<!--
  PreviewWindowMenu.vue — web-hub-preview-windows plan r2 §5.5 (W2): the「⋯」window menu in
  each preview window's header. Replaces the modal-era "click the scrim to close everything"
  affordance (用户拍板 3): a `role="menu"` popover with 「全部关闭（N）」, 「重置位置和大小」
  (desktop only) and the window list (basename — path; the current window carries
  `aria-current`; selecting calls `focusWindow(id, {moveFocus:true})` — 提到最前 + 转移焦点).

  Keyboard model mirrors `shell/LangMenu.vue` / `spawn/NewSessionMenu.vue` (评审 #12): the
  trigger is a plain button with `aria-haspopup="menu"` + `aria-expanded`; Enter/Space/↓ open
  and focus the first item, ↑↓ cycle with wrap-around, Esc closes the MENU ONLY and returns
  focus to the trigger (stopPropagation so the window's own Esc never fires), Tab closes, and
  an outside pointerdown (capture phase — fires before the browser's focus-steal) closes it.
  No timers, no rAF.
-->
<script lang="ts">
/** One window-list entry — the host precomputes the display fields. */
export interface PreviewWindowMenuItem {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly current: boolean;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";

const props = defineProps<{
  /** Creation order (stable — same order as the DOM windows). */
  readonly items: readonly PreviewWindowMenuItem[];
  /** The 「重置位置和大小」 item renders on desktop only (§5.5). */
  readonly showReset: boolean;
  /** The 「最大化/恢复」 item (2026-10-22 L1) — desktop only, like `showReset`. */
  readonly showMaximize: boolean;
  /** This window's current maximize state — flips the item's label 最大化 ⇄ 恢复. */
  readonly maximized: boolean;
}>();

const emit = defineEmits<{
  (e: "close-all"): void;
  (e: "reset"): void;
  (e: "toggle-maximize"): void;
  (e: "select", id: number): void;
}>();

const { t } = useI18n();
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);

function menuItems(): HTMLButtonElement[] {
  const root = rootEl.value;
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLButtonElement>(".pw-menu-item")];
}

async function openMenu(): Promise<void> {
  if (open.value) return;
  open.value = true;
  await nextTick();
  menuItems()[0]?.focus();
}

function closeMenu(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocus) triggerEl.value?.focus();
}

function onTriggerClick(): void {
  if (open.value) closeMenu(false);
  else void openMenu();
}

function onTriggerKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault(); // Space would otherwise re-click the trigger
    void openMenu();
  }
}

/** Esc closes the menu only — stopPropagation keeps the WINDOW open (§5.5). */
function onMenuKeydown(ev: KeyboardEvent): void {
  const items = menuItems();
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeMenu(true);
    return;
  }
  if (ev.key === "Tab") {
    closeMenu(false);
    return;
  }
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (items.length === 0) return;
    const next =
      ev.key === "ArrowDown"
        ? items[(idx + 1 + items.length) % items.length]!
        : items[(idx - 1 + items.length) % items.length]!;
    next.focus();
  }
}

function run(fn: () => void): void {
  closeMenu(true);
  fn();
}

/** Outside close — capture phase so it wins the browser's default focus-steal. */
function onOutsidePointerdown(ev: PointerEvent): void {
  if (open.value && rootEl.value !== null && ev.target instanceof Node && !rootEl.value.contains(ev.target)) {
    closeMenu(false);
  }
}

document.addEventListener("pointerdown", onOutsidePointerdown, true);
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onOutsidePointerdown, true);
});

defineExpose({ closeMenu });
</script>

<template>
  <div ref="rootEl" class="pw-menu-anchor">
    <button
      ref="triggerEl"
      class="btn btn-ghost btn-icon pw-menu-btn"
      type="button"
      :aria-label="t('preview.windowMenu')"
      :title="t('preview.windowMenu')"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-no-drag
      @click="onTriggerClick"
      @keydown="onTriggerKeydown"
    >
      <span class="pw-menu-dots" aria-hidden="true">⋯</span>
    </button>
    <div v-if="open" class="pw-menu" role="menu" :aria-label="t('preview.windowMenu')" @keydown="onMenuKeydown">
      <button class="pw-menu-item" type="button" role="menuitem" @click="run(() => emit('close-all'))">
        {{ t("preview.windowCloseAll", { n: items.length }) }}
      </button>
      <button v-if="showReset" class="pw-menu-item" type="button" role="menuitem" @click="run(() => emit('reset'))">
        {{ t("preview.windowResetGeom") }}
      </button>
      <!-- 2026-10-22 L1 拍板: the maximize/restore entry — desktop only; the LABEL carries the
           current state (「恢复窗口大小」 while maximized), mirroring the header button. -->
      <button
        v-if="showMaximize"
        class="pw-menu-item"
        type="button"
        role="menuitem"
        @click="run(() => emit('toggle-maximize'))"
      >
        {{ maximized ? t("preview.windowRestore") : t("preview.windowMaximize") }}
      </button>
      <div v-if="items.length > 0" class="pw-menu-sep" role="separator" aria-hidden="true"></div>
      <button
        v-for="w in items"
        :key="w.id"
        class="pw-menu-item pw-menu-window"
        type="button"
        role="menuitem"
        :aria-current="w.current ? 'true' : undefined"
        :title="w.path"
        @click="run(() => emit('select', w.id))"
      >
        <span class="pw-menu-name" translate="no">{{ w.name }}</span>
        <span class="pw-menu-path" translate="no">{{ w.path }}</span>
      </button>
    </div>
  </div>
</template>
