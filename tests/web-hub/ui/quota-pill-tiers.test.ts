// @vitest-environment happy-dom
/**
 * Width tiers + hover peek (2026-10-15, 「quota 在 topbar 的宽度不能一直增长，如果项目过多，
 * 可以转换成悬浮展示的形式」): the three-face pill (full / compact / names) chosen by measured
 * natural width, the 8px expansion hysteresis, the CSS-cap + bar-grant limits, and the hover
 * popover timing (peek open/close, click pin, focus policy).
 *
 * Measurement is driven through a FAKE ResizeObserver plus per-element width stubs: the real
 * happy-dom RO never fires callbacks (verified 2026-10-15 — the very property that keeps the
 * byte-parity goldens free of the measurer), so the component's `canMeasure` gate is flipped
 * manually here. Widths are stubbed on the elements themselves (`offsetWidth`) because
 * happy-dom performs no layout.
 */
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuotaPill from "../../../src/web-hub/ui/src/components/quota/QuotaPill.vue";
import type { QuotaWire } from "../../../src/web-hub/protocol/messages.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/* ------------------------------------------------------------------ fakes & helpers */

type FireRO = (width?: number) => void;
let fireRO: FireRO | undefined;

class FakeResizeObserver {
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    fireRO = (width = 800): void => {
      cb([{ contentRect: { width } } as ResizeObserverEntry]);
    };
  }
  observe(): void {}
  disconnect(): void {}
}

/** Live media-query state per query (the stub's `addEventListener` registers here), so a test
 *  can FLIP a band after mount — the desktop→phone transition — exactly like a viewport
 *  resize does in a real browser. */
const mediaListeners = new Map<string, Array<(ev: { matches: boolean }) => void>>();

function stubMedia(opts: { mobile?: boolean; phone?: boolean; hover?: boolean }): void {
  mediaListeners.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(max-width: 767px)"
        ? opts.mobile === true
        : query === "(max-width: 480px)"
          ? opts.phone === true
          : query === "(hover: hover) and (pointer: fine)"
            ? opts.hover === true
            : false,
    media: query,
    addEventListener: (_type: "change", listener: (ev: { matches: boolean }) => void): void => {
      const arr = mediaListeners.get(query) ?? [];
      arr.push(listener);
      mediaListeners.set(query, arr);
    },
    removeEventListener: (): void => {},
  }));
}

/** Flip one stubbed media query after mount (fires the captured change listeners). */
function flipMedia(query: string, matches: boolean): void {
  for (const listener of mediaListeners.get(query) ?? []) listener({ matches });
}

/** Fixed element widths (happy-dom has no layout, so `offsetWidth` is stubbed per element). */
function stubWidths(el: Element, values: Record<string, number>): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(el, key, { configurable: true, value });
  }
}

interface TierWidths {
  /** the flex bar's grant for the anchor (`availableWidth`) */
  avail: number;
  /** the pill's CSS max-width as resolved by the `cssCapPx` probe (read off the real button) */
  cap: number;
  full: number;
  compact: number;
  names: number;
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fireRO = undefined;
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

function mixedQuota(over: Partial<QuotaWire> = {}): QuotaWire {
  return {
    v: 1,
    at: 1_000,
    providers: [
      {
        id: "zai-coding-cn",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 12, level: 0 },
          { scope: "week", usedPct: 35, level: 0 },
        ],
      },
      {
        id: "zai",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 12, level: 0 },
          { scope: "week", usedPct: 35, level: 0 },
        ],
      },
      {
        id: "kimi-coding",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 6, level: 0 },
          { scope: "week", usedPct: 77, level: 0 },
        ],
      },
      {
        id: "droid-standard",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 0, level: 0 },
          { scope: "week", usedPct: 56, level: 0 },
          { scope: "month", usedPct: 28, level: 0 },
        ],
      },
    ],
    ...over,
  };
}

/** Mounts, fires the first RO delivery (flips `canMeasure`, renders the measurer), then applies
 *  the width stubs and re-fires so `evaluateFace` runs against them. */
async function mountMeasured(q: QuotaWire, widths: TierWidths, opts: { phone?: boolean } = {}) {
  stubMedia({ phone: opts.phone === true, hover: false });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const wrapper = mount(QuotaPill, { props: { quota: q }, attachTo: document.body });
  mounted.push(wrapper);
  fireRO?.();
  await nextTick(); // first RO delivery flips canMeasure; evaluateFace builds the measurer host
  await nextTick();
  const btn = wrapper.get("button.q-pill").element;
  const anchor = wrapper.element as HTMLElement;
  stubWidths(btn, { offsetWidth: widths.cap });
  stubWidths(anchor, { offsetWidth: widths.avail });
  if (opts.phone !== true) {
    // host children order = FACE_TIERS order (full, compact, names)
    const tiers = wrapper.findAll(".q-measure .q-measure-t");
    expect(tiers).toHaveLength(3);
    stubWidths(tiers[0]!.element, { offsetWidth: widths.full });
    stubWidths(tiers[1]!.element, { offsetWidth: widths.compact });
    stubWidths(tiers[2]!.element, { offsetWidth: widths.names });
  }
  fireRO?.();
  await nextTick();
  await nextTick();
  return wrapper;
}

/* ------------------------------------------------------------------ tier selection */

describe("QuotaPill — width tiers", () => {
  it("before any RO delivery: full face exactly as today, no measurer in the DOM, no data-face", async () => {
    stubMedia({});
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const wrapper = mount(QuotaPill, { props: { quota: mixedQuota() } });
    mounted.push(wrapper);
    expect(wrapper.find(".q-measure").exists()).toBe(false);
    expect(wrapper.get("button.q-pill").attributes("data-face")).toBeUndefined();
    expect(wrapper.get("button.q-pill .q-pill-text").text()).toBe(
      "GLM 5h 12% · 7d 35% · Kimi 5h 6% · 7d 77% · Droid Std 5h 0% · 7d 56% · mo 28%",
    );
  });

  it("first RO delivery renders the measurer with all three tier faces", async () => {
    stubMedia({});
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const wrapper = mount(QuotaPill, { props: { quota: mixedQuota() } });
    mounted.push(wrapper);
    fireRO?.();
    await nextTick();
    const tiers = wrapper.findAll(".q-measure .q-measure-t");
    expect(tiers).toHaveLength(3);
    expect(tiers[0]!.text()).toContain("GLM 5h 12% · 7d 35%"); // full clone
    expect(tiers[1]!.text()).toContain("GLM 7d 35%"); // compact clone
    expect(tiers[2]!.text()).toContain("Droid Std"); // names clone
    // R1/R2: each clone renders in ITS OWN tier's CSS (`data-face`) — never whatever the live
    // pill happened to carry at clone time — so semibold/chip styles apply to the measurement.
    expect(tiers.map((t) => t.attributes("data-face"))).toEqual(["full", "compact", "names"]);
    expect(wrapper.get(".q-measure").attributes("aria-hidden")).toBe("true");
  });

  it("full overflows the bar grant ⇒ compact tier: label + most-constrained window + pct", async () => {
    const wrapper = await mountMeasured(mixedQuota(), { avail: 450, cap: 560, full: 500, compact: 420, names: 260 });
    const pill = wrapper.get("button.q-pill");
    expect(pill.attributes("data-face")).toBe("compact");
    expect(pill.get(".q-pill-text").text()).toBe("GLM 7d 35% · Kimi 7d 77% · Droid Std 7d 56%");
    // aria/title keep the FULL per-group sentence in every tier (headline window, as today)
    const aria = pill.attributes("aria-label");
    expect(aria).toContain("GLM 7d 35%");
    expect(aria).toContain("Kimi 7d 77%");
    expect(pill.attributes("title")).toBe(aria);
  });

  it("compact overflows too ⇒ names tier: label only, colour carries state", async () => {
    const wrapper = await mountMeasured(mixedQuota(), { avail: 300, cap: 560, full: 500, compact: 480, names: 260 });
    const pill = wrapper.get("button.q-pill");
    expect(pill.attributes("data-face")).toBe("names");
    expect(pill.get(".q-pill-text").text()).toBe("GLM · Kimi · Droid Std");
    expect(pill.attributes("aria-label")).toContain("GLM 7d 35%"); // full sentence stays
  });

  it("names overflowing too ⇒ stays names (CSS ellipsis takes over), never crashes", async () => {
    const wrapper = await mountMeasured(mixedQuota(), { avail: 100, cap: 560, full: 500, compact: 480, names: 260 });
    expect(wrapper.get("button.q-pill").attributes("data-face")).toBe("names");
  });

  it("the pill's own CSS cap binds even when the bar has room", async () => {
    const wrapper = await mountMeasured(mixedQuota(), { avail: 1000, cap: 450, full: 500, compact: 420, names: 260 });
    expect(wrapper.get("button.q-pill").attributes("data-face")).toBe("compact");
  });

  it("hysteresis: expanding back needs 8px slack — full fitting exactly keeps compact, full+8 expands", async () => {
    // drop to compact first
    const wrapper = await mountMeasured(mixedQuota(), { avail: 450, cap: 560, full: 500, compact: 420, names: 260 });
    expect(wrapper.get("button.q-pill").attributes("data-face")).toBe("compact");
    // widen: full now fits by 5px (< 8px slack) ⇒ must NOT expand
    stubWidths(wrapper.element, { offsetWidth: 505 });
    fireRO?.();
    await nextTick();
    await nextTick();
    expect(wrapper.get("button.q-pill").attributes("data-face")).toBe("compact");
    // widen past the hysteresis dead zone ⇒ full returns (byte-identical text)
    stubWidths(wrapper.element, { offsetWidth: 512 });
    fireRO?.();
    await nextTick();
    await nextTick();
    const pill = wrapper.get("button.q-pill");
    expect(pill.attributes("data-face")).toBeUndefined();
    expect(pill.get(".q-pill-text").text()).toContain("GLM 5h 12% · 7d 35%");
  });

  it("hysteresis from names skips straight to the fullest tier that fits WITH slack", async () => {
    const wrapper = await mountMeasured(mixedQuota(), { avail: 300, cap: 560, full: 500, compact: 480, names: 260 });
    expect(wrapper.get("button.q-pill").attributes("data-face")).toBe("names");
    // widen: full fits by 5px but lacks slack; compact has plenty ⇒ expand to COMPACT, not full
    stubWidths(wrapper.element, { offsetWidth: 505 });
    fireRO?.();
    await nextTick();
    await nextTick();
    expect(wrapper.get("button.q-pill").attributes("data-face")).toBe("compact");
  });

  it("most-constrained window = max usedPct (not the level-ranked headline); tie ⇒ longer window", async () => {
    const tie = mixedQuota();
    tie.providers = [
      {
        id: "kimi-coding",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 50, level: 0 },
          { scope: "week", usedPct: 50, level: 0 },
        ],
      },
    ];
    const w1 = await mountMeasured(tie, { avail: 200, cap: 560, full: 300, compact: 150, names: 80 });
    expect(w1.get("button.q-pill .q-pill-text").text()).toBe("Kimi 7d 50%");
    w1.unmount();
    const monthTie = mixedQuota();
    monthTie.providers = [
      {
        id: "kimi-coding",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 50, level: 0 },
          { scope: "week", usedPct: 50, level: 0 },
          { scope: "month", usedPct: 50, level: 0 },
        ],
      },
    ];
    const w2 = await mountMeasured(monthTie, { avail: 200, cap: 560, full: 300, compact: 150, names: 80 });
    expect(w2.get("button.q-pill .q-pill-text").text()).toBe("Kimi mo 50%");
    w2.unmount();
    const pctWins = mixedQuota();
    pctWins.providers = [
      {
        id: "kimi-coding",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 62, level: 0 },
          { scope: "week", usedPct: 35, level: 0 },
        ],
      },
    ];
    const w3 = await mountMeasured(pctWins, { avail: 200, cap: 560, full: 300, compact: 150, names: 80 });
    expect(w3.get("button.q-pill .q-pill-text").text()).toBe("Kimi 5h 62%");
    w3.unmount();
  });

  it("exhausted mode: compact keeps ⚠ + clock dropped; names keeps ⚠ + label", async () => {
    const exhausted = mixedQuota();
    for (const p of exhausted.providers) {
      p.level = 3;
      for (const w of p.windows) {
        w.level = 3;
        w.usedPct = 98;
      }
    }
    exhausted.providers[3]!.windows = [{ scope: "week", usedPct: 98, level: 3, resetAt: 9_000 }];
    const compact = await mountMeasured(exhausted, { avail: 450, cap: 560, full: 500, compact: 420, names: 260 });
    expect(compact.get("button.q-pill").attributes("data-face")).toBe("compact");
    expect(compact.get("button.q-pill .q-pill-text").text()).toBe("⚠ GLM 7d 98% · ⚠ Kimi 7d 98% · ⚠ Droid Std 7d 98%");
    compact.unmount();
    const names = await mountMeasured(exhausted, { avail: 300, cap: 560, full: 500, compact: 480, names: 260 });
    expect(names.get("button.q-pill").attributes("data-face")).toBe("names");
    expect(names.get("button.q-pill .q-pill-text").text()).toBe("⚠ GLM · ⚠ Kimi · ⚠ Droid Std");
    names.unmount();
  });

  it("problem chips shrink to `auth 402` in the compact/names tiers (full keeps `Droid auth 402`)", async () => {
    const q = mixedQuota({ problems: [{ family: "droid", status: 402 }] });
    const compact = await mountMeasured(q, { avail: 450, cap: 560, full: 500, compact: 480, names: 260 });
    expect(compact.get(".q-problem").text()).toBe("auth 402");
    compact.unmount();
    const names = await mountMeasured(q, { avail: 300, cap: 560, full: 500, compact: 480, names: 280 });
    expect(names.get(".q-problem").text()).toBe("auth 402");
    names.unmount();
    stubMedia({});
    const full = mount(QuotaPill, { props: { quota: q } });
    mounted.push(full);
    expect(full.get(".q-problem").text()).toBe("Droid auth 402");
  });

  it("desktop→phone after mount: data-face is not rendered on the phone chip; →desktop restores the tier (R7)", async () => {
    const wrapper = await mountMeasured(mixedQuota(), { avail: 450, cap: 560, full: 500, compact: 420, names: 260 });
    const pill = wrapper.get("button.q-pill");
    expect(pill.attributes("data-face")).toBe("compact"); // desktop tier engaged
    flipMedia("(max-width: 480px)", true); // viewport shrank to ≤480px AFTER mount
    await nextTick();
    expect(pill.attributes("data-face")).toBeUndefined(); // phone chip: never carries data-face
    expect(wrapper.get(".q-pill-text").text()).toBe("77%"); // old chip form, byte-for-byte
    expect(wrapper.find(".q-seg-compact").exists()).toBe(true);
    flipMedia("(max-width: 480px)", false); // back to desktop — RO re-evaluates the tier
    await nextTick();
    fireRO?.();
    await nextTick();
    await nextTick();
    expect(pill.attributes("data-face")).toBe("compact");
    expect(pill.get(".q-pill-text").text()).toBe("GLM 7d 35% · Kimi 7d 77% · Droid Std 7d 56%");
  });

  it("phone (≤480px): measurement stays inert — chip form, no measurer, no data-face", async () => {
    const wrapper = await mountMeasured(
      mixedQuota(),
      { avail: 100, cap: 560, full: 500, compact: 480, names: 260 },
      { phone: true },
    );
    expect(wrapper.find(".q-measure").exists()).toBe(false);
    const pill = wrapper.get("button.q-pill");
    expect(pill.attributes("data-face")).toBeUndefined();
    expect(pill.get(".q-pill-text").text()).toBe("77%"); // worst-of-snapshot chip, unchanged
  });
});

/* ------------------------------------------------------------------ hover peek */

describe("QuotaPill — hover peek popover", () => {
  async function mountHoverable(): Promise<ReturnType<typeof mount>> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubMedia({ hover: true });
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const wrapper = mount(QuotaPill, { props: { quota: mixedQuota() }, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
  }

  it("~150ms hover opens the card as a peek; ~200ms after leaving the pill it closes", async () => {
    const wrapper = await mountHoverable();
    const pill = wrapper.get("button.q-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(149);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(true);
    expect(pill.attributes("aria-expanded")).toBe("true");
    await pill.trigger("mouseleave");
    vi.advanceTimersByTime(199);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(true);
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
    expect(pill.attributes("aria-expanded")).toBe("false");
  });

  it("pill→card traversal within the 200ms grace keeps the peek open; leaving the card closes it", async () => {
    const wrapper = await mountHoverable();
    const pill = wrapper.get("button.q-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(150);
    await pill.trigger("mouseleave");
    vi.advanceTimersByTime(100); // inside the grace window
    await wrapper.get("#quota-panel").trigger("mouseenter");
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(true);
    await wrapper.get("#quota-panel").trigger("mouseleave");
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
  });

  it("a click pins the card: mouseleave (pill or card) no longer closes; Esc still does", async () => {
    const wrapper = await mountHoverable();
    const pill = wrapper.get("button.q-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(150);
    await pill.trigger("click"); // pin on top of the peek
    await pill.trigger("mouseleave");
    await wrapper.get("#quota-panel").trigger("mouseleave");
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(true);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
  });

  it("re-entering the pill during the close grace cancels the close", async () => {
    const wrapper = await mountHoverable();
    const pill = wrapper.get("button.q-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(150);
    await pill.trigger("mouseleave");
    vi.advanceTimersByTime(100);
    await pill.trigger("mouseenter"); // cancel
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(true);
  });

  it("a peek mount never steals focus; a click-open (no hover) still focuses the panel", async () => {
    const wrapper = await mountHoverable();
    const pill = wrapper.get("button.q-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(150);
    await nextTick();
    expect(document.activeElement?.id).not.toBe("quota-panel"); // peek: no focus steal
    await pill.trigger("click");
    await pill.trigger("mouseleave");
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(true); // pinned stays
    expect(document.activeElement?.id).not.toBe("quota-panel"); // still never stole focus
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    await nextTick();
    wrapper.unmount();
    // click-open path (pointer never hovered): the classic mount-focus behaviour is intact
    vi.useRealTimers();
    stubMedia({ hover: true });
    const wrapper2 = mount(QuotaPill, { props: { quota: mixedQuota() }, attachTo: document.body });
    mounted.push(wrapper2);
    await wrapper2.get("button.q-pill").trigger("click");
    await nextTick();
    expect(document.activeElement?.id).toBe("quota-panel");
  });

  it("no auto-open on hover-incapable pointers (touch), and no auto-open on focus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubMedia({ hover: false });
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const wrapper = mount(QuotaPill, { props: { quota: mixedQuota() }, attachTo: document.body });
    mounted.push(wrapper);
    await wrapper.get("button.q-pill").trigger("mouseenter");
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
    await wrapper.get("button.q-pill").trigger("focus");
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.find("#quota-panel").exists()).toBe(false);
  });
});

/* ------------------------------------------------------------------ CSS pins */

describe("quota.css — tier + measurer pins", () => {
  const css = readFileSync(resolve(REPO_ROOT, "src/web-hub/ui/src/styles/quota.css"), "utf8");

  it("the pill's max-width cap was tightened to min(50vw, 560px)", () => {
    expect(css).toContain("max-width: min(50vw, 560px)");
  });

  it("the measurer is hidden without display:none and measures uncapped natural widths", () => {
    expect(css).toContain(".q-measure {");
    expect(css).toContain("visibility: hidden");
    expect(css.match(/\.q-measure \.q-pill \{[\s\S]*?\}/)?.[0]).toContain("max-width: none");
  });

  it("compact/names tiers colour the LABEL by the level ladder (incl. stale gray)", () => {
    const selectors = [
      '[data-face="compact"] .q-seg[data-level="0"] .q-seg-text',
      '[data-face="names"] .q-seg[data-level="0"] .q-seg-text',
    ];
    for (const sel of selectors) {
      const rule = css.match(
        new RegExp(`\\.q-pill${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,?\\s*[^{]*\\{([\\s\\S]*?)\\}`, "g"),
      );
      expect(rule, sel).not.toBeNull();
    }
    expect(css).toContain('[data-face="compact"] .q-seg[data-level="0"] .q-seg-text');
    expect(css).toContain('[data-face="names"] .q-seg[data-stale="true"] .q-seg-text');
  });
});
