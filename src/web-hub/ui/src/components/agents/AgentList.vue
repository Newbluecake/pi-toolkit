<!--
  Agent sidebar / list (ui-design.md §5, §5.1, §6.1, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/agents/**`). Owns the filter textbox and the live/"stale & offline"
  grouping (ui-design §5.1) over the already-derived `AgentCardView[]` its parent
  (`DashboardView.vue`) computes once per agent via `agentCardModel.ts`.

  Desktop collapse (user-reported: the sidebar had no way to reclaim its width on a fixed desktop
  split): a header toggle shrinks `.sidebar` to a narrow icon rail via the SAME `--sidebar-w` CSS
  variable `shell.css`'s `.layout` grid already reads. The STATE is owned by `DashboardView.vue`
  (`useSidebarCollapse` composable; prop `collapsed` + `update:collapsed` here) so a single
  `layoutStyle` computed arbitrates between the rail width and the dragged width — both resolve
  through the same custom property on `.layout` (2026-10-13 bug: a previously dragged width,
  inline on `.layout`, shadowed this component's 56px written on `<html>`, hiding the content
  while the column kept its width). The toggle itself (and the whole collapse effect) is
  CSS-gated to `min-width: 1025px` (`agents.css`) rather than JS/`narrow`-gated, so mobile's
  existing full-screen list/drawer behaviour is untouched by construction — collapsing on
  desktop and then shrinking the window never leaves the list stuck hidden.

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
  ok/err line, not a toast.

  Rename entry (web-hub-rename plan): `RenameButton.vue`, a sibling of `AgentCard` exactly like
  `RemoveButton` below — `toRow`'s `rename` field precomputes `@logic/control.js`'s
  `renameEnabled()` gate (hub `cmd.v1` AND agent card `control` AND agent live AND not mid-
  restore AND the agent's `commands` slot present) plus the current raw session name off the
  injected hub state (the frozen `AgentCardView.sessionLabel` is a localized placeholder-or-name
  string, not usable as an edit prefill) plus the title-auto capability (title-auto plan: the
  `commands` slot lists `title` ⇒ clearing the input and saving sends `/title auto`).
-->
<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useListDensity } from "../../composables/useListDensity.js";
import { browserLocalStorage } from "../shell/themeStorage.js";
import { xsChannelsOf } from "./agentCardModel.js";
import { channelDirectory } from "./channelModel.js";
import { renameEnabled } from "../../logic/control.js";
import {
  classifyRelaunchError,
  newSessionActions,
  pendingRows,
  relaunchableFor,
  restoringKeys,
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
import SessionHistoryDialog from "../spawn/SessionHistoryDialog.vue";
import SpawnRow from "../spawn/SpawnRow.vue";
import AgentCard from "./AgentCard.vue";
import RemoveButton from "./RemoveButton.vue";
import RenameButton from "./RenameButton.vue";

const props = withDefaults(defineProps<AgentListProps>(), { collapsed: false });
const emit = defineEmits<AgentListEmits>();
const { t } = useI18n();

// channel-plan §7 (CHU): sidebar channel filter — component memory only (never persisted). The chip
// row appears only while a non-default channel exists on the hub (cap xs.channel.v1).
const hub = inject(HUB_CTX, null);
const channelPick = ref<string | null>(null);
const channelRows = computed(() => {
  const agents = hub?.state.value.agents;
  if (!(agents instanceof Map)) return [];
  const rows = channelDirectory(agents, hub?.state.value.hub?.["caps"]);
  return rows.some((r) => r.name !== "default") ? rows : [];
});
// a picked channel that vanished from the hub falls back to 「全部」 (no stuck-empty list)
watch(channelRows, (rows) => {
  if (channelPick.value !== null && !rows.some((r) => r.name === channelPick.value)) channelPick.value = null;
});
const filtered = computed(() => {
  const needle = props.filter.trim().toLowerCase();
  let list = props.cards;
  const pick = channelPick.value;
  if (pick !== null && channelRows.value.length > 0) {
    const caps = hub?.state.value.hub?.["caps"];
    list = list.filter((c) => xsChannelsOf(hub?.state.value.agents.get(c.key), caps)?.includes(pick) === true);
  }
  if (needle === "") return list;
  return list.filter((c) => `${c.shortCwd} ${c.sessionLabel}`.toLowerCase().includes(needle));
});
// 2026-10-13 restore order-stability (user report: restart+restore 卡片跳动): a card whose
// managed session is mid-restore (an in-flight spawn record's `restore.prevAgentKey` names it)
// stays in the LIVE group with its `restoring` chip — its process being temporarily dead must
// not sink it into 「过期与离线」 mid-flight. The final position itself is stabilized one layer
// down (`@logic/state.js`'s stableAgentOrder slots the successor back at its historic rank).
const restoringSet = computed(() => restoringKeys(hub?.state.value.spawns ?? null));
const live = computed(() => filtered.value.filter((c) => (!c.stale && !c.down) || restoringSet.value.has(c.key)));
const staleOrDown = computed(() => filtered.value.filter((c) => (c.stale || c.down) && !restoringSet.value.has(c.key)));

function onFilterInput(ev: Event): void {
  emit("update:filter", (ev.target as HTMLInputElement).value);
}

// ---------------------------------------------------------------------------
// desktop collapse (persisted, CSS-gated to >=1025px — see header comment). The STATE lives
// in DashboardView (`useSidebarCollapse`): the collapsed rail and the dragged width resolve
// through the SAME `--sidebar-w` on `.layout`, so a single computed there must arbitrate
// (2026-10-13 bug: AgentList-owned 56px on `<html>` lost to a dragged inline width on
// `.layout` ⇒ blank full-width panel with a lone chevron).
// ---------------------------------------------------------------------------

const listDensity = useListDensity({ storage: browserLocalStorage() });

function toggleCollapsed(): void {
  emit("update:collapsed", !props.collapsed);
}

// ---------------------------------------------------------------------------
// new session (§header comment; web-hub-spawn SP12 — actions come from @logic/spawn.js, SP11)
// ---------------------------------------------------------------------------

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
/** session-history plan §4.7.2 / arch §7.1: the EmptyState 「历史会话」 entry — the `history`
 * action must be present AND enabled (a denied policy keeps it footer-only-disabled). */
const historyEnabled = computed(() => sessionActions.value.some((a) => a.kind === "history" && a.enabled));
/** The sidebar-footer 「历史会话」 entry (2026-10 relocation from the NewSessionMenu dropdown —
 * reachable in every layout that renders this sidebar: the ≥1025 split, the 481–1024 overlay
 * drawer, the tablet card grid and the phone list, so a second menu copy would be pure
 * duplication). Same gating as the old menu item: the action is absent ⇒ footer hidden
 * (no `spawn.history.v1` cap, or the `GET /api/headless` never succeeded), a denied policy ⇒
 * disabled with its reason spelled out (aria-describedby + the visible hint line). */
const historyAction = computed(() => sessionActions.value.find((a) => a.kind === "history") ?? null);
const historyReason = computed(() => {
  const a = historyAction.value;
  if (a === null || a.kind !== "history" || a.enabled || a.reason === undefined) return null;
  return t(spawnDeniedKey(a.reason));
});

function onHistoryEntry(): void {
  const a = historyAction.value;
  if (a === null) return;
  // Disabled entries keep the old menu-item behavior: the click shows the inline policy hint.
  if (!a.enabled) return showSpawnHint();
  pickerOpen.value = false; // one overlay at a time
  historyOpen.value = true;
}

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
  historyOpen.value = false; // one overlay at a time
  pickerFocusSubmit.value = focusSubmit;
  pickerOpen.value = true;
}

// --- 「历史会话…」 (session-history plan §4.7.2): the dialog is Teleport'd like DirPicker —
// mounted only while open, so its fetch engine/timers live exactly as long as the dialog.
const historyOpen = ref(false);

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
  readonly rename: { readonly enabled: boolean; readonly name: string; readonly titleAuto: boolean };
  /** spawn-relaunch: the terminal managed record this offline card may re-fork
   *  (`relaunchableFor` — undefined ⇒ the row keeps the plain click=select behavior). */
  readonly relaunch: { readonly spawnId: string } | undefined;
}

/** web-hub-rename plan: same enable formula as `AgentDetail.vue`'s `controlEnabled` +
 *  `commandsEnabled` (duplicated, not imported — that file is outside this package's exclusive
 *  `components/agents/**` scope), evaluated against the raw `AgentState` this list already
 *  injects for `removalTargetForAgent`/`managedFor`. */
function renameInfoFor(c: AgentCardView): { enabled: boolean; name: string; titleAuto: boolean } {
  const agent = hub?.state.value.agents.get(c.key) as
    | {
        down?: unknown;
        card?: { control?: unknown; state?: unknown };
        session?: { name?: unknown };
        commands?: unknown;
      }
    | undefined;
  const cardRaw = agent?.card ?? {};
  const enabled = renameEnabled({
    hubControl: hub?.state.value.control === true,
    controlPresent: hub?.control !== undefined,
    cardControl: cardRaw.control === true,
    agentLive: agent !== undefined && agent.down !== true && cardRaw.state !== "stale",
    restoring: restoringKeys(hub?.state.value.spawns ?? null).has(c.key),
    hasCommandsSlot: Array.isArray(agent?.commands),
  });
  // title-auto plan: clear-to-auto semantics are only offered when the agent advertises the
  // /title command (a96c189a) in its `commands` slot — an old agent keeps empty ⇒ local cancel.
  const cmds = agent?.commands;
  const titleAuto =
    Array.isArray(cmds) &&
    cmds.some((cmd) => cmd !== null && typeof cmd === "object" && (cmd as { name?: unknown }).name === "title");
  const rawName = agent?.session?.name;
  return { enabled, titleAuto, name: typeof rawName === "string" ? rawName : "" };
}

function toRow(c: AgentCardView): AgentRow {
  return {
    card: c,
    target: removalTargetForAgent(hub?.state.value.agents.get(c.key), hub?.state.value.spawns ?? null),
    rename: renameInfoFor(c),
    relaunch: relaunchableFor(hub?.state.value.spawns ?? null, c.key, hubCaps.value),
  };
}
const liveRows = computed<AgentRow[]>(() => live.value.map(toRow));
const staleRows = computed<AgentRow[]>(() => staleOrDown.value.map(toRow));

// ---------------------------------------------------------------------------
// spawn-relaunch (「离线/过期会话点击直接重新拉起」): a stale row whose card is managed by a
// TERMINAL spawn record turns the WHOLE card click into 「重新拉起」 (capture-phase intercept
// of AgentCard's anchor — plain hash navigation stays the fallback for every other row).
// `relaunching` (per-card, memory-only) is the in-flight guard against double clicks; a
// failure renders a per-row inline error (`classifyRelaunchError` → `spawn.relaunchErr*`).
// Success: the 202 means the record is `starting` again — we navigate to the OLD key's detail,
// where DashboardView's restoring state shows and useHub's `successorOf` follow moves the
// route to the new card once the session is live (the same path a hub-restart restore takes).
// ---------------------------------------------------------------------------
const relaunching = ref<ReadonlySet<string>>(new Set());
const relaunchErr = ref<{ key: string; text: string } | null>(null);

/** Bucket → its `spawn.relaunchErr*` line (prose blocks — translated in zh). */
function relaunchErrorText(outcome: unknown): string {
  switch (classifyRelaunchError(outcome)) {
    case "gone":
      return t("spawn.relaunchErrGone");
    case "alive":
      return t("spawn.relaunchErrAlive");
    case "missing":
      return t("spawn.relaunchErrMissing");
    case "state":
      return t("spawn.relaunchErrState");
    case "denied":
      return t("spawn.relaunchErrDenied");
    case "launcher":
      return t("spawn.relaunchErrLauncher");
    case "rate":
      return t("spawn.relaunchErrRate");
    case "deadline":
      return t("spawn.relaunchErrDeadline");
    case "unsupported":
      return t("spawn.relaunchErrUnsupported");
    default:
      return t("spawn.relaunchErrNetwork");
  }
}

async function relaunchCard(row: AgentRow): Promise<void> {
  const spawn = hub?.spawn;
  const relaunch = row.relaunch;
  if (spawn === undefined || relaunch === undefined) return;
  const key = row.card.key;
  if (relaunching.value.has(key)) return; // 防双击
  relaunchErr.value = null;
  const next = new Set(relaunching.value);
  next.add(key);
  relaunching.value = next;
  const call = spawn.relaunch;
  if (call === undefined) {
    // useHub always provides it (degraded); a bare component-level fake may omit it.
    relaunchErr.value = { key, text: relaunchErrorText({ ok: false, error: "E_UNSUPPORTED" }) };
    const done = new Set(relaunching.value);
    done.delete(key);
    relaunching.value = done;
    return;
  }
  try {
    const out = await call.call(spawn, relaunch.spawnId);
    if (out.ok) {
      // Navigate to the OLD key: the detail shows 「正在恢复」 while the restore job forks,
      // then follows the successor card automatically once the session is live.
      window.location.hash = `#/agent/${encodeURIComponent(key)}`;
      return;
    }
    relaunchErr.value = { key, text: relaunchErrorText(out) };
  } finally {
    const done = new Set(relaunching.value);
    done.delete(key);
    relaunching.value = done;
  }
}

/** Capture-phase click on a stale row: a relaunchable card's whole body is the 「重新拉起」
 *  action; clicks on the row's own buttons (×/rename) and every non-relaunchable row pass
 *  through untouched (the anchor's default hash navigation = 选中查看死 transcript). */
function onStaleRowClick(row: AgentRow, ev: MouseEvent): void {
  if (row.relaunch === undefined) return;
  const el = ev.target as HTMLElement | null;
  if (el !== null && typeof el.closest === "function" && el.closest("button") !== null) return;
  ev.preventDefault();
  ev.stopPropagation();
  void relaunchCard(row);
}
</script>

<template>
  <nav
    ref="sidebarEl"
    class="sidebar"
    :class="{ 'is-collapsed': collapsed }"
    :data-density="listDensity.density.value"
    aria-label="Agents"
  >
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
          class="btn btn-ghost btn-icon list-density-toggle"
          type="button"
          :aria-pressed="listDensity.density.value === 'compact'"
          :aria-label="
            listDensity.density.value === 'compact' ? t('agents.densityCompact') : t('agents.densityDetailed')
          "
          :title="listDensity.density.value === 'compact' ? t('agents.densityCompact') : t('agents.densityDetailed')"
          @click="listDensity.toggle()"
        >
          <AppIcon name="layers" class="icon-sm" />
        </button>
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
      <div
        v-if="channelRows.length > 0"
        class="channel-filter"
        role="group"
        :aria-label="t('agents.channelFilterAria')"
      >
        <button type="button" class="chip" :aria-pressed="channelPick === null" @click="channelPick = null">
          {{ t("agents.channelAll") }}
        </button>
        <button
          v-for="r in channelRows"
          :key="r.name"
          type="button"
          class="chip"
          translate="no"
          :aria-pressed="channelPick === r.name"
          @click="channelPick = channelPick === r.name ? null : r.name"
        >
          #{{ r.name }} <span class="num">{{ r.members }}</span>
        </button>
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
    <SessionHistoryDialog v-if="historyOpen" :plaintext="plaintext" @close="historyOpen = false" />
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
      <template v-if="pickDirEnabled || historyEnabled" #actions>
        <button v-if="pickDirEnabled" class="btn spawn-empty-pick" type="button" @click="openPicker(false)">
          {{ t("spawn.itemPickDir") }}
        </button>
        <button v-if="historyEnabled" class="btn spawn-empty-pick" type="button" @click="historyOpen = true">
          {{ t("history.emptyStateItem") }}
        </button>
      </template>
    </EmptyState>
    <ul v-else class="agent-list">
      <li
        v-for="row in liveRows"
        :key="row.card.key"
        class="agent-item"
        :class="{ removable: !!row.target, renamable: row.rename.enabled }"
      >
        <AgentCard :key="listDensity.density.value" :card="row.card" :selected="row.card.key === selectedKey" />
        <RenameButton
          v-if="row.rename.enabled"
          :agent-key="row.card.key"
          :name="row.rename.name"
          :title-auto="row.rename.titleAuto"
        />
        <RemoveButton
          v-if="row.target"
          :target="row.target.kind === 'managed' ? { spawnId: row.target.spawnId } : { agentKey: row.card.key }"
          :removing="row.target.kind === 'managed' && row.target.removing"
          :ariaKind="row.target.kind === 'managed' ? 'managed' : 'agent'"
        />
      </li>
      <li v-if="staleOrDown.length > 0" class="agent-group">{{ t("agents.staleOffline") }}</li>
      <li
        v-for="row in staleRows"
        :key="row.card.key"
        class="agent-item"
        :class="{
          removable: !!row.target,
          renamable: row.rename.enabled,
          relaunchable: row.relaunch !== undefined,
          relaunching: relaunching.has(row.card.key),
        }"
        @click.capture="onStaleRowClick(row, $event)"
      >
        <AgentCard :key="listDensity.density.value" :card="row.card" :selected="row.card.key === selectedKey" />
        <!-- spawn-relaunch affordance: hover-revealed on hover-capable pointers, always visible
             on touch (same `.agent-item` convention as the delete button); the busy state swaps
             the label for a spinner line and stays visible until the call settles. -->
        <span
          v-if="row.relaunch !== undefined"
          class="relaunch-hint"
          :class="{ busy: relaunching.has(row.card.key) }"
          role="note"
        >
          <AppIcon :name="relaunching.has(row.card.key) ? 'loader' : 'refresh'" class="icon-sm" />
          {{ relaunching.has(row.card.key) ? t("spawn.relaunchPending") : t("spawn.relaunchHint") }}
        </span>
        <p v-if="relaunchErr !== null && relaunchErr.key === row.card.key" class="relaunch-note" role="alert">
          {{ relaunchErr.text }}
        </p>
        <RenameButton
          v-if="row.rename.enabled"
          :agent-key="row.card.key"
          :name="row.rename.name"
          :title-auto="row.rename.titleAuto"
        />
        <RemoveButton
          v-if="row.target"
          :target="row.target.kind === 'managed' ? { spawnId: row.target.spawnId } : { agentKey: row.card.key }"
          :removing="row.target.kind === 'managed' && row.target.removing"
          :ariaKind="row.target.kind === 'managed' ? 'managed' : 'agent'"
        />
      </li>
    </ul>

    <!-- 「历史会话」 footer entry (session-history plan §4.7.2): pinned at the sidebar's
         bottom — `margin-top: auto` keeps it below the scrollable list even when the list is
         short/empty, so it never scrolls away (any layout). -->
    <div v-if="historyAction" class="sidebar-foot">
      <button
        class="sidebar-history-btn"
        type="button"
        :disabled="!historyAction.enabled"
        :aria-label="t('history.sidebarEntry')"
        :aria-describedby="historyReason !== null ? 'sidebar-history-reason' : undefined"
        @click="onHistoryEntry"
      >
        <AppIcon name="clock" class="icon-sm" />
        <span>{{ t("history.sidebarEntry") }}</span>
      </button>
      <!-- sr-ONLY in the collapsed rail (agents.css) — never display:none, so the disabled
           reason the aria-describedby above points at stays exposed to AT in every state. -->
      <p v-if="historyReason !== null" id="sidebar-history-reason" class="sidebar-history-reason">
        {{ historyReason }}
      </p>
    </div>
  </nav>
</template>
