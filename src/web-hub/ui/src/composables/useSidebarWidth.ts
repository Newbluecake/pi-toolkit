/**
 * Draggable session-list sidebar width (desktop ≥1025px split only). A strict mirror of
 * `useFontScale.ts`'s precedent: storage access is injected (never the `localStorage`
 * identifier, so this file stays clean under `source-scan.test.ts`'s storage-identifier
 * rule), a stored value that is unparseable or outside the static bounds fails open to the
 * responsive default (`null` → no inline override → shell.css's media queries win), and
 * drag-preview never hammers storage — persistence happens on release / key step only.
 *
 * The composable owns ONLY the width state and the pointer/keyboard math; the actual
 * `--sidebar-w` override reaches the DOM through the component's `:style` binding on the
 * `.layout` element (inline style beats shell.css's media-scoped `html:root` rules by
 * cascade, no `!important`). No module-scope mutable state — every field lives in the
 * closure, and `dispose()` (registered via `onScopeDispose`) drops any in-flight drag's
 * listeners and the body drag class.
 */
import { onScopeDispose, ref, type Ref } from "vue";

export const SIDEBAR_WIDTH_STORAGE_KEY = "pwh_sidebar_w";

export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 560; // additionally capped at 50vw — see sidebarWidthMax()
export const SIDEBAR_WIDTH_STEP = 16; // ArrowLeft/Right keyboard step
/** Drag-start / aria fallback when neither a stored width nor a measurable layout exists
 * (matches shell.css's ≥1025px default of 240px). */
export const SIDEBAR_WIDTH_FALLBACK = 240;

export interface SidebarWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SidebarWidthWindow {
  readonly innerWidth: number;
  getComputedStyle(el: unknown): { readonly gridTemplateColumns: string };
}

export interface SidebarWidthBody {
  classList: { add(name: string): void; remove(name: string): void };
}

/** Body class applied while a drag is in flight (shell.css: user-select none + col-resize). */
export const SIDEBAR_RESIZING_CLASS = "pwh-sidebar-resizing";

/** Effective max for a viewport: the smaller of the static 560px cap and 50vw. */
export function sidebarWidthMax(win: { readonly innerWidth: number }): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.floor(win.innerWidth / 2));
}

/** Clamp to [MIN, effective max] and round to whole pixels. */
export function clampSidebarWidth(px: number, win: { readonly innerWidth: number }): number {
  return Math.min(sidebarWidthMax(win), Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
}

/**
 * Read the persisted width; `null` = no override (media-query defaults apply). Values
 * outside the STATIC [MIN, MAX] bounds (or unparseable) are ignored — the viewport half of
 * the clamp is re-applied at restore/drag time, so a width stored on a wide monitor still
 * loads on a narrow one.
 */
export function loadSidebarWidth(storage: SidebarWidthStorage): number | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  } catch {
    /* storage disabled/unavailable — same fail-open philosophy as useFontScale.ts */
  }
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < SIDEBAR_WIDTH_MIN || parsed > SIDEBAR_WIDTH_MAX) {
    return null;
  }
  return Math.round(parsed);
}

/** Minimal element surface the drag lifecycle needs (PointerEvent.currentTarget). */
interface DragHandleElement {
  addEventListener(type: string, listener: (ev: { clientX: number }) => void): void;
  removeEventListener(type: string, listener: (ev: { clientX: number }) => void): void;
  setPointerCapture?(pointerId: number): void;
}

export interface SidebarWidthPointerEvent {
  readonly button: number;
  readonly pointerId: number;
  readonly clientX: number;
  readonly currentTarget: unknown;
  preventDefault(): void;
}

export interface SidebarWidthKeyEvent {
  readonly key: string;
  preventDefault(): void;
}

export interface UseSidebarWidthOptions {
  storage: SidebarWidthStorage;
  win: SidebarWidthWindow;
  /** The `.layout` element — measured for the drag-start width when no override is set yet. */
  target: Ref<unknown>;
  /** Receives `SIDEBAR_RESIZING_CLASS` for the drag's lifetime (text-selection suppression). */
  body?: SidebarWidthBody;
}

export interface UseSidebarWidthHandle {
  /** Explicit width in px, or `null` for the responsive media-query default. */
  readonly width: Readonly<Ref<number | null>>;
  readonly dragging: Readonly<Ref<boolean>>;
  readonly ariaMin: number;
  /** Current effective max (viewport-dependent; call during render/aria computation). */
  ariaMax(): number;
  /** Width the sidebar currently renders at (override, measured grid track, or fallback). */
  currentWidth(): number;
  onPointerDown(ev: SidebarWidthPointerEvent): void;
  onKeyDown(ev: SidebarWidthKeyEvent): void;
  /** Double-click: back to the responsive default (clears storage + the inline override). */
  reset(): void;
  dispose(): void;
}

export function useSidebarWidth(opts: UseSidebarWidthOptions): UseSidebarWidthHandle {
  const stored = loadSidebarWidth(opts.storage);
  const width = ref<number | null>(stored === null ? null : clampSidebarWidth(stored, opts.win)) as Ref<number | null>;
  const dragging = ref(false);

  function persist(value: number): void {
    try {
      opts.storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(value));
    } catch {
      /* storage disabled — the in-memory width still applies for this load */
    }
  }

  function clearStored(): void {
    try {
      opts.storage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    } catch {
      /* storage disabled — nothing to clear */
    }
  }

  /** First grid track of `.layout` resolves to the live sidebar width at ≥1025px. */
  function measureTarget(): number | null {
    const el = opts.target.value;
    if (el === null || el === undefined) return null;
    try {
      const first = (opts.win.getComputedStyle(el).gridTemplateColumns ?? "").trim().split(/\s+/)[0] ?? "";
      if (!first.endsWith("px")) return null;
      const px = Number(first.slice(0, -2));
      return Number.isFinite(px) && px > 0 ? px : null;
    } catch {
      return null;
    }
  }

  function currentWidth(): number {
    return width.value ?? measureTarget() ?? SIDEBAR_WIDTH_FALLBACK;
  }

  // --- drag lifecycle (listeners live on the captured handle, never on window) ----------

  let startX = 0;
  let startWidth = 0;
  let handle: DragHandleElement | null = null;

  const onMove = (ev: { clientX: number }): void => {
    width.value = clampSidebarWidth(startWidth + (ev.clientX - startX), opts.win);
  };

  function endDrag(): void {
    if (!dragging.value) return;
    dragging.value = false;
    if (handle !== null) {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle = null;
    }
    opts.body?.classList.remove(SIDEBAR_RESIZING_CLASS);
    if (width.value !== null) persist(width.value);
  }

  const onUp = (): void => endDrag();

  function onPointerDown(ev: SidebarWidthPointerEvent): void {
    if (ev.button !== 0 || dragging.value) return;
    const el = ev.currentTarget as DragHandleElement | null;
    if (el === null || el === undefined || typeof el.addEventListener !== "function") return;
    ev.preventDefault(); // suppresses the native text-selection gesture from the first move
    startX = ev.clientX;
    startWidth = currentWidth();
    dragging.value = true;
    handle = el;
    try {
      el.setPointerCapture?.(ev.pointerId); // happy-dom may not implement it — optional
    } catch {
      /* capture is best-effort; listeners on the handle itself still track the drag */
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    opts.body?.classList.add(SIDEBAR_RESIZING_CLASS);
  }

  // --- keyboard (WAI-ARIA separator pattern: arrows step, Home/End to the ends) ---------

  function onKeyDown(ev: SidebarWidthKeyEvent): void {
    let next: number;
    if (ev.key === "ArrowLeft") next = currentWidth() - SIDEBAR_WIDTH_STEP;
    else if (ev.key === "ArrowRight") next = currentWidth() + SIDEBAR_WIDTH_STEP;
    else if (ev.key === "Home") next = SIDEBAR_WIDTH_MIN;
    else if (ev.key === "End") next = sidebarWidthMax(opts.win);
    else return;
    ev.preventDefault();
    width.value = clampSidebarWidth(next, opts.win);
    persist(width.value);
  }

  function reset(): void {
    width.value = null;
    clearStored();
  }

  function dispose(): void {
    endDrag();
    dragging.value = false;
  }

  onScopeDispose(dispose, true); // failSilently: safe outside a component scope (unit tests)

  return {
    width,
    dragging,
    ariaMin: SIDEBAR_WIDTH_MIN,
    ariaMax: () => sidebarWidthMax(opts.win),
    currentWidth,
    onPointerDown,
    onKeyDown,
    reset,
    dispose,
  };
}
