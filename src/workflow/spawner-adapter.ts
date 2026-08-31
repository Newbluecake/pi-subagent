import type { StopCause } from "../core/types.js";
import type { AgentTypeRegistry } from "../config/agent-types.js";
import type { ChildOutcome, ChildSpawnError, ChildSpawnResult, ChildSpawner } from "./host.js";
import type { SpawnService } from "../service/spawn-service.js";

/**
 * M3.6 (workflow design §11 M3.6, blocker fix §6.3 E2): the production
 * `ChildSpawner` \u2014 a thin adapter over the real `SpawnService` +
 * `AgentTypeRegistry`, assembled once per session in `stack.ts` (D7/I7:
 * `src/workflow/**` stays decoupled from `src/service/**` concrete types,
 * WI2 \u2014 this file lives *outside* `src/workflow/**` for exactly that
 * reason, mirroring where `runtime-adapter.ts` sits relative to
 * `runtime/runner.ts`).
 *
 * `SpawnService.spawn`/`waitAll` are already structurally compatible with
 * `ChildSpawner` (host.ts's own doc comment) \u2014 the only real work here is
 * (a) narrowing `StopCause` (a small closed union) down from the
 * `ChildSpawner` surface's plain `string` `cause` parameter, since a
 * workflow-internal stop cause (`"runaway"`, `"script_error"`,
 * `"phase_timeout"`, \u2026) has no matching core `StopCause` member, and
 * (b) wiring `configHashOf` to the real `AgentTypeRegistry` (the Blocker fix
 * \u2014 without this, `host.ts` fails closed on replay for every call, which
 * is the *safe* default but not the *useful* one).
 */
function toCoreStopCause(cause?: string): StopCause | undefined {
  switch (cause) {
    case "user_stop":
    case "timeout":
    case "shutdown":
    case "parent_abort":
    case "parent_gone":
      return cause;
    case undefined:
      return undefined;
    default:
      // "runaway" / "script_error" / "worker_died" / "phase_timeout" / any
      // future WorkflowStopCause member: all describe "this workflow's own
      // owner decided to stop it", which is exactly core's `parent_abort`.
      return "parent_abort";
  }
}

export function createWorkflowChildSpawner(spawn: SpawnService, types: AgentTypeRegistry): ChildSpawner {
  return {
    async spawn(req): Promise<ChildSpawnResult | ChildSpawnError> {
      const result = await spawn.spawn({
        type: req.type,
        prompt: req.prompt,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.deadlineAt !== undefined ? { deadlineAt: req.deadlineAt } : {}),
        ...(req.parentRunId !== undefined ? { parentRunId: req.parentRunId } : {}),
        // §4.4.3 BW1/BW3: the workflow-derived relative budget, forwarded
        // verbatim \u2014 `SpawnRequest.budgetOverride` is `Partial<DeadlineBudget>`,
        // a strict superset of `{ totalMs?, queueWaitMs? }`.
        ...(req.budgetOverride !== undefined ? { budgetOverride: req.budgetOverride } : {}),
        // D-W3 (§5.4 / D4 front-condition 4): workflow children *do* go
        // through the core `SlotPool` like any other run — `slotless` is
        // deliberately left unset (defaults to `false`) rather than forced
        // `true`. The workflow's own `maxParallel` (run-budget.ts's RW5
        // `min(4, concurrencyLimit-1)`) is a *local* gate layered on top of,
        // never a substitute for, T1's queue-timeout protection.
      });
      return "error" in result ? { error: { message: result.error.message } } : { runId: result.runId };
    },
    abort(runId, cause) {
      return spawn.abort(runId, toCoreStopCause(cause));
    },
    async waitAll(opts): Promise<{ settled: ChildOutcome[]; pending: string[] }> {
      const { settled, pending } = await spawn.waitAll({ runIds: opts.runIds });
      return {
        settled: settled.map((o) => ({
          runId: o.runId,
          status: o.status,
          ...(o.text !== undefined ? { text: o.text } : {}),
          ...(o.error !== undefined ? { error: { message: o.error.message } } : {}),
          ...(o.usage !== undefined ? { usage: o.usage } : {}),
        })),
        pending,
      };
    },
    async stopChildrenOf(parentRunId, cause) {
      return spawn.stopChildrenOf(parentRunId, toCoreStopCause(cause));
    },
    configHashOf(type) {
      return types.configHashOf(type);
    },
  };
}
