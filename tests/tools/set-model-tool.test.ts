import { describe, expect, it } from "vitest";
import type { Text } from "@earendil-works/pi-tui";
import { FakeClock } from "../../src/core/clock.js";
import { resolveModelHint, type ModelCandidate } from "../../src/config/model-hint.js";
import type { SetModelOutcome } from "../../src/core/types.js";
import { createSetModelTool, type SetModelToolDeps } from "../../src/tools/set-model-tool.js";

const candidates: ModelCandidate[] = [
  { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { provider: "anthropic", id: "claude-haiku-4", name: "Claude Haiku 4" },
  { provider: "copilot-completion", id: "kimi-k3", name: "Kimi K3" },
];

const never = <T>() => new Promise<T>(() => undefined);

interface HostSpy {
  level: string | undefined;
  setModelResult: boolean | Promise<boolean>;
  setModelCalls: unknown[];
  thinkingWrites: string[];
}
function hostSpy(init: Partial<HostSpy> = {}): { deps: NonNullable<SetModelToolDeps["host"]>; spy: HostSpy } {
  const spy: HostSpy = {
    level: "medium",
    setModelResult: true,
    setModelCalls: [],
    thinkingWrites: [],
    ...init,
  };
  return {
    spy,
    deps: {
      setModel: (model) => {
        spy.setModelCalls.push(model);
        return Promise.resolve(spy.setModelResult);
      },
      getThinkingLevel: () => spy.level,
      setThinkingLevel: (level) => {
        spy.thinkingWrites.push(level);
        spy.level = level;
      },
      findModel: (provider, id) => candidates.find((c) => c.provider === provider && c.id === id),
    },
  };
}

function makeDeps(overrides: Partial<SetModelToolDeps> = {}): SetModelToolDeps {
  const { deps: host } = hostSpy();
  const deps: SetModelToolDeps = {
    host,
    runs: {
      setModel: async (_runId, model) => ({ ok: true, model }),
    },
    resolveHint: (hint) => resolveModelHint(hint, candidates),
    available: () => candidates,
    resolveRun: (handle) => ({ ok: true, runId: `resolved:${handle}` }),
  };
  Object.assign(deps, overrides);
  // exactOptionalPropertyTypes: "host: undefined" in overrides means "delete".
  if ("host" in overrides && overrides.host === undefined) delete deps.host;
  return deps;
}
function runTool(deps: SetModelToolDeps, params: Record<string, unknown>) {
  return createSetModelTool(deps).execute("tc1", params as never, undefined, undefined, {} as never);
}

describe("tools/set-model-tool", () => {
  it("① host self-switch succeeds; text reports the resolved provider/id and next-call semantics", async () => {
    const result = await runTool(makeDeps(), { model: "haiku" });
    const text = result.content[0]!.text;
    expect(text).toContain("anthropic/claude-haiku-4");
    expect(text).toContain("next model call");
    expect(result.details).toMatchObject({
      ok: true,
      target: "self",
      model: { provider: "anthropic", id: "claude-haiku-4" },
      thinking: "medium",
    });
  });

  it("② pi.setModel === false (no auth) throws and names the provider; session unchanged", async () => {
    const { deps, spy } = hostSpy({ setModelResult: false });
    await expect(runTool(makeDeps({ host: deps }), { model: "anthropic/claude-haiku-4" })).rejects.toThrow(
      /no auth configured for provider "anthropic".*unchanged/,
    );
    expect(spy.thinkingWrites).toEqual([]);
  });

  it("③ fuzzy hint resolves against the candidate table", async () => {
    const { deps, spy } = hostSpy();
    await runTool(makeDeps({ host: deps }), { model: "sonnet" });
    expect(spy.setModelCalls).toEqual([candidates[0]]);
  });

  it("④ an unresolvable hint throws with a candidate listing (E2)", async () => {
    await expect(runTool(makeDeps(), { model: "gpt-42" })).rejects.toThrow(
      /unknown model: "gpt-42".*Available: anthropic\/claude-sonnet-5/,
    );
  });

  it("⑤ a foreign run_id goes through runs.setModel with thinking threaded", async () => {
    let seen: { runId: string; opts: unknown } | undefined;
    const deps = makeDeps({
      runs: {
        setModel: async (runId, model, opts) => {
          seen = { runId, opts };
          return { ok: true, model, ...(opts?.thinking === undefined ? {} : { thinking: opts.thinking }) };
        },
      },
    });
    const result = await runTool(deps, { model: "haiku", run_id: "some-label", thinking: "high" });
    expect(seen).toEqual({ runId: "resolved:some-label", opts: { thinking: "high" } });
    expect(result.content[0]!.text).toContain("some-label");
    expect(result.content[0]!.text).toContain("(thinking: high)");
  });

  it("⑥ not_running maps to the terminal-run guidance (E6)", async () => {
    const deps = makeDeps({ runs: { setModel: async () => ({ ok: false, reason: "not_running" }) } });
    await expect(runTool(deps, { model: "haiku", run_id: "r9" })).rejects.toThrow(
      /not currently running.*Agent\(model/,
    );
  });

  it("⑦ resolveRun failure is passed through verbatim (E7)", async () => {
    const deps = makeDeps({
      resolveRun: () => ({ ok: false, error: "run target not found: nope. Candidates: [none]", candidates: [] }),
    });
    await expect(runTool(deps, { model: "haiku", run_id: "nope" })).rejects.toThrow("run target not found: nope");
  });

  it("⑧ run form rejects a foreign run_id (E8)", async () => {
    const deps = makeDeps({ selfRunId: "r-self", host: undefined });
    await expect(runTool(deps, { model: "haiku", run_id: "r-other" })).rejects.toThrow(/only switch your own model/);
  });

  it("⑨ run form: omitted / 'self' / own runId are equivalent and land on selfRunId", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      selfRunId: "r-self",
      host: undefined,
      runs: {
        setModel: async (runId, model) => {
          seen.push(runId);
          return { ok: true, model };
        },
      },
    });
    for (const params of [{ model: "haiku" }, { model: "haiku", run_id: "self" }, { model: "haiku", run_id: "r-self" }])
      await runTool(deps, params);
    expect(seen).toEqual(["r-self", "r-self", "r-self"]);
  });

  it("⑩ invalid thinking level is rejected defensively (E1)", async () => {
    await expect(runTool(makeDeps(), { model: "haiku", thinking: "xhigh" })).rejects.toThrow(
      /invalid thinking level "xhigh"; use one of off, low, medium, high/,
    );
  });

  it("⑪ timeout / unsupported / rejected map to distinct self-correcting texts (E5/E9/E10)", async () => {
    const outcomes: SetModelOutcome[] = [
      { ok: false, reason: "timeout" },
      { ok: false, reason: "unsupported" },
      { ok: false, reason: "rejected", detail: "No API key for x/y" },
    ];
    const patterns = [
      /timed out after 5s.*previous model/,
      /cannot switch models mid-run/,
      /refused the model switch: No API key/,
    ];
    for (const [i, outcome] of outcomes.entries()) {
      const deps = makeDeps({ runs: { setModel: async () => outcome } });
      await expect(runTool(deps, { model: "haiku", run_id: "r9" }), `case ${i}`).rejects.toThrow(patterns[i]!);
    }
  });

  it("⑫ host capability absent (canSetModel=false): self degrades, subagent switch still works", async () => {
    const deps = makeDeps({ host: undefined });
    await expect(runTool(deps, { model: "haiku" })).rejects.toThrow(/cannot switch the host session's model/);
    const result = await runTool(deps, { model: "haiku", run_id: "r9" });
    expect(result.details).toMatchObject({ ok: true, target: "resolved:r9" });
  });

  it("⑬ renderCall: title + meta line, tolerant of partial streaming args", () => {
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const tool = createSetModelTool(makeDeps());
    const comp = tool.renderCall!(
      { model: "haiku", run_id: "r9", thinking: "high" } as never,
      theme as never,
      {
        lastComponent: undefined,
        state: {},
      } as never,
    );
    const out = (comp as Text).render(120).join("\n");
    expect(out).toContain("Set Model: haiku");
    expect(out).toContain("target: r9");
    expect(out).toContain("thinking: high");
    const partial = (tool.renderCall!({} as never, theme as never, { state: {} } as never) as Text)
      .render(120)
      .join("\n");
    expect(partial).toContain("Set Model:");
    expect(partial).toContain("target: self");
  });

  it("⑭ host thinking write-back chain: previous level is restored over pi's recompute; clamping is annotated", async () => {
    // Simulate pi's setModel recomputing the level to the global default ("medium").
    const { deps, spy } = hostSpy({ level: "high" });
    const base = deps.setModel;
    deps.setModel = (m) => {
      spy.level = "medium"; // pi's _getThinkingLevelForModelSwitch lands on the global default
      return base(m);
    };
    const result = await runTool(makeDeps({ host: deps }), { model: "haiku" });
    expect(spy.thinkingWrites).toEqual(["high"]); // previous level written back
    expect(result.content[0]!.text).toContain("(thinking: high)");
    expect(result.content[0]!.text).not.toContain("clamped");

    // Clamped case: requested high, the new model only supports up to low.
    const clamped = hostSpy({ level: "low" });
    clamped.deps.setThinkingLevel = (level) => {
      clamped.spy.thinkingWrites.push(level);
      clamped.spy.level = level === "high" ? "low" : level; // pi clamps
    };
    const r2 = await runTool(makeDeps({ host: clamped.deps }), { model: "haiku", thinking: "high" });
    expect(r2.content[0]!.text).toContain("(thinking: low — clamped from high)");
  });

  it("⑮ host path is bounded: a hung pi.setModel times out after 5s (E9 host variant)", async () => {
    const clock = new FakeClock();
    const { deps } = hostSpy();
    deps.setModel = () => never<boolean>();
    const p = runTool(makeDeps({ host: deps, clock }), { model: "haiku" });
    const assertion = expect(p).rejects.toThrow(/model switch timed out after 5s.*previous model/);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    clock.advance(5_000);
    await assertion;
  });

  it("strict provider/id pairs bypass hint resolution but still require a registry hit (E3)", async () => {
    const { deps } = hostSpy();
    await expect(runTool(makeDeps({ host: deps }), { model: "nosuch/model-9" })).rejects.toThrow(
      /unknown model: nosuch\/model-9 \(not available in this installation/,
    );
  });

  it("run form has a self-only promptSnippet (m5)", () => {
    const hostTool = createSetModelTool(makeDeps());
    const runToolDef = createSetModelTool(makeDeps({ selfRunId: "r-self" }));
    expect(hostTool.promptSnippet).toContain("running subagent");
    expect(runToolDef.promptSnippet).not.toContain("subagent");
    expect(runToolDef.description).toContain("only switch YOUR OWN");
  });
});
