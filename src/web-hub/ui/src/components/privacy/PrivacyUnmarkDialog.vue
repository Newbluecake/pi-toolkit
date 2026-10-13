<!--
  取消隐私标记 dialog (web-hub-privacy plan v2.1 N1, package P2). Mounted by
  `DashboardView.vue` (`v-if` on the lock handle's `unmarkTarget` — mount/unmount IS
  open/close, the `PickerSheet.vue` lifecycle convention) and Teleported to `<body>`.

  Two variants, matching the hub's per-listener enforcement (`POST /api/privacy/lock`
  `{locked:false}`):
  - **password (LAN)**: a password form — the password lives ONLY inside the emitted confirm
    payload (the parent's `confirmUnmark` puts it straight into the request body; it is never
    cached, never reused from any view-unlock state, and the field is cleared on emit);
  - **token (loopback)**: a plain confirm row (no second credential exists there).

  Overlay contract (mirrors `preview/PreviewHost.vue` + `spawn/DirPicker.vue`): scrim click
  closes (`@click.self`), Escape closes with `preventDefault()` + `stopPropagation()` at both
  the scrim (bubbling path) and a document-level capture listener that only acts while this
  dialog is the TOPMOST open overlay (`OVERLAY_ROOTS`, appended to `<body>` in mount order),
  Tab/Shift+Tab cycle inside the panel, focus enters the password field (LAN) / confirm
  button (loopback) on open and returns to the opener on close, body scroll lock is ref-counted
  (`useScrollLock`) and always released (close path AND unmount path).
-->
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { acquireBodyScrollLock } from "../../composables/useScrollLock.js";
import type { LoginErrorView } from "../../types.js";

const props = defineProps<{
  readonly mode: "token" | "password";
  readonly busy: boolean;
  readonly error: LoginErrorView | null;
}>();
const emit = defineEmits<{ confirm: [password: string | null]; close: [] }>();
const { t } = useI18n();

const password = ref("");
const scrimEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const passwordEl = ref<HTMLInputElement | null>(null);
const confirmEl = ref<HTMLButtonElement | null>(null);

function errorText(): string {
  const err = props.error;
  if (err === null) return "";
  const params = { ...(err.params ?? {}), ...(err.countdownS === undefined ? {} : { s: err.countdownS }) };
  return t(err.key, params);
}

function onConfirm(): void {
  if (props.busy) return;
  const value = password.value;
  password.value = ""; // request-scoped only (plan v2.1 N1: 不缓存) — cleared right after emit
  emit("confirm", props.mode === "password" ? value : null);
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
  await nextTick();
  (props.mode === "password" ? passwordEl.value : confirmEl.value)?.focus();
});

onUnmounted(() => {
  releaseScrollLock?.(); // idempotent — close and unmount are the same path (parent v-if)
  releaseScrollLock = null;
  document.removeEventListener("keydown", onDocumentKeydown, true);
  const target = returnFocus;
  returnFocus = null;
  if (target instanceof HTMLElement && document.contains(target)) target.focus();
});

/** Every Teleport'd overlay root this dialog can stack with (same constant DirPicker /
 *  SessionHistoryDialog / PreviewHost share — keep the list in lockstep). */
const OVERLAY_ROOTS = ".spawn-scrim, .picker-scrim, .preview-overlay, .privacy-scrim";

/** Escape/Tab belong to this dialog only while it is the TOPMOST open overlay (DirPicker's
 *  precedent): a keydown targeted inside a sibling overlay is that overlay's business. */
function ownsDocumentKeydown(ev: KeyboardEvent): boolean {
  const panel = panelEl.value;
  if (panel === null) return false;
  if (ev.target instanceof Node && panel.contains(ev.target)) return false; // scrim path handles it
  const roots = Array.from(document.querySelectorAll(OVERLAY_ROOTS));
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
    <div ref="scrimEl" class="privacy-scrim" @click.self="onClose" @keydown="onScrimKeydown">
      <section
        ref="panelEl"
        class="privacy-unmark"
        role="dialog"
        aria-modal="true"
        :aria-label="t('privacy.unmarkTitle')"
        tabindex="-1"
      >
        <h3 class="privacy-unmark-title">
          <AppIcon name="unlock" class="icon-sm" />
          {{ t("privacy.unmarkTitle") }}
        </h3>
        <p class="privacy-unmark-body">
          {{ mode === "password" ? t("privacy.unmarkBodyLan") : t("privacy.unmarkBodyLoopback") }}
        </p>

        <form v-if="mode === 'password'" class="form privacy-unmark-form" novalidate @submit.prevent="onConfirm">
          <div class="field">
            <label for="privacy-unmark-password">{{ t("privacy.passwordLabel") }}</label>
            <input
              id="privacy-unmark-password"
              ref="passwordEl"
              v-model="password"
              class="input"
              name="password"
              type="password"
              autocomplete="current-password"
              autocapitalize="none"
              spellcheck="false"
              :disabled="busy"
            />
          </div>
          <p class="form-error" role="alert">{{ errorText() }}</p>
          <div class="privacy-unmark-actions">
            <button class="btn btn-ghost" type="button" :disabled="busy" @click="onClose">
              {{ t("privacy.unmarkCancel") }}
            </button>
            <button class="btn btn-primary" type="submit" :disabled="busy">{{ t("privacy.unmarkConfirm") }}</button>
          </div>
        </form>

        <template v-else>
          <p v-if="errorText()" class="form-error" role="alert">{{ errorText() }}</p>
          <div class="privacy-unmark-actions">
            <button class="btn btn-ghost" type="button" :disabled="busy" @click="onClose">
              {{ t("privacy.unmarkCancel") }}
            </button>
            <button ref="confirmEl" class="btn btn-primary" type="button" :disabled="busy" @click="onConfirm">
              {{ t("privacy.unmarkConfirm") }}
            </button>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>
