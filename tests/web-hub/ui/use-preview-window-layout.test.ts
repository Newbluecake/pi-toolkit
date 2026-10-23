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

  it("keyResize: negative deltas shrink the SE edge — the handle never flips to NW", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    const before = r.layout.varsOf(1);
    r.layout.keyResize(1, -16, -16);
    const after = r.layout.varsOf(1);
    // only the right/bottom edges moved: x/y stay, w/h each lose 16
    expect(after["--pw-x"]).toBe(before["--pw-x"]);
    expect(after["--pw-y"]).toBe(before["--pw-y"]);
    expect(Number.parseFloat(after["--pw-w"]!)).toBeCloseTo(Number.parseFloat(before["--pw-w"]!) - 16, 1);
    expect(Number.parseFloat(after["--pw-h"]!)).toBeCloseTo(Number.parseFloat(before["--pw-h"]!) - 16, 1);
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

describe("usePreviewWindowLayout — maximize/restore (2026-10-22 L1 拍板 1)", () => {
  /** Parse varsOf back into numbers for exact comparisons. */
  const rectVars = (l: ReturnType<typeof usePreviewWindowLayout>, id: number) => {
    const v = l.varsOf(id);
    return {
      x: Number.parseFloat(v["--pw-x"]!),
      y: Number.parseFloat(v["--pw-y"]!),
      w: Number.parseFloat(v["--pw-w"]!),
      h: Number.parseFloat(v["--pw-h"]!),
    };
  };

  it("toggleMaximize fills the usable box (topOffset respected); restore returns the EXACT prior rect", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    const before = r.layout.varsOf(1);
    expect(r.layout.isMaximized(1)).toBe(false);
    r.layout.toggleMaximize(1);
    expect(r.layout.isMaximized(1)).toBe(true);
    // rig: innerWidth 1280, innerHeight 900, topOffset 40 → EDGE inset all around
    expect(rectVars(r.layout, 1)).toEqual({ x: 8, y: 40 + 8, w: 1280 - 16, h: 900 - 40 - 16 });
    r.layout.toggleMaximize(1);
    expect(r.layout.isMaximized(1)).toBe(false);
    expect(r.layout.varsOf(1)).toEqual(before); // byte-identical vars — exact restore
  });

  it("maximized: drag, keyMove and keyResize never touch the rect", () => {
    const r = makeRig({ captureThrows: true });
    r.layout.ensureRect(1, null);
    r.layout.toggleMaximize(1);
    const maxed = r.layout.varsOf(1);
    // a header drag: beginGesture refuses (maximized) — no listeners, so moves do nothing
    r.begin(1);
    r.doc.dispatch("pointermove", { pointerId: 7, clientX: 500, clientY: 600 });
    expect(r.doc.bodyClasses.has(PW_DRAGGING_CLASS)).toBe(false);
    expect(r.layout.varsOf(1)).toEqual(maxed);
    // keyboard equivalents are no-ops too
    r.layout.keyMove(1, 200, 200);
    r.layout.keyResize(1, 200, 200);
    expect(r.layout.varsOf(1)).toEqual(maxed);
    // after restore the stored rect is still the pre-maximize one (never clobbered)
    r.layout.toggleMaximize(1);
    const restored = rectVars(r.layout, 1);
    expect(restored.w).toBeLessThan(1280 - 16); // the default 960, not the maximized box
  });

  it("maximized: the box FOLLOWS a viewport resize; restore clamps into the CURRENT viewport", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    r.layout.toggleMaximize(1);
    r.win.innerWidth = 600;
    r.win.innerHeight = 500;
    r.win.dispatch("resize");
    expect(rectVars(r.layout, 1)).toEqual({ x: 8, y: 48, w: 584, h: 444 });
    // restore: the frozen pre-maximize rect (960 wide, placed for 1280×900) is CLAMPED in
    r.layout.toggleMaximize(1);
    const restored = rectVars(r.layout, 1);
    expect(restored.w).toBe(584); // 960 clamped down to AW
    expect(restored.h).toBe(444); // 765 clamped down to AH
    expect(restored.x).toBeLessThanOrEqual(600 - 96); // P4 held through the clamp
  });

  it("resetRect cancels a maximize; dropRect forgets the state entirely", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    r.layout.toggleMaximize(1);
    expect(r.layout.isMaximized(1)).toBe(true);
    r.layout.resetRect(1);
    expect(r.layout.isMaximized(1)).toBe(false); // 拍板 2: 重置布局 ⇒ 取消最大化
    const reset = rectVars(r.layout, 1);
    // centered default: symmetric margins inside the usable box
    expect(Math.abs(reset.x - (1280 - (reset.x + reset.w)))).toBeLessThanOrEqual(1);
    r.layout.toggleMaximize(1);
    r.layout.dropRect(1);
    expect(r.layout.isMaximized(1)).toBe(false);
    r.layout.ensureRect(1, null); // fresh rect — a reused id never inherits the state
    expect(r.layout.isMaximized(1)).toBe(false);
    expect(rectVars(r.layout, 1).w).toBeLessThan(1280 - 16);
  });

  it("a maximized window contributes its MAXIMIZED box to the cascade's occupied list", () => {
    const r = makeRig();
    r.layout.ensureRect(1, null);
    r.layout.toggleMaximize(1);
    r.layout.ensureRect(2, 1);
    const rect2 = rectVars(r.layout, 2);
    // window 2 must not sit in the maximized window's top-left slot (8, 48)
    expect(Math.abs(rect2.x - 8) >= 16 || Math.abs(rect2.y - 48) >= 16).toBe(true);
  });
});
