// @vitest-environment happy-dom
/**
 * `QuotaPill.vue` + `QuotaCard.vue` (quota-web plan §3/D1/D6/D7) and `TopBar.vue`'s hosting of
 * them (D5 freshest-hoist + the "no data ⇒ byte-identical TopBar DOM" requirement).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuotaPill from "../../../src/web-hub/ui/src/components/quota/QuotaPill.vue";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { UI_BUILD } from "../../../src/web-hub/ui/src/build-info.js";
import { uiBuildStamp } from "../../../src/web-hub/ui/src/logic/build-stamp.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { QuotaWire } from "../../../src/web-hub/protocol/messages.js";

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

function m<T>(wrapper: T): T {
  mounted.push(wrapper as unknown as ReturnType<typeof mount>);
  return wrapper;
}

function quota(providers: QuotaWire["providers"], at = 1_000): QuotaWire {
  return { v: 1, at, providers };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TOPBAR_REL_PATH = "src/web-hub/ui/src/components/shell/TopBar.vue";
const FIXTURE_PATH = resolve(REPO_ROOT, "tests/fixtures/quota/topbar-no-quota-golden.html");

/** Strips the fixture's leading `<!-- ... -->` audit-trail header, keeping only the captured
 *  HTML payload (the header documents generation method/HEAD commit for humans — see the fixture
 *  file itself — and is not part of the DOM content being pinned). */
function readGoldenHtml(): string {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const withoutHeader = raw.replace(/^<!--[\s\S]*?-->\n/, "");
  const html = withoutHeader.replace(/\n$/, "");
  // `build-stamp.js`'s `uiBuildStamp` renders `MM-DD HH:mm` in the PROCESS's LOCAL time by
  // design (it is a human-facing build stamp) — the fixture was captured on a UTC+8 dev box, so
  // its baked literal (`01-02 11:04`) is wrong under CI's UTC runner (`01-02 03:04` for the
  // exact same `UI_BUILD.builtAt` instant). Re-derive the suffix for THIS process's timezone
  // instead of trusting the baked literal — the fixture still pins everything else byte-for-byte.
  const liveStamp = uiBuildStamp(UI_BUILD);
  const liveSuffix = liveStamp === null ? null : liveStamp.replace(/^.*? · /, "");
  if (liveSuffix === null) return html;
  return html.replace(/\d{2}-\d{2} \d{2}:\d{2}/g, liveSuffix);
}

describe("TopBar: no quota data ⇒ byte-identical DOM (quota-web plan D7's no-data ruling)", () => {
  const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;
  // Read from the committed, auditable fixture (quota-web plan verification r_WV2Y9VQZ #3) —
  // see `tests/fixtures/quota/topbar-no-quota-golden.html`'s own header for exactly how and from
  // which HEAD commit it was captured. Never hand-typed here.
  const GOLDEN = readGoldenHtml();

  // Opt-in regeneration (r_WV2Y9VQZ #3's "scripted regeneration, test only reads the fixture"
  // option): `UPDATE_QUOTA_GOLDEN=1 npx vitest run tests/web-hub/ui/quota-pill.test.ts` re-runs
  // the exact capture procedure (git show HEAD:<TopBar.vue> → temp-file dynamic import → mount)
  // and overwrites the fixture, including its header. Only meaningful against a HEAD that still
  // predates the quota-web pill; this never runs in a normal test invocation.
  if (process.env.UPDATE_QUOTA_GOLDEN === "1") {
    it("regenerates the golden fixture from git HEAD (opt-in, UPDATE_QUOTA_GOLDEN=1)", async () => {
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
      const headSource = execFileSync("git", ["show", `HEAD:${TOPBAR_REL_PATH}`], { cwd: REPO_ROOT }).toString();
      const tmpPath = resolve(REPO_ROOT, "src/web-hub/ui/src/components/shell/__quota_golden_head.vue");
      writeFileSync(tmpPath, headSource);
      let html: string;
      try {
        const mod = (await import(/* @vite-ignore */ `${tmpPath}?t=${Date.now()}`)) as { default: unknown };
        const wrapper = mount(mod.default as Parameters<typeof mount>[0], { props: baseProps });
        html = wrapper.element.outerHTML;
        wrapper.unmount();
      } finally {
        unlinkSync(tmpPath);
      }
      const header =
        "<!--\n" +
        "  AUTO-GENERATED fixture \u2014 quota-web plan verification r_WV2Y9VQZ #3 (audit trail for the\n" +
        '  "TopBar DOM byte-identical to pre-feature when there is no quota data" pin). DO NOT hand-edit.\n\n' +
        "  What this is: the exact `outerHTML` produced by mounting the PRE-quota-web `TopBar.vue` (i.e.\n" +
        "  the file as it stood at the HEAD commit below, before this feature's working-tree edit to that\n" +
        "  file) with `@vue/test-utils` under `happy-dom`, using\n" +
        '    props = { conn: "open", hubVersion: null, canSignOut: false }\n' +
        "  \u2014 the same `baseProps` `tests/web-hub/ui/topbar-settings-toggle.test.ts` already used.\n\n" +
        "  Captured from:  git show HEAD:" +
        TOPBAR_REL_PATH +
        "\n" +
        "  HEAD commit at capture time: " +
        headSha +
        "\n\n" +
        "  Regenerate (only meaningful against a HEAD that still predates the quota-web pill \u2014 i.e.\n" +
        "  before this feature's TopBar.vue edit itself is committed; regenerating afterwards would just\n" +
        "  capture the post-feature file and defeat the whole point of the pin):\n\n" +
        "      UPDATE_QUOTA_GOLDEN=1 npx vitest run tests/web-hub/ui/quota-pill.test.ts\n\n" +
        '  See `tests/web-hub/ui/quota-pill.test.ts`\'s "regenerates the golden fixture" test for the exact\n' +
        "  (scripted, not hand-typed) capture procedure this file's content was produced by: it does the\n" +
        "  same `git show HEAD:<path>` + temp-file dynamic `import()` + `mount()` dance as above,\n" +
        "  programmatically, and overwrites this file including this header.\n" +
        "-->\n";
      writeFileSync(FIXTURE_PATH, header + html + "\n");
    });
    return; // regeneration mode: skip the normal assertions below for this file run.
  }

  it("with no HUB_CTX injected at all (unit-test precedent) — identical to the pre-feature baseline", () => {
    const wrapper = m(mount(TopBar, { props: baseProps }));
    expect(wrapper.element.outerHTML).toBe(GOLDEN);
  });

  it("with a live hub whose agents carry no quota wire — identical to the pre-feature baseline", () => {
    const hub: HubHandle = {
      state: ref({
        control: false,
        agents: new Map([["a1", { status: { busy: false, pending: false } }]]),
      } as unknown as HubState) as HubHandle["state"],
    };
    const wrapper = m(mount(TopBar, { props: baseProps, global: { provide: { [HUB_CTX as symbol]: hub } } }));
    expect(wrapper.element.outerHTML).toBe(GOLDEN);
  });

  it("no .q-pill node exists in either case", () => {
    const wrapper = m(mount(TopBar, { props: baseProps }));
    expect(wrapper.find(".q-pill").exists()).toBe(false);
  });
});

describe("TopBar: D5 freshest-session hoist", () => {
  const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;

  it("picks the agent with the largest status.quota.at and renders its pill", () => {
    const older = quota(
      [{ id: "zai-coding-cn", level: 0, stale: false, windows: [{ scope: "5h", usedPct: 20, level: 0 }] }],
      1_000,
    );
    const newer = quota(
      [{ id: "kimi-coding", level: 1, stale: false, windows: [{ scope: "5h", usedPct: 55, level: 1 }] }],
      9_000,
    );
    const hub: HubHandle = {
      state: ref({
        control: false,
        agents: new Map([
          ["a1", { status: { quota: older } }],
          ["a2", { status: { quota: newer } }],
        ]),
      } as unknown as HubState) as HubHandle["state"],
    };
    const wrapper = m(mount(TopBar, { props: baseProps, global: { provide: { [HUB_CTX as symbol]: hub } } }));
    const pill = wrapper.get(".q-pill");
    expect(pill.attributes("data-level")).toBe("1");
    expect(pill.text()).toContain("Kimi");
  });
});

describe("QuotaPill.vue — rendering and the four-level color ladder", () => {
  it("renders nothing when quota is undefined", () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: undefined } }));
    expect(wrapper.find(".q-pill").exists()).toBe(false);
  });

  it("renders nothing when quota has zero providers/windows", () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: quota([]) } }));
    expect(wrapper.find(".q-pill").exists()).toBe(false);
  });

  it.each([
    [0, "L0"],
    [1, "L1"],
    [2, "L2"],
    [3, "L3"],
  ] as const)("level %i renders data-level=%i", (level) => {
    const q = quota([{ id: "zai-coding-cn", level, stale: false, windows: [{ scope: "5h", usedPct: 50, level }] }]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill").attributes("data-level")).toBe(String(level));
  });

  it("L0: shows the provider name, no ⚠, no reset annex", () => {
    const q = quota([
      { id: "zai-coding-cn", level: 0, stale: false, windows: [{ scope: "5h", usedPct: 62, level: 0 }] },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("GLM 5h 62%");
  });

  it("L1: 5h usedPct>70 ⇒ pill carries the 5h reset annex", () => {
    const resetAt = new Date(2026, 9, 8, 18, 20).getTime();
    const q = quota([
      { id: "zai-coding-cn", level: 1, stale: false, windows: [{ scope: "5h", usedPct: 76, level: 1, resetAt }] },
    ]);
    vi.setSystemTime(new Date(2026, 9, 8, 16, 0));
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("GLM 5h 76% · 18:20 reset");
  });

  it("all-exhausted single provider: `⚠ Kimi · 7d` — label kept, clock omitted when unknown (2026-10-08 ruling)", () => {
    const q = quota([
      { id: "kimi-coding", level: 3, stale: false, windows: [{ scope: "week", usedPct: 95, level: 3 }] },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("⚠ Kimi · 7d");
    expect(wrapper.get(".q-pill").attributes("aria-label")).toContain("Kimi");
  });

  it("mobile (≤767px): exhausted compact form is `⚠ Label {clock}` (no scope, no reset prose)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const q = quota([
      { id: "kimi-coding", level: 3, stale: false, windows: [{ scope: "week", usedPct: 95, level: 3 }] },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("⚠ Kimi");
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
});

describe("QuotaPill.vue — multi-group rendering (2026-10-08 rulings: available-only + both windows + GLM merge)", () => {
  /** GLM L0 pair (mergeable) + Kimi L3 with a cross-day reset — the canonical mixed scenario. */
  function glmAndKimiQuota(kimiResetAt: number): QuotaWire {
    return quota([
      {
        id: "zai-coding-cn",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 42, level: 0 },
          { scope: "week", usedPct: 41, level: 0 },
        ],
      },
      {
        id: "zai",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 42, level: 0 },
          { scope: "week", usedPct: 41, level: 0 },
        ],
      },
      {
        id: "kimi-coding",
        level: 3,
        stale: false,
        windows: [{ scope: "week", usedPct: 98, level: 3, resetAt: kimiResetAt }],
      },
    ]);
  }

  it("mixed ⇒ available mode: ONLY the available group renders, with BOTH its windows (5h first, then 7d)", () => {
    vi.setSystemTime(new Date(2026, 9, 10, 20, 0));
    const wrapper = m(mount(QuotaPill, { props: { quota: glmAndKimiQuota(new Date(2026, 9, 12, 9, 6).getTime()) } }));
    const segs = wrapper.findAll(".q-seg-text");
    expect(segs).toHaveLength(1); // exhausted Kimi is HIDDEN from the face
    expect(segs[0]!.text()).toBe("GLM 5h 42% · 7d 41%"); // both windows, no annex (nothing triggered)
    expect(wrapper.get(".q-pill").attributes("data-level")).toBe("0"); // max among SHOWN groups
    expect(wrapper.get(".q-pill-text").text()).not.toContain("Kimi");
    expect(wrapper.findAll(".q-sep")).toHaveLength(0);
  });

  it("…but the hidden exhausted group stays in aria/title (discoverable via hover/screen reader)", () => {
    vi.setSystemTime(new Date(2026, 9, 10, 20, 0));
    const wrapper = m(mount(QuotaPill, { props: { quota: glmAndKimiQuota(new Date(2026, 9, 12, 9, 6).getTime()) } }));
    const aria = wrapper.get(".q-pill").attributes("aria-label");
    expect(aria).toBe("Subscription quota: GLM 5h 42%; Subscription quota: Kimi 7d 98%, resets 10/12 09:06");
    expect(wrapper.get(".q-pill").attributes("title")).toBe(aria);
  });

  it("available group with a triggered week window carries the D6 reset annex after BOTH windows", () => {
    const resetAt = new Date(2026, 9, 8, 18, 20).getTime();
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 1,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 17, level: 0 },
          { scope: "week", usedPct: 43, level: 1, resetAt },
        ],
      },
    ]);
    vi.setSystemTime(new Date(2026, 9, 8, 16, 0));
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("GLM 5h 17% · 7d 43% · 18:20 reset");
  });

  it("two available groups (merged GLM + Kimi): one .q-seg each with its own data-level, separated by .q-sep; the GLM pair merges even though values differ (2026-10-14)", () => {
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 17, level: 0 },
          { scope: "week", usedPct: 43, level: 0 },
        ],
      },
      {
        id: "zai",
        level: 1,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 20, level: 1 },
          { scope: "week", usedPct: 30, level: 0 },
        ],
      },
      {
        id: "kimi-coding",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 10, level: 0 },
          { scope: "week", usedPct: 9, level: 0 },
        ],
      },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    const segs = wrapper.findAll(".q-seg");
    expect(segs).toHaveLength(2);
    // GLM values are per-scope worst-of: 5h from the intl side (L1 20% beats L0 17%), week
    // from the cn side (43% > 30%) — one segment, never "GLM Intl", never a second GLM row.
    expect(segs[0]!.attributes("data-level")).toBe("1");
    expect(segs[1]!.attributes("data-level")).toBe("0");
    expect(wrapper.get(".q-pill").attributes("data-level")).toBe("1");
    expect(wrapper.findAll(".q-sep")).toHaveLength(1);
    const texts = wrapper.findAll(".q-seg-text").map((s) => s.text());
    expect(texts).toEqual(["GLM 5h 20% · 7d 43%", "Kimi 5h 10% · 7d 9%"]);
    expect(wrapper.text()).not.toContain("GLM Intl");
  });

  it("mobile (≤767px): available compact form is `Label p5/p7` — `GLM 17%/43% · Kimi 20%/30%`", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 17, level: 0 },
          { scope: "week", usedPct: 43, level: 0 },
        ],
      },
      {
        id: "kimi-coding",
        level: 1,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 20, level: 1 },
          { scope: "week", usedPct: 30, level: 0 },
        ],
      },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("GLM 17%/43% · Kimi 20%/30%");
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  it("all exhausted ⇒ every group in week-reset form, merged GLM included; data-level 3", () => {
    vi.setSystemTime(new Date(2026, 9, 10, 20, 0));
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 3,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 95, level: 3 },
          { scope: "week", usedPct: 98, level: 3, resetAt: new Date(2026, 9, 14, 15, 48).getTime() },
        ],
      },
      {
        id: "zai",
        level: 3,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 95, level: 3 },
          { scope: "week", usedPct: 98, level: 3, resetAt: new Date(2026, 9, 15, 1, 0).getTime() },
        ],
      },
      {
        id: "kimi-coding",
        level: 3,
        stale: false,
        windows: [{ scope: "week", usedPct: 97, level: 3, resetAt: new Date(2026, 9, 12, 9, 6).getTime() }],
      },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    const segs = wrapper.findAll(".q-seg-text");
    expect(segs).toHaveLength(2); // GLM pair merged; equal values ⇒ tie keeps the cn side's clock (10/14, not intl's 10/15)
    expect(segs[0]!.text()).toBe("⚠ GLM · 7d 10/14 15:48 reset");
    expect(segs[1]!.text()).toBe("⚠ Kimi · 7d 10/12 09:06 reset");
    expect(wrapper.get(".q-pill").attributes("data-level")).toBe("3");
  });

  it("all-exhausted merged pair with a WORSE intl week ⇒ the week clock comes from the intl side (worst-of)", () => {
    vi.setSystemTime(new Date(2026, 9, 10, 20, 0));
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 3,
        stale: false,
        windows: [{ scope: "week", usedPct: 97, level: 3, resetAt: new Date(2026, 9, 14, 15, 48).getTime() }],
      },
      {
        id: "zai",
        level: 3,
        stale: false,
        windows: [{ scope: "week", usedPct: 99, level: 3, resetAt: new Date(2026, 9, 15, 1, 0).getTime() }],
      },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    const segs = wrapper.findAll(".q-seg-text");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text()).toBe("⚠ GLM · 7d 10/15 01:00 reset"); // 99% > 97% ⇒ intl's window carries its own clock
  });

  it("intl-only snapshot labels 'GLM' too — the web never shows 'GLM Intl' (2026-10-14)", () => {
    const q = quota([{ id: "zai", level: 0, stale: false, windows: [{ scope: "5h", usedPct: 41, level: 0 }] }]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("GLM 5h 41%");
    expect(wrapper.get(".q-pill").attributes("aria-label")).toBe("Subscription quota: GLM 5h 41%");
    expect(wrapper.get(".q-pill").attributes("title")).toBe("Subscription quota: GLM 5h 41%");
    expect(wrapper.text()).not.toContain("GLM Intl");
  });

  it("mobile all-exhausted: `⚠ Label {clock}` only — `⚠ GLM 10/14 15:48 · ⚠ Kimi 10/12 09:06`", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.setSystemTime(new Date(2026, 9, 10, 20, 0));
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 3,
        stale: false,
        windows: [{ scope: "week", usedPct: 98, level: 3, resetAt: new Date(2026, 9, 14, 15, 48).getTime() }],
      },
      {
        id: "kimi-coding",
        level: 3,
        stale: false,
        windows: [{ scope: "week", usedPct: 97, level: 3, resetAt: new Date(2026, 9, 12, 9, 6).getTime() }],
      },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("⚠ GLM 10/14 15:48 · ⚠ Kimi 10/12 09:06");
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  it("defensive wire policy: unknown provider id renders under its raw id; non-finite pct shows 0%", () => {
    const q = quota([
      { id: "moonshot-coding", level: 0, stale: false, windows: [{ scope: "5h", usedPct: 40, level: 0 }] },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q } }));
    expect(wrapper.get(".q-pill-text").text()).toBe("moonshot-coding 5h 40%");
    const nan = quota([
      { id: "zai-coding-cn", level: 0, stale: false, windows: [{ scope: "5h", usedPct: Number.NaN, level: 0 }] },
    ]);
    const wrapper2 = m(mount(QuotaPill, { props: { quota: nan } }));
    expect(wrapper2.get(".q-pill-text").text()).toBe("GLM 5h 0%");
  });
});

describe("QuotaPill.vue — popover open/close, a11y, card content", () => {
  function threeProviderQuota(): QuotaWire {
    return quota([
      {
        id: "zai-coding-cn",
        level: 1,
        stale: false,
        plan: "pro",
        windows: [
          { scope: "5h", usedPct: 84, level: 1, resetAt: 2_000, etaMs: 500 },
          { scope: "week", usedPct: 29, level: 0, resetAt: 50_000 },
        ],
      },
      {
        id: "kimi-coding",
        level: 2,
        stale: false,
        demotedUntil: 10_000,
        windows: [{ scope: "week", usedPct: 91, level: 2, resetAt: 60_000 }],
      },
      {
        id: "zai",
        level: 0,
        stale: true,
        windows: [{ scope: "5h", usedPct: 41, level: 0 }],
      },
    ]);
  }

  it("starts closed; click opens with aria-expanded/controls wired, and mounts the card", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: threeProviderQuota() }, attachTo: document.body }));
    const pill = wrapper.get(".q-pill");
    expect(pill.attributes("aria-expanded")).toBe("false");
    expect(pill.attributes("aria-controls")).toBe("quota-panel");
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
    await pill.trigger("click");
    expect(pill.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find("#quota-panel").exists()).toBe(true);
    expect(wrapper.find("#quota-panel").attributes("role")).toBe("dialog");
  });

  it("renders ONE merged GLM row + Kimi with name/plan/stale/demoted badges (the pair always merges)", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: threeProviderQuota() }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const provRows = wrapper.findAll(".q-prov");
    expect(provRows).toHaveLength(2); // GLM pair merged — never a second "GLM Intl" row
    expect(provRows[0]!.find(".q-name").text()).toBe("GLM");
    expect(provRows[0]!.find(".q-plan").text()).toBe("pro");
    expect(provRows[0]!.find(".q-badge.q-stale").exists()).toBe(true); // the intl side's stale flag survives the merge
    expect(provRows[1]!.find(".q-name").text()).toBe("Kimi");
    expect(provRows[1]!.find(".q-badge.q-demoted").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("GLM Intl");
  });

  it("each window row shows a level-colored bar, the percent, and the reset time (always, D2)", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: threeProviderQuota() }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const rows = wrapper.findAll(".q-row");
    expect(rows.length).toBe(3); // 2 (merged GLM worst-of: cn's L1 5h + week) + 1 (Kimi week) windows
    const firstBar = rows[0]!.find(".q-bar");
    expect(firstBar.attributes("data-lv")).toBe("1");
    expect(rows[0]!.find(".q-val").text()).toBe("84%");
    expect(rows[0]!.find(".q-sub").exists()).toBe(true);
  });

  it("ETA-before-reset renders the warn line (D6: 'ETA<reset ⇒ warn text')", async () => {
    const resetAt = Date.now() + 10 * 60 * 60_000; // 10h away — safely after the 28-minute ETA
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 3,
        stale: false,
        windows: [{ scope: "5h", usedPct: 84, level: 3, resetAt, etaMs: 28 * 60_000 }],
      },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const sub = wrapper.get(".q-sub");
    expect(sub.classes()).toContain("q-warn");
    expect(sub.text()).toContain("28 min");
  });

  it("Esc closes the card and calls preventDefault (never double-handled by a global Escape listener)", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: threeProviderQuota() }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    await flushPromises();
    expect(ev.defaultPrevented).toBe(true);
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
    expect(wrapper.get(".q-pill").attributes("aria-expanded")).toBe("false");
  });

  it("outside pointerdown closes the card; a click on the pill itself does not", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: threeProviderQuota() }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    expect(wrapper.find("#quota-panel").exists()).toBe(true);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
  });

  it("closing returns focus to the trigger button", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: threeProviderQuota() }, attachTo: document.body }));
    const pillEl = wrapper.get(".q-pill").element as HTMLButtonElement;
    await wrapper.get(".q-pill").trigger("click");
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    await flushPromises();
    expect(document.activeElement).toBe(pillEl);
  });
});

describe("quota.css / tokens.css — four-tier color ladder (verification r_WV2Y9VQZ #1)", () => {
  const quotaCss = readFileSync(resolve(REPO_ROOT, "src/web-hub/ui/src/styles/quota.css"), "utf8");
  const tokensCss = readFileSync(resolve(REPO_ROOT, "src/web-hub/ui/src/styles/tokens.css"), "utf8");

  /** Pulls the declaration block for one `selector { ... }` rule (first match only — every
   *  selector used below appears exactly once in quota.css). */
  function ruleBody(css: string, selector: string): string {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
    const m = re.exec(css);
    if (m === null) throw new Error(`rule not found in CSS: ${selector}`);
    return m[1]!;
  }

  it("per-segment dots: L0 uses --c-success, L1 --c-warning, L2 --c-orange, L3 --c-danger — and only L3 text escalates (danger + font-weight, available segments stay muted)", () => {
    expect(ruleBody(quotaCss, '.q-seg[data-level="0"] .q-dot')).toContain("--c-success");
    expect(ruleBody(quotaCss, '.q-seg[data-level="1"] .q-dot')).toContain("--c-warning");
    expect(ruleBody(quotaCss, '.q-seg[data-level="2"] .q-dot')).toContain("--c-orange");
    expect(ruleBody(quotaCss, '.q-seg[data-level="2"] .q-dot')).not.toContain("--c-danger");
    expect(ruleBody(quotaCss, '.q-seg[data-level="3"] .q-dot')).toContain("--c-danger");
    expect(ruleBody(quotaCss, '.q-seg[data-level="3"] .q-dot')).not.toContain("--c-orange");
    expect(ruleBody(quotaCss, '.q-seg[data-level="3"] .q-seg-text')).toContain("--c-danger");
    expect(ruleBody(quotaCss, '.q-seg[data-level="3"] .q-seg-text')).toContain("--fw-semibold");
    expect(ruleBody(quotaCss, ".q-seg-text")).not.toContain("--c-danger");
    expect(ruleBody(quotaCss, ".q-seg-text")).not.toContain("--fw-semibold");
  });

  it("pill width is bounded and the text may shrink/ellipsis — 3 alerting groups must never push the bar's controls off-viewport (verifier #3)", () => {
    const pill = ruleBody(quotaCss, ".q-pill");
    expect(pill).toContain("max-width");
    expect(pill).toContain("min-width: 0");
    expect(pill).toContain("flex: 0 1 auto"); // shrinks like `.brand`, no longer `flex: none`
    expect(ruleBody(quotaCss, ".q-pill-text")).toContain("text-overflow: ellipsis");
    expect(ruleBody(quotaCss, ".q-pill-text")).toContain("min-width: 0");
  });

  it("pill-level ladder keeps the whole-pill border/background semantics by MAX level (never color-only confusion)", () => {
    expect(ruleBody(quotaCss, '.q-pill[data-level="1"]')).toContain("--c-warning");
    expect(ruleBody(quotaCss, '.q-pill[data-level="2"]')).toContain("--c-orange");
    expect(ruleBody(quotaCss, '.q-pill[data-level="2"]')).not.toContain("--c-danger");
    expect(ruleBody(quotaCss, '.q-pill[data-level="2"]')).not.toContain("--fw-semibold");
    expect(ruleBody(quotaCss, '.q-pill[data-level="3"]')).toContain("--c-danger");
    expect(ruleBody(quotaCss, '.q-pill[data-level="3"]')).not.toContain("--c-orange");
  });

  it("the card's progress bar fill follows the same four-tier mapping (L2 orange, distinct from L3 danger)", () => {
    expect(ruleBody(quotaCss, '.q-bar[data-lv="1"] > i')).toContain("--c-warning");
    expect(ruleBody(quotaCss, '.q-bar[data-lv="2"] > i')).toContain("--c-orange");
    expect(ruleBody(quotaCss, '.q-bar[data-lv="2"] > i')).not.toContain("--c-danger");
    expect(ruleBody(quotaCss, '.q-bar[data-lv="3"] > i')).toContain("--c-danger");
    expect(ruleBody(quotaCss, '.q-bar[data-lv="3"] > i')).not.toContain("--c-orange");
  });

  it("--c-orange/-soft/-border/-text exist in all three token blocks (light :root, prefers-color-scheme dark, .theme-dark) — same parity as --c-warning", () => {
    const ORANGE_VARS = ["--c-orange:", "--c-orange-soft:", "--c-orange-border:", "--c-orange-text:"];
    const occurrences = (needle: string) => tokensCss.split(needle).length - 1;
    for (const v of ORANGE_VARS) {
      expect(occurrences(v), `${v} should be defined exactly 3 times (light + prefers-dark + .theme-dark)`).toBe(3);
    }
  });
});

describe("QuotaCard.vue — GLM merge (2026-10-14: ALWAYS one row, per-scope worst-of windows; same `glmPair` rule as the pill)", () => {
  function glmQuota(cnWindows: QuotaWire["providers"][number]["windows"], intlWindows: typeof cnWindows): QuotaWire {
    return quota([
      { id: "zai-coding-cn", level: 0, stale: false, plan: "pro", windows: cnWindows },
      { id: "zai", level: 0, stale: false, plan: "max", windows: intlWindows },
      { id: "kimi-coding", level: 0, stale: false, windows: [{ scope: "week", usedPct: 20, level: 0 }] },
    ]);
  }

  const equalW = [
    { scope: "5h" as const, usedPct: 42, level: 0 as const, resetAt: 1_000 },
    { scope: "week" as const, usedPct: 41, level: 0 as const, resetAt: 2_000 },
  ];

  it("equal pair renders ONE 'GLM' row (worst-of = identical windows here) + Kimi — never a second GLM Intl row", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: glmQuota(equalW, equalW) }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const provRows = wrapper.findAll(".q-prov");
    expect(provRows).toHaveLength(2);
    expect(provRows[0]!.find(".q-name").text()).toBe("GLM");
    expect(provRows[0]!.findAll(".q-row")).toHaveLength(2); // 5h + week from the cn side
    expect(provRows[1]!.find(".q-name").text()).toBe("Kimi");
    expect(wrapper.text()).not.toContain("GLM Intl");
  });

  it("merged row aggregates badges: one badge per distinct plan", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: glmQuota(equalW, equalW) }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const plans = wrapper.findAll(".q-plan").map((p) => p.text());
    expect(plans).toEqual(["pro", "max"]);
  });

  it("differing pair STILL renders ONE merged row — its windows are the per-scope worst-of", async () => {
    const wrapper = m(
      mount(QuotaPill, {
        props: {
          quota: glmQuota(
            [{ scope: "5h", usedPct: 42, level: 0, resetAt: 1_000 }],
            [{ scope: "5h", usedPct: 71, level: 1, resetAt: 9_000 }],
          ),
        },
        attachTo: document.body,
      }),
    );
    await wrapper.get(".q-pill").trigger("click");
    const provRows = wrapper.findAll(".q-prov");
    expect(provRows).toHaveLength(2); // merged GLM + Kimi — never a split "GLM Intl" row
    expect(provRows[0]!.find(".q-name").text()).toBe("GLM");
    expect(provRows[0]!.find(".q-val").text()).toBe("71%"); // the intl side's worse 5h window (L1 beats L0)
    expect(provRows[1]!.find(".q-name").text()).toBe("Kimi");
    expect(wrapper.text()).not.toContain("GLM Intl");
  });

  it("merged window keeps ITS OWN reset/eta from the side that supplied it (internally consistent row)", async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 16, 0));
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 0,
        stale: false,
        windows: [{ scope: "5h", usedPct: 42, level: 0, resetAt: new Date(2026, 9, 8, 18, 0).getTime() }],
      },
      {
        id: "zai",
        level: 1,
        stale: false,
        windows: [
          {
            scope: "5h",
            usedPct: 80,
            level: 1,
            resetAt: new Date(2026, 9, 8, 20, 0).getTime(),
            etaMs: 30 * 60_000,
          },
        ],
      },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const sub = wrapper.get(".q-sub");
    expect(sub.classes()).toContain("q-warn");
    expect(sub.text()).toContain("30 min"); // the intl side's eta rides its own (worse) window…
    expect(sub.text()).toContain("20:00 reset"); // …and so does its reset clock
    expect(sub.text()).not.toContain("18:00"); // never the cn side's clock on the intl side's numbers
  });

  it("reversed snapshot order (zai BEFORE zai-coding-cn) still labels the merged row 'GLM' at the pair's first slot; equal values tie ⇒ the cn side's clock", async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 16, 0));
    // Same values (exact tie) but DIFFERENT resetAts: the merged window keeps the CN side's
    // 18:20, never the intl side's 10/9 04:00 — ties keep the cn side's window (cn compared
    // first in the worst-of concat).
    const cnW = [
      { scope: "5h" as const, usedPct: 42, level: 0 as const, resetAt: new Date(2026, 9, 8, 18, 20).getTime() },
    ];
    const intlW = [
      { scope: "5h" as const, usedPct: 42, level: 0 as const, resetAt: new Date(2026, 9, 9, 4, 0).getTime() },
    ];
    const q = quota([
      { id: "kimi-coding", level: 0, stale: false, windows: [{ scope: "week", usedPct: 20, level: 0 }] },
      { id: "zai", level: 0, stale: false, plan: "max", windows: intlW },
      { id: "zai-coding-cn", level: 0, stale: false, plan: "pro", windows: cnW },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const provRows = wrapper.findAll(".q-prov");
    expect(provRows).toHaveLength(2); // merged at zai's (first-of-pair) slot, cn's own slot gone
    expect(provRows[0]!.find(".q-name").text()).toBe("Kimi");
    expect(provRows[1]!.find(".q-name").text()).toBe("GLM"); // NOT "GLM Intl"
    expect(provRows[1]!.find(".q-sub").text()).toContain("18:20 reset"); // the cn side's clock (tie)
    expect(provRows[1]!.find(".q-sub").text()).not.toContain("10/9");
    const plans = provRows[1]!.findAll(".q-plan").map((p) => p.text());
    expect(plans).toEqual(["pro", "max"]); // BOTH members' plans survive the merge
  });

  it("merged row never loses a member's flags: demoted + stale show BOTH badges (verifier #2)", async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 16, 0));
    const fetchedAt = Date.now() - 12 * 60_000;
    const q = quota([
      {
        id: "zai-coding-cn",
        level: 0,
        stale: false,
        demotedUntil: new Date(2026, 9, 8, 20, 0).getTime(),
        windows: equalW,
      },
      { id: "zai", level: 0, stale: true, fetchedAt, windows: equalW },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const head = wrapper.findAll(".q-prov")[0]!;
    const demoted = head.find(".q-badge.q-demoted");
    const stale = head.find(".q-badge.q-stale");
    expect(demoted.exists()).toBe(true);
    expect(demoted.text()).toContain("20:00");
    expect(stale.exists()).toBe(true);
    expect(stale.text()).toBe("stale 12 min");
  });

  it("both members stale with different ages ⇒ one stale badge each, own age", async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 16, 0));
    const q = quota([
      { id: "zai-coding-cn", level: 0, stale: true, fetchedAt: Date.now() - 31 * 60_000, windows: equalW },
      { id: "zai", level: 0, stale: true, fetchedAt: Date.now() - 12 * 60_000, windows: equalW },
    ]);
    const wrapper = m(mount(QuotaPill, { props: { quota: q }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const badges = wrapper.findAll(".q-prov")[0]!.findAll(".q-badge.q-stale");
    expect(badges.map((b) => b.text())).toEqual(["stale 31 min", "stale 12 min"]);
  });
});

describe("QuotaCard.vue — stale badge age (verification r_WV2Y9VQZ #2)", () => {
  function staleQuota(stale: boolean, fetchedAt?: number): QuotaWire {
    return quota([
      {
        id: "zai",
        level: 0,
        stale,
        ...(fetchedAt === undefined ? {} : { fetchedAt }),
        windows: [{ scope: "5h", usedPct: 41, level: 0 }],
      },
    ]);
  }

  it("shows an age ('stale N min') when fetchedAt is known", async () => {
    const fetchedAt = Date.now() - 12 * 60_000; // 12 minutes ago
    const wrapper = m(mount(QuotaPill, { props: { quota: staleQuota(true, fetchedAt) }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const badge = wrapper.get(".q-badge.q-stale");
    expect(badge.text()).toBe("stale 12 min");
  });

  it("falls back to a bare 'stale' badge when fetchedAt is absent (defensive / older peer)", async () => {
    const wrapper = m(mount(QuotaPill, { props: { quota: staleQuota(true) }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    const badge = wrapper.get(".q-badge.q-stale");
    expect(badge.text()).toBe("stale");
  });

  it("clamps a negative age (clock skew) to 0 rather than printing a negative number", async () => {
    const fetchedAt = Date.now() + 5 * 60_000; // in the "future" relative to the browser clock
    const wrapper = m(mount(QuotaPill, { props: { quota: staleQuota(true, fetchedAt) }, attachTo: document.body }));
    await wrapper.get(".q-pill").trigger("click");
    expect(wrapper.get(".q-badge.q-stale").text()).toBe("stale 0 min");
  });

  it("no stale badge at all when stale is false, even with fetchedAt present", async () => {
    const wrapper = m(
      mount(QuotaPill, { props: { quota: staleQuota(false, Date.now() - 60_000) }, attachTo: document.body }),
    );
    await wrapper.get(".q-pill").trigger("click");
    expect(wrapper.find(".q-badge.q-stale").exists()).toBe(false);
  });
});
