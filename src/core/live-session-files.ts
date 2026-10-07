// Process-wide registry of child session files that a live (not yet reaped)
// run still owns — run-persistence plan D8 (docs/dev/subagent-run-persistence/plan.md).
//
// After a `/reload` whose shutdown drain timed out, the OLD stack's run can
// still be finishing (abort_grace / reap) and appending to its child session
// jsonl while the NEW stack has already seeded that run as resumable. Resuming
// it right then would put two AgentSessions on one file (forked parentId
// chains). The runner marks a file live right before dispatching
// `session_created` and releases it once the run is physically reaped; spawn
// admission refuses a resume of a still-live file (an admission rejection,
// never a wait — zero-hang).
//
// The only mutable state lives on globalThis under a Symbol.for key — the
// same exemption class as core/worktree-origin.ts and HOST_KEY: it must be
// shared across /reload's fresh module instances. Zero pi imports; no timers.
// Unbounded only in the degenerate case of unkillable orphans (never
// released, by design: such a session may still be writing).

import { resolve } from "node:path";

const REGISTRY_KEY = Symbol.for("pi-subagent:live-session-files");

type Registry = Map<string, Set<string>>;

function registry(): Registry {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[REGISTRY_KEY] as Registry | undefined;
  if (!map) {
    map = new Map();
    g[REGISTRY_KEY] = map;
  }
  return map;
}

/** Pure key normalization (the file usually does not exist yet at mark time — pi creates it lazily). */
function key(file: string): string {
  return resolve(file);
}

/** Record that `owner` (a runId) holds `file` open. Idempotent per (file, owner). */
export function markLiveSessionFile(file: string, owner: string): void {
  if (file === "") return;
  const map = registry();
  const k = key(file);
  let owners = map.get(k);
  if (!owners) {
    owners = new Set();
    map.set(k, owners);
  }
  owners.add(owner);
}

/** Release `owner`'s hold on `file` (identity-checked: an unknown owner is a no-op). */
export function releaseLiveSessionFile(file: string, owner: string): void {
  if (file === "") return;
  const map = registry();
  const k = key(file);
  const owners = map.get(k);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size === 0) map.delete(k);
}

/** True while any owner still holds `file`. */
export function isLiveSessionFile(file: string): boolean {
  if (file === "") return false;
  return (registry().get(key(file))?.size ?? 0) > 0;
}
