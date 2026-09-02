# `/agent settings` TUI 交互编辑器 + 时间单位秒化 — 需求文档

## 背景

pi-subagent 的 `/agent settings` 目前是纯文本命令：`/agent settings` 通过 `ctx.ui.notify` 输出设置列表，`set <key> <value>` / `reset <key>` 修改配置（见 `src/commands/status.ts` 的 `SETTING_SPECS` / `handleSettings`，持久化由 `src/config/settings.ts` 的 `persistSettingOverride` 完成）。所有时间类配置以毫秒存储/显示/输入（如 `foregroundAutoBackgroundMs: 600000`），可读性差。

## 需求 1：交互式 TUI 设置编辑器

- `/agent settings`（无参数）打开**交互式 overlay 编辑器**，基于 pi `ExtensionUIContext.custom()` 自定义组件（技术可行性已确认：`pi-coding-agent` 的 `ExtensionUIContext` 提供 `custom<T>(factory)`，组件获得键盘焦点，`done(result)` 关闭）。
- 列出 `SETTING_SPECS` 全部可配置项（budget._、concurrencyLimit、maxNestedDepth、rememberAgents、fleetWidget、deliveryAttempts、reconcile/coalesce/ack 系列、worktree._、workflow._、bashJobs._ 等）。
- 交互：
  - ↑↓ 导航选择配置项；
  - 数值/字符串：回车进入编辑（内嵌输入框），实时校验（复用现有 SettingSpec 校验规则），非法值就地提示、不写入；
  - boolean：空格/回车直接切换；
  - enum：弹出选项选择；
  - `r` 重置为默认值；
  - Esc 关闭编辑器。
- 修改即时持久化到 settings 文件（默认 `~/.pi/agent/pi-subagent.json`）；生效语义沿用现状：budget.* 立即生效于新 spawn 的 run，其余键持久化后 /reload 生效（编辑器内应有相应提示）。
- **保留**原有文本命令 `set` / `reset` / `list`（脚本化、无 TTY 场景仍可用）。无参数进入编辑器；显式 `list` 仍输出文本列表。

## 需求 2：时间单位全面改为秒（整数秒）

- **存储格式**：settings JSON 中所有时间字段重命名 `*Ms` → `*S`，值为整数秒。涉及（不限于）：
  - `budget.*` 全部时间字段（queueWaitMs、startupMs、bindMs、firstEventMs、idleMs、modelTurnMs、toolMs、compactionMs、totalMs、abortGraceMs、steerMs、reapMs、retrySlackMs；startupRetries 是次数，不变）
  - 顶层：`deliveryBackoffMs`、`foregroundAutoBackgroundMs`、`reconcileTtlMs`、`coalesceWindowMs`、`ackWindowMs`
  - `worktree.gitTimeoutMs`
  - `workflow.replayTtlMs`、`workflow.budget.*`（scriptLoadMs 等 10 个）
  - `bashJobs.autoBackgroundMs`、`bashJobs.retentionMs`（maxLogBytes/maxBackgroundJobs 非时间，不变）
- **显示与输入**：TUI 编辑器、文本命令 `set/list`、tab 补全描述中的时间字段一律以秒显示/接受（整数）。
- **仅整数秒**：不接受小数。现有亚秒语义字段（coalesceWindowMs/ackWindowMs 上限 5000ms）改为上限 5 秒。
- **自动迁移**：加载 settings 文件时检测到旧 `*Ms` 字段 → 值 ÷1000 转为新 `*S` 字段，写回文件并 console.warn 提示；不能整除 1000 的旧值 WARN 并丢弃（用默认值）。迁移不抛异常（沿用 loadSettings 的容错纪律）。
- **运行时内部表示**：DeadlineBudget / AgentSettings 等内部类型是否同步改名（*Ms→*S）或保持毫秒内部表示、仅在配置边界换算，由方案阶段评估后决定；对外可见的存储/显示/输入必须是秒。
- 非时间字段（concurrencyLimit、maxNestedDepth、maxLogBytes、maxBackgroundJobs、maxReconcile* 等）不受影响。

## 验收标准

1. `/agent settings` 在交互式 pi 会话中打开 overlay 编辑器，可完成「导航 → 修改各类型字段 → 持久化」全流程；Esc 正常关闭。
2. 编辑器与 `set` 命令对非法输入均拒绝并给出原因。
3. settings 文件中时间字段为 `*S` 整数秒；旧 `*Ms` 配置文件首次加载自动迁移并 WARN。
4. `npm run format:check`、`npm run typecheck`、`npm test`（1190+ 测试）、`npm run build` 全绿。
5. 文本命令 `set/reset/list` 行为不变（除时间单位显示/输入为秒）。

## 约束

- TypeScript strict（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`）；ESM，相对 import 带 `.js` 后缀。
- Prettier 格式化；Conventional Commits。
- 容错纪律：settings 加载/迁移永不抛异常，非法值字段级回退默认。
- peer 依赖 `@earendil-works/pi-tui` / `pi-coding-agent` `>=0.84.0 <0.86.0`。
