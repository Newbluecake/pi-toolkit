<script setup lang="ts">
import { tracePoint } from "../../logic/trace.js";
tracePoint("graph:setup");
import { computed, defineAsyncComponent, inject, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { useWorktreeGraph } from "../../composables/useWorktreeGraph.js";
import { pickGraphWt, wtgraphScopeOf } from "@logic/gitGraphScope.js";
import type { WorktreeRowWire, WorktreesWire, SessionInfo } from "@protocol/messages.js";
import type { WorktreeGraphTransport } from "../../transport/types.js";
import type { HubHandle as HubHandleLike } from "../../types.js";
import { CONTROL_ENV, HUB_CTX } from "../control/controlContext.js";
import "../../styles/worktrees.css";

const props = defineProps<{
  readonly worktrees: WorktreesWire;
  readonly agentKey?: string;
  readonly session?: SessionInfo | undefined;
  readonly graphLoader?: () => Promise<typeof import("../graph/WorktreeGraph.vue")>;
}>();
const { t } = useI18n();
const open = ref(false);
const component = ref<InstanceType<typeof WorktreeGraph> | null>(null);
let graphComponentPromise: Promise<typeof import("../graph/WorktreeGraph.vue")> | null = null;
function loadGraph(): Promise<typeof import("../graph/WorktreeGraph.vue")> {
  graphComponentPromise ??= (props.graphLoader?.() ?? import("../graph/WorktreeGraph.vue")).catch((err: unknown) => {
    graphComponentPromise = null;
    throw err;
  });
  return graphComponentPromise;
}
const WorktreeGraph = defineAsyncComponent({ loader: loadGraph });

const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);
function hubCaps(): unknown {
  const h = hub?.state.value.hub;
  return h !== null && typeof h === "object" ? (h as { caps?: unknown }).caps : undefined;
}
interface GraphHubSurface {
  readonly worktreeGraph?: WorktreeGraphTransport;
}
const graphTransport = computed<WorktreeGraphTransport | undefined>(() => {
  const h = hub as (HubHandleLike & GraphHubSurface) | null;
  return h === null ? undefined : h.worktreeGraph;
});
const graphScope = computed(() =>
  wtgraphScopeOf({
    mode: env?.authMode,
    hubCaps: hubCaps(),
    hasTransport: graphTransport.value !== undefined,
    agentKey: props.agentKey,
    session: props.session,
  }),
);
const graphWt = computed(() => pickGraphWt(props.worktrees.rows));
const graphMobile = useMedia(window, "(max-width: 480px)");
const graphCount = computed(() => component.value?.state.state.value.data?.n ?? 200);
const shouldRender = computed(() => graphScope.value !== null && graphWt.value !== null);
</script>

<template>
  <section v-if="shouldRender" class="graph-panel gg-section" :data-open="open">
    <button
      class="wt-sum"
      type="button"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-label="t('graph.toggleAria')"
      @click="open = !open"
    >
      <AppIcon name="branch" class="icon-sm gg-sum-icon" />
      <span class="wt-sum-text">{{ t("graph.headLabel", { n: graphCount }) }}</span>
      <AppIcon name="chev-right" class="icon-sm chev" aria-hidden="true" />
    </button>
    <WorktreeGraph
      v-if="open || component !== null"
      ref="component"
      :scope="graphScope!"
      :wt="graphWt!"
      :transport="graphTransport"
      :rows="worktrees.rows"
      :mobile="graphMobile.matches.value"
      :expanded="open"
    />
  </section>
</template>
