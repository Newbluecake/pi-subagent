import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  buildEntry,
  canonicalize,
  CHAIN_SEED,
  createJournalStore,
  entryDigest,
  nextChainDigest,
  parseEntry,
  sha256Hex,
  taskKeyOf,
} from "../../src/workflow/journal.js";
import type { JournalEntry, TaskSemantics } from "../../src/workflow/types.js";

/**
 * M3.5 (workflow design §6.2/§6.5/§6.6): pure unit coverage for
 * `journal.ts` — key computation (`taskKeyOf`, chain digest recurrence),
 * entry digesting/tamper-detection, and the append-only `JournalStore`
 * (JS1/JS2/JS3, corrupt-line tolerance).
 */

const baseSem: TaskSemantics = { agentType: "general-purpose", agentTypeConfigHash: "h1", prompt: "hello" };

describe("canonicalize (§6.2 WP6: key-order-insensitive, value-sensitive)", () => {
  it("is insensitive to object key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it("is sensitive to value differences", () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });
  it("drops undefined-valued keys (matches JSON.stringify's own object behavior)", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
  it("preserves array order (arrays are not reordered)", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe("taskKeyOf (§6.2 A2': declared-semantics completeness)", () => {
  it("is deterministic for identical semantics", () => {
    expect(taskKeyOf(baseSem)).toBe(taskKeyOf({ ...baseSem }));
  });
  it("changes when prompt changes", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, prompt: "different" }));
  });
  it("changes when agentTypeConfigHash changes (§6.3 E2: a .md definition edit must miss)", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, agentTypeConfigHash: "h2" }));
  });
  it("changes when agentType changes even if the config hash coincidentally matches", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, agentType: "other-type" }));
  });
  it("changes when isolation is added", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, isolation: "worktree" }));
  });
  it("changes when workflowArgs changes", () => {
    expect(taskKeyOf({ ...baseSem, workflowArgs: { n: 1 } })).not.toBe(
      taskKeyOf({ ...baseSem, workflowArgs: { n: 2 } }),
    );
  });
  it("is stable under workflowArgs key-order permutation (canonicalize, not raw JSON)", () => {
    expect(taskKeyOf({ ...baseSem, workflowArgs: { a: 1, b: 2 } })).toBe(
      taskKeyOf({ ...baseSem, workflowArgs: { b: 2, a: 1 } }),
    );
  });
});

describe("nextChainDigest (§6.2 chain recurrence)", () => {
  it("is deterministic", () => {
    const tk = taskKeyOf(baseSem);
    expect(nextChainDigest(CHAIN_SEED, tk)).toBe(nextChainDigest(CHAIN_SEED, tk));
  });
  it("differs for different chainDigestBefore (causal propagation, 定理 4')", () => {
    const tk = taskKeyOf(baseSem);
    expect(nextChainDigest(CHAIN_SEED, tk)).not.toBe(nextChainDigest("some-other-digest", tk));
  });
  it("differs for different taskKey", () => {
    const tk1 = taskKeyOf(baseSem);
    const tk2 = taskKeyOf({ ...baseSem, prompt: "other" });
    expect(nextChainDigest(CHAIN_SEED, tk1)).not.toBe(nextChainDigest(CHAIN_SEED, tk2));
  });
});

function makeEntry(overrides: Partial<Parameters<typeof buildEntry>[0]> = {}): JournalEntry {
  return buildEntry({
    scope: "chain",
    key: taskKeyOf(baseSem),
    chainDigestBefore: CHAIN_SEED,
    occurrence: 0,
    agentType: baseSem.agentType,
    value: "the answer",
    completedAt: 1000,
    durationMs: 50,
    ...overrides,
  });
}

describe("entryDigest / parseEntry (RP4: tamper detection)", () => {
  it("round-trips a well-formed line", () => {
    const entry = makeEntry();
    const parsed = parseEntry(JSON.stringify(entry));
    expect(parsed).toEqual(entry);
  });
  it("recomputes the same digest for the same fields", () => {
    const entry = makeEntry();
    const { digest, ...fields } = entry;
    expect(entryDigest(fields)).toBe(digest);
  });
  it("rejects a hand-edited `value` whose digest was not recomputed (the exact §10.2 W30 scenario)", () => {
    const entry = makeEntry();
    const tampered = { ...entry, value: "a completely different answer" };
    expect(parseEntry(JSON.stringify(tampered))).toBeUndefined();
  });
  it("rejects malformed JSON", () => {
    expect(parseEntry("{not json")).toBeUndefined();
  });
  it("rejects an unknown `v`", () => {
    const entry = makeEntry();
    expect(parseEntry(JSON.stringify({ ...entry, v: 2 }))).toBeUndefined();
  });
  it("rejects a non-object line", () => {
    expect(parseEntry("42")).toBeUndefined();
    expect(parseEntry('"a string"')).toBeUndefined();
    expect(parseEntry("[1,2,3]")).toBeUndefined();
  });
  it("rejects a truncated line", () => {
    const entry = makeEntry();
    const line = JSON.stringify(entry);
    expect(parseEntry(line.slice(0, line.length - 10))).toBeUndefined();
  });
});

describe("sha256Hex", () => {
  it("is a 64-char lowercase hex string", () => {
    expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("JournalStore (§6.6 JS1/JS2/JS3): async append, batched flush, corrupt-line tolerance", () => {
  let dir: string;
  let clock: FakeClock;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-journal-"));
    clock = new FakeClock();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("load() on a missing journal returns empty, not an error", async () => {
    const store = createJournalStore({ clock });
    const result = await store.load(dir);
    expect(result).toEqual({ entries: [], corruptLines: 0 });
  });

  it("append() returns synchronously (JS1) — does not block the caller on disk I/O", () => {
    const store = createJournalStore({ clock });
    const start = Date.now();
    store.append(dir, makeEntry());
    // JS1: append() must be a plain synchronous function call, not an
    // (even resolved) Promise — asserting on wall-clock elapsed time here
    // would be flaky; the real guarantee is the *type signature* (`void`,
    // not `Promise<void>`) plus the JS1 end-to-end coverage in host.test.ts
    // (asserting `agent()`'s own settle round trip never awaits a flush).
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("flush() writes every appended entry to journal.jsonl, batched into one file", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry({ occurrence: 0 }));
    store.append(dir, makeEntry({ occurrence: 1 }));
    store.append(dir, makeEntry({ occurrence: 2 }));
    const result = await store.flush(dir, 5_000);
    expect(result).toEqual({ written: 3, pending: 0 });
    const text = await readFile(join(dir, "journal.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("load() after flush() reconstructs every valid entry and reports zero corrupt lines", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry({ occurrence: 0 }));
    store.append(dir, makeEntry({ occurrence: 1, value: "second" }));
    await store.flush(dir, 5_000);
    const result = await store.load(dir);
    expect(result.corruptLines).toBe(0);
    expect(result.entries).toHaveLength(2);
  });

  it("a hand-corrupted line is skipped (WARN + counted) while the remaining valid lines still load (§10.2 W30/W33)", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry({ occurrence: 0 }));
    await store.flush(dir, 5_000);
    const good = makeEntry({ occurrence: 1, value: "still good" });
    const tampered = { ...makeEntry({ occurrence: 2, value: "original" }), value: "hand-edited, digest stale" };
    const path = join(dir, "journal.jsonl");
    await appendFile(path, "not even json\n" + JSON.stringify(good) + "\n" + JSON.stringify(tampered) + "\n");
    const result = await store.load(dir);
    // 1 garbage line + 1 tampered-digest line = 2 corrupt; the original
    // entry + the still-good appended one load fine (2 entries).
    expect(result.corruptLines).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it("flush() with an exhausted deadline still reports what remains pending, never throws", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry());
    const result = await store.flush(dir, 0);
    // Whether or not the microtask-scheduled fs write beat the zero-deadline
    // race is not the point under test — the call must resolve (not hang,
    // not throw) either way.
    expect(result.pending).toBeGreaterThanOrEqual(0);
    expect(result.written).toBeGreaterThanOrEqual(0);
  });
});
