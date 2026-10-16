<!--
  web-hub-version plan §5.2 (V2) + the 2026-10-16 D4 refinement: the mount point for the
  version panel, used in TWO modes:

  - popover (default): the desktop (≥1025px) non-modal `role="dialog"` opened by TopBar's
    version chip. Esc calls `preventDefault()` then closes, an outside `pointerdown` closes
    (with the SettingsOverlay P1 fix: `preventDefault()` so the browser's synchronous
    focus-steal default action can't race the focus-return below), focus moves into the panel
    on open and back to the anchor chip on close — the exact lifecycle
    `shell/SettingsOverlay.vue`'s desktop branch already uses. Below 1025px the chip itself is
    CSS-hidden, so this branch is unreachable there by construction; a mid-session shrink
    across the breakpoint simply keeps the open popover until closed (no geometry math, the
    panel is CSS-anchored under `.version-anchor`).
  - `embedded`: no popover/sheet shell at all — just the lazily loaded panel. This is the mode
    the settings popup's 「版本」 card renders (`SettingsView.vue`, D4: the version info lives
    INLINE inside the settings dialog on every viewport; there is no "close settings then open
    a sheet" flow). The card and the popover share the ONE `useVersionInfo` instance
    (`VERSION_CTX`, provided by TopBar), so their fetches ride the same single flight.

  The panel itself is a LAZY chunk (`defineAsyncComponent`, 8s timeout): the first-screen cost
  of the feature stays the chip + this host + `VersionLoadError`. On timeout/loader failure the
  error component renders and distinguishes 「页面已过期」 (only when §4 proved `tab-stale`)
  from 「面板加载失败」(retry = key bump, remounting the async component — never a claim of
  staleness).
-->
<script setup lang="ts">
import { computed, defineAsyncComponent, inject, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import VersionLoadError from "./VersionLoadError.vue";
import { VERSION_CTX } from "../../composables/useVersionInfo.js";
import "../../styles/version.css";

const props = withDefaults(defineProps<{ anchorEl?: HTMLElement | null; embedded?: boolean }>(), {
  anchorEl: null,
  embedded: false,
});
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const handle = inject(VERSION_CTX, null);

/** §5.2: the panel is a lazy chunk with an 8s timeout and the first-screen error component. */
const VersionPanel = defineAsyncComponent({
  loader: () => import("./VersionPanel.vue"),
  timeout: 8000,
  errorComponent: VersionLoadError,
});

/** The §4-proven tab-stale flag rides down as a prop (reaching whichever component renders —
 *  resolved panel ignores it, the error component switches to the 「已过期」 branch). Computed
 *  off the live matcher so a late `hub` frame can flip the branch while the error shows. */
const stale = computed(() => handle?.match.value.tabStale === true);

/** Retry = key bump: rebuilds the async component (a fresh loader attempt), never claims
 *  staleness by itself. */
const panelKey = ref(0);
function onRetry(): void {
  panelKey.value += 1;
}

const panelEl = ref<HTMLElement | null>(null);

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  emit("close");
}

function onPointerDown(ev: PointerEvent): void {
  if (!(ev.target instanceof Node)) return;
  const panel = panelEl.value;
  if (panel !== null && panel.contains(ev.target)) return;
  if (props.anchorEl !== null && props.anchorEl.contains(ev.target)) return;
  // Same P1 fix as SettingsOverlay: cancel the pointerdown's own focus-steal default action
  // so the focus-return on unmount is the only focus-setter that runs.
  ev.preventDefault();
  emit("close");
}

onMounted(async () => {
  if (props.embedded) return;
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  await nextTick();
  panelEl.value?.focus();
});

onUnmounted(() => {
  if (props.embedded) return;
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  props.anchorEl?.focus();
});
</script>

<template>
  <div v-if="embedded" class="version-embedded">
    <VersionPanel :key="panelKey" :stale="stale" embedded @retry="onRetry" />
  </div>
  <div
    v-else
    id="version-panel"
    ref="panelEl"
    class="version-pop"
    role="dialog"
    aria-labelledby="version-panel-title"
    tabindex="-1"
  >
    <header class="version-pop-head">
      <h2 id="version-panel-title" class="version-pop-title">{{ t("version.panelTitle") }}</h2>
    </header>
    <div class="version-pop-body">
      <VersionPanel :key="panelKey" :stale="stale" @retry="onRetry" />
    </div>
  </div>
</template>
