/**
 * `diff` i18n namespace (worktree-diff plan v3.1 §4.2/§4.3/§4.7, package D5): the worktree
 * file list + the diff dialog. Per the AGENTS.md UI-text split, compact inline markers (badge
 * labels come from `logic/wtdiff.js`'s `statusBadge` and need no i18n; `bin`/`conflict` chips,
 * `old ·`/`new ·` side heads) stay English-token-only in BOTH locales; every prose surface
 * (loading/error/empty states, banners, disabled-entry titles, aria labels) is translated.
 * The zh file `satisfies Messages<typeof en>` so parity is compile-checked; i18n-parity.test.ts
 * re-checks key + `{param}` sets at runtime.
 */
const diff = {
  // ---- panel row toggle (§4.1) ----
  toggleTitle: "Show changed files",
  // ---- file list (§4.2) ----
  listLoading: "Loading changed files…",
  listEmpty: "No changes to show.",
  listErrorTitle: "Could not load changed files",
  footnote: "Protected entries are never listed; submodule changes are not shown.",
  refresh: "Refresh",
  retry: "Retry",
  truncatedNote: "List truncated — more changes exist than shown.",
  untrackedSkippedNote: "Untracked files were skipped in this listing.",
  numstatPartialNote: "Line counts unavailable for some files.",
  attrPartialNote: "Filter status unknown for some files — those are not viewable.",
  chipBinary: "bin",
  chipConflict: "conflict",
  entryFiltered: "Managed by a Git filter driver (e.g. LFS) — not viewable",
  entryNewline: "Filename contains CR/LF — not requestable",
  entryLossy: "Filename contains undecodable bytes — not requestable",
  entryInvalid: "Filename contains special characters — not requestable",
  // ---- dialog shell (§4.3) ----
  dialogLabel: "File diff",
  close: "Close",
  copyPath: "Copy worktree path",
  viewLabel: "Diff view",
  viewSplit: "Split",
  viewUnified: "Unified",
  oldSide: "old · {base}",
  newSide: "new · worktree",
  plaintextWarning: "Plain-text connection — the diff you view may be seen by others on the network.",
  // ---- dialog body states (§4.3 six-state main area) ----
  bodyLoading: "Loading diff…",
  bodyBinary: "Binary file — diff not rendered.",
  bodyEmpty: "No content difference against HEAD.",
  bodyUnviewable: "This file no longer has changes, or is not viewable here.",
  errorTitle: "Could not load diff",
  // ---- banners (§4.3) ----
  bannerUntracked: "Untracked file — content is read from the worktree as-is.",
  bannerTruncated: "Diff truncated — the tail is not shown.",
  bannerIncomplete: "Patch ended mid-hunk — the tail is missing.",
  bannerLineCap: "Diff hit the render line cap — the tail is not shown.",
  bannerHunkCap: "Diff hit the hunk cap — the tail is not shown.",
  bannerMalformed: "Patch could not be parsed past this point.",
  bannerStale: "The worktree changed since this diff was loaded.",
  bannerRenameOnly: "Rename only ({pct}% similar) — no content changes.",
  bannerModeOnly: "Mode change only — no content changes.",
  // ---- rows (§3.4/§3.5/§3.7) ----
  srDel: "removed",
  srAdd: "added",
  noEol: "no newline at end of file",
  showMore: "Show more ({n} rows left)",
  metaNewFile: "new file",
  metaDeleted: "deleted",
  metaBinary: "binary",
  metaMode: "{a} → {b}",
  // ---- error mapping (§1.5, shared by list + dialog) ----
  errNotRepo: "The session cwd is not inside a git repository.",
  errNotWorktree: "Not a registered worktree of this repository.",
  errDenied: "Access to this worktree was denied.",
  errUnborn: "The repository has no commits yet (HEAD unborn).",
  errSymlink: "The untracked path contains a symbolic link.",
  errGitUnavailable: "git is unavailable on the hub host.",
  errGitTooOld: "git is too old for this feature.",
  errFilterConfig: "Unsafe git filter configuration — refusing to run.",
  errStaleCtx: "The workspace changed while loading — retry.",
  errSession: "The session changed — reload the panel.",
  errDeadline: "The request timed out.",
  errRate: "Too many requests — retry shortly.",
  errBusy: "The hub is busy — retry shortly.",
  errGeneric: "Request failed ({code})",
};

export default diff;
