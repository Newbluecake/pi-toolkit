<!--
  Attachment image viewer dialog (2026-10 attachment-preview: 「通过输入框上传的图片支持
  预览（不点击发送的情况下，并且支持放大）」) — the zoomable host for a PRE-SEND tray image.
  Fed entirely from the LOCAL file (any tray state — the hub round trip would add a preview
  scope/caps dependency the composer tray doesn't need); the pixels arrive as one transient
  `data:` URL from `useAttachmentPreview` (D1: no `blob:`, CSP untouched).

  The component is mount-on-open (the parent renders it `v-if="viewer !== null"`), so open IS
  mount and close IS unmount. It reuses the preview overlay's classes and PreviewHost's
  interaction contract (§4.6): scrim click closes, Esc closes with preventDefault +
  stopPropagation, focus enters the panel / Tab cycles inside / returns to the opener on
  close, body scroll is locked while open and ALWAYS restored (close and unmount paths).
  The zoomable image itself is the SAME `PreviewImage.vue` the hub preview dialog uses — one
  viewer component with zoom, per the feature spec.
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, nextTick } from "vue";
import { formatAttachmentSize } from "@protocol/upload.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import { useI18n } from "../../composables/useI18n.js";
import { ATTACH_PREVIEW_MAX_BYTES, type AttachmentViewerState } from "../../composables/useAttachmentPreview.js";
import AppIcon from "../../icons/AppIcon.vue";
import PreviewImage from "../preview/PreviewImage.vue";

const props = defineProps<{ readonly viewer: AttachmentViewerState }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const sizeLabel = formatAttachmentSize(Number.isFinite(props.viewer.size) ? props.viewer.size : 0);
const maxLabel = formatAttachmentSize(ATTACH_PREVIEW_MAX_BYTES);

function close(): void {
  emit("close");
}

// --- focus management + scroll lock (PreviewHost §4.6 contract, mount/unmount variant) ---
const panelEl = ref<HTMLElement | null>(null);
let returnFocus: Element | null = null;
let releaseScrollLock: (() => void) | null = null;

onMounted(async () => {
  returnFocus = document.activeElement;
  releaseScrollLock = acquireBodyScrollLock();
  await nextTick();
  panelEl.value?.focus();
});

onUnmounted(() => {
  releaseScrollLock?.(); // idempotent — always restored
  releaseScrollLock = null;
  const target = returnFocus;
  returnFocus = null;
  if (target instanceof HTMLElement && document.contains(target)) target.focus();
});

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
    ev.preventDefault();
    ev.stopPropagation(); // the overlay owns Esc while open
    close();
    return;
  }
  if (ev.key === "Tab") trapTab(ev);
}
</script>

<template>
  <Teleport to="body">
    <div class="preview-overlay" @click.self="close" @keydown="onKeydown">
      <div
        ref="panelEl"
        class="preview-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('upload.previewDialogLabel')"
        tabindex="-1"
      >
        <header class="preview-header">
          <AppIcon name="image" class="icon-sm preview-header-icon" />
          <span class="preview-title" translate="no">{{ viewer.name }}</span>
          <span class="preview-path" translate="no">{{ sizeLabel }}</span>
          <button
            class="btn btn-ghost btn-icon preview-close"
            type="button"
            :aria-label="t('preview.close')"
            @click="close"
          >
            <AppIcon name="x" />
          </button>
        </header>
        <div class="preview-body">
          <div v-if="viewer.phase === 'loading'" class="preview-loading" role="status">
            <AppIcon name="loader" class="preview-spinner" />
            <span>{{ t("preview.loading") }}</span>
          </div>
          <PreviewImage
            v-else-if="viewer.phase === 'ready'"
            :data-url="viewer.dataUrl"
            :size-label="sizeLabel"
            :alt="viewer.name"
          />
          <div v-else-if="viewer.phase === 'tooLarge'" class="preview-note">
            <AppIcon name="alert" class="preview-note-icon" />
            <h3 class="preview-note-title">{{ t("preview.tooLargeTitle") }}</h3>
            <p translate="no">{{ t("preview.tooLargeBytes", { size: sizeLabel, max: maxLabel }) }}</p>
          </div>
          <div v-else class="preview-note">
            <AppIcon name="alert" class="preview-note-icon" />
            <h3 class="preview-note-title">{{ t("upload.previewUnavailableTitle") }}</h3>
            <p>{{ t("upload.previewUnavailableBody") }}</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
