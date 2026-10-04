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

  "New session" (web control-plane parity: the only way to start a new session was typing `/new`
  into the composer): a header button re-runs that exact same command — `ControlHandle.runCommand
  (agentKey, "new", "")`, the identical channel/whitelisted name `DetailDock.vue`'s command mode
  uses — against the currently SELECTED agent (never a bulk/all-agents action). Enabled mirrors
  `AgentDetail.vue`'s own `controlEnabled` formula exactly (hub cmd.v1 ∧ agent card control ∧ agent
  live), computed here from the same `HUB_CTX`-injected `HubHandle` TopBar/AgentCard already use for
  the identical reason (this component is not a descendant of `AgentDetail`, which is where that
  formula's canonical copy lives). No dedicated result UI: a successful/failed call gets one
  inline ok/err line (same convention as `FleetActions.vue`'s `note`), not a toast — the new
  session's own effect (the selected card's session label changing) is the real confirmation, and
  if the detail pane happens to be open for that agent, typing `/new` there would have shown the
  same outcome through `CommandResult`, which this button deliberately doesn't duplicate.
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { AgentListEmits, AgentListProps } from "../../contracts.js";
import { HUB_CTX } from "../control/controlContext.js";
import EmptyState from "../shell/EmptyState.vue";
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
// new session (§header comment)
// ---------------------------------------------------------------------------

const hub = inject(HUB_CTX, null);

/** Byte-identical formula to `AgentDetail.vue`'s `controlEnabled` (hub cmd.v1 ∧ agent card
 * control ∧ agent live) — kept as a second copy rather than a shared export because the two
 * components read it off two different props shapes (`AgentState` here vs. `props.agent`
 * there) and plan §5.2 keeps P3's components independently reviewable. */
const selectedAgent = computed(() =>
  props.selectedKey === null ? undefined : hub?.state.value.agents.get(props.selectedKey),
);
const newSessionEnabled = computed(() => {
  const agent = selectedAgent.value;
  if (!agent || hub?.control === undefined) return false;
  if (hub.state.value.control !== true) return false;
  if ((agent.card as { control?: unknown }).control !== true) return false;
  if (agent.down) return false;
  return (agent.card as { state?: unknown }).state !== "stale";
});

const newSessionNote = ref<{ kind: "ok" | "err"; text: string } | null>(null);
const newSessionBusy = ref(false);

async function onNewSession(): Promise<void> {
  const key = props.selectedKey;
  const c = hub?.control;
  if (!newSessionEnabled.value || key === null || !c) return;
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
        <button
          class="btn btn-ghost btn-xs new-session-btn"
          type="button"
          :disabled="!newSessionEnabled || newSessionBusy"
          :aria-label="t('agents.newSessionAria')"
          @click="onNewSession"
        >
          {{ t("agents.newSession") }}
        </button>
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

    <EmptyState
      v-if="cards.length === 0"
      icon="terminal"
      :title="t('agents.emptyTitle')"
      :body="`${t('agents.emptyBodyLead')} webHub.enabled ${t('agents.emptyBodyTail')}`"
    />
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
