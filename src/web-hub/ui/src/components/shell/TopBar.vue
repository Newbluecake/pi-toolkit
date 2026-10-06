<!--
  Top bar: brand, connection pill, hub version, read-only/Control chip, settings entry (gear),
  sign out (vue-plan.md v2.1 §3.2, §7, §5.2 — P3 exclusive, `components/shell/**`; Control chip
  per control-plan.md v2.1 §7.4 — C5). 2026-10 (user-decided): the theme dropdown and the
  font-size popover moved into the standalone `#/settings` page — the bar now carries a single
  gear link there (a real hash navigation, so browser back returns). `TopBarProps` is frozen
  with no `user`/username field (`contracts.ts`), so — unlike the static mockup, which also
  showed a `.user-chip` — this build has no username slot to render; §7's connection pill
  states are otherwise ported verbatim (states.html: `connecting` = spinning loader icon,
  `open`/`reconnecting` = the same live dot, `auth` = an unlock icon with no dot).

  C5: the chip switches on the hub's negotiated control plane (`HUB_CTX.state.control`) —
  `Read-only` when off, a warn-coloured `Control` button when on; clicking it expands the
  persistent `ControlNotice` (shared `CONTROL_ENV.noticeExpanded`; App.vue owns the mounted
  notice, §7.4). Both chips keep the base `.chip` class (shell.css's <481px hiding rule applies
  to either).
-->
<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { UI_BUILD } from "../../build-info.js";
import { uiBuildStamp } from "@logic/build-stamp.js";
import type { TopBarEmits, TopBarProps } from "../../contracts.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import { parseRouteHash } from "../../composables/useHashRoute.js";

const props = defineProps<TopBarProps>();
const emit = defineEmits<TopBarEmits>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);
const controlOn = computed(() => hub?.state.value.control === true);

const connLabelKey = computed(() => `shell.conn.${props.conn}`);
const uiStamp = computed(() => uiBuildStamp(UI_BUILD));

/** Full version info as the brand's tooltip — the inline metas are desktop-only (<1025px) so
 * on phones/tablets this is the only place the hub/ui stamps remain visible (field report
 * 2026-10-05: the wrapped meta texts crowded the fixed-height bar). */
const brandTitle = computed(() => {
  const parts = ["pi web-hub"];
  if (props.hubVersion) parts.push(`hub ${props.hubVersion}`);
  if (uiStamp.value) parts.push(`ui ${uiStamp.value}`);
  return parts.join(" · ");
});

function onControlChipClick(): void {
  if (env) env.noticeExpanded.value = !env.noticeExpanded.value;
}

// Gear = toggle (user 2026-10): a second click while `#/settings` is showing closes it, back to
// where the user came from. `openedInApp` records whether THIS gear opened it (so in-app history
// has an entry to pop); a direct deep link to `#/settings` has none ⇒ replace to `#/` instead of
// `history.back()` leaving the app. Self-contained — `TopBarProps` stays untouched.
const onSettings = ref(isSettingsHash());
let openedInApp = false;
function isSettingsHash(): boolean {
  return parseRouteHash(window.location.hash).name === "settings"; // same rule as the router
}
function onHashChange(): void {
  onSettings.value = isSettingsHash();
  if (!onSettings.value) openedInApp = false;
}
function onSettingsClick(ev: MouseEvent): void {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  if (!onSettings.value) {
    openedInApp = true; // the href navigation itself proceeds
    return;
  }
  ev.preventDefault();
  if (openedInApp) window.history.back();
  else window.location.replace("#/");
}
onMounted(() => window.addEventListener("hashchange", onHashChange));
onUnmounted(() => window.removeEventListener("hashchange", onHashChange));
</script>

<template>
  <header class="topbar">
    <span class="brand" :title="brandTitle">
      <span class="brand-mark" aria-hidden="true"><AppIcon name="logo" /></span>
      <span translate="no">pi web-hub</span>
    </span>

    <span class="pill conn" :data-conn="conn" role="status">
      <AppIcon v-if="conn === 'connecting'" name="loader" class="icon-sm spin" />
      <AppIcon v-else-if="conn === 'auth'" name="unlock" class="icon-sm" />
      <span v-else class="dot dot-live"></span>
      {{ t(connLabelKey) }}
    </span>

    <span v-if="hubVersion" class="topbar-meta" translate="no">{{ t("shell.hubVersion", { v: hubVersion }) }}</span>
    <span v-if="uiStamp" class="topbar-meta" translate="no">{{ t("shell.uiBuild", { v: uiStamp }) }}</span>
    <button
      v-if="controlOn"
      class="chip control-chip"
      type="button"
      :aria-label="t('control.noticeTitle')"
      :title="t('control.noticeTitle')"
      :aria-expanded="env?.noticeExpanded.value === true"
      @click="onControlChipClick"
    >
      <AppIcon name="terminal" class="icon-sm" />
    </button>
    <span v-else class="chip readonly-chip"><AppIcon name="eye" class="icon-sm" />{{ t("common.readonly") }}</span>

    <span class="topbar-spacer"></span>

    <a
      class="btn btn-ghost btn-icon settings-link"
      href="#/settings"
      :aria-label="t('settings.title')"
      :title="t('settings.title')"
      :aria-current="onSettings ? 'page' : undefined"
      @click="onSettingsClick"
    >
      <AppIcon name="gear" />
    </a>

    <button
      v-if="canSignOut"
      class="btn btn-ghost"
      type="button"
      :aria-label="t('shell.signOut')"
      @click="emit('signout')"
    >
      <AppIcon name="logout" />
      <span class="lbl-md" aria-hidden="true">{{ t("shell.signOut") }}</span>
    </button>
  </header>
</template>
