/**
 * `upload` i18n namespace (web-hub-upload plan §4.1–§4.3, package U5 —
 * `docs/dev/web-hub-upload/plan.md`): attachment tray, the three composer entries
 * (paste / drop / attach button), send-gate hints, and the `upload.err.*` mapping
 * §4.2 prescribes for `E_UPLOAD_*` / transport codes. Compact inline markers
 * (state chips) stay English tokens in BOTH languages (AGENTS.md UI-text split);
 * prose blocks (hints, warnings, errors) get real translations.
 */
const upload = {
  // --- tray ---
  trayAria: "Attachments",
  stateQueued: "queued",
  stateUploading: "uploading",
  stateReady: "ready",
  stateFailed: "failed",
  stateRemoving: "removing",
  itemAria: "{name}, {size}, {state}",
  progressAria: "{name} upload progress",
  removeAria: "Remove {name}",
  retry: "Retry",
  retryAria: "Retry uploading {name}",
  announceReady: "{name} attached",
  announceFailed: "{name} failed to upload",

  // --- entries (paste / drop / attach button) ---
  attachAria: "Attach files",
  dropHint: "Drop files to attach them",
  hintTooLarge: "{name} exceeds the 100 MiB file limit",
  hintTooMany: "At most {n} attachments per message",
  hintDuplicate: "{name} is already attached",
  hintInvalid: "{name} cannot be attached",
  hintDirectory: "Folders cannot be attached ({names})",

  // --- send-gate hints (§3.2 — the tray-related block reasons) ---
  gateUploading: "Attachments are still uploading — wait for them to finish",
  gateFailed: "An attachment failed to upload — retry or remove it before sending",
  gateCommand:
    "Attachments can only be sent with a normal message: remove them, or start the text with // to send it as text",
  gateTooLarge: "Message plus attachment block exceeds the 48 KiB limit",
  gateBlocked: "Attachments cannot be sent in the current state",

  // --- plaintext warning (§4.2 — permanent while the tray is non-empty, NOT dismissible) ---
  plaintextWarning: "Plain HTTP: attachment contents cross this network unencrypted and can be intercepted or altered.",

  // --- upload.err.* (§4.2 error mapping; the Attachment.error code indexes here) ---
  errTooLarge: "File exceeds the hub size limit",
  errQuota: "Upload quota exceeded — free space or wait for older uploads to expire",
  errDisabled: "Uploads are disabled on this hub",
  errConflict: "Upload conflict — retry the upload",
  errGone: "Attachment was cleaned up on the hub — upload it again",
  errAgentGone: "Agent disconnected during the upload — retry",
  errBusy: "Hub is reorganizing temporary space — retry in a moment",
  errRestarted: "Hub restarted — upload again",
  errNetwork: "Network error — retry",
  errTimeout: "Upload timed out — retry",
  errAuth: "Session expired — sign in again, then retry",
  errRate: "Too many upload requests — retry in a moment",
  errUnknown: "Upload failed ({code})",
};

export default upload;
