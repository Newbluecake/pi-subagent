# bash 后台任务存储按 session 隔离 — 实施方案

> 状态：**v3.1（终审定点修订版）**，已按 `review-opus.md`「# v3 终审」（结论：修改后通过，无需再评审轮次）修正 latch 机制两处定点缺陷；只做设计与改动清单，不含实现代码。
> 变更摘要：§8.1 = v1→v2，§8.2 = v2→v3，§8.3 = v3→v3.1（逐条对应终审编号）。
> 约束：不改公共 API 形状（job-store 仍注入 `dir`，仅允许**附加**可选字段；manager 仅**新增**方法）；保持 tmp+rename 原子写与 0600 权限；bash/bash_job 对外行为不变（除 list/status 只见本 session）。

---

## 0. 已确认的代码事实（方案依据；v3 已按复审 🟡-J 修正/补充）

| #   | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 依据                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F1  | `currentSessionId(ctx)` 读 `ctx.sessionManager.getSessionId()`，异常/缺失时返回 `""`                                                                                                                                                                                                                                                                                                                                                                                                         | `src/stack.ts:153-159`                                                                         |
| F2  | `getSessionId()` 返回 `this.sessionId`（初值 `""`）；新 session 用 `uuidv7()`（版本位 7、变体位 10、全小写 hex，36 字符）                                                                                                                                                                                                                                                                                                                                                                    | `session-manager.js:720-722, 12-14, 587`；`pi-ai/dist/utils/uuid.js`                           |
| F3  | **resume 复用同一 sessionId**（`header.id`）                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `session-manager.js:634`                                                                       |
| F4  | new / branch / fork 都换新 id                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `session-manager.js:651, 1097, 1256`                                                           |
| F5  | `assertValidSessionId` 允许 `[A-Za-z0-9._-]`、大小写混用、不限长度；`newSession({id})`/`forkFrom({id})` 允许指定 id                                                                                                                                                                                                                                                                                                                                                                          | `session-manager.js:15-20, 649, 1254`                                                          |
| F6  | stack 每次 `session_start` 重建；reason 五种：startup/reload/new/resume/fork；`previousSessionFile` **只在 new/resume/fork 传**（startup 没有）；`session_shutdown` 有 `targetSessionFile?`                                                                                                                                                                                                                                                                                                  | `src/index.ts:209-222`；`types.d.ts:415-422, 478-483`                                          |
| F7  | 注入点：`dir: config.dir ?? join(getAgentDir(), "bash-jobs")`（:170），`sessionId`（:182）、`hostPid`（:183）；call site :525                                                                                                                                                                                                                                                                                                                                                                | `src/stack.ts:167-212, 525`                                                                    |
| F8  | job-store flat 单目录；`pruneExpired`：非终态永不删、过期按 `endedAt ?? createdAt`、不可读记录/孤儿 log 按 mtime、`.tmp` 固定 1h TTL（不受 retention 门控）、`fileAge` 对未来 mtime 返回 undefined=不判、爆炸半径仅 `.json/.log/.tmp`、`retentionEnabled = retentionMs > 0`、文件名分类为**纯后缀模型**（`.json`/`.log` 看 stem 是否 isJobId，`.tmp` 只看后缀）                                                                                                                              | `src/bash/job-store.ts:91-92, 140, 213-285, 180-198, 236-244`                                  |
| F9  | `recover()` 分支：localJobs 跳过 → terminal 入库 → staged→failed → foreign（hostPid 活且非我）→ adopted（**不重写 hostPid**，只补 backgroundedAt）→ exited_unknown → orphaned                                                                                                                                                                                                                                                                                                                | `src/bash/manager.ts:785-855, 817-826`                                                         |
| F10 | `recover()` fire-and-forget 触发，失败只 WARN                                                                                                                                                                                                                                                                                                                                                                                                                                                | `src/stack.ts:578-590`                                                                         |
| F11 | `JobRecord.sessionId` parse 缺省 `""`；`parseJobRecord` 白名单重建（新字段必须显式加）                                                                                                                                                                                                                                                                                                                                                                                                       | `src/bash/types.ts:87, 320-345`                                                                |
| F12 | **（v3 修正）**`dispose()`：清 poll 计时器 + 结算全部 waiters；**故意不**发信号、**不关闭日志流、不取消 `exitPromise` 回调**——「the log streams stay open so an in-flight job keeps capturing output for the next stack to adopt」。即 **disposed manager 的 `finalizeLocal` 仍会跑完并向旧 store 路径落盘终态**（其 `ensurePolling`/`deliverNotice` 因 disposed 静默，I-b：persists but never notifies）                                                                                    | `src/bash/manager.ts:936-955, 552-572, 412-431`                                                |
| F13 | bash_job list 直接返回 `manager.list()`；描述文案 253-263                                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/tools/bash-job-tool.ts:278-282, 253-263`                                                  |
| F14 | `bashJobs.dir` 仅 JSON 可配                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `src/config/settings.ts:72`、`src/config/setting-specs.ts:172`                                 |
| F15 | `readOutput` 读**持久化字段** `record.logPath`；工具文案同。`store.logPath(jobId)` 只在 `create()`/`store.remove()` 用                                                                                                                                                                                                                                                                                                                                                                       | `src/bash/manager.ts:686, 693`；`bash-job-tool.ts:151/224/319/339/348`；`job-store.ts:92, 174` |
| F16 | `store.remove()` 按**计算路径**删日志，读取按**记录字段**——分叉时"记录删了日志泄留"                                                                                                                                                                                                                                                                                                                                                                                                          | `src/bash/job-store.ts:170-175` vs F15                                                         |
| F17 | `checkPidOwnership(record)` 三级 alive/dead/unsafe（pid + `/proc` starttime + 启动时间兜底），unsafe 绝不杀（I-c）                                                                                                                                                                                                                                                                                                                                                                           | `src/bash/process.ts:210-230`                                                                  |
| F18 | running 记录**不周期落盘**（只 staged:591 / running:623 / 终态:562 三处）；append 日志不更新目录 mtime                                                                                                                                                                                                                                                                                                                                                                                       | `src/bash/manager.ts:509, 562, 591, 623`                                                       |
| F19 | `shouldNotifyJob` 只看**内存**记录；`applyPatch`→`store.update` 在磁盘记录缺失时返回 undefined（ENOENT 连 WARN 都不打）→ 不收敛则每 2s 重发 + triggerTurn                                                                                                                                                                                                                                                                                                                                    | `manager.ts:215-217, 354-372, 412-431`；`job-store.ts:128-134, 164-166`                        |
| F20 | session 文件名 `${fileTimestamp}_${sessionId}.jsonl`（fileTimestamp 不含 `_`）；但 `--session <path>` 允许任意文件名，且新 session 文件**推迟到首个 assistant 消息才落盘**——路径解析两条路都可能失败                                                                                                                                                                                                                                                                                         | `session-manager.js:669`、`_persist` 的 hasAssistant 守卫、`createBranchedSession` 同守卫      |
| F21 | 新 session header 带 `parentSession`（仅持久化模式）                                                                                                                                                                                                                                                                                                                                                                                                                                         | `session-manager.js:659, 1107, 1267`                                                           |
| F22 | `isJobId`：`/^b_[0-9A-HJKMNP-TV-Z]{8}$/`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `src/bash/ids.ts:11`                                                                           |
| F23 | 前台跑完的 job 由 `discardForeground` 删记录，**目录残留为空**                                                                                                                                                                                                                                                                                                                                                                                                                               | `src/bash/manager.ts:437-450`                                                                  |
| F24 | 注释矛盾：`settings.ts:68`「0 = prune immediately」 vs `job-store.ts:22`「`<=0` disables」——以后者为准                                                                                                                                                                                                                                                                                                                                                                                       | 同上                                                                                           |
| F25 | **（v3 新增）隐式交接链**：旧 manager 的 `finalizeLocal → applyTransition → store.update` 写旧路径终态；新 manager 把同一 job 当 adopted 收下后，`probeAdopted` 每 tick 先 `store.load(jobId)`，**读到旧 manager 刚写的终态就 putRecord 采用**（退出码/finalText/footer 全对）。**同一磁盘路径是这条链的前提**——把记录文件搬走会让旧 manager 的 `store.update` 在旧路径 ENOENT 静默失败 → 终态无人落盘 → 新 manager 判 `exited_unknown`、退出码丢失（且日志 footer 显示正常 exit，自相矛盾） | `manager.ts:552-572, 400-409, 335-352`；`job-store.ts:128-134`                                 |
| F26 | **（v3 新增）LocalHandle 结构**：`{ spawned(含 exitPromise), stream, flush, written, truncated, closed, atLineStart, footerWritten(幂等锁), termination? }`；`create()` 把 `teeChunk(entry, handle)` 绑到 stdout/stderr，`finalizeLocal(jobId, entry, handle)` fire-and-forget 等 exitPromise 后：appendLogFooter（footerWritten 幂等）→ flush → stream.end → applyTransition 落盘。`previousBashJobs` 是 stack.ts 模块级变量（:59），buildSessionStack 顶部 dispose（:265）、:526 重新赋值  | `src/bash/manager.ts:230-243, 575-641`；`src/stack.ts:59, 265, 526`                            |
| F27 | 真实 tmp 文件名是 `b_<id>.json.<pid>.<ts>.<seq>.tmp`，**不匹配** `b_<isJobId>.tmp`                                                                                                                                                                                                                                                                                                                                                                                                           | `src/bash/job-store.ts:113-115`                                                                |

---

## 1. 决策结论（对应任务书 8 个点；v3 修订）

### 1.1 目录结构 → `<root>/<sessionDirName>/`（同 v2，sanitize 不变）

```
<root>/                              root = settings.bashJobs.dir ?? ~/.pi/agent/bash-jobs
  <sessionDirName>/                  sanitizeSessionDirName(sessionId)，mkdir mode 0o700
    session-id                       标记文件：原始 sessionId 一行（🟢-4，正向归属 + 调试）
    b_<jobId>.json / b_<jobId>.log / b_<jobId>.json.<pid>.<ts>.<seq>.tmp
  _unscoped/                         sessionId 为空/非法时的兜底桶（多主共享，§1.3）
  b_<jobId>.json / .log / .tmp       旧版 flat 遗留（仅迁移期存在，§1.7、§3.2）
```

- **sanitize（🟡-7/8 决策，同 v2）**：uuidv7 形状（版本位/变体位已核对真实实现，F2）原样保留；其余合法 id → `lower(id).slice(0,48)` 去尾非 alnum + `-` + `sha256(id).slice(0,8)`（≤57 字符，解决大小写不敏感 FS 碰撞与 ENAMETOOLONG）；非法/空 → `_unscoped`。全量 hash 方案否决定于"目录可读性 > id 保密性"（id 非机密）。
- **🟢-5 声明**：`sanitizeSessionDirName` 是**磁盘契约**——改它等于改磁盘布局，老目录变孤儿；函数注释写明，单测用真实 `uuidv7()` 输出断言走原样分支。
- **目录权限（🟡-4）**：`JobStoreOptions` 附加 `dirMode?: number`，stack 传 `0o700`；`recursive` mkdir 对**新建层级**生效 → 新装用户的 root 也会是 0700（🟢-3，写明确认是想要的效果）；`manager.ts:591` 的 `mkdir(store.dir)` 与 `session-dirs.ts` 的建目录都带同一 mode（谁先谁定权限）。
- **🟢-4 标记文件**：每个 session 目录写一个 `session-id` 文本文件（原始 sessionId，0600）。**写入点两处（🟡-e 修正）**：`buildBashJobManager` 建 store 之后 best-effort 写一次（正常 `create()` 路径只走 job-store 的 mkdir，不写标记）+ `moveRecordFiles` 建目标目录时。**定位是诊断辅助**：GC 的归属判据仍是目录名白名单 + 逐文件后缀模型，不依赖标记文件存在与否（否则旧目录会被误判为"不是我们的"）。前提：GC 已改逐文件放行（🔴-D/🟡-B），标记文件不会 veto 目录；它是 GC 的"已知文件"，仅当目录只剩它时随 rmdir 一并清掉。

### 1.2 recover 语义 → 逻辑不变，扫描面收窄（v3：交接/收养全部在 recover 之前落位）

所有分支保留（F9）。recover 看到的目录内容由启动编排（§3.4）先行准备好：本 session 迁移（§1.7）→ 进程内交接（§1.6）→ 孤儿收养（§1.6）→ 然后才 `recover()`。foreign 分支仍防"同一 session 被两个活进程同时打开"。

### 1.3 死 session 兄弟目录 GC（v3 修正：🔴-D 文件名模型、🟡-A 门控、🟡-B 逐文件放行、🟡-C 删豁免）

新模块 `src/bash/session-dirs.ts`。GC 是 `pruneExpired` 的忠实同构。**与 v2 的三处硬修正**：

1. **文件名分类照抄 `pruneExpired` 的后缀模型（🔴-D）**：`.json`/`.log` 要求 stem 是 `isJobId`；`.tmp` 只要求 `startsWith("b_") && endsWith(".tmp")`（真实 tmp 命名见 F27）；外加字面量 `session-id`（§1.1 标记文件）。**其余任何条目：永不删除，但不再 veto 目录**。
2. **整目录一票否决 → 逐文件放行（🟡-B）**：陌生文件（`.DS_Store`/`.swp`/用户文件）只是"不动它"，不阻止已识别文件清理、不阻止 rmdir 尝试（rmdir 遇到非空自然失败，静默）。安全属性"绝不删不认识的文件"由逐文件白名单保证。
3. **非终态记录永不删除（🟡-C，严格版 🔴-1）**：删掉 v2 的"host 本机 + checkPidOwnership=dead + 过期"豁免条款——非终态记录是"未结算凭证"，不该由清理程序销毁。磁盘收敛改由 🔴-B 孤儿收养保证（孤儿被下一会话接管 → 走正常终态 → 终态过期删除）。**连带：`JobRecord.host` 字段不再必要，v2 §1.9 整节撤销**（不动 schema、不动 parseJobRecord；NFS/容器场景仅剩一句说明：GC 的删除判断不依赖任何跨机 pid 探测——probePid/checkPidOwnership 只用于"搬移"决策，误把异机活 job 判孤儿而收养是与 flat 时代 recover 相同的既有语义，不新增暴露面）。

保留的 v2 规则：目录名白名单（`VALID_ID_RE` 或 `_unscoped`，其余跳过不 WARN——root 里放别的东西是用户的自由，符号链接等 `!isDirectory()` 忽略）；逐文件 unlink + 非递归 rmdir；`fileAge` 从 job-store 导出复用（mtime 在未来=不判，G1/🟢-2 显式 `age === undefined → continue` 分支）；每次 unlink 紧邻判龄（🔴-7）；ENOENT 静默、其余 WARN。

**retention 门控下沉到条款级（🟡-A，修正 v2 错位）**：

- `.tmp` 分支：**永不门控**（对齐 job-store.ts:237-244）——root 与兄弟目录都一样；
- 依赖 `retentionMs` 的分支（终态记录、不可读 json、孤儿 log、root flat 兜底）：`retentionMs <= 0` 时逐条跳过；
- 空目录 rmdir：**不依赖 retention**（🟡-3）；
- 阶段 B（root flat 残留清扫）与阶段 C（兄弟目录）共用同一个 `sweepJobFiles(dir, opts)`，同一套门控——杜绝 v2"阶段 B 在门控外"的错位。

完整伪代码见 §3.2/§3.3。

### 1.4 settings.bashJobs.dir 语义 → root 化（同 v2，🟡-5 维持 WARN-only）

`dir` = root，其下一律按 sanitize 分层；不加 `scope` 开关（两布局翻倍 GC/迁移/测试矩阵，迁移已保全数据）；root 下发现 flat `b_*.json` 时启动 WARN 一次。README 的 `dir` 行、「日志与敏感输出」「目录清理」小节同步修订。

### 1.5 shutdownPolicy 交互 → 无冲突，零改动（同 v2）

`quit` 只杀内存 entries；reload/resume(同 id) 走同目录 recover；new/fork/换 id resume 走 §1.6 交接；startup 走孤儿收养。五种 reason 全覆盖（§1.6）。

### 1.6 fork/new/startup 契约 —— **v3 全部重写**（🔴-A/🔴-B/🔴-C、🟡-G/🟡-H/🟡-I）

**契约**：index.ts:235-238 注释与 README「重启/reload 后收养」承诺「reload/new/resume/fork 一律保留，下一个 stack 收养并继续通知」+「重启后收养」。

**v2 方案为什么被推翻（🔴-A 机理，依据 F12/F25/F26）**：v2 把记录文件从旧 manager 的 store 路径搬走。但 `dispose()` 故意保留 LocalHandle/日志流/exitPromise（F12），旧 manager 的 `finalizeLocal` 在 dispose 后仍会跑完并向**旧 store 路径** `store.update` 落终态——文件已被搬走 → ENOENT **静默**失败（F19/F25）→ 真实退出码无处落盘；新 manager 侧该 job 无 local handle → `probeAdopted` 探到 pid 死 → `store.load` 读不到终态 → 判 `exited_unknown`。而日志流 fd 跟 inode 走（rename 不影响），footer 显示正常 exit——`bash_job status` 与 `tail` 自相矛盾。**结论：进程内交接必须交接 LocalHandle 所有权，不能只搬文件。**

**v3 设计：双通道交接**

**通道一（进程内，覆盖 reload/new/fork/进程内 resume）——LocalHandle 交接（🔴-A 采纳推荐修法 1）**：

`previousBashJobs` 已是 stack.ts 模块级变量（F26）。manager 新增两个方法（纯增量，不破 API 形状）：

```ts
interface LocalJobHandoff { jobId: JobId; record: JobRecord; handle: LocalHandle; }

// 旧 manager（dispose 之后调用；dispose 已停 poll/notify，F12）
exportLocalJobs(): LocalJobHandoff[] {
  // 只导出「非终态 && 有 local handle && record.backgroundedAt !== undefined」的 job（🔴-β，见下）；
  // 终态的由文件通道/旧目录 GC 处理。导出时【不动 handle.owner】，仅
  // entries.delete + localJobs.delete（旧 manager 彻底放手内存表）
}

// 新 manager
adoptLocalJobs(handoffs: LocalJobHandoff[]): void {
  // 对每个 handoff：entry = ensureEntry(record)；entry.local = handle；localJobs.add(jobId)；
  // handle.owner = myToken（接管所有权，见下）；重新发起 finalizeLocal(jobId, entry, handle).catch(warn)
  // —— 由新 manager 写 footer/flush/end stream/applyTransition 落盘到【新 store】
  // → 退出码正确、通知正确（deliverNotice 在新 manager 活着）；顺手 ensurePolling()（🟢-4 终审）
}
```

- **所有权机制：owner token，而非布尔 latch（🔴-α 修正）**。v3 的 `handle.handoff` 布尔只有 set/check 没有 clear：新 manager 的 `finalizeLocal` 跑的是同一个函数、同一个共享 handle，`await exitPromise` 后同样看到 latch 为真 → 同样退场 → 终态永不落盘、job 永久 `running`（`probeAdopted` 第一行因 `entry.local` 存在而早退，无兜底）、`hasWork()` 永真 poll 不停、槽位永久占用。改为**身份判定**：
  ```
  // LocalHandle 增加字段：owner: object        // 每个 manager 构造时创建唯一 token（如 `const myToken = {}`）
  // create() 建 handle 时 owner = myToken
  // finalizeLocal 入口：const mine = myToken（闭包捕获，不读 handle）
  // await exitPromise 之后第一步：if (handle.owner !== mine) return entry.record;   // 只有当前 owner 负责落盘
  // exportLocalJobs(): 不动 owner；adoptLocalJobs(): handle.owner = myToken（新 manager 的 token）
  ```
  不能用"adopt 时把布尔清回 false"：**A→B→C 连续交接**时 B 的 `finalizeLocal` 还在 `await exitPromise`，清布尔会让 B、C 两个 awaiter 同时通过检查 → 双 `stream.end()`（`ERR_STREAM_ALREADY_FINISHED`）+ 重复 `applyTransition` 撞终态 sink（I-a WARN 噪音）。owner token 天然满足 §2 不变量「每个在跑 job 的终态有且只有一个负责落盘的 writer」。残余窗口（exit 恰好先于 export、旧 finalizeLocal 已越过检查点）：两侧各写一份终态，旧目录那份由 🟡-H 复查清掉；footer 有 `footerWritten` 幂等锁（F26）不会双写。
- **🔴-β 导出条件必须含 `backgroundedAt !== undefined`**：`create()` 返回的 `CreatedJob.exit` 就是前台 bash 工具的返回值（`bash-tool.ts:483-486` `const record = await job.exit; ... return { exitCode: record.exitCode }`）。前台在飞的 job 若被交接，旧 `finalizeLocal` 退场后该 promise resolve 出非终态快照 → 模型收到 `exitCode: null` 的静默错报。new/fork/resume 走 `teardownCurrent → session.abort()` 会先中止工具调用（抛 "aborted"，不错报）；但 `reload()` **不 abort 在飞工具调用**（`agent-session.js:2210-2231`），而 README 正教用户"设置改动 /reload 后生效"——正确性不能押在 UI 时序上。背景化之后无人再消费 `job.exit`（阈值触发走 `raced === "trigger"` 分支返回 job_id，`bash-tool.ts:283-310`），故导出条件收窄到 backgrounded 的 job 是零成本加固。被排除的前台 job 留给旧 manager 自行收尾：reload 场景 `prevDir === newDir`，新 `recover()` 已将其收养，旧 manager 写下终态后由 `probeAdopted` 的 `store.load` 采纳（F25 隐式链在同目录下成立）；new/fork 场景 abort 已先杀掉它。两条路都不需要交接介入。
- **stdout/stderr 的 `data` 监听不动**：`teeChunk` 闭包引用旧 entry 与**共享的 handle 对象**——输出继续写同一个 stream（fd 跟 inode，rename 安全），`handle.written` 计数正确；旧 entry.record 的 logBytes 更新落在死对象上，新 entry 的 logBytes 运行期滞后——与今天 adopted job 完全同构（`readBashJobTail` 两遍读就是为此设计，stack.ts:130-144），终态由新 finalizeLocal 持久化真实值。`init.onData`（旧 bash 工具回调）继续触发到死上下文，与今天 reload 行为相同。
- **文件归位**：`adoptLocalJobs` 前，对每个 handoff 记录执行崩溃安全搬移（复用 §3.5 `migrateOne` 的三步）：`rename(log → 新目录)` → 新 store `save({...record, logPath: 新计算路径, sessionId: 新id})`（0600）→ `unlink` 旧 json。目标已存在 → 跳过 + WARN（带两条记录的 createdAt/command 预览，🟢-6）。
- **旧目录中非 local 的该走记录**（上一 session 里已是 adopted 的 job、staged、终态未通知）：无 LocalHandle 可交，走文件通道——筛选条件为 **🔴-C 修正版**（只跳过活的 foreign，与 `manager.ts:813-815` foreign 判据的补集一致）：
  ```
  if (record.hostPid > 0 && record.hostPid !== process.pid && probePid(record.hostPid)) continue;  // 活的 foreign，不动
  if (!isTerminal(record.status) || shouldNotifyJob(record)) → 搬移（三步顺序，重写 sessionId+logPath）
  ```
  adopted 分支不重写 hostPid（F9）→ 被收养过的 job（hostPid=死 pid）由此正确进入交接，堵住"resume 后再 fork 又丢一次"。
- **🟡-G 落实：不解析 session 文件路径**。旧目录直接从 `prevManager.dir` 拿（manager 公共字段），无需 `previousSessionFile` 推导、无需模块级记 sessionId——信息全在内存。**附带收益：in-memory session 的回归消失**（进程内交接不依赖 session 文件是否存在）。`previousSessionFile` 不再参与交接逻辑。
- **🟡-H 落实**：交接+recover 完成后对旧目录做一次幂等复查 `sweepHandoffRemnants(prevDir, newManager.list() 的 jobId 集合)`：删掉 jobId 已归本 session 的残留 json/log（来源：export 前已发出的 mid-flight patch——如 outputTruncated/staged→running——在文件搬走后落回旧路径）。🔴-A 修复后窗口只剩"export 前已发出的写"，一次复查即收敛；不删的代价是 🟡-H 推演的"resume 旧 session 双管理"。
- **reload/同目录**：`prevManager.dir === newManager.dir` → 跳过一切文件操作，纯 `adoptLocalJobs`——比今天靠 `probeAdopted` 轮询采纳（F25）更快更直接，隐式链从"依赖同路径巧合"升级为显式交接。

**通道二（跨进程，覆盖 startup/跨进程 resume）——孤儿收养扫描（🔴-B 采纳推荐修法 1）**：

`reason: "startup"` 无 `previousSessionFile`、无 `previousBashJobs`（F6）→ 通道一不适用。新 stack 启动编排里（await，在 recover 之前）扫 root 下**全部白名单兄弟目录**，把**孤儿记录**迁入本 session 目录：

```
孤儿判据：非终态 && !(record.hostPid > 0 && probePid(record.hostPid))     // host 死或 hostPid=0
```

- 活主一律不动 → **不泄露活会话的 job**；暴露面仅限"主人已死的遗留 job"= flat 时代 adoption 的既有语义，不是新增暴露面。
- 迁入用 §3.5 `migrateOne` 三步（重写 logPath + sessionId），随后 `recover()` 走既有分支：job 活 → adopted；job 死 → `exited_unknown`（诚实标注）；staged → failed。通知由 recover 的 pendingNotices 正常发出。
- 与"resume 同 session"的竞合：rename 原子，先迁先得；后到的 loadAll ENOENT 跳过。不会双收养。
- 每次 session start 都跑（不只 startup）——统一、幂等；成本是白名单目录各一次 readdir+记录解析，与 GC 扫描同量级。
- README 写明"主人已死的后台任务会被下一个新会话接管并通知"。

**契约覆盖矩阵（v3）**：startup→孤儿收养；reload→通道一（同目录）；new/fork/进程内 resume→通道一（跨目录）；quit→shutdownPolicy（不变）。README:91 承诺完整恢复。

### 1.7 兼容/迁移（v2 收紧版保留 + 🟡-E/🟡-F 补充）

启动时对 root 下 flat 遗留 `b_*.json`（`isJobId` 匹配）逐条：

- 跳过条件（🔴-5，不分状态）：`hostPid > 0 && probePid(hostPid)` → 跳过（含 `=== process.pid`，pid 回收误判宁可不迁）。即只迁 host 已死的记录。
- 目标已存在 → 跳过 + WARN（🟢-6：WARN 带两条记录的 createdAt/command 预览）。
- 崩溃安全顺序：`rename(.log)` → 原子写新 `.json`（tmp+rename、0600、**重写 `logPath`**，F15 必须项）→ `unlink` 旧 `.json`。
- `sessionId` 空/非法 → `_unscoped/`。
- 编排（🟡-1）：本 session 的迁移 **await** 在 `recover()` 之前；其他 session 的迁移与 GC 合并 fire-and-forget。
- **🟡-E 防重叠**：`reconcileRootDir` 接 `skipDirNames: [selfDirName]`——阶段 A 跳过目标为 selfDirName 的记录（本 session 迁移已由 await 通道完成）；测试断言同一文件不迁移两次。
- **🟡-F 终态出口**：root 下无法迁移的 `.json`（活主跳过/损坏/rename 持续失败）进入阶段 B 兜底：可读且终态且过期 → 删（连同 log）；不可读且 mtime 过期 → 删（连同 log）；非终态一律保留（与 🟡-C 一致）。
- **store.remove() 硬修 + 🟡-D 防护**：删记录前先读记录，若 `record.logPath` 与计算路径不同**且** `basename(record.logPath) === \`${jobId}.log\``**且**`resolve(record.logPath)`位于`resolve(root)`之下（root 由`JobStoreOptions`新增可选`extraLogRoot` 传入，stack 传 rootDir；缺省=不删第二路径）→ 才 unlink 第二路径，否则只 WARN。堵"记录删了日志泄留"（F16）且不把 unlink 目标交给不可信 JSON 内容。

### 1.8 通知风暴防御（🔴-4，同 v2）

`deliverNotice`：`applyPatch` 返回 undefined（记录被外部删除/搬走）→ 内存标记 `notifiedAt`，通知收敛为一次。独立于我方 GC/交接正确性的纵深防御。

### 1.9 ~~JobRecord.host 字段~~ → **v3 撤销**（🟡-C）

非终态记录永不删后，host 字段只剩诊断价值；不新增持久化字段（省 parseJobRecord 白名单改动、NFS 语义与容器文档整节）。NFS/容器仅剩一句（§1.3 第 3 条末）。

### 1.10 文案与文档（同 v2）

工具描述事实化（`list (this session's jobs)` + `status/list only show jobs started by this session`）；README 写明"可见性隔离非 OS 边界"、`session-id` 标记文件、孤儿接管语义；`settings.ts:68` 注释统一「`<=0` disables」（F24）。

---

## 2. 目标结构 & 不变量（v3）

- job-store API 形状不变，仅附加可选 `dirMode` / `extraLogRoot`；manager **新增** `exportLocalJobs`/`adoptLocalJobs`（纯增量）。原子写/0600 不动。
- **隐式链不变量（F25）升级**：任何交接方案必须保证"每个在跑 job 的终态有且只有一个负责落盘的 writer"——v3.1 由 `handle.owner` token 显式转移该职责（布尔 latch 不实现此不变量，🔴-α）。
- 目录数量 ≈ 近 retention 窗口内有未清理 job 的会话数（空目录即建即收）。
- 错误分类统一：ENOENT 静默，其余 WARN。
- `maxBackgroundJobs` 计数不受影响。

---

## 3. 新逻辑伪代码（v3）

### 3.1 `sanitizeSessionDirName`（同 v2，🟢-5 磁盘契约注释）

见 §1.1。

### 3.2 `reconcileRootDir` 总编排（🟡-A/E/F、🔴-D、G2/G3）

```ts
reconcileRootDir({ rootDir, selfDirName, skipDirNames = [selfDirName], retentionMs, clock, probePid, warn }):
  // 阶段 A：flat 遗留迁移（不受 retention 门控；🔴-5 规则见 §3.5）
  for name of readdir(rootDir):                        // ENOENT → return
    if isJobId(stem(name)) && name.endsWith(".json"):  // G2
      await migrateOne(join(rootDir, name), { skipDirNames })   // 🟡-E：目标 ∈ skipDirNames → 跳过
  // 阶段 B：root flat 残留清扫（🟡-F 兜底 + G3；与阶段 C 同一 helper、同条款级门控 🟡-A）
  sweepJobFiles(rootDir, { retentionMs, clock, warn, isRoot: true })
  // 阶段 C：兄弟目录 GC
  for entry of readdir(rootDir, withFileTypes):
    if !entry.isDirectory(): continue                  // 符号链接等忽略
    if entry.name === selfDirName: continue
    if !(VALID_ID_RE.test(entry.name) || entry.name === "_unscoped"): continue   // 目录名白名单
    await gcSessionDir(join(rootDir, entry.name), { rmdirSelf: entry.name !== "_unscoped" })
```

### 3.3 `sweepJobFiles` / `gcSessionDir`（🔴-D 后缀模型 + 🟡-B 逐文件放行 + 🟡-A 条款级门控 + 🟡-C 非终态永不删）

```ts
// 文件分类（🔴-D，照抄 pruneExpired 后缀模型）：
//   known = (endsWith(".json" | ".log") && isJobId(stem))
//         || (startsWith("b_") && endsWith(".tmp"))          // 真实 tmp 命名 F27
//         || name === "session-id"                            // 🟢-4 标记文件
//   未知条目：永不删除，不 veto、不 WARN（🟡-B）

sweepJobFiles(dir, { retentionMs, clock, warn, ... }):        // 条款级门控（🟡-A）
  names = readdir(dir)                          // ENOENT 静默
  present = new Set(names)                      // 🟡-f：孤儿 log 判定必须先建立 present（否则误删有记录陪着的 log）
  retentionOn = retentionMs > 0
  for name of names:
    if startsWith("b_") && endsWith(".tmp"):                   // 永不门控
      age = await fileAge(name); if (age === undefined) continue        // 🟢-2 显式分支
      if (age >= TMP_RETENTION_MS) await unlinkQuiet(name)
      continue
    if (!retentionOn) continue                                 // 以下全部 retention 门控
    if name.endsWith(".json") && isJobId(stem):
      record = tryRead(name)
      if (record === undefined) {                              // 不可读：mtime 判龄（🟡-f 分支顺序写清）
        age = await fileAge(name); if (age === undefined || age < retentionMs) continue
        unlink name + 同名 log
      } else if (isTerminal(record.status)) {
        if now - (record.endedAt ?? record.createdAt) >= retentionMs: unlink json + 同名 log
      } else {
        continue                                               // 非终态：永不删（🟡-C）
      }
    else if name.endsWith(".log") && isJobId(stem) && !present.has(`${stem}.json`):
      age = await fileAge(name); if (age === undefined || age < retentionMs) continue
      unlinkQuiet(name)
    // "session-id" 与其他未知文件：不动
  // 每次 unlink：ENOENT 静默，其余 WARN（🔴-7/🟡-10）

gcSessionDir(dir, { rmdirSelf }):
  await sweepJobFiles(dir, ...)                                // 同上
  // rmdir 不依赖 retention（🟡-3）：空目录/只剩 session-id/过期 tmp 的目录即建即收
  rest = (await readdir(dir)).filter(n => n !== "session-id" || 只剩它)
  if rmdirSelf && 目录实际为空（先 unlink 孤独的 session-id）:
    await rmdir(dir)                             // ENOTEMPTY/ENOENT 静默，其余 WARN；非递归（🔴-2c）
```

### 3.4 装配层编排（stack.ts，🟡-1 + 双通道交接）

```ts
// buildSessionStack 顶部（:265 附近）——先捕获再 dispose：
const prevBashJobs = previousBashJobs;             // 新增：捕获引用
previousBashJobs?.dispose();                        // 原有：停 poll/notify，保留 handle（F12）
previousBashJobs = undefined;

buildBashJobManager(pi, ctx, settings):            // 不再需要 prevSessionFile 参数（🟡-G）
  rootDir = config.dir ?? join(getAgentDir(), "bash-jobs")
  selfDirName = sanitizeSessionDirName(currentSessionId(ctx))
  store = createJobStore({ dir: join(rootDir, selfDirName), dirMode: 0o700, extraLogRoot: rootDir, ... })
  manager = createBashJobManager({ ... })           // 无 host 字段（v3 撤销）

// buildSessionStack 中替代现在裸的 recover()（:578-590）：
void (async () => {
  await migrateFlatRecords(rootDir, { only: selfDirName, ... }).catch(warn)     // 🟡-1 本 session 迁移
  if (prevBashJobs) await handoffInProcess(prevBashJobs, manager, ...).catch(warn)   // 通道一 §3.5
  await adoptOrphans(rootDir, { selfDirName, prevDirName: prevBashJobs ? basename(prevBashJobs.dir) : undefined, ... }).catch(warn)  // 通道二 §3.5（🟡-b）
  await manager.recover()                                                       // 原有
  if (prevBashJobs && prevBashJobs.dir !== manager.dir) {
    await prevBashJobs.drain().catch(warn)               // 🟡-c：先 drain 旧 store 的 enqueue 链（见 §3.6），
                                                         // 保证 export 前发出的 mid-flight 写在 sweep 前落完
    await sweepHandoffRemnants(prevBashJobs.dir, new Set(manager.list().map(r => r.jobId))).catch(warn)  // 🟡-H
  }
})().catch(warn).finally(() => widgetRef.current?.refresh())
void reconcileRootDir({ rootDir, selfDirName, skipDirNames: [selfDirName], ... }).catch(warn)  // 🟡-E
```

`index.ts` **零改动**（不解析 previousSessionFile、shutdown handler 不动）。

### 3.5 交接/收养/迁移原语（🔴-A/🔴-C、🔴-5）

```ts
handoffInProcess(prevManager, newManager):               // 通道一（🔴-A）
  handoffs = prevManager.exportLocalJobs()               // 同步；仅 backgrounded 非终态 local job（🔴-β）；
                                                         // owner token 在 adoptLocalJobs 里转移（🔴-α）
  sameDir = prevManager.dir === newManager.dir
  for h of handoffs:
    if (!sameDir) moveRecordFiles(prevManager.dir → newManager.dir, h.record,
                                  patch: { logPath: 新计算路径, sessionId: 新id })   // §3.5 migrateOne 三步
    // 更新 handoff.record 为新路径版本后：
  newManager.adoptLocalJobs(handoffs)                    // 新 finalizeLocal 接管终态落盘
  if (!sameDir):
    // 旧目录里无 local handle 的该走记录（🔴-C 修正筛选）：
    for record of readRecords(prevManager.dir):
      if record.hostPid > 0 && record.hostPid !== process.pid && probePid(record.hostPid): continue  // 活 foreign
      if !isTerminal(record.status) || shouldNotifyJob(record):
        moveRecordFiles(... 同上 ...)                    // adopted/staged/终态未通知 → 进新目录等 recover

adoptOrphans(rootDir, { selfDirName, prevDirName }):      // 通道二（🔴-B）
  for entry of readdir(rootDir, withFileTypes):
    if !entry.isDirectory() || entry.name === selfDirName || entry.name === prevDirName: continue  // 🟡-b：比目录名不比全路径
    if !(VALID_ID_RE.test(entry.name) || entry.name === "_unscoped"): continue
    for record of readRecords(join(rootDir, entry.name)):
      if isTerminal(record.status): continue
      if record.hostPid > 0 && probePid(record.hostPid): continue     // 活主不动（不泄露活会话）
      // 🟡-a 排他认领（二选一）：(a) 先 open(join(toDir, `${jobId}.json`), "wx") 占位（EEXIST=认领失败，
      // 放弃该条），再 rename 日志、再 writeAtomic 覆盖占位；或 (b) 最小改动——日志 rename 得 ENOENT 时
      // 【放弃该条记录】（源已被别人搬走），仅 staged 无日志记录允许继续。
      // 认领前 re-stat 一次源 json 的活性（probePid 复查），读快照与搬移之间的活主复活窗口由此关闭。
      moveRecordFiles(该目录 → selfDir 目录, record, patch: { logPath, sessionId: 新id })  // recover 会 adjudicate

migrateOne(jsonPath, { skipDirNames }):                   // 🔴-5 + 🟡-E（flat 迁移专用）
  record = parse(readFile(jsonPath));  失败 → warn + return
  if record.hostPid > 0 && probePid(record.hostPid): return           // 活主（含 ===me），不分状态
  target = sanitizeSessionDirName(record.sessionId)
  if target ∈ skipDirNames: return                                    // 🟡-E
  moveRecordFiles(rootDir → join(rootDir, target), record, patch: { logPath: 新路径 })

moveRecordFiles(fromDir, toDir, record, patch):           // 崩溃安全三步（🔴-5）
  if exists(join(toDir, `${record.jobId}.json`)): warn(带双方 createdAt/command 预览, 🟢-6) + return   // 不覆盖
  mkdir(toDir, { recursive: true, mode: 0o700 }); 写 session-id 标记（🟢-4）
  rename(join(fromDir, `${jobId}.log`), join(toDir, `${jobId}.log`))  // ENOENT 静默；其余 warn + return（禁 copy）
  writeAtomic(join(toDir, `${jobId}.json`), { ...record, ...patch }, 0600)
  unlink(join(fromDir, `${jobId}.json`))                  // 最后；崩在前面=原样保留，幂等重跑

sweepHandoffRemnants(prevDir, activeJobIds):              // 🟡-H
  for name of readdir(prevDir):
    if isJobId(stem) && activeJobIds.has(stem): unlink json/log       // 已归本 session 的残留
```

### 3.6 manager.ts 增量（🔴-A/🔴-4）

```ts
// LocalHandle 增加字段：owner: object                    // 🔴-α owner token（不用布尔 latch，理由见 §1.6）
// 每个 manager 构造时：const myToken = {}; create() 建 handle 时 owner = myToken
// finalizeLocal 入口捕获 const mine = myToken；await exitPromise 之后第一步：
if (handle.owner !== mine) return entry.record;          // 只有当前 owner 负责 footer/flush/end/落盘
// exportLocalJobs 导出条件：非终态 && entry.local && record.backgroundedAt !== undefined（🔴-β）
// adoptLocalJobs：handle.owner = myToken 后重发 finalizeLocal，并 ensurePolling()（🟢-4 终审）
// drain(): Promise<void>                                 // 🟡-c：给 store 的 enqueue 链尾追加 no-op 并 await
                                                         //（job-store.ts:98-108 的链天然支持），供 sweep 前做 barrier
// deliverNotice 收敛（🔴-4，同 v2）：
const stored = await applyPatch(jobId, ...notifiedAt...);
if (stored === undefined) { const e = entries.get(jobId); if (e) e.record = { ...e.record, notifiedAt: at }; }
```

---

## 4. 逐文件改动清单（v3）

| 文件                                    | 改什么                                                                                                                                                                                                                                                                                                                                                        | 为什么                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/bash/session-dirs.ts`              | **新建**：`sanitizeSessionDirName`（🟢-5 磁盘契约注释）、`migrateFlatRecords`/`migrateOne`、`moveRecordFiles`、`handoffInProcess`、`adoptOrphans`、`sweepHandoffRemnants`、`sweepJobFiles`/`gcSessionDir`/`reconcileRootDir`                                                                                                                                  | 分层、迁移、双通道交接、GC 的唯一实现处；纯注入便于单测 |
| `src/bash/manager.ts`                   | ① LocalHandle 加 `owner` token + `finalizeLocal` owner 检查（🔴-α，**不用布尔 latch**）；② 新增 `exportLocalJobs()`（条件含 `backgroundedAt !== undefined`，🔴-β）/`adoptLocalJobs()`（转移 owner + `ensurePolling()`）；③ 新增 `drain()`（🟡-c barrier）；④ `deliverNotice` 收敛（🔴-4）；⑤ `mkdir(store.dir)` 带 mode 0o700（🟢-3）；⑥ §3.6/§3.7 块注释更新 | 交接所有权显式化；纵深防御；F25 不变量注释化            |
| `src/bash/types.ts`                     | 不动（v2 的 host 字段撤销，🟡-C）                                                                                                                                                                                                                                                                                                                             | —                                                       |
| `src/bash/job-store.ts`                 | ① `JobStoreOptions` 附加 `dirMode?`（🟡-4）与 `extraLogRoot?`；② `store.remove()` 硬修 + 🟡-D 防护（basename + root 前缀双重校验，否则只 WARN）；③ 导出 `fileAge`（G1）；④ `writeAtomic` 的 rename 遇 ENOENT 重试一次（🟢-1：mkdir 后重试，把 rmdir/mkdir 竞态变不可观测）；⑤ 头注更新                                                                        | 权限、泄留硬修、判龄复用、竞态兜底                      |
| `src/stack.ts`                          | ① 顶部捕获 `prevBashJobs` 再 dispose；② `buildBashJobManager`：rootDir→per-session dir、`dirMode`/`extraLogRoot`；③ recover 调用点改 §3.4 编排                                                                                                                                                                                                                | 通道一接线（F26）；🟡-1 编排                            |
| `src/index.ts`                          | **不动**（🟡-G：不解析 previousSessionFile/targetSessionFile）                                                                                                                                                                                                                                                                                                | —                                                       |
| `src/config/settings.ts:68,72`          | 注释统一（F24、root 语义）                                                                                                                                                                                                                                                                                                                                    | 🔴-3/§1.4                                               |
| `src/config/setting-specs.ts:172`       | 注释同步                                                                                                                                                                                                                                                                                                                                                      | 一致性                                                  |
| `src/tools/bash-job-tool.ts:253-263`    | 事实化文案（🟡-4）                                                                                                                                                                                                                                                                                                                                            | —                                                       |
| `README.md` / `README.en.md`            | dir/retentionS 行；「目录清理」（root 级 GC 后缀模型+逐文件放行）；「日志与敏感输出」（可见性隔离非 OS 边界）；「重启/reload 后收养」（双通道交接 + 孤儿接管语义）；日志路径加 `<sessionId>/`；`session-id` 标记文件                                                                                                                                          | §1.4/🟡-4/5、🔴-B                                       |
| `CHANGELOG.md`                          | dir 语义 root 化、flat 自动迁移+WARN、可见性收窄、fork/new/startup 交接语义                                                                                                                                                                                                                                                                                   | breaking 告知                                           |
| `docs/dev/bash-auto-background/plan.md` | 文末指针                                                                                                                                                                                                                                                                                                                                                      | 历史文档                                                |

---

## 5. 测试计划（v3）

### 5.1 新增 `tests/bash/session-dirs.test.ts`

- sanitize：同 v2 + **真实 `uuidv7()` 输出断言走原样分支**（🟢-5）。
- GC（🔴-D/🟡-A/B/C/F）：**用真实 tmp 文件名 `b_XXXXXXXX.json.<pid>.<ts>.0.tmp`**（🟡-I④）测 tmp 判龄；目录内有 `.DS_Store`/陌生文件 → 已识别文件照常清理、陌生文件不动、rmdir 失败后静默（🟡-B 直接断言）；非终态记录**任何条件组合下都不删**（🟡-C，含 hostPid 死 + 子进程死 + 过期）；`retentionMs<=0` → 依赖 retention 的条款全跳过但 `.tmp` 照扫、空目录照 rmdir、**阶段 B 的 root 孤儿 log 也不删**（🟡-A/🟡-I⑤）；root 下不可迁移 `.json` 的终态出口：终态+过期→删、不可读+mtime 过期→删、非终态→留（🟡-F/🟡-I⑥）；`_unscoped` 永不 rmdir；`session-id` 标记不 veto、孤独时随 rmdir 清掉；mtime 未来不判；并发 GC 不抛不误删（🟡-9⑧）。
- 迁移：同 v2（活主不分状态跳过、===me 跳过、不覆盖 + 🟢-6 WARN 内容断言、顺序与崩溃安全、`_unscoped` 落桶）+ **skipDirNames 断言同一文件不迁移两次**（🟡-E）。
- 孤儿收养（🔴-B）：死 host 非终态记录被迁入目标目录（logPath/sessionId 重写）；活主记录原地不动；rename 竞合（目标已存在）幂等。
- 交接文件通道（🔴-C）：hostPid=死 pid 的 adopted 记录被搬；活 foreign 不搬；终态已通知不搬。

### 5.2 修改既有测试

- `tests/integration/bash-jobs-wiring.test.ts`
  - 路径期望改 per-session 子目录（同 v2；fake sessionId 改真 uuidv7）。
  - **交接退出码用例（🟡-I①，🔴-A 的把关测试）**：activate 后起 `sh -c 'sleep 0.3; exit 7'` 的 job → emit session_start（reason:"fork"）→ 新 stack → 等终态 → 断言 `status === "failed" && exitCode === 7`（**不是** exited_unknown），且日志 footer 与 status 一致。
  - **startup 孤儿收养用例（🟡-I②，🔴-B）**：session_start reason:"startup"（无 previousSessionFile、无 prev manager）+ 兄弟目录 seed 死 host running 记录（真实活 pid 的 sleep 子进程 + 死 hostPid）→ 断言被 adopt、list 可见、终态后通知发出。
  - **adopted 后 fork 用例（🟡-I③，🔴-C）**：seed hostPid=死 pid 的 running 记录 → 第一次 activate（resume 同 id）收养 → 第二次 session_start（fork）→ 断言 job 仍可见且被管理。
  - 隔离用例（seed 时间取 `Date.now()` 附近防自伤，GC 用专门死 session 目录）、迁移用例同 v2。
  - 默认配置不碰真实 `~/.pi` 断言（temp HOME 教条）。
- `tests/bash/manager.test.ts`
  - **🔴-A 单测**：exportLocalJobs 后旧 manager 的 finalizeLocal 在 exit 后不再写旧 store（owner 已非己）；adoptLocalJobs 后新 manager 完成终态落盘（新 store 收到正确 exitCode）；footer 不双写。
  - **🔴-α 把关：A→B→C 链式交接**（🟡-d③）：连续两次交接同一在跑 job → 断言终态**恰好落盘一次**（C 的 store 收到正确 exitCode）、footer 只有一行、无 `ERR_STREAM_ALREADY_FINISHED`、无非法转移 WARN（owner token 的直接回归测试——布尔 latch 会在此暴露双 awaiter）。
  - **🔴-β 把关：前台在飞 job 不被导出**（🟡-d①）：起一个不到阈值的前台 bash → emit session_start(reload) → 进程退出后断言 bash 工具返回真实 `exitCode`（不是 `null`）；exportLocalJobs 的导出清单不含该 job。
  - exit 与 export 交叠两个窗口的确定性单测（可控 exitPromise；🟡-d②）：exit 早于 export → 走文件通道终态不丢；exit 恰在 export 与 adopt 之间 → 终态由新侧落盘。
  - 交接时功能被关闭（`autoBackgroundMs` 改 0 后 reload，prev manager 存在、新 manager 不存在）→ 不抛，旧 job 由旧 manager 自行收尾（🟡-d④）。
  - 🔴-4 收敛用例（同 v2）。
- `tests/bash/job-store.test.ts`：`dirMode` 0700；`remove()` 分叉路径双删 + **logPath 指向 root 之外 → 拒删只 WARN**（🟡-D/🟡-I⑦）；`writeAtomic` rename ENOENT 重试（🟢-1）。
- 其余（bash-auto-background / tool 文案 / notification-complement / stack-terminal-failure / status / fleet-widget）同 v2。

---

## 6. 风险与回滚（v3）

| 风险                                           | 评估 & 缓解                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 交接竞态（🔴-A 残余）                          | exit 先于 export：双侧各写一份终态（footer 有幂等锁不双写）；旧目录副本由 🟡-H 复查清掉。mid-flight patch 落回旧目录 → 同复查收敛。                                                        |
| 孤儿误收养（NFS/容器）                         | 异机活 job 的 hostPid 在本机 probe 不到 → 判孤儿被收养——与 flat 时代 recover 的 foreign 判据完全同源，非新增暴露面；写明。                                                                 |
| 孤儿收养与 resume 竞合                         | rename 原子，先迁先得，后到 ENOENT 跳过；不双收养。                                                                                                                                        |
| GC 误删                                        | 目录名白名单 + 逐文件后缀模型 + 非终态永不删 + 非递归 rmdir + 未来 mtime 不判 + `retentionMs<=0` 条款级关闭。爆炸半径 = pruneExpired。                                                     |
| 旧版共存 / `dir` 语义变化 / `_unscoped` 共享桶 | 同 v2（迁移只动 host 已死记录；CHANGELOG+启动 WARN；WARN+文档）。                                                                                                                          |
| 回滚（G7 修正措辞）                            | schema 完全不变（host 字段已撤销）；但迁移/交接重写过 `logPath` 指向新布局——revert 后被迁记录若被旧版 `store.remove()` 删会漏删日志，回滚需人工清理 `<root>/<sessionId>/`；其余纯 revert。 |

## 7. 实施顺序建议（v3）

1. `job-store.ts`（dirMode/extraLogRoot/remove 硬修/fileAge 导出/🟢-1 重试）+ 单测 → 2. `manager.ts`（handoff latch、export/adopt、🔴-4）+ 单测 → 3. `session-dirs.ts` 全套 + 单测（安全关键）→ 4. stack.ts 接线 + wiring 集成测试（含 🟡-I 三条新用例）→ 5. 文案/注释 → 6. README/CHANGELOG/docs。
   **评审要求**：§1.6（双通道交接）单独走一轮短评审后再与 GC 一起进主干。

---

## 8. 变更摘要

### 8.1 v1→v2（对应 review-opus.md 初评）

| 编号          | 落实                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 🔴-1          | GC 活性改 `checkPidOwnership`，非终态默认永不删                                                                                     |
| 🔴-2          | 目录名+内容白名单、逐文件 unlink、非递归 rmdir                                                                                      |
| 🔴-3          | `retentionMs<=0` 关 GC；settings.ts:68 注释统一（F24）                                                                              |
| 🔴-4          | `deliverNotice` 内存标记 notifiedAt 收敛                                                                                            |
| 🔴-5          | 迁移不分状态探活主、===me 跳过、不覆盖、崩溃安全顺序                                                                                |
| 🔴-6          | 选 (b) 归属交接（v2 实现于 session_start 侧；**v3 已推翻重做，见 8.2**）                                                            |
| 🔴-7          | 逐文件判龄紧邻 unlink，窗口收敛写明                                                                                                 |
| 🟡-1/2/3/4/5  | 本 session 迁移 await 在 recover 前；`_unscoped` 逐文件 GC 不 rmdir；空目录即收；文案事实化+dirMode 0700；WARN-only 否决 scope 开关 |
| 🟡-6/7/8/9/10 | host 字段（**v3 已撤销**）；sanitize 小写+hash 后缀限长；8 条测试补齐+防自伤；ENOENT 静默其余 WARN                                  |
| G1-G7         | fileAge 复用；isJobId 匹配；root litter 清扫；普通目录；README 路径提示；reconcile 门控取舍写明；回滚措辞修正                       |
| 事实修正      | F15/F16；logPath 重写升为必须；store.remove 硬修                                                                                    |

### 8.2 v2→v3（对应 review-opus.md「# v2 复审」）

| 编号     | 落实                                                                                                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴-A     | **§1.6 重写为通道一 LocalHandle 进程内交接**：manager 新增 `exportLocalJobs()`/`adoptLocalJobs()`，LocalHandle 加 `handoff` latch，旧 `finalizeLocal` 退场、新 manager 接管终态落盘（F12/F25/F26 已核实入事实表）；文件搬移只用于无本地句柄的记录；把关测试 = 🟡-I①（fork 后断言 `exitCode===7` 而非 exited_unknown） |
| 🔴-B     | **采纳孤儿收养扫描（修法 1）**：`adoptOrphans` 在每次 session start（含 startup）await 于 recover 前，把"非终态 + 无活主"记录迁入本 session 目录交 recover adjudicate；活主一律不动；与 resume 的 rename 竞合写明；README 补"孤儿接管"语义                                                                            |
| 🔴-C     | 交接筛选改为 foreign 判据补集：`hostPid>0 && !==me && probePid` 才跳过（F9 adopted 不改写 hostPid 已入事实表）；把关测试 = 🟡-I③                                                                                                                                                                                      |
| 🔴-D     | §3.3 文件名分类照抄 pruneExpired 后缀模型（`.json`/`.log` 看 isJobId stem；`.tmp` 只要 `b_` 前缀+后缀，真实命名 F27 已入事实表）；整目录否决改逐文件放行；GC 测试必须用真实 tmp 文件名                                                                                                                                |
| 🟡-A     | retention 门控下沉到条款级：`.tmp` 永不门控、retention 条款 `<=0` 跳过、rmdir 不依赖 retention、阶段 B/C 共用 `sweepJobFiles`                                                                                                                                                                                         |
| 🟡-B     | 逐文件放行（陌生文件不动不 veto 不 WARN）；与 🟢-4 标记文件兼容                                                                                                                                                                                                                                                       |
| 🟡-C     | **删除非终态豁免条款**（非终态永不删，磁盘收敛靠孤儿收养）；**v2 §1.9 的 `JobRecord.host` 字段整节撤销**，schema 不动                                                                                                                                                                                                 |
| 🟡-D     | `store.remove()` 硬修加双重防护（basename 匹配 + resolve 前缀在 root 内，`extraLogRoot` 注入），否则只 WARN；测试补 root 外拒删                                                                                                                                                                                       |
| 🟡-E     | `reconcileRootDir` 加 `skipDirNames`；测试断言不重复迁移                                                                                                                                                                                                                                                              |
| 🟡-F     | root flat `.json` 终态出口（终态+过期删 / 不可读+mtime 过期删 / 非终态留），并入 `sweepJobFiles`                                                                                                                                                                                                                      |
| 🟡-G     | **交接不解析 session 文件路径**：旧目录直接取 `prevManager.dir`（连模块级记 sessionId 都不需要）；`previousSessionFile` 退出交接逻辑，index.ts 零改动；in-memory 回归随之消失                                                                                                                                         |
| 🟡-H     | `sweepHandoffRemnants`：recover 后对旧目录幂等复查，删 jobId 已归本 session 的残留；🔴-A 修复后窗口缩为"export 前已发出的 mid-flight 写"，已写明                                                                                                                                                                      |
| 🟡-I     | 三条把关用例全部入 §5.2（fork 退出码 / startup 孤儿收养 / adopted 后 fork）；GC 用真实 tmp 文件名、`.DS_Store` 放行、`retentionMs<=0` 阶段 B、root 终态出口、remove 拒删各补断言                                                                                                                                      |
| 🟡-J     | F12 重写为 dispose 真实语义（保留流/exitPromise、I-b persists-but-never-notifies）；新增 F25（probeAdopted 同路径隐式链）、F26（LocalHandle 结构与 previousBashJobs 模块变量）、F27（真实 tmp 命名）                                                                                                                  |
| 🟢-1     | `writeAtomic` rename ENOENT 重试一次（入 §4 job-store 行）                                                                                                                                                                                                                                                            |
| 🟢-2     | `fileAge` undefined 显式分支写入 §3.3 伪代码                                                                                                                                                                                                                                                                          |
| 🟢-4     | `session-id` 标记文件（依赖 🟡-B 先行，已满足；孤独时随 rmdir 清理）                                                                                                                                                                                                                                                  |
| 🟢-3/5/6 | root 0700 连带效果写明 + manager mkdir 同 mode；sanitize 磁盘契约注释 + 真实 uuidv7 单测；碰撞 WARN 带 createdAt/command 预览                                                                                                                                                                                         |

### 8.3 v3→v3.1（对应 review-opus.md「# v3 终审」；终审结论：修改后通过，无需再评审轮次）

| 编号    | 落实                                                                                                                                                                                                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴-α    | **布尔 latch 改为 owner token**（§1.6/§3.6）：每个 manager 持唯一 token，`finalizeLocal` 以闭包捕获的 token 与 `handle.owner` 比较决定是否落盘；export 不动 owner、adopt 转移 owner；A→B→C 双 awaiter 问题随之解决；§5.2 补链式交接把关用例（🟡-d③）                                                           |
| 🔴-β    | `exportLocalJobs` 导出条件加 `record.backgroundedAt !== undefined`（§1.6/§3.6）：前台在飞 job 的 `exit` promise 是 bash 工具返回值（`bash-tool.ts:483-486` 已核实），交接会导致 `exitCode: null` 错报；前台 job 留给旧 manager 收尾（reload 同目录隐式链 F25 / new·fork 已被 abort）；§5.2 补把关用例（🟡-d①） |
| 🟡-a    | 孤儿认领改排他操作（§3.5）：`open(..., "wx")` 占位或"日志 rename ENOENT 即放弃该条"二选一；认领前 re-stat 源 json 活性复查，关闭快照→搬移之间的活主复活窗口                                                                                                                                                    |
| 🟡-b    | `adoptOrphans` 的 `exclude` 改 `prevDirName`（比目录名不比全路径，§3.4/§3.5）                                                                                                                                                                                                                                  |
| 🟡-c    | `sweepHandoffRemnants` 前 `await prevManager.drain()`（manager 新增 `drain()`，借 store enqueue 链尾做 barrier，§3.4/§3.6）                                                                                                                                                                                    |
| 🟡-d    | 四条补测全部入 §5.2（前台 reload 真实退出码、exit/export 交叠两窗口、A→B→C 链式交接、交接时功能关闭）                                                                                                                                                                                                          |
| 🟡-e    | `session-id` 标记文件写入点补 `buildBashJobManager`（§1.1）；写明"诊断辅助，GC 归属判据不依赖它"                                                                                                                                                                                                               |
| 🟡-f    | §3.3 伪代码修正：`present` 集合定义补回；`.json` 三分支顺序写清                                                                                                                                                                                                                                                |
| 其余 🟢 | 按终审"确认无碍"维持不动                                                                                                                                                                                                                                                                                       |
