<!--
  Attachment tray (web-hub-upload plan §4.2, package U5 — `docs/dev/web-hub-upload/plan.md`).

  Renders the Composer's per-agent attachment list above the composer row. Pure view: every
  state change flows through `ControlHandle.uploads` (U4b's `useUploads`) — this component only
  ever emits `remove`/`retry` intents upward; it never touches tray state itself.

  - States (U4a's `attachmentReduce`): `queued → uploading(%) → ready | failed(原因, 可重试)`,
    plus `removing`. Failed rows show the §4.2 `upload.err.*` mapping and a retry button when
    `retryable`.
  - Progress is a real `role="progressbar"` with `aria-valuenow`; every row is a
    `role="listitem"` with a name/size/state `aria-label`.
  - Ready/failed transitions are announced through a local sr-only `aria-live="polite"` region
    (the App-level `useAnnouncer` is not injectable — a tray-local region keeps the same a11y
    contract without touching App.vue, §4.2's 播报 requirement).
  - §4.2 plaintext warning: when `plaintext` (LAN password mode over http:), a permanent,
    NON-dismissible warning line sits at the tray bottom (distinct from ControlNotice's
    dismissible banner — this component has no close button for it). Hideable ONLY via the
    explicit browser-wide opt-out `pwh_hide_plaintext_warn` (`composables/usePlaintextWarning.ts`,
    2026-10 user ruling: the sole LAN user accepts the plaintext risk) — never dismissible
    in-page.

  Thumbnails: deliberately NOT rendered — `UploadsHandle` never exposes the source `File`
  (U4b keeps it closure-private for retry), and `createObjectURL` is banned by source-scan.
  A mime-based icon (`image` vs `file`) takes the thumbnail's place (U4b-dev consult, U5).
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatAttachmentSize } from "@protocol/upload.js";
import { useI18n } from "../../composables/useI18n.js";
import { usePlaintextWarning } from "../../composables/usePlaintextWarning.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { IconName } from "../../icons/names.js";
import type { Attachment } from "../../types.js";
import { browserLocalStorage } from "../shell/themeStorage.js";

const props = defineProps<{ items: readonly Attachment[]; plaintext: boolean }>();
const emit = defineEmits<{ remove: [id: string]; retry: [id: string] }>();
const { t } = useI18n();

// `pwh_hide_plaintext_warn` (explicit browser opt-out) gates the §4.2 warning line.
const warn = usePlaintextWarning({ storage: browserLocalStorage() });
const showPlainWarning = computed(() => warn.warnVisible(props.plaintext));

function iconFor(item: Attachment): IconName {
  if (item.state === "failed") return "alert";
  if (item.mime !== null && item.mime.startsWith("image/")) return "image";
  return "file";
}

function stateLabel(item: Attachment): string {
  switch (item.state) {
    case "queued":
      return t("upload.stateQueued");
    case "uploading":
      return t("upload.stateUploading");
    case "ready":
      return t("upload.stateReady");
    case "failed":
      return t("upload.stateFailed");
    case "removing":
      return t("upload.stateRemoving");
  }
}

function sizeLabel(item: Attachment): string {
  return formatAttachmentSize(Number.isFinite(item.size) ? item.size : 0);
}

function percentOf(item: Attachment): number {
  if (!Number.isFinite(item.size) || item.size <= 0) return item.state === "uploading" ? 0 : 100;
  const done = Math.min(item.uploadedBytes ?? 0, item.size);
  return Math.floor((done / item.size) * 100);
}

/** §4.2's `upload.err.*` mapping — the `Attachment.error` code indexes this table; anything
 * unmapped (incl. transport HTTP n / E_INTERNAL) falls back to `errUnknown` with the raw code. */
const ERR_KEY_BY_CODE: Readonly<Record<string, string>> = {
  E_UPLOAD_TOO_LARGE: "upload.errTooLarge",
  E_UPLOAD_QUOTA: "upload.errQuota",
  E_UPLOAD_DISABLED: "upload.errDisabled",
  E_UPLOAD_CONFLICT: "upload.errConflict",
  E_UPLOAD_GONE: "upload.errGone",
  E_AGENT_GONE: "upload.errAgentGone",
  E_BUSY: "upload.errBusy",
  E_NOT_FOUND: "upload.errRestarted",
  E_HUB_RESTARTING: "upload.errRestarted",
  E_NETWORK: "upload.errNetwork",
  E_DEADLINE: "upload.errTimeout",
  E_AUTH: "upload.errAuth",
  E_RATE: "upload.errRate",
};

function errorText(item: Attachment): string {
  const code = item.error ?? "";
  const key = Object.prototype.hasOwnProperty.call(ERR_KEY_BY_CODE, code) ? ERR_KEY_BY_CODE[code]! : undefined;
  return key === undefined ? t("upload.errUnknown", { code: code === "" ? "?" : code }) : t(key);
}

function onRemove(item: Attachment): void {
  if (item.state === "removing") return;
  emit("remove", item.id);
}

function onRetry(item: Attachment): void {
  if (item.state !== "failed" || item.retryable === false) return;
  emit("retry", item.id);
}

// §4.2 a11y 播报: announce ready/failed transitions into the sr-only live region. The first
// watcher run only seeds the previous-state map — mounting with an already-ready tray (agent
// switch) must not replay stale announcements.
const announced = ref("");
// Seed from the MOUNT-time tray: switching to an agent whose attachments are already ready
// must not replay stale announcements — only later transitions are announced.
let prevStates = new Map<string, Attachment["state"]>(props.items.map((it) => [it.id, it.state]));
watch(
  () => props.items,
  (items) => {
    const next = new Map<string, Attachment["state"]>();
    for (const it of items) {
      const before = prevStates.get(it.id);
      if (before !== undefined && before !== it.state) {
        if (it.state === "ready") announced.value = t("upload.announceReady", { name: it.name });
        else if (it.state === "failed") announced.value = t("upload.announceFailed", { name: it.name });
      }
      next.set(it.id, it.state);
    }
    prevStates = next;
  },
);
</script>

<template>
  <div class="attachment-tray" role="list" :aria-label="t('upload.trayAria')">
    <div
      v-for="item in items"
      :key="item.id"
      class="tray-item"
      :class="[`is-${item.state}`]"
      role="listitem"
      :aria-label="t('upload.itemAria', { name: item.name, size: sizeLabel(item), state: stateLabel(item) })"
    >
      <AppIcon :name="iconFor(item)" class="icon-sm tray-icon" />
      <span class="tray-name" :title="item.name">{{ item.name }}</span>
      <span class="tray-size">{{ sizeLabel(item) }}</span>

      <span v-if="item.state === 'queued' || item.state === 'removing'" class="chip tray-state">{{
        stateLabel(item)
      }}</span>
      <span
        v-else-if="item.state === 'uploading'"
        class="tray-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percentOf(item)"
        :aria-label="t('upload.progressAria', { name: item.name })"
      >
        <span class="tray-progress-fill" :style="{ width: `${percentOf(item)}%` }"></span>
        <span class="tray-progress-pct">{{ percentOf(item) }}%</span>
      </span>
      <span v-else-if="item.state === 'ready'" class="chip tray-state is-ready">{{ stateLabel(item) }}</span>
      <template v-else>
        <span class="tray-error" role="alert">{{ errorText(item) }}</span>
        <button
          v-if="item.retryable !== false"
          type="button"
          class="btn btn-ghost tray-retry"
          :aria-label="t('upload.retryAria', { name: item.name })"
          @click="onRetry(item)"
        >
          {{ t("upload.retry") }}
        </button>
      </template>

      <button
        v-if="item.state !== 'removing'"
        type="button"
        class="btn btn-ghost tray-remove"
        :aria-label="t('upload.removeAria', { name: item.name })"
        @click="onRemove(item)"
      >
        <AppIcon name="x" class="icon-sm" />
      </button>
    </div>

    <div v-if="showPlainWarning && items.length > 0" class="tray-plain-warning" role="note">
      <AppIcon name="alert" class="icon-sm" />
      <span>{{ t("upload.plaintextWarning") }}</span>
    </div>

    <p class="sr-only" role="status" aria-live="polite">{{ announced }}</p>
  </div>
</template>
