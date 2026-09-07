# set_model 实施方案（运行中切换模型：自己 / 指定 subagent run）· v2（评审修订版）

> **状态：已实现（§11 第 1–6 步已完成并提交）；§10 真机验证 V1–V12 待人工回填。**

> v2 修订说明：评审结论「修订后可实施」（0 Blocker / 1 Major / 8 Minor）已全部落入本文档——
> **M1**（Major：agent type 声明 `tools:` 白名单时 pi 层会在 customTools 进注册表前按白名单过滤，
> `grantedReserved` 只喂 enforcer policy、救不回注册表过滤，run 形态的 set_model 会被静默丢弃；
> 修复见 §0 新增行 + §4.7 第 4 点 + §9.1 新增用例）、**m1**（§4.4 注释的 steerRun 超时类比失实）、
> **m2**（宿主形态 `pi.setModel` 补 `withDeadline` 上界，§4.9/§6 E9）、**m3**（§0/§4.8
> RESERVED_TOOL_NAMES 论证修正：HOST_KEY 守卫使宿主版不进子会话，真正防护对象是 MCP/迟到同名工具）、
> **m4**（run 形态注入补 `available` 候选透传，§4.7）、**m5**（两形态 `promptSnippet` 分开，§3）、
> **m6**（§9.1 补宿主形态 thinking 回写链路用例）、**m7**（§5 在案说明 transcript 可能双写
> `thinking_level_change`）、**m8**（`SetModelOutcome` 统一定义在 `core/types.ts`，§4.1/§4.4）。

> 需求（用户已拍板，不可更改）：
>
> 1. **入口**：独立 `set_model` 工具（挂在 `steer_subagent` 上的方案已否决）。目标可为**自己**（调用者所在
>    session：主会话，或 subagent 自身），也可为**某个正在运行的 subagent run**（按 run_id 指定）。
> 2. **生效时机**：下一次 LLM 调用生效（pi core `session.setModel` 语义），**不中止当前 turn**。
> 3. **thinking**：可选 `thinking` 参数同时指定；不指定则**保持当前档位**，由 pi core clamp 到新模型支持范围。
> 4. **持久化**：写入 session transcript（pi core `setModel` 默认行为），resume 后沿用新模型。
> 5. **模型解析**：与 spawn 完全一致的 fuzzy hint 解析（`src/config/model-hint.ts` 的 `resolveModelHint`）。
>
> 本方案的核心取舍：**不新增状态机 input kind**（改用 `DriverEvent` 变体，转移矩阵 13×12 不变）、
> **不引入新 settings 键**、**不破坏零挂死不变量**（切换路径有独立超时上界）。

## 0. 源码接缝核实表（已逐条读码验证）

| 断言                                                                                                                                                    | 位置（符号 · 行号辅助）                                                                                                                                                             | 结论                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ExtensionAPI` 才有 `setModel/getThinkingLevel/setThinkingLevel`；`ExtensionContext` 没有                                                               | `types.d.ts:1003/1005/1007`（ExtensionAPI）vs `ExtensionContext`（`:208-249` 只有 `model`/`modelRegistry`/`thinkingLevel`）                                                         | 主会话自切换必须在 `src/index.ts` 闭包注入 `pi.*`，先例 `createCompactTool({ sendUserMessage })` · `src/index.ts:206`                                                                                                                                                                                                                |
| `pi.setModel` 语义 = **无 auth 返回 false**、有 auth 则 `session.setModel(model)`（**不传 persist**）                                                   | `agent-session.js:2043-2048`（ExtensionActions 包装）→ `AgentSession.setModel` · `agent-session.js:1252-1268`                                                                       | 只写 **session transcript**（`appendModelChange`），**不写全局默认**（`options.persist` 缺省）；需求 4 成立                                                                                                                                                                                                                          |
| `AgentSession.setModel` 内部会重算 thinking：`_getThinkingLevelForModelSwitch` = 该模型的 per-model 覆盖 → **全局默认** → 当前档位 → DEFAULT            | `agent-session.js:1257` + `:1407-1420`                                                                                                                                              | **陷阱**：若 pi settings 里有 `defaultThinkingLevel`，切模型会把档位改成全局默认而非"保持当前"。需求 3 必须显式回写（§5）                                                                                                                                                                                                            |
| `setThinkingLevel` 自带 clamp，且**只在档位真的变化时**写 transcript                                                                                    | `agent-session.js:1358-1377`（`_clampThinkingLevel` → `clampThinkingLevel(model, level)`）                                                                                          | 本仓库**不自建 clamp**；回读生效档位上报即可                                                                                                                                                                                                                                                                                         |
| resume 时 `options.model` 缺省 → **从 transcript 恢复模型**；thinking 同理                                                                              | `sdk.js:84-95`（`existingSession.model` + `hasConfiguredAuth`）、`:117-125`                                                                                                         | 需求 4 成立；但见 §8.4 的 agent-type `model:` 覆盖陷阱                                                                                                                                                                                                                                                                               |
| subagent 的真实 `AgentSession` 由 `RuntimeRunner.activeHandles` 按 runId+gen 跟踪                                                                       | `src/runtime/runner.ts:222`（Map）、`:365`（set）、`:474-475`（按 gen 删除）                                                                                                        | "切自己"与"按 run_id 切别人"共用同一机制                                                                                                                                                                                                                                                                                             |
| `steerRun` 是可照搬的模板：取 handle → 无则报错 → 调 handle 方法                                                                                        | `RuntimeRunner.steerRun` · `src/runtime/runner.ts:254-258`                                                                                                                          | `setModelForRun` 与之并列（但返回**结果联合**而非 throw，见 §4.4）                                                                                                                                                                                                                                                                   |
| `SessionHandle` 是窄包装接口，`getModelRef?()` 已读活 session 的真实模型                                                                                | `src/runtime/session-driver.ts:20-33`；`PiSessionHandle.getModelRef` · `:211-216`                                                                                                   | 新增 `setModel?/getThinkingLevel?/setThinkingLevel?` 三个**可选**方法，老测试 fake 不破                                                                                                                                                                                                                                              |
| `PiSessionDriver` 已持有 `{provider,id} → pi Model` 解析器（`ctx.modelRegistry.find`）                                                                  | `src/stack.ts:780`；`PiSessionDriver.withResolvedModel` · `session-driver.ts:246-262`                                                                                               | 复用它把 pi Model 对象**关在 driver 边界内**（I1：core/service 层不 import `@earendil-works/*`）                                                                                                                                                                                                                                     |
| `diag.model` 只在两处写入：`enqueued.meta.model`（spawn 时）与 `session_created.model`（创建后一次）                                                    | `state-machine.ts:440`、`:505-507`；runner 侧 `handle.getModelRef()` · `runner.ts:369`                                                                                              | **运行中切换后 widget 会停留在旧模型** → §7 的刷新链路                                                                                                                                                                                                                                                                               |
| 状态机已有"最佳努力诊断类事件"先例：`context_usage` 在**世代/终态守卫之前**早退，纯 patch diag、零 effect                                               | `reduce` 开头 · `src/core/state-machine.ts:394`                                                                                                                                     | `model_changed` 照抄该形状；**不新增 `RunInput.kind`**                                                                                                                                                                                                                                                                               |
| 转移矩阵按 `RunInput["kind"]` 取 cell；`session_event` cell 的事件由 `buildInput` 固定构造（turn_start / tool_end / text_delta）                        | `tests/core/core.test.ts:690-714`、`:1213-1218`（13 kinds × 12 phases = 156）                                                                                                       | 新增 `DriverEvent` 变体**不动矩阵计数**；property 测试的 `randomInput` 也不枚举 DriverEvent（`:1265+`）                                                                                                                                                                                                                              |
| 工具作用域：`RESERVED_TOOL_NAMES` + `buildToolScopePolicy(granted)` 的"deny 默认、按 run 授权"模式                                                      | `src/runtime/tool-scope.ts:21-27`、`:63-70`                                                                                                                                         | `set_model` 必须进 `RESERVED_TOOL_NAMES`，再按 run 授权注入。**论证修正（评审 m3）**：因 HOST_KEY 守卫（`src/index.ts` activate 开头），宿主版 set_model 根本不会注册进子会话，"宿主版泄漏 = 子 agent 改主会话模型"不是真实威胁；真正的防护对象是 **MCP/迟到注册的同名工具与未来改动**（deny 默认保证未授权 run 剥掉它们）。机制不变 |
| **pi 层在 customTools 进注册表前按 `tools:` 白名单过滤**（评审 M1 核实）                                                                                | `agent-session.js:2097-2112`（`_refreshToolRegistry`：`[...registeredTools, ...this._customTools].filter(isAllowedTool)`）+ `sdk.js:141`（`allowedToolNames = options.tools ?? …`） | agent type 声明 `tools:` 白名单时，注入的 run 形态 set_model 会被**静默丢弃**；message_agent / Agent / StructuredOutput 是**同类既有缺陷**。修复：§4.7 第 4 点把 `grantedReserved` 合入 sessionSpec 的 `tools` 白名单                                                                                                                |
| run 作用域工具注入范例：`createMessageAgentTool({ from: spec.runId, generation: () => runtime.getRunState(...)?.generation })` + `grantedReserved.push` | `src/service/runtime-adapter.ts:343-367`                                                                                                                                            | `set_model` 与之并列注入（§4.7）                                                                                                                                                                                                                                                                                                     |
| 端口层 steer 三件套：`Runner.steer?` / `QueryService.steer` / adapter 透传                                                                              | `src/service/ports.ts:56`；`query-service.ts:20-23`、`:97-104`；`runtime-adapter.ts:511-513`                                                                                        | `setModel` 三处镜像                                                                                                                                                                                                                                                                                                                  |
| 目标解析（run_id / 唯一前缀 / label）已是现成件                                                                                                         | `resolveRunId` · `src/service/resolve-target.ts`；`createSteerTool` 用法 · `steer-tool.ts:47-49`                                                                                    | 直接复用，不再造                                                                                                                                                                                                                                                                                                                     |
| fuzzy hint 解析器已在 stack 里构造一次（喂 spawn-service）                                                                                              | `src/stack.ts:813-817`（`ctx.modelRegistry.getAvailable()`）                                                                                                                        | 提升为 `Stack.models` 端口，spawn 与 set_model 共用同一实现（§4.10）                                                                                                                                                                                                                                                                 |
| pi 能力探测集中在唯一允许读 pi 版本/结构的文件                                                                                                          | `src/adapters/pi-compat.ts`（`PiCapabilities` / `MinimalPiHost`）                                                                                                                   | 新增 `canSetModel` 结构探测（I14）                                                                                                                                                                                                                                                                                                   |

## 1. 总体形状

```
                        ┌──────────────── 一个工厂，两种形态 ────────────────┐
                        │        src/tools/set-model-tool.ts (新建)          │
                        │  createSetModelTool(deps) → ToolDefinition         │
                        └───────▲───────────────────────────────▲───────────┘
       宿主形态 (host)          │                               │        run 作用域形态 (self-scoped)
       src/index.ts 注册        │                               │        runtime-adapter customTools 注入
       deps.host = {            │                               │        deps.selfRunId = spec.runId
         setModel: pi.setModel  │                               │        deps.runs.setModel = runner 直连
         get/setThinkingLevel   │                               │        （V1：只允许 self）
       }                        │                               │
       deps.runs.setModel = query.setModel
       deps.resolveHint/findModel = stack.models
                                │                               │
   ┌────────────────────────────┴───────────┐   ┌───────────────┴──────────────────────────┐
   │ 路径 A：目标 = 主会话自己               │   │ 路径 B：目标 = 某个 running run           │
   │ resolveHint(model) → {provider,id}     │   │ resolveHint(model) → {provider,id}        │
   │ findModel(p,id) → pi Model             │   │ resolveRun(run_id) → runId（前缀/label）  │
   │ pi.setModel(Model) → boolean           │   │ QueryService.setModel(runId, ref, opts)   │
   │ false ⇒ auth 缺失（原模型不变）         │   │   → Runner.setModel（ports.ts）           │
   │ thinking：切换后回写并回读生效档位      │   │   → RuntimeRunner.setModelForRun          │
   └────────────────────────────────────────┘   │     ├ activeHandles.get(runId) 无 ⇒ not_running
                                                │     ├ driver.resolveModelRef ⇒ unknown_model
                                                │     ├ handle.setModel(Model)（≤5s 上界）
                                                │     ├ thinking 回写（缺省=切换前档位）
                                                │     ├ effective = handle.getModelRef()（回读）
                                                │     └ dispatchExternal(session_event:model_changed)
                                                └───────────────┬──────────────────────────┘
                                                                ▼
                                     reduce 早退分支 → diag.model = effective
                                     → onStateChange → 活 registry → fleet widget / /agent status
                                     → finish() 拷贝 diag → outcome.diag.model（终态卡片/通知一致）
```

## 2. 需求推导出的语义定稿

| 编号 | 语义                                                                                      | 理由                                                                         |
| ---- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| D-1  | `run_id` 缺省或 `"self"` = 调用者自己。宿主形态的"自己"= 主会话；run 形态的"自己"= 该 run | 需求 1；两形态共用一个 schema，差异只在 description 与 execute 授权          |
| D-2  | run 形态 V1 **只允许 self**；传别人的 run_id 报权限错                                     | fabric `can_message` 的保守授权先例；放宽（parent→descendant）留作 v2（§12） |
| D-3  | 目标必须 `running`；终态 run 一律拒绝，并在错误文本里指路（`Agent(model:…)` / resume）    | 与 `steer_subagent` 的 `not_running` 完全同构                                |
| D-4  | 成功返回**回读到的生效值**（provider/id + thinking），不是请求值                          | hint 可能落到别的模型、thinking 会被 clamp；回读让模型能自纠                 |
| D-5  | 不中止当前 turn、不发 steer、不重置任何 watchdog 预算                                     | 需求 2；`model_changed` 走零 effect 的诊断早退分支                           |
| D-6  | 只作用于 session（transcript），**不写 pi 全局默认**                                      | `pi.setModel` 不传 `persist`（核实表第 2 行）                                |
| D-7  | 无 settings 开关，工具常开                                                                | 无外部副作用、无后台资源；与 `steer_subagent`/`abort_subagent` 同级          |

## 3. 工具参数 schema 定稿

```ts
// src/tools/set-model-tool.ts
export const SetModelParams = Type.Object({
  model: Type.String({
    description:
      "Target model: a strict 'provider/id', or a fuzzy hint — a bare model id ('kimi-k3') or a " +
      "case-insensitive substring alias ('sonnet', 'haiku') — resolved against the models available " +
      "in this installation. The resolved provider/id is reported back in the result.",
  }),
  run_id: Type.Optional(
    Type.String({
      description:
        "Which session to switch. Omit (or pass 'self') for your own session. Otherwise the run id of a " +
        "currently running subagent; a unique run_id prefix or the Agent call's label (its description) also works.",
    }),
  ),
  thinking: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description:
        "Optional thinking level to apply together with the switch ('off' | 'low' | 'medium' | 'high'). " +
        "Omit to keep the current level; the level is clamped to what the new model supports and the " +
        "effective value is reported back.",
    }),
  ),
});
```

- **档位集合**：复用 `core/types.ts` 的 `THINKING_LEVELS`（off/low/medium/high），与 `Agent` 工具的
  `thinking` 参数保持**同一个面向模型的表面**（pi 内部另有 minimal/xhigh/max，本仓库刻意收窄 —— 见
  `core/types.ts:78-84` 的既有注释）。execute 内**再校验一次**（防御性，不依赖宿主是否做 schema 校验）。
- **`description` / `promptSnippet`**（两形态共享前缀，run 形态追加 self-only 说明；宿主形态追加"可切
  subagent"说明）：
  - `description`（宿主形态）：`"Switch the model used from the next LLM call onward — either your own session (omit run_id) or a currently running subagent (run_id). Does not interrupt the current turn: the switch applies to the next model call. Optionally set the thinking level at the same time; otherwise the current level is kept (clamped to the new model's capabilities). The switch is remembered in the session transcript (a resumed session keeps it) and never changes global defaults."`
  - run 形态追加：`" This instance can only switch YOUR OWN session's model; run_id must be omitted, 'self', or your own run id."`
  - `promptSnippet`（**两形态分开，评审 m5**：run 形态 self-only，文案不得出现 "or a running subagent"）：
    - 宿主形态：`"set_model(model, run_id?, thinking?) - switch the model for the next LLM call (self or a running subagent)"`
    - run 形态：`"set_model(model, thinking?) - switch your own session's model for the next LLM call"`
  - `promptGuidelines`（宿主形态）：
    1. `"Use set_model when the remaining work clearly needs a different capability/cost point (e.g. drop to a cheap model for mechanical edits, escalate for hard reasoning)."`
    2. `"The switch takes effect on your NEXT model call — finish the current tool sequence normally, do not re-plan around it."`
    3. `"Report/act on the resolved provider/id in the result: a fuzzy hint may resolve to a different model than you expected."`
- **`renderCall`**（与 steer/compact 同一约定：标题 + 一行 muted meta）：
  标题 `Set Model: <model>`，meta = `target: self|<run_id>` + `thinking: <level>`（有则显示）。
- **`model-facing-strings.test.ts` 约束**：描述里不得出现 `§`/`architecture`（该测试会加入新工具，§9.1）。

## 4. 分层改动清单（自下而上）

### 4.1 `src/core/types.ts` —— 新增 DriverEvent 变体

```ts
export type DriverEvent =
  | …
  /** set_model: the live session's model was switched mid-run (display-only diag patch; see state-machine.ts). */
  | { t: "model_changed"; model: { provider: string; id: string } };
```

同时在本文件新增 `SetModelOutcome`（**评审 m8**：定义位置统一为 `core/types.ts` —— 符合 I1 无 pi 依赖约束，
runner / ports / query-service / 工具层四处共用，不在 runner.ts 重复定义；§4.4 代码块已相应改为引用）：

```ts
/** set_model 切换结果联合：runner 返回 reason union 而非 throw（与 steer 不同），
 *  让 "unknown_model" 与 "session 拒绝" 在工具层映射成不同的自纠文案（§6）。 */
export type SetModelOutcome =
  | { ok: true; model: { provider: string; id: string }; thinking?: string }
  | { ok: false; reason: "not_running" }
  | { ok: false; reason: "unsupported" } // driver/handle 无该能力
  | { ok: false; reason: "unknown_model"; detail: string } // 不在 pi 注册表 / 无 auth 配置
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "rejected"; detail: string }; // pi 拒绝（无 API key 等）
```

不新增 `RunInput.kind`（决策见 §7.1）。

### 4.2 `src/core/state-machine.ts` —— reduce 早退分支

紧跟 `context_usage` 分支（`:394`）之后、**世代守卫之前**插入：

```ts
// set_model: a mid-run model switch is a display-only diagnostics patch —
// it must not enter/re-arm any phase timer (D-5) and emits no effects. Kept
// next to context_usage for the same reason: it is best-effort metadata,
// not a lifecycle transition. Terminal states are left untouched (the
// outcome snapshot is already sealed).
if (input.kind === "session_event" && input.event.t === "model_changed")
  return terminal(state.status)
    ? { state, effects: [] }
    : { state: { ...state, diag: { ...state.diag, model: input.event.model } }, effects: [] };
```

不改 `lastEventType`（与 `context_usage` 一致：不污染 idle/超时判定的事件语义）。

### 4.3 `src/runtime/session-driver.ts` —— handle/driver 两个可选接缝

```ts
export interface SessionHandle {
  …
  /** set_model: switch this live session's model. `model` is an opaque pi Model
   *  (resolved by the driver — core/service layers never see pi types, I1).
   *  Rejects when pi refuses the switch (e.g. no auth for the provider). */
  setModel?(model: unknown): Promise<void>;
  /** Current thinking level ("off" | "low" | … ), when the driver exposes one. */
  getThinkingLevel?(): string | undefined;
  /** Apply a thinking level; pi clamps it to the model's capabilities. */
  setThinkingLevel?(level: string): void;
}

export interface SessionDriver {
  …
  /** {provider,id} → opaque pi Model, for a mid-run switch (create() resolves the same way). */
  resolveModelRef?(provider: string, id: string): unknown | undefined;
}
```

`PiSessionHandle` 实现（薄包装，与 `steer`/`getModelRef` 同风格）：

```ts
setModel(model: unknown) { return this.session.setModel(model as never); }
getThinkingLevel() { return this.session.thinkingLevel as string | undefined; }
setThinkingLevel(level: string) { this.session.setThinkingLevel(level as never); }
```

`PiSessionDriver` 新增（复用构造器里已有的私有 `resolveModel` 依赖；方法名避开同名字段）：

```ts
resolveModelRef(provider: string, id: string): unknown | undefined {
  return this.resolveModel?.(provider, id);
}
```

### 4.4 `src/runtime/runner.ts` —— `setModelForRun`

`SetModelOutcome` **不在本文件定义**（评审 m8）—— 见 §4.1，统一放在 `core/types.ts`；本文件只
`import type { SetModelOutcome } from "../core/types.js"`。

```ts
/** set_model: switch an active run's model. Bounded (SET_MODEL_TIMEOUT_MS) —
 *  session.setModel awaits a provider auth check, and no anti-hang path may
 *  await an unbounded pi call.（评审 m1：steerRun 本身无超时——steerMs 只用于
 *  fabric/reaper——其无界是已知缺陷，本路径是有界新代码，不重复该缺陷，
 *  也不以它为"可照搬的纪律先例"。） */
async setModelForRun(
  runId: string,
  model: { provider: string; id: string },
  opts: { thinking?: string } = {},
): Promise<SetModelOutcome> {
  const entry = this.activeHandles.get(runId);
  if (!entry) return { ok: false, reason: "not_running" };
  const { gen, handle } = entry;
  if (!handle.setModel || !this.d.driver.resolveModelRef) return { ok: false, reason: "unsupported" };
  const resolved = this.d.driver.resolveModelRef(model.provider, model.id);
  if (!resolved) return { ok: false, reason: "unknown_model", detail: `${model.provider}/${model.id}` };
  const previousThinking = handle.getThinkingLevel?.();
  const applied = await withDeadline(handle.setModel(resolved), SET_MODEL_TIMEOUT_MS, this.d.clock, "set_model");
  if (!applied.ok)
    return applied.reason === "timeout"
      ? { ok: false, reason: "timeout" }
      : { ok: false, reason: "rejected", detail: applied.error.message }; // withDeadline 的 error 变体携带 ErrorInfo（消息已带 label 前缀）
  // 需求 3：pi 的 setModel 会按 per-model/全局默认重算档位（核实表第 3 行），
  // 所以"保持当前档位"必须显式回写；clamp 仍由 pi core 负责。
  const desired = opts.thinking ?? previousThinking;
  if (desired !== undefined && handle.setThinkingLevel) {
    try { handle.setThinkingLevel(desired); } catch { /* 非致命：模型不支持该档位，pi 已 clamp */ }
  }
  const effective = handle.getModelRef?.() ?? model;
  this.dispatchExternal(runId, gen, {
    kind: "session_event",
    at: this.d.clock.now(),
    event: { t: "model_changed", model: effective },
  });
  const level = handle.getThinkingLevel?.();
  return { ok: true, model: effective, ...(level === undefined ? {} : { thinking: level }) };
}
```

`src/core/deadline.ts` 新增导出常量（与 `DEFAULT_BUDGET.steerMs` 同取 5s —— 一次 provider 往返的量级；理由各自独立，见 m1）：

```ts
/** set_model 的固定上界：切换只等 pi 的一次 auth 校验 + 状态写入，与 run 预算无关
 *  （per-run budget 只在 run() 内可见），故不进 DeadlineBudget。 */
export const SET_MODEL_TIMEOUT_MS = 5_000;
```

### 4.5 `src/service/ports.ts` —— Runner 端口

```ts
export interface Runner {
  …
  steer?(runId: RunId, text: string): Promise<void>;
  /** set_model: bounded mid-run model switch. Returns a reason union instead of
   *  throwing (unlike steer) so "unknown_model" stays distinguishable from
   *  "the session refused" — the tool turns the two into different, self-correcting messages. */
  setModel?(
    runId: RunId,
    model: { provider: string; id: string },
    opts?: { thinking?: string },
  ): Promise<SetModelOutcome>;
}
```

`SetModelOutcome` 定义在 `src/core/types.ts`（core 无 pi 依赖，runner/ports/query 共用）。

### 4.6 `src/service/query-service.ts` —— QueryService.setModel

```ts
setModel(
  runId: RunId,
  model: { provider: string; id: string },
  opts?: { thinking?: string },
): Promise<SetModelOutcome>;
```

实现镜像 `steer`（`:97-104`）：

```ts
async setModel(id, model, opts) {
  const snapshot = deps.registry.get(id);
  if (!snapshot || snapshot.status !== "running" || !deps.runner.setModel) return { ok: false, reason: "not_running" };
  try {
    return await deps.runner.setModel(id, model, opts);
  } catch (error) {
    return { ok: false, reason: "rejected", detail: error instanceof Error ? error.message : String(error) };
  }
}
```

超时上界已在 runner 内（§4.4），此层不重复计时；`src/index.ts` 的 `forwardQuery` 增加一行转发。

### 4.7 `src/service/runtime-adapter.ts` —— 透传 + run 作用域注入

1. 返回对象里，`steer`（`:511-513`）旁加：

```ts
setModel(runId, model, opts) {
  return runtime.setModelForRun(runId, model, opts ?? {});
},
```

2. `RuntimeAdapterDeps` 新增：

```ts
/** Fuzzy model-hint resolver (same instance spawn admission uses — stack.ts Stack.models). */
resolveModelHint?: (hint: string) => { provider: string; id: string } | undefined;
/** 可用模型候选（stack.models.available 透传，评审 m4）：让 subagent 侧解析失败的候选列举与宿主形态 E2 一致。 */
availableModels?: () => readonly { provider: string; id: string; name?: string }[];
```

3. `customTools` 块里（`message_agent` 注入之后、`Agent` 之前，约 `:367` 后）每个 run 都注入（但“生效”以
   第 4 点的白名单合入为前提 —— 见下）：

```ts
customTools.push(
  createSetModelTool({
    selfRunId: spec.runId,
    runs: { setModel: (runId, model, opts) => runtime.setModelForRun(runId, model, opts ?? {}) },
    ...(deps.resolveModelHint ? { resolveHint: deps.resolveModelHint } : {}),
    ...(deps.availableModels ? { available: deps.availableModels } : {}),
  }),
);
grantedReserved.push("set_model");
```

4. **评审 M1（Major）—— pi 层白名单过滤的修复**：pi 在 customTools 进注册表**之前**按 session 的
   `tools:` 白名单过滤（§0 新增核实行：`agent-session.js:2097-2112` `_refreshToolRegistry` →
   `isAllowedTool`；`sdk.js:141` `allowedToolNames = options.tools ?? …`）。agent type 声明了
   `tools:` 时，上面注入的 set_model 会被**静默丢弃**——`grantedReserved` 只喂 enforcer policy
   （tool-scope 的 allow/deny），救不回 pi 注册表过滤。因此本方案原表述的“无条件注入”不成立：
   注入动作无条件，但**生效**需要把 `grantedReserved` 合入 sessionSpec 的 `tools` 白名单（仅当 type
   声明了 tools）：

```ts
// M1：pi 的 _refreshToolRegistry 按 tools 白名单过滤 customTools；grantedReserved
// 只覆盖 enforcer policy，必须把已授权保留名也合入 pi 层白名单，否则 allow-listed
// type 下注入工具被静默丢弃（message_agent/Agent/StructuredOutput 的同类既有缺陷一并治愈）。
if (sessionSpec.tools !== undefined && grantedReserved.length > 0)
  sessionSpec = { ...sessionSpec, tools: [...new Set([...sessionSpec.tools, ...grantedReserved])] };
```

注明：message_agent / Agent / StructuredOutput 的注入在 allow-listed type 下存在**同类既有缺陷**
（同样被静默丢弃）；本修复按 `grantedReserved` 整体合入，顺带治愈它们，不另开改动。

注意：**不依赖 ExtensionContext**（子会话里 custom tool 的 ctx 不可保证），所有依赖显式注入 —— 同时让
工具 100% 可单测。

### 4.8 `src/runtime/tool-scope.ts` —— 保留名

```ts
export const RESERVED_TOOL_NAMES: readonly string[] = [
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "StructuredOutput",
  "message_agent",
  "set_model", // 评审 m3：HOST_KEY 守卫（index.ts activate 开头）使宿主版根本不会注册进子会话；
  // 此条目的真实防护对象是 MCP/迟到注册的同名工具与未来改动——deny 默认保证未授权 run 剥掉它们
];
```

`tests/runtime/tool-scope.test.ts` 对该常量是泛化断言（`for (const n of RESERVED_TOOL_NAMES)`），无需改测试。

### 4.9 `src/tools/set-model-tool.ts`（新建）—— 一个工厂两形态

```ts
export interface SetModelToolDeps {
  /** 宿主形态：主会话自切换（index.ts 闭包注入 ExtensionAPI）。run 形态不传。 */
  host?: {
    setModel: (model: unknown) => Promise<boolean>; // pi.setModel：false = auth 缺失
    getThinkingLevel: () => string | undefined;
    setThinkingLevel: (level: string) => void;
    /** {provider,id} → 不透明 pi Model（ctx.modelRegistry.find）。 */
    findModel: (provider: string, id: string) => unknown | undefined;
  };
  /** run 形态：本 run 的 id（"self" 语义的落点）。 */
  selfRunId?: string;
  /** 切某个 run 的模型（宿主形态 = query.setModel；run 形态 = runner 直连）。 */
  runs?: {
    setModel: (
      runId: string,
      model: { provider: string; id: string },
      opts?: { thinking?: string },
    ) => Promise<SetModelOutcome>;
  };
  /** fuzzy hint 解析（与 spawn admission 同一实现）。 */
  resolveHint?: (hint: string) => { provider: string; id: string } | undefined;
  /** 可选：错误文本里列举候选，帮模型一轮自纠。 */
  available?: () => readonly { provider: string; id: string; name?: string }[];
  /** run_id / 唯一前缀 / label 解析（宿主形态）。 */
  resolveRun?: (handle: string) => ResolveRunResult;
  /** withDeadline 的时钟（评审 m2：宿主路径也套独立超时上界）；缺省 systemClock，测试注入 FakeClock。 */
  clock?: Clock;
}
```

execute 决策顺序（**先解析、后动手**，与 spawn admission 同一纪律）：

1. `thinking` 防御性校验（不在 `THINKING_LEVELS` → throw，列出合法值）。
2. 目标判定：`run_id` 缺省 / `"self"` / `=== deps.selfRunId` ⇒ **self**；否则 **foreign**。
3. run 形态 + foreign ⇒ throw：`"set_model here can only switch your own model; omit run_id (or pass \"self\")"`。
4. 模型解析：`parseStrictModelRef(model)`（严格对直接用）→ 否则 `deps.resolveHint(model)`；
   解析失败 ⇒ throw `unknown model: "<hint>" — pass a strict provider/id, or a bare id/substring of an available model` + 至多 8 个候选（`deps.available`）。
   注意：严格对也要经 §4.4/宿主 `findModel` 的注册表校验，避免"看起来合法其实不存在"。
5. self：
   - run 形态 ⇒ `deps.runs.setModel(deps.selfRunId!, ref, { thinking })`；
   - 宿主形态 ⇒ `findModel` → 无 ⇒ unknown_model 文案（E3）；`withDeadline(host.setModel(Model),
SET_MODEL_TIMEOUT_MS, clock)`（**评审 m2**：pi 的 `checkAuth` 可能读凭据存储，无证据表明有界，宿主路径
     同样套独立超时上界，保持首部"切换路径有独立超时上界"的论断对两形态都成立）→ timeout ⇒ E9 宿主变体；
     `false` ⇒ throw auth 文案（E4）；rejected ⇒ E11 文案。成功后按 §5 处理 thinking，回读
     `host.getThinkingLevel()`。
6. foreign（仅宿主形态）：`resolveRun(run_id)` → 失败原样 throw（错误里已带候选，`resolve-target.ts` 生成）→
   `deps.runs.setModel(runId, ref, { thinking })`。
7. 结果映射（§6）→ 成功返回：

```ts
{
  content: [{ type: "text", text:
    `Model for ${targetText} set to ${provider}/${id}${thinkingText}. Takes effect on the next model call; the current turn continues unchanged.` }],
  details: { ok: true, target: "self" | runId, model: { provider, id }, thinking },
}
```

`thinkingText` 形如 `(thinking: high)` 或 `(thinking: off — clamped from high)`（请求值 ≠ 生效值时显式标注）。

### 4.10 `src/stack.ts` —— models 端口 + 复用

```ts
export interface StackModelPort {
  resolveHint(hint: string): { provider: string; id: string } | undefined;
  find(provider: string, id: string): unknown | undefined;
  available(): readonly { provider: string; id: string; name?: string }[];
}
```

`buildSessionStack` 里构造一次（把 `:813-817` 的内联闭包提出来），并且：

- `createSpawnService({ resolveModelHint: models.resolveHint, … })`（行为不变，改为复用）；
- `createRuntimeRunnerAdapter({ …, resolveModelHint: models.resolveHint, availableModels: models.available })`
  （评审 m4：run 形态的候选列举与宿主形态 E2 一致）；
- `Stack` 导出 `models`（供 `index.ts` 的宿主形态使用）。

### 4.11 `src/index.ts` —— 宿主形态注册（assembly only，I7）

`pi-compat.ts` 先加结构探测（唯一允许结构探测 pi 的文件）：

```ts
// MinimalPiHost: setModel?: unknown; setThinkingLevel?: unknown; getThinkingLevel?: unknown;
canSetModel: typeof pi.setModel === "function"
  && typeof pi.setThinkingLevel === "function"
  && typeof pi.getThinkingLevel === "function",
```

注册（`createSteerTool` 之后，`:202` 附近）：

```ts
pi.registerTool(
  createSetModelTool({
    ...(caps.canSetModel
      ? {
          host: {
            setModel: (model) => pi.setModel(model as never),
            getThinkingLevel: () => pi.getThinkingLevel(),
            setThinkingLevel: (level) => pi.setThinkingLevel(level as never),
            findModel: (p, id) => holder.current?.models.find(p, id),
          },
        }
      : {}),
    runs: { setModel: (runId, model, opts) => requireStack(holder).query.setModel(runId, model, opts) },
    resolveHint: (hint) => holder.current?.models.resolveHint(hint),
    available: () => holder.current?.models.available() ?? [],
    resolveRun: forwardResolveRun(holder),
  }),
);
```

`caps.canSetModel === false` 时 `host` 缺省 ⇒ self 目标返回明确错误（"this pi build cannot switch the host
session's model; target a running subagent instead"），切 subagent 仍可用（优雅降级，不整体禁用）。

## 5. thinking 语义（需求 3 的落地细节）

pi 的 `setModel` 内部会调 `_getThinkingLevelForModelSwitch`：**per-model 覆盖 → 全局 `defaultThinkingLevel`
→ 当前档位 → DEFAULT**（`agent-session.js:1407-1420`）。因此"什么都不做"并不等于"保持当前档位" ——
只要用户 settings 里配了 `defaultThinkingLevel`，切模型就会把档位重置成它。

规则（两形态一致）：

1. 切换**前**读 `previous = getThinkingLevel()`。
2. `setModel(...)`。
3. `desired = params.thinking ?? previous`；`desired !== undefined` 时调 `setThinkingLevel(desired)`。
4. 回读 `effective = getThinkingLevel()`，写进结果文本/details；`effective !== desired` 时显式标注 clamped。

**评审 m7（在案说明）**：第 2 步 pi 内部重算档位时若档位变化会写一条 `thinking_level_change`
（`agent-session.js:1368-1376`：只在真的变化时写），第 3 步回写若再次改变档位会**再写一条** ——
transcript 可能出现两条相邻的 `thinking_level_change` 条目；最终状态正确（回读值为准），属可接受的冗余，不做去重。

有意的偏离说明：这会**压过** pi 的 per-model thinking 覆盖（`/model` 手动切换时 pi 会尊重它）。理由是
需求 3 明确"不指定则保持当前档位"；该偏离写在工具注释与本节，v2 若要改回 pi 语义只需删掉第 3 步的
`?? previous`。**clamp 一律由 pi core 负责，本仓库不自建**。

## 6. 错误处理矩阵

| #   | 场景                                                           | 检出点                                                                                                  | 面向模型的表现                                                                                                                                                                                         |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | `thinking` 非法档位                                            | 工具 execute 防御性校验（schema 之外再一层）                                                            | throw：`invalid thinking level "x"; use one of off, low, medium, high`                                                                                                                                 |
| E2  | 模型 hint 无法解析                                             | `parseStrictModelRef` + `resolveHint` 均失败                                                            | throw：`unknown model: "…" — pass a strict provider/id, or a bare id/substring of an available model. Available: a/b, c/d, …`（≤8 个）                                                                 |
| E3  | 严格对存在但不在注册表 / 无 auth 配置                          | 宿主：`findModel` 返回 undefined；run：`driver.resolveModelRef` 返回 undefined ⇒ `unknown_model`        | throw：`unknown model: p/id (not available in this installation — check the provider auth)`                                                                                                            |
| E4  | 宿主 self：`pi.setModel` 返回 `false`                          | 返回值判定（pi 内部 `hasConfiguredAuth`）                                                               | throw：`no auth configured for provider "p"; the session model is unchanged (run /login or set the provider key)`                                                                                      |
| E5  | run 目标：`session.setModel` throw（`No API key for p/id`）    | `reason: "rejected"` + detail                                                                           | throw：`run <id> refused the model switch: <detail>`                                                                                                                                                   |
| E6  | 目标 run 不在 running（终态 / 未知 / 已 reap）                 | registry 状态检查 或 `activeHandles` 未命中 ⇒ `not_running`                                             | throw：`run <handle> is not currently running; a terminal run's model can only be chosen when you spawn (Agent(model: …)) or resume it`                                                                |
| E7  | run_id 未知 / 前缀歧义                                         | `resolveRun`（`resolve-target.ts` 已生成带候选的文案）                                                  | throw：原样透传（`run target not found: …. Candidates: [...]` / `ambiguous run target: …`）                                                                                                            |
| E8  | run 形态传别人的 run_id                                        | `selfRunId` 比对（D-2）                                                                                 | throw：`set_model here can only switch your own model; omit run_id or pass "self"`                                                                                                                     |
| E9  | 切换超过 5s 未返回                                             | run：`withDeadline(SET_MODEL_TIMEOUT_MS)` ⇒ `reason: "timeout"`；宿主：工具层 `withDeadline`（评审 m2） | throw：run 侧 `model switch for run <id> timed out after 5s; the session may still be on the previous model`；宿主侧 `model switch timed out after 5s; the session may still be on the previous model` |
| E10 | driver/handle 不支持（老 driver、测试 fake）                   | `reason: "unsupported"`                                                                                 | throw：`this session cannot switch models mid-run`                                                                                                                                                     |
| E11 | 宿主 `pi.setModel` 因 `/reload` 后实例失效而 throw             | try/catch（`compact-tool` 的 `sendUserMessage` 先例）                                                   | throw：`the host session is no longer bound (session was reloaded); retry the switch`                                                                                                                  |
| E12 | 并发：同 turn 内两次 set_model，或与 turn 内 provider 调用竞争 | 无锁；pi 只写 `agent.state.model`                                                                       | 后者胜；两次都回读上报生效值。已在飞的 provider 调用不受影响（需求 2）                                                                                                                                 |
| E13 | 目标 run 在切换过程中settle                                    | `dispatchExternal` 的 gen 校验 + 状态机终态早退                                                         | 切换可能"成功但无效"：结果文本已声明"下次调用生效"，终态 run 不再有下次调用；`diag` 不被污染                                                                                                           |
| E14 | print/json 非交互模式                                          | **不设门**（与 `compact_context` 不同）                                                                 | `pi.setModel` 在 headless 下同样有效、无 UI 依赖、无 fire-and-forget，故不拦                                                                                                                           |

统一约定：**失败一律 throw**（pi 会把 message 全文交给模型，`details` 在错误通道恒空 —— agent-label 方案
§0 已核实），成功走 `content` + `details`。

## 7. fleet widget / `diag.model` 一致性

### 7.1 现状与决策

`diag.model` 只有两个写入点（enqueue 的 `displayMeta`、`session_created` 的一次性回读），运行中切换后
widget/`/agent status`/Agent 卡片会**永久停留在旧模型**。

三条候选路径与取舍：

| 方案          | 做法                                                                                                               | 取舍                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A（**采用**） | 新增 `DriverEvent` 变体 `model_changed`，runner 切换成功后 `dispatchExternal` 一次，reduce 早退 patch `diag.model` | 转移矩阵 13 kinds × 12 phases **不变**（矩阵按 `input.kind` 取 cell，`session_event` cell 的事件由 `buildInput` 固定构造）；活快照与 `outcome.diag`（`finish()` 拷贝 diag）**同时**变新；零 effect、零计时器影响 |
| B（否决）     | 新增 `RunInput.kind: "model_changed"`                                                                              | 需同步改矩阵 12 个 cell + 计数 13→14、156→168，收益与 A 相同                                                                                                                                                     |
| C（否决）     | 读时叠加：`createLiveRunRegistry` 用 `runner.getModelRef(runId)` 覆盖                                              | 活行正确但 `outcome.diag.model` 仍是旧值，终态卡片/通知与运行中显示不一致                                                                                                                                        |

### 7.2 采用方案后的链路

```
setModelForRun 成功
  → handle.getModelRef()（回读真实值，而非请求值）
  → dispatchExternal(runId, gen, session_event:model_changed)
  → reduce 早退分支 patch diag.model（无 effect、无 phase 变更、不动 lastEventType）
  → RunnerDeps.onStateChange → runtime-adapter 组装 RunSnapshot（runtime-adapter.ts:226-236）
  → spawn-service records.set + deps.onSnapshot → createLiveRunRegistry → QueryService
  → fleet widget 行（fleet-panel.ts:340 `formatModelRef(snapshot.diag.model)`）、
    /agent status（commands/status.ts:223,278）、Agent 卡片（agent-tool.ts:63,89）
  → run settle 时 finish() 拷贝 diag ⇒ outcome.diag.model = 新模型（终态卡片/通知一致）
```

宿主自切换**不涉及** fleet widget（widget 只画 subagent 行）；主会话模型由 pi 自己的状态栏显示，
`pi.setModel` 已触发 pi 的 `model_select` 扩展事件与状态栏刷新，本仓库无需额外工作。

## 8. 边界语义

### 8.1 persist 范围（核实结论）

`pi.setModel(model)` → `AgentSession.setModel(model)`（**不传 `options.persist`**）⇒
① `agent.state.model = model`（下次 LLM 调用生效）；② `sessionManager.appendModelChange(provider, id)`
（写 transcript）；③ **不**调 `settingsManager.setDefaultModelAndProvider`（不写全局默认，不动
`enabledModels` 作用域）。`setThinkingLevel` 同理：只在档位真的变化时写 transcript，`persist` 缺省。

### 8.2 self 的两种含义

| 调用者               | `run_id` 缺省时的目标  | 通道                               | 说明                                                                           |
| -------------------- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| 主会话（宿主形态）   | 主会话自身             | `pi.setModel`                      | 用户在 TUI 里看到的模型立即变（下次调用生效）                                  |
| subagent（run 形态） | 该 subagent 自己的 run | `runner.setModelForRun(selfRunId)` | 与"主会话切某个 subagent"**完全同一机制**，只是 runId 由宿主闭包写死，不可伪造 |

### 8.3 终态 run

一律拒绝（E6）。terminal run 的模型只能在 `Agent(model: …)` 或 resume 时决定 —— 错误文本直接指路。

### 8.4 resume 与 agent-type `model:` 的覆盖陷阱（已知边界，V1 不改）

`spawn-service` 的 `admittedModel = req.modelOverride ?? config.model`（`:273`），resume 分支不清空它；
`runtime-adapter` 有 `spec.model` 时会写进 `SessionSpec.model`（`:329-333`），而 `sdk.js:84-95` 只在
`options.model` **缺省**时才从 transcript 恢复。所以：

- agent type **没有** `model:`/`modelHint`，且 resume 未显式传 model ⇒ transcript 里的新模型被沿用（需求 4 达成）。
- agent type **声明了** `model:`（或 hint）⇒ resume 会回落到类型默认，set_model 的切换被丢弃。

V1 记录为已知边界（V8 验证项）；修法（v2）：resume 分支在 `req.modelOverride` 缺省时不套用 `config.model`。

### 8.5 嵌套 / 授权

run 形态 V1 self-only（D-2）。宿主形态可切**任意** tracked running run（含嵌套子 run）——与
`steer_subagent`/`abort_subagent` 的既有权限面完全一致，不新增暴露面。

### 8.6 与其它子系统的交互

- **成本/用量**：`diag.usage` 由 `message_end` 累加，与模型无关；切换后新模型的单价由 pi 侧计算，累计值不回溯（正确行为，记录在案）。
- **watchdog**：`model_changed` 不进 `enter()`，不重置 `phaseEnteredAt`/`lastEventAt`（D-5）。切到更慢的模型可能更容易撞 `modelTurnMs`/`idleMs` —— 属既有预算语义，不改。
- **compact-hint**：上下文窗口随模型变化，`ctx.getContextUsage()` 每次现取，自动跟随，无需改动。
- **RPC / workflow**：本次不暴露（§12）。

## 9. 测试方案（vitest，沿用现有 fake 模式）

### 9.1 新增/改写文件

| 文件                                                      | 模式参照                                                                  | 用例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/tools/set-model-tool.test.ts`（新建）              | `tests/tools/steer-tool.test.ts`（纯依赖 fake）                           | ① 宿主 self 成功（`pi.setModel` 返回 true）→ 文本含解析后的 `provider/id` 与 "next model call"；② `pi.setModel` 返回 false → throw 含 provider 与 "unchanged"（E4）；③ hint 解析：`"sonnet"` → 候选表命中；④ 解析失败 throw 含候选列举（E2）；⑤ `run_id` 走 `runs.setModel` 并透传 `thinking`；⑥ `not_running` → 文本含 "not currently running"（E6）；⑦ `resolveRun` 失败原样透传（E7）；⑧ run 形态 + foreign run_id → 权限 throw（E8）；⑨ run 形态 `run_id` 省略/`"self"`/自身 runId 三写法等价；⑩ 非法 thinking（E1）；⑪ `timeout`/`unsupported`/`rejected` 三种 reason 的文案（E5/E9/E10）；⑫ `host` 缺省（`canSetModel=false`）时 self 的降级错误；⑬ `renderCall` 标题/meta/流式半参数容错；⑭ 宿主形态 thinking 回写链路（评审 m6）：切换前读 previous → setModel → setThinkingLevel(previous) → 回读生效档位并在文本标注 clamped（模拟 pi 把档位改成全局默认的行为）；⑮ 宿主路径超时（m2：fake clock 推进 5s → E9 宿主变体） |
| `tests/runtime/runtime.test.ts`（改写）                   | 已有 `handle()` fake 工厂 + `deps()`                                      | 在 fake handle 上加 `setModel/getThinkingLevel/setThinkingLevel`，driver fake 加 `resolveModelRef`：① 成功 → handle 收到 resolve 后的对象、返回 `ok` 且 `model` 来自 `getModelRef` 回读；② `activeHandles` 无该 run → `not_running`；③ `resolveModelRef` 返回 undefined → `unknown_model`（**不调用** `handle.setModel`）；④ `handle.setModel` reject → `rejected` + detail；⑤ `setModel` 挂住 + `clock.advance(5s)` → `timeout`（零挂死）；⑥ `thinking` 缺省时回写切换前档位（模拟 pi 把档位改成全局默认的行为）；⑦ 指定 `thinking` 时以参数为准；⑧ run settle 后调用 → `not_running`（`activeHandles` 已按 gen 清理）                                                                                                                                                                                                                                                                                                            |
| `tests/service/query-service-set-model.test.ts`（新建）   | `tests/service/query-service-stop.test.ts`（字面量 Runner/Registry fake） | ① running + runner 成功 → 透传；② 非 running/未知 run → `not_running`（**不调** runner）；③ `runner.setModel` 缺省（老 runner）→ `not_running`；④ runner throw → `rejected` + detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/core/presentation-diag.test.ts`（改写）            | 已有 `apply()` 序列                                                       | ① `model_changed` 覆盖 `session_created` 写入的 `diag.model`；② 不改 `lastEventType`、不产生 effect、不改 phase/status；③ 终态后到达的 `model_changed` 不改 `diag`/`outcome`；④ 切换后 settle，`outcome.diag.model` = 新值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/service/runtime-adapter-set-model.test.ts`（新建） | `tests/service/runtime-adapter-fabric.test.ts`（探 `spec.customTools`）   | ① 每个 run 的 `customTools` 都含 `set_model`；② 该实例的 `selfRunId` 就是本 run（用 fake `runs.setModel` 捕获 runId）；③ `grantedReserved` 含 `set_model` ⇒ `buildToolScopePolicy` 不 deny 它，且**未授权**的 run 会 deny；④ **M1**：allow-listed type（type 声明 `tools:` 白名单）时 `sessionSpec.tools` 含 `set_model`（注入不被 pi 注册表过滤丢弃），既有注入（message_agent 等）同理合入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/tools/model-facing-strings.test.ts`（改写）        | 已有 `tools()` 列表                                                       | 把 `createSetModelTool({})` 加入列表（无 `§`/`architecture`；`run_id` 描述含 "label"，与 result/steer/abort 同一断言族）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/core/core.test.ts`                                 | ——                                                                        | **无需改动**（矩阵仍 13×12=156；`buildInput` 不构造 `model_changed`）。在 §9.2 的 CI 前置里显式确认这一点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 9.2 回归确认（不改但必须跑）

`tests/runtime/tool-scope.test.ts`（`RESERVED_TOOL_NAMES` 泛化断言）、`tests/core/core.test.ts`（矩阵计数 +
property 不变量）、`tests/service/spawn-service.test.ts`（`resolveModelHint` 改为复用 `Stack.models` 后行为不变）、
`tests/runtime/session-driver.test.ts`（新增可选方法不破 fake）。

## 10. 真机验证清单（V1–V12，需人工在真 pi 会话里跑）

| #   | 场景                           | 步骤                                                                                                                      | 期望                                                                                                                 |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| V1  | 主会话自切换（下一次调用生效） | 让模型连续两轮报告自己的模型：`set_model(model:"haiku")` 后本轮继续说话 → 下一轮                                          | 本轮不中断、不重开 turn；下一轮起状态栏与回答均为新模型                                                              |
| V2  | fuzzy hint                     | `set_model(model:"sonnet")` / `set_model(model:"kimi")`                                                                   | 结果文本回报解析出的完整 `provider/id`；与 `Agent(model:"sonnet")` 落到同一模型                                      |
| V3  | 未知模型                       | `set_model(model:"gpt-42")`                                                                                               | 一条自纠错误 + 候选列举；模型下一轮改用合法 hint 成功（E2）                                                          |
| V4  | 无 auth 的 provider            | 切到一个未配置 key 的 provider/model                                                                                      | E4 文案；`/model` 显示模型**未变**                                                                                   |
| V5  | thinking 保持                  | 先 `/thinking high`（或 set_model 带 `thinking:"high"`），再 `set_model(model: <另一支持 thinking 的模型>)` 不带 thinking | 切换后档位仍是 high（不被 pi 全局默认覆盖，§5）                                                                      |
| V6  | thinking clamp                 | 切到不支持 thinking 的模型并带 `thinking:"high"`                                                                          | 结果文本标注 clamped（生效 off）；无异常                                                                             |
| V7  | 切运行中的 subagent            | 起一个长 run（分轮执行的多步 bash 任务），`set_model(run_id:<label>, model:"haiku")`                                      | 成功；fleet widget 该行的模型列**当轮内**变新；该 run 后续轮次用新模型；run 不被打断（§7.2）                         |
| V8  | resume 沿用                    | V7 的 run 结束后 `Agent(resume:<label>, …)`；分别测"agent type 无 model:"与"有 model:"                                    | 无 `model:` ⇒ 沿用切换后的模型；有 `model:` ⇒ 回落类型默认（§8.4 已知边界，需与文档一致）                            |
| V9  | 终态 run 拒绝                  | 对已完成 run 调 `set_model`                                                                                               | E6 文案；无副作用                                                                                                    |
| V10 | run_id 形态                    | 依次用完整 run_id / 唯一前缀 / `@label` 的 label 值                                                                       | 三者等价（复用 `resolve-target`）；歧义前缀报 E7                                                                     |
| V11 | subagent 自切换 + 越权         | 在 subagent 任务里让它 `set_model(model:"haiku")`（self），再让它试 `set_model(run_id:"<别的 run>")`                      | self 成功且 widget 行刷新；foreign 被 E8 拒绝；**确认子会话里看不到宿主版**（否则会切主会话模型 —— §4.8 的核心防线） |
| V12 | `/reload` 后可用               | `/reload` 一次，再走 V1/V7                                                                                                | 工具仍在、仍生效（HOST_KEY 释放 + holder 重建）；无重复注册                                                          |

## 11. 实施顺序（建议按提交切分，每步 `npm test` 绿）

1. **core 层**：`DriverEvent.model_changed`、`SetModelOutcome`、`SET_MODEL_TIMEOUT_MS`、reduce 早退分支 +
   `tests/core/presentation-diag.test.ts`。（矩阵计数不变 —— 提交信息里点明）
2. **runtime 层**：`SessionHandle`/`SessionDriver` 可选方法 + `PiSessionHandle`/`PiSessionDriver` 实现 +
   `RuntimeRunner.setModelForRun` + `tests/runtime/runtime.test.ts`。
3. **service 层**：`ports.Runner.setModel?`、`QueryService.setModel`、adapter 透传 +
   `tests/service/query-service-set-model.test.ts`。
4. **工具**：`src/tools/set-model-tool.ts` + `tests/tools/set-model-tool.test.ts` +
   `model-facing-strings` 列表。
5. **接线**：`tool-scope` 保留名、`Stack.models` 端口（spawn-service 改为复用）、runtime-adapter 注入（含 M1 白名单合入 + m4 `available` 透传）+
   `tests/service/runtime-adapter-set-model.test.ts`、`pi-compat.canSetModel`、`index.ts` 注册 +
   `forwardQuery` 一行。
6. **文档**：本方案标注"已实现"、`README`/`README.en` 工具清单补 `set_model`、CHANGELOG（`feat(tools): ...`）。
7. **真机**：跑 §10 的 V1–V12，把结果回填本文件。

`npm run format:check && npm run typecheck && npm test && npm run build` 四道门在推送前全绿。

## 12. 非目标 / 后续

- **RPC / workflow 暴露**：`src/rpc/*` 与 `SubagentWorkflow` 本次不加 `setModel` 动作（保持最小面）。
- **`/agent` 命令**：不加 `set-model` 子命令（用户手上已有 pi 原生 `/model`）。
- **run 形态放宽到 descendant**：需要一条可信的父子关系源（fabric tree 或 `nesting` 表）+ 权限声明
  （类比 `can_message`），留 v2。
- **`persist: true`（写全局默认）**：需求未要求，且会污染用户 pi 配置；如要做，应作为显式 `persist` 参数。
- **agent type `model:` 覆盖 resume 的修复**：§8.4，独立小改动，单独评审。
- **thinking 全档位（minimal/xhigh/max）**：本仓库面向模型的表面刻意收窄为 4 档；如放宽应与 `Agent`
  工具的 `thinking` 参数同步改，避免两套表面。
