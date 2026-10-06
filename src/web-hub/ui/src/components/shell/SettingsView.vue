<!--
  Settings panel content (floating panel, revised 2026-10 field report: the previous standalone
  `#/settings` route unmounted the whole session view when opened — this content now lives
  inside `shell/SettingsOverlay.vue`'s desktop popover / mobile bottom sheet instead, so the
  session underneath stays mounted). Every preference that used to live behind top-bar popovers
  (theme dropdown, font-size slider) or the composer (per-message delivery switch) has one home
  here. Three cards:

    1. Theme — three radio rows (system / light / dark) driving `useTheme`'s `pref`/`setPref`
       (same `pwh_theme` persistence the retired `ThemeToggle.vue` used).
    2. Font size — 0.8–3.0 slider + live percentage readout + reset, driving `useFontScale`
       (slider `input` live-previews without persisting; `change`/reset persist — the retired
       `FontScaleToggle.vue` popover's exact split).
    3. Default delivery — steer/followUp radio rows driving `useDeliverDefault` (`pwh_deliver`);
       the composer reads the same key for busy sends (Alt+Enter still flips per message).

  Self-wired (`browserLocalStorage()` + `document`), exactly like the retired toggles — no new
  props, so the frozen `contracts.ts` surface stays untouched. The header's × button only emits
  `close` — there is no "back" destination to return to any more (the panel floats over
  whatever the session view already showed); the owner (`SettingsOverlay.vue`) decides how to
  tear the panel down (unmount for the desktop popover, `PickerSheet`'s own close path on
  mobile). `settings-panel-title` is the `aria-labelledby` target the desktop popover points at.
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import type { IconName } from "../../icons/names.js";
import { useI18n } from "../../composables/useI18n.js";
import { useTheme } from "../../composables/useTheme.js";
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  fontScalePercent,
  useFontScale,
} from "../../composables/useFontScale.js";
import { useDeliverDefault, type DeliverDefault } from "../../composables/useDeliverDefault.js";
import { browserLocalStorage } from "./themeStorage.js";
import type { ThemePref } from "../../types.js";
import "../../styles/settings.css";

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();

const theme = useTheme({
  storage: browserLocalStorage(),
  doc: document,
  metaThemeColor: document.querySelector('meta[name="theme-color"]'),
});
const fontScale = useFontScale({ storage: browserLocalStorage(), doc: document });
const deliverDefault = useDeliverDefault({ storage: browserLocalStorage() });

const THEME_OPTIONS: readonly { value: ThemePref; icon: IconName; labelKey: string }[] = [
  { value: "system", icon: "monitor", labelKey: "shell.theme.system" },
  { value: "light", icon: "sun", labelKey: "shell.theme.light" },
  { value: "dark", icon: "moon", labelKey: "shell.theme.dark" },
];

const DELIVER_OPTIONS: readonly { value: DeliverDefault; labelKey: string; hintKey: string }[] = [
  { value: "steer", labelKey: "settings.deliverSteer", hintKey: "settings.deliverSteerHint" },
  { value: "followUp", labelKey: "settings.deliverFollowUp", hintKey: "settings.deliverFollowUpHint" },
];

const pct = computed(() => fontScalePercent(fontScale.scale.value));

function rangeValue(ev: Event): number {
  return Number((ev.target as HTMLInputElement).value);
}

function onRangeInput(ev: Event): void {
  fontScale.preview(rangeValue(ev)); // live preview while dragging — no storage write
}

function onRangeChange(ev: Event): void {
  fontScale.setScale(rangeValue(ev)); // released — persist
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-inner">
      <header class="settings-head">
        <h2 id="settings-panel-title" class="settings-title">{{ t("settings.title") }}</h2>
        <button
          type="button"
          class="btn btn-ghost btn-icon settings-close"
          :aria-label="t('settings.close')"
          :title="t('settings.close')"
          @click="emit('close')"
        >
          <AppIcon name="x" />
        </button>
      </header>

      <section class="settings-card" :aria-label="t('settings.themeSection')">
        <h2 class="settings-h">{{ t("settings.themeSection") }}</h2>
        <div class="settings-options" role="radiogroup" :aria-label="t('settings.themeSection')">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.value"
            type="button"
            role="radio"
            :aria-checked="theme.pref.value === opt.value"
            class="settings-option"
            @click="theme.setPref(opt.value)"
          >
            <AppIcon :name="opt.icon" class="icon-sm" />
            <span class="settings-option-label">{{ t(opt.labelKey) }}</span>
            <AppIcon v-if="theme.pref.value === opt.value" name="check" class="icon-sm settings-option-check" />
          </button>
        </div>
      </section>

      <section class="settings-card" :aria-label="t('settings.fontSection')">
        <h2 class="settings-h">{{ t("settings.fontSection") }}</h2>
        <div class="settings-font">
          <input
            type="range"
            :min="FONT_SCALE_MIN"
            :max="FONT_SCALE_MAX"
            :step="FONT_SCALE_STEP"
            :value="fontScale.scale.value"
            :aria-label="t('settings.fontSection')"
            :aria-valuetext="`${pct}%`"
            @input="onRangeInput"
            @change="onRangeChange"
          />
          <span class="settings-font-readout" aria-hidden="true">{{ pct }}%</span>
          <button type="button" class="btn btn-ghost settings-font-reset" @click="fontScale.reset()">
            {{ t("shell.fontScale.reset") }}
          </button>
        </div>
      </section>

      <section class="settings-card" :aria-label="t('settings.deliverSection')">
        <h2 class="settings-h">{{ t("settings.deliverSection") }}</h2>
        <p class="settings-note">{{ t("settings.deliverHint") }}</p>
        <div class="settings-options" role="radiogroup" :aria-label="t('settings.deliverSection')">
          <button
            v-for="opt in DELIVER_OPTIONS"
            :key="opt.value"
            type="button"
            role="radio"
            :aria-checked="deliverDefault.deliver.value === opt.value"
            class="settings-option"
            @click="deliverDefault.setDeliver(opt.value)"
          >
            <span class="settings-option-label" translate="no">{{ t(opt.labelKey) }}</span>
            <span class="settings-option-hint">{{ t(opt.hintKey) }}</span>
            <AppIcon
              v-if="deliverDefault.deliver.value === opt.value"
              name="check"
              class="icon-sm settings-option-check"
            />
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
