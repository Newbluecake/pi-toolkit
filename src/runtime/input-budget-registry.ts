import type { InputBudget } from "../core/types.js";

/** Process-wide registry used by child-session extensions to measure provider payloads. */
export const INPUT_BUDGET_REGISTRY_KEY = Symbol.for("pi-subagent:input-budget-registry");
export const INPUT_BUDGET_REGISTRY_MAX_ENTRIES = 256;

export interface InputBudgetRegistration {
  readonly maxInputTokens: number;
  readonly bytesPerToken: 2;
  readonly onMeasure: (payloadBytes: number) => void;
  readonly abort: (reason: string) => void;
  readonly generation: number;
}

export interface InputBudgetRegistry {
  subscribe(listener: (sessionId: string) => void): () => void;
  register(
    sessionId: string,
    entry: Omit<InputBudgetRegistration, "generation">,
  ): { generation: number; unregister: () => void } | undefined;
  unregister(sessionId: string, generation: number): void;
  get(sessionId: string): InputBudgetRegistration | undefined;
  size(): number;
  /** Live (non-collected) listener count; prunes dead weak refs first. */
  listenerCount(): number;
}

export interface CreateInputBudgetRegistryOptions {
  /**
   * Test seam: wraps a listener in the weak reference the registry stores.
   * Defaults to `new WeakRef`; injectable so tests can simulate collection
   * deterministically (no `--expose-gc` needed).
   */
  readonly createListenerRef?: (listener: (sessionId: string) => void) => WeakRef<(sessionId: string) => void>;
}

export function createInputBudgetRegistry(options: CreateInputBudgetRegistryOptions = {}): InputBudgetRegistry {
  const createListenerRef =
    options.createListenerRef ?? ((listener: (sessionId: string) => void) => new WeakRef(listener));
  const entries = new Map<string, InputBudgetRegistration>();
  // Leak fix (heap-snapshot evidence, introduced 5442a910): child sessions install
  // their provider measurer via `subscribe`, and the listener closure captures the
  // child `pi` object — i.e. the whole child AgentSession graph. A child session torn
  // down through `AgentSession.dispose()` never emits `session_shutdown`, so the
  // unsubscribe hook never fires and a strong Set here pinned every finished session
  // forever. Hold listeners weakly instead: the child session itself keeps its
  // `install` closure alive (see `wireChildSession`), and dead refs are pruned lazily
  // on the next broadcast/subscription. The set is therefore bounded by live child
  // sessions plus not-yet-pruned empty WeakRef shells.
  const listeners = new Set<WeakRef<(sessionId: string) => void>>();
  let nextGeneration = 0;
  const pruneCollected = () => {
    for (const ref of listeners) {
      if (!ref.deref()) listeners.delete(ref);
    }
  };
  const broadcast = (sessionId: string) => {
    for (const ref of [...listeners]) {
      const listener = ref.deref();
      if (!listener) {
        listeners.delete(ref);
        continue;
      }
      try {
        listener(sessionId);
      } catch {
        // A stale child-session listener must never block registration.
      }
    }
  };
  return {
    subscribe(listener) {
      const ref = createListenerRef(listener);
      listeners.add(ref);
      for (const sessionId of entries.keys()) {
        try {
          listener(sessionId);
        } catch {
          // A stale child-session listener must never block subscription.
        }
      }
      return () => listeners.delete(ref);
    },
    register(sessionId, entry) {
      if (entries.size >= INPUT_BUDGET_REGISTRY_MAX_ENTRIES && !entries.has(sessionId)) return undefined;
      const generation = ++nextGeneration;
      const isNewSession = !entries.has(sessionId);
      entries.set(sessionId, { ...entry, generation });
      if (isNewSession) broadcast(sessionId);
      return {
        generation,
        unregister: () => {
          const current = entries.get(sessionId);
          if (current?.generation === generation) entries.delete(sessionId);
        },
      };
    },
    unregister(sessionId, generation) {
      const current = entries.get(sessionId);
      if (current?.generation === generation) entries.delete(sessionId);
    },
    get: (sessionId) => entries.get(sessionId),
    size: () => entries.size,
    listenerCount() {
      pruneCollected();
      return listeners.size;
    },
  };
}

export function getInputBudgetRegistry(): InputBudgetRegistry {
  const g = globalThis as Record<symbol, InputBudgetRegistry | undefined>;
  const existing = g[INPUT_BUDGET_REGISTRY_KEY];
  if (existing) return existing;
  const created = createInputBudgetRegistry();
  g[INPUT_BUDGET_REGISTRY_KEY] = created;
  return created;
}

export function inputTokensForBytes(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 2);
}
