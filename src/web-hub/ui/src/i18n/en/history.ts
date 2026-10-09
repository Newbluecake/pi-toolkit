/**
 * `history` i18n namespace (session-history plan §4.7 — P-ui): the 「历史会话…」 menu entry,
 * SessionHistoryDialog (search / kind toggle / rows / banners / the W1–W7 best-effort note)
 * and HistoryForkConfirm (six body texts + five proof-gap mappings).
 *
 * UI-text split (AGENTS.md): badges and inline markers (`live`, `maybe`, `sub`, `fork`,
 * `gone`, `moved`, `no-access`, `not-dir`, relative times like `5m ago`) stay English in
 * BOTH languages; prose blocks get real translations in zh/history.ts. The
 * `bestEffortNote` copy is pinned by tests: zh must contain 「pid 被新进程复用」 and
 * 「替换又换回」 (W5/W7), en their English counterparts.
 */
const history = {
  // --- AgentList sidebar footer + EmptyState entry (2026-10: the footer entry replaced the
  // --- old NewSessionMenu dropdown item — one persistent entry point, same gating) ---
  sidebarEntry: "History sessions",
  emptyStateItem: "History sessions",

  // --- SessionHistoryDialog shell ---
  dialogAria: "Past sessions",
  dialogTitle: "History sessions",
  searchLabel: "Search sessions",
  searchPlaceholder: "Search title, path or id",
  kindAll: "Include subagents",
  close: "Close",
  loading: "Loading sessions…",
  loadMore: "Load more",
  scanningMore: "Scanning more…",
  // partial:「已索引 X / Y 个会话文件…」(X = stats.indexed, Y = stats.files)
  indexedPartial: "Indexed {x} of {y} session files…",
  indexedIo: "Some file reads failed — retrying",
  // files === 0 with no query
  emptyFiles: "No session files under the hub's sessions directory yet.",
  // files > 0 but nothing matched the query
  noResults: "No sessions match this search.",
  rowNoTitle: "(no title)",
  blockedGone: "The directory no longer exists",
  blockedNoAccess: "The directory is not accessible",
  blockedNotDir: "The path is no longer a directory",
  blockedMoved: "The directory was replaced by a symlink",
  blockedInvalid: "The session file is damaged",
  resume: "Resume",
  forkAction: "Copy as new session",
  goto: "Go to",
  overflowAria: "More actions for this session",
  retry: "Retry",
  sessionErrorTitle: "Could not open this session",

  // --- incompleteNotice banners (logic/sessionHistory.ts's keys, in fixed order) ---
  noticeEnumRunning:
    "Enumerating session directories ({done}/{total}) — ordering is approximate until enumeration completes",
  noticeSkipped: "{n} session files failed to read and are not included; refresh the list to retry",
  noticeDirsSkipped: "{n} directories could not be read",
  noticeChanged: "{n} sessions' directories were changed",
  noticeTruncated: "The list reached its cap",
  noticeIncomplete: "The list may be incomplete",
  livenessNote: "The process scan did not complete — occupancy detection may be incomplete",

  // --- list errors (historyErrorKey) ---
  errBusy: "The hub is busy — retry in a moment",
  errRate: "Too many requests — retry in a moment",
  errDeadline: "The hub did not answer in time — retry",
  errAuth: "The session expired — log in again",
  errCursor: "The list changed on the hub — reload it",
  errNetwork: "Network error — retry",

  // --- failed{kind:"session"} reasons (sessionErrKey) ---
  errSessionRef: "This session reference is invalid — refresh the list",
  errModelWithSession: "A model cannot be set when resuming a session",
  errSessionMissing: "The session file no longer exists — refresh the list",
  errSessionMismatch: "The session file no longer matches its id — refresh the list",
  errSessionInvalid: "The session file is unreadable or does not match — refresh the list",
  errSessionTooLarge: "The session file is too large to copy — open it in place instead",
  errMoved: "The session's directory changed — refresh the list",
  errSessionChanged: "The session file changed while starting — try again",
  errSessionUnsupported: "This hub no longer offers session history — reload the page",

  // --- HistoryForkConfirm (six body texts, forkConfirmKey) ---
  forkTitle: "Copy as a new session",
  forkRun: "Copy and start",
  forkOpenCard:
    "This session is currently open by a web session. To avoid two processes writing the same session file, a COPY will be started as a new session; the original session is unaffected and the two conversations stay separate from here on.",
  forkOpenManaged:
    "This session is currently open by a managed pi process on this hub. To avoid two processes writing the same session file, a COPY will be started as a new session; the original session is unaffected and the two conversations stay separate from here on.",
  forkMaybeProc:
    "A pi process not connected to the hub (pid {pid}) was detected and may have this session open. To be safe, a copy will be started as a new session; the original session is unaffected.",
  forkSubagent:
    "This is a subagent session; it always opens as a copy, and the original keeps its subagent record unchanged.",
  forkManual:
    "A copy of this session will be started as a new session; the original session is unaffected and the two conversations stay separate from here on.",
  forkUnverified:
    "It cannot be confirmed that this session is not currently open by another pi process ({gap}). To avoid two processes writing at once, a copy will be started as a new session; the original session is unaffected.",

  // --- ProofGap → the {gap} text of forkUnverified (historyGapKey) ---
  gapKind: "cannot tell whether this is a main session",
  gapUnconnectedPi: "a pi process not connected to the hub exists (pid {pid})",
  gapCardUnproven: "a pi process that has not reported its session yet exists (pid {pid})",
  gapProcPartial: "the process scan did not complete",
  gapNewProcess: "a new pi/node process started during the check",

  // --- §14.1 residual windows W1–W7 (always present at the dialog's bottom — since the
  // --- 2026-10 layout pass collapsed behind the bestEffortSummary toggle; copy-pinned) ---
  bestEffortSummary: "About occupancy detection",
  bestEffortNote:
    "Occupancy detection is best-effort: processes run as root, inside containers, or started by non-pi launchers cannot be detected (W3/W4); so can a process that opens the session only after the check completes (W1/W2), and the instant a just-exited pi's pid is reused by a new process (W5); auto-restore after a hub restart does not re-check (W6); a session file swapped out and swapped back during startup cannot be detected (W7). Opening the same session twice only forks the session tree — no data is lost or corrupted.",

  // --- SpawnRow's `from` marker (PD15: retry hidden) ---
  fromRetryHidden:
    "This session was opened from history — retry as-is is unavailable; open it again from the history list.",
} satisfies Record<string, string>;

export default history;
