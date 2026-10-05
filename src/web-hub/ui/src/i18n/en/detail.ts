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
  follow: "Follow",
  latest: "Latest",
  newCount: "{n} new",
} satisfies Record<string, string>;

export default detail;
