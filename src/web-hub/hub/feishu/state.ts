/**
 * Feishu bot durable state (bot plan §5.4 / §R2-c / §5.8 / §R2-f, package F4).
 * Pi-free (hub boundary): `node:*`, `../../protocol/*` and sibling `feishu/` modules only.
 *
 * `<stateDir>/feishu-bot/state.json` — compact JSON, 0600, atomic replace + fsync (the
 * `credentials.ts` primitives), ≤ {@link FEISHU_CAPS.stateMaxBytes} (4 MiB). One strict, versioned
 * document holds every durable store: allow-list, tenant pin, dedup, requests (with the §R2-c
 * durable payload), bindings, dialog cards, nonces, approvals, outbox parts and the undecodable
 * ring. All mutators are SYNCHRONOUS in-memory operations that mark the document dirty; durability
 * is a separate, explicit barrier:
 *
 * ## Group commit / ACK barrier (§2.4)
 * - The first mutation after a flush arms an unref'd timer (`FEISHU_ACK.groupCommitMs`, ≤100 ms);
 *   every mutation applied before the write starts rides the same fsync'd write.
 * - `commit()` resolves `true` once EVERYTHING applied before the call is durable; `false` on a failed
 *   write or when it is not durable within `FEISHU_ACK.commitDeadlineMs` (1.5 s) — the caller must
 *   then NOT ACK (§2.4) and the state reports `persist-failed` until a later write succeeds
 *   (retried every `retryMs`, default 1 s).
 * - **Rule for callers:** an in-memory fact is only evidence once `commit()` said `true`. In particular
 *   a DUPLICATE detected through `dedup.has()` may only be ACKed after `await commit()` too: the
 *   first copy's `received` record may still be in memory only.
 * - `transition(…→dispatching)` must be committed before `commandRouter.request` (§5.4).
 *
 * ## Caps (§5.8 + §R2-f): every store refuses the NEW item at cap — never silent eviction of
 * security state (allow-list, tenant pin, dedup, nonces, approvals, bindings, non-terminal requests,
 * dialog cards, outbox parts). Explicit, documented exceptions are non-security bookkeeping:
 * TTL expiry, terminal request metadata (oldest evicted beyond 2 000), the diagnostic undecodable
 * ring. Admission also computes the post-write size against the 4 MiB budget BEFORE accepting
 * durable work (R2-c/R2-f): `tracked + delta + reserve > budget` ⇒ `budget` refusal, where
 * `reserve` = flat 32 KiB + 1 KiB per non-terminal request (a request may grow that much through
 * its later transitions; terminal transitions only shrink — payload is deleted).
 *
 * ## Corruption (§5.8 + §R2-f)
 * Unreadable / unsafe / invalid `state.json` ⇒ phase `corrupt`: the bytes are copied to
 * `state.json.bak` (only when they could be read safely), the file is left IN PLACE (so the next
 * boot is corrupt again — fail closed, never "fresh"), `connectorMayStart()` is false and
 * `degradedReasons()` has `state-corrupt`, every mutator refuses `unavailable`. `repair()` (keeps
 * credentials) writes a fresh state with the owner re-seeded; dedup/requests/bindings are cleared and
 * the tenant pin is dropped (re-pinned on the next owner event).
 *
 * No module-scope mutable state; all timers/clocks/fs are seams (`FeishuClock`, `FeishuFs`).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  FEISHU_ACK,
  FEISHU_CAPS,
  FEISHU_CMD_ID_RE,
  FEISHU_IDENTITY,
  FEISHU_NONCE_RE,
  FEISHU_OPEN_ID_RE,
  FEISHU_RECEIVED_BODY_MAX_BYTES,
  FEISHU_REPLY_LIMITS,
  FEISHU_DEBOUNCE,
  FEISHU_SHUTDOWN_BUDGET_MS,
} from "../../protocol/feishu.js";
import type { FeishuDegradedReason } from "../../protocol/feishu.js";
import { ensurePrivateDir, fsErrCode, readPrivateFile, realFeishuFs, writeFileAtomicPrivate } from "./credentials.js";
import type { FeishuFs } from "./credentials.js";
import { systemFeishuClock } from "./http.js";
import type { FeishuClock } from "./http.js";

export const FEISHU_STATE_FILE = "state.json";
export const FEISHU_STATE_BAK_SUFFIX = ".bak";

/** flat admission reserve (envelope growth, small state flips) */
export const FEISHU_STATE_FLAT_RESERVE = 32 * 1024;
/** per non-terminal request: how much a record may still grow through its transitions */
export const FEISHU_STATE_REQUEST_GROWTH = 1024;
/** fixed document overhead assumed by the byte ledger (key names, braces, appId, tenant pin, ring, counters) */
export const FEISHU_STATE_ENVELOPE_BYTES = 4096;
/** outbox slots only a `final` may use (notices are refused earlier) */
export const FEISHU_OUTBOX_FINAL_RESERVE = 64;
/** sent/failed outbox bookkeeping lives this long (queued parts never expire here) */
export const FEISHU_OUTBOX_SETTLED_TTL_MS = 3_600_000;
export const FEISHU_UNDECODABLE_RING = 16;
export const FEISHU_UNDECODABLE_NOTICE_GAP_MS = 3_600_000;
export const FEISHU_STATE_RETRY_MS = 1_000;

// ---------------------------------------------------------------------------
// shared types
// ---------------------------------------------------------------------------

export type Refusal = "cap" | "budget" | "exists" | "invalid" | "unavailable" | "payload-too-large" | "recent";
export type Admit<T> = { ok: true; value: T } | { ok: false; refused: Refusal };

export const REQUEST_STATES = [
  "received",
  "dispatching",
  "accepted",
  "rejected",
  "uncertain",
  "replied",
  "reply-failed",
  "unattributed",
  "revoked",
  "expired",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export const TERMINAL_REQUEST_STATES: readonly RequestState[] = [
  "rejected",
  "replied",
  "reply-failed",
  "unattributed",
  "revoked",
  "expired",
];
export function isTerminalRequestState(state: RequestState): boolean {
  return TERMINAL_REQUEST_STATES.includes(state);
}

/** Legal §5.4 transitions (terminal states have none). */
export const REQUEST_TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  received: ["dispatching", "rejected", "revoked", "expired"],
  dispatching: ["accepted", "rejected", "uncertain"],
  accepted: ["replied", "reply-failed", "unattributed", "expired", "rejected"],
  uncertain: ["accepted", "rejected", "replied", "reply-failed", "unattributed", "expired"],
  rejected: [],
  replied: [],
  "reply-failed": [],
  unattributed: [],
  revoked: [],
  expired: [],
};

/** §R2-c durable payload: deleted on any terminal state. */
export interface RequestPayload {
  /** ≤16 KiB UTF-8 (longer inbound text is staged as a `.txt` attachment by F6/F8) */
  body: string;
  /** ordered member message ids */
  messageIds: string[];
  /** committed + pinned upload ids */
  uploadIds: string[];
}

export interface FeishuRequestRecord {
  /** = cmdId (`fs…`, deterministic from the batch) */
  id: string;
  /** sha256 hex of the sorted member message ids */
  batchId: string;
  state: RequestState;
  createdAt: number;
  stateAt: number;
  // frozen at batch close (§5.4 / R1 #9)
  sessionId: string;
  bindingKey: string;
  bindingRev: number;
  senderOpenId: string;
  /** already sanitized for the §R2-a header (≤32 code points) */
  senderDisplay: string;
  chatLabel: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  /** message the reply targets */
  triggerMessageId: string;
  /** sha256 hex of the dispatched body */
  textDigest: string;
  payload?: RequestPayload;
  agentKey?: string;
  dispatchedAt?: number;
  /** reject / failure code (static, ≤64 B) */
  code?: string;
  /** Typing reaction id (to remove it) */
  reactionId?: string;
}

export type NewRequestInput = Omit<
  FeishuRequestRecord,
  "state" | "createdAt" | "stateAt" | "payload" | "agentKey" | "dispatchedAt" | "code" | "reactionId"
> & { payload: RequestPayload };

export interface RequestPatch {
  agentKey?: string;
  dispatchedAt?: number;
  code?: string;
  reactionId?: string;
}

export interface FeishuBinding {
  key: string;
  /** strictly increases on EVERY change (store-wide counter — survives remove/recreate) */
  rev: number;
  sessionId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  label?: string;
  /** e.g. `session-changed` */
  offline?: string;
  updatedAt: number;
}
export interface BindingInput {
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  /** `null` clears */
  sessionId?: string | null;
  label?: string | null;
  offline?: string | null;
}

export const DIALOG_CARD_STATUSES = ["open", "answered", "closed", "expired", "unknown"] as const;
export type DialogCardStatus = (typeof DIALOG_CARD_STATUSES)[number];
export interface FeishuDialogCard {
  id: string;
  agentKey: string;
  dialogId: string;
  epoch: number;
  bindingKey: string;
  chatId: string;
  /** the card's own message id */
  messageId: string;
  /** short code `#k3` */
  shortCode: string;
  status: DialogCardStatus;
  createdAt: number;
  expiresAt: number;
}
export type NewDialogCardInput = Omit<FeishuDialogCard, "status" | "createdAt" | "expiresAt">;

/** §4.3: a card nonce's server record. */
export interface FeishuNonce {
  nonce: string;
  installGen: number;
  tenantKey: string;
  operatorOpenId: string;
  chatId: string;
  messageId: string;
  action: string;
  target: string;
  createdAt: number;
  expiresAt: number;
}
export type NewNonceInput = Omit<FeishuNonce, "nonce" | "createdAt" | "expiresAt">;
export type RedeemResult =
  { ok: true; record: FeishuNonce } | { ok: false; reason: "unknown" | "expired" | "mismatch" | "unavailable" };

export interface FeishuApproval {
  senderOpenId: string;
  senderDisplay: string;
  state: "pending" | "ignored";
  askedAt: number;
  expiresAt: number;
  nonce?: string;
  cardMessageId?: string;
}

export const OUTBOX_MSG_TYPES = ["text", "post", "interactive", "image", "file"] as const;
export interface FeishuOutboxPart {
  /** the Feishu `uuid` (`^[A-Za-z0-9_-]{1,50}$`): reused on every retry */
  sendId: string;
  requestId?: string;
  kind: "final" | "notice";
  state: "queued" | "sent" | "failed";
  route: "reply" | "send";
  /** message id (reply) or chat/open id (send) */
  targetId: string;
  receiveIdType?: "chat_id" | "open_id";
  inThread?: boolean;
  msgType: (typeof OUTBOX_MSG_TYPES)[number];
  /** serialized content (≤ one card); dropped once the part is `sent`/`failed` */
  content?: string;
  part?: number;
  parts?: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  code?: string;
}
export type NewOutboxPartInput = Omit<
  FeishuOutboxPart,
  "state" | "attempts" | "createdAt" | "updatedAt" | "code" | "content"
> & { content: string };
export interface OutboxPatch {
  state?: "queued" | "sent" | "failed";
  attempts?: number;
  code?: string;
}

export interface UndecodableEntry {
  at: number;
  reason: string;
  sha8?: string;
}
export interface UndecodableSnapshot {
  count: number;
  lastAt?: number;
  noticeAt?: number;
  ring: UndecodableEntry[];
}

export type PersistHealth = { persistFailed: boolean };

// ---------------------------------------------------------------------------
// validation helpers (strict, never throw)
// ---------------------------------------------------------------------------

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function onlyKeys(r: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const k of Object.keys(r)) if (!keys.includes(k)) return false;
  return true;
}
function isNat(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
const CONTROL_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
function isText(v: unknown, maxBytes: number): v is string {
  return typeof v === "string" && v.length > 0 && utf8(v) <= maxBytes && !CONTROL_RE.test(v);
}
const HEX64_RE = /^[0-9a-f]{64}$/;
const TENANT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEDUP_KEY_RE = /^[em]:[A-Za-z0-9_.:-]{1,100}$/;
const SEND_ID_RE = /^[A-Za-z0-9_-]{1,50}$/;
const ACTION_RE = /^[a-z0-9_.-]{1,32}$/;
const SHA8_RE = /^[0-9a-f]{8}$/;
const ID_MAX = 256;
const BINDING_KEY_MAX = 520;
const DISPLAY_MAX = 160;
const CODE_MAX = 64;
const TARGET_MAX = 512;

function parseAllow(key: string, raw: unknown): number | undefined {
  return FEISHU_OPEN_ID_RE.test(key) && isNat(raw) ? raw : undefined;
}
function parseDedup(key: string, raw: unknown): number | undefined {
  return DEDUP_KEY_RE.test(key) && isNat(raw) ? raw : undefined;
}

const REQUEST_KEYS = [
  "id",
  "batchId",
  "state",
  "createdAt",
  "stateAt",
  "sessionId",
  "bindingKey",
  "bindingRev",
  "senderOpenId",
  "senderDisplay",
  "chatLabel",
  "chatId",
  "chatType",
  "threadId",
  "triggerMessageId",
  "textDigest",
  "payload",
  "agentKey",
  "dispatchedAt",
  "code",
  "reactionId",
] as const;

function parsePayload(raw: unknown): RequestPayload | undefined {
  if (!isRec(raw) || !onlyKeys(raw, ["body", "messageIds", "uploadIds"])) return undefined;
  const { body, messageIds, uploadIds } = raw;
  if (typeof body !== "string" || utf8(body) > FEISHU_RECEIVED_BODY_MAX_BYTES) return undefined;
  if (!Array.isArray(messageIds) || messageIds.length > 64 || !messageIds.every((m) => isText(m, ID_MAX)))
    return undefined;
  if (
    !Array.isArray(uploadIds) ||
    uploadIds.length > FEISHU_DEBOUNCE.maxAttachments ||
    !uploadIds.every((m) => isText(m, ID_MAX))
  )
    return undefined;
  return { body, messageIds: [...(messageIds as string[])], uploadIds: [...(uploadIds as string[])] };
}

function parseRequest(key: string, raw: unknown): FeishuRequestRecord | undefined {
  if (!isRec(raw) || !onlyKeys(raw, REQUEST_KEYS)) return undefined;
  const r = raw;
  const state = r["state"];
  if (typeof state !== "string" || !(REQUEST_STATES as readonly string[]).includes(state)) return undefined;
  const id = r["id"];
  if (typeof id !== "string" || id !== key || !FEISHU_CMD_ID_RE.test(id)) return undefined;
  if (typeof r["batchId"] !== "string" || !HEX64_RE.test(r["batchId"])) return undefined;
  if (typeof r["textDigest"] !== "string" || !HEX64_RE.test(r["textDigest"])) return undefined;
  if (!isNat(r["createdAt"]) || !isNat(r["stateAt"]) || !isNat(r["bindingRev"])) return undefined;
  if (!isText(r["sessionId"], ID_MAX) || !isText(r["bindingKey"], BINDING_KEY_MAX)) return undefined;
  if (typeof r["senderOpenId"] !== "string" || !FEISHU_OPEN_ID_RE.test(r["senderOpenId"])) return undefined;
  if (!isText(r["senderDisplay"], DISPLAY_MAX) || !isText(r["chatLabel"], DISPLAY_MAX)) return undefined;
  if (!isText(r["chatId"], ID_MAX) || !isText(r["triggerMessageId"], ID_MAX)) return undefined;
  if (r["chatType"] !== "p2p" && r["chatType"] !== "group") return undefined;
  if (r["threadId"] !== undefined && !isText(r["threadId"], ID_MAX)) return undefined;
  if (r["agentKey"] !== undefined && !isText(r["agentKey"], ID_MAX)) return undefined;
  if (r["dispatchedAt"] !== undefined && !isNat(r["dispatchedAt"])) return undefined;
  if (r["code"] !== undefined && !isText(r["code"], CODE_MAX)) return undefined;
  if (r["reactionId"] !== undefined && !isText(r["reactionId"], ID_MAX)) return undefined;
  const terminal = isTerminalRequestState(state as RequestState);
  let payload: RequestPayload | undefined;
  if (r["payload"] !== undefined) {
    payload = parsePayload(r["payload"]);
    if (payload === undefined || terminal) return undefined;
  } else if (!terminal) {
    return undefined; // a non-terminal request without its durable payload cannot be recovered
  }
  const out: FeishuRequestRecord = {
    id,
    batchId: r["batchId"],
    state: state as RequestState,
    createdAt: r["createdAt"],
    stateAt: r["stateAt"],
    sessionId: r["sessionId"],
    bindingKey: r["bindingKey"],
    bindingRev: r["bindingRev"],
    senderOpenId: r["senderOpenId"],
    senderDisplay: r["senderDisplay"],
    chatLabel: r["chatLabel"],
    chatId: r["chatId"],
    chatType: r["chatType"],
    triggerMessageId: r["triggerMessageId"],
    textDigest: r["textDigest"],
  };
  if (r["threadId"] !== undefined) out.threadId = r["threadId"] as string;
  if (payload !== undefined) out.payload = payload;
  if (r["agentKey"] !== undefined) out.agentKey = r["agentKey"] as string;
  if (r["dispatchedAt"] !== undefined) out.dispatchedAt = r["dispatchedAt"] as number;
  if (r["code"] !== undefined) out.code = r["code"] as string;
  if (r["reactionId"] !== undefined) out.reactionId = r["reactionId"] as string;
  return out;
}

const BINDING_KEYS = [
  "key",
  "rev",
  "sessionId",
  "chatId",
  "chatType",
  "threadId",
  "label",
  "offline",
  "updatedAt",
] as const;
function parseBinding(key: string, raw: unknown): FeishuBinding | undefined {
  if (!isRec(raw) || !onlyKeys(raw, BINDING_KEYS)) return undefined;
  if (raw["key"] !== key || !isText(key, BINDING_KEY_MAX)) return undefined;
  if (!isNat(raw["rev"]) || !isNat(raw["updatedAt"])) return undefined;
  if (!isText(raw["chatId"], ID_MAX)) return undefined;
  if (raw["chatType"] !== "p2p" && raw["chatType"] !== "group") return undefined;
  for (const k of ["sessionId", "threadId"] as const)
    if (raw[k] !== undefined && !isText(raw[k], ID_MAX)) return undefined;
  if (raw["label"] !== undefined && !isText(raw["label"], DISPLAY_MAX)) return undefined;
  if (raw["offline"] !== undefined && !isText(raw["offline"], CODE_MAX)) return undefined;
  const out: FeishuBinding = {
    key,
    rev: raw["rev"],
    chatId: raw["chatId"],
    chatType: raw["chatType"],
    updatedAt: raw["updatedAt"],
  };
  if (raw["sessionId"] !== undefined) out.sessionId = raw["sessionId"] as string;
  if (raw["threadId"] !== undefined) out.threadId = raw["threadId"] as string;
  if (raw["label"] !== undefined) out.label = raw["label"] as string;
  if (raw["offline"] !== undefined) out.offline = raw["offline"] as string;
  return out;
}

const DIALOG_KEYS = [
  "id",
  "agentKey",
  "dialogId",
  "epoch",
  "bindingKey",
  "chatId",
  "messageId",
  "shortCode",
  "status",
  "createdAt",
  "expiresAt",
] as const;
function parseDialogCard(key: string, raw: unknown): FeishuDialogCard | undefined {
  if (!isRec(raw) || !onlyKeys(raw, DIALOG_KEYS) || raw["id"] !== key || !isText(key, ID_MAX * 2)) return undefined;
  if (!isText(raw["agentKey"], ID_MAX) || !isText(raw["dialogId"], ID_MAX) || !isNat(raw["epoch"])) return undefined;
  if (!isText(raw["bindingKey"], BINDING_KEY_MAX) || !isText(raw["chatId"], ID_MAX)) return undefined;
  if (!isText(raw["messageId"], ID_MAX) || !isText(raw["shortCode"], 16)) return undefined;
  const status = raw["status"];
  if (typeof status !== "string" || !(DIALOG_CARD_STATUSES as readonly string[]).includes(status)) return undefined;
  if (!isNat(raw["createdAt"]) || !isNat(raw["expiresAt"])) return undefined;
  return {
    id: key,
    agentKey: raw["agentKey"],
    dialogId: raw["dialogId"],
    epoch: raw["epoch"],
    bindingKey: raw["bindingKey"],
    chatId: raw["chatId"],
    messageId: raw["messageId"],
    shortCode: raw["shortCode"],
    status: status as DialogCardStatus,
    createdAt: raw["createdAt"],
    expiresAt: raw["expiresAt"],
  };
}

const NONCE_KEYS = [
  "nonce",
  "installGen",
  "tenantKey",
  "operatorOpenId",
  "chatId",
  "messageId",
  "action",
  "target",
  "createdAt",
  "expiresAt",
] as const;
function parseNonce(key: string, raw: unknown): FeishuNonce | undefined {
  if (!isRec(raw) || !onlyKeys(raw, NONCE_KEYS) || raw["nonce"] !== key || !FEISHU_NONCE_RE.test(key)) return undefined;
  if (typeof raw["installGen"] !== "number" || !Number.isSafeInteger(raw["installGen"]) || raw["installGen"] <= 0)
    return undefined;
  if (typeof raw["tenantKey"] !== "string" || !TENANT_KEY_RE.test(raw["tenantKey"])) return undefined;
  if (typeof raw["operatorOpenId"] !== "string" || !FEISHU_OPEN_ID_RE.test(raw["operatorOpenId"])) return undefined;
  if (!isText(raw["chatId"], ID_MAX) || !isText(raw["messageId"], ID_MAX)) return undefined;
  if (typeof raw["action"] !== "string" || !ACTION_RE.test(raw["action"])) return undefined;
  if (typeof raw["target"] !== "string" || utf8(raw["target"]) > TARGET_MAX || CONTROL_RE.test(raw["target"]))
    return undefined;
  if (!isNat(raw["createdAt"]) || !isNat(raw["expiresAt"])) return undefined;
  return {
    nonce: key,
    installGen: raw["installGen"],
    tenantKey: raw["tenantKey"],
    operatorOpenId: raw["operatorOpenId"],
    chatId: raw["chatId"],
    messageId: raw["messageId"],
    action: raw["action"],
    target: raw["target"],
    createdAt: raw["createdAt"],
    expiresAt: raw["expiresAt"],
  };
}

const APPROVAL_KEYS = [
  "senderOpenId",
  "senderDisplay",
  "state",
  "askedAt",
  "expiresAt",
  "nonce",
  "cardMessageId",
] as const;
function parseApproval(key: string, raw: unknown): FeishuApproval | undefined {
  if (!isRec(raw) || !onlyKeys(raw, APPROVAL_KEYS) || raw["senderOpenId"] !== key || !FEISHU_OPEN_ID_RE.test(key))
    return undefined;
  if (!isText(raw["senderDisplay"], DISPLAY_MAX)) return undefined;
  if (raw["state"] !== "pending" && raw["state"] !== "ignored") return undefined;
  if (!isNat(raw["askedAt"]) || !isNat(raw["expiresAt"])) return undefined;
  if (raw["nonce"] !== undefined && (typeof raw["nonce"] !== "string" || !FEISHU_NONCE_RE.test(raw["nonce"])))
    return undefined;
  if (raw["cardMessageId"] !== undefined && !isText(raw["cardMessageId"], ID_MAX)) return undefined;
  const out: FeishuApproval = {
    senderOpenId: key,
    senderDisplay: raw["senderDisplay"],
    state: raw["state"],
    askedAt: raw["askedAt"],
    expiresAt: raw["expiresAt"],
  };
  if (raw["nonce"] !== undefined) out.nonce = raw["nonce"] as string;
  if (raw["cardMessageId"] !== undefined) out.cardMessageId = raw["cardMessageId"] as string;
  return out;
}

const OUTBOX_KEYS = [
  "sendId",
  "requestId",
  "kind",
  "state",
  "route",
  "targetId",
  "receiveIdType",
  "inThread",
  "msgType",
  "content",
  "part",
  "parts",
  "attempts",
  "createdAt",
  "updatedAt",
  "code",
] as const;
function parseOutbox(key: string, raw: unknown): FeishuOutboxPart | undefined {
  if (!isRec(raw) || !onlyKeys(raw, OUTBOX_KEYS) || raw["sendId"] !== key || !SEND_ID_RE.test(key)) return undefined;
  if (raw["requestId"] !== undefined && !isText(raw["requestId"], ID_MAX)) return undefined;
  if (raw["kind"] !== "final" && raw["kind"] !== "notice") return undefined;
  const state = raw["state"];
  if (state !== "queued" && state !== "sent" && state !== "failed") return undefined;
  if (raw["route"] !== "reply" && raw["route"] !== "send") return undefined;
  if (!isText(raw["targetId"], ID_MAX)) return undefined;
  if (raw["receiveIdType"] !== undefined && raw["receiveIdType"] !== "chat_id" && raw["receiveIdType"] !== "open_id")
    return undefined;
  if (raw["inThread"] !== undefined && typeof raw["inThread"] !== "boolean") return undefined;
  const msgType = raw["msgType"];
  if (typeof msgType !== "string" || !(OUTBOX_MSG_TYPES as readonly string[]).includes(msgType)) return undefined;
  if (state === "queued") {
    if (typeof raw["content"] !== "string" || utf8(raw["content"]) > FEISHU_REPLY_LIMITS.maxCardBytes) return undefined;
  } else if (raw["content"] !== undefined) return undefined;
  if (raw["part"] !== undefined && !isNat(raw["part"])) return undefined;
  if (raw["parts"] !== undefined && !isNat(raw["parts"])) return undefined;
  if (!isNat(raw["attempts"]) || !isNat(raw["createdAt"]) || !isNat(raw["updatedAt"])) return undefined;
  if (raw["code"] !== undefined && !isText(raw["code"], CODE_MAX)) return undefined;
  const out: FeishuOutboxPart = {
    sendId: key,
    kind: raw["kind"],
    state,
    route: raw["route"],
    targetId: raw["targetId"],
    msgType: msgType as FeishuOutboxPart["msgType"],
    attempts: raw["attempts"],
    createdAt: raw["createdAt"],
    updatedAt: raw["updatedAt"],
  };
  if (raw["requestId"] !== undefined) out.requestId = raw["requestId"] as string;
  if (raw["receiveIdType"] !== undefined) out.receiveIdType = raw["receiveIdType"] as "chat_id" | "open_id";
  if (raw["inThread"] !== undefined) out.inThread = raw["inThread"] as boolean;
  if (raw["content"] !== undefined) out.content = raw["content"] as string;
  if (raw["part"] !== undefined) out.part = raw["part"] as number;
  if (raw["parts"] !== undefined) out.parts = raw["parts"] as number;
  if (raw["code"] !== undefined) out.code = raw["code"] as string;
  return out;
}

function parseUndecodable(raw: unknown): UndecodableSnapshot | undefined {
  if (!isRec(raw) || !onlyKeys(raw, ["count", "lastAt", "noticeAt", "ring"])) return undefined;
  if (!isNat(raw["count"])) return undefined;
  if (raw["lastAt"] !== undefined && !isNat(raw["lastAt"])) return undefined;
  if (raw["noticeAt"] !== undefined && !isNat(raw["noticeAt"])) return undefined;
  const ring = raw["ring"];
  if (!Array.isArray(ring) || ring.length > FEISHU_UNDECODABLE_RING) return undefined;
  const entries: UndecodableEntry[] = [];
  for (const e of ring) {
    if (!isRec(e) || !onlyKeys(e, ["at", "reason", "sha8"]) || !isNat(e["at"]) || !isText(e["reason"], CODE_MAX))
      return undefined;
    if (e["sha8"] !== undefined && (typeof e["sha8"] !== "string" || !SHA8_RE.test(e["sha8"]))) return undefined;
    const entry: UndecodableEntry = { at: e["at"], reason: e["reason"] };
    if (e["sha8"] !== undefined) entry.sha8 = e["sha8"];
    entries.push(entry);
  }
  const out: UndecodableSnapshot = { count: raw["count"], ring: entries };
  if (raw["lastAt"] !== undefined) out.lastAt = raw["lastAt"] as number;
  if (raw["noticeAt"] !== undefined) out.noticeAt = raw["noticeAt"] as number;
  return out;
}

// ---------------------------------------------------------------------------
// byte-ledgered table
// ---------------------------------------------------------------------------

interface Entry<T> {
  v: T;
  cost: number;
}
/** Exactly the bytes one `"key":value,` member takes in the compact document. */
function costOf(key: string, value: unknown): number {
  return utf8(JSON.stringify(key)) + utf8(JSON.stringify(value)) + 2;
}

class Table<T> {
  readonly map = new Map<string, Entry<T>>();
  bytes = 0;
  constructor(
    readonly name: string,
    readonly cap: number,
  ) {}
  get size(): number {
    return this.map.size;
  }
  get(key: string): T | undefined {
    return this.map.get(key)?.v;
  }
  /** Delta in ledger bytes if `key` were set to `value` (does not mutate). */
  delta(key: string, value: T): number {
    return costOf(key, value) - (this.map.get(key)?.cost ?? 0);
  }
  set(key: string, value: T): void {
    const cost = costOf(key, value);
    this.bytes += cost - (this.map.get(key)?.cost ?? 0);
    this.map.set(key, { v: value, cost });
  }
  delete(key: string): boolean {
    const e = this.map.get(key);
    if (e === undefined) return false;
    this.bytes -= e.cost;
    this.map.delete(key);
    return true;
  }
  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
  *values(): IterableIterator<T> {
    for (const e of this.map.values()) yield e.v;
  }
  *entries(): IterableIterator<[string, T]> {
    for (const [k, e] of this.map) yield [k, e.v];
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export type StatePhase = "unloaded" | "ok" | "corrupt";

export type StateLoadOutcome =
  { kind: "fresh" } | { kind: "loaded" } | { kind: "corrupt"; reason: string; backedUp: boolean };

export interface StateUsage {
  bytes: number;
  budget: number;
  reserve: number;
  counts: {
    allowList: number;
    dedup: number;
    requestsNonTerminal: number;
    requestsTerminal: number;
    bindings: number;
    dialogCards: number;
    nonces: number;
    approvals: number;
    outbox: number;
  };
  appliedSeq: number;
  durableSeq: number;
}

export interface FeishuStateDeps {
  /** `<stateDir>/feishu-bot` */
  dir: string;
  fs?: FeishuFs;
  clock?: FeishuClock;
  /** crypto-random seam for nonces (tests only) */
  random?: (n: number) => Uint8Array;
  groupCommitMs?: number;
  commitDeadlineMs?: number;
  retryMs?: number;
  /** fired on every `persistFailed` flip (connector pause / resume + `degraded(persist-failed)`) */
  onHealth?: (health: PersistHealth) => void;
  log?: (event: { event: string; reason?: string; ms?: number }) => void;
}

export interface FeishuState {
  readonly path: string;
  /** Read + validate `state.json`. A missing file is a normal fresh state. Never throws. */
  load(): Promise<StateLoadOutcome>;
  phase(): StatePhase;
  /** `degraded` reasons this module owns: `state-corrupt`, `persist-failed`. */
  degradedReasons(): FeishuDegradedReason[];
  /** §5.8: false while unloaded/corrupt (connector NOT started — fail closed). `persist-failed` pauses via `onHealth`. */
  connectorMayStart(): boolean;
  persistFailed(): boolean;
  corruptReason(): string | undefined;
  /** Everything applied so far is durable (`true`) or not (`false` — do NOT ACK). */
  commit(): Promise<boolean>;
  /** Shutdown flush (≤ `FEISHU_SHUTDOWN_BUDGET_MS.stateFlush` by default); `true` iff nothing is left dirty. */
  flush(budgetMs?: number): Promise<boolean>;
  /** Drop expired entries (TTL stores); returns how many. Runs automatically before each write. */
  sweep(): number;
  usage(): StateUsage;
  /**
   * Bind the state to an installation: when the stored `appId` differs (open_ids are PER APP) every
   * store is wiped and the owner is seeded; same app ⇒ no-op. Committed before resolving.
   */
  adoptInstall(install: {
    appId: string;
    ownerOpenId: string;
  }): Promise<{ ok: true; reset: boolean } | { ok: false; reason: "unavailable" | "persist" }>;
  /** `/webhub feishu repair`: only from `corrupt`. Fresh state, owner re-seeded, tenant un-pinned. */
  repair(install: {
    appId: string;
    ownerOpenId: string;
  }): Promise<{ ok: true } | { ok: false; reason: "not-corrupt" | "write-failed" }>;
  /** `reset`: delete `state.json` (+ `.bak`, tmp) by exact path and return to `unloaded`. */
  destroy(): Promise<{ ok: true } | { ok: false; reason: "io" }>;
  dispose(): void;

  readonly appId: string | undefined;
  readonly tenant: {
    get(): string | undefined;
    /** TOFU pin: first valid key pins; the same key ⇒ `same`; another ⇒ `mismatch` (drop the event). */
    pin(tenantKey: string): "pinned" | "same" | "mismatch" | "invalid" | "unavailable";
  };
  readonly allowList: {
    list(): string[];
    has(openId: string): boolean;
    add(openId: string): Admit<{ added: boolean }>;
    remove(openId: string): boolean;
    readonly size: number;
  };
  readonly dedup: {
    /** `"e:<event_id>"` / `"m:<message_id>"`; `undefined` for an unusable id. */
    keyFor(kind: "event" | "message", id: string): string | undefined;
    /** seen and not expired (memory — see the ACK rule in the module doc) */
    has(key: string): boolean;
    /** at cap ⇒ `cap` (stop ACKing new events, `degraded`); expired entries are pruned first */
    add(key: string): Admit<{ added: boolean }>;
    readonly size: number;
  };
  readonly requests: {
    receive(input: NewRequestInput): Admit<FeishuRequestRecord>;
    get(id: string): FeishuRequestRecord | undefined;
    list(filter?: { states?: readonly RequestState[]; senderOpenId?: string }): FeishuRequestRecord[];
    transition(
      id: string,
      to: RequestState,
      patch?: RequestPatch,
    ):
      | { ok: true; record: FeishuRequestRecord }
      | { ok: false; reason: "unknown" | "illegal" | "invalid" | "unavailable" };
    patch(id: string, patch: RequestPatch): boolean;
    /** §4.2 deny: every `received` request of the sender ⇒ `revoked`; returns the ids. */
    revokeSender(openId: string): string[];
    readonly nonTerminal: number;
    readonly terminal: number;
  };
  readonly bindings: {
    get(key: string): FeishuBinding | undefined;
    list(): FeishuBinding[];
    set(key: string, input: BindingInput): Admit<FeishuBinding>;
    remove(key: string): boolean;
    readonly size: number;
  };
  readonly dialogCards: {
    add(input: NewDialogCardInput): Admit<FeishuDialogCard>;
    get(id: string): FeishuDialogCard | undefined;
    list(): FeishuDialogCard[];
    update(id: string, patch: { status?: DialogCardStatus; messageId?: string }): boolean;
    remove(id: string): boolean;
    readonly size: number;
  };
  readonly nonces: {
    issue(input: NewNonceInput, ttlMs?: number): Admit<FeishuNonce>;
    get(nonce: string): FeishuNonce | undefined;
    /** One-shot: operator/chat/message/tenant/gen must all match; a mismatch does NOT consume (no DoS on the legit holder). */
    redeem(ctx: {
      nonce: string;
      operatorOpenId: string;
      chatId: string;
      messageId: string;
      tenantKey: string;
      installGen: number;
    }): RedeemResult;
    /** §4.2 revocation: drop every nonce issued to an operator; returns how many. */
    purgeOperator(openId: string): number;
    readonly size: number;
  };
  readonly approvals: {
    /** ≤1 per sender per 24 h (`recent`), ≤16 entries (`cap`). */
    ask(senderOpenId: string, senderDisplay: string): Admit<FeishuApproval>;
    get(senderOpenId: string): FeishuApproval | undefined;
    list(): FeishuApproval[];
    attach(senderOpenId: string, card: { nonce?: string; cardMessageId?: string }): boolean;
    /** `allowed` removes the entry (the sender is allow-listed now); `ignored` keeps it as the 24 h gate. */
    resolve(senderOpenId: string, outcome: "allowed" | "ignored"): boolean;
    readonly size: number;
  };
  readonly outbox: {
    add(input: NewOutboxPartInput): Admit<FeishuOutboxPart>;
    get(sendId: string): FeishuOutboxPart | undefined;
    list(filter?: { state?: "queued" | "sent" | "failed" }): FeishuOutboxPart[];
    /** `sent`/`failed` drop the content. */
    update(sendId: string, patch: OutboxPatch): boolean;
    remove(sendId: string): boolean;
    readonly size: number;
  };
  readonly undecodable: {
    /** Always accepted (bounded ring); the caller commits before the ACK. */
    record(entry: { reason: string; sha8?: string }): void;
    snapshot(): UndecodableSnapshot;
    /** §2.3: owner notice ≤1/h */
    noticeDue(): boolean;
    markNotice(): void;
  };
}

const TOP_KEYS = [
  "v",
  "appId",
  "tenantKey",
  "revSeq",
  "allowList",
  "dedup",
  "requests",
  "bindings",
  "dialogCards",
  "nonces",
  "approvals",
  "outbox",
  "undecodable",
] as const;

export function createFeishuState(deps: FeishuStateDeps): FeishuState {
  const fs = deps.fs ?? realFeishuFs;
  const clock = deps.clock ?? systemFeishuClock;
  const random = deps.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const groupCommitMs = deps.groupCommitMs ?? FEISHU_ACK.groupCommitMs;
  const commitDeadlineMs = deps.commitDeadlineMs ?? FEISHU_ACK.commitDeadlineMs;
  const retryMs = deps.retryMs ?? FEISHU_STATE_RETRY_MS;
  const path = join(deps.dir, FEISHU_STATE_FILE);
  const bakPath = `${path}${FEISHU_STATE_BAK_SUFFIX}`;
  const budget = FEISHU_CAPS.stateMaxBytes;

  const allow = new Table<number>("allowList", FEISHU_CAPS.allowList);
  const dedup = new Table<number>("dedup", FEISHU_CAPS.dedup);
  const requests = new Table<FeishuRequestRecord>("requests", Number.MAX_SAFE_INTEGER);
  const bindings = new Table<FeishuBinding>("bindings", FEISHU_CAPS.bindings);
  const dialogs = new Table<FeishuDialogCard>("dialogCards", FEISHU_CAPS.dialogCards);
  const nonces = new Table<FeishuNonce>("nonces", FEISHU_CAPS.nonces);
  const approvals = new Table<FeishuApproval>("approvals", FEISHU_CAPS.approvals);
  const outbox = new Table<FeishuOutboxPart>("outbox", FEISHU_CAPS.outboxParts);
  const tables = [allow, dedup, requests, bindings, dialogs, nonces, approvals, outbox];

  let appId: string | undefined;
  let tenantKey: string | undefined;
  let revSeq = 0;
  let undec: UndecodableSnapshot = { count: 0, ring: [] };
  let nonTerminal = 0;
  let terminal = 0;

  let phase: StatePhase = "unloaded";
  let corruptWhy: string | undefined;
  let disposed = false;

  let appliedSeq = 0;
  let durableSeq = 0;
  let writing: Promise<void> | undefined;
  let flushTimer: unknown;
  let retryTimer: unknown;
  let persistFailed = false;
  let dirReady = false;
  const waiters: Array<{ seq: number; resolve: (ok: boolean) => void; timer: unknown }> = [];

  function log(event: string, reason?: string): void {
    try {
      deps.log?.({ event, ...(reason !== undefined ? { reason } : {}) });
    } catch {
      /* observers never affect state */
    }
  }

  // ----- ledger / admission ------------------------------------------------

  const tracked = (): number => FEISHU_STATE_ENVELOPE_BYTES + tables.reduce((n, t) => n + t.bytes, 0);
  const reserve = (): number => FEISHU_STATE_FLAT_RESERVE + nonTerminal * FEISHU_STATE_REQUEST_GROWTH;
  /** `budget` refusal when `delta` more bytes (plus the growth reserve) would not fit the 4 MiB document. */
  const overBudget = (delta: number): boolean => delta > 0 && tracked() + delta + reserve() > budget;

  function resetMemory(): void {
    for (const t of tables) t.clear();
    appId = undefined;
    tenantKey = undefined;
    revSeq = 0;
    undec = { count: 0, ring: [] };
    nonTerminal = 0;
    terminal = 0;
  }

  // ----- group commit ------------------------------------------------------

  function setPersistFailed(value: boolean): void {
    if (persistFailed === value) return;
    persistFailed = value;
    try {
      deps.onHealth?.({ persistFailed: value });
    } catch {
      /* observers never affect state */
    }
  }

  function settleWaiters(): void {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.seq <= durableSeq) {
        waiters.splice(i, 1);
        clock.clearTimeout(w.timer);
        w.resolve(true);
      }
    }
  }
  function failWaiters(): void {
    for (const w of waiters.splice(0)) {
      clock.clearTimeout(w.timer);
      w.resolve(false);
    }
  }

  function schedule(ms: number): void {
    if (disposed || phase !== "ok") return;
    if (flushTimer !== undefined || writing !== undefined || retryTimer !== undefined) return;
    flushTimer = clock.setTimeout(() => {
      flushTimer = undefined;
      void runWriter();
    }, ms);
  }

  function touch(): void {
    if (phase !== "ok") return;
    appliedSeq += 1;
    schedule(groupCommitMs);
  }

  function serialize(): Uint8Array {
    const doc: Record<string, unknown> = { v: 1 };
    if (appId !== undefined) doc["appId"] = appId;
    if (tenantKey !== undefined) doc["tenantKey"] = tenantKey;
    doc["revSeq"] = revSeq;
    const dump = <T>(t: Table<T>): Record<string, T> => {
      const o: Record<string, T> = {};
      for (const [k, v] of t.entries()) Object.defineProperty(o, k, { value: v, enumerable: true });
      return o;
    };
    doc["allowList"] = dump(allow);
    doc["dedup"] = dump(dedup);
    doc["requests"] = dump(requests);
    doc["bindings"] = dump(bindings);
    doc["dialogCards"] = dump(dialogs);
    doc["nonces"] = dump(nonces);
    doc["approvals"] = dump(approvals);
    doc["outbox"] = dump(outbox);
    doc["undecodable"] = undec;
    const bytes = new TextEncoder().encode(`${JSON.stringify(doc)}\n`);
    if (bytes.length > budget) throw new Error("state-too-large");
    return bytes;
  }

  function armRetry(): void {
    if (disposed || retryTimer !== undefined) return;
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      void runWriter();
    }, retryMs);
  }

  function fail(reason: string): void {
    log("persist-failed", reason);
    setPersistFailed(true);
    failWaiters();
    armRetry();
  }

  function runWriter(): Promise<void> {
    if (writing !== undefined) return writing;
    const p = (async (): Promise<void> => {
      try {
        while (!disposed && phase === "ok" && durableSeq < appliedSeq) {
          const target = appliedSeq;
          sweepExpired();
          let bytes: Uint8Array;
          try {
            bytes = serialize();
          } catch {
            return fail("serialize");
          }
          try {
            if (!dirReady) {
              const dir = await ensurePrivateDir(fs, deps.dir);
              if (!dir.ok) throw new Error(dir.check);
              dirReady = true;
            }
            await writeFileAtomicPrivate(fs, path, bytes);
          } catch {
            return fail("write");
          }
          if (phase !== "ok") return; // destroyed/repaired while writing
          durableSeq = Math.max(durableSeq, target);
          setPersistFailed(false);
          settleWaiters();
        }
      } finally {
        writing = undefined;
      }
    })();
    writing = p;
    return p;
  }

  function commit(): Promise<boolean> {
    if (phase !== "ok") return Promise.resolve(false);
    if (durableSeq >= appliedSeq) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = {
        seq: appliedSeq,
        resolve,
        timer: clock.setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          setPersistFailed(true); // §2.4: not durable within 1.5 s ⇒ degraded(persist-failed) until a write lands
          resolve(false);
        }, commitDeadlineMs),
      };
      waiters.push(waiter);
      schedule(groupCommitMs);
    });
  }

  async function flush(budgetMs: number = FEISHU_SHUTDOWN_BUDGET_MS.stateFlush): Promise<boolean> {
    if (phase !== "ok") return phase !== "corrupt";
    if (durableSeq >= appliedSeq) return true;
    if (flushTimer !== undefined) {
      clock.clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (retryTimer !== undefined) {
      clock.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    let timer: unknown;
    const timeout = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, budgetMs);
    });
    try {
      await Promise.race([runWriter(), timeout]);
    } finally {
      clock.clearTimeout(timer);
    }
    return durableSeq >= appliedSeq;
  }

  // ----- TTL sweep ---------------------------------------------------------

  function sweepExpired(): number {
    const now = clock.now();
    let removed = 0;
    for (const [k, seenAt] of [...dedup.entries()]) {
      if (now - seenAt > FEISHU_CAPS.dedupTtlMs) {
        dedup.delete(k);
        removed++;
      }
    }
    for (const [k, rec] of [...requests.entries()]) {
      if (isTerminalRequestState(rec.state) && now - rec.stateAt > FEISHU_CAPS.terminalTtlMs) {
        requests.delete(k);
        terminal--;
        removed++;
      }
    }
    for (const [k, d] of [...dialogs.entries()]) if (d.expiresAt <= now && dialogs.delete(k)) removed++;
    for (const [k, n] of [...nonces.entries()]) if (n.expiresAt <= now && nonces.delete(k)) removed++;
    for (const [k, a] of [...approvals.entries()]) if (a.expiresAt <= now && approvals.delete(k)) removed++;
    for (const [k, o] of [...outbox.entries()]) {
      if (o.state !== "queued" && now - o.updatedAt > FEISHU_OUTBOX_SETTLED_TTL_MS && outbox.delete(k)) removed++;
    }
    return removed;
  }

  // ----- load / validation -------------------------------------------------

  function parseTable<T>(
    t: Table<T>,
    raw: unknown,
    parse: (key: string, value: unknown) => T | undefined,
    cap: number,
  ): boolean {
    if (!isRec(raw)) return false;
    const keys = Object.keys(raw);
    if (keys.length > cap) return false;
    for (const key of keys) {
      const v = parse(key, raw[key]);
      if (v === undefined) return false;
      t.set(key, v);
    }
    return true;
  }

  /** Strict full-document validation into memory; `undefined` = ok, else the static reason. */
  function ingest(doc: unknown): string | undefined {
    if (!isRec(doc) || !onlyKeys(doc, TOP_KEYS)) return "schema";
    if (doc["v"] !== 1) return "version";
    const id = doc["appId"];
    if (id !== undefined && (typeof id !== "string" || id.length === 0 || id.length > 80)) return "app-id";
    const tk = doc["tenantKey"];
    if (tk !== undefined && (typeof tk !== "string" || !TENANT_KEY_RE.test(tk))) return "tenant-key";
    if (!isNat(doc["revSeq"])) return "rev-seq";
    if (!parseTable(allow, doc["allowList"], parseAllow, FEISHU_CAPS.allowList)) return "allow-list";
    if (!parseTable(dedup, doc["dedup"], parseDedup, FEISHU_CAPS.dedup)) return "dedup";
    if (
      !parseTable(
        requests,
        doc["requests"],
        parseRequest,
        FEISHU_CAPS.requestsNonTerminal + FEISHU_CAPS.terminalMetadata,
      )
    )
      return "requests";
    if (!parseTable(bindings, doc["bindings"], parseBinding, FEISHU_CAPS.bindings)) return "bindings";
    if (!parseTable(dialogs, doc["dialogCards"], parseDialogCard, FEISHU_CAPS.dialogCards)) return "dialog-cards";
    if (!parseTable(nonces, doc["nonces"], parseNonce, FEISHU_CAPS.nonces)) return "nonces";
    if (!parseTable(approvals, doc["approvals"], parseApproval, FEISHU_CAPS.approvals)) return "approvals";
    if (!parseTable(outbox, doc["outbox"], parseOutbox, FEISHU_CAPS.outboxParts)) return "outbox";
    const u = parseUndecodable(doc["undecodable"]);
    if (u === undefined) return "undecodable";
    nonTerminal = 0;
    terminal = 0;
    for (const r of requests.values()) {
      if (isTerminalRequestState(r.state)) terminal++;
      else nonTerminal++;
    }
    if (nonTerminal > FEISHU_CAPS.requestsNonTerminal || terminal > FEISHU_CAPS.terminalMetadata) return "requests-cap";
    for (const b of bindings.values()) if (b.rev > (doc["revSeq"] as number)) return "rev-seq";
    appId = id as string | undefined;
    tenantKey = tk as string | undefined;
    revSeq = doc["revSeq"] as number;
    undec = u;
    if (tracked() > budget) return "budget";
    return undefined;
  }

  async function load(): Promise<StateLoadOutcome> {
    if (phase === "ok") return { kind: "loaded" };
    resetMemory();
    corruptWhy = undefined;
    const res = await readPrivateFile(fs, path, budget);
    if (res.kind === "absent") {
      phase = "ok";
      return { kind: "fresh" };
    }
    let reason: string | undefined;
    let bytes: Uint8Array | undefined;
    if (res.kind === "unsafe") reason = res.check;
    else {
      bytes = res.bytes;
      try {
        reason = ingest(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        reason = "json";
      }
    }
    if (reason === undefined) {
      phase = "ok";
      if (sweepExpired() > 0) touch();
      return { kind: "loaded" };
    }
    resetMemory();
    let backedUp = false;
    if (bytes !== undefined) {
      try {
        if ((await ensurePrivateDir(fs, deps.dir)).ok) {
          await writeFileAtomicPrivate(fs, bakPath, bytes);
          backedUp = true;
        }
      } catch {
        /* the backup is best effort; corruption handling continues */
      }
    }
    phase = "corrupt";
    corruptWhy = reason;
    log("state-corrupt", reason);
    return { kind: "corrupt", reason, backedUp };
  }

  // ----- helpers for mutators ----------------------------------------------

  const live = (): boolean => phase === "ok" && !disposed;
  const clone = <T>(v: T): T => structuredClone(v);

  function expireRequestMetadata(): void {
    // Terminal metadata beyond the cap: oldest first. Non-security bookkeeping (documented exception).
    while (terminal > FEISHU_CAPS.terminalMetadata) {
      let oldest: [string, number] | undefined;
      for (const [k, r] of requests.entries()) {
        if (isTerminalRequestState(r.state) && (oldest === undefined || r.stateAt < oldest[1])) oldest = [k, r.stateAt];
      }
      if (oldest === undefined) return;
      requests.delete(oldest[0]);
      terminal--;
    }
  }

  function applyPatch(rec: FeishuRequestRecord, patch: RequestPatch | undefined): boolean {
    if (patch === undefined) return true;
    if (patch.agentKey !== undefined) {
      if (!isText(patch.agentKey, ID_MAX)) return false;
      rec.agentKey = patch.agentKey;
    }
    if (patch.dispatchedAt !== undefined) {
      if (!isNat(patch.dispatchedAt)) return false;
      rec.dispatchedAt = patch.dispatchedAt;
    }
    if (patch.code !== undefined) {
      if (!isText(patch.code, CODE_MAX)) return false;
      rec.code = patch.code;
    }
    if (patch.reactionId !== undefined) {
      if (!isText(patch.reactionId, ID_MAX)) return false;
      rec.reactionId = patch.reactionId;
    }
    return true;
  }

  function validInstall(i: { appId: string; ownerOpenId: string }): boolean {
    return (
      typeof i.appId === "string" &&
      i.appId.length > 0 &&
      i.appId.length <= 80 &&
      typeof i.ownerOpenId === "string" &&
      FEISHU_OPEN_ID_RE.test(i.ownerOpenId)
    );
  }

  // ----- the public object ---------------------------------------------------

  const state: FeishuState = {
    path,
    load,
    phase: () => phase,
    degradedReasons() {
      const out: FeishuDegradedReason[] = [];
      if (phase === "corrupt") out.push("state-corrupt");
      if (persistFailed) out.push("persist-failed");
      return out;
    },
    connectorMayStart: () => phase === "ok",
    persistFailed: () => persistFailed,
    corruptReason: () => corruptWhy,
    commit,
    flush,
    sweep() {
      const n = sweepExpired();
      if (n > 0) touch();
      return n;
    },
    usage() {
      return {
        bytes: tracked(),
        budget,
        reserve: reserve(),
        counts: {
          allowList: allow.size,
          dedup: dedup.size,
          requestsNonTerminal: nonTerminal,
          requestsTerminal: terminal,
          bindings: bindings.size,
          dialogCards: dialogs.size,
          nonces: nonces.size,
          approvals: approvals.size,
          outbox: outbox.size,
        },
        appliedSeq,
        durableSeq,
      };
    },

    async adoptInstall(install) {
      if (!live() || !validInstall(install)) return { ok: false, reason: "unavailable" };
      if (appId === install.appId) return { ok: true, reset: false };
      for (const t of tables) t.clear();
      nonTerminal = 0;
      terminal = 0;
      tenantKey = undefined;
      appId = install.appId;
      allow.set(install.ownerOpenId, clock.now());
      touch();
      return (await commit()) ? { ok: true, reset: true } : { ok: false, reason: "persist" };
    },

    async repair(install) {
      if (phase !== "corrupt" || disposed) return { ok: false, reason: "not-corrupt" };
      if (!validInstall(install)) return { ok: false, reason: "not-corrupt" };
      if (writing !== undefined) await writing;
      resetMemory();
      appId = install.appId;
      allow.set(install.ownerOpenId, clock.now());
      try {
        const bytes = serialize();
        const dir = await ensurePrivateDir(fs, deps.dir);
        if (!dir.ok) throw new Error(dir.check);
        dirReady = true;
        await writeFileAtomicPrivate(fs, path, bytes);
      } catch {
        resetMemory();
        return { ok: false, reason: "write-failed" };
      }
      phase = "ok";
      corruptWhy = undefined;
      appliedSeq = 0;
      durableSeq = 0;
      setPersistFailed(false);
      log("repaired");
      return { ok: true };
    },

    async destroy() {
      if (flushTimer !== undefined) clock.clearTimeout(flushTimer);
      if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
      flushTimer = undefined;
      retryTimer = undefined;
      phase = "unloaded"; // stops the writer loop at its next check
      failWaiters();
      if (writing !== undefined) await writing.catch(() => {});
      let ok = true;
      for (const p of [path, bakPath, `${path}.tmp`, `${bakPath}.tmp`]) {
        try {
          await fs.unlink(p);
        } catch (err) {
          if (fsErrCode(err) !== "ENOENT") ok = false;
        }
      }
      resetMemory();
      corruptWhy = undefined;
      appliedSeq = 0;
      durableSeq = 0;
      dirReady = false;
      setPersistFailed(false);
      return ok ? { ok: true } : { ok: false, reason: "io" };
    },

    dispose() {
      disposed = true;
      if (flushTimer !== undefined) clock.clearTimeout(flushTimer);
      if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
      flushTimer = undefined;
      retryTimer = undefined;
      failWaiters();
    },

    get appId() {
      return appId;
    },

    tenant: {
      get: () => tenantKey,
      pin(key) {
        if (!live()) return "unavailable";
        if (typeof key !== "string" || !TENANT_KEY_RE.test(key)) return "invalid";
        if (tenantKey === undefined) {
          tenantKey = key;
          touch();
          return "pinned";
        }
        return tenantKey === key ? "same" : "mismatch";
      },
    },

    allowList: {
      list: () => [...allow.map.keys()],
      has: (id) => allow.map.has(id),
      add(openId) {
        if (!live()) return { ok: false, refused: "unavailable" };
        if (typeof openId !== "string" || !FEISHU_OPEN_ID_RE.test(openId)) return { ok: false, refused: "invalid" };
        if (allow.map.has(openId)) return { ok: true, value: { added: false } };
        if (allow.size >= allow.cap) return { ok: false, refused: "cap" };
        const now = clock.now();
        if (overBudget(allow.delta(openId, now))) return { ok: false, refused: "budget" };
        allow.set(openId, now);
        touch();
        return { ok: true, value: { added: true } };
      },
      remove(openId) {
        if (!live() || !allow.delete(openId)) return false;
        touch();
        return true;
      },
      get size() {
        return allow.size;
      },
    },

    dedup: {
      keyFor(kind, id) {
        const key = `${kind === "event" ? "e" : "m"}:${id}`;
        return DEDUP_KEY_RE.test(key) ? key : undefined;
      },
      has(key) {
        const seenAt = dedup.get(key);
        return seenAt !== undefined && clock.now() - seenAt <= FEISHU_CAPS.dedupTtlMs;
      },
      add(key) {
        if (!live()) return { ok: false, refused: "unavailable" };
        if (!DEDUP_KEY_RE.test(key)) return { ok: false, refused: "invalid" };
        const now = clock.now();
        const existing = dedup.get(key);
        if (existing !== undefined && now - existing <= FEISHU_CAPS.dedupTtlMs) {
          return { ok: true, value: { added: false } };
        }
        if (existing === undefined && dedup.size >= dedup.cap) {
          // Expired entries are not security state: reclaim them before refusing.
          const removed = sweepExpired();
          if (removed > 0) touch();
          if (dedup.size >= dedup.cap) return { ok: false, refused: "cap" };
        }
        if (overBudget(dedup.delta(key, now))) return { ok: false, refused: "budget" };
        dedup.set(key, now);
        touch();
        return { ok: true, value: { added: true } };
      },
      get size() {
        return dedup.size;
      },
    },

    requests: {
      receive(input) {
        if (!live()) return { ok: false, refused: "unavailable" };
        if (!isRec(input.payload) || typeof input.payload.body !== "string") return { ok: false, refused: "invalid" };
        if (utf8(input.payload.body) > FEISHU_RECEIVED_BODY_MAX_BYTES)
          return { ok: false, refused: "payload-too-large" };
        const now = clock.now();
        const candidate: unknown = {
          ...input,
          state: "received",
          createdAt: now,
          stateAt: now,
        };
        const rec = parseRequest(input.id, candidate);
        if (rec === undefined) return { ok: false, refused: "invalid" };
        if (requests.map.has(rec.id)) return { ok: false, refused: "exists" };
        if (nonTerminal >= FEISHU_CAPS.requestsNonTerminal) return { ok: false, refused: "cap" };
        if (overBudget(requests.delta(rec.id, rec))) return { ok: false, refused: "budget" };
        requests.set(rec.id, rec);
        nonTerminal++;
        touch();
        return { ok: true, value: clone(rec) };
      },
      get: (id) => {
        const r = requests.get(id);
        return r === undefined ? undefined : clone(r);
      },
      list(filter) {
        const out: FeishuRequestRecord[] = [];
        for (const r of requests.values()) {
          if (filter?.states !== undefined && !filter.states.includes(r.state)) continue;
          if (filter?.senderOpenId !== undefined && r.senderOpenId !== filter.senderOpenId) continue;
          out.push(clone(r));
        }
        return out;
      },
      transition(id, to, patch) {
        if (!live()) return { ok: false, reason: "unavailable" };
        const cur = requests.get(id);
        if (cur === undefined) return { ok: false, reason: "unknown" };
        if (!REQUEST_TRANSITIONS[cur.state].includes(to)) return { ok: false, reason: "illegal" };
        const next = clone(cur);
        if (!applyPatch(next, patch)) return { ok: false, reason: "invalid" };
        next.state = to;
        next.stateAt = clock.now();
        const wasTerminal = isTerminalRequestState(cur.state);
        const nowTerminal = isTerminalRequestState(to);
        if (nowTerminal) delete next.payload; // §R2-c: payload deleted on terminal
        requests.set(id, next);
        if (wasTerminal !== nowTerminal) {
          if (nowTerminal) {
            nonTerminal--;
            terminal++;
          }
        }
        if (nowTerminal) expireRequestMetadata();
        touch();
        return { ok: true, record: clone(next) };
      },
      patch(id, patch) {
        if (!live()) return false;
        const cur = requests.get(id);
        if (cur === undefined) return false;
        const next = clone(cur);
        if (!applyPatch(next, patch)) return false;
        requests.set(id, next);
        touch();
        return true;
      },
      revokeSender(openId) {
        if (!live()) return [];
        const ids: string[] = [];
        for (const [id, r] of [...requests.entries()]) {
          if (r.state !== "received" || r.senderOpenId !== openId) continue;
          const next = clone(r);
          next.state = "revoked";
          next.stateAt = clock.now();
          delete next.payload;
          requests.set(id, next);
          nonTerminal--;
          terminal++;
          ids.push(id);
        }
        if (ids.length > 0) {
          expireRequestMetadata();
          touch();
        }
        return ids;
      },
      get nonTerminal() {
        return nonTerminal;
      },
      get terminal() {
        return terminal;
      },
    },

    bindings: {
      get: (key) => {
        const b = bindings.get(key);
        return b === undefined ? undefined : clone(b);
      },
      list: () => [...bindings.values()].map((b) => clone(b)),
      set(key, input) {
        if (!live()) return { ok: false, refused: "unavailable" };
        const prev = bindings.get(key);
        const draft: Record<string, unknown> = {
          key,
          rev: revSeq + 1,
          chatId: input.chatId,
          chatType: input.chatType,
          updatedAt: clock.now(),
        };
        const threadId = input.threadId ?? prev?.threadId;
        if (threadId !== undefined) draft["threadId"] = threadId;
        const pick = (next: string | null | undefined, old: string | undefined): string | undefined =>
          next === null ? undefined : (next ?? old);
        const sessionId = pick(input.sessionId, prev?.sessionId);
        const label = pick(input.label, prev?.label);
        const offline = pick(input.offline, prev?.offline);
        if (sessionId !== undefined) draft["sessionId"] = sessionId;
        if (label !== undefined) draft["label"] = label;
        if (offline !== undefined) draft["offline"] = offline;
        const rec = parseBinding(key, draft);
        if (rec === undefined) return { ok: false, refused: "invalid" };
        if (prev === undefined && bindings.size >= bindings.cap) return { ok: false, refused: "cap" };
        if (overBudget(bindings.delta(key, rec))) return { ok: false, refused: "budget" };
        revSeq += 1;
        bindings.set(key, rec);
        touch();
        return { ok: true, value: clone(rec) };
      },
      remove(key) {
        if (!live() || !bindings.delete(key)) return false;
        touch();
        return true;
      },
      get size() {
        return bindings.size;
      },
    },

    dialogCards: {
      add(input) {
        if (!live()) return { ok: false, refused: "unavailable" };
        const now = clock.now();
        const rec = parseDialogCard(input.id, {
          ...input,
          status: "open",
          createdAt: now,
          expiresAt: now + FEISHU_CAPS.dialogCardsTtlMs,
        });
        if (rec === undefined) return { ok: false, refused: "invalid" };
        if (dialogs.map.has(rec.id)) return { ok: false, refused: "exists" };
        if (dialogs.size >= dialogs.cap) {
          if (sweepExpired() > 0) touch();
          if (dialogs.size >= dialogs.cap) return { ok: false, refused: "cap" };
        }
        if (overBudget(dialogs.delta(rec.id, rec))) return { ok: false, refused: "budget" };
        dialogs.set(rec.id, rec);
        touch();
        return { ok: true, value: clone(rec) };
      },
      get: (id) => {
        const d = dialogs.get(id);
        return d === undefined ? undefined : clone(d);
      },
      list: () => [...dialogs.values()].map((d) => clone(d)),
      update(id, patch) {
        if (!live()) return false;
        const cur = dialogs.get(id);
        if (cur === undefined) return false;
        const next = parseDialogCard(id, {
          ...cur,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.messageId !== undefined ? { messageId: patch.messageId } : {}),
        });
        if (next === undefined) return false;
        dialogs.set(id, next);
        touch();
        return true;
      },
      remove(id) {
        if (!live() || !dialogs.delete(id)) return false;
        touch();
        return true;
      },
      get size() {
        return dialogs.size;
      },
    },

    nonces: {
      issue(input, ttlMs) {
        if (!live()) return { ok: false, refused: "unavailable" };
        const now = clock.now();
        const ttl = Math.max(1, Math.min(FEISHU_CAPS.nonceTtlMs, ttlMs ?? FEISHU_CAPS.nonceTtlMs));
        const nonce = Buffer.from(random(FEISHU_IDENTITY.nonceBytes)).toString("base64url");
        const rec = parseNonce(nonce, { ...input, nonce, createdAt: now, expiresAt: now + ttl });
        if (rec === undefined) return { ok: false, refused: "invalid" };
        if (nonces.map.has(nonce)) return { ok: false, refused: "exists" };
        if (nonces.size >= nonces.cap) {
          if (sweepExpired() > 0) touch();
          if (nonces.size >= nonces.cap) return { ok: false, refused: "cap" };
        }
        if (overBudget(nonces.delta(nonce, rec))) return { ok: false, refused: "budget" };
        nonces.set(nonce, rec);
        touch();
        return { ok: true, value: clone(rec) };
      },
      get: (nonce) => {
        const n = nonces.get(nonce);
        return n === undefined ? undefined : clone(n);
      },
      redeem(ctx) {
        if (!live()) return { ok: false, reason: "unavailable" };
        if (typeof ctx.nonce !== "string" || !FEISHU_NONCE_RE.test(ctx.nonce)) return { ok: false, reason: "unknown" };
        const rec = nonces.get(ctx.nonce);
        if (rec === undefined) return { ok: false, reason: "unknown" };
        if (rec.expiresAt <= clock.now()) {
          nonces.delete(ctx.nonce);
          touch();
          return { ok: false, reason: "expired" };
        }
        if (
          rec.operatorOpenId !== ctx.operatorOpenId ||
          rec.chatId !== ctx.chatId ||
          rec.messageId !== ctx.messageId ||
          rec.tenantKey !== ctx.tenantKey ||
          rec.installGen !== ctx.installGen
        ) {
          return { ok: false, reason: "mismatch" };
        }
        nonces.delete(ctx.nonce);
        touch();
        return { ok: true, record: clone(rec) };
      },
      purgeOperator(openId) {
        if (!live()) return 0;
        let n = 0;
        for (const [k, r] of [...nonces.entries()]) if (r.operatorOpenId === openId && nonces.delete(k)) n++;
        if (n > 0) touch();
        return n;
      },
      get size() {
        return nonces.size;
      },
    },

    approvals: {
      ask(senderOpenId, senderDisplay) {
        if (!live()) return { ok: false, refused: "unavailable" };
        const now = clock.now();
        const prev = approvals.get(senderOpenId);
        if (prev !== undefined && prev.expiresAt > now) return { ok: false, refused: "recent" };
        const rec = parseApproval(senderOpenId, {
          senderOpenId,
          senderDisplay,
          state: "pending",
          askedAt: now,
          expiresAt: now + FEISHU_CAPS.approvalsTtlMs,
        });
        if (rec === undefined) return { ok: false, refused: "invalid" };
        if (prev === undefined && approvals.size >= approvals.cap) {
          if (sweepExpired() > 0) touch();
          if (approvals.size >= approvals.cap) return { ok: false, refused: "cap" };
        }
        if (overBudget(approvals.delta(senderOpenId, rec))) return { ok: false, refused: "budget" };
        approvals.set(senderOpenId, rec);
        touch();
        return { ok: true, value: clone(rec) };
      },
      get: (id) => {
        const a = approvals.get(id);
        return a === undefined ? undefined : clone(a);
      },
      list: () => [...approvals.values()].map((a) => clone(a)),
      attach(senderOpenId, card) {
        if (!live()) return false;
        const cur = approvals.get(senderOpenId);
        if (cur === undefined) return false;
        const next = parseApproval(senderOpenId, {
          ...cur,
          ...(card.nonce !== undefined ? { nonce: card.nonce } : {}),
          ...(card.cardMessageId !== undefined ? { cardMessageId: card.cardMessageId } : {}),
        });
        if (next === undefined) return false;
        approvals.set(senderOpenId, next);
        touch();
        return true;
      },
      resolve(senderOpenId, outcome) {
        if (!live()) return false;
        const cur = approvals.get(senderOpenId);
        if (cur === undefined) return false;
        if (outcome === "allowed") approvals.delete(senderOpenId);
        else {
          const next: FeishuApproval = { ...cur, state: "ignored" };
          delete next.nonce;
          approvals.set(senderOpenId, next);
        }
        touch();
        return true;
      },
      get size() {
        return approvals.size;
      },
    },

    outbox: {
      add(input) {
        if (!live()) return { ok: false, refused: "unavailable" };
        const now = clock.now();
        const rec = parseOutbox(input.sendId, {
          ...input,
          state: "queued",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        });
        if (rec === undefined) return { ok: false, refused: "invalid" };
        if (outbox.map.has(rec.sendId)) return { ok: false, refused: "exists" };
        const limit = rec.kind === "final" ? outbox.cap : outbox.cap - FEISHU_OUTBOX_FINAL_RESERVE;
        if (outbox.size >= limit) {
          if (sweepExpired() > 0) touch();
          if (outbox.size >= limit) return { ok: false, refused: "cap" };
        }
        if (overBudget(outbox.delta(rec.sendId, rec))) return { ok: false, refused: "budget" };
        outbox.set(rec.sendId, rec);
        touch();
        return { ok: true, value: clone(rec) };
      },
      get: (id) => {
        const o = outbox.get(id);
        return o === undefined ? undefined : clone(o);
      },
      list: (filter) =>
        [...outbox.values()]
          .filter((o) => filter?.state === undefined || o.state === filter.state)
          .map((o) => clone(o)),
      update(sendId, patch) {
        if (!live()) return false;
        const cur = outbox.get(sendId);
        if (cur === undefined) return false;
        const merged: Record<string, unknown> = { ...cur, updatedAt: clock.now() };
        if (patch.state !== undefined) merged["state"] = patch.state;
        if (patch.attempts !== undefined) merged["attempts"] = patch.attempts;
        if (patch.code !== undefined) merged["code"] = patch.code;
        if (merged["state"] !== "queued") delete merged["content"];
        const next = parseOutbox(sendId, merged);
        if (next === undefined) return false;
        outbox.set(sendId, next);
        touch();
        return true;
      },
      remove(sendId) {
        if (!live() || !outbox.delete(sendId)) return false;
        touch();
        return true;
      },
      get size() {
        return outbox.size;
      },
    },

    undecodable: {
      record(entry) {
        if (!live()) return;
        const at = clock.now();
        const e: UndecodableEntry = {
          at,
          reason: isText(entry.reason, CODE_MAX) ? entry.reason : "undecodable",
        };
        if (entry.sha8 !== undefined && SHA8_RE.test(entry.sha8)) e.sha8 = entry.sha8;
        const ring = [...undec.ring, e].slice(-FEISHU_UNDECODABLE_RING);
        undec = { ...undec, count: undec.count + 1, lastAt: at, ring };
        touch();
      },
      snapshot: () => clone(undec),
      noticeDue() {
        return undec.noticeAt === undefined || clock.now() - undec.noticeAt >= FEISHU_UNDECODABLE_NOTICE_GAP_MS;
      },
      markNotice() {
        if (!live()) return;
        undec = { ...undec, noticeAt: clock.now() };
        touch();
      },
    },
  };
  return state;
}
