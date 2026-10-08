/**
 * worktree-diff plan v3.1 §4.3 (package D5, D12): the diff dialog's LOCAL modal shell —
 * focus enter/return, Tab cycling, Esc ownership, backdrop close, body scroll lock. Deliberately
 * its own implementation next to `PreviewHost.vue`'s identical semantics (D12: 不抽共享
 * composable、不改 PreviewHost) — the two must stay behaviorally aligned (same test grammar as
 * `tests/web-hub/ui/preview-host.test.ts`'s shell cases) but evolve independently.
 *
 * Contract (mirrors preview §4.6 exactly):
 * - `isOpen` flipping true: remember the previously focused element, lock body scroll through
 *   the shared ref-counted `acquireBodyScrollLock()` (composes with preview/other overlays),
 *   then focus the panel (which carries `tabindex="-1"`);
 * - closing (false) restores the scroll lock — idempotently — and returns focus to the saved
 *   element if it is still in the document;
 * - Tab / Shift+Tab cycle inside the panel; the focusable set only ever contains RENDERED,
 *   visible elements because the dialog hides things with `v-if` (never CSS) — e.g. the mobile
 *   viewport's split/unified toggle is absent from the DOM and thus never in the cycle (#11);
 * - Esc: `preventDefault()` + `stopPropagation()` — the overlay owns Esc while open — then
 *   `onClose()`;
 * - unmount/dispose releases the scroll lock (关闭与卸载两路径都释放), never touching focus.
 */
import { nextTick, onScopeDispose, watch, type Ref } from "vue";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";

export interface DiffModalOptions {
  readonly isOpen: Readonly<Ref<boolean>>;
  readonly panelEl: Readonly<Ref<HTMLElement | null>>;
  readonly onClose: () => void;
}

export interface DiffModalHandle {
  /** Wire to the overlay root's `@keydown` (focus sits inside the panel; keydown bubbles up). */
  onKeydown(ev: KeyboardEvent): void;
  dispose(): void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDiffModal(opts: DiffModalOptions): DiffModalHandle {
  let returnFocus: Element | null = null;
  let releaseScrollLock: (() => void) | null = null;

  function restoreScroll(): void {
    releaseScrollLock?.(); // idempotent — safe on both the close and unmount paths
    releaseScrollLock = null;
  }

  async function enter(): Promise<void> {
    returnFocus = typeof document === "undefined" ? null : document.activeElement;
    releaseScrollLock = acquireBodyScrollLock();
    await nextTick();
    opts.panelEl.value?.focus();
  }

  function leave(): void {
    restoreScroll();
    const target = returnFocus;
    returnFocus = null;
    if (target instanceof HTMLElement && typeof document !== "undefined" && document.contains(target)) {
      target.focus();
    }
  }

  const stopWatch = watch(
    opts.isOpen,
    (open) => {
      if (open) void enter();
      else leave();
    },
    { immediate: true }, // a dialog mounted already-open locks/focuses too
  );

  function trapTab(ev: KeyboardEvent): void {
    const panel = opts.panelEl.value;
    if (panel === null) {
      ev.preventDefault();
      return;
    }
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      ev.preventDefault();
      return;
    }
    const active = document.activeElement;
    const outside = active === null || !panel.contains(active);
    if (ev.shiftKey && (outside || active === first)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (outside || active === last)) {
      ev.preventDefault();
      first.focus();
    }
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      opts.onClose();
      return;
    }
    if (ev.key === "Tab") trapTab(ev);
  }

  function dispose(): void {
    stopWatch();
    restoreScroll(); // the unmount path: ALWAYS release the lock (never returns focus)
    returnFocus = null;
  }
  onScopeDispose(dispose, true); // failSilently: safe outside a component/effect scope

  return { onKeydown, dispose };
}
