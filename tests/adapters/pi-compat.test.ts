import { describe, expect, it } from "vitest";
import { assertCompatible, detectPiCapabilities, probeReadBackEntries } from "../../src/adapters/pi-compat.js";

describe("pi-compat gate", () => {
  it("passes when the load-time ExtensionAPI lacks sessionManager (real pi behavior)", () => {
    // Regression: gating on sessionManager.getEntries at load time disabled
    // the whole extension on real pi, where sessionManager only exists on
    // the session_start ctx.
    const caps = detectPiCapabilities({ sendMessage() {}, appendEntry() {}, events: { on() {}, emit() {} } }, "0.84.4");
    expect(caps.canReadBackEntries).toBe(false);
    const result = assertCompatible(caps);
    expect(result.ok).toBe(true);
  });

  it("rejects when a load-time-critical capability is missing", () => {
    expect(assertCompatible(detectPiCapabilities({ appendEntry() {}, events: { on() {}, emit() {} } }))).toMatchObject({
      ok: false,
    });
    expect(assertCompatible(detectPiCapabilities({ sendMessage() {}, events: { on() {}, emit() {} } }))).toMatchObject({
      ok: false,
    });
    expect(assertCompatible(detectPiCapabilities({ sendMessage() {}, appendEntry() {} }))).toMatchObject({
      ok: false,
    });
  });

  it("warns (not rejects) outside the tested version range", () => {
    const caps = detectPiCapabilities({ sendMessage() {}, appendEntry() {}, events: { on() {}, emit() {} } }, "0.99.0");
    const result = assertCompatible(caps);
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty("warning");
  });

  it("probeReadBackEntries detects the session-start ctx shape", () => {
    expect(probeReadBackEntries({ sessionManager: { getEntries: () => [] } })).toBe(true);
    expect(probeReadBackEntries({ sessionManager: {} })).toBe(false);
    expect(probeReadBackEntries({})).toBe(false);
    expect(probeReadBackEntries(undefined)).toBe(false);
  });
});
