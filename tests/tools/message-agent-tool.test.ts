import { describe, expect, it, vi } from "vitest";
import { createMessageAgentTool } from "../../src/tools/message-agent-tool.js";

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
