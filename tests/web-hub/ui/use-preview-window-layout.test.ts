/**
 * web-hub-preview-windows plan r2 §10.2 (W2): the gesture controller — capture fallback
 * (评审 #8), the 3px threshold, body-class lifecycle, end conditions (pointerup/cancel,
 * lostpointercapture, window blur, page hidden, window dropped, unmount) and pointerId
 * filtering. Pure node fakes — no DOM; geometry itself is covered by logic tests.
 */
import { ref } from "vue";
import { describe, expect, it } from "vitest";
import {
  DRAG_START_PX,
  PW_DRAGGING_CLASS,
  usePreviewWindowLayout,
  type LayoutDoc,
  type LayoutWin,
} from "../../../src/web-hub/ui/src/composables/usePreviewWindowLayout.js";

interface Rig {
  layout: ReturnType<typeof usePreviewWindowLayout>;
  doc: FakeDoc;
  win: FakeWin;
  desktop: ReturnType<typeof ref<boolean>>;
  rectOf: (id: number) => { x: number; y: number; w: number; h: number } | undefined;
  begin: (id: number, opts?: { target?: unknown; button?: number; el?: object }) => void;
  move: (id: number, dx: number, dy: number) => void;
}

class FakeDoc {
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  bodyClasses = new Set<string>();
  readonly body = {
    classList: { add: (c: string) => this.bodyClasses.add(c), remove: (c: string) => this.bodyClasses.delete(c) },
  };
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

class FakeWin {
  readonly listeners = new Map<string, Set<() => void>>();
  innerWidth = 1280;
  innerHeight = 900;
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

function makeRig(
  el: {
    captureThrows?: boolean;
    hasCapture?: (id: number) => boolean;
  } = {},
): Rig {
  const doc = new FakeDoc();
  const win = new FakeWin();
  const desktop = ref(true);
  const target = { closest: () => null };
  const elListeners = new Map<string, Set<(ev: unknown) => void>>();
  const elNode = {
    setPointerCapture: el.captureThrows
      ? () => {
          throw new Error("no capture");
        }
      : () => {},
    hasPointerCapture: el.hasCapture === undefined ? () => true : el.hasCapture,
    releasePointerCapture: () => {},
    addEventListener(type: string, listener: (ev: unknown) => void): void {
      const set = elListeners.get(type) ?? new Set();
      set.add(listener);
      elListeners.set(type, set);
    },
    removeEventListener(type: string, listener: (ev: unknown) => void): void {
      elListeners.get(type)?.delete(listener);
    },
    dispatch(type: string, ev: unknown): void {
      for (const fn of elListeners.get(type) ?? []) fn(ev);
    },
  };
  const layout = usePreviewWindowLayout({
    desktop,
    doc: doc as unknown as LayoutDoc,
    win: win as unknown as LayoutWin,
    topOffset: () => 40,
  });
  const begin = (id: number, opts: { target?: unknown; button?: number } = {}): void => {
    layout.beginGesture(
      {
        pointerId: 7,
        button: opts.button ?? 0,
        clientX: 100,
        clientY: 200,
        target: opts.target ?? target,
      },
      id,
      "move",
      elNode as never,
    );
  };
  return {
    layout,
    doc,
    win,
    desktop,
    rectOf: (id: number) => layout.varsOf(id) as unknown as { x: number; y: number; w: number; h: number } | undefined,
    begin,
    move: (_id: number, dx: number, dy: number): void => {
      elNode.dispatch("pointermove", { pointerId: 7, clientX: 100 + dx, clientY: 200 + dy });
    },
  };
}

describe("usePreviewWindowLayout — gesture controller (§7.4, 评审 #8)", () => {
  it("capture mode: moves after the 3px threshold, ends on el pointerup, body class lifecycle", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    const before = r.layout.varsOf(1);
    r.begin(1);
    r.move(1, 1, 1); // below threshold — nothing yet
    expect(r.layout.varsOf(1)).toEqual(before);
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    r.move(1, DRAG_START_PX, 0);
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(true);
    const moved = r.layout.varsOf(1);
    expect(Number.parseFloat(moved["--pw-x"]!)).toBe(Number.parseFloat(before["--pw-x"]!) + DRAG_START_PX);
    // end via el pointerup — capture mode listens on the element
    r.layout.endGesture();
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
  });

  it("setPointerCapture throws ⇒ document mode: still moves, document pointerup ends it", () => {
    const r = makeRig({ captureThrows: true });
    r.layout.ensureRect(1, null);
    const before = r.layout.varsOf(1);
    r.begin(1);
    // moves arrive on the DOCUMENT in this mode — feed them through doc
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 100 + 30, clientY: 200 });
    expect(Number.parseFloat(r.layout.varsOf(1)["--pw-x"]!)).toBe(Number.parseFloat(before["--pw-x"]!) + 30);
    r.doc.dispatch("pointerup", { pointerId: 7 });
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 100 + 99, clientY: 200 });
    expect(Number.parseFloat(r.layout.varsOf(1)["--pw-x"]!)).toBe(Number.parseFloat(before["--pw-x"]!) + 30);
  });

  it("hasPointerCapture === false ⇒ document mode", () => {
    const r = makeRig({ hasCapture: () => false });
    r.layout.ensureRect(1, null);
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 140, clientY: 200 });
    r.doc.dispatch("pointercancel", { pointerId: 7 });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
  });

  it("other pointerId events are ignored", () => {
    const r = makeRig({ captureThrows: true });
    r.layout.ensureRect(1, null);
    const before = r.layout.varsOf(1);
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 99, clientX: 400, clientY: 400 });
    expect(r.layout.varsOf(1)).toEqual(before); // untouched
    r.layout.endGesture();
  });

  it("window blur ends the gesture; page hidden ends it; both clean the body class", () => {
    const r = makeRig({ captureThrows: true });
    r.layout.ensureRect(1, null);
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 120, clientY: 220 });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(true);
    r.win.dispatch("blur");
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    // again, ending via visibilitychange
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 130, clientY: 230 });
    r.doc.dispatch("visibilitychange", { visibilityState: "hidden" });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    // visible again never starts anything
    r.doc.dispatch("visibilitychange", { visibilityState: "visible" });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
  });

  it("dropping the target window ends the gesture; a second pointerdown while active is ignored", () => {
    const r = makeRig({ captureThrows: true });
    r.layout.ensureRect(1, null);
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 150, clientY: 200 });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(true);
    r.layout.dropRect(1);
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 260, clientY: 200 }); // no rect → ended
  });

  it("crossing into the phone band ends the gesture; back to desktop re-clamps rects", () => {
    const r = makeRig({ captureThrows: true });
    r.layout.ensureRect(1, null);
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 130, clientY: 230 });
    r.desktop.value = false;
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    // shrink the viewport while on phone, then flip back — the rect is re-clamped
    r.win.innerWidth = 500;
    r.win.innerHeight = 400;
    r.desktop.value = true;
    const vars = r.layout.varsOf(1);
    expect(Number.parseFloat(vars["--pw-w"]!)).toBeLessThanOrEqual(500 - 16);
  });

  it("a pointerdown on an interactive target / non-primary button / off-desktop never starts", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    const btn = { closest: (sel: string) => (sel.includes("button") ? {} : null) };
    r.begin(1, { target: btn });
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 400, clientY: 400 });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    r.begin(1, { button: 2 });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    r.desktop.value = false;
    r.begin(1);
    r.desktop.value = true;
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
  });

  it("viewport resize re-clamps every rect; keyMove/keyResize clamp through the geometry", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    r.win.innerWidth = 380; // far below MIN_W=360+2·EDGE fits
    r.win.dispatch("resize");
    const vars = r.layout.varsOf(1);
    expect(Number.parseFloat(vars["--pw-w"]!)).toBeLessThanOrEqual(380 - 16);
    r.layout.keyMove(1, -5000, -5000);
    const moved = r.layout.varsOf(1);
    // P4 keeps the title reachable: x ≥ TITLE_KEEP_X − w (w clamps to AW=364 here)
    expect(Number.parseFloat(moved["--pw-x"]!)).toBeGreaterThanOrEqual(96 - 364);
    r.layout.keyResize(1, 5000, 5000);
    const sized = r.layout.varsOf(1);
    expect(Number.parseFloat(sized["--pw-w"]!)).toBeLessThanOrEqual(380 - 16);
  });

  it("resetRect recenters to the default placement; dispose ends any gesture", () => {
    const r = makeRig({ captureThrows: true });
    r.layout.ensureRect(1, null);
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 400, clientY: 400 });
    r.layout.resetRect(1);
    const vars = r.layout.varsOf(1);
    // default is centered: x = EDGE + (AW−w)/2 → symmetric margins
    const x = Number.parseFloat(vars["--pw-x"]!);
    const w = Number.parseFloat(vars["--pw-w"]!);
    const marginL = x;
    const marginR = r.win.innerWidth - (x + w);
    expect(Math.abs(marginL - marginR)).toBeLessThanOrEqual(1);
    r.layout.dispose();
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
  });
});
