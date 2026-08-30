import type { Clock } from "../core/clock.js";
import type { DeadlineBudget, Millis, OrphanRecord, RunId, RunPhase, StopCause, TimeoutReason } from "../core/types.js";
import type { CancelHandle } from "./runner.js";
import type { DisposeReport, SessionHandle } from "./session-driver.js";

export type { OrphanRecord } from "../core/types.js";
export interface OrphanRegistry {
  register(r: OrphanRecord): void;
  recordLateRecovered(runId: RunId, generation: number): void;
  readonly recent: ReadonlyArray<OrphanRecord>;
  readonly totalCount: number;
  readonly lateRecoveredCount: number;
  countInWindow(windowMs: Millis): number;
  readonly byReason: ReadonlyMap<string, number>;
  resetCircuit(operator: string): void;
}
export class MemoryOrphanRegistry implements OrphanRegistry {
  private records: OrphanRecord[] = [];
  private times: number[] = [];
  private total = 0;
  private recovered = 0;
  private readonly reasons = new Map<string, number>();
  private resetAt = 0;
  constructor(
    private readonly clock: Clock,
    private readonly maxRetained = 50,
  ) {}
  register(r: OrphanRecord) {
    this.total++;
    this.records = [...this.records, r].slice(-this.maxRetained);
    this.times.push(r.registeredAt);
    this.reasons.set(r.reason, (this.reasons.get(r.reason) ?? 0) + 1);
  }
  recordLateRecovered() {
    this.recovered++;
  }
  get recent() {
    return this.records;
  }
  get totalCount() {
    return this.total;
  }
  get lateRecoveredCount() {
    return this.recovered;
  }
  get byReason() {
    return this.reasons;
  }
  countInWindow(windowMs: Millis) {
    const cutoff = this.clock.now() - windowMs;
    return this.times.filter((t) => t >= cutoff && t >= this.resetAt).length;
  }
  resetCircuit() {
    this.resetAt = this.clock.now();
    this.times = this.times.filter((t) => t >= this.resetAt);
  }
}
export interface ReapInput {
  runId: RunId;
  generation: number;
  cancel: CancelHandle;
  handle?: SessionHandle;
  sessionId?: string;
  phase: RunPhase;
  cause?: StopCause;
  budget: DeadlineBudget;
}
export interface ReapResult {
  disposed: boolean;
  orphaned: boolean;
  escalation: ReadonlyArray<{ level: "L0" | "L1" | "L2" | "L3" | "L3p"; ok: boolean; ms: Millis; detail?: string }>;
  unkillable: ReadonlyArray<{ kind: string; id: string }>;
}
export interface Reaper {
  reap(input: ReapInput): Promise<ReapResult>;
  abortReap(runId: RunId, generation: number, reason: string): void;
  disposeLate(runId: RunId, generation: number, h: SessionHandle): void;
  readonly registry: OrphanRegistry;
}
const info = (e: unknown) => ({
  kind: "internal" as const,
  message: e instanceof Error ? e.message : String(e),
  retryable: false,
});
export class EscalatingReaper implements Reaper {
  private readonly active = new Map<string, AbortController>();
  constructor(
    private readonly clock: Clock,
    public readonly registry: OrphanRegistry = new MemoryOrphanRegistry(clock),
  ) {}
  async reap(i: ReapInput): Promise<ReapResult> {
    const started = this.clock.now();
    const esc: Array<ReapResult["escalation"][number]> = [];
    const key = `${i.runId}:${i.generation}`;
    const stop = new AbortController();
    this.active.set(key, stop);
    const push = (level: ReapResult["escalation"][number]["level"], ok: boolean, detail?: string) =>
      esc.push({ level, ok, ms: Math.max(0, this.clock.now() - started), ...(detail === undefined ? {} : { detail }) });
    try {
      try {
        i.cancel.cancel("reap");
        push("L0", true);
      } catch (e) {
        push("L0", false, info(e).message);
      }
      if (!i.handle) {
        const orphaned = i.sessionId !== undefined;
        if (orphaned)
          this.registry.register({
            runId: i.runId,
            ...(i.sessionId ? { sessionId: i.sessionId } : {}),
            phase: i.phase,
            reason: i.cause ?? "timeout",
            registeredAt: this.clock.now(),
            unkillable: [],
            lateArrival: false,
          });
        return { disposed: false, orphaned, escalation: esc, unkillable: [] };
      }
      const l1 = await bounded(
        i.handle.steer("wrap up now"),
        Math.min(i.budget.steerMs, i.budget.abortGraceMs),
        this.clock,
        stop.signal,
      );
      push("L1", l1);
      const l2 = await bounded(i.handle.requestAbort(), i.budget.abortGraceMs, this.clock, stop.signal);
      push("L2", l2);
      let report: DisposeReport;
      try {
        report = i.handle.dispose();
      } catch (e) {
        report = { returned: false, error: info(e), killed: 0, unkillable: [] };
      }
      push("L3", report.returned, report.error?.message);
      const unkillable = [...report.unkillable];
      for (const h of i.handle.killableHandles) {
        try {
          h.kill();
        } catch {
          unkillable.push({ kind: h.kind, id: h.id });
        }
      }
      push("L3p", unkillable.length === 0);
      const orphaned = !report.returned || unkillable.length > 0;
      if (orphaned)
        this.registry.register({
          runId: i.runId,
          sessionId: i.handle.sessionId,
          phase: i.phase,
          reason: i.cause ?? "timeout",
          registeredAt: this.clock.now(),
          unkillable,
          lateArrival: false,
        });
      return { disposed: report.returned, orphaned, escalation: esc, unkillable };
    } catch (e) {
      push("L3", false, info(e).message);
      return { disposed: false, orphaned: true, escalation: esc, unkillable: [] };
    } finally {
      this.active.delete(key);
    }
  }
  abortReap(runId: RunId, generation: number) {
    this.active.get(`${runId}:${generation}`)?.abort();
  }
  disposeLate(runId: RunId, generation: number, h: SessionHandle) {
    const r = h.dispose();
    if (r.returned && !r.unkillable.length) this.registry.recordLateRecovered(runId, generation);
    else
      this.registry.register({
        runId,
        sessionId: h.sessionId,
        phase: "session_create",
        reason: "session_create" as TimeoutReason,
        registeredAt: this.clock.now(),
        unkillable: [...r.unkillable],
        lateArrival: true,
      });
  }
}
function bounded<T>(p: Promise<T>, ms: number, clock: Clock, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        clock.clearTimer(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      }
    };
    const onAbort = () => finish(false);
    const timer = clock.setTimer(Math.max(0, ms), () => finish(false));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      () => finish(true),
      () => finish(false),
    ).catch(() => finish(false));
  });
}
