/**
 * `agents` i18n namespace (vue-plan.md v2.1 §3.8, §5.1, §5.2 — P3): the sidebar/list —
 * heading, filter, group label, empty state and per-card bits not already covered by
 * `common`'s shared `status.*` vocabulary.
 */
const agents = {
  title: "Sessions",
  filterPlaceholder: "Filter by path or session…",
  filterAria: "Filter sessions",
  staleOffline: "Stale & Offline",
  stopped: "Stopped",
  emptyTitle: "No pi sessions connected",
  emptyBodyLead: "Start pi on this machine with",
  emptyBodyTail: "on; sessions appear here within a second.",
  runningCount: "{n} running",
  noSessionName: "(no session name)",
  collapseSidebar: "Collapse sidebar",
  expandSidebar: "Expand sidebar",
  openDrawer: "Show sessions list",
  newSession: "New session",
  newSessionAria: "Start a new session in the selected session's directory; pick a directory when none is selected",
  newSessionOk: "New session started",
  // --- web-hub-delete-session plan v2 §5.4: AgentCard's two-step delete button ---
  remove: "Delete",
  removeConfirm: "Click again to delete",
  removeAria: "Delete this session from the list (session file is kept)",
  removeManagedAria: "Stop and delete this web-started session (session file is kept)",
  removing: "removing\u2026",
  removeFailed: "Delete failed: {reason}",
  "removeErr.online": "the session is still online",
  "removeErr.unconfirmed": "could not confirm the process exited; kept",
  "removeErr.managedLan": "web-managed session; cannot be stopped from the LAN",
  "removeErr.rate": "too many requests, retry shortly",
  "removeErr.unsupported": "hub does not support this, reload the page",
  "removeErr.network": "network error",
  // Deep-link refresh flicker fix: pre-first-`agents`-snapshot loading state (AgentList).
  loadingTitle: "Connecting…",
  // --- web-hub-rename plan: AgentCard's inline rename (reuses the existing `command` op) ---
  renameAria: "Rename this session",
  renameInputAria: "New session name",
  renameSaveAria: "Save name",
  renameCancelAria: "Cancel rename",
  renameFailed: "Rename failed: {reason}",
} satisfies Record<string, string>;

export default agents;
