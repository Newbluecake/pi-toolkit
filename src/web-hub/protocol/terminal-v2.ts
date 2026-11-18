/** T51 r2 §4: single v2 wire/ledger contract. Declarations and pure validation only.
 * No v1 imports, auth persistence, PTY implementation, public SSE or runtime activation.
 * Structural schemas are JSON-only-projectable; semantic guards below MUST also run. */
import { Type, type Static, type TProperties, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TerminalOpV2 } from "./terminal-v2-paths.js";
import {
  TERMINAL_V2_LIMITS,
  terminalCwdV2Ok,
  normalizeTerminalNameV2,
  terminalBase64BytesV2,
} from "./terminal-v2-values.js";
export {
  TERMINAL_V2_LIMITS,
  terminalCwdV2Ok,
  normalizeTerminalNameV2,
  terminalBase64BytesV2,
} from "./terminal-v2-values.js";
export { TERMINAL_V2_CAP, TERMINAL_V2_HTTP_PATHS } from "./terminal-v2-paths.js";

const closed = <P extends TProperties>(p: P) => Type.Object(p, { additionalProperties: false });
const literals = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const uint = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** Random ids require >=128 bits of entropy at minting (length is necessary, not proof of entropy).
 * Existing agentKey/sessionId/epoch are correlation keys, NOT new randomly minted ids. */
export const TerminalRandomIdV2Schema = Type.String({ minLength: 22, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const id = TerminalRandomIdV2Schema;
const key = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
export const TerminalScopeV2Schema = closed({ agentKey: key, sessionId: key, epoch: key });
export type TerminalScopeV2 = Static<typeof TerminalScopeV2Schema>;
export const TerminalTargetLimitsV2Schema = closed({
  maxPerSession: Type.Integer({ minimum: 1, maximum: 4 }),
  inputIdleMs: Type.Integer({ minimum: 300_000, maximum: 86_400_000 }),
  maxLifetimeMs: Type.Integer({ minimum: 900_000, maximum: 86_400_000 }),
});
export const TerminalMachineLimitsV2Schema = closed({
  ...TerminalTargetLimitsV2Schema.properties,
  maxPerPrincipal: Type.Integer({ minimum: 1, maximum: 8 }),
  maxTotal: Type.Integer({ minimum: 1, maximum: 32 }),
});
export type TerminalTargetLimitsV2 = Static<typeof TerminalTargetLimitsV2Schema>;
export type TerminalMachineLimitsV2 = Static<typeof TerminalMachineLimitsV2Schema>;
export const TerminalSessionV2Schema = closed({
  v: Type.Literal(2),
  enabled: Type.Literal(true),
  sessionId: key,
  epoch: key,
  contextGeneration: uint,
  limits: TerminalTargetLimitsV2Schema,
});
export type TerminalSessionV2 = Static<typeof TerminalSessionV2Schema>;
const cwd = Type.String({ minLength: 1, maxLength: 8192, pattern: "^/[^\\u0000]*$" });
export const TerminalContextRequestSchema = closed({
  t: Type.Literal("terminal_context_req"),
  v: Type.Literal(2),
  rid: id,
  sessionId: key,
  epoch: key,
  contextGeneration: uint,
});
export const TerminalContextReplySchema = Type.Union([
  closed({
    t: Type.Literal("terminal_context_res"),
    v: Type.Literal(2),
    rid: id,
    ok: Type.Literal(true),
    sessionId: key,
    epoch: key,
    contextGeneration: uint,
    cwd,
  }),
  closed({
    t: Type.Literal("terminal_context_res"),
    v: Type.Literal(2),
    rid: id,
    ok: Type.Literal(false),
    code: literals(["E_UNSUPPORTED", "E_SESSION_CHANGED", "E_SECURE", "E_CWD"]),
  }),
]);
export type TerminalContextRequest = Static<typeof TerminalContextRequestSchema>;
export type TerminalContextReply = Static<typeof TerminalContextReplySchema>;
/** Standalone decoder until P6 installs pre-registry private ingress. Do NOT add these
 * frames to the ordinary decoder/router without that consumer (would leak cwd to the bus). */
export function terminalContextFrameV2Ok(raw: unknown): raw is TerminalContextRequest | TerminalContextReply {
  if (!jsonBytesOk(raw, TERMINAL_V2_LIMITS.frameBytes)) return false;
  if (Value.Check(TerminalContextRequestSchema, raw)) return true;
  return Value.Check(TerminalContextReplySchema, raw) && (!raw.ok || terminalCwdV2Ok(raw.cwd));
}
export function parseTerminalSessionV2(
  raw: unknown,
  expected?: Pick<TerminalScopeV2, "sessionId" | "epoch">,
): TerminalSessionV2 | undefined {
  if (!jsonBytesOk(raw, 1024) || !Value.Check(TerminalSessionV2Schema, raw)) return undefined;
  if (expected && (raw.sessionId !== expected.sessionId || raw.epoch !== expected.epoch)) return undefined;
  return raw;
}

export const TerminalStateV2Schema = literals(["starting", "live", "closing", "exited", "failed", "cleanup-unknown"]);
export type TerminalStateV2 = Static<typeof TerminalStateV2Schema>;
const name = Type.String({ minLength: 1, maxLength: 48, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$" });
/** Raw rename requests may contain surrounding whitespace; service stores only normalized names. */
export const TerminalTabRowV2Schema = closed({
  termId: id,
  name,
  state: TerminalStateV2Schema,
  createdAt: uint,
  ordinal: positive,
});
export type TerminalTabRowV2 = Static<typeof TerminalTabRowV2Schema>;
export const TerminalUnknownResourceV2Schema = closed({ allocationTag: id, state: Type.Literal("cleanup-unknown") });
export type TerminalUnknownResourceV2 = Static<typeof TerminalUnknownResourceV2Schema>;
const quotaDimension = closed({
  used: Type.Integer({ minimum: 0, maximum: 32 }),
  unknown: Type.Integer({ minimum: 0, maximum: 32 }),
  limit: Type.Integer({ minimum: 1, maximum: 32 }),
});
export const TerminalQuotaV2Schema = closed({
  session: quotaDimension,
  principal: quotaDimension,
  total: quotaDimension,
});
export type TerminalQuotaV2 = Static<typeof TerminalQuotaV2Schema>;
const tabs = {
  revision: uint,
  rows: Type.Array(TerminalTabRowV2Schema, { maxItems: 32 }),
  unknownResources: Type.Array(TerminalUnknownResourceV2Schema, { maxItems: 32 }),
  quota: TerminalQuotaV2Schema,
};
export const TerminalTabsV2Schema = closed(tabs);
export type TerminalTabsV2 = Static<typeof TerminalTabsV2Schema>;
const dimensions = {
  cols: Type.Integer({ minimum: 2, maximum: 500 }),
  rows: Type.Integer({ minimum: 1, maximum: 200 }),
};
const scope = { scope: TerminalScopeV2Schema };
const envelope = { ...scope, hubInstance: id };
const term = { ...envelope, termId: id };
const writer = { ...term, viewId: id };
const base64 = (bytes: number) =>
  Type.String({
    maxLength: 4 * Math.ceil(bytes / 3),
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
  });
export const TERMINAL_V2_HTTP_SCHEMAS = {
  list: closed(scope),
  create: closed({ ...envelope, requestId: id, mode: literals(["ensure-empty", "new"]), ...dimensions }),
  creation: closed({ ...envelope, requestId: id }),
  rename: closed({ ...term, name: Type.String({ minLength: 1, maxLength: 256 }) }),
  close: closed(term),
  view: closed({ ...term, offset: Type.Optional(uint) }),
  input: closed({ ...writer, seq: uint, bytesB64: base64(4096), kind: literals(["user", "terminal_response"]) }),
  resize: closed({ ...writer, seq: uint, ...dimensions }),
  ack: closed({ ...writer, offset: uint, replayComplete: Type.Optional(Type.Literal(true)) }),
} satisfies Record<TerminalOpV2, TSchema>;
export type TerminalHttpRequestsV2 = { [K in TerminalOpV2]: Static<(typeof TERMINAL_V2_HTTP_SCHEMAS)[K]> };
export type TerminalCreateInputV2 = Omit<TerminalHttpRequestsV2["create"], "scope">;

/** Fixed codes and HTTP mapping; auth DB failure remains auth E_DB, never a resource error.
 * `none` requires proof of no accepted effect; transport cancellation is NOT that proof. */
export const TERMINAL_V2_ERROR_STATUS = Object.freeze({
  E_BAD_REQUEST: 400,
  E_IDEMPOTENCY_CONFLICT: 400,
  E_AUTH: 401,
  E_REVOKING: 401,
  E_CSRF: 403,
  E_OFF: 404,
  E_NOT_FOUND: 404,
  E_HUB_CHANGED: 409,
  E_SESSION_CHANGED: 409,
  E_WRITER_BUSY: 409,
  E_VIEW_CHANGED: 409,
  E_NOT_READY: 409,
  E_PRIVACY: 409,
  E_CLEANUP_UNKNOWN: 409,
  E_INPUT_UNKNOWN: 409,
  E_LIMIT: 429,
  E_RATE: 429,
  E_UNAVAILABLE: 503,
  E_RESOURCE_UNAVAILABLE: 503,
  E_SETUP_REQUIRED: 503,
  E_UNSUPPORTED: 503,
  E_CWD: 503,
  E_BACKEND: 503,
  E_DB: 503,
  E_DEADLINE: 504,
} as const);
export type TerminalErrorCodeV2 = keyof typeof TERMINAL_V2_ERROR_STATUS;
export const TerminalFailureV2Schema = closed({
  ok: Type.Literal(false),
  code: literals(Object.keys(TERMINAL_V2_ERROR_STATUS) as TerminalErrorCodeV2[]),
  effect: literals(["none", "unknown"]),
});
export type TerminalFailureV2 = Static<typeof TerminalFailureV2Schema>;
const success = { ok: Type.Literal(true) };
export const TerminalCreationV2Schema = Type.Union([
  closed({ ...success, outcome: Type.Literal("pending") }),
  closed({ ...success, outcome: Type.Literal("created"), termId: id }),
  closed({ ...success, outcome: Type.Literal("failed"), code: TerminalFailureV2Schema.properties.code }),
  closed({ ...success, outcome: Type.Literal("unknown") }),
]);
export const TERMINAL_V2_HTTP_SUCCESS_SCHEMAS = {
  list: closed({ ...success, hubInstance: id, ...tabs }),
  create: closed({ ...success, requestId: id, termId: id, state: TerminalStateV2Schema }),
  creation: TerminalCreationV2Schema,
  rename: closed({ ...success, row: TerminalTabRowV2Schema, revision: uint }),
  close: closed({ ...success, state: literals(["closing", "closed"]), revision: uint }),
  input: closed({ ...success, acceptedThrough: uint }),
  resize: closed({ ...success, acceptedThrough: uint }),
  ack: closed({ ...success, offset: uint }),
}; // view is NOT a JSON success; it is the independent NDJSON stream below.
export type TerminalJsonOpV2 = keyof typeof TERMINAL_V2_HTTP_SUCCESS_SCHEMAS;
export type TerminalHttpResultsV2 = { [K in TerminalJsonOpV2]: Static<(typeof TERMINAL_V2_HTTP_SUCCESS_SCHEMAS)[K]> };
export type TerminalHttpResponseV2<K extends TerminalJsonOpV2> = TerminalHttpResultsV2[K] | TerminalFailureV2;
export const TERMINAL_V2_VIEW_HEADERS = Object.freeze({
  "Content-Type": "application/x-ndjson",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
  "Content-Encoding": "identity",
});
const label = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$" });
export const TerminalMetadataV2Schema = closed({ cwd, shellName: label, userLabel: label, hostLabel: label });
export type TerminalMetadataV2 = Static<typeof TerminalMetadataV2Schema>;
export const TerminalViewFrameV2Schema = Type.Union([
  closed({
    t: Type.Literal("attached"),
    hubInstance: id,
    viewId: id,
    termId: id,
    start: uint,
    end: uint,
    metadata: Type.Optional(TerminalMetadataV2Schema),
  }),
  closed({ t: Type.Literal("output"), offset: uint, bytesB64: base64(8192) }),
  closed({ t: Type.Literal("gap"), from: uint, to: uint }),
  closed({ t: Type.Literal("replay-end"), offset: uint }),
  closed({ t: Type.Literal("ready"), offset: uint }),
  closed({ t: Type.Literal("tabs"), ...tabs }),
  closed({
    t: Type.Literal("state"),
    termId: id,
    state: TerminalStateV2Schema,
    exitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  }),
  closed({ t: Type.Literal("ping") }),
  closed({ t: Type.Literal("error"), code: TerminalFailureV2Schema.properties.code }),
]);
export type TerminalViewFrameV2 = Static<typeof TerminalViewFrameV2Schema>;

/** Only resource attribution. These fields NEVER authorize a request or persist auth intent. */
export const AllocationV2Schema = closed({
  allocationId: id,
  termId: id,
  kernelBootId: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }),
  hubInstance: id,
  scope: TerminalScopeV2Schema,
  quotaSessionKey: key,
  principalKey: Type.String({ minLength: 5, maxLength: 137, pattern: "^(?:loopback|lan):[A-Za-z0-9_-]{1,128}$" }),
  creatorSidTag: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" }),
});
export type AllocationV2 = Static<typeof AllocationV2Schema>;
export const LedgerV2Schema = closed({
  v: Type.Literal(2),
  storeId: id,
  revision: uint,
  allocations: Type.Array(AllocationV2Schema, { maxItems: 32 }),
});
export type LedgerV2 = Static<typeof LedgerV2Schema>;
export const TerminalMarkerV2Schema = closed({
  v: Type.Literal(2),
  storeId: id,
  initialization: literals(["fresh", "v1-clean-checkpoint"]),
  checkpointId: id,
});
export type TerminalMarkerV2 = Static<typeof TerminalMarkerV2Schema>;
/** Pure closed validation; no healing, accounting, disk IO, auth or physical-release inference. */
export function terminalLedgerV2Ok(raw: unknown): raw is LedgerV2 {
  if (!jsonBytesOk(raw, TERMINAL_V2_LIMITS.ledgerBytes) || !Value.Check(LedgerV2Schema, raw)) return false;
  const allocations = new Set<string>(),
    terms = new Set<string>();
  for (const row of raw.allocations) {
    if (row.quotaSessionKey !== row.scope.sessionId || allocations.has(row.allocationId) || terms.has(row.termId))
      return false;
    allocations.add(row.allocationId);
    terms.add(row.termId);
  }
  return true;
}
export function terminalHttpRequestV2Ok<K extends TerminalOpV2>(op: K, raw: unknown): raw is TerminalHttpRequestsV2[K] {
  if (!jsonBytesOk(raw, TERMINAL_V2_LIMITS.frameBytes) || !Value.Check(TERMINAL_V2_HTTP_SCHEMAS[op], raw)) return false;
  const r = raw as Record<string, unknown>;
  if (op === "rename") return typeof r.name === "string" && normalizeTerminalNameV2(r.name) !== undefined;
  if (op === "input") {
    const n = terminalBase64BytesV2(String(r.bytesB64));
    return n !== undefined && n <= TERMINAL_V2_LIMITS.inputBytes;
  }
  return true;
}
export function terminalViewFrameV2Ok(raw: unknown): raw is TerminalViewFrameV2 {
  if (!jsonBytesOk(raw, TERMINAL_V2_LIMITS.frameBytes, true) || !Value.Check(TerminalViewFrameV2Schema, raw))
    return false;
  if (raw.t === "output") {
    const n = terminalBase64BytesV2(raw.bytesB64);
    return n !== undefined && n <= 8192 && Number.isSafeInteger(raw.offset + n);
  }
  if (raw.t === "gap") return raw.from < raw.to;
  if (raw.t === "attached") return raw.start <= raw.end && (!raw.metadata || terminalCwdV2Ok(raw.metadata.cwd));
  if (raw.t === "tabs") return terminalTabsV2Ok(raw);
  return true;
}
export function terminalTabsV2Ok(raw: TerminalTabsV2): boolean {
  return (
    raw.rows.every((r) => normalizeTerminalNameV2(r.name) === r.name) &&
    new Set(raw.rows.map((r) => r.termId)).size === raw.rows.length &&
    Object.values(raw.quota).every((d) => d.unknown <= d.used)
  );
}
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}
function jsonBytesOk(raw: unknown, max: number, newline = false): boolean {
  try {
    const s = JSON.stringify(raw);
    return s !== undefined && utf8Bytes(s + (newline ? "\n" : "")) <= max;
  } catch {
    return false;
  }
}
