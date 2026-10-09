// quota-web plan §3/§5 (D5/D6): `logic/quota.js`'s pure selection algorithm, reset-annex rule,
// cross-session hoist, and formatting helpers. The D6 pill-selection + dual-window-override
// rule is the file this package calls out for exhaustive parameterized coverage.
import { describe, expect, it } from "vitest";
import {
  etaDurationKey,
  fmtResetAt,
  freshestQuota,
  pillDisplay,
  pillGroups,
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

describe("pillGroups — one group per provider (headline, ordering, availability)", () => {
  it("undefined / no providers / windowless providers ⇒ []", () => {
    expect(pillGroups(undefined)).toEqual([]);
    expect(pillGroups(quota([]))).toEqual([]);
    expect(pillGroups(quota([provider("zai", [])]))).toEqual([]);
  });

  it("one group per provider in snapshot order; headline = that provider's worst window; windows 5h-first", () => {
    const q = quota([
      provider("kimi-coding", [window("week", 91, 2), window("5h", 10, 0)]),
      provider("zai-coding-cn", [window("5h", 62, 0)]),
    ]);
    expect(pillGroups(q)).toEqual([
      {
        ids: ["kimi-coding"],
        labelId: "kimi-coding",
        level: 2,
        scope: "week",
        usedPct: 91,
        windows: [
          { scope: "5h", level: 0, usedPct: 10 },
          { scope: "week", level: 2, usedPct: 91 },
        ],
        weekResetAt: undefined, // week window exists but carries no resetAt
        resetScope: "week", // triggered week ⇒ week annex (its resetAt itself is unknown here)
        resetAt: undefined,
        available: true,
      },
      {
        ids: ["zai-coding-cn"],
        labelId: "zai-coding-cn",
        level: 0,
        scope: "5h",
        usedPct: 62,
        windows: [{ scope: "5h", level: 0, usedPct: 62 }],
        weekResetAt: undefined, // no week window, headline has no resetAt either
        resetScope: undefined,
        resetAt: undefined,
        available: true,
      },
    ]);
  });

  it("usedPct is rounded; level 3 ⇒ available:false (spawn gate fast-fails that provider)", () => {
    const q = quota([provider("kimi-coding", [window("week", 97.6, 3)])]);
    const g = pillGroups(q)[0];
    expect(g.usedPct).toBe(98);
    expect(g.available).toBe(false);
  });
});

describe("pillGroups — GLM merge (2026-10-14 ruling: ALWAYS one GLM group, worst-of values)", () => {
  const glmPair = (cnWindows, intlWindows) => [provider("zai-coding-cn", cnWindows), provider("zai", intlWindows)];

  it("equal pair collapses into ONE group at the first one's position, labelId cn (label 'GLM') — unchanged from the equality era", () => {
    const q = quota([
      ...glmPair([window("5h", 42, 0), window("week", 41, 0)], [window("5h", 42, 0), window("week", 41, 0)]),
      provider("kimi-coding", [window("week", 98, 3, { resetAt: 9_999 })]),
    ]);
    const groups = pillGroups(q);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ ids: ["zai-coding-cn", "zai"], labelId: "zai-coding-cn", level: 0 });
    expect(groups[1]).toMatchObject({ ids: ["kimi-coding"], labelId: "kimi-coding", level: 3 });
  });

  it("differing level per scope still merges — the merged window is the WORSE side's", () => {
    const groups = pillGroups(quota(glmPair([window("5h", 42, 0)], [window("5h", 42, 1)])));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ ids: ["zai-coding-cn", "zai"], labelId: "zai-coding-cn", level: 1 });
    expect(groups[0].windows).toEqual([{ scope: "5h", level: 1, usedPct: 42 }]); // intl's L1 beats cn's L0
  });

  it("same level, differing pct still merges — the higher pct wins (level first, then usedPct)", () => {
    const groups = pillGroups(quota(glmPair([window("5h", 41.4, 0)], [window("5h", 41.6, 0)])));
    expect(groups).toHaveLength(1);
    expect(groups[0].windows).toEqual([{ scope: "5h", level: 0, usedPct: 42 }]); // intl's 41.6 ⇒ rounds to 42
  });

  it("differing scope sets still merge — a scope only one side has is taken as-is; exact ties keep the cn side's window", () => {
    const groups = pillGroups(quota(glmPair([window("5h", 42, 0), window("week", 41, 0)], [window("5h", 42, 0)])));
    expect(groups).toHaveLength(1);
    expect(groups[0].windows).toEqual([
      { scope: "5h", level: 0, usedPct: 42 }, // tie ⇒ the cn side's window (cn compared first)
      { scope: "week", level: 0, usedPct: 41 }, // cn-only scope carried over unchanged
    ]);
  });

  it("worst-of is PER SCOPE (5h from one side, week from the other); the D6 annex reads the merged windows — never a mixed pair", () => {
    const groups = pillGroups(
      quota(
        glmPair(
          [window("5h", 80, 2, { resetAt: 1_000 }), window("week", 91, 1, { resetAt: 2_000 })],
          [window("5h", 60, 3, { resetAt: 3_000 }), window("week", 55, 1, { resetAt: 4_000 })],
        ),
      ),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].windows).toEqual([
      { scope: "5h", level: 3, usedPct: 60 }, // intl's L3 beats cn's L2 despite the lower pct
      { scope: "week", level: 1, usedPct: 91 }, // cn's 91 beats intl's 55
    ]);
    // Headline = the merged 5h window (L3); the annex's triggered week window is the CN side's
    // (91%), so the week reset shown (2_000) comes from the SAME side that supplied the week
    // percentages — internally consistent, never one side's numbers under the other's clock.
    expect(groups[0]).toMatchObject({ level: 3, scope: "5h", resetScope: "week", resetAt: 2_000 });
  });

  it("level-3 merged headline with no week window ⇒ the unavailable fallback's resetAt comes from the headline window's OWN side", () => {
    const groups = pillGroups(
      quota(glmPair([window("5h", 80, 2, { resetAt: 1_000 })], [window("5h", 60, 3, { resetAt: 3_000 })])),
    );
    expect(groups[0]).toMatchObject({
      ids: ["zai-coding-cn", "zai"],
      level: 3,
      scope: "5h",
      resetScope: "5h",
      resetAt: 3_000, // the intl side supplied the headline window ⇒ its clock, not cn's 1_000
      available: false,
    });
  });

  it("only one GLM side present ⇒ plain single group, no merge machinery", () => {
    expect(pillGroups(quota([provider("zai-coding-cn", [window("5h", 42, 0)])]))).toMatchObject([
      { ids: ["zai-coding-cn"], labelId: "zai-coding-cn" },
    ]);
    // intl-only: ids/labelId stay "zai" — the i18n labels it "GLM" too (2026-10-14: the web
    // never shows "GLM Intl").
    expect(pillGroups(quota([provider("zai", [window("5h", 42, 0)])]))).toMatchObject([
      { ids: ["zai"], labelId: "zai" },
    ]);
  });

  it("reversed snapshot order (zai first) still merges at the FIRST position with the cn label", () => {
    const q = quota([
      provider("kimi-coding", [window("5h", 8, 0)]),
      provider("zai", [window("5h", 42, 0)]),
      provider("zai-coding-cn", [window("5h", 42, 0)]),
    ]);
    const groups = pillGroups(q);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ ids: ["kimi-coding"], labelId: "kimi-coding" });
    expect(groups[1]).toMatchObject({ ids: ["zai-coding-cn", "zai"], labelId: "zai-coding-cn", usedPct: 42 });
  });
});

describe("pillGroups — D6 reset annex per provider + the unavailable fallback", () => {
  it("week triggered (any level>=1) ⇒ that group carries the week reset", () => {
    const g = pillGroups(quota([provider("kimi-coding", [window("week", 91, 2, { resetAt: 54_321 })])]))[0];
    expect(g.resetScope).toBe("week");
    expect(g.resetAt).toBe(54_321);
  });

  it("5h triggered with usedPct>70 ⇒ that group carries the 5h reset", () => {
    const g = pillGroups(quota([provider("zai", [window("5h", 76, 1, { resetAt: 12_345 })])]))[0];
    expect(g.resetScope).toBe("5h");
    expect(g.resetAt).toBe(12_345);
  });

  it("5h triggered but usedPct<=70 ⇒ no reset annex", () => {
    const g = pillGroups(quota([provider("zai", [window("5h", 70, 1, { resetAt: 999 })])]))[0];
    expect(g.resetScope).toBeUndefined();
    expect(g.resetAt).toBeUndefined();
  });

  it("both windows triggered (5h headline) ⇒ week reset wins for that group", () => {
    const g = pillGroups(
      quota([
        provider("zai-coding-cn", [window("5h", 84, 2, { resetAt: 1_000 }), window("week", 55, 1, { resetAt: 2_000 })]),
      ]),
    )[0];
    expect(g.scope).toBe("5h"); // headline stays 5h
    expect(g.resetScope).toBe("week"); // annex prefers 7d
    expect(g.resetAt).toBe(2_000);
  });

  it("reset decisions are independent per provider (one provider's triggers never leak into another's annex)", () => {
    const q = quota([
      provider("zai-coding-cn", [window("5h", 84, 1, { resetAt: 1_000 })]), // 5h>70 ⇒ annex
      provider("kimi-coding", [window("week", 10, 0, { resetAt: 2_000 })]), // nothing triggered
    ]);
    expect(pillGroups(q)[0].resetAt).toBe(1_000);
    expect(pillGroups(q)[1].resetAt).toBeUndefined();
  });

  it("level-3 group always carries its headline window's resetAt when known (5h 65% would otherwise show none)", () => {
    const g = pillGroups(quota([provider("kimi-coding", [window("5h", 65, 3, { resetAt: 7_777 })])]))[0];
    expect(g.available).toBe(false);
    expect(g.resetScope).toBe("5h");
    expect(g.resetAt).toBe(7_777);
  });

  it("level-3 group with no resetAt anywhere stays annex-free", () => {
    const g = pillGroups(quota([provider("kimi-coding", [window("week", 65, 3)])]))[0];
    expect(g.resetScope).toBe("week"); // triggered week decided the scope…
    expect(g.resetAt).toBeUndefined(); // …but there is no timestamp to show
  });

  it("level-3 group keeps a D6-decided week reset (the headline's own is NOT substituted in)", () => {
    const g = pillGroups(
      quota([
        provider("kimi-coding", [window("5h", 95, 3, { resetAt: 1_000 }), window("week", 30, 1, { resetAt: 2_000 })]),
      ]),
    )[0];
    expect(g.resetScope).toBe("week");
    expect(g.resetAt).toBe(2_000);
  });
});

describe("pillDisplay — 2026-10-08 ruling: available-only / all-exhausted week-resets", () => {
  it("nothing to show ⇒ null", () => {
    expect(pillDisplay(undefined)).toBeNull();
    expect(pillDisplay(quota([]))).toBeNull();
    expect(pillDisplay(quota([provider("zai", [])]))).toBeNull();
  });

  it("single available provider ⇒ mode available, that one group", () => {
    const d = pillDisplay(quota([provider("zai-coding-cn", [window("5h", 42, 0)])]));
    expect(d?.mode).toBe("available");
    expect(d?.groups).toHaveLength(1);
    expect(d?.groups[0]).toMatchObject({ labelId: "zai-coding-cn", available: true });
  });

  it("mixed available + exhausted ⇒ mode available, ONLY the available groups shown", () => {
    const d = pillDisplay(
      quota([
        provider("zai-coding-cn", [window("5h", 17, 0), window("week", 43, 0)]),
        provider("kimi-coding", [window("week", 98, 3, { resetAt: 9_999 })]),
      ]),
    );
    expect(d?.mode).toBe("available");
    expect(d?.groups.map((g) => g.labelId)).toEqual(["zai-coding-cn"]);
    // the group carries BOTH windows (5h first) so the pill can render `GLM 5h 17% · 7d 43%`
    expect(d?.groups[0]?.windows).toEqual([
      { scope: "5h", level: 0, usedPct: 17 },
      { scope: "week", level: 0, usedPct: 43 },
    ]);
  });

  it("all exhausted ⇒ mode exhausted, every group kept with its WEEK resetAt", () => {
    const d = pillDisplay(
      quota([
        provider("zai-coding-cn", [window("5h", 95, 3), window("week", 98, 3, { resetAt: 5_000 })]),
        provider("kimi-coding", [window("week", 97, 3, { resetAt: 6_000 })]),
      ]),
    );
    expect(d?.mode).toBe("exhausted");
    expect(d?.groups.map((g) => g.labelId)).toEqual(["zai-coding-cn", "kimi-coding"]);
    expect(d?.groups[0]?.weekResetAt).toBe(5_000);
    expect(d?.groups[1]?.weekResetAt).toBe(6_000);
  });

  it("no week window ⇒ weekResetAt falls back to the headline window's resetAt", () => {
    const d = pillDisplay(quota([provider("kimi-coding", [window("5h", 95, 3, { resetAt: 7_777 })])]));
    expect(d?.mode).toBe("exhausted");
    expect(d?.groups[0]?.weekResetAt).toBe(7_777);
  });

  it("week window present but without resetAt ⇒ weekResetAt undefined (clock omitted)", () => {
    const d = pillDisplay(quota([provider("kimi-coding", [window("week", 95, 3)])]));
    expect(d?.mode).toBe("exhausted");
    expect(d?.groups[0]?.weekResetAt).toBeUndefined();
  });

  it("merged GLM pair stays merged when exhausted together (one group in exhausted mode)", () => {
    const d = pillDisplay(
      quota([
        provider("zai-coding-cn", [window("week", 99, 3, { resetAt: 5_000 })]),
        provider("zai", [window("week", 99, 3, { resetAt: 8_000 })]),
      ]),
    );
    expect(d?.mode).toBe("exhausted");
    expect(d?.groups).toHaveLength(1);
    expect(d?.groups[0]).toMatchObject({
      ids: ["zai-coding-cn", "zai"],
      labelId: "zai-coding-cn",
      weekResetAt: 5_000, // equal values ⇒ tie keeps the cn side's week window (cn compared first)
    });
  });

  it("exhausted merged pair with a WORSE intl week ⇒ weekResetAt from the intl side (worst-of)", () => {
    const d = pillDisplay(
      quota([
        provider("zai-coding-cn", [window("week", 97, 3, { resetAt: 5_000 })]),
        provider("zai", [window("week", 99, 3, { resetAt: 8_000 })]),
      ]),
    );
    expect(d?.mode).toBe("exhausted");
    expect(d?.groups).toHaveLength(1);
    expect(d?.groups[0]).toMatchObject({ labelId: "zai-coding-cn", weekResetAt: 8_000 }); // intl's window/clock
  });
});

describe("pillGroups/pillDisplay — defensive wire policy (verifier 2026-10: never throw, never NaN)", () => {
  it("an unknown future provider id renders under its raw id (labelId = id)", () => {
    const groups = pillGroups(quota([provider("moonshot-coding", [window("5h", 40, 0)])]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ ids: ["moonshot-coding"], labelId: "moonshot-coding", usedPct: 40 });
    const d = pillDisplay(quota([provider("moonshot-coding", [window("5h", 40, 0)])]));
    expect(d?.mode).toBe("available");
    expect(d?.groups[0]?.labelId).toBe("moonshot-coding");
  });

  it("a non-finite usedPct reads as 0% everywhere it is shown — never NaN", () => {
    const q = quota([provider("zai-coding-cn", [window("5h", Number.NaN, 0), window("week", 41, 0)])]);
    const g = pillGroups(q)[0]!;
    expect(g.usedPct).toBe(41); // headline = the finite week window
    expect(g.windows).toEqual([
      { scope: "5h", level: 0, usedPct: 0 }, // NaN window still listed, pct clamped to 0
      { scope: "week", level: 0, usedPct: 41 },
    ]);
    const allNan = pillGroups(quota([provider("kimi-coding", [window("5h", Number.NaN, 0)])]))[0]!;
    expect(allNan.usedPct).toBe(0);
    expect(allNan.windows[0]?.usedPct).toBe(0);
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
