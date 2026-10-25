/**
 * `detail` i18n namespace (vue-plan.md v2.1 §3.8, §5.2, §5.3 — P3): the detail header, session
 * info, metrics, agent-level notices and the bottom dock.
 */
const detail = {
  selectAgentTitle: "Select a session",
  selectAgentBody: "Pick a session on the left to see its conversation, tool calls and subagents.",
  notConnectedTitle: "This session is not connected",
  notConnectedBody: "It may have exited, or the link is stale.",
  sessionDetailsAria: "Session details",
  // 2026-10 「红框部分支持收起，点击标题展开」: the detail-title disclosure toggle (aria-label —
  // combined expand/collapse wording, same grammar as todoToggleAria; state rides aria-expanded).
  headToggleAria: "Expand or collapse session info",
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
  worktreesLastSample: "Last sampled {time} (agent's clock)",
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
  // aria label gets a real translation.
  bashJobsTitle: "Bash",
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
  // todo-archive plan v2.1 §2 (package B, D4/D5): TodoPanel's fold tail rows. zh translates both
  // lines as prose (「已完成 {n} 项」/「已归档 {n} 项」, D4 拍板 — web walks i18n, unlike the TUI's
  // English-token fold line). Appended at the file's end — another package inserts before
  // `todoCompletedHidden`, never here.
  todoCompletedHidden: "✓ {n} done",
  todoArchived: "{n} archived",
  // Web /clear quick button (2026-10 user request): the detail header's 「清空」 — starts a new
  // session in the same pi process via builtin /new with confirm baked in (no dialog anywhere).
  // Appended at the file's end — another package inserts before `todoCompletedHidden`, never here.
  clearAria: "Clear",
  clearLabel: "Clear",
  clearBusyLabel: "Clearing…",
  clearTitle: "New session (/clear)",
  clearFailed: "Couldn't start a new session ({code})",
  // web-hub archive plan: the `· N archived` summary segment. 2026-10-25 (user request): the zh
  // locale now translates the drawer's Bash count segments (running/done/failed/archived) to match
  // the neighbouring 「已归档 {n}」 fold; status tokens (exit/grace) stay English in both.
  bashJobsArchived: "{n} archived",
  // scheduled-reports W1 (plan r3 §5.6): the detail header's 「定时」 button opening the lazy
  // SchedulePanel (hub cap sched.v1 + a sessionId on the card; absent ⇒ zero trace).
  scheduleOpenTitle: "Scheduled tasks",
  scheduleOpenLabel: "Schedules",
  // issue #41 (titlebar overflow): the 「⋯」 menu trigger + menu aria-label receiving the
  // folded low-frequency titlebar buttons on narrow bars.
  moreActions: "More actions",
} satisfies Record<string, string>;

export default detail;
