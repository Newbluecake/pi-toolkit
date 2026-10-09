<!--
  worktree-diff plan v3.1 §4.3/§4.4 (package D5): the file-diff dialog. Teleported to `<body>`,
  rendering `useWorktreeDiff`'s DialogState through the local `diffModal.ts` shell (D12 — same
  semantics as PreviewHost's overlay, independently implemented): focus enters the panel, Tab
  cycles inside, Esc is owned (preventDefault + stopPropagation), backdrop click closes, clicks
  inside the panel never do, focus returns on close, and the body scroll lock is released on
  BOTH the close and unmount paths.

  Header: status badge, `orig → path` title (`displayPath`-visualized), `+a −d`, the
  split/unified segmented control — `v-if`-removed (never CSS-hidden) in the ≤767px viewport so
  it can never enter the Tab cycle (#11; the mobile view is forced unified, §4.4) — refresh,
  CopyButton (`W/path`) and close. password+http shows the plaintext-transport note (hideable
  via the explicit `pwh_hide_plaintext_warn` browser opt-out, like every plaintext warning).

  Body, six states: loading / binary / empty / error (code+reason mapped via `wtdErrorKey` —
  incl. the 415 symlink case — plus the §4.5 不可查看 terminal state) / patch (DiffRows).
  Banners: untracked, stale (「工作区已变化」 — manual refresh only, D13), the truncation family
  (`truncated` / incomplete / lineCap / hunkCap), malformed, rename-only and mode-only.
  View preference is session memory in the composable (D16 — never persisted).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { buildSplitRows, buildUnifiedRows, displayPath, formatStat, statusBadge } from "@logic/wtdiff.js";
import type { WtDiffFileEntry } from "@protocol/worktree-diff.js";
import { useI18n } from "../../composables/useI18n.js";
import { usePlaintextWarning } from "../../composables/usePlaintextWarning.js";
import type { DialogState } from "../../composables/useWorktreeDiff.js";
import { wtdErrorKey } from "../../composables/useWorktreeDiff.js";
import AppIcon from "../../icons/AppIcon.vue";
import CopyButton from "../detail/CopyButton.vue";
import DiffRows from "./DiffRows.vue";
import { useDiffModal } from "./diffModal.js";
import { browserLocalStorage } from "../shell/themeStorage.js";

const props = defineProps<{
  readonly state: DialogState;
  readonly mode: "split" | "unified";
  /** ≤767px viewport (§4.4): full-screen dialog, forced unified view, no segmented control. */
  readonly mobile: boolean;
  /** password-over-http transport warning (§5.2 semantics). */
  readonly plaintext: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "refresh"): void;
  (e: "set-mode", mode: "split" | "unified"): void;
}>();
const { t } = useI18n();

// `pwh_hide_plaintext_warn` (explicit browser opt-out) gates the plaintext-transport note.
const warn = usePlaintextWarning({ storage: browserLocalStorage() });
const showPlainWarning = computed(() => warn.warnVisible(props.plaintext));

const isOpen = computed(() => props.state.phase !== "closed");
const panelEl = ref<HTMLElement | null>(null);
const modal = useDiffModal({ isOpen, panelEl, onClose: () => emit("close") });

const open = computed(() => (props.state.phase === "closed" ? null : props.state));

/** §4.4: the mobile viewport forces unified (mockup W4); desktop honors the session mode. */
const effectiveMode = computed<"split" | "unified">(() => (props.mobile ? "unified" : props.mode));

const entry = computed<WtDiffFileEntry | null>(() => open.value?.entry ?? null);

const badge = computed(() => statusBadge(entry.value?.status));

const title = computed(() => {
  const e = entry.value;
  if (e === null) return "";
  return e.orig !== undefined ? `${e.orig} → ${e.path}` : e.path;
});

const stat = computed(() => formatStat(entry.value?.add, entry.value?.del));

const errorText = computed(() => {
  const d = open.value;
  if (d === null || d.phase !== "error" || d.error === undefined) return "";
  const key = wtdErrorKey(d.error.code, d.error.reason);
  return key === "diff.errGeneric" ? t(key, { code: d.error.code }) : t(key);
});

const rows = computed(() => {
  const d = open.value;
  if (d?.phase !== "ok" || d.parsed === undefined || d.payload?.kind !== "patch") return [];
  return effectiveMode.value === "split" ? buildSplitRows(d.parsed) : buildUnifiedRows(d.parsed);
});

/** §4.3 banner stack, top to bottom: untracked / stale / truncation family / malformed /
 * rename-only / mode-only. Every line is its own `<p role="note">`; truncation-class flags are
 * mutually exclusive in practice but each renders its own wording when present. */
const banners = computed(() => {
  const d = open.value;
  if (d?.phase !== "ok" || d.payload === undefined) return [];
  const out: string[] = [];
  if (d.payload.untracked === true) out.push(t("diff.bannerUntracked"));
  if (d.stale) out.push(t("diff.bannerStale"));
  if (d.payload.truncated) out.push(t("diff.bannerTruncated"));
  if (d.parsed?.lineCap === true) out.push(t("diff.bannerLineCap"));
  if (d.parsed?.hunkCap === true) out.push(t("diff.bannerHunkCap"));
  if (d.parsed !== undefined && !d.parsed.complete) out.push(t("diff.bannerIncomplete"));
  if (d.parsed?.malformed === true) out.push(t("diff.bannerMalformed"));
  const hunks = d.parsed?.files.reduce((n, f) => n + f.hunks.length, 0) ?? 0;
  if (hunks === 0) {
    const meta = d.parsed?.files[0]?.meta;
    if (meta?.renameFrom !== undefined || meta?.renameTo !== undefined) {
      out.push(t("diff.bannerRenameOnly", { pct: meta.similarity ?? 100 }));
    } else if (meta?.oldMode !== undefined && meta.newMode !== undefined && meta.oldMode !== meta.newMode) {
      out.push(t("diff.bannerModeOnly"));
    }
  }
  return out;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="wtd-overlay" @click.self="emit('close')" @keydown="modal.onKeydown">
      <div
        ref="panelEl"
        class="wtd-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('diff.dialogLabel')"
        tabindex="-1"
      >
        <header class="wtd-head">
          <span class="wtd-badge" :class="`is-${badge.cls}`" aria-hidden="true">{{ badge.label }}</span>
          <bdi class="wtd-title" dir="ltr" translate="no" :title="title">{{ displayPath(title) }}</bdi>
          <span v-if="stat.plus !== '' || stat.minus !== ''" class="wtd-stat" translate="no">
            <span v-if="stat.plus !== ''" class="is-add">{{ stat.plus }}</span>
            <span v-if="stat.minus !== ''" class="is-del">{{ stat.minus }}</span>
          </span>
          <!-- #11: the segmented control is v-if-REMOVED (never CSS-hidden) in the mobile
               viewport — absent from the DOM, therefore absent from the Tab cycle. -->
          <div v-if="!mobile" class="wtd-seg" role="group" :aria-label="t('diff.viewLabel')">
            <button
              class="wtd-seg-btn"
              type="button"
              :aria-pressed="mode === 'split'"
              @click="emit('set-mode', 'split')"
            >
              {{ t("diff.viewSplit") }}
            </button>
            <button
              class="wtd-seg-btn"
              type="button"
              :aria-pressed="mode === 'unified'"
              @click="emit('set-mode', 'unified')"
            >
              {{ t("diff.viewUnified") }}
            </button>
          </div>
          <button
            class="btn btn-ghost btn-icon wtd-refresh"
            type="button"
            :aria-label="t('diff.refresh')"
            :title="t('diff.refresh')"
            @click="emit('refresh')"
          >
            <AppIcon name="refresh" />
          </button>
          <CopyButton
            class="wtd-copy"
            :value="open !== null && entry !== null ? `${open.wt}/${entry.path}` : ''"
            :label="t('diff.copyPath')"
          />
          <button
            class="btn btn-ghost btn-icon wtd-close"
            type="button"
            :aria-label="t('diff.close')"
            @click="emit('close')"
          >
            <AppIcon name="x" />
          </button>
        </header>
        <p v-if="showPlainWarning" class="wtd-plaintext" role="note">
          <AppIcon name="unlock" class="icon-sm" />
          <span>{{ t("diff.plaintextWarning") }}</span>
        </p>

        <div class="wtd-body">
          <div v-if="state.phase === 'loading'" class="wtd-state" role="status">
            <AppIcon name="loader" class="wtd-spinner" />
            <span>{{ t("diff.bodyLoading") }}</span>
          </div>

          <div v-else-if="state.phase === 'error'" class="wtd-state wtd-state-error" role="alert">
            <AppIcon :name="state.unviewable === true ? 'info' : 'alert'" class="wtd-state-icon" />
            <!-- §4.5's terminal 不可查看 state (409-stale re-pull lost the entry) -->
            <p v-if="state.unviewable === true">{{ t("diff.bodyUnviewable") }}</p>
            <template v-else>
              <p class="wtd-state-title">{{ t("diff.errorTitle") }}</p>
              <p class="wtd-state-text" translate="no">{{ errorText }}</p>
              <button class="btn wtd-state-retry" type="button" @click="emit('refresh')">
                <AppIcon name="refresh" class="icon-sm" />
                <span>{{ t("diff.retry") }}</span>
              </button>
            </template>
          </div>

          <template v-else-if="state.phase === 'ok' && state.payload !== undefined">
            <p v-for="(banner, i) in banners" :key="i" class="wtd-banner" role="note">{{ banner }}</p>
            <div v-if="state.payload.kind === 'binary'" class="wtd-state">
              <AppIcon name="ban" class="wtd-state-icon" />
              <span>{{ t("diff.bodyBinary") }}</span>
            </div>
            <div v-else-if="state.payload.kind === 'empty'" class="wtd-state">
              <AppIcon name="info" class="wtd-state-icon" />
              <span>{{ t("diff.bodyEmpty") }}</span>
            </div>
            <DiffRows v-else :rows="rows" :mode="effectiveMode" :base="state.payload.base" />
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
