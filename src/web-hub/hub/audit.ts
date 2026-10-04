/**
 * hub control-plane audit logging (plan §6.4, U7/D18, C3): a single structured log line per
 * request/rejection/late-result, written through a whitelisted field set so a message body,
 * steer text, ask_user answer/other text, question text or command args — or any hash of them —
 * can never reach `hub.log` even by accident (U7 "审计不记正文，也不记正文哈希"; only *lengths*
 * (`textLen`/`argsLen`, UTF-8 bytes) and *counts* (`answered`) are recorded). `hub/http.ts` is the
 * only writer of "reject"-phase lines (CSRF/auth/rate-limit failures before any `CmdFrame` is even
 * built); `hub/commands.ts`'s router writes "request"/"late" lines for everything that reaches it.
 */
/** UploadStats is imported type-only: `uploads.ts` never imports this module (the store's audit
 * seam is the `deps.audit` callback), so there is no cycle. */
import type { UploadStats } from "./uploads.js";

// ---------------------------------------------------------------------------
// HTTP-layer upload metrics (plan §5.4 stats row, U3 P2-2)
// ---------------------------------------------------------------------------

/**
 * Counts the `/api/upload/*` rejects that happen BEFORE the store is ever called (CSRF / auth /
 * 429 bucket / 501 / capability gate / body errors) — the store only sees and counts requests
 * that reach it, so without this the §5.4 stats row would silently under-report rejects. One
 * instance per hub, shared by both listeners (`FrontendDeps.uploadMetrics`), merged into the
 * periodic stats row by `uploadStatsFields`.
 */
export interface UploadHttpMetrics {
  /** Record an HTTP-layer reject. `retryAfterS` feeds `maxRetryAfterS` (429s carry one). */
  reject(code: string, retryAfterS?: number): void;
  snapshot(): UploadHttpMetricsSnapshot;
}

export interface UploadHttpMetricsSnapshot {
  readonly rejectsByCode: Record<string, number>;
  readonly rateLimited: number;
  readonly maxRetryAfterS: number;
}

export function createUploadHttpMetrics(): UploadHttpMetrics {
  const rejectsByCode = new Map<string, number>();
  let rateLimited = 0;
  let maxRetryAfterS = 0;
  return {
    reject(code, retryAfterS) {
      rejectsByCode.set(code, (rejectsByCode.get(code) ?? 0) + 1);
      if (code === "E_RATE") {
        rateLimited++;
        if (typeof retryAfterS === "number") maxRetryAfterS = Math.max(maxRetryAfterS, retryAfterS);
      }
    },
    snapshot: () => ({ rejectsByCode: Object.fromEntries(rejectsByCode), rateLimited, maxRetryAfterS }),
  };
}

/** Field set of the periodic `upload stats` aggregate row (plan §5.4, written by hub.ts's 30-min
 * sweep tick). A pure function so the row's shape is unit-testable without driving a hub for
 * 30 minutes. `http` merges the HTTP-layer pre-store rejects (`FrontendDeps.uploadMetrics`) into
 * the store-side counters — `rejects` is keyed by error code, `rateLimited`/`maxRetryAfterS`
 * combine both layers. */
export function uploadStatsFields(s: UploadStats, http?: UploadHttpMetricsSnapshot): Record<string, unknown> {
  const rejects: Record<string, number> = { ...s.rejectsByCode };
  if (http !== undefined) {
    for (const [code, n] of Object.entries(http.rejectsByCode)) rejects[code] = (rejects[code] ?? 0) + n;
  }
  return {
    ready: s.ready,
    disabled: s.disabled,
    disabledReason: s.disabledReason,
    scanning: s.scanning,
    closing: s.closing,
    active: s.inflight,
    inflightBytes: s.inflightBytes,
    committedFiles: s.committedFiles,
    committedBytes: s.committedBytes,
    referencedFiles: s.referencedFiles,
    buckets: s.buckets,
    requests: s.counters.requests,
    rejects,
    rateLimited: s.counters.rateLimited + (http?.rateLimited ?? 0),
    maxRetryAfterS: Math.max(s.counters.maxRetryAfterS, http?.maxRetryAfterS ?? 0),
    timeouts: s.counters.timeouts,
    poisoned: s.counters.poisoned,
    evicted: s.counters.evicted,
    dedupHits: s.counters.dedupHits,
    lateOps: s.counters.lateOps,
    p50Ms: s.p50Ms,
    p95Ms: s.p95Ms,
  };
}

export interface ControlAuditRecord {
  phase: "request" | "reject" | "late";
  reqId?: string;
  id?: string;
  op?: string;
  endpoint?: "cmd" | "dialog";
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  agentPid?: number;
  linkGen?: number;
  ok: boolean;
  code?: string | null;
  effect?: "none" | "unknown" | null;
  dup?: boolean;
  queryOnly?: boolean;
  ms?: number;
  /** UTF-8 byte length of the request's own free-text field (`prompt`/`steer_subagent`'s `text`);
   * never the text itself (U7). */
  textLen?: number | null;
  /** UTF-8 byte length of a `command` op's `args`; never `args` itself (U7). */
  argsLen?: number | null;
  deliver?: string | null;
  runId?: string | null;
  dialogId?: string | null;
  /** Answer *count*, never the answer text/labels (U7). */
  answered?: number | null;
  name?: string | null;
  kind?: string | null;
  confirmed?: boolean | null;
  sessionChanged?: boolean;
  /** v2.1 §4.9/§6.4: command-output size, never its content. */
  outputLen?: number | null;
  outputEntries?: number | null;
}

export function auditControl(log: { info(msg: string, data?: object): void }, record: ControlAuditRecord): void {
  log.info("control", { audit: "control", ...record });
}

export function auditAdmin(log: { info(msg: string, data?: object): void }, record: Record<string, unknown>): void {
  log.info("admin", { audit: "admin", ...record });
}

// ---------------------------------------------------------------------------
// web-hub-upload plan §5.4 (#11 #17, U3): upload audit channel
// ---------------------------------------------------------------------------

/**
 * Upload audit record (plan §5.4). NEVER carries the original filename, `safeName`, `sha256`,
 * file content or prompt text (same U7 discipline as `ControlAuditRecord`): `ext` is the
 * sanitized extension (≤16 ASCII), `mimeClass` only the type half before `/`. `principal` is an
 * U3 addition to the plan's field table (plan-author approved): the store-side audit seam
 * (`uploads.ts`'s `UploadAuditEvent`) knows only the `${listener}:${user ?? "token"}` principal
 * string, never reqId/listener/ip/user — HTTP-layer reject lines (`upload-http.ts`) carry those
 * instead. Either way, `auditUpload` picks whitelisted keys at runtime, so a future field added
 * to a call site by mistake (e.g. `name`) is dropped here rather than landing in `hub.log`.
 */
export interface UploadAuditRecord {
  phase: "request" | "reject" | "evict" | "recover";
  op: "begin" | "chunk" | "commit" | "abort" | "reference" | "sweep";
  reqId?: string | undefined;
  listener?: "loopback" | "lan" | undefined;
  ip?: string | undefined;
  user?: string | undefined;
  /** Store-side principal (`${listener}:${user ?? "token"}`) — the only subject identity the
   * store itself knows (plan-author-approved addition to the §5.4 table). */
  principal?: string | undefined;
  agentKey?: string | undefined;
  uploadId?: string | undefined;
  bucket?: string | undefined;
  ok: boolean;
  code?: string | null | undefined;
  ms?: number | undefined;
  /** begin: declared size; commit/evict: actual file size. */
  bytes?: number | undefined;
  /** Bytes already received when a reject/poison happened. */
  received?: number | undefined;
  chunks?: number | undefined;
  dupChunks?: number | undefined;
  dedup?: boolean | undefined;
  ext?: string | null | undefined;
  mimeClass?: string | null | undefined;
  mimeDropped?: boolean | undefined;
  referenced?: boolean | undefined;
  ageS?: number | undefined;
  reason?:
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
    | null
    | undefined;
  /** v3 #4: the non-atomic-commit fallback was deleted; the field stays as a `null` placeholder
   * so the schema never needs to change shape again. */
  note?: null | undefined;
  retryAfterS?: number | undefined;
}

/** Runtime whitelist for `auditUpload` — anything not listed here is dropped, even if passed. */
export const UPLOAD_AUDIT_KEYS = [
  "phase",
  "op",
  "reqId",
  "listener",
  "ip",
  "user",
  "principal",
  "agentKey",
  "uploadId",
  "bucket",
  "ok",
  "code",
  "ms",
  "bytes",
  "received",
  "chunks",
  "dupChunks",
  "dedup",
  "ext",
  "mimeClass",
  "mimeDropped",
  "referenced",
  "ageS",
  "reason",
  "note",
  "retryAfterS",
] as const;

/** `log.info("upload", { audit: "upload", ...pick(record, UPLOAD_AUDIT_KEYS) })` (plan §5.4). */
export function auditUpload(log: { info(msg: string, data?: object): void }, record: UploadAuditRecord): void {
  const out: Record<string, unknown> = { audit: "upload" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of UPLOAD_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("upload", out);
}
