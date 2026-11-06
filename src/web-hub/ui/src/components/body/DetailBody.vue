<!-- Main transcript seam. #41/#42 rail is lifted to AgentDetail .detail-split;
     memory-key remains scoped to agent.key for session-switch scroll restoration. -->
<script setup lang="ts">
import { computed, inject, provide, watch } from "vue";
import type { DetailBodyEmits, DetailBodyProps } from "../../contracts.js";
import Transcript from "../transcript/Transcript.vue";
import { HUB_CTX } from "../control/controlContext.js";
import {
  acceptXsStatus,
  narrowXsRequests,
  xsEntryIndex,
  xsMentionSeeds,
  xsRemoteRows,
  xsRequestRows,
  XS_RX_PROGRESS,
} from "@logic/xsRequestState.js";

const props = defineProps<DetailBodyProps>();
const emit = defineEmits<DetailBodyEmits>();

// fabric-xs-activation plan §3 P4: the received-card badge index. Cap-gated (no `xs.state.v1`
// ⇒ an EMPTY map — TxCustom then renders no badge DOM at all, byte-identical) and
// session-matched ("错 session 丢弃"): the entryId match is the only attachment key.
const hub = inject(HUB_CTX, null);
const xsSnapshot = computed(() => {
  const hubCaps = (hub?.state.value.hub as { caps?: unknown } | null | undefined)?.caps;
  const snapshot = narrowXsRequests(props.agent.status, hubCaps);
  const sid = (props.agent.session as { sessionId?: unknown } | undefined)?.sessionId;
  if (snapshot === undefined || typeof sid !== "string" || snapshot.sessionId !== sid) return undefined;
  return { snapshot, sessionId: sid };
});
/** Root fix #4: fold into the SAME persistent store the dock uses — a stale frame arriving
 *  after a newer one cannot regress the stored row (and both consumers stay consistent). */
watch(
  xsSnapshot,
  (v) => {
    if (v !== undefined) acceptXsStatus(props.agent.key, v.sessionId, v.snapshot);
  },
  { immediate: true },
);
const xsBadgeIndex = computed(() => {
  // Root fix #6: same display gate — no `xs.state.v1` on the current hub frame ⇒ no badge DOM.
  const hubCaps = (hub?.state.value.hub as { caps?: unknown } | null | undefined)?.caps;
  const v = xsSnapshot.value;
  if (v === undefined || !Array.isArray(hubCaps) || !hubCaps.includes("xs.state.v1")) {
    return new Map<string, never>();
  }
  return xsEntryIndex(
    xsRequestRows(xsMentionSeeds(props.agent.key, v.sessionId), xsRemoteRows(props.agent.key, v.sessionId)),
  );
});
provide(XS_RX_PROGRESS, { rows: xsBadgeIndex });
</script>

<template>
  <div class="detail-body">
    <Transcript
      :key="agent.key"
      :agent="agent"
      :following="following"
      :narrow="narrow"
      :memory-key="agent.key"
      @load-older="emit('load-older')"
      @update:following="emit('update:following', $event)"
      @new-count="emit('new-count', $event)"
    />
  </div>
</template>
