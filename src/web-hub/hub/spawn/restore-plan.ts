/**
 * web-hub-spawn-restore plan v1 §6.4/§6.5 (RS5): the PURE decision half of spawn restore —
 * no pi import, no side effect, no clock read, no `/proc` access. The supervisor feeds it a
 * persisted record plus the boot context and acts on the verdict.
 *
 *   - `classifyForRestore(stored, ctx)` — §6.4's boot table for ONE non-terminal record that
 *     already survived the `bootChanged` and `removeIntent` rows (the supervisor runs those
 *     first; they always win). Verdicts:
 *       `legacy`    — not a restore candidate at all: the pre-restore recovery path, untouched.
 *       `skip`      — WAS a candidate but a §6.4 filter failed: pre-restore recovery path +
 *                     `restore.failure` annotation (`lifetime` / `exhausted` / `prev-unknown`).
 *       `scan`      — `starting{restore.phase:"forking"}` (a crash between the fork intent and
 *                     the identity write): environ scan with `forkIntentAt - 1s` as the lower
 *                     bound (§7 L1 — the spawnId is reused, `createdAt` would be too wide).
 *   - `restoreWireOf(restore)` — §9.2's Public projection of the restore slice (both projections
 *     share it: `project.ts` and the supervisor's own `publicItem`).
 *       `candidate` — rewrite to `starting{reaping}` and hand to a restore job.
 *   - `planSessionArgv(rec, fs, uid)` — §6.5 step 2 / D7: the session coordinate preflight that
 *     decides the argv tail (`--session <file>` / `--session-id <id>`) or a failure.
 *
 * Zero-`as` module (`hub/spawn/**` contract, `tests/web-hub/hub/spawn/source-scan.test.ts`).
 */
import {
  RESTORE_MAX_ATTEMPTS,
  RESTORE_MIN_LIFETIME_MS,
  RESTORE_SESSION_ID_RE,
  type RestoreFailure,
} from "../../protocol/spawn.js";
import type { SpawnRestoreWire } from "../../protocol/spawn.js";
import type { StoredRecord, StoredRestore } from "./store.js";

/** §9.2: the wire slice — every field explicit (no spread), all principals may see it. */
export function restoreWireOf(r: StoredRestore | undefined): SpawnRestoreWire | undefined {
  if (r === undefined) return undefined;
  const out: SpawnRestoreWire = { attempt: r.attempts };
  if (r.phase !== undefined) out.phase = r.phase;
  if (r.failure !== undefined) out.failure = r.failure;
  if (r.prevAgentKey !== undefined) out.prevAgentKey = r.prevAgentKey;
  if (r.restoredAt !== undefined) out.restoredAt = r.restoredAt;
  return out;
}

/** §9.1: while reaping, `pid`/`exit` still describe the OLD process — never projected. */
export function hidesIdentityOnWire(r: StoredRestore | undefined): boolean {
  return r?.phase === "reaping";
}

/** Bytes read from a session file's start to find its header line (same probe as dirs.ts). */
export const RESTORE_SESSION_HEAD_BYTES = 4 * 1024;

export interface RestoreClassifyContext {
  /** `cfg.restore === true` (D18: hub-side absent ⇒ false). */
  restoreOn: boolean;
  /** The one-shot `restore.veto` file was present at this boot (D13). */
  vetoed: boolean;
  /** Current time (ms). */
  now: number;
  /** `cfg.maxLifetimeMinutes * 60_000` — the createdAt-anchored lifetime (D14). */
  maxLifetimeMs: number;
}

export type RestoreClassification =
  | { kind: "legacy" }
  | { kind: "skip"; failure: RestoreFailure }
  | { kind: "scan"; forkIntentAt: number }
  | { kind: "candidate" };

function hasFullIdentity(r: StoredRecord): boolean {
  return r.pid !== undefined && r.procStartTicks !== undefined && r.bootId !== undefined && r.uid !== undefined;
}

/** §1.2's candidate predicate minus the rows the caller already handled (bootChanged, removeIntent). */
export function isRestoreCandidateShape(r: StoredRecord): boolean {
  if (r.removeIntent === true) return false;
  if (r.sessionId === undefined || !RESTORE_SESSION_ID_RE.test(r.sessionId)) return false;
  if (r.state === "live") return true;
  if (r.state === "stopping") return r.restoreIntent === true;
  if (r.state === "starting") return r.restore?.phase !== undefined;
  return false;
}

/** §6.4 for one non-terminal record past the `bootChanged` / `removeIntent` rows. */
export function classifyForRestore(stored: StoredRecord, ctx: RestoreClassifyContext): RestoreClassification {
  if (!ctx.restoreOn || ctx.vetoed) return { kind: "legacy" };
  if (!isRestoreCandidateShape(stored)) return { kind: "legacy" };
  // D14: lifetime is anchored at the ORIGINAL createdAt — restores neither extend nor shorten it.
  if (stored.createdAt + ctx.maxLifetimeMs - ctx.now < RESTORE_MIN_LIFETIME_MS) {
    return { kind: "skip", failure: "lifetime" };
  }
  // D15: attempts counts restore forks already started (incremented before each fork).
  if ((stored.restore?.attempts ?? 0) >= RESTORE_MAX_ATTEMPTS) return { kind: "skip", failure: "exhausted" };
  if (stored.state === "starting" && stored.restore?.phase === "forking") {
    // No pid by construction: the fork intent landed, the identity write did not. The scan's lower
    // bound is the intent time (the scanner subtracts the same 1s slack the launching scan uses).
    return { kind: "scan", forkIntentAt: stored.restore.forkIntentAt ?? stored.restore.lastAt };
  }
  if (!hasFullIdentity(stored)) return { kind: "skip", failure: "prev-unknown" };
  return { kind: "candidate" };
}

// ---------------------------------------------------------------------------
// session coordinate preflight (§6.5 step 2, D7)
// ---------------------------------------------------------------------------

/** The sync fs seam the preflight needs (supervisor deps `sessionFs`, default node:fs). */
export interface RestoreSessionFs {
  lstatSync(p: string): { isFile(): boolean; isSymbolicLink(): boolean; uid: number };
  readHeadSync(p: string, maxBytes: number): string;
}

export interface RestoreSessionInput {
  sessionId: string | undefined;
  sessionFile?: string | undefined;
  sessionPersisted?: true | undefined;
  cwd: string;
}

export type SessionArgvPlan =
  { ok: true; tail: readonly string[] } | { ok: false; failure: "session-missing" | "session-invalid"; detail: string };

function errCodeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * D7: file known & present & valid ⇒ `["--session", file]` (absolute path — pi's id form can
 * prompt on stdio, F21); file absent and NEVER observed ⇒ `["--session-id", id]` (pi creates the
 * file lazily, F23); file absent but observed before ⇒ `session-missing` (the user deleted it —
 * never silently recreate it empty, F22); unknown file ⇒ `--session-id`.
 */
export function planSessionArgv(rec: RestoreSessionInput, fs: RestoreSessionFs, uid: number): SessionArgvPlan {
  const sessionId = rec.sessionId;
  if (sessionId === undefined || !RESTORE_SESSION_ID_RE.test(sessionId)) {
    return { ok: false, failure: "session-invalid", detail: "session id missing or malformed" };
  }
  const file = rec.sessionFile;
  if (file === undefined) return { ok: true, tail: ["--session-id", sessionId] };
  let st: { isFile(): boolean; isSymbolicLink(): boolean; uid: number };
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    const code = errCodeOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return rec.sessionPersisted === true
        ? { ok: false, failure: "session-missing", detail: "session file no longer exists" }
        : { ok: true, tail: ["--session-id", sessionId] };
    }
    return { ok: false, failure: "session-invalid", detail: `lstat failed: ${code ?? "unknown"}` };
  }
  if (st.isSymbolicLink()) return { ok: false, failure: "session-invalid", detail: "session file is a symlink" };
  if (!st.isFile()) return { ok: false, failure: "session-invalid", detail: "session file is not a regular file" };
  if (st.uid !== uid) return { ok: false, failure: "session-invalid", detail: "session file owner mismatch" };
  let head: string;
  try {
    head = fs.readHeadSync(file, RESTORE_SESSION_HEAD_BYTES);
  } catch (err) {
    return { ok: false, failure: "session-invalid", detail: `header unreadable: ${errCodeOf(err) ?? "unknown"}` };
  }
  const nl = head.indexOf("\n");
  const firstLine = nl < 0 ? head : head.slice(0, nl);
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return { ok: false, failure: "session-invalid", detail: "header is not JSON" };
  }
  if (!isPlainObject(header)) return { ok: false, failure: "session-invalid", detail: "header is not an object" };
  if (header["type"] !== "session") return { ok: false, failure: "session-invalid", detail: "header type mismatch" };
  if (header["id"] !== sessionId) return { ok: false, failure: "session-invalid", detail: "header id mismatch" };
  if (header["cwd"] !== rec.cwd) return { ok: false, failure: "session-invalid", detail: "header cwd mismatch" };
  return { ok: true, tail: ["--session", file] };
}
