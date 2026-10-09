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

  Plus two conditional cards: 「会话缓存」 (the `pwh_keepalive` radio group, web-hub-session-switch
  D2) and — only on pages actually served as plaintext (CONTROL_ENV.plaintext: password mode
  over http:) — 「明文 HTTP 警告」 (the `pwh_hide_plaintext_warn` radio group,
  `composables/usePlaintextWarning.ts`, 2026-10 user opt-out: hides every plaintext-HTTP
  warning in the UI; warning-text visibility only, never any security behavior).

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
import { KEEPALIVE_CHOICES, loadKeepAlive, setKeepAlivePref } from "@logic/sessionKeepAlive.js";
import { browserLocalStorage } from "./themeStorage.js";
import { usePlaintextWarning } from "../../composables/usePlaintextWarning.js";
import { CONTROL_ENV } from "../control/controlContext.js";
import { isSpawnModelRef, knownModelRefs, readModelCache, writeModelCache } from "../../logic/models.js";
import { spawnModelSupported } from "../../logic/spawn.js";
import { SPAWN_HUB_CAP } from "@protocol/version.js";
import { HUB_CTX } from "../control/controlContext.js";
import SettingsModelPicker from "./SettingsModelPicker.vue";
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

// D2（web-hub-session-switch plan §1.2 D2-5 / §2.2 步骤 6）：「会话缓存」单选组。偏好读在挂载
// 时一次、写在点击时持久化（useHub 每次切换时重读 pwh_keepalive，改小在下一次切换时生效）。
// 纯逻辑（校验/读写）在 @logic/sessionKeepAlive.js —— 本组件只持 ref 与 i18n 标签。
const keepAliveStorage = browserLocalStorage();
const keepAlive = ref<number>(loadKeepAlive(keepAliveStorage));
const KEEPALIVE_OPTIONS: readonly { value: number; labelKey: string }[] = KEEPALIVE_CHOICES.map((v) => ({
  value: v,
  labelKey: v === 1 ? "settings.keepAliveOff" : v === 3 ? "settings.keepAlive3" : "settings.keepAlive5",
}));
function setKeepAlive(v: number): void {
  keepAlive.value = v;
  setKeepAlivePref(keepAliveStorage, v);
}

// 2026-10 明文警告开关（用户显式选择「http 警告支持通过设置关闭」）：`pwh_hide_plaintext_warn`
// 浏览器级偏好（与 pwh_keepalive 同族），控制全部 7 处明文 HTTP 警告的可见性。卡片仅在
// 确实以明文提供的页面渲染——判定复用警告组件自己的谓词 CONTROL_ENV.plaintext（App 提供：
// 密码模式 ∧ http:）；https / 回环 token 页面根本没有明文警告，开关无从谈起。只影响警告文案
// 可见性，不改变任何安全行为。
const controlEnv = inject(CONTROL_ENV, null);
const plainHttpPage = controlEnv?.plaintext === true;
const plainWarn = usePlaintextWarning({ storage: browserLocalStorage() });
const PLAINWARN_OPTIONS: readonly { value: boolean; labelKey: string }[] = [
  { value: false, labelKey: "settings.plainWarnShow" },
  { value: true, labelKey: "settings.plainWarnHide" },
];

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
// default-model card (web-hub-spawn default-model plan F1, D1/D2/D4/D7; 2026-10 select-only
// rework): the hub-wide 「新建会话默认模型」. Rendered only when the hub advertises `spawn.v1`
// at all; without `spawn.model.v1` (an old hub) the card stays visible but DISABLED with an
// upgrade hint — and the UI never sends `model`/`POST /api/headless/prefs` to such a hub
// (D4). The picker itself lives in `shell/SettingsModelPicker.vue` (switcher-styled chip +
// listbox, select-ONLY — no free-text save path); this card owns the prefs, the D7 option
// list and the save wire call.
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

/** The picker's saved value: `""` = 跟随 pi 默认. Live off the prefs ref — select-only means
 * there is no in-progress edit to protect any more; a save's 200 echo (or another tab's
 * save) legitimately updates the trigger immediately. */
const defaultModelValue = computed(() => spawn?.prefs.value?.defaultModel ?? "");

onMounted(() => {
  if (modelCap.value && spawn !== undefined) void spawn.refreshPrefs();
});

async function saveDefaultModel(value: string): Promise<void> {
  if (spawn === undefined || !modelCap.value || modelSaveState.value === "saving") return;
  if (value !== "" && !isSpawnModelRef(value)) return; // picker items are pre-validated; belt
  modelSaveState.value = "saving";
  const r = await spawn.setDefaultModel(value);
  modelSaveState.value = r.ok ? "saved" : "failed";
}

/** The picker spoke: a listed `provider/id` or the `""` follow-pi tri-state (the retired
 * 「使用 pi 默认」 button's semantics, now a list row). Saves immediately. */
function onModelSelect(value: string): void {
  void saveDefaultModel(value);
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

        <section class="settings-card settings-card-wide" :aria-label="t('settings.keepAliveSection')">
          <h2 class="settings-h">{{ t("settings.keepAliveSection") }}</h2>
          <p class="settings-note">{{ t("settings.keepAliveHint") }}</p>
          <div class="settings-options" role="radiogroup" :aria-label="t('settings.keepAliveSection')">
            <button
              v-for="opt in KEEPALIVE_OPTIONS"
              :key="opt.value"
              type="button"
              role="radio"
              :aria-checked="keepAlive === opt.value"
              class="settings-option"
              @click="setKeepAlive(opt.value)"
            >
              <span class="settings-option-label">{{ t(opt.labelKey) }}</span>
              <AppIcon v-if="keepAlive === opt.value" name="check" class="icon-sm settings-option-check" />
            </button>
          </div>
        </section>

        <section
          v-if="plainHttpPage"
          class="settings-card settings-card-wide"
          :aria-label="t('settings.plainWarnSection')"
        >
          <h2 class="settings-h">{{ t("settings.plainWarnSection") }}</h2>
          <p class="settings-note">{{ t("settings.plainWarnHint") }}</p>
          <div class="settings-options" role="radiogroup" :aria-label="t('settings.plainWarnSection')">
            <button
              v-for="opt in PLAINWARN_OPTIONS"
              :key="String(opt.value)"
              type="button"
              role="radio"
              :aria-checked="plainWarn.hidden.value === opt.value"
              class="settings-option"
              @click="plainWarn.setHidden(opt.value)"
            >
              <span class="settings-option-label">{{ t(opt.labelKey) }}</span>
              <AppIcon v-if="plainWarn.hidden.value === opt.value" name="check" class="icon-sm settings-option-check" />
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
          <!-- select-ONLY picker (2026-10 rework): chip trigger + listbox, options from the D7
               union/cache, 「跟随 pi 默认」 as a list row — no free-text save path remains -->
          <SettingsModelPicker
            :value="defaultModelValue"
            :options="modelOptions"
            :disabled="!modelCap"
            :saving="modelSaveState === 'saving'"
            @select="onModelSelect"
          />
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
