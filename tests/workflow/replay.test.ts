import { describe, expect, it } from "vitest";
import { buildEntry, CHAIN_SEED, nextChainDigest, taskKeyOf } from "../../src/workflow/journal.js";
import { buildReplayIndex, decideReplay } from "../../src/workflow/replay.js";
import type { JournalEntry, TaskSemantics } from "../../src/workflow/types.js";

/**
 * M3.5 (workflow design §6.2/§6.3/§6.4): pure unit coverage for the
 * `ReplayIndex`/`decideReplay` decision layer, independent of host.ts's
 * wiring — this is where 定理 3 (至多复用一次), 定理 4' (chain causal
 * safety), and RP1-RP9 get their line-by-line assertions.
 */

const sem = (prompt: string): TaskSemantics => ({ agentType: "gp", agentTypeConfigHash: "h1", prompt });

function makeChainRun(prompts: readonly string[], scope: "chain" | "content" = "chain"): JournalEntry[] {
  let chain = CHAIN_SEED;
  const entries: JournalEntry[] = [];
  const occCounters = new Map<string, number>();
  prompts.forEach((prompt, i) => {
    const key = taskKeyOf(sem(prompt));
    const chainDigestBefore = chain;
    const k = scope === "content" ? key : nextChainDigest(chainDigestBefore, key);
    const occurrence = occCounters.get(k) ?? 0;
    occCounters.set(k, occurrence + 1);
    chain = nextChainDigest(chainDigestBefore, key);
    entries.push(
      buildEntry({
        scope,
        key,
        chainDigestBefore,
        occurrence,
        agentType: "gp",
        value: `result-${i}`,
        completedAt: 1000 + i,
        durationMs: 10,
      }),
    );
  });
  return entries;
}

describe("buildReplayIndex + decideReplay: basic hit/miss", () => {
  it("hits when taskKey/chainDigestBefore/occurrence all match (chain scope)", () => {
    const entries = makeChainRun(["a", "b"]);
    const index = buildReplayIndex(entries, 0, "chain");
    let chain = CHAIN_SEED;
    for (const prompt of ["a", "b"]) {
      const taskKey = taskKeyOf(sem(prompt));
      const decision = decideReplay({
        index,
        taskKey,
        chainDigestBefore: chain,
        occurrence: 0,
        noReplay: false,
        deterministic: true,
        now: 2000,
      });
      expect(decision.kind).toBe("hit");
      chain = nextChainDigest(chain, taskKey);
    }
  });

  it("misses when nothing was journaled for that key", () => {
    const index = buildReplayIndex([], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("never seen")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "miss" });
  });
});

describe("定理 3 (至多复用一次): occurrence-scoped, not key-scoped", () => {
  it("the same prompt submitted 3 times in one run: occurrence 0 hits, 1/2 miss when journal only has one", () => {
    const entries = makeChainRun(["same-prompt"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const taskKey = taskKeyOf(sem("same-prompt"));
    const results = [0, 1, 2].map((occurrence) =>
      decideReplay({
        index,
        taskKey,
        chainDigestBefore: CHAIN_SEED,
        occurrence,
        noReplay: false,
        deterministic: true,
        now: 2000,
      }),
    );
    expect(results.map((r) => r.kind)).toEqual(["hit", "miss", "miss"]);
  });
});

describe("定理 4' (chain scope causal safety): an upstream content change breaks the whole downstream chain", () => {
  it("chain scope: changing task A's prompt misses A AND B (chain propagation)", () => {
    const entries = makeChainRun(["A", "B"], "chain");
    const index = buildReplayIndex(entries, 0, "chain");

    // Run 2: A's prompt changed, B's did not.
    const taskKeyA2 = taskKeyOf(sem("A-changed"));
    const decisionA = decideReplay({
      index,
      taskKey: taskKeyA2,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionA.kind).toBe("miss");

    const chainAfterA2 = nextChainDigest(CHAIN_SEED, taskKeyA2);
    const taskKeyB = taskKeyOf(sem("B")); // B's own content is unchanged...
    const decisionB = decideReplay({
      index,
      taskKey: taskKeyB,
      chainDigestBefore: chainAfterA2, // ...but its chain digest now differs.
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionB.kind).toBe("miss"); // causal break: B misses too.
  });

  it("content scope: the same upstream change only misses A, B still hits (推论 2.3)", () => {
    const entries = makeChainRun(["A", "B"], "content");
    const index = buildReplayIndex(entries, 0, "content");

    const taskKeyA2 = taskKeyOf(sem("A-changed"));
    const decisionA = decideReplay({
      index,
      taskKey: taskKeyA2,
      chainDigestBefore: CHAIN_SEED, // irrelevant for content scope
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionA.kind).toBe("miss");

    const taskKeyB = taskKeyOf(sem("B"));
    const decisionB = decideReplay({
      index,
      taskKey: taskKeyB,
      chainDigestBefore: "irrelevant-in-content-scope",
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionB.kind).toBe("hit"); // content scope: B's own content is unchanged, still hits.
  });
});

describe("推论 2.1 (completion order does not affect matching — occurrence is submission-time, matching is by map lookup)", () => {
  it("out-of-order settle (journal written in completion order) does not change the hit set", () => {
    // Two tasks submitted A, B (in that order); simulate B completing before
    // A by writing the journal in completion order B-then-A, but with
    // occurrence/chainDigestBefore recorded per *submission* order (as
    // host.ts's real submission-time assignment would do).
    const taskKeyA = taskKeyOf(sem("A"));
    const chainAfterA = nextChainDigest(CHAIN_SEED, taskKeyA);
    const taskKeyB = taskKeyOf(sem("B"));

    const entryA = buildEntry({
      scope: "chain",
      key: taskKeyA,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "a",
      completedAt: 2000, // settles *second*
      durationMs: 10,
    });
    const entryB = buildEntry({
      scope: "chain",
      key: taskKeyB,
      chainDigestBefore: chainAfterA,
      occurrence: 0,
      agentType: "gp",
      value: "b",
      completedAt: 1000, // settles *first*, but was submitted second
      durationMs: 10,
    });

    // Journal file order = completion order (B, then A) — exactly what a
    // naive line-order matcher would trip over.
    const index = buildReplayIndex([entryB, entryA], 0, "chain");

    const decisionA = decideReplay({
      index,
      taskKey: taskKeyA,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 3000,
    });
    const decisionB = decideReplay({
      index,
      taskKey: taskKeyB,
      chainDigestBefore: chainAfterA,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 3000,
    });
    expect(decisionA.kind).toBe("hit");
    expect(decisionB.kind).toBe("hit");
  });
});

describe("RP gate: noReplay / deterministic / isolation / TTL / scope mismatch", () => {
  it("RP1: noReplay forces skip even on an otherwise-matching entry", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: true,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "no_replay" });
  });

  it("RP9: deterministic:false skips every lookup, even a matching one", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: false,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "non_deterministic" });
  });

  it("RP7: isolation:worktree entries are never replayed", () => {
    const key = taskKeyOf({ ...sem("a"), isolation: "worktree" });
    const entry = buildEntry({
      scope: "chain",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([entry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "isolation_worktree" });
  });

  it("RP6: an entry older than replayTtlMs is skipped as expired", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 1000 + 10_000,
      replayTtlMs: 5_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "expired" });
  });

  it("scope mismatch: an entry written under 'content' is invisible to a 'chain'-scope index (and vice versa)", () => {
    const contentEntries = makeChainRun(["a"], "content");
    const chainIndex = buildReplayIndex(contentEntries, 0, "chain");
    expect(chainIndex.stats.scopeMismatch).toBe(1);
    const decision = decideReplay({
      index: chainIndex,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "miss" });
  });
});

describe("同 (K, occurrence) 多条 → 取 completedAt 最大者 (§6.5)", () => {
  it("buildReplayIndex keeps the entry with the latest completedAt for a duplicate key", () => {
    const key = taskKeyOf(sem("dup"));
    const older = buildEntry({
      scope: "content",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "older",
      completedAt: 1000,
      durationMs: 10,
    });
    const newer = buildEntry({
      scope: "content",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "newer",
      completedAt: 5000,
      durationMs: 10,
    });
    const index = buildReplayIndex([older, newer], 0, "content");
    const decision = decideReplay({
      index,
      taskKey: key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 6000,
    });
    expect(decision.kind).toBe("hit");
    if (decision.kind === "hit") expect(decision.entry.value).toBe("newer");
  });
});

describe("M3.6 Blocker fix (§6.3 E2): configHashAvailable fail-closed", () => {
  it("configHashAvailable:false skips even an entry that would otherwise hit, and does not consult the index at all", () => {
    const entries = makeChainRun(["a"]);
    let lookedUp = false;
    const index = buildReplayIndex(entries, 0, "chain");
    const spiedIndex = {
      ...index,
      lookup: (...args: Parameters<typeof index.lookup>) => {
        lookedUp = true;
        return index.lookup(...args);
      },
    };
    const decision = decideReplay({
      index: spiedIndex,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      configHashAvailable: false,
    });
    expect(decision).toEqual({ kind: "skip", reason: "config_hash_unavailable" });
    expect(lookedUp).toBe(false); // fail-closed: never even looks, regardless of what might match
  });

  it("configHashAvailable:true (or omitted, default) behaves exactly as before — unaffected by the Blocker fix", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const withTrue = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      configHashAvailable: true,
    });
    const omitted = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(withTrue.kind).toBe("hit");
    expect(omitted.kind).toBe("hit");
  });

  it("a truncated (JS6) entry is always skipped, never handed back as a hit", () => {
    const key = taskKeyOf(sem("a"));
    const truncatedEntry = buildEntry({
      scope: "chain",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "x".repeat(70 * 1024), // forces JS6 truncation
      completedAt: 1000,
      durationMs: 10,
    });
    expect(truncatedEntry.truncated).toBe(true);
    const index = buildReplayIndex([truncatedEntry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "truncated" });
  });
});
