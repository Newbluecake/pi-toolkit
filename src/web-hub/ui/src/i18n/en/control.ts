/**
 * `control` i18n namespace (control-plan.md v2.1 §7.6, §12.3 — C5): the control plane —
 * composer, stop button, queue list, command mode, and the persistent risk notice. Compact
 * inline markers (mode/source/state/policy badges) stay English tokens in BOTH languages
 * (AGENTS.md UI-text split); prose blocks get real translations. (2026-10: the per-message
 * delivery switch moved to the settings page — its labels now live in the `settings`
 * namespace.)
 */
const control = {
  // --- persistent risk notice (§7.6 table, verbatim) ---
  noticePlainHttp:
    "Control is on. This page can send messages to your agents and stop them. Over plain HTTP, anyone who can see this network's traffic can hijack your session and run arbitrary commands as you.",
  // The plainHttp body minus its plaintext sentence — used ONLY when the browser pref
  // `pwh_hide_plaintext_warn` (explicit user opt-out, 2026-10) hides plaintext warnings: the
  // control-risk remainder stays visible.
  noticePlainHttpMasked: "Control is on. This page can send messages to your agents and stop them.",
  noticeLocal: "Control is on. Messages you send run with this computer's full permissions.",
  noticeHttps: "Control is on. Messages you send run with the host machine's full permissions.",
  noticeTitle: "Control is on",
  noticeExpand: "Details",
  noticeCollapse: "Hide details",
  noticeDismiss: "Dismiss this notice",

  // --- composer (§7.4/§7.6) ---
  // 2026-10-07 (user request 「插话当前轮的提示不优雅」×2): concise full-sentence prompts;
  // the busy pair still mirrors the stored delivery default (acceptance P2 — a fixed steer
  // text lied when the default was follow-up).
  placeholderIdle: "Type a message…",
  placeholderBusy: "Interject this turn…",
  placeholderBusyFollowUp: "Queue a follow-up…",
  send: "Send",
  sendAria: "Send message",

  // --- composer context ring (2026-10-05, user 现场拍板: context metric moved here from the
  // detail header; panel labels reuse the `detail` namespace) ---
  contextRingAria: "Context used {p} — show details",
  contextRingPanelAria: "Context and cost details",

  // --- stop button (two-step, §7.4) ---
  stop: "Stop",
  stopConfirm: "Confirm stop",
  stopAria: "Stop the current turn",
  stopArmed: "Armed — click again to confirm, Esc to cancel",
  stopQueueNote: "{n} queued message(s) will still be sent",

  // --- queue list (§7.4/§7.7) — badges are compact English tokens in both languages ---
  queueAria: "Message queue",
  badgeSteer: "steer",
  badgeFollowUp: "follow-up",
  sourceWeb: "web",
  sourceTerminal: "terminal",
  stateSending: "sending",
  stateQueued: "queued",
  stateFailed: "failed",
  stateDropped: "dropped",
  stateUnknown: "unknown",
  stateQuerying: "checking",
  stateNotExecuted: "not executed",
  stateUnconfirmed: "unconfirmed",
  stateUnobserved: "sent · unconfirmed",
  stateRunning: "running",

  // --- steer recall (web-hub-steer-recall plan §7, P-ui) — state chips stay English tokens
  // in both languages; notes/arias are prose. ---
  stateHeld: "held",
  stateRecalling: "recalling",
  stateReturned: "returned",
  stateHanded: "handed",
  stateUnavailable: "unavailable",
  recall: "Recall",
  recallAria: "Recall this held message: {text}",
  edit: "Edit",
  editAria: "Recall and edit this returned message: {text}",
  discardHeldAria: "Discard this returned message",
  copyHeld: "Copy",
  copyHeldAria: "Copy this message's text",
  heldNote: "Held until the current turn ends — recall it to edit or cancel.",
  handedNote: "Handed to the model — no longer recallable.",
  tooLate: "Already delivered (or recalled in another tab) — copy the text if you still need it.",
  returnedAborted: "Returned: the turn was aborted before delivery.",
  returnedSession: "Returned: the session ended before delivery.",
  returnedReload: "Returned: the extension reloaded before delivery.",
  returnedStale: "Returned without delivery — edit and resend if you still want it.",
  previousSession: "from a previous session",
  recalledAnnounce: "Message recalled to the composer.",
  holdUnavailable:
    "Connection unavailable: cannot recall. If it is still held it becomes recallable again once the link returns; otherwise it is handed to the model or returned here.",

  retry: "Retry",
  retryAria: "Retry this item",
  discard: "Discard",
  discardAria: "Discard this item",
  resend: "Resend",
  resendAria: "Resend as a new action",
  droppedNote: "Returned to the terminal editor or discarded.",
  unconfirmedNote: "Sent, but could not confirm it entered the conversation — check the transcript.",
  unknownNote: "Outcome unknown — querying the agent, never re-sent automatically.",
  offlineNote: "Outcome unknown — the agent went offline.",
  notExecutedNote: "Never reached the agent — resend as a new action.",
  sessionChanged: "The terminal switched sessions — confirm, then resend.",
  resultUnknown: "Result unknown — never re-executed automatically.",
  hubRestarting: "The hub is restarting — this request was not received; retry once it is back.",

  // --- command mode (§4.6/§7.7) ---
  cmdBadge: "cmd",
  sendAsText: "Send as text",
  paletteAria: "Command completions",
  policyAllow: "allow",
  policyConfirm: "confirm",
  policyDeny: "deny",
  outputHere: "output here",
  outputTerminal: "output in terminal",
  cmdDeniedTerminal: "Terminal only",
  cmdDeniedUnknown: "Unknown command — never sent as plain text",
  cmdConfirm: "Run /{name}?",
  cmdConfirmHint: "This command is marked confirm — click again to run it.",
  cmdRunning: "Running…",
  cmdWaitingTerminal: "This command is waiting for interaction in the terminal.",
  cmdFailed: "/{name} failed: {error}",

  // --- command output echo (v2.1 §4.9 第 10 条) ---
  "cmdOutput.needsTerminal": "Interactive steps of this command need the terminal; skipped on the web: {steps}",
  "cmdOutput.terminalOnly": "This command's output is only visible in the terminal.",
  "cmdOutput.truncated":
    "Output too long — {entries} entr(y/ies) / {kib} KiB dropped; see the terminal for the full output.",
  "cmdOutput.clipped": "…",

  // --- read-only dock reasons (§7.4 DetailDock) ---
  dockReadonlyHub: "This hub is read-only",
  dockReadonlyAgent: "This pi's pi-toolkit doesn't support web control — update and /reload",
  dockReadonlyOffline: "Agent offline",

  // --- fleet inline sub-agent actions (§7.4) ---
  fleetActionsAria: "Sub-agent actions",

  // --- @mention completion (task #11) + @文件补全 (file-mention) ---
  mentionAria: "Mentions and files",
  mentionZone: "Sub-agents",
  fileZone: "Files",
  mentionEmpty: "No matching sub-agent or file",

  // --- transcript web badge (§7.7, best-effort) ---
  badgeWeb: "web",

  // --- model switcher (web-model-switch plan v2 §5, M3a) — tabs/badges/snapshot stay English
  // tokens in both languages; errors and notes are prose ---
  modelChipAria: "Switch model",
  modelListAria: "Model list",
  modelSearch: "Search models",
  modelTabScoped: "scoped",
  modelTabAll: "all",
  modelCurrentBadge: "current",
  modelEmpty: "No models with credentials",
  modelNoMatch: "No matching model",
  modelReadError: "Couldn't read the full model list",
  modelBusyNote: "Current reply is unaffected; later requests use the new model",
  modelOmitted: "+{n} omitted",
  modelInvalidCount: "{n} invalid",
  modelSnapshot: "snapshot {t}",
  modelOldAgent: "Update pi-toolkit to pick models here — or type /model provider/id",
  modelDeniedPolicy: "Model switching is disabled by webCommandPolicy",
  modelDeniedShadowed: "/model is shadowed by an extension command — pick models in the terminal",
  modelConfirm: "Switch to {id}?",
  modelConfirmRun: "Switch",
  modelConfirmCancel: "Cancel",
  modelErrRejected: "No credentials for this model's provider, or it was rejected",
  modelErrUnknown: "Model not found — the list may be out of date",
  modelErrDenied: "Model switching is disabled by webCommandPolicy",
  modelErrSession: "The session changed — pick again",
  modelErrInvalidRef: "Invalid model reference — not sent",
  modelUnconfirmed: "Not confirmed yet — check the session",
  modelErrGeneric: "Couldn't switch model ({code})",
  modelCheck: "check",
  modelDismiss: "Dismiss",

  // --- thinking chip (web-model-switch plan v2 §5.1/§6, M3b) — level names and the clamp
  // marker stay English tokens in both languages; errors and notes are prose ---
  thinkingChipAria: "Switch thinking level",
  thinkingListAria: "Thinking levels",
  thinkingCurrentBadge: "current",
  thinkingOldAgent: "Update pi-toolkit to pick thinking levels here — or type /thinking <level>",
  thinkingNoLevels: "Thinking levels not reported — update pi-toolkit, or type /thinking <level>",
  thinkingUnsupported: "This model doesn't support thinking levels",
  thinkingDeniedPolicy: "Thinking level switching is disabled by webCommandPolicy",
  thinkingDeniedShadowed: "/thinking is shadowed by an extension command — set levels in the terminal",
  thinkingConfirm: "Set thinking to {level}?",
  thinkingConfirmRun: "Set",
  thinkingConfirmCancel: "Cancel",
  thinkingClamped: "clamped to {level}",
  thinkingBusyNote: "Current reply is unaffected; later requests use the new level",
  thinkingErrBadLevel: "Unknown thinking level",
  thinkingErrDenied: "Thinking level switching is disabled by webCommandPolicy",
  thinkingErrSession: "The session changed — pick again",
  thinkingErrGeneric: "Couldn't set thinking level ({code})",
  thinkingDismiss: "Dismiss",
} satisfies Record<string, string>;

export default control;
