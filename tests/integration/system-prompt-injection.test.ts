import { afterEach, beforeEach, describe, expect, it } from "vitest";
import activate from "../../src/index.js";

/**
 * The model cannot discover valid `subagent_type` values on its own: an
 * unknown name comes back as `unknown agent type: <x>` and the turn is burned
 * on trial and error. activate() therefore hooks pi's before_agent_start and
 * appends the registry listing to the assembled system prompt.
 *
 * This guards the *wiring* (hook registered, reads the registry at event
 * time); the rendering itself is unit-tested in tests/config/agent-config.test.ts.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Mirrors pi's registration semantics: `on()` appends, every handler fires (loader.ts on()). */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage() {},
    appendEntry() {},
    events: { on() {}, emit() {} },
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const first = (event: string) => handlers.get(event)?.[0];
  return { pi, handlers, emit, first };
}

describe("wiring: available agent types are injected into the system prompt", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  });

  it("registers before_agent_start and appends the registry listing once types are loaded", async () => {
    const { pi, handlers, emit, first } = fakePi();
    activate(pi as never);

    const hook = first("before_agent_start");
    expect(hook, "before_agent_start must be hooked").toBeTypeOf("function");

    // Before any session_start the registry is empty → no override at all
    // (never hand pi a systemPrompt it did not ask us to change).
    expect(hook!({ systemPrompt: "BASE" }, {})).toBeUndefined();

    // session_start reloads the registry (built-ins always present).
    await emit("session_start");
    const result = hook!({ systemPrompt: "BASE" }, {}) as { systemPrompt: string };
    expect(result.systemPrompt.startsWith("BASE\n\n")).toBe(true);
    expect(result.systemPrompt).toContain("## Available subagent types (pi-subagent)");
    expect(result.systemPrompt).toContain("- general-purpose:");
    expect(handlers.has("session_shutdown")).toBe(true);

    await emit("session_shutdown", { reason: "exit" });
  });

  it("stays inert inside child sessions (HOST_KEY guard: no duplicate hook)", () => {
    const first = fakePi();
    activate(first.pi as never);
    const child = fakePi();
    activate(child.pi as never); // re-activation inside a spawned child session
    expect(child.handlers.has("before_agent_start")).toBe(false);
  });

  it("re-activates after /reload (the host claim is released on session_shutdown)", async () => {
    // Regression: pi's /reload emits session_shutdown on the old runner, then
    // re-imports the extension and calls activate() again in the SAME process.
    // A globalThis claim that outlived its activation made every post-reload
    // instance inert — no Agent tool, no /agent, no hooks — until pi restarted.
    const first = fakePi();
    activate(first.pi as never);
    expect(first.handlers.has("before_agent_start")).toBe(true);

    await first.emit("session_shutdown", { reason: "reload" });

    const reloaded = fakePi();
    activate(reloaded.pi as never);
    expect(reloaded.handlers.has("before_agent_start"), "post-reload instance must take over").toBe(true);

    // ...and the fresh instance owns the claim: a child session spawned after
    // the reload is still inert.
    const child = fakePi();
    activate(child.pi as never);
    expect(child.handlers.has("before_agent_start")).toBe(false);
  });

  it("a child session's shutdown cannot steal the host claim", async () => {
    const host = fakePi();
    activate(host.pi as never);
    const child = fakePi();
    activate(child.pi as never);
    expect(child.handlers.size, "inert child registers nothing at all").toBe(0);

    // Host still owns the claim, so a later activation stays inert.
    const another = fakePi();
    activate(another.pi as never);
    expect(another.handlers.has("before_agent_start")).toBe(false);
  });
});
