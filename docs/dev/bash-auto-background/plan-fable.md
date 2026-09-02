# bash auto-background — 实施方案（fable v1）

> 只读调查 + 本文档，不含实现。目标：覆盖 pi 内置 `bash` 工具，命令执行超过阈值后自动
> 转后台——工具调用提前返回 `job_id`，**进程不杀**，输出持续落日志文件；模型用管理工具
> `bash_job` 查状态 / 收增量输出 / 终止进程；进程结束时注入完成通知（triggerTurn）。
> 与 `docs/dev/auto-background/plan.md`（Agent 前台调用 auto-background）语义对齐。

## 0. 核实基线（行号均对照当前 node_modules 内 pi 与本仓库代码复核）

- **同名覆盖**：pi 组装工具表先内置后扩展，同名扩展覆盖内置（pi dist/core/
  agent-session.js:2101-2140；官方示例 examples/extensions/tool-override.ts 明文说明
  "Extensions can register tools with the same name as built-in tools to replace them"）。
  多个扩展同名时**首个注册 wins**——风险见 §11。
- **pi 公开导出**（dist/index.d.ts）：`createBashToolDefinition(cwd, options?)` /
  `createBashTool` / `createLocalBashOperations` / `BashOperations` / `BashToolDetails` /
  `truncateTail` / `formatSize` / `getAgentDir` / `withFileMutationQueue`。
  `createBashToolDefinition` 返回的正是扩展 `registerTool` 所需的
  `ToolDefinition<bashSchema, BashToolDetails|undefined, BashRenderState>`（bash.d.ts:81），
  其 `execute(toolCallId, params, signal, onUpdate, ctx)` 签名与扩展工具**完全一致**
  （extensions/types.d.ts:344-377），`ctx` 需要的字段（`cwd`/`sessionManager`/`model`/
  `thinkingLevel`）都在 `ExtensionContext` 上（types.d.ts:209-249）——**内置 bash 的
  execute/renderCall/renderResult 可被本插件直接复用**。
- **BashOperations.exec 是唯一进程边界**（bash.d.ts:60-72）：
  `exec(command, cwd, { onData, signal, timeout, env }) → { exitCode: number|null }`。
  内置实现 `createLocalShellOperations`（bash.js:38-114）：spawn(detached: 非 win32)、
  stdout/stderr **合流**进同一个 `onData`、`signal` abort → `killProcessTree(pid)`、
  `timeout` 到期 → 杀进程树并 throw `timeout:<s>`、abort → throw `"aborted"`。
  **pid 不经接口暴露**；`getShellConfig`/`killProcessTree`/`trackDetachedChildPid`
  未在包顶层导出（package.json exports 仅 `"."`/`"./rpc-entry"`/`"./client"`，
  深路径 import 会被 exports map 拒绝）→ 自建 spawn 是拿到 pid/pgid 的唯一正路。
- **内置 bash 的结果格式**（bash.js:230-360，短命令兼容性的对照物）：
  - 成功：`{ content: [{type:"text", text: <输出 或 "(no output)"(截断时追加
"\n\n[Showing lines …. Full output: <tmp>]")>}], details: {truncation, fullOutputPath} | undefined }`；
  - 非零退出：**throw** `Error("<输出>\n\nCommand exited with code <N>")`；
  - abort：**throw** `Error("<输出>\n\nCommand aborted")`；
  - timeout 参数到期：**throw** `Error("<输出>\n\nCommand timed out after <s> seconds")`；
  - `exitCode === null`（被信号杀但非 abort/timeout 路径）：按成功格式返回输出。
  - onUpdate：100ms 节流的流式部分结果（content + truncation details）。
- **session_shutdown 有 reason**：`"quit" | "reload" | "new" | "resume" | "fork"`
  （pi extensions/types.d.ts:478-483）——/reload 与真退出可区分，§3.7 的
  shutdown 策略依赖这一点。
- **本仓库既有件**：
  - settings 加载/校验/persist 模式：src/config/settings.ts（`loadSettings` 逐字段容错、
    `persistSettingOverride` dotted-key）；`/agent settings` 白名单
    `SETTING_SPECS`（src/commands/status.ts:116-133）。
  - 通知注入：stack.ts:160-198 `sendFormatted` → `pi.sendMessage({customType:
"subagent:notification", …}, {triggerTurn: true})`。notifier outbox
    （delivery/notifier.ts）的 `DeliveryPayload` 强绑定 `runId:generation`、
    reconcile/coalesce 语义都为 subagent run 设计——**不硬塞**（§5 权衡）。
  - Agent auto-background 的返回协议（src/tools/agent-tool.ts:318-334）：
    relay AbortController + `stopForwarding` 状态门、文案
    "…is still running after <d> and has been moved to the background (run_id: …).
    The run was NOT stopped…"、`details: { runId, background: true, autoBackgrounded: true }`。
  - id 规则：`r_` + 8 位 Crockford（src/core/ids.ts）。
  - 前缀解析：exact → unique prefix → label（src/service/resolve-target.ts:118-137）。
  - fleet-panel 行 marker：`diag.autoBackgroundedAt !== undefined → "⇣后台"`
    （src/ui/fleet-panel.ts:314 附近）；面板强类型 `RunSnapshot`，塞 bash job 需伪造
    snapshot（§7 权衡）。
  - 组装约束：src/index.ts assembly-only + holder 转发；stack.ts 每 session_start 重建、
    上一代组件在下一次 build 顶部 dispose（previousFleetWidget 模式）；模块级禁可变状态；
    定时器必须 `unref()`。
- **插件现无 child_process 依赖**——本功能新增独立进程管理边界 `src/bash/`（§3）。

## 1. 总体架构与调用流程

```
模型调用 bash(command, timeout?, run_in_background?)
  └─ 覆盖工具 createBashOverrideTool (src/tools/bash-tool.ts)
       ① manager.create(command, cwd) → job 记录（b_XXXXXXXX，staged）
       ② relay = new AbortController()；caller signal --状态门--> relay
       ③ inner = pi createBashToolDefinition(ctx.cwd, { operations: jobOps }).execute(
              toolCallId, {command, timeout}, relay.signal, gatedOnUpdate, ctx)
          （jobOps.exec = 本插件自建 spawn：登记 pid/pgid 到 job、tee onData → 日志文件）
       ④ race(inner, 阈值 sleep)
          ├─ inner 先 settle（短命令，绝大多数情况）
          │    → job 落终态并归档；结果/异常原样透传 —— 与内置 bash 逐字节一致
          └─ 阈值先到（或 run_in_background: true）
               → stopForwarding()（此后 caller abort 不再传导，进程不杀）
               → gatedOnUpdate 关门（不再发 partial）
               → job.backgroundedAt = now；inner promise 由 manager 接管
                 （.then/.catch 把内置格式的最终文本落进 job 记录 → JSON 落盘）
               → 工具返回 "moved to background (job_id: …)" + details
模型后续
  └─ bash_job(action: status|output|wait|kill|list, job_id?, …)  (src/tools/bash-job-tool.ts)
进程结束
  └─ manager 轮询/回调发现 job 终态且未通知
       → pi.sendMessage({customType: "bash-job:notification", …}, {triggerTurn: true})
pi /reload 或重启
  └─ buildSessionStack 重建 manager → 扫描 jobs 目录 JSON → pid 存活探测
       → 收养仍在跑的 job / 补发漏掉的完成通知
```

关键不变量（延续本仓库的 zero-hang 哲学）：

- **Z1** 覆盖工具的 execute 永不无限挂：要么 inner settle，要么阈值到期返回 job_id
  （阈值 0 = 功能关，此时根本不注册覆盖，见 §2.6）。
- **Z2** 转后台后进程的生杀只有三个入口：命令自身退出、`timeout` 参数（内置语义保留，
  计时器仍在 inner exec 里活着）、`bash_job kill`。caller signal 不再是入口。
- **Z3** 每个 job 的输出、终态、通知状态都持久化在磁盘 JSON + 日志文件，pi 重启/reload
  后可发现、可收口、不重复通知。

## 2. bash 覆盖工具设计（src/tools/bash-tool.ts）

### 2.1 复用 pi 的 schema / description / renderers

- **不重写 execute 主体**：每次调用现场 `createBashToolDefinition(ctx.cwd, { operations })`
  构造 inner definition（纯闭包，无 IO，逐调用构造开销可忽略；`cwd` 用 `ctx.cwd`
  与内置一致），我方 execute 只做 §1 ④ 的 race 包装。输出累积、截断、temp file、
  "(no output)"、"Command exited with code N" 等**全部由 pi 代码产生**——短命令
  兼容性不是"模仿得像"，而是**同一段代码**（测试 T1 组做 golden 等价断言双保险）。
- **schema**：pi 未导出 `bashSchema`，但 inner definition 实例上有 `.parameters`。
  用 `Type.Composite([inner.parameters, Type.Object({ run_in_background: Type.Optional(
Type.Boolean({description: …})) })])` 派生——`command`/`timeout` 的 description
  自动继承，零漂移。注意本仓库 typebox 依赖是 `@sinclair/typebox`，pi 内部是
  `typebox`（pi alias 到自带模块）；Composite 需用 **inner.parameters 所属的实例**
  能力——稳妥做法：直接手写三字段 `Type.Object`，`command`/`timeout` 的 description
  在测试里与 `inner.parameters.properties.*.description` 做相等断言（编译期解耦、
  测试期防漂移）。二选一在实现时定，方案默认后者（更稳）。
- **description**：取 inner.description 原文（"Execute a bash command … timeout in
  seconds."）**原样保留**，追加一段：
  "If a command runs longer than ~<threshold>, the call returns early with a job_id —
  the process is NOT killed, it keeps running with output captured to a log file; you
  will be notified when it finishes. Manage it with the bash_job tool (status / output /
  wait / kill). Set run_in_background: true to background immediately."
  `promptSnippet`/`promptGuidelines` 同样取自 inner（bash.js 导出的
  bashToolSystemPromptContribution 经 definition 透传）。
- **renderCall**：直接委托 `inner.renderCall`（`$ <command>` + timeout 后缀）。
- **renderResult**：委托 `inner.renderResult`。前台路径 result.details 是 pi 原生
  `BashToolDetails`，渲染完全一致；后台路径我方 details（§2.4）没有
  truncation/fullOutputPath 字段，inner renderer 按普通文本渲染我方文案，安全。
  为区分度可在文案首行带 `⏳→job` 前缀，不另写 renderer（保持 D 最小面）。
- **renderers 的 definition 实例**：renderCall/renderResult 不依赖 operations，
  在工具工厂里用 `createBashToolDefinition(process.cwd())` 建一个**仅供渲染委托**的
  单例（无状态、不 spawn）；execute 内另建绑定 job ops 的实例。

### 2.2 新参数 `run_in_background?: boolean`

需要。理由：与 Agent 工具的 `run_in_background` 对称（模型已被系统提示训练过这一
心智模型）；明知是长命令（`npm run build:all`、数据迁移）时不必白等阈值。语义 =
阈值视为 0：spawn 成功、拿到 pid 后立即走后台返回分支（仍先等 spawn 回调拿 pid，
避免返回一个还没进程的 job）。额外参数对内置 schema 是**纯增量**，不影响兼容。

### 2.3 与内置 bash 的行为兼容保证（关键要求）

| 场景                            | 行为                                                                                                                                                      | 保证方式                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 短命令成功/失败/截断/超时/abort | 与内置逐字节一致（含 throw 的 Error message）                                                                                                             | 前台路径原样透传 inner.execute 的 resolve/reject（§2.1）；T1 组 golden 断言   |
| onUpdate 流式部分结果           | 前台阶段一致（100ms 节流由 inner 实现）；转后台后停发                                                                                                     | gatedOnUpdate 状态门                                                          |
| `timeout` 参数                  | 保留内置"到期杀进程"语义，**转后台后依然生效**（计时器在 inner exec 闭包里）；到期后 job 终态 = timed_out，最终文本 = 内置的 "Command timed out after Ns" | inner 不动                                                                    |
| exitCode 非零                   | 前台：throw（同内置）；后台：job 终态 failed，文本进 job 记录，不再 throw（工具已返回）                                                                   | manager 接管 inner promise 的 rejection（必须 .catch，防 unhandledRejection） |
| PI_* 环境变量注入               | 一致                                                                                                                                                      | inner 的 resolveSpawnContext 原样跑，ctx 透传                                 |

唯一有意的行为差异（CHANGELOG 必须写明）：超阈值不再无限阻塞，改为返回 job_id。

### 2.4 abort signal 语义

照搬 agent-tool.ts:318-334 的 relay + 状态门模式：

```ts
const relay = new AbortController();
let forward = true;
const onAbort = () => {
  if (forward) relay.abort();
};
if (signal?.aborted)
  relay.abort(); // 进入时已 abort：保持内置语义（立即 throw "aborted"）
else signal?.addEventListener("abort", onAbort, { once: true });
const stopForwarding = () => {
  forward = false;
  signal?.removeEventListener("abort", onAbort);
};
```

- 前台阶段 caller abort（用户 Esc）→ relay → inner exec 的 onAbort → 杀进程树 →
  throw "Command aborted"——与内置完全一致。
- 转后台返回前 `stopForwarding()`：此后 turn 结束/abort **不能杀进程**（需求硬性要求）。
- 前台正常终态返回前、异常 rethrow 前也统一 `stopForwarding()`（try/finally 收拢），
  防 listener 泄漏。
- `/reload`：转后台的 job 不持 caller signal，进程自然存活；前台中的调用被 pi abort
  → 同内置行为（杀进程）——可接受且一致。

### 2.5 win32

**v1 不覆盖 win32**：`process.platform === "win32"` 时 index.ts 直接不注册覆盖工具
（内置 bash 原样保留，行为零变化）。理由：detached/pgid 进程组语义缺失、
`killProcessTree` 的 taskkill 版本未导出需自行复刻、pid 存活探测/重用防护在 win32
另一套；本仓库 CI 也只跑 Linux。win32 支持列为后续迭代（§13 开放问题 Q4）。

### 2.6 功能开关

`settings.bashJobs.autoBackgroundMs === 0`（且未来没有别的 bashJobs 子功能依赖）时
**不注册覆盖工具与 bash_job 工具**——关闭态零风险、零行为差异。代价：与其他
settings 一样，改值后 /reload 生效（与 §4/status.ts 既有提示语义一致）。

## 3. BashJobManager / job 模型（src/bash/）

### 3.1 job id

`b_` + 8 位 Crockford（复用 core/ids.ts 的字母表与重试模式，新增
`newJobId(exists?)` / `isJobId`，放 `src/bash/ids.ts`）。前缀 `b_` 与 run 的 `r_`
天然区分，`bash_job` 的解析域与 subagent 的 resolveRun 互不混淆。

### 3.2 状态机

```
staged ──spawn ok──▶ running ──exit 0────────────▶ completed
   │                    │──exit N───────────────▶ failed
   │                    │──timeout 参数到期──────▶ timed_out
   └─spawn error        │──bash_job kill / 前台 abort ▶ killed
      ▶ failed          │──重启后 pid 已死、退出码不可知 ▶ exited_unknown
                        └─重启后 pid 无法安全归属 ────▶ orphaned（只标记，绝不杀）
```

正交标记：`backgroundedAt?: number`（是否转过后台）、`notifiedAt?: number`（完成
通知是否已发）、`outputTruncated: boolean`（日志尺寸截断）。终态集合
`{completed, failed, timed_out, killed, exited_unknown, orphaned}`。转移函数写成
纯函数放 `src/bash/types.ts`，测试矩阵化（对齐 core/state-machine.ts 的测试惯例）。

### 3.3 pid / pgid 与进程终止（src/bash/process.ts）

- 自建 spawn，语义复刻内置 createLocalShellOperations（bash.js:38-114）：
  `spawn(shell, [...args, command], { cwd, detached: true, env, stdio:
["ignore","pipe","pipe"], windowsHide: true })`；POSIX detached → 子进程为
  **进程组组长**，`pgid === pid`。
- shell 解析：`settings.bashJobs.shellPath` → `$SHELL`（仅当 basename ∈
  {bash, zsh, sh}，参数统一 `-c`）→ `"bash"`。与 pi 的 getShellConfig（未导出）
  可能存在 fish/nushell 等奇异 shell 的分歧——文档写明限制；工具名叫 bash，
  以 bash 语义为契约是合理收口。
- 终止（`killJob`）：`process.kill(-pid, "SIGTERM")` → grace（默认 2s，unref timer）
  → 仍存活则 `process.kill(-pid, "SIGKILL")`——对齐 reaper 的 escalate 精神。
  ESRCH 视为已死（幂等）。
- 存活探测：`process.kill(pid, 0)`；EPERM 视为存活。
- **pid 重用防护**：job JSON 记录 `pid`、`spawnedAt`、Linux 下再记
  `/proc/<pid>/stat` 第 22 字段 starttime（best-effort）。重启后收养时：
  starttime 可读则必须匹配；不可读（非 Linux/权限）则退化为
  `kill(pid,0)` 存活 + `spawnedAt` 早于系统 boot 时间合理性检查；**任何不确定
  一律判 orphaned 且绝不 kill**（安全底线：宁可漏管，不可误杀无关进程）。
- 该文件是唯一 `node:child_process` 边界，接口化（`ProcessPort`）供 manager 注入
  fake 做单测。

### 3.4 日志文件布局

```
~/.pi/agent/bash-jobs/               ← getAgentDir() + "bash-jobs"（settings.bashJobs.dir 可覆盖）
  b_XXXXXXXX.json                    ← job 状态（原子写：tmp + rename）
  b_XXXXXXXX.log                     ← stdout+stderr 合流日志
```

- **合流单文件**而非 `.{stdout,stderr}.log` 拆分：内置 bash 的 onData 本就把两个流
  合进同一累积器（bash.js:96-97），工具返回和 bash_job output 的口径都是合流文本；
  拆分反而与结果格式对不上，还让增量读游标复杂化。有意偏离需求提示里的建议布局，
  记录为决策 D3。
- 目录扁平不按 session 分层：job 是 host 级资源（跨 session 收养是需求），JSON 内
  记 `sessionId`/`cwd`/`hostPid` 字段即可过滤展示。多 pi 进程并存：收养仅限
  `hostPid` 已死或等于自身的 job（探测 host 存活同 §3.3）。
- 日志大小上限：manager tee 写入时计数，超 `settings.bashJobs.maxLogBytes`
  （默认 10MB）后停写日志、置 `outputTruncated`、日志尾部追加一行
  `[log truncated at 10MB]`；进程继续跑（上限保护磁盘，不当作杀进程理由）。
  inner 的 OutputAccumulator 自身有行/字节截断 + temp file 机制，维持内置行为不动。
- 终态 job 的 JSON/日志保留 `settings.bashJobs.retentionMs`（默认 24h），manager
  启动扫描时清理过期文件（对齐 tombstone TTL 精神）。

### 3.5 状态持久化：JSON 文件（决策 D4，弃 session custom entry）

| 方案                                         | 优点                                                                                                      | 缺点                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **每 job 一个 JSON 文件（选定）**            | pi 重启/换 session 后仍可发现存活 pid；与日志文件同目录同生命周期；原子 rename 简单可靠；多 host 进程可见 | 需要自己扫描/清理                                                                                                                                         |
| session custom entry（pi-outbox-store 模式） | 复用既有 adapter；随 session 持久                                                                         | **绑死单个 session 文件**——重启后新 session 读不到旧 session 的 entry，跨 session 收养（需求 §3 明点）直接不成立；长日志游标类高频更新会刷爆 session 文件 |

JSON 结构（`src/bash/types.ts` 定义 + `src/bash/job-store.ts` 读写）：

```jsonc
{
  "v": 1,
  "jobId": "b_XXXXXXXX",
  "command": "npm test", // oneLine 截断存 200 字符预览 + 完整 command
  "cwd": "/repo",
  "sessionId": "…",
  "hostPid": 12345,
  "pid": 23456,
  "pgid": 23456,
  "procStartTime": "428899", // §3.3
  "status": "running",
  "createdAt": 0,
  "spawnedAt": 0,
  "backgroundedAt": 0,
  "endedAt": 0,
  "exitCode": null,
  "finalText": "…", // inner.execute 的最终文本/错误文本（截尾 16KB）
  "logPath": "…/b_XXXXXXXX.log",
  "logBytes": 12345,
  "outputTruncated": false,
  "notifiedAt": 0,
  "readCursor": 0, // bash_job output 的增量游标（持久化，重启后不重放全量）
}
```

### 3.6 pi 重启 / reload 后的恢复

manager 每 session 重建（stack.ts，previousBashJobManager dispose 模式）。构造时
`recover()`：

1. 扫描 jobs 目录全部 `*.json`（容错：坏 JSON → WARN + 跳过）。
2. 终态且 `notifiedAt` 未置 → 进补发通知队列（§5）。
3. `running`：hostPid 归属检查 → pid 存活 + 重用防护通过 → **收养**：登记进内存表、
   起存活轮询（见下）；pid 已死 → 状态改 `exited_unknown`（exitCode 不可知，日志在）
   → 补发通知；归属不确定 → `orphaned`（只展示，不 kill、不通知重复）。
4. 过期终态文件按 retentionMs 清理。

同进程 /reload 的特殊性：老 manager 的 inner promise 回调仍活着——**所有写路径只落
盘、不直接调 pi API**。通知走"新 manager 的轮询发现磁盘上的 终态+未通知"单通道
（§5），天然免疫 reload 时序。老 manager `dispose()` 只清计时器（unref 本来就有）、
不杀进程。

存活轮询：manager 内单个 interval（默认 2s，`unref()`），职责：① 收养 job 的
`kill(pid,0)` 探测（同进程 spawn 的 job 有 close 事件不需要）；② 扫描内存表里
终态未通知 → 触发通知回调。无 running 且无待通知 job 时停表，新 job 时再启
（省电，防 `pi -p` wedge——unref 已兜底，双保险）。

### 3.7 孤儿进程清理策略（session_shutdown）

- `reason === "reload" | "new" | "resume" | "fork"`：**一律保留**（进程与 job 记录
  原封不动，新 stack 收养）。
- `reason === "quit"`：按 `settings.bashJobs.shutdownPolicy` 处理，
  **默认 `"keep"`**——转后台的价值就是"长命令跨越等待边界"，quit 时杀掉等于把
  半小时的构建作废；且进程是 detached 组长、日志在磁盘、下次启动可收养，不构成
  不可回收的孤儿（与 subagent 的 in-process run 必须 drain 不同类）。
  `"kill"` 可选：quit 时对所有本 host 的 running job 执行 §3.3 终止序列（best-effort，
  不 await 超过 abortGraceMs）。
- 前台阶段（未转后台）的命令在 quit 时由 caller signal → relay 杀掉，与内置一致，
  不受此策略影响。

### 3.8 并发上限

`settings.bashJobs.maxBackgroundJobs`（默认 8）：阈值到期时若"本 host running 且
backgrounded"的 job 数已达上限，**不转后台**，继续前台等待（打 WARN + 结果文案
提示上限）——宁可退回内置行为也不无限积累失控进程。`run_in_background: true` 超限
则直接 throw 配置类错误（模型可自纠错）。

## 4. 管理工具设计（src/tools/bash-job-tool.ts）

### 4.1 单工具 vs 多工具（决策 D5）

选**单个 `bash_job` 工具 + `action` 参数**。对比 subagent 侧的多工具
（get_subagent_result/steer/abort 各自独立）：那三者参数面差异大（wait/steer text/
reason），且是本插件的核心协议；bash job 的五个动作全是同一实体上的小型 CRUD，
参数高度重合（都是 job_id 打头），拆五个工具徒增工具表噪音（本插件已注册
Agent/get_subagent_result/steer/abort/SubagentWorkflow 五个）。promptSnippet 一行
即可教会模型。

### 4.2 参数 schema（typebox）

```ts
export const BashJobToolParams = Type.Object({
  action: Type.Union(
    [Type.Literal("status"), Type.Literal("output"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")],
    {
      description:
        "status: state summary; output: incremental output since last read; " +
        "wait: block (bounded) until the job exits; kill: terminate the process tree; list: all known jobs.",
    },
  ),
  job_id: Type.Optional(
    Type.String({
      description:
        "Job id returned by a backgrounded bash call; a unique prefix is accepted. Required for every action except list.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "output only: byte offset to read from (default: continue from the last read position; 0 = from the beginning).",
    }),
  ),
  wait_ms: Type.Optional(
    Type.Number({
      description:
        "wait only: max milliseconds to block (default 30000, capped at 120000). Returns the current status on timeout instead of failing.",
    }),
  ),
});
```

### 4.3 行为与返回格式

- **status**：`Bash job b_X ($ npm test): running for 7m32s (pid 23456, log 1.2MB)` /
  终态含 exit code 与耗时。details `{ jobId, status, pid, exitCode, backgrounded,
logPath, logBytes, startedAt, endedAt }`。
- **output**：从 `readCursor`（或显式 offset）读日志文件增量，经 pi 导出的
  `truncateTail`（DEFAULT_MAX_LINES/BYTES 同内置口径）截断后返回；尾注
  `[read bytes 1024-4096 of 4096; job still running]`；job 已终态且增量读尽时附
  `finalText` 的状态行（如 `Command exited with code 1`），并推进持久化游标。
  **不自动 consume/删除 job**——可反复读。
- **wait**：`Promise.race(job 终态事件, wait_ms unref 计时器)`；超时**正常返回**
  当前 status（绝不 throw——Z1 精神），终态则返回同 output 的收口格式。上限
  120s 硬帽，防模型一把梭 wait 出一个新的挂死点。
- **kill**：§3.3 终止序列；幂等——已终态返回 "already finished (completed, exit 0);
  nothing to kill"（对齐 abort_subagent 的 already_terminal 正常返回，不 throw）；
  orphaned job 拒绝："job b_X was orphaned by a previous pi process and cannot be
  safely killed (pid ownership unverified)"。
- **list**：全部未过期 job 一行一个（id · 状态 · 命令预览 · 年龄），空表返回 "no bash jobs"。
- **job_id 解析**（`src/bash/resolve-job.ts` 或 manager 方法）：exact → unique
  prefix；歧义/未知 throw 并附候选列表（格式对齐 resolve-target.ts 的
  `Candidates: [...]` 自纠错文案）。无 label 概念（命令预览已在 list 里承担辨识）。
- renderCall：`bash_job <action> <job_id?>` 单行（Text 组件，仿 abort-tool.ts）。

## 5. 完成通知

- **通道**：`pi.sendMessage({ customType: "bash-job:notification", content, display:
true, details }, { triggerTurn: true })`——与 stack.ts:160-198 的 subagent 通知同
  机制、**不同 customType**（下游 hook/HUD 可区分订阅）。
- **不复用 notifier outbox（决策 D6）**：DeliveryPayload 键型是 `runId:generation`、
  状态机含 staged/finalize/reconcile/ack-suppression，全部围绕"run 有 generation、
  会 retry、caller 可能已 spawnAndWait 拿到结果"设计；bash job 无 generation、无
  caller-ack 语义（转后台后必然无人拿到结果）、跨重启补发靠 job JSON 的
  `notifiedAt` 字段即可实现同等幂等。塞进 outbox 要么污染 DeliveryPayload 类型，
  要么造平行抽象——两头不讨好。v1 用"磁盘状态 + manager 轮询"单通道（§3.6）：
  终态落盘（含 finalText）→ 轮询发现 `endedAt && !notifiedAt` → sendMessage →
  成功后写 `notifiedAt` 落盘。sendMessage throw 则下轮重试（天然 backoff = 轮询间隔）。
- **通知归属**：只由"当前拥有 pi.sendMessage 的 manager"发（host 单例保证唯一），
  跨 session 收养的 job 也在新 session 里补发——模型上下文虽换，job_id 仍可
  `bash_job output` 收口。
- **文案**（与 subagent 通知的 "Subagent …" 前缀区分，格式对齐 delivery/format.ts 风格）：

```
Bash job b_XXXXXXXX ($ npm test) finished: exit 1 after 7m32s.
--- output tail ---
<日志最后 ~10 行 / 1KB>
---
Collect full output with bash_job(action: "output", job_id: "b_XXXXXXXX").
```

details `{ kind: "bash-job", jobId, status, exitCode, durationMs, logPath }`。

- 不做 coalesce/digest（并发 job 上限 8，风暴面远小于 subagent；留作后续需要再接
  coalescer——其 send/settle 接口是通用的，接入成本可控）。

## 6. 配置项（settings.ts `bashJobs` 块）

```ts
export interface BashJobsSettings {
  autoBackgroundMs: number; // 默认 120_000（决议 R2，原为 180_000）；0 = 整个功能关（不注册覆盖）
  maxLogBytes: number; // 默认 10_485_760 (10MB)
  maxBackgroundJobs: number; // 默认 8
  retentionMs: number; // 默认 24h；终态 job 文件清理
  shutdownPolicy: "keep" | "kill"; // 默认 "keep"（§3.7）
  dir?: string; // 默认 getAgentDir()/bash-jobs
  shellPath?: string; // 默认 $SHELL 白名单 → bash（§3.3）
}
```

- **autoBackgroundMs 默认 120s（2 分钟，决议 R2），有意短于 Agent 的 600s**。理由：
  ① Agent run 的产出是"终态结果"，提前打断只能拿到 run_id，600s 给足单任务完成
  机会；bash 转后台**零损失**——进程照跑、输出照收、通知照来，阈值收益单调，
  只需长过"绝大多数交互式命令"（构建/测试常在 3min 内，超过的恰是该后台化的）。
  ② 一次 10 分钟的工具级阻塞对 TUI 用户是明显更糟的体验（bash 调用频率远高于
  Agent）。③ Claude Code 同类特性的 bash 阈值同量级（~2-3min）。
- 校验：全部走 loadSettings 逐字段容错模式（number/finite/≥0，enum 白名单，
  非法回落默认）；`parseBashJobsSettings` 仿 parseWorkflowSettings。
- `/agent settings` 暴露（status.ts SETTING_SPECS 增量）：
  `bashJobs.autoBackgroundMs: MS`、`bashJobs.maxLogBytes: {number,min:0}`、
  `bashJobs.maxBackgroundJobs: COUNT`、`bashJobs.retentionMs: MS`、
  `bashJobs.shutdownPolicy: 新增 enum SettingSpec（或先不暴露，改 JSON 文件）`——
  v1 暴露前四个数值项 + shutdownPolicy 用 enum spec（SettingSpec 需加
  `{ kind: "enum", values }` 小扩展，改动局部）。生效时机：与既有非 budget key
  一致——persist 后 /reload 生效，status.ts 既有提示语覆盖，不另造热更新。

## 7. UI

- **fleet widget：v1 不纳入（决策 D7）**。fleet-panel/FleetWidgetController 全链路
  强类型 `RunSnapshot`（phase/deadlines/diag/usage），bash job 塞进去要伪造 run
  语义（没有 turn/model/cost/watchdog phase），行渲染与 usage 广播全要特判；收益
  只是"多一行 ⇣"。widget 的存在性判断（有无 active run）也会被 job 干扰。
- **`/agent status` 展示 bash jobs：纳入**。status.ts 文本诊断加一节：

```
bash jobs (2 running, 1 finished unread):
  b_3F7K2M9P  running 12m  $ npm run build:all   (log 3.4MB)
  b_8Q1RN4ZC  exit 0  2m   $ pytest -x           (unnotified)
```

数据来自 holder 转发的 `bashJobs.list()`；零 job 时整节隐藏。`/agent status
  <b_前缀>` 直接展示单 job 详情（resolve 前缀，与 run id 分流用 `b_`/`r_` 前缀判别）。

- 转后台瞬间的用户可见性：覆盖工具返回文案本身在 TUI 渲染即是提示；完成通知
  display: true。够用，不加 widget。

## 8. 与 Agent auto-background 的语义一致性

| 维度            | Agent（既有）                                                                                                                                     | bash（本方案）                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 返回文案骨架    | `Subagent "X" is still running after <d> and has been moved to the background (run_id: …). The run was NOT stopped — … collect … steer … abort …` | `Bash command is still running after <d> and has been moved to the background (job_id: …). The process was NOT killed — it keeps running with output captured to a log; you will be notified when it finishes. Check bash_job(action:"status"/"output"), stop it with bash_job(action:"kill").` |
| details         | `{ runId, background: true, autoBackgrounded: true }`                                                                                             | `{ jobId, background: true, autoBackgrounded: true, pid, logPath }`                                                                                                                                                                                                                             |
| 显式后台参数    | `run_in_background: true` → `{ runId, background: true }`                                                                                         | `run_in_background: true` → `{ jobId, background: true }`（无 autoBackgrounded）                                                                                                                                                                                                                |
| 通知 customType | `subagent:notification`                                                                                                                           | `bash-job:notification`                                                                                                                                                                                                                                                                         |
| 阈值配置        | `foregroundAutoBackgroundMs`（600s）                                                                                                              | `bashJobs.autoBackgroundMs`（120s，决议 R2）                                                                                                                                                                                                                                                    |
| 系统提示协议    | agent-types.ts "Tool protocol" 行                                                                                                                 | bash 工具 description 追加段（§2.1）；不动 agent-types.ts                                                                                                                                                                                                                                       |

`formatDuration` 复用 ui/fleet-panel.ts 导出，措辞用词（"moved to the background" /
"NOT stopped|killed" / "you will be notified"）刻意同构，降低模型学习成本。

## 9. 文件清单

### 新增

| 文件                                          | 职责                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bash/types.ts`                           | JobId/JobStatus/JobRecord 类型、终态集合、状态转移纯函数、JSON schema 版本                                                                                             |
| `src/bash/ids.ts`                             | `newJobId` / `isJobId`（`b_` + Crockford8，仿 core/ids.ts）                                                                                                            |
| `src/bash/job-store.ts`                       | JSON 落盘（tmp+rename 原子写）、目录扫描、坏文件容错、retention 清理                                                                                                   |
| `src/bash/process.ts`                         | `ProcessPort`：spawn(detached)/kill 序列(TERM→grace→KILL)/存活探测/pid 重用防护/shell 解析。唯一 child_process 边界                                                    |
| `src/bash/manager.ts`                         | `BashJobManager`：create/adopt/list/get/resolve(prefix)/readOutput(cursor)/kill/waitExit/notify 轮询/log tee+cap/dispose。依赖注入 clock+ProcessPort+store+notify 回调 |
| `src/tools/bash-tool.ts`                      | 覆盖工具：包装 `createBashToolDefinition`，race+relay+状态门、后台返回、renderers 委托（§2）                                                                           |
| `src/tools/bash-job-tool.ts`                  | `bash_job` 管理工具（§4）                                                                                                                                              |
| `docs/dev/bash-auto-background/plan-fable.md` | 本文档                                                                                                                                                                 |

### 修改

| 文件                         | 改动                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/settings.ts`     | `BashJobsSettings` + DEFAULT + `parseBashJobsSettings`（仿 workflow 块）                                                                                                |
| `src/stack.ts`               | 构造/收养 `BashJobManager`（previousBashJobManager dispose 模式）；notify 回调接 `pi.sendMessage`；`Stack` 增 `bashJobs`                                                |
| `src/index.ts`               | 组装：非 win32 且 autoBackgroundMs>0 时注册 bash 覆盖 + bash_job（holder 转发 `forwardBashJobs`）；session_shutdown 按 reason+policy 收尾（§3.7）。仅接线，无逻辑（I7） |
| `src/commands/status.ts`     | SETTING_SPECS 增 bashJobs.*（含 enum spec 小扩展）；status 文本加 bash jobs 节；`b_` 前缀详情分流                                                                       |
| `README.md` / `README.en.md` | 工具表、settings 表、行为说明                                                                                                                                           |
| `CHANGELOG.md`               | feat 行为变化：bash 超阈值自动转后台                                                                                                                                    |

### 测试（tests/ 镜像 src/）

| 文件                                             | 内容                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/bash/ids.test.ts`                         | 格式/唯一性重试/isJobId                                                                                                                                                                                                                   |
| `tests/bash/types.test.ts`                       | 状态转移矩阵（合法/非法转移全枚举）                                                                                                                                                                                                       |
| `tests/bash/job-store.test.ts`                   | mkdtemp：写读回环、原子性（无半写）、坏 JSON 容错、retention 清理、readCursor 持久化                                                                                                                                                      |
| `tests/bash/process.test.ts`                     | 真实子进程（POSIX guard）：spawn+exit code、进程组 kill（子孙一起死）、ESRCH 幂等、存活探测、shell 白名单回落                                                                                                                             |
| `tests/bash/manager.test.ts`                     | FakeClock+fake ProcessPort：create/终态落盘、log tee+10MB 截断、readOutput 游标、maxBackgroundJobs 上限、notify 轮询（一次且仅一次、失败重试）、dispose 不杀进程、recover 收养/exited_unknown/orphaned 三分支、hostPid 归属、补发通知幂等 |
| `tests/tools/bash-tool.test.ts`                  | 见 §10 T1-T9                                                                                                                                                                                                                              |
| `tests/tools/bash-job-tool.test.ts`              | 见 §10 T10-T16                                                                                                                                                                                                                            |
| `tests/tools/model-facing-strings.test.ts`       | 追加：两工具 description 无内部术语、schema 描述与 inner 一致性断言                                                                                                                                                                       |
| `tests/config/bash-jobs-settings.test.ts`        | 解析默认/0/NaN/负数/enum 非法回落                                                                                                                                                                                                         |
| `tests/commands/status.test.ts`                  | 追加：settings set bashJobs.autoBackgroundMs、status 的 bash jobs 节                                                                                                                                                                      |
| `tests/integration/bash-auto-background.test.ts` | 真实组件全链路（§10 I 组）                                                                                                                                                                                                                |

### 测试用例矩阵（核心）

- **T1 兼容 golden**：同一 fake ops 分别喂内置 definition 与覆盖工具（阈值放极大），
  断言 成功/非零 exit throw 文本/截断 footer/abort throw/timeout throw/(no output)
  六种结果**深度相等**。
- **T2 阈值降级**：fake timers + 永不 settle 的 fake exec → advance 过 120s →
  返回文案含 job_id/"NOT killed"/bash_job 三动作；details `{jobId, background:true,
autoBackgrounded:true}`；此后 gatedOnUpdate 不再发。
- **T3 降级后 caller abort**：abort 原 signal → fake exec 的 signal 未 aborted、
  进程未 kill（状态门生效）。**T4** 降级前 abort → 传导、throw "Command aborted"
  与内置一致。**T5** 进入时已 aborted → 立即 throw（同内置）。**T6** 正常返回后
  abort 无传导（listener 摘除）。
- **T7** `run_in_background: true` → 拿到 pid 后立即后台返回；超 maxBackgroundJobs
  → throw 配置错误。**T8** 阈值到期但后台位满 → 继续前台等待。
- **T9** 降级后 inner reject（非零 exit）→ 无 unhandledRejection（vitest
  process.on 捕获断言），job.finalText 含 "Command exited with code"。
- **T10-T16 bash_job**：status 各态文案；output 游标增量/显式 offset/终态收口附
  finalText/游标持久化；wait 超时正常返回+120s 硬帽+终态即返；kill 幂等/
  orphaned 拒绝；list 空表/多 job；前缀解析 exact/unique/歧义 throw 候选/未知 throw。
- **I1 全链路（真实 bash，POSIX guard）**：阈值 200ms + `sleep 1; echo done` →
  降级返回 → 轮询通知 sendMessage 一次（triggerTurn）→ bash_job output 读到
  "done"。**I2 kill 链路**：`sleep 60 &` 的进程组被整组杀、job=killed。
  **I3 重启恢复**：manager A 建 job（长 sleep）→ dispose A → 同目录建 manager B →
  收养 running；kill 后 B 通知一次。**I4 exited_unknown**：伪造 JSON（running+死 pid）
  → recover → exited_unknown + 补发通知。**I5 短命令走真实内置格式**：
  `echo hi` 结果与真内置工具输出全等（真 golden）。

## 10.（并入 §9 测试矩阵，编号沿用）

## 11. 风险与边界

| 风险                                                        | 处理                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 其他扩展也覆盖 bash（首个注册 wins，本插件可能被抢先/抢后） | 无程序化仲裁手段。README 写明冲突语义 + `/agent status` 提示（可检测：pi 无查询 API，v1 仅文档）；被抢先时本功能整体失效但不破坏对方       |
| pi 升级改变 bash 结果格式/definition 签名                   | 我方前台路径是透传，格式随 pi 自动跟进；`createBashToolDefinition` 签名进 adapters/pi-compat.ts 的探测清单（peer range >=0.84 <0.86 已钉） |
| 日志膨胀                                                    | maxLogBytes 硬帽 + retentionMs 清理 + inner 自身截断不动（§3.4）                                                                           |
| 长进程跨 session/重启                                       | JSON+pid 重用防护收养；不确定判 orphaned 决不误杀（§3.3/§3.6）                                                                             |
| 误杀无关进程（pid 重用）                                    | starttime 校验，读不到则拒绝 kill（orphaned）；kill 只对 pgid==pid 的自建组长                                                              |
| 并发 job 失控                                               | maxBackgroundJobs=8，超限退回前台等待/显式后台报错（§3.8）                                                                                 |
| unhandledRejection（后台 inner throw）                      | manager 接管处强制 .catch → job.failed；T9 断言                                                                                            |
| /reload 后老闭包乱发通知                                    | 写路径只落盘、通知单通道走新 manager 轮询（§3.6）                                                                                          |
| `pi -p` 挂死                                                | 所有 interval/timeout unref + 空闲停表                                                                                                     |
| shell 解析与 pi 不一致（fish/nushell 用户）                 | bash 语义为契约，白名单回落 bash；README 限制说明 + shellPath 覆盖                                                                         |
| 敏感输出落盘                                                | 日志在 `~/.pi/agent`（与 session 文件同威胁模型）；retention 自动清理；README 提示                                                         |
| timeout 参数与阈值交互                                      | timeout 计时器在 inner 存活，后台照杀照记 timed_out（§2.3），无双杀（kill 幂等）                                                           |

## 12. 实施步骤拆解（可独立验收，标注依赖与文件域）

| #   | 任务                                                        | 文件域                                                                                           | 依赖                               | 验收                                                  |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------- |
| S1  | settings：BashJobsSettings + 解析 + SETTING_SPECS           | src/config/settings.ts, src/commands/status.ts(仅 SPECS 段), tests/config, tests/commands        | 无                                 | 解析测试绿；`/agent settings set bashJobs.*` 可持久化 |
| S2  | bash 核心域：types/ids/job-store                            | src/bash/{types,ids,job-store}.ts + tests/bash 同名                                              | 无                                 | 状态矩阵/落盘回环测试绿                               |
| S3  | 进程边界：process.ts                                        | src/bash/process.ts + tests/bash/process.test.ts                                                 | S2(types)                          | 真子进程组 kill/探测测试绿（POSIX）                   |
| S4  | BashJobManager（含 recover/通知轮询/log cap）               | src/bash/manager.ts + tests/bash/manager.test.ts                                                 | S2, S3                             | manager 全用例绿（fake port）                         |
| S5  | 覆盖工具 bash-tool                                          | src/tools/bash-tool.ts + tests/tools/bash-tool.test.ts                                           | S4                                 | T1 golden + T2-T9 绿                                  |
| S6  | 管理工具 bash-job-tool                                      | src/tools/bash-job-tool.ts + tests/tools/bash-job-tool.test.ts                                   | S4（与 S5 **并行**，文件域零交叉） | T10-T16 绿                                            |
| S7  | 组装与通知接线：stack/index + shutdown 策略 + status 展示节 | src/stack.ts, src/index.ts, src/commands/status.ts(展示段)                                       | S1, S4, S5, S6                     | typecheck 绿；/reload 手测收养                        |
| S8  | 集成测试 + 文档                                             | tests/integration/bash-auto-background.test.ts, README*, CHANGELOG.md, model-facing-strings 增补 | S7                                 | I1-I5 绿；npm test/typecheck/format/build 全绿        |

并行建议：S1 ∥ S2 → S3 → S4 → (S5 ∥ S6) → S7 → S8。文件域交叉点仅
`src/commands/status.ts`（S1 改 SPECS 常量段、S7 改 handler 展示段，段落不重叠，
仍建议串行合并或由同一人做）。

## 13. 开放问题 → 决议记录（2026-09-02 用户拍板，HARD GATE 已过）

- **R1 基线方案**：以本方案（fable-5）为实施基线；吸收 k3 方案（plan.md）的风险表
  与 `maxBackgroundJobs` 并发上限细节（本方案 §3.8 已含同等设计）。
- **R2 阈值默认 120s**（原 Q2：本方案 180s → 改为 120s；k3 同值）。
- **R3 `run_in_background` 参数：加**（原 Q 未列，k3 开放问题①；本方案 §2.2 已含，确认保留）。
- **R4 功能默认开启**（原 Q3）：`autoBackgroundMs` 默认 120_000 即开；同名覆盖风险由
  T1 golden 等价测试 + README 冲突说明兜底。
- **R5 shutdownPolicy 默认 `"keep"`**（原 Q1，维持 §3.7）。
- **R6 win32：v1 不覆盖**，不注册覆盖工具（原 Q4，维持 §2.5；路线图后续再议）。
- **R7 schema 派生：手写三字段 + 测试防漂移**（原 Q5 默认项）。

## 14. 产品决策收敛（用户拍板，实施后追记）

实测反馈:日志本来就是普通文件,模型用 `read`/`tail`/`grep`/`awk` 直接分析比任何工具参数都灵活;
只教模型用 `bash_job output` 等于用话术锁住模型能力。据此收敛三项:

- **A 明确授权直读日志文件**:`formatAutoBackgroundText` / `formatExplicitBackgroundText` /
  bash description 追加段 / `bash_job` 的 description 与 promptSnippet / 完成通知
  (`formatBashJobNotification`) / `/agent status <b_…>` 一律写清"日志是普通文件,可用 read 工具或
  tail/grep/awk 直接分析,大日志优先 grep"。路径在每条文案里只出现一次。
- **B 日志自洽(终态页脚)**:`BashJobManager.finalizeLocal` 在**关流之前**向日志尾部追加一行
  `[pi-subagent] job <id> <describeJobStatus 口径> after <duration>`。幂等(`LocalHandle.footerWritten`)、
  计入 `logBytes`、即使已达 `maxLogBytes` 也照写(有意略微超限:结论不能被容量策略吞掉)。
  `describeJobStatus` 因此下沉到 `src/bash/types.ts`(工具层再导出),保证工具文案与日志页脚同一口径。
- **C `output` 合并进 `status`**:删除 `output` 动作与 `offset` 参数,`status` = 状态摘要 + 日志尾部
  (`STATUS_TAIL_LINES=20` / `STATUS_TAIL_BYTES=2048`,经 pi 的 `truncateTail` 收窄)+ 日志路径指引。
  `wait` / `kill` / `list` 不变(`kill` 明确保留:它承载 pid 复用防护与进程组安全校验,是安全不变量)。
  `manager.readOutput` 保留(status 复用其 flush 等待与截断逻辑),但工具侧一律 `advanceCursor: false`;
  `JobRecord.readCursor` 字段保留(磁盘 schema 兼容,`v` 不变),仅供内部/未来使用。
