// @vitest-environment node
import { describe, expect, it } from "vitest";
import { shortModelLabel, typeBadge, TYPE_TONE_COUNT } from "../../../src/web-hub/ui/src/logic/fleetRow.js";

describe("shortModelLabel", () => {
  it.each([
    ["claude-sonnet-5-5", "sonnet-5.5"],
    ["claude-opus-4-8", "opus-4.8"],
    ["claude-fable-5-1", "fable-5.1"],
    ["claude-fable-5", "fable-5"],
    ["claude-opus-5-5", "opus-5.5"],
    ["glm-5.3", "glm-5.3"],
    ["gpt-6.1-sol", "gpt-6.1-sol"],
    ["deepseek-v4-pro", "deepseek-v4-pro"],
    ["k3", "k3"],
    ["kimi-k3", "kimi-k3"],
    ["k3-256k", "k3-256k"],
    ["gpt-5.6-terra", "gpt-5.6-terra"],
    // dated / multi-digit ids keep their version digits untouched
    ["claude-opus-4-6-20250101", "opus-4-6-20250101"],
    ["claude-3-5-sonnet-20241022", "3-5-sonnet-20241022"],
    ["claude-sonnet-50-5", "sonnet-50-5"],
    ["kimi-k2-0905", "kimi-k2-0905"],
  ])("%s → %s", (i, o) => expect(shortModelLabel(i)).toBe(o));
});

describe("typeBadge", () => {
  it.each([
    ["general", "G"],
    ["verifier", "V"],
    ["reviewer", "R"],
    ["Explore", "E"],
    ["Plan", "P"],
    ["architect", "A"],
    ["frontend-dev", "F"],
    ["general-purpose", "G"],
  ])("%s → %s", (t, l) => expect(typeBadge(t)?.letter).toBe(l));

  it("known types have fixed distinct tones; general-purpose shares general's", () => {
    const tones = ["general", "verifier", "reviewer", "Explore", "Plan", "architect", "frontend-dev"].map(
      (t) => typeBadge(t)!.tone,
    );
    expect(new Set(tones).size).toBe(tones.length);
    expect(typeBadge("general-purpose")!.tone).toBe(typeBadge("general")!.tone);
  });

  it("unknown types hash deterministically into the palette; empty yields null", () => {
    const a = typeBadge("zeta-bot")!;
    expect(a).toEqual(typeBadge("zeta-bot"));
    expect(a.tone).toBeGreaterThanOrEqual(0);
    expect(a.tone).toBeLessThan(TYPE_TONE_COUNT);
    expect(typeBadge("")).toBeNull();
    expect(typeBadge("--")).toBeNull();
  });
});
