<!--
  P4 takeover of the P0→P4 seam (vue-plan.md v2.1 §1.1/§3.2/§5.2). Nests `FleetPanel.vue` +
  `Transcript.vue` exactly as `docs/dev/web-hub/ui-mockups/dashboard.html`'s `.detail-body`
  wrapper does (`.detail-body`'s own layout rules live in P3's `detail.css` — this component
  only emits the class, never defines it, plan §5.2's file-ownership split). `AgentDetail.vue`
  (P3) imports this file and only this file to reach the fleet tree / conversation — it never
  imports `fleet/`/`transcript/` directly (plan §3.2's component tree). Keyed by the agent's own
  `key` so switching the selected agent remounts both children fresh (`FleetPanel.vue`'s header
  comment: fold state / windowing / follow state all reset for free, no extra plumbing needed).
-->
<script setup lang="ts">
import type { FleetRowWire } from "@protocol/messages.js";
import type { DetailBodyEmits, DetailBodyProps } from "../../contracts.js";
import FleetPanel from "../fleet/FleetPanel.vue";
import Transcript from "../transcript/Transcript.vue";

const props = defineProps<DetailBodyProps>();
const emit = defineEmits<DetailBodyEmits>();
</script>

<template>
  <div class="detail-body">
    <FleetPanel
      :key="agent.key"
      :rows="agent.fleet as unknown as readonly FleetRowWire[]"
      :now="now"
      :default-open="!narrow"
    />
    <Transcript
      :key="agent.key"
      :agent="agent"
      :following="following"
      :narrow="narrow"
      @load-older="emit('load-older')"
      @update:following="emit('update:following', $event)"
      @new-count="emit('new-count', $event)"
    />
  </div>
</template>
