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
  observed. Three layout bands (mobile-adaptation package, todo #7 — the original two-band
  <768 / ≥768 split was re-cut user-decided): **≤767px** `narrow` single-view (list ⇄ detail,
  unchanged semantics — this is also the `narrow` prop passed to `AgentDetail`, which
  `FleetPanel`'s default fold and `checks-body.ts`'s 768px line still key off), **≥1025px**
  `wide` permanent split, and the **481–1024px mid band** in between: single-view navigation
  (full-width card grid on the list route, full-width detail on the agent route) with the
  sidebar available as an overlay drawer on the detail route (scrim click / Escape / picking an
  agent closes it), aligned with the fleet drawer's 768–1279 overlay precedent
  (docs/dev/web-hub-fleet-drawer/plan.md). The drawer toggle itself lives in `DetailHeader.vue`,
  wired through the provided `SIDEBAR_DRAWER` context (frozen `contracts.ts` untouched).
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { useTicker } from "../../composables/useTicker.js";
import type { UseHubHandle } from "../../composables/useHub.js";
import type { DashboardViewProps } from "../../contracts.js";
import { toAgentCardView } from "../agents/agentCardModel.js";
import AgentList from "../agents/AgentList.vue";
import AgentDetail from "../detail/AgentDetail.vue";
import EmptyState from "./EmptyState.vue";
import { SIDEBAR_DRAWER } from "./sidebarDrawer.js";

const props = defineProps<DashboardViewProps>();
const { t } = useI18n();

const narrow = useMedia(window, "(max-width: 767px)").matches;
const wide = useMedia(window, "(min-width: 1025px)").matches;
const drawerBand = useMedia(window, "(min-width: 481px) and (max-width: 1024px)").matches;

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

// ---------------------------------------------------------------------------
// mid-band (481–1024px) sidebar drawer (todo #7 — see the file header)
// ---------------------------------------------------------------------------

const drawerOpen = ref(false);
const drawerAvailable = computed(() => drawerBand.value && props.route.name === "agent");
const drawerVisible = computed(() => drawerAvailable.value && drawerOpen.value);

function openDrawer(): void {
  if (drawerAvailable.value) drawerOpen.value = true;
}

function closeDrawer(): void {
  drawerOpen.value = false;
}

// Leaving the drawer band or the agent route always settles the drawer closed — a resize
// into the ≥1025 split (or down to the phone band) can never leave a stray overlay mounted.
watch(drawerAvailable, (available) => {
  if (!available) drawerOpen.value = false;
});

/** Picking any agent card inside the drawer closes it (the route change it triggers is what
 * swaps the detail); clicks anywhere else in the list panel (filter input, collapse toggle,
 * new-session menu) keep it open. */
function onListClick(ev: MouseEvent): void {
  if (!drawerVisible.value) return;
  const anchor = (ev.target as HTMLElement | null)?.closest?.("a");
  if (anchor !== null && anchor !== undefined) closeDrawer();
}

provide(SIDEBAR_DRAWER, { active: drawerAvailable, open: openDrawer });

// ---------------------------------------------------------------------------
// back navigation / retry / loadOlder
// ---------------------------------------------------------------------------

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

// ui-design §6.2/§4.4.2 + the mid-band drawer (todo #7): Escape first closes an open drawer
// (without navigating anywhere), and only with no drawer open returns from the detail view to
// the list — in every single-view band (everything below the 1025px split), same destination
// as the back button. Never fires while the key press is part of text entry/IME composition,
// and `defaultPrevented` is honored so an inner overlay (fleet-drawer plan §6.4's contract)
// that already handled the key wins.
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" || ev.isComposing || ev.defaultPrevented) return;
  if (drawerVisible.value) {
    ev.preventDefault();
    drawerOpen.value = false;
    return;
  }
  if (wide.value || props.route.name !== "agent") return;
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
    <!-- list: full-width page on the list route of every single-view band, permanent column in
         the ≥1025 split, overlay drawer (`.sidebar-drawer` + scrim) in the 481–1024 mid band -->
    <AgentList
      v-if="wide || route.name === 'list' || drawerVisible"
      :class="{ 'sidebar-drawer': drawerVisible }"
      :cards="cards"
      :selected-key="selectedKey"
      :filter="filter"
      @update:filter="filter = $event"
      @click="onListClick"
    />
    <div v-if="drawerVisible" class="drawer-scrim" aria-hidden="true" @click="closeDrawer"></div>

    <template v-if="wide">
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
        :narrow="narrow"
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
