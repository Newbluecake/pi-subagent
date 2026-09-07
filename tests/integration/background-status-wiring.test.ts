import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { readBackgroundStatus } from "../../src/service/background-status.js";

const HOST_KEY = Symbol.for("pi-subagent:host");
const STATUS_KEY = Symbol.for("pi-subagent:background-status");

function fakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: () => undefined,
    registerEntryRenderer: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    emit: async (event: string, payload: unknown = {}, ctx: unknown = sessionContext) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

const sessionContext = {
  cwd: process.cwd(),
  hasUI: false,
  mode: "interactive",
  sessionManager: {
    getEntries: () => [],
    getBranch: () => [],
    getSessionId: () => "background-status-wiring",
  },
  modelRegistry: { getAvailable: () => [], find: () => undefined },
  ui: {},
} as unknown as ExtensionContext;

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[STATUS_KEY];
});

describe("background-status host wiring", () => {
  it("publishes live status through activate/session_start and replaces it after shutdown", async () => {
    const first = fakePi();
    activate(first.pi);
    await first.emit("session_start");
    const provider = (globalThis as Record<symbol, unknown>)[STATUS_KEY];
    expect(provider).toBeDefined();
    expect(readBackgroundStatus()).toMatchObject({ runningSubagents: 0, runningBashJobs: expect.anything() });

    await first.emit("session_shutdown", { reason: "reload" });
    expect(readBackgroundStatus()).toBeUndefined();

    const second = fakePi();
    activate(second.pi);
    await second.emit("session_start");
    expect((globalThis as Record<symbol, unknown>)[STATUS_KEY]).not.toBe(provider);
    expect(readBackgroundStatus()?.runningSubagents).toBe(0);
    await second.emit("session_shutdown", { reason: "test" });
  });

  it("reports null bash status when bash jobs are disabled", async () => {
    const host = fakePi();
    activate(host.pi);
    await host.emit("session_start");
    const status = readBackgroundStatus();
    expect(status?.runningSubagents).toBe(0);
    // The default test settings keep bash jobs disabled when the host cannot
    // construct a session manager-backed job directory.
    expect(status?.runningBashJobs === null || status?.runningBashJobs === 0).toBe(true);
    await host.emit("session_shutdown", { reason: "test" });
  });
});
