import { describe, expect, it } from "vitest";
import { createE2EHarness } from "./e2e-harness.js";

const single = {
  questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
};

describe("real component execute e2e", () => {
  it("submits a single choice through the real component", async () => {
    const harness = createE2EHarness(single);
    harness.component.handleInput("\r");
    const result = await harness.result;
    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers["Which DB?"].selected).toEqual(["Postgres"]);
    expect(harness.doneCalls).toBe(1);
  });

  it("submits multiple questions, including a multi-select question", async () => {
    const harness = createE2EHarness({
      questions: [
        { question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
        { question: "Q2", header: "Second", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
      ],
    });
    harness.component.handleInput("\r");
    harness.component.handleInput(" ");
    harness.component.handleInput("\r");
    harness.component.handleInput("\r");
    const result = await harness.result;
    expect(result.details.answers.Q1.selected).toEqual(["A"]);
    expect(result.details.answers.Q2.selected).toEqual(["X"]);
    expect(harness.doneCalls).toBe(1);
  });

  it("supports an Other answer in the real component", async () => {
    const harness = createE2EHarness(single);
    harness.component.handleInput("\x1b[B");
    harness.component.handleInput("\x1b[B");
    harness.component.handleInput("\r");
    for (const char of "MariaDB") harness.component.handleInput(char);
    harness.component.handleInput("\r");
    const result = await harness.result;
    expect(result.details.answers["Which DB?"]).toEqual({ selected: [], other: "MariaDB" });
  });

  it("mid-flight abort returns agent-aborted and resolves done once", async () => {
    const harness = createE2EHarness(single);
    harness.component.handleInput("p");
    harness.abort();
    const result = await harness.result;
    expect(result.details.cancelled).toBe(true);
    expect(result.content[0].text).toContain("Agent aborted");
    expect(harness.doneCalls).toBe(1);
    harness.component.cancel();
    expect(harness.doneCalls).toBe(1);
  });
});
