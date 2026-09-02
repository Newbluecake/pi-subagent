# 工具结果回流与提示词修缮实施方案（v2，按评审意见修订）

范围：7 个改进点，分三组——组 1（结构化结果回流 ×1，P1）、组 2（轮询进度增强 + 失败可恢复提示 ×2，P2）、组 3（提示词修缮 ×4，P1/P2/P3 混合）。
涉及文件：`src/tools/result-tool.ts`、`src/tools/agent-tool.ts`、`src/tools/steer-tool.ts`、`src/config/agent-types.ts`；`src/tools/workflow-tool.ts` 与 `src/tools/structured-output-tool.ts` 经核实模型可见字符串无需改动（见 §3c），后者仅纳入卫生测试范围。
测试：`tests/tools/result-tool.test.ts`、`tests/tools/agent-tool.test.ts`、`tests/config/agent-config.test.ts`，新增 `tests/tools/model-facing-strings.test.ts`。

验证命令（已核实 package.json）：`npm test`（vitest run）、`npm run typecheck`（tsc --noEmit）、`npm run build`（tsc -p tsconfig.build.json）。

---

## 组 1：结构化结果回流（P1，bug 级）

**问题**：`src/tools/result-tool.ts` 的 `formatOutcome()`（第 102 行起，模块私有函数）completed 分支只取 `outcome.text`。带 `schema` 的 run 结果在 `outcome.structuredResult`（由 `src/core/json-schema.ts#applyStructuredOutputPolicy` 写入；失败时该字段缺席，见 `RunOutcome` 注释），后台 run 经 get_subagent_result 取回时模型只看到 undefined 兜底的 "(subagent completed with no text output)"。前台路径（agent-tool.ts 成功分支）已是正确写法。

**改动**：仅改 `formatOutcome` 一个函数，两个调用点（第 58 行非等待分支、第 87 行等待分支）不动——它们传入的本来就是完整 `RunOutcome`，只需把参数类型加上 `structuredResult?: unknown`。

```ts
// 前
function formatOutcome(outcome: {
  status: string;
  text?: string;
  error?: { message: string };
  timeoutReason?: string;
  usage?: { ... };
}): string {
  ...
  if (outcome.status === "completed") return (outcome.text ?? "(subagent completed with no text output)") + usage;

// 后
function formatOutcome(outcome: {
  status: string;
  text?: string;
  structuredResult?: unknown;   // 新增
  error?: { message: string };
  timeoutReason?: string;
  usage?: { ... };
}): string {
  ...
  if (outcome.status === "completed") {
    const body =
      outcome.structuredResult !== undefined
        ? JSON.stringify(outcome.structuredResult)
        : (outcome.text ?? "(subagent completed with no text output)");
    return body + usage;
  }
```

**边界情况**：

- 用 `!== undefined` 而非真值判断：`structuredResult` 可能是 `0`/`false`/`null`（schema 允许时），与 agent-tool.ts 前台写法保持一致。
- 非 completed 状态不序列化 structuredResult（按 `RunOutcome` 契约失败时该字段本就不存在；防御性地只在 completed 分支处理）。
- usage 尾注拼接逻辑保持不变（body 之后 `\n\n(usage: ...)`）。
- 风险：`JSON.stringify` 结果无长度上限，大 payload 会膨胀 content。前台路径同样无上限，本次保持两路径一致；如需截断属后续独立改进，勿在本次混入。

---

## 组 2a：非终态轮询返回完整态势（P2）

**改动点**：`src/tools/result-tool.ts` 非等待分支（第 57-60 行）。

```ts
// 前
const text = snapshot.outcome
  ? formatOutcome(snapshot.outcome)
  : `Run ${runId} is still ${snapshot.status} (phase: ${snapshot.phase}).`;

// 后
const text = snapshot.outcome
  ? formatOutcome(snapshot.outcome)
  : [
      `Run ${runId} is still ${snapshot.status} (phase: ${snapshot.phase}).`,
      ...buildProgressLines(snapshot, Date.now()),
    ].join("\n");
```

**共享方式（采纳方案 A）**：result-tool.ts 直接 `import { buildProgressLines } from "./agent-tool.js";`。import 方向已核实无循环依赖：agent-tool.ts 的依赖为 typebox / pi-tui / pi-coding-agent(类型) / core/types / ui/fleet-panel / ui/fleet-widget / config/model-hint / tools/usage，**不 import result-tool**；grep 确认 result-tool 仅被 `src/index.ts` 与测试引用。传递引入的 pi-tui（`Text`）是既有 peer dep，测试环境可加载，代价可接受。
（未来可选清理：若后续想消除 tool→tool 边，可把 `buildProgressLines` 提取到 `src/tools/progress.ts` 并由 agent-tool 再导出；本次不做。）

**边界情况**：queued/starting 快照 `diag.model`/`toolHistory`/`text` 均可缺省，`buildProgressLines` 已有兜底（agentType→status、空轨迹、无 💬 行），此时输出仅头一行，不会炸。`diag.createdAt` 必有（`RunDiagnostics` 必填），耗时计算安全。

## 组 2b：前台失败错误信息附带 runId / resume 提示 / 部分输出（P2）

**改动点**：`src/tools/agent-tool.ts` 第 296-299 行（spawnAndWait 与 progress-port 两条前台路径汇合后的唯一 throw，单点修改两者皆覆盖）。

```ts
// 前
if (outcome.status !== "completed") {
  const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
  throw new Error(`Subagent "${params.description}" did not complete successfully: ${reason}`);
}

// 后
if (outcome.status !== "completed") {
  const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
  const tail = outcome.text?.trim();
  const excerpt = tail ? (tail.length > 500 ? `…${tail.slice(-500)}` : tail) : undefined;
  const parts = [
    `Subagent "${params.description}" did not complete successfully: ${reason} (run_id: ${outcome.runId}).`,
  ];
  if (outcome.diag.sessionFile) {
    // 非承诺式措辞：resume 的真实成功条件是终态快照 + sessionFile 存在
    // 且为盘上普通文件（resolve-target.ts:157 existsSync/statIsFile），
    // 工具层不做新的存在性检查，只给提示。
    parts.push(`A persisted session may be resumable — retry with resume: "${outcome.runId}".`);
  } else {
    parts.push("The run failed before a session was created; there is nothing to resume.");
  }
  if (excerpt) parts.push(`Partial output (tail): ${excerpt}`);
  throw new Error(parts.join(" "));
}
```

**resume 可行性核实（已做）**：`src/service/resolve-target.ts` 的 `TERMINAL = {completed, failed, timed_out, aborted}`，`resolveResumeTarget` 要求终态快照/tombstone 中存在 `diag.sessionFile`、且 `existsSync(sessionFile) && statSync().isFile()`（resolve-target.ts:157）。结论：**aborted 同样可 resume**，无需按状态区分；但 `diag.sessionFile` 有值 ≠ 文件仍在盘上（如被清理），因此提示语必须是非承诺式（"may be resumable"），工具层**不引入新的 fs 存在性检查**（保持 tools 层无 IO 的既有边界）。无 sessionFile（config 错误、queue 超时等早期失败）时给出"nothing to resume"。

**边界情况**：

- `outcome.text` 为 undefined 或全空白 → 省略 tail 段。
- 截断取**末尾** 500 字符（尾部离失败点最近），前缀加 `…` 标记有截断；`params.description` 与 `error.message` 不截断，维持现有语义。
- 保留 `did not complete successfully: ${reason}` 原前缀，现有测试断言 `/did not complete successfully: total/`（tests/tools/agent-tool-progress.test.ts:198）继续通过。

---

## 组 3a：描述截断改为句界优先（P1，提示词质量）

**改动点**：`src/config/agent-types.ts` `formatAgentTypesForPrompt()` 内的裁剪逻辑（第 ~190 行）。

```ts
// 前
const desc = t.description.replace(/\s+/g, " ").trim();
const clipped = desc.length > 200 ? `${desc.slice(0, 197)}...` : desc;

// 后
const DESC_LIMIT = 300;
const desc = t.description.replace(/\s+/g, " ").trim();
const clipped = desc.length > DESC_LIMIT ? clipAtSentenceBoundary(desc, DESC_LIMIT) : desc;
```

新增模块内私有助手（修订版：无最小前缀门槛；英文/CJK 标点双规则）：

```ts
/** Clip at the last sentence boundary within `limit`; hard `...` cut when none exists.
 *  双规则句界：英文标点 (.!?;) 须后跟空白或结尾（避免误切 "v1.2" / "e.g." 之类）；
 *  CJK 标点 (。！？；) 后可直接接任意字符（"句一。句二" 中 。 是有效句界）。 */
function clipAtSentenceBoundary(text: string, limit: number): string {
  const window = text.slice(0, limit);
  const matches = [...window.matchAll(/[.!?;](?=\s|$)|[。！？；]/g)];
  const last = matches[matches.length - 1];
  if (last) return window.slice(0, last.index + 1); // 保留标点，不加 "..."
  return `${text.slice(0, limit - 3)}...`;
}
```

**边界情况**：窗口内只要有有效句界就取最后一个（不再设 ≥40 的最小前缀门槛——短首句截到首句是可接受行为，且与测试样例一致）；英文句点要求 `(?=\s|$)`，CJK 标点不要求；完全无句界的长串行为与现状一致（`...` 结尾）。

## 组 3b：系统提示追加工具使用协议（P2）

**改动点**：同函数返回数组末尾追加固定 4 行（英文）：

```ts
return [
  "## Available subagent types (pi-subagent)",
  "When calling the Agent tool, pass one of these exact names as `subagent_type`:",
  ...lines,
  "Tool protocol: a foreground Agent call blocks until the subagent finishes and returns its result directly.",
  "With run_in_background: true the Agent call returns immediately with a run_id — poll or block with get_subagent_result(run_id, wait?).",
  "steer_subagent works only on a run that is still running; the Agent tool's resume parameter works only on a terminal run with an existing persisted session (terminal includes completed, failed, timed_out and aborted).",
  "Anywhere a run_id is accepted (get_subagent_result, steer_subagent, resume), the Agent call's label (its `description`) works too.",
].join("\n");
```

label 支持的依据已核实：`spawn-service.ts` 在 spawn 时以 `req.label`（= Agent 工具 `description` 参数）注册 labels 表，`resolveRunId` 查该表。resume 的"终态"措辞与 resolve-target.ts 的 TERMINAL 集合一致，不暗示只有 completed 可续。

## 组 3c：清除模型可见描述中的内部架构编号（P1，已全量核实）

`grep` 结果：

- **唯一模型可见违规**：`src/tools/agent-tool.ts` 第 159 行 schema 参数描述中的 `(double validation — architecture §7.2 X10)`。
  改为 `(validated twice — by the injected tool at submission and independently by the host before completion)`，保留语义、去掉内部引用。
- `src/tools/workflow-tool.ts`：工具 `description`/`promptSnippet`/参数描述均无 `§`/`architecture`；所有 `\u00a7` 引用（10 处）都在代码注释里 → **不改**。
- `src/tools/result-tool.ts`、`steer-tool.ts`、`structured-output-tool.ts`：仅注释含内部引用，模型可见字符串干净 → 保留注释，不改。

防回归：新增卫生测试（见测试方案），扫描**全部五个模型可见工具**的 `description`/`promptSnippet`/递归参数 description，断言不匹配 `/[§]|architecture/`。

## 组 3d：run_id / resume 参数描述说明接受 label 与终态语义（P3）

- `src/tools/result-tool.ts`：`"The run id returned by the Agent tool."` →
  `"The run id returned by the Agent tool; also accepts a unique run_id prefix or the Agent call's label (its description)."`
- `src/tools/steer-tool.ts`：`"The run id of the subagent to steer."` → 同上句式。
- `src/tools/agent-tool.ts` resume 参数描述：`"Agent label or run_id of a completed subagent session to continue."` →
  `"Agent label or run_id of a terminal subagent session (completed, failed, timed_out or aborted) with an existing persisted session to continue."`——现状措辞暗示只有 completed 可续，与 TERMINAL 集合不符。
- `src/tools/agent-tool.ts` 工具级 description 中的 `"Set resume to a completed Agent label or run_id to continue its persisted session."`（第 ~198 行）同步改为终态措辞：`"Set resume to the Agent label or run_id of a terminal run to continue its persisted session."`
- 依据已核实：`resolve-target.ts#resolveRunId` 支持精确 id → 唯一前缀 → 注册 label 三级匹配；`resolveResumeTarget` 接受全部四种终态。三个工具均已接 `resolveRun`/resume 链路。

---

## 测试方案

现有风格：vitest，手写假 `QueryService`/`NestedSpawnPort` 对象字面量，构造完整 `RunSnapshot`/`RunOutcome` 夹具（见 tests/tools/result-tool.test.ts、agent-tool-progress.test.ts 的 `snapshot()`/`diag()` 工厂，可直接复用该模式）。

### tests/tools/result-tool.test.ts（新增 describe "structured result + progress"）

1. `serializes structuredResult as content text for a completed schema run (non-wait path)`：outcome 带 `structuredResult: {ok:true}` 且无 text。断言拆两条（避免"既严格相等又含尾注"的矛盾）：
   `expect(text.startsWith(JSON.stringify(value))).toBe(true)` 且 `expect(text).toContain("cost:$0.0055")`；或等价地 `expect(text).toBe(`${JSON.stringify(value)}\n\n(usage: ...)`)` 精确全串。
2. `serializes structuredResult on the wait path`：wait 返回带 structuredResult 的 outcome；同上拆分断言。
3. `prefers structuredResult over text when both are present` / `treats structuredResult: null as present`（`!== undefined` 语义：序列化为 "null" 而非落到 text 兜底）。
4. `non-terminal lookup appends full progress situation`：running 快照带 diag.model/toolHistory(2 条)/text；断言 content 含 "still running"、`⏳` 头（model · phase · turn）、最近工具名与 ✓/▸ 标记、`💬` 文本尾巴。

### tests/tools/agent-tool.test.ts（新增 describe "foreground failure diagnostics"）

用 spawnAndWait 返回非 completed outcome 的假 port：

1. `failure error carries runId and a non-committal resume hint when a session file exists`：outcome `status:"failed"`、diag.sessionFile 有值；断言 message 含 runId、`may be resumable`、`resume: "<runId>"`，且**不含**承诺式 "is preserved"；保留原前缀。
2. `resume hint stays non-committal when the session file is gone from disk`：diag.sessionFile 指向盘上不存在的路径；断言措辞仍为 "may be resumable"（工具层不做 fs 检查），且 resume 实际失败路径行为不变（resolveResumeTarget 的 existsSync 拒绝已由 tests/service/resolve-target.test.ts 覆盖，此处仅断言 agent-tool 不新增 IO 耦合——可用一个不存在的路径间接证明未做检查）。
3. `omits the resume hint when no session was created`：无 sessionFile；断言含 "nothing to resume"、不含 "resumable"。
4. `appends the partial-output tail capped at 501 chars`：text 为 1000 字符；断言 tail 片段（`…` + 末尾 500 字符）长度 ≤501、message 含该尾部、且 description/error.message 部分未被截断。
5. `no tail section when text is undefined/blank`。
6. 兼容检查：agent-tool-progress.test.ts 既有 `/did not complete successfully: total/` 断言无需修改（跑一遍确认）。

### tests/config/agent-config.test.ts（修改 + 新增）

1. 修改 `flattens multi-line descriptions and clips pathological lengths`：上限 200→300，行长断言改为 `< 320`；无句界长串仍以 `...` 结尾的断言保留。
2. 新增 `clips at a sentence boundary when one exists within the limit`：desc = `"First sentence. " + "x".repeat(400)`；修订后规则下首句句界（index ~15）即有效，断言裁到 "First sentence." 结束、无 `...`。
3. 新增 `treats CJK sentence punctuation as a boundary without trailing whitespace`：desc 为 300+ 字符的中文多句文本（如 `"句一。" + "字".repeat(400)`），断言裁到 "句一。"、无 `...`。
4. 新增 `falls back to hard cut when the window has no sentence boundary`：纯长串无标点 → `...` 结尾、长度 = limit。
5. 新增 `appends the tool-usage protocol lines`：断言输出含 `run_in_background`、`get_subagent_result`、`steer_subagent`、`terminal run`、`label` 关键词。
6. 既有 header/空列表断言不变；tests/integration/system-prompt-injection.test.ts 只断言 `toContain` 标题与类型行，不受影响（跑一遍确认）。

### 新增 tests/tools/model-facing-strings.test.ts

1. `tool descriptions/snippets/parameter descriptions contain no internal architecture references`：构造**五个**模型可见工具——agent / result / steer / workflow（最小假 deps）/ StructuredOutput（`createStructuredOutputTool({ schema: {...}, onSubmit: () => ({ok:true}) })`）。遍历 `description` + `promptSnippet` + 参数 schema 中**递归**收集的所有 `description` 字段（workflow-tool 的 `replayScope` 是 `Type.Union` 嵌套，浅遍历会漏），断言 `not.toMatch(/§|architecture/)`。递归收集器形态：

```ts
function collectDescriptions(schema: unknown, out: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return out;
  const s = schema as Record<string, unknown>;
  if (typeof s.description === "string") out.push(s.description);
  for (const v of Object.values(s)) {
    if (Array.isArray(v)) for (const x of v) collectDescriptions(x, out);
    else collectDescriptions(v, out);
  }
  return out;
}
```

2. `run_id parameters document label acceptance`：result/steer 两工具的 run_id 描述含 "label"。
3. `resume parameter documents terminal-run semantics`：agent 工具的 resume 描述含 "terminal"、不含暗示仅 completed 的孤立 "completed subagent session" 措辞。

## 改动顺序

1. **组 3c/3d**（最小、独立）→ `npx vitest run tests/tools`
2. **组 1**（formatOutcome）→ `npx vitest run tests/tools/result-tool.test.ts`
3. **组 3a/3b** → `npx vitest run tests/config tests/integration`
4. **组 2a**（方案 A：result-tool 直接 import agent-tool）→ `npx vitest run tests/tools`
5. **组 2b** → `npx vitest run tests/tools`
6. 全量：`npm run typecheck && npm test && npm run build`

## 风险点

- **formatOutcome 签名**：模块私有、仅两处调用且均传完整 RunOutcome，类型加可选字段即可，无外部调用点。
- **import 边**：result-tool→agent-tool 已核实无环；代价是经 agent-tool 传递引入 pi-tui 运行时依赖（既有 peer dep）。若未来要消除该边，再做 progress.ts 提取。
- **提示词长度**：固定部分（协议 4 行）约 +90~120 token，与类型数无关；可变部分按当前实际注册类型数 N 线性增长——描述上限 200→300 为每类型最坏 +100 字符（≈25 token），当前内置仅 2 个类型（general-purpose/Plan），实际增量 ≈50 token；类型数无上限，N 很大时增量随 N 线性增长（每类型 ≤25 token），属可预期的有界斜率。agent-config 测试的行长断言必须同步放宽，否则会红。
- **错误信息变更**：agent-tool 失败 message 被现有测试以正则断言，保持 `did not complete successfully: ${reason}` 原前缀即可兼容；工作流工具的同名句式（workflow-tool.ts:268）不在本次范围，不要顺手改。
- **structuredResult 体积**：序列化无截断，与前台路径现状一致；超大 schema payload 的 content 膨胀是已知遗留，记入后续 issue。
- **卫生测试的假 deps**：workflow/StructuredOutput 工具构造参数较多，测试里用最小假对象即可（execute 不被调用，只读字符串字段）。
