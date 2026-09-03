# 评审：bash 后台任务存储按 session 隔离方案（plan.md）

> 评审人：fable（批判性技术评审）。方案由另一模型制定。
> 结论先行：**修改后通过** —— 隔离布局（§1.1）、recover 不变（§1.2）、dir 语义（§1.4）方向正确且事实核对基本无误；但方案的核心新增机制 **GC（§1.3）与迁移（§1.7）存在多个必须修复的设计缺陷**，这两节需要实质性返工并重新评审。

## 0. 事实核对结果

方案 §0 的 F1–F14 逐条对照代码验证，**基本全部属实**：

- F1 ✓ `src/stack.ts:153-159`（`currentSessionId` 异常/缺失返回 `""`）。
- F2/F3/F4/F5 ✓ `session-manager.js`：`getSessionId()` 返回 `this.sessionId`；`_setSessionFile` 中 `this.sessionId = header?.id ?? createSessionId()`（resume 复用）；branch/fork 走 `createSessionId()`（uuidv7）；`assertValidSessionId` 正则属实。
  - ⚠️ 但注意：**`header.id` 从文件读入时不经过 `assertValidSessionId`**（只有显式 `options.id` 校验）——方案的 `sanitizeSessionDirName` 兜底因此是必要的，这点方案自己也预料到了，核对通过。
- F7 ✓ `src/stack.ts:170,182,183`，call site `stack.ts:525`。
- F8 ✓ `job-store.ts`：flat 单层 `readdir`；`pruneExpired` 对 terminal 记录按 `endedAt ?? createdAt`；**非 terminal 记录永不 prune**（`job-store.ts` prune 内注释 "A non-terminal job is never pruned, however old it looks"）；`.tmp` TTL 1h（`TMP_RETENTION_MS`）。
- F9 ✓ recover 分支顺序属实（`manager.ts:787` 起）。**但注意实际顺序是 staged→failed 在 foreign 检查之前**（见 🟡-11）。
- F11 ✓ `types.ts:87`（字段）、`types.ts:329`（解析缺省 `""`）。
- F12/F13/F14 ✓（settings.ts 实际是 :73 而非 :72，一行之差，不影响）。
- 测试引用 ✓：wiring test `getSessionId: () => "session-under-test"`（~~:52）、`on.bashJobs?.dir` 断言（~~:115）、S7 `withTempHome`/`seedRecord`（~~:400-433）；auto-background test ctx（~~:68）、`settingsWith(dir)`（~:76-81）均属实。
- `probePid`：`kill(pid,0)`，**EPERM 计为 alive**（`process.ts:192-199`）——GC 不会因权限误判活主为死，这点方案的依赖成立（单机场景）。

方案没有虚构代码事实。问题全部出在**新增机制的设计本身**。

---

## 1. 🔴 必须修复

### R1. GC 会删除"宿主已死但 job 进程仍活"的 running 任务的记录与日志

- **描述**：`gcSiblingDir` 的保护条件是 `!isTerminal && hostPid 活`（§3.1）。它完全不看 **`record.pid`（job 进程本身）的存活性**。`shutdownPolicy: "keep"`（默认值！）+ quit 正是"pi 宿主死、job 进程活"的**旗舰场景**：用户 quit pi 留下一个跑了两天的构建/服务，24h（retentionMs）后**任意其他 session 启动时把整个目录 rm -rf**——running 记录无 `endedAt`，age 按 `createdAt` 计；日志文件只 append 不改目录 mtime，记录 JSON 在宿主死后也无人重写，所以 mtime 兜底救不了它。日志文件被删时进程还开着 fd，后续输出全部写进已 unlink 的 inode；用户之后 `--resume` 该 session，recover 一无所见，进程成为永久孤儿且无法通过 `bash_job kill` 清理。
- **依据**：§3.1 伪代码 skip 条件；`manager.ts` recover 的 adopted 分支（宿主死、`checkPidOwnership === "alive"` → 认领）证明这类记录是设计上要**保活等待认领**的；`job-store.ts` prune 明文承诺非 terminal 永不删。**方案的 GC 直接推翻了这条既有不变量**，而方案文本没有任何地方承认这一点。
- **建议**：GC 跳过条件改为"存在任何非 terminal 记录，且（`hostPid` 活 **或** `checkPidOwnership(record) !== "dead"`）"；更保守（推荐）：**目录内存在任何非 terminal 记录即跳过**，让状态收敛（exited_unknown/orphaned）交给该 session 自己 resume 时的 recover，GC 只处理全 terminal 的目录。

### R2. `rm -rf` 整目录的爆炸半径违反既有安全边界，叠加 dir 语义变更后可删用户无关数据

- **描述**：`job-store.pruneExpired` 有明确的安全设计："three suffixes of blast radius"，除 `.json/.log/.tmp` 外**任何东西不碰**。方案的 GC 却对 root 下**任意子目录**（不限名字形状、不限内容）整体 `rm(recursive)`——一个没有任何 `b_*.json` 的目录，`records` 为空，`newest = 目录 mtime`，过期即整删。再叠加 §1.4：`bashJobs.dir` 从"最终目录"变"root"。README.md:88 **明确建议**用户把 `bashJobs.dir` 指到别处存敏感输出——已按旧语义配置 `dir: ~/tmp` 之类的用户升级后，`~/tmp` 下所有 mtime 超过 24h 的子目录会被静默递归删除。这是数据丢失级事故。
- **依据**：`job-store.ts` prune 注释（safety boundary）；§3.1 `gcSiblingDir` 伪代码；README.md:88。
- **建议**：(a) GC 只认形如合法 sessionId（或 `_unscoped`）的目录名；(b) 目录内只删 `b_*.json|.log|.tmp`，随后 `rmdir`（非空则留下并 WARN），**永不 `rm -rf`**；(c) 无任何 `b_*.json` 的目录不删（或只在空目录时 rmdir）。三条全上。

### R3. 迁移"活旧版 pi 的 terminal 记录"会让旧版进入通知死循环

- **描述**：§1.7 只跳过"非 terminal 且 hostPid 活"的记录，并断言"其 terminal 记录被迁走对旧版无害（旧版只会 prune 它们）"——**该断言错误**。旧版 manager 对内存 entries 中 terminal 且未通知的记录，每 2s tick 走 `deliverNotice`：`notify()` 成功后 `applyPatch` 落 `notifiedAt` → `store.update` 读 flat 路径 **ENOENT → 返回 undefined → `putRecord` 不执行 → 内存记录的 `notifiedAt` 永远是 undefined → 下一 tick 再次通知**。文件被新版搬走的瞬间起，旧版 session 每 2s 收到一条重复的完成通知（`triggerTurn: true`！），直到用户杀掉旧 pi。窗口不止"exit 到首次 notify 的 2s"：通知失败重试中、宿主 idle 时刚落盘的记录都会中招。
- **依据**：`manager.ts` `deliverNotice`（notify 成功后才 `applyPatch`；update 读不到文件返回 undefined，见 `job-store.ts` `update`）；`shouldNotifyJob` 只看内存 record。
- **建议**：迁移跳过条件改为"**`hostPid` 活且 ≠ 本进程 → 一律不迁**（不论 terminal 与否）"。活旧版进程退出后下次启动再迁，与方案已接受的"过渡态"完全一致，零额外代价。

### R4. 活 session 目录的 GC 竞态：无"session 在用"标记

- **描述**：一个**当前打开着**的 session，若其目录里只有过期 terminal 记录（或目录为空、只有旧记录），对 GC 而言与死 session 无法区分——skip 条件只认"非 terminal + 活 hostPid"。并发的另一个 session 会把它整目录删掉；TOCTOU 窗口内（readdir/解析 → stat mtime → rm 之间）该活 session 刚 `create()` 落盘的 staged 记录和刚打开的 log 流一并被删（log fd 写入 unlink 的 inode，输出丢失；staged 记录消失后 `applyTransition` 的 `store.update` 读不到文件，staged→running 永不落盘）。目录 mtime 取 max 只缩小窗口，不闭合它。
- **依据**：§3.1 伪代码无任何活性声明机制；`manager.ts` `create()` 先 save staged 再 spawn；`writeAtomic` 会重新 mkdir（部分自愈，但 in-flight 记录已丢）。
- **建议**：每个 session 目录写一个 claim 文件（如 `host.json`：`{hostPid, claimedAt}`，stack 构建时 touch），GC 要求 claim 的 hostPid 已死**且** claim 年龄超 retention 才可删。这同时天然修复 R1 的一半（宿主活着时目录绝对安全）。

### R5. `retentionMs <= 0` 的 GC 行为未定义，按伪代码会立删一切

- **描述**：`job-store.ts` 明文 `<= 0 disables pruning`（`retentionEnabled = retentionMs > 0`）。方案 GC 伪代码 `now - newest > retentionMs`，retentionMs=0 时任何目录 age > 0 即删——**语义正好反转**：用户配"永不清理"，得到"立刻全删"。（顺带：`settings.ts` 注释写 "0 = prune immediately"，与 job-store 实现矛盾，是既有文档 bug，本次应一并修。）
- **依据**：`job-store.ts` `retentionEnabled`；§3.1 伪代码。
- **建议**：GC 显式镜像 store 语义：`retentionMs <= 0` → 不 GC；测试计划补该用例。

### R6. 迁移与 recover 的顺序竞态：升级后 resume 的 job 整个 session 不可见

- **描述**：§3.3 让 `reconcileRootDir` 与 `bashJobs.recover()` **并行 fire-and-forget**。最常见的升级路径——用户升级扩展后 `pi --resume` 自己的 session（旧宿主已死）——flat 记录会被迁入**本 session 目录**（self dir），而 recover 的 `loadAll` 可能在 rename 落地前已扫完。`loadAll` 此后无人再调（下次调用要等下一个 session_start）：迁进来的 running job **不被 adopt、不在 `bash_job list`、不发通知、无法 kill**，直到用户 /reload。升级后第一次 resume 恰恰是最需要认领的时刻。
- **依据**：§3.3 伪代码（两个 `void ...` 并列）；`manager.ts` `loadAll` 仅在 `recover()` 中调用。
- **建议**：至少对 target 为 self dir 的迁移**先 await 完成再触发 recover**（root 扫描本身很快，不违反"不阻塞 session start"——recover 本来也是 fire-and-forget 的）；或迁移完成后对 self dir 补一次 recover。

---

## 2. 🟡 建议改进

### Y1. 进程内 branch / `/new` 会静默孤儿化仍在跑的 job（行为回归，方案未讨论）

今天：branch/new 触发 session_start 重建 stack，新 manager 在**全局目录**上 recover，重新认领仍在跑的 job（foreign 分支挡不住——同进程 hostPid 相同），通知照发。改造后：新 sessionId → 新空目录，旧 session 目录里的 running 记录（hostPid=本进程，活）无人扫描；旧 manager 已 dispose（I-b：永不通知）。结果：job 完成通知**永久丢失**（除非将来有人 resume 旧 session），job 在新 session 里不可见、不可 kill。这可以辩护为"隔离的正确语义"，但方案 §1.1 只说"branch/new → 新目录，符合隔离直觉"，§1.5 声称"零改动"，**完全没有把这个用户可感知的回归摆到桌面上**。建议：在方案/README/CHANGELOG 明示；或考虑 branch 时对旧目录中 hostPid===本进程的 running job 给一次性提示。

### Y2. NFS/多机共享 home：hostPid 探测跨机无意义，GC 把既有的"误标状态"缺陷升级为"删数据"

记录里只有 `hostPid`，无主机标识；机器 B 上 `probePid(机器A的pid)` 结果随机（pid 碰撞→假活，未碰撞→假死）。假死时 R1 的删除路径直接触发。既有 recover 在同一场景下最多是误 adopt/误标 orphaned（可恢复），GC 是不可逆删除。建议：记录里加 hostname（新字段向后兼容，解析缺省空）参与 GC 判定；或在文档中明确把共享 home 列为不支持场景。

### Y3. 根目录遗留 litter 从此无人清理

改造后 `store.dir` 指向子目录，`pruneExpired` 永不再扫 root；`reconcileRootDir` 只处理可解析的 `b_*.json` 和子目录。旧版留下的孤儿 `.log`（json 已被 prune）、坏 JSON、`.tmp` 残骸在 root 里**永久滞留**。方案 §3.1 对坏 JSON 甚至明确"保守起见不删"。建议：root 扫描复用 job-store 的三后缀 + mtime 规则做一次性 litter 清理（坏 json 超 retention 删、孤儿 log 超 retention 删、tmp 超 1h 删）。

### Y4. `migrateLegacyRecord` 的读-改-写破坏了方案自己承诺的原子写

方案开头承诺"保持 tmp+rename 原子写与 0600 权限"，但 §3.1 为重写 `logPath` 字段引入裸的读-改-写，未说明 tmp+rename、未说明 mode 0600、未说明写完后如何删源文件、崩溃在"新文件已写、旧文件未删"之间时两份记录并存的收敛路径（重跑应幂等覆盖——需要明说并测试）。两个新版进程并发迁移同一条记录的行为也未定义（双写同内容+双 unlink，大概率良性，但应写明）。

### Y5. "foreign 分支是唯一防双主保护"的论述不准确

`manager.ts` recover 中 **staged→failed 分支在 foreign 检查之前**（787 起的顺序：terminal → staged → foreign → …）。两个进程同时 resume 同一 session 时，B 的 recover 会把 A 刚落盘、spawn 还在飞的 staged 记录标成 failed——之后 A 的 staged→running 转移被拒，pid 永不落盘，正是 `localJobs` 注释里描述的"unkillable process"事故。这是既有缺陷（全局目录下同样存在），不是回归；但方案把 foreign 分支描述为完整的双主保护是错的，且 per-session 化让"双开同一 session"成为 foreign 分支**唯一**的存在理由——顺手修复很便宜：把 foreign（hostPid 活性）检查提到 staged 分支之前。

### Y6. `_unscoped` 桶内的跨 session 认领与通知劫持

桶内多个无 id 会话共享目录：A 的宿主死后，B 的 recover 会 **adopt** A 的 running job 并把 A 的完成通知发进 B 的对话（连同命令与输出尾巴）。这比"互相可见"更进一步，是主动的跨会话数据搬运。方案只说"共享桶，文档注明"。建议：`_unscoped` 内禁用 adopt（宿主死 → 只标 orphaned/exited_unknown，不 backgrounded），或用 `_unscoped-<pid>` 按进程分桶。

### Y7. 测试计划缺口

§5 覆盖了主干（隔离、GC 基线、迁移基线），但缺：

- `retentionMs=0` 不 GC（R5）；
- 迁移 → recover 的顺序（R6）：flat 的 running 记录（宿主死）迁入 self dir 后必须被本次 recover adopt；
- 无 `b_*.json` 的兄弟目录 / 含陌生文件的目录不被整删（R2）；
- 活 hostPid 的 **terminal** flat 记录不迁移（R3 修复后的断言）;
- GC 对含非 terminal 记录 + 宿主死 + job 进程活目录的行为（R1）；
- branch 场景（Y1）至少一个说明性用例锁定所选语义。

---

## 3. 🟢 可选优化

- `settings.ts` 行号引用是 :73 非 :72（不影响结论）；F 表其余行号抽查均准确。
- GC 在每次 session_start（含 /reload）都全量跑一遍；可像 `maybeSweep` 一样加最小间隔节流，纯锦上添花。
- 被迁移的"foreground 已完成未 backgrounded"记录（`shouldDiscardJob` 候选，5s 宽限内）会失去被旧宿主 discard 的机会，滞留到 retention 才清——量小，可接受，写进注释即可。
- README.md:88 建议"用 `bashJobs.dir` 指到别处做隔离"的安全段落应重写——隔离改为默认后该建议的动机已变。
- `bash_job` 工具描述里 "job_id 前缀解析" 跨目录撞前缀问题**不存在**（`resolve` 只查本 manager 的 entries），方案未提但也无需处理——确认无虞。

---

## 4. 总体结论

**修改后通过。**

方案的事实基础扎实（F1–F14 核验全部成立），布局选择（`<root>/<sessionId>/`）、recover 零改动、dir 重定义为 root、shutdownPolicy 零改动的论证都站得住。但它的两个新增机制质量与项目其余部分（job-store 的三后缀爆炸半径、"非 terminal 永不删"、"不可比时间戳不得授权删除"等既有安全哲学）明显不匹配：

- **§1.3 GC 必须重做判定模型**（R1/R2/R4/R5）：加目录名白名单 + 只删已知后缀 + 非 terminal 即跳过（或校验 job pid）+ host claim 文件 + retention<=0 语义对齐；
- **§1.7 迁移必须收紧跳过条件并定序**（R3/R6）：活宿主的记录一律不碰；self dir 迁移先于 recover。

以上修复后，建议对 GC/迁移两节做一轮增量复审再进入实施。其余章节可按方案直接实施。
