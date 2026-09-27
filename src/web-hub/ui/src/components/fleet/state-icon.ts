/**
 * `RunVisualState` → icon (ui-design.md §3.2's "图标/形态" column) — the single lookup both
 * `FleetNode.vue` (a subagent tree row) and `ToolCard.vue` (a tool call's own, narrower state
 * set) key their status icon off, so the two never drift into picking different icons for the
 * same semantic state.
 */
import type { IconName } from "../../icons/names.js";
import type { RunVisualState } from "../../types.js";

/** `waiting`/`stale` share the "message" (dialog) icon — both are "something else is blocking
 * progress" states (ui-design.md §3.2); `queued`/`idle`/`aborted` share "clock"/neutral-dot
 * semantics (no separate icon exists for a hollow dot, `clock` is the closest available). */
export const FLEET_STATE_ICON: Readonly<Record<RunVisualState, IconName>> = {
  running: "loader",
  thinking: "sparkle",
  tool: "wrench",
  idle: "clock",
  queued: "clock",
  done: "check",
  failed: "x",
  timed_out: "x",
  waiting: "message",
  stale: "clock",
  offline: "unplug",
  aborted: "ban",
};

/** Only `running` gets the spin animation (a genuinely in-progress row); every other state's
 * icon is static. */
export function fleetStateSpins(state: RunVisualState): boolean {
  return state === "running";
}
