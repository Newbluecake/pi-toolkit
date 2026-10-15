// @vitest-environment happy-dom
/**
 * P7w (docs/dev/external-agent/quota-plan.md §9A.3, D19/D20): droid pool rows, the month window,
 * billing badges and auth problems — logic + QuotaPill/QuotaCard rendering (en/zh, desktop/mobile/phone).
 */
process.env["TZ"] = "Asia/Shanghai";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuotaPill from "../../../src/web-hub/ui/src/components/quota/QuotaPill.vue";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import {
  fmtCents,
  pillDisplay,
  pillGroups,
  pillProblems,
  scopeLabel,
} from "../../../src/web-hub/ui/src/logic/quota.js";
import type { QuotaWire } from "../../../src/web-hub/protocol/messages.js";

const NOW = Date.UTC(2026, 9, 14, 4, 0, 0); // 12:00 Asia/Shanghai
const H = 3_600_000;
type P = QuotaWire["providers"][number];
type W = P["windows"][number];

const w = (scope: W["scope"], usedPct: number, level: W["level"], over: Partial<W> = {}): W => ({
  scope,
  usedPct,
  level,
  ...over,
});
const std = (windows: W[], billing?: P["billing"]): P => ({
  id: "droid-standard",
  level: Math.max(0, ...windows.map((x) => x.level)) as P["level"],
  stale: false,
  windows,
  ...(billing ? { billing } : {}),
});
const core = (windows: W[]): P => ({
  id: "droid-core",
  level: Math.max(0, ...windows.map((x) => x.level)) as P["level"],
  stale: false,
  windows,
  billing: { overage: "droidCore", extraUsageBalanceCents: 0 },
});
const wire = (providers: P[], problems?: QuotaWire["problems"]): QuotaWire => ({
  v: 1,
  at: NOW,
  providers,
  ...(problems ? { problems } : {}),
});

const HEALTHY = wire([
  std([w("5h", 12, 0), w("week", 40, 0), w("month", 5, 0)], { overage: "droidCore", extraUsageBalanceCents: 0 }),
  core([w("5h", 0, 0), w("week", 0, 0), w("month", 0, 0)]),
]);

function stubMedia(mobile: boolean, phone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 767px)" ? mobile : query === "(max-width: 480px)" ? phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.useRealTimers();
  resetLangForTests();
  stubMedia(false, false);
});

function mountPill(q: QuotaWire, lang: "en" | "zh" = "en", mobile = false, phone = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setLangOverride(lang, null);
  stubMedia(mobile, phone);
  return mount(QuotaPill, { props: { quota: q }, attachTo: document.body });
}

describe("logic: droid pools", () => {
  it("scopeLabel / fmtCents", () => {
    expect(scopeLabel("month")).toBe("mo");
    expect(fmtCents(1234)).toBe("$12.34");
    expect(fmtCents(0)).toBe("$0.00");
    expect(fmtCents(-1)).toBeUndefined();
    expect(fmtCents(Number.NaN)).toBeUndefined();
  });

  it("windows sort 5h, week, month regardless of wire order", () => {
    const g = pillGroups(wire([std([w("month", 5, 0), w("5h", 1, 0), w("week", 2, 0)])]));
    expect(g[0]!.windows.map((x) => x.scope)).toEqual(["5h", "week", "month"]);
  });

  it("D6 annex: droid month (level>=1) beats week; non-droid unaffected", () => {
    const g = pillGroups(
      wire([
        std([w("5h", 80, 1, { resetAt: 1 }), w("week", 60, 1, { resetAt: 2 }), w("month", 55, 1, { resetAt: 3 })]),
      ]),
    );
    expect(g[0]).toMatchObject({ resetScope: "month", resetAt: 3 });
    const g2 = pillGroups(wire([std([w("week", 60, 1, { resetAt: 2 }), w("month", 5, 0, { resetAt: 3 })])]));
    expect(g2[0]).toMatchObject({ resetScope: "week", resetAt: 2 });
  });

  it("exhaustScope = the LONGEST exhausted window's scope / reset; non-droid stays week", () => {
    const g = pillGroups(
      wire([
        std([
          w("5h", 100, 3, { resetAt: 100 }),
          w("week", 99, 3, { resetAt: 500 }),
          w("month", 10, 0, { resetAt: 9000 }),
        ]),
      ]),
    );
    expect(g[0]).toMatchObject({ exhaustScope: "week", exhaustResetAt: 500 });
    const g2 = pillGroups(wire([std([w("5h", 100, 3, { resetAt: 100 }), w("month", 100, 3, { resetAt: 900 })])]));
    expect(g2[0]).toMatchObject({ exhaustScope: "month", exhaustResetAt: 900 });
    const g3 = pillGroups(wire([std([w("5h", 100, 3)])]));
    expect(g3[0]!.exhaustResetAt).toBeUndefined();
    const kimi = pillGroups(
      wire([{ id: "kimi-coding" as never, level: 3, stale: false, windows: [w("week", 100, 3, { resetAt: 7 })] }]),
    );
    expect(kimi[0]).toMatchObject({ exhaustScope: "week", exhaustResetAt: 7 });
  });

  it("extra only for standard + extraUsage + L3", () => {
    const ex = (level: W["level"], overage: "extraUsage" | "droidCore", id: P["id"] = "droid-standard") => {
      const p = std([w("month", level === 3 ? 100 : 5, level)], { overage, extraUsageBalanceCents: 1234 });
      p.id = id;
      return pillGroups(wire([p]))[0]!;
    };
    expect(ex(3, "extraUsage").extra).toEqual({ cents: 1234 });
    expect(ex(0, "extraUsage").extra).toBeUndefined();
    expect(ex(3, "droidCore").extra).toBeUndefined();
    expect(ex(3, "extraUsage", "droid-core").extra).toBeUndefined();
  });

  it("pillProblems drops illegal entries and caps at 4", () => {
    const q = wire([], [
      { family: "droid", status: 402 },
      { family: "x", status: 402 },
      { family: "droid", status: 99 },
      null,
      ...Array.from({ length: 6 }, () => ({ family: "droid", status: 401 })),
    ] as never);
    expect(pillProblems(q)).toHaveLength(4);
    expect(pillProblems(wire([]))).toEqual([]);
    expect(pillProblems(undefined)).toEqual([]);
  });

  it("pillDisplay: problems-only ⇒ available/[]; none ⇒ null; shape unchanged without problems", () => {
    expect(pillDisplay(wire([], [{ family: "droid", status: 402 }]))).toEqual({
      mode: "available",
      groups: [],
      problems: [{ family: "droid", status: 402 }],
    });
    expect(pillDisplay(wire([]))).toBeNull();
    expect(Object.keys(pillDisplay(HEALTHY)!)).toEqual(["mode", "groups"]);
    expect(pillDisplay(wire([std([w("5h", 1, 0)])], [{ family: "droid", status: 401 }]))!.problems).toHaveLength(1);
  });
});

describe("QuotaPill: droid", () => {
  it("desktop en: two pool segments with mo", () => {
    const texts = mountPill(HEALTHY)
      .findAll(".q-seg-text")
      .map((x) => x.text());
    expect(texts).toEqual(["Droid Std 5h 12% · 7d 40% · mo 5%", "Droid Core 5h 0% · 7d 0% · mo 0%"]);
  });
  it("zh: pool labels are brand tokens", () => {
    const texts = mountPill(HEALTHY, "zh")
      .findAll(".q-seg-text")
      .map((x) => x.text());
    expect(texts[0]).toBe("Droid Std 5h 12% · 7d 40% · mo 5%");
  });
  it("mobile: pct-only with three values", () => {
    const texts = mountPill(HEALTHY, "en", true)
      .findAll(".q-seg-text")
      .map((x) => x.text());
    expect(texts).toEqual(["Droid Std 12%/40%/5%", "Droid Core 0%/0%/0%"]);
  });
  it("exhausted: ⚠ label · <scope of longest exhausted> clock reset", () => {
    const q = wire([
      std([w("5h", 100, 3, { resetAt: NOW + H }), w("month", 100, 3, { resetAt: NOW + 5 * H })]),
      core([w("5h", 100, 3, { resetAt: NOW + 2 * H }), w("month", 100, 3)]),
    ]);
    const texts = mountPill(q)
      .findAll(".q-seg-text")
      .map((x) => x.text());
    expect(texts[0]).toBe("⚠ Droid Std · mo 17:00 reset");
    expect(texts[1]).toBe("⚠ Droid Core · 5h 14:00 reset");
  });
  it("extra $ appended after the annex on a standard L3 pool (available mode)", () => {
    const q = wire([
      std([w("5h", 100, 3, { resetAt: NOW + H })], { overage: "extraUsage", extraUsageBalanceCents: 1234 }),
      core([w("5h", 0, 0)]),
    ]);
    // standard is exhausted but core available ⇒ only core shows; make both exhausted-free: use one pool
    const solo = wire([
      std([w("5h", 100, 3, { resetAt: NOW + H }), w("month", 50, 0)], {
        overage: "extraUsage",
        extraUsageBalanceCents: 1234,
      }),
    ]);
    expect(mountPill(q).text()).not.toContain("extra");
    const text = mountPill(solo).get(".q-seg-text").text();
    expect(text).toBe("⚠ Droid Std · 5h 13:00 reset"); // all exhausted ⇒ exhausted form, no extra
  });
  it("auth problem chip next to groups, with level>=2 and aria", () => {
    const q = wire(HEALTHY.providers, [{ family: "droid", status: 402 }]);
    const wrapper = mountPill(q);
    const chip = wrapper.get(".q-problem");
    expect(chip.text()).toBe("Droid auth 402");
    expect(chip.attributes("data-level")).toBe("2");
    expect(wrapper.get(".q-pill").attributes("data-level")).toBe("2");
    expect(wrapper.get(".q-pill").attributes("aria-label")).toContain("Droid quota: HTTP 402");
  });
  it("problems-only: pill renders; phone chip reads `auth 402`", () => {
    const q = wire([], [{ family: "droid", status: 402 }]);
    expect(mountPill(q).get(".q-problem").text()).toBe("Droid auth 402");
    const phone = mountPill(q, "en", true, true);
    expect(phone.get(".q-seg-compact .q-seg-text").text()).toBe("auth 402");
  });
  it("no problems and no groups ⇒ nothing", () => {
    expect(mountPill(wire([])).find(".q-pill").exists()).toBe(false);
  });
});

describe("QuotaCard: droid", () => {
  async function openCard(q: QuotaWire, lang: "en" | "zh" = "en") {
    const wrapper = mountPill(q, lang);
    await wrapper.get(".q-pill").trigger("click");
    return wrapper.get("#quota-panel");
  }

  it("renders a month row and the droidCore overage badge on the standard row only", async () => {
    const card = await openCard(HEALTHY);
    const rows = card.findAll(".q-prov");
    expect(rows.map((r) => r.get(".q-name").text())).toEqual(["Droid Std", "Droid Core"]);
    expect(rows[0]!.findAll(".q-scope").map((x) => x.text())).toEqual(["5h", "week", "month"]);
    expect(rows[0]!.get(".q-overage").text()).toBe("Overage: switch to core pool");
    expect(rows[1]!.find(".q-overage").exists()).toBe(false);
  });
  it("extraUsage badge with balance + allowed badge when gateOpen; zh text", async () => {
    const q = wire([std([w("month", 10, 0)], { overage: "extraUsage", extraUsageBalanceCents: 1234, gateOpen: true })]);
    const en = await openCard(q);
    expect(en.findAll(".q-overage").map((x) => x.text())).toEqual([
      "Overage: extra usage ($12.34)",
      "extra usage allowed",
    ]);
    const zh = await openCard(q, "zh");
    expect(zh.findAll(".q-overage").map((x) => x.text())).toEqual(["超额：额外余额（$12.34）", "已允许花额外余额"]);
    expect(zh.find(".q-scope").text()).toBe("月");
  });
  it("overage off ⇒ no badge; no gateOpen ⇒ no allowed badge", async () => {
    const off = await openCard(wire([std([w("5h", 1, 0)], { overage: "off", extraUsageBalanceCents: 0 })]));
    expect(off.find(".q-overage").exists()).toBe(false);
    const ex = await openCard(wire([std([w("5h", 1, 0)], { overage: "extraUsage", extraUsageBalanceCents: 5 })]));
    expect(ex.findAll(".q-overage")).toHaveLength(1);
  });
  it("auth problem row under the title (en/zh)", async () => {
    const q = wire(HEALTHY.providers, [{ family: "droid", status: 402 }]);
    expect((await openCard(q)).get(".q-problem-row").text()).toBe(
      "Droid quota unavailable: Factory billing API returned HTTP 402 — check FACTORY_API_KEY and restart pi",
    );
    expect((await openCard(q, "zh")).get(".q-problem-row").text()).toContain("HTTP 402");
  });
  it("no droid / no problems ⇒ no problem row and no overage badge", async () => {
    const card = await openCard(wire([{ id: "kimi-coding", level: 0, stale: false, windows: [w("5h", 1, 0)] }]));
    expect(card.find(".q-problem-row").exists()).toBe(false);
    expect(card.find(".q-overage").exists()).toBe(false);
  });
});
