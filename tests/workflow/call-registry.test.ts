import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createCallRegistry } from "../../src/workflow/call-registry.js";

/**
 * §3.6 CallRegistry + the A2 bounded-retry cancel loop. All driven by
 * `FakeClock` — deterministic, no real timers.
 */
describe("CallRegistry (§3.6)", () => {
  it("submit -> bind -> settle is the ordinary happy path (CR8 simplification: bind() lands directly on 'running', see types.ts doc)", () => {
    const clock = new FakeClock();
    const registry = createCallRegistry({ clock, abort: async () => true, cancelRetryWindowMs: 1_000 });
    registry.submit("c1", clock.now());
    expect(registry.resolve("c1")?.phase).toBe("admission");
    registry.bind("c1", "run1");
    expect(registry.resolve("c1")?.phase).toBe("running");
    expect(registry.resolve("c1")?.runId).toBe("run1");
    registry.settle("c1", clock.now());
    expect(registry.resolve("c1")?.phase).toBe("settled");
  });

  it("CR4: cancel() arriving before submit() records intent, and the call is withheld the instant it is submitted", () => {
    const clock = new FakeClock();
    const registry = createCallRegistry({ clock, abort: async () => true, cancelRetryWindowMs: 1_000 });
    expect(registry.cancel("c1", "user_stop")).toBe("unknown");
    registry.submit("c1", clock.now());
    expect(registry.resolve("c1")?.phase).toBe("settled");
    expect(registry.resolve("c1")?.cancelIntent?.cause).toBe("user_stop");
  });

  it("A1: cancel() while still in admission withholds the call permanently without ever calling abort()", async () => {
    const clock = new FakeClock();
    let abortCalls = 0;
    const registry = createCallRegistry({
      clock,
      abort: async () => {
        abortCalls += 1;
        return true;
      },
      cancelRetryWindowMs: 1_000,
    });
    registry.submit("c1", clock.now());
    const effect = registry.cancel("c1", "user_stop");
    expect(effect).toBe("withheld");
    expect(registry.resolve("c1")?.phase).toBe("settled");
    await Promise.resolve();
    expect(abortCalls).toBe(0); // never spawned, nothing to abort (CR1's zero-window guarantee).
  });

  it("A5: cancel() after settle() is a no-op reported honestly as already_settled (CR6)", () => {
    const clock = new FakeClock();
    const registry = createCallRegistry({ clock, abort: async () => true, cancelRetryWindowMs: 1_000 });
    registry.submit("c1", clock.now());
    registry.bind("c1", "run1");
    registry.settle("c1", clock.now());
    expect(registry.cancel("c1", "user_stop")).toBe("already_settled");
  });

  it("§3.6 A2 window: abort() failing repeatedly is retried on the cancelRetryMs cadence until it succeeds (CR6/CR7 — never lies, never blocks)", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const abortResults = [false, false, false, true]; // fails 3x, succeeds on the 4th attempt
    const registry = createCallRegistry({
      clock,
      abort: async () => {
        const ok = abortResults[attempts] ?? true;
        attempts += 1;
        return ok;
      },
      cancelRetryWindowMs: 10_000,
      cancelRetryMs: 250,
    });
    registry.submit("c1", clock.now());
    registry.bind("c1", "run1");

    const effect = registry.cancel("c1", "parent_abort");
    expect(effect).toBe("retrying"); // CR6: honestly reports "still trying", not "stopped"
    expect(registry.stats.retryingCancels).toBe(1);

    // Attempt 1 (immediate, synchronous kick-off) resolves on a microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);

    // Attempts 2-4 happen on the 250ms cadence.
    clock.advance(250);
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);

    clock.advance(250);
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(3);

    clock.advance(250);
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(4); // this one returns true -> retry loop stops.

    // No further timer should fire even if we advance well past the window.
    clock.advance(20_000);
    await Promise.resolve();
    expect(attempts).toBe(4);
    expect(registry.resolve("c1")?.cancelIntent?.attempts).toBeGreaterThanOrEqual(3);
  });

  it("WT18/CR7: retries give up boundedly at cancelRetryWindowMs and never block — a distinct settle() still closes the call out cleanly", async () => {
    const clock = new FakeClock();
    let gaveUp: { callId: string; runId: string } | undefined;
    const registry = createCallRegistry({
      clock,
      abort: async () => false, // never succeeds
      cancelRetryWindowMs: 1_000,
      cancelRetryMs: 250,
      onCancelRetryGivenUp: (callId, runId) => {
        gaveUp = { callId, runId };
      },
    });
    registry.submit("c1", clock.now());
    registry.bind("c1", "run1");
    registry.cancel("c1", "timeout");
    await Promise.resolve();
    await Promise.resolve();

    for (let i = 0; i < 6; i += 1) {
      clock.advance(250);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(gaveUp).toEqual({ callId: "c1", runId: "run1" });

    // CR7: the retry loop giving up must not prevent the call from being
    // settled normally by whatever eventually observes the child's own
    // terminal state (e.g. `waitAll()` in host.ts) — settle() still works.
    registry.settle("c1", clock.now());
    expect(registry.resolve("c1")?.phase).toBe("settled");
  });

  it("the retry loop stops immediately once settle() fires independently, even mid-window", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const registry = createCallRegistry({
      clock,
      abort: async () => {
        attempts += 1;
        return false;
      },
      cancelRetryWindowMs: 10_000,
      cancelRetryMs: 250,
    });
    registry.submit("c1", clock.now());
    registry.bind("c1", "run1");
    registry.cancel("c1", "timeout");
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);

    registry.settle("c1", clock.now()); // child settled on its own (e.g. it finished right as cancel fired)
    const attemptsAtSettle = attempts;

    clock.advance(5_000);
    await Promise.resolve();
    expect(attempts).toBe(attemptsAtSettle); // no further retries after settle
  });

  it("in-flight-spawn leak fix: cancel() during admission followed by a late bind() with a real runId reports cancelNow so the caller can abort it", () => {
    const clock = new FakeClock();
    const registry = createCallRegistry({ clock, abort: async () => true, cancelRetryWindowMs: 1_000 });
    registry.submit("c1", clock.now());
    // WL1/WL2 fires while `spawner.spawn()` for c1 is still in flight (bind() hasn't run yet).
    const effect = registry.cancel("c1", "user_stop");
    expect(effect).toBe("withheld");
    expect(registry.resolve("c1")?.phase).toBe("settled");

    // The in-flight spawn() now resolves with a real runId — bind() must not
    // silently swallow it; it must surface cancelNow so the caller aborts
    // the now-leaked child instead of letting it run unattended.
    const bound = registry.bind("c1", "run1");
    expect(bound).toEqual({ cancelNow: true, cause: "user_stop" });
  });

  it("in-flight-spawn leak fix: the late-bind orphan abort retries on the same cancelRetryMs cadence as the ordinary A2 path (CR2), not just once", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const abortResults = [false, false, true]; // fails twice, succeeds on the 3rd attempt
    const registry = createCallRegistry({
      clock,
      abort: async () => {
        const ok = abortResults[attempts] ?? true;
        attempts += 1;
        return ok;
      },
      cancelRetryWindowMs: 10_000,
      cancelRetryMs: 250,
    });
    registry.submit("c1", clock.now());
    registry.cancel("c1", "timeout"); // marks it withheld while spawn() is still (conceptually) in flight
    registry.bind("c1", "leaked-run"); // spawn() resolves late, with a real runId

    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);

    clock.advance(250);
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);

    clock.advance(250);
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(3); // succeeds -> retry loop stops

    clock.advance(20_000);
    await Promise.resolve();
    expect(attempts).toBe(3); // no further attempts after success
  });

  it("in-flight-spawn leak fix: the late-bind orphan abort gives up boundedly at cancelRetryWindowMs (CR7/WT18), not forever", async () => {
    const clock = new FakeClock();
    let gaveUp: { callId: string; runId: string } | undefined;
    const registry = createCallRegistry({
      clock,
      abort: async () => false, // never succeeds
      cancelRetryWindowMs: 1_000,
      cancelRetryMs: 250,
      onCancelRetryGivenUp: (callId, runId) => {
        gaveUp = { callId, runId };
      },
    });
    registry.submit("c1", clock.now());
    registry.cancel("c1", "timeout");
    registry.bind("c1", "leaked-run");
    await Promise.resolve();
    await Promise.resolve();

    for (let i = 0; i < 6; i += 1) {
      clock.advance(250);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(gaveUp).toEqual({ callId: "c1", runId: "leaked-run" });
  });

  it("CR5: cancelAll() closes the registry — subsequent submit() is rejected (WR7-adjacent: no post-close spawns)", () => {
    const clock = new FakeClock();
    const registry = createCallRegistry({ clock, abort: async () => true, cancelRetryWindowMs: 1_000 });
    registry.submit("c1", clock.now());
    registry.bind("c1", "run1");
    const result = registry.cancelAll("shutdown");
    expect(result.retrying).toContain("c1");
    expect(registry.closed).toBe(true);
    registry.submit("c2", clock.now());
    expect(registry.resolve("c2")).toBeUndefined();
  });

  it("cancelAll() classifies withheld/retrying/already_settled correctly across a mixed batch", () => {
    const clock = new FakeClock();
    const registry = createCallRegistry({ clock, abort: async () => true, cancelRetryWindowMs: 1_000 });
    registry.submit("admission-only", clock.now());
    registry.submit("bound", clock.now());
    registry.bind("bound", "runB");
    registry.submit("done", clock.now());
    registry.bind("done", "runD");
    registry.settle("done", clock.now());

    const result = registry.cancelAll("shutdown");
    expect(result.withheld).toEqual(["admission-only"]);
    expect(result.retrying).toEqual(["bound"]);
    expect(result.alreadySettled).toEqual(["done"]);
  });
});
