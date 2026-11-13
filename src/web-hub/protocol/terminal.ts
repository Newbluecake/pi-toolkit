/** WebHub terminal v1, plan r4 §§2–6. Append-only, NOT a hello capability.
 * This file is the frozen shared face for P1-A/P1-H/P2. No backend/OS authority here.
 * Classification is deliberately wider than validation: invalid reserved frames are discarded.
 */
import { Type, type Static, type TProperties, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const TERMINAL_LIMITS = Object.freeze({
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  hardTotal: 32,
  inputIdleMs: 3_600_000,
  maxLifetimeMs: 28_800_000,
  ringBytes: 1_048_576,
  scrollbackLines: 1000,
  resizeMarks: 128,
  outputChunkBytes: 8192,
  inputBytes: 4096,
  frameBytes: 16_384,
  inputPendingBytes: 32_768,
  liveWindowBytes: 65_536,
  liveStagingBytes: 65_536,
  nonRingPendingBytes: 131_072,
  helperPendingBytes: 131_072,
  udsPendingBytes: 131_072,
  replayBytes: 16_384,
  replayLiveStagingBytes: 0,
  replayAttempts: 8,
  replayRateBytes: 131_072,
  liveRateBytes: 131_072,
  hubRateBytes: 524_288,
  bootstrapMs: 3000,
  httpMs: 5000,
  controlMs: 2000,
  probeMs: 1000,
  startupMs: 3000,
  leaseMs: 15_000,
  renewMs: 5000,
  linkLossMs: 30_000,
  heartbeatMs: 5000,
  helperSilenceMs: 15_000,
  reapMs: 5000,
  reapRounds: 3,
  reapRetryMs: 60_000,
  offerMs: 10_000,
  grantMs: 10_000,
  replayMs: 3000,
  viewerMs: 2000,
  ticketMs: 600_000,
  exitedMs: 60_000,
  ticketsPerOwner: 64,
  ticketsTotal: 2048,
  offers: 64,
  privateCommandsPerLink: 256,
  unresolvedResources: 32,
  inventoryBytes: 65_536,
  inventoryMs: 5000,
  inventoryRetries: 1,
});
const closed = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((v) => Type.Literal(v)));
export const TerminalIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const id = TerminalIdSchema;
const uint = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const pos = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const cols = Type.Integer({ minimum: 2, maximum: 500 });
const rows = Type.Integer({ minimum: 1, maximum: 200 });
const v = Type.Literal(1);
const dimensions = { cols, rows };
export const TerminalConfigSchema = closed({
  maxPerSession: Type.Integer({ minimum: 1, maximum: 4 }),
  maxPerPrincipal: Type.Integer({ minimum: 1, maximum: 8 }),
  maxTotal: Type.Integer({ minimum: 1, maximum: 32 }),
  inputIdleMs: Type.Integer({ minimum: 300_000, maximum: 86_400_000 }),
  maxLifetimeMs: Type.Integer({ minimum: 900_000, maximum: 86_400_000 }),
});
export type TerminalHubConfig = Static<typeof TerminalConfigSchema>;
export const TerminalResourceIdentitySchema = closed({
  agentSessionId: id,
  termId: id,
  epoch: id,
  ownerInstance: id,
  reservationId: id,
});
export type TerminalResourceIdentity = Static<typeof TerminalResourceIdentitySchema>;
export const TerminalProcessIdentitySchema = closed({
  bootId: id,
  pid: pos,
  starttime: Type.String({ pattern: "^[0-9]{1,32}$" }),
  uid: uint,
});
export type TerminalProcessIdentity = Static<typeof TerminalProcessIdentitySchema>;
export const TerminalManagedIdentitySchema = closed({
  ...TerminalProcessIdentitySchema.properties,
  sid: pos,
  pgid: pos,
  role: literals(["helper", "shell", "foreground", "background", "descendant"]),
});
export const TerminalResourceEntrySchema = closed({
  identity: TerminalResourceIdentitySchema,
  agentProcessIdentity: TerminalProcessIdentitySchema,
  managed: Type.Array(TerminalManagedIdentitySchema, { maxItems: 256 }),
  spawnState: literals(["pending", "settled"]),
  state: literals(["reserved", "starting", "live", "closing", "reaping", "poison"]),
});
export type TerminalResourceEntry = Static<typeof TerminalResourceEntrySchema>;
export const TerminalChallengeSchema = closed({ hubBootId: id, challengeId: id, linkGen: pos, deadlineAt: uint });
export type TerminalChallenge = Static<typeof TerminalChallengeSchema>;
const evidenceScope = { hubBootId: id, challengeId: id, linkGen: pos, inventoryId: id, revision: uint };
export const TerminalReapProofSchema = closed({
  ...evidenceScope,
  identity: TerminalResourceIdentitySchema,
  agentProcessIdentity: TerminalProcessIdentitySchema,
  proofId: id,
  spawnSettled: Type.Literal(true),
  ptyClosed: Type.Literal(true),
  helperReaped: Type.Literal(true),
  managedGroupsGone: Type.Literal(true),
  identitiesChecked: Type.Array(TerminalManagedIdentitySchema, { maxItems: 256 }),
  outcome: Type.Literal("reaped"),
});
export type TerminalReapProof = Static<typeof TerminalReapProofSchema>;
export const TerminalInventorySchema = closed({
  v,
  ...evidenceScope,
  sender: closed({ agentSessionId: id, epoch: id, ownerInstance: id, processIdentity: TerminalProcessIdentitySchema }),
  totalCount: Type.Integer({ minimum: 0, maximum: 32 }),
  digest,
  entries: Type.Array(TerminalResourceEntrySchema, { maxItems: 32 }),
  proofs: Type.Array(TerminalReapProofSchema, { maxItems: 32 }),
  complete: Type.Literal(true),
});
export type TerminalInventory = Static<typeof TerminalInventorySchema>;
/** Pagination is atomic: no page applies until end/count/digest/revision/coverage match. */
export const TerminalInventoryPageSchema = Type.Union([
  closed({
    ...evidenceScope,
    phase: Type.Literal("begin"),
    sender: TerminalInventorySchema.properties.sender,
    totalCount: Type.Integer({ minimum: 0, maximum: 32 }),
    chunkCount: Type.Integer({ minimum: 0, maximum: 64 }),
    digest,
  }),
  closed({
    ...evidenceScope,
    phase: Type.Literal("chunk"),
    chunkIndex: uint,
    entries: Type.Array(TerminalResourceEntrySchema, { maxItems: 32 }),
    proofs: Type.Array(TerminalReapProofSchema, { maxItems: 32 }),
  }),
  closed({
    ...evidenceScope,
    phase: Type.Literal("end"),
    chunkCount: Type.Integer({ minimum: 0, maximum: 64 }),
    totalCount: Type.Integer({ minimum: 0, maximum: 32 }),
    digest,
    complete: Type.Literal(true),
  }),
]);
export type TerminalInventoryPage = Static<typeof TerminalInventoryPageSchema>;
export const TerminalQuarantineSchema = Type.Union([
  closed({ state: Type.Literal("cleared"), revision: uint }),
  closed({
    state: literals(["collecting", "reconciling", "lost", "inconsistent", "reap_incomplete"]),
    revision: uint,
    code: Type.Literal("E_RESOURCE_QUARANTINED"),
    effect: Type.Literal("unknown"),
    reason: literals(["inventory-missing", "inventory-inconsistent", "cleanup-unproven"]),
    physicalUsed: Type.Integer({ minimum: 0, maximum: 32 }),
  }),
]);
export type TerminalQuarantine = Static<typeof TerminalQuarantineSchema>;
/** Journal contains metadata only; unresolved is never evicted/TTL-released. */
export const TerminalJournalSchema = closed({
  v,
  revision: uint,
  resources: Type.Array(
    closed({
      entry: TerminalResourceEntrySchema,
      status: literals(["unresolved", "resolved"]),
      proof: Type.Optional(TerminalReapProofSchema),
    }),
    { maxItems: 32 },
  ),
});
export type TerminalJournal = Static<typeof TerminalJournalSchema>;
export const TERMINAL_JOURNAL_FILE = "terminal-resource-fence-v1.json";
export const TerminalOwnerBindingSchema = closed({
  listener: literals(["loopback", "lan"]),
  principal: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9:_.-]+$" }),
  sidTag: id,
  agentKey: id,
  sessionId: id,
  epoch: id,
  ownerInstance: id,
});
export type TerminalOwnerBinding = Static<typeof TerminalOwnerBindingSchema>;
export const TerminalCreateTicketSchema = closed({
  v,
  bootId: id,
  ticketId: id,
  issuedAt: uint,
  expiresAt: uint,
  ownerBinding: TerminalOwnerBindingSchema,
  payloadDigest: digest,
  mac: digest,
});
export type TerminalCreateTicket = Static<typeof TerminalCreateTicketSchema>;
export const TerminalFenceSchema = closed({
  revision: uint,
  authEpoch: uint,
  selector: Type.Union([
    closed({ kind: Type.Literal("sid"), listener: literals(["loopback", "lan"]), sidTag: id }),
    closed({ kind: Type.Literal("user"), userId: uint }),
    closed({ kind: Type.Literal("listener"), listener: literals(["loopback", "lan"]) }),
    closed({ kind: Type.Literal("all") }),
  ]),
  denied: Type.Literal(true),
});
export type TerminalFence = Static<typeof TerminalFenceSchema>;
export const TERMINAL_FENCE_CAPACITY = 2048; // saturated selectors widen to sticky all; no TTL repair
export const TerminalSseIdentitySchema = closed({ clientId: id, connectionInstance: id, connectionToken: id });
export type TerminalSseIdentity = Static<typeof TerminalSseIdentitySchema>;
/** Private object identity + socket/sink references live in hub, not in this wire schema. */
export const TerminalSseBindingMetadataSchema = closed({
  listener: literals(["loopback", "lan"]),
  principal: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9:_.-]+$" }),
  sidTag: id,
  ...TerminalSseIdentitySchema.properties,
  parentExpiresAt: uint,
  fenceRevision: uint,
  authEpoch: uint,
  live: Type.Boolean(),
  userId: Type.Optional(uint),
});
export type TerminalSseBindingMetadata = Static<typeof TerminalSseBindingMetadataSchema>;
export const TerminalConnectionEventSchema = closed({ connectionInstance: id, connectionToken: id, expiresAt: uint });
export const TerminalOfferSchema = closed({ v, outcome: Type.Literal("handshake-required"), offerId: id });
export type TerminalOffer = Static<typeof TerminalOfferSchema>;
export const TerminalCommandResultDataSchema = closed({
  op: Type.Literal("command"),
  kind: Type.Literal("builtin"),
  completion: Type.Literal("sync"),
  history: Type.Literal("none"),
  terminal: TerminalOfferSchema,
});
export type TerminalCommandResultData = Static<typeof TerminalCommandResultDataSchema>;
export const TerminalPrivateCommandIdentitySchema = closed({
  agentKey: id,
  linkGen: pos,
  sessionId: id,
  epoch: id,
  rid: id,
  commandId: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }),
  ownerInstance: Type.Optional(id),
});
export type TerminalPrivateCommandIdentity = Static<typeof TerminalPrivateCommandIdentitySchema>;
export const TerminalNegotiationSchema = closed({
  v,
  action: literals(["negotiate", "resource_inventory"]),
  requestNonce: id,
});
export type TerminalNegotiation = Static<typeof TerminalNegotiationSchema>;
export const TerminalProtocolReadyProofSchema = closed({
  offerId: id,
  localConnectionInstance: id,
  sessionId: id,
  epoch: id,
  ownerInstance: id,
  mode: literals(["interactive", "resource-only"]),
  hubNonce: id,
  agentChallenge: id,
  expiresAt: uint,
});
export type TerminalProtocolReadyProof = Static<typeof TerminalProtocolReadyProofSchema>;
const scope = { sessionId: id, epoch: id, ownerInstance: id };
const req = { t: Type.Literal("term_req"), v, rid: id, ...scope };
const res = { t: Type.Literal("term_res"), v, rid: id, ...scope };
const channel = { channelId: id };
const writer = { termId: id, attachmentId: id, writerLease: id };
const handshake = { offerId: id, hubNonce: id };
const ready = { ...handshake, agentChallenge: id };
const deadlines = closed({ inputIdleAt: uint, lifetimeAt: uint, parentExpiresAt: uint });
export const TerminalStateSchema = literals(["starting", "live", "closing", "exited", "failed", "reap_incomplete"]);
const facts = {
  termId: id,
  reservationId: id,
  revision: uint,
  state: TerminalStateSchema,
  nextInputSeq: uint,
  baseOffset: uint,
  nextOffset: uint,
  deadlines,
};
const attachment = { ...facts, attachmentId: id, writerLease: id, replayMode: literals(["cold", "warm"]) };
const b64 = (bytes: number) =>
  Type.String({
    maxLength: 4 * Math.ceil(bytes / 3),
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
  });
const open = { openId: id, createTicket: TerminalCreateTicketSchema, ...dimensions };
const ack = Type.Union([
  closed({ phase: Type.Literal("live"), renderedThrough: uint }),
  closed({ phase: Type.Literal("replay_ready"), attemptId: id, replayEpoch: id, renderedThrough: uint }),
]);
export const TermReqSchema = Type.Union([
  // prepare has no owner yet: agent supplies authority in challenge, not public offer.
  closed({
    t: Type.Literal("term_req"),
    v,
    rid: id,
    sessionId: id,
    epoch: id,
    op: Type.Literal("prepare_protocol"),
    ...handshake,
  }),
  closed({ ...req, op: Type.Literal("protocol_ready"), ...ready }),
  closed({ ...req, op: Type.Literal("bind"), ...ready, proposedChannelId: id, grant: id }),
  closed({ ...req, ...channel, op: Type.Literal("inventory"), challenge: TerminalChallengeSchema }),
  closed({
    ...req,
    ...channel,
    op: Type.Literal("open"),
    ...open,
    reservationId: id,
    termId: id,
    ownerKey: id,
    attachmentId: id,
    writerLease: id,
  }),
  closed({ ...req, ...channel, op: Type.Literal("list") }),
  closed({
    ...req,
    ...channel,
    op: Type.Literal("attach"),
    termId: id,
    attachId: id,
    attachmentId: id,
    writerLease: id,
    ...dimensions,
    fromOffset: Type.Optional(uint),
  }),
  closed({ ...req, ...channel, ...writer, op: Type.Literal("detach") }),
  closed({
    ...req,
    ...channel,
    ...writer,
    op: Type.Literal("input"),
    inputSeq: uint,
    bytesB64: b64(4096),
    inputKind: literals(["user", "terminal_response"]),
    streamEpoch: id,
  }),
  closed({
    ...req,
    ...channel,
    ...writer,
    op: Type.Literal("resize"),
    resizeSeq: uint,
    ...dimensions,
    redraw: Type.Optional(Type.Literal(true)),
  }),
  closed({ ...req, ...channel, ...writer, op: Type.Literal("ack"), ack }),
  closed({ ...req, ...channel, ...writer, op: Type.Literal("renew") }),
  closed({
    ...req,
    ...channel,
    op: Type.Literal("state"),
    target: Type.Union([closed({ termId: id }), closed({ openId: id }), closed({ reservationId: id })]),
  }),
  closed({
    ...req,
    ...channel,
    op: Type.Literal("close"),
    termId: id,
    reservationId: id,
    closeId: id,
    expectedRevision: uint,
  }),
]);
export type TermReq = Static<typeof TermReqSchema>;
export const TERMINAL_ERROR_CODES = [
  "E_AUTH",
  "E_CSRF",
  "E_DISABLED",
  "E_UNSUPPORTED",
  "E_UNAVAILABLE",
  "E_SECURE",
  "E_PRIVACY_LOCKED",
  "E_SESSION_CHANGED",
  "E_WRITER_BUSY",
  "E_LEASE_EXPIRED",
  "E_LIMIT",
  "E_RATE",
  "E_INPUT_SEQUENCE",
  "E_DEADLINE",
  "E_UNKNOWN_EFFECT",
  "E_AUTH_REVOKING",
  "E_EXPIRED",
  "E_STALE_CREATION",
  "E_REPLAY_BUSY",
  "E_REPLAY_DEADLINE",
  "E_BACKEND_CAPABILITY",
  "E_RESOURCE_QUARANTINED",
  "E_BAD_REQUEST",
] as const;
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];
const error = { ok: Type.Literal(false), code: literals(TERMINAL_ERROR_CODES), effect: literals(["none", "unknown"]) };
const ops = [
  "prepare_protocol",
  "protocol_ready",
  "bind",
  "inventory",
  "open",
  "list",
  "attach",
  "detach",
  "input",
  "resize",
  "ack",
  "renew",
  "state",
  "close",
] as const;
// Error vocabulary is op-local; a UI must not infer an effect from a string alone.
const commonErrors = [
  "E_AUTH",
  "E_CSRF",
  "E_DISABLED",
  "E_UNSUPPORTED",
  "E_UNAVAILABLE",
  "E_SECURE",
  "E_PRIVACY_LOCKED",
  "E_SESSION_CHANGED",
  "E_RATE",
  "E_DEADLINE",
  "E_AUTH_REVOKING",
  "E_BAD_REQUEST",
  "E_RESOURCE_QUARANTINED",
] as const;
export const TERMINAL_OP_ERROR_CODES = {
  prepare: [...commonErrors, "E_LIMIT"],
  prepare_protocol: commonErrors,
  protocol_ready: commonErrors,
  bind: [...commonErrors, "E_EXPIRED"],
  inventory: commonErrors,
  open: [...commonErrors, "E_LIMIT", "E_EXPIRED", "E_STALE_CREATION", "E_UNKNOWN_EFFECT", "E_BACKEND_CAPABILITY"],
  list: commonErrors,
  attach: [...commonErrors, "E_WRITER_BUSY", "E_LEASE_EXPIRED", "E_REPLAY_BUSY", "E_REPLAY_DEADLINE"],
  detach: [...commonErrors, "E_LEASE_EXPIRED"],
  input: [...commonErrors, "E_LEASE_EXPIRED", "E_INPUT_SEQUENCE", "E_UNKNOWN_EFFECT"],
  resize: [...commonErrors, "E_LEASE_EXPIRED", "E_UNKNOWN_EFFECT"],
  ack: [...commonErrors, "E_LEASE_EXPIRED", "E_REPLAY_DEADLINE"],
  renew: [...commonErrors, "E_LEASE_EXPIRED"],
  state: [...commonErrors, "E_EXPIRED", "E_STALE_CREATION"],
  close: [...commonErrors, "E_UNKNOWN_EFFECT"],
} as const;
export const TermResSchema = Type.Union([
  closed({ ...res, op: Type.Literal("protocol_challenge"), ...ready, ok: Type.Literal(true) }),
  closed({
    ...res,
    op: Type.Literal("protocol_ready"),
    ...ready,
    ok: Type.Literal(true),
    mode: Type.Literal("interactive"),
    grant: id,
    expiresAt: uint,
    backend: Type.Literal("linux-pty-v1"),
    limits: TerminalConfigSchema,
  }),
  closed({
    ...res,
    op: Type.Literal("protocol_ready"),
    ...ready,
    ok: Type.Literal(true),
    mode: Type.Literal("resource-only"),
    ...channel,
  }),
  closed({ ...res, ...channel, op: Type.Literal("bind"), ok: Type.Literal(true), bound: Type.Literal(true) }),
  closed({
    ...res,
    ...channel,
    op: Type.Literal("inventory"),
    ok: Type.Literal(true),
    page: TerminalInventoryPageSchema,
  }),
  ...(["open", "attach"] as const).map((op) =>
    closed({ ...res, ...channel, op: Type.Literal(op), ok: Type.Literal(true), ...attachment }),
  ),
  closed({
    ...res,
    ...channel,
    op: Type.Literal("list"),
    ok: Type.Literal(true),
    revision: uint,
    rows: Type.Array(closed(facts), { maxItems: 32 }),
  }),
  closed({ ...res, ...channel, op: Type.Literal("input"), ok: Type.Literal(true), acceptedThrough: uint }),
  ...(["detach", "resize", "ack", "renew"] as const).map((op) =>
    closed({ ...res, ...channel, op: Type.Literal(op), ok: Type.Literal(true), revision: uint }),
  ),
  closed({
    ...res,
    ...channel,
    op: Type.Literal("close"),
    ok: Type.Literal(true),
    state: Type.Literal("closing"),
    revision: uint,
  }),
  closed({
    ...res,
    ...channel,
    op: Type.Literal("state"),
    ok: Type.Literal(true),
    fact: Type.Union([
      closed(facts),
      closed({ state: Type.Literal("expired"), effect: Type.Literal("unknown"), code: Type.Literal("E_EXPIRED") }),
      closed({ state: Type.Literal("unknown"), effect: Type.Literal("unknown") }),
    ]),
  }),
  ...ops.map((op) =>
    closed({
      ...res,
      op: Type.Literal(op),
      channelId: Type.Optional(id),
      offerId: Type.Optional(id),
      ...error,
      code: literals(TERMINAL_OP_ERROR_CODES[op]),
    }),
  ),
]);
export type TermRes = Static<typeof TermResSchema>;
const event = { t: Type.Literal("term_event"), v, ...scope, ...channel, termId: id, revision: uint };
export const TermEventSchema = Type.Union([
  closed({ ...event, kind: Type.Literal("output"), offset: uint, bytesB64: b64(8192), streamEpoch: id }),
  closed({
    ...event,
    kind: Type.Literal("replay_begin"),
    attemptId: id,
    replayEpoch: id,
    S: uint,
    N0: uint,
    deadlineAt: uint,
  }),
  closed({
    ...event,
    kind: Type.Literal("cutover"),
    attemptId: id,
    newLiveEpoch: id,
    replayEnd: uint,
    liveFrom: uint,
    gap: closed({ from: uint, to: uint }),
    resetParser: Type.Literal(true),
  }),
  closed({
    ...event,
    kind: Type.Literal("state"),
    state: TerminalStateSchema,
    deadlines,
    writerPresent: Type.Boolean(),
    nextInputSeq: uint,
  }),
  closed({
    ...event,
    kind: Type.Literal("gap"),
    requestedOffset: uint,
    baseOffset: uint,
    nextOffset: uint,
    reason: literals(["evicted", "replay-cutover", "slow-viewer"]),
  }),
  closed({
    ...event,
    kind: Type.Literal("exit"),
    exitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
    signal: Type.Optional(literals(["SIGHUP", "SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT"])),
    reap: literals(["reaped", "reap_incomplete"]),
  }),
]);
export type TermEvent = Static<typeof TermEventSchema>;
/** Browser direct-send projection: never expose the internal channel id or replay id.
 * Binding+attachment are rechecked on EVERY enqueue; no Last-Event-ID restoration. */
export const TerminalSseEventSchema = closed({
  agentKey: id,
  attachmentId: id,
  connectionInstance: id,
  event: Type.Union(TermEventSchema.anyOf.map((schema) => Type.Omit(schema, ["t", "channelId"]))),
});
export type TerminalSseEvent = Static<typeof TerminalSseEventSchema>;
export const TERMINAL_AGENT_FRAME_SCHEMAS = { term_res: TermResSchema, term_event: TermEventSchema };
export const TERMINAL_HUB_FRAME_SCHEMAS = { term_req: TermReqSchema };

const http = { agentKey: id, expect: closed({ sessionId: id, epoch: id }), ...TerminalSseIdentitySchema.properties };
export const TERMINAL_HTTP_PATHS = Object.freeze(
  Object.fromEntries(
    ["prepare", ...ops.filter((op) => !["prepare_protocol", "protocol_ready", "bind", "inventory"].includes(op))].map(
      (op) => [op, `/api/terminal/${op}`],
    ),
  ),
) as Readonly<
  Record<
    "prepare" | "open" | "list" | "attach" | "detach" | "input" | "resize" | "ack" | "renew" | "state" | "close",
    string
  >
>;
export const TERMINAL_HTTP_SCHEMAS = {
  prepare: closed({ ...http, ...dimensions }),
  list: closed(http),
  open: closed({ ...http, ...open, tabId: id }),
  attach: closed({ ...http, termId: id, attachId: id, tabId: id, ...dimensions, fromOffset: Type.Optional(uint) }),
  detach: closed({ ...http, ...writer }),
  input: closed({
    ...http,
    ...writer,
    inputSeq: uint,
    bytesB64: b64(4096),
    inputKind: literals(["user", "terminal_response"]),
    streamEpoch: id,
  }),
  resize: closed({ ...http, ...writer, resizeSeq: uint, ...dimensions }),
  ack: closed({ ...http, ...writer, ack }),
  renew: closed({ ...http, ...writer }),
  state: closed({
    ...http,
    target: Type.Union([closed({ termId: id }), closed({ openId: id, createTicket: TerminalCreateTicketSchema })]),
  }),
  close: closed({ ...http, termId: id, closeId: id, expectedRevision: uint }),
};
export type TerminalHttpRequests = {
  [K in keyof typeof TERMINAL_HTTP_SCHEMAS]: Static<(typeof TERMINAL_HTTP_SCHEMAS)[K]>;
};
export type TerminalFailure = { ok: false; code: TerminalErrorCode; effect: "none" | "unknown" };
export const TERMINAL_HTTP_SUCCESS_SCHEMAS = {
  prepare: closed({ ok: Type.Literal(true), openId: id, createTicket: TerminalCreateTicketSchema }),
  open: closed({ ok: Type.Literal(true), ...attachment }),
  attach: closed({ ok: Type.Literal(true), ...attachment }),
  list: closed({ ok: Type.Literal(true), revision: uint, rows: Type.Array(closed(facts), { maxItems: 32 }) }),
  input: closed({ ok: Type.Literal(true), acceptedThrough: uint }),
  detach: closed({ ok: Type.Literal(true), revision: uint }),
  resize: closed({ ok: Type.Literal(true), revision: uint }),
  ack: closed({ ok: Type.Literal(true), revision: uint }),
  renew: closed({ ok: Type.Literal(true), revision: uint }),
  close: closed({ ok: Type.Literal(true), state: Type.Literal("closing"), revision: uint }),
  state: closed({
    ok: Type.Literal(true),
    fact: Type.Union([
      closed(facts),
      closed({ state: Type.Literal("expired"), effect: Type.Literal("unknown"), code: Type.Literal("E_EXPIRED") }),
      closed({ state: Type.Literal("unknown"), effect: Type.Literal("unknown") }),
    ]),
  }),
};
export type TerminalHttpResults = {
  [K in keyof typeof TERMINAL_HTTP_SUCCESS_SCHEMAS]: Static<(typeof TERMINAL_HTTP_SUCCESS_SCHEMAS)[K]>;
};
export type TerminalHttpResponse<K extends keyof TerminalHttpResults> =
  TerminalHttpResults[K] | { ok: false; code: (typeof TERMINAL_OP_ERROR_CODES)[K][number]; effect: "none" | "unknown" };
export function terminalHttpRequestOk<K extends keyof TerminalHttpRequests>(
  op: K,
  raw: unknown,
): raw is TerminalHttpRequests[K] {
  if (!Value.Check(TERMINAL_HTTP_SCHEMAS[op], raw)) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(raw)).length > TERMINAL_LIMITS.frameBytes) return false;
  } catch {
    return false;
  }
  const r = raw as Record<string, unknown>;
  if (op === "input") {
    const n = canonicalBase64Bytes(String(r.bytesB64));
    return n !== undefined && n <= TERMINAL_LIMITS.inputBytes;
  }
  return true;
}

/** Strict UTF-8 frame budget + canonical base64 and raw-byte/offset overflow guards. */
export function terminalFrameOk(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  const schema: TSchema | undefined = (
    { ...TERMINAL_AGENT_FRAME_SCHEMAS, ...TERMINAL_HUB_FRAME_SCHEMAS } as Record<string, TSchema>
  )[String(r.t)];
  if (!schema || !Value.Check(schema, raw)) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(raw) + "\n").length > TERMINAL_LIMITS.frameBytes) return false;
  } catch {
    return false;
  }
  if (typeof r.bytesB64 === "string") {
    const n = canonicalBase64Bytes(r.bytesB64);
    if (n === undefined || n > (r.t === "term_event" ? 8192 : 4096)) return false;
    if (typeof r.offset === "number" && !Number.isSafeInteger(r.offset + n)) return false;
  }
  return true;
}
export function canonicalBase64Bytes(s: string): number | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return undefined;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  if (padding && (alphabet.indexOf(s[s.length - padding - 1]!) & (padding === 2 ? 15 : 3)) !== 0) return undefined;
  return (s.length / 4) * 3 - padding;
}
export function isTerminalNamespace(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    typeof (raw as Record<string, unknown>).t === "string" &&
    ((raw as Record<string, unknown>).t as string).startsWith("term_")
  );
}
/** Only reserved structures; never scan user output/text for the word terminal. */
export function hasReservedTerminalResult(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.t !== "cmd_result" && r.t !== "cmd_late") return false;
  let d: unknown = r.data;
  for (let depth = 0; depth < 8; depth++) {
    if (!d || typeof d !== "object") return false;
    const o = d as Record<string, unknown>;
    if (
      Object.hasOwn(o, "terminal") ||
      o.outcome === "handshake-required" ||
      Object.hasOwn(o, "terminalOutcome") ||
      o.op === "__terminal" ||
      (o.v === 1 &&
        ["prepare_protocol", "protocol_challenge", "protocol_ready", "bind", "inventory"].includes(String(o.op))) ||
      (o.v === 1 && ["negotiate", "resource_inventory"].includes(String(o.action))) ||
      isTerminalNamespace(o)
    )
      return true;
    if (o.op !== "query") return false;
    const result = o.result;
    d = result && typeof result === "object" ? (result as Record<string, unknown>).data : undefined;
  }
  return true; // excessive nested query envelopes are not a legacy result
}
export function isReservedTerminalCommand(cmd: unknown): boolean {
  if (!cmd || typeof cmd !== "object") return false;
  const c = cmd as Record<string, unknown>;
  const reservedText = (text: unknown): boolean => /^\/+webhub\s+__terminal/i.test(String(text ?? "").trim());
  if (c.op === "prompt") return reservedText(c.text);
  if (c.op !== "command") return false;
  // Normalize slash/ASCII casing/whitespace. A template cannot smuggle a reserved
  // slash prefix in args; ordinary text containing the word terminal is unchanged.
  const name = String(c.name ?? "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
  return (
    (name === "webhub" && /^__terminal/i.test(String(c.args ?? "").trim())) ||
    name === "__terminal" ||
    reservedText(c.args) ||
    reservedText(`/${name}`)
  );
}

/** Canonical resource metadata JSON v1. SHA256 is applied by the hub, never over content. */
export function terminalIdentityKey(i: TerminalResourceIdentity): string {
  return JSON.stringify([i.agentSessionId, i.termId, i.epoch, i.ownerInstance, i.reservationId]);
}
export function canonicalTerminalInventory(entries: readonly TerminalResourceEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    terminalIdentityKey(a.identity) < terminalIdentityKey(b.identity)
      ? -1
      : terminalIdentityKey(a.identity) > terminalIdentityKey(b.identity)
        ? 1
        : 0,
  );
  const process = (p: TerminalProcessIdentity) => ({
    bootId: p.bootId,
    pid: p.pid,
    starttime: p.starttime,
    uid: p.uid,
  });
  return JSON.stringify({
    v: 1,
    entries: sorted.map((e) => ({
      identity: {
        agentSessionId: e.identity.agentSessionId,
        termId: e.identity.termId,
        epoch: e.identity.epoch,
        ownerInstance: e.identity.ownerInstance,
        reservationId: e.identity.reservationId,
      },
      agentProcessIdentity: process(e.agentProcessIdentity),
      managed: [...e.managed]
        .sort((a, b) => a.pid - b.pid || (a.starttime < b.starttime ? -1 : a.starttime > b.starttime ? 1 : 0))
        .map((p) => ({ ...process(p), sid: p.sid, pgid: p.pgid, role: p.role })),
      spawnState: e.spawnState,
      state: e.state,
    })),
  });
}
