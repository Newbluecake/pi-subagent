# delivery v2 — P1 期实施计划（稳定 key + staged/finalize + storageKey）· rev2

> 权威依据：`architecture.md`（rev2）。P1 = §8 分期表第一期；P2（coalescer）/P3（ack）不做，
> 但 `SendResult`/`settleDelivered`/`settleFailed` 汇点函数形态按 §2/§6 契约预留（P1 仅 immediate 来源）。
> 行号以当前 HEAD 复核。rev2 = 评审定向修订（0 P0 / 6 P1 / 3 P2 全部落点，见各节 "rev2" 标注）。

## 1. 改动面总览（文件级）

| 序  | 文件                                | 动作                                                                                                                                             |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | `src/core/delivery-key.ts`（新）    | `deliveryKey(runId,gen)` → `${runId}:${gen}`；`canonicalizeDeliveryKey(key)`；`parseDeliveryKey(key)`（严格白名单，§4.3 用）                     |
| B   | `src/core/types.ts`                 | `DeliveryPayload` 增 `finalized?/degradedReason?/structuredPreview?/failReason?/label?`（§6，全可选向后兼容）                                    |
| C   | `src/core/state-machine.ts:293-307` | `finish()` 的 `enqueue_delivery` payload 换稳定 key + 补 `label/failReason`（§1.3）                                                              |
| D   | `src/delivery/notifier.ts`          | 见 §3（本期心脏）；接口增 `peek(key)` + `finalize()`；enqueue 入口统一 canonicalize                                                              |
| E   | `src/service/runtime-adapter.ts`    | `policyPendingRunIds: Map<RunId,Generation>` + hold enqueue + finally 统一 finalize + post-policy `store.put`（§4）；F2 payload 换稳定 key（§5） |
| F   | `src/service/spawn-service.ts:317`  | `SpawnServiceDeps.runIdTaken` 谓词接入 `newRunId` 排除集（§4.3）                                                                                 |
| G   | `src/stack.ts`                      | sender 双源取值（payload 优先）；删 consume schema-flip fallback（222-233）；F1 简化 + payload 换稳定 key（235-262）；`runIdTaken` 快照注入      |
| H   | `src/tools/result-tool.ts:51-63`    | 删 schema-flip fallback，`consume(runId:gen)` 单 key（§1.4"与 fallback 的关系"）                                                                 |
| I   | `src/index.ts:303-315`              | `forwardNotifier` façade 增 `peek` 转发（必需，见 §5.4）                                                                                         |
| J   | `src/commands/status.ts:400-402`    | Delivery 行补 `staged=` 与 `batched=`（§6.1；batched P1 恒 0 也展示，避免 P2 再动此行）                                                          |

**裁决（rev2 #5）**：P1 **不引入** `policyHoldMs` setting，也不实现 hold 保险 timer——O2 默认 0 = 不排 timer，
P1 硬编码无 timer；`AgentSettings`/`src/config/settings.ts` 零改动。`enqueue` opts 只带 `{ hold?: boolean }`，
`holdMs` 字段与 timer 分支留 P3 按需。`DeliveryState` union 与 `stats` 一次到位含 `batched`（占位，P1 无代码写入）。

## 2. core：key 上移（A/B/C）

**`src/core/delivery-key.ts`（新建，core 无出边，§1 key 归属）**

```ts
export type DeliveryKey = string;
export function deliveryKey(runId: RunId, generation: Generation): DeliveryKey {
  return `${runId}:${generation}`;
}
// P1-2 收窄：仅第三段 ∈ 终态四值才剥离；其余原样返回。宽松——服务 legacy 记录的读路径归一，
// 不校验 runId 形态（旧记录 runId 可能不符合现行 isRunId）。
const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);
export function canonicalizeDeliveryKey(key: string): DeliveryKey {
  const parts = key.split(":");
  if (parts.length === 3 && TERMINAL.has(parts[2])) return `${parts[0]}:${parts[1]}`;
  return key;
}
// 严格白名单（rev2 P2 项）：仅用于 §4.3 从 outbox 记录提取 runId 进 taken 集——
// 格式不净的记录宁可不进 taken（降级方向 = 概率面略增，绝不误排除合法 id）。
export function parseDeliveryKey(key: string): { runId: RunId; generation: Generation } | undefined {
  const k = canonicalizeDeliveryKey(key);
  const parts = k.split(":");
  if (parts.length !== 2) return undefined; // 恰一个冒号分隔
  const generation = Number(parts[1]);
  if (!Number.isInteger(generation) || generation < 1) return undefined; // gen 为正整数
  if (!isRunId(parts[0])) return undefined; // runId 过 isRunId
  return { runId: parts[0], generation };
}
```

- **B** `core/types.ts` `DeliveryPayload`（现 305 行处）按 §6 契约追加五个可选字段。
- **C** `state-machine.ts` `finish()`（293-307 行 payload 字面量）：`key` 改
  `deliveryKey(state.runId, state.generation)`，补 `label: d.label`（`core/types.ts:261`）与
  `failReason: d.error?.message ?? d.timeoutReason`（§1.3：两者都是 diag 现成值）。
  `import { deliveryKey } from "./delivery-key.js"`——**state-machine 唯一新依赖**（§7 纪律③）。

## 3. notifier.ts（D）——全量改写要点

**类型面**（§6.1）：

```ts
export type DeliveryState = "staged" | "pending" | "batched" | "delivered" | "consumed" | "dropped" | "abandoned";
export interface PersistedDelivery extends DeliveryPayload {
  state?: DeliveryState;
  attempts?: number;
  storageKey?: string; // 物理 key，缺省 = key；一切写回用它（§1.1）
}
export type SendResult = "sent" | "buffered"; // §2 预留；P1 sender 返回 void 视为 "sent"
interface MessageSender {
  sendMessage(p: DeliveryPayload): SendResult | void;
}
interface Notifier {
  enqueue(payload: DeliveryPayload, opts?: { hold?: boolean }): void;
  finalize(runId, generation, patch): "sent" | "updated" | "late" | "missing";
  peek(key: DeliveryKey): DeliveryState | undefined; // 只读逻辑态查询，供 F1（§4.2），必需方法
  /* consume/reconcile/verifyPersisted/stats/degraded 不变 */
}
```

- `deliveryKey()` 实现从 notifier 删除，改 `export { deliveryKey, canonicalizeDeliveryKey } from "../core/delivery-key.js"`（重导出保旧 importer，§1）。
- **enqueue 入口统一 canonicalize（rev2 #2 裁决：是）**：`enqueue(payload)` 首行
  `payload = { ...payload, key: canonicalizeDeliveryKey(payload.key) }`——单点防御：F1/F2/未来调用方
  即使误传三段 key 也在入口归一，逻辑索引永不分裂。代价：无（新格式 key canonicalize 是恒等映射）。
- `hold:true` → `state:"staged"`，`store.put` 后**不 attempt**（§4 转移 #1）；缺省 → 原路径（转移 #2）。
- **canonicalize 层**：`normalize(record)` 先过 `canonicalizeDeliveryKey`；三段且第三段非终态 →
  `audit({key, state:"pending", error:"illegal legacy key"})` 并排除于折叠与重投（§1.4 P1-2 收窄）。
  旧记录 `storageKey = 原三段物理 key`，新记录 `storageKey = key`。
- **折叠（§1.2 硬规则）**：`list()` 三处读取（现 142/156/195）与 consume/finalize/peek 入参先 canonicalize，按
  (runId,gen) 分组：未投递组 = {staged, pending, batched, dropped} 非空恒取；组内 `createdAt` 最大、并列
  `attempts` 最大；未选中物理记录不删不改。逻辑视图存 `state` Map，键 = 逻辑 key。
- **写回五处全走 `storageKey`**（§1.1，验收⑪）——attempt 内 update（现 101/114）、reconcile 内
  TTL-abandon 与 rounds-abandon（现 170/176）、`consume`、`finalize`、backoff retry（复用 attempt 同一写回）：
  ```ts
  const writeBack = (rec: PersistedDelivery, patch: Partial<PersistedDelivery>) =>
    options.store.update(rec.storageKey ?? rec.key, patch);
  ```
- **`finalize(runId, generation, patch)`**（§4 转移 #3/#13）：查逻辑 key →
  - `staged`：`writeBack(rec, {...patch, state:"pending", finalized:true, degradedReason:undefined})` →
    内存转 pending → `attempt`（返回 `"sent"`）；update 抛错 → degraded + 仍转 pending 发送（M2）。
  - `pending/batched`（在途，如 schema run 走 config-failure 非 hold 入队后迟到 finalize）：
    按 #13 同处理——仅写回 patch 不重发（返回 `"late"`）。
  - `delivered/consumed`：仅 `writeBack(rec, patch)` 供审计（返回 `"late"`，转移 #13）。
  - 无记录 → `"missing"`。patch 类型见 §6 契约（status/textPreview/structuredPreview/failReason/label/diag）。
- **`releaseStale(record, round)`**（P1-4 唯一 helper）：置 `degradedReason:"pre-finalize"` +
  `finalized:false` → `writeBack` → 转 pending → immediate `attempt`（留"强制不进窗口"标记位给 P2 消费）。
  `attempts` 原样继承，`reconcileRound = (p.reconcileRound ?? 0) + 1`。reconcile 遇 staged **只准**走它。
  **可观察性（rev2 P2 项）**：release 时 `audit(key, "pending", "pre-finalize release")`——使"必经 helper"
  可从 audit 序列断言（验收⑫ 改行为断言后依赖此条）。
- **reconcile（§4.1）**：排除式筛选不动；candidates 先折叠再判定——`staged` → `releaseStale`；
  `batched` → 转 pending 正常重投（P1 防御分支，无产生源）；`pending/dropped` 既有行为；折叠隐去记录不参与。
- **汇点预留**：`settleDelivered(keys)` = "state=delivered + store.update 唯一写入处"（P1-5 修正），P1 唯一来源
  是 `attempt()` 内 send 返回后调用它；`settleFailed(keys, err)` = 现 attempt 的 catch 分支抽出
  （attempts++/backoff/dropped 同一实现，O5）。`settleBatch(keys, ok)` 签名挂上、P1 体内仅路由到两汇点。
- **stats**：`Record<DeliveryState, number>` 初始化补 `staged/batched` 两键（现 198-202）。
- **onDelivery**：staged/batched 转换照常 fire（§6.1；对外签名 `state: string` 已兼容）。

## 4. runtime-adapter.ts（E）——hold 决策 + finally 统一出口（§1.4）

**`policyPendingRunIds` 一步到位 `Map<RunId, Generation>`（rev2 #1 + rev3：**staged 入队时才注册**，与 childRunIds 同模式 161/275/401）**：

```ts
// 标记集：哪些 run 是 schema run（仅作拦截器判定，不承担 finalize 语义）
const schemaRunIds = new Set<string>();
// staged 登记：只有真正以 hold 入队的 (runId, gen) 才会出现在这里——gen 永远真实，无 0 占位
const policyPendingRunIds = new Map<string, number>();
// run() try 顶部、首个 await 之前：
if (spec.request.schema !== undefined) schemaRunIds.add(spec.runId);
let settled: RunOutcome | undefined; // finalize 一律用它，与 snapshot 写回成败解耦（rev2 #6）

// enqueue_delivery 解释器（现 170-177）：只有 state-machine settle 路径经过这里；
// F2（settleConfigFailure 直接 notifier.enqueue）不经此处 → 天然不会被登记/hold
if (childRunIds.has(e.payload.runId)) return;
const hold = schemaRunIds.has(e.payload.runId);
if (hold) policyPendingRunIds.set(e.payload.runId, e.payload.generation); // 登记与 hold 同时发生
deps.notifier.enqueue(e.payload, { hold });

// policy 之后（现 394-397 处）——rev2 #6 顺序修正：先 settled 再 best-effort 写回
if (spec.request.schema !== undefined) {
  outcome = applyStructuredOutputPolicy(outcome, spec.request.schema, structured.value);
  settled = outcome;
  try { deps.store.put(snapshotOf(outcome)); } // §1.3 顺带修：post-policy 终态 snapshot 回写
  catch (err) { console.warn(`[pi-subagent] post-policy snapshot persist failed for ${spec.runId}: ...`); }
} else settled = outcome;
return outcome;

} finally {
  perRun.delete(spec.runId);
  childRunIds.delete(spec.runId);
  schemaRunIds.delete(spec.runId);
  const gen = policyPendingRunIds.get(spec.runId);
  if (gen !== undefined) { // 仅当真有 staged 记录时才 finalize；config-failure 早退路径从未登记 → 不触发
    policyPendingRunIds.delete(spec.runId);
    deps.notifier.finalize(spec.runId, gen,
      settled ? patchOf(settled) : { degradedReason: "policy-error" });
  }
}
```

- **finalize-in-finally 不变量（验收⑧）**：正常返回 / 抛出 / H2-CP2 提前 return（现 275-281、343 两处
  `return settleConfigFailure(...)`）三条路径必经 finally。**rev3 修正**：schema run 走 config-failure 提前
  return 时，state-machine settle 从未发生、staged 入队从未发生 → policyPendingRunIds 无登记 → finally
  **不触发 finalize**，F2 已发送的记录不会被迟到补丁误伤（旧版 gen=0 占位 + `gen||1` 的误触面整体消失）。
  notifier.finalize 对 `pending/delivered` 的 late/no-op 分支（#13）降为纵深防御，非主防线。
  配套用例（验收⑧补）："schema run hitting config-failure never triggers finalize"——断言 F2 记录发送后
  无任何 finalize audit，且记录无 degradedReason/finalized 标记。
- `patchOf(outcome)`：`{ status, textPreview: structuredPreview ?? outcome.text ?? "", structuredPreview,
failReason: error?.message ?? timeoutReason, label: diag.label, diag: summaryOf(diag) }`；
  `textPreview` 取 structuredResult 预览优先（§1.3）。

## 5. F1/F2 稳定 key 迁移（rev2 #2 显式步骤）

**F2 — `runtime-adapter.ts:249`（settleConfigFailure 内 enqueue payload）**：

```ts
deps.notifier.enqueue({
  key: deliveryKey(runId, outcome.diag.generation), // 删第三段 status
  runId,
  generation: outcome.diag.generation,
  status: outcome.status,
  textPreview: "",
  label: outcome.diag.label, // diag 现成值（config-failure 通常为 undefined，保留字段一致性）
  failReason: outcome.error?.message, // F2 恒 failed(config)，error 必存在
  diag: {/* 既有五字段不动 */},
  createdAt: outcome.diag.createdAt,
  reconcileRound: 0,
});
```

**F1 — `stack.ts:237`（notifyTerminalFailure payload）**：

```ts
const payload = {
  key: deliveryKey(outcome.runId, outcome.diag.generation), // 删第三段 status
  runId: outcome.runId,
  generation: outcome.diag.generation,
  status: outcome.status,
  textPreview: outcome.text ?? "",
  label: outcome.diag.label, // runner rejection 的 diag 带 spawn 时 label
  failReason: outcome.error?.message ?? outcome.timeoutReason,
  diag: {/* 既有五字段不动 */},
  createdAt: outcome.diag.createdAt,
  reconcileRound: 0,
} satisfies DeliveryPayload;
```

F1 分治（§4.2 六行表平移 + 不做清单 8）：前缀扫描（现 252-261）**删除**，改 `notifier.peek(deliveryKey(runId, gen))`：

| `peek()` 返回            | F1 行为                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `undefined`              | `enqueue`（无记录 / list 内部失败时 peek 返回 undefined → fail-open enqueue，既有裁决保留） |
| `delivered` / `consumed` | 跳过                                                                                        |
| `pending` / `batched`    | 跳过（在途）                                                                                |
| `staged`                 | `notifier.finalize(runId, gen, failedPatch)` 合流——**不二次 enqueue**（验收⑦）              |
| `dropped` / `abandoned`  | `enqueue` 复活（`notifier.ts:129` 既有复活语义）                                            |

配套测试断言（rev2 #2）：① F1/F2 入队记录的 `key` 恰为 `runId:gen` 两段（不含 status）；
② F1 payload 带 `failReason === outcome.error.message`；③ enqueue 入口防御：直接向
`notifier.enqueue` 传三段 key 的 payload，`store.list()` 中记录 key 已归一为两段（canonicalize 单点生效）。

## 6. "零行为变化"边界修正（rev2 #3）

非 schema run 的**用户可见 content、发送时序（settle 即同步发送）、非 schema outcome 内容**不变——
这是保留的回归哨兵。以下观察值**必然变化**，需新增显式断言而非回避：

- `payload.key` / `details.key`：`runId:gen:status` → `runId:gen`；
- `onDelivery` 观察到的 `payload.key` 同上；
- `PersistedDelivery` 增 `storageKey` 字段（新记录恒等于 key）。

新增断言落点：`wiring.test.ts` 增「stable delivery key」用例——非 schema run settle 后 `details.key`
匹配 `/^r_[0-9A-HJKMNP-TV-Z]{8}:\d+$/` 且无第三段，`onDelivery` 收到的 key 与之一致。原 wiring 非 schema
用例的 **content 字符串与调用次数断言原样保留**（改了即破坏哨兵）；仅引用 key 三段形态的断言迁移为两段。

## 7. peek() 入 façade（rev2 #4）

`peek` 定为 `Notifier` **必需**方法（非可选）：可选化会逼 stack 写 `peek?.() ?? outbox.list()` 双路径，
等于把已删的前缀扫描以 fallback 复活，违背不做清单 8；`Notifier` 是本仓内部接口，无外部实现者要兼容。
`src/index.ts:303-315` `forwardNotifier` 增两行：

```ts
peek: (key) => requireStack(holder).notifier.peek(key),
finalize: (runId, gen, patch) => requireStack(holder).notifier.finalize(runId, gen, patch), // 一并转发，防 RPC/命令层后续要用时漏
```

## 8. spawn-service + result-tool（F/H）

- **F** `SpawnServiceDeps` 增 `runIdTaken?: (id: string) => boolean`（service 不 import delivery，§4.3/§6）；
  `spawn-service.ts:317` 排除集扩为 `records/running/tombstones/runIdTaken` 四项。
- **G-stack `runIdTaken` 快照**（buildSessionStack 内，outbox 构造之后）：
  ```ts
  let taken = new Set<string>();
  try {
    taken = new Set(
      outbox
        .list()
        .map((r) => parseDeliveryKey(r.key)?.runId)
        .filter((x) => x !== undefined),
    );
  } catch {
    console.warn("[pi-subagent] outbox list failed; runId uniqueness degrades to process-local (M17)");
  }
  ```
  传入 `createSpawnService({ ..., runIdTaken: (id) => taken.has(id) })`。
  `parseDeliveryKey` 从 `core/delivery-key.js` import（stack 是组装层，可直接引用 core）。
- **G-stack sender 双源取值（§1.3）**（现 145-181）：`label = payload.label ?? snapshot?.diag.label`；
  `failReason = payload.failReason ?? (payload.status !== "completed" ? outcome?.error?.message ?? ... : undefined)`；
  stats 行维持 `formatOutcomeSummary(store.get(...))` 现状（不进 payload，不做清单 9）。
  **pre-finalize 降级文案**：`payload.degradedReason === "pre-finalize"` 时 content 追加
  ` (pre-finalize snapshot; run get_subagent_result "${runId.slice(0,8)}" to confirm)`（§1.4 文案）。
- **G-stack 删 consume fallback**（现 222-233）：`onOutcomeConsumed` 收敛为
  `notifier.consume(deliveryKey(outcome.runId, outcome.diag.generation), by)` 单次调用。
- **H** `result-tool.ts:51-63`：删 `:completed` fallback，`consume(deliveryKey(runId, generation))` 单 key。

## 9. 改动波及面清点（测试迁移清单 —— 本期最大回归风险，rev2 已按评审核实修正）

grep 实测分布（key 形态直接断言共 **20 处 / 6 文件**）：

**必迁移（18 处 / 4 文件）**：

| 文件                                                   | 处数 | 更新策略                                                                                                                                                                                               |
| ------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/delivery/notifier.test.ts`（255 行）            | 13   | 基准 payload `r:1:completed`→`r:1`；TTL/abandon/reconcile 用例里的三段 key 改为两段；**另保留**专门兼容用例以三段 key 作输入、断言逻辑 key/storageKey 行为                                             |
| `tests/tools/result-tool.test.ts:64-90`                | 3    | `calls` 期望 `["r1:1:completed", ...]` → `["r1:1", ...]`；「only uses completed fallback…」整例删除，替换为「schema-flipped failure consumes single stable key」（断言 consume 恰一次、key 为 `r1:1`） |
| `tests/integration/stack-terminal-failure.test.ts:102` | 1    | `existing()` 的 key `r_failure:1:completed` → `r_failure:1`；既有五用例保留，补 staged 合流与 abandoned 用例（见 §10⑦）                                                                                |
| `tests/integration/notification-complement.test.ts:31` | 1    | 四段伪 key → `r_123456:1`                                                                                                                                                                              |

**opaque 样例保留（2 处 / 2 文件，不动）**：

| 文件                                       | 处数 | 理由                                                    |
| ------------------------------------------ | ---- | ------------------------------------------------------- |
| `tests/adapters/pi-outbox-store.test.ts:6` | 1    | store 适配器层 key 是不透明字符串，三段样例不影响行为   |
| `tests/extensions/registry.test.ts:26`     | 1    | 样例 payload 仅用于 onDelivery 透传测试，key 不参与断言 |

**功能牵连（无 key 断言但需过一遍）**：`wiring.test.ts`（增 §6 stable-key 用例；core.test.ts:1279 的 key
唯一性用法 opaque 不破坏）、`runtime-adapter-x3-x10`/`h2-failure-visibility`/`deadline-cap`（F2 路径）、
`status.test.ts`（Delivery 行）、`spawn-service.test.ts` + `ids.test.ts`（runIdTaken）。
**哨兵原则（rev2 #3）**：非 schema 用例的 content 与时序断言一律不动；仅引用 key 三段形态的断言迁移，
每处迁移核对 §6 边界清单。

## 10. 验收①-⑫ → 用例映射（⑫ 已按 rev2 改为可观察行为断言）

| #   | 文件/用例名（建议）                                                                                                                                 | 断言要点                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | `tests/service/runtime-adapter-x3-x10.test.ts`「schema-flip notification carries failed + reason」                                                  | schema run completed→failed(schema)：sendMessage content 含 `failed` 与 `error.message`；payload.failReason 正确；key 为两段                                                                                                                                                                    |
| ②   | `tests/integration/wiring.test.ts` 既有非 schema 用例 + 新增「stable delivery key」                                                                 | 既有 content/时序断言零改动全绿（哨兵）；新用例断言 `details.key` 两段形态、onDelivery key 一致（§6）                                                                                                                                                                                           |
| ③   | `tests/delivery/notifier.test.ts`「staged record released by reconcile with pre-finalize annotation」                                               | enqueue(hold) → 不发送 → reconcile → 发出，payload.degradedReason="pre-finalize"、finalized=false、attempts 继承、reconcileRound+1；stack 级补降级文案标注断言                                                                                                                                  |
| ④   | 同上「delivered+pending legacy pair redelivers the pending one」                                                                                    | put `r:1:completed`(delivered) + `r:1:failed`(pending) → reconcile 只重投 failed 那条（逻辑 key `r:1`），delivered 记录不被改写                                                                                                                                                                 |
| ⑤   | 同上「legacy key writes back via storageKey」                                                                                                       | 旧三段记录 consume/finalize/TTL-abandon 后 `store.list()` 回读：物理 key 不变、状态已更新（无分叉）                                                                                                                                                                                             |
| ⑥   | `tests/service/runtime-adapter-x3-x10.test.ts`「post-policy snapshot persisted」+ rev2 #6 增补「snapshot persist failure does not affect finalize」 | 前者：schema-flip 后 `store.get(runId).outcome.status === "failed"`；后者：注入 `store.put` 抛错 → warn 记录、finalize 仍用 post-policy outcome（通知内容为 failed + failReason，非 pre-policy completed）                                                                                      |
| ⑦   | `tests/integration/stack-terminal-failure.test.ts` F1 六分支全量（rev2 P2 项补全）                                                                  | 无记录→enqueue 发送；`delivered`→跳过；`consumed`→跳过；`pending`→跳过；`staged`→finalize 合流（单条发送、内容 failed、无二次 enqueue、原 staged 记录状态变 delivered）；`abandoned`→enqueue 复活；list/peek 失败→fail-open enqueue                                                             |
| ⑧   | `tests/service/runtime-adapter-x3-x10.test.ts` 三用例：正常返回 / policy 后抛出（注入）/ `resolveSessionSpec` 失败提前 return                       | 三路径后无 staged 残留（stats.staged===0），staged 记录均已 release（发送或 late-update），无 timer 依赖                                                                                                                                                                                        |
| ⑨   | `tests/service/spawn-service.test.ts` + `tests/core/ids.test.ts`「runIdTaken hit retries」「list throws → degraded」                                | 谓词命中 → newRunId 返回其他 id；stack 级：list 抛错 → warn + spawn 不崩、进程内检查仍生效                                                                                                                                                                                                      |
| ⑩   | `tests/delivery/notifier.test.ts`「illegal legacy key is audited and excluded」                                                                     | `r_x:1:running` 不归一、audit 一条 "illegal legacy key"、不参与折叠与重投；`r_x:1:timed_out` 正常归一                                                                                                                                                                                           |
| ⑪   | 同上「storageKey dual-index invariants」四子断言                                                                                                    | 读旧记录填 storageKey=三段物理 key；state Map 键=逻辑 key；五条写回路径（attempt-update/TTL-abandon/consume/finalize/retry）全部落物理 key；被折叠隐去记录不被误写（⑤的超集）                                                                                                                   |
| ⑫   | 同上「reconcile staged release is observable via audit + payload markers」（rev2：不 spy 私有函数）                                                 | N 条 staged 记录 reconcile → audit 序列恰含 N 条 "pre-finalize release"、sender 收到的每条 payload 均带 `degradedReason:"pre-finalize"` + `finalized:false`、持久化记录同标记；无任何 staged 记录以正常 completed 文案（无 degradedReason）发出——绕过 releaseStale 的实现必然违反此可观察不变量 |

**新增（rev2 P2 项）**：`tests/core/delivery-key.test.ts`（新文件）——`parseDeliveryKey` 白名单：
`r_ABCDEFGH:1` ✓、`r_ABCDEFGH:12:completed`（canonicalize 后）✓；非法样例各返回 undefined
（`"r:1"` runId 不过 isRunId、`"r_ABCDEFGH:0"` gen 非正、`"r_ABCDEFGH:abc"`、`"a:1:extra:2"` 冒号数 ≠1、`""`）；
`canonicalizeDeliveryKey`：终态四值各剥离，`queued/running/stopping/starting` 及任意串不剥离。

## 11. 实施顺序与检查点

1. **core key**（A/B/C + `delivery-key.test.ts`）→ `npm run typecheck` + core 测试全绿。
2. **notifier**（D 全量）→ `notifier.test.ts` 迁移后全绿 + 新增 ③④⑤⑩⑪⑫（此步可单独交付，重导出保旧 importer）。
3. **runtime-adapter**（E + F2 key）→ `runtime-adapter-x3-x10`/`wiring`/`h2-failure-visibility` 绿 + 新增 ①②⑥⑧。
4. **spawn-service + stack + result-tool + index façade**（F/G/H/I）→ `stack-terminal-failure`/`result-tool`/`ids` 绿 + 新增 ⑦⑨。
5. **status 行**（J）→ `status.test.ts` 绿。
6. **全量**：`npm run typecheck && npm test && npm run build`。

## 12. 风险清单

| 风险                                                      | 等级 | 缓解                                                                                |
| --------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| 测试迁移面（18 处必改 + 功能牵连 7 文件）误改掩盖行为回归 | 高   | §9 清单逐个过；§6 content/时序哨兵原则                                              |
| storageKey 漏用（R8）                                     | 中   | 收敛到 notifier 内单一 `writeBack` helper；验收⑤⑪ 直测 list() 回读                  |
| finalize 漏出口（R10 liveness）                           | 中   | finally 统一出口结构性保证 + 验收⑧三路径直测；P1 无 timer 兜底故结构保证是唯一防线  |
| 折叠规则实现错（delivered 隐藏 pending，P0-1）            | 中   | 验收④回放用例锁死                                                                   |
| canonicalize 过宽污染折叠（R11）                          | 低   | 终态四值白名单 + 验收⑩                                                              |
| `peek()` 被滥用成第二真相源                               | 低   | 只读、仅返回 state、仅供 F1；注释注明                                               |
| `batched` 占位态被 P1 意外产生                            | 低   | P1 无代码写 batched；reconcile 分支仅防御；status 行恒 0 可巡检                     |
| enqueue 入口 canonicalize 掩盖误用 / 旧记录 `state` 缺失  | 低   | 单点防御是有意裁决（§5），新路径直接构造两段 key；`state ?? "pending"` 沿用既有裁决 |

## 13. 验证命令

```bash
npm run typecheck && npm test && npm run build
# 分步：npx vitest run tests/core/delivery-key.test.ts tests/delivery/notifier.test.ts
#       npx vitest run tests/service/runtime-adapter-x3-x10.test.ts tests/integration/wiring.test.ts
#       npx vitest run tests/integration/stack-terminal-failure.test.ts tests/tools/result-tool.test.ts
```
