# 独立方案评审报告 · timeout-notify（宽限 + 通知 + 延长）

评审人：reviewer（opus-5，独立于方案制定者 fable）· 结论：有条件通过
用户拍板：BL-1 选"禁止 totalMs=0"；BL-2 砍掉 RPC 项；BL-4 显式 timeout 为硬顶（倍数不适用）+ 全部 model/user-facing 时间参数统一用秒；修订后直接开工。

## Blocker（必须修复才能开工）

### BL-1 · R-11 的"顺带修复"会制造无限挂死（zero-hang 违反）★最严重

plan §3.5 / arch §4.6：`guardUntil` 在 `deadlineOf() === undefined` 时不武装 timer，V13 期望"totalMs=0 的 run 推进 1h 仍 running"。
读码事实：`state-machine.ts:226,234` clearAndArm 武装任何 timer 都带 `&& budget.totalMs !== 0` → totalMs=0 时离开 queue_wait 后 armedTimers 恒空，idle/tool/modelTurn/first_event/compaction 全不武装；watchdog tick 只遍历 armedTimers → 完全不巡检。今天 totalMs=0 唯一刹车就是被当作 bug 的 fail-fast 假超时。修好它 = 永久挂死路径。
用户拍板：**禁止 totalMs=0**（settings/budgetOverride 层禁止 0，uncapped 分支退化为死代码），V13 期望文案重写。

### BL-2 · S9 断言为假，RPC 工作项与用例不可实现

`rpc/protocol.ts:25-44` budgetOverride 是逐键白名单 + additionalProperties:false；server.ts:82 先整包校验 → 远端根本发不进这三个键。威胁不存在；只加 DEFAULT_CAPS 是死代码；计划的 rpc 用例必然失败。
用户拍板：**砍掉 RPC 这一项与用例**。

### BL-3 · 通知总量上界差一

进宽限不消耗额度 → N=3 最坏序列 graces=N+1=4，总通知=2N+1=7。P12 必须写成 grace ≤ maxExtensions+1、extended ≤ maxExtensions、总数 ≤ 2·maxExtensions+1；arch §5.5 与 V4 同步改。

### BL-4 · agent-tool.ts 的 timeout_ms 描述变谎言

`src/tools/agent-tool.ts:154-158` "The run always settles within this budget." 本特性后被静默 ×factor 放宽。该文件不在任何包 owned 集合。
用户拍板：**显式 timeout 为硬顶**（hardDeadlineAt = enqueuedAt + totalMs，factor 不适用，无宽限无延长）；**时间参数统一用秒**：Agent 工具 timeout_ms → timeout_s，extend 工具参数 extend_s（秒）；agent-tool.ts 入 P0 冻结面；arch 决策表加一条 D-x。

### BL-5 · 终态快照丢 graceUntil/hardDeadlineAt

`spawn-service.ts:132-143` 终态重建 deadlines 只留 enqueuedAt/deadlineAt → V6 断言必挂。修：spawn-service 终态重建保留两字段，文件分配给 P-final。（diag.overtime 幸存，§3.9 overtimeTail 无碍。）

## 风险项（一并纳入修订）

- RK-1 · S1 因果论证错：arm_timer effect 无消费者，watchdog 用 dueAtFor 重算 → R-2 不是真实隐患；rearmTimers 仍值得做但别当承重安全修复。plan §3.4 watchdog 用例第 4 条 oracle 错：真正 oracle 是"total 必须不在 armedTimers"（在的话 tick 会点着过去时 total 走通用路径直接杀宽限中的 run），另加一条防御用例。
- RK-2 · "total_grace 与 total 原路径 effects 逐项相等"字面不成立：进 abort_grace 后 graceUntil 仍在 → 重新武装过去时 total_grace，clear_timer 前缀 id 也不同。断言改"除总类 timer id 外逐项相等"，或进 abort_grace 时显式清 graceUntil（与 BL-5 审计诉求冲突，需取舍）。另：既有事实——总超时场景 abortGraceMs 实际只有约 1 个 tick，不是 10s，文档别写成实测值。
- RK-3 · deadline_extended × queue_wait 的 oracle 很可能写错（rearmTimers 用 phaseEnteredAt 重算 vs enqueued 手工按 input.at 武装）。建议：extendability 对 queue_wait/resolve_config/session_create/extension_bind 返回新 reason（如 not_started），oracle 从 12 格降到 5 格，也避免排队 run 白烧额度。
- RK-4 · 补风险项：宽限+延长把 slot 持有到 H（默认 2×），并发上限下挤压队列 → 补一条验收（limit=1，一个 run 宽限中，另一个排队 run 的 queue_timeout 行为）。
- RK-5 · wait() 默认改 hardDeadlineAt 副作用面大（所有裸 wait 窗口翻倍）；stack.ts:972 defaultWaitMs = totalMs + abortGraceMs + 30s 未同步。建议：hardDeadlineAt 只在 overtime 存在时作基准，否则仍用 deadlineAt，统一口径并说明。
- RK-6 · TERMINAL_STATUSES 第三份拷贝必漂移 → 收敛到 core/types.ts 或新建 core/status.ts。
- RK-7 · source:"rpc" 是死枚举（RPC deps.query 无 extendTimeout）；Q1 已砍 "user" → v1 ExtendSource 只留 "tool"，需要时再扩。
- RK-8 · extend.enabled=false 关断不彻底：frontmatter budgetOverride.maxExtensions 会盖回全局 0 → 宽限生效、通知发出、工具没注册 → 模型收到"调用不存在的工具"。修：合并后再钳一次，或工具未注册时通知降级为纯展示；V11 补此组合。
- RK-9 · notify:"always" 缺 ack-hold 保护（现有 outbox 有 isAckHoldable + ackHold coalescer，stack.ts:799-812）。§7 明确 always 仅调试用途，或复用 hold。
- RK-10 · Pkg B 的 it.skip 解耦不必要：adapter 的 notify_deadline handler 可直接构造 EffectEnvelope 喂 BasicEffectInterpreter，不需要 reducer。删掉跨包 skip，B 独立全绿。
- RK-11 · 三个无 owner 测试文件补进文件域：tests/service/deadline-cap.test.ts、tests/delivery/notifier.test.ts（arch §9.5 "宽限通知不抢 key"回归，plan §3.11 弄丢了）、tests/config/agent-config.test.ts。
- RK-12 · 验收矩阵缺口：(a) workflow 子 run：workflow/budget.ts 给 agent() 带绝对 deadlineAt cap，orchestrator 的 hostCallMs 独立超时，"子 run 宽限中、编排器已放弃"组合无用例；(b) /reload：补"宽限中的 run 跨越 stack 重建"；(c) total_grace 与 stop_requested 并存先到先杀（arch §3.6 有，V 表无对应项）。
- RK-13 · §0 行号失准（S3: 实际 runner.ts:456-457；S4: 实际 :221,354）→ 统一重采或改符号引用。

## 评审通过的项（不要推翻）

- zero-hang 上界 I-A/I-B/I-C 成立；hardDeadlineAt 唯一写入点在 enqueued；graceWindow 的 until > at 保证 t=H 时落原杀路径；reaper 未削弱。
- 无限续命封堵（次数+天花板双闸 enqueue 冻结；reducer 纵深防御）。
- graceUntil × abort_grace 无死循环（收敛，见 RK-2 推演）。
- clearAndArm→rearmTimers 对 156 格逐位等价（已逐行比对验证）。
- D-9 同步链无 TOCTOU。
- §3.5 fireDeadline"dispatch 后回读 state 再决定 cancel"断言属实且关键；建议加一条 P-level 属性：宽限进入后 activeCancels 未被触发。
- D-4 不进 outbox / P10 不破坏；CC2 子 run 抑制位置正确；caller-ack 三层规则通过（附 RK-8/RK-9）。
- 包切分两两无交集（补齐遗漏文件后）；8 commit 切分合理。

## 抽查验证记录（行号以评审时为准）

- S1 文本真、因果假（RK-1）；S3 真但修复路径错（BL-1）；S5 真；S7 真；S8 真（RK-5）；S16 真但解法坏（RK-6）；S9 假（BL-2）；§3.5 fireDeadline 真且关键；§5.6 终态留 graceUntil 假（BL-5）；§5.5 上界 ≤2N 假（BL-3）；S6/S10/S11/S12/S13/S14 均真。
