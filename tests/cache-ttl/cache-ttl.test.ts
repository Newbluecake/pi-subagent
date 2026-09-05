import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { DEFAULT_SETTINGS, loadSettings, parseCacheTtlSettings } from "../../src/config/settings.js";

function setup(mode: "auto" | "on" | "off" = "auto", persist = vi.fn()) {
  const hooks = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerCommand: (name: string, value: any) => commands.set(name, value),
  } as unknown as ExtensionAPI;
  const notify = vi.fn();
  const status = vi.fn();
  const ctx = { ui: { notify, setStatus: status } } as unknown as ExtensionContext;
  wireCacheTtl(pi, { ...DEFAULT_SETTINGS, cacheTtl: { mode } }, { persist });
  return { hooks, commands, ctx, notify, status, persist };
}

describe("cache TTL settings", () => {
  it("parses only whitelisted modes", () => {
    expect(parseCacheTtlSettings({ mode: "on", extra: true })).toEqual({ mode: "on" });
    for (const input of [undefined, null, [], "on", { mode: "bad" }, { mode: 1 }])
      expect(parseCacheTtlSettings(input)).toEqual({ mode: "auto" });
    expect(loadSettings({ cacheTtl: { mode: "off", extra: true } }).cacheTtl).toEqual({ mode: "off" });
  });

  it("rewrites nested ephemeral controls without mutating the request", () => {
    const { hooks } = setup("on");
    const shared = { cache_control: { type: "ephemeral" } };
    const payload: any = { messages: [{ content: [{ ...shared, system: shared }] }], tools: [{ x: shared }] };
    const original = structuredClone(payload);
    const result: any = hooks.get("before_provider_request")!({ payload }, {});
    expect(result.messages[0].content[0].cache_control.ttl).toBe("1h");
    expect(result.messages[0].content[0].system.cache_control.ttl).toBe("1h");
    expect(result.tools[0].x.cache_control.ttl).toBe("1h");
    expect(payload).toEqual(original);
  });

  it("handles off, auto, malformed payloads, and cycles", () => {
    const off = setup("off");
    const cycle: any = { messages: [], nested: { cache_control: { type: "ephemeral", ttl: "1h" } } };
    cycle.nested.cycle = cycle;
    const result = off.hooks.get("before_provider_request")!({ payload: cycle }, {});
    expect((result as any).nested.cache_control.ttl).toBeUndefined();
    for (const payload of [undefined, null, [], "x", 1, { messages: "x" }])
      expect(off.hooks.get("before_provider_request")!({ payload }, {})).toBeUndefined();
    expect(setup("auto").hooks.get("before_provider_request")!({ payload: cycle }, {})).toBeUndefined();
  });

  it("leaves malformed cache_control variants untouched", () => {
    const { hooks } = setup("on");
    const payload: any = {
      messages: [
        { a: { cache_control: null }, b: { cache_control: [1] }, c: { cache_control: "x" } },
        { d: { cache_control: { type: "other" } }, e: { cache_control: { type: "ephemeral" } } },
      ],
    };
    const result: any = hooks.get("before_provider_request")!({ payload }, {});
    expect(result.messages[0].a.cache_control).toBeNull();
    expect(result.messages[0].b.cache_control).toEqual([1]);
    expect(result.messages[0].c.cache_control).toBe("x");
    expect(result.messages[1].d.cache_control).toEqual({ type: "other" });
    expect(result.messages[1].e.cache_control.ttl).toBe("1h");
  });

  it("returns undefined and warns when the payload cannot be cloned", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { hooks } = setup("on");
    const payload: any = { messages: [], fn: () => undefined };
    expect(hooks.get("before_provider_request")!({ payload }, {})).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("tracks the dirty matrix and status bar across switches and saves", async () => {
    const persist = vi.fn().mockReturnValue(undefined);
    const state = setup("on", persist);
    const cmd = state.commands.get("cache-ttl");
    await cmd.handler("off", state.ctx);
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "⏱ cache: 5m*");
    await cmd.handler("on", state.ctx); // 回到持久化值 → clean
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "⏱ cache: 1h");
    await cmd.handler("auto", state.ctx);
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", undefined);
    await cmd.handler("on", state.ctx); // auto → on：又回到持久化值 → clean
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "⏱ cache: 1h");
    await cmd.handler("save", state.ctx); // clean 时不落盘
    expect(persist).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenLastCalledWith("没有未保存的更改", "info");
    await cmd.handler("off", state.ctx);
    await cmd.handler("save", state.ctx);
    expect(persist).toHaveBeenCalledWith("off");
    expect(state.status).toHaveBeenLastCalledWith("cache-ttl", "⏱ cache: 5m"); // 保存后无 *
  });

  it("shows both runtime and persisted modes when dirty and warns on bad args", async () => {
    const state = setup("on");
    const cmd = state.commands.get("cache-ttl");
    await cmd.handler("off", state.ctx);
    await cmd.handler("", state.ctx);
    expect(state.notify).toHaveBeenLastCalledWith(expect.stringContaining("持久化模式"), "info");
    expect(state.notify.mock.calls.at(-1)![0]).toContain("save");
    await cmd.handler("bogus", state.ctx);
    expect(state.notify).toHaveBeenLastCalledWith(expect.stringContaining("无效参数"), "warning");
  });

  it("keeps changes in memory until `/cache-ttl save` and retains dirty state on failure", async () => {
    const persist = vi.fn().mockReturnValue(undefined);
    const state = setup("on", persist);
    await state.commands.get("cache-ttl").handler("off", state.ctx);
    expect(persist).not.toHaveBeenCalled();
    await state.commands.get("cache-ttl").handler("save", state.ctx);
    expect(persist).toHaveBeenCalledWith("off");
    const failing = setup("on", vi.fn().mockReturnValue("disk full"));
    await failing.commands.get("cache-ttl").handler("off", failing.ctx);
    await failing.commands.get("cache-ttl").handler("save", failing.ctx);
    expect(failing.notify).toHaveBeenLastCalledWith(expect.stringContaining("disk full"), "error");
    await failing.commands.get("cache-ttl").handler("save", failing.ctx);
    expect(failing.persist).toHaveBeenCalledTimes(2);
  });
});
