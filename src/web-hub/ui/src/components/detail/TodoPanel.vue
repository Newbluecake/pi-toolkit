<!--
  Task-list panel (todo-web plan §4/D4, package T4): a read-only summary of the main session's
  Task* todo list, fed by `AgentState.todo` — `@logic/state.js`'s status reducer mirrors
  `StatusInfo.todo` (todo-web §3.1) onto the agent. Collapsed by default: the one-line summary
  ("Tasks 3/8 · 2 active") is the glance surface; expanding lists every task with a status
  icon, the subject, an optional description (projection-truncated, `descTruncated` adds the
  ellipsis back) and its still-open blockers (`blockedBy` = activeBlockers, same口径 as the
  TUI widget's `[blocked by #n]`). Rows beyond the wire cap surface as one `(+N more)` tail
  line via `omitted`.

  V1 拍板项: strictly read-only — no checkboxes, no write path, `aria-readonly` on the section.
  Empty-state 拍板项: no todo wire or zero tasks ⇒ the whole section doesn't render
  (`DetailHeader`'s `v-if` plus the `tasks.length` guard here as a second line; the agent-side
  projection already omits the field entirely when there are no tasks).

  Fold state is a plain local ref — NOT persisted across reloads, because
  source-scan.test.ts's persistence allowlist doesn't cover this component (same
  precedent as DetailHeader's own ≤480px metrics fold). Styles live in `styles/todo.css`
  (imported below) rather than scoped `<style>` — source-scan bans `<style>` blocks outright —
  or `styles/detail.css`, which the in-flight fleet-drawer F6 line owns.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import type { IconName } from "../../icons/names.js";
import { useI18n } from "../../composables/useI18n.js";
import type { TodoTaskWire, TodoWire } from "../../types.js";
import "../../styles/todo.css";

// contracts.ts is F6-owned and frozen for T4, so this props interface stays deliberately
// local (same escape hatch DetailHeader's inject-only SP12/todo-#7 additions used).
const props = defineProps<{ readonly todo: TodoWire }>();
const { t } = useI18n();

const open = ref(false);

const summary = computed(() =>
  t("detail.todoTitle", {
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
</script>

<template>
  <section v-if="todo.tasks.length > 0" class="todo-panel" :data-open="open" aria-readonly="true">
    <button
      class="todo-sum"
      type="button"
      :aria-expanded="open"
      :aria-label="t('detail.todoToggleAria')"
      @click="open = !open"
    >
      <span class="todo-sum-text">{{ summary }}</span>
      <span v-if="todo.counts.blocked > 0" class="todo-sum-blocked">
        <AppIcon name="alert" class="icon-sm" />{{ todo.counts.blocked }}
      </span>
      <AppIcon name="chev-right" class="icon-sm chev" />
    </button>
    <ul v-if="open" class="todo-list">
      <li v-for="task in todo.tasks" :key="task.id" class="todo-item" :data-status="task.status">
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
      <li v-if="todo.omitted !== undefined && todo.omitted > 0" class="todo-more">
        {{ t("detail.todoMore", { n: todo.omitted }) }}
      </li>
    </ul>
  </section>
</template>
