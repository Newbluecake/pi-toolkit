/**
 * Phase-2 R1 / r3 B1. Process-local authorization for delayed xs actions, NOT a TTL cache.
 * No timer, no eviction (not even tombstones). Only execution/settlement, abort completion,
 * synchronous host rejection or proven session teardown permit release. A full ledger refuses
 * admission; forgetting a still-executable token would turn a delayed trigger into an orphan.
 */
export const XS_WAKE_LEDGER_CAP = 8;

export interface XsWakeRecord {
  readonly token: string;
  readonly sessionId: string;
  readonly xid: string;
  readonly dispatchedAt: number;
  readonly deadlineAt: number;
  readonly state: "live" | "tombstone";
  readonly abortOnSight: boolean;
  /** Fpi2 (!isIdle after send) or matching before_agent_start, never merely a human input. */
  readonly started: boolean;
  /** A run is currently under supervision (may be conservatively presumed when custom shape is lost). */
  readonly executionPending: boolean;
  readonly handed: boolean;
  readonly level?: number;
  readonly levelMode?: "hop" | "return";
  readonly levelCommitted: boolean;
  readonly boundAt?: number;
  readonly abortIssuedAt?: number;
}

export type XsWakeReleaseProof = "host_rejected" | "settled" | "idle_observed" | "aborted" | "teardown";
export type NewXsWakeRecord = Pick<XsWakeRecord, "token" | "sessionId" | "xid" | "dispatchedAt" | "deadlineAt"> & {
  level?: number;
  levelMode?: "hop" | "return";
};
type MutableFields = Partial<Omit<XsWakeRecord, "token" | "sessionId" | "xid" | "dispatchedAt" | "deadlineAt">>;

export class XsWakeLedger {
  private readonly records = new Map<string, XsWakeRecord>();
  private readonly owners = new Map<string, symbol>();

  constructor(readonly capacity = XS_WAKE_LEDGER_CAP) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("invalid xs wake ledger capacity");
  }

  get size(): number {
    return this.records.size;
  }

  get(token: string): XsWakeRecord | undefined {
    const record = this.records.get(token);
    return record === undefined ? undefined : { ...record };
  }

  entries(): readonly XsWakeRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  put(input: NewXsWakeRecord): boolean {
    if (this.records.has(input.token) || this.records.size >= this.capacity) return false;
    this.records.set(input.token, {
      ...input,
      state: "live",
      abortOnSight: false,
      started: false,
      executionPending: false,
      handed: false,
      levelCommitted: false,
    });
    return true;
  }

  update(token: string, patch: MutableFields): XsWakeRecord | undefined {
    const old = this.records.get(token);
    if (old === undefined) return undefined;
    const record = { ...old, ...patch };
    this.records.set(token, record);
    return { ...record };
  }

  /** Revocation does NOT release capacity. The delayed action may still execute arbitrarily late. */
  tombstone(token: string): void {
    this.update(token, { state: "tombstone", abortOnSight: true });
  }

  /** One controller can supervise a token. dispose releases the lease, NOT the authorization record. */
  claim(token: string, owner: symbol): boolean {
    const record = this.records.get(token);
    if (record === undefined) return false;
    // A reload contender must not own an old tombstone while another controller owns this
    // session's new run. Exclusivity is per session, not merely per token.
    for (const owned of this.owners.keys()) {
      if (owned !== token && this.records.get(owned)?.sessionId === record.sessionId) return false;
    }
    const old = this.owners.get(token);
    if (old !== undefined && old !== owner) return false;
    this.owners.set(token, owner);
    return true;
  }

  hasOwner(sessionId: string): boolean {
    return [...this.owners.keys()].some((token) => this.records.get(token)?.sessionId === sessionId);
  }

  owns(token: string, owner: symbol): boolean {
    return this.owners.get(token) === owner;
  }

  unclaim(token: string, owner: symbol): void {
    if (this.owns(token, owner)) this.owners.delete(token);
  }

  /** Caller supplies actual terminal evidence; passage of time is deliberately not a proof. */
  release(token: string, _proof: XsWakeReleaseProof): void {
    this.records.delete(token);
    this.owners.delete(token);
  }

  /** Only call once teardown is PROVEN, not on reload/session_shutdown (those preserve pending actions). */
  teardown(sessionId: string): void {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) this.release(record.token, "teardown");
    }
  }
}

const LEDGER_KEY = Symbol.for("pi-subagent:xs-wake-ledger");

/** No reset in production: this same object must survive jiti reloads / session stack replacement. */
export function getXsWakeLedger(): XsWakeLedger {
  const global = globalThis as Record<symbol, XsWakeLedger | undefined>;
  return (global[LEDGER_KEY] ??= new XsWakeLedger());
}
