import { describe, expect, it } from "vitest";
import { nextCronOccurrence, parseCron } from "../../src/schedule/cron.js";

const at = (value: string) => new Date(value).getTime();

describe("cron", () => {
  it("parses five fields, lists and steps, and rejects invalid boundaries", () => {
    const parsed = parseCron("*/15 9,10 1-5 1,12 0");
    expect(parsed.fields[0]).toEqual(new Set([0, 15, 30, 45]));
    expect(parsed.fields[1]).toEqual(new Set([9, 10]));
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* * * *")).toThrow();
  });

  it("finds the next matching local minute across an hour and month boundary", () => {
    expect(nextCronOccurrence("5 * * * *", at("2026-01-01T12:05:00"))).toBe(at("2026-01-01T13:05:00"));
    expect(nextCronOccurrence("0 0 1 * *", at("2026-01-31T23:59:00"))).toBe(at("2026-02-01T00:00:00"));
  });
});
