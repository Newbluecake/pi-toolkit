<!--
  Fleet drawer 的「bash」分组(2026-10-15 用户拍板 L1 前端包):主会话的后台 bash 任务从
  详情头部的 BashJobsPanel 迁到子 agent 视图 —— 抽屉树视图里、agent 树之后独立一组,组标题
  `Bash · 2 running · 8 done`(紧凑英文标记,两个语言档一致,AGENTS.md UI-text rule)。
  数据集不变:`StatusInfo.bashJobs`(agent 端投影 src/web-hub/agent/bash-jobs.ts,行选择/预算
  规则不动),由 FleetDrawer 经 `bashJobsOf(agent)`  narrowed 后传入;wire 缺失或零行 ⇒
  整个分组不渲染(旧 hub/agent 不带该字段时与现状一致)。

  与 agent 行的区分(拍板 ③):分组不参与 agent 的父子缩进/`FLEET_STATE_ICON` 状态图标体系 ——
  terminal 图标只出现在分组标题(2026-10-15 用户拍板:行内身份图标与左边框都去掉),每行以
  BashJobsPanel 原样的状态语义开头(`statusToken`:loader 旋转=running / check=done /
  x=failed / alert=timeout…,英文 token 文案),行底色与 agent 行区分。行可点击展开:完整 redacted 命令
  (纯文本)+ 日志尾 `<pre>`(PLAIN TEXT,绝不 v-html —— source-scan 全仓禁止;tail 是
  agent 端 best-effort redact 过的任意进程输出,D2a)。

  Elapsed 走时与 FleetTree 同一套语法:本组件不自带 ticker,走时由父级(FleetDrawer ←
  AgentDetail)的共享 `now` prop 驱动;以 job id 为键的 baseline Map 在 wire `elapsedMs`
  变化(新帧)时把 `at` 重置为共享 now,显示值 = baseline + max(0, now − at);终态行直接
  显示 wire 冻结的 `elapsedMs`。行集合收缩时 pruning,展开中的行消失时收起。

  折叠状态是普通局部 ref —— 不跨 reload 持久化(同 TodoPanel/WorktreePanel 先例;
  source-scan 的持久化白名单不覆盖本组件)。有运行中的任务时分组默认展开,全终态时默认
  收起(终态计数已在组标题里一目了然)。样式沿用 `styles/bash-jobs.css`(`.bj-*` 类不变,
  overscroll-guard.test.ts 按类名钉),分组包装与状态底色也在该文件。
-->
<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { formatDuration } from "../../format.js";
import type { BashJobRowWire, BashJobsWire } from "@protocol/messages.js";
import type { FleetBashJobsProps } from "../../contracts.js";
import { formatBytes, statusToken, summaryCounts, tailFreshness, type TailFreshness } from "../detail/bashJobsView.js";
import { deshellCmd, type DeshelledCmd } from "../../logic/bashCmd.js";
import { formatTimeRange, type TimeRangeLabel } from "../../logic/timeRange.js";
import { FLEET_ARCHIVE } from "./summary.js";
import "../../styles/bash-jobs.css";

const props = defineProps<FleetBashJobsProps>();
const { t } = useI18n();
const arch = inject(FLEET_ARCHIVE, null);

/** 有运行中的任务、或任务总数 ≤ BASH_OPEN_FEW 时默认展开(2026-10-16 用户:「很少就默认展开，不然
 *  显得空空的」);更多且全终态时默认收起。一次性的初始值,不随 wire 后续变化强制开合。 */
const BASH_OPEN_FEW = 5;
const initialCounts = summaryCounts(props.jobs);
const open = ref(
  initialCounts.running > 0 || initialCounts.running + initialCounts.failed + initialCounts.done <= BASH_OPEN_FEW,
);
/** At most one row's tail is expanded at a time (the wire caps rows at 20 — no fold math needed). */
const expandedId = ref<string | null>(null);

// ---------------------------------------------------------------------------
// web-hub archive plan: partition live/archived rows. The wire carries ALL rows (the agent
// never filters — display-only hiding), so the archived fold keeps its full row data. The
// summary counts `N running · N done · N archived` count over the whole wire: running rows can
// never be archived (agent-side terminality check), so running is the same either way.
// ---------------------------------------------------------------------------
const archivedRows = computed(() => props.jobs.rows.filter((row) => props.archived?.has(String(row.id)) === true));
const liveRows = computed(() => props.jobs.rows.filter((row) => props.archived?.has(String(row.id)) !== true));
/** omitted-orphan fix (2026-10-27): the wire caps terminal rows at 12 and the agent does not
 *  know which rows are archived (display-only hiding). When ALL wire rows are archived, the
 *  live list is empty and a bare `(+N more)` would hang in the empty list — unidentifiable and
 *  un-archivable. In that one case the marker moves next to the archived fold with an explicit
 *  prose note. live rows present ⇒ unchanged; no archived rows ⇒ byte-identical render. */
const orphanOmitted = computed(
  () =>
    liveRows.value.length === 0 &&
    archivedRows.value.length > 0 &&
    props.jobs.omitted !== undefined &&
    props.jobs.omitted > 0,
);
function isAuto(row: BashJobRowWire): boolean {
  return props.archived?.get(String(row.id))?.auto === true;
}
function canArchiveRow(row: BashJobRowWire): boolean {
  return arch !== null && arch.canArchive.value && !statusToken(row).live;
}
function onArchiveRow(row: BashJobRowWire): void {
  arch?.archive("bash", String(row.id), shell(row).cmd);
}
function onUnarchiveRow(row: BashJobRowWire): void {
  arch?.unarchive("bash", String(row.id));
}
const archivedOpen = ref(false);

// ---------------------------------------------------------------------------
// 组标题(D4 计数语法):`Bash · 2 running · 8 done · N archived`,零计数段省略
// ---------------------------------------------------------------------------
const counts = computed(() => summaryCounts(props.jobs));
const summary = computed(() => {
  const c = counts.value;
  const segments: string[] = [];
  if (c.running > 0) segments.push(t("detail.bashJobsRunning", { n: c.running }));
  if (c.done > 0) segments.push(t("detail.bashJobsDone", { n: c.done }));
  if (c.failed > 0) segments.push(t("detail.bashJobsFailed", { n: c.failed }));
  if (archivedRows.value.length > 0) segments.push(t("detail.bashJobsArchived", { n: archivedRows.value.length }));
  // `Bash · 2 running · 8 done` — every segment (incl. the title) joins with ` · `.
  return segments.length > 0 ? `${t("detail.bashJobsTitle")} · ${segments.join(" · ")}` : t("detail.bashJobsTitle");
});
/** Prose aria-label for the toggle (the visible summary is English tokens only). */
const toggleAria = computed(() => t("detail.bashJobsSummary", { ...counts.value }));

// ---------------------------------------------------------------------------
// elapsed 走时(FleetTree 语法,共享 `now` prop 驱动 —— 本组件不自带 ticker)
// ---------------------------------------------------------------------------
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
      if (b === undefined || b.elapsedMs !== elapsed) tickBaselines.set(id, { elapsedMs: elapsed, at: props.now });
    }
    for (const key of [...tickBaselines.keys()]) if (!alive.has(key)) tickBaselines.delete(key);
    if (expandedId.value !== null && !alive.has(expandedId.value)) expandedId.value = null;
  },
  { immediate: true },
);

function displayElapsed(row: BashJobRowWire): string {
  const elapsed = typeof row.elapsedMs === "number" ? row.elapsedMs : 0;
  if (!statusToken(row).live) return formatDuration(elapsed);
  const b = tickBaselines.get(String(row.id)) ?? { elapsedMs: elapsed, at: props.now };
  return formatDuration(b.elapsedMs + Math.max(0, props.now - b.at));
}

// ---------------------------------------------------------------------------
// row 渲染辅助(与 BashJobsPanel 原样一致)
// ---------------------------------------------------------------------------
function shortId(row: BashJobRowWire): string {
  return String(row.id).slice(0, 8);
}

/** Row line 1 shows the de-shelled core command; title/expansion keep the full redacted one. */
function shell(row: BashJobRowWire): DeshelledCmd {
  return deshellCmd(row.cmd);
}

/** Status text only when the icon does not already say it (running / done) and `exit N` does not. */
function showStatus(row: BashJobRowWire): boolean {
  const tok = statusToken(row);
  if (tok.kind === "running" || tok.kind === "done") return false;
  return !(tok.text === "failed" && showExit(row));
}

function showExit(row: BashJobRowWire): boolean {
  return typeof row.exitCode === "number" && row.exitCode !== 0 && statusToken(row).text !== "timeout";
}

function bytesLabel(row: BashJobRowWire): string {
  return formatBytes(row.logBytes) + (row.logTruncated === true ? "+" : "");
}

/** Start/end token from the row's `createdAt`/`endedAt` (missing createdAt ⇒ null ⇒ no token). */
function timeRangeOf(row: BashJobRowWire): TimeRangeLabel | null {
  return formatTimeRange(row.createdAt, row.endedAt);
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
  <section class="fleet-bash" :data-open="open" aria-readonly="true">
    <button class="bj-sum" type="button" :aria-expanded="open" :aria-label="toggleAria" @click="open = !open">
      <AppIcon name="terminal" class="icon-sm" />
      <span class="bj-sum-text">{{ summary }}</span>
      <AppIcon name="chev-right" class="icon-sm chev" />
    </button>
    <ul v-if="open" class="bj-list">
      <li v-for="row in liveRows" :key="row.id" class="bj-item" :data-status="statusToken(row).text">
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
          <span class="bj-cmd" translate="no" :title="row.cmd">{{ shell(row).cmd }}</span>
          <span class="bj-elapsed num">{{ displayElapsed(row) }}</span>
          <span class="bj-l2">
            <span v-if="shell(row).cwd !== undefined" class="bj-cwd" translate="no" :title="shell(row).cwdFull">{{
              shell(row).cwd
            }}</span>
            <span v-if="shell(row).timeout !== undefined" class="bj-wrap" translate="no">{{ shell(row).timeout }}</span>
            <span class="bj-id" translate="no">{{ shortId(row) }}</span>
            <span v-if="showStatus(row)" class="bj-status" :data-kind="statusToken(row).kind">{{
              statusToken(row).text
            }}</span>
            <span v-if="showExit(row)" class="bj-exit num">{{
              t("detail.bashJobsExit", { n: row.exitCode ?? 0 })
            }}</span>
            <span v-if="row.grace === true" class="bj-chip">{{ t("detail.bashJobsGrace") }}</span>
            <span v-if="freshnessText(row) !== null" class="bj-fresh" :data-kind="freshnessOf(row).kind">{{
              freshnessText(row)
            }}</span>
          </span>
          <span class="bj-bytes num">{{ bytesLabel(row) }}</span>
          <span v-if="timeRangeOf(row)" class="bj-meta" translate="no" :title="timeRangeOf(row)!.title">{{
            timeRangeOf(row)!.text
          }}</span>
        </button>
        <!-- web-hub archive plan: archive button — SIBLING of the .bj-row button (nested buttons
             are invalid HTML), absolutely positioned top-right on hover. -->
        <button
          v-if="canArchiveRow(row)"
          class="btn btn-ghost arch-act"
          type="button"
          @click.stop.prevent="onArchiveRow(row)"
        >
          {{ t("fleet.archive") }}
        </button>
        <!-- full redacted command (plain text) — the row itself ellipsizes it -->
        <div v-if="expandedId === row.id && row.tail !== undefined" class="bj-cmd-full" translate="no">
          {{ row.cmd }}
        </div>
        <!-- plain-text tail: arbitrary process output, never v-html / never markdown -->
        <pre v-if="expandedId === row.id && row.tail !== undefined" class="bj-tail">{{ row.tail }}</pre>
      </li>
      <li v-if="jobs.omitted !== undefined && jobs.omitted > 0 && !orphanOmitted" class="bj-more">
        {{ t("detail.bashJobsMore", { n: jobs.omitted }) }}
      </li>
      <!-- web-hub archive plan: the archived fold — dimmed rows, `auto` badge for sweep-archived
           ones,「取消归档」on hover. -->
      <li v-if="archivedRows.length > 0" class="bj-archived">
        <button
          class="bj-archived-fold"
          type="button"
          :aria-expanded="archivedOpen"
          @click="archivedOpen = !archivedOpen"
        >
          <AppIcon name="chev-right" class="icon-sm chev" />
          <span>{{ t("fleet.archivedFold", { n: archivedRows.length }) }}</span>
        </button>
        <ul v-if="archivedOpen" class="bj-list">
          <li
            v-for="row in archivedRows"
            :key="row.id"
            class="bj-item is-archived"
            :data-status="statusToken(row).text"
          >
            <div class="bj-row" :data-archived="true">
              <AppIcon :name="statusToken(row).icon" class="icon-sm bj-ico" :data-kind="statusToken(row).kind" />
              <span class="bj-cmd" translate="no" :title="row.cmd">{{ shell(row).cmd }}</span>
              <span class="bj-elapsed num">{{ displayElapsed(row) }}</span>
              <span class="bj-l2">
                <span class="bj-id" translate="no">{{ shortId(row) }}</span>
                <span v-if="isAuto(row)" class="arch-auto" translate="no">auto</span>
              </span>
              <span v-if="timeRangeOf(row)" class="bj-meta" translate="no" :title="timeRangeOf(row)!.title">{{
                timeRangeOf(row)!.text
              }}</span>
            </div>
            <button class="btn btn-ghost arch-act" type="button" @click.stop.prevent="onUnarchiveRow(row)">
              {{ t("fleet.unarchive") }}
            </button>
          </li>
        </ul>
      </li>
      <!-- omitted-orphan fix: all wire rows archived ⇒ the `(+N more)` marker moves here with a
           prose note instead of hanging in the empty live list. -->
      <li v-if="orphanOmitted" class="bj-more bj-more-orphan">
        {{ t("detail.bashJobsOlderOmitted", { n: jobs.omitted ?? 0 }) }}
      </li>
    </ul>
  </section>
</template>
