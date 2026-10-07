/**
 * `spawn` i18n namespace (web-hub-spawn plan SP12 / arch §9.1 — `docs/dev/web-hub-spawn/plan.md`):
 * the NewSessionMenu split button, DirPicker, SpawnConfirm, SpawnRow, the AgentCard `web` badge
 * and DetailHeader's managed-session stop button / first-prompt notice.
 *
 * UI-text split (AGENTS.md): compact inline markers — state chips (`starting` / `failed`), the
 * `web` badge, `fp:*` first-prompt tokens — stay English in BOTH languages; prose blocks
 * (hints, warnings, errors) get real translations in zh/spawn.ts.
 */
const spawn = {
  // --- NewSessionMenu (split button; the main button reuses agents.newSession) ---
  menuAria: "New session options",
  menuToggleAria: "More ways to start a session",
  itemSameCwd: "Replace current session (/new)",
  itemPickDir: "Choose a directory…",
  // main-button clicks while spawn is unavailable (2026-10 redesign point 3)
  unavailableHint:
    'Headless sessions are off: set webHub.spawn.enabled: true in ~/.pi/agent/pi-subagent.json (over LAN also webHub.spawn.lan: "known"), then /reload and /webhub restart.',
  retryHint: "Checking whether this hub supports headless sessions — click again.",
  // 「替换当前会话（/new）」 inline confirm bar (AgentList)
  replaceConfirmTitle: "Replace current session",
  replaceConfirmBody:
    "The current session will be replaced by a fresh one. The old session file is kept (resume it with /resume); a terminal attached to the same session switches too.",
  replaceConfirmRun: "Replace",

  // --- pick-dir disabled reasons (SpawnPolicyWire.reason, arch §8.1) ---
  deniedPlatform: "Not supported on this hub's platform",
  deniedLauncher: "Launcher check failed on the hub",
  deniedPersist: "Persistence unavailable on the hub",
  deniedReaper: "Reaper unavailable on the hub",
  deniedCooldown: "Cooling down after failures — retry in a moment",
  deniedBreaker: "Temporarily disabled after repeated failures",
  deniedUnknown: "Unavailable on this hub",

  // --- DirPicker ---
  pickerAria: "Start a session in a directory",
  pickerTitle: "New session in a directory",
  pickerCwdLabel: "Directory",
  pickerCwdPlaceholder: "/path/to/project or ~",
  pickerRecentLabel: "Recent",
  pickerRecentPartial: "Some directories could not be listed.",
  pickerRecentError: "Could not load recent directories.",
  pickerPromptLabel: "First message (optional)",
  pickerPromptPlaceholder: "Sent automatically once the session is live",
  // default-model plan F2 keys (added in F1 so F2 never touches i18n, plan §4)
  pickerModelLabel: "Model (this session only)",
  pickerModelDefault: "Default: {model}",
  pickerPromptTooLong: "First message is {n} bytes — over the 48 KiB limit",
  pickerSubmit: "Start",
  pickerSubmitting: "Starting…",
  pickerAwaiting: "Waiting for the session to come up…",
  pickerUnknown: "Status unknown — still listening; the next sync will settle it.",
  pickerDone: "Session is live.",
  pickerRetry: "Retry",
  pickerCancel: "Cancel",
  pickerClose: "Close",
  // first-prompt mirror chips (inline markers — English tokens in both languages)
  fpPending: "fp: pending",
  fpSending: "fp: sending",
  fpDelivered: "fp: delivered",

  // --- DirPicker error kinds (NewSessionFailKind, plan §3.2) ---
  errDir: "The directory was rejected — pick a recent or allowed directory",
  errDenied: "Spawning is not allowed on this hub right now",
  errLimit: "Process limit reached — stop a session or wait for one to exit",
  errRate: "Too many spawn requests — retry in a moment",
  errLauncher: "The hub cannot launch pi right now — try again later",
  errDeadline: "The hub did not answer in time — check whether the session came up",
  errNetwork: "Network error — retry",
  errSpawn: "The session failed to start",
  errFirstPrompt: "The first message could not be delivered",
  errUnsupported: "This hub does not offer headless sessions",
  errRetryAfter: "Retry in {n}s",
  // default-model plan F1: hub-side 400 E_BAD_REQUEST{reason:"model-invalid"} (drift-only —
  // the UI validates locally first)
  errModelInvalid: "The model was rejected — use a valid provider/id",

  // --- SpawnConfirm ---
  confirmTitle: "Confirm the real directory",
  confirmBody: "The hub resolved your input to the directory below. A new pi session will start there.",
  confirmReasonUnknownDir: "This directory is not in the known list.",
  confirmReasonLan: "Confirmation is required for sessions started over LAN.",
  confirmPlaintext: "Plain HTTP: this confirmation and the session's traffic cross the network unencrypted.",
  confirmRun: "Start in this directory",

  // --- SpawnRow (pending starting/failed placeholder rows) ---
  pendingAria: "Headless sessions in progress",
  stateStarting: "starting",
  stateFailed: "failed",
  rowDetails: "Details",
  rowDetailsAria: "Show failure details for {cwd}",
  rowRetry: "Retry",
  rowRetryAria: "Retry starting a session in {cwd}",
  rowDismiss: "Dismiss",
  rowDismissAria: "Dismiss this row",
  rowOwnerOnly: "Details are only visible to the session's owner.",
  rowStderrTail: "stderr tail",
  rowDetailError: "Could not load details — retry",

  // failure hints (SpawnHint, arch §8.1)
  hintRegisterTimeoutHello: "The session never registered — is pi installed with this extension?",
  hintRegisterTimeoutSession: "The process registered but never opened a session",
  hintControlOff: "The session has the control plane disabled",
  hintNewerPlugin: "The pi version is newer than this hub supports",
  hintCwdMismatch: "The process started in a different directory — it was stopped",
  hintProtocolError: "The process spoke an unexpected protocol — it was stopped",
  hintLauncherChanged: "The pi launcher changed on disk — run /webhub restart",
  // default-model plan D5: pi rejected `--model` at startup (not found / ambiguous)
  hintModelRejected: "The model was rejected by pi — pick another default in Settings",

  // --- AgentCard managed badge (inline marker — English token in both languages) ---
  badgeWeb: "web",
  badgeWebTitle: "Started from the web — managed by this hub",

  // --- DetailHeader (managed session) ---
  stopSession: "Stop session",
  stopSessionConfirm: "Click again to stop",
  stopSessionAria: "Stop this web-started session",
  stopSessionStopping: "stopping…",
  stopSessionFailed: "Stop failed ({code})",
  fpRefilled: "The first message was not delivered ({state}) — its text is back in the draft.",
  fpRefilledDismiss: "Dismiss",

  // --- SpawnRow's two-step delete button (web-hub-delete-session plan v2 §0.3/§5.4) ---
  removeAria: "Stop and delete this web-started session record",

  // --- DirPicker / idempotent-replay-but-record-gone error (§2.5) ---
  errGone: "This session was deleted; start a new one",

  // --- spawn-restore plan §9.1 (RS7): restore across hub restarts ---
  // inline markers (English token in both languages)
  stateRestoring: "restoring",
  badgeRestoring: "restoring",
  badgeRestored: "restored",
  badgeRestoringTitle: "Restoring after a hub restart — messages sent now would be lost",
  badgeRestoredTitle: "Restored after a hub restart",
  restorePhaseReaping: "Stopping the previous process…",
  restorePhaseForking: "Starting pi on the saved session…",
  restorePhaseRegistering: "Waiting for the restored session to register…",
  restoreAttempt: "attempt {n}",
  restoringTitle: "Restoring session",
  restoringBody:
    "The hub restarted; this web session is being restored on its saved history. The view switches to it automatically.",
  composerRestoring: "This session is being restored — sending is disabled until it is back.",
  restoreFailSessionMissing: "The session file no longer exists — cannot restore",
  restoreFailSessionInvalid: "The session file is unreadable or does not match — cannot restore",
  restoreFailPrevAlive: "The previous process could not be stopped — restore cancelled",
  restoreFailPrevUnknown: "Could not confirm the previous process exited — restore cancelled",
  restoreFailScanMiss: "The previous process could not be identified — restore cancelled",
  restoreFailExhausted: "Restore failed repeatedly — gave up",
  restoreFailLifetime: "Too little of the session's lifetime is left to restore it",
  restoreFailLauncher: "The pi launcher is unavailable — run /webhub restart",
  restoreFailReaper: "The hub's orphan reaper is unavailable — restore cancelled",
  restoreFailPersist: "The hub could not save its state — restore cancelled",
  restoreFailCwdChanged: "The session directory changed or is gone — cannot restore",
  restoreFailRegisterTimeout: "The restored session never registered",
  restoreFailExitedEarly: "The restored pi process exited during startup",
} satisfies Record<string, string>;

export default spawn;
