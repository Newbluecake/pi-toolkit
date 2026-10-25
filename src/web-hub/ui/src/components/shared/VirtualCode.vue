<!--
  VirtualCode.vue — the virtual-scroll source body (preview-perf P2, plan r3 §4.3–§4.5).
  Owns the scroll container (`pre.preview-text-body.pv-virtual` — PreviewText/P3 swaps its
  legacy <pre> for this component wholesale on the virtual paths), the spacer (total height
  + unified gutter width, §4.4), the line-height probe (§4.3), the scroll/resize windowing
  and the selection state machine (§4.5). Lines are rendered by VirtualBlock.vue.

  P2 builds against the FROZEN interface only (@logic/previewVirtualTypes.js); the window
  math (computeWindow/maxLines/reanchor semantics) is implemented inline here and is
  swapped for P1's pure functions at the 对接 step — signatures and semantics follow §4.3/
  §4.5 exactly so the swap is mechanical.

  Text-model reactivity: `VirtualTextSource` is a plain object (frozen interface, no Vue
  reactivity), so the parent passes `sourceRevision` — a number it bumps on every
  append/setHighlight. The watcher consumes `source.lastChange` to invalidate per-block
  caches incrementally (append ⇒ only the blocks touching [fromLine, …); highlight ⇒ all).

  Selection freeze (§4.5, 已拍板 ④): `selectionActive()` is checked SYNCHRONOUSLY before
  every window computation / patch. While active the mounted block range only grows (never
  unmounts, stays contiguous, ≤ 2048 lines = 64 blocks — past the cap the window returns
  to normal and a status notice points at Ctrl+A / the full view), mounted blocks' `lines`
  props keep their exact array references (Vue then skips the subtrees — no text node is
  replaced, native Ranges survive), and highlight arrivals / last-line growth queue until
  the selection collapses or leaves the body (detected via the async `selectionchange`,
  which is used for shrinking only, never for liveness).

  Logical select-all (§4.5): Ctrl/⌘+A inside the body preventDefaults, clears the native
  selection and sets a DOM-independent `allSelected` flag (spacer paints it with system
  highlight colors). The `copy` event then writes the FULL loaded text — at copy time,
  including anything appended after the select-all. Cancel conditions are explicit new
  selection actions ONLY (pointerdown in the body, Shift+selection keys, Esc, a new
  non-collapsed selectionchange); scroll / append / highlight arrival / blur never cancel.

  Test seams (§4.3): `rowHeight` / `viewportHeight` props inject the geometry happy-dom
  cannot measure; `selectionActive` replaces the whole liveness predicate. No rAF anywhere
  (source-scan); scroll listener is registered manually so it can be { passive: true }.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { observeResize } from "../../composables/useSharedResize.js";
import { lineNumberDigits } from "@logic/previewLines.js";
import {
  PREVIEW_VIRTUAL_BLOCK_LINES,
  VIRTUAL_MAX_LINES,
  VIRTUAL_MAX_PX,
  VIRTUAL_SELECTION_MAX_LINES,
  type DisplayLine,
  type VirtualTextSource,
} from "@logic/previewVirtualTypes.js";
import VirtualBlock from "./VirtualBlock.vue";
import "../../styles/preview-virtual.css";

/** Half a block, in lines — the hysteresis margin folded into the window edges (§4.5). */
const HYSTERESIS_LINES = PREVIEW_VIRTUAL_BLOCK_LINES / 2;

/* Local copy of the P2-owned UI strings (i18n/{zh,en}/preview.ts is P3's exclusive file
 * domain). P3 wiring: replace with `t("preview.*")` keys; the shapes are the final copy
 * from plan §4.2/§4.3/§4.5/§4.7. */
const STRINGS = {
  zh: {
    clipLabel: "本行超长，已截断 {n} 个字符",
    allSelected: "已选中全部 {n} 行（已加载内容），Ctrl+C 复制",
    selectionCap: "选区超过 {n} 行，无法保持；请用 Ctrl+A 复制全部或切换完整视图",
    capNote: "已加载 {n} 行，超过本视图上限，其余请用完整视图 / 复制全部 / 下载",
    srDesc:
      "大文件按需渲染，读屏只能读到当前可见部分。按『完整视图』按钮（只影响本窗口）可以连续阅读整份已加载内容；Ctrl+F 在文件内查找；Ctrl+A 再 Ctrl+C 复制全部。",
  },
  en: {
    clipLabel: "Line exceeds the display limit; {n} characters hidden",
    allSelected: "All {n} lines selected (loaded content). Press Ctrl+C to copy.",
    selectionCap:
      "Selection exceeds {n} lines and cannot be preserved; use Ctrl+A to copy all or switch to the full view",
    capNote: "{n} lines loaded, beyond this view's cap — use the full view / copy-all / download for the rest",
    srDesc:
      "Large files render on demand; screen readers only see the currently visible part. The “full view” button (this window only) renders the whole loaded content; Ctrl+F searches within the file; Ctrl+A then Ctrl+C copies everything.",
  },
} as const;
type StringKey = keyof typeof STRINGS.zh;

const props = defineProps<{
  /** The single text model behind the body (frozen interface §4.2). */
  readonly source: VirtualTextSource;
  /** Reactive tick the parent bumps on every append/setHighlight (the model itself is inert). */
  readonly sourceRevision?: number;
  /** Test seam (§4.3): inject the row height; skips probe measurement (happy-dom measures 0). */
  readonly rowHeight?: number;
  /** Test seam (§4.3): inject the viewport height; skips clientHeight measurement. */
  readonly viewportHeight?: number;
  /** Test seam: replaces the whole selection-liveness predicate (§4.5 同步判定). */
  readonly selectionActive?: () => boolean;
}>();

const i18n = useI18n();
function fmt(key: StringKey, params?: Readonly<Record<string, string | number>>): string {
  const dict = i18n.lang === "zh" ? STRINGS.zh : STRINGS.en;
  let out: string = dict[key];
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** Per-instance describedby id (module counter — plain DOM id, no randomness needed). */
let uidSeq = 0;
const descId = `pv-vdesc-${(uidSeq += 1)}`;

const scrollEl = ref<HTMLElement | null>(null);
const probeEl = ref<HTMLElement | null>(null);
const spacerEl = ref<HTMLElement | null>(null);

function fallbackRowH(): number {
  let scale = 1;
  try {
    if (typeof document !== "undefined") {
      const n = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-scale"));
      if (Number.isFinite(n) && n > 0) scale = n;
    }
  } catch {
    /* no computed style — 100% */
  }
  return 13 * scale * 1.5;
}

const rowH = ref(props.rowHeight ?? fallbackRowH());
const viewH = ref(props.viewportHeight ?? 0);
/** Current contiguous mounted block range [lo, hi) — block indices (§4.5). */
const windowRange = shallowRef({ lo: 0, hi: 0 });

const allSelected = ref(false);
const statusText = ref("");

/* ---------------------------------------------------------------- geometry */

/** Lines actually renderable: min(loaded, maxLines) where maxLines = min(500k, 15e6/rowH). */
const displayLines = computed(() => {
  void props.sourceRevision; // reactive tick: lineCount is read fresh after append
  const cap = Math.max(1, Math.min(VIRTUAL_MAX_LINES, Math.floor(VIRTUAL_MAX_PX / rowH.value)));
  return Math.min(props.source.lineCount, cap);
});
const isCapped = computed(() => {
  void props.sourceRevision;
  return props.source.lineCount > displayLines.value;
});
const totalBlocks = computed(() => Math.ceil(displayLines.value / PREVIEW_VIRTUAL_BLOCK_LINES));

/** Unified gutter + locked row height + total height + pure-`ch` min-width (§4.4). */
const spacerStyle = computed((): CSSProperties => {
  void props.sourceRevision; // maxDisplayCols is monotone but read fresh per tick
  const digits = lineNumberDigits(displayLines.value);
  const cols = props.source.maxDisplayCols;
  return {
    "--pvline-w": `${digits}ch`,
    "--pv-row-h": `${rowH.value}px`,
    height: `${displayLines.value * rowH.value}px`,
    minWidth: `calc(${digits + 1.5 + cols}ch + 2 * var(--sp-3))`,
  } as CSSProperties;
});

const capNoteText = computed(() => {
  void props.sourceRevision;
  return fmt("capNote", { n: props.source.lineCount });
});
const srDescText = computed(() => fmt("srDesc"));
const clipLabelFn = computed(
  () =>
    (n: number): string =>
      fmt("clipLabel", { n }),
);

const blockIndexList = computed(() => {
  const { lo, hi } = windowRange.value;
  const out: number[] = [];
  for (let bi = lo; bi < hi; bi++) out.push(bi);
  return out;
});

/* ------------------------------------------------- selection freeze (§4.5) */

/** BlockIndex → its lines array WHILE a selection is active (the frozen snapshot). */
let frozenLines: Map<number, readonly DisplayLine[]> | null = null;
let freezeCapNotified = false;
/** Set when a revision bump arrived during a freeze — flush on unfreeze (conservatively:
 * the whole cache is dropped, every mounted block recomputes at the current revision). */
let queuedWhileFrozen = false;
/** Lines → block cache for the normal path; entries are invalidated by the tick watcher
 * (append ⇒ blocks touching [fromLine, …); highlight/init/ambiguous ⇒ everything). */
const blockCache = new Map<number, { rev: number; lines: readonly DisplayLine[] }>();
let pointerSelecting = false;

function internalSelectionActive(): boolean {
  if (pointerSelecting) return true;
  if (typeof document === "undefined") return false;
  const sel = document.getSelection();
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return false;
  const spacer = spacerEl.value;
  if (spacer === null) return false;
  try {
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      if (typeof r.intersectsNode === "function" && r.intersectsNode(spacer)) return true;
    }
  } catch {
    /* partial Selection impl — fail closed (not active) */
  }
  return false;
}
function selectionActiveNow(): boolean {
  return props.selectionActive !== undefined ? props.selectionActive() : internalSelectionActive();
}

/** Overscan in screens: 1, or 1.5 on coarse pointers (§4.5). */
function overscanScreens(): number {
  try {
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return 1.5;
  } catch {
    /* no matchMedia — desktop default */
  }
  return 1;
}

/**
 * Window math — P1's `computeWindow` semantics, inlined until the 对接 swap (§4.5): a
 * CONTIGUOUS block range covering [firstVisible − overscan − ½block, lastVisible +
 * overscan + ½block) — the half-block margin is the hysteresis (§4.5 带半块滞回).
 */
function computeWindowRange(): { lo: number; hi: number } {
  const total = totalBlocks.value;
  if (total === 0) return { lo: 0, hi: 0 };
  const rh = rowH.value;
  const vh = Math.max(viewH.value, rh);
  const over = Math.ceil((vh * overscanScreens()) / rh);
  const first = Math.max(0, Math.floor((scrollEl.value?.scrollTop ?? 0) / rh) - over - HYSTERESIS_LINES);
  const last = Math.min(
    displayLines.value,
    Math.ceil(((scrollEl.value?.scrollTop ?? 0) + vh) / rh) + over + HYSTERESIS_LINES,
  );
  return {
    lo: Math.floor(first / PREVIEW_VIRTUAL_BLOCK_LINES),
    hi: Math.min(total, Math.ceil(last / PREVIEW_VIRTUAL_BLOCK_LINES)),
  };
}

function pruneTo(lo: number, hi: number): void {
  for (const bi of blockCache.keys()) if (bi < lo || bi >= hi) blockCache.delete(bi);
  if (frozenLines !== null) {
    for (const bi of frozenLines.keys()) if (bi < lo || bi >= hi) frozenLines.delete(bi);
  }
}

/** Snapshot the mounted blocks' current lines — the frozen props (§4.5). */
function startFreeze(): void {
  frozenLines = new Map();
  freezeCapNotified = false;
  const { lo, hi } = windowRange.value;
  for (let bi = lo; bi < hi; bi++) {
    const cached = blockCache.get(bi);
    if (cached !== undefined) frozenLines.set(bi, cached.lines);
  }
}
function endFreeze(): void {
  frozenLines = null;
  queuedWhileFrozen = false;
  blockCache.clear(); // conservative: every mounted block recomputes at the current revision
}

/** Called before every window computation AND every patch (§4.5 — synchronous check). */
function updateWindow(): void {
  const active = selectionActiveNow();
  if (active) {
    if (frozenLines === null) startFreeze();
  } else if (frozenLines !== null) {
    endFreeze();
  }
  const fresh = computeWindowRange();
  let lo = fresh.lo;
  let hi = fresh.hi;
  if (active && frozenLines !== null) {
    // 只增不减：grow the range, keep it contiguous; past 2048 lines fall back to the
    // normal window — the selection is explicitly no longer guaranteed (已拍板 ④).
    const prev = windowRange.value;
    lo = Math.min(lo, prev.lo);
    hi = Math.max(hi, prev.hi);
    if ((hi - lo) * PREVIEW_VIRTUAL_BLOCK_LINES > VIRTUAL_SELECTION_MAX_LINES) {
      lo = fresh.lo;
      hi = fresh.hi;
      if (!freezeCapNotified) {
        freezeCapNotified = true;
        statusText.value = fmt("selectionCap", { n: VIRTUAL_SELECTION_MAX_LINES });
      }
    }
  }
  windowRange.value = { lo, hi };
  pruneTo(lo, hi);
}

/** Render-time lines accessor: frozen snapshot during a selection (newly mounted blocks
 * render at the CURRENT revision and then freeze with it — §4.5「新挂载的块按当前
 * revision 渲染」), incremental cache otherwise. Returns STABLE references so unchanged
 * blocks are skipped by Vue's shallow prop compare. */
function linesFor(bi: number): readonly DisplayLine[] {
  if (frozenLines !== null) {
    const frozen = frozenLines.get(bi);
    if (frozen !== undefined) return frozen;
    const lines = freshLines(bi);
    frozenLines.set(bi, lines);
    return lines;
  }
  const cached = blockCache.get(bi);
  if (cached !== undefined) return cached.lines; // invalidated entries never survive a tick
  const lines = freshLines(bi);
  blockCache.set(bi, { rev: props.source.revision, lines });
  return lines;
}
function freshLines(bi: number): readonly DisplayLine[] {
  const start = bi * PREVIEW_VIRTUAL_BLOCK_LINES;
  const end = Math.min(start + PREVIEW_VIRTUAL_BLOCK_LINES, displayLines.value);
  const lines: DisplayLine[] = [];
  for (let i = start; i < end; i++) lines.push(props.source.displayLine(i));
  return lines;
}

/* ------------------------------------------------------- source ticks */

let lastTick = props.sourceRevision ?? 0;
watch(
  () => props.sourceRevision ?? 0,
  (tick) => {
    const delta = tick - lastTick;
    lastTick = tick;
    if (selectionActiveNow()) {
      // Freeze: highlight arrivals and last-line growth QUEUE (§4.5). The window itself
      // still updates — appended blocks mount, rendered at the current revision.
      queuedWhileFrozen = true;
      updateWindow();
      return;
    }
    if (delta > 1 || props.source.lastChange.kind !== "append") {
      // highlight / init / ambiguous multi-bump: everything may differ.
      blockCache.clear();
    } else {
      // append: only the blocks touching [fromLine, …) re-render (§4.8) — the last
      // unfinished line's block and the new ones; every other mounted block keeps its
      // exact array reference (and its DOM text nodes).
      const fromLine = props.source.lastChange.fromLine;
      for (const bi of [...blockCache.keys()]) {
        if (bi * PREVIEW_VIRTUAL_BLOCK_LINES + (PREVIEW_VIRTUAL_BLOCK_LINES - 1) >= fromLine) blockCache.delete(bi);
      }
    }
    updateWindow();
  },
);

/* ------------------------------------------- logical select-all (§4.5) */

const SHIFT_SELECT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

function setAllSelected(v: boolean): void {
  if (allSelected.value === v) return;
  allSelected.value = v;
  if (v) {
    try {
      document.getSelection()?.removeAllRanges();
    } catch {
      /* partial Selection impl — the visual state still applies */
    }
    statusText.value = fmt("allSelected", { n: props.source.lineCount });
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    setAllSelected(true);
    return;
  }
  // Cancel conditions: explicit new selection actions ONLY (§4.5).
  if (allSelected.value && e.key === "Escape") {
    setAllSelected(false);
    return;
  }
  if (allSelected.value && e.shiftKey && SHIFT_SELECT_KEYS.has(e.key)) setAllSelected(false);
}

function onPointerDown(e: PointerEvent): void {
  if (allSelected.value) setAllSelected(false);
  if (e.button === 0) pointerSelecting = true;
}

function onPointerUp(): void {
  pointerSelecting = false;
  updateWindow();
}

function onSelectionChange(): void {
  const sel = typeof document === "undefined" ? null : document.getSelection();
  if (allSelected.value && sel !== null && !sel.isCollapsed && sel.rangeCount > 0) {
    setAllSelected(false);
  }
  // Async shrink path (§4.5): selectionchange is used to RELEASE the freeze, never to
  // keep it alive — liveness is judged synchronously inside updateWindow.
  updateWindow();
}

function onCopy(e: ClipboardEvent): void {
  if (!allSelected.value) return;
  // Full LOADED text at copy time — includes anything appended after the select-all.
  const dt = e.clipboardData;
  if (dt !== null) dt.setData("text/plain", props.source.text());
}

/* --------------------------------------------- measurement / reanchor */

function measureProbe(): number {
  const el = probeEl.value;
  if (el === null) return 0;
  const h = el.getBoundingClientRect().height;
  return Number.isFinite(h) && h > 0 ? h : 0;
}

/** §4.3 anchor: keep the logical line (and in-line fraction) under a row-height change.
 *  Vue flushes the spacer height / block tops in a microtask; the scrollTop rewrite rides
 *  nextTick so it lands after the patch and still before paint. */
function reanchor(oldH: number, newH: number): void {
  const el = scrollEl.value;
  const st = el?.scrollTop ?? 0;
  const anchorLine = Math.floor(st / oldH);
  const frac = (st - anchorLine * oldH) / oldH;
  rowH.value = newH;
  void nextTick(() => {
    if (el !== null) el.scrollTop = (anchorLine + frac) * newH;
    updateWindow();
  });
}

function onProbeResize(): void {
  if (props.rowHeight !== undefined) return; // injected geometry — the probe is inert
  const nh = measureProbe();
  if (nh <= 0 || Math.abs(nh - rowH.value) < 0.01) return;
  reanchor(rowH.value, nh);
}

function onScroll(): void {
  updateWindow();
}
function onScrollResize(): void {
  if (props.viewportHeight !== undefined) return;
  const ch = scrollEl.value?.clientHeight ?? 0;
  if (ch > 0 && ch !== viewH.value) viewH.value = ch;
  updateWindow();
}

// Test seams double as the live-geometry change path (font-scale change ⇒ new rowHeight).
watch(
  () => props.rowHeight,
  (nh, oh) => {
    if (nh === undefined) return;
    if (oh !== undefined && oh > 0) reanchor(oh, nh);
    else {
      rowH.value = nh;
      updateWindow();
    }
  },
);
watch(
  () => props.viewportHeight,
  (vh) => {
    if (vh === undefined) return;
    viewH.value = vh;
    updateWindow();
  },
);

/* --------------------------------------------------- mount / teardown */

let unobserveProbe: (() => void) | null = null;
let unobserveScroll: (() => void) | null = null;

onMounted(() => {
  if (props.rowHeight === undefined) {
    const measured = measureProbe();
    if (measured > 0 && Math.abs(measured - rowH.value) > 0.01) rowH.value = measured;
  }
  if (props.viewportHeight === undefined) {
    const ch = scrollEl.value?.clientHeight ?? 0;
    if (ch > 0) viewH.value = ch;
  }
  updateWindow();
  // Manual listeners: template v-on cannot be passive; the scroll path must be (§4.5).
  scrollEl.value?.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("selectionchange", onSelectionChange);
  if (probeEl.value !== null) unobserveProbe = observeResize(probeEl.value, onProbeResize);
  if (scrollEl.value !== null) unobserveScroll = observeResize(scrollEl.value, onScrollResize);
});

onBeforeUnmount(() => {
  scrollEl.value?.removeEventListener("scroll", onScroll);
  document.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("selectionchange", onSelectionChange);
  unobserveProbe?.();
  unobserveScroll?.();
});

/* ------------------------------------------------------------ public */

/** Scroll a 1-based logical line into view (§0: the ONLY line-navigation API this far). */
function scrollToLine(line: number, where: "start" | "center" = "center"): void {
  const el = scrollEl.value;
  if (el === null) return;
  const target = Math.max(1, Math.min(Math.floor(line), displayLines.value));
  const top = (target - 1) * rowH.value;
  el.scrollTop = where === "center" ? Math.max(0, top - (Math.max(viewH.value, rowH.value) - rowH.value) / 2) : top;
  updateWindow();
}

defineExpose({ scrollToLine, scrollEl });
</script>

<template>
  <div class="pv-vwrap">
    <pre
      ref="scrollEl"
      class="preview-text-body pv-virtual"
      tabindex="0"
      :aria-describedby="descId"
      @keydown="onKeydown"
      @pointerdown="onPointerDown"
      @copy="onCopy"
    ><span
        ref="spacerEl"
        class="pv-spacer"
        :class="{ 'is-all-selected': allSelected }"
        :style="spacerStyle"
        ><VirtualBlock
          v-for="bi in blockIndexList"
          :key="bi"
          :lines="linesFor(bi)"
          :start="bi * PREVIEW_VIRTUAL_BLOCK_LINES + 1"
          :top-px="bi * PREVIEW_VIRTUAL_BLOCK_LINES * rowH"
          :clip-label="clipLabelFn"
      /></span><span v-if="isCapped" class="pv-cap-note" role="note">{{ capNoteText }}</span><!-- P3 wiring point: the stream sentinel (.preview-stream-sentinel) and the stream state lines ride this slot - after the spacer, inside the scroll container (§4.8). --><slot></slot></pre>
    <span ref="probeEl" class="pv-vprobe" aria-hidden="true">{{ "\u00A0" }}</span>
    <span :id="descId" class="sr-only">{{ srDescText }}</span>
    <span class="sr-only" role="status">{{ statusText }}</span>
  </div>
</template>
