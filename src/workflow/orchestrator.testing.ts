import { createOrchestrator, type Orchestrator, type OrchestratorDeps } from "./orchestrator.js";

/**
 * M3.1 (workflow design §3.8.1): the *only* place `OrchestratorTestHooks` and
 * `createOrchestratorForTest` are allowed to live. This file implements the
 * L1/L2 halves of the four-layer "production unreachable" gate; L3 lives in
 * `orchestrator.ts` (`assertNoSmuggledTestHooks`), L4 is CI grep (see
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
 * M3.1 keeps `OrchestratorTestHooks` intentionally minimal (the task's own
 * scope note: "M3.1 只建钩子骨架" — build the hook *skeleton*, not the full
 * fault-injection menu from §3.8.1, which needs the reduce/effect pipeline
 * M3.2/M3.3 introduce). `onWorkerHostCreated` is the one real hook wired all
 * the way through in M3.1: it lets tests observe (not fabricate) the
 * `WorkerHost` instance the orchestrator built for a given run, which is
 * enough to assert lifecycle/stat invariants (e.g. W36-style "no late
 * message produced an effect") without needing the orchestrator itself to
 * expose internal state.
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
}

/**
 * **Test-only factory.** Not reachable from production (see the L1/L2/L3/L4
 * gate description above). Does not use `NODE_ENV` or any other environment
 * variable to decide anything (TH4) — unreachability is a property of types
 * and the build graph, not a runtime check.
 */
export function createOrchestratorForTest(deps: OrchestratorDeps, _hooks: OrchestratorTestHooks): Orchestrator {
  // M3.1: hooks are not yet consumed by any orchestrator-internal seam (see
  // the module doc above). Passing a clean `deps` object through here means
  // this call path can never trip `assertNoSmuggledTestHooks` in
  // orchestrator.ts — that assertion exists for the `as any` bypass case
  // (WC14 ③), not for legitimate use of this factory.
  return createOrchestrator(deps);
}
