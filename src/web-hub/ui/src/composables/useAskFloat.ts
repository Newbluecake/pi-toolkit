/**
 * Non-modal floating ask_user window — position state, drag math and persistence (user rulings
 * 2026-10-20; approved mocks `~/pwh-preview/askfloat/ask-float.png` +
 * `~/pwh-preview/askcompact/ask-compact.png`). A strict mirror of `useSidebarWidth.ts`'s
 * precedent: storage access is injected (never the `localStorage` identifier, so this file
 * stays clean under `source-scan.test.ts`'s storage-identifier rule), a stored value that is
 * unparseable or outside static sanity bounds fails open to the default anchor (`null` → no
 * inline override → ask-float.css's `right`/`bottom` fallback wins), and drag-preview never
 * hammers storage — persistence happens on release / keyboard nudge only. No rAF anywhere
 * (banned repo-wide; renderGate.ts owns scheduling): pointermove writes the ref directly, Vue
 * batches the render.
 *
 * Geometry contract (viewport ruling 2026-10-20): the window is `position: fixed`, so every
 * coordinate here is a VIEWPORT px offset — the user may drag it anywhere below the top bar,
 * across the agents tree / fleet drawer. The clamp box is the whole app viewport inset by
 * ASK_FLOAT_MARGIN, minus the top bar's bottom edge (the component measures `header.topbar`;
 * `window.innerWidth/innerHeight` bound the rest). The height-0 `.ask-anchor` element in flow
 * above the dock is now only the DEFAULT-POSITION marker: with no stored/dragged position the
 * window sits just above the composer, hugging the viewport's right edge
 * (`x = innerWidth − width − ASK_FLOAT_GUTTER`, `y = anchor.top − gap − height`), re-resolved
 * on every resize / dock-size change, so the default TRACKS the right edge and the composer.
 *
 * Persistence is VERSIONED (`{v:2,x,y}` — verifier round 3): values from the pre-fixed
 * (pane-relative, unversioned) build are DROPPED, not clamped — a negative pane-relative `y`
 * has no meaningful viewport interpretation, so the window simply opens at the default. The
 * phone sheet (<768px) never persists: it is an in-flow absolute sheet above the composer.
 */
import { onScopeDispose, ref, type Ref } from "vue";

export const ASK_FLOAT_POS_STORAGE_KEY = "pwh_askfloat_pos";
export const ASK_FLOAT_KEYBOARD_STEP = 16;
/** |dx|+|dy| beyond this during a drag makes the trailing click a drag-end, not an expand. */
export const ASK_FLOAT_CLICK_SUPPRESS_PX = 4;
/** Viewport inset around the clamp box (drag may go edge-to-edge except this margin). */
export const ASK_FLOAT_MARGIN = 8;
/** Vertical gap between the default-anchored window and the composer/dock top edge. */
export const ASK_FLOAT_GAP = 8;
/** Horizontal gap between the default-anchored window and the viewport's right edge. */
export const ASK_FLOAT_GUTTER = 8;
/** Storage schema version — anything without `v:2` (legacy pane-relative values) is dropped. */
export const ASK_FLOAT_POS_VERSION = 2;
/** Static sanity bounds for the persisted position (the viewport clamp is the real bound). */
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
  readonly innerWidth: number;
  readonly innerHeight: number;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

/**
 * Read the persisted window position; `null` = default bottom-right anchor. Unparseable
 * JSON, non-numeric/non-finite members, values beyond the static sanity bounds — and ANY
 * unversioned/foreign-version value (notably the pre-fixed pane-relative `{x,y}` schema,
 * whose negative `y` has no viewport meaning) — are ignored: the window opens at the default
 * instead of being clamped into a corner. The viewport clamp re-applies at mount/drag/resize
 * time, so a position stored on a large monitor still lands inside a small window.
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
  const { v, x, y } = parsed as Record<string, unknown>;
  if (v !== ASK_FLOAT_POS_VERSION) return null; // legacy/other schema ⇒ default position
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > POS_ABS_LIMIT || Math.abs(y) > POS_ABS_LIMIT) return null;
  return { x, y };
}

/** Clamp into the viewport box (degenerate/inverted boxes collapse onto the min edge) and round. */
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
  /** The height-0 `.ask-anchor` marker above the dock (default-position reference only). */
  anchor: Ref<unknown>;
  /** The `.ask-float` window element (measured for its live width/height). */
  float: Ref<unknown>;
  win: AskFloatResizeWindow;
  /** Bottom edge of the app chrome (top bar) in viewport px; 0 when it cannot be measured. */
  topOffset(): number;
}

export interface UseAskFloatHandle {
  /** Explicit viewport px offset, or `null` while the default anchor applies. */
  readonly pos: Ref<AskFloatPos | null>;
  /** Resolved default position (above the composer, right-aligned) once layout is measurable. */
  readonly defaultPos: Readonly<Ref<AskFloatPos | null>>;
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
  /** Re-clamp a set position / re-resolve the default (mount, expand, resize, band flip). */
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
  const defaultPos = ref<AskFloatPos | null>(null);
  const dragging = ref(false);

  interface Geo {
    ar: AskFloatRect;
    fr: AskFloatRect;
  }

  function measure(): Geo | null {
    const anchor = asFloatElement(opts.anchor.value);
    const float = asFloatElement(opts.float.value);
    if (anchor === null || float === null) return null;
    return {
      ar: anchor.getBoundingClientRect(),
      fr: float.getBoundingClientRect(),
    };
  }

  /** The clamp box: the whole app viewport below the top bar, inset by ASK_FLOAT_MARGIN — the
   * window may be dragged across the agents tree / fleet drawer, never under the top bar. */
  function clampBox(fr: AskFloatRect): AskFloatClampBox {
    return {
      minX: ASK_FLOAT_MARGIN,
      maxX: opts.win.innerWidth - fr.width - ASK_FLOAT_MARGIN,
      minY: opts.topOffset() + ASK_FLOAT_MARGIN,
      maxY: opts.win.innerHeight - fr.height - ASK_FLOAT_MARGIN,
    };
  }

  /** Current position: the explicit override, else measured from the live rects (0/0 if none). */
  function currentPos(): AskFloatPos {
    if (pos.value !== null) return pos.value;
    const g = measure();
    if (g === null) return { x: 0, y: 0 };
    return { x: g.fr.left, y: g.fr.top };
  }

  function persist(): void {
    if (pos.value === null) return;
    try {
      opts.storage.setItem(ASK_FLOAT_POS_STORAGE_KEY, JSON.stringify({ v: ASK_FLOAT_POS_VERSION, ...pos.value }));
    } catch {
      /* storage disabled — the in-memory position still applies for this load */
    }
  }

  function clampNow(): void {
    if (!opts.desktop.value) return;
    const g = measure();
    if (g === null) return;
    if (pos.value !== null) {
      pos.value = clampAskFloatPos(pos.value, clampBox(g.fr));
      return;
    }
    // No override: resolve the DEFAULT position in viewport coordinates — hugging the RIGHT
    // EDGE (x tracks resizes: innerWidth − width − gutter) and sitting just above the composer
    // (anchor top − gap − height; the component's ResizeObserver re-runs this when the dock
    // grows). Zero rects (pre-layout / happy-dom) mean "not measurable yet" — keep the CSS
    // fallback rather than materializing a bogus position.
    if (g.fr.width === 0 && g.fr.height === 0) return;
    defaultPos.value = clampAskFloatPos(
      { x: opts.win.innerWidth - g.fr.width - ASK_FLOAT_GUTTER, y: g.ar.top - ASK_FLOAT_GAP - g.fr.height },
      clampBox(g.fr),
    );
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
    pos.value = clampAskFloatPos({ x: baseX + dx, y: baseY + dy }, clampBox(g.fr));
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
    pos.value = clampAskFloatPos({ x: cur.x + dx, y: cur.y + dy }, clampBox(g.fr));
    persist();
  }

  const onResize = (): void => clampNow();
  opts.win.addEventListener("resize", onResize);

  function dispose(): void {
    opts.win.removeEventListener("resize", onResize);
    endDrag();
  }
  onScopeDispose(dispose, true); // failSilently: safe to call outside a component scope (unit tests)

  return {
    pos,
    defaultPos,
    dragging,
    onBarPointerDown,
    consumeDragClick,
    resetDragClick,
    cancelDrag,
    nudge,
    clampNow,
    dispose,
  };
}
