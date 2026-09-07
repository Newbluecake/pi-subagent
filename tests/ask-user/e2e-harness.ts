import factory from "../../src/ask-user/index.js";
import { AskUserComponent } from "../../src/ask-user/component.js";
import { mockTui, stubTheme } from "./fixtures.js";

export interface E2EHarness {
  tool: any;
  component: AskUserComponent;
  doneCalls: number;
  result: Promise<any>;
  abort(): void;
}

/**
 * Exercise the real registered tool and real component. Only Pi registration
 * and the custom UI boundary are mocked.
 */
export function createE2EHarness(params: any, signalController = new AbortController()): E2EHarness {
  let tool: any;
  let component!: AskUserComponent;
  let doneCalls = 0;
  let resolveCustom!: (value: any) => void;
  const customResult = new Promise<any>((resolve) => {
    resolveCustom = resolve;
  });
  const pi = {
    registerTool(definition: any) {
      tool = definition;
    },
    getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
    setActiveTools: () => {},
  };
  factory(pi as never);
  const ctx = {
    mode: "tui" as const,
    hasUI: true,
    ui: {
      custom: async <T>(make: (...args: any[]) => any): Promise<T> => {
        component = make(mockTui, stubTheme, {}, (value: T) => {
          doneCalls += 1;
          resolveCustom(value);
        }) as AskUserComponent;
        return customResult as Promise<T>;
      },
    },
  };
  const result = tool.execute("e2e", params, signalController.signal, undefined, ctx);
  return {
    tool,
    get component() {
      return component;
    },
    get doneCalls() {
      return doneCalls;
    },
    result,
    abort: () => signalController.abort(),
  };
}
