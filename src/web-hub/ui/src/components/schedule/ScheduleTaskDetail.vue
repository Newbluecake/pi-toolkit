<!--
  ScheduleTaskDetail (scheduled-reports W1, plan r3 §5.6): the read-only full-definition
  view of ONE scheduled task. Rendered INSIDE SchedulePanel (same lazy chunk, same PickerSheet
  — the panel swaps its body), never a second stacked sheet.

  Shows the full definition verbatim: the complete prompt (plain text nodes only, never
  v-html), schedule expr + tz, form, model/thinking/timeout/handoff/isolation, and the feishu
  flag. The wire's legacy approval fields (`pendingApproval` / `executable` / `offer` /
  `task.approval`) are ignored — never read. The parent passes the task looked up from the
  live `schedules` snapshot, so a change elsewhere re-renders the view.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { ScheduleTaskProjectionWire } from "@protocol/schedule.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { fmtTs, whenParts } from "../../logic/schedule.js";

const props = defineProps<{
  readonly task: ScheduleTaskProjectionWire;
}>();
const emit = defineEmits<{ back: []; close: [] }>();
const { t } = useI18n();

const def = computed(() => props.task.task);
const when = computed(() => whenParts(def.value.when));
const whenLabel = computed(() => {
  const w = when.value;
  if (w.kind === "cron") return t("schedule.whenCron", { expr: w.expr, tz: w.tz });
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

    <ul class="review-kv">
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
