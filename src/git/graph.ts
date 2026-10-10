/**
 * Pure argv builders and parsers for the web-hub "worktree graph" feature
 * (worktree-graph plan v2, §2.2/§2.3/§2.6 — P1 git layer).
 *
 * Closure requirement (tests/web-hub/boundary.test.ts, same discipline as ./diff.ts): this
 * module is hub-reachable and must import NOTHING besides `./diff.js` (for `WT_PINNED_PREFIX`).
 * Everything here is a pure function over strings/arrays — no fs, no child_process, no pi
 * imports, and no import of the web-hub protocol module (its constants are mirrored below,
 * not imported, the same way WTDIFF_DRIVER_SCAN_MAX mirrors a protocol constant in diff.ts).
 * `src/web-hub/protocol/worktree-graph.ts` is a SEPARATE, concurrently-developed package (P0);
 * this file defines its own minimal local types/constants instead of depending on it — P2 is
 * the package that wires the two together.
 *
 * Two frozen, pinned commands (plan §2.2):
 * - Gr — one bounded `for-each-ref` snapshot. Record separator is `\n` (one ref per line);
 *   field separator is a literal NUL from the `%00` escape in the `--format` string (git's own
 *   escape, not a JS escape) — this is NOT `-z` mode. Fields: objecttype, objectname,
 *   *objecttype, *objectname, refname, upstream:short, symref (`parseForEachRefZ`).
 * - Gl — one `log --date-order` call whose explicit revision arguments are EXACTLY the commit
 *   tips derived from that one Gr snapshot (`tipsFromRefs`) plus the caller's worktree HEADs —
 *   Gl never resolves `--branches`/`--all`/`HEAD` itself (plan I4). Record separator is NUL
 *   (`-z`); field separator is `\x1f` from the `%x1f` escape (git's own escape). Fields: H, P,
 *   an, at, s (`parseGraphLogZ`).
 *
 * Byte-format notes (git 2.53, verified against real output):
 * - `for-each-ref --format=…%00…`: one line per ref, NUL between fields, `*objecttype`/
 *   `*objectname` are the FULLY DEREFERENCED target (git recurses through nested tags down to
 *   the first non-tag object on its own — no tag-chasing logic needed here).
 * - `log -z --format=%H%x1f%P%x1f%an%x1f%at%x1f%s`: NUL between records, `\x1f` between the
 *   first four fields, the subject is the verbatim remainder (may itself contain `\x1f`, though
 *   git's `%s` already collapses the message to one line).
 * - A root commit's `%P` field is empty (zero parents); a shallow boundary commit's `%P` is
 *   also empty even though it logically has history beyond the shallow horizon.
 */

import { WT_PINNED_PREFIX } from "./diff.js";

// ---------------------------------------------------------------------------
// Mirrored protocol constants (§3 draft; src/web-hub/protocol/worktree-graph.ts is P0's
// concurrently-developed file — NOT imported, see header). P2 reconciles the two.
// ---------------------------------------------------------------------------

/** Mirrors protocol `WTGRAPH_PARENTS_MAX`. */
export const WTGRAPH_PARENTS_MAX = 8;
/** Mirrors protocol `WTGRAPH_SUBJECT_MAX_BYTES`. */
export const WTGRAPH_SUBJECT_MAX_BYTES = 200;
/** Mirrors protocol `WTGRAPH_AUTHOR_MAX_BYTES`. */
export const WTGRAPH_AUTHOR_MAX_BYTES = 64;
/** Mirrors protocol `WTGRAPH_REFNAME_MAX_BYTES`. */
export const WTGRAPH_REFNAME_MAX_BYTES = 200;
/** Mirrors protocol `WTGRAPH_TIPS_MAX`. */
export const WTGRAPH_TIPS_MAX = 2048;
/** Mirrors protocol `WTGRAPH_WT_HEADS_MAX`. */
export const WTGRAPH_WT_HEADS_MAX = 32;

// ---------------------------------------------------------------------------
// Frozen argv (§2.2)
// ---------------------------------------------------------------------------

/**
 * `GB` (§2.2): the shared pinned prefix for both Gr and Gl. `--no-lazy-fetch` is the load-
 * bearing hardening (plan G2/§2.3 row 1): it is a GLOBAL option introduced in git 2.45.0 — an
 * older git rejects it with "unknown option" and exit 129 (`classifyGraphExit` → "git-too-old");
 * callers must NEVER retry without it (that would re-open the lazy-fetch execution surface).
 */
function graphBase(): string[] {
  return [
    ...WT_PINNED_PREFIX,
    "--no-lazy-fetch",
    "--no-replace-objects",
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
  ];
}

/** Gr's format string, frozen byte-for-byte (§2.2 table). */
const GR_FORMAT =
  "--format=%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(refname)%00%(upstream:short)%00%(symref)";

/** Gl's format string, frozen byte-for-byte (§2.2 table / §2.6). */
const GL_FORMAT = "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s";

/**
 * Frozen argv constructors (§2.2). Both are pinned (start with `WT_PINNED_PREFIX`); `log()`'s
 * only request-derived values are the tips themselves, which are git-reported hex object names
 * already validated by `tipsFromRefs` — never raw request input.
 */
export const wtGraphArgs: {
  /** Gr — one bounded ref snapshot (no request-derived values at all). */
  refs(): string[];
  /** Gl — commit list over EXACTLY the given tips; never resolves refs itself (plan I4). */
  log(tips: readonly string[]): string[];
} = {
  refs() {
    return [...graphBase(), "for-each-ref", "--count=2001", GR_FORMAT, "refs/heads", "refs/remotes", "refs/tags"];
  },
  log(tips) {
    return [
      ...graphBase(),
      "-c",
      "log.showSignature=false",
      "-c",
      "log.mailmap=false",
      "-c",
      "i18n.logOutputEncoding=UTF-8",
      "log",
      "--no-show-signature",
      "--no-use-mailmap",
      "--no-notes",
      "--no-decorate",
      "--no-color",
      "--date-order",
      "-z",
      "--max-count=201",
      GL_FORMAT,
      ...tips,
      "--",
    ];
  },
};

// ---------------------------------------------------------------------------
// Shared low-level helpers (local reimplementations — diff.ts's private splitters/token
// functions are not exported, and this module's closure may import nothing but diff.js).
// ---------------------------------------------------------------------------

/**
 * Split `stdout` on `sep`, dropping the trailing element: when `capped` that element is a
 * partial record cut off by the stdout byte cap; when not capped it is the harmless empty
 * string left by the final terminator (git always terminates the last record too).
 */
function terminatedRecords(stdout: string, sep: string, capped: boolean): string[] {
  const parts = stdout.split(sep);
  if (capped) return parts.slice(0, -1);
  if (parts.length > 0 && parts[parts.length - 1] === "") return parts.slice(0, -1);
  return parts;
}

/**
 * Split `token` on single-character `sep` into exactly `limit` fields where the LAST field is
 * the verbatim remainder (mirrors diff.ts's private `splitFields`, generalized to any
 * single-char separator since this module cannot import that one).
 */
function splitFields(token: string, sep: string, limit: number): string[] | undefined {
  const parts: string[] = [];
  let rest = token;
  while (parts.length < limit - 1) {
    const index = rest.indexOf(sep);
    if (index < 0) return undefined;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  parts.push(rest);
  return parts;
}

/**
 * Sanitize then byte-truncate free text (§2.2 "格式与隐私措辞"): every C0 control character
 * (and DEL) becomes U+FFFD, then the result is cut at `maxBytes` UTF-8 bytes without splitting
 * a multi-byte sequence. Exported for the dedicated unit tests the plan calls for.
 */
export function truncateText(s: string, maxBytes: number): string {
  const sanitized = s.replace(/[\x00-\x1f\x7f]/g, "\uFFFD");
  const buf = Buffer.from(sanitized, "utf8");
  if (buf.length <= maxBytes) return sanitized;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

const HEX_RE = /^[0-9a-f]+$/;
const ZERO_OID_RE = /^0+$/;

function isValidOid(oid: string): boolean {
  return (oid.length === 40 || oid.length === 64) && HEX_RE.test(oid);
}

// ---------------------------------------------------------------------------
// parseForEachRefZ (Gr's output)
// ---------------------------------------------------------------------------

export interface ForEachRefRow {
  /** `%(objecttype)` of the ref's direct target (e.g. "commit", "tag", "tree", "blob"). */
  objectType: string;
  /** `%(objectname)` — the ref's direct target oid. */
  objectName: string;
  /** `%(*objecttype)` — empty unless the direct target is a tag (fully dereferenced by git). */
  derefType: string;
  /** `%(*objectname)` — the fully-dereferenced target oid (empty unless `derefType` is set). */
  derefName: string;
  /** `%(refname)` — the full ref name, e.g. "refs/heads/main". */
  refname: string;
  /** `%(upstream:short)` — empty when no upstream is configured. */
  upstream: string;
  /** `%(symref)` — non-empty only for a symbolic ref (e.g. refs/remotes/origin/HEAD). */
  symref: string;
}

const GR_FIELD_COUNT = 7;

/**
 * Parse Gr's one-ref-per-line, NUL-field-separated output. Robust to a truncated trailing line
 * (dropped per `capped`) and to a malformed interior line (dropped silently — defensive only;
 * well-formed git output never produces one).
 */
export function parseForEachRefZ(stdout: string, capped: boolean): ForEachRefRow[] {
  const rows: ForEachRefRow[] = [];
  for (const line of terminatedRecords(stdout, "\n", capped)) {
    if (line === "") continue;
    const fields = line.split("\0");
    if (fields.length !== GR_FIELD_COUNT) continue;
    rows.push({
      objectType: fields[0]!,
      objectName: fields[1]!,
      derefType: fields[2]!,
      derefName: fields[3]!,
      refname: fields[4]!,
      upstream: fields[5]!,
      symref: fields[6]!,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// tipsFromRefs (§2.2 "tips（#3）")
// ---------------------------------------------------------------------------

export interface TipsFromRefsResult {
  /** Deduped, `WTGRAPH_TIPS_MAX`-capped commit oids — Gl's explicit revision arguments. */
  tips: string[];
  /** The object format inferred from the valid candidate oids' hex length; `undefined` if none. */
  format: "sha1" | "sha256" | undefined;
  /** Count of ref rows rejected for type / oid / refname-length reasons (§2.2 table). */
  refsSkipped: number;
  /** True when `extraHeads` (after dropping unborn/invalid entries) exceeded `WTGRAPH_WT_HEADS_MAX`. */
  wtHeadsCapped: boolean;
}

/**
 * Derive Gl's tips from ONE Gr snapshot plus the caller-supplied worktree HEAD oids (the "本
 * worktree HEAD 与其它 worktree 的 detached HEAD" of §2.2 — the caller reads those from the
 * membership porcelain it already ran; this module cannot import `./worktrees.js`). A row
 * becomes a tip iff `objectType === "commit"` (its own oid) or `objectType === "tag" &&
 * derefType === "commit"` (git has already fully dereferenced nested tags — no recursion is
 * needed here); every other row is rejected and counted in `refsSkipped`, EXCEPT a symref row
 * (`symref !== ""`, e.g. `origin/HEAD`) which is silently excluded without being counted (it is
 * chip-only — its target ref is expected to already be a tip in its own right). Rejected
 * reasons, all counted: wrong type, oversized refname (`> WTGRAPH_REFNAME_MAX_BYTES`), malformed
 * oid, or an oid whose length disagrees with the majority format across all candidates (mixed
 * object formats cannot occur in one real repo, but defensive parsing treats the minority as
 * invalid). `extraHeads` entries are dropped when empty/all-zero (unborn) or not a well-formed
 * oid, then capped at `WTGRAPH_WT_HEADS_MAX` (first-N, `wtHeadsCapped` sticky on overflow) before
 * joining the same format vote and the same final `WTGRAPH_TIPS_MAX` cap.
 */
export function tipsFromRefs(rows: readonly ForEachRefRow[], extraHeads: readonly string[]): TipsFromRefsResult {
  let refsSkipped = 0;
  const refCandidates: string[] = [];
  for (const row of rows) {
    if (row.symref !== "") continue; // chip-only, never a tip, not an error
    let oid: string | undefined;
    if (row.objectType === "commit") oid = row.objectName;
    else if (row.objectType === "tag" && row.derefType === "commit") oid = row.derefName;
    if (oid === undefined) {
      refsSkipped++;
      continue;
    }
    if (Buffer.byteLength(row.refname, "utf8") > WTGRAPH_REFNAME_MAX_BYTES) {
      refsSkipped++;
      continue;
    }
    if (!isValidOid(oid)) {
      refsSkipped++;
      continue;
    }
    refCandidates.push(oid);
  }

  const nonZeroHeads = extraHeads.filter((h) => h.length > 0 && !ZERO_OID_RE.test(h) && isValidOid(h));
  const wtHeadsCapped = nonZeroHeads.length > WTGRAPH_WT_HEADS_MAX;
  const usedHeads = wtHeadsCapped ? nonZeroHeads.slice(0, WTGRAPH_WT_HEADS_MAX) : nonZeroHeads;

  const count40 = refCandidates.filter((o) => o.length === 40).length + usedHeads.filter((o) => o.length === 40).length;
  const count64 = refCandidates.filter((o) => o.length === 64).length + usedHeads.filter((o) => o.length === 64).length;
  const majorityLen: 40 | 64 | undefined = count40 === 0 && count64 === 0 ? undefined : count64 > count40 ? 64 : 40;
  const format: "sha1" | "sha256" | undefined =
    majorityLen === undefined ? undefined : majorityLen === 64 ? "sha256" : "sha1";

  const tipsSet = new Set<string>();
  if (majorityLen !== undefined) {
    for (const oid of refCandidates) {
      if (oid.length === majorityLen) tipsSet.add(oid);
      else refsSkipped++;
    }
    for (const oid of usedHeads) {
      if (oid.length === majorityLen) tipsSet.add(oid);
      // A format-mismatched head is dropped silently: it is not a "ref" and cannot occur in a
      // real repo (one object format per repo) — defensive only, not counted.
    }
  }

  const tips = [...tipsSet].slice(0, WTGRAPH_TIPS_MAX);
  return { tips, format, refsSkipped, wtHeadsCapped };
}

// ---------------------------------------------------------------------------
// parseGraphLogZ (Gl's output)
// ---------------------------------------------------------------------------

export interface GraphCommit {
  h: string;
  p: string[];
  /** Present (true) iff the real parent list was longer than `WTGRAPH_PARENTS_MAX` and was cut. */
  pT?: true;
  a: string;
  t: number;
  s: string;
}

export interface ParseGraphLogZResult {
  commits: GraphCommit[];
  /** Records dropped for a malformed hash/parent/timestamp field (truncated cut excluded). */
  badRecords: number;
  /** Number of returned commits whose parent list was truncated (`pT`). */
  parentsTruncated: number;
}

const TIMESTAMP_RE = /^\d+$/;

/**
 * Parse Gl's NUL-record, `\x1f`-field output. `format` fixes the expected hex length for `%H`
 * and every `%P` entry (the request's single object format, from `tipsFromRefs`); a record
 * whose hash/parent/timestamp fields don't conform is dropped and counted in `badRecords` —
 * this is the ONLY rejection path (there is no partial-record recovery within a record, only
 * the capped-truncated LAST record is dropped without counting, same convention as `./diff.ts`).
 * A parent list longer than `WTGRAPH_PARENTS_MAX` is cut to that length and the commit is kept
 * with `pT: true`. The subject and author fields are sanitized/truncated via `truncateText`.
 */
export function parseGraphLogZ(stdout: string, capped: boolean, format: "sha1" | "sha256"): ParseGraphLogZResult {
  const hexLen = format === "sha1" ? 40 : 64;
  const hexRe = new RegExp(`^[0-9a-f]{${hexLen}}$`);
  const commits: GraphCommit[] = [];
  let badRecords = 0;
  let parentsTruncated = 0;
  for (const record of terminatedRecords(stdout, "\0", capped)) {
    if (record === "") continue;
    const fields = splitFields(record, "\x1f", 5);
    if (fields === undefined) {
      badRecords++;
      continue;
    }
    const [h, pRaw, anRaw, atRaw, sRaw] = fields as [string, string, string, string, string];
    if (!hexRe.test(h)) {
      badRecords++;
      continue;
    }
    const parentsRaw = pRaw === "" ? [] : pRaw.split(" ");
    if (!parentsRaw.every((p) => hexRe.test(p))) {
      badRecords++;
      continue;
    }
    if (!TIMESTAMP_RE.test(atRaw)) {
      badRecords++;
      continue;
    }
    const t = Number(atRaw);
    if (!Number.isSafeInteger(t)) {
      badRecords++;
      continue;
    }
    const truncated = parentsRaw.length > WTGRAPH_PARENTS_MAX;
    const p = truncated ? parentsRaw.slice(0, WTGRAPH_PARENTS_MAX) : parentsRaw;
    if (truncated) parentsTruncated++;
    commits.push({
      h,
      p,
      ...(truncated ? { pT: true as const } : {}),
      a: truncateText(anRaw, WTGRAPH_AUTHOR_MAX_BYTES),
      t,
      s: truncateText(sRaw, WTGRAPH_SUBJECT_MAX_BYTES),
    });
  }
  return { commits, badRecords, parentsTruncated };
}

// ---------------------------------------------------------------------------
// classifyGraphExit (§2.3 "结果分类顺序")
// ---------------------------------------------------------------------------

export type GraphExitReason = "missing-object" | "git-too-old" | "git-failed";

/**
 * Stderr substrings observed (git 2.53, this plan's own fixtures) for a hardened Gr/Gl call
 * failing because a referenced object is absent: `for-each-ref` on a loose (unpacked) tag whose
 * target was deleted says "fatal: bad tag"; the same ref once PACKED (packed-refs peeling takes
 * a different internal path) says "fatal: missing object <oid> for refs/tags/<name>" instead;
 * `log` walking past a deleted parent says "Could not read <oid>" (and, depending on walk
 * strategy, "fatal: Failed to traverse parents of commit" or "fatal: revision walk setup
 * failed"). Matched loosely by design — §2.9-style discipline is to classify, never to record
 * the full stderr text.
 */
const MISSING_OBJECT_RE =
  /bad tag|bad object|Could not read|unable to read [0-9a-f]+|missing (blob|tree|commit|object)\b/i;

/**
 * Classify a COMPLETED Gr/Gl run's exit code (plan §2.3's "结果分类顺序"): the caller MUST rule
 * out `capped` / `killed` (overflow, timeout, abort) and `spawnError` BEFORE calling this — those
 * degrade to `logCapped`/`refsTruncated` or an abort/deadline outcome and never reach exit-code
 * classification at all. `code` is therefore expected to be a real process exit code; a capped
 * run that reaches the hub as `code:-1` (worktree-diff's `classify` convention) still classifies
 * here as `"git-failed"` (fails closed — never a silent success) if the capped-first gate is
 * ever skipped by mistake. Returns `null` for `code === 0` (not an error).
 */
export function classifyGraphExit(code: number, stderr: string): GraphExitReason | null {
  if (code === 0) return null;
  // A negative code is never a real process exit status (e.g. the hub's capped sentinel
  // `code:-1`, worktree-diff's `classify` convention) — classify it BEFORE ever looking at
  // stderr, so a coincidental missing-object-shaped stderr string can never upgrade a
  // should-have-been-gated capped/killed outcome into a misleading "missing-object" result.
  if (code < 0) return "git-failed";
  if (code === 129) return "git-too-old";
  if (MISSING_OBJECT_RE.test(stderr)) return "missing-object";
  return "git-failed";
}
