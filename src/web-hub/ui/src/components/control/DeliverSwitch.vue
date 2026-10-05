<!--
  Delivery-mode switch (control-plan.md v2.1 §7.4/§7.5 — C5). Shown by the composer only while
  the agent is busy: Steer = 插话当前轮 (default), Follow-up = 排到之后. 2026-10-05 (user field
  report): custom dropdown menu, NOT a native <select> — Android Chrome renders a native select
  as a full-screen OS picker dialog, which the user rejected; the menu expands upward inline
  (the composer hugs the screen's bottom edge). Menu semantics mirror shell/ThemeToggle.vue:
  aria-haspopup="menu"/aria-expanded, ArrowDown/ArrowUp cycle, Enter/Space selects, Escape
  closes and refocuses the trigger, outside click closes. No timers, no rAF.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { DeliverSwitchEmits, DeliverSwitchProps } from "../../contracts.js";

type DeliverMode = "steer" | "followUp";

const props = defineProps<DeliverSwitchProps>();
const emit = defineEmits<DeliverSwitchEmits>();
const { t } = useI18n();

const OPTIONS: readonly { value: DeliverMode; labelKey: string }[] = [
  { value: "steer", labelKey: "control.deliverSteer" },
  { value: "followUp", labelKey: "control.deliverFollowUp" },
];

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);

const currentLabel = computed(() =>
  t(OPTIONS.find((o) => o.value === props.modelValue)?.labelKey ?? "control.deliverSteer"),
);

function closeMenu(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocus) trigger.value?.focus();
}

function choose(value: DeliverMode): void {
  emit("update:modelValue", value);
  closeMenu(true);
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLButtonElement>(".deliver-menu button") ?? []);
}

function onTriggerKeydown(ev: KeyboardEvent): void {
  if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && !open.value) {
    ev.preventDefault();
    open.value = true;
    void Promise.resolve().then(() => menuItems()[0]?.focus());
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

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return;
  if (root.value !== null && ev.target instanceof Node && !root.value.contains(ev.target)) closeMenu(false);
}

watch(open, (v) => {
  if (v) document.addEventListener("click", onDocClick, true);
  else document.removeEventListener("click", onDocClick, true);
});
onBeforeUnmount(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <span v-if="!busy" class="deliver-idle">{{ t("control.idleHint") }}</span>
  <span v-else ref="root" class="deliver-wrap">
    <button
      ref="trigger"
      type="button"
      class="deliver-trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="`${t('control.deliverGroup')}: ${currentLabel}`"
      @click="open = !open"
      @keydown="onTriggerKeydown"
    >
      <span class="deliver-current">{{ currentLabel }}</span>
      <AppIcon name="chev-down" class="icon-sm deliver-caret" />
    </button>
    <span v-if="open" class="deliver-menu" role="menu" :aria-label="t('control.deliverGroup')" @keydown="onMenuKeydown">
      <button
        v-for="o in OPTIONS"
        :key="o.value"
        type="button"
        role="menuitemradio"
        :aria-checked="modelValue === o.value"
        class="deliver-item"
        @click="choose(o.value)"
      >
        <span class="deliver-item-label">{{ t(o.labelKey) }}</span>
        <AppIcon v-if="modelValue === o.value" name="check" class="icon-sm deliver-item-check" />
      </button>
    </span>
  </span>
</template>
