<!--
  Preview overlay host (web-hub-preview plan v3 §4.6, package PV5; dir-plan v3.1 §0.2 A3/§5
  P3): Teleports to `<body>` and renders `usePreview`'s state machine (`PREVIEW_CTX` — provided
  by PV6's App wiring; absent ⇒ nothing renders): loading / image / text / dir / unsupported /
  tooLarge / error, with the header's basename + full path + close button and the §5.2
  plaintext-transport standing warning (hideable via the explicit `pwh_hide_plaintext_warn`
  browser opt-out, like every plaintext warning).

  Interaction contract (§4.6):
  - scrim click closes (`@click.self` — clicks INSIDE the panel never reach it);
  - Esc closes with `preventDefault()` + `stopPropagation()` (a global Esc handler must not
    also fire — e.g. a drawer closing underneath);
  - focus ENTERS the panel on open, Tab/Shift+Tab CYCLE inside it, and focus RETURNS to the
    previously focused element on close;
  - body scroll is locked while open and ALWAYS restored (close path AND unmount path).

  dir-plan §0.2 A3 (P3): when the injected handle carries the navigation face
  (`asDirHandle` — `usePreview`'s P3 return), the header grows 返回 (pop the in-dialog history
  stack; disabled at its bottom) and, in the dir phase, 上级 (`parentPreviewPath`; disabled at
  one-segment paths — `/` is not listable). The whole host subtree gets `PREVIEW_CTX`
  re-provided with `open` mapped to `navigate`, so path refs rendered INSIDE the open dialog
  (B6: a rendered md's PathText segments) drill down — push + 返回-able — instead of
  restarting the visit. A handle without the face (pre-P3 fakes) keeps open-only navigation:
  no nav buttons, no dir branch, byte-identical to pre-P3 DOM.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, provide, ref, watch } from "vue";
import { childPreviewPath, parentPreviewPath } from "@logic/preview.js";
import type { PreviewDirEntry } from "@protocol/preview.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import { useI18n } from "../../composables/useI18n.js";
import { usePlaintextWarning } from "../../composables/usePlaintextWarning.js";
import { asDirHandle, type PreviewHandleDir, type PreviewViewDir } from "../../composables/usePreview.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { PreviewView } from "../../types.js";
import CopyButton from "../detail/CopyButton.vue";
import PreviewDir from "./PreviewDir.vue";
import PreviewImage from "./PreviewImage.vue";
import PreviewText from "./PreviewText.vue";
import { browserLocalStorage } from "../shell/themeStorage.js";
import { PREVIEW_CTX } from "./previewContext.js";

const ctx = inject(PREVIEW_CTX, null);
const { t } = useI18n();

// `pwh_hide_plaintext_warn` (explicit browser opt-out) gates the §5.2 standing warning.
const warn = usePlaintextWarning({ storage: browserLocalStorage() });
const showPlainWarning = computed(() => warn.warnVisible(ctx?.plaintext === true));

/** A3/P3: the navigation face — `null` for a pre-P3 handle/fake (open-only degradation). */
const nav = computed<PreviewHandleDir | null>(() => (ctx === null ? null : asDirHandle(ctx.handle)));

const view = computed<PreviewViewDir>(() =>
  nav.value !== null ? nav.value.view.value : ((ctx?.handle.view.value ?? { phase: "closed" }) as PreviewView),
);
const isOpen = computed(() => view.value.phase !== "closed");
const path = computed(() => ("path" in view.value ? view.value.path : ""));
const basename = computed(() => {
  const p = path.value;
  const slash = p.lastIndexOf("/");
  return slash >= 0 && slash < p.length - 1 ? p.slice(slash + 1) : p;
});
const isDirPhase = computed(() => view.value.phase === "dir");
/** Once a directory listing has been shown in this open, the panel keeps its full height
 * (2026-10-08 field report: browsing from a long listing to a short one — or through the
 * loading phase in between — shrank the vertically-centered panel and made the header buttons
 * jump under the cursor). Reset whenever the dialog closes. */
const holdTall = ref(false);
watch(
  () => view.value.phase,
  (phase) => {
    if (phase === "dir") holdTall.value = true;
    else if (phase === "closed") holdTall.value = false;
  },
  { immediate: true },
);
const backDisabled = computed(() => nav.value === null || nav.value.stackDepth.value === 0);
const upDisabled = computed(() => parentPreviewPath(path.value) === null);

// §4.1/P3 (B6): the dialog's subtree re-provides PREVIEW_CTX with `open` mapped to
// `navigate` — an in-dialog path ref click drills down (history push) instead of restarting
// the visit. The injected `ctx` itself stays untouched for anything above this host; the
// override only exists when the parent wiring provided a context at all.
if (ctx !== null) {
  const outer = ctx;
  provide(PREVIEW_CTX, {
    plaintext: outer.plaintext,
    handle: {
      ...outer.handle,
      open(ref: { readonly path: string }) {
        const d = nav.value;
        if (d !== null) d.navigate(ref);
        else outer.handle.open(ref);
      },
    },
  });
}

function back(): void {
  nav.value?.back();
}

function up(): void {
  nav.value?.up();
}

/** A3 “点子项”: join the row's name onto the listed dir; the join's legality
 * (`childPreviewPath`) is re-checked here — a bad row never fires a request. A `dir` row
 * requests the listing directly (`dir:true`); a symlink row leaves the decision to the
 * admission chain (the 415 fallback upgrades it to a listing if it is a directory). */
function onDirEntry(entry: PreviewDirEntry): void {
  const d = nav.value;
  if (d === null || view.value.phase !== "dir") return;
  const child = childPreviewPath(view.value.path, entry.name);
  if (child === null) return;
  const ref: { readonly path: string; readonly dir?: true } =
    entry.type === "dir" ? { path: child, dir: true } : { path: child };
  d.navigate(ref);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const unsupportedReason = computed(() => {
  if (view.value.phase !== "unsupported") return "";
  switch (view.value.reason) {
    case "binary":
      return t("preview.reasonBinary");
    case "not-regular":
      return t("preview.reasonNotRegular");
    case "dims-unknown":
      return t("preview.reasonDimsUnknown");
    default:
      return t("preview.reasonGeneric");
  }
});

function close(): void {
  ctx?.handle.close();
}

// --- focus management + scroll lock (§4.6: 焦点进入、循环、归还；滚动锁一定会清理) ---
const panelEl = ref<HTMLElement | null>(null);
let returnFocus: Element | null = null;
// Shared ref-counted lock (useScrollLock.ts — verify:model-switch-M3b): composes with
// PickerSheet's lock when overlays stack; only the LAST release restores the overflow.
let releaseScrollLock: (() => void) | null = null;

function restoreScroll(): void {
  releaseScrollLock?.(); // idempotent
  releaseScrollLock = null;
}

watch(
  isOpen,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement;
      releaseScrollLock = acquireBodyScrollLock();
      await nextTick();
      panelEl.value?.focus();
      return;
    }
    restoreScroll();
    const target = returnFocus;
    returnFocus = null;
    if (target instanceof HTMLElement && document.contains(target)) target.focus();
  },
  { immediate: true }, // a host mounted with an already-open view locks/focuses too
);

onUnmounted(restoreScroll); // 滚动锁一定会清理 — even if the host unmounts mid-preview

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(ev: KeyboardEvent): void {
  const panel = panelEl.value;
  if (panel === null) return;
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
    // §4.6: preventDefault + stopPropagation — the overlay owns Esc while open.
    ev.preventDefault();
    ev.stopPropagation();
    close();
    return;
  }
  if (ev.key === "Tab") trapTab(ev);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="preview-overlay" @click.self="close" @keydown="onKeydown">
      <div
        ref="panelEl"
        class="preview-panel"
        :class="{ 'is-hold-tall': holdTall }"
        role="dialog"
        aria-modal="true"
        :aria-label="t('preview.dialogLabel')"
        tabindex="-1"
      >
        <header class="preview-header">
          <!-- A3/P3: 返回 (history pop, disabled at the bottom) — present whenever the handle
               carries the navigation face; 上级 joins only in the dir phase, disabled at
               one-segment paths (`/` is not listable). Native buttons: keyboard-reachable,
               part of the panel's Tab cycle. -->
          <nav v-if="nav !== null" class="preview-nav" :aria-label="t('preview.dirNavLabel')">
            <button
              class="btn btn-ghost btn-icon preview-nav-btn"
              type="button"
              :disabled="backDisabled"
              :aria-label="t('preview.dirBack')"
              :title="t('preview.dirBack')"
              @click="back"
            >
              <AppIcon name="chev-left" />
            </button>
            <button
              v-if="isDirPhase"
              class="btn btn-ghost btn-icon preview-nav-btn"
              type="button"
              :disabled="upDisabled"
              :aria-label="t('preview.dirUp')"
              :title="t('preview.dirUp')"
              @click="up"
            >
              <AppIcon name="arrow-up" />
            </button>
          </nav>
          <AppIcon :name="isDirPhase ? 'folder' : 'file'" class="icon-sm preview-header-icon" />
          <span class="preview-title" translate="no">{{ basename }}</span>
          <!-- `<bdi dir="ltr">` isolates the path from `.preview-path`'s `direction: rtl`
               front-ellipsis trick: without it the Unicode bidi algorithm reorders the
               absolute path's LEADING "/" to the visual end (user field report 2026-10-08:
               the header showed "…Tf4uhhFX.png/"). The stored/requested path is unaffected. -->
          <span class="preview-path" :title="path" translate="no"
            ><bdi dir="ltr">{{ path }}</bdi></span
          >
          <button
            class="btn btn-ghost btn-icon preview-close"
            type="button"
            :aria-label="t('preview.close')"
            @click="close"
          >
            <AppIcon name="x" />
          </button>
        </header>
        <p v-if="showPlainWarning" class="preview-plaintext" role="note">
          <AppIcon name="unlock" class="icon-sm" />
          <span>{{ t("preview.plaintextWarning") }}</span>
        </p>
        <div class="preview-body">
          <div v-if="view.phase === 'loading'" class="preview-loading" role="status">
            <AppIcon name="loader" class="preview-spinner" />
            <span>{{ t("preview.loading") }}</span>
          </div>
          <PreviewImage
            v-else-if="view.phase === 'image'"
            :data-url="view.dataUrl"
            :dims="view.dims"
            :size-label="formatBytes(view.size)"
            :alt="basename"
          />
          <!-- PM (dir-plan §4.1 B4): `:key` remounts PreviewText on every path change — the
               rendered/source mode resets per freshly opened file; a same-path retry keeps it. -->
          <PreviewText
            v-else-if="view.phase === 'text'"
            :key="view.path"
            :text="view.text"
            :truncated="view.truncated"
            :size-label="formatBytes(view.size)"
            :filename="basename"
            :path="path"
          />
          <!-- A3/P3: the listing — rendered only with the navigation face (a frozen fake can
               never produce a dir phase; the guard keeps the branch total anyway). -->
          <PreviewDir
            v-else-if="view.phase === 'dir' && nav !== null"
            :key="view.path"
            :path="view.path"
            :listing="view.listing"
            @navigate="onDirEntry"
          />
          <div v-else-if="view.phase === 'unsupported'" class="preview-note">
            <AppIcon name="ban" class="preview-note-icon" />
            <h3 class="preview-note-title">{{ t("preview.unsupportedTitle") }}</h3>
            <p>{{ t("preview.unsupportedBody", { reason: unsupportedReason }) }}</p>
            <p v-if="view.size !== undefined" class="preview-meta">
              {{ t("preview.fileSize", { size: formatBytes(view.size) }) }}
            </p>
          </div>
          <div v-else-if="view.phase === 'tooLarge'" class="preview-note">
            <AppIcon name="alert" class="preview-note-icon" />
            <h3 class="preview-note-title">{{ t("preview.tooLargeTitle") }}</h3>
            <p v-if="view.dims !== undefined" translate="no">
              {{ t("preview.tooLargePixels", { w: view.dims.w, h: view.dims.h }) }}
            </p>
            <p v-else-if="view.size !== undefined && view.max !== undefined" translate="no">
              {{ t("preview.tooLargeBytes", { size: formatBytes(view.size), max: formatBytes(view.max) }) }}
            </p>
            <p v-else>{{ t("preview.tooLargeGeneric") }}</p>
            <p class="preview-copy-path">
              <code class="md-code" translate="no">{{ path }}</code>
              <CopyButton :value="path" :label="t('preview.copyPath')" />
            </p>
          </div>
          <div v-else-if="view.phase === 'error'" class="preview-note">
            <AppIcon name="alert" class="preview-note-icon" />
            <h3 class="preview-note-title">{{ t("preview.errorTitle") }}</h3>
            <p translate="no">{{ view.error }}</p>
            <p v-if="view.retryAfterS !== undefined" class="preview-meta">
              {{ t("preview.retryAfter", { n: view.retryAfterS }) }}
            </p>
            <button v-if="view.retryable" class="btn preview-retry" type="button" @click="ctx?.handle.retry()">
              <AppIcon name="refresh" class="icon-sm" />
              <span>{{ t("preview.retry") }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
