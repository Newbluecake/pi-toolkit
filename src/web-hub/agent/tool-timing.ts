/**
 * Tool-duration plan (2026-10): per-turn durability for tool execution timings.
 *
 * `event-tap.ts` stamps `startedAt` (agent clock) at `tool_execution_start` and derives
 * `durationMs` at `tool_execution_end` (persisted pi messages cannot: in parallel mode
 * pi-agent-core creates all toolResult messages — with one shared `timestamp` — only after the
 * whole batch finishes). This module persists the tap's accumulated durations as ONE (or, past
 * the id cap, a few) `subagent:web-tool-timing` custom entries per `turn_end`, so a browser
 * attaching later (history / branch / run-file paths, all through `projectSessionEntry`) can
 * fold toolCallId → durationMs into its tool cards. The entries never render: the projection
 * keeps the display:false tombstone shape, and the TUI renderer registered here deliberately
 * returns `undefined` (pi's `CustomEntryComponent.hasContent()` then adds nothing — no blank
 * line, unlike an empty `Text`).
 *
 * Everything here is best-effort: append failures (stale ctx, detached session) are swallowed
 * — a missing timing entry only costs a duration chip, never a turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_TIMING_WIRE_PAIRS, WEB_TOOL_TIMING_ENTRY_TYPE } from "../protocol/keys.js";

export { WEB_TOOL_TIMING_ENTRY_TYPE };

/** Max toolCallIds per persisted entry (matches the wire-side projection cap). */
export const TOOL_TIMING_ENTRY_IDS = TOOL_TIMING_WIRE_PAIRS;

export interface ToolTimingEntryData {
  v: 1;
  t: Record<string, number>;
}

/** Append the turn's timings as bounded `subagent:web-tool-timing` entries (≤256 ids each).
 *  Never throws, never blocks; returns the number of entries appended. */
export function appendToolTimingEntries(pi: ExtensionAPI, timings: ReadonlyMap<string, number>): number {
  const ids: string[] = [];
  for (const [id, ms] of timings) {
    if (id === "" || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) continue;
    ids.push(id);
  }
  if (ids.length === 0) return 0;
  let appended = 0;
  for (let i = 0; i < ids.length; i += TOOL_TIMING_ENTRY_IDS) {
    const t: Record<string, number> = {};
    for (const id of ids.slice(i, i + TOOL_TIMING_ENTRY_IDS)) t[id] = timings.get(id)!;
    try {
      pi.appendEntry(WEB_TOOL_TIMING_ENTRY_TYPE, { v: 1, t } satisfies ToolTimingEntryData);
      appended += 1;
    } catch {
      /* stale ctx / detached session: skip the chunk, keep going */
    }
  }
  return appended;
}

/**
 * Register the `subagent:web-tool-timing` renderer — deliberately `undefined` so pi's
 * `CustomEntryComponent` reports no content and the TUI renders NOTHING (not even a blank
 * line). A pre-0.87-shaped pi without `registerEntryRenderer` degrades to the same silence
 * (`addCustomEntryToChat` returns early when no renderer exists).
 */
export function registerToolTimingEntryRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerEntryRenderer !== "function") return;
  pi.registerEntryRenderer<ToolTimingEntryData>(WEB_TOOL_TIMING_ENTRY_TYPE, () => undefined);
}
