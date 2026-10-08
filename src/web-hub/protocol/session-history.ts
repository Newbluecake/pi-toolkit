/**
 * web-hub session-history plan §3.1 (P0 — frozen surface, verbatim): the wire types,
 * constants and pure validators for the history session list (`GET /api/headless/history`)
 * and the `session` ref on `POST /api/headless`.
 *
 * Pure TypeScript — NO typebox, NO `node:*` imports: the browser UI (P-ui) imports the
 * limits and types here for its own prechecks, exactly like `protocol/spawn.ts`. Everything
 * on the wire for the history surface is frozen in this one module so the hub (P-scan /
 * P-route) and the UI never drift. The three functions are the only runtime here and are
 * all total (`decodeHistoryCursor`/`isValidSessionKey` never throw; `encodeHistoryCursor`
 * validates its trusted-caller inputs and throws `TypeError` — the plan annotates "Never
 * throws" only on the two wire-facing functions).
 */

export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 100;
export const HISTORY_Q_MAX_CHARS = 128; // after trim, UTF-16 units
export const SESSION_KEY_MAX_BYTES = 512; // UTF-8
export const HISTORY_TITLE_MAX = 200; // UTF-16 units, never splits a surrogate pair
export const HISTORY_CURSOR_MAX_CHARS = 64;
/** H0 marker customType — pinned equal to src/runtime/session-driver.ts's SUBAGENT_CHILD_CUSTOM_TYPE by source scan. */
export const HISTORY_CHILD_MARKER_TYPE = "subagent:child";
export const SESSION_OPEN_REASON = "session-open";
export const CURSOR_EXPIRED_REASON = "cursor-expired";

export type HistoryKind = "main" | "sub" | "unknown";

export type HistoryCwdState = "ok" | "gone" | "not-dir" | "no-access" | "moved" | "unknown";
export type HistoryBlocked = Exclude<HistoryCwdState, "ok" | "unknown"> | "invalid";
/** Why a session must be forked. Priority when several hold: open > subagent > maybe > unverified. */
export type ForkReason = "open" | "maybe" | "subagent" | "unverified";
/**
 * Why the hub could NOT establish "no occupancy detected" (§4.5.5; best-effort per arch §14.1).
 * forkReason "maybe" ⇔ gap "unconnected-pi"; every other gap ⇒ forkReason "unverified".
 */
export type ProofGap =
  | "kind" // target not positively kind "main" (unknown)
  | "proc-partial" // /proc scan incomplete: budget / PID cap / zombie breaker / unreadable same-uid entry / no procfs
  | "unconnected-pi" // a same-uid pi candidate matches no live card (pid) and no managed record (pid+startTicks)
  | "card-unproven" // candidate matches a card that is claiming/stale, or live but never reported a session
  | "new-process"; // the sync re-stat right before spawn saw a changed starttime or a new same-uid pi/node* pid

export interface HistoryLiveWire {
  state: "open" | "maybe";
  by: "card" | "managed" | "proc";
  agentKey?: string;
  pid?: number;
}

export interface HistoryItemWire {
  key: string; // "<dir>/<file>" relative to realpath(sessionsRoot); sole source of SessionRefWire.key
  id: string;
  cwd: string; // header cwd, verbatim
  cwdLabel: string;
  startedAt: string;
  mtimeMs: number; // as captured when the generation enumerated the file
  size: number; // as captured when the generation enumerated the file
  title?: string;
  titleSource: "name" | "first" | "none";
  kind: HistoryKind;
  forked?: true;
  cwdState: HistoryCwdState;
  startable: boolean;
  blocked?: HistoryBlocked;
  live?: HistoryLiveWire;
  forkOnly?: ForkReason; // advisory (≤5s-old scan); the POST re-scans fresh
  proofGap?: ProofGap; // present iff forkOnly ∈ {"maybe","unverified"}
  indexed: true;
}

export interface HistoryEnumStats {
  complete: boolean; // enumeration CURSOR finished (PD9'); says nothing about omissions — see HistoryPage.incomplete
  dirsDone: number;
  dirsTotal: number; // frozen at generation creation (≤ HISTORY_DIR_LIMIT)
  dirsSkipped?: number; // dirs given up after HISTORY_IO_RETRY_MAX consecutive readdir/open failures (file count unknown)
  dirsTruncated?: true; // root had more than HISTORY_DIR_LIMIT dirs — the rest are never listed
  filesTruncated?: true; // HISTORY_FILE_LIMIT reached — remaining files of the current dir are never listed
}

export interface HistoryPage {
  items: HistoryItemWire[];
  next?: string; // opaque cursor "v1.<genId>.<pos>"; absent ⇔ enumeration complete AND pos reached files.length
  partial?: { reason: "budget" | "enum" | "zombie" | "io" };
  /** Present whenever THIS generation may be missing sessions — i.e. unless every file enumerated so far AND
   *  every file of every dir landed in one of {row, filtered, invalid, vanished}:
   *  `!enum.complete || skipped > 0 || enum.dirsSkipped > 0 || changed > 0 || enum.dirsTruncated || enum.filesTruncated`.
   *  Retry = a NEW generation (refresh without cursor after HISTORY_GEN_REUSE_MS, or after the gen expires).
   *  Items of a page are sorted (mtimeMs desc, key asc) per page (PD23); while `!enum.complete` the ORDER ACROSS
   *  pages is approximate. */
  incomplete?: true;
  liveness?: "partial" | "no-proc";
  stats: {
    files: number; // enumerated so far in this generation
    indexed: number;
    invalid?: number; // header-less files consumed in this generation (cumulative)
    vanished?: number; // ENOENT at open, consumed in this generation (cumulative)
    skipped?: number; // files given up after HISTORY_IO_RETRY_MAX CONSECUTIVE failures (enumeration lstat + paging reads), cumulative
    changed?: number; // files whose directory's dev/ino no longer matches the pinned one (dir replaced/symlinked) — never followed
    enum: HistoryEnumStats;
  };
}

export interface SessionRefWire {
  key: string;
  id: string;
  mode?: "resume" | "fork";
}

export interface HistoryQueryWire {
  q?: string;
  kind?: "main" | "all";
  cursor?: string;
  limit?: number;
}

export type SessionSpawnRejectReason =
  | "session-ref" // 400 E_BAD_REQUEST
  | "model-with-session" // 400 E_BAD_REQUEST
  | "session-missing" // 400 E_DIR
  | "session-mismatch" // 400 E_DIR
  | "session-invalid" // 400 E_DIR (incl. nlink !== 1, non-regular, symlink level)
  | "session-too-large" // 400 E_DIR (fork snapshot cap)
  | "moved" // 400 E_DIR
  | "session-changed"; // 409 E_DIR (sync re-verify failed)

// ---------------------------------------------------------------------------
// pure validators (the module's only runtime; TextEncoder is a language global,
// present in both Node ≥ 11 and every browser — this file stays node:*-free)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** `v1.<genId>.<pos>` — genId half (§4.5.3: base64url(8 random bytes) is always 11 chars). */
const HISTORY_GEN_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** The whole opaque cursor: `v1.` + 11-char genId + `.` + 1..6 decimal digits (≤ 999999). */
const HISTORY_CURSOR_RE = /^v1\.([A-Za-z0-9_-]{11})\.([0-9]{1,6})$/;

/** `<dir>/<file>`: exactly one `/`; each segment 1..255 chars, no NUL/CR/LF, not "."/".."; file ends with
 * ".jsonl" and is longer than it; whole key ≤ SESSION_KEY_MAX_BYTES UTF-8. Never throws. */
export function isValidSessionKey(s: string): boolean {
  const slash = s.indexOf("/");
  if (slash <= 0) return false; // no "/" at all, or a leading "/" (empty dir segment — absolute path)
  if (s.indexOf("/", slash + 1) !== -1) return false; // more than one "/"
  const dir = s.slice(0, slash);
  const file = s.slice(slash + 1);
  if (dir.length < 1 || dir.length > 255 || file.length < 1 || file.length > 255) return false;
  if (dir === "." || dir === ".." || file === "." || file === "..") return false;
  if (s.includes("\0") || s.includes("\r") || s.includes("\n")) return false;
  if (!file.endsWith(".jsonl") || file.length === ".jsonl".length) return false;
  return textEncoder.encode(s).length <= SESSION_KEY_MAX_BYTES;
}

/** `v1.<genId>.<pos>`: genId = /^[A-Za-z0-9_-]{11}$/, pos = decimal 0..999999. */
export function encodeHistoryCursor(genId: string, pos: number): string {
  // Trusted-caller producer (the hub's own gen ids always match); a violation here is a
  // programmer error, so it fails loudly instead of emitting a cursor decode would reject.
  if (!HISTORY_GEN_ID_RE.test(genId)) {
    throw new TypeError(`encodeHistoryCursor: genId must match ${HISTORY_GEN_ID_RE.source}`);
  }
  if (!Number.isInteger(pos) || pos < 0 || pos > 999_999) {
    throw new TypeError("encodeHistoryCursor: pos must be an integer in 0..999999");
  }
  return `v1.${genId}.${pos}`;
}

/** null on any shape violation (prefix, length > HISTORY_CURSOR_MAX_CHARS, genId/pos pattern). Never throws. */
export function decodeHistoryCursor(s: string): { genId: string; pos: number } | null {
  if (s.length > HISTORY_CURSOR_MAX_CHARS) return null;
  const m = HISTORY_CURSOR_RE.exec(s);
  if (m === null) return null;
  const [, genId, posStr] = m;
  if (genId === undefined || posStr === undefined) return null; // unreachable for this regex; keeps noUncheckedIndexedAccess honest
  const pos = Number(posStr);
  if (!Number.isSafeInteger(pos) || pos < 0 || pos > 999_999) return null;
  return { genId, pos };
}
