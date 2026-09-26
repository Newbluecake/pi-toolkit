import type { Millis } from "./types.js";

/**
 * Compact human-readable duration ("500ms" / "59s" / "1m05s" / "1h02m"),
 * clamped so negative inputs render as "0ms".
 *
 * Lives in core (zero outward deps) so lower layers — e.g. the bash job
 * manager — can format durations without importing the UI view-model
 * (`ui/fleet-panel`), which would be a reverse layering dependency.
 */
export function formatDuration(ms: Millis): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  const s = Math.floor(clamped / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * L1 (agent-tool pool-full plan §1§5): concurrency-pool occupancy, counted
 * with the SAME inclusion/exclusion rule SlotPool itself uses — slotless
 * runs (consult forks, the nested Agent tool) are never counted, a workflow
 * child that occupies a real slot is. `free` is omitted when `limit` is 0
 * (SlotPool's own "unlimited" sentinel), never `Infinity` (which JSON.stringify
 * silently turns into `null`, corrupting a tool result's `details` payload).
 */
export interface SlotsInfo {
  limit: number;
  inUse: number;
  free?: number;
  /**
   * L1 pool-full-display fix: count of non-slotless requests that have been
   * ADMITTED (won the atomic pool-full check) but have not yet actually
   * acquired a real SlotPool slot — i.e. queued behind `limit` others.
   * Absent (or 0) when nothing is queued; only meaningful when `limit > 0`.
   */
  queued?: number;
}

/**
 * `inUse` here is deliberately capped at `limit` (never the raw admission
 * count) — see spawn-service.ts's `slotsInfo` call sites for why the
 * admission-time reservation count and the *displayed* occupancy must not
 * be the same number: the reservation counts every admitted-but-not-yet-
 * slotted request (needed to make the pool-full/queue decision atomic
 * across same-tick spawn() calls), while the display must mirror what a
 * human/model expects `slots: N/limit` to mean — never more `inUse` than
 * `limit`. The overflow (if any) is reported separately as `queued`.
 */
export function slotsInfo(limit: number, inUse: number, queued = 0): SlotsInfo {
  if (limit <= 0) return { limit, inUse };
  const cappedInUse = Math.min(limit, inUse);
  return {
    limit,
    inUse: cappedInUse,
    free: Math.max(0, limit - cappedInUse),
    ...(queued > 0 ? { queued } : {}),
  };
}

/** Compact inline marker (AGENTS.md UI text convention — English tokens only): `slots: 7/10 in use, 3 free` / `slots: 10/10 in use, 0 free, 2 queued` / `slots: 4 running (no limit)`. */
export function formatSlots(slots: SlotsInfo): string {
  if (slots.limit <= 0) return `slots: ${slots.inUse} running (no limit)`;
  const queuedSuffix = slots.queued ? `, ${slots.queued} queued` : "";
  return `slots: ${slots.inUse}/${slots.limit} in use, ${slots.free} free${queuedSuffix}`;
}
