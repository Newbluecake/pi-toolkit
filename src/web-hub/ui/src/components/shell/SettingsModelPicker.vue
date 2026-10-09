<!--
  Settings 「新建会话默认模型」 SELECT-ONLY picker (2026-10 user request: 设置里配置默认模型，
  选项风格参考输入框里面的切换按钮，只能选不能输入) — replaces the retired free-text input +
  datalist card in `shell/SettingsView.vue`. The saved value can only ever be an item from the
  known-model list, or the 「跟随 pi 默认」 tri-state `""` (the old `onModelUsePi` semantics);
  there is no free-text save path any more (the search box only FILTERS).

  Building blocks are IMPORTED from the composer's model switcher, not forked:
  - chip/panel/row styling: `styles/models.css` (`.model-chip` / `.model-panel` / `.model-row`);
  - list logic: `@logic/models.js` (`filterModels` / `groupByProvider` / `shortModelLabel`);
  - option row: `control/ModelOptionRow.vue` (extracted from ModelSwitcher for exactly this);
  - ≤640px form factor: `control/PickerSheet.vue`'s Teleport'd bottom sheet (identical to the
    switcher's — viewport decides the form factor, the sheet's scrim owns Esc/outside clicks
    and `[data-autofocus]` keeps focus on the listbox so the mobile keyboard stays down).

  The >640px form factor cannot reuse the switcher's in-flow ABSOLUTE popover as-is: the
  trigger lives inside the settings panel's scroll container (`.settings-page` `overflow-y:
  auto`, within `.settings-panel`'s `overflow: hidden`), which would clip any absolutely
  positioned child popover — worst case the search head amputated on short viewports. The
  desktop panel is therefore also Teleport'd to `<body>` and FIXED-positioned against the
  trigger's viewport rect (same anchor geometry as the switcher: above the chip, flipped below
  when that side has more room, clamped into the viewport — `usePopoverClamp.ts`'s exported
  gap/margin constants — and it follows the trigger while the settings content scrolls). It
  carries `data-subpanel` so `SettingsOverlay`'s own outside-click/Esc handlers defer to it.

  Interaction contract mirrors ModelSwitcher: listbox/option semantics, `aria-expanded` +
  `aria-controls` + `aria-haspopup` on the trigger, ↑↓ with `aria-activedescendant` on the
  search input, Enter picks the highlighted row (NEVER a bare default pick — Enter with no
  highlighted row does nothing, unlike the switcher's quick-switch Enter: the first row here
  is 「跟随 pi 默认」 and an accidental Enter must not clear the saved default), Esc and
  outside click close and refocus the trigger. A window-capture Esc guard runs while open so
  this picker always closes BEFORE the settings panel around it (nesting, whichever form
  factor — SettingsOverlay's document-capture listener would otherwise win on desktop).

  Stateless by design: value / options / disabled / saving are PROPS (SettingsView owns the
  hub prefs, the D7 option list and the save wire call); the single emit `select(ref)` (""
  = follow pi default) carries the user's choice up, after which the parent's existing
  saving/saved/failed status line reports the outcome. Opening highlights the CURRENT choice
  (or nothing when the saved value isn't in the list — it still shows on the trigger with the
  muted `not in list` marker and is never silently cleared).
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { filterModels, groupByProvider, shortModelLabel } from "@logic/models.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { POPOVER_PANEL_GAP, POPOVER_VIEWPORT_MARGIN } from "../../composables/usePopoverClamp.js";
import ModelOptionRow from "../control/ModelOptionRow.vue";
import PickerSheet from "../control/PickerSheet.vue";
import "../../styles/models.css";

/** `knownModelRefs`/`readModelCache` items — `{provider, id, name?}` only (D7). */
interface KnownModel {
  provider: string;
  id: string;
  name?: string;
}

const props = defineProps<{
  /** Saved hub default (`provider/id`), `""` = follow pi default. Shown even when absent from `options`. */
  value: string;
  /** Known models (SettingsView's D7 union/cache), provider-first-seen order. */
  options: readonly KnownModel[];
  /** No `spawn.model.v1` ⇒ trigger disabled; nothing model-shaped is ever sent (D4). */
  disabled?: boolean;
  /** A save is in flight ⇒ rows are inert (SettingsView guards the wire call itself too). */
  saving?: boolean;
}>();
const emit = defineEmits<{ select: [value: string] }>();
const { t } = useI18n();

// --- ≤640px ⇒ PickerSheet bottom sheet (same media query the switcher uses, #16) ------------

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

// --- state -------------------------------------------------------------------------------------

const PANEL_ID = "settings-model-panel";
const PI_OPT_ID = "settings-model-opt-pi";
const open = ref(false);
const query = ref("");
const activeIdx = ref(-1);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
/** `<component :is>` ref: the desktop panel element, or PickerSheet's component instance. */
const panelEl = ref<unknown>(null);

function panelNode(): HTMLElement | null {
  const raw = panelEl.value;
  return raw instanceof HTMLElement ? raw : null;
}

// --- trigger label -------------------------------------------------------------------------------

/** `provider/id-with-slashes` ⇒ the id part for `shortModelLabel`; a slash-less value stays whole. */
const savedId = computed(() => {
  const v = props.value;
  const slash = v.indexOf("/");
  return slash >= 0 ? v.slice(slash + 1) : v;
});
/** The saved value isn't offered by any known model — keep showing it (never silently cleared). */
const notInList = computed(
  () => props.value !== "" && !props.options.some((m) => `${m.provider}/${m.id}` === props.value),
);
const chipLabel = computed(() =>
  props.value === "" ? t("settings.defaultModelFollowPi") : shortModelLabel(savedId.value),
);
const chipTitle = computed(() => {
  if (props.value === "") return t("settings.defaultModelFollowPi");
  return notInList.value ? `${props.value} — ${t("settings.defaultModelNotInListTitle")}` : props.value;
});

// --- list derivation ------------------------------------------------------------------------------

const searched = computed(() => filterModels(props.options, query.value) as KnownModel[]);
const groups = computed(() => groupByProvider(searched.value) as { provider: string; items: KnownModel[] }[]);

/** Selectable rows in display order: 「跟随 pi 默认」 first, then the (filtered) models. */
type Entry = { kind: "pi" } | { kind: "model"; item: KnownModel };
const entries = computed<Entry[]>(() => [
  { kind: "pi" },
  ...searched.value.map((item) => ({ kind: "model" as const, item })),
]);
const indexByItem = computed(() => {
  const m = new Map<KnownModel, number>();
  entries.value.forEach((e, i) => {
    if (e.kind === "model") m.set(e.item, i);
  });
  return m;
});
function optionIdOf(m: KnownModel): string {
  return `settings-model-opt-${indexByItem.value.get(m) ?? -1}`;
}
const activeEntry = computed(() => (activeIdx.value >= 0 ? entries.value[activeIdx.value] : undefined));
const activeDescendant = computed(() => {
  const e = activeEntry.value;
  if (e === undefined) return undefined;
  return e.kind === "pi" ? PI_OPT_ID : optionIdOf(e.item);
});
function isActiveModel(m: KnownModel): boolean {
  const e = activeEntry.value;
  return e !== undefined && e.kind === "model" && e.item === m;
}
const piActive = computed(() => activeEntry.value?.kind === "pi");

function isSelected(m: KnownModel): boolean {
  return `${m.provider}/${m.id}` === props.value;
}
const emptyText = computed(() =>
  props.options.length > 0 ? t("control.modelNoMatch") : t("settings.defaultModelNoList"),
);

// --- open/close -----------------------------------------------------------------------------------

function closePanel(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  activeIdx.value = -1;
  if (refocus) trigger.value?.focus();
}

function togglePanel(): void {
  if (open.value) {
    closePanel(true);
    return;
  }
  if (props.disabled === true) return;
  query.value = "";
  open.value = true;
  // Opening highlights the CURRENT choice (or nothing — Enter with no highlight is a no-op
  // here; see the header's bare-Enter note). Desktop moves focus INTO the panel (the search
  // input, exactly the switcher's focus path); the narrow sheet's `[data-autofocus]` listbox
  // keeps the mobile keyboard down.
  activeIdx.value = entries.value.findIndex((e) => (e.kind === "pi" ? props.value === "" : isSelected(e.item)));
  if (!narrow.value) void nextTick(() => searchEl.value?.focus());
}

function pickEntry(e: Entry): void {
  if (props.saving === true) return;
  const already = e.kind === "pi" ? props.value === "" : isSelected(e.item);
  if (already) {
    closePanel(true);
    return;
  }
  emit("select", e.kind === "pi" ? "" : `${e.item.provider}/${e.item.id}`);
  closePanel(true); // saves immediately; the parent's status line reports saving/saved/failed
}

// --- keyboard (mirror of ModelSwitcher's chip + panel handlers) -------------------------------------

function onChipKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closePanel(true);
    return;
  }
  // Explicit Enter/Space open (combobox trigger convention); preventDefault suppresses the
  // native click activation so the panel toggles exactly once (happy-dom has none anyway).
  if ((ev.key === "Enter" || ev.key === " ") && !open.value && props.disabled !== true) {
    ev.preventDefault();
    togglePanel();
  }
}

function onPanelKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    closePanel(true);
    return;
  }
  const list = entries.value;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (list.length === 0) return;
    const d = ev.key === "ArrowDown" ? 1 : -1;
    activeIdx.value = (activeIdx.value + d + list.length) % list.length;
    const id = activeDescendant.value;
    if (id !== undefined) document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (ev.key === "Enter") {
    const e = activeIdx.value >= 0 ? list[activeIdx.value] : undefined;
    if (e !== undefined) {
      ev.preventDefault();
      pickEntry(e);
    }
  }
}

/** Window-capture Esc: runs BEFORE SettingsOverlay's document-capture handler (window is the
 * first capture node), so Esc closes THIS picker first and the settings panel survives it. */
function onWinKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" || !open.value) return;
  ev.preventDefault();
  ev.stopPropagation();
  closePanel(true);
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return;
  const target = ev.target;
  if (!(target instanceof Node)) return;
  if (root.value !== null && root.value.contains(target)) return;
  const panel = panelNode();
  if (panel !== null && panel.contains(target)) return; // the Teleport'd panel is outside `root`
  closePanel(false);
}

// --- desktop panel anchoring (Teleport'd + fixed — see the header) ----------------------------------

function placePanel(): void {
  const el = panelNode();
  const tr = trigger.value;
  if (el === null || tr === null) return;
  el.style.removeProperty("left");
  el.style.removeProperty("top");
  el.style.removeProperty("bottom");
  el.style.removeProperty("max-height");
  const r = tr.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return; // happy-dom zero rects ⇒ keep the CSS anchor
  const width = el.getBoundingClientRect().width;
  const left = Math.min(Math.max(POPOVER_VIEWPORT_MARGIN, r.left), window.innerWidth - width - POPOVER_VIEWPORT_MARGIN);
  el.style.left = `${Math.round(left)}px`;
  const height = el.getBoundingClientRect().height;
  const above = r.top - POPOVER_VIEWPORT_MARGIN - POPOVER_PANEL_GAP;
  const below = window.innerHeight - r.bottom - POPOVER_VIEWPORT_MARGIN - POPOVER_PANEL_GAP;
  // Prefer above (the switcher's anchor); flip below only when above doesn't fit AND below
  // has more room — clampPopoverY's rule, in fixed coordinates.
  if (height <= above || above >= below) {
    el.style.bottom = `${Math.round(window.innerHeight - r.top + POPOVER_PANEL_GAP)}px`;
  } else {
    el.style.top = `${Math.round(r.bottom + POPOVER_PANEL_GAP)}px`;
  }
  el.style.maxHeight = `${Math.floor(Math.max(120, Math.min(height, Math.max(above, below))))}px`;
}

/** Any scroll (the settings content scrolling moves the trigger) re-anchors the open panel. */
function onAnyScroll(): void {
  if (open.value && !narrow.value) placePanel();
}

let winKeyOn = false;
let desktopChromeOn = false;

function setWinKey(on: boolean): void {
  if (on === winKeyOn) return;
  winKeyOn = on;
  if (on) window.addEventListener("keydown", onWinKeydown, true);
  else window.removeEventListener("keydown", onWinKeydown, true);
}

function setDesktopChrome(on: boolean): void {
  if (on === desktopChromeOn) return;
  desktopChromeOn = on;
  const vv = window.visualViewport;
  if (on) {
    document.addEventListener("click", onDocClick, true);
    window.addEventListener("resize", placePanel);
    document.addEventListener("scroll", onAnyScroll, true);
    vv?.addEventListener("resize", placePanel);
    vv?.addEventListener("scroll", onAnyScroll);
    void nextTick(placePanel);
  } else {
    document.removeEventListener("click", onDocClick, true);
    window.removeEventListener("resize", placePanel);
    document.removeEventListener("scroll", onAnyScroll, true);
    vv?.removeEventListener("resize", placePanel);
    vv?.removeEventListener("scroll", onAnyScroll);
  }
}

// [open, narrow] so crossing the 640px boundary WHILE OPEN swaps the chrome: the desktop
// panel gets its click/scroll/resize listeners + re-anchored, the narrow sheet's scrim owns
// everything instead (the switcher's boundary-crossing discipline).
watch([open, narrow], ([o]) => {
  setWinKey(o);
  setDesktopChrome(o && !narrow.value);
});

onBeforeUnmount(() => {
  setWinKey(false);
  setDesktopChrome(false);
  mq?.removeEventListener?.("change", onMqChange);
});
</script>

<template>
  <div ref="root" class="settings-model-picker">
    <button
      ref="trigger"
      type="button"
      class="model-chip model-chip--card"
      :disabled="props.disabled === true"
      :aria-expanded="open"
      :aria-controls="PANEL_ID"
      aria-haspopup="listbox"
      :aria-label="t('settings.defaultModelSection')"
      :title="chipTitle"
      @click="togglePanel"
      @keydown="onChipKeydown"
    >
      <AppIcon name="cpu" class="icon-sm" />
      <span class="model-chip-label" :class="{ 'model-chip-label--unset': props.value === '' }">
        {{ chipLabel }}
      </span>
      <span v-if="notInList" class="model-chip-marker" translate="no">{{ t("settings.defaultModelNotInList") }}</span>
      <AppIcon v-if="props.saving === true" name="loader" class="icon-sm model-spin" />
      <AppIcon v-else name="chev-down" class="icon-sm" />
    </button>

    <!-- One shared body for both form factors (the switcher's `component :is` discipline);
         the OUTER Teleport serves the desktop div — PickerSheet's own inner Teleport lands in
         the same target either way. -->
    <Teleport v-if="open" to="body">
      <component
        :is="narrow ? PickerSheet : 'div'"
        ref="panelEl"
        data-subpanel
        v-bind="
          narrow
            ? { label: t('settings.defaultModelListAria') }
            : {
                id: PANEL_ID,
                class: 'model-panel model-panel--fixed',
                role: 'dialog',
                'aria-label': t('settings.defaultModelListAria'),
              }
        "
        @close="closePanel(true)"
        @keydown="onPanelKeydown"
      >
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
        </div>
        <ul
          class="model-list"
          role="listbox"
          :aria-label="t('settings.defaultModelListAria')"
          tabindex="-1"
          data-autofocus
        >
          <li
            :id="PI_OPT_ID"
            class="model-row model-row--choice"
            :class="{ active: piActive }"
            role="option"
            :aria-selected="props.value === ''"
            :aria-disabled="props.saving === true"
            @click="pickEntry({ kind: 'pi' })"
          >
            <AppIcon name="check" class="icon-sm row-check" />
            <span class="row-label">{{ t("settings.defaultModelFollowPi") }}</span>
            <span class="row-badges">
              <span class="row-name">{{ t("settings.defaultModelFollowPiHint") }}</span>
            </span>
          </li>
          <template v-for="g in groups" :key="g.provider">
            <li class="model-group" role="presentation">{{ g.provider }}</li>
            <ModelOptionRow
              v-for="m in g.items"
              :key="`${m.provider}/${m.id}`"
              :option-id="optionIdOf(m)"
              :item="m"
              :selected="isSelected(m)"
              :active="isActiveModel(m)"
              :disabled="props.saving === true"
              @pick="pickEntry({ kind: 'model', item: m })"
            />
          </template>
          <li v-if="groups.length === 0" class="model-empty">{{ emptyText }}</li>
        </ul>
      </component>
    </Teleport>
  </div>
</template>
