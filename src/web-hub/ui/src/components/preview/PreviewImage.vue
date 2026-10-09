<!--
  Image phase of the preview overlay (web-hub-preview plan v3 §4.6, package PV5; 2026-10
  attachment-preview: minimal zoom added — benefits every image preview, not just the tray).
  Only a `data:` URL ever reaches `<img src>` — D1: CSP is not relaxed, so a host bug passing
  a `blob:`/remote URL renders NOTHING rather than smuggling a request past the policy (the
  `usePreview` state machine already verified the `data:<mime>;base64,` prefix; this is the
  component-level backstop). No `createObjectURL` anywhere (source-scan banned, HP8).

  Zoom model (attachment-preview feature spec): fit-to-window ⇄ actual size, plus
  - `+` / `−` buttons stepping the actual-size scale by 1.25× (clamped 100%–400%); `−` at
    100% falls back to fit, `+` from fit enters actual — the buttons and the toggle are two
    views of one state, never conflicting;
  - click/tap on the image toggles fit ⇄ actual (a pointerdown→pointerup pair that moved
    less than 5px counts as a click; anything more is a drag, never a toggle);
  - drag-to-pan while the actual-size image overflows the viewport (pointer capture, pan
    clamped to the overflow so the image can never be dragged fully off-screen; pan resets
    on every mode/scale change so a stale offset never survives a zoom step);
  - keyboard: the image is a focusable `role="button"` (Enter/Space toggles fit) and arrow
    keys pan by 40px — zoom/pan is fully reachable without a pointer.

  `dims` is optional since 2026-10 (the tray viewer has no hub-computed dims): when absent,
  the meta line picks the image's natural dimensions up from its `load` event. Scheduling
  stays event-driven (pointer/keyboard handlers mutate reactive state directly) — no rAF
  (`renderGate.ts` owns scheduling; `requestAnimationFrame` is source-scan banned).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { PreviewDims } from "@protocol/preview.js";
import { useI18n } from "../../composables/useI18n.js";

const props = defineProps<{
  readonly dataUrl: string;
  readonly dims?: PreviewDims | undefined;
  readonly sizeLabel?: string | undefined;
  readonly alt?: string | undefined;
}>();
const { t } = useI18n();

/** D1 backstop: only `data:image/` sources render (see the header comment). */
const safe = computed(() => props.dataUrl.startsWith("data:image/"));

// --- zoom state -------------------------------------------------------------
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
/** Pointer travel (CSS px) below which a press-release counts as a click, not a drag. */
const DRAG_THRESHOLD = 5;
/** Arrow-key pan step (CSS px). */
const KEY_PAN_STEP = 40;

const fit = ref(true);
const scale = ref(1);
const pan = ref({ x: 0, y: 0 });
const dragging = ref(false);
const percent = computed(() => `${Math.round(scale.value * 100)}%`);
const canZoomIn = computed(() => fit.value || scale.value < ZOOM_MAX);
const canZoomOut = computed(() => !fit.value);

/** `<img>`/body refs for pan clamping (visual rects — transform included). */
const bodyEl = ref<HTMLElement | null>(null);
const imgEl = ref<HTMLElement | null>(null);

/** Natural dims picked up from the img `load` event when the `dims` prop is absent. */
const naturalDims = ref<{ w: number; h: number } | null>(null);
const shownDims = computed(() => props.dims ?? naturalDims.value);
const metaLine = computed(() => {
  const parts: string[] = [];
  const d = shownDims.value;
  if (d !== undefined && d !== null) parts.push(`${d.w} × ${d.h}`);
  if (props.sizeLabel !== undefined && props.sizeLabel !== "") parts.push(props.sizeLabel);
  if (!fit.value) parts.push(percent.value);
  return parts.join("  ·  ");
});

function resetPan(): void {
  pan.value = { x: 0, y: 0 };
  dragging.value = false;
}

function toggleFit(): void {
  fit.value = !fit.value;
  resetPan();
}

function zoomIn(): void {
  if (!canZoomIn.value) return;
  if (fit.value) {
    fit.value = false; // enter actual at the current scale (100% initially)
    resetPan();
    return;
  }
  scale.value = Math.min(ZOOM_MAX, Math.round(scale.value * ZOOM_STEP * 100) / 100);
  resetPan();
}

function zoomOut(): void {
  if (fit.value) return;
  if (scale.value <= 1) {
    fit.value = true; // − at 100% is the inverse of + from fit
    resetPan();
    return;
  }
  scale.value = Math.max(1, Math.round((scale.value / ZOOM_STEP) * 100) / 100);
  resetPan();
}

// --- pan (actual mode only; clamped to the overflow so the image stays on screen) ---
function panBounds(): { dx: number; dy: number } {
  const body = bodyEl.value;
  const img = imgEl.value;
  if (body === null || img === null) return { dx: 0, dy: 0 };
  const b = body.getBoundingClientRect();
  const r = img.getBoundingClientRect();
  return { dx: Math.max(0, (r.width - b.width) / 2), dy: Math.max(0, (r.height - b.height) / 2) };
}

function clampPan(x: number, y: number): { x: number; y: number } {
  const { dx, dy } = panBounds();
  return { x: Math.min(dx, Math.max(-dx, x)), y: Math.min(dy, Math.max(-dy, y)) };
}

interface DragStart {
  px: number;
  py: number;
  x: number;
  y: number;
  bounds: { dx: number; dy: number };
  moved: boolean;
}
let dragStart: DragStart | null = null;

function onPointerDown(ev: PointerEvent): void {
  if (typeof ev.button === "number" && ev.button !== 0) return; // primary pointer only
  dragStart = { px: ev.clientX, py: ev.clientY, x: pan.value.x, y: pan.value.y, bounds: panBounds(), moved: false };
  if (!fit.value) {
    dragging.value = true;
    const el = ev.currentTarget as HTMLElement | null;
    if (el !== null && typeof el.setPointerCapture === "function") {
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        // capture is best-effort — the move handlers work without it, just less reliably
      }
    }
  }
}

function onPointerMove(ev: PointerEvent): void {
  const s = dragStart;
  if (s === null) return;
  const dx = ev.clientX - s.px;
  const dy = ev.clientY - s.py;
  if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) s.moved = true;
  // pan only in actual mode, and only once past the click threshold
  if (fit.value || !s.moved) return;
  const b = s.bounds;
  pan.value = { x: Math.min(b.dx, Math.max(-b.dx, s.x + dx)), y: Math.min(b.dy, Math.max(-b.dy, s.y + dy)) };
}

function onPointerUp(): void {
  const s = dragStart;
  dragStart = null;
  dragging.value = false;
  if (s !== null && !s.moved) toggleFit(); // click/tap ⇄ toggle
}

function onPointerCancel(): void {
  dragStart = null;
  dragging.value = false;
}

function onImgKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    toggleFit();
    return;
  }
  let dx = 0;
  let dy = 0;
  if (ev.key === "ArrowLeft") dx = -KEY_PAN_STEP;
  else if (ev.key === "ArrowRight") dx = KEY_PAN_STEP;
  else if (ev.key === "ArrowUp") dy = -KEY_PAN_STEP;
  else if (ev.key === "ArrowDown") dy = KEY_PAN_STEP;
  else return;
  ev.preventDefault();
  if (fit.value) return;
  pan.value = clampPan(pan.value.x + dx, pan.value.y + dy);
}

function onImgLoad(ev: Event): void {
  if (props.dims !== undefined) return;
  const img = ev.target as HTMLImageElement | null;
  const w = img?.naturalWidth ?? 0;
  const h = img?.naturalHeight ?? 0;
  if (w > 0 && h > 0) naturalDims.value = { w, h };
}
</script>

<template>
  <div v-if="safe" class="preview-image">
    <div class="preview-image-toolbar">
      <span class="preview-meta" translate="no">{{ metaLine }}</span>
      <span class="preview-image-tools">
        <button
          type="button"
          class="btn btn-ghost preview-zoom-btn"
          :disabled="!canZoomOut"
          :aria-label="t('preview.zoomOut')"
          :title="t('preview.zoomOut')"
          @click="zoomOut"
        >
          −
        </button>
        <span v-if="!fit" class="preview-zoom-pct" translate="no">{{ percent }}</span>
        <button
          type="button"
          class="btn btn-ghost preview-zoom-btn"
          :disabled="!canZoomIn"
          :aria-label="t('preview.zoomIn')"
          :title="t('preview.zoomIn')"
          @click="zoomIn"
        >
          +
        </button>
        <button class="btn btn-ghost preview-image-toggle" type="button" @click="toggleFit">
          {{ fit ? t("preview.actualSize") : t("preview.fit") }}
        </button>
      </span>
    </div>
    <div ref="bodyEl" class="preview-image-body" :class="{ actual: !fit }">
      <img
        ref="imgEl"
        :src="dataUrl"
        :alt="alt ?? ''"
        :class="{ fit, 'is-dragging': dragging }"
        :style="!fit ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` } : undefined"
        :aria-label="fit ? t('preview.actualSize') : t('preview.fit')"
        tabindex="0"
        role="button"
        draggable="false"
        @load="onImgLoad"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @keydown="onImgKeydown"
      />
    </div>
  </div>
</template>
