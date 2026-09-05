import { describe, expect, it, vi } from "vitest";
import { createMessageAgentTool, MessageAgentParams } from "../../src/tools/message-agent-tool.js";

const generation = () => 3;
const params = { to: "r_PARENT01", kind: "finding" as const, text: "status" };

describe("tools/message-agent", () => {
  it("passes the host-owned sender and generation to the router", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "admitted" as const, key: "k", seq: 1 }));
    const tool = createMessageAgentTool({ router: { admit } as never, from: "r_CHILD001", generation });

    const result = await tool.execute("call", params);

    expect(admit).toHaveBeenCalledWith("r_CHILD001", {
      ...params,
      generation: 3,
    });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("routes @label through mention and returns structured details", async () => {
    const send = vi.fn(async () => ({ ok: false as const, status: "unknown_label" as const, label: "builder" }));
    const admit = vi.fn();
    const tool = createMessageAgentTool({
      router: { admit } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
    });
    const result = await tool.execute("call", { to: "@builder", kind: "finding", text: "status" });
    expect(send).toHaveBeenCalledWith("builder", "finding", "status");
    expect(admit).not.toHaveBeenCalled();
    expect(result.details).toEqual({ ok: false, status: "unknown_label", label: "builder" });
  });

  it("keeps bare run ids and root on the original admission path", async () => {
    const admit = vi.fn(() => ({ ok: true as const, status: "accepted" as const, key: "k", seq: 1 }));
    const send = vi.fn();
    const tool = createMessageAgentTool({
      router: { admit } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
    });
    await tool.execute("call", { to: "root", kind: "finding", text: "status" });
    await tool.execute("call", { to: "r_PARENT01", kind: "finding", text: "status" });
    expect(send).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("documents root versus @label addressing in the to schema", () => {
    const description = (MessageAgentParams.properties.to as { description: string }).description;
    expect(description).toContain('"root" for the root session');
    expect(description).toContain("@label for a registered top-level agent");
  });

  it("surfaces a synchronous router rejection as a failed tool call", async () => {
    const tool = createMessageAgentTool({
      router: {
        admit: () => {
          throw new Error("message not authorized");
        },
      } as never,
      from: "r_CHILD001",
      generation,
    });
    await expect(tool.execute("call", params)).rejects.toThrow("message not authorized");
  });
});
