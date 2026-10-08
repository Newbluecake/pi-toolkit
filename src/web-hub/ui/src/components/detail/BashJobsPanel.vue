<!--
  Background bash-jobs panel (bash-jobs-panel plan §3 包 B / D4): a read-only summary of the
  session's own background bash jobs, fed by `StatusInfo.bashJobs` (包 A0 wire) via
  `bashJobsOf(agent)` in `DetailHeader` — no `state.js` mirror, no `types.ts` change (same
  posture as `WorktreePanel`). Collapsed by default: the one-line summary (`bash 2 running ·
  5 done · 1 failed`, English tokens in BOTH locales per the AGENTS.md UI-text rule) is the
  glance surface; expanding lists every row with a status icon, short id, the redacted cmd
  (mono, single-line ellipsis, full redacted text on `title`), status token, `exit N` /
  `grace` chips, locally-ticking elapsed, `logBytes` (`+` when the tail view starts mid-file)
  and the agent-judged freshness marker (`sampling…` / `tail Ns old` / `unavailable` /
  `no output yet` — read off `tailCurrent`/`tailUnavailable`, D3-3, the UI never compares
  clocks/bytes itself).

  Rows with a `tail` are buttons: clicking expands a `<pre>` with the tail as PLAIN TEXT
  (never `v-html` — source-scan bans it repo-wide; the tail is redacted agent-side but is
  still arbitrary process output; redaction is best-effort hygiene, NOT a security boundary —
  D2a, its standing UI hint was dropped by user ruling 2026-10-08). The expanded list ends
  with an `(+N more)` line when the wire carries `omitted`.

  Elapsed 走时 baseline (D4, same grammar as FleetTree's tickBaselines): a Map keyed by job
  id holds `{elapsedMs, at}`; a new wire frame (the row's `elapsedMs` changes) resets `at` to
  the shared now, and the display adds `max(0, now - at)`. Terminal rows show the wire's
  frozen `elapsedMs` directly. Baselines are pruned when the row set shrinks, and the
  1 Hz ticker (`useTicker` — hidden-page-aware, never requestAnimationFrame) only exists
  while at least one row is live (`staged`/`running`); it is disposed on unmount.

  Fold state is a plain local ref — NOT persisted across reloads, same precedent as
  `TodoPanel`/`WorktreePanel` (source-scan.test.ts's persistence allowlist doesn't cover this
  component). Styles live in `styles/bash-jobs.css` (imported below), not scoped `<style>` —
  source-scan bans `<style>` blocks outright. No `logPath`, no CopyButton anywhere (plan v2
  #2: the path never crosses the wire; the settlement notification card already carries it).
-->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useTicker, type TickerHandle } from "../../composables/useTicker.js";
import { formatDuration } from "../../format.js";
import type { BashJobRowWire, BashJobsWire } from "@protocol/messages.js";
import { formatBytes, statusToken, summaryCounts, tailFreshness, type TailFreshness } from "./bashJobsView.js";
import "../../styles/bash-jobs.css";

// Deliberately local props interface (same escape hatch as TodoPanel/WorktreePanel):
// contracts.ts is owned by another in-flight line and `BashJobsWire` comes straight from
// `@protocol/messages.js`.
const props = defineProps<{ readonly jobs: BashJobsWire }>();
const { t } = useI18n();

const open = ref(false);
/** At most one row's tail is expanded at a time (the wire caps rows at 20 — no fold math needed). */
const expandedId = ref<string | null>(null);

// ---------------------------------------------------------------------------
// collapsed summary (D4): `bash 2 running · 5 done · 1 failed`, zero segments omitted
// ---------------------------------------------------------------------------
const counts = computed(() => summaryCounts(props.jobs));
const summary = computed(() => {
  const c = counts.value;
  const segments: string[] = [];
  if (c.running > 0) segments.push(t("detail.bashJobsRunning", { n: c.running }));
  if (c.done > 0) segments.push(t("detail.bashJobsDone", { n: c.done }));
  if (c.failed > 0) segments.push(t("detail.bashJobsFailed", { n: c.failed }));
  // `bash 2 running · 5 done · 1 failed` — the title prefix joins with a space, segments with ` · `.
  return segments.length > 0 ? `${t("detail.bashJobsTitle")} ${segments.join(" · ")}` : t("detail.bashJobsTitle");
});
/** Prose aria-label for the toggle (the visible summary is English tokens only). */
const toggleAria = computed(() => t("detail.bashJobsSummary", { ...counts.value }));

// ---------------------------------------------------------------------------
// elapsed 走时 (D4): per-row baseline Map + a ticker that only exists while a row is live
// ---------------------------------------------------------------------------
const hasLive = computed(() => props.jobs.rows.some((row) => statusToken(row).live));
const nowMs = ref(Date.now());
let ticker: TickerHandle | null = null;
let stopNowBridge: (() => void) | null = null;

function stopTicker(): void {
  stopNowBridge?.();
  stopNowBridge = null;
  ticker?.dispose();
  ticker = null;
}

watch(
  hasLive,
  (live) => {
    if (live && ticker === null) {
      const handle = useTicker({
        doc: document,
        win: window,
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h),
        now: () => Date.now(),
      });
      ticker = handle;
      nowMs.value = handle.now.value;
      stopNowBridge = watch(handle.now, (v) => {
        nowMs.value = v;
      });
    } else if (!live) {
      stopTicker();
    }
  },
  { immediate: true },
);
onUnmounted(stopTicker);

/** Baseline per job id (FleetTree grammar): a row's wire `elapsedMs` changing means a new
 * frame arrived — reset `at` to the shared now so the local tick continues from the fresh
 * value instead of double-counting the frame gap. */
const tickBaselines = new Map<string, { elapsedMs: number; at: number }>();
watch(
  () => props.jobs.rows,
  (rows) => {
    const alive = new Set<string>();
    for (const row of rows) {
      const id = String(row.id);
      alive.add(id);
      const elapsed = typeof row.elapsedMs === "number" ? row.elapsedMs : 0;
      const b = tickBaselines.get(id);
      if (b === undefined || b.elapsedMs !== elapsed) tickBaselines.set(id, { elapsedMs: elapsed, at: nowMs.value });
    }
    for (const key of [...tickBaselines.keys()]) if (!alive.has(key)) tickBaselines.delete(key);
    if (expandedId.value !== null && !alive.has(expandedId.value)) expandedId.value = null;
  },
  { immediate: true },
);

function displayElapsed(row: BashJobRowWire): string {
  const elapsed = typeof row.elapsedMs === "number" ? row.elapsedMs : 0;
  if (!statusToken(row).live) return formatDuration(elapsed);
  const b = tickBaselines.get(String(row.id)) ?? { elapsedMs: elapsed, at: nowMs.value };
  return formatDuration(b.elapsedMs + Math.max(0, nowMs.value - b.at));
}

// ---------------------------------------------------------------------------
// row rendering helpers
// ---------------------------------------------------------------------------
function shortId(row: BashJobRowWire): string {
  return String(row.id).slice(0, 8);
}

function bytesLabel(row: BashJobRowWire): string {
  return formatBytes(row.logBytes) + (row.logTruncated === true ? "+" : "");
}

function freshnessOf(row: BashJobRowWire): TailFreshness {
  return tailFreshness(row, props.jobs.sampledAt);
}

function freshnessText(row: BashJobRowWire): string | null {
  const f = freshnessOf(row);
  switch (f.kind) {
    case "current":
      return null;
    case "sampling":
      return t("detail.bashJobsSampling");
    case "stale":
      return t("detail.bashJobsTailAge", { n: f.ageSec });
    case "unavailable":
      return t("detail.bashJobsUnavailable");
    case "empty":
      return t("detail.bashJobsNoOutput");
  }
}

function toggleRow(row: BashJobRowWire): void {
  if (row.tail === undefined) return;
  const id = String(row.id);
  expandedId.value = expandedId.value === id ? null : id;
}
</script>

<template>
  <section class="bj-panel" :data-open="open" aria-readonly="true">
    <button class="bj-sum" type="button" :aria-expanded="open" :aria-label="toggleAria" @click="open = !open">
      <AppIcon name="terminal" class="icon-sm" />
      <span class="bj-sum-text">{{ summary }}</span>
      <AppIcon name="chev-right" class="icon-sm chev" />
    </button>
    <ul v-if="open" class="bj-list">
      <li v-for="row in jobs.rows" :key="row.id" class="bj-item" :data-status="statusToken(row).text">
        <button
          class="bj-row"
          type="button"
          :disabled="row.tail === undefined"
          :aria-expanded="row.tail === undefined ? undefined : expandedId === row.id"
          @click="toggleRow(row)"
        >
          <AppIcon
            :name="statusToken(row).icon"
            class="icon-sm bj-ico"
            :class="{ spin: statusToken(row).spin }"
            :data-kind="statusToken(row).kind"
          />
          <span class="bj-id" translate="no">{{ shortId(row) }}</span>
          <span class="bj-cmd" translate="no" :title="row.cmd">{{ row.cmd }}</span>
          <span class="bj-status" :data-kind="statusToken(row).kind">{{ statusToken(row).text }}</span>
          <span v-if="row.exitCode !== null" class="bj-exit num">{{
            t("detail.bashJobsExit", { n: row.exitCode })
          }}</span>
          <span v-if="row.grace === true" class="bj-chip">{{ t("detail.bashJobsGrace") }}</span>
          <span class="bj-elapsed num">{{ displayElapsed(row) }}</span>
          <span class="bj-bytes num">{{ bytesLabel(row) }}</span>
          <span v-if="freshnessText(row) !== null" class="bj-fresh" :data-kind="freshnessOf(row).kind">{{
            freshnessText(row)
          }}</span>
        </button>
        <!-- plain-text tail: arbitrary process output, never v-html / never markdown -->
        <pre v-if="expandedId === row.id && row.tail !== undefined" class="bj-tail">{{ row.tail }}</pre>
      </li>
      <li v-if="jobs.omitted !== undefined && jobs.omitted > 0" class="bj-more">
        {{ t("detail.bashJobsMore", { n: jobs.omitted }) }}
      </li>
    </ul>
  </section>
</template>
