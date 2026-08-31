import { describe, expect, it, vi } from "vitest";
import { createRPCClient } from "../../src/rpc/client.js";
import { RPC_REQUEST_CHANNEL, RPC_VERSION, replyChannel } from "../../src/rpc/protocol.js";
import { createRPCServer } from "../../src/rpc/server.js";

class MemoryEvents {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly emitted: Array<{ channel: string; payload: unknown }> = [];
  on(channel: string, listener: (payload: unknown) => void) {
    const set = this.listeners.get(channel) ?? new Set();
    set.add(listener);
    this.listeners.set(channel, set);
    return () => set.delete(listener);
  }
  emit(channel: string, payload: unknown) {
    this.emitted.push({ channel, payload });
    for (const listener of this.listeners.get(channel) ?? []) listener(payload);
  }
}

function request(events: MemoryEvents, requestId: unknown, method: string, params: unknown) {
  events.emit(RPC_REQUEST_CHANNEL, { version: RPC_VERSION, requestId, method, params });
}

describe("cross-extension RPC", () => {
  it("answers ping without a ready event, including for a late consumer", async () => {
    const events = new MemoryEvents();
    createRPCServer({ events, spawn: { spawn: vi.fn() }, query: { get: vi.fn(), stop: vi.fn() } });
    const client = createRPCClient({ events, timeoutMs: 50, requestId: () => "ping-1" });
    await expect(client.ping()).resolves.toEqual({ version: RPC_VERSION, ready: true });
  });

  it("rejects invalid schema and never invokes a service", async () => {
    const events = new MemoryEvents();
    const spawn = vi.fn();
    createRPCServer({ events, spawn: { spawn }, query: { get: vi.fn(), stop: vi.fn() } });
    request(events, "bad-1", "spawn", { type: "worker", prompt: "run", unexpected: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawn).not.toHaveBeenCalled();
    expect(events.emitted.find((entry) => entry.channel === replyChannel("bad-1"))).toMatchObject({
      payload: { ok: false, error: { kind: "internal" } },
    });
  });

  it("drops missing and oversized request ids without emitting an undefined reply channel", async () => {
    const events = new MemoryEvents();
    const warn = vi.fn();
    createRPCServer({ events, warn, spawn: { spawn: vi.fn() }, query: { get: vi.fn(), stop: vi.fn() } });
    request(events, undefined, "ping", {});
    request(events, "x".repeat(129), "ping", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(events.emitted.every((entry) => !entry.channel.includes("undefined"))).toBe(true);
  });

  it("times out a caller when nobody answers", async () => {
    const events = new MemoryEvents();
    const client = createRPCClient({ events, timeoutMs: 10, requestId: () => "no-server" });
    await expect(client.ping()).rejects.toThrow("timed out after 10ms");
  });

  it("clamps extreme spawn budgets before calling the service", async () => {
    const events = new MemoryEvents();
    const spawn = vi.fn().mockResolvedValue({ runId: "run-1" });
    createRPCServer({ events, spawn: { spawn }, query: { get: vi.fn(), stop: vi.fn() } });
    request(events, "spawn-1", "spawn", {
      type: "worker",
      prompt: "run",
      budgetOverride: { totalMs: 0, startupMs: Number.MAX_SAFE_INTEGER },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ budgetOverride: { totalMs: 1, startupMs: 5 * 60_000 } }),
    );
  });

  it("does not leak internal stack details in a failed call", async () => {
    const events = new MemoryEvents();
    const client = createRPCClient({ events, timeoutMs: 50, requestId: () => "fail-1" });
    createRPCServer({
      events,
      spawn: { spawn: vi.fn().mockRejectedValue(new Error("secret implementation path")) },
      query: { get: vi.fn(), stop: vi.fn() },
    });
    const failure = await client.call("spawn", { type: "worker", prompt: "run" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ info: { kind: "internal", message: "secret implementation path" } });
    expect((failure as { info: { stack?: string } }).info).not.toHaveProperty("stack");
  });
});
