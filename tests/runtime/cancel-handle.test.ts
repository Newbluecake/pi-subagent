import { describe, expect, it, vi } from "vitest";
import { createCancelHandle } from "../../src/runtime/runner.js";

describe("createCancelHandle", () => {
  it("propagates an external abort to the internal signal and callback", async () => {
    const external = new AbortController();
    const onCancel = vi.fn();
    const handle = createCancelHandle("run-1", 1, external.signal, onCancel);
    external.abort();
    expect(handle.signal.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledWith("external");
    await expect(handle.whenCancelled).rejects.toThrow("external");
  });

  it("does not propagate an external abort after detach", () => {
    const external = new AbortController();
    const onCancel = vi.fn();
    const handle = createCancelHandle("run-1", 1, external.signal, onCancel);
    handle.detach();
    external.abort();
    expect(handle.signal.aborted).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
