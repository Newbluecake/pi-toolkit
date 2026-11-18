<script setup lang="ts">
import { registerTerminalV2Extra } from "../../../i18n/terminal-v2-extra.js";
registerTerminalV2Extra();
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "../../../composables/useI18n.js";
import { terminalCanCreateV2, type TerminalRestoreStorageV2 } from "../../../logic/terminal-v2.js";
import { terminalOwnsKey } from "../../../logic/terminalFocus.js";
import AppIcon from "../../../icons/AppIcon.vue";
import type { TerminalTransportV2 } from "../../../transport/terminal-v2.js";
import { loadTerminalFontSize, saveTerminalFontSize } from "../fonts.js";
import { TERMINAL_RENDERER_FACTORY, type TerminalRendererFactory } from "../renderer-port.js";
import type { WebglUiState } from "../webgl-lifecycle.js";
import type { TerminalScopeV2, TerminalTabRowV2 } from "../protocol-v2.js";
import terminalCss from "./terminal-v2.css?url";
import TerminalChromeV2 from "./TerminalChromeV2.vue";
import TerminalTabsV2 from "./TerminalTabsV2.vue";
import { createTerminalControllerV2 } from "./controller.js";

const props = defineProps<{
  transport: TerminalTransportV2;
  scope: TerminalScopeV2;
  storage?: TerminalRestoreStorageV2;
}>();
const emit = defineEmits<{ background: [] }>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const surface = ref<HTMLElement>();
const tabs = ref<InstanceType<typeof TerminalTabsV2>>();
const open = ref(false);
const maximized = ref(false);
const confirmRow = ref<TerminalTabRowV2 | null>(null);
const paste = ref<string | null>(null);
const fontSize = ref(loadTerminalFontSize());
const rendererFactory = inject<TerminalRendererFactory>(TERMINAL_RENDERER_FACTORY, async (...args) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const module = await Promise.race([
      import("./terminal-v2-impl.js"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("E_RENDERER_LOAD_DEADLINE")), 5000);
      }),
    ]);
    return await module.mountTerminal(...args);
  } finally {
    clearTimeout(timer);
  }
});
let renderer: Awaited<ReturnType<TerminalRendererFactory>> | undefined;
let rendererPending: Promise<void> | undefined;
let rendererAbort: AbortController | undefined;
let rendererGeneration = 0;
let disposed = false;
let panelStyle: HTMLLinkElement | undefined;
let panelStylePending: Promise<void> | undefined;
let abortPanelStyle = () => {};
const panelStyleReady = ref(false);
let observer: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let removeInput = () => {};
let lastUserEvent: Event | undefined;
let userGesture = false;
let imeGesture = false;
let responseWritable = false;
let writeGeneration = 0;
let imeTimer: ReturnType<typeof setTimeout> | undefined;
let openFlight: Promise<boolean> | undefined;

function userEvent(event?: KeyboardEvent | InputEvent | CompositionEvent | ClipboardEvent): void {
  if (event) lastUserEvent = event;
  else {
    userGesture = true;
    queueMicrotask(() => {
      userGesture = false;
    });
  }
  if (event?.type === "compositionend" || (event instanceof KeyboardEvent && event.keyCode === 229)) {
    imeGesture = true;
    clearTimeout(imeTimer);
    imeTimer = setTimeout(() => {
      imeTimer = setTimeout(() => {
        imeGesture = false;
      }, 0);
    }, 0);
  }
}

function defaultRestoreStorage(): TerminalRestoreStorageV2 | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}
const restoreStorage = props.storage ?? defaultRestoreStorage();
const controller = createTerminalControllerV2({
  transport: props.transport,
  scope: props.scope,
  ...(restoreStorage !== undefined ? { storage: restoreStorage } : {}),
  hidden: () => document.hidden,
  revoked() {
    confirmRow.value = null;
    paste.value = null;
    lastUserEvent = undefined;
    userGesture = imeGesture = responseWritable = false;
    clearTimeout(imeTimer);
    open.value = false;
    disposeRenderer();
  },
  renderer: {
    async write(bytes) {
      const mine = ++writeGeneration;
      responseWritable = state.writable;
      try {
        if (!renderer) throw new Error("E_RENDERER_NOT_READY");
        await renderer.write(bytes);
      } finally {
        if (mine === writeGeneration) responseWritable = false;
      }
    },
    reset() {
      writeGeneration++;
      responseWritable = false;
      renderer?.terminal?.reset();
    },
    dimensions: () => ({ cols: renderer?.terminal?.cols ?? 80, rows: renderer?.terminal?.rows ?? 24 }),
  },
});
const state = controller.state;
const activeRow = computed(() => state.rows.find((row) => row.termId === state.activeTermId));
const canCreate = computed(
  () => panelStyleReady.value && terminalCanCreateV2(state.quota) && !state.creating && !state.creationUnsettled,
);
const quotaFull = computed(() => !!state.quota && !terminalCanCreateV2(state.quota));
const errorText = computed(() => (state.error.startsWith("E_LIMIT") ? t("terminalV2.limit") : state.error));
const noticeText = computed(() => {
  if (!state.notice) return "";
  return t(`terminalV2.${state.notice}`, { code: state.exitCode ?? "unknown" });
});

function disposeRenderer(): void {
  rendererGeneration++;
  rendererAbort?.abort();
  clearTimeout(resizeTimer);
  observer?.disconnect();
  observer = undefined;
  removeInput();
  removeInput = () => {};
  renderer?.dispose();
  renderer = undefined;
}

function rendererState(next: WebglUiState): void {
  if (disposed) return;
  if (next.phase === "recovering") {
    removeInput();
    controller.detach();
  }
  if (next.phase === "ready" && next.rebuilds > 0) {
    wireInput();
    // Reattach only the selected term. WebGL recovery is never a create intent.
    void controller.reconnect();
  }
  if (next.phase === "reopen-required" || next.phase === "unavailable") {
    removeInput();
    controller.cancelIntent();
    state.error = next.reason;
  }
}

function ensurePanelStyle(): Promise<void> {
  if (panelStylePending) return panelStylePending;
  const link = document.createElement("link");
  panelStyle = link;
  link.rel = "stylesheet";
  link.href = terminalCss;
  panelStylePending = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      link.onload = link.onerror = null;
      if (error || disposed || panelStyle !== link || link.parentNode !== document.head) {
        panelStyleReady.value = false;
        link.remove();
        reject(error ?? new Error("E_PANEL_CSS_ABORTED"));
      } else {
        panelStyleReady.value = true;
        resolve();
      }
    };
    const timer = setTimeout(() => finish(new Error("E_PANEL_CSS_DEADLINE")), 5000);
    link.onload = () => finish();
    link.onerror = () => finish(new Error("E_PANEL_CSS_LOAD"));
    abortPanelStyle = () => finish(new Error("E_PANEL_CSS_ABORTED"));
    document.head.appendChild(link);
  });
  // A lazy mount may never receive open(); still consume a failed stylesheet load.
  void panelStylePending.catch(() => {});
  return panelStylePending;
}

async function ensureRenderer(): Promise<void> {
  await ensurePanelStyle();
  if (disposed || !open.value || !panelStyleReady.value) throw new Error("E_PANEL_CSS_ABORTED");
  if (renderer?.terminal) return;
  if (rendererPending) return rendererPending;
  await nextTick();
  if (!open.value || !surface.value) throw new Error("E_RENDERER_NOT_READY");
  const mine = ++rendererGeneration;
  rendererAbort = new AbortController();
  const surfaceElement = surface.value;
  const abort = rendererAbort;
  rendererPending = (async () => {
    const instance = await rendererFactory(surfaceElement, {
      signal: abort.signal,
      onStateChange: rendererState,
      onEscapeFocus: () => root.value?.querySelector<HTMLButtonElement>("[data-terminal-focus]")?.focus(),
    });
    if (disposed || !open.value || mine !== rendererGeneration) {
      instance.dispose();
      return;
    }
    renderer = instance;
    if (fontSize.value !== 14) renderer.setFontSize(fontSize.value);
    wireInput();
    observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        renderer?.fit();
        void controller.resize().catch(() => {});
      }, 75);
    });
    observer.observe(surfaceElement);
  })().finally(() => {
    rendererPending = undefined;
  });
  return rendererPending;
}

function openPanel(): Promise<boolean> {
  if (openFlight) return openFlight;
  openFlight = (async () => {
    if (disposed) return false;
    open.value = true;
    try {
      await ensureRenderer();
      if (!open.value || disposed) return false;
      const result = await controller.open();
      if (result && activeRow.value) renderer?.focus();
      return result;
    } catch (error) {
      if (open.value && !disposed) state.error = error instanceof Error ? error.message : "E_UNAVAILABLE";
      return false;
    }
  })().finally(() => {
    openFlight = undefined;
  });
  return openFlight;
}

function restorePanel(): Promise<boolean> {
  if (openFlight) return openFlight;
  openFlight = (async () => {
    if (disposed) return false;
    open.value = true;
    try {
      await ensureRenderer();
      if (!open.value || disposed) return false;
      return await controller.restore();
    } catch (error) {
      if (open.value && !disposed) state.error = error instanceof Error ? error.message : "E_UNAVAILABLE";
      return false;
    }
  })().finally(() => {
    openFlight = undefined;
  });
  return openFlight;
}

async function createTab(): Promise<boolean> {
  if (!open.value || !canCreate.value || state.busy) return false;
  try {
    await ensureRenderer();
    return await controller.newTerminal();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "E_UNAVAILABLE";
    return false;
  }
}

function collapse(): void {
  confirmRow.value = null;
  paste.value = null;
  maximized.value = false;
  controller.collapse();
  open.value = false;
  disposeRenderer();
  emit("background");
}

async function selectTab(termId: string): Promise<void> {
  if (disposed || !panelStyleReady.value) return;
  await controller.select(termId);
}

async function renameTab(termId: string, name: string): Promise<void> {
  if (disposed || !panelStyleReady.value) return;
  await controller.rename(termId, name);
}

async function closeTab(row: TerminalTabRowV2): Promise<void> {
  if (disposed || !panelStyleReady.value) return;
  const wasActive = row.termId === state.activeTermId;
  const completed = await controller.close(row.termId);
  if (completed && wasActive) {
    const next = state.rows.find((candidate) => candidate.termId !== row.termId && candidate.state === "live");
    if (next) await controller.select(next.termId);
  }
}

function requestClose(row: TerminalTabRowV2): void {
  if (["starting", "live"].includes(row.state)) {
    confirmRow.value = row;
    void nextTick(() => root.value?.querySelector<HTMLButtonElement>("[data-terminal-cancel]")?.focus());
  } else void closeTab(row);
}

function cancelModal(): void {
  confirmRow.value = null;
  paste.value = null;
  root.value?.querySelector<HTMLButtonElement>("[data-terminal-focus]")?.focus();
}

async function confirmModal(): Promise<void> {
  if (confirmRow.value) {
    const row = confirmRow.value;
    confirmRow.value = null;
    await closeTab(row);
  } else await sendPaste();
}

function modalKeys(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelModal();
    return;
  }
  if (event.key !== "Tab") return;
  const modal = event.currentTarget as HTMLElement;
  const controls = [...modal.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
  const first = controls[0];
  const last = controls.at(-1);
  if (
    first &&
    last &&
    ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function inputAllowed(): boolean {
  return (
    open.value &&
    panelStyleReady.value &&
    state.writable &&
    !confirmRow.value &&
    paste.value === null &&
    !!surface.value?.contains(document.activeElement) &&
    ![...document.querySelectorAll('[aria-modal="true"]')].some(
      (modal) => modal.id !== "fleet-drawer" || !root.value || !modal.contains(root.value),
    )
  );
}

function wireInput(): void {
  removeInput();
  const terminal = renderer?.terminal;
  if (!terminal) return;
  const data = terminal.onData((value) => {
    const user = userGesture || imeGesture || (lastUserEvent !== undefined && lastUserEvent.eventPhase !== Event.NONE);
    if (inputAllowed() && (user || responseWritable))
      controller.input(new TextEncoder().encode(value), user ? "user" : "terminal_response");
  });
  const binary = terminal.onBinary((value) => {
    const user = userGesture || imeGesture || (lastUserEvent !== undefined && lastUserEvent.eventPhase !== Event.NONE);
    if (inputAllowed() && (user || responseWritable))
      controller.input(
        Uint8Array.from(value, (character) => character.charCodeAt(0)),
        user ? "user" : "terminal_response",
      );
  });
  removeInput = () => {
    data.dispose();
    binary.dispose();
  };
}

function onPaste(event: ClipboardEvent): void {
  if (!inputAllowed()) {
    event.preventDefault();
    return;
  }
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (new TextEncoder().encode(text).byteLength > 4096) {
    event.preventDefault();
    state.error = t("terminalV2.pasteTooLarge");
    return;
  }
  if (/[\r\n]/.test(text)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    paste.value = text;
    void nextTick(() => root.value?.querySelector<HTMLButtonElement>("[data-terminal-cancel]")?.focus());
  }
}

function dropText(event: DragEvent): void {
  if (!inputAllowed()) {
    state.error = t("terminalV2.focusFirst");
    return;
  }
  const text = event.dataTransfer?.getData("text/plain") ?? "";
  if (!text || new TextEncoder().encode(text).byteLength > 4096) {
    state.error = t("terminalV2.pasteTooLarge");
    return;
  }
  paste.value = text;
  void nextTick(() => root.value?.querySelector<HTMLButtonElement>("[data-terminal-cancel]")?.focus());
}

async function sendPaste(): Promise<void> {
  const text = paste.value;
  paste.value = null;
  await nextTick();
  if (disposed || !state.writable || text === null) return;
  renderer?.focus();
  if (!inputAllowed()) return;
  userEvent();
  renderer?.terminal?.paste(text);
}

function focus(): void {
  void nextTick(() => {
    renderer?.fit();
    renderer?.focus();
  });
}

async function maximize(): Promise<void> {
  if (disposed || !panelStyleReady.value) return;
  maximized.value = !maximized.value;
  await nextTick();
  renderer?.fit();
  await controller.resize().catch(() => {});
}

function font(step: number): void {
  if (disposed || !panelStyleReady.value) return;
  fontSize.value = Math.max(10, Math.min(24, fontSize.value + step));
  saveTerminalFontSize(fontSize.value);
  renderer?.setFontSize(fontSize.value);
  void controller.resize().catch(() => {});
}

function chromeKeys(event: KeyboardEvent): void {
  if (event.key !== "Escape" || terminalOwnsKey(event) || confirmRow.value || paste.value !== null || !maximized.value)
    return;
  event.preventDefault();
  event.stopPropagation();
  void maximize();
}

function visibilityChanged(): void {
  controller.visibilityChanged();
}

onMounted(() => {
  void ensurePanelStyle();
  document.addEventListener("visibilitychange", visibilityChanged);
  // No list/view/create here. P6 calls open() only from an explicit session-button intent.
});

onBeforeUnmount(() => {
  disposed = true;
  confirmRow.value = null;
  paste.value = null;
  lastUserEvent = undefined;
  clearTimeout(imeTimer);
  clearTimeout(resizeTimer);
  document.removeEventListener("visibilitychange", visibilityChanged);
  abortPanelStyle();
  panelStyleReady.value = false;
  panelStyle?.remove();
  disposeRenderer();
  controller.dispose();
});

defineExpose({ open: openPanel, restore: restorePanel, collapse, focus });
</script>

<template>
  <section
    v-if="open"
    id="terminal-v2-panel"
    ref="root"
    class="terminal-v2-panel"
    :data-writable="state.phase === 'ready'"
    :class="{ 'is-maximized': maximized }"
    role="complementary"
    aria-labelledby="terminal-v2-title"
    @keydown="chromeKeys"
  >
    <TerminalChromeV2
      :maximized="maximized"
      :busy="state.busy"
      :can-rename="!!activeRow"
      @focus="focus"
      @rename="activeRow && tabs?.beginRename(activeRow)"
      @background="collapse"
      @maximize="maximize"
      @font="font"
    />
    <TerminalTabsV2
      ref="tabs"
      :rows="state.rows"
      :active-term-id="state.activeTermId"
      :busy="state.busy || state.creating"
      :can-create="canCreate"
      @select="selectTab"
      @close="requestClose"
      @rename="renameTab"
      @create="createTab"
    />
    <div
      id="terminal-v2-workspace"
      class="terminal-v2-workspace"
      role="tabpanel"
      :aria-labelledby="activeRow ? `terminal-v2-tab-${activeRow.termId}` : undefined"
    >
      <div v-if="activeRow" class="terminal-v2-context">
        <span>{{ activeRow.name }}</span>
        <template v-if="state.metadata">
          <span>· {{ state.metadata.shellName }}</span>
          <span>· {{ state.metadata.userLabel }}@{{ state.metadata.hostLabel }}</span>
          <bdi class="terminal-v2-cwd">· {{ state.metadata.cwd }}</bdi>
        </template>
        <span v-else class="terminal-v2-metadata-missing">{{ t("terminalV2.metadataUnavailable") }}</span>
      </div>
      <div
        ref="surface"
        class="terminal-v2-surface"
        data-terminal-input
        @keydown.capture="userEvent"
        @keypress.capture="userEvent"
        @input.capture="userEvent"
        @compositionend.capture="userEvent"
        @paste.capture="
          userEvent($event);
          onPaste($event);
        "
        @dragover.prevent
        @drop.prevent="dropText"
      ></div>
      <div v-if="!activeRow && state.phase === 'idle'" class="terminal-v2-empty">
        <AppIcon name="terminal" class="icon" />
        <strong>{{ t("terminalV2.empty") }}</strong>
        <p>{{ t("terminalV2.emptyHint") }}</p>
        <button class="btn" type="button" :disabled="state.busy || !canCreate" @click="createTab">
          + {{ t("terminalV2.newTab") }}
        </button>
      </div>
      <p v-if="state.phase === 'loading'" class="terminal-v2-status" role="status">
        {{ t("terminalV2.attaching") }}
      </p>
      <p v-else-if="state.phase === 'replaying'" class="terminal-v2-status" role="status">
        {{ t("terminalV2.replaying") }}
      </p>
      <p v-else-if="state.phase === 'disconnected'" class="terminal-v2-status" role="alert">
        {{ t("terminalV2.disconnected") }}
      </p>
    </div>
    <section v-if="state.unknownResources.length" class="terminal-v2-unknown" aria-label="cleanup-unknown">
      <strong>{{ t("terminalV2.unknownTitle") }} · {{ state.unknownResources.length }}</strong>
      <p>{{ t("terminalV2.unknownHint") }}</p>
    </section>
    <div v-if="state.quota" class="terminal-v2-quota">
      <span>{{
        t("terminalV2.quota", {
          sessionUsed: state.quota.session.used,
          sessionLimit: state.quota.session.limit,
          principalUsed: state.quota.principal.used,
          principalLimit: state.quota.principal.limit,
          totalUsed: state.quota.total.used,
          totalLimit: state.quota.total.limit,
        })
      }}</span>
      <span v-if="quotaFull"> · limit</span>
    </div>
    <p v-if="state.error" class="terminal-v2-error" role="alert">{{ errorText }}</p>
    <p v-if="noticeText" class="terminal-v2-notice" role="status">{{ noticeText }}</p>
    <p v-if="state.gap" class="terminal-v2-notice" role="status">
      {{ t("terminalV2.gap", state.gap) }}
    </p>
    <button
      v-if="state.activeTermId && state.phase === 'disconnected' && !state.busy"
      class="btn terminal-v2-reconnect"
      type="button"
      @click="controller.reconnect"
    >
      {{ t("terminalV2.manualReconnect") }}
    </button>
    <footer class="terminal-v2-footer">{{ t("terminalV2.warning") }} {{ t("terminalV2.escape") }}</footer>
    <div
      v-if="confirmRow || paste !== null"
      class="terminal-v2-confirm"
      role="dialog"
      aria-modal="true"
      :aria-label="confirmRow ? t('terminalV2.confirmCloseTitle') : t('terminalV2.confirmPasteTitle')"
      @keydown="modalKeys"
    >
      <p>
        {{ confirmRow ? t("terminalV2.confirmClose", { name: confirmRow.name }) : t("terminalV2.confirmPaste") }}
      </p>
      <div>
        <button class="btn" type="button" data-terminal-cancel @click="cancelModal">
          {{ t("terminalV2.cancel") }}
        </button>
        <button class="btn" type="button" :disabled="state.busy" @click="confirmModal">
          {{ t("terminalV2.confirm") }}
        </button>
      </div>
    </div>
  </section>
</template>
