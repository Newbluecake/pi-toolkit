/**
 * Fast's activation-local contracts only. No pi objects, storage, bus, globals or timers.
 * Implementations belong to the later state/wire and runtime integration packages.
 */
import type { FastMode, FastSeed, RunId } from "../core/types.js";

/** Volatile callback snapshot. NEVER serialize this into a seed, custom record or journal hash. */
export interface FastSnapshot {
  readonly mode: FastMode;
  readonly revision: number;
  readonly incarnation: object;
}

/** Main admission or trusted nested-parent lookup; disabled returns undefined, not an inherit seed. */
export interface FastParentPort {
  snapshot(parentRunId?: RunId): FastSeed | undefined;
}

/** Host-only capture before workflow replay/hash/FIFO; not part of worker options. */
export interface FastWorkflowPort {
  capture(): FastSeed | undefined;
}

/** Exact child owner; a reused run/session id must not revive an earlier binding. */
export interface FastOwner {
  readonly parentRunId: RunId;
  readonly incarnation: object;
}

/**
 * Bind this child's read-only current branch mode for nested admission. Before binding, the
 * consumer uses the admitted seed, never root state. The returned synchronous, idempotent
 * cleanup revokes only this exact owner incarnation (including abort/create-failure paths);
 * stale cleanup must not revoke a replacement owner. No root-to-child subscriptions.
 */
export interface FastChildStatePort {
  bind(owner: FastOwner, readMode: () => FastMode): () => void;
}
