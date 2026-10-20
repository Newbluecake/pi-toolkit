/**
 * Non-modal floating ask_user window — position state, drag math and persistence (user ruling
 * 2026-10-20; approved mock `~/pwh-preview/askfloat/ask-float.png`). A strict mirror of
 * `useSidebarWidth.ts`'s precedent: storage access is injected (never the `localStorage`
 * identifier, so this file stays clean under `source-scan.test.ts`'s storage-identifier
 * rule), a stored value that is unparseable or outside static sanity bounds fails open to the
 * default anchor (`null` → no inline override → ask-float.css's `right`/`bottom` anchor wins),
 * and drag-preview never hammers storage — persistence happens on release / keyboard nudge
 * only. No rAF anywhere (banned repo-wide; renderGate.ts owns scheduling): pointermove writes
 * the ref directly, Vue batches the render.
 *
 * Geometry contract: the component's root is a height-0 `.ask-anchor` element placed in flow
 * IMMEDIATELY above the dock (folded notes render between them are fine — the anchor is the
 * float's containing block, so the default `bottom: 8px` anchor always sits just above the
 * composer without any measuring, and a growing dock simply pushes the anchor up). The pane
 * the window clamps to is the anchor's `parentElement` (`.detail-main` in AgentDetail). All
 * stored/inline positions are px offsets from the anchor's top-left — `y` is normally
 * NEGATIVE (the window floats ABOVE the zero-height anchor), so validation must accept
 * negative values; the pane clamp on apply/drag/resize is what actually bounds it.
 */
import { onScopeDispose, ref, type Ref } from "vue";

export const ASK_FLOAT_POS_STORAGE_KEY = "pwh_askfloat_pos";
export const ASK_FLOAT_KEYBOARD_STEP = 16;
/** |dx|+|dy| beyond this during a drag makes the trailing click a drag-end, not an expand. */
export const ASK_FLOAT_CLICK_SUPPRESS_PX = 4;
/** Static sanity bounds for the persisted position (the pane clamp is the real bound). */
const POS_ABS_LIMIT = 100_000;

export interface AskFloatPos {
  readonly x: number;
  readonly y: number;
}

export interface AskFloatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AskFloatClampBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface AskFloatRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Minimal element surface the drag lifecycle needs (PointerEvent.currentTarget + rects). */
export interface AskFloatElement {
  readonly parentElement: AskFloatElement | null;
  getBoundingClientRect(): AskFloatRect;
  addEventListener(type: string, listener: (ev: { clientX: number; clientY: number }) => void): void;
  removeEventListener(type: string, listener: (ev: { clientX: number; clientY: number }) => void): void;
  setPointerCapture?(pointerId: number): void;
}

export interface AskFloatPointerEvent {
  readonly button: number;
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly currentTarget: unknown;
  readonly target: unknown;
}

export interface AskFloatResizeWindow {
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

/**
 * Read the persisted window position; `null` = default bottom-right anchor. Unparseable
 * JSON, non-numeric/non-finite members, or values beyond the static sanity bounds are
 * ignored — the pane clamp re-applies at mount/drag/resize time, so a position stored on a
 * large monitor still lands inside a small pane. `y` may legitimately be negative (see the
 * file header), so only the absolute magnitude is bounded.
 */
export function loadAskFloatPos(storage: AskFloatStorage): AskFloatPos | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(ASK_FLOAT_POS_STORAGE_KEY);
  } catch {
    /* storage disabled/unavailable — same fail-open philosophy as useFontScale.ts */
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { x, y } = parsed as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > POS_ABS_LIMIT || Math.abs(y) > POS_ABS_LIMIT) return null;
  return { x, y };
}

/** Clamp into the pane box (degenerate/inverted boxes collapse onto the min edge) and round. */
export function clampAskFloatPos(pos: AskFloatPos, box: AskFloatClampBox): AskFloatPos {
  const maxX = Math.max(box.minX, box.maxX);
  const maxY = Math.max(box.minY, box.maxY);
  return {
    x: Math.round(Math.min(Math.max(pos.x, box.minX), maxX)),
    y: Math.round(Math.min(Math.max(pos.y, box.minY), maxY)),
  };
}

export interface UseAskFloatOptions {
  storage: AskFloatStorage;
  /** ≥768px desktop band — drag/clamp/persist only apply there (the phone sheet never moves). */
  desktop: Ref<boolean>;
  /** The height-0 `.ask-anchor` element; its parent is the pane the window clamps to. */
  anchor: Ref<unknown>;
  /** The `.ask-float` window element (measured for its live width/height). */
  float: Ref<unknown>;
  win: AskFloatResizeWindow;
}

export interface UseAskFloatHandle {
  /** Explicit px offset from the anchor, or `null` for the CSS default anchor. */
  readonly pos: Ref<AskFloatPos | null>;
  readonly dragging: Readonly<Ref<boolean>>;
  onBarPointerDown(ev: AskFloatPointerEvent): void;
  /** Returns true once when the click ending a real drag should be ignored (click-to-expand). */
  consumeDragClick(): boolean;
  /** Clear the drag-click suppression (keyboard activation / programmatic expand after a drag). */
  resetDragClick(): void;
  /** End any in-flight drag WITHOUT a pointerup (bar swap on minimize, `lostpointercapture`). */
  cancelDrag(): void;
  /** Keyboard nudge (arrow keys on the title bar); clamps and persists immediately. */
  nudge(dx: number, dy: number): void;
  /** Re-clamp a set position to the current pane (mount, expand, content resize, band flip). */
  clampNow(): void;
  dispose(): void;
}

function asFloatElement(raw: unknown): AskFloatElement | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const el = raw as Partial<AskFloatElement>;
  return typeof el.getBoundingClientRect === "function" ? (el as AskFloatElement) : null;
}

/**
 * A pointerdown landing on an INTERACTIVE CHILD of the bar (the minimize/expand button,
 * links, inputs) must NOT start a drag: `setPointerCapture` retargets every later pointer
 * event of that pointer — including the compatibility `click` — to the bar, so the child
 * control would go dead under a real mouse (Chromium dispatches click to the capture
 * target). A `closest()` hit that IS the bar itself (the minimized bar is a `<button>`)
 * does not count — that bar stays draggable as a whole.
 */
function isInteractiveChild(bar: AskFloatElement, target: unknown): boolean {
  if (target === null || target === undefined || typeof target !== "object") return false;
  const el = target as Partial<Element>;
  if (typeof el.closest !== "function") return false;
  const hit = el.closest("button, a, input, textarea, select, [role='button']");
  if (hit === null || hit === (bar as unknown as Element)) return false;
  const contains = (bar as unknown as Partial<Element>).contains;
  return typeof contains === "function" ? contains.call(bar, hit) : true;
}

export function useAskFloat(opts: UseAskFloatOptions): UseAskFloatHandle {
  const pos = ref<AskFloatPos | null>(loadAskFloatPos(opts.storage)) as Ref<AskFloatPos | null>;
  const dragging = ref(false);

  interface Geo {
    ar: AskFloatRect;
    pr: AskFloatRect;
    fr: AskFloatRect;
  }

  function measure(): Geo | null {
    const anchor = asFloatElement(opts.anchor.value);
    const float = asFloatElement(opts.float.value);
    if (anchor === null || float === null) return null;
    const pane = anchor.parentElement;
    if (pane === null) return null;
    return {
      ar: anchor.getBoundingClientRect(),
      pr: pane.getBoundingClientRect(),
      fr: float.getBoundingClientRect(),
    };
  }

  function clampBox(g: Geo): AskFloatClampBox {
    return {
      minX: g.pr.left - g.ar.left,
      maxX: g.pr.right - g.ar.left - g.fr.width,
      minY: g.pr.top - g.ar.top,
      maxY: g.pr.bottom - g.ar.top - g.fr.height,
    };
  }

  /** Current position: the explicit override, else measured from the live rects (0/0 if none). */
  function currentPos(): AskFloatPos {
    if (pos.value !== null) return pos.value;
    const g = measure();
    if (g === null) return { x: 0, y: 0 };
    return { x: g.fr.left - g.ar.left, y: g.fr.top - g.ar.top };
  }

  function persist(): void {
    if (pos.value === null) return;
    try {
      opts.storage.setItem(ASK_FLOAT_POS_STORAGE_KEY, JSON.stringify(pos.value));
    } catch {
      /* storage disabled — the in-memory position still applies for this load */
    }
  }

  function clampNow(): void {
    if (!opts.desktop.value || pos.value === null) return;
    const g = measure();
    if (g === null) return;
    pos.value = clampAskFloatPos(pos.value, clampBox(g));
  }

  // --- drag lifecycle (listeners live on the captured bar, never on window) ---------------

  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let movedFar = false;
  let bar: AskFloatElement | null = null;

  const onMove = (ev: { clientX: number; clientY: number }): void => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > ASK_FLOAT_CLICK_SUPPRESS_PX) movedFar = true;
    const g = measure();
    if (g === null) return;
    pos.value = clampAskFloatPos({ x: baseX + dx, y: baseY + dy }, clampBox(g));
  };

  function endDrag(): void {
    if (!dragging.value) return;
    dragging.value = false;
    if (bar !== null) {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      bar.removeEventListener("lostpointercapture", onUp);
      bar = null;
    }
    persist();
  }

  const onUp = (): void => endDrag();

  function onBarPointerDown(ev: AskFloatPointerEvent): void {
    if (!opts.desktop.value || ev.button !== 0 || dragging.value) return;
    const el = asFloatElement(ev.currentTarget);
    if (el === null || typeof el.addEventListener !== "function") return;
    if (isInteractiveChild(el, ev.target)) return; // clicks on inner controls must stay clicks
    // NO preventDefault here — it would rob the bar of pointer-focus (keyboard nudge/Esc
    // need it). Text selection during the drag is suppressed by CSS `user-select: none` on
    // the bar, touch scrolling by `touch-action: none` (ask-float.css).
    const cur = currentPos();
    startX = ev.clientX;
    startY = ev.clientY;
    baseX = cur.x;
    baseY = cur.y;
    movedFar = false;
    dragging.value = true;
    bar = el;
    try {
      el.setPointerCapture?.(ev.pointerId); // happy-dom may not implement it — optional
    } catch {
      /* capture is best-effort; listeners on the bar itself still track the drag */
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    // Chromium fires `lostpointercapture` when the capture is released out from under us
    // (element detached by the minimized-bar swap, browser gesture takeover, …) — end the
    // drag there too so it can never get stuck with move listeners on a dead element.
    el.addEventListener("lostpointercapture", onUp);
  }

  function consumeDragClick(): boolean {
    const was = movedFar;
    movedFar = false;
    return was;
  }

  function resetDragClick(): void {
    movedFar = false;
  }

  function cancelDrag(): void {
    endDrag();
    movedFar = false;
  }

  function nudge(dx: number, dy: number): void {
    if (!opts.desktop.value) return;
    const g = measure();
    if (g === null) return;
    const cur = currentPos();
    pos.value = clampAskFloatPos({ x: cur.x + dx, y: cur.y + dy }, clampBox(g));
    persist();
  }

  const onResize = (): void => clampNow();
  opts.win.addEventListener("resize", onResize);

  function dispose(): void {
    opts.win.removeEventListener("resize", onResize);
    endDrag();
  }
  onScopeDispose(dispose, true); // failSilently: safe to call outside a component scope (unit tests)

  return { pos, dragging, onBarPointerDown, consumeDragClick, resetDragClick, cancelDrag, nudge, clampNow, dispose };
}
