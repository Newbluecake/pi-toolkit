<!--
  SpawnConfirm — the 409 `E_CONFIRM_REQUIRED` view inside DirPicker (web-hub-spawn plan SP12 /
  arch §6.3, §9.1). Shows the hub-admitted `resolvedCwd` (plain interpolation ⇒ textContent,
  never HTML — the same string is echoed back as `expectCwd` by `useNewSession.confirm()`),
  the reason (`unknown-dir` / `lan`), and — on plaintext LAN (`plaintext` prop, mirrors
  AttachmentTray's warning rule) — the unencrypted-traffic warning. Pure presentation: the
  confirm/cancel semantics live in `useNewSession` (SP11), this component only forwards clicks.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import "../../styles/spawn.css";

const props = defineProps<{
  /** The admitted realpath from 409 — rendered via textContent, echoed back as `expectCwd`. */
  readonly resolvedCwd: string;
  /** 409 reason (`unknown-dir` / `lan`); unknown values render raw. */
  readonly reason?: string | undefined;
  /** LAN plaintext HTTP ⇒ the permanent warning line (arch §9.1). */
  readonly plaintext: boolean;
  /** Resend in flight (useNewSession is back in `submitting`). */
  readonly busy?: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();

const reasonLabel = computed(() => {
  const r = props.reason;
  if (r === undefined || r === "") return null;
  if (r === "unknown-dir") return t("spawn.confirmReasonUnknownDir");
  if (r === "lan") return t("spawn.confirmReasonLan");
  return r;
});
</script>

<template>
  <div class="spawn-confirm" role="group" :aria-label="t('spawn.confirmTitle')">
    <h3 class="spawn-confirm-title">{{ t("spawn.confirmTitle") }}</h3>
    <p class="spawn-confirm-body">{{ t("spawn.confirmBody") }}</p>
    <code class="spawn-confirm-cwd" translate="no">{{ resolvedCwd }}</code>
    <p v-if="reasonLabel" class="spawn-confirm-reason">{{ reasonLabel }}</p>
    <p v-if="plaintext" class="spawn-plain-warning" role="note">{{ t("spawn.confirmPlaintext") }}</p>
    <div class="spawn-confirm-actions">
      <button class="btn btn-ghost" type="button" :disabled="busy === true" @click="emit('cancel')">
        {{ t("dialog.cancel") }}
      </button>
      <button class="btn btn-primary" type="button" :disabled="busy === true" @click="emit('confirm')">
        {{ t("spawn.confirmRun") }}
      </button>
    </div>
  </div>
</template>
