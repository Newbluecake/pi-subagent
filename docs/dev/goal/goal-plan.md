# /goal 目标驱动持续运行 · 设计方案 v1

> 需求（已过澄清闸门）：用户开发时经常遇到任务停下来等确认，希望像 Codex `/goal` 一样
> 给定一个目标和结束条件，让 agent 持续自主运行直到达成。
>
> 设计输入：① 网络调研（Codex CLI `/goal`、Claude Code `/goal`、Ralph Wiggum 系、
> Gemini/Aider 权限模式）；② pi core 与 pi-subagent 现有机制盘点（Explore 结论见 §1）。
>
> 用户已拍板的两个分叉：
>
> - **运行位置**：主会话内 loop（Claude/Codex `/goal` 的做法），一期不做后台 subagent 长跑。
> - **判定器**：确定性命令判定 + 独立模型评估器都要，可叠加。

## 0. 外部调研结论（为什么这样设计）

| 来源                          | 机制                                                                                                                                                                | 借鉴点                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Codex CLI `/goal`（v0.128.0） | goal 是 thread 级持久化实体；每轮结束注入 `goals/continuation.md` 模板续跑；token 预算封顶；`pause/resume/clear` 控制面                                             | 持久化 goal 实体、预算刹车、控制面命令    |
| Claude Code `/goal`           | session 级 Stop hook 语法糖；**独立小模型评估器**（默认 Haiku）每轮判定 yes/no+理由，no 则理由作为下轮指引；与 auto mode 互补（一个去 tool 确认，一个去 turn 确认） | **判定模型 ≠ 干活模型**；评估反馈回灌下轮 |
| Ralph Wiggum / run-loop skill | Stop hook 拦截退出，原 prompt 重新喂回；completion promise tag 检测放行                                                                                             | 完成承诺（promise）概念作为退化判定形式   |
| Gemini / Codex 权限模式       | yolo / full-auto 放开 tool 级确认                                                                                                                                   | pi 天然无确认弹窗，零成本获得该能力       |

## 1. pi 侧现状盘点（Explore 结论）

**优势**：

- pi 设计哲学即 **无 permission 弹窗**（README Philosophy 明示），`bash/edit/write` 默认直接执行——别家要 auto mode 解决的问题在 pi 不存在。
- 续跑原语现成：`pi.sendUserMessage(text, { triggerTurn: true })` 可在 agent 空闲时主动唤起新一轮 LLM 调用。
- **compact-hint 已跑通完整闭环**（`src/stack.ts` `createCompactHintHook`）：turn_end 监测状态量 → 越过阈值自主动作（`ctx.compact`）→ `onComplete` 里 `sendUserMessage(RESUME_TEXT)` 把任务续上，全程无用户介入。`/goal` 是该模式的泛化。
- 积木齐全：settings 持久化（`src/config/settings.ts`）、runaway 停滞检测（`src/workflow/runaway.ts`）、verifier subagent spawn 体系（`src/service/spawn-service.ts`）、fleet widget 状态展示。

**空白**：

- pi core 与 pi-subagent 均无「目标驱动续跑」一等抽象；cron 调度器（`src/schedule/`）只能定时重新 spawn，无完成判定语义。
- `pi -p` print 模式跑完即退进程，天然不支持挂机 loop——与 Codex 一致，只在交互模式生效。
- `run-loop`/`run-owl` skill 是跨 CLI 的 prompt 层方案（外部进程重启循环），在 pi 下属降级路线，本方案是 harness 层正解。

## 2. 总体形状

```
/goal <目标> --until-cmd "npm test" [--until "自然语言条件"] [--max-turns N] [--budget-tokens N] [--max-minutes N]
        │
        ▼ 持久化（session 级 goal 实体，settings 态文件）
┌────────────────────────────────────────────────────────────┐
│ GoalLoopHook（pi.on("turn_end", …)，仿 createCompactHintHook）│
│  前置检查：goal active？交互模式？预算未爆？非冷却？未闩锁？   │
│      │                                                      │
│      ▼ 评估完成条件                                          │
│  ① until-cmd：bash 执行，exit 0 = 通过（确定性，零幻觉）      │
│  ② until（自然语言）：spawn verifier subagent（独立模型，      │
│     只读 diff + 定向命令取证）→ yes/no + 理由                 │
│  两者都给了 → 命令过了还要 verifier 确认（AND 语义）           │
│      │                                                      │
│      ├─ 未达成 → sendUserMessage(续跑指令 + 评估差距反馈),    │
│      │           triggerTurn:true，iteration++               │
│      └─ 达成   → 清除 goal，注入一条总结/收尾指令              │
└────────────────────────────────────────────────────────────┘
```

关键不变式：

- **判定模型 ≠ 干活模型**（Claude 对齐）：verifier 走 spawn-service 的独立 subagent，只读、带自己的上下文，防止主 agent 自卖自夸。
- **停滞即停**：连续 N 轮（默认 3）git diff 无变化或错误签名重复 → 判定卡住，停 loop 并上报，防 Ralph 式空转烧钱。
- **防抖三件套**（照抄 compact-hint）：冷却窗口 + 闩锁 + in-flight guard，杜绝 turn_end 重入导致的双重续跑。
- **pi 扩展铁律**：loop 内所有 timer `unref()`；无 module 级可变状态，goal 状态挂 Stack，`activate()` 重建；HOST_KEY 守卫下 subagent 会话中本模块完全惰性。

## 3. 状态机

```
        /goal 设置                /goal pause        /goal resume
none ──────────▶ active ─────────────────▶ paused ──────────▶ active
                  │
                  │ 评估通过                 /goal clear
                  ▼                        （任意状态可达）
               achieved ──────────────────▶ none
                  │
                  │ 预算耗尽 / 停滞 / verifier 连续报错
                  ▼
               stopped ──── /goal resume ──▶ active（预算重置需显式 --reset-budget）
```

持久化字段：`{ objective, untilCmd?, untilText?, maxTurns, budgetTokens, maxMinutes, iteration, state, createdAt, lastEvalSignature }`。
`session_start` 时检测到 `active` 状态的 goal → 提示用户 resume（对齐 Codex 的崩溃持久语义，不自动续跑，避免意外烧钱）。

## 4. 刹车系统

| 刹车                     | 默认            | 说明                                                              |
| ------------------------ | --------------- | ----------------------------------------------------------------- |
| `--max-turns`            | 20 轮           | 迭代次数封顶                                                      |
| `--budget-tokens`        | 无（可选）      | 累计 token 估算封顶                                               |
| `--max-minutes`          | 120             | wall-clock 封顶                                                   |
| 停滞检测                 | 连续 3 轮无进展 | 复用 `src/workflow/runaway.ts` 心跳/签名思路                      |
| `Ctrl+C` / `/goal clear` | —               | 人工急停，立即生效（下一轮 turn_end 检查到 state 变更即不再续跑） |

撞线行为：goal → `stopped`，注入一条「预算/停滞终止报告」指令让主 agent 总结当前进展与卡点，**不静默消失**。

## 5. 控制面

- `/goal <objective> [flags]` — 设置/替换 goal（替换需确认，防误覆盖）
- `/goal` — 查看当前 goal 状态（目标、条件、已跑轮数、剩余预算、上次评估结论）
- `/goal pause | resume | clear`
- fleet widget / 状态栏显示 `goal: 3/20 turns` 徽标（复用现有 widget 通道）

## 6. 与现有模块的接缝

| 接缝                           | 复用方式                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/stack.ts`                 | 新增 `goal` 字段挂 Stack；`createGoalLoopHook()` 与 `createCompactHintHook` 并列注册                                                                                                       |
| `src/index.ts`                 | 顶层注册 `/goal` 命令 + turn_end hook 各一次（I7：assembly only）                                                                                                                          |
| `src/config/settings.ts`       | goal 默认值（maxTurns/maxMinutes/verifier 模型）进 settings schema，逐字段容错                                                                                                             |
| `src/service/spawn-service.ts` | verifier subagent 走唯一 spawn 入口，吃 slot pool/label/通知体系                                                                                                                           |
| `src/workflow/runaway.ts`      | 停滞签名检测逻辑抽出共用或仿写                                                                                                                                                             |
| `src/compact-hint/`            | 冷却/闩锁/fire-and-forget+resume 的模板来源；**两者 turn_end 共存**：compact L2 触发压缩并 resume 时，goal hook 当轮跳过评估（防 compact 与 goal 续跑双重注入，用同一 in-flight 标记协调） |

## 7. 不做的事（一期）

- 后台 subagent 长跑模式（`/goal --background`）——二期，届时复用 Agent 工具的 watchdog/预算体系。
- 多 goal 并存——一期一个 session 一个 active goal（与 Claude 一致）。
- print 模式支持。
- 危险命令拦截层——pi 哲学不做 approval；若用户需要可自行用 `tool_call` hook 扩展，本方案不内置。

## 8. 测试要点

- 状态机迁移矩阵测试（对齐仓库「状态机变更必须同步 matrix/property 测试」的铁律）。
- turn_end hook：active/paused/冷却/闩锁/in-flight 各分支；until-cmd exit≠0 续跑、exit 0 收尾；verifier 超时/报错降级策略（连续 2 次评估失败 → stopped，不无限烧）。
- 与 compact-hint 同轮触发的协调测试。
- `pi -p` 下完全惰性；`/reload` 后状态正确重建。
- 持久化文件损坏时的容错恢复。

---

# v2 · 施工级细化（Plan 产出，kimi-k3）

所有接缝已核实完毕。以下是施工级方案。

---

# /goal 实施方案细化 · 源码接缝核实与文件级落地

## §0 接缝核实表（逐条取证）

### A. pi 扩展 API

| #   | 断言                                                                                                                                                                                                                                                                                                                 | 证据（文件：行号）                                                                                                                             | 结论                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `pi.on("turn_end", handler)`，handler 签名 `(event: TurnEndEvent, ctx: ExtensionContext)`；`TurnEndEvent = { turnIndex, message: AgentMessage, toolResults }`                                                                                                                                                        | `pi-coding-agent/dist/core/extensions/types.d.ts:930`、`:584-590`；`ExtensionHandler` 定义 `:902`                                              | ✅ 能用                                                                                                                                                                                               |
| A2  | **turn_end 每个 LLM 轮触发一次（一次 agent run 内多次），不是 run 结束**；`turnIndex` 在 agent_start 清零、每个 turn_end 后 +1                                                                                                                                                                                       | `dist/core/agent-session.js:484-491`（`_turnIndex++`）、`:362`（agent_start 时 `_turnIndex = 0`）                                              | ⚠️ **goal-plan v1 假设有误**，见 §3-C1                                                                                                                                                                |
| A3  | **`agent_end` 每次 agent run 结束触发一次**，`AgentEndEvent = { type, messages: AgentMessage[] }`；且 **agent_end handler 里入队的消息会让 run 继续**（pi 原生 continuation 语义："Any messages here were queued by agent_end extension handlers and need a continuation. `return this.agent.hasQueuedMessages()`"） | `types.d.ts:555-558`、`:925`；`agent-session.js:473-474`（emit）、`:808-810`（continuation 注释+实现）                                         | ✅ **goal loop 的正解事件**，见 §3-C1                                                                                                                                                                 |
| A4  | `agent_settled` 在 run 完全落定（无 retry/compaction/queued continuation）后触发，`_isAgentRunActive = false`                                                                                                                                                                                                        | `types.d.ts:559-562`、`:926`；`agent-session.js:345-356`                                                                                       | ✅ 可作"彻底空闲"信号，备用                                                                                                                                                                           |
| A5  | `pi.sendUserMessage(content, { deliverAs?: "steer"\|"followUp", expandPromptTemplates? })`，**doc 原文 "Always triggers a turn"**；底层走 `session.prompt(text, { streamingBehavior: options?.deliverAs })`——streaming 时按 deliverAs 入队，空闲时立即起新 run                                                       | `types.d.ts:980-985`；`agent-session.js:1161-1183`                                                                                             | ✅ 续跑原语成立。agent_end handler 内（仍 streaming）须显式 `deliverAs:"followUp"` 入队；落定后调用则直接起新 run                                                                                     |
| A6  | `pi.sendMessage(msg, { triggerTurn?, deliverAs? })`；custom message 落历史为 `type:"custom_message"` 条目，可经 `ctx.sessionManager.getEntries()` 读回                                                                                                                                                               | `types.d.ts:971-976`；compact-hint-plan §0 已核实                                                                                              | ✅ 用于总结/报告类注入                                                                                                                                                                                |
| A7  | `pi.registerCommand(name, options)`；`options.handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>`——**args 是整段原始字符串，自行解析**                                                                                                                                                           | `types.d.ts:946`、`:891-897`                                                                                                                   | ✅ `/goal` 参数自行 split 解析，先例 `src/commands/status.ts:81-82`（`args.trim().split(/\s+/)`）                                                                                                     |
| A8  | `ctx.mode: "tui"\|"rpc"\|"json"\|"print"`、`ctx.hasUI`、`ctx.cwd`、`ctx.sessionManager` 均在 ExtensionContext 上                                                                                                                                                                                                     | `types.d.ts:208-219`                                                                                                                           | ✅。注意**字面值是 `"tui"` 不是 `"interactive"`**——compact-hint 测试里 `mode="interactive"` 是 `as never` 强转的假值（`tests/integration/compact-hint-wiring.test.ts:11`），goal 新测试必须用 `"tui"` |
| A9  | **ExtensionContext 上没有累计 token 统计 API**。但 ① `AgentEndEvent.messages` 里 assistant 消息带 `usage: Usage`（`{input, output, cacheRead, cacheWrite, …}`）；② `ctx.sessionManager.getEntries()` 可读全量条目；③ pi 内部有 `getUsageCostBreakdown(entries)` 但未从包根导出给扩展                                 | `pi-ai/dist/types.d.ts:307-327`（AssistantMessage.usage :316）、`:265-276`（Usage）；`pi-coding-agent/dist/core/usage-totals.d.ts`（非扩展面） | ⚠️ 需适配：**goal hook 在 agent_end 时自行遍历 `event.messages` 累加 assistant usage**（本次 run 的增量），零额外 IO。见 §3-C3                                                                        |
| A10 | `pi.exec(command, args, { signal?, timeout?, cwd? }): Promise<{ stdout, stderr, code, killed }>`                                                                                                                                                                                                                     | `types.d.ts:993`；`dist/core/exec.d.ts`（ExecOptions/ExecResult 全文）                                                                         | ✅ until-cmd 正解，见 §3-C2                                                                                                                                                                           |
| A11 | `ctx.ui.setStatus(key, text \| undefined)` 状态栏徽标                                                                                                                                                                                                                                                                | `types.d.ts:79-80`；先例 `src/cache-ttl/cache-ttl.ts:25-27`                                                                                    | ✅ goal 徽标通道，见 §3-C5                                                                                                                                                                            |

### B. pi-subagent 内部接缝

| #   | 断言                                                                                                                                                                                                                                                                                                                                                                                                                         | 证据                                                                                                                                                        | 结论                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `createCompactHintHook(holder, deps)` 骨架：闭包 `forcing`/`lastForcedAt` 双保险 + `holder.current?.compactHint` 读 Stack + `ctx.mode === "print" \|\| "json"` 跳过 + `ctx.getContextUsage()` + fire-and-forget `ctx.compact({onComplete})` 里 `sendUserMessage(RESUME_TEXT)`                                                                                                                                                | `src/stack.ts:473-602`（forcing 于 :479-480，mode 门 :483，compact 回调 :521-536）                                                                          | ✅ 模板可直接仿写。**但注意 `forcing` 是 hook 闭包私有变量，外部不可见**——goal↔compact 协调标记需提升，见 §3-C4                                                                                                                                                                                         |
| B2  | turn_end 注册处：`pi.on("turn_end", createCompactHintHook(holder, {…}))` 在 activate() 顶层注册一次；`pi.on("message_start", …)` 同处                                                                                                                                                                                                                                                                                        | `src/index.ts:113-120`                                                                                                                                      | ✅ goal hook 并列注册（agent_end），I7 合规                                                                                                                                                                                                                                                             |
| B3  | `/agent` 命令注册先例：`pi.registerCommand("agent", createStatusCommand({…}))`，所有 stack 依赖经 holder 透传                                                                                                                                                                                                                                                                                                                | `src/index.ts:262-281`                                                                                                                                      | ✅ `/goal` 同构                                                                                                                                                                                                                                                                                         |
| B4  | HOST_KEY 守卫：`activate()` 开头 claim，子会话惰性；`session_shutdown` 仅 owner 释放                                                                                                                                                                                                                                                                                                                                         | `src/index.ts:85-113`                                                                                                                                       | ✅ goal 模块在子会话天然惰性，无需额外守卫                                                                                                                                                                                                                                                              |
| B5  | Stack 定义 + buildSessionStack 结构；`previousXxx` 模块级 handoff + 顶部 dispose 的 rebuild 模式；`session_shutdown` 里 `stack.fleetWidget?.dispose()` 等                                                                                                                                                                                                                                                                    | `src/stack.ts:435-471`（Stack）、`:87-104`（previous*）、`:614`（buildSessionStack）；`src/index.ts:367-378`                                                | ✅ 新增 `goal` 字段挂 Stack；无 timer 则无需 previous handoff（goal 状态纯数据+持久化条目）                                                                                                                                                                                                             |
| B6  | settings schema 加新块：`AgentSettings` 加字段 → `DEFAULT_SETTINGS` 加默认 → `loadSettings` 里 `parseXxxSettings(input: unknown)` **逐字段容错、never throws** → 时长字段须登记 `TIME_SETTING_MS_PATHS`（文件存秒级 `*S` 键）                                                                                                                                                                                                | `src/config/settings.ts:146-183`（DEFAULT_SETTINGS）、`:252`（loadSettings）、`:437-470`（parseBashJobsSettings 范本）、`:236-251`（TIME_SETTING_MS_PATHS） | ✅ `goal.maxMinutes` 这类时长字段**必须**进 TIME_SETTING_MS_PATHS，否则 `normalizeTimeUnits` 不做秒→毫秒转换                                                                                                                                                                                            |
| B7  | `SpawnService.spawn(req)` → `{ runId, label? } \| { error }`；**`spawnAndWait(req)` → `Promise<RunOutcome>`**（内部 spawn+expectAck+等终态）；`RunOutcome = { status, text?, error?, usage?, turns, durationMs, diag }`                                                                                                                                                                                                      | `src/service/spawn-service.ts:31-50`（接口）、`:355-373`（spawnAndWait）；`src/core/types.ts:252-271`（RunOutcome）                                         | ✅ verifier 用 `spawnAndWait` 同步等结果，`outcome.text` 取评估结论文本                                                                                                                                                                                                                                 |
| B8  | `SpawnRequest = { type, prompt, label?, cwd?, modelOverride?, modelHintOverride?, thinkingOverride?, budgetOverride?, … }`——可按 spawn 覆盖模型与预算                                                                                                                                                                                                                                                                        | `src/core/types.ts:120-157`                                                                                                                                 | ✅ verifier 模型/预算走 `modelHintOverride`/`budgetOverride`                                                                                                                                                                                                                                            |
| B9  | **只读 verifier agent type 已存在于用户级 `~/.pi/agent/agents/verifier.md`**（frontmatter `tools: read, grep, find, ls, bash`、`prompt_mode: replace`）；类型加载目录三处：`cwd/.pi/agents`、`cwd/.agents/agents`、`~/.pi/agent/agents`                                                                                                                                                                                      | `src/config/agent-types.ts:163`；`~/.pi/agent/agents/verifier.md` 实读                                                                                      | ✅ 现成可用。但它是**用户环境文件不是仓库资产**——settings 里做 `goal.verifierType`（默认 `"verifier"`），spawn 返回 `unknown agent type` 时报清晰错误降级                                                                                                                                               |
| B10 | `src/workflow/runaway.ts` = workflow 心跳看门狗：依赖 `WorkerHost.readHeartbeat()`（vm 心跳语义），`startRunawayWatchdog(deps)` 轮询+edge-trigger 升级                                                                                                                                                                                                                                                                       | `src/workflow/runaway.ts:61-84`                                                                                                                             | ❌ **不可直接复用**——它测的是 vm 脚本心跳，goal 需要的是"跨 run 的进展签名（git diff hash / 错误签名）对比"，语义完全不同。**仿写**：新写 ~40 行纯函数模块，复用其 edge-trigger/单次触发思想                                                                                                            |
| B11 | fleet widget 只读 `QueryService.list()` 且**仅在 subagent run 活跃时显示**（idle 时 setWidget(undefined) 隐藏）                                                                                                                                                                                                                                                                                                              | `src/ui/fleet-widget.ts:20-28`（文件头注释）、`:594-640`                                                                                                    | ⚠️ goal 徽标**不该**走 fleet widget（goal 活跃时常常没有任何 subagent 在跑）。用 `ctx.ui.setStatus("goal", …)`（A11）。若要 tree 内展示，需给 FleetWidgetDeps 加 `goalLine?: () => string` 并在 `buildFleetWidgetLines` 头部插入（`fleet-widget.ts:507` 的 `lines.unshift` 处）——一期建议只做 setStatus |
| B12 | 持久化三范式对比：① settings 文件 = **用户全局配置**（`~/.pi/agent/pi-subagent.json`，`persistSettingOverride` 单键改写）；② schedule store = **全局单 JSON 文件**（tmp+rename 原子写，`src/schedule/store.ts:24-56`）；③ bash job store = **每 job 一文件目录**（`src/bash/job-store.ts:1-70`）；④ fabric/outbox = **会话条目**（`pi.appendEntry` + `sessionManager.getEntries()` 读回，`src/adapters/pi-outbox-store.ts`） | 见各文件                                                                                                                                                    | ⚠️ **goal 运行态是 session 级实体，①②③全部语义错误**（都是全局的）。正解是 ④：`pi.appendEntry("subagent:goal", state)` + session_start 读回（`probeReadBackEntries` 先例 `src/stack.ts:668-676`），崩溃持久+会话隔离+零新文件格式。见 §3-C6                                                             |

### C. 命令执行与测试设施

| #   | 断言                                                                                                                                                                                                                | 证据                                                                                                                  | 结论                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | until-cmd 三选项：a) `pi.exec` b) `child_process` 直跑 c) BashJobManager                                                                                                                                            | A10；`src/stack.ts:1088-1099` 有现成先例（workflow gateRunner 就是 `pi.exec("bash", ["-c", cmd], { timeout, cwd })`） | ✅ **选 `pi.exec`**：同步等退出码、内置 timeout/killed 语义、跨平台、与 workflow gate 同一路径。BashJobManager 是后台化+日志+通知体系（POSIX-gated、异步），语义完全不符；child_process 直跑会绕开 pi 的 exec 设施重复造 timeout 轮子 |
| C2  | hook 类测试范本：`tests/integration/compact-hint-wiring.test.ts`——`harness()` 造假 holder/ctx/sent 数组，`fakePi()`/`stackContext()` 造 `as unknown as ExtensionAPI`，直接调 `createCompactHintHook` 返回的 handler | `tests/integration/compact-hint-wiring.test.ts:7-70`                                                                  | ✅ 照抄结构。goal hook 是 async（等 until-cmd/verifier），测试里 `await hook(event, ctx)` 即可                                                                                                                                        |
| C3  | 状态机 matrix 测试：`tests/core/core.test.ts` "executable transition matrix"（:543 起 builders、:1213 describe）+ "seeded property invariants"（:1637）                                                             | `tests/core/core.test.ts:543-560,1213,1637`                                                                           | ✅ goal 状态机小（5 状态），写一张迁移表测试即可，不必上 seeded property                                                                                                                                                              |
| C4  | runaway 测试先例 `tests/workflow/runaway.test.ts`                                                                                                                                                                   | 存在                                                                                                                  | 仿写 goal 停滞检测测试                                                                                                                                                                                                                |

## §1 文件级改动清单

**新建（全部在 `src/goal/`，对齐 compact-hint 的单目录模块风格）：**

| 文件                  | 职责（一句话）                                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/goal/state.ts`   | GoalState/GoalRecord 类型 + 纯函数状态机（`transition(state, event)` 迁移表）+ 进展签名（git diff hash/错误签名）对比 + 停滞判定；零 pi import（对齐 `src/core/` 纯度）                                                                                                                                     |
| `src/goal/texts.ts`   | 续跑指令 / 评估差距反馈 / 撞线终止报告 / session_start resume 提示的文案 builder（纯函数，对齐 `compact-hint/threshold.ts` 的 builder 风格）                                                                                                                                                                |
| `src/goal/store.ts`   | goal 状态的 appendEntry 持久化：写入 `pi.appendEntry("subagent:goal", record)`、session_start 时从 `ctx.sessionManager.getEntries()` 取最后一条读回；readBack 不可用时降级内存态 + WARN（G5a 同款）                                                                                                         |
| `src/goal/hook.ts`    | `createGoalLoopHook(holder, deps)`：agent_end handler——前置门（state=active？mode？预算？停滞？in-flight？compact 刚强制过？）→ 评估（until-cmd 经注入的 exec port；until-text 经注入的 spawn port spawnAndWait verifier）→ 未达成 `sendUserMessage(续跑, followUp)` / 达成清 goal+总结 / 撞线 stopped+报告 |
| `src/goal/command.ts` | `createGoalCommand(deps)` → registerCommand options：解析 `args`（objective + `--until-cmd/--until/--max-turns/--budget-tokens/--max-minutes` 与 `pause\|resume\|clear` 子命令），操作 Stack.goal 并落盘                                                                                                    |

**修改：**

| 文件                                          | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/settings.ts`                      | 加 `GoalSettings`（`enabled`、`maxTurns`=20、`maxMinutes`=120、`budgetTokens`=0、`stallRounds`=3、`verifierType`="verifier"、`verifierModelHint?`）→ `AgentSettings.goal` + `DEFAULT_SETTINGS` + `parseGoalSettings`（逐字段容错）；`maxMinutes` 登记进 `TIME_SETTING_MS_PATHS`（存储键 `goal.maxMinutes`…注意分钟非毫秒，建议内部直接存 `maxMinutes: number` 不进时长表，或统一定为 `goal.maxRunMs` 走 `*S` 秒键——**推荐后者对齐全仓时长规约**） |
| `src/stack.ts`                                | `Stack` 加 `goal: GoalSessionState`；buildSessionStack 里从 store 读回重建；compact-hint 的 `forcing` 协调标记提升（见 §3-C4）                                                                                                                                                                                                                                                                                                                    |
| `src/index.ts`                                | 顶层注册 `pi.registerCommand("goal", …)` + `pi.on("agent_end", createGoalLoopHook(holder, { exec: …, sendUserMessage: …, spawn: … }))`；各一次（I7）                                                                                                                                                                                                                                                                                              |
| `tests/goal/state.test.ts`                    | 迁移表矩阵测试（5 状态 × 全事件）+ 停滞签名单测                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/goal/hook.test.ts`                     | 各分支：active/paused/冷却/in-flight/compact 跳过/until-cmd exit 0·非 0/verifier 超时·连续 2 次失败 → stopped                                                                                                                                                                                                                                                                                                                                     |
| `tests/integration/goal-wiring.test.ts`       | 假 pi+ctx 端到端：/goal 设置 → agent_end → until-cmd 通过 → achieved 清态                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/config/settings.test.ts`（已有则追加） | `parseGoalSettings` 容错矩阵                                                                                                                                                                                                                                                                                                                                                                                                                      |

## §2 关键设计决策落实（v1 假设纠错）

- **C1（最重要）：评估事件从 `turn_end` 改为 `agent_end`。** v1 §2 写"仿 createCompactHintHook（pi.on("turn_end")）"——turn_end 每次 LLM 轮触发（一个 run 内可几十次），在每次工具调用间隙跑 until-cmd/verifier 既烧钱又会在任务中途误判"未达成"然后注入续跑指令造成 steer 干扰。**`agent_end` 每 run 一次，且 pi 原生支持 handler 内入队消息触发 continuation**（`agent-session.js:808-810`），语义恰好等于"Codex 每轮结束注入 continuation.md"。compact-hint 的「冷却/闩锁/in-flight」三件套照抄，事件源换掉。
- **C2：until-cmd 用 `pi.exec("bash", ["-c", cmd], { timeout, cwd: ctx.cwd })`**（先例 stack.ts:1088），不走 BashJobManager、不直跑 child_process。超时默认建议 5min，进 settings（`goal.untilCmdTimeoutMs`，走 `*S` 时长规约）。
- **C3：token 预算无现成 API**——agent_end handler 内遍历 `event.messages`，累加 `role==="assistant"` 的 `usage.input+output+cacheRead+cacheWrite` 到 `goal.tokensUsed`。是估算（不含子 agent 消耗），文档里注明。
- **C4：compact↔goal 协调标记需提升可见性。** 现 `forcing` 是 `createCompactHintHook` 闭包私有（stack.ts:479）。方案：`CompactHintState` 加 `forcedCompactionAt?: number`（L2 触发时打戳），goal hook 检查"上一 run 期间有强制压缩 → 本轮跳过评估"（compact 的 onComplete 自己会发 RESUME_TEXT 续跑，goal 再发就双重注入）。改动量 3 行，不动 hook 签名。
- **C5：徽标用 `ctx.ui.setStatus("goal", `goal: 3/20 turns`)`**（cache-ttl 先例），clear/stop 时传 undefined 清除；不进 fleet widget（理由 B11）。
- **C6：持久化走 appendEntry 会话条目，不是 settings 文件也不是新 JSON store。** v1 §2 括号里"settings 态文件"的提法废弃：settings 是用户全局配置，goal 是 session 运行态。`subagent:goal` 条目随会话文件走，session_start 读回最后一条，`state==="active"` 则 toast 提示 `/goal resume`（不自动续跑，对齐 v1 §3）。readBack 降级路径照抄 G5a（stack.ts:668-676）。
- **C7：verifier 类型名可配**（`goal.verifierType`，默认 `"verifier"`）；spawn 返回 `unknown agent type` error 时把 until-text 评估降级为"仅 until-cmd 判定"并 WARN 一次，不反复烧。
- **C8：mode 门用 `ctx.mode !== "tui"` 跳过**（一期只交互 TUI；rpc 模式 hasUI 但无真人看 loop，保守跳过）。测试 mock 必须用 `"tui"` 字面值（A8 的坑）。

## §3 实施顺序

1. **第一批（互相可并行）**：`src/goal/state.ts` + `src/goal/texts.ts`（纯函数，无依赖）｜ `settings.ts` goal 块 ｜ `src/goal/store.ts`
2. **第二批（依赖第一批）**：`src/goal/hook.ts`（依赖 state/texts/store 的类型）＋ `src/goal/command.ts`；compact-hint `forcedCompactionAt` 提升（3 行，独立可先行）
3. **第三批（串行收口）**：`stack.ts`（Stack.goal + 读回重建）→ `index.ts`（两处注册）
4. **测试与实现同批走**：state/texts/settings 的单测可随第一批；hook/wiring 测试随第三批。状态机迁移表测试与 `state.ts` 同 PR（仓库铁律）。

## §4 风险清单

| 风险                                                                                                                                                                          | 等级 | 缓解                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 async 评估窗口期的竞态**：agent_end handler 若 `await` verifier spawn（分钟级），会阻塞 pi 的 `_extensionRunner.emit` 全程，run 迟迟不 settle，用户输入/其他通知全部排队 | 高   | handler 内只做同步门检后 fire-and-forget 异步评估，handler 立即返回（run 正常 settle → agent_settled）；评估完成后 agent 已空闲，`sendUserMessage` 直接起新 run（A5）。in-flight 闩锁防重入；评估期间 `/goal clear` 生效时丢弃结果不续跑 |
| **R2 非 goal 触发的 run 也会过评估**：subagent 完成通知（`triggerTurn:true`）等也会让主会话产生 run → agent_end → goal 评估一次                                               | 中   | 无害（until-cmd 幂等、verifier 有一次成本），但要在文案/计数上把这类"被动轮"与"主动迭代轮"分开记，或在 goal 状态里记 `lastContinuationAt`，评估前先跑 until-cmd 有进展才计 iteration                                                     |
| **R3 until-cmd 有副作用**（如 `npm test` 写缓存/快照）：每轮重复执行                                                                                                          | 低   | 一期不管（pi 无 approval 哲学），文档注明 until-cmd 应幂等                                                                                                                                                                               |
| **R4 `sendUserMessage` 在 compaction 进行中会 throw**（`agent-session.js:840` "Cannot submit a prompt while compaction is in progress"）                                      | 中   | goal 续跑调用包 try/catch，失败时冷却一轮后重试（闩锁已防风暴）；与 C4 的 `forcedCompactionAt` 检查天然互斥大部分情形                                                                                                                    |
| **R5 verifier 连续失败烧钱**：verifier spawn 自身超时/报错若每轮重试                                                                                                          | 中   | v1 §8 已定：连续 2 次评估失败 → stopped + 报告；在 state.ts 加 `consecutiveEvalFailures` 计数                                                                                                                                            |
| **R6 会话条目膨胀**：每轮 goal 状态变更都 appendEntry                                                                                                                         | 低   | 只在状态迁移/iteration 变更时写条目（不是每轮心跳）；读回只取最后一条                                                                                                                                                                    |
| **R7 用户 Ctrl+C abort 当前 run 时 agent_end 是否照常触发**                                                                                                                   | 中   | 需真机验证：abort 路径若跳过 agent_end emit，goal 当轮不评估（行为可接受：用户中断=人工介入信号，下轮用户输入后的 agent_end 再评估）；建议列为真机验证清单第一条                                                                         |
| **R8 `/reload` 后 in-flight 评估丢失**                                                                                                                                        | 低   | 异步评估闭包随旧模块失效；goal 状态已持久化，session_start 读回后提示 resume，不自动续跑——与崩溃语义一致                                                                                                                                 |

---

**一句话总结**：v1 方案骨架成立，但有四处必须改——评估事件 turn_end→**agent_end**（A2/A3，v1 核心假设错误）、持久化 settings 文件→**appendEntry 会话条目**（B12）、token 预算→**agent_end messages 里自累加 usage**（A9）、compact 协调标记需从闭包**提升到 CompactHintState**（C4）。所有其余积木（spawnAndWait、pi.exec、setStatus、逐字段容错 settings、holder 透传、HOST_KEY 惰性）均已核实存在且语义吻合。
---

# v3 补充决策（主会话问答固化，2026-09-09）

- **D1 评估器模型**：`goal.verifierModelHint` 默认 `cloudrouter-anthropic/claude-sonnet-5`，可配。
  独立性双支柱：上下文隔离（spawn 独立会话，天然保证）+ 模型不同于干活的（默认 sonnet-5
  覆盖主会话跑 k3 系的常见情况；主会话即 sonnet-5 时用户应自行改配）。
- **D2 不新建 goal-evaluator agent type**：pi 无扩展注册 agent type 的 API（类型仅从
  `cwd/.pi/agents`、`cwd/.agents/agents`、`~/.pi/agent/agents` 三目录加载），新建类型有分发问题。
  改用现成 `verifier` 类型 + SpawnRequest 三重覆盖：
  ① `schema: { goal_met: boolean, gap: string }`（X10 双重校验结构化输出）——判定结果
  走 schema 强制结构，不从文本 regex 解析；verifier.md 的验收矩阵输出要求降级为无害噪音；
  ② `thinkingOverride: "low"`——verifier.md 的 `thinking: high` 是终验档位，循环评估必须降档；
  ③ `budgetOverride` 小预算 + `modelHintOverride`（D1）。
- **D3 任务框架**：goal 评估的 task prompt 为循环场景重写（「工作进行中，判定停止条件是否满足，
  未满足给 ≤3 句差距/下轮指引」），与 verifier.md 角色 prompt 的「一次性终验」框架区分开；
  角色 prompt 只继承证据纪律与只读工具集。
- **D4 until-cmd 优先短路**：双条件叠加时先跑 until-cmd（零模型成本），失败直接续跑，
  不再 spawn verifier。

---

# v4 评审修订（reviewer=opus-5 有条件通过，10 条放行条件逐条处置）

> 评审抽查的 v2 行号证据全部属实（仅行号漂移，施工以"as of 当前 HEAD"重新定位）。
> 结论：满足条件 1–9 + 条件 10 的保留分支后进入施工，无需二次评审。

## 状态机 v4（条件 2 + O4 折中）

四状态：`none / active / paused / stopped(reason)`。

```
none ──/goal set──▶ active ──评估通过──▶ stopped("achieved")
                      │──/goal pause──▶ paused ──/goal resume──▶ active
                      │──abort(stopReason==="aborted")──▶ paused（自动，toast 提示）
                      │──预算/评估上限/投递失败/评估连败──▶ stopped(reason)
rehydrate(session_start) ──▶ paused（强制降级，仅 /goal resume 可迁出；条件 2/BLK-2）
任意 ──/goal clear──▶ none
```

- `stopped` 携带 `reason: "achieved"|"budget"|"max-evals"|"delivery-failed"|"eval-failures"|"paused-manual"`；
  除 `achieved` 外均可 `/goal resume`（预算类需 `--reset-budget`）。
- 持久化只写 `active/paused` 态记录；`stopped/none` 落地为终态记录（rehydrate 遇到终态不提示）。

## 放行条件处置

1. **BLK-1 急停**：hook 入口检查 `event` 对应 run 末条 assistant 消息 `stopReason === "aborted"`
   → 不评估 + goal 自动置 `paused` + toast（`pi -p` 无 UI 时仅落条目）。已核实：abort 照常 emit
   agent_end/agent_settled（`chunk-OMWWHBTG.js` abort 分支）。测试：abort 分支用例。
2. **BLK-2 读回不自动跑**：见状态机 v4，rehydrate 一律落 `paused`；迁移矩阵测试覆盖
   `active --(rehydrate)--> paused`。
3. **BLK-3 刹车旁路**：`evalCount` 硬计数（每次进入评估无条件 +1，含通知触发的被动 run），
   上限 `maxEvals = maxTurns × 2`；成本上限见条件 6。回归测试：「verifier 失败通知 → 新 run →
   再评估」链路必须被 maxEvals 截停。iteration（主动迭代轮）仅用于文案展示，不作刹车口径。
4. **BLK-4 续跑投递**：`sendUserMessage` 返回 void、错误经 emitError 走掉，扩展侧 try/catch
   抓不到——**删除 R4 的 try/catch 方案**。改为：① 无条件 `deliverAs: "followUp"`；
   ② **投递看门狗**：发出后启动 `unref()` timer（默认 30s，settings `goal.deliveryWatchdogMs`
   走 `*S` 规约），未观察到 `agent_start` 则重试一次，再失败 → `stopped("delivery-failed")` + 报告。
5. **MAJ-1 触发事件 = `agent_settled`**（唯一"无 retry/压缩/续跑待决"信号）。删除 v2 中
   "agent_end 入队原生 continuation"的互斥叙事；评估统一为 settled 后 fire-and-forget，
   完成后 `sendUserMessage(followUp)` 起新 run。C4（forcedCompactionAt 提升）随之**作废**——
   settled 语义下压缩期不会到达评估点；补充防线用现成 `ctx.isIdle()`/`hasPendingMessages()`。
6. **MAJ-2 预算口径**：主口径 = 累加 `usage.cost.total`（美元，`pi-ai` Usage 已含）；token 口径
   仅 `input + output`（**cacheRead/cacheWrite 不计**，否则一轮即误刹）。verifier 成本经
   `RunOutcome.usage` 计入 goal 总账。
7. **MAJ-4 epoch 令牌**：goal record 带单调 `epoch`；clear/pause/resume/replace/rehydrate 均
   `epoch++`；评估开始时快照 epoch，应用结果前校验（不等即丢弃）。所有 fire-and-forget 链尾
   `.catch(() => {})`。用户手输新 prompt 期间评估完成 → epoch 未变但 `!ctx.isIdle()` →
   续跑消息降级为 `deliverAs: "followUp"` 排队（不劫持当前话题）。
8. **MAJ-5 读回口径**：走 `getBranch()` 而非 `getEntries()`（防 fork 废弃分支复活 goal）；
   按 `SessionStartEvent.reason` 分支：`reload` 静默保持内存态（不弹 toast）；`resume`/`fork`
   toast 提示；`new` 不继承。fork 出的新会话读回到 goal → 同样降级 `paused`，不产生双认领
   （两个会话都是 paused，谁 resume 谁接管）。
9. **MAJ-6 改动清单补全**：新增 `src/config/setting-specs.ts`（goal.* 进 SETTING_SPECS 白名单
   - 设置编辑器可见）；文档三件套 README.md（中文，`/goal` 章节 + 设置表）、AGENTS.md
     （Repository layout 加 `src/goal/`）、CHANGELOG（Conventional Commits 自动生成，不手改）。
     C7 降级改写为 `try/catch` 包住 `spawnAndWait`（它 throw 而非返回 error）。
10. **保留 verifier（用户已拍板）+ 硬化**：`goal.evalTimeoutMs`（默认 300s，走 `*S` 规约）+
    `budgetOverride` + 闩锁看门狗（评估 in-flight 超时强制解锁并计入连败）；评估超时计入
    `consecutiveEvalFailures`（≥2 → stopped("eval-failures")）。**M-a fallback**：spawn 返回
    unknown agent type 时降级为 `general` 类型 + 内置 evaluator task prompt（仓库内置文案，
    含只读纪律与 schema 提交要求），WARN 一次。

## Minor 处置

- **M-b ask_user**：一期 prompt 级——续跑指令文案明令「goal 运行期间禁止调用 ask_user，
  遇到阻塞把问题写进本轮输出继续推进其他部分」；tool-scope 摘除列为二期选项。
- **M-c 通知/widget/飞书**：verifier run 出现在 fleet widget 属预期（可观测性）；label 统一
  `goal-eval` 前缀便于识别。飞书 completion 卡 defer 喷出风险记录为已知行为，一期不改。
- **M-e 文案语言**：注入模型的续跑指令用中文（对齐仓库用户可见文案惯例），目标原文照引。
- **M-f/M-g**：施工时行号按当前 HEAD 重新定位；abort-emit、agent_end 无 willRetry 等未文档化
  行为登记进 `src/adapters/pi-compat.ts` 假设清单，0.85 回归。
- **M-h**：`maxMinutes` 在评估点检查（无定时器），文档注明滞后一整轮上限；`achieved` 为终态
  记录（见状态机 v4）。
- **Nit 消歧**：`/goal` 参数解析——**单 token** 且精确匹配 `pause|resume|clear|status` 才按
  子命令处理，其余一律视为目标文本。

## 裁剪确认

- O1（删 C4）：采纳（条件 5 已含）。
- O2（砍 verifier）：**不采纳**（用户拍板保留），按条件 10 硬化。
- O3（停滞签名检测）：采纳推迟到二期——evalCount + 成本上限已兜住最坏路径。
- O4（状态机精简）：部分采纳（5→4 状态，`suspended` 折入 rehydrate→paused 强制降级）。
