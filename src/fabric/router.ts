import type { DeliveryEngine } from "../delivery/engine.js";
import {
  authorize,
  effectiveChannel,
  makeMessageKey,
  type FabricRecord,
  type MessageChannel,
  type MessageKey,
  type MessageKind,
  type NodeRef,
} from "../core/message.js";
import type { FabricTree, TreeTargetState } from "./tree.js";
import type { FabricThrottle } from "./throttle.js";

export interface FabricRouterConfig {
  maxPerRun: number;
  findingQuota: number;
  directiveQuota: number;
  deadLetterQuota: number;
  maxChars: number;
  progressTtlMs: number;
  reconcileTtlMs: number;
  progressChannel?: MessageChannel;
  canRenderEntries?: boolean;
  rootInboxCap: number;
}
export interface AdmissionInput {
  to: NodeRef;
  kind: MessageKind;
  text: string;
  generation: number;
  canMessage?: readonly ("parent" | "child" | "ancestor" | "descendant" | "sibling" | "self")[];
}
export type AdmissionResult =
  | { ok: true; status: "accepted"; key: MessageKey; seq: number; superseded?: MessageKey }
  | {
      ok: false;
      status: "quota_exhausted";
      key: MessageKey;
      seq: number;
      kind: MessageKind;
      used: number;
      quota: number;
    }
  | { ok: false; status: "target_backpressure"; key: MessageKey; seq: number; retryAfterMs: number };
export type DeadLetterOutcome =
  { status: "issued"; key: MessageKey } | { status: "suppressed_quota" | "suppressed_sender_gone" };

const terminalFor = (reason: NonNullable<FabricRecord["deadLetter"]>["reason"]): FabricRecord["state"] =>
  reason === "ttl_expired" ? "abandoned" : "dropped";
const truncate = (text: string, max: number): string =>
  [...text].length <= max
    ? text
    : [...text].slice(0, Math.ceil(max * 0.75)).join("") + [...text].slice(-Math.floor(max * 0.25)).join("");

export class FabricRouter {
  private readonly used = new Map<NodeRef, Record<"progress" | "finding" | "directive", number>>();
  private readonly deadLetterUsed = new Map<NodeRef, number>();
  private readonly dlRefs = new Map<MessageKey, DeadLetterOutcome>();
  private seq = new Map<string, number>();
  private frozen = false;
  constructor(
    private readonly engine: DeliveryEngine<FabricRecord, FabricRecord["state"]>,
    private readonly tree: FabricTree,
    private readonly throttle: FabricThrottle,
    private readonly config: FabricRouterConfig,
    private readonly now: () => number,
    private readonly onChanged: () => void = () => undefined,
  ) {}

  hydrate(records: readonly FabricRecord[]): void {
    for (const r of records) {
      this.seq.set(this.link(r.from, r.to), Math.max(this.seq.get(this.link(r.from, r.to)) ?? 0, r.seq));
      if (r.rejected === undefined && (r.kind === "progress" || r.kind === "finding" || r.kind === "directive"))
        this.count(r.from, r.kind);
      if (r.kind === "dead_letter" && r.to !== "system" && r.ref) {
        for (const key of r.ref.keys) this.dlRefs.set(key, { status: "issued", key: r.key });
        this.deadLetterUsed.set(r.to, (this.deadLetterUsed.get(r.to) ?? 0) + 1);
      }
      if (r.deadLetter && (r.deadLetter.status !== "issued" || r.deadLetter.key))
        this.dlRefs.set(
          r.key,
          r.deadLetter.status === "issued"
            ? { status: "issued", key: r.deadLetter.key! }
            : { status: r.deadLetter.status },
        );
    }
  }

  admit(from: NodeRef, input: AdmissionInput): AdmissionResult {
    if (this.frozen) throw new Error("shutting down");
    if (this.tree.targetState(from, this.now()) !== "running") throw new Error("sender is not running");
    const relation = this.tree.relation(from, input.to, this.now());
    const authorization =
      input.canMessage === undefined
        ? { kind: input.kind, relation, from }
        : { kind: input.kind, relation, from, canMessage: input.canMessage };
    if (!authorize(authorization)) throw new Error("message not authorized");
    const seq = this.nextSeq(from, input.to);
    const key = makeMessageKey(from, input.to, input.generation, seq);
    const used = this.getUsed(from, input.kind);
    const quota = this.quota(input.kind);
    let rejection: AdmissionResult | undefined;
    if (quota !== undefined && used >= quota)
      rejection = { ok: false, status: "quota_exhausted", key, seq, kind: input.kind, used, quota };
    const channel = effectiveChannel(
      input.kind,
      this.config.progressChannel ?? "display",
      this.config.canRenderEntries ?? true,
      input.to,
    );
    if (!rejection && input.to === "root" && channel === "context" && this.rootInbox() >= this.config.rootInboxCap)
      rejection = { ok: false, status: "target_backpressure", key, seq, retryAfterMs: 0 };
    const record: FabricRecord = {
      key,
      from,
      to: input.to,
      kind: input.kind,
      seq,
      generation: input.generation as never,
      payload: { text: truncate(input.text, this.config.maxChars) },
      ttlMs: input.kind === "progress" ? this.config.progressTtlMs : this.config.reconcileTtlMs,
      createdAt: this.now(),
      updatedAt: this.now(),
      state: rejection ? "dropped" : "pending",
      attempts: 0,
      ...(rejection
        ? { rejected: { reason: rejection.status === "quota_exhausted" ? "quota_exhausted" : "target_backpressure" } }
        : {}),
      ...(from !== "system"
        ? { via: { lca: this.tree.lca(from, input.to) ?? input.to, hops: this.tree.hops(from, input.to) } }
        : {}),
    };
    if (input.kind === "progress" && !rejection) {
      const old = this.engine.select(
        (r) => r.from === from && r.to === input.to && r.kind === "progress" && r.state === "pending",
      )[0];
      if (old) this.engine.transition(old.key, "pending", "consumed", { terminalReason: "superseded" });
    }
    this.engine.put(record);
    if (!rejection && (input.kind === "progress" || input.kind === "finding" || input.kind === "directive"))
      this.count(from, input.kind);
    this.onChanged();
    return rejection ?? { ok: true, status: "accepted", key, seq };
  }

  rootInbox(): number {
    return this.engine.select(
      (r) =>
        r.to === "root" &&
        (r.state === "pending" || r.state === "claimed") &&
        effectiveChannel(
          r.kind,
          this.config.progressChannel ?? "display",
          this.config.canRenderEntries ?? true,
          r.to,
        ) === "context",
    ).length;
  }
  targetState(node: NodeRef): TreeTargetState {
    return this.tree.targetState(node, this.now());
  }
  onRunSettled(from: NodeRef): void {
    for (const r of this.engine.select((r) => r.from === from && r.kind === "progress" && r.state === "pending"))
      this.engine.transition(r.key, "pending", "consumed", { terminalReason: "sender_settled" });
    this.tree.tombstone(from, this.now(), this.config.reconcileTtlMs);
    this.onChanged();
  }
  issueDeadLetter(orig: FabricRecord, reason: NonNullable<FabricRecord["deadLetter"]>["reason"]): void {
    this.issueDeadLetters([orig], reason);
  }
  issueDeadLetters(origs: readonly FabricRecord[], reason: NonNullable<FabricRecord["deadLetter"]>["reason"]): void {
    if (this.frozen || origs.length === 0) return;
    const fresh: FabricRecord[] = [];
    for (const o of origs) {
      const prior = this.dlRefs.get(o.key);
      if (prior)
        this.engine.transition(o.key, ["pending", "claimed"], terminalFor(reason), {
          terminalReason: reason,
          deadLetter:
            prior.status === "issued" ? { reason, status: "issued", key: prior.key } : { reason, status: prior.status },
        });
      else fresh.push(o);
    }
    if (!fresh.length) return;
    const sender = fresh[0]!.from;
    let outcome: DeadLetterOutcome;
    if (this.targetState(sender) === "gone") outcome = { status: "suppressed_sender_gone" };
    else if ((this.deadLetterUsed.get(sender) ?? 0) >= this.config.deadLetterQuota)
      outcome = { status: "suppressed_quota" };
    else {
      const key = makeMessageKey("system", sender, 0, this.nextSeq("system", sender));
      const env: FabricRecord = {
        key,
        from: "system",
        to: sender,
        kind: "dead_letter",
        seq: this.currentSeq("system", sender),
        generation: 0 as never,
        payload: { text: `${fresh.length} delivery failure(s)` },
        ref: { keys: fresh.slice(0, 5).map((r) => r.key), omittedCount: Math.max(0, fresh.length - 5) },
        ttlMs: this.config.reconcileTtlMs,
        createdAt: this.now(),
        updatedAt: this.now(),
        state: "pending",
        attempts: 0,
      };
      try {
        this.engine.put(env);
      } catch (error) {
        throw error;
      }
      this.deadLetterUsed.set(sender, (this.deadLetterUsed.get(sender) ?? 0) + 1);
      outcome = { status: "issued", key };
    }
    for (const o of fresh) this.dlRefs.set(o.key, outcome);
    for (const o of fresh)
      this.engine.transition(o.key, ["pending", "claimed"], terminalFor(reason), {
        terminalReason: reason,
        deadLetter:
          outcome.status === "issued"
            ? { reason, status: "issued", key: outcome.key }
            : { reason, status: outcome.status },
      });
    this.onChanged();
  }
  freeze(): void {
    this.frozen = true;
  }
  private count(from: NodeRef, kind: "progress" | "finding" | "directive"): void {
    const value = this.used.get(from) ?? { progress: 0, finding: 0, directive: 0 };
    value[kind]++;
    this.used.set(from, value);
  }
  private getUsed(from: NodeRef, kind: MessageKind): number {
    return kind === "progress" || kind === "finding" || kind === "directive" ? (this.used.get(from)?.[kind] ?? 0) : 0;
  }
  private quota(kind: MessageKind): number | undefined {
    return kind === "progress"
      ? this.config.maxPerRun
      : kind === "finding"
        ? this.config.findingQuota
        : kind === "directive"
          ? this.config.directiveQuota
          : undefined;
  }
  private link(from: NodeRef, to: NodeRef): string {
    return `${from}:${to}`;
  }
  private nextSeq(from: NodeRef, to: NodeRef): number {
    const link = this.link(from, to);
    const next = (this.seq.get(link) ?? 0) + 1;
    this.seq.set(link, next);
    return next;
  }
  private currentSeq(from: NodeRef, to: NodeRef): number {
    return this.seq.get(this.link(from, to)) ?? 0;
  }
}
export const createFabricRouter = (...args: ConstructorParameters<typeof FabricRouter>): FabricRouter =>
  new FabricRouter(...args);
