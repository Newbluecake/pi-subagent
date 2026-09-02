import { describe, expect, it, vi } from "vitest";
import { createAbortTool } from "../../src/tools/abort-tool.js";
import type { QueryService, StopResult } from "../../src/service/query-service.js";

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as never;
const context = { lastComponent: undefined } as never;

function tool(result: StopResult, resolveRun?: QueryService["get"] extends never ? never : (handle: string) => any) {
  const query = { stop: vi.fn(async () => result) } as unknown as QueryService;
  return createAbortTool({ query, ...(resolveRun ? { resolveRun } : {}) });
}

describe("abort_subagent", () => {
  it("renders a folded, clipped streaming reason", () => {
    const t = tool({ ok: true, escalatedTo: "L2" });
    const rendered = t.renderCall!({ run_id: "run-1", reason: "line\none\t" + "x".repeat(100) }, theme, context) as {
      text: string;
    };
    expect(rendered.text).toContain("Abort Subagent: run-1");
    expect(rendered.text.split("\n")[1]).not.toMatch(/[\n\t]/);
    expect(rendered.text.split("\n")[1]!.length).toBeLessThanOrEqual(80);
  });

  it.each([
    [{ ok: true, escalatedTo: "L2" } as const, /Abort requested/],
    [{ ok: false, reason: "already_terminal", status: "completed" } as const, /already reached.*completed/],
  ])("returns a friendly result for %j", async (result, expected) => {
    const response = await tool(result).execute("tc", { run_id: "run-1" }, undefined, undefined, {} as never);
    expect(response.content[0]!.text).toMatch(expected);
  });

  it("resolves a label and sanitizes a reason without passing it as a cause", async () => {
    const stop = vi.fn(async () => ({ ok: true as const, escalatedTo: "L3" as const }));
    const query = { stop } as unknown as QueryService;
    const t = createAbortTool({ query, resolveRun: () => ({ ok: true, runId: "canonical" }) });
    const response = await t.execute(
      "tc",
      { run_id: "label", reason: "why\u0000 now" },
      undefined,
      undefined,
      {} as never,
    );
    expect(stop).toHaveBeenCalledWith("canonical", "user_stop");
    expect(response.content[0]!.text).not.toContain("\u0000");
    expect(response.details).toMatchObject({ runId: "canonical", reason: "why now" });
  });

  it("throws for unknown and failed stops, but resolve errors remain self-correcting", async () => {
    await expect(
      tool({ ok: false, reason: "unknown_run" }).execute(
        "tc",
        { run_id: "missing" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("unknown run_id");
    await expect(
      tool({ ok: false, reason: "stop_failed", escalatedTo: "L4" }).execute(
        "tc",
        { run_id: "run" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("failed to abort");
    const t = createAbortTool({ query: {} as QueryService, resolveRun: () => ({ ok: false, error: "ambiguous" }) });
    await expect(t.execute("tc", { run_id: "prefix" }, undefined, undefined, {} as never)).rejects.toThrow("ambiguous");
  });
});
