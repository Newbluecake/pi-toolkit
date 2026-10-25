/**
 * web-hub worktree commit-graph protocol (worktree-graph plan v2 §3 — frozen interface, P0).
 *
 * Pure TypeScript, `node:*`-free: the browser UI (P4's transports / P5's graph components)
 * imports the constants, types and the defensive parser here, exactly like
 * `protocol/worktree-diff.ts`. Everything on the wire for `GET /api/worktree-graph`
 * (`X-PWH: 1`; query `agentKey`, `sessionId`, `wt`) — caps, budget constants, the payload
 * envelope, the degrade vocabulary and `parseWtGraphPayload` — is frozen in this one module
 * so the hub (P2) and the UI never drift. NOT here: membership/three-fd pinning, the Gr/Gl
 * argv and their parsers (P1's `src/git/graph.ts`), routes/assembly/audit (P2), layout
 * (P3/UI). Error bodies reuse the existing codes (`E_WTDIFF_DENIED`/`E_WTDIFF_UNSUPPORTED`/
 * `E_DEADLINE`/`E_BUSY`/`E_INTERNAL`…) — only the `reason` vocabulary (`WtGraphErrorReason`)
 * is new here; no new frames, no SSE event, no PROTO bump.
 *
 * The parser is deliberately STRICTER than wtdiff's: every object level is a KEY WHITELIST
 * (an unknown key anywhere ⇒ `null`, never ignored) because the payload has a single producer
 * (the hub's projector) versioned by `v` — a stray key is a hub bug, not a future extension.
 * Cross-field rules settled with the plan author (consult 2026-10-10):
 * - `n` is pinned to `WTGRAPH_N` (§0 G3: v1 ships a fixed 200, no pagination) — a v1 parser
 *   rejects any other value outright; `commits.length` is independently capped at
 *   `WTGRAPH_N` too (never merely at the wire's own, caller-controlled `n`).
 * - the hub runs Gl with `--max-count=n+1` only to PROVE `more`, then slices to `n` before
 *   projecting; the (n+1)-th record never rides the wire.
 * - `degrade.more` is set iff ≥ n+1 valid records were parsed. It is NOT judged jointly with
 *   `logCapped` here, but the two are NOT equally trustworthy (§2.5): when `logCapped` is also
 *   set, Gl's stdout was cut and its incomplete last record dropped, so "is there more beyond
 *   n?" is actually UNKNOWN — a `more` riding alongside `logCapped` is only a best-effort hint,
 *   never proof, and callers (P3/UI) must render it that way.
 * - `empty` is one-directional: `empty:true ⇒ commits = []`, but `commits: []` without
 *   `empty` is the legal「zero commits, degraded」state (all records bad / ③ trimmed
 *   everything / Gl returned nothing) and requires ≥ 1 real degrade marker.
 * - `pT:true` (a visibly-truncated commit survived the §2.5 ③ trim) requires
 *   `degrade.parentsTruncated` to be present and `≥` the number of such commits in the
 *   payload — NOT exactly equal (the body-budget trim can drop a `pT` commit from the tail
 *   while the hub's own counter, taken before that trim, still counts it).
 * - membership of `refs[].h` / `wtHeads[].h` / `head.h` in the commit set is NOT judged here
 *   (a ref/HEAD can legitimately point beyond the n-window; P2's projection tests pin the
 *   hub-side filter, P3 renders stragglers as no-chip/no-ring/no-highlight).
 * - defensive hardening: the whole parse runs inside a try/catch (a throwing getter, a
 *   revoked Proxy or an `ownKeys` trap that throws must still yield `null`, never propagate);
 *   every object level must have `Object.prototype`/`null` as its OWN prototype, and every
 *   field is read only via `hasOwnProperty` (an inherited "protocol" field — living on a
 *   non-default prototype, or on a polluted `Object.prototype` — is treated as absent, never
 *   adopted); the key whitelist is checked against `Object.getOwnPropertyNames` (own
 *   properties, enumerable or not), not just `Object.keys`.
 */

/** The single graph endpoint (§3: `GET` + `X-PWH: 1`; query: `agentKey`, `sessionId`, `wt`). */
export const WTGRAPH_PATH = "/api/worktree-graph";

// ---------------------------------------------------------------------------
// caps (§3 — the values hub, UI and parser all import)
// ---------------------------------------------------------------------------

/** Fixed response N (G3): no pagination, no load-more; the `n` payload field carries it so a
 *  future version may vary it without a structural change (v1 hubs always send 200). */
export const WTGRAPH_N = 200;

/** Max parents kept per commit (§2.2: over ⇒ truncated to this many, `pT: true`). */
export const WTGRAPH_PARENTS_MAX = 8;

/** `s` subject byte cap (UTF-8; applied by the hub's parse, judged again here). */
export const WTGRAPH_SUBJECT_MAX_BYTES = 200;

/** `a` author-name byte cap (UTF-8). */
export const WTGRAPH_AUTHOR_MAX_BYTES = 64;

/** Ref-name byte cap — `refs[].n` / `refs[].up` / `head.b` / `wtHeads[].b` (§2.2: refs whose
 *  name exceeds it are skipped at tip-building time, `refsSkipped`). */
export const WTGRAPH_REFNAME_MAX_BYTES = 200;

/** `wtHeads[].path` byte cap (consult 2026-10-10; the only field on this cap). Same Linux
 *  PATH_MAX figure as wtdiff's `WTDIFF_PATH_MAX_BYTES`. The hub DROPS an over-cap worktree
 *  head under the existing `wtHeadsCapped` flag — never truncates it, since a truncated path
 *  could never equal the `StatusInfo` row path the UI matches labels against. The agent side
 *  truncates `StatusInfo` paths to 1024 B, so 1025–4096 B paths are wire-legal but match no
 *  row (the UI falls back to the basename label — accepted, no extra rule). */
export const WTGRAPH_PATH_MAX_BYTES = 4096;

/** Gr `for-each-ref --count=2001` scan cap (§2.2: rows > this ⇒ `refsTruncated` degrade). */
export const WTGRAPH_REFS_SCAN_MAX = 2000;

/** Max refs in the payload (§2.5 ②: over ⇒ dropped tags→remotes→heads, `refsOmitted`). */
export const WTGRAPH_REFS_MAX = 400;

/** Max explicit tips handed to Gl (§2.2: deduped snapshot tips + worktree HEADs). */
export const WTGRAPH_TIPS_MAX = 2048;

/** Max worktree HEADs in the payload (§2.2: over ⇒ `wtHeadsCapped`). */
export const WTGRAPH_WT_HEADS_MAX = 32;

/** Gr stdout cap (§2.2; over ⇒ `refsTruncated`). */
export const WTGRAPH_REFS_MAX_BYTES = 256 * 1024;

/** Gl stdout cap (§2.5; over ⇒ `logCapped`, the incomplete last record is dropped). */
export const WTGRAPH_LOG_MAX_BYTES = 512 * 1024;

/** Serialized `WtGraphPayload` body cap (§2.5's three-stage trim keeps the hub under it; the
 *  transport judges it — the frozen `parseWtGraphPayload` signature takes no byte length). */
export const WTGRAPH_BODY_MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// budgets (§2.4 总账 — the two arithmetic relations are pinned with real arithmetic in
// tests/web-hub/protocol/worktree-graph.test.ts, importing WTDIFF_* from worktree-diff.ts)
// ---------------------------------------------------------------------------

/** S5 (Gl) single-command cap. */
export const WTGRAPH_LOG_MS = 6_000;

/** Git phase G (S1–S5): `4 × WTDIFF_STEP_MS + WTGRAPH_LOG_MS = 14 s` — every step always
 *  gets its full cap, Gl is never squeezed by its predecessors. */
export const WTGRAPH_GIT_PHASE_MS = 14_000;

/** UI client timeout: `WTDIFF_ADMIT_MS + WTGRAPH_GIT_PHASE_MS + WTDIFF_CLOSE_MS` (23 s) +
 *  `WTDIFF_TRANSFER_RESERVE_MS` (10 s) = 33 s ≤ this. */
export const WTGRAPH_CLIENT_TIMEOUT_MS = 35_000;

// ---------------------------------------------------------------------------
// payload envelope (§3)
// ---------------------------------------------------------------------------

export interface WtGraphCommit {
  /** Full-length commit oid (lowercase hex, length 40 for `sha1` / 64 for `sha256`). */
  h: string;
  /** Parent oids, same format; ≤ `WTGRAPH_PARENTS_MAX` (over ⇒ hub truncated + `pT`). */
  p: string[];
  /** Parents were truncated to `WTGRAPH_PARENTS_MAX` (⇒ `p.length === WTGRAPH_PARENTS_MAX`). */
  pT?: true;
  /** Author name (≤ `WTGRAPH_AUTHOR_MAX_BYTES` UTF-8; may be empty). */
  a: string;
  /** Author time, unix seconds (non-negative safe integer). */
  t: number;
  /** Subject (≤ `WTGRAPH_SUBJECT_MAX_BYTES` UTF-8; may be empty). */
  s: string;
}

export interface WtGraphRef {
  k: "branch" | "remote" | "tag";
  /** Short ref name (`main`, `origin/main`, `v1.0` — never the `refs/…` full form). */
  n: string;
  /** Target commit oid (tags are peeled to their commit; same format as `WtGraphCommit.h`). */
  h: string;
  /** Upstream short name (`%(upstream:short)`), branches only. */
  up?: string;
  /** Symref (an `origin/HEAD`-style chip target, never a Gl tip). */
  sym?: true;
}

export interface WtGraphWtHead {
  /** The worktree's HEAD commit oid (never a zero/unborn oid — those are skipped). */
  h: string;
  /** Worktree absolute path — the same asset `StatusInfo.worktrees` already broadcasts. */
  path: string;
  /** Branch short name when the worktree is on a branch (absent when detached). */
  b?: string;
  /** This request's own worktree (the membership `selfIndex` row). */
  self?: true;
}

/** §2.5's degrade states — mutually independent, all surfaced by the UI. Every counter is
 *  omitted-when-zero (a literal `0` is off-contract); every flag is `true`-only.
 *  `complete === true` iff none of these is present EXCEPT `more` (it only means「仅显示
 *  前 n 条」, not degradation). */
export interface WtGraphDegrade {
  /** ≥ n+1 valid records were parsed — only the first n ride the payload. */
  more?: true;
  /** Gl stdout hit `WTGRAPH_LOG_MAX_BYTES`; the incomplete last record was dropped. */
  logCapped?: true;
  /** Records dropped by `parseGraphLogZ` (bad hex / non-integer t / wrong field count). */
  badRecords?: number;
  /** Commits whose parents were truncated to `WTGRAPH_PARENTS_MAX` (the `pT` ones). */
  parentsTruncated?: number;
  /** Gr scan hit `WTGRAPH_REFS_SCAN_MAX` rows / bytes — the snapshot is partial. */
  refsTruncated?: true;
  /** Refs skipped at tip-building (non-commit target, bad/mixed-length oid, name > 200 B). */
  refsSkipped?: number;
  /** Refs dropped by the §2.5 ② body-budget stage (tags → remotes → heads). */
  refsOmitted?: number;
  /** Commits dropped from the tail by the §2.5 ③ body-budget stage. */
  trimmed?: number;
  /** More than `WTGRAPH_WT_HEADS_MAX` worktree HEADs (or one broke the path cap). */
  wtHeadsCapped?: true;
}

export interface WtGraphPayload {
  v: 1;
  /** The N the hub used; v1 always `WTGRAPH_N`. The UI slices its rows to this. */
  n: number;
  format: "sha1" | "sha256";
  /** The repo is shallow (S1's stat; commit history stops at the shallow boundary). */
  shallow?: true;
  /** The tips set was empty, so Gl never ran — the empty graph, shown as「暂无提交」only
   *  when `complete` too (§4.3). One-directional: `commits: []` WITHOUT `empty` is the
   *  degraded zero-commits state. */
  empty?: true;
  /** Current worktree HEAD; absent = unborn. May point outside the n-window (no highlight). */
  head?: { h: string; b?: string };
  /** ≤ `n` commits, newest first (`--date-order`), each parent either later in the array or
   *  outside it (a layout stub). No duplicate oids. */
  commits: WtGraphCommit[];
  refs: WtGraphRef[];
  wtHeads: WtGraphWtHead[];
  degrade: WtGraphDegrade;
  /** `true` iff `degrade` carries nothing but `more` (parser-enforced both directions). */
  complete: boolean;
  /** Only returned for `merged=1` (merged-plan §6); absent preserves the legacy payload. */
  merged?: WtGraphMerged;
}

/** §2.2/§3 error `reason` values riding the REUSED error codes (`E_DEADLINE{reason:
 *  "log-timeout"}` 504, `E_WTDIFF_UNSUPPORTED{reason: "missing-object" | "git-too-old"}` 503,
 *  `E_INTERNAL{reason: "git-failed"}` 500 — the hub's classification, P2). */
export type WtGraphErrorReason = "log-timeout" | "missing-object" | "git-too-old" | "git-failed";

// ---------------------------------------------------------------------------
// parser (§3 — key whitelist + hex/length/caps + complete⇔degrade consistency)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

const OID_RE: Readonly<Record<"sha1" | "sha256", RegExp>> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

const TOP_KEYS = [
  "v",
  "n",
  "format",
  "shallow",
  "empty",
  "head",
  "commits",
  "refs",
  "wtHeads",
  "degrade",
  "complete",
  "merged",
] as const;
const HEAD_KEYS = ["h", "b"] as const;
const COMMIT_KEYS = ["h", "p", "pT", "a", "t", "s"] as const;
const REF_KEYS = ["k", "n", "h", "up", "sym"] as const;
const WT_HEAD_KEYS = ["h", "path", "b", "self"] as const;
const DEGRADE_KEYS = [
  "more",
  "logCapped",
  "badRecords",
  "parentsTruncated",
  "refsTruncated",
  "refsSkipped",
  "refsOmitted",
  "trimmed",
  "wtHeadsCapped",
] as const;
const DEGRADE_COUNTERS = ["badRecords", "parentsTruncated", "refsSkipped", "refsOmitted", "trimmed"] as const;
const DEGRADE_FLAGS = ["more", "logCapped", "refsTruncated", "wtHeadsCapped"] as const;

function byteLen(s: string): number {
  return textEncoder.encode(s).length;
}

/** Own-property test (never trusts the prototype chain — a value living only on a non-default
 *  prototype, or injected via `Object.prototype` pollution, is not this object's OWN data). */
function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** Reads a field iff it is an OWN property of `o`; an inherited value (including one living on
 *  a polluted `Object.prototype`) is treated as absent, never adopted as a protocol field. */
function getOwn(o: Record<string, unknown>, key: string): unknown {
  return hasOwn(o, key) ? o[key] : undefined;
}

/** `Object.getOwnPropertyNames` (own, enumerable OR NOT) rather than `Object.keys` (enumerable
 *  only) — a non-enumerable own key must still be caught by the whitelist. */
function hasOnlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.getOwnPropertyNames(o)) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

function isOid(v: unknown, format: "sha1" | "sha256"): v is string {
  return typeof v === "string" && OID_RE[format].test(v);
}

function isPosSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Ref-name-ish string (`refs[].n`/`up`, `head.b`, `wtHeads[].b`): non-empty, ≤ 200 UTF-8 B. */
function isRefName(v: unknown): v is string {
  return typeof v === "string" && v !== "" && byteLen(v) <= WTGRAPH_REFNAME_MAX_BYTES;
}

/** A plain data object: not null/array, and its OWN prototype is `Object.prototype` or `null`
 *  (rejects class instances, `Object.create(exoticProto)` tricks, and most hostile Proxies —
 *  a Proxy whose `getPrototypeOf` trap lies is an inherent, unfixable limit of duck typing). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Strict validation of a `WtGraphPayload` (§3). Key whitelists at EVERY object level (unknown
 * key ⇒ `null`, checked against own properties whether enumerable or not), full-length
 * lowercase-hex oids matching `format` everywhere (`h`, `p[]`, `refs[].h`, `head.h`,
 * `wtHeads[].h`), UTF-8 byte caps, array caps, `n === WTGRAPH_N` (v1 is pinned, §0 G3), no
 * duplicate commit oids, and the consistency rules settled with the plan author:
 * - `complete ⇔ degrade` carries no real marker (`more` excluded on BOTH sides);
 * - `empty:true ⇒ commits = []`;
 * - `commits = []` without `empty` ⇒ at least one real degrade marker (the「zero commits,
 *   degraded」state — §4.3 shows「已降级」, never「暂无提交」);
 * - `pT:true ⇒ p.length === WTGRAPH_PARENTS_MAX`, AND every `pT` commit in the payload must be
 *   covered by `degrade.parentsTruncated ≥` (not `===`) that count — a visible `pT` can never
 *   be waved off as `complete`.
 * Every object level is also required to have `Object.prototype`/`null` as its own prototype
 * and every field is read via `hasOwnProperty` — an inherited "protocol" field never counts.
 * NOT judged (deliberately): `more`/`logCapped` co-occurrence (though they are not equally
 * trustworthy — see the module header), and whether `refs[].h` / `wtHeads[].h` / `head.h` fall
 * inside the commit set. Never throws — the whole parse runs inside a try/catch.
 */
export function parseWtGraphPayload(raw: unknown): WtGraphPayload | null {
  try {
    return parseWtGraphPayloadUnsafe(raw);
  } catch {
    // a throwing getter, a revoked Proxy, or an `ownKeys` trap that throws must never escape
    // this parser — any such exotic input is simply rejected.
    return null;
  }
}

function parseWtGraphPayloadUnsafe(raw: unknown): WtGraphPayload | null {
  if (!isPlainObject(raw)) return null;
  const o = raw;
  if (!hasOnlyKeys(o, TOP_KEYS)) return null;

  if (getOwn(o, "v") !== 1) return null;
  // v1 is pinned to exactly WTGRAPH_N (§0 G3: fixed 200, no pagination) — NOT an arbitrary
  // positive integer. `n` is still carried on the wire (future versions may vary it), but this
  // v1 parser must reject anything else outright.
  if (getOwn(o, "n") !== WTGRAPH_N) return null;
  const n: number = WTGRAPH_N;
  const format = getOwn(o, "format");
  if (format !== "sha1" && format !== "sha256") return null;
  const shallow = getOwn(o, "shallow");
  if (shallow !== undefined && shallow !== true) return null;
  const emptyRaw = getOwn(o, "empty");
  if (emptyRaw !== undefined && emptyRaw !== true) return null;
  const empty = emptyRaw === true;

  let head: { h: string; b?: string } | undefined;
  const rawHead = getOwn(o, "head");
  if (rawHead !== undefined) {
    if (!isPlainObject(rawHead)) return null;
    const h = rawHead;
    if (!hasOnlyKeys(h, HEAD_KEYS)) return null;
    const hh = getOwn(h, "h");
    if (!isOid(hh, format)) return null;
    const hb = getOwn(h, "b");
    if (hb !== undefined && !isRefName(hb)) return null;
    head = hb === undefined ? { h: hh } : { h: hh, b: hb };
  }

  const rawCommits = getOwn(o, "commits");
  // commits.length is capped at WTGRAPH_N independently of the wire's own `n` field (already
  // pinned to WTGRAPH_N above, but this must never be the ONLY thing standing between an
  // oversized array and the parser accepting it).
  if (!Array.isArray(rawCommits) || rawCommits.length > WTGRAPH_N) return null;
  const commits: WtGraphCommit[] = [];
  const seenCommits = new Set<string>();
  let visibleTruncatedParents = 0;
  for (const rawCommit of rawCommits) {
    if (!isPlainObject(rawCommit)) return null;
    const c = rawCommit;
    if (!hasOnlyKeys(c, COMMIT_KEYS)) return null;
    const ch = getOwn(c, "h");
    if (!isOid(ch, format)) return null;
    if (seenCommits.has(ch)) return null; // no duplicate commit oids (consult 2026-10-10)
    seenCommits.add(ch);
    const rawParents = getOwn(c, "p");
    if (!Array.isArray(rawParents) || rawParents.length > WTGRAPH_PARENTS_MAX) return null;
    const parents: string[] = [];
    for (const parent of rawParents) {
      if (!isOid(parent, format)) return null;
      parents.push(parent);
    }
    const cpT = getOwn(c, "pT");
    if (cpT !== undefined && cpT !== true) return null;
    if (cpT === true && parents.length !== WTGRAPH_PARENTS_MAX) return null;
    const ca = getOwn(c, "a");
    if (typeof ca !== "string" || byteLen(ca) > WTGRAPH_AUTHOR_MAX_BYTES) return null;
    const ct = getOwn(c, "t");
    if (!isNonNegSafeInt(ct)) return null;
    const cs = getOwn(c, "s");
    if (typeof cs !== "string" || byteLen(cs) > WTGRAPH_SUBJECT_MAX_BYTES) return null;
    const commit: WtGraphCommit = { h: ch, p: parents, a: ca, t: ct, s: cs };
    if (cpT === true) {
      commit.pT = true;
      visibleTruncatedParents++;
    }
    commits.push(commit);
  }

  const rawRefs = getOwn(o, "refs");
  if (!Array.isArray(rawRefs) || rawRefs.length > WTGRAPH_REFS_MAX) return null;
  const refs: WtGraphRef[] = [];
  for (const rawRef of rawRefs) {
    if (!isPlainObject(rawRef)) return null;
    const r = rawRef;
    if (!hasOnlyKeys(r, REF_KEYS)) return null;
    const rk = getOwn(r, "k");
    if (rk !== "branch" && rk !== "remote" && rk !== "tag") return null;
    const rn = getOwn(r, "n");
    if (!isRefName(rn)) return null;
    const rh = getOwn(r, "h");
    if (!isOid(rh, format)) return null;
    const rup = getOwn(r, "up");
    if (rup !== undefined && !isRefName(rup)) return null;
    const rsym = getOwn(r, "sym");
    if (rsym !== undefined && rsym !== true) return null;
    const ref: WtGraphRef = { k: rk, n: rn, h: rh };
    if (rup !== undefined) ref.up = rup;
    if (rsym === true) ref.sym = true;
    refs.push(ref);
  }

  const rawWtHeads = getOwn(o, "wtHeads");
  if (!Array.isArray(rawWtHeads) || rawWtHeads.length > WTGRAPH_WT_HEADS_MAX) return null;
  const wtHeads: WtGraphWtHead[] = [];
  for (const rawWt of rawWtHeads) {
    if (!isPlainObject(rawWt)) return null;
    const w = rawWt;
    if (!hasOnlyKeys(w, WT_HEAD_KEYS)) return null;
    const wh = getOwn(w, "h");
    if (!isOid(wh, format)) return null;
    const wpath = getOwn(w, "path");
    if (
      typeof wpath !== "string" ||
      wpath === "" ||
      wpath[0] !== "/" || // Linux absolute path only (§0.2 Q1 — the StatusInfo.worktrees asset)
      wpath.includes("\0") ||
      byteLen(wpath) > WTGRAPH_PATH_MAX_BYTES
    ) {
      return null;
    }
    const wb = getOwn(w, "b");
    if (wb !== undefined && !isRefName(wb)) return null;
    const wself = getOwn(w, "self");
    if (wself !== undefined && wself !== true) return null;
    const wtHead: WtGraphWtHead = { h: wh, path: wpath };
    if (wb !== undefined) wtHead.b = wb;
    if (wself === true) wtHead.self = true;
    wtHeads.push(wtHead);
  }

  const rawDegrade = getOwn(o, "degrade");
  if (!isPlainObject(rawDegrade)) return null;
  const d = rawDegrade;
  if (!hasOnlyKeys(d, DEGRADE_KEYS)) return null;
  const degrade: WtGraphDegrade = {};
  for (const flag of DEGRADE_FLAGS) {
    const v = getOwn(d, flag);
    if (v === undefined) continue;
    if (v !== true) return null;
    degrade[flag] = true;
  }
  for (const counter of DEGRADE_COUNTERS) {
    const v = getOwn(d, counter);
    if (v === undefined) continue;
    if (!isPosSafeInt(v)) return null; // omitted-when-zero: a literal 0 is off-contract
    degrade[counter] = v;
  }

  const complete = getOwn(o, "complete");
  if (typeof complete !== "boolean") return null;

  // complete ⇔ no real degrade marker (more excluded on both sides — it only means「仅显示前
  // n 条」, never degradation).
  const realDegrade =
    degrade.logCapped === true ||
    degrade.refsTruncated === true ||
    degrade.wtHeadsCapped === true ||
    degrade.badRecords !== undefined ||
    degrade.parentsTruncated !== undefined ||
    degrade.refsSkipped !== undefined ||
    degrade.refsOmitted !== undefined ||
    degrade.trimmed !== undefined;
  if (complete === realDegrade) return null;

  // a visible pT can't be disclaimed away as "complete": every pT commit in the payload must be
  // covered by a (≥, not ===) parentsTruncated counter — the body-budget trim can drop a pT
  // commit from the tail after the hub took its own count, so ≥ is the only safe relation.
  if (visibleTruncatedParents > 0 && (degrade.parentsTruncated ?? 0) < visibleTruncatedParents) return null;

  // empty is one-directional: empty ⇒ zero commits; zero commits without empty need a reason.
  if (empty && commits.length > 0) return null;
  if (commits.length === 0 && !empty && !realDegrade) return null;

  const payload: WtGraphPayload = { v: 1, n, format, commits, refs, wtHeads, degrade, complete };
  if (shallow === true) payload.shallow = true;
  if (empty) payload.empty = true;
  if (head !== undefined) payload.head = head;
  const rawMerged = getOwn(o, "merged");
  if (rawMerged !== undefined) {
    const merged = parseWtGraphMerged(rawMerged, payload, seenCommits);
    if (merged === null) return null;
    payload.merged = merged;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Optional merged extension (merged-plan r3 §3.4 / §6). Legacy budgets above stay frozen.
// ---------------------------------------------------------------------------

/** Sent only under `wtgraph.merged.v1`; the only supported query value is "1". */
export const WTGRAPH_MERGED_QUERY = "merged";
/** At most 24 selected branch entries and at most 24 distinct Gm executions. */
export const WTGRAPH_MERGED_MAX = 24;
/** Global e-element budget, not a per-branch allowance. */
export const WTGRAPH_MERGED_E_MAX = 200;
export const WTGRAPH_CHERRY_MS = 2_000;
export const WTGRAPH_CHERRY_MAX_BYTES = 64 * 1024;
/** Independent M phase after G; NOT added to legacy requests. */
export const WTGRAPH_MERGED_PHASE_MS = 14_000;
/** Reserved for final info/attributes read + shallow stat (2 s each). */
export const WTGRAPH_MERGED_TAIL_MS = 4_000;
/** Reserved from the existing 512 KiB complete-response cap, not added to it. */
export const WTGRAPH_MERGED_MAX_BYTES = 32 * 1024;
/** A + G + M + close = 37 s; + transfer = 47 s ≤ 48 s (only merged=1). */
export const WTGRAPH_MERGED_CLIENT_TIMEOUT_MS = 48_000;

export type WtGraphMergedKind = "eq" | "part" | "none" | "anc" | "unk";
export type WtGraphMergedUnknown = "budget" | "timeout" | "too-many" | "missing-object" | "git-failed" | "attr-changed";
export type WtGraphMergedSkip =
  "no-head" | "shallow" | "filter-config" | "git-too-old" | "attr-changed" | "unconfirmed" | "bytes";

export interface WtGraphMergedEntry {
  /** Short local branch name, matching a branch ref with the same h. */
  n: string;
  h: string;
  v: WtGraphMergedKind;
  /** eq/part/none only: patch-equivalent count and total branch-side commits. */
  k?: number;
  t?: number;
  /** part only: unique window commit oids, on the first entry for this tip only. */
  e?: string[];
  /** part only: e is a subset (possibly absent after byte trimming). */
  eP?: true;
  /** Checked out by any worktree, including attached worktrees. */
  co?: true;
  /** Required on unk, forbidden on all other kinds. */
  why?: WtGraphMergedUnknown;
}

export interface WtGraphMerged {
  v: 1;
  /** Present iff payload.head exists, and exactly equal to head.h. */
  base?: string;
  /** Whole-stage failure: no branch entries or omitted count. */
  skipped?: WtGraphMergedSkip;
  branches: WtGraphMergedEntry[];
  /** Omitted selected-candidate overflow (strictly positive, omitted when zero). */
  omitted?: number;
}

const MERGED_KEYS = ["v", "base", "skipped", "branches", "omitted"] as const;
const MERGED_ENTRY_KEYS = ["n", "h", "v", "k", "t", "e", "eP", "co", "why"] as const;
const MERGED_KINDS: readonly WtGraphMergedKind[] = ["eq", "part", "none", "anc", "unk"];
const MERGED_UNKNOWNS: readonly WtGraphMergedUnknown[] = [
  "budget",
  "timeout",
  "too-many",
  "missing-object",
  "git-failed",
  "attr-changed",
];
const MERGED_SKIPS: readonly WtGraphMergedSkip[] = [
  "no-head",
  "shallow",
  "filter-config",
  "git-too-old",
  "attr-changed",
  "unconfirmed",
  "bytes",
];

/** Called inside parseWtGraphPayload's existing defensive try/catch. Only the optional
 * extension is inspected; the legacy projection and its property insertion order never change. */
function parseWtGraphMerged(raw: unknown, payload: WtGraphPayload, commits: ReadonlySet<string>): WtGraphMerged | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, MERGED_KEYS)) return null;
  if (getOwn(raw, "v") !== 1) return null;
  const base = getOwn(raw, "base");
  if (payload.head === undefined) {
    if (base !== undefined) return null;
  } else if (base !== payload.head.h) {
    return null;
  }
  const skipped = getOwn(raw, "skipped");
  if (skipped !== undefined && !MERGED_SKIPS.includes(skipped as WtGraphMergedSkip)) return null;
  const omitted = getOwn(raw, "omitted");
  if (omitted !== undefined && !isPosSafeInt(omitted)) return null;
  const rawBranches = getOwn(raw, "branches");
  if (!Array.isArray(rawBranches) || rawBranches.length > WTGRAPH_MERGED_MAX) return null;
  if (skipped !== undefined && (rawBranches.length !== 0 || omitted !== undefined)) return null;

  const branches: WtGraphMergedEntry[] = [];
  const names = new Set<string>();
  const tips = new Map<string, WtGraphMergedEntry>();
  let totalE = 0;
  for (const rawEntry of rawBranches) {
    if (!isPlainObject(rawEntry) || !hasOnlyKeys(rawEntry, MERGED_ENTRY_KEYS)) return null;
    const n = getOwn(rawEntry, "n");
    const h = getOwn(rawEntry, "h");
    if (!isRefName(n) || !isOid(h, payload.format)) return null;
    if (names.has(n) || !payload.refs.some((r) => r.k === "branch" && r.n === n && r.h === h)) return null;
    names.add(n);
    const v = getOwn(rawEntry, "v");
    if (!MERGED_KINDS.includes(v as WtGraphMergedKind)) return null;
    const k = getOwn(rawEntry, "k");
    const t = getOwn(rawEntry, "t");
    const e = getOwn(rawEntry, "e");
    const eP = getOwn(rawEntry, "eP");
    const co = getOwn(rawEntry, "co");
    const why = getOwn(rawEntry, "why");
    if (co !== undefined && co !== true) return null;
    if (eP !== undefined && eP !== true) return null;
    if (v !== "part" && (e !== undefined || eP !== undefined)) return null;
    if (v === "unk") {
      if (!MERGED_UNKNOWNS.includes(why as WtGraphMergedUnknown)) return null;
    } else if (why !== undefined) {
      return null;
    }

    const entry: WtGraphMergedEntry = { n, h, v: v as WtGraphMergedKind };
    if (v === "eq" || v === "part" || v === "none") {
      // A sha1 cherry-mark line consumes at least 41 bytes (the protocol's conservative
      // common bound); sha256 shares the same wire bound, not a different schema.
      if (!isNonNegSafeInt(k) || !isPosSafeInt(t) || t > WTGRAPH_CHERRY_MAX_BYTES / 41) return null;
      if (v === "eq" && k !== t) return null;
      if (v === "part" && !(k > 0 && k < t)) return null;
      if (v === "none" && k !== 0) return null;
      entry.k = k;
      entry.t = t;
      if (e !== undefined) {
        if (!Array.isArray(e) || e.length > k || totalE + e.length > WTGRAPH_MERGED_E_MAX) return null;
        const seen = new Set<string>();
        const oids: string[] = [];
        for (const oid of e) {
          if (!isOid(oid, payload.format) || !commits.has(oid) || seen.has(oid)) return null;
          seen.add(oid);
          oids.push(oid);
        }
        totalE += oids.length;
        entry.e = oids;
      }
    } else if (k !== undefined || t !== undefined) {
      return null;
    }
    const first = tips.get(h);
    if (first !== undefined) {
      if (e !== undefined || v !== first.v || k !== first.k || t !== first.t) return null;
    } else {
      tips.set(h, entry);
    }
    if (eP === true) entry.eP = true;
    if (co === true) entry.co = true;
    if (v === "unk") entry.why = why as WtGraphMergedUnknown;
    branches.push(entry);
  }
  const merged: WtGraphMerged = { v: 1, branches };
  if (base !== undefined) merged.base = base as string;
  if (skipped !== undefined) merged.skipped = skipped as WtGraphMergedSkip;
  if (omitted !== undefined) merged.omitted = omitted as number;
  return merged;
}
