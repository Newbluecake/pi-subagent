import { describe, expect, it } from "vitest";
import type { DeliveryPayload } from "../../src/core/types.js";
import { formatDigest, formatSingle, truncateMarkdownPreview } from "../../src/delivery/format.js";

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

  describe("truncateMarkdownPreview", () => {
    const fenceCount = (s: string) => s.split("\n").filter((l) => l.trimStart().startsWith("```")).length;

    it("passes through multi-line markdown that fits both budgets, without a hint", () => {
      const md = "## 标题\n\n一段 **粗体** 文本。";
      const r = truncateMarkdownPreview(md);
      expect(r).toEqual({ text: md, truncated: false });
      const out = formatSingle({ ...base("a", "worker"), textPreview: md });
      expect(out).toContain(md);
      expect(out).not.toContain("for full output");
    });

    it("truncates at line granularity — never half a line", () => {
      const lines = ["# Markdown 渲染测试样例", "", "第二段 " + "长".repeat(90), "第三段 " + "长".repeat(90)];
      const src = lines.join("\n");
      expect(src.length).toBeGreaterThan(200);
      const r = truncateMarkdownPreview(src);
      expect(r.truncated).toBe(true);
      // Every kept line is a complete source line, in order.
      const kept = r.text.split("\n");
      let cursor = 0;
      for (const line of kept) {
        expect(lines.indexOf(line)).toBeGreaterThanOrEqual(cursor);
        cursor = lines.indexOf(line);
      }
      expect(r.text.length).toBeLessThanOrEqual(200);
      // The half-cut tail line must not appear.
      expect(kept).not.toContain(lines[3]);
      const out = formatSingle({ ...base("a", "worker"), textPreview: src });
      expect(out).toContain('get_subagent_result "run-1234" for full output');
    });

    it("puts the full-output hint in its own paragraph for multi-line previews", () => {
      // Glued onto the last preview line the hint would corrupt that markdown
      // construct (table separator, fence); without a blank line a trailing
      // table would absorb it as a data row.
      const src = [
        "| a | b |",
        "| --- | --- |",
        ...Array.from({ length: 30 }, (_, i) => `| r${i} | ${"x".repeat(40)} |`),
      ].join("\n");
      const out = formatSingle({ ...base("a", "worker"), textPreview: src });
      expect(out).toContain('\n\n— get_subagent_result "run-1234" for full output');
      // The hint is not part of any table row.
      for (const line of out.split("\n")) {
        if (line.includes("get_subagent_result")) expect(line.startsWith("|")).toBe(false);
      }
    });

    it("closes an open code fence cut mid-block (even fence count)", () => {
      const src = [
        "说明：",
        "",
        "```ts",
        "const a = 1;",
        ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`),
        "```",
      ].join("\n");
      const r = truncateMarkdownPreview(src);
      expect(r.truncated).toBe(true);
      expect(fenceCount(r.text) % 2).toBe(0);
      expect(r.text.endsWith("\n```")).toBe(true);
      // No code line is cut in half.
      for (const line of r.text.split("\n")) {
        expect(src.split("\n")).toContain(line);
      }
    });

    it("enforces the line budget even when characters fit", () => {
      const src = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"); // 79 chars, 10 lines
      expect(src.length).toBeLessThanOrEqual(200);
      const r = truncateMarkdownPreview(src);
      expect(r.truncated).toBe(true);
      expect(r.text.split("\n")).toHaveLength(6);
      expect(r.text).not.toContain("line 6");
    });

    it("never halves a table row — rows are kept whole or dropped entirely", () => {
      const row = (a: string, b: string) => `| ${a} | ${b} |`;
      const src = [
        "| 指标 | 数值 |",
        "| --- | --- |",
        row("turns", "3"),
        row("tools", "5"),
        row("cost", "$0.0123"),
        row("padding", "x".repeat(160)),
        row("tail", "dropped"),
      ].join("\n");
      const r = truncateMarkdownPreview(src);
      expect(r.truncated).toBe(true);
      const rows = r.text.split("\n").filter((l) => l.startsWith("|"));
      for (const line of rows) {
        expect(line.endsWith("|")).toBe(true); // whole rows only
        expect(src.split("\n")).toContain(line);
      }
      expect(r.text).not.toContain("dropped");
    });

    it("degenerates to a character slice for a single over-budget line", () => {
      const r = truncateMarkdownPreview("x".repeat(201));
      expect(r).toEqual({ text: "x".repeat(200), truncated: true });
    });

    it("leaves short failReason text untouched", () => {
      const out = formatSingle({ ...base("a", "worker"), status: "failed", failReason: "boom: schema invalid" });
      expect(out).toContain(": boom: schema invalid");
      expect(out).not.toContain("for full output");
    });

    it("puts the pre-finalize note in its own paragraph for multi-line previews", () => {
      // Same rule as the full-output hint: glued onto the last preview line,
      // the note would corrupt that markdown construct.
      const src = ["## 结果", "", "第一段 " + "长".repeat(90), "第二段 " + "长".repeat(90)].join("\n");
      const out = formatSingle({ ...base("a", "worker"), textPreview: src, degradedReason: "pre-finalize" });
      expect(out).toContain('\n\n(pre-finalize snapshot; run get_subagent_result "run-1234" to confirm)');
    });

    it("keeps the historical inline pre-finalize note for single-line previews", () => {
      const out = formatSingle({ ...base("a", "worker"), degradedReason: "pre-finalize" });
      expect(out).toContain(': done (pre-finalize snapshot; run get_subagent_result "run-1234" to confirm)');
    });
  });
});
