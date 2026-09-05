# get_subagent_result 返回文本修复 — 实施方案（v3）

> 只读调查 + 本文档，不含源码改动。行号均已在当前 HEAD 复核（含两轮独立调查 + 一轮评审的交叉验证）。
> 评审前置知识为零假设：§1 自带问题背景，§2 是现状核实，§3 起是方案。
>
> **v3 变更点（评审"有条件通过"的逐条处置，全部接受）**：
>
> | 评审意见                                                               | 处置                                                                                                                                              | 落点             |
> | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
> | 阻断1：resultMaxChars 未接入 loadSettings 白名单                       | 接受，补 loadSettings 字段校验（NaN/Infinity/负数/小数回退）+ loadSettings 测试                                                                   | §4 B1a、§6 T15   |
> | 阻断2：嵌套 Agent 工具（runtime-adapter.ts:319-325）未接截断           | 接受，锁定方案 (a)：RuntimeAdapterDeps 加 resultMaxChars thunk，stack.ts:449 接线                                                                 | §4 B5a、§6 T13   |
> | 阻断3：非正常终态（turnError/失败/超时/abort）的覆盖语义未定义         | 接受，锁定：**仅 `input.error === undefined` 时覆盖**；非正常终态保留 delta 拼接作为 partial output                                               | §4 A1、§6 T4     |
> | 重要4：abort_grace 可达性说明 + 守卫误拦 thinking_delta                | 接受：补可达性论证；守卫**只拦 text_delta**，thinking_delta 维持现状                                                                              | §4 A3、§6 T6     |
> | 重要5：T13 透传测试不足，需端到端链路                                  | 接受，T13 改为 fake driver→状态机→SpawnService→workflow 值的端到端用例                                                                            | §6 T13           |
> | 重要6：thunk 模式 ≠ spec 可不标 live                                   | 接受：resultMaxChars 标 `live: true`（execute 时读 thunk，即时生效属实）；autoBackgroundS 的同类文案问题记为 follow-up                            | §4 B2            |
> | 重要7：maxChars 语义未固定                                             | 接受：只限正文 body（不含截断标注与 duration/usage trailer）；details.totalChars = 原 body 的 UTF-16 code unit 数；slice 避开 surrogate pair 断裂 | §4 B3、§6 T9-T11 |
> | 建议8：textFinal 持久化回归                                            | 接受，新增 snapshot JSON round-trip 测试                                                                                                          | §6 T16           |
> | 建议9：T1-T14 补缺口                                                   | 接受，测试清单重排为 T1-T16                                                                                                                       | §6               |
> | 建议10：runtime-adapter.ts 路径前缀错误（src/runtime/ → src/service/） | 接受，全文修正                                                                                                                                    | §2.3/§2.4        |

## 1. 问题背景

`get_subagent_result`（以及前台 `Agent` 工具的完成返回）交给主会话模型的"结果正文"，
**不是**子 agent 的最终回答，而是整个 run 期间所有模型轮次 `text_delta` 的无界拼接：
多轮子 agent 的每一轮过程叙述（"我先看一下文件…""现在跑一下测试…"）全部缝在一起，
最终报告被埋在里面；且文本无任何长度上限，长任务可灌入几万 token 到主会话上下文。

两个缺陷：

- **语义错误**：终态文本来源用错。正确来源（pi 会话的最后一条 assistant 消息）其实
  已经拿到了，但被降级成"没有 delta 时才用"的兜底。**最强的语义诉求来自
  SubagentWorkflow**：src/workflow/host.ts:703,717 里沙箱脚本 `await agent()` resolve
  的值就是 `outcome.text`，脚本会拿它做逻辑判断/拼接——全量拼接对脚本不是"读着费劲"
  而是**正确性 bug**。本方案的语义验收标准：**workflow 脚本拿到的值 == 模型最后一轮
  的结论文本**。
- **体量无界**：结果文本在进入模型上下文前的最后一环（工具返回格式化）没有截断。
  对比完成通知的 `textPreview` 有 200 字符截断 + "去取全文"引导
  （src/delivery/format.ts:16-21），而"全文"本身无界。

## 2. 现状核实（行号已复核）

### 2.1 文本如何产生与流转

- `streamPatch()`（src/core/state-machine.ts:69-80）：`text_delta` 纯追加
  `d.text = (diag.text ?? "") + e.delta`（:72）。turn 边界（`turn_end`）不重置 `d.text`；
  甚至同一 turn 内多条 assistant 消息（工具调用前后的叙述段）也都拼在一起。
- runner 在 `prompt()` 落定后取 `finalText = handle.getLastAssistantText()`
  （src/runtime/runner.ts:414），随 `prompt_settled` 派发（:432）。pi 侧的
  `getLastAssistantText()`（node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2778-2800）
  语义正确：取最后一条 assistant 消息（跳过空 aborted 消息）的 text block 拼接，
  trim 后为空返回 `undefined`（因此 runner 永远不会传出空字符串 text）。
  **修复不需要 pi 侧任何改动**。
- 注意（评审阻断3）：runner 在 `prompted.ok === true` 但末轮出错（`getTurnError()`
  非空，runner.ts:418）时**仍会传 finalText**——此时最后一条 assistant 消息可能是
  被 provider 截断的半句。覆盖语义必须区分正常/非正常终态（§4 A1）。
- 状态机 `prompt_settled` 分支（state-machine.ts:645）：
  `const textPatch = input.text !== undefined && state.diag.text === undefined ? { text: input.text } : {};`
  ——**只在 diag.text 为空时才用 finalText**。正常流式场景 delta 早已累积，
  正确路径形同虚设。
- `finish()`（state-machine.ts:255-318 区域）以 `d.text` 生成 `outcome.text`、
  delivery payload 的 `textPreview: d.text ?? ""`（:298）、以及 persist_snapshot
  里的 diag/outcome。
- 终态后（`terminalUpdate`，state-machine.ts:333-343）：迟到的 `text_delta` 仍会
  追加进 `diag.text` 和已形成的 `outcome.text`（"collecting late text" 是刻意的，
  见 tests/core/core.test.ts:163-178）。
- `formatOutcome()`（src/tools/result-tool.ts:195-225）：completed 时返回
  `outcome.text` 全文 + trailer，无截断。前台 Agent 工具完成返回同样直出
  `outcome.text`（src/tools/agent-tool.ts:370）。
- **嵌套 Agent 工具**（评审阻断2）：src/service/runtime-adapter.ts:319-325 为子会话
  注入的 nested Agent 工具只传 `spawn/parentRunId/allowedTypes/forceSlotless`，
  其前台完成返回同样直出 outcome.text——这是第三个"进入模型上下文的边界"
  （子会话的模型上下文），v2 漏接。

### 2.2 消息边界信号盘点（增量调查结论）

pi 侧可用的消息边界信号：

| 信号                                                      | 现状                                                                              | 粒度                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| `turn_start`                                              | 已映射进 DriverEvent（src/runtime/session-driver.ts:121），但**状态机无对应分支** | turn（含多条 assistant 消息）——过粗 |
| `message_start`（session 事件）                           | mapEvent **未映射**（session-driver.ts:117-166）                                  | assistant 消息——正确粒度            |
| `assistantMessageEvent.type === "start"` / `"text_start"` | mapEvent **未映射**（tests/runtime/session-driver.test.ts:152-166 明确断言忽略）  | assistant 消息内 block——正确粒度    |

**结论：本方案（项 1）不需要任何重置边界信号**——终态正文由 finalText 在
prompt_settled 时权威覆盖，不依赖"运行期把 diag.text 维护成最后一条消息"。
若未来做字段拆分/运行期消息级预览（§3.4），应选 **message 级信号**（映射
`message_start` 或 `assistantMessageEvent.type === "start"`）而非 `turn_start`：
一个 turn 内有多条 assistant 消息，turn 边界重置后同 turn 内仍然拼接，治标不治本。

### 2.3 diag.text / outcome.text 全部消费者清单

| 消费者                                                  | 位置                                               | 用的字段                                    | 对修复的敏感度                                                                            |
| ------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `finish()` → outcome.text / textPreview                 | state-machine.ts:255-318                           | diag.text                                   | 项1直接受益者（终态语义变正确）                                                           |
| delivery 完成通知（200 字符预览+引导）                  | src/delivery/format.ts:14-21                       | payload.textPreview                         | 项1后预览变成"最终回答开头"，是改进                                                       |
| notifier finalize 的 textPreview                        | src/service/runtime-adapter.ts:432                 | settled.text                                | 同上；schema run 走 structuredPreview 短路                                                |
| workflow 子 run 进度预览                                | src/workflow/host.ts:682                           | outcome.text.slice(0, 2048)（生成端已截断） | 项1后语义变准                                                                             |
| fleet widget `»` 预览行                                 | src/ui/fleet-panel.ts:341-344                      | diag.thinkingText ?? diag.text              | **免疫**：仅非终态且 model_turn；lastTextLine 取最后一行，项1的覆盖发生在终态之时         |
| Agent 工具卡 `💬` 进度行                                | src/tools/agent-tool.ts:73-81 (buildProgressLines) | diag.text（最后非空行）                     | **免疫**：同上，仅运行中展示                                                              |
| Agent 前台失败 excerpt（尾部 500 字符）                 | src/tools/agent-tool.ts:350-352                    | outcome.text                                | 非正常终态保留 delta 拼接（§4 A1），尾部仍是最后叙述，天然适配"Partial output (tail)"语义 |
| Agent 前台成功返回                                      | src/tools/agent-tool.ts:365-375                    | outcome.text 全文                           | 项2截断点                                                                                 |
| 嵌套 Agent 前台返回                                     | src/service/runtime-adapter.ts:319-325             | outcome.text 全文                           | 项2截断点（v3 新增，方案 a）                                                              |
| get_subagent_result 两条路径                            | src/tools/result-tool.ts:112,179                   | formatOutcome(outcome)                      | 项2截断点                                                                                 |
| **workflow 沙箱 `agent()` resolve 值 + replay journal** | src/workflow/host.ts:703,717                       | outcome.text                                | **项1的验收标准**；replay 缓存按值匹配，**截断绝不能打在源头**                            |
| persist_snapshot 落盘                                   | src/adapters/pi-run-log.ts:24-32                   | diag.text + outcome.text                    | 保持全文（找回/恢复语义不变）                                                             |

### 2.4 structuredResult（X10）路径的正交性

schema run 的 `structuredResult` 由 `applyStructuredOutputPolicy` 在
src/service/runtime-adapter.ts:408-421 闭包内事后填充，消费端
（result-tool.ts:213-215、agent-tool.ts:368-370、
src/service/runtime-adapter.ts:433-437 的 structuredPreview）均短路 text。
**但注意**：schema run 运行期 diag.text 仍全量累积并进 persist_snapshot 和
（finalize 前的）textPreview。项 1 的 prompt_settled 覆盖对 schema run 同样生效
（finalText 覆盖发生在 settle 时，policy 翻转在其后），textPreview 随之变准；
本方案不对 structuredResult JSON 本身截断（schema 契约）。

### 2.5 被否决的备选：拆分"流式预览文本"与"终态答案文本"两字段

调查过程中评估过字段拆分（diag 新增 `finalText` 字段，diag.text 保持纯流式缓冲）。
结论：**不采用**，理由：

- 两个"免疫"消费者（fleet 预览、💬 行）都只在**非终态**读 diag.text——终态后
  没有任何预览消费者，因此"终态时把 diag.text 覆盖为 finalText"与"拆两个字段"
  对所有现存消费者效果等价；
- 拆分需要在 types/snapshot/delivery payload 全链路增加字段，而覆盖法只需
  一个布尔标记（textFinal）防 post-terminal 污染；
- 覆盖法顺带缩小了终态快照里 diag.text 的体积。

## 3. 修复组合建议（按风险/收益排序）

### 项 1（MVP）：正常终态时 finalText 覆盖 diag.text + textFinal 守卫

`prompt_settled` 同时满足 `input.text !== undefined` 且 `input.error === undefined`
时**覆盖** diag.text（而非仅兜底）并置 `textFinal`；其余场景（finalText 缺失、
或失败/超时/中止/末轮 model error 落定）保留 delta 拼接作为 partial output——
中止/超时场景 runner 本来就不传 text（`prompted.ok === false`），末轮 turnError
场景 runner 虽传 finalText 但状态机不用它（评审阻断3 的锁定语义，理由：
被 provider 截断的半句不如完整的流式记录有诊断价值，且 agent-tool 失败 excerpt
的 "Partial output (tail)" 语义正好匹配 delta 拼接）。

- 收益：completed 结果正文语义正确（最终回答）；**workflow `agent()` 值正确性修复**
  （验收标准）；完成通知 textPreview、workflow 进度预览（host.ts:682）同时变准。
- 风险：低-中。post-terminal 追加行为收窄（§4 A3），已有测试锁定旧行为（§6）。

### 项 2（MVP）：工具边界长度上限 + 可配置

`get_subagent_result`、前台 `Agent`、**嵌套 `Agent`** 三个模型上下文边界的
完成返回正文加可配置字符上限（默认 8000），超出截断并附 `diag.sessionFile`
路径，引导用 read 工具看全文。`structuredResult`（X10 schema 契约）不截断；
workflow value / journal / 快照保持全文。

- 收益：堵住无界 token 灌入；与 textPreview 的"预览+引导取全文"语义对齐。
- 风险：低。纯展示层；全文仍可从 session 文件 / snapshot 找回。

### 项 3（不做）：streamPatch 按 turn/message 重置 diag.text

理由：① turn 边界过粗（§2.2），message 边界需新增 mapEvent 映射，两者都只为
"运行期 diag.text 语义正确"服务；② 项 1 已从终态来源上解决问题，运行期 diag.text
的消费者只看最后一行（§2.3 免疫行），重置反而在每个边界清空预览、引入 UI 抖动；
③ 终态后 diag.text 被 finalText 覆盖，拼接文本不逃逸到任何终态产物。
jsdoc 中把 diag.text 的"运行期流式预览缓冲"定位写清楚即可（§4 A2 一并做）。

### 项 3b（顺带评估，结论：不改）：textPreview 截断方向

现状 delivery/format.ts:16-21 截**头部** 200 字符——在全量拼接语义下展示的是
第一段过程叙述，确实错误；但项 1 后 textPreview 的源变成 finalText（单条最终消息），
头部即最终回答的开头，与结果截断（项 2，同样保头部）方向一致。尾部截取会冒
"从代码块/列表中间切开"的风险，且 format.ts 是纯函数、不知道文本结构。
**结论：保持头部截断不改**；host.ts:682 的 2048 生成端截断同理保持。
tests/delivery/format.test.ts:10-30 因此无需改动。

### 项 4（可选后续，非本批）：diag.text 尾部硬帽

参照 `THINKING_TEXT_CAP`（state-machine.ts:51-66）给 diag.text 加 tail-cap
（如 8k），限制 persist_snapshot 体积与极端长 run 的内存。与项 1 正交：
项 1 后 diag.text 只在运行期被预览消费（最后一行），tail-cap 对预览无损。
注意 fallback 场景（非正常终态 run）下 outcome.text 将只剩尾部——对本就残缺的
输出，尾部恰是最有用的部分，可接受。**本批不做**，单独评估。

### 项 5（follow-up 记录，非本批）：foregroundAutoBackgroundS 的 live 文案

评审重要6 顺带发现：`foregroundAutoBackgroundS`（setting-specs.ts:142-145）经
thunk 在 execute 时读取、实际即时生效，但 spec 未标 `live: true`，
`effectOf()`（setting-specs.ts:285-286）会告诉用户"takes effect after /reload"。
与 resultMaxChars 同款的既有文案不准问题，**本批只保证新键标对**，旧键修正另开。

## 4. 具体改动点

### A. 终态文本语义（项 1）

**A1. src/core/state-machine.ts:645** — prompt_settled 分支（v3：加 error 条件）：

```ts
// 现状：
const textPatch = input.text !== undefined && state.diag.text === undefined ? { text: input.text } : {};
// 改为（v3 锁定：仅正常完成时覆盖；非正常终态保留 delta 拼接作为 partial output）：
const textPatch =
  input.text !== undefined && input.error === undefined ? { text: input.text, textFinal: true as const } : {};
```

同步更新 :641-644 的注释：finalText（SessionHandle.getLastAssistantText，消息粒度）
是**正常完成**时终态正文的权威来源；失败/超时/中止时 runner 可能仍传 finalText
（runner.ts:414 不看 turnError），但末条 assistant 消息可能是被截断的半句，
此时 delta 拼接是最完整的 partial output，不覆盖、不置 textFinal。
runner 侧无需改动（state-machine 单点裁决）。

`finish()` 无需改动：patch 合入 diag 后，`outcome.text = d.text`、
`textPreview = d.text` 自动取到正确来源。

**A2. src/core/types.ts — RunDiagnostics 增加字段**（放在 `text?: string` 旁，
jsdoc 同时厘清字段定位）：

```ts
/**
 * 运行期 = text_delta 拼接的流式预览缓冲（消费者只取最后一行，见 fleet-panel
 * lastTextLine / agent-tool buildProgressLines）；正常完成的 prompt_settled 以
 * finalText 覆盖并置 textFinal，此后即终态正文。非正常终态保持拼接原文
 * （partial output 语义）。
 */
text?: string;
/** 正常完成的 prompt_settled 以 finalText 覆盖 text 后置位：此后迟到 text_delta 不再追加。 */
textFinal?: true;
```

**A3. src/core/state-machine.ts terminalUpdate 的 session_event text_delta 分支
（:333-343）** — 加守卫（v3：只拦 text_delta，不拦 thinking_delta）：

```ts
if (input.event.t === "text_delta" && d.textFinal) {
  // finalText 已就位后，teardown 期间迟到的 delta 不得再污染终态正文
  // （其内容已包含在 finalText 所属的 assistant 消息里，追加只会重复）。
  // d 已含 lastEventAt/lastEventType；thinking_delta 不在此拦截——它只喂
  // display-only 的 thinkingText 尾部帽缓冲，无正确性风险。
  return { state: { ...state, diag: d }, effects: [] };
}
```

（插入位置：terminalUpdate 的 `session_event` 分支内、现有
`text_delta || thinking_delta` 分流之前；守卫命中时直接返回，不进 streamPatch。）

**可达性说明**（评审重要4）：`textFinal` 只在 `finish()` 的 patch 里被置位，而
`finish()` 必然把 run 置于终态（status completed/failed/timed_out/aborted，
phase settled）。此后所有输入都走 `terminalUpdate`；reduce 内非终态的
abort_grace 分支（:540-553）在 textFinal 置位后**不可达**（要进入该分支需
phase === abort_grace 且非终态，与 textFinal 的存在条件互斥）。因此该分支
**不需要也不允许**加守卫——它处理的是"stop_requested 已发、prompt_settled 未到"
的窗口期，此时 finalText 尚未产生，delta 仍是唯一文本来源。

**A4. 不改动**：src/runtime/session-driver.ts mapEvent（§2.2——本方案不需要
消息边界信号），tests/runtime/session-driver.test.ts:146-169 无新增用例负担。

### B. 工具边界截断（项 2）

**B1. src/config/settings.ts** — `AgentSettings` 增加：

```ts
/** Max chars of a subagent's result text returned to the caller; 0 = no cap. Default 8000. */
resultMaxChars: number;
```

`DEFAULT_SETTINGS` 增加 `resultMaxChars: 8_000`。

**B1a. src/config/settings.ts loadSettings()（:190-258，评审阻断1）** —
字段白名单重建设置对象，必须显式接入，否则 JSON 文件配置被静默丢弃。
加入（对齐 foregroundAutoBackgroundMs 的校验风格 + maxNestedDepth 的取整）：

```ts
resultMaxChars:
  typeof value.resultMaxChars === "number" &&
  Number.isFinite(value.resultMaxChars) &&
  value.resultMaxChars >= 0
    ? Math.floor(value.resultMaxChars)
    : DEFAULT_SETTINGS.resultMaxChars,
```

回退矩阵：NaN / ±Infinity / 负数 / 非 number → 默认 8000；小数 → floor。
`loadSettingsFromFile` 委托 `loadSettings`，无需单独改动（其 WARN/rewrite 只针对
时间单位迁移，resultMaxChars 非时间字段）。

**B2. src/config/setting-specs.ts** — SETTING_SPECS 增加（放 `fleetWidget` 附近，
v3：标 live，评审重要6）：

```ts
resultMaxChars: {
  ...count("resultMaxChars", 0, "Max chars of subagent result text returned; 0 = no cap"),
  live: true, // execute 时经 thunk 读取（index.ts B6 / stack.ts B5a），settings set 即时生效
},
```

`/agent settings set resultMaxChars …` 的生效文案随之输出
"applies to new runs immediately"——对 execute-time thunk 而言属实
（实际连"new runs"都不用等，进行中的 wait 下一次调用也读新值，但 live 文案
已是现有词汇表中最准确的）。

**B3. 新文件 src/tools/result-text.ts** — 共享截断 helper（纯函数，便于单测。
v3 按评审重要7 固定语义）：

```ts
export interface TruncatedResultText {
  /** 截断后的正文 + （截断时）截断标注；调用方在此之后自行追加 duration/usage trailer。 */
  text: string;
  truncated: boolean;
  /** 原始正文的 UTF-16 code unit 长度（JS string.length 语义），未截断时等于 text.length。 */
  totalChars: number;
}
export function truncateResultText(text: string, maxChars: number, sessionFile?: string): TruncatedResultText;
```

锁定的语义：

- `maxChars` 只限制**正文 body**，不含截断标注本身，也不含调用方追加的
  duration/usage trailer——返回文本可能略超 maxChars（标注 + trailer），这是有意的：
  上限的用途是防"几万 token 灌入"，不是精确排版。
- `maxChars <= 0`（含负数——loadSettings 已拦负数，此处防御 thunk 直供场景）
  或 `text.length <= maxChars`：原样返回，`truncated: false`。
- 计数单位是 **UTF-16 code unit**（JS `string.length`）；切分点若落在 surrogate
  pair 中间（`text.charCodeAt(maxChars - 1)` 为 high surrogate），回退一个 code
  unit 再切，避免产出孤立代理半个字符。
- 截断标注（接在 body 之后、trailer 之前）：
  `\n\n… [output truncated — showing first {n} of {totalChars} chars]`
  - `sessionFile` 存在时追加
    `; full session transcript: {sessionFile} — use the read tool to inspect it`。

**B4. src/tools/result-tool.ts** —

- `createResultTool` deps 增加 `resultMaxChars?: () => number`。
- `formatOutcome()` 签名加第二参 `maxChars`，completed 且
  `structuredResult === undefined` 时对 `outcome.text` 走 truncateResultText
  （sessionFile 取 `outcome.diag.sessionFile`——formatOutcome 的入参类型目前是
  结构子集，需加 `diag?: { sessionFile?: string }`）。trailer 拼接在截断之后。
- 两处调用点（:112 get 路径、:179 wait 路径）传入 `deps.resultMaxChars?.() ?? 0`。
- `details` 增加 `truncated: true` / `totalChars: <原 body 长度>`（仅截断时）。
- 工具 description 补一句：结果超长时按 resultMaxChars 截断并附 session 文件路径，
  可用 read 工具查看全文（model-facing 字符串，注意 §6 的 model-facing-strings 测试）。

**B5. src/tools/agent-tool.ts** — 前台 completed 返回处（:365-375）对
`outcome.text` 走同一 truncateResultText；`createAgentTool` deps 增加
`resultMaxChars?: () => number`。失败 excerpt（:350-352 已有 500 字符尾截）不动。

**B5a. 嵌套 Agent 工具（v3 新增，评审阻断2，锁定方案 a）** —

- src/service/runtime-adapter.ts `RuntimeAdapterDeps`（:35-58）增加
  `resultMaxChars?: () => number`。
- 同文件 :319-325 的 nested `createAgentTool({...})` 调用加传
  `resultMaxChars: deps.resultMaxChars`（createAgentTool 内部自行判 undefined）。
  嵌套工具的前台返回进入**子会话**的模型上下文，与"模型上下文边界截断"的
  设计意图一致；子会话 Agent 调用没有 run_in_background 引导心智，长文本
  危害等同顶层前台。
- src/stack.ts:449 `createRuntimeRunnerAdapter({...})` 接线
  `resultMaxChars: () => settings.resultMaxChars`（settings 在 buildSessionStack
  作用域内，:282 参数）。

**B6. src/index.ts 接线** — :123 createAgentTool 与 :137 createResultTool 各加
`resultMaxChars: () => settings.resultMaxChars`（沿用 `autoBackgroundMs` thunk 模式）。

**明确不做**：workflow host_settle value / replay journal（host.ts:703,717）、
persist_snapshot、textPreview 均保持全文/现状——截断只在"进入模型上下文"的
三个工具边界。

### C. 文档与注释

- A2 的 jsdoc（字段定位）；A1 分支注释更新。
- AGENTS.md 无需改（无新子系统）；README 的 settings 列表如有枚举需补
  resultMaxChars（实现时 grep 确认）。

## 5. 配置项设计小结

| 键               | 类型                       | 默认 | 语义                                                      | 生效                            |
| ---------------- | -------------------------- | ---- | --------------------------------------------------------- | ------------------------------- |
| `resultMaxChars` | count（整数，min 0，live） | 8000 | 工具返回给调用方的结果正文字符上限（仅 body）；0 = 不截断 | execute 时 thunk 读取，即时生效 |

默认 8000 字符 ≈ 2-4k token：足够装下典型的最终报告，又能挡住几万 token 的
长任务全文。单位用字符（UTF-16 code unit）而非 token（与仓库现有
slice/maxLogBytes 风格一致，且无需 tokenizer）。

## 6. 测试策略

### 已评估的现有测试（保持绿色，无需改动）

1. **tests/core/core.test.ts:163-178 "preserves aborted status while collecting late text"**：
   最直接依赖无边界追加的用例。其 `prompt_settled` 不带 text，textFinal 不置位，
   迟到 delta 仍追加——保持绿色，恰好锁定 fallback 语义。
2. **矩阵测试共享断言器**（core.test.ts:545-551 `diagTextDelta`、:600-609
   `diagTerminalTextDelta`，后者断言 `outcome.text` 同步追加）：矩阵的
   prompt_settled 输入均不带 text（随机生成器 :1421-1430 只随机 error），
   before 态 `textFinal` 恒为 undefined → A3 守卫不触发 → 矩阵保持绿色。
   AGENTS.md"改状态机必须同步矩阵测试"的要求以新增 T1/T2/T6 用例满足。
3. tests/integration/wiring.test.ts:139（`getLastAssistantText: () => "hello from subagent"`
   断言 `outcome.text` 恰为它，且无 error）：项 1 后依然成立。
4. tests/tools/result-tool.test.ts:263、tests/tools/agent-tool-progress.test.ts:419-427
   （运行中 diag.text 预览行）：项 1/项 2 均不触碰其构造路径。
5. tests/delivery/format.test.ts:10-30：§3.3b 结论不改截断方向。
6. tests/runtime/session-driver.test.ts:146-169：mapEvent 不动。
7. tests/tools/result-tool.test.ts 现有用例 text 都很短，默认 8000 不触发截断；
   description 改动需核对 tests/tools/model-facing-strings.test.ts。

### 新增测试（T1-T16）

**tests/core/core.test.ts（状态机）**：

- T1 多轮叙述场景：model_turn 中 `text_delta("turn1 narrative")` → `turn_end` →
  `text_delta("turn2 narrative")` → `prompt_settled({ text: "final answer" })`（无 error）：
  断言 `outcome.text === "final answer"`、`diag.text === "final answer"`、
  `diag.textFinal === true`；effects 中 enqueue_delivery 的 `textPreview === "final answer"`。
- T2 终态守卫（text_delta）：T1 后再来 `text_delta(" trailing")`：outcome.text /
  diag.text 不变，lastEventType 仍更新。
- T3 fallback（无 text）：只有 delta、prompt_settled 不带 text → outcome.text 为
  delta 拼接（回归旧行为）。
- T4 **非正常终态不覆盖（v3 阻断3）**：delta 累积 "partial output" 后
  `prompt_settled({ error: {kind:"model",…}, text: "被截断的半句" })`：
  断言 outcome.text === "partial output"、textFinal 未置位、status === "failed"；
  后续迟到 text_delta 仍可追加（textFinal 未置，守卫不拦）。
- T5 无 delta 场景：prompt_settled 带 text、无任何 delta → outcome.text 为 finalText
  （现有兜底路径，锁定不回归）。finalText 为空字符串的情况由 runner 边界排除
  （pi 返回 undefined，§2.1），状态机层不需特判——用 runner 层 T8 锁定。
- T6 **终态守卫不拦 thinking_delta（v3 重要4）**：T1 后来 thinking_delta：
  `diag.thinkingText` 正常累积（尾部帽逻辑不变），text/outcome.text 不变。
- T7 非终态 abort_grace 中 delta 仍累积（:540-553 分支可达性回归，呼应 §4 A3
  可达性说明）。

**tests/runtime/runtime.test.ts（runner 集成）**：

- T8 fake handle 同时吐 text_delta 且 `getLastAssistantText()` 返回 "final"：
  outcome.text === "final"（runner→状态机全链路覆盖）；同文件补
  `getLastAssistantText()` 返回 undefined 的 fallback 全链路用例。
- T9（可选）fake handle `getTurnError()` 非空 + 返回 finalText：outcome.status
  为 failed 且 outcome.text 为 delta 拼接（runner 传 text 但状态机不采用）。

**tests/tools/result-text.test.ts（新文件，helper 单测，v3 重要7）**：

- T10 边界与语义：`maxChars === text.length` 不截断；`maxChars: 0` 与负数不截断；
  截断时 text 含标注且标注在 trailer 之前（trailer 由调用方拼接，单测只验 helper
  输出不含 trailer）；无 sessionFile 时标注不含文件引导。
- T11 Unicode：body 恰在 emoji（surrogate pair）处越界时，截断点回退一个 code
  unit，输出不含孤立代理半字符；totalChars 为原串 `.length`。

**tests/tools/result-tool.test.ts / agent-tool.test.ts（截断接线）**：

- T12 超长 text + `resultMaxChars: () => 100`：正文截断、含标注与 sessionFile
  引导、duration/usage trailer 仍在末尾、details.truncated/totalChars 正确；
  get 路径与 wait 路径各一次。agent-tool 前台 completed 冒烟一次。
- structuredResult 场景（:235-250 现有用例扩展）：JSON 不截断，即使超长。

**嵌套 Agent（v3 阻断2）**：

- T13 tests/service/ 或 tests/tools/：经 RuntimeAdapterDeps.resultMaxChars 构造
  嵌套 Agent 工具（参考 runtime-adapter 现有测试的 fake deps），断言其前台
  completed 返回被截断；不传该 dep 时不截断（边界锁定）。

**workflow 端到端验收（v3 重要5，替换 v2 的透传式 T13）**：

- T14 端到端链路（放 tests/integration/ 或沿用
  tests/workflow/a2-window-real-spawn-service.test.ts:118 的"真实 SpawnService +
  RuntimeRunner + fake driver"模式）：fake SessionDriver 的 handle 分两段吐
  text_delta（模拟两轮叙述），`getLastAssistantText()` 返回第二段；
  `SpawnService.waitAll` 落定后断言 outcome.text === 第二段；再经 workflow host
  settle 路径（host.ts:703,717）断言 `agent()` resolve 值与 journal 条目 value
  均为该最终文本（replay 用全文的语义一并锁定）。

**配置（v3 阻断1/重要6）**：

- T15 tests/config/agent-config.test.ts（该文件已测 loadSettings，:26-35 为同款
  用例风格）：`loadSettings({ resultMaxChars: 100 })` → 100；NaN / Infinity /
  -5 / "100" / 3.9 → 8000 / 8000 / 8000 / 8000 / 3。另在
  settings-time-migration.test.ts 或同文件断言 `SETTING_SPECS.resultMaxChars`
  存在、`live === true`、defaultOf === 8000。
- T16 **textFinal 持久化 round-trip（v3 建议8）**：终态 snapshot（含
  `textFinal: true` 与覆盖后的 text）经 JSON 序列化/反序列化（pi-run-log 的
  appendEntry JSONL 通路或其等价物）后两字段保留；旧快照（无 textFinal）读入
  为 undefined，行为同旧。放 tests/adapters/ 下既有 store 测试旁。

## 7. 兼容性风险

1. **对外行为变化（主要）**：`get_subagent_result`、前台与嵌套 `Agent` 的返回正文
   (a) completed 时语义变为"最终回答"而非全程拼接，(b) 超 8000 字符被截断；
   workflow 脚本 `agent()` 的 resolve 值同步变为最终结论（对依赖拼接文本做解析的
   既有 workflow 脚本是行为变化，但旧行为本身是 bug，无兼容义务）。仓库内依赖
   "拼接全文"的消费者：经 §2.3 全量排查不存在（replay journal 用 outcome.text
   全文，项 1 只让全文更准；textPreview 本就 200 字符截断）。
2. **非正常终态行为不变**：failed/timed_out/aborted 的 outcome.text 保持 delta
   拼接（v3 阻断3 锁定），Agent 失败 excerpt、失败通知等既有展示不受影响。
3. **CHANGELOG**：需要。仓库惯例是 [Unreleased] 下手写详述条目
   （见现有 CHANGELOG.md 风格），建议 `### Fixed` 一条（终态文本语义，
   含 workflow agent() 值修复）+ `### Changed` 一条（结果截断与新设置
   resultMaxChars）。commit 遵循 Conventional Commits：
   `fix(core): prefer final assistant message as run outcome text`
   - `feat(tools): cap subagent result text with resultMaxChars`。
4. **快照格式**：RunDiagnostics 新增可选字段 textFinal，旧快照读入为 undefined，
   行为同旧（T16 锁定）——无迁移负担。
5. **pi 版本耦合**：`getLastAssistantText` 已在现有 peer 范围（>=0.84 <0.86）内
   使用（runner.ts:414 现状即依赖），本方案不引入新 pi API、不改 mapEvent。
6. **性能**：截断是 O(body) slice；项 1 反而缩小了终态后 diag.text 的体积。

## 8. 落地顺序建议

1. A1-A3（状态机语义）+ T1-T9、T14、T16 → 单独一个 fix commit；
2. B1-B6（含 B1a loadSettings、B5a 嵌套接线）+ T10-T13、T15 + CHANGELOG →
   第二个 commit；
3. 全量 `npm run format && npm run typecheck && npm test && npm run build` 四连
   （CI 门槛，AGENTS.md 要求）。
