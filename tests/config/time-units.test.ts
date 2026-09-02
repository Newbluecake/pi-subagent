import { describe, expect, it } from "vitest";
import {
  getPath,
  migrateTimeUnitsToSeconds,
  msKeyOf,
  msToWholeSeconds,
  normalizeTimeUnits,
  secondsKeyOf,
  secondsToMs,
  setPath,
} from "../../src/config/time-units.js";

const PATHS = [
  "budget.idleMs",
  "budget.totalMs",
  "coalesceWindowMs",
  "worktree.gitTimeoutMs",
  "workflow.budget.gateMs",
];

describe("time-units key/scalar helpers", () => {
  it("renames *Ms ⇄ *S and leaves non-time keys alone", () => {
    expect(secondsKeyOf("budget.idleMs")).toBe("budget.idleS");
    expect(secondsKeyOf("budget.startupRetries")).toBe("budget.startupRetries");
    expect(msKeyOf("budget.idleS")).toBe("budget.idleMs");
    expect(msKeyOf("concurrencyLimit")).toBe("concurrencyLimit");
    // already-ms names must not be double-converted
    expect(msKeyOf("budget.idleMs")).toBe("budget.idleMs");
  });

  it("converts whole seconds only", () => {
    expect(secondsToMs(240)).toBe(240_000);
    expect(msToWholeSeconds(240_000)).toBe(240);
    expect(msToWholeSeconds(0)).toBe(0);
    for (const bad of [1_500, -1_000, Number.NaN, Number.POSITIVE_INFINITY, "1000", null, undefined, {}, []])
      expect(msToWholeSeconds(bad), String(bad)).toBeUndefined();
  });

  it("reads and writes dotted paths without throwing on missing branches", () => {
    const root: Record<string, unknown> = { a: { b: 1 } };
    expect(getPath(root, "a.b")).toBe(1);
    expect(getPath(root, "a.b.c")).toBeUndefined();
    expect(getPath(root, "nope.deep")).toBeUndefined();
    setPath(root, "x.y.z", 5);
    expect(getPath(root, "x.y.z")).toBe(5);
    setPath(root, "x.y.z", undefined);
    expect(getPath(root, "x.y")).toEqual({});
  });
});

describe("normalizeTimeUnits (file seconds → internal milliseconds)", () => {
  it("converts *S keys to *Ms and removes the second-valued key", () => {
    const out = normalizeTimeUnits(
      { budget: { idleS: 240, startupRetries: 2 }, coalesceWindowS: 2, workflow: { budget: { gateS: 30 } } },
      PATHS,
    );
    expect(out).toEqual({
      budget: { idleMs: 240_000, startupRetries: 2 },
      coalesceWindowMs: 2_000,
      workflow: { budget: { gateMs: 30_000 } },
    });
  });

  it("does not mutate the input object", () => {
    const input = { budget: { idleS: 240 }, coalesceWindowS: 1 };
    const out = normalizeTimeUnits(input, PATHS);
    expect(input).toEqual({ budget: { idleS: 240 }, coalesceWindowS: 1 });
    expect(out).not.toBe(input);
  });

  it("drops illegal *S values so the caller's default wins", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "240", null, {}, []]) {
      const out = normalizeTimeUnits({ budget: { idleS: bad } }, PATHS);
      expect(getPath(out, "budget.idleMs"), String(bad)).toBeUndefined();
      expect(getPath(out, "budget.idleS"), String(bad)).toBeUndefined();
    }
  });

  it("tolerates a legacy *Ms key silently when it is a whole second", () => {
    expect(normalizeTimeUnits({ budget: { idleMs: 600_000 } }, PATHS)).toEqual({ budget: { idleMs: 600_000 } });
    // fractional / negative / non-numeric legacy values fall back to the default
    expect(normalizeTimeUnits({ budget: { idleMs: 1_500 } }, PATHS)).toEqual({ budget: {} });
    expect(normalizeTimeUnits({ budget: { idleMs: -1_000 } }, PATHS)).toEqual({ budget: {} });
    expect(normalizeTimeUnits({ budget: { idleMs: "600000" } }, PATHS)).toEqual({ budget: {} });
  });

  it("prefers the new key when both are present", () => {
    expect(normalizeTimeUnits({ budget: { idleS: 10, idleMs: 999_000 } }, PATHS)).toEqual({
      budget: { idleMs: 10_000 },
    });
  });

  it("leaves unrelated keys, non-object branches and arrays untouched", () => {
    const out = normalizeTimeUnits({ concurrencyLimit: 6, budget: "garbage", worktree: null, extra: [1, 2] }, PATHS);
    expect(out).toEqual({ concurrencyLimit: 6, budget: "garbage", worktree: null, extra: [1, 2] });
  });
});

describe("migrateTimeUnitsToSeconds (legacy file *Ms → *S)", () => {
  it("reports no change for an already-migrated file", () => {
    const m = migrateTimeUnitsToSeconds({ budget: { idleS: 240 }, concurrencyLimit: 6 }, PATHS);
    expect(m.changed).toBe(false);
    expect(m.converted).toEqual([]);
    expect(m.warnings).toEqual([]);
  });

  it("divides whole-second ms values, including nested budget blocks", () => {
    const m = migrateTimeUnitsToSeconds(
      {
        budget: { idleMs: 600_000, totalMs: 0, startupRetries: 2 },
        coalesceWindowMs: 2_000,
        worktree: { enabled: true, gitTimeoutMs: 30_000 },
        workflow: { budget: { gateMs: 600_000 } },
        concurrencyLimit: 6,
      },
      PATHS,
    );
    expect(m.changed).toBe(true);
    expect(m.value).toEqual({
      budget: { idleS: 600, totalS: 0, startupRetries: 2 },
      coalesceWindowS: 2,
      worktree: { enabled: true, gitTimeoutS: 30 },
      workflow: { budget: { gateS: 600 } },
      concurrencyLimit: 6,
    });
    expect(m.converted).toContain("budget.idleMs → budget.idleS (600)");
    expect(m.converted).toContain("workflow.budget.gateMs → workflow.budget.gateS (600)");
    expect(m.warnings).toEqual([]);
  });

  it("drops values that are not whole seconds, with a warning and no *S key", () => {
    const m = migrateTimeUnitsToSeconds({ budget: { idleMs: 1_500 }, coalesceWindowMs: -3_000 }, PATHS);
    expect(m.changed).toBe(true);
    expect(m.value).toEqual({ budget: {} });
    expect(m.warnings).toHaveLength(2);
    expect(m.warnings[0]).toContain("budget.idleMs=1500");
    expect(m.warnings[0]).toContain("not a whole number of seconds");
    expect(m.warnings[1]).toContain("coalesceWindowMs=-3000");
    expect(m.converted).toEqual([]);
  });

  it("keeps the new key and warns when both keys coexist", () => {
    const m = migrateTimeUnitsToSeconds({ budget: { idleS: 30, idleMs: 999_000 } }, PATHS);
    expect(m.changed).toBe(true);
    expect(m.value).toEqual({ budget: { idleS: 30 } });
    expect(m.warnings[0]).toContain("budget.idleMs and budget.idleS are both set");
    expect(m.warnings[0]).toContain("keeping budget.idleS=30");
  });

  it("does not mutate the input and never throws on hostile shapes", () => {
    const input = { budget: { idleMs: 5_000 } };
    const m = migrateTimeUnitsToSeconds(input, PATHS);
    expect(input).toEqual({ budget: { idleMs: 5_000 } });
    expect(m.value).toEqual({ budget: { idleS: 5 } });
    expect(() => migrateTimeUnitsToSeconds({ budget: 42, workflow: { budget: [] } }, PATHS)).not.toThrow();
    expect(migrateTimeUnitsToSeconds({ budget: 42 }, PATHS).changed).toBe(false);
  });
});
