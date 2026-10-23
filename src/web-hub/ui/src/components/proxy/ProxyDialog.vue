<!--
  「打开本机端口」dialog (web-hub-proxy plan v2 §8, package X2). Lazy chunk, mounted by TopBar
  (`v-if` — mount/unmount IS open/close) through `ProxyHost`'s `defineAsyncComponent`, Teleported to
  `<body>`.

  Holds (and nothing more — v1 is deliberately trimmed): the `host:port` / URL input + open button,
  a basic list of open proxies (target, origin, 「打开」, 「停止」) fetched when the dialog opens and
  after each action (NO polling, no traffic stats), and the prose LAN / tunnel / reverse-proxy notes.

  Open flow: `useProxyOpen().open()` opens a blank tab synchronously inside the click handler,
  then navigates it to the one-time enter URL (popup blocked ⇒ the URL is shown as a link below
  the form; it is cleared as soon as the dialog closes).

  Overlay contract (PrivacyUnmarkDialog's precedent): scrim click closes, Escape closes with
  `preventDefault()` + `stopPropagation()` (capture listener acts only while this is the TOPMOST
  open overlay), Tab cycles inside the panel, focus enters the input and returns to the opener,
  body scroll lock is ref-counted and always released.
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { ProxyListItem } from "@protocol/proxy.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useProxyOpen } from "../../composables/useProxyOpen.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import { proxyErrorKey } from "@logic/proxy.js";
import { MODAL_OVERLAY_ROOTS } from "@logic/overlayRoots.js";
import type { ProxyListView } from "../../types.js";
import "../../styles/proxy-dialog.css";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const proxy = useProxyOpen();

const target = ref("");
const list = ref<ProxyListView>({ phase: "idle" });
const stoppingId = ref<string | null>(null);
const actionErrorKey = ref<string | null>(null);

const scrimEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

const canSubmit = computed(() => target.value.trim() !== "" && !proxy.busy.value);
const errorKey = computed(() => proxy.errorKey.value ?? actionErrorKey.value);

let listSeq = 0;
let listCtl: AbortController | null = null;

async function refreshList(): Promise<void> {
  const tr = proxy.transport.value;
  if (tr === null) return;
  listCtl?.abort();
  const ctl = new AbortController();
  listCtl = ctl;
  const seq = ++listSeq;
  list.value = { phase: "loading" };
  const out = await tr.list({ signal: ctl.signal });
  if (seq !== listSeq) return; // superseded or unmounted
  if (out.ok) list.value = { phase: "ready", items: out.items, policy: out.policy };
  else
    list.value = {
      phase: "error",
      status: out.status,
      error: out.error,
      ...(out.reason === undefined ? {} : { reason: out.reason }),
    };
}

/** `[v6]:port` for an IPv6 host token, `host:port` otherwise (the hub's `parseProxyTarget` grammar). */
function hostPortOf(item: ProxyListItem): string {
  const h = item.target.host;
  return h.includes(":") && !h.startsWith("[")
    ? `[${h}]:${String(item.target.port)}`
    : `${h}:${String(item.target.port)}`;
}

function listErrorText(): string {
  const l = list.value;
  return l.phase === "error"
    ? t(proxyErrorKey({ status: l.status, error: l.error, ...(l.reason === undefined ? {} : { reason: l.reason }) }))
    : "";
}

async function openTarget(text: string): Promise<void> {
  actionErrorKey.value = null;
  const ok = await proxy.open(text);
  if (ok) void refreshList();
}

function onSubmit(): void {
  const text = target.value.trim();
  if (text === "") return;
  void openTarget(text);
}

function onOpenItem(item: ProxyListItem): void {
  void openTarget(hostPortOf(item));
}

async function onStopItem(item: ProxyListItem): Promise<void> {
  const tr = proxy.transport.value;
  if (tr === null || stoppingId.value !== null) return;
  actionErrorKey.value = null;
  proxy.clear();
  stoppingId.value = item.instanceId;
  const out = await tr.stop(item.instanceId);
  stoppingId.value = null;
  // 404 = already gone: the refreshed list is the answer, not an error.
  if (!out.ok && out.status !== 404) actionErrorKey.value = proxyErrorKey(out);
  void refreshList();
}

function onClose(): void {
  emit("close");
}

// --- overlay contract (see the header) ------------------------------------------------------
let returnFocus: Element | null = null;
let releaseScrollLock: (() => void) | null = null;

onMounted(async () => {
  returnFocus = document.activeElement;
  releaseScrollLock = acquireBodyScrollLock();
  document.addEventListener("keydown", onDocumentKeydown, true);
  void refreshList();
  await nextTick();
  inputEl.value?.focus();
});

onUnmounted(() => {
  listSeq++;
  listCtl?.abort();
  proxy.clear(); // drops the popup-blocked fallback link (one-time code) with the dialog
  releaseScrollLock?.();
  releaseScrollLock = null;
  document.removeEventListener("keydown", onDocumentKeydown, true);
  const el = returnFocus;
  returnFocus = null;
  if (el instanceof HTMLElement && document.contains(el)) el.focus();
});

/** Topmost decision per logic/overlayRoots.ts (preview-windows §5.2) + this dialog's own
 *  `.proxy-scrim`; the desktop modeless preview-window root stays out of the decision. */
const PROXY_OVERLAY_ROOTS = MODAL_OVERLAY_ROOTS + ", .proxy-scrim";

function ownsDocumentKeydown(ev: KeyboardEvent): boolean {
  const panel = panelEl.value;
  if (panel === null) return false;
  if (ev.target instanceof Node && panel.contains(ev.target)) return false; // scrim path handles it
  const roots = Array.from(document.querySelectorAll(PROXY_OVERLAY_ROOTS));
  for (const root of roots) {
    if (root !== scrimEl.value && ev.target instanceof Node && root.contains(ev.target)) return false;
  }
  const last = roots[roots.length - 1];
  return last === undefined || last === scrimEl.value;
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" && ev.key !== "Tab") return;
  if (!ownsDocumentKeydown(ev)) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    onClose();
    return;
  }
  trapTab(ev);
}

function onScrimKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    onClose();
    return;
  }
  if (ev.key === "Tab") trapTab(ev);
}

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
</script>

<template>
  <Teleport to="body">
    <div ref="scrimEl" class="proxy-scrim" @click.self="onClose" @keydown="onScrimKeydown">
      <section ref="panelEl" class="proxy-dialog" role="dialog" aria-modal="true" :aria-label="t('proxy.dialogTitle')">
        <header class="proxy-head">
          <h3 class="proxy-title">
            <AppIcon name="unplug" class="icon-sm" />
            {{ t("proxy.dialogTitle") }}
          </h3>
          <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('proxy.close')" @click="onClose">
            <AppIcon name="x" />
          </button>
        </header>
        <p class="proxy-intro">{{ t("proxy.intro") }}</p>

        <form class="form proxy-form" novalidate @submit.prevent="onSubmit">
          <div class="field">
            <label for="proxy-target">{{ t("proxy.targetLabel") }}</label>
            <div class="proxy-input-row">
              <input
                id="proxy-target"
                ref="inputEl"
                v-model="target"
                class="input"
                name="target"
                type="text"
                inputmode="url"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                maxlength="512"
                :placeholder="t('proxy.targetPlaceholder')"
                :disabled="proxy.busy.value"
              />
              <button class="btn btn-primary" type="submit" :disabled="!canSubmit">
                {{ proxy.busy.value ? t("proxy.submitting") : t("proxy.submit") }}
              </button>
            </div>
            <p class="proxy-hint">{{ t("proxy.targetHint") }}</p>
          </div>
          <p v-if="errorKey !== null" class="form-error proxy-error" role="alert">{{ t(errorKey) }}</p>
          <p v-if="proxy.fallbackUrl.value !== null" class="proxy-blocked" role="status">
            {{ t("proxy.blockedNote") }}
            <a :href="proxy.fallbackUrl.value" target="_blank" rel="noopener noreferrer">{{
              t("proxy.blockedLink")
            }}</a>
          </p>
        </form>

        <section class="proxy-list" :aria-label="t('proxy.listTitle')">
          <div class="proxy-list-head">
            <h4>{{ t("proxy.listTitle") }}</h4>
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              :aria-label="t('proxy.listRefresh')"
              :title="t('proxy.listRefresh')"
              :disabled="list.phase === 'loading'"
              @click="refreshList"
            >
              <AppIcon name="refresh" class="icon-sm" />
            </button>
          </div>
          <p v-if="list.phase === 'idle' || list.phase === 'loading'" class="proxy-muted" role="status">
            {{ t("proxy.listLoading") }}
          </p>
          <div v-else-if="list.phase === 'error'" class="proxy-list-error">
            <p class="form-error" role="alert">{{ listErrorText() }}</p>
            <button class="btn btn-ghost" type="button" @click="refreshList">{{ t("proxy.listRetry") }}</button>
          </div>
          <p v-else-if="list.items.length === 0" class="proxy-muted">{{ t("proxy.listEmpty") }}</p>
          <ul v-else class="proxy-items">
            <li v-for="item in list.items" :key="item.instanceId" class="proxy-item">
              <div class="proxy-item-main">
                <span class="proxy-item-target" translate="no">{{ item.target.host }}:{{ item.target.port }}</span>
                <span class="proxy-item-meta" translate="no"
                  >{{ t("proxy.cls." + item.target.cls) }} · {{ item.origin
                  }}<template v-if="item.mine"> · {{ t("proxy.itemMine") }}</template></span
                >
              </div>
              <div class="proxy-item-actions">
                <button class="btn btn-ghost" type="button" :disabled="proxy.busy.value" @click="onOpenItem(item)">
                  {{ t("proxy.itemOpen") }}
                </button>
                <button class="btn btn-ghost" type="button" :disabled="stoppingId !== null" @click="onStopItem(item)">
                  {{ stoppingId === item.instanceId ? t("proxy.itemStopping") : t("proxy.itemStop") }}
                </button>
              </div>
            </li>
          </ul>
        </section>

        <div class="proxy-notes">
          <p v-if="list.phase === 'ready'">
            {{
              t("proxy.policy", {
                max: list.policy.maxProxies,
                lo: list.policy.portRange[0],
                hi: list.policy.portRange[1],
              })
            }}
          </p>
          <p v-if="list.phase === 'ready'">{{ list.policy.lan ? t("proxy.noteLanOn") : t("proxy.noteLanOff") }}</p>
          <p v-if="list.phase === 'ready'">
            {{ t("proxy.noteTunnel", { lo: list.policy.portRange[0], hi: list.policy.portRange[1] }) }}
          </p>
          <p>{{ t("proxy.noteReverse") }}</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
