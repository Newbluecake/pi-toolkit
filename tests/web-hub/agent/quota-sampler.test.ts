// quota-web plan §2 (D3/D4): `projectQuota`/`quotaFingerprint` — pure projection + the 1Hz
// fingerprint gate (no sampler state, no timers: see the module's own docstring for why this
// differs from worktree-sampler.ts/bash-jobs-sampler.ts).
import { describe, expect, it } from "vitest";
import { projectQuota, quotaFingerprint } from "../../../src/web-hub/agent/quota-sampler.js";
import type { ProviderVerdict, WindowVerdict } from "../../../src/quota/ladder.js";

function window(over: Partial<WindowVerdict> = {}): WindowVerdict {
  return { scope: "5h", usedPct: 10, level: 0, reason: "none", ...over };
}

function verdict(over: Partial<ProviderVerdict> = {}): ProviderVerdict {
  return {
    provider: "zai-coding-cn",
    level: 0,
    windows: [window()],
    demoted: false,
    fetchedAt: 1_000,
    stale: false,
    ...over,
  };
}

describe("projectQuota", () => {
  it("undefined/empty verdicts ⇒ undefined (field omitted entirely)", () => {
    expect(projectQuota(undefined, 1_000)).toBeUndefined();
    expect(projectQuota([], 1_000)).toBeUndefined();
  });

  it("projects provider + window fields; v=1 and at=now", () => {
    const v = verdict({
      provider: "kimi-coding",
      level: 2,
      plan: "pro",
      demoted: true,
      demotedUntil: 5_000,
      stale: true,
      windows: [window({ scope: "week", usedPct: 91.4, level: 2, resetAt: 9_000, etaMs: 120_000 })],
    });
    const wire = projectQuota([v], 2_000)!;
    expect(wire.v).toBe(1);
    expect(wire.at).toBe(2_000);
    expect(wire.providers).toHaveLength(1);
    expect(wire.providers[0]).toEqual({
      id: "kimi-coding",
      plan: "pro",
      level: 2,
      stale: true,
      fetchedAt: 1_000,
      demotedUntil: 5_000,
      windows: [{ scope: "week", usedPct: 91.4, level: 2, resetAt: 9_000, etaMs: 120_000 }],
    });
  });

  it("projects fetchedAt unconditionally (always present on the verdict)", () => {
    const wire = projectQuota([verdict({ fetchedAt: 7_500 })], 1_000)!;
    expect(wire.providers[0]!.fetchedAt).toBe(7_500);
  });

  it("omits plan/demotedUntil/resetAt/etaMs when absent (never emits as explicit undefined)", () => {
    const wire = projectQuota([verdict()], 1_000)!;
    const p = wire.providers[0]!;
    expect("plan" in p).toBe(false);
    expect("demotedUntil" in p).toBe(false);
    const w = p.windows[0]!;
    expect("resetAt" in w).toBe(false);
    expect("etaMs" in w).toBe(false);
  });

  it("demoted=true but demotedUntil undefined ⇒ wire carries no demotedUntil (matches the plan's wire shape — no standalone `demoted` flag)", () => {
    const wire = projectQuota([verdict({ demoted: true })], 1_000)!;
    expect("demotedUntil" in wire.providers[0]!).toBe(false);
  });

  it("multiple providers project in order; an unrecognized provider id is dropped, not fatal", () => {
    const bogus = verdict({ provider: "nope" as unknown as ProviderVerdict["provider"] });
    const wire = projectQuota([verdict({ provider: "zai" }), bogus, verdict({ provider: "kimi-coding" })], 1_000)!;
    expect(wire.providers.map((p) => p.id)).toEqual(["zai", "kimi-coding"]);
  });

  it("every provider dropped (all unrecognized ids) ⇒ undefined, not an empty-providers wire", () => {
    const bogus = verdict({ provider: "nope" as unknown as ProviderVerdict["provider"] });
    expect(projectQuota([bogus], 1_000)).toBeUndefined();
  });
});

describe("quotaFingerprint", () => {
  it("undefined wire ⇒ empty-string sentinel, distinct from any real wire", () => {
    expect(quotaFingerprint(undefined)).toBe("");
    const wire = projectQuota([verdict()], 1_000)!;
    expect(quotaFingerprint(wire)).not.toBe("");
  });

  it("ignores `at` (two reads a tick apart with identical verdicts must not flip the fingerprint)", () => {
    const v = verdict();
    const a = projectQuota([v], 1_000)!;
    const b = projectQuota([v], 61_000)!;
    expect(quotaFingerprint(a)).toBe(quotaFingerprint(b));
  });

  it("rounds usedPct to whole percent, resetAt/etaMs to the minute (sub-unit jitter never flips it)", () => {
    const v1 = verdict({ windows: [window({ usedPct: 50.1, resetAt: 60_000, etaMs: 120_000 })] });
    const v2 = verdict({ windows: [window({ usedPct: 50.49, resetAt: 60_999, etaMs: 120_999 })] });
    expect(quotaFingerprint(projectQuota([v1], 0))).toBe(quotaFingerprint(projectQuota([v2], 0)));
  });

  it("flips on a real level/usedPct/resetAt/etaMs/stale/demotedUntil change", () => {
    const base = quotaFingerprint(projectQuota([verdict()], 0));
    expect(quotaFingerprint(projectQuota([verdict({ level: 1 })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ windows: [window({ usedPct: 60 })] })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ stale: true })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ demoted: true, demotedUntil: 5_000 })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ windows: [window({ resetAt: 600_000 })] })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ windows: [window({ etaMs: 600_000 })] })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ fetchedAt: 9_999 })], 0))).not.toBe(base);
  });
});
