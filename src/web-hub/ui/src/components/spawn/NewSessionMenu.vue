<!--
  NewSessionMenu — the sidebar's split "New session" button (web-hub-spawn plan SP12 / arch
  §9.1; 2026-10 redesign). Pure presentation + event forwarding over `@logic/spawn.js`'s
  `newSessionActions` output (SP11): the parent (AgentList) computes the `NewSessionAction[]`
  and executes the picked one; this component never re-derives enablement itself.

  - Main button = managed spawn in the SELECTED session's cwd (the `spawn-cwd` action; the
    parent opens DirPicker prefilled, which drives `useNewSession` incl. the 409 confirm flow).
    With no selection it falls back to `pick-dir` (blank DirPicker). It is never hidden and
    never disabled for capability reasons — when spawn is unavailable the click still emits the
    action and the parent shows an inline how-to-enable hint; `busy` (the `/new` round-trip)
    is the only disabled state.
  - The caret toggle (`aria-haspopup="menu"`) opens a `role="menu"` dropdown: 「替换当前会话
    （/new）」 (the old main-button action, `same-cwd` — the parent runs it behind an inline
    confirm) plus 「选择目录新建…」 (`pick-dir`, arch §8.3: `reason:"unavailable"` ⇒ HIDDEN;
    a denied policy shows it disabled with its reason). The toggle exists while any menu item
    is renderable.
  - Keyboard: Enter/Space activate natively; ArrowDown on the closed toggle opens and focuses
    the first enabled item; ArrowUp/ArrowDown cycle focus between enabled items; Escape closes
    and returns focus to the toggle. Outside click closes. No timers, no rAF.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { spawnDeniedKey, type NewSessionAction } from "../../logic/spawn.js";
import "../../styles/spawn.css";

const props = defineProps<{
  /** `newSessionActions(...)` output — spawn-cwd/same-cwd omitted without a selected agent. */
  readonly actions: readonly NewSessionAction[];
  /** `/new` runCommand round-trip in flight — gates the main button and the replace item. */
  readonly busy?: boolean;
}>();
const emit = defineEmits<{
  /** The user picked an action (main button ⇒ spawn-cwd, or pick-dir without a selection). */
  select: [action: NewSessionAction];
  /** The dropdown opened — the parent refreshes the spawn policy (`list()`). */
  open: [];
}>();
const { t } = useI18n();

const spawnCwd = computed(() => props.actions.find((a) => a.kind === "spawn-cwd"));
const sameCwd = computed(() => props.actions.find((a) => a.kind === "same-cwd"));
const pickDir = computed(() => props.actions.find((a) => a.kind === "pick-dir"));
/** arch §8.3: a 404/unavailable pick-dir is hidden, not shown disabled. */
const pickDirVisible = computed(() => {
  const a = pickDir.value;
  return a !== undefined && a.kind === "pick-dir" && a.reason !== "unavailable";
});
/** The dropdown renders while either item is renderable (same-cwd needs a selected agent). */
const menuAvailable = computed(() => sameCwd.value !== undefined || pickDirVisible.value);

const pickDirReason = computed(() => {
  const a = pickDir.value;
  if (a === undefined || a.kind !== "pick-dir" || a.enabled || a.reason === undefined) return null;
  return t(spawnDeniedKey(a.reason));
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
  if (props.busy === true) return;
  // Selected agent ⇒ managed spawn in its cwd; none ⇒ the pick-dir flow (blank DirPicker).
  // Enablement is the parent's call — a disabled action still emits so it can show the hint.
  const a = spawnCwd.value ?? pickDir.value;
  if (a !== undefined) emit("select", a);
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
  if (ev.key === "ArrowDown" && !open.value && menuAvailable.value) {
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
      :disabled="busy === true"
      :aria-label="t('agents.newSessionAria')"
      @click="onMainClick"
    >
      {{ t("agents.newSession") }}
    </button>
    <button
      v-if="menuAvailable"
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
        {{ t("spawn.itemSameCwd") }}
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
