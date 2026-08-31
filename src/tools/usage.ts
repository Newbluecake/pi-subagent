import type { UsageDelta } from "../core/types.js";

/**
 * pi's tool-result usage accounting (docs/extensions.md "Usage accounting"):
 * a tool that makes nested LLM calls should return their combined Usage on
 * the tool result — pi persists it on the toolResult message and includes it
 * in the footer, /session and RPC session totals.
 *
 * Map our UsageDelta (flat costUsd) to pi's Usage shape. Per-component cost
 * breakdowns are not tracked per-run (only the total), so components are 0
 * and `cost.total` carries the real number — consumers that sum `cost.total`
 * (pi's footer, pi-hud) see the correct amount.
 */
export function toPiToolUsage(u: UsageDelta): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.costUsd },
  };
}
