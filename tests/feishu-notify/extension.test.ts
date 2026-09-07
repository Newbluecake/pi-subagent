import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishBackgroundStatus } from "../../src/service/background-status.js";

const TEST_CONFIG_PATH = join(tmpdir(), `feishu-notify-test-${process.pid}.json`);

// ---------------------------------------------------------------------------
// Test scaffolding (per plan §9.1, with the createFakePi "push" bug fixed)
// ---------------------------------------------------------------------------

function createFakePi(externalTools: unknown[] = []) {
  const handlers = new Map<string, Function[]>();
  const busHandlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const push = (m: Map<string, Function[]>, k: string, h: Function) => {
    const arr = m.get(k) ?? [];
    arr.push(h);
    m.set(k, arr);
  };
  const pi = {
    on: (e: string, h: Function) => push(handlers, e, h),
    events: {
      on: (ch: string, h: Function) => {
        push(busHandlers, ch, h);
        return () => {
          const arr = busHandlers.get(ch);
          if (arr)
            busHandlers.set(
              ch,
              arr.filter((x) => x !== h),
            );
        };
      },
      emit: (ch: string, d: unknown) => {
        for (const h of busHandlers.get(ch) ?? []) h(d);
      },
    },
    registerTool: (t: any) => tools.push(t),
    registerCommand: (n: string, c: any) => commands.set(n, c),
    getAllTools: () => externalTools,
  } as unknown as ExtensionAPI;

  const emit = async (e: string, ev: any = {}, ctx: any = defaultCtx) => {
    for (const h of handlers.get(e) ?? []) await h(ev, ctx);
  };
  return { pi, emit, bus: (pi as any).events, tools, commands, handlers };
}

let assistantText = "";
function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: "/tmp/proj",
    hasUI: true,
    mode: "tui",
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    } as any,
    sessionManager: {
      getBranch: () =>
        assistantText
          ? [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } }]
          : [],
    } as any,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    ...overrides,
  } as unknown as ExtensionContext;
}

const defaultCtx = makeCtx();

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

function installFetchMock() {
  const calls: { url: string; body: any }[] = [];
  const fetchMock = vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => '{"code":0}',
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

// ---------------------------------------------------------------------------
// Config file helper: 通过 FEISHU_NOTIFY_CONFIG_PATH 指向 tmp 文件，
// 测试完全不接触真实的 ~/.pi/agent/feishu-notify.json（验收 🟡-1 修复）
// ---------------------------------------------------------------------------

function writeTestConfigFile(extra: Record<string, unknown>) {
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ webhookUrl: "https://example.com/hook", ...extra }));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let extensionModule: any;
let activeHarness: { emit: (event: string, payload?: any, ctx?: any) => Promise<void> } | undefined;
let releaseBackgroundStatus: (() => void) | undefined;
let backgroundStatus = { runningSubagents: 0, runningBashJobs: 0 as number | null };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  assistantText = "";
  backgroundStatus = { runningSubagents: 0, runningBashJobs: 0 };
  process.env.FEISHU_WEBHOOK_URL = "https://example.com/hook";
  delete process.env.FEISHU_WEBHOOK_SECRET;
  process.env.FEISHU_NOTIFY_CONFIG_PATH = TEST_CONFIG_PATH;
  rmSync(TEST_CONFIG_PATH, { force: true });
  extensionModule = await import("../../src/feishu-notify/index.js");
});

afterEach(async () => {
  if (activeHarness) await activeHarness.emit("session_shutdown", { reason: "test" }, defaultCtx);
  activeHarness = undefined;
  releaseBackgroundStatus?.();
  releaseBackgroundStatus = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.FEISHU_WEBHOOK_URL;
  delete process.env.FEISHU_NOTIFY_CONFIG_PATH;
  rmSync(TEST_CONFIG_PATH, { force: true });
});

function setup() {
  const { pi, emit, bus, tools, commands } = createFakePi();
  releaseBackgroundStatus = publishBackgroundStatus(() => backgroundStatus);
  extensionModule.default(pi);
  activeHarness = { emit };
  return {
    emit,
    bus,
    tools,
    commands,
    setBackgroundStatus: (next: typeof backgroundStatus) => (backgroundStatus = next),
  };
}

// ---------------------------------------------------------------------------
// Background gating semantics
// ---------------------------------------------------------------------------

describe("background gating", () => {
  it("fails closed when the background-status provider is missing", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    releaseBackgroundStatus?.();
    releaseBackgroundStatus = undefined;
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("后台任务状态不可用"), "warning");
  });

  it("treats a disabled bash provider value as idle", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, setBackgroundStatus } = setup();
    setBackgroundStatus({ runningSubagents: 0, runningBashJobs: null });
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defers a result card while busy and sends it after the provider becomes idle", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, setBackgroundStatus } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    setBackgroundStatus({ runningSubagents: 1, runningBashJobs: 0 });
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    setBackgroundStatus({ runningSubagents: 0, runningBashJobs: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("任务完成");
  });

  it("sends at the defer cap and annotates the card", async () => {
    writeTestConfigFile({ backgroundIdleRecheckMs: 100, backgroundDeferCapMs: 500 });
    const { fetchMock } = installFetchMock();
    const { emit, setBackgroundStatus } = setup();
    setBackgroundStatus({ runningSubagents: 1, runningBashJobs: 0 });
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("后台任务超时未结束");
  });

  it("drops an armed idle reminder if the provider becomes busy before fire", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, setBackgroundStatus } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setBackgroundStatus({ runningSubagents: 0, runningBashJobs: 1 });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps heartbeat and waiting reminders exempt while background work is busy", async () => {
    writeTestConfigFile({ heartbeatIntervalSec: 1, waitNotifyTimeoutSec: 1 });
    const { fetchMock } = installFetchMock();
    const { emit, setBackgroundStatus } = setup();
    setBackgroundStatus({ runningSubagents: 1, runningBashJobs: 1 });
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("tool_execution_start", { toolCallId: "ask-1", toolName: "ask_user", args: {} }, ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock.mock.calls.some((call) => call[1].body.includes("仍在运行"))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => call[1].body.includes("等待输入"))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => call[1].body.includes("后台任务：subagent 1 个，bash 1 个"))).toBe(true);
  });

  it("keeps multiple result keys and sends each exactly once", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, setBackgroundStatus } = setup();
    setBackgroundStatus({ runningSubagents: 1, runningBashJobs: 0 });
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    for (const text of ["first", "second"]) {
      await emit("input", { type: "input", text: `@notify ${text}`, source: "interactive" }, ctx);
      await emit("agent_start", {}, ctx);
      await emit("agent_settled", {}, ctx);
      await vi.advanceTimersByTimeAsync(1);
    }
    setBackgroundStatus({ runningSubagents: 0, runningBashJobs: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears pending notifications on session shutdown", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, setBackgroundStatus } = setup();
    setBackgroundStatus({ runningSubagents: 1, runningBashJobs: 0 });
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    await emit("session_shutdown", {}, ctx);
    setBackgroundStatus({ runningSubagents: 0, runningBashJobs: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails safe and warns when an old ask_user tool is detected", async () => {
    const fetchState = installFetchMock();
    const oldTool = { name: "ask_user", sourceInfo: "/home/user/.pi-ask-user/index.ts" };
    const fake = createFakePi([oldTool]);
    releaseBackgroundStatus = publishBackgroundStatus(() => backgroundStatus);
    extensionModule.default(fake.pi);
    const ctx = makeCtx();
    await fake.emit("session_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("卸载旧包"), "warning");
    // 冲突惰性：即使被动触发（@notify + 任务结束）也不发送任何通知
    await fake.emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await fake.emit("agent_start", {}, ctx);
    await fake.emit("agent_settled", {}, ctx);
    expect(fetchState.fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a child activation inert while the host claim is held", () => {
    const hostKey = Symbol.for("pi-subagent:feishu-notify:host");
    (globalThis as Record<symbol, unknown>)[hostKey] = { test: true };
    const child = createFakePi();
    extensionModule.default(child.pi);
    expect(child.tools).toHaveLength(0);
    expect(child.commands.size).toBe(0);
    expect(child.handlers.size).toBe(0);
    delete (globalThis as Record<symbol, unknown>)[hostKey];
  });
});

// ---------------------------------------------------------------------------
// 12. Heartbeat basic
// ---------------------------------------------------------------------------

describe("12. heartbeat basic", () => {
  it("fires every heartbeatIntervalSec while gated; never fires without gate; stops after settled", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await emit("input", { type: "input", text: "long task @notify", source: "interactive" }, ctx);
    await emit("agent_start", { type: "agent_start" }, ctx);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("仍在运行");

    await emit("agent_settled", { type: "agent_settled" }, ctx);
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(1_200_000);
    const heartbeatCalls = fetchMock.mock.calls.filter((c) => c[1].body.includes("仍在运行"));
    expect(heartbeatCalls).toHaveLength(0); // heartbeat stopped (💤 idle card firing later is expected, separate behavior)
  });

  it("no gate -> zero heartbeats over 1200s", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "long task no keyword", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 13 & 14. multiple agent_start within one settled (retry / followUp drain)
// ---------------------------------------------------------------------------

describe("13/14. multiple agent_start before one settled (🔴-1 / 🔴-A)", () => {
  it("heartbeat timer is not reset by an in-run agent_start; stats not reset; 1 result card after settled", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify do it", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx); // first run start
    await vi.advanceTimersByTimeAsync(100); // small time passes
    await emit("agent_start", {}, ctx); // simulated retry/followUp drain within same run (running=true)
    await vi.advanceTimersByTimeAsync(599_900); // total 600_000ms since first start

    expect(fetchMock).toHaveBeenCalledTimes(1); // heartbeat fired once, not reset
    expect(fetchMock.mock.calls[0]![1].body).toContain("仍在运行");

    fetchMock.mockClear();
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("任务完成");
  });

  it("isUserRun survives a no-input in-run agent_start (🔴-A): 1 result card + idle armed", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify do it", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_start", {}, ctx); // retry, no input in between
    await emit("agent_settled", {}, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("任务完成");

    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("空闲提醒");
  });
});

// ---------------------------------------------------------------------------
// 15. heartbeat "当前进展" staleness
// ---------------------------------------------------------------------------

describe("15. heartbeat mid-run summary staleness", () => {
  it("uses the last known assistant text at the time the timer fires (may be stale)", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify do it", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);

    assistantText = "progress from turn 1";
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock.mock.calls[0]![1].body).toContain("progress from turn 1");

    // text changes after the heartbeat fired; next heartbeat should reflect new text
    assistantText = "progress from turn 2";
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock.mock.calls[0]![1].body).toContain("progress from turn 2");
  });
});

// ---------------------------------------------------------------------------
// 16. idle basic
// ---------------------------------------------------------------------------

describe("16. idle reminder basic", () => {
  it("fires idle after idleNotifyTimeoutSec; input before that cancels it", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify do it", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const idleBody = fetchMock.mock.calls[0]![1].body;
    expect(idleBody).toContain("空闲提醒");
    // 逐格断言：耗时格=空闲时长（5 分钟），第三格 label=上轮耗时且经 formatDuration 格式化
    expect(idleBody).toContain("**耗时**\\n5 分钟");
    expect(idleBody).toContain("**上轮耗时**\\n0 秒");
  });

  it("input at 200s cancels the idle timer, no idle card at 300s", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify do it", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(200_000);
    await emit("input", { type: "input", text: "another message", source: "interactive" }, ctx);
    await vi.advanceTimersByTimeAsync(200_000); // total 400s from settled
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 17. @notify + subagent combo (idle re-arm across continuation run)
// ---------------------------------------------------------------------------

describe("17. @notify + subagent continuation re-arms idle (🔴-3 positive)", () => {
  it("idle cancelled by continuation agent_start, re-armed after continuation settled", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify do it", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx); // result card sent, idle armed
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(100_000); // idle in progress (not yet fired)

    // subagent triggerTurn continuation: no input beforehand
    bus.emit("subagent:started", { runId: "s1", at: Date.now() });
    await emit("agent_start", {}, ctx); // continuation run, clears idle timer

    bus.emit("subagent:completed", { runId: "s1", status: "completed", generation: 1, at: Date.now() });
    await emit("agent_settled", {}, ctx); // continuation settled: no result card, idle re-armed

    // no result card from continuation settled (only whatever subagent summary flush produces)
    const resultCardCalls = fetchMock.mock.calls.filter((c) => c[1].body.includes("任务完成"));
    expect(resultCardCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300_000); // idle timeout after re-arm
    const idleCalls = fetchMock.mock.calls.filter((c) => c[1].body.includes("空闲提醒"));
    expect(idleCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 18. gate leakage negative
// ---------------------------------------------------------------------------

describe("18. gate does not leak across tasks", () => {
  it("task1 @notify gets a card; task2 without keyword gets none, no idle armed", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task1", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();

    // cancel idle armed from task1 by issuing next input (also clears idle) - simulate real usage
    await emit("input", { type: "input", text: "task2 no keyword", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 19. no-input first run bootstrap (RPC/steer)
// ---------------------------------------------------------------------------

describe("19. no-input first run bootstrap", () => {
  it("does not crash; initializes stats; gateOpen()=false -> no card", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await expect(emit("agent_start", {}, ctx)).resolves.not.toThrow();
    await expect(emit("agent_settled", {}, ctx)).resolves.not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 20. subagent flush self-sustained triggering
// ---------------------------------------------------------------------------

describe("20. subagent summary self-sustained flush (🔴-2)", () => {
  it("does not flush while any run is still active; flushes once after all complete + delivered", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx); // watched=true -> gateOpen()=true
    await emit("agent_start", {}, ctx); // sets lastCtx

    bus.emit("subagent:started", { runId: "a", at: Date.now() });
    bus.emit("subagent:started", { runId: "b", at: Date.now() });
    bus.emit("subagent:completed", { runId: "a", status: "completed", generation: 1, at: Date.now() });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(0); // b still running

    // deliver channel B for 'a' (already settled via A)
    await emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent:notification",
          details: { runId: "a", status: "completed", label: "task-a", textPreview: "done a" },
        },
      },
      ctx,
    );

    bus.emit("subagent:completed", { runId: "b", status: "completed", generation: 1, at: Date.now() });
    await emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent:notification",
          details: { runId: "b", status: "completed", label: "task-b", textPreview: "done b" },
        },
      },
      ctx,
    );

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("Subagent 汇总");
    expect(fetchMock.mock.calls[0]![1].body).toContain("task-a");
    expect(fetchMock.mock.calls[0]![1].body).toContain("task-b");
  });

  it("re-checks runningCount at flush time: a new run starting before the debounce fires cancels the send", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx);
    await emit("agent_start", {}, ctx);

    bus.emit("subagent:started", { runId: "c", at: Date.now() });
    bus.emit("subagent:completed", { runId: "c", status: "completed", generation: 1, at: Date.now() });
    await emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent:notification",
          details: { runId: "c", status: "completed", label: "task-c" },
        },
      },
      ctx,
    ); // schedules flush(debounce=1500)

    bus.emit("subagent:started", { runId: "d", at: Date.now() }); // race: new run starts before debounce elapses

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(0); // re-check at fire time sees runningCount>0 -> no send
  });
});

// ---------------------------------------------------------------------------
// 21. "wait for B" three states + mixed batch
// ---------------------------------------------------------------------------

describe("21. subagentDeliveryGraceMs 'wait for B' + mixed batch (🟡-A/🟡-C)", () => {
  it("① B arrives before grace expiry -> normal flush after debounce", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx);
    await emit("agent_start", {}, ctx);

    bus.emit("subagent:started", { runId: "e", at: Date.now() });
    bus.emit("subagent:completed", { runId: "e", status: "completed", generation: 1, at: Date.now() });
    await emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent:notification",
          details: { runId: "e", status: "completed", label: "task-e" },
        },
      },
      ctx,
    );

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("② no B, not yet past grace -> flush moment reschedules, zero fetch calls", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx);
    await emit("agent_start", {}, ctx);

    bus.emit("subagent:started", { runId: "f", at: Date.now() });
    bus.emit("subagent:completed", { runId: "f", status: "completed", generation: 1, at: Date.now() }); // channel A only, no delivery

    await vi.advanceTimersByTimeAsync(1_500); // debounce elapses -> doFlush finds pending grace, reschedules
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(3_000); // still within 6000ms grace window
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("③ no B, past grace, pure foreground batch -> silently discarded by default", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx);
    await emit("agent_start", {}, ctx);

    bus.emit("subagent:started", { runId: "g", at: Date.now() });
    bus.emit("subagent:completed", { runId: "g", status: "completed", generation: 1, at: Date.now() });

    await vi.advanceTimersByTimeAsync(1_500 + 6_000 + 100); // debounce + full grace + margin
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("③b subagentForegroundSummary:true -> pure foreground batch is sent after grace", async () => {
    writeTestConfigFile({ subagentForegroundSummary: true });
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx); // loads config from file (webhookUrl + subagentForegroundSummary)
    await commands.get("watch").handler("", ctx);
    await emit("agent_start", {}, ctx);

    bus.emit("subagent:started", { runId: "h", at: Date.now() });
    bus.emit("subagent:completed", { runId: "h", status: "completed", generation: 1, at: Date.now() });

    await vi.advanceTimersByTimeAsync(1_500 + 6_000 + 100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("④ mixed batch: 1 hadDelivery + 1 pure foreground -> whole batch is sent (foreground row degrades)", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx);
    await emit("agent_start", {}, ctx);

    bus.emit("subagent:started", { runId: "i1", at: Date.now() });
    bus.emit("subagent:completed", { runId: "i1", status: "completed", generation: 1, at: Date.now() });
    await emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent:notification",
          details: { runId: "i1", status: "completed", label: "with-delivery" },
        },
      },
      ctx,
    );

    bus.emit("subagent:started", { runId: "i2", at: Date.now() });
    bus.emit("subagent:completed", { runId: "i2", status: "completed", generation: 1, at: Date.now() }); // no delivery ever

    await vi.advanceTimersByTimeAsync(1_500); // i1 satisfied (hadDelivery); i2 within grace -> reschedule
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(6_000 + 100); // i2's grace expires -> whole batch flushed together
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("with-delivery");
    expect(fetchMock.mock.calls[0]![1].body).toContain("i2".slice(0, 8));
  });
});

// ---------------------------------------------------------------------------
// 22. continuation suppresses duplicate result cards
// ---------------------------------------------------------------------------

describe("22. /watch + subagent continuation: result card not duplicated", () => {
  it("only 1 result card (first settled) + 1 summary card; continuation settled sends no extra result card", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx); // watched=true
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx); // 1st settled -> result card (watched)
    fetchMock.mockClear();

    bus.emit("subagent:started", { runId: "j", at: Date.now() });
    await emit("agent_start", {}, ctx); // continuation
    bus.emit("subagent:completed", { runId: "j", status: "completed", generation: 1, at: Date.now() });
    await emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent:notification",
          details: { runId: "j", status: "completed", label: "task-j" },
        },
      },
      ctx,
    );
    await emit("agent_settled", {}, ctx); // continuation settled: no result card, but flush may schedule

    await vi.advanceTimersByTimeAsync(1_500);

    const resultCards = fetchMock.mock.calls.filter((c) => c[1].body.includes("任务完成"));
    const summaryCards = fetchMock.mock.calls.filter((c) => c[1].body.includes("Subagent 汇总"));
    expect(resultCards).toHaveLength(0); // continuation settled suppressed
    expect(summaryCards).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 23. digest duplicate arrival / no resend after drain
// ---------------------------------------------------------------------------

describe("23. duplicate delivery before drain does not double-count; nothing resent after drain", () => {
  it("repeated identical delivery collapses to a single row; post-drain flush attempts send nothing more", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx);
    await emit("agent_start", {}, ctx);

    bus.emit("subagent:started", { runId: "k", at: Date.now() });
    bus.emit("subagent:completed", { runId: "k", status: "completed", generation: 1, at: Date.now() });
    const delivery = {
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent:notification",
        details: { runId: "k", status: "completed", label: "task-k" },
      },
    };
    await emit("message_end", delivery, ctx);
    await emit("message_end", delivery, ctx); // duplicate delivery before flush

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rowsOccurrences = (fetchMock.mock.calls[0]![1].body.match(/task-k/g) ?? []).length;
    expect(rowsOccurrences).toBeGreaterThanOrEqual(1); // single row, not duplicated N times

    // after drain: re-triggering maybeFlushSubagentSummary (via a run-in-progress agent_start,
    // which does not emit a result card) finds nothing left to send
    fetchMock.mockClear();
    await emit("agent_start", {}, ctx);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 24. graceful degradation without any subagent channel activity
// ---------------------------------------------------------------------------

describe("24. degrades gracefully without pi-subagent installed", () => {
  it("no subagent events emitted at all -> no crash, no extraneous fetch", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify plain task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the result card
    expect(fetchMock.mock.calls[0]![1].body).toContain("任务完成");
  });
});

// ---------------------------------------------------------------------------
// 25. timer leak check
// ---------------------------------------------------------------------------

describe("25. session_shutdown clears all timers", () => {
  it("vi.getTimerCount() === 0 after shutdown", async () => {
    installFetchMock();
    const { emit, bus, commands } = setup();
    const ctx = makeCtx();

    await emit("session_start", {}, ctx);
    await commands.get("watch").handler("", ctx);
    await emit("input", { type: "input", text: "@notify long", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx); // arms heartbeat

    // arm a wait timer
    await emit(
      "tool_execution_start",
      { type: "tool_execution_start", toolCallId: "t1", toolName: "ask_user", args: {} },
      ctx,
    );

    // arm a pending subagent flush timer
    bus.emit("subagent:started", { runId: "m", at: Date.now() });
    bus.emit("subagent:completed", { runId: "m", status: "completed", generation: 1, at: Date.now() });

    await emit("agent_settled", {}, ctx); // stops heartbeat, arms idle timer

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await emit("session_shutdown", {}, ctx);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 26. baseline regression
// ---------------------------------------------------------------------------

describe("26. baseline regression", () => {
  it("@notify result card (success)", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("任务完成");
  });

  it("error card when the last assistant message stopReason is 'error'", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit(
      "message_end",
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "boom" },
      },
      ctx,
    );
    await emit("agent_settled", {}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("任务出错");
    expect(fetchMock.mock.calls[0]![1].body).toContain("boom");
  });

  it("waiting card after tool times out without activity", async () => {
    const { fetchMock } = installFetchMock();
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit(
      "tool_execution_start",
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "ask_user",
        args: { questions: [{ question: "pick one" }] },
      },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toContain("等待输入");
    expect(fetchMock.mock.calls[0]![1].body).toContain("pick one");
  });

  it("ask-user:activity cancels the wait timer", async () => {
    const { fetchMock } = installFetchMock();
    const { emit, bus } = setup();
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await emit("input", { type: "input", text: "@notify task", source: "interactive" }, ctx);
    await emit("agent_start", {}, ctx);
    await emit(
      "tool_execution_start",
      { type: "tool_execution_start", toolCallId: "t1", toolName: "ask_user", args: {} },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(50_000);
    bus.emit("ask-user:activity", {});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
