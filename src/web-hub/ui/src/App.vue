<!--
  Application root (vue-plan.md v2.1 §1.1, §3.2, §3.3, §3.7-§3.9, §5.2 — P3 exclusive, takes
  over the P0 placeholder). Reads `data-auth-mode`, wires the one `useHub()`/transport pair the
  detected mode needs, and picks `LoginView` / `TokenGate` / the authenticated shell
  (`TopBar` + global notices + `DashboardView`). Renders `IconSprite` once (every icon
  elsewhere is a `<use>` against it) and the single sr-only `role="status"` announcer region
  (ui-design.md §3.12/§11) that `useAnnouncer` (P1) writes into.

  Ordering constraint (plan §3.7, `useHashRoute.ts`'s own doc comment): in token mode,
  `token-client.js`'s `start()` synchronously clears any `#t=` fragment (via
  `history.replaceState`) before its first `await` — calling `hub.start()` and then
  `hashRoute.start()` back-to-back, in the same synchronous tick, guarantees the hash is already
  cleared before the router's own `hashchange` listener attaches, so a token can never be
  mis-parsed as an agent key.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import "./styles/base.css";
import "./styles/primitives.css";
import "./styles/notices.css";
import "./styles/shell.css";
import "./styles/agents.css";
import "./styles/detail.css";
import "./styles/dock.css";
import "./styles/login.css";
import "./styles/states.css";
// #32 C5 (control-plan.md v2.1 §7.4/§7.6): control-plane + ask_user dialog styles.
import "./styles/control.css";
import "./styles/dialog.css";
// PV6 (web-hub-preview plan v3 §4.6): path-ref segments + the preview overlay.
import "./styles/preview.css";
// syntax-highlight (2026-10): tok-* token colors (CSS vars, light/dark per tokens.css).
import "./styles/highlight.css";
import IconSprite from "./icons/IconSprite.vue";
import { browserLocalStorage } from "./components/shell/themeStorage.js";
import { hubVersionStamp } from "@logic/build-stamp.js";
import ControlNotice from "./components/control/ControlNotice.vue";
import { CONTROL_ENV, HUB_CTX, type ControlEnv } from "./components/control/controlContext.js";
import DashboardView from "./components/shell/DashboardView.vue";
import HubStateBanner from "./components/shell/HubStateBanner.vue";
import LoginView from "./components/shell/LoginView.vue";
import NoticeStack from "./components/shell/NoticeStack.vue";
import TokenGate from "./components/shell/TokenGate.vue";
import TopBar from "./components/shell/TopBar.vue";
import PreviewHost from "./components/preview/PreviewHost.vue";
import { PREVIEW_CTX } from "./components/preview/previewContext.js";
import { createAnnouncer } from "./composables/useAnnouncer.js";
import { useHashRoute } from "./composables/useHashRoute.js";
import { useHub } from "./composables/useHub.js";
import { loadKeepAlive } from "@logic/sessionKeepAlive.js";
import { useI18n } from "./composables/useI18n.js";
import { useMedia } from "./composables/useMedia.js";
import { useMotionPref } from "./composables/useMotionPref.js";
import { usePasswordAuth } from "./composables/usePasswordAuth.js";
import { usePreview } from "./composables/usePreview.js";
import { useTheme } from "./composables/useTheme.js";
import { createTokenTransport } from "./transport/token.js";
import type { HubTransport, TransportHooks } from "./transport/types.js";
import type { ConnState, Notice } from "./types.js";

type AuthMode = "token" | "password" | "unknown";

function detectAuthMode(): AuthMode {
  const raw = document.documentElement.dataset["authMode"];
  return raw === "token" || raw === "password" ? raw : "unknown";
}

const authMode = detectAuthMode();
const { t } = useI18n();

// Boot-time theme assert (classes + meta theme-color; `public/theme-init.js` already applied
// the persisted class pre-paint). 2026-10 (user-decided): runtime theme CHANGES moved to the
// settings page (`shell/SettingsView.vue` owns its own `useTheme` instance) — the top bar no
// longer carries a theme control, so nothing here consumes the handle.
useTheme({
  storage: browserLocalStorage(),
  doc: document,
  metaThemeColor: document.querySelector('meta[name="theme-color"]'),
});

// Boot-time motion assert (`public/theme-init.js` already applied the persisted
// `<html data-motion>` attribute pre-paint; this re-asserts it and — because App.vue never
// unmounts — owns the page-lifetime cross-tab `storage` listener, so another tab flipping
// `pwh_motion` re-applies the attribute here even with the settings panel closed. Runtime
// CHANGES live on the settings page (`shell/SettingsView.vue` owns its own instance), the
// same split as the theme block above.
useMotionPref({ storage: browserLocalStorage() });

const announcerEl = ref<HTMLElement | null>(null);
const announcer = createAnnouncer({
  render: (text) => {
    if (announcerEl.value) announcerEl.value.textContent = text;
  },
  doc: document,
  win: window,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
  now: () => Date.now(),
});

// Nothing below this point ever runs when the auth mode couldn't be determined: no `#t=` read,
// no localStorage token access, no request, no SSE (tests/web-hub/ui/app-gate.test.ts;
// migrated from the legacy `auth-mode.test.ts`).
let hub: ReturnType<typeof useHub> | undefined;
let passwordAuth: ReturnType<typeof usePasswordAuth> | undefined;
let hashRoute: ReturnType<typeof useHashRoute> | undefined;

if (authMode !== "unknown") {
  hashRoute = useHashRoute(window);

  const sharedTimers = {
    setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
    clearTimeout: (h: number) => window.clearTimeout(h),
  };

  let createTransport: (hooks: TransportHooks) => HubTransport;
  if (authMode === "password") {
    passwordAuth = usePasswordAuth({
      deps: {
        fetch: (url, init) => window.fetch(url, init),
        EventSource: window.EventSource,
        location: window.location,
        history: window.history,
        ...sharedTimers,
        now: () => Date.now(),
      },
      ...sharedTimers,
      plaintext: window.location.protocol === "http:",
    });
    createTransport = passwordAuth.createTransport;
  } else {
    createTransport = (hooks) =>
      createTokenTransport({
        fetch: (url, init) => window.fetch(url, init),
        EventSource: window.EventSource,
        storage: browserLocalStorage(),
        location: window.location,
        history: window.history,
        ...sharedTimers,
        now: () => Date.now(),
        onMessage: hooks.onMessage,
        onConn: hooks.onConn,
      });
  }

  // web-hub-spawn SP13（SP11/SP12 移交，plan §3.2）：「我发起的」记录 live 时的新会话跳转接到
  // 真实 hash 路由（`#/agent/<key>`）——useHub 的 navigate 选项未接时只发一个内存 route 事件，
  // URL/后退键从不感知；接到 hashRoute.navigate 后是真实 location.hash 变更。
  // D2（web-hub-session-switch plan §1.2 D2-5）：产品默认 K=3 的会话订阅 LRU 保活在此接线 ——
  // useHub 的库级缺省仍是 1（旧行为），浏览器设置 pwh_keepalive 每次切换时重读（改小在下一次
  // 切换时生效）。
  hub = useHub({
    createTransport,
    doc: document,
    win: window,
    ...sharedTimers,
    keepAliveSessions: () => loadKeepAlive(browserLocalStorage()),
    navigate: (agentKey) => {
      hashRoute?.navigate({ name: "agent", key: agentKey });
    },
  });

  // #32 C5 (control-plan v2.1 §7.1/§7.4): the control plane reaches components via inject —
  // the frozen `contracts.ts` props of TopBar/AgentDetail/AgentCard have no hub/control field.
  provide(HUB_CTX, hub);
  provide(CONTROL_ENV, {
    authMode,
    plaintext: authMode === "password" && window.location.protocol === "http:",
    dialogDrafts: new Map(),
    noticeExpanded: ref(false),
  } satisfies ControlEnv);

  // PV6 (web-hub-preview plan v3 §3.2/§4.6, D7): the App-level preview state machine. Scope
  // derivation lives in `usePreview` (`previewScopeOf` — no transport/cap/session ⇒ `null`,
  // and every `PathText` in the tree renders its DOM-equivalent plain text). `PREVIEW_CTX`
  // also feeds `PreviewHost` (mounted below) and carries the §5.2 plaintext-LAN warning flag.
  const preview = usePreview({
    preview: hub.preview,
    mode: authMode,
    state: hub.state,
    coarse: useMedia(window, "(pointer: coarse)").matches,
  });
  provide(PREVIEW_CTX, {
    handle: preview,
    plaintext: authMode === "password" && window.location.protocol === "http:",
  });
}

const route = hashRoute?.route;
const conn = computed<ConnState>(() => hub?.state.value.conn ?? "connecting");

/** Password mode only: the very first "connecting" tick must NOT flash the sign-in form — with
 * a valid session cookie the SSE handshake resolves in a few hundred ms, so every refresh used
 * to show the form for a blink (user field report 2026-10-05). Show a neutral boot splash until
 * auth resolves (open/reconnecting ⇒ dashboard, "auth" ⇒ the form). "connecting" never recurs
 * after boot (drops go "reconnecting"), so this is strictly boot-only. */
const booting = computed(() => authMode === "password" && conn.value === "connecting");
// C5: control negotiated (hub caps include cmd.v1) ⇒ persistent ControlNotice + Control chip.
const controlOn = computed(() => hub?.state.value.control === true);
const hubVersion = computed<string | null>(() => {
  const h = hub?.state.value.hub as { version?: unknown; buildId?: unknown } | null | undefined;
  return hubVersionStamp(h?.version, h?.buildId);
});

/** Password: authenticated once the SSE stream is open (or transiently reconnecting) — during
 * the very first "connecting" tick this deliberately shows the sign-in form rather than a
 * flash of an empty dashboard. Token: no separate sign-in form exists, so only a confirmed
 * `"auth"` (a stored token, if any, already failed a silent re-login) falls through to the
 * "link no longer valid" gate. */
const showDashboard = computed(() => {
  if (authMode === "password") return conn.value === "open" || conn.value === "reconnecting";
  return conn.value !== "auth";
});

const globalNotices = computed<readonly Notice[]>(() => {
  if (authMode !== "password" || passwordAuth?.initialPasswordHint.value !== true) return [];
  return [
    {
      id: "initial-password",
      tone: "warn",
      title: t("notices.initialPasswordLead"),
      body: t("notices.initialPasswordMore"),
      persistent: true,
    },
  ];
});

let lastAnnouncedConn: ConnState | undefined;
function announceConn(next: ConnState): void {
  if (next === lastAnnouncedConn) return;
  lastAnnouncedConn = next;
  announcer.announce(t(`shell.conn.${next}`));
}
if (authMode !== "unknown") watch(conn, announceConn, { immediate: true });

async function onSubmit(payload: { username: string; password: string }): Promise<void> {
  await passwordAuth?.submit(payload);
}

async function onSignOut(): Promise<void> {
  await passwordAuth?.signOut();
}

onMounted(() => {
  if (hub) void hub.start();
  hashRoute?.start();
});

onUnmounted(() => {
  hub?.dispose();
  hashRoute?.dispose();
  passwordAuth?.dispose();
  announcer.dispose();
});
</script>

<template>
  <IconSprite />
  <TokenGate v-if="authMode === 'unknown'" reason="auth-mode-unknown" />
  <template v-else>
    <h1 v-if="showDashboard" class="sr-only">{{ t("shell.dashboardHeading") }}</h1>
    <a v-if="showDashboard" class="skip-link" href="#transcript">{{ t("shell.skipToConversation") }}</a>

    <div v-if="showDashboard" class="app">
      <TopBar :conn="conn" :hub-version="hubVersion" :can-sign-out="authMode === 'password'" @signout="onSignOut" />
      <!-- 2026-10-08 布局修复：三条横幅（HubStateBanner/ControlNotice/NoticeStack）各自条件渲染，
           直接作 .app 的网格项会让 .layout 在它们缺省时掉进 auto 行（auto auto 1fr 的 1fr 行空掉，
           短会话的 composer 悬在半空）。包一层永远存在的容器，保证网格项恒为 3 个。 -->
      <div class="app-notices">
        <HubStateBanner />
        <ControlNotice v-if="controlOn" />
        <NoticeStack :notices="globalNotices" @action="() => {}" />
      </div>
      <DashboardView :hub="hub!" :route="route!" />
    </div>
    <div v-else-if="booting" class="boot-splash" role="status">
      <span class="boot-spinner" aria-hidden="true"></span>
      <span class="sr-only">{{ t("shell.booting") }}</span>
    </div>
    <LoginView
      v-else-if="authMode === 'password'"
      :plaintext="passwordAuth!.plaintext"
      :busy="passwordAuth!.busy.value"
      :error="passwordAuth!.error.value"
      :initial-password-hint="passwordAuth!.initialPasswordHint.value"
      @submit="onSubmit"
    />
    <TokenGate v-else reason="token-invalid" />
    <PreviewHost />
  </template>
  <p v-if="authMode !== 'unknown'" ref="announcerEl" class="sr-only" role="status" aria-live="polite"></p>
</template>
