# delivery v2 — P2 实施方案：coalescer 通知合并（rev2）

> 权威依据：`architecture.md`（六轮评审定稿）§2（D2）、§4（转移 #5/#6/#7）、§4.1（batched 行）、§5（M6/M11/M14）、§6/§6.1（契约）、§8 P2 验收①–⑦、§11（O4/O5）。
> 基线 = HEAD `fda4111`（P1 已落地，`918694c`）。行号均按 HEAD 复核。
> rev2：评审打回修订——P1-1 maxBatch 同步 flush 覆盖竞态（裁决 a）、P1-2 reconcileRound 准入穿透修正、P1-3 集成验收升级、P2 三项（digest kind 契约 / dispose 幂等 / settings 有限性校验）。
> P2 目标：`windowMs=0` 时逐字节零行为变化（回归哨兵）；`windowMs>0` 时 completed 类通知窗口合并为 digest。

## 0. P1 后现状（本方案的挂点）

| 事实                                                                                                                                                                       | 位置                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `MessageSender.sendMessage(payload): void`（无 SendResult、无缓冲谓词）                                                                                                    | `src/delivery/notifier.ts:24-26`                              |
| `attempt(record, round)`：**`send(record)` 原样透传 record**——reconcile 路径 `attempt(next, (record.reconcileRound ?? 0) + 1)` 的 `next` 未带 effective round（P1-2 实证） | `notifier.ts:158-166`；reconcile 调用点 `notifier.ts:304-308` |
| `settleDelivered`/`settleFailed` 双汇点已存在；`settleBatch(keys, ok)` façade 已接通（ok→逐条 settleDelivered，!ok→逐条 settleFailed + backoff）                           | `notifier.ts:127,143,243-250`                                 |
| `batched` 态已在 union/折叠未投递组/stats 中，但**无生产来源**（恒 0）                                                                                                     | `notifier.ts:8,97,340` 一带                                   |
| reconcile 排除式筛选不含 batched → batched 落 else 分支转 pending 重投（§4.1 已落地）                                                                                      | `notifier.ts:271-310`（排除表 ~L277）                         |
| `writeBack` 一律走 `storageKey`                                                                                                                                            | `notifier.ts:80-81`                                           |
| stack sender：内联文案组装 + `pi.sendMessage({customType, content, details: payload}, {triggerTurn:true})`                                                                 | `src/stack.ts:151-201`（sendMessage L187，details L197）      |
| 重建清理模式：模块级 `previousX?.dispose()` + 置 undefined，位于 `buildSessionStack` 顶部                                                                                  | `stack.ts:39-41,86-89`                                        |
| settings：`AgentSettings`/`DEFAULT_SETTINGS`/`loadSettings` 三处平铺键；`Number.isFinite` 校验有先例（`foregroundAutoBackgroundMs`）                                       | `src/config/settings.ts:53-95,110-150`（isFinite L126）       |
| `/agent settings` 白名单 `SETTING_SPECS`                                                                                                                                   | `src/commands/status.ts:116-140`（delivery 键 L127-132）      |
| `session_start` 防御重建：仅停 scheduler/rpc，随后 `buildSessionStack` + 同步 `reconcile()`                                                                                | `src/index.ts:192-203`                                        |
| `Clock`/`FakeClock`（`setTimer/clearTimer/advance/pendingTimers`）                                                                                                         | `src/core/clock.ts:3-7,25-60`                                 |

## 1. 裁决汇总（本期全部开放点）

1. **依赖方向（D2 契约 + §7 纪律）**：`SendResult = "sent" | "buffered"` 定义在 **`core/types.ts`**（紧邻 `DeliveryPayload`，`core/types.ts:307-321`；core 无出边）。`notifier.ts` 与 `coalescer.ts` 各自 `import type { SendResult } from "../core/types.js"`；**notifier 不 import coalescer，coalescer 不 import notifier**——两者只经 stack.ts 的回调接线（`send`/`onSettled`/`willBuffer`）。`delivery/**` 禁 import `service/**`、`adapters/**`、`tools/**`（§7 ②，stats 由 stack 注入）。
2. **P1-1 maxBatch 同步 flush 覆盖竞态——选 (a) 状态先行**：若 submit 达 maxBatch 同步 flush，`settleBatch(keys,true)` 先置 delivered，notifier 随后的 markBatched 覆盖回 batched（重启重复投递 / flush 失败态被吞）。**裁决 (a)：notifier 在 `send()`（其内即 `coalescer.submit`）调用之前先持久化 batched**；submit 的返回值退化为断言通道。选 (a) 弃 (b) 的理由：① 状态先行与 P1 staged"put 先于发送"同模式（§1 决策 D1），盘面永远先于内存窗口，M11 崩溃窗口进一步收窄；② (b) 的 0ms timer 引入"窗 timer / 即 flush timer"双句柄生命周期与 dispose 竞态（dispose 须先清即 flush timer 再同步 flush），复杂度全花在时序上而正确性仍依赖调用序；③ (a) 下 flush 失败路径同样受益——`settleBatch(false)` 从 batched 出发 settleFailed，无状态丢失。
   **代码形态**（不暴露 notifier 内部、不破坏回调解耦）：`MessageSender` 增**可选纯谓词** `willBuffer?(p: DeliveryPayload): boolean`；`attempt()` 先问谓词再发：
   ```ts
   const attempt = (record: PersistedDelivery, round: number) => {
     if (state.get(record.key)?.state === "consumed") return;
     const outbound = { ...record, reconcileRound: round }; // P1-2：effective round 必须进 sender payload
     const preBuffer = willBuffer(outbound); // sender.willBuffer?.(p) === true
     if (preBuffer) markBatched(record, round); // (a)：盘面 batched 先于 submit
     try {
       const result = send(outbound);
       if (result === "buffered") {
         if (!preBuffer) markBatched(record, round);
         return;
       } // 防御：谓词缺失的旧式 sender
       settleDelivered(record, round);
     } catch (e) {
       settleFailed(record, round, e); // mark-first 后 send 抛错：从 batched 出发 attempts++，方向正确
     }
   };
   ```
   `markBatched` **幂等**：当前已是 batched 则跳过 writeBack/audit/notify（防谓词路径与防御路径双重标记）。
3. **P1-2 reconcileRound 准入穿透修正**：现状 `attempt` 把 `record` 原样传给 sender（`notifier.ts:161`），而 reconcile 的 effective round（`record.reconcileRound + 1`，L307）只进 settle 不进 payload → 首次重投的 round=0 记录会被 `isCoalescible` 放行入窗。修正即裁决 2 代码形态中的 `outbound = { ...record, reconcileRound: round }`——单点修正在 `attempt` 内，enqueue（round=payload 原值）、backoff 重试（`next` 已带 round）、releaseStale（`next.reconcileRound=round+1`）三条路径天然一致，无需各自改动。
   **显式规则：batched 记录经 reconcile 释放后不允许再入窗**——释放走 else 分支，`attempt(next, round+1)` 的 outbound 恒 `reconcileRound ≥ 1`，被准入谓词天然排除，立即重发；不靠额外标记位。
4. **settings 名称**：任务提示的 `notificationCoalesceMs` 与架构 §6 settings 增量不一致；**以架构为准**：`coalesceWindowMs`（默认 **0**，钳制 [0, 5_000]）+ `coalesceMaxBatch`（默认 **8**，≥1 整数）。**P2 修订：两键 `loadSettings` 均加 `Number.isFinite` 有限性校验**（对齐 L126 先例），非有限数（NaN/Infinity）/非 number 一律回默认。
5. **单条退化（§2"逐字节复用单条文案路径"）**：flush 时 `items.length===1` → 走 `formatSingle` 同一条文案函数，`details = items[0]`（payload 原样，非 digest 形状）——content 与 details **逐字节同 P1**。
6. **digest details 形状**：`details = { ...items[0], kind: "digest", items: DeliveryPayload[] }`。轻裁决：以**首条 payload 为基底**保留单条兼容字段（`runId/status/diag/…`），使按 `details.runId`/`details.status` 读取的现有消费者（pi-hud 等）不崩；因准入规则保证窗内**全部 completed**（见裁决 7），`status` 拷贝无歧义。**P2 修订——契约注释（写入 `format.ts` 与 stack digest 分支头注释）**："digest 消息的 `details` 形状以 `kind` 为判别字段；**消费者必须先查 `details.kind === "digest"`**，命中时一律读 `items[]`，未命中才按单条 payload 读取——不得对 digest 基底的单条兼容字段做语义依赖（兼容字段仅为不崩，权威内容在 items）"。
7. **准入清单核实**：架构 §2 准入表原文为**三类不进窗口**——`status ≠ completed`、`degradedReason` 存在、`reconcileRound > 0`（P1-2 修正后查的是 outbound 的 effective round）。本方案**补第四类 `attempts > 0`（重投不进窗口）**：架构 §2 综述"失败/降级/重投类不进窗口"与之呼应，且 flush 失败 → `settleFailed`（attempts++）→ backoff 重发若不拦会再次入窗、循环叠加窗口延迟；拦截后重投走 immediate，更快暴露持久故障。谓词 `isCoalescible(p)` 作为纯函数从 `coalescer.ts` 导出（stack sender 的 `willBuffer` 与发送分支共用同一谓词，单一来源）。
8. **O4 轻裁决**：digest 文案任务示例含 `✗` 项，但按 §2 准入表 failed/timed_out/aborted **永不进窗口**，digest 内不存在 ✗ 行——不做 attention 强调（不过度设计）。O4 保留观测：`triggerTurn` N→1 的漏看风险由"每项一行 + `onDelivery` 逐条 fire + `details.items` 全量 payload"缓解，P2 期仅观测不加固。
9. **`windowMs=0` 完全旁路**：stack 在 `coalesceWindowMs===0` 时**不实例化 coalescer**，sender 为 P1 原样函数（无 `willBuffer`）——零行为变化由构造保证，而非运行时分支。
10. **dispose/shutdown**：`dispose()` 幂等——首次同步 flush（抛错走 `onSettled(keys,false)`，自身不抛），**重复 dispose 为 no-op**（disposed 标志，P2 修订）；**disposed 后 `submit(p)` 直发短路**：直接 `deps.send([p])` 并返回 `"sent"`（避免"dispose 后入窗无人 flush"的悬挂；send 抛错则由 notifier `settleFailed` 兜住——此时若已经 markBatched 先行，从 batched 出发 attempts++，方向正确）。stack 不新增 dispose hook（X7b 既有模式：index.ts 从不调 stack dispose，`stack.ts:37` 注释），`session_shutdown` 不 flush——进程退出后盘面 batched 由下次 `session_start` 的 `reconcile()` 兜底（M11/M14）。

## 2. 逐文件改动

### 2.1 `src/core/types.ts`（+2 行）

在 `DeliveryPayload`（L307）上方新增：

```ts
export type SendResult = "sent" | "buffered"; // delivery v2 D2（§2）；void 兼容旧 sender = "sent"
```

### 2.2 `src/delivery/notifier.ts`（batched 生产来源 + P1-1/P1-2 修正）

- `MessageSender`（L24-26）签名改 `sendMessage(payload): SendResult | void` 并增 `willBuffer?(p: DeliveryPayload): boolean`（裁决 2）；`NotifierOptions.sender` 函数形态同步放宽返回类型（函数形态无 willBuffer → 走防御分支）。
- `send` 包装（L62-63）返回 `SendResult | void` 透传；并列包装 `willBuffer = (p) => typeof options.sender === "object" ? options.sender.willBuffer?.(p) === true : false`。
- 新增模块内 helper `markBatched(record, round)`（形态对齐 `settleDelivered` L127）：**幂等守卫** `if (state.get(record.key)?.state === "batched") return;`；`state="batched"`、**attempts 不变、不排 backoff**、`reconcileRound: round`；`state.set` + `writeBack(record, { state:"batched", reconcileRound: round })`（storageKey，§1.1）+ `audit(key,"batched")` + `notify(next,"batched")`（§6.1：onDelivery 照常 fire）。
- `attempt()`（L158-166）按裁决 2 代码形态整体替换（outbound 带 effective round = P1-2 修正；willBuffer 预问 + mark-first = P1-1 裁决 a；`"buffered"` 防御补标；抛错仍 `settleFailed` 不变）。**不变量**：`delivered` 仍只由 `settleDelivered` 写入，两来源 = immediate `"sent"` / flush 成功（§2 P1-5 修正表述）。
- `settleBatch`（L243-250）逻辑不变：`ok=false` 时 `settleFailed(record, record.reconcileRound ?? 0, …)`——attempts++ 进 backoff、**不动 reconcileRound**（O5，现状已满足，加测试锁定）；mark-first 后 settleBatch 恒从 batched 出发转移，无覆盖窗口。

### 2.3 `src/delivery/format.ts`（新建，纯函数；§2"文案抽取"）

从 `stack.ts:151-200` 平移文案逻辑，stats 由调用方注入（§1.3，避免 delivery→tools 反向依赖）：

```ts
export function formatSingle(p: DeliveryPayload, ctx?: { stats?: string }): string;
// 逐字节 = stack.ts 现 content 组装（label/#shortId、stats、failReason/textPreview 200 截断、degradedTail、hint）
export function formatDigest(items: readonly DeliveryPayload[], ctx?: { stats?: Record<string, string> }): string;
// 首行 `${items.length} subagents settled`；随后每项一行 `✓ "label" (#shortId) — stats`（stats 缺省省略；
// 无 textPreview/failReason 行——窗内恒 completed，单条全文仍走 get_subagent_result）
```

文件头注释写明裁决 6 的 **kind 判别契约**（消费者必须先查 `details.kind === "digest"`）。key 索引用 `item.key`（稳定 key，`core/delivery-key.ts`）。

### 2.4 `src/delivery/coalescer.ts`（新建；§6 契约原文）

```ts
export function isCoalescible(p: DeliveryPayload): boolean;
// status==="completed" && !p.degradedReason && (p.reconcileRound ?? 0)===0 && (p.attempts ?? 0)===0
// —— 查的是 outbound 的 effective round（P1-2 修正后 reconcile 重投恒 ≥1，天然排除）
export function createCoalescer(deps: {
  clock: Clock;
  windowMs: number;
  maxBatch: number;
  send(items: readonly DeliveryPayload[]): void; // 抛错 = flush 失败
  onSettled(keys: readonly DeliveryKey[], ok: boolean): void; // → notifier.settleBatch
}): Coalescer; // { submit(p): SendResult; cancel(key): boolean; flush(): void; dispose(): void }
```

实现要点：

- `submit`：disposed 后直发短路（裁决 10）。正常路径：**首条** `clock.setTimer(windowMs, () => this.flush())` 开窗并入缓冲；窗内后续只入缓冲；缓冲达 `maxBatch` **同步** `flush()`（§2 满即 flush；同步 flush 的覆盖竞态已由裁决 2 的 mark-first 消除，无需 0ms timer）；恒返回 `"buffered"`。内部缓冲 `Map<DeliveryKey, DeliveryPayload>`。
- `flush()`：清 timer + 取出全部条目 → `try { deps.send(items); deps.onSettled(keys, true); } catch { deps.onSettled(keys, false); }`；`items.length===1` 由 stack 的 `send` 退化单条路径（裁决 5）。空缓冲 no-op。
- `dispose()`：disposed 标志幂等——首次 `flush()`，重复调用 no-op（裁决 10）。`cancel(key)`：从缓冲移除（P3 ack 抑制用，P2 先实现不接线）。
- coalescer 不认识 pi、不认识 notifier（裁决 1）。

### 2.5 `src/stack.ts`（接线）

- 顶部模块级加 `let previousCoalescer: Coalescer | undefined`（对齐 L39-41），`buildSessionStack` 开头加 `previousCoalescer?.dispose(); previousCoalescer = undefined;`（对齐 L86-89 模式；dispose 幂等同步 flush，M14）。
- `createNotifier` 之前按 `settings.coalesceWindowMs > 0` 条件装配：
  ```ts
  const coalescer =
    settings.coalesceWindowMs > 0
      ? createCoalescer({
          clock: systemClock,
          windowMs: settings.coalesceWindowMs,
          maxBatch: settings.coalesceMaxBatch,
          send: (items) => sendFormatted(items),
          onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
        })
      : undefined;
  ```
  （`notifier` 晚绑定：onSettled 闭包引用 let notifier，与 `spawnRef`/`runnerRef` 同模式。）
- 抽出现 sender 的文案段为 `sendFormatted(items: readonly DeliveryPayload[])`：
  - `items.length===1`：P1 原路径逐字节——`formatSingle(p, {stats})` + `pi.sendMessage({customType:"subagent:notification", content, display:true, details: p}, {triggerTurn:true})`（L187-198 不变）。
  - `≥2`：`formatDigest(items, {stats})` + `details = {...items[0], kind:"digest", items}`（裁决 6，分支头注释写 kind 判别契约），`triggerTurn:true` 只发一次（§2）。
  - stats：每条 `store.get(item.runId)` → `formatOutcomeSummary(outcome)`（`tools/agent-tool.ts:84`；stack 是唯一 store 读取处，§7 图）。
- notifier `sender`（L151）改为**对象形态**（函数形态无 `willBuffer` 通道）：
  ```ts
  sender: {
    willBuffer: (p) => coalescer !== undefined && isCoalescible(p), // 与发送分支同一谓词，单一来源
    sendMessage: (payload) => {
      if (coalescer && isCoalescible(payload)) return coalescer.submit(payload); // markBatched 已被 notifier 先行（裁决 2）
      sendFormatted([payload]);
    },
  },
  ```
  `windowMs=0` → `coalescer===undefined` → `willBuffer` 恒 false、sendMessage 与 P1 等价（裁决 9 哨兵）。
- 成功装配后 `previousCoalescer = coalescer`。

### 2.6 `src/config/settings.ts` + `src/commands/status.ts`

- `AgentSettings` 加 `coalesceWindowMs: number; coalesceMaxBatch: number;`（L62-64 旁）；`DEFAULT_SETTINGS` 加 `coalesceWindowMs: 0, coalesceMaxBatch: 8`（L80-82 旁）。
- `loadSettings`（L116-137 同形态，**含 `Number.isFinite`**，对齐 L126 先例）：
  - `coalesceWindowMs`：`typeof number && Number.isFinite(v) ? Math.min(5_000, Math.max(0, v)) : DEFAULT`（架构硬上限 5000 在解析处钳制；NaN/Infinity 回默认 0）。
  - `coalesceMaxBatch`：`typeof number && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : DEFAULT`（NaN/Infinity 回默认 8）。
- `SETTING_SPECS`（status.ts:127-132 旁）加 `coalesceWindowMs: MS, coalesceMaxBatch: { kind:"number", min:1, integer:true }`（spec 无 max 字段，上限由 loadSettings 钳制——不过度扩展 spec）。

### 2.7 `src/index.ts`

**不改**。`session_start` 必经 `buildSessionStack`（L200），其顶部的 `previousCoalescer.dispose()` 即覆盖防御重建路径（裁决 10）；`reconcile()`（L201）兜底 shutdown/崩溃遗留的 batched。

## 3. 崩溃/失败矩阵（P2 增量行，并入架构 §5）

| ID                         | 故障 × 阶段                                                   | 结果                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M11（核实落地，rev2 收窄） | 窗口内进程崩溃                                                | **mark-first（裁决 2）后盘面 batched 先于 submit 落盘**——"已入内存窗口、盘面未标"的崩溃窗被消除；重启 `reconcile()`：折叠未投递组含 batched（`notifier.ts:97`）、排除表不含 batched（~L277）→ else 分支转 pending、effective round≥1 **立即重发不再入窗**（裁决 3）。丢失为空集 |
| M6（核实落地）             | flush 时 `pi.sendMessage` 抛错（含 maxBatch 同步 flush 抛错） | coalescer catch → `onSettled(keys,false)` → `settleBatch` 从 batched 出发逐条 `settleFailed`：attempts++ → backoff → 达上限 dropped（与 M5 同一实现）；`reconcileRound` 不变（O5）；mark-first 保证无 delivered→batched 覆盖、无状态丢失                                        |
| M14（核实落地）            | session 重建 / `dispose()` 时 flush 抛错                      | `previousCoalescer.dispose()` 幂等同步 flush，抛错同上走 `settleBatch(keys,false)` → 回 pending；dispose 自身不抛；未成功者由新 stack 的 `reconcile()`（`index.ts:201`）重投                                                                                                    |
| R4                         | completed 延迟至多 `windowMs`                                 | 失败/降级/重投类免疫（裁决 3/7）；默认 0；硬上限 5s                                                                                                                                                                                                                             |

## 4. 测试方案（vitest + FakeClock，沿用 `tests/delivery/notifier.test.ts` 风格：FakeOutbox + 内联 payload 工厂）

### 4.1 `tests/delivery/coalescer.test.ts`（新建，纯组件）

1. **多条合并**：windowMs=100，3 条 completed 相继 submit → 0 次 send；`clock.advance(100)` → 1 次 send、`items.length===3`、`onSettled` 收到 3 keys 且 ok=true。
2. **窗口错开**：A submit → advance(60) → B submit（不开新窗）→ advance(40) flush [A,B]；再 submit C → advance(100) 单独 flush [C]（两窗独立）。
3. **单条**：submit 1 条 → advance → send 收到长度 1 数组（退化路径由 stack 层测试锁定逐字节，见 4.3）。
4. **maxBatch 满即同步 flush**：maxBatch=2，submit×2 → 立即 flush，timer 已清（`clock.pendingTimers===0`）。
5. **flush 抛错**：send 抛 → `onSettled(keys,false)`；coalescer 不向外抛。
6. **dispose 同步 flush + 幂等（P2 修订）**：submit 后 `dispose()` → 立即 send（不 advance）；`dispose()` 再调一次 → 无二次 send/onSettled；dispose 时 send 抛错 → `onSettled(false)` 且不抛；**disposed 后 submit → 直发 `send([p])` 且返回 `"sent"`**。
7. **cancel**：submit 后 `cancel(key)` 返回 true → advance 后该条不在 items；未知 key 返回 false。
8. **isCoalescible 四类各一**：failed / degradedReason / reconcileRound=1 / attempts=1 → false；干净 completed → true。

### 4.2 `tests/delivery/notifier.test.ts`（增补，含真实 notifier+coalescer 集成）

9. **buffered → batched（mark-first）**：对象形态 sender（`willBuffer: () => true`，`sendMessage: () => "buffered"`）→ enqueue 后 FakeOutbox 回读 state=`batched`、attempts=0 不变、无 backoff timer（`pendingTimers===0`）、onDelivery fire `"batched"` 恰好一次（幂等守卫）。
10. **settleBatch(true) → delivered**：逐条 state=`delivered`、onDelivery 逐条 fire（3 条 3 次）、`store` 经 storageKey 回读一致。
11. **settleBatch(false) → backoff**：3 条各自 attempts=1、state=pending、reconcileRound 不变（O5 断言）、advance 触发重投。
12. **P1-1 集成：maxBatch=2 同步 flush 无覆盖**：真实 notifier + 真实 coalescer + FakeClock（stack 式 sender 闭包：`willBuffer = isCoalescible`、`sendMessage = submit`）→ 连发两条 completed（第二条触发同步 flush）→ 断言：① FakeOutbox 每条记录的 writeBack 序列 = `batched → delivered`，**绝不出现 delivered→batched 覆盖**；② 终态 2×delivered；③ **重启回放**：新 notifier（同 store）`reconcile()` → `redelivered` 为空（无重复投递）。
13. **P1-2 集成：reconcile 首次重投不进窗口**：同 12 的接线，outbox 预置 `pending`（reconcileRound=0）与 `dropped` 各一条 → `reconcile()` → 断言 sender 收到的 outbound `reconcileRound===1`、走了 immediate 直发（coalescer 缓冲为空、无 batched 标记）；另预置 `batched` 一条 → reconcile 后同样 immediate（释放即 effective round≥1，不允许再入窗，裁决 3）。
14. **flush 失败重投不进窗口**：上接 11——backoff 重发时 `willBuffer` 因 attempts=1 返回 false → 直发路径。
15. **batched 崩溃回放**：outbox 预置 3 条 batched → 新 notifier（同 store）`reconcile()` → 3 条全部 redelivered 立即重发（丢失为空集，§8 P2 验收⑦）。

### 4.3 `tests/delivery/format.test.ts`（新建）

16. `formatSingle` 与 P1 stack 内联文案**逐字节相等**（含 stats/failReason/200 截断/degradedTail/hint 各分支）——回归哨兵。
17. `formatDigest`：首行计数、每项一行 `✓ "label" (#short) — stats`、stats 缺省省略；断言不含 textPreview。

### 4.4 `tests/commands/status.test.ts` / settings（沿用既有 run() 风格，status.test.ts:269-290）

18. settings 白名单与有限性：`settings set coalesceWindowMs 500` 成功；`settings set coalesceMaxBatch 0` 拒绝（min:1）；`loadSettings` 钳制 99999 → 5000；**NaN/Infinity/非 number → 回默认**（两键各一断言，P2 修订）。
19. **windowMs=0 旁路哨兵**：stack sender 逐字节等价 P1（content/details/triggerTurn 全等；以 formatSingle 哨兵 + sender 无 coalescer 分支断言覆盖）。
20. digest details 形状与 kind 契约：`kind==="digest"`、`items.length===3`、兼容字段（runId/status）取自首条且消费者经 kind 判别（裁决 6）。

## 5. 实施顺序与验证

序（§8 P2）：① `core/types.ts` SendResult → ② notifier（MessageSender+willBuffer / 幂等 markBatched / attempt 三分支含 outbound effective round）→ ③ `delivery/format.ts` → ④ `delivery/coalescer.ts` → ⑤ settings + SETTING_SPECS → ⑥ `stack.ts` 接线 + previousCoalescer → ⑦ 测试（4.1→4.4）。

每步可独立编译；② 完成后 `batched` 首次有生产来源（mark-first，无覆盖窗口）。

```bash
npm run typecheck                                # 每步后
npx vitest run tests/delivery                    # ②③④ 后
npx vitest run tests/delivery tests/commands     # ⑤⑥ 后
npm test && npm run build                        # 合入前全量
```

**验收对账（§8 P2 + rev2 增补⑧⑨⑩）**：① windowMs=0 与 P1 逐字节一致（测试 16/19）；② 3 条 completed → 1 次 sendMessage、`details.items.length===3`、onDelivery 3 次（测试 1/10/20）；③ 窗口内单条逐字节相同（测试 3/16）；④ 四类不进窗口（测试 8/13/14——含 effective round 与 attempts 的集成断言，非只测纯函数）；⑤ dispose 立即发（测试 6）；⑥ flush 抛错 → 各自 attempts++ 进 backoff、reconcileRound 不变（测试 5/11）；⑦ batched 崩溃回放全部重投（测试 15）；⑧ **maxBatch 同步 flush 无 delivered→batched 覆盖、终态 delivered、重启回放零重复**（测试 12，P1-1）；⑨ **reconcile 首次重投（pending/dropped/batched）immediate 直发不入窗**（测试 13，P1-2）；⑩ dispose 幂等与 settings 有限性（测试 6/18，P2 项）。
