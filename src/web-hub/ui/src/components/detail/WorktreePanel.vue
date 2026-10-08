<!--
  Git-worktree panel (worktree-web plan §5/D5, package W4; worktree-diff plan v3.1 §4.1,
  package D5): a read-only summary of the git worktrees of the repo the session cwd lives in,
  fed by `StatusInfo.worktrees` (W2 wire, commit 04021a9) via `worktreesOf(agent)` — no
  `state.js` mirror, no `types.ts` change (beyond D4's additive `worktreeDiff` passthrough).
  Collapsed by default: the one-line summary (`master@053387d ↑1 · worktrees 3 · 1 dirty ·
  stale 2m`) is the glance surface; expanding lists every row with its home-abbreviated label
  (the full absolute path rides the row's `title` and a per-row CopyButton — 用户拍板 Q1:
  absolute paths are shown/copyable), branch chip, short HEAD, dirty token (`*N` / `*N+` /
  `*N~` / `clean` / `?`), ahead/behind and flag chips (main/agent/locked/prunable/bare).

  worktree-diff D5 (§4.1): a row whose dirty token is EXPANDABLE (`rowDiffable`: wtdiff scope
  + usable `path` + not bare/prunable + possibly-dirty) renders that token as
  `<button class="wt-status wtd-toggle" aria-expanded>` — `*N` + chevron — embedding
  `WorktreeFileList` below the row when open; the whole ROW stays unclickable (it hosts the
  per-row CopyButton). Rows without a scope / without `path` / clean rows keep today's exact
  `<span class="wt-status">` (I8 — the no-cap DOM is byte-identical, pinned by
  `worktree-panel.test.ts`). Expansion state lives in `useWorktreeDiff` (not persisted); the
  diff dialog (`WorktreeDiffDialog`) is mounted here as a fragment sibling (its own internal
  Teleport carries it to `<body>`), mounted only when a scope exists.

  V1 rulings (plan §10 / 用户拍板): strictly read-only — no write path, no preview link,
  `aria-readonly` on the section; shown even for a single worktree (Q2); no settings toggle
  (Q3); ahead/behind is vs the local remote-tracking ref and the web UI never fetches (Q5,
  tooltip `worktreesAbHint`). A single worktree still renders the panel; a wire with zero rows
  (or none at all) renders nothing — `DetailHeader`'s `v-if` plus `worktreesOf`'s non-empty
  -rows guard.

  Fold state is a plain local ref — NOT persisted across reloads, same precedent as
  `TodoPanel` (source-scan.test.ts's persistence allowlist doesn't cover this component).
  Styles live in `styles/worktrees.css` (imported below) + `styles/diff.css` (via the diff
  components), not scoped `<style>` — source-scan bans `<style>` blocks outright.

  Compact inline markers (summary segments, `*N+`/`?` tokens, flag chips) are English-token-only
  in BOTH locales per the AGENTS.md UI-text rule; only tooltips/aria labels are translated prose.
  Everything is plain-text interpolation (`translate="no"` on paths/refs, no `v-html`, never
  routed through `markdown.js` / `PathText.vue`); unknown future wire fields (Q4 open schema)
  are never read, so a newer agent can't break an older UI.
-->
<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { useWorktreeDiff, type ListState } from "../../composables/useWorktreeDiff.js";
import type { WorktreeRowWire, WorktreesWire, SessionInfo } from "@protocol/messages.js";
import { rowDiffable, wtdiffScopeOf } from "@logic/wtdiff.js";
import type { WtDiffFileEntry } from "@protocol/worktree-diff.js";
import type { WtDiffScope } from "../../transport/types.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import CopyButton from "./CopyButton.vue";
import WorktreeDiffDialog from "../diff/WorktreeDiffDialog.vue";
import WorktreeFileList from "../diff/WorktreeFileList.vue";
import { currentRowOf, formatSampleTime, rowStatus } from "./worktreesView.js";
import "../../styles/worktrees.css";

// Deliberately local props interface (same escape hatch as TodoPanel): contracts.ts is owned
// by another in-flight line and `WorktreesWire` comes straight from `@protocol/messages.js`.
// `agentKey`/`session` (D5 §4.1, optional — absent in every pre-D5 mount, e.g. old snapshots)
// are the wtdiff scope inputs alongside the injected hub/transport.
const props = defineProps<{
  readonly worktrees: WorktreesWire;
  readonly agentKey?: string;
  readonly session?: SessionInfo | undefined;
}>();
const { t } = useI18n();

const open = ref(false);

// ---------------------------------------------------------------------------
// worktree-diff D5 §4.1: scope derivation + the diff state machine. Inject-only (HUB_CTX /
// CONTROL_ENV), no new provider — a missing hub/context/transport/cap collapses `scope` to
// null and the panel renders byte-identical to the pre-D5 DOM (I8).
// ---------------------------------------------------------------------------
const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);

function hubCaps(): unknown {
  const h = hub?.state.value.hub;
  return h !== null && typeof h === "object" ? (h as { caps?: unknown }).caps : undefined;
}

const scope = computed<WtDiffScope | null>(() =>
  wtdiffScopeOf({
    mode: env?.authMode,
    hubCaps: hubCaps(),
    hasTransport: hub?.worktreeDiff !== undefined,
    agentKey: props.agentKey,
    session: props.session,
  }),
);

const {
  lists,
  dialog,
  mode: viewMode,
  isExpanded,
  toggleRow,
  refreshList,
  openFile,
  refreshDialog,
  closeDialog,
  setMode,
  onRowsChanged,
} = useWorktreeDiff({ transport: hub?.worktreeDiff, scope });

/** §4.4: ≤767px drives the dialog's full-screen/unified degradation (mockup W4). */
const mobile = useMedia(window, "(max-width: 767px)").matches;

const plaintext = computed(() => env?.plaintext === true);

// D13: every status frame re-samples the rows — sig moves re-pull expanded lists (debounced
// in the composable) and raise the dialog's stale banner.
watch(
  () => props.worktrees.rows,
  (rows) => onRowsChanged(rows),
);

function rowKey(row: WorktreeRowWire): string {
  return typeof row.path === "string" ? row.path : "";
}

function listStateOf(row: WorktreeRowWire): ListState {
  return lists.get(rowKey(row)) ?? { phase: "idle", sig: "" };
}

function listId(i: number): string {
  return `wtd-files-${i}`;
}

function onOpen(row: WorktreeRowWire, entry: WtDiffFileEntry): void {
  openFile(rowKey(row), entry);
}

function onRefresh(row: WorktreeRowWire): void {
  refreshList(rowKey(row));
}

const current = computed(() => currentRowOf(props.worktrees));

/** The collapsed one-liner. Every segment is optional except the `worktrees {total}` count
 * (plan §5): no current row ⇒ no branch segment; zero counts ⇒ omitted; no `staleMin` ⇒ omitted. */
const summary = computed(() => {
  const w = props.worktrees;
  const parts: string[] = [];
  const cur = current.value;
  if (cur !== undefined) {
    const branch = cur.branch ?? t("detail.worktreesBranchDetached");
    let seg = cur.head !== undefined ? `${branch}@${cur.head}` : branch;
    const ab = abLabel(cur);
    if (ab !== null) seg += ` ${ab}`;
    parts.push(seg);
  }
  parts.push(t("detail.worktreesCount", { total: w.total }) + (w.listCapped === true ? "+" : ""));
  if (w.dirtyCount > 0) parts.push(t("detail.worktreesDirty", { n: w.dirtyCount }));
  if (w.agentCount > 0) parts.push(t("detail.worktreesAgent", { n: w.agentCount }));
  if (typeof w.staleMin === "number" && w.staleMin > 0) {
    parts.push(t("detail.worktreesStale", { n: w.staleMin }));
  }
  return parts.join(" · ");
});

/** `↑a ↓b` (vs the local remote-tracking ref — see the tooltip) or null when both are 0/absent. */
function abLabel(row: WorktreeRowWire): string | null {
  const parts: string[] = [];
  if (typeof row.ahead === "number" && row.ahead > 0) parts.push(`↑${row.ahead}`);
  if (typeof row.behind === "number" && row.behind > 0) parts.push(`↓${row.behind}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Branch chip text; `detached@<sha>` (or bare `detached`) fallback, null for bare rows —
 * their `bare` flag chip says it instead. */
function branchChip(row: WorktreeRowWire): string | null {
  if (row.bare === true) return null;
  if (row.branch !== undefined) return row.branch;
  const detached = t("detail.worktreesBranchDetached");
  return row.head !== undefined ? `${detached}@${row.head}` : detached;
}

interface StatusToken {
  readonly text: string;
  readonly kind: "unprobed" | "clean" | "dirty";
  readonly title: string | null;
}

/** The row's dirty/probe token (plan §5's `*N` / `*N+` / `*N~` / `clean` / `?` grammar), with
 * its restrained explanatory tooltip; null when the row was never probed (bare/prunable). */
function statusToken(row: WorktreeRowWire): StatusToken | null {
  const s = rowStatus(row);
  switch (s.kind) {
    case "none":
      return null;
    case "clean":
      return { text: t("detail.worktreesClean"), kind: "clean", title: null };
    case "dirty": {
      const hints: string[] = [];
      if (s.capped) hints.push(t("detail.worktreesDirtyCapped"));
      if (s.skipped) hints.push(t("detail.worktreesUntrackedSkipped"));
      return { text: s.text, kind: "dirty", title: hints.length > 0 ? hints.join("; ") : null };
    }
    case "unprobed": {
      // `unprobed` is an open string on the wire: unknown future reasons show the error wording.
      const title =
        s.reason === "cap"
          ? t("detail.worktreesUnprobedCap")
          : s.reason === "timeout"
            ? t("detail.worktreesUnprobedTimeout")
            : t("detail.worktreesUnprobedError");
      return { text: "?", kind: "unprobed", title };
    }
  }
}

function flagChips(row: WorktreeRowWire): string[] {
  const out: string[] = [];
  if (row.main === true) out.push(t("detail.worktreesFlagMain"));
  if (row.agentRunId !== undefined) out.push(t("detail.worktreesFlagAgent"));
  if (row.locked === true) out.push(t("detail.worktreesFlagLocked"));
  if (row.prunable === true) out.push(t("detail.worktreesFlagPrunable"));
  if (row.bare === true) out.push(t("detail.worktreesFlagBare"));
  return out;
}

const sampleTime = computed(() => formatSampleTime(props.worktrees.sampledAt));
</script>

<template>
  <section class="wt-panel" :data-open="open" aria-readonly="true">
    <button
      class="wt-sum"
      type="button"
      :aria-expanded="open"
      :aria-label="t('detail.worktreesToggleAria')"
      @click="open = !open"
    >
      <AppIcon name="branch" class="icon-sm" />
      <span class="wt-sum-text">{{ summary }}</span>
      <AppIcon name="chev-right" class="icon-sm chev" />
    </button>
    <ul v-if="open" class="wt-list">
      <li
        v-for="(row, i) in worktrees.rows"
        :key="row.path ?? row.label"
        class="wt-item"
        :class="{ 'is-expanded': rowDiffable(scope, row) && isExpanded(rowKey(row)) }"
        :data-current="row.current === true ? 'true' : undefined"
      >
        <span class="wt-marker" aria-hidden="true">{{ row.current === true ? "●" : "○" }}</span>
        <span v-if="row.current === true" class="sr-only">{{ t("detail.worktreesCurrent") }}</span>
        <span class="wt-label" translate="no" :title="row.path ?? row.label">{{ row.label }}</span>
        <span v-if="branchChip(row) !== null" class="wt-chip wt-branch" translate="no">{{ branchChip(row) }}</span>
        <span v-if="row.branch !== undefined && row.head !== undefined" class="wt-head" translate="no">{{
          row.head
        }}</span>
        <template v-if="statusToken(row) !== null">
          <template v-if="rowDiffable(scope, row)">
            <button
              class="wt-status wtd-toggle"
              type="button"
              :data-kind="statusToken(row)?.kind"
              :title="t('diff.toggleTitle')"
              :aria-expanded="isExpanded(rowKey(row)) ? 'true' : 'false'"
              :aria-controls="isExpanded(rowKey(row)) ? listId(i) : undefined"
              @click="toggleRow(row)"
            >
              {{ statusToken(row)?.text }}<AppIcon name="chev-right" class="wtd-chev" aria-hidden="true" />
            </button>
            <div v-if="isExpanded(rowKey(row))" :id="listId(i)" class="wt-files-slot">
              <WorktreeFileList :state="listStateOf(row)" @open="(e) => onOpen(row, e)" @refresh="onRefresh(row)" />
            </div>
          </template>
          <span
            v-else
            class="wt-status"
            :data-kind="statusToken(row)?.kind"
            :title="statusToken(row)?.title ?? undefined"
            >{{ statusToken(row)?.text }}</span
          >
        </template>
        <span v-if="abLabel(row) !== null" class="wt-ab" :title="t('detail.worktreesAbHint')">{{ abLabel(row) }}</span>
        <span v-for="flag in flagChips(row)" :key="flag" class="wt-chip wt-flag">{{ flag }}</span>
        <CopyButton class="wt-copy" :value="row.path ?? row.label" :label="t('detail.worktreesCopyPath')" />
      </li>
      <li v-if="worktrees.omitted !== undefined && worktrees.omitted > 0" class="wt-more">
        {{ t("detail.worktreesMore", { n: worktrees.omitted }) }}
      </li>
      <li class="wt-foot" :title="t('detail.worktreesLastSampleHint')">
        {{ t("detail.worktreesLastSample", { time: sampleTime }) }}
      </li>
    </ul>
  </section>
  <!-- worktree-diff D5: the diff dialog mounts as a SECOND root (a fragment sibling of the
       section, so the panel's own DOM stays byte-identical when no scope exists — I8), only
       when a scope does; the dialog's own internal Teleport carries it to <body> (D6: the
       outer Teleport here was redundant nesting and was removed). -->
  <WorktreeDiffDialog
    v-if="scope !== null"
    :state="dialog"
    :mode="viewMode"
    :mobile="mobile"
    :plaintext="plaintext"
    @close="closeDialog"
    @refresh="refreshDialog"
    @set-mode="setMode"
  />
</template>
