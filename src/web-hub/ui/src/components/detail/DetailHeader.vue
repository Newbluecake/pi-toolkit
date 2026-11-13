<!--
  Detail pane header: back button (single-view bands: ≤767 via `narrow`, 481–1024 mid band via
  the injected `SIDEBAR_DRAWER` context), mid-band drawer toggle, title, status pill, session
  info, session cost (ui-design.md §5.2, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
  `components/detail/**`). 2026-10-05 (user 现场拍板): the CONTEXT metric moved out of this
  header into the composer as `control/ContextRing.vue` (inject-only via `DETAIL_METRICS`).
  web-hub-spawn SP12 adds, via `HUB_CTX` inject
  only (frozen props untouched, kept deliberately local so the pending mobile-collapse line can
  still reflow this header freely): the managed session's 「停止会话」 button and the
  first-prompt refill notice (arch §9.1). 2026-10 variant-A redesign (user-picked mockup
  pwh-stopbtn/v-a): idle is an icon-only ghost button; the armed state is an inline confirm
  pill (✓/✕) instead of a relabelled text button — see the template block below.

  Mobile-adaptation package (todo #7), inject/local-only like SP12:
  `SIDEBAR_DRAWER` (DashboardView-provided): while the 481–1024px mid band shows a detail
  route, a 「show agents list」 toggle opens the sidebar as an overlay drawer, and the back
  button renders even though `narrow` is false (single-view navigation needs it).
  (Its second addition — the `.metrics-wrap` fold — is gone again, see 2026-10-07 below.)

  2026-10 (user field report, fold-into-info-stack revision): `.metrics-wrap` used to live in
  its own grid column to the right of the title/session-info stack from 481px up (full panel
  always open ≥1025px) — read as visually disconnected and crowded out cwd/model text.

  2026-10-07 (user request 「花费合并到第一行的会话详情」): the cost row is GONE from this
  header altogether — `SessionInfo`'s summary line carries a `$…` chip and its expanded kv
  panel carries the cost row (incl. the sub-agent aside). The `metricsCollapsed` fold state,
  the `.metrics-summary` toggle and `detail.metricsToggleAria` went with it.

  2026-10 (user request 「红框部分支持收起，点击标题展开」): the info block under the titlebar
  (SessionInfo / TasksPanel / WorktreePanel / CacheKeepalivePanel) collapses behind the title itself —
  the title text is wrapped in a disclosure <button> (h2 keeps `id="detail-title"`), the state
  is the browser-local `pwh_detail_head_collapsed` pref (global, fail-open to EXPANDED; see
  `composables/useDetailHeadCollapse.ts`), and the transient `<p>` notices stay outside the
  block. 2026-10 (user request 「标题那个箭头我感觉可以去掉」): the leading chevron glyph is
  removed — the toggle is text-only (hover background + aria-expanded/aria-controls carry the
  disclosure affordance). Styles: `.detail-title-toggle` / `.detail-title-text` /
  `.detail-head-info` in detail.css.
-->
<script setup lang="ts">
import {
  computed,
  h,
  render,
  defineAsyncComponent,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import { TERMINAL_ENTRY } from "../../logic/terminalContext.js";
import AppIcon from "../../icons/AppIcon.vue";
import { agentVisualState } from "../../composables/visual-state.js";
import { useI18n } from "../../composables/useI18n.js";
import { useDetailHeadCollapse } from "../../composables/useDetailHeadCollapse.js";
import { useMedia } from "../../composables/useMedia.js";
import { browserLocalStorage } from "../shell/themeStorage.js";
import { managedFor, restoringKeys } from "../../logic/spawn.js";
import { classifyRemoveError, removalTargetForAgent } from "../../logic/remove.js";
import {
  foldTitlebar,
  TITLEBAR_FOLD_ORDER,
  TITLEBAR_TERMINAL_FOLD_ORDER,
  TITLEBAR_ICON_TIER_MAX_PX,
  type TitlebarFoldId,
  type TitlebarFoldState,
} from "../../logic/headerFold.js";
import type { DetailHeaderEmits, DetailHeaderProps } from "../../contracts.js";
import { CONTROL_VIEW, HUB_CTX } from "../control/controlContext.js";
import { PRIVACY_LOCK_CTX } from "../privacy/privacyContext.js";
import { SIDEBAR_DRAWER } from "../shell/sidebarDrawer.js";
import "../../styles/spawn.css";
import { cardOf, sessionOf, statusOf } from "./agentViews.js";
import { resumeAvailable, RESUME_DIALOG } from "@logic/resume.js";
import SessionInfo from "./SessionInfo.vue";
import StatusPill from "./StatusPill.vue";
import HeaderOverflowMenu, { type HeaderOverflowItem } from "./HeaderOverflowMenu.vue";
import TasksPanel from "./TasksPanel.vue";
import WorktreePanel from "./WorktreePanel.vue";
import GraphPanel from "./GraphPanel.vue";
import { cacheKeepaliveOf } from "./cacheKeepaliveView.js";
import { XS_CHANNEL_CAP, xsAliasOf, xsUnreadLabel, xsUnreadOf } from "../agents/agentCardModel.js";
import { schedCapOn, schedSummaryOf, sessionProjectionOf } from "../../logic/schedule.js";
import { worktreesOf } from "./worktreesView.js";

const props = defineProps<DetailHeaderProps>();
const emit = defineEmits<DetailHeaderEmits>();
const { t } = useI18n();

const session = computed(() => sessionOf(props.agent));
const card = computed(() => cardOf(props.agent));
const status = computed(() => statusOf(props.agent));

const visual = computed(() => agentVisualState(props.agent));
const statusLabel = computed(() => t(`common.status.${visual.value}`));

// worktree-web W4: the repo's git worktrees ride `StatusInfo.worktrees` (no state.js mirror —
// the status reducer replaces `agent.status` wholesale); undefined ⇒ the panel renders nothing.
const worktrees = computed(() => worktreesOf(props.agent));

// 2026-10-15 (user ruling, bash→fleet): the background bash jobs LEFT this header — they now
// live as the fleet drawer's own 「bash」 group (components/fleet/FleetBashJobs.vue, same
// `StatusInfo.bashJobs` wire via bashJobsOf). Nothing renders here anymore.

// cache-keepalive-web P-B (§4): the main session's prompt-cache keepalive rides
// `StatusInfo.cacheKeepalive` (same no-state.js-mirror posture as bashJobs); undefined ⇒ no
// panel (web-hub off / keepalive off / silent projection — byte-equal to the pre-feature shape).
// The panel BODY is a lazy chunk (defineAsyncComponent, GraphPanel→WorktreeGraph precedent)
// for the first-screen budget: only the narrowing helper + this wrapper ride the main bundle.
const cacheKeepalive = computed(() => cacheKeepaliveOf(props.agent));
const CacheKeepalivePanel = defineAsyncComponent(() => import("./CacheKeepalivePanel.vue"));

const title = computed(() => {
  const name = session.value?.name;
  if (typeof name === "string" && name !== "") return name;
  const sessionId = session.value?.sessionId;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId.slice(0, 8) : t("agents.noSessionName");
});

// ---------------------------------------------------------------------------
// todo #7 (see the file header): mid-band drawer toggle + ≤480px metrics fold
// ---------------------------------------------------------------------------

const drawer = inject(SIDEBAR_DRAWER, null);
const showBack = computed(() => props.narrow || drawer?.active.value === true);

// ---------------------------------------------------------------------------
// web-hub-privacy plan v2.1 (P2), 2026-11-03 user decision: the header button is the
// mark-STATE toggle (the card hover affordance's keyboard/备用 twin). An UNMARKED session
// gets 「锁定」 (`privacy.lock({locked:true})` — persistent mark, no password); a MARKED
// session being viewed (necessarily view-unlocked — otherwise the lock screen owns the pane
// and this header isn't mounted) gets 「解锁」, which opens the 取消标记 flow (`requestUnmark`:
// LAN password dialog / loopback confirm — the same entry the card uses). The former
// 「立即锁定」 manual view-relock entry is gone from the UI (`relock("manual")` stays
// API-only in `usePrivacyLock`; route/idle/tab-hidden still relock). Desktop band +
// `privacy.v1` cap only; no provider / no cap / phone band ⇒ no button at all.
// ---------------------------------------------------------------------------
const terminalEntry = inject(TERMINAL_ENTRY, null);
const privacy = inject(PRIVACY_LOCK_CTX, null);
const privacyMarked = computed(() => privacy?.isMarked(props.agent.key) ?? false);
const privacyButton = computed(
  () => privacy !== null && privacy.enabled.value && privacy.sessionIdOf(props.agent.key) !== null,
);
const privacyError = computed(() => {
  const err = privacy?.actionError.value;
  return err !== null && err !== undefined && err.agentKey === props.agent.key ? err : null;
});

function onPrivacyClick(): void {
  if (privacy === null) return;
  if (privacyMarked.value) privacy.requestUnmark(props.agent.key);
  else void privacy.mark(props.agent.key);
}

// ---------------------------------------------------------------------------
// web-hub-spawn SP12 (arch §9.1) — additive, inject-only (the frozen DetailHeaderProps stay
// untouched): a spawn record managing THIS agent adds 「停止会话」 (two-step arm, same grammar
// as StopButton) wired to `useSpawn.stop`, and a terminal failed/expired first prompt whose
// body `useNewSession` already put back into the draft surfaces as a one-time dismissible note.
// ---------------------------------------------------------------------------
const hub = inject(HUB_CTX, null);
// channel-plan §12.6 (IBU): unread cross-session inbox badge; absent field / no xs.v1 ⇒ nothing.
const xsUnread = computed(() => xsUnreadOf(props.agent, hub?.state.value.hub?.["caps"]));
const managed = computed(() => managedFor(hub?.state.value.spawns ?? null, props.agent.key));
// spawn-restore plan §9.1 (F20): the OLD agent of a restore in flight — `restoring` badge here,
// the composer itself goes read-only through AgentDetail's readonlyReason.
const restoring = computed(() => restoringKeys(hub?.state.value.spawns ?? null).has(props.agent.key));

const stopArmed = ref(false);
const stopBusy = ref(false);
const stopError = ref<string | null>(null);
let stopArmTimer: ReturnType<typeof setTimeout> | undefined;
const STOP_ARM_MS = 4000;
// 2026-10 variant-A redesign: the idle icon button / armed pill / stopping pill are separate
// elements, so the two ends of the arm↔disarm round trip need their own focus targets.
const stopIdleBtn = ref<HTMLButtonElement | null>(null);
const stopOkBtn = ref<HTMLButtonElement | null>(null);
const stopPill = ref<HTMLElement | null>(null);

/** stopping = the record already stopping OR our own stop RPC still in flight (busy). */
const stopStopping = computed(() => stopBusy.value || managed.value?.state === "stopping");

function disarmStop(): void {
  stopArmed.value = false;
  if (stopArmTimer !== undefined) {
    clearTimeout(stopArmTimer);
    stopArmTimer = undefined;
  }
}

/** Arm in place: expand the confirm pill and hand focus to its ✓ control (the idle button
 * that received the click is about to unmount). */
function armStop(): void {
  stopArmed.value = true;
  stopArmTimer = setTimeout(autoDisarmStop, STOP_ARM_MS);
  void nextTick(() => stopOkBtn.value?.focus());
}

/** ✕ — explicit cancel: disarm and give focus back to the idle icon button. */
function cancelStop(): void {
  disarmStop();
  void nextTick(() => stopIdleBtn.value?.focus());
}

/** 4s window elapsed: disarm, and if keyboard focus was inside the pill (which is about to
 * unmount) hand it back to the idle button instead of dropping it to <body>. */
function autoDisarmStop(): void {
  stopArmTimer = undefined;
  const active = typeof document === "undefined" ? null : document.activeElement;
  const hadFocus = active !== null && stopPill.value?.contains(active) === true;
  disarmStop();
  if (hadFocus) void nextTick(() => stopIdleBtn.value?.focus());
}

async function onStopSession(): Promise<void> {
  const rec = managed.value;
  const spawn = hub?.spawn;
  if (rec === undefined || spawn === undefined || stopBusy.value || rec.state === "stopping") return;
  if (!stopArmed.value) {
    armStop();
    return;
  }
  disarmStop();
  stopBusy.value = true;
  stopError.value = null;
  try {
    const outcome = await spawn.stop(rec.spawnId);
    if (!outcome.ok) stopError.value = outcome.error ?? "E_FAILED";
  } finally {
    stopBusy.value = false;
  }
}

function onStopKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && stopArmed.value) {
    ev.stopPropagation();
    cancelStop();
  }
}

// ---------------------------------------------------------------------------
// 「删除会话」 (2026-10-28 user ruling: the cards' corner × is gone, deletion lives here;
// 2026-11-02 user ruling: no longer a PERMANENT ⋯ entry — it is a normal in-bar icon button
// on wide bars and joins the issue-#41 fold set as the FIRST button to fold into 「⋯」 on
// narrow bars; on touch screens it stays in the menu like the idle stop button, 防误触).
// A removable session (managed record or offline card — `removalTargetForAgent`, the same
// target the old card button used) gets the button/entry. Same two-step grammar as the stop
// button from EITHER entrance: the button/menu item arms, an in-bar ✓/✕ pill confirms (4s
// auto-cancel, Esc cancels, focus follows), then `hub.removeAgent(target)`. No optimistic
// removal — the pane goes away only when the hub's broadcast lands; a failure shows the
// classified reason.
// ---------------------------------------------------------------------------
const removeTarget = computed(() => removalTargetForAgent(props.agent, hub?.state.value.spawns ?? null));
const delArmed = ref(false);
const delBusy = ref(false);
const delError = ref<string | null>(null);
let delArmTimer: ReturnType<typeof setTimeout> | undefined;
const delIdleBtn = ref<HTMLButtonElement | null>(null);
const delOkBtn = ref<HTMLButtonElement | null>(null);
const delPill = ref<HTMLElement | null>(null);
/** in-flight = our own RPC OR the hub-confirmed pending delete (another tab / 202 state). */
const delRemoving = computed(
  () => delBusy.value || (removeTarget.value?.kind === "managed" && removeTarget.value.removing),
);

function disarmDelete(): void {
  delArmed.value = false;
  if (delArmTimer !== undefined) {
    clearTimeout(delArmTimer);
    delArmTimer = undefined;
  }
}

/** Arm from EITHER entrance (inline button / ⋯ item): expand the confirm pill and hand focus
 * to its ✓ control (the control that received the click is about to unmount/close). */
function armDelete(): void {
  if (removeTarget.value === null || delRemoving.value) return;
  delError.value = null;
  delArmed.value = true;
  delArmTimer = setTimeout(autoDisarmDelete, STOP_ARM_MS);
  void nextTick(() => delOkBtn.value?.focus());
}

/** ✕ — explicit cancel: disarm and give focus back to the idle icon button when it is in the
 * bar (touch screens keep deletion menu-only — nothing to refocus there). */
function cancelDelete(): void {
  disarmDelete();
  void nextTick(() => delIdleBtn.value?.focus());
}

/** 4s window elapsed: disarm, and if keyboard focus was inside the pill (which is about to
 * unmount) hand it back to the idle button instead of dropping it to <body>. */
function autoDisarmDelete(): void {
  delArmTimer = undefined;
  const active = typeof document === "undefined" ? null : document.activeElement;
  const hadFocus = active !== null && delPill.value?.contains(active) === true;
  disarmDelete();
  if (hadFocus) void nextTick(() => delIdleBtn.value?.focus());
}

async function onDeleteSession(): Promise<void> {
  const target = removeTarget.value;
  if (target === null || delBusy.value) return;
  disarmDelete();
  const removeAgent = hub?.removeAgent;
  if (removeAgent === undefined) {
    delError.value = "unsupported";
    return;
  }
  delBusy.value = true;
  delError.value = null;
  try {
    const outcome = await removeAgent(
      target.kind === "managed" ? { spawnId: target.spawnId } : { agentKey: props.agent.key },
    );
    if (!outcome.ok) delError.value = classifyRemoveError(outcome) ?? "network";
  } finally {
    delBusy.value = false;
  }
}

function onDeleteKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && delArmed.value) {
    ev.stopPropagation();
    cancelDelete();
  }
}

onUnmounted(() => {
  disarmStop();
  disarmDelete();
});

// ---------------------------------------------------------------------------
// Web `/clear` quick button (2026-10 user request): starts a NEW session in the SAME pi
// process — the web twin of the TUI's /clear (= session-nav's alias for builtin /new). It
// rides the EXISTING command path end to end: `runCommand(agentKey, "new", "",
// { confirm: true })` through `useControl` → hub cmd → `builtin-bridge.ts`'s `/new` →
// `/webhub __exec new <nonce>` → `ctx.newSession()`. The confirm flag is baked in up front
// (the user's explicit 「无需二次确认」), so the dock's E_CONFIRM_REQUIRED/CommandConfirm flow
// never engages and NO confirmation dialog exists anywhere in this button's flow. Gating is
// the composer's exact slash-command surface (`CONTROL_VIEW.enabled` — hub cmd.v1 ∧ card
// control ∧ live — plus `commandsEnabled`, the agent's `command.v1` slot). Deliberately NOT
// disabled while busy: builtin `new` has no `policyBusy` (command-policy.ts) and the bridge
// dispatches with `deliverAs:"followUp"`, so a busy agent queues it exactly like typing
// /new in the composer. In-flight disable is the local `clearing` ref (double-submit guard;
// the optimistic queue row is the ctl item `useControl` already dispatches). A wire failure
// surfaces as this header's one-line role=alert note (the stop-session error's
// `.spawn-stop-note` pattern — no new dialog); success needs no work here: the agentKey
// stays constant and state.js's `applySession` clears + resyncs the same agent's transcript,
// which is precisely the session-switch plan's follow behavior.
// ---------------------------------------------------------------------------
const controlView = inject(CONTROL_VIEW, null);
const clearUsable = computed(
  () =>
    controlView !== null &&
    controlView.control !== null &&
    controlView.enabled.value &&
    controlView.commandsEnabled.value,
);
const clearing = ref(false);
const clearError = ref<string | null>(null);

// ---------------------------------------------------------------------------
// web-resume plan v2 §2.6 D7 (P3) — the 「恢复」 button right after 「清空」: same gating as
// the clear button (CONTROL_VIEW.enabled ∧ commandsEnabled) plus the resume.v1 feature
// signal (§2.7), deliberately NOT busy-gated (D4: while busy the LIST stays browsable —
// only its rows go disabled inside the dialog). Opens the same lazy ResumeDialog.
// ---------------------------------------------------------------------------
const resumeHost = inject(RESUME_DIALOG, null);
const resumeUsable = computed(() => clearUsable.value && resumeAvailable(status.value));

// ---------------------------------------------------------------------------
// channel-plan §7 (CHU): 「频道」 button → lazy ChannelsDialog. Needs hub cap xs.channel.v1, the
// session's `status.xs` slot (xs usable on that session) and the same control gate as 「清空」
// (the dialog drives `/fabric join|leave` through the command channel).
// ---------------------------------------------------------------------------
const ChannelsDialog = defineAsyncComponent(() => import("./ChannelsDialog.vue"));
const channelsOpen = ref(false);
const channelsUsable = computed(() => {
  const caps = hub?.state.value.hub?.["caps"];
  if (!Array.isArray(caps) || !caps.includes(XS_CHANNEL_CAP)) return false;
  const xs = (status.value as { xs?: unknown } | undefined)?.xs;
  return clearUsable.value && typeof xs === "object" && xs !== null;
});

// ---------------------------------------------------------------------------
// scheduled-reports W1 (plan r3 §5.6) + schedule-auto-approve r2 W2: the 「定时」 button →
// lazy SchedulePanel, and the aggregated TasksPanel section below. Gated ONLY on the hub's
// sched.v1 cap + this card having a sessionId — NOT on the control gate: the surfaces are
// read-only by default (write buttons hide when offline, E3). Mounted inside AgentDetail's
// tree, so a privacy relock unmounts them with everything else (ResumeDialog precedent).
// ---------------------------------------------------------------------------
const SchedulePanel = defineAsyncComponent(() => import("../schedule/SchedulePanel.vue"));
const schedOpen = ref(false);
const schedSessionId = computed(() => {
  const sid = session.value?.["sessionId"];
  return typeof sid === "string" && sid !== "" ? sid : undefined;
});
const schedUsable = computed(() => schedCapOn(hub?.state.value.hub?.["caps"]) && schedSessionId.value !== undefined);

// schedule-auto-approve r2 W2: the TasksPanel's sched inputs — the summary gates the panel
// (undefined ⇒ no ⏰ segment, no sched section) and the raw projection carries the rows.
const schedSummary = computed(() =>
  schedSummaryOf(hub?.state.value.hub?.["caps"], hub?.state.value.schedules, schedSessionId.value),
);
const schedProj = computed(() =>
  schedUsable.value ? sessionProjectionOf(hub?.state.value.schedules, schedSessionId.value) : undefined,
);
/** Write gate for the panel's pause/resume/rm (same gate as SchedulePanel's canWrite):
 *  control surface on + commands on + the agent online. */
const schedCanWrite = computed(
  () =>
    controlView !== null && controlView.enabled.value && controlView.commandsEnabled.value && props.agent.down !== true,
);
/** TasksPanel `open-run` ⇒ the fleet drawer's run view (FleetDrawer's selectRun precedent). */
function onSchedOpenRun(runId: string): void {
  hub?.selectRun?.(props.agent.key, runId);
}

// alias-plan r4 §7.2 (ALU): the held alias renders as a small `@alias` right after the title;
// clicking it opens the same (lazily loaded) 「频道与别名」 dialog. Drawn only when the hub
// pushed `status.xs.alias` under the xs.alias.v1 cap — otherwise zero trace.
const headerAlias = computed(() => xsAliasOf(props.agent, hub?.state.value.hub?.["caps"]));
function onAliasOpen(): void {
  if (channelsUsable.value) channelsOpen.value = true;
}

async function onClear(): Promise<void> {
  const view = controlView;
  const c = view?.control ?? null;
  if (view === null || c === null || clearing.value || !clearUsable.value) return;
  clearing.value = true;
  clearError.value = null;
  try {
    const outcome = await c.runCommand(view.agentKey, "new", "", { confirm: true });
    if (!outcome.ok) clearError.value = outcome.error ?? "E_FAILED";
  } catch {
    clearError.value = "E_NETWORK";
  } finally {
    clearing.value = false;
  }
}

/** One-time first-prompt notice: keyed by spawnId, dismissed per record (一次性). */
const fpNotice = computed(() => {
  const flow = hub?.spawn?.newSession.flow.value;
  if (flow === undefined) return null;
  if (
    flow.phase === "done" &&
    flow.agentKey === props.agent.key &&
    flow.firstPrompt !== undefined &&
    (flow.firstPrompt.state === "failed" || flow.firstPrompt.state === "expired") &&
    flow.firstPrompt.refilled === "draft"
  ) {
    return { id: flow.spawnId, state: flow.firstPrompt.state };
  }
  if (flow.phase === "failed" && flow.agentKey === props.agent.key && flow.refilled === "draft") {
    return { id: flow.spawnId ?? flow.reqId ?? "", state: flow.code ?? flow.kind };
  }
  return null;
});
const fpDismissedId = ref<string | null>(null);
const fpNoticeVisible = computed(() => fpNotice.value !== null && fpNotice.value.id !== fpDismissedId.value);

// ---------------------------------------------------------------------------
// 2026-10 (user request 「红框部分支持收起，点击标题展开」): the whole info block under the
// titlebar — SessionInfo / TasksPanel / WorktreePanel / CacheKeepalivePanel — collapses behind the
// title itself. The preference is browser-local (`pwh_detail_head_collapsed`, "1" = collapsed),
// global (not per session) and fails open to EXPANDED, so the header stays byte-identical for
// anyone who never toggles. The transient `<p>` notices above the block (stop error, first-
// prompt refill) are NOT part of the collapsible block — an alert must never be hidden by a
// layout preference.
// ---------------------------------------------------------------------------
const headCollapse = useDetailHeadCollapse({ storage: browserLocalStorage() });
const headCollapsed = headCollapse.collapsed; // top-level ref → template auto-unwrap

/** Drag-select guard: a click that ends an in-title text selection must read as a selection,
 * not as a toggle (desktop copy path — see the 2026-10 dispatcher ruling). */
function onToggleHeadInfo(): void {
  const sel = typeof window === "undefined" ? null : (window.getSelection?.() ?? null);
  if (sel !== null && sel.toString() !== "") return;
  headCollapse.toggle();
}

// ---------------------------------------------------------------------------
// issue #41 (titlebar narrow-screen overflow): measure the bar (ONE ResizeObserver on
// `.detail-titlebar`, fired per frame at most — RO callbacks are already frame-aligned, no
// extra rAF) and let logic/headerFold.ts's pure `foldTitlebar` decide which right-side
// buttons fold into the 「⋯」 menu, so the title never drops below its 96px clickable floor.
// Fold priority: delete → privacy → schedule → resume → channels → stop → clear (「删除会话」
// lowest-frequency, added 2026-11-02). No measurement (SSR first paint / RO unavailable /
// zero-layout) ⇒ empty fold state ⇒ the pre-feature DOM.
// ---------------------------------------------------------------------------
const titlebarEl = ref<HTMLElement | null>(null);
const foldState = ref<TitlebarFoldState>({ folded: [], aliasGlyph: false, pillDot: false });
const coarsePointer = useMedia(window, "(pointer: coarse)").matches;
/** Last measured full-form widths — folded / degraded elements can't be re-measured. */
const foldWidthCache = new Map<TitlebarFoldId, number>();
let aliasFullCache = 0;
let pillFullCache = 0;

function isFolded(id: TitlebarFoldId): boolean {
  // Touch screens: the IDLE stop icon and 「删除会话」 are always folded into the 「⋯」 menu
  // (a swipe / tap on the title area too easily hits a bare destructive icon — 防误触). The
  // armed/busy pills never go through this (their own v-ifs), so confirm/busy stay in the bar.
  if ((id === "stop" || id === "delete") && coarsePointer.value) return true;
  return foldState.value.folded.includes(id);
}

/** Present foldable buttons in FOLD-PRIORITY order (the armed/busy stop pill is a transient
 * in-bar state and never folds — only the IDLE stop button does). */
function presentFoldIds(): TitlebarFoldId[] {
  const present = new Set<TitlebarFoldId>();
  if (privacyButton.value) present.add("privacy");
  if (terminalEntry?.available.value) present.add("terminal");
  if (schedUsable.value) present.add("schedule");
  if (resumeUsable.value) present.add("resume");
  if (channelsUsable.value) present.add("channels");
  if (managed.value !== undefined && !stopArmed.value && !stopStopping.value && !coarsePointer.value)
    present.add("stop"); // coarse: always folded, nothing to measure
  if (clearUsable.value) present.add("clear");
  // 「删除会话」 (2026-11-02): a normal foldable button now — measured like the rest, folded
  // first (TITLEBAR_FOLD_ORDER). Coarse pointers keep it menu-only, exactly like idle stop.
  if (removeTarget.value !== null && !delArmed.value && !delRemoving.value && !coarsePointer.value)
    present.add("delete"); // coarse: always folded, nothing to measure
  return (terminalEntry?.available.value ? TITLEBAR_TERMINAL_FOLD_ORDER : TITLEBAR_FOLD_ORDER).filter((id) =>
    present.has(id),
  );
}

function measureTitlebar(): void {
  const el = titlebarEl.value;
  if (el === null) return;
  const barWidth = el.clientWidth;
  if (!(barWidth > 0)) return; // hidden / zero-layout (happy-dom): keep the state as-was
  // Mirror the CSS tiers: at/below TITLEBAR_ICON_TIER_MAX_PX the row's effective spacing
  // compacts 8 → 4 (fine pointers: -4px sibling margins; coarse: viewport-media gap — a
  // container query can't restyle its own container); icon-only buttons are 32px square
  // (44px on coarse pointers, never overlapped there).
  const gap = barWidth <= TITLEBAR_ICON_TIER_MAX_PX ? 4 : 8;
  const btnFallback = coarsePointer.value ? 44 : 32;
  const items = presentFoldIds().map((id) => {
    const btn = el.querySelector(`[data-fold="${id}"]`);
    let width = btn instanceof HTMLElement ? btn.offsetWidth : 0;
    if (width > 0) foldWidthCache.set(id, width);
    else width = foldWidthCache.get(id) ?? btnFallback;
    return { id, width };
  });
  // Σ(width+gap) of the non-foldable, non-title, non-alias, non-pill children (back/drawer
  // buttons, unread/restoring chips, the transient stop-armed/busy pill).
  let fixedSlots = 0;
  for (const child of Array.from(el.children)) {
    const c = child as HTMLElement;
    if (
      c.classList.contains("detail-title") ||
      c.classList.contains("detail-more-wrap") ||
      c.hasAttribute("data-fold") ||
      c.hasAttribute("data-alias") ||
      c.hasAttribute("data-pill")
    ) {
      continue;
    }
    fixedSlots += c.offsetWidth + gap;
  }
  let aliasFull = 0;
  const aliasEl = el.querySelector("[data-alias]");
  if (aliasEl !== null && headerAlias.value !== undefined) {
    const w = (aliasEl as HTMLElement).offsetWidth;
    if (!foldState.value.aliasGlyph && w > 0) aliasFullCache = w; // only trust full-form widths
    aliasFull = (foldState.value.aliasGlyph ? aliasFullCache : w) || aliasFullCache;
    if (aliasFull === 0) aliasFull = 26 + headerAlias.value.length * 9; // never measured: estimate
    aliasFull += gap;
  }
  const pillEl = el.querySelector("[data-pill]");
  let pillFull = 0;
  if (pillEl !== null) {
    const w = (pillEl as HTMLElement).offsetWidth;
    if (!foldState.value.pillDot && w > 0) pillFullCache = w;
    pillFull = (foldState.value.pillDot ? pillFullCache : w) || pillFullCache || 78;
    pillFull += gap;
  }
  const next = foldTitlebar({
    barWidth,
    gap,
    moreSlot: btnFallback + gap,
    fixedSlots,
    aliasFull,
    pillFull,
    items,
    hysteresis: 24,
    prev: foldState.value,
  });
  const cur = foldState.value;
  if (
    next.aliasGlyph !== cur.aliasGlyph ||
    next.pillDot !== cur.pillDot ||
    next.folded.length !== cur.folded.length ||
    next.folded.some((id, i) => id !== cur.folded[i])
  ) {
    foldState.value = next;
  }
}

// No off-branch Vue comment/anchor: keep the old titlebar bytes when the cap is absent.
let terminalButtonMount: HTMLDivElement | undefined;
function updateTerminalButton() {
  const bar = titlebarEl.value;
  if (!bar || !terminalEntry?.available.value || isFolded("terminal")) {
    if (terminalButtonMount) render(null, terminalButtonMount);
    return;
  }
  terminalButtonMount ??= document.createElement("div");
  const vnode = h(
    "button",
    {
      class: "btn btn-ghost detail-resume-btn",
      style: { minWidth: "44px", minHeight: "44px" },
      type: "button",
      "data-fold": "terminal",
      "aria-controls": "terminal-panel",
      "aria-expanded": terminalEntry.open.value,
      "aria-label": t("terminal.title"),
      onClick: () => terminalEntry.show(),
    },
    [
      h(AppIcon, { name: "terminal", class: "icon" }),
      h("span", { class: "head-btn-label", "aria-hidden": "true" }, t("terminal.title")),
    ],
  );
  render(vnode, terminalButtonMount);
  const button = (terminalButtonMount.firstChild ?? vnode.el) as Node | null;
  if (button && button.parentNode !== bar) {
    const privacyButtonEl = bar.querySelector('[data-fold="privacy"]');
    bar.insertBefore(
      button,
      privacyButtonEl?.nextSibling ?? bar.querySelector('[data-fold="stop"], [data-fold="delete"], .detail-head-more'),
    );
  }
}
watch(
  () => [terminalEntry?.available.value, terminalEntry?.open.value, isFolded("terminal"), t("terminal.title")],
  () => {
    updateTerminalButton();
    void nextTick(measureTitlebar);
  },
  { flush: "post" },
);
onMounted(updateTerminalButton);
onBeforeUnmount(() => {
  if (terminalButtonMount) render(null, terminalButtonMount);
});
let titlebarRO: ResizeObserver | null = null;
onMounted(() => {
  measureTitlebar();
  if (typeof ResizeObserver !== "undefined") {
    titlebarRO = new ResizeObserver(() => measureTitlebar());
    if (titlebarEl.value !== null) titlebarRO.observe(titlebarEl.value);
  }
});
onBeforeUnmount(() => {
  titlebarRO?.disconnect();
  titlebarRO = null;
});
// A cap gate flipping adds/removes a button without necessarily resizing the bar — re-measure.
watch(
  () => presentFoldIds().join(","),
  () => void nextTick(measureTitlebar),
);

/** Menu entries in the BAR's left-to-right order (not fold order) — a stable, predictable list. */
const overflowItems = computed<HeaderOverflowItem[]>(() => {
  const out: HeaderOverflowItem[] = [];
  // Glyph-degraded alias chip shows a bare 「@」 — keep the full alias readable as the menu's
  // first (read-only) entry.
  if (foldState.value.aliasGlyph && headerAlias.value !== undefined)
    out.push({ id: "alias-note", note: true, label: `@${headerAlias.value}` });
  if (clearUsable.value && isFolded("clear")) {
    const busy = clearing.value;
    out.push({
      id: "clear",
      icon: busy ? "loader" : "sparkle",
      label: busy ? t("detail.clearBusyLabel") : t("detail.clearLabel"),
      busy,
      separatorBefore: out.length > 0,
    });
  }
  if (channelsUsable.value && isFolded("channels")) {
    const alias = headerAlias.value;
    out.push({
      id: "channels",
      icon: "radio",
      label: alias === undefined ? t("agents.channelsOpenLabel") : `${t("agents.channelsOpenLabel")} @${alias}`,
      haspopupDialog: true,
    });
  }
  if (schedUsable.value && isFolded("schedule"))
    out.push({ id: "schedule", icon: "clock", label: t("detail.scheduleOpenLabel"), haspopupDialog: true });
  if (resumeUsable.value && isFolded("resume"))
    out.push({ id: "resume", icon: "clock", label: t("resume.openLabel"), haspopupDialog: true });
  if (privacyButton.value && isFolded("privacy"))
    out.push({
      id: "privacy",
      icon: privacyMarked.value ? "unlock" : "lock",
      label: privacyMarked.value ? t("privacy.unlockLabel") : t("privacy.markLabel"),
      checked: privacyMarked.value,
    });
  if (terminalEntry?.available.value && isFolded("terminal"))
    out.push({ id: "terminal", icon: "terminal", label: t("terminal.title") });
  if (managed.value !== undefined && !stopArmed.value && !stopStopping.value && isFolded("stop"))
    out.push({
      id: "stop",
      icon: "stop",
      label: t("spawn.stopSessionLabel"),
      danger: true,
      separatorBefore: out.length > 0,
    });
  // 「删除会话」 (2026-11-02): in the menu only while FOLDED (narrow bar / touch) — a wide bar
  // shows the inline icon button instead and mounts no ⋯ at all when nothing else folded.
  if (removeTarget.value !== null && !delArmed.value && isFolded("delete")) {
    const busy = delRemoving.value;
    out.push({
      id: "delete",
      icon: busy ? "loader" : "x",
      label: busy ? t("agents.removing") : t("detail.deleteSessionLabel"),
      danger: true,
      busy,
      separatorBefore: out.length > 0,
    });
  }
  return out;
});

function onOverflowRun(id: string): void {
  switch (id) {
    case "clear":
      void onClear();
      break;
    case "channels":
      channelsOpen.value = true;
      break;
    case "schedule":
      schedOpen.value = true;
      break;
    case "resume":
      resumeHost?.open({ scope: "recent" });
      break;
    case "terminal":
      terminalEntry?.show();
      break;
    case "privacy":
      onPrivacyClick();
      break;
    case "delete":
      armDelete();
      break;
    case "stop":
      // Menu already closed; arm the two-step confirm — the ✓/✕ pill surfaces IN THE BAR
      // (the armed/busy pills never fold) exactly as if the idle button had been clicked.
      armStop();
      break;
  }
}
</script>

<template>
  <header class="detail-head">
    <div class="detail-titlebar" ref="titlebarEl">
      <button
        v-if="drawer && drawer.active.value"
        class="btn btn-ghost detail-drawer-toggle"
        type="button"
        :aria-label="t('agents.openDrawer')"
        @click="drawer.open()"
      >
        <AppIcon name="layers" class="icon-lg" />
      </button>
      <button
        v-if="showBack"
        class="btn btn-ghost detail-back"
        type="button"
        :aria-label="t('common.backToAgents')"
        @click="emit('back')"
      >
        <AppIcon name="chev-left" class="icon-lg" />
      </button>
      <!-- 2026-10 「红框部分支持收起」: the title is the disclosure toggle for the info block
           below (button inside the h2 keeps `id="detail-title"` — the detail region's
           aria-labelledby target — while gaining native keyboard/AT toggle semantics).
           2026-10 「标题那个箭头去掉」: text-only toggle — no chevron glyph, the hover
           background + aria state carry the affordance. -->
      <h2 class="detail-title" id="detail-title">
        <button
          class="detail-title-toggle"
          type="button"
          :aria-expanded="headCollapsed ? 'false' : 'true'"
          aria-controls="detail-head-info"
          :aria-label="t('detail.headToggleAria')"
          @click="onToggleHeadInfo"
        >
          <span class="detail-title-text">{{ title }}</span>
        </button>
      </h2>
      <!-- alias-plan r4 §7.2 (ALU): `@alias` next to the title opens the channels & alias
           dialog (a plain non-interactive chip when the dialog's control gate is not met). -->
      <button
        v-if="headerAlias !== undefined && channelsUsable"
        class="chip detail-alias-btn"
        :class="{ 'is-glyph': foldState.aliasGlyph }"
        type="button"
        translate="no"
        data-alias
        :title="t('agents.xsAliasManage', { alias: headerAlias })"
        :aria-label="t('agents.xsAliasManage', { alias: headerAlias })"
        @click="onAliasOpen"
      >
        @{{ foldState.aliasGlyph ? "" : headerAlias }}
      </button>
      <span
        v-else-if="headerAlias !== undefined"
        class="chip chip-xs-alias"
        :class="{ 'is-glyph': foldState.aliasGlyph }"
        translate="no"
        data-alias
        :title="`@${headerAlias}`"
        :aria-label="`@${headerAlias}`"
        >@{{ foldState.aliasGlyph ? "" : headerAlias }}</span
      >
      <StatusPill :state="visual" :label="statusLabel" :dot-only="foldState.pillDot" data-pill />
      <!-- Web /clear quick button (2026-10): new session in the same pi process via builtin
           /new with confirm baked in — no confirmation dialog anywhere in this flow. Rendered
           only on the composer's slash-command surface (control ∧ live ∧ command.v1 slot);
           never busy-gated (see the script block above). -->
      <button
        v-if="clearUsable && !isFolded('clear')"
        class="detail-clear-btn"
        type="button"
        data-fold="clear"
        :disabled="clearing"
        :title="t('detail.clearTitle')"
        :aria-label="t('detail.clearAria')"
        @click="void onClear()"
      >
        <AppIcon :name="clearing ? 'loader' : 'sparkle'" class="icon" :class="{ spin: clearing }" />
        <span class="head-btn-label" aria-hidden="true">{{ t("detail.clearLabel") }}</span>
      </button>
      <!-- web-resume §2.6 D7 (P3): 「恢复」 opens the resume picker — clear-button gating +
           resume.v1; never busy-gated (D4: busy ⇒ list browsable, rows not switchable). -->
      <button
        v-if="channelsUsable && !isFolded('channels')"
        class="detail-channels-btn"
        type="button"
        data-fold="channels"
        :title="t('agents.channelsOpenTitle')"
        :aria-label="t('agents.channelsOpenTitle')"
        aria-haspopup="dialog"
        @click="channelsOpen = true"
      >
        <AppIcon name="radio" class="icon" />
        <span class="head-btn-label" aria-hidden="true">{{ t("agents.channelsOpenLabel") }}</span>
      </button>
      <ChannelsDialog v-if="channelsOpen" @close="channelsOpen = false" />
      <!-- scheduled-reports W1 (§5.6): 「定时」 → lazy SchedulePanel (sched.v1 + sessionId;
           read-only-safe offline, so NOT gated on the control surface). -->
      <button
        v-if="schedUsable && !isFolded('schedule')"
        class="detail-sched-btn"
        type="button"
        data-fold="schedule"
        :title="t('detail.scheduleOpenTitle')"
        :aria-label="t('detail.scheduleOpenTitle')"
        aria-haspopup="dialog"
        @click="schedOpen = true"
      >
        <AppIcon name="clock" class="icon" />
        <span class="head-btn-label" aria-hidden="true">{{ t("detail.scheduleOpenLabel") }}</span>
      </button>
      <SchedulePanel
        v-if="schedOpen && schedSessionId !== undefined"
        :session-id="schedSessionId"
        @close="schedOpen = false"
      />
      <button
        v-if="resumeUsable && !isFolded('resume')"
        class="detail-resume-btn"
        type="button"
        data-fold="resume"
        :title="t('resume.openTitle')"
        :aria-label="t('resume.openTitle')"
        @click="resumeHost?.open({ scope: 'recent' })"
      >
        <AppIcon name="clock" class="icon" />
        <span class="head-btn-label" aria-hidden="true">{{ t("resume.openLabel") }}</span>
      </button>
      <!-- web-hub-privacy P2, 2026-11-03: the mark-STATE toggle — 「锁定」 (unmarked →
           persistent mark) vs 「解锁」 (marked + viewing → 取消标记 flow, the card affordance's
           twin); icons follow the ACTION (lock/unlock — the AgentCard pair). -->
      <button
        v-if="privacyButton && !isFolded('privacy')"
        class="btn btn-ghost privacy-head-btn"
        data-fold="privacy"
        :class="{ 'is-marked': privacyMarked }"
        type="button"
        :title="privacyMarked ? t('privacy.unmarkTitle') : t('privacy.mark')"
        :aria-label="privacyMarked ? t('privacy.unlockAria') : t('privacy.markAria')"
        @click="onPrivacyClick"
      >
        <AppIcon :name="privacyMarked ? 'unlock' : 'lock'" class="icon" />
        <span class="head-btn-label" aria-hidden="true">{{
          privacyMarked ? t("privacy.unlockLabel") : t("privacy.markLabel")
        }}</span>
      </button>
      <!-- web-hub-spawn SP12 (arch §9.1) — 2026-10 variant-A redesign (user-picked mockup
           pwh-stopbtn/v-a): idle = 32px icon-only ghost button (title + aria-label, danger tint
           on hover/focus-visible); first click expands IN PLACE into the red confirm pill
           (✓ or a second click on the pill confirms, ✕ / Esc / the STOP_ARM_MS timer cancels,
           focus moves to ✓ on arm); stopping = spinner + label, no interactive control. -->
      <template v-if="managed">
        <button
          v-if="!stopArmed && !stopStopping && !isFolded('stop')"
          ref="stopIdleBtn"
          class="spawn-stop-btn"
          type="button"
          data-fold="stop"
          :title="t('spawn.stopSession')"
          :aria-label="t('spawn.stopSessionAria')"
          @click="onStopSession"
          @keydown="onStopKeydown"
        >
          <AppIcon name="stop" class="icon" />
          <span class="head-btn-label" aria-hidden="true">{{ t("spawn.stopSessionLabel") }}</span>
        </button>
        <span
          v-else-if="stopStopping"
          class="spawn-stop-busy"
          role="status"
          :aria-label="t('spawn.stopSessionStopping')"
        >
          <AppIcon name="loader" class="icon-sm spin" />
          {{ t("spawn.stopSessionStopping") }}
        </span>
        <span
          v-else-if="stopArmed"
          ref="stopPill"
          class="spawn-stop-armed"
          role="group"
          :aria-label="t('spawn.stopSessionGroupAria')"
          @keydown="onStopKeydown"
        >
          <button class="spawn-stop-armed-confirm" type="button" @click="onStopSession">
            {{ t("spawn.stopSessionConfirm") }}
          </button>
          <span class="spawn-stop-armed-sep" aria-hidden="true"></span>
          <button
            ref="stopOkBtn"
            class="spawn-stop-armed-ok"
            type="button"
            :aria-label="t('spawn.stopSessionConfirmAria')"
            @click="onStopSession"
          >
            <AppIcon name="check" class="icon-sm" />
          </button>
          <button
            class="spawn-stop-armed-no"
            type="button"
            :aria-label="t('spawn.stopSessionCancelAria')"
            @click="cancelStop"
          >
            <AppIcon name="x" class="icon-sm" />
          </button>
        </span>
      </template>
      <!-- 「删除会话」 (2026-11-02): the idle entry is a normal in-bar icon button on wide bars
           (same spawn-stop-btn grammar — 危险 hover tint, ✓/✕ arm pill identical from either
           entrance); it folds FIRST into 「⋯」 on narrow bars and is menu-only on touch. The
           armed ✓/✕ pill (reuses the stop pill's look) + in-flight status live IN THE BAR and
           never fold. -->
      <button
        v-if="removeTarget !== null && !delArmed && !delRemoving && !isFolded('delete')"
        ref="delIdleBtn"
        class="spawn-stop-btn detail-del-btn"
        type="button"
        data-fold="delete"
        :title="t('detail.deleteSessionLabel')"
        :aria-label="t('detail.deleteSessionLabel')"
        @click="armDelete"
        @keydown="onDeleteKeydown"
      >
        <AppIcon name="x" class="icon" />
        <span class="head-btn-label" aria-hidden="true">{{ t("detail.deleteSessionLabel") }}</span>
      </button>
      <span
        v-if="delArmed"
        ref="delPill"
        class="spawn-stop-armed detail-del-pill"
        role="group"
        :aria-label="t('detail.deleteSessionGroupAria')"
        @keydown="onDeleteKeydown"
      >
        <button class="spawn-stop-armed-confirm" type="button" @click="onDeleteSession">
          {{ t("agents.removeConfirm") }}
        </button>
        <span class="spawn-stop-armed-sep" aria-hidden="true"></span>
        <button
          ref="delOkBtn"
          class="spawn-stop-armed-ok"
          type="button"
          :aria-label="t('detail.deleteSessionConfirmAria')"
          @click="onDeleteSession"
        >
          <AppIcon name="check" class="icon-sm" />
        </button>
        <button
          class="spawn-stop-armed-no"
          type="button"
          :aria-label="t('spawn.stopSessionCancelAria')"
          @click="cancelDelete"
        >
          <AppIcon name="x" class="icon-sm" />
        </button>
      </span>
      <span v-else-if="delRemoving" class="spawn-stop-busy detail-del-busy" role="status">
        <AppIcon name="loader" class="icon-sm spin" />
        {{ t("agents.removing") }}
      </span>
      <!-- issue #41: the 「⋯」 overflow menu receives the measured-out low-frequency buttons
           (logic/headerFold.ts); mounted only while ≥1 action is folded, so a wide bar's DOM
           stays byte-identical to the pre-feature markup. Sits BEFORE the trailing state chips
           (review pass: the unread chip stays the bar's LAST element). -->
      <HeaderOverflowMenu v-if="overflowItems.length > 0" :items="overflowItems" @run="onOverflowRun" />
      <span v-if="restoring" class="chip chip-restoring" translate="no" :title="t('spawn.badgeRestoringTitle')">{{
        t("spawn.badgeRestoring")
      }}</span>
      <span
        v-if="xsUnread !== undefined"
        class="chip chip-xs-unread"
        role="img"
        translate="no"
        :title="t('agents.xsUnread', { n: xsUnread })"
        :aria-label="t('agents.xsUnread', { n: xsUnread })"
        ><AppIcon name="inbox" class="icon" /><span class="num">{{ xsUnreadLabel(xsUnread) }}</span></span
      >
    </div>

    <p v-if="privacyError" class="privacy-head-error" role="alert">
      {{ t(privacyError.key, { code: privacyError.code }) }}
    </p>
    <p v-if="delError" class="spawn-stop-note detail-del-note" role="alert">
      {{ t("agents.removeFailed", { reason: t(`agents.removeErr.${delError}`) }) }}
    </p>
    <p v-if="stopError" class="spawn-stop-note" role="alert">
      {{ t("spawn.stopSessionFailed", { code: stopError }) }}
    </p>
    <p v-if="clearError" class="spawn-stop-note" role="alert">
      {{ t("detail.clearFailed", { code: clearError }) }}
    </p>
    <p v-if="fpNoticeVisible && fpNotice" class="spawn-fp-note" role="status">
      {{ t("spawn.fpRefilled", { state: fpNotice.state }) }}
      <button class="btn btn-ghost btn-xs" type="button" @click="fpDismissedId = fpNotice.id">
        {{ t("spawn.fpRefilledDismiss") }}
      </button>
    </p>

    <!-- 2026-10 「红框部分支持收起」: the collapsible block. `v-if` (not `hidden`) so the inner
         panels' own `<details>` expanded state cannot leak through a collapsed header — the
         rows are simply not rendered. -->
    <div v-if="!headCollapsed" id="detail-head-info" class="detail-head-info">
      <SessionInfo
        :session="session"
        :card="card"
        :cost-usd="status?.costUsd"
        :subagent-cost-usd="status?.subagentCostUsd"
      />

      <!-- todo-web T4 + schedule-auto-approve r2 W2: the aggregated tasks panel — the todo
           section (status-reducer mirror on `agent.todo`) plus the sched section when
           `schedSummaryOf` finds this session's schedule projection. Renders when EITHER
           side has content; each section additionally hides itself when its own input is
           empty. -->
      <TasksPanel
        v-if="(agent.todo?.tasks.length ?? 0) > 0 || schedSummary !== undefined"
        :todo="agent.todo"
        :sched-summary="schedSummary"
        :sched-proj="schedProj"
        :can-write="schedCanWrite"
        @open-run="onSchedOpenRun"
        @open-schedule="schedOpen = true"
      />

      <!-- worktree-web W4: git worktrees of the session cwd's repo, straight from
           `status.worktrees`; renders nothing when the wire is absent or has zero rows.
           worktree-diff D5 (§4.1): `agentKey`/`session` are the wtdiff scope inputs — absent
           (old mounts) or a missing hub cap keeps the panel byte-identical (I8). -->
      <WorktreePanel v-if="worktrees" :worktrees="worktrees" :agent-key="agent.key" :session="session" />
      <GraphPanel v-if="worktrees" :worktrees="worktrees" :agent-key="agent.key" :session="session" />

      <!-- cache-keepalive-web P-B (§4): the main session's prompt-cache keepalive, straight
           from `status.cacheKeepalive`; renders nothing when the wire is absent (read-only). -->
      <CacheKeepalivePanel v-if="cacheKeepalive" :keepalive="cacheKeepalive" />
    </div>
  </header>
</template>
