/**
 * `detail` i18n namespace (vue-plan.md v2.1 §3.8, §5.2, §5.3 — P3): the detail header, session
 * info, metrics, agent-level notices and the bottom dock.
 */
const detail = {
  selectAgentTitle: "Select an agent",
  selectAgentBody: "Pick a session on the left to see its conversation, tool calls and subagents.",
  notConnectedTitle: "This agent is not connected",
  notConnectedBody: "It may have exited, or the link is stale.",
  sessionDetailsAria: "Session details",
  kvCwd: "cwd",
  kvSession: "session",
  kvModel: "model",
  kvProcess: "process",
  copyCwd: "Copy cwd",
  copySession: "Copy session id",
  contextLabel: "Context",
  contextAria: "Context used",
  costLabel: "Cost",
  metricsToggleAria: "Toggle context and cost metrics",
  subCost: "sub {v}",
  waitingOnDialog: "Waiting on a dialog in the terminal:",
  waitingMore: "(+{n} more)",
  staleBanner: "Stale — no recent heartbeat. Data may be out of date.",
  offlineBanner: "Offline — the pi process exited. Showing the last known transcript.",
  versionMismatch: "UI built at {c1}, hub is {c2} — consider rebuilding with npm run build:web.",
  loadingHistory: "Loading history…",
  dockLong: "· reply from the terminal",
  latest: "Latest",
  newCount: "{n} new",
  todoTitle: "Tasks {done}/{total} · {active} active",
  todoToggleAria: "Toggle the task list",
  todoStatusPending: "Pending",
  todoStatusInProgress: "In progress",
  todoStatusCompleted: "Completed",
  todoBlockedBy: "blocked by {ids}",
  todoMore: "(+{n} more)",
  // web-hub-delete-session plan v2 §5.4: DashboardView's 「已删除」 empty state (appended at
  // the file's end — another package inserts before `todoTitle`, never here).
  removedTitle: "Session removed from the list",
  removedBody: "The session file is kept; resume it from a terminal with pi.",
} satisfies Record<string, string>;

export default detail;
