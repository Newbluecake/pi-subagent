# 超时宽限 + 主会话通知 + 延长超时 —— 只读探索报告

> 探索范围：只读，未修改 `src/` 任何文件。目标特性：
> ①fleet widget 显示 run 剩余超时；②run 到达总超时（`totalMs`/`deadlineAt`）时不直接杀，
> 进入宽限期并通知主会话；③主会话可延长 run 的超时。

---

## 1. 超时全链路

### 1.1 DeadlineBudget 默认值 & Agent 工具 timeout_ms 的落点

- **默认值定义处**：`src/core/deadline.ts:4-18` `DEFAULT_BUDGET`（`DeadlineBudget` 常量对象）。
  - `totalMs: 1_800_000`（30 分钟）即"总超时"默认值；`abortGraceMs: 10_000`（10s）即现有的中止宽限时长。
  - 类型定义在 `src/core/types.ts:56-69`（`DeadlineBudget` 接口，14 个字段）。
- **每类型覆盖**：agent-type frontmatter 的 `budgetOverride?: Partial<DeadlineBudget>`（`src/core/types.ts:105`，`AgentTypeConfig.budgetOverride`）。
- **Agent 工具入口**：`src/tools/agent-tool.ts:154-159` 声明 `timeout_ms` 参数（typebox schema）；
  `agent-tool.ts:267` 把它转成 `budgetOverride: { totalMs: params.timeout_ms }`，随 `SpawnRequest` 一起传给 spawn 服务。
  最终合并顺序（agent-type override → per-spawn override）在 spawn-service 里完成（未在本节展开，见第 4 节）。
- **SpawnRequest.deadlineAt 语义**（`src/core/types.ts:196-212`，CC4 设计）：
  - 绝对 wall-clock 上限（epoch millis），语义为 `deadlines.deadlineAt = min(enqueuedAt + budget.totalMs, deadlineAt)`；
  - **只收紧不放宽**（`min()` 自动保证）；
  - 在 enqueue 时刻**一次性计算，永久冻结**（核心不变式 B1：“算法只决策一次，从不重算”——这是理解“延长超时”为什么需要**新增输入类型**而不能直接改字段的关键背景）；
  - 若入队时已过期 → 直接 `failed(config)`，不占用 slot / 不建会话；
  - 必须逐层显式传递（`src/service/request-threading.ts` 有编译期防丢线检查），否则会被静默丢弃（`ResolvedSpawnRequest.parentRunId` 就是历史上真实发生过的失败案例，代码注释里点名了）。
  - 落地到 state machine 的地方：`src/core/state-machine.ts:428-436`（`enqueued` 分支）：
    ```
    const raw = input.budget.totalMs === 0 ? undefined : input.at + input.budget.totalMs;
    const cap = input.deadlineCapAt;
    const deadlineAt = cap === undefined ? raw : raw === undefined ? cap : Math.min(raw, cap);
    ```
    这是 `RunState.deadlines.deadlineAt` 唯一的写入点（此后只在 `deadline_fired` 分支里被"清空 armedTimers 条目"，**从未被重新赋值**）。

### 1.2 state-machine.ts：`deadline_fired(timer="total")` 完整处理路径

- **RunPhase 全集**（`src/core/state-machine.ts:139-152`，`RUN_PHASES`，12 个）：
  `queue_wait → resolve_config → session_create → extension_bind → prompt_dispatch → model_turn ⇄ tool_exec ⇄ retry_backoff ⇄ compaction → abort_grace → reap → settled`
  **已经存在“宽限”类 phase：`abort_grace`**（`phaseTimer` 映射见 `state-machine.ts:159-172`，`abort_grace: "abort_grace"` 定时器；时长来源 `budget.abortGraceMs`，见 `src/core/deadline.ts` `dueAtFor` 的 `phase === "abort_grace"` 分支）。
- **`deadline_fired` 处理入口**：`state-machine.ts:675-706`。
  - `!state.armedTimers.includes(input.timer)` → `illegal`（防御性检查）。
  - `removed`：从 `armedTimers` 里摘掉该 timer id（**不是**清空 `deadlines.deadlineAt`，那个字段永远不再变）。
  - 按 `state.phase` 分支：
    - `resolve_config` → 直接 `finish(..., "failed", ..., { timeoutReason: input.reason })`（尚未起会话，无需 dispose）。
    - `queue_wait` → 直接 `finish(..., "failed", ..., { timeoutReason: "queue_timeout" })`。
    - `session_create` / `extension_bind` → 直接 `finish(..., "timed_out", ..., [{ kind: "dispose" }])`（启动期超时，没有可 abort 的会话，只需 dispose）。
    - **`abort_grace`**（即"已经在宽限期里，宽限期本身又超时了"）→ `state-machine.ts:684-693`：
      ```
      const status = state.diag.timeoutReason !== undefined || state.diag.stopCause === "timeout"
        ? "timed_out" : "aborted";
      return finish(removed, status, input.at, budget, { timeoutReason: input.reason },
        [{ kind: "request_abort" }, { kind: "dispose" }]);
      ```
      这里才真正 side-effect 掉 session：`request_abort`（cancel signal 已经在进入 abort_grace 时发过一次，这里是二次强制）+ `dispose`。
    - **其余所有运行中 phase（含 `model_turn`/`tool_exec`/`retry_backoff`/`compaction`，也就是 `total` 计时器正常触发时命中的分支）**→ `state-machine.ts:701-706`：
      ```
      const entered = enter(removed, "stopping", "abort_grace", input.at, budget, {
        timeoutReason: input.reason,
        stopCause: "timeout",
      });
      ```
      即：**第一次总超时不会直接杀，而是先进入 `abort_grace`**（status 变 `"stopping"`，不是终态！`terminal()` 判断见 `state-machine.ts:151-152` 只认 completed/failed/timed_out/aborted）。随后发 `cancel_signal` + （若原 phase 在运行中）`soft_steer: "wrap up now"`（`state-machine.ts:706-712`）。
      **只有 `abort_grace` 计时器（`budget.abortGraceMs`，默认 10s）到期后再次 `deadline_fired` 才真正终结**（上面 `abort_grace` 分支）。
  - **这意味着"总超时先进宽限期"这条主干在状态机层面已经天然存在**——新特性①②要做的不是"新增一个 phase"，而是：
    (a) 在进入 `abort_grace` 的这一刻（`state-machine.ts:701`）往主会话发一条通知（目前只发 `soft_steer` 给**子会话自己**，不发给 root）；
    (b) 让 `abortGraceMs` 在“总超时触发的宽限”场景下可被主会话动态延长，而不是固定 10s 就杀。
- **最终 `timed_out` 状态的落地**：`finish()`（`state-machine.ts:264` 起，本文没展开全文，行为是设置 `status`、`diag.timeoutReason`、清空 `armedTimers`、发 `settle_waiters`/`release_slot`/`emit_lifecycle`/`enqueue_delivery`/`persist_snapshot` 等终态 effect）。

### 1.3 runner.ts 与状态机的交互

- `dispatchExternal(runId, generation, input)`（`src/runtime/runner.ts:226-230`）是**唯一**外部输入入口——watchdog tick / effect-failure 反馈都走这里，内部调用 `reduce()`（`core/state-machine.ts`）得到新 state + effects，再交给 `EffectInterpreter`。
- **`fireDeadline`**（`runner.ts:313-318`，M4 设计，注释详细）：
  ```
  fireDeadline(runId, generation, input) {
    ...
    this.dispatchExternal(runId, generation, input);   // 1) 先让状态机记录 timeoutReason，进 abort_grace
    const entry = this.activeCancels.get(runId);
    if (entry && entry.gen === generation) entry.cancel.cancel("timeout"); // 2) 再真正 cancel 阻塞中的 run()
  }
  ```
  **顺序不可颠倒**（代码注释原话）：先 deadline 后 cancel，否则 cancel 派发的 `stop_requested` 会在 `abort_grace` 里把 `timeoutReason` 覆盖成笼统状态。
- **effect 执行者**：`BasicEffectInterpreter`（`runner.ts:114-163`）——`abort`/`dispose`/`request_abort`/`cancel_signal` 等效果的**真正执行体**是通过构造时传入的 `handlers: Partial<Record<RunEffect["kind"], (e)=>void>>`，在 `service/runtime-adapter.ts` 里接线到真实的 `SessionHandle.abort()` / `driver.dispose()` 等（不在本节展开，属于第4节的邻接层）。`applyCriticalSync` 只同步跑 `criticality:"critical"` 的效果（`release_slot`/`settle_waiters`/`clear_timer`/`persist_snapshot`，见 `state-machine.ts` 的 `envelope()`，`state-machine.ts:227-235`）。
- **watchdog 只做轮询，不持有真实定时器**（见 1.4）——`arm_timer`/`clear_timer` 这两个 effect 目前只用于维护 `RunState.armedTimers`（诊断用途），真正“到点触发”是靠 `EventWatchdog.tick()` 每秒重新读取 `state.deadlines.deadlineAt`/`dueAtFor(...)` 与 `now` 比较（`src/runtime/watchdog.ts:46-64`）。**这对"延长超时"极为有利**：只要状态机把 `state.deadlines.deadlineAt` 改成更大的值，下一次 tick 自然就不会误杀，完全不需要重新"武装"任何真实计时器。

### 1.4 src/core/deadline.ts：dueAtFor / remainingFor

- `remainingFor(phaseBudgetMs, now, d: RunDeadlines)`（`deadline.ts:24-32`）：`phase` 预算与 `d.deadlineAt` 取较小者，`d.deadlineAt` 已过期时返回 `{ms:0, capped:"expired"}`。目前只在 runner 内部用于某些同步等待场景（未在本次探索中定位到调用点，属于 legacy `withDeadline` 辅助）。
- `dueAtFor(phase, diag, budget)`（`deadline.ts:34-77`）：按 phase 分派到具体的到期时间点：
  - `model_turn`：`min(lastEventAt+idleMs, phaseEnteredAt+modelTurnMs)`（双重约束，M4 修复）。
  - `retry_backoff`：走 `idleDueAt`（`deadline.ts:79-82`），覆盖 backoff 本身时长 + `retrySlackMs`。
  - `abort_grace`：`start + budget.abortGraceMs`（**这就是宽限期时长的唯一来源**——`totalMs` 触发后的宽限固定用 `abortGraceMs`，与用户主动 `stop` 触发的宽限用的是**同一个**字段，没有区分“总超时宽限”与“用户中止宽限”）。
  - `total` 计时器本身**不走** `dueAtFor`——watchdog 直接读 `state.deadlines.deadlineAt`（`watchdog.ts:52`）。
- **关键结论**：要新增“可延长的总超时宽限时长”，`dueAtFor` 的 `abort_grace` 分支必须能感知“这次 abort_grace 是不是因为总超时触发的”，否则会跟用户主动 `stop_requested` 的宽限混在一起，语义会打架（详见第 7 节改造触点）。

---

## 2. 通知机制

### 2.1 delivery/ 通知 outbox 完整生命周期

- **状态集合**（`src/delivery/notifier.ts:8` `DeliveryState`）：
  `"staged" → "pending" → "batched" → "delivered" → "consumed"`，另有旁支 `"dropped"`（重试超限）/`"abandoned"`（reconcile TTL/轮次超限）。
- **引擎层**（`src/delivery/engine.ts`）：`createDeliveryEngine` 是通用的 `put/get/select/transition/claim/annotate/freeze` 状态机 + 持久化封装（对 `OutboxStore` 的读写），fabric（`src/fabric/router.ts`）和 delivery notifier 都复用它。
- **notifier 层**（`src/delivery/notifier.ts`）实际驱动生命周期：
  - `enqueue(payload, {hold})`：`hold:true` → 落 `"staged"`（等 `finalize` 才真正进队列，用于 X10 schema 校验等需要"先确认再发"的场景）；否则直接 `"pending"` 并立刻 `attempt()`。
  - `finalize(runId, generation, patch)`：把 `"staged"` 转正为 `"pending"` 并发出（`notifier.ts:243-266`），返回 `"sent"`；若记录已经不是 `"staged"`（迟到的 finalize）则只 `writeBack` 补丁，返回 `"late"`；找不到记录返回 `"missing"`。
  - `attempt(record, round)`（`notifier.ts:176-192`）：调用 `send()`（外部 `sender.sendMessage` 或函数式 sender）；`willBuffer` 预判是否会被 coalescer/ackHold 缓冲 → 提前打 `"batched"`；成功 → `settleDelivered`（`"delivered"`，`attempts+1`）；失败 → `settleFailed`（超过 `maxAttempts` 记 `"dropped"`，否则退避重试 `backoffMs * 2^(attempts-1)`）。
  - `consume(key)` / `ack(runId, generation, by)`：把记录标记 `"consumed"`（终态，不会再重试/reconcile）。`ack` 额外调用 `cancelBuffered(key)`（取消 coalescer/ackHold 里还没发出的缓冲副本）并累加 `ackedSuppressions` 统计（caller-ack 抑制，见下）。
  - `reconcile(persisted?)`：session 重启/`/reload` 后按 TTL（`reconcileTtlMs`）与轮次上限（`maxReconcileRounds`）扫一遍未终态记录，超限的转 `"abandoned"`，其余重新 `attempt()`。
- **completion 通知如何注入主会话上下文**：真正的 `sender` 在 `src/stack.ts:768-786`（`sendFormatted`）——单条走
  ```ts
  pi.sendMessage(
    { customType: "subagent:notification", content, display: true, details: payload },
    { triggerTurn: true },
  );
  ```
  多条聚合走同一函数但用 `formatDigest`（`src/stack.ts:781-786`）。**`triggerTurn: true` 是让主会话在下一轮自动看到这条消息（无需用户手敲）的关键参数**；`display: true` 让它同时出现在 TUI 里。这条 `sendMessage` 由 `notifier` 的 `sender.sendMessage` 调用触发，触发时机是 `attempt()`（`enqueue` 时若非 hold，或 `finalize` 转正时）。
  上游把 outcome 变成 `DeliveryPayload` 并调用 `notifier.enqueue(...)` 的地方在 `src/service/spawn-service.ts`（未展开源码，属于第4节邻接层——`notifyTerminalFailure` 回调签名可见于 `src/stack.ts:906-930`）。
- **caller-ack 抑制**：`notifier.ack()` 里的 `cancelBuffered` + `ackedSuppressions++`（`notifier.ts:296-317`）——语义是"调用者已经通过 `get_subagent_result`/`waitOutcome` 同步拿到结果了，不需要再异步推一条通知"，由 `src/service/spawn-service.ts` 的 `onOutcomeAcked` 回调驱动（接线见 `src/stack.ts:906-910`：`notifier.ack(outcome.runId, outcome.diag.generation, { extensionOwner: "spawnAndWait" })`）。
- **主会话是否真的"读到"了通知**：`src/delivery/context-receipt.ts` 的 `ContextReceiptTracker`（`noteDelivery`/`noteEntered`/`receiptOf`）追踪每个 runId 的通知是否已经 `"entered"`（进了主会话上下文）还是仍 `"pending"`/`"undeliverable"`；`turn_end`/`message_start` hook（`createNotificationReceiptHook`，`src/index.ts:146`）负责在真正的消息进入时调用 `noteEntered`。fleet widget 用这个 receipt 决定终态行是否继续 linger 展示（"待通知进入前不要让这行消失"）。

### 2.2 非终态事件通知主会话的现有机制

| 机制                                                                    | 触发方                                                  | 约束                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`message_agent(to:"root", kind:"progress"\|"finding"\|"directive")`** | 子会话自己主动调用（`src/tools/message-agent-tool.ts`） | 走 `fabric/router.ts` 的 `admit()`；需要 `canMessage` 包含 `"parent"`（默认值就是仅父级，`root` 的子代天然满足）；`progress`/`finding`/`directive` 各有独立配额（见 2.3）；投递到 root 时走 `sendRootContext`（steer 注入）或 `sendRootDisplay`（仅展示，视 `progressChannel` 配置）——见 `src/stack.ts:265-284`。 |
| **`@label` mention（fabric mention channel）**                          | 主会话或其它 agent                                      | 只能寄给"root 的直接子节点"（`tree.isRootChild`），且必须 `canMessage: ["mention"]`；本特性用不上（那是横向/反向通知，不是"子 run 通知自己的父会话"）。                                                                                                                                                           |
| **delivery outbox（本节 2.1）**                                         | 仅在 run 到达**终态**时由 spawn-service 触发 `enqueue`  | 只覆盖终态；非终态事件不走这条路。**这正是本特性②要新增的缺口**——"进入 abort_grace（宽限期）"目前只对子会话自己 `soft_steer`，不触达主会话。                                                                                                                                                                      |

**结论**：子会话内部想在非终态时刻推一条上下文消息给主会话，**现有机制里 `message_agent(to:"root", kind:"progress")` 是唯一现成的路径**，但那是"子会话自己决定发"，不是"运行时框架强制在进入宽限期时发"。本特性②如果要在框架层（而不是靠子会话自己写代码）实现"进宽限就通知"，大概率要在 `runner.ts`/`stack.ts` 里新增一条独立于 fabric 的通知路径（例如复用 delivery notifier 的 `enqueue`，给一个新的 `DeliveryPayload.status`-like 中间态，或者直接调用 `sendRootContext`/`sendFormatted` 等价逻辑），而不是指望子会话主动调用 `message_agent`。

### 2.3 fabric/ 消息路由

- **kind 全集**（`src/core/message.ts:5,42`）：`"progress" | "finding" | "directive" | "result" | "dead_letter"`。`message_agent` 工具只暴露前三种（`src/tools/message-agent-tool.ts:12`），`"result"`/`"dead_letter"` 是协议内部用的（正常结果回传 / 投递失败通知）。
- **配额**（`src/fabric/router.ts:16-19,232-241`）：`maxPerRun`（progress，每 run 每条会覆盖旧的 pending progress——见 `router.ts:154-160` 的"supersede"逻辑）、`findingQuota`、`directiveQuota`、`deadLetterQuota`，均从 `settings.fabric.*` 读取（在 `src/stack.ts` 组装时传入）。
- **root 方向是否可达**：可达——`canMessage` 默认值就包含 `"parent"`（`src/core/message.ts:95` `effectiveCanMessage`），子 run 发给 `to:"root"` 走 `authorize()`（`message.ts:107-118`）用 `relation = tree.relation(to, from)`（`progress`/`finding` 是反向关系检查）判定；只要 `canMessage` 未显式关闭 `"parent"`，root 就是可达目标。`directive` 方向相反（root → 子）。

---

## 3. 工具面：注册 pattern

- **schema + 定义**：每个工具是一个模块（`src/tools/*.ts`），用 `@sinclair/typebox` 的 `Type.Object({...})` 定义 `Params`，导出 `createXxxTool(deps): ToolDefinition<typeof Params>`（依赖注入，无全局状态）。例：`src/tools/message-agent-tool.ts:8-14`（Params）+ `:27-56`（factory）。
- **激活期注册**：全部集中在 `src/index.ts` 的 `activate()` 内，一次性 `pi.registerTool(createXxxTool({ ...forwardXxx(holder) }))`（例：`index.ts:188-236` 依次注册 `Agent`/`get_subagent_result`/`steer_subagent`/`set_model`/`abort_subagent`）。**这些是"主会话专属工具"**——之所以不会泄漏进子会话，是因为子会话重新 import 本扩展时会在 `activate()` 顶部就被 `HOST_KEY` 全局守卫拦截返回（架构里反复强调的 host-claim guard），子会话的 `activate()` 根本不会跑到 `pi.registerTool` 这些语句。
- **`holder`/`forwardXxx` 模式**：`activate()` 只在插件加载时跑一次，但 `buildSessionStack`（`src/stack.ts`）在每次 `session_start` 重建；工具的 `execute()` 不能直接闭包捕获某次构建的 stack 实例（会在 `/reload` 后失效），所以统一通过 `forwardSpawn(holder)`/`forwardQuery(holder)` 等在**调用时**才从 `holder.current` 里取最新 stack（`index.ts` 顶部有这些 `forwardXxx` helper 的定义，未在本次探索展开源码，属于同一文件内可查）。
- **动态工具裁剪**：`src/runtime/tool-scope.ts`——`RESERVED_TOOL_NAMES`（`tool-scope.ts:20-30`：`Agent`/`get_subagent_result`/`steer_subagent`/`StructuredOutput`/`message_agent`/`set_model`）默认对**所有子会话** `deny`（除非该 run 被显式 `granted`，比如 X3 嵌套 Agent 工具、X10 StructuredOutput）；`buildToolScopePolicy()`（`tool-scope.ts:66-73`）把 agent-type 的 `tools` 白名单 + `granted` 名单合成最终策略；`ToolScopeEnforcer.onBind`/`onTurnBoundary`（`tool-scope.ts:75-131`）在 bind 成功后与每个 turn_end 重新对 `SessionHandle.getActiveTools()` 做 diff 并 `setActiveTools()`，防止后注册的 MCP 工具绕过白名单。
- **新增 `extend_subagent_timeout`（主会话可用）需要动的文件**（结论，供第 7 节引用）：
  1. `src/tools/extend-timeout-tool.ts`（新文件）：typebox Params（`run_id`/`label`, `extend_ms` 或 `new_deadline_at`）+ `createExtendTimeoutTool(deps)`。
  2. `src/index.ts`：`activate()` 内 `pi.registerTool(createExtendTimeoutTool({ ... }))`（放在 `abort_subagent` 附近，主会话专属，天然被 HOST_KEY 守卫保护，**不需要**加进 `RESERVED_TOOL_NAMES`——因为它压根不会被子会话 import 到的 `activate()` 执行）。
  3. `src/service/query-service.ts`：新增 `extendDeadline(runId, ms)` 方法，语义类比 `steer`/`setModel`（查 registry 拿 snapshot，检查 `status==="running"`——或者要不要放宽到 `"stopping"`/`abort_grace` 阶段以支持"宽限期内追加时间"，是本特性的核心设计决策点）。
  4. `src/runtime/runner.ts`：新增 `extendDeadlineForRun(runId, generation, newDeadlineAt)`，通过 `dispatchExternal` 派发一个新的 `RunInput`（见第 4 节）。
  5. `src/core/types.ts` + `src/core/state-machine.ts`：新增 `RunInput` 变体（如 `{ kind: "deadline_extended"; at; newDeadlineAt }`）和对应 reduce 分支。

---

## 4. 服务面：run registry / 运行时改 deadlineAt

- **RunRegistry 暴露 run 状态**：`src/service/run-registry.ts`——`createRunRegistry(store)` 是纯 `SnapshotStore` 包装（只看持久化的终态记录）；`createLiveRunRegistry(live, store)`（`run-registry.ts:31-47`）才是实际接线的版本——`get`/`list` 先查 `live.snapshots()`（SpawnService 手上的**实时**内存记录，含运行中的），fallback 到 `store`（仅终态）。`QueryService.get/list`（`src/service/query-service.ts:44-45`）直接转发到这个 registry。
- **RunInput 现有 kind 全集**（`src/core/types.ts` `RunInput` union，13 种）：
  `enqueued | slot_acquired | slot_denied | phase_entered | session_created | startup_failed | session_event | prompt_settled | deadline_fired | stop_requested | escalation_done | reap_finished | effect_failed`。
  **没有任何一种是"运行时修改 deadlineAt"**——这是本特性③必须新增的输入类型（对照第1.2节结论："算法只决策一次"是核心不变式，`enqueued` 分支是 `deadlines.deadlineAt` 唯一写入点）。新增建议：
  ```ts
  | { kind: "deadline_extended"; at: Millis; newDeadlineAt: Millis }
  ```
  reduce() 里需要新增分支，语义草案：
  - 仅收紧不适用（这是"延长"，语义应为"只能变大，不能变小"——与 CC4 的 `min()` 收紧方向正好相反，需要在 reduce 里显式 `Math.max(state.deadlines.deadlineAt ?? 0, input.newDeadlineAt)` 或直接拒绝更小的值）。
  - 更新 `state.deadlines.deadlineAt` 与 `state.diag.deadlineAt`（fleet widget 读的是 `diag`/`deadlines` 两处都要同步，见第5节）。
  - 允许的 phase：至少要覆盖 `abort_grace`（"宽限期里追加时间"是本特性的核心场景），是否也允许在正常运行阶段（`model_turn`/`tool_exec`等）预防性延长是设计决策点。
  - **不需要新增/重新武装任何真实 effect**——因为 `EventWatchdog.tick()` 每次都从 `state.deadlines.deadlineAt` 现读（`watchdog.ts:52`），状态机只要把这个字段改大，下一次 1s 轮询自然不会再触发 `deadline_fired`。`arm_timer`/`clear_timer` effect 可以选择性地发一条用于诊断，但**不是**功能所需。
- **传导路径**：`QueryService.extendDeadline(runId, newDeadlineAt)` → `Runner.extendDeadlineForRun`（新方法，类比 `runner.ts:296-311` 的 `setModelForRun` 或 `runner.ts:313-318` 的 `fireDeadline`，用 `dispatchExternal` 派发新 input）→ `state-machine.reduce()`。**无需**触碰 `SlotPool`/`Reaper`/`EffectInterpreter` 的现有接口。

---

## 5. UI：fleet-panel.ts 加字段

- `FleetRow` 接口定义在 `src/ui/fleet-panel.ts:41-90`；`toRow(snapshot, opts)`（`fleet-panel.ts:332-372`）是唯一的映射函数——从 `RunSnapshot`（含 `snapshot.deadlines.deadlineAt`、`snapshot.diag.*`）算出展示字段。
- **加"剩余超时"字段的位置**：在 `toRow()` 里新增一行，例如：
  ```ts
  remainingMs: snapshot.deadlines.deadlineAt === undefined
    ? undefined
    : Math.max(0, snapshot.deadlines.deadlineAt - opts.now),
  ```
  同步在 `FleetRow` 接口加 `remainingMs: Millis | undefined;`。
- **已有的"过期判定"可直接复用/对照**：`highlightOf()`（`fleet-panel.ts:189-197`）已经在用 `snapshot.deadlines.deadlineAt` 做 `crit` 高亮判定（`opts.now > snapshot.deadlines.deadlineAt` → `"crit"`）——新特性①要做的"剩余超时倒计时"和这条判定逻辑共享同一个数据源，只是需要把差值也暴露出来供渲染文本使用（而不仅仅做二元高亮判断）。
- widget 侧渲染（用户已读过，不重复）会消费 `FleetRow.remainingMs` 来渲染倒计时/宽限期标签；若要区分"进入 abort_grace 宽限期"与"正常运行剩余时间"，还需要在 `toRow()` 里判断 `snapshot.phase === "abort_grace" && snapshot.diag.stopCause === "timeout"`，并可能新增一个 `graceRemainingMs` 字段（用 `abort_grace` 的 `phaseEnteredAt + abortGraceMs`）。

---

## 6. 测试布局

| 类别                                        | 位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **state-machine 可执行迁移矩阵 + 属性测试** | `tests/core/core.test.ts`（1866 行，全部内容都在一个文件）。关键锚点：`describe("transition contract", ...)`（line 111）、`describe("major recovery and deadline contracts", ...)`（line 334，M4 相关）、`describe("stopping ladder", ...)`（line 403，`stop_requested`/`deadline_fired` 走 `abort_grace` 的路径）、`FLAT_MATRIX`/`MATRIX`（line ~543 起，`RUN_PHASES × INPUT_KINDS` 全组合的显式表）、`describe("executable transition matrix (§4.4.1)", ...)`（line 1213：`expect(RUN_PHASES).toHaveLength(12)` / `expect(INPUT_KINDS).toHaveLength(13)`——**新增 RunPhase 或 RunInput kind 必须同步改这两个数字断言和 MATRIX 表**，否则测试直接报错）、`describe("P1-P10 property invariants", ...)`（line 1257，随机序列上的不变式，P6 直接断言 `result.state.deadlines.deadlineAt` 不变——**这条测试必须相应更新**才能允许"延长超时"这个新语义）、`describe("seeded property invariants", ...)`（line 1637）。 |

- **watchdog 测试**：未见独立 `watchdog.test.ts` 文件；watchdog 逻辑主要被 `tests/runtime/runtime.test.ts` 间接覆盖（`RuntimeRunner.fireDeadline`/`dispatchExternal` 路径）以及 `tests/core/core.test.ts` 的 `deadline_fired` 分支覆盖。改 `dueAtFor`/`EventWatchdog.tick` 时应检查 `tests/runtime/runtime.test.ts` 与 `tests/core/core.test.ts` 两处。
- **delivery 测试**：`tests/delivery/`——`engine.test.ts`（通用引擎）、`notifier.test.ts`（`enqueue/finalize/ack/reconcile` 全生命周期）、`context-receipt.test.ts`（`noteDelivery/noteEntered/receiptOf`）、`coalescer.test.ts`。
- **fabric 测试**：`tests/fabric/`——`router.test.ts`（配额/authorize/dead-letter）、`mailbox.test.ts`、`tree.test.ts`、`throttle.test.ts`、`mention.test.ts`。
- **service 层测试**（run registry / query-service / spawn-service 相关）：`tests/service/`——`query-service-stop.test.ts`、`query-service-set-model.test.ts`（**新增 `extendDeadline` 应仿照这两个文件加 `query-service-extend-deadline.test.ts`**）、`deadline-cap.test.ts`（CC4 `deadlineAt` cap 语义的专门测试，与本特性③高度相关）、`spawn-service.test.ts`、`resolve-target.test.ts`。
- **UI 测试**：`tests/ui/fleet.test.ts`（`buildFleetViewModel`/`toRow` 纯函数测试，新增 `remainingMs` 字段要在这里补断言）、`fleet-widget.test.ts`（widget 渲染层）。
- **工具测试**：`tests/tools/`——新增 `extend_subagent_timeout` 工具应仿照 `tests/tools/set-model-tool.test.ts` 或 `abort-tool.test.ts` 加 `extend-timeout-tool.test.ts`。
- **集成测试**：`tests/integration/wiring.test.ts` / `notification-complement.test.ts` / `fleet-widget-lifecycle.test.ts`——涉及"通知是否真的从子会话一路送到主会话上下文"的端到端断言，本特性②改完后应在此补一条"宽限期通知"的集成用例。

---

## 7. 设置项：新增 grace 时长 / 延长上限的 pattern

- **现状**：`abortGraceMs` 已经是 `DeadlineBudget` 的一员，享有完整的 `/agent settings` 文本命令 + TUI 编辑器支持——`BUDGET_SPECS`（`src/config/setting-specs.ts:113-124`）用 `Object.keys(DEFAULT_BUDGET)` 自动为每个 `DeadlineBudget` 字段生成一条 `seconds(...)` spec（存储/展示用整数秒 `budget.abortGraceS`，内部字段是 `budget.abortGraceMs`，转换见 `src/config/time-units.ts` 的 `secondsKeyOf`/`msKeyOf`），并配一句 `BUDGET_DESCRIPTIONS.abortGraceMs`（`setting-specs.ts:91`）。**新特性如果只是想让"总超时触发的宽限时长"可配置，最小改法是直接复用 `abortGraceMs` 这个已有旋钮**——不需要新增设置项；如果想让"总超时宽限"与"用户主动 stop 宽限"分离配置，则需要新增字段。
- **新增独立设置项的 pattern**（参照 `compact.hintThresholdPercent`/`compact.forceAtPercent`，`src/config/settings.ts:87-88,214-217`）：
  1. `src/config/settings.ts`：在某个子接口（例如新增 `TimeoutNotifySettings`）里加字段类型 + `DEFAULT_SETTINGS` 里的默认值 + `parseXxxSettings()` 校验函数（仿照 `parseCompactSettings`，`settings.ts:391` 附近，含范围钳制逻辑如 `hintThresholdPercent`/`forceAtPercent` 的相对大小校验）。
  2. `src/config/setting-specs.ts`：用 `seconds(path, {...})`/`count(path, ...)` helper 加一条 `SETTING_SPECS` 条目，配 `description`；如果是"延长上限"这种整数（非时长）用 `count()`；如果是时长用 `seconds()`（复用既有的 `msKeyOf`/`secondsKeyOf` 时间单位转换机制，不要自己写秒↔毫秒转换）。
  3. TUI 编辑器（`src/ui/settings-editor.ts`，未展开）会自动从 `SETTING_SPECS` 里读出新增条目，通常不需要手改。
  4. 需要在 `AgentSettings` 类型 + `DEFAULT_SETTINGS` 常量 + `parse*Settings` 三处同步，缺一处会在 `tests/config/agent-config.test.ts` / 对应的 `*-settings.test.ts` 里挂掉（参照 `tests/config/compact-settings.test.ts` 的测试形态）。

---

## 8. 改造触点清单（按子系统）

| 子系统                            | 预计要改的文件                                                                                                                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **core（类型+状态机，纯领域层）** | `src/core/types.ts`                                                                                                             | 新增 `RunInput` 变体（如 `deadline_extended`）；`RunEffect`/`DiagSummary` 若需要暴露"进入宽限"事件也在此加。                                                                                                                                                                                                                                                                                        |
|                                   | `src/core/state-machine.ts`                                                                                                     | ① `deadline_fired` 分支（line 701-706）在进入 `abort_grace` 时增加"是总超时触发"的标记（区分于 `stop_requested` 触发的宽限，供后续 `dueAtFor` 和通知逻辑判断）；② 新增 `deadline_extended` 输入的 reduce 分支（更新 `deadlines.deadlineAt`/`diag.deadlineAt`，只允许变大）；③ 同步更新 `RUN_PHASES`/`INPUT_KINDS` 相关的常量断言（若新增 phase，本特性目前判断不需要新 phase，只需新 input kind）。 |
|                                   | `src/core/deadline.ts`                                                                                                          | `dueAtFor` 的 `abort_grace` 分支可能需要区分"总超时宽限"用一个独立的 grace 时长字段（如果设计上要与 `stop_requested` 宽限分离）。                                                                                                                                                                                                                                                                   |
| **runtime（执行层）**             | `src/runtime/runner.ts`                                                                                                         | 新增 `extendDeadlineForRun(runId, generation, newDeadlineAt)` 方法（类比 `setModelForRun`/`fireDeadline`），通过 `dispatchExternal` 派发新 input；进入 `abort_grace` 时触发通知回调（新增 `RunnerDeps` 字段，如 `onGraceEntered`）。                                                                                                                                                                |
|                                   | `src/runtime/watchdog.ts`                                                                                                       | 基本不需要改（`tick()` 已经现读 `deadlines.deadlineAt`）；如果新增独立 grace 定时器字段，`timerReason` 映射表可能要扩展。                                                                                                                                                                                                                                                                           |
| **service（服务/编排层）**        | `src/service/query-service.ts`                                                                                                  | 新增 `extendDeadline(runId, newDeadlineAt \| extendMs)` 方法。                                                                                                                                                                                                                                                                                                                                      |
|                                   | `src/service/spawn-service.ts`                                                                                                  | 若要在"进入宽限"时机触发通知，通知的组装/推送大概率挂在这里（类比现有 `notifyTerminalFailure`）。                                                                                                                                                                                                                                                                                                   |
|                                   | `src/service/ports.ts`                                                                                                          | `Runner`/`RunRegistry` 接口若新增方法签名要同步。                                                                                                                                                                                                                                                                                                                                                   |
| **delivery / 通知**               | `src/delivery/notifier.ts` 或 `src/stack.ts`（`sendFormatted`/`buildFabric` 附近）                                              | 新增"进入宽限"通知的发送路径——可复用 `pi.sendMessage({customType: "subagent:grace", ..., triggerTurn:true})` 模式（对照 `stack.ts:768-786`），或扩展 delivery outbox 让它也能表达非终态事件。                                                                                                                                                                                                       |
| **fabric**                        | 可能不需要改；若选择走 `message_agent` 路径通知，需要在 runner 内部合成一次"框架级 progress 消息"而不是依赖子会话主动调用工具。 |                                                                                                                                                                                                                                                                                                                                                                                                     |
| **工具面**                        | `src/tools/extend-timeout-tool.ts`（新文件）                                                                                    | 主会话专属的 `extend_subagent_timeout` 工具。                                                                                                                                                                                                                                                                                                                                                       |
|                                   | `src/index.ts`                                                                                                                  | `activate()` 内 `pi.registerTool(createExtendTimeoutTool({...}))`。                                                                                                                                                                                                                                                                                                                                 |
| **UI**                            | `src/ui/fleet-panel.ts`                                                                                                         | `FleetRow` 加 `remainingMs`（及可能的 `graceRemainingMs`）字段；`toRow()` 计算逻辑。                                                                                                                                                                                                                                                                                                                |
|                                   | `src/ui/fleet-widget.ts`（用户已读，未重复探索）                                                                                | 渲染新字段。                                                                                                                                                                                                                                                                                                                                                                                        |
| **config/settings**               | `src/config/settings.ts`                                                                                                        | 视是否新增独立 grace/延长上限设置项而定；最小方案可直接复用现有 `budget.abortGraceMs`。                                                                                                                                                                                                                                                                                                             |
|                                   | `src/config/setting-specs.ts`                                                                                                   | 若新增设置项，加 `SETTING_SPECS` 条目 + description。                                                                                                                                                                                                                                                                                                                                               |
| **测试（必须同步）**              | `tests/core/core.test.ts`                                                                                                       | `INPUT_KINDS` 长度断言、`MATRIX` 表、P6 属性测试（`deadlines.deadlineAt` 不变式）。                                                                                                                                                                                                                                                                                                                 |
|                                   | `tests/service/query-service-*.test.ts`（新增）                                                                                 | `extendDeadline` 的服务层测试。                                                                                                                                                                                                                                                                                                                                                                     |
|                                   | `tests/service/deadline-cap.test.ts`                                                                                            | 与 CC4 语义交叉，需确认新特性不破坏"只收紧"的既有 cap 语义（延长是新方向，需要新测试明确区分"cap 收紧"与"运行时延长"两条路径不冲突）。                                                                                                                                                                                                                                                              |
|                                   | `tests/ui/fleet.test.ts`                                                                                                        | `remainingMs` 字段断言。                                                                                                                                                                                                                                                                                                                                                                            |
|                                   | `tests/tools/`（新增）                                                                                                          | `extend-timeout-tool.test.ts`。                                                                                                                                                                                                                                                                                                                                                                     |
|                                   | `tests/integration/notification-complement.test.ts` / `wiring.test.ts`                                                          | 宽限期通知的端到端断言。                                                                                                                                                                                                                                                                                                                                                                            |
| **文档**                          | `docs/dev/timeout-notify/`（新目录，本报告所在处）                                                                              | 后续应新增 `plan.md` 设计方案文档，遵循仓库既有 `docs/dev/<feature>/<feature>-plan.md` 命名习惯（参照 `docs/dev/compact-hint/compact-hint-plan.md`、`docs/dev/agent-label/agent-label-plan.md`）。                                                                                                                                                                                                  |
