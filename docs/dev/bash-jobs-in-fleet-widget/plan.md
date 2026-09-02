# 后台 bash 任务进入 fleet widget（agent tree）实施方案

> **v2（评审修订版）**：根据 gpt-sol 评审「需修订后实施」逐条修订。
> 每条修订在设计决策处以「评审 B1/M1/…/m1…」标注可追溯。
> 主要变化：tail 读取改为复用 stack.ts `readBashJobTail` 的两遍读模式（B1）；
> 删除 staged 展示（M1）；recover 完成后显式 refresh（M2/M8）；bash 主行与
> run 主行同池、优先于一切 activity 行（M3）；hidden 计数精确定义（M4）；
> 终态做一次受控 tail 读、finalText 仅 fallback（M5）；header bullet 语义
> 不合并 bash（M6）；缓存失效改为 controller 自维护 observedSize + running
> 每 tick 重读（M7）；及 m1–m8 全部处理。

## 1. 需求摘要

把后台执行的 bash 任务（`BashJobManager` 管理的 job）展示到常驻 fleet widget
（`src/ui/fleet-widget.ts`，编辑器上方的 agent tree）中：

- **范围**：仅常驻 widget；`fleet-panel.ts` 只作数据源/工具函数参考，不改渲染。
- **行样式**：每个 bash 任务 1–2 行——主行 `$ <命令预览> · running · 12s · 45KB`，
  第二行 ╰ activity 行显示**日志 tail 预览**（最后一条非空白行，单行折叠）。
  终态用 ✓/!/✗ 短暂停留（复用 `terminalLingerMs` 语义，默认 5s）后消失。
- **高亮**：非零退出（failed / timed_out）crit，被终止/状态不明 warn，
  沿用 `FleetHighlight` 机制。
- **刷新**：搭现有 `FleetWidgetController` 的 1Hz tick，不新增 timer。

## 2. 设计决策

### D1. 数据注入形态：预烘焙 view 进 opts（仿 workflows 注入）

**决策**：builder 层新增 `opts.bashJobs?: readonly BashJobViewInput[]`（与
`opts.workflows` 同构）；controller 层新增 `deps.bashJobs?: () => readonly JobRecord[]`
与 `deps.readBashTail?: (record: JobRecord, sizeHint?: number) => Promise<string | undefined>`，
由 controller 负责把 `JobRecord` 转成 `BashJobViewInput`（算 elapsed、highlight、
取 tail 缓存）。

**选项对比**：

| 方案                                       | 优点                                                                                                                              | 缺点                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A. 传 `JobRecord` 给 builder，builder 内算 | 少一层类型                                                                                                                        | builder 引入 bash 领域类型 + now/缓存语义，纯函数层被污染；测试要造完整 JobRecord |
| B. 预烘焙 `BashJobViewInput`（选定）       | builder 保持"plain data in, lines out"，单测只需构造小字面量；与 `WorkflowGroupInput`（elapsed 由 controller 预计算）先例完全一致 | 多一个接口类型                                                                    |

选 B。先例就在同文件里（M9 workflows），一致性权重最高。

### D2. 日志 tail 预取：两遍读 + controller 缓存 + 每 tick 重读（评审 B1、M5、M7）

renderFrame 是同步的（1Hz tick 不能 await），日志读取是异步的。

**B1 修订 — 两遍读是必须的**：`readOutput(jobId, {offset, maxBytes})` 的语义是
「从 offset 起顺序读 maxBytes」（manager.ts readOutput 实现），**不是**自动 tail。
当 `record.logBytes` 滞后于磁盘真实大小（adopted job 的常态，见 M7）时，
`offset = record.logBytes - maxBytes` 读到的是日志中段，v1 方案里的
`slice(-TAIL_BYTES)` 补救拿到的是错误内容。既有先例是**两遍读**：
`src/stack.ts` 的 `readBashJobTail()`（~L128，通知路径在用）——
第一遍以 `tailOffset(record.logBytes)` 读，若 `read.logBytes > record.logBytes`
则以 `tailOffset(read.logBytes)` 重读；`src/tools/bash-job-tool.ts` L180/L200-207
的 `tailOffset`/`bash_job status` 是同款模式。（v1 把引用错写成
fleet-panel.ts L180，特此修正：正确引用是 stack.ts L108-135 与
bash-job-tool.ts L180-207。）

**决策：复用 `readBashJobTail`，不新写 fs 逻辑**。stack.ts 该函数已是
「两遍读 + advanceCursor:false + 永不 reject」的完整实现，唯一差异是它返回
最多 `BASH_JOB_TAIL_LINES`(10) 行的 join，widget 只取其中最后一条非空白行
（行提取是纯函数，见 D8/m5）。为它增加一个可选 `sizeHint` 参数（见 M7），
并从 stack.ts export 以便直接单测（m7；stack.ts 导出内部函数有先例：
`bashJobsEnabled`/`bashJobElapsedMs`/`formatBashJobNotification`）。
widget 通过 deps 注入拿到绑定好 manager 的它——**widget 不 import stack.ts**
（分层方向是 stack → widget），由 stack.ts 装配时注入 closure（m1）。

**缓存与失效（M7 修订）**：v1 的「`record.logBytes` 变化才重读」不成立——
`readOutput(advanceCursor:false)` 不回写 record.logBytes（manager.ts
readOutput 实现只写 readCursor），adopted job 的 liveness poll
（`probeAdopted`，~L399）只探活、从不刷新 logBytes，所以 adopted running job
的 `record.logBytes` 会永久停在 recover 时的值，缓存永远"失配"→ 每秒重复读，
或者（若按记录值判新鲜）永久不刷新。改为：

- cache entry = `{ text: string; observedSize: number; terminal: boolean }`，
  **observedSize 由 controller 自维护**（= 上次读取返回的真实 `read.logBytes`），
  不依赖 record.logBytes。
- **running job：每 tick 重读**（缓存只承担"两帧之间渲染"的职责，不承担
  新鲜度判断）。成本上限：同屏 running bash ≤ maxRows ≤ 8 个，每个 1–2 次
  × 1KB 读/秒；steady-state 下凭 sizeHint（= max(record.logBytes,
  entry.observedSize)）第一遍即命中真实 tail，第二遍只在日志本秒内有增长时
  发生。上限 ≤ 16KB/s 的本地文件读，可忽略——这个量级买回了「没有失效逻辑
  可错」。
- **terminal job：首次观察到终态时做一次受控 tail 读（M5）**，成功后
  `terminal: true` 冻结，不再读。日志最后一行是 manager 写入的 footer
  （`[pi-subagent] job … completed (exit 0) after 12s`，manager.ts
  `appendLogFooter` ~L536），是理想的终态 activity 行。**finalText 仅作
  fallback**：它语义上是内层 tool 的最终文本而非日志 tail，且成功路径靠
  `adoptInnerPromise` 异步 `setFinalText` 补写（bash-tool.ts ~L388-405），
  终态首帧常常还没有。tail 读失败时才取 `record.finalText` 的最后一行；
  再失败则无 activity 行。
- **并发去重**：`bashTailInflight: Set<JobId>`，在飞请求不重复发起，finally
  删除。
- **失败退避（m3）**：读取 reject（log 被 sweep、job 消失）→ 不 reject 出
  prefetch（吞掉），记录 `tailFailures: Map<JobId, Millis>`，同一 job 距上次
  失败 < 5s（5 个 tick）内不再尝试，避免对长期 running 的坏 job 每秒重试。
  不 WARN（1Hz 下刷屏；job 消失是 retention sweep 的正常竞态）。
- **缓存回收**：每帧以当前 `list()` 的 jobId 集合修剪 cache/inflight/failures
  中已消失的 entry，防泄漏。
- **渲染**：`renderFrame()` 只读缓存。缓存未命中 → 本帧无 activity 行（主行
  仍在），读取完成后由**下一个 1Hz tick** 自然拾取——不主动触发 refresh，
  异步路径完全不触碰 refresh 的容错/重臂逻辑。丢一帧安全是 refresh() 的既定
  容错哲学（widget 无增量状态）。

**选项对比**：tick 内 await（违反同步 render 约束）与独立 timer（违反需求 4）
均否；v1 的 logBytes 失效判断被 M7 证伪，改为「running 每 tick 重读 +
terminal 读一次冻结」。

### D3. 哪些 job 上树：仅 `backgroundedAt !== undefined`（评审 M1）

**决策**：只显示 backgrounded job。先例：`shouldNotifyJob` / `shouldDiscardJob`
都以 `backgroundedAt !== undefined` 划分"模型可见的 job"；recover 的 adoption
路径也会给收养的 running job 补盖 `backgroundedAt`（manager.ts ~L822-828），
所以跨会话存活的 job 在 recover 后自然上树。前台 bash 的 live 输出已在编辑器
里滚动，上树只会刷屏。

**M1 修订 — 删除 staged 展示**：v1 假设的 `staged + backgrounded` 状态不可
观察：`markBackgrounded` 唯一调用点（bash-tool.ts ~L310）在 spawn 确认
（jobReady resolve，record 已 transition 到 running）之后才执行；recover 遇到
遗留 staged 直接转 `failed` 且**不**补 backgroundedAt（manager.ts ~L805-814，
lostStaged 路径）。结论：上树集合 = `backgroundedAt !== undefined`（此时状态
必为 running 或某终态），方案与测试中 staged 相关内容全部删除，无需为
lost-staged 定义可见性（它走 `shouldDiscardJob` 的清理路径）。

### D4. 行预算与 header 计数（评审 M3、M4、M6）

**M3 修订 — bash 主行与 run 主行同池，优先于一切 activity 行**。
预算分配保持现有的两遍结构，bash entry 追加到 `entries` 末尾后**第一遍
（主行遍）覆盖所有 entry**：

1. 第一遍：按显示顺序给每个 entry 发主行（workflow children → run tree →
   bash），budget 耗尽为止。**bash 主行优先于所有 run 的 activity 行**。
2. 第二遍：剩余行按显示顺序发给 activity 行（run 的 tool trail 先于 bash 的
   log tail）。
3. 第三遍（现有逻辑）：剩余行给 terminal linger 行。

效果：默认 6 行预算下 3 个忙 agent（3 主行）+ 2 个 bash（2 主行）= 5 主行
全部显示，剩 1 行给首个 activity。**bash 主行被饿死当且仅当 active run 数
alone ≥ maxRows**（默认 6）——这与第 7 个 run 受到的待遇完全相同。
**产品决策：接受此取舍，不为 bash 设保底行**。理由：widget 的职责是
glanceability，6+ 并发 subagent 已是退化场景；保底机制会引入第二个预算维度，
与「maxRows 是唯一行预算」的现有心智模型冲突。被挤掉的 bash 由 `+N more`
如实报告（见下）。

**M4 修订 — hidden 计数精确定义**：
`hidden = (model.activeCount + activeBashCount) − shownMainRows`，其中
shownMainRows 为第一遍实际发出主行的 entry 数（run + bash 合计）。
workflow ⚙ group header 不占预算、不计入 hidden（现有规则不变）；terminal
linger 行不占第一遍预算、不计入 activeCount/activeBashCount（transient，
现有 run 侧语义不变，bash 侧对齐）。

**M6 修订 — header bullet 语义不变**：bullet 仍只取 active **run** 的最差
高亮（`activeRows[0]?.highlight`），不合并 bash。理由：running bash 的
highlight 恒为 none（D6），可合并的只有 bash 终态行，而 run 终态行本来也不
参与 bullet——bash 对齐 run 即可，语义「bullet = 进行中 agent 的健康度」
保持单一。v1 中「bash-only 时 bullet 取 bash 最差高亮」的断言删除（该情形
下 bullet 恒为 `none` 色）。

- **header 计数**：`N active Agents` **只数 run**，bash 单独成段：
  `● 3 active Agents · 2 bash`。零 agent 但有 bash 时 header 退化为
  `● 2 background bash`（bullet 为 none 色）。
- **widget 可见性**：现逻辑"无 active run 且无 recentTerminal 且无 workflows →
  undefined（隐藏）"扩展为同时考虑 bash：只有 bash 活动时 widget 保持显示。
  这是行为变更点：此前 bash-only 场景 widget 是隐藏的。

### D5. stack.ts 装配顺序：提前创建 bashJobs + recover 后显式 refresh（评审 M2、M8）

**决策**：把 `buildBashJobManager(pi, ctx, settings)` 从 ~L553 上移到 widget
创建块（~L514）之前。`buildBashJobManager` 只依赖 `pi`/`ctx`/`settings`
（均为 buildSessionStack 入参），上移零风险；同文件有 M9 workflowActivity
提前创建的同款先例与注释。

**M2/M8 修订 — recover 时序必须显式处理**：`list()` 只读内存 entries
（manager.ts ~L888），历史记录要等 `recover()` 的 `store.loadAll()`（~L790）
后才进内存；而 recover 是 fire-and-forget 启动的，widget 构造时的首次
refresh() 必然看到空列表。不处理的话 bash 行要等「recover 耗时 + 至多 1 个
tick」才出现——recover 涉及目录扫描与 pid 探测，延迟不可控，不接受纯等待。
改为在 recover 的 completion 里显式刷新：

```ts
void bashJobs
  .recover()
  .catch((error: unknown) => {
    console.warn(/* 现有文案不变 */);
  })
  .finally(() => widgetRef.current?.refresh());
```

`widgetRef`（L259）在 widget 创建前已声明，recover resolve 时
`widgetRef.current` 必已赋值（同一同步函数体内稍后执行；fleetWidget 关闭时
为 undefined，refresh 调用安全 no-op）。recover 失败路径同样刷新——内存里
可能有 create() 的 job。

widget deps 注入：`...(bashJobs ? { bashJobs: () => bashJobs!.list(),
readBashTail: (record, hint) => readBashJobTail(bashJobs!, record, hint) } : {})`
（exactOptionalPropertyTypes 条件 spread）。manager 与 widget 同属一次
buildSessionStack 的生命周期，无悬挂引用。

### D6. 高亮与终态 marker（评审 m6）

- running：`none`。
- 终态 linger 期间：`completed` → 不高亮；`failed` / `timed_out` → `crit`；
  `killed` / `exited_unknown` / `orphaned` → `warn`。
- **m6 修订 — bash 终态 marker 独立定义，不照抄 run 的 `completed?✓:✗`**：
  marker 由 highlight 驱动——`crit → "✗"`（整行 crit 色）、`warn → "!"`
  （整行 warn 色）、无高亮（completed）→ `"✓"`（整行 muted）。即复用
  `WIDGET_MARK` 的 !/✗ 语义并补 ✓ 分支；warn 行用 "!" 而不是 ✗，与 run 树
  主行的 mark 语义（! warn / ✗ crit）一致。

全部失败类一律 crit 的选项被否——killed 多半是用户主动操作，红色 ✗ 会制造
警报疲劳。映射是一个 5 行纯函数，后续调整零成本。

### D7. 设置开关：不新增

跟随既有两级开关：`settings.fleetWidget` + `bashJobsEnabled(settings)`。
第三个 `fleetWidget.showBashJobs` 之类是配置杂物（YAGNI）。

### D8. tail 行提取与编码边界（评审 m4、m5）

`readBashJobTail` 返回最多 10 行的 join；widget 的 activity 行只要一行，
提取规则（纯函数 `tailLine`，m5 明确顺序——**先取行、后折叠**）：

1. 按 `\n` 分行（输入已 strip 末尾换行）；
2. 从尾向前找第一条 trim 后非空的行（覆盖末行纯空白、连续空行）；
3. 该行 `\s+` 折叠为单空格并 trim；
4. 找不到 → undefined（无 activity 行）。

**m4 — UTF-8 边界**：byte offset 切割多字节字符会在 chunk 边界产生 U+FFFD
替换字符。接受：running 预览是装饰性的，下一 tick 自愈；测试加一条多字节
内容用例，断言不抛异常且行提取仍返回有效行（不断言无替换字符）。

**clock 一致性（m1）**：elapsedMs / settledAgoMs / 失败退避全部用 controller
的 `deps.clock`（测试注入 fake clock）；manager 内部的 clock 与 widget 无关。
`readBashTail` 由 stack.ts 注入、绑定 session 级 manager（m1 归属决策：
默认实现不放 controller 内部——controller 保持零 fs 知识，可纯 fake 测试）。

## 3. 数据流（文字描述）

```
BashJobManager.list()  (内存快照, 同步)
        │  每 1Hz tick，controller.renderFrame() 拉取；recover() 完成后
        │  额外 finally→refresh() 一次（D5）
        ▼
controller: 过滤 backgroundedAt !== undefined（D3）
        │   每个可见 job：
        │   - terminal 且缓存未冻结 → fire-and-forget 读一次 tail（M5），
        │     成功则冻结缓存；失败 fallback finalText，再失败记退避
        │   - running 且不在 inflight 且不在失败退避窗 → 每 tick 重读
        │     （sizeHint = max(record.logBytes, cache.observedSize)，D2）
        │   - 组装 BashJobViewInput（elapsed/settledAgo 用 deps.clock、
        │     preview=previewCommand(command,80)、highlight=D6、
        │     tail=tailLine(cache.text)）
        ▼
buildFleetWidgetLines(model, { ..., bashJobs: BashJobViewInput[] })
        │   entries = [⚙workflow headers+children..., run tree..., bash rows...]
        │   三遍分配（D4/M3）：主行全池 → activity → terminal linger
        │   hidden = (activeCount + activeBash) − shownMainRows（M4）
        ▼
push(lines) → setWidget(FLEET_WIDGET_KEY, truncated, aboveEditor)
```

## 4. 改动文件清单

| 文件                                         | 改动     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/fleet-widget.ts`                     | **修改** | 新增 `BashJobViewInput`、`formatLogSize`、`bashJobHighlight`（D6）、`tailLine`（D8）、`widgetBashRowMain`/`widgetBashRowActivity`/`widgetBashTerminalDetail`（marker 规则 m6）；`FleetWidgetRenderOptions.bashJobs`；`buildFleetWidgetLines` 三遍分配接入（M3）、hidden 计数（M4）、header bash 段与退化形态、bash recentTerminal linger；`FleetWidgetDeps.bashJobs`/`readBashTail`；controller 的 `bashTailCache`（observedSize/terminal 冻结，M7）/`bashTailInflight`/`tailFailures`（m3）/`prefetchBashTails`；renderFrame 的 record→view 转换与缓存修剪 |
| `src/stack.ts`                               | **修改** | ① `readBashJobTail` 增加可选 `sizeHint` 参数（offset 基数 = max(record.logBytes, sizeHint)）并 export（B1/M7/m7）；② `bashJobs` 创建上移至 widget 块之前 + recover().finally(refresh)（D5/M2）；③ widget deps 注入 bashJobs/readBashTail 条件 spread                                                                                                                                                                                                                                                                                                        |
| `tests/ui/fleet-widget.test.ts`              | **修改** | builder 层 bash 用例（§6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/ui/fleet-widget-bash.test.ts`         | **新增** | controller 层缓存/预取/退避行为（fake deps + fake clock，§6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/integration/bash-jobs-wiring.test.ts` | **修改** | stack wiring 用例（m8，§6）；readBashJobTail 两遍读直测（m7）也放这里（它住 stack.ts）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

不改：`fleet-panel.ts`、`src/bash/*`（list/readOutput 能力已足够）、settings
相关文件（D7）。

**注释密度要求**：匹配项目 dense why-comment 风格，至少覆盖：两遍读的原因
（record.logBytes 滞后，B1）、为何 running 每 tick 重读（adopted job 的
logBytes 永不刷新，M7）、terminal 冻结与 finalText fallback 顺序（M5）、
advanceCursor:false（通知路径同款）、recover.finally(refresh)（M2）、主行
同池分配与饿死取舍（M3 产品决策）、hidden 计数口径（M4）、bullet 不含
bash（M6）、失败退避（m3）。

## 5. 接口签名草案（TypeScript）

```ts
// ── src/ui/fleet-widget.ts 新增 ──

/** Widget 行用的紧凑日志大小："45KB" / "1.2MB"；<1KB 显示字节数。 */
export function formatLogSize(bytes: number): string;

/** D6：failed/timed_out → crit；killed/exited_unknown/orphaned → warn；其余 none。 */
export function bashJobHighlight(status: JobStatus): FleetHighlight;

/** D8/m5：多行 tail → 单条 activity 行。先取最后一条非空白行，再 \s+ 折叠。 */
export function tailLine(text: string | undefined): string | undefined;

/** D1：预烘焙的一行 bash job 展示数据。 */
export interface BashJobViewInput {
  jobId: string;
  /** previewCommand(command, 80)，单行。 */
  commandPreview: string;
  status: JobStatus;
  /** D6 映射结果；builder 不自行推断。 */
  highlight: FleetHighlight;
  /** bashJobElapsedMs 语义，controller 用 deps.clock 计算（m1）。 */
  elapsedMs: number;
  logBytes: number;
  /** tailLine(缓存文本)；无 → 不渲染 activity 行。 */
  logTail?: string;
  /** 终态：now − endedAt，供 terminalLingerMs 过滤（同 FleetRow.settledAgoMs）。 */
  settledAgoMs?: number;
}

// FleetWidgetRenderOptions 增加：
//   /** 后台 bash 任务（D1 预烘焙 view）；主行与 run 主行同池（M3）。 */
//   bashJobs?: readonly BashJobViewInput[];

// FleetWidgetDeps 增加：
//   /** 后台 bash job 内存快照（BashJobManager.list 绑定）；缺省 = 无 bash 行。 */
//   bashJobs?: () => readonly JobRecord[];
//   /** 两遍读 tail（stack.ts readBashJobTail 绑定 manager）；测试注入 fake。 */
//   readBashTail?: (record: JobRecord, sizeHint?: number) => Promise<string | undefined>;

// controller 私有：
//   bashTailCache: Map<JobId, { text: string; observedSize: number; terminal: boolean }>
//   bashTailInflight: Set<JobId>
//   tailFailures: Map<JobId, Millis>          // m3：5s 退避
//   private prefetchBashTails(records: readonly JobRecord[]): void  // fire-and-forget
//   private bashJobViews(records, now): BashJobViewInput[]            // 转换 + 缓存修剪
```

stack.ts 侧（B1/M7/m7）：

```ts
/** sizeHint：调用方维护的已观察真实大小；offset 基数 = max(record.logBytes, sizeHint)。 */
export async function readBashJobTail(
  manager: BashJobManager,
  record: JobRecord,
  sizeHint?: number,
): Promise<string | undefined>;
```

渲染形态（marker 规则 m6）：

```
  $ npm run build · running · 12s · 45KB        ← 主行
 ╰ » added 42 packages in 8s                    ← activity（muted ╰ hook + » tailLine）
✗ $ npm run build · failed · 12s · 45KB         ← crit 终态 linger（整行 crit）
! $ npm run build · killed · 12s · 45KB         ← warn 终态 linger（整行 warn）
✓ $ npm run build · completed · 12s · 45KB      ← completed linger（整行 muted）
```

## 6. 测试计划

### tests/ui/fleet-widget.test.ts（扩展，纯函数层）

- `formatLogSize` 边界：0 / 1023 / 1024 / 1.5MB。
- `bashJobHighlight`：6 终态 + running 的全映射表。
- `tailLine`（m5）：末尾换行、连续空行、末行纯空白、全空白 → undefined、
  多行取最后非空行且 `\s+` 折叠；多字节内容不抛异常（m4）。
- 单 running bash → header 含 `· 1 bash`，主行含 `$ 预览 · running · 时长 · 大小`。
- `logTail` 存在 → ╰ activity 行；缺失 → 仅主行。
- **M3 同池分配**：3 忙 run + 2 bash、预算 6 → 5 条主行全显示，剩 1 行给
  首个 activity（bash 主行优先于 run activity）；6 忙 run + 1 bash、预算 6 →
  bash 进 `+1 more`（固化「饿死=产品决策」的边界，而非 v1 的错误断言）。
- **M4 计数**：run+bash 合计超出 → `+N more` = (activeCount + activeBash) −
  shownMainRows；⚙ header 与 linger 行不计入。
- 零 agent + 有 bash → header `● 2 background bash`（bullet none 色，M6），
  widget 不隐藏。
- 终态 linger（m6）：failed → `✗` crit 行；killed → `!` warn 行；completed →
  `✓` muted 行；超过 lingerMs → 消失。
- 无 run 无 bash 无 workflow → 仍返回 undefined（回归）。

### tests/ui/fleet-widget-bash.test.ts（新增，controller 层）

fake `ui.setWidget` + fake clock + 注入 `bashJobs` getter / `readBashTail` stub：

- 首帧缓存空 → 主行无 activity；下一 tick → activity 出现。
- running job 每 tick 重读（M7 语义）；inflight 期间不重复发起（去重）。
- terminal job：只读一次，后续 tick 不再调 `readBashTail`（缓存冻结，M5）；
  tail 读失败 → fallback `finalText` 最后一行。
- 读取 reject → 吞掉、帧不丢、tick 继续；5s 退避窗内不重试，过窗重试（m3，
  fake clock 推进验证）。
- job 从 list 消失 → cache/inflight/failures 修剪。
- `bashJobs` dep 缺省 → 行为与现状完全一致（回归）。
- dispose 后不再发起新预取；**在飞的 promise 允许自然完成**（m2 措辞：
  dispose 不是 cancel，结果写入无人读取的缓存后被修剪，无副作用）。

### tests/integration/bash-jobs-wiring.test.ts（扩展，m7/m8）

- **m7（readBashJobTail 直测，export 后）**：stale `record.logBytes` 时第一遍
  读错、第二遍以真实 size 重读命中 tail；`advanceCursor:false` 不污染
  readCursor（读后 record.readCursor 不变）；log 超 maxLogBytes 截断时行为
  稳定；`sizeHint` ≥ 真实 size 时一遍命中（不多读）。
- **m8（stack wiring）**：fleetWidget:true + bashJobs on + fake setWidget →
  widget getter 拿到同一 manager 实例；recover 完成后 finally 触发 refresh
  （bash 行无需等满 1 tick）；recover reject 不破坏 widget；session rebuild
  时旧 widget dispose 先于新 stack 挂载；bashJobsEnabled 为 false 时 widget
  deps 不含 bashJobs（getter 永不访问 manager）。

### 验证步骤（需求逐条验收）

1. **范围**：`git diff --stat` 确认 fleet-panel.ts 无渲染改动；fleet-widget
   测试全绿。
2. **行样式**：builder 测试覆盖主行/activity/高亮（上文）。
3. **终态处理**：linger 测试覆盖 ✓/!/✗ 与 5s 消失。
4. **不新增 timer**：controller 测试断言 clock.setTimer 调用次数不变（仅
   现有 1Hz）；`grep setTimer src/ui/fleet-widget.ts` 人工复核。
5. `npm run typecheck`（重点：exactOptionalPropertyTypes 条件 spread）、
   `npm run test`、`npm run build` 全绿。

## 7. 风险与边界

1. **fs 读放大（M7 权衡）**：running job 每 tick 重读是刻意的——用
   ≤8 × ≤2 × 1KB/s 的本地读换「无失效逻辑可错」。sizeHint 让 steady-state
   一遍命中；失败有 5s 退避（m3）。
2. **recover 窗口（M2）**：recover 完成前 widget 看不到历史 job——由
   recover().finally(refresh) 兜底，最长额外延迟 = recover 自身耗时。
3. **log 被 sweep 清理**：readBashTail 吞错返回 undefined → 主行仍在，仅
   activity 缺失 + 5s 退避。可接受。
4. **widget 高度**：共享 maxRows，总高度不变；截断仍走 push() 的
   truncateToWidth，无 M-C flicker 回归。
5. **win32 / feature off**：bashJobs undefined → deps 缺省 → 零行为变化
   （m8 有 wiring 测试固化）。
6. **预算饿死（M3 产品决策）**：active runs ≥ maxRows 时 bash 全部进
   `+N more`——与第 7 个 run 同待遇，见 D4。
7. **finalText 长度**（16KB cap）：只在 tail 读失败时作 fallback，且经
   tailLine 取单行；activity 行长度由 push() 截断兜底。
8. **UTF-8 边界（m4）**：byte 切割可能产生替换字符，装饰性预览，下 tick
   自愈；有测试兜底不抛异常。
