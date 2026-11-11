<!--
  ScheduleTaskDetail (scheduled-reports W1, plan r3 §5.6): the full-definition
  view and policy-governed editor of ONE scheduled task. Rendered INSIDE SchedulePanel (same lazy chunk, same PickerSheet
  — the panel swaps its body), never a second stacked sheet.

  Shows the full definition verbatim: the complete prompt (plain text nodes only, never
  v-html), schedule expr + tz, form, model/thinking/timeout/handoff/isolation, and the feishu
  flag. The wire's legacy approval fields (`pendingApproval` / `executable` / `offer` /
  `task.approval`) are ignored — never read. The parent passes the task looked up from the
  live `schedules` snapshot, so a change elsewhere re-renders the view.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { StoredTaskProjection } from "@protocol/schedule.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { fmtTs, whenParts, scheduleEditArgs } from "../../logic/schedule.js";

const props = defineProps<{
  readonly task: StoredTaskProjection;
  readonly canEdit?: boolean;
  readonly busy?: boolean;
  readonly error?: string | undefined;
}>();
const emit = defineEmits<{ back: []; close: []; save: [args: string] }>();
const editing = ref(false);
const invalid = ref(false);
const draft = ref({ name: "", prompt: "", kind: "every", value: "", tz: "UTC" });
function beginEdit(): void {
  const task = props.task.task;
  const w = task.when;
  draft.value = {
    name: task.name,
    prompt: task.prompt,
    kind: w.kind,
    value: w.kind === "every" ? `${w.everyMs / 1000}s` : w.kind === "cron" ? w.expr : w.at,
    tz: w.kind === "every" ? "UTC" : w.tz,
  };
  invalid.value = false;
  editing.value = true;
}
function save(): void {
  const args = scheduleEditArgs(props.task.task, draft.value);
  invalid.value = args === undefined;
  if (args !== undefined && props.canEdit && !props.busy) emit("save", args);
}
const { t } = useI18n();

const def = computed(() => props.task.task);
const when = computed(() => whenParts(def.value.when));
const whenLabel = computed(() => {
  const w = when.value;
  if (w.kind === "cron") return t("schedule.whenCron", { expr: w.expr, tz: w.tz });
  if (w.kind === "every") return t("schedule.whenEvery", { expr: w.expr });
  if (w.kind === "once") return t("schedule.whenOnce", { expr: w.expr, tz: w.tz });
  return t("schedule.whenInvalid");
});
const bg = computed(() => (def.value.form === "background" ? def.value.bg : undefined));
const createdLabel = computed(() =>
  def.value.createdBy === "agent"
    ? t("schedule.createdByAgent", { at: fmtTs(def.value.createdAt) })
    : t("schedule.createdByUser", { at: fmtTs(def.value.createdAt) }),
);
</script>

<template>
  <div class="sched-dialog">
    <header class="sched-head">
      <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('schedule.cancel')" @click="emit('back')">
        <AppIcon name="chev-left" class="icon-sm" />
      </button>
      <h3 class="sched-title">{{ t("schedule.detailTitle", { name: def.name }) }}</h3>
      <button
        class="btn btn-ghost btn-icon sched-close"
        type="button"
        :aria-label="t('schedule.close')"
        @click="emit('close')"
      >
        <AppIcon name="x" class="icon-sm" />
      </button>
    </header>
    <slot />

    <p v-if="invalid" class="sched-empty" role="alert">{{ t("schedule.editInvalid") }}</p>
    <p v-if="error" class="sched-empty" role="alert">{{ error }}</p>
    <p v-if="task.legacyStep" class="sched-empty">legacy-step: {{ task.legacyStep }}</p>
    <button v-if="canEdit && !editing" type="button" class="btn btn-ghost" data-schedule-edit @click="beginEdit">
      {{ t("schedule.taskEdit") }}
    </button>
    <form v-if="editing" class="sched-sec sched-edit" @submit.prevent="save">
      <fieldset :disabled="busy || !canEdit">
        <label>{{ t("schedule.editName") }}<input v-model="draft.name" name="name" maxlength="40" required /></label>
        <label
          >{{ t("schedule.kvWhen") }}
          <select v-model="draft.kind" name="kind">
            <option value="cron">cron</option>
            <option value="once">at</option>
            <option value="every">every</option>
          </select>
        </label>
        <label>{{ t("schedule.editWhen") }}<input v-model="draft.value" name="when" required /></label>
        <label v-if="draft.kind !== 'every'"
          >{{ t("schedule.editTz") }}<input v-model="draft.tz" name="tz" required
        /></label>
        <p v-else>{{ t("schedule.editEveryHint") }}</p>
        <label>{{ t("schedule.reviewPromptLabel") }}<textarea v-model="draft.prompt" name="prompt" required /></label>
        <p>{{ t("schedule.editPolicyHint") }}</p>
        <button type="submit" class="btn btn-primary">{{ t("schedule.editSave") }}</button>
        <button type="button" class="btn btn-ghost" @click="editing = false">{{ t("schedule.cancel") }}</button>
      </fieldset>
    </form>
    <ul v-else class="review-kv">
      <li>
        <span class="k">{{ t("schedule.kvWhen") }}</span>
        <span class="v" translate="no">{{ whenLabel }}</span>
      </li>
      <li>
        <span class="k">{{ t("schedule.kvForm") }}</span>
        <span class="v"
          >{{ t(def.form === "message" ? "schedule.formMessage" : "schedule.formBackground") }} ·
          {{ t("schedule.kvFeishu") }} {{ def.feishu ? t("schedule.kvOn") : t("schedule.kvOff") }}</span
        >
      </li>
      <template v-if="bg">
        <li>
          <span class="k">{{ t("schedule.kvType") }}</span>
          <span class="v" translate="no">{{ bg.type }}</span>
        </li>
        <li v-if="bg.model">
          <span class="k">{{ t("schedule.kvModel") }}</span>
          <span class="v" translate="no">{{ bg.model.provider }}/{{ bg.model.id }}</span>
        </li>
        <li v-if="bg.thinking">
          <span class="k">{{ t("schedule.kvThinking") }}</span>
          <span class="v" translate="no">{{ bg.thinking }}</span>
        </li>
        <li>
          <span class="k">{{ t("schedule.kvTimeout") }}</span>
          <span class="v">{{ bg.timeoutS }}s</span>
        </li>
        <li v-if="bg.consultMain">
          <span class="k">{{ t("schedule.kvConsult") }}</span>
          <span class="v">{{ t("schedule.kvOn") }}</span>
        </li>
        <li>
          <span class="k">{{ t("schedule.kvHandoff") }}</span>
          <span class="v">{{ bg.handoff ? t("schedule.kvOn") : t("schedule.kvOff") }}</span>
        </li>
        <li>
          <span class="k">{{ t("schedule.kvIsolation") }}</span>
          <span class="v">{{ bg.isolation === "worktree" ? t("schedule.kvOn") : t("schedule.kvOff") }}</span>
        </li>
      </template>
      <li>
        <span class="k">{{ t("schedule.kvCreatedBy") }}</span>
        <span class="v">{{ createdLabel }}</span>
      </li>
    </ul>

    <section class="sched-sec" :aria-label="t('schedule.reviewPromptLabel')">
      <p class="sched-sec-title">{{ t("schedule.reviewPromptLabel") }}</p>
      <pre class="review-prompt" translate="no">{{ def.prompt }}</pre>
    </section>
  </div>
</template>
