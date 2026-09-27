/**
 * todo #27 (child-extension-missing diagnostic).
 *
 * Background (AGENTS.md's `src/runtime/` note): `session-driver.ts`'s
 * `toCreateOptions`/`PiSessionDriver` rediscovers extensions for every
 * spawned child session purely from settings.json (`SettingsManager` /
 * `DefaultResourceLoader`, the same discovery `pi -p` itself uses) — never
 * from whatever `-e <path>` / `--no-extensions` flags the PARENT pi process
 * was started with. So if this package is loaded into the parent via `-e`
 * (or the settings.json `packages`/`extensions` list simply omits it), every
 * child session this package spawns never activates it at all: bash-job
 * settle-hold, switch_context, memory injection and cache-ttl keepalive all
 * silently do nothing for that run, with no error anywhere. Use `pi install`
 * instead so settings.json actually lists the package.
 *
 * This module is the process-internal signal `PiSessionDriver` (session-driver.ts)
 * reads to detect that condition, without parsing settings.json itself.
 *
 * Design: a monotonic counter keyed by `Symbol.for` (survives pi's own
 * module-cache-free `/reload` re-import, same convention as `src/index.ts`'s
 * `HOST_KEY` guard) that `src/index.ts`'s `isChildSession` branch increments
 * on every child activation, unconditionally (no settings gate — this must
 * fire regardless of which optional features are on).
 *
 * Correctness argument for using "did the counter advance ANYWHERE during my
 * own await window" as a proxy for "did MY child session activate it": this
 * package's discoverability to a spawned child session depends only on the
 * ONE shared settings.json `packages`/`extensions` list every
 * `SettingsManager` in this process reads — never on which particular spawn
 * call is asking — so it is a process-wide binary fact (activation happens
 * for every child spawned in this process, or for none of them), not a
 * per-call one. Several concurrent spawns' activations can interleave inside
 * one call's window; each of THEIR activations still proves the SAME
 * package-wide fact this call needs, so counting any advance (not exactly
 * one) is correct, not just convenient. The one scenario this deliberately
 * does not chase with per-call precision is settings.json being edited
 * mid-process between two concurrent spawns — an edge case not worth solving
 * for a diagnostic-only signal (see docs/dev's note on this todo).
 */

const CHILD_ACTIVATION_COUNT_KEY = Symbol.for("pi-subagent:child-activation-count");
type CountedGlobal = typeof globalThis & { [CHILD_ACTIVATION_COUNT_KEY]?: number };

function countedGlobal(): CountedGlobal {
  return globalThis as CountedGlobal;
}

/** Called unconditionally from `src/index.ts`'s `isChildSession` branch, once per child activation. */
export function markChildExtensionActivated(): void {
  const g = countedGlobal();
  g[CHILD_ACTIVATION_COUNT_KEY] = (g[CHILD_ACTIVATION_COUNT_KEY] ?? 0) + 1;
}

/** Snapshot the current counter value — take this BEFORE awaiting a session create/resume call. */
export function childActivationSnapshot(): number {
  return countedGlobal()[CHILD_ACTIVATION_COUNT_KEY] ?? 0;
}

/**
 * True iff the counter advanced at least once since `since` (see module doc
 * above for why this is an accurate process-wide proxy, not a per-call one).
 */
export function childActivationAdvanced(since: number): boolean {
  return childActivationSnapshot() > since;
}
