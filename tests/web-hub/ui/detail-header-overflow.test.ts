// @vitest-environment happy-dom
/**
 * DetailHeader narrow-screen overflow (issue #41): the titlebar folds low-frequency right-side
 * buttons into a 「⋯」 menu (ResizeObserver + logic/headerFold.ts), degrades the alias chip to a
 * bare 「@」 glyph and the status pill to a bare dot at extreme widths, and never squeezes the
 * title below its 96px floor. Wide bars keep the pre-feature DOM (no ⋯ trigger at all).
 *
 * happy-dom does no layout (zero rects), so — like useCoarseClamp's tests — widths are stubbed
 * per element (Object.defineProperty offsetWidth/clientWidth) and the captured ResizeObserver
 * callback is fired manually.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import { TITLEBAR_ICON_TIER_MAX_PX } from "../../../src/web-hub/ui/src/logic/headerFold.js";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { PRIVACY_LOCK_CTX } from "../../../src/web-hub/ui/src/components/privacy/privacyContext.js";
import { RESUME_DIALOG } from "../../../src/web-hub/ui/src/logic/resume.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/** Captured ResizeObserver callbacks — tests fire them manually after stubbing widths. */
let roCallbacks: Array<() => void> = [];
class FakeRO {
  constructor(cb: () => void) {
    roCallbacks.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  roCallbacks = [];
  vi.stubGlobal("ResizeObserver", FakeRO);
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, // fine pointer: 32px icon buttons
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

const CAPS = ["xs.v1", "xs.channel.v1", "xs.alias.v1", "sched.v1"];

function agent(over: Partial<AgentState> = {}): AgentState {
  return {
    key: "agent-1",
    card: { agentKey: "agent-1", kind: "tui", pid: 123, cwd: "/home/bluecake/ai/pi-toolkit", state: "live" },
    down: false,
    session: {
      sessionId: "01a0d892-5c1e-7a40-9e2b-4f6d0c8a1b37",
      cwd: "/home/bluecake/ai/pi-toolkit",
      name: "web-hub Vue rewrite",
      model: { provider: "cr-anthropic", id: "claude-opus-5-5" },
      thinkingLevel: "high",
      mode: "tui",
    },
    status: {
      busy: true,
      features: ["resume.v1"],
      xs: { receive: "wake", joined: true, alias: "小艾" },
      xsInbox: { unread: 3 },
    },
    prompts: [],
    fleet: [],
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    ...over,
  } as unknown as AgentState;
}

function fakeControl(opts: { holdCommands?: boolean } = {}): { control: ControlHandle; runs: string[][] } {
  const runs: string[][] = [];
  const ok: CmdOutcome = { ok: true, data: { op: "command", kind: "builtin", completion: "unknown" } } as CmdOutcome;
  const control: ControlHandle = {
    runCommand: ((agentKey: string, name: string, args: string) => {
      runs.push([agentKey, name, args]);
      // holdCommands: never settle — lets a test observe the in-flight (clearing) UI state
      return opts.holdCommands === true ? new Promise<CmdOutcome>(() => {}) : Promise.resolve(ok);
    }) as ControlHandle["runCommand"],
    sendPrompt: (() => Promise.resolve({ ok: true })) as ControlHandle["sendPrompt"],
    abort: (() => Promise.resolve({ ok: true })) as ControlHandle["abort"],
    steerSub: (() => Promise.resolve({ ok: true })) as ControlHandle["steerSub"],
    stopSub: (() => Promise.resolve({ ok: true })) as ControlHandle["stopSub"],
    answerDialog: (() => Promise.resolve({ ok: true })) as ControlHandle["answerDialog"],
    cancelDialog: (() => Promise.resolve({ ok: true })) as ControlHandle["cancelDialog"],
    query: (() => Promise.resolve({ ok: true })) as ControlHandle["query"],
    retry: (() => Promise.resolve({ ok: true })) as ControlHandle["retry"],
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
  };
  return { control, runs };
}

function fakeView(control: ControlHandle): ControlView {
  const a = ref(agent());
  return {
    agentKey: "agent-1",
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => a.value),
    busy: computed(() => false),
    commands: computed(() => [{ name: "new", kind: "builtin", policy: "confirm" }]),
    commandsEnabled: computed(() => true),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
}

function fakeHub(opts: { managed?: boolean; removeOutcome?: Record<string, unknown> } = {}): {
  hub: HubHandle;
  stops: string[];
  removes: unknown[];
} {
  const stops: string[] = [];
  const removes: unknown[] = [];
  const spawns = opts.managed
    ? { items: [{ spawnId: "sp-1", agentKey: "agent-1", state: "live", updatedAt: 1 }] }
    : null;
  const hub = {
    state: ref({ hub: { caps: CAPS }, spawns } as unknown as HubState),
    dispatch() {},
    removeAgent: (target: unknown) => {
      removes.push(target);
      return Promise.resolve(opts.removeOutcome ?? { ok: true });
    },
    spawn: {
      stop: (spawnId: string) => {
        stops.push(spawnId);
        return Promise.resolve({ ok: true });
      },
      newSession: { flow: ref(undefined) },
    },
  } as unknown as HubHandle;
  return { hub, stops, removes };
}

function fakePrivacy(opts: { marked?: boolean } = {}) {
  return {
    enabled: ref(true),
    failClosed: computed(() => false),
    isMarked: () => opts.marked === true,
    isLocked: () => false,
    sessionIdOf: () => "01a0d892-5c1e-7a40-9e2b-4f6d0c8a1b37",
    mark: vi.fn(() => Promise.resolve(true)),
    unmark: vi.fn(() => Promise.resolve(true)),
    verify: vi.fn(() => Promise.resolve(true)),
    relock: vi.fn(),
    actionError: ref(null),
  };
}

interface Harness {
  wrapper: ReturnType<typeof mount>;
  runs: string[][];
  stops: string[];
  removes: unknown[];
  resume: { opens: number };
  remarks: unknown[];
}

function mountHeader(
  opts: {
    managed?: boolean;
    narrow?: boolean;
    privacyMarked?: boolean;
    holdCommands?: boolean;
    offline?: boolean;
    removeOutcome?: Record<string, unknown>;
  } = {},
): Harness {
  const { control, runs } = fakeControl({ holdCommands: opts.holdCommands });
  const { hub, stops, removes } = fakeHub(opts);
  const privacy = fakePrivacy({ marked: opts.privacyMarked });
  const resume = { opens: 0 };
  const wrapper = mount(DetailHeader, {
    props: { agent: agent(opts.offline === true ? { down: true } : {}), narrow: opts.narrow ?? false },
    attachTo: document.body, // focus assertions need a real document attachment
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: fakeView(control),
        [HUB_CTX as symbol]: hub,
        [PRIVACY_LOCK_CTX as symbol]: privacy,
        [RESUME_DIALOG as symbol]: { open: () => resume.opens++ },
      },
    },
  });
  mounted.push(wrapper);
  return { wrapper, runs, stops, removes, resume, remarks: privacy.mark.mock.calls };
}

/** Stub layout widths (happy-dom is all-zero) and fire the RO callback once. */
async function layOut(wrapper: ReturnType<typeof mount>, barWidth: number): Promise<void> {
  const bar = wrapper.get(".detail-titlebar").element as HTMLElement;
  Object.defineProperty(bar, "clientWidth", { configurable: true, value: barWidth });
  for (const el of bar.querySelectorAll("[data-fold]")) {
    Object.defineProperty(el, "offsetWidth", { configurable: true, value: 32 });
  }
  const back = bar.querySelector(".detail-back");
  if (back !== null) Object.defineProperty(back, "offsetWidth", { configurable: true, value: 40 });
  const alias = bar.querySelector("[data-alias]");
  if (alias !== null)
    Object.defineProperty(alias, "offsetWidth", {
      configurable: true,
      value: alias.classList.contains("is-glyph") ? 22 : 56,
    });
  const pill = bar.querySelector("[data-pill]");
  if (pill !== null) Object.defineProperty(pill, "offsetWidth", { configurable: true, value: 74 });
  const unread = bar.querySelector(".chip-xs-unread");
  if (unread !== null) Object.defineProperty(unread, "offsetWidth", { configurable: true, value: 30 });
  for (const cb of roCallbacks) cb();
  await flushPromises();
}

describe("DetailHeader overflow (issue #41)", () => {
  it("wide bar ⇒ every button visible, ⋯ holds only delete (managed), pill + alias in full form", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 1200);
    const bar = h.wrapper.get(".detail-titlebar");
    expect(bar.find(".detail-clear-btn").exists()).toBe(true);
    expect(bar.find(".detail-channels-btn").exists()).toBe(true);
    expect(bar.find(".detail-sched-btn").exists()).toBe(true);
    expect(bar.find(".detail-resume-btn").exists()).toBe(true);
    expect(bar.find(".privacy-head-btn").exists()).toBe(true);
    expect(bar.find(".spawn-stop-btn").exists()).toBe(true);
    // a managed (removable) session always carries ⋯ — holding only 「Delete session」 on a wide bar
    expect(bar.find(".detail-more-btn").exists()).toBe(true);
    expect(bar.find(".detail-head-menu").exists()).toBe(false);
    expect(bar.get(".pill").text()).toContain("Working");
    expect(bar.get(".detail-alias-btn").text()).toBe("@小艾");
    expect(bar.get(".chip-xs-unread").text()).toContain("3");
  });

  it("widening the bar restores every folded button and retires the ⋯ trigger", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 420); // folds privacy→…→stop, only clear stays
    const bar = h.wrapper.get(".detail-titlebar");
    expect(bar.find(".detail-more-btn").exists()).toBe(true);
    expect(bar.find(".spawn-stop-btn").exists()).toBe(false);
    await layOut(h.wrapper, 1200); // RO refires on the resize ⇒ fold recomputes to flat
    // ⋯ stays (managed ⇒ permanent 「Delete session」) but nothing else is folded into it
    await bar.get(".detail-more-btn").trigger("click");
    await flushPromises();
    expect(h.wrapper.findAll(".detail-head-menu .detail-head-menu-item").map((i) => i.text())).toEqual([
      "Delete session",
    ]);
    await bar.get(".detail-more-btn").trigger("click");
    expect(bar.find(".detail-clear-btn").exists()).toBe(true);
    expect(bar.find(".detail-channels-btn").exists()).toBe(true);
    expect(bar.find(".detail-sched-btn").exists()).toBe(true);
    expect(bar.find(".detail-resume-btn").exists()).toBe(true);
    expect(bar.find(".privacy-head-btn").exists()).toBe(true);
    expect(bar.find(".spawn-stop-btn").exists()).toBe(true);
  });

  it("narrow bar ⇒ folds in priority order (privacy→schedule→…→stop), keeps only clear, shows ⋯", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    // 100 title + 78 fixed + 60 alias + 78 pill + 6×36 = 532; bar 420: folding 4 leaves 424 > 420,
    // so stop folds too (388 ≤ 420) — clear is the only button that stays.
    await layOut(h.wrapper, 420);
    const bar = h.wrapper.get(".detail-titlebar");
    expect(bar.find(".privacy-head-btn").exists()).toBe(false);
    expect(bar.find(".detail-sched-btn").exists()).toBe(false);
    expect(bar.find(".detail-resume-btn").exists()).toBe(false);
    expect(bar.find(".detail-channels-btn").exists()).toBe(false);
    expect(bar.find(".spawn-stop-btn").exists()).toBe(false);
    expect(bar.find(".detail-clear-btn").exists()).toBe(true);
    expect(bar.get(".detail-more-btn").attributes("aria-haspopup")).toBe("menu");
    expect(bar.get(".detail-more-btn").attributes("aria-expanded")).toBe("false");
    // unread chip + alias + pill never fold
    expect(bar.find(".chip-xs-unread").exists()).toBe(true);
    expect(bar.get(".detail-alias-btn").text()).toBe("@小艾");
    expect(bar.get(".pill").text()).toContain("Working");
  });

  it("menu lists folded actions with icon+label in bar order; running one closes the menu and acts", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 420);
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
    const items = h.wrapper.findAll(".detail-head-menu .detail-head-menu-item");
    // bar order among the folded five; the channels item carries the held alias (issue #41)
    expect(items.map((i) => i.text())).toEqual([
      "Channels @小艾",
      "Schedules",
      "Resume",
      "Private",
      "Stop",
      "Delete session",
    ]);
    // review pass — secondary action states: dialogs announce aria-haspopup, the privacy item is
    // a checkbox reflecting the (un)marked state, the danger stop row is set off by a separator
    const byText = (s: string) => items.find((i) => i.text().includes(s))!;
    for (const s of ["Channels", "Schedules", "Resume"]) expect(byText(s).attributes("aria-haspopup")).toBe("dialog");
    expect(byText("Private").attributes("role")).toBe("menuitemcheckbox");
    expect(byText("Private").attributes("aria-checked")).toBe("false");
    expect(byText("Stop").attributes("aria-haspopup")).toBeUndefined();
    const seps = h.wrapper.findAll(".detail-head-menu-sep");
    expect(seps.length).toBe(2); // before Stop, and before the permanent Delete row
    expect(seps[0]!.attributes("role")).toBe("separator");
    expect((seps[0]!.element.nextElementSibling as HTMLElement).textContent).toContain("Stop");
    expect((seps[1]!.element.nextElementSibling as HTMLElement).textContent).toContain("Delete session");
    // the ⋯ wrap sits before the trailing state chips; the unread chip is the bar's LAST child
    const barEl = h.wrapper.get(".detail-titlebar").element;
    const kids = [...barEl.children];
    expect(kids.indexOf(h.wrapper.get(".detail-more-wrap").element)).toBeLessThan(
      kids.indexOf(h.wrapper.get(".chip-xs-unread").element),
    );
    expect(barEl.lastElementChild!.classList.contains("chip-xs-unread")).toBe(true);
    expect(h.wrapper.get(".detail-head-menu").attributes("role")).toBe("menu");
    expect(h.wrapper.get(".detail-more-btn").attributes("aria-expanded")).toBe("true");
    // 恢复 → opens the resume dialog host
    const resumeItem = items.find((i) => i.text().includes("Resume"));
    await resumeItem!.trigger("click");
    await flushPromises();
    expect(h.resume.opens).toBe(1);
    expect(h.wrapper.find(".detail-head-menu").exists()).toBe(false);
  });

  it("menu keyboard flow: ↓ opens + focuses first item, ↑↓ cycles with wrap, Esc closes and refocuses the trigger", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 420);
    const trigger = h.wrapper.get(".detail-more-btn");
    (trigger.element as HTMLElement).focus();
    await trigger.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    const items = h.wrapper.findAll(".detail-head-menu .detail-head-menu-item");
    expect(items.length).toBe(6);
    expect(document.activeElement).toBe(items[0]!.element);
    await h.wrapper.get(".detail-head-menu").trigger("keydown", { key: "ArrowUp" }); // wraps to last
    expect(document.activeElement).toBe(items[5]!.element);
    await h.wrapper.get(".detail-head-menu").trigger("keydown", { key: "ArrowDown" }); // wraps back
    expect(document.activeElement).toBe(items[0]!.element);
    await h.wrapper.get(".detail-head-menu").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(h.wrapper.find(".detail-head-menu").exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
  });

  it("「清空」 runs through the menu identically (runCommand new, confirm baked in)", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 380); // folds ALL six incl. clear (need 352 ≤ 380)
    expect(h.wrapper.find(".detail-clear-btn").exists()).toBe(false);
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
    const clearItem = h.wrapper
      .findAll(".detail-head-menu .detail-head-menu-item")
      .find((i) => i.text().includes("Clear"));
    await clearItem!.trigger("click");
    await flushPromises();
    expect(h.runs).toEqual([["agent-1", "new", ""]]);
  });

  it("folded 「停止会话」 arms from the menu: menu closes, the in-bar ✓/✕ pill appears, ✓ stops", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 400); // folds privacy..stop (388 ≤ 400), clear stays
    expect(h.wrapper.find(".spawn-stop-btn").exists()).toBe(false);
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
    const stopItem = h.wrapper
      .findAll(".detail-head-menu .detail-head-menu-item")
      .find((i) => i.text().includes("Stop"));
    expect(stopItem!.classes()).toContain("is-danger");
    await stopItem!.trigger("click");
    await flushPromises();
    // the two-step confirm pill surfaces IN THE BAR even though the idle button was folded
    expect(h.wrapper.find(".detail-head-menu").exists()).toBe(false);
    expect(h.wrapper.find(".spawn-stop-armed").exists()).toBe(true);
    await h.wrapper.get(".spawn-stop-armed-ok").trigger("click");
    await flushPromises();
    expect(h.stops).toEqual(["sp-1"]);
  });

  it("privacy already marked ⇒ the menu item is a checked menuitemcheckbox", async () => {
    const h = mountHeader({ managed: true, narrow: true, privacyMarked: true });
    await layOut(h.wrapper, 420);
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
    const item = h.wrapper.findAll(".detail-head-menu .detail-head-menu-item").find((i) => i.text().includes("Lock"));
    expect(item!.attributes("role")).toBe("menuitemcheckbox");
    expect(item!.attributes("aria-checked")).toBe("true");
  });

  it("clearing in flight ⇒ the folded 「清空」 item is disabled + aria-busy with the busy label", async () => {
    const h = mountHeader({ managed: true, narrow: true, holdCommands: true });
    await layOut(h.wrapper, 380); // folds ALL six incl. clear
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
    const clearItem = () =>
      h.wrapper.findAll(".detail-head-menu .detail-head-menu-item").find((i) => i.text().includes("Clear"));
    expect(clearItem()!.attributes("disabled")).toBeUndefined();
    await clearItem()!.trigger("click"); // starts /new — the held promise keeps `clearing` true
    await flushPromises();
    expect(h.runs).toEqual([["agent-1", "new", ""]]);
    await h.wrapper.get(".detail-more-btn").trigger("click"); // reopen while in flight
    await flushPromises();
    const busy = clearItem();
    expect(busy!.text()).toBe("Clearing…");
    expect(busy!.attributes("disabled")).toBeDefined();
    expect(busy!.attributes("aria-busy")).toBe("true");
  });

  it("extreme narrow ⇒ alias chip becomes the bare 「@」 button, status pill becomes a dot (role=img)", async () => {
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 300); // all folded (352) still > 300 ⇒ alias glyph (318) still > 300 ⇒ pill dot (264)
    const alias = h.wrapper.get(".detail-alias-btn");
    expect(alias.text()).toBe("@");
    expect(alias.attributes("aria-label")).toContain("小艾");
    const pill = h.wrapper.get(".pill");
    expect(pill.text()).toBe("");
    expect(pill.attributes("role")).toBe("img");
    expect(pill.attributes("aria-label")).toBe("Working");
    // unread chip stays readable
    expect(h.wrapper.get(".chip-xs-unread").text()).toContain("3");
    // review pass: with the chip degraded to 「@」, the full alias is the menu's first
    // (read-only) row — keyboard nav skips it (focus lands on the first ACTION)
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
    const menu = h.wrapper.get(".detail-head-menu");
    const note = menu.find(".detail-head-menu-note");
    expect(note.exists()).toBe(true);
    expect(note.text()).toBe("@小艾");
    expect(note.attributes("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(h.wrapper.findAll(".detail-head-menu .detail-head-menu-item")[0]!.element);
  });

  it("i18n: detail.moreActions + detail.clearBusyLabel exist in both locales", () => {
    expect(MESSAGES.en.detail.moreActions).toBe("More actions");
    expect(MESSAGES.zh.detail.moreActions).toBe("更多操作");
    expect(MESSAGES.en.detail.clearBusyLabel).toBe("Clearing…");
    expect(MESSAGES.zh.detail.clearBusyLabel).toBe("清空中…");
  });
});

// Review pass (issue #41): the icon-tier breakpoint lives in TWO places — the TS measurer and
// the CSS container/viewport queries. Pin them to the single exported constant, straight from
// the real sources (the mounted component never sees the stylesheet).
describe("icon-tier breakpoint sync (TS ⇆ CSS)", () => {
  const root = resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src");
  const css = readFileSync(resolve(root, "styles/detail.css"), "utf8");
  const vue = readFileSync(resolve(root, "components/detail/DetailHeader.vue"), "utf8");

  it("every 599px-class query in detail.css uses TITLEBAR_ICON_TIER_MAX_PX's value", () => {
    expect(TITLEBAR_ICON_TIER_MAX_PX).toBe(599);
    expect(css).toContain(`@container detail-titlebar (max-width: ${TITLEBAR_ICON_TIER_MAX_PX}px)`);
    expect(css).toContain(`@media (pointer: coarse) and (max-width: ${TITLEBAR_ICON_TIER_MAX_PX}px)`);
    expect(vue).toContain("TITLEBAR_ICON_TIER_MAX_PX");
    expect(vue).not.toMatch(/barWidth <= 599/); // no second hard-coded copy in the measurer
  });

  it("the icon tier's -4px sibling compression is FINE-pointer only; coarse compresses the track gap", () => {
    // the bare 599px container block (icon sizing) must not overlap hit boxes anymore
    const containerStart = css.indexOf(`@container detail-titlebar (max-width: ${TITLEBAR_ICON_TIER_MAX_PX}px) {`);
    const fineStart = css.indexOf("@media (pointer: fine)", containerStart);
    expect(containerStart).toBeGreaterThanOrEqual(0);
    expect(fineStart).toBeGreaterThan(containerStart);
    expect(css.slice(containerStart, fineStart)).not.toContain("margin-left: -4px");
    // …the negative margins live under the fine-pointer gate…
    const fineBlock = css.slice(fineStart, css.indexOf("@media (pointer: coarse) and", fineStart));
    expect(fineBlock).toContain("margin-left: -4px");
    // …and coarse pointers compact via the bar's own gap, never via overlap
    const coarseBlock = css.slice(css.indexOf("@media (pointer: coarse) and", fineStart));
    expect(coarseBlock).toMatch(/\.detail-titlebar\s*\{\s*gap:\s*4px/);
  });
});

describe("DetailHeader — touch screens fold the idle stop button into ⋯", () => {
  const stubPointer = (coarse: boolean): void => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: coarse && q === "(pointer: coarse)",
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  };

  it("coarse pointer: no bare stop icon even on a wide bar; the ⋯ menu still stops (arm → ✓)", async () => {
    stubPointer(true);
    const h = mountHeader({ managed: true });
    await layOut(h.wrapper, 1200);
    expect(h.wrapper.find(".spawn-stop-btn").exists()).toBe(false);
    // idle + folded ⇒ NO stop control of any kind in the bar (not even the armed pill)
    expect(h.wrapper.find(".spawn-stop-armed").exists()).toBe(false);
    expect(h.wrapper.find(".spawn-stop-busy").exists()).toBe(false);
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
    const stopItem = h.wrapper
      .findAll(".detail-head-menu .detail-head-menu-item")
      .find((i) => i.text().includes("Stop"));
    expect(stopItem).toBeDefined();
    await stopItem!.trigger("click");
    await flushPromises();
    // armed pill stays in the bar (never folded)
    expect(h.wrapper.find(".spawn-stop-armed").exists()).toBe(true);
    await h.wrapper.get(".spawn-stop-armed-ok").trigger("click");
    await flushPromises();
    expect(h.stops).toEqual(["sp-1"]);
  });

  it("fine pointer (desktop): wide bar keeps the bare stop icon; ⋯ holds only delete", async () => {
    stubPointer(false);
    const h = mountHeader({ managed: true });
    await layOut(h.wrapper, 1200);
    expect(h.wrapper.find(".spawn-stop-btn").exists()).toBe(true);
    expect(h.wrapper.find(".spawn-stop-armed").exists()).toBe(false);
  });

  it("narrow desktop bar, stop folded and idle ⇒ no armed pill in the bar (only after arming from ⋯)", async () => {
    stubPointer(false);
    const h = mountHeader({ managed: true, narrow: true });
    await layOut(h.wrapper, 400); // folds stop
    expect(h.wrapper.find(".spawn-stop-btn").exists()).toBe(false);
    expect(h.wrapper.find(".spawn-stop-armed").exists()).toBe(false);
  });

  it("coarse pointer, unmanaged online session: no stop anywhere, no ⋯ trigger, no delete", async () => {
    stubPointer(true);
    const h = mountHeader({});
    await layOut(h.wrapper, 1200);
    expect(h.wrapper.find(".spawn-stop-btn").exists()).toBe(false);
    expect(h.wrapper.find(".detail-more-btn").exists()).toBe(false);
  });
});

describe("DetailHeader — 「删除会话」 lives in the ⋯ menu (the cards' corner × is gone)", () => {
  async function openMenu(h: Harness): Promise<void> {
    await h.wrapper.get(".detail-more-btn").trigger("click");
    await flushPromises();
  }
  const deleteItem = (h: Harness) =>
    h.wrapper.findAll(".detail-head-menu .detail-head-menu-item").find((i) => i.text().includes("Delete session"));

  it("an online unmanaged session has no delete entry (and no ⋯ on a wide bar)", async () => {
    const h = mountHeader({});
    await layOut(h.wrapper, 1200);
    expect(h.wrapper.find(".detail-more-btn").exists()).toBe(false);
  });

  it("an offline session gets ⋯ with a danger 「Delete session」; arm → ✓ calls removeAgent({agentKey})", async () => {
    const h = mountHeader({ offline: true });
    await layOut(h.wrapper, 1200);
    await openMenu(h);
    const item = deleteItem(h);
    expect(item!.classes()).toContain("is-danger");
    await item!.trigger("click");
    await flushPromises();
    // armed pill in the bar (menu closed), nothing deleted yet
    expect(h.wrapper.find(".detail-head-menu").exists()).toBe(false);
    expect(h.wrapper.find(".detail-del-pill").exists()).toBe(true);
    expect(h.removes).toEqual([]);
    await h.wrapper.get(".detail-del-pill .spawn-stop-armed-ok").trigger("click");
    await flushPromises();
    expect(h.removes).toEqual([{ agentKey: "agent-1" }]);
    expect(h.wrapper.find(".detail-del-pill").exists()).toBe(false);
  });

  it("a managed session deletes by spawnId", async () => {
    const h = mountHeader({ managed: true });
    await layOut(h.wrapper, 1200);
    await openMenu(h);
    await deleteItem(h)!.trigger("click");
    await flushPromises();
    await h.wrapper.get(".detail-del-pill .spawn-stop-armed-confirm").trigger("click");
    await flushPromises();
    expect(h.removes).toEqual([{ spawnId: "sp-1" }]);
  });

  it("✕ and Esc cancel without a call; the 4s timer auto-disarms", async () => {
    vi.useFakeTimers();
    try {
      const h = mountHeader({ offline: true });
      await layOut(h.wrapper, 1200);
      await openMenu(h);
      await deleteItem(h)!.trigger("click");
      await flushPromises();
      await h.wrapper.get(".detail-del-pill .spawn-stop-armed-no").trigger("click");
      expect(h.wrapper.find(".detail-del-pill").exists()).toBe(false);
      await openMenu(h);
      await deleteItem(h)!.trigger("click");
      await flushPromises();
      await h.wrapper.get(".detail-del-pill").trigger("keydown", { key: "Escape" });
      expect(h.wrapper.find(".detail-del-pill").exists()).toBe(false);
      await openMenu(h);
      await deleteItem(h)!.trigger("click");
      await flushPromises();
      vi.advanceTimersByTime(4100);
      await flushPromises();
      expect(h.wrapper.find(".detail-del-pill").exists()).toBe(false);
      expect(h.removes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed delete shows the classified reason in a role=alert note", async () => {
    const h = mountHeader({ offline: true, removeOutcome: { ok: false, error: "E_RATE" } });
    await layOut(h.wrapper, 1200);
    await openMenu(h);
    await deleteItem(h)!.trigger("click");
    await flushPromises();
    await h.wrapper.get(".detail-del-pill .spawn-stop-armed-ok").trigger("click");
    await flushPromises();
    const note = h.wrapper.get(".detail-del-note");
    expect(note.attributes("role")).toBe("alert");
    expect(note.text()).toContain("too many requests");
  });
});
