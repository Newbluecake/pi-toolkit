<!--
  Model switcher chip (web-model-switch plan v2 §5, package M3a; M3b added the ThinkingChip
  sibling and the Teleport'd mobile sheet). Lives in DetailDock's slim `.dock-tools` row
  above the composer (user 拍板 Q2). Two form factors (#16): viewport >640px = popover above
  the chip; ≤640px = `PickerSheet` bottom sheet Teleport'd to `<body>` (M3b — same slot
  content, the search box deliberately NOT autofocused there so the mobile keyboard stays
  down; focus lands on the listbox via `[data-autofocus]`). CSS in `styles/models.css`;
  `(pointer: coarse)` only raises hit areas.

  §5.4 four-state table (①② not-rendered / ③ not-rendered / ④ read-only chip / ⑤ full) is
  driven entirely off the injected CONTROL_VIEW + `modelsOf(session)`; the switch execution
  itself goes through the existing `cmd{op:"command"}` channel with a CALLER-GENERATED cmdId
  (`newCmdId()` passed as `{id}` — #6) and converges via the shared pure reducer
  `@logic/models.js`'s `trackSwitch` (§5.2: exactly one tracked id; 20s ⇒ `unknown`, resend
  barred until the id settles; session switch drops tracking).
-->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { newCmdId } from "@logic/control.js";
import {
  currentModelOf,
  ctxBadge,
  filterModels,
  groupByProvider,
  modelsOf,
  shortModelLabel,
  snapshotAge,
  switchErrorKey,
  trackSwitch,
  SWITCH_TIMEOUT_MS,
} from "@logic/models.js";
import { modelCommandArg } from "@protocol/models.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { usePopoverClamp } from "../../composables/usePopoverClamp.js";
import PickerSheet from "./PickerSheet.vue";
import ThinkingChip from "./ThinkingChip.vue";
import { CONTROL_VIEW } from "./controlContext.js";
import "../../styles/models.css";

/** Local mirrors of `@logic/models.js`'s JSDoc typedefs (types.ts's mirror discipline — the
 * .js logic module stays the behavioral source of truth). */
interface ModelItem {
  provider: string;
  id: string;
  name?: string;
  ctx?: number;
  reasoning?: true;
  scoped?: true;
}
interface ModelsView {
  status: string;
  items: ModelItem[];
  total: number;
  omitted?: number;
  invalid?: number;
  scoped?: true;
  levels?: string[];
  policy: { model: string; thinking: string };
  shadowed?: { model?: true; thinking?: true };
  sampledAt: number;
}
interface Track {
  id: string;
  sessionId: string;
  target: { provider: string; id: string };
  startedAt: number;
}
type SwitchState =
  { kind: "idle" } | { kind: "pending" } | { kind: "unknown" } | { kind: "error"; code: string; message?: string };

const { t } = useI18n();
const view = inject(CONTROL_VIEW, null);

const session = computed<Record<string, unknown> | undefined>(() => view?.agent.value.session);
const models = computed(() => modelsOf(session.value) as unknown as ModelsView | null);
const current = computed(() => currentModelOf(session.value) as { provider: string; id: string } | null);
const busy = computed(() => view?.busy.value === true);

/** §5.4 ①②③: control off / offline / command cap missing ⇒ render NOTHING. */
const visible = computed(() => view !== null && view.enabled.value && view.commandsEnabled.value);

// --- narrow viewport ⇒ Teleport'd bottom sheet (M3b; viewport decides the form factor, #16) -

const narrow = ref(false);
let mq: MediaQueryList | undefined;
const onMqChange = (): void => {
  narrow.value = mq?.matches === true;
};
onMounted(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    mq = window.matchMedia("(max-width: 640px)");
    onMqChange();
    mq.addEventListener?.("change", onMqChange);
  }
});

// --- panel open/close (ContextRing.vue's Esc + outside-click pattern) -------------------------

const open = ref(false);
const tab = ref<"scoped" | "all">("scoped");
const query = ref("");
const activeIdx = ref(-1);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const panelEl = ref<unknown>(null);
const nowTick = ref(Date.now());

// Widened desktop popover (2026-10): never overflow the viewport — shift the left-anchored
// panel back inside when the chip sits near the right edge, and fit it vertically (flip below
// the chip / cap max-height) when opening above would run off the top of the viewport; keeps
// re-clamping on resize / visualViewport (mobile keyboard) while open
// (composables/usePopoverClamp.ts).
usePopoverClamp(
  open,
  () => !narrow.value,
  () => panelEl.value,
  () => trigger.value,
);

/** Global row id for `aria-activedescendant` (rows render in two template branches, so the id
 * comes from the row's index in the flat `selectable` list, not the v-for index). */
function optionId(m: ModelItem): string {
  return `model-opt-${selectable.value.indexOf(m)}`;
}
const activeDescendant = computed(() => {
  const m = activeIdx.value >= 0 ? selectable.value[activeIdx.value] : undefined;
  return m !== undefined ? optionId(m) : undefined;
});

function closePanel(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  confirmItem.value = null;
  activeIdx.value = -1;
  if (refocus) trigger.value?.focus();
}

function togglePanel(): void {
  if (open.value) {
    closePanel(true);
    return;
  }
  query.value = "";
  tab.value = "scoped";
  nowTick.value = Date.now();
  open.value = true;
  // Focus path (#verify P1): opening moves focus INTO the panel — the search input on
  // desktop — so the panel's ↑↓/Enter/Esc keydown handler actually receives keys; closing
  // returns it (closePanel). Narrow sheet: do NOT focus the search box (it would pop the
  // mobile keyboard, §5.1/A10) — PickerSheet focuses the `[data-autofocus]` listbox itself.
  if (!narrow.value) void nextTick(() => searchEl.value?.focus());
}

function onChipKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closePanel(true);
    return;
  }
  // Explicit Enter/Space open (combobox trigger convention). Real browsers would ALSO fire a
  // native click activation — preventDefault suppresses it so the panel toggles exactly once
  // (happy-dom has no such activation, which is exactly what the focus-path test drives).
  if ((ev.key === "Enter" || ev.key === " ") && !open.value && !denied.value) {
    ev.preventDefault();
    togglePanel();
  }
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return;
  if (root.value !== null && ev.target instanceof Node && !root.value.contains(ev.target)) closePanel(false);
}

let ageTimer: ReturnType<typeof setInterval> | undefined;
watch(open, (v) => {
  // Desktop only: the narrow sheet's scrim covers outside clicks itself (@click.self), and
  // the Teleport'd sheet is OUTSIDE `root` — a document listener would misread sheet taps.
  if (v && !narrow.value) {
    document.addEventListener("click", onDocClick, true);
    ageTimer = setInterval(() => {
      nowTick.value = Date.now();
    }, 30_000);
  } else {
    document.removeEventListener("click", onDocClick, true);
    if (ageTimer !== undefined) {
      clearInterval(ageTimer);
      ageTimer = undefined;
    }
  }
});

// --- list derivation --------------------------------------------------------------------------

const searched = computed<ModelItem[]>(() => filterModels(models.value?.items ?? [], query.value) as ModelItem[]);
const useTabs = computed(() => models.value?.scoped === true);
const scopedItems = computed<ModelItem[]>(() => searched.value.filter((m) => m.scoped === true));
const groups = computed(() => groupByProvider(searched.value) as { provider: string; items: ModelItem[] }[]);
/** Selectable rows in DISPLAY order (drives ↑↓/Enter). */
const selectable = computed<ModelItem[]>(() =>
  useTabs.value && tab.value === "scoped"
    ? scopedItems.value
    : useTabs.value
      ? groups.value.flatMap((g) => g.items)
      : searched.value,
);

function isCurrent(m: ModelItem): boolean {
  const c = current.value;
  return c !== null && c.provider === m.provider && c.id === m.id;
}

/** §5.1: the current model pinned on top when it isn't in the delivered list. */
const pinnedCurrent = computed<ModelItem | null>(() => {
  const c = current.value;
  if (c === null) return null;
  const listed = (models.value?.items ?? []).some((m) => m.provider === c.provider && m.id === c.id);
  return listed ? null : { provider: c.provider, id: c.id };
});

const emptyText = computed(() => {
  const m = models.value;
  if (m === null) return "";
  return m.status === "empty" || m.items.length === 0 ? t("control.modelEmpty") : t("control.modelNoMatch");
});

// --- chip label / policy ------------------------------------------------------------------------

const denied = computed(() => models.value?.policy.model === "deny");

const chipLabel = computed(() => {
  const tr = track.value;
  const kind = swState.value.kind;
  if (tr !== null && (kind === "pending" || kind === "unknown")) return shortModelLabel(tr.target.id);
  const c = current.value;
  return c !== null ? shortModelLabel(c.id) : "—";
});

const chipTitle = computed(() => {
  const m = models.value;
  if (m === null) return t("control.modelOldAgent");
  if (denied.value) {
    return m.shadowed?.model === true ? t("control.modelDeniedShadowed") : t("control.modelDeniedPolicy");
  }
  const c = current.value;
  return c !== null ? `${c.provider}/${c.id}` : t("control.modelChipAria");
});

// --- switch execution + exact-id tracking (§5.2) --------------------------------------------------

const track = ref<Track | null>(null);
const swState = ref<SwitchState>({ kind: "idle" });
const confirmItem = ref<{ item: ModelItem; message?: string } | null>(null);

let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
let errorTimer: ReturnType<typeof setTimeout> | undefined;
let queriedId: string | null = null;

function clearTimers(): void {
  if (timeoutTimer !== undefined) {
    clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  }
  if (errorTimer !== undefined) {
    clearTimeout(errorTimer);
    errorTimer = undefined;
  }
}

function applyState(next: SwitchState): void {
  const prevKind = swState.value.kind;
  swState.value = next;
  if (next.kind === "idle") {
    track.value = null;
    queriedId = null;
    clearTimers();
    return;
  }
  if (next.kind === "error" && prevKind !== "error") {
    if (errorTimer !== undefined) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => applyState({ kind: "idle" }), 6_000);
  }
  if (next.kind === "unknown" && track.value !== null && queriedId !== track.value.id) {
    queriedId = track.value.id;
    const c = view?.control;
    if (c && view) void c.query(view.agentKey, track.value.id).catch(() => {});
  }
}

function reevaluate(): void {
  const tr = track.value;
  if (tr === null || view === null) return;
  const a = view.agent.value;
  applyState(
    trackSwitch(tr, { pendingCtl: a.pendingCtl, ctl: a.ctl, session: a.session, now: Date.now() }) as SwitchState,
  );
}

watch(
  () => [view?.agent.value.pendingCtl, view?.agent.value.ctl, view?.agent.value.session] as const,
  () => reevaluate(),
);

function startTrack(id: string, item: ModelItem): void {
  const sid =
    session.value && typeof session.value["sessionId"] === "string" ? (session.value["sessionId"] as string) : "";
  track.value = { id, sessionId: sid, target: { provider: item.provider, id: item.id }, startedAt: Date.now() };
  swState.value = { kind: "pending" };
  closePanel(false);
  if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => reevaluate(), SWITCH_TIMEOUT_MS + 250);
  reevaluate();
}

async function sendSwitch(item: ModelItem, confirm: boolean): Promise<void> {
  const c = view?.control;
  if (view === null || !c) return;
  const arg = modelCommandArg(item.provider, item.id);
  if (arg === undefined) {
    applyState({ kind: "error", code: "E_INVALID_REF" });
    return;
  }
  const id = newCmdId();
  const outcome = await c.runCommand(view.agentKey, "model", arg, confirm ? { confirm: true, id } : { id });
  if (!outcome.ok) {
    if (outcome.error === "E_CONFIRM_REQUIRED") {
      confirmItem.value = { item, ...(outcome.message !== undefined ? { message: outcome.message } : {}) };
      return;
    }
    applyState({
      kind: "error",
      code: outcome.error ?? "E_FAILED",
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    });
    return;
  }
  confirmItem.value = null;
  const data = (outcome.data ?? {}) as { completion?: string };
  if (data.completion === "async" || data.completion === "unknown") startTrack(id, item);
  else {
    applyState({ kind: "idle" });
    closePanel(false);
  }
}

function pick(item: ModelItem): void {
  if (isCurrent(item)) {
    closePanel(false);
    return;
  }
  // §5.2: one tracked id at a time; `unknown` bars resending until the id settles.
  if (swState.value.kind === "pending" || swState.value.kind === "unknown") return;
  confirmItem.value = null;
  if (models.value?.policy.model === "confirm") {
    confirmItem.value = { item };
    return;
  }
  void sendSwitch(item, false);
}

function confirmSwitch(): void {
  const pending = confirmItem.value;
  if (pending === null) return;
  confirmItem.value = null;
  void sendSwitch(pending.item, true);
}

function checkNow(): void {
  const tr = track.value;
  const c = view?.control;
  if (tr === null || view === null || !c) return;
  void c.query(view.agentKey, tr.id).catch(() => {});
}

function dismissNote(): void {
  if (swState.value.kind === "error") applyState({ kind: "idle" });
}

const switching = computed(() => swState.value.kind === "pending" || swState.value.kind === "unknown");

const noteText = computed(() => {
  const s = swState.value;
  if (s.kind === "error") return t(`control.${switchErrorKey(s.code)}`, { code: s.code });
  if (s.kind === "unknown") return t("control.modelUnconfirmed");
  return "";
});

const noteTitle = computed(() => {
  const s = swState.value;
  return s.kind === "error" ? s.message : undefined;
});

const ageLabel = computed(() => snapshotAge(nowTick.value, models.value?.sampledAt));

function onPanelKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    closePanel(true);
    return;
  }
  const list = selectable.value;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (list.length === 0) return;
    const d = ev.key === "ArrowDown" ? 1 : -1;
    activeIdx.value = (activeIdx.value + d + list.length) % list.length;
    // keep the highlighted row visible (aria-activedescendant carries the AT semantics)
    const id = activeDescendant.value;
    if (id !== undefined) root.value?.querySelector(`#${id}`)?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (ev.key === "Enter") {
    const m = (activeIdx.value >= 0 ? list[activeIdx.value] : undefined) ?? list[0];
    if (m !== undefined) {
      ev.preventDefault();
      pick(m);
    }
  }
}

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick, true);
  mq?.removeEventListener?.("change", onMqChange);
  if (ageTimer !== undefined) clearInterval(ageTimer);
  clearTimers();
});
</script>

<template>
  <div v-if="visible" ref="root" class="model-switcher">
    <!-- §5.4 state ④: old agent (no session.models) ⇒ read-only chip, no chevron, no panel -->
    <span v-if="models === null" class="model-chip model-chip-static" :title="chipTitle">
      <AppIcon name="cpu" class="icon-sm" /><span class="model-chip-label" translate="no">{{ chipLabel }}</span>
    </span>
    <template v-else>
      <button
        ref="trigger"
        type="button"
        class="model-chip"
        :disabled="denied"
        :aria-expanded="open"
        :aria-label="t('control.modelChipAria')"
        :title="chipTitle"
        @click="togglePanel"
        @keydown="onChipKeydown"
      >
        <AppIcon name="cpu" class="icon-sm" />
        <span class="model-chip-label" translate="no">{{ chipLabel }}</span>
        <AppIcon v-if="swState.kind === 'pending'" name="loader" class="icon-sm model-spin" />
        <span v-else-if="swState.kind === 'unknown'" class="model-chip-state">?</span>
        <span v-else-if="swState.kind === 'error'" class="model-chip-state">!</span>
        <AppIcon v-else name="chev-down" class="icon-sm" />
      </button>
      <span v-if="swState.kind === 'error'" class="model-note model-note-error" role="alert" :title="noteTitle">
        <span class="model-note-text">{{ noteText }}</span>
        <button type="button" class="model-note-x" :aria-label="t('control.modelDismiss')" @click="dismissNote">
          ×
        </button>
      </span>
      <span v-else-if="swState.kind === 'unknown'" class="model-note model-note-unknown" role="status">
        <span class="model-note-text">{{ noteText }}</span>
        <button type="button" class="model-note-check" @click="checkNow">{{ t("control.modelCheck") }}</button>
      </span>
      <component
        :is="narrow ? PickerSheet : 'div'"
        v-if="open"
        ref="panelEl"
        v-bind="
          narrow
            ? { label: t('control.modelListAria') }
            : { class: 'model-panel', role: 'dialog', 'aria-label': t('control.modelListAria') }
        "
        @close="closePanel(true)"
        @keydown="onPanelKeydown"
      >
        <div v-if="models.status === 'error'" class="model-banner" role="status">{{ t("control.modelReadError") }}</div>
        <div class="model-panel-head">
          <input
            ref="searchEl"
            v-model="query"
            class="model-search"
            type="search"
            :placeholder="t('control.modelSearch')"
            :aria-label="t('control.modelSearch')"
            :aria-activedescendant="activeDescendant"
          />
          <div v-if="useTabs" class="model-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'scoped'"
              :class="{ active: tab === 'scoped' }"
              @click="tab = 'scoped'"
            >
              {{ t("control.modelTabScoped") }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'all'"
              :class="{ active: tab === 'all' }"
              @click="tab = 'all'"
            >
              {{ t("control.modelTabAll") }}
            </button>
          </div>
        </div>
        <div v-if="confirmItem" class="model-confirm">
          <span>{{ t("control.modelConfirm", { id: confirmItem.item.id }) }}</span>
          <p v-if="confirmItem.message" class="model-confirm-msg">{{ confirmItem.message }}</p>
          <button type="button" class="btn btn-primary" @click="confirmSwitch">
            {{ t("control.modelConfirmRun") }}
          </button>
          <button type="button" class="btn btn-ghost" @click="confirmItem = null">
            {{ t("control.modelConfirmCancel") }}
          </button>
        </div>
        <ul class="model-list" role="listbox" :aria-label="t('control.modelListAria')" tabindex="-1" data-autofocus>
          <li v-if="pinnedCurrent" class="model-row" role="option" aria-selected="true" @click="closePanel(false)">
            <AppIcon name="check" class="icon-sm row-check" />
            <span class="row-id" translate="no">{{ pinnedCurrent.id }}</span>
            <span class="row-badges">
              <span class="model-badge model-badge-current">{{ t("control.modelCurrentBadge") }}</span>
            </span>
          </li>
          <template v-if="useTabs && tab === 'all'">
            <template v-for="g in groups" :key="g.provider">
              <li class="model-group" role="presentation">{{ g.provider }}</li>
              <li
                v-for="m in g.items"
                :key="`${m.provider}/${m.id}`"
                :id="optionId(m)"
                class="model-row"
                :class="{ active: selectable[activeIdx] === m }"
                role="option"
                :aria-selected="isCurrent(m)"
                :aria-disabled="switching"
                @click="pick(m)"
              >
                <AppIcon name="check" class="icon-sm row-check" />
                <span class="row-id" translate="no">{{ m.id }}</span>
                <span v-if="m.name" class="row-name">{{ m.name }}</span>
                <span class="row-badges">
                  <span v-if="ctxBadge(m.ctx)" class="model-badge">{{ ctxBadge(m.ctx) }}</span>
                  <span v-if="m.reasoning === true" class="model-badge model-badge-reasoning">R</span>
                </span>
              </li>
            </template>
          </template>
          <template v-else>
            <li
              v-for="m in selectable"
              :key="`${m.provider}/${m.id}`"
              :id="optionId(m)"
              class="model-row"
              :class="{ active: selectable[activeIdx] === m }"
              role="option"
              :aria-selected="isCurrent(m)"
              :aria-disabled="switching"
              @click="pick(m)"
            >
              <AppIcon name="check" class="icon-sm row-check" />
              <span class="row-id" translate="no">{{ m.id }}</span>
              <span v-if="m.name" class="row-name">{{ m.name }}</span>
              <span class="row-badges">
                <span v-if="ctxBadge(m.ctx)" class="model-badge">{{ ctxBadge(m.ctx) }}</span>
                <span v-if="m.reasoning === true" class="model-badge model-badge-reasoning">R</span>
              </span>
            </li>
          </template>
          <li v-if="selectable.length === 0" class="model-empty">{{ emptyText }}</li>
        </ul>
        <div class="model-foot">
          <span v-if="busy" class="model-busy">{{ t("control.modelBusyNote") }}</span>
          <span v-if="models.omitted" class="model-count">{{ t("control.modelOmitted", { n: models.omitted }) }}</span>
          <span v-if="models.invalid" class="model-count">{{
            t("control.modelInvalidCount", { n: models.invalid })
          }}</span>
          <span class="model-snapshot">{{ t("control.modelSnapshot", { t: ageLabel }) }}</span>
        </div>
      </component>
    </template>
    <!-- user 拍板 Q1: thinking chip sits right next to the model chip (M3b) -->
    <ThinkingChip />
  </div>
</template>
