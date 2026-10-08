/**
 * web-hub worktree file-diff protocol (worktree-diff plan v3 §1.3 — frozen interface, D0).
 *
 * Pure TypeScript, `node:*`-free: the browser UI (D2/D4/D5's `logic/wtdiff.js` / transports)
 * imports the limits, types, validators and parsers here, exactly like `protocol/preview.ts`.
 * Everything on the wire for the two `GET /api/worktree-diff/*` endpoints (§1.2) — caps,
 * budget constants, envelope types, defensive parsers, the unified-patch parser and the
 * repo-relative path gate — is frozen in this one module so the hub (D3) and the UI never
 * drift. The route behavior itself (membership, three-fd pinning, driver neutralization) is
 * NOT here; D0 only ships the wire contract.
 *
 * 「可展示但不可请求」(#7) lives here as a protocol definition: the file-list parser ACCEPTS
 * CR/LF/TAB/U+FFFD in `path`/`orig` (they came from `git -z` output and must render), while
 * `isWtRequestableEntry` is the single predicate deciding whether the `file` endpoint may be
 * asked for that entry. The two must never be conflated.
 */

/** The file-list endpoint (§1.2: `GET`, `X-PWH: 1` required). */
export const WTDIFF_FILES_PATH = "/api/worktree-diff/files";

/** The single-file endpoint (§1.2: `GET`, `X-PWH: 1` required). */
export const WTDIFF_FILE_PATH = "/api/worktree-diff/file";

// ---------------------------------------------------------------------------
// caps (§1.3 上限)
// ---------------------------------------------------------------------------

/** Max parsed entries in a `WtDiffFileList` (over ⇒ hub truncates, `limits.files`). */
export const WTDIFF_FILES_MAX = 1_000;

/** C2 `status --porcelain=v2 -z` stdout cap. */
export const WTDIFF_STATUS_MAX_BYTES = 512 * 1024;

/** C3 `diff-index --numstat -z` stdout cap. */
export const WTDIFF_NUMSTAT_MAX_BYTES = 256 * 1024;

/** Serialized `WtDiffFileList` body cap (the UNCOMPRESSED JSON, judged by the parser). */
export const WTDIFF_LIST_BODY_MAX_BYTES = 256 * 1024;

/** Single `patch` string cap inside `WtDiffFilePayload` (C4 stdout cap). */
export const WTDIFF_PATCH_MAX_BYTES = 512 * 1024;

/** Serialized `WtDiffFilePayload` body cap (the UNCOMPRESSED JSON, judged by the parser). */
export const WTDIFF_FILE_BODY_MAX_BYTES = 1024 * 1024;

/** §3.1.1: max bytes read from an untracked file before the synthesized patch is cut. */
export const WTDIFF_UNTRACKED_READ_MAX_BYTES = 384 * 1024;

/** `parseUnifiedPatch` line budget — patch lines processed (hunk headers + extended headers
 * included). Independent of the hunk budget below (#8): a 512 KiB `-U3` patch can carry
 * ~26k single-line hunks, and every hunk is its own UI pagination unit, so hunk METADATA
 * needs its own cap. First cap to fire stops the parse (`lineCap`). */
export const WTDIFF_PARSE_LINES_MAX = 50_000;

/** `parseUnifiedPatch` hunk budget (#8) — first cap to fire stops the parse (`hunkCap`). */
export const WTDIFF_PARSE_HUNKS_MAX = 10_000;

/** C1 `worktree list --porcelain` stdout cap (§2.3 membership runs on the COMPLETE output). */
export const WTDIFF_WT_LIST_MAX_BYTES = 256 * 1024;

/** Membership realpath fan-out cap (#9) — caps only the fan-out, never the literal match. */
export const WTDIFF_WT_REALPATH_FANOUT_MAX = 64;

/** Max neutralizable driver names (over ⇒ 415 `filter-config`, §2.6.2 L2). */
export const WTDIFF_DRIVERS_MAX = 16;

/** Changeset cache TTL (§1.10; key carries the request's own C0 oid, never content). */
export const WTDIFF_CHANGESET_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// budgets (§1.9 总账 — two-phase + finally; relations pinned in
// tests/web-hub/protocol/worktree-diff.test.ts)
// ---------------------------------------------------------------------------

/** Admission phase: auth + params + session + membership + three-fd pinning (same 8s as preview). */
export const WTDIFF_ADMIT_MS = 8_000;

/** Minimum admission remainder guaranteed AFTER auth (LAN auth itself is capped at 3s). */
export const WTDIFF_AUTH_RESERVE_MS = 5_000;

/** Single-step cap: each small git command / fs step (same as PREVIEW_FS_STEP_MS). */
export const WTDIFF_STEP_MS = 2_000;

/** Git phase: appended INDEPENDENT after admission ends (like dir-plan's listing phase). */
export const WTDIFF_GIT_PHASE_MS = 14_000;

/** C2 / C3 / C4 single-command cap. */
export const WTDIFF_GIT_CMD_MS = 5_000;

/** finally: the three pins (+ untracked handle) close in parallel, each on its OWN deadline. */
export const WTDIFF_CLOSE_MS = 1_000;

/** Transfer reserve after the server wall-clock cap (23s) — see the §1.9 relation pin. */
export const WTDIFF_TRANSFER_RESERVE_MS = 10_000;

/** UI client timeout; `ADMIT + GIT_PHASE + CLOSE + TRANSFER_RESERVE ≤ CLIENT_TIMEOUT`. */
export const WTDIFF_CLIENT_TIMEOUT_MS = 35_000;

// ---------------------------------------------------------------------------
// request-value validation (§2.4 / §1.2)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** `base` / HEAD oid gate: full-length lowercase hex, sha1 (40) or sha256 (64). */
export const WTDIFF_BASE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Repo-relative path byte cap (Linux PATH_MAX, same figure as preview's absolute-path cap). */
export const WTDIFF_PATH_MAX_BYTES = 4096;

/**
 * §1.2/§2.4: the `path` / `orig` request gate — non-empty, not rooted, ≤4096 UTF-8 bytes, no
 * NUL/CR/LF, and every `/`-segment non-empty and neither `.` / `..` / `.git`. Returns a
 * boolean (never throws); callers map `false` to their own error (hub: 400 `E_BAD_REQUEST`).
 * Deliberately does NOT reject TAB (it round-trips losslessly through JSON/query encoding;
 * only CR/LF break line-oriented handling and only U+FFFD marks a lossy decode).
 */
export function validateWtRelPath(p: string): boolean {
  if (typeof p !== "string" || p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\0") || p.includes("\r") || p.includes("\n")) return false;
  if (textEncoder.encode(p).length > WTDIFF_PATH_MAX_BYTES) return false;
  const segments = p.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment === ".git") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// file list (§1.3 清单)
// ---------------------------------------------------------------------------

/** The single source of the status enum — hub, UI badge mapping and parser all import THIS. */
export const WTDIFF_STATUSES = ["M", "A", "D", "R", "C", "T", "U", "?"] as const;

export type WtDiffStatus = (typeof WTDIFF_STATUSES)[number];

export interface WtDiffFileEntry {
  /** Repo-relative path, git `-z` output decoded as-is; may contain CR/LF/TAB/U+FFFD —
   * displayable but then never requestable (see `isWtRequestableEntry`). */
  path: string;
  /** Pre-image path; only for `R` / `C`. */
  orig?: string;
  status: WtDiffStatus;
  /** numstat counts; absent for binary / untracked / filtered / numstat-missing entries. */
  add?: number;
  del?: number;
  binary?: true;
  /** Managed by a filter driver (LFS…) or check-attr did not cover it (fail-closed):
   * listed, never requestable. Never carries `add`/`del` (parser-enforced). */
  filtered?: true;
}

export interface WtDiffFileList {
  /** Current HEAD full-length oid (the request's own C0 — never a cached value). */
  base: string;
  /** Order = git status output order. */
  entries: WtDiffFileEntry[];
  /** Parsed, NOT-hidden entry count (denylist hits never count, D14); lower bound when
   * `limits.status` fired. */
  total: number;
  /** `entries.length < total || limits.status` (parser-enforced). */
  truncated: boolean;
  limits: { status: boolean; files: boolean; bytes: boolean };
  untrackedSkipped?: true;
  numstatPartial?: true;
  /** check-attr did not cover everything: uncovered entries are already marked `filtered`. */
  attrPartial?: true;
}

/**
 * #7「可展示但不可请求」— the SINGLE predicate. The UI uses it to disable an entry; the hub
 * uses it to build the requestable changeset (a `file` ask for anything else ⇒ 409 `entry`).
 * = `validateWtRelPath(path) && (orig === undefined || validateWtRelPath(orig))`
 *   `&& !path.includes(U+FFFD) && !(orig ?? "").includes(U+FFFD) && filtered !== true`.
 */
export function isWtRequestableEntry(e: WtDiffFileEntry): boolean {
  if (e === null || typeof e !== "object") return false;
  if (!validateWtRelPath(e.path)) return false;
  if (e.orig !== undefined && !validateWtRelPath(e.orig)) return false;
  if (e.path.includes("\uFFFD")) return false;
  if (e.orig !== undefined && e.orig.includes("\uFFFD")) return false;
  if (e.filtered === true) return false;
  return true;
}

function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isWtPathWireString(v: unknown): v is string {
  // The LIST parser is deliberately wider than validateWtRelPath: CR/LF/TAB/U+FFFD stay
  // displayable (§1.3「可展示但不可请求」); only NUL and the byte cap are refused here.
  return (
    typeof v === "string" && v !== "" && !v.includes("\0") && textEncoder.encode(v).length <= WTDIFF_PATH_MAX_BYTES
  );
}

/**
 * Strict validation of a `WtDiffFileList` body (§1.3). `byteLength` is the DECODED body's
 * UTF-8 byte count (transport may have carried it gzip'd — the cap is judged on this number,
 * never on Content-Length). Anything off-contract ⇒ `null`; unknown fields are ignored.
 * Never throws.
 */
export function parseWtDiffFileList(raw: unknown, byteLength: number): WtDiffFileList | null {
  if (!isNonNegSafeInt(byteLength)) return null;
  if (byteLength > WTDIFF_LIST_BODY_MAX_BYTES) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const base = o.base;
  if (typeof base !== "string" || !WTDIFF_BASE_RE.test(base)) return null;

  const rawEntries = o.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length > WTDIFF_FILES_MAX) return null;
  const entries: WtDiffFileEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null;
    const e = rawEntry as Record<string, unknown>;
    if (!isWtPathWireString(e.path)) return null;
    const status = e.status;
    if (typeof status !== "string" || !(WTDIFF_STATUSES as readonly string[]).includes(status)) return null;
    const entry: WtDiffFileEntry = { path: e.path, status: status as WtDiffStatus };
    if (e.orig !== undefined) {
      if (!isWtPathWireString(e.orig)) return null;
      if (status !== "R" && status !== "C") return null;
      entry.orig = e.orig;
    }
    if (e.add !== undefined) {
      if (!isNonNegSafeInt(e.add)) return null;
      entry.add = e.add;
    }
    if (e.del !== undefined) {
      if (!isNonNegSafeInt(e.del)) return null;
      entry.del = e.del;
    }
    if (e.binary !== undefined && e.binary !== true) return null;
    if (e.filtered !== undefined && e.filtered !== true) return null;
    if (e.filtered === true) {
      if (entry.add !== undefined || entry.del !== undefined) return null;
      entry.filtered = true;
    }
    if (e.binary === true) entry.binary = true;
    entries.push(entry);
  }

  const total = o.total;
  if (!isNonNegSafeInt(total)) return null;
  if (total < entries.length) return null;
  const rawLimits = o.limits;
  if (rawLimits === null || typeof rawLimits !== "object" || Array.isArray(rawLimits)) return null;
  const l = rawLimits as Record<string, unknown>;
  if (typeof l.status !== "boolean" || typeof l.files !== "boolean" || typeof l.bytes !== "boolean") return null;
  const truncated = o.truncated;
  if (typeof truncated !== "boolean") return null;
  if (truncated !== (entries.length < total || l.status)) return null;
  if (o.untrackedSkipped !== undefined && o.untrackedSkipped !== true) return null;
  if (o.numstatPartial !== undefined && o.numstatPartial !== true) return null;
  if (o.attrPartial !== undefined && o.attrPartial !== true) return null;

  const list: WtDiffFileList = {
    base,
    entries,
    total,
    truncated,
    limits: { status: l.status, files: l.files, bytes: l.bytes },
  };
  if (o.untrackedSkipped === true) list.untrackedSkipped = true;
  if (o.numstatPartial === true) list.numstatPartial = true;
  if (o.attrPartial === true) list.attrPartial = true;
  return list;
}

// ---------------------------------------------------------------------------
// single file (§1.3 单文件)
// ---------------------------------------------------------------------------

export type WtDiffFileKind = "patch" | "binary" | "empty";

export interface WtDiffFilePayload {
  base: string;
  path: string;
  orig?: string;
  /** `empty`: the entry is in the changeset but has no content delta vs `base` (e.g. a
   * stat-only change that was reverted). */
  kind: WtDiffFileKind;
  /** Raw unified patch; always `""` when `kind !== "patch"`. */
  patch: string;
  /** `patch`'s exact UTF-8 byte count (the uncompressed payload, never the transport's). */
  bytes: number;
  truncated: boolean;
  untracked?: true;
}

/**
 * Strict validation of a `WtDiffFilePayload` body (§1.3). Unlike the LIST parser this one
 * routes `path`/`orig` through `validateWtRelPath` — a `file` RESPONSE carrying a
 * non-requestable path would mean the hub served an entry it should have 409'd. Never throws.
 */
export function parseWtDiffFile(raw: unknown, byteLength: number): WtDiffFilePayload | null {
  if (!isNonNegSafeInt(byteLength)) return null;
  if (byteLength > WTDIFF_FILE_BODY_MAX_BYTES) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const base = o.base;
  if (typeof base !== "string" || !WTDIFF_BASE_RE.test(base)) return null;
  const path = o.path;
  if (typeof path !== "string" || !validateWtRelPath(path)) return null;
  if (o.orig !== undefined && (typeof o.orig !== "string" || !validateWtRelPath(o.orig))) return null;
  const kind = o.kind;
  if (kind !== "patch" && kind !== "binary" && kind !== "empty") return null;
  const patch = o.patch;
  if (typeof patch !== "string") return null;
  if (kind !== "patch" && patch !== "") return null;
  const bytes = o.bytes;
  if (!isNonNegSafeInt(bytes)) return null;
  if (bytes > WTDIFF_PATCH_MAX_BYTES) return null;
  if (bytes !== textEncoder.encode(patch).length) return null;
  const truncated = o.truncated;
  if (typeof truncated !== "boolean") return null;
  if (o.untracked !== undefined && o.untracked !== true) return null;

  const payload: WtDiffFilePayload = { base, path, kind, patch, bytes, truncated };
  if (o.orig !== undefined) payload.orig = o.orig;
  if (o.untracked === true) payload.untracked = true;
  return payload;
}

// ---------------------------------------------------------------------------
// error reasons (§1.5 error matrix — bodies of E_WTDIFF_DENIED / E_WTDIFF_UNSUPPORTED /
// E_BUSY / E_STALE_CTX; E_STALE_CTX itself is a pre-existing code, only its reason is new)
// ---------------------------------------------------------------------------

/** 403 `E_WTDIFF_DENIED` body reason. */
export type WtDiffDenyReason = "not-repo" | "not-worktree" | "denylist" | "virtual-fs";

/** 415/503 `E_WTDIFF_UNSUPPORTED` body reason. */
export type WtDiffUnsupportedReason = "unborn" | "symlink" | "git-unavailable" | "git-too-old" | "filter-config";

/** 503 `E_BUSY` body reason (wtdiff's slice of the shared busy vocabulary). */
export type WtDiffBusyReason = "inflight" | "fs" | "attr-changed";

/** 409 `E_STALE_CTX` body reason (D8/#1: base ≠ this request's HEAD / entry not requestable). */
export type WtDiffStaleReason = "base" | "entry";

// ---------------------------------------------------------------------------
// unified patch parsing (§3.2 — linear, never throws)
// ---------------------------------------------------------------------------

export interface PatchLine {
  k: "ctx" | "del" | "add";
  o: number | null;
  n: number | null;
  text: string;
  noEol?: true;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: PatchLine[];
}

export interface PatchFileMeta {
  newFile?: true;
  deleted?: true;
  renameFrom?: string;
  renameTo?: string;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  binary?: true;
}

export interface PatchFile {
  meta: PatchFileMeta;
  hunks: PatchHunk[];
}

export interface ParsedPatch {
  files: PatchFile[];
  add: number;
  del: number;
  /** False iff a hunk's counts were still open when parsing stopped (truncated input). */
  complete: boolean;
  /** A syntactically invalid line/header was hit; everything after it is discarded. */
  malformed: boolean;
  /** `WTDIFF_PARSE_LINES_MAX` fired. */
  lineCap: boolean;
  /** `WTDIFF_PARSE_HUNKS_MAX` fired (#8). */
  hunkCap: boolean;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const BINARY_DIFFER_RE = /^Binary files .* differ$/;
const OCTAL_MODE_RE = /^[0-7]{1,6}$/;
const SIMILARITY_RE = /^(\d+)%$/;

/**
 * §3.2: count-driven unified-patch parser. Splits on `\n` (a trailing `\r` stays in `text`);
 * hunk bodies are driven by the header's old/new counts; `\`-lines never count and mark the
 * previous line `noEol`. While a hunk's counts are open, EVERY line is content judged by its
 * first character — a deleted line whose text starts with `--` renders as `--- x` and must
 * still parse as a deletion, never as a `--- a/file` header. Both caps (lines / hunks) are
 * judged independently, first to fire stops. Never throws, never quadratic.
 */
export function parseUnifiedPatch(text: string): ParsedPatch {
  const files: PatchFile[] = [];
  let addTotal = 0;
  let delTotal = 0;
  let malformed = false;
  let lineCap = false;
  let hunkCap = false;

  let curFile: PatchFile | null = null;
  let curHunk: PatchHunk | null = null;
  let lastLine: PatchLine | null = null;
  let oldRemain = 0;
  let newRemain = 0;
  let oldCur = 0;
  let newCur = 0;
  let hunkCount = 0;
  let processed = 0;

  const rawLines = text.split("\n");
  // A text ending in "\n" yields a trailing "" artifact — not a line. An interior "" IS a
  // line (a blank context line, rule 4).
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  for (const line of rawLines) {
    if (processed >= WTDIFF_PARSE_LINES_MAX) {
      lineCap = true;
      break;
    }
    processed++;

    if (oldRemain > 0 || newRemain > 0) {
      // ---- hunk body: count-driven, first character decides (rule 4) ----
      const c0 = line.charAt(0);
      if (c0 === "\\") {
        // never counts; attaches to the most recent emitted line (may legally arrive after
        // the count hit zero — "old\n+new\n\ No newline" closes the hunk before the marker)
        if (lastLine !== null) lastLine.noEol = true;
        continue;
      }
      if (c0 === " " || line === "") {
        if (oldRemain <= 0 || newRemain <= 0) {
          malformed = true;
          break;
        }
        const pl: PatchLine = { k: "ctx", o: oldCur++, n: newCur++, text: line.slice(1) };
        curHunk?.lines.push(pl);
        lastLine = pl;
        oldRemain--;
        newRemain--;
        continue;
      }
      if (c0 === "-") {
        if (oldRemain <= 0) {
          malformed = true;
          break;
        }
        const pl: PatchLine = { k: "del", o: oldCur++, n: null, text: line.slice(1) };
        curHunk?.lines.push(pl);
        lastLine = pl;
        oldRemain--;
        delTotal++;
        continue;
      }
      if (c0 === "+") {
        if (newRemain <= 0) {
          malformed = true;
          break;
        }
        const pl: PatchLine = { k: "add", o: null, n: newCur++, text: line.slice(1) };
        curHunk?.lines.push(pl);
        lastLine = pl;
        newRemain--;
        addTotal++;
        continue;
      }
      // includes `@@`-prefixed lines and `diff --git` lookalikes — inside open counts they
      // cannot be structure (rule 4/5)
      malformed = true;
      break;
    }

    // ---- not inside an active hunk ----
    if (line.startsWith("diff --git ")) {
      curFile = { meta: {}, hunks: [] };
      files.push(curFile);
      curHunk = null;
      lastLine = null;
      continue;
    }
    if (curFile === null) continue; // stray text before the first file header: ignored
    if (line.startsWith("\\")) {
      // trailing "\ No newline" after the counts closed — still belongs to the last line
      if (lastLine !== null) lastLine.noEol = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER_RE.exec(line);
      if (m === null) {
        malformed = true;
        break;
      }
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      if (
        !Number.isSafeInteger(oldStart) ||
        !Number.isSafeInteger(oldLines) ||
        !Number.isSafeInteger(newStart) ||
        !Number.isSafeInteger(newLines)
      ) {
        malformed = true;
        break;
      }
      if (hunkCount >= WTDIFF_PARSE_HUNKS_MAX) {
        hunkCap = true;
        break;
      }
      curHunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        section: m[5] ?? "",
        lines: [],
      };
      curFile.hunks.push(curHunk);
      hunkCount++;
      oldCur = oldStart;
      newCur = newStart;
      oldRemain = oldLines;
      newRemain = newLines;
      lastLine = null;
      continue;
    }

    // ---- extended headers (rule 2): recognized set, unknown ignored ----
    const meta = curFile.meta;
    if (line.startsWith("new file mode ")) {
      const mode = line.slice("new file mode ".length);
      if (OCTAL_MODE_RE.test(mode)) {
        meta.newFile = true;
        meta.newMode = mode;
      }
    } else if (line.startsWith("deleted file mode ")) {
      const mode = line.slice("deleted file mode ".length);
      if (OCTAL_MODE_RE.test(mode)) {
        meta.deleted = true;
        meta.oldMode = mode;
      }
    } else if (line.startsWith("old mode ")) {
      const mode = line.slice("old mode ".length);
      if (OCTAL_MODE_RE.test(mode)) meta.oldMode = mode;
    } else if (line.startsWith("new mode ")) {
      const mode = line.slice("new mode ".length);
      if (OCTAL_MODE_RE.test(mode)) meta.newMode = mode;
    } else if (line.startsWith("similarity index ")) {
      const m = SIMILARITY_RE.exec(line.slice("similarity index ".length));
      if (m !== null) meta.similarity = Number(m[1]);
    } else if (line.startsWith("rename from ")) {
      const from = line.slice("rename from ".length);
      if (from !== "") meta.renameFrom = from;
    } else if (line.startsWith("rename to ")) {
      const to = line.slice("rename to ".length);
      if (to !== "") meta.renameTo = to;
    } else if (
      line.startsWith("copy from ") ||
      line.startsWith("copy to ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      // recognized but deliberately not surfaced — `PatchFileMeta`'s frozen field set has no
      // slot for them (the list entry's path/orig is the UI's source of truth)
    } else if (BINARY_DIFFER_RE.test(line) || line === "GIT binary patch") {
      meta.binary = true;
    }
    // everything else: unknown extended header — ignored
  }

  return {
    files,
    add: addTotal,
    del: delTotal,
    complete: oldRemain === 0 && newRemain === 0,
    malformed,
    lineCap,
    hunkCap,
  };
}
