import {
  createOrchestratorImpl,
  type Orchestrator,
  type OrchestratorDeps,
  type OrchestratorInternalHooks,
  type WorkflowEffectKind,
} from "./orchestrator.js";
import type { Millis } from "../core/types.js";
import type { WorkflowId } from "./types.js";

/**
 * M3.1/M3.3 (workflow design §3.8.1): the *only* place `OrchestratorTestHooks`
 * and `createOrchestratorForTest` are allowed to live. This file implements
 * the L1/L2 halves of the four-layer "production unreachable" gate; L3 lives
 * in `orchestrator.ts` (`assertNoSmuggledTestHooks`), L4 is CI grep (see
 * tests/workflow/wc14-testhooks-gate.test.ts).
 *
 * L1 (type layer): `OrchestratorDeps` (orchestrator.ts) has no `__testHooks`
 *   field. A production call site that tries
 *   `createOrchestrator({ ...deps, __testHooks: hooks })` as an *object
 *   literal* fails TypeScript's excess-property check — there is no type an
 *   assembler could write that both satisfies `OrchestratorDeps` and carries
 *   the hooks. (Assigning through an intermediate `as any` still exists as an
 *   escape hatch, which is exactly what L3 is for.)
 * L2 (build layer): this file is listed in `tsconfig.build.json`'s `exclude`
 *   and is not reachable from `src/index.ts`'s import graph, so `dist/`
 *   built via `tsc -p tsconfig.build.json` never contains it at all — not
 *   "disabled by a flag", physically absent.
 *
 * M3.3 known deviation from the full §3.8.1 gate (documented, not silent):
 * `createOrchestratorImpl` and `OrchestratorInternalHooks` are plain exports
 * of `orchestrator.ts` (production file), not physically absent from
 * `dist/` the way the full design's L2 wants for the hooks *themselves*.
 * Nothing under `src/index.ts`/`src/tools/**`/`src/commands/**`/`src/ui/**`
 * imports them (WC14's L4 grep still passes), so they are inert in
 * production, but a determined production call site *could* `import` them
 * directly (unlike `OrchestratorTestHooks`/`createOrchestratorForTest`,
 * which truly cannot be reached — this file is excluded from the build).
 * Tightening this further (e.g. moving the effect-hook branching entirely
 * into this file via a richer injected interpreter) is listed in the M3.3
 * hand-off backlog.
 */
export interface OrchestratorTestHooks {
  /**
   * Fired once per `run()` call, right after the orchestrator constructs the
   * `WorkerHost` for that run (via `deps.createWorkerHost()`) and before
   * `boot()` is called on it. Purely observational — throwing here is not
   * caught and will fail the test loudly rather than silently altering
   * orchestrator behavior (TH3: hooks must not be able to bypass state
   * machine invariants).
   */
  onWorkerHostCreated?(workflowId: string): void;

  /**
   * §3.8.1: fired before each of the six WL0–WL4 effects this milestone's
   * pipeline applies (`close_gate` / `stop_owned` / `terminate_worker` /
   * `commit_terminal` / `reconcile_children` / `resolve_settled`).
   * `"proceed"` (default) applies it normally; `"skip"` omits it entirely;
   * `"throw"` makes applying it fail (exercises EI2/EI5 fallback paths);
   * `{ delayMs }` delays application by that many (fake-clock) ms.
   */
  beforeEffect?(
    kind: WorkflowEffectKind,
    ctx: { readonly workflowId: WorkflowId },
  ): "proceed" | "skip" | "throw" | { readonly delayMs: Millis };

  /** W37/WP2: observes each effect actually being applied, once, in order — for "every WL step ran exactly once" assertions. */
  onEffectApplied?(kind: WorkflowEffectKind, workflowId: WorkflowId, at: Millis): void;

  /** W39/W39b: delay or permanently suppress the ② `resolve_settled` delivery (`settled()`/`run()`'s own resolution). */
  settledDelivery?: "normal" | "suppress" | { readonly delayMs: Millis };
}

/**
 * **Test-only factory.** Not reachable from production (see the L1/L2/L3/L4
 * gate description above). Does not use `NODE_ENV` or any other environment
 * variable to decide anything (TH4) — unreachability is a property of types
 * and the build graph, not a runtime check.
 */
export function createOrchestratorForTest(deps: OrchestratorDeps, hooks: OrchestratorTestHooks): Orchestrator {
  const internal: OrchestratorInternalHooks = {
    ...(hooks.beforeEffect ? { beforeEffect: hooks.beforeEffect } : {}),
    ...(hooks.onEffectApplied ? { onEffectApplied: hooks.onEffectApplied } : {}),
    ...(hooks.settledDelivery !== undefined ? { settledDelivery: hooks.settledDelivery } : {}),
  };
  const wrappedDeps: OrchestratorDeps = hooks.onWorkerHostCreated
    ? {
        ...deps,
        createWorkerHost: () => {
          // M3.1: purely observational (see the interface doc above) — this
          // wrapper cannot tell `createOrchestratorImpl` *which* workflowId a
          // given `createWorkerHost()` call is for (that context lives
          // inside `run()`), so tests that need it correlate via call order
          // or a single-run scenario. Widening this is a straightforward
          // follow-up if a multi-run test ever needs per-id correlation.
          hooks.onWorkerHostCreated?.("");
          return deps.createWorkerHost();
        },
      }
    : deps;
  return createOrchestratorImpl(wrappedDeps, internal);
}
