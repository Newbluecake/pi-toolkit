/**
 * web-hub-version plan §2 (V0 frozen surface): the pure, shared core of the version-info
 * endpoint (`GET /api/version`) — wire types, parse/compare helpers and the limits both
 * sides share.
 *
 * This module is deliberately IMPORT-FREE (no `node:*`, no typebox, no pi): V1's hub-side
 * service (`hub/version-info.ts`, `hub/changelog.ts`, `hub/version-git.ts`) and V2's browser
 * UI (`ui/src/composables/useVersionInfo.ts`, via the `@protocol/version-info.js` alias the
 * same way `upload.js`/`preview.js` are shared) import the identical constants and the
 * identical validation logic — never re-implement them. Every function here never throws.
 *
 * Frozen per plan §7: V1/V2 develop against these exports without touching this file.
 */

/** The version-info endpoint (V1's `hub/http.ts` mounts it on both listeners, plan §3.9). */
export const VERSION_INFO_PATH = "/api/version";

/**
 * The single limits table for the whole feature (plan §2). Producer side (V1): the hub
 * service clips sections/commits to `changelogSections`/`commits`, bounds subject bytes,
 * caches results for `okTtlMs`/`failTtlMs`, caps waiters and budgets time. Consumer side
 * (this file): `parseVersionInfoWire` REJECTS any array over `changelogSections`/`commits`
 * (plan §2「parse 拒绝超界」— the hub already trimmed, so an over-limit array is off-contract;
 * same reject-over-cap discipline as `parsePreviewDirListing`). Nothing else in the table is
 * parse-enforced (byte/latency budgets are producer-side concerns).
 */
export const VERSION_LIMITS = {
  /** Max changelog sections in one response (after `[Unreleased]` skipping). */
  changelogSections: 5,
  /** Per-section markdown byte budget before `truncated: true` (hub-side clip). */
  sectionBytes: 8192,
  /** Hard read cap for CHANGELOG.md / package.json (`readBounded`, plan §3.4). */
  fileBytes: 1 << 20,
  /** Max commits since the last `v*` tag. */
  commits: 20,
  /** Per-commit subject char budget (hub-side clip; control chars stripped). */
  subjectChars: 200,
  /** Whole-response byte budget (§8 acceptance「响应 ≤64 KiB」). */
  bodyBytes: 64 * 1024,
  /** Max concurrent waiters on the single-flight snapshot round (`E_BUSY` beyond). */
  waiters: 8,
  /** Total snapshot computation budget. */
  requestMs: 4000,
  /** Per git step budget (three stages, §3.3). */
  gitStepMs: 1000,
  /** File-read budget (§3.4/§3.5). */
  fileMs: 1000,
  /** Success cache TTL. */
  okTtlMs: 30_000,
  /** Failed-section cache TTL (`repo.error` / `changelog.error`). */
  failTtlMs: 10_000,
} as const;

/** One observed commit. `commit` is a lowercase-hex git hash ≥ 7 chars (short or full);
 *  `time` is unix seconds (`%ct`); `dirty` marks an unclean working tree at observation time. */
export interface CommitRef {
  commit: string;
  time?: number;
  dirty?: true;
}

/**
 * Identity of the UI root the hub is CURRENTLY serving (plan §2): `assets` are the
 * `/assets/*` paths the verified `index.html` references (sorted, ≤ 4) — Vite content-hash
 * filenames, so the list is a bundle fingerprint that changes even when `version`/`commit`/
 * `builtAt` do not (fixed `SOURCE_DATE_EPOCH`, dirty rebuilds). Lives in `HubInfo.ui` once
 * the UI root state is `ok`; surfaced through `FrontendDeps.onUiServed` (V1).
 */
export interface HubUiBuildWire {
  source: "package" | "external";
  version: string;
  commit: string;
  builtAt: string;
  assets: string[];
}

/** Why a repo/changelog section is missing or partial (plan §2; no paths ever ride along). */
export type SectionError = "timeout" | "unavailable" | "git-too-old" | "too-large" | "missing";

/** One commit of `VersionInfoWire.repo.commits` (subject is pre-clipped to
 *  `VERSION_LIMITS.subjectChars` by the hub; no author/email is ever collected, §3.3). */
export interface VersionRepoCommit {
  commit: string;
  time: number;
  subject: string;
}

/** The success form of `VersionInfoWire.repo` (the whole key is ABSENT when the package root
 *  is not a git toplevel — host-repo exclusion, plan §3.3 stage 1). */
export interface VersionRepoWire {
  head: CommitRef;
  packageVersion?: string;
  lastTag?: string;
  commits?: VersionRepoCommit[];
  commitsTotal?: number;
}

/** One parsed CHANGELOG section (`## [x.y.z] - date` + body). */
export interface VersionChangelogSection {
  title: string;
  date?: string;
  markdown: string;
  truncated?: true;
}

/** The success form of `VersionInfoWire.changelog`. */
export interface VersionChangelogWire {
  sections: VersionChangelogSection[];
}

/**
 * The `GET /api/version` response body (plan §2). `hub.pid`/`hub.startedAt` are the
 * generation key — the UI drops snapshots that do not match the CURRENT hub frame (plan §4).
 */
export interface VersionInfoWire {
  v: 1;
  checkedAt: number;
  hub: { pid: number; startedAt: number };
  repo?: VersionRepoWire | { error: SectionError };
  changelog?: VersionChangelogWire | { error: SectionError };
  truncated?: true;
}

// ---------------------------------------------------------------------------
// normalizeCommit / compareCommit (plan §2) — accept every commit spelling that appears on
// the wire: bare short hash (`abc1234`), hub `buildId` (`0.5.5@abc1234` / `0.5.5@abc1234*`),
// UI manifest commit (`abc1234-dirty` / `"unknown"` / `"nogit"`).
// ---------------------------------------------------------------------------

/** Lowercase hex, 7 (short-hash minimum, plan「小写 hex ≥7」) through 64 chars (a full
 *  sha-256 object id — the longest git can emit; the bound keeps absurd strings out). */
const COMMIT_HEX_RE = /^[0-9a-f]{7,64}$/;

/**
 * Strip the decorations off any wire-side commit spelling and return the bare hash + dirty
 * flag, or `null` when no valid hash remains. Never throws.
 *
 * - everything up to and including the LAST `@` is dropped first (`<version>@<hash>`
 *   buildIds; a semver version never contains `@`), so `0.5.5@nogit` / `0.5.5@unknown`
 *   degrade to `nogit` / `unknown` and die on the hex check like their bare forms;
 * - at most ONE terminal suffix mark, `*` (hub buildId dirty) or `-dirty` (UI manifest) —
 *   the two vocabularies never chain in reality, so stacked marks (`abc1234**`,
 *   `abc1234-dirty-dirty`, `abc1234-dirty*`, `abc1234*-dirty`) all fail the hex check ⇒ null;
 * - uppercase hex is REJECTED (git emits lowercase; `CommitRef.commit` is specified
 *  小写) and fewer than 7 hex chars ⇒ null.
 */
export function normalizeCommit(s: unknown): { hex: string; dirty: boolean } | null {
  if (typeof s !== "string") return null;
  let t = s;
  const at = t.lastIndexOf("@");
  if (at >= 0) t = t.slice(at + 1);
  let dirty = false;
  if (t.endsWith("*")) {
    dirty = true;
    t = t.slice(0, -1);
  } else if (t.endsWith("-dirty")) {
    dirty = true;
    t = t.slice(0, -"-dirty".length);
  }
  if (!COMMIT_HEX_RE.test(t)) return null;
  return { hex: t, dirty };
}

/**
 * Compare two wire-side commit spellings by hash PREFIX equality: `same` when the two hashes
 * agree on the first `min(len)` characters (min is ≥ 7 by construction — one side's short
 * hash vs the other's full hash compares on the short side's length), `differ` otherwise.
 * Dirty flags are ignored for equality (`abc1234*` vs `abc1234-dirty` ⇒ `same` — the dirty
 * info is surfaced separately, §4's `dirty` finding). Either side unparseable ⇒ `unknown`
 * (never lit as a dot). Never throws.
 */
export function compareCommit(a: unknown, b: unknown): "same" | "differ" | "unknown" {
  const na = normalizeCommit(a);
  const nb = normalizeCommit(b);
  if (na === null || nb === null) return "unknown";
  const n = Math.min(na.hex.length, nb.hex.length);
  return na.hex.slice(0, n) === nb.hex.slice(0, n) ? "same" : "differ";
}

// ---------------------------------------------------------------------------
// parseVersionInfoWire (plan §2) — strict validation of a decoded `GET /api/version` body.
// House discipline follows `parsePreviewDirListing`: anything off-contract ⇒ `undefined`,
// unknown fields are ignored (additive-extension room), never throws. Over-limit arrays are
// REJECTED, not clipped (「parse 拒绝超界」— the producer already trims; §8's ≤64 KiB body
// cap is a transport-level concern this signature deliberately does not take).
// ---------------------------------------------------------------------------

const SECTION_ERRORS: readonly SectionError[] = ["timeout", "unavailable", "git-too-old", "too-large", "missing"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPosSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function parseSectionError(v: unknown): SectionError | undefined {
  return typeof v === "string" && SECTION_ERRORS.includes(v as SectionError) ? (v as SectionError) : undefined;
}

function parseCommitRef(v: unknown): CommitRef | undefined {
  if (!isObj(v)) return undefined;
  const commit = v["commit"];
  if (typeof commit !== "string" || !COMMIT_HEX_RE.test(commit)) return undefined;
  const ref: CommitRef = { commit };
  if (v["time"] !== undefined) {
    if (!isNonNegSafeInt(v["time"])) return undefined;
    ref.time = v["time"];
  }
  if (v["dirty"] !== undefined) {
    if (v["dirty"] !== true) return undefined;
    ref.dirty = true;
  }
  return ref;
}

/** `{error}` wins when both forms' keys are present (a well-formed producer never mixes them;
 *  extra keys are ignored like everywhere else). */
function parseRepo(v: unknown): VersionRepoWire | { error: SectionError } | undefined {
  if (!isObj(v)) return undefined;
  if (v["error"] !== undefined) {
    const error = parseSectionError(v["error"]);
    return error === undefined ? undefined : { error };
  }
  const head = parseCommitRef(v["head"]);
  if (head === undefined) return undefined;
  const repo: VersionRepoWire = { head };
  if (v["packageVersion"] !== undefined) {
    if (typeof v["packageVersion"] !== "string" || v["packageVersion"] === "") return undefined;
    repo.packageVersion = v["packageVersion"];
  }
  if (v["lastTag"] !== undefined) {
    if (typeof v["lastTag"] !== "string" || v["lastTag"] === "") return undefined;
    repo.lastTag = v["lastTag"];
  }
  if (v["commits"] !== undefined) {
    const arr = v["commits"];
    if (!Array.isArray(arr) || arr.length > VERSION_LIMITS.commits) return undefined;
    const commits: VersionRepoCommit[] = [];
    for (const c of arr) {
      if (!isObj(c)) return undefined;
      const commit = c["commit"];
      const time = c["time"];
      const subject = c["subject"];
      if (typeof commit !== "string" || !COMMIT_HEX_RE.test(commit)) return undefined;
      if (!isNonNegSafeInt(time)) return undefined;
      if (typeof subject !== "string") return undefined;
      commits.push({ commit, time, subject });
    }
    repo.commits = commits;
  }
  if (v["commitsTotal"] !== undefined) {
    if (!isNonNegSafeInt(v["commitsTotal"])) return undefined;
    repo.commitsTotal = v["commitsTotal"];
  }
  return repo;
}

/** Same `{error}`-wins rule as `parseRepo`. */
function parseChangelog(v: unknown): VersionChangelogWire | { error: SectionError } | undefined {
  if (!isObj(v)) return undefined;
  if (v["error"] !== undefined) {
    const error = parseSectionError(v["error"]);
    return error === undefined ? undefined : { error };
  }
  const sections = v["sections"];
  if (!Array.isArray(sections) || sections.length > VERSION_LIMITS.changelogSections) return undefined;
  const out: VersionChangelogSection[] = [];
  for (const s of sections) {
    if (!isObj(s)) return undefined;
    const title = s["title"];
    if (typeof title !== "string" || title === "") return undefined;
    const markdown = s["markdown"];
    if (typeof markdown !== "string") return undefined;
    const sec: VersionChangelogSection = { title, markdown };
    if (s["date"] !== undefined) {
      if (typeof s["date"] !== "string" || s["date"] === "") return undefined;
      sec.date = s["date"];
    }
    if (s["truncated"] !== undefined) {
      if (s["truncated"] !== true) return undefined;
      sec.truncated = true;
    }
    out.push(sec);
  }
  return { sections: out };
}

/**
 * Validate + narrow an arbitrary decoded JSON value into a `VersionInfoWire`. `undefined` on
 * anything off-contract (bad `v`, non-safe-integer `checkedAt`/`hub.pid`/`hub.startedAt`,
 * malformed `repo`/`changelog` shapes, over-limit arrays, non-`true` `dirty`/`truncated`
 * flags, …). Unknown fields at every level are ignored. Never throws.
 */
export function parseVersionInfoWire(x: unknown): VersionInfoWire | undefined {
  if (!isObj(x)) return undefined;
  if (x["v"] !== 1) return undefined;
  const checkedAt = x["checkedAt"];
  if (!isNonNegSafeInt(checkedAt)) return undefined;
  const hubRaw = x["hub"];
  if (!isObj(hubRaw)) return undefined;
  const pid = hubRaw["pid"];
  if (!isPosSafeInt(pid)) return undefined;
  const startedAt = hubRaw["startedAt"];
  if (!isNonNegSafeInt(startedAt)) return undefined;
  const wire: VersionInfoWire = { v: 1, checkedAt, hub: { pid, startedAt } };
  if (x["repo"] !== undefined) {
    const repo = parseRepo(x["repo"]);
    if (repo === undefined) return undefined;
    wire.repo = repo;
  }
  if (x["changelog"] !== undefined) {
    const changelog = parseChangelog(x["changelog"]);
    if (changelog === undefined) return undefined;
    wire.changelog = changelog;
  }
  if (x["truncated"] !== undefined) {
    if (x["truncated"] !== true) return undefined;
    wire.truncated = true;
  }
  return wire;
}
