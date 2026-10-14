import { describe, expect, it } from "vitest";
import { formatExternal } from "../../src/tools/result-text.js";
import type { ExternalRunMeta } from "../../src/core/types.js";

/**
 * external-agent plan §3.4 (P4c): formatExternal renders RunDiagnostics.external
 * as one identity/pricing line. Acceptance ④ pins the five pricing renderings:
 * upstream / family-approx / consensus-approx / unpriced / partial.
 */

const BASE: ExternalRunMeta = {
  provider: "droid",
  sessionId: "1a2b3c4d5e6f7890",
  autonomy: "high",
  credits: 1800,
};

describe("P4c formatExternal", () => {
  it("returns undefined for undefined meta (every pi run)", () => {
    expect(formatExternal(undefined)).toBeUndefined();
  });

  it("renders provider/session/autonomy/credits around the pricing segment", () => {
    const meta: ExternalRunMeta = {
      ...BASE,
      pricing: { status: "priced", source: "anthropic/claude-opus-5-5", basis: "upstream" },
    };
    expect(formatExternal(meta)).toBe(
      "droid · session 1a2b3c4d · autonomy high · priced anthropic/claude-opus-5-5 · 1.8k credits",
    );
  });

  it("upstream: exact price, no approx marker", () => {
    const meta: ExternalRunMeta = {
      provider: "droid",
      pricing: { status: "priced", source: "anthropic/claude-opus-5-5", basis: "upstream" },
    };
    expect(formatExternal(meta)).toBe("droid · priced anthropic/claude-opus-5-5");
  });

  it("family basis: approximate vendor list price marked (family, approx)", () => {
    const meta: ExternalRunMeta = {
      provider: "droid",
      pricing: { status: "priced", source: "moonshotai/kimi-k3", basis: "family", approx: true },
    };
    expect(formatExternal(meta)).toBe("droid · priced ~moonshotai/kimi-k3 (family, approx)");
  });

  it("consensus basis: approximate price marked (consensus, approx)", () => {
    const meta: ExternalRunMeta = {
      provider: "droid",
      pricing: { status: "priced", source: "openai/gpt-5.2", basis: "consensus", approx: true },
    };
    expect(formatExternal(meta)).toBe("droid · priced ~openai/gpt-5.2 (consensus, approx)");
  });

  it("override basis: user-pinned price is exact (no approx marker)", () => {
    const meta: ExternalRunMeta = {
      provider: "droid",
      pricing: { status: "priced", source: "settings", basis: "override" },
    };
    expect(formatExternal(meta)).toBe("droid · priced settings");
  });

  it("unpriced: names the reason and points at the settings override", () => {
    const meta: ExternalRunMeta = {
      provider: "droid",
      pricing: { status: "unpriced", reason: "no_match" },
    };
    expect(formatExternal(meta)).toBe('droid · unpriced (no_match) — set externalAgents.droid.pricing["<id>"]');
  });

  it("unpriced without a reason still renders the override hint", () => {
    const meta: ExternalRunMeta = { provider: "droid", pricing: { status: "unpriced" } };
    expect(formatExternal(meta)).toBe('droid · unpriced (unknown) — set externalAgents.droid.pricing["<id>"]');
  });

  it("partial: keeps the priced source and flags the unpriced remainder", () => {
    const meta: ExternalRunMeta = {
      provider: "droid",
      pricing: { status: "partial", source: "anthropic/claude-opus-5-5", basis: "upstream", reason: "child_usage" },
    };
    expect(formatExternal(meta)).toBe("droid · priced anthropic/claude-opus-5-5 +unpriced (child_usage)");
  });

  it("partial with an approximate priced source marks both sides", () => {
    const meta: ExternalRunMeta = {
      provider: "droid",
      pricing: {
        status: "partial",
        source: "moonshotai/kimi-k3",
        basis: "family",
        approx: true,
        reason: "child_usage",
      },
    };
    expect(formatExternal(meta)).toBe("droid · priced ~moonshotai/kimi-k3 (family, approx) +unpriced (child_usage)");
  });

  it("partial without a priced source renders just the unpriced remainder", () => {
    const meta: ExternalRunMeta = { provider: "droid", pricing: { status: "partial", reason: "child_usage" } };
    expect(formatExternal(meta)).toBe("droid · +unpriced (child_usage)");
  });

  it("omits absent optional segments and formats credits compactly", () => {
    // No session/autonomy/credits at all.
    expect(formatExternal({ provider: "droid" })).toBe("droid");
    // Sub-1000 credits stay a plain integer.
    expect(formatExternal({ provider: "droid", credits: 950 })).toBe("droid · 950 credits");
    expect(formatExternal({ provider: "droid", credits: 2500 })).toBe("droid · 2.5k credits");
    // Session id is shown as its 8-char prefix.
    expect(formatExternal({ provider: "droid", sessionId: "abcdef0123456789" })).toBe("droid · session abcdef01");
  });
});
