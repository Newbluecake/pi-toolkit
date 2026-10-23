<!--
  Inline session-rename affordance (web-hub-rename plan): a small pencil button rendered as a
  SIBLING of `AgentCard` (never nested inside its `<a>` — same `components/agents/**` precedent
  as `RemoveButton.vue`: a `<button>`/`<input>` can't nest inside an anchor, and the frozen
  `AgentCardProps` stays untouched).

  Design choice (see the task's final report): rename reuses the EXISTING `command` op
  (`ControlHandle.runCommand(agentKey, "name", newName)`) — the agent's builtin bridge already
  ships a `/name` row (`src/web-hub/agent/builtin-bridge.ts`'s `case "name"`, policy `allow`
  whenever args are non-empty) that calls `pi.setSessionName`, and pi's own `session_info_changed`
  event already refreshes every connected tab's `session` frame (`src/web-hub/agent/index.ts`'s
  `SESSION_EVENTS` set) — so there is NO protocol change, NO new capability flag, and NO agent-
  side code in this change. The pencil only renders when `@logic/control.js`'s `renameEnabled()`
  gate passes (hub `cmd.v1` ∧ agent card `control` ∧ agent live ∧ not mid-restore ∧ the agent's
  `commands` slot is present, i.e. `command.v1`) — an old agent/hub hides the action exactly like
  every other capability-gated control affordance in this app.

  Click → inline edit: Enter (`@keydown.enter.prevent`) saves, Esc cancels, blur cancels (the
  Save/Cancel buttons use `@mousedown.prevent` so clicking them never loses input focus first
  and triggers a blur-cancel race), trimmed + capped at `RENAME_MAX_CHARS` (120), unchanged ⇒
  local cancel, no wire call at all (`@logic/control.js`'s `renameAction`).

  Clear-to-auto (title-auto plan, user ruling 2026-10-21): saving an EMPTY input while the
  session currently has a name hands the title back to auto-generation — the same as the
  `/title auto` command (a96c189a) — by sending `runCommand(agentKey, "title", "auto",
  { confirm: true })`. The web policy for `title auto` is `confirm`
  (`src/web-hub/agent/command-policy.ts`), but the user's explicit clear-and-save IS the
  confirmation and the sidebar has no dock confirm bar, so the confirm the protocol already
  supports rides the FIRST call (no second round-trip). The semantics are only offered when the
  `titleAuto` prop is set (the agent's `commands` slot lists `title` — `AgentList.vue`'s
  `renameInfoFor`); an old agent without /title keeps the legacy rule: empty ⇒ local cancel,
  no wire call. Empty with no current name is always a local cancel.
-->
<script setup lang="ts">
import { inject, nextTick, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { renameAction, RENAME_MAX_CHARS } from "../../logic/control.js";
import { HUB_CTX } from "../control/controlContext.js";
import "../../styles/agents.css";

const props = defineProps<{
  readonly agentKey: string;
  /** Current session name ("" when the session has none — never the localized placeholder
   *  text `AgentCardView.sessionLabel` falls back to). */
  readonly name: string;
  /** title-auto plan: the agent advertises the `/title` command (its `commands` slot lists
   *  `title`), so saving an EMPTY input sends `/title auto` instead of a local cancel. */
  readonly titleAuto?: boolean;
}>();
const { t } = useI18n();
const hub = inject(HUB_CTX, null);

const editing = ref(false);
const draft = ref("");
const sending = ref(false);
const errorText = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

async function startEdit(): Promise<void> {
  if (editing.value) return;
  draft.value = props.name;
  errorText.value = null;
  editing.value = true;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
}

function cancel(): void {
  editing.value = false;
  draft.value = "";
  errorText.value = null;
}

async function save(): Promise<void> {
  if (sending.value) return;
  const action = renameAction(draft.value, props.name, props.titleAuto === true);
  if (action === null) {
    cancel();
    return;
  }
  const control = hub?.control;
  if (control === undefined) {
    cancel();
    return;
  }
  sending.value = true;
  errorText.value = null;
  try {
    // title-auto: the explicit clear-and-save IS the confirmation — the protocol's existing
    // `confirm` flag rides the first call, so the `confirm`-policy /title auto never bounces
    // back E_CONFIRM_REQUIRED (the sidebar has no dock confirm bar to answer one).
    const outcome =
      action.kind === "auto"
        ? await control.runCommand(props.agentKey, "title", "auto", { confirm: true })
        : await control.runCommand(props.agentKey, "name", action.name);
    if (outcome.ok) {
      editing.value = false;
      draft.value = "";
    } else {
      const key = action.kind === "auto" ? "agents.titleAutoFailed" : "agents.renameFailed";
      errorText.value = t(key, { reason: outcome.message ?? outcome.error ?? "E_FAILED" });
    }
  } catch {
    errorText.value = t("agents.renameFailed", { reason: "E_NETWORK" });
  } finally {
    sending.value = false;
  }
}

/** Focus left the whole form (not a Save/Cancel click — those `@mousedown.prevent` so the
 *  input never blurs first) ⇒ treat it as an implicit cancel, same as Esc. */
function onBlur(): void {
  if (!sending.value) cancel();
}
</script>

<template>
  <span class="rename-wrap" :class="{ 'is-editing': editing }">
    <button
      v-if="!editing"
      class="btn btn-ghost rename-btn"
      type="button"
      :aria-label="t('agents.renameAria')"
      @click="startEdit"
    >
      <AppIcon name="edit" class="icon-sm" />
    </button>
    <template v-else>
      <span class="rename-form">
        <input
          ref="inputEl"
          v-model="draft"
          class="input rename-input"
          type="text"
          :maxlength="RENAME_MAX_CHARS"
          autocomplete="off"
          spellcheck="false"
          :aria-label="t('agents.renameInputAria')"
          :placeholder="titleAuto === true ? t('agents.renameAutoHint') : undefined"
          :disabled="sending"
          @keydown.enter.prevent="save"
          @keydown.esc.stop="cancel"
          @blur="onBlur"
        />
        <button
          class="btn btn-ghost btn-icon rename-save"
          type="button"
          :disabled="sending"
          :aria-label="t('agents.renameSaveAria')"
          @mousedown.prevent
          @click="save"
        >
          <AppIcon v-if="sending" name="loader" class="icon-sm spin" />
          <AppIcon v-else name="check" class="icon-sm" />
        </button>
        <button
          class="btn btn-ghost btn-icon rename-cancel"
          type="button"
          :disabled="sending"
          :aria-label="t('agents.renameCancelAria')"
          @mousedown.prevent
          @click="cancel"
        >
          <AppIcon name="x" class="icon-sm" />
        </button>
      </span>
      <p v-if="errorText" class="rename-note" role="alert">{{ errorText }}</p>
    </template>
  </span>
</template>
