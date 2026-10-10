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
}

function createRegistry(): InputBudgetRegistry {
  const entries = new Map<string, InputBudgetRegistration>();
  const listeners = new Set<(sessionId: string) => void>();
  let nextGeneration = 0;
  return {
    subscribe(listener) {
      listeners.add(listener);
      for (const sessionId of entries.keys()) {
        try {
          listener(sessionId);
        } catch {
          // A stale child-session listener must never block subscription.
        }
      }
      return () => listeners.delete(listener);
    },
    register(sessionId, entry) {
      if (entries.size >= INPUT_BUDGET_REGISTRY_MAX_ENTRIES && !entries.has(sessionId)) return undefined;
      const generation = ++nextGeneration;
      const isNewSession = !entries.has(sessionId);
      entries.set(sessionId, { ...entry, generation });
      if (isNewSession) {
        for (const listener of listeners) {
          try {
            listener(sessionId);
          } catch {
            // A stale child-session listener must never block registration.
          }
        }
      }
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
  };
}

export function getInputBudgetRegistry(): InputBudgetRegistry {
  const g = globalThis as Record<symbol, InputBudgetRegistry | undefined>;
  const existing = g[INPUT_BUDGET_REGISTRY_KEY];
  if (existing) return existing;
  const created = createRegistry();
  g[INPUT_BUDGET_REGISTRY_KEY] = created;
  return created;
}

export function isValidInputBudget(value: unknown): value is InputBudget {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.maxInputTokens === "number" &&
    Number.isFinite(entry.maxInputTokens) &&
    entry.maxInputTokens >= 0 &&
    entry.bytesPerToken === 2
  );
}

export function inputTokensForBytes(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 2);
}
