<!--
  PreviewWindow.vue — web-hub-preview-windows plan r2 §9 (W2): ONE preview window. Everything
  the old modal PreviewHost rendered per-dialog moves here (header / all phases / holdTall /
  htmlHoldTall / copy channel / download), now window-scoped:

  - `openFrom(ref, route?)` is the ONE entry every in-window click funnels through (评审 #10):
    PathText/MdInline refs, MdImage and dir-listing file/symlink rows all call
    `face.openWindow(ref, win.id, {route})`; a KNOWN dir row still navigates IN PLACE
    (`win.handle.navigate`) per §3.1. The subtree gets `PREVIEW_CTX` re-provided with `open`
    mapped to `openFrom`, so every nested PathText drills the router, not a fresh visit.
  - the header carries the 「⋯」 window menu (PreviewWindowMenu), the phone `2/3` stack badge
    and — desktop only — `tabindex=0` keyboard move/resize (§5.5: arrows move 16px,
    Shift+arrows resize the SE edge, both through the layout controller's clamping).
  - the §3.4 limit notice renders as a `role=status` line under the header; the TEXT and the
    8s/epoch clears belong to the W1 manager (`limitNotice {id, seq}`) — the DOM only displays
    it for ITS window id.

  The SHELL (overlay root, sections, geometry, focus, Esc, phone trap) lives in PreviewHost.
-->
<script setup lang="ts">
import { computed, inject, provide, ref, watch } from "vue";
import { childPreviewPath, isHtmlPath, parentPreviewPath } from "@logic/preview.js";
import { routeOfDirEntry, type PreviewRoute } from "@logic/previewWindowRoute.js";
import type { PreviewDirEntry } from "@protocol/preview.js";
import type { PreviewWindow, PreviewWindowsFace } from "../../composables/usePreviewWindows.js";
import type { PreviewWindowLayout } from "../../composables/usePreviewWindowLayout.js";
import { usePreviewDownload } from "../../composables/usePreviewDownload.js";
import { useI18n } from "../../composables/useI18n.js";
import type { PreviewNavRef } from "../../composables/usePreview.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { PreviewView } from "../../types.js";
import CopyButton from "../detail/CopyButton.vue";
import { HUB_CTX } from "../control/controlContext.js";
import PreviewDir from "./PreviewDir.vue";
import PreviewImage from "./PreviewImage.vue";
import PreviewText from "./PreviewText.vue";
import PreviewWindowMenu from "./PreviewWindowMenu.vue";
import { PREVIEW_CTX, type PreviewContext } from "./previewContext.js";

const props = defineProps<{
  readonly win: PreviewWindow;
  readonly face: PreviewWindowsFace;
  readonly desktop: boolean;
  /** Phone band: this window is the top of the stack. */
  readonly isTop: boolean;
  /** 0-based creation index + total window count (the phone `2/3` badge). */
  readonly index: number;
  readonly count: number;
  readonly plaintext: boolean;
  readonly showPlainWarning: boolean;
  readonly layout: PreviewWindowLayout;
}>();

const emit = defineEmits<{
  (e: "close", id: number): void;
  (e: "close-all"): void;
  (e: "reset", id: number): void;
  (e: "select", id: number): void;
}>();

const { t } = useI18n();
const hub = inject(HUB_CTX, null);

const handle = props.win.handle;
const view = computed(() => handle.view.value);
const path = computed(() => ("path" in view.value ? view.value.path : ""));
const basename = computed(() => {
  const p = path.value;
  const slash = p.lastIndexOf("/");
  return slash >= 0 && slash < p.length - 1 ? p.slice(slash + 1) : p;
});
const isDirPhase = computed(() => view.value.phase === "dir");
const backDisabled = computed(() => handle.stackDepth.value === 0);
const upDisabled = computed(() => parentPreviewPath(path.value) === null);
const titleId = computed(() => `pw-title-${props.win.id}`);
const hintId = computed(() => `pw-hint-${props.win.id}`);

/** Once a directory listing (or a sandboxed html render) has been shown, the panel keeps its
 *  full height so the header buttons never jump — same trade-off as the modal-era host. */
const holdTall = ref(false);
watch(
  () => view.value.phase,
  (phase) => {
    if (phase === "dir") holdTall.value = true;
    else if (phase === "closed") holdTall.value = false;
  },
  { immediate: true },
);
const htmlHoldTall = computed(() => {
  const v = view.value;
  return (
    v.phase === "text" &&
    isHtmlPath(path.value) &&
    handle.scope.value?.html === true &&
    hub?.preview?.htmlCap !== undefined
  );
});
watch(
  htmlHoldTall,
  (on) => {
    if (on) holdTall.value = true;
  },
  { immediate: true },
);

// --- routing: every in-window click funnels through openFrom → face.openWindow (§3.1) ------

function openFrom(ref: PreviewNavRef, route?: PreviewRoute): void {
  props.face.openWindow(ref, props.win.id, route !== undefined ? { route } : undefined);
}

// The subtree re-provides PREVIEW_CTX with `open` mapped to `openFrom` — nested PathText /
// MdInline / MdImage clicks ride the window router (dir → in-place navigate, file → new
// window, unknown → speculative), never a fresh root visit.
provide(PREVIEW_CTX, {
  plaintext: props.plaintext,
  // The machine's `view` is the widened `PreviewViewDir` — bridged to the frozen face by ONE
  // cast, exactly like `usePreview`'s own return boundary (the frozen reader never matches a
  // phase it cannot produce on its own).
  handle: {
    ...handle,
    open: (ref: { readonly path: string }) => openFrom(ref),
  } as unknown as PreviewContext["handle"],
});

/** §3.1: a KNOWN dir row navigates in place (double-click / Ctrl+Enter / 「上级」/ path bar);
 *  file and symlink/other rows open windows (routeOfDirEntry — symlink stays "unknown"). */
function onDirEntry(entry: PreviewDirEntry, parentPath?: string): void {
  if (view.value.phase !== "dir") return;
  const child = childPreviewPath(parentPath ?? path.value, entry.name);
  if (child === null) return;
  if (entry.type === "dir") handle.navigate({ path: child, dir: true });
  else openFrom({ path: child }, routeOfDirEntry(entry.type));
}

function onPathBarGo(p: string): void {
  handle.navigate({ path: p });
}

// --- copy channel (PreviewText stays the sole value source) + download (per window) --------

const copyValue = ref<string | null>(null);
function onCopyValue(v: string | null): void {
  copyValue.value = v;
}

const dl = usePreviewDownload({ hub, view: () => view.value });
// Destructured so the template reads plain refs (refs nested in a plain object are not
// auto-unwrapped in templates).
const { dlBusy, dlFailed, downloadable, downloadCap } = dl;
watch(
  () => ("path" in view.value ? `${view.value.phase}:${view.value.path}` : view.value.phase),
  () => {
    dl.resetForView();
    copyValue.value = null; // stale copy text from the previous view never survives a switch
  },
);

/** The displayed body's UTF-8 length — only a fallback for a fake/legacy view without `bytes`. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
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

// --- window menu -----------------------------------------------------------------------------

const menuEl = ref<InstanceType<typeof PreviewWindowMenu> | null>(null);

const menuItems = computed(() =>
  props.face.windows.value.map((w) => {
    const v = w.handle.view.value;
    const p = "path" in v ? v.path : "";
    const slash = p.lastIndexOf("/");
    const name = slash >= 0 && slash < p.length - 1 ? p.slice(slash + 1) : p;
    return { id: w.id, name: name === "" ? "…" : name, path: p, current: w.id === props.win.id };
  }),
);

// r2 复审处置: crossing INTO the phone band closes an open window menu.
watch(
  () => props.desktop,
  (desktopNow) => {
    if (!desktopNow) menuEl.value?.closeMenu(false);
  },
);

// --- §3.4 limit notice (manager-owned; this window only displays its own id) -----------------

const limitLine = computed(() => {
  const n = props.face.limitNotice.value;
  return n !== null && n.id === props.win.id ? t("preview.windowLimit", { n: props.count }) : "";
});

// --- §5.5 keyboard move/resize on the title bar (desktop; only when the header itself focused)

const KEY_STEP_PX = 16;

/** §7.4: the header drag — `layout.beginGesture` gates button/desktop/threshold itself. */
function onHeaderPointerdown(ev: PointerEvent): void {
  if (!props.desktop) return;
  const el = ev.currentTarget;
  if (el instanceof HTMLElement) props.layout.beginGesture(ev, props.win.id, "move", el);
}

function onHeaderKeydown(ev: KeyboardEvent): void {
  if (!props.desktop || ev.target !== ev.currentTarget) return;
  const dx = ev.key === "ArrowLeft" ? -KEY_STEP_PX : ev.key === "ArrowRight" ? KEY_STEP_PX : 0;
  const dy = ev.key === "ArrowUp" ? -KEY_STEP_PX : ev.key === "ArrowDown" ? KEY_STEP_PX : 0;
  if (dx === 0 && dy === 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.shiftKey) props.layout.keyResize(props.win.id, dx, dy);
  else props.layout.keyMove(props.win.id, dx, dy);
}

const ariaModal = computed(() => (props.desktop || !props.isTop ? "false" : "true"));
</script>

<template>
  <div
    class="preview-panel"
    :class="{ 'is-hold-tall': holdTall }"
    role="dialog"
    :aria-modal="ariaModal"
    :aria-labelledby="titleId"
    :aria-describedby="hintId"
    tabindex="-1"
  >
    <header
      class="preview-header"
      :tabindex="desktop ? 0 : undefined"
      :title="desktop ? t('preview.windowMoveHint') : undefined"
      @pointerdown="onHeaderPointerdown"
      @keydown="onHeaderKeydown"
    >
      <nav class="preview-nav" :aria-label="t('preview.dirNavLabel')">
        <button
          class="btn btn-ghost btn-icon preview-nav-btn"
          type="button"
          :disabled="backDisabled"
          :aria-label="t('preview.dirBack')"
          :title="t('preview.dirBack')"
          data-no-drag
          @click="handle.back()"
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
          data-no-drag
          @click="handle.up()"
        >
          <AppIcon name="arrow-up" />
        </button>
      </nav>
      <AppIcon :name="isDirPhase ? 'folder' : 'file'" class="icon-sm preview-header-icon" />
      <!-- §5.3: the panel's accessible name comes from THIS element (aria-labelledby — no
           competing aria-label on the panel). The sr-only prefix makes the label read
           「文件预览：a.md」 while the visible title stays just the basename. -->
      <span :id="titleId" class="preview-title" translate="no"
        ><span class="sr-only">{{ t("preview.windowLabel") }}</span
        >{{ basename }}</span
      >
      <!-- §6.1: the phone stack badge (compact English token; the screen-reader label carries
           the localized sentence). -->
      <span
        v-if="!desktop && count > 1"
        class="pw-count"
        :aria-label="t('preview.windowStackLabel', { i: index + 1, n: count })"
        >{{ index + 1 }}/{{ count }}</span
      >
      <!-- `<bdi dir="ltr">` isolates the path from `.preview-path`'s `direction: rtl`
           front-ellipsis trick (see the modal-era host). -->
      <span class="preview-path" :title="path" translate="no" data-no-drag
        ><bdi dir="ltr">{{ path }}</bdi></span
      >
      <CopyButton
        v-if="view.phase === 'text' && copyValue !== null"
        class="preview-copy"
        :value="copyValue"
        :label="t('common.copy')"
        :title="t('common.copy')"
      />
      <button
        v-if="downloadable"
        class="btn btn-ghost btn-icon preview-download"
        type="button"
        :disabled="dlBusy"
        :aria-label="t('preview.download')"
        :title="t('preview.download')"
        data-no-drag
        @click="dl.download()"
      >
        <AppIcon :name="dlBusy ? 'loader' : 'arrow-down'" :class="dlBusy ? 'spin' : undefined" />
      </button>
      <PreviewWindowMenu
        ref="menuEl"
        class="pw-menu-slot"
        :items="menuItems"
        :show-reset="desktop"
        @close-all="emit('close-all')"
        @reset="emit('reset', win.id)"
        @select="emit('select', $event)"
      />
      <button
        class="btn btn-ghost btn-icon preview-close"
        type="button"
        :aria-label="t('preview.close')"
        data-no-drag
        @click="emit('close', win.id)"
      >
        <AppIcon name="x" />
      </button>
    </header>
    <span :id="hintId" class="sr-only">{{ t("preview.windowMoveHint") }}</span>
    <p v-if="limitLine !== ''" class="preview-window-limit" role="status">{{ limitLine }}</p>
    <p v-if="dlFailed" class="preview-download-error" role="alert">
      {{ t("preview.downloadFailed") }}
    </p>
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
      <!-- dir-plan §4.1 B4: `:key` remounts PreviewText on every path change. -->
      <PreviewText
        v-else-if="view.phase === 'text'"
        :key="view.path"
        :text="view.text"
        :truncated="view.truncated"
        :loaded-label="formatBytes(view.bytes ?? utf8Length(view.text))"
        :total-label="formatBytes(view.size)"
        :stream="view.stream"
        :filename="basename"
        :path="path"
        @load-more="handle.loadMore()"
        @reopen="handle.reopen()"
        @retry-stream="handle.loadMore()"
        @update:copy-value="onCopyValue"
      />
      <PreviewDir
        v-else-if="view.phase === 'dir'"
        :key="view.path"
        :path="view.path"
        :listing="view.listing"
        :tree="handle.tree"
        @navigate="onDirEntry"
        @go="onPathBarGo"
      />
      <div v-else-if="view.phase === 'unsupported'" class="preview-note">
        <AppIcon name="ban" class="preview-note-icon" />
        <h3 class="preview-note-title">{{ t("preview.unsupportedTitle") }}</h3>
        <p>
          {{
            downloadCap ? t("preview.unsupportedDownload") : t("preview.unsupportedBody", { reason: unsupportedReason })
          }}
        </p>
        <p v-if="view.size !== undefined" class="preview-meta">
          {{ t("preview.fileSize", { size: formatBytes(view.size) }) }}
        </p>
        <button
          v-if="downloadCap"
          class="btn btn-primary preview-download-unsupported"
          type="button"
          :disabled="dlBusy"
          @click="dl.downloadUnsupported()"
        >
          <AppIcon :name="dlBusy ? 'loader' : 'arrow-down'" class="icon-sm" :class="dlBusy ? 'spin' : undefined" />
          <span>{{ t("preview.download") }}</span>
        </button>
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
        <button v-if="view.retryable" class="btn preview-retry" type="button" @click="handle.retry()">
          <AppIcon name="refresh" class="icon-sm" />
          <span>{{ t("preview.retry") }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
