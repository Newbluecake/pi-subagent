import type { Clock, TimerHandle } from "../core/clock.js";
import type { FabricRecord, MessageChannel, NodeRef } from "../core/message.js";
import { effectiveChannel } from "../core/message.js";
import { newRunId } from "../core/ids.js";
import type { DeliveryEngine } from "../delivery/engine.js";
import type { FabricRouter } from "./router.js";
import type { FabricThrottle } from "./throttle.js";

export type Verdict =
  | { ok: true }
  | { ok: false; retryable: true; reason: string }
  | { ok: false; retryable: false; reason: "target_gone" | "policy" };
export interface FabricPorts {
  inject(record: FabricRecord): Promise<Verdict>;
  sendRootContext(record: FabricRecord): Promise<Verdict>;
  sendRootDisplay(record: FabricRecord): Promise<Verdict>;
}
export interface MailboxOptions {
  engine: DeliveryEngine<FabricRecord, FabricRecord["state"]>;
  router: FabricRouter;
  throttle: FabricThrottle;
  ports: FabricPorts;
  clock: Clock;
  fabricSteerTimeoutMs: number;
  progressChannel?: MessageChannel;
  canRenderEntries?: boolean;
  maxAttempts: number;
  onDegraded?: (error: unknown) => void;
}

export class FabricMailbox {
  readonly mailboxInstanceId = newRunId();
  private wake: TimerHandle | undefined;
  private readonly raceTimers = new Set<TimerHandle>();
  private readonly inFlight = new Map<NodeRef, string>();
  private readonly settled = new Set<NodeRef>();
  private frozen = false;
  constructor(private readonly options: MailboxOptions) {}

  pump(hint?: NodeRef): void {
    if (this.frozen) return;
    const targets =
      hint === undefined
        ? [...new Set(this.options.engine.select((r) => r.state === "pending").map((r) => r.to))]
        : [hint];
    const gone: FabricRecord[] = [];
    for (const target of targets) {
      const candidates = this.options.engine
        .select((r) => r.state === "pending" && r.to === target)
        .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
      for (const record of candidates) {
        const now = this.options.clock.now();
        if (now - record.createdAt > record.ttlMs) {
          if (record.kind === "finding" || record.kind === "directive")
            this.options.router.issueDeadLetter(record, "ttl_expired");
          else this.options.engine.transition(record.key, "pending", "abandoned", { terminalReason: "ttl_expired" });
          continue;
        }
        const targetState = this.options.router.targetState(record.to);
        if (targetState === "gone") {
          if (record.kind === "finding" || record.kind === "directive") gone.push(record);
          else this.options.engine.transition(record.key, "pending", "dropped", { terminalReason: "target_gone" });
          continue;
        }
        if (targetState === "pending_start") continue;
        if (this.inFlight.has(target) || now < this.options.throttle.eligibleAt(record)) continue;
        const token = `${this.mailboxInstanceId}:${record.attempts}`;
        const claimed = this.options.engine.claim(record.key, token);
        if (claimed === undefined) continue;
        this.inFlight.set(target, record.key);
        this.dispatch(claimed, token);
        break;
      }
    }
    const goneBySender = new Map<string, FabricRecord[]>();
    for (const record of gone) {
      const batch = goneBySender.get(record.from) ?? [];
      batch.push(record);
      goneBySender.set(record.from, batch);
    }
    for (const batch of goneBySender.values()) this.options.router.issueDeadLetters(batch, "target_gone");
    this.rescheduleWake();
  }

  onRunSettled(from: NodeRef): void {
    this.settled.add(from);
    this.options.router.onRunSettled(from);
    this.pump(from);
  }

  dispose(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.options.engine.freeze();
    if (this.wake) this.options.clock.clearTimer(this.wake);
    this.wake = undefined;
    for (const timer of this.raceTimers) this.options.clock.clearTimer(timer);
    this.raceTimers.clear();
    this.inFlight.clear();
    this.options.router.freeze();
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }
  get pendingRaceTimers(): number {
    return this.raceTimers.size;
  }

  private dispatch(record: FabricRecord, token: string): void {
    void this.boundedSend(record).then((verdict) => this.verdict(record.key, token, verdict));
  }

  private boundedSend(record: FabricRecord): Promise<Verdict> {
    return new Promise((resolve) => {
      let done = false;
      let sender: Promise<Verdict>;
      try {
        sender =
          record.to === "root"
            ? effectiveChannel(
                record.kind,
                this.options.progressChannel ?? "display",
                this.options.canRenderEntries ?? true,
                record.to,
              ) === "context"
              ? this.options.ports.sendRootContext(record)
              : this.options.ports.sendRootDisplay(record)
            : this.options.ports.inject(record);
      } catch (error) {
        sender = Promise.reject(error);
      }
      let timer: TimerHandle | undefined;
      const finish = (verdict: Verdict): void => {
        if (done) return;
        done = true;
        if (timer) {
          this.options.clock.clearTimer(timer);
          this.raceTimers.delete(timer);
        }
        resolve(verdict);
      };
      timer = this.options.clock.setTimer(Math.max(0, this.options.fabricSteerTimeoutMs), () =>
        finish({ ok: false, retryable: true, reason: "steer_timeout" }),
      );
      this.raceTimers.add(timer);
      Promise.resolve(sender).then(finish, (error) => finish(this.toVerdict(error)));
    });
  }

  private verdict(key: string, token: string, verdict: Verdict): void {
    if (this.frozen) return;
    const record = this.options.engine.get(key);
    if (!record || record.state !== "claimed" || record.claimToken !== token) return;
    const target = record.to;
    const attempts = record.attempts + 1;
    if (verdict.ok) {
      const delivered = this.options.engine.transition(key, "claimed", "delivered", {
        attempts,
        deliveredAt: this.options.clock.now(),
      });
      if (delivered) this.options.throttle.noteDelivered(delivered, delivered.deliveredAt ?? this.options.clock.now());
    } else if (
      verdict.retryable &&
      attempts < this.options.maxAttempts &&
      record.kind === "progress" &&
      this.settled.has(record.from)
    ) {
      this.options.engine.transition(key, "claimed", "consumed", { attempts, terminalReason: "sender_settled" });
    } else if (verdict.retryable && attempts < this.options.maxAttempts) {
      this.options.engine.transition(key, "claimed", "pending", { attempts });
    } else if (verdict.retryable) {
      if (record.kind === "finding" || record.kind === "directive")
        this.options.router.issueDeadLetter({ ...record, attempts }, "attempts_exhausted");
      else
        this.options.engine.transition(key, "claimed", "dropped", { attempts, terminalReason: "attempts_exhausted" });
    } else if (verdict.reason === "target_gone") {
      if (record.kind === "finding" || record.kind === "directive")
        this.options.router.issueDeadLetter({ ...record, attempts }, "target_gone");
      else this.options.engine.transition(key, "claimed", "dropped", { attempts, terminalReason: "target_gone" });
    } else {
      console.warn(`[pi-subagent] fabric policy rejection for ${key}: ${verdict.reason}`);
      this.options.engine.transition(key, "claimed", "dropped", { attempts, terminalReason: "policy" });
    }
    this.inFlight.delete(target);
    this.pump(target);
  }

  private rescheduleWake(): void {
    if (this.frozen) return;
    if (this.wake) this.options.clock.clearTimer(this.wake);
    this.wake = undefined;
    const now = this.options.clock.now();
    let due = Number.POSITIVE_INFINITY;
    for (const record of this.options.engine.select((r) => r.state === "pending"))
      due = Math.min(due, this.options.throttle.eligibleAt(record), record.createdAt + record.ttlMs);
    if (Number.isFinite(due))
      this.wake = this.options.clock.setTimer(Math.max(0, due - now), () => {
        this.wake = undefined;
        this.pump();
      });
  }

  private toVerdict(error: unknown): Verdict {
    const message = error instanceof Error ? error.message : String(error);
    if (/no active session/i.test(message)) return { ok: false, retryable: false, reason: "target_gone" };
    if (/policy/i.test(message)) return { ok: false, retryable: false, reason: "policy" };
    return { ok: false, retryable: true, reason: message };
  }
}
export const createFabricMailbox = (options: MailboxOptions): FabricMailbox => new FabricMailbox(options);
