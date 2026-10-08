<!--
  worktree-diff plan v3.1 §4.2 (package D5): the expanded worktree row's changed-file list,
  rendering one `useWorktreeDiff` ListState. States: loading / ok (entries or the empty note) /
  error (mapped code+reason + retry when retryable). The D14/D20 static footnote — 「受保护条
  目不显示；子模块变化不在此列出」 — is ALWAYS rendered (0 entries / entries / error alike):
  it is a standing property of the listing, never a data-conditioned oracle.

  Entries are native `<button>`s (keyboard-reachable); every `!isWtRequestableEntry` entry is
  DISABLED with a title distinguishing the reason (#7: filtered / undecodable bytes / CR-LF /
  otherwise-invalid filename — TAB stays clickable, §2.4 v3.1). Paths render through
  `displayPath` (control characters → visible glyphs) inside `<bdi dir="ltr" translate="no">`;
  R/C rows show `orig → path`; binary/conflict entries carry their compact chip. Truncation and
  the three degrade flags (`untrackedSkipped` / `numstatPartial` / `attrPartial`) each get
  their own note; >200 entries cap the container height and scroll inside (§4.2).

  Everything is plain-text interpolation; styles live in `styles/diff.css`.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { displayPath, formatStat, statusBadge } from "@logic/wtdiff.js";
import { isWtRequestableEntry, type WtDiffFileEntry } from "@protocol/worktree-diff.js";
import { useI18n } from "../../composables/useI18n.js";
import { wtdErrorKey, type ListState } from "../../composables/useWorktreeDiff.js";
import "../../styles/diff.css";

const props = defineProps<{ readonly state: ListState }>();
const emit = defineEmits<{ (e: "open", entry: WtDiffFileEntry): void; (e: "refresh"): void }>();
const { t } = useI18n();
/** The ⓘ footnote's inline reveal (touch has no hover title). Purely local, never data-driven. */
const footOpen = ref(false);

const entries = computed(() => (props.state.phase === "ok" ? (props.state.data?.entries ?? []) : []));

/** §4.2 list cell label: R/C shows `orig → path`, everything else the path itself. */
function labelOf(e: WtDiffFileEntry): string {
  return e.orig !== undefined ? `${e.orig} → ${e.path}` : e.path;
}

/** #7 disabled-title taxonomy — checked in this order so every non-requestable entry gets
 * exactly ONE actionable reason (filtered beats lossy beats newline beats generic-invalid). */
function disabledTitle(e: WtDiffFileEntry): string | undefined {
  if (isWtRequestableEntry(e)) return undefined;
  if (e.filtered === true) return t("diff.entryFiltered");
  const paths = e.orig === undefined ? [e.path] : [e.path, e.orig];
  if (paths.some((p) => p.includes("\uFFFD"))) return t("diff.entryLossy");
  if (paths.some((p) => p.includes("\r") || p.includes("\n"))) return t("diff.entryNewline");
  return t("diff.entryInvalid");
}

function badge(e: WtDiffFileEntry): { cls: string; label: string } {
  return statusBadge(e.status);
}

function stat(e: WtDiffFileEntry): { plus: string; minus: string } {
  return formatStat(e.add, e.del);
}

const errorText = computed(() => {
  const err = props.state.error;
  if (err === undefined) return "";
  const key = wtdErrorKey(err.code, err.reason);
  return key === "diff.errGeneric" ? t(key, { code: err.code }) : t(key);
});

/** §4.2: only tall lists scroll inside a capped container. */
const tall = computed(() => entries.value.length > 200);

const notes = computed(() => {
  if (props.state.phase !== "ok" || props.state.data === undefined) return [];
  const d = props.state.data;
  const out: string[] = [];
  if (d.truncated) out.push(t("diff.truncatedNote"));
  if (d.untrackedSkipped === true) out.push(t("diff.untrackedSkippedNote"));
  if (d.numstatPartial === true) out.push(t("diff.numstatPartialNote"));
  if (d.attrPartial === true) out.push(t("diff.attrPartialNote"));
  return out;
});
</script>

<template>
  <div class="wtd-files" :data-phase="state.phase">
    <p v-if="state.phase === 'loading'" class="wtd-files-state" role="status">{{ t("diff.listLoading") }}</p>

    <div v-else-if="state.phase === 'error'" class="wtd-files-error" role="alert">
      <p class="wtd-files-error-title">{{ t("diff.listErrorTitle") }}</p>
      <p class="wtd-files-error-text" translate="no">{{ errorText }}</p>
      <button v-if="state.error?.retryable" class="btn wtd-files-retry" type="button" @click="emit('refresh')">
        {{ t("diff.retry") }}
      </button>
    </div>

    <template v-else-if="state.phase === 'ok'">
      <p v-if="entries.length === 0" class="wtd-files-state">{{ t("diff.listEmpty") }}</p>
      <ul v-else class="wtd-file-list" :class="{ 'is-tall': tall }">
        <li v-for="(entry, i) in entries" :key="`${i}:${entry.path}`" class="wtd-file-item">
          <button
            class="wtd-file"
            type="button"
            :disabled="!isWtRequestableEntry(entry)"
            :title="disabledTitle(entry)"
            @click="emit('open', entry)"
          >
            <span class="wtd-badge" :class="`is-${badge(entry).cls}`" aria-hidden="true">{{ badge(entry).label }}</span>
            <bdi class="wtd-file-path" dir="ltr" translate="no">{{ displayPath(labelOf(entry)) }}</bdi>
            <span v-if="entry.binary === true" class="wtd-chip">{{ t("diff.chipBinary") }}</span>
            <span v-if="entry.status === 'U'" class="wtd-chip">{{ t("diff.chipConflict") }}</span>
            <span v-if="stat(entry).plus !== '' || stat(entry).minus !== ''" class="wtd-file-stat" translate="no">
              <span v-if="stat(entry).plus !== ''" class="is-add">{{ stat(entry).plus }}</span>
              <span v-if="stat(entry).minus !== ''" class="is-del">{{ stat(entry).minus }}</span>
            </span>
          </button>
        </li>
      </ul>
      <p v-for="(note, i) in notes" :key="i" class="wtd-note">{{ note }}</p>
    </template>

    <!-- D14/D20: the standing footnote — rendered in EVERY state (0 entries / entries / error),
         never a data-conditioned signal. Presented as an always-present ⓘ (hover/aria carries
         the text; click/tap reveals it inline for touch) sharing the refresh row, not a row of
         its own. -->
    <div class="wtd-files-actions">
      <button
        class="btn btn-ghost btn-xs btn-icon wtd-foot"
        type="button"
        :title="t('diff.footnote')"
        :aria-label="t('diff.footnote')"
        :aria-expanded="footOpen ? 'true' : 'false'"
        @click="footOpen = !footOpen"
      >
        <AppIcon name="info" class="icon-sm" aria-hidden="true" />
      </button>
      <span v-if="footOpen" class="wtd-foot-text">{{ t("diff.footnote") }}</span>
      <button
        class="btn btn-ghost btn-xs wtd-refresh"
        type="button"
        :disabled="state.phase === 'loading'"
        @click="emit('refresh')"
      >
        {{ t("diff.refresh") }}
      </button>
    </div>
  </div>
</template>
