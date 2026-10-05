<!--
  NewSessionMenu — the sidebar's split "New session" button (web-hub-spawn plan SP12 / arch
  §9.1). Pure presentation + event forwarding over `@logic/spawn.js`'s `newSessionActions`
  output (SP11): the parent (AgentList) computes the `NewSessionAction[]` and executes the
  picked one; this component never re-derives enablement itself.

  - Main button keeps the pre-SP12 contract byte-for-byte: same `.new-session-btn` class, same
    label/aria keys (`agents.newSession*`), same disabled semantics — clicking it selects the
    `same-cwd` action (the `/new` rerun against the selected agent).
  - The caret toggle (`aria-haspopup="menu"`) opens a `role="menu"` dropdown. The pick-dir
    item follows arch §8.3: `reason:"unavailable"` (hub without `spawn.v1`, GET 404, error, or
    not-yet-fetched) ⇒ HIDDEN, never shown disabled; a denied policy shows the item disabled
    with its reason. The toggle itself only exists while the pick-dir item is visible — a
    one-item menu that duplicates the main button is never rendered.
  - Keyboard: Enter/Space activate natively; ArrowDown on the closed toggle opens and focuses
    the first enabled item; ArrowUp/ArrowDown cycle focus between enabled items; Escape closes
    and returns focus to the toggle. Outside click closes. No timers, no rAF.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { NewSessionAction } from "../../logic/spawn.js";
import "../../styles/spawn.css";

const props = defineProps<{
  /** `newSessionActions(...)` output (SP11) — same-cwd omitted without a selected agent. */
  readonly actions: readonly NewSessionAction[];
  /** same-cwd in flight (the `/new` runCommand round-trip) — gates the main button. */
  readonly busy?: boolean;
  /** Selected agent's short cwd, for the same-cwd menu label. */
  readonly shortCwd?: string | undefined;
}>();
const emit = defineEmits<{
  /** The user picked an action (main button ⇒ same-cwd; menu item ⇒ that action). */
  select: [action: NewSessionAction];
  /** The dropdown opened — the parent refreshes the spawn policy (`list()`). */
  open: [];
}>();
const { t } = useI18n();

const sameCwd = computed(() => props.actions.find((a) => a.kind === "same-cwd"));
const pickDir = computed(() => props.actions.find((a) => a.kind === "pick-dir"));
/** arch §8.3: a 404/unavailable pick-dir is hidden, not shown disabled. */
const pickDirVisible = computed(() => {
  const a = pickDir.value;
  return a !== undefined && a.kind === "pick-dir" && a.reason !== "unavailable";
});

const mainDisabled = computed(() => sameCwd.value === undefined || !sameCwd.value.enabled || props.busy === true);

const sameCwdLabel = computed(() =>
  props.shortCwd !== undefined && props.shortCwd !== ""
    ? t("spawn.itemSameCwd", { cwd: props.shortCwd })
    : t("spawn.itemSameCwdNoCwd"),
);

const DENIED_KEYS: Record<string, string> = {
  platform: "spawn.deniedPlatform",
  launcher: "spawn.deniedLauncher",
  persist: "spawn.deniedPersist",
  reaper: "spawn.deniedReaper",
  cooldown: "spawn.deniedCooldown",
  breaker: "spawn.deniedBreaker",
};
const pickDirReason = computed(() => {
  const a = pickDir.value;
  if (a === undefined || a.kind !== "pick-dir" || a.enabled || a.reason === undefined) return null;
  const key = DENIED_KEYS[a.reason];
  return key !== undefined ? t(key) : t("spawn.deniedUnknown");
});

// ---------------------------------------------------------------------------
// dropdown open/close + focus management
// ---------------------------------------------------------------------------
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

function enabledItems(): HTMLButtonElement[] {
  const root = rootEl.value;
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLButtonElement>(".nsmenu-item:not(:disabled)")];
}

async function openMenu(focusFirst: boolean): Promise<void> {
  if (open.value) return;
  open.value = true;
  emit("open");
  if (focusFirst) {
    await nextTick();
    enabledItems()[0]?.focus();
  }
}

function closeMenu(refocusToggle: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocusToggle) rootEl.value?.querySelector<HTMLButtonElement>(".nsmenu-toggle")?.focus();
}

function onToggleClick(): void {
  if (open.value) closeMenu(false);
  else void openMenu(true);
}

function onMainClick(): void {
  const a = sameCwd.value;
  if (a !== undefined && a.enabled && props.busy !== true) emit("select", a);
}

function onItemClick(action: NewSessionAction): void {
  if (action.kind === "pick-dir" && !action.enabled) return;
  if (action.kind === "same-cwd" && (!action.enabled || props.busy === true)) return;
  closeMenu(false);
  emit("select", action);
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closeMenu(true);
    return;
  }
  if (ev.key === "ArrowDown" && !open.value && pickDirVisible.value) {
    ev.preventDefault();
    void openMenu(true);
    return;
  }
  if (!open.value) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const items = enabledItems();
    if (items.length === 0) return;
    const idx = items.findIndex((el) => el === document.activeElement);
    const next =
      idx < 0
        ? ev.key === "ArrowDown"
          ? 0
          : items.length - 1
        : (idx + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
}

function onDocClick(ev: Event): void {
  const root = rootEl.value;
  if (root !== null && !root.contains(ev.target as Node)) closeMenu(false);
}

watch(open, (v) => {
  if (typeof document === "undefined") return;
  if (v) document.addEventListener("click", onDocClick, true);
  else document.removeEventListener("click", onDocClick, true);
});
onBeforeUnmount(() => {
  if (typeof document !== "undefined") document.removeEventListener("click", onDocClick, true);
});
</script>

<template>
  <span ref="rootEl" class="nsmenu" @keydown="onKeydown">
    <button
      class="btn btn-ghost btn-xs new-session-btn"
      type="button"
      :disabled="mainDisabled"
      :aria-label="t('agents.newSessionAria')"
      @click="onMainClick"
    >
      {{ t("agents.newSession") }}
    </button>
    <button
      v-if="pickDirVisible"
      class="btn btn-ghost btn-xs nsmenu-toggle"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="t('spawn.menuToggleAria')"
      @click="onToggleClick"
    >
      <AppIcon name="arrow-down" class="icon-sm" />
    </button>
    <div v-if="open" class="nsmenu-menu" role="menu" :aria-label="t('spawn.menuAria')">
      <button
        v-if="sameCwd"
        class="nsmenu-item"
        type="button"
        role="menuitem"
        :disabled="!sameCwd.enabled || busy === true"
        @click="onItemClick(sameCwd)"
      >
        {{ sameCwdLabel }}
      </button>
      <button
        v-if="pickDir && pickDirVisible"
        class="nsmenu-item"
        type="button"
        role="menuitem"
        :disabled="!pickDir.enabled"
        @click="onItemClick(pickDir)"
      >
        <span>{{ t("spawn.itemPickDir") }}</span>
        <span v-if="pickDirReason" class="nsmenu-item-reason">{{ pickDirReason }}</span>
      </button>
    </div>
  </span>
</template>
