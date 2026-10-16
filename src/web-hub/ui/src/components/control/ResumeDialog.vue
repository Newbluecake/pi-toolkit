<!--
  ResumeDialog (web-resume plan v2 §2.6, package P3) — the 「恢复会话」 picker. LAZY: mounted
  by AgentDetail.vue through `defineAsyncComponent` the first time the dock intercept, the
  header D7 button or a palette pick opens it — none of this chunk costs first-screen bytes.

  Shell: `PickerSheet.vue` (root class `.picker-scrim`, already inside every OVERLAY_ROOTS
  list — no edits there; scrim click / Esc close, Tab trap + focus return, ref-counted body
  scroll lock). The sheet is capped at ≤640px and centered on wide viewports
  (`.resume-scrim`/`.resume-sheet` in styles/resume.css — `cssCodeSplit:false` folds it into
  the single CSS file, so it had to stay tiny).

  Body: search (§2.4 title-only, debounced 300ms) + segmented 「48h | 全部」 scope; rows carry
  the 当前 / ⑂ / 「已在其他窗口打开」 badges and relative times. Titles are untrusted
  session-file strings — interpolation only, never v-html. D4: while the agent is busy a
  banner explains and every row is disabled — the list stays browsable. D5-a: a
  live-elsewhere row needs a second click (armed state + inline hint), and the server's
  `E_CONFIRM_REQUIRED resume:active-elsewhere` swaps the list for an inline confirm; the
  honest residual rides the permanent footer line. Keyboard: ↑/↓ move, Enter picks, Esc
  closes (PickerSheet owns it); the search never steals focus on coarse pointers.
-->
<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { createResume, type ResumeRowView } from "../../composables/useResume.js";
import type { ResumeScope } from "@logic/resume.js";
import { formatRelTime } from "@logic/sessionHistory.js";
import { CONTROL_VIEW, HUB_CTX } from "./controlContext.js";
import PickerSheet from "./PickerSheet.vue";
import "../../styles/resume.css";

const props = defineProps<{ readonly scope: ResumeScope }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const view = inject(CONTROL_VIEW, null);
const hub = inject(HUB_CTX, null);

const unsupported = Promise.resolve({
  ok: false as const,
  error: "E_UNSUPPORTED",
  retryable: false,
  effect: "none" as const,
});

const resume = createResume({
  agentKey: () => view?.agentKey ?? "",
  queryCommand: (key, name, args) => {
    const q = view?.control?.queryCommand;
    return q === undefined ? unsupported : q(key, name, args);
  },
  runCommand: (key, name, args, opts) => {
    const c = view?.control;
    return c === null || c === undefined ? unsupported : c.runCommand(key, name, args, opts);
  },
  query: (key, id) => {
    const c = view?.control;
    return c === null || c === undefined ? unsupported : c.query(key, id);
  },
  agent: () => view?.agent.value,
  agents: () => {
    const agents = hub?.state.value.agents;
    return agents instanceof Map ? agents : undefined;
  },
  busy: () => view?.busy.value === true,
  requestClose: () => emit("close"),
});

const phase = resume.phase;
const rows = resume.rows;
const meta = resume.meta;
const busy = computed(() => view?.busy.value === true);
const pickBusy = computed(() => {
  const p = resume.pick.value;
  return p !== null && (p.state === "picking" || p.state === "switching");
});
const rowsDisabled = computed(() => busy.value || pickBusy.value);
const confirming = computed(() => resume.pick.value !== null && resume.pick.value.state === "confirm");
const pickStatus = computed(() => (resume.pick.value?.state === "switching" ? t("resume.picking") : null));

const emptyText = computed(() => (resume.qRaw.value.trim() === "" ? t("resume.empty") : t("resume.noResults")));
const errorText = computed(() => {
  const e = resume.error.value;
  return e === null ? null : t("resume.listFailed", { code: e.message ?? e.code });
});

function relTime(row: ResumeRowView): string {
  return formatRelTime(Date.now(), row.modifiedMs);
}
function rowTitle(row: ResumeRowView): string {
  return row.title !== "" ? row.title : `${t("resume.noTitle")} · ${row.id.slice(0, 8)}`;
}

// --- keyboard: ↑/↓/Enter across the whole sheet (focus stays where the user left it) ------
const selIdx = ref(0);
const listEl = ref<HTMLElement | null>(null);
watch(rows, (list) => {
  if (selIdx.value > list.length - 1) selIdx.value = Math.max(0, list.length - 1);
});
function moveSel(delta: number): void {
  const n = rows.value.length;
  if (n === 0) return;
  selIdx.value = (selIdx.value + delta + n) % n;
  void scrollSel();
}
function scrollSel(): void {
  listEl.value?.querySelectorAll<HTMLElement>(".resume-row")[selIdx.value]?.scrollIntoView?.({ block: "nearest" });
}
function onSheetKeydown(ev: KeyboardEvent): void {
  if (confirming.value) return; // the confirm block's buttons own the keys
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    moveSel(1);
    return;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    moveSel(-1);
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    if (!rowsDisabled.value) {
      const row = rows.value[selIdx.value];
      if (row !== undefined) resume.pickRow(row);
    }
  }
}
function onRow(row: ResumeRowView): void {
  selIdx.value = Math.max(0, rows.value.indexOf(row));
  resume.pickRow(row);
}

// --- search ------------------------------------------------------------------------------
const coarsePointer = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)").matches : false;

function onSearchInput(ev: Event): void {
  resume.setSearch((ev.target as HTMLInputElement).value);
}
function onSearchKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Enter") {
    ev.preventDefault();
    ev.stopPropagation(); // commit here — never ALSO pick the highlighted row
    resume.commitSearch();
  }
}

onMounted(() => resume.open(props.scope));
watch(
  () => props.scope,
  (s) => resume.open(s),
);
onUnmounted(() => resume.dispose());
</script>

<template>
  <PickerSheet :label="t('resume.dialogTitle')" class="resume-scrim" @close="emit('close')" @keydown="onSheetKeydown">
    <div class="resume-dialog">
      <header class="resume-head">
        <h3 class="resume-title">{{ t("resume.dialogTitle") }}</h3>
        <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('resume.close')" @click="emit('close')">
          <AppIcon name="x" class="icon-sm" />
        </button>
      </header>

      <div class="resume-searchrow">
        <div class="resume-search">
          <AppIcon name="search" />
          <input
            class="input"
            type="search"
            name="resume-search"
            :data-autofocus="coarsePointer ? undefined : ''"
            :placeholder="t('resume.searchPlaceholder')"
            :aria-label="t('resume.searchLabel')"
            :maxlength="128"
            autocomplete="off"
            spellcheck="false"
            :value="resume.qRaw.value"
            @input="onSearchInput"
            @keydown="onSearchKeydown"
          />
        </div>
        <div class="resume-seg" role="group" :aria-label="t('resume.scopeAria')">
          <button
            type="button"
            :aria-pressed="resume.scope.value === 'recent' ? 'true' : 'false'"
            @click="resume.setScope('recent')"
          >
            {{ t("resume.scopeRecent") }}
          </button>
          <button
            type="button"
            :aria-pressed="resume.scope.value === 'all' ? 'true' : 'false'"
            @click="resume.setScope('all')"
          >
            {{ t("resume.scopeAll") }}
          </button>
        </div>
      </div>

      <p v-if="busy" class="resume-busy" role="status">{{ t("resume.busyBanner") }}</p>
      <p v-if="pickStatus" class="resume-status" role="status">
        <AppIcon name="loader" class="icon-sm spin" />{{ pickStatus }}
      </p>
      <p v-if="resume.notice.value" class="resume-notice" role="status">
        {{ t(resume.notice.value.key, resume.notice.value.params) }}
        <button class="btn btn-ghost btn-xs" type="button" @click="resume.dismissNotice()">
          {{ t("resume.close") }}
        </button>
      </p>

      <!-- D5-a server half: E_CONFIRM_REQUIRED resume:active-elsewhere -->
      <div v-if="confirming" class="resume-confirm" role="group" :aria-label="t('resume.confirmTitle')">
        <p class="resume-confirm-title">{{ t("resume.confirmTitle") }}</p>
        <p class="resume-confirm-body">{{ t("resume.confirmBody") }}</p>
        <div class="resume-confirm-actions">
          <button class="btn btn-primary btn-xs" type="button" @click="resume.confirmPick()">
            {{ t("resume.confirmOk") }}
          </button>
          <button class="btn btn-ghost btn-xs" type="button" @click="resume.cancelPick()">
            {{ t("resume.confirmCancel") }}
          </button>
        </div>
      </div>

      <template v-else>
        <p v-if="phase === 'loading' && rows.length === 0" class="resume-status" role="status">
          <AppIcon name="loader" class="icon-sm spin" />{{ t("resume.loading") }}
        </p>
        <div v-else-if="errorText !== null" class="resume-error" role="alert">
          <span>{{ errorText }}</span>
          <button class="btn btn-ghost btn-xs" type="button" @click="resume.retry()">{{ t("resume.retry") }}</button>
        </div>
        <div
          v-else-if="rows.length > 0"
          ref="listEl"
          class="resume-list"
          role="listbox"
          :aria-label="t('resume.rowsAria')"
        >
          <button
            v-for="(row, i) in rows"
            :key="row.id"
            type="button"
            role="option"
            class="resume-row"
            :class="{ active: i === selIdx, armed: resume.armedId.value === row.id }"
            :aria-selected="i === selIdx"
            :disabled="rowsDisabled"
            @click="onRow(row)"
            @mousemove="selIdx = i"
          >
            <span class="resume-row-main">
              <span class="resume-row-title" :title="row.title">{{ rowTitle(row) }}</span>
              <span class="resume-row-badges">
                <span v-if="row.current" class="chip chip-muted">{{ t("resume.currentBadge") }}</span>
                <span v-if="row.forked" class="chip chip-mono" translate="no">{{ t("resume.forkBadge") }}</span>
                <span v-if="row.liveElsewhere" class="chip chip-live">{{ t("resume.liveBadge") }}</span>
              </span>
            </span>
            <span class="resume-row-time" translate="no">{{ relTime(row) }}</span>
            <span v-if="resume.armedId.value === row.id" class="resume-row-hint" role="status">
              {{ t("resume.liveHint") }}
            </span>
          </button>
        </div>
        <p v-else-if="phase === 'ready'" class="resume-empty">{{ emptyText }}</p>
      </template>

      <footer class="resume-foot">
        <div class="resume-foot-row">
          <div class="resume-foot-status">
            <p v-if="resume.loadingMore.value" class="resume-note" role="status">
              {{ t("resume.loadingMore") }}
            </p>
            <p v-if="meta?.partial" class="resume-note">{{ t("resume.partialNote") }}</p>
            <p v-if="meta?.truncated" class="resume-note">{{ t("resume.truncatedNote", { n: meta.total }) }}</p>
            <p v-if="meta?.ambiguous" class="resume-note">{{ t("resume.ambiguousNote", { n: meta.ambiguous }) }}</p>
          </div>
          <button
            v-if="meta?.next !== undefined && phase === 'ready' && !resume.loadingMore.value"
            class="btn btn-ghost btn-xs"
            type="button"
            :disabled="pickBusy"
            @click="resume.loadMore()"
          >
            {{ t("resume.loadMore") }}
          </button>
        </div>
        <p class="resume-d5">{{ t("resume.d5Footer") }}</p>
      </footer>
    </div>
  </PickerSheet>
</template>
