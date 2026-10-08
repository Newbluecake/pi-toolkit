<!--
  Preview overlay host (web-hub-preview plan v3 §4.6, package PV5). Teleports to `<body>` and
  renders PV4's `usePreview` state machine (`PREVIEW_CTX` — provided by PV6's App wiring;
  absent ⇒ nothing renders): loading / image / text / unsupported / tooLarge / error, with the
  header's basename + full path + close button and the §5.2 plaintext-transport standing
  warning.

  Interaction contract (§4.6):
  - scrim click closes (`@click.self` — clicks INSIDE the panel never reach it);
  - Esc closes with `preventDefault()` + `stopPropagation()` (a global Esc handler must not
    also fire — e.g. a drawer closing underneath);
  - focus ENTERS the panel on open, Tab/Shift+Tab CYCLE inside it, and focus RETURNS to the
    previously focused element on close;
  - body scroll is locked while open and ALWAYS restored (close path AND unmount path).
-->
<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from "vue";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { PreviewView } from "../../types.js";
import CopyButton from "../detail/CopyButton.vue";
import PreviewImage from "./PreviewImage.vue";
import PreviewText from "./PreviewText.vue";
import { PREVIEW_CTX } from "./previewContext.js";

const ctx = inject(PREVIEW_CTX, null);
const { t } = useI18n();

const view = computed<PreviewView>(() => ctx?.handle.view.value ?? { phase: "closed" });
const isOpen = computed(() => view.value.phase !== "closed");
const path = computed(() => ("path" in view.value ? view.value.path : ""));
const basename = computed(() => {
  const p = path.value;
  const slash = p.lastIndexOf("/");
  return slash >= 0 && slash < p.length - 1 ? p.slice(slash + 1) : p;
});

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
        role="dialog"
        aria-modal="true"
        :aria-label="t('preview.dialogLabel')"
        tabindex="-1"
      >
        <header class="preview-header">
          <AppIcon name="file" class="icon-sm preview-header-icon" />
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
        <p v-if="ctx?.plaintext === true" class="preview-plaintext" role="note">
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
