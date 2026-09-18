// Worktree path → original cwd registry (方案 §5.6, B3).
//
// pi's CreateAgentSessionOptions has no metadata passthrough and SessionSpec
// is spread wholesale into createAgentSession, so the original cwd cannot ride
// along with a worktree-rewritten SessionSpec. The worktree extension,
// however, holds BOTH cwds at once in resolveSessionSpec — so a small in-
// process registry keyed by the worktree path closes the loop with zero
// changes to SessionSpec/driver. Memory's inject hook and tool read through
// resolveWorktreeOrigin to key injection/writes at the MAIN repo's memory dir.
//
// The only mutable state lives on globalThis under a Symbol.for key — the
// same exemption as HOST_KEY (bounded, cleaned per-reap; /reload re-activation
// shares the map so stale instances don't leak). Zero pi imports; no timers.

import { realpathSync } from "node:fs";

const REGISTRY_KEY = Symbol.for("pi-subagent:worktree-origin");

/** Hard cap; overflow evicts the OLDEST entry (FIFO, R6 — a blanket clear
 *  would silently drop still-running worktrees back to their worktree slug). */
const CAPACITY = 256;

/** Transitive resolution hop cap (worktree-of-worktree chains; also a cycle
 *  guard for hand-corrupted registries). */
const MAX_HOPS = 4;

type Registry = Map<string, string>;

function registry(): Registry {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[REGISTRY_KEY] as Registry | undefined;
  if (!map) {
    map = new Map();
    g[REGISTRY_KEY] = map;
  }
  return map;
}

/** Key normalization (R1): realpathSync.native on BOTH record and resolve
 *  sides — on macOS tmpdir() returns /var/... while /var symlinks to
 *  /private/var, and an un-normalized key on either side silently misses.
 *  Unresolvable paths (not yet created / already reaped) fall back to the
 *  raw string. */
function normalize(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function recordWorktreeOrigin(sessionCwd: string, originalCwd: string): void {
  const map = registry();
  const key = normalize(sessionCwd);
  if (map.has(key)) map.delete(key); // re-record = overwrite + refresh recency
  map.set(key, normalize(originalCwd));
  while (map.size > CAPACITY) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Transitive resolution, cap 4 hops: worktree-of-worktree resolves all the
 *  way back to the main repo. Returns undefined when no entry exists. */
export function resolveWorktreeOrigin(sessionCwd: string): string | undefined {
  const map = registry();
  let current = normalize(sessionCwd);
  let found = false;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = map.get(current);
    if (next === undefined) break;
    found = true;
    current = next;
  }
  return found ? current : undefined;
}

export function forgetWorktreeOrigin(sessionCwd: string): void {
  registry().delete(normalize(sessionCwd));
}
