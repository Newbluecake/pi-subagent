# 超时宽限与续期（timeout grace & extension）技术架构

> 状态：架构设计稿 **v2** —— 已按评审 v1 修订（`review.md`），可直接开工
> 范围：`src/core` / `src/runtime` / `src/service` / `src/tools` / `src/delivery` / `src/ui` / `src/config`
> 前置阅读：`AGENTS.md`、`docs/dev/timeout-notify/explore.md`、`docs/dev/timeout-notify/review.md`（本文所有代码引用均自行读码核对过；行号以符号引用为主，避免漂移）
> 本文只描述设计，不含实现代码改动。
>
> **v2 修订要点**（对应 review.md 的 5 个 Blocker + 13 条风险项）：
>
> - BL-1：废除 `totalMs = 0 = 不限` 语义，配置层规范化（D-11）；R-11 假超时路径消失。
> - BL-2：砍掉 RPC caps 工作项（`rpc/protocol.ts` 白名单已在入口挡住）。
> - BL-3：通知上界修正为 `graces ≤ N+1`、`extended ≤ N`、总数 `≤ 2N+1`（§5.5）。
> - BL-4：显式 `timeout` 的 run 是硬顶（D-10）；model/user-facing 时间参数统一用秒（D-12）：`timeout_ms → timeout_s`、`extend_ms → extend_s`。
> - BL-5：终态快照保留 `graceUntil` / `hardDeadlineAt`（§5.6，spawn-service 终态重建同步）。
> - RK-1~RK-13 全部纳入（决策表 D-13 ~ D-17，§3.4/§3.6/§4.4/§5.4/§9/§10 相应改写）。
> - 评审"通过项"（zero-hang 上界 I-A/I-B/I-C、无限续命双闸、D-9 同步链、fireDeadline 回读、D-4 不进 outbox、CC2 位置、包切分）**一律不动**。

---

## 1. 背景与已确认决策

### 1.1 当前行为（读码结论）

一个 run 的总超时今天由**两条相互独立的执行路径**同时把守，这是本特性最大的坑：

| 路径            | 位置                                                                                                   | 机制                                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. watchdog     | `src/runtime/watchdog.ts` `EventWatchdog.tick()`                                                       | 1Hz 扫描 `armedTimers`；`timer === "total"` 时取 `state.deadlines.deadlineAt` 作为 due，**其它 timer 用 `dueAtFor(phase, diag, budget)` 现算**（不读 `arm_timer` effect 的 `dueAt`）；到点 `dispatch(deadline_fired{timer, reason})` → `RuntimeRunner.fireDeadline()` → 状态机进 `abort_grace` + `cancel.cancel("timeout")` |
| B. runner guard | `src/runtime/runner.ts` `run()` 中 `this.guard(handle.prompt(...), promptBudget.ms, cancel, "prompt")` | `promptBudget = remainingFor(budget.totalMs, now, state.deadlines)`，**一次性** `clock.setTimer(ms)`，到点解析 `{ok:false, reason:"timeout"}` → `prompt_settled{error:timeout}` → `finish(timed_out)`                                                                                                                       |

`deadlineAt` 在 `reduce` 的 `enqueued` 分支里**算一次、永不重算**（CC4/FF2 的 B1 不变量），`RunDeadlines` 三个字段全 `readonly`。到点即杀，无宽限、无通知、无延长入口。

`src/core/state-machine.ts` 里已存在的 `abort_grace` 相位是**停机宽限**（`abortGraceMs`，默认 10s）：cancel 已发出、run 正在拆机、只等它体面退出。**与本特性引入的"续跑宽限"是完全不同的东西**，命名上必须彻底区分（见 §3.1）。

**既有事实（评审 RK-2 指出，写明以免误导）**：总超时场景下 `abortGraceMs` 实际只有约 **1 个 watchdog tick**，不是 10s——`total` 到点进 `abort_grace` 后 `clearAndArm` 会把 `total` 以（已成过去时的）`deadlineAt` 重新武装，下一 tick 即在 `abort_grace` 分支 `finish(timed_out) + request_abort + dispose`。本特性的 `total_grace` 到点路径与此**同构**（见 §3.6）。

**既有事实（评审 RK-1 指出）**：`arm_timer` effect 没有任何消费者（`BasicEffectInterpreter` 未注册 handler，watchdog 自行重算 due）。因此 `armedTimers` 里"有哪些 timer id"是真实的运行时语义，而 `arm_timer.dueAt` 只是审计信息。

### 1.2 本次要做的四件事（用户已拍板，不推翻）

1. **宽限期续跑**：到达总超时时不直接杀，进入可配置宽限（默认 90s，见 §7），run **继续正常运行**，同时发通知；宽限内被延长则按新 deadline 继续；宽限耗尽无人处理 → 按原逻辑 `timed_out`。
2. **通知注入主会话上下文**：复用 delivery 的"完成通知注入主会话"这条通道（`pi.sendMessage(..., { triggerTurn: true })`），把"run X 到点了、还剩 Ns 宽限、可用 `extend_subagent_timeout` 延长"送进主会话模型上下文，模型自主决策。
3. **新工具 `extend_subagent_timeout`**：typebox schema（参数 `extend_s`，秒），运行时修改 active run 的 `deadlineAt` 并重武装定时器。
4. **延长设上限**：settings 可配，保住 zero-hang 硬保证。

外加小项：fleet widget 活动 run 主行显示剩余超时（`⏳12m`）。

**v2 新增边界（用户拍板）**：**只有使用默认预算（`settings.budget.totalMs`，含 agent-type 配置层覆盖）的 run 享受宽限与延长**；显式传入 timeout 的 run（`Agent` 工具 `timeout_s`、`SubagentWorkflow` 子 run、RPC spawn、`/goal` 评估 run——凡经 `SpawnRequest.budgetOverride.totalMs` 传入者）是**硬顶**（D-10）。

### 1.3 术语约定（全文强制）

| 术语                        | 含义                                                                 | 代码符号                                                                 |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **总预算**                  | `budget.totalMs`，run 的原始总时长，**恒 > 0**（D-11）               | `DeadlineBudget.totalMs`                                                 |
| **软截止 / deadline**       | 当前生效的总截止时刻，**本特性后可向后移动**                         | `RunDeadlines.deadlineAt`                                                |
| **续跑宽限 / grace**        | 软截止到点后额外的继续运行窗口，run 仍在正常干活                     | `RunDeadlines.graceUntil`、`budget.totalGraceMs`、timer `"total_grace"`  |
| **停机宽限 / abort grace**  | 已有概念，cancel 后的拆机窗口，run 正在死                            | 相位 `abort_grace`、`budget.abortGraceMs`、timer `"abort_grace"`         |
| **硬天花板 / hard ceiling** | 绝对不可逾越的时刻，enqueue 时算一次、永久冻结                       | `RunDeadlines.hardDeadlineAt`                                            |
| **延长 / extension**        | 主会话主动把 `deadlineAt` 往后推                                     | `RunInput.deadline_extended`                                             |
| **显式预算 run**            | `SpawnRequest.budgetOverride.totalMs` 有值的 run；硬顶，无宽限无延长 | `applyBudgetPolicy(..., { explicitTotal: true })` ⇒ `maxTotalFactor = 1` |
| **默认预算 run**            | 未经 per-spawn 覆盖 `totalMs` 的 run；可宽限可延长                   | 同上 `explicitTotal: false`                                              |

### 1.4 关键决策速查（含理由）

| #                   | 决策                                                                                                                                                                                                                                                                                                                                                                                                       | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1                 | **不新增 `RunPhase`**，宽限建模为 deadline 层的正交状态（`graceUntil` + `"total_grace"` timer）                                                                                                                                                                                                                                                                                                            | 宽限期内 run 仍在 `model_turn`/`tool_exec`/…；换相位会摧毁子阶段 timer 语义（`phaseTimer()` / `dueAtFor()`），而子阶段预算恰恰是宽限期最不能削弱的防挂机制；同时避免把 12×13 转移矩阵撑成一个"能转到任何地方"的怪相位                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D-2                 | `deadlineAt` 可变，但 **B1 不变量迁移到 `hardDeadlineAt`**                                                                                                                                                                                                                                                                                                                                                 | 保住"算一次、冻结"的核心论证，只是被冻结的对象换成天花板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D-3                 | 宽限/延长参数放进 `DeadlineBudget`（`totalGraceMs` / `maxExtensions` / `maxTotalFactor`）                                                                                                                                                                                                                                                                                                                  | `reduce(state, stamped, budget)` 签名不变（避免全量测试涟漪）；自动获得 agent-type `budgetOverride` 与每次 spawn 覆盖；自动进 `/agent settings`（`BUDGET_SPECS` 由 `Object.keys(DEFAULT_BUDGET)` 生成）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D-4                 | 宽限通知**不进 outbox**，走同侧的独立通道 `subagent:timeout`                                                                                                                                                                                                                                                                                                                                               | outbox 主键是 `deliveryKey(runId, generation)`，一个 run 一条终态记录；宽限通知占用同一 key 会让后续终态 `enqueue()` 被静默丢弃（`notifier.enqueue` 见到已存在且非 dropped 的记录直接 return）——这是灾难性 bug。而且 reconcile/重投语义对一条只活 90s 的紧急通知是错的（重启后重播"你还有 90s"是撒谎）                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D-5                 | 延长参数**只用增量 `extend_s`**，不提供 `new_total_s`                                                                                                                                                                                                                                                                                                                                                      | 两个互斥可选参数是已知的模型混淆源；"再给它 10 分钟"是模型的自然表达；绝对值场景 = 自己算差值。备选方案见 §4.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D-6                 | **只有还剩延长额度时才进宽限**                                                                                                                                                                                                                                                                                                                                                                             | 没额度时通知不可行动，等于纯噪声；同时把宽限次数上界钉死（§5.5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D-7                 | 宽限窗口本身也被 `hardDeadlineAt` 夹住（`graceUntil = min(at + G, H)`）                                                                                                                                                                                                                                                                                                                                    | 让 zero-hang 上界保持与今天完全同构：`H + abortGraceMs + reapMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D-8                 | 子 run（`parentRunId` 存在）**不向顶层上下文发宽限通知**                                                                                                                                                                                                                                                                                                                                                   | 与既有 CC2 规则一致（`runtime-adapter.ts` 的 `childRunIds` 守卫）；子 run 归其 owner（父 agent / workflow orchestrator）所有                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D-9                 | `Runner.extendDeadline` / `QueryService.extendTimeout` **同步**                                                                                                                                                                                                                                                                                                                                            | 检查与派发之间没有 `await`，watchdog 与延长的竞态在单线程事件循环上被结构性消除（§4.6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **D-10** (v2, BL-4) | **显式 timeout 的 run 是硬顶**：`SpawnRequest.budgetOverride.totalMs` 有值 ⇒ 生效预算 `maxTotalFactor = 1` ⇒ `hardDeadlineAt = enqueuedAt + totalMs`（再与 `SpawnRequest.deadlineAt` 取 min）⇒ `extendability` 恒为 `no_headroom` ⇒ 不进宽限、不可延长。**仅默认预算 run 享受宽限 + 延长**                                                                                                                 | ① `Agent` 工具 `timeout_s` 的描述 "The run always settles within this budget" 必须保持为真（否则模型/用户的心智模型被静默打破）；② workflow 子 run、RPC run、`/goal` 评估 run 都有各自的外层等待者与预算（`hostCallMs`、RPC caps、`evalTimeoutMs`），它们**不希望**被内层自作主张放宽——评审 RK-12(a)"子 run 宽限中、编排器已放弃"的组合由此**结构性消失**；③ 实现极简：无需新字段，只是 `maxTotalFactor` 钳 1，reducer 与工具层的 `no_headroom` 路径原样复用。**边界判定**：以 `SpawnRequest.budgetOverride.totalMs !== undefined` 为准；agent-type `AgentTypeConfig.budgetOverride` 属配置层（与 settings 同级，类型作者可自行设 `maxTotalFactor: 1`），**不**算显式（今天 frontmatter 解析器尚未读取 budget 键，此边界暂无实际差别） |
| **D-11** (v2, BL-1) | **禁止 `totalMs = 0`**："0 = 不限"语义废除。`mergeBudget()`（唯一合并入口）对每一层覆盖的 `totalMs` 做校验：非有限数或 `≤ 0` ⇒ **视为非法、丢弃该层的 `totalMs`，回退到下一层（最终 `DEFAULT_BUDGET.totalMs` = 1800s）**；`loadSettingsFromFile` 见到文件里 `budget.totalS ≤ 0` 时 WARN 一次；`budget.totalS` 的 spec `min: 1`（编辑器拒收 0）；RPC `clampBudget` 既有的 `Math.max(1, …)` 保留（注释改写） | 读码事实：`clearAndArm` 在 `totalMs === 0` 时**不武装任何 timer**（含 idle/tool/modelTurn），watchdog 只遍历 `armedTimers` ⇒ 今天 `totalMs=0` 的唯一刹车就是被当作 bug 的 prompt 假超时（R-11）。修掉假超时 = 制造永久挂死。**选"回退默认值"而非"钳到最小值"**：用户写 0 的意图是"不限"，钳成 1s 会让 run 秒死、比回退到 30min 默认更违背意图；回退默认 = 与"键缺席"行为一致，最不意外。禁止后：R-11 假超时路径消失；`hardDeadlineAtFor` / `guardUntil` / `extendability` 的 `undefined`/`uncapped` 分支退化为**防御性代码**（保留，注明）                                                                                                                                                                                             |
| **D-12** (v2, BL-4) | **时间单位分层**：model/user-facing 参数一律**秒**（`Agent.timeout_s`、`SubagentWorkflow.timeout_s`、`extend_subagent_timeout.extend_s`、settings `*S` 键）；`src/core` / `src/runtime` 内部一律**毫秒**（`Millis` 类型不变）；**RPC 线协议字段保持毫秒不动**（`budgetOverride.*Ms`）                                                                                                                      | 秒是模型与人类的自然单位（settings 文件早已如此）；内部毫秒与 `Clock` / `FakeClock` / 全部既有测试一致；RPC 是跨进程稳定协议，改单位 = 破坏所有外部集成，且它不是 model-facing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **D-13** (v2, RK-7) | `ExtendSource` v1 **只有 `"tool"`**；`"user"` / `"rpc"` 枚举与对应文案分支砍掉                                                                                                                                                                                                                                                                                                                             | `/agent extend` 命令 v1 不做（Q1）；RPC 的 `deps.query` 只有 `get`/`stop`，没有 `extendTimeout`——两者都是死枚举。需要时再加，一行联合类型扩展                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **D-14** (v2, RK-3) | `extendability` 对 `queue_wait` / `resolve_config` / `session_create` / `extension_bind` 返回新 reason **`not_started`**（不可延长）；宽限与延长共用同一相位集合 `OVERTIME_PHASES = [prompt_dispatch, model_turn, tool_exec, retry_backoff, compaction]`                                                                                                                                                   | 排队/启动中的 run 延长 = 白烧额度（还没开始干活）；`deadline_extended × queue_wait` 的 oracle（`rearmTimers` 用 `phaseEnteredAt` 重算 vs `enqueued` 手工按 `input.at` 武装 queue）极易写错；矩阵新列的非平凡 oracle 从 12 格降到 5 格                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D-15** (v2, RK-6) | 终态判定收敛到 **`src/core/status.ts`**：`TERMINAL_STATUSES` + `isTerminalStatus()`（类型守卫）；`state-machine.ts` 的 `terminal()`、`runner.ts` 的 `TERMINAL_STATUSES`、`deadline.ts`（新消费者）三处统一                                                                                                                                                                                                 | 第三份拷贝必漂移。其余散落拷贝（`stack.ts`/`index.ts`/`status.ts`/`mention.ts`/`delivery-key.ts`/`fleet-panel.ts`）不在本特性范围，留后续 chore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **D-16** (v2, RK-8) | `extend.enabled === false` 的关断在 **spawn-service 合并之后**钳 `maxExtensions = 0`（`applyBudgetPolicy(..., { extensionsEnabled: false })`），而不是在 `stack.ts` 改 `settings.budget` 副本                                                                                                                                                                                                              | 后者会被 `config.budgetOverride` / `req.budgetOverride` 的 `maxExtensions` 盖回去 ⇒ 宽限生效、通知发出、但工具没注册 ⇒ 模型收到"调用不存在的工具"。合并后钳位是唯一无泄漏的位置；与 D-10 同一函数、同一调用点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **D-17** (v2, RK-9) | `extend.notify: "always"` **仅调试用途**（描述与文档写明）；**不**复用 outbox 的 `ackHold` coalescer                                                                                                                                                                                                                                                                                                       | `ackHold` 以 `DeliveryPayload`/outbox key 为单位，宽限通知不是 `DeliveryPayload`（D-4）；把它塞进 ackHold = 把 outbox 生命周期重新引入本通道。`background` 默认值已覆盖"前台阻塞不发"的需求；`always` 只用于验证通知链路本身                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 2. 总体设计

### 2.1 一图：一个 run 的时间轴（默认预算 run）

```
E=enqueuedAt                D0 = E + totalMs                                    H = hardDeadlineAt
|                            |                                                   |
|<--------- 正常运行 -------->|<-- grace#1 -->|<---- 延长后继续 ---->|<-grace#2->|…|<abortGrace><reap>
|                            |    G=90s      |                     |           |
|                            |               ^                     ^           ^
|                            |          extend_s 到达          再次到点      额度耗尽/触顶
|                            ^                                                  ^
|                    deadline_fired{total}                          deadline_fired{total_grace}
|                    → 不杀，置 graceUntil                          → 走原逻辑：abort_grace + cancel
|                    → notify_deadline{grace}                       → timed_out
|
|  全程并行生效（宽限期内不削弱）：idle / tool / modelTurn / compaction 子阶段 timer
|                                                                   绝对上界 = H + abortGraceMs + reapMs
```

**显式预算 run（D-10）**：`H = D0`，时间轴退化为今天的形状——`deadline_fired{total}` 在 D0 直接走原杀路径，无 grace、无通知。

### 2.2 一表：三层 deadline 的职责

| 层                                                                      | 触发物                                  | 到点后果                                                 | 本特性是否改动                                           |
| ----------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| 子阶段（idle/tool/modelTurn/compaction/first_event/bind/startup/queue） | `dueAtFor(phase, diag, budget)`         | 进 `abort_grace` → 杀                                    | **否**（宽限期内照常生效，这是"宽限不掩盖真挂死"的关键） |
| 软截止 `total`                                                          | `deadlines.deadlineAt`                  | 若可宽限 → 进 grace + 通知；否则 → 进 `abort_grace` → 杀 | **是**                                                   |
| 宽限截止 `total_grace`                                                  | `deadlines.graceUntil`                  | 恒定 → 进 `abort_grace` → 杀（`timeoutReason: "total"`） | **新增**                                                 |
| 硬天花板 `hardDeadlineAt`                                               | 不是 timer，是所有上面两者的 `min` 夹子 | 数学上保证 total/total_grace 必在其前触发                | **新增**                                                 |

### 2.3 数据流

```
spawn-service.spawn
   └─ budget = applyBudgetPolicy(mergeBudget(deps.budget, config.budgetOverride, req.budgetOverride),
                                 { explicitTotal: req.budgetOverride?.totalMs !== undefined,   ← D-10
                                   extensionsEnabled: deps.extensionsEnabled ?? true })        ← D-16
      （mergeBudget 内部已把 totalMs ≤ 0 的层丢弃 —— D-11）

watchdog.tick (1Hz, 复用现有 timer，不新增任何 interval)
   └─ due(total)      = deadlines.deadlineAt
   └─ due(total_grace)= deadlines.graceUntil          ← 新增分支
   └─ dispatch deadline_fired → runner.fireDeadline → reduce → 回读 state，仅 stopping/终态才 cancel

reduce (core，纯函数)
   ├─ enqueued            : 计算并冻结 hardDeadlineAt（同时镜像到 diag.hardDeadlineAt）
   ├─ deadline_fired total: 宽限中 ⇒ illegal（残留 timer 防御）；否则 graceWindow() 判定 → 进 grace 或走原路
   ├─ deadline_fired total_grace: 走原路（abort_grace + cancel + soft_steer）
   └─ deadline_extended   : extendability() → 夹紧 → 改 deadlineAt → 清 graceUntil → rearmTimers → 通知
        ↓ effects
   notify_deadline{notice}   (best_effort)
        ↓
runtime-adapter 的 BasicEffectInterpreter 新增 handler（deadlineNoticeHandler，可独立单测）
   ├─ 子 run（childRunIds）→ 丢弃（CC2）
   └─ deps.onDeadlineNotice(notice)
        ↓ stack.ts sendDeadlineNotice
   shouldDeliverDeadlineNotice(notice, { policy, expectsAck, autoBackgrounded })   ← 纯函数，delivery/deadline-notice.ts
        ↓
pi.sendMessage({ customType: "subagent:timeout", content: formatDeadlineNotice(notice, ctx), display: true, details: notice },
               { triggerTurn: notice.kind === "grace" })

extend_subagent_timeout(tool, extend_s) → resolveRun → query.extendTimeout(runId, extend_s * 1000, { source: "tool", reason })  (sync)
   → runner.extendDeadline(sync) → dispatchExternal(deadline_extended) → reduce
   → 回读 state 生成 ExtendOutcome → 工具文本
```

---

## 3. 状态机设计

### 3.1 为什么不是新相位（回答设计问题 1）

候选 A：新增 `RunPhase = "grace"`。**否决**，四条硬理由：

1. `clearAndArm()` 用 `phaseTimer(phase)` + `dueAtFor(phase, diag, budget)` 决定该相位的子阶段 timer。进 `"grace"` 相位就必须**卸掉当前的 idle/tool timer**——宽限期内一个卡死的 tool 调用将再也不会被子阶段预算杀掉，直接违反 zero-hang 的"分层 deadline"。
2. `clearAndArm()` 会把 `diag.phaseEnteredAt` 重置为当前时刻，等于给卡死的相位免费续命。
3. `"grace"` 能转出到 `model_turn`/`tool_exec`/`compaction`/`retry_backoff` 任意一个（run 还在跑），转移矩阵会退化。
4. UI/诊断层（`phaseLabel()`、`/agent status`）需要知道 run 到底在思考还是在跑工具——宽限期这个信息必须保留。

**采纳方案**：宽限是 deadline 层的正交状态。相位不变、`status` 不变（仍是 `"running"`），只动 `RunDeadlines` 与 `armedTimers`。

### 3.2 类型改动（`src/core/types.ts`）

```ts
export interface DeadlineBudget {
  // …既有 14 个字段不变…（totalMs 的注释改写：恒 > 0；mergeBudget 丢弃非法层，见 D-11）
  /** 总预算到点后的续跑宽限；0 = 关闭宽限（到点即按原逻辑终止）。 */
  totalGraceMs: Millis;
  /** 单个 run 允许的 deadline 延长次数上限；0 = 禁止延长（同时也禁用宽限，见 D-6）。 */
  maxExtensions: number;
  /** 硬天花板倍数：hardDeadlineAt = enqueuedAt + ceil(totalMs * maxTotalFactor)（≥ 1）。显式预算 run 被 applyBudgetPolicy 钳为 1（D-10）。 */
  maxTotalFactor: number;
}

export interface RunDeadlines {
  readonly enqueuedAt: Millis;
  /** 当前生效的软截止。**只可向后移动**，且只经由 deadline_extended，且 ≤ hardDeadlineAt。 */
  readonly deadlineAt: Millis | undefined;
  readonly queueDeadlineAt: Millis | undefined;
  /** 续跑宽限截止；undefined = 不在宽限中。进宽限时置位，被延长时清除；**终态时保留作审计痕迹**（BL-5）。 */
  readonly graceUntil?: Millis;
  /**
   * 绝对硬天花板：enqueue 时算一次、永久冻结（原 deadlineAt 的 B1 不变量迁移至此）。
   * = min(enqueuedAt + ceil(totalMs * maxTotalFactor), SpawnRequest.deadlineAt ?? ∞)
   * 配置层已禁止 totalMs ≤ 0（D-11），故正常路径下必有值；undefined 分支仅为防御（直接喂 reducer 的测试输入）。
   */
  readonly hardDeadlineAt?: Millis;
}

export interface RunDiagnostics {
  // …既有字段不变…
  /** hardDeadlineAt 的展示镜像（与 diag.deadlineAt 同款），enqueue 时写一次；spawn-service 终态重建从此处恢复（BL-5）。 */
  hardDeadlineAt?: Millis;
  /** 超时宽限/延长的审计记录；从未发生过时整个字段缺席。 */
  overtime?: {
    /** 进入过几次续跑宽限。 */
    graces: number;
    /** 当前（或终态时最后一次）宽限窗口；被延长救出时删除。终态快照保留它 = 审计痕迹（BL-5），spawn-service 终态重建据此恢复 deadlines.graceUntil。 */
    grace?: { startedAt: Millis; until: Millis };
    /** 已批准的延长次数。 */
    extensions: number;
    /** 累计实际批准的延长毫秒（可能小于请求量，被天花板夹过）。 */
    grantedMs: Millis;
    /** 最近一次延长的 reason 参数（展示/审计用，截断 200 字符）。 */
    lastReason?: string;
    /** 最近一次延长的来源（v1 只有 "tool"，D-13）。 */
    lastSource?: ExtendSource;
  };
}

/** v1 只有工具一个来源（D-13）；预留联合类型扩展位。 */
export type ExtendSource = "tool";

export type RunInput =
  // …既有 13 个 kind 不变…
  {
    kind: "deadline_extended";
    at: Millis;
    /** 请求追加的毫秒数（叠加在 max(at, deadlineAt) 之上）；由 reducer 负责夹紧。工具层已把 extend_s × 1000。 */
    extendMs: Millis;
    source: ExtendSource;
    reason?: string;
  };

export type RunEffect =
  // …既有 13 个 kind 不变…
  { kind: "notify_deadline"; notice: DeadlineNotice };

/** 送往宿主通知层的纯数据；core 不做任何文案格式化（I1：core 无 pi 依赖）。 */
export interface DeadlineNotice {
  kind: "grace" | "extended";
  runId: RunId;
  generation: Generation;
  at: Millis;
  phase: RunPhase;
  label?: string;
  agentType?: string;
  taskPreview?: string;
  /** 变更后的软截止。 */
  deadlineAt: Millis;
  /** kind === "grace" 时必有：本次宽限的截止时刻。 */
  graceUntil?: Millis;
  hardDeadlineAt: Millis;
  extensionsUsed: number;
  maxExtensions: number;
  /** kind === "grace" 时必有：文案里"可直接抄"的建议值 = min(totalMs, headroom)，core 一次算好（毫秒；文案层换成秒）。 */
  suggestedExtendMs?: Millis;
  /** kind === "extended" 时必有。 */
  requestedMs?: Millis;
  grantedMs?: Millis;
  source?: ExtendSource;
}

/** 与 SetModelOutcome 同置（既有先例）：给工具层生成自纠错文案。 */
export type ExtendOutcome =
  | {
      ok: true;
      runId: RunId;
      previousDeadlineAt: Millis;
      deadlineAt: Millis;
      requestedMs: Millis;
      grantedMs: Millis;
      /** grantedMs < requestedMs（被硬天花板夹过）。 */
      clamped: boolean;
      extensionsUsed: number;
      extensionsRemaining: number;
      hardDeadlineAt: Millis;
      /** 本次延长把 run 从续跑宽限中救了出来。 */
      rescuedFromGrace: boolean;
    }
  | {
      ok: false;
      reason:
        | "unknown_run"
        | "already_terminal"
        | "stopping"
        | "not_started" // v2 D-14：queue_wait / resolve_config / session_create / extension_bind
        | "uncapped" // 防御性：deadlineAt/hardDeadlineAt 缺席（配置层已禁止，见 D-11）
        | "limit_reached"
        | "no_headroom" // 含 D-10 显式预算 run（H = deadlineAt）
        | "unsupported";
      detail?: string;
    };
```

`INPUT_KINDS` 13 → 14；`RUN_PHASES` 不变（12）；`TimeoutReason` 不变（宽限耗尽复用 `"total"`）；`RunStatus` 不变。

### 3.3 纯函数（`src/core/deadline.ts` + 新 `src/core/status.ts`）

```ts
// src/core/status.ts（D-15，新文件）
export type TerminalStatus = Extract<RunStatus, "completed" | "failed" | "timed_out" | "aborted">;
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "timed_out", "aborted"]);
export function isTerminalStatus(status: RunStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.has(status);
}
```

```ts
// src/core/deadline.ts
export const DEFAULT_BUDGET: DeadlineBudget = {
  // …既有…
  totalGraceMs: 90_000,
  maxExtensions: 3,
  maxTotalFactor: 2,
};

/** 相位集合：既是"可进宽限"也是"可延长"（D-14）。 */
export const OVERTIME_PHASES: readonly RunPhase[] = [
  "prompt_dispatch",
  "model_turn",
  "tool_exec",
  "retry_backoff",
  "compaction",
];

/** 当前生效的总截止：宽限中取 graceUntil，否则取 deadlineAt。所有 timer 计算的唯一入口。 */
export function effectiveDeadlineAt(d: RunDeadlines): Millis | undefined {
  return d.graceUntil ?? d.deadlineAt;
}

/**
 * spawn-service 在 mergeBudget 之后、传给 runner 之前调用一次（D-10 / D-16）。
 * - explicitTotal：per-spawn 覆盖了 totalMs ⇒ 硬顶：maxTotalFactor = 1（H = deadlineAt ⇒ no_headroom ⇒ 无宽限无延长）
 * - extensionsEnabled = false：maxExtensions = 0（宽限与延长一并关闭，任何层的覆盖都盖不回来）
 */
export function applyBudgetPolicy(
  budget: DeadlineBudget,
  opts: { explicitTotal: boolean; extensionsEnabled: boolean },
): DeadlineBudget {
  let out = budget;
  if (opts.explicitTotal && out.maxTotalFactor !== 1) out = { ...out, maxTotalFactor: 1 };
  if (!opts.extensionsEnabled && out.maxExtensions !== 0) out = { ...out, maxExtensions: 0 };
  return out;
}

/** enqueue 时算一次。totalMs ≤ 0 只可能来自绕过 mergeBudget 的直接输入（测试）⇒ 防御性返回 undefined。 */
export function hardDeadlineAtFor(
  enqueuedAt: Millis,
  budget: DeadlineBudget,
  capAt: Millis | undefined,
): Millis | undefined {
  if (!(budget.totalMs > 0)) return undefined;
  const factor = Math.max(1, budget.maxTotalFactor);
  const raw = enqueuedAt + Math.ceil(budget.totalMs * factor);
  return capAt === undefined ? raw : Math.min(raw, capAt);
}

/**
 * 延长/宽限的唯一判定口径：reducer 用它做决策，runner/工具层用它生成拒绝理由。
 * 一份逻辑两处消费，不允许各写各的。
 */
export function extendability(
  state: RunState,
  budget: DeadlineBudget,
  now: Millis,
):
  | { ok: true; headroomMs: Millis }
  | {
      ok: false;
      reason: "already_terminal" | "stopping" | "not_started" | "uncapped" | "limit_reached" | "no_headroom";
    } {
  if (isTerminalStatus(state.status)) return { ok: false, reason: "already_terminal" };
  if (state.phase === "abort_grace" || state.phase === "reap") return { ok: false, reason: "stopping" };
  if (!OVERTIME_PHASES.includes(state.phase)) return { ok: false, reason: "not_started" }; // D-14
  const { deadlineAt, hardDeadlineAt } = state.deadlines;
  if (deadlineAt === undefined || hardDeadlineAt === undefined) return { ok: false, reason: "uncapped" }; // 防御
  if ((state.diag.overtime?.extensions ?? 0) >= budget.maxExtensions) return { ok: false, reason: "limit_reached" };
  const headroom = hardDeadlineAt - Math.max(now, deadlineAt);
  if (headroom <= 0) return { ok: false, reason: "no_headroom" }; // 含 D-10：显式预算 run 恒落此处
  return { ok: true, headroomMs: headroom };
}

/** 宽限窗口：夹在硬天花板之内（D-7）。返回 undefined = 没有可用宽限。 */
export function graceWindow(state: RunState, budget: DeadlineBudget, at: Millis): Millis | undefined {
  if (budget.totalGraceMs <= 0) return undefined;
  if (!extendability(state, budget, at).ok) return undefined; // D-6：没额度就不宽限；D-14：非 OVERTIME 相位不宽限
  const h = state.deadlines.hardDeadlineAt!; // extendability ok ⇒ 非 undefined
  const until = Math.min(at + budget.totalGraceMs, h);
  return until > at ? until : undefined;
}
```

`remainingFor` **不动**（`queue`/`create`/`bind` 三处 guard 仍用）。

**`mergeBudget`（`src/config/settings.ts`）的 D-11 改动**：

```ts
export function mergeBudget(...overrides: Array<Partial<DeadlineBudget> | undefined>): DeadlineBudget {
  const sane = overrides.map((o) =>
    o !== undefined && "totalMs" in o && !(typeof o.totalMs === "number" && Number.isFinite(o.totalMs) && o.totalMs > 0)
      ? (({ totalMs: _drop, ...rest }) => rest)(o) // 该层的 totalMs 非法 ⇒ 丢弃，回退下一层
      : o,
  );
  return { ...DEFAULT_BUDGET, ...sane.reduce((out, value) => ({ ...out, ...value }), {}) };
}
```

`DEFAULT_BUDGET.totalMs = 1_800_000` 是最后一层，恒 > 0 ⇒ **`mergeBudget` 的返回值 `totalMs` 恒 > 0**（`tests/config/agent-config.test.ts` 加断言锁死）。

### 3.4 `armedTimers` 如何重算（回答设计问题 1）

现有 `clearAndArm()` 做三件事：清掉所有已武装 timer → 改相位（并重置 `phaseEnteredAt`）→ 按新相位重武装。本特性需要一个"**只重武装、不动相位时钟**"的版本：

```ts
/** 只重算 armedTimers，绝不触碰 diag.phaseEnteredAt / lastEventAt。 */
function rearmTimers(state: RunState, budget: DeadlineBudget): { state: RunState; effects: RunEffect[] } {
  const effects: RunEffect[] = state.armedTimers.map((timer) => ({ kind: "clear_timer" as const, timer }));
  const timers: TimerId[] = [];
  const total = activeTotalTimer(state.deadlines); // ← 新增（下方）
  const phaseTimerId = phaseTimer(state.phase);
  const phaseDue = phaseTimerId === undefined ? undefined : dueAtFor(state.phase, state.diag, budget);
  if (phaseTimerId !== undefined && phaseDue !== undefined && budget.totalMs !== 0) {
    // totalMs !== 0 分支：防御性保留
    timers.push(phaseTimerId);
    effects.push({
      kind: "arm_timer",
      timer: phaseTimerId,
      dueAt: total === undefined ? phaseDue : Math.min(phaseDue, total.dueAt),
    }); // 上界用 effectiveDeadlineAt（审计一致性，见下）
  }
  if (total !== undefined && budget.totalMs !== 0) {
    timers.push(total.timer);
    effects.push({ kind: "arm_timer", timer: total.timer, dueAt: total.dueAt });
  }
  return { state: { ...state, armedTimers: timers }, effects };
}

/** 同一时刻只可能武装 total / total_grace 其中之一。 */
function activeTotalTimer(d: RunDeadlines): { timer: TimerId; dueAt: Millis } | undefined {
  if (d.graceUntil !== undefined) return { timer: "total_grace", dueAt: d.graceUntil };
  if (d.deadlineAt !== undefined) return { timer: "total", dueAt: d.deadlineAt };
  return undefined;
}
```

`clearAndArm(state, phase, at, budget)` 重构为：先写入 `{ phase, phaseEnteredAt: at }`，再委托 `rearmTimers`。行为对既有全部路径**逐位等价**（`graceUntil === undefined` 时 `activeTotalTimer` 退化为原来的 `deadlineAt` 分支）——评审已逐行比对确认 156 格等价。

**评审 RK-1 修正的因果关系**：`arm_timer.dueAt` **没有消费者**（watchdog 对非总类 timer 用 `dueAtFor` 现算，与 `deadlineAt` 无关），所以 v1 所述"宽限中相位 timer 以过去时上界立刻误触发（R-2）"**不是真实隐患**；`rearmTimers` 的真正承重点是 **`armedTimers` 里总类 timer 的 id 必须正确**：宽限中必须是 `total_grace` 而**绝不能残留 `total`**——否则 watchdog 每个 tick 都会看到 `now ≥ deadlineAt` 并派发 `deadline_fired{total}`。`dueAt` 上界改用 `activeTotalTimer` 只是让审计信息自洽。

### 3.5 `reduce` 的三处分支改动

#### (a) `enqueued`（唯一新增：冻结硬天花板）

```ts
const deadlineAt = /* 既有 min(raw, cap) 逻辑，一字不改 */;
const hardDeadlineAt = hardDeadlineAtFor(input.at, input.budget, input.deadlineCapAt);
// deadlines: { enqueuedAt, deadlineAt, queueDeadlineAt, ...(hardDeadlineAt === undefined ? {} : { hardDeadlineAt }) }
// diag:      { ..., ...(hardDeadlineAt === undefined ? {} : { hardDeadlineAt }) }   ← 镜像（BL-5 终态重建用）
```

`armedTimers` 与 effects **完全不变**（仍是 `arm_timer queue` + `arm_timer total`）。天花板不是 timer，只是夹子。
`exactOptionalPropertyTypes` 下 `graceUntil` 在 enqueue 时不写入（缺席即"不在宽限中"）。

#### (b) `deadline_fired`

```ts
if (input.kind === "deadline_fired") {
  if (!state.armedTimers.includes(input.timer)) return illegal(state, input);
  // ★ 防御（RK-1）：宽限中不可能合法收到 total（它已被 rearmTimers 卸载）。若因 bug 残留在 armedTimers，
  //   绝不能让它二次进宽限 / 重复通知 / 走原杀路径 —— 判 illegal，什么都不做。
  if (input.timer === "total" && state.deadlines.graceUntil !== undefined) return illegal(state, input);
  const removed = { ...state, armedTimers: state.armedTimers.filter((t) => t !== input.timer) };
  // ── queue_wait / resolve_config / session_create / extension_bind / abort_grace 五个分支
  //    一字不改（见 §3.6 表格的"不可宽限"行）──
  …既有代码…

  // ★ 新增：软截止到点 + OVERTIME 相位 + 宽限可用 ⇒ 进入续跑宽限，run 不停
  if (input.timer === "total") {
    const until = graceWindow(state, budget, input.at);       // 内含 D-6 / D-10 / D-14 判定
    if (until !== undefined) {
      const o = state.diag.overtime ?? { graces: 0, extensions: 0, grantedMs: 0 };
      const overtime = { ...o, graces: o.graces + 1, grace: { startedAt: input.at, until } };
      const next = { ...removed, deadlines: { ...removed.deadlines, graceUntil: until }, diag: { ...removed.diag, overtime } };
      const armed = rearmTimers(next, budget);          // 卸 total、装 total_grace
      return emit(armed.state, [...armed.effects, { kind: "notify_deadline", notice: buildGraceNotice(next, budget, input.at, until) }]);
    }
    // until === undefined ⇒ 宽限关闭 / 额度耗尽 / 触顶 / 显式预算 run ⇒ 落到下面的既有通用路径（原地杀）
  }

  // ── 既有通用路径：进 abort_grace + cancel_signal (+ soft_steer)，一字不改 ──
  //    total_grace 到点也走这里（timerReason["total_grace"] = "total"，timeoutReason 仍是 "total"）
  …既有代码…
}
```

**为什么启动相位不宽限**：`resolve_config` / `session_create` / `extension_bind` 卡住是环境/配置问题，多给 90s 不会变好；`queue_wait` 到点应快速失败以释放队列压力。宽限只授予"正在产出的 run"（`OVERTIME_PHASES`）。

**为什么 `total_grace` 到点复用原路径**：终态语义必须与今天完全一致（`timed_out` + `timeoutReason:"total"` + `request_abort` + `dispose` + reaper），这是 zero-hang 论证可以直接复用的前提。

#### (c) `deadline_extended`（新分支）

```ts
if (input.kind === "deadline_extended") {
  const verdict = extendability(state, budget, input.at);
  if (!verdict.ok) return illegal(state, input); // 工具层已先行拒绝，这里是纵深防御（含 not_started）
  const prev = state.deadlines.deadlineAt!; // extendability 保证非 undefined
  const hard = state.deadlines.hardDeadlineAt!;
  // ★ 以 max(now, prev) 为基准：宽限中 prev 已成过去时，若从 prev 起算，"+60s" 可能等于 0 净增益
  const base = Math.max(input.at, prev);
  const requested = Math.max(0, input.extendMs);
  const nextDeadline = Math.min(base + requested, hard);
  if (nextDeadline <= prev && nextDeadline <= input.at) return illegal(state, input); // 净增益为 0
  const granted = nextDeadline - base;
  const o = state.diag.overtime ?? { graces: 0, extensions: 0, grantedMs: 0 };
  const { grace: _leaving, ...rest } = o; // ★ 退出宽限：删 overtime.grace
  const overtime = {
    ...rest,
    extensions: o.extensions + 1,
    grantedMs: o.grantedMs + granted,
    ...(input.reason === undefined ? {} : { lastReason: input.reason.slice(0, 200) }),
    lastSource: input.source,
  };
  const { graceUntil: _cleared, ...deadlines } = { ...state.deadlines, deadlineAt: nextDeadline }; // ★ 清宽限
  const next = { ...state, deadlines, diag: { ...state.diag, deadlineAt: nextDeadline, overtime } };
  const armed = rearmTimers(next, budget); // 卸 total_grace（若有）→ 装 total@nextDeadline；相位时钟不动
  return emit(armed.state, [
    ...armed.effects,
    { kind: "notify_deadline", notice: buildExtendedNotice(next, budget, input, prev, granted) },
  ]);
}
```

**三条绝对禁令（防"延长 = 免费续命一切"）：**

1. 不得触碰 `diag.phaseEnteredAt` —— 否则一次延长就顺手把卡死 10 分钟的 `tool_exec` 计时清零，`toolMs` 永远打不到。
2. 不得触碰 `diag.lastEventAt` —— 同理，`idleMs` 静默检测必须继续从真实的最后事件起算。
3. 不得触碰 `deadlines.hardDeadlineAt` / `enqueuedAt` / `queueDeadlineAt`。

`envelope()` 的 criticality 分类：`notify_deadline` 落在 `best_effort`（不在 `release_slot|settle_waiters|clear_timer|persist_snapshot` 白名单里，默认即 best_effort）。通知丢了不影响 run 仍会在 `graceUntil` 死掉。

**`fireDeadline()`（runner）必须配套改**：dispatch 后**回读 state**，仅当 `state.status === "stopping" || isTerminalStatus(state.status)` 才 `cancel.cancel("timeout")`——否则宽限刚进入就被 cancel 掉。评审确认此点属实且关键；配 P-level 属性"宽限进入后 `activeCancels` 未被触发"。

### 3.6 状态转移表（事件 × 相位 → 新状态 + effects）

只列**新增/改变**的格子；其余 12×13 = 156 格全部保持现状。

**新增列：`deadline_extended`**（12 格；非平凡 oracle 只有 5 格——D-14）

| 相位                                                                            | 判定                                           | 新 status/phase    | effects                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `queue_wait` / `resolve_config` / `session_create` / `extension_bind`           | `extendability → "not_started"`                | 不变               | `[]`（`illegal:deadline_extended`）                                                                  |
| `prompt_dispatch` / `model_turn` / `tool_exec` / `retry_backoff` / `compaction` | 允许（主路径；若在宽限中则同时脱离宽限）       | running / 相位不变 | `clear_timer*`,`arm_timer <phase>`(上界=新 deadlineAt),`arm_timer total`,`notify_deadline{extended}` |
| `abort_grace`                                                                   | `extendability → "stopping"`                   | 不变               | `[]`（`illegal`）                                                                                    |
| `reap`                                                                          | 同上                                           | 不变               | `[]`                                                                                                 |
| `settled` / 任意终态                                                            | `terminalUpdate` 未列举 → 落到末尾 `illegal()` | 不变               | `[]`                                                                                                 |
| 任意 OVERTIME 相位 + 额度耗尽/触顶（含 D-10 显式预算 run）                      | `"limit_reached"` / `"no_headroom"`            | 不变               | `[]`                                                                                                 |
| （防御）任意相位 + `deadlineAt === undefined`                                   | `"uncapped"`                                   | 不变               | `[]`                                                                                                 |

**改变的格子：`deadline_fired{timer:"total"}` × 5 个 OVERTIME 相位**

| 条件                                                         | 新 status/phase                        | effects                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `graceUntil !== undefined`（残留 timer，**防御**）           | 不变                                   | `[]`（`illegal`）                                                                                                                           |
| `graceWindow() !== undefined` （**新行为**）                 | **running / 相位不变**                 | `clear_timer <phase>`,`clear_timer total`,`arm_timer <phase>`(上界=graceUntil),`arm_timer total_grace(graceUntil)`,`notify_deadline{grace}` |
| `graceWindow() === undefined`（宽限关/额度尽/触顶/显式预算） | stopping / `abort_grace`（**同今天**） | `clear_timer*`,`arm_timer abort_grace`,`arm_timer total(过去时)`,`cancel_signal`,`soft_steer`（后二者仅 running 相位）                      |

**新增行：`deadline_fired{timer:"total_grace"}`**

| 相位               | 新 status/phase                                                  | effects                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 个 OVERTIME 相位 | stopping / `abort_grace`                                         | 与今天 `total` 到点**除总类 timer id（`total` ↔ `total_grace`）及其 `dueAt` 外逐项相等**（RK-2：进 `abort_grace` 后 `graceUntil` 仍在 ⇒ `rearmTimers` 重装的是过去时 `total_grace`，与今天重装过去时 `total` 同构；`timeoutReason:"total"`、`stopCause:"timeout"`、`cancel_signal`、`soft_steer` 完全相同） |
| 其它相位           | `total_grace` 不可能被武装 → `!armedTimers.includes` → `illegal` | `[]`                                                                                                                                                                                                                                                                                                        |

**其它交互（无需改码，但必须验证）：**

| 事件                                                              | 宽限中的行为                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt_settled`（run 在宽限内自然完成）                          | 正常 `finish(completed)`；`armedTimers` 清空；`deadlines.graceUntil` 与 `diag.overtime.grace` **留在终态快照里作为审计痕迹**（BL-5）                                                                                                                                                                                             |
| `stop_requested`（用户 abort）                                    | 正常进 `abort_grace`；`rearmTimers` 同时武装 `abort_grace`（`phaseEnteredAt + abortGraceMs`）与 `total_grace`（`graceUntil`），**先到先杀**；无论哪个先到，`abort_grace` 分支的 status 判定读的是进入时的 `timeoutReason`（宽限进入**不**写 `timeoutReason`）与 `stopCause: user_stop` ⇒ 终态恒为 **`aborted`**（RK-12(c)，V22） |
| `deadline_fired{timer:"idle"/"tool"/…}`                           | **照常杀**——这是"宽限不掩盖真挂死"的机制保证                                                                                                                                                                                                                                                                                     |
| `session_event` / `effect_failed` / `escalation_done` / …         | 完全不受影响                                                                                                                                                                                                                                                                                                                     |
| （既有事实）`total`/`total_grace` 到点后 `abort_grace` 的实际时长 | ≈ 1 个 watchdog tick（§1.1），不是 `abortGraceMs`；文档与测试断言按此事实写                                                                                                                                                                                                                                                      |

---

## 4. 延长工具契约（回答设计问题 2）

### 4.1 工具定义 `src/tools/extend-timeout-tool.ts`

```ts
export const ExtendTimeoutParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id of the subagent whose time budget to extend; also accepts a unique run_id prefix or the Agent call's label (its description).",
  }),
  extend_s: Type.Integer({
    minimum: 1,
    description:
      "Extra wall-clock seconds to add on top of the run's current deadline. The grant is capped by the run's hard ceiling, so you may get less than you ask for — the result says exactly how much was granted.",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Short note on why more time is warranted; shown in the agent tree and the run's diagnostics.",
    }),
  ),
});
```

- **单位：秒**（D-12）。`execute` 内 `extendMs = params.extend_s * 1000` 后进入 query/runner/core 的毫秒世界。
- 与 `steer_subagent` / `abort_subagent` 完全同款：`run_id` 走 `resolveRun`（exact → prefix → label），失败即 `throw new Error(resolved.error)`（错误里带候选列表）。
- `renderCall` 同款：`Extend Subagent Timeout: <run_id>` + 灰色的 `+10m<reason 预览>`。
- **注册门禁**：`index.ts` 中 `if (settings.extend.enabled) pi.registerTool(createExtendTimeoutTool({...}))`，与 `compact.enabled` 门禁同款。子会话不注入（走 host-claim 守卫；子 run 的注入工具集见 `runtime-adapter.ts`，本工具不加入）。

### 4.2 增量 vs 绝对（D-5 的完整论证）

采纳：**只有 `extend_s`（增量）**。

- 模型的自然表达是"再给它 10 分钟"，增量与之同构；绝对总预算要求模型先知道 `enqueuedAt` 才能算对，而它并不可靠地知道。
- 两个互斥可选参数（`extend_s` XOR `new_total_s`）在实践中会产生三种坏调用：都不给、都给、给错语义。每一种都需要一条自纠错错误文案 + 一条测试。
- 绝对语义并未丢失：`get_subagent_result` / `/agent status` / fleet widget 都会显示剩余时间，"把它设成还剩 30 分钟" = `extend_s: 30min - remaining`。
- **未采纳备选**记录在案：若后续真实使用中出现"我想设一个绝对上限"的强需求，再加 `new_total_s` 时应做成**独立工具** `set_subagent_timeout`，而不是往同一个 schema 里塞第二个互斥参数。

### 4.3 上限模型（次数 + 倍数，双重）

| 上限                 | 键                        | 默认 | 语义                                                                                                      |
| -------------------- | ------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| 次数                 | `budget.maxExtensions`    | `3`  | 单个 run 累计批准的延长次数；`0` = 禁止延长且禁用宽限                                                     |
| 时长倍数             | `budget.maxTotalFactor`   | `2`  | `hardDeadlineAt = enqueuedAt + ceil(totalMs × factor)`，enqueue 时冻结；**显式预算 run 被钳为 1**（D-10） |
| 绝对上限（既有 CC4） | `SpawnRequest.deadlineAt` | —    | `hardDeadlineAt = min(上式, deadlineAt)`；调用方给的绝对帽子**永远收紧、绝不放松**                        |

两个上限**同时生效，取最严**。默认配置下一个 30min 的默认预算 run 最多活到 60min（`H`），再 +abortGrace（实际 ≈1 tick）+reap。

为什么要两个而不是一个：

- 只有次数：模型可以一次要 `extend_s: 86400`，一次就把 run 变成一天。
- 只有倍数：模型可以在天花板内高频小步延长，每次都触发一次宽限通知 → 通知风暴（次数上限把通知总量钉死，见 §5.5）。

### 4.4 各状态 run 的校验矩阵

| run 状态/相位                                                                              | `extendability`        | 工具行为                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未知 run_id                                                                                | —                      | `throw`：`resolveRun` 的错误（含候选）                                                                                                                                                                                                                                                                                                        |
| `queued`（`queue_wait`）/ `starting`（`resolve_config`/`session_create`/`extension_bind`） | `"not_started"` (D-14) | `throw`："run X has not started running yet (<status>); its deadline can only be extended once it is executing. Check on it with get_subagent_result \"<id>\" and extend after it starts."                                                                                                                                                    |
| `running`（5 个 OVERTIME 相位）                                                            | ok                     | 允许，主路径                                                                                                                                                                                                                                                                                                                                  |
| `stopping`（`abort_grace`/`reap`）                                                         | `"stopping"`           | `throw`："run X is already shutting down (abort in progress); extending its deadline would not bring it back."                                                                                                                                                                                                                                |
| 终态（completed/failed/timed_out/aborted）                                                 | `"already_terminal"`   | `throw`："run X already finished (<status>). Use get_subagent_result \"<id>\" to read its output."                                                                                                                                                                                                                                            |
| 显式预算 run（`Agent(timeout_s)` / workflow 子 run / RPC / goal-eval）——`H = deadlineAt`   | `"no_headroom"` (D-10) | `throw`："run X was spawned with an explicit timeout, which is a hard cap; it stops at its deadline (in 42s) and cannot be extended. Read what it has so far with get_subagent_result \"<id>\", or abort_subagent and respawn with a larger timeout_s." （文案由 `hardDeadlineAt === deadlineAt && extensionsUsed === 0` 区分于下面的"触顶"） |
| 已用满次数                                                                                 | `"limit_reached"`      | `throw`："run X has already used all N deadline extensions. It will stop at its current deadline (in 42s). Read what it has so far with get_subagent_result \"<id>\", or abort_subagent and respawn with a larger timeout_s."                                                                                                                 |
| 已触硬天花板（延长过后）                                                                   | `"no_headroom"`        | `throw`："run X is at its hard ceiling (60m from start); no further extension is possible. …（同上收尾建议）"                                                                                                                                                                                                                                 |
| （防御）`deadlineAt === undefined`                                                         | `"uncapped"`           | `throw`："run X has no time cap configured; there is nothing to extend."（配置层已禁止此状态，保留文案作纵深防御）                                                                                                                                                                                                                            |
| `Runner.extendDeadline` 未实现（老 runner）                                                | `"unsupported"`        | `throw`："this build cannot extend run deadlines."                                                                                                                                                                                                                                                                                            |

所有拒绝文案都遵循既有"**自纠错**"约定（`tests/tools/model-facing-strings.test.ts` 会扫 schema description，文案本身由专门用例覆盖）：每条都告诉模型**下一步该做什么**，而不是只说失败。

### 4.5 成功返回

```ts
content: [{ type: "text", text:
  `Extended run ${short} by ${formatDuration(granted)} (requested ${formatDuration(requested)}${clamped ? ", clamped by its hard ceiling" : ""}). ` +
  `New deadline in ${formatDuration(deadlineAt - now)}. ` +
  `${extensionsRemaining} of ${maxExtensions} extensions left; at most ${formatDuration(hardDeadlineAt - deadlineAt)} more available.` +
  (rescuedFromGrace ? " The run was inside its timeout grace window and is now back to normal execution." : "")
}],
details: <ExtendOutcome>
```

时间一律用相对时长（`formatDuration`），不用绝对时钟——与 `formatSingle` / `formatBashJobNotification` 的既有约定一致，且测试不受时区/locale 影响。

### 4.6 并发竞态（回答设计问题 2 最后一问）

**三个竞争者**：① watchdog 的 1Hz tick、② 延长工具、③ runner 内 `guard(handle.prompt(...))` 的一次性 timer。

**① vs ②**：两者最终都收敛到 `RuntimeRunner.dispatchExternal(runId, gen, input) → reduce`，跑在同一个 JS 事件循环线程上，天然串行。两种顺序都安全：

- **watchdog 先**：进宽限（`total` 卸、`total_grace` 装、通知发出）。随后 `deadline_extended` 到达 → `deadline_extended` 分支以 `base = max(now, prev)` 重算 → 清 `graceUntil` → 装 `total`。净效果正确，且 `rescuedFromGrace: true`。
- **延长先**：`deadlineAt` 推到未来、`total` 以新 due 重装。watchdog 下一 tick **实时读** `state.deadlines.deadlineAt`（不是快照），条件不成立，不触发。

**结构性保证**：`Runner.extendDeadline` 与 `QueryService.extendTimeout` **必须是同步方法**（D-9）。检查（`extendability`）→ 派发（`dispatchExternal`）→ 回读（`this.states.get(runId)`）三步之间不允许出现任何 `await`，于是不存在 TOCTOU 窗口。工具的 `execute` 仍是 `async`（`ToolDefinition` 要求），但它对 query 的调用是同步的一行。

**③ prompt guard —— 必须改造的隐藏杀手**：
`run()` 里 `promptBudget = remainingFor(budget.totalMs, now, state.deadlines)` 得到一个**固定毫秒数**，`guard()` 用 `clock.setTimer(ms)` 一次性武装。延长 `deadlineAt` 对它毫无影响：旧 timer 到点 → `{ok:false, reason:"timeout"}` → `prompt_settled{error:timeout}` → `finish(timed_out)`。**延长会静默失效，run 照旧在原时间死掉。**

改造方案：把 prompt 这一处的 `guard` 换成 **deadline 从动的重检查守卫**：

```ts
private async guardUntil<T>(
  p: Promise<T>, deadlineOf: () => Millis | undefined, cancel: CancelHandle, label: string,
): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" | "cancelled" }> {
  // timer 到点时不直接判超时，而是重读 deadlineOf()：
  //   - undefined            → 不重装（防御性分支：配置层已禁止 totalMs ≤ 0（D-11），正常路径不可达；
  //                            保留是为了让直接构造的 RunDeadlines 也不会 setTimer(0) 假超时）
  //   - due > now            → 按 due - now 重装，继续等
  //   - due <= now           → 真超时，resolve
}
```

`deadlineOf` 传 `() => effectiveDeadlineAt(state.deadlines)`（`state` 是 `run()` 里那个被 `dispatch` 持续替换的闭包变量，读到的永远是最新值）。

`queue` / `create` / `bind` 三处 guard **保持原样**（那三个相位不可宽限、不参与延长，`remainingFor` 的一次性语义仍然正确）。

`clock.setTimer` 沿用 `systemClock`，重装复用同一 `Clock` 端口；`guard` 的 `finish()` 清理路径不变 → **不新增任何常驻 timer，`pi -p` 打印模式不受影响**。

---

## 5. 通知流（回答设计问题 3）

### 5.1 为什么不进 outbox（D-4 完整论证）

| 维度        | outbox（`delivery/notifier.ts`）                                                                                                              | 宽限通知的真实需求                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 主键        | `deliveryKey(runId, generation)`，一 run 一条                                                                                                 | 一个 run 可能发多条宽限通知 + 1 条终态通知                                                                                                      |
| 抢占风险    | `enqueue()` 见到该 key 已存在且非 `dropped/abandoned` → **直接 return**。宽限通知先占了 key，run 真正终结时的 `enqueue_delivery` 会被静默吞掉 | **不可接受**                                                                                                                                    |
| 持久化/重投 | `reconcile()` 会在重启后重投 `pending` 记录                                                                                                   | 重启后重播"你还有 90s 可以延长"是撒谎；宽限窗口早已过期                                                                                         |
| 合并        | `coalescer` / `ackHold` 按窗口攒批                                                                                                            | 宽限通知是紧急、单条、必须立刻到达（`isCoalescible` 要求 `status === "completed"`，本来也不会被攒批，但语义上要显式排除；D-17：不复用 ackHold） |
| 属性测试    | P10「一个 run 恰好一条 delivery」                                                                                                             | 必须保持不变                                                                                                                                    |

**结论**：复用的是**注入主会话上下文这条通道的形状与接线点**（`pi.sendMessage(..., { triggerTurn })`，就在 `stack.ts` 的 `sendFormatted` 旁边），而**不是** outbox 的记录生命周期。

### 5.2 通道定义

```ts
// delivery/deadline-notice.ts 导出常量；stack.ts 接线，与 sendFormatted 并列
export const TIMEOUT_NOTICE_TYPE = "subagent:timeout";

const sendDeadlineNotice = (notice: DeadlineNotice) => {
  if (!shouldDeliverDeadlineNotice(notice, { policy: settings.extend.notify, expectsAck, autoBackgrounded })) return;
  pi.sendMessage(
    {
      customType: TIMEOUT_NOTICE_TYPE,
      content: formatDeadlineNotice(notice, { now, snapshot }),
      display: true,
      details: notice,
    },
    deliveryOptionsFor(notice), // grace → { triggerTurn: true }；extended → { triggerTurn: false }
  );
};
```

- `customType` 与 `subagent:notification` **必须不同**：`createNotificationReceiptHook` 只认 `subagent:notification`，否则宽限通知会被 `contextReceipt.noteEntered()` 误记成"终态通知已进上下文"，进而让 fleet widget 的 terminal-linger 逻辑错判。
- `triggerTurn`：`grace` = `true`（必须唤醒模型做决策）；`extended` = `false`（见 §5.4）。
- 无持久化、无重试、无 reconcile。丢一条通知的后果是"run 按原计划在 `graceUntil` 死掉"——即降级到本特性之前的行为，安全。

### 5.3 宽限通知文案（`delivery/deadline-notice.ts` 的 `formatDeadlineNotice`）

模型必须从这一条消息里拿到：**是谁**、**还剩多久**、**怎么延长**、**能延多少**、**不作为的后果**。

```
⏳ Subagent "reviewer" (#a1b2c3d4) hit its 30m time budget and is STILL RUNNING.
Grace: 88s left — after that it is killed as timed_out and you only get its partial output.
Now: tool_exec (bash) · 7 turns · $0.41 · idle 3s
Give it more time:  extend_subagent_timeout(run_id: "a1b2c3d4", extend_s: 600)
Budget left: 3 of 3 extensions, at most 30m more.
Doing nothing lets it expire — that is a valid choice if its partial result is enough.
Task: 审查 src/delivery 的投递生命周期并给出风险清单
```

要点：

- `run_id` 用 8 位短 id（`resolveRun` 支持唯一前缀），与既有 `formatSingle` 一致。
- 给出**一个可以直接抄的完整调用**（含具体 `extend_s` 建议值 = `round(suggestedExtendMs / 1000)`，core 以 `min(totalMs, headroom)` 算好）。
- 显式说明"不作为也是合法选择"，避免模型形成"看到就必须续"的条件反射。
- `Task:` 一行来自 `diag.taskPrompt`（折叠空白、截断 120 字符），让模型不必回忆上下文就知道这个 run 在干嘛。
- `Now:` 行从 `snapshot.diag` 实时读取（phase/currentTool/turns/usage/idle）；缺快照则省略该行。
- `display: true` → 人类在 TUI 里同样看得到。

### 5.4 "已延长"回执通知

`deadline_extended` 也发 `notify_deadline{kind:"extended"}`。v1 只有 `source: "tool"`（D-13）：

| source   | 场景                   | 处置                                                                                                                                                                           |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"tool"` | 主会话模型自己调的工具 | **不注入模型上下文**（工具返回值已经把同样的信息给它了，再注一条纯属烧 context）。v1 选择：`display: true, triggerTurn: false` 的一行短消息，因为人类需要看到"谁把 run 续了命" |

文案：`⏳ Run "reviewer" (#a1b2c3d4) deadline extended by 10m (2 of 3 extensions used, 20m headroom left). Reason: 需要跑完全量测试`

### 5.5 抑制规则与配额

三层抑制。**规则 1 在 `runtime-adapter.ts`**（它独占 `childRunIds`），**规则 2/3 在纯函数 `shouldDeliverDeadlineNotice()`**（`delivery/deadline-notice.ts`，由 `stack.ts` 注入谓词后调用——`diag.autoBackgroundedAt` 只存在于 spawn-service 的 records 副本，adapter 内拿不到，见 plan §0 S5）：

1. **CC2 子 run 抑制**（D-8）：`if (childRunIds.has(notice.runId)) return;`
   子 run 归其 owner 所有，不得独立向顶层上下文喷通知。**v2 补充**：workflow 子 run 因 D-10 是显式预算 run，**根本不会进宽限**；此规则今天实际只作用于嵌套 `Agent` 子 run（父 agent 注入的 Agent 工具不带 `timeout_s` 时）。已知限制：这类子 run 白得 `totalGraceMs` 的额外寿命然后死掉。v2 可将其经 fabric router 路由给父 run（`kind: "directive"`），本版不做。
2. **caller-ack 抑制**：`expectAck === true` 的前台 `Agent` 调用，宿主模型此刻**正阻塞在该工具调用内部**，收到通知也无法调用延长工具——通知等于纯噪声。规则：
   `policy === "background" && expectsAck(runId) && !autoBackgrounded(runId) → false`。
   一旦该 run 被 `foregroundAutoBackgroundMs` 自动转后台（`autoBackgroundedAt` 置位），宿主已解除阻塞，通知恢复发送。
3. **主开关**：`policy === "off"` → 全不发（宽限本身仍生效，只是静默续 90s）。`policy === "always"` → 忽略规则 2（**仅调试用途**，D-17）。

**通知总量上界**（BL-3 口径）：记 `N = maxExtensions`。宽限只在 `extensionsUsed < N` 时进入（D-6），进宽限不消耗额度；每次进宽限最多 1 条 `grace`，每次延长最多 1 条 `extended`，延长次数 ≤ `N`。断言口径（P12）：**`grace ≤ N + 1`、`extended ≤ N`、总数 `≤ 2N + 1`**（默认 N=3 ⇒ ≤ 7 条）。这是状态机层面的硬保证，不依赖任何节流器。

> 备注：按 D-6 的判定顺序可推得更紧的 `grace ≤ N`（第 N+1 次进宽限需要 `extensions < N`，而每次幸存的宽限都消耗一次延长）。P12 采用评审给出的保守上界以规避边界差一争议；另配一条定向用例断言 N=3 的最坏序列恰好产生 3 条 `grace` + 3 条 `extended`。

### 5.6 run 在宽限期内自然完成如何收尾

- **走完全正常的终态路径**：`prompt_settled` → `finish("completed")` → `settle_waiters` / `emit_lifecycle` / `persist_snapshot` / `enqueue_delivery`。宽限对终态语义**零影响**。
- **不撤回宽限通知**：`pi.sendMessage` 无法撤回，且宽限通知是同步发出的（无 hold window，没有可 cancel 的缓冲条目）。
- **由终态通知收尾**：终态通知紧随其后到达，天然构成"事情已解决"的语义闭环。
- **增强（低成本）**：`stack.ts` 的 `sendFormatted` 在单条分支里已经 `store.get(payload.runId)` 取快照做 label/failReason 兜底；顺带读 `snapshot.diag.overtime`，在 `completed` 文案尾部追加 ` (finished in overtime; 1 extension used)`。让主会话明确知道"上一条催命通知已经作废"。
- **终态快照保留审计字段（BL-5）**：`finish()` 原样带走 `state.deadlines`（含 `graceUntil` / `hardDeadlineAt`）。但 **`spawn-service.ts` 的终态重建**（`outcomes` 路径：`deadlines: { enqueuedAt, deadlineAt: diag.deadlineAt, queueDeadlineAt: undefined }`）只保留两字段——**必须改为**同时恢复 `hardDeadlineAt: diag.hardDeadlineAt` 与 `graceUntil: diag.overtime?.grace?.until`（这就是两个 diag 镜像存在的原因）。否则 V6 的 `deadlines.graceUntil` 断言必挂。

---

## 6. Fleet widget（回答设计问题 4）

### 6.1 `FleetRow` 新增字段（`src/ui/fleet-panel.ts`）

```ts
export interface FleetRow {
  // …既有字段…
  /** 距离生效截止（宽限中取 graceUntil）的剩余毫秒；终态时 undefined。 */
  remainingMs: Millis | undefined;
  /** run 已越过总预算，正处在续跑宽限窗口内。 */
  inGrace: boolean;
  /** 已批准的 deadline 延长次数（0 表示从未延长）。 */
  extensions: number;
}
```

`toRow()` 里：

```ts
const eff = snapshot.deadlines.graceUntil ?? snapshot.deadlines.deadlineAt;
remainingMs: terminal || eff === undefined ? undefined : Math.max(0, eff - opts.now),
inGrace: !terminal && snapshot.deadlines.graceUntil !== undefined,
extensions: snapshot.diag.overtime?.extensions ?? 0,
```

### 6.2 `highlightOf()` 调整

```ts
if (isTerminalStatus(s.status)) return "none";
if (s.status === "stopping") return "crit";
if (s.deadlines.graceUntil !== undefined) return "crit"; // ★ 新增：宽限中 = 最响的信号
if (s.deadlines.deadlineAt !== undefined && now > s.deadlines.deadlineAt) return "crit"; // 既有，保留
if (idleBudgetMs !== undefined && idleOf(s, now) * 2 > idleBudgetMs) return "warn"; // 既有
if (deadlineWarnMs !== undefined && deadlineWarnMs > 0 && eff !== undefined && eff - now <= deadlineWarnMs)
  return "warn"; // ★ 新增
return "none";
```

`FleetViewOptions` 增 `deadlineWarnMs?: Millis`（由 `stack.ts` 传 `settings.fleetDeadlineWarnMs`，默认 60s）。新增的 warn 层解决的是"超时永远是突然发生的"——现在主行会提前 60s 变黄。

### 6.3 `widgetRowMain` 字段插入位置与丢弃优先级

插入位置：**紧跟 `phase` 之后、`context` 之前**。理由：它与 `phase` 同属"这个 run 现在健康吗"这一层信息，`context`/`cost` 是资源统计，属下一层。

```ts
const fields = [
  { name: "type",  value: row.type ?? "·" },
  ...(modelFull ? [{ name: "model", value: modelFull }] : []),
  { name: "phase", value: fixed },
  ...(row.remainingMs === undefined ? [] : [{ name: "deadline", value: deadlineField(row) }]),  // ★
  { name: "context", value: … },
  ...(row.usage ? [{ name: "cost", value: … }] : []),
  { name: "total", value: `Σ${formatDuration(row.elapsedMs)}` },
  ...(row.autoBackgrounded ? [{ name: "background", value: "⇣后台" }] : []),
];

function deadlineField(row: FleetRow): string {
  const t = formatDuration(row.remainingMs!);
  const ext = row.extensions > 0 ? `+${row.extensions}` : "";
  return row.inGrace ? `⏳宽限${t}` : `⏳${t}${ext}`;
}
```

丢弃优先级（在现有 `if (!fits())` 阶梯末尾追加一级）：

```
type → model(先缩短为 base，再丢) → context → cost → background → total → deadline*
                                                                          ↑ 仅当 !row.inGrace
```

即 **`deadline` 是最后一个被丢弃的可选字段**，排在 `total`（Σ 累计耗时）之后——极窄宽度下"还剩多久"比"已经跑了多久"更有决策价值。**宽限中（`inGrace`）时 `deadline` 永不丢弃**：那是一条 90 秒内必须被人看到的信息，宁可截断 label。

`⏳` 是宽度 2 的 emoji（与既有 `🧠/🔧/⇣` 同类），`visibleWidth` 计算无歧义，不会触发 CJK 歧义宽度导致的整树重排（见 `THINKING_FRAMES` 注释里记录的 braille 教训）。

### 6.4 `/agent status <runId>`（`src/commands/status.ts`）

诊断面输出增两行（原始值，不做 emoji 美化，与该命令既有风格一致）：

```
deadline      2026-09-10T14:32:10Z (in 4m12s)  [grace: 58s left]  ceiling +60m
overtime      graces=1 extensions=1 granted=10m reason="需要跑完全量测试"
```

---

## 7. Settings 新增项（回答设计问题 5）

### 7.1 `DeadlineBudget`（`core/deadline.ts` 的 `DEFAULT_BUDGET`）

| 内部字段                            | 存储/展示键             | 默认       | live | 说明（进 `BUDGET_DESCRIPTIONS`）                                                     |
| ----------------------------------- | ----------------------- | ---------- | ---- | ------------------------------------------------------------------------------------ |
| `totalMs`（既有，**改描述 + min**） | `budget.totalS`         | `1800`     | ✅   | `Overall run cap (must be > 0; 0 falls back to the default)`；spec `min: 1`（D-11）  |
| `totalGraceMs`                      | `budget.totalGraceS`    | `90`（秒） | ✅   | `Grace after the total budget before force-kill (default-budget runs only); 0 = off` |
| `maxExtensions`                     | `budget.maxExtensions`  | `3`        | ✅   | `Max deadline extensions per run; 0 = no extension and no grace`                     |
| `maxTotalFactor`                    | `budget.maxTotalFactor` | `2`        | ✅   | `Hard ceiling as a multiple of the total budget (explicit timeouts are always 1)`    |

实现注意：

- `totalGraceMs` 因为 `*Ms` 后缀，`secondsKeyOf()` 自动映射为 `budget.totalGraceS`，`normalizeTimeUnits` 自动做秒↔毫秒转换，**零额外代码**。
- `BUDGET_SPECS` 现在的生成逻辑是「除 `startupRetries` 外一律 `seconds(...)`」，需扩成白名单：`["startupRetries", "maxExtensions"] → count(...)`，`"maxTotalFactor" → { kind:"number", path, min:1, live:true }`（**允许非整数**，如 1.5），`"totalMs" → seconds(..., { min: 1 })`（`seconds()` 增 `min?` 选项）。
- `BUDGET_DESCRIPTIONS` 是 `Record<keyof DeadlineBudget, string>`，TS 会强制补齐三条——这是好事（编译器当检查表）。
- `/agent budget` 的 usage 文案（`commands/status.ts`）里 "budget.totalS: 0 = no overall cap" **删除**。
- 放进 `DeadlineBudget` 的收益：`reduce()` 签名不变、agent-type `budgetOverride` 自动支持、`/agent settings` 自动列出。

### 7.2 `AgentSettings` 新增 `extend` 块（`config/settings.ts`）

| 键                   | 类型                                   | 默认         | 生效      | 说明                                                                                                                                                                                           |
| -------------------- | -------------------------------------- | ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extend.enabled`     | boolean                                | `true`       | `/reload` | 总开关。为 `false` 时：① `index.ts` 不注册 `extend_subagent_timeout`；② spawn-service 合并后钳 `maxExtensions = 0`（D-16）→ 宽限与延长一并关闭（保持"没有工具就不要发不可行动的通知"的一致性） |
| `extend.notify`      | enum `background` \| `always` \| `off` | `background` | `/reload` | 宽限通知投递策略。`background` = 跳过仍在前台阻塞宿主的 caller-ack run（§5.5 规则 2）；`always` = **调试用**，前台阻塞中也发（D-17）；`off` = 不发（宽限仍生效）                               |
| `fleetDeadlineWarnS` | seconds → `fleetDeadlineWarnMs`        | `60`         | `/reload` | 剩余时间低于该值时 fleet widget 主行转 warn 色；0 = 关闭该预警层                                                                                                                               |

`parseExtendSettings(value)` 逐字段容错（与 `parseCompactSettings` / `parseGoalSettings` 同款，绝不抛进 settings 加载路径）。
`SETTING_SPECS` 追加三条（`bool` / `choice` / `seconds`），排在 `"compact.enabled"` 之后、`"cacheTtl.mode"` 之前。

### 7.3 完整键名清单（供 `/agent settings` 验收）

```
budget.totalS               1800    applies to new runs immediately   (min 1; 0 → WARN + default)
budget.totalGraceS          90      applies to new runs immediately
budget.maxExtensions        3       applies to new runs immediately
budget.maxTotalFactor       2       applies to new runs immediately
extend.enabled              true    takes effect after /reload
extend.notify               background   takes effect after /reload   (always = debug only)
fleetDeadlineWarnS          60      takes effect after /reload
```

---

## 8. 改造触点清单（回答设计问题 6）

图例：🧊 = **冻结面**（P0 串行落地）；其余按 plan §2 的包归属。

| 子系统   | 文件                                                                                                                                          | 职责                                                                                                                                                                                                                                                                                    | 归属            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| core     | `src/core/types.ts`                                                                                                                           | `DeadlineBudget` +3；`RunDeadlines` +`graceUntil`/`hardDeadlineAt`；`RunDiagnostics` +`hardDeadlineAt`/`overtime`；`RunInput` +`deadline_extended`；`RunEffect` +`notify_deadline`；新 `ExtendSource`/`DeadlineNotice`/`ExtendOutcome`                                                  | 🧊              |
| core     | `src/core/status.ts`（**新**）                                                                                                                | `TERMINAL_STATUSES` / `isTerminalStatus`（D-15）                                                                                                                                                                                                                                        | 🧊              |
| core     | `src/core/deadline.ts`                                                                                                                        | `DEFAULT_BUDGET` +3；`OVERTIME_PHASES`；`effectiveDeadlineAt` / `applyBudgetPolicy` / `hardDeadlineAtFor` / `extendability` / `graceWindow`                                                                                                                                             | 🧊              |
| core     | `src/core/state-machine.ts`                                                                                                                   | `INPUT_KINDS` +1；`terminal()` → `isTerminalStatus`；`clearAndArm` 拆出 `rearmTimers` + `activeTotalTimer`；`enqueued` 冻结天花板 + diag 镜像；`deadline_fired` 新增宽限分支 + 残留 `total` 防御；新增 `deadline_extended` 分支；`buildGraceNotice`/`buildExtendedNotice`               | Pkg A           |
| runtime  | `src/runtime/watchdog.ts`                                                                                                                     | `timerReason` +`total_grace: "total"`；`tick()` 的 due 取值改为 `timer === "total" ? deadlineAt : timer === "total_grace" ? graceUntil : dueAtFor(...)`                                                                                                                                 | Pkg A           |
| runtime  | `src/runtime/runner.ts`                                                                                                                       | `TERMINAL_STATUSES` → core/status；新增同步 `extendDeadline(runId, extendMs, opts): ExtendOutcome`；prompt 那一处 `guard` → `guardUntil`；`fireDeadline` 回读 state 条件 cancel                                                                                                         | 🧊 存根 → Pkg A |
| service  | `src/service/ports.ts`                                                                                                                        | `Runner.extendDeadline?(…): ExtendOutcome`（可选方法，老实现返回 `unsupported`）                                                                                                                                                                                                        | 🧊              |
| service  | `src/service/runtime-adapter.ts`                                                                                                              | 导出 `deadlineNoticeHandler(childRunIds, sink)`；`BasicEffectInterpreter` 注册 `notify_deadline`；`Runner.extendDeadline` 透传；`deps.onDeadlineNotice`                                                                                                                                 | Pkg B           |
| service  | `src/service/query-service.ts`                                                                                                                | `QueryService.extendTimeout(runId, extendMs, opts): ExtendOutcome`（**同步**）；`wait()` 默认基准（RK-5：`diag.overtime` 存在才用 `hardDeadlineAt`，否则 `deadlineAt`）                                                                                                                 | 🧊 存根 → Pkg B |
| service  | `src/service/spawn-service.ts`                                                                                                                | `applyBudgetPolicy` 调用（D-10/D-16）+ `deps.extensionsEnabled`；终态重建保留 `hardDeadlineAt`/`graceUntil`（BL-5）                                                                                                                                                                     | P-final         |
| tools    | `src/tools/agent-tool.ts`                                                                                                                     | `timeout_ms` → `timeout_s`（`Type.Integer({ minimum: 1 })`，描述改写为硬顶语义 + 指向默认预算可延长）；`budgetOverride: { totalMs: timeout_s * 1000 }`                                                                                                                                  | 🧊（BL-4）      |
| tools    | `src/tools/workflow-tool.ts`                                                                                                                  | `timeout_ms` → `timeout_s`（schema/描述/promptSnippet/renderCall/execute ×1000）——同为 model-facing 总预算参数，D-12 一致性                                                                                                                                                             | 🧊              |
| tools    | `src/tools/extend-timeout-tool.ts`                                                                                                            | **新文件**：typebox schema（`extend_s`）、`resolveRun`、`renderCall`、拒绝文案矩阵                                                                                                                                                                                                      | Pkg B           |
| runtime  | `src/runtime/tool-scope.ts`                                                                                                                   | `RESERVED_TOOL_NAMES` +`extend_subagent_timeout`                                                                                                                                                                                                                                        | Pkg B           |
| delivery | `src/delivery/deadline-notice.ts`（**新**）                                                                                                   | `TIMEOUT_NOTICE_TYPE`、`formatDeadlineNotice`、`shouldDeliverDeadlineNotice`、`deliveryOptionsFor`、`overtimeTail`                                                                                                                                                                      | Pkg B           |
| stack    | `src/stack.ts`                                                                                                                                | `sendDeadlineNotice`（与 `sendFormatted` 并列）；`createSpawnService({ extensionsEnabled: settings.extend.enabled })`；`createRuntimeRunnerAdapter({ onDeadlineNotice })`；fleet widget 传 `deadlineWarnMs`；`sendFormatted` 追加 overtime 尾巴；`defaultWaitMs` 注释补一句（数值不变） | P-final         |
| index    | `src/index.ts`                                                                                                                                | `forwardQuery` +`extendTimeout` 转发（P0）；`if (settings.extend.enabled) pi.registerTool(createExtendTimeoutTool(...))`（P-final）                                                                                                                                                     | 🧊 / P-final    |
| config   | `src/config/settings.ts`                                                                                                                      | `mergeBudget` 丢弃非法 `totalMs` 层（D-11）；`loadSettingsFromFile` WARN `budget.totalS ≤ 0`；`ExtendSettings` + `DEFAULT_SETTINGS.extend` + `parseExtendSettings` + `fleetDeadlineWarnMs`                                                                                              | 🧊              |
| config   | `src/config/setting-specs.ts`                                                                                                                 | `BUDGET_DESCRIPTIONS` +3 且 `totalMs` 改写；`seconds()` 增 `min?`；`BUDGET_SPECS` 生成器白名单扩容（`totalMs` min 1）；`SETTING_SPECS` +3                                                                                                                                               | 🧊              |
| rpc      | `src/rpc/server.ts`                                                                                                                           | **仅注释**：`clampBudget` 的 `Math.max(1, …)` 注释改为引用 D-11（"0 现在回退默认，RPC 仍需钳 ≥1 以保持 caps.totalMs 语义"）；**不加** DEFAULT_CAPS（BL-2：`protocol.ts` 白名单 + `additionalProperties:false` 已挡住新三键）                                                            | 🧊              |
| ui       | `src/ui/fleet-panel.ts`                                                                                                                       | `FleetRow` +3 字段；`toRow`；`highlightOf` +2 条；`FleetViewOptions.deadlineWarnMs`                                                                                                                                                                                                     | Pkg C           |
| ui       | `src/ui/fleet-widget.ts`                                                                                                                      | `widgetRowMain` 的 `deadline` 字段与丢弃阶梯；`FleetWidgetController` 透传 `deadlineWarnMs`                                                                                                                                                                                             | Pkg C           |
| commands | `src/commands/status.ts`                                                                                                                      | `/agent status` 增 deadline / overtime 两行；`/agent budget` usage 文案删 "totalS: 0 = no overall cap"                                                                                                                                                                                  | Pkg C           |
| docs     | `README.md` / `README.en.md`（`Agent` 工具参数行 `timeout_ms` → `timeout_s`）、`CHANGELOG.md`、`AGENTS.md` 的 `src/core` 一行描述、本文状态行 | P-final                                                                                                                                                                                                                                                                                 |

**建议施工顺序**见 plan §4（P0 冻结面 → A ∥ B ∥ C → P-final → 真机验证）。

---

## 9. 测试策略（回答设计问题 7）

### 9.1 转移矩阵（`tests/core/core.test.ts`，lockstep 强制）

- `INPUT_KINDS` 13 → 14，断言从 `toHaveLength(13)` 改 `14`，`FLAT_MATRIX` 从 156 → **168**，`Object.keys(MATRIX[phase])` 断言同步。
- **矩阵基线 budget 显式设 `totalGraceMs: 0`**：这样全部 12 个 `deadline_fired` 旧格子**逐位保持现状**，改动不扩散。宽限行为放进独立的 `describe("timeout grace")`，用 `totalGraceMs: 60_000` 的 budget 驱动。
- 新增列 `deadline_extended` 的 12 个 oracle 按 §3.6 表填写（4 个启动相位 + `abort_grace`/`reap`/`settled` 为 `illegal`，5 个 OVERTIME 相位为主路径）；`buildInput()` 增一个 case。
- 新增独立套件：
  - `deadline_fired{total}` × 5 个 OVERTIME 相位 × {宽限可用 / `totalGraceMs=0` / `maxExtensions=0` / 已用满次数 / 已触天花板 / `maxTotalFactor=1`（D-10 显式预算）} → 5×6 = 30 个断言。
  - `deadline_fired{total_grace}` 与今天的 `total` 路径 **除总类 timer id 及其 dueAt 外 effects 序列逐项相等**（RK-2；把 `total_grace`→`total` 归一化后 `toEqual`）。
  - 宽限中 `phase_entered` / `tool_start` / `tool_end` → `rearmTimers` 仍武装 `total_grace` 且 **`total` ∉ armedTimers**（RK-1 真正 oracle）。
  - **防御**：宽限中手工把 `total` 塞回 `armedTimers` 再喂 `deadline_fired{total}` → `illegal`，`graces` 不变、无 `notify_deadline`。
  - 宽限中 `stop_requested` → 两种 timer 先后顺序 → 终态均为 `aborted`（RK-12(c)）。

### 9.2 属性不变量（同文件）

| 编号                     | 变更                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P6**                   | 「immutable deadline」**改写**为：`deadlineAt` 单调不减；且任意时刻 `deadlineAt <= hardDeadlineAt`；且 `hardDeadlineAt` 在整个序列中恒定不变（B1 迁移的可执行证明） |
| **P3**                   | 「no timers after terminal」不变，但随机输入生成器要能产出 `deadline_extended`（终态后必须无效果）                                                                  |
| **P10**                  | 「一个 run 恰好一条 delivery」**必须保持不变**——这是 D-4（通知不进 outbox）的回归护栏                                                                               |
| **P11**（新）            | 任意随机序列后：`graceUntil === undefined \|\| graceUntil <= hardDeadlineAt`                                                                                        |
| **P12**（新，BL-3 口径） | 单个 run 的 `notify_deadline{kind:"grace"}` 效果数 ≤ `maxExtensions + 1`；`{kind:"extended"}` ≤ `maxExtensions`；总数 ≤ `2·maxExtensions + 1`                       |
| **P13**（新）            | `deadline_extended` 永不改变 `diag.phaseEnteredAt` / `diag.lastEventAt` / `deadlines.enqueuedAt` / `deadlines.hardDeadlineAt`（§3.5 三条禁令的可执行证明）          |
| **P14**（新，评审建议）  | 宽限进入后（`graceUntil` 刚置位的那一步）effects 里**没有** `cancel_signal`（对应 runner 层 `fireDeadline` 不 cancel 的 reducer 侧证明）                            |
| **P8**                   | 重复/乱序/陈旧代次鲁棒性：随机序列里混入重复的 `deadline_extended`，最终 `(status, phase)` 与规范序列一致                                                           |

`randomInput()` 需增加 `deadline_extended` 分支（`extendMs` 取 1s~1h 随机、`source: "tool"`）。

### 9.3 watchdog（`tests/runtime/watchdog.test.ts`，新）

- `total_grace` 已武装时，due 取 `graceUntil`（而非 `deadlineAt`）。
- 宽限中 **`total` 不在 `armedTimers`**（真正的 oracle）；配合 §9.1 的 reducer 防御用例，即使残留也不会二次进宽限。
- 宽限中 `idle` timer 照常在 `idleMs` 后触发 → 走原杀路径（"宽限不掩盖真挂死"）。
- 假时钟推进：`totalMs=1000, totalGraceMs=500, maxExtensions=1, maxTotalFactor=2` 的 run，t=1000 进宽限并发通知，t=1500 被杀，`timeoutReason === "total"`。

### 9.4 runner（`tests/runtime/runtime.test.ts`）

- **回归核心**：`extendDeadline` 之后，`guardUntil` 重装而非在旧时刻误判超时（假时钟 + fake driver，断言 `prompt` 未被超时解除）。
- `guardUntil` 的 `deadlineOf() === undefined` 防御分支：直接构造无 `deadlineAt` 的 deadlines 不 `setTimer(0)`（一条防御用例；**不再**是 "totalMs=0 回归"）。
- `fireDeadline` 进宽限后**不** cancel（`activeCancels` 未触发、`prompt` 未 abort）。
- `extendDeadline` 对终态 / 陈旧 generation / 不存在的 run / `not_started` 返回正确的 `ExtendOutcome.reason`。
- 宽限中延长 → `rescuedFromGrace: true`，`grantedMs` 以 `now` 为基准（不是过去的 `deadlineAt`）。
- 延长被天花板夹住 → `clamped: true`，`grantedMs < requestedMs`。
- 并发顺序双向用例：`fireDeadline` 后立刻 `extendDeadline`，以及 `extendDeadline` 后立刻 `tick()`。

### 9.5 工具 / 通知 / UI / 集成

| 层                                                     | 用例                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/tools/extend-timeout-tool.test.ts`（新）        | 八种拒绝理由各一条（含 `not_started`、显式预算 `no_headroom` 文案变体；每条含"下一步该做什么"）；成功文案含 granted/remaining/ceiling；`resolveRun` 前缀与 label；`extend_s` 边界（0 被 schema 拒）；`extend_s * 1000` 传给 query                                                                                                                                                          |
| `tests/tools/agent-tool.test.ts`                       | `timeout_s: 120` → `budgetOverride.totalMs === 120_000`；缺席时不写 `budgetOverride`                                                                                                                                                                                                                                                                                                       |
| `tests/tools/model-facing-strings.test.ts`             | 把新工具加入 `tools()` 列表；Agent/Workflow 的 description 不再含 `timeout_ms`                                                                                                                                                                                                                                                                                                             |
| `tests/delivery/deadline-notice.test.ts`（新）         | `formatDeadlineNotice` 两种 kind 快照（含 `extend_s: 600` 而非毫秒）；`shouldDeliverDeadlineNotice` 真值表（off / background+ack 前台 / background+ack 已转后台 / always）；`deliveryOptionsFor`；`overtimeTail` 三态                                                                                                                                                                      |
| `tests/service/runtime-adapter-extend.test.ts`（新）   | `deadlineNoticeHandler`：直接构造 `EffectEnvelope{notify_deadline}` 喂 `BasicEffectInterpreter`，子 run 丢弃、顶层透传（RK-10：**不依赖 reducer，不 skip**）；`extendDeadline` 透传                                                                                                                                                                                                        |
| `tests/delivery/notifier.test.ts`                      | **回归**：宽限通知发出后（模拟：在 `enqueue()` 之前对同一 runId 调 `sendDeadlineNotice` 路径的等价操作 = 什么都不写入 outbox），同一 run 的终态 `enqueue()` 仍然成功（outbox 里恰好一条记录，key 未被抢占）——本质是锁死"宽限通知不碰 outbox"                                                                                                                                               |
| `tests/service/deadline-cap.test.ts`                   | 补 `hardDeadlineAt` 断言：显式 `budgetOverride.totalMs` ⇒ `hardDeadlineAt === deadlineAt`（D-10）；带 `deadlineAt` cap ⇒ `hardDeadlineAt === cap`；显式预算 run + `totalGraceMs > 0` 到点**直接**进 `abort_grace`（无宽限）                                                                                                                                                                |
| `tests/service/query-service-wait-default.test.ts`     | RK-5：无 `overtime` 时默认基准仍是 `deadlineAt`（既有用例不变）；有 `overtime` 时基准变 `hardDeadlineAt`                                                                                                                                                                                                                                                                                   |
| `tests/config/agent-config.test.ts`                    | `mergeBudget` 丢弃 `totalMs: 0` / 负数 / NaN 层并回退下一层；返回值 `totalMs > 0` 恒成立                                                                                                                                                                                                                                                                                                   |
| `tests/ui/fleet.test.ts`                               | `FleetRow.remainingMs/inGrace/extensions` 计算；`highlightOf` 的宽限 crit 与 warn 阈值                                                                                                                                                                                                                                                                                                     |
| `tests/ui/fleet-widget.test.ts`                        | `⏳12m` / `⏳宽限58s` 渲染；窄宽度丢弃阶梯（`deadline` 排在 `total` 之后被丢）；`inGrace` 时永不丢弃                                                                                                                                                                                                                                                                                       |
| `tests/config/extend-settings.test.ts`（新）           | 三个 budget 键的秒↔毫秒往返、`maxTotalFactor` 非整数、`extend.*` 容错解析；`budget.totalS: 0` → `totalMs` 默认 + `loadSettingsFromFile` WARN；`SETTING_SPECS["budget.totalS"].min === 1`                                                                                                                                                                                                   |
| `tests/ui/settings-editor.test.ts`                     | 新键出现在编辑器列表且描述非空                                                                                                                                                                                                                                                                                                                                                             |
| `tests/integration/timeout-grace-wiring.test.ts`（新） | 端到端（默认预算 run）：假时钟 + `totalMs=2s / totalGraceMs=1s / maxExtensions=1 / maxTotalFactor=2` → 断言 `pi.sendMessage` 收到 `subagent:timeout` 且 `triggerTurn:true` → 调用工具延长 → run 活过原 deadline → 最终正常 `completed` 且终态通知只有一条；limit=1 槽位挤压（RK-4）；`extend.enabled=false` + agent-type `maxExtensions:3` 覆盖仍无宽限（RK-8）；跨 stack 重建（RK-12(b)） |

### 9.6 真机验证清单

见 plan §5（V1–V24，含方法列与结果列）。

---

## 10. 风险与不变量论证（回答设计问题 8）

### 10.1 zero-hang 形式化论证

记：`E = enqueuedAt`，`T = budget.totalMs`（**恒 > 0**，D-11），`F = budget.maxTotalFactor (≥1；显式预算 run 为 1)`，`G = budget.totalGraceMs`，`N = budget.maxExtensions`，`C = SpawnRequest.deadlineAt`（可缺席）。

**定义** `H = hardDeadlineAt = min(E + ⌈T·F⌉, C ?? +∞)`，在 `enqueued` 分支中计算**一次**，之后没有任何代码路径写它（P6/P13 属性测试锁死）。因 `T > 0`，`H` 恒有定义。

- **不变量 I-A（软截止封顶）**：任意时刻 `deadlineAt ≤ H`。
  - 初始：`deadlineAt = min(E+T, C)`，而 `E+T ≤ E+⌈T·F⌉`（`F ≥ 1`），且 `C` 项两边同取 min ⇒ 成立。
  - 归纳：唯一的写入点是 `deadline_extended`，其值 `= min(base + requested, H) ≤ H`。∎
- **不变量 I-B（宽限封顶）**：`graceUntil = min(at + G, H) ≤ H`（D-7 的直接结论）。∎
- **不变量 I-C（总类 timer 始终在武装）**：非终态时 `armedTimers` 恒包含 `total`（due = `deadlineAt`）或 `total_grace`（due = `graceUntil`）之一，且**不同时包含二者**。
  - `activeTotalTimer()` 是全代码库唯一的总类 timer 武装点，`rearmTimers`/`clearAndArm` 都经它；`enqueued` 分支同样武装 `total`。`deadline_fired` 卸载某个 timer 后，宽限分支立刻武装 `total_grace`，非宽限分支进 `abort_grace` 并武装 `abort_grace` timer + 过去时总类 timer。∎
- **定理（零挂死）**：任意 run 的墙钟寿命 ≤ `H + abortGraceMs + reapMs`。
  - 由 I-A/I-B/I-C，watchdog（1Hz，恒定运行）最迟在 `H` 时刻观测到一个 due ≤ `H` 的总类 timer 并派发 `deadline_fired`。
  - 在 `H` 时刻，`graceWindow()` 返回 `min(H+G, H) = H`，不满足 `until > at` ⇒ 返回 `undefined` ⇒ **不进宽限**，走原杀路径。
  - 原杀路径 = `abort_grace`（由 `abortGraceMs` 封顶，实测 ≈1 tick）→ `finish(timed_out)` + `request_abort` + `dispose` → `finally` 里的 `reaper.reap`（由 `reapMs` 封顶 + L0–L4 逐级升级 + orphan registry 兜底）。
  - 与本特性之前的公式 `deadlineAt + abortGraceMs + reapMs` **完全同构**，只是把冻结的 `deadlineAt` 换成冻结的 `H`。∎
- **v2 补充（D-11 的必要性）**：若 `T = 0` 可达，`clearAndArm` 不武装任何 timer（含子阶段），I-C 不成立，上述定理无上界——这正是评审 BL-1 指出的挂死路径。D-11 把 `T > 0` 变成配置层不变量，定理前提恒成立。

### 10.2 逐项风险

| #                   | 风险                                                                                                                               | 缓解                                                                                                                                                                                                                   | 验证                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| R-1                 | **双重超时执行器**：runner 的一次性 prompt guard 无视延长，run 仍在旧时刻死                                                        | `guardUntil` 从动于 `effectiveDeadlineAt(state.deadlines)`，到点重检查后重装                                                                                                                                           | §9.4 第 1 条；V2                                                    |
| R-2                 | （**降级，RK-1**）宽限中 `total` 残留在 `armedTimers` → watchdog 每 tick 重复派发 `deadline_fired{total}` → 二次进宽限 / 通知风暴  | `rearmTimers` 经 `activeTotalTimer()` 保证总类 timer 唯一；reducer 对"宽限中收到 `total`"判 `illegal`（纵深防御）                                                                                                      | §9.1 防御用例；§9.3 第 2 条                                         |
| R-3                 | **延长顺手重置相位时钟** → 卡死的 tool/idle 获得无限续命                                                                           | §3.5 三条禁令 + **P13 属性测试**逐序列断言                                                                                                                                                                             | P13；V7                                                             |
| R-4                 | 宽限通知抢占 outbox 主键，导致终态通知被静默吞掉                                                                                   | D-4：独立 `subagent:timeout` 通道，完全不碰 outbox                                                                                                                                                                     | P10 + `tests/delivery/notifier.test.ts` 回归；V6                    |
| R-5                 | 通知风暴烧 context                                                                                                                 | 状态机层硬上界 `grace ≤ N+1`、`extended ≤ N`、总 `≤ 2N+1`（D-6 + 次数上限）；三层抑制                                                                                                                                  | P12；V4/V9/V10                                                      |
| R-6                 | 模型无限自续                                                                                                                       | 双上限（次数 `N` + 天花板 `H`），二者均在 enqueue 时冻结，模型无任何途径修改                                                                                                                                           | I-A/I-B；V4/V5                                                      |
| R-7                 | CC4 的 `SpawnRequest.deadlineAt` 被延长绕过（违反"只收紧不放松"）                                                                  | `H = min(公式, C)`；`C` 更紧时 `extendability` 立刻返回 `no_headroom`                                                                                                                                                  | `tests/service/deadline-cap.test.ts`；V17                           |
| R-8                 | **B1 不变量被破坏**（"算一次、永不重算"）                                                                                          | 显式迁移：受 B1 保护的对象从 `deadlineAt` 换成 `hardDeadlineAt`；`deadlineAt` 降级为"单调不减且受 `H` 封顶"。文档、`core/types.ts` 注释、P6 三处同步改写                                                               | P6                                                                  |
| R-9                 | 宽限掩盖真正的挂死                                                                                                                 | 宽限**不削弱任何子阶段 timer**：`idle`/`tool`/`modelTurn`/`compaction` 全程照常武装并可触发                                                                                                                            | §9.3 第 3 条；**V7**                                                |
| R-10                | reaper 兜底被削弱                                                                                                                  | reaper 路径完全未改动：`total_grace` 到点后的 effects 序列与今天 `total` 到点除 timer id 外逐项相等（有可执行断言）                                                                                                    | §9.1 等价性用例                                                     |
| R-11                | （**v2 改写**）`totalMs = 0` 曾是 "不限" 语义，但实际上只靠 prompt 假超时刹车；修掉假超时会制造永久挂死                            | **D-11**：配置层禁止 `totalMs ≤ 0`（`mergeBudget` 丢弃非法层 + 文件加载 WARN + 编辑器 `min: 1`）；reducer/runner 的 `totalMs === 0` / `undefined` 分支保留为防御代码                                                   | `tests/config/agent-config.test.ts`、`extend-settings.test.ts`；V13 |
| R-12                | `pi -p` 打印模式被常驻 timer 卡住                                                                                                  | 不新增任何 interval；宽限完全复用 watchdog 现有 1Hz tick；`guardUntil` 的重装 timer 生命周期与原 `guard` 一致（`finish()` 清理）                                                                                       | 现有 print-mode 集成测试；V14                                       |
| R-13                | `/reload` 后模块级状态泄漏                                                                                                         | 本特性无任何模块级可变状态：宽限/延长状态全在 `RunState`（per-run），通知策略从 `settings` 读，`sendDeadlineNotice` 是 `buildSessionStack` 内的闭包                                                                    | V15/V21                                                             |
| R-14                | 子 run 拿不到续期机会（**已知限制**，非缺陷）                                                                                      | D-8 有意为之；workflow 子 run 因 D-10 本就不进宽限；嵌套 Agent 子 run 白得 `totalGraceMs`；v2 可经 fabric 路由给父 run                                                                                                 | §5.5                                                                |
| R-15                | 延长与 watchdog 的 TOCTOU                                                                                                          | D-9：`extendDeadline`/`extendTimeout` 同步，检查—派发—回读之间无 `await`；单线程事件循环串行                                                                                                                           | §9.4 双向顺序用例                                                   |
| **R-16** (v2, RK-4) | **槽位占用**：宽限 + 延长把并发 slot 持有到 `H`（默认 2×`totalMs`），`concurrencyLimit` 下挤压排队 run，排队者可能 `queue_timeout` | 不做特殊处理（宽限本就是"多占一会儿"，与一个跑满 `totalMs` 的 run 无本质区别）；上界仍是 `H`；文档明示 `totalGraceMs`/`maxTotalFactor` 会放大最坏槽位占用时间                                                          | V19（limit=1：宽限 run 挤压排队 run 的 `queue_timeout` 行为）       |
| **R-17** (v2, RK-5) | `wait()` 默认基准改 `hardDeadlineAt` 会让所有裸 wait 窗口翻倍                                                                      | 仅当 `diag.overtime` 存在（run 真的进过宽限/被延长）才用 `hardDeadlineAt`，否则维持 `deadlineAt`；`stack.ts` 的静态 `defaultWaitMs` 数值不变，只补注释；实际裸 wait 调用方只有 RPC/扩展（`result-tool` 恒传 `waitMs`） | `query-service-wait-default.test.ts`；V18                           |
| **R-18** (v2, RK-8) | `extend.enabled=false` 被 agent-type/per-spawn `maxExtensions` 覆盖回去                                                            | D-16：spawn-service 合并后钳位                                                                                                                                                                                         | V11                                                                 |
| **R-19** (v2, BL-4) | `Agent` 工具描述 "always settles within this budget" 变谎言                                                                        | D-10：显式预算 run 硬顶；描述改写并入 P0 冻结面                                                                                                                                                                        | `agent-tool.test.ts`；V23                                           |

### 10.3 保持不变的既有不变量（回归护栏清单）

- **P10**：一个 run 恰好一条 outbox delivery。
- **CC2**：子 run 不向顶层上下文投递（延伸到新通道）。
- **CC4 ①②③**：`SpawnRequest.deadlineAt` 只收紧、enqueue 时判过期、逐跳显式穿透。
- **I1**：`src/core` 无 pi 导入（`DeadlineNotice` 是纯数据，文案格式化在 `delivery/deadline-notice.ts`）。
- **I7**：`src/index.ts` 只做装配（新增的几行只是条件注册工具 + 转发）。
- **终态语义**：`timed_out` / `timeoutReason: "total"` / `request_abort` / `dispose` / reaper 升级路径逐项未变。
- **RPC 协议**：`budgetOverride` 白名单与毫秒单位不变（BL-2 / D-12）。

---

## 11. 已拍板事项（原"未决问题"，v2 全部关闭）

| #      | 问题                                      | 结论                                              |
| ------ | ----------------------------------------- | ------------------------------------------------- |
| 1      | `/agent extend <run> <duration>` 人类命令 | **v1 不做**；`ExtendSource` 只留 `"tool"`（D-13） |
| 2      | `extend.notify` 默认值                    | `background`；`always` 仅调试（D-17）             |
| 3      | 子 run 宽限通知经 fabric 路由给父 run     | 留 v2；workflow 子 run 因 D-10 本就不进宽限       |
| 4      | `maxTotalFactor` 默认                     | **2**（30min run 最坏 60min）                     |
| 5      | `totalGraceMs` 默认                       | **90s**；V1/V2 真机后复核                         |
| 6 (v2) | 显式 `timeout` 的 run 是否享受宽限        | **不**——硬顶（D-10）                              |
| 7 (v2) | `totalMs = 0`                             | **禁止**，回退默认 + WARN（D-11）                 |
| 8 (v2) | model-facing 时间单位                     | **秒**；内部毫秒；RPC 毫秒（D-12）                |
