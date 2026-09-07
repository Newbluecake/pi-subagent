import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decodeAnswer, decodeOther, encodeAnswer } from "../../src/ask-user/answer-codec.js";

describe("answer codec", () => {
  it("encodes single-select and Other values", () => {
    expect(encodeAnswer({ selected: ["A"], other: null }, { key: "db", multiSelect: false })).toEqual({
      db: "A",
    });
    expect(encodeAnswer({ selected: ["A"], other: "custom" }, { key: "db", multiSelect: false })).toEqual({
      db: "A",
      db__other: "custom",
    });
    expect(encodeAnswer({ selected: [], other: "custom" }, { key: "db", multiSelect: false })).toEqual({
      db__other: "custom",
    });
  });

  it("encodes multi-select values as a JSON string", () => {
    expect(encodeAnswer({ selected: ["A", "B"], other: null }, { key: "features", multiSelect: true })).toEqual({
      features: '["A","B"]',
    });
  });

  it("leaves empty values absent and decodes ordinary values", () => {
    expect(encodeAnswer({ selected: [], other: null }, { key: "db", multiSelect: false })).toEqual({});
    expect(encodeAnswer({ selected: [], other: "" }, { key: "db", multiSelect: true })).toEqual({});
    expect(decodeAnswer({ db: "A" }, "db", false)).toBe("A");
    expect(decodeOther({ db__other: "custom" }, "db")).toBe("custom");
    expect(decodeAnswer({}, "db", false)).toBeUndefined();
    expect(decodeOther({}, "db")).toBeUndefined();
  });

  it.each(["123", "null", '{"a":1}', '["a",1]'])(
    "falls back to a single raw label for malformed multi-select JSON: %s",
    (raw) => {
      expect(decodeAnswer({ value: raw }, "value", true)).toEqual([raw]);
    },
  );

  it("accepts only an all-string JSON array for multi-select", () => {
    expect(decodeAnswer({ value: '["a","b"]' }, "value", true)).toEqual(["a", "b"]);
    expect(decodeAnswer({ value: "not-json" }, "value", true)).toEqual(["not-json"]);
  });

  it("does not read inherited object properties", () => {
    const answers = Object.create({ value: "inherited" }) as Record<string, string>;
    expect(decodeAnswer(answers, "value", false)).toBeUndefined();
  });
});

describe("answer codec property-based round trip", () => {
  it("round-trips constrained AnswerValue values", () => {
    // Labels are non-empty; single-select has at most one item; other is null
    // or non-empty. These are the values the encoder is specified to preserve.
    const label = fc.string({ minLength: 1 });
    const key = fc.string({ minLength: 1 });
    const other = fc.option(fc.string({ minLength: 1 }), { nil: null });

    fc.assert(
      fc.property(
        key,
        fc.boolean(),
        fc.array(label, { minLength: 0, maxLength: 4 }),
        other,
        (answerKey, multiSelect, generatedSelected, generatedOther) => {
          const selected = multiSelect ? generatedSelected : generatedSelected.slice(0, 1);
          const encoded = encodeAnswer({ selected, other: generatedOther }, { key: answerKey, multiSelect });
          const decoded = decodeAnswer(encoded, answerKey, multiSelect);
          const decodedOther = decodeOther(encoded, answerKey) ?? null;

          const expectedAnswer = selected.length === 0 ? undefined : multiSelect ? selected : selected[0];
          expect(decoded).toEqual(expectedAnswer);
          expect(decodedOther).toBe(generatedOther);
        },
      ),
    );
  });
});
