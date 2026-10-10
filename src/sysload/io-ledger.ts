/**
 * Process-wide async-I/O admission ledger. The only mutable module-global state allowed by
 * sysload is this bounded ledger: a stuck kernel/thread-pool operation must survive reloads.
 */
export const SYSLOAD_IO_LEDGER_KEY = Symbol.for("pi-subagent:sysload-io");

export interface IoLedgerStats {
  readonly active: number;
  readonly keys: readonly string[];
  readonly capacity: number;
}

export interface IoLease {
  readonly key: string;
  readonly release: () => void;
}

export interface IoLedgerState {
  readonly active: Map<string, number>;
  readonly capacity: number;
}

const globalObject = globalThis as typeof globalThis & { [SYSLOAD_IO_LEDGER_KEY]?: IoLedgerState };
const globalState = (): IoLedgerState => {
  const existing = globalObject[SYSLOAD_IO_LEDGER_KEY];
  if (existing !== undefined) return existing;
  const created: IoLedgerState = { active: new Map(), capacity: 2 };
  globalObject[SYSLOAD_IO_LEDGER_KEY] = created;
  return created;
};

export class IoLedger {
  private readonly state: IoLedgerState;
  constructor(state: IoLedgerState = globalState()) {
    this.state = state;
  }
  tryAcquire(key: string): IoLease | undefined {
    if (key.length === 0 || this.state.active.has(key) || this.state.active.size >= this.state.capacity)
      return undefined;
    this.state.active.set(key, 1);
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        this.state.active.delete(key);
      },
    };
  }
  acquire(key: string): IoLease | undefined {
    return this.tryAcquire(key);
  }
  release(key: string): void {
    this.state.active.delete(key);
  }
  has(key: string): boolean {
    return this.state.active.has(key);
  }
  get size(): number {
    return this.state.active.size;
  }
  stats(): IoLedgerStats {
    return { active: this.state.active.size, keys: [...this.state.active.keys()], capacity: this.state.capacity };
  }
}

export function createIoLedger(): IoLedger {
  return new IoLedger();
}

export function getIoLedgerStats(): IoLedgerStats {
  return new IoLedger().stats();
}

/** Acquires a slot and releases it only when the underlying operation really settles. */
export function withIoLease<T>(ledger: IoLedger, key: string, operation: () => Promise<T>): Promise<T> | undefined {
  const lease = ledger.tryAcquire(key);
  if (lease === undefined) return undefined;
  let result: Promise<T>;
  try {
    result = operation();
  } catch (error) {
    lease.release();
    return Promise.reject(error);
  }
  return result.finally(lease.release);
}
