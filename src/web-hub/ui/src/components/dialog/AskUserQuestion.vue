<!--
  One ask_user question (control-plan.md v2.1 §7.4 — C5): semantic `fieldset/legend`, options
  as radio (single) / checkbox (`multiSelect`) with their descriptions, `context` as grey
  helper text, and an automatic free-text "Other" row (same as the TUI; hidden only when the
  wire explicitly says `allowOther: false`). Typing in Other auto-selects its pseudo-option;
  no global number-key shortcuts (§7.4 — they'd hijack the inputs). Selections are written
  straight into the form-provided `ASK_FORM` context (see `askFormContext.ts` for why this
  isn't an emit — the frozen contract has none).
-->
<script setup lang="ts">
import { computed, inject } from "vue";
import type { AskUserQuestionWire } from "@protocol/messages.js";
import { useI18n } from "../../composables/useI18n.js";
import type { AskUserQuestionProps } from "../../contracts.js";
import { ASK_FORM, type AskSelection } from "./askFormContext.js";

const props = defineProps<AskUserQuestionProps>();
const { t } = useI18n();
const form = inject(ASK_FORM, null);

const question = computed(() => props.question as AskUserQuestionWire);
const multi = computed(() => question.value.multiSelect === true);
const showOther = computed(() => question.value.allowOther !== false);
const options = computed(() => (Array.isArray(question.value.options) ? question.value.options : []));

const index = computed(() => (form ? form.questions.indexOf(props.question) : -1));

// Local fallback when mounted without a form context (isolated tests).
const fallback: AskSelection = { selected: [], other: null };
const selection = computed<AskSelection>(() => {
  const i = index.value;
  if (!form || i < 0) return fallback;
  return form.selections[i] ?? fallback;
});

const inputName = computed(() => `ask-q-${index.value}`);

function setSelected(next: string[]): void {
  const i = index.value;
  if (!form || i < 0 || form.suspended.value) return;
  form.selections[i] = { selected: next, other: selection.value.other };
  form.saveDraft();
}

function setOther(text: string): void {
  const i = index.value;
  if (!form || i < 0 || form.suspended.value) return;
  form.selections[i] = { selected: selection.value.selected, other: text };
  form.saveDraft();
}

function isChecked(label: string): boolean {
  return selection.value.selected.includes(label);
}

function onToggle(label: string, ev: Event): void {
  const checked = (ev.target as HTMLInputElement).checked;
  const cur = selection.value.selected;
  setSelected(multi.value ? (checked ? [...cur, label] : cur.filter((l) => l !== label)) : checked ? [label] : []);
}

function onRadio(label: string): void {
  const i = index.value;
  // Snapshot BEFORE the mutation (2026-10 revision UX): auto-advance is a first-answer
  // convenience only — revising an already-answered question must keep the user on that tab,
  // so the form needs to know whether this pick is the question's first answer or a revision.
  // Re-picking the already-selected option fires no `change` event at all, so this path never
  // double-fires for a no-op click.
  const wasAnswered = form !== null && i >= 0 && form.isAnswered(i);
  setSelected([label]);
  // 2026-10 mobile UX: auto-advance multi-question dialogs to the next unanswered tab. Only
  // fired for this single-select path — setSelected() alone (shared with the multiSelect
  // checkbox toggle above) has no "this question is done" signal of its own.
  if (form && i >= 0 && !form.suspended.value) form.onAnswered?.(i, wasAnswered);
}

function onOtherInput(ev: Event): void {
  setOther((ev.target as HTMLInputElement).value);
}
</script>

<template>
  <fieldset class="ask-question" :disabled="form?.suspended.value === true">
    <legend class="ask-question-text">{{ question.question }}</legend>
    <p v-if="question.context" class="ask-context">{{ question.context }}</p>
    <div class="ask-options">
      <label v-for="opt in options" :key="opt.label" class="ask-option">
        <input
          v-if="multi"
          type="checkbox"
          :name="inputName"
          :value="opt.label"
          :checked="isChecked(opt.label)"
          @change="onToggle(opt.label, $event)"
        />
        <input
          v-else
          type="radio"
          :name="inputName"
          :value="opt.label"
          :checked="isChecked(opt.label)"
          @change="onRadio(opt.label)"
        />
        <span class="ask-option-text">
          <span class="ask-option-label">{{ opt.label }}</span>
          <span v-if="opt.description" class="ask-option-desc">{{ opt.description }}</span>
        </span>
      </label>
      <label v-if="showOther" class="ask-option ask-other">
        <span class="ask-option-text">
          <span class="ask-option-label">{{ t("dialog.other") }}</span>
          <input
            class="ask-other-input"
            type="text"
            data-other
            :aria-label="t('dialog.otherAria')"
            :placeholder="t('dialog.otherPlaceholder')"
            :value="selection.other ?? ''"
            :disabled="form?.suspended.value === true"
            maxlength="4096"
            @input="onOtherInput"
          />
        </span>
      </label>
    </div>
  </fieldset>
</template>
