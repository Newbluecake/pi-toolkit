// @vitest-environment happy-dom
/**
 * P7w byte-parity golden (docs/dev/external-agent/quota-plan.md §9A.5): kimi / zai / GLM-merge /
 * stale / demoted / L3-exhausted wires must render byte-identically before and after the droid
 * pool + month changes. The fixture `tests/fixtures/web-hub-ui/quota-legacy-golden.json` was
 * generated ONCE from the pre-change UI code (UPDATE_QUOTA_LEGACY_GOLDEN=1, only honoured while the
 * file is absent) and must never be regenerated.
 */
process.env["TZ"] = "Asia/Shanghai";
import { mount } from "@vue/test-utils";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuotaPill from "../../../src/web-hub/ui/src/components/quota/QuotaPill.vue";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { freshestQuota, pillDisplay, pillGroups, pillView } from "../../../src/web-hub/ui/src/logic/quota.js";
import type { QuotaWire } from "../../../src/web-hub/protocol/messages.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/web-hub-ui/quota-legacy-golden.json");
const NOW = Date.UTC(2026, 9, 14, 4, 0, 0); // 12:00 Asia/Shanghai
const H = 3_600_000;

type P = QuotaWire["providers"][number];
const kimi = (over: Partial<P> = {}, wp = 8): P => ({
  id: "kimi-coding",
  level: 0,
  stale: false,
  fetchedAt: NOW - 60_000,
  windows: [
    { scope: "5h", usedPct: wp, level: 0, resetAt: NOW + 2 * H },
    { scope: "week", usedPct: 20, level: 0, resetAt: NOW + 30 * H },
  ],
  ...over,
});
const zai = (id: "zai" | "zai-coding-cn", w5: number, ww: number): P => ({
  id,
  plan: id === "zai" ? "max" : "pro",
  level: ww >= 98 ? 3 : 0,
  stale: false,
  fetchedAt: NOW - 120_000,
  windows: [
    { scope: "5h", usedPct: w5, level: 0, resetAt: NOW + H },
    { scope: "week", usedPct: ww, level: ww >= 98 ? 3 : 0, resetAt: NOW + 50 * H, etaMs: 3 * H },
  ],
});
const wire = (providers: P[]): QuotaWire => ({ v: 1, at: NOW - 30_000, providers });

const WIRES: Record<string, QuotaWire> = {
  kimiOnly: wire([kimi()]),
  zaiPair: wire([zai("zai-coding-cn", 42, 41), zai("zai", 42, 41)]),
  glmAndKimi: wire([zai("zai-coding-cn", 17, 43), zai("zai", 20, 40), kimi()]),
  glmIntlOnly: wire([zai("zai", 30, 30)]),
  stale: wire([kimi({ stale: true, fetchedAt: NOW - 20 * 60_000 })]),
  demoted: wire([kimi({ demotedUntil: NOW + 3 * H, level: 2 }, 75)]),
  exhaustedMix: wire([
    zai("zai-coding-cn", 10, 99),
    zai("zai", 10, 99),
    kimi({
      level: 3,
      windows: [{ scope: "week", usedPct: 100, level: 3, resetAt: NOW + 26 * H }],
    }),
  ]),
  l1Annex: wire([
    kimi({
      level: 1,
      windows: [
        { scope: "5h", usedPct: 80, level: 1, resetAt: NOW + H },
        { scope: "week", usedPct: 55, level: 1, resetAt: NOW + 40 * H },
      ],
    }),
  ]),
};

function stubMedia(mobile: boolean, phone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 767px)" ? mobile : query === "(max-width: 480px)" ? phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** P7w ADDED `exhaustScope`/`exhaustResetAt` (and droid-only `extra`) to every group object; the
 *  golden pins every PRE-EXISTING field, so the additive keys are removed before comparing. */
function stripAdditive<T extends object>(g: T): Record<string, unknown> {
  const { exhaustScope: _s, exhaustResetAt: _r, extra: _e, ...rest } = g as Record<string, unknown>;
  return rest;
}
function stripDisplay(d: ReturnType<typeof pillDisplay>): unknown {
  return d === null ? null : { ...d, groups: d.groups.map(stripAdditive) };
}

async function capture(): Promise<Record<string, unknown>> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const out: Record<string, unknown> = {};
  const logic: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(WIRES)) {
    logic[name] = {
      groups: pillGroups(q).map(stripAdditive),
      display: stripDisplay(pillDisplay(q)),
      view: pillView(q),
    };
  }
  logic["freshest"] = freshestQuota([
    { status: { quota: WIRES["stale"] } },
    { status: { quota: WIRES["kimiOnly"] } },
    { status: {} },
  ]);
  out["logic"] = logic;

  const html: Record<string, string> = {};
  const sizes: Array<[string, boolean, boolean]> = [
    ["desktop", false, false],
    ["mobile", true, false],
    ["phone", true, true],
  ];
  for (const lang of ["en", "zh"] as const) {
    setLangOverride(lang, null);
    for (const [size, mobile, phone] of sizes) {
      stubMedia(mobile, phone);
      for (const [name, q] of Object.entries(WIRES)) {
        const w = mount(QuotaPill, { props: { quota: q }, attachTo: document.body });
        html[`pill/${lang}/${size}/${name}`] = w.html();
        if (size === "desktop") {
          await w.get(".q-pill").trigger("click");
          html[`card/${lang}/${name}`] = w.get("#quota-panel").html();
        }
        w.unmount();
      }
    }
  }
  out["html"] = html;
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  resetLangForTests();
  stubMedia(false, false);
});

describe("quota legacy golden (kimi/zai byte parity)", () => {
  it("matches the pre-P7w fixture byte-for-byte", async () => {
    const got: any = JSON.parse(JSON.stringify(await capture()));
    if (!existsSync(FIXTURE)) {
      if (process.env["UPDATE_QUOTA_LEGACY_GOLDEN"] !== "1") throw new Error("golden fixture missing");
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, JSON.stringify(got, null, 1) + "\n");
      return;
    }
    const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
    // per-key compare first: a failure names the exact scenario instead of dumping the whole fixture
    for (const k of Object.keys(want.html)) expect(got["html"][k], k).toBe(want.html[k]);
    for (const k of Object.keys(want.logic)) expect(got["logic"][k], k).toEqual(want.logic[k]);
    expect(got).toEqual(want);
  });
});
