<!--
  Detail pane orchestration: header, agent-level notices, ask_user answer forms, history
  waiting/error/loaded branching, dock (ui-design.md §5, §9, vue-plan.md v2.1 §3.2, §5.2 — P3;
  control-plane wiring per control-plan.md v2.1 §7.1/§7.4/§7.7 — C5).

  Control-plane additions (C5):
  - Injects `HUB_CTX` (App.vue-provided HubHandle) and provides the frozen `CONTROL_CTX`
    ({agentKey, control, enabled} — for `FleetActions`, plan §7.4's explicit provide/inject
    seam) plus C5's richer `CONTROL_VIEW` (reactive agent/busy/commands/queue/web-badge) for
    `DetailDock`/`Composer`/`AskUserForm`. The frozen `AgentDetailProps` has no hub field, and
    the frozen `DetailDockEmits` has no send/stop/retry/discard — inject is the only channel
    that touches neither frozen surface.
  - ask_user: every `agent.dialogs.open` entry renders an `AskUserForm` (keyed
    `dialogId:epoch` — an epoch flip remounts with a fresh, empty draft plus a one-line
    epochChanged hint, §3.5); a dialog that leaves `open` folds into a one-line note resolved
    from `dialogs.closed[].by/outcome` (§7.4's 409 folding). `suspended` tracks the hub's
    `restarting` state (§6.7.3 网页语义).
  - `DetailDock` receives `control`/`queue`/`busy`/`readonlyReason` (all optional additions to
    the frozen `DetailDockProps`).
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, provide, ref, watch } from "vue";
import { mergeQueue, newCmdId } from "@logic/control.js";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_CTX } from "../../composables/useControl.js";
import type { AgentDetailEmits, AgentDetailProps } from "../../contracts.js";
import type { CmdOutcome, Notice } from "../../types.js";
import type { DialogClosedWire, DialogWire } from "@protocol/messages.js";
import { CONTROL_VIEW, HUB_CTX, type ControlView } from "../control/controlContext.js";
import AskUserForm from "../dialog/AskUserForm.vue";
import { buildAgentNotices } from "./agentNotices.js";
import DetailBody from "../body/DetailBody.vue";
import DetailDock from "./DetailDock.vue";
import DetailHeader from "./DetailHeader.vue";
import NoticeBanner from "../shell/NoticeBanner.vue";

const RETRY_NOTICE_ID = "history-error";

const props = defineProps<AgentDetailProps>();
const emit = defineEmits<AgentDetailEmits>();
const { t } = useI18n();

const agentNotices = computed(() => buildAgentNotices(props.agent, t));
const historyErrorNotice = computed<Notice | null>(() => {
  if (props.agent.history !== "error") return null;
  return {
    id: RETRY_NOTICE_ID,
    tone: "danger",
    title: props.agent.historyError ?? t("notices.retryNow"),
    action: { label: t("notices.retryNow") },
    persistent: false,
  };
});
const notices = computed<readonly Notice[]>(() =>
  historyErrorNotice.value ? [...agentNotices.value, historyErrorNotice.value] : agentNotices.value,
);

function onNoticeAction(id: string): void {
  if (id === RETRY_NOTICE_ID) emit("retry");
}

// ---------------------------------------------------------------------------
// control plane (C5)
// ---------------------------------------------------------------------------

const hub = inject(HUB_CTX, null);
const control = computed(() => hub?.control ?? null);

const hubControl = computed(() => hub?.state.value.control === true);
const cardControl = computed(() => (props.agent.card as { control?: unknown }).control === true);
const cardState = computed(() => (props.agent.card as { state?: unknown }).state);
const agentLive = computed(() => !props.agent.down && cardState.value !== "stale");
const controlEnabled = computed(
  () => control.value !== null && hubControl.value && cardControl.value && agentLive.value,
);

/** §7.4 DetailDock read-only reasons, in the plan table's order: hub caps → agent caps → liveness. */
const readonlyReason = computed<string | null>(() => {
  if (controlEnabled.value) return null;
  if (!hubControl.value || control.value === null) return "control.dockReadonlyHub";
  if (!cardControl.value) return "control.dockReadonlyAgent";
  return "control.dockReadonlyOffline";
});

const busy = computed(() => (props.agent.status as { busy?: unknown } | undefined)?.busy === true);
const commands = computed<readonly Record<string, unknown>[]>(() =>
  Array.isArray(props.agent.commands) ? (props.agent.commands as readonly Record<string, unknown>[]) : [],
);
// §7.7: command mode requires the agent's `command.v1` — surfaced by the presence of the
// commands SLOT (old agents never send one), not just cmd.v1.
const commandsEnabled = computed(() => controlEnabled.value && Array.isArray(props.agent.commands));
const pendingCtl = computed<readonly Record<string, unknown>[]>(() =>
  Array.isArray(props.agent.pendingCtl) ? (props.agent.pendingCtl as readonly Record<string, unknown>[]) : [],
);
const sending = computed(() => pendingCtl.value.some((it) => it.state === "sending"));
const queueItems = computed<readonly unknown[]>(() =>
  mergeQueue(Array.isArray(props.agent.queue) ? [...props.agent.queue] : [], [...pendingCtl.value]),
);

/** §7.7 transcript web badge: a user message counts as web-sent when a ctl ledger entry in a
 * post-dispatch state (`started`/`consumed`) sits within [at, at+120s] of its timestamp. */
const WEB_BADGE_WINDOW_MS = 120_000;
function isWebMessage(timestamp: number | undefined): boolean {
  if (timestamp === undefined || !Array.isArray(props.agent.ctl)) return false;
  for (const raw of props.agent.ctl) {
    const e = raw as { state?: unknown; at?: unknown };
    if (e.state !== "started" && e.state !== "consumed") continue;
    if (typeof e.at !== "number") continue;
    if (timestamp >= e.at && timestamp - e.at <= WEB_BADGE_WINDOW_MS) return true;
  }
  return false;
}

const controlView: ControlView = {
  agentKey: props.agent.key,
  get control() {
    return control.value;
  },
  enabled: controlEnabled,
  readonlyReason,
  agent: computed(() => props.agent),
  busy,
  commands,
  commandsEnabled,
  sending,
  queueItems,
  isWebMessage,
};
provide(CONTROL_VIEW, controlView);
// Frozen seam for FleetActions (plan §7.4): only provided when a ControlHandle exists —
// `useHub` creates it synchronously, so a null here means a control-less hub for the whole
// mount. FleetActions treats a missing inject as "don't render" (component test pins this).
if (control.value !== null) {
  provide(CONTROL_CTX, {
    agentKey: props.agent.key,
    control: control.value,
    get enabled() {
      return controlEnabled.value;
    },
  });
}

// --- ask_user dialogs (§5.5/§7.4) -----------------------------------------------------------

const dialogsEpoch = computed(() => props.agent.dialogs?.epoch ?? "");
const openDialogs = computed<readonly DialogWire[]>(() => {
  const open = props.agent.dialogs?.open;
  return Array.isArray(open) ? (open as readonly DialogWire[]) : [];
});
const closedDialogs = computed<readonly DialogClosedWire[]>(() => {
  const closed = props.agent.dialogs?.closed;
  return Array.isArray(closed) ? (closed as readonly DialogClosedWire[]) : [];
});
const hubSuspended = computed(() => hub?.state.value.hubState === "restarting");

/** Dialog ids this mount has SEEN open — when one leaves `open`, fold it into a one-line note
 * (§7.4's post-409 collapse; also covers terminal-first answers and aborts). */
const seenOpen = new Set<string>();
const folded = ref<readonly string[]>([]);

/** Bug fix (user-reported): a folded "Answered/Cancelled here" note used to stay pinned at the
 * top of the detail pane forever (until an agent switch remounted the whole component) — after
 * a few rounds of ask_user, the top of the pane was wall-to-wall stale "Answered" lines. Each
 * note now auto-clears itself ~8s after it first appears; the existing 4-item cap (`folded.value
 * = next.slice(-4)` below) stays as a hard backstop regardless of the timer. */
const FOLD_AUTO_DISMISS_MS = 8000;
const foldTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleFoldDismiss(id: string): void {
  if (foldTimers.has(id)) return;
  const timer = setTimeout(() => {
    foldTimers.delete(id);
    folded.value = folded.value.filter((x) => x !== id);
  }, FOLD_AUTO_DISMISS_MS);
  foldTimers.set(id, timer);
}

function clearFoldTimer(id: string): void {
  const timer = foldTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    foldTimers.delete(id);
  }
}

onBeforeUnmount(() => {
  for (const timer of foldTimers.values()) clearTimeout(timer);
  foldTimers.clear();
});

/** acc32-B3 (accfix): cmdIds THIS browser tab generated when answering/cancelling a dialog,
 * keyed by dialogId — `foldedNote` below compares a `closed{by:"web"}` record's `cmdId` against
 * this to tell "answered here" apart from "answered in a DIFFERENT browser tab" (both are
 * `by:"web"`).
 *
 * accfix fix: the id is generated and recorded HERE, synchronously, before `control.answerDialog`/
 * `cancelDialog` is even called — not read back out of `props.agent.pendingCtl` afterwards. The
 * optimistic `pendingCtl` item lands in the reducer's `raw` state synchronously, but `props.agent`
 * only reflects it once `useHub`'s render gate commits the next `state.value` snapshot (a
 * throttled, deferred commit — see useHub.ts's `gate.request()`), which has NOT happened yet at
 * the point right after the call returns. Reading `pendingCtl.value` there therefore always saw
 * the PREVIOUS props snapshot ⇒ `mine` was permanently false. Generating the id ourselves and
 * passing it straight into `control.answerDialog`/`cancelDialog` (which accept it as an optional
 * override, defaulting to their own `newCmdId()` otherwise) sidesteps props timing entirely. */
const myDialogCmdIds = new Map<string, Set<string>>();
function trackOwnDialogCmdId(dialogId: string, id: string): void {
  let set = myDialogCmdIds.get(dialogId);
  if (set === undefined) {
    set = new Set();
    myDialogCmdIds.set(dialogId, set);
  }
  set.add(id);
}
watch(
  openDialogs,
  (open) => {
    for (const d of open) seenOpen.add(d.dialogId);
    const openIds = new Set(open.map((d) => d.dialogId));
    const next = [...seenOpen].filter((id) => !openIds.has(id));
    const bounded = next.length > 0 ? next.slice(-4) : next; // bounded: only the 4 most recent folds
    const prevSet = new Set(folded.value);
    for (const id of bounded) if (!prevSet.has(id)) scheduleFoldDismiss(id);
    const boundedSet = new Set(bounded);
    for (const id of folded.value) if (!boundedSet.has(id)) clearFoldTimer(id); // evicted by the cap
    folded.value = bounded;
  },
  { immediate: true },
);

/** accfix-N3: `dialogs.closed[]` is a bounded slot — once a dialogId's record scrolls out of it
 * (enough OTHER dialogs closed after it), `foldedNote` used to lose the specific attribution
 * ("Cancelled in the terminal") and silently degrade to the generic "Dialog closed" on the very
 * next render, even though the fold row for that dialogId was still visible (`folded` is capped
 * at 4, independent of `closed[]`'s own bound). Resolving and caching the note THE FIRST TIME a
 * dialogId's closed record is seen keeps the specific text for as long as this mount cares about
 * it (bounded FIFO, generous relative to `folded`'s 4-item display cap) — the generic fallback
 * is reserved for dialogIds this mount truly never got a determinable outcome for. */
const resolvedNotes = new Map<string, string>();
const RESOLVED_NOTES_CAP = 32;
function resolveClosedNote(c: DialogClosedWire): string {
  // acc32-B3: `by === "web"` alone doesn't say WHICH browser tab — compare the closed record's
  // `cmdId` (§5.4: "标记 closed{by:"web", cmdId}") against the ids THIS tab generated when it
  // submitted an answer/cancel for this exact dialog (tracked by `trackOwnDialogCmdId` right
  // after `onDialogAnswer`/`onDialogCancel` dispatch — the optimistic `pendingCtl` item, and
  // therefore its generated id, is visible synchronously before the wire round-trip settles).
  const mine = c.cmdId !== undefined && myDialogCmdIds.get(c.dialogId)?.has(c.cmdId) === true;
  if (c.outcome === "cancelled") {
    if (mine) return t("dialog.cancelledHere");
    return c.by === "web" ? t("dialog.cancelledWeb") : t("dialog.cancelledTui");
  }
  switch (c.by) {
    case "tui":
      return t("dialog.closedTui");
    case "web":
      return mine ? t("dialog.closedHere") : t("dialog.closedWeb");
    case "abort":
      return t("dialog.closedAbort");
    case "background":
      // ask-user-async §7.2 (P3): a background completion interrupted the ask — the question
      // is parked and the model will re-ask; there is nothing left for this tab to answer.
      return t("dialog.closedBackground");
    case "session":
      return t("dialog.closedSession");
    default:
      return t("dialog.closedError");
  }
}
watch(
  closedDialogs,
  (list) => {
    for (const c of list) {
      if (resolvedNotes.has(c.dialogId)) continue; // resolve ONCE, before closed[] can evict it
      resolvedNotes.set(c.dialogId, resolveClosedNote(c));
      while (resolvedNotes.size > RESOLVED_NOTES_CAP) {
        const oldest = resolvedNotes.keys().next().value;
        if (oldest === undefined) break;
        resolvedNotes.delete(oldest);
      }
    }
  },
  { immediate: true },
);

function foldedNote(dialogId: string): string {
  const cached = resolvedNotes.get(dialogId);
  if (cached !== undefined) return cached;
  // accfix-N3: not resolved yet — either still genuinely `open`, or its `closed[]` record was
  // evicted (bounded slot) before this mount ever observed it. This generic fallback is now
  // reached ONLY in that narrow case, never as a degeneration of a note we once knew.
  return t("dialog.closedGeneric");
}

/** §3.5: an epoch flip under a still-open dialogId ⇒ one-line stale hint (the form itself is
 * remounted by the `:key`, so its draft is already fresh). */
const seenEpochs = new Map<string, string>();
const epochStaleIds = ref<readonly string[]>([]);
watch(
  [openDialogs, dialogsEpoch],
  ([open, epoch]) => {
    const stale: string[] = [];
    for (const d of open) {
      const prev = seenEpochs.get(d.dialogId);
      if (prev !== undefined && prev !== epoch) stale.push(d.dialogId);
      seenEpochs.set(d.dialogId, epoch);
    }
    epochStaleIds.value = stale;
  },
  { immediate: true },
);

function dialogOutcome(p: Promise<CmdOutcome>): void {
  // Failures surface through the pendingCtl state machine (QueueList + reducer) — nothing to
  // do here; the void keeps an unhandled rejection out of the console.
  void p.catch(() => {});
}

function onDialogAnswer(dialogId: string, answers: unknown): void {
  const c = control.value;
  if (!c) return;
  const id = newCmdId();
  trackOwnDialogCmdId(dialogId, id);
  dialogOutcome(c.answerDialog(props.agent.key, dialogId, dialogsEpoch.value, answers, id));
}

function onDialogCancel(dialogId: string): void {
  const c = control.value;
  if (!c) return;
  const id = newCmdId();
  trackOwnDialogCmdId(dialogId, id);
  dialogOutcome(c.cancelDialog(props.agent.key, dialogId, dialogsEpoch.value, id));
}

// --- follow-scroll plumbing (P3 original) ---------------------------------------------------

const following = ref(true);
const newCount = ref(0);

// AgentDetail is remounted per agent by DashboardView's `:key="agent.key"`; reset defensively
// too, in case a future caller ever reuses one instance across agents.
watch(
  () => props.agent.key,
  () => {
    following.value = true;
    newCount.value = 0;
  },
);

function onUpdateFollowing(value: boolean): void {
  following.value = value;
  if (value) newCount.value = 0;
}

function onNewCount(n: number): void {
  newCount.value = n;
}

function onJump(): void {
  onUpdateFollowing(true);
}

/** `exactOptionalPropertyTypes` + frozen `DetailDockProps`: optional control props are bound
 * through this object so an absent value means an ABSENT key, never an explicit `undefined`. */
const dockCtlProps = computed(() => ({
  ...(control.value !== null ? { control: control.value } : {}),
  queue: queueItems.value,
  busy: busy.value,
  ...(readonlyReason.value !== null ? { readonlyReason: readonlyReason.value } : {}),
}));
</script>

<template>
  <main class="detail" aria-labelledby="detail-title">
    <DetailHeader :agent="agent" :narrow="narrow" @back="emit('back')" />

    <NoticeBanner v-for="notice in notices" :key="notice.id" :notice="notice" @action="onNoticeAction" />

    <div v-if="agent.history === 'waiting'" class="detail-body" aria-busy="true">
      <div class="skel-stack">
        <span class="skel skel-bubble"></span>
        <span class="skel skel-w90"></span><span class="skel skel-w80"></span><span class="skel skel-w60"></span>
      </div>
      <p class="sr-only" role="status">{{ t("detail.loadingHistory") }}</p>
    </div>

    <DetailBody
      v-else
      class="detail-body"
      :agent="agent"
      :now="now"
      :following="following"
      :narrow="narrow"
      @load-older="emit('load-older')"
      @update:following="onUpdateFollowing"
      @new-count="onNewCount"
    />

    <!-- ask_user dialogs anchor just above the dock/Composer (user-requested 2026-10-05:
         was pinned to the top banner slot, which forced mobile users to scroll up to answer) -->
    <template v-if="controlEnabled">
      <section v-for="d in openDialogs" :key="`${d.dialogId}:${dialogsEpoch}`" class="ask-user-slot">
        <p v-if="epochStaleIds.includes(d.dialogId)" class="ask-epoch-note" role="status">
          {{ t("dialog.epochChanged") }}
        </p>
        <AskUserForm
          :dialog="d"
          :suspended="hubSuspended"
          @answer="onDialogAnswer(d.dialogId, $event)"
          @cancel="onDialogCancel(d.dialogId)"
        />
      </section>
    </template>
    <p v-for="id in folded" :key="`folded-${id}`" class="ask-folded" role="status">{{ foldedNote(id) }}</p>

    <DetailDock
      :following="following"
      :new-count="newCount"
      v-bind="dockCtlProps"
      @update:following="onUpdateFollowing"
      @jump="onJump"
    />
  </main>
</template>
