import { describe, expect, it } from "vitest";
import type { Text } from "@earendil-works/pi-tui";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import type { QueryService } from "../../src/service/query-service.js";

const query = (steer: QueryService["steer"]): QueryService => ({
  get: () => undefined,
  list: () => [],
  wait: async () => ({ ok: false, reason: "unknown_run" }),
  waitAll: async () => ({ settled: [], pending: [] }),
  steer,
  stop: async () => false,
});

describe("tools/steer-tool: renderCall (TUI call card)", () => {
  // Bare-minimum Theme stand-in (same convention as agent-tool.test.ts).
  const theme = { fg: (_color: string, t: string) => t, bold: (t: string) => t };
  const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} });

  it("renders the target run_id and a one-line instruction preview", () => {
    const tool = createSteerTool({ query: query(async () => ({ ok: true })) });
    const comp = tool.renderCall!(
      { run_id: "r9", text: "focus on the\n  quota module first" },
      theme as never,
      ctx() as never,
    );
    const out = (comp as Text).render(120).join("\n");
    expect(out).toContain("Steer Subagent: r9");
    expect(out).toContain("focus on the quota module first"); // whitespace collapsed to one line
  });

  it("clips long previews and tolerates partial streaming args", () => {
    const tool = createSteerTool({ query: query(async () => ({ ok: true })) });
    const long = "x".repeat(200);
    const clipped = (tool.renderCall!({ run_id: "r9", text: long }, theme as never, ctx() as never) as Text)
      .render(300)
      .join("\n");
    expect(clipped).toContain("…");
    expect(clipped).not.toContain("x".repeat(100));
    const streaming = (tool.renderCall!({}, theme as never, ctx() as never) as Text).render(120).join("\n");
    expect(streaming).toContain("Steer Subagent:");
  });
});
