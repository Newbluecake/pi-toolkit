<!--
  Thinking-level chip (web-model-switch plan v2 §5.1/§5.4/§6, package M3b — user 拍板 Q1:
  built alongside the model chip, rendered by ModelSwitcher right next to it). Compact token
  form `[sparkle] high ▾`; the level list comes ONLY from the delivered `models.levels`
  (pi-ai's `getSupportedThinkingLevels` — never derived locally, #2): levels absent ⇒
  read-only "no-levels", `["off"]` ⇒ read-only "unsupported" (§5.4 ⑤).

  Execution reuses the model chip's exact-id tracking channel: caller-generated cmdId passed
  as `{id}` (#6), `/thinking <level>` is SYNC (builtin-bridge `:236-246`), so convergence is
  the command outcome itself plus the §6 clamp judgement — pi may clamp the requested level
  to the model's capability, and the proving session frame can arrive BEFORE or AFTER the
  cmd_result. Both orders converge identically: wait `CLAMP_SETTLE_MS` for a
  `session.thinkingLevel` change, then compare the then-current level with the request; a
  mismatch surfaces a one-shot "clamped to {level}" note (UI always renders the latest
  session frame as truth, §6).
-->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { newCmdId } from "@logic/control.js";
import { CLAMP_SETTLE_MS, modelsOf, thinkingErrorKey, thinkingGate, thinkingLevelOf } from "@logic/models.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import PickerSheet from "./PickerSheet.vue";
import { CONTROL_VIEW } from "./controlContext.js";
import "../../styles/models.css";

/** Local mirrors of `@logic/models.js`'s JSDoc typedefs (types.ts's mirror discipline). */
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

const { t } = useI18n();
const view = inject(CONTROL_VIEW, null);

const session = computed<Record<string, unknown> | undefined>(() => view?.agent.value.session);
const models = computed(() => modelsOf(session.value) as unknown as ModelsView | null);
const level = computed(() => thinkingLevelOf(session.value));
const busy = computed(() => view?.busy.value === true);

const gate = computed(() => thinkingGate(models.value));
const levels = computed<readonly string[]>(() => models.value?.levels ?? []);

/** §5.4 ①②③ mirror the model chip: control off / offline / command cap missing ⇒ nothing.
 * State ④ (old agent, no `session.models`): read-only chip ONLY when a thinkingLevel exists. */
const rendered = computed(
  () =>
    view !== null &&
    view.enabled.value &&
    view.commandsEnabled.value &&
    (gate.value !== "old-agent" || level.value !== null),
);

const denied = computed(() => models.value?.policy.thinking === "deny");

const chipLabel = computed(() => level.value ?? "off");

const chipTitle = computed(() => {
  const m = models.value;
  switch (gate.value) {
    case "old-agent":
      return t("control.thinkingOldAgent");
    case "no-levels":
      return t("control.thinkingNoLevels");
    case "unsupported":
      return t("control.thinkingUnsupported");
    default:
      break;
  }
  if (denied.value) {
    return m?.shadowed?.thinking === true ? t("control.thinkingDeniedShadowed") : t("control.thinkingDeniedPolicy");
  }
  return t("control.thinkingChipAria");
});

// --- narrow viewport ⇒ Teleport'd bottom sheet (M3b; viewport decides, #16) -------------------

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

// --- panel open/close -------------------------------------------------------------------------

const open = ref(false);
const activeIdx = ref(-1);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const activeDescendant = computed(() =>
  activeIdx.value >= 0 && activeIdx.value < levels.value.length ? `thinking-opt-${activeIdx.value}` : undefined,
);

function closePanel(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  confirmFor.value = null;
  activeIdx.value = -1;
  if (refocus) trigger.value?.focus();
}

function togglePanel(): void {
  if (open.value) {
    closePanel(true);
    return;
  }
  activeIdx.value = levels.value.indexOf(level.value ?? "");
  open.value = true;
  // Desktop popover: focus the listbox so ↑↓/Enter/Esc land on the panel handler. Narrow
  // sheet: PickerSheet focuses the `[data-autofocus]` listbox itself — no search box here at
  // all, so nothing ever pops the mobile keyboard (§5.1).
  if (!narrow.value) void nextTick(() => listEl.value?.focus());
}

function onChipKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closePanel(true);
    return;
  }
  if ((ev.key === "Enter" || ev.key === " ") && !open.value && !denied.value) {
    ev.preventDefault();
    togglePanel();
  }
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return;
  if (root.value !== null && ev.target instanceof Node && !root.value.contains(ev.target)) closePanel(false);
}

watch(open, (v) => {
  // Desktop only: the narrow sheet's scrim covers outside clicks itself (@click.self), and
  // the sheet is Teleport'd OUTSIDE `root` — a document listener would misread sheet taps.
  if (v && !narrow.value) document.addEventListener("click", onDocClick, true);
  else document.removeEventListener("click", onDocClick, true);
});

function onPanelKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    closePanel(true);
    return;
  }
  const list = levels.value;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (list.length === 0) return;
    const d = ev.key === "ArrowDown" ? 1 : -1;
    activeIdx.value = (activeIdx.value + d + list.length) % list.length;
    const id = activeDescendant.value;
    if (id !== undefined) root.value?.querySelector(`#${id}`)?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (ev.key === "Enter") {
    const lv = (activeIdx.value >= 0 ? list[activeIdx.value] : undefined) ?? list[0];
    if (lv !== undefined) {
      ev.preventDefault();
      pick(lv);
    }
  }
}

// --- execution + clamp judgement (§5.2/§6) ------------------------------------------------------

const sending = ref(false);
const confirmFor = ref<{ level: string; message?: string } | null>(null);
const err = ref<{ code: string; message?: string } | null>(null);
const clampNote = ref<string | null>(null);
const awaiting = ref<string | null>(null); // requested level awaiting its proving session frame

let clampTimer: ReturnType<typeof setTimeout> | undefined;
let noteTimer: ReturnType<typeof setTimeout> | undefined;
let errTimer: ReturnType<typeof setTimeout> | undefined;

function clearAwaiting(): void {
  awaiting.value = null;
  if (clampTimer !== undefined) {
    clearTimeout(clampTimer);
    clampTimer = undefined;
  }
}

function showClamp(actual: string): void {
  clampNote.value = actual;
  if (noteTimer !== undefined) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    clampNote.value = null;
  }, 6_000);
}

/** §6: compare the then-current session level with the request — order-independent. A frame
 * that never arrives means pi kept the previous level (no event when unchanged) ⇒ that IS
 * the clamp result. */
function judgeClamp(): void {
  const req = awaiting.value;
  if (req === null) return;
  clearAwaiting();
  const cur = level.value;
  if (cur !== req && cur !== null) showClamp(cur);
}

watch(level, (v, prev) => {
  if (awaiting.value !== null && v !== prev) judgeClamp();
});

function showError(code: string, message?: string): void {
  err.value = message !== undefined ? { code, message } : { code };
  if (errTimer !== undefined) clearTimeout(errTimer);
  errTimer = setTimeout(() => {
    err.value = null;
  }, 6_000);
}

async function sendLevel(lv: string, confirm: boolean): Promise<void> {
  const c = view?.control;
  if (view === null || !c) return;
  const id = newCmdId();
  sending.value = true;
  let outcome;
  try {
    outcome = await c.runCommand(view.agentKey, "thinking", lv, confirm ? { confirm: true, id } : { id });
  } finally {
    sending.value = false;
  }
  if (!outcome.ok) {
    if (outcome.error === "E_CONFIRM_REQUIRED") {
      confirmFor.value = { level: lv, ...(outcome.message !== undefined ? { message: outcome.message } : {}) };
      return;
    }
    showError(outcome.error ?? "E_FAILED", outcome.message);
    return;
  }
  confirmFor.value = null;
  closePanel(false);
  if (level.value !== lv) {
    clearAwaiting();
    awaiting.value = lv;
    clampTimer = setTimeout(judgeClamp, CLAMP_SETTLE_MS);
  }
}

function pick(lv: string): void {
  if (lv === level.value) {
    closePanel(false);
    return;
  }
  if (sending.value || awaiting.value !== null) return; // one tracked request at a time
  confirmFor.value = null;
  if (models.value?.policy.thinking === "confirm") {
    confirmFor.value = { level: lv };
    return;
  }
  void sendLevel(lv, false);
}

function confirmRun(): void {
  const pending = confirmFor.value;
  if (pending === null) return;
  confirmFor.value = null;
  void sendLevel(pending.level, true);
}

function dismissErr(): void {
  err.value = null;
}

function dismissClamp(): void {
  clampNote.value = null;
}

const errText = computed(() => {
  const e = err.value;
  return e === null ? "" : t(`control.${thinkingErrorKey(e.code)}`, { code: e.code });
});

// Session switch ⇒ drop all tracking/notes (same rule as the model chip, §5.2).
watch(
  () => (session.value && typeof session.value["sessionId"] === "string" ? session.value["sessionId"] : null),
  () => {
    clearAwaiting();
    clampNote.value = null;
    err.value = null;
    confirmFor.value = null;
    closePanel(false);
  },
);

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick, true);
  mq?.removeEventListener?.("change", onMqChange);
  clearAwaiting();
  if (noteTimer !== undefined) clearTimeout(noteTimer);
  if (errTimer !== undefined) clearTimeout(errTimer);
});
</script>

<template>
  <div v-if="rendered" ref="root" class="thinking-chip-host">
    <!-- read-only gates (§5.4 ④ / levels absent / ["off"]): static chip, no chevron, no panel -->
    <span v-if="gate !== 'pick'" class="model-chip model-chip-static" :title="chipTitle">
      <AppIcon name="sparkle" class="icon-sm" /><span class="model-chip-label" translate="no">{{ chipLabel }}</span>
    </span>
    <template v-else>
      <button
        ref="trigger"
        type="button"
        class="model-chip"
        :disabled="denied"
        :aria-expanded="open"
        :aria-label="t('control.thinkingChipAria')"
        :title="chipTitle"
        @click="togglePanel"
        @keydown="onChipKeydown"
      >
        <AppIcon name="sparkle" class="icon-sm" />
        <span class="model-chip-label" translate="no">{{ chipLabel }}</span>
        <AppIcon v-if="sending" name="loader" class="icon-sm model-spin" />
        <AppIcon v-else name="chev-down" class="icon-sm" />
      </button>
      <span v-if="err" class="model-note model-note-error" role="alert" :title="err.message">
        <span class="model-note-text">{{ errText }}</span>
        <button type="button" class="model-note-x" :aria-label="t('control.thinkingDismiss')" @click="dismissErr">
          ×
        </button>
      </span>
      <span v-else-if="clampNote !== null" class="model-note model-note-clamp" role="status">
        <span class="model-note-text">{{ t("control.thinkingClamped", { level: clampNote }) }}</span>
        <button type="button" class="model-note-x" :aria-label="t('control.thinkingDismiss')" @click="dismissClamp">
          ×
        </button>
      </span>
      <component
        :is="narrow ? PickerSheet : 'div'"
        v-if="open"
        v-bind="
          narrow
            ? { label: t('control.thinkingListAria') }
            : { class: 'model-panel thinking-panel', role: 'dialog', 'aria-label': t('control.thinkingListAria') }
        "
        @close="closePanel(true)"
        @keydown="onPanelKeydown"
      >
        <div v-if="confirmFor" class="model-confirm">
          <span>{{ t("control.thinkingConfirm", { level: confirmFor.level }) }}</span>
          <p v-if="confirmFor.message" class="model-confirm-msg">{{ confirmFor.message }}</p>
          <button type="button" class="btn btn-primary" @click="confirmRun">
            {{ t("control.thinkingConfirmRun") }}
          </button>
          <button type="button" class="btn btn-ghost" @click="confirmFor = null">
            {{ t("control.thinkingConfirmCancel") }}
          </button>
        </div>
        <ul
          ref="listEl"
          class="model-list thinking-list"
          role="listbox"
          :aria-label="t('control.thinkingListAria')"
          tabindex="-1"
          data-autofocus
          :aria-activedescendant="activeDescendant"
        >
          <li
            v-for="(lv, i) in levels"
            :id="`thinking-opt-${i}`"
            :key="lv"
            class="model-row thinking-row"
            :class="{ active: activeIdx === i }"
            role="option"
            :aria-selected="lv === level"
            :aria-disabled="sending || awaiting !== null"
            @click="pick(lv)"
          >
            <AppIcon name="check" class="icon-sm row-check" />
            <span class="row-id" translate="no">{{ lv }}</span>
            <span class="row-badges">
              <span v-if="lv === level" class="model-badge model-badge-current">{{
                t("control.thinkingCurrentBadge")
              }}</span>
            </span>
          </li>
        </ul>
        <div v-if="busy" class="model-foot">
          <span class="model-busy">{{ t("control.thinkingBusyNote") }}</span>
        </div>
      </component>
    </template>
  </div>
</template>
