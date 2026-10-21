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
import type { SpawnAuditRecord } from "./spawn/supervisor.js";
import type { WtDiffFileKind, WtDiffStatus } from "../protocol/worktree-diff.js";

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

// ---------------------------------------------------------------------------
// web-hub-spawn plan §SP9 (arch v2 §6.6): spawn audit channel
// ---------------------------------------------------------------------------

/**
 * Spawn audit record (arch §6.6, verbatim). The SHAPE lives in `hub/spawn/supervisor.ts` (SP7
 * defined it next to every writer the supervisor already has — its `deps.audit` callback and the
 * first-prompt forwarder's own lines); SP9 re-exports it here so `auditSpawn`'s callers import
 * the audit channel, not the supervisor module. Type-only import: erased at runtime, so this
 * adds no module-graph edge (same pattern as `UploadStats` above).
 *
 * NEVER carries the first-prompt text, stderr content, the raw request `cwd` string (the
 * sanctioned exception is the RESOLVED realpath, for forensics) or extension dialog titles —
 * `SPAWN_AUDIT_KEYS` is the runtime whitelist that enforces this even if a call site passes
 * more (same discipline as `UPLOAD_AUDIT_KEYS`).
 */
export type { SpawnAuditRecord };

/** Runtime whitelist for `auditSpawn` — anything not listed here is dropped, even if passed. */
export const SPAWN_AUDIT_KEYS = [
  "phase",
  "endpoint",
  "reqId",
  "listener",
  "ip",
  "user",
  "spawnId",
  "cwd",
  "known",
  "confirmed",
  "dup",
  "pid",
  "state",
  "code",
  "endReason",
  "exitCode",
  "signal",
  "ms",
  "limit",
  "active",
  "max",
  "firstPrompt",
  "textLen",
  "attempts",
  "identity",
  "reaper",
  "model",
  "from",
  "to",
  // session-history plan §4.6.4: session-backed spawn/restore request+state lines (never
  // sessionId/sessionFile/key/title/search text — those never reach a `SpawnAuditRecord` at all).
  "session",
  "sessionLive",
  "sessionKind",
  "forkReason",
  "proofGap",
  // web-hub-spawn-restore plan §10.6 (never sessionId / sessionFile)
  "restore",
  "restoreFailure",
  "attempt",
  "reason",
  "detail",
] as const;

/** `log.info("spawn", { audit: "spawn", ...pick(record, SPAWN_AUDIT_KEYS) })` (arch §6.6). */
export function auditSpawn(log: { info(msg: string, data?: object): void }, record: SpawnAuditRecord): void {
  const out: Record<string, unknown> = { audit: "spawn" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of SPAWN_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("spawn", out);
}

// ---------------------------------------------------------------------------
// web-hub-preview plan v3 §4.5 (PV3): preview audit channel
// ---------------------------------------------------------------------------

/**
 * Preview audit record (plan v3 §4.5). NEVER carries the raw request path, any filename, the
 * original upload name, file content or any hash of them (same discipline as
 * `ControlAuditRecord`/`UploadAuditRecord`): `pathTag` is an HMAC-12 tag (per hub-process key)
 * purely for correlating one process's own lines, `ext` a sanitized ≤16-char extension, `bytes`
 * /`total` sizes only. `shared` is U3's audit hint — true iff an upload-class read was served to
 * someone other than the uploader. One line per request, written in §3.1 ⑩'s `finally`
 * (429 repeats are throttled by the routes to one line per `preview:${principal}` per 60s).
 */
export interface PreviewAuditRecord {
  /** `"request"` = a `GET /api/preview` pipeline run; `"probe"` = a `POST
   * /api/preview/probe` batch (2026-10-07 修订 — `total` carries the path count, never a
   * path). */
  phase: "request" | "probe";
  listener?: "loopback" | "lan" | undefined;
  ip?: string | undefined;
  user?: string | undefined;
  agentKey?: string | undefined;
  /** §3.1 ⑥ request class, computed LITERALLY (zero fs, dir-plan §2.2/C1): `upload` =
   * literally under the uploads root, `cwd` = literally under the session cwd, `abs` = any
   * other absolute path (U4's new class — statistics only, never an admission decision). */
  cls?: "upload" | "cwd" | "abs" | undefined;
  /** sniffed content kind of the admitted file (undefined before ⑧ decided); `"dir"` for a
   * dir-plan §3.5 (P1b) listing answer; `"download"` for a preview-download raw-byte answer
   * (no sniff ran — the kind IS the mode). */
  kind?: "text" | "image" | "dir" | "download" | undefined;
  ok: boolean;
  code?: string | undefined;
  reason?: string | undefined;
  verify?: "hashed" | "cached" | "joined" | undefined;
  /** U3: upload-class read served to a non-uploader (session-visible sharing). */
  shared?: boolean | undefined;
  /** streamed/served bytes (⑨). */
  bytes?: number | undefined;
  /** admitted file size (⑦). */
  total?: number | undefined;
  /** chunked-plan §3.3: the chunked-mode request's offset (0 for a first chunk) — a
   * statistics-only integer, present only on `chunk=1` requests. Never a path or name. */
  offset?: number | undefined;
  truncated?: boolean | undefined;
  ms?: number | undefined;
  ext?: string | undefined;
  /** HMAC-sha256(path)[0:12] under the routes instance's random key — never the path itself. */
  pathTag?: string | undefined;
}

/** Runtime whitelist for `auditPreview` — anything not listed here is dropped, even if passed. */
export const PREVIEW_AUDIT_KEYS = [
  "phase",
  "listener",
  "ip",
  "user",
  "agentKey",
  "cls",
  "kind",
  "ok",
  "code",
  "reason",
  "verify",
  "shared",
  "bytes",
  "total",
  "offset",
  "truncated",
  "ms",
  "ext",
  "pathTag",
] as const;

/** `log.info("preview", { audit: "preview", ...pick(record, PREVIEW_AUDIT_KEYS) })` (§4.5). */
export function auditPreview(log: { info(msg: string, data?: object): void }, record: PreviewAuditRecord): void {
  const out: Record<string, unknown> = { audit: "preview" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of PREVIEW_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("preview", out);
}

// ---------------------------------------------------------------------------
// web-hub-delete-session plan v2 §4.2: remove audit channel
// ---------------------------------------------------------------------------

/**
 * Remove audit record (plan v2 §4.2, A13: "每次请求一行 audit:'remove'"). ONE line per
 * `POST /api/agents/remove` request, written by `hub/agent-remove.ts` — a channel SEPARATE from
 * the supervisor's own `audit:"spawn"` `phase:"remove"` lines (those record the state-machine
 * transition that deletes/abandons a managed record; these record the HTTP-layer decision, which
 * may never reach the supervisor at all — e.g. an unmanaged offline card, or an early CSRF/
 * auth/rate reject). Never carries anything beyond identifiers/outcomes (same U7 discipline as
 * every other audit channel here).
 */
export interface RemoveAuditRecord {
  phase: "request" | "reject";
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  spawnId?: string;
  /** `"removed" | "pending" | "absent"` (§2.4's success outcomes) — a free string, not a union,
   * so a future outcome never needs a schema change here. */
  outcome?: string;
  code?: string;
  reason?: string;
}

/** Runtime whitelist for `auditRemove` — anything not listed here is dropped, even if passed. */
export const REMOVE_AUDIT_KEYS = [
  "phase",
  "listener",
  "ip",
  "user",
  "agentKey",
  "spawnId",
  "outcome",
  "code",
  "reason",
] as const;

/** `log.info("remove", { audit: "remove", ...pick(record, REMOVE_AUDIT_KEYS) })` (§4.2). */
export function auditRemove(log: { info(msg: string, data?: object): void }, record: RemoveAuditRecord): void {
  const out: Record<string, unknown> = { audit: "remove" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of REMOVE_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("remove", out);
}

// ---------------------------------------------------------------------------
// worktree-diff plan §2.9 (D3): the wtdiff audit channel
// ---------------------------------------------------------------------------

/**
 * worktree-diff audit record (plan §2.9, verbatim field set). NEVER carries `wt`/`path`/`orig`
 * verbatim, any driver name, branch name, oid, patch or content (same discipline as every other
 * channel here): `wtTag`/`pathTag` are HMAC-12 tags under the routes instance's per-process key,
 * `drivers` is only the neutralized COUNT, `files` only the visible entry count (denylist hits
 * never reach ANY field, D14). One line per request, written in §1.7 ⑬'s finally; the single
 * exception (I7) is 429, throttled by the routes to one line per `wtdiff:${principal}` per 60 s.
 */
export interface WtDiffAuditRecord {
  phase: "files" | "file";
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  ok: boolean;
  code?: string;
  reason?: string;
  status?: WtDiffStatus;
  kind?: WtDiffFileKind | "untracked";
  files?: number;
  truncated?: boolean;
  bytes?: number;
  ms?: number;
  ext?: string;
  /** HMAC-12(W) under the routes instance's random key — never the worktree path itself. */
  wtTag?: string;
  /** HMAC-12(W + "\\0" + rel) — never the repo-relative path itself. */
  pathTag?: string;
  /** true when this request joined another request's single-flight execution (§1.10). */
  joined?: boolean;
  /** true when the changeset came from the ≤5 s TTL cache (never: git output is never cached). */
  cached?: boolean;
  /** neutralized driver COUNT (never names, §2.9 永不记录驱动名). */
  drivers?: number;
}

/** Runtime whitelist for `auditWorktreeDiff` — anything not listed here is dropped, even if passed. */
export const WTDIFF_AUDIT_KEYS = [
  "phase",
  "listener",
  "ip",
  "user",
  "agentKey",
  "ok",
  "code",
  "reason",
  "status",
  "kind",
  "files",
  "truncated",
  "bytes",
  "ms",
  "ext",
  "wtTag",
  "pathTag",
  "joined",
  "cached",
  "drivers",
] as const;

/** `log.info("wtdiff", { audit: "wtdiff", ...pick(record, WTDIFF_AUDIT_KEYS) })` (§2.9). */
export function auditWorktreeDiff(log: { info(msg: string, data?: object): void }, record: WtDiffAuditRecord): void {
  const out: Record<string, unknown> = { audit: "wtdiff" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of WTDIFF_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("wtdiff", out);
}

// ---------------------------------------------------------------------------
// worktree-graph plan v2 §2.6 (P2): the wtgraph audit channel
// ---------------------------------------------------------------------------

/**
 * worktree-graph audit record (plan §2.6, verbatim field set: "phase, listener, ip, user,
 * agentKey, ok, code, reason, commits, refs, tips, complete, bytes, ms, joined, wtTag"). Same
 * discipline as `WtDiffAuditRecord` above — NEVER carries `wt` verbatim, any ref/branch name,
 * oid, subject, author or patch text: `wtTag` is an HMAC-12 tag under the routes instance's
 * per-process key, `commits`/`refs`/`tips` are only COUNTS. One line per request, written in
 * the route's finally; 429 is throttled to one line per `wtgraph:${principal}` per 60 s.
 */
export interface WtGraphAuditRecord {
  phase: "graph";
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  ok: boolean;
  code?: string;
  reason?: string;
  commits?: number;
  refs?: number;
  tips?: number;
  complete?: boolean;
  bytes?: number;
  ms?: number;
  /** true when this request joined another request's single-flight Gl execution (§2.5). */
  joined?: boolean;
  /** HMAC-12(W) under the routes instance's random key — never the worktree path itself. */
  wtTag?: string;
}

/** Runtime whitelist for `auditWorktreeGraph` — anything not listed here is dropped. */
export const WTGRAPH_AUDIT_KEYS = [
  "phase",
  "listener",
  "ip",
  "user",
  "agentKey",
  "ok",
  "code",
  "reason",
  "commits",
  "refs",
  "tips",
  "complete",
  "bytes",
  "ms",
  "joined",
  "wtTag",
] as const;

/** `log.info("wtgraph", { audit: "wtgraph", ...pick(record, WTGRAPH_AUDIT_KEYS) })` (§2.6). */
export function auditWorktreeGraph(log: { info(msg: string, data?: object): void }, record: WtGraphAuditRecord): void {
  const out: Record<string, unknown> = { audit: "wtgraph" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of WTGRAPH_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("wtgraph", out);
}

// ---------------------------------------------------------------------------
// web-hub-avatar plan v2.1 §2.7
// ---------------------------------------------------------------------------

export interface AvatarAuditRecord {
  reqId: string;
  op: "get" | "put" | "delete" | "load";
  phase: "request" | "reject" | "reconcile";
  ok: boolean;
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  code?: string;
  reason?: string;
  effect?: "none" | "unknown";
  io?: "deadline" | "busy" | "abort" | "errno";
  errno?: string;
  bytes?: number;
  side?: number;
  v?: string;
  gen?: number;
  dedup?: boolean;
  ms: number;
}

export const AVATAR_AUDIT_KEYS = [
  "reqId",
  "op",
  "phase",
  "ok",
  "listener",
  "ip",
  "user",
  "code",
  "reason",
  "effect",
  "io",
  "errno",
  "bytes",
  "side",
  "v",
  "gen",
  "dedup",
  "ms",
] as const;

export function auditAvatar(log: { info(msg: string, data?: object): void }, record: AvatarAuditRecord): void {
  const out: Record<string, unknown> = { audit: "avatar" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of AVATAR_AUDIT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (key === "errno" && (typeof value !== "string" || !/^E[A-Z0-9]{2,15}$/.test(value))) continue;
    if (typeof value === "string" && value.includes("/")) continue;
    out[key] = value;
  }
  log.info("avatar", out);
}

// ---------------------------------------------------------------------------
// web-hub-privacy plan v2.1 (P1): the privacy-lock audit channel
// ---------------------------------------------------------------------------

/**
 * Privacy audit record (plan「接口」审计条). ONE line per `/api/privacy/*` decision, written by
 * `hub/privacy/routes.ts`. `agentKey` rides plaintext per the existing convention (v2 评审 #10
 * 纠正了 v1 的「哈希级标识」). NEVER carries the password (not even a hash/length — the field
 * simply does not exist here) and NEVER the sessionId (same "never sessionId" discipline as
 * `SPAWN_AUDIT_KEYS`); `locked` is the boolean direction of a lock op.
 */
export interface PrivacyAuditRecord {
  phase: "request" | "reject";
  op: "verify" | "lock";
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  locked?: boolean;
  ok: boolean;
  code?: string;
  ms?: number;
}

/** Runtime whitelist for `auditPrivacy` — anything not listed here is dropped, even if passed. */
export const PRIVACY_AUDIT_KEYS = [
  "phase",
  "op",
  "listener",
  "ip",
  "user",
  "agentKey",
  "locked",
  "ok",
  "code",
  "ms",
] as const;

/** `log.info("privacy", { audit: "privacy", ...pick(record, PRIVACY_AUDIT_KEYS) })`. */
export function auditPrivacy(log: { info(msg: string, data?: object): void }, record: PrivacyAuditRecord): void {
  const out: Record<string, unknown> = { audit: "privacy" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of PRIVACY_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("privacy", out);
}

// LAN security r2 §8. Explicit runtime picks, including for untyped callers.
export interface ClientDenyAuditRecord {
  listener: "lan" | "proxy";
  ip: string;
  via: "peer" | "forwarded";
  reason: "not-allowed" | "invalid-ip" | "xff-unusable" | "overflow";
  suppressed: number;
}
export const CLIENT_DENY_AUDIT_KEYS = ["listener", "ip", "via", "reason", "suppressed"] as const;
export interface LanSessionAuditRecord {
  /** A kicked session shared the revoker's current IP; its trust was deliberately kept. */
  sharedIpKept?: boolean;
  op: "list" | "revoke" | "others";
  ip: string;
  user?: string;
  ok: boolean;
  code?: string;
  n?: number;
  complete?: boolean;
  self?: boolean;
}
export const LAN_SESSION_AUDIT_KEYS = [
  "op",
  "ip",
  "user",
  "ok",
  "code",
  "n",
  "complete",
  "self",
  "sharedIpKept",
] as const;
export interface Lan2faAuditRecord {
  phase: "gate" | "challenge" | "verify" | "complete" | "dead" | "admin";
  method?: "password" | "totp" | "recovery" | "feishu";
  ip?: string;
  user?: string;
  ok: boolean;
  /** Outcome code, NEVER the user-entered OTP/recovery code. */
  code?: string;
  reason?: string;
  left?: number;
  ms?: number;
  op?: string;
}
export const LAN_2FA_AUDIT_KEYS = ["phase", "method", "ip", "user", "ok", "code", "reason", "left", "ms"] as const;
function auditLanSecurity(
  log: { info(msg: string, data?: object): void },
  channel: string,
  record: object,
  keys: readonly string[],
): void {
  const raw = record as Record<string, unknown>;
  const out: Record<string, unknown> = { audit: channel };
  for (const key of keys) if (raw[key] !== undefined) out[key] = raw[key];
  log.info(channel, out);
}
export function auditClientDeny(log: { info(msg: string, data?: object): void }, record: ClientDenyAuditRecord): void {
  auditLanSecurity(log, "client-deny", record, CLIENT_DENY_AUDIT_KEYS);
}
export function auditLanSession(log: { info(msg: string, data?: object): void }, record: LanSessionAuditRecord): void {
  auditLanSecurity(log, "lan-session", record, LAN_SESSION_AUDIT_KEYS);
}
export function auditLan2fa(log: { info(msg: string, data?: object): void }, record: Lan2faAuditRecord): void {
  if (record.phase === "admin") auditLanSecurity(log, "lan-2fa", record, ["op", "ok"]);
  else auditLanSecurity(log, "lan-2fa", record, LAN_2FA_AUDIT_KEYS);
}
