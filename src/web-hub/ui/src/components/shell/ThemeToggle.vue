<!--
  Theme switcher as a dropdown (2026-10-05 user field report: the segmented radiogroup crowded the
  header, especially on phones). One ghost icon button showing the CURRENT theme opens a menu with
  all three options (check on the active one). Menu semantics mirror `spawn/NewSessionMenu.vue`:
  aria-haspopup="menu"/aria-expanded, ArrowDown opens + focuses the first item, ArrowUp/ArrowDown
  cycle focus, Enter/Space selects, Escape closes and refocuses the trigger, outside click closes.
  No timers, no rAF. Same dropdown at every width (the ≤480px cycle-button mode is retired).

  `useTheme()` (P1) owns the actual class/localStorage bookkeeping — this is purely the control
  that drives its `pref` ref two-way.
-->
<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import type { ThemeToggleEmits, ThemeToggleProps } from "../../contracts.js";
import type { ThemePref } from "../../types.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { IconName } from "../../icons/names.js";

const ICON_FOR: Record<ThemePref, IconName> = { system: "monitor", light: "sun", dark: "moon" };

const props = defineProps<ThemeToggleProps>();
const emit = defineEmits<ThemeToggleEmits>();
const { t } = useI18n();

const OPTIONS: readonly { value: ThemePref; labelKey: string }[] = [
  { value: "system", labelKey: "shell.theme.system" },
  { value: "light", labelKey: "shell.theme.light" },
  { value: "dark", labelKey: "shell.theme.dark" },
];

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);

function closeMenu(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocus) trigger.value?.focus();
}

function toggleMenu(): void {
  open.value = !open.value;
}

function choose(value: ThemePref): void {
  emit("update:modelValue", value);
  closeMenu(true);
}

function currentLabel(): string {
  return t(OPTIONS.find((o) => o.value === props.modelValue)?.labelKey ?? "shell.theme.system");
}

function onTriggerKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowDown" && !open.value) {
    ev.preventDefault();
    open.value = true;
    focusItem(0);
  } else if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closeMenu(true);
  }
}

function onMenuKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    closeMenu(true);
    return;
  }
  if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
  ev.preventDefault();
  const items = menuItems();
  if (items.length === 0) return;
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = ev.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
  items[next]?.focus();
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLButtonElement>(".theme-menu button") ?? []);
}

function focusItem(idx: number): void {
  // menu mounts on open — wait a tick for the DOM
  requestAnimationFrameSafe(() => menuItems()[idx]?.focus());
}

/** nextTick without rAF (repo rule: no requestAnimationFrame). */
function requestAnimationFrameSafe(fn: () => void): void {
  void Promise.resolve().then(fn);
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return;
  if (root.value !== null && ev.target instanceof Node && !root.value.contains(ev.target)) closeMenu(false);
}

import { watch } from "vue";
watch(open, (v) => {
  if (v) document.addEventListener("click", onDocClick, true);
  else document.removeEventListener("click", onDocClick, true);
});
onBeforeUnmount(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <div ref="root" class="theme-toggle">
    <button
      ref="trigger"
      type="button"
      class="btn btn-ghost btn-icon theme-trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="`${t('shell.theme.groupLabel')}: ${currentLabel()}`"
      :title="currentLabel()"
      @click="toggleMenu"
      @keydown="onTriggerKeydown"
    >
      <AppIcon :name="ICON_FOR[modelValue]" />
    </button>
    <div v-if="open" class="theme-menu" role="menu" :aria-label="t('shell.theme.groupLabel')" @keydown="onMenuKeydown">
      <button
        v-for="opt in OPTIONS"
        :key="opt.value"
        type="button"
        role="menuitemradio"
        :aria-checked="modelValue === opt.value"
        class="theme-menu-item"
        @click="choose(opt.value)"
      >
        <AppIcon :name="ICON_FOR[opt.value]" class="icon-sm" />
        <span class="theme-menu-label">{{ t(opt.labelKey) }}</span>
        <AppIcon v-if="modelValue === opt.value" name="check" class="icon-sm theme-menu-check" />
      </button>
    </div>
  </div>
</template>
