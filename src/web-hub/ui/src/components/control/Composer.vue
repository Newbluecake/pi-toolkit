<!--
  Control composer (control-plan.md v2.1 §7.4/§7.7, §12.3 — C5 exclusive, `components/control/**`).

  Replaces the dock's read-only line when control is available. Key map (§7.4, delegated to
  `@logic/control.js`'s pure `composerKeyAction` so tests pin one implementation): desktop
  Enter = send in the current mode, Shift+Enter = newline, Alt+Enter = followUp (TUI 同键);
  `pointer: coarse` ⇒ Enter = newline (button-only send); IME composition (`isComposing` /
  keyCode 229) never sends.

  Delivery mode (2026-10, user-decided): the per-message DeliverSwitch dropdown is retired —
  a busy send goes with the STORED default from the settings page (`useDeliverDefault`,
  `pwh_deliver`, fallback steer); desktop Alt+Enter still flips to followUp per message.

  Auto-grow 1–8 lines: CSS `field-sizing: content` where supported, else a CSSOM
  `el.style.height` fallback (CSSOM is not governed by `style-src 'self'` — CSP stays put).

  Command mode (§7.7): text starting with `/` while the agent advertised `command.v1` (the
  `commands` slot) switches to command mode — `cmd` badge + `CommandPalette` completions with
  allow/confirm/deny policy badges; deny entries are greyed with their reason and Enter on a
  denied command never emits. The `sendAsText` toggle (or a `//` prefix, `parseSlash`) falls
  back to a plain prompt. The component never executes commands itself: it emits the same
  `send(text, deliver)` as for prompts; the dock (which owns the `ControlHandle` calls) decides
  prompt vs `runCommand` — the frozen `ComposerEmits` has no command event.

  Palette keyboard model (2026-10 user request 「/ 开头激活选项后，支持通过 Tab 选择，并且支持
  继续输入，过滤可用选项」, TUI-like — mirrors the @mention panel's layer, generalized to a full
  combobox): focus ALWAYS stays in the textarea; the palette is a listbox driven through
  aria-activedescendant. Continuing to type after `/` filters live (`matchCommandRows`, same
  shared matcher the palette renders); the highlight resets to the best match on every query
  change; Backspace keeps filtering; deleting the `/` exits command mode. ArrowUp/ArrowDown
  move the highlight (wrapping, `moveMentionActive` — the shared wrap-move helper), Shift+Tab
  moves up, Tab completes the highlighted option into `/name ` and HIDES the palette (the user
  types arguments next; editing the name token reopens it — the suppression latch resets on
  name change, so typing args after a completion never re-pops the list). Enter keeps the
  normal key map (executes the typed command per the dock's routing); Escape closes the
  palette WITHOUT clearing the text. Tab is consumed (preventDefault — never moves browser
  focus out of the composer) ONLY while the palette is visible; with it closed Tab behaves
  natively (no focus trap). IME composition (`composing` latch + the event's own
  isComposing/keyCode 229) never triggers completion/navigation — those keys belong to the IME
  candidate window. Mobile keeps tap-to-select (click → same completion path).

  Drafts: on every input the text is pushed to `control.setDraft(agentKey, …)` (§7.1's
  in-memory per-agent drafts — no localStorage), restored on mount, cleared after a send.

  Attachments (web-hub-upload plan §3.2/§4.1, package U5): two LOCAL entries — textarea
  `@paste` (classified by `@logic/upload.js`'s pure `classifyPaste`: files-only pastes are
  intercepted, files+text pastes keep the text flowing into the textarea) and the paperclip
  button + hidden `<input type="file" multiple>` (the only reliable mobile entry) — plus the
  PAGE-WIDE drop zone (`PageDropZone.vue`, App-level, 2026-10 user ruling 「整个页面都是拖放区」):
  the composer carries NO drag handlers of its own, an in-composer drop bubbles to the
  window listeners exactly once (double-processing is structurally impossible). All entries
  delegate admission/scheduling to `ControlHandle.uploads` (U4b's `useUploads`) through the
  shared `addAttachments` pipeline (`./attachmentAdd.ts`) and are disabled together when
  `!enabled` or `uploadAvailability(...)` fails.

  §3.2's **single send gate**: `sendGate()` (pure judgment in `@logic/upload.js`'s
  `canSendWithAttachments`) backs the button's `:disabled`, `doSend()`'s FIRST line, and the
  keyboard path — Enter / Alt+Enter / click can never disagree. `doSend` emits the gate's own
  composed text (body + §3.1 attachment block, ≤48 KiB) and clears the tray via
  `uploads.discard` — NEVER `remove`, which would abort-delete the just-referenced hub files.

  Context ring + stop, merged (2026-10 user request "把 stop 图标放到上下文比例圆圈中"):
  `ContextRing` lives in the card's bottom row while that row is expanded, and re-anchors to
  the card's right-edge vertical center whenever the row is collapsed (typing / no switcher —
  the `.composer-input` wrapper; the textarea's constant `padding-right` makes room via `:has`
  in BOTH states). IDLE ⇒ the ring's details toggle; BUSY ⇒
  the ring's whole zone is the two-step stop button (stop wins — nothing else intercepts taps
  there). It injects `DETAIL_METRICS` itself and self-hides the ring without a provider (then
  falls back to the standalone stop look) — nothing here reads the metrics.

  Model/thinking chips + context ring as an input CARD (2026-10 user-picked mock option 1, with
  the user's collapse refinement — supersedes the 5cc081d top-left chips overlay and, before it,
  web-model-switch plan v2 §5.1's slim `.dock-tools` strip): `.composer-input` IS the card — the
  border/radius/background live on it, the textarea is borderless inside, and a bottom row
  (`.composer-bottom`) INSIDE the same border carries `ModelSwitcher` (which renders
  `ThinkingChip` itself) on the left and the `ContextRing` on the right, in NORMAL flow. While
  `text` is non-empty (`.has-text`) the chips fade/slide out (`.chips-off`, `visibility:hidden`
  — out of the tab order and the a11y tree, `pointer-events:none`) AND the row's height
  collapses to 0 (max-height transition — no dead strip), and the ring re-anchors to its base
  absolute geometry: the card's right edge, vertically centered (the card's height is then
  exactly the textarea's, so this is byte-identical to the pre-card mid-right overlay). The
  textarea keeps a CONSTANT `padding-right:36px` ring slot in BOTH states, so text never
  reflows horizontally, and the row sits BELOW the textarea, so the switch never moves existing
  text vertically either. The expanded row is `:has(.model-switcher)`-gated in CSS: when
  ModelSwitcher self-hides (the §5.4 not-rendered states) there is no bottom row at all and the
  ring overlays mid-right exactly as before 5cc081d. Pickers still open upward from the chips
  and keep their usePopoverClamp viewport fitting — opening one moves focus into the panel,
  which the chips' hidden state can never interrupt (hidden ⇒ not clickable).
-->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import {
  commandPolicyFor,
  composerKeyAction,
  matchCommandRows,
  mergeRecalledDraft,
  parseSlash,
} from "@logic/control.js";
import {
  applyMentionPick,
  filterMentionTargets,
  mentionCompletion,
  moveMentionActive,
  mentionTargets,
} from "@logic/mention.js";
import { canSendWithAttachments, classifyPaste, uploadAvailability } from "@logic/upload.js";
import { decoratePalette, resumeAvailable } from "@logic/resume.js";
import { buildFileSearchUrl, parseFileSearchResults } from "@logic/file-mention.js";
import { API } from "@logic/contract.js";
import { useI18n } from "../../composables/useI18n.js";
import type { ComposerEmits, ComposerProps } from "../../contracts.js";
import type { ControlHandle } from "../../types.js";
import { CONTROL_CTX } from "../../composables/useControl.js";
import AppIcon from "../../icons/AppIcon.vue";
import { addAttachments } from "./attachmentAdd.js";
import AttachmentTray from "./AttachmentTray.vue";
import CommandPalette from "./CommandPalette.vue";
import ContextRing from "./ContextRing.vue";
import ModelSwitcher from "./ModelSwitcher.vue";
import { CONTROL_ENV, CONTROL_VIEW, HUB_CTX } from "./controlContext.js";
import { useDeliverDefault } from "../../composables/useDeliverDefault.js";
import { browserLocalStorage } from "../shell/themeStorage.js";
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

// 2026-10 (user-decided): no per-message mode state — busy sends read the settings page's
// stored default (`pwh_deliver`, fallback steer). Read once at mount; the settings page and
// the composer are never mounted at the same time (different routes).
const deliverDefault = useDeliverDefault({ storage: browserLocalStorage() });
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
// web-resume §2.6 (P3): while the agent advertises resume.v1 (§2.7), the slash resume forms
// are intercepted client-side (DetailDock.onSend's FIRST line) and never sent as commands —
// so they must not be command-routed here either (the advertised policy is deny, §2.7, and a
// denied command cannot pass §3.2's gate). Bare `resume` needs nothing here: it is plain
// text and already passes; with attachments the composed text stops matching the intent
// regex, so the “empty tray” half of the gate rule falls out structurally.
const resumeOn = computed(() => resumeAvailable(view?.agent.value.status));
const resumeSlash = computed(() => {
  const s = slash.value;
  if (s === undefined || !commandsEnabled.value || !resumeOn.value) return false;
  return s.name === "resume" || s.name === "resume-recent";
});
const commandMode = computed(
  () => slash.value !== undefined && commandsEnabled.value && !sendAsText.value && !resumeSlash.value,
);

// ---------------------------------------------------------------------------
// @mention completion (web-hub task #11) + @文件补全 (file-mention)
// ---------------------------------------------------------------------------
// A line-initial `@partial` token opens a TWO-ZONE panel: root-direct sub-agents from the
// live fleet (running, settled/resumable, and other/unavailable rows) plus files under the
// session cwd (debounced ~200ms search). The agent remains authoritative for send routing;
// the browser sends the raw leading @mention as a normal prompt. Keyboard navigation is
// continuous across both zones.
const rootEl = ref<HTMLElement | null>(null);
const caret = ref(text.value.length);
const mentionDismissed = ref(false); // Esc / outside-pointerdown latch, reset on any input
const mentionActive = ref(0);

function syncCaret(): void {
  caret.value = textareaEl.value?.selectionStart ?? text.value.length;
}

const mentionState = computed(() => mentionCompletion(text.value, caret.value));
type MentionPanelTarget = {
  readonly label: string;
  readonly runId: string;
  readonly status: "running" | "settled" | "other";
};
const mentionTargetsForFleet = computed<readonly MentionPanelTarget[]>(
  () => mentionTargets([...(view?.agent.value.fleet ?? [])]) as MentionPanelTarget[],
);
const mentionRows = computed<readonly MentionPanelTarget[]>(() =>
  mentionState.value.open ? filterMentionTargets(mentionTargetsForFleet.value, mentionState.value.query) : [],
);

// --- file zone (debounced search; silent degrade on any failure) -------------------------

interface FilePanelRow {
  readonly kind: "file";
  readonly path: string;
  readonly rel: string;
}
type PanelRow =
  | {
      readonly kind: "agent";
      readonly label: string;
      readonly runId: string;
      readonly status: "running" | "settled" | "other";
    }
  | FilePanelRow;

const FILE_SEARCH_DEBOUNCE_MS = 200;
const FILE_SEARCH_LIMIT = 20;

const fileRows = ref<readonly FilePanelRow[]>([]);
/** Armed once THIS token's search has returned ≥1 hit — keeps the panel (and its empty line)
 * up while the user keeps typing past every match, exactly like the sub-agent zone's
 * `runningTargets.length > 0` arm. Reset when the token closes. */
const fileArmed = ref(false);
let fileSeq = 0;
let fileTimer: ReturnType<typeof setTimeout> | undefined;
let fileCtl: AbortController | undefined;

function stopFileSearch(): void {
  if (fileTimer !== undefined) {
    clearTimeout(fileTimer);
    fileTimer = undefined;
  }
  fileSeq += 1; // any in-flight/stale response is dropped by the seq guard
  fileCtl?.abort();
  fileCtl = undefined;
}

function resetFileZone(): void {
  stopFileSearch();
  fileRows.value = [];
  fileArmed.value = false;
}

async function doFileSearch(q: string, seq: number, key: string): Promise<void> {
  const ctl = new AbortController();
  fileCtl = ctl;
  try {
    const r = await fetch(buildFileSearchUrl(API.filesSearch, key, q, FILE_SEARCH_LIMIT), {
      credentials: "same-origin",
      method: "GET",
      headers: { "X-PWH": "1" },
      signal: ctl.signal,
    });
    if (seq !== fileSeq) return;
    if (!r.ok) return; // 401/429/… — silent degrade to the sub-agent zone
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return;
    }
    if (seq !== fileSeq) return;
    const rows = parseFileSearchResults(body);
    fileRows.value = rows.map((row) => ({ kind: "file" as const, path: row.path, rel: row.rel }));
    if (rows.length > 0) fileArmed.value = true;
  } catch {
    /* network/abort — silent degrade */
  } finally {
    if (fileCtl === ctl) fileCtl = undefined;
  }
}

// The token's query (null when the completion is closed): schedules/cancels the file search.
watch(
  () => (mentionState.value.open ? mentionState.value.query : null),
  (q) => {
    stopFileSearch();
    fileRows.value = [];
    if (q === null) {
      fileArmed.value = false;
      return;
    }
    if (typeof q !== "string" || q.length < 1) return; // bare "@": files need ≥1 character (sub-agents still list)
    const seq = fileSeq;
    const key = view?.agentKey ?? ctx?.agentKey ?? null;
    if (key === null) return;
    if (view?.agent.value.session === undefined) return; // no live session ⇒ hub answers 409
    if (typeof fetch !== "function") return;
    fileTimer = setTimeout(() => {
      void doFileSearch(q, seq, key);
    }, FILE_SEARCH_DEBOUNCE_MS);
  },
);

const panelRows = computed<readonly PanelRow[]>(() => [
  ...mentionRows.value.map((r) => ({ kind: "agent" as const, label: r.label, runId: r.runId, status: r.status })),
  ...fileRows.value,
]);
const mentionOpen = computed(
  () =>
    mentionState.value.open &&
    !mentionDismissed.value &&
    !commandMode.value &&
    (mentionTargetsForFleet.value.length > 0 || fileArmed.value),
);
// Reset the highlight only when the QUERY (or open) changes; a fleet wire refresh (~1Hz)
// rebuilds the rows array with identical content — resetting on that would yank the user's
// arrow-key selection back to the first row (verifier P3, 2026-10-05).
watch(
  () => (mentionState.value.open ? mentionState.value.query : null),
  () => {
    mentionActive.value = 0;
  },
);
watch(panelRows, (rows) => {
  if (mentionActive.value > rows.length - 1) mentionActive.value = Math.max(0, rows.length - 1);
});

function pickPanelRow(row: PanelRow): void {
  const applied = applyMentionPick(text.value, caret.value, row.kind === "agent" ? row.label : row.path);
  text.value = applied.text;
  persistDraft();
  void nextTick(() => {
    const el = textareaEl.value;
    if (el) {
      el.focus();
      el.setSelectionRange(applied.caret, applied.caret);
    }
    caret.value = applied.caret;
    grow();
  });
}

function onDocPointerDown(ev: Event): void {
  if (!mentionOpen.value) return;
  const root = rootEl.value;
  if (root !== null && ev.target instanceof Node && root.contains(ev.target)) return;
  mentionDismissed.value = true;
}
onMounted(() => document.addEventListener("pointerdown", onDocPointerDown, true));

/** Mention key layer, called from `onKeydown` while the panel is open. Returns true when the
 * event was consumed (never reaches `composerKeyAction` — Enter picks instead of sending).
 * Navigation spans BOTH zones (one flat index over `panelRows`). */
function mentionKeydown(ev: KeyboardEvent): boolean {
  if (!mentionOpen.value) return false;
  if (ev.key === "Escape") {
    mentionDismissed.value = true;
    return true;
  }
  if (ev.key === "ArrowDown") {
    mentionActive.value = moveMentionActive(mentionActive.value, 1, panelRows.value.length);
    return true;
  }
  if (ev.key === "ArrowUp") {
    mentionActive.value = moveMentionActive(mentionActive.value, -1, panelRows.value.length);
    return true;
  }
  if (ev.key === "Enter" && !ev.shiftKey && !ev.altKey) {
    const row = panelRows.value[mentionActive.value] ?? panelRows.value[0];
    if (row === undefined) return false; // zero matches: fall through to the normal key map
    pickPanelRow(row);
    return true;
  }
  return false;
}
const policy = computed(() =>
  commandMode.value && slash.value ? commandPolicyFor([...commands.value], slash.value.name, busy.value) : null,
);
// §2.6 decoratePalette: the /resume + /resume-recent rows render RUNNABLE with the
// 「恢复会话」 description while available (the agent advertises them deny for old UIs).
// The decoration rides BOTH surfaces: the `commands` prop (CommandPalette re-derives its
// rendered rows through matchCommandRows internally) and the composer's own keyboard rows.
const paletteCommands = computed(
  () =>
    decoratePalette(
      [...commands.value] as unknown as readonly import("@logic/resume.js").PaletteRowLike[],
      resumeOn.value ? t("resume.paletteDesc") : null,
    ) as unknown as readonly Record<string, unknown>[],
);
const paletteRows = computed(() => {
  if (slash.value === undefined || !commandsEnabled.value || sendAsText.value) return [];
  // Matching over the DECORATED slot rows keeps the keyboard half and the rendered palette
  // one computation apart (matchCommandRows re-derives policy from the same array).
  return matchCommandRows([...paletteCommands.value], slash.value.name, busy.value);
});
const paletteOpen = computed(
  () => slash.value !== undefined && commandsEnabled.value && (commandMode.value || resumeSlash.value),
);

// --- command-palette keyboard model (2026-10 user request, see file header) ----------------

const paletteId = useId(); // listbox root id; option ids are `<paletteId>-opt-<index>` (CommandPalette mirrors)
/** Highlight index (raw state; `paletteActiveIndex` is the clamped view of it). */
const paletteActive = ref(0);
/** Esc/completion latch: palette hidden while the NAME TOKEN is unchanged (typing args after a
 * completion never re-pops it); editing the name (`watch` below) reopens with a fresh highlight. */
const paletteSuppressed = ref(false);
/** The name a completion is currently writing — lets the name watcher distinguish "changed
 * because Tab/click just completed it" (keep suppressed) from "the user edited it" (reopen). */
let completingName: string | null = null;
const paletteVisible = computed(() => paletteOpen.value && !paletteSuppressed.value);
/** The row aria-activedescendant / Tab act on — clamped so a shrinking list can never leave the
 * highlight pointing past the end (mirror of the mention panel's clamp). */
const paletteActiveIndex = computed(() =>
  paletteRows.value.length === 0 ? 0 : Math.min(paletteActive.value, paletteRows.value.length - 1),
);
const paletteActiveRowId = computed(() =>
  paletteVisible.value && paletteRows.value.length > 0 ? `${paletteId}-opt-${paletteActiveIndex.value}` : undefined,
);

// Query change ⇒ fresh highlight (resets to the best match) + reopen (a completion's OWN name
// change is exempt: `completingName` — the palette must STAY hidden right after `/name ` lands).
watch(
  () => slash.value?.name ?? null,
  (name) => {
    const fromCompletion = completingName !== null && name === completingName;
    completingName = null;
    paletteSuppressed.value = fromCompletion;
    paletteActive.value = 0;
  },
);
// A wire refresh can shrink the list under a stationary query — clamp in place (verifier P3,
// same ruling as the mention panel: a fleet refresh must not yank the user's selection).
watch(paletteRows, (rows) => {
  if (paletteActive.value > rows.length - 1) paletteActive.value = Math.max(0, rows.length - 1);
});
// Keep the highlighted option in view when the palette scrolls (≤50 rows vs 240px max-height).
watch(paletteActiveIndex, () => {
  if (!paletteVisible.value) return;
  const id = paletteActiveRowId.value;
  if (id === undefined) return;
  void nextTick(() => {
    const el = document.getElementById(id);
    if (el !== null && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  });
});

/** Palette key layer, called from `onKeydown` while the palette is visible. Returns true when
 * the event was consumed (never reaches `composerKeyAction`). Focus NEVER leaves the textarea:
 * Tab is consumed even when it completes nothing (deny row / zero rows) — while the palette is
 * CLOSED Tab falls through untouched (no focus trap). IME keys are never taken (isComposing /
 * keyCode 229 — they belong to the candidate window, not the palette). Enter is deliberately
 * NOT consumed: it keeps the normal key map and executes the typed command (current behaviour). */
function paletteKeydown(ev: KeyboardEvent): boolean {
  if (!paletteVisible.value) return false;
  if (ev.isComposing || ev.keyCode === 229) return false;
  const rows = paletteRows.value;
  if (ev.key === "Escape") {
    paletteSuppressed.value = true; // close without clearing the text; name edit reopens
    return true;
  }
  if (ev.key === "ArrowDown") {
    paletteActive.value = moveMentionActive(paletteActive.value, 1, rows.length);
    return true;
  }
  if (ev.key === "ArrowUp" || (ev.key === "Tab" && ev.shiftKey)) {
    paletteActive.value = moveMentionActive(paletteActive.value, -1, rows.length);
    return true;
  }
  if (ev.key === "Tab") {
    const row = rows[paletteActiveIndex.value];
    if (row !== undefined && row.policy !== "deny") completeCommand(row.name);
    return true; // deny row / zero rows: no completion, but Tab still never leaves the composer
  }
  return false;
}

/** Tab/click completion: `/name ` (trailing space — args come next), palette hidden, caret at
 * the end, focus back in the textarea. The one insert path both the keyboard and pointer pick
 * funnel through, so they can never diverge. */
function completeCommand(name: string): void {
  completingName = name; // the name watcher keeps the palette suppressed across this change
  text.value = `/${name} `;
  paletteSuppressed.value = true; // also covers completing to the SAME name (watcher won't fire)
  paletteActive.value = 0;
  persistDraft();
  void nextTick(() => {
    completingName = null; // stale guard: a later MANUAL re-type of the same name must reopen
    grow();
    const el = textareaEl.value;
    if (el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      caret.value = end;
    }
  });
}

/** §7.6 placeholders: idle announces "starts a new turn" (D4). Busy follows the STORED
 * delivery default (acceptance P2: a fixed "steer" placeholder lied when the settings page
 * default was followUp — Enter actually queues then). */
const placeholder = computed(() => {
  if (!busy.value) return t("control.placeholderIdle");
  return deliverDefault.deliver.value === "followUp"
    ? t("control.placeholderBusyFollowUp")
    : t("control.placeholderBusy");
});

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

/** Transient add/paste feedback line (admission rejects) — auto-clears. */
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
  resetFileZone();
  document.removeEventListener("pointerdown", onDocPointerDown, true);
});

function addFiles(files: readonly unknown[]): void {
  const key = agentKey.value;
  if (!uploadOn.value || uploadsHandle === undefined || key === null || files.length === 0) return;
  addAttachments(uploadsHandle, key, files, t, showHint);
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

/** §4.1 entry 2 — the paperclip button (§4.4: the only reliable mobile entry). Entry 3 is
 * the PAGE-WIDE drop zone: `PageDropZone.vue` owns the window-level drag listeners (2026-10
 * user ruling), so the composer deliberately has none — an in-composer drop bubbles up and
 * is handled exactly once, identical to a drop anywhere else on the page. */
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

/** attachment-preview: read-only source access for the tray's pre-send thumbnails/viewer —
 * never the upload loop's own path (that stays closure-private inside `useUploads`). */
function traySourceOf(id: string): unknown {
  const key = agentKey.value;
  if (uploadsHandle === undefined || key === null) return undefined;
  return uploadsHandle.source === undefined ? undefined : uploadsHandle.source(key, id);
}

/** §3.2's ONE gate — button `:disabled`, `doSend`'s first line, and the keyboard path all see
 * this exact answer. `commandRouted` mirrors DetailDock.onSend's routing (`parseSlash` +
 * `commandsEnabled`, deliberately NOT `sendAsText`) so the gate's command-policy / 16 KiB args
 * checks see exactly the text DetailDock would execute. */
function sendGate() {
  const g = canSendWithAttachments({
    enabled: props.enabled,
    sending: sending.value,
    text: text.value,
    attachments: [...trayItems.value],
    // web-resume §2.6: the slash resume forms are intercepted client-side (never sent), so
    // they are NOT command-routed — the advertised deny must not block them at the gate.
    // DetailDock still re-derives the policy from the ROUTED text (sendAsText only changes
    // composer display), so the non-resume branches keep seeing exactly the routed answer.
    commandRouted: slash.value !== undefined && commandsEnabled.value && !resumeSlash.value,
    policy:
      slash.value !== undefined && commandsEnabled.value && !resumeSlash.value
        ? commandPolicyFor([...commands.value], slash.value.name, busy.value)
        : policy.value,
  });
  // §2.6 "intent ∧ available ∧ empty tray": with attachments the composed text stops
  // matching the intent (bare form) — the slash form would still pass as plain text, so it
  // is blocked explicitly here; the hint line reuses upload.gateBlocked.
  if (g.ok && resumeSlash.value && trayItems.value.length > 0) {
    return { ok: false as const, reason: "attachment-block" as const };
  }
  return g;
}
const gate = computed(sendGate);

/** The tray-related block reasons surface as a persistent hint line (§3.2's 提示); transient
 * add/drop feedback (`hint`) takes priority over it. */
const gateHint = computed(() => {
  const g = gate.value;
  if (g.ok) return null;
  if (g.reason === "queued" || g.reason === "uploading") return t("upload.gateUploading");
  if (g.reason === "failed") return t("upload.gateFailed");
  if (g.reason === "args-too-large") return t("upload.gateArgsTooLarge");
  if (g.reason === "too-large") return t("upload.gateTooLarge");
  if (g.reason === "attachment-block") return t("upload.gateBlocked");
  return null;
});

function persistDraft(): void {
  ctx?.control.setDraft(ctx.agentKey, text.value);
}

function onInput(): void {
  syncCaret();
  mentionDismissed.value = false; // any edit re-arms the completion after Esc/outside-click
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
  if (paletteKeydown(ev)) {
    ev.preventDefault();
    return;
  }
  if (mentionKeydown(ev)) {
    ev.preventDefault();
    return;
  }
  const action = composerKeyAction(ev, { busy: busy.value });
  if (action === "newline") return; // default behaviour (insert a newline)
  ev.preventDefault();
  // No local deny early-exit anymore (§3.2): a denied command is `command-policy` in sendGate.
  doSend(action === "followUp" ? "followUp" : deliverDefault.deliver.value);
}

function onSendClick(): void {
  doSend(deliverDefault.deliver.value);
}

/** Stop (2026-10 user request: moved INTO the input's inner edge): same channel the dock used —
 * `CONTROL_VIEW`'s `ControlHandle` straight from the inject, no emit hop. Renders only when a
 * view with a live control handle is present (the dock's control-ON context). */
function onStopInline(): void {
  if (view === null || view.control === null) return;
  void view.control.abort(view.agentKey).catch(() => {});
}

/** The 44px touch-target floor lives on the CARD (control.css, 2026-10-07 symmetric-gap
 * ruling), so a single-line composer has a few px of centering slack above/below the
 * textarea where a tap lands on the card itself — refocus the textarea so the whole card
 * stays the hit target. Interactive children (ring/stop/chips) are excluded by the target
 * check; preventDefault keeps the press from starting a text selection or shifting focus. */
function onCardMousedown(e: MouseEvent): void {
  if (e.target !== e.currentTarget) return;
  e.preventDefault();
  textareaEl.value?.focus();
}

watch(
  () => props.draft,
  (d) => {
    if (d !== undefined) text.value = d;
  },
);

// steer-recall §7 (P-ui): a recalled body backfills AHEAD of the current draft whenever `rev`
// bumps (rev, not text, is the trigger — the same body re-recalled still re-fills), then the
// composer persists, focuses itself and grows (the dock announces the recall separately).
watch(
  () => props.injectDraft?.rev,
  (rev, prev) => {
    const inj = props.injectDraft;
    if (rev === undefined || rev === prev || inj === undefined) return;
    if (typeof inj.text !== "string" || inj.text === "") return;
    text.value = mergeRecalledDraft(inj.text, text.value);
    persistDraft();
    void nextTick(() => {
      grow();
      const el = textareaEl.value;
      if (el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
        caret.value = end;
      }
    });
  },
);
</script>

<template>
  <div ref="rootEl" class="composer" :class="{ 'cmd-mode': commandMode }" @paste="onPaste">
    <CommandPalette
      v-if="paletteVisible && slash"
      :commands="paletteCommands"
      :query="slash.name"
      :busy="busy"
      :active="paletteActiveIndex"
      :listbox-id="paletteId"
      @pick="completeCommand"
      @hover="paletteActive = $event"
    />
    <!-- @mention completion (task #11 + file-mention): rendered before the input row so it
         opens UPWARD from the bottom-pinned composer. TWO zones — the session's running
         sub-agents, then files under the session cwd (relative path shown; pick inserts
         `@<absolute path> `). Enter/click inserts, arrows navigate across BOTH zones,
         Esc/outside-pointerdown closes. -->
    <div v-if="mentionOpen" class="mention-panel" role="listbox" :aria-label="t('control.mentionAria')">
      <p v-if="mentionRows.length > 0" class="mention-zone">{{ t("control.mentionZone") }}</p>
      <button
        v-for="(row, i) in mentionRows"
        :key="row.runId"
        type="button"
        role="option"
        class="mention-item"
        :class="{ active: i === mentionActive }"
        :aria-selected="i === mentionActive"
        @click="pickPanelRow({ kind: 'agent', ...row })"
        @mousemove="mentionActive = i"
      >
        <span class="mention-label" translate="no">@{{ row.label }}</span>
        <span class="chip chip-muted mention-status">{{
          row.status === "running"
            ? t("control.mentionRunning")
            : row.status === "settled"
              ? t("control.mentionSettled")
              : t("control.mentionUnavailable")
        }}</span>
      </button>
      <p v-if="fileRows.length > 0" class="mention-zone">{{ t("control.fileZone") }}</p>
      <button
        v-for="(row, i) in fileRows"
        :key="row.path"
        type="button"
        role="option"
        class="mention-item mention-file"
        :class="{ active: i + mentionRows.length === mentionActive }"
        :aria-selected="i + mentionRows.length === mentionActive"
        @click="pickPanelRow({ kind: 'file', path: row.path, rel: row.rel })"
        @mousemove="mentionActive = i + mentionRows.length"
      >
        <span class="mention-label" translate="no">{{ row.rel }}</span>
      </button>
      <p v-if="panelRows.length === 0" class="mention-empty">{{ t("control.mentionEmpty") }}</p>
    </div>
    <AttachmentTray
      v-if="trayItems.length > 0"
      :items="trayItems"
      :plaintext="plaintext"
      :source-of="traySourceOf"
      @remove="onTrayRemove"
      @retry="onTrayRetry"
    />
    <div class="composer-row">
      <input
        ref="fileInputEl"
        class="file-input sr-only"
        type="file"
        multiple
        tabindex="-1"
        aria-hidden="true"
        @change="onFilePick"
      />
      <!-- composer-input is the CARD (2026-10 user-picked mock option 1 + collapse
           refinement): border/radius/background here; the textarea is borderless inside;
           `.composer-bottom` (chips left, ring right, normal flow) sits INSIDE the same
           border. `has-text` collapses the row (max-height→0, no dead strip) and the ring
           falls back to its absolute mid-right geometry; no `.model-switcher`
           (ModelSwitcher self-hide, §5.4) never expands the row at all. Constant
           padding-right:36px ring slot on the textarea in every state (control.css). -->
      <div class="composer-input" :class="{ 'has-text': text !== '', busy }" @mousedown="onCardMousedown">
        <textarea
          ref="textareaEl"
          v-model="text"
          :disabled="!enabled"
          :placeholder="placeholder"
          :aria-label="placeholder"
          rows="1"
          enterkeyhint="send"
          :role="paletteVisible ? 'combobox' : undefined"
          :aria-multiline="paletteVisible ? 'true' : undefined"
          :aria-expanded="paletteVisible ? 'true' : undefined"
          :aria-controls="paletteVisible ? paletteId : undefined"
          :aria-autocomplete="paletteVisible ? 'list' : undefined"
          :aria-activedescendant="paletteActiveRowId"
          @input="onInput"
          @keydown="onKeydown"
          @keyup="syncCaret"
          @click="syncCaret"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
        ></textarea>
        <div class="composer-bottom">
          <!-- Chips (left end of the bottom row): fade/slide out via `.chips-off` while the
               input has content; `visibility:hidden` removes them from the tab order and the
               a11y tree while hidden. ModelSwitcher self-hides (§5.4) — the row's expanded
               state is `:has(.model-switcher)`-gated, so an empty composer pays nothing then. -->
          <div class="composer-chips" :class="{ 'chips-off': text !== '' }">
            <ModelSwitcher />
          </div>
          <div class="composer-end">
            <!-- Attach (2026-10-07 user request 「附件按钮放到上下文进度的左侧」): moved INSIDE
                 the card, immediately left of the ring, following the ring's two placements —
                 absolute mid-right while the row is collapsed (upload.css), in-flow here when
                 expanded. Frameless inside the card; the hit zone stretches full card height. -->
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
            <!-- Context ring + stop, merged (right end of the bottom row while the row is
                 expanded; absolute mid-right overlay otherwise — control.css's `:not(.has-text)`
                 tier). Idle ⇒ ring details toggle; busy + live control ⇒ the whole ring zone is
                 the two-step stop button. Self-hides the ring when no DETAIL_METRICS provider/
                 contextUsage exists, falling back to the standalone stop look so stop stays
                 reachable. Same stop channel the dock used — no emit hop (see `onStopInline`). -->
            <ContextRing
              :busy="busy && view?.control != null"
              :queue-count="view === null ? 0 : view.queueItems.value.length"
              @stop="onStopInline"
            />
          </div>
        </div>
      </div>
      <button
        class="btn btn-primary composer-send"
        type="button"
        data-send
        :disabled="!gate.ok"
        :aria-label="t('control.sendAria')"
        @click="onSendClick"
      >
        <AppIcon name="send-plane" class="icon-sm send-icon" />
        <span class="lbl-md">{{ t("control.send") }}</span>
      </button>
    </div>
    <div v-if="hint" class="composer-hint is-transient" role="status">{{ hint }}</div>
    <div v-else-if="gateHint" class="composer-hint" role="note">{{ gateHint }}</div>
    <!-- 2026-10-09 「cmd 标记导致输入框抖动」(user picked option 2): the badge lives at the head
         of the command-mode sub row instead of before the input card, so entering / never
         changes the input's width. -->
    <div v-if="commandMode" class="composer-sub">
      <span class="chip cmd-badge" translate="no">{{ t("control.cmdBadge") }}</span>
      <label class="send-as-text"
        ><input v-model="sendAsText" type="checkbox" name="send-as-text" />{{ t("control.sendAsText") }}</label
      >
      <span v-if="policy === 'deny'" class="cmd-denied" role="alert">{{ t("control.cmdDeniedTerminal") }}</span>
    </div>
  </div>
</template>
