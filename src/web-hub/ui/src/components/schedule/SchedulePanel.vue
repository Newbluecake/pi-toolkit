<!--
  SchedulePanel (scheduled-reports W1, plan r3 §5.6, §12 W1 行) — LAZY: mounted by
  DetailHeader through `defineAsyncComponent` on first open. Shell: `PickerSheet.vue`
  (scrim click / Esc close, Tab trap, focus return, scroll lock) with the `.sched-scrim`
  desktop-centered variant (channels-sheet grammar).

  Data: the hub-global `schedules` SSE slot (`HubState.schedules`, cap `sched.v1`), narrowed
  to THIS session by `sessionId` via `@logic/schedule.js`'s `panelView`. Task rows offer
  pause/resume/delete (schedule-auto-approve r2 §6-W2: `/schedule pause|resume|rm <id>` via
  the control view's tracked-command + policy-confirm bar, hidden while offline per E3) and
  the「详情」 swap into `ScheduleTaskDetail.vue`; run rows link into the fleet drawer when the
  wire carries a `runId`. The wire's legacy `pendingApproval` / `executable` / `offer` fields
  are never read (old-hub compat, I10).

  Offline sessions (E3): read-only + a hint pointing at `/schedule … --all` in a local
  terminal. Stale (hub connection down): the last snapshot stays, a warn banner shows and
  every Feishu receipt column renders `?` (consult r1 Q3 — the hub never emits `?`).

  Privacy: the dialog lives INSIDE AgentDetail's tree (mounted by DetailHeader), so a privacy
  relock unmounts it with everything else (ResumeDialog precedent).
-->
<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useTicker } from "../../composables/useTicker.js";
import { useTrackedCommand } from "../../composables/useTrackedCommand.js";
import { registerScheduleExtra } from "../../i18n/schedule-extra.js";
import { fmtTs, panelView, relIn, runReasonKey, runStateKey } from "../../logic/schedule.js";
import { CONTROL_VIEW, HUB_CTX } from "../control/controlContext.js";
import CommandConfirm from "../control/CommandConfirm.vue";
import PickerSheet from "../control/PickerSheet.vue";
import ScheduleTaskDetail from "./ScheduleTaskDetail.vue";
import "../../styles/schedule.css";

const props = defineProps<{
  readonly sessionId: string | undefined;
}>();
const emit = defineEmits<{ close: [] }>();
registerScheduleExtra(); // before any t() this dialog renders
const { t } = useI18n();

const hub = inject(HUB_CTX, null);
const view = inject(CONTROL_VIEW, null);

// --- write path (schedule-auto-approve r2 §6-W2): pause/resume/rm through the policy confirm ---

const tracked = useTrackedCommand({
  view: () => {
    if (view === null) return null;
    return { control: view.control, agentKey: view.agentKey, pendingCtl: view.agent.value.pendingCtl };
  },
});
// Top-level bindings so the template auto-unwraps them (nested refs on the plain `tracked`
// object are NOT unwrapped by the template compiler — ChannelsDialog precedent).
const trackedConfirm = tracked.confirmReq;
/** Task id with a pause/resume/rm in flight — every action button disables while non-null
 *  (one logical command at a time on the tracked channel). */
const busyTaskId = ref<string | null>(null);
const actionNote = ref<{ kind: "err"; text: string } | null>(null);

async function onTaskAction(action: "pause" | "resume" | "rm", id: string): Promise<void> {
  if (busyTaskId.value !== null) return;
  busyTaskId.value = id;
  actionNote.value = null;
  try {
    const r = await tracked.run("schedule", `${action} ${id}`);
    if (!r.ok && !("cancelled" in r)) {
      actionNote.value = { kind: "err", text: t("schedule.actionFailed", { reason: r.message ?? r.error }) };
    }
  } finally {
    busyTaskId.value = null;
  }
}

/** Run-row fleet jump (§6-W2): the wire's runId → the drawer's run transcript
 *  (FleetDrawer's `hub.selectRun` precedent). */
function openRun(runId: string): void {
  if (view === null) return;
  hub?.selectRun?.(view.agentKey, runId);
}

/** The typed mirror of `@logic/schedule.js`'s `panelView` return (the .js module is checkJs-off;
 *  this local union is what vue-tsc narrows the template against). Field shapes follow the
 *  logic module's own JSDoc; drift is covered by schedule-logic.test.ts's toMatchObject checks. */
interface PanelTask {
  id: string;
  name: string;
  form: "background" | "message";
  when: { kind: "cron" | "once" | "invalid"; expr: string; tz: string };
  enabled: boolean;
  createdBy: string;
  feishu: boolean;
  nextAt: number | undefined;
  degraded: boolean;
  totals: { fired: number; missed: number; skipped: number; manual: number };
}
interface PanelRun {
  runKey: string;
  taskId: string;
  taskName: string;
  kind: "auto" | "manual";
  form: "background" | "message";
  state: string;
  live: boolean;
  reason: string | undefined;
  scheduledAt: number | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  reportFile: string | undefined;
  runId: string | undefined;
  feishu: string;
}
type PanelModel =
  | { kind: "none" }
  | { kind: "degraded"; reason: string; offline: boolean }
  | {
      kind: "ready";
      offline: boolean;
      stale: boolean;
      canWrite: boolean;
      rev: number;
      tasks: PanelTask[];
      runs: PanelRun[];
      missedTotal: number;
      droppedReports: number;
    };

/** Browser clock for the `next …` relative labels (30s — relIn is minute-grained; a 1s tick
 *  would re-render the whole sheet for nothing). Disposed with the dialog. */
const ticker = useTicker({
  doc: typeof document === "undefined" ? { hidden: false, addEventListener() {}, removeEventListener() {} } : document,
  win: typeof window === "undefined" ? { addEventListener() {}, removeEventListener() {} } : window,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  now: () => Date.now(),
  intervalMs: 30_000,
});
onUnmounted(() => ticker.dispose());

const caps = computed(() => hub?.state.value.hub?.["caps"]);
const conn = computed(() => hub?.state.value.conn ?? "connecting");
const offline = computed(() => view?.agent.value.down === true);
const canWrite = computed(() => view !== null && view.enabled.value && view.commandsEnabled.value && !offline.value);

const model = computed(
  (): PanelModel =>
    panelView({
      hubCaps: caps.value,
      payload: hub?.state.value.schedules,
      sessionId: props.sessionId,
      offline: offline.value,
      stale: conn.value !== "open",
      canWrite: canWrite.value,
      now: ticker.now.value,
    }) as unknown as PanelModel,
);

function whenLabel(when: { kind: "cron" | "once" | "invalid"; expr: string; tz: string }): string {
  if (when.kind === "cron") return t("schedule.whenCron", { expr: when.expr, tz: when.tz });
  if (when.kind === "once") return t("schedule.whenOnce", { expr: when.expr, tz: when.tz });
  return t("schedule.whenInvalid");
}

function nextLabel(nextAt: number | undefined, degraded: boolean): string {
  if (degraded || nextAt === undefined) return t("schedule.taskNextNever");
  return t("schedule.taskNext", { t: `${fmtTs(nextAt)} (${relIn(nextAt, ticker.now.value)})` });
}

// --- detail view (in-dialog swap; ONE PickerSheet — stacked sheets would double the scroll lock) ---

const detailTaskId = ref<string | null>(null);
/** The raw projection task under detail — read live off the hub slot so a change elsewhere
 *  re-renders the view with the refreshed definition; a task that vanishes from the snapshot
 *  falls back to the list view silently. */
const detailTask = computed(() => {
  if (detailTaskId.value === null || model.value.kind !== "ready") return null;
  const proj = hub?.state.value.schedules?.sessions.find((s) => s.sessionId === props.sessionId);
  return proj?.tasks.find((task) => task.task.id === detailTaskId.value) ?? null;
});

watch(detailTask, (task) => {
  if (task !== null || detailTaskId.value === null) return;
  if (model.value.kind !== "ready") return; // a degraded/unscanned store is not「任务已删除」
  detailTaskId.value = null;
});

function openDetail(taskId: string): void {
  detailTaskId.value = taskId;
}
function closeDetail(): void {
  detailTaskId.value = null;
}
</script>

<template>
  <PickerSheet :label="t('schedule.panelTitle')" class="sched-scrim" @close="emit('close')">
    <!-- detail view (swaps the whole dialog body; the task can vanish mid-view — a removed
         task falls back to the list view). -->
    <ScheduleTaskDetail v-if="detailTask !== null" :task="detailTask" @back="closeDetail" @close="emit('close')" />
    <div v-else class="sched-dialog">
      <header class="sched-head">
        <h3 class="sched-title">
          {{ t("schedule.panelTitle") }}
          <span v-if="model.kind === 'ready' && model.stale" class="chip sched-chip-missed">{{
            t("schedule.staleChip")
          }}</span>
        </h3>
        <button
          class="btn btn-ghost btn-icon sched-close"
          type="button"
          :aria-label="t('schedule.close')"
          @click="emit('close')"
        >
          <AppIcon name="x" class="icon-sm" />
        </button>
      </header>

      <p v-if="model.kind === 'ready' && model.stale" class="sched-note" data-kind="warn" role="status">
        {{ t("schedule.staleNote") }}
      </p>
      <p v-if="model.kind !== 'none' && model.offline" class="sched-note" data-kind="info" role="status">
        {{ t("schedule.offlineNote") }}
      </p>

      <template v-if="model.kind === 'degraded'">
        <p class="sched-note" data-kind="warn" role="alert">
          {{ t("schedule.degradedNote", { reason: model.reason }) }}
        </p>
      </template>

      <template v-else-if="model.kind === 'ready'">
        <CommandConfirm
          v-if="trackedConfirm"
          :name="trackedConfirm.name"
          :args="trackedConfirm.args"
          @confirm="tracked.confirm()"
          @cancel="tracked.cancel()"
        />
        <p v-if="actionNote !== null" class="sched-note" data-kind="warn" role="alert">{{ actionNote.text }}</p>
        <p v-if="model.droppedReports > 0" class="sched-note" data-kind="warn" role="status">
          {{ t("schedule.droppedReports", { n: model.droppedReports }) }}
        </p>

        <section class="sched-sec" :aria-label="t('schedule.sectionTasks', { n: model.tasks.length })">
          <p class="sched-sec-title">{{ t("schedule.sectionTasks", { n: model.tasks.length }) }}</p>
          <ul v-if="model.tasks.length > 0" class="sched-list">
            <li v-for="task in model.tasks" :key="task.id" class="sched-task" :data-enabled="task.enabled">
              <div class="sched-task-head">
                <span class="sched-task-name" translate="no">{{ task.name }}</span>
                <span v-if="task.enabled" class="chip">{{ t("schedule.taskEnabled") }}</span>
                <span v-else class="chip">{{ t("schedule.taskPaused") }}</span>
                <span v-if="task.totals.missed > 0" class="chip sched-chip-missed">{{
                  t("schedule.missedNote", { n: task.totals.missed })
                }}</span>
                <span class="sched-task-act">
                  <template v-if="model.canWrite">
                    <button
                      v-if="task.enabled"
                      class="icon-btn"
                      type="button"
                      :title="t('schedule.taskPause')"
                      :aria-label="t('schedule.taskPauseAria', { name: task.name })"
                      :disabled="busyTaskId !== null"
                      @click="void onTaskAction('pause', task.id)"
                    >
                      <AppIcon name="pause" class="icon-sm" />
                    </button>
                    <button
                      v-else
                      class="icon-btn"
                      type="button"
                      :title="t('schedule.taskResume')"
                      :aria-label="t('schedule.taskResumeAria', { name: task.name })"
                      :disabled="busyTaskId !== null"
                      @click="void onTaskAction('resume', task.id)"
                    >
                      <AppIcon name="play" class="icon-sm" />
                    </button>
                    <button
                      class="icon-btn danger"
                      type="button"
                      :title="t('schedule.taskRemove')"
                      :aria-label="t('schedule.taskRemoveAria', { name: task.name })"
                      :disabled="busyTaskId !== null"
                      @click="void onTaskAction('rm', task.id)"
                    >
                      <AppIcon name="trash" class="icon-sm" />
                    </button>
                  </template>
                  <button class="btn btn-ghost btn-xs" type="button" @click="openDetail(task.id)">
                    {{ t("schedule.details") }}
                  </button>
                </span>
              </div>
              <p class="sched-task-meta">
                {{ whenLabel(task.when) }} ·
                {{ t(task.form === "message" ? "schedule.formMessage" : "schedule.formBackground")
                }}<template v-if="task.feishu"> · {{ t("schedule.taskFeishuOn") }}</template>
                <template v-if="task.createdBy === 'agent'"> · {{ t("schedule.taskCreatedByAgent") }}</template>
                <template v-if="task.enabled"> · {{ nextLabel(task.nextAt, task.degraded) }}</template>
              </p>
              <p class="sched-task-stats">
                {{
                  t("schedule.taskStats", {
                    fired: task.totals.fired,
                    missed: task.totals.missed,
                    skipped: task.totals.skipped,
                    manual: task.totals.manual,
                  })
                }}
              </p>
            </li>
          </ul>
          <p v-else class="sched-empty">{{ t("schedule.empty") }}</p>
        </section>

        <section v-if="model.runs.length > 0" class="sched-sec" :aria-label="t('schedule.sectionRuns')">
          <p class="sched-sec-title">{{ t("schedule.sectionRuns") }}</p>
          <ul class="sched-list">
            <li
              v-for="run in model.runs"
              :key="run.runKey"
              class="sched-run"
              :data-state="runStateKey(run.state)"
              :data-live="run.live"
            >
              <span class="sched-run-state">{{ t(`schedule.runState.${runStateKey(run.state)}`) }}</span>
              <span class="sched-run-task" translate="no">{{ run.taskName || run.taskId }}</span>
              <span v-if="run.kind === 'manual'" class="chip">{{ t("schedule.runManual") }}</span>
              <span class="sched-run-time">{{ fmtTs(run.startedAt) }}</span>
              <span class="sched-run-sub">
                <template v-if="run.reason"
                  >{{ runReasonKey(run.state, run.reason) ? t(`schedule.runReason.${run.reason}`) : run.reason }} ·
                </template>
                {{ t("schedule.runFeishu", { state: t(`schedule.feishu.${run.feishu}`) })
                }}<template v-if="run.reportFile"> · {{ t("schedule.runReport", { file: run.reportFile }) }}</template>
              </span>
              <button
                v-if="run.runId !== undefined"
                class="icon-btn sched-run-open"
                type="button"
                :title="t('schedule.runOpen')"
                :aria-label="t('schedule.runOpenAria', { id: run.runId })"
                @click="openRun(run.runId!)"
              >
                <AppIcon name="chev-right" class="icon-sm" />
              </button>
            </li>
          </ul>
        </section>
      </template>

      <p v-else class="sched-empty">{{ t("schedule.empty") }}</p>
    </div>
  </PickerSheet>
</template>
