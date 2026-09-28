/**
 * `control` i18n namespace (control-plan.md v2.1 §7.6, §12.3 — C5): the control plane —
 * composer, delivery switch, stop button, queue list, command mode, and the persistent risk
 * notice. Compact inline markers (mode/source/state/policy badges) stay English tokens in BOTH
 * languages (AGENTS.md UI-text split); prose blocks get real translations.
 */
const control = {
  // --- persistent risk notice (§7.6 table, verbatim) ---
  noticePlainHttp:
    "Control is on. This page can send messages to your agents and stop them. Over plain HTTP, anyone who can see this network's traffic can hijack your session and run arbitrary commands as you.",
  noticeLocal: "Control is on. Messages you send run with this computer's full permissions.",
  noticeHttps: "Control is on. Messages you send run with the host machine's full permissions.",
  noticeTitle: "Control is on",
  noticeExpand: "Details",
  noticeCollapse: "Hide details",

  // --- composer (§7.4/§7.6) ---
  placeholderIdle: "Message — starts a new turn",
  placeholderBusy: "Message — steers the current turn (Alt+Enter: follow-up)",
  send: "Send",
  sendAria: "Send message",
  deliverGroup: "Delivery",
  deliverSteer: "Steer",
  deliverFollowUp: "Follow-up",
  idleHint: "Idle — starts a new turn",

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

  // --- transcript web badge (§7.7, best-effort) ---
  badgeWeb: "web",
} satisfies Record<string, string>;

export default control;
