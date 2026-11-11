/** Pi-free opaque contracts for the production Web session-add/revision paths.
 * memory/index owns the per-call facade; scopes/owner owns the SAME lazy kernel,
 * actual owner and activity lease. The bridge consumes only these closed kinds.
 * Integration/probe tests exercise the real SDK/store/E/C paths; JSON DTOs and
 * these read-only display capabilities are never execution authority.
 */
import type { CommandFlowResult } from "../command-flow.js";
import type { MemoryCancelReason, SessionWebAddRequest, SessionWebOutcome } from "./session-store.js";

/** Domain write result (alias for the store's bounded outcome). */
export type WriteOutcome = SessionWebOutcome;
export type { MemoryCancelReason };

export interface MemoryRevisionReviewRequest {
  readonly kind: "revision.review";
  readonly rawArgs: string;
  readonly listOnly: boolean;
}
export interface MemoryRevisionOutcome {
  readonly kind: "revision.review";
  readonly result: CommandFlowResult;
}
export type MemoryWebOutcome = WriteOutcome | MemoryRevisionOutcome;
interface MemoryWebDispatchBinding {
  readonly cmdId: string;
  readonly commandOwner: string;
  readonly operationGeneration: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
}
/** Closed grammar: the old session-add payload is unchanged. No caller-supplied
 * effect/class/host or JSON LIVE capability can reach either controller. */
export type MemorySessionWebDispatchRequest = MemoryWebDispatchBinding & { readonly write: SessionWebAddRequest };
export type MemoryRevisionWebDispatchRequest = MemoryWebDispatchBinding & {
  readonly write: MemoryRevisionReviewRequest;
};
export type MemoryWebDispatchRequest = MemoryWebDispatchBinding & {
  readonly write: SessionWebAddRequest | MemoryRevisionReviewRequest;
};

/**
 * The controller's handle on one accepted write. `done` is the only completion
 * source; `cancel` reads the store's already-observed outcome (it must never
 * downgrade a completed/unknown observation to `none`), and `release` is
 * idempotent — the command dispatcher calls it only AFTER the ledger has copied
 * the final result out (observe-before-release).
 */
export interface MemoryWriteTask<Outcome = WriteOutcome> {
  readonly done: Promise<Outcome>;
  cancel(reason: MemoryCancelReason): Outcome;
  release(): void;
}

/** Read-only, actual-context projection. Missing/unknown is all false, never authority. */
export interface MemoryWebCapabilities {
  readonly sessionAdd: boolean;
  readonly revisionReview: boolean;
}

/**
 * Package 4's per-call facade, late-bound by the bridge. `ctx` is the live
 * `ExtensionContext` (typed `unknown` here to keep this module pi-free; the
 * facade narrows it). `start`'s business work must not begin until a microtask
 * after it returns, so the caller's cancel/release handles are registered first.
 */
export interface MemoryWebWritePort {
  capabilities(ctx: unknown): MemoryWebCapabilities;
  start(
    request: MemoryWebDispatchRequest,
    ctx: unknown,
  ): { accepted: true; task: MemoryWriteTask<MemoryWebOutcome> } | { accepted: false; outcome: MemoryWebOutcome };
}
