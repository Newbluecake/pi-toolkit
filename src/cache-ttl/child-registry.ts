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
  /**
   * Registers (or replaces) this session's dispose callback. `runId` (todo #30 follow-up, P1
   * §3.3/§3.9) is the CURRENT run's own identity — `src/cache-ttl/child.ts` reads it via
   * `getChildBashRegistry().hostView(sessionId)?.runId` at registration time (the bash
   * registry's `attachHost`, driven by the SAME `onSessionSeen` hook stack.ts fires for every
   * run, is always live well before a child session's own lazily-built keepalive service ever
   * registers — the identical host/child ordering invariant `ChildBashRegistry` relies on). This
   * is a deliberate cross-module read (bash → cache-ttl stays one-directional; cache-ttl never
   * reaches back into bash's mutable state) — it is the only process-wide source of "which run
   * currently owns this sessionId" available to a child-side registration that has no other way
   * to learn its own runId. Omitting `runId` keeps the old unconditional-dispose behavior (a
   * caller that predates this fix, or a sessionId the bash registry never saw a host for).
   */
  register(sessionId: string, dispose: () => void, runId?: string): void;
  /**
   * Idempotent: removes and calls the registered dispose exactly once; a second call, or a
   * call for a session that never registered, is a silent no-op. Never throws — `dispose()`
   * itself is wrapped in a try/catch (the registry must never break the runner's onReaped fan-out).
   *
   * P1 review fix (todo #30 follow-up): `runId`, when given, must match the runId the CURRENTLY
   * registered entry was registered under — otherwise this call is a stale caller (an old run's
   * `onReaped` fan-out arriving after a resume already registered a NEW dispose callback for the
   * same sessionId) and is a no-op, exactly like `ChildBashRegistry.sealAndKill`'s own
   * stale-caller guard. Only a caller that omits `runId` (back-compat) disposes unconditionally.
   */
  disposeSession(sessionId: string, runId?: string): void;
}

function createRegistry(): ChildKeepaliveDisposeRegistry {
  const entries = new Map<string, { dispose: () => void; runId?: string }>();
  return {
    register(sessionId, dispose, runId) {
      entries.set(sessionId, runId === undefined ? { dispose } : { dispose, runId });
    },
    disposeSession(sessionId, runId) {
      const registered = entries.get(sessionId);
      if (!registered) return;
      // Stale-caller guard (todo #30 follow-up): a caller that DOES know its own runId must match
      // the runId the live entry was registered under — never dispose a NEWER run's service just
      // because an OLDER run's own late/defensive fan-out finally arrived.
      if (runId !== undefined && registered.runId !== runId) return;
      entries.delete(sessionId);
      try {
        registered.dispose();
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
