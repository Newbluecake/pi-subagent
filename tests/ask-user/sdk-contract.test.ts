import { describe, expect, it } from "vitest";
import factory from "../../src/ask-user/index.js";

it("matches the Pi extension registration contract", () => {
  let registered: any;
  let onCalled = false;
  const pi = {
    registerTool(value: any) {
      registered = value;
    },
    getAllTools: () => [],
    setActiveTools: () => {},
    on: () => {
      onCalled = true;
    },
  };
  factory(pi as never);

  expect(onCalled).toBe(false);
  expect(registered.name).toBe("ask_user");
  expect(registered.label).toBe("Ask User");
  expect(registered.parameters).toBeTruthy();
  expect(typeof registered.execute).toBe("function");
  expect(registered.execute.length).toBe(5);
  expect(registered.renderCall.length).toBeGreaterThanOrEqual(2);
  expect(registered.renderResult.length).toBeGreaterThanOrEqual(4);
});

describe("schema contract", () => {
  it("keeps questions bounded and options object-shaped at the declared schema level", () => {
    let registered: any;
    factory({
      registerTool: (value: any) => {
        registered = value;
      },
    } as never);
    const schema = registered.parameters;
    expect(schema.properties.questions.minItems).toBe(1);
    expect(schema.properties.questions.maxItems).toBe(4);
    const question = schema.properties.questions.items;
    expect(question.properties.options.minItems).toBe(2);
    expect(question.properties.options.maxItems).toBe(4);
  });
});
