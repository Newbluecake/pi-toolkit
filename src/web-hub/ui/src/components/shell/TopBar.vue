<!--
  Top bar: brand, connection pill, hub version, read-only/Control chip, settings entry (gear),
  sign out (vue-plan.md v2.1 §3.2, §7, §5.2 — P3 exclusive, `components/shell/**`; Control chip
  per control-plan.md v2.1 §7.4 — C5). `TopBarProps` is frozen with no `user`/username field
  (`contracts.ts`), so — unlike the static mockup, which also showed a `.user-chip` — this build
  has no username slot to render; §7's connection pill states are otherwise ported verbatim
  (states.html: `connecting` = spinning loader icon, `open`/`reconnecting` = the same live dot,
  `auth` = an unlock icon with no dot).

  Settings is a floating panel, not a route (user field report 2026-10: "settings 那个页面应该是
  悬浮的，现在点击 setting 会导致会话页面消失，不是很合理" — a standalone `#/settings` page used
  to unmount the whole session view underneath it). The gear is a plain toggle button —
  `aria-expanded`/`aria-controls` instead of the retired `href="#/settings"` + `aria-current`
  history dance — that mounts/unmounts `SettingsOverlay.vue` inside the `.settings-anchor` span
  right after it; `shell.css` anchors the desktop popover to that span with plain CSS (no
  geometry math). An old `#/settings` deep link (or anyone setting that hash while the app is
  already running) is translated into "open the panel, replace the hash with `#/`" the moment it
  is observed — `#/settings` itself is never a route `DashboardView` has to render around.

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
import SettingsOverlay from "./SettingsOverlay.vue";

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

// Settings panel (floating, not a route): `open` drives SettingsOverlay's mount/unmount
// directly. `#/settings` is only ever a transitional signal — whenever it is observed (at
// startup, or via a later hashchange) it is immediately replaced with `#/` so no other part of
// the app (DashboardView included) ever has to special-case that hash.
function isSettingsHash(hash: string): boolean {
  return parseRouteHash(hash).name === "settings"; // same rule as the router
}

const initialSettingsOpen = isSettingsHash(window.location.hash);
if (initialSettingsOpen) window.history.replaceState(null, "", "#/");

const open = ref(initialSettingsOpen);
const gearEl = ref<HTMLButtonElement | null>(null);

function onHashChange(): void {
  if (!isSettingsHash(window.location.hash)) return;
  open.value = true;
  window.history.replaceState(null, "", "#/");
}

function onToggle(): void {
  open.value = !open.value;
}

function onClose(): void {
  open.value = false;
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

    <span class="settings-anchor">
      <button
        ref="gearEl"
        type="button"
        class="btn btn-ghost btn-icon settings-link"
        :aria-label="t('settings.title')"
        :title="t('settings.title')"
        aria-haspopup="dialog"
        :aria-expanded="open"
        aria-controls="settings-panel"
        @click="onToggle"
      >
        <AppIcon name="gear" />
      </button>
      <SettingsOverlay v-if="open" :anchor-el="gearEl" @close="onClose" />
    </span>

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
