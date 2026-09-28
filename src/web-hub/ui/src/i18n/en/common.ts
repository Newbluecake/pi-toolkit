/**
 * `common` i18n namespace (vue-plan.md v2.1 §3.8, §5.2 — P3): strings shared across shell,
 * agents and detail — the run/agent status vocabulary (ui-design.md §3.2's `RunVisualState`,
 * one shared enum for agent cards / status pills / fleet rows / tool cards) plus a handful of
 * generic action words (`back`, `copy`, `readonly`, …) that would otherwise be duplicated
 * verbatim across the `shell`/`agents`/`detail` namespaces.
 */
const common = {
  back: "Back",
  backToAgents: "Back to Agents",
  copy: "Copy",
  copied: "Copied",
  selectedPressCopy: "Selected — press Copy",
  readonly: "Read-only",
  // #32 C5 (control-plan §7.4): agent-card badge for an open ask_user dialog.
  needsAnswer: "Needs answer",
  "status.running": "Working",
  "status.thinking": "Thinking",
  "status.tool": "Running tool",
  "status.idle": "Idle",
  "status.queued": "Queued",
  "status.done": "Done",
  "status.failed": "Failed",
  "status.timed_out": "Timed out",
  "status.waiting": "Waiting on dialog",
  "status.stale": "Stale · no recent heartbeat",
  "status.offline": "Offline · process exited",
  "status.aborted": "Aborted",
  "status.outdated": "Plugin newer than hub",
} satisfies Record<string, string>;

export default common;
