<!--
  In-page proxy preview dialog (link-preview plan §4.3, package LP3; layout: variant A of
  pwh-preview/proxy-preview.html). Teleports to `<body>` and renders `useProxyPreview`'s
  state machine (`PROXY_PREVIEW_CTX` — provided by App.vue; absent ⇒ nothing renders):

  - header (single row): header icon + the target AS TYPED (mono, ellipsis) + the muted
    「经由 <proxy origin>」 (only once the open response named it) + icon buttons
    重新加载 / 新标签打开 / 关闭 (aria-label + title tooltips);
  - a thin muted standing-hint bar under the header while `ready` (D2: an app that forbids
    embedding shows blank/refused — use 新标签打开; Back walks the frame first);
  - body: `opening` = centered spinner; `ready` = the §2.5 sandboxed iframe (D5:
    PROXY_FRAME_SANDBOX — never `allow-top-navigation*`, never `credentialless`, which would
    drop the gate cookie — plus `referrerpolicy="no-referrer"` and PROXY_FRAME_ALLOW), with a
    loading overlay that escalates to 「仍在加载…」 after 10 s without a `load` event;
    `error` = the prose reason + 「重试」 + the D9 「直接打开原链接 ↗」 native anchor (no
    automatic navigation ever).

  「新标签打开」 runs `useProxyOpen().open(href)` SYNCHRONOUSLY in its click handler
  (`openProxyTab` calls `window.open` before its first await, so popup blockers don't apply)
  and surfaces the existing popup-blocked fallback link / error key in a note line.

  Interaction contract mirrors PreviewHost.vue (§4.6): scrim click closes; Esc closes with
  preventDefault + stopPropagation when focus is OUTSIDE the frame (keystrokes inside the
  cross-origin frame never reach this handler — the close button and scrim stay usable);
  focus enters the panel on open, Tab cycles inside it, and focus returns on close; body
  scroll is locked while open and always restored (close path AND unmount path). No
  `message` listener (PreviewHtml precedent). The iframe is keyed by the generation counter
  and never re-parented (§2.3).
-->
<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from "vue";
import { PROXY_FRAME_ALLOW, PROXY_FRAME_SANDBOX } from "@protocol/proxy.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useProxyOpen } from "../../composables/useProxyOpen.js";
import type { ProxyPreviewView } from "../../composables/useProxyPreview.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import { PROXY_PREVIEW_CTX } from "./proxyPreviewContext.js";
import "../../styles/proxy-preview.css";

const ctx = inject(PROXY_PREVIEW_CTX, null);
const { t } = useI18n();
/** The X2 new-tab flow behind 「新标签打开」 — its `open()` is synchronous up to and including
 * `window.open`, so calling it from the click handler keeps the user activation. */
const tab = useProxyOpen();

const view = computed<ProxyPreviewView>(() => ctx?.handle.view.value ?? { phase: "closed" });
const isOpen = computed(() => ctx !== null && view.value.phase !== "closed");
const href = computed(() => ("href" in view.value ? view.value.href : ""));
const origin = computed(() => (view.value.phase === "ready" ? view.value.origin : null));

/** Popup-blocked fallback / open failure from 「新标签打开」, shown as a note under the header. */
const tabNote = computed(() => {
  const key = tab.errorKey.value;
  const url = tab.fallbackUrl.value;
  return key === null && url === null ? null : { key, url };
});

function close(): void {
  tab.clear();
  ctx?.handle.close();
}
function reload(): void {
  ctx?.handle.reload();
}
/** MUST stay synchronous up to `tab.open(...)`: `window.open` fires inside this handler. */
function openInTab(): void {
  const h = href.value;
  if (h === "") return;
  void tab.open(h);
}

// --- iframe load tracking (§4.3: after 10 s without `load` ⇒ 「仍在加载…」) ---
const frameLoaded = ref(false);
const frameSlow = ref(false);
let slowTimer: ReturnType<typeof setTimeout> | undefined;

function clearSlowTimer(): void {
  if (slowTimer !== undefined) clearTimeout(slowTimer);
  slowTimer = undefined;
}

watch(
  () => (view.value.phase === "ready" ? view.value.gen : null),
  (g) => {
    frameLoaded.value = false;
    frameSlow.value = false;
    clearSlowTimer();
    if (g !== null)
      slowTimer = setTimeout(() => {
        frameSlow.value = true;
      }, 10_000);
  },
  { immediate: true },
);

function onFrameLoad(): void {
  frameLoaded.value = true;
  frameSlow.value = false;
  clearSlowTimer();
}

onUnmounted(clearSlowTimer);

// --- focus management + scroll lock (PreviewHost.vue §4.6 pattern: 焦点进入、循环、归还；
// 滚动锁一定会清理 — close path AND unmount path) ---
const panelEl = ref<HTMLElement | null>(null);
let returnFocus: Element | null = null;
// Shared ref-counted lock (useScrollLock.ts): composes with other overlays' holds.
let releaseScrollLock: (() => void) | null = null;

function restoreScroll(): void {
  releaseScrollLock?.(); // idempotent
  releaseScrollLock = null;
}

watch(
  isOpen,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement;
      releaseScrollLock = acquireBodyScrollLock();
      await nextTick();
      panelEl.value?.focus();
      return;
    }
    restoreScroll();
    const target = returnFocus;
    returnFocus = null;
    if (target instanceof HTMLElement && document.contains(target)) target.focus();
  },
  { immediate: true },
);

onUnmounted(restoreScroll);

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(ev: KeyboardEvent): void {
  const panel = panelEl.value;
  if (panel === null) return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    ev.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = active === null || !panel.contains(active);
  if (ev.shiftKey && (outside || active === first)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (outside || active === last)) {
    ev.preventDefault();
    first.focus();
  }
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    // The overlay owns Esc while open (keystrokes inside the cross-origin frame never reach
    // here — the close button and scrim stay usable).
    ev.preventDefault();
    ev.stopPropagation();
    close();
    return;
  }
  if (ev.key === "Tab") trapTab(ev);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="proxy-preview-overlay" @click.self="close" @keydown="onKeydown">
      <div
        ref="panelEl"
        class="proxy-preview-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('proxy.preview.dialogLabel')"
        tabindex="-1"
      >
        <header class="proxy-preview-header">
          <AppIcon name="radio" class="icon-sm proxy-preview-header-icon" />
          <div class="proxy-preview-headtext">
            <span class="proxy-preview-target" :title="href" translate="no">{{ href }}</span>
            <span v-if="origin !== null" class="proxy-preview-origin" translate="no"
              ><span class="proxy-preview-via">{{ t("proxy.preview.via") }}</span
              >{{ origin }}</span
            >
          </div>
          <span class="proxy-preview-actions">
            <button
              class="btn btn-ghost btn-icon proxy-preview-reload"
              type="button"
              :aria-label="t('proxy.preview.reload')"
              :title="t('proxy.preview.reload')"
              @click="reload"
            >
              <AppIcon name="refresh" />
            </button>
            <button
              class="btn btn-ghost btn-icon proxy-preview-open-tab"
              type="button"
              :aria-label="t('proxy.preview.openTab')"
              :title="t('proxy.preview.openTab')"
              @click="openInTab"
            >
              <AppIcon name="arrow-up" />
            </button>
            <button
              class="btn btn-ghost btn-icon proxy-preview-close"
              type="button"
              :aria-label="t('proxy.preview.close')"
              :title="t('proxy.preview.close')"
              @click="close"
            >
              <AppIcon name="x" />
            </button>
          </span>
        </header>
        <p v-if="tabNote !== null" class="proxy-preview-note" role="status">
          <template v-if="tabNote.key !== null">{{ t(tabNote.key) }}</template>
          <template v-else-if="tabNote.url !== null"
            >{{ t("proxy.blockedNote") }}
            <a :href="tabNote.url" target="_blank" rel="noopener noreferrer">{{ t("proxy.blockedLink") }}</a></template
          >
        </p>
        <p v-if="view.phase === 'ready'" class="proxy-preview-hint" role="note">
          <AppIcon name="info" class="icon-sm" />
          <span>{{ t("proxy.preview.hint") }}</span>
        </p>
        <div class="proxy-preview-body">
          <div v-if="view.phase === 'opening'" class="proxy-preview-loading" role="status">
            <AppIcon name="loader" class="proxy-preview-spinner spin" />
            <span>{{ t("proxy.preview.opening") }}</span>
          </div>
          <div v-else-if="view.phase === 'ready'" class="proxy-preview-stage">
            <!-- §2.5 (D5): PROXY_FRAME_SANDBOX — never allow-top-navigation*, NEVER
                 `credentialless` (it would drop the Lax gate cookie). Keyed by gen, never
                 re-parented; src is the hub's one-time enter URL, used unmodified. -->
            <iframe
              :key="view.gen"
              class="proxy-preview-frame"
              :src="view.enterUrl"
              :sandbox="PROXY_FRAME_SANDBOX"
              referrerpolicy="no-referrer"
              :allow="PROXY_FRAME_ALLOW"
              allowfullscreen
              :title="t('proxy.preview.frameTitle')"
              @load="onFrameLoad"
            ></iframe>
            <div v-if="!frameLoaded" class="proxy-preview-frame-loading" role="status">
              <AppIcon name="loader" class="proxy-preview-spinner spin" />
              <span>{{ frameSlow ? t("proxy.preview.stillLoading") : t("proxy.preview.opening") }}</span>
            </div>
          </div>
          <div v-else-if="view.phase === 'error'" class="proxy-preview-error">
            <AppIcon name="alert" class="proxy-preview-error-icon" />
            <h3 class="proxy-preview-error-title">{{ t("proxy.preview.errorTitle") }}</h3>
            <p class="proxy-preview-error-detail">{{ t(view.key) }}</p>
            <div class="proxy-preview-error-actions">
              <button class="btn proxy-preview-retry" type="button" @click="reload">
                <AppIcon name="refresh" class="icon-sm" />
                <span>{{ t("proxy.preview.retry") }}</span>
              </button>
              <!-- D9: a native anchor, never an automatic navigation. -->
              <a class="proxy-preview-original" :href="view.href" target="_blank" rel="noopener noreferrer"
                >{{ t("proxy.preview.openOriginal") }} ↗</a
              >
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
