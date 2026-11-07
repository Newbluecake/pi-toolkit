<!--
  TasksPanel (schedule-auto-approve r2, plan §6-W2): the detail header's ONE aggregated
  glance panel — the todo section (markup + fold-tail logic migrated VERBATIM from the deleted
  TodoPanel.vue) plus a scheduled-tasks section (`ScheduleRows.vue`) behind a merged summary
  line ("Tasks 3/8 · 2 active · ⏰ 2"). DetailHeader mounts it when the agent carries a todo
  wire with tasks OR `schedSummaryOf` finds a schedule projection (cap `sched.v1`).

  Write path: the section's pause/resume/delete buttons ride the injected CONTROL_VIEW
  through `useTrackedCommand` — the first send carries no confirm, the policy's
  E_CONFIRM_REQUIRED surfaces the generic CommandConfirm bar here, and 执行 re-sends with
  `confirm: true` (D4: pause/resume/rm stay policy-confirm as通用防误点; the bar is UX, not
  an approval concept). Offline/read-only surfaces pass canWrite=false ⇒ no action buttons at
  all. `open-run`/`open-schedule` bubble up to DetailHeader (selectRun / SchedulePanel).

  Fold state is a plain local ref — NOT persisted (source-scan's persistence allowlist doesn't
  cover this component, TodoPanel/WorktreePanel precedent). The todo section keeps
  `aria-readonly` (that section stays read-only); styles: todo rows in `styles/todo.css`
  (imported), panel/section chrome + sched rows in `styles/schedule.css`.
-->
<script setup lang="ts">
import { computed, inject, onUnmounted, ref } from "vue";
import type { ScheduleSessionProjectionWire } from "@protocol/schedule.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { IconName } from "../../icons/names.js";
import { useI18n } from "../../composables/useI18n.js";
import { useTicker } from "../../composables/useTicker.js";
import { useTrackedCommand } from "../../composables/useTrackedCommand.js";
import { taskRowsOf } from "../../logic/schedule.js";
import type { TodoTaskWire, TodoWire } from "../../types.js";
import CommandConfirm from "../control/CommandConfirm.vue";
import { CONTROL_VIEW } from "../control/controlContext.js";
import ScheduleRows from "../schedule/ScheduleRows.vue";
import type { SchedSummary, TaskRow } from "../schedule/taskRow.js";
import "../../styles/todo.css";
import "../../styles/schedule.css"; // the panel chrome (.tasks-panel/.tasks-sec/…) + rows (via ScheduleRows)

const props = defineProps<{
  /** Absent/empty ⇒ the todo section doesn't render (the old TodoPanel ruling). */
  readonly todo?: TodoWire | undefined;
  /** `schedSummaryOf`'s result — undefined ⇒ no sched section, no ⏰ segment. */
  readonly schedSummary?: SchedSummary | undefined;
  /** The session's raw projection (rows derive here off the ticker clock). */
  readonly schedProj?: ScheduleSessionProjectionWire | undefined;
  /** Offline (E3) / read-only surfaces pass false ⇒ ScheduleRows hides its action column. */
  readonly canWrite?: boolean;
}>();
const emit = defineEmits<{
  openRun: [runId: string];
  openSchedule: [];
}>();
const { t } = useI18n();

const open = ref(false);

/** Browser clock for the `next …`/`last …` relative tokens (30s — relIn/relAgo are
 *  minute-grained; SchedulePanel precedent). Disposed with the panel. */
const ticker = useTicker({
  doc: typeof document === "undefined" ? { hidden: false, addEventListener() {}, removeEventListener() {} } : document,
  win: typeof window === "undefined" ? { addEventListener() {}, removeEventListener() {} } : window,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  now: () => Date.now(),
  intervalMs: 30_000,
});
onUnmounted(() => ticker.dispose());

// --- todo section (verbatim migration from TodoPanel.vue) ------------------------------------

const todoPresent = computed(() => (props.todo?.tasks.length ?? 0) > 0);
/** todo-archive v2.1 (D5): the "more" tail excludes what `todoCompletedHidden` already
 *  counted — an old wire (no completedHidden) degrades to the raw `omitted` count. */
const moreCount = computed(() => Math.max(0, (props.todo?.omitted ?? 0) - (props.todo?.completedHidden ?? 0)));

const todoSummary = computed(() =>
  props.todo === undefined
    ? ""
    : t("detail.tasksSummary", {
        done: props.todo.counts.completed,
        total: props.todo.total,
        active: props.todo.counts.inProgress,
      }),
);

/** 状态图标语义沿用既有图标: pending=clock（等待）, in_progress=loader（旋转）, completed=check。 */
const STATUS_ICON: Readonly<Record<TodoTaskWire["status"], IconName>> = {
  pending: "clock",
  in_progress: "loader",
  completed: "check",
};

function statusLabel(status: TodoTaskWire["status"]): string {
  switch (status) {
    case "pending":
      return t("detail.todoStatusPending");
    case "in_progress":
      return t("detail.todoStatusInProgress");
    case "completed":
      return t("detail.todoStatusCompleted");
  }
}

function blockedLabel(task: TodoTaskWire): string {
  return t("detail.todoBlockedBy", { ids: task.blockedBy.map((id) => `#${id}`).join(", ") });
}

// --- sched section -----------------------------------------------------------------------------

const rows = computed<TaskRow[]>(() =>
  props.schedSummary === undefined ? [] : (taskRowsOf(props.schedProj, ticker.now.value) as TaskRow[]),
);
const schedDegraded = computed(() => {
  const d = props.schedProj?.degraded;
  return typeof d === "string" && d !== "" ? d : undefined;
});

/** The summary's ⏰ segment (compact English token; the AgentCard chip grammar). */
const schedSummaryText = computed(() => (props.schedSummary === undefined ? "" : `⏰ ${props.schedSummary.count}`));
const summary = computed(() => [todoSummary.value, schedSummaryText.value].filter((seg) => seg !== "").join(" · "));

// --- sched write path (pause/resume/rm through the policy confirm) ----------------------------

const view = inject(CONTROL_VIEW, null);
const tracked = useTrackedCommand({
  view: () => {
    if (view === null) return null;
    return { control: view.control, agentKey: view.agentKey, pendingCtl: view.agent.value.pendingCtl };
  },
});
const trackedConfirm = tracked.confirmReq;
/** Task id with an action in flight (buttons keep rendering; the tracked channel serializes
 *  to one logical command at a time — a second click while busy is dropped). */
const busyTaskId = ref<string | null>(null);
const actionNote = ref<string | null>(null);

async function onSchedAction(action: "pause" | "resume" | "rm", id: string): Promise<void> {
  if (busyTaskId.value !== null) return;
  busyTaskId.value = id;
  actionNote.value = null;
  try {
    const r = await tracked.run("schedule", `${action} ${id}`);
    if (!r.ok && !("cancelled" in r)) {
      actionNote.value = t("detail.tasksActionFailed", { reason: r.message ?? r.error });
    }
  } finally {
    busyTaskId.value = null;
  }
}
</script>

<template>
  <section class="tasks-panel" :data-open="open">
    <button
      class="todo-sum"
      type="button"
      :aria-expanded="open"
      :aria-label="t('detail.tasksToggleAria')"
      @click="open = !open"
    >
      <AppIcon name="check" class="icon-sm" />
      <span class="todo-sum-text">{{ summary }}</span>
      <span v-if="todoPresent && (todo?.counts.blocked ?? 0) > 0" class="todo-sum-blocked">
        <AppIcon name="alert" class="icon-sm" />{{ todo?.counts.blocked }}
      </span>
      <AppIcon name="chev-right" class="icon-sm chev" />
    </button>
    <div v-if="open" class="tasks-body">
      <div v-if="todoPresent" class="tasks-sec" aria-readonly="true">
        <p class="tasks-sec-title">{{ t("detail.tasksTodoSec", { n: todo!.total }) }}</p>
        <ul class="todo-list">
          <li v-for="task in todo!.tasks" :key="task.id" class="todo-item" :data-status="task.status">
            <AppIcon
              :name="STATUS_ICON[task.status]"
              class="icon-sm todo-ico"
              :class="{ spin: task.status === 'in_progress' }"
            />
            <span class="sr-only">{{ statusLabel(task.status) }}</span>
            <span class="todo-body">
              <span class="todo-subject">{{ task.subject }}</span>
              <span v-if="task.description" class="todo-desc"
                >{{ task.description }}{{ task.descTruncated ? "…" : "" }}</span
              >
              <span v-if="task.blockedBy.length > 0" class="todo-blocked">{{ blockedLabel(task) }}</span>
            </span>
          </li>
          <li v-if="todo!.completedHidden !== undefined && todo!.completedHidden > 0" class="todo-done">
            {{ t("detail.todoCompletedHidden", { n: todo!.completedHidden }) }}
          </li>
          <li v-if="moreCount > 0" class="todo-more">{{ t("detail.todoMore", { n: moreCount }) }}</li>
          <li v-if="todo!.archived !== undefined && todo!.archived > 0" class="todo-archived">
            {{ t("detail.todoArchived", { n: todo!.archived }) }}
          </li>
        </ul>
      </div>

      <div v-if="schedSummary !== undefined" class="tasks-sec">
        <p class="tasks-sec-title">{{ t("detail.tasksSchedSec", { n: schedSummary.count }) }}</p>
        <p v-if="schedDegraded !== undefined" class="tasks-sched-note">
          {{ t("detail.tasksSchedUnreadable", { reason: schedDegraded }) }}
        </p>
        <ScheduleRows
          :rows="rows"
          :now="ticker.now.value"
          :can-write="canWrite === true && busyTaskId === null"
          @pause="(id) => void onSchedAction('pause', id)"
          @resume="(id) => void onSchedAction('resume', id)"
          @remove="(id) => void onSchedAction('rm', id)"
          @open-run="(runId) => emit('openRun', runId)"
          @open-detail="emit('openSchedule')"
        />
        <p class="tasks-foot">
          <button class="tasks-foot-link" type="button" @click="emit('openSchedule')">
            {{ t("detail.tasksFoot") }}
          </button>
        </p>
      </div>

      <CommandConfirm
        v-if="trackedConfirm"
        :name="trackedConfirm.name"
        :args="trackedConfirm.args"
        @confirm="tracked.confirm()"
        @cancel="tracked.cancel()"
      />
      <p v-if="actionNote !== null" class="tasks-sched-note" role="alert">{{ actionNote }}</p>
    </div>
  </section>
</template>
