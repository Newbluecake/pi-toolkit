<!--
  worktree-graph plan v2 §4.3 (package P5): the commit-graph body mounted inside
  `WorktreePanel.vue` under the worktree list, when a graph scope AND a picked worktree exist.
  This component (plus `GraphLanes.vue`) is the ONLY importer of `@logic/gitGraph.ts` — the
  panel reaches it through `defineAsyncComponent` + a retryable `loadGraph()`, so all layout
  code stays in a lazy chunk (§4.3/#13; `worktree-panel.test.ts` pins the no-import rule).

  Structure (§4.3): `<table>` + `<caption class="sr-only">`; the FIRST tbody row carries the
  lane cell (`rowspan` = commit count, `aria-hidden`) hosting the `GraphLanes` SVG; one row
  per commit: chips + subject (`title` = full subject) | date | author | hash.
  - ≥768px: all columns; 481–767: author dropped; ≤480px (Q3, the panel's injected `useMedia`
    verdict rides the `mobile` prop): only lanes (≤4) + subject (HEAD chip only) + hash.
  - merge rows `.is-merge` (DIMMED subject + hollow dot — §0.2 ruling, the opposite of the
    mockup's bold); current row `data-current` (background + outer ring); other worktree
    HEADs get a dashed ring + badge (full-oid matching via `wtRingsOf`).
  - Row centers are MEASURED (ResizeObserver on tbody; row rect vs tbody rect), never computed
    from a row height — font scale 100/200/300% and coarse-pointer rows all align (#8).
    `injectedCenters` is the test seam for the "SVG coordinates match row centers" pin
    (happy-dom does no layout, so measured centers are all 0 there).
  - States (§4.3): loading / ready / empty (only `empty && complete`) / degraded (any degrade
    marker — zero commits but incomplete shows degraded, NEVER empty) / error (per-reason
    copy + retry). A re-pull keeps the old data visible with `aria-busy`.
  - sr-only text per row: merge parents / current checkout / worktree ring / folded lane /
    out-of-set parent (#14) — the topology reads without the SVG.
  - The hash cell IS the copy button (§4.3: no 32px CopyButton — the cell is full-height,
    ≥32px under coarse pointers via `--gg-row-min`); `useClipboard` + a local sr-only
    `role="status"` region announce the result (CopyButton's pattern, tray-local precedent).

  - wtgraph.files.v1 (only when the hub declared the cap — otherwise rows stay inert and the
    DOM is byte-identical): a commit row is a disclosure control (click / Enter / Space,
    `tabindex=0`, `aria-expanded`, `aria-label` from `graph.rowToggle` — the row KEEPS its
    implicit `role="row"`; see `rowAttrs` for why not `role="button"`); the open row gets ONE
    detail row right below it listing the
    commit's changed files (status badge, `+add −del`, path — left-ellipsized, full path on
    `title`), with loading / error+retry / empty states. The detail row carries NO `data-row`,
    so the lane measurement skips it: the SVG's row centers stay the commit rows' own centers
    (lines simply stretch across the inserted row), the lane cell's rowspan grows by one, and
    the pitch is taken from a row pair that does not straddle the open row.

  No v-html, no <Transition>, no rAF, no createObjectURL; plain-text interpolation only.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import {
  commitDateParts,
  foldLayout,
  formatCommitDate,
  GRAPH_LANE_LIMIT_DESKTOP,
  GRAPH_LANE_LIMIT_MOBILE,
  layoutGraph,
  refChipsOf,
  rowLaneExtent,
  wtRingsOf,
  type RefChip,
  type WtRing,
} from "@logic/gitGraph.js";
import type { GraphScope } from "@logic/gitGraphScope.js";
import type { WorktreeRowWire } from "@protocol/messages.js";
import { useClipboard } from "../../composables/useClipboard.js";
import { useI18n } from "../../composables/useI18n.js";
import { useWorktreeGraph } from "../../composables/useWorktreeGraph.js";
import { useCommitFiles } from "../../composables/useCommitFiles.js";
import type { WtGraphFileEntry } from "@protocol/worktree-graph.js";
import type { WorktreeGraphTransport } from "../../transport/types.js";
import GraphLanes from "./GraphLanes.vue";
import { foldMerged, mergedBadgeOf, mergedViewOf, type MergedBadge } from "@logic/gitGraphMerged.js";
import "../../styles/graph.css";

const { t, lang } = useI18n();

const props = defineProps<{
  /** The §4.3 graph scope (`wtgraphScopeOf`), as a plain object (panel-computed). */
  readonly scope: GraphScope;
  /** The picked worktree path (`pickGraphWt`) — the request's `wt` input. */
  readonly wt: string;
  /** The transport (`UseHubHandle.worktreeGraph`) — absent ⇒ nothing renders. */
  readonly transport?: WorktreeGraphTransport | undefined;
  /** The panel's `StatusInfo` rows (label lookup for worktree rings). */
  readonly rows: readonly WorktreeRowWire[];
  /** §4.3/§0.2 Q3: the ≤480px verdict from the panel's injected `useMedia`. */
  readonly mobile: boolean;
  /** Parent-owned disclosure state; the graph keeps its data while collapsed. */
  readonly expanded?: boolean;
  /** Test seam (#8): when set, these centers are used verbatim and no measurement runs. */
  readonly injectedCenters?: readonly number[];
}>();

const state = useWorktreeGraph({
  transport: props.transport,
  scope: computed(() => props.scope),
  wt: computed(() => props.wt),
});
const files = useCommitFiles({
  transport: props.transport,
  scope: computed(() => props.scope),
  wt: computed(() => props.wt),
});
defineExpose({ state, toggle: state.toggle, expanded: state.expanded, files });

// D13's graph twin: every status frame re-samples the rows — an expanded graph re-pulls
// (debounced in the composable) when `graphSigOf` moves.
watch(
  () => props.rows,
  (next) => state.onRowsChanged(next),
);
watch(
  () => props.expanded,
  (isExpanded) => {
    if (isExpanded === true && !state.expanded.value) state.toggle();
    if (isExpanded === false && state.expanded.value) state.toggle();
  },
  { immediate: true },
);

const payload = computed(() => (state.state.value.phase === "ok" ? state.state.value.data : undefined));

// ---------------------------------------------------------------------------
// layout (§4.1) + fold (#6) — recomputed only on a new payload / lane-limit change
// ---------------------------------------------------------------------------

const laneLimit = computed(() => (props.mobile ? GRAPH_LANE_LIMIT_MOBILE : GRAPH_LANE_LIMIT_DESKTOP));

// ---------------------------------------------------------------------------
// merged branches (merged-plan r3 §7.2/§7.3): patch-equivalence annotation + the default
// fold of「已合入」branches. The logic lives in `@logic/gitGraphMerged.js` (P3, same lazy
// chunk); every merged DOM addition is gated so the §7.5 invariance conditions render
// byte-identical to the baseline. `showMerged` is NEVER persisted (F3) — a refresh or a
// remount returns to the default fold; the component stays mounted while collapsed, so a
// same-page collapse/re-expand keeps the choice.
// ---------------------------------------------------------------------------

const showMerged = ref(false);
const mview = computed(() => (payload.value === undefined ? null : mergedViewOf(payload.value, props.rows)));
const mergedFold = computed(() =>
  payload.value === undefined || mview.value === null ? null : foldMerged(payload.value, mview.value, showMerged.value),
);
/** The fold-filtered commit list (identical to `payload.commits` whenever nothing folds). */
const graphCommits = computed(() => mergedFold.value?.commits ?? payload.value?.commits ?? []);

const layout = computed(() => (payload.value === undefined ? null : layoutGraph(graphCommits.value)));

const fold = computed(() => (layout.value === null ? null : foldLayout(layout.value, laneLimit.value)));

/** The payload's own `n` caps the rendered rows (the parser pins it to WTGRAPH_N). */
const commits = computed(() => (payload.value === undefined ? [] : graphCommits.value.slice(0, payload.value.n)));

// ---------------------------------------------------------------------------
// commit files (wtgraph.files.v1) — one open row, its detail row right below
// ---------------------------------------------------------------------------

// a new visible window OR a completed graph pull (even one returning identical data — the
// stale-oid retry path relies on it) re-validates the open row
watch([commits, () => state.state.value], ([next, st]) => {
  if (st.phase === "ok" && st.refreshing !== true) files.onCommitsChanged(next.map((c) => c.h));
});

/** Row index of the open commit among the RENDERED rows (-1 = none open / not visible). */
const openIdx = computed(() => {
  const h = files.open.value;
  return h === null ? -1 : commits.value.findIndex((c) => c.h === h);
});
/** The detail row spans every column right of the (rowspanned) lane cell. */
const filesColspan = computed(() => (props.mobile ? 2 : 4));

/** Disclosure attributes for a commit row — EMPTY when the cap is absent (byte-identical DOM). */
function rowAttrs(h: string): Record<string, string> {
  if (!files.enabled.value) return {};
  const open = files.open.value === h;
  return {
    tabindex: "0",
    // a11y: the row keeps its implicit role="row" — ARIA-in-HTML does not allow role="button"
    // on <tr>, and overriding the role would strip the row out of the table's row/cell
    // structure (screen readers would stop announcing it as a table row). The disclosure
    // instead rides the named-focusable-row pattern: tabindex + aria-label (the per-row name,
    // `graph.rowToggle`) + aria-expanded — a state role=row supports (cf. treegrid rows). In
    // browse mode the row's own cells still read; the label names the toggle when focused.
    "aria-label": t("graph.rowToggle", { hash: h }),
    "aria-expanded": open ? "true" : "false",
    ...(open ? { "aria-controls": `gg-files-${h}` } : {}),
    "data-toggle": "",
  };
}

function onRowClick(ev: MouseEvent, h: string): void {
  if (!files.enabled.value) return;
  const target = ev.target as Element | null;
  if (target !== null && typeof target.closest === "function" && target.closest("button, a") !== null) return;
  // a drag-selection of the subject text is not a click
  const sel = typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
  if (sel !== null && !sel.isCollapsed && sel.toString() !== "") return;
  files.toggle(h);
}

function onRowKey(ev: KeyboardEvent, h: string): void {
  if (!files.enabled.value || ev.target !== ev.currentTarget) return;
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    files.toggle(h);
  }
}

const fileStateOf = (h: string) => files.states.value.get(h);

function filesErrorText(h: string): string {
  const err = fileStateOf(h)?.error;
  if (err === undefined) return "";
  if (err.code === "E_STALE_CTX") return t("graph.filesErrStale");
  if (err.code === "E_BUSY" || err.code === "E_RATE") return t("graph.filesErrBusy");
  if (err.reason === "filter-config") return t("graph.filesErrFilter");
  if (err.reason === "missing-object") return t("graph.filesErrMissing");
  return t("graph.filesErrGeneric", { code: err.code });
}

/** The error button: a stale oid needs a fresh graph (the files fetch re-runs after it). */
function filesRetry(h: string): void {
  if (fileStateOf(h)?.error?.code === "E_STALE_CTX") state.refresh();
  else files.retry(h);
}

function statusTitle(e: WtGraphFileEntry): string {
  if (e.status === "R") return t("graph.statusR", { orig: e.orig ?? "" });
  if (e.status === "A") return t("graph.statusA");
  if (e.status === "D") return t("graph.statusD");
  if (e.status === "T") return t("graph.statusT");
  return t("graph.statusM");
}

/** The detail row's text starts just right of the lane SVG (lines keep running through the
 *  row). 2026-10-28 user preview: `svgW + 6` read as one notch too deep — pull it back so the
 *  text edge sits 2px right of the lane cell, not 6px right of the (already padded) SVG. */
const filesIndent = computed(() => ({ paddingLeft: `${Math.max(0, svgW.value - 4)}px` }));

/** §7.3 badges: one per visible eq/part tip (never on ≤480px, where only the HEAD chip
 *  survives — Q3). Computed once per payload, not per row render. */
const badgeMap = computed(() => {
  const map = new Map<string, MergedBadge>();
  const p = payload.value;
  const v = mview.value;
  if (p === undefined || v === null || props.mobile) return map;
  for (const c of commits.value) {
    const b = mergedBadgeOf(p, v, c.h);
    if (b !== null) map.set(c.h, b);
  }
  return map;
});
const badgeText = (b: MergedBadge): string =>
  b.kind === "eq" ? t("graph.mergedBadge") : t("graph.mergedBadgePart", { k: b.k, t: b.t });
/** §7.3 tooltip: the patch-id verdict + the cherry-pick caveat; `eP` appends the
 *  incomplete-window-marks note. */
const badgeTitle = (b: MergedBadge): string => {
  const head = payload.value?.head?.b ?? "HEAD";
  const base =
    b.kind === "eq" ? t("graph.mergedTitle", { t: b.t, head }) : t("graph.mergedTitlePart", { k: b.k, t: b.t, head });
  const partial = payload.value?.merged?.branches.some((e) => e.eP === true && b.branches.includes(e.n)) === true;
  return partial ? base + t("graph.mergedTitlePartial") : base;
};

/** §7.3 landed rows: eq targets' window-only commits ∪ part's explicit `e` — color only. */
const isLanded = (h: string): boolean => mview.value?.landed.has(h) === true;
const landedRows = computed(() => commits.value.map((c) => isLanded(c.h)));

/** §7.3 footnote tokens (compact markers, English-only in both locales). */
const mergedHiddenNow = computed(() => mergedFold.value?.hiddenNow.length ?? 0);
const mergedWouldHide = computed(() => mergedFold.value?.wouldHide.length ?? 0);
const mergedFootUnknown = computed(() => {
  const m = payload.value?.merged;
  if (m === undefined) return "";
  if (m.skipped !== undefined) return t("graph.footMergedUnknown", { m: "skipped" });
  const unk = m.branches.filter((b) => b.v === "unk").length;
  return unk > 0 ? t("graph.footMergedUnknown", { m: unk }) : "";
});
/** §7.2: set only when eq targets exist AND the fold is blocked by incomplete information. */
const foldBlocked = computed(() => mview.value?.foldBlocked !== undefined);

const isMerge = (i: number): boolean => (commits.value[i]?.p.length ?? 0) > 1;
const isCurrent = (h: string): boolean => payload.value?.head?.h === h;

/** §4.2: ≤3 chips + `+n` per row; ≤480px keeps ONLY the HEAD chip (Q3). */
function chipsOf(h: string): RefChip[] {
  if (payload.value === undefined) return [];
  const all = refChipsOf(payload.value, h);
  if (props.mobile) {
    const head = all.find((c) => c.kind === "head");
    return head === undefined ? [] : [head];
  }
  return all.slice(0, 3);
}
const chipOverflow = (h: string): number => {
  if (payload.value === undefined || props.mobile) return 0;
  return Math.max(0, refChipsOf(payload.value, h).length - 3);
};
/** The `+n` chip's `title`: every hidden chip's full name. */
const chipTitle = (h: string): string =>
  payload.value === undefined
    ? ""
    : refChipsOf(payload.value, h)
        .map((x) => x.text)
        .join(", ");

function ringsOf(h: string): WtRing[] {
  if (payload.value === undefined) return [];
  return wtRingsOf(payload.value, h, props.rows);
}

const dateOf = (tSec: number): string => formatCommitDate(tSec, lang, commitDateParts);

// ---------------------------------------------------------------------------
// degrade footnote (§4.3 degraded state: every §2.5 marker its own line)
// ---------------------------------------------------------------------------

const degradeNotes = computed<string[]>(() => {
  const p = payload.value;
  if (p === undefined) return [];
  const d = p.degrade;
  const out: string[] = [];
  if (d.logCapped === true) out.push(t("graph.degLogCapped"));
  if (d.badRecords !== undefined) out.push(t("graph.degBadRecords", { n: d.badRecords }));
  if (d.parentsTruncated !== undefined) out.push(t("graph.degParentsTruncated", { n: d.parentsTruncated }));
  if (d.refsTruncated === true) out.push(t("graph.degRefsTruncated", { n: 2000 }));
  if (d.refsSkipped !== undefined) out.push(t("graph.degRefsSkipped", { n: d.refsSkipped }));
  if (d.refsOmitted !== undefined) out.push(t("graph.degRefsOmitted", { n: d.refsOmitted }));
  if (d.trimmed !== undefined) out.push(t("graph.degTrimmed", { n: d.trimmed }));
  if (d.wtHeadsCapped === true) out.push(t("graph.degWtHeadsCapped"));
  if (p.shallow === true) out.push(t("graph.degShallow"));
  return out;
});

/** §4.3 state verdict — degraded beats empty (zero commits but incomplete is NOT「暂无提交」). */
type Phase = "loading" | "ready" | "empty" | "degraded" | "error";
const phase = computed<Phase>(() => {
  const s = state.state.value;
  if (s.phase === "error") return "error";
  if (s.data === undefined) return "loading"; // first pull, nothing visible yet
  const p = s.data;
  if (p.empty === true && p.complete && p.commits.length === 0) return "empty";
  if (!p.complete || p.commits.length === 0) return "degraded";
  return "ready";
});

/** §4.3 error copy: per-reason first, raw-code fallback last. */
const errorText = computed(() => {
  const err = state.state.value.error;
  if (err === undefined) return "";
  if (err.reason === "log-timeout") return t("graph.errLogTimeout");
  if (err.reason === "missing-object") return t("graph.errMissingObject");
  if (err.reason === "git-too-old") return t("graph.errGitTooOld");
  if (err.reason === "git-failed") return t("graph.errGitFailed");
  if (err.reason === "not-worktree") return t("graph.errNotWorktree");
  if (err.reason === "session-changed") return t("graph.errSessionChanged");
  if (err.code === "E_BUSY") return t("graph.errBusy");
  return t("graph.errGeneric", { code: err.code });
});

// ---------------------------------------------------------------------------
// measured row centers (#8) — ResizeObserver on tbody, no rAF
// ---------------------------------------------------------------------------

const tbodyEl = shallowRef<HTMLElement | null>(null);
const centers = ref<number[]>([]);
const rowH = ref(22);
let ro: ResizeObserver | null = null;

function measure(): void {
  const el = tbodyEl.value;
  if (el === null) return;
  const base = el.getBoundingClientRect().top;
  const out: number[] = [];
  let first = 0;
  el.querySelectorAll("tr[data-row]").forEach((tr) => {
    const r = (tr as HTMLElement).getBoundingClientRect();
    out.push(r.top - base + r.height / 2);
    if (first === 0) first = r.height;
  });
  if (out.length !== centers.value.length || out.some((y, i) => y !== centers.value[i])) centers.value = out;
  if (first > 0) rowH.value = first;
}

function observe(): void {
  ro?.disconnect();
  ro = null;
  const el = tbodyEl.value;
  if (el === null || typeof ResizeObserver === "undefined") return;
  ro = new ResizeObserver(() => measure());
  ro.observe(el);
  measure();
}

watch(
  [
    tbodyEl,
    () => state.state.value.data,
    laneLimit,
    () => props.mobile,
    () => files.open.value,
    () => files.states.value,
  ],
  () => {
    void nextTick(observe);
  },
  { immediate: true, flush: "post" },
);

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});

/** Effective centers: the injected seam wins (tests), else the measured ones. */
const effCenters = computed<readonly number[]>(() =>
  props.injectedCenters !== undefined && props.injectedCenters.length > 0 ? props.injectedCenters : centers.value,
);

/** Row pitch: adjacent measured centers when they exist, else the measured row height. */
const pitch = computed(() => {
  const c = effCenters.value;
  // the first adjacent pair that does NOT straddle an open commit's detail row (none open ⇒
  // exactly the old c[1] − c[0])
  for (let k = 0; k + 1 < c.length; k++) {
    if (k === openIdx.value) continue;
    const dy = c[k + 1]! - c[k]!;
    if (dy > 0) return dy;
    break;
  }
  return rowH.value > 0 ? rowH.value : 22;
});

/** §4.3: lane spacing = `round(pitch × 14/22)`; the dot radius scales the same way (below). */
const laneGap = computed(() => Math.round((pitch.value * 14) / 22));
const dotRadius = computed(() => (3.5 * pitch.value) / 22);

const usedLanes = computed(() => {
  if (layout.value === null) return 0;
  return Math.max(1, Math.min(layout.value.laneCount, laneLimit.value));
});
const hasFold = computed(() => fold.value?.folded === true);
/** Fold column x — just right of the last visible lane. */
const foldX = computed(() => 8 + usedLanes.value * laneGap.value + 2);
const svgW = computed(() => foldX.value + (hasFold.value ? laneGap.value : 8));
const svgH = computed(() => {
  const c = effCenters.value;
  const last = c[c.length - 1];
  return last === undefined ? 0 : last + pitch.value / 2 + 4;
});

/** Lane x-mapper: visible lanes step by `laneGap`; ≥ limit folds into the fold column. */
const laneX = (lane: number): number =>
  fold.value !== null && lane >= laneLimit.value ? foldX.value : 8 + lane * laneGap.value;

/** The SVG's global width token — one `--gg-w` custom property via `:style` object binding
 *  (QuotaCard.vue precedent; static `style=` attributes are banned, bindings are not). */
const laneStyle = computed(() => ({ "--gg-w": `${svgW.value}px` }));
const rowExtents = computed(() =>
  fold.value === null ? [] : rowLaneExtent(fold.value, commits.value.length, laneX, foldX.value),
);
const subjectStyle = (row: number): Record<string, string> => ({
  paddingLeft: `${(rowExtents.value[row] ?? 0) + dotRadius.value + 10}px`,
});

/** A commit's out-of-set parents (root or beyond-N) — the row's stub rows in the raw layout. */
const stubRows = computed(() => {
  const set = new Set<number>();
  if (layout.value !== null) for (const s of layout.value.stubs) set.add(s.from);
  return set;
});

// ---------------------------------------------------------------------------
// hash copy (§4.3 — the cell is the button)
// ---------------------------------------------------------------------------

const copyFeedback = ref<Record<number, "copied" | "selected">>({});
let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copyHash(i: number, h: string): Promise<void> {
  const clipboard = useClipboard(window);
  const res = await clipboard.copy(h);
  copyFeedback.value = { ...copyFeedback.value, [i]: res.ok ? "copied" : "selected" };
  if (resetTimer !== undefined) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    copyFeedback.value = {};
  }, 2000);
}
onBeforeUnmount(() => {
  if (resetTimer !== undefined) clearTimeout(resetTimer);
});
</script>

<template>
  <section
    v-if="state.expanded.value"
    class="gg"
    :data-phase="phase"
    :aria-busy="state.state.value.refreshing === true ? 'true' : undefined"
  >
    <!-- §4.3 five states: loading / error first (no data to keep), then the data states -->
    <p v-if="phase === 'loading'" class="gg-state" role="status">{{ t("graph.loading") }}</p>

    <div v-else-if="phase === 'error'" class="gg-error" role="alert">
      <p class="gg-error-title">{{ t("graph.errorTitle") }}</p>
      <p class="gg-error-text">{{ errorText }}</p>
      <button class="btn gg-retry" type="button" @click="state.refresh()">{{ t("graph.retry") }}</button>
    </div>

    <template v-else>
      <p v-if="phase === 'empty'" class="gg-state">{{ t("graph.empty") }}</p>

      <template v-else>
        <!-- degraded (§4.3): every §2.5 marker its own footnote line; zero-commits-but-
             incomplete shows「已降级」here — never「暂无提交」(the empty verdict above requires
             empty && complete) -->
        <div v-if="phase === 'degraded'" class="gg-degrade" role="status">
          <p class="gg-degrade-title">{{ t("graph.degradedTitle") }}</p>
          <p v-for="(note, i) in degradeNotes" :key="i" class="gg-degrade-note">{{ note }}</p>
        </div>

        <!-- §7.3 merged bar: only when branches would actually hide (foldBlocked ⇒ P3's
             foldMerged reports wouldHide:[] and the bar stays out — the `fold off`
             footnote carries the state instead) -->
        <div v-if="mergedWouldHide > 0" class="gg-merged-bar">
          <button
            class="gg-merged-toggle"
            type="button"
            :aria-pressed="showMerged === true ? 'true' : 'false'"
            @click="showMerged = !showMerged"
          >
            {{
              showMerged ? t("graph.mergedHide", { n: mergedWouldHide }) : t("graph.mergedShow", { n: mergedWouldHide })
            }}
          </button>
        </div>

        <div v-if="commits.length > 0" class="gg-viewport" :style="laneStyle">
          <table class="gg-table" :class="{ 'is-mobile': mobile }">
            <caption class="sr-only">
              {{
                t("graph.caption")
              }}
            </caption>
            <colgroup>
              <col class="gg-col-lanes" />
              <col />
              <col v-if="!mobile" class="gg-col-date" />
              <col v-if="!mobile" class="gg-col-author" />
              <col class="gg-col-hash" />
            </colgroup>
            <tbody ref="tbodyEl">
              <template v-for="(c, i) in commits" :key="c.h">
                <tr
                  data-row
                  :class="{ 'is-merge': isMerge(i), 'is-landed': isLanded(c.h), 'is-open': files.open.value === c.h }"
                  :data-current="isCurrent(c.h) === true ? 'true' : undefined"
                  v-bind="rowAttrs(c.h)"
                  @click="onRowClick($event, c.h)"
                  @keydown="onRowKey($event, c.h)"
                >
                  <td
                    v-if="i === 0 && fold !== null"
                    class="gg-lanes"
                    :rowspan="commits.length + (openIdx >= 0 ? 1 : 0)"
                    aria-hidden="true"
                  >
                    <GraphLanes
                      :fold="fold"
                      :centers="effCenters"
                      :merges="commits.map((_, index) => isMerge(index))"
                      :lane-x="laneX"
                      :pitch="pitch"
                      :fold-x="foldX"
                      :dot-radius="dotRadius"
                      :width="svgW"
                      :height="svgH"
                      :landed="landedRows"
                    />
                  </td>
                  <td class="gg-cell gg-subject" :title="c.s" :style="subjectStyle(i)">
                    <span class="gg-refs">
                      <span
                        v-for="chip in chipsOf(c.h)"
                        :key="chip.text"
                        class="gg-ref"
                        :class="[`k-${chip.kind}`, { 'is-sym': chip.sym === true }]"
                        :title="chip.text"
                        translate="no"
                        >{{ chip.text }}</span
                      >
                      <!-- §7.3 merged badge: after the branch chips, before `+n`, outside the
                         ≤3-chip quota; suppressed entirely on ≤480px (badgeMap is empty) -->
                      <span v-if="badgeMap.has(c.h)" class="gg-mbadge" :title="badgeTitle(badgeMap.get(c.h)!)">{{
                        badgeText(badgeMap.get(c.h)!)
                      }}</span>
                      <span v-if="chipOverflow(c.h) > 0" class="gg-ref gg-ref-overflow" :title="chipTitle(c.h)"
                        >+{{ chipOverflow(c.h) }}</span
                      >
                      <span
                        v-for="ring in ringsOf(c.h)"
                        :key="`wt-${ring.path}`"
                        class="gg-wtbadge"
                        :class="{ 'is-self': ring.self }"
                        :title="t('graph.srRing', { label: ring.label })"
                        ><span class="dot" aria-hidden="true"></span>{{ ring.label }}</span
                      >
                    </span>
                    <span class="gg-sub" translate="no">{{ c.s }}</span>
                    <!-- sr-only topology (#14): merge parents / current checkout / worktree
                       ring / folded lane / out-of-set parent — readable without the SVG -->
                    <span class="sr-only">
                      <template v-if="isMerge(i)"
                        >{{ t("graph.srMerge", { parents: c.p.map((p) => p.slice(0, 7)).join(", ") }) }}
                      </template>
                      <template v-if="isCurrent(c.h)">{{ t("graph.srCurrent") }} </template>
                      <template v-for="ring in ringsOf(c.h)" :key="`sr-${ring.path}`"
                        >{{ t("graph.srRing", { label: ring.label }) }}
                      </template>
                      <template v-if="fold !== null && (fold.nodes[i]?.folded ?? false)"
                        >{{ t("graph.srFold") }}
                      </template>
                      <template v-if="isLanded(c.h)">{{ t("graph.srLanded") }} </template>
                      <template v-if="stubRows.has(i)">{{ t("graph.srOutOfSet") }}</template>
                    </span>
                  </td>
                  <td v-if="!mobile" class="gg-cell gg-date" translate="no">{{ dateOf(c.t) }}</td>
                  <td v-if="!mobile" class="gg-cell gg-author" translate="no">{{ c.a }}</td>
                  <td class="gg-cell gg-hashcell">
                    <button
                      class="gg-hash"
                      type="button"
                      :aria-label="t('graph.copyHash', { hash: c.h })"
                      :title="t('graph.copyHash', { hash: c.h })"
                      translate="no"
                      @click="copyHash(i, c.h)"
                    >
                      {{ c.h.slice(0, 7) }}
                    </button>
                    <span class="sr-only" role="status">{{
                      copyFeedback[i] === "copied"
                        ? t("graph.copiedHash")
                        : copyFeedback[i] === "selected"
                          ? t("graph.selectedHash")
                          : ""
                    }}</span>
                  </td>
                </tr>
                <!-- wtgraph.files.v1 detail row: NO data-row (the lane measurement skips it) -->
                <tr v-if="files.enabled.value && files.open.value === c.h" class="gg-files-row">
                  <td :id="`gg-files-${c.h}`" class="gg-files-cell" :colspan="filesColspan" :style="filesIndent">
                    <div v-if="fileStateOf(c.h)?.phase === 'error'" class="gg-files-error" role="alert">
                      <span class="gg-files-error-title">{{ t("graph.filesErrorTitle") }}</span>
                      <span class="gg-files-error-text">{{ filesErrorText(c.h) }}</span>
                      <button class="btn gg-files-retry" type="button" @click="filesRetry(c.h)">
                        {{
                          fileStateOf(c.h)?.error?.code === "E_STALE_CTX"
                            ? t("graph.filesRefreshGraph")
                            : t("graph.filesRetry")
                        }}
                      </button>
                    </div>
                    <template v-else-if="fileStateOf(c.h)?.phase === 'ok' && fileStateOf(c.h)?.data !== undefined">
                      <p class="gg-files-meta">
                        <span translate="no">{{ t("graph.filesCount", { n: fileStateOf(c.h)!.data!.total }) }}</span
                        ><template v-if="c.p.length > 1"> · {{ t("graph.filesMergeNote") }}</template
                        ><template v-else-if="c.p.length === 0 && fileStateOf(c.h)!.data!.shallow !== true">
                          · {{ t("graph.filesRootNote") }}</template
                        ><template v-if="fileStateOf(c.h)!.data!.shallow === true">
                          · {{ t("graph.filesShallowNote") }}</template
                        >
                      </p>
                      <p v-if="fileStateOf(c.h)!.data!.entries.length === 0" class="gg-files-state">
                        {{ t("graph.filesEmpty") }}
                      </p>
                      <ul v-else class="gg-files-list">
                        <li v-for="(e, fi) in fileStateOf(c.h)!.data!.entries" :key="`${fi}:${e.path}`" class="gg-file">
                          <span class="gg-fst" :class="`s-${e.status}`" :title="statusTitle(e)" translate="no">{{
                            e.status
                          }}</span>
                          <span class="gg-fnum" translate="no"
                            ><template v-if="e.binary === true">{{ t("graph.filesBinary") }}</template
                            ><template v-else-if="e.add !== undefined"
                              ><span class="gg-fadd">+{{ e.add }}</span>
                              <span class="gg-fdel">−{{ e.del }}</span></template
                            ></span
                          >
                          <span
                            class="gg-fpath"
                            :title="e.orig !== undefined ? `${e.orig} → ${e.path}` : e.path"
                            translate="no"
                            ><bdi dir="ltr">{{ e.path }}</bdi></span
                          >
                        </li>
                      </ul>
                      <p v-if="fileStateOf(c.h)!.data!.truncated" class="gg-files-state">
                        {{
                          fileStateOf(c.h)!.data!.limits.output
                            ? t("graph.filesTruncatedOutput")
                            : t("graph.filesTruncated", {
                                shown: fileStateOf(c.h)!.data!.entries.length,
                                total: fileStateOf(c.h)!.data!.total,
                              })
                        }}
                      </p>
                    </template>
                    <p v-else class="gg-files-state" role="status">
                      <span class="gg-spinner" aria-hidden="true"></span>{{ t("graph.filesLoading") }}
                    </p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>

      <!-- §4.3 standing footnote (compact marker tokens, English-only per the UI rule) -->
      <p class="gg-foot">
        {{ t("graph.footNote", { n: state.state.value.data?.n ?? 200 })
        }}<template v-if="state.state.value.data?.degrade.more === true">
          · {{ t("graph.footMore", { n: state.state.value.data.n }) }}</template
        ><template v-if="mergedHiddenNow > 0"> · {{ t("graph.footMergedHidden", { n: mergedHiddenNow }) }}</template
        ><template v-if="mergedFootUnknown !== ''"> · {{ mergedFootUnknown }}</template
        ><template v-if="foldBlocked"> · {{ t("graph.footFoldOff") }}</template>
      </p>
    </template>
  </section>
</template>
