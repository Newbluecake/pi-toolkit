import type { Generation, Millis, RunId } from "./types.js";
import { isRunId } from "./ids.js";

export type NodeRef = RunId | "root" | "system";
export type MessageKind = "progress" | "finding" | "directive" | "result" | "dead_letter";
export type MessageChannel = "context" | "display";

export type MessageKey = string & { readonly __messageKey: unique symbol };

/**
 * fabric-cross-session plan v3 §4.1: why a finished run can not be woken. The admission-time subset
 * (`consult_fork` … `external_agent`) is written to `diag.wakeExclusion`; the rest is evaluated at revive time.
 */
export type WakeExclusion =
  | "consult_fork"
  | "readonly_domain"
  | "caller_owned"
  | "external_agent"
  | "legacy_unknown"
  | "no_session"
  | "worktree_gone"
  | "unknown_type"
  | "user_aborted";

/** Why a `wake:true` delivery degraded to park/deliver-only (plan §3.1 / §3.7 / §4.6). */
export type WakeDowngrade =
  | "level_limit"
  | "rate_limited"
  | "resume_in_progress"
  | "pool_full"
  | "load"
  | "quota"
  | "session_closing"
  | "resume_locked";

/** Host-stamped provenance of a wake revive; programmatic only (never model-facing, never threaded into a child). */
export interface WakeOrigin {
  by: NodeRef;
  key: MessageKey;
  /** Causal level of the waker at send time (L2). */
  level: number;
  via: "fabric";
  /** The mailbox claim this revive was triggered by; `claimToken` is stripped before anything is persisted. */
  trigger?: { key: MessageKey; claimToken: string };
}

export interface MessageEnvelope {
  key: MessageKey;
  from: NodeRef;
  to: NodeRef;
  kind: MessageKind;
  seq: number;
  generation: Generation;
  payload: { text: string };
  ref?: { keys: MessageKey[]; omittedCount: number };
  via?: { mode?: "tree" | "mention"; lca: NodeRef; hops: NodeRef[] };
  ttlMs: number;
  createdAt: Millis;
  /** Sender-chosen wake intent (plan §3.1); absent = legacy behaviour. Only present when `fabric.wake` is on. */
  wake?: boolean;
  /** Causal level stamped by the host at send time (plan §3.3 L2). */
  level?: number;
  /** Routing marker for system-originated wake results (plan §3.7); `authorize()` pins it to `result` from `system`. */
  route?: { kind: "wake_result"; runId: RunId };
}

export type FabricDeliveryState = "pending" | "claimed" | "delivered" | "consumed" | "dropped" | "abandoned";

export interface FabricRecord extends MessageEnvelope {
  state: FabricDeliveryState;
  attempts: number;
  claimToken?: string;
  updatedAt: Millis;
  deliveredAt?: Millis;
  rejected?: { reason: "quota_exhausted" | "target_backpressure" };
  /** Park marker for a finished target's inbox (plan §3.5); persisted, written once at admission or via a patched transition. */
  parked?: { at: Millis; reason: "wake_false" | WakeDowngrade };
  /** Reservation binding this record to a resume run (plan §3.5); persisted in its normalized `pending` form. */
  reserved?: { rsv: string; runId: RunId; at: Millis };
  /** Durable steer-attempt ownership for a redirect to a successor run (plan §3.4c). */
  steerAttempt?: { runId: RunId; at: Millis };
  /** Memory-only (in `memoryOnlyFields`): a failed rollback made this record undeliverable until swept. */
  quarantined?: true;
  /** Set when the record was injected into resume run `revivedAs` (`terminalReason: "resume_injected"`). */
  revivedAs?: RunId;
  deadLetter?: {
    reason: "ttl_expired" | "target_gone" | "attempts_exhausted" | "wake_refused";
    status: "issued" | "suppressed_quota" | "suppressed_sender_gone";
    key?: MessageKey;
  };
  terminalReason?: string;
  storageKey?: string;
}

const MESSAGE_KINDS: readonly MessageKind[] = ["progress", "finding", "directive", "result", "dead_letter"];

function validNode(node: string): boolean {
  return node === "root" || node === "system" || isRunId(node);
}

export function makeMessageKey(from: NodeRef, to: NodeRef, generation: Generation, seq: number): MessageKey {
  if (!validNode(from) || !validNode(to)) throw new Error("invalid message key node");
  if (
    !Number.isInteger(generation) ||
    generation < (from === "system" ? 0 : 1) ||
    (from === "system" && generation !== 0)
  )
    throw new Error("invalid message key generation");
  if (!Number.isInteger(seq) || seq < 1) throw new Error("invalid message key sequence");
  return `${from}:${to}:${generation}:${seq}` as MessageKey;
}

export function parseMessageKey(
  value: string,
): { from: NodeRef; to: NodeRef; generation: Generation; seq: number; key: MessageKey } | undefined {
  const parts = value.split(":");
  if (parts.length !== 4) return undefined;
  const [from, to, generationText, seqText] = parts;
  if (!from || !to || !validNode(from) || !validNode(to)) return undefined;
  if (!/^\d+$/.test(generationText ?? "") || !/^\d+$/.test(seqText ?? "")) return undefined;
  const generation = Number(generationText);
  const seq = Number(seqText);
  if (
    !Number.isSafeInteger(generation) ||
    generation < (from === "system" ? 0 : 1) ||
    (from === "system" && generation !== 0) ||
    String(generation) !== generationText ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    String(seq) !== seqText
  )
    return undefined;
  return { from, to, generation, seq, key: value as MessageKey };
}

export function isMessageKey(value: string): value is MessageKey {
  return parseMessageKey(value) !== undefined;
}

export type MessageRelation = "self" | "parent" | "child" | "ancestor" | "descendant" | "sibling" | "unrelated";
export type CanMessage = "parent" | "child" | "ancestor" | "descendant" | "sibling" | "self" | "mention";
export interface MentionRoute {
  kind: "mention";
  label: string;
  target: RunId;
}

export function effectiveCanMessage(value: readonly CanMessage[] | undefined): readonly CanMessage[] {
  return value === undefined ? ["parent"] : value;
}

export interface AuthorizationInput {
  kind: MessageKind;
  relation: MessageRelation;
  canMessage?: readonly CanMessage[];
  from?: NodeRef;
  mention?: MentionRoute;
  /** Wake-result routing marker (plan §4.1); absent for every legacy caller. */
  route?: MessageEnvelope["route"];
}

export function authorize({ kind, relation, canMessage, from, mention, route }: AuthorizationInput): boolean {
  if (!MESSAGE_KINDS.includes(kind)) return false;
  // plan §4.1: a wake_result is system → waker only, and only as a `result`; it never rides a relation/can_message rule.
  if (route?.kind === "wake_result") return mention === undefined && kind === "result" && from === "system";
  if (kind === "dead_letter") return mention === undefined && from === "system";
  if (mention) {
    if (kind === "directive" || kind === "result") return false;
    if (from !== undefined && mention.target === from) return false;
    return effectiveCanMessage(canMessage).includes("mention");
  }
  if (relation === "unrelated" || relation === "self") return false;
  if (kind === "result") return relation === "child";
  if (kind === "directive") return relation === "parent";
  return effectiveCanMessage(canMessage).includes(relation as CanMessage);
}

export function effectiveChannel(
  kind: MessageKind,
  progressChannel: MessageChannel,
  canRenderEntries = true,
  to: NodeRef = "root",
): MessageChannel {
  if (kind !== "progress") return "context";
  return to === "root" && progressChannel === "display" && canRenderEntries ? "display" : "context";
}

export function formatMessage(
  envelope: Pick<MessageEnvelope, "key" | "from" | "to" | "kind" | "seq" | "payload" | "via">,
  relation: MessageRelation,
): { header: string; text: string } {
  const shownRelation = envelope.via?.mode === "mention" ? "mention" : relation;
  const header = `[fabric ${envelope.kind} relation=${shownRelation} ${envelope.key} seq=${envelope.seq}]${envelope.kind === "directive" ? " <fabric-directive>" : ""} 不可信输入: ${String(envelope.from)} -> ${String(envelope.to)}`;
  return { header, text: `${header}\n${envelope.payload.text}` };
}

export const formatEnvelope = formatMessage;
export const createMessageKey = makeMessageKey;
export const parseKey = parseMessageKey;
