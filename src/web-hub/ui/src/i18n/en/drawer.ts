/**
 * `drawer` i18n namespace (fleet-drawer plan v2 §6 — F6). Copy owned by the fleet drawer:
 * chrome (close/back), the §6.3 visibility markers (orphan chip, omitted counts, "no longer
 * listed"), the §6.5/§6.6 transcript footer states (reconnecting badge, retry, terminal chip,
 * watching:false degradation), and the §3.6 terminal-denial vocabulary (`reason.*` — leaf keys
 * with an embedded dot, same convention as `common.status.*`: `useI18n`'s lookup only splits
 * the full key on its FIRST dot).
 *
 * Reused, NOT duplicated here: `fleet.panelTitle`/`fleet.running`/`fleet.totalCost`/
 * `fleet.showFinished`/`fleet.treeLabel` (summary bar + tree), `transcript.loadOlderMessages`/
 * `transcript.loadingHistory`/`transcript.historyError` (the reused transcript kernel),
 * `detail.latest`/`detail.newCount` (the mini jump-to-latest pill).
 */
const drawer = {
  close: "Close subagent drawer",
  backToTree: "Subagent list",
  runTranscriptAria: "Subagent transcript",
  parentMissing: "parent run not listed",
  omittedActive: "{n} more running not listed",
  omittedTerminal: "{n} more finished not listed",
  notListed: "no longer listed",
  reconnecting: "Reconnecting…",
  retry: "Retry",
  terminalStatus: "Finished · {status}",
  watchingOff: "Live update slots are full — showing the last reported activity instead",
  "reason.unknown_run": "This subagent is no longer in the current session's records.",
  "reason.not_persisted": "Not persisted (rememberAgents=false) — the conversation cannot be replayed after it ended.",
  "reason.file_missing": "It ended before its first reply — there is no conversation to show.",
  "reason.leaf_unknown": "The final conversation position could not be determined.",
  "reason.leaf_missing": "The session file does not match the records.",
  "reason.too_large": "The session file is too large to display on the web.",
  "reason.parse_error": "The session file is corrupted.",
  "reason.unsupported": "Subagent transcripts are not available on this connection.",
  "reason.busy": "Busy — please try again in a moment.",
  "reason.resync_storm": "Live updates are unstable right now — please try again in a moment.",
} satisfies Record<string, string>;

export default drawer;
