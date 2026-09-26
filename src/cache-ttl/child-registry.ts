/**
 * Child-session keepalive dispose registry (child-context-switch plan.md §2.4 "终态" ③).
 *
 * A process-wide, `Symbol.for`-backed singleton (same pattern as
 * `src/bash/child-registry.ts` / `src/cache-ttl/ping-ledger.ts` / `src/core/worktree-origin.ts`)
 * that lets a child session's `CacheKeepaliveService` register its own `dispose()` under its
 * session id, and lets the MAIN session's `onReaped(runId, forkSessionFrom, sessionId)` callback
 * (wired in `src/stack.ts`, forwarded by the runner after every run — see
 * `RunnerDeps.onReaped`) reach across the process to actually stop it, even when the child's own
 * `agent_settled` path was somehow never taken (defensive fan-out, same rationale as
 * `ChildBashRegistry.sealAndKill`).
 *
 * No module-scope mutable state (AGENTS.md: the extension re-activates on `/reload` without
 * busting Node's module cache) — the registry lives behind `CHILD_KEEPALIVE_DISPOSE_KEY` on
 * `globalThis`, built lazily and never reset (a `/reload` must not forget a still-alive child
 * session's entry).
 */

export const CHILD_KEEPALIVE_DISPOSE_KEY = Symbol.for("pi-subagent:child-keepalive");

export interface ChildKeepaliveDisposeRegistry {
  /** Registers (or replaces) this session's dispose callback. */
  register(sessionId: string, dispose: () => void): void;
  /** Idempotent: removes and calls the registered dispose exactly once; a second call, or a
   *  call for a session that never registered, is a silent no-op. Never throws — `dispose()`
   *  itself is wrapped in a try/catch (the registry must never break the runner's onReaped fan-out). */
  disposeSession(sessionId: string): void;
}

function createRegistry(): ChildKeepaliveDisposeRegistry {
  const entries = new Map<string, () => void>();
  return {
    register(sessionId, dispose) {
      entries.set(sessionId, dispose);
    },
    disposeSession(sessionId) {
      const dispose = entries.get(sessionId);
      if (!dispose) return;
      entries.delete(sessionId);
      try {
        dispose();
      } catch {
        // best effort — a throwing dispose must never break the caller (runner onReaped fan-out).
      }
    },
  };
}

export function getChildKeepaliveDisposeRegistry(): ChildKeepaliveDisposeRegistry {
  const g = globalThis as Record<symbol, ChildKeepaliveDisposeRegistry | undefined>;
  const existing = g[CHILD_KEEPALIVE_DISPOSE_KEY];
  if (existing) return existing;
  const created = createRegistry();
  g[CHILD_KEEPALIVE_DISPOSE_KEY] = created;
  return created;
}
