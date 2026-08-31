import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import type { JournalEntry, ReplayScope, TaskKey, TaskSemantics } from "./types.js";

/**
 * M3.5 (workflow design §6.2/§6.5/§6.6): content-addressed task keys +
 * the append-only journal store.
 *
 * File layout (§6.5, narrowed to what this milestone needs — no
 * `progress.jsonl`/`meta.json`, those are UI/ops concerns out of scope
 * here): `<journalDir>/journal.jsonl`, one `JournalEntry` per line.
 *
 * JS1 (§6.6/§6.7, CI grep gate): zero `appendFileSync`/`writeFileSync`/
 * `readFileSync` in this file (or anywhere under `src/workflow/**`) — every
 * FS call here is `node:fs/promises`, and `append()` itself is a **synchronous
 * return** that only enqueues work (JS2: a single serialized writer queue per
 * directory, batched into one `fs.appendFile` per flush).
 */

const JOURNAL_FILE = "journal.jsonl";

/** Stable JSON stringification: sorts object keys recursively so semantically-identical objects (key order aside) hash identically (WP6-equivalent). `undefined` values are dropped, matching `JSON.stringify`'s own object-key behavior (kept for array *entries*, since `JSON.stringify` turns those into `null`, which is what we want too — the array shape itself still participates in the hash). */
export function canonicalize(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * §6.2 `taskKeyOf`: the content-addressed key for one `agent()` call's
 * *declared* semantics. Every field on `TaskSemantics` participates (an
 * exhaustive object literal below, not a spread — adding a field to
 * `TaskSemantics` without also listing it here is a compile error, the
 * file-scope-appropriate stand-in for the full design's `KEY_POLICY`
 * mapped-type gate).
 */
export function taskKeyOf(sem: TaskSemantics): TaskKey {
  const canon: Record<string, unknown> = {
    agentType: sem.agentType,
    agentTypeConfigHash: sem.agentTypeConfigHash,
    prompt: sem.prompt,
    ...(sem.isolation !== undefined ? { isolation: sem.isolation } : {}),
    ...(sem.workflowArgs !== undefined ? { workflowArgs: sem.workflowArgs } : {}),
  };
  return sha256Hex(canonicalize(canon)).slice(0, 32);
}

/** §6.2 chain digest recurrence: `chainDigest := H(chainDigest ‖ taskKey)`, used both to advance the *live* chain (host.ts, on every submission, hit or miss) and to reconstruct a *historical* entry's chain-scope key from its recorded `chainDigestBefore` (replay.ts). Same formula either way — this is the only function that computes it. */
export function nextChainDigest(chainDigestBefore: string, taskKey: TaskKey): string {
  return sha256Hex(`${chainDigestBefore}:${taskKey}`);
}

/** The seed a fresh workflow run's chain starts from (§6.2: "首批提交只依赖脚本与全局"). */
export const CHAIN_SEED = "wf:chain:root";

type EntryDigestInput = Omit<JournalEntry, "digest">;

/** RP4: sha256 over the canonical form of every field except `digest` itself. */
export function entryDigest(fields: EntryDigestInput): string {
  return sha256Hex(canonicalize(fields));
}

export interface BuildEntryInput {
  readonly scope: ReplayScope;
  readonly key: TaskKey;
  readonly chainDigestBefore: string;
  readonly occurrence: number;
  readonly agentType: string;
  readonly isolation?: "worktree";
  readonly value: string | null;
  readonly completedAt: Millis;
  readonly durationMs: Millis;
}

export function buildEntry(input: BuildEntryInput): JournalEntry {
  const fields: EntryDigestInput = {
    v: 1,
    scope: input.scope,
    key: input.key,
    chainDigestBefore: input.chainDigestBefore,
    occurrence: input.occurrence,
    agentType: input.agentType,
    status: "completed",
    ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
    value: input.value,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
  };
  return { ...fields, digest: entryDigest(fields) };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Runtime shape guard (a hand-edited/foreign-tool-produced line can be arbitrary JSON) + RP4 digest re-verification, combined — either failure demotes the line to "corrupt" (never partially trusted). */
export function parseEntry(line: string): JournalEntry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(raw)) return undefined;
  if (raw.v !== 1) return undefined;
  if (raw.scope !== "chain" && raw.scope !== "content") return undefined;
  if (typeof raw.key !== "string" || typeof raw.chainDigestBefore !== "string") return undefined;
  if (typeof raw.occurrence !== "number" || !Number.isFinite(raw.occurrence)) return undefined;
  if (typeof raw.agentType !== "string") return undefined;
  if (raw.status !== "completed") return undefined;
  if (raw.isolation !== undefined && raw.isolation !== "worktree") return undefined;
  if (raw.value !== null && typeof raw.value !== "string") return undefined;
  if (typeof raw.completedAt !== "number" || typeof raw.durationMs !== "number") return undefined;
  if (typeof raw.digest !== "string") return undefined;

  const fields: EntryDigestInput = {
    v: 1,
    scope: raw.scope,
    key: raw.key,
    chainDigestBefore: raw.chainDigestBefore,
    occurrence: raw.occurrence,
    agentType: raw.agentType,
    status: "completed",
    ...(raw.isolation !== undefined ? { isolation: raw.isolation } : {}),
    value: raw.value,
    completedAt: raw.completedAt,
    durationMs: raw.durationMs,
  };
  // RP4: a hand-edited `value` (or any other field) without recomputing
  // `digest` demotes the whole line to corrupt — never returned as a
  // "trust it anyway" partial entry.
  if (entryDigest(fields) !== raw.digest) return undefined;
  return { ...fields, digest: raw.digest };
}

export interface JournalLoadResult {
  readonly entries: readonly JournalEntry[];
  readonly corruptLines: number;
}

export interface JournalStore {
  /** Reads and parses the whole file (if any); malformed/tampered lines are dropped and counted, never thrown (GW4: a damaged journal degrades this run to live, it never crashes it). */
  load(dir: string): Promise<JournalLoadResult>;
  /**
   * JS1: synchronous return — only enqueues `entry` onto `dir`'s writer
   * queue and (if not already scheduled) kicks off an async flush. Never
   * awaited by the settle path that calls it (host.ts) — see this module's
   * doc and `journal.test.ts`'s JS1 non-blocking coverage.
   */
  append(dir: string, entry: JournalEntry): void;
  /** JS4: bounded best-effort flush — used once, right before a run's terminal decision, to give buffered entries a real chance to land before the process might exit. Returns how many lines were actually written vs. still queued when the deadline hit. */
  flush(dir: string, deadlineMs: Millis): Promise<{ written: number; pending: number }>;
}

interface DirQueue {
  pending: JournalEntry[];
  /** JS2: single writer per directory — a flush already in flight is awaited by the next one instead of racing it (multiple concurrent `fs.appendFile` calls against the same path is exactly the hazard JS2 exists to avoid). */
  flushing: Promise<void> | undefined;
  /** Cumulative count of entries that ever made it into a successful `fs.appendFile` call — `flush()` diffs this before/after its race to report how many of *its own* pending entries actually landed. */
  writtenTotal: number;
}

/**
 * `clock` is accepted for interface symmetry with the rest of `src/workflow/**`
 * (every module that can wait takes one) — `flush`'s deadline here is a
 * *count* of in-flight promises settling, not a timer race, since the
 * underlying `fs.appendFile` calls are not itself clock-driven; `flush`
 * still honors `deadlineMs` via `Promise.race` against a `clock.setTimer`.
 */
export function createJournalStore(deps: { readonly clock: Clock }): JournalStore {
  const queues = new Map<string, DirQueue>();

  function queueFor(dir: string): DirQueue {
    let q = queues.get(dir);
    if (!q) {
      q = { pending: [], flushing: undefined, writtenTotal: 0 };
      queues.set(dir, q);
    }
    return q;
  }

  async function drain(dir: string): Promise<void> {
    const q = queueFor(dir);
    if (q.pending.length === 0) return;
    const batch = q.pending;
    q.pending = [];
    try {
      await mkdir(dir, { recursive: true });
      const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(join(dir, JOURNAL_FILE), lines, "utf8");
      q.writtenTotal += batch.length;
    } catch {
      // JS3: a flush failure degrades this run's future hit rate, it never
      // fails the workflow itself — the caller (host.ts) never awaits
      // `append()`, and `flush()` reports the loss via `pending` instead of
      // throwing.
      q.pending = [...batch, ...q.pending];
    }
  }

  function scheduleFlush(dir: string): void {
    const q = queueFor(dir);
    if (q.flushing) return; // JS2: a drain is already in flight; it will pick up anything appended meanwhile on its *next* cycle (see the loop below).
    q.flushing = (async () => {
      // Loop, not a single drain: entries appended *while* this flush's own
      // `fs.appendFile` was in flight must not be silently left for the next
      // caller to discover — keep draining until the queue is actually empty.
      while (queueFor(dir).pending.length > 0) {
        await drain(dir);
      }
      queueFor(dir).flushing = undefined;
    })();
  }

  return {
    async load(dir) {
      let text: string;
      try {
        text = await readFile(join(dir, JOURNAL_FILE), "utf8");
      } catch {
        return { entries: [], corruptLines: 0 }; // JS3-equivalent: no journal yet is not an error.
      }
      const entries: JournalEntry[] = [];
      let corruptLines = 0;
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed = parseEntry(line);
        if (parsed === undefined) {
          corruptLines += 1;
          continue;
        }
        entries.push(parsed);
      }
      return { entries, corruptLines };
    },
    append(dir, entry) {
      queueFor(dir).pending.push(entry);
      scheduleFlush(dir);
    },
    async flush(dir, deadlineMs) {
      const q = queueFor(dir);
      const writtenBefore = q.writtenTotal;
      if (q.pending.length === 0 && !q.flushing) return { written: 0, pending: 0 };
      scheduleFlush(dir);
      let timer: TimerHandle | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = deps.clock.setTimer(Math.max(0, deadlineMs), resolve);
      });
      await Promise.race([queueFor(dir).flushing ?? Promise.resolve(), timeout]);
      if (timer) deps.clock.clearTimer(timer);
      const q2 = queueFor(dir);
      return { written: q2.writtenTotal - writtenBefore, pending: q2.pending.length };
    },
  };
}
