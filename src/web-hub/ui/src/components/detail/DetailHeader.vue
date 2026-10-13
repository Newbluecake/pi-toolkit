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
  (SessionInfo / TodoPanel / WorktreePanel / BashJobsPanel) collapses behind the title itself —
  the title text is wrapped in a disclosure <button> (h2 keeps `id="detail-title"`), the state
  is the browser-local `pwh_detail_head_collapsed` pref (global, fail-open to EXPANDED; see
  `composables/useDetailHeadCollapse.ts`), and the transient `<p>` notices stay outside the
  block. 2026-10 (user request 「标题那个箭头我感觉可以去掉」): the leading chevron glyph is
  removed — the toggle is text-only (hover background + aria-expanded/aria-controls carry the
  disclosure affordance). Styles: `.detail-title-toggle` / `.detail-title-text` /
  `.detail-head-info` in detail.css.
-->
<script setup lang="ts">
import { tracePoint } from "../../logic/trace.js";
tracePoint("dh:setup");
import { computed, inject, nextTick, onUnmounted, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { agentVisualState } from "../../composables/visual-state.js";
import { useI18n } from "../../composables/useI18n.js";
import { useDetailHeadCollapse } from "../../composables/useDetailHeadCollapse.js";
import { browserLocalStorage } from "../shell/themeStorage.js";
import { managedFor, restoringKeys } from "../../logic/spawn.js";
import type { DetailHeaderEmits, DetailHeaderProps } from "../../contracts.js";
import { HUB_CTX } from "../control/controlContext.js";
import { PRIVACY_LOCK_CTX } from "../privacy/privacyContext.js";
import { SIDEBAR_DRAWER } from "../shell/sidebarDrawer.js";
import "../../styles/spawn.css";
import { cardOf, sessionOf, statusOf } from "./agentViews.js";
import SessionInfo from "./SessionInfo.vue";
import StatusPill from "./StatusPill.vue";
import TodoPanel from "./TodoPanel.vue";
import WorktreePanel from "./WorktreePanel.vue";
import GraphPanel from "./GraphPanel.vue";
import BashJobsPanel from "./BashJobsPanel.vue";
import { bashJobsOf } from "./bashJobsView.js";
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

// bash-jobs-panel 包 B (D4): the session's own background bash jobs ride `StatusInfo.bashJobs`
// (same no-state.js-mirror posture as worktrees); undefined ⇒ the panel renders nothing.
const bashJobs = computed(() => bashJobsOf(props.agent));

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
// web-hub-privacy plan v2.1 (P2): the header lock button — the keyboard/备用 entrance next to
// the card's hover affordance (v2.1 N1). 命名分离 (a pinned distinction): an UNMARKED session
// gets 「隐私标记」 (persistent, calls `privacy.lock({locked:true})` — no password); a MARKED
// session being viewed (necessarily view-unlocked — otherwise the lock screen owns the pane
// and this header isn't mounted) gets 「立即锁定」 (pure client-side view relock, no request).
// Desktop band + `privacy.v1` cap only; no provider / no cap / phone band ⇒ no button at all.
// ---------------------------------------------------------------------------
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
  if (privacyMarked.value) privacy.relock("manual");
  else void privacy.mark(props.agent.key);
}

// ---------------------------------------------------------------------------
// web-hub-spawn SP12 (arch §9.1) — additive, inject-only (the frozen DetailHeaderProps stay
// untouched): a spawn record managing THIS agent adds 「停止会话」 (two-step arm, same grammar
// as StopButton) wired to `useSpawn.stop`, and a terminal failed/expired first prompt whose
// body `useNewSession` already put back into the draft surfaces as a one-time dismissible note.
// ---------------------------------------------------------------------------
const hub = inject(HUB_CTX, null);
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

onUnmounted(disarmStop);

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
// titlebar — SessionInfo / TodoPanel / WorktreePanel / BashJobsPanel — collapses behind the
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
</script>

<template>
  <header class="detail-head">
    <div class="detail-titlebar">
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
      <StatusPill :state="visual" :label="statusLabel" />
      <!-- web-hub-privacy P2: 隐私标记 (unmarked → persistent mark) vs 立即锁定 (marked +
           viewing → view relock) — the two names never mix (plan v2.1 N1 命名分离). -->
      <button
        v-if="privacyButton"
        class="btn btn-ghost privacy-head-btn"
        type="button"
        :title="privacyMarked ? t('privacy.lockNow') : t('privacy.mark')"
        :aria-label="privacyMarked ? t('privacy.lockNowAria') : t('privacy.markAria')"
        @click="onPrivacyClick"
      >
        <AppIcon name="lock" class="icon" />
      </button>
      <span v-if="restoring" class="chip chip-restoring" translate="no" :title="t('spawn.badgeRestoringTitle')">{{
        t("spawn.badgeRestoring")
      }}</span>
      <!-- web-hub-spawn SP12 (arch §9.1) — 2026-10 variant-A redesign (user-picked mockup
           pwh-stopbtn/v-a): idle = 32px icon-only ghost button (title + aria-label, danger tint
           on hover/focus-visible); first click expands IN PLACE into the red confirm pill
           (✓ or a second click on the pill confirms, ✕ / Esc / the STOP_ARM_MS timer cancels,
           focus moves to ✓ on arm); stopping = spinner + label, no interactive control. -->
      <template v-if="managed">
        <button
          v-if="!stopArmed && !stopStopping"
          ref="stopIdleBtn"
          class="spawn-stop-btn"
          type="button"
          :title="t('spawn.stopSession')"
          :aria-label="t('spawn.stopSessionAria')"
          @click="onStopSession"
          @keydown="onStopKeydown"
        >
          <AppIcon name="stop" class="icon" />
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
          v-else
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
    </div>

    <p v-if="privacyError" class="privacy-head-error" role="alert">
      {{ t(privacyError.key, { code: privacyError.code }) }}
    </p>
    <p v-if="stopError" class="spawn-stop-note" role="alert">
      {{ t("spawn.stopSessionFailed", { code: stopError }) }}
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

      <!-- todo-web T4: the main session's task list, mirrored onto `agent.todo` by the status
           reducer; the panel renders nothing when the wire is absent or empty. -->
      <TodoPanel v-if="agent.todo" :todo="agent.todo" />

      <!-- worktree-web W4: git worktrees of the session cwd's repo, straight from
           `status.worktrees`; renders nothing when the wire is absent or has zero rows.
           worktree-diff D5 (§4.1): `agentKey`/`session` are the wtdiff scope inputs — absent
           (old mounts) or a missing hub cap keeps the panel byte-identical (I8). -->
      <WorktreePanel v-if="worktrees" :worktrees="worktrees" :agent-key="agent.key" :session="session" />
      <GraphPanel v-if="worktrees" :worktrees="worktrees" :agent-key="agent.key" :session="session" />

      <!-- bash-jobs-panel 包 B (D4): the session's own background bash jobs, straight from
           `status.bashJobs`; renders nothing when the wire is absent or has zero rows. -->
      <BashJobsPanel v-if="bashJobs" :jobs="bashJobs" />
    </div>
  </header>
</template>
