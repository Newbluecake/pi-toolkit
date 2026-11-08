/**
 * Seam types for the Web session-memory write path (package 2 → package 4).
 *
 * This module is pi-free and holds ONLY opaque contracts. The production facade
 * (`MemoryWebWritePort`) and the per-owner Web controller that backs `MemoryWriteTask`
 * belong to the sole integrator (package 4) and live in `memory/index.ts` /
 * `scopes/owner.ts`; the bridge and command dispatcher (package 2) consume these
 * types and are proven against a test double, never against a fake of the real store.
 */
import type { MemoryCancelReason, SessionWebAddRequest, SessionWebOutcome } from "./session-store.js";

/** Domain write result (alias for the store's bounded outcome). */
export type WriteOutcome = SessionWebOutcome;
export type { MemoryCancelReason };

/** The single parsed write the bridge may dispatch; nothing else reaches the write port. */
export interface MemoryWebDispatchRequest {
  readonly write: SessionWebAddRequest;
  readonly cmdId: string;
  readonly commandOwner: string;
  readonly operationGeneration: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
}

/**
 * The controller's handle on one accepted write. `done` is the only completion
 * source; `cancel` reads the store's already-observed outcome (it must never
 * downgrade a completed/unknown observation to `none`), and `release` is
 * idempotent — the command dispatcher calls it only AFTER the ledger has copied
 * the final result out (observe-before-release).
 */
export interface MemoryWriteTask {
  readonly done: Promise<WriteOutcome>;
  cancel(reason: MemoryCancelReason): WriteOutcome;
  release(): void;
}

/**
 * Package 4's per-call facade, late-bound by the bridge. `ctx` is the live
 * `ExtensionContext` (typed `unknown` here to keep this module pi-free; the
 * facade narrows it). `start`'s business work must not begin until a microtask
 * after it returns, so the caller's cancel/release handles are registered first.
 */
export interface MemoryWebWritePort {
  start(
    request: MemoryWebDispatchRequest,
    ctx: unknown,
  ): { accepted: true; task: MemoryWriteTask } | { accepted: false; outcome: WriteOutcome };
}
