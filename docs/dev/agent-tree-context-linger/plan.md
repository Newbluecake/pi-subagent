# Agent tree 终态 run 驻留至通知进入模型上下文 — 实施方案（v2，评审修订版）

> v2 修订说明：本版合并了 `review.md`（gpt-sol 评审）的全部结论，并纳入用户追加需求——
> **待处理行展示的内容是"派单时发送给 subagent 的任务 prompt"，不是结果摘要**。
> 与评审意见的唯一一处 adjudication 见 §2「consumed 语义」。

## 0. 核实基线（全部已复核，附出处）

### pi 侧（node_modules/@earendil-works/pi-coding-agent@0.84.4）

- `sendCustomMessage`（dist/core/agent-session.js:1099）四条路径：
  1. 流式中 + triggerTurn≠false → `agent.steer(appMessage)`（:1117）排队；
  2. 非流式 + triggerTurn → `_runAgentPrompt(appMessage)`（:1121）→ `agent.prompt()`；
  3. 流式中 + triggerTurn===false → `_pendingCustomMessages`，turn_end 时 flush；
  4. 非流式无 trigger → `_appendCustomMessage`（:1131）。
- **关键差异**：`_appendCustomMessage`（:1134-1139）里的 `this._emit({type:"message_start"...})`
  只通知 `subscribe()` 监听器（`_emit` 实现 :313 只遍历 `_eventListeners`），**不会**转发给
  `_extensionRunner`——即 `pi.on("message_start")` 在路径 3/4 下收不到。
  但路径 1/2 走 agent loop：steering 队列被 drain 时 agent-core 对每个 pending message
  `emit({type:"message_start"})`，经 `_handleAgentEvent`（agent-session.js:386 "Emit to extensions
  first"）→ `_emitExtensionEvent`（:494）→ **`pi.on("message_start")` 触发**。
  `sendFormatted`（src/stack.ts ~:506/:519）两条发送都用 `{ triggerTurn: true }`，
  因此**本扩展的通知永远走路径 1/2，`pi.on("message_start")` 语义可靠**。
- message 对象带 `customType` 与 `details` 原样传递。
- **无历史重放**：compaction（:1533 `buildSessionContext()` 后整体替换 state.messages，无事件）、
  会话恢复、分支切换都不重新 emit message_start。
- **seeding 数据源（v2 修正，评审 Major #4）**：必须用**当前分支**而非整棵 entry 树。
  `ReadonlySessionManager`（session-manager.d.ts:140）同时暴露 `getEntries()`（整棵树）与
  `getBranch(fromId?)`（:261，当前分支）——seeding 改用 `ctx.sessionManager.getBranch()`，
  筛 `type === "custom_message"` 的 entry。fork 旧分支上的通知不再误标 entered。

### 扩展侧

- `sendFormatted`（src/stack.ts）：单条 `details = payload`（DeliveryPayload，含 `runId`/`generation`/`key`）；
  digest `details = { ...first, kind: "digest", items }`，items 每项含 runId。
- Notifier（src/delivery/notifier.ts）：每次状态迁移都 `notify(p, state)` → `onDelivery` 扇出。
  **dropped/abandoned/consumed 全部可经 H4 onDelivery 观测**，无需新增 hook。
- `buildFleetViewModel`（src/ui/fleet-panel.ts:370-389）：终态行按 updatedAt 倒序取
  `recentTerminal`（controller 硬编码 3）条；FleetRow 有 `terminal`/`settledAgoMs`。
- `buildFleetWidgetLines`（src/ui/fleet-widget.ts:~280）：终态行在活跃行之后、共享 maxRows
  预算（默认 6，硬顶 8），`settledAgoMs <= lingerMs(5000)` 才渲染。controller 当前不传
  terminalLingerMs，5000 是 builder 默认值，settings 里无此项。
- 终态 run 在 MemoryRunStore / live registry 中**不会被 prune**，awaiting 堆积是真实场景。
- resume 产生**新 runId**，旧 run 保持终态；tracker 按 runId 键控。
- 前台 Agent 调用（未转后台）**从不产生通知**——tracker 必须区分"无 delivery 记录"与
  "有记录但未入上下文"，否则所有前台 run 永久挂树。
- `pi.on(...)` 必须在 activate() 注册一次，不能在 buildSessionStack 里注册（重建会累积重复 handler）。
- **prompt 不持久化（v2 新增）**：`SpawnRequest.prompt` 只在 spawn 链路存在
  （runner.ts:29 ResolvedSpawnRequest.prompt），落盘的 RunDiagnostics 只有 displayMeta
  （label/type/model，runner.ts:42 M-A 注释处）。终态后 prompt 不可查 → 需新增持久化字段（§4）。

## 1. 背景与目标（用户已确认的语义）

现状：终态 run 只保留 `settledAgoMs <= 5000` 的暗色行。完成通知从 sendMessage 返回
（delivered）到真正进上下文（steer 排队被 drain / 新 turn 开始）可能相隔很久。

目标语义：

- **移除时机 = 通知消息进入 `agent.state.messages`**（= `pi.on("message_start")` 且
  customType === "subagent:notification" 的时刻），不是 delivered。
- **与 get_subagent_result 是否收取无关**——收取不是移除的必要条件；通知路径自足。
  （consumed 作为充分信号之一的 adjudication 见 §2。）
- 进入后按 terminalLingerMs 短暂驻留再淡出。
- 通知 dropped/abandoned/发不出去 → 回退旧 5s 行为 + 硬性超时兜底，永不卡死。
- **待处理行展示派单 prompt**（首行预览，预算富余时弹性展开多行），完整 prompt 经
  `/agent status <runId>` 查看。

## 2. 设计：ContextReceiptTracker

新文件 `src/delivery/context-receipt.ts`（纯领域，无 pi import，与 notifier 同层）：

```ts
export type ContextReceiptKind = "untracked" | "pending" | "entered" | "undeliverable";
export interface ContextReceipt {
  kind: ContextReceiptKind;
  at?: Millis;
}
export interface ContextReceiptTracker {
  noteDelivery(runId: RunId, generation: Generation, state: DeliveryState, at: Millis): void;
  noteEntered(runIds: readonly RunId[], at: Millis): void;
  receiptOf(runId: RunId): ContextReceipt;
  prune(keepRunIds: ReadonlySet<RunId>, now: Millis, opts: { lingerMs: Millis; awaitMs: Millis }): void;
}
```

- 内部 `Map<RunId, { seenAt: Millis; enteredAt?: Millis; undeliverable?: boolean }>`，按 runId 键控。
- **consumed 语义（对评审 Blocker 的 adjudication）**：评审指出 `notifier.ack()` 在 tool result
  返回前调用，标 entered 略早于结果真正入上下文。裁决：**保留 consumed→entered 映射**，理由：
  (a) ack 只在工具即将返回终态 outcome 时触发，工具结果**必然**在同一 turn 进入模型上下文，
  "entered" 最多提前毫秒级，而淡出还有 lingerMs（5s）裕量，语义不违；
  (b) ackHold 场景通知被整体抑制，若 consumed 不算 entered，这类 run 会在树上挂到 10min 兜底——
  结果明明已在上下文却长期显示"待处理"，反而误导；
  (c) 用户语义"与收不收取无关"指收取不是移除的**必要**条件（通知路径自足），
  并不排斥收取成为**充分**信号。
- `noteDelivery`：任何状态 → seenAt=at（first-wins）；`consumed` → 若未 entered 则 enteredAt=at；
  `dropped`/`abandoned` → undeliverable=true。entered 优先于 undeliverable。
- `noteEntered`：first-wins（同一 runId 不覆盖更早的 enteredAt）。
- `receiptOf` 优先级：entered > undeliverable > pending(seen) > untracked。
- **prune（v2 修正，评审 Major #3）**：keep 集合用 `query.list()` 不够（终态 run 永不从 store
  消失，Map 会无限增长）。改为**时间界 prune**：
  - 不在 keep 集合 → 删；
  - entered 且 `now - enteredAt > lingerMs` → 删（显示相关性已结束）；
  - 非 entered 且 `now - seenAt > awaitMs + lingerMs` → 删（过了硬兜底，渲染层也不再需要）。
    Map 规模由此有界：pending 条目最多存活 awaitMs，entered 条目最多存活 lingerMs。
- **details 解析**（同文件导出纯函数）：
  `runIdsFromNotificationDetails(details: unknown): RunId[]` —
  `details?.kind === "digest" && Array.isArray(details.items)` → items.map(i => i.runId).filter(string)；
  否则 `typeof details?.runId === "string"` → 单元素；其它形态返回 []。
  digest 必须**逐项**映射（评审：不得把 digest 首项字段当作所有 run 的状态）。
- **事件接入**：
  - `src/index.ts` activate() 内注册一次 `pi.on("message_start", ...)`：过滤
    `message.role === "custom" && message.customType === "subagent:notification"`，转发
    `holder.current?.contextReceipt.noteEntered(runIdsFromNotificationDetails(message.details), Date.now())`。
  - `src/stack.ts`：tracker 实例化 + seeding——`ctx.sessionManager.getBranch()`（**当前分支**，
    见 §0）筛 `custom_message/subagent:notification`，`noteEntered(runIds, Date.parse(e.timestamp))`。
  - delivery 侧走现有 H4 扇出：`receiptPoints = { onDelivery: (p, state) => tracker.noteDelivery(...) }`，
    并入 `mergeExtensionPoints([...])`，不新增 hook 面。
- **未建模路径的归宿（v2 补充，评审 Major #2）**：通知已发出但消息**永远不被消费**的路径——
  steer 队列被 abort 清空、`_runAgentPrompt` 抛错、session 在 drain 前中断——receipt 停留在
  pending，由硬兜底（默认 10min）移除。这是有意的保守语义：宁多驻留，不误判已进入。

## 3. 设计：可见性状态机与渲染

终态行可见性 = f(receipt, settledAgoMs, enteredAt)：

| receipt                                       | 语义                     | 渲染                                                                                                     | 移除时机                                                          |
| --------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `pending`                                     | 通知在途/排队            | **awaiting 形态**：`✓/✗ 标签 type model status 时长 费用 · 待处理`（muted）+ 下挂 `╰ » <prompt 预览>` 行 | 硬兜底：`settledAgoMs > fleetAwaitNotificationMs`（默认 10min）   |
| `entered`                                     | 通知/结果已在上下文      | 现有暗色 `✓/✗ …` 行                                                                                      | `now - enteredAt > terminalLingerMs`（linger 从**入上下文**起算） |
| `undeliverable`                               | 通知永远发不出           | 现有暗色行                                                                                               | 旧行为：`settledAgoMs > terminalLingerMs`                         |
| `untracked`（前台同步返回，无 delivery 记录） | 结果已随工具结果入上下文 | 现有暗色行                                                                                               | 旧行为（与今天完全一致）                                          |

行数预算（评审确认的两阶段分配，顺序即裁剪优先级，从低到高裁）：

```
lingering 行 < awaiting 预览行 < awaiting 主行 < 活跃活动行 < 活跃主行
```

- 第一阶段：所有活跃主行、awaiting 主行各得 1 行（身份行优先）；
- 第二阶段：剩余预算按 活跃活动行 → awaiting 预览行 → lingering 行 分配；
- **预览行绝不脱离主行单独出现**（主行被挤掉则预览也不渲染——防 1Hz 抖动，评审要求）；
- **弹性展开（用户确认）**：预算仍有富余时，最新一条 awaiting 的预览按终端宽度折叠空白后
  自动 wrap 成最多 4 行（`min(4, leftover)`）；其余 awaiting 只给 1 行预览；
- 预算耗尽时被挤掉的 awaiting run 计入 header：`● N active Agents · $x · M 待处理 · +K more`
  （M>0 恒显示——健康信号，不是纯溢出）；
- view model 侧：`buildFleetViewModel` 新增可选 `retainTerminal?: (s: RunSnapshot) => boolean`，
  通过者不受 recentTerminal:3 上限约束追加进 terminalRows（去重、updatedAt 倒序）；
  面板不传，零行为变化；
- **FleetRow 新增可选字段（v2 变更，采纳评审建议打破"FleetRow 不加字段"）**：
  `taskPreview?: string`——由 `diag.taskPrompt` 投影（折叠换行/连续空白后的单行），
  这是 presentation 中立的投影字段，delivery 概念仍不进 fleet-panel；
- 竞态说明：run 刚 settle 到 notifier 记录到达之间差一两帧，receipt 还是 untracked → 按旧 5s
  逻辑渲染，记录到达后翻成 pending——两种形态都显示该行，视觉无跳变。

## 4. 改动清单（文件 + 函数级）

1. **`src/delivery/context-receipt.ts`（新建，约 100 行）**：ContextReceiptTracker 工厂 +
   `runIdsFromNotificationDetails` 纯函数（§2）。
2. **`src/core/types.ts`**：`RunDiagnostics` 增加 `taskPrompt?: string`（截断后的派单 prompt）。
3. **prompt 持久化（v2 新增）**：沿用 M-A displayMeta 的折叠路径——spawn 链路
   （runtime-adapter/runner 折叠 displayMeta 的同一点）把
   `taskPrompt: request.prompt.slice(0, TASK_PROMPT_CAP)` 写进 diag。
   `TASK_PROMPT_CAP = 4096`（常量化，不暴露设置）。persist_snapshot 体积影响：每次快照多 ≤4KB，
   快照写盘本就随 phase 迁移发生，量级可接受；`/agent status` 与 tree 预览都从 diag 读。
4. **`src/index.ts`**：activate() 内注册一次 `pi.on("message_start", ...)`（过滤 + 转发
   `holder.current.contextReceipt`）。
5. **`src/stack.ts`**：
   - tracker 实例化 + `getBranch()` seeding；
   - `receiptPoints` 并入 merged 扇出；
   - FleetWidgetController deps 增加 `receiptOf`、`terminalLingerMs`、`awaitNotificationMs`；
   - `Stack` 接口增加 `contextReceipt: ContextReceiptTracker`。
6. **`src/ui/fleet-panel.ts`**：`FleetViewOptions.retainTerminal?`；FleetRow 加 `taskPreview?`；
   投影时折叠空白（`replace(/\s+/g, " ").trim()`）。
7. **`src/ui/fleet-widget.ts`**：
   - `FleetWidgetRenderOptions` 加 `receiptOf?`、`awaitNotificationMs?`；
   - `buildFleetWidgetLines`：§3 三分区 + 两阶段预算 + header `· M 待处理` +
     awaiting 预览行（`╰ » <taskPreview>`，muted，truncateToWidth）+ 最新一条弹性展开 ≤4 行；
   - controller deps/renderFrame 传参 + 每帧 `prune`（经 dep 回调，controller 不直接持 tracker）。
8. **`src/commands/status.ts`**：`/agent status <runId>` 输出增加 `taskPrompt` 全文
   （存储上限 4KB 内的完整内容），无 prompt 的旧 run 静默省略。
9. **`src/config/settings.ts` + `setting-specs.ts`**：`fleetTerminalLingerMs`（默认 5000，
   顺势暴露现有硬编码）与 `fleetAwaitNotificationMs`（默认 600_000）；
   spec 键 `fleetTerminalLingerS` / `fleetAwaitNotificationS`（seconds 模式照抄现有字段）。
10. **`README.md` / `README.en.md`**：Agent tree 一节改写为三段式语义（待处理驻留 + prompt
    预览 / 入上下文后淡出 / 发不出去的兜底）；设置 JSON 示例加两个新键。

## 5. 测试计划

1. **`tests/delivery/context-receipt.test.ts`（新）**：状态迁移（untracked→pending→entered）、
   consumed→entered、dropped/abandoned→undeliverable、entered 不翻回、noteEntered first-wins、
   `runIdsFromNotificationDetails`（单条/digest 逐项/缺 runId/非对象/null）、
   **时间界 prune**（entered 超 linger 删、pending 超 await+linger 删、keep 外删）。
2. **`tests/ui/fleet-widget.test.ts`（扩）**：pending 行 `· 待处理` 后缀 + 不受旧 linger 限制；
   entered 行以 enteredAt 为基准；undeliverable/untracked 回退旧语义；兜底超时消失；
   预算两阶段分配（活跃行占满时 awaiting 让位且 header 显示 `M 待处理`；awaiting 优先 lingering）；
   **预览行**：taskPreview 折叠空白/截断、预览不脱离主行、弹性展开行数 = min(4, leftover)；
   maxRows 硬顶不被突破。
3. **`tests/ui/fleet.test.ts`（扩）**：retainTerminal 突破 recentTerminal cap；taskPreview 投影。
4. **prompt 持久化**：spawn 后 diag.taskPrompt 存在且 ≤4096 字符；长 prompt 截断；
   resume 新 run 携带新 prompt（旧 run diag 不变）。
5. **`tests/integration/context-receipt-wiring.test.ts`（新，评审 Major #5）**：
   **扩展 fakePi——`on` 记录 handler、`sendMessage` 捕获消息，并支持手动触发已注册的
   message_start handler**（现有 fakePi 全是 no-op，无法验证接线）。用例：
   buildSessionStack 暴露 `stack.contextReceipt`；getBranch seeding 生效；
   onDelivery 扇出反映到 receiptOf；模拟 pi 触发 message_start（custom/subagent:notification）
   后 receiptOf 翻 entered；controller 首帧 pending run 呈待处理形态。
6. **真实 pi 事件链冒烟**（评审建议）：实现后在 pi 0.84.0（peer 下限）手工冒烟一次——
   后台 run 完成 → 主会话忙时通知排队 → turn 结束后确认行从"待处理"转淡出。

## 6. 风险与边界

1. **pi 版本差异（核心风险）**：`pi.on("message_start")` 对 custom 消息的触发依赖
   `_emitExtensionEvent` 转发；已在 0.84.4 源码核实路径 1/2 必触发。若某小版本不转发：
   pending 行驻留到硬兜底后消失——不卡死但体验退化。缓解：兜底有限且默认开启 + seeding 恢复。
2. **`_appendCustomMessage` 路径不触达扩展事件**：本扩展通知恒走 triggerTurn，不受影响；
   不要给 sendFormatted 加 deliverAs:"nextTurn"（该路径事件行为未核实）。
3. **/reload 与 stack 重建**：tracker 会话级，reload 后由 seeding（getBranch 当前分支）恢复
   entered；pending 由 notifier.reconcile 重投。message_start 监听只在 activate 注册一次。
4. **通知发出但永不消费**（abort 清队 / _runAgentPrompt 抛错 / session 中断）：停留 pending
   至硬兜底——有意保守，见 §2。
5. **前台 run 永久挂树**：untracked 分支必须走旧 5s 逻辑（状态机最易漏的分支）。
6. **awaiting 堆积**：header `M 待处理` 计数 + maxRows 硬顶兜住，widget 高度不变。
7. **prompt 体积与隐私**：taskPrompt ≤4KB 随快照持久化到 session 文件；内容即用户自己的
   派单文本，与同文件中的会话消息同级，无新增暴露面。
8. **digest 部分消费**：runId 级 entered first-wins latch，重复 noteEntered 无害。
