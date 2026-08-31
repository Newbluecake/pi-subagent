import type { SubagentExtensionPoints } from "../core/types.js";

function warn(hook: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[pi-subagent] extension hook ${hook} threw (ignored): ${message}`);
}

/**
 * Merge N SubagentExtensionPoints (architecture §7.1) into a single one.
 * This is the "simple extensions: SubagentExtensionPoints[] merge entry"
 * index.ts assembles into (I7: index.ts stays assembly-only; future
 * milestones push their hooks into the array there, not here).
 *
 * - H1 onLifecycle / H4 onDelivery: fan-out, read-only bypass observers.
 *   Every extension is called even if an earlier one throws; a throw is
 *   caught, WARN-logged, and never reaches the caller (architecture: "返回值
 *   被忽略，异常被捕获并 WARN").
 * - H2 resolveSessionSpec: composed in registration order (each extension's
 *   output feeds the next one's input). A throw here is deliberately NOT
 *   swallowed — H2 is a bounded pre-hook whose failure must fail the run
 *   (`failed(config)`), not silently continue. The caller applies the
 *   startupMs-scale timeout (architecture: "调用方施加 startupMs 超时").
 * - H3 beforeReap: run sequentially; each extension's failure/timeout is
 *   caught and logged but never blocks the remaining extensions or the
 *   caller's physical reclaim — H3 must stay bounded and diagnostic-only.
 */
export function mergeExtensionPoints(points: readonly SubagentExtensionPoints[]): SubagentExtensionPoints {
  const active = points.filter((p): p is SubagentExtensionPoints => Boolean(p));
  const merged: SubagentExtensionPoints = {};

  if (active.some((p) => p.onLifecycle)) {
    merged.onLifecycle = (e) => {
      for (const p of active) {
        if (!p.onLifecycle) continue;
        try {
          p.onLifecycle(e);
        } catch (err) {
          warn("onLifecycle", err);
        }
      }
    };
  }

  if (active.some((p) => p.resolveSessionSpec)) {
    merged.resolveSessionSpec = async (spec, req) => {
      let current = spec;
      for (const p of active) {
        if (!p.resolveSessionSpec) continue;
        current = await p.resolveSessionSpec(current, req);
      }
      return current;
    };
  }

  if (active.some((p) => p.beforeReap)) {
    merged.beforeReap = async (outcome, ctx) => {
      for (const p of active) {
        if (!p.beforeReap) continue;
        try {
          await p.beforeReap(outcome, ctx);
        } catch (err) {
          warn("beforeReap", err);
        }
      }
    };
  }

  if (active.some((p) => p.onDelivery)) {
    merged.onDelivery = (payload, state) => {
      for (const p of active) {
        if (!p.onDelivery) continue;
        try {
          p.onDelivery(payload, state);
        } catch (err) {
          warn("onDelivery", err);
        }
      }
    };
  }

  return merged;
}
