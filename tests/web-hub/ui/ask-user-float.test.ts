// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AskUserFloat from "../../../src/web-hub/ui/src/components/dialog/AskUserFloat.vue";
import AskUserForm from "../../../src/web-hub/ui/src/components/dialog/AskUserForm.vue";
import {
  ASK_FLOAT_KEYBOARD_STEP,
  ASK_FLOAT_POS_STORAGE_KEY,
  clampAskFloatPos,
  loadAskFloatPos,
} from "../../../src/web-hub/ui/src/composables/useAskFloat.js";

/**
 * `dialog/AskUserFloat.vue` + `composables/useAskFloat.ts` (user ruling 2026-10-20; approved
 * mock ~/pwh-preview/askfloat/ask-float.png): the NON-MODAL floating ask_user window.
 *
 * Covered here: desktop floating render (role=dialog, aria-modal=false, stacked forms, i/n
 * counter), drag updates + VIEWPORT clamp (2026-10-20 ruling: the whole app viewport below
 * the top bar — the window may be dragged across the agents tree / fleet drawer) +
 * localStorage persistence (release/nudge only), the default-position resolution (above the
 * composer), legacy pane-relative position migration by re-clamping, minimize/expand (button,
 * bar click, Esc — which NEVER cancels), keyboard nudge, resize clamp, the phone bottom
 * sheet's collapse/expand bar, auto-expand + pulse + sr-only announcement when a new dialog
 * arrives while minimized, and the storage validation / clamp pure functions.
 *
 * Geometry in these tests: happy-dom's window is 1024×768 and no `header.topbar` exists, so
 * the clamp box is minX=8 / minY=8 / maxX=1024−w−8 / maxY=768−h−8 (ASK_FLOAT_MARGIN=8).
 */

const mounted: Array<ReturnType<typeof mount>> = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
  for (const h of hosts.splice(0)) h.remove();
});

/** Query-aware matchMedia stub (same shape as the composer/dashboard tests). */
function stubMedia(desktop: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? desktop : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function dialogWire(dialogId: string, question = "Which plan?") {
  return {
    dialogId,
    source: "ask_user",
    toolCallId: dialogId,
    questions: [{ question, options: [{ label: "A" }, { label: "B" }] }],
    allowCancel: true,
    openedAt: 1,
  };
}

interface RectSpec {
  left: number;
  top: number;
  width: number;
  height: number;
}

function fakeRect({ left, top, width, height }: RectSpec): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Stub the pane (`.detail-main` host) / anchor / float rects for drag & clamp tests. */
function stubRects(wrapper: ReturnType<typeof mount>, pane: RectSpec, anchorTop: number, float: RectSpec) {
  const paneEl = wrapper.element.parentElement as HTMLElement;
  const anchorEl = wrapper.find(".ask-anchor").element as HTMLElement;
  const floatEl = wrapper.find(".ask-float").element as HTMLElement;
  paneEl.getBoundingClientRect = () => fakeRect(pane);
  anchorEl.getBoundingClientRect = () => fakeRect({ left: pane.left, top: anchorTop, width: pane.width, height: 0 });
  floatEl.getBoundingClientRect = () => fakeRect(float);
  return { paneEl, anchorEl, floatEl };
}

function mountFloat(props: Record<string, unknown>, opts: { desktop?: boolean } = {}) {
  stubMedia(opts.desktop ?? true);
  const host = document.createElement("div");
  host.className = "detail-main";
  document.body.appendChild(host);
  hosts.push(host);
  const wrapper = mount(AskUserFloat, { props, attachTo: host });
  mounted.push(wrapper);
  return wrapper;
}

const TWO = [dialogWire("ask:1", "First?"), dialogWire("ask:2", "Second?")];

describe("AskUserFloat.vue — desktop floating window (≥768px)", () => {
  it("renders a non-modal dialog stacking every open form, counter in the title", () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    const root = w.find(".ask-float");
    expect(root.exists()).toBe(true);
    expect(root.attributes("role")).toBe("dialog");
    expect(root.attributes("aria-modal")).toBe("false");
    expect(root.attributes("aria-labelledby")).toBe("ask-float-title");
    expect(w.findAllComponents(AskUserForm)).toHaveLength(2);
    expect(w.find(".ask-float-title").text()).toBe("Answer needed · 2 questions");
    // No backdrop / scroll lock is rendered — the transcript beneath stays interactive.
    expect(w.find(".ask-float-backdrop").exists()).toBe(false);
  });

  it("title drops the counter for a single dialog (需要你回答 / Answer needed)", () => {
    const w = mountFloat({ dialogs: [dialogWire("ask:1")], epoch: "e1" });
    expect(w.find(".ask-float-title").text()).toBe("Answer needed");
  });

  it("renders the epoch-stale note only for the listed dialogIds", () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e2", staleIds: ["ask:2"] });
    const notes = w.findAll(".ask-epoch-note");
    expect(notes).toHaveLength(1);
  });

  it("minimize collapses to the bar; bar click and Enter re-expand; Esc minimizes (never cancels)", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    const toggle = w.find(".ask-float-btn");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(toggle.attributes("aria-controls")).toBe("ask-float-body");
    expect(w.find("#ask-float-body").exists()).toBe(true);
    await toggle.trigger("click");
    expect(w.find(".ask-float--min").exists()).toBe(true);
    expect((w.find(".ask-float-body").attributes("style") ?? "").replace(/\s/g, "")).toContain("display:none");
    const bar = w.find("button.ask-float-bar");
    expect(bar.exists()).toBe(true);
    expect(bar.attributes("aria-expanded")).toBe("false");
    expect(bar.attributes("aria-controls")).toBe("ask-float-body");

    await bar.trigger("click"); // click expands…
    expect(w.find(".ask-float--min").exists()).toBe(false);

    await w.find(".ask-float-btn").trigger("click");
    await w.find("button.ask-float-bar").trigger("keydown", { key: "Enter" }); // happy-dom has no
    await w.find("button.ask-float-bar").trigger("click"); // native button activation — click stands in
    expect(w.find(".ask-float--min").exists()).toBe(false);

    // Esc on the expanded bar minimizes; it must NOT emit cancel.
    await w.find(".ask-float-bar").trigger("keydown", { key: "Escape" });
    expect(w.find(".ask-float--min").exists()).toBe(true);
    expect(w.emitted("cancel")).toBeUndefined();
  });

  it("drag: pointermove updates the position, clamps to the VIEWPORT, persists on release only", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    // window 440×250 floating at (552,442): viewport clamp maxX = 1024−440−8 = 576, maxY = 768−250−8 = 510.
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    const bar = w.find(".ask-float-bar");

    await bar.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 600, clientY: 460 });
    await bar.trigger("pointermove", { clientX: 650, clientY: 480 }); // +50/+20 → x clamps at 576
    const style = w.find(".ask-float").attributes("style") ?? "";
    expect(style).toContain("left: 576px");
    expect(style).toContain("top: 462px");
    expect(window.localStorage.getItem(ASK_FLOAT_POS_STORAGE_KEY)).toBeNull(); // no persist mid-drag

    await bar.trigger("pointermove", { clientX: 650, clientY: 1200 }); // dy huge → y clamps at 510
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("top: 510px");

    await bar.trigger("pointerup", { pointerId: 1 });
    expect(window.localStorage.getItem(ASK_FLOAT_POS_STORAGE_KEY)).toBe(JSON.stringify({ v: 2, x: 576, y: 510 }));
  });

  it("the window drags BEYOND the detail pane's right edge (agents tree / fleet drawer area)", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    // The detail pane is only 500px wide; the viewport is 1024px. The pre-ruling pane clamp
    // would cap x at 500−440 = 60 — the viewport clamp allows up to 1024−440−8 = 576.
    stubRects(w, { left: 0, top: 0, width: 500, height: 800 }, 700, { left: 40, top: 442, width: 440, height: 250 });
    const bar = w.find(".ask-float-bar");
    await bar.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 460 });
    await bar.trigger("pointermove", { clientX: 560, clientY: 460 }); // dx=460 → x=500, past the pane
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("left: 500px");
    await bar.trigger("pointerup", { pointerId: 1 });
    expect(window.localStorage.getItem(ASK_FLOAT_POS_STORAGE_KEY)).toBe(JSON.stringify({ v: 2, x: 500, y: 442 }));
  });

  it("the clamp box starts BELOW the top bar (header.topbar bottom + margin)", async () => {
    const topbar = document.createElement("header");
    topbar.className = "topbar";
    document.body.appendChild(topbar);
    hosts.push(topbar);
    topbar.getBoundingClientRect = () => fakeRect({ left: 0, top: 0, width: 1024, height: 48 });

    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    const bar = w.find(".ask-float-bar");
    await bar.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 600, clientY: 460 });
    await bar.trigger("pointermove", { clientX: 600, clientY: -500 }); // dy=−960 → y clamps at 48+8=56
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("top: 56px");
    await bar.trigger("pointerup", { pointerId: 1 });
  });

  it("no stored position ⇒ the default hugs the viewport's right edge above the composer (never persisted)", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    // dock top at y=700, window 440×250 ⇒ default = {x: 1024−440−8, y: 700−8−250} = {576, 442}
    // — x tracks the RIGHT EDGE (innerWidth − width − gutter), not the laid-out rect.
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    await nextTick();
    await nextTick(); // onMounted → nextTick clampNow resolves defaultPos
    const style = w.find(".ask-float").attributes("style") ?? "";
    expect(style).toContain("left: 576px");
    expect(style).toContain("top: 442px");
    expect(window.localStorage.getItem(ASK_FLOAT_POS_STORAGE_KEY)).toBeNull(); // defaults never persist
  });

  it("a drag's trailing click does NOT expand a minimized bar (click suppression)", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    await w.find(".ask-float-btn").trigger("click"); // minimize
    const bar = w.find("button.ask-float-bar");
    await bar.trigger("pointerdown", { button: 0, pointerId: 2, clientX: 600, clientY: 460 });
    await bar.trigger("pointermove", { clientX: 660, clientY: 460 }); // real drag (> suppress px)
    await bar.trigger("pointerup", { pointerId: 2 });
    await bar.trigger("click");
    expect(w.find(".ask-float--min").exists()).toBe(true); // still minimized
  });

  it("arrow keys nudge by 16px (clamped) and persist immediately", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    const bar = w.find(".ask-float-bar");
    await bar.trigger("keydown", { key: "ArrowLeft" }); // 552 → 536
    expect(w.find(".ask-float").attributes("style") ?? "").toContain(`left: ${552 - ASK_FLOAT_KEYBOARD_STEP}px`);
    expect(window.localStorage.getItem(ASK_FLOAT_POS_STORAGE_KEY)).toBe(
      JSON.stringify({ v: 2, x: 552 - ASK_FLOAT_KEYBOARD_STEP, y: 442 }),
    );
    await bar.trigger("keydown", { key: "ArrowUp" }); // 442 → 426
    expect(window.localStorage.getItem(ASK_FLOAT_POS_STORAGE_KEY)).toBe(
      JSON.stringify({ v: 2, x: 552 - ASK_FLOAT_KEYBOARD_STEP, y: 426 }),
    );
  });

  it("a persisted v2 position is restored (clamped to the viewport) and re-clamped on window resize", async () => {
    window.localStorage.setItem(ASK_FLOAT_POS_STORAGE_KEY, JSON.stringify({ v: 2, x: 900, y: 400 }));
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    await nextTick();
    await nextTick(); // onMounted → nextTick clamp: maxX = 1024−440−8 = 576, y 400 fits (maxY 510)
    const style = w.find(".ask-float").attributes("style") ?? "";
    expect(style).toContain("left: 576px");
    expect(style).toContain("top: 400px");

    // The window's content grows mid-session → resize re-clamps (maxY = 768−600−8 = 160).
    const floatEl = w.find(".ask-float").element as HTMLElement;
    floatEl.getBoundingClientRect = () => fakeRect({ left: 576, top: 400, width: 440, height: 600 });
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    const shrunk = w.find(".ask-float").attributes("style") ?? "";
    expect(shrunk).toContain("left: 576px");
    expect(shrunk).toContain("top: 160px");
  });

  it("a legacy UNVERSIONED (pane-relative) stored position is DROPPED — the window opens at the default", async () => {
    // Verifier round 3: no clamping legacy negative-y values into the top-left corner.
    window.localStorage.setItem(ASK_FLOAT_POS_STORAGE_KEY, JSON.stringify({ x: 900, y: -100 }));
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    // anchor top 700, float 440×250 ⇒ default = {x: 1024−440−8, y: 700−8−250} = {576, 442}.
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    await nextTick();
    await nextTick();
    const style = w.find(".ask-float").attributes("style") ?? "";
    expect(style).toContain("left: 576px");
    expect(style).toContain("top: 442px");
  });

  it("auto-expands once with a pulse + sr-only announcement when a new dialog arrives while minimized", async () => {
    const w = mountFloat({ dialogs: [dialogWire("ask:1")], epoch: "e1" });
    await w.find(".ask-float-btn").trigger("click");
    expect(w.find(".ask-float--min").exists()).toBe(true);

    await w.setProps({ dialogs: TWO, epoch: "e1" });
    await nextTick();
    expect(w.find(".ask-float--min").exists()).toBe(false); // auto-expanded
    expect(w.find(".ask-float--pulse").exists()).toBe(true); // subtle pulse
    expect(w.find(".sr-only[role='status']").text()).toBe("The agent asked a new question");
  });

  it("the sr-only announcement clears itself after being read (timer cleaned up)", async () => {
    const w = mountFloat({ dialogs: [dialogWire("ask:1")], epoch: "e1" });
    vi.useFakeTimers();
    await w.find(".ask-float-btn").trigger("click");
    await w.setProps({ dialogs: TWO, epoch: "e1" });
    await nextTick();
    const live = w.find(".sr-only[role='status']");
    expect(live.text()).toBe("The agent asked a new question");
    vi.advanceTimersByTime(2000); // pulse window passes first…
    expect(live.text()).toBe("The agent asked a new question"); // …announcement still there
    vi.advanceTimersByTime(1100); // past ANNOUNCE_MS
    await nextTick(); // the timer writes the ref; the DOM update lands on the next tick
    expect(live.text()).toBe("");
    vi.useRealTimers();
  });

  // --- verifier round 2 (real-Chromium repro) regressions -----------------------------------

  it("BLOCKER: pointerdown on the inner minimize button never starts a drag — click stays a click", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    const btn = w.find(".ask-float-btn");
    // Real-mouse sequence: pointerdown lands ON the button — no capture, no drag…
    await btn.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 700, clientY: 460 });
    expect(w.find(".ask-float--drag").exists()).toBe(false);
    const before = w.find(".ask-float").attributes("style") ?? "";
    await w.find(".ask-float-bar").trigger("pointermove", { clientX: 760, clientY: 500 });
    expect(w.find(".ask-float").attributes("style") ?? "").toBe(before); // …no drag state
    // …so Chromium's click reaches the button and minimize actually runs.
    await btn.trigger("click");
    expect(w.find(".ask-float--min").exists()).toBe(true);
  });

  it("pointerdown on the minimized bar ITSELF (a <button>) still drags — the guard is child-only", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    await w.find(".ask-float-btn").trigger("click"); // minimize
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 41 });
    const bar = w.find("button.ask-float-bar");
    await bar.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 600, clientY: 460 });
    expect(w.find(".ask-float--drag").exists()).toBe(true); // the bar itself stays a drag handle
    await bar.trigger("pointermove", { clientX: 650, clientY: 460 });
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("left: 576px"); // clamped
    await bar.trigger("pointerup", { pointerId: 1 });
  });

  it("lostpointercapture ends the drag (no stuck listeners, no further position writes)", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    const bar = w.find(".ask-float-bar");
    await bar.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 600, clientY: 460 });
    expect(w.find(".ask-float--drag").exists()).toBe(true);
    await bar.trigger("pointermove", { clientX: 650, clientY: 480 }); // +50/+20 → x clamps at 576
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("left: 576px");
    await bar.trigger("lostpointercapture", { pointerId: 1 });
    expect(w.find(".ask-float--drag").exists()).toBe(false); // drag ended
    await bar.trigger("pointermove", { clientX: 800, clientY: 600 }); // dead — no listeners left
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("left: 576px"); // unchanged
    // capture loss still persisted the last position, exactly like a pointerup would
    expect(window.localStorage.getItem(ASK_FLOAT_POS_STORAGE_KEY)).toBe(JSON.stringify({ v: 2, x: 576, y: 462 }));
  });

  it("minimizing MID-DRAG swaps the bar and cancels the drag — nothing gets stuck", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 250 });
    const bar = w.find(".ask-float-bar");
    await bar.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 600, clientY: 460 });
    expect(w.find(".ask-float--drag").exists()).toBe(true);
    const before = w.find(".ask-float").attributes("style") ?? "";
    await bar.trigger("keydown", { key: "Escape" }); // minimize while the pointer is still down
    await nextTick();
    expect(w.find(".ask-float--min").exists()).toBe(true);
    expect(w.find(".ask-float--drag").exists()).toBe(false); // drag cancelled by the swap
    await bar.trigger("pointermove", { clientX: 900, clientY: 700 }); // old bar: listeners gone
    expect(w.find(".ask-float").attributes("style") ?? "").toBe(before);
  });

  it("re-clamps on EXPAND after the window's content height changed", async () => {
    window.localStorage.setItem(ASK_FLOAT_POS_STORAGE_KEY, JSON.stringify({ v: 2, x: 100, y: 500 }));
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    const { floatEl } = stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, {
      left: 552,
      top: 442,
      width: 440,
      height: 250,
    });
    await nextTick();
    await nextTick();
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("top: 500px"); // fits: maxY=510

    // Content grows (longer option list): without the re-clamp the window would hang 340px
    // below the viewport's bottom margin (new maxY = 768−600−8 = 160).
    floatEl.getBoundingClientRect = () => fakeRect({ left: 552, top: 442, width: 440, height: 600 });
    await w.find(".ask-float-btn").trigger("click"); // minimize…
    await w.find("button.ask-float-bar").trigger("click"); // …expand again → re-clamp
    await nextTick();
    await nextTick();
    expect(w.find(".ask-float").attributes("style") ?? "").toContain("top: 160px");
  });

  it("keydown resets the drag-click suppression — first keyboard activation after a drag works", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    await w.find(".ask-float-btn").trigger("click"); // minimize
    stubRects(w, { left: 0, top: 0, width: 1000, height: 800 }, 700, { left: 552, top: 442, width: 440, height: 41 });
    const bar = w.find("button.ask-float-bar");
    await bar.trigger("pointerdown", { button: 0, pointerId: 2, clientX: 600, clientY: 460 });
    await bar.trigger("pointermove", { clientX: 660, clientY: 460 }); // real drag > suppress px
    await bar.trigger("pointerup", { pointerId: 2 });
    await bar.trigger("keydown", { key: "ArrowLeft" }); // keyboard intent: suppression cleared
    await bar.trigger("click"); // …so this activation is NOT swallowed as the drag's tail click
    expect(w.find(".ask-float--min").exists()).toBe(false);
  });

  it("Esc inside the FORM minimizes at the float root (never reaches global back-navigation, never cancels)", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" });
    expect(w.find(".ask-float--min").exists()).toBe(false);
    await w.find(".ask-user-form").trigger("keydown", { key: "Escape" }); // deep inside the form
    expect(w.find(".ask-float--min").exists()).toBe(true); // minimized by the ROOT handler
    expect(w.emitted("cancel")).toBeUndefined(); // Esc NEVER cancels
  });
});

describe("AskUserFloat.vue — phone bottom sheet (<768px)", () => {
  it("collapses to the compact pending bar and expands again; never draggable", async () => {
    const w = mountFloat({ dialogs: TWO, epoch: "e1" }, { desktop: false });
    expect(w.findAllComponents(AskUserForm)).toHaveLength(2);

    const collapseBtn = w.find(".ask-float-btn");
    expect(collapseBtn.attributes("aria-label")).toBe("Collapse");
    await collapseBtn.trigger("click");

    const bar = w.find("button.ask-float-bar");
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain("2 question(s) waiting for an answer");
    expect(bar.text()).toContain("Expand");
    expect((w.find(".ask-float-body").attributes("style") ?? "").replace(/\s/g, "")).toContain("display:none");

    // No drag on the phone band: pointer events never produce an inline position.
    stubRects(w, { left: 0, top: 0, width: 390, height: 800 }, 700, { left: 12, top: 400, width: 366, height: 300 });
    await bar.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 750 });
    await bar.trigger("pointermove", { clientX: 200, clientY: 400 });
    await bar.trigger("pointerup", { pointerId: 1 });
    expect(w.find(".ask-float").attributes("style") ?? "").not.toContain("left:");

    await bar.trigger("click"); // expand again
    expect(w.find(".ask-float--min").exists()).toBe(false);
    expect(w.findAllComponents(AskUserForm)).toHaveLength(2);
  });
});

describe("useAskFloat — storage validation + clamp math", () => {
  const fakeStorage = (raw: string | null) => ({
    getItem: () => raw,
    setItem: () => {},
  });

  it("loadAskFloatPos: valid v2 positions load (negative y still loads — the mount clamp bounds it)", () => {
    expect(loadAskFloatPos(fakeStorage('{"v":2,"x":560,"y":-238}'))).toEqual({ x: 560, y: -238 });
    expect(loadAskFloatPos(fakeStorage('{"v":2,"x":0,"y":0}'))).toEqual({ x: 0, y: 0 });
  });

  it("loadAskFloatPos: legacy UNVERSIONED (pane-relative) and foreign-version values are dropped", () => {
    // Verifier round 3: the pre-fixed build's {x,y} schema has no viewport meaning — the
    // window opens at the default instead of being clamped into a corner.
    expect(loadAskFloatPos(fakeStorage('{"x":560,"y":-238}'))).toBeNull();
    expect(loadAskFloatPos(fakeStorage('{"v":1,"x":560,"y":10}'))).toBeNull();
    expect(loadAskFloatPos(fakeStorage('{"v":"2","x":560,"y":10}'))).toBeNull();
  });

  it("loadAskFloatPos: unparseable / wrong-shape / non-finite / absurd values are ignored", () => {
    for (const bad of [
      "bogus",
      "",
      "null",
      "[]",
      '"120"',
      '{"v":2,"x":"560","y":0}',
      '{"v":2,"x":560}',
      '{"v":2,"x":null,"y":0}',
      `{"v":2,"x":${Number.POSITIVE_INFINITY},"y":0}`,
      '{"v":2,"x":100001,"y":0}',
      '{"v":2,"x":0,"y":-100001}',
    ]) {
      expect(loadAskFloatPos(fakeStorage(bad)), bad).toBeNull();
    }
    const throwing = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {},
    };
    expect(loadAskFloatPos(throwing)).toBeNull();
  });

  it("clampAskFloatPos: clamps into the box, collapses inverted boxes, rounds", () => {
    const box = { minX: 0, minY: -700, maxX: 560, maxY: -150 };
    expect(clampAskFloatPos({ x: 999, y: 0 }, box)).toEqual({ x: 560, y: -150 });
    expect(clampAskFloatPos({ x: -5, y: -900 }, box)).toEqual({ x: 0, y: -700 });
    expect(clampAskFloatPos({ x: 100.4, y: -200.6 }, box)).toEqual({ x: 100, y: -201 });
    // happy-dom zero rects ⇒ degenerate box collapses to the min edge, never NaN
    expect(clampAskFloatPos({ x: 50, y: 50 }, { minX: 0, minY: 0, maxX: -440, maxY: -250 })).toEqual({ x: 0, y: 0 });
  });
});
