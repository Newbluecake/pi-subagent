import type { FabricRecord, MessageChannel, NodeRef } from "../core/message.js";
import { effectiveChannel } from "../core/message.js";

export interface ThrottleOptions {
  minIntervalMs: number;
  rootMinIntervalMs: number;
  backoffMs: number;
  progressChannel?: MessageChannel;
  canRenderEntries?: boolean;
  records?: readonly FabricRecord[];
  now?: () => number;
}

export class FabricThrottle {
  private readonly linkNotBefore = new Map<string, number>();
  private rootNotBeforeValue = 0;
  private readonly options: Required<Omit<ThrottleOptions, "records" | "now">>;

  constructor(options: ThrottleOptions) {
    this.options = {
      minIntervalMs: Math.max(0, options.minIntervalMs),
      rootMinIntervalMs: Math.max(0, options.rootMinIntervalMs),
      backoffMs: Math.max(0, options.backoffMs),
      progressChannel: options.progressChannel ?? "display",
      canRenderEntries: options.canRenderEntries ?? true,
    };
    this.rebuild(options.records ?? []);
  }

  rebuild(records: readonly FabricRecord[]): void {
    this.linkNotBefore.clear();
    this.rootNotBeforeValue = 0;
    for (const record of records) {
      if (record.state !== "delivered" || record.deliveredAt === undefined) continue;
      const link = this.linkKey(record.from, record.to);
      this.linkNotBefore.set(
        link,
        Math.max(this.linkNotBefore.get(link) ?? 0, record.deliveredAt + this.options.minIntervalMs),
      );
      if (
        record.to === "root" &&
        effectiveChannel(record.kind, this.options.progressChannel, this.options.canRenderEntries, record.to) ===
          "context"
      ) {
        if (this.options.rootMinIntervalMs > 0)
          this.rootNotBeforeValue = Math.max(
            this.rootNotBeforeValue,
            record.deliveredAt + this.options.rootMinIntervalMs,
          );
      }
    }
  }

  backoffUntil(record: Pick<FabricRecord, "attempts" | "updatedAt" | "state">): number {
    if (record.state !== "pending" || record.attempts <= 0 || this.options.backoffMs === 0) return 0;
    return record.updatedAt + this.options.backoffMs * 2 ** (record.attempts - 1);
  }

  eligibleAt(record: FabricRecord): number {
    return Math.max(this.notBefore(record.from, record.to), this.rootNotBefore(record), this.backoffUntil(record));
  }

  notBefore(from: NodeRef, to: NodeRef): number {
    return this.linkNotBefore.get(this.linkKey(from, to)) ?? 0;
  }

  rootNotBefore(record?: Pick<FabricRecord, "to" | "kind">): number {
    if (
      record === undefined ||
      record.to !== "root" ||
      effectiveChannel(record.kind, this.options.progressChannel, this.options.canRenderEntries, record.to) !==
        "context"
    )
      return 0;
    return this.rootNotBeforeValue;
  }

  noteDelivered(record: FabricRecord, at: number): void {
    const value = at + this.options.minIntervalMs;
    const link = this.linkKey(record.from, record.to);
    this.linkNotBefore.set(link, Math.max(this.linkNotBefore.get(link) ?? 0, value));
    if (
      record.to === "root" &&
      effectiveChannel(record.kind, this.options.progressChannel, this.options.canRenderEntries, record.to) ===
        "context"
    ) {
      if (this.options.rootMinIntervalMs > 0)
        this.rootNotBeforeValue = Math.max(this.rootNotBeforeValue, at + this.options.rootMinIntervalMs);
    }
  }

  private linkKey(from: NodeRef, to: NodeRef): string {
    return `${from}\u0000${to}`;
  }
}

export const createFabricThrottle = (options: ThrottleOptions): FabricThrottle => new FabricThrottle(options);
