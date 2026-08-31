import { describe, expect, it } from "vitest";
import { applyStructuredOutputPolicy, validateAgainstSchema } from "../../src/core/json-schema.js";
import type { RunOutcome } from "../../src/core/types.js";

const objSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    age: { type: "integer", minimum: 0 },
  },
  required: ["name", "age"],
  additionalProperties: false,
};

function completedOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "r1",
    status: "completed",
    turns: 1,
    durationMs: 5,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 5,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
    ...overrides,
  };
}

describe("core/json-schema: validateAgainstSchema", () => {
  it("accepts a value matching required/typed properties", () => {
    const result = validateAgainstSchema(objSchema, { name: "ada", age: 30 });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects a missing required property with a concrete diagnosable error, not a rubber stamp", () => {
    const result = validateAgainstSchema(objSchema, { name: "ada" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("age") && e.includes("required"))).toBe(true);
  });

  it("rejects a wrong-typed property", () => {
    const result = validateAgainstSchema(objSchema, { name: "ada", age: "thirty" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("age"))).toBe(true);
  });

  it("rejects additional properties when additionalProperties is false", () => {
    const result = validateAgainstSchema(objSchema, { name: "ada", age: 30, extra: true });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("extra"))).toBe(true);
  });

  it("recurses into array items and nested objects", () => {
    const schema = { type: "array", items: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } };
    const bad = validateAgainstSchema(schema, [{ n: 1 }, { n: "oops" }]);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.startsWith("$[1]"))).toBe(true);
    const good = validateAgainstSchema(schema, [{ n: 1 }, { n: 2 }]);
    expect(good.ok).toBe(true);
  });

  it("undefined schema means no constraint", () => {
    expect(validateAgainstSchema(undefined, { anything: "goes" })).toEqual({ ok: true, errors: [] });
  });
});

describe("core/json-schema: applyStructuredOutputPolicy (X10 host-side / second validation)", () => {
  it("leaves non-completed outcomes untouched", () => {
    const outcome = completedOutcome({ status: "timed_out" });
    expect(applyStructuredOutputPolicy(outcome, objSchema, { name: "x", age: 1 })).toBe(outcome);
  });

  it("marks failed(schema) when nothing was ever submitted", () => {
    const outcome = completedOutcome();
    const result = applyStructuredOutputPolicy(outcome, objSchema, undefined);
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("schema");
    expect(result.error?.message).toMatch(/without submitting/);
  });

  it("attaches structuredResult when the captured payload is genuinely valid", () => {
    const outcome = completedOutcome();
    const result = applyStructuredOutputPolicy(outcome, objSchema, { name: "ada", age: 30 });
    expect(result.status).toBe("completed");
    expect(result.structuredResult).toEqual({ name: "ada", age: 30 });
  });

  /**
   * The double-validation defense: this call simulates a captured value that
   * bypassed (or was never subjected to) the injected tool's own first-pass
   * check — e.g. a bug in the wiring, or a forged/tampered capture. The
   * host-side call must independently re-derive validity from
   * (schema, captured) alone; it must NOT treat "captured !== undefined" as
   * "already validated". If this assertion were changed to expect
   * status:"completed", the mutation would slip an invalid payload through
   * as if it were legitimate — this is exactly the journal-pollution defect
   * X10's double validation exists to close.
   */
  it("independently rejects an invalid captured payload even though it was 'submitted' (proves it is not a rubber stamp)", () => {
    const outcome = completedOutcome();
    const forged = { name: "", age: -5 }; // violates minLength and minimum
    const result = applyStructuredOutputPolicy(outcome, objSchema, forged);
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("schema");
    expect(result.error?.message).toMatch(/host-side re-validation/);
    expect(result.structuredResult).toBeUndefined();
  });
});
