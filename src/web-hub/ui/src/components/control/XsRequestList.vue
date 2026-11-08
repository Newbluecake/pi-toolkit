<!--
  fabric-xs-activation plan §3 P4 (arch §4.9): the LIGHT cross-session request area beside
  QueueList — never a whole-machine task panel. Pure presentation over the dock's pre-merged
  row views (`logic/xsRequestState.ts`): one main line of compact English tokens per request
  (four-phase / unknown / not delivered + reply state + `wake↓ <reason>`), a translated
  evidence note underneath, and — ONLY under the full activate/query gates the dock evaluated —
  an action button. `activate` targets the ORIGINAL messageId+activationKey and never resends
  text (U6); an `unknown` row offers query only. Nothing fires without a user click: no
  lifecycle path (status frame, SSE reconnect, reply timeout, quota expiry) emits anything.

  Byte-identity: an empty `rows` array renders NO DOM at all (not even a container) — an
  old/off hub (no `xs.state.v1` cap) or a session without records keeps the pre-feature dock.
-->
<script setup lang="ts">
import { computed } from "vue";
import { formatDuration } from "@logic/duration.js";
import { XS_REQUEST_LIST_MAX } from "@logic/xsRequestState.js";
import { useI18n } from "../../composables/useI18n.js";
import { registerXsExtra } from "../../i18n/xs-extra.js";
import type { XsRequestListEmits, XsRequestListProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";

registerXsExtra();

const props = defineProps<XsRequestListProps>();
const emit = defineEmits<XsRequestListEmits>();
const { t } = useI18n();

/** The display window — the tail collapses into the "+N" note (omitted is a display hint,
 *  never a correctness claim; the wire's own `omitted` rides along when present). */
const visible = computed(() => props.rows.slice(0, XS_REQUEST_LIST_MAX));
const hidden = computed(() => Math.max(0, props.rows.length - visible.value.length) + (props.omitted ?? 0));

function activateAria(id: string): string {
  return t("xs.activateAria", { id });
}
function queryAria(id: string): string {
  return t("xs.queryAria", { id });
}
/** retryAfterAt is epoch ms — the distance from `now` reads better than a wall-clock stamp.
 *  `formatDuration` yields null only for non-numbers, which cannot reach here. */
function retryAfterLabel(at: number): string {
  const now = props.now ?? 0;
  return formatDuration(Math.max(0, at - now)) ?? "—";
}
function activateRetryAt(messageId: string): number | undefined {
  return props.activatable?.get(messageId)?.retryAfterAt;
}
</script>

<template>
  <ul v-if="visible.length > 0" class="xs-request-list" :aria-label="t('xs.areaAria')">
    <li v-for="row in visible" :key="row.messageId" class="xs-request-item" :data-phase="row.phaseToken">
      <span class="queue-badges">
        <span class="chip state-chip" translate="no">{{ row.phaseToken }}</span>
        <span v-if="row.replyToken" class="chip chip-muted" translate="no">{{ row.replyToken }}</span>
        <span v-if="row.wakeToken" class="chip chip-wake" translate="no">{{ row.wakeToken }}</span>
      </span>
      <span class="xs-request-id" translate="no" :aria-label="t('xs.rowAria', { id: row.messageId })">{{
        row.messageId
      }}</span>
      <span class="queue-actions">
        <button
          v-if="activatable?.has(row.messageId) && row.activationKey !== undefined"
          class="btn btn-ghost btn-xs"
          type="button"
          data-xs-activate
          :disabled="inFlight?.has(row.messageId) || activateRetryAt(row.messageId) !== undefined"
          :aria-disabled="inFlight?.has(row.messageId) || activateRetryAt(row.messageId) !== undefined"
          :aria-label="activateAria(row.messageId)"
          @click="emit('activate', row.messageId, row.activationKey)"
        >
          <AppIcon name="sparkle" class="icon-sm" />{{
            inFlight?.has(row.messageId) ? t("xs.activating") : t("xs.activate")
          }}
        </button>
        <button
          v-if="queryable?.has(row.messageId)"
          class="btn btn-ghost btn-xs"
          type="button"
          data-xs-query
          :disabled="inFlight?.has(row.messageId)"
          :aria-disabled="inFlight?.has(row.messageId)"
          :aria-label="queryAria(row.messageId)"
          @click="emit('query', row.messageId, row.activationKey ?? null)"
        >
          <AppIcon name="search" class="icon-sm" />{{ t("xs.query") }}
        </button>
        <button
          class="btn btn-ghost btn-xs"
          type="button"
          data-xs-dismiss
          :aria-label="t('xs.dismissAria', { id: row.messageId })"
          :title="t('xs.dismissTitle')"
          @click="emit('dismiss', row.messageId)"
        >
          <span aria-hidden="true">×</span>
        </button>
      </span>
      <span class="queue-note">{{ t(row.noteKey) }}</span>
      <span v-if="row.seeded" class="queue-note">{{ t("xs.noteSeeded") }}</span>
      <span v-if="activateRetryAt(row.messageId) !== undefined" class="queue-note" role="status">{{
        t("xs.retryAfterNote", { t: retryAfterLabel(activateRetryAt(row.messageId)!) })
      }}</span>
      <span v-else-if="row.expired" class="queue-note">{{ t("xs.expiredKeyNote") }}</span>
    </li>
    <li v-if="hidden > 0" class="xs-request-more queue-note">{{ t("xs.noteOmitted", { n: hidden }) }}</li>
  </ul>
</template>
