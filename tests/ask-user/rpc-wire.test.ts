import { describe, expect, it } from "vitest";

import {
  ASK_USER_MARKER,
  askUserInteract,
  type AskUserQuestion,
  type GuiContext,
} from "../../src/ask-user/channel-handler.js";

interface RequestFrame {
  type: "extension_ui_request";
  id: string;
  method: "select";
  title: string;
  options: string[];
}

type ResponseFrame =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; cancelled: true };

/** Minimal adapter for the rpc-mode createDialogPromise wire semantics. */
function createWireAdapter() {
  let nextId = 1;
  const frames: RequestFrame[] = [];
  const pending = new Map<string, (value: string | undefined) => void>();

  const select: NonNullable<GuiContext["ui"]>["select"] = async (title, options, selectOptions) => {
    const id = `request-${nextId++}`;
    frames.push({
      type: "extension_ui_request",
      id,
      method: "select",
      title,
      options,
    });

    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        selectOptions?.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(undefined);
      pending.set(id, finish);
      if (selectOptions?.signal?.aborted) onAbort();
      else selectOptions?.signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const feed = (frame: ResponseFrame) => {
    if (frame.type !== "extension_ui_response") return;
    pending.get(frame.id)?.("value" in frame ? frame.value : undefined);
  };

  return { frames, select, feed };
}

const questions: AskUserQuestion[] = [
  {
    question: "Which DB?",
    header: "Database",
    options: [{ label: "Postgres" }, { label: "SQLite" }],
  },
];

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("RPC wire contract", () => {
  it("records the exact request shape and decodes a value response", async () => {
    const adapter = createWireAdapter();
    const interaction = askUserInteract({ mode: "rpc", hasUI: true, ui: { select: adapter.select } }, questions);
    await nextTurn();

    expect(adapter.frames).toHaveLength(1);
    const frame = adapter.frames[0];
    expect(frame).toEqual({
      type: "extension_ui_request",
      id: "request-1",
      method: "select",
      title: ASK_USER_MARKER,
      options: [expect.any(String)],
    });
    expect(JSON.parse(frame!.options[0]!)).toEqual({
      questions,
      allowCancel: true,
    });

    adapter.feed({
      type: "extension_ui_response",
      id: "request-1",
      value: JSON.stringify({ Database: "Postgres" }),
    });
    await expect(interaction).resolves.toEqual({ Database: "Postgres" });
  });

  it("maps a cancelled response and an abort to null", async () => {
    const cancelledAdapter = createWireAdapter();
    const cancelled = askUserInteract({ mode: "rpc", hasUI: true, ui: { select: cancelledAdapter.select } }, questions);
    await nextTurn();
    cancelledAdapter.feed({
      type: "extension_ui_response",
      id: "request-1",
      cancelled: true,
    });
    await expect(cancelled).resolves.toBeNull();

    const abortAdapter = createWireAdapter();
    const controller = new AbortController();
    const aborted = askUserInteract({ mode: "rpc", hasUI: true, ui: { select: abortAdapter.select } }, questions, {
      signal: controller.signal,
    });
    await nextTurn();
    controller.abort();
    await expect(aborted).resolves.toBeNull();
  });

  it("treats a malformed value frame as cancellation", async () => {
    const adapter = createWireAdapter();
    const interaction = askUserInteract({ mode: "rpc", hasUI: true, ui: { select: adapter.select } }, questions);
    await nextTurn();
    adapter.feed({
      type: "extension_ui_response",
      id: "request-1",
      value: "{not-json",
    });
    await expect(interaction).resolves.toBeNull();
  });
});
