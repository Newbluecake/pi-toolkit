<!--
  HeaderOverflowMenu.vue — issue #41 (detail titlebar narrow-screen overflow): the 「⋯」
  overflow menu that receives the titlebar's low-frequency action buttons when the measured
  bar width can no longer keep the title at its 96px floor (fold decision: logic/headerFold.ts,
  measurement: DetailHeader.vue). Renders NOTHING but the trigger + (while open) the menu; the
  parent only mounts it when ≥1 button is folded, so a wide bar's DOM is byte-identical to the
  pre-feature markup.

  Trigger uses the 「⋯」 TEXT glyph (PreviewWindowMenu precedent — the P0-frozen IconSprite
  stays untouched). Keyboard model mirrors PreviewWindowMenu / LangMenu / NewSessionMenu:
  trigger is a plain button with aria-haspopup="menu" + aria-expanded; Enter/Space/↓ open and
  focus the first item, ↑↓ cycle with wrap-around, Esc closes the menu and refocuses the
  trigger (stopPropagation — the detail pane's own Esc handling never fires), Tab closes, an
  outside pointerdown (capture phase) closes. No timers, no rAF.
-->
<script lang="ts">
import type { IconName } from "../../icons/names.js";

/** One folded titlebar action — the parent precomputes icon/label per its own gating. */
export interface HeaderOverflowItem {
  readonly id: string;
  /** Action icon; omitted on the read-only note row (glyph-degraded alias, issue #41 a11y pass). */
  readonly icon?: IconName;
  readonly label: string;
  /** Read-only info row (not clickable, skipped by keyboard nav) — e.g. the full alias while the
   *  alias chip is degraded to a bare 「@」 glyph. */
  readonly note?: boolean;
  /** Danger styling (「停止会话」 — mirrors the in-bar button's danger hover). */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** In-flight action — renders disabled + aria-busy (e.g. 「清空」 while /new is running). */
  readonly busy?: boolean;
  /** Present ⇒ role="menuitemcheckbox" + aria-checked (the privacy mark's on/off state). */
  readonly checked?: boolean;
  /** The action opens a dialog (channels / schedules / resume pickers) ⇒ aria-haspopup="dialog". */
  readonly haspopupDialog?: boolean;
  /** Render a role="separator" divider above this item (the parent never sets it on row 0). */
  readonly separatorBefore?: boolean;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";

defineProps<{ readonly items: readonly HeaderOverflowItem[] }>();
const emit = defineEmits<{ (e: "run", id: string): void }>();

const { t } = useI18n();
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);

function menuItems(): HTMLButtonElement[] {
  const root = rootEl.value;
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLButtonElement>(".detail-head-menu-item")];
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

function onMenuKeydown(ev: KeyboardEvent): void {
  const items = menuItems();
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation(); // the detail pane's own Esc handling must not fire
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

function run(id: string, disabled: boolean | undefined): void {
  if (disabled) return;
  closeMenu(true);
  emit("run", id);
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
  <div ref="rootEl" class="detail-more-wrap">
    <button
      ref="triggerEl"
      class="detail-more-btn"
      type="button"
      :aria-label="t('detail.moreActions')"
      :title="t('detail.moreActions')"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="onTriggerClick"
      @keydown="onTriggerKeydown"
    >
      <span class="detail-more-dots" aria-hidden="true">⋯</span>
    </button>
    <div
      v-if="open"
      class="detail-head-menu"
      role="menu"
      :aria-label="t('detail.moreActions')"
      @keydown="onMenuKeydown"
    >
      <template v-for="item in items" :key="item.id">
        <div v-if="item.separatorBefore === true" class="detail-head-menu-sep" role="separator" />
        <div v-if="item.note === true" class="detail-head-menu-note" role="menuitem" aria-disabled="true" tabindex="-1">
          <span class="detail-head-menu-label">{{ item.label }}</span>
        </div>
        <button
          v-else
          class="detail-head-menu-item"
          :class="{ 'is-danger': item.danger === true }"
          type="button"
          :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          :aria-checked="item.checked"
          :aria-haspopup="item.haspopupDialog === true ? 'dialog' : undefined"
          :aria-busy="item.busy === true ? 'true' : undefined"
          :disabled="item.disabled === true || item.busy === true"
          @click="run(item.id, item.disabled === true || item.busy === true)"
        >
          <AppIcon
            v-if="item.icon !== undefined"
            :name="item.icon"
            class="icon"
            :class="{ spin: item.busy === true }"
          />
          <span class="detail-head-menu-label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </div>
</template>
