import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate, { mentionAutocompleteEntries } from "../../src/index.js";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { Stack } from "../../src/stack.js";

/**
 * D-M7/B2 wiring coverage:
 *  - the session_start handler registers an autocomplete wrapper EVERY time
 *    (no module-level once guard — pi's resetExtensionUI clears wrappers on
 *    /reload, so re-registration is required, not harmful);
 *  - the wrapper reads labels through the session holder at call time, so a
 *    rebuilt stack (reload/new session) is picked up without re-wrapping;
 *  - only root-direct labels are listed (v2 hard constraint, case ⑧).
 */
const HOST_KEY = Symbol.for("pi-subagent:host");

// session_start builds a BashJobManager rooted at the agent dir — run against
// a throwaway $HOME (same convention as system-prompt-injection.test.ts).
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;

type Handler = (event: unknown, ctx: unknown) => unknown;
type Factory = (current: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const pi = {
    registerTool() {},
    registerCommand(name: string, cmd: { handler(args: string, ctx: unknown): Promise<void> }) {
      commands.set(name, cmd);
    },
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
  return { pi, handlers, commands, emit };
}

function fakeCtx(wrappers: Factory[]) {
  return {
    hasUI: true,
    ui: {
      addAutocompleteProvider(factory: Factory) {
        wrappers.push(factory);
      },
    },
  };
}

/** Minimal Stack-shaped holder fixture: mention registry + query status. */
function fakeStack(
  targets: Record<string, { runId: string; type: string; parent?: string }>,
  statuses: Record<string, string>,
): Stack {
  return {
    mention: {
      labels: () => Object.keys(targets),
      resolve: (label: string) => targets[label],
    },
    query: { get: (runId: string) => (statuses[runId] ? { status: statuses[runId] } : undefined) },
  } as never;
}

describe("mentionAutocompleteEntries (root-direct filter + status mapping)", () => {
  it("⑧ lists only root-direct labels; nested labels and parent-less targets are excluded", () => {
    const holder = {
      current: fakeStack(
        {
          worker: { runId: "r1", type: "general", parent: "root" },
          nested: { runId: "r2", type: "general", parent: "r1" }, // nested run — must not be mentionable
          legacy: { runId: "r3", type: "general" }, // no parent field at all — excluded defensively
        },
        { r1: "running" },
      ),
    };
    const entries = mentionAutocompleteEntries(holder);
    expect(entries.map((e) => e.label)).toEqual(["worker"]);
    expect(entries[0]).toMatchObject({ runId: "r1", status: "running" });
  });

  it("maps terminal statuses to settled, unknown/absent to other", () => {
    const holder = {
      current: fakeStack(
        {
          a: { runId: "r1", type: "general", parent: "root" },
          b: { runId: "r2", type: "general", parent: "root" },
          c: { runId: "r3", type: "general", parent: "root" },
        },
        { r1: "completed", r2: "pending_start" },
      ),
    };
    const byLabel = Object.fromEntries(mentionAutocompleteEntries(holder).map((e) => [e.label, e.status]));
    expect(byLabel).toEqual({ a: "settled", b: "other", c: "other" });
  });

  it("reads through the holder at call time: a rebuilt stack (reload) is picked up", () => {
    const holder: { current?: Stack } = {
      current: fakeStack({ worker: { runId: "r1", type: "general", parent: "root" } }, { r1: "running" }),
    };
    expect(mentionAutocompleteEntries(holder).map((e) => e.label)).toEqual(["worker"]);
    // session rebuild swaps holder.current — no re-registration needed
    holder.current = fakeStack({ reviewer: { runId: "r9", type: "review", parent: "root" } }, { r9: "running" });
    expect(mentionAutocompleteEntries(holder).map((e) => e.label)).toEqual(["reviewer"]);
    holder.current = undefined;
    expect(mentionAutocompleteEntries(holder)).toEqual([]);
  });
});

describe("session_start autocomplete wrapper registration (B2 reload regression)", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("registers a wrapper on every session_start; post-reload completion still works", async () => {
    const { pi, emit } = fakePi();
    activate(pi as never);

    const wrappers: Factory[] = [];
    const ctx = fakeCtx(wrappers);
    await emit("session_start", {}, ctx);
    expect(wrappers).toHaveLength(1); // exactly one registration per session_start

    // simulate pi's resetExtensionUI(): /reload clears the wrapper list and
    // rebuilds the provider chain; the next session_start must re-register.
    wrappers.length = 0;
    await emit("session_start", {}, ctx);
    expect(wrappers).toHaveLength(1);

    // the post-reload factory produces a working provider layered over the base
    const base = new CombinedAutocompleteProvider([], process.cwd());
    const provider = wrappers[0]!(base) as {
      triggerCharacters?: string[];
      getSuggestions: (...args: unknown[]) => Promise<{ items: unknown[] } | null>;
    };
    expect(provider.triggerCharacters).toContain("@");
    const result = await provider.getSuggestions(["@"], 0, 1, {
      signal: new AbortController().signal,
      force: true,
    });
    // no labels registered in this harness ⇒ pure passthrough of the base result
    const baseOnly = await base.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal, force: true });
    expect(result).toEqual(baseOnly);

    await emit("session_shutdown", { reason: "reload" });
  });

  it("does not register when the host lacks addAutocompleteProvider (graceful degradation)", async () => {
    const { pi, emit } = fakePi();
    activate(pi as never);
    // must not throw with a bare/non-interactive ctx
    await emit("session_start", {}, {});
    await emit("session_start", {}, { hasUI: true, ui: {} });
    await emit("session_shutdown", { reason: "quit" });
  });

  it("/agent status gains the Mentionable labels section", async () => {
    const { pi, commands, emit } = fakePi();
    activate(pi as never);
    await emit("session_start", {}, {});
    const notifications: string[] = [];
    await commands.get("agent")!.handler("status", {
      ui: { notify: (text: string) => notifications.push(text) },
    });
    expect(notifications.join("\n")).toContain("Mentionable labels: 0");
    await emit("session_shutdown", { reason: "quit" });
  });
});
