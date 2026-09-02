# notification 与 get_subagent_result 互补优化 — 实施方案（v3.1）

> 只读调查 + 本文档。复审裁决：**项 1（通知/outcome 一致化，含 stage/release）整体移出
> 本批**，与 D/E 合并为下批"delivery 状态机重设计"预研（设计前提见文末）。
> v3 范围 3 项：**A（consume 接线，含 P0-3 修复）、B（指引句）、C（必达 bug 修复 F1-F3）**。

## 0. 核实基线（行号均已复核）

- 状态机 `finish()`（core/state-machine.ts:291-303）：settle 时以**当时 status** 入队
  （schema run 为 completed）；`applyStructuredOutputPolicy` 在之后
  （runtime-adapter.ts:370-374）才可能把 outcome 翻成 failed(schema)——**本批不改此
  时序**，故 consume 需要 schema-flip fallback（项 A）。
- `notifier.enqueue`（delivery/notifier.ts:111-115）：persist pending 后同步 attempt→send；
  `reconcile`（:127）输入源仅 outbox，只重投 pending/dropped（:135）；`attempt` 开头有
  consumed 熔断（:84）。`consume`（:117-123）。
- `attempt`（:85-108）的 try 块同时覆盖 send 与成功路径的 `store.update`；失败分支
  （:97-107）内也有一次 `store.update`——两处 update 抛错当前都会逃逸/被误记。
- **P0-3 证实**：`adapters/pi-outbox-store.ts:31-39` 的 `put`/`update` **先改内存 cache
  再 `pi.appendEntry()`**；append 抛错时 cache 已是新值。若 consume 的 update 走此路径
  失败：Notifier 内存未标 consumed（v2 改序后），但 store cache 已是 consumed → 同进程
  `reconcile` 用 `store.list()` 把该记录按 consumed 过滤 → **不再重投 = 静默丢失方向**。
- `pi-run-log.ts:24-32`：snapshot 的 appendEntry 异常被吞（best-effort）——snapshot
  找回不是硬保证（影响项 A 残余风险表述）。
- `runner.ts:435-437`：driver.prompt 抛错被捕获 → dispatch `prompt_settled` → 正常
  状态机通路返回 outcome，**不 reject**——F1 测试不能用 driver 抛错驱动（见项 C）。
- `OutboxStore` 接口（core/store.ts:22-26）只有 put/update/list；前缀查只能 list() 过滤。
- `resolveRunId`（resolve-target.ts:112-121）：`startsWith` 唯一前缀，不剥离 `#`；
  runId `r_XXXXXXXX`，`slice(0,8)`="r_"+6 位。
- spawn-service catch 路径（spawn-service.ts:163-189）：runner.run() reject →
  `finish(failed outcome)`（diag.generation 恒 1），无 notifier 入口。
- `settleConfigFailure`（runtime-adapter.ts:227-246）：只 put snapshot + lifecycle，
  不 enqueue；snapshot 构造在场（generation 取自 `outcome.diag.generation`=1）。
- `forwardNotifier` 晚绑定已存在（index.ts:288-305）；result-tool 接线点 index.ts:128。
- `forwardSpawn` 仅转发 spawn/spawnAndWait/waitAll，本批不动（hasLiveWaiter 随 E1 砍除）。

---

## 项 A：consume 接线（含两处复审修正）

**语义（维持 v2 收窄版）**：consume = "有消费者取走了 outcome，重启 reconcile 不再
重投该 key"。**不承诺**结果已进入模型上下文（无 caller ack），**不做任何实时抑制**
（无 claim 窗口、无 waiter 检查、不影响 send/retry 时序）。

**残余风险（P1-9 修正表述）**：consume 可能关闭该 key 的**唯一主动重投渠道**——若
工具结果随后丢失（pi 崩溃/turn abort），找回依赖 snapshot store/tombstone 的显式查询
（get_subagent_result、/agent status），而 snapshot 落盘本身是 best-effort
（pi-run-log.ts:24-32 吞 appendEntry 异常），**不是硬保证**。结论：这是"重复 vs
丢失"权衡下有意接受的取舍，方向仍为"宁重复不丢失"之外的唯一例外，须写入文档与
consume 的 jsdoc。

**改动**：

1. `src/delivery/notifier.ts` consume（:117-123）改序为**先写盘后改内存**：
   ```ts
   try {
     options.store.update(key, { state: "consumed" });
   } catch (err) {
     degraded.push({ key, reason: `consume persist failed: ${msg}`, at: clock.now() });
     return false;
   }
   state.set(key, { ...record, state: "consumed" });
   audit(key, "consumed");
   notifyExt(record, "consumed");
   return true;
   ```
   失败时 Notifier 内存不变、返回 false、不抛错。配合下面的 P0-3 回滚后，"失败恒为
   重复（重投）而非丢失"真正成立。CAS 前置检查（:119）不变。
2. **P0-3 修复 `src/adapters/pi-outbox-store.ts`**：`put`/`update` 在 appendEntry
   抛错时**回滚 cache 再 rethrow**：
   ```ts
   update(key, patch) {
     const current = cache.get(key); if (!current) return;
     const next = { ...current, ...patch };
     cache.set(key, next);
     try { pi.appendEntry(OUTBOX_CUSTOM_TYPE, next); }
     catch (e) { cache.set(key, current); throw e; }  // 还原旧值，保持 cache 与盘面一致
   }
   // put 同理：旧值 = cache.get(record.key)（undefined 时回滚为 delete）
   ```
   效果：append 失败 → cache 仍是旧状态 → reconcile（`store.list()` 输入）按旧状态
   重投 → 重复方向。MemoryOutboxStore 无此问题（纯内存）。
   **前提（v3.1 标注）**：回滚的正确性依赖 pi.appendEntry 不同步重入同一 outbox
   （重入会打乱"旧值"语义）；当前 pi 实现无此行为，若未来违反需改为版本号校验。
3. `src/tools/result-tool.ts`：deps 加 `notifier?: Pick<Notifier,"consume">`。get 分支
   与 wait 分支均在**成功构造返回值之后的最后一步**调用（consume 失败不影响返回值）：
   ```ts
   const by = { extensionOwner: "get_subagent_result" };
   const tryConsume = (runId: string, gen: number, outcome: RunOutcome) => {
     if (!deps.notifier) return;
     try {
       const hit = deps.notifier.consume(deliveryKey(runId, gen, outcome.status), by);
       // schema-flip fallback（项1移出后恢复 v1 语义，v3.1 收窄）：入队 key 用 settle 时
       // status，仅 policy 翻转（failed + error.kind==="schema"）这一种情况 finalStatus
       // 才与入队 key 不同 —— 仅此情况 miss 后试 `:completed`；aborted/timed_out/普通
       // failed 的入队 key 与最终 status 一致，不做 fallback（避免无意义二次查询）。
       if (!hit && outcome.status === "failed" && outcome.error?.kind === "schema")
         deps.notifier.consume(deliveryKey(runId, gen, "completed"), by);
     } catch {
       /* 防御：consume 已不抛错，此处仅兜底未来改动 */
     }
   };
   ```
   generation：get 分支 `snapshot.generation`；wait 分支 `outcome.diag.generation`。
4. `src/service/spawn-service.ts`：deps 加 `onOutcomeConsumed?: (outcome) => void`，
   `spawnAndWait` resolve 后调用（try/catch）。`stack.ts` 接线：
   ```ts
   onOutcomeConsumed: (o) => {  // 同样的 schema-flip fallback，与 result-tool 同一收窄条件
     try {
       const by = { extensionOwner: "spawnAndWait" };
       if (!notifier.consume(deliveryKey(o.runId, o.diag.generation, o.status), by) &&
           o.status === "failed" && o.error?.kind === "schema")
         notifier.consume(deliveryKey(o.runId, o.diag.generation, "completed"), by);
     } catch {}
   },
   ```
5. DI：`index.ts:128` → `createResultTool({ query, resolveRun, notifier: forwardNotifier(holder) })`。

**边界**：CC2 子 run 未入队 → consume 返回 false 无害；run 未完成不 consume；
重复 get 首次 true 后续 false。

## 项 B：指引句（v2 复审通过，原样保留）

`src/stack.ts` sender（:160-170 区域）：

```ts
const truncated = tail !== undefined && tail.length > 200;
const hint = truncated ? ` — get_subagent_result "${payload.runId.slice(0, 8)}" for full output` : "";
```

引号内**裸 8 位前缀、不带 `#`**（matchRunId 不剥离 `#`）；未截断不追加。本批项 1
移出后 structuredResult 尚进不了 textPreview，截断条件只对 text/failReason 生效——
structured 场景的截断指引随下批一致化自动获得，此处不额外处理。

## 项 C：F 必达 bug 修复（按复审修正）

三条路径统一进 `notifier.enqueue` → 同一 sender（stack.ts）出口。

**F1 runner rejection（spawn-service.ts:163-189）**

- deps 加 `notifyTerminalFailure?: (outcome: RunOutcome) => void`；catch 内调用。
- **时序约束（v3.1）**：`notifyTerminalFailure` 必须在 `finish()`（含 snapshot 持久化）
  **之后**调用——stack sender 依赖 `store.get(runId)` 组装 stats/failReason，先 enqueue
  会读到无 outcome 的旧 snapshot。即 catch 块内先 `finish(o)` 再
  `deps.notifyTerminalFailure?.(o)`。
- `stack.ts` 接线构造 payload（key=`deliveryKey(o.runId, o.diag.generation, o.status)`、
  `textPreview: o.text ?? ""`、diag 简表仿 state-machine.ts:298-302、reconcileRound:0）
  → 经防双发检查后 `notifier.enqueue`。
- **防双发（v3.1 按 state 区分，P0 处方）**：enqueue 前查 outbox 中 `runId:gen:` 前缀
  记录（"settle 已入队、run() 仍 reject"组合），按 state 分治：
  ```ts
  const prefix = `${o.runId}:${o.diag.generation}:`;
  let existing: PersistedDelivery | undefined;
  try {
    existing = outbox.list().find((r) => r.key.startsWith(prefix));
  } catch {
    /* list() 抛错 fail-open：不确定时宁可重复，照常 enqueue */
  }
  const st = existing?.state ?? "pending"; // state 缺失（旧记录）按 pending 保守处理
  if (existing && st !== "dropped" && st !== "abandoned") return; // pending（backoff 重试在途）/delivered/consumed → 跳过
  notifier.enqueue(payload); // 无记录，或 dropped/abandoned → 补投
  ```
  OutboxStore 无前缀查询，list() 过滤即可（记录量级小）。stack.ts 接线处持有
  outbox 引用（:126-130 创建）。跳过是纯静默（审计可经 notifier.stats 旁证），
  不新增 audit 通道。
- **enqueue 行为核实（P0 处方前提修正）**：评审假设"同 key enqueue 会覆盖并重置
  attempts 重新 attempt"——**核实 notifier.ts:112，同 key 是无条件 no-op**
  （`if (state.has(payload.key)) return;`），dropped 记录不会被复活。故补投需
  `enqueue` 一处小改动：早退仅对 `pending/delivered/consumed`；既有记录为
  `dropped`/`abandoned` 时重置为 `{ ...payload, state:"pending", attempts:0 }`、
  persist 覆盖、重新 attempt（主链路无影响——正常 settle 路径的 key 只入队一次）。
- **测试驱动修正**：runner.ts:435-437 会捕获 driver.prompt 异常走正常状态机通路，
  测不到 F1——必须用**显式 reject 的 Runner stub** 直接驱动 SpawnService（复用
  tests/service/spawn-service.test.ts:27-39 的 `deps(runner)` 模式：
  `runner.run = async () => { throw new Error("boom"); }`）。

**F2 后台 config-failure（runtime-adapter.ts:227-246 settleConfigFailure）**

- 末尾 `deps.notifier.enqueue(payload)`：generation/status/diag 全部取自现有
  snapshot/outcome 构造（`outcome.diag.generation`=1、status="failed"、
  textPreview=""）；CC2 过滤 `if (!childRunIds.has(runId))`（run() 入口 :251 已 add）。
- try/catch + console.warn：通知失败不阻断失败返回路径。
- **显式接受的取舍（P1-3 裁决）**：前台 config-failure 会**重复通知**（waiter 拿到
  error 的同时也发通知）——重复优于丢失的硬约束方向，且该路径罕见；不引入
  后台标志传递。写入文档即本段。

**F3 outbox 写失败韧性（notifier.ts）**

- `enqueue`（:111-115）：`persist` 的 `store.put` 包 try/catch——抛错时 `state.set`
  保留内存记录 + `degraded.push({key, reason:"outbox put failed: …"})` +
  `audit(key,"pending",msg)`，**照常 attempt**（内存重试/backoff 继续；落盘失败 ≠ 不发）。
- `attempt` **两个分支都修**（P0-2：v2 只搬了成功路径）：
  ① 成功路径（:86-95）：send 之后的 `store.update` 移出主 try、独立 catch 记 degraded
  ——update 抛错不再被误记为 send 失败而触发重投；
  ② 失败分支（:97-107）：`store.update` 独立 try/catch 记 degraded——保证异常不逃逸，
  `audit`/`notifyExt`/backoff `clock.setTimer` **一定执行**。
- 断言基准（P1-7 修正）：put 失败 + send 成功 → `stats.delivered===1` + degraded 有
  记录（内存照样标 delivered）；send 失败 + update 失败 → 仍进 backoff、attempts
  递增正确。

---

## 测试方案（全部为行为测试，含驱动方式）

**项 A**

- notifier 单测（FakeClock+FakeOutbox）："consume 后 reconcile 不重投；未 consume 的
  pending/dropped 照常重投"（对照两组 key）。
- "store.update 失败时 consume 返回 false、degraded 有记录、内存未标 consumed、重启
  后该 key 仍按原状态重投"（FakeOutbox update 注入抛错）。（P2-3：删除"consume 抛错"
  用例，consume 不再抛错。）
- **真实 PiOutboxStore 覆盖（P2-2）**：新建 tests/adapters/pi-outbox-store.test.ts，
  host stub = `{ appendEntry: () => { throw ... }, sessionManager: { getEntries: () => [] } }`
  （接口见 pi-outbox-store.ts:5-8）："update 的 append 失败后 cache 回滚、list() 返回
  旧状态、reconcile 仍重投该 key"；"put 的 append 失败后 list() 不含该记录"。再叠加
  真实 notifier + 真实 createPiOutboxStore 的集成用例：consume 遇 append 失败 →
  返回 false → reconcile 重投（失败恒为重复的端到端证据）。
- result-tool（stub QueryService + 记录型 notifier stub）："get/wait 成功返回时以
  最终 status+正确 generation consume"；"schema-flip fallback：failed 且
  error.kind==='schema' 时先 `:failed` miss 再 `:completed` 命中"；"普通 failed
  （error.kind!=='schema'）/timed_out/aborted 不做 fallback（consume 仅调用一次）"；
  "run 未完成不 consume"；"notifier 缺失时正常返回"。
- spawn-service（`deps(runner)` stub）："spawnAndWait resolve 后回调 onOutcomeConsumed"。

**项 B**

- sender 文案用例："tail≤200 无指引句；tail>200 有指引句且含裸 8 位前缀
  （`"r_XXXXXX"`，无 `#`）"。（驱动：wiring 级 `sent` 不可见文案——sender 在
  stack.ts；将格式化抽为纯函数或在 wiring 测试以真实 sender+假 pi.sendMessage 捕获。）

**项 C**

- F1："显式 reject 的 Runner stub → 后台 run 产生 failed 通知"（spawn-service 级
  `notifyTerminalFailure` stub 断言 payload + wiring 级真实 notifier，sent 含
  runId+failed）；"**通知内容含失败原因**"（sender 组装后带 error.message——证明
  enqueue 在 finish()/snapshot 持久化之后，时序约束生效）；"同前缀 pending/delivered/
  consumed 记录 → 跳过"；"**existing dropped 记录 → F1 仍 enqueue**"（对照：复活重投、
  attempts 重置）；state 缺失旧记录按 pending 跳过；"**outbox.list() 抛错 → fail-open
  照常 enqueue**"。不得用 driver.prompt 抛错驱动（runner.ts:435-437 会捕获）。
- F1 的 notifier 侧：同 key 且既有记录为 dropped/abandoned 时复活重投（新增用例
  锁定）；pending/delivered/consumed 仍为 no-op（既有去重用例回归）。
- F2："后台 config-failure（H2 抛错 / deadlineAt 过期 CP2）产生通知"；"嵌套子 run 的
  config-failure 无通知（CC2）"；"前台 config-failure 通知照发（已接受的重复）"。
- F3："put 失败 + send 成功 → stats.delivered===1 且 degraded 有记录"；"send 失败 +
  update 失败 → 仍进 backoff、attempts 递增、audit 完整"。
- 回归：现有 retry/backoff（notifier.test.ts:34-55）与 consume CAS（:57-69）必须通过。

## 实施顺序与验证

1. **A**（pi-outbox-store 回滚 → notifier consume 改序 → result-tool → spawn-service → 接线）。
2. **C**（F3 → F2 → F1）。
3. **B**（stack.ts sender）。

每步 `npm run typecheck && npm test`；全部完成后 `npm run build`。

## 风险清单

| 风险                                             | 等级 | 缓解                                                        |
| ------------------------------------------------ | ---- | ----------------------------------------------------------- |
| consume 关闭唯一主动重投渠道（工具结果随后丢失） | 中   | 有意取舍，已写入文档+jsdoc；显式查询兜底（best-effort）     |
| schema-flip fallback 掩盖 key 不一致的根因       | 低   | 根因修复属下批项 1；fallback 有测试锁定                     |
| pi-outbox-store 回滚改变 put/update 失败语义     | 低   | 方向恒为重复；行为测试锁定                                  |
| 回滚依赖"appendEntry 不同步重入同一 outbox"前提  | 低   | 当前 pi 无此行为；未来违反时改版本号校验（已写入项 A 前提） |
| F1 前缀检查漏掉跨 generation 组合                | 低   | 已知边缘，同 gen 已覆盖；双发方向可接受                     |
| F2 前台重复通知                                  | 低   | 显式裁决接受（P1-3）                                        |
| F3 内存-only 记录崩溃后丢失                      | 低   | G5a 降级语义内（outbox 已故障），degraded 可观测            |

## 下批预研：delivery 状态机重设计（项 1 + D + E 合并，本批不做）

两轮复审沉淀的设计前提（原样记录，下批展开前逐条回应）：

- **stage/release（项 1）**：需要完整状态转移表 + 失败矩阵（hold/release/consume/
  reconcile 的全交叉）；两 key 迁移（completed→failed）非原子（P0-1）——候选方向：
  先 put 新 key 再 retire 旧 key，或改用 status 无关的稳定 key `runId:gen`（简化方向，
  记录备查）；staged payload 必须按 runId/generation 的 Map 暂存，不能依赖单次闭包；
  `snapshotFromStoreOrRebuild` 需明确重建规则（store miss 时字段从哪来）；崩溃路径的
  stale pre-policy 通知只能降级标注，无法消除。
- **D（coalesce）**：需 delivered-after-flush 语义或 outbox claim 状态——flush 前
  不得标 delivered（P0-1）；triggerTurn 是控制流信号，延迟需 SLA 与 flush/dispose
  生命周期（P1-5）。
- **E（waiter 抑制）**：waits Map 只是 resolver 注册表，无 caller ack 即无法证明
  "结果已被模型接收"（P0-4）；waitAll 无 signal、无注销协议（spawn-service.ts:401
  原生 setTimeout 超时不清理 waiter）；isConsumed/claim API 及其状态所有权未定义
  （P1-3）。本批 consume 的落盘数据可作为未来 claim 语义的基础。
