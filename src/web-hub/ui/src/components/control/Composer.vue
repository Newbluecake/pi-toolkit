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

  Attachments (web-hub-upload plan §3.2/§4.1, package U5): three entries — textarea `@paste`
  (classified by `@logic/upload.js`'s pure `classifyPaste`: files-only pastes are intercepted,
  files+text pastes keep the text flowing into the textarea), drag & drop onto `.composer`
  (counter-guarded overlay; `webkitGetAsEntry()?.isDirectory` rejects with a hint), and the
  paperclip button + hidden `<input type="file" multiple>` (the only reliable mobile entry).
  All three delegate admission/scheduling to `ControlHandle.uploads` (U4b's `useUploads`) and
  are disabled together when `!enabled` or `uploadAvailability(...)` fails.

  §3.2's **single send gate**: `sendGate()` (pure judgment in `@logic/upload.js`'s
  `canSendWithAttachments`) backs the button's `:disabled`, `doSend()`'s FIRST line, and the
  keyboard path — Enter / Alt+Enter / click can never disagree. `doSend` emits the gate's own
  composed text (body + §3.1 attachment block, ≤48 KiB) and clears the tray via
  `uploads.discard` — NEVER `remove`, which would abort-delete the just-referenced hub files.
-->
<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from "vue";
import { commandPolicyFor, composerKeyAction, parseSlash } from "@logic/control.js";
import { canSendWithAttachments, classifyPaste, collectDrop, pastedName, uploadAvailability } from "@logic/upload.js";
import { UPLOAD_ATTACH_MAX_PER_MSG } from "@protocol/upload.js";
import { useI18n } from "../../composables/useI18n.js";
import type { ComposerEmits, ComposerProps } from "../../contracts.js";
import type { AddReject, ControlHandle } from "../../types.js";
import { CONTROL_CTX } from "../../composables/useControl.js";
import AppIcon from "../../icons/AppIcon.vue";
import AttachmentTray from "./AttachmentTray.vue";
import CommandPalette from "./CommandPalette.vue";
import DeliverSwitch from "./DeliverSwitch.vue";
import { CONTROL_ENV, CONTROL_VIEW, HUB_CTX } from "./controlContext.js";
import "../../styles/upload.css";

const props = defineProps<ComposerProps>();
const emit = defineEmits<ComposerEmits>();
const { t } = useI18n();

const ctx = inject(CONTROL_CTX, null);
const view = inject(CONTROL_VIEW, null);
const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);

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

// ---------------------------------------------------------------------------
// attachments (web-hub-upload §3.2/§4.1 — U5)
// ---------------------------------------------------------------------------

/** The tray belongs to the agent, not the draft: CONTROL_VIEW's key first, CONTROL_CTX's as fallback. */
const agentKey = computed(() => view?.agentKey ?? ctx?.agentKey ?? null);
const uploadsHandle = view?.control?.uploads ?? ctx?.control.uploads;

const trayItems = computed(() => {
  const key = agentKey.value;
  if (uploadsHandle === undefined || key === null) return [] as const;
  return uploadsHandle.tray(key).value;
});

const plaintext = computed(() => env?.plaintext === true);

/** §4.1/§5.1: the three entries are disabled together — `!enabled`, no `uploads` driver, or a
 * failed capability negotiation (`upload.v1` hub+agent; LAN additionally `upload.lan.v1`). */
const uploadOn = computed(() => {
  if (!props.enabled || uploadsHandle === undefined) return false;
  const hubFrame = hub?.state.value.hub;
  const hubCaps = hubFrame !== null && hubFrame !== undefined ? (hubFrame as { caps?: unknown }).caps : undefined;
  return uploadAvailability({ hubCaps, card: view?.agent.value.card, authMode: env?.authMode });
});

/** §2.3: screenshots/nameless blobs get a `pasted-<stamp>[-n].<ext>` name; real names pass through. */
function renameIfNameless(file: unknown, seq: number): unknown {
  const f = file as { name?: unknown; type?: unknown; lastModified?: unknown } | null;
  if (typeof f?.name === "string" && f.name !== "") return file;
  const mime = typeof f?.type === "string" ? f.type : null;
  const lastModified = typeof f?.lastModified === "number" ? f.lastModified : undefined;
  try {
    if (typeof File === "function" && typeof Blob === "function" && file instanceof Blob) {
      return new File([file], pastedName(mime, Date.now(), seq), {
        type: mime ?? "",
        ...(lastModified !== undefined ? { lastModified } : {}),
      });
    }
  } catch {
    // fall through — a non-constructible file keeps its (empty) name
  }
  return file;
}

/** Transient add/drop feedback line (directory rejects, admission rejects) — auto-clears. */
const hint = ref<string | null>(null);
let hintTimer: ReturnType<typeof setTimeout> | undefined;
function showHint(msg: string): void {
  hint.value = msg;
  if (hintTimer !== undefined) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hint.value = null;
    hintTimer = undefined;
  }, 6000);
}
onUnmounted(() => {
  if (hintTimer !== undefined) clearTimeout(hintTimer);
});

function fileNameOf(file: unknown): string {
  const name = (file as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? name : "file";
}

/** Surface `useUploads.add`'s admission rejects (§4.2: the first one stands for the batch). */
function reportRejects(rejected: readonly AddReject[]): void {
  const first = rejected[0];
  if (first === undefined) return;
  const name = fileNameOf(first.file);
  if (first.reason === "too-large") showHint(t("upload.hintTooLarge", { name }));
  else if (first.reason === "too-many") showHint(t("upload.hintTooMany", { n: UPLOAD_ATTACH_MAX_PER_MSG }));
  else if (first.reason === "duplicate") showHint(t("upload.hintDuplicate", { name }));
  else showHint(t("upload.hintInvalid", { name }));
}

function addFiles(files: readonly unknown[]): void {
  const key = agentKey.value;
  if (!uploadOn.value || uploadsHandle === undefined || key === null || files.length === 0) return;
  let seq = 0;
  reportRejects(
    uploadsHandle.add(
      key,
      files.map((f) => renameIfNameless(f, ++seq)),
    ).rejected,
  );
}

/** §4.1 entry 1 — paste. Files-only ⇒ intercepted as attachments; files+text ⇒ the text still
 * pastes normally (no preventDefault) AND the files become attachments (pinned by test). */
function onPaste(ev: ClipboardEvent): void {
  if (!uploadOn.value || uploadsHandle === undefined) return;
  const cls = classifyPaste(ev.clipboardData);
  if (cls.files.length === 0) return;
  addFiles(cls.files);
  if (cls.preventDefault) ev.preventDefault();
}

/** §4.1 entry 2 — drag & drop. Counter-guarded so child-element enter/leave pairs don't flicker
 * the overlay; `types` must contain `Files` (text drags over the composer stay untouched). */
const dropActive = ref(false);
let dragDepth = 0;
function dtHasFiles(dt: DataTransfer | null): boolean {
  if (dt === null) return false;
  for (const ty of Array.from(dt.types ?? [])) if (ty === "Files") return true;
  return false;
}

function onDragEnter(ev: DragEvent): void {
  if (!uploadOn.value || !dtHasFiles(ev.dataTransfer)) return;
  ev.preventDefault();
  dragDepth += 1;
  dropActive.value = true;
}

function onDragOver(ev: DragEvent): void {
  if (!uploadOn.value || !dtHasFiles(ev.dataTransfer)) return;
  ev.preventDefault(); // required — otherwise the browser never fires `drop` here
  dropActive.value = true;
}

function onDragLeave(): void {
  if (!dropActive.value) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropActive.value = false;
}

function onDrop(ev: DragEvent): void {
  dragDepth = 0;
  dropActive.value = false;
  if (!uploadOn.value || uploadsHandle === undefined || !dtHasFiles(ev.dataTransfer)) return;
  ev.preventDefault();
  const res = collectDrop(ev.dataTransfer);
  if (!res.ok) {
    showHint(t("upload.hintDirectory", { names: res.names.join(", ") }));
    return;
  }
  addFiles(res.files);
}

/** §4.1 entry 3 — the paperclip button (§4.4: the only reliable mobile entry). */
const fileInputEl = ref<HTMLInputElement | null>(null);
function onAttachClick(): void {
  fileInputEl.value?.click();
}

function onFilePick(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  addFiles(input.files !== null ? Array.from(input.files) : []);
  input.value = ""; // re-picking the same file must fire `change` again
}

function onTrayRemove(id: string): void {
  const key = agentKey.value;
  if (uploadsHandle === undefined || key === null) return;
  uploadsHandle.remove(key, id);
}

function onTrayRetry(id: string): void {
  const key = agentKey.value;
  if (uploadsHandle === undefined || key === null) return;
  uploadsHandle.retry(key, id);
}

/** §3.2's ONE gate — button `:disabled`, `doSend`'s first line, and the keyboard path all see
 * this exact answer. `commandRouted` mirrors DetailDock.onSend's routing (`parseSlash` +
 * `commandsEnabled`, deliberately NOT `sendAsText`) so a gated-ok send can never be re-routed
 * into a command execution with the attachment block glued on. */
function sendGate() {
  return canSendWithAttachments({
    enabled: props.enabled,
    sending: sending.value,
    text: text.value,
    attachments: [...trayItems.value],
    commandRouted: slash.value !== undefined && commandsEnabled.value,
    // DetailDock re-derives the policy from the ROUTED text (sendAsText only changes composer
    // display), so the gate must see the same answer — `policy` (display-scoped) would report
    // null for a sendAsText-escaped "/allow-command" and block a send v1 allowed.
    policy:
      slash.value !== undefined && commandsEnabled.value
        ? commandPolicyFor([...commands.value], slash.value.name, busy.value)
        : policy.value,
  });
}
const gate = computed(sendGate);

/** The tray-related block reasons surface as a persistent hint line (§3.2's 提示); transient
 * add/drop feedback (`hint`) takes priority over it. */
const gateHint = computed(() => {
  const g = gate.value;
  if (g.ok) return null;
  if (g.reason === "queued" || g.reason === "uploading") return t("upload.gateUploading");
  if (g.reason === "failed") return t("upload.gateFailed");
  if (g.reason === "command-attachments") return t("upload.gateCommand");
  if (g.reason === "too-large") return t("upload.gateTooLarge");
  if (g.reason === "attachment-block") return t("upload.gateBlocked");
  return null;
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
  const g = sendGate(); // §3.2: FIRST line — the one gate every send path funnels through
  if (!g.ok) return;
  emit("send", g.text, mode); // gate-composed text: body + §3.1 attachment block (≤48 KiB)
  text.value = "";
  sendAsText.value = false;
  persistDraft();
  // §3.2 乐观清盘: `discard`, never `remove` — remove would abort-delete the committed hub
  // files the just-sent prompt now references (U5 patch; pins only block sweep eviction).
  const key = agentKey.value;
  if (uploadsHandle !== undefined && key !== null && trayItems.value.length > 0) {
    uploadsHandle.discard?.(key);
  }
  void nextTick(grow);
}

function onKeydown(ev: KeyboardEvent): void {
  if (composing.value) return; // inside an IME session: no key ever sends
  const action = composerKeyAction(ev, { busy: busy.value });
  if (action === "newline") return; // default behaviour (insert a newline)
  ev.preventDefault();
  // No local deny early-exit anymore (§3.2): a denied command is `command-policy` in sendGate.
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
  <div
    class="composer"
    :class="{ 'cmd-mode': commandMode }"
    @paste="onPaste"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <CommandPalette
      v-if="paletteOpen && slash"
      :commands="commands"
      :query="slash.name"
      :busy="busy"
      @pick="onPalettePick"
    />
    <AttachmentTray
      v-if="trayItems.length > 0"
      :items="trayItems"
      :plaintext="plaintext"
      @remove="onTrayRemove"
      @retry="onTrayRetry"
    />
    <div v-if="dropActive" class="drop-overlay">{{ t("upload.dropHint") }}</div>
    <div class="composer-row">
      <span v-if="commandMode" class="chip cmd-badge" translate="no">{{ t("control.cmdBadge") }}</span>
      <button
        v-if="uploadsHandle !== undefined"
        class="composer-attach"
        type="button"
        data-attach
        :disabled="!uploadOn"
        :aria-label="t('upload.attachAria')"
        @click="onAttachClick"
      >
        <AppIcon name="paperclip" class="icon-sm" />
      </button>
      <input
        ref="fileInputEl"
        class="file-input sr-only"
        type="file"
        multiple
        tabindex="-1"
        aria-hidden="true"
        @change="onFilePick"
      />
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
        :disabled="!gate.ok"
        :aria-label="t('control.sendAria')"
        @click="onSendClick"
      >
        <AppIcon name="arrow-up" class="icon-sm send-icon" />
        <span class="lbl-md">{{ t("control.send") }}</span>
      </button>
    </div>
    <div v-if="hint" class="composer-hint is-transient" role="status">{{ hint }}</div>
    <div v-else-if="gateHint" class="composer-hint" role="note">{{ gateHint }}</div>
    <div v-if="commandMode" class="composer-sub">
      <label class="send-as-text"
        ><input v-model="sendAsText" type="checkbox" name="send-as-text" />{{ t("control.sendAsText") }}</label
      >
      <span v-if="policy === 'deny'" class="cmd-denied" role="alert">{{ t("control.cmdDeniedTerminal") }}</span>
    </div>
  </div>
</template>
