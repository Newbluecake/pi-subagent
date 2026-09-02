# auto-background + abort_subagent — 实施方案（v3，复审修订版）

> 只读调查 + 本文档，不含实现。目标：借鉴 Claude Code，前台 Agent 调用超过阈值后自动
> 降级为后台（主会话拿回控制权）；补齐模型侧后台控制面 `abort_subagent`。
> v3 相对 v2 的 7 条实施级修订见 §9。行号均已对照当前代码复核。

## 0. 核实基线

- **前台两条路径**（src/tools/agent-tool.ts）：`request` 在分支**外**构造（:228-246），
  `...(signal ? { signal } : {})`（:252）对所有路径生效。顶层（`deps.progress` 且有
  `onUpdate`）走 spawn → 1Hz push → `progress.waitOutcome`（:266-292）；嵌套/无
  progress 走 `spawnAndWait`（:293）；`run_in_background` 分支（:248-258）返回
  `details: { runId, background: true }`。
- **progress port 接线**（src/index.ts:118-127）：`waitOutcome` 目前借用
  `spawn.waitAll`；v3 改为直转新的 `spawn.waitOutcome`（§2.2）。
- **signal 消费**：`SpawnRequest.signal` → `createCancelHandle(req.runId, gen,
req.signal, …)`（src/runtime/runner.ts:281）；external signal 监听注册于
  runner.ts:78-80，`detach()` 仅 runner 内部持有 → 工具层只能 relay（§2.1）。
  `createCancelHandle` 本身从 runner.ts:55 导出，可直接单测（§7 I1b）。
- **SpawnService 状态源**：`finish()`（spawn-service.ts:105-128）同步写 `outcomes`
  map 并 resolve `waits`；`records.set` 的两处写入点：start() 的 runner `onSnapshot`
  回调（:147-150）与 finish() 的 terminal snapshot（:127-129）。v3 的
  autoBackgrounded 标记合并就挂在这两处 + 独立 metadata map（§2.4）。
- **QueryService.stop 现状**（query-service.ts:101-109）：终态/未知/无能力/异常统一
  `{ ok: false, escalatedTo: "L4" }` → v3 细化（§3.2）。调用方：rpc/server.ts:113-119、
  index.ts session_shutdown drain（:182-191，忽略返回值）。
- **RPC 协议**：`StopParamsSchema` 的 `cause` 仅允许 `"user_stop" | "shutdown"`
  （rpc/protocol.ts:39-44）——既有限制，v3 不动；result 侧为 `Type.Unknown()` 透传。
- **模型协议文案**：`formatAgentTypesForPrompt()`（agent-types.ts:198-220）的
  "Tool protocol: a foreground Agent call blocks until…"（:213）必须改写；该函数目前
  不接收 settings，需扩参。
- **fleet 数据源**：fleet-panel.ts 行构建（:258-266）全部读 `snapshot.diag.*` →
  标记必须进 `RunDiagnostics`。
- **settings 生效时机**：settings 在 activate() 加载一次（index.ts:86）；工具注册也
  只在 activate 一次；`/agent settings set` 仅 budget.* 原地生效，其余 /reload 后
  生效（status.ts:14-16）。v3 决策见 §4。

## 1. 改动文件清单

| 文件                                          | 改动                                                                                                                                                                      | 为什么             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `src/config/settings.ts`                      | `AgentSettings.foregroundAutoBackgroundMs: number`；DEFAULT 600_000；`loadSettings` 校验 `typeof === "number" && Number.isFinite(v) && v >= 0`                            | §4                 |
| `src/core/types.ts`                           | `RunDiagnostics.autoBackgroundedAt?: Millis`                                                                                                                              | §2.4               |
| `src/service/spawn-service.ts`                | ① `waitOutcome(runId, waitMs?)` 有界/无界等待；② `markAutoBackgrounded(runId)` + `autoBackgroundedAt` metadata map；③ 两处 records.set 与 finish() 合并标记、终态清理 map | §2.2 / §2.4        |
| `src/service/query-service.ts`                | `stop()` 返回 `StopResult` union（导出类型）                                                                                                                              | §3.2               |
| `src/tools/agent-tool.ts`                     | request 构造拆分；relay + 状态门；降级返回；`AgentToolDetails.autoBackgrounded?`；description 更新                                                                        | §2.1 / §2.3 / §5.2 |
| `src/tools/abort-tool.ts`                     | **新文件**                                                                                                                                                                | §3.1               |
| `src/config/agent-types.ts`                   | `formatAgentTypesForPrompt` / `appendAgentTypesToSystemPrompt` 扩参，Tool protocol 文案按阈值改写                                                                         | §5.1               |
| `src/ui/fleet-panel.ts`                       | `diag.autoBackgroundedAt` → 行标记 `⇣后台`                                                                                                                                | §2.4               |
| `src/index.ts`                                | 注册 abort 工具；progress port 改接 `spawn.waitOutcome`/`markAutoBackgrounded`；传 autoBackgroundMs；before_agent_start 传阈值                                            | 接线               |
| `src/commands/status.ts`                      | `SETTING_SPECS` 加 `foregroundAutoBackgroundMs: MS`                                                                                                                       | §4                 |
| `src/rpc/server.ts` + `src/rpc/client.ts`     | server stop 分支注释形式化两层语义；client 复用导出的 `StopResult` 类型                                                                                                   | §3.3               |
| `README.md` / `README.en.md` / `CHANGELOG.md` | 工具清单 + settings + CHANGELOG 行为变化说明                                                                                                                              | §4 / §5            |
| 测试                                          | 见 §7                                                                                                                                                                     |                    |

## 2. 功能 1：auto-background

### 2.1 relay 分支规则（正式化）

**request 构造拆分**：构造不含 signal 的 `baseRequest`；signal 由各分支按下表注入：

| 分支                               | signal 处理       | 说明                                                                    |
| ---------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `run_in_background: true`          | 直传原始 `signal` | **有意保留现有语义**（后台 run 仍挂在 tool-call signal 上），本变更不动 |
| 顶层前台 progress 分支             | 传 `relay.signal` | relay 规则见下                                                          |
| 嵌套 / 无 progress（spawnAndWait） | 直传原始 `signal` | 不引入 relay，最小改动                                                  |

relay 规则（伪代码）：

```ts
const relay = new AbortController();
let forwardAbort = true; // 状态门
const onAbort = () => {
  if (forwardAbort) relay.abort();
};
let relayListenerAttached = false;
if (signal?.aborted) {
  relay.abort(); // ① 原 signal 已 aborted：仍然 spawn（有意保持现有语义——
  //   今天该 request 也会带着已 aborted 的 signal 进入 runner，
  //   由 cancel handle 立即取消，run 落 aborted 而非 config 错误）
} else if (signal) {
  signal.addEventListener("abort", onAbort, { once: true });
  relayListenerAttached = true;
}
const stopForwarding = () => {
  forwardAbort = false; // ② 先同步关门（abort 事件已入
  //   派发队列时晚到的 onAbort 变 no-op）
  if (relayListenerAttached) signal!.removeEventListener("abort", onAbort); // ③ 再摘除
};
```

**清理统一顺序 `forwardAbort = false → removeEventListener`**，三条路径都执行：

- 降级返回前：stopForwarding()（此后原 signal 不再影响 run）；
- 正常终态返回前：stopForwarding()（终态后 abort 原 signal 不应再触发任何传导）；
- spawn 返回 `{ error }` / 抛错路径：stopForwarding() 后 rethrow（用 try/finally 收拢）。

降级后仍能停 run 的手段：`timeout_ms`/budget 看门狗、session shutdown drain、
`abort_subagent`——唯一变化是原 tool-call signal 不再影响该 run。relay 在 runner 眼中
是普通 external signal（stopCause 记 `parent_abort`），与今天一致。

### 2.2 SpawnService.waitOutcome（有界/无界等待，正式签名与伪代码）

```ts
// src/service/spawn-service.ts
export type BoundedWaitResult =
  | { kind: "settled"; outcome: RunOutcome }
  | { kind: "pending" };

// interface SpawnService 增加：
waitOutcome(runId: RunId, waitMs?: number): Promise<BoundedWaitResult>;
//   waitMs === undefined → 无限等待（功能关闭时工具层走此分支）；
//   waitMs 为有限数      → 超时 resolve { kind: "pending" }。
```

实现伪代码（复刻 spawnAndWait 的同步 check-then-register；统一 cleanup 防双重结算）：

```ts
waitOutcome(runId, waitMs) {
  const done = outcomes.get(runId);
  if (done) return Promise.resolve({ kind: "settled", outcome: done });
  return new Promise((resolve) => {
    let settledFlag = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = waits.get(runId) ?? new Set();
    const cleanup = () => {
      if (settledFlag) return;
      settledFlag = true;
      if (timer !== undefined) clearTimeout(timer);
      set.delete(waiter);
      if (set.size === 0) waits.delete(runId);      // 空集摘除，防 map 泄漏
    };
    const waiter = (outcome: RunOutcome) => {
      if (settledFlag) return;                      // resolve 只发生一次
      cleanup();
      resolve({ kind: "settled", outcome });
    };
    set.add(waiter);
    waits.set(runId, set);
    // 关键：绝不能把 undefined 传给 setTimeout（JS 中等价 0ms）。
    if (waitMs !== undefined) {
      timer = setTimeout(() => {
        if (settledFlag) return;
        cleanup();
        // 最后再查一次 outcomes：finish() 已先于本回调在同 tick 跑完时按 settled 收口
        const late = outcomes.get(runId);
        resolve(late ? { kind: "settled", outcome: late } : { kind: "pending" });
      }, waitMs);
      (timer as { unref?: () => void }).unref?.();
    }
    // waitMs === undefined：只注册 waiter、不建 timer —— 无限等待，由 finish() 唯一结算。
  });
}
```

**正确原子性语义**（取代 v2 的错误表述）：

- finish() 在 deadline 回调**之前**执行（含同 tick 的宏任务序）→ waiter 已 resolve
  settled，或 deadline 回调的 `outcomes.get` 复查命中 → settled。
- deadline 回调**先**执行且 `outcomes` 无记录 → `{ kind: "pending" }` 是**合法结果**，
  不是误报：run 随后终态时 outcome 由 outcomes/records/tombstones 保留，
  `get_subagent_result` 可读。工具层对 pending 的唯一动作是返回"已转后台"文案，
  不消费、不丢弃任何 outcome。

**工具层消费**（agent-tool.ts 顶层 progress 分支）：

```ts
const autoMs = deps.autoBackgroundMs?.() ?? 0;
const waited = await progress.waitOutcome(spawned.runId, autoMs > 0 ? autoMs : undefined);
if (waited.kind === "pending") {
  progress.markAutoBackgrounded?.(spawned.runId);
  stopForwarding();
  return backgroundStyleResult; // §2.3
}
// settled → 现有 completed / 非 completed 处理（return/throw 前 stopForwarding()）
```

`ForegroundProgressPort` 签名更新：`waitOutcome(runId, waitMs?)` → `BoundedWaitResult`；
新增 `markAutoBackgrounded?(runId)`。index.ts 接线从 waitAll 借用改为直转
`spawn.waitOutcome` / `spawn.markAutoBackgrounded`。1Hz progress timer 仍由现有
`finally { clearInterval }` 清理。嵌套防御：分支条件加 `!deps.parentRunId`。

### 2.3 降级返回的 tool result

```ts
{
  content: [{ type: "text", text:
    `Subagent "${label}" is still running after ${formatDuration(autoMs)} and has been moved ` +
    `to the background (run_id: ${runId}). The run was NOT stopped — it keeps running under ` +
    `its normal time budget. You must collect it later: get_subagent_result(run_id: "${runId}", ` +
    `wait: true) to block for its result; steer_subagent to send a follow-up instruction; ` +
    `abort_subagent to stop it.` }],
  details: { runId, background: true, autoBackgrounded: true },  // AgentToolDetails 新增字段
}
```

renderResult 无需改（无 `details.progress` 时走 final 分支渲染 body）。

### 2.4 autoBackgrounded 标记：独立 metadata map（不依赖 records 时序）

问题：spawn() 返回 runId 后 runner 可能尚未发出首个 snapshot，`records.get(runId)`
为 undefined——若标记依赖 live record 则 no-op 丢标记。

设计（SpawnService 内部）：

```ts
const autoBackgroundedAt = new Map<RunId, Millis>();

markAutoBackgrounded(runId) {
  if (!running.has(runId)) return;                 // 已终态/未知：no-op
  autoBackgroundedAt.set(runId, now());            // ① 先落 map（与 snapshot 时序解耦）
  const live = records.get(runId);
  if (live) {
    live.diag.autoBackgroundedAt = autoBackgroundedAt.get(runId);   // ② 有 live 则就地合并
    deps.onSnapshot?.(live);                       //    重发，触发 fleet/usage 刷新链路
  }
}
```

合并点（两处 records.set + finish）：

- start() 的 runner `onSnapshot` 回调（spawn-service.ts:147-150）：写入 records 前
  `if (autoBackgroundedAt.has(runId)) s.diag.autoBackgroundedAt = autoBackgroundedAt.get(runId)`；
- finish() 的 terminal snapshot（:116-130）：**双源取值**——
  `outcome.diag.autoBackgroundedAt ?? records.get(runId)?.diag.autoBackgroundedAt ?? autoBackgroundedAt.get(runId)`，
  写入 terminal snapshot 的 diag；terminal snapshot 照常进 records/tombstones/run-log
  （**终态与持久化 snapshot 保留该字段**，有意决策：history 可区分"曾被降级"）；
- finish() 末尾 `autoBackgroundedAt.delete(runId)` 清理 map 条目。

`core/types.ts`：`RunDiagnostics` 增加 `autoBackgroundedAt?: Millis`（display-only）。
`fleet-panel.ts`：行 marker 区（参考 ♻重试，:114 附近）追加
`diag.autoBackgroundedAt !== undefined ? "⇣后台"`。

## 3. 功能 2：abort_subagent

### 3.1 工具本体（src/tools/abort-tool.ts，仿 steer-tool.ts）

- 参数：`run_id`（描述同 steer/result：全 id / 唯一前缀 / label）、`reason?: string`。
- `reason` **只回显**，不进 `StopCause`（封闭 union，core/types.ts:28，不扩）；回显前
  清理控制字符（`/[\u0000-\u001f\u007f]/g` → 空格，同 resolve-target.ts `oneLine`）
  并截断。cause 恒传 `"user_stop"`。
- `renderCall` 复用 steer-tool 模式：`Abort Subagent: <run_id>` + reason 空白折叠单行
  预览、80 字截断、容忍流式半参数。
- 执行流程（判态收进 `QueryService.stop` 一处，工具层不做 `query.get` 预判）：
  1. `resolveRun` 失败 → throw（自纠错 candidates，沿用 steer 模式）；
  2. `query.stop(runId, "user_stop")`，按 §3.2 的 `StopResult` 分发：
     - `{ ok: true, escalatedTo }` → 确认文案 `Abort requested for run X (escalation:
L2). Use get_subagent_result(run_id, wait: true) to wait for its terminal
state.`，details `{ runId, ok: true, escalatedTo }`；
     - `{ ok: false, reason: "already_terminal", status }` → **正常返回**（幂等）：
       `run X has already reached a terminal state ("<status>"); nothing to abort`，
       details `{ runId, alreadyTerminal: true, status }`；
     - `{ ok: false, reason: "unknown_run" }` → throw `unknown run_id: …`；
     - `{ ok: false, reason: "stop_failed", escalatedTo }` → throw。

### 3.2 QueryService.stop() 返回契约（正式类型 + 伪代码）

```ts
// src/service/query-service.ts（导出，供 abort 工具与 rpc/client.ts 复用）
export type StopResult =
  | { ok: true; escalatedTo: "L2" | "L3" | "L4" }
  | { ok: false; reason: "unknown_run" }
  | { ok: false; reason: "already_terminal"; status: RunStatus }
  | { ok: false; reason: "stop_failed"; escalatedTo: "L2" | "L3" | "L4" };

async stop(id, cause = "user_stop"): Promise<StopResult> {
  const snapshot = deps.registry.get(id);
  if (!snapshot) return { ok: false, reason: "unknown_run" };
  if (terminal(snapshot.status))
    return { ok: false, reason: "already_terminal", status: snapshot.status };
  if (!deps.runner.abort) return { ok: false, reason: "stop_failed", escalatedTo: "L4" };
  try {
    const res = await deps.runner.abort(id, cause);
    if (res.ok) return res;
    // TOCTOU 内化：查 snapshot → runner.abort 之间 run 恰好终态（activeCancels 已摘除，
    // runner.ts:248-251 返回 ok:false）——复查 registry，已终态则按 already_terminal
    // 收口（语义等价"目标已达成"，对调用方幂等），否则 stop_failed。
    const after = deps.registry.get(id);
    if (after && terminal(after.status))
      return { ok: false, reason: "already_terminal", status: after.status };
    return { ok: false, reason: "stop_failed", escalatedTo: res.escalatedTo };
  } catch {
    return { ok: false, reason: "stop_failed", escalatedTo: "L4" };
  }
}
```

重复 abort（stopping 中）由 runner cancel handle 的 already-aborted 守卫
（runner.ts:69）保证 `{ ok: true }` 幂等返回，不进 stop_failed。

### 3.3 RPC 边界与两层语义（正式化）

`abort_subagent` **仅是 host 进程 model-facing 工具**，走 forwardQuery 的本地
QueryService。外部 RPC 调用方使用 protocol 已有的 `"stop"` 方法（精确 runId，无
label/前缀解析——resolve-target.ts 顶部注释明确 RPC 保持精确 id 语义）；
`StopParamsSchema.cause` 仅允许 `"user_stop" | "shutdown"` 是**既有限制**，本变更不动。

两层语义必须在 server.ts stop 分支注释中写明：

- **外层 envelope** `{ ok: true, result }`：仅表示 RPC 传输/校验成功；
- **内层 result**：才是 §3.2 的 `StopResult` union——`{ ok: false, reason:
"already_terminal" }` 时**外层仍 `ok: true`**，调用方必须解析内层。

`rpc/client.ts` 从 query-service.ts 导入 `StopResult` 作为 stop 调用的 result 类型，
避免调用方按旧 `{ ok, escalatedTo }` 假设解析。protocol schema 不变（result 侧
`Type.Unknown()` 透传），无需版本号升级。

现有调用方影响：index.ts session_shutdown drain（:182-191）忽略返回值，不受影响
（补竞态测试，§7 I4）；测试里的 `stop: async () => false` mock 需按新类型修正；
实现时 `grep "\.stop("` 全仓核对遗漏调用方。

## 4. 配置（最终决策）

- `AgentSettings.foregroundAutoBackgroundMs: number`；**默认 600_000（10 分钟，开启）**；
  `0` = 关闭。`loadSettings` 校验 `typeof v === "number" && Number.isFinite(v) && v >= 0`，
  否则回落默认。现有其他 key 的 NaN/Infinity 校验缺口本变更不修，记为已知问题。
- **生效时机（明确表述，取代 v2 的误导说法）**：`createAgentTool` deps 传 getter
  `autoBackgroundMs?: () => number`，index.ts 传
  `() => settings.foregroundAutoBackgroundMs`。settings 对象在 activate() 时加载；
  `/agent settings set foregroundAutoBackgroundMs …` 只持久化到文件，**当前 session
  继续用旧值，/reload 后生效**（status.ts 对非 budget key 的既有提示语即此语义）；
  getter 只是避免在工具注册时固化数值，**不承诺热生效**；正在等待中的前台调用
  按调用开始时读到的值执行，不受事后 set 的追溯影响。
- `status.ts` `SETTING_SPECS` 增加 `foregroundAutoBackgroundMs: MS`（min 0）。
- CHANGELOG 必须写明行为变化：前台 Agent 调用超过 10 分钟自动转为后台返回。

## 5. 模型协议文案全套更新

### 5.1 `formatAgentTypesForPrompt()`（agent-types.ts:198-220）

签名扩为 `formatAgentTypesForPrompt(types, opts?: { foregroundAutoBackgroundMs?: number })`，
`appendAgentTypesToSystemPrompt(systemPrompt, types, opts?)` 透传；index.ts 的
before_agent_start hook（:139-143）在事件时从 settings 读取传入。

"Tool protocol" 行（:213）二选一：

- 开启时：`Tool protocol: a foreground Agent call blocks until the subagent finishes and
returns its result directly; if it runs longer than ~<threshold> the call returns early
with a run_id — the run is NOT stopped, it keeps running in the background and you must
collect it with get_subagent_result(run_id, wait?), steer it with steer_subagent, or stop
it with abort_subagent.`
- 关闭（0）时：保留现文案，末尾补 abort_subagent 的存在。

其余行：`run_in_background` 行补 abort_subagent；末行 "Anywhere a run_id is accepted"
列表加入 abort_subagent。

### 5.2 Agent 工具 description（agent-tool.ts:200-207）

补："A foreground call that exceeds the configured auto-background threshold returns early
with a run_id (the run keeps going; collect it with get_subagent_result)." 与
"abort_subagent stops a running subagent." `promptSnippet` 不变。

### 5.3 abort 工具自身文案

description："Stop a still-running subagent started with the Agent tool (including one
that was auto-backgrounded). Terminal runs are reported as already-finished instead of
erroring, so repeated calls are safe."
`promptSnippet`：`abort_subagent(run_id, reason?) - stop a running subagent`。

## 6. usage 归属（产品行为，明确）

- 降级后该 run 的 usage 走 `get_subagent_result` 首次终态读取附加（result-tool.ts
  `usageReported`/`usageOnce` 去重），与显式 background 完全一致。
- 模型从不读取终态时，主会话 pi usage 总额不含该 run 花费（fleet / `/agent costs`
  仍可见真实花费）——既有 background 语义，接受并保持，README 写明。

## 7. 测试计划（vitest；T* 单测，I* 真实组件测试，边界按复审拆分）

### 单测

**tests/tools/agent-tool-progress.test.ts（追加 describe "auto-background"）**

- T1 超时降级：fake timers；`autoBackgroundMs: () => 1_000`；port 的 waitOutcome 在
  阈值内不 settle；advance 过阈值 → `details` 为 `{ runId, background: true,
autoBackgrounded: true }`；文案含三工具名与 "NOT stopped"；降级后无新 onUpdate。
- T2 阈值前 settled → 走原有 enriched final result（行为不变）。
- T3 降级后 abort 原 signal：`request.signal.aborted === false` 且
  `request.signal !== controller.signal`（relay 替换断言）。
- T4 降级前 abort 原 signal → 经 relay 生效，execute reject（前台取消语义保留）。
- T5 原 signal 进入时已 aborted → 仍调用 spawn（relay 立即 aborted），保持现有语义。
- T6 **正常终态后** abort 原 signal → 无任何传导（listener 已按统一顺序清理）。
- T7 spawn 返回 `{ error }` → throw 且原 signal listener 已摘除。
- T8 `autoBackgroundMs: () => 0` → waitOutcome 以 `waitMs === undefined` 调用（断言
  port 实参），无界阻塞语义不变。
- T9 显式 `run_in_background: true`：request 直传原 signal（`request.signal ===
controller.signal`），语义不变。

**tests/tools/abort-tool.test.ts（新文件）**

- T10 renderCall：空白折叠 + 80 字截断 + 流式半参数。
- T11-T15：stop 返回 `ok:true` / `already_terminal`（正常返回、文案含 status）/
  `unknown_run`（throw）/ `stop_failed`（throw）/ resolveRun 失败（throw）。
- T16 label 解析后 stop 收到规范 runId 与 `"user_stop"`；reason 控制字符清理回显。

**tests/service（query-service 测试）**

- T17 stop 契约：unknown / terminal（带 status）/ 无 runner.abort（stop_failed L4）/
  正常 L2 / runner.abort 返回 ok:false 且复查已终态 → 改写 already_terminal。

**tests/service/spawn-service.test.ts（追加）**

- T18 `waitOutcome`：已终态立即 settled；注册后 finish → settled；超时 → pending；
  `waitMs === undefined` 时不建 timer、无限等待（finish 前一直 pending，finish 后
  settled）；cleanup 后 waiter 摘除且空集 `waits.delete`（重复调用不累积）；timer
  与 finish 交错时 cleanup/done 标志保证 resolve 只发生一次。
- T19 `markAutoBackgrounded`：① 首个 snapshot 之前 mark（records 无条目）→ 标记落
  map，随后首个 onSnapshot 写入 records 时合并进 diag（**关键回归用例**）；② live
  run mark → diag 就地更新 + onSnapshot 重发；③ terminal/未知 no-op；④ finish 后
  terminal snapshot 继承标记且 map 条目已清理。

**tests/config/agent-config.test.ts**

- T20 settings 解析：默认 600_000；0 保留；NaN/Infinity/负数/字符串回落默认。
- T21 prompt 文案：开启/关闭两种 "Tool protocol" 行；abort_subagent 在 run_id 列表。

**tests/tools/model-facing-strings.test.ts**

- T22 tools() 加 abort 工具；无 §/architecture；run_id 描述含 label。

**tests/commands/status.test.ts**

- T23 `settings set foregroundAutoBackgroundMs 300000` 成功；负数 Invalid value。

**tests/tools/result-tool.test.ts（追加）**

- T24 降级后首次终态读取附 usage，第二次不重复。
- T25 先非等待（running，无 usage）后等待读取（终态，附一次）不重复计费。

### 真实组件测试（边界按复审拆分，不混装）

装配仿 tests/integration/wiring.test.ts（真实 SingleSlotPool +
createRuntimeRunnerAdapter + 脚本化 SessionDriver + 真实 SpawnService/QueryService）。

- **I1a（SpawnService wait/finish 竞态，fake runner）**：可控 finish 时机。
  - 用例 1：finish 在 deadline 回调前执行（含同 tick 宏任务序）→ waitOutcome 得
    `{ kind: "settled" }`，工具层返回终态结果而非降级文案。
  - 用例 2：deadline 回调先执行且 outcomes 无记录 → `{ kind: "pending" }` 为合法
    结果；随后 finish 的 outcome 保留在 store，`get_subagent_result`（同一 query）
    可读终态——两条断言分开写，不再宣称"两种顺序均 settled"。
- **I1b（relay 取消链路，真实 RuntimeRunner / createCancelHandle）**：与 I1a 分开。
  降级返回后 abort 原 tool signal → 经真实 `createCancelHandle`（runner.ts:55 导出，
  可直接行为单测）验证 run 不被取消、仍 running；随后正常 finish 落终态。
  覆盖点：external listener 已摘除 + 状态门使晚到 abort 为 no-op。
- **I2（降级后 result tool 收口）**：I1a 布景 + `createResultTool` 接同一 query，
  wait:true 读到终态且 usage 只附一次。
- **I3（session shutdown 竞态）**：① drain 的 `query.list()` 之后 run 自然完成 →
  `query.stop` 返回 `already_terminal`，shutdown 的 `Promise.all` **不 reject**；
  ② stopping 状态 run 的 stop 返回 `ok:true` 幂等，不抛。走 index.ts drain 同款
  `query.stop(runId, "shutdown")` + `waitAll`。
- **I4（abort 工具四态，真实 QueryService + 可控 runner）**：running → ok:true；
  stopping → 幂等 ok:true；terminal → already_terminal 正常返回；unknown → throw。

## 8. 风险与边界情况

| 风险                                      | 处理                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 降级瞬间 run 恰好终态                     | §2.2 原子语义：finish 先 → settled；deadline 先 → pending 合法、outcome 由 store 保留可后读；I1a 两用例 |
| abort 事件已入派发队列                    | §2.1 状态门先于 removeEventListener；T3/I1b                                                             |
| 降级后原 tool signal 连带杀 run           | relay + 三路径统一清理；明确仅原 signal 失效，timeout/shutdown/abort_subagent 仍可停                    |
| `setTimeout(fn, undefined)` ≡ 0ms         | §2.2 伪代码显式 `waitMs !== undefined` 分支；T8                                                         |
| waiter / waits map 泄漏                   | cleanup() + 空集 delete + done 标志；T18                                                                |
| mark 早于首个 snapshot 丢标记             | §2.4 独立 metadata map + 两处写入合并 + finish 双源取值；T19                                            |
| workflow/嵌套误降级                       | 不经 progress 分支 + `!deps.parentRunId` 双保险                                                         |
| stop TOCTOU                               | §3.2 stop 内复查 registry 改写 already_terminal；T17/I4                                                 |
| 重复 abort / abort 已终态 / shutdown 竞态 | runner 守卫幂等 + 契约区分；I3/I4                                                                       |
| RPC 调用方按旧契约解析                    | §3.3 两层语义注释 + client 复用 StopResult                                                              |
| 降级后 usage 丢失/重复                    | §6 + T24/T25/I2                                                                                         |
| 配置误读为热生效                          | §4 明确 set 后当前 session 旧值、/reload 生效、在途调用不追溯                                           |
| 降级后终态通知                            | notifier 照常投递（progress 路径本就不 consume），模型凭通知或 get_subagent_result 收口                 |

## 9. v3 相对 v2 的 7 条修订落实

1. **waitOutcome 无界语义**：正式签名 `waitOutcome(runId, waitMs?)`；伪代码含
   `waitMs === undefined` 分支（只注册 waiter、不建 timer）；显式禁止把 undefined
   传给 setTimeout（§2.2，T8）。
2. **waits map 清理**：统一 `cleanup()` + `settledFlag` 防 timer 回调与 finish() 双重
   结算；空集 `waits.delete(runId)`（§2.2，T18）。
3. **原子性表述修正**：删除"同 tick 两种顺序均 settled"；正确语义两分支写明，
   I2 拆为 I1a 的两个明确用例（§2.2、§7）。
4. **markAutoBackgrounded 时序**：SpawnService 内独立 `autoBackgroundedAt` map——
   mark 先落 map、两处 records.set 合并、finish() 双源取值写入 terminal snapshot、
   终态清理（§2.4，T19 含"mark 早于首个 snapshot"回归用例）。
5. **RPC stop 契约正式化**：envelope ok:true=传输成功、内层 result=StopResult 的
   两层语义写入 server 注释；client.ts 复用导出类型；补 shutdown 竞态测试 I3；
   注明 StopParamsSchema 的 cause 限制为既有（§3.3）。
6. **relay 分支规则正式化**：三分支 signal 处理表（含"原 signal 已 aborted 仍
   spawn"的有意保留）；三路径统一 `forwardAbort=false → removeEventListener`；
   测试 T3-T7、T9 全覆盖（§2.1、§7）。
7. **I1 边界拆分**：I1a（fake runner 的 wait/finish 竞态）与 I1b（真实
   RuntimeRunner/createCancelHandle 的 relay 取消链路）分开列（§7）。

另：删除 v2 "getter 与 settings 原地 mutation 兼容"的误导表述，§4 明确生效时机
为 /reload、在途调用不追溯。
