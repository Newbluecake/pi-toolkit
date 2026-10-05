/**
 * `transcript` i18n namespace (vue-plan.md v2.1 §3.2/§3.8/§5.2 — P4). Flat dict — leaf keys that
 * read naturally with an embedded `.` (`"tool.input"` etc.) are legitimate string keys here,
 * `useI18n.ts`'s `lookup()` only splits the FULL key on its *first* `.` (namespace vs. leaf), so
 * `t("transcript.tool.input")` resolves to this dict's `"tool.input"` entry unchanged.
 */
const transcript = {
  ariaLabel: "Conversation",
  who: "pi",
  whoNotice: "notice",
  whoSubagent: "subagent",
  streaming: "Streaming…",
  thinking: "Thinking · {n} lines",
  imagePlaceholder: "[image]",
  truncated: "truncated",
  truncatedTitle: "payload truncated",
  compacted: "Context compacted",
  branchSummary: "Branch summary",
  modelChange: "Model → {model}",
  modelChangeUnknown: "unknown model",
  loadOlderMessages: "Load Older Messages",
  loadingOlder: "Loading older messages…",
  loadingHistory: "Loading history…",
  historyError: "History unavailable: {error}",
  hiddenBefore: "{n} earlier messages hidden · Show",
  hiddenAfter: "{n} newer hidden · Jump to latest",
  plainText: "text",
  copyCode: "Copy code",
  copyCopied: "Copied!",
  copySelected: "Selected — press Copy",
  "tool.input": "Input",
  "tool.liveOutput": "Live output",
  "tool.output": "Output",
  "tool.result": "Result",
  "tool.error": "error",
  "tool.lines": "{n} lines",
  "tool.showFull": "Show full output",
} satisfies Record<string, string>;

export default transcript;
