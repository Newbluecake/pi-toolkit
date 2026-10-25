<!--
  worktree-graph plan v2 §4.3 (package P5): the lane SVG of the commit graph. Receives the
  FROZEN P3 geometry (layout + fold + measured `centers`) and renders only — every coordinate
  decision lives in `@logic/gitGraph.ts` (`pathD` / `stubPathD` take the measured row centers,
  never a computed row height, #8).

  Contract:
  - `aria-hidden="true"`: the topology essentials (merge / folded lane / out-of-set parent)
    are carried by the row's sr-only text in `WorktreeGraph.vue` (#14) — the SVG is decoration.
  - The SVG is absolutely positioned over the table's row range (`height` = last center +
    half pitch + pad); its global width rides the parent's `--gg-w` token while the table lane
    column remains zero-width.
  - Fold region (#6): a route touching any hidden lane renders NO connected path — its visible
    ends get short arrow stubs (`foldStubs`) and the fold column draws hollow diamonds on
    folded nodes plus the vertical `⋮` marks (`foldMarkRows`). NEVER a connected vertical line.
  - No rAF, no <Transition>, no createObjectURL; pure template + computed paths.
-->
<script setup lang="ts">
import { computed } from "vue";
import { pathD, stubPathD, type FoldLayout, type LaneXFn } from "@logic/gitGraph.js";

const props = defineProps<{
  /** `foldLayout(layout, laneLimit)` — P3's fold pass, computed by the parent. */
  readonly fold: FoldLayout;
  /** MEASURED row centers (px, tbody-relative) — `ResizeObserver`'s `offsetTop + h/2`. */
  readonly centers: readonly number[];
  /** Merge flags indexed by commit row, independent of the rowspan SVG's ancestor. */
  readonly merges: readonly boolean[];
  /** Lane x-coordinate mapper (lane → px); lane ≥ limit maps to the fold column. */
  readonly laneX: LaneXFn;
  /** Row pitch in px (the measured `--gg-row`), feeds `pathD`'s arc control points. */
  readonly pitch: number;
  /** Fold column x (px) — folded diamonds + ⋮ marks draw here. */
  readonly foldX: number;
  /** Commit dot radius, scaled with measured row pitch. */
  readonly dotRadius: number;
  /** SVG width (px) — the parent's lane-span width (the `--gg-w` source). */
  readonly width: number;
  /** SVG height (px) — the parent's `lastCenter + halfPitch + pad`. */
  readonly height: number;
  /** merged-plan r3 §7.3: row-indexed landed flags (patch-equivalent commits). Recolors the
   *  row's dot and every route/stub DEPARTING that row to `--gg-lane-landed` — geometry
   *  (cx/cy/r, path `d`) is provably unchanged (the §7.4 geometry test pins it). */
  readonly landed?: readonly boolean[];
}>();

/** §7.4: the landed recolor rides ONE solid token — no opacity on any `.is-landed` path. */
const LANDED_COLOR = "var(--gg-lane-landed)";
const laneColor = (color: number): string => `var(--gg-lane-${color % 8})`;
const rowLanded = (row: number): boolean => props.landed?.[row] === true;

/** Visible (non-fold) routes — P3 already filtered them to all-visible endpoints. */
const routePaths = computed(() =>
  props.fold.routes
    .map((r) => ({
      key: `r${r.from}-${r.to}-${r.lane}`,
      color: rowLanded(r.from) ? LANDED_COLOR : laneColor(r.color),
      d: pathD(r, props.fold.nodes, props.centers, props.laneX, props.pitch),
    }))
    .filter((p) => p.d !== ""),
);

/** Visible fade stubs (out-of-set parents in visible lanes). */
const stubPaths = computed(() =>
  props.fold.stubs
    .map((s) => ({
      key: `s${s.from}-${s.lane}`,
      color: rowLanded(s.from) ? LANDED_COLOR : laneColor(s.color),
      d: stubPathD(s, props.centers, props.laneX),
    }))
    .filter((p) => p.d !== ""),
);

/** Fold-boundary arrow stubs (#6): short lines at the VISIBLE endpoint of a hidden run. */
const foldStubPaths = computed(() => {
  const out: { key: string; d: string; color: string; at: string }[] = [];
  for (const f of props.fold.foldStubs) {
    const y = props.centers[f.from];
    if (y === undefined) continue;
    const x = props.laneX(f.lane);
    // a short 8px line: departing downward from the dot, arriving upward into it
    const d = f.at === "depart" ? `M ${x} ${y} L ${x} ${y + 8}` : `M ${x} ${y} L ${x} ${y - 8}`;
    out.push({
      key: `f${f.from}-${f.lane}-${f.at}`,
      d,
      color: rowLanded(f.from) ? LANDED_COLOR : laneColor(f.color),
      at: f.at,
    });
  }
  return out;
});

/** Commit dots: filled circles on visible lanes; hollow diamonds in the fold column. */
const dots = computed(() => {
  const out: { i: number; y: number; lane: number; color: string; folded: boolean }[] = [];
  props.fold.nodes.forEach((n, i) => {
    const y = props.centers[i];
    if (y !== undefined)
      out.push({ i, y, lane: n.lane, color: rowLanded(i) ? LANDED_COLOR : laneColor(n.color), folded: n.folded });
  });
  return out;
});

/** Fold-column ⋮ mark rows (the visible-lane-cap overflow indicator). */
const foldMarks = computed(() =>
  props.fold.foldMarkRows.map((row) => props.centers[row]).filter((y): y is number => y !== undefined),
);
</script>

<template>
  <svg
    class="gg-svg"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    aria-hidden="true"
    focusable="false"
  >
    <g v-for="p in routePaths" :key="p.key" class="gg-route" :style="{ color: p.color }">
      <path :d="p.d" />
    </g>
    <path v-for="p in stubPaths" :key="p.key" class="gg-stub" :d="p.d" :style="{ color: p.color }" />
    <path
      v-for="p in foldStubPaths"
      :key="p.key"
      class="gg-foldstub"
      :class="p.at === 'arrive' ? 'is-arrive' : 'is-depart'"
      :d="p.d"
      :style="{ color: p.color }"
    />
    <template v-for="d in dots" :key="`n${d.i}`">
      <circle
        v-if="!d.folded"
        class="gg-dot"
        :class="{ 'is-merge': merges[d.i] === true }"
        :cx="laneX(d.lane)"
        :cy="d.y"
        :r="dotRadius"
        :style="{ color: d.color }"
      />
      <!-- folded node (#6): hollow diamond in the fold column, never in its hidden lane -->
      <rect v-else class="gg-fold-node" :x="foldX - 4" :y="d.y - 4" width="8" height="8" :style="{ stroke: d.color }" />
    </template>
    <text v-for="(y, i) in foldMarks" :key="`fm${i}`" class="gg-fold-mark" :x="foldX" :y="y + 3.5">⋮</text>
  </svg>
</template>
