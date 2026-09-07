import { describe, expect, it } from "vitest";
import factory from "../../src/ask-user/index.js";
import { AskUserComponent } from "../../src/ask-user/component.js";
import { mockTui, stubTheme } from "./fixtures.js";

interface Tool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (...args: any[]) => Promise<any>;
  renderCall: (...args: any[]) => any;
  renderResult: (...args: any[]) => any;
}

const valid = {
  questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
};

function capture() {
  let tool: Tool | undefined;
  let active: string[] | undefined;
  const pi = {
    registerTool(definition: Tool) {
      tool = definition;
    },
    getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
    setActiveTools(names: string[]) {
      active = names;
    },
  };
  factory(pi as never);
  if (!tool) throw new Error("tool was not registered");
  return {
    tool,
    get active() {
      return active;
    },
  };
}

function renderText(component: { render(width: number): string[] }): string {
  return component.render(100).join("\n");
}

function tuiContext(onCreate?: (component: AskUserComponent) => void) {
  return {
    mode: "tui" as const,
    hasUI: true,
    ui: {
      custom: async <T>(make: (...args: any[]) => any): Promise<T> =>
        new Promise<T>((resolve) => {
          const component = make(mockTui, stubTheme, {}, resolve) as AskUserComponent;
          onCreate?.(component);
        }),
    },
  };
}

describe("ask_user entry orchestration", () => {
  it("registers the tool and returns a structured TUI result", async () => {
    const { tool } = capture();
    const result = await tool.execute(
      "id",
      valid,
      undefined,
      undefined,
      tuiContext((component) => component.handleInput("\r")),
    );
    expect(result.details).toEqual({
      questions: valid.questions,
      answers: { "Which DB?": { selected: ["Postgres"], other: null } },
      cancelled: false,
    });
    expect(result.content[0].text).toContain('"Which DB?" = "Postgres"');
  });

  it("validates before checking the session mode", async () => {
    const { tool } = capture();
    await expect(
      tool.execute("id", { questions: [{ question: "Q", options: ["A", "B"] }] }, undefined, undefined, {
        mode: "print",
        hasUI: false,
        ui: {},
      }),
    ).rejects.toThrow(/not strings/);
  });

  it("disables ask_user before throwing in headless mode", async () => {
    const captured = capture();
    await expect(
      captured.tool.execute("id", valid, undefined, undefined, {
        mode: "print",
        hasUI: false,
        ui: {},
      }),
    ).rejects.toThrow(/interactive session/);
    expect(captured.active).toEqual(["other"]);
  });

  it("returns a distinct agent-aborted result for a pre-aborted signal", async () => {
    const { tool } = capture();
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute("id", valid, controller.signal, undefined, tuiContext());
    expect(result.details.cancelled).toBe(true);
    expect(result.content[0].text).toContain("Agent aborted");
    expect(result.content[0].text).not.toContain("User cancelled");
  });
});

describe("M-1 cancellation classification", () => {
  it("TUI mid-flight abort cancels once with agent-aborted text", async () => {
    const { tool } = capture();
    const controller = new AbortController();
    let component: AskUserComponent | undefined;
    let doneCalls = 0;
    const ctx = {
      mode: "tui" as const,
      hasUI: true,
      ui: {
        custom: async <T>(make: (...args: any[]) => any): Promise<T> =>
          new Promise<T>((resolve) => {
            const done = (value: T) => {
              doneCalls++;
              resolve(value);
            };
            component = make(mockTui, stubTheme, {}, done) as AskUserComponent;
          }),
      },
    };
    const pending = tool.execute("id", valid, controller.signal, undefined, ctx);
    await Promise.resolve();
    component!.handleInput("p");
    controller.abort();
    const result = await pending;
    expect(result.details.cancelled).toBe(true);
    expect(result.content[0].text).toContain("Agent aborted");
    expect(doneCalls).toBe(1);
  });

  it("TUI user cancellation uses user-cancelled text", async () => {
    const { tool } = capture();
    const result = await tool.execute(
      "id",
      valid,
      undefined,
      undefined,
      tuiContext((component) => {
        component.handleInput("\x1b");
        component.handleInput("\x1b");
      }),
    );
    expect(result.details.cancelled).toBe(true);
    expect(result.content[0].text).toContain("User cancelled");
    expect(result.content[0].text).not.toContain("Agent aborted");
  });

  it("RPC mid-flight abort uses agent-aborted text", async () => {
    const { tool } = capture();
    const controller = new AbortController();
    let resolveSelect: ((value: string | undefined) => void) | undefined;
    const ctx = {
      mode: "rpc" as const,
      hasUI: true,
      ui: {
        select: async () =>
          new Promise<string | undefined>((resolve) => {
            resolveSelect = resolve;
          }),
      },
    };
    const pending = tool.execute("id", valid, controller.signal, undefined, ctx);
    await Promise.resolve();
    controller.abort();
    resolveSelect!(undefined);
    const result = await pending;
    expect(result.details.cancelled).toBe(true);
    expect(result.content[0].text).toContain("Agent aborted");
  });

  it("RPC undefined without abort uses user-cancelled text", async () => {
    const { tool } = capture();
    const result = await tool.execute("id", valid, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
      ui: { select: async () => undefined },
    });
    expect(result.content[0].text).toContain("User cancelled");
    expect(result.content[0].text).not.toContain("Agent aborted");
  });

  it("prefers a submitted TUI result when abort races after done", async () => {
    const { tool } = capture();
    const controller = new AbortController();
    let component: AskUserComponent | undefined;
    let doneCalls = 0;
    const resultPromise = tool.execute("id", valid, controller.signal, undefined, {
      mode: "tui",
      hasUI: true,
      ui: {
        custom: async <T>(make: (...args: any[]) => any) =>
          new Promise<T>((resolve) => {
            const done = (value: T) => {
              doneCalls++;
              resolve(value);
            };
            component = make(mockTui, stubTheme, {}, done) as AskUserComponent;
          }),
      },
    });
    await Promise.resolve();
    component!.handleInput("\r");
    controller.abort();
    const result = await resultPromise;
    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers["Which DB?"].selected).toEqual(["Postgres"]);
    expect(doneCalls).toBe(1);
  });
});

describe("renderers", () => {
  it("uses the fourth render context argument for host errors", () => {
    const { tool } = capture();
    const component = tool.renderResult(
      { content: [{ type: "text", text: "boom" }] },
      { expanded: false, isPartial: false },
      stubTheme,
      { isError: true },
    );
    expect(renderText(component)).toContain("✗ boom");
  });

  it("renders normal and expanded answers", () => {
    const { tool } = capture();
    const component = tool.renderResult(
      {
        details: {
          questions: [{ question: "Q", header: "DB", options: [{ label: "A" }, { label: "B" }] }],
          answers: { Q: { selected: ["A"], other: null } },
          cancelled: false,
        },
      },
      { expanded: true, isPartial: false },
      stubTheme,
      { isError: false },
    );
    const text = renderText(component);
    expect(text).toContain("DB: A");
    expect(text).toContain("●");
    expect(text).toContain("○");
  });
});
