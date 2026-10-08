// quota-web plan §3/§5 (D5/D6): `logic/quota.js`'s pure selection algorithm, reset-annex rule,
// cross-session hoist, and formatting helpers. The D6 pill-selection + dual-window-override
// rule is the file this package calls out for exhaustive parameterized coverage.
import { describe, expect, it } from "vitest";
import {
  etaDurationKey,
  fmtResetAt,
  freshestQuota,
  pillView,
  scopeLabel,
} from "../../../src/web-hub/ui/src/logic/quota.js";

function window(scope, usedPct, level, over = {}) {
  return { scope, usedPct, level, ...over };
}

function provider(id, windows, over = {}) {
  return { id, level: Math.max(0, ...windows.map((w) => w.level)), stale: false, windows, ...over };
}

function quota(providers, at = 1_000) {
  return { v: 1, at, providers };
}

describe("scopeLabel", () => {
  it("maps week→7d, everything else→5h (compact token, same both languages)", () => {
    expect(scopeLabel("week")).toBe("7d");
    expect(scopeLabel("5h")).toBe("5h");
  });
});

describe("fmtResetAt", () => {
  const now = new Date(2026, 9, 8, 16, 31).getTime(); // 2026-10-08 16:31 local

  it("same calendar day ⇒ HH:MM", () => {
    const sameDay = new Date(2026, 9, 8, 18, 20).getTime();
    expect(fmtResetAt(sameDay, now)).toBe("18:20");
  });

  it("different calendar day ⇒ M/D HH:MM", () => {
    const nextDay = new Date(2026, 9, 9, 4, 0).getTime();
    expect(fmtResetAt(nextDay, now)).toBe("10/9 04:00");
  });

  it("undefined/non-finite resetAt ⇒ undefined", () => {
    expect(fmtResetAt(undefined, now)).toBeUndefined();
    expect(fmtResetAt(Number.NaN, now)).toBeUndefined();
  });
});

describe("etaDurationKey", () => {
  it("under an hour ⇒ etaMinutes (at least 1)", () => {
    expect(etaDurationKey(30_000)).toEqual({ key: "etaMinutes", params: { n: 1 } });
    expect(etaDurationKey(28 * 60_000)).toEqual({ key: "etaMinutes", params: { n: 28 } });
  });

  it("whole hours ⇒ etaHours", () => {
    expect(etaDurationKey(3 * 3_600_000)).toEqual({ key: "etaHours", params: { h: 3 } });
  });

  it("hours + minutes ⇒ etaHoursMinutes", () => {
    expect(etaDurationKey(3 * 3_600_000 + 25 * 60_000)).toEqual({ key: "etaHoursMinutes", params: { h: 3, m: 25 } });
  });

  it("undefined/negative/non-finite ⇒ undefined", () => {
    expect(etaDurationKey(undefined)).toBeUndefined();
    expect(etaDurationKey(-1)).toBeUndefined();
    expect(etaDurationKey(Number.NaN)).toBeUndefined();
  });
});

describe("pillView — selection (level desc, usedPct desc tie-break)", () => {
  it("undefined / no providers / no windows ⇒ null", () => {
    expect(pillView(undefined)).toBeNull();
    expect(pillView(quota([]))).toBeNull();
    expect(pillView(quota([provider("zai", [])]))).toBeNull();
  });

  it("single quiet window ⇒ L0, no reset annex", () => {
    const q = quota([provider("zai-coding-cn", [window("5h", 62, 0)])]);
    expect(pillView(q)).toEqual({
      level: 0,
      providerId: "zai-coding-cn",
      scope: "5h",
      usedPct: 62,
      resetScope: undefined,
      resetAt: undefined,
    });
  });

  it("higher level wins regardless of usedPct", () => {
    const q = quota([
      provider("zai-coding-cn", [window("5h", 95, 1)]),
      provider("kimi-coding", [window("week", 20, 2)]),
    ]);
    const v = pillView(q);
    expect(v.providerId).toBe("kimi-coding");
    expect(v.scope).toBe("week");
    expect(v.level).toBe(2);
  });

  it("equal level ⇒ higher usedPct wins, across different providers/scopes", () => {
    const q = quota([
      provider("zai-coding-cn", [window("5h", 84, 3)]),
      provider("kimi-coding", [window("week", 95, 3)]),
    ]);
    const v = pillView(q);
    expect(v.providerId).toBe("kimi-coding");
    expect(v.scope).toBe("week");
    expect(v.usedPct).toBe(95);
  });

  it("usedPct is rounded in the output", () => {
    const q = quota([provider("zai", [window("5h", 61.6, 1)])]);
    expect(pillView(q).usedPct).toBe(62);
  });

  it("ignores a provider's other, less-severe windows when a worse one exists elsewhere", () => {
    const q = quota([
      provider("zai-coding-cn", [window("5h", 10, 0), window("week", 99, 3)]),
      provider("kimi-coding", [window("5h", 50, 1)]),
    ]);
    expect(pillView(q).scope).toBe("week");
  });
});

describe("pillView — D6 reset-time annex rule", () => {
  it("L0 (not triggered) ⇒ no reset annex even when resetAt is known", () => {
    const q = quota([provider("zai", [window("5h", 62, 0, { resetAt: 999 })])]);
    expect(pillView(q).resetAt).toBeUndefined();
  });

  it("5h triggered (level>=1) but usedPct<=70 ⇒ no reset annex", () => {
    const q = quota([provider("zai", [window("5h", 70, 1, { resetAt: 999 })])]);
    const v = pillView(q);
    expect(v.usedPct).toBe(70);
    expect(v.resetAt).toBeUndefined();
  });

  it("5h triggered AND usedPct>70 ⇒ its own reset annex", () => {
    const q = quota([provider("zai", [window("5h", 76, 1, { resetAt: 12_345 })])]);
    const v = pillView(q);
    expect(v.resetScope).toBe("5h");
    expect(v.resetAt).toBe(12_345);
  });

  it("week triggered (any level>=1, any usedPct) ⇒ its own reset annex always", () => {
    const q = quota([provider("kimi-coding", [window("week", 91, 2, { resetAt: 54_321 })])]);
    const v = pillView(q);
    expect(v.resetScope).toBe("week");
    expect(v.resetAt).toBe(54_321);
  });

  it("dual trigger (a 5h window AND a week window both >=L1, different providers) ⇒ week's reset wins even though the headline selection is the 5h window", () => {
    // Headline: GLM 5h 84% (L3, forecast) vs Kimi week 95% (L3, forecast) — week wins the
    // headline here too (95 > 84), but prove the override independently with a case where the
    // headline pick is actually the 5h window:
    const q = quota([
      provider("zai-coding-cn", [window("5h", 99, 3, { resetAt: 1_111 })]), // headline winner (level 3)
      provider("kimi-coding", [window("week", 55, 1, { resetAt: 2_222 })]), // only L1, loses the headline
    ]);
    const v = pillView(q);
    expect(v.providerId).toBe("zai-coding-cn"); // headline unaffected
    expect(v.scope).toBe("5h");
    expect(v.resetScope).toBe("week"); // but the annex prefers 7d
    expect(v.resetAt).toBe(2_222);
  });

  it("dual trigger picks the WORST week window's reset when several providers have one", () => {
    const q = quota([
      provider("zai-coding-cn", [window("5h", 80, 2, { resetAt: 1_000 })]),
      provider("zai", [window("week", 60, 1, { resetAt: 2_000 })]),
      provider("kimi-coding", [window("week", 97, 3, { resetAt: 3_000 })]),
    ]);
    const v = pillView(q);
    expect(v.resetScope).toBe("week");
    expect(v.resetAt).toBe(3_000); // the worst (L3, 97%) week window, not the first one found
  });

  it("5h triggered alone (no week window anywhere) never gets overridden", () => {
    const q = quota([provider("zai-coding-cn", [window("5h", 90, 3, { resetAt: 1_000 })])]);
    const v = pillView(q);
    expect(v.resetScope).toBe("5h");
    expect(v.resetAt).toBe(1_000);
  });

  it("week triggered alone (no 5h window triggered) never gets overridden (it already shows its own reset)", () => {
    const q = quota([
      provider("zai-coding-cn", [window("5h", 10, 0, { resetAt: 1_000 })]),
      provider("kimi-coding", [window("week", 91, 2, { resetAt: 2_000 })]),
    ]);
    const v = pillView(q);
    expect(v.resetScope).toBe("week");
    expect(v.resetAt).toBe(2_000);
  });
});

describe("freshestQuota — D5 cross-session hoist", () => {
  it("undefined/empty ⇒ undefined", () => {
    expect(freshestQuota([])).toBeUndefined();
  });

  it("picks the agent with the largest `at`", () => {
    const a = { status: { quota: quota([], 1_000) } };
    const b = { status: { quota: quota([], 5_000) } };
    const c = { status: { quota: quota([], 3_000) } };
    expect(freshestQuota([a, b, c])).toBe(b.status.quota);
  });

  it("skips agents without a well-formed quota wire", () => {
    const a = { status: {} };
    const b = { status: { quota: null } };
    const c = { status: { quota: "nope" } };
    const d = { status: { quota: { at: 1 } } }; // missing providers
    const e = { status: { quota: { providers: [] } } }; // missing at
    const f = { status: { quota: quota([], 7_000) } };
    expect(freshestQuota([a, b, c, d, e, f])).toBe(f.status.quota);
  });

  it("tolerates agents without a status object at all", () => {
    expect(freshestQuota([{}, { status: undefined }])).toBeUndefined();
  });
});
