/**
 * `graph` i18n namespace (worktree-graph plan v2 §4.3, package P5): the commit-graph section
 * inside the worktree panel. Per the AGENTS.md UI-text split, compact inline markers (`graph ·
 * 200`, `+3`, `HEAD`, hash) stay English-token-only in BOTH locales; every prose surface
 * (states, degrade footnotes, sr-only topology descriptions, aria labels) is translated.
 * The zh file `satisfies Messages<typeof en>` so parity is compile-checked;
 * i18n-parity.test.ts re-checks key + `{param}` sets at runtime.
 */
const graph = {
  // ---- section header (§4.3) ----
  toggleAria: "Toggle the commit graph",
  /** `graph · {n}` — the header count row (compact marker, English-only per the UI rule). */
  headLabel: "graph · {n}",
  /** §4.3's standing footnote: `{n} commits · date-order · local refs, no fetch`. */
  footNote: "{n} commits · date-order · local refs, no fetch",
  footMore: "only the newest {n} commits are shown",
  // ---- states (§4.3 five states) ----
  loading: "Loading commit graph…",
  empty: "No commits yet.",
  degradedTitle: "Graph loaded with degraded data",
  errorTitle: "Could not load the commit graph",
  retry: "Retry",
  // ---- per-reason error copy (§4.3 error state, `reason` vocabulary from P0) ----
  errLogTimeout:
    "git log --date-order timed out — large repositories without a commit-graph file can be slow. Run `git commit-graph write` in the repository, then retry.",
  errMissingObject: "Some commits are missing (partial clone?). The graph cannot be shown for them.",
  errGitTooOld: "The repository's git version is too old for this feature.",
  errGitFailed: "git failed while reading the repository.",
  errNotWorktree: "Not a registered worktree of this repository.",
  errSessionChanged: "The session changed — reopen the graph to reload.",
  errBusy: "The hub is busy — try again shortly.",
  /** Fallback: interpolates the raw error code for diagnosis. */
  errGeneric: "Error: {code}",
  // ---- degrade footnote items (§2.5 vocabulary, each its own line) ----
  degLogCapped: "Log output hit the byte cap — the tail may be missing.",
  degBadRecords: "{n} malformed records were skipped.",
  degParentsTruncated: "{n} commits have more than 8 parents (parent list truncated).",
  degRefsTruncated: "The ref snapshot is partial (more than {n} refs).",
  degRefsSkipped: "{n} refs were skipped (not commits).",
  degRefsOmitted: "{n} refs were dropped to fit the response budget.",
  degTrimmed: "{n} commits were dropped to fit the response budget.",
  degWtHeadsCapped: "More than 32 worktree HEADs — some are not shown.",
  degShallow: "Shallow clone — history stops at the clone boundary.",
  // ---- sr-only topology descriptions (§4.3 读屏, one per row) ----
  srMerge: "merge commit, parents {parents}",
  srCurrent: "current checkout",
  srRing: "worktree HEAD: {label}",
  srFold: "on a folded lane",
  srOutOfSet: "parent commit outside the shown list",
  // ---- hash copy (§4.3) ----
  copyHash: "Copy commit hash {hash}",
  copiedHash: "Commit hash copied.",
  selectedHash: "Selected — press Copy.",
  // ---- table caption (§4.3) ----
  caption: "Commit graph of the current worktree, newest first",
};
export default graph;
