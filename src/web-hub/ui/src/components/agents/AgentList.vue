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
  collapse effect) is CSS-gated to `min-width: 768px` (`agents.css`) rather than JS/`narrow`-gated,
  so mobile's existing full-screen list/drawer behaviour is untouched by construction — collapsing
  on desktop and then shrinking the window never leaves the list stuck hidden.

  "New session" (web control-plane parity + web-hub-spawn SP12 / arch §9.1): the header's
  `NewSessionMenu` split button consumes SP11's `newSessionActions` — the main button / same-cwd
  item re-runs the exact same `/new` command (`ControlHandle.runCommand(agentKey, "new", "")`,
  the identical channel/whitelisted name `DetailDock.vue`'s command mode uses) against the
  currently SELECTED agent (never a bulk/all-agents action; the enable formula stays byte-identical
  to `AgentDetail.vue`'s `controlEnabled` via the action's `enabled`), while the pick-dir item
  (hub cap `spawn.v1` ∧ `GET /api/headless` policy, refreshed on mount/cap change/menu open) opens
  the inline `DirPicker` panel that drives `useNewSession` (plan §3.2). `pendingRows` of the SSE
  `spawns` slot render as `SpawnRow` placeholders above the list (also with 0 agents); a local,
  memory-only dismissed set powers their 「关闭」. No dedicated result UI for same-cwd: one inline
  ok/err line (same convention as `FleetActions.vue`'s `note`), not a toast.
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { newSessionActions, pendingRows, spawnAvailability, type NewSessionAction } from "../../logic/spawn.js";
import type { SpawnListOutcome } from "../../transport/types.js";
import type { AgentListEmits, AgentListProps } from "../../contracts.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import EmptyState from "../shell/EmptyState.vue";
import DirPicker from "../spawn/DirPicker.vue";
import NewSessionMenu from "../spawn/NewSessionMenu.vue";
import SpawnRow from "../spawn/SpawnRow.vue";
import AgentCard from "./AgentCard.vue";

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
// desktop collapse (persisted, CSS-gated to >=768px — see header comment)
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

const selectedAgent = computed(() =>
  props.selectedKey === null ? undefined : hub?.state.value.agents.get(props.selectedKey),
);
const selectedShortCwd = computed(() => props.cards.find((c) => c.key === props.selectedKey)?.shortCwd);

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

const newSessionNote = ref<{ kind: "ok" | "err"; text: string } | null>(null);
const newSessionBusy = ref(false);
const pickerOpen = ref(false);
const pickerPrefill = computed(() => {
  const card = selectedAgent.value?.card as { cwd?: unknown } | undefined;
  return typeof card?.cwd === "string" && card.cwd !== "" ? card.cwd : "~";
});
const plaintext = computed(() => env?.plaintext ?? false);

/** same-cwd — the pre-SP12 `/new` button behavior, byte-identical (plan SP12: 原样搬进). */
async function onNewSession(): Promise<void> {
  const key = props.selectedKey;
  const c = hub?.control;
  const action = sessionActions.value.find((a) => a.kind === "same-cwd");
  if (action === undefined || !action.enabled || key === null || !c) return;
  newSessionBusy.value = true;
  newSessionNote.value = null;
  try {
    const outcome = await c.runCommand(key, "new", "");
    newSessionNote.value = outcome.ok
      ? { kind: "ok", text: t("agents.newSessionOk") }
      : { kind: "err", text: outcome.message ?? outcome.error ?? "E_FAILED" };
  } finally {
    newSessionBusy.value = false;
  }
}

function onMenuSelect(action: NewSessionAction): void {
  if (action.kind === "pick-dir") {
    if (action.enabled) pickerOpen.value = true;
    return;
  }
  void onNewSession();
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
</script>

<template>
  <nav class="sidebar" :class="{ 'is-collapsed': collapsed }" aria-label="Agents">
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
          :short-cwd="selectedShortCwd"
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
    </div>

    <DirPicker
      v-if="pickerOpen"
      :prefill-cwd="pickerPrefill"
      :plaintext="plaintext"
      @close="pickerOpen = false"
      @done="pickerOpen = false"
    />
    <ul v-if="spawnRows.length > 0" class="spawn-pending" :aria-label="t('spawn.pendingAria')">
      <li v-for="rec in spawnRows" :key="rec.spawnId">
        <SpawnRow :rec="rec" @dismiss="dismissSpawn(rec.spawnId)" />
      </li>
    </ul>

    <EmptyState
      v-if="cards.length === 0"
      icon="terminal"
      :title="t('agents.emptyTitle')"
      :body="`${t('agents.emptyBodyLead')} webHub.enabled ${t('agents.emptyBodyTail')}`"
    >
      <template v-if="pickDirEnabled" #actions>
        <button class="btn spawn-empty-pick" type="button" @click="pickerOpen = true">
          {{ t("spawn.itemPickDir") }}
        </button>
      </template>
    </EmptyState>
    <ul v-else class="agent-list">
      <li v-for="card in live" :key="card.key">
        <AgentCard :card="card" :selected="card.key === selectedKey" />
      </li>
      <li v-if="staleOrDown.length > 0" class="agent-group">{{ t("agents.staleOffline") }}</li>
      <li v-for="card in staleOrDown" :key="card.key">
        <AgentCard :card="card" :selected="card.key === selectedKey" />
      </li>
    </ul>
  </nav>
</template>
