<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useArmedConfirm } from "../../composables/useArmedConfirm.js";
import { useAvatarEditor } from "../../composables/useAvatarEditor.js";
import { AVATAR_CTX } from "../transcript/avatarContext.js";
import { HUB_CTX } from "../control/controlContext.js";
import AppIcon from "../../icons/AppIcon.vue";
import "../../styles/avatar.css";

const { t } = useI18n();
const avatar = inject(AVATAR_CTX, null);
const hub = inject(HUB_CTX, null);
const input = ref<HTMLInputElement | null>(null);
const editor = useAvatarEditor();
const localError = ref<string | null>(null);

const enabled = computed(() => {
  const caps = hub?.state.value.hub;
  const list =
    caps !== null && caps !== undefined && typeof caps === "object" ? (caps as { caps?: unknown }).caps : undefined;
  return Array.isArray(list) && list.includes("avatar.v1");
});
const visible = computed(() => enabled.value && avatar !== null);
const hasAvatar = computed(() => avatar?.hasAvatar.value === true);
const working = computed(() => avatar?.busy.value === true || editor.phase.value === "processing");
const imageSrc = computed(() => editor.dataUrl.value ?? avatar?.src.value ?? null);
const imageFailed = ref(false);
watch(imageSrc, () => {
  imageFailed.value = false;
});
const statusText = computed(() => {
  if (localError.value !== null && avatar?.error.value === null) return t("avatar.errorGeneric");
  if (editor.error.value !== null) {
    if (editor.error.value === "unsupported" && editor.reason.value !== null) {
      const reason = editor.reason.value;
      return t(`avatar.error${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}`);
    }
    return t(
      `avatar.error${editor.error.value[0]?.toUpperCase() ?? ""}${editor.error.value.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`,
    );
  }
  const error = avatar?.error.value;
  if (error === null || error === undefined) return "";
  if (error === "E_AVATAR_UNSUPPORTED") {
    const reason = avatar?.errorReason?.value;
    return reason === null || reason === undefined
      ? t("avatar.errorUnsupported")
      : t(`avatar.error${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}`);
  }
  if (error === "E_AVATAR_TOO_LARGE") return t("avatar.errorTooLarge");
  if (error === "E_BUSY") return t("avatar.errorBusy");
  if (error === "E_RATE") {
    const retry = avatar?.retryAfterS?.value;
    return retry === null || retry === undefined ? t("avatar.errorRate") : t("avatar.errorRateAfter", { n: retry });
  }
  if (error === "E_AUTH") return t("avatar.errorAuth");
  if (error === "E_DEADLINE")
    return avatar?.errorEffect?.value === "unknown" ? t("avatar.errorDeadlineUnknown") : t("avatar.errorDeadline");
  return t("avatar.errorGeneric");
});
const removeConfirm = useArmedConfirm(() => {
  void avatar?.remove();
});

async function onFile(event: Event): Promise<void> {
  localError.value = null;
  const result = await editor.select(event);
  const bytes = editor.bytes.value;
  if (result?.ok === true && bytes !== null) {
    const uploaded = await avatar?.upload(bytes, result.dataUrl);
    if (uploaded !== undefined && !uploaded.ok) localError.value = uploaded.error;
    editor.reset();
  }
  if (input.value) input.value.value = "";
}
function openPicker(): void {
  if (!working.value) input.value?.click();
}
</script>

<template>
  <section
    v-if="visible"
    class="settings-card settings-card-wide settings-avatar-card"
    :aria-label="t('avatar.title')"
    :aria-busy="working"
  >
    <h2 class="settings-h">{{ t("avatar.title") }}</h2>
    <p class="settings-note">{{ t("avatar.hint") }}</p>
    <div class="avatar-settings-row">
      <div class="avatar-settings-preview" aria-hidden="true">
        <img
          v-if="imageSrc && !imageFailed"
          class="avatar-settings-img"
          :src="imageSrc"
          alt=""
          decoding="async"
          @error="imageFailed = true"
        />
        <AppIcon v-else name="user" class="avatar-settings-icon" />
      </div>
      <div class="avatar-settings-actions">
        <input
          ref="input"
          class="avatar-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          :aria-label="t('avatar.upload')"
          @change="onFile"
        />
        <button type="button" class="btn avatar-action avatar-upload" :disabled="working" @click="openPicker">
          {{ t("avatar.upload") }}
        </button>
        <button
          v-if="hasAvatar"
          type="button"
          class="btn btn-ghost avatar-action avatar-remove"
          :disabled="working"
          :aria-label="removeConfirm.armed.value ? t('avatar.removeConfirm') : t('avatar.remove')"
          @click="removeConfirm.trigger"
          @keydown="removeConfirm.onKeydown"
        >
          {{ removeConfirm.armed.value ? t("avatar.removeConfirm") : t("avatar.remove") }}
        </button>
      </div>
    </div>
    <p v-if="removeConfirm.armed.value" class="avatar-confirm" role="status">{{ t("avatar.removeArmed") }}</p>
    <p v-if="working" class="avatar-status" role="status">{{ t("avatar.processing") }}</p>
    <p v-else-if="statusText" class="avatar-status" role="status">{{ statusText }}</p>
  </section>
</template>
