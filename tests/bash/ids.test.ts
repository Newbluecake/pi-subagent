import { describe, expect, it } from "vitest";
import { isJobId, newJobId } from "../../src/bash/ids.js";
import { isRunId } from "../../src/core/ids.js";

describe("short bash job ids", () => {
  it("uses the exact b_ plus eight-character Crockford syntax", () => {
    const id = newJobId();
    expect(id).toMatch(/^b_[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(id).toHaveLength(10);
    expect(isJobId(id)).toBe(true);
    expect(isJobId("b_ABCDEFG")).toBe(false);
    expect(isJobId("b_ABCDEFGH-extra")).toBe(false);
    expect(isJobId("b_abcdefgh")).toBe(false);
    for (const forbidden of ["I", "L", "O", "U"]) expect(isJobId(`b_${forbidden}AAAAAAA`)).toBe(false);
  });

  it("never collides with the run id namespace", () => {
    const id = newJobId();
    expect(isRunId(id)).toBe(false);
    expect(isJobId("r_ABCDEFGH")).toBe(false);
  });

  it("generates 1000 ids without a collision", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newJobId()));
    expect(ids.size).toBe(1000);
  });

  it("retries when the exists callback reports a collision", () => {
    let calls = 0;
    const id = newJobId(() => ++calls === 1);
    expect(isJobId(id)).toBe(true);
    expect(calls).toBe(2);
  });

  it("throws after ten occupied candidates", () => {
    let calls = 0;
    expect(() =>
      newJobId(() => {
        calls++;
        return true;
      }),
    ).toThrow("after 10 attempts");
    expect(calls).toBe(10);
  });
});
