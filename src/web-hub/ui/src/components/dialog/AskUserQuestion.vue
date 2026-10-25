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
import PathText from "../preview/PathText.vue";

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
  // 2026-10-24 复验 blocker (双向互斥): single-select — picking an option CLEARS a typed
  // Other (TUI parity: component.ts's confirm sets freeTextValue=null). The DESELECT path
  // (next empty) deliberately keeps Other — cancelling a mis-click must not eat typed text.
  const other = !multi.value && next.length > 0 ? null : selection.value.other;
  // Picking an option retracts a skip (the fresh slot object simply drops `skipped`).
  form.selections[i] = { selected: next, other };
  form.saveDraft();
}

function setOther(text: string): void {
  const i = index.value;
  if (!form || i < 0 || form.suspended.value) return;
  // Typing an Other answer retracts a skip too.
  // 2026-10-24 bug fix (单选误点无法撤销): single-select — a NON-EMPTY Other clears the picked
  // option (option ⟂ Other are mutually exclusive; the wire would otherwise send BOTH —
  // encodeAnswer emits `key` = selected[0] plus `key__other`). 复验 #2: the emptiness check
  // trims (TUI parity: component.ts confirms `draftText.trim()`), so whitespace-only text
  // does NOT clear the option. Clearing the Other text does NOT resurrect the old option.
  // multiSelect keeps the legacy coexistence.
  const selected =
    !multi.value && text.trim() !== "" && selection.value.selected.length > 0 ? [] : selection.value.selected;
  form.selections[i] = { selected, other: text };
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

/**
 * Clicking a path/proxy ref INSIDE an option row must never toggle the option (user ruling
 * 2026-10-24 — ask 对话框路径可预览). The ref span (`span.path-ref`/`span.proxy-ref`, an ARIA
 * button, not HTML interactive content) would otherwise let the <label>'s default activation
 * forward the click to the radio/checkbox. The PathText handler runs first at the span (opens
 * the preview synchronously), then the click bubbles to the label where preventDefault cancels
 * the label's default forwarding — no wrapper element needed, so the no-PREVIEW_CTX DOM stays
 * byte-identical.
 * 2026-10-24 验收裁定 (fix #2): the selector ALSO covers `.proxy-ref-note` — with `no-note`
 * set on these PathText instances the note never renders here, this is belt-and-braces. */
function onOptionClick(ev: MouseEvent): void {
  const target = ev.target;
  if (target instanceof Element && target.closest(".path-ref, .proxy-ref, .proxy-ref-note") !== null)
    ev.preventDefault();
}

function isChecked(label: string): boolean {
  return selection.value.selected.includes(label);
}

function onToggle(label: string, ev: Event): void {
  const checked = (ev.target as HTMLInputElement).checked;
  const cur = selection.value.selected;
  setSelected(multi.value ? (checked ? [...cur, label] : cur.filter((l) => l !== label)) : checked ? [label] : []);
}

/**
 * 2026-10-24 bug fix (单选误点无法撤销): clicking the ALREADY-SELECTED radio deselects it,
 * returning the question to unanswered. Native radios never fire `change` on a re-click, so
 * the toggle rides `click` directly; Space on the checked radio (natively a no-op there)
 * deselects too — keyboard parity. Deselecting NEVER calls form.onAnswered: the auto-advance
 * is a first-answer convenience, a deselect is the opposite of an answer (and re-picking
 * later keeps the existing first-answer/revision semantics untouched).
 *
 * 复验 #5 (Space 取消的稳定性): the Space path relies on keydown `preventDefault` to suppress
 * the activation's SYNTHETIC click. If a browser dispatches that click anyway, it would find
 * the option already unchecked and RE-SELECT it (undoing the deselect) — the `spaceDeselect`
 * marker makes exactly that one trailing click a no-op (matched by label, armed for 500 ms).
 * The marker is belt-and-braces; preventDefault is the primary mechanism. NOTE: keyboard
 * activation timing is browser-specific — worth a real-device manual check (Chrome/Firefox/
 * Safari Space on a checked radio).
 */
let spaceDeselect: { label: string; at: number } | null = null;

function onRadioToggle(label: string, ev: MouseEvent): void {
  if (spaceDeselect !== null && spaceDeselect.label === label && Date.now() - spaceDeselect.at < 500) {
    spaceDeselect = null; // one-shot: swallow exactly the Space-synthesized trailing click
    ev.preventDefault();
    return;
  }
  if (multi.value || !isChecked(label)) return; // unchecked: native click ⇒ change ⇒ onRadio
  ev.preventDefault(); // the checked flag is state-driven (`:checked`); undo the native re-assert
  setSelected([]);
}

function onRadioKeydown(label: string, ev: KeyboardEvent): void {
  if (ev.key !== " " || multi.value || !isChecked(label)) return;
  ev.preventDefault(); // native Space on a CHECKED radio is a no-op; make it deselect
  spaceDeselect = { label, at: Date.now() };
  setSelected([]);
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
    <legend class="ask-question-text"><PathText :text="question.question" /></legend>
    <p v-if="question.context" ref="contextEl" class="ask-context" :class="{ 'ask-context--clamped': !contextOpen }">
      <PathText :text="question.context" />
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
      <label v-for="view in optionViews" :key="view.opt.label" class="ask-option" @click="onOptionClick">
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
          @click="onRadioToggle(view.opt.label, $event)"
          @keydown="onRadioKeydown(view.opt.label, $event)"
        />
        <span class="ask-option-text">
          <span class="ask-option-label">
            <PathText :text="view.text" no-note /><span v-if="view.recommended" class="ask-reco-tag">{{
              t("dialog.recommendedTag")
            }}</span>
          </span>
          <span v-if="view.opt.description" class="ask-option-desc" :title="view.opt.description">
            <PathText :text="view.opt.description" no-note />
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
