import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import type { NestedSpawnPort } from "../../src/tools/agent-tool.js";

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
  };
}
const notifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};
function buildAdapter(clock: FakeClock, overrides: Partial<RuntimeAdapterDeps> & { driver: SessionDriver }) {
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  return createRuntimeRunnerAdapter({ clock, pool, store, watchdog, reaper, notifier, ...overrides });
}
async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}
function spec(type: AgentTypeConfig, overrides: Partial<RunnerSpec["request"]> = {}): RunnerSpec {
  return { runId: "r1", type, request: { type: type.name, prompt: "hi", ...overrides }, budget: fastBudget() };
}

describe("service/runtime-adapter: X3 nested Agent tool injection", () => {
  const nestedType: AgentTypeConfig = {
    name: "planner",
    description: "x",
    systemPrompt: "",
    promptMode: "append",
    canSpawn: ["worker"],
  };

  it("injects a nested Agent tool into customTools when canSpawn is set and a spawn port is available", async () => {
    const clock = new FakeClock();
    let capturedTools: unknown[] | undefined;
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        capturedTools = s.customTools;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const port: NestedSpawnPort = {
      spawn: async () => ({ runId: "child" }),
      spawnAndWait: async () => {
        throw new Error("unused");
      },
    };
    const runner = buildAdapter(clock, { driver, nestedSpawn: () => port });
    const p = runner.run(spec(nestedType));
    await drain(clock, 10);
    await p;
    expect(capturedTools?.some((t) => (t as { name?: string }).name === "Agent")).toBe(true);
  });

  it("does not inject the nested Agent tool when the agent type has no canSpawn", async () => {
    const clock = new FakeClock();
    let capturedTools: unknown[] | undefined;
    const plainType: AgentTypeConfig = { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        capturedTools = s.customTools;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const port: NestedSpawnPort = {
      spawn: async () => ({ runId: "child" }),
      spawnAndWait: async () => {
        throw new Error("unused");
      },
    };
    const runner = buildAdapter(clock, { driver, nestedSpawn: () => port });
    const p = runner.run(spec(plainType));
    await drain(clock, 10);
    await p;
    expect(capturedTools ?? []).toHaveLength(0);
  });

  it("the injected nested tool, when invoked, calls the spawn port with parentRunId=this run and slotless=true", async () => {
    const clock = new FakeClock();
    let calledWith: { type: string; parentRunId?: string; slotless?: boolean } | undefined;
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const port: NestedSpawnPort = {
      spawn: async (req) => {
        calledWith = { type: req.type, parentRunId: req.parentRunId, slotless: req.slotless };
        return { runId: "child" };
      },
      spawnAndWait: async () => {
        throw new Error("unused");
      },
    };
    let injectedTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const drv2: SessionDriver = {
      create: async (s: SessionSpec) => {
        injectedTool = (
          s.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>
        ).find((t) => t.name === "Agent");
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    void driver;
    const runner = buildAdapter(clock, { driver: drv2, nestedSpawn: () => port });
    const p = runner.run(spec(nestedType));
    await drain(clock, 10);
    await p;
    expect(injectedTool).toBeDefined();
    await injectedTool!.execute(
      "tc",
      { description: "d", prompt: "p", subagent_type: "worker", run_in_background: true },
      undefined,
      undefined,
      {},
    );
    expect(calledWith).toEqual({ type: "worker", parentRunId: "r1", slotless: true });
  });
});

describe("service/runtime-adapter: X10 structured output injection + double validation", () => {
  const schemaType: AgentTypeConfig = { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };
  const schema = {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"],
    additionalProperties: false,
  };

  it("injects StructuredOutput; a valid submission produces outcome.structuredResult and status completed", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        const tool = (s.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>).find(
          (t) => t.name === "StructuredOutput",
        );
        return handle({
          prompt: async () => {
            await tool!.execute("tc", { answer: 42 }, undefined, undefined, {});
          },
        });
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver });
    const p = runner.run(spec(schemaType, { schema }));
    await drain(clock, 10);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    expect(outcome.structuredResult).toEqual({ answer: 42 });
  });

  it("a run that never submits StructuredOutput is reported failed(schema), not completed with free text", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: async () => undefined }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver });
    const p = runner.run(spec(schemaType, { schema }));
    await drain(clock, 10);
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("schema");
  });

  /**
   * Double validation, end to end: the tool's own onSubmit gate rejects an
   * invalid payload (so `structured.value` in runtime-adapter.ts is never
   * populated for it) — proving the *first* check is real. A separate
   * assertion in core/json-schema.test.ts proves the *second* (host-side)
   * check independently rejects a value that bypassed the first. Together
   * they cover both halves of "双重校验".
   */
  it("an invalid submission is rejected by the injected tool itself and never reaches the host as a valid result", async () => {
    const clock = new FakeClock();
    let toolResult: { details?: { ok: boolean } } | undefined;
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        const tool = (
          s.customTools as Array<{
            name: string;
            execute: (...args: unknown[]) => Promise<{ details?: { ok: boolean } }>;
          }>
        ).find((t) => t.name === "StructuredOutput");
        return handle({
          prompt: async () => {
            toolResult = await tool!.execute("tc", { answer: "not-a-number" }, undefined, undefined, {});
          },
        });
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver });
    const p = runner.run(spec(schemaType, { schema }));
    await drain(clock, 10);
    const outcome = await p;
    expect(toolResult?.details?.ok).toBe(false);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("schema");
    expect(outcome.structuredResult).toBeUndefined();
  });
});

describe("service/runtime-adapter: thinking level resolution (SpawnRequest.thinkingOverride)", () => {
  const typeWithThinking: AgentTypeConfig = {
    name: "thinker",
    description: "x",
    systemPrompt: "",
    promptMode: "append",
    thinkingLevel: "high",
  };
  const typeWithoutThinking: AgentTypeConfig = {
    name: "plain",
    description: "x",
    systemPrompt: "",
    promptMode: "append",
  };

  function capturingDriver(captured: { spec?: SessionSpec }): SessionDriver {
    return {
      create: async (s: SessionSpec) => {
        captured.spec = s;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
  }

  it("thinkingOverride wins over the agent type's configured thinkingLevel", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const runner = buildAdapter(clock, { driver: capturingDriver(captured) });
    const p = runner.run(spec(typeWithThinking, { thinkingOverride: "low" }));
    await drain(clock, 10);
    await p;
    expect(captured.spec?.thinkingLevel).toBe("low");
  });

  it("falls back to the agent type's thinkingLevel when no override is given", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const runner = buildAdapter(clock, { driver: capturingDriver(captured) });
    const p = runner.run(spec(typeWithThinking));
    await drain(clock, 10);
    await p;
    expect(captured.spec?.thinkingLevel).toBe("high");
  });

  it("omits thinkingLevel from the session spec when neither override nor type config sets one", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const runner = buildAdapter(clock, { driver: capturingDriver(captured) });
    const p = runner.run(spec(typeWithoutThinking));
    await drain(clock, 10);
    await p;
    expect(captured.spec && "thinkingLevel" in captured.spec).toBe(false);
  });
});
