/**
 * Process-level claim of `/cache-ttl measure` (measure-plan.md r4 §7.1). Pure and pi-free; the same `Symbol.for`
 * singleton pattern as `ping-ledger.ts`: the object lives at `globalThis[MEASURE_CLAIM_KEY]`, so it survives `/reload`
 * (which re-activates the extension in the same process) and is shared by every activation.
 *
 * States: `free → preparing → running → draining → free`.
 *  - `prepare(owner, now)` — only from `free`, registered BEFORE the estimate/confirm await; hands out a token whose
 *    `owner.generation` is unique per claim. A `draining`/`running`/`preparing` claim answers `busy`
 *    (`busy-io-pending` while `draining`, with `since`).
 *  - `owns(token)` — same generation, activation and session and the claim is still `preparing`/`running`. Every await in
 *    the command and the runner re-checks it; `false` ⇒ stop silently (no send/persist/progress/notify).
 *  - `revoke(token)` — `preparing → free` (shutdown during the confirm). No-op for anything else.
 *  - `start(token, run)` — `preparing → running`.
 *  - `finishLogical(token, now)` — `running → draining`, or `free` when no physical IO is pending. Logical end only:
 *    a send whose transport `settled` never resolves keeps the claim `draining` until restart (fail closed).
 *  - `ioBegin()/ioSettled()` — the physical-IO ledger. NOT token-gated: an old generation's IO still settles, and the
 *    last `ioSettled` of a `draining` claim frees it.
 *
 * The claim also carries the process-wide single-writer slot of the measurement store (`persistSlot`), so zombie
 * fencing and write coalescing hold across `/reload` too. No module-scope mutable state.
 */

import type { Millis } from "../core/types.js";
import {
  MEASURE_CLAIM_KEY,
  type MeasureRouteIdentity,
  type MeasureRunRecord,
  type MeasureClaim,
  type MeasureClaimOwner,
  type MeasureClaimPrepare,
  type MeasureClaimState,
  type MeasureClaimToken,
  type MeasurePersistState,
  type MeasureProgress,
  type MeasureRunHandle,
} from "./measure-types.js";

/** The store's single-writer slot (see `measure-store.ts`); lives on the claim so it is process-wide. */
export interface MeasurePersistSlot {
  state: MeasurePersistState;
  lastSavedAt: Millis | undefined;
  /** When the slot became a zombie (a step missed its deadline); persists are skipped from then on. */
  zombieSince: Millis | undefined;
  /** A write is in flight (owned by exactly one writer loop, whichever activation started it). */
  writing: boolean;
  /** Newest snapshot per `<route key>\0<slot>` not yet written (a newer persist replaces an older pending one). */
  pending: Map<string, MeasurePendingUpdate>;
}

export interface MeasurePendingUpdate {
  route: MeasureRouteIdentity;
  slot: "latest" | "inProgress";
  run: MeasureRunRecord | null;
}

export interface MeasureClaimInternal extends MeasureClaim {
  readonly persistSlot: MeasurePersistSlot;
}

interface TokenImpl extends MeasureClaimToken {
  readonly owner: MeasureClaimOwner;
}

export function createMeasureClaim(): MeasureClaimInternal {
  let state: MeasureClaimState = "free";
  let generation = 0;
  let current: TokenImpl | undefined;
  let run: MeasureRunHandle | undefined;
  let physicalPending = 0;
  let drainingSince: Millis | undefined;
  const persistSlot: MeasurePersistSlot = {
    state: "idle",
    lastSavedAt: undefined,
    zombieSince: undefined,
    writing: false,
    pending: new Map(),
  };

  const toFree = (): void => {
    state = "free";
    current = undefined;
    run = undefined;
    drainingSince = undefined;
  };

  const owns = (token: MeasureClaimToken): boolean => {
    if (current === undefined) return false;
    if (state !== "preparing" && state !== "running") return false;
    const a = token.owner;
    const b = current.owner;
    return (
      a.generation === b.generation &&
      a.activationId === b.activationId &&
      a.sessionId === b.sessionId &&
      a.runId === b.runId
    );
  };

  const claim: MeasureClaimInternal = {
    get state() {
      return state;
    },
    get generation() {
      return generation;
    },
    get physicalPending() {
      return physicalPending;
    },
    get drainingSince() {
      return drainingSince;
    },
    persistSlot,
    prepare(owner: Omit<MeasureClaimOwner, "generation">, now: Millis): MeasureClaimPrepare {
      if (state === "draining" || (state === "free" && physicalPending > 0)) {
        return {
          ok: false,
          reason: "busy-io-pending",
          ...(drainingSince !== undefined ? { since: drainingSince } : { since: now }),
        };
      }
      if (state !== "free") return { ok: false, reason: "busy" };
      generation += 1;
      const token: TokenImpl = { owner: { ...owner, generation } };
      current = token;
      state = "preparing";
      return { ok: true, token };
    },
    owns,
    revoke(token) {
      if (state === "preparing" && owns(token)) toFree();
    },
    start(token, handle) {
      if (state !== "preparing" || !owns(token)) return false;
      state = "running";
      run = handle;
      return true;
    },
    finishLogical(token, now) {
      if (state !== "running" || !owns(token)) return;
      if (physicalPending > 0) {
        state = "draining";
        drainingSince = now;
        // the logical owner is gone: `owns` is now false for every token, `current()` reports nothing
        current = undefined;
        run = undefined;
      } else {
        toFree();
      }
    },
    ioBegin() {
      physicalPending += 1;
    },
    ioSettled() {
      physicalPending = Math.max(0, physicalPending - 1);
      if (physicalPending === 0 && state === "draining") toFree();
    },
    current(): MeasureProgress | undefined {
      return run?.snapshot();
    },
  };
  return claim;
}

/** Marker so a stale shape left by an older module version is never trusted. */
const SHAPE_MARK = Symbol.for("pi-subagent:cache-ttl-measure:shape-v1");

/** The process-wide claim (lazily built, survives `/reload`, never reset). */
export function getMeasureClaim(): MeasureClaimInternal {
  const g = globalThis as Record<symbol, (MeasureClaimInternal & { [SHAPE_MARK]?: true }) | undefined>;
  const existing = g[MEASURE_CLAIM_KEY];
  if (existing !== undefined && existing[SHAPE_MARK] === true) return existing;
  const fresh = createMeasureClaim() as MeasureClaimInternal & { [SHAPE_MARK]?: true };
  fresh[SHAPE_MARK] = true;
  g[MEASURE_CLAIM_KEY] = fresh;
  return fresh;
}
