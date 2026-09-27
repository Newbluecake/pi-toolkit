<!--
  Authenticated shell: agent list ⇄ detail split (ui-design.md §5, §6.1, §6.2, vue-plan.md v2.1
  §3.2, §3.3, §3.7, §5.2 — P3 exclusive, `components/shell/**`). `DashboardViewProps` has no
  `Emits` (frozen `contracts.ts`) — every interaction here either calls straight into the
  `hub: HubHandle` prop (`dispatch`/`loadOlder`) or mutates `window.location`/`history` directly
  (the same browser primitives `useHashRoute.ts`'s owner — `App.vue` — already listens to via
  its own `hashchange` handler, so a hash write here flows back down as an updated `route` prop
  without this component needing a second, parallel route-mutation channel).

  Reflects every `route` prop change into the reducer's compatibility `route` event (plan §3.3)
  so `state.js`'s `withSelection` stops auto-picking the first agent once any deep link has been
  observed. `narrow` (`<768px`, matching `shell.css`'s split breakpoint) decides single-view
  (list ⇄ detail) vs. permanent split — never both agent list and detail visible at once below
  768px, always both at/above it.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { useTicker } from "../../composables/useTicker.js";
import type { UseHubHandle } from "../../composables/useHub.js";
import type { DashboardViewProps } from "../../contracts.js";
import { toAgentCardView } from "../agents/agentCardModel.js";
import AgentList from "../agents/AgentList.vue";
import AgentDetail from "../detail/AgentDetail.vue";
import EmptyState from "./EmptyState.vue";

const props = defineProps<DashboardViewProps>();
const { t } = useI18n();

const narrow = useMedia(window, "(max-width: 767px)").matches;

const ticker = useTicker({
  doc: document,
  win: window,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
  now: () => Date.now(),
});

const filter = ref("");

const cards = computed(() => {
  const state = props.hub.state.value;
  const out = [];
  for (const key of state.order) {
    const agent = state.agents.get(key);
    if (agent) out.push(toAgentCardView(agent, t));
  }
  return out;
});

const selectedKey = computed(() => (props.route.name === "agent" ? props.route.key : null));
const selectedAgent = computed(() =>
  selectedKey.value === null ? undefined : props.hub.state.value.agents.get(selectedKey.value),
);

// plan §3.3's `route` compatibility event — dispatched on every route change (incl. the very
// first one, `immediate: true`, so a direct deep link is honored before any `agents` frame
// arrives: `withSelection` re-evaluates `wanted` whenever `agents`/`agent_up` land too).
watch(
  () => props.route,
  (r) => {
    props.hub.dispatch({ event: "route", data: { agentKey: r.name === "agent" ? r.key : null } });
  },
  { immediate: true },
);

// §6.2: back button uses real browser history when the current entry was reached by navigating
// within this app (history.length grew past what it was on mount), otherwise replaces the hash
// (a direct deep link has no "back" to return to).
const historyFloor = window.history.length;
function onBack(): void {
  if (window.history.length > historyFloor) window.history.back();
  else window.location.replace("#/");
}

function onRetry(agentKey: string): void {
  props.hub.dispatch({ event: "retry", data: { agentKey } });
}

// ui-design §6.2/§4.4.2: below 768px, Escape returns from the detail view to the list, same
// destination as the back button — but only while a detail view is actually showing (narrow +
// `route.name === "agent"`) and never while the key press is part of text entry/IME composition.
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" || ev.isComposing) return;
  if (!narrow.value || props.route.name !== "agent") return;
  const target = ev.target as HTMLElement | null;
  if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
  onBack();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

/**
 * `DashboardViewProps.hub` is deliberately typed as the frozen, minimal `HubHandle`
 * (`state`/`dispatch` only — `types.ts`'s own header: "components never call the reducer
 * directly") so that most components never see `loadOlder`/`transport`/`start`/`dispose` at
 * all. `App.vue` (the only place that ever constructs a `hub` value) always passes the full
 * `useHub()` return value (`UseHubHandle extends HubHandle`), so this cast is safe by
 * construction — it is not a widening of what `contracts.ts` promises callers, only of what
 * this one call site relies on the *actual* object shape being. Flagged in the delivery report
 * as a candidate for a small `HubHandle.loadOlder` addition to `types.ts`, should a future
 * package want to call it from a component that ISN'T guaranteed to receive a `UseHubHandle`.
 */
function onLoadOlder(agentKey: string): void {
  (props.hub as UseHubHandle).loadOlder(agentKey);
}
</script>

<template>
  <div class="layout">
    <AgentList
      v-if="!narrow || route.name === 'list'"
      :cards="cards"
      :selected-key="selectedKey"
      :filter="filter"
      @update:filter="filter = $event"
    />

    <template v-if="!narrow">
      <AgentDetail
        v-if="selectedAgent"
        :agent="selectedAgent"
        :now="ticker.now.value"
        :narrow="false"
        @back="onBack"
        @retry="onRetry(selectedAgent!.key)"
        @load-older="onLoadOlder(selectedAgent!.key)"
      />
      <div v-else-if="route.name === 'agent'" class="detail">
        <EmptyState icon="inbox" :title="t('detail.notConnectedTitle')" :body="t('detail.notConnectedBody')">
          <template #actions>
            <a class="btn" href="#/">{{ t("common.backToAgents") }}</a>
          </template>
        </EmptyState>
      </div>
      <div v-else class="detail">
        <EmptyState icon="inbox" :title="t('detail.selectAgentTitle')" :body="t('detail.selectAgentBody')" />
      </div>
    </template>

    <template v-else-if="route.name === 'agent'">
      <AgentDetail
        v-if="selectedAgent"
        :agent="selectedAgent"
        :now="ticker.now.value"
        :narrow="true"
        @back="onBack"
        @retry="onRetry(selectedAgent!.key)"
        @load-older="onLoadOlder(selectedAgent!.key)"
      />
      <div v-else class="detail">
        <EmptyState icon="inbox" :title="t('detail.notConnectedTitle')" :body="t('detail.notConnectedBody')">
          <template #actions>
            <a class="btn" href="#/">{{ t("common.backToAgents") }}</a>
          </template>
        </EmptyState>
      </div>
    </template>
  </div>
</template>
