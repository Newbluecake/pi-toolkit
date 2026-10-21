/**
 * web-hub-preview-windows plan r2 §7.4 (W2): the ONE gesture controller for the desktop
 * modeless preview windows — drag (header) and eight-way resize (`.pw-rz` hot zones), plus
 * the per-window rect store every new window's cascade placement reads from.
 *
 * Geometry itself is W1's pure `logic/previewWindowGeom.ts`; this composable only moves
 * pointer deltas through it. Design invariants (评审 #8):
 * - AT MOST ONE gesture at a time `{pointerId, winId, kind, el, mode}` — a second pointerdown
 *   while one is active is ignored (`button===0` + desktop band + no active gesture gate it).
 * - pointer capture is BEST-EFFORT: `setPointerCapture` throwing OR
 *   `hasPointerCapture(id) === false` ⇒ **document mode** (listeners on `document`, filtered
 *   by `pointerId`); otherwise listeners live on `el` (incl. `lostpointercapture`).
 * - a drag only STARTS after the pointer moved ≥3px (the 3px threshold); until then the body
 *   class is absent and no rect changes.
 * - `endGesture()` is idempotent and fires on: pointerup/cancel, lostpointercapture (capture
 *   mode), window `blur`, `visibilitychange`→hidden, crossing into the phone band, the target
 *   window being dropped (`dropRect`), and component unmount (`dispose`).
 * - viewport `resize` re-clamps every rect synchronously (`reclampAll`) while any rect exists.
 * - cross-breakpoint: rects are KEPT in both directions (§6.3); flipping to desktop re-clamps.
 *
 * CSP: rect values reach the DOM only as CSS variables through Vue `:style` OBJECT bindings
 * (`varsOf`) — no static style attributes, no rAF, no transform (R2).
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";
import {
  clampRect,
  defaultRect,
  moveRect,
  resizeRect,
  cascadeRect,
  type PreviewRect,
  type PreviewResizeDir,
  type PreviewViewportBox,
} from "@logic/previewWindowGeom.js";

/** §7.4 step 1: a pointerdown whose target is one of these never starts a gesture. */
const INTERACTIVE_SELECTOR = "button,a,input,select,textarea,[data-no-drag],[role=menu]";

/** The drag start threshold in px (§7.4 step 3). */
export const DRAG_START_PX = 3;

/** Added to `document.body` while a drag is active (CSS: `user-select:none` + iframe pointer-events:none). */
export const PW_DRAGGING_CLASS = "pwh-pw-dragging";

/** The structural event slices the controller reads (happy-dom and unit fakes both fit). */
export interface PointerDownLike {
  readonly pointerId: number;
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly target: unknown;
}

interface PointerMoveLike {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface LayoutDoc {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
  readonly body: { readonly classList: { add(cls: string): void; remove(cls: string): void } };
}

export interface LayoutWin {
  readonly innerWidth: number;
  readonly innerHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface UsePreviewWindowLayoutOptions {
  /** The ≥768px band (§6.3) — gestures only ever run on desktop. */
  readonly desktop: Readonly<Ref<boolean>>;
  readonly doc: LayoutDoc;
  readonly win: LayoutWin;
  /** The topbar's bottom edge in viewport px (ask-float's `topOffset()` discipline). */
  readonly topOffset: () => number;
}

/** §7.4's single in-flight gesture record. */
interface Gesture {
  readonly pointerId: number;
  readonly winId: number;
  readonly kind: "move" | PreviewResizeDir;
  readonly el: Element & {
    setPointerCapture?: (id: number) => void;
    hasPointerCapture?: (id: number) => boolean;
    releasePointerCapture?: (id: number) => void;
  };
  readonly mode: "capture" | "document";
  readonly startRect: PreviewRect;
  readonly startX: number;
  readonly startY: number;
  started: boolean;
}

export type PreviewWindowLayout = ReturnType<typeof usePreviewWindowLayout>;

export function usePreviewWindowLayout(opts: UsePreviewWindowLayoutOptions) {
  const rects = new Map<number, Ref<PreviewRect>>();
  let gesture: Gesture | null = null;
  let resizeHooked = false;
  let disposed = false;

  function vp(): PreviewViewportBox {
    return { vw: opts.win.innerWidth, vh: opts.win.innerHeight, top: opts.topOffset() };
  }

  // --- rect store ---------------------------------------------------------------------------

  /** A window appearing: the FIRST window takes `defaultRect`; every later one cascades off
   *  the given anchor's rect (the previous active window, W1's "从活动窗口错开摆放"),
   *  avoiding every occupied top-left corner (§7.3 cascadeRect). */
  function ensureRect(id: number, anchorId: number | null): void {
    if (rects.has(id)) return;
    const base = anchorId !== null ? (rects.get(anchorId)?.value ?? defaultRect(vp())) : defaultRect(vp());
    const occupied = [...rects.values()].map((r) => r.value);
    rects.set(id, ref(cascadeRect(base, vp(), occupied)));
    hookResize();
  }

  function dropRect(id: number): void {
    if (gesture !== null && gesture.winId === id) endGesture();
    rects.delete(id);
    if (rects.size === 0) unhookResize();
  }

  /** The 「重置位置和大小」 menu item: default size, centered (§5.5). */
  function resetRect(id: number): void {
    const r = rects.get(id);
    if (r !== undefined) r.value = defaultRect(vp());
  }

  /** §6.3 phone→desktop: re-clamp every stored rect into the (possibly new) viewport. */
  function reclampAll(): void {
    for (const r of rects.values()) r.value = clampRect(r.value, vp());
  }

  /** The `:style` payload for one desktop window — CSS variables ONLY (`left/top/width/height`
   *  and z ride `var(--pw-*)` in preview.css; the object form keeps this CSP-safe, §7.1). */
  function varsOf(id: number): Record<string, string> {
    const r = rects.get(id)?.value ?? defaultRect(vp());
    return {
      "--pw-x": `${r.x}px`,
      "--pw-y": `${r.y}px`,
      "--pw-w": `${r.w}px`,
      "--pw-h": `${r.h}px`,
    };
  }

  /** §5.5 keyboard equivalents: arrows move 16px, clamped. */
  function keyMove(id: number, dx: number, dy: number): void {
    const r = rects.get(id);
    if (r !== undefined) r.value = moveRect(r.value, dx, dy, vp());
  }

  /** §5.5 keyboard equivalents: Shift+arrows resize the right/bottom edge by 16px, clamped.
   *  The handle is UNCONDITIONALLY "se" — a negative delta shrinks the same right/bottom
   *  edge (Shift+← pulls the right edge LEFT); it never flips to the NW handle. */
  function keyResize(id: number, dx: number, dy: number): void {
    const r = rects.get(id);
    if (r !== undefined) r.value = resizeRect(r.value, "se", dx, dy, vp());
  }

  // --- gesture lifecycle --------------------------------------------------------------------

  function isInteractiveTarget(target: unknown): boolean {
    const el = target as Element | null;
    return el !== null && typeof el.closest === "function" && el.closest(INTERACTIVE_SELECTOR) !== null;
  }

  /** §7.4 step 1–2: gate, capture attempt, listener attachment. Returns whether a gesture began. */
  function beginGesture(ev: PointerDownLike, id: number, kind: "move" | PreviewResizeDir, el: Gesture["el"]): boolean {
    if (disposed || gesture !== null) return false;
    if (!opts.desktop.value) return false; // no drag/resize off the desktop band
    if (ev.button !== 0) return false;
    if (isInteractiveTarget(ev.target)) return false;
    const startRect = rects.get(id)?.value;
    if (startRect === undefined) return false;
    let mode: Gesture["mode"] = "capture";
    try {
      el.setPointerCapture?.(ev.pointerId);
      if (el.hasPointerCapture !== undefined && el.hasPointerCapture(ev.pointerId) === false) mode = "document";
    } catch {
      mode = "document";
    }
    gesture = {
      pointerId: ev.pointerId,
      winId: id,
      kind,
      el,
      mode,
      startRect,
      startX: ev.clientX,
      startY: ev.clientY,
      started: false,
    };
    const move = (m: unknown): void => onPointerMove(m as PointerMoveLike);
    const up = (): void => endGesture();
    if (mode === "capture") {
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up);
      gestureCleanup = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.removeEventListener("lostpointercapture", up);
      };
    } else {
      opts.doc.addEventListener("pointermove", move);
      opts.doc.addEventListener("pointerup", up);
      opts.doc.addEventListener("pointercancel", up);
      gestureCleanup = () => {
        opts.doc.removeEventListener("pointermove", move);
        opts.doc.removeEventListener("pointerup", up);
        opts.doc.removeEventListener("pointercancel", up);
      };
    }
    return true;
  }

  let gestureCleanup: (() => void) | null = null;

  function onPointerMove(m: PointerMoveLike): void {
    const g = gesture;
    if (g === null || m.pointerId !== g.pointerId) return; // other pointers are ignored
    const dx = m.clientX - g.startX;
    const dy = m.clientY - g.startY;
    if (!g.started) {
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      g.started = true;
      opts.doc.body.classList.add(PW_DRAGGING_CLASS);
    }
    const r = rects.get(g.winId);
    if (r === undefined) {
      endGesture();
      return;
    }
    r.value = g.kind === "move" ? moveRect(g.startRect, dx, dy, vp()) : resizeRect(g.startRect, g.kind, dx, dy, vp());
  }

  /** §7.4's one exit — idempotent; releases capture best-effort and drops the body class. */
  function endGesture(): void {
    const g = gesture;
    gesture = null;
    gestureCleanup?.();
    gestureCleanup = null;
    if (g === null) return;
    if (g.started) opts.doc.body.classList.remove(PW_DRAGGING_CLASS);
    if (g.mode === "capture") {
      try {
        g.el.releasePointerCapture?.(g.pointerId);
      } catch {
        /* already released — best-effort only */
      }
    }
  }

  // --- ambient listeners (blur / visibility / resize / band flip) ---------------------------

  function onWindowBlur(): void {
    endGesture();
  }

  function onVisibility(ev?: unknown): void {
    // Browser path: the state lives on `document`; a unit-test fake may carry it on the event.
    const state =
      typeof (ev as { visibilityState?: string } | undefined)?.visibilityState === "string"
        ? (ev as { visibilityState: string }).visibilityState
        : document.visibilityState;
    if (state === "hidden") endGesture();
  }

  function hookResize(): void {
    if (resizeHooked || disposed) return;
    resizeHooked = true;
    opts.win.addEventListener("resize", reclampAll);
    opts.win.addEventListener("blur", onWindowBlur);
    opts.doc.addEventListener("visibilitychange", onVisibility);
  }

  function unhookResize(): void {
    if (!resizeHooked) return;
    resizeHooked = false;
    opts.win.removeEventListener("resize", reclampAll);
    opts.win.removeEventListener("blur", onWindowBlur);
    opts.doc.removeEventListener("visibilitychange", onVisibility);
  }

  // §6.3 cross-breakpoint: leaving desktop ends any gesture; ENTERING desktop re-clamps
  // (rects are kept in both directions). The host owns the scroll-lock/focus halves.
  const stopDesktopWatch = watch(
    opts.desktop,
    (desktopNow) => {
      if (!desktopNow) endGesture();
      else reclampAll();
    },
    { flush: "sync" }, // a band flip must end the gesture before any later pointer event
  );

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    endGesture();
    unhookResize();
    stopDesktopWatch();
    rects.clear();
  }
  onScopeDispose(dispose, true); // failSilently: node unit tests run outside a component scope

  return {
    ensureRect,
    dropRect,
    resetRect,
    reclampAll,
    varsOf,
    keyMove,
    keyResize,
    beginGesture,
    endGesture,
    isInteractiveTarget,
    dispose,
  };
}
