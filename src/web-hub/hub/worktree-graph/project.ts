/**
 * worktree-graph plan v2 §2.5/§2.6 (P2): the pure projector from Gr/Gl raw results to a
 * `WtGraphPayload`. Pure function — no fs, no git, no pi imports; `routes.ts` is the only
 * caller, handing it the already-parsed Gr rows (`parseForEachRefZ`), the already-derived tips
 * (`tipsFromRefs`), the already-parsed Gl commits (`parseGraphLogZ`, when Gl ran at all) and the
 * worktree-HEAD candidate list built from `membership`'s `rows`/`selfIndex` (never re-reading
 * porcelain itself — "HEAD 取自 membership 的 porcelain 自身行", §2.2).
 *
 * Degrade/trim discipline (§2.5), in order:
 * - §2.5 states are independent: `more` (≥ n+1 valid Gl records), `logCapped` (Gl stdout hit its
 *   byte cap), `badRecords`/`parentsTruncated` (from `parseGraphLogZ`, passed straight through —
 *   `parentsTruncated` is the FULL count over every parsed record, never re-derived from the
 *   post-slice/post-trim visible set, so the parser's `pT ⇒ parentsTruncated ≥ visible pT count`
 *   relation holds no matter how much trimming happens later), `refsTruncated` (Gr hit its row/
 *   byte cap), `refsSkipped` (from `tipsFromRefs`, authoritative — never recomputed here),
 *   `refsOmitted` (this module's own ref-count reduction, see below), `wtHeadsCapped` (from
 *   `tipsFromRefs`, authoritative — the SAME candidate-oid list feeds both the tips pool and this
 *   module's `wtHeads` projection, in the SAME order, so the two counts can never disagree).
 * - refs[] is ALWAYS capped at `WTGRAPH_REFS_MAX` (400) regardless of byte budget (the parser
 *   itself rejects a longer array) by dropping the lowest-priority kind first: tags, then
 *   remotes, then branches (`orderByKeepPriority`); `refsOmitted` counts whatever this drops.
 * - wtHeads[] is ALWAYS capped at `WTGRAPH_WT_HEADS_MAX` (32), same reasoning.
 * - ONLY when the serialized body still exceeds `WTGRAPH_BODY_MAX_BYTES` (512 KiB) does the
 *   three-stage trim actually reduce anything further: stage ② binary-searches a SHORTER
 *   keep-priority-ordered refs prefix (tags dropped first) until the body fits or refs reaches
 *   zero; stage ③ (only if refs=0 still doesn't fit) binary-searches a shorter commits prefix
 *   (oldest/tail commits dropped first, since Gl is `--date-order` newest-first) and, if any
 *   commit was actually dropped, RE-FILTERS refs/wtHeads/head to the remaining commit oid set
 *   (§2.5: "每次删提交后重过滤 refs / wtHeads / head 到剩余提交集") — this is a byte-saving
 *   measure specific to the forced-trim path; in NORMAL (non-trimmed) operation a ref/wtHead/head
 *   may legitimately dangle outside the n-commit window (§3: "membership … is NOT judged here",
 *   UI renders those as no-chip/no-ring/no-highlight stragglers).
 */

import type { ForEachRefRow, GraphCommit, TipsFromRefsResult } from "../../../git/graph.js";
import {
  WTGRAPH_BODY_MAX_BYTES,
  WTGRAPH_N,
  WTGRAPH_PATH_MAX_BYTES,
  WTGRAPH_REFNAME_MAX_BYTES,
  WTGRAPH_REFS_MAX,
  WTGRAPH_WT_HEADS_MAX,
  type WtGraphDegrade,
  type WtGraphPayload,
  type WtGraphRef,
  type WtGraphWtHead,
} from "../../protocol/worktree-graph.js";

/** One candidate worktree-HEAD entry (§2.2's "本 worktree HEAD 与其它 worktree 的 detached
 * HEAD"): `routes.ts` builds this list from `membership`'s `rows`/`selfIndex` — the self row
 * ALWAYS included (attached or detached), every OTHER row only when `detached === true`. The
 * SAME `h` values (in the SAME order) must be handed to `tipsFromRefs`'s `extraHeads` parameter
 * so its `wtHeadsCapped` count and this module's own cap agree. */
export interface WtHeadCandidate {
  h: string;
  path: string;
  b?: string;
  self?: true;
}

export interface ProjectGraphGlResult {
  /** Up to 201 parsed records (`wtGraphArgs.log`'s `--max-count=201`) — the (n+1)-th record is
   * what lets `more` be PROVEN rather than guessed; this module slices to `WTGRAPH_N` itself. */
  commits: readonly GraphCommit[];
  badRecords: number;
  parentsTruncated: number;
  /** Gl stdout hit `WTGRAPH_LOG_MAX_BYTES` — the incomplete last record was already dropped by
   * `parseGraphLogZ`; this is purely a degrade flag now. */
  logCapped: boolean;
}

export interface ProjectGraphInput {
  /** Gr's parsed rows (`parseForEachRefZ`). */
  refRows: readonly ForEachRefRow[];
  /** Gr hit `WTGRAPH_REFS_SCAN_MAX` rows or its own stdout byte cap. */
  refsTruncated: boolean;
  /** `tipsFromRefs(refRows, wtHeadCandidates.map(c => c.h))` — computed by the caller so the
   * SAME result can also drive Gl's argv before this projector ever runs. */
  tips: TipsFromRefsResult;
  /** `undefined` iff `tips.tips.length === 0` (Gl never ran — the empty graph). */
  gl: ProjectGraphGlResult | undefined;
  shallow: boolean;
  /** SAME order as fed to `tipsFromRefs`'s `extraHeads` (self first, if present). */
  wtHeadCandidates: readonly WtHeadCandidate[];
  /** Test-only override of `WTGRAPH_BODY_MAX_BYTES` (default when absent). The real max-field
   * worst case (200 commits × 8 sha256 parents × 200 B subjects + 400 refs × 200 B names + 32
   * wtHeads × 4096 B paths) only barely exceeds the real 512 KiB cap — enough margin that
   * naturally forcing the §2.5 ③ COMMIT trim (as opposed to ②'s ref trim, which alone usually
   * suffices) from realistic data is impractical; `budget.test.ts`/`project.test.ts` inject a
   * smaller bound here to exercise that stage deterministically. `routes.ts` never sets this. */
  maxBodyBytes?: number;
}

function byteSize(payload: WtGraphPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/** Shared by the route's tip candidates and projection; unborn is never a HEAD. */
export function isValidHead(h: string, format?: "sha1" | "sha256"): boolean {
  const length = format === undefined ? undefined : format === "sha1" ? 40 : 64;
  return (
    /^[0-9a-f]+$/.test(h) &&
    (length === undefined ? h.length === 40 || h.length === 64 : h.length === length) &&
    /[1-9a-f]/.test(h)
  );
}

function validBranch(b: string | undefined): boolean {
  return b !== undefined && b !== "" && Buffer.byteLength(b, "utf8") <= WTGRAPH_REFNAME_MAX_BYTES;
}

function validPath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\0") && Buffer.byteLength(path, "utf8") <= WTGRAPH_PATH_MAX_BYTES;
}

function isOidOf(hexLen: number): (s: string) => boolean {
  const re = new RegExp(`^[0-9a-f]{${hexLen}}$`);
  return (s: string): boolean => re.test(s);
}

/** Build `refs[]` directly from Gr's rows (independent of `tipsFromRefs`'s Set-only output,
 * since a ref chip needs its name/kind/upstream/sym too) — a row contributes IFF it would also
 * have contributed to `tipsFromRefs`'s tip set (same oid/refname/format validity), so the two
 * never disagree on which rows are "valid". A symref (`sym:true`) is chip-only — never excluded
 * from `refsSkipped` (same "not an error" treatment `tipsFromRefs` gives it), it is simply
 * dropped silently from `refs[]` on failure. */
function buildRefs(rows: readonly ForEachRefRow[], isOid: (s: string) => boolean): WtGraphRef[] {
  const refs: WtGraphRef[] = [];
  for (const row of rows) {
    let oid: string | undefined;
    if (row.objectType === "commit") oid = row.objectName;
    else if (row.objectType === "tag" && row.derefType === "commit") oid = row.derefName;
    if (oid === undefined || !isOid(oid)) continue;
    if (Buffer.byteLength(row.refname, "utf8") > WTGRAPH_REFNAME_MAX_BYTES) continue;
    let kind: "branch" | "remote" | "tag";
    let name: string;
    if (row.refname.startsWith("refs/heads/")) {
      kind = "branch";
      name = row.refname.slice("refs/heads/".length);
    } else if (row.refname.startsWith("refs/remotes/")) {
      kind = "remote";
      name = row.refname.slice("refs/remotes/".length);
    } else if (row.refname.startsWith("refs/tags/")) {
      kind = "tag";
      name = row.refname.slice("refs/tags/".length);
    } else {
      continue; // defensive — Gr only ever scans these three prefixes
    }
    if (name === "" || Buffer.byteLength(name, "utf8") > WTGRAPH_REFNAME_MAX_BYTES) continue;
    const ref: WtGraphRef = { k: kind, n: name, h: oid };
    if (row.symref !== "") ref.sym = true;
    if (
      kind === "branch" &&
      row.upstream !== "" &&
      Buffer.byteLength(row.upstream, "utf8") <= WTGRAPH_REFNAME_MAX_BYTES
    ) {
      ref.up = row.upstream;
    }
    refs.push(ref);
  }
  return refs;
}

/** Keep-priority order (lowest priority — dropped FIRST — last): branches, then remotes, then
 * tags (§2.5 ②: "按 tags → remotes → heads 逆序删"). Stable within each kind. */
function orderByKeepPriority(refs: readonly WtGraphRef[]): WtGraphRef[] {
  const branch = refs.filter((r) => r.k === "branch");
  const remote = refs.filter((r) => r.k === "remote");
  const tag = refs.filter((r) => r.k === "tag");
  return [...branch, ...remote, ...tag];
}

function hasRealDegrade(d: WtGraphDegrade): boolean {
  return (
    d.logCapped === true ||
    d.refsTruncated === true ||
    d.wtHeadsCapped === true ||
    d.badRecords !== undefined ||
    d.parentsTruncated !== undefined ||
    d.refsSkipped !== undefined ||
    d.refsOmitted !== undefined ||
    d.trimmed !== undefined
  );
}

export function projectGraph(input: ProjectGraphInput): WtGraphPayload {
  const bodyCap = input.maxBodyBytes ?? WTGRAPH_BODY_MAX_BYTES;
  const format: "sha1" | "sha256" = input.tips.format ?? "sha1";
  const hexLen = format === "sha1" ? 40 : 64;
  const isOid = isOidOf(hexLen);

  // ---- commits ------------------------------------------------------------
  let empty = input.gl === undefined;
  const rawCommits = input.gl?.commits ?? [];
  const more = rawCommits.length > WTGRAPH_N;
  let commits: GraphCommit[] = rawCommits.slice(0, WTGRAPH_N) as GraphCommit[];

  // ---- wtHeads + head (same candidate list, same validity predicate) ------
  const nonZeroCandidates = input.wtHeadCandidates.filter((c) => isValidHead(c.h, format));
  const validWtHeadCandidates = nonZeroCandidates.filter((c) => validPath(c.path));
  const wtHeadsCapped =
    input.tips.wtHeadsCapped ||
    nonZeroCandidates.length > validWtHeadCandidates.length ||
    validWtHeadCandidates.length > WTGRAPH_WT_HEADS_MAX;
  let wtHeads: WtGraphWtHead[] = validWtHeadCandidates.slice(0, WTGRAPH_WT_HEADS_MAX).map((c) => {
    const w: WtGraphWtHead = { h: c.h, path: c.path };
    if (validBranch(c.b)) w.b = c.b!;
    if (c.self === true) w.self = true;
    return w;
  });
  const selfCandidate = nonZeroCandidates.find((c) => c.self === true);
  let head: { h: string; b?: string } | undefined;
  if (selfCandidate !== undefined) {
    head = validBranch(selfCandidate.b) ? { h: selfCandidate.h, b: selfCandidate.b! } : { h: selfCandidate.h };
  }

  // ---- refs (built once, then kept in keep-priority order for easy trims) --
  const orderedRefs = orderByKeepPriority(buildRefs(input.refRows, isOid));
  let refs: WtGraphRef[] = orderedRefs.slice(0, Math.min(orderedRefs.length, WTGRAPH_REFS_MAX));
  let refsOmitted = orderedRefs.length - refs.length;

  // ---- degrade (pre-budget) -------------------------------------------------
  const degrade: WtGraphDegrade = {};
  if (more) degrade.more = true;
  if (input.gl?.logCapped === true) degrade.logCapped = true;
  if ((input.gl?.badRecords ?? 0) > 0) degrade.badRecords = input.gl!.badRecords;
  if ((input.gl?.parentsTruncated ?? 0) > 0) degrade.parentsTruncated = input.gl!.parentsTruncated;
  if (input.refsTruncated) degrade.refsTruncated = true;
  if (input.tips.refsSkipped > 0) degrade.refsSkipped = input.tips.refsSkipped;
  if (refsOmitted > 0) degrade.refsOmitted = refsOmitted;
  if (wtHeadsCapped) degrade.wtHeadsCapped = true;
  // Defensive fallback (never reached by a well-behaved git: a non-empty tip set always yields
  // at least the tips themselves from `log`): if Gl ran yet produced zero commits with no other
  // degrade marker, fold it into `empty` rather than emit a payload the frozen parser's own
  // "zero commits needs empty OR a real degrade marker" rule would reject.
  if (!empty && commits.length === 0 && !hasRealDegrade(degrade)) empty = true;

  const build = (): WtGraphPayload => {
    const payload: WtGraphPayload = {
      v: 1,
      n: WTGRAPH_N,
      format,
      commits,
      refs,
      wtHeads,
      degrade: { ...degrade },
      complete: !hasRealDegrade(degrade),
    };
    if (input.shallow) payload.shallow = true;
    if (empty) payload.empty = true;
    if (head !== undefined) payload.head = head;
    return payload;
  };

  let payload = build();
  if (byteSize(payload) <= bodyCap) return payload;

  // §2.5 ② — shrink refs further (binary search the SAME keep-priority order). The candidate's
  // `degrade.refsOmitted` is updated INSIDE the loop (not just after) — otherwise `build()`
  // would size a payload that doesn't carry the very `refsOmitted` field the final one will,
  // making the search converge on a candidate that looked like it fit but didn't once that
  // field was added back.
  {
    const updateOmitted = (keep: number): void => {
      const omitted = orderedRefs.length - keep;
      if (omitted > 0) degrade.refsOmitted = omitted;
      else delete degrade.refsOmitted;
    };
    let lo = 0;
    let hi = refs.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      refs = orderedRefs.slice(0, mid);
      updateOmitted(mid);
      payload = build();
      if (byteSize(payload) <= bodyCap) lo = mid;
      else hi = mid - 1;
    }
    refs = orderedRefs.slice(0, lo);
    refsOmitted = orderedRefs.length - refs.length;
    updateOmitted(lo);
    payload = build();
    if (byteSize(payload) <= bodyCap) return payload;
  }

  // §2.5 ③ — refs is already empty here; shrink commits (tail/oldest first), then re-filter
  // refs/wtHeads/head to the remaining commit set.
  {
    const originalCount = commits.length;
    const originalRefs = refs;
    const originalWtHeads = wtHeads;
    const originalHead = head;
    const trimTo = (keep: number): void => {
      commits = rawCommits.slice(0, keep) as GraphCommit[];
      if (keep < originalCount) {
        degrade.trimmed = originalCount - keep;
        const remaining = new Set(commits.map((c) => c.h));
        refs = originalRefs.filter((r) => remaining.has(r.h));
        wtHeads = originalWtHeads.filter((w) => remaining.has(w.h));
        head = originalHead !== undefined && remaining.has(originalHead.h) ? originalHead : undefined;
      } else {
        delete degrade.trimmed;
        refs = originalRefs;
        wtHeads = originalWtHeads;
        head = originalHead;
      }
    };
    let lo = 0;
    let hi = originalCount;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      trimTo(mid);
      payload = build();
      if (byteSize(payload) <= bodyCap) lo = mid;
      else hi = mid - 1;
    }
    trimTo(lo);
    payload = build();
  }
  // Final post-trim check: the `trimmed` marker and filtered collections are part of the
  // serialized size. Drop optional worktree decorations once more if they are the last overflow.
  if (byteSize(payload) > bodyCap) {
    wtHeads = [];
    head = undefined;
    degrade.wtHeadsCapped = true;
    payload = build();
  }
  if (byteSize(payload) > bodyCap) throw new RangeError("worktree graph body cap cannot fit envelope");
  return payload;
}
