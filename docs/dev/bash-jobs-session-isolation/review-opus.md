# 评审：bash 后台任务存储按 session 隔离（plan.md）

> 评审对象：`docs/dev/bash-jobs-session-isolation/plan.md`（215 行）
> 评审方式：逐条核对方案引用的代码事实（读源码，不信方案文本），再按 GC 安全性 / 迁移竞态 /
> 隔离有效性 / recover 语义 / 配置 breaking / 测试充分性六个角度找漏洞。
> 结论见文末。

---

## 0. 事实核对（方案 §0 的 F1–F14）

| #   | 判定                          | 说明                                                                                                                                                                                                                                                                       |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | ✅                            | `src/stack.ts:153-159` 与描述一致（try/catch + `?? ""`）。                                                                                                                                                                                                                 |
| F2  | ✅                            | `session-manager.js:12-14`（`uuidv7()`）、`:720-722`（`getSessionId`）。补充：字段默认值是 `sessionId = ""`（`:587`），所以"空 id"在类型上是可达的。                                                                                                                       |
| F3  | ✅                            | `:634` `this.sessionId = header?.id ?? createSessionId()`；resume 复用 id 属实。                                                                                                                                                                                           |
| F4  | ✅ 但**方案对它的使用是错的** | `createBranchedSession` `:1097` / `newSession` `:651` / `forkFrom` `:1256` 都换新 id。方案只写了一句"符合隔离直觉"，没意识到这条会打破一条已文档化的既有契约（见 🔴-6）。                                                                                                  |
| F5  | ✅                            | `assertValidSessionId` `:15-20` 正则与方案一致。补充：该正则**不限长度**，且允许大小写混用（见 🟡-7 / 🟡-8）。                                                                                                                                                             |
| F6  | ⚠️ 部分                       | stack 确实每次 `session_start` 重建（`src/index.ts:209-222`），但 `session_start` 的 reason 有 `startup/reload/resume/new/fork` 五种（`dist/core/agent-session.js:2230`、`dist/core/agent-session-runtime.js:141/165/211/229/246/283`）。方案只推演了 reload/resume 两种。 |
| F7  | ✅                            | `src/stack.ts:167-212`（`dir` 在 :170、`sessionId` :182、`hostPid` :183）、call site `:525`。                                                                                                                                                                              |
| F8  | ✅                            | `job-store.ts:91-92`（`recordPath`/`logPath`）、`:140`/`:223`（两处单层 `readdir`）、`:253` 附近的 terminal+`endedAt ?? createdAt` 规则、`TMP_RETENTION_MS = 3_600_000`（`:86`）。                                                                                         |
| F9  | ✅                            | `manager.ts:785-855`，分支顺序与方案描述一致。注意 `putRecord(record)` 发生在 foreign 判定**之前**（`:806`/`:813`）——这正是本次要修的泄露成因：foreign 记录会进 `entries`，因而出现在 `list()`。                                                                           |
| F10 | ✅                            | `src/stack.ts:578-590`，fire-and-forget + WARN + `finally` 刷新 widget。                                                                                                                                                                                                   |
| F11 | ✅                            | `types.ts:87`；`parseJobRecord` 对 `sessionId` 缺省 `""`。                                                                                                                                                                                                                 |
| F12 | ✅                            | `src/index.ts:235-241` 注释 + `killBashJobsBounded`。                                                                                                                                                                                                                      |
| F13 | ✅                            | `bash-job-tool.ts:253-263` 描述，`list (all known jobs)` 属实。                                                                                                                                                                                                            |
| F14 | ✅                            | `settings.ts:72`、`setting-specs.ts:172`。                                                                                                                                                                                                                                 |

**方案里另有一处硬性事实错误**（不在 F 表中，藏在 §3.1 伪代码注释里）：

> 「manager 读日志走 `store.logPath(jobId)`（job-store.ts:92），记录里的 `logPath` 字段仅用于通知展示(details.logPath)」

**错。** `readOutput` 读的是**持久化字段** `record.logPath`：`manager.ts:686`（`fileSize(record.logPath)`）、
`:693`（`open(record.logPath, "r")`）；`bash_job` 给模型展示的路径也是 `record.logPath`
（`bash-job-tool.ts:151/224/319/339/348`）。`store.logPath(jobId)` 只在 `create()`（`:577`）和
`store.remove()`（`job-store.ts:174`）里用。后果：

- 迁移时重写 `logPath` **不是"顺手"，而是必须**，且顺序必须正确（见 🔴-5 修法）；
- 顺带暴露一个既有不一致：`store.remove()` 按**计算路径**删日志，而读走**记录字段**。迁移后若两者不同步，
  会出现"记录删了、日志文件泄留"或"记录在新目录、`readOutput` ENOENT"。方案基于错误前提把这一步降级成
  "决策：顺手重写"，实施者很可能把它当优化删掉。

---

## 🔴 必须修复

### 🔴-1 GC 只探 `hostPid`，不探 job 自己的子进程 → 会删掉仍在运行的 job 的记录与日志

**问题**：§1.3/§3.2 的跳过条件是「存在非 terminal 且 `hostPid` 活着的记录」。可是"host 死、job 还活着"
恰恰是本项目专门设计过的 **adopted** 场景（`manager.ts:817-826`：`checkPidOwnership(record) === "alive"` → 收养）。
GC 对这一类目录的判定是「无活 host」→ 只看 age → 整目录 `rm -rf`，**把一个正在运行的进程的记录和日志一起删掉**。

**方案的第二道保护（目录 mtime）在这个场景恰好失效**：`running` 记录**不周期落盘**——
`manager.ts:509` 明确写「(it would thrash the JSON file), so only this edge persists eagerly」，
磁盘写只发生在 `staged`（`:591`）、`running`（`:623`）和终态（`:562`）三处；而**向日志文件 append 不会更新目录 mtime**
（目录 mtime 只随条目创建/删除/改名变化）。所以一个跑了 30 小时的 `npm run build` / 训练脚本 / 服务进程，
其目录 mtime 就是 spawn 时刻，`createdAt` 同理 → 24h retention 一到就被判定"过期"。

**依据**：`src/bash/manager.ts:509`、`:562`、`:591`、`:623`；`src/bash/job-store.ts:111-123`；
`manager.ts:817-826`（adopted 分支存在的意义）。

**修法**：非终态记录的活性判定必须用 `processPort.checkPidOwnership(record)`（`process.ts:216-230`）而不是
`probePid(record.hostPid)`：`"alive"` 或 `"unsafe"` 一律不删（I-c「identity doubt never kills」的同构版本——
identity doubt 也不该删数据）。只有「目录内全部记录都是 terminal 且全部过期」才允许删。

### 🔴-2 GC 没有"这目录是不是我们的"判据 + 递归删除 → 显式 `dir` 语义变更后可递归删掉用户无关目录

**问题**：`reconcileRootDir` 对 root 下**任意** `isDirectory()` 的兄弟项调用 `gcSiblingDir`，而
`gcSiblingDir` 对"里面没有任何 `b_*.json`"的目录得到 `records = []` → `newest = max(default 0, dir mtime) = dir mtime`
→ 只要 mtime 够老就 `rm(recursive: true, force: true)`。目录名不校验、目录内容不校验、非 job 文件不豁免。

这与本功能既有的、写进 README 的安全边界正面冲突：
README:87「安全边界：**只碰 `.json` / `.log` / `.tmp` 三种后缀**，目录里其他文件一律不动」，
以及 `job-store.ts:206-212` 的同款注释。方案把 `dir` 从"最终目录"改成"root"（§1.4）之后，
风险面直接放大到用户自选目录——而 README:89 正好在**建议**用户「需要更严的隔离时用 `bashJobs.dir` 指到别处」。
一个把 `dir` 指到 `~/logs`、`/tmp/work`、`~/.pi/agent` 的用户，升级后会看到无关子目录被递归删除。

**依据**：plan §3.1 `gcSiblingDir` 伪代码；`README.md:87`、`README.md:89`；`job-store.ts:206-212`。

**修法（三条都要）**：

1. 目录名白名单：只 GC 匹配 `VALID_ID_RE` 的目录名或字面量 `_unscoped`，其余一律跳过；
2. 内容白名单：目录内若存在**任何** `b_*.json|.log|.tmp` 之外的条目 → 跳过 + WARN 一次（"refusing to GC a directory that is not ours"）；
3. 删除方式：逐文件 `unlink` 已判定过期的 `.json/.log/.tmp`，最后 `rmdir`（**非递归**，非空自然失败）。
   这样爆炸半径与 `job-store.pruneExpired` 完全一致，README:87 那条承诺继续成立。

### 🔴-3 GC 不尊重 `retentionMs <= 0`（"关闭清理"）→ 该配置下秒删所有兄弟目录

**问题**：`job-store` 的语义是 `retentionMs > 0` 才清理（`job-store.ts:236` `retentionEnabled`，接口注释 `:22`
「`<= 0` disables pruning」）。方案的 GC 只写 `now - newest > retentionMs`：当 `retentionMs = 0` 时，
任何过去时刻都满足 → **所有兄弟目录立刻被删**，包括正在被别的活会话使用的目录（只要它当前没有非终态 job）。

顺带暴露一处既有注释冲突：`settings.ts:68` 写「0 = prune immediately」，`job-store.ts:22` 写「`<=0` disables」，
README:81 的 `retentionS` 行也含糊。方案原封不动地继承了这个歧义。

**依据**：`src/bash/job-store.ts:22`、`:236`；`src/config/settings.ts:68`。

**修法**：`retentionMs <= 0` → `reconcileRootDir` 直接 return（GC 关闭；迁移可保留）。同时在本次改动里把
`settings.ts:68` 与 README 的措辞统一到 job-store 的真实语义。

### 🔴-4 删掉/搬走"别人还在用"的记录会触发通知风暴（每 2 秒一条 + `triggerTurn`）

**问题**（🔴-1/2/3/5 的后果放大器）：`deliverNotice` 成功推送后用 `applyPatch` 写 `notifiedAt`
（`manager.ts:425-430`）；`applyPatch` → `store.update` → `readRecord`，**记录在磁盘上不存在时返回 `undefined`**
（`job-store.ts:164-166`），于是内存里的 `entry.record.notifiedAt` 永远是 `undefined`。
而 `shouldNotifyJob` 判的是**内存记录**（`manager.ts:215-217` + `deliverNotice(entry.record)`），
`hasWork()` 也因此永远为真 → poll 每 `DEFAULT_NOTIFY_POLL_MS = 2000` ms 就**重复发一条**
`pi.sendMessage(..., { triggerTurn: true })`（`stack.ts:186-211`）。

也就是说：只要 GC 或迁移动了某个**活着的进程正在管理**的记录，那个进程就会开始每 2 秒刷一条通知并反复触发 turn。
从"丢数据"升级为"刷屏 + 烧 token"。

**依据**：`manager.ts:215-217`、`:363-372`（`hasWork`）、`:412-431`、`job-store.ts:164-166`、`stack.ts:186-211`。

**修法**：两处都要改。

1. 本方案范围内：GC/迁移绝不动"可能有活主"的记录（🔴-1/🔴-5 的修法）；
2. 防御性（建议纳入本方案，代价极低）：`deliverNotice` 在 `applyPatch` 返回 `undefined` 时，
   把内存记录标记为已通知（或 `entries.delete`），让"记录被外部删除"退化为"通知一次后收敛"而不是无限重发。
   顺带给 `session-dirs.ts` 的测试提供一个可断言的不变量。

### 🔴-5 迁移会搬走"活着的旧版 pi"的**终态**记录，且没有防重入/防覆盖

**问题**：§1.7 / §3.1 的 hostPid 活性判定只加在 `!isTerminal(record.status)` 分支上，终态记录**无条件**搬走。
方案自辩「其 terminal 记录被迁走对旧版无害（旧版只会 prune 它们）」——不成立：

1. 旧进程内存里仍有这条 entry。`bash_job status/output` 读 `record.logPath`（`manager.ts:686/693`）——
   如果迁移重写了 `logPath` 它读新路径（此时数据还在，勉强能读）；如果只 `rename` 不重写，它读旧路径 → ENOENT；
2. 若该 job 还没通知（终态 + `backgroundedAt` + 无 `notifiedAt`，即最常见的"刚跑完"状态），
   旧进程写 `notifiedAt` 失败 → 直接进 🔴-4 的通知风暴；
3. **双写/覆盖**：旧进程随后任何一次 `applyPatch/applyTransition` 都会用 `writeAtomic` 把 flat json
   **重新写回根目录**（`job-store.ts:111-123`，路径是构造时注入的 root）。于是同一个 jobId 在
   `root/b_x.json` 和 `root/<sid>/b_x.json` 两处并存、内容分叉；下次启动再迁移时 `rename` 直接**覆盖**目标，
   谁新谁旧完全取决于时序。若该 sessionId 恰是当前 session，新版这一侧还会把"缺 `notifiedAt` 的快照"
   收进 `entries` → **同一个 job 通知两次**（一次旧进程、一次新进程）。
4. `hostPid === process.pid` 就认为"是自己的"也不严谨：旧进程退出后 pid 被回收给新进程时，
   会把一个陌生 host 的活 job 判成自己的（记录里有 `procStartTime` 可以判 job 的子进程，但没有任何字段能判 host 的身份）。

**依据**：`src/bash/job-store.ts:111-123`、`:164-166`；`src/bash/manager.ts:354-360`、`:686/693`；plan §1.7 第 1/2 条。

**修法**：

- 活性判定**不分状态**：任何记录只要 `hostPid > 0 && hostPid !== me && probePid(hostPid)` → 跳过（终态也跳过）；
- `hostPid === me` 的记录也跳过（本进程的 store 已经指向 session 目录，根目录里不会有自己的新记录；
  真出现就是 pid 回收，跳过最安全）；
- 目标已存在 → 不覆盖：跳过 + WARN（幂等 + 不丢更新）；
- 明确迁移步骤与顺序（崩溃安全）：`rename(.log)` → 原子写新 `.json`（tmp+rename，`mode 0600`，重写 `logPath`）
  → `unlink` 旧 `.json`。反过来（先搬 json）崩在中间会得到"记录在新目录、日志还在根目录、`readOutput` ENOENT"；
- 每次迁移**至多处理一遍**并把结果 WARN 汇总，便于用户核对。

### 🔴-6 fork / new session 打破一条已文档化的既有契约：「reload/new/resume/fork 一律保留，下一个 stack 收养」

**问题**：`src/index.ts:235-238` 的注释与 README:75、README:91 都明确承诺：
「reload/new/resume/fork 一律保留（the next stack adopts them）」「仍在跑的 job 在下一个 session 里被重新接管**并继续通知**」。
而 `new`/`fork`（包括交互式改历史消息 → `AgentSessionRuntime.fork` → `createBranchedSession`，
`agent-session-runtime` 里 fork 分支发 `session_start reason:"fork"`）**会换 sessionId**
（`session-manager.js:651/1097/1256`）。改成 per-session 目录后：

- 上一 session 仍在跑的 job 落在旧目录 → 新 stack 的 `store.dir` 看不到 → **永远不被收养、永远不发完成通知**；
- 它们同时变成"无活 host 的孤立目录"，叠加 🔴-1 就是"连日志一起被 GC 删掉"；
- 用户视角：编辑一条历史消息（一个很常见的操作）就会让正在跑的后台任务从 `bash_job list` 里凭空消失。

方案 §1.2 的结论「recover 逻辑不变，扫描面收窄，所有分支保留」因此**论证不充分**：它只推演了
resume（同 id）和 reload（同进程同 id），没有推演 fork/new。§1.5 关于 `keep` 的那段（"resume 同 sessionId 后 recover 认领"）
同样只覆盖了一半的 shutdown reason。

**依据**：`src/index.ts:235-241`；`README.md:75`、`README.md:91`；
`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js:165/211/229/246`；
`session-manager.js:651/1097/1256`。

**修法（必须显式决策并写进方案，任选其一）**：

- (a) **继承链**：新 session 启动时若 `header.parentSession` 指向上一个 session 文件，则把父 session 目录里的
  **非终态** job 迁入本 session 目录（迁移逻辑已有，复用即可）；
- (b) **交接清单**：`session_shutdown(reason ∈ {new, fork})` 时把仍活的 job 记录改写 `sessionId` 为
  `event.targetSessionFile` 对应的新 id（该字段 pi 会传，见 `emitSessionShutdownEvent` 的 `targetSessionFile`），
  下个 stack 自然认领；
- (c) **显式接受回归**：那就必须同步改 `src/index.ts:235-238` 注释、README:75/91，并在 fork/new 后给用户一条
  "上一个会话有 N 个后台任务留在 `<path>`" 的提示——否则就是静默丢功能。
  无论选哪条，都要有对应集成测试（见 🟡-9）。

### 🔴-7 GC 的 TOCTOU：`stat` → `rm -rf` 之间别的会话可能刚落一个新 job

**问题**：方案把"目录 mtime 纳入 max"当作"防扫描与新写入竞争"的保护，但 `stat` 与 `rm` 不是原子的：
另一个会话（或同 session 双开）在这两步之间 `writeAtomic` 落下 `staged` 记录 + 建日志文件，
`rm(recursive)` 会把这条**刚诞生的活 job** 连记录带日志一起删掉（进程已 spawn 或即将 spawn，
之后就是一个无人管理、`kill` 不到的后台进程；再叠加 🔴-4 → 通知风暴）。
两个会话并发 GC 同一目录还会互相看到半删状态（`readdir`/`stat` 抛 ENOENT），方案没规定这类错误怎么归类。

**依据**：plan §3.1 `gcSiblingDir`；`job-store.ts:111-123`（写路径不加锁、跨进程无互斥）。

**修法**：采纳 🔴-2 修法 3（逐文件判龄 + `unlink` + 非递归 `rmdir`）后这个窗口自然收敛：
每个文件在删除前被单独判过龄，新落的文件因 mtime 新而豁免，`rmdir` 遇到非空直接失败。
另外 ENOENT 一律静默、其余 WARN（对齐 `job-store.ts:142/225` 的既有规范）。

---

## 🟡 建议改进

### 🟡-1 迁移是 fire-and-forget，排在 `recover()` 之后 → 当前 session 自己的旧记录本次不进 `entries`

`recover()` 先 `loadAll()`（此刻 session 目录里还没有被迁入的记录），迁移随后才落文件；而
`deliverNotice` 只遍历 `entries`（`manager.ts:385-387`）→ 迁移进来的**终态未通知** job 这一整个会话都不会通知，
非终态 job 这一整个会话都不会被收养/探活。方案 §6 风险表却写"旧 flat 记录自动归位"。
**修法**：把"当前 session 的记录迁移"改成 `await`（只是一次 root `readdir` + 少量 `rename`，成本远低于 `recover` 自身的目录扫描），
在 `recover()` 之前完成；兄弟目录 GC 继续 fire-and-forget。或让迁移返回 jobId 列表由 stack 回灌 `putRecord`。

### 🟡-2 `_unscoped` 与 `selfDirName` 冲突，§1.3 的「GC 同样作用于 `_unscoped`」不成立

当前会话本身退化（sessionId 为空）时 `selfDirName === "_unscoped"` → 被 `continue` 跳过，
那个共享桶恰恰在"最需要清理"的场景永不清理。反过来，退化路径下 `_unscoped` 里是**多个会话混住**，
`recover()` 会把别的退化会话遗留的 `staged` 记录判 `failed`、把 host 已死的 job 收养走——
这是今天的行为，可以接受，但方案只写了"共享可见面"，没写"跨会话相互接管"。**修法**：文档写全；
GC 对 `_unscoped` 用"逐记录"策略（只删过期终态记录，不整目录删），因为它天然可能有多主。

### 🟡-3 每个跑过 bash 的会话都会留下一个目录 → root 下堆积成千空目录，每次启动全量扫描

`create()` 在 spawn 之前就 `store.save(staged)`（`manager.ts:591`），前台跑完的 job 会被
`discardForeground` 删掉记录（`manager.ts:437-450`），但**目录留下来**且为空。于是"每个执行过任意 bash 命令的会话"
= 一个目录，24h 内不会被回收；`reconcileRootDir` 每次 session start 都要 `readdir` root + 对每个目录 `readdir` + `stat`。
**修法**：空目录（或只剩 `.tmp` 的目录）不等 retention，直接 `rmdir`；并在 §2 不变量里写明"目录数量 ≈ 近 retention 窗口内的会话数"。

### 🟡-4 隔离强度被夸大，工具文案会误导模型

文件仍是同一用户 0600、目录名就是 sessionId，模型完全可以 `ls ~/.pi/agent/bash-jobs/*/` 再 `read` 别的会话的日志
（`bash` 和 `read` 都在手边）。§4 要给 `bash-job-tool.ts` 加的「jobs and logs are private to this session」
是**假陈述**。**修法**：文案改成事实描述（"`list`/`status` 只显示本会话的 job"）；README 安全小节明确
"这是可见性隔离，不是 OS 边界"；session 目录 `mkdir` 用 `mode: 0o700`（`job-store.writeAtomic` 的 `mkdir` 需要能传 mode，
或由 `session-dirs.ts` 预建）。

### 🟡-5 `dir` 语义 breaking 的迁移说明不足；README 漏改两行

方案只给"CHANGELOG 标注 + 注释改写"。考虑到 `dir` 是 JSON-only 的高级选项、且改后语义**倒转**（最终目录 → root），
建议：(a) 增加 `bashJobs.scope: "session" | "shared"`（默认 `"session"`）给需要旧语义的人一条出路，
或至少 (b) 启动时若在 root 下发现 flat `b_*.json` 就 WARN 一次并打印新布局说明。
另外 §4 的文档清单漏了 **README:87**（目录清理的"三后缀安全边界"承诺，被 GC 打破，见 🔴-2）和
**README:89**（"需要更严的隔离时用 `bashJobs.dir` 指到别处" —— 在新语义 + GC 下这条建议变危险）。
README 行号也偏了 1（方案写 67/80，实际是 68/81）。

### 🟡-6 跨主机 / NFS 共享 home：`probePid` 在本机无意义 → 删掉别的机器上仍在运行的 job

`probePid` 是 `process.kill(pid, 0)`（`process.ts:192-201`，`EPERM` 也算活），对"另一台机器写的 hostPid"
只会给出随机答案：探不到 → GC 判"无活主"→ 删；探到（pid 巧合复用）→ 永不清理。
记录里**没有 hostname 字段**（`types.ts:78-160`），所以想正确处理必须加字段——而方案 §6 声称
"无持久化格式变化"。**修法**：`JobRecord` 增加可选 `host?: string`（`parseJobRecord` 缺省即"未知"，
向后兼容不需要 bump `v`）；GC 对 `host` 未知或非本机的**非终态**记录一律不删；或提供 `bashJobs.gc: false` 开关
（NFS/容器用户的逃生口）。同样的问题也适用于容器场景（同一 pid 命名空间外的 hostPid 毫无意义）。

### 🟡-7 大小写不敏感文件系统 + 用户自定 session id → 两个不同 session 落进同一目录，隔离直接失效

`newSession({ id })` / `forkFrom({ id })` 允许调用方指定 id（`session-manager.js:649`、`:1254`），
`assertValidSessionId` 允许大小写混用。macOS APFS 默认大小写不敏感：`Work` 与 `work` 是同一个目录。
**修法**：`sanitizeSessionDirName` 对"非纯小写 uuidv7 形状"的 id 追加一个短 hash 后缀
（如 `${lower(id)}-${sha256(id).slice(0,8)}`），或整体改成 `sha256(sessionId).slice(0,16)` 目录名 +
目录内放一个 `session-id` 文件（顺带解决 🟡-4 的 id 泄露与 🟡-8 的长度问题）。

### 🟡-8 sessionId 无长度上限 → `ENAMETOOLONG` 时 bash job 静默不可用

`assertValidSessionId` 不限长；`mkdir` 失败 → `writeAtomic` 每次抛 → `create()` 直接失败。
**修法**：sanitize 加长度上限（超限截断 + hash 后缀），或采纳 🟡-7 的 hash 方案。

### 🟡-9 测试计划不足以支撑方案的安全声明

§5 缺以下用例（每条都对应上面一个 🔴/🟡）：

1. **迁移幂等**：连跑两次 `reconcileRootDir`；目标文件已存在时不覆盖、不丢；
2. `retentionMs <= 0` → GC 完全不动任何兄弟目录（🔴-3）；
3. 兄弟目录里含非 job 文件 / 目录名不像 session id → 拒绝删除（🔴-2）；
4. **非终态 + hostPid 已死 + 子进程仍活**（`checkPidOwnership → "alive"`/`"unsafe"`）→ 不删（🔴-1）；
5. 迁移**终态**记录时 hostPid 仍活 → 跳过（🔴-5）；
6. fork/new（换 sessionId）后上一 session 的 running job 的归属断言（🔴-6，选定方案后必测）；
7. 记录被外部删除后 `deliverNotice` 只通知一次（🔴-4 的防御性修复）；
8. 两个 store（模拟两会话）并发 GC 同一 root 不抛、不误删。

另外 §5 有一个**测试自伤**风险没提示：GC 用的是 `systemClock`（stack 硬编码 `systemClock`，`stack.ts:169-183`），
而"隔离用例"要 seed 一个 `<other-session>/` 目录并断言"recover 后未被改动"——如果 seed 的
`createdAt/endedAt` 用了 0 或很老的值，**同一次 activate 里的 GC 会把它删掉**，测试会以"删了"的方式变绿/变红，
掩盖真实语义。seed 时间必须显式取 `Date.now()` 附近，并单独用一个专门的 `<dead-session>/` 目录测 GC。
建议同时补一条断言：默认配置（无显式 `dir`）下不出现 flat 文件、也不触碰真实 `~/.pi`。

### 🟡-10 §3.1 伪代码对错误分类含糊

`stat` 失败、`readdir` 中途 ENOENT、`rename` EXDEV（root 与 session 目录跨设备时不可能，但 root 是符号链接/挂载点时可能）
都没规定行为。**修法**：对齐 `job-store` 既有规范——ENOENT 静默、其余 WARN 并跳过该条目；
`rename` 失败回退到"copy + fsync + unlink"或直接跳过（**不要**用非原子的 copy 覆盖已有目标）。

---

## 🟢 可选优化

- **G1** GC 判龄缺 `job-store.fileAge` 的"mtime 在时钟未来 → 不判"规则（`job-store.ts:180-198`）。
  方案的 `now - newest > retention` 在未来 mtime 下恰好也不会删（方向安全），但语义应统一：
  把 `fileAge` 提成共享 helper，两处复用。
- **G2** 迁移用的 `^b_[A-Za-z0-9]+\.json$` 比 `isJobId`（`ids.ts:11`：`^b_[0-9A-HJKMNP-TV-Z]{8}$`）松。直接用 `isJobId`。
- **G3** 根目录里旧时代残留的**孤儿 `.log`** 和 `.tmp` 迁移后无人清理（迁移只看 `b_*.json`，root 又不再是任何 store 的 `dir`）。
  补一条：root 下 flat 残留按 `pruneExpired` 的同一套规则清理（或干脆在 root 上跑一次 `createJobStore({dir: root}).pruneExpired()`）。
- **G4** `readdir(withFileTypes)` 下"指向目录的符号链接"既不是 `isDirectory()` 也不是 `b_*.json` → 静默忽略。
  这是合理行为，但要在文档里写明"只处理普通目录"。
- **G5** `manager.dir` 变成 per-session 后，`/agent status`、fleet widget、通知 `details.logPath` 里的路径都会带 sessionId。
  无害，但值得在 README 里说一句（路径变长、含会话 id）。
- **G6** GC/迁移只在 `bashJobsEnabled(settings)` 为真时才跑（`stack.ts:525`）。把 `autoBackgroundMs` 设为 0 的用户
  会永久滞留旧数据。方案应写明这一点（或把 root 级 reconcile 提到 `bashJobsEnabled` 之外）。
- **G7** §6 的"回滚方式：纯 revert（无持久化格式变化）"不准确：迁移重写了 `logPath`，而旧版
  `store.remove()` 按**计算路径**删日志（`job-store.ts:174`）→ revert 后被迁移过的记录即使被旧版看到也会漏删日志文件。
  措辞改成"记录 schema 不变，但 `logPath` 字段值会指向新布局；回滚需人工清理"。

---

## 总体结论：**修改后通过**（§1.3 GC 小节等同重做）

方向和骨架是对的：`<root>/<sessionId>/` 的布局、store 层不做 session 感知、只在装配层拼路径、
保留 `recover()` 的全部分支、`_unscoped` 兜底——这些决策我都认同，改动面也控制得很好（§4 的清单基本准确）。
问题集中在两处，且都在"会不动声色地删用户数据/刷屏"的方向上：

1. **§1.3 的 GC 需要重做**，不是打补丁：它以"目录"为删除单位、以 `hostPid` 为唯一活性证据、
   以 `rm -rf` 为手段、不校验目录归属、不尊重 `retentionMs<=0`，四个缺陷叠加起来能删掉正在运行的 job
   （🔴-1）、删掉用户无关目录（🔴-2/🔴-3）、并把后果放大成每 2 秒一次的通知风暴（🔴-4）。
   正确形态应当是 `pruneExpired` 的同构扩展：**逐文件判龄、三后缀爆炸半径、非终态永不删、非本会话目录先验归属、最后非递归 rmdir**。
2. **§1.2 / §1.5 的语义论证漏了 fork/new**（🔴-6）：`session_start` 有五种 reason，其中两种换 sessionId，
   而"reload/new/resume/fork 一律保留 + 下一个 stack 收养"是写在代码注释和 README 里的既有契约。
   这条必须显式决策（继承父 session 目录 / shutdown 时改写归属 / 明确接受并改文档），不能用一句"符合隔离直觉"带过。

另外 §1.7 的迁移需要收紧（终态记录也要看 hostPid、目标不覆盖、顺序与崩溃安全、当前 session 的迁移要 await 在 recover 之前），
§3.1 里关于 `record.logPath` 的那条注释是**事实错误**（`readOutput`/工具文案读的都是持久化字段，
`manager.ts:686/693`、`bash-job-tool.ts:151/224/319`），基于它做的"logPath 只是展示字段"推断必须删掉。
测试计划补齐 🟡-9 的 8 条后，才算覆盖了方案自己声明的安全属性。

上述 7 个 🔴 修完、fork/new 决策落地、测试补齐，即可实施；GC 小节建议重写后再走一轮短评审。

---

# v2 复审（2026-09-03）

复审对象：`plan.md` v2（386 行，§8 为 v1→v2 变更摘要）。范围：只看增量——§8 声称的修复是否真的落在正文、
改法是否正确完整、v2 是否引入新问题、测试是否跟上。v1 已确认的部分不再复述。

## A. §8 逐条核对

| 评审项                     | 落实情况                                                                                                                              | 结论                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 🔴-1 GC 删活 job           | §1.3/§3.3 改用 `checkPidOwnership(record)`，alive/unsafe 一律保留、非终态默认永不删、不再以目录 mtime 当活性证据（并在 F18 写明理由） | ✅ **真修好了**。四叠加里最危险的一条已封堵。残余见 🟡-C                                                     |
| 🔴-2 无归属判据 + `rm -rf` | §3.2 目录名白名单（`VALID_ID_RE` / `_unscoped`）、§3.3 内容白名单、逐文件 unlink、非递归 rmdir，全文无 `rm -rf`                       | ⚠️ **设计对了，规格写错**：内容白名单的文件名规则与真实 `.tmp` 命名不符 → 见 🔴-D；整目录一票否决过脆 → 🟡-B |
| 🔴-3 无视 `retentionMs<=0` | §1.3 总开关 + §3.2 `if retentionMs > 0` 包住阶段 C；F24 注释统一                                                                      | ⚠️ **门控粒度错了**：阶段 B 未受门控、阶段 C 全被门控，两处都与 §1.3 自己的文字相反 → 🟡-A                   |
| 🔴-4 通知风暴              | §1.8/§3.6 `deliverNotice` 在 `applyPatch` 返回 undefined 时标记内存 `notifiedAt`                                                      | ✅ 位置和写法都对（与 F19 一致，`shouldNotifyJob` 只看内存记录）。纵深防御到位                               |
| 🔴-5 迁移搬活主记录        | §1.7/§3.5：活性判定不分状态、`hostPid===me` 也跳、目标不覆盖、`rename(log)→原子写 json(重写 logPath)→unlink`                          | ✅ 修得完整、顺序正确。残余：无法迁移的 root `.json` 没有终态出口 → 🟡-F                                     |
| 🔴-7 TOCTOU                | §3.3 每次 unlink 紧邻判龄 + 非递归 rmdir；残余 rmdir/mkdir 窗口写明接受                                                               | ✅ 收敛方式正确。残余窗口的处理建议见 🟢-1                                                                   |
| 🔴-6 fork/new 契约         | §1.6 选 (b′)：`session_start` 侧用 `previousSessionFile` 交接                                                                         | ❌ **不通过**：引入了比原问题更糟的新缺陷（🔴-A），且仍漏掉最常见的冷启动路径（🔴-B）与被收养 job（🔴-C）    |
| 🟡-1/2/3/4/5/9/10、G1–G7   | 逐条落在 §1.3/§1.4/§1.9/§1.10/§2/§5/§6                                                                                                | ✅ 基本都落地了；G7 回滚措辞、G6 取舍、🟡-5 否决 `scope` 的理由都写了论证，可接受                            |
| 事实修正 F15/F16           | v1 §3.1 的 `logPath` 错误已删，迁移重写 `logPath` 升为"必须"，并连带硬修 `store.remove()`                                             | ✅ 修正正确（`manager.ts:686/693`、`job-store.ts:170-175` 复核一致）。硬修本身带来新隐患 → 🟡-D              |

新增事实核对（v2 新引用的部分，我逐条读过）：

- **F6 / `previousSessionFile`**：`dist/core/extensions/types.d.ts:415-422` 确认 `reason: "startup"|"reload"|"new"|"resume"|"fork"`，
  `previousSessionFile?: string` 注释明写「Present for "new", "resume", and "fork"」。✅ 属实——**但同时证明了 🔴-B**：
  `startup` 不带该字段。
- **F20**：`SessionShutdownEvent.targetSessionFile?`（`types.d.ts:478-483`）✅；文件名 `${fileTimestamp}_${sessionId}.jsonl`
  且 fileTimestamp 由 `timestamp.replace(/[:.]/g,"-")` 生成、不含 `_`（`session-manager.js:669`）✅。
- **F18**：`manager.ts:509` 注释 + 只有 :562/:591/:623 三处落盘 ✅（v1 我自己也是这么核的）。
- **§1.1 的 `UUIDV7_RE`**：我读了实现（`node_modules/@earendil-works/pi-ai/dist/utils/uuid.js`）——
  `bytes[6] = 0x70|…`（版本位 7）、`bytes[8] = 0x80|(…&0x3f)`（变体位 10 → 首 nibble ∈ 8/9/a/b）、全小写 hex。
  ✅ 方案的正则与实现吻合，99% 路径确实是"原样保留"。
- **F12 的简化有害**：v2 把它写成「`dispose()` 只清计时器」。实际 `manager.ts:936-955` 还做两件事、并且**明确保留**
  「no process is signalled, and the log streams stay open so an in-flight job keeps capturing output for the next stack to adopt」。
  被省掉的正是 (b′) 时序论证的关键前提 → 直接导致 🔴-A。见 🟡-J。

**总评（A 部分）**：GC 小节的重做方向完全正确，是 `pruneExpired` 的忠实同构；v1 指出的四缺陷叠加中
🔴-1/🔴-7 已实质封堵，🔴-2/🔴-3 是"设计对、规格错"的一步之遥。真正的问题全部集中在 v2 **新写的 §1.6 交接机制**上。

---

## 🔴 必须修复（v2 新增）

### 🔴-A （b′) 交接把文件从旧 manager 脚下搬走，破坏「disposed manager 仍负责落盘」的既有交接通道 → fork 时正在跑的 job 全部以 `exited_unknown` 收场，退出码丢失

**问题**：§1.6 的时序论证只考虑了"计时器停了"，漏了 `dispose()` **故意不做**的事——
`manager.ts:947-953` 注释写得很清楚：不发信号、**日志流保持打开**，好让 in-flight job 继续写、让下一个 stack 收养。
也就是说旧 manager 的 `LocalHandle` 和 `finalizeLocal()`（`manager.ts:552-572`）在 dispose 后依然存活，
它**仍将在进程退出前把真实终态写进磁盘**——写的是**旧 store 的路径**（`store` 的 `dir` 是构造时捕获的常量）。

今天（flat 目录）这条链是这样闭合的：
旧 manager 的 `finalizeLocal → applyTransition → store.update` 写入 `<dir>/b_x.json`；
新 manager 把同一个 job 当 adopted 收下，`probeAdopted` 每 2s 先 `store.load(jobId)`，
**读到旧 manager 刚写下的终态记录就 `putRecord` 采用它**（`manager.ts:400-409`）→ 退出码、finalText、footer 全部正确，
`pendingNotices` 也照常发。这是"I-b + 同路径"共同保证的隐式交接。

v2 的交接 `rename` 了 `.json`、重写了 `logPath`、`unlink` 了旧 json：

- 旧 manager 的 `finalizeLocal` → `store.update(jobId)` → `readRecord` 打开**旧路径** → ENOENT → 静默返回 undefined
  （`job-store.ts:128-134` 对 ENOENT 连 WARN 都不打）→ **真实退出码没有任何地方落盘**；
- 新 manager 把它当 adopted（没有 local handle），`probeAdopted` 轮到 `checkPidOwnership === "dead"` →
  `store.load` 读不到终态（旧 manager 写失败了）→ 打成 **`exited_unknown`**：模型看到的是
  「gone (its process disappeared, exit code lost)」（`types.ts:describeJobStatus`）。

**后果**：只要用户在有后台 job 在跑时编辑一条历史消息（fork）或开新会话（new），
**每一个当时在跑的 job 最终都会被报成"进程消失、退出码丢失"**，而它其实是正常 exit 0 的。
（日志 footer 反而是对的——`handle.stream` 的 fd 跟着 inode 走，`rename` 不影响它，所以 `tail` 看到
`completed (exit 0)`，而 `bash_job status` 说 `exited_unknown`——自相矛盾的输出，比 v1 的"看不见"更难排查。）

**依据**：`src/bash/manager.ts:936-955`（dispose 保留 local handle/流的显式注释）、`:552-572`（`finalizeLocal` 在 dispose 后仍 await 并落盘）、
`:400-409`（`probeAdopted` 靠 `store.load` 采纳旧 manager 的终态——**同路径**是前提）、
`:335-352`（`applyTransition` 在 `store.update` 返回 undefined 时静默失败）、`job-store.ts:128-134`（ENOENT 不 WARN）。

**修法（择一，都要写进方案并测）**：

1. **推荐：进程内交接 LocalHandle**，而不是搬文件。`previousBashJobs` 已经是 stack.ts 的模块级变量（`stack.ts:59/265/526`），
   给 manager 加一个 `exportLocalJobs(): LocalJobHandoff[]` / `adoptLocalJobs(handoff)`：新 manager 接过
   `spawned`/`stream`/`flush`/`written`/`truncated` 与 `exitPromise` 的所有权，`finalizeLocal` 由**新** manager 执行 →
   落盘落在新目录、退出码正确、通知正确、`dispose()` 的既有语义不动。搬文件只留给"上一 session 里已经是 adopted/无本地句柄"的记录。
2. **退让方案**：交接**只搬没有活本地句柄的记录**（即上一 manager `localJobs` 之外的）；本地拥有的 job 留在旧目录，
   由新 stack 登记一份 "pending pull" 清单（jobId + 旧目录），在 poll 里等旧 manager 写完终态后再把记录拉过来。
   实现更简单，但要新增一个跨目录的观察面，且窗口内 `bash_job list` 看不到那些 job（回归可见）。
3. 无论哪种，都必须新增一条集成测试：**fork 前起 `sleep 0.5 && exit 7` 的 job，fork 后断言最终 status=`completed`/`failed` 且 `exitCode===7`**
   （现在的 §5.2 交接用例只断言"可见且 adopted"，恰好绕过了这个缺陷）。

### 🔴-B 冷启动（`reason: "startup"`）没有 `previousSessionFile` → README 承诺的「**重启**后收养」仍然是坏的

**问题**：§1.6 通篇只讨论 new/fork（以及 reload/resume 同 id），把契约当成已恢复。但 README:91 的原文是
「**重启**/reload 后收养：仍在跑的 job 在下一个 session 里被重新接管并继续通知」——最常见的场景恰恰是：
用户在跑着长任务时 `quit`（`shutdownPolicy: keep` 默认保留进程），然后**重新开一个 pi**（`pi`，无参数）。
这条路径是 `sessionStartEvent` 缺省值 `{ reason: "startup" }`（`dist/core/agent-session.js:152`），
`previousSessionFile` **不存在**（types.d.ts:420 明写只在 new/resume/fork 传），新 session 又是新 uuidv7 →
**没有交接、没有收养、永不通知**。旧 job 的记录静静躺在上一个 session 的目录里，
`bash_job list` 看不到，完成通知永远不来。

更糟的是它与 §1.3 的非终态豁免条款合流：那个 job 跑完后（host 死、job pid 死、host 本机、过期）
**记录和日志会被 GC 删掉** → 用户既没收到通知，也失去了日志。v1 的 🔴-1 是"删还在跑的"，
v2 修好了；但"删一个从未被任何会话认领、结局无人知晓的 job"这条路径是 v2 自己造出来的。

**依据**：`dist/core/agent-session.js:152`；`dist/core/extensions/types.d.ts:418-421`；
`README.md:91`；`src/index.ts:235-238`；plan §1.3 非终态豁免条款、§1.6（全文无 "startup"）。

**修法（择一，必须显式决策）**：

1. **孤儿收养扫描（推荐，语义与今天最接近）**：`reconcileRootDir` 已经要读所有兄弟目录的记录了——
   顺手把"非终态 + 无活主（`hostPid` 死或 `probePid` 假）"的记录判为**可收养孤儿**，`rename` 进本 session 目录，
   由 `recover()` 走既有 adopted/exited_unknown 分支。这**不会泄露活会话的 job**（活主一律不动），
   泄露面仅限"主人已死的遗留 job"——而这正是今天 flat 目录下 adoption 的语义，不是新增暴露面。
   代价：`startup` 时才做（有 `previousSessionFile` 的路径已由交接覆盖），并且要在文档里写清"孤儿会被新会话接管"。
2. **只收终态未通知的**：更保守——只把 `shouldNotifyJob(record)` 为真的孤儿记录拉过来发一次通知，
   非终态的留在原处不动（那就仍然没人管，但至少不会被 GC 删掉——需要同时采纳 🟡-C 去掉非终态豁免）。
3. **接受并改文档**：把 README:91 的「重启后收养」明确降级为「**resume 同一 session 后**收养」，
   并在 `quit` 时若有活 job 就打印"这些 job 留在 `<dir>`，下次用 `pi --resume <session>` 可继续跟踪"。
   （这是可接受的产品决策，但必须是**显式**的，不能像现在这样被 §1.6 的乐观措辞掩盖。）

### 🔴-C 交接的记录筛选条件 `hostPid === process.pid` 会漏掉"被收养过"的 job → resume 后再 fork/new 又丢一次

**问题**：§1.6 步骤 3 / §3.5 `handoffJobsFromPreviousSession` 用 `if (record.hostPid !== process.pid) continue`。
但 `recover()` 的 adopted 分支**不重写 `hostPid`**——它只补 `backgroundedAt`（`manager.ts:817-826`）。
所以一个"P1 起的 job → P1 退出 → P2 `pi --resume A` 收养"的 job，其记录里的 `hostPid` 一直是 **P1 的死 pid**。
此时用户在 P2 里 `/new` 或编辑历史消息 fork → 交接过滤器把它当"别人的"跳过 → job 再次从 `bash_job list` 消失、
再次永不通知。这正是 🔴-6 要修的那个洞，只是需要多一步 resume。

**依据**：`src/bash/manager.ts:817-826`（adopted 只 `applyPatch(backgroundedAt)`，`hostPid` 不变）；plan §3.5 过滤条件。

**修法**：过滤条件改成 `recover()` 的 foreign 判据的补集——**只跳过真正"活的别人"**：

```
if (record.hostPid > 0 && record.hostPid !== process.pid && probePid(record.hostPid)) continue;  // 活的 foreign，不动
```

这样 `hostPid===me`、`hostPid` 已死（adopted）、`hostPid===0`（旧/损坏记录）都会被交接，
与 `manager.ts:813-815` 的语义完全一致。顺带在测试里加"adopted 后 fork"用例（§5.2 现在只测了"本进程起的 job + fork"）。

### 🔴-D 内容白名单的文件名规则与真实 `.tmp` 命名不符 → 任何写过一半的目录（以及 macOS 上任何被 Finder 逛过的目录）永久跳过 GC

**问题**：§3.3 的 `isJobFileName` 规定"非 `b_<isJobId>.(json|log|tmp)` 条目 → 整个目录跳过 + WARN"。
但 job-store 的原子写临时文件叫 **`b_XXXXXXXX.json.<pid>.<now>.<seq>.tmp`**：

```ts
const target = recordPath(record.jobId); // <dir>/b_ABC12345.json
const temp = `${target}.${process.pid}.${clock.now()}.${tmpSeq++}.tmp`; // b_ABC12345.json.4242.1756...0.tmp
```

它**不匹配** `b_<isJobId>\.tmp`。后果两层：

1. 任何目录只要有一个崩溃残留的 `.tmp`（`TMP_RETENTION_MS` 存在就是因为这不罕见），
   或者恰好在扫描瞬间有别的进程在写（tmp 文件短暂存在），**整个目录被判"not ours"跳过 + WARN**
   → 新 GC 在最需要它的目录上永不工作，同时刷 WARN；
2. §3.3 里那条 `.tmp` 判龄分支（`name.endsWith(".tmp")`）虽然按后缀能命中，
   但它排在内容白名单之后——白名单先把整个目录 veto 了，所以**兄弟目录的 tmp 残留永远清不掉**。
   （对照：job-store 自己的 `pruneExpired` 用的是纯后缀判定 `entry.endsWith(TMP_SUFFIX)`，所以它一直是对的。）

顺带：macOS 用户的 `.DS_Store`、编辑器的 `.swp`、`nohup.out` 任何一个都会永久禁用该目录的 GC。

**依据**：`src/bash/job-store.ts:113-115`（tmp 命名）、`:238-244`（后缀判定，与之匹配）；plan §3.3 `isJobFileName`。

**修法**：

1. 文件名分类**照抄 `pruneExpired` 的后缀模型**：`.json`/`.log` 要求 stem 是 `isJobId`；`.tmp` 只要求
   `name.startsWith("b_") && name.endsWith(".tmp")`（或干脆 `endsWith(".tmp")`，因为爆炸半径已被三后缀限制）；
2. 白名单从"整目录一票否决"改为"**逐文件放行**"（见 🟡-B）——未知文件永不删除，但不阻止已识别文件的清理；
3. 单测必须用**真实的 tmp 文件名**（`b_XXXXXXXX.json.<pid>.<ts>.0.tmp`）而不是手写的 `b_XXXXXXXX.tmp`，
   否则测试会绿而线上会哑（这正是 v1 🟡-9 说的"测试自伤"的另一种形态）。

---

## 🟡 建议改进（v2 新增/残余）

- **🟡-A retention 门控粒度错位（与 §1.3 自述矛盾）**。§3.2 里 `sweepFlatLitter(rootDir)`（阶段 B）**在 `if retentionMs > 0` 之外**，
  而 §1.3 说阶段 B「按 mtime+retentionMs 删」→ `retentionMs = 0` 时 `now - mtime >= 0` 恒真 →
  **root 下的孤儿日志被立刻删掉**，正是 🔴-3 要禁止的行为。反过来阶段 C 被整体门控，导致 §1.3 承诺的
  「`.tmp` 不受 retentionMs 开关影响」在兄弟目录上不成立（与 `job-store.ts:237-244` 的既有行为也不一致）。
  **修法**：门控下沉到条款级——`.tmp` 分支永不门控；所有依赖 `retentionMs` 的分支在 `retentionMs <= 0` 时跳过；
  `rmdir` 空目录不依赖 retention（§1.3 已这么设计）。阶段 B/C 共用同一个 `sweepJobFiles(dir, opts)`。
- **🟡-B 整目录一票否决 → 改逐文件放行**（与 🔴-D 同源）。安全属性"绝不删不认识的文件"用**逐文件白名单**就能保证，
  不需要"有陌生文件就整目录不清理"。后者把一次性污染变成永久性功能失效，而且和 🟢-4 的
  "放一个 `session-id` 标记文件用于正向归属确认"直接冲突（标记文件本身会 veto 整个目录）。
- **🟡-C 非终态豁免删除条款建议直接删掉（顺带砍掉 `host` 字段的必要性）**。§1.3 现在允许在
  「`host` 本机 + `checkPidOwnership === "dead"` + 过期」三条件下删非终态记录。它的收益只是回收几 KB 和一个目录；
  代价是：一个**结局从未被任何会话报告过**的 job（🔴-B 场景常态化）连记录带日志一起消失，
  用户永远不知道它是成功还是失败——非终态记录是"未结算凭证"，不该由清理程序销毁。
  **修法**：非终态记录**永不删除**（严格版 🔴-1）。如果同时采纳 🔴-B 的孤儿收养，这些记录会被下一个会话转成
  `exited_unknown`/adopted → 走正常终态过期路径，磁盘自然收敛，逻辑还更简单。这样 `host` 字段（§1.9）
  就只剩诊断价值，**可以不动 `JobRecord` schema**（少一个 `parseJobRecord` 白名单改动、少一个 NFS 语义讨论、
  少一段容器文档）——用零风险换掉一个新持久化字段，是划算的。若仍要保留豁免，至少把阈值与 `retentionMs` 解耦
  （例如固定 7 天）并在删除时 WARN 出 jobId + 日志路径。
- **🟡-D `store.remove()` 硬修引入"按记录字段 unlink 任意路径"的新风险**。§1.7 末尾要求"若 `record.logPath !== 计算路径`
  则两个路径都 unlink"。`record.logPath` 是磁盘上的**不可信数据**（用户可手改、可被损坏、旧版本可写入任意值），
  照此实现等于把 unlink 的目标交给 JSON 内容决定。**修法**：只在 `basename(record.logPath) === `${jobId}.log`` 且
  该路径位于 root 之下（`resolve` 后前缀检查）时才 unlink，否则只 WARN。测试补一条"logPath 指向 root 之外 → 拒删"。
- **🟡-E 本 session 迁移与 `reconcileRootDir` 阶段 A 自相重叠**。§3.4 先 `await migrateFlatRecords(root, { only: selfDirName })`，
  又并发 `reconcileRootDir`（其阶段 A 遍历**全部** root flat 记录，不带 exclude）→ 同一进程内两条路径同时迁移同一文件。
  多数交错是良性的（存在性检查 + ENOENT 静默），但会出现"B 在 A 完成后用旧快照 `writeAtomic` 覆盖目标"这种
  无意义的重写。**修法**：给 `reconcileRootDir` 传 `skipDirNames: [selfDirName]`（或让阶段 A 只处理 `sanitize(record.sessionId) !== selfDirName` 的记录），
  并在测试里断言"同一文件不被迁移两次"。
- **🟡-F 无法迁移的 root flat `.json` 没有终态出口**。阶段 B（G3）只清孤儿 `.log` 和 `.tmp`。
  一条 `hostPid` 恰好被别的长命进程复用、或 JSON 已损坏、或 `rename` 持续失败的 root `.json`
  → 永远不迁移、永远不清理，且因为同名 `.log` 有 json 陪着也永不算孤儿 → **两个文件永久滞留**。
  **修法**：阶段 B 加一条与 GC 同规则的兜底——root 下的 `.json`：可读且终态且过期 → 删（连同 log）；
  不可读且 mtime 过期 → 删（连同 log）；非终态一律保留（与 🟡-C 一致）。
- **🟡-G `prevSessionFile → sessionId` 的推导顺序反了，且缺"两条路都失败"的处置**。§1.6 步骤 1 是
  "先按文件名第一个 `_` 切，文件存在则读 header 复核"。但文件名规则只对 pi 自己生成的名字成立——
  `SessionManager.open(explicitPath)` 允许 `--session ./my.jsonl` 这类**没有 `_`** 的路径；
  反过来 header 也可能读不到：`newSession()`/`createBranchedSession()` **推迟到首个 assistant 消息才落盘**
  （`session-manager.js:_persist` 的 `hasAssistant` 守卫、`createBranchedSession` 的 `if (hasAssistant)` 分支），
  所以 `previousSessionFile` 指向的文件**可能根本不存在**。
  **修法**：顺序改成 header 优先、文件名兜底、两者都失败则放弃交接并 WARN（不要猜）。
  更稳的做法是不解析路径：在 `session_shutdown` 时把本 session 的 `sanitize(sessionId)` 记到模块级变量
  （单进程内交接本来就不需要跨进程信息），`session_start` 直接用它——`previousSessionFile` 只作为
  "是否发生了会话替换"的信号。这也顺手绕开了 in-memory session 的局限（§1.6 步骤 6 现在把它列为回归）。
- **🟡-H 交接后旧目录可能被"复活"，导致同一个 job 被两个会话同时收养**。§1.6 已承认 dispose 后可能有
  mid-flight 写落回旧目录；但没推演它的下游：那份复活的副本是**非终态、`hostPid` = 本进程**的记录，
  按 🟡-C 前的规则它不会被 GC 删（pid 活着），于是长期留存；用户之后 `pi --resume <旧 session>` 时
  `recover()` 会把它当自己的 job 收养 → **同一个 pid 被两个会话的两个 manager 管理**（双通知、双 kill、记录分叉）。
  **修法**：交接结束后（`recover()` 之后）对旧目录做一次幂等复查，删掉 jobId 已归本 session 的残留 json/log；
  或采纳 🔴-A 修法 1（不搬文件，就没有这个窗口）。
- **🟡-I 测试计划跟不上 v2 的新逻辑**。§5 补齐了 v1 要的八条（值得肯定），但 v2 自己新增的部分覆盖不足：
  1. **交接用例只断言"可见 + adopted"**，不断言**退出码/终态正确** → 恰好放过 🔴-A。必须加：
     fork 前起 `sh -c 'sleep 0.3; exit 7'`，fork 后等终态，断言 `status === "failed" && exitCode === 7`（不是 `exited_unknown`）；
  2. 无 `reason: "startup"`（无 `previousSessionFile`）的用例 → 🔴-B 无人把关；
  3. 无"adopted（`hostPid` 为死 pid）后 fork"的用例 → 🔴-C 无人把关；
  4. GC 的 `.tmp` 用例若不用真实 tmp 文件名（`b_X.json.<pid>.<ts>.0.tmp`）就测不出 🔴-D；
     还应加"目录内有 `.DS_Store` → 已识别文件仍被清理、陌生文件不动"（🟡-B 修法的直接断言）；
  5. `retentionMs <= 0` 只测了"阶段 C 不动"，没测"阶段 B 也不许删 root 孤儿 log"（🟡-A）；
  6. 无 root 下不可迁移 `.json` 的终态出口用例（🟡-F）；
  7. `store.remove()` 硬修只测了"两个都删"，没测"logPath 指向 root 之外 → 拒删"（🟡-D）。
- **🟡-J 事实表 F12 的简化掩盖了关键前提**。「`dispose()` 只清计时器」应改为
  「清计时器 + 结算 waiters；**故意保留**本地 job 的日志流与 `exitPromise` 回调，让 in-flight job 继续写并由下一个 stack 采纳
  （`manager.ts:936-955`）」，并新增一条 F：「`probeAdopted` 通过 `store.load` 采纳旧 manager 写下的终态记录
  （`manager.ts:400-409`）——**同一磁盘路径是这条隐式交接链的前提**」。§1.6 的任何方案都必须先满足这条不变量。

---

## 🟢 可选优化

1. **rmdir/mkdir 竞态的显式兜底**（§1.3 已"接受并写明"）：`create()` 的失败会直接冒泡给模型。
   `writeAtomic` 在 `mkdir` 之后 `rename` 遇 ENOENT 时重试一次即可把这个窗口变成不可观测——两行代码，
   建议随本方案一起做（`job-store.ts:111-123`）。
2. **伪代码里的 `undefined` 比较**：`(await fileAge(name)) >= retentionMs` 与 `((await fileAge(...)) ?? 0) >= TMP_RETENTION_MS`
   两种写法混用；前者在 `strict` + `Millis | undefined` 下**过不了 typecheck**（本仓库开了严格模式）。
   实现时统一成显式 `const age = await fileAge(x); if (age === undefined) continue;`，让"不判"成为可读的一等分支（也回应 G1）。
3. **`dirMode` 会连带把 root 建成 0700**：`mkdir(root/<sid>, { recursive: true, mode })` 对**所有新建层级**生效，
   所以新装用户的 `~/.pi/agent/bash-jobs` 也会变 0700（既有目录不变）。这大概是想要的效果，但值得在 §1.1 写明；
   另外 `manager.ts:591` 的那次 `mkdir(store.dir, { recursive: true })` 也要带上同一个 mode，否则谁先赢谁定权限。
4. **`session-id` 标记文件**（需先做 🟡-B 的逐文件放行）：在每个 session 目录里写一个 `session-id` 文本文件，
   可以把 GC 的目录归属判断从"名字形状匹配"升级为"正向确认这是我们建的"，同时解决 §1.1 里
   "非 uuidv7 目录名不可逆推 sessionId"的调试痛点。成本一行，收益不小。
5. **`sanitizeSessionDirName` 已成为磁盘契约**：将来任何调整（正则、截断长度、hash 算法/位数）都会让老目录变成孤儿。
   建议在函数注释里写明"改这个函数等于改磁盘布局"，并把 `uuidv7()` 的真实输出纳入单测（断言走的是原样分支），
   而不是只测手写的正则样本——我核过当前实现（版本位 `0x70`、变体位 `0x80|`、全小写）确实匹配，但这是**别人的**实现细节。
6. **jobId 跨 session 碰撞**：`newJobId` 只查本 manager 的 `entries`（`manager.ts:576`），
   迁移/交接的"目标已存在 → 跳过"会把碰撞变成"静默丢一条记录"。概率 32⁻⁸，但 WARN 文案里带上两条记录的
   `createdAt`/`command` 预览，出了事才有据可查。

---

## 总体结论：**修改后通过**（§1.6 需要再走一轮；GC 小节修掉 🔴-D 即可实施）

v2 是一次实质性的、诚实的返工：GC 已经从"目录级 `rm -rf` + `hostPid` 单点判活"变成 `pruneExpired` 的忠实同构
（逐文件判龄、三后缀、非终态默认不删、`checkPidOwnership` 判活、非递归 rmdir、`retentionMs<=0` 关闭），
v1 的四缺陷叠加在设计层面已经解开；🔴-4 的纵深防御、🔴-5 的迁移收紧、F15/F16 的事实修正与 `store.remove()` 连带硬修
都做得比我要求的更完整；🟡-5/🟡-6/🟡-7 的几处"否决 + 写明理由"（不加 `scope` 开关、不加 `gc:false`、不做全量 hash）
论证充分，我同意这些取舍。

不通过的部分集中在 v2 **新写**的 §1.6 fork/new 交接：

- **🔴-A**：把记录从旧 manager 的 store 路径下搬走，破坏了 `dispose()` 刻意保留的"disposed manager 仍落盘 +
  新 manager 靠 `store.load` 采纳"这条隐式交接链（`manager.ts:400-409` / `:936-955`），
  结果是 fork 时在跑的 job 全部被报成 `exited_unknown`、退出码丢失，而日志 footer 却显示正确结局——
  比 v1 的"看不见"更糟，且现有交接用例正好测不到。**建议改为进程内交接 LocalHandle，不搬文件。**
- **🔴-B**：`reason: "startup"` 不带 `previousSessionFile`（types.d.ts:420 明写），
  所以"退出 pi → 重新开 pi"这条最常见路径仍然没有收养、没有通知，叠加 §1.3 的非终态豁免还会删掉证据。
  必须显式决策（孤儿收养扫描 / 只捞终态未通知 / 明确改文档 + quit 提示），不能靠 §1.6 的乐观措辞掩盖。
- **🔴-C**：交接筛选用 `hostPid === process.pid`，而 adopted 分支不重写 `hostPid`（`manager.ts:817-826`）→
  resume 后再 fork/new 会再丢一次。一行改成"只跳过活的 foreign"即可。
- **🔴-D**（GC 侧唯一硬伤）：内容白名单没考虑真实 tmp 命名 `b_X.json.<pid>.<ts>.<seq>.tmp`（`job-store.ts:113-115`），
  加上"整目录一票否决"，会让 GC 在任何有 tmp 残留/`.DS_Store` 的目录上永久失效。改后缀模型 + 逐文件放行即可。

另外建议顺手做两个减法，能同时降低风险和实现量：**去掉非终态豁免删除条款**（🟡-C）→ `JobRecord.host` 变成
可选诊断字段甚至不必新增，`parseJobRecord`/NFS/容器那一整段讨论随之消失；**交接不解析 session 文件路径**（🟡-G）→
改用 shutdown 时记下的模块级 `sanitize(sessionId)`，顺带解决 in-memory session 的回归。

实施建议：§7 的顺序 1→2→3（`session-dirs.ts` 全套）可以在修掉 🔴-D、🟡-A/B/D/E/F 后照常推进；
**§1.6 请单独重写一版（含 🔴-A/B/C 的决策与 🟡-I 补的三条用例）再走一次短评审**，
不要与 GC 一起进主干——它现在是整个方案里唯一"改了会比不改更糟"的部分。

---

# v3 终审（2026-09-03）

终审对象：`plan.md` v3（438 行，§8.2 = v2→v3）。范围：§1.6 重写的正确性、孤儿收养与 GC 的交互、
v2 复审各条的落实、新事实错误/自相矛盾、测试覆盖，以及撤销 `host` 字段后 NFS/容器的处置。

## A. §8.2 逐条核对

| 编号      | 落实情况                                                                                                                                                                    | 结论                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴-A      | §1.6 通道一改为 LocalHandle 进程内交接，`exportLocalJobs`/`adoptLocalJobs` + `handle.handoff` latch；F12/F25/F26 入事实表                                                   | **方向完全正确**（这是我推荐的修法 1），但机制有两处硬缺陷 → 🔴-α / 🔴-β                                                                                                                                                      |
| 🔴-B      | §1.6 通道二 `adoptOrphans`，每次 session start（含 startup）await 于 recover 前；活主一律不动                                                                               | ✅ 语义正确、暴露面论证站得住（"主人已死"= flat 时代 adoption 既有语义）。竞态 claim 不成立 → 🟡-a                                                                                                                            |
| 🔴-C      | 筛选改为 foreign 判据补集 `hostPid>0 && !==me && probePid` 才跳过                                                                                                           | ✅ 与 `manager.ts:813-815` 完全同构；F9「adopted 不改写 hostPid」已入表                                                                                                                                                       |
| 🔴-D      | §3.3 改纯后缀模型：`.json`/`.log` 看 `isJobId(stem)`，`.tmp` 只要 `startsWith("b_") && endsWith(".tmp")`（F27）；整目录否决改逐文件放行                                     | ✅ 真实 tmp 名 `b_<id>.json.<pid>.<ts>.<seq>.tmp`（`job-store.ts:113-115`）确实以 `b_` 开头、以 `.tmp` 结尾——新规则命中。测试也要求用真实文件名                                                                               |
| 🟡-A      | 门控下沉条款级：`.tmp` 永不门控、retention 条款 `<=0` 跳过、rmdir 不依赖 retention、阶段 B/C 共用 `sweepJobFiles`                                                           | ✅ v2 的错位已消除，且与 `job-store.ts:237-244` 对齐                                                                                                                                                                          |
| 🟡-B      | 逐文件放行（陌生文件不动、不 veto、不 WARN）                                                                                                                                | ✅ 安全属性由白名单保证、可用性不再被一个 `.DS_Store` 摧毁                                                                                                                                                                    |
| 🟡-C      | 非终态豁免条款删除（非终态永不删）；**v2 §1.9 `host` 字段整节撤销**，schema 不动                                                                                            | ✅ 我推荐的减法被采纳，风险与实现量同时下降                                                                                                                                                                                   |
| 🟡-D      | `store.remove()` 硬修加 basename + `resolve()` 前缀双重校验，root 经 `extraLogRoot` 注入，否则只 WARN                                                                       | ✅ 不再把 unlink 目标交给不可信 JSON                                                                                                                                                                                          |
| 🟡-E      | `reconcileRootDir` 加 `skipDirNames`，阶段 A 跳过目标为 selfDirName 的记录                                                                                                  | ✅ 自重叠消除                                                                                                                                                                                                                 |
| 🟡-F      | root flat `.json` 终态出口并入 `sweepJobFiles`                                                                                                                              | ✅                                                                                                                                                                                                                            |
| 🟡-G      | 旧目录直接取 `prevManager.dir`，`previousSessionFile` 退出交接逻辑，`index.ts` 零改动                                                                                       | ✅ 我核了 `manager.ts:871 dir: store.dir` 是公共字段——推导链完全消失，in-memory 回归也随之消失。**这比我建议的"shutdown 时记模块级变量"更干净**                                                                               |
| 🟡-H      | `sweepHandoffRemnants` recover 后幂等复查                                                                                                                                   | ✅ 方向对，但依赖一个没有 barrier 的时序假设 → 🟡-c                                                                                                                                                                           |
| 🟡-I      | 三条把关用例入 §5.2（fork 退出码 / startup 孤儿 / adopted 后 fork）+ GC 真实 tmp 名等断言                                                                                   | ✅ 尤其"fork 后断言 `exitCode===7` 而非 exited_unknown"这条**会当场抓到 🔴-α**                                                                                                                                                |
| 🟡-J      | F12 重写为 dispose 真实语义，新增 F25/F26/F27                                                                                                                               | ✅ 三条我逐字复核：`manager.ts:936-955`（保留流/exitPromise）、`:400-409`（probeAdopted 靠 `store.load` 采纳）、`:229-243`（LocalHandle 字段含 `footerWritten` 幂等锁、`termination?`）、`job-store.ts:113-115`。**全部属实** |
| G1/🟢-1~6 | fileAge 导出 + 显式 undefined 分支、`writeAtomic` rename ENOENT 重试、`session-id` 标记文件、root 0700 连带、sanitize 磁盘契约注释 + 真实 `uuidv7()` 单测、碰撞 WARN 带预览 | ✅ 全落。sanitize 的 `UUIDV7_RE` 我对着 `pi-ai/dist/utils/uuid.js` 复核过（`0x70` 版本位、`0x80                                                                                                                               | ` 变体位、全小写）——匹配 |

**GC 小节到此我认为可以实施**：文件名模型、门控粒度、逐文件放行、非终态永不删、非递归 rmdir、
未来 mtime 不判、爆炸半径三后缀——已与 `pruneExpired` 完全同构，v1 指出的四缺陷叠加全部解开。

---

## 🔴 必须修复（两处定点，均在 §1.6/§3.6 的 latch 机制上）

### 🔴-α `handle.handoff` latch 只有"置位"和"检查"，没有"清位" → 新 manager 的 `finalizeLocal` 也会立即退场，终态永远无人落盘

**问题**：§3.6 规定 `finalizeLocal` 在 `await exitPromise` **之后第一步**检查 `if (handle.handoff) return entry.record;`，
而 `exportLocalJobs()` 同步置 `handle.handoff = true`；`adoptLocalJobs()` 则"重新发起 `finalizeLocal(jobId, entry, handle)`"。
**latch 是挂在共享 handle 对象上的布尔量，新 manager 跑的是同一个函数、同一个 handle** →
它 `await exitPromise` 之后同样看到 `handoff === true` → **同样直接 return，不写 footer、不 flush、不 persist**。

后果链（全部可从代码直接推出）：

- 终态无人落盘：旧侧退场、新侧也退场；
- 新 entry 有 `entry.local` → `probeAdopted` 第一行 `if (entry.local || record.status !== "running") return`（`manager.ts:400`）
  永远早退，没有任何兜底把它转成 `exited_unknown`；
- 于是该 job **永久停留在 `running`**：`bash_job list/status` 一直显示运行中，`bash_job wait` 永不 settle，
  `hasWork()`（`manager.ts:363-372`）永真 → **poll 计时器永不停**（对一个空闲会话，这也违反本项目"不唤醒空闲会话"的既有教条）；
- `maxBackgroundJobs` 槽位被永久占用（`backgroundJobCount` 只看内存记录 + `hostPid===me`，`manager.ts:861-868`）。

**依据**：plan §3.6（只有 set + check，无 clear）、§1.6 通道一（"重新发起 finalizeLocal"）；
`src/bash/manager.ts:552-572`（latch 检查点在 `await exitPromise` 之后）、`:400-409`、`:363-372`、`:861-868`。

**修法（推荐 owner token 而非清布尔）**：把 latch 换成**所有者标记**——

```
// LocalHandle: owner: object            // 每个 manager 构造时创建一个唯一 token
// finalizeLocal 入口捕获 const mine = handle.owner;（或直接用闭包内的 myToken）
// await exitPromise 之后：if (handle.owner !== myToken) return entry.record;
// exportLocalJobs(): 不动 owner；adoptLocalJobs(): handle.owner = myToken
```

为什么不是"adopt 时把布尔清成 false"：**A→B→C 连续交接**会同时存在两个 pending 的 `finalizeLocal`
（B 的那个还在 `await exitPromise`）。清布尔会让 B 与 C 的两个 awaiter 同时通过检查 → 双 `stream.end()`
（第二次触发 `ERR_STREAM_ALREADY_FINISHED`）+ 第二次 `applyTransition` 撞终态 sink → `transitionJob` 返回 not-ok →
I-a 的 WARN 噪音（footer 有 `footerWritten` 幂等锁，只有这一项是安全的）。owner token 是**身份判定**，
天然满足方案 §2 自己写下的不变量「每个在跑 job 的终态有且只有一个负责落盘的 writer」——
现在的布尔机制并不实现这条不变量。

**好消息**：§5.2 已计划的 manager 单测第二条（"adoptLocalJobs 后新 manager 完成终态落盘（新 store 收到正确 exitCode）"）
与集成用例 🟡-I①（fork 后断言 `exitCode===7`）**都会在实现阶段立刻抓到这条**，所以它不需要再走评审轮次，
按上面改即可。请把 A→B→C 双次交接也补成一条单测（见 🟡-d）。

### 🔴-β `exportLocalJobs` 必须排除"仍在前台"的 job：`create()` 的 `exit` promise 就是 bash 工具的返回值

**问题**：§1.6 的导出条件是"非终态 && 有 local handle"。但 `create()` 把 `finalizeLocal(...)` 的 promise
作为 `CreatedJob.exit` 返回，而前台路径的 bash 工具**正在 await 它并直接用它的 `exitCode`**：

```ts
const record = await job.exit; // src/tools/bash-tool.ts:483
if (options.signal?.aborted) throw new Error("aborted");
if (timedOut) throw new Error(`timeout:${options.timeout}`);
return { exitCode: record.exitCode }; // :485-486
```

latch 生效后，旧 `finalizeLocal` 在进程退出时返回的是**非终态快照**（`status: "running"`, `exitCode: null`）→
前台 bash 调用于是向模型返回 **`exitCode: null`**，而真实退出码被丢弃（或由新 manager 写进另一份记录，
模型看不到）。这是"命令实际 exit 0，模型收到 null"的静默错报。

触发条件：session_start 发生在前台 bash 调用在飞时。new/fork/resume 走 `teardownCurrent → await session.abort()`
（`agent-session-runtime.js`），会先中止工具调用（`options.signal.aborted` → 抛 "aborted"，不会错报）；
但 **`reload()` 通篇没有 abort**（`dist/core/agent-session.js:2210-2231`：emit shutdown → 重建 runtime → emit session_start），
而本项目 README 恰恰教用户"设置改动 `/reload` 后生效"。即使保守地认为 TUI 未必允许在工具调用期间执行 `/reload`，
把"谁还在等 `job.exit`"纳入导出条件也是**零成本的正确性加固**，不应把正确性押在别人的 UI 时序上。

**修法**：`exportLocalJobs()` 增加条件 `record.backgroundedAt !== undefined`。
依据：背景化之后没有任何人再消费 `job.exit`——阈值触发后工具走 `raced === "trigger"` 分支返回 job_id
并 `await manager.markBackgrounded(job.jobId)`（`bash-tool.ts:283-310`），`settled` promise 从此无人观察。
前台在飞的 job 留给旧 manager 自己收尾：它虽 disposed 但仍会落盘（F12/I-b），
reload 场景下 `prevDir === newDir` → 新 manager 的 `recover()` 已把它当 adopted 收下 →
旧 manager 写下终态后由 `probeAdopted` 的 `store.load` 采纳（F25 隐式链在同目录下依然成立）；
new/fork 场景下 abort 已先把它杀掉。两条路都不需要交接介入。

---

## 🟡 建议改进（实现期一并处理，不需再评审）

- **🟡-a 孤儿收养的"rename 原子，先迁先得，不会双收养"不成立**。`moveRecordFiles` 的第一个文件操作是
  `rename(.log)`，且规格明写"ENOENT 静默"（§3.5）——它**不是一次排他性认领**。两个几乎同时启动的进程 P/Q
  都在批量 `readRecords` 之后各自搬移同一条孤儿记录：P 先 rename 走日志，Q 的 rename 得 ENOENT → 按规格**继续** →
  Q 用自己内存里的快照 `writeAtomic` 出一份记录到 Q 的目录（`logPath` 指向一个不存在的日志，`fileSize` 静默返回 0，
  `manager.ts:966-972`）→ 双方 recover 都 adopt 同一个活 pid → **双通知、双 kill 责任、记录分叉**。
  tmux 会话恢复多面板、脚本并发起多个 pi 都会真实撞上。
  **修法（二选一，都很小）**：(a) 把认领做成原子操作——先 `open(join(toDir, jobId + ".json"), "wx")` 占位
  （EEXIST = 自己输了，直接 return），再 rename 日志、再 `writeAtomic` 覆盖占位；或用 `link(oldJson, target)`
  靠 EEXIST 互斥。(b) 最小改动：把日志 rename 的 ENOENT 从"静默继续"改成"**放弃该条记录**"
  （源 json/日志已消失 = 别人已认领），仅当记录本身没有日志（`staged`）时才允许继续。
  另外 §5.1 现有的"rename 竞合（目标已存在）幂等"只覆盖了"目标已存在"，覆盖不到这条"源已消失"的输家路径。
- **🟡-b `adoptOrphans` 的 `exclude` 参数类型对不上**：§3.4 传 `exclude: prevBashJobs?.dir`（**全路径**），
  §3.5 里却拿它和 `entry.name`（**目录名**）比较 → 条件永假。当前无害（旧目录里剩下的非终态记录要么
  `hostPid===me` 活着被"活主不动"跳过、要么已被通道一搬走），但实现者会照抄一个死条件。
  改成 `basename(prevManager.dir)` 或干脆删掉这个参数并在注释里说明"旧目录由通道一负责，这里重扫一遍是幂等的"。
- **🟡-c `sweepHandoffRemnants` 依赖一个没有 barrier 的时序假设**。旧 store 的 `enqueue` 串行链与新 store 无关，
  方案只论证了"窗口缩为 export 前已发出的写"，但没有任何机制保证那些写在 sweep **之前**落完。
  实践中大概率如此（sweep 排在 migrate+handoff+orphan+recover 之后），但一旦落在 sweep 之后，残留会以
  **非终态**形态留在旧目录——而 🟡-C 之后非终态永不删、且本进程活着期间 `adoptOrphans` 会因
  `probePid(hostPid)=alive` 永远跳过它 → 残留长期存在。届时另一个进程 resume 那个旧 session 时，
  `recover()` 会 `putRecord` 后才判 foreign（F9）→ **那条幻影 entry 会出现在别的会话的 `bash_job list` 里，
  连命令预览一起**，正是本方案要消除的泄露面。
  **修法**：给 manager 加一个 `drain(): Promise<void>`（把 store 的 enqueue 链尾 await 出来，
  `job-store.ts:98-108` 的链天然支持"追加一个 no-op 并等待"），在 sweep 前 `await prevManager.drain()`；
  或把 sweep 改成"重试两次、间隔一个 macrotask"。
- **🟡-d 测试补四条**（前两条是 🔴-α/🔴-β 的把关，必须有）：
  1. **前台在飞 + reload**：起一个前台 bash（不到阈值）→ emit session_start(reload) → 进程退出 →
     断言 bash 工具返回的 `exitCode` 是真实值（不是 `null`）；
  2. **exit 与 export 交叠的两个窗口**（用可控的 `exitPromise` 做确定性单测）：
     exit 早于 export（导出被跳过、走文件通道、终态不丢）、exit 恰在 export 与 adopt 之间（终态由新侧落盘）；
  3. **A→B→C 连续两次交接**：断言 footer 只有一行、`applyTransition` 无非法转移 WARN、退出码正确（owner token 的直接回归测试）；
  4. **交接时功能被关掉**（`autoBackgroundMs` 改 0 后 reload：prev manager 存在、新 manager 不存在）→
     断言不抛，旧 job 由旧 manager 自行收尾、记录留在旧目录并最终由 GC 按终态过期回收。
- **🟡-e `session-id` 标记文件的写入点缺失**。§3.5 只在 `moveRecordFiles` 里写它，正常 `create()` 路径
  建目录走的是 job-store 的 `writeAtomic → mkdir`（`job-store.ts:112`）→ **绝大多数 session 目录不会有标记文件**。
  这样 §1.1 说的"归属从名字形状升级为正向确认"落不了地（GC 也确实不能依赖它，否则就把旧目录全判成"不是我们的"）。
  **修法**：在 `buildBashJobManager` 建 store 之后 best-effort 写一次（0600），并在 §1.3 明确"标记文件是诊断辅助，
  GC 的归属判据仍是目录名白名单 + 逐文件后缀模型"——否则这个字段会给后来者错误的安全暗示。
- **🟡-f §3.3 伪代码两处笔误**：`sweepJobFiles` 用到了 `present`（判孤儿 log）但 v3 没再定义它（v2 有）；
  `.json` 分支的 `if record && isTerminal / else if (record) continue / else 不可读` 三分支顺序容易被读成两分支。
  实现时注意"孤儿 log 判定必须先建立 `present` 集合"，否则会把有记录陪着的 log 误判成孤儿（爆炸半径内、但会误删）。

---

## 🟢 可选优化 / 确认无碍

1. **交接后 teeChunk 的截断持久化会静默 no-op**：`manager.ts:508-514` 的 `applyPatch(outputTruncated)` 打在旧路径 →
   ENOENT no-op。但 `finalizeLocal` 的终态 patch 带 `outputTruncated: handle.truncated`（`:562-568`）会修回来。
   可接受，加一句注释即可。
2. **新 entry 的 `logBytes` 运行期滞后**（teeChunk 更新的是旧 entry）：与今天 adopted job 同构，
   `readBashJobTail` 的两遍读（`stack.ts:130-144`）本就是为此设计的。无需处理。
3. **reload 场景"前台 tool call 返回 + adopted 完成通知"的双报告是既有行为**（adopted 分支注释假定
   "nobody is waiting on its tool call anymore"，`manager.ts:817-820`），本方案不改变它，不必在本轮处理。
4. **`adoptLocalJobs` 建议顺手 `ensurePolling()`**：exit 是事件驱动的，pre-exit 不 poll 也正确，
   但加上更稳（也让 widget 的首帧与 `hasWork` 语义一致）。
5. **`moveRecordFiles` 写的是 export 时的内存快照**（不读盘合并）：本地 job 的内存记录是权威（`putRecord` 合并
   `logBytes/outputTruncated`），风险低；建议注释写明这是有意为之。
6. **NFS/容器（任务问题 5）**：撤销 `host` 字段后，处置方案是"**GC 的删除判定完全不依赖跨机 pid 探测**"
   （非终态永不删；终态只看 `endedAt/createdAt` 与 retention），`probePid/checkPidOwnership` 只参与"搬移"决策。
   我核过这个论证：多主机共享 home 时，异机活 job 的 `hostPid` 在本机探不到 → 被判孤儿 → 迁入本机并 adjudicate →
   Linux 上 `/proc` starttime 不匹配 → `exited_unknown`（非 Linux/无 `/proc` → `unsafe` → `orphaned`，**绝不杀**）。
   这个误判**在 flat 时代就存在且完全同源**（recover 的 foreign 判据也只有 `probePid`），v3 唯一的新增是
   记录被物理搬走而非就地改写——量级相同、且有 🔴-4 的通知收敛兜底。**结论：可接受**，
   但 README 应加一句"不支持多主机共享 `~/.pi` 的并发使用（后台任务可能被另一台主机标记为 `exited_unknown`）"，
   这比 v2 那个 `host` 字段更诚实、成本更低。我同意这笔减法。
7. **磁盘上界**：`hostPid` 恰被长命进程复用的非终态记录会永久滞留（永不 adopt、永不删），几 KB 量级，可接受。
8. **事实表复核**：F12/F25/F26/F27 四条新增事实与源码逐字吻合（`manager.ts:229-243`、`:400-409`、`:552-572`、
   `:936-955`、`:871`、`job-store.ts:113-115`、`stack.ts:59/265/526`、`bash-tool.ts:483`）。
   除 🟡-b（`exclude` 语义）与 🟡-e（标记文件写入点）两处正文内不一致外，未发现新的事实错误或自相矛盾。

---

## 总体结论：**修改后通过 —— 不再需要评审轮次，按 🔴-α/🔴-β 定点修正后即可实施**

v3 的方向判断我完全认可：GC 已经收敛为 `pruneExpired` 的忠实同构（🔴-D 的文件名模型、🟡-A 的条款级门控、
🟡-B 的逐文件放行、🟡-C 的"非终态永不删"），v1/v2 指出的删数据路径全部关闭；
`host` 字段的撤销是一笔漂亮的减法（少一个持久化字段、少一整节 NFS 语义，而 GC 的正确性反而更强）；
🟡-G 用 `prevManager.dir` 取代路径解析比我建议的方案更干净，还顺手消灭了 in-memory session 的回归；
🔴-B 的孤儿收养把 README:91 的"重启后收养"契约真正补回来了，且"活主一律不动"的暴露面论证成立；
🔴-C 的筛选改成 foreign 判据补集，与 `manager.ts:813-815` 严格同构。§1.6 的双通道覆盖矩阵
（startup→孤儿收养；reload→通道一同目录；new/fork/进程内 resume→通道一跨目录；quit→shutdownPolicy）
是五种 reason 的第一份完整推演，这一轮的设计工作是扎实的。

剩下的两条 🔴 都不是设计问题，而是**同一个机制（latch）的两处定点缺陷**，改动各在十行以内、修法唯一、
且方案自己计划的测试就能把关：

- **🔴-α**：latch 只有 set/check 没有 clear，新 manager 的 `finalizeLocal` 会一并退场 →
  终态永不落盘、job 永久 `running`、poll 永不停。**改成 owner token 身份判定**（顺带解决 A→B→C 双 awaiter），
  这样才真正实现方案 §2 自己写下的"每个在跑 job 的终态有且只有一个 writer"不变量。
- **🔴-β**：`exportLocalJobs` 必须只导出 `backgroundedAt !== undefined` 的 job——
  前台在飞 job 的 `exit` promise 是 bash 工具的返回值（`bash-tool.ts:483-486`），
  latch 会让它以 `exitCode: null` 错报（`reload()` 不 abort 在飞工具调用，`agent-session.js:2210-2231`）。

另有 6 条 🟡 请在实现期一并处理，其中 **🟡-a（孤儿认领不是排他操作 → 并发启动可能双收养）** 和
**🟡-c（sweep 前缺 drain barrier → 幻影 entry 泄露到别的会话）** 是代码级的，各约五行；
🟡-b/e/f 是正文自相矛盾或伪代码笔误；🟡-d 是四条补测（前两条是 🔴 的把关测试）。

按 §7 的顺序实施即可，**§1.6 无需再单独走一轮短评审**——把 🔴-α 的 owner token、🔴-β 的导出条件、
🟡-a 的排他认领、🟡-c 的 drain 直接写进实现，并让 🟡-d 的四条测试在 CI 里把关，比再来一轮文档评审更划算。
