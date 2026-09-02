# pi-subagent

**中文** | [English](README.en.md)

[pi](https://github.com/earendil-works/pi) 的防卡死 subagent 扩展 —— `@tintinweb/pi-subagents` 核心(`Agent` / `get_subagent_result` / `steer_subagent`)的即插即用替代实现。整个项目围绕一条显式的 run 状态机重建,让卡住的子 agent 始终**可见、可诊断、有硬边界**——绝不无声挂死。

## 为什么

子 agent 的失败方式,"spawn + await" 式的简单封装根本看不见:模型 API 在 turn 中途停滞、工具调用永不返回、session 在 abort 时拒绝退出。pi-subagent 把每个 run 当作带分相 deadline 的状态机:看门狗负责触发,升级阶梯负责物理回收资源——同时把这一切实时流式呈现在编辑器上方的 **agent tree** 里。

## 功能

- **`Agent` 工具** —— 发起有边界的 subagent run:`description`、`prompt`、`subagent_type`,可选 `model` 覆盖(严格 `provider/id` 或模糊 hint,如 `sonnet`、`kimi-k3`,按 pi 可用模型解析)、`run_in_background`、`resume`(续跑已结束的会话)、`isolation: "worktree"`(每个 run 一个 git worktree)、`timeout_ms`、`schema`(结构化输出,经 schema 校验)。
- **`get_subagent_result`** —— 默认非阻塞轮询;`wait: true` + `wait_ms` 为有界阻塞。
- **`steer_subagent`** —— 向运行中的子 agent 发送追加指令。
- **`abort_subagent`** —— 停止运行中的子 agent（包括自动转后台的 run）；对终态 run 幂等返回。
- **前台自动转后台** —— 前台 Agent 调用超过 `foregroundAutoBackgroundS`（默认 10 分钟）会提前返回，run 不会停止，稍后用 `get_subagent_result` 收取结果。
- **bash 自动转后台** —— 覆盖 pi 内置 `bash` 工具:命令跑过 `bashJobs.autoBackgroundS`(默认 120 秒)后调用提前返回 `job_id`,**进程不杀**、输出继续落日志,结束时推送完成通知;用 `bash_job`(status / wait / kill / list)管理,日志本身是普通文件,可以直接 read/tail/grep。仅 POSIX,详见下文。
- **`SubagentWorkflow`** —— 沙箱化 JS 编排(`agent()` / `parallel()` / `pipeline()` / `phase()`),带独立 wall-clock 预算和可回放 journal。默认关闭(`workflow.enabled`)。
- **Agent tree 组件** —— run 活跃期间常驻编辑器上方(见下文)。
- **`@mention` 引导** —— 在编辑器输入 `@<label> <消息>`,可引导运行中的子 agent,或复活已结束的。
- **成本核算** —— 每个 run 的用量汇入 pi 的会话总计;`/agent costs` 查看明细。后台 run 的用量在首次读取终态结果时附加。
- **Agent 类型** —— 从 `.pi/agents/`、`.agents/agents/`、`~/.pi/agent/agents/` 发现 `.md` 定义;注入系统提示词,让模型知道合法的 `subagent_type` 取值。frontmatter `model:` 支持严格 `provider/id` 或模糊 hint(如 `sonnet`)。

## Agent tree

```
● 4 active Agents · $0.92
  后端实现 surface 截断 #6b7201c9 general-purpose cloudrouter-response/gpt-5.6-sol 🔧工具 3m32s $0.91
  TaskUpdate→edit✗→read→edit×3 ▸edit src/core/quota-bucket.ts
  ↳ 并行检索候选实现 #c3d4e5f6 explore 🔧工具 48s
    bash ▸grep monthlyQuota
  前端联调 #d4e5f607 · ♻重试2/3 1m15s
  修订方案:月额度纳入调度 #81ab2a94 Plan droid-completion/kimi-k3 🧠思考 6s $0.0021
  » 调度模块需要支持月额度,我倾向于在 quota-bucket 里加一个 monthly 窗口,然后
✓ 单元测试补齐 #0718293a test completed 40s $0.11
```

- 头部:bullet 取全场最严重的高亮色,活跃数、实时花费、`+N more` 溢出。
- 每个 run 一行主行:标签、`#id`、类型、`provider/id` 模型、人性化相位(`🧠思考` / `🔧工具` / `♻重试2/3` / `⏸排队` / `🗜压缩` / `⏹停止中`)、耗时、费用。嵌套 run 缩进在父级下方(`↳`);进行中的 workflow 渲染为 `⚙` 组头。
- run 处于工具调用或思考中时,追加一行**活动行**:近期工具轨迹(`bash×3→read`)+ 高亮的在途 `▸工具` 及参数预览,或模型流式文本的一行 `»` 尾部。工具调用 vs 模型请求的状态始终准确——包括并行工具调用。
- 高亮:`!` 黄 = 空闲超过 idle 预算一半(可疑地安静);`✗` 红 = 停止中或超过总 deadline。刚结束的 run 暗色驻留几秒。

## 命令

| 命令                    | 内容                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `/agent status`         | 所有非终态 run 的诊断:相位、最近事件、空闲时长、孤儿 session |
| `/agent status <runId>` | 单个 run 的完整工具时间线                                    |
| `/agent costs`          | 按花费降序的逐 run 明细                                      |

## bash 自动转后台

开启后(默认开启,仅 POSIX)本扩展以同名方式覆盖 pi 内置的 `bash` 工具:短命令与内置行为**逐字节一致**——前台路径直接复用 pi 自己的 bash 实现,输出累积、截断、临时文件、`Command exited with code N` 等全部由 pi 的代码产生。只有跑过阈值的命令会改变行为:调用提前返回一个 `job_id`,进程留在自己的进程组里继续跑,stdout/stderr 合流写入日志文件,退出时以 `bash-job:notification` 消息注入完成通知(带输出尾巴,并触发一个新 turn)。命令自带的 `timeout` 参数语义不变,转后台后到期照样杀进程树。

`bash` 工具额外接受 `run_in_background: true`——明知是长命令时立刻转后台,不用等阈值。

`bash_job` 工具管理这些 job(`job_id` 支持唯一前缀):

| 动作     | 内容                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| `status` | 状态摘要(运行中/终态、耗时、pid、日志大小)**+ 日志尾部**(最后 20 行 / 2KB)+ 日志文件路径 |
| `wait`   | 有界阻塞(默认 30s,硬上限 120s);超时正常返回当前状态,不报错                               |
| `kill`   | 终止整个进程组(SIGTERM → 宽限 → SIGKILL);对已结束的 job 幂等,并做 pid 复用防护           |
| `list`   | 列出已知 job(id · 状态 · 命令预览 · 年龄)；只含转过后台的 job                            |

**没有 `output` 动作**:日志就是 `~/.pi/agent/bash-jobs/<job>.log` 这样一个普通文件,模型用 `read` 工具或
`tail`/`grep`/`awk` 直接分析比任何工具参数都灵活(大日志优先 `grep`,不要整读)。`status` 给的尾部只是
"现在在干什么 / 怎么结束的"的快照,完整或定向分析请直接读文件。

设置项(时间字段同样是**整数秒**):

| 键                           | 默认                     | 含义                                                                                        |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `bashJobs.autoBackgroundS`   | `120`                    | 前台 bash 超过该时长后转后台;`0` = 整个功能关闭(覆盖工具都不注册,内置 bash 零变化)          |
| `bashJobs.maxLogBytes`       | `10485760`               | 单个 job 日志上限;写满后停写并标记截断,**进程继续跑**                                       |
| `bashJobs.maxBackgroundJobs` | `8`                      | 并发后台 job 上限;满位时阈值到期也继续前台等待,显式 `run_in_background` 则直接报错          |
| `bashJobs.retentionS`        | `86400`                  | 终态 job 的 JSON/日志保留时长,过期文件由目录清理扫描删除(见下)                              |
| `bashJobs.shutdownPolicy`    | `"keep"`                 | pi 真退出(`quit`)时对仍在跑的 job:`keep` 保留 / `kill` 终止;reload/new/resume/fork 一律保留 |
| `bashJobs.dir`               | `~/.pi/agent/bash-jobs`  | job 状态 JSON 与日志目录(**仅 JSON 文件可配**,不在 `/agent settings` 中)                    |
| `bashJobs.shellPath`         | `$SHELL`(白名单)→ `bash` | 执行命令的 shell;`$SHELL` 仅在 basename ∈ {bash, zsh, sh} 时采用(**仅 JSON 文件可配**)      |

行为说明:

- **win32 不覆盖**:该平台没有进程组语义,内置 `bash` 原样保留,`bash` 与 `bash_job` 都不注册。
- **同名覆盖冲突**:pi 里同名工具"首个注册者胜出"。若另一个扩展也覆盖 `bash` 且先注册,本功能整体失效(不会破坏对方);想禁用本覆盖把 `bashJobs.autoBackgroundS` 设为 `0` 即可。
- **目录清理**:清理扫描在 session 启动时跑一次,之后每次新建 bash job 时**最多每 10 分钟**再跑一次(**不新增任何定时器**,连开几天的会话也会清理)。一次扫描处理四类:过期终态 job 的 JSON+日志;读不出来的 `.json`(文件名非法 / JSON 损坏 / schema 不认)——按**文件 mtime** 计龄,过期连同同名 `.log` 一起删;没有对应 `.json` 的孤儿 `.log`(同样按 mtime,且内存里还挂着该 job 时绝不删);原子写崩溃残留的 `.tmp`(固定 1 小时 TTL)。安全边界:**只碰 `.json` / `.log` / `.tmp` 三种后缀**,目录里其他文件一律不动;**非终态 job 永不删**;文件 mtime 与时钟不可比(例如 mtime 在未来)时一律保留。每删一个非记录类文件都会打一条 WARN。
- **日志与敏感输出**:job 状态与日志默认写在 `~/.pi/agent/bash-jobs/`(权限 0600,与 session 文件同威胁模型)。命令输出里的密钥/令牌会**落盘**,直到 `retentionS` 过期被清理——需要更严的隔离时用 `bashJobs.dir` 指到别处,或把敏感命令的输出重定向掉。
- **日志自洽**:进程进入终态时,日志尾部会追加一行结论,形如
  `[pi-subagent] job b_XXXXXXXX completed (exit 0) after 2m30s`(被杀/超时/丢失退出码的 job 不会硬编出 `exit`)。
  `tail -3 <log>` 即可知道结局,不必再调工具。这一行只写一次,计入日志字节数;即使日志已经写满 `maxLogBytes`
  也照样追加(结论不能被容量策略吞掉,因此文件可能略微超出上限)。
- **重启/reload 后收养**:仍在跑的 job 在下一个 session 里被重新接管并继续通知;pid 归属无法确认(可能被复用)的 job 只标记不杀,`kill` 会明确拒绝。
- 设置改动与其他非 `budget.*` 键一样,`/reload` 后生效。

## 防卡死架构

每个 run 都是一条纯状态机(`src/core/state-machine.ts`),由会话事件驱动:

```
queue_wait → resolve_config → session_create → extension_bind
  → prompt_dispatch → model_turn ⇄ tool_exec (⇄ retry_backoff, compaction)
  → settled        (超时/停止:→ abort_grace → reap → settled)
```

1. **信号**:每个会话事件(文本增量、工具 start/end/update、retry、compaction)都会刷新 `lastEventAt`。空闲 = `now - lastEventAt`——正在流式输出的模型、有心跳的工具永远不算"卡住"。
2. **Deadline**:每个相位挂独立计时器(`dueAtFor`)——启动 30s、首事件 120s、模型 turn 空闲 240s、单工具 600s、压缩 300s、总计 30min(全部可配)。`EventWatchdog` 以 1Hz tick,派发 `deadline_fired`。
3. **升级**:运行中相位超时 → `cancel_signal` + `soft_steer`("wrap up now",给 agent 体面收尾的机会)→ 10s abort 宽限 → 强制 abort。若仍失败,`EscalatingReaper` 逐级爬升 L0 cancel → L1 steer → L2 requestAbort → L3 dispose(强杀进程句柄)→ 仍杀不掉的登记为 **orphan**,绝不遗忘。

重试有独立的 backoff 相位,不会误触 idle 计时器;并行工具调用会让 run 停留在 `tool_exec` 直到**最后一个**兄弟调用结束。

## 配置

用户配置:`~/.pi/agent/pi-subagent.json`(文件缺失/格式错误 → 用默认值,绝不抛错)。

`/agent settings` 直接打开**交互式设置编辑器**(overlay:↑↓ 选择、回车编辑/切换、空格切换布尔、`r` 重置默认、Esc 关闭,改动即时落盘);脚本场景仍可用 `/agent settings list` / `set <key> <value>` / `reset <key>`,`/agent budget` 是限定到 `budget.*` 的别名。

**所有时间字段都以整数秒配置**(键名以 `S` 结尾)。旧版的毫秒键(`*Ms`)在首次加载时自动迁移:能整除 1000 的换算成秒并写回文件 + WARN,不能整除的丢弃并回退默认值(绝不抛错)。

```jsonc
{
  "concurrencyLimit": 6,
  "fleetWidget": true, // 编辑器上方的 agent tree
  "maxNestedDepth": 2, // 子 agent 再 spawn 子 agent 的深度上限
  "foregroundAutoBackgroundS": 600, // 前台调用自动转后台；0 关闭
  "worktree": { "enabled": false },
  "workflow": { "enabled": false },
  "budget": {
    "idleS": 240, // 模型 turn 静默（无任何 delta/事件）多久算超时
    "modelTurnS": 900, // 单轮模型调用硬上限（即使仍在产出）
    "toolS": 600, // 单次工具调用上限
    "totalS": 1800, // 整个 run 的上限
    // … queueWaitS, startupS, bindS, firstEventS, compactionS,
    //   abortGraceS, steerS, reapS, startupRetries, retrySlackS
  },
}
```

## 安装

pi 直接加载 TypeScript 源码（经 jiti），无需构建：

```sh
pi install git:github.com/Newbluecake/pi-subagent
# 更新：
pi update --extension git:github.com/Newbluecake/pi-subagent
```

也可以从 [GitHub Releases](https://github.com/Newbluecake/pi-subagent/releases) 下载 zip（已含编译产物），解压后 `pi install ./pi-subagent`（本地路径方式，不参与 `pi update`）。

## 开发

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest:970+ 测试——状态机迁移矩阵、
                     # 带种子的属性不变量、组件渲染……
npm run typecheck
npm run format
```

版本化 pre-commit hook(对暂存文件跑 prettier):

```sh
git config core.hooksPath .githooks
```

目录结构:`core/` 纯状态机 + deadline(无 I/O)· `runtime/` 看门狗、会话驱动、回收器 · `service/` spawn/query/registry · `tools/` 四个面向 LLM 的工具 · `ui/` agent-tree 视图模型 + 组件(纯函数,可单测)· `workflow/` 沙箱编排器 · `adapters/` 面向 pi 的胶水层。

Node.js ≥ 22(用了 `fs.globSync`)。

## License

MIT
