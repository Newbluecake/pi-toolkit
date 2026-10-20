<!--
  Renderer for the preview-mode `image` inline node (md-preview-html plan, user ruling
  2026-10-20 — README screenshots inside the file preview dialog). Three forms:

  - EXTERNAL http(s) src ⇒ NEVER fetched (user ruling): a placeholder chip that is a plain
    external link (`🖼 <alt or host>`, `target="_blank" rel="noopener noreferrer"`);
  - resolvable relative/absolute src ⇒ loaded through the injected per-document
    `MD_IMAGE_LOADER` (same preview API + admission + `maxPixels` budget as an image preview,
    converted to a verified `data:<mime>;base64,` URL — CSP stays `img-src 'self' data:`, no
    `createObjectURL`). The D1 backstop applies here too: only a `data:image/` URL ever
    reaches `<img src>`, even if the loader were buggy. Clicking a loaded image opens it in
    the normal image preview (the dialog's `open`→`navigate` override drills down);
  - failed / denied / oversize / unresolved / over-limit / over-budget ⇒ a placeholder chip
    showing the alt text plus a small reason — never an error page.

  The transcript renderer never sees this component (the parser emits `image` nodes only in
  preview mode); with no loader provided it degrades to the placeholder, fetch-free.
  All styling lives in `styles/preview.css` (source-scan bans `<style>` blocks).
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, shallowRef } from "vue";
import { resolveMdLinkTarget } from "@logic/mdLinkPath.js";
import { useI18n } from "../../composables/useI18n.js";
import type { MdImageFailReason, MdImageSlot } from "../../composables/useMdImageLoader.js";
import { MD_IMAGE_LOADER, PREVIEW_BASE_DIR, PREVIEW_CTX } from "./previewContext.js";
import type { MdImageSize } from "../transcript/markdown-types.js";

const props = defineProps<{
  readonly src: string;
  readonly alt: string;
  readonly title?: string | undefined;
  readonly width?: MdImageSize | undefined;
  readonly height?: MdImageSize | undefined;
}>();

const { t } = useI18n();
const loader = inject(MD_IMAGE_LOADER, null);
const previewCtx = inject(PREVIEW_CTX, null);
const previewBase = inject(PREVIEW_BASE_DIR, null);

/** External http(s) image — never fetched, chip links out (user ruling). */
// Protocol-relative `//host/x` is external too (verifier nit) — never fetched, chip link.
const external = computed(() => /^(?:https?:)?\/\//i.test(props.src));
// Host via regex (no URL base literal: check:web forbids external URLs in the bundle).
const externalHost = computed(() => /^(?:https?:)?\/\/([^/?#\s]+)/i.exec(props.src)?.[1] ?? "");

/** Relative/absolute src ⇒ the resolved preview request path (same resolution as pathlink). */
const resolved = computed(() => {
  if (external.value) return null;
  const scope = previewCtx?.handle.scope.value ?? null;
  return resolveMdLinkTarget(props.src, previewBase?.value ?? null, scope);
});

// --- load lifecycle (mount → loader.load; unmount → release ⇒ abort) ----------------------
interface LocalView {
  readonly state: "loading" | "ready" | "placeholder";
  readonly dataUrl: string | null;
  readonly reason: MdImageFailReason | null;
}
const slot = shallowRef<MdImageSlot | null>(null);
/** Pre-slot view (external / unresolved / loader-less): placeholder without any fetch. */
const fallback = shallowRef<LocalView | null>(null);

onMounted(() => {
  if (external.value) return;
  const r = resolved.value;
  if (r === null || r.dir || loader === null) {
    fallback.value = { state: "placeholder", dataUrl: null, reason: "unavailable" };
    return;
  }
  slot.value = loader.load(r.path);
});
onBeforeUnmount(() => {
  slot.value?.release(); // aborts the in-flight fetch / drops the queued one
});

const view = computed<LocalView>(() => {
  const s = slot.value;
  if (s !== null) return { state: s.state.value, dataUrl: s.dataUrl.value, reason: s.reason.value };
  return fallback.value ?? { state: "loading", dataUrl: null, reason: null };
});

/** D1 component-level backstop: only `data:image/` sources render (see PreviewImage.vue). */
const readyUrl = computed(() => {
  const v = view.value;
  return v.state === "ready" && v.dataUrl !== null && v.dataUrl.startsWith("data:image/") ? v.dataUrl : null;
});

const reasonText = computed(() => {
  const v = view.value;
  if (v.state === "loading") return t("preview.mdImg.loading");
  if (v.reason === null) return "";
  return t(`preview.mdImg.${v.reason}`);
});

const sizeStyle = computed(() => {
  const style: Record<string, string> = {};
  if (props.width !== undefined) style.width = props.width.unit === "%" ? `${props.width.n}%` : `${props.width.n}px`;
  if (props.height !== undefined)
    style.height = props.height.unit === "%" ? `${props.height.n}%` : `${props.height.n}px`;
  return style;
});

const chipLabel = computed(() =>
  props.alt !== "" ? props.alt : external.value ? externalHost.value || props.src : props.src,
);

function openImage(): void {
  const r = resolved.value;
  if (r === null || r.dir) return;
  // Inside the open dialog PreviewHost re-provides `open` → `navigate` (history push).
  previewCtx?.handle.open({ path: r.path });
}
function onImgKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    openImage();
  }
}
</script>

<template>
  <a v-if="external" class="md-img-chip md-img-ext" :href="src" target="_blank" rel="noopener noreferrer" :title="src"
    >🖼 {{ chipLabel }}</a
  >
  <img
    v-else-if="readyUrl !== null"
    class="md-img md-img-open"
    :src="readyUrl"
    :alt="alt"
    :title="title ?? alt"
    :style="sizeStyle"
    role="button"
    tabindex="0"
    draggable="false"
    @click="openImage"
    @keydown="onImgKeydown"
  />
  <span v-else class="md-img-chip" :class="{ 'md-img-loading': view.state === 'loading' }"
    >🖼 {{ chipLabel }}<span v-if="reasonText !== ''" class="md-img-why"> · {{ reasonText }}</span></span
  >
</template>
