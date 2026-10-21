/**
 * web-hub-preview-windows plan r2 §5.6 (W3): the DOM half of the conversation ⇄ window
 * keyboard switcher. Key = `Ctrl+`` forward / `Ctrl+Shift+`` backward (user 拍板 3),
 * detected via `ev.code === "Backquote"` (layout-independent; Ctrl on macOS too — never
 * Alt/⌘), listened on `window` keydown in the BUBBLE phase so window-level handlers
 * (DashboardView's Esc, the composer's Enter/Tab) see their keys first and are untouched
 * (the plan's per-key audit: composer owns Enter/Alt+Enter/Shift+Enter + ↑↓/Tab/Esc for
 * palette/mention; Transcript owns scroll keys; PageDropZone owns drag-Esc only).
 *
 * Never active when: there are no windows; the key is part of an IME composition
 * (`ev.isComposing`); or ANY `[aria-modal="true"]` is in the document (every real modal —
 * settings, pickers, and the phone full-screen window stack, whose top panel is
 * `aria-modal="true"`).
 *
 * Semantics (Alt+Tab-style MRU, pure helpers in `@logic/previewWindowCycle.js`):
 * - Each press reuses the FROZEN ring while `document.activeElement === lastFocused` (focus
 *   is still exactly where the previous step put it); anything else — a click, another
 *   window's focusRequest, focus moved within a window — takes a FRESH ring off the current
 *   `order` starting at wherever focus now sits. The frozen ring is what prevents
 *   ping-ponging between two windows: `focusWindow` raising the target never rebuilds it.
 * - Landing on a window: `focusWindow(id, { moveFocus: true })` — the HOST (W2's
 *   PreviewHost) lands the focus after its focusRequest/nextTick; this composable then
 *   records the landed element as `lastFocused` (two ticks later; if focus never arrived the
 *   value stays `null` and the next press re-snapshots — always safe).
 * - Landing on "page": focus `pageFocus()` (W2's §5.4 ref) if still connected, else
 *   `.composer textarea`, else blur the active element.
 *
 * DOM contract relied on (plan §5.3, W2 implements it): each window section is
 * `.preview-window` containing a `.preview-panel[aria-labelledby="pw-title-<id>"]`. That
 * `aria-labelledby` id is the ONLY window-identity channel in the DOM (§7.2 gives the
 * section no data attribute) — see `previewCycleWindowIdOf`.
 */
import { nextTick, onScopeDispose } from "vue";
import { previewCycleRing, previewCycleStep, type PreviewCycleEntry } from "@logic/previewWindowCycle.js";
import type { PreviewWindowsFace } from "./usePreviewWindows.js";

export interface PreviewWindowCycleOptions {
  /** The §4.3 windows face (from `asWindowsHandle(ctx.handle)`); order/focusWindow/windows. */
  readonly face: PreviewWindowsFace;
  /** §5.4 page-focus restore target (W2's `pageFocus`), read per landing; absent ⇒ fallbacks. */
  readonly pageFocus?: () => Element | null;
}

interface CycleSnapshot {
  readonly ring: readonly PreviewCycleEntry[];
  readonly at: PreviewCycleEntry;
}

const PW_TITLE_RE = /^pw-title-(\d+)$/;

/**
 * Which preview window (if any) contains `el` — via the §5.3 `pw-title-<id>` aria contract.
 * Exported for tests and for W2's host-side parity checks; returns `null` outside windows.
 */
export function previewCycleWindowIdOf(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const section = target.closest(".preview-window");
  if (section === null) return null;
  const panel = section.querySelector(".preview-panel[aria-labelledby]");
  if (panel === null) return null;
  const labelledby = panel.getAttribute("aria-labelledby") ?? "";
  const m = PW_TITLE_RE.exec(labelledby);
  return m === null ? null : Number(m[1]);
}

export function usePreviewWindowCycle(opts: PreviewWindowCycleOptions): void {
  const { face } = opts;
  let snapshot: CycleSnapshot | null = null;
  /** The element the last cycle step focused; `null` while a window landing is in flight. */
  let lastFocused: Element | null = null;

  function focusAt(): PreviewCycleEntry {
    return previewCycleWindowIdOf(document.activeElement) ?? "page";
  }

  function landOnPage(): void {
    lastFocused = null;
    const wanted = opts.pageFocus?.() ?? null;
    const el = wanted !== null && wanted.isConnected ? wanted : document.querySelector(".composer textarea");
    if (el instanceof HTMLElement) {
      el.focus();
      lastFocused = el;
      return;
    }
    const cur = document.activeElement;
    if (cur instanceof HTMLElement) cur.blur();
  }

  /** After the host lands a `focusRequest`, remember the landed element (reuse condition). */
  async function landOnWindow(id: number): Promise<void> {
    await nextTick();
    await nextTick();
    const el = document.activeElement;
    if (el instanceof Element && previewCycleWindowIdOf(el) === id) lastFocused = el;
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.code !== "Backquote" || !ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.isComposing) return;
    if (face.windows.value.length === 0) return;
    if (document.querySelector('[aria-modal="true"]') !== null) return;

    const dir: 1 | -1 = ev.shiftKey ? -1 : 1;
    if (snapshot === null || document.activeElement !== lastFocused) {
      snapshot = { ring: previewCycleRing(face.order.value), at: focusAt() };
    }
    let next = previewCycleStep(snapshot.ring, snapshot.at, dir);
    if (next === null) {
      snapshot = null;
      lastFocused = null;
      return;
    }
    if (next !== "page" && !face.windows.value.some((w) => w.id === next)) {
      // The frozen ring stepped onto a window closed since the snapshot — re-snapshot from
      // where focus actually sits and take a single fresh step instead.
      const ring = previewCycleRing(face.order.value);
      const at = focusAt();
      next = previewCycleStep(ring, at, dir);
      if (next === null || (next !== "page" && !face.windows.value.some((w) => w.id === next))) {
        snapshot = null;
        lastFocused = null;
        return;
      }
      snapshot = { ring, at: next };
    } else {
      snapshot = { ring: snapshot.ring, at: next };
    }

    ev.preventDefault();
    if (next === "page") {
      landOnPage();
      return;
    }
    lastFocused = null; // until the host lands the focusRequest (async)
    face.focusWindow(next, { moveFocus: true });
    void landOnWindow(next);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeydown);
    onScopeDispose(() => window.removeEventListener("keydown", onKeydown));
  }
}
