<!--
  Top-bar host-load pill (sysload plan docs/dev/sysload/plan.md §7.4/视觉稿 topbar mockup — U3).
  Self-contained: owns its own popover `open`/anchor state (same pattern as `QuotaPill.vue`), so
  `TopBar.vue` only ever mounts this one component, right after `QuotaPill` (视觉稿).

  Renders nothing (`v-if="view"`) when there is no (fresh) `load` snapshot — the caller
  (`TopBar.vue`) additionally mounts it through a 0/1-item `v-for`, never a plain `v-if`, for the
  same "zero extra DOM nodes" reason `QuotaPill.vue`'s own header documents (Vue's compiled
  `v-if` always leaves a `<!--v-if-->` anchor comment; an empty `v-for` list leaves none — I8: a hub/session with the
load feature off, or one running an older peer without `load.v1`, must look byte-identical to before this feature
existed). Segments: `CPU NN% · MEM NN% · DISK NN%` (視覚稿), each independently colored by ITS OWN level
(`.ld-seg.hot[data-level]`); the pill's own `data-level` is the worst segment's level (border/ background ladder,
mirrors `QuotaPill`'s "whole-pill = MAX level" rule). ≤480px shows only the single worst segment (视觉稿 mobile-390:
"only the worst metric pill shows — field width is tight"). "主机 · hub 视角" disclosure (plan §3's "Pill/Card
标注「主机 · hub 视角」"): the aria/title text says so explicitly, since this is a HOST-wide reading independent of
which session/agent is selected — never to be confused with a per-session verdict (that one lives on `FleetDrawer`'s
banner, via `StatusInfo.loadGate`). i18n (2026-10 user ruling, overrides AGENTS.md's usual "compact markers stay
English" convention for THIS pill only): the segment LABELS are localized — zh renders `CPU 3% · 内存 10% · 磁盘 71%`,
en keeps `CPU 3% · MEM 10% · DISK 71%` (`CPU` itself is identical in both languages on purpose). `@logic/load.js`'s
`pillView` builds the actual `"{label} {pct}%"` strings from the `load.segCpu`/`segMem`/`segDisk` i18n keys passed in
below — the ≤480px single-worst-segment chip reuses the SAME localized text (never a separate hardcoded "CPU N%"; the
two happen to read identically only because the CPU label itself never changes). -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { pillView } from "@logic/load.js";
import type { LoadWire } from "@protocol/messages.js";
import LoadCard from "./LoadCard.vue";
import "../../styles/load.css";

interface PillSeg {
  key: "cpu" | "mem" | "disk";
  level: 0 | 1 | 2 | 3;
  text: string;
}
interface PillView {
  level: 0 | 1 | 2 | 3;
  segs: PillSeg[];
  worstKey: "cpu" | "mem" | "disk" | undefined;
}

const props = defineProps<{ load: LoadWire | undefined; receivedAt: number | undefined }>();
const { t } = useI18n();

const mobile = useMedia(window, "(max-width: 480px)").matches;
/** Hover-capable pointer (desktop): gates the hover-peek popover — phones/tablets never
 *  auto-open on hover. Same gate as `QuotaPill` (2026-10-17 user 「sysload 也改为 hover 悬停展开，
 *  参考 quota」). */
const hoverFine = useMedia(window, "(hover: hover) and (pointer: fine)").matches;

// Re-derives staleness/elapsed off the browser's OWN clock on a light tick — a snapshot that
// stops arriving (hub died, feature turned off mid-session) must still go stale on schedule,
// not freeze showing its last reading forever (§7.4).
const nowTick = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now();
  }, 5_000);
});
onUnmounted(() => {
  if (hoverIn !== undefined) clearTimeout(hoverIn);
  if (hoverOut !== undefined) clearTimeout(hoverOut);
  if (timer !== undefined) clearInterval(timer);
});

const view = computed(
  (): PillView | null =>
    pillView(props.load, props.receivedAt, nowTick.value, {
      cpu: t("load.segCpu"),
      mem: t("load.segMem"),
      disk: t("load.segDisk"),
    }) as PillView | null,
);

const shownSegs = computed((): PillSeg[] => {
  const v = view.value;
  if (v === null) return [];
  if (!mobile.value) return v.segs;
  const worst = v.segs.find((s) => s.key === v.worstKey) ?? v.segs[0];
  return worst === undefined ? [] : [worst];
});

const btnEl = ref<HTMLButtonElement | null>(null);

/* --------------------------------------------------------- popover: pinned + hover peek
 * Mirrors `QuotaPill` exactly: click pins; on hover-capable pointers a ~150ms hover opens a
 * non-pinned "peek" (no focus move — `LoadCard` `peek`), closing ~200ms after the pointer leaves
 * BOTH the pill and the card; a click on top of a peek pins it. */
const pinned = ref(false);
const peek = ref(false);
const open = computed(() => pinned.value || peek.value);

let hoverIn: ReturnType<typeof setTimeout> | undefined;
let hoverOut: ReturnType<typeof setTimeout> | undefined;

function onToggle(): void {
  pinned.value = !pinned.value;
  peek.value = false;
}
function onClose(): void {
  pinned.value = false;
  peek.value = false;
}
function stopPeekClose(): void {
  if (hoverOut !== undefined) {
    clearTimeout(hoverOut);
    hoverOut = undefined;
  }
}
/** Bound to both the pill's and the card's mouseenter: opens after ~150ms, or (card already
 *  open) just cancels a pending close. */
function onPillEnter(): void {
  stopPeekClose();
  if (!hoverFine.value || mobile.value || open.value) return;
  hoverIn = setTimeout(() => {
    hoverIn = undefined;
    peek.value = true;
  }, 150);
}
function onPillLeave(): void {
  if (hoverIn !== undefined) {
    clearTimeout(hoverIn);
    hoverIn = undefined;
  }
  if (!pinned.value && peek.value) {
    stopPeekClose();
    hoverOut = setTimeout(() => {
      hoverOut = undefined;
      peek.value = false;
    }, 200);
  }
}

const ariaLabel = computed(() => {
  const segs = shownSegs.value;
  const text = segs.map((s) => s.text).join(" · ");
  return t("load.pillAria", { segs: text });
});
</script>

<template>
  <span v-if="view" class="ld-anchor">
    <button
      ref="btnEl"
      type="button"
      class="ld-pill"
      :data-level="view.level"
      aria-haspopup="dialog"
      :aria-expanded="open"
      aria-controls="load-panel"
      :aria-label="ariaLabel"
      :title="ariaLabel"
      @click="onToggle"
      @mouseenter="onPillEnter"
      @mouseleave="onPillLeave"
    >
      <span class="ld-dot" aria-hidden="true"></span>
      <template v-for="(seg, i) in shownSegs" :key="seg.key">
        <span v-if="i > 0" class="ld-sep" aria-hidden="true">·</span>
        <span class="ld-seg" :class="{ hot: seg.level > 0 }" :data-level="seg.level">{{ seg.text }}</span>
      </template>
    </button>
    <LoadCard
      v-if="open && load"
      :load="load"
      :received-at="receivedAt"
      :now="nowTick"
      :anchor-el="btnEl"
      :peek="peek"
      @close="onClose"
      @mouseenter="onPillEnter"
      @mouseleave="onPillLeave"
    />
  </span>
</template>
