# ask-user / feishu-notify 并入 pi-subagent 实施方案（v2）

> 把 `~/ai/pi-ask-user` 仓库的两个独立 pi 扩展（`ask_user` 工具、`feishu-notify` 通知）vendor 进本仓库，
> 并为 feishu-notify 增加门控。**正式需求（用户拍板，v2 起以此为准）**：
>
> **仅主会话生效；完成类自动通知（结果卡、subagent 汇总卡、空闲提醒）仅在「无后台 subagent 在运行、
> 且无后台 bash 在运行」时发送（忙时 defer 补发或丢弃）；提醒类（心跳、等待输入）与显式触发的通知
> （feishu_notify 工具、/feishu-test、/watch）不受后台门控。**
>
> 本文所有技术断言均基于对两个仓库的实际读码 + 一次真实编译/测试探针实验（附录 A 给出可复现命令）。

## v2 修订记录（对应评审 B1/B2 + M1–M7 + m1–m6）

| 评审项           | 处置                                                                                                                                                                                                        | 位置         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B1 门控范围      | 需求按用户决定 1 正式化（见文首框）；矩阵删除模糊空间：受门控=结果卡/汇总卡/空闲提醒，豁免=心跳/等待输入/feishu_notify//feishu-test//watch；汇总卡**双轴**都查 provider（含 subagent 轴，防与另一批次赛跑） | §5.3         |
| B2 defer 存储    | 明确「内存 defer，接受丢失」语义 + session_shutdown 清理路径；采纳 M6 的 PendingNotification 显式模型                                                                                                       | §5.4         |
| M1 schema 表述   | 删除「逐字节一致」绝对表述，改为「schema 语义兼容」；新增实际工具 schema 的对拍验证节（可复现命令）                                                                                                         | §2.1、附录 B |
| M2 bash 计数     | 改用 `BashJobManager.backgroundJobCount()`（manager.ts:1042，实读确认存在），不再用 list()+isTerminalJobStatus                                                                                              | §5.1         |
| M3 provider 缺失 | 受门控通知 **fail-closed**（不发 + log warning 到 feishu-notify.log），豁免类不受影响；标注为有意选择                                                                                                       | §5.1、§5.3   |
| M4 集成测试      | M3 里程碑增加真实装配集成测试（activate→session_start→provider→注入 live run/bash manager→计数→shutdown→重 activate）与三入口 loader 集成测试                                                               | §7-M3        |
| M5 并存冲突      | 与旧 pi-ask-user 并存定性为**不支持的配置**；activate/session_start 时检测冲突并 fail-safe（拒绝发送 + warning）；README 迁移步骤                                                                           | §6、§7-M4/M5 |
| M7 activity 接线 | 细化：`AskUserComponent.handleInput` 入口统一触发 onActivity（`_resolved` 后忽略），定义 activity 语义，三层测试闭环                                                                                        | §5.6         |
| m1               | loader.test.ts 固定用单文件路径方案——**已实际验证可行**（附录 A.3）                                                                                                                                         | §3.3         |
| m2               | 探针可复现脚本附进 docs（附录 A）                                                                                                                                                                           | 附录 A       |
| m3               | package-lock.json 列入 M0 产物，M0 验证加 `npm ci`                                                                                                                                                          | §7-M0        |
| m4               | tsconfig 修改与根 entry 文件同提交                                                                                                                                                                          | §7-M0/M1/M2  |
| m5               | prettier 只格式化新增/修改文件，不整库 format（给出精确命令）                                                                                                                                               | §7、§8-R1    |
| m6               | M5 里程碑加 CHANGELOG unreleased 条目与迁移文档清单                                                                                                                                                         | §7-M5        |

## 0. 探针实验结论（先说结果）

在 `/tmp/merge-probe` 做过一次完整的「拷贝 → 机械改写 import → 编译 → 跑测试」演练（复现命令见附录 A.1/A.2）：

- 源码在 pi-subagent 的 tsconfig（strict + noUncheckedIndexedAccess + **exactOptionalPropertyTypes** + NodeNext）下
  只有 **5 个编译错误**，全部是 exactOptionalPropertyTypes 引起的（清单见 §2.4）。
- 18 个测试文件搬到 `tests/` 布局、改写导入后，**177/178 通过**；唯一失败的是 `loader.test.ts`
  （它假定包根 `pi.extensions` 只有 ask-user 一个 entry，按 §3.3 用单文件路径适配即可——已验证）。
- `typebox@1.3.23` 与 `@sinclair/typebox@0.34.52` 对本案用到的组合子 **schema 语义兼容**
  （抽样对拍输出一致，见 §2.1 与附录 B 的对拍步骤），`Value.Check` 关键语义一致
  （未声明 `additionalProperties` 时额外字段放行，两边相同）。

## 1. 目标目录布局

### 1.1 源码 vendor 位置

沿用 pi-subagent「`src/` 按子系统分目录」的约定，两个子系统各一个目录：

| 源（pi-ask-user）                                                      | 目标（pi-subagent）               |
| ---------------------------------------------------------------------- | --------------------------------- |
| `src/answer-codec.ts`                                                  | `src/ask-user/answer-codec.ts`    |
| `src/channel-handler.ts`                                               | `src/ask-user/channel-handler.ts` |
| `src/component.ts`                                                     | `src/ask-user/component.ts`       |
| `src/editor-ops.ts`                                                    | `src/ask-user/editor-ops.ts`      |
| `src/index.ts`（214 行，registerTool 装配）                            | `src/ask-user/index.ts`           |
| `src/question-view.ts` / `submit-view.ts` / `types.ts` / `validate.ts` | `src/ask-user/` 同名              |
| `feishu-notify/core.ts`（477 行纯逻辑）                                | `src/feishu-notify/core.ts`       |
| `feishu-notify/index.ts`（578 行装配）                                 | `src/feishu-notify/index.ts`      |

命名说明：与 pi-subagent 现有子系统目录（kebab-case：`compact-hint/`、`cache-ttl/`、`bash/`）风格一致；
不并入现有目录是因为两者都是自洽子系统，`src/ask-user/` 的纯 UI 部分（editor-ops、question-view）
与 `src/ui/` 的 fleet widget 没有共享代码。

### 1.2 测试迁移

`vitest.config.ts` 的 `include: ["tests/**/*.test.ts"]` 无需改动；`fixtures.ts`、`e2e-harness.ts`
不是 `*.test.ts`，不会被 vitest 收集（探针已验证：18 个测试文件 = 15 ask-user + 3 feishu，helper 未被当作测试）。

| 源                                                                  | 目标                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/__tests__/*.test.ts`（15 个）                                  | `tests/ask-user/`                                                                                              |
| `src/__tests__/fixtures.ts`、`e2e-harness.ts`                       | `tests/ask-user/`（helper，非测试文件）                                                                        |
| `feishu-notify/__tests__/{core,extension,subagent-tracker}.test.ts` | `tests/feishu-notify/`                                                                                         |
| `feishu-notify/__tests__/__snapshots__/core.test.ts.snap`           | `tests/feishu-notify/__snapshots__/core.test.ts.snap`（必须随测试文件一起走，vitest 按测试文件相对路径找快照） |

注意：pi-subagent 的 `tsconfig.json` `include` 只有 `src/**/*` 和根 entry，`tests/` 不在 typecheck 范围内
（与现状一致，测试由 vitest/esbuild 转译不做类型检查）。

### 1.3 根目录薄 entry

参照 `index.ts`（pi 的 jiti 入口）模式新增两个文件（详见 §3）：

```
ask-user.ts        # export * from "./src/ask-user/index.js"; export { default } from ...
feishu-notify.ts   # 同上，指向 ./src/feishu-notify/index.js
```

### 1.4 新增/修改的本仓库文件一览

```
新增  src/ask-user/*            (9 个)
新增  src/feishu-notify/*       (core.ts, index.ts)
新增  src/service/background-status.ts        # §5.1 状态共享
新增  tests/ask-user/*          (17 个)
新增  tests/feishu-notify/*     (3 个 + __snapshots__ + 门控新测试)
新增  tests/service/background-status.test.ts
新增  tests/integration/background-status-wiring.test.ts   # §7-M3 真实装配集成测试
新增  tests/integration/three-entries-loader.test.ts       # §7-M3 三入口 loader 测试
新增  ask-user.ts, feishu-notify.ts           # 根薄 entry
修改  package.json + package-lock.json        # pi.extensions / files / devDependencies(fast-check)
修改  tsconfig.json / tsconfig.build.json     # 与根 entry 同提交（m4）
修改  src/index.ts              # 仅装配：发布 background-status provider（I7）
修改  AGENTS.md / README*.md / CHANGELOG.md   # 布局、功能、迁移说明
```

## 2. import 重写规则清单

### 2.1 `typebox` → `@sinclair/typebox`（v2：「schema 语义兼容」，附对拍验证）

pi-ask-user 对 typebox 的全部用法（grep 核实）：

- 运行时 import：`src/types.ts`、`src/index.ts`、`feishu-notify/index.ts` 的 `import { Type } / { type Static } from "typebox"`。
- 测试 import：`src/__tests__/validate.test.ts` 的 `import { Value } from "typebox/value"`。
- 用到的 `Type.*` 符号仅 9 个：`Object, String, Array, Optional, Union, Boolean, Literal, Null, Record`
  —— 在 `@sinclair/typebox@0.34.52`（本仓库 node_modules 实装版本）全部存在且签名兼容。
- `@sinclair/typebox@0.34.52` 的 package.json `exports` 含 `"."` 与 `"./value"` 两个子路径且带
  `import`/`require` 双条件 + 各自 types，NodeNext 下解析无障碍（实读 package.json 确认）。
- **兼容性结论（v2 措辞）**：抽样对拍显示两边对本案用到的组合子产出**语义兼容的 JSON Schema**
  （`Type.Object/String/Optional/Array/Union/Null` 组合的输出在抽样输入上一致）；`Value.Check` 对
  未声明 `additionalProperties` 的 object 放行额外字段，两边一致。不对「所有输入逐字节一致」做断言。
- **对拍验证步骤（M1，附录 B 给出完整可复现命令）**：对**实际工具 schema**（ask_user 的
  `InputSchema`、`ResultSchema`，feishu_notify 的 `Type.Object({status, summary})`）分别在两个包下
  构建，断言：① JSON 序列化一致；② `Value.Check` 正例（合法输入：对象形 options、含 Other 之外的多选）通过；
  ③ 反例（缺 `questions`、`options` 仅 1 项、`status` 非 success/error）两边同样拒绝。
  该对拍落成 `tests/ask-user/schema-compat.test.ts` 一次性守住院线（只测 0.34 侧行为，
  对拍脚本本身作为附录 B 文档化，不进测试套件）。

重写规则（机械 sed 即可完成）：

```
R1a  from "typebox"        → from "@sinclair/typebox"
R1b  from "typebox/value"  → from "@sinclair/typebox/value"
```

### 2.2 相对导入补 `.js` 后缀（NodeNext）

pi-ask-user 的 tsconfig 是 `moduleResolution: "Bundler"`，全部相对导入无后缀。规则：

```
R2  from "./x" → from "./x.js"      # src 内 9+ 处（./types ./validate ./component ...）
R2b  注意多行 import：from 单独成行，sed 按 `from "(\.[^"]*)"` 匹配即可覆盖（探针实测无遗漏）
```

### 2.3 测试文件搬迁后的路径修正

```
R3a  tests/ask-user/:     from "../x"        → from "../../src/ask-user/x.js"
                          from "./fixtures"  → from "./fixtures.js"  (同理 ./e2e-harness)
R3b  tests/feishu-notify/: from "../core"    → from "../../src/feishu-notify/core.js"
R3c  extension.test.ts:120 还有动态导入 await import("../index")
                          → await import("../../src/feishu-notify/index.js")
     （探针第一次跑挂在这里——静态 grep "from" 找不到，务必单独处理）
R3d  loader.test.ts 的 packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
     从 tests/ask-user/ 算起 "../.." 仍是包根（与 src/__tests__ 同深度），**无需改动**。
```

### 2.4 exactOptionalPropertyTypes 适配（5 处，探针编译实测清单）

pi-ask-user 的 tsconfig 没有开 `exactOptionalPropertyTypes`，本仓库开了。全部错误及修法：

| 文件（vendor 后路径）             | 位置 | 问题                                                                         | 修法                                                                                       |
| --------------------------------- | ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/ask-user/channel-handler.ts` | :78  | `{ signal: AbortSignal \| undefined }` 传给 `{ signal?: AbortSignal }`       | 把 `askUserInteract` 的 options 形参类型改为 `signal?: AbortSignal \| undefined`           |
| `src/ask-user/index.ts`           | :68  | 同上（调用 `askUserInteract` 处）                                            | 同上，改形参声明即可                                                                       |
| `src/feishu-notify/core.ts`       | :59  | `parseConfig` 返回字面量给 `Config`，`webhookUrl/secret` 可能 undefined      | `Config` 的两个字段声明为 `webhookUrl?: string \| undefined; secret?: string \| undefined` |
| `src/feishu-notify/core.ts`       | :302 | `parseSubagentLifecycle` 返回 `{ status, generation }` 可能 undefined        | `ParsedLifecycle` 字段加 `\| undefined`                                                    |
| `src/feishu-notify/index.ts`      | :353 | `sendCard → buildCard` 传 `errorMessage?: string` 收到 `string \| undefined` | `BuildCardInput.errorMessage` 声明加 `\| undefined`（`overrides` 同理检查）                |

原则：只放宽**类型声明**（加 `| undefined`），不改运行逻辑；这是对本仓库 tsconfig 语义最小幅的适配。

### 2.5 pi-tui / pi-coding-agent 导入

`@earendil-works/pi-tui` 用到的符号（`Box, Text, TruncatedText, truncateToWidth, matchesKey, parseKey, visibleWidth, wrapTextWithAnsi, type Component`）与 `@earendil-works/pi-coding-agent` 的类型
（`ExtensionAPI, ExtensionContext, AgentToolResult, AgentToolUpdateCallback, ToolRenderResultOptions`）
均已在本仓库同版本 peer range（`>=0.84 <0.86`）的 `dist/index.d.ts` 中逐一确认存在，无需改动。

## 3. 入口与 package.json 变更

### 3.1 根薄 entry（照抄 index.ts 模式）

`ask-user.ts` / `feishu-notify.ts`：

```ts
export * from "./src/ask-user/index.js";
export { default } from "./src/ask-user/index.js";
```

pi 用 jiti 加载 `.ts` entry 并把 `.js` 后缀映射回 `.ts`（与现有 index.ts 相同机制）。
**不需要** `ask-user.js`/`feishu-notify.js` 的 Node 版伴随文件——那两个 entry 只给 pi 用，
Node 消费者不直接 import 它们（见 §3.4 exports 不动的理由）。

### 3.2 package.json diff

```jsonc
{
  "pi": { "extensions": ["./index.ts", "./ask-user.ts", "./feishu-notify.ts"] },
  "files": [..., "ask-user.ts", "feishu-notify.ts"],       // 现有 "src" 已覆盖 vendor 源码
  "devDependencies": { ..., "fast-check": "^4.9.0" }        // 与 pi-ask-user 同版本
}
```

- `pi.extensions` 顺序有意义：pi-subagent 主 entry 必须**最先** activate（先 claim HOST_KEY、
  先发布 §5.1 的 status provider），ask-user/feishu-notify 随后。数组顺序即加载顺序。
- `main` 不变（`dist/index.js`）。**package-lock.json 随 M0 一并提交**（m3）。

### 3.3 loader.test.ts 适配（v2/m1：固定单文件路径方案，已实际验证可行）

**已验证**（附录 A.3 命令实跑）：`loadExtensions(["<pkg>/index.ts"], cwd)` 在 pi-ask-user 仓库实测返回
`{ errors: [], extensions: 1 个, tools: ["ask_user"] }` —— loader 接受单文件路径。

因此 loader.test.ts 固定改为：

```ts
const loaded = await loadExtensions([join(packageRoot, "ask-user.ts")], packageRoot);
expect(loaded.errors).toEqual([]);
expect(loaded.extensions).toHaveLength(1);
// 断言 ask_user 已注册（与原断言相同）
```

不加载包根 → 不会 activate 主扩展（无 HOST_KEY 副作用、无 compat warn）。兜底方案（若未来 loader
行为变化）：加载包根并在全部 extensions 的 tools 里查找 `ask_user`。三入口的整体加载验证移到
`tests/integration/three-entries-loader.test.ts`（§7-M3）。

### 3.4 exports 不动

`exports` 维持只有 `"."`：pi 解析扩展走 `pi.extensions` 清单而非 exports；Node 消费者只用主入口。
新增 entry 不进入 Node API 面，避免无意承诺。

## 4. 构建兼容性

- `tsconfig.json` `include`：增加 `"ask-user.ts"`, `"feishu-notify.ts"`（否则根 entry 不被 typecheck）。
- `tsconfig.build.json` `exclude`：同步增加这两个文件。现有 exclude 已有 `index.ts` 的先例——
  因为 `rootDir: "src"`，任何 `src/` 之外的输入都会破坏 rootDir 约束；根薄 entry 属于「pi 专用、
  jiti 直读 TS」的入口，不进 dist。
- **m4：tsconfig 修改与根 entry 文件在同一提交内落地**（先加配置后加文件会导致中间态 typecheck 报错
  ——include 指向不存在的文件 tsc 会失败）。
- `src/ask-user/`、`src/feishu-notify/` 在 rootDir 内，正常编译进 `dist/ask-user/`、`dist/feishu-notify/`
  （无害，且让 `tsc -p tsconfig.build.json` 成为对新代码的第二道类型关卡）。
- **测试绝不进 dist**：tests/ 本就不在任何 tsconfig include 里，天然隔离；无需额外动作。
- vitest 对新布局零配置（include `tests/**/*.test.ts` 已覆盖）。

## 5. feishu-notify 门控设计（核心新增）

### 5.1 跨扩展状态共享机制（v2：M2 bash 计数改用 backgroundJobCount；M3 缺失 fail-closed）

仿照 `src/index.ts` 的 `HOST_KEY = Symbol.for("pi-subagent:host")` globalThis 守卫模式
（该模式已验证可跨 jiti 的 `moduleCache:false` 重载保持单例），新增模块
**`src/service/background-status.ts`**：

```ts
export interface BackgroundTaskStatus {
  /** 当前 session stack 中非终态 run 数（queued/starting/running/stopping） */
  runningSubagents: number;
  /** 本进程持有的后台 bash job 数；null = bash-jobs 功能关闭（win32 或 autoBackgroundMs=0） */
  runningBashJobs: number | null;
}
const STATUS_KEY = Symbol.for("pi-subagent:background-status");

/** 主扩展 activate() 调用；返回的 release 用 identity check（与 HOST_KEY 释放同模式）。 */
export function publishBackgroundStatus(getStatus: () => BackgroundTaskStatus): () => void;

/** feishu-notify 调用。返回 undefined = provider 缺失（主 entry 未激活/被用户从
 *  pi.extensions 摘掉/compat 失败前已发布除外——发布点在 compat gate 之前，见下）。 */
export function readBackgroundStatus(): BackgroundTaskStatus | undefined;
```

发布点（`src/index.ts`，只加装配代码，守 I7）：在 HOST_KEY claim 成功之后、compat gate **之前**
发布，provider 闭包读 `holder.current`：

- `runningSubagents`：`holder.current?.query.list()` 过滤 `["queued","starting","running","stopping"]`
  （RunStatus 终态集见 `src/core/types.ts:22`；registry 由 `createLiveRunRegistry` 支撑，live run 可见——
  `src/service/run-registry.ts:34`）。无 stack（session_start 前）按 0 计。
- `runningBashJobs`（**v2/M2**）：`bashJobsEnabled(settings)`（`src/stack.ts:114`：非 win32 且
  `autoBackgroundMs>0`）为 false 时返回 **null**；否则 `stack.bashJobs?.backgroundJobCount() ?? 0`。
  `backgroundJobCount()` 在 `src/bash/manager.ts:1042` 实读确认存在（接口声明 :226），语义为
  `record.status === "running" && record.backgroundedAt !== undefined && record.hostPid === hostPid`
  计数——即只统计**本进程持有的、已真正后台化的、运行中** job。推论（明确语义）：
  - `staged`（已建未跑）**不计入**——job 尚未在跑，不构成「后台 bash 在运行」；
  - 前台 bash（`backgroundedAt === undefined`，仍在自动后台阈值内）不计入——它同步阻塞主 run，
    主 run 未 settle 时本就不会触发完成类通知；
  - 其他 pi 进程遗留的 job（`hostPid` 不匹配，含 `shutdownPolicy:"keep"` 留下的）不计入——
    它们不受本实例管理，计入会导致门控被不可控外部状态永久卡住（有意取舍，写进用户文档）。
- 释放：与 HOST_KEY 同一个 `session_shutdown` handler 里 identity-check 后 delete。

**「bash 功能关闭」的明确决定：`runningBashJobs: null`，门控视为恒真（vacuously true）。**
理由：功能关闭时 pi-subagent 根本不接管 bash（内建 bash 无后台概念），「无后台 bash 在跑」
客观上成立；视为恒真而不是「忽略该条件」在代码上也更干净（`null` 不参与 `> 0` 判定）。

**provider 缺失的决定（v2/M3，有意选择）：受门控的通知 fail-closed** —— `readBackgroundStatus()`
返回 `undefined` 时，结果卡/汇总卡/空闲提醒**不发送**，每会话 log 一次 warning 到
`~/.pi/agent/feishu-notify.log`（复用现有 `log()`），并在 `ctx.hasUI` 时 `ctx.ui.notify(..., "warning")`。
理由：门控的存在是为了防止「后台还在跑就误报完成」；无法确认后台状态时发送，恰恰可能制造
该需求要消灭的误报，宁可漏发。豁免类（心跳/等待输入/feishu_notify/命令）不受此影响，照常工作。

### 5.2 主会话检测

feishu-notify 作为独立 extension entry，会在每个 subagent 子会话里被重新 activate
（pi 的 `bindExtensions`；pi-subagent 的 AGENTS.md 已记载子会话会 re-import 扩展）。
采用与 HOST_KEY 相同的 first-wins claim：

```ts
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
// activate 开头：已 claim → 直接 return（子会话 inert：不注册 feishu_notify、/watch、/feishu-test，不挂任何事件）
// session_shutdown 时 identity-check 释放（与 src/index.ts 的 HOST_KEY 释放完全同构）
```

成立的前提假设与 HOST_KEY 相同：主会话在进程启动时最先 activate 全部扩展，子会话只会更晚创建。
佐证：`createAgentSession`（sdk.js）本身**不调用** `bindExtensions`，子会话的 `_extensionMode`
保持默认 `"print"`（agent-session.js:122），这也解释了为什么 ask_user 在子会话里
`ctx.mode !== "tui" && !== "rpc"` → 走既有的 headless 自禁用路径，无需额外守卫。

### 5.3 各触发点门控决定（v2：按正式需求定稿，无模糊空间）

统一定义（纯谓词放 `src/feishu-notify/core.ts`，保持其「纯逻辑无 IO」定位；wiring 在 index.ts）：

```ts
/** provider 缺失 → 受门控路径视为 not idle（fail-closed，见 §5.1/M3） */
function backgroundIdle(status: BackgroundTaskStatus | undefined): boolean {
  if (status === undefined) return false;
  return status.runningSubagents === 0 && (status.runningBashJobs ?? 0) === 0; // null 恒真
}
```

| 触发点                                 | 主会话门控                          | 后台门控    | 忙时语义                                                 |
| -------------------------------------- | ----------------------------------- | ----------- | -------------------------------------------------------- |
| 结果卡（agent_settled，success/error） | ✅                                  | ✅          | **defer**（PendingNotification，§5.4）                   |
| subagent 汇总卡                        | ✅                                  | ✅ **双轴** | **defer**（§5.4；tracker 记录不提前 discard）            |
| 空闲提醒（idle）                       | ✅                                  | ✅ 双轴     | **丢弃**：arm 时与 fire 时各查一次                       |
| 心跳卡（heartbeat）                    | ✅                                  | ❌ 豁免     | —（正式需求）                                            |
| 等待输入卡（waiting）                  | ✅                                  | ❌ 豁免     | —（正式需求）                                            |
| `feishu_notify` 工具                   | ✅（host guard 保证只在主会话注册） | ❌ 豁免     | —（正式需求；显式成功另取消同任务 pending 结果卡，§5.4） |
| `/feishu-test`、`/watch`               | ✅                                  | ❌ 豁免     | —（正式需求）                                            |

逐点说明：

- **结果卡**：用户需求核心场景——主任务结束 ≠ 全部结束。忙时进 pending，idle 时补发；超过
  `backgroundDeferCapMs` 仍补发并在卡片追加「后台任务超时未结束」注记。
- **subagent 汇总卡（B1 内核）**：除自身 tracker 的 `runningCount==0 && hasFinished` 条件外，
  flush 时必须**同时**查 provider 双轴——subagent 轴查 provider 是为了防止与**另一个批次**的
  subagent 赛跑（本 tracker 只含它见过的 runId；provider 的 `runningSubagents` 是全 session 的
  权威计数，含本批次之外/之后新起的 run）。任一轴忙 → defer，tracker 记录保留（不 drain/discard），
  真正发送时才 `drainFinished()` 组卡——迟到合批的记录自然并入同一张卡。
- **空闲提醒**：前提是「会话真的闲下来」。现有代码 arm 时只查自己的 SubagentTracker
  （index.ts agent_settled 里 `subagents.runningCount(...)`），改为统一查 provider
  （单数据源，且覆盖 bash）；fire 时复查，忙则丢弃。
- **心跳**：豁免（正式需求）。可选增强：心跳卡追加一行后台任务计数（读 provider，缺失则不追加），
  M4 里做，成本极低。

defer 的驱动：subagent 侧有 `subagent:started/completed/failed` 事件与 flush 链路可做「复检点」；
bash 侧 pi-subagent 不发 pi.events 生命周期事件（bash 完成走 message 通道，`src/stack.ts:102`），
所以 defer 统一用 unref'd 轮询定时器（§5.4）+ 事件复检点双驱动（已确认 feishu 现有全部
定时器都有 `.unref?.()`，新定时器沿用，避免 wedge `pi -p`）。

### 5.4 defer 存储：PendingNotification 模型（v2/B2+M6）

**存储语义（用户拍板）：内存 defer，明确接受丢失。** defer 仅保证**当前扩展实例存活期内**补发；
`/reload`、退出、session 切换时未补发的通知**丢弃**。清理路径：`session_shutdown` handler 里
停轮询 timer、`pendings.clear()`（与现有 clearHeartbeat/clearIdleTimer 并列）。

显式模型（放在 `src/feishu-notify/core.ts` 做纯状态机，index.ts 接线）：

```ts
type PendingKind = "result" | "subagents"; // 空闲提醒是丢弃语义，不进 pending

interface PendingNotification {
  key: string; // result: `result:${taskStartedAt}`；subagents: "subagents:batch"
  kind: PendingKind;
  /** result 卡：冻结 sendCard 入参快照（status/summary/overrides/stats 在 defer 时刻定格，
   *  因为 extractSummary(ctx) 依赖当时会话状态）。
   *  subagents 卡：不冻结 recs——tracker 记录保留，发送时现组卡（见 §5.3）。 */
  card?: FrozenCardInput;
  createdAt: number;
  deadlineAt: number; // createdAt + backgroundDeferCapMs
  state: "pending" | "sending" | "sent" | "failed";
}
```

不变式（逐条对应 M6）：

1. **每 key 只发一次**：进入发送前置 `state="sending"`；成功 → `"sent"` 后从 Map 删除；
   失败 → `"failed"` 后删除并 `log()`。terminal 态（sent/failed）不再触发任何重试。
2. **sending 防重入**：轮询 tick、`subagent:*` 事件复检点、`agent_settled` 可能并发命中同一
   pending；只有 `state==="pending"` 的条目允许进入发送，CAS 式置 `"sending"`。
3. **feishu_notify 显式成功取消同任务 pending 结果卡**：工具发送成功（现有逻辑已置
   `notifiedThisRun=true`）时追加 `pendings.delete(\`result:${taskStartedAt}\`)`——显式卡即终版，
   defer 的结果卡不再补发。
4. **多 pending 不互相覆盖**：`Map<key, PendingNotification>` 按 key 共存；同 key 重复入队
   （理论上 result 同任务只发生一次，防御性处理）→ 替换 card 快照并刷新 deadline。
5. **summary defer 时 tracker 不被提前 discard**：defer 路径不调用 `drainFinished()`/
   `discardFinished()`；只有真正发送的代码路径才 drain。
6. **轮询只在 pendings 非空时 arm**（unref'd，间隔 `backgroundIdleRecheckMs`）；tick 里逐条：
   idle 或 `now >= deadlineAt` → 发送（deadline 路径卡片加注记）；全部 terminal 后停轮询。

### 5.5 设置项设计（写入 `~/.pi/agent/feishu-notify.json`，core.ts 的 parseConfig 扩展）

```jsonc
{
  "requireBackgroundIdle": true, // 总开关；false 退回合并前行为。默认 true（新需求即默认）
  "backgroundIdleRecheckMs": 5000, // defer 轮询间隔；<=0 退化为「忙即丢弃」
  "backgroundDeferCapMs": 600000, // defer 上限；超时补发并注记
}
```

解析沿用 `normalizeNumber` / 布尔归一化模式，新增 `DEFAULT_*` 常量；非法值回落默认，绝不抛异常。
（配置文件路径、`FEISHU_NOTIFY_CONFIG_PATH` 测试隔离机制、`FEISHU_WEBHOOK_URL/SECRET` env 全部保持不变。）

### 5.6 顺带修复：`ask-user:activity` 死通道（v2/M7 细化）

feishu-notify 监听 `pi.events` 的 `ask-user:activity` 来取消等待计时（index.ts:453），
但全仓库 grep 证实 **ask_user 侧从未 emit 过这个事件**（docs 里的 `onActivity` 设计没落地）。

接线设计：

- **`AskUserComponent` 增加可选构造参数 `onActivity?: () => void`**；在 `handleInput(data)`
  **入口**统一触发（component.ts:140），早于所有分支——定义：**任何送达组件的输入事件
  （按键、paste/bracketed-paste 序列）都算 activity**，不做语义过滤（用户正在操作即事实）。
- **resolved 后忽略**：`handleInput` 首行已有 `if (this._resolved) return;`（component.ts:141），
  onActivity 调用放在该行**之后**——组件已完结（提交/取消）后到达的输入不再计为 activity，
  避免取消/提交瞬间的尾巴输入错误地清掉下一个工具的等待计时。
- `src/ask-user/index.ts` 装配：`new AskUserComponent(questions, tui, theme, done, { onActivity: () => pi.events.emit("ask-user:activity", {}) })`。
  RPC 通道（select 模式）无组件，不 emit——等待计时在 RPC 下由 select 返回自然结束，可接受。

测试闭环（三层）：

1. **组件单测**（tests/ask-user/component 或新 activity 测试文件）：任意按键/paste 触发一次
   onActivity；`_resolved` 后的输入不触发；多次输入多次触发（去抖由 feishu 侧 clearWaitTimers 天然承担）。
2. **ask-user index 集成测试**（e2e-harness 路径）：harness 里组件输入 → 断言 fake pi 的
   `events.emit` 收到 `"ask-user:activity"`。
3. **feishu 集成测试**（extension.test.ts 既有用例 :720「ask-user:activity cancels the wait timer」
   已覆盖接收端；补一条端到端：tool_execution_start(ask_user) → bus.emit activity → 断言 waitTimers 清空）。
   接好后该用例从「测了但线上无效」变成真实有效。

## 6. 与独立 pi-ask-user 包并存：不支持的配置 + fail-safe 检测（v2/M5）

**定性：与 `@bluecake/pi-ask-user` 同时安装是不支持的配置。** 风险实读确认：

- **同名工具**：pi 的 `getAllRegisteredTools()` 是「first registration per name wins」
  （runner.js:323 注释），`ask_user`/`feishu_notify` 静默二选一，取决于加载顺序——行为不可预期。
- **命令**：`/watch`、`/feishu-test` 同名注册，冲突行为依版本而定。
- **最危险的是事件面**：两个 feishu-notify 实例**都会**挂 `agent_settled`/`message_end` 等 handler
  → 同一张卡片发两遍、双写 `~/.pi/agent/feishu-notify.log`。

**fail-safe 检测（本方案实施）**：activate 时无法枚举工具（loader.js:155 实读确认 activate 期间
`getAllTools` 是 `notInitialized`），因此检测放在**首个 session_start**：

1. `pi.getAllTools()`（session_start 时 runtime 已初始化；`ToolInfo` 含 `sourceInfo`，
   types.d.ts:1192 实读确认）查找 `feishu_notify` / `ask_user` 的 `sourceInfo` 路径——
   若指向本包之外（旧 pi-ask-user），判定冲突。
2. 同时检查 globalThis 是否已有其他实例标记（防御未来版本互认）。
3. 命中冲突 → `log()` warning + `ctx.ui.notify(..., "warning")` 提示卸载旧包，并置
   `conflictInert=true`：**所有发送路径与事件 handler 提前 return**（fail-safe，宁可全不发）。
   已注册的工具 execute 返回错误文案指引卸载。

**README 迁移步骤**（M5 落地）：① `pi uninstall @bluecake/pi-ask-user`（或从 pi 配置移除该包）；
② 升级/安装合并版 pi-subagent；③ `~/.pi/agent/feishu-notify.json` 配置原样沿用；
④ 首次启动若见冲突 warning 说明旧包未卸干净。

## 7. 分里程碑实施步骤

### M0 — 基建（不改行为）

1. `package.json`：devDependencies 加 `fast-check@^4.9.0`；`npm install` **并提交 `package-lock.json`**
   （m3：lock 是本次产物之一）。
2. **本里程碑不动 tsconfig**（m4：tsconfig 与根 entry 同提交，见 M1/M2）。
   验证：`npm ci && npm run typecheck && npm run build && npm test` 全绿（`npm ci` 验证 lock 一致性）。

### M1 — vendor ask-user

1. 拷贝 9 个源文件到 `src/ask-user/`；应用 §2.1/§2.2 重写；修 §2.4 的 2 处（channel-handler、index）。
2. 拷贝 17 个测试文件到 `tests/ask-user/`；应用 §2.3；loader.test.ts 按 §3.3 改单文件路径。
3. **同一提交**：新建根 entry `ask-user.ts` + `pi.extensions` 增加 `"./ask-user.ts"` +
   `tsconfig.json` include / `tsconfig.build.json` exclude 增加 `ask-user.ts`（m4）。
4. **m5：prettier 只格式化本次新增/修改的文件**，不整库 format：
   `npx prettier --write "src/ask-user/**" "tests/ask-user/**" ask-user.ts package.json tsconfig*.json`。
5. 新增 `tests/ask-user/schema-compat.test.ts`（§2.1 对拍结论的 0.34 侧常驻断言）。
   验证：`npm run format:check && npm run typecheck && npx vitest run tests/ask-user && npm run build`。

### M2 — vendor feishu-notify（行为不变）

1. `core.ts`/`index.ts` → `src/feishu-notify/`；§2.1/§2.2 重写；§2.4 的 3 处修复。
2. 3 个测试 + `__snapshots__/` → `tests/feishu-notify/`；§2.3（**含 R3c 动态 import**）。
3. **同一提交**：根 entry `feishu-notify.ts` + `pi.extensions` + 两个 tsconfig 修改（m4）。
4. prettier scoped 格式化：`npx prettier --write "src/feishu-notify/**" "tests/feishu-notify/**" feishu-notify.ts`。
   验证：全量 `npm run format:check && npm run typecheck && npm test && npm run build`。
   （探针证明此步结束时 177/178 个迁移测试应通过；loader 适配后 178/178。）

### M3 — 后台状态 provider（v2/M4：补真实装配集成测试）

1. 新建 `src/service/background-status.ts`（§5.1 接口）。
2. `src/index.ts`：HOST_KEY claim 后 publish；session_shutdown 里随 HOST_KEY 一起 identity-release。
   严格遵守「模块级无可变状态」（AGENTS.md 既有约束）。
3. `tests/service/background-status.test.ts`（纯单元）：publish/read/release 生命周期、
   provider 缺失返回 `undefined`、bashJobs 关闭时 `runningBashJobs === null`、live run 计入计数（fake holder）。
4. **`tests/integration/background-status-wiring.test.ts`（真实装配，参照现有 wiring 测试模式）**：
   activate(真实 `src/index.js` default) → 触发 session_start（fake ctx）→ 从 globalThis 读 provider →
   断言初始 `{0, ...}` → 经 holder 注入 live run / fake bash manager（或驱动真 spawn 桩）→
   断言计数变化 → 触发 session_shutdown → 断言 provider 已释放 → 重新 activate + session_start →
   断言**新** provider 生效且旧 claim 不残留（identity-release 验证）。
5. **`tests/integration/three-entries-loader.test.ts`**：`loadExtensions([packageRoot], packageRoot)`
   断言 3 个 entry 零错误加载，且 `Agent`/`ask_user`/`feishu_notify` 分别出现在对应 entry 的 tools 里。
   验证：`npm test && npm run typecheck`（其余门禁不动）。

### M4 — 主会话守卫 + 门控 + 冲突 fail-safe

1. `src/feishu-notify/index.ts`：activate 开头加 FEISHU_HOST_KEY first-wins claim（§5.2）。
2. `core.ts`：`backgroundIdle()` 谓词（§5.3）、PendingNotification 状态机（§5.4）、3 个新配置项解析（§5.5）。
3. `index.ts`：按 §5.3 矩阵接线（pending 轮询、idle 双查、汇总卡双轴 defer、心跳后台计数行）；
   §6 的 session_start 冲突检测 + conflictInert fail-safe。
4. `tests/feishu-notify/` 新增门控测试：globalThis 上放 fake provider / 删除 provider，覆盖
   「忙时 defer→idle 补发」「cap 超时补发并注记」「bash 关闭（null）恒真」「provider 缺失 fail-closed
   且有 log」「idle 忙时丢弃」「心跳/等待/feishu_notify 豁免」「feishu_notify 成功取消 pending 结果卡」
   「同 key 防重入/多 key 共存」「子会话 inert（预先 claim 后 activate 不注册任何工具/命令/handler）」
   「session_shutdown 清空 pendings」。
   验证：全量四件套 + 手动 `pi` 里跑一个长 bash job + `@notify` 任务做端到端确认。

### M5 — 收尾（v2/m6 补充）

1. `ask-user:activity` 接线（§5.6，含三层测试）。
2. `AGENTS.md` 布局段落、`README.md`/`README.en.md`：功能说明 + §6 迁移步骤。
3. **CHANGELOG.md 增加 Unreleased 条目**（遵循 Conventional Commits 生成惯例，记录
   feat: ask_user 工具并入、feat: feishu-notify 并入与门控、BREAKING/迁移提示）。
4. **迁移文档清单**（本目录下落地）：① 从 pi-ask-user `docs/dev/feishu-notify/` 移植用户文档并更新
   门控章节；② 迁移指南（卸载旧包→装合并版→配置沿用→冲突 warning 含义）。
   验证：整体验收命令：

```sh
npm run format:check && npm run typecheck && npm test && npm run build
```

## 8. 风险清单（均已实际验证）

- **R0 探针基线**：整套「拷贝+机械改写」流程已演练一次（附录 A 可复现），18 测试文件 177/178 通过、
  源码仅 5 个 exactOptionalPropertyTypes 错误。方案的可行性不是推测。
- **R1 prettier 格式差异**：feishu-notify 源文件用 **tab** 缩进，本仓库 prettier 配置为 2 空格
  （`.prettierrc.json`）。**v2/m5 处置收窄：只格式化新增/修改文件**（§7 各里程碑给了精确命令），
  不整库 `npm run format`，避免无关文件 churn；CI 的 format:check 兜底。
- **R2 fast-check 不在本仓库 devDeps**：`answer-codec.test.ts`、`core.test.ts` 都 `import fc from "fast-check"`。
  处置：M0 加 `fast-check@^4.9.0` 并提交 lock（探针用源仓库的 4.x 实跑通过）。
- **R3 NodeNext × typebox 1.x**：若保留 `import from "typebox"`，1.3.23 的 exports 只有 `import` 条件
  （无 `require`/`types` 分列），NodeNext 下有解析风险。**已规避**：§2.1 整体迁到
  `@sinclair/typebox@0.34`（双条件 exports 实读确认；符号存在性逐一核对；schema 语义兼容经
  抽样对拍 + M1 对拍测试常驻守护）。
- **R4 动态 import 漏改**：`extension.test.ts:120` 的 `await import("../index")` 不在静态 `from` grep 视野内，
  探针第一次运行就挂在这里。已列入 R3c 规则。
- **R5 快照文件随测试搬迁**：`__snapshots__/core.test.ts.snap` 必须与测试文件保持相对位置
  （tests/feishu-notify/**snapshots**/），否则 CI 上快照缺失导致写新快照/失败。
- **R6 jiti 双模块实例**：`/reload` 以 `moduleCache:false` 重导入，两个 entry 若各自缓存状态会出现
  「provider 是新实例、reader 是旧实例」。**设计已规避**：共享状态只走 `globalThis` + `Symbol.for`
  （与 HOST_KEY 同模式），模块内只放无状态函数；feishu-notify 自身的任务级状态本就 per-activate
  闭包持有；§5.4 的内存 defer 在该语义下自然「reload 即丢弃」，与 B2 的决定一致。
- **R7 loader.test.ts 的包布局假设**：v2/m1 已定稿单文件路径方案并实跑验证（附录 A.3）；
  包根三入口加载由 three-entries-loader 集成测试守护。
- **R8 子会话行为**：子会话 `ctx.mode === "print"`（createAgentSession 不 bindExtensions，
  默认 `_extensionMode="print"`），ask_user 首次被调用即自禁用——与独立包现状一致；
  feishu-notify 靠 §5.2 的 host claim 在子会话完全 inert。另注意子会话工具面还受
  `src/runtime/tool-scope.ts` 的 allow-list 管控，ask_user 不会出现在声明了 `tools` 白名单的
  agent type 里，行为可控。
- **R9 定时器**：新增 defer 轮询必须 `.unref()`（AGENTS.md 明确：ref'd timer 会 wedge `pi -p`）。
  feishu 现有定时器已全部带 `unref?.()`，新增代码沿用该写法，M4 测试用 fake timers 验证计数。
- **R10 pi.events 能力**：feishu-notify 依赖 `pi.events.on/emit`（subagent 生命周期、ask-user:activity）。
  本仓库 peer 范围（0.84–0.85）具备该能力（pi-subagent 自己的 pi-compat 也在查 `canUseEvents`）；
  若未来放宽 peer range，需同步在 feishu-notify 加防御性判空。
- **R11 backgroundJobCount 的边界语义**（v2 新增）：§5.1 已列明 staged/前台/跨进程 job 均不计入。
  若用户反馈「上个会话 keep 下来的 job 还在跑却没挡住通知」，属已知取舍；如要改变，
  需另设「含跨进程运行中 job」的计数方法，本方案不做。

## 附录 A — 探针复现命令（v2/m2）

### A.1 编译探针（5 个 exactOptionalPropertyTypes 错误的复现）

```sh
rm -rf /tmp/merge-probe && mkdir -p /tmp/merge-probe/src/ask-user /tmp/merge-probe/src/feishu-notify
cp ~/ai/pi-ask-user/src/*.ts /tmp/merge-probe/src/ask-user/
cp ~/ai/pi-ask-user/feishu-notify/{core,index}.ts /tmp/merge-probe/src/feishu-notify/
cd /tmp/merge-probe
find src -name '*.ts' -exec sed -i -E \
  -e 's|from "typebox/value"|from "@sinclair/typebox/value"|g' \
  -e 's|from "typebox"|from "@sinclair/typebox"|g' \
  -e 's|from "(\.[^"]*)"|from "\1.js"|g' {} +
ln -s ~/ai/pi-subagent/node_modules node_modules
# 写入与 pi-subagent tsconfig.json 相同 compilerOptions + noEmit 的 tsconfig.json 后：
~/ai/pi-subagent/node_modules/.bin/tsc -p tsconfig.json
# 预期：恰好 5 个 TS2379/TS2375 错误，位置与 §2.4 表格一致
```

### A.2 测试探针（177/178 的复现）

```sh
cd /tmp/merge-probe
mkdir -p tests/ask-user tests/feishu-notify/__snapshots__
cp ~/ai/pi-ask-user/src/__tests__/*.ts tests/ask-user/
cp ~/ai/pi-ask-user/feishu-notify/__tests__/*.ts tests/feishu-notify/
cp ~/ai/pi-ask-user/feishu-notify/__tests__/__snapshots__/*.snap tests/feishu-notify/__snapshots__/
# 按 §2.3 R3a–R3c 改写导入（含 extension.test.ts 的动态 import）
ln -s ~/ai/pi-ask-user/node_modules/fast-check node_modules/fast-check
# vitest.config.ts: include ["tests/**/*.test.ts"]
~/ai/pi-subagent/node_modules/.bin/vitest run
# 预期：18 files，177 passed / 1 failed（loader.test.ts，包布局假设）
```

### A.3 loader 单文件路径验证（m1 的实跑记录）

```sh
cd ~/ai/pi-ask-user && node --input-type=module -e "
import * as ca from '@earendil-works/pi-coding-agent';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const hostEntry = resolve('node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const loadExtensions = 'loadExtensions' in ca ? ca.loadExtensions
  : (await import(pathToFileURL(resolve(dirname(hostEntry), 'core/extensions/loader.js')).href)).loadExtensions;
const r = await loadExtensions([resolve('index.ts')], process.cwd());
console.log(r.errors, r.extensions.length, [...r.extensions[0].tools.keys()]);
"
# 实测输出：[] 1 [ 'ask_user' ]  → 单文件路径方案可行
```

## 附录 B — typebox 1.x ↔ @sinclair/typebox 0.34 对拍步骤（v2/M1）

对**实际工具 schema** 做构建输出与 Value.Check 正/反例对拍（在 pi-ask-user 目录跑 1.x 侧、
在 pi-subagent 目录跑 0.34 侧，或单进程同时 import 两个包）：

```sh
node --input-type=module -e "
const a = await import('<pi-ask-user>/node_modules/typebox/build/index.mjs');
const b = await import('<pi-subagent>/node_modules/@sinclair/typebox/build/esm/index.mjs');
const bv = await import('<pi-subagent>/node_modules/@sinclair/typebox/build/esm/value/index.mjs');
// 1. InputSchema 同构构建（照 src/ask-user/types.ts 的 Type.Object/Array/Optional/Union 结构）
// 2. assert JSON.stringify(build(a.Type)) === JSON.stringify(build(b.Type))
// 3. 正例：{questions:[{question:'Q',options:[{label:'A'},{label:'B'}]}]} → Value.Check === true（两边）
// 4. 反例：{} / options 仅 1 项 / status: 'ok'（feishu_notify schema）→ 两边同样 false
"
```

结论落为 §2.1 的「schema 语义兼容」表述；0.34 侧行为由 `tests/ask-user/schema-compat.test.ts` 常驻守护
（正例通过、反例拒绝、关键关键字 minItems/maxItems/anyOf 存在），对拍脚本本身不进测试套件。
