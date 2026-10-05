/**
 * `agents` i18n namespace (vue-plan.md v2.1 §3.8, §5.1, §5.2 — P3): the sidebar/list —
 * heading, filter, group label, empty state and per-card bits not already covered by
 * `common`'s shared `status.*` vocabulary.
 */
const agents = {
  title: "Agents",
  filterPlaceholder: "Filter by path or session…",
  filterAria: "Filter agents",
  staleOffline: "Stale & Offline",
  stopped: "Stopped",
  emptyTitle: "No pi sessions connected",
  emptyBodyLead: "Start pi on this machine with",
  emptyBodyTail: "on; sessions appear here within a second.",
  runningCount: "{n} running",
  noSessionName: "(no session name)",
  collapseSidebar: "Collapse sidebar",
  expandSidebar: "Expand sidebar",
  openDrawer: "Show agents list",
  newSession: "New session",
  newSessionAria: "Start a new session for the selected agent (runs /new)",
  newSessionOk: "New session started",
} satisfies Record<string, string>;

export default agents;
