<!--
  Language dropdown menu (2026-10-10 user report: the old two-state toggle showed the TARGET
  language — "EN" while the UI was Chinese, "中文" while English — which read backwards). The
  trigger now shows the CURRENT language (compact 中 / EN + a `chev-down` glyph) and opens a
  `role="menu"` popover with one `menuitemradio` per language, each written in its OWN script
  (中文 / English — never translated; the i18n values are identical across dictionaries on
  purpose). Selecting reuses the exact persistence the toggle had (`setLangOverride`'s persisted
  `pwh_lang` key — every no-arg useI18n() handle re-renders reactively).

  Interaction model follows `spawn/NewSessionMenu.vue`'s dropdown pattern (root-span keydown
  delegation, wrap-around arrows, capture-phase outside close) with the radio semantics of the
  model/thinking pickers: opening focuses the CHECKED item, `aria-checked` marks the current
  language, Click/Enter/Space select, Escape closes and returns focus to the trigger, and
  outside close uses `pointerdown` (`SettingsOverlay.vue`'s newer pattern — it fires before the
  browser's default focus-steal, so the focus-return cannot race it). The panel is CSS-anchored
  right-aligned under the trigger inside `.lang-anchor` (the same anchor trick as the settings
  gear's `.settings-anchor`) and wires `usePopoverClamp` as a belt-and-braces viewport guard —
  right-anchored + a ≤200px menu can never run off a 360px phone, the clamp covers exotic
  `--fs-scale` values. No timers, no rAF.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { setLangOverride, useI18n, type Lang } from "../../composables/useI18n.js";
import { usePopoverClamp } from "../../composables/usePopoverClamp.js";

const i18n = useI18n();
const { t } = i18n;

/** Both languages, each keyed at an i18n entry whose value is its own-script name (identical
 * in en/zh — never translated). 中文 first, matching the old toggle's 中 glyph lineage. */
const OPTIONS: ReadonlyArray<{ code: Lang; key: string }> = [
  { code: "zh", key: "shell.langZh" },
  { code: "en", key: "shell.langEn" },
];

/** Compact CURRENT-language glyph on the trigger: 中 / EN (the toggle's target-language naming
 * was the reported bug). */
const shortLabel = computed(() => (i18n.lang === "zh" ? "中" : "EN"));

/** Trigger aria-label/title names the CURRENT language, e.g. "Language: English" / "语言：中文". */
const triggerLabel = computed(() => {
  const cur = OPTIONS.find((o) => o.code === i18n.lang) ?? OPTIONS[0]!;
  return t("shell.langMenuLabel", { lang: t(cur.key) });
});

// --- open/close + focus management -------------------------------------------------------------

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

usePopoverClamp(
  open,
  () => true, // one form factor: the tiny right-anchored menu works on phones as-is
  () => menuEl.value,
  () => triggerEl.value,
);

function items(): HTMLButtonElement[] {
  const root = rootEl.value;
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLButtonElement>(".lang-menu-item")];
}

async function openMenu(): Promise<void> {
  if (open.value) return;
  open.value = true;
  await nextTick();
  // Opening focuses the CHECKED item (menu-button + radio-group convention).
  const checked = rootEl.value?.querySelector<HTMLButtonElement>('.lang-menu-item[aria-checked="true"]');
  (checked ?? items()[0])?.focus();
}

function closeMenu(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocus) triggerEl.value?.focus();
}

function onToggleClick(): void {
  if (open.value) closeMenu(false);
  else void openMenu();
}

function select(code: Lang): void {
  if (code !== i18n.lang) setLangOverride(code); // same persistence the old toggle used
  closeMenu(true);
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation(); // never double-handled by an ancestor Escape listener
    closeMenu(true);
    return;
  }
  if (!open.value) {
    // Menu-button convention: ↓/↑/Enter/Space on the closed trigger opens it. Enter/Space are
    // handled explicitly (preventDefault) so a real browser's native click activation cannot
    // double-fire — same discipline as ModelSwitcher's chip trigger.
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      void openMenu();
    }
    return;
  }
  const list = items();
  if (list.length === 0) return;
  const idx = list.findIndex((el) => el === document.activeElement);
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const next = idx < 0 ? 0 : (idx + (ev.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
    return;
  }
  if (ev.key === "Home") {
    ev.preventDefault();
    list[0]?.focus();
    return;
  }
  if (ev.key === "End") {
    ev.preventDefault();
    list[list.length - 1]?.focus();
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    // Enter/Space on the trigger itself toggles closed (it has focus, not an item); on a
    // focused item it selects. Explicit + preventDefault ⇒ no native click double-fire.
    ev.preventDefault();
    if (document.activeElement === triggerEl.value) closeMenu(true);
    else if (idx >= 0) select(OPTIONS[idx]!.code);
    return;
  }
  if (ev.key === "Tab") {
    // APG menu behavior: Tab closes without refocus (the browser moves focus on its own).
    closeMenu(false);
  }
}

function onDocPointerDown(ev: Event): void {
  const root = rootEl.value;
  if (root !== null && !root.contains(ev.target as Node)) closeMenu(false);
}

watch(open, (v) => {
  if (typeof document === "undefined") return;
  if (v) document.addEventListener("pointerdown", onDocPointerDown, true);
  else document.removeEventListener("pointerdown", onDocPointerDown, true);
});
onBeforeUnmount(() => {
  if (typeof document !== "undefined") document.removeEventListener("pointerdown", onDocPointerDown, true);
});
</script>

<template>
  <span ref="rootEl" class="lang-anchor" @keydown="onKeydown">
    <button
      ref="triggerEl"
      type="button"
      class="btn btn-ghost lang-toggle"
      aria-haspopup="menu"
      :aria-expanded="open"
      aria-controls="lang-menu"
      :aria-label="triggerLabel"
      :title="triggerLabel"
      @click="onToggleClick"
    >
      <span class="lang-toggle-cur" translate="no">{{ shortLabel }}</span>
      <AppIcon name="chev-down" class="icon-sm" />
    </button>
    <div v-if="open" id="lang-menu" ref="menuEl" class="lang-menu" role="menu" :aria-label="t('shell.langMenuAria')">
      <button
        v-for="opt in OPTIONS"
        :key="opt.code"
        type="button"
        class="lang-menu-item"
        role="menuitemradio"
        :aria-checked="opt.code === i18n.lang"
        :data-lang="opt.code"
        @click="select(opt.code)"
      >
        <span class="lang-item-check" aria-hidden="true">
          <AppIcon v-if="opt.code === i18n.lang" name="check" class="icon-sm" />
        </span>
        <span translate="no">{{ t(opt.key) }}</span>
      </button>
    </div>
  </span>
</template>
