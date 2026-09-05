# Agent Tree Context Linger 方案评审

评审范围：`docs/dev/agent-tree-context-linger/plan.md`、当前 `src/`/`tests/`、以及已安装的 `@earendil-works/pi-coding-agent@0.84.4`。本次只评审，不修改实现代码。

## 总体结论

**需修订后实施。** 方案的大方向可行：以 notification 的 `message_start` 作为主信号，复用 notifier 的 `onDelivery`，在视图层扩大 pending 终态候选集，能够解决正常通知路径在主 agent 长 turn 中过早消失的问题。单条、coalescer digest 和 ackHold 的 details 形态也已基本核实。

当前不能直接实施，因为存在一个直接违背已确认需求的 blocker，以及多个会造成错误提前淡出、状态误判、内存增长或预览错配的 major 问题。

## Blocker

### B1. `consumed` 不能等价于“通知已进入主上下文”

**依据：** 方案在 `plan.md:64-68,89-93,123` 将 `consumed` 当作 `entered`，并在 `plan.md:187-190,238-239` 将 ackHold 场景称为正确。但 `src/tools/result-tool.ts:65-73` 的 `tryAck()` 在 tool result 返回 pi 之前调用 `notifier.ack()`；非等待路径也先 ack 再 return tool result。

因此在 `ackWindowMs > 0` 且 `get_subagent_result` 收取结果的场景，ack 会取消/抑制通知，通知实际上没有进入主会话；tracker 却收到 `consumed` 并开始 5 秒 linger。这违反用户已确认的“与 get_subagent_result 是否收取无关”和“直到完成通知真正进入主会话模型上下文”。

**建议：** `consumed` 只能记录 caller 收取或取消未发送 outbox，不能设置 `enteredAt`。`entered` 必须只由真实 notification `message_start` 产生。若要接受 ackHold 后提前移除，必须先重新确认产品语义。

## Major

### M1. 正常事件链成立，但 abort/失败边角没有进入状态机

**依据：** pi 0.84.4 的 steer 路径是 `agent-session.js:1112-1118`，非 streaming trigger 是 `:1120-1122`；事件经 `:383-386` 转发，`message_start` 在 `:494-500` 交给 extension runner。因此正常 steer drain 和 prompt 确实会触发扩展 `message_start`。相反 `_appendCustomMessage` 在 `agent-session.js:1134-1138` 只调用内部 `_emit`。

steer 排队后被 abort/清空，或 `_runAgentPrompt` 抛错时，可能已经在 `src/delivery/notifier.ts:197-203` 标 delivered，却永远没有扩展 `message_start`。`plan.md:215-223` 只依赖 10 分钟兜底，没有定义明确归宿，也没有测试。

**建议：** 明确 send 返回、队列入列、队列清除、prompt 抛错、session shutdown 的 receipt 转移；补成功 drain、abort 后不 drain、prompt throw 的真实 pi session 测试。

### M2. `prune(当前 query.list().runId)` 不能防 tracker 增长

**依据：** `plan.md:111-114` 用 query list 做保留集合，同时 `plan.md:47-48` 说明终态 run 不会 prune。真实 registry 在 `src/service/run-registry.ts:40-45` 合并全部 store 快照；`MemoryRunStore.list()` 在 `src/core/store.ts:40-51` 返回全部快照。因此终态 run 一直在 keep 集合，tracker Map 会随历史终态增长。

**建议：** 保留条件绑定 pending/undeliverable/linger deadline，而不是所有 query snapshot；超过最大 receipt deadline 后删除。增加 tracker size 测试。

### M3. seeding 整棵 entry 树会误判非当前分支

**依据：** pi `session-manager.js:982-983` 的 `getEntries()` 返回整个 append-only entry 集合，当前 context 则由 `:960-968` 从当前 leaf 构建。方案 `plan.md:103-106` 使用全部 entries，并在 `plan.md:228-231` 承认旧分支会被标 entered。这不满足“真正进入当前主会话模型上下文”：旧分支通知可能不在当前 context，却会使 pending run 提前淡出。

**建议：** 使用当前分支 context entries 或可验证的当前分支 entry id 集合；若 API 不可用，采用有限降级，不把整棵树当当前 context。补 fork 后旧分支通知测试。

### M4. awaiting 预览的数据归属不能放在 controller 私自查 outcome

新增需求要求 awaiting 行下展示自己的 notification 摘要。当前方案在 `plan.md:140-142` 明确不让 FleetRow 携带 delivery 概念；但 `src/ui/fleet-panel.ts:333-366` 的 `toRow()` 是把 snapshot 转成行的唯一稳定投影层，`src/ui/fleet-widget.ts:491` 后的 controller 只负责同步渲染和异步 bash tail。让 controller 再根据 query snapshot 查 outcome，会把投影逻辑、payload 优先级和时间截断逻辑塞进 controller，且无法可靠还原 coalesced notification 的 `textPreview`。

**判断：** 建议打破“FleetRow 不加字段”的约束，增加可选的终态展示字段，例如 `terminalPreview?: string`，或更干净地增加 `terminalDetail?: { preview?: string; reason?: string }`。该字段不是 delivery 状态，只是 UI 需要的稳定呈现数据；由 `buildFleetViewModel` 接受 `terminalPreviewOf?(snapshot)`/`previewOf?(runId)` 适配器生成。不要让 controller 自己读取 store：controller 目前只有 QueryService，不应新增对 MemoryRunStore 或 notifier 的隐式依赖。

数据优先级应为：`DeliveryPayload.textPreview`；失败时 `failReason`；若 outbox payload 不在内存，则 snapshot outcome 的 text/error/timeoutReason；最后无预览。`src/delivery/format.ts` 已将 notification 单条预览截断到 200 字符，建议 tracker/receipt 保存该 presentation preview，而不是在 widget 再从完整 outcome 二次猜测。

### M5. 预览加入后预算顺序会放大 1Hz 抖动

建议的优先级“活跃主行 > 活跃活动行 > awaiting 主行 > awaiting 预览行 > lingering 行”是合理的，但必须按“主行先分配、活动/预览再分配”的两阶段算法实现。否则一个 pending run 从无 preview 变有 preview，或 preview 因宽度/截断变化，会把后面的 awaiting/lingering 行逐帧挤出。

**建议：** 先保证所有可见 active 主行，再分配 active activity；然后按 updatedAt 稳定排序分配 awaiting 主行，只有主行全部分配后才分配预览；最后 lingering。awaiting 主行和预览应成对绑定，不能出现只显示 preview 不显示主行。header 统计 awaiting 总数及被预算隐藏的主行/预览数，且排序 tie-breaker 使用 runId，避免相同时间戳抖动。

### M6. digest 不应让每个 run 复制造成通知级预览错觉

`src/stack.ts:498-520` 单条 details 是 payload，`:523-533` digest 是 `{ kind: "digest", items }`；ackHold 在 `:548-555` 逐条发送。每个 awaiting run 各自显示自己的 `textPreview` 是合理的，因为 tree 的对象是 run，不是消息；但必须明确这只是 per-run outcome preview，不代表每个 run 都有独立 message。

**风险：** digest 发送后一个 message_start 会同时 receipt 多个 run；每个 run 的预览应从对应 item 读取，而不能使用 digest 的首项（兼容字段 `details.runId/textPreview` 是首项基底）。若某 item 缺 preview，应回退该 run 的 outcome，而不是显示首项摘要。补 digest items 顺序、缺项、部分 retry 后单条重投测试。

### M7. `retainTerminal` 的 cap、排序和去重规则缺失

当前 `buildFleetViewModel` 在 `src/ui/fleet-panel.ts:371-383` 先按 updatedAt 再截取 cap。方案 `plan.md:132-135,159-160` 要求 cap 外追加 pending，却没有规定合并顺序；预览进一步增加每个 run 可能占两行。若先 cap 后追加，pending 可能被 newer lingering 遮蔽。

**建议：** 终态统一排序，先保留所有满足 pending deadline 的项，再从剩余项填普通 cap，最后去重；widget 使用同一 now。补“超过 cap 的 pending + newer lingering + preview”测试。

### M8. fakePi 无法覆盖核心 `message_start` 接线

现有 fakePi 的 `on` 是空实现、`sendMessage` no-op，见 `tests/integration/fleet-widget-lifecycle.test.ts:22-32`。方案把 index 接线列为间接覆盖（`plan.md:204-211`），这不能证明 handler 注册、过滤、single/digest 转发，也不能证明真实事件链。

**建议：** 增加可捕获 handler 的 fakePi，并用真实 AgentSession 或最小 pi harness 覆盖 steer drain、prompt、abort、throw；至少在 peer 下限 0.84.0 做一次冒烟。

## Minor

### m1. 多行摘要、失败原因和 200 字符边界需要显式 UI 契约

`textPreview`/`failReason` 可能包含换行、空白和错误前缀。建议先按行折叠空白为单行，再按终端 `visibleWidth` 截断（不是 JS 字符数），追加单一省略号；200 字符是 payload 的语义上限，不应再直接把原始多行文本插入 widget。失败优先展示 `failReason`，成功展示 `textPreview`；不要把完整 outcome JSON 或多段错误堆进 tree。

### m2. 时间戳异常未定义

方案混用 `Date.now()` 和 `Date.parse`（`plan.md:101,105`），未处理 NaN、未来 timestamp 或 clock 差异。建议 finite 校验、clamp，并统一注入 Clock。

### m3. `fleetAwaitNotificationS=0` 与“永不卡死”冲突

`plan.md:172-173` 建议 0 表示永久等待，但目标 `plan.md:4-5` 明确不能永久挂树。建议禁止 0，或保留不可关闭的系统 hard cap。

### m4. generation 参数没有实际语义

方案传 generation（`plan.md:80,107-109`），内部却按 runId 聚合（`plan.md:87-93`）。建议删除无效参数，或按 delivery key/generation 记录并定义旧 generation 的迟到事件规则。

## Nit

### n1. 方案基线行号已漂移

`plan.md:23-24` 标的 sendFormatted 位置与当前 `src/stack.ts:491-533` 不完全一致。实施前应重新生成基线。

### n2. entry 持久化不等于实时 receipt

pi 在 `agent-session.js:388-393` 的 `message_end` 才 append custom message entry，而 `message_start` 更早发生。seeding 是 reload 后近似恢复，不是实时 receipt 等价物。

## 逐项判断

1. **信号可靠性：部分通过。** 正常 steer/prompt 到 extension；`_appendCustomMessage` 不到。abort/throw/queue clear 未完备。
2. **details 解析：通过但需契约测试。** 单条 `src/stack.ts:498-520`、digest `:523-533`、ackHold `:548-555` 逐条发送，形态覆盖；digest preview 必须按 item。
3. **状态机：不通过。** foreground、background、coalescer、ackHold、resume 已识别，但 consumed 违反需求，失败边角未建模。
4. **预算交互：需修订。** 新预览必须低于 active/awaiting 主行，高于 lingering；两阶段分配和稳定排序是必要条件。
5. **seeding/reload：不通过。** entry 形状已核实（`session-manager.js:868-880`），但必须按当前分支；prune 也不能解决历史终态积累。
6. **测试计划：不足。** fakePi 无法模拟 message_start，且缺预览/digest/预算抖动测试。
7. **替代方案：见下。** 保留 tracker + onDelivery，删除 consumed→entered，增加 UI preview 投影和当前分支 seeding。

## 更简单的替代方案

1. 保留 message_start handler、details parser、delivery onDelivery 和有限 hard cap。
2. `entered` 只由真实 notification message_start 产生；consumed 不影响 widget receipt。
3. 在 `FleetRow` 增加可选 `terminalPreview`/`terminalDetail`，由 view-model 投影层注入；controller 不自行查 store。
4. 对 digest 按 item 保存 per-run preview，缺失时回退该 run outcome，绝不使用首项兼容字段替代其他 run。
5. tracker 只保存 delivery 已观察到或当前 linger 候选，超 hard deadline 删除。
6. reload 使用当前分支 context entries；预算固定为 active 主行、active activity、awaiting 主行、awaiting preview、lingering，并测试每种边界。
