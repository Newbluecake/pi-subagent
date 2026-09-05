# agent-label 实施方案（label 与 description 融合：自动派生 + 冲突自动加序号）· v4

> v4（主会话按三审意见直修）：① §0 throw 证据措辞修正（bundled 内联 catch，无 createErrorToolResult 符号）；② §5.6 新增——失败路径 diag.label 贯穿（start() catch / failedConfigOutcome 写入生效 label）；③ §5.3 worker 侧 settle 信封链路补全（envelope ok 变体加 runId?/label?、waitForSettle/bufferedSettles/pending.resolve 透传、agent() 从 envelope 读取、五情形测试）；④ §3.6 新增测试缝（可注入 labelIndex），§8.2 MAX 耗尽改走测试缝（agent + agent-2…agent-999 共 999 key）；⑤ §8.6 五情形、§8.8 三断言补齐；⑥ §11 步骤 2 补测试缝/失败路径/test double 同步。

> 需求（用户已拍板）：**每个 subagent run 必须带 label 且可 @**。label 与 description 融合为一个概念；
> 无 label 时自动派生；冲突时不拒绝、自动追加序号（sleep3 → sleep3-2）；调用方必须能拿到**生效 label**
> （派生/加序号后的真实值）以便正确 @。
>
> **v3 = 第三轮复审（gpt-sol）打回后的修订**，逐条处置：P0（failure 路径契约——经核实 pi 工具 throw 的错误
> 通道后定为"保持 throw、marker 并入错误文本"）、P1a（workflow M10 事件链逐处贯穿生效 label）、
> P1b（replay hit 产品决策写成规范语句）、P1c（MAX 耗尽测试拆纯函数层/service 层）、P2a（RPC 弱契约措辞）、
> P2b（structured 契约写死 + contract test）、测试修正 6 条。v2 决策未点名者全部维持。
> 所有引用以函数/符号名为主、行号为辅（§0）。

## 0. 源码接缝核实表（v3 复核）

| 断言                                                                                                                                                                                                                                                                    | 位置（符号 · 行号辅助）                                                                                                                                                                                                                     | 结论                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Agent 工具 `label = params.description`，description 必填                                                                                                                                                                                                               | `createAgentTool` 内 `baseRequest.label` · `src/tools/agent-tool.ts:247`；`AgentToolParams`                                                                                                                                                 | Agent 路径必有 base label，但未净化（含空格 description 今天无法 @）                                                             |
| @ 解析正则要求 label 为任意非空白串                                                                                                                                                                                                                                     | `parseMention` · `src/mention/mention.ts:19`                                                                                                                                                                                                | 净化修掉此隐性 bug                                                                                                               |
| **工具 throw 的错误通道**：`createAgentTool` 非 completed 分支 `throw new Error(parts.join(" "))`；pi 侧 catch 后产出 `{ content: [{type:"text", text: message}], details: {} }` + `isError: true`                                                                      | throw 点 · `agent-tool.ts:349-360`；pi bundled agent-core `chunk-OMWWHBTG.js:1078` 附近的**内联 catch**（无独立 createErrorToolResult 符号）：catch 后将 `error instanceof Error ? error.message : String(error)` 放入 content 并置 isError | **P0 定论：throw 的 message 全文模型可见，details 恒为空对象**——失败路径没有 details 通道，marker 只能并进错误文本（§5.1 方案②） |
| **正常 ToolResult 的 `details` 不进 LLM 上下文**：`convertMessages` 只序列化 `content` text/image block                                                                                                                                                                 | `@earendil-works/pi-ai/dist/api/openai-completions.js` `convertMessages` toolResult 分支（`:1060-1085`）；`anthropic-messages.js` `convertToolResult`（仅用 `msg.content`）                                                                 | 成功路径的生效 label 也必须进 content（marker block），details 只做 UI/回放冗余                                                  |
| spawn() label 注册四分支现状：isRunId 只告警不注册（run 正常跑但不可 @）；resume 仅 `prior.runId === 目标` 时 re-point，否则 warn 保留旧映射                                                                                                                            | `createSpawnService.spawn` · `src/service/spawn-service.ts:359-379`                                                                                                                                                                         | isRunId 改"换兜底 base"（§3.3）；resume 改四情形表（§6.1）                                                                       |
| spawn() 入场副作用顺序：只读检查 → `newRunId`（未 claim）→ **`resumeLocks.add`（首个可变写）** → `labels.set` → `nesting`/`claimedRunIds`/`parentOf`/`childrenOf`/`onSpawnEdge` → `void start()`                                                                        | `createSpawnService.spawn`；CC4 注释                                                                                                                                                                                                        | label 规划段必须在 resumeLocks 之前，MAX 耗尽零副作用（§3.5）                                                                    |
| onLabel 回调：`resumed ? reassign : register` 喂 mention registry                                                                                                                                                                                                       | `buildSessionStack` spawn deps · `src/stack.ts:671-672`                                                                                                                                                                                     | 管线不动；register 冲突分支成不可达（语义保留）                                                                                  |
| mention registry first-registration-wins                                                                                                                                                                                                                                | `createMentionRegistry` · `src/mention/registry.ts`                                                                                                                                                                                         | 不动（范围外 §9）                                                                                                                |
| workflow `agent()` opts 无 description 字段；label 缺省时 spawn 不带 label                                                                                                                                                                                              | `attachHostCallHandler.handleAgent` · `src/workflow/host.ts`；sandbox `agent()` · `src/workflow/worker-source.ts:157`                                                                                                                       | base 缺省由 spawn-service 从 prompt 派生                                                                                         |
| **workflow M10 事件链五处用值不一致**：提交存原始 label（`labelOf.set(callId, label)`）；`spawned` 事件用原始 label；`recordSettled` 以 labelOf enrichment 进 summary；`settled` 事件用局部 label 而非 `enriched.label`；replay hit 分支也 `labelOf.set(callId, label)` | `handleAgent` 提交段（`host.ts:595`）、`spawned` 事件（`:643-651`）、live-settle 回调的 `recordSettled`（`:676-684`）、`recordSettled` 本体（`:319-342`）                                                                                   | **P1a：逐处改动清单见 §5.3**                                                                                                     |
| workflow 脚本对 `agent()` 返回值做字符串运算，失败 resolve `null`                                                                                                                                                                                                       | `tests/workflow/journal-replay-e2e.test.ts:131,206`；`worker-source.ts` `agent()` settle 分支                                                                                                                                               | 返回类型不能改——`opts.fullResult` opt-in（§5.3）                                                                                 |
| `ChildSpawnResult` 仅 `{runId}`；`HostSettleEnvelope` ok 变体仅 `value/outputTokens`；spawner-adapter 只透传 `{runId}`                                                                                                                                                  | `host.ts:36`；`src/workflow/types.ts:466-474`；`spawner-adapter.ts:63`                                                                                                                                                                      | 三处加可选字段（§5.3）                                                                                                           |
| **`NestedSpawnPort.spawn` 返回 `{runId} \| {error}`**——Agent 工具（含嵌套）只持有此窄口                                                                                                                                                                                 | `NestedSpawnPort` · `agent-tool.ts:15-21`                                                                                                                                                                                                   | 签名扩为 `{runId, label?} \| {error}`，fake port 兼容策略见 §11 步骤 3                                                           |
| UI label 来自 `diag.label` ← `displayMeta.label = spec.request.label`                                                                                                                                                                                                   | runtime-adapter 组装 displayMeta · `src/service/runtime-adapter.ts:444-448`；fleet-widget/panel                                                                                                                                             | 所有分支写回 `resolvedReq.label`（§5.2 矩阵）                                                                                    |
| RPC `spawn` 把 `deps.spawn.spawn(request)` 的 result 原样透传；reply `result: Type.Unknown()`                                                                                                                                                                           | `createRPCServer` · `src/rpc/server.ts:105-112`；`src/rpc/protocol.ts`                                                                                                                                                                      | 弱契约：文档注释 + 透传测试，**不引入 result schema**（§5.4）                                                                    |
| worktree 资源名 `request.runId ?? request.label`，runId 恒已设置                                                                                                                                                                                                        | `src/extensions/worktree.ts:124`                                                                                                                                                                                                            | label 改写不影响                                                                                                                 |
| 现有 label 测试：first-wins 冲突 warn、resume re-point                                                                                                                                                                                                                  | `tests/service/spawn-service.test.ts`；`tests/mention/mention.test.ts:151`                                                                                                                                                                  | §8 改写/新增                                                                                                                     |

## 1. 总体形状

```
                ┌────────────── 纯函数层（新增 src/core/labels.ts）──────────────┐
                │  sanitizeLabelBase(raw) → string | undefined                   │
                │  deriveUniqueLabel(base, isTaken) → string | undefined         │
                └──────────────────────▲──────────────────▲─────────────────────┘
                                       │                  │
   Agent 工具 ─ label=description ──┐                    │（base 缺省时由
   嵌套 Agent 工具 ─ 同上 ──────────┼──▶ spawn-service    │  spawn-service 从
   workflow host ─ label?/无 ──────┤    spawn() 规划段     │  prompt 首行派生，
   RPC ─ label? ───────────────────┘    （只读，在任何可变  │  再不行兜底 agent）
                                        写之前完成）：
                                        1) base = sanitize(req.label)
                                           ?? sanitize(prompt 首行) ?? "agent"
                                        2) isRunId(base) → base = "agent"（warn，仍注册）
                                        3) resume? → 四情形表（§6.1）
                                           否则   → effective = deriveUniqueLabel(base, labels.has)
                                        4) MAX 耗尽 → { error }，零副作用返回
                                        ── 以下才发生可变写 ──
                                        5) resumeLocks（resume 时）→ labels.set + onLabel
                                        6) resolvedReq = { …req, label: effective }（所有分支）
                                                       │
              ┌────────────────────────────────────────┼─────────────────────────┐
              ▼                                        ▼                         ▼
   mention registry（register/reassign，    diag.label = 生效 label      spawn() 返回 { runId, label }
   stack.ts 现有管线不变）                   （UI/通知/候选列表自动同步）   → Agent content marker / throw 文本
                                                                           / workflow 事件+envelope / RPC reply
```

## 2. 纯函数模块：`src/core/labels.ts`（新建）

```ts
/** 最终 label 的最大长度（码点），含序号后缀。与 resolve-target.ts oneLine 的 40 截断对齐。 */
export const MAX_LABEL_LENGTH = 40;
/** base 截断长度：MAX_LABEL_LENGTH 减序号后缀最大长度 "-999"（4 字符），加序号后不超上限。 */
export const MAX_LABEL_BASE_LENGTH = 36;
/** 冲突序号上限（防御性）。 */
export const MAX_LABEL_ATTEMPTS = 999;

/**
 * 净化任意人类输入为可 @ 的 label base：
 *  - 控制字符（\u0000-\u001f / \u007f）与一切空白序列（\s+）→ 单个 "-"
 *  - 去首尾 "-"；折叠连续 "-"
 *  - 按码点（[...str] 迭代，surrogate pair 不劈裂）截断到 MAX_LABEL_BASE_LENGTH
 *  - 结果为空字符串 → undefined（仅全空白/全控制字符输入触发；"***" 等纯符号**原样保留**）
 * 中文等非空白字符原样保留（mention 正则 [^\s]+ 可解析）。
 */
export function sanitizeLabelBase(raw: string): string | undefined;

/**
 * 唯一化。base 必非空。规则（定死）：base 空闲 → 直取；否则线性扫描 `base-2`、`base-3`…
 * 取第一个空闲值，跳过已被占用的中间序号；上界 MAX_LABEL_ATTEMPTS，耗尽返回 undefined。
 * 序号永远挂在**本次请求的 base** 上；service 从不以已生效 label 作为新请求的 base，
 * 同一 base 重复 spawn 产出线性序列 `x, x-2, x-3, …`，**不产生 `x-2-2`**。
 * （调用方显式传 base="x-2" 且冲突时产出 "x-2-2"，是对独立 base 的正常序号，不在禁止之列。）
 * isRunId 判定是调用方职责且先于本函数（§3.3）。
 */
export function deriveUniqueLabel(base: string, isTaken: (label: string) => boolean): string | undefined;
```

## 3. 生效层：spawn-service 统一做，规划/写入两段分离

### 3.1 为什么不在各入口做

① 唯一性判定需要 `labels` Map 全局视图，`spawn()` 入场段是同步原子区，查重+注册无竞态；
② 五路入口（Agent/嵌套/workflow/RPC/routeMention-resume）各自做必然漂移；
③ 只有 spawn-service 改写 `resolvedReq.label` 才能让 `diag.label` → UI/通知/候选列表零成本同步。

### 3.2 spawn() 的 label 规划段（替代 `spawn-service.ts:359-379` 四分支）

depth 检查之后、**任何可变写之前**（含 resumeLocks）插入只读规划：

```ts
type LabelPlan =
  | { action: "register"; effective: string; resumed: false }
  | { action: "repoint"; effective: string } // resume 情形②：onLabel(resumed:true)
  | { action: "error"; error: ErrorInfo }; // MAX 耗尽

function planLabel(req): LabelPlan {
  const sanitized = req.label !== undefined ? sanitizeLabelBase(req.label) : undefined;
  let base = sanitized ?? sanitizeLabelBase(firstLineOf(req.prompt)) ?? "agent";
  if (isRunId(base)) {
    console.warn(`[pi-subagent] label "${base}" looks like a run id; using a fallback label instead`);
    base = "agent";
  }
  if (req.resumeFrom) {
    /* §6.1 四情形表 */
  }
  const effective = deriveUniqueLabel(base, (l) => labels.has(l));
  if (effective === undefined)
    return {
      action: "error",
      error: {
        kind: "config",
        retryable: false,
        message: `cannot derive a unique label from "${base}": all ${MAX_LABEL_ATTEMPTS} numbered variants are taken — pass a different label/description`,
      },
    };
  return { action: "register", effective, resumed: false };
}
```

`firstLineOf(prompt)` = prompt 首个非空行原文，**无独立预截断**——统一交给 `sanitizeLabelBase`
一次截到 36（全代码库只有这一个长度规则）。规划成功后按现有顺序执行可变写，所有注册/re-point
分支统一 `resolvedReq = { ...resolvedReq, label: effective }`。

### 3.3 isRunId：换兜底 base，不拒绝（Blocker 决策，维持 v2）

判定位置：sanitize 后、uniquify 前（防 `r_ABC12345-2` 绕过 `RUN_ID_RE`）。命中时 `base = "agent"` +
console.warn，正常注册。**任何 run 不允许"正常运行但没有可 @ 的 label"**。uniquify 输出不可能匹配
`RUN_ID_RE`，规划段之后无需二次判定。

### 3.4 mention registry 不动

onLabel 管线原样；`register` 冲突分支成不可达（语义保留，其单测继续成立）；resume re-point 走 `reassign`。

### 3.5 MAX 耗尽：错误形态与零副作用（Major 6 决策，维持 v2）

`{ error: { kind: "config", retryable: false, message: 自愈文案 } }`。规划段在 `newRunId` 之后、
`resumeLocks.add` 之前；耗尽返回时 runId 未 claim、resumeLocks/labels/nesting/parentOf/childrenOf
无写入、onSpawnEdge/onLabel 未触发、runner 未启动——对照 §0 副作用顺序逐条"未发生"。
规划与应用之间无 `await`，应用是原子的。

### 3.6 测试缝：可注入 label 索引（三审 P1-3 决策）

service 层 MAX 耗尽测试不能用 999 次真实 `spawn()` 预填充（会产生真实 run/runner/records 副作用，
既慢又污染零副作用断言）。定死：`createSpawnService` deps 新增**可选** `labelIndex?: Map<string, SpawnLabelTarget>`
——缺省内部自建（生产零变化）；测试注入预填充 Map（`agent` + `agent-2`…`agent-999` 共 999 个 key，
使线性扫描在 MAX 处耗尽）。零副作用断言直接对注入的 Map 做（size 不变、无新 key）。这是唯一新增的
测试专用接缝，不得用于生产路径。

## 4. 各入口语义

- **Agent 工具（含嵌套）**：`label: params.description` 不改；变化只在回传（§5.1）与工具文案
  （"生效 label 以工具结果为准"）。
- **SubagentWorkflow `agent()`**：opts 不新增 description 字段；host.ts 对 spawn 请求侧零改动
  （`opts.label` 传了当 base，不传由 spawn-service 从 prompt 首行派生）；workflow 侧只改回传链（§5.3）。
- **嵌套 Agent 工具 / RPC**：自动生效；RPC 回传见 §5.4。

## 5. 回传可感知

### 5.1 Agent 工具五路径（P0 定论：成功走 content marker，失败走 throw 文本——两通道契约不同）

§0 双重证据：① 正常 ToolResult 的 `details` 不进 LLM 上下文（pi-ai `convertMessages`/`convertToolResult`
只序列化 content）；② throw 的错误被 pi 包成 `{content:[{text: message}], details:{}}` + `isError:true`——
**失败路径根本没有 details 通道，message 全文模型可见**。据此五条路径定死：

| 路径                    | 通道                                         | 形态                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| foreground completed    | content 末尾**追加独立 text block**          | marker 一行：`[subagent label: "<effective>" · run_id: <runId> · status: completed] — 用户可 @<effective> 直接向它发消息`；生效值取 `outcome.diag.label`                                  |
| auto-background         | 现有说明文本 + 同格式 marker block           | 文本中的 `params.description` 改生效 label                                                                                                                                                |
| background              | 启动文本 + marker block                      | 生效值取 `spawn()` 返回的 `label`                                                                                                                                                         |
| **failure**             | **保持 throw，marker 并入错误文本**（方案②） | `parts` 首行改为 `Subagent "<effective>" (run_id: …, label: "<effective>") did not complete successfully: …`；**details 在失败路径放弃**（pi 会覆盖为空对象），错误文本是唯一模型可见通道 |
| resume（经 Agent 工具） | 同 foreground/background 返回点              | 自动携带 re-point 后生效 label，无单独分支；测试单列                                                                                                                                      |

**structured 契约（P2b 写死）**：`structuredResult` 路径的机器可解析值**恒在 `content[0]`**（纯 JSON），
marker 等后续 block 均为非结构化展示文本；**禁止拼接整个 content 数组 parse JSON**。因此 foreground
completed 的 marker 一律作为独立末尾 block 追加、绝不拼进 content[0]。配套 contract test（§8.4）。

`AgentToolDetails` 仍加 `label?: string`（成功三路径填充，UI/历史回放冗余通道），但不是模型可见通道。

> 现状 bug 提示：auto-background 文本当前用 `params.description`（agent-tool.ts:326 附近），必须改为 `spawn()` 返回的生效 label——派生/加序号后两者可能不同。

### 5.2 六量赋值矩阵（维持 v2，全分支定死）

不变式：**`resolvedReq.label` === `effective` === onLabel 第一参 === spawn 返回的 label**，
凡发生注册/re-point 的分支全部成立。

| 分支                         | req.label      | base                       | effective           | resolvedReq.label | onLabel                                       | spawn 返回                   |
| ---------------------------- | -------------- | -------------------------- | ------------------- | ----------------- | --------------------------------------------- | ---------------------------- |
| 新 spawn，有 label 无冲突    | `"sleep 3"`    | `sleep-3`                  | `sleep-3`           | `sleep-3`         | `(sleep-3, t, {resumed:false})`               | `{runId, label:"sleep-3"}`   |
| 新 spawn，有 label 冲突      | `"builder"`    | `builder`                  | `builder-2`         | `builder-2`       | `(builder-2, …, {resumed:false})`             | `{runId, label:"builder-2"}` |
| 新 spawn，无 label           | `undefined`    | prompt 首行派生 ?? `agent` | 唯一化结果          | effective         | `(effective, …, {resumed:false})`             | `{runId, label:effective}`   |
| 新 spawn，base 为 runId 形态 | `"r_ABCDEFGH"` | → `agent`（warn）          | `agent` / `agent-N` | effective         | `(effective, …, {resumed:false})`             | `{runId, label:effective}`   |
| resume ① 无占用              | `"builder"`    | `builder`                  | `builder`           | `builder`         | `(builder, …, {resumed:false})`               | `{runId, label:"builder"}`   |
| resume ② 指向 resume 目标    | `"builder"`    | `builder`                  | `builder`           | `builder`         | `(builder, …, {resumed:true})`                | `{runId, label:"builder"}`   |
| resume ③ 指向其他 run        | `"builder"`    | `builder`                  | `builder-2`         | `builder-2`       | `(builder-2, …, {resumed:false})`；旧映射不动 | `{runId, label:"builder-2"}` |
| resume ④ 无 label            | `undefined`    | prompt 派生 ?? `agent`     | 唯一化结果          | effective         | `(effective, …, {resumed:false})`             | `{runId, label:effective}`   |
| MAX 耗尽                     | 任意           | 任意                       | —                   | —                 | 不调用                                        | `{error}`，零副作用          |

`req.label` 原始值仅保留在 Agent 卡片 `renderCall` 标题（展示用描述），不进 registry。

### 5.3 workflow 回传链（P1a 逐处改动清单 + P1b replay 规范语句）

**`src/workflow/host.ts` 五处**：

1. `ChildSpawnResult`（`:36`）加可选 `label?: string`；`createWorkflowChildSpawner.spawn`
   （spawner-adapter）透传 `result.label`。结构类型加可选字段不破坏 WI2 隔离。
2. **spawn 成功后**（`bind` 之后、`spawned` 事件之前）：`const effectiveLabel = spawned.label ?? label;
if (effectiveLabel !== undefined) labelOf.set(callId, effectiveLabel);`——**覆盖**提交段写入的原始值，
   `labelOf` 自此只存生效值。
3. `spawned` 事件（`:643-651`）：`label` 字段改 `effectiveLabel`（即 `spawned.label ?? label`），不再用
   原始 `label`。
4. `recordSettled`（`:319-342`）的 `settled` 事件：`label` 字段统一取 **`enriched.label`**（不再用局部
   `label`），与进 `children[]` 的 summary 同源；`WorkflowChildSummary.label`、activity registry
   （`WorkflowChildActivity`/`WorkflowSettledChild`）、workflow 工具卡四者自动同值（下游零改动）。
5. live-settle 推送（`:676-684` 起的 `host_settle` ok 消息）：加 `runId: outcome.runId` 与
   `label: effectiveLabel`（`HostSettleEnvelope` ok 变体在 `src/workflow/types.ts:466-474` 加可选
   `runId?: string; label?: string`）。withheld/force-settled 走 ok:false 变体，不涉及。

**replay hit 规范语句（P1b 写死）**：replay hit 不创建 subagent run、不进 SpawnService、不进 mention
registry，因此**不承诺 runId，也不承诺可 @ 的 label**：`host_settle` 的 `runId`/`label` 字段在 replay
路径**缺省**（同 `outputTokens` "没有就不编"语义），`fullResult` 中二者为 `null` 是正常语义而非缺失。
replay 的 `settled` summary/事件仍可携带脚本**请求**的 label（`labelOf` 在 replay 分支的现有写入保留），
仅作展示回声，不代表可 @。

**worker 侧 settle 字段链路（三审 P1 补全）**：`fullResult` 的数据源是 **settle envelope**，不是
`ChildOutcome`（host.ts:45 的 ChildOutcome 不动）。逐点定死：

1. `HostSettleEnvelope` ok 变体（types.ts:466-474）加可选 `runId?: string; label?: string`；
2. worker-source 的 settle 接收/缓存链同步携带两字段：`waitForSettle()`（:110 附近）、
   `bufferedSettles` 的暂存对象、`pending.resolve(...)`（:522 附近）的 payload 类型全部加
   `runId?/label?` 透传，缺省即 undefined；
3. sandbox `agent()`：`opts.fullResult` opt-in——缺省/`false` 时 `return outcome.value`（存量脚本零影响，
   兼容证据 §0）；`true` 时从 **settle envelope 字段**读取：
   `return { text: value ?? null, runId: env.runId ?? null, label: env.label ?? null }`；失败仍 resolve `null`；
4. replay 路径发送缺省字段，worker 映射为 `null`（与 P1b 规范语句一致）；
5. `parallel`/`pipeline` 只是包 thunk，自动兼容。脚本 API 注释与 `SubagentWorkflow` 工具描述补
   `fullResult` 说明。

测试按五情形分字段断言（§8.6）：live completed（两字段有值）/ replay（null）/ failure（null）/
withheld / force-settle（ok:false 变体不携带，worker 映射 null）。

### 5.4 RPC 弱契约（P2a 措辞定死）

本期**不引入 result schema**——`SpawnParamsSchema`/`RPCReplySchema` 保持 `result: Type.Unknown()` 透传。
`{ runId: string, label?: string }` 是**文档契约 + 透传测试**：在 `src/rpc/protocol.ts` 的
`SpawnParamsSchema` 旁补注释写明 spawn result 形态，`AGENTS.md` RPC 行同步一句，`tests/rpc/rpc.test.ts`
新增透传断言（§8.9）。`createRPCServer` 传输层零改动。

### 5.5 UI / 通知同步

§5.2 不变式保证 diag.label 恒为生效值：fleet widget/panel、完成通知、resolve-target 候选列表零改动。
@ 自动补全过滤 `/^[^\s]+$/`，派生 label 天然可补全。

### 5.6 失败路径的 diag.label 贯穿（三审 P1-1 补漏）

§5.2 的不变式在**失败路径**当前不成立：spawn-service `start()` 的 runner 异常 catch（:197 附近）
构造 failed outcome 时诊断对象无 label；runtime-adapter `failedConfigOutcome()`（:127 附近）只收
`runId/error/now`；`displayMeta.label` 仅在正常 runner 初始化路径（:444 附近）写入。结果是
`getLabel(effective)` 能命中，但终态 `diag.label`、失败通知、failure marker 可能拿不到 label。

**决策：所有失败 outcome 构造点写入生效 label**——start() catch 用 `resolvedReq.label`（此时已回写
生效值）；`failedConfigOutcome` 加 label 参数、调用方传 `spec.request.label`。不变式扩展为：
`resolvedReq.label === effective === diag.label（含失败路径）=== spawn 返回值 === onLabel 第一参`。
配套断言见 §8.8（终态 diag.label / notification.label / failure marker 三者含生效值）。

## 6. resume / reassign 语义兼容（状态表维持 v2 定稿）

### 6.1 resume 四情形

| 情形               | 条件                                                      | 动作                               | onLabel           |
| ------------------ | --------------------------------------------------------- | ---------------------------------- | ----------------- |
| ① 无占用           | `!prior`                                                  | 注册 `base → 新 run`               | `{resumed:false}` |
| ② 指向 resume 目标 | `prior && target.ok && prior.runId === target.runId`      | re-point（现状硬保持）             | `{resumed:true}`  |
| ③ 指向其他 run     | `prior && (!target.ok \|\| prior.runId !== target.runId)` | 唯一化注册 `builder-2`；旧映射不动 | `{resumed:false}` |
| ④ 无 label         | `req.label` 缺省或净化为空                                | prompt 派生 + 唯一化               | `{resumed:false}` |

### 6.2 @ 路由推演（维持 v2）

routeMention 主链路命中情形②逐字节保持；情形③ @builder 仍命中 A（A 终态则触发 A 自己的情形②
re-point），模型从工具结果拿到 builder-2 引导用户；情形④ 关闭"resume 无 label 不注册"漏洞；
respawn 后 @ 旧 label 经情形②复活 re-point，label 永不悬空。

### 6.3 回归约束

`spawn-service.test.ts` 的 re-point 用例与 `mention.test.ts` resume 路由用例保持绿色；旧"resume 冲突
warn 保留旧映射"断言块改写为情形③新语义。

## 7. 配置决策：不加开关，直接改默认行为

全是增量行为；isRunId 换 base 只让本来不可 @ 的 run 变得可 @；插件先例（X3/X6/M-B）均直接改默认。

## 8. 测试计划（v3 修订后）

| #    | 位置                                                                     | 用例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1  | `tests/core/labels.test.ts`（新建）                                      | sanitize：空白→单 `-`、控制字符、首尾 `-` 剥离、连续 `-` 折叠、中文保留、36 码点截断（emoji surrogate pair 不劈裂）、全空白→undefined、`"***"` 原样保留。**prompt 派生边界**（经 `firstLineOf`+sanitize 组合测）：多空行跳过取首个非空行、首行全控制字符跳过、仅符号行原样采用、emoji 长行截断、无有效行→调用方兜底 `agent`。deriveUniqueLabel：空闲直取、线性扫描跳过已占用 `x-2` 取 `x-3`、同 base 线性序列**断言不出现 `x-2-2`**、显式 base `"x-2"` 冲突产出 `x-2-2`（独立 base 正常序号）、**`deriveUniqueLabel("x", () => true)` → undefined（纯函数层 MAX 耗尽）**。**长度边界**：36 码点 base + `-999` = 40 正好不超上限 |
| 8.2  | `tests/service/spawn-service.test.ts`                                    | 冲突派生（`builder`/`builder-2`/`builder-3` 各指其 run + onLabel 断言）；无 label prompt 派生；含空格净化注册；**isRunId base → 换 `agent` 兜底注册成功可 @**；**service 层 MAX 耗尽（三审 P1-3 修正）：经 §3.6 测试缝注入预填充 Map（`agent` + `agent-2`…`agent-999` 共 999 key）→ spawn 无 label 请求 → `{error.kind:"config"}`；零副作用断言 = 注入 Map size 不变 + records/running/resumeLocks 无写入 + onLabel 未触发**；resume ①②④；情形③（builder 属 A、resume B → builder-2、`getLabel("builder")` 仍为 A，改写旧 warn 断言）；六量矩阵抽查（spawn 返回 === onLabel 第一参 === runner 收到的 `spec.request.label`）     |
| 8.3  | `tests/mention/mention.test.ts`                                          | 带序号 label 的 steer/resume 路由；parseMention 命中净化 label；情形③旧 label 仍路由到 A；first-wins 单测不动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8.4  | `tests/tools/agent-tool.test.ts`                                         | **五路径断言口径随 P0 定死**：① foreground completed——content **末尾 block** 含 marker、`details.label` 填充；**structured contract test（P2b）：schema 路径 `JSON.parse(content[0])` 成功且 content.length === 2、marker 在 content[1]，并断言"拼接全 content 再 parse"不属于契约（用注释+负例说明，不做拼接断言）**；② auto-background 文本与 marker；③ background（fake spawn 返回 label）；④ **failure——断言 `execute` rejects（throw），rejection message 含生效 label 与 run_id；不断言 details**（pi 会覆盖为空）；⑤ resume（foreground + resume 参数）marker 携带 re-point 后生效值                                     |
| 8.5  | `tests/workflow/host.test.ts`                                            | **四分立断言（fake spawner 返回 `{runId, label:"derived-1"}`）**：a) `spawned` 事件 label === `"derived-1"`（非原始 opts.label）；b) `settled` 事件 label === `"derived-1"`（经 enriched.label）；c) `children[]` summary label === `"derived-1"`；d) **replay hit**——settle envelope **无** runId/label、summary 携带请求 label（展示回声）。另有：无 opts.label 时 spawn 请求无 label（派生下放）；`host_settle` ok 消息带 runId/label                                                                                                                                                                                        |
| 8.6  | `tests/workflow/` worker-source 层                                       | `agent()` 默认返回 string（兼容回归）；`opts.fullResult:true` 从 **settle envelope** 读字段返回 `{text, runId, label}`；**五情形字段断言（三审 P1-2）**：live completed（runId/label 有值）/ replay（null，envelope 缺省）/ failure（null）/ withheld / force-settle（ok:false 变体不携带 → worker 映射 null）                                                                                                                                                                                                                                                                                                                  |
| 8.7  | `tests/service/resolve-target.test.ts`（必做）                           | 派生 label 进候选列表且 `resolveRun` 命中；序号 label 精确命中不被前缀干扰；re-point 后指向新 run；新旧并存（x→旧死 run、x-2→新活 run）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8.8  | `tests/service/spawn-service.test.ts` 或 `h2-failure-visibility.test.ts` | admission/start 交界，**拆两组（终审条件）**：① `start()` runner 抛错/秒退/超时——终态 snapshot 落 records、`notifyTerminalFailure` 触发、`getLabel(effective)` 解析到死 run；② runtime-adapter H2/config failure（`failedConfigOutcome`，不经过 notifyTerminalFailure）——`snapshot.diag.label`、`outcome.diag.label`、notifier payload label 均为生效值。两组各自断言**五者一致**：`snapshot.diag.label` / `snapshot.outcome.diag.label` / `service.getLabel(effective)` / `notification.label` / Agent failure rejection message                                                                                               |
| 8.9  | `tests/rpc/rpc.test.ts`                                                  | fake spawn 返回 `{runId, label:"x-2"}` → reply `result.label === "x-2"` 透传（弱契约，不测 schema）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8.10 | `tests/workflow/` e2e 或 `tests/integration/`                            | 真 SpawnService + workflow：无 label `agent()` 子节点经 `resolveRun(生效label)` 命中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 9. 范围外

不改 mention registry first-wins 内部语义；不动 fabric 消息层；不做跨 session label 持久化；
workflow 运行体（WorkflowId）仍不可 @；不加配置开关；RPC 不引入 result schema（§5.4）。

## 10. 风险与开放问题

1. 情形③唯一化而非 re-point 的取舍（维持 v2 结论：re-point 会劫持活 run 的 @ 路由，唯一化 + 结果回传
   可自愈）。
2. 卡片 `renderCall` 标题（原始 description）与功能面生效值的显示差异——可接受，§5.2 保证功能面同源。
3. prompt 派生 base 遇到客套话首行时不可读；兜底 `agent-N` 永远可用，更聪明的截取不在本期。
4. **failure 与成功路径的 marker 通道不一致**（throw 文本 vs content block）是 pi 框架的客观约束
   （§0 证据），已在 §5.1 写成显式契约；若未来 pi 支持 throw 携带 details，可再统一。
5. structured 双 block 方案假定调用方只 parse content[0]；§8.4 的 contract test 将此固化为回归防线。
6. tombstone/历史候选的意外收益：生效 label 唯一，候选列表不再歧义。

## 11. 实施步骤（按依赖序）

1. `src/core/labels.ts`：常量 + `sanitizeLabelBase` + `deriveUniqueLabel`（含 `firstLineOf` 辅助，可同文件
   或 spawn-service 内部——若只此一处用，放 spawn-service 模块内私有）+ `tests/core/labels.test.ts`（§8.1）。
2. `src/service/spawn-service.ts`：`planLabel` 规划段（只读、resumeLocks 之前）+ 应用段（四情形 +
   `resolvedReq.label` 写回）+ `SpawnService.spawn` 返回 `{runId, label?}` + **§3.6 测试缝**（deps 可选
   `labelIndex`）+ **失败路径 diag.label**（start() catch 写 `resolvedReq.label`）+
   runtime-adapter `failedConfigOutcome` 加 label 参数（§5.6）+
   `tests/service/spawn-service.test.ts`（§8.2/§8.8）。**所有 test double 同步签名**：workflow fake
   spawner、RPC fake、`tests/tools/` 各 fake port（label 可选不破坏旧桩，§8 各节）。

3. `src/tools/agent-tool.ts`：**先把 `NestedSpawnPort.spawn` 签名扩为 `{runId, label?} | {error}`**
   （`agent-tool.ts:15-21`；label 可选——fake port 与任何结构兼容的旧实现不破坏；真实 SpawnService
   恒返回；workflow 的 ChildSpawner 是另一条结构链不受影响）；再做五路径 marker/throw 文本 +
   `AgentToolDetails.label` + 工具文案 + `tests/tools/agent-tool.test.ts`（§8.4）。
   fake port 兼容策略：测试桩可只返回 `{runId}`（label 可选），工具侧 `spawned.label ?? params.description`
   兜底；**host.ts 回落 `opts.label`**（§5.3-2）；**replay 路径不过 ChildSpawner**，无 label 概念（§5.3 P1b）。
4. `src/workflow/types.ts`（HostSettleEnvelope ok 变体 + `runId?/label?`）→ `src/workflow/host.ts`
   （§5.3 五处）→ `src/workflow/spawner-adapter.ts`（透传）→ `src/workflow/worker-source.ts`
   （`opts.fullResult`）+ `tests/workflow/host.test.ts`（§8.5）与 worker-source 层（§8.6）。
5. `src/rpc/protocol.ts` 契约注释 + `AGENTS.md` 一句 + `tests/rpc/rpc.test.ts`（§8.9）。
6. `tests/mention/mention.test.ts`（§8.3）、`tests/service/resolve-target.test.ts`（§8.7）、
   集成用例（§8.10）；全量 `vitest` 回归（重点盯 resume/resolve-target/fabric 通知快照）。
7. 文档收尾：README/CHANGELOG（冲突 warn-first-wins → 自动序号；isRunId label → 兜底 base；
   Agent 工具失败文本格式变化）。
