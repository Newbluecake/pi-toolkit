<!--
  ScheduleReview (scheduled-reports W1, plan r3 §5.6「专用审阅对话框」/复审 Major 5) — the
  approval surface for a pending-approval task, and the read-only full-definition view for
  every other task. Rendered INSIDE SchedulePanel (same lazy chunk, same PickerSheet — the
  panel swaps its body), never a second stacked sheet.

  What it must guarantee (复审 Major 5):
  - shows the FULL definition verbatim — the complete prompt (plain text nodes only, never
    v-html), schedule expr + tz, form, model/thinking/timeout/consult/handoff/isolation,
    feishu flag, and the defHash (first 8 in the note, full hash on the wire);
  - 「批准」 sends `/schedule approve <id> <fullHash>` through `useTrackedCommand` (own cmdId,
    async settle via pendingCtl + one queryOnly, E_CONFIRM_REQUIRED re-issued behind the
    generic CommandConfirm bar) — the hash comes ONLY from this dialog's projection, and the
    agent's lock-internal CAS is the arbiter;
  - `E_REV` (definition changed under the dialog) ⇒ the 「内容已变更，请重新审阅」 note; the
    dialog re-renders live off the hub slot, so the refreshed definition is what the user now
    sees (the parent passes the task looked up from the live `schedules` snapshot).

  Read-only unless `canWrite` (online session + control channel) AND `task.pendingApproval`.
  Offline sessions (E3) and non-pending tasks show no action buttons at all.
-->
<script setup lang="ts">
import { computed, inject, ref } from "vue";
import type { ScheduleTaskProjectionWire } from "@protocol/schedule.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useTrackedCommand, type TrackedCommandResult } from "../../composables/useTrackedCommand.js";
import { approveArgs, fmtTs, shortHash, whenParts } from "../../logic/schedule.js";
import CommandConfirm from "../control/CommandConfirm.vue";
import { CONTROL_VIEW } from "../control/controlContext.js";

const props = defineProps<{ readonly task: ScheduleTaskProjectionWire; readonly canWrite: boolean }>();
const emit = defineEmits<{ back: []; close: [] }>();
const { t } = useI18n();

const view = inject(CONTROL_VIEW, null);
const tracked = useTrackedCommand({
  view: () => {
    if (view === null) return null;
    return { control: view.control, agentKey: view.agentKey, pendingCtl: view.agent.value.pendingCtl };
  },
});
const busy = computed(() => tracked.phase.value !== "idle");
// Top-level bindings so the template auto-unwraps them (nested refs on the plain `tracked`
// object are NOT unwrapped by the template compiler — ChannelsDialog precedent).
const trackedPhase = tracked.phase;
const trackedConfirm = tracked.confirmReq;

const note = ref<{ kind: "ok" | "err" | "rev"; text: string } | null>(null);

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

/** The approval button: only a pending task on a writable channel (§5.6). The approval hash
 *  is the projection's CURRENT defHash — read at click time so a mid-review change can never
 *  be approved from a stale render (the agent's CAS double-checks anyway). */
const approvable = computed(() => props.canWrite && props.task.pendingApproval === true && !busy.value);

function isRev(r: TrackedCommandResult): boolean {
  if (r.ok) return false;
  if ("cancelled" in r) return false;
  return /\bE_REV\b/.test(r.error) || (r.message !== undefined && /\bE_REV\b/.test(r.message));
}

async function onApprove(): Promise<void> {
  if (!approvable.value) return;
  note.value = null;
  const r = await tracked.run("schedule", approveArgs(def.value.id, props.task.defHash));
  if (r.ok) {
    note.value = { kind: "ok", text: t("schedule.approveOk") };
    return;
  }
  if ("cancelled" in r) return; // timeout/close/switch — the next SSE snapshot is the truth
  note.value = isRev(r)
    ? { kind: "rev", text: t("schedule.approveRev") }
    : { kind: "err", text: t("schedule.approveFailed", { reason: r.message ?? r.error }) };
}
</script>

<template>
  <div class="sched-dialog">
    <header class="sched-head">
      <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('schedule.cancel')" @click="emit('back')">
        <AppIcon name="chev-left" class="icon-sm" />
      </button>
      <h3 class="sched-title">{{ t("schedule.reviewTitle", { name: def.name }) }}</h3>
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
        <li>
          <span class="k">{{ t("schedule.kvConsult") }}</span>
          <span class="v">{{ bg.consultMain ? t("schedule.kvOn") : t("schedule.kvOff") }}</span>
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

    <p class="review-hash">{{ t("schedule.reviewHashNote", { hash: shortHash(task.defHash) }) }}</p>

    <CommandConfirm
      v-if="trackedConfirm"
      :name="trackedConfirm.name"
      :args="trackedConfirm.args"
      @confirm="tracked.confirm()"
      @cancel="tracked.cancel()"
    />

    <p
      v-if="note"
      class="review-status"
      :data-kind="note.kind === 'ok' ? 'ok' : 'err'"
      :role="note.kind === 'ok' ? 'status' : 'alert'"
    >
      {{ note.text }}
    </p>

    <div v-if="task.pendingApproval" class="review-actions">
      <button class="btn btn-ghost" type="button" @click="emit('back')">{{ t("schedule.cancel") }}</button>
      <button
        v-if="canWrite"
        class="btn btn-primary"
        type="button"
        :disabled="!approvable"
        :aria-label="t('schedule.approveAria')"
        @click="void onApprove()"
      >
        <AppIcon v-if="trackedPhase === 'running'" name="loader" class="icon-sm spin" />
        {{ trackedPhase === "running" ? t("schedule.approving") : t("schedule.approve") }}
      </button>
    </div>
  </div>
</template>
