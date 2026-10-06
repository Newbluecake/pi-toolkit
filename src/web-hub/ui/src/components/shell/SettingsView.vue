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
import { computed, inject, onMounted, ref, watch } from "vue";
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
import { isSpawnModelRef, knownModelRefs, readModelCache, writeModelCache } from "../../logic/models.js";
import { spawnModelSupported } from "../../logic/spawn.js";
import { SPAWN_HUB_CAP } from "@protocol/version.js";
import { HUB_CTX } from "../control/controlContext.js";
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

// ---------------------------------------------------------------------------
// default-model card (web-hub-spawn default-model plan F1, D1/D2/D4/D7): the hub-wide
// 「新建会话默认模型」. Rendered only when the hub advertises `spawn.v1` at all; without
// `spawn.model.v1` (an old hub) the card stays visible but DISABLED with an upgrade hint —
// and the UI never sends `model`/`POST /api/headless/prefs` to such a hub (D4).
// ---------------------------------------------------------------------------
const hub = inject(HUB_CTX, null);
const spawn = hub?.spawn;

const hubCaps = computed<unknown>(() => {
  const h = hub?.state.value.hub;
  return h !== null && h !== undefined && typeof h === "object" ? (h as { caps?: unknown }).caps : undefined;
});
/** No `spawn.v1` ⇒ the whole card is absent (the hub has no managed sessions at all). */
const spawnCap = computed(() => Array.isArray(hubCaps.value) && hubCaps.value.includes(SPAWN_HUB_CAP));
/** No `spawn.model.v1` ⇒ disabled + upgrade hint; nothing model-shaped ever hits the wire. */
const modelCap = computed(() => spawnModelSupported(hubCaps.value));

const modelInput = ref("");
type ModelSaveState = "idle" | "saving" | "saved" | "failed";
const modelSaveState = ref<ModelSaveState>("idle");

// D7's list: union of online agents' `session.models.items` (cache refreshed whenever it is
// non-empty); the last non-empty cache covers the no-online-agent case.
const storage = browserLocalStorage();
const knownRefs = computed(() => knownModelRefs(hub?.state.value.agents));
watch(
  knownRefs,
  (refs) => {
    if (refs.length > 0) writeModelCache(storage, refs);
  },
  { immediate: true },
);
const modelOptions = computed(() => (knownRefs.value.length > 0 ? knownRefs.value : readModelCache(storage)));

const modelTrimmed = computed(() => modelInput.value.trim());
/** Live local validation (the hub's own `parseSpawnModelRef`, via `@logic/models.js`). */
const modelInvalid = computed(() => modelTrimmed.value !== "" && !isSpawnModelRef(modelTrimmed.value));
/** D7/R1 soft warning: a valid ref that no known list entry offers (typo-prone free input). */
const modelNotInList = computed(
  () =>
    modelTrimmed.value !== "" &&
    !modelInvalid.value &&
    modelOptions.value.length > 0 &&
    !modelOptions.value.some((m) => `${m.provider}/${m.id}` === modelTrimmed.value),
);

// Initialize the input from the hub preference once it is known (a later re-arrival must not
// clobber an in-progress edit — after the first fill, only a successful save re-syncs).
let modelInitialized = false;
watch(
  () => spawn?.prefs.value,
  (p) => {
    if (modelInitialized || p === null || p === undefined) return;
    modelInitialized = true;
    modelInput.value = p.defaultModel ?? "";
  },
  { immediate: true },
);

onMounted(() => {
  if (modelCap.value && spawn !== undefined) void spawn.refreshPrefs();
});

watch(modelInput, () => {
  if (modelSaveState.value !== "saving") modelSaveState.value = "idle";
});

async function saveDefaultModel(value: string): Promise<void> {
  if (spawn === undefined || !modelCap.value || modelSaveState.value === "saving") return;
  if (value !== "" && !isSpawnModelRef(value)) return; // the live invalid note already shows
  modelSaveState.value = "saving";
  const r = await spawn.setDefaultModel(value);
  modelSaveState.value = r.ok ? "saved" : "failed";
}

function onModelSave(): void {
  void saveDefaultModel(modelTrimmed.value);
}

/** 「使用 pi 默认」: clear the preference (the POST's `""` tri-state) and persist immediately. */
function onModelUsePi(): void {
  modelInput.value = "";
  void saveDefaultModel("");
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

      <div class="settings-grid">
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

        <section class="settings-card settings-card-wide" :aria-label="t('settings.deliverSection')">
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

        <section
          v-if="spawnCap"
          class="settings-card settings-card-wide"
          :aria-label="t('settings.defaultModelSection')"
        >
          <h2 class="settings-h">{{ t("settings.defaultModelSection") }}</h2>
          <p class="settings-note">{{ t("settings.defaultModelHint") }}</p>
          <p class="settings-note">{{ t("settings.defaultModelShared") }}</p>
          <p v-if="!modelCap" class="settings-note settings-model-warn">{{ t("settings.defaultModelUnsupported") }}</p>
          <div class="settings-model-row">
            <input
              v-model="modelInput"
              type="text"
              class="settings-model-input"
              list="settings-model-options"
              :placeholder="t('settings.defaultModelPlaceholder')"
              :aria-label="t('settings.defaultModelSection')"
              :disabled="!modelCap || modelSaveState === 'saving'"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              translate="no"
            />
            <datalist id="settings-model-options">
              <option v-for="m in modelOptions" :key="`${m.provider}/${m.id}`" :value="`${m.provider}/${m.id}`">
                {{ m.name ?? `${m.provider}/${m.id}` }}
              </option>
            </datalist>
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="!modelCap || modelSaveState === 'saving'"
              @click="onModelUsePi"
            >
              {{ t("settings.defaultModelUsePi") }}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="!modelCap || modelSaveState === 'saving' || modelInvalid"
              @click="onModelSave"
            >
              {{ t("settings.defaultModelSave") }}
            </button>
          </div>
          <p v-if="modelInvalid" class="settings-note settings-model-warn">{{ t("settings.defaultModelInvalid") }}</p>
          <p v-else-if="modelNotInList" class="settings-note settings-model-warn">
            {{ t("settings.defaultModelNotInList") }}
          </p>
          <p v-else-if="modelOptions.length === 0" class="settings-note">{{ t("settings.defaultModelNoList") }}</p>
          <p v-if="modelSaveState !== 'idle'" class="settings-model-status" role="status">
            {{
              modelSaveState === "saving"
                ? t("settings.defaultModelSaving")
                : modelSaveState === "saved"
                  ? t("settings.defaultModelSaved")
                  : t("settings.defaultModelSaveFailed")
            }}
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
