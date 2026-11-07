import type {
  MemoryAuthority,
  MemoryApprovalChannel,
  SessionMemoryId,
  MemorySessionId,
  MemoryLeafId,
  MemoryTimestamp,
  SessionMemoryGrant,
  SessionItem,
  SessionMemorySeedV1,
  MemorySeedCapture,
} from "../../core/memory-types.js";
export type {
  MemoryAuthority,
  MemoryApprovalChannel,
  SessionMemoryId,
  MemorySessionId,
  MemoryLeafId,
  MemoryTimestamp,
  SessionMemoryGrant,
  SessionItem,
  SessionMemorySeedV1,
  MemorySeedCapture,
} from "../../core/memory-types.js";

/**
 * #39 P0 shared pi-free contracts. No runtime wiring, validation, storage, or capability minting.
 * Capabilities are activation-local host objects, never schema/tool/wire/journal arguments.
 * Product budgets count UTF-8 raw bodies; DTO/render budgets count their FINAL serialized bytes.
 */
export type StorageScope = "session" | "project" | "hub";
export type WritableStorageScope = Exclude<StorageScope, "project">;
export type MemoryRemoteOriginKind = "loopback" | "lan" | "feishu";

export const SESSION_MEMORY_ENTRY_TYPE = "subagent:memory-session";
export const SESSION_MEMORY_SECTION = "pi_session_memory";
export const HUB_MEMORY_SECTION = "pi_hub_memory";
export const MEMORY_META_MAX_BYTES = 512;
export const MEMORY_ENVELOPE_MAX_BYTES = 2048;
export const MEMORY_ITEM_MAX_BYTES = 1024;
export const MEMORY_OPERATION_DTO_MAX_BYTES = 8704;
export const SESSION_MEMORY_MAX_ITEMS = 48;
export const SESSION_MEMORY_MAX_BODY_BYTES = 8192;
export const SESSION_MEMORY_DTO_MAX_BYTES = 75776;
export const SESSION_MEMORY_RENDER_MAX_BYTES = 63488;
export const HUB_MEMORY_MAX_ITEMS = 32;
export const HUB_MEMORY_MAX_BODY_BYTES = 4096;
export const HUB_MEMORY_DTO_MAX_BYTES = 43008;
export const HUB_MEMORY_RENDER_MAX_BYTES = 34816;
export const FOLD_HARD_ITEMS = 64;
export const FOLD_HARD_TEXT = 1024;
export const FOLD_HARD_BODY_BYTES = 65536;
export const FOLD_HARD_DTO_BYTES = 428032;
export const FOLD_HARD_RENDER_BYTES = 411648;
export const SESSION_MEMORY_SNAPSHOT_INTERVAL = 32;

/** Validate at the unknown-data boundary; string aliases do not confer validation or authority. */
export type HubMemoryId = string;
export type MemoryRevision = string;
export interface MemoryInheritance {
  readonly kind: "spawn";
  readonly fromSid: MemorySessionId;
  readonly fromLeaf?: MemoryLeafId;
  readonly frozenAt: MemoryTimestamp;
}
export type SessionMemoryCause = { readonly op: "put" | "del"; readonly id: SessionMemoryId };
export type SessionMemoryEntryV1 =
  | { readonly v: 1; readonly sid: MemorySessionId; readonly op: "put"; readonly item: SessionItem }
  | { readonly v: 1; readonly sid: MemorySessionId; readonly op: "del"; readonly id: SessionMemoryId }
  | {
      readonly v: 1;
      readonly sid: MemorySessionId;
      readonly op: "snap";
      readonly items: readonly SessionItem[];
      readonly nextN: number;
      readonly cause?: SessionMemoryCause;
      readonly inherit?: MemoryInheritance;
    };

/** Capture failure throws: reject create; never silently fall back to empty or retry at dequeue. */
export interface MemoryParentPort {
  snapshot(parentRunId?: string): MemorySeedCapture;
}
/** Capture at EACH accepted workflow agent() before FIFO/hash/replay. Cache hit does not spawn. */
export interface MemoryWorkflowPort {
  capture(): MemorySeedCapture;
}

export interface HubMemoryGrant {
  readonly via: "dialog" | "command";
  readonly by: "agent" | "user";
  readonly channel?: MemoryApprovalChannel;
  readonly turn?: string;
  readonly cap?: string;
  readonly who?: string;
}
export interface HubMemorySource {
  readonly project: string;
  readonly label: string;
  readonly sid8: string;
}
export interface HubItem {
  readonly id: HubMemoryId;
  readonly topic: string;
  readonly text: string;
  readonly authority: "user";
  readonly created: MemoryTimestamp;
  readonly updated: MemoryTimestamp;
  readonly grant: HubMemoryGrant;
  readonly src: HubMemorySource;
  readonly from?: string;
}
/** Shared effective paths output, NOT a memoryRoot/HOME/agentDir-derived second resolution. */
export interface EffectiveHubSlot {
  readonly effectiveStateDir: string;
  readonly uid: number;
  readonly source: "web-hub" | "default-slot";
}
/** Absent when hub scopes off or secure/locked; resolving is forbidden on those paths. */
export interface EffectiveHubSlotPort {
  resolve(): EffectiveHubSlot;
}
export type SessionWriteGateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export interface SessionWriteGate {
  /** Recheck synchronously after the LAST await, at append. Locked providers must not read branch. */
  check(target: { readonly sessionFile?: string; readonly sessionDir?: string }): SessionWriteGateResult;
}

export interface MemoryOwner {
  /** Identity compared by reference, recreated per activation; not a string supplied by a model. */
  readonly incarnation: object;
  readonly sid: MemorySessionId;
  readonly sessionFile?: string;
  readonly sessionEpoch: number;
  readonly branchGen: number;
}
export interface HumanTurn {
  readonly id: string;
  readonly channel: MemoryApprovalChannel;
  readonly owner: MemoryOwner;
}
/** Host-created only. InputEvent has no cmdId/owner/nonce/generation fields. */
export interface HumanDispatchTicket {
  readonly cmdId: string;
  readonly owner: MemoryOwner;
  readonly nonce: object;
  readonly dispatchGeneration: number;
  readonly originKind: "loopback" | "lan";
}
declare const ingressCandidateBrand: unique symbol;
export interface HumanIngressCandidate {
  readonly [ingressCandidateBrand]: true;
}
/** Pure mirror of the actual public InputEvent source/queue metadata; never add cmdId to it. */
export interface HumanDispatchIngress {
  readonly source: "interactive" | "rpc" | "extension";
  readonly streamingBehavior?: "steer" | "followUp";
}
export interface HumanDispatchProofPort {
  /** Synchronously checks shared idle/owner gate, then enters activation-local ALS around send.
   * No await between admission and send; no held queue, idle resend or native-queue grants.
   * Observable dispatch rejection/exception revokes. A void SDK bridge is NOT a start receipt.
   */
  runDispatch<T>(ticket: HumanDispatchTicket, send: () => T): T;
  /** Earliest secure-guard-following ingress; synchronous one-shot claim, before await/reentry. */
  claim(owner: MemoryOwner, ingress: HumanDispatchIngress): HumanIngressCandidate | undefined;
  /** Only the corresponding immediate before_agent_start may activate a human turn. */
  confirmStart(candidate: HumanIngressCandidate, owner: MemoryOwner): HumanTurn | undefined;
  /** Record SDK agent_settled; recheck public isIdle+hasPendingMessages on actual dispatch. */
  settled(owner: MemoryOwner): void;
  /** New input/session/tree/abort/reload/teardown invalidates candidates, turns and capabilities. */
  revoke(reason: "input" | "session" | "tree" | "abort" | "reload" | "handled" | "dispatch-error" | "shutdown"): void;
  dispose(): void;
}

/** Canonical operation digest covers EVERY field, including authority, rev and source. */
interface FrozenScopedOperationFields {
  readonly op: "create" | "update" | "delete";
  readonly targetId?: string;
  readonly topic?: string;
  readonly text?: string;
  readonly from?: string;
  readonly expectRev?: MemoryRevision;
}
export type FrozenScopedOp = FrozenScopedOperationFields &
  (
    | { readonly storageScope: "session"; readonly authority: MemoryAuthority }
    | { readonly storageScope: "hub"; readonly authority: "user" }
  );
export interface MemoryApprovalBinding {
  readonly owner: MemoryOwner;
  readonly humanTurn: HumanTurn;
  readonly toolCallId: string;
  readonly nonce: string;
  readonly opDigest: string;
  readonly textDigest: string;
}
declare const privateOpCapBrand: unique symbol;
/** Opaque host object: only P1's private capability registry may mint/inspect it. */
export interface PrivateOpCap {
  readonly [privateOpCapBrand]: true;
}
export interface OpApprovalRequest {
  readonly operation: FrozenScopedOp;
  readonly binding: MemoryApprovalBinding;
  readonly projectLabel: string;
}
export type OpApprovalResult =
  | { readonly approved: true; readonly cap: PrivateOpCap }
  | { readonly approved: false; readonly code: ScopedMemoryErrorCode };
export interface ApprovalPort {
  /** Human turn is only a prerequisite. Mint solely after exact-content explicit affirmation. */
  request(request: OpApprovalRequest, signal?: AbortSignal): Promise<OpApprovalResult>;
  revoke(): void;
  dispose(): void;
}
/** Trusted inspection returned by the capability registry, never accepted from tool arguments. */
export interface ReservedMemoryOperation {
  readonly operation: FrozenScopedOp;
  readonly binding: MemoryApprovalBinding;
  readonly capId: string;
  readonly channel: MemoryApprovalChannel;
  readonly who?: string;
}
export interface MemoryOpCapPort {
  reserve(cap: PrivateOpCap, owner: MemoryOwner): ReservedMemoryOperation | undefined;
  check(cap: PrivateOpCap, owner: MemoryOwner): ReservedMemoryOperation | undefined;
  consume(cap: PrivateOpCap): boolean;
  revoke(cap?: PrivateOpCap): void;
}

export type ScopedMemoryErrorCode =
  | "E_SCOPE_DISABLED"
  | "E_CHILD_READONLY"
  | "E_CHILD_AUTHORITY"
  | "E_AUTHORITY"
  | "E_HUB_NEEDS_HUMAN_TURN"
  | "E_HUB_CONFIRM_UNAVAILABLE"
  | "E_HUB_DECLINED"
  | "E_HUB_DECLINED_TURN"
  | "E_HUB_RATE"
  | "E_HUB_CAP_STALE"
  | "E_USER_AUTH_DECLINED"
  | "E_REV_REQUIRED"
  | "E_CONFLICT"
  | "E_FULL"
  | "E_TOO_LARGE"
  | "E_META_INVALID"
  | "E_NOT_FOUND"
  | "E_STALE_SESSION"
  | "E_PERSIST"
  | "E_PERSIST_UNKNOWN"
  | "E_BUSY"
  | "E_NAMESPACE"
  | "E_WRITE_GATE"
  | "E_FROM_INVALID";
/** Root C0 ruling: scoped-writer-observed failure poisons writes; reload alone cannot clear it.
 * Explicit new/reopen plus rebuilt/verified real branch is required. Do not auto-open/repair a tail.
 * Unobserved SDK conversation flush failures cannot be intercepted by this scoped writer.
 */
export interface SessionPersistenceFailure {
  readonly code: "E_PERSIST" | "E_PERSIST_UNKNOWN";
  readonly poisoned: true;
  readonly recovery: "explicit-reopen-and-verify";
  readonly observedBy: "scoped-writer";
}
/** Custom-only buffered success is memory-only. appended never promises fsync or crash recovery. */
export type SessionMemoryPersistence = "memory-only" | "appended";
export interface FoldedSessionItem {
  readonly item: SessionItem;
  readonly rev: MemoryRevision;
  readonly inherited?: { readonly kind: "fork" | "spawn"; readonly fromSid: string; readonly frozenAt?: string };
}
export interface FoldedSessionMemory {
  readonly items: readonly FoldedSessionItem[];
  readonly nextN: number;
  readonly opsSinceSnap: number;
  readonly dropped: readonly { readonly entryId: string; readonly reason: string }[];
}
export interface SessionMemoryView extends FoldedSessionMemory {
  readonly persistence: SessionMemoryPersistence;
  readonly poisoned: boolean;
}
export interface HubMemoryView {
  readonly items: readonly HubItem[];
  readonly state: "disabled" | "absent" | "ok" | "inert";
  readonly reason?: string;
}
export interface SessionMemoryWrite {
  readonly operation: FrozenScopedOp & { readonly storageScope: "session" };
  readonly owner: MemoryOwner;
  readonly cap?: PrivateOpCap;
  readonly signal?: AbortSignal;
}
export type ScopedMemoryWriteResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly rev?: MemoryRevision;
      readonly persistence: SessionMemoryPersistence;
    }
  | {
      readonly ok: false;
      readonly code: ScopedMemoryErrorCode;
      readonly persistenceFailure?: SessionPersistenceFailure;
    };
export interface SessionMemoryPort {
  fold(): FoldedSessionMemory;
  view(): SessionMemoryView;
  render(): string;
  snapshot(): MemorySeedCapture;
  enqueue(request: SessionMemoryWrite): Promise<ScopedMemoryWriteResult>;
  dispose(): void;
}
/** Off means property absent, not a port which lazily reads disabled storage. */
export interface MemoryScopesReadPort {
  readonly session?: Pick<SessionMemoryPort, "fold" | "view" | "render" | "snapshot">;
  readonly hub?: { view(): HubMemoryView; render(): string };
}
