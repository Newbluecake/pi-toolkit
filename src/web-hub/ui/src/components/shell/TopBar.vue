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

  Phone decluttering (≤480px, user-approved plan A/B/C — phone screenshot report: the bar
  collapsed into an unreadable row of a green "在线" pill, a squeezed-to-a-sliver quota pill
  (b4c8dc4 made it shrinkable), a two-line-wrapped CPU load pill, the language menu and the
  sign-out button all fighting for the same narrow row). Desktop/tablet (>480px) stay
  byte-for-byte unchanged — every new element below is either CSS-hidden at that width or, for
  the brand-mark connection badge, physically absent from the DOM (the same "0/1-item `v-for`,
  never `v-if`" trick `quotaList`/`loadList` already use, so the existing
  `quota-pill.test.ts` TopBar-no-quota-data golden-HTML pin stays untouched — `phone` is false
  under every test's stubbed `matchMedia`, so `connBadgeList` is empty there exactly like
  today):
    A. `.pill.conn`'s text is hidden on phone; a small `role="status"` badge on the brand mark
       takes over conveying the SAME `t(connLabelKey)` name (dot = live, pulsing = connecting/
       reconnecting — `.dot-live`'s own halo animation, reused verbatim — danger-red = signed
       out, reusing `.conn[data-conn]`'s existing severity colouring) — `HubStateBanner`
       (mounted elsewhere) keeps announcing problems regardless.
    B. `QuotaPill`/`LoadPill` collapse to compact number chips on phone (their own files).
    C. The language menu and sign-out move into `SettingsOverlay`'s mobile sheet (hidden from
       the bar via CSS on phone only — `canSignOut`/`@signout` are threaded down to it exactly
       the way they already flow through this component).
-->
<script setup lang="ts">
import { computed, defineAsyncComponent, inject, onMounted, onUnmounted, provide, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import LangMenu from "./LangMenu.vue";
import { UI_BUILD } from "../../build-info.js";
import { uiBuildStamp } from "@logic/build-stamp.js";
import type { TopBarEmits, TopBarProps } from "../../contracts.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import { parseRouteHash } from "../../composables/useHashRoute.js";
import { useMedia } from "../../composables/useMedia.js";
import SettingsOverlay from "./SettingsOverlay.vue";
import VersionHost from "./VersionHost.vue";
import { useVersionInfo, VERSION_CTX } from "../../composables/useVersionInfo.js";
import QuotaPill from "../quota/QuotaPill.vue";
import { freshestQuota } from "@logic/quota.js";
import LoadPill from "../load/LoadPill.vue";
import { useProxyOpen } from "../../composables/useProxyOpen.js";

const props = defineProps<TopBarProps>();
const emit = defineEmits<TopBarEmits>();
const i18n = useI18n();
const { t } = i18n;
/* 2026-10-08 user request: manual language switch in the top bar (supersedes vue-plan §0.2's
 * "no manual switcher"); 2026-10-10 user report replaced the two-state toggle (it showed the
 * TARGET language — EN while the UI was Chinese) with the LangMenu dropdown. The choice still
 * persists via setLangOverride's `pwh_lang` localStorage key. */

const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);
const controlOn = computed(() => hub?.state.value.control === true);

/**
 * quota-web plan §3/D5: cross-session hoist — computed fresh off `hub.state.value.agents` on
 * every reactive tick (no reducer change needed: `@logic/state.js` already mirrors `StatusInfo`
 * wholesale onto `AgentState.status`, so `status.quota` just rides along). Wrapped in a 0/1-item
 * array (NOT a `v-if`) so the template below can mount `QuotaPill` with a plain `v-for`: Vue's
 * compiled `v-if` always leaves a `<!--v-if-->` anchor comment in the DOM even when false
 * (verified empirically against this exact component tree), but an empty `v-for` list produces
 * truly zero extra nodes — the only way to satisfy quota-web plan's "no quota data ⇒ TopBar DOM
 * byte-identical to pre-feature" requirement (pinned by `tests/web-hub/ui/quota-pill.test.ts`).
 */
const quotaList = computed(() => {
  const agents = hub?.state.value.agents;
  if (agents === undefined) return [];
  const q = freshestQuota(agents.values());
  return q === undefined ? [] : [q];
});

/** sysload plan §7.4/§10 (package P4): the hub-global `load` slot, read the SAME "0/1-item
 *  `v-for`, never `v-if`" way `quotaList` above is (I8: zero extra DOM when the load feature is
 *  off / not yet sampled / the hub's caps don't advertise `load.v1`). */
const loadList = computed(() => {
  const load = hub?.state.value.load;
  return load === undefined ? [] : [load];
});
const loadReceivedAt = computed(() => hub?.state.value.loadReceivedAt);

/** Phone-only connection badge (plan A): mirrors the `quotaList`/`loadList` 0/1-item `v-for`
 *  trick above — `phone` is false under every test's stubbed `matchMedia` (and on real
 *  desktop/tablet viewports), so `connBadgeList` is empty there and the badge contributes
 *  literally zero DOM nodes, keeping `quota-pill.test.ts`'s TopBar golden-HTML pin intact. */
const phone = useMedia(window, "(max-width: 480px)").matches;
const connBadgeList = computed(() => (phone.value ? [props.conn] : []));

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

// web-hub-version plan §5.2 (V2): the version chip + its dot. ONE useVersionInfo instance per
// TopBar, PROVIDED as VERSION_CTX — the popover and the settings 「版本」 card share its
// single-flight fetch (D4: 共用单飞，不重复请求). The dot list uses the same 0/1-item `v-for`
// trick as `quotaList` above: `match.dot` is null for 无法验证/无发现, so a clean TopBar
// contributes ZERO extra DOM nodes (the quota golden pin stays intact; §5.3's scoped
// normalization only has to restore the old `.topbar-meta` span shape — note the template's
// DOM comments around it stay byte-identical, which is why the V2 notes live HERE and not in
// a new template comment). The gear button mirrors the same dot below 1025px, where the chip
// itself is CSS-hidden (`.version-dot-gear`, version.css) — same 0/1-item trick.
const versionInfo = useVersionInfo({ hub });
provide(VERSION_CTX, versionInfo);
onUnmounted(() => versionInfo.dispose());
const versionChipEl = ref<HTMLButtonElement | null>(null);
const dotList = computed(() => {
  const d = versionInfo.match.value.dot;
  return d === null ? [] : [d];
});

/* web-hub-proxy plan v2 §8 (X2): ONE entry 「打开本机端口」, visible iff the hub advertises the proxy
 * cap AND the transport implements it (`useProxyOpen().scope`). Same 0/1-item `v-for` trick as
 * `quotaList` — no scope ⇒ ZERO extra DOM nodes (no `<!--v-if-->` anchor), so the TopBar stays
 * byte-identical on a hub without the feature. The dialog is a lazy chunk (first-screen budget);
 * a failed chunk load simply closes the dialog again. */
const proxyHandle = useProxyOpen();
const proxyList = computed(() => (proxyHandle.scope.value === null ? [] : [proxyHandle.scope.value]));
const proxyOpen = ref(false);
const ProxyDialog = defineAsyncComponent({
  loader: () =>
    import("../proxy/ProxyDialog.vue").catch((e: unknown) => {
      proxyOpen.value = false;
      throw e;
    }),
  timeout: 8000,
});

/* R1 rework (2026-10-17 user real-browser check): the version popover opens like QuotaPill's
 * QuotaCard / LoadPill's LoadCard — click = PINNED open, plus a hover PEEK on hover-capable
 * pointers only. QuotaPill's exact state machine, duplicated inline the same way LoadPill
 * duplicates it (there is no shared composable to import — the pattern lives in each pill):
 * ~150ms enter delay (a pointer transiting the bar must not flash the card), ~200ms close
 * grace covering the chip→card traversal gap, the CARD's own mouseenter cancels a pending
 * close (bindings fall through onto VersionHost's root), phones never auto-open on hover. */
const versionPinned = ref(false);
const versionPeek = ref(false);
const versionOpen = computed(() => versionPinned.value || versionPeek.value);
const hoverFine = useMedia(window, "(hover: hover) and (pointer: fine)").matches;
let versionHoverIn: ReturnType<typeof setTimeout> | undefined;
let versionHoverOut: ReturnType<typeof setTimeout> | undefined;

function onVersionToggle(): void {
  versionPinned.value = !versionPinned.value;
  versionPeek.value = false;
}
function onVersionClose(): void {
  versionPinned.value = false;
  versionPeek.value = false;
}
function stopPeekClose(): void {
  if (versionHoverOut !== undefined) {
    clearTimeout(versionHoverOut);
    versionHoverOut = undefined;
  }
}
function onChipEnter(): void {
  stopPeekClose();
  if (!hoverFine.value || phone.value || versionOpen.value) return;
  versionHoverIn = setTimeout(() => {
    versionHoverIn = undefined;
    versionPeek.value = true;
  }, 150);
}
function schedulePeekClose(): void {
  stopPeekClose();
  versionHoverOut = setTimeout(() => {
    versionHoverOut = undefined;
    versionPeek.value = false;
  }, 200);
}
function onChipLeave(): void {
  if (versionHoverIn !== undefined) {
    clearTimeout(versionHoverIn);
    versionHoverIn = undefined;
  }
  if (!versionPinned.value && versionPeek.value) schedulePeekClose();
}
onUnmounted(() => {
  if (versionHoverIn !== undefined) clearTimeout(versionHoverIn);
  if (versionHoverOut !== undefined) clearTimeout(versionHoverOut);
});
</script>

<template>
  <header class="topbar">
    <span class="brand" :title="brandTitle">
      <span class="brand-mark" :aria-hidden="phone ? undefined : true">
        <AppIcon name="logo" />
        <template v-for="c in connBadgeList" :key="'conn-badge'">
          <!-- auth mirrors the desktop pill's unlock glyph (same danger colour) so a login-needed
               state is recognisable by shape, not just by a red dot -->
          <span
            v-if="c === 'auth'"
            class="conn conn-badge conn-badge-icon"
            :data-conn="c"
            role="status"
            :aria-label="t(connLabelKey)"
            :title="t(connLabelKey)"
            ><AppIcon name="unlock" class="icon-sm"
          /></span>
          <span
            v-else
            class="dot conn conn-badge"
            :class="{ 'dot-live': c === 'connecting' || c === 'reconnecting' }"
            :data-conn="c"
            role="status"
            :aria-label="t(connLabelKey)"
            :title="t(connLabelKey)"
          ></span>
        </template>
      </span>
      <!-- 2026-10-13 用户拍板：品牌区只留 icon+「pi」（web-hub 字样去掉）；全称仍留在 tooltip。 -->
      <span translate="no">pi</span>
    </span>

    <span class="pill conn" :data-conn="conn" role="status">
      <AppIcon v-if="conn === 'connecting'" name="loader" class="icon-sm spin" />
      <AppIcon v-else-if="conn === 'auth'" name="unlock" class="icon-sm" />
      <span v-else class="dot dot-live"></span>
      {{ t(connLabelKey) }}
    </span>

    <QuotaPill v-for="q in quotaList" :key="'quota'" :quota="q" />
    <LoadPill v-for="ld in loadList" :key="'load'" :load="ld" :received-at="loadReceivedAt" />

    <!-- 2026-10-06: only the frontend (ui) version shows in the bar; the hub version stays in
         the brand's title tooltip. -->
    <span v-if="uiStamp" class="version-anchor">
      <button
        ref="versionChipEl"
        type="button"
        class="topbar-meta version-chip"
        translate="no"
        aria-haspopup="dialog"
        :aria-expanded="versionOpen"
        aria-controls="version-panel"
        :title="t('version.chipTitle')"
        @click="onVersionToggle"
        @mouseenter="onChipEnter"
        @mouseleave="onChipLeave"
      >
        {{ t("shell.uiBuild", { v: uiStamp })
        }}<span v-for="lv in dotList" :key="'vdot'" class="version-dot" :data-level="lv"></span>
      </button>
      <VersionHost
        v-if="versionOpen"
        :anchor-el="versionChipEl"
        :peek="versionPeek"
        @close="onVersionClose"
        @mouseenter="onChipEnter"
        @mouseleave="onChipLeave"
      />
    </span>
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

    <template v-for="sc in proxyList" :key="'proxy'">
      <button
        type="button"
        class="btn btn-ghost btn-icon proxy-entry"
        :data-lan="sc.lan ? 'true' : 'false'"
        :aria-label="t('proxy.openBtn')"
        :title="t('proxy.openBtnTitle')"
        aria-haspopup="dialog"
        :aria-expanded="proxyOpen"
        @click="proxyOpen = true"
      >
        <AppIcon name="unplug" />
      </button>
      <ProxyDialog v-if="proxyOpen" @close="proxyOpen = false" />
    </template>

    <LangMenu v-if="!phone" />

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
        <span v-for="lv in dotList" :key="'gdot'" class="version-dot version-dot-gear" :data-level="lv"></span>
      </button>
      <SettingsOverlay
        v-if="open"
        :anchor-el="gearEl"
        :can-sign-out="canSignOut"
        @close="onClose"
        @signout="emit('signout')"
      />
    </span>

    <button
      v-if="canSignOut && !phone"
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
