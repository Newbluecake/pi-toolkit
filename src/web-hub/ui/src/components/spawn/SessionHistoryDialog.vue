<!--
  SessionHistoryDialog — the 「历史会话…」 modal (session-history plan §4.7.2 / arch §7).
  Teleport'd to `<body>` with the PickerSheet/DirPicker dialog contract (scrim @click.self,
  Escape, focus trap + return, ref-counted body scroll lock).

  The list is a pure-reducer view: `@logic/sessionHistory.ts`'s `historyListReducer` owns
  query/more/page/error/expired, dedupes rows BY KEY across generations, and `nextRequest`
  decides the auto-continue (partial ∈ {budget, enum, io} OR enum incomplete, ≤3 rounds per
  input, never for zombie). The UI never sorts across pages — the server orders each page
  (PD23) and the approximation is stated in copy. Rows render through interpolation ⇒
  textContent ONLY (titles/cwd come from session files — untrusted strings).

  Flow integration: resumes/forks go through the SHARED `useNewSession` flow (SpawnRow picks
  up the awaiting record after the dialog closes on `awaiting`/`done`). A 409
  `{reason:"session-open"}` swaps the list for HistoryForkConfirm (confirm ⇒ same id resent
  as `mode:"fork"`); any other 409 reason swaps in SpawnConfirm. `failed{kind:"session"}`
  shows an inline `history.err*` line AND refreshes the list (the file may be gone/changed).

  Keyboard: ↑/↓ move the listbox selection, Enter runs the selected row's primary action,
  Enter in the search commits immediately, first Esc clears the search, the next closes.
  The kind preference persists under `localStorage["pwh_history_kind"]` (pure UI preference,
  the source-scan allow-list carries this file).

  2026-10 layout pass: two-row header (title + close / full-width search with the kind filter
  at its right end), compact two-line rows (line 1 = title + badges + relative time, line 2 =
  cwd + the row actions, subdued until hover on hover-capable pointers, ≥44px on coarse ones)
  separated by hairlines, and a one-line footer (status texts left, 「加载更多」 right). The
  W1–W7 best-effort small print stays the dialog's bottom line — collapsed behind a native
  <details> toggle (user ruling §14.1 keeps the copy mandatory, not its expansion).
-->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import {
  HISTORY_LIST_IDLE,
  SEARCH_DEBOUNCE_MS,
  historyErrorKey,
  historyListReducer,
  incompleteNotice,
  nextRequest,
  readHistoryKindPref,
  sessionErrKey,
  writeHistoryKindPref,
  type HistoryListState,
  type HistoryRowModel,
} from "../../logic/sessionHistory.js";
import { HISTORY_Q_MAX_CHARS } from "@protocol/session-history.js";
import type { HistoryQueryWire } from "@protocol/session-history.js";
import type { SpawnHistoryOutcome } from "../../transport/types.js";
import { HUB_CTX } from "../control/controlContext.js";
import HistoryForkConfirm from "./HistoryForkConfirm.vue";
import SpawnConfirm from "./SpawnConfirm.vue";
import "../../styles/history.css";

const props = defineProps<{
  /** LAN plaintext HTTP — forwarded to both confirm views. */
  readonly plaintext?: boolean;
}>();
const emit = defineEmits<{
  /** User dismissed the dialog. In-flight flows keep running (SpawnRow takes over). */
  close: [];
}>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);
const newSession = computed(() => hub?.spawn?.newSession ?? null);
const flow = computed(() => newSession.value?.flow.value ?? ({ phase: "idle" } as const));

// ---------------------------------------------------------------------------
// list state (the reducer is the single source of truth — §4.7.1)
// ---------------------------------------------------------------------------
const state = shallowRef<HistoryListState>(HISTORY_LIST_IDLE);
const kind = ref(readHistoryKindPref(safeStorage()));
const searchRaw = ref("");
/** The user's locally pending fork (row action) — rendered instead of the list until settled. */
const pendingFork = ref<HistoryRowModel | null>(null);
/** `failed{kind:"session"}`'s wire reason — mapped to a `history.err*` line by the watcher. */
const sessionError = ref<string | null>(null);
const selIdx = ref(0);

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function knownCards(): ReadonlySet<string> {
  const agents = hub?.state.value.agents;
  return agents instanceof Map ? new Set(agents.keys()) : new Set<string>();
}

// --- fetch engine (single-flight by seq; stale responses are dropped) ---
let seq = 0;
let unmounted = false;
/** Open `runReq` calls (incl. auto-continue rounds). `onLoadMore` no-ops while > 0 — the
 * reducer's phase alone cannot express the in-flight AUTO round (state stays `ready` with a
 * cursor while the next page is being fetched; a manual more-click there would fire a second
 * concurrent request on the same cursor). */
let activeReqs = 0;

async function runReq(q: HistoryQueryWire, auto: boolean): Promise<void> {
  const spawn = hub?.spawn;
  const mySeq = ++seq;
  activeReqs++;
  try {
    if (spawn === undefined) {
      state.value = historyListReducer(state.value, { type: "error", status: 0, error: "E_UNSUPPORTED" });
      return;
    }
    let r: SpawnHistoryOutcome;
    try {
      const history = spawn.history;
      if (history === undefined) {
        state.value = historyListReducer(state.value, { type: "error", status: 0, error: "E_UNSUPPORTED" });
        return;
      }
      r = await history(q);
    } catch {
      r = { ok: false, error: "E_NETWORK", status: 0 };
    }
    if (unmounted || mySeq !== seq) return;
    if (r.ok) {
      state.value = historyListReducer(state.value, {
        type: "page",
        page: r.page,
        now: Date.now(),
        knownCards: knownCards(),
        ...(auto ? { auto: true } : {}),
      });
      const nxt = nextRequest(state.value);
      if (nxt !== null && nxt.auto) {
        void runReq({ q: nxt.q, kind: nxt.kind, ...(nxt.cursor !== undefined ? { cursor: nxt.cursor } : {}) }, true);
      }
      return;
    }
    if (r.status === 409 && r.reason === "cursor-expired") {
      // F16: hub restart / gen expiry — restart the SAME query from the beginning (the reducer
      // allows exactly one auto-restart; a second expiry inside one query becomes an error).
      state.value = historyListReducer(state.value, { type: "expired" });
      if (state.value.phase === "loading") {
        void runReq({ q: state.value.q, kind: state.value.kind }, false);
      }
      return;
    }
    state.value = historyListReducer(state.value, {
      type: "error",
      status: r.status,
      error: r.error,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    });
  } finally {
    activeReqs--;
  }
}

function commitQuery(q: string): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  searchRaw.value = q;
  state.value = historyListReducer(state.value, { type: "query", q, kind: kind.value });
  void runReq({ q, kind: kind.value }, false);
}

// --- search debounce (250ms; Enter commits immediately, Esc clears then closes) ---
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onSearchInput(ev: Event): void {
  searchRaw.value = (ev.target as HTMLInputElement).value;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const v = searchRaw.value;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    commitQuery(v.trim());
  }, SEARCH_DEBOUNCE_MS);
}

function onSearchKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Enter") {
    ev.preventDefault();
    commitQuery(searchRaw.value.trim());
    return;
  }
  if (ev.key === "Escape" && searchRaw.value !== "") {
    ev.stopPropagation(); // first Esc clears the search; the next one closes (scrim handler)
    commitQuery("");
  }
}

function onKindToggle(): void {
  kind.value = kind.value === "all" ? "main" : "all";
  writeHistoryKindPref(safeStorage(), kind.value);
  state.value = historyListReducer(state.value, { type: "query", q: state.value.q, kind: kind.value });
  void runReq({ q: state.value.q, kind: kind.value }, false);
}

function onLoadMore(): void {
  const cur = state.value;
  if (cur.phase !== "ready" || cur.cursor === undefined) return;
  // One page request at a time: no manual round while an auto-continue is pending (the footer
  // shows 「Scanning more…」 then) or any other request is still in flight.
  if (autoScanning.value || activeReqs > 0) return;
  state.value = historyListReducer(state.value, { type: "more" });
  void runReq({ q: cur.q, kind: cur.kind, cursor: cur.cursor }, false);
}

function refresh(): void {
  state.value = historyListReducer(state.value, { type: "query", q: state.value.q, kind: state.value.kind });
  void runReq({ q: state.value.q, kind: state.value.kind }, false);
}

// ---------------------------------------------------------------------------
// rows / actions
// ---------------------------------------------------------------------------
const rows = computed(() => state.value.rows);
const canMore = computed(() => nextRequest(state.value) !== null);
const autoScanning = computed(() => {
  const nxt = nextRequest(state.value);
  return state.value.phase === "ready" && nxt !== null && nxt.auto;
});
const partialLine = computed(() => {
  const p = state.value.partial;
  if (p === undefined) return null;
  const stats = state.value.stats;
  return t("history.indexedPartial", {
    x: stats?.indexed ?? rows.value.length,
    y: stats?.files ?? rows.value.length,
  });
});
const notices = computed(() => incompleteNotice(state.value.stats, state.value.incomplete));
const emptyHint = computed(() => {
  if (state.value.phase !== "ready" || rows.value.length > 0) return null;
  return state.value.q !== "" ? t("history.noResults") : t("history.emptyFiles");
});
const errorText = computed(() => {
  const e = state.value.error;
  return e === undefined ? null : t(historyErrorKey(e.error, e.status));
});
const sessionErrorText = computed(() => (sessionError.value === null ? null : t(sessionErrKey(sessionError.value))));
/** Rows clickable while no flow phase holds the wire (submitting/confirming). */
const flowBusy = computed(() => {
  const p = flow.value.phase;
  return p === "submitting" || p === "confirming";
});

function rowTitle(row: HistoryRowModel): string {
  return row.titleIsFallback ? `${t("history.rowNoTitle")} · ${row.id.slice(0, 8)}` : row.title;
}

function onPrimary(row: HistoryRowModel): void {
  if (flowBusy.value || !row.startable) return;
  if (row.forkOnly !== undefined) {
    // forkOnly rows fork straight away — the local confirm below is the only confirmation
    // (PD17); the forkOnly reason/proofGap/live feed the warning copy.
    pendingFork.value = row;
    return;
  }
  const ns = newSession.value;
  if (ns === null) return;
  void ns.submit({ cwd: row.cwd, session: { key: row.key, id: row.id, mode: "resume" } });
}

function onLocalForkConfirm(): void {
  const row = pendingFork.value;
  pendingFork.value = null;
  const ns = newSession.value;
  if (row === null || ns === null) return;
  // PD17: one local confirm, then ONE request — submit() adds confirm:true + expectCwd:cwd
  // for mode:"fork" itself; the hub never gets a chance to 409 this one.
  void ns.submit({ cwd: row.cwd, session: { key: row.key, id: row.id, mode: "fork" } });
}

function onGoto(): void {
  // The 「转到」 link navigates natively (a real <a href="#/agent/<key>"> — middle-click and
  // browser history work); all that's left here is closing the dialog.
  emit("close");
}

// per-row overflow menu (one open at a time, closed by any outside click / row change)
const overflowKey = ref<string | null>(null);
function toggleOverflow(key: string): void {
  overflowKey.value = overflowKey.value === key ? null : key;
}
function onOverflowFork(row: HistoryRowModel): void {
  overflowKey.value = null;
  pendingFork.value = row;
}

// listbox keyboard: ↑/↓ move, Enter runs the selected row's primary action
function onListKeydown(ev: KeyboardEvent): void {
  const n = rows.value.length;
  if (n === 0) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const delta = ev.key === "ArrowDown" ? 1 : -1;
    selIdx.value = (selIdx.value + delta + n) % n;
    listEl.value?.querySelectorAll<HTMLElement>(".history-row")[selIdx.value]?.scrollIntoView?.({ block: "nearest" });
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    const row = rows.value[selIdx.value];
    if (row !== undefined) onPrimary(row);
  }
}

// ---------------------------------------------------------------------------
// flow wiring (the SHARED useNewSession flow; SpawnRow takes over once the dialog closes)
// ---------------------------------------------------------------------------
const confirmingFlow = computed(() => (flow.value.phase === "confirming" ? flow.value : null));

watch(flow, (f) => {
  if (f.phase === "awaiting" || f.phase === "done") {
    emit("close"); // 进入 awaiting ⇒ 关闭弹窗 (§4.7.2); SpawnRow shows the record from here
    return;
  }
  if (f.phase === "failed" && f.kind === "session") {
    sessionError.value = f.code ?? "session-invalid";
    // The file may have been deleted/replaced under us — refresh so greyed rows/omissions
    // reflect reality (§4.7.2: failed{kind:"session"} 时在行内显示文案并刷新列表).
    refresh();
  }
});

// ---------------------------------------------------------------------------
// dialog shell (the PickerSheet/DirPicker contract)
// ---------------------------------------------------------------------------
const panelEl = ref<HTMLElement | null>(null);
const scrimEl = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
let returnFocus: Element | null = null;
let releaseScrollLock: (() => void) | null = null;

onMounted(async () => {
  returnFocus = document.activeElement;
  releaseScrollLock = acquireBodyScrollLock();
  document.addEventListener("keydown", onDocumentKeydown, true);
  await nextTick();
  searchInput.value?.focus();
  // Initial page — the reducer's `query` also arms the expired-restart budget.
  state.value = historyListReducer(HISTORY_LIST_IDLE, { type: "query", q: "", kind: kind.value });
  void runReq({ q: "", kind: kind.value }, false);
});

onUnmounted(() => {
  unmounted = true;
  seq++; // drop any in-flight response
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  document.removeEventListener("keydown", onDocumentKeydown, true);
  releaseScrollLock?.();
  releaseScrollLock = null;
  const target = returnFocus;
  returnFocus = null;
  if (target instanceof HTMLElement && document.contains(target)) target.focus();
});

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(ev: KeyboardEvent): void {
  const panel = panelEl.value;
  if (panel === null) return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    ev.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = active === null || !panel.contains(active);
  if (ev.shiftKey && (outside || active === first)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (outside || active === last)) {
    ev.preventDefault();
    first.focus();
  }
}

function onCancelOrClose(): void {
  const f = flow.value;
  if (f.phase === "confirming") newSession.value?.cancel();
  pendingFork.value = null;
  emit("close");
}

function onScrimKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    onCancelOrClose();
    return;
  }
  if (ev.key === "Tab") trapTab(ev);
}

const OVERLAY_ROOTS = ".spawn-scrim, .picker-scrim, .preview-overlay";

function ownsDocumentKeydown(ev: KeyboardEvent): boolean {
  const panel = panelEl.value;
  if (panel === null) return false;
  if (ev.target instanceof Node && panel.contains(ev.target)) return false;
  const roots = Array.from(document.querySelectorAll(OVERLAY_ROOTS));
  for (const root of roots) {
    if (root !== scrimEl.value && ev.target instanceof Node && root.contains(ev.target)) return false;
  }
  const last = roots[roots.length - 1];
  return last === undefined || last === scrimEl.value;
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" && ev.key !== "Tab") return;
  if (!ownsDocumentKeydown(ev)) return;
  if (ev.key === "Escape") {
    ev.stopPropagation();
    onCancelOrClose();
    return;
  }
  trapTab(ev);
}
</script>

<template>
  <Teleport to="body">
    <div ref="scrimEl" class="spawn-scrim history-scrim" @click.self="onCancelOrClose" @keydown="onScrimKeydown">
      <section
        ref="panelEl"
        class="history-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('history.dialogAria')"
        tabindex="-1"
      >
        <!-- 409 session-open ⇒ HistoryForkConfirm; any other 409 reason ⇒ SpawnConfirm -->
        <template v-if="confirmingFlow">
          <HistoryForkConfirm
            v-if="confirmingFlow.reason === 'session-open'"
            :reason="confirmingFlow.forkReason ?? 'unverified'"
            :by="confirmingFlow.live?.by"
            :gap="confirmingFlow.proofGap"
            :pid="confirmingFlow.live?.pid"
            :plaintext="plaintext === true"
            :busy="flow.phase === 'submitting'"
            @confirm="newSession?.confirm()"
            @cancel="newSession?.cancel()"
          />
          <SpawnConfirm
            v-else
            :resolved-cwd="confirmingFlow.resolvedCwd"
            :reason="confirmingFlow.reason"
            :plaintext="plaintext === true"
            :busy="flow.phase === 'submitting'"
            @confirm="newSession?.confirm()"
            @cancel="newSession?.cancel()"
          />
        </template>

        <!-- user-chosen fork (row action / overflow) ⇒ the SAME confirm view, locally -->
        <HistoryForkConfirm
          v-else-if="pendingFork"
          :reason="pendingFork.forkOnly ?? 'manual'"
          :by="pendingFork.live?.by"
          :gap="pendingFork.proofGap"
          :pid="pendingFork.live?.pid"
          :plaintext="plaintext === true"
          :busy="flowBusy"
          @confirm="onLocalForkConfirm"
          @cancel="pendingFork = null"
        />

        <template v-else>
          <header class="history-head">
            <div class="history-headrow">
              <h3 class="history-title">{{ t("history.dialogTitle") }}</h3>
              <button
                class="btn btn-ghost btn-icon"
                type="button"
                :aria-label="t('history.close')"
                @click="onCancelOrClose"
              >
                <AppIcon name="x" class="icon-sm" />
              </button>
            </div>
            <div class="history-searchrow">
              <div class="history-search">
                <AppIcon name="search" />
                <input
                  ref="searchInput"
                  class="input"
                  type="search"
                  name="history-search"
                  :placeholder="t('history.searchPlaceholder')"
                  :aria-label="t('history.searchLabel')"
                  :maxlength="HISTORY_Q_MAX_CHARS"
                  autocomplete="off"
                  spellcheck="false"
                  :value="searchRaw"
                  @input="onSearchInput"
                  @keydown="onSearchKeydown"
                />
              </div>
              <label class="history-kind">
                <input type="checkbox" :checked="kind === 'all'" :disabled="flowBusy" @change="onKindToggle" />
                <span>{{ t("history.kindAll") }}</span>
              </label>
            </div>
          </header>

          <p v-if="flow.phase === 'submitting'" class="history-status" role="status">
            <AppIcon name="loader" class="icon-sm spin" />{{ t("spawn.pickerSubmitting") }}
          </p>
          <div v-if="sessionErrorText" class="history-session-error" role="alert">
            <span class="history-session-error-title">{{ t("history.sessionErrorTitle") }}</span>
            {{ sessionErrorText }}
          </div>

          <p v-if="state.phase === 'loading' && rows.length === 0" class="history-status" role="status">
            <AppIcon name="loader" class="icon-sm spin" />{{ t("history.loading") }}
          </p>
          <!-- the error block renders with OR without gathered rows (an appended-page failure
               still shows what the query found so far) -->
          <div v-else-if="state.phase === 'error'" class="history-session-error" role="alert">
            <span>{{ errorText }}</span>
            <button class="btn btn-ghost btn-xs" type="button" @click="refresh">{{ t("history.retry") }}</button>
          </div>

          <div
            v-else-if="rows.length > 0"
            ref="listEl"
            class="history-list"
            role="listbox"
            :aria-label="t('history.dialogTitle')"
            tabindex="0"
            @keydown="onListKeydown"
          >
            <div
              v-for="(row, i) in rows"
              :key="row.key"
              class="history-row"
              :class="{ 'is-greyed': !row.startable }"
              role="option"
              :aria-selected="i === selIdx"
              :aria-disabled="!row.startable"
              @click="selIdx = i"
            >
              <div class="history-row-line1">
                <span class="history-row-title" :title="row.titleIsFallback ? row.id : row.title">{{
                  rowTitle(row)
                }}</span>
                <span
                  v-for="b in row.badges"
                  :key="b"
                  class="chip chip-mono history-badge"
                  :data-badge="b"
                  translate="no"
                  >{{ b }}</span
                >
                <span class="history-row-time" translate="no">{{ row.relTime }}</span>
              </div>
              <div class="history-row-line2">
                <span class="history-row-cwd" :title="row.cwd" translate="no">{{ row.cwdLabel }}</span>
                <span v-if="row.startable" class="history-row-actions">
                  <button
                    class="btn btn-ghost btn-xs"
                    type="button"
                    :disabled="flowBusy"
                    :aria-label="row.forkOnly === undefined ? t('history.resume') : t('history.forkAction')"
                    @click.stop="onPrimary(row)"
                  >
                    {{ row.forkOnly === undefined ? t("history.resume") : t("history.forkAction") }}
                  </button>
                  <a
                    v-if="row.gotoAgentKey"
                    class="btn btn-ghost btn-xs"
                    :href="`#/agent/${row.gotoAgentKey}`"
                    @click="onGoto"
                  >
                    {{ t("history.goto") }}
                  </a>
                  <span class="history-overflow">
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      :aria-label="t('history.overflowAria')"
                      :aria-expanded="overflowKey === row.key"
                      :disabled="flowBusy"
                      @click.stop="toggleOverflow(row.key)"
                    >
                      <span class="history-overflow-dots" translate="no">⋯</span>
                    </button>
                    <div v-if="overflowKey === row.key" class="history-overflow-menu" role="menu">
                      <button
                        class="history-overflow-item"
                        type="button"
                        role="menuitem"
                        @click.stop="onOverflowFork(row)"
                      >
                        {{ t("history.forkAction") }}
                      </button>
                    </div>
                  </span>
                </span>
              </div>
              <p v-if="row.blockedKey" class="history-row-blocked">{{ t(row.blockedKey) }}</p>
            </div>
          </div>
          <p v-if="emptyHint" class="history-empty">{{ emptyHint }}</p>

          <footer class="history-foot">
            <div class="history-foot-row">
              <div class="history-foot-status">
                <p v-if="state.phase === 'loading' && rows.length > 0" class="history-status" role="status">
                  <AppIcon name="loader" class="icon-sm spin" />{{ t("history.scanningMore") }}
                </p>
                <p v-else-if="autoScanning" class="history-status" role="status">
                  <AppIcon name="loader" class="icon-sm spin" />{{ t("history.scanningMore") }}
                </p>
                <p v-if="partialLine" class="history-note" role="status">
                  {{ partialLine }}
                  <span v-if="state.partial?.reason === 'io'">{{ t("history.indexedIo") }}</span>
                </p>
                <p
                  v-for="(n, i) in notices"
                  :key="`notice-${n.key}-${i}`"
                  class="history-note history-banner"
                  role="status"
                >
                  {{ t(n.key, { n: n.n ?? 0, done: n.dirsDone ?? 0, total: n.dirsTotal ?? 0 }) }}
                </p>
                <p v-if="state.liveness" class="history-note">{{ t("history.livenessNote") }}</p>
              </div>
              <button
                v-if="canMore && state.phase === 'ready' && !autoScanning"
                class="btn btn-ghost btn-xs history-foot-more"
                type="button"
                @click="onLoadMore"
              >
                {{ t("history.loadMore") }}
              </button>
            </div>
            <details class="history-besteffort">
              <summary class="history-besteffort-summary">
                <span aria-hidden="true">ⓘ</span> {{ t("history.bestEffortSummary") }}
              </summary>
              <p class="history-besteffort-text" role="note">{{ t("history.bestEffortNote") }}</p>
            </details>
          </footer>
        </template>
      </section>
    </div>
  </Teleport>
</template>
