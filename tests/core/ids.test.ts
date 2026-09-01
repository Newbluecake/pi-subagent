import { describe, expect, it } from "vitest";
import { isRunId, newRunId } from "../../src/core/ids.js";

describe("short run ids", () => {
  it("uses the exact r_ plus eight-character Crockford syntax", () => {
    const id = newRunId();
    expect(id).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(id).toHaveLength(10);
    expect(isRunId(id)).toBe(true);
    expect(isRunId("r_ABCDEFG")).toBe(false);
    expect(isRunId("r_ABCDEFGH-extra")).toBe(false);
    for (const forbidden of ["I", "L", "O", "U"]) expect(isRunId(`r_${forbidden}AAAAAAA`)).toBe(false);
  });

  it("generates 1000 ids without a collision", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRunId()));
    expect(ids.size).toBe(1000);
  });

  it("retries when the exists callback reports a collision", () => {
    let calls = 0;
    const id = newRunId(() => ++calls === 1);
    expect(isRunId(id)).toBe(true);
    expect(calls).toBe(2);
  });

  it("throws after ten occupied candidates", () => {
    let calls = 0;
    expect(() =>
      newRunId(() => {
        calls++;
        return true;
      }),
    ).toThrow("after 10 attempts");
    expect(calls).toBe(10);
  });
});
