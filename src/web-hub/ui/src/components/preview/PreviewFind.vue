<!--
  PreviewFind.vue — the in-window find bar (preview-perf P3, plan r3 §4.6). Pure presentation
  + input handling: the ENGINE (incremental search, current-hit anchor) and the RANGE
  painting (Custom Highlight manager) live in PreviewText, which owns the virtual source.
  This component carries:

  - the query input (newlines/CR are stripped on input — a one-line find must never produce
    multi-line hits, which keeps the hit→DOM-range mapping line-local) with `focusSelect()`
    exposed for the Ctrl+F entry (「打开或聚焦查找框（全选输入）」);
  - the keys: Enter / Shift+Enter, F3 / Shift+F3, Ctrl(⌘)+G / Shift+Ctrl(⌘)+G = next/prev
    (all preventDefault so the browser's own find-again never fires); Enter during IME
    composition (isComposing / keyCode 229) is ignored entirely; Esc preventDefaults AND
    stopPropagation's so PreviewHost's window-closing Esc (which checks defaultPrevented)
    never fires — only the bar closes;
  - the count live region (`role=status`): "cur / n" (n as "10000+" when capped), "无结果"
    for a miss; plus the beyond-display annotation when the current hit sits in a clipped
    line's hidden tail (§4.6「超出显示部分」);
  - the standing scope note (one gray line): what the bar searches (the file's LOADED
    content), the key hints (⌘G / ⇧⌘G on Mac), and that the browser's own page find only
    sees the currently visible lines.

  Styling is deliberately CSSOM-only: `<style>` blocks are banned (source-scan) and no CSS
  file belongs to this package's domain, so the bar's few layout rules ride object `:style`
  bindings (the CSP-clean form `probe:csp` verified) + the shared `btn btn-ghost btn-icon`
  classes.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{
  /** The raw query as typed (already newline-stripped by this component on emit). */
  readonly query: string;
  /** Case-sensitive toggle state (owner: PreviewText). */
  readonly caseSensitive: boolean;
  /** Current hit count (never exceeds the 10 000 cap; `more` marks the truncation). */
  readonly count: number;
  /** 1-based index of the current hit; 0 when none is selected. */
  readonly current: number;
  /** true when the greedy search hit the 10 000 cap and at least one more hit exists. */
  readonly more: boolean;
  /** true while a non-empty query is armed (drives the "no result" vs empty state). */
  readonly hasQuery: boolean;
  /** true when the current hit extends past its line's display cut (§4.6 截断区命中). */
  readonly beyondDisplay: boolean;
}>();

const emit = defineEmits<{
  (e: "update:query", value: string): void;
  (e: "update:caseSensitive", value: boolean): void;
  (e: "next"): void;
  (e: "prev"): void;
  (e: "close"): void;
}>();

const { t } = useI18n();
const inputEl = ref<HTMLInputElement | null>(null);

const isMac = computed((): boolean => {
  try {
    if (typeof navigator === "undefined") return false;
    return /mac/i.test(navigator.platform ?? navigator.userAgent ?? "");
  } catch {
    return false;
  }
});

const countText = computed((): string => {
  if (!props.hasQuery) return "";
  if (props.count === 0) return t("preview.findNoHit");
  return `${props.current} / ${props.count}${props.more ? "+" : ""}`;
});

/** Ctrl+F entry contract: focus the input AND select its text (§4.6 全选输入). */
function focusSelect(): void {
  const el = inputEl.value;
  if (el === null) return;
  el.focus();
  el.select();
}

function onInput(ev: Event): void {
  const raw = (ev.target as HTMLInputElement).value;
  // A one-line find: CR/LF are stripped so hits stay line-local (range building, §4.6).
  const clean = raw.replace(/\r|\n/g, "");
  if (clean !== raw) (ev.target as HTMLInputElement).value = clean;
  emit("update:query", clean);
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.isComposing || ev.keyCode === 229) return; // IME composition: every key ignored
  const nav = (shift: boolean): void => {
    if (shift) emit("prev");
    else emit("next");
  };
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === "Enter") {
    ev.preventDefault();
    nav(ev.shiftKey);
    return;
  }
  if (ev.key === "F3") {
    ev.preventDefault();
    nav(ev.shiftKey);
    return;
  }
  if (mod && !ev.altKey && (ev.key === "g" || ev.key === "G")) {
    ev.preventDefault();
    nav(ev.shiftKey);
    return;
  }
  if (ev.key === "Escape") {
    // Only the bar closes; the window survives (PreviewHost's Esc checks defaultPrevented).
    ev.preventDefault();
    ev.stopPropagation();
    emit("close");
  }
}

defineExpose({ focusSelect });
</script>

<template>
  <div
    class="pv-find"
    role="search"
    :aria-label="t('preview.findLabel')"
    :style="{
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '6px',
      margin: '0 0 6px',
    }"
  >
    <input
      ref="inputEl"
      class="pv-find-input"
      type="text"
      :value="query"
      :placeholder="t('preview.findPlaceholder')"
      :aria-label="t('preview.findLabel')"
      :style="{
        flex: '1 1 10em',
        minWidth: '8em',
        maxWidth: '24em',
        padding: '2px 8px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--c-text-1)',
        background: 'var(--c-surface)',
        border: '1px solid var(--c-border)',
        borderRadius: '4px',
      }"
      @input="onInput"
      @keydown="onKeydown"
    />
    <button
      type="button"
      class="btn btn-ghost btn-icon"
      :aria-pressed="caseSensitive ? 'true' : 'false'"
      :aria-label="t('preview.findCaseSensitive')"
      :title="t('preview.findCaseSensitive')"
      :style="{ fontFamily: 'var(--font-mono)', fontWeight: caseSensitive ? 700 : 400 }"
      @click="emit('update:caseSensitive', !caseSensitive)"
    >
      Aa
    </button>
    <span
      class="pv-find-count"
      role="status"
      aria-live="polite"
      :style="{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--c-text-2)',
        whiteSpace: 'nowrap',
      }"
      >{{ countText }}</span
    >
    <button
      type="button"
      class="btn btn-ghost btn-icon"
      :disabled="count === 0"
      :aria-label="t('preview.findPrev')"
      :title="t('preview.findPrev')"
      @click="emit('prev')"
    >
      <AppIcon name="chev-left" />
    </button>
    <button
      type="button"
      class="btn btn-ghost btn-icon"
      :disabled="count === 0"
      :aria-label="t('preview.findNext')"
      :title="t('preview.findNext')"
      @click="emit('next')"
    >
      <AppIcon name="chev-right" />
    </button>
    <button
      type="button"
      class="btn btn-ghost btn-icon"
      :aria-label="t('preview.findClose')"
      :title="t('preview.findClose')"
      @click="emit('close')"
    >
      <AppIcon name="x" />
    </button>
    <span v-if="beyondDisplay" :style="{ fontSize: 'var(--fs-sm)', color: 'var(--c-text-3)', width: '100%' }">{{
      t("preview.findBeyondDisplay")
    }}</span>
    <span class="pv-find-note" :style="{ width: '100%', fontSize: 'var(--fs-xs)', color: 'var(--c-text-3)' }">{{
      isMac ? t("preview.findScopeNoteMac") : t("preview.findScopeNote")
    }}</span>
  </div>
</template>
