import { describe, expect, it } from "vitest";
import type { CustomEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createFabricEntryRenderer, renderFabricEntry } from "../../src/adapters/fabric-entry-renderer.js";
import { makeMessageKey, type FabricDeliveryState, type FabricRecord } from "../../src/core/message.js";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

function record(patch: Partial<FabricRecord> = {}): FabricRecord {
  return {
    key: makeMessageKey("r_ABCDEFGH", "root", 1, 1),
    from: "r_ABCDEFGH",
    to: "root",
    kind: "finding",
    seq: 1,
    generation: 1,
    payload: { text: "hello fabric" },
    ttlMs: 100_000,
    createdAt: 1,
    updatedAt: 1,
    state: "pending",
    attempts: 0,
    ...patch,
  };
}

function entry(data: unknown): CustomEntry {
  return {
    type: "custom",
    id: "e1",
    parentId: null,
    timestamp: "2024-01-01T00:00:00Z",
    customType: "subagent:fabric",
    data,
  };
}

describe("renderFabricEntry", () => {
  it("renders a delivered record as a one-line muted Text with the sender runId", () => {
    const component = renderFabricEntry(
      entry(record({ state: "delivered", deliveredAt: 2 })),
      { expanded: false },
      theme,
    );
    expect(component).toBeInstanceOf(Text);
    expect(component!.render(200).join("\n")).toContain("[fabric finding r_ABCDEFGH] hello fabric");
  });

  it("prefers the mention label over the runId when a resolver is provided", () => {
    const render = createFabricEntryRenderer((runId) => (runId === "r_ABCDEFGH" ? "watcher" : undefined));
    const component = render(entry(record({ state: "delivered", deliveredAt: 2 })), { expanded: false }, theme);
    expect(component!.render(200).join("\n")).toContain("[fabric finding @watcher] hello fabric");
  });

  it("renders nothing for every non-delivered state (append-per-transition would duplicate the message)", () => {
    const states: FabricDeliveryState[] = ["pending", "claimed", "consumed", "dropped", "abandoned"];
    for (const state of states) {
      expect(renderFabricEntry(entry(record({ state })), { expanded: false }, theme)).toBeUndefined();
    }
  });

  it("renders nothing when data is missing or has no state", () => {
    expect(renderFabricEntry(entry(undefined), { expanded: false }, theme)).toBeUndefined();
    expect(renderFabricEntry(entry({ payload: { text: "x" } }), { expanded: false }, theme)).toBeUndefined();
  });

  it("falls back to a generic label when kind is absent on a delivered record", () => {
    const component = renderFabricEntry(
      entry({ state: "delivered", payload: { text: "x" } }),
      { expanded: false },
      theme,
    );
    expect(component!.render(200).join("\n")).toContain("[fabric message] x");
  });
});
