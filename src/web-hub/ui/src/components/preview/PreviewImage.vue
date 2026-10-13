<!--
  Image phase of the preview overlay (web-hub-preview plan v3 §4.6, package PV5; 2026-10
  attachment-preview: minimal zoom added — benefits every image preview, not just the tray;
  2026-10 zoom-enhance: wheel zoom + 50% floor + fullscreen).
  Only a `data:` URL ever reaches `<img src>` — D1: CSP is not relaxed, so a host bug passing
  a `blob:`/remote URL renders NOTHING rather than smuggling a request past the policy (the
  `usePreview` state machine already verified the `data:<mime>;base64,` prefix; this is the
  component-level backstop). No `createObjectURL` anywhere (source-scan banned, HP8).

  Zoom model (attachment-preview spec + 2026-10 zoom-enhance): fit-to-window ⇄ actual size,
  scale range 50%–400% of natural size (100% = natural), plus
  - `+` / `−` buttons stepping the actual-size scale by 1.25×; `+` from fit enters actual at
    100%, `−` steps below 100% down to the 50% floor — fit itself is only reached through the
    toggle / click / Enter (the buttons and the toggle are two views of one state, never
    conflicting);
  - mouse wheel zooms around the cursor (cursor-centered anchor): the image point under the
    cursor stays under the cursor, stepping smoothly by exp(−deltaY·0.002) (≈×1.22 per
    standard tick, proportional for trackpads/pinch). The first wheel tick while in fit mode
    starts from the CURRENT FIT RATIO (measured displayed ÷ natural), so a large image eases
    out of fit instead of jumping to 100%. Pan is re-clamped against the new scale's overflow
    (same bounds math as drag pan);
  - click/tap on the image toggles fit ⇄ actual (a pointerdown→pointerup pair that moved
    less than 5px counts as a click; anything more is a drag, never a toggle);
  - drag-to-pan while the actual-size image overflows the viewport (pointer capture, pan
    clamped to the overflow so the image can never be dragged fully off-screen; button/toggle
    zoom steps reset the pan so a stale offset never survives a step — wheel zoom instead
    re-anchors it);
  - fullscreen: a toolbar button runs the Fullscreen API on the component root (native Esc
    exits; `fullscreenchange` keeps the button state honest). Browsers without the API simply
    hide the button (degrade); a rejected requestFullscreen leaves the state untouched;
  - keyboard: the image is a focusable `role="button"` (Enter/Space toggles fit), `+`/`=` and
    `-`/`_` zoom like the buttons, and arrow keys pan by 40px — zoom/pan is fully reachable
    without a pointer.

  `dims` is optional since 2026-10 (the tray viewer has no hub-computed dims): when absent,
  the meta line picks the image's natural dimensions up from its `load` event. Scheduling
  stays event-driven (pointer/keyboard/wheel handlers mutate reactive state directly) — no
  rAF (`renderGate.ts` owns scheduling; `requestAnimationFrame` is source-scan banned).
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
/** Wheel zoom speed: scale multiplier per CSS px of deltaY (≈×1.22 per 100px tick). */
const WHEEL_ZOOM_PER_PX = 0.002;
/** deltaMode=1 (lines) → px conversion, per the CSSOM-view convention. */
const WHEEL_LINE_PX = 16;
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
const canZoomOut = computed(() => !fit.value && scale.value > ZOOM_MIN);

/** Root/`<img>`/body refs (fullscreen target; pan clamping — visual rects, transform incl.). */
const rootEl = ref<HTMLElement | null>(null);
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
  if (!canZoomOut.value) return;
  scale.value = Math.max(ZOOM_MIN, Math.round((scale.value / ZOOM_STEP) * 100) / 100);
  resetPan();
}

// --- wheel zoom (cursor-centered; fit eases out from its measured ratio) -----
/**
 * The ratio the image is CURRENTLY displayed at relative to natural size. In actual mode
 * that is `scale`; in fit mode it is measured (displayed width ÷ natural width) so the
 * first wheel tick continues from the on-screen size instead of jumping to 100%.
 */
function effectiveScale(): number | null {
  if (!fit.value) return scale.value;
  const img = imgEl.value;
  const d = shownDims.value;
  if (img === null || d === undefined || d === null || d.w <= 0) return null;
  const w = img.getBoundingClientRect().width; // fit mode: no transform, so this is layout px
  if (w <= 0) return null;
  return w / d.w;
}

function zoomAt(factor: number, cx: number, cy: number): void {
  const s0 = effectiveScale() ?? 1; // unmeasurable (pre-load) → legacy jump from 100%
  const s1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(s0 * factor * 1000) / 1000));
  if (!fit.value && s1 === scale.value) return; // already resting on a bound
  const img = imgEl.value;
  const body = bodyEl.value;
  if (img !== null && body !== null && s0 > 0) {
    // Keep the image point under the cursor fixed: pan' = (cursor−C)·(1−s1/s0) + pan·(s1/s0)
    // with C the image center (flexbox keeps the layout box centered in the body), then
    // re-clamp against the NEW scale's overflow (same bounds math as panBounds()).
    const r = img.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const ratio = s1 / s0;
    const px = (cx - (r.left + r.width / 2)) * (1 - ratio) + pan.value.x * ratio;
    const py = (cy - (r.top + r.height / 2)) * (1 - ratio) + pan.value.y * ratio;
    const layoutW = r.width / s0;
    const layoutH = r.height / s0;
    const dx = Math.max(0, (layoutW * s1 - b.width) / 2);
    const dy = Math.max(0, (layoutH * s1 - b.height) / 2);
    pan.value = {
      x: Math.round(Math.min(dx, Math.max(-dx, px)) * 10) / 10,
      y: Math.round(Math.min(dy, Math.max(-dy, py)) * 10) / 10,
    };
  } else {
    resetPan();
  }
  fit.value = false;
  scale.value = s1;
}

function onWheel(ev: WheelEvent): void {
  let delta = ev.deltaY;
  if (ev.deltaMode === 1) delta *= WHEEL_LINE_PX; // lines → px (page mode falls through raw)
  if (delta === 0) return;
  zoomAt(Math.exp(-delta * WHEEL_ZOOM_PER_PX), ev.clientX, ev.clientY);
}

// --- fullscreen (Fullscreen API on the component root; hidden when unsupported) ---
/** Feature-detected once at setup; unsupported browsers degrade by hiding the button. */
const fullscreenAvailable = typeof document !== "undefined" && document.fullscreenEnabled === true;
const isFullscreen = ref(false);

function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === rootEl.value;
}

async function toggleFullscreen(): Promise<void> {
  if (isFullscreen.value) {
    if (typeof document.exitFullscreen === "function") {
      try {
        await document.exitFullscreen();
      } catch {
        // transient — the fullscreenchange listener resyncs the state either way
      }
    }
    return;
  }
  const el = rootEl.value;
  if (el === null || typeof el.requestFullscreen !== "function") return;
  try {
    await el.requestFullscreen();
  } catch {
    // rejected (permission/policy/transient) — the button simply stays off
  }
}

onMounted(() => document.addEventListener("fullscreenchange", onFullscreenChange));
onBeforeUnmount(() => document.removeEventListener("fullscreenchange", onFullscreenChange));

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
  if (ev.key === "+" || ev.key === "=") {
    ev.preventDefault();
    zoomIn();
    return;
  }
  if (ev.key === "-" || ev.key === "_") {
    ev.preventDefault();
    zoomOut();
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
  <div v-if="safe" ref="rootEl" class="preview-image">
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
        <button
          v-if="fullscreenAvailable"
          type="button"
          class="btn btn-ghost preview-zoom-btn preview-fullscreen-btn"
          :aria-pressed="isFullscreen"
          :aria-label="isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')"
          :title="isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')"
          @click="toggleFullscreen"
        >
          ⛶
        </button>
      </span>
    </div>
    <div ref="bodyEl" class="preview-image-body" :class="{ actual: !fit }" @wheel.prevent="onWheel">
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
