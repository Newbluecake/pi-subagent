import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { buildSessionStack } from "../../src/stack.js";
import { FLEET_WIDGET_KEY } from "../../src/ui/fleet-widget.js";

/**
 * Zombie-widget regression: pi's /reload re-imports this extension as a
 * FRESH module (jiti moduleCache:false), so the module-level
 * previousFleetWidget handoff in buildSessionStack never sees the pre-reload
 * controller. The stale ctx.ui closures keep working after reload (setWidget
 * has no assertActive), so an undisposed FleetWidgetController's
 * self-rescheduling 1Hz tick outlives its session forever — pushing
 * setWidget(undefined) over the new session's frames and blinking the agent
 * tree off/on once per zombie per second. The fix: Stack exposes the widget
 * and session_shutdown disposes it. These tests pin the two halves of that
 * contract: buildSessionStack EXPOSES the controller, and dispose() both
 * clears the widget and stops the tick.
 */

function fakePi() {
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: () => undefined,
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return pi as unknown as ExtensionAPI;
}

function fakeCtx(ui: unknown): ExtensionContext {
  return {
    sessionManager: { getEntries: () => [], getSessionId: () => "session-under-test" },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui,
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
}

const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;

function settings(fleetWidget: boolean): AgentSettings {
  return { ...DEFAULT_SETTINGS, fleetWidget };
}

interface WidgetCall {
  key: string;
  content: string[] | undefined;
}

function recordingUi() {
  const calls: WidgetCall[] = [];
  return {
    calls,
    ui: {
      setWidget(key: string, content: string[] | undefined) {
        calls.push({ key, content });
      },
    },
  };
}

describe("fleet widget session lifecycle (zombie-after-reload regression)", () => {
  it("buildSessionStack exposes the controller as stack.fleetWidget so session_shutdown can dispose it", () => {
    const { ui } = recordingUi();
    const stack = buildSessionStack(fakePi(), fakeCtx(ui), settings(true), types, []);
    try {
      expect(stack.fleetWidget).toBeDefined();
    } finally {
      stack.fleetWidget?.dispose();
      stack.bashJobs?.dispose();
    }
  });

  it("stack.fleetWidget is absent when settings.fleetWidget is off", () => {
    const { ui } = recordingUi();
    const stack = buildSessionStack(fakePi(), fakeCtx(ui), settings(false), types, []);
    expect(stack.fleetWidget).toBeUndefined();
    stack.bashJobs?.dispose();
  });

  it("dispose (what session_shutdown calls) hides the widget and stops the tick — no zombie frames", async () => {
    const { ui, calls } = recordingUi();
    const stack = buildSessionStack(fakePi(), fakeCtx(ui), settings(true), types, []);
    stack.bashJobs?.dispose();
    const before = calls.length;
    stack.fleetWidget!.dispose();
    // The hide push is synchronous…
    expect(calls.length).toBeGreaterThan(before);
    expect(calls[calls.length - 1]).toEqual({ key: FLEET_WIDGET_KEY, content: undefined });
    // …and no tick fires afterwards (1Hz self-rescheduling timer is dead).
    const settled = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(calls.length).toBe(settled);
  });

  it("a rebuild disposes the previous session's widget — old stack closures cannot push frames (R-13)", () => {
    const { ui, calls } = recordingUi();
    const stack1 = buildSessionStack(fakePi(), fakeCtx(ui), settings(true), types, []);
    // /reload 等价物：第二个 buildSessionStack 在顶部 dispose 前一个 stack 的 widget
    // （previousFleetWidget 交接）。timeout-notify 的 sendDeadlineNotice 同为
    // buildSessionStack 闭包——这里钉死的是同一机制：旧 stack 的 UI 推送全部失能。
    const stack2 = buildSessionStack(fakePi(), fakeCtx(ui), settings(true), types, []);
    try {
      const settled = calls.length;
      stack1.fleetWidget!.refresh(); // disposed ⇒ inert no-op
      expect(calls.length).toBe(settled);
      stack2.fleetWidget!.refresh(); // alive ⇒ pushes a frame
      expect(calls.length).toBeGreaterThan(settled);
    } finally {
      stack2.fleetWidget?.dispose();
      stack2.bashJobs?.dispose();
    }
  });
});
