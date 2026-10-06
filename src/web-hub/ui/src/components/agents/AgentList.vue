<!--
  Agent sidebar / list (ui-design.md §5, §5.1, §6.1, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/agents/**`). Owns the filter textbox and the live/"stale & offline"
  grouping (ui-design §5.1) over the already-derived `AgentCardView[]` its parent
  (`DashboardView.vue`) computes once per agent via `agentCardModel.ts`.

  Desktop collapse (user-reported: the sidebar had no way to reclaim its width on a fixed desktop
  split): a header toggle shrinks `.sidebar` to a narrow icon rail via the SAME `--sidebar-w` CSS
  variable `shell.css`'s `.layout` grid already reads (overridden here, at the highest-specificity
  inline level, when collapsed; removed — falling back to the stylesheet's own breakpoint values
  — when expanded), persisted across reloads in `localStorage`. The toggle itself (and the whole
  collapse effect) is CSS-gated to `min-width: 1025px` (`agents.css`) rather than JS/`narrow`-gated,
  so mobile's existing full-screen list/drawer behaviour is untouched by construction — collapsing
  on desktop and then shrinking the window never leaves the list stuck hidden.

  "New session" (2026-10 redesign of the web-hub-spawn SP12 split button): the header's
  `NewSessionMenu` main button is now a MANAGED SPAWN in the selected session's cwd — it opens
  the `DirPicker` modal dialog (Teleport'd to `<body>`, it may cover the whole page) prefilled
  with that cwd and focused on 「启动」, so the whole
  `useNewSession` flow (incl. the arch §6.3 409 confirm) is reused unchanged; with no selection
  the main button is the blank pick-dir flow. When spawn is unavailable (no-cap / 404 / error)
  the button stays clickable and shows an inline how-to-enable hint instead (denied policies
  show their `spawn.denied*` reason). The old main-button behavior — the `/new` rerun against
  the SELECTED agent (`ControlHandle.runCommand(agentKey, "new", "", { confirm: true })`, the
  identical channel/whitelisted name `DetailDock.vue`'s command mode uses, enable formula
  byte-identical to `AgentDetail.vue`'s `controlEnabled`) — moved into the dropdown as
  「替换当前会话（/new）」 behind an inline two-step confirm bar. `pendingRows` of the SSE
  `spawns` slot render as `SpawnRow` placeholders above the list (also with 0 agents); a local,
  memory-only dismissed set powers their 「关闭」. No dedicated result UI for `/new`: one inline
  ok/err line (same convention as `FleetActions.vue`'s `note`), not a toast.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import {
  newSessionActions,
  pendingRows,
  spawnAvailability,
  spawnDeniedKey,
  type NewSessionAction,
} from "../../logic/spawn.js";
import { removalTargetForAgent } from "../../logic/remove.js";
import type { SpawnListOutcome } from "../../transport/types.js";
import type { AgentCardView } from "../../types.js";
import type { AgentListEmits, AgentListProps } from "../../contracts.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import EmptyState from "../shell/EmptyState.vue";
import DirPicker from "../spawn/DirPicker.vue";
import NewSessionMenu from "../spawn/NewSessionMenu.vue";
import SpawnRow from "../spawn/SpawnRow.vue";
import AgentCard from "./AgentCard.vue";
import RemoveButton from "./RemoveButton.vue";

const props = defineProps<AgentListProps>();
const emit = defineEmits<AgentListEmits>();
const { t } = useI18n();

const filtered = computed(() => {
  const needle = props.filter.trim().toLowerCase();
  if (needle === "") return props.cards;
  return props.cards.filter((c) => `${c.shortCwd} ${c.sessionLabel}`.toLowerCase().includes(needle));
});
const live = computed(() => filtered.value.filter((c) => !c.stale && !c.down));
const staleOrDown = computed(() => filtered.value.filter((c) => c.stale || c.down));

function onFilterInput(ev: Event): void {
  emit("update:filter", (ev.target as HTMLInputElement).value);
}

// ---------------------------------------------------------------------------
// desktop collapse (persisted, CSS-gated to >=1025px — see header comment)
// ---------------------------------------------------------------------------

const COLLAPSE_KEY = "webhub.agentList.collapsed";
const RAIL_WIDTH = "56px";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function applySidebarWidth(isCollapsed: boolean): void {
  try {
    if (isCollapsed) document.documentElement.style.setProperty("--sidebar-w", RAIL_WIDTH);
    else document.documentElement.style.removeProperty("--sidebar-w");
  } catch {
    // non-DOM test harness — the var is a pure cosmetic layout hint, never load-bearing
  }
}

const collapsed = ref(readCollapsed());
applySidebarWidth(collapsed.value);

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  applySidebarWidth(collapsed.value);
  try {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed.value ? "1" : "0");
  } catch {
    // best-effort persistence only
  }
}

onBeforeUnmount(() => applySidebarWidth(false));

// ---------------------------------------------------------------------------
// new session (§header comment; web-hub-spawn SP12 — actions come from @logic/spawn.js, SP11)
// ---------------------------------------------------------------------------

const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);
// First-`agents`-snapshot gate (deep-link refresh flicker fix): before the hub's first snapshot
// lands, an empty card list is "still connecting", not 「暂无会话」. Missing hub/field defaults
// to synced so pre-feature snapshots and hub-less test mounts keep the old behavior; a
// `reconnecting` transport that never synced (hub unreachable) also falls back to the old
// empty state rather than an endless 「Connecting…」.
const synced = computed(() => {
  const st = hub?.state.value;
  return st === undefined || st.synced !== false || st.conn === "reconnecting";
});

const selectedAgent = computed(() =>
  props.selectedKey === null ? undefined : hub?.state.value.agents.get(props.selectedKey),
);

/** The hub SSE frame's caps (`spawn.v1` ⇒ the pick-dir entry can exist at all, arch §8.2). */
const hubCaps = computed<unknown>(() => {
  const h = hub?.state.value.hub;
  return h !== null && typeof h === "object" ? (h as { caps?: unknown }).caps : undefined;
});

/** Latest `GET /api/headless` outcome (the policy half of the availability truth table). */
const spawnListResult = ref<SpawnListOutcome | null>(null);
let spawnListInFlight = false;
async function refreshSpawnList(): Promise<void> {
  const spawn = hub?.spawn;
  if (spawn === undefined || spawnListInFlight) return;
  if (spawnAvailability({ hubCaps: hubCaps.value }).state === "no-cap") return;
  spawnListInFlight = true;
  try {
    spawnListResult.value = await spawn.list();
  } catch {
    spawnListResult.value = { ok: false, error: "E_NETWORK", status: 0 };
  } finally {
    spawnListInFlight = false;
  }
}
// Fetch on mount / whenever the hub frame's caps change; the menu also refreshes on open.
watch(hubCaps, () => void refreshSpawnList(), { immediate: true });

const sessionActions = computed<readonly NewSessionAction[]>(() =>
  newSessionActions({
    hubCaps: hubCaps.value,
    listResult: spawnListResult.value,
    selected: {
      agent: selectedAgent.value,
      hubControl: hub?.state.value.control === true,
      controlPresent: hub?.control !== undefined,
    },
  }),
);
const pickDirEnabled = computed(() => sessionActions.value.some((a) => a.kind === "pick-dir" && a.enabled));

const newSessionNote = ref<{ kind: "ok" | "err" | "hint"; text: string } | null>(null);
const newSessionBusy = ref(false);
const pickerOpen = ref(false);
/** Main-button opens focus DirPicker's 「启动」 (the menu's pick-dir keeps the neutral form). */
const pickerFocusSubmit = ref(false);
const pickerPrefill = computed(() => {
  const card = selectedAgent.value?.card as { cwd?: unknown } | undefined;
  return typeof card?.cwd === "string" && card.cwd !== "" ? card.cwd : "~";
});
const plaintext = computed(() => env?.plaintext ?? false);

/** Inline hint for a click on a spawn entry whose capability isn't there (redesign point 3). */
function showSpawnHint(): void {
  const avail = spawnAvailability({ hubCaps: hubCaps.value, listResult: spawnListResult.value });
  if (avail.state === "denied") {
    newSessionNote.value = { kind: "hint", text: t(spawnDeniedKey(avail.policy.reason)) };
  } else if (avail.state === "unknown") {
    void refreshSpawnList(); // race the click against the still-missing policy
    newSessionNote.value = { kind: "hint", text: t("spawn.retryHint") };
  } else {
    newSessionNote.value = { kind: "hint", text: t("spawn.unavailableHint") };
  }
}

/** 「替换当前会话（/new）」 — armed from the menu, executed only by the inline confirm bar. */
const replaceConfirm = ref(false);
const replaceRunBtn = ref<HTMLButtonElement | null>(null);
const sidebarEl = ref<HTMLElement | null>(null);
async function armReplace(): Promise<void> {
  replaceConfirm.value = true;
  newSessionNote.value = null;
  await nextTick();
  replaceRunBtn.value?.focus();
}
/**
 * Return focus after the bar closes. The menu item that armed it unmounts with the dropdown,
 * so the stable restore target is the caret toggle (rendered whenever the replace item exists
 * — `menuAvailable` in NewSessionMenu), falling back to the main button. Never lands on BODY.
 */
function restoreReplaceFocus(): void {
  const root = sidebarEl.value;
  const btn =
    root?.querySelector<HTMLButtonElement>(".nsmenu-toggle") ??
    root?.querySelector<HTMLButtonElement>(".new-session-btn");
  btn?.focus();
}
function disarmReplace(): void {
  if (!replaceConfirm.value) return;
  replaceConfirm.value = false;
  restoreReplaceFocus();
}
async function confirmReplace(): Promise<void> {
  if (newSessionBusy.value) return;
  replaceConfirm.value = false;
  await onNewSession();
  restoreReplaceFocus();
}
function onReplaceKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    disarmReplace();
  }
}

/** `/new` execution — the pre-SP12 button behavior, byte-identical (plan SP12: 原样搬进). */
async function onNewSession(): Promise<void> {
  const key = props.selectedKey;
  const c = hub?.control;
  const action = sessionActions.value.find((a) => a.kind === "same-cwd");
  if (action === undefined || !action.enabled || key === null || !c) return;
  newSessionBusy.value = true;
  newSessionNote.value = null;
  try {
    // A dedicated button click IS the explicit intent: `/new` sits in the agent-side policy's
    // `confirm` tier (command-policy.ts), and this button has no inline confirm UI, so without
    // `confirm: true` every click bounced back as an E_CONFIRM_REQUIRED "error". Typed `/new` in
    // DetailDock's command mode still goes through the two-step confirm.
    const outcome = await c.runCommand(key, "new", "", { confirm: true });
    newSessionNote.value = outcome.ok
      ? { kind: "ok", text: t("agents.newSessionOk") }
      : { kind: "err", text: outcome.message ?? outcome.error ?? "E_FAILED" };
  } finally {
    newSessionBusy.value = false;
  }
}

function onMenuSelect(action: NewSessionAction): void {
  if (action.kind === "pick-dir") {
    if (!action.enabled) return showSpawnHint();
    openPicker(false);
    return;
  }
  if (action.kind === "spawn-cwd") {
    if (!action.enabled) return showSpawnHint();
    openPicker(true);
    return;
  }
  // same-cwd — 「替换当前会话（/new）」 goes through the inline confirm bar, never directly.
  if (action.enabled && !newSessionBusy.value) void armReplace();
}

function openPicker(focusSubmit: boolean): void {
  pickerFocusSubmit.value = focusSubmit;
  pickerOpen.value = true;
}

// --- pending spawn rows (SpawnRow; 「关闭」 is a local, memory-only dismiss — the hub keeps
// terminal records until they roll off its retention, so re-snapshots re-show un-dismissed rows)
const dismissedSpawns = ref<ReadonlySet<string>>(new Set());
function dismissSpawn(spawnId: string): void {
  const next = new Set(dismissedSpawns.value);
  next.add(spawnId);
  dismissedSpawns.value = next;
}
const spawnRows = computed(() =>
  pendingRows(hub?.state.value.spawns ?? null).filter((r) => !dismissedSpawns.value.has(r.spawnId)),
);

// ---------------------------------------------------------------------------
// delete entry (web-hub-delete-session plan v2 §5.4): the full `AgentState` (down/card.state)
// backing each card lives in the injected hub state, not the frozen `AgentCardView` prop —
// `removalTargetForAgent` wants that richer shape, same injection pattern as `managed` above.
// `target: null` (online, unmanaged card) hides the button entirely (user 拍板: 在线 TUI 会话
// 不可删). Precomputed per row (rather than called inline from the template) so the union
// narrowing on `target.kind` only has to happen once per card.
// ---------------------------------------------------------------------------
interface AgentRow {
  readonly card: AgentCardView;
  readonly target: ReturnType<typeof removalTargetForAgent>;
}
function toRow(c: AgentCardView): AgentRow {
  return {
    card: c,
    target: removalTargetForAgent(hub?.state.value.agents.get(c.key), hub?.state.value.spawns ?? null),
  };
}
const liveRows = computed<AgentRow[]>(() => live.value.map(toRow));
const staleRows = computed<AgentRow[]>(() => staleOrDown.value.map(toRow));
</script>

<template>
  <nav ref="sidebarEl" class="sidebar" :class="{ 'is-collapsed': collapsed }" aria-label="Agents">
    <div class="sidebar-head">
      <div class="sidebar-headrow">
        <button
          class="btn btn-ghost btn-icon sidebar-collapse-toggle"
          type="button"
          :aria-pressed="collapsed"
          :aria-label="collapsed ? t('agents.expandSidebar') : t('agents.collapseSidebar')"
          @click="toggleCollapsed"
        >
          <AppIcon :name="collapsed ? 'chev-right' : 'chev-left'" class="icon-sm" />
        </button>
        <h2 class="sidebar-title">
          {{ t("agents.title") }} <span class="count num">{{ cards.length }}</span>
        </h2>
        <NewSessionMenu
          :actions="sessionActions"
          :busy="newSessionBusy"
          @select="onMenuSelect"
          @open="refreshSpawnList"
        />
      </div>
      <div class="search">
        <AppIcon name="search" />
        <input
          class="input"
          type="search"
          name="agent-filter"
          :placeholder="t('agents.filterPlaceholder')"
          :aria-label="t('agents.filterAria')"
          autocomplete="off"
          spellcheck="false"
          :value="filter"
          @input="onFilterInput"
        />
      </div>
      <p v-if="newSessionNote" class="new-session-note" :data-kind="newSessionNote.kind" role="status">
        {{ newSessionNote.text }}
      </p>
      <div
        v-if="replaceConfirm"
        class="replace-confirm"
        role="alertdialog"
        aria-labelledby="replace-confirm-title"
        aria-describedby="replace-confirm-body"
        @keydown="onReplaceKeydown"
      >
        <p id="replace-confirm-title" class="replace-confirm-title">{{ t("spawn.replaceConfirmTitle") }}</p>
        <p id="replace-confirm-body" class="replace-confirm-body">{{ t("spawn.replaceConfirmBody") }}</p>
        <div class="replace-confirm-actions">
          <button class="btn btn-ghost btn-xs" type="button" :disabled="newSessionBusy" @click="disarmReplace">
            {{ t("dialog.cancel") }}
          </button>
          <button
            ref="replaceRunBtn"
            class="btn btn-primary btn-xs"
            type="button"
            :disabled="newSessionBusy"
            @click="confirmReplace"
          >
            {{ t("spawn.replaceConfirmRun") }}
          </button>
        </div>
      </div>
    </div>

    <DirPicker
      v-if="pickerOpen"
      :prefill-cwd="pickerPrefill"
      :focus-submit="pickerFocusSubmit"
      :plaintext="plaintext"
      @close="pickerOpen = false"
      @done="pickerOpen = false"
    />
    <ul v-if="spawnRows.length > 0" class="spawn-pending" :aria-label="t('spawn.pendingAria')">
      <li v-for="rec in spawnRows" :key="rec.spawnId">
        <SpawnRow :rec="rec" @dismiss="dismissSpawn(rec.spawnId)" />
      </li>
    </ul>

    <EmptyState v-if="cards.length === 0 && !synced" icon="loader" :title="t('agents.loadingTitle')" />
    <EmptyState
      v-else-if="cards.length === 0"
      icon="terminal"
      :title="t('agents.emptyTitle')"
      :body="`${t('agents.emptyBodyLead')} webHub.enabled ${t('agents.emptyBodyTail')}`"
    >
      <template v-if="pickDirEnabled" #actions>
        <button class="btn spawn-empty-pick" type="button" @click="openPicker(false)">
          {{ t("spawn.itemPickDir") }}
        </button>
      </template>
    </EmptyState>
    <ul v-else class="agent-list">
      <li v-for="row in liveRows" :key="row.card.key" class="agent-item" :class="{ removable: !!row.target }">
        <AgentCard :card="row.card" :selected="row.card.key === selectedKey" />
        <RemoveButton
          v-if="row.target"
          :target="row.target.kind === 'managed' ? { spawnId: row.target.spawnId } : { agentKey: row.card.key }"
          :removing="row.target.kind === 'managed' && row.target.removing"
          :ariaKind="row.target.kind === 'managed' ? 'managed' : 'agent'"
        />
      </li>
      <li v-if="staleOrDown.length > 0" class="agent-group">{{ t("agents.staleOffline") }}</li>
      <li v-for="row in staleRows" :key="row.card.key" class="agent-item" :class="{ removable: !!row.target }">
        <AgentCard :card="row.card" :selected="row.card.key === selectedKey" />
        <RemoveButton
          v-if="row.target"
          :target="row.target.kind === 'managed' ? { spawnId: row.target.spawnId } : { agentKey: row.card.key }"
          :removing="row.target.kind === 'managed' && row.target.removing"
          :ariaKind="row.target.kind === 'managed' ? 'managed' : 'agent'"
        />
      </li>
    </ul>
  </nav>
</template>
