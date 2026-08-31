import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SpawnRequest } from "../../src/core/types.js";
import { threadThroughRequestFields } from "../../src/service/request-threading.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const fixturesDir = join(here, "..", "fixtures");

/**
 * FF4-c / F3-F4 transport (workflow design §4.4.1.1): unit-level coverage of
 * `threadThroughRequestFields` itself — separate from the compile-time gate
 * (WC13, below) and from the full-stack value assertions (WC12a/b/c in
 * tests/service/deadline-cap.test.ts).
 */
describe("threadThroughRequestFields", () => {
  it("threads exactly the THREADED fields that are present, dropping everything else", () => {
    const req: SpawnRequest = {
      type: "worker",
      prompt: "hi",
      label: "kept-out",
      cwd: "/tmp",
      signal: new AbortController().signal,
      slotless: true,
      parentRunId: "p1",
      resumeFrom: "/tmp/x.jsonl",
      deadlineAt: 12345,
      schema: { type: "object" },
    };
    expect(threadThroughRequestFields(req)).toEqual({
      signal: req.signal,
      slotless: true,
      parentRunId: "p1",
      resumeFrom: "/tmp/x.jsonl",
      deadlineAt: 12345,
    });
  });

  it("FF4-c: fields explicitly set to undefined are skipped, not copied through as explicit undefined", () => {
    const req: SpawnRequest = { type: "worker", prompt: "hi", deadlineAt: undefined, parentRunId: "p1" };
    const out = threadThroughRequestFields(req);
    expect(out).toEqual({ parentRunId: "p1" });
    expect(Object.prototype.hasOwnProperty.call(out, "deadlineAt")).toBe(false);
  });

  it("an empty request threads to an empty object (no THREADED field present)", () => {
    expect(threadThroughRequestFields({ type: "worker", prompt: "hi" })).toEqual({});
  });
});

/**
 * WC13 (workflow design §4.4.1.1 / §10.1): the FF4 reverse-mapping gate must
 * actually fire at compile time, not just exist as a comment. Three
 * sub-assertions:
 *   ① current src/ compiles (the gate doesn't false-positive on real code);
 *   ② a fixture with an unclassified SpawnRequest field fails tsc, pointing
 *      at `_assertAllClassified` (Gate A);
 *   ③ a fixture with a stale NOT_THREADED key fails tsc, pointing at
 *      `_assertNoStaleKeys` (Gate B).
 * If the real gate were reverted to the R3 `Required<Pick<...>>` form (which
 * does not actually fail to compile on a new field), sub-assertions ② and ③
 * would fail — that's the point: they are a meta-test of the gate itself.
 */
describe("WC13: FF4 compile-time gate self-test", () => {
  function runTsc(cwd: string): { code: number; output: string } {
    try {
      const output = execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, output };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  it("① the real src/ tree (including service/request-threading.ts) compiles cleanly", () => {
    const result = runTsc(repoRoot);
    expect(result.code).toBe(0);
  }, 60_000);

  it("② fixture with an unclassified field fails tsc at _assertAllClassified (Gate A)", () => {
    const result = runTsc(join(fixturesDir, "ff4-unclassified"));
    expect(result.code).not.toBe(0);
    // tsc doesn't echo the const's name in a "not assignable to never" error,
    // so pin to the declaration site instead: spawn-request.ts:50 is exactly
    // `const _assertAllClassified: _AssertAllClassified = true;`.
    expect(result.output).toContain("spawn-request.ts(50,");
    expect(result.output).toContain("not assignable to type 'never'");
  }, 30_000);

  it("③ fixture with a stale NOT_THREADED key fails tsc at _assertNoStaleKeys (Gate B)", () => {
    const result = runTsc(join(fixturesDir, "ff4-stale-key"));
    expect(result.code).not.toBe(0);
    // spawn-request.ts:49 is exactly `const _assertNoStaleKeys: _AssertNoStaleKeys = true;`.
    expect(result.output).toContain("spawn-request.ts(49,");
    expect(result.output).toContain("not assignable to type 'never'");
  }, 30_000);
});
