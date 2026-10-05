<!--
  ask_user dual-channel form (control-plan.md v2.1 §5/§7.4, §12.3 — C5). Rendered by
  `AgentDetail` in place of the waiting banner while `agent.dialogs.open` is non-empty.

  - Multi-question dialogs get a top tab row (each question's `header`, else "Question N");
    single-question dialogs render directly. All questions stay MOUNTED (`v-show`) so tab
    switches never lose a half-filled answer.
  - Submit is enabled only when every question has an answer (`dialogComplete`, §7.4); the
    payload goes through `buildDialogAnswers` (labels filtered to what the question offers).
  - `allowCancel` ⇒ a Cancel button with the same two-step grammar as StopButton.
  - Selections auto-persist as a draft keyed `(agentKey, epoch, dialogId)` (§3.5) into
    `CONTROL_ENV.dialogDrafts` — switching agents and back loses nothing; a page reload does
    (in-memory only, like the composer drafts).
  - `suspended` (hub `restarting`, §6.7.3 网页语义): the whole form goes read-only, Submit is
    disabled, the draft is preserved, and the suspended copy points at the terminal; when the
    hub comes back with this dialogId still open the same mounted form simply becomes
    answerable again.

  The 409 race loss is handled by the PARENT (AgentDetail folds the form into "Answered in the
  terminal / …" from `dialogs.closed[].by`) — this component only emits.
-->
<script setup lang="ts">
import { computed, inject, nextTick, provide, reactive, ref, watch } from "vue";
import { buildDialogAnswers, dialogComplete } from "@logic/control.js";
import type { AskUserQuestionWire, DialogWire } from "@protocol/messages.js";
import { useI18n } from "../../composables/useI18n.js";
import type { AskUserFormEmits, AskUserFormProps } from "../../contracts.js";
import { CONTROL_ENV, CONTROL_VIEW, dialogDraftKey } from "../control/controlContext.js";
import AskUserQuestion from "./AskUserQuestion.vue";
import { ASK_FORM, type AskSelection } from "./askFormContext.js";

const props = defineProps<AskUserFormProps>();
const emit = defineEmits<AskUserFormEmits>();
const { t } = useI18n();

const view = inject(CONTROL_VIEW, null);
const env = inject(CONTROL_ENV, null);

const dialog = computed(() => props.dialog as DialogWire);
const questions = computed<readonly AskUserQuestionWire[]>(() =>
  Array.isArray(dialog.value.questions) ? dialog.value.questions : [],
);

const draftKey = computed(() =>
  dialogDraftKey(view?.agentKey ?? "?", view?.agent.value.dialogs?.epoch ?? "?", dialog.value.dialogId),
);

function blankSelections(): AskSelection[] {
  return questions.value.map(() => ({ selected: [], other: null }));
}

function loadDraft(): AskSelection[] {
  const raw = env?.dialogDrafts.get(draftKey.value);
  if (!Array.isArray(raw) || raw.length !== questions.value.length) return blankSelections();
  return raw.map((r) => {
    const rec = r !== null && typeof r === "object" ? (r as Partial<AskSelection>) : {};
    return {
      selected: Array.isArray(rec.selected) ? rec.selected.filter((s): s is string => typeof s === "string") : [],
      other: typeof rec.other === "string" ? rec.other : null,
    };
  });
}

const selections = reactive<AskSelection[]>(loadDraft());

function saveDraft(): void {
  env?.dialogDrafts.set(
    draftKey.value,
    selections.map((s) => ({ selected: [...s.selected], other: s.other })),
  );
}

const suspended = computed(() => props.suspended === true);

// --- auto-advance (multi-question; 2026-10 mobile UX) ---------------------------------------
// A single-select answer on one tab jumps to the next unanswered tab (forward, wrapping back to
// the start) so a phone user never has to reach for the tab row between questions. multiSelect
// toggles and Other free text never call this (askFormContext.ts's AskFormCtx.onAnswered doc) —
// there is no reliable "this question is done" moment for either. Manual tab clicks are
// untouched (this only ever WRITES `activeTab`, same ref the tab buttons already use).
const submitBtn = ref<HTMLButtonElement | null>(null);

function isAnswered(sel: AskSelection | undefined): boolean {
  if (sel === undefined) return false;
  return sel.selected.length > 0 || (typeof sel.other === "string" && sel.other.trim() !== "");
}

function onQuestionAnswered(index: number): void {
  if (!multi.value) return; // single-question dialogs have no tab to advance to
  const n = questions.value.length;
  for (let step = 1; step <= n; step++) {
    const next = (index + step) % n;
    if (!isAnswered(selections[next])) {
      activeTab.value = next;
      return;
    }
  }
  // every question answered: stay put, move focus to Submit (nextTick — it may have just
  // flipped from disabled to enabled this same tick).
  void nextTick(() => submitBtn.value?.focus());
}

// accfix-N1: `questions` must stay a LIVE view, not a one-time snapshot of `questions.value` —
// this component's <script setup> runs once per mount, but `props.dialog` (and therefore
// `questions.value`) can be replaced with a new array (same dialogId, different array/item
// identity) later without a remount, e.g. when a hub restart/version-replace restores this
// dialog's slot in place. `AskUserQuestion.vue` looks itself up via
// `form.questions.indexOf(props.question)` (object identity), so a stale snapshot here made
// that lookup fail forever (`index === -1` ⇒ radio group name `ask-q--1`, every selection
// silently dropped, Submit stuck disabled). A getter keeps `form.questions` reading the
// current computed value on every access, so it advances in lockstep with the live `questions`
// the template's `v-for` hands to `AskUserQuestion` as `props.question`.
provide(ASK_FORM, {
  get questions() {
    return questions.value;
  },
  selections,
  suspended,
  saveDraft,
  onAnswered: onQuestionAnswered,
});

// --- tabs (multi-question; §7.4 "多题 = 顶部 tab（header）") ---
const activeTab = ref(0);
const multi = computed(() => questions.value.length > 1);
function tabLabel(q: AskUserQuestionWire, i: number): string {
  return typeof q.header === "string" && q.header !== "" ? q.header : t("dialog.questionTab", { n: i + 1 });
}

// --- completion / submit ---
const complete = computed(() => dialogComplete([...questions.value], selections));
function onSubmit(): void {
  if (!complete.value || suspended.value) return;
  const answers = buildDialogAnswers([...questions.value], selections);
  if (answers === undefined) return;
  env?.dialogDrafts.delete(draftKey.value);
  emit("answer", answers);
}

// --- cancel (two-step, same grammar as StopButton) ---
const cancelArmed = ref(false);
let cancelTimer: ReturnType<typeof setTimeout> | undefined;
function cancelDisarm(): void {
  cancelArmed.value = false;
  if (cancelTimer !== undefined) {
    clearTimeout(cancelTimer);
    cancelTimer = undefined;
  }
}
function onCancelClick(): void {
  if (suspended.value) return;
  if (!cancelArmed.value) {
    cancelArmed.value = true;
    cancelTimer = setTimeout(cancelDisarm, 4000);
    return;
  }
  cancelDisarm();
  env?.dialogDrafts.delete(draftKey.value);
  emit("cancel");
}
function onCancelKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && cancelArmed.value) {
    ev.stopPropagation();
    cancelDisarm();
  }
}

// An epoch flip remounts this component (AgentDetail's :key) — but guard anyway: a draft
// restored under a NEW key pair starts blank, never resurrecting stale selections.
watch(draftKey, () => {
  const fresh = loadDraft();
  selections.splice(0, selections.length, ...fresh);
});
</script>

<template>
  <section class="ask-user-form" :aria-label="t('dialog.formAria')" :data-suspended="suspended ? 'true' : undefined">
    <p class="ask-dual-hint">{{ t("dialog.alsoInTerminal") }}</p>
    <p v-if="suspended" class="ask-suspended" role="status">{{ t("dialog.suspended") }}</p>

    <div v-if="multi" class="ask-tabs" role="tablist">
      <button
        v-for="(q, i) in questions"
        :key="i"
        type="button"
        role="tab"
        data-question-tab
        :aria-selected="activeTab === i"
        :class="{ active: activeTab === i }"
        @click="activeTab = i"
      >
        {{ tabLabel(q, i) }}
      </button>
    </div>

    <AskUserQuestion v-for="(q, i) in questions" v-show="!multi || activeTab === i" :key="i" :question="q" />

    <div class="ask-actions">
      <button
        ref="submitBtn"
        class="btn btn-primary"
        type="button"
        data-submit
        :disabled="!complete || suspended"
        :aria-label="t('dialog.submitAria')"
        @click="onSubmit"
      >
        {{ t("dialog.submit") }}
      </button>
      <template v-if="dialog.allowCancel">
        <button
          class="btn btn-ghost"
          :class="{ armed: cancelArmed }"
          type="button"
          :disabled="suspended"
          :data-armed="cancelArmed ? 'true' : undefined"
          :aria-label="t('dialog.cancelAria')"
          @click="onCancelClick"
          @keydown="onCancelKeydown"
        >
          {{ cancelArmed ? t("dialog.cancelConfirm") : t("dialog.cancel") }}
        </button>
        <span v-if="cancelArmed" class="sr-only" role="status">{{ t("dialog.cancelArmed") }}</span>
      </template>
    </div>
  </section>
</template>
