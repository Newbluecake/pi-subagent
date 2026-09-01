import { describe, expect, it } from "vitest";
import { parseStrictModelRef, resolveModelHint, type ModelCandidate } from "../../src/config/model-hint.js";

const CANDIDATES: ModelCandidate[] = [
  { provider: "cloudrouter-anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { provider: "cloudrouter-anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { provider: "moonshot", id: "kimi-k3", name: "Kimi K3" },
  { provider: "cloudrouter-kimi", id: "kimi-k3", name: "Kimi K3" },
];

describe("parseStrictModelRef", () => {
  it("splits provider/id and rejects non-pairs", () => {
    expect(parseStrictModelRef("moonshot/kimi-k3")).toEqual({ provider: "moonshot", id: "kimi-k3" });
    expect(parseStrictModelRef("kimi-k3")).toBeUndefined();
    expect(parseStrictModelRef("/kimi-k3")).toBeUndefined();
    expect(parseStrictModelRef("moonshot/")).toBeUndefined();
    expect(parseStrictModelRef("")).toBeUndefined();
  });
});

describe("resolveModelHint", () => {
  it("resolves a strict provider/id pair exactly", () => {
    expect(resolveModelHint("cloudrouter-kimi/kimi-k3", CANDIDATES)).toEqual({
      provider: "cloudrouter-kimi",
      id: "kimi-k3",
    });
  });
  it("strict pair must exist in the candidate list", () => {
    expect(resolveModelHint("moonshot/nonexistent", CANDIDATES)).toBeUndefined();
  });
  it("resolves a bare id, first candidate winning across providers", () => {
    // moonshot is listed before cloudrouter-kimi → deterministic tie-break by
    // candidate order (stack.ts passes pi's registry order).
    expect(resolveModelHint("kimi-k3", CANDIDATES)).toEqual({ provider: "moonshot", id: "kimi-k3" });
  });
  it("resolves id prefixes before substrings", () => {
    expect(resolveModelHint("claude-opus", CANDIDATES)).toEqual({
      provider: "cloudrouter-anthropic",
      id: "claude-opus-5",
    });
  });
  it("resolves case-insensitive substring aliases", () => {
    expect(resolveModelHint("Sonnet", CANDIDATES)).toEqual({
      provider: "cloudrouter-anthropic",
      id: "claude-sonnet-5",
    });
    expect(resolveModelHint("k3", CANDIDATES)).toEqual({ provider: "moonshot", id: "kimi-k3" });
  });
  it("falls back to display-name substring when no id matches", () => {
    expect(resolveModelHint("opus 5", CANDIDATES)).toEqual({ provider: "cloudrouter-anthropic", id: "claude-opus-5" });
  });
  it("returns undefined for unresolvable and empty hints", () => {
    expect(resolveModelHint("gpt-99", CANDIDATES)).toBeUndefined();
    expect(resolveModelHint("   ", CANDIDATES)).toBeUndefined();
    expect(resolveModelHint("sonnet", [])).toBeUndefined();
  });
});
