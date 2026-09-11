# compact-hint 实施方案（主会话可动态指定的压缩阈值提示）· v3

> 需求（已过澄清 HARD GATE）：主会话新增 `set_compact_threshold` 工具，模型可随时设定/修改/关闭
> 压缩提示阈值（百分比语义）；插件在 `turn_end` 时拉取 context usage，越过阈值即注入一条
> "可调用 compact_context 主动压缩"的提示消息（时机模型自主，绝不强制）；**阈值必须低于 pi
> 自动压缩线留出缓冲（硬需求）**；完全不涉及 subagent 会话。
>
> **v3 = 第二轮复审打回后的修订**，逐条处置见 §10 对照表：
> P0（直读 pi settings 文件取真实 reserveTokens，用户已拍板）、P1a（窗口切换 × 闩锁组合漏洞）、
> P1b（数值矩阵算错）、P1c（floor 后正数变 0）、V5 验证标准不可执行、测试 7.4-7 自相矛盾。
> v2 决策未点名者全部维持。所有源码行号按当前 HEAD 复核（§0）。

## 0. 源码接缝核实表（v3 复核）

| 断言                                                                                                                                                                                                                   | 位置                                                                                                                                        | 结论                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi 事件不携带 usage；`turn_end` handler 第 2 参 `ctx: ExtensionContext` 上有 `getContextUsage()`                                                                                                                       | `pi-coding-agent/dist/core/extensions/types.d.ts:244`、`:586-590`、`:930`                                                                   | 观察路径 = `pi.on("turn_end", (event, ctx) => ctx.getContextUsage())`                                                                                                                                                                                                |
| `ContextUsage = { tokens: number\|null, contextWindow: number, percent: number\|null }`；contextWindow 恒非空                                                                                                          | `types.d.ts:193-199`                                                                                                                        | 动态上限输入总是可用；percent=null 按"回落/未知"处理                                                                                                                                                                                                                 |
| `ctx.mode: ExtensionMode`；`ctx.hasUI`（TUI 与 RPC 均 true）                                                                                                                                                           | `types.d.ts:212-215`                                                                                                                        | hook 用 mode 跳过 print/json；toast 用 hasUI 门控（§5）                                                                                                                                                                                                              |
| pi 真实 reserveTokens：`settings.compaction?.reserveTokens ?? 16384`；SettingsManager **不经 ExtensionContext 暴露**                                                                                                   | `dist/core/settings-manager.js:559-561`                                                                                                     | **P0 拍板：插件直读 settings 文件**（§4）。注意：`getCompactionReserveTokens()` 是 SettingsManager 的**实例方法**（settings-manager.d.ts:221），**未从包根导出**（dist/index.d.ts:29 只导出 SettingsManager 类）——插件不能 import 该函数，只能自行读文件复刻取值语义 |
| pi 全局 settings = `join(getAgentDir(), "settings.json")`；项目 settings = `join(cwd, CONFIG_DIR_NAME, "settings.json")`，CONFIG_DIR_NAME = `".pi"`（默认值）；getAgentDir() = `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent` | `dist/core/settings-manager.js:52-56`（FileSettingsStorage）、`dist/config.js:402,420-426`（CONFIG_DIR_NAME / getAgentDir / ENV_AGENT_DIR） | 两个路径都能从插件侧重算：getAgentDir 与 CONFIG_DIR_NAME 均由 `@earendil-works/pi-coding-agent` 导出（`dist/index.d.ts:2`），cwd 用 `ctx.cwd`                                                                                                                        |
| 合并优先级：`this.settings = deepMergeSettings(globalSettings, projectSettings)`，注释原文 "project/overrides take precedence"——**项目覆盖全局**                                                                       | `settings-manager.js:151`、`:12-30`（deepMergeObjects 逐键覆盖、嵌套递归）                                                                  | 插件读取复刻同一优先级：项目 > 全局（§4）                                                                                                                                                                                                                            |
| pi 模型注册表 contextWindow **十进制与二进制混用**：128000（×124）与 131072（×100）并存、200000（×91）与 262144（×174）并存、64000 与 65536 并存                                                                       | `@earendil-works/pi-ai/dist/providers/data/*.json` 实测统计                                                                                 | 文档/测试的示例矩阵必须用**精确字面值**（§3.4，P1b）；运行时永远用 `ctx.getContextUsage().contextWindow` 真值                                                                                                                                                        |
| `pi.sendMessage(msg, {triggerTurn:false})`：streaming 时进 `_pendingCustomMessages` 并在 turn_end 派发后立即 flush（"…picks up messages that turn_end handlers queued"）；非 streaming 纯 append 不起 turn             | `dist/core/agent-session.js:1097-1131`、`:420-426`                                                                                          | hint 在当前 turn_end 后追加进上下文、同一 run 下一轮可见；run 已结束则只落历史、不自动起新 turn、等未来触发                                                                                                                                                          |
| custom message 落会话历史为 `type:"custom_message"` 条目，可经 `ctx.sessionManager.getEntries()` 读回断言（stack.ts 再水化循环即此模式）                                                                               | `dist/core/session-manager.js:868`（appendCustomMessageEntry）、`src/stack.ts`（buildSessionStack 内 branch 扫描）                          | **V5 的确定性判据**（§9）                                                                                                                                                                                                                                            |
| HOST_KEY 守卫确保工具只注册主会话                                                                                                                                                                                      | `src/index.ts:81-90`                                                                                                                        | 天然不触及 subagent 会话                                                                                                                                                                                                                                             |
| 工具先例：settings.compact.enabled 门控 + deps 注入；execute 第 5 参为 ctx；print/json 返回 `non_interactive_mode`                                                                                                     | `src/index.ts:177-179`、`src/tools/compact-tool.ts:101-112`                                                                                 | §3                                                                                                                                                                                                                                                                   |
| per-session 状态挂 Stack、holder 透传先例；hook 放 stack.ts、index.ts 顶层注册一次先例                                                                                                                                 | `src/stack.ts`（Stack/buildSessionStack/:420-428）、`src/index.ts:113`                                                                      | §3.5/§6                                                                                                                                                                                                                                                              |
| display:false 先例；中英混排文案先例；settings 逐字段容错先例                                                                                                                                                          | `src/stack.ts:261-269`、`src/mention/mention.ts:38-44`、`src/config/settings.ts:335-360,369-373`                                            | §5/§6                                                                                                                                                                                                                                                                |

## 1. 总体形状

```
pi settings 文件（项目 > 全局）──┐
插件 compact.assumedReserveTokens ├─▶ resolveReserveTokens() ─▶ stack.compactHint.reserveTokens
（最高优先级手动覆盖，可选）──────┘                              （session_start 时解析一次）
模型 ──调用──▶ set_compact_threshold 工具 ──写──▶ stack.compactHint.thresholdPercent
pi turn_end ──▶ createCompactHintHook ──读──▶ ctx.getContextUsage() + stack.compactHint
                    effective = min(threshold, maxThresholdPercent(contextWindow, reserveTokens))
                    percent >= effective 且闩锁不匹配当前 (effective, contextWindow) 且未冷却
                                                      ▼
              pi.sendMessage({customType:"subagent:compact-hint", display:false, …}, {triggerTurn:false})
                    + ctx.hasUI 时 ui.notify toast
```

## 2. 共享常量与纯函数（src/compact-hint/threshold.ts，新建模块）

所有魔法数字集中于此并导出，stack.ts / 工具 / settings / 测试统一引用：

```ts
/** hint 消息 customType。 */
export const COMPACT_HINT_CUSTOM_TYPE = "subagent:compact-hint";
/** settings 默认阈值（百分比原始设定值）。 */
export const DEFAULT_HINT_THRESHOLD_PERCENT = 75;
/** 两次 hint 的最小间隔（闩锁之外的第二保险）。 */
export const COMPACT_HINT_COOLDOWN_MS = 600_000; // 10 min
/** pi reserveTokens 的出厂默认（settings-manager.js:560 的 `?? 16384`），读文件失败的最终回退。 */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;

/** 动态阈值上限（百分比整数，floor）。窗口 ≤ reserve 时返回 0（功能实质关闭）。 */
export function maxThresholdPercent(contextWindow: number, reserveTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(0, Math.floor(((contextWindow - reserveTokens) / contextWindow) * 100));
}

/** hook 实际生效阈值：设定值与动态上限取小；0 = 关闭。 */
export function effectiveThresholdPercent(
  thresholdPercent: number,
  contextWindow: number,
  reserveTokens: number,
): number {
  if (thresholdPercent <= 0) return 0;
  return Math.min(thresholdPercent, maxThresholdPercent(contextWindow, reserveTokens));
}

/** §5 的中英混排提示文案 builder（纯函数）。 */
export function buildCompactHintText(percent: number, thresholdPercent: number): string;
```

**上限参考矩阵（reserve = 16384，P1b 修正版——全部用精确字面值，禁止近似）**：

| contextWindow（目录实测值） | maxThresholdPercent |
| --------------------------- | ------------------- |
| 32000                       | 48                  |
| 32768                       | 50                  |
| 64000                       | 74                  |
| 65536                       | 75                  |
| 128000                      | 87                  |
| 131072                      | 87                  |
| 200000                      | 91                  |
| 262144                      | 93                  |

pi 模型目录十进制与二进制窗口并存（§0），运行时永远取 `ctx.getContextUsage().contextWindow` 真值代入公式，文档与测试只用上表精确值。推论：默认阈值 75 在 64000 窗口下生效值为 74（读侧钳制，正常）；在 128000 窗口（上限 87）下不被钳制，生效值仍为 75。窗口 ≤ reserve 时上限 ≤ 0（如 reserve=32768 时 32000/32768 窗口），功能实质关闭。

## 3. 阈值状态机（src/stack.ts）

### 3.1 状态对象（**v3：闩锁改为 hintedAt 记录 — P1a**）

```ts
export interface CompactHintState {
  /** 设定阈值（百分比原始值，不做钳制）；0 = 关闭。初始值来自 settings.compact.hintThresholdPercent。 */
  thresholdPercent: number;
  /** 已解析的 pi 压缩 reserveTokens（§4 优先级链），build 时定值，供 hook/工具计算动态上限。 */
  reserveTokens: number;
  /** 上次成功发出 hint 的时间戳（ms），0 = 从未发过。 */
  lastHintAt: number;
  /**
   * 越阈闩锁：hint 成功发出时记录当时的生效阈值与窗口；undefined = 未置位。
   * 判定为"同一越阈事件"当且仅当记录与当前 (effective, contextWindow) 完全相等——
   * /model 切窗口或动态上限随 reserve/窗口变化而改变 effective，都构成新越阈事件（P1a）。
   */
  hintedAt: { effectivePercent: number; contextWindow: number } | undefined;
}
```

在 `buildSessionStack` 内创建并加入 `Stack`（`compactHint: CompactHintState`，非可选）。工具经 `holder.current?.compactHint` 写，hook 经同路径读。**读侧钳制语义维持 v2**：`thresholdPercent` 恒存原始设定值，钳制只发生在读取侧（hook 判定与工具回显统一走 `effectiveThresholdPercent`）；理由：session_start 早期 model 可能未就绪、/model 换窗口自动跟随、换回大窗口设定值恢复。

### 3.2 turn_end 判定（越阈 = `>=`，含等号）

`createCompactHintHook(holder, deps)`（deps = `{ sendMessage, now?: () => number }`，放 src/stack.ts）：

```
on turn_end(event, ctx):
  if (ctx.mode === "print" || ctx.mode === "json") return          // 一次性模式整体跳过（§5）
  stack = holder.current;  state = stack?.compactHint
  if (!state || state.thresholdPercent <= 0) return
  usage = ctx.getContextUsage()
  percent = usage?.percent
  if (percent == null):                        // 压缩后 tokens 未知 / usage 不可用
      state.hintedAt = undefined               // 视为回落，清闩锁
      return
  effective = effectiveThresholdPercent(state.thresholdPercent, usage.contextWindow, state.reserveTokens)
  if (effective <= 0):                         // 窗口 ≤ reserve：功能实质关闭
      state.hintedAt = undefined               // ★ P1a：必须清闩锁，否则切回大窗口后被永久抑制
      return
  if (percent < effective):                    // 严格小于 = 回落（含压缩成功后）
      state.hintedAt = undefined
      return
  // 越阈（percent >= effective）：
  if (state.hintedAt
      && state.hintedAt.effectivePercent === effective
      && state.hintedAt.contextWindow === usage.contextWindow) return   // 同一越阈事件只提示一次
  if (state.lastHintAt > 0 && now() - state.lastHintAt < COMPACT_HINT_COOLDOWN_MS) return  // 冷却窗；lastHintAt=0 是"从未发过"哨兵，必须跳过判定——否则测试时钟从 0 起步时首个 hint 被误判在冷却窗内（三审指摘）
  try:
      deps.sendMessage({ customType: COMPACT_HINT_CUSTOM_TYPE, content: buildCompactHintText(percent, effective),
                         display: false, details: { percent, thresholdPercent: effective } },
                       { triggerTurn: false })
  catch (e):
      console.warn(`[pi-subagent] compact-hint send failed: ${e}`)
      return                                   // 失败时 hintedAt/lastHintAt 不动，不落脏
  state.hintedAt = { effectivePercent: effective, contextWindow: usage.contextWindow }
  state.lastHintAt = now()                     // ★ 只在 sendMessage 成功之后置位
  if (ctx.hasUI) try { ctx.ui.notify(`Context ${Math.round(percent)}% ≥ ${effective}% — hinted model to compact`, "info") } catch {}
```

窗口切换场景的行为（P1a 修复后）：200k@75% hint 后 hintedAt={75, 200000} → /model 切 64000（reserve 16384 ⇒ effective=74）→ usage 76% ≥ 74 且闩锁记录不匹配 ⇒ **新越阈事件，正常提示**（仍受冷却约束）；若切到的窗口使 effective<=0（窗口 ≤ reserve，如 reserve=16384 时的 ≤16384 窗口）⇒ 清闩锁返回，切回大窗口后按新事件重新判定，无永久抑制。

### 3.3 闩锁/冷却转换表（P1a 补齐版）

| 事件                                                                           | hintedAt                     | lastHintAt | 说明                                                                                   |
| ------------------------------------------------------------------------------ | ---------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| hint 成功发出                                                                  | → {effective, contextWindow} | → now()    | sendMessage 抛错则两者不动（不落脏）                                                   |
| percent < effective（回落/压缩后）                                             | → undefined                  | 不变       | 重新武装；再越阈仍受冷却约束                                                           |
| percent == null（usage 未知）                                                  | → undefined                  | 不变       | 同上                                                                                   |
| effective <= 0（窗口 ≤ reserve）                                               | → undefined                  | 不变       | **P1a 新增行**：清闩锁防永久抑制                                                       |
| 窗口/阈值变化使 (effective, contextWindow) ≠ 闩锁记录，且 percent >= effective | 视为新越阈事件               | 冷却仍生效 | **P1a 新增行**：不匹配即重新走越阈流程                                                 |
| 工具**置零**（percent:0）                                                      | → undefined                  | → 0        | 关闭即完全复位                                                                         |
| 工具**设定/修改**（任何合法值，含重设同值）                                    | → undefined                  | → 0        | 阈值变更 = 重新武装 + 清冷却：当前已越新阈值则下一 turn_end 立即提示                   |
| 工具**查询**（省略 percent）                                                   | 不变                         | 不变       | 纯读                                                                                   |
| 工具调用被拒（invalid / above_cap / no_session / compact_tool_disabled）       | 不变                         | 不变       | 拒绝不写入，状态机零影响                                                               |
| sendMessage 成功 + ui.notify 抛错                                              | → {effective, contextWindow} | → now()    | 状态置位在前、toast 在后且吞错（§3.2 顺序），toast 失败不回流                          |
| /model 切窗口后 percent < 新 effective                                         | → undefined                  | 不变       | 即走"回落"行——闩锁随窗口变化自动失效，无需单独分支                                     |
| reserveTokens 动态性                                                           | —                            | —          | build 时定值，仅在 stack 重建（session_start）时重新解析（§4）；运行中不随任何事件变化 |
| session_start 重建 stack                                                       | 全新对象（undefined）        | 0          | 阈值回落 settings 初始值，reserveTokens 重新解析（§4）                                 |
| activate 后、首次 session_start 前                                             | —                            | —          | holder.current undefined：工具 no_session，hook 直接返回                               |

任何写入共享同一条规则：**写入 ⇒ `hintedAt=undefined, lastHintAt=0`**，在工具 execute 写入路径统一执行。

### 3.4 动态上限（v3：reserve 为已解析真值，不再是静态假设）

- 公式与矩阵见 §2（P1b 修正）。安全边界恒在读侧：`effective = min(threshold, maxThresholdPercent(contextWindow, reserveTokens))`。
- 工具侧即时校验（反馈体验，非安全边界）：execute 时 usage 可用且 `floor(percent) > maxThresholdPercent(usage.contextWindow, state.reserveTokens)` ⇒ `ok:false, reason:"above_cap"`，文案给出当前窗口的动态上限值；usage 不可用 ⇒ 接受并在文案注明读侧钳制。
- 窗口 ≤ reserve 时上限 0 ⇒ hint 永不发（任何阈值都无法保证低于自动线，公式必然推论）。

### 3.5 hook 注册（src/index.ts）

`pi.on("turn_end", createCompactHintHook(holder, { sendMessage: (m, o) => pi.sendMessage(m, o) }))`，与 :113 并列、**activate() 顶层只注册一次**。buildSessionStack 中 `settings.compact.enabled === false` 时初始 `thresholdPercent` 强制为 0；工具侧 `compactToolEnabled()` false 时 set 返回 `compact_tool_disabled`。

## 4. pi settings 文件读取策略（P0 新设计，独立小节）

**目的**：用 pi 的真实 `compaction.reserveTokens` 替换 v2 的静态假设 32768，使"阈值低于自动压缩线"在任意用户配置下成立。

**已核实事实**（§0）：① 全局文件 `<agentDir>/settings.json`（agentDir = `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）；② 项目文件 `<cwd>/.pi/settings.json`；③ pi 自身合并语义 = 项目覆盖全局（deepMergeSettings，settings-manager.js:151）；④ 取值语义 = `compaction?.reserveTokens ?? 16384`（:559-561）。

**新模块 `src/compact-hint/pi-settings.ts`**：

```ts
/** 读 pi 的 compaction.reserveTokens：项目文件优先，其次全局文件；均无有效值返回 undefined。 */
export function readPiCompactionReserveTokens(cwd: string): number | undefined;

/** 优先级链（写死）：插件手动覆盖 > pi 项目 settings > pi 全局 settings > pi 出厂默认 16384。 */
export function resolveReserveTokens(override: number | undefined, cwd: string): number;
```

- **读取实现**：`readFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"))` 与 `readFileSync(join(getAgentDir(), "settings.json"))`（CONFIG_DIR_NAME / getAgentDir 从 `@earendil-works/pi-coding-agent` 导入，与本仓 stack.ts 现有 import 同源）。逐文件容错（**每层独立 try/catch，任何异常不得冒泡进 buildSessionStack**——session_start 重建路径是先停旧 stack 再建新 stack，读取异常冒泡会留下不一致状态）：
  - 文件不存在（ENOENT）→ 跳过该文件，不告警；
  - EACCES / EISDIR / ENOTDIR / 其他 I/O 错误 → `console.warn("[pi-subagent] pi settings <path> unreadable; ignoring compaction.reserveTokens")`，跳过该层；
  - JSON 非法 → `console.warn("[pi-subagent] pi settings <path> unparseable; ignoring compaction.reserveTokens")`，跳过；
  - `compaction.reserveTokens` 缺失 / null / 非有限数 / `<= 0` → 视为缺失（**不告警**；非法值如字符串同理）。
  - 合法值取 `Math.floor` 后的正整数。
- **合并语义（三审拍板：保守取大，非复刻 pi）**：pi 自身是"项目覆盖全局"且 `projectTrusted === false` 时完全忽略项目 settings（settings-manager.js:188/203），而**插件无法获知 projectTrusted 状态**。若复刻"项目覆盖全局"：项目值 < 全局值时插件 reserve 偏小 → 上限偏高 → hint 可能晚于真实自动线（不安全方向）。因此定死为：
  ```
  resolveReserveTokens(override, cwd) =
    override（合法才视为存在）?? max(项目文件值, 全局文件值, PI_DEFAULT_RESERVE_TOKENS)
  ```
  取大保证插件 reserve ≥ pi 真实 reserve ⇒ 上限恒 ≤ 真实自动线 ⇒ hint 恒早于自动压缩（安全方向）；代价是项目值大于全局值时 hint 略偏早，可接受。null/非法视为缺失在取大策略下等价或更保守（16384 保底参与 max）。这是与 pi 语义的**有意偏差**，理由即上。
- **优先级**：插件手动覆盖 > 文件读取（取大） > 16384。
- **读取时机与同步性**：在 `buildSessionStack` 内**同步**读取（两个小型本地文件，与本仓 `loadSettingsFromFile` 的 readFileSync 一致；buildSessionStack 本身是同步函数，session_start handler 是 async 但无需为此引入异步）。**每次 session_start 重新解析**——new/resume/fork/reload 都会重建 stack，自动拾取配置变更；会话进行中对 pi settings 文件的手动编辑在下一次 stack 重建前不生效（写进文档，可接受）。
- **插件 settings 键义变更**：`compact.assumedReserveTokens` 从 v2 的"假设值（默认 32768）"改为**可选的手动覆盖**（`assumedReserveTokens?: number`，缺省 = 不存在 ⇒ 走文件读取链）。parse 侧：仅在合法（有限、> 0）时设置，非法值丢弃并回落"不存在"（**不再默认 32768**，否则永远压制文件读取）。`DEFAULT_ASSUMED_RESERVE_TOKENS` 常量删除，新增 `PI_DEFAULT_RESERVE_TOKENS = 16384`。
- **覆盖的正当性**：直读文件依赖 pi 内部路径/键名约定，pi 未来改版可能读不到；`assumedReserveTokens` 是用户在该情形下的逃生门，也为"读到的值仍不真实"（如 pi 运行时另有来源）留手动修正手段。
- 解析结果存入 `CompactHintState.reserveTokens`（§3.1），hook 与工具统一使用，不再每次读文件。

## 5. 工具定义 / 文案 / display·notify（src/tools/set-compact-threshold-tool.ts 新建；§5 合写，全部定死）

工具结构仿 compact-tool.ts：TypeBox 参数、`createSetCompactThresholdTool(deps)` 工厂、deps = `{ getState: () => CompactHintState | undefined; compactToolEnabled: () => boolean }`。

- **name** `set_compact_threshold`，**label** `Set Compact Threshold`。
- **参数**：`percent?: number`——省略 = 查询；`0` = 关闭；`>= 1` = 设定（小数 `Math.floor`）；**`0 < percent < 1` 一律 `ok:false, reason:"invalid"`（P1c 定死）**——floor 会把 0.9 变 0 等同关闭，与调用者设定意图相悖，最小合法设定值为 1。文案说明合法域：`0` 或 `>= 1` 的数。
- **其余校验**：print/json → `non_interactive_mode`（文案对齐 compact-tool.ts:101-112）；非有限 / 负 / >100 → `invalid`；超动态上限（窗口已知）→ `above_cap`（**拒绝不写入**，§3.4）；compactToolEnabled false → `compact_tool_disabled`；getState() undefined → `no_session`。
- **写入语义**：成功写入执行 `thresholdPercent = floor(v); hintedAt = undefined; lastHintAt = 0`（§3.3）。
- **返回内容**：当前用量（缺失降级 "unknown"）、设定阈值、生效阈值（窗口已知时按动态上限钳制后的值）、本次动作（set/off/query）。
- **promptSnippet/promptGuidelines**：阈值只是提示线不是自动压缩；生效值钳制在 pi 自动压缩线之下；0 关闭；省略查询；合法域 0 或 ≥1。

**提示文案**（builder 在 threshold.ts，中英混排仿 mention.ts:38-44）：

```
[pi-subagent 上下文提示] 当前上下文已使用约 {percent}%（生效阈值 {threshold}%）。
你可以调用 compact_context 工具主动压缩历史、释放上下文空间——是否压缩、何时压缩由你自主决定；
本提示仅为提醒，不会强制执行。若当前任务正处关键阶段，可忽略本提示继续工作。
```

**定死的决策（维持 v2 Minor 7 结论）**：消息 `display: false`；toast 发（`ctx.hasUI` 门控，try/catch 吞错，不影响状态置位）；print/json 模式 hook 整体跳过（不发消息、不发 toast、不动状态）；triggerTurn:false 语义 = streaming 中当前 turn_end 后追加进上下文、下一轮可见；run 已结束则只落历史、不自动起新 turn、等未来触发。

## 6. settings 字段（src/config/settings.ts）

- `CompactSettings`（:80-82）：
  ```ts
  /** 越阈提示百分比原始设定值；0 = 关闭。初始值，运行时被 set_compact_threshold 改写（per-session，不持久）。 */
  hintThresholdPercent: number;
  /** pi compaction.reserveTokens 的手动覆盖（最高优先级，§4）；缺省 = 读 pi settings 文件。 */
  assumedReserveTokens?: number;
  ```
- `DEFAULT_SETTINGS.compact` → `{ enabled: true, hintThresholdPercent: DEFAULT_HINT_THRESHOLD_PERCENT /* 75 */ }`（assumedReserveTokens 缺省不存在）。
- `parseCompactSettings`（:369-373）照 `count()` 风格：`hintThresholdPercent` 要求有限数、`=== 0` 或 `>= 1`（**(0,1) 区间非法回落默认 — P1c 与工具侧同规**）、`<= 100`，合法取 `Math.floor`；`assumedReserveTokens` 仅在有限且 > 0 时设置（exactOptionalPropertyTypes：不存在而非 undefined），非法丢弃。
- 均非时长字段，不进 `TIME_SETTING_MS_PATHS`。
- **settings 是初始值**：工具改的阈值活在 stack 的 compactHint 里；stack 重建后回落 settings 值（不持久化，范围外）。

## 7. 改动文件清单（v3）

| 文件                                             | 改动                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/compact-hint/threshold.ts`                  | **新建**：§2 常量（COMPACT_HINT_CUSTOM_TYPE / DEFAULT_HINT_THRESHOLD_PERCENT / COMPACT_HINT_COOLDOWN_MS / PI_DEFAULT_RESERVE_TOKENS）+ 纯函数                                                                                               |
| `src/compact-hint/pi-settings.ts`                | **新建（P0）**：`readPiCompactionReserveTokens` / `resolveReserveTokens`（§4）                                                                                                                                                              |
| `src/tools/set-compact-threshold-tool.ts`        | **新建**：§5 工具规范                                                                                                                                                                                                                       |
| `src/config/settings.ts`                         | CompactSettings 两键（assumedReserveTokens 可选）；DEFAULT_SETTINGS；parseCompactSettings（§6）                                                                                                                                             |
| `src/stack.ts`                                   | `CompactHintState`（含 hintedAt 记录 + reserveTokens）+ Stack 增字段 + buildSessionStack 初始化（enabled=false ⇒ 0；reserveTokens = resolveReserveTokens(settings.compact.assumedReserveTokens, ctx.cwd)）+ `createCompactHintHook`（§3.2） |
| `src/index.ts`                                   | import；门控内注册工具（:177-179 块内）；顶层 `pi.on("turn_end", …)`（:113 旁）                                                                                                                                                             |
| `tests/compact-hint/threshold.test.ts`           | **新建**（§8.1）                                                                                                                                                                                                                            |
| `tests/compact-hint/pi-settings.test.ts`         | **新建（P0）**（§8.2）                                                                                                                                                                                                                      |
| `tests/tools/set-compact-threshold-tool.test.ts` | **新建**（§8.3）                                                                                                                                                                                                                            |
| `tests/config/compact-settings.test.ts`          | **追加**（§8.4）                                                                                                                                                                                                                            |
| `tests/integration/compact-hint-wiring.test.ts`  | **新建**（§8.5）                                                                                                                                                                                                                            |

## 8. 测试计划（v3，全量与工具规范一致性自查过）

### 8.1 纯函数（tests/compact-hint/threshold.test.ts）

1. **上限矩阵（P1b 精确字面值，node 实测复核）**：reserve=16384 下 32000→48、32768→50、64000→74、65536→75、128000→87、131072→87、200000→91、262144→93；
2. reserve 自定义（如 32768）改变上限：128000→74、200000→83、262144→87，逐一算清断言（对照组：同窗口 reserve=16384 时 87/91/93）；并验证取大合并语义：项目值 < 全局值时生效全局值，项目值 > 全局值时生效项目值（§4）；
   2b. **冷却哨兵**：测试时钟 now 从 0 起步时，lastHintAt=0（从未发过）不得被冷却拦截——首个越阈必须发出（验证 `lastHintAt > 0 &&` 守卫）；
3. 非法 contextWindow（0 / NaN）→ 0；`effectiveThresholdPercent(0, …)` 恒 0；设定值低于上限时 effective = 设定值；
4. `buildCompactHintText` 含百分比/阈值数字与关键中英句。

### 8.2 pi settings 读取（tests/compact-hint/pi-settings.test.ts，tmp dir）

必含用例：项目覆盖全局的常规链；**保守取大**（项目 8192 + 全局 32768 → 生效 32768；反向亦然）；ENOENT 静默；JSON 非法 warn+跳过；EACCES/EISDIR 等 I/O 错误 warn+跳过且**另一层仍生效**；两层都失败 → 回退 16384；null/字符串/负数/0 视为缺失；插件 override 压制一切文件值；读取函数任何输入下不抛异常。

1. 项目文件有值、全局无 → 项目值；两者都有 → **项目覆盖全局**；
2. 仅全局有 → 全局值；都无 → undefined；
3. 文件缺失（ENOENT）静默跳过；JSON 非法 → console.warn + 跳过；`reserveTokens` 为字符串/负数/0/缺键 → 视为缺失；
4. `resolveReserveTokens` 优先级链四条逐一断言：override > 项目 > 全局 > 16384；override 非法（0/-1/NaN）视为不存在。

### 8.3 工具单测（tests/tools/set-compact-threshold-tool.test.ts）

1. print/json → `non_interactive_mode`；
2. 省略 percent → 查询：回显设定值 + 生效值 + 用量，state 不变；
3. 合法设定 → 写入且 `hintedAt/lastHintAt` 复位（§3.3 直接断言）；
4. `percent: 0` → 关闭 + 复位；
5. **`percent: 0.9` / `0.5` → `invalid`（P1c）**，state 不变；`1` 合法；`75.9` → 75；
6. 超动态上限（假 ctx contextWindow=200000、state.reserveTokens=16384，设 84 > 83）→ `above_cap`，state 不变；设 83 合法；
7. 非法值（-5 / NaN / 101）→ `invalid`；
8. `compactToolEnabled() false` → `compact_tool_disabled`；`getState()` undefined → `no_session`；
9. usage 缺失 / tokens null 时回显降级不抛。

### 8.4 settings 解析（追加 tests/config/compact-settings.test.ts）

1. 缺省 → `{enabled:true, hintThresholdPercent:75}`，assumedReserveTokens **不存在**；
2. 合法透传（60 / 0 / assumedReserveTokens:32768）；
3. 非法回落：负数 / 字符串 / NaN / 101 / **0.5（P1c）** → 默认 75；assumedReserveTokens 非法 → 键不存在；
4. 旧文件（无新键）→ 默认（向后兼容）。

### 8.5 wiring 集成（tests/integration/compact-hint-wiring.test.ts，fakePi() 模板）

（fakePi 的 ctx 假对象提供可编程 `getContextUsage()`；stack 用 settings.compact.assumedReserveTokens=16384 固定 reserve，绕开真实文件读取——文件路径解析由 8.2 覆盖。）

1. **阈值下不发**：40% < 75 → sent 空；
2. **越阈发一次**：200000 窗口 80% → sent 恰 1 条（customType / display:false / triggerTurn:false / details.effective=75）；再 emit → 不发（闩锁匹配）；
3. **边界 `>=`**：percent == 75 发；74.5 不发；
4. **冷却**：回落清闩锁后再越阈但在窗内 → 不发；推进 now 超 10 min → 发；
5. **hinted 置位 → 置零 → 重设 → 高 usage**：发过 → 工具置零 → 重设 → 下一 turn_end 立即再发（不受旧冷却压制）；
6. **hint 后降阈值**：80% 发过（阈值 75）→ 降到 70 → 下一 turn_end 立即再发（写入复位语义）；
7. **hint 后升再降（v3 重写，消除与 above_cap 的矛盾）**：200000 窗口（上限 91）80% 发过（75）→ 升到 **82**（≤ 上限 91，合法写入）→ 80% < 82，回落分支清闩锁、不发 → 再降回 75 → 下一 turn_end（80% ≥ 75，闩锁已清且写入复位）立即再发。**另补一条**：试图升到 92 → `above_cap` 拒绝、state 不变（工具规范一致性）；
8. **动态上限随窗口变化**：假 ctx 从 200000 切到 32768（模拟 /model），effective 75→50 → usage 65% 从"不发"（65 < 75）变"发"（65 ≥ 50）；
9. **P1a 窗口切换 × 闩锁**：200000@75% 发过（hintedAt={75,200000}）→ 切 64000（effective=74）→ usage 76% 越阈且闩锁不匹配 → 冷却过后**再发**（同一 percent 持续越阈不再发——闩锁更新为 {74,64000}）；
10. **P1a effective<=0 清闩锁**：切到 8000 窗口（窗口 ≤ reserve ⇒ effective=0）→ 不发且闩锁清空 → 切回 200000 → 80% 可再发（无永久抑制）；
11. **首个 turn 无 usage**：getContextUsage undefined / percent null → 不发且闩锁清 undefined；
12. **sendMessage 抛错**：hintedAt/lastHintAt 不落脏，下一 turn_end 重试；console.warn 被调；
13. **hasUI=false 无 toast；notify 抛错被吞**且状态正常置位；
14. **print/json 模式 hook 整体跳过**；
15. **session_start 重建**：旧阈值丢失回落 settings 值、reserveTokens 重新解析；工具 set 写新 stack；hook 读新值生效；
16. compact.enabled=false → 初始 thresholdPercent=0，越阈不发。

## 9. 开发期验证清单（V5 已改为确定性判据；V1–V4 处置全量自查）

fakePi 覆盖状态机与接线（§8.5）；以下 pi 真实行为必须真机验证。统一方法：hook 内加环境变量门控日志（`PI_SUBAGENT_DEBUG_COMPACT_HINT=1` 时 console.warn 打印 `{percent, effective, contextWindow, hintedAt}` 与每次 send/清闩动作），真实 pi + `/reload` 后逐项操作。

| #   | 待验证项                                              | 验证方法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 确定性判据                                              | 不成立时的可执行处置                                                                                     |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| V1  | turn_end 每 assistant turn 恰一次（含多工具调用批次） | debug 日志计数 vs 会话中 assistant 消息数                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 日志条数 == turn 数                                     | 多派发：闩锁天然去重，无代码改动，记录观测；漏派发：hint 延迟到下一 turn，可接受，文档注明               |
| V2  | retryable error 重试中是否派发 turn_end               | debug 日志 + 会话条目时间线                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 重试期间无重复 hint 发送日志                            | 闩锁 + 冷却兜底；记录观测，无代码改动                                                                    |
| V3  | ctx.compact() abort 后是否派发 turn_end               | 真实会话调 compact_context，看日志                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 若派发则 percent 为 null → 走"清闩锁"分支，无 send 日志 | 若派发且 percent 非 null：闩锁/冷却仍防重复；记录观测                                                    |
| V4  | compaction 进行中 getContextUsage() 形状              | V3 同操作，日志打印完整 usage 对象                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | tokens/percent 为 null（types.d.ts:195）                | 返回旧值：闩锁防重复，记录；返回异常形状：按实际形状在 hook 加防御分支（代码改动点明确）                 |
| V5  | hint 消息在同一 run 下一轮进入模型上下文              | **确定性判据（v3 重写）**：越过阈值后继续 run，然后用 `ctx.sessionManager.getEntries()`（经临时 debug 命令或直接读 session JSONL 文件）断言：① 存在恰一条 `type:"custom_message" && customType:"subagent:compact-hint"` 条目；② 其位置在下一条 assistant 消息之前；③ hint 之后、无用户输入时没有新 assistant 消息（未触发 turn）；④ **hint 后的下一次 LLM 请求确实携带该消息**——经 `before_provider_request` 事件（或 debug 日志打印请求 messages 尾部）断言 custom 消息在进入模型的 payload 里，不靠 JSONL 顺序推断 | 四条全部满足                                            | ①②④不满足 ⇒ 改 `deliverAs:"nextTurn"` 重测（同签名，types.d.ts:973）；③不满足 ⇒ 检查是否误传 triggerTurn |
| V6  | hasUI / ui.notify 在 TUI 与 RPC 的真实行为            | TUI 观察 toast；`--mode rpc` 冒烟                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | TUI/RPC 有 toast，print/json 无                         | 按实际行为收紧 hasUI 判定                                                                                |
| V7  | /model 切换后 contextWindow 即时反映                  | 切模型看日志 contextWindow 字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 立即为新窗口值                                          | 延迟：钳制按旧窗口多算一轮，无害，记录                                                                   |

**V1–V5 全过方可提交 PR**；每项观测结果（含"成立/不成立+处置"）回填本节。门控日志建议保留。

## 10. 范围外 / 风险 / v2→v3 修订对照表

**明确范围外**：不改 pi 自动压缩行为；不动 subagent 会话；不做强制压缩；不把工具改的阈值持久化；不监听 pi settings 文件的会话内变更（stack 重建时重读，§4）。

**残留风险**：

1. 直读 pi settings 依赖其内部路径/键名（`compaction.reserveTokens`、`.pi/settings.json`）——pi 改版读不到时回退 16384，且有 `compact.assumedReserveTokens` 手动覆盖逃生门（§4）。
2. 模型可合法忽视提示——需求本意，不对抗。
3. 阈值 per-session 不持久——后续可加 persist 参数走 persistSettingOverride。

**v2 → v3 修订对照**：

| 复审项                                   | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 落点                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| P0 直读 pi settings 取真实 reserveTokens | 核实路径（全局 `<agentDir>/settings.json`、项目 `<cwd>/.pi/settings.json`）与合并优先级（项目覆盖全局，settings-manager.js:151）；新模块 pi-settings.ts；优先级链写死：插件覆盖 > 项目文件 > 全局文件 > 16384；逐类容错（ENOENT 静默 / JSON 非法 warn / 字段非法视为缺失）；同步 readFileSync、buildSessionStack 每次 session_start 重读；`assumedReserveTokens` 改为可选手动覆盖（删除 32768 默认值，新增 PI_DEFAULT_RESERVE_TOKENS=16384）                                                                                                                                                                             | §0/§4/§6                          |
| P1a 窗口切换 × 闩锁漏洞                  | 闩锁 `hinted: boolean` → `hintedAt: {effectivePercent, contextWindow} \| undefined`；判定不匹配即新越阈事件；`effective<=0` 分支清闩锁；转换表补两行；测试补 8.5-9/10                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §3.1/§3.2/§3.3/§8.5               |
| P1b 数值矩阵错误                         | 核实 pi 模型目录十进制/二进制窗口混用（§0）；矩阵改为精确字面值并经 node 实测复核（reserve=16384：32000→48、32768→50、64000→74、65536→75、128000→87、131072→87、200000→91、262144→93），rounding=floor 写明；文档与测试全部统一                                                                                                                                                                                                                                                                                                                                                                                          | §2/§8.1                           |
| 三审追加（v3.1）                         | ① §0/§4 明确 getCompactionReserveTokens 是实例方法、非包根导出；② 文件容错补全 EACCES/EISDIR/ENOTDIR，每层独立 try/catch，异常不冒泡进 buildSessionStack；③ 合并语义从"复刻项目覆盖全局"改为**保守取大**（projectTrusted 不可知 + 取大恒在安全方向），偏差写明理由；④ 冷却哨兵 `lastHintAt > 0 &&` 守卫（测试时钟从 0 起步时首 hint 不被误拦），转换表补 4 行（拒绝不变/notify 抛错/切窗口回落/reserve 生命周期）；⑤ 8.5-7/8/9/10 数字按 reserve=16384 重算（上限 91、above_cap 用 92、切窗用例用 32768/8000 窗口）；⑥ 8.2 补文件错误与取大用例；⑦ V5 增补判据 ④（before_provider_request 断言消息真实进入 LLM payload） | §0/§3.2/§3.3/§4/§8.1/§8.2/§8.5/§9 |
| P1c floor 后正数变 0                     | 定死：`0 < percent < 1` 一律 invalid（工具拒绝 / settings 回落默认）；最小合法设定值 1；工具规范与 8.3-5、8.4-3 测试同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §5/§6/§8.3/§8.4                   |
| V5 不可执行                              | 改为三条确定性判据（sessionManager.getEntries() 断言 custom_message 条目存在性/位置/不触发新 turn），不成立处置具体（改 deliverAs:"nextTurn" 重测）；V1–V4 处置逐条改写为可执行动作（闩锁兜底记录观测 / 明确代码改动点）                                                                                                                                                                                                                                                                                                                                                                                                 | §9                                |
| 测试 7.4-7 自相矛盾                      | 重写为 8.5-7：升阈值用合法值 82（≤上限 83），另补 above_cap 拒绝用例；全量自查后工具规范（拒绝）与所有测试一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §8.5-7                            |

## 11. v3.2 增量：L2 强制压缩 + 警告文案升级（用户拍板 2026-09-05）

### 11.1 分级语义（纯硬线，无宽限期）

```
percent ≥ warnAt（hintThresholdPercent，默认 75）→ L1 警告（现有机制不变，闩锁+冷却照旧）
percent ≥ forceAt（forceAtPercent，默认 88）     → L2 强制压缩，不等任何人
pi 撞墙线（contextWindow − reserveTokens）        → 兜底不变
```

- **L2 动作**：turn_end hook 内直接 `ctx.compact()`（abort 当前 run → 压缩），压缩完成后自动发
  resume 消息续任务——复用 compact-tool 的 resume 机制（RESUME_TEXT 模式 + in-flight 守卫，
  见 src/tools/compact-tool.ts），不得裸调 compact 让任务断掉。
- **环路安全**：强制压缩完成后若 percent 仍 ≥ effectiveForce（压缩收益不足），冷却期
  （COMPACT_HINT_COOLDOWN_MS）内不重复强制，交 pi 撞墙线兜底 + debug 日志记录。
- **压缩后 percent 回落/变 null** → L1/L2 状态全复位（沿用现有清闩锁分支），下次越阈重新从 L1 开始。
- **状态扩展**：CompactHintState 加 `forceAtPercent`（初始值来自 settings）；闩锁只服务 L1，
  L2 不做闩锁（每次 turn_end 越线都该压，环路安全靠冷却）。

### 11.2 护栏与校验

- `effectiveForce = min(forceAtPercent, maxThresholdPercent(contextWindow, reserveTokens))`——
  force 同样恒低于 pi 自动线；effectiveForce ≤ 0 时 L2 关闭。
- settings 校验：`forceAtPercent` 0..100 整数（0=关闭）；**forceAt 必须 > warnAt**，否则
  forceAtPercent 回落默认 88（parse 层，非法值不生效）。
- 工具 `set_compact_threshold` 加可选 `force` 参数（同 percent 语义：0=关、1..上限=设定、
  省略=不动）；设定时若 `force <= 当前 warnAt` 返回 invalid；查询回显两级阈值。

### 11.3 L2 的用户/模型感知

- 强制前发 toast（hasUI 门控）：`Context X% ≥ 88% — forcing compaction`（warn 级别，非 info）。
- 不向模型上下文注入"即将强制"消息（turn_end 后立即执行，没有意义）；resume 消息即告知。

### 11.4 警告文案升级（替换 buildCompactHintText）

```
[pi-subagent 上下文警告] 上下文已使用约 X%（阈值 Y%）。

建议在当前子任务告一段落后调用 compact_context 主动压缩：
- 通过 instructions 参数写明必须保留的内容（当前目标、关键文件路径、未决决策、TODO），
  这是只有自主压缩才有的控制权；
- 若用量继续涨至 {effectiveForce}%，系统将强制压缩并使用通用摘要，你可能丢失想保留的细节；
- 压缩不是终止：压缩后你会带着摘要自动继续当前任务。
```

（forceAt=0 时第三行替换为"压缩不是终止"段落的直接衔接，不提强制线。）

### 11.5 测试增量（追加到 §8）

- wiring：87% 不强制 / 88% 强制（ctx.compact 被调一次 + resume 消息发出）/ force 后冷却期内再越线不重复强制 /
  forceAt=0 关闭 / effectiveForce 受动态上限钳制（小窗口）/ 强制后 percent null → 状态复位 /
  force 与 L1 闩锁互不干扰（75% 警告→88% 强制→回落→再越 75% 重新警告）
- settings：forceAtPercent 校验（0 关、合法值、forceAt<=warnAt 回落默认 88、非数回落）
- 工具：force 参数设定/查询回显/force<=warnAt 拒绝
- compact resume 机制复用：mock ctx.compact + 验证 resume 消息内容语义（沿用 compact-tool 测试模式）

### 11.6 真机验证追加（§9 清单扩展）

- V8：L2 从 turn_end 触发 ctx.compact() 的真实时序（压缩是否在 turn 边界安全发生、abort 是否影响
  进行中的工具调用批次——turn_end 时批次已落地，预期安全，实测确认）；
- V9：强制压缩后任务经 resume 消息真实续跑；
- V10（行为观察）：新警告文案下模型是否/何时自主压缩、instructions 质量。

## 12. v3.3 增量：阶梯式用量通报（usage tick，用户拍板 2026-09-06）

**动机**：L1 警告（75%）之前模型对上下文用量完全无感知——pi core 不把用量写进系统提示，
footer 只有用户可见，`set_compact_threshold()` 无参查询虽返回当前用量但需要模型"想起去查"
（不知道自己不知道）。模型因此无法做"阶段刚完成、用量已 60%，主动压一波再开新阶段"的规划决策。

### 12.1 语义（v3.4 修订：取消 30% 地板，全区间逐阶梯通报，用户拍板）

```
percent < step（首个阶梯以下）                  → 不通报
percent 跨过 step 网格（usageTickStepPercent，默认 10）→ 一行通报，不催促
percent ≥ L1 阈值但 < L2 强制线                  → L1 警告照发一次；tick 继续逐阶梯通报
                                                  （文案改为“已超过提醒阈值 Y%”）
percent ≥ L2 强制线                              → L2 强制压缩接管，tick 止步
```

- 通报文案（`buildUsageTickText`，customType `subagent:usage-tick`，display:false + triggerTurn:false，
  与 L1 同通道）：低于 L1 阈值时
  `[pi-subagent 上下文通报] 上下文已使用约 X%。达到 Y% 时会再提醒你考虑 compact_context；现在无需操作。`；
  已达/超过 L1 阈值时改为 `已超过提醒阈值 Y%；如果你正在收尾一个子任务，请尽快调用 compact_context。`
- **闩锁**：`CompactHintState.lastTickStep` 记录已通报的最高阶梯，同阶梯不重复。
- **滞回复位**：percent 回落至 `lastTickStep − 5`（USAGE_TICK_HYSTERESIS_PERCENT）以下才重新武装——
  区分真实压缩（掉几十个点）与边界抖动（±1–2 点），后者绝不重报。
- **天花板**：`ceiling = effectiveForce || 100`（v3.4：原为 L1 阈值）；threshold=0（L1 关闭）时 tick 可在
  force 线以下继续工作（纯通报模式）；三者全 0 时 hook 整体短路（原早退条件扩展）。
- 发送失败不落闩锁，下个 turn_end 重试（与 L1 一致）。
- **同 turn 去重**：某一 turn 同时满足“新 tick 阶梯”与“L1 警告发送”时只发 L1（其文案本身携带当前
  百分比），并将 `lastTickStep` 吸收到该阶梯，不当 turn 双注入。

### 12.2 配套：主动查询引导（方案 B）

- `compact_context` promptGuidelines 新增一条：决策前可 `set_compact_threshold()` 无参查询当前用量。
- `set_compact_threshold` description 点明无参调用即"读当前用量与阈值，不改任何状态"。

### 12.3 settings / 状态

- `compact.usageTickStepPercent`：默认 10，0=关闭，合法域 {0} ∪ [5,100]（<5 的步长通报过密，parse 层回落默认）。
- `CompactHintState` 加 `tickStepPercent`（compact.enabled=false 时归 0）与 `lastTickStep`（初始 0）。
- tick 不暴露工具参数——与 `assumedReserveTokens` 一致，settings 文件即配置面。

### 12.4 测试增量

- 纯函数：usageTickStep 首阶梯以下/天花板/自定义步长/0 关闭；buildUsageTickText 低于/超过/无 ceiling 三形态。
- wiring：10% 起逐阶梯通报且消息契约精确（customType/display:false/triggerTurn:false/details.tickStep）/
  同阶梯不重复 / 边界抖动不重报、真实回落（压缩级）后重新武装 / 75% 处 L1 接管（customType 切换）、
  L1 区域 tick 继续通报（80% 阶梯、超阈值文案）/
  threshold=0 时 tick 续命至 force 线 / tickStepPercent=0 全静默。
- settings：usageTickStepPercent 解析（0、15、非法值回落默认）。
