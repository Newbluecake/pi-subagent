# cache-ttl 合并进 pi-subagent — 实施方案（v2，已并入评审意见）

## 背景

现有独立 pi 扩展 `~/.pi/agent/extensions/cache-ttl.ts`（Anthropic 1h prompt cache 开关）：

- `/cache-ttl on|off|auto` 切换，`before_provider_request` 钩子里改写 payload 中所有
  `cache_control: {type:"ephemeral"}` 的 `ttl`（on → `"1h"`，off → 删除 ttl，auto → 不动）
- 状态**立即持久化**到 `~/.pi/agent/cache-ttl-state.json`

## 需求（已澄清）

1. **合并**该功能进 pi-subagent，最终删除旧扩展。
2. **行为变更**：`/cache-ttl` 切换立即生效但**仅当前进程**（不写盘）；**`/cache-ttl save`** 显式持久化。
   （v3 变更：原计划的 Ctrl+S 快捷键被 pi 判定与内建 `app.models.save` 冲突——pi 的冲突检测对所有内建
   defaultKeys 生效，不限作用域，其他 ctrl 字母键同理基本被占完；改为命令式保存，零快捷键冲突面。）
3. 持久化状态**并入 `~/.pi/agent/pi-subagent.json`**（新设置项 `cacheTtl.mode`），不再用独立状态文件。
4. **仅主会话生效**（子 agent 会话不注册该 hook/命令/快捷键）。

## 关键事实（已核实）

- ~~pi.registerShortcut("ctrl+s")~~ **v3 废弃**：pi 启动时把 ctrl+s 报为与内建
  `app.models.save` 冲突（Extension issues 警告，实测复现）——冲突检测对所有内建
  defaultKeys 生效，不限作用域。本方案不注册任何快捷键，持久化走 `/cache-ttl save` 命令。
- `persistSettingOverride(dottedKey, value, path?)` 已支持点分嵌套键写盘，返回错误字符串或
  undefined，never throws；保留文件中其他字段。**已知限制**：read-modify-write 不是多进程安全的
  （与 `/agent settings set` 相同语义，本方案不新造锁）。
- `setting-specs.ts` 有 `choice(path, values, description)` helper，加一行即可让 `/agent settings`
  文本命令和 TUI 编辑器自动支持新设置。
- HOST_KEY 守卫在 `src/index.ts`：子会话 activate 直接 return。wiring 放在守卫**之后**
  即天然"仅主会话生效"。
- 现有状态 `cache-ttl-state.json` 内容为 `{ "mode": "on" }`，需要一次性迁移进 pi-subagent.json。

## 改动清单

### 1. `src/config/settings.ts`

- 新增 `export type CacheTtlMode = "auto" | "on" | "off";`
- 新增 `export interface CacheTtlSettings { mode: CacheTtlMode }`
- `AgentSettings` 增加 `cacheTtl: CacheTtlSettings`；`DEFAULT_SETTINGS.cacheTtl = { mode: "auto" }`
- 新增 `parseCacheTtlSettings(input: unknown): CacheTtlSettings`（仿 `parseCompactSettings`：
  白名单校验，非法/缺失/非对象回落默认，never throws），在 `loadSettings` 中接入。
- **一次性迁移放进 `loadSettingsFromFile`**（评审 major-5：与既有的时间单位迁移同处，
  保持 settings 文件"单一读写点"）：
  - 新增 `migrateLegacyCacheTtlState(raw: Record<string, unknown>, settingsPath: string, legacyPath: string): { value: Record<string, unknown>; changed: boolean }`：
    - legacy 文件不存在 → 原样返回；
    - legacy 存在但 JSON 损坏 / mode 非法 → console.warn，**保留** legacy 文件（下次重试），原样返回；
    - 读 legacy mode 合法：
      - 若 `raw` 已有 own key `cacheTtl`（无论值是否合法）→ 不覆盖；值非法时额外 warn
        （回落 auto 是 parse 的职责）；视为迁移完成，尝试删除 legacy；
      - 否则 `raw.cacheTtl = { mode }`，changed = true；
  - `loadSettingsFromFile` 在已有 `migrateSettingsFileTimeUnits` 之后串联调用；
    **任一迁移 changed 即统一写回一次**（复用现有写回+失败 warn 模式）；
    **只有写回成功（或无写回必要，即 settings 已有键）才删除 legacy 文件**（评审 blocker-1）。
  - 删除 legacy 用 `rmSync(..., { force: true })` 包 try/catch，失败仅 warn（legacy 残留无害——
    settings 已有键时迁移逻辑幂等；settings 无键但删除失败会导致下次重复迁移同一值，幂等可接受）。

### 2. `src/config/setting-specs.ts`

- `SETTING_SPECS` 增加：
  `"cacheTtl.mode": choice("cacheTtl.mode", ["auto", "on", "off"], "Anthropic prompt-cache TTL: auto=follow pi/env, on=force 1h, off=provider default (5m)")`
- 不带 `live` 标记 → 通过 `/agent settings` 修改需 /reload 生效（与多数设置一致）；
  `/cache-ttl` 命令才是会话内即时开关。README 写清两个入口的语义差异（评审 minor-11）。

### 3. `src/cache-ttl/cache-ttl.ts`（新模块）

`export function wireCacheTtl(pi: ExtensionAPI, settings: AgentSettings, deps?: CacheTtlDeps): void`

- **依赖注入**（评审 major-4）：
  ```ts
  interface CacheTtlDeps {
    /** 默认 (mode) => persistSettingOverride("cacheTtl.mode", mode, defaultSettingsPath()) */
    persist?: (mode: CacheTtlMode) => string | undefined;
  }
  ```
  迁移不在此模块（已挪到 settings loader），这里零文件读取。
- **状态**（闭包内，符合 /reload 重复 activate 规范，不用模块级可变状态）：
  `let mode: CacheTtlMode = settings.cacheTtl.mode`、
  `let persisted: CacheTtlMode = settings.cacheTtl.mode`、dirty = `mode !== persisted`
  （`on→off→on` 自然回到 clean，评审 minor-12 状态矩阵由此定义）。
- **hook** `pi.on("before_provider_request", ...)`（评审 blocker-2/3 修正）：
  - `mode === "auto"` → return undefined；
  - `isObjectRecord(event.payload)`（非 null、非数组、typeof object）否则 return undefined；
  - `!Array.isArray(payload.messages)` → return undefined；
  - `structuredClone` 包 try/catch，失败 console.warn 后 return undefined（绝不让请求链因扩展炸掉）；
  - walk 用 `WeakSet<object>` 防循环引用/共享引用重复处理；
    凡 `cache_control` 为对象且 `type === "ephemeral"`：on → `ttl = "1h"`，off → `delete ttl`。
- **命令** `/cache-ttl`：
  - 无参 → notify 当前运行时模式 + 持久化模式（不同时显式列出）+ 用法（评审 minor-11）；
  - `on|off|auto` → 更新内存 mode、刷新状态栏，notify「已切换为 X（仅当前进程生效，/cache-ttl save 持久化）」；
  - `save` → dirty 时 `deps.persist(mode)`；成功 → `persisted = mode`、刷新状态栏、notify 已持久化；
    失败 → dirty 保持、notify 错误内容（写失败不丢未保存标记）；非 dirty → notify「没有未保存的更改」；
  - 非法参数 → warning。
- **不注册快捷键**（v3）。
- **状态栏**：`session_start` 及每次变更时刷新：on → `⏱ cache: 1h`，off → `⏱ cache: 5m`，
  auto → 清除；dirty 时追加 `*`。

### 4. `src/index.ts`

- import + 一行 `wireCacheTtl(pi, settings)`，放在 HOST_KEY 守卫**之后**（仅主会话），
  与其他 wiring 并列。index.ts 保持 assembly-only（I7）。

### 5. 测试 `tests/cache-ttl/cache-ttl.test.ts` + settings 迁移/parse 测试

mock ExtensionAPI 的方式参考现有 tests（tests/extensions、tests/commands）。

**hook 改写**：

- on 给嵌套在 system/messages/tools 里的所有 ephemeral 加 `ttl:"1h"`；off 删 ttl；auto → undefined；
- 原 payload 不被 mutate（clone 验证）；
- 边界：`payload` 为 undefined/null/数组/字符串/数字 → undefined 不抛；
- 循环引用 payload → 不栈溢出、正常改写；共享引用对象不重复处理；
- `cache_control` 为 null/数组/字符串/`type` 非 ephemeral → 不动；
- 无 messages 数组 → 不动。

**settings parse**：合法/非法/缺失/非对象/`cacheTtl: null`；未知字段保留在文件但不进入内部 settings。

**迁移**（临时目录注入路径）：

- legacy 合法 + settings 无键 → 写入 settings、删 legacy、返回值生效；
- legacy 合法 + settings 已有合法键 → 不覆盖、删 legacy；
- legacy 合法 + settings 已有非法键 → 不覆盖、warn、删 legacy、parse 回落 auto；
- legacy 损坏 / mode 非法 → warn、保留 legacy、原样返回；
- settings 写回失败（只读文件/目录）→ **保留 legacy**、不丢配置（评审 blocker-1 回归测试）；
- 迁移与时间单位迁移同次发生 → 一次写回、两者都生效。

**命令**：

- 切换置 dirty、**不写盘**（persist mock 断言零调用）；
- `save` dirty → persist 被调、成功转 clean；persist 返回错误 → dirty 保持、错误 notify；
- `save` clean → 不调 persist；
- dirty 矩阵：on→off（dirty）、on→off→on（clean）、on→auto→on（clean）；
- 无参命令在 runtime≠persisted 时同时显示两者。

**wiring/reload**（评审 minor-10）：

- HOST_KEY 守卫外的二次 activate（模拟子会话）→ 无任何 cache-ttl 注册；
- 两次 activate（模拟 /reload）→ 各自独立闭包，新 activation 从 settings 重建基线
  （未保存的切换丢失——文档注明）。

### 6. 文档

- README.md / README.en.md 增加 cache-ttl 小节：命令（含 save）、设置项、仅主会话生效、
  两个入口（/cache-ttl 会话级 vs /agent settings 持久级）语义差异、
  off = "删除显式 ttl，用 provider 默认 TTL（当前为 5m）"的准确措辞（评审 nit-14）。
- CHANGELOG 走 Conventional Commits 自动生成，提交信息用 `feat(cache-ttl): ...`。

### 7. 收尾（验收通过后，评审 minor-13 修正）

1. `mv ~/.pi/agent/extensions/cache-ttl.ts ~/.pi/agent/extensions/cache-ttl.ts.bak`
2. 启动 pi 实际验证（验收标准 2-4）无冲突、迁移正确
3. 确认无恙后 `rm ~/.pi/agent/extensions/cache-ttl.ts.bak`

## 验收标准

**自动化**：

1. `npm run format:check && npm run typecheck && npm test && npm run build` 全绿；
2. 上述测试矩阵全部落地，含写盘失败保留 legacy 的回归测试。

**手工**（真实 pi 环境）：3. 启动 pi：legacy `{"mode":"on"}` 被迁移 → pi-subagent.json 出现 `"cacheTtl":{"mode":"on"}`，
legacy 文件消失，状态栏 `⏱ cache: 1h`；4. `/cache-ttl off` → 状态栏 `⏱ cache: 5m*`，pi-subagent.json 不变；`/cache-ttl save` → `⏱ cache: 5m`，落盘；5. 重启 pi → 保持 off；切换后不 save 直接重启 → 回退到上次持久化值；
/reload → 未保存的切换同样回退（与重启语义一致）；6. 子 agent 会话无 `/cache-ttl` 命令、请求 payload 不被改写；7. 旧扩展改名 .bak 后无命令重复注册冲突，验证通过再删除。

## 已知限制（显式接受）

- `persistSettingOverride` 多进程 read-modify-write 可能丢写——与 `/agent settings set` 相同语义，
  不新造锁；
- 持久化需显式 `/cache-ttl save`，无快捷键（pi 冲突检测对内建键全面生效，实测 ctrl+s 不可用）。
