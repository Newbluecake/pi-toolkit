<!--
  PreviewHost.vue — web-hub-preview-windows plan r2 §9 (W2): the windows SHELL. Everything
  per-dialog moved into `PreviewWindow.vue`; what remains here is exactly §7.2's sketch:

  - the Teleport + root node `.preview-overlay.is-windows` (+ `.is-modeless` on the ≥768px
    band — pointer-events:none, no scrim, no body-scroll lock; the phone band keeps the base
    z60 fullscreen stack + scroll lock, §6);
  - the keyed `v-for` over the manager's `windows` (CREATION order — never reordered; z-order
    rides `--pw-z`, so a window's DOM node and any iframe inside it are never remounted, R1);
  - geometry (`usePreviewWindowLayout`: cascade placement per new window, drag/resize
    gestures, viewport re-clamp) and the desktop resize hot zones;
  - focus (§5.4/§6.2): activation on pointerdown/focusin, per-window `lastFocus`, `pageFocus`
    refreshed by ANY focusin landing outside the windows (r2 复审处置), `focusRequest`
    landing after nextTick, focus return on close — and the phone-band trap confined to the
    TOP window with `focusablesIn()` filtering `[inert]` subtrees (评审 #4);
  - Esc (§5.5): closes exactly the window containing the event target (preventDefault +
    stopPropagation, so DashboardView's window-level Esc never fires); the window menu stops
    its own Esc first.

  `asWindowsHandle(ctx.handle) === null` ⇒ NOTHING renders (评审 #14: the legacy single-window
  face is deleted; component fakes come from `tests/.../helpers/preview-windows-fake.ts`).

  W3 wire-in (live, see the "W3 wire-in" section below): `usePreviewWindowCycle(...)` — the
  Ctrl+` conversation⇄window ring (§5.6) — and `provide(PREVIEW_HTML_LEDGER, …)` — the §8.2
  tab-local html-cap FIFO ledger every window's PreviewHtml shares.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, provide, ref, watch } from "vue";
import type { PreviewResizeDir } from "@logic/previewWindowGeom.js";
import { asWindowsHandle } from "../../composables/usePreviewWindows.js";
import { usePreviewWindowCycle } from "../../composables/usePreviewWindowCycle.js";
import { usePreviewWindowLayout } from "../../composables/usePreviewWindowLayout.js";
import { useMedia } from "../../composables/useMedia.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import { usePlaintextWarning } from "../../composables/usePlaintextWarning.js";
import { browserLocalStorage } from "../shell/themeStorage.js";
import PreviewWindow from "./PreviewWindow.vue";
import { PREVIEW_CTX } from "./previewContext.js";
import { createPreviewHtmlLedger, PREVIEW_HTML_LEDGER } from "./previewHtmlLedger.js";

const ctx = inject(PREVIEW_CTX, null);

/** §4.3 (frozen): only the windows face renders. A plain handle/fake ⇒ nothing at all. */
const face = computed(() => (ctx === null ? null : asWindowsHandle(ctx.handle)));
const windows = computed(() => face.value?.windows.value ?? []);
const order = computed(() => face.value?.order.value ?? []);
const activeId = computed(() => face.value?.activeId.value ?? null);
const focusRequest = computed(() => face.value?.focusRequest.value ?? null);
const hasWindows = computed(() => windows.value.length > 0);

// `pwh_hide_plaintext_warn` (browser pref, hidden by default) gates the §5.2 standing warning.
const warn = usePlaintextWarning({ storage: browserLocalStorage() });
const showPlainWarning = computed(() => warn.warnVisible(ctx?.plaintext === true));

/** §6: the ≥768px desktop band (modeless floating windows ⇄ phone fullscreen stack). */
const media = useMedia(window, "(min-width: 768px)");
const desktop = computed(() => media.matches.value);

/** Bottom edge of the top bar in viewport px — the clamp box starts here (ask-float's rule). */
function topOffset(): number {
  const el = document.querySelector("header.topbar");
  if (el === null) return 0;
  const r = el.getBoundingClientRect();
  return Number.isFinite(r.bottom) ? Math.max(0, r.bottom) : 0;
}

const layout = usePreviewWindowLayout({
  desktop,
  doc: document,
  win: window,
  topOffset,
});

/** §7.2: the eight resize hot zones (desktop only, `aria-hidden` — §5.5's keyboard
 *  equivalents live on the title bar and in the window menu). */
const RZ_DIRS: readonly PreviewResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

// --- focus bookkeeping (§5.4/§6.2) -----------------------------------------------------------

const rootEl = ref<HTMLElement | null>(null);
const sectionEls = new Map<number, HTMLElement>();
const lastFocus = new Map<number, Element>();
/** The window that currently holds (or last held) focus — drives the close-time return. */
let focusedWin: number | null = null;
/** The last element focused OUTSIDE the windows (r2 复审: ANY outside focusin refreshes it). */
let pageFocus: HTMLElement | null = null;

function setSectionRef(id: number, el: unknown): void {
  if (el instanceof HTMLElement) sectionEls.set(id, el);
  else sectionEls.delete(id);
}

function onWinFocusin(id: number, ev: FocusEvent): void {
  face.value?.focusWindow(id); // §5.4 activation: only reorders, never moves focus
  focusedWin = id;
  if (ev.target instanceof Element) lastFocus.set(id, ev.target);
}

function onDocFocusin(ev: FocusEvent): void {
  // r2 复审处置: ANY focusin landing outside the windows refreshes pageFocus — including
  // while no overlay root exists yet (the pre-open moments are exactly the ones we must
  // remember). An Element target inside the (existing) root is the only skip case.
  const root = rootEl.value;
  if (root !== null && ev.target instanceof Element && root.contains(ev.target)) return;
  if (ev.target instanceof Element) {
    focusedWin = null;
    pageFocus = ev.target instanceof HTMLElement ? ev.target : null;
  }
}
document.addEventListener("focusin", onDocFocusin, true);

/** §5.4 落焦: the window's own last focus target if it survives, else its panel. */
function landFocus(id: number | null): void {
  if (id === null) return;
  const sec = sectionEls.get(id);
  if (sec === undefined) return;
  const lf = lastFocus.get(id);
  if (lf instanceof HTMLElement && sec.contains(lf) && document.contains(lf)) lf.focus();
  else sec.querySelector<HTMLElement>(".preview-panel")?.focus();
}

// §5.4: the manager's DOM-side instruction — land AFTER the (possibly new) node exists.
watch(focusRequest, (req) => {
  if (req === null) return;
  void nextTick().then(() => {
    landFocus(req.id);
  });
});

// Geometry lifecycle (§7.4): cascade every NEW window off the previous ACTIVE one; drop the
// rects of closed windows. flush:"pre" ⇒ the rect exists before the section renders.
watch(
  windows,
  (next, prev) => {
    const prevIds = new Set(prev.map((w) => w.id));
    const newIds = next.filter((w) => !prevIds.has(w.id)).map((w) => w.id);
    if (newIds.length > 0) {
      // the previous ACTIVE window (the order's tail before the new id landed) — lib ES2022
      // has no findLast, hence the manual tail walk.
      let anchor: number | null = null;
      for (let i = order.value.length - 1; i >= 0; i--) {
        const x = order.value[i]!;
        if (!newIds.includes(x)) {
          anchor = x;
          break;
        }
      }
      for (const id of newIds) layout.ensureRect(id, anchor);
    }
    const nextIds = new Set(next.map((w) => w.id));
    for (const w of prev) if (!nextIds.has(w.id)) layout.dropRect(w.id);
  },
  { flush: "pre" },
);

// Focus return (§5.4 关闭): the closed window had focus ⇒ land on the new active window;
// the LAST window (or 全部关闭) ⇒ return to pageFocus if it still exists.
watch(
  windows,
  (next, prev) => {
    const removed = prev.filter((w) => !next.some((n) => n.id === w.id));
    if (removed.length === 0) return;
    if (next.length === 0) {
      const target = pageFocus;
      pageFocus = null;
      if (target !== null && document.contains(target)) target.focus();
      return;
    }
    if (focusedWin !== null && removed.some((w) => w.id === focusedWin)) {
      landFocus(activeId.value);
    }
  },
  { flush: "post" },
);

// --- W3 wire-in (§8.2 + §5.6): the html-cap ledger + the conversation⇄window switcher -------------

// §8.2: ONE tab-local ledger for EVERY window's PreviewHtml (the hub's per-principal 8-cap
// FIFO simulation — drives the 「可能已被挤掉」 role=status notice and the standing 重新加载
// as its deterministic recovery entry). PreviewHtml injects it optionally; a mount that never
// receives it keeps byte-identical pre-W3 behavior.
provide(PREVIEW_HTML_LEDGER, createPreviewHtmlLedger());

// §5.6: Ctrl+` / Ctrl+Shift+` (拍板 3). The face object is stable for this host's lifetime —
// `ctx.handle` is captured once at mount (App's single `usePreviewWindows` handle) — so the
// composable is armed exactly once, guards included. `pageFocus` here is a plain variable
// (NOT a ref), so the §5.4 page restore target crosses as a GETTER, read per landing.
const cycleFace = face.value;
if (cycleFace !== null) {
  usePreviewWindowCycle({ face: cycleFace, pageFocus: () => pageFocus });
}

// --- phone fullscreen stack (§6): scroll lock + top-window focus + the Tab trap --------------

let releaseScrollLock: (() => void) | null = null;

watch(
  [hasWindows, desktop],
  ([has, desk]) => {
    const need = has && !desk;
    if (need && releaseScrollLock === null) releaseScrollLock = acquireBodyScrollLock();
    else if (!need && releaseScrollLock !== null) {
      releaseScrollLock();
      releaseScrollLock = null;
    }
  },
  { immediate: true },
);

// §6.3 desktop→phone: if focus is not already inside the top window, land it there (the
// gesture end + rect re-clamp halves live in the layout controller's own desktop watch).
watch(desktop, (desk) => {
  if (!desk && hasWindows.value) {
    const top = activeId.value;
    if (top !== null) {
      const sec = sectionEls.get(top);
      const active = document.activeElement;
      if (sec === undefined || active === null || !sec.contains(active)) landFocus(top);
    }
  }
});

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** §6.2 (评审 #4): the trap's universe is the TOP window only, with `[inert]`,
 *  `[aria-hidden="true"]` and `[hidden]` subtrees explicitly filtered out (no layout reads —
 *  holds in happy-dom too). */
function focusablesIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.closest("[inert],[aria-hidden='true'],[hidden]") === null,
  );
}

function trapTab(ev: KeyboardEvent): void {
  const top = activeId.value;
  const sec = top === null ? undefined : sectionEls.get(top);
  if (sec === undefined) return;
  const items = focusablesIn(sec);
  const active = document.activeElement;
  if (items.length === 0) {
    ev.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const outside = active === null || !sec.contains(active);
  if (ev.shiftKey && (outside || active === first || active === sec.querySelector(".preview-panel"))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (outside || active === last)) {
    ev.preventDefault();
    first.focus();
  }
}

/** §5.5 Esc: close exactly the window containing the event target — and ONLY then eat the
 *  event (preventDefault + stopPropagation so DashboardView's Esc never also fires). Focus
 *  on the page (outside every window) leaves the key to the page. */
function onRootKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Tab" && !desktop.value) {
    trapTab(ev);
    return;
  }
  if (ev.key !== "Escape" || ev.defaultPrevented || ev.isComposing) return;
  const target = ev.target;
  const sec = target instanceof Element ? target.closest(".preview-window") : null;
  if (sec === null) return;
  const idAttr = sec.getAttribute("data-pw-id");
  if (idAttr === null) return;
  const id = Number(idAttr);
  if (!desktop.value && id !== activeId.value) return; // phone: only the TOP window closes
  ev.preventDefault();
  ev.stopPropagation();
  face.value?.closeWindow(id);
}

// --- resize hot zones (§7.2) -------------------------------------------------------------------

function onRzPointerdown(ev: PointerEvent, id: number, dir: PreviewResizeDir): void {
  const el = ev.currentTarget;
  if (el instanceof HTMLElement) layout.beginGesture(ev, id, dir, el);
}

function zOf(id: number): string {
  return String(1 + Math.max(0, order.value.indexOf(id)));
}

/** Desktop geometry: CSS variables ONLY, through Vue's OBJECT `:style` binding (§7.1 CSP —
 *  runtime CSSOM via style.setProperty, never a static style attribute). */
function geomVars(id: number): Record<string, string> {
  return { ...layout.varsOf(id), "--pw-z": zOf(id) };
}

onUnmounted(() => {
  document.removeEventListener("focusin", onDocFocusin, true);
  releaseScrollLock?.(); // 滚动锁一定会清理 — even mid-preview unmount
  releaseScrollLock = null;
  layout.dispose();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="hasWindows"
      ref="rootEl"
      class="preview-overlay is-windows"
      :class="{ 'is-modeless': desktop }"
      @keydown="onRootKeydown"
    >
      <section
        v-for="(w, i) in windows"
        :key="w.id"
        class="preview-window"
        :class="{
          'is-floating': desktop,
          'is-active': w.id === activeId,
          'is-maximized': desktop && layout.isMaximized(w.id),
        }"
        :data-pw-id="w.id"
        :style="desktop ? geomVars(w.id) : { '--pw-z': zOf(w.id) }"
        :inert="!desktop && w.id !== activeId"
        :ref="(el) => setSectionRef(w.id, el)"
        @pointerdown.capture="face?.focusWindow(w.id)"
        @focusin="onWinFocusin(w.id, $event)"
      >
        <PreviewWindow
          :win="w"
          :face="face!"
          :desktop="desktop"
          :is-top="w.id === activeId"
          :index="i"
          :count="windows.length"
          :plaintext="ctx?.plaintext === true"
          :show-plain-warning="showPlainWarning"
          :layout="layout"
          @close="face?.closeWindow($event)"
          @close-all="face?.closeAll()"
          @reset="layout.resetRect($event)"
          @select="face?.focusWindow($event, { moveFocus: true })"
        />
        <!-- Maximized (2026-10-22 L1): the hot zones are dropped from the DOM entirely — no
             dead hit areas; `beginGesture` refuses them belt-and-braces on top. -->
        <template v-if="desktop && !layout.isMaximized(w.id)"
          ><div
            v-for="d in RZ_DIRS"
            :key="d"
            class="pw-rz"
            :data-dir="d"
            aria-hidden="true"
            @pointerdown="onRzPointerdown($event, w.id, d)"
        /></template>
      </section>
    </div>
  </Teleport>
</template>
