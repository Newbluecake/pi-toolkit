/**
 * `RunVisualState` mapping (vue-plan.md v2.1 §3.2, §5.2 — P1): the single source of truth every
 * status pill / agent card / fleet row / tool card colors itself from (ui-design.md §3.2's
 * status-color table), so the ten states never get reimplemented slightly differently in four
 * places. Pure functions — no DOM, no Vue reactivity — tested by exhaustively covering every row
 * of that table.
 */
import type { FleetRowWire } from "@protocol/messages.js";
import type { AgentState, RunVisualState } from "../types.js";

/** ui-design.md §3.2, subagent/fleet-row column ("来源字段"): `FleetRowWire.status` / `highlight`
 * / `terminal` drive a subagent tree row's state — `phaseLabel` disambiguates a live
 * (non-terminal) row between "running" / "thinking" / "tool". */
export function fleetRowVisualState(
  row: Pick<FleetRowWire, "status" | "phaseLabel" | "highlight" | "terminal">,
): RunVisualState {
  if (row.highlight === "crit") return "failed";
  if (row.status === "failed") return "failed";
  if (row.status === "timed_out") return "timed_out";
  if (row.status === "aborted") return "aborted";
  if (row.status === "queued") return "queued";
  if (row.terminal && row.status === "completed") return "done";
  const phase = row.phaseLabel.toLowerCase();
  if (phase.includes("tool")) return "tool";
  if (phase.includes("model_turn") || phase.includes("thinking")) return "thinking";
  if (row.status === "running") return "running";
  return row.terminal ? "done" : "idle";
}

/** ui-design.md §3.2, agent-card column: `agent_down` → offline; a non-empty `prompts[]` (blocked
 * on a dialog) → waiting; `card.state==="stale"` → stale; `status.busy` → running; else idle. */
export function agentVisualState(agent: Pick<AgentState, "down" | "prompts" | "card" | "status">): RunVisualState {
  if (agent.down) return "offline";
  if (agent.prompts.length > 0) return "waiting";
  const cardState = (agent.card as { state?: unknown }).state;
  if (cardState === "stale") return "stale";
  const busy = (agent.status as { busy?: unknown } | undefined)?.busy;
  if (busy === true) return "running";
  return "idle";
}
