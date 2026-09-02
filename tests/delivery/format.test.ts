import { describe, expect, it } from "vitest";
import type { DeliveryPayload } from "../../src/core/types.js";
import { formatDigest, formatSingle } from "../../src/delivery/format.js";

const base = (key: string, label?: string): DeliveryPayload => ({
  key,
  runId: "run-123456789",
  generation: 1,
  status: "completed",
  textPreview: "done",
  ...(label ? { label } : {}),
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
});

describe("delivery formatting", () => {
  it("formats a single payload with truncation and full-output hint", () => {
    const payload = { ...base("a", "worker"), textPreview: "x".repeat(201) };
    expect(formatSingle(payload, { stats: "1 turn · 2 tools" })).toBe(
      'Subagent "worker" (#run-1234) completed — 1 turn · 2 tools: ' +
        `${"x".repeat(200)} — get_subagent_result "run-1234" for full output`,
    );
  });

  it("formats digest lines without internal identifiers or previews", () => {
    const items = [base("a", "one"), base("b")];
    const text = formatDigest(items, { stats: { a: "1 turn", b: "2 turns" } });
    expect(text).toBe('2 subagents settled:\n✓ "one" (#run-1234) — 1 turn\n✓ #run-1234 — 2 turns');
    expect(text).not.toContain("textPreview");
    expect(text).not.toContain("internal-key");
  });
});
