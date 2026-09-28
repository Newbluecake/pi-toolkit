<!--
  Control composer (control-plan.md v2.1 §7.4/§7.7, §12.3 — C5 exclusive, `components/control/**`).

  Replaces the dock's read-only line when control is available. Key map (§7.4, delegated to
  `@logic/control.js`'s pure `composerKeyAction` so tests pin one implementation): desktop
  Enter = send in the current mode, Shift+Enter = newline, Alt+Enter = followUp (TUI 同键);
  `pointer: coarse` ⇒ Enter = newline (button-only send); IME composition (`isComposing` /
  keyCode 229) never sends.

  Auto-grow 1–8 lines: CSS `field-sizing: content` where supported, else a CSSOM
  `el.style.height` fallback (CSSOM is not governed by `style-src 'self'` — CSP stays put).

  Command mode (§7.7): text starting with `/` while the agent advertised `command.v1` (the
  `commands` slot) switches to command mode — `cmd` badge + `CommandPalette` completions with
  allow/confirm/deny policy badges; deny entries are greyed with their reason and Enter on a
  denied command never emits. The `sendAsText` toggle (or a `//` prefix, `parseSlash`) falls
  back to a plain prompt. The component never executes commands itself: it emits the same
  `send(text, deliver)` as for prompts; the dock (which owns the `ControlHandle` calls) decides
  prompt vs `runCommand` — the frozen `ComposerEmits` has no command event.

  Drafts: on every input the text is pushed to `control.setDraft(agentKey, …)` (§7.1's
  in-memory per-agent drafts — no localStorage), restored on mount, cleared after a send.
-->
<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from "vue";
import { commandPolicyFor, composerKeyAction, parseSlash } from "@logic/control.js";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import type { ComposerEmits, ComposerProps } from "../../contracts.js";
import type { ControlHandle } from "../../types.js";
import { CONTROL_CTX } from "../../composables/useControl.js";
import AppIcon from "../../icons/AppIcon.vue";
import CommandPalette from "./CommandPalette.vue";
import DeliverSwitch from "./DeliverSwitch.vue";
import { CONTROL_VIEW } from "./controlContext.js";

const props = defineProps<ComposerProps>();
const emit = defineEmits<ComposerEmits>();
const { t } = useI18n();

const ctx = inject(CONTROL_CTX, null);
const view = inject(CONTROL_VIEW, null);

const text = ref(props.draft ?? "");
// §7.1: restore the in-memory per-agent draft when no explicit draft prop was given.
if (props.draft === undefined && ctx) text.value = ctx.control.draft(ctx.agentKey);

const deliver = ref<"steer" | "followUp">("steer");
const sendAsText = ref(false);
const textareaEl = ref<HTMLTextAreaElement | null>(null);

// IME: `composerKeyAction` checks the keydown's own isComposing/keyCode 229; we ALSO track the
// composition session locally (compositionstart/end) so an Enter arriving between the two —
// whose isComposing some input pipelines never set — still can't send (中文输入法, §7.4).
const composing = ref(false);
function onCompositionStart(): void {
  composing.value = true;
}
function onCompositionEnd(): void {
  composing.value = false;
}

const coarse = useMedia(window, "(pointer: coarse)").matches;

const busy = computed(() => props.busy === true);
const commands = computed(() => view?.commands.value ?? []);
const commandsEnabled = computed(() => view?.commandsEnabled.value === true);
const sending = computed(() => view?.sending.value === true);

const slash = computed(() => parseSlash(text.value));
const commandMode = computed(() => slash.value !== undefined && commandsEnabled.value && !sendAsText.value);
const policy = computed(() =>
  commandMode.value && slash.value ? commandPolicyFor([...commands.value], slash.value.name, busy.value) : null,
);
const paletteOpen = computed(() => commandMode.value && slash.value !== undefined);

/** §7.6 placeholders: idle announces "starts a new turn" (D4), busy the steer/follow-up keys. */
const placeholder = computed(() => (busy.value ? t("control.placeholderBusy") : t("control.placeholderIdle")));

const canSend = computed(() => {
  if (!props.enabled || sending.value) return false;
  if (text.value.trim() === "") return false;
  if (commandMode.value) return policy.value === "allow" || policy.value === "confirm";
  return true;
});

function persistDraft(): void {
  ctx?.control.setDraft(ctx.agentKey, text.value);
}

function onInput(): void {
  persistDraft();
  void nextTick(grow);
}

/** CSSOM fallback for browsers without `field-sizing: content` (1–8 rows, §7.4). */
const supportsFieldSizing =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
function grow(): void {
  const el = textareaEl.value;
  if (!el || supportsFieldSizing) return;
  el.style.height = "auto";
  const line = 22; // matches .composer textarea line-height in control.css
  const max = line * 8 + 16;
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

function doSend(mode: "steer" | "followUp"): void {
  const value = text.value;
  if (value.trim() === "" || !props.enabled) return;
  emit("send", value, mode);
  text.value = "";
  sendAsText.value = false;
  persistDraft();
  void nextTick(grow);
}

function onKeydown(ev: KeyboardEvent): void {
  if (composing.value) return; // inside an IME session: no key ever sends
  const action = composerKeyAction(ev, { coarse: coarse.value, busy: busy.value });
  if (action === "newline") return; // default behaviour (insert a newline)
  ev.preventDefault();
  if (commandMode.value && policy.value === "deny") return; // palette already shows the reason
  doSend(action === "followUp" ? "followUp" : deliver.value);
}

function onSendClick(): void {
  doSend(deliver.value);
}

function onPalettePick(name: string): void {
  text.value = `/${name} `;
  persistDraft();
  void nextTick(() => {
    grow();
    textareaEl.value?.focus();
  });
}

watch(
  () => props.draft,
  (d) => {
    if (d !== undefined) text.value = d;
  },
);
</script>

<template>
  <div class="composer" :class="{ 'cmd-mode': commandMode }">
    <CommandPalette
      v-if="paletteOpen && slash"
      :commands="commands"
      :query="slash.name"
      :busy="busy"
      @pick="onPalettePick"
    />
    <div class="composer-row">
      <span v-if="commandMode" class="chip cmd-badge" translate="no">{{ t("control.cmdBadge") }}</span>
      <textarea
        ref="textareaEl"
        v-model="text"
        :disabled="!enabled"
        :placeholder="placeholder"
        :aria-label="placeholder"
        rows="1"
        enterkeyhint="send"
        @input="onInput"
        @keydown="onKeydown"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      ></textarea>
      <DeliverSwitch v-if="busy" :busy="busy" v-model="deliver" />
      <button
        class="btn btn-primary composer-send"
        type="button"
        data-send
        :disabled="!canSend"
        :aria-label="t('control.sendAria')"
        @click="onSendClick"
      >
        <AppIcon name="arrow-up" class="icon-sm send-icon" />
        <span class="lbl-md">{{ t("control.send") }}</span>
      </button>
    </div>
    <div v-if="commandMode" class="composer-sub">
      <label class="send-as-text"
        ><input v-model="sendAsText" type="checkbox" name="send-as-text" />{{ t("control.sendAsText") }}</label
      >
      <span v-if="policy === 'deny'" class="cmd-denied" role="alert">{{ t("control.cmdDeniedTerminal") }}</span>
    </div>
  </div>
</template>
