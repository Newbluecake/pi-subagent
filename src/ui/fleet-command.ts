import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../core/clock.js";
import type { Millis, RunId } from "../core/types.js";
import type { QueryService } from "../service/query-service.js";
import { buildFleetViewModel, FleetPanel, renderFleetLines } from "./fleet-panel.js";

export interface FleetCommandDeps {
  query: QueryService;
  /** settings.budget.idleMs — enables the yellow half-idle highlight. */
  idleBudgetMs?: Millis;
  /** Panel auto-refresh interval (default 1000ms). */
  refreshMs?: Millis;
  clock?: Clock;
  /** Optional runId → agent-type resolver (RunSnapshot doesn't carry the type yet). */
  typeOf?: (runId: RunId) => string | undefined;
}

/**
 * `/agent fleet` (X7, architecture §7.2): opens the live fleet panel via
 * ctx.ui.custom. In non-interactive modes (rpc/json/print — no TUI) degrades
 * to a one-shot text snapshot through ctx.ui.notify, mirroring /agent status.
 *
 * Wired into the existing /agent command group in commands/status.ts (the
 * "fleet" subcommand dispatches here); index.ts only needs to pass the
 * optional extras (`idleBudgetMs`) through StatusCommandDeps.fleet.
 */
export function createFleetCommand(deps: FleetCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "Open the live subagent fleet panel (phase, elapsed, current tool, escalation, usage).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const now = deps.clock?.now() ?? Date.now();
        const model = buildFleetViewModel(deps.query.list(), {
          now,
          ...(deps.idleBudgetMs !== undefined ? { idleBudgetMs: deps.idleBudgetMs } : {}),
          ...(deps.typeOf ? { typeOf: deps.typeOf } : {}),
        });
        ctx.ui.notify(renderFleetLines(model).join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new FleetPanel({
            query: deps.query,
            done: () => done(),
            tui,
            theme,
            ...(deps.clock ? { clock: deps.clock } : {}),
            ...(deps.refreshMs !== undefined ? { refreshMs: deps.refreshMs } : {}),
            ...(deps.idleBudgetMs !== undefined ? { idleBudgetMs: deps.idleBudgetMs } : {}),
            ...(deps.typeOf ? { typeOf: deps.typeOf } : {}),
          }),
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "70%", anchor: "center" } },
      );
    },
  };
}
