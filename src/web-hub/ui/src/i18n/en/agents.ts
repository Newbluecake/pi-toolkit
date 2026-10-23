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
  costTitle: "This session {own} + subagents {sub}",
  emptyTitle: "No pi sessions connected",
  emptyBodyLead: "Start pi on this machine with",
  emptyBodyTail: "on; sessions appear here within a second.",
  runningCount: "{n} running",
  noSessionName: "(no session name)",
  collapseSidebar: "Collapse sidebar",
  expandSidebar: "Expand sidebar",
  densityCompact: "Compact list: directory, title and alias only (click for detailed)",
  densityDetailed: "Detailed list: cost, model and context (click for compact)",
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
  // --- title-auto plan: clearing the input and saving hands the title back to auto-generation
  renameAutoHint: "Leave empty = auto-generate title",
  titleAutoFailed: "Could not restore automatic title: {reason}",
  "xs.wake": "Cross-session: joined — messages from other sessions can wake this session",
  "xs.deliver": "Cross-session: joined — messages from other sessions are delivered but do not wake this session",
  "xs.replies":
    "Cross-session: joined — only replies to requests this session sent are accepted; other messages are rejected",
  xsUnread: "{n} unread cross-session message(s) (cleared automatically once the model handles them)",
  xsChannels: "Channels: {list}",
  channelFilterAria: "Channel filter",
  channelAll: "All",
  channelsOpenTitle: "Manage cross-session channels",
  channelsOpenLabel: "Channels",
  // alias-plan r4 §7.2 (ALU): the detail header's `@alias` button tooltip
  xsAliasManage: "Alias @{alias} — manage channels & alias",
  "xs.off": "Cross-session: joined — currently rejecting all messages",
} satisfies Record<string, string>;

export default agents;
