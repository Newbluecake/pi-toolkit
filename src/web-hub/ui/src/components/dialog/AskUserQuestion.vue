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
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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

/**
 * Compact ruling (mock ~/pwh-preview/askcompact/ask-compact.png): a `(Recommended) ` prefix
 * is stripped from the VISIBLE label and rendered as a small 「推荐」 tag instead. The answer
 * value is untouched — inputs, selections and the submitted payload all keep the ORIGINAL
 * label string (the prefix is presentation-only).
 */
const RECOMMENDED_PREFIX = /^\(Recommended\)\s+/i;
const optionViews = computed(() =>
  options.value.map((opt) => {
    const m = RECOMMENDED_PREFIX.exec(opt.label);
    return { opt, text: m === null ? opt.label : opt.label.slice(m[0].length), recommended: m !== null };
  }),
);

const index = computed(() => (form ? form.questions.indexOf(props.question) : -1));

// Local fallback when mounted without a form context (isolated tests).
const fallback: AskSelection = { selected: [], other: null };
const selection = computed<AskSelection>(() => {
  const i = index.value;
  if (!form || i < 0) return fallback;
  return form.selections[i] ?? fallback;
});

const inputName = computed(() => `ask-q-${index.value}`);

// --- compact: long context collapses to 2 lines behind an 「展开/收起」 toggle ------------
// The toggle also un-clamps the option descriptions (one switch for "show me everything").
// Multi-question forms keep inactive tabs mounted under `v-show` (display:none), where every
// box measures 0×0 — so a one-shot onMounted measurement missed every non-first tab and the
// toggle never appeared there. A ResizeObserver on the fieldset re-measures whenever the
// question becomes visible or reflows.
const rootEl = ref<HTMLElement | null>(null);
const contextEl = ref<HTMLElement | null>(null);
const contextOpen = ref(false);
const contextLong = ref(false);

function overflows(el: Element): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}

function measureContext(): void {
  // Measured only while the 2-line clamps apply; once expanded the toggle must stay reachable.
  if (contextOpen.value) return;
  const ctx = contextEl.value;
  const descs = rootEl.value?.querySelectorAll(".ask-option-desc") ?? [];
  let long = ctx !== null && overflows(ctx);
  for (const d of descs) if (overflows(d)) long = true;
  contextLong.value = long;
}

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  void nextTick(measureContext);
  if (typeof ResizeObserver === "function" && rootEl.value !== null) {
    resizeObserver = new ResizeObserver(() => measureContext());
    resizeObserver.observe(rootEl.value);
  }
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
});
watch(
  () => question.value.context,
  () => {
    contextOpen.value = false;
    void nextTick(measureContext);
  },
);

// --- compact: the Other free-text input hides behind a 「✎ 其它回答…」 link ----------------
const otherInputEl = ref<HTMLInputElement | null>(null);
// A restored non-empty draft keeps the input open; typing (any source) opens it too.
const otherOpen = ref((selection.value.other ?? "") !== "");
watch(
  () => selection.value.other,
  (val) => {
    if ((val ?? "") !== "") otherOpen.value = true;
  },
);

function revealOther(): void {
  otherOpen.value = true;
  void nextTick(() => otherInputEl.value?.focus());
}

function setSelected(next: string[]): void {
  const i = index.value;
  if (!form || i < 0 || form.suspended.value) return;
  // Picking an option retracts a skip (the fresh slot object simply drops `skipped`).
  form.selections[i] = { selected: next, other: selection.value.other };
  form.saveDraft();
}

function setOther(text: string): void {
  const i = index.value;
  if (!form || i < 0 || form.suspended.value) return;
  // Typing an Other answer retracts a skip too.
  form.selections[i] = { selected: selection.value.selected, other: text };
  form.saveDraft();
}

/** Per-question skip (「我可以不回答这个问题」): mark the question deliberately unanswered.
 *  Toggling off leaves the question blank again (the skip had cleared selected/other). */
function onSkipToggle(): void {
  const i = index.value;
  if (!form || i < 0 || form.suspended.value) return;
  if (selection.value.skipped === true) {
    form.selections[i] = { selected: [], other: null };
    form.saveDraft();
    return;
  }
  // Snapshot BEFORE the mutation — same first-answer/revision rule as onRadio: skipping an
  // already-answered question is a revision and must not yank the user to another tab.
  const wasAnswered = form.isAnswered(i);
  form.selections[i] = { selected: [], other: null, skipped: true };
  form.saveDraft();
  form.onAnswered?.(i, wasAnswered);
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
  <fieldset
    ref="rootEl"
    class="ask-question"
    :class="{ 'ask-skipped': selection.skipped === true, 'ask-question--expanded': contextOpen }"
    :disabled="form?.suspended.value === true"
  >
    <legend class="ask-question-text">{{ question.question }}</legend>
    <p v-if="question.context" ref="contextEl" class="ask-context" :class="{ 'ask-context--clamped': !contextOpen }">
      {{ question.context }}
    </p>
    <button
      v-if="contextLong"
      type="button"
      class="ask-context-toggle"
      data-context-toggle
      :aria-expanded="contextOpen"
      @click="contextOpen = !contextOpen"
    >
      {{ contextOpen ? t("dialog.contextCollapse") : t("dialog.contextExpand") }}
    </button>
    <div class="ask-options">
      <label v-for="view in optionViews" :key="view.opt.label" class="ask-option">
        <input
          v-if="multi"
          type="checkbox"
          :name="inputName"
          :value="view.opt.label"
          :checked="isChecked(view.opt.label)"
          @change="onToggle(view.opt.label, $event)"
        />
        <input
          v-else
          type="radio"
          :name="inputName"
          :value="view.opt.label"
          :checked="isChecked(view.opt.label)"
          @change="onRadio(view.opt.label)"
        />
        <span class="ask-option-text">
          <span class="ask-option-label">
            {{ view.text }}<span v-if="view.recommended" class="ask-reco-tag">{{ t("dialog.recommendedTag") }}</span>
          </span>
          <span v-if="view.opt.description" class="ask-option-desc" :title="view.opt.description">
            {{ view.opt.description }}
          </span>
        </span>
      </label>
    </div>
    <input
      v-if="showOther && otherOpen"
      ref="otherInputEl"
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
    <div class="ask-skip-row">
      <button
        v-if="showOther && !otherOpen"
        type="button"
        class="ask-other-link"
        data-other-link
        :disabled="form?.suspended.value === true"
        @click="revealOther"
      >
        {{ t("dialog.otherReveal") }}
      </button>
      <button
        type="button"
        class="btn btn-ghost ask-skip"
        data-skip
        :aria-pressed="selection.skipped === true"
        :aria-label="t('dialog.skipAria')"
        :disabled="form?.suspended.value === true"
        @click="onSkipToggle"
      >
        {{ selection.skipped === true ? t("dialog.skippedMark") : t("dialog.skip") }}
      </button>
      <span v-if="selection.skipped === true" class="ask-skipped-note">{{ t("dialog.skippedNote") }}</span>
    </div>
  </fieldset>
</template>
