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
  // worktree-web plan §5 (W4): the git-worktree panel. Compact inline markers (summary counts,
  // row tokens, flag chips) stay English-token-only in BOTH locales per the AGENTS.md UI-text
  // rule — zh keeps them byte-identical; only prose tooltips/aria labels get real translations.
  worktreesBranchDetached: "detached",
  worktreesCount: "worktrees {total}",
  worktreesDirty: "{n} dirty",
  worktreesAgent: "{n} agent",
  worktreesStale: "stale {n}m",
  worktreesClean: "clean",
  worktreesCurrent: "current",
  worktreesLastSample: "last sample {time}",
  worktreesLastSampleHint: "Sample time uses the agent's clock.",
  worktreesToggleAria: "Toggle the worktree list",
  worktreesCopyPath: "Copy worktree path",
  worktreesUnprobedCap: "not probed: beyond the probe limit",
  worktreesUnprobedTimeout: "not probed: timed out",
  worktreesUnprobedError: "probe failed",
  worktreesDirtyCapped: "dirty count is a lower bound (status output was capped)",
  worktreesUntrackedSkipped: "untracked files not counted",
  worktreesAbHint: "ahead/behind the local remote-tracking ref (the web UI never fetches)",
  worktreesMore: "(+{n} more)",
  worktreesFlagMain: "main",
  worktreesFlagAgent: "agent",
  worktreesFlagLocked: "locked",
  worktreesFlagPrunable: "prunable",
  worktreesFlagBare: "bare",
  // bash-jobs-panel plan §3 包 B (D4): the background bash-jobs panel. Compact inline markers
  // (summary segments, status/exit/grace/bytes/freshness tokens) stay English-token-only in
  // BOTH locales per the AGENTS.md UI-text rule — zh keeps them byte-identical; only the
  // aria label and the sensitive-info hint get real translations.
  bashJobsTitle: "bash",
  bashJobsSummary: "Background bash jobs: {running} running, {done} done, {failed} failed",
  bashJobsRunning: "{n} running",
  bashJobsDone: "{n} done",
  bashJobsFailed: "{n} failed",
  bashJobsExit: "exit {n}",
  bashJobsGrace: "grace",
  bashJobsNoOutput: "no output yet",
  bashJobsSampling: "sampling…",
  bashJobsTailAge: "tail {n}s old",
  bashJobsUnavailable: "unavailable",
  bashJobsMore: "(+{n} more)",
  bashJobsSensitiveHint:
    "Commands and output may contain sensitive information; redaction is best-effort only, not a security boundary.",
  todoTitle: "Tasks {total} · {done} done · {active} active",
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
  // Deep-link refresh flicker fix: pre-first-`agents`-snapshot loading state (DashboardView).
  loadingTitle: "Connecting…",
  loadingBody: "Waiting for the hub's first snapshot.",
} satisfies Record<string, string>;

export default detail;
