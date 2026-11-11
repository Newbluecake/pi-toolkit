<script setup lang="ts">
import { provide } from "vue";
import DetailDock from "../../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import { CONTROL_VIEW, HUB_CTX } from "../../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../../src/web-hub/ui/src/composables/useControl.js";
import type { createMemoryCommandFixture } from "./memory-command.js";

// Mount this component in the I browser probe. command() and emit() on fixture are the only
// transport seams; the visible Composer/DetailDock, useControl/useHub and reducers are real.
const props = defineProps<{ fixture: ReturnType<typeof createMemoryCommandFixture> }>();
provide(CONTROL_VIEW, props.fixture.view);
provide(HUB_CTX, props.fixture.hub);
if (props.fixture.view.control)
  provide(CONTROL_CTX, { agentKey: props.fixture.view.agentKey, control: props.fixture.view.control, enabled: true });
</script>
<template>
  <DetailDock v-if="fixture.hub.state.value.agents.has(fixture.card.agentKey)" :following="true" :new-count="0" />
</template>
