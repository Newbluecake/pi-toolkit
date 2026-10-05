/**
 * web-hub upload storage — the `UploadStore` state machine (plan `docs/dev/web-hub-upload/plan.md`
 * §2.2/§2.4/§2.6, package U2).
 *
 * This module owns upload *policy*: request-idempotency, the begin/chunk/commit/abort lifecycle,
 * the three-level + principal-level quotas, content dedup (principal-scoped, §2.5), reference
 * pinning (v3 #8's synchronous in-memory protection + bounded persistence), TTL/quota eviction,
 * startup crash recovery (§2.2.4's state table) and close semantics (§2.6 #13). It NEVER imports
 * `node:fs` (enforced by `tests/web-hub/hub/upload-fs-guard.test.ts`) — every disk access goes
 * through `hub/upload-fs.ts`, wrapped in `trackedDeps()` so the poison machinery can observe when
 * the last in-flight raw fs promise for an upload has settled (§2.2.5). The same wrapper layer
 * carries the §2.6 #13 close gate: once `close()` has completed, a mutation initiated through —
 * or settling into — the wrapper becomes an observable no-op (counted in `stats().counters.lateOps`
 * and logged), surfaced to its caller as a deadline error so a late write can never produce a
 * success reply or a state change after close returned.
 *
 * Deadline discipline (§2.2.5): every public method takes an absolute `deadline`; every fs step
 * is bounded by `min(FS_STEP_CAP_MS, remaining)` inside `upload-fs.fsStep`. A step timeout moves
 * the upload to `poisoned` — it immediately stops accepting requests (404), its state is never
 * updated again, no success reply is ever produced, and its directory is deleted only after the
 * in-flight fs promises settle (bounded 30s). Late fs results therefore only ever land inside a
 * directory that is about to disappear.
 *
 * The audit seam is `deps.audit` (U3's `hub/audit.ts` implements the whitelist); this module
 * just calls it at the plan's §5.4 write points. All timers created anywhere in this module or
 * `upload-fs.ts` are unref'd (`hasRef() === false`).
 */

import { createHash, type Hash } from "node:crypto";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";
import { PrivateDirError } from "../protocol/paths.js";
import {
  bucketFor,
  normalizeMime,
  parseAttachmentBlock,
  parseUploadMeta,
  sanitizeUploadName,
  uploadDiskExt,
  UPLOAD_BUCKET_MAX_BYTES,
  UPLOAD_FILE_MAX_BYTES,
  UPLOAD_INFLIGHT_HUB,
  UPLOAD_INFLIGHT_PER_PRINCIPAL,
  UPLOAD_TOTAL_MAX_BYTES,
  type UploadMetaV1,
} from "../protocol/upload.js";
import {
  createUploadDir,
  defaultUploadFsDeps,
  ensureUploadDir,
  fsStep,
  isUploadFsDeadline,
  openFileNoFollow,
  probeHardlink,
  raceDeadlineUnref,
  syncDir,
  unrefDelay,
  UploadDirCreateError,
  UploadFsError,
  verifyDirChain,
  writeAllAt,
  FS_STEP_CAP_MS,
  META_TMP_FLAGS,
  PART_CREATE_FLAGS,
  PART_WRITE_FLAGS,
  PROBE_CAP_MS,
  TRUSTED_READ_FLAGS,
  type Deadline,
  type DirChain,
  type DirChainEntry,
  type FileStat,
  type ReadableUploadFileHandle,
  type UploadFileHandle,
  type UploadFsDeps,
} from "./upload-fs.js";

// ---------------------------------------------------------------------------
// §2.4 limits + §2.6 lifecycle constants
// ---------------------------------------------------------------------------

export interface UploadLimits {
  readonly fileMaxBytes: number;
  readonly bucketMaxBytes: number;
  readonly totalMaxBytes: number;
  readonly inflightPerPrincipal: number;
  readonly inflightHub: number;
  readonly idleTtlMs: number;
  readonly unreferencedTtlMs: number;
  readonly referencedTtlMs: number;
  readonly unreferencedEvictableAfterMs: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  fileMaxBytes: UPLOAD_FILE_MAX_BYTES,
  bucketMaxBytes: UPLOAD_BUCKET_MAX_BYTES,
  totalMaxBytes: UPLOAD_TOTAL_MAX_BYTES,
  inflightPerPrincipal: UPLOAD_INFLIGHT_PER_PRINCIPAL,
  inflightHub: UPLOAD_INFLIGHT_HUB,
  idleTtlMs: 10 * 60_000,
  unreferencedTtlMs: 24 * 3_600_000,
  referencedTtlMs: 7 * 24 * 3_600_000,
  unreferencedEvictableAfterMs: 3_600_000,
};

/** §2.2.4: total advisory budget of the startup scan (it keeps going past this in the background). */
export const UPLOAD_SCAN_TOTAL_MS = 10_000;
/** §2.2.5: how long a poisoned upload waits for in-flight fs promises before deleting anyway. */
export const UPLOAD_POISON_SETTLE_CAP_MS = 30_000;
/** §2.6 #13: close() waits at most this long for in-flight fs promises. */
export const UPLOAD_CLOSE_SETTLE_MS = 2_000;
/** §2.6 #13: close()'s total budget for removing un-committed directories. */
export const UPLOAD_CLOSE_RM_MS = 1_000;
/** Total budget of a single sweep() run. */
export const UPLOAD_SWEEP_BUDGET_MS = 10_000;
/** begin's E_BUSY hint (§2.2.4: `Retry-After: 2`). */
export const UPLOAD_BUSY_RETRY_AFTER_S = 2;
/** Bounded retention of dedup'd terminal commit results (idempotent commit retries). */
const FINISHED_MAX = 256;
/** §5.4 stats row: op-latency reservoir size (ring) backing `stats().p50Ms/p95Ms`. */
const LATENCY_RESERVOIR_MAX = 2_048;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export type UploadErrorCode =
  | "E_BAD_REQUEST"
  | "E_NOT_FOUND"
  | "E_UPLOAD_OFFSET"
  | "E_UPLOAD_DISABLED"
  | "E_UPLOAD_CONFLICT"
  | "E_UPLOAD_TOO_LARGE"
  | "E_RATE"
  | "E_DEADLINE"
  | "E_BUSY"
  | "E_HUB_RESTARTING"
  | "E_UPLOAD_QUOTA"
  | "E_INTERNAL";

export const UPLOAD_ERROR_STATUS: Record<UploadErrorCode, number> = {
  E_BAD_REQUEST: 400,
  E_NOT_FOUND: 404,
  E_UPLOAD_OFFSET: 409,
  E_UPLOAD_DISABLED: 409,
  E_UPLOAD_CONFLICT: 409,
  E_UPLOAD_TOO_LARGE: 413,
  E_RATE: 429,
  E_DEADLINE: 504,
  E_BUSY: 503,
  E_HUB_RESTARTING: 503,
  E_UPLOAD_QUOTA: 507,
  E_INTERNAL: 500,
};

export interface UploadErrorExtra {
  readonly received?: number | undefined;
  readonly retryAfterS?: number | undefined;
  readonly reason?: string | undefined;
  readonly earliestExpiryAt?: number | undefined;
}

/** Store-level failure carrying the HTTP-mappable code (U3 maps `status` + `extra` 1:1). */
export class UploadStoreError extends Error {
  readonly code: UploadErrorCode;
  readonly status: number;
  readonly extra: UploadErrorExtra;

  constructor(code: UploadErrorCode, message: string, extra: UploadErrorExtra = {}) {
    super(`web-hub upload: ${code}: ${message}`);
    this.code = code;
    this.status = UPLOAD_ERROR_STATUS[code];
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// §5.4 audit seam (canonical whitelist lives in U3's hub/audit.ts)
// ---------------------------------------------------------------------------

export type UploadAuditReason =
  | "ttl"
  | "quota"
  | "idle"
  | "deadline"
  | "close"
  | "orphan-part"
  | "anomaly"
  | "conflict"
  | "short-write"
  | "no-hardlink"
  | null;

export type UploadAuditOp = "begin" | "chunk" | "commit" | "abort" | "reference" | "sweep";

export interface UploadAuditEvent {
  phase: "request" | "reject" | "evict" | "recover";
  op: UploadAuditOp;
  ok: boolean;
  code?: string | undefined;
  uploadId?: string | undefined;
  bucket?: string | undefined;
  agentKey?: string | undefined;
  principal?: string | undefined;
  bytes?: number | undefined;
  received?: number | undefined;
  chunks?: number | undefined;
  dupChunks?: number | undefined;
  dedup?: boolean | undefined;
  ext?: string | null | undefined;
  mimeClass?: string | null | undefined;
  mimeDropped?: boolean | undefined;
  referenced?: boolean | undefined;
  ageS?: number | undefined;
  reason?: UploadAuditReason;
  ms?: number | undefined;
  retryAfterS?: number | undefined;
}

export type UploadAuditFn = (event: UploadAuditEvent) => void;

export interface UploadLog {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

// ---------------------------------------------------------------------------
// §6 U2 public shapes
// ---------------------------------------------------------------------------

export interface BeginParams {
  readonly principal: string;
  readonly agentKey: string;
  readonly sessionId?: string | undefined;
  readonly id: string;
  readonly name: unknown;
  readonly size: number;
  readonly mime?: string | undefined;
}

export interface BeginResult {
  readonly id: string;
  readonly received: number;
  readonly maxBytes: number;
}

export interface ChunkParams {
  readonly principal: string;
  readonly id: string;
  readonly offset: number;
  readonly bytes: Buffer;
}

export interface ChunkResult {
  readonly received: number;
  readonly dup?: true;
}

export interface CommitParams {
  readonly principal: string;
  readonly id: string;
}

export interface CommitResult {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly mime: string | null;
  readonly dedup?: true;
}

// -- web-hub-preview §4.2 (PV2b): read-only preview open ---------------------------------

export interface OpenForPreviewParams {
  readonly principal: string;
  readonly listener: "loopback" | "lan";
  readonly path: string;
  readonly agentKey: string;
  readonly sessionId: string;
}

/** §4.2's result-object contract — `openForPreview` never throws; the route layer maps `code`
 *  onto web-hub-preview §4.3's response matrix. */
export type OpenForPreviewResult =
  | {
      readonly ok: true;
      readonly fh: ReadableUploadFileHandle;
      readonly size: number;
      readonly uploadId: string;
      readonly sha256: string;
      readonly layout: "generated" | "legacy";
      /** Audit hint (§4.5): true iff the reader is not the uploader (U3 session-visible sharing). */
      readonly shared: boolean;
    }
  | { readonly ok: false; readonly code: "E_BUSY" | "E_NOT_FOUND" | "E_PREVIEW_CHANGED" | "E_DEADLINE" };

export interface PinToken {
  readonly ids: readonly string[];
}

export type PinResult =
  { readonly ok: true; readonly token: PinToken } | { readonly ok: false; readonly gone: readonly string[] };

export interface RecoverReport {
  completed: boolean;
  buckets: number;
  ids: number;
  committed: number;
  removed: number;
  anomalies: number;
  overran: boolean;
}

export interface SweepEviction {
  readonly id: string;
  readonly reason: "ttl" | "quota" | "idle";
  readonly bytes: number;
}

export interface SweepReport {
  readonly reason: "tick" | "quota";
  readonly evicted: readonly SweepEviction[];
  readonly errors: number;
}

export interface UploadStats {
  readonly ready: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly scanning: boolean;
  readonly closing: boolean;
  readonly inflight: number;
  readonly inflightBytes: number;
  readonly committedFiles: number;
  readonly committedBytes: number;
  readonly referencedFiles: number;
  readonly buckets: number;
  /** §5.4 stats row: reject counts keyed by error code (store-side rejects only — the HTTP
   * layer's pre-store rejects are merged in by `uploadStatsFields`). */
  readonly rejectsByCode: Record<string, number>;
  /** §5.4 stats row: op-latency percentiles (all begin/chunk/commit/abort completions, success
   * and failure), from a bounded reservoir; `null` before the first op. */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly counters: {
    readonly requests: number;
    readonly rejects: number;
    readonly poisoned: number;
    readonly evicted: number;
    readonly dedupHits: number;
    readonly timeouts: number;
    /** §5.4 stats row: store-side E_RATE reject count (in-flight admission caps). */
    readonly rateLimited: number;
    /** §5.4 stats row: largest Retry-After the store ever handed out (seconds). */
    readonly maxRetryAfterS: number;
    /** §2.6 #13: mutations dropped by the close gate (observable no-ops after `close()`). */
    readonly lateOps: number;
  };
}

export interface UploadStore {
  /** §2.2.4 startup scan — full, rebuilds every index; `begin` returns `E_BUSY` until done. */
  recover(): Promise<RecoverReport>;
  begin(p: BeginParams, deadline: Deadline): Promise<BeginResult>;
  chunk(p: ChunkParams, deadline: Deadline): Promise<ChunkResult>;
  commit(p: CommitParams, deadline: Deadline): Promise<CommitResult>;
  abort(p: CommitParams, deadline: Deadline): Promise<void>;
  /** v3 #8: synchronous in-memory pin — must run in a no-await region before forwarding a prompt. */
  pinForPrompt(p: { principal: string; text: string }): PinResult;
  /** v3 #8: synchronous settle — `referenced` sets `referencedAt` and marks meta dirty. */
  settlePins(token: PinToken, outcome: "referenced" | "released"): void;
  /** Bounded best-effort persistence of `referencedAt` (never blocks a success reply). */
  flushReferences(ids: readonly string[], deadline: Deadline): Promise<"ok" | "timeout" | "error">;
  sweep(reason: "tick" | "quota"): Promise<SweepReport>;
  stats(): UploadStats;
  inflight(): number;
  /** U3 (plan §5.1.2): the authoritative begin-time principal→agentKey binding for the commit
   * agent-recheck. Only an OPEN in-flight upload owned by `principal` returns its agentKey —
   * poisoned/committed/finished/unknown ids return `undefined` (their commit path needs no
   * recheck: 404 or an idempotent replay of an already-committed upload). Synchronous: safe to
   * call inside no-await regions. */
  agentKeyOf(principal: string, id: string): string | undefined;
  /** web-hub-preview §4.2 (PV2b): read-only preview open of a committed upload — exact byPath
   *  index hit + generated/legacy structural re-check + U3 session-visibility + `O_NOFOLLOW`
   *  open with dirChain/size re-verification. Never throws; never mutates indexes, counters,
   *  `referencedAt` or TTL (reading is not referencing). */
  openForPreview(
    p: OpenForPreviewParams,
    ctx: { deadline: Deadline; signal: AbortSignal },
  ): Promise<OpenForPreviewResult>;
  /** §2.6 #13: poison everything un-committed, remove their dirs, retain committed files. */
  close(): Promise<void>;
}

export interface UploadStoreDeps {
  /** Absolute uploads root (`~/.pi/agent/web-hub/uploads`). */
  readonly root: string;
  readonly now?: (() => number) | undefined;
  readonly log: UploadLog;
  readonly audit?: UploadAuditFn | undefined;
  readonly limits?: Partial<UploadLimits> | undefined;
  readonly fs?: Partial<UploadFsDeps> | undefined;
  /** Test-only seam (U3 race-case acceptance): invoked — and awaited — after a sweep has
   * selected a committed eviction candidate but BEFORE the per-id lock is taken, i.e. exactly the
   * window in which `pinForPrompt` and the lock-side recheck race (plan §2.6 v3 #8 case (c)).
   * Production wiring never passes it; when absent the call site is skipped entirely (zero
   * production overhead). */
  readonly onEvictCandidate?: ((id: string, reason: "ttl" | "quota") => void | Promise<void>) | undefined;
}

// ---------------------------------------------------------------------------
// implementation
// ---------------------------------------------------------------------------

/** Same shape as `hub/http.ts`'s `CMD_ID_RE` — the HTTP layer validates first; this re-checks. */
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const BUCKET_NAME_RE = /^[sa]-[A-Za-z0-9_-]{1,80}$/;
const META_TMP_RE = /^\.meta\.[0-9a-f]+\.tmp$/;
const ROOT_UNSAFE_RE = /[\x00-\x1F\x7F]/;

interface BaseRec {
  readonly id: string;
  readonly principal: string;
  readonly agentKey: string;
  readonly bucket: string;
  /** Canonical client-declared display name (`sanitizeUploadName`) — begin-idempotency
   *  comparison, dedup key, and the `meta.json` record. Never an fs path component. */
  readonly safeName: string;
  /** Generated on-disk file name (`<id>.<ext>` / bare `<id>`) — every fs path in this module
   *  (`.part`, final, scan) is built from this, never from the client's name. */
  readonly diskName: string;
  readonly size: number;
  readonly mime: string | null;
  readonly dirChain: DirChain;
  /** Raw fs promises currently outstanding for this upload (poison/close settle tracking). */
  readonly pending: Set<Promise<unknown>>;
}

interface InflightRec extends BaseRec {
  received: number;
  readonly hash: Hash;
  lastActivityAt: number;
  state: "open" | "poisoned";
  /** Set once a `.part` has been successfully created — a retried first chunk (after a
   *  truncate-back) must re-open WITHOUT `O_CREAT|O_EXCL` or it would EEXIST its own part. */
  partCreated: boolean;
  chunkCount: number;
  dupChunks: number;
}

interface CommittedRec extends BaseRec {
  readonly sha256: string;
  readonly path: string;
  readonly committedAt: number;
  referencedAt: number | null;
  metaDirty: boolean;
  pins: number;
  state: "committed" | "evicting";
  readonly result: CommitResult;
}

interface FinishedRec {
  readonly principal: string;
  readonly result: CommitResult;
  readonly at: number;
}

function errCodeOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function mimeClassOf(mime: string | null): string | null {
  return mime === null ? null : (mime.split("/")[0] ?? null);
}

/**
 * Generated on-disk file name: `<uploadId>[.<ext>]` with `ext` from `uploadDiskExt(rawName)`.
 * The id is unique per upload and its exclusive `<id>/` directory already rules out collisions,
 * so the attacker-controlled original name never reaches the filesystem (2026-10 rework; the id
 * is `[A-Za-z0-9_-]{16,64}` — no dots, so the generated name can never collide with `meta.json`
 * or a `.meta.*.tmp` either). `part` is RESERVED for the in-flight `<diskName>.part` suffix: a
 * final named `<id>.part` would match the startup scan's orphan filter and be swept, so such
 * uploads (and every name without a legal ext) land extension-less as the bare id.
 */
function diskNameFor(id: string, rawName: unknown): string {
  const ext = uploadDiskExt(rawName);
  return ext === undefined || ext === "part" ? id : `${id}.${ext}`;
}

/**
 * web-hub-preview §4.2 step 3's generated-name predicate (`^<id>(\.[A-Za-z0-9]{1,16})?$`),
 * done structurally: scanned `<id>` dir names come straight from `readdir` (attacker-shaped
 * strings), so the id is never interpolated into a RegExp.
 */
function isGeneratedDiskName(id: string, name: string): boolean {
  if (name === id) return true;
  if (!name.startsWith(`${id}.`)) return false;
  const ext = name.slice(id.length + 1);
  return /^[A-Za-z0-9]{1,16}$/.test(ext);
}

const pbKey = (principal: string, bucket: string): string => `${principal}|${bucket}`;
const dedupKey = (principal: string, bucket: string, sha256: string, safeName: string): string =>
  `${principal}|${bucket}|${sha256}|${safeName}`;

export function createUploadStore(deps: UploadStoreDeps): UploadStore {
  const fs: UploadFsDeps = { ...defaultUploadFsDeps(), ...(deps.fs ?? {}) };
  const now: () => number = deps.now !== undefined ? deps.now : fs.now;
  fs.now = now;
  const log = deps.log;
  const audit: UploadAuditFn = deps.audit ?? (() => undefined);
  const limits: UploadLimits = { ...DEFAULT_UPLOAD_LIMITS, ...(deps.limits ?? {}) };
  const root = deps.root;

  // -- lifecycle state ------------------------------------------------------
  type StoreState = "init" | "ready" | "disabled";
  let storeState: StoreState = "init";
  let disabledReason: string | null = null;
  let rootEntry: DirChainEntry | null = null;
  let rootResolved = "";
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  type ScanState = "idle" | "running" | "done";
  let scanState: ScanState = "idle";
  let scanPromise: Promise<RecoverReport> | null = null;

  // -- indexes --------------------------------------------------------------
  const inflight = new Map<string, InflightRec>();
  const committed = new Map<string, CommittedRec>();
  const finished = new Map<string, FinishedRec>();
  const byPath = new Map<string, string>();
  const dedup = new Map<string, string>();
  /** Per-id mutex tail — survives the inflight→committed transition of the same id. */
  const idLocks = new Map<string, Promise<unknown>>();
  const bucketBytes = new Map<string, number>();
  const bucketInflightBytes = new Map<string, number>();
  const pbBytes = new Map<string, number>();
  const pbInflightBytes = new Map<string, number>();
  let totalCommittedBytes = 0;
  let totalInflightBytes = 0;
  const counters = {
    requests: 0,
    rejects: 0,
    poisoned: 0,
    evicted: 0,
    dedupHits: 0,
    timeouts: 0,
    lateOps: 0,
    rateLimited: 0,
    maxRetryAfterS: 0,
  };
  /** §5.4 stats row: per-code reject counts + a bounded ring of op latencies (ms) for p50/p95. */
  const rejectsByCode = new Map<string, number>();
  const latencyMs: number[] = [];
  let latencyCursor = 0;

  function recordLatency(ms: number): void {
    if (latencyMs.length < LATENCY_RESERVOIR_MAX) {
      latencyMs.push(ms);
      return;
    }
    latencyMs[latencyCursor] = ms;
    latencyCursor = (latencyCursor + 1) % LATENCY_RESERVOIR_MAX;
  }

  function latencyPercentile(p: 50 | 95): number | null {
    if (latencyMs.length === 0) return null;
    const sorted = [...latencyMs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(((sorted.length - 1) * p) / 100))]!;
  }

  // -- §2.2.3 v3 #4 constructor-time probe ----------------------------------
  const initPromise: Promise<void> = (async () => {
    if (!root.startsWith("/") || ROOT_UNSAFE_RE.test(root)) {
      storeState = "disabled";
      disabledReason = "root-invalid";
      log.error("web-hub uploads disabled: root path invalid", { root });
      return;
    }
    try {
      const id = await ensureUploadDir(root, { create: true }, fs, { at: now() + FS_STEP_CAP_MS });
      rootEntry = { path: root, id };
      rootResolved = resolvePath(root);
    } catch (err) {
      storeState = "disabled";
      disabledReason = "root-invalid";
      log.error("web-hub uploads disabled: root unusable", { root, error: String(err) });
      return;
    }
    try {
      await probeHardlink(root, fs, { at: now() + PROBE_CAP_MS });
      storeState = "ready";
    } catch (err) {
      storeState = "disabled";
      disabledReason = "no-hardlink";
      log.error("web-hub uploads disabled: hardlink probe failed (no fallback — v3 #4)", {
        root,
        error: String(err),
      });
    }
  })();

  // -- small helpers ---------------------------------------------------------

  function bump(m: Map<string, number>, key: string, delta: number): void {
    const v = (m.get(key) ?? 0) + delta;
    if (v <= 0) m.delete(key);
    else m.set(key, v);
  }

  function noteRaw<T>(rec: BaseRec, p: Promise<T>): Promise<T> {
    rec.pending.add(p);
    void p.then(
      () => {
        rec.pending.delete(p);
      },
      () => {
        rec.pending.delete(p);
      },
    );
    return p;
  }

  /**
   * §2.6 #13 close gate. After `close()` completes, a mutation initiated through — or still
   * in-flight when the gate closed and only now settling into — the tracked wrapper layer is
   * dropped: counted (`lateOps`), logged, and surfaced as a §2.2.5 deadline error so the
   * caller's failure path runs instead of a success reply. The underlying bytes of an
   * already-initiated write may still land in the removed dir's unlinked inode (POSIX), but
   * the store never again observes them.
   */
  function gateMutation<T>(rec: BaseRec, op: string, raw: () => Promise<T>): Promise<T> {
    if (closed) return lateMutation(rec, op);
    const p = noteRaw(rec, raw());
    return p.then(
      (v) => (closed ? lateMutation(rec, op) : v),
      (err: unknown) => (closed ? lateMutation(rec, op, err) : Promise.reject(err)),
    );
  }

  function lateMutation(rec: BaseRec, op: string, cause?: unknown): Promise<never> {
    counters.lateOps++;
    log.warn("web-hub upload: fs mutation dropped — store closed", {
      uploadId: rec.id,
      op,
      ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }),
    });
    return Promise.reject(new UploadFsError("deadline", `fs ${op} dropped: store closed`));
  }

  function wrapHandle(rec: BaseRec, fh: UploadFileHandle): UploadFileHandle {
    return {
      write: (buffer, offset, length, position) =>
        gateMutation(rec, "write", () => fh.write(buffer, offset, length, position)),
      truncate: (len) => gateMutation(rec, "truncate", () => fh.truncate(len)),
      datasync: () => gateMutation(rec, "datasync", () => fh.datasync()),
      sync: () => gateMutation(rec, "sync", () => fh.sync()),
      stat: () => noteRaw(rec, fh.stat()),
      close: () => noteRaw(rec, fh.close()),
    };
  }

  /** Per-rec view of the fs deps: every raw promise is registered on `rec.pending`; mutations
   *  additionally pass the §2.6 #13 close gate (read-only ops and fd hygiene stay ungated). */
  function trackedDeps(rec: BaseRec): UploadFsDeps {
    const wrap =
      <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      (...args: A): Promise<unknown> =>
        noteRaw(rec, fn(...args));
    const mute =
      <A extends unknown[], R>(op: string, fn: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> =>
        gateMutation(rec, op, () => fn(...args));
    return {
      ...fs,
      lstat: wrap(fs.lstat) as UploadFsDeps["lstat"],
      mkdir: mute("mkdir", fs.mkdir) as UploadFsDeps["mkdir"],
      chmod: mute("chmod", fs.chmod) as UploadFsDeps["chmod"],
      readdir: wrap(fs.readdir) as UploadFsDeps["readdir"],
      link: mute("link", fs.link) as UploadFsDeps["link"],
      unlink: mute("unlink", fs.unlink) as UploadFsDeps["unlink"],
      rename: mute("rename", fs.rename) as UploadFsDeps["rename"],
      rm: mute("rm", fs.rm) as UploadFsDeps["rm"],
      readFile: wrap(fs.readFile) as UploadFsDeps["readFile"],
      open: (path: string, flags: number, mode?: number): Promise<UploadFileHandle> =>
        noteRaw(rec, fs.open(path, flags, mode)).then((fh) => wrapHandle(rec, fh)),
      randomBytes: fs.randomBytes,
      now: fs.now,
      getuid: fs.getuid,
    };
  }

  function enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = idLocks.get(id) ?? Promise.resolve();
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    idLocks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Run `body` under the id's lock, bounded by the request deadline (§2.2.5). If the deadline
   * lapses while still queued, the body is marked abandoned and no-ops when its turn arrives —
   * its caller already saw `E_DEADLINE` and late state changes must not happen.
   */
  async function runLocked<T>(id: string, deadline: Deadline, body: () => Promise<T>): Promise<T> {
    const remaining = deadline.at - now();
    if (remaining <= 0) throw new UploadStoreError("E_DEADLINE", "deadline expired before operation");
    let abandoned = false;
    const run = enqueue(id, () =>
      abandoned ? Promise.reject(new UploadStoreError("E_DEADLINE", "abandoned before start")) : body(),
    );
    try {
      return await raceDeadlineUnref(run, remaining);
    } catch (err) {
      if (isUploadFsDeadline(err)) {
        abandoned = true;
        throw new UploadStoreError("E_DEADLINE", "deadline expired while queued");
      }
      throw err;
    }
  }

  /** Lock + deadline without throwing on timeout (sweep/evict paths count an error instead). */
  async function runLockedQuiet<T>(id: string, deadline: Deadline, body: () => Promise<T>): Promise<T> {
    const remaining = deadline.at - now();
    if (remaining <= 0) throw new UploadFsError("deadline", "no budget");
    return raceDeadlineUnref(enqueue(id, body), remaining);
  }

  /** Waits for `rec.pending` to settle, bounded by `capMs`. Returns `false` when the cap was
   *  hit with promises still outstanding (callers log; §2.2.5 "超时只记日志"). */
  async function settleRec(rec: BaseRec, capMs: number): Promise<boolean> {
    if (rec.pending.size === 0) return true;
    const settled = Symbol("settled");
    const winner = await Promise.race([Promise.allSettled([...rec.pending]).then(() => settled), unrefDelay(capMs)]);
    return winner === settled;
  }

  async function bestEffortClose(fh: UploadFileHandle): Promise<void> {
    await raceDeadlineUnref(fh.close(), FS_STEP_CAP_MS).catch(() => undefined);
  }

  /** Cleanup-path failures are never swallowed silently — the warn classifies the cause
   *  (safe-delete failure / dir-chain change / deadline) so a missed cleanup is diagnosable. */
  function cleanupKindOf(err: unknown): "deadline" | "chain-mismatch" | "delete-failed" {
    if (isUploadFsDeadline(err)) return "deadline";
    if (err instanceof UploadFsError && err.reason === "chain-mismatch") return "chain-mismatch";
    return "delete-failed";
  }

  function warnCleanup(msg: string, err: unknown, data: object): void {
    log.warn(`${msg} (${cleanupKindOf(err)})`, { ...data, error: err instanceof Error ? err.message : String(err) });
  }

  /**
   * Remove an upload directory. `verifyChain:true` re-checks the recorded identity first — a
   * replaced directory is NEVER deleted by path (§2.2.1: deleting the wrong object is worse
   * than leaving litter behind for the next startup scan).
   */
  async function removeUploadDir(
    rec: BaseRec,
    tfs: UploadFsDeps,
    deadline: Deadline,
    opts: { verifyChain: boolean },
  ): Promise<boolean> {
    if (opts.verifyChain) {
      try {
        await verifyDirChain(rec.dirChain, tfs, deadline);
      } catch {
        log.error("web-hub upload: dir identity mismatch — refusing to delete by path", { uploadId: rec.id });
        return false;
      }
    }
    const dir = rec.dirChain[rec.dirChain.length - 1]!.path;
    await fsStep(() => tfs.rm(dir, { recursive: true, force: true }), deadline, tfs.now);
    return true;
  }

  function dropInflight(rec: InflightRec): void {
    if (inflight.get(rec.id) !== rec) return;
    inflight.delete(rec.id);
    bump(bucketInflightBytes, rec.bucket, -rec.size);
    bump(pbInflightBytes, pbKey(rec.principal, rec.bucket), -rec.size);
    totalInflightBytes -= rec.size;
  }

  function dropCommitted(rec: CommittedRec): void {
    if (committed.get(rec.id) !== rec) return;
    committed.delete(rec.id);
    byPath.delete(rec.path);
    for (const [k, v] of dedup) if (v === rec.id) dedup.delete(k);
    bump(bucketBytes, rec.bucket, -rec.size);
    bump(pbBytes, pbKey(rec.principal, rec.bucket), -rec.size);
    totalCommittedBytes -= rec.size;
  }

  function rememberFinished(rec: InflightRec, result: CommitResult): void {
    finished.set(rec.id, { principal: rec.principal, result, at: now() });
    while (finished.size > FINISHED_MAX) {
      const oldest = finished.keys().next().value;
      if (oldest === undefined) break;
      finished.delete(oldest);
    }
  }

  /**
   * §2.2.5 poison: the upload immediately leaves the accepted set (later chunk/commit ⇒ 404),
   * its state is frozen, and its directory is deleted only after in-flight fs promises settle
   * (bounded). `deleteDir:false` is the §2.2.1 chain-mismatch case — never delete by path.
   */
  function poisonInflight(
    rec: InflightRec,
    op: UploadAuditOp,
    reason: Extract<UploadAuditReason, "deadline" | "idle" | "close" | "anomaly" | "conflict" | "short-write">,
    deleteDir: boolean,
  ): void {
    if (rec.state === "poisoned") return;
    rec.state = "poisoned";
    counters.poisoned++;
    audit({
      phase: "evict",
      op,
      ok: false,
      reason,
      uploadId: rec.id,
      bucket: rec.bucket,
      bytes: rec.size,
      received: rec.received,
    });
    if (closing || closed) return; // close() removes everything itself
    const tfs = trackedDeps(rec);
    void (async () => {
      const settled = await settleRec(rec, UPLOAD_POISON_SETTLE_CAP_MS);
      if (!settled) {
        // §2.2.5: cap hit with fs promises still outstanding — log only, delete anyway;
        // a late write lands in a directory that is about to disappear
        log.warn("web-hub upload: poison settle cap hit — deleting with fs still in flight", { uploadId: rec.id });
      }
      try {
        await enqueue(rec.id, async () => {
          if (closing || closed) return;
          if (inflight.get(rec.id) !== rec || rec.state !== "poisoned") return; // stale poison
          const removed = await removeUploadDir(rec, tfs, { at: tfs.now() + FS_STEP_CAP_MS }, { verifyChain: true });
          if (removed) dropInflight(rec);
        });
      } catch (err) {
        log.error("web-hub upload: poison cleanup failed", { uploadId: rec.id, error: String(err) });
      }
    })();
  }

  function quotaFits(bucket: string, principal: string, addBytes: number): boolean {
    if ((bucketBytes.get(bucket) ?? 0) + (bucketInflightBytes.get(bucket) ?? 0) + addBytes > limits.bucketMaxBytes) {
      return false;
    }
    const key = pbKey(principal, bucket);
    if ((pbBytes.get(key) ?? 0) + (pbInflightBytes.get(key) ?? 0) + addBytes > limits.bucketMaxBytes) return false;
    return totalCommittedBytes + totalInflightBytes + addBytes <= limits.totalMaxBytes;
  }

  function underAllLimits(): boolean {
    for (const v of bucketBytes.values()) if (v > limits.bucketMaxBytes) return false;
    for (const v of bucketInflightBytes.values()) if (v > limits.bucketMaxBytes) return false;
    for (const v of pbBytes.values()) if (v > limits.bucketMaxBytes) return false;
    return totalCommittedBytes + totalInflightBytes <= limits.totalMaxBytes;
  }

  /** Evict quota-eligible files (§2.6): invalidated/idle in-flight first, then oldest >1h unreferenced. */
  async function quotaEvict(
    deadline: Deadline,
    bucket?: string,
    principal?: string,
    addBytes = 0,
  ): Promise<SweepEviction[]> {
    const out: SweepEviction[] = [];
    for (const rec of [...inflight.values()]) {
      if (rec.state === "open" && now() - rec.lastActivityAt >= limits.idleTtlMs) {
        if (await evictInflight(rec, "quota", deadline)) out.push({ id: rec.id, reason: "quota", bytes: rec.size });
      }
    }
    const candidates = [...committed.values()]
      .filter(
        (r) =>
          r.state === "committed" &&
          r.referencedAt === null &&
          r.pins === 0 &&
          now() - r.committedAt >= limits.unreferencedEvictableAfterMs,
      )
      .sort((a, b) => a.committedAt - b.committedAt);
    for (const cand of candidates) {
      const fitsNow =
        bucket !== undefined && principal !== undefined ? quotaFits(bucket, principal, addBytes) : underAllLimits();
      if (fitsNow) break;
      if (await evictCommitted(cand, "quota", deadline)) out.push({ id: cand.id, reason: "quota", bytes: cand.size });
    }
    return out;
  }

  async function enforceQuota(principal: string, bucket: string, addBytes: number, deadline: Deadline): Promise<void> {
    if (quotaFits(bucket, principal, addBytes)) return;
    await quotaEvict(deadline, bucket, principal, addBytes);
    if (quotaFits(bucket, principal, addBytes)) return;
    let earliest: number | undefined;
    for (const r of committed.values()) {
      if (r.referencedAt !== null) continue;
      const exp = r.committedAt + limits.unreferencedTtlMs;
      earliest = earliest === undefined ? exp : Math.min(earliest, exp);
    }
    throw new UploadStoreError(
      "E_UPLOAD_QUOTA",
      "upload quota exceeded and nothing eligible to evict",
      earliest === undefined ? {} : { earliestExpiryAt: earliest },
    );
  }

  /** Locked eviction of a committed file. The recheck + `evicting` set happen synchronously after
   *  lock acquisition — JS single-threading makes this non-interleavable with `pinForPrompt` (§2.6). */
  async function evictCommitted(rec: CommittedRec, reason: "ttl" | "quota", deadline: Deadline): Promise<boolean> {
    // Test-only seam (U3): fires in the exact window between candidate selection and the per-id
    // lock, so a test can land a `pinForPrompt` there and prove the in-lock recheck below is what
    // saves the file. Never passed by production wiring.
    if (deps.onEvictCandidate !== undefined) await deps.onEvictCandidate(rec.id, reason);
    return runLockedQuiet(rec.id, deadline, async () => {
      const live = committed.get(rec.id);
      if (live === undefined || live.state !== "committed") return false;
      if (live.pins > 0) return false; // pinned — sweep exemptions apply to both reasons
      if (reason === "quota") {
        if (live.referencedAt !== null) return false; // referenced files are never quota-evicted
        if (now() - live.committedAt < limits.unreferencedEvictableAfterMs) return false; // <1h not evictable
      } else {
        const expiry =
          live.referencedAt !== null
            ? live.referencedAt + limits.referencedTtlMs
            : live.committedAt + limits.unreferencedTtlMs;
        if (now() < expiry) return false;
      }
      live.state = "evicting";
      const tfs = trackedDeps(live);
      try {
        await removeUploadDir(live, tfs, deadline, { verifyChain: true });
      } catch (err) {
        live.state = "committed";
        log.error("web-hub upload sweep: removal failed", { uploadId: live.id, error: String(err) });
        throw err;
      }
      dropCommitted(live);
      counters.evicted++;
      audit({
        phase: "evict",
        op: "sweep",
        ok: true,
        reason,
        uploadId: live.id,
        bucket: live.bucket,
        bytes: live.size,
        referenced: live.referencedAt !== null,
        ageS: Math.round((now() - live.committedAt) / 1000),
      });
      return true;
    });
  }

  async function evictInflight(rec: InflightRec, reason: "idle" | "quota", deadline: Deadline): Promise<boolean> {
    return runLockedQuiet(rec.id, deadline, async () => {
      const live = inflight.get(rec.id);
      if (live === undefined || live.state !== "open") return false;
      if (now() - live.lastActivityAt < limits.idleTtlMs) return false;
      live.state = "poisoned";
      const tfs = trackedDeps(live);
      try {
        await removeUploadDir(live, tfs, deadline, { verifyChain: true });
      } catch (err) {
        live.state = "open";
        log.error("web-hub upload sweep: idle removal failed", { uploadId: live.id, error: String(err) });
        throw err;
      }
      counters.evicted++;
      audit({
        phase: "evict",
        op: "sweep",
        ok: true,
        reason,
        uploadId: live.id,
        bucket: live.bucket,
        bytes: live.size,
        received: live.received,
      });
      dropInflight(live);
      return true;
    });
  }

  function buildMeta(p: {
    id: string;
    principal: string;
    agentKey: string;
    bucket: string;
    safeName: string;
    diskName: string;
    size: number;
    mime: string | null;
    sha256: string;
    committedAt: number;
    referencedAt: number | null;
  }): UploadMetaV1 {
    return {
      v: 1,
      id: p.id,
      principal: p.principal,
      agentKey: p.agentKey,
      bucket: p.bucket,
      safeName: p.safeName,
      diskName: p.diskName,
      size: p.size,
      mime: p.mime,
      sha256: p.sha256,
      committedAt: p.committedAt,
      referencedAt: p.referencedAt,
    };
  }

  /** §2.2.3 step 4: `<id>/.meta.<rand>.tmp` → write → datasync → rename onto `meta.json`. */
  async function writeMetaAtomic(
    chain: DirChain,
    meta: UploadMetaV1,
    tfs: UploadFsDeps,
    deadline: Deadline,
  ): Promise<void> {
    const dir = chain[chain.length - 1]!.path;
    const tmp = `.meta.${tfs.randomBytes(6).toString("hex")}.tmp`;
    try {
      const fh = await openFileNoFollow(chain, tmp, META_TMP_FLAGS, 0o600, tfs, deadline);
      try {
        await writeAllAt(fh, Buffer.from(JSON.stringify(meta), "utf8"), 0, deadline, tfs);
        await fsStep(() => fh.datasync(), deadline, tfs.now);
      } finally {
        await bestEffortClose(fh);
      }
      await fsStep(() => tfs.rename(`${dir}/${tmp}`, `${dir}/meta.json`), deadline, tfs.now);
    } catch (err) {
      // §2.2.5: the tmp cleanup is itself a deadline-bounded fs step (was an unbounded raw
      // unlink that could outlive the request); a failure only leaves litter the next startup
      // scan reclaims (META_TMP_RE) — log it, never swallow it
      await fsStep(() => tfs.unlink(`${dir}/${tmp}`), deadline, tfs.now).catch((cleanupErr: unknown) =>
        warnCleanup("web-hub upload: meta tmp cleanup failed", cleanupErr, { dir }),
      );
      throw err;
    }
  }

  async function verifyCommittedFile(rec: CommittedRec, tfs: UploadFsDeps, deadline: Deadline): Promise<boolean> {
    try {
      const st = await fsStep(() => tfs.lstat(rec.path), deadline, tfs.now);
      return st.isFile() && !st.isSymbolicLink() && st.size === rec.size;
    } catch {
      return false;
    }
  }

  // -- request envelope ------------------------------------------------------

  async function guarded<T>(op: UploadAuditOp, fn: () => Promise<T>): Promise<T> {
    counters.requests++;
    const t0 = now();
    try {
      const result = await fn();
      recordLatency(now() - t0);
      return result;
    } catch (err) {
      recordLatency(now() - t0);
      counters.rejects++;
      const code = err instanceof UploadStoreError ? err.code : "E_INTERNAL";
      rejectsByCode.set(code, (rejectsByCode.get(code) ?? 0) + 1);
      if (code === "E_DEADLINE") counters.timeouts++;
      if (code === "E_RATE") {
        counters.rateLimited++;
        const ra = err instanceof UploadStoreError ? err.extra.retryAfterS : undefined;
        if (typeof ra === "number") counters.maxRetryAfterS = Math.max(counters.maxRetryAfterS, ra);
      }
      const base: UploadAuditEvent = { phase: "reject", op, ok: false, code, ms: now() - t0 };
      if (err instanceof UploadStoreError) {
        if (err.extra.received !== undefined) base.received = err.extra.received;
        if (err.extra.retryAfterS !== undefined) base.retryAfterS = err.extra.retryAfterS;
      }
      audit(base);
      throw err;
    }
  }

  // -- begin (§1.2/§2.4) -----------------------------------------------------

  async function begin(p: BeginParams, deadline: Deadline): Promise<BeginResult> {
    return guarded("begin", async () => {
      const t0 = now();
      await initPromise;
      if (closing || closed) throw new UploadStoreError("E_HUB_RESTARTING", "hub is closing");
      if (storeState === "disabled") {
        throw new UploadStoreError("E_UPLOAD_DISABLED", `uploads disabled: ${disabledReason}`, {
          reason: disabledReason ?? undefined,
        });
      }
      if (scanState !== "done") {
        throw new UploadStoreError("E_BUSY", "startup scan in progress", { retryAfterS: UPLOAD_BUSY_RETRY_AFTER_S });
      }
      if (typeof p.id !== "string" || !UPLOAD_ID_RE.test(p.id)) {
        throw new UploadStoreError("E_BAD_REQUEST", "bad upload id");
      }
      if (typeof p.principal !== "string" || p.principal.length === 0) {
        throw new UploadStoreError("E_BAD_REQUEST", "bad principal");
      }
      if (typeof p.agentKey !== "string" || p.agentKey.length === 0) {
        throw new UploadStoreError("E_BAD_REQUEST", "bad agentKey");
      }
      if (!Number.isInteger(p.size) || p.size < 0 || p.size > limits.fileMaxBytes) {
        throw new UploadStoreError("E_UPLOAD_TOO_LARGE", `size must be an integer in [0, ${limits.fileMaxBytes}]`);
      }
      const bucket = bucketFor({ sessionId: p.sessionId, agentKey: p.agentKey });
      const safeName = sanitizeUploadName(p.name);
      const diskName = diskNameFor(p.id, p.name);
      const mime = normalizeMime(p.mime) ?? null;
      const mimeDropped = p.mime !== undefined && mime === null;

      // idempotency / id reuse (§1.2/§2.5)
      const existing = inflight.get(p.id);
      if (existing !== undefined) {
        if (existing.principal !== p.principal) throw new UploadStoreError("E_NOT_FOUND", "no such upload");
        if (existing.state === "poisoned") throw new UploadStoreError("E_NOT_FOUND", "upload invalidated");
        // The name comparison deliberately stays on the SANITIZED ORIGINAL name (safeName), not
        // on the generated disk name: `name` remains a client-declared begin parameter (it feeds
        // the display name, the dedup key and the disk extension), while comparing generated
        // names would degenerate to an extension-only comparison (the id is already equal) and
        // silently accept a retry that declared a different name. sanitizeUploadName's NFC /
        // path-segment canonicalization keeps its pre-rework comparison meaning byte-for-byte.
        if (
          existing.agentKey === p.agentKey &&
          existing.bucket === bucket &&
          existing.safeName === safeName &&
          existing.size === p.size &&
          existing.mime === mime
        ) {
          return { id: existing.id, received: existing.received, maxBytes: limits.fileMaxBytes };
        }
        throw new UploadStoreError("E_UPLOAD_CONFLICT", "upload id already in use with different parameters");
      }
      const usedBy = committed.get(p.id) ?? finished.get(p.id);
      if (usedBy !== undefined) {
        const owner = committed.has(p.id) ? committed.get(p.id)!.principal : finished.get(p.id)!.principal;
        if (owner !== p.principal) throw new UploadStoreError("E_NOT_FOUND", "no such upload");
        throw new UploadStoreError("E_UPLOAD_CONFLICT", "upload id already committed (ids are not reused)");
      }

      // in-flight admission (§2.4)
      let openHub = 0;
      let openPrincipal = 0;
      for (const r of inflight.values()) {
        if (r.state !== "open") continue;
        openHub++;
        if (r.principal === p.principal) openPrincipal++;
      }
      if (openHub >= limits.inflightHub) {
        throw new UploadStoreError("E_RATE", "hub-wide in-flight upload limit reached", { retryAfterS: 1 });
      }
      if (openPrincipal >= limits.inflightPerPrincipal) {
        throw new UploadStoreError("E_RATE", "per-principal in-flight upload limit reached", { retryAfterS: 1 });
      }

      // quotas (§2.4/§2.6): evict eligible files first, still over ⇒ 507
      await enforceQuota(p.principal, bucket, p.size, deadline);

      // directories (§2.1) — bucket re-usable, id dir exclusive
      const bucketPath = `${root}/${bucket}`;
      let bucketEntry: DirChainEntry;
      try {
        bucketEntry = { path: bucketPath, id: await ensureUploadDir(bucketPath, { create: true }, fs, deadline) };
      } catch (err) {
        if (isUploadFsDeadline(err)) throw new UploadStoreError("E_DEADLINE", "begin exceeded deadline");
        if (err instanceof PrivateDirError) {
          throw new UploadStoreError("E_UPLOAD_DISABLED", `bucket dir unusable: ${err.reason}`, {
            reason: `bucket-${err.reason}`,
          });
        }
        throw err;
      }
      const idPath = `${bucketPath}/${p.id}`;
      let idEntry: DirChainEntry;
      try {
        idEntry = { path: idPath, id: await createUploadDir(idPath, fs, deadline) };
      } catch (err) {
        if (isUploadFsDeadline(err)) throw new UploadStoreError("E_DEADLINE", "begin exceeded deadline");
        if (err instanceof UploadDirCreateError) {
          // our own mkdir succeeded but validation failed — clean up our litter, then reject
          await fs
            .rm(idPath, { recursive: true, force: true })
            .catch((cleanupErr: unknown) =>
              warnCleanup("web-hub upload begin: invalid id-dir cleanup failed", cleanupErr, { uploadId: p.id }),
            );
          const cause = err.causeErr;
          const reason = cause instanceof PrivateDirError ? `id-${cause.reason}` : "id-invalid";
          throw new UploadStoreError("E_UPLOAD_DISABLED", `upload dir unusable: ${reason}`, { reason });
        }
        if (errCodeOf(err) === "EEXIST") {
          throw new UploadStoreError("E_UPLOAD_CONFLICT", "upload id already exists on disk");
        }
        throw err;
      }

      const rec: InflightRec = {
        id: p.id,
        principal: p.principal,
        agentKey: p.agentKey,
        bucket,
        safeName,
        diskName,
        size: p.size,
        mime,
        dirChain: [rootEntry!, bucketEntry, idEntry],
        received: 0,
        hash: createHash("sha256"),
        lastActivityAt: now(),
        state: "open",
        partCreated: false,
        chunkCount: 0,
        dupChunks: 0,
        pending: new Set(),
      };
      inflight.set(p.id, rec);
      bump(bucketInflightBytes, bucket, p.size);
      bump(pbInflightBytes, pbKey(p.principal, bucket), p.size);
      totalInflightBytes += p.size;

      audit({
        phase: "request",
        op: "begin",
        ok: true,
        uploadId: p.id,
        bucket,
        agentKey: p.agentKey,
        principal: p.principal,
        bytes: p.size,
        ext: uploadDiskExt(diskName),
        mimeClass: mimeClassOf(mime),
        ...(mimeDropped ? { mimeDropped: true } : {}),
        ms: now() - t0,
      });
      return { id: p.id, received: 0, maxBytes: limits.fileMaxBytes };
    });
  }

  // -- chunk (§2.2.2) --------------------------------------------------------

  async function chunk(p: ChunkParams, deadline: Deadline): Promise<ChunkResult> {
    return guarded("chunk", async () => {
      await initPromise;
      if (closing || closed) throw new UploadStoreError("E_HUB_RESTARTING", "hub is closing");
      const early = inflight.get(p.id);
      if (early === undefined || early.principal !== p.principal) {
        throw new UploadStoreError("E_NOT_FOUND", "no such upload");
      }
      if (early.state === "poisoned") throw new UploadStoreError("E_NOT_FOUND", "upload invalidated");
      if (!Buffer.isBuffer(p.bytes)) throw new UploadStoreError("E_BAD_REQUEST", "bytes must be a Buffer");
      if (!Number.isInteger(p.offset) || p.offset < 0) {
        throw new UploadStoreError("E_UPLOAD_OFFSET", "bad offset", { received: early.received });
      }
      return runLocked(p.id, deadline, () => chunkBody(p, deadline));
    });
  }

  async function chunkBody(p: ChunkParams, deadline: Deadline): Promise<ChunkResult> {
    const rec = inflight.get(p.id);
    if (rec === undefined || rec.principal !== p.principal || rec.state === "poisoned") {
      throw new UploadStoreError("E_NOT_FOUND", "no such upload");
    }
    const len = p.bytes.length;
    if (p.offset + len > rec.size) throw new UploadStoreError("E_UPLOAD_TOO_LARGE", "chunk exceeds declared size");
    // §2.5 idempotency: a retried, already-written chunk ⇒ dup:true
    if (p.offset + len === rec.received && p.offset <= rec.received) {
      rec.dupChunks++;
      return { received: rec.received, dup: true };
    }
    if (p.offset !== rec.received) {
      throw new UploadStoreError("E_UPLOAD_OFFSET", `offset ${p.offset} != received ${rec.received}`, {
        received: rec.received,
      });
    }

    const tfs = trackedDeps(rec);
    const partName = `${rec.diskName}.part`;
    // create only when no part exists yet — a truncate-back retry re-opens the same part
    const create = !rec.partCreated;
    let fh: UploadFileHandle;
    try {
      fh = await openFileNoFollow(
        rec.dirChain,
        partName,
        create ? PART_CREATE_FLAGS : PART_WRITE_FLAGS,
        create ? 0o600 : undefined,
        tfs,
        deadline,
      );
      rec.partCreated = true;
    } catch (err) {
      if (isUploadFsDeadline(err)) {
        poisonInflight(rec, "chunk", "deadline", true);
        throw new UploadStoreError("E_DEADLINE", "chunk open exceeded deadline");
      }
      if (err instanceof UploadFsError && err.reason === "chain-mismatch") {
        // §2.2.1: the directory was replaced — poison WITHOUT deleting by path
        poisonInflight(rec, "chunk", "anomaly", false);
        log.error("web-hub upload: dir chain mismatch during chunk — upload invalidated, dir not deleted", {
          uploadId: rec.id,
        });
        throw new UploadStoreError("E_INTERNAL", "upload directory identity mismatch");
      }
      // EEXIST (external .part), ELOOP (.part is a symlink), ENOENT (vanished) — 作废
      poisonInflight(rec, "chunk", "anomaly", true);
      throw new UploadStoreError("E_INTERNAL", `cannot open part file: ${errCodeOf(err) ?? String(err)}`);
    }

    try {
      await writeAllAt(fh, p.bytes, p.offset, deadline, tfs);
    } catch (err) {
      if (isUploadFsDeadline(err)) {
        await bestEffortClose(fh);
        poisonInflight(rec, "chunk", "deadline", true);
        throw new UploadStoreError("E_DEADLINE", "chunk write exceeded deadline");
      }
      // short write / raw error (§2.2.2 #6): truncate back to `received`, state stays unchanged
      try {
        await fsStep(() => fh.truncate(rec.received), deadline, tfs.now);
      } catch {
        await bestEffortClose(fh);
        poisonInflight(rec, "chunk", "short-write", true);
        throw new UploadStoreError("E_INTERNAL", "chunk failed and truncate-back failed — upload invalidated");
      }
      await bestEffortClose(fh);
      throw new UploadStoreError("E_INTERNAL", "chunk write failed; part truncated back to received", {
        received: rec.received,
      });
    }
    await bestEffortClose(fh);

    // only after the complete write: hash + received (§2.2.2)
    rec.hash.update(p.bytes);
    rec.received += len;
    rec.lastActivityAt = now();
    rec.chunkCount++;
    return { received: rec.received };
  }

  // -- commit (§2.2.3) -------------------------------------------------------

  async function commit(p: CommitParams, deadline: Deadline): Promise<CommitResult> {
    return guarded("commit", async () => {
      await initPromise;
      if (closing || closed) throw new UploadStoreError("E_HUB_RESTARTING", "hub is closing");
      const fin = finished.get(p.id);
      if (fin !== undefined) {
        if (fin.principal !== p.principal) throw new UploadStoreError("E_NOT_FOUND", "no such upload");
        return fin.result;
      }
      const com = committed.get(p.id);
      if (com !== undefined) {
        if (com.principal !== p.principal) throw new UploadStoreError("E_NOT_FOUND", "no such upload");
        if (com.state === "evicting") throw new UploadStoreError("E_NOT_FOUND", "upload invalidated");
        return com.result;
      }
      const rec = inflight.get(p.id);
      if (rec === undefined || rec.principal !== p.principal) {
        throw new UploadStoreError("E_NOT_FOUND", "no such upload");
      }
      if (rec.state === "poisoned") throw new UploadStoreError("E_NOT_FOUND", "upload invalidated");
      const t0 = now();
      return runLocked(p.id, deadline, () => commitBody(p, deadline, t0));
    });
  }

  async function commitBody(p: CommitParams, deadline: Deadline, t0: number): Promise<CommitResult> {
    const rec = inflight.get(p.id);
    if (rec === undefined || rec.principal !== p.principal || rec.state === "poisoned") {
      // a concurrent first commit may already have settled this id — idempotent result (v3 #4)
      const fin = finished.get(p.id);
      if (fin !== undefined && fin.principal === p.principal) return fin.result;
      const com = committed.get(p.id);
      if (com !== undefined && com.principal === p.principal) return com.result;
      throw new UploadStoreError("E_NOT_FOUND", "no such upload");
    }
    if (rec.received !== rec.size) {
      throw new UploadStoreError("E_UPLOAD_OFFSET", `received ${rec.received} != size ${rec.size}`, {
        received: rec.received,
      });
    }
    const tfs = trackedDeps(rec);
    const dir = rec.dirChain[rec.dirChain.length - 1]!.path;
    const partName = `${rec.diskName}.part`;
    const finalPath = `${dir}/${rec.diskName}`;
    if (!resolvePath(finalPath).startsWith(rootResolved + sep)) {
      // §2.3 line 7 — final defense; unreachable with our own names
      poisonInflight(rec, "commit", "anomaly", true);
      throw new UploadStoreError("E_INTERNAL", "final path escapes uploads root");
    }
    const onDeadline = (what: string): never => {
      poisonInflight(rec, "commit", "deadline", true);
      throw new UploadStoreError("E_DEADLINE", `commit ${what} exceeded deadline`);
    };

    // step 1 — datasync the .part (creating it empty for zero-size uploads)
    try {
      const fh = await openFileNoFollow(
        rec.dirChain,
        partName,
        !rec.partCreated ? PART_CREATE_FLAGS : PART_WRITE_FLAGS,
        !rec.partCreated ? 0o600 : undefined,
        tfs,
        deadline,
      );
      rec.partCreated = true;
      try {
        await fsStep(() => fh.datasync(), deadline, tfs.now);
      } finally {
        await bestEffortClose(fh);
      }
    } catch (err) {
      if (isUploadFsDeadline(err)) onDeadline("datasync");
      if (err instanceof UploadFsError && err.reason === "chain-mismatch") {
        poisonInflight(rec, "commit", "anomaly", false);
        log.error("web-hub upload: dir chain mismatch during commit — invalidated, dir not deleted", {
          uploadId: rec.id,
        });
        throw new UploadStoreError("E_INTERNAL", "upload directory identity mismatch");
      }
      poisonInflight(rec, "commit", "anomaly", true);
      throw new UploadStoreError("E_INTERNAL", `commit datasync failed: ${errCodeOf(err) ?? String(err)}`);
    }

    // step 2 — dedup (§2.5: principal-scoped, re-verified before reuse)
    const sha256 = rec.hash.digest("hex");
    const key = dedupKey(rec.principal, rec.bucket, sha256, rec.safeName);
    const oldId = dedup.get(key);
    if (oldId !== undefined) {
      const old = committed.get(oldId);
      if (
        old !== undefined &&
        old.principal === rec.principal &&
        old.state === "committed" &&
        (await verifyCommittedFile(old, tfs, deadline))
      ) {
        try {
          await removeUploadDir(rec, tfs, deadline, { verifyChain: true });
        } catch (err) {
          if (isUploadFsDeadline(err)) onDeadline("dedup-cleanup");
          throw err;
        }
        counters.dedupHits++;
        const result: CommitResult = { id: rec.id, path: old.path, size: old.size, mime: old.mime, dedup: true };
        dropInflight(rec);
        rememberFinished(rec, result);
        audit({
          phase: "request",
          op: "commit",
          ok: true,
          uploadId: rec.id,
          bucket: rec.bucket,
          bytes: rec.size,
          chunks: rec.chunkCount,
          dupChunks: rec.dupChunks,
          dedup: true,
          ext: uploadDiskExt(rec.diskName),
          mimeClass: mimeClassOf(rec.mime),
          ms: now() - t0,
        });
        return result;
      }
      dedup.delete(key); // stale entry — don't dedup, commit fresh
    }

    // step 3 — link(part, final) + unlink(part) (v3 #4: the ONLY final-creation path, never rename)
    try {
      await fsStep(() => tfs.link(`${dir}/${partName}`, finalPath), deadline, tfs.now);
    } catch (err) {
      const code = errCodeOf(err);
      if (code === "EEXIST") {
        log.error("web-hub upload commit: final already exists — external write into <id>/?", { uploadId: rec.id });
        await removeUploadDir(rec, tfs, deadline, { verifyChain: true }).catch((cleanupErr: unknown) =>
          warnCleanup("web-hub upload commit: conflict cleanup failed", cleanupErr, { uploadId: rec.id }),
        );
        dropInflight(rec);
        throw new UploadStoreError("E_UPLOAD_CONFLICT", "final file already exists");
      }
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV") {
        // v3 #4: no rename fallback — invalidate the upload and disable for THIS call's reply
        await removeUploadDir(rec, tfs, deadline, { verifyChain: true }).catch((cleanupErr: unknown) =>
          warnCleanup("web-hub upload commit: no-hardlink cleanup failed", cleanupErr, { uploadId: rec.id }),
        );
        dropInflight(rec);
        throw new UploadStoreError("E_UPLOAD_DISABLED", "filesystem does not support hard links", {
          reason: "no-hardlink",
        });
      }
      if (isUploadFsDeadline(err)) onDeadline("link");
      poisonInflight(rec, "commit", "anomaly", true);
      throw new UploadStoreError("E_INTERNAL", `commit link failed: ${code ?? String(err)}`);
    }
    try {
      await fsStep(() => tfs.unlink(`${dir}/${partName}`), deadline, tfs.now);
    } catch (err) {
      if (isUploadFsDeadline(err)) onDeadline("unlink");
      poisonInflight(rec, "commit", "anomaly", true);
      throw new UploadStoreError("E_INTERNAL", "commit unlink of part failed");
    }

    // step 4 — meta.json: the LAST durable step; written ⇒ committed form exists
    const committedAt = now();
    try {
      await writeMetaAtomic(
        rec.dirChain,
        buildMeta({
          id: rec.id,
          principal: rec.principal,
          agentKey: rec.agentKey,
          bucket: rec.bucket,
          safeName: rec.safeName,
          diskName: rec.diskName,
          size: rec.size,
          mime: rec.mime,
          sha256,
          committedAt,
          referencedAt: null,
        }),
        tfs,
        deadline,
      );
    } catch (err) {
      if (isUploadFsDeadline(err)) onDeadline("meta-write");
      poisonInflight(rec, "commit", "anomaly", true);
      throw new UploadStoreError("E_INTERNAL", "meta write failed");
    }

    // step 5 — dir fsync (advisory). The request deadline threads through (§2.2.5): an
    // ordinary fsync failure only warns, but a DEADLINE here means the request budget is
    // gone — poison instead of returning a success reply for an over-budget commit.
    try {
      await syncDir(dir, tfs, deadline);
    } catch (err) {
      if (isUploadFsDeadline(err)) onDeadline("dir-sync");
      log.warn("web-hub upload commit: dir fsync failed (ignored)", {
        uploadId: rec.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // step 6 — in-memory indexes
    const result: CommitResult = { id: rec.id, path: finalPath, size: rec.size, mime: rec.mime };
    const crec: CommittedRec = {
      id: rec.id,
      principal: rec.principal,
      agentKey: rec.agentKey,
      bucket: rec.bucket,
      safeName: rec.safeName,
      diskName: rec.diskName,
      size: rec.size,
      mime: rec.mime,
      dirChain: rec.dirChain,
      pending: rec.pending,
      sha256,
      path: finalPath,
      committedAt,
      referencedAt: null,
      metaDirty: false,
      pins: 0,
      state: "committed",
      result,
    };
    inflight.delete(rec.id);
    committed.set(rec.id, crec);
    byPath.set(finalPath, rec.id);
    dedup.set(key, rec.id);
    bump(bucketBytes, rec.bucket, rec.size);
    bump(pbBytes, pbKey(rec.principal, rec.bucket), rec.size);
    totalCommittedBytes += rec.size;
    bump(bucketInflightBytes, rec.bucket, -rec.size);
    bump(pbInflightBytes, pbKey(rec.principal, rec.bucket), -rec.size);
    totalInflightBytes -= rec.size;

    audit({
      phase: "request",
      op: "commit",
      ok: true,
      uploadId: rec.id,
      bucket: rec.bucket,
      bytes: rec.size,
      chunks: rec.chunkCount,
      dupChunks: rec.dupChunks,
      ext: uploadDiskExt(rec.diskName),
      mimeClass: mimeClassOf(rec.mime),
      ms: now() - t0,
    });
    return result;
  }

  // -- abort (§2.5/§2.6) -----------------------------------------------------

  async function abort(p: CommitParams, deadline: Deadline): Promise<void> {
    return guarded("abort", async () => {
      const t0 = now();
      await initPromise;
      if (closing || closed) throw new UploadStoreError("E_HUB_RESTARTING", "hub is closing");
      if (typeof p.id !== "string" || !UPLOAD_ID_RE.test(p.id)) {
        throw new UploadStoreError("E_BAD_REQUEST", "bad upload id");
      }
      const fin = finished.get(p.id);
      if (fin !== undefined) {
        if (fin.principal !== p.principal) throw new UploadStoreError("E_NOT_FOUND", "no such upload");
        finished.delete(p.id);
        audit({ phase: "request", op: "abort", ok: true, uploadId: p.id, ms: now() - t0 });
        return;
      }
      const com = committed.get(p.id);
      if (com !== undefined) {
        if (com.principal !== p.principal) throw new UploadStoreError("E_NOT_FOUND", "no such upload");
        await runLocked(p.id, deadline, async () => {
          const live = committed.get(p.id);
          if (live === undefined || live.principal !== p.principal) {
            throw new UploadStoreError("E_NOT_FOUND", "no such upload");
          }
          if (live.state === "evicting") throw new UploadStoreError("E_NOT_FOUND", "upload already being removed");
          live.state = "evicting";
          try {
            await removeUploadDir(live, trackedDeps(live), deadline, { verifyChain: true });
          } catch (err) {
            live.state = "committed";
            if (isUploadFsDeadline(err)) throw new UploadStoreError("E_DEADLINE", "abort exceeded deadline");
            throw err;
          }
          dropCommitted(live);
          audit({
            phase: "request",
            op: "abort",
            ok: true,
            uploadId: live.id,
            bucket: live.bucket,
            bytes: live.size,
            ms: now() - t0,
          });
        });
        return;
      }
      const rec = inflight.get(p.id);
      if (rec === undefined || rec.principal !== p.principal) {
        throw new UploadStoreError("E_NOT_FOUND", "no such upload");
      }
      await runLocked(p.id, deadline, async () => {
        const live = inflight.get(p.id);
        if (live === undefined || live.principal !== p.principal) {
          throw new UploadStoreError("E_NOT_FOUND", "no such upload");
        }
        live.state = "poisoned"; // subsequent ops 404 even if removal fails
        try {
          await removeUploadDir(live, trackedDeps(live), deadline, { verifyChain: true });
        } catch (err) {
          log.error("web-hub upload abort: removal failed — dir left for startup scan", {
            uploadId: live.id,
            error: String(err),
          });
          if (isUploadFsDeadline(err)) throw new UploadStoreError("E_DEADLINE", "abort exceeded deadline");
          throw err;
        }
        dropInflight(live);
        audit({
          phase: "request",
          op: "abort",
          ok: true,
          uploadId: live.id,
          bucket: live.bucket,
          bytes: live.size,
          received: live.received,
          ms: now() - t0,
        });
      });
    });
  }

  // -- v3 #8 reference pinning ------------------------------------------------

  function pinForPrompt(p: { principal: string; text: string }): PinResult {
    const items = parseAttachmentBlock(p.text) ?? [];
    const hits: CommittedRec[] = [];
    const gone: string[] = [];
    for (const item of items) {
      const id = byPath.get(item.path);
      if (id === undefined) continue; // unknown path — ignore (§2.6)
      const rec = committed.get(id);
      if (rec === undefined) continue;
      if (rec.principal !== p.principal) continue; // someone else's — ignore, no existence leak
      if (rec.state === "evicting") {
        gone.push(rec.id);
        continue;
      }
      if (!hits.includes(rec)) hits.push(rec);
    }
    if (gone.length > 0) return { ok: false, gone };
    for (const rec of hits) rec.pins += 1;
    return { ok: true, token: { ids: hits.map((r) => r.id) } };
  }

  function settlePins(token: PinToken, outcome: "referenced" | "released"): void {
    for (const id of token.ids) {
      const rec = committed.get(id);
      if (rec === undefined) continue;
      if (rec.pins > 0) rec.pins -= 1;
      if (outcome === "referenced" && rec.state !== "evicting") {
        rec.referencedAt = now();
        rec.metaDirty = true;
        audit({ phase: "request", op: "reference", ok: true, uploadId: rec.id, bucket: rec.bucket });
      }
    }
  }

  async function flushReferences(ids: readonly string[], deadline: Deadline): Promise<"ok" | "timeout" | "error"> {
    await initPromise;
    for (const id of ids) {
      const rec = committed.get(id);
      if (rec === undefined || !rec.metaDirty) continue; // clean/absent entries never need budget
      if (deadline.at - now() <= 0) return "timeout";
      try {
        await runLockedQuiet(id, deadline, async () => {
          const live = committed.get(id);
          if (live === undefined || !live.metaDirty || closing || closed) return;
          await writeMetaAtomic(
            live.dirChain,
            buildMeta({
              id: live.id,
              principal: live.principal,
              agentKey: live.agentKey,
              bucket: live.bucket,
              safeName: live.safeName,
              diskName: live.diskName,
              size: live.size,
              mime: live.mime,
              sha256: live.sha256,
              committedAt: live.committedAt,
              referencedAt: live.referencedAt,
            }),
            trackedDeps(live),
            deadline,
          );
          live.metaDirty = false;
        });
      } catch (err) {
        if (isUploadFsDeadline(err)) return "timeout";
        return "error";
      }
    }
    return "ok";
  }

  // -- sweep (§2.6) -----------------------------------------------------------

  async function sweep(reason: "tick" | "quota"): Promise<SweepReport> {
    await initPromise;
    if (closing || closed) return { reason, evicted: [], errors: 0 };
    const deadline: Deadline = { at: now() + UPLOAD_SWEEP_BUDGET_MS };
    const evicted: SweepEviction[] = [];
    let errors = 0;

    // every sweep retries dirty reference persistence first (§2.6)
    const dirty = [...committed.values()].filter((r) => r.metaDirty).map((r) => r.id);
    if (dirty.length > 0) await flushReferences(dirty, { at: now() + 1_000 });

    for (const rec of [...inflight.values()]) {
      if (rec.state === "open" && now() - rec.lastActivityAt >= limits.idleTtlMs) {
        try {
          if (await evictInflight(rec, "idle", deadline)) evicted.push({ id: rec.id, reason: "idle", bytes: rec.size });
        } catch {
          errors++;
        }
      }
    }
    if (reason === "tick") {
      for (const rec of [...committed.values()]) {
        const expiry =
          rec.referencedAt !== null
            ? rec.referencedAt + limits.referencedTtlMs
            : rec.committedAt + limits.unreferencedTtlMs;
        if (now() >= expiry && rec.pins === 0) {
          try {
            if (await evictCommitted(rec, "ttl", deadline))
              evicted.push({ id: rec.id, reason: "ttl", bytes: rec.size });
          } catch {
            errors++;
          }
        }
      }
    } else {
      try {
        evicted.push(...(await quotaEvict(deadline)));
      } catch {
        errors++;
      }
    }
    return { reason, evicted, errors };
  }

  // -- startup recovery (§2.2.4) ----------------------------------------------

  function recover(): Promise<RecoverReport> {
    if (scanPromise !== null) return scanPromise;
    scanState = "running";
    scanPromise = (async (): Promise<RecoverReport> => {
      await initPromise;
      const report: RecoverReport = {
        completed: true,
        buckets: 0,
        ids: 0,
        committed: 0,
        removed: 0,
        anomalies: 0,
        overran: false,
      };
      if (rootEntry === null || closing || closed) {
        scanState = "done";
        return report;
      }
      const start = now();
      const stepDl = (): Deadline => {
        const remaining = start + UPLOAD_SCAN_TOTAL_MS - now();
        if (remaining <= 0) {
          if (!report.overran) {
            report.overran = true;
            log.warn("web-hub upload scan overran its budget — continuing in background", {});
          }
          return { at: now() + FS_STEP_CAP_MS };
        }
        return { at: now() + Math.min(FS_STEP_CAP_MS, remaining) };
      };
      try {
        const names = await fsStep(() => fs.readdir(root), stepDl(), now);
        for (const name of names) {
          if (closing || closed) break;
          if (/^\.probe-/.test(name)) {
            await fsStep(() => fs.unlink(`${root}/${name}`), stepDl(), now).catch((err: unknown) =>
              warnCleanup("web-hub upload scan: probe litter cleanup failed", err, { name }),
            );
            continue;
          }
          if (!BUCKET_NAME_RE.test(name)) continue; // unknown entry — leave untouched
          report.buckets++;
          await scanBucket(name, report, stepDl);
        }
      } catch (err) {
        log.error("web-hub upload scan failed", { error: String(err) });
        report.completed = false;
      }
      scanState = "done";
      return report;
    })();
    return scanPromise;
  }

  async function scanBucket(bucket: string, report: RecoverReport, stepDl: () => Deadline): Promise<void> {
    const bucketPath = `${root}/${bucket}`;
    let bst: FileStat;
    try {
      bst = await fsStep(() => fs.lstat(bucketPath), stepDl(), now);
    } catch {
      report.anomalies++;
      return;
    }
    if (bst.isSymbolicLink() || !bst.isDirectory() || bst.uid !== fs.getuid()) {
      // §2.2.4 last row: tampered — do NOT follow, do NOT delete
      report.anomalies++;
      log.error("web-hub upload scan: bucket dir tampered — skipped, not deleted", { bucket });
      return;
    }
    const bucketEntry: DirChainEntry = { path: bucketPath, id: { dev: bst.dev, ino: bst.ino } };
    let ids: string[];
    try {
      ids = await fsStep(() => fs.readdir(bucketPath), stepDl(), now);
    } catch {
      report.anomalies++;
      return;
    }
    let kept = 0;
    for (const id of ids) {
      if (closing || closed) return;
      report.ids++;
      if (await scanId(bucket, bucketEntry, id, report, stepDl)) kept++;
    }
    if (kept === 0 && !closing && !closed) {
      // empty bucket ⇒ remove (§2.2.4 last row; not counted in `removed`, which tracks <id>/ dirs)
      try {
        const rest = await fsStep(() => fs.readdir(bucketPath), stepDl(), now);
        if (rest.length === 0) {
          await fsStep(() => fs.rm(bucketPath, { recursive: true, force: true }), stepDl(), now);
        }
      } catch (err) {
        warnCleanup("web-hub upload scan: empty bucket removal failed", err, { bucket });
      }
    }
  }

  async function scanId(
    bucket: string,
    bucketEntry: DirChainEntry,
    id: string,
    report: RecoverReport,
    stepDl: () => Deadline,
  ): Promise<boolean> {
    const idPath = `${bucketEntry.path}/${id}`;
    let ist: FileStat;
    try {
      ist = await fsStep(() => fs.lstat(idPath), stepDl(), now);
    } catch {
      report.anomalies++;
      return false;
    }
    if (ist.isSymbolicLink() || !ist.isDirectory() || ist.uid !== fs.getuid()) {
      report.anomalies++;
      log.error("web-hub upload scan: <id>/ dir tampered — skipped, not deleted", { uploadId: id });
      return false;
    }
    const idEntry: DirChainEntry = { path: idPath, id: { dev: ist.dev, ino: ist.ino } };
    const rmId = async (reason: Extract<UploadAuditReason, "orphan-part" | "anomaly">): Promise<void> => {
      await fsStep(() => fs.rm(idPath, { recursive: true, force: true }), stepDl(), now);
      report.removed++;
      audit({ phase: "recover", op: "sweep", ok: true, reason, uploadId: id, bucket });
    };
    /** A failed scan-time removal leaves litter for the NEXT startup scan — warn, never swallow. */
    const rmIdQuiet = async (reason: Extract<UploadAuditReason, "orphan-part" | "anomaly">): Promise<void> => {
      await rmId(reason).catch((err: unknown) =>
        warnCleanup("web-hub upload scan: <id>/ removal failed", err, { uploadId: id, bucket, reason }),
      );
    };
    let files: string[];
    try {
      files = await fsStep(() => fs.readdir(idPath), stepDl(), now);
    } catch (err) {
      report.anomalies++;
      log.error("web-hub upload scan: unreadable <id>/ — removing", { uploadId: id, error: String(err) });
      await rmIdQuiet("anomaly");
      return false;
    }
    const hasMeta = files.includes("meta.json");
    const parts = files.filter((f) => f.endsWith(".part"));
    const tmps = files.filter((f) => META_TMP_RE.test(f));
    if (!hasMeta) {
      // rows 1–3 + empty: never acked to the browser — delete
      await rmIdQuiet(files.length > 0 ? "orphan-part" : "anomaly");
      return false;
    }
    let meta: UploadMetaV1 | null = null;
    try {
      const text = await fsStep(() => fs.readFile(`${idPath}/meta.json`), stepDl(), now);
      const parsed = parseUploadMeta(JSON.parse(text));
      if (parsed.ok) meta = parsed.meta;
    } catch {
      meta = null;
    }
    if (meta === null) {
      report.anomalies++;
      await rmIdQuiet("anomaly");
      return false;
    }
    // Generated disk names: the committed file sits at `diskName` (`<id>.<ext>`); metas written
    // before the rework carry no `diskName` and their file sits under `safeName` (legacy layout —
    // still indexed unchanged). The dedup key below stays on `safeName` for both layouts.
    const diskName = meta.diskName ?? meta.safeName;
    if (meta.id !== id || meta.bucket !== bucket || !files.includes(diskName) || parts.length > 0) {
      report.anomalies++;
      await rmIdQuiet("anomaly");
      return false;
    }
    let fst: FileStat;
    try {
      fst = await fsStep(() => fs.lstat(`${idPath}/${diskName}`), stepDl(), now);
    } catch {
      report.anomalies++;
      await rmIdQuiet("anomaly");
      return false;
    }
    if (fst.isSymbolicLink() || !fst.isFile() || fst.size !== meta.size) {
      report.anomalies++;
      await rmIdQuiet("anomaly");
      return false;
    }
    // committed form (row 4) — a crashed flushReferences leaves stray tmp files; committed
    // stands, litter is cleaned
    for (const t of tmps) {
      await fsStep(() => fs.unlink(`${idPath}/${t}`), stepDl(), now).catch((err: unknown) =>
        warnCleanup("web-hub upload scan: meta tmp litter cleanup failed", err, { uploadId: id, name: t }),
      );
    }
    const finalPath = `${idPath}/${diskName}`;
    const rec: CommittedRec = {
      id: meta.id,
      principal: meta.principal,
      agentKey: meta.agentKey,
      bucket: meta.bucket,
      safeName: meta.safeName,
      diskName,
      size: meta.size,
      mime: meta.mime,
      dirChain: [rootEntry!, bucketEntry, idEntry],
      pending: new Set(),
      sha256: meta.sha256,
      path: finalPath,
      committedAt: meta.committedAt,
      referencedAt: meta.referencedAt,
      metaDirty: false,
      pins: 0,
      state: "committed",
      result: { id: meta.id, path: finalPath, size: meta.size, mime: meta.mime },
    };
    committed.set(meta.id, rec);
    byPath.set(finalPath, meta.id);
    dedup.set(dedupKey(meta.principal, meta.bucket, meta.sha256, meta.safeName), meta.id);
    bump(bucketBytes, meta.bucket, meta.size);
    bump(pbBytes, pbKey(meta.principal, meta.bucket), meta.size);
    totalCommittedBytes += meta.size;
    report.committed++;
    return true;
  }

  // -- stats / close ------------------------------------------------------------

  function stats(): UploadStats {
    let open = 0;
    for (const r of inflight.values()) if (r.state === "open") open++;
    let referenced = 0;
    for (const r of committed.values()) if (r.referencedAt !== null) referenced++;
    const buckets = new Set<string>([...bucketBytes.keys(), ...bucketInflightBytes.keys()]);
    return {
      ready: storeState === "ready",
      disabled: storeState === "disabled",
      disabledReason,
      scanning: scanState !== "done",
      closing: closing || closed,
      inflight: open,
      inflightBytes: totalInflightBytes,
      committedFiles: committed.size,
      committedBytes: totalCommittedBytes,
      referencedFiles: referenced,
      buckets: buckets.size,
      rejectsByCode: Object.fromEntries(rejectsByCode),
      p50Ms: latencyPercentile(50),
      p95Ms: latencyPercentile(95),
      counters: { ...counters },
    };
  }

  function inflightCount(): number {
    let open = 0;
    for (const r of inflight.values()) if (r.state === "open") open++;
    return open;
  }

  /** §5.1.2 (U3): the begin-time binding is the store's own record — nothing external can evict
   *  or lose it while the upload is open. */
  function agentKeyOf(principal: string, id: string): string | undefined {
    const rec = inflight.get(id);
    if (rec === undefined || rec.principal !== principal || rec.state !== "open") return undefined;
    return rec.agentKey;
  }

  // -- web-hub-preview §4.2 (PV2b): read-only preview open ------------------------

  /**
   * Read-only preview open of a committed upload (web-hub-preview plan §4.2). The route layer
   * has ALREADY confirmed (§3.1 ⑤) that `(agentKey, sessionId)` is a currently-visible session;
   * this adds the store's own checks: byPath exact-index hit, generated/legacy structural
   * re-check of the requested spelling, the U3 session-visibility rule, then an `O_NOFOLLOW`
   * open with dirChain identity + recorded-size re-verification. A failure never deletes
   * anything; a success never mutates an index or counter — reading is not referencing
   * (`referencedAt`/TTL untouched, §4.2 step 6).
   */
  async function openForPreview(
    p: OpenForPreviewParams,
    ctx: { deadline: Deadline; signal: AbortSignal },
  ): Promise<OpenForPreviewResult> {
    await initPromise;
    if (scanState !== "done") return { ok: false, code: "E_BUSY" };
    if (storeState === "disabled") return { ok: false, code: "E_NOT_FOUND" };
    if (closing || closed) return { ok: false, code: "E_BUSY" };
    const indexed = byPath.get(p.path);
    if (indexed === undefined) return { ok: false, code: "E_NOT_FOUND" };
    const rec = committed.get(indexed);
    if (rec === undefined || rec.state === "evicting") return { ok: false, code: "E_NOT_FOUND" };

    // Structural re-check (§4.2 step 3). Terminal state of the 2026-10 generated-name rework:
    // `CommittedRec.diskName` is ALWAYS set — a legacy record (a meta written before the
    // rework, no `diskName` field) carries `diskName === safeName` with its file at
    // `<id>/<safeName>`. Layout is therefore classified STRUCTURALLY from the open name —
    // "generated" iff it spells `<id>` or `<id>.<ext>` — and every other name falls to the
    // legacy branch, which still requires basename === safeName and parent dir === `<id>`.
    // (A legacy record whose safeName degenerates to exactly the generated form opens under
    // either branch — same file, same checks; only the reported label differs.) The original
    // client-declared name participates in matching ONLY through the legacy safeName rule.
    const generated = isGeneratedDiskName(rec.id, rec.diskName);
    const layout: "generated" | "legacy" = generated ? "generated" : "legacy";
    const openName = generated ? rec.diskName : rec.safeName;
    if (generated) {
      if (basename(p.path) !== rec.diskName) return { ok: false, code: "E_NOT_FOUND" };
    } else if (basename(p.path) !== rec.safeName || basename(dirname(p.path)) !== rec.id) {
      return { ok: false, code: "E_NOT_FOUND" };
    }

    // Visibility (§4.2 step 4, ruling U3): the owner always reads their own upload (even after
    // the session moved on); any authenticated principal reads uploads of the session the
    // request names — or of the agent's session-less `a-` bucket; loopback is the machine
    // owner. A denial is E_NOT_FOUND: never leak that a path exists for another session.
    const owner = rec.principal === p.principal;
    const sessionOk =
      rec.bucket === bucketFor({ sessionId: p.sessionId, agentKey: p.agentKey }) || rec.bucket === `a-${p.agentKey}`;
    if (!(p.listener === "loopback" || owner || sessionOk)) return { ok: false, code: "E_NOT_FOUND" };

    // Open + re-verify (§4.2 step 5): `O_NOFOLLOW` regular-file open, parent-chain identity
    // re-check, then the recorded-size re-check. Failures NEVER delete anything; a replaced
    // dir chain, a non-regular final or a symlink-swapped final are logged anomalies mapping
    // to E_PREVIEW_CHANGED (§4.3: 409).
    const attempt = async (): Promise<OpenForPreviewResult> => {
      let fh: UploadFileHandle;
      try {
        fh = await openFileNoFollow(rec.dirChain, openName, TRUSTED_READ_FLAGS, undefined, fs, ctx.deadline);
      } catch (err) {
        if (isUploadFsDeadline(err)) return { ok: false, code: "E_DEADLINE" };
        if (err instanceof UploadFsError && (err.reason === "chain-mismatch" || err.reason === "not-regular")) {
          log.error("web-hub upload preview: open re-check failed — nothing deleted", {
            uploadId: rec.id,
            reason: err.reason,
          });
          return { ok: false, code: "E_PREVIEW_CHANGED" };
        }
        const raw = errCodeOf(err);
        if (raw === "ELOOP") {
          log.error("web-hub upload preview: final replaced by symlink — refusing, nothing deleted", {
            uploadId: rec.id,
          });
          return { ok: false, code: "E_PREVIEW_CHANGED" };
        }
        if (raw === "EMFILE" || raw === "ENFILE" || raw === "EAGAIN") return { ok: false, code: "E_BUSY" };
        if (raw !== "ENOENT" && raw !== "ENOTDIR" && raw !== "EACCES" && raw !== "EPERM") {
          log.warn("web-hub upload preview: open failed unexpectedly", { uploadId: rec.id, code: raw ?? "unknown" });
        }
        return { ok: false, code: "E_NOT_FOUND" };
      }
      const readable = fh as ReadableUploadFileHandle;
      if (typeof readable.read !== "function") {
        // only reachable with injected non-standard fs deps — fail closed, never leak the fd
        await bestEffortClose(fh);
        log.error("web-hub upload preview: handle lacks read()", { uploadId: rec.id });
        return { ok: false, code: "E_NOT_FOUND" };
      }
      try {
        const st = await fsStep(() => fh.stat(), ctx.deadline, now);
        if (st.size !== rec.size) {
          await bestEffortClose(fh);
          return { ok: false, code: "E_PREVIEW_CHANGED" };
        }
      } catch (err) {
        await bestEffortClose(fh);
        if (isUploadFsDeadline(err)) return { ok: false, code: "E_DEADLINE" };
        log.warn("web-hub upload preview: size re-check failed", {
          uploadId: rec.id,
          code: errCodeOf(err) ?? "unknown",
        });
        return { ok: false, code: "E_NOT_FOUND" };
      }
      return {
        ok: true,
        fh: readable,
        size: rec.size,
        uploadId: rec.id,
        sha256: rec.sha256,
        layout,
        shared: !owner,
      };
    };

    if (ctx.signal.aborted) return { ok: false, code: "E_DEADLINE" };
    const opened = attempt();
    // §4.2 ctx.signal: a caller that stops waiting (client disconnect / hub close) must not
    // leak the fd its abandoned open eventually produces — the loser of this race late-closes.
    const lateClose = (): void => {
      void opened.then(
        (r) => {
          if (r.ok) void bestEffortClose(r.fh);
        },
        () => undefined,
      );
    };
    const aborted = new Promise<"aborted">((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const winner = await Promise.race([
      opened.then((r): { kind: "open"; r: OpenForPreviewResult } => ({ kind: "open", r })),
      aborted.then((): { kind: "abort" } => ({ kind: "abort" })),
    ]);
    if (winner.kind === "abort") {
      lateClose();
      return { ok: false, code: "E_DEADLINE" };
    }
    return winner.r;
  }

  function close(): Promise<void> {
    if (closePromise !== null) return closePromise;
    closing = true;
    closePromise = (async () => {
      await initPromise.catch(() => undefined);
      const recs = [...inflight.values()];
      for (const rec of recs) {
        if (rec.state === "open") {
          rec.state = "poisoned";
          counters.poisoned++;
        }
      }
      // §2.6 #13: wait for in-flight fs promises at most 2s — late writes only ever land
      // inside directories we are about to remove (POSIX unlink-while-open)
      await Promise.race([Promise.allSettled(recs.flatMap((r) => [...r.pending])), unrefDelay(UPLOAD_CLOSE_SETTLE_MS)]);
      await raceDeadlineUnref(
        (async () => {
          for (const rec of recs) {
            try {
              const removed = await removeUploadDir(
                rec,
                trackedDeps(rec),
                { at: now() + FS_STEP_CAP_MS },
                { verifyChain: true },
              );
              if (removed) dropInflight(rec);
              counters.evicted++;
              audit({
                phase: "evict",
                op: "sweep",
                ok: true,
                reason: "close",
                uploadId: rec.id,
                bucket: rec.bucket,
                bytes: rec.size,
                received: rec.received,
              });
            } catch (err) {
              log.error("web-hub uploads close: dir removal failed", { uploadId: rec.id, error: String(err) });
            }
          }
        })(),
        UPLOAD_CLOSE_RM_MS,
      ).catch((err: unknown) =>
        warnCleanup("web-hub uploads close: dir removal budget exhausted", err, { remaining: inflight.size }),
      );
      // committed files are RETAINED (§2.6); clear in-memory state
      inflight.clear();
      committed.clear();
      finished.clear();
      byPath.clear();
      dedup.clear();
      bucketBytes.clear();
      bucketInflightBytes.clear();
      pbBytes.clear();
      pbInflightBytes.clear();
      totalCommittedBytes = 0;
      totalInflightBytes = 0;
      closed = true;
    })();
    return closePromise;
  }

  return {
    recover,
    begin,
    chunk,
    commit,
    abort,
    pinForPrompt,
    settlePins,
    flushReferences,
    sweep,
    stats,
    inflight: inflightCount,
    agentKeyOf,
    openForPreview,
    close,
  };
}
