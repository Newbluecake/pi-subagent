import type { NodeRef, MessageRelation } from "../core/message.js";

export type TreeTargetState = "pending_start" | "running" | "gone";

type Tombstone = { readonly settledAt: number; readonly expiresAt: number };

export class FabricTree {
  private readonly edges = new Map<NodeRef, NodeRef>();
  private readonly tombstones = new Map<NodeRef, Tombstone>();
  private readonly goneNodes = new Set<NodeRef>();
  private readonly pendingStarts = new Set<NodeRef>();

  append(from: NodeRef, to: NodeRef): void {
    if (from === to) throw new Error("tree edge cannot self-reference");
    const existing = this.edges.get(to);
    if (existing !== undefined && existing !== from) throw new Error("tree node already has a parent");
    if (this.isAncestor(to, from)) throw new Error("tree edge would create a cycle");
    this.edges.set(to, from);
    this.pendingStarts.add(to);
  }

  appendEdge(parent: NodeRef, child: NodeRef): void {
    this.append(parent, child);
  }

  tombstone(node: NodeRef, settledAt: number, reconcileTtlMs: number): void {
    this.tombstones.set(node, { settledAt, expiresAt: settledAt + Math.max(0, reconcileTtlMs) });
    this.goneNodes.add(node);
    this.pendingStarts.delete(node);
  }

  relation(from: NodeRef, to: NodeRef, now = Number.POSITIVE_INFINITY): MessageRelation {
    if (from === to) return "self";
    if (this.isAncestor(from, to)) return this.depthBetween(from, to) === 1 ? "parent" : "ancestor";
    if (this.isAncestor(to, from)) return this.depthBetween(to, from) === 1 ? "child" : "descendant";
    if (this.edges.get(from) !== undefined && this.edges.get(from) === this.edges.get(to)) return "sibling";
    return "unrelated";
  }

  lca(a: NodeRef, b: NodeRef): NodeRef | undefined {
    const ancestors = new Set<NodeRef>();
    let current: NodeRef | undefined = a;
    while (current !== undefined) {
      ancestors.add(current);
      current = this.edges.get(current);
    }
    current = b;
    while (current !== undefined) {
      if (ancestors.has(current)) return current;
      current = this.edges.get(current);
    }
    return undefined;
  }

  hops(from: NodeRef, to: NodeRef): NodeRef[] {
    const common = this.lca(from, to);
    if (common === undefined) return [];
    const up: NodeRef[] = [];
    let current: NodeRef | undefined = from;
    while (current !== undefined && current !== common) {
      up.push(current);
      current = this.edges.get(current);
    }
    const down: NodeRef[] = [];
    current = to;
    while (current !== undefined && current !== common) {
      down.push(current);
      current = this.edges.get(current);
    }
    return [...up, common, ...down.reverse()];
  }

  isRootChild(node: NodeRef): boolean {
    return this.edges.get(node) === "root";
  }

  targetState(node: NodeRef, now = Number.POSITIVE_INFINITY): TreeTargetState {
    if (node === "root" || node === "system") return "running";
    if (this.goneNodes.has(node)) return "gone";
    if (this.pendingStarts.has(node)) return "pending_start";
    if (!this.edges.has(node)) return "gone";
    return "running";
  }

  isAncestor(ancestor: NodeRef, node: NodeRef): boolean {
    let current = this.edges.get(node);
    while (current !== undefined) {
      if (current === ancestor) return true;
      current = this.edges.get(current);
    }
    return false;
  }

  private depthBetween(ancestor: NodeRef, node: NodeRef): number {
    let depth = 0;
    let current = this.edges.get(node);
    while (current !== undefined) {
      depth++;
      if (current === ancestor) return depth;
      current = this.edges.get(current);
    }
    return Number.POSITIVE_INFINITY;
  }

  markRunning(node: NodeRef): void {
    if (node !== "root" && node !== "system") this.pendingStarts.delete(node);
  }

  markPendingStart(node: NodeRef): void {
    if (node !== "root" && node !== "system") this.pendingStarts.add(node);
  }

  sweep(now: number): number {
    let removed = 0;
    for (const [node, tombstone] of this.tombstones) {
      if (now > tombstone.expiresAt) {
        this.tombstones.delete(node);
        removed++;
      }
    }
    return removed;
  }

  get edgeCount(): number {
    return this.edges.size;
  }
}

export function createFabricTree(): FabricTree {
  return new FabricTree();
}
