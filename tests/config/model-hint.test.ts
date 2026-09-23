import { describe, expect, it } from "vitest";
import {
  formatModelCandidates,
  parseStrictModelRef,
  resolveModelHint,
  type ModelCandidate,
} from "../../src/config/model-hint.js";

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

describe("formatModelCandidates", () => {
  it("returns an empty string for no candidates", () => {
    expect(formatModelCandidates([])).toBe("");
  });

  it("lists provider/id pairs and truncates with a remainder count", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ provider: "p", id: `m-${index}` }));
    expect(formatModelCandidates(CANDIDATES.slice(0, 2))).toBe(
      "Available: cloudrouter-anthropic/claude-opus-5, cloudrouter-anthropic/claude-sonnet-5",
    );
    expect(formatModelCandidates(many)).toBe(
      "Available: p/m-0, p/m-1, p/m-2, p/m-3, p/m-4, p/m-5, p/m-6, p/m-7, … +2 more",
    );
  });

  // quota-plan §4.3 / §9: the optional `annotate` param is the only signature
  // extension — when omitted (or explicitly undefined) the output must stay
  // byte-for-byte identical to the pre-quota implementation. This is the
  // backward-compat lock for the sole spawn-admission call site.
  describe("annotate (quota-plan §4.3)", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ provider: "p", id: `m-${index}` }));
    it("is byte-for-byte identical when annotate is omitted vs explicitly undefined", () => {
      for (const list of [[], CANDIDATES, many] as const) {
        expect(formatModelCandidates(list, 8, undefined)).toBe(formatModelCandidates(list, 8));
        expect(formatModelCandidates(list, undefined, undefined)).toBe(formatModelCandidates(list));
      }
      expect(formatModelCandidates(CANDIDATES)).toBe(
        "Available: cloudrouter-anthropic/claude-opus-5, cloudrouter-anthropic/claude-sonnet-5, moonshot/kimi-k3, cloudrouter-kimi/kimi-k3",
      );
    });
    it("leaves the remainder suffix untouched and applies no annotation past the limit", () => {
      const annotate = (candidate: ModelCandidate) => (candidate.id === "m-0" ? " [5h 93% ⛔]" : undefined);
      expect(formatModelCandidates(many, 8, annotate)).toBe(
        "Available: p/m-0 [5h 93% ⛔], p/m-1, p/m-2, p/m-3, p/m-4, p/m-5, p/m-6, p/m-7, … +2 more",
      );
    });
    it("appends the suffix per candidate from the quota marker", () => {
      const annotate = (candidate: ModelCandidate) => (candidate.provider === "moonshot" ? " [7d 100% ⛔]" : undefined);
      expect(formatModelCandidates(CANDIDATES, 8, annotate)).toBe(
        "Available: cloudrouter-anthropic/claude-opus-5, cloudrouter-anthropic/claude-sonnet-5, moonshot/kimi-k3 [7d 100% ⛔], cloudrouter-kimi/kimi-k3",
      );
    });
    it("returns an empty string for empty input even with an annotator", () => {
      expect(formatModelCandidates([], 8, () => " [5h 1%]")).toBe("");
    });
  });
});
