import type { JsonSchema, RunOutcome } from "./types.js";

export type { JsonSchema } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * X10: minimal-but-real JSON Schema (draft-07-ish) subset validator. No
 * `@earendil-works/*` import (I1: core stays pure). Deliberately not a stub
 * — it recurses into `properties`/`items`, enforces `required`,
 * `additionalProperties: false`, `enum`/`const`, and the common string/
 * number/array constraints, so a genuinely malformed structured-output
 * payload is actually rejected (this is what makes the "double validation"
 * in service/runtime-adapter.ts meaningful rather than a rubber stamp).
 *
 * Deliberately NOT implemented: $ref, oneOf/anyOf/allOf, format. A schema
 * using those degrades to "no constraint enforced for that branch" rather
 * than throwing — acceptable for the P2 scope (architecture \u00a77.2 X10),
 * but callers should not assume full draft-07 coverage.
 */
export function validateAgainstSchema(schema: JsonSchema | undefined, data: unknown): ValidationResult {
  const errors: string[] = [];
  walk("$", schema, data, errors);
  return { ok: errors.length === 0, errors };
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return jsonTypeOf(value) === type;
}
function deepEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function walk(path: string, schema: unknown, data: unknown, errors: string[]): void {
  if (schema === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
  const s = schema as JsonSchema;

  if (s.const !== undefined && !deepEqual(data, s.const)) {
    errors.push(`${path}: expected const value ${JSON.stringify(s.const)}, got ${JSON.stringify(data)}`);
    return;
  }
  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, data))) {
    errors.push(`${path}: value ${JSON.stringify(data)} is not one of the allowed enum values`);
  }

  const type = s.type;
  if (typeof type === "string") {
    if (!matchesType(data, type)) {
      errors.push(`${path}: expected type "${type}", got "${jsonTypeOf(data)}"`);
      return;
    }
  } else if (Array.isArray(type) && type.length > 0) {
    if (!type.some((t) => typeof t === "string" && matchesType(data, t))) {
      errors.push(`${path}: expected one of types [${type.join(", ")}], got "${jsonTypeOf(data)}"`);
      return;
    }
  }

  if (jsonTypeOf(data) === "object") {
    const obj = data as Record<string, unknown>;
    const props =
      s.properties && typeof s.properties === "object" ? (s.properties as Record<string, JsonSchema>) : undefined;
    const required = Array.isArray(s.required)
      ? (s.required as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    for (const key of required) if (!(key in obj)) errors.push(`${path}.${key}: required property is missing`);
    if (props)
      for (const [key, sub] of Object.entries(props)) if (key in obj) walk(`${path}.${key}`, sub, obj[key], errors);
    if (s.additionalProperties === false) {
      const allowed = new Set(Object.keys(props ?? {}));
      for (const key of Object.keys(obj))
        if (!allowed.has(key)) errors.push(`${path}.${key}: additional property is not allowed`);
    }
  }

  if (Array.isArray(data)) {
    if (typeof s.minItems === "number" && data.length < s.minItems)
      errors.push(`${path}: expected at least ${s.minItems} items, got ${data.length}`);
    if (typeof s.maxItems === "number" && data.length > s.maxItems)
      errors.push(`${path}: expected at most ${s.maxItems} items, got ${data.length}`);
    if (s.items && typeof s.items === "object" && !Array.isArray(s.items))
      data.forEach((item, i) => walk(`${path}[${i}]`, s.items, item, errors));
  }

  if (typeof data === "string") {
    if (typeof s.minLength === "number" && data.length < s.minLength)
      errors.push(`${path}: expected minLength ${s.minLength}, got length ${data.length}`);
    if (typeof s.maxLength === "number" && data.length > s.maxLength)
      errors.push(`${path}: expected maxLength ${s.maxLength}, got length ${data.length}`);
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern).test(data)) errors.push(`${path}: does not match pattern ${s.pattern}`);
      } catch {
        /* malformed pattern in a caller-provided schema is not this validator's problem to crash on */
      }
    }
  }

  if (typeof data === "number") {
    if (typeof s.minimum === "number" && data < s.minimum)
      errors.push(`${path}: expected >= ${s.minimum}, got ${data}`);
    if (typeof s.maximum === "number" && data > s.maximum)
      errors.push(`${path}: expected <= ${s.maximum}, got ${data}`);
  }
}

/**
 * X10 host-side re-validation (the second of the two mandatory checks,
 * architecture \u00a77.2 X10 "\u53cc\u91cd\u6821\u9a8c\u9632 journal \u6c61\u67d3"). Deliberately re-derives
 * validity purely from `(schema, captured)` rather than trusting any
 * "already validated" flag the injected tool's own (first) check may have
 * set \u2014 if `captured` was ever populated through anything other than the
 * tool's own gate (a tampered/forged journal entry, a bug in the tool
 * wiring), this call still independently rejects it. Only touches `outcome`
 * when it is `"completed"`: a run that already failed/timed_out/aborted for
 * an unrelated reason keeps that status and error untouched.
 */
export function applyStructuredOutputPolicy(outcome: RunOutcome, schema: JsonSchema, captured: unknown): RunOutcome {
  if (outcome.status !== "completed") return outcome;
  if (captured === undefined) {
    return {
      ...outcome,
      status: "failed",
      error: {
        kind: "schema",
        message: "subagent reached a terminal state without submitting a StructuredOutput result",
        retryable: false,
      },
    };
  }
  const revalidated = validateAgainstSchema(schema, captured);
  if (!revalidated.ok) {
    return {
      ...outcome,
      status: "failed",
      error: {
        kind: "schema",
        message: `structured output failed host-side re-validation: ${revalidated.errors.join("; ")}`,
        retryable: false,
      },
    };
  }
  return { ...outcome, structuredResult: captured };
}
