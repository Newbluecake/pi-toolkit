<!--
  Bottom-sheet shell (web-model-switch plan v2 §5.1, package M3b — #16). Teleports to `<body>`
  and hosts a chip's picker on ≤640px viewports; shared by the model chip and the thinking
  chip (both decide sheet-vs-popover by viewport, `(pointer: coarse)` only raises hit areas).

  Interaction contract mirrors `preview/PreviewHost.vue:69-122`:
  - scrim click closes (`@click.self` — clicks INSIDE the panel never reach it);
  - Esc closes with `preventDefault()` + `stopPropagation()`;
  - focus ENTERS on open: the `[data-autofocus]` element inside the panel when the content
    marks one (the listbox — the sheet's search box must NOT steal focus and pop the mobile
    keyboard, §5.1/A10), otherwise the panel itself;
  - Tab/Shift+Tab CYCLE inside the panel; focus RETURNS to the previously focused element;
  - body scroll is locked while open and ALWAYS restored — the sheet only exists while open
    (parent `v-if`), so close and unmount are the same path and `onUnmounted` covers both.

  The parent's keydown listener (list ↑↓/Enter/Esc navigation) arrives through `$attrs` and
  lands on the scrim alongside the sheet's own handler — content keydowns bubble up to it.
-->
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";

defineOptions({ inheritAttrs: false });
defineProps<{ label: string }>();
const emit = defineEmits<{ close: [] }>();

const panelEl = ref<HTMLElement | null>(null);
let returnFocus: Element | null = null;
let releaseScrollLock: (() => void) | null = null;

onMounted(async () => {
  returnFocus = document.activeElement;
  // Shared ref-counted lock (useScrollLock.ts): composes with PreviewHost's lock when the
  // two overlays stack — only the LAST release restores the original overflow.
  releaseScrollLock = acquireBodyScrollLock();
  await nextTick();
  const panel = panelEl.value;
  if (panel === null) return;
  const marked = panel.querySelector<HTMLElement>("[data-autofocus]");
  (marked ?? panel).focus();
});

onUnmounted(() => {
  // 滚动锁一定会清理 — the sheet only lives while open, so this covers BOTH the close path
  // and a mid-open unmount (session switch, dock branch flip). Idempotent release.
  releaseScrollLock?.();
  releaseScrollLock = null;
  const target = returnFocus;
  returnFocus = null;
  if (target instanceof HTMLElement && document.contains(target)) target.focus();
});

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(ev: KeyboardEvent): void {
  const panel = panelEl.value;
  if (panel === null) return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    ev.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = active === null || !panel.contains(active);
  if (ev.shiftKey && (outside || active === first)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (outside || active === last)) {
    ev.preventDefault();
    first.focus();
  }
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    // the sheet owns Esc while open — a global handler must not also fire.
    ev.preventDefault();
    ev.stopPropagation();
    emit("close");
    return;
  }
  if (ev.key === "Tab") trapTab(ev);
}
</script>

<template>
  <Teleport to="body">
    <div class="picker-scrim" v-bind="$attrs" @click.self="emit('close')" @keydown="onKeydown">
      <div ref="panelEl" class="picker-sheet" role="dialog" aria-modal="true" :aria-label="label" tabindex="-1">
        <slot />
      </div>
    </div>
  </Teleport>
</template>
