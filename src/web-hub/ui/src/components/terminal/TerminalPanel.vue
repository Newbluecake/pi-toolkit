<script setup lang="ts">
import { registerTerminalExtra } from "../../i18n/terminal-extra.js";
registerTerminalExtra();
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { HubHandle } from "../../types.js";
import { useI18n } from "../../composables/useI18n.js";
import { createTerminalController, type TerminalRow, type TerminalScope } from "./controller.js";
import type { WebglUiState } from "./webgl-lifecycle.js";
import { TERMINAL_RENDERER_FACTORY, type TerminalRendererFactory } from "./renderer-port.js";
const rendererFactory = inject<TerminalRendererFactory>(TERMINAL_RENDERER_FACTORY, async (...args) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const module = await Promise.race([
      import("./terminal-impl.js"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("终端渲染器加载超时，请重试。")), 5000);
      }),
    ]);
    return await module.mountTerminal(...args);
  } finally {
    clearTimeout(timer);
  }
});
import { loadTerminalFontSize, saveTerminalFontSize } from "./fonts.js";
import terminalCss from "./terminal.css?url";
import TerminalChrome from "./TerminalChrome.vue";
import TerminalList from "./TerminalList.vue";
const props = defineProps<{ hub: HubHandle; scope: TerminalScope }>();
const emit = defineEmits<{ background: [] }>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const surface = ref<HTMLElement>();
const maximized = ref(false),
  listing = ref(true),
  confirmRow = ref<TerminalRow | null>(null);
const paste = ref<string | null>(null);
const height = ref(320);
const fontSize = ref(loadTerminalFontSize());
function font(step: number) {
  fontSize.value = Math.max(10, Math.min(24, fontSize.value + step));
  saveTerminalFontSize(fontSize.value);
  renderer?.setFontSize(fontSize.value);
  void controller.resize().catch(controller.fail);
}
let renderer: Awaited<ReturnType<TerminalRendererFactory>> | undefined;
let rendererPending: Promise<void> | undefined;
let rendererAbort: AbortController | undefined;
let rendererGeneration = 0;
let disposed = false;
let panelStyle: HTMLLinkElement | undefined;
let stopEvents = () => {};
let observer: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let removeInput = () => {};
let lastUserEvent: Event | undefined;
let userGesture = false,
  imeGesture = false,
  responseWritable = false,
  writeGeneration = 0;
let imeTimer: ReturnType<typeof setTimeout> | undefined;
function userEvent(event?: KeyboardEvent | InputEvent | CompositionEvent | ClipboardEvent) {
  if (event) lastUserEvent = event;
  else {
    userGesture = true;
    queueMicrotask(() => {
      userGesture = false;
    });
  }
  // xterm 6's public IME input is emitted one macrotask after compositionend/229.
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
const controller = createTerminalController({
  transport: props.hub.terminal!,
  scope: props.scope,
  revoked() {
    paste.value = null;
    confirmRow.value = null;
    lastUserEvent = undefined;
    userGesture = imeGesture = responseWritable = false;
    clearTimeout(imeTimer);
    rendererGeneration++;
    rendererAbort?.abort();
    removeInput();
    renderer?.dispose();
    renderer = undefined;
    observer?.disconnect();
    listing.value = true;
  },
  clientId: () => props.hub.state.value.clientId,
  renderer: {
    async write(bytes) {
      const mine = ++writeGeneration;
      responseWritable = state.writable;
      try {
        if (!renderer) throw new Error("WebGL 界面未就绪。");
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
const errorText = computed(() => {
  const code = state.error.split(" ")[0];
  const key =
    code === "E_UNSUPPORTED"
      ? "terminal.unsupported"
      : code === "E_BACKEND_CAPABILITY"
        ? "terminal.backendUnavailable"
        : code === "E_WRITER_BUSY"
          ? "terminal.writerBusy"
          : code === "E_RESOURCE_QUARANTINED"
            ? "terminal.quarantined"
            : code === "E_AUTH_REVOKING" || code === "E_AUTH"
              ? "terminal.loginRequired"
              : null;
  return key ? `${t(key)} (${state.error})` : state.error;
});
function modalKeys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelConfirm();
    return;
  }
  if (event.key !== "Tab") return;
  const modal = event.currentTarget as HTMLElement;
  const controls = [...modal.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
  const first = controls[0],
    last = controls.at(-1);
  if (
    first &&
    last &&
    ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
function dropText(event: DragEvent) {
  if (!inputAllowed()) {
    state.error = t("terminal.focusFirst");
    return;
  }
  const text = event.dataTransfer?.getData("text/plain") ?? "";
  if (!text || new TextEncoder().encode(text).length > 4096) {
    state.error = t("terminal.pasteTooLarge");
    return;
  }
  paste.value = text;
  void nextTick(() => root.value?.querySelector<HTMLButtonElement>("[data-terminal-cancel]")?.focus());
}
function inputAllowed() {
  return (
    state.writable &&
    !listing.value &&
    !confirmRow.value &&
    paste.value === null &&
    !!surface.value?.contains(document.activeElement) &&
    !document.querySelector('[aria-modal="true"]')
  );
}
function wireInput() {
  removeInput();
  const term = renderer?.terminal;
  if (!term) return;
  const data = term.onData((value) => {
    const user = userGesture || imeGesture || (lastUserEvent !== undefined && lastUserEvent.eventPhase !== Event.NONE);
    if (inputAllowed() && (user || responseWritable))
      controller.input(new TextEncoder().encode(value), user ? "user" : "terminal_response");
  });
  const binary = term.onBinary((value) => {
    const user = userGesture || imeGesture || (lastUserEvent !== undefined && lastUserEvent.eventPhase !== Event.NONE);
    if (inputAllowed() && (user || responseWritable))
      controller.input(
        Uint8Array.from(value, (c) => c.charCodeAt(0)),
        user ? "user" : "terminal_response",
      );
  });
  removeInput = () => {
    data.dispose();
    binary.dispose();
  };
}
function rendererState(s: WebglUiState) {
  if (disposed) return;
  if (s.phase === "recovering") {
    removeInput();
    void controller.detach().catch(controller.fail);
  }
  if (s.phase === "ready" && s.rebuilds > 0) {
    wireInput();
    const row = state.current;
    if (row) void controller.action(() => controller.attach(row));
  }
  if (s.phase === "reopen-required" || s.phase === "unavailable") {
    removeInput();
    void controller.detach().catch(() => {});
    state.error = s.reason;
  }
}
async function ensureRenderer() {
  listing.value = false;
  await nextTick();
  if (renderer?.terminal) return;
  if (renderer) {
    removeInput();
    observer?.disconnect();
    renderer.dispose();
    renderer = undefined;
  }
  if (rendererPending) return rendererPending;
  const mine = ++rendererGeneration;
  rendererAbort = new AbortController();
  rendererPending = (async () => {
    if (!surface.value) throw new Error("终端界面不可用。");
    const instance = await rendererFactory(surface.value, {
      signal: rendererAbort.signal,
      onStateChange: rendererState,
      onEscapeFocus: () => root.value?.querySelector<HTMLButtonElement>("[data-terminal-focus]")?.focus(),
    });
    if (disposed || mine !== rendererGeneration) {
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
        void controller.resize().catch(controller.fail);
      }, 75);
    });
    observer.observe(surface.value);
  })().finally(() => {
    rendererPending = undefined;
  });
  return rendererPending;
}
function create() {
  void controller.action(async (guard) => {
    await ensureRenderer();
    guard();
    if (!disposed) {
      await controller.open();
      guard();
      renderer?.focus();
    }
  });
}
function attach(row: TerminalRow) {
  void controller.action(async (guard) => {
    await ensureRenderer();
    guard();
    if (!disposed) {
      await controller.attach(row);
      guard();
      renderer?.focus();
    }
  });
}
async function showList() {
  await controller.action(async (guard) => {
    await controller.detach();
    guard();
    listing.value = true;
    await controller.list();
  });
}
function focus() {
  if (renderer?.terminal) {
    listing.value = false;
    void nextTick(() => {
      renderer?.fit();
      renderer?.focus();
    });
  }
}
async function background() {
  const completed = await controller.action(() => controller.detach());
  if (completed && !state.error) emit("background");
}
async function maximize() {
  maximized.value = !maximized.value;
  await nextTick();
  renderer?.fit();
  await controller.resize().catch(controller.fail);
}
function terminate(row: TerminalRow) {
  confirmRow.value = row;
  void nextTick(() => root.value?.querySelector<HTMLButtonElement>("[data-terminal-cancel]")?.focus());
}
function cancelConfirm() {
  confirmRow.value = null;
  paste.value = null;
  root.value?.querySelector<HTMLButtonElement>("[data-terminal-focus]")?.focus();
}
async function kill() {
  const row = confirmRow.value;
  if (!row) return;
  confirmRow.value = null;
  const completed = await controller.action(() => controller.close(row));
  if (completed && !state.error) await showList();
}
function onPaste(event: ClipboardEvent) {
  if (!inputAllowed()) {
    event.preventDefault();
    return;
  }
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (new TextEncoder().encode(text).length > 4096) {
    event.preventDefault();
    state.error = t("terminal.pasteTooLarge");
    return;
  }
  if (/[\r\n]/.test(text)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    paste.value = text;
    void nextTick(() => root.value?.querySelector<HTMLButtonElement>("[data-terminal-cancel]")?.focus());
  }
}
async function sendPaste() {
  const text = paste.value;
  paste.value = null;
  // Remove the higher modal first; its focus must not freeze this explicit user paste.
  await nextTick();
  if (disposed || !state.writable || text === null) return;
  renderer?.focus();
  if (!inputAllowed()) return;
  userEvent();
  renderer?.terminal?.paste(text);
}
function adjust(event: KeyboardEvent) {
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    height.value = Math.max(
      160,
      Math.min(window.innerHeight * 0.7, height.value + (event.key === "ArrowUp" ? 20 : -20)),
    );
    applyHeight();
  }
}
function applyHeight() {
  if (root.value) root.value.style.height = `${height.value}px`;
  renderer?.fit();
  void controller.resize().catch(controller.fail);
}
let endDrag = () => {};
function drag(event: PointerEvent) {
  const start = event.clientY,
    original = height.value;
  const move = (e: PointerEvent) => {
    height.value = Math.max(160, Math.min(window.innerHeight * 0.7, original + start - e.clientY));
    applyHeight();
  };
  endDrag();
  window.addEventListener("pointermove", move);
  endDrag = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", endDrag);
  };
  window.addEventListener("pointerup", endDrag, { once: true });
}
onMounted(() => {
  panelStyle = document.createElement("link");
  panelStyle.rel = "stylesheet";
  panelStyle.href = terminalCss;
  document.head.appendChild(panelStyle);
  stopEvents = props.hub.terminalEvents?.(controller.event) ?? (() => {});
  void showList();
});
onBeforeUnmount(() => {
  disposed = true;
  paste.value = null;
  confirmRow.value = null;
  lastUserEvent = undefined;
  rendererGeneration++;
  rendererAbort?.abort();
  clearTimeout(imeTimer);
  responseWritable = false;
  writeGeneration++;
  panelStyle?.remove();
  stopEvents();
  endDrag();
  observer?.disconnect();
  clearTimeout(resizeTimer);
  removeInput();
  renderer?.dispose();
  controller.dispose();
});
</script>
<template>
  <section
    id="terminal-panel"
    ref="root"
    class="terminal-panel"
    :data-writable="state.writable || undefined"
    :class="{ 'is-maximized': maximized }"
    :aria-label="t('terminal.title')"
  >
    <div
      class="terminal-resize"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      :aria-label="t('terminal.resize')"
      :aria-valuenow="height"
      @keydown="adjust"
      @pointerdown.prevent="drag"
    ></div>
    <TerminalChrome
      :maximized="maximized"
      :busy="state.busy"
      :attached="state.current?.state === 'live'"
      @font="font"
      @focus="focus"
      @list="showList"
      @background="background"
      @maximize="maximize"
      @terminate="state.current && terminate(state.current)"
    />
    <p class="terminal-warning">{{ t("terminal.warning") }}</p>
    <p class="terminal-warning">{{ t("terminal.recovery") }}</p>
    <p class="terminal-hint">{{ t("terminal.escape") }}</p>
    <p v-if="state.current" class="terminal-facts">
      <span>{{
        state.current.sessionOrdinal !== undefined
          ? `#${state.current.sessionOrdinal}`
          : t("terminal.metadataUnavailable")
      }}</span>
      <span v-if="state.current.shellName"> · {{ state.current.shellName }}</span>
      <span v-if="state.current.userLabel"> · {{ state.current.userLabel }}</span>
      <span v-if="state.current.hostLabel">@{{ state.current.hostLabel }}</span>
      <span v-if="state.current.cwd"> · {{ state.current.cwd }}</span>
      <span v-if="state.current.ownerLabel"> · {{ state.current.ownerLabel }}</span>
      <span v-if="!state.current.userLabel || !state.current.hostLabel || !state.current.cwd">
        · {{ t("terminal.metadataUnavailable") }}</span
      >
      <br />idle {{ new Date(state.current.deadlines.inputIdleAt).toLocaleTimeString() }} · hard
      {{ new Date(state.current.deadlines.lifetimeAt).toLocaleTimeString() }}
    </p>
    <p v-if="state.error" role="alert">{{ errorText }}</p>
    <p v-if="state.gap" role="status">{{ state.gap }}</p>
    <p
      v-if="
        state.current &&
        (state.current.sessionOrdinal === undefined ||
          !state.current.userLabel ||
          !state.current.hostLabel ||
          !state.current.cwd)
      "
      class="terminal-warning"
    >
      {{ t("terminal.metadataHint") }}
    </p>
    <TerminalList
      v-if="listing"
      :rows="state.rows"
      :busy="state.busy"
      @create="create"
      @attach="attach"
      @terminate="terminate"
    />
    <button
      v-if="!listing && !state.writable && state.current?.state === 'live'"
      class="btn"
      :disabled="state.busy"
      @click="attach(state.current)"
    >
      {{ t("terminal.attach") }}
    </button>
    <div
      v-show="!listing"
      ref="surface"
      class="terminal-surface"
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
    <div
      v-if="confirmRow || paste !== null"
      class="terminal-confirm"
      role="dialog"
      aria-modal="true"
      :aria-label="t('terminal.confirmTitle')"
      @keydown="modalKeys"
    >
      <p>{{ confirmRow ? t("terminal.confirmKill") : t("terminal.confirmPaste") }}</p>
      <button class="btn" data-terminal-cancel @click="cancelConfirm">{{ t("terminal.cancel") }}</button>
      <button class="btn" :disabled="state.busy" @click="confirmRow ? kill() : sendPaste()">
        {{ t("terminal.confirm") }}
      </button>
    </div>
  </section>
</template>
