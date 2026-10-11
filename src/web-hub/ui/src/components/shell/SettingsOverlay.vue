<!--
  Settings floating panel (user field report 2026-10: "settings 那个页面应该是悬浮的，现在点击
  setting 会导致会话页面消失，不是很合理" — the previous standalone `#/settings` route unmounted
  the whole session view behind it). Mounted by `TopBar.vue`'s gear toggle (`v-if`, so mount/
  unmount IS open/close — same lifecycle-driven convention `control/PickerSheet.vue` already
  uses) inside the `.settings-anchor` span right after the gear button; the session layout
  underneath (`DashboardView.vue`) is never touched and keeps its own scroll position / composer
  draft / drawer state.

  Two presentations, chosen purely by viewport (`useMedia`, same `(max-width: 767px)` breakpoint
  `DashboardView.vue`'s `narrow` band uses):

  - **mobile**: `control/PickerSheet.vue`, imported but never modified (explicitly allowed by
    the task) — gets the bottom sheet, scrim-click-to-close, Esc, body scroll lock and its own
    internal focus trap / focus-return-to-opener for free.
  - **desktop**: a small non-modal `role="dialog"` popover, anchored purely with CSS
    (`.settings-panel` in shell.css, `position: absolute` under the `.settings-anchor` wrapper —
    no geometry math needed). Non-modal per spec: Esc and an outside click close it (the click
    check excludes both the panel itself and the anchor's gear button, so pressing the gear
    again is a plain toggle, not a close-then-reopen race), but there is no Tab focus trap —
    only focus-in on open and focus-return-to-opener (`anchorEl`) on close.

  Esc here always calls `preventDefault()` before emitting `close` — `DashboardView.vue`'s own
  global Escape handler (closes the mid-band drawer / returns to the agent list) already bails
  out whenever `event.defaultPrevented` is true, so the two handlers never fight over the same
  keypress regardless of listener registration order.

  Phone quick-actions (≤480px, plan C): the language switch and sign-out button move off the
  cramped top bar (`TopBar.vue` hides its own `.lang-anchor`/`.signout-btn` via CSS at that
  width) into a small row at the top of THIS panel instead — gated by its OWN `phone` media
  query (`useMedia`, mirrors `TopBar.vue`'s `connBadgeList`/`conn-badge` convention), so the row
  is physically absent from the DOM — not just CSS-hidden — anywhere above 480px, including the
  481-767px band that otherwise shares this exact `PickerSheet` branch. No CSS display-toggle
  rule is needed for `.settings-phone-quick` in shell.css as a result; it is simply inert
  wherever it doesn't exist. `canSignOut`/`signout` are plain prop/emit, the same shape
  `TopBar.vue` already exposes (`contracts.ts`'s frozen `TopBarProps`/`TopBarEmits` do not cover
  this component, so adding them here is not a frozen-surface change).
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useMedia } from "../../composables/useMedia.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import LangMenu from "./LangMenu.vue";
import PickerSheet from "../control/PickerSheet.vue";
import SettingsView from "./SettingsView.vue";

const props = withDefaults(defineProps<{ anchorEl: HTMLElement | null; canSignOut?: boolean }>(), {
  canSignOut: false,
});
const emit = defineEmits<{ close: []; signout: [] }>();
const { t } = useI18n();

const mobile = useMedia(window, "(max-width: 767px)").matches;
/** Phone-only quick-actions row (plan C): 0/1-item-rendering by `phone`, the SAME pattern
 *  `TopBar.vue`'s `connBadgeList` uses — a plain `v-if` would still mount the row's DOM subtree
 *  in the 481-767px tablet band (which shares this PickerSheet branch); gating on `phone`
 *  directly keeps it out of the DOM there too, not just CSS-hidden. */
const phone = useMedia(window, "(max-width: 480px)").matches;
const phoneQuickList = computed(() => (phone.value ? [true] : []));

function onSignOut(): void {
  emit("signout");
  emit("close");
}

const panelEl = ref<HTMLElement | null>(null);

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  // An open sub-overlay (the default-model picker's Teleport'd panel/sheet, marked
  // `[data-subpanel]`) owns this Esc: it closes itself via its own window-capture guard —
  // the settings panel around it stays open. Belt-and-braces alongside that guard.
  if (document.querySelector("[data-subpanel]") !== null) return;
  ev.preventDefault();
  emit("close");
}

function onPointerDown(ev: PointerEvent): void {
  if (!(ev.target instanceof Node)) return;
  const panel = panelEl.value;
  if (panel !== null && panel.contains(ev.target)) return;
  if (props.anchorEl !== null && props.anchorEl.contains(ev.target)) return;
  // Clicks inside an open sub-overlay (the default-model picker's Teleport'd panel/sheet)
  // are INSIDE this dialog logically but outside its DOM — the sub-overlay manages its own
  // dismissal; without this bail a pick inside it would tear down the whole settings panel.
  if (ev.target instanceof Element && ev.target.closest("[data-subpanel]") !== null) return;
  // P1 fix (verifier 2026-10): outside pointerdown's own default action is "move focus to
  // whatever was clicked, or blur to <body> if nothing focusable was hit" — a REAL browser
  // applies that default synchronously as part of dispatching this very pointerdown (not as a
  // later microtask), i.e. strictly before `onUnmounted`'s `anchorEl.focus()` below ever runs
  // (that one is scheduled through Vue's reactive flush, a microtask, so it ran AFTER the
  // browser already stole focus to <body> — confirmed via real Chromium repro, not caught by
  // happy-dom's pointerdown, which never implements this default action at all). `preventDefault`
  // on pointerdown cancels that default focus change outright, so there is nothing left to race
  // against — `anchorEl.focus()` on unmount is the only focus-setter that runs for this path.
  ev.preventDefault();
  emit("close");
}

// The mobile sheet is a separate component (`PickerSheet`) that already owns its own Esc /
// scrim-click / scroll-lock / focus-trap lifecycle — this component only drives the desktop
// popover's lighter-weight equivalent, and only while the desktop branch is actually rendered.
onMounted(async () => {
  if (mobile.value) return;
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  await nextTick();
  panelEl.value?.focus();
});

onUnmounted(() => {
  if (mobile.value) return;
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  props.anchorEl?.focus();
});
</script>

<template>
  <PickerSheet v-if="mobile" id="settings-panel" side="top" :label="t('settings.title')" @close="emit('close')">
    <div v-for="_ in phoneQuickList" :key="'phone-quick'" class="settings-phone-quick">
      <LangMenu />
      <button v-if="canSignOut" type="button" class="btn btn-ghost settings-phone-signout" @click="onSignOut">
        <AppIcon name="logout" class="icon-sm" />
        <span>{{ t("shell.signOut") }}</span>
      </button>
    </div>
    <SettingsView @close="emit('close')" />
  </PickerSheet>
  <div
    v-else
    id="settings-panel"
    ref="panelEl"
    class="settings-panel"
    role="dialog"
    aria-labelledby="settings-panel-title"
    tabindex="-1"
  >
    <SettingsView @close="emit('close')" />
  </div>
</template>
