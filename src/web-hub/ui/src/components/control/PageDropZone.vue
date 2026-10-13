<!--
  Page-wide file drop zone (2026-10 user ruling 「拖拽上传不限于 Composer 输入框，整个页面都是
  拖放区」). Mounted ONCE by App.vue in the authenticated shell; owns the window-level
  dragenter/dragover/dragleave/drop listeners.

  Behaviour contract:
  - Files drags (`DataTransfer.types` contains `Files`) are ALWAYS swallowed
    (dragover + drop preventDefault) — the one anti-accident invariant: dropping a file on
    any page must never navigate the browser away from the session. Text/link drags are
    never touched (native textarea text-drop keeps working).
  - The full-page overlay (`.page-drop-overlay`, pointer-events:none) shows only when the
    CURRENT route names an agent whose uploads are available (the same `uploadAvailability`
    gate the Composer entries use, plus a present `UploadsHandle`). Counter-guarded
    dragenter/dragleave so crossing child elements (devtools dock edges, iframe borders)
    never flickers it; Esc resets a stuck drag session defensively.
  - drop on ANY page position feeds the current session's tray through the shared
    `addAttachments` pipeline — identical to the paperclip/paste entries (same validation,
    same reject hints). Composer carries NO drag handlers of its own anymore: an in-composer
    drop simply bubbles to these window listeners, so double-processing is structurally
    impossible.
  - Directory drops reject the whole batch with the existing `upload.hintDirectory` toast;
    a selected session whose uploads are unavailable gets `upload.dropUnavailable`; no
    selected session (list/settings route) is silently preventDefault-only.
  - After a handled drop the composer textarea is refocused (best-effort DOM lookup — the
    composer exists exactly on the agent route this feature targets).
-->
<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import { collectDrop, uploadAvailability } from "@logic/upload.js";
import { useI18n } from "../../composables/useI18n.js";
import type { Route } from "../../types.js";
import { addAttachments } from "./attachmentAdd.js";
import { CONTROL_ENV, HUB_CTX } from "./controlContext.js";

const props = defineProps<{ route: Route }>();
const { t } = useI18n();

const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);

const uploadsHandle = hub?.control?.uploads;

/** The route-selected session is the drop target; list/settings routes have none. */
const agentKey = computed(() => (props.route.name === "agent" ? props.route.key : null));

/** Same gate as the Composer entries (§5.1 `uploadAvailability` + a live uploads driver). */
const uploadOn = computed(() => {
  const key = agentKey.value;
  if (uploadsHandle === undefined || key === null) return false;
  const hubFrame = hub?.state.value.hub;
  const hubCaps = hubFrame !== null && hubFrame !== undefined ? (hubFrame as { caps?: unknown }).caps : undefined;
  const card = hub?.state.value.agents.get(key)?.card;
  return uploadAvailability({ hubCaps, card, authMode: env?.authMode });
});

/** Transient feedback toast (directory rejects, unavailable session, admission rejects). */
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string): void {
  toast.value = msg;
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
    toastTimer = undefined;
  }, 6000);
}

const dropActive = ref(false);
let dragDepth = 0;

function dtHasFiles(dt: DataTransfer | null): boolean {
  if (dt === null) return false;
  for (const ty of Array.from(dt.types ?? [])) if (ty === "Files") return true;
  return false;
}

function resetDrag(): void {
  dragDepth = 0;
  dropActive.value = false;
}

function onDragEnter(ev: DragEvent): void {
  if (!dtHasFiles(ev.dataTransfer)) return;
  if (!uploadOn.value) return; // nothing to show; dragover/drop below still guard navigation
  ev.preventDefault();
  dragDepth += 1;
  dropActive.value = true;
}

function onDragOver(ev: DragEvent): void {
  if (!dtHasFiles(ev.dataTransfer)) return;
  // ALWAYS for file drags: allowing the drop event to fire is what lets our drop handler
  // swallow it — without this the browser's default (open/navigate to the file) can win.
  ev.preventDefault();
  if (uploadOn.value) dropActive.value = true;
}

function onDragLeave(): void {
  if (!dropActive.value) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropActive.value = false;
}

function onDrop(ev: DragEvent): void {
  resetDrag();
  if (!dtHasFiles(ev.dataTransfer)) return;
  ev.preventDefault(); // the anti-navigation swallow — unconditional for file drags
  const key = agentKey.value;
  if (key === null) return; // no session selected: silent prevention
  if (!uploadOn.value || uploadsHandle === undefined) {
    showToast(t("upload.dropUnavailable"));
    return;
  }
  const res = collectDrop(ev.dataTransfer);
  if (!res.ok) {
    showToast(t("upload.hintDirectory", { names: res.names.join(", ") }));
  } else {
    addAttachments(uploadsHandle, key, res.files, t, showToast);
  }
  // A handled drop is a pointer gesture; hand focus back to the composer (files added and
  // directory rejects alike) so typing continues without a click. Best-effort: no composer
  // on this route ⇒ no-op.
  document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
}

/** Defensive reset for a cancelled drag (Esc mid-drag never reliably fires dragleave). */
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && dropActive.value) resetDrag();
}

onMounted(() => {
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.removeEventListener("dragenter", onDragEnter);
  window.removeEventListener("dragover", onDragOver);
  window.removeEventListener("dragleave", onDragLeave);
  window.removeEventListener("drop", onDrop);
  window.removeEventListener("keydown", onKeydown);
  if (toastTimer !== undefined) clearTimeout(toastTimer);
});
</script>

<template>
  <div v-if="dropActive" class="page-drop-overlay" aria-hidden="true">
    <p class="page-drop-text">{{ t("upload.dropHint") }}</p>
  </div>
  <div v-if="toast" class="page-drop-toast" role="status">{{ toast }}</div>
</template>
