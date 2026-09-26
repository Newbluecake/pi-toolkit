import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { RunDiagnostics, RunSnapshot } from "../core/types.js";
import { displayAgentType } from "../core/types.js";
import { isTerminalStatus } from "../core/status.js";
import { formatDuration } from "../core/format.js";
import { formatSlots, type SlotsInfo } from "../core/format.js";
import { formatModelRef } from "../ui/fleet-panel.js";
import type { WorkflowActivitySnapshot, WorkflowChildActivity, WorkflowQueuedChild } from "../workflow/activity.js";

/** L1 todo #19: hard cap on `recent` — a runaway session could have thousands of terminal runs recorded. */
export const LIST_SUBAGENTS_MAX_RECENT = 20;

export const ListSubagentsParams = Type.Object({
  recent: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: LIST_SUBAGENTS_MAX_RECENT,
      description:
        "Also include the most recently finished (terminal) runs, newest first — up to this many (default 0, max 20). Useful to look up the run_id of something that just completed.",
    }),
  ),
});
export type ListSubagentsParams = Static<typeof ListSubagentsParams>;

/** One flattened row of the active run tree (details.runs / details.recent). `depth` is nesting depth under its top-level ancestor (0 = root). */
export interface ListSubagentsRunRow {
  runId: string;
  label?: string;
  agentType?: string;
  model?: { provider: string; id: string };
  status: string;
  phase: string;
  /** Only set while status is "queued" (phase "queue_wait"). */
  queueWaitMs?: number;
  elapsedMs: number;
  turns: number;
  costUsd?: number;
  parentRunId?: string;
  depth: number;
}

/** One workflow child, active or still queued behind maxParallel — `run` is populated whenever a live run snapshot exists for it. */
export interface ListSubagentsWorkflowChild {
  callId: string;
  runId?: string;
  label?: string;
  agentType?: string;
  phaseId?: string;
  queued: boolean;
  elapsedMs: number;
  run?: ListSubagentsRunRow;
  /** Nested descendants of this workflow child (e.g. its own nested Agent runs), depth ≥ 2, in tree order. */
  descendants?: ListSubagentsRunRow[];
}

export interface ListSubagentsWorkflowRow {
  workflowId: string;
  name: string;
  /** The activity feed only carries live workflows: "grace" while inside a timeout grace window, else "running". */
  status: "running" | "grace";
  currentPhaseId?: string;
  deadlineAt?: number;
  remainingMs?: number;
  /** Absolute end-of-grace timestamp, present only while the workflow is inside a timeout grace window. */
  graceUntil?: number;
  /** `graceUntil - now`, clamped to 0 — what the text line actually renders (never re-derived from a stale `graceUntil` at format time). */
  graceRemainingMs?: number;
  extensions?: number;
  children: ListSubagentsWorkflowChild[];
}

export interface ListSubagentsDetails {
  runs: ListSubagentsRunRow[];
  workflows: ListSubagentsWorkflowRow[];
  slots: SlotsInfo;
  recent?: ListSubagentsRunRow[];
}

function runRow(s: RunSnapshot, now: number, depth: number): ListSubagentsRunRow {
  const d: RunDiagnostics = s.diag;
  return {
    runId: s.runId,
    ...(d.label !== undefined ? { label: d.label } : {}),
    ...(d.agentType !== undefined ? { agentType: displayAgentType(d.agentType) } : {}),
    ...(d.model !== undefined ? { model: d.model } : {}),
    status: s.status,
    phase: s.phase,
    ...(s.status === "queued" && d.enqueuedAt !== undefined ? { queueWaitMs: Math.max(0, now - d.enqueuedAt) } : {}),
    elapsedMs: Math.max(0, now - d.createdAt),
    turns: d.turns,
    ...(d.usage !== undefined ? { costUsd: d.usage.costUsd } : {}),
    ...(s.parentRunId !== undefined ? { parentRunId: s.parentRunId } : {}),
    depth,
  };
}

function formatRunLine(row: ListSubagentsRunRow): string {
  const indent = "  ".repeat(row.depth);
  const marker = row.depth > 0 ? "└─ " : "";
  const label = row.label !== undefined ? `"${row.label}"` : "·";
  const type = row.agentType ?? "·";
  const model = formatModelRef(row.model) ?? "·";
  const phaseInfo =
    row.queueWaitMs !== undefined ? `queue_wait ${formatDuration(row.queueWaitMs)}` : `${row.status}/${row.phase}`;
  const cost = row.costUsd !== undefined ? `$${row.costUsd.toFixed(4)}` : "$0.0000";
  return (
    `${indent}${marker}${row.runId}  ${label}  ${type}  ${model}  ${phaseInfo}  ` +
    `elapsed ${formatDuration(row.elapsedMs)}  ${row.turns}t  ${cost}`
  );
}

function formatRecentLine(row: ListSubagentsRunRow): string {
  const label = row.label !== undefined ? `"${row.label}"` : "·";
  const cost = row.costUsd !== undefined ? `$${row.costUsd.toFixed(4)}` : "$0.0000";
  return `  ${row.runId}  ${label}  ${row.status}  ended ${formatDuration(row.elapsedMs)} ago  ${cost}`;
}

/**
 * L1 todo #19: build the active run tree, EXCLUDING every run whose
 * `parentRunId` names a running SubagentWorkflow (`wf_…`, per
 * tools/workflow-target.ts's frozen contract "a workflow's children carry it
 * as their parentRunId") — those are rendered nested under their workflow
 * row instead (`workflowRows` below), never duplicated at the top level.
 * Everything else nests by real `parentRunId` (nested Agent-tool / consult
 * children of another still-tracked run); a `parentRunId` that does not
 * resolve to any tracked run (dangling — the parent already settled) falls
 * back to being rendered as its own root, never dropped.
 */
function buildRunTree(
  nonTerminal: readonly RunSnapshot[],
  workflowIds: ReadonlySet<string>,
  now: number,
): ListSubagentsRunRow[] {
  const owned = workflowOwnedRunIds(nonTerminal, workflowIds);
  const independent = nonTerminal.filter((s) => !owned.has(s.runId));
  const byId = new Map(independent.map((s) => [s.runId, s]));
  const childrenOf = new Map<string, RunSnapshot[]>();
  const roots: RunSnapshot[] = [];
  for (const s of independent) {
    if (s.parentRunId !== undefined && byId.has(s.parentRunId)) {
      const siblings = childrenOf.get(s.parentRunId) ?? [];
      siblings.push(s);
      childrenOf.set(s.parentRunId, siblings);
    } else {
      roots.push(s);
    }
  }
  const rows: ListSubagentsRunRow[] = [];
  const visited = new Set<string>();
  const visit = (s: RunSnapshot, depth: number) => {
    if (visited.has(s.runId)) return; // defensive: a malformed parentRunId cycle must never infinite-loop this walk
    visited.add(s.runId);
    rows.push(runRow(s, now, depth));
    for (const child of childrenOf.get(s.runId) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/**
 * Every non-terminal run that belongs to a live workflow's subtree: its direct
 * children (parentRunId = wf_…) plus, transitively, their own descendants —
 * all rendered under the workflow row, never re-surfacing as top-level roots.
 */
function workflowOwnedRunIds(nonTerminal: readonly RunSnapshot[], workflowIds: ReadonlySet<string>): Set<string> {
  const owned = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of nonTerminal) {
      if (owned.has(s.runId) || s.parentRunId === undefined) continue;
      if (workflowIds.has(s.parentRunId) || owned.has(s.parentRunId)) {
        owned.add(s.runId);
        grew = true;
      }
    }
  }
  return owned;
}

/** Depth-first descendants of `rootId` among `nonTerminal`, starting at `depth`. Cycle-safe. */
function descendantRows(
  rootId: string,
  nonTerminal: readonly RunSnapshot[],
  now: number,
  depth: number,
  seen: Set<string> = new Set([rootId]),
): ListSubagentsRunRow[] {
  const rows: ListSubagentsRunRow[] = [];
  for (const s of nonTerminal) {
    if (s.parentRunId !== rootId || seen.has(s.runId)) continue;
    seen.add(s.runId);
    rows.push(runRow(s, now, depth));
    rows.push(...descendantRows(s.runId, nonTerminal, now, depth + 1, seen));
  }
  return rows;
}

function workflowRemainingMs(w: WorkflowActivitySnapshot, now: number): number | undefined {
  return w.deadlineAt !== undefined ? Math.max(0, w.deadlineAt - now) : undefined;
}

function formatWorkflowHeader(w: ListSubagentsWorkflowRow): string {
  const remaining = w.remainingMs !== undefined ? `remaining ${formatDuration(w.remainingMs)}` : "no deadline";
  const grace = w.graceRemainingMs !== undefined ? ` [grace ${formatDuration(w.graceRemainingMs)} left]` : "";
  const ext = w.extensions ? ` ext=${w.extensions}` : "";
  return `${w.workflowId}  "${w.name}"  ${w.status}  phase=${w.currentPhaseId ?? "-"}  ${remaining}${grace}${ext}`;
}

function formatWorkflowChildLines(child: ListSubagentsWorkflowChild): string[] {
  const descendants = (child.descendants ?? []).map((row) => formatRunLine(row));
  if (child.run) return [formatRunLine({ ...child.run, depth: 1 }), ...descendants];
  return [formatWorkflowChildStub(child), ...descendants];
}

function formatWorkflowChildStub(child: ListSubagentsWorkflowChild): string {
  const label = child.label !== undefined ? `"${child.label}"` : (child.runId ?? child.callId);
  const type = child.agentType ?? "·";
  const phase = child.phaseId ? ` phase=${child.phaseId}` : "";
  const state = child.queued ? "queued" : "starting";
  return `  └─ ${label}  ${type}${phase}  ${state} ${formatDuration(child.elapsedMs)}`;
}

function buildWorkflowRow(
  w: WorkflowActivitySnapshot,
  now: number,
  snapshotOf: (runId: string) => RunSnapshot | undefined,
  nonTerminal: readonly RunSnapshot[] = [],
): ListSubagentsWorkflowRow {
  const active: ListSubagentsWorkflowChild[] = w.activeChildren.map((c: WorkflowChildActivity) => {
    const run = c.runId !== undefined ? snapshotOf(c.runId) : undefined;
    const descendants = c.runId !== undefined ? descendantRows(c.runId, nonTerminal, now, 2) : [];
    return {
      callId: c.callId,
      ...(c.runId !== undefined ? { runId: c.runId } : {}),
      ...(c.label !== undefined ? { label: c.label } : {}),
      ...(c.agentType !== undefined ? { agentType: displayAgentType(c.agentType) } : {}),
      ...(c.phaseId !== undefined ? { phaseId: c.phaseId } : {}),
      queued: false,
      elapsedMs: Math.max(0, now - c.enteredAt),
      ...(run !== undefined ? { run: runRow(run, now, 1) } : {}),
      ...(descendants.length ? { descendants } : {}),
    };
  });
  const queued: ListSubagentsWorkflowChild[] = w.queuedChildren.map((c: WorkflowQueuedChild) => ({
    callId: c.callId,
    ...(c.label !== undefined ? { label: c.label } : {}),
    ...(c.agentType !== undefined ? { agentType: displayAgentType(c.agentType) } : {}),
    ...(c.phaseId !== undefined ? { phaseId: c.phaseId } : {}),
    queued: true,
    elapsedMs: Math.max(0, now - c.queuedAt),
  }));
  const remainingMs = workflowRemainingMs(w, now);
  const graceRemainingMs = w.graceUntil !== undefined ? Math.max(0, w.graceUntil - now) : undefined;
  return {
    workflowId: w.workflowId,
    name: w.name,
    status: w.graceUntil !== undefined ? "grace" : "running",
    ...(w.currentPhaseId !== undefined ? { currentPhaseId: w.currentPhaseId } : {}),
    ...(w.deadlineAt !== undefined ? { deadlineAt: w.deadlineAt } : {}),
    ...(remainingMs !== undefined ? { remainingMs } : {}),
    ...(w.graceUntil !== undefined ? { graceUntil: w.graceUntil } : {}),
    ...(graceRemainingMs !== undefined ? { graceRemainingMs } : {}),
    ...(w.extensions !== undefined ? { extensions: w.extensions } : {}),
    children: [...active, ...queued],
  };
}

/**
 * "list_subagents" — L1 todo #19 (2026-09-26 user decision: a standalone
 * read-only tool, registered alongside get_subagent_result). Answers the two
 * questions a dispatcher otherwise has no tool for: "is there a free slot
 * right now" and "what is the run_id / workflow id of the thing I want to
 * check on / steer / abort / message" — without guessing a label or waiting
 * for a notification. Never mutates anything; safe to poll (though there is
 * no reason to poll it in a tight loop — nothing here changes faster than a
 * subagent's own progress).
 *
 * Registration (see AGENTS.md HOST_KEY guard / runtime/tool-scope.ts):
 * main-session only. `get_subagent_result` — the tool this one is meant to
 * sit next to — is injected into a child (subagent) session ONLY via the
 * nested Agent tool's own blocking result path (service/runtime-adapter.ts),
 * never as a standalone tool; a child never gets a standalone
 * `get_subagent_result` to pair this with. Mirroring that: this tool is
 * main-session only too, and NOT added to a nested-Agent child's tool set.
 * `list_subagents` is still added to `RESERVED_TOOL_NAMES`
 * (runtime/tool-scope.ts) purely as defense-in-depth against an
 * MCP/late-registered same-name tool leaking into a child session — the
 * same treatment `get_subagent_result`/`steer_subagent` already get despite
 * never being granted there.
 */
export function createListSubagentsTool(deps: {
  query: QueryService;
  spawn: { slots(): SlotsInfo };
  /** Running workflows only, same port shape `/agent status`'s WORKFLOWS section reads (commands/status.ts). Absent (workflow feature off) ⇒ section 2 never renders. */
  workflow?: { activity: { list(): readonly WorkflowActivitySnapshot[] } };
  now?: () => number;
}): ToolDefinition<typeof ListSubagentsParams> {
  return {
    name: "list_subagents",
    label: "List Subagents",
    description:
      "List every currently active subagent run and SubagentWorkflow in this session: label, run_id, agent " +
      "type, model (provider/id), phase (including queue_wait), elapsed time, turns, accumulated cost, and " +
      "parent/child nesting (nested Agent-tool children indented under their parent; workflow children listed " +
      "under their workflow) — plus the current concurrency pool occupancy (`slots: N/limit in use, K free`, " +
      "same accounting as the Agent tool's own trailer: a workflow itself never occupies a slot, its children " +
      "do, consult forks never do). Call this BEFORE dispatching with the Agent tool to check for a free slot, " +
      "and whenever you need a run_id or workflow id (wf_…) for get_subagent_result / steer_subagent / " +
      "abort_subagent / message_agent / extend_subagent_timeout without guessing a label. Set `recent` " +
      "(0-20, default 0) to also list the most recently finished runs, newest first — handy right after a " +
      "run just settled. Read-only: never starts, stops, or steers anything.",
    promptSnippet: "list_subagents(recent?) - list active subagent runs/workflows, free slots, and run_ids",
    parameters: ListSubagentsParams,
    renderCall(_args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("List Subagents")));
      return text;
    },
    async execute(_toolCallId, params) {
      const now = deps.now?.() ?? Date.now();
      const allRuns = deps.query.list();
      const workflowSnapshots = deps.workflow?.activity.list() ?? [];
      const workflowIds = new Set(workflowSnapshots.map((w) => w.workflowId));
      const nonTerminal = allRuns.filter((s) => !isTerminalStatus(s.status));
      const runs = buildRunTree(nonTerminal, workflowIds, now);
      const workflows = workflowSnapshots.map((w) =>
        buildWorkflowRow(w, now, (runId) => deps.query.get(runId), nonTerminal),
      );
      const slots = deps.spawn.slots();
      const recentN = Math.max(0, Math.min(params.recent ?? 0, LIST_SUBAGENTS_MAX_RECENT));
      const recentRows =
        recentN > 0
          ? allRuns
              .filter((s) => isTerminalStatus(s.status))
              .sort((a, b) => (b.diag.settledAt ?? b.updatedAt) - (a.diag.settledAt ?? a.updatedAt))
              .slice(0, recentN)
              .map((s) => runRow(s, now, 0))
          : undefined;

      const lines: string[] = [];
      if (workflows.length) {
        lines.push(`Workflows: ${workflows.length} active`);
        for (const w of workflows) {
          lines.push(`  ${formatWorkflowHeader(w)}`);
          for (const child of w.children) for (const line of formatWorkflowChildLines(child)) lines.push(`  ${line}`);
        }
      }
      if (runs.length) {
        lines.push(`Subagent runs: ${runs.length} active`);
        for (const row of runs) lines.push(`  ${formatRunLine(row)}`);
      }
      if (workflows.length === 0 && runs.length === 0) {
        lines.push("No active subagent runs or workflows.");
      }
      lines.push(formatSlots(slots));
      if (recentRows !== undefined) {
        if (recentRows.length) {
          lines.push(`Recent (${recentRows.length}):`);
          for (const row of recentRows) lines.push(formatRecentLine(row));
        } else {
          lines.push("Recent (0): no terminal runs recorded this session.");
        }
      }

      const details: ListSubagentsDetails = {
        runs,
        workflows,
        slots,
        ...(recentRows !== undefined ? { recent: recentRows } : {}),
      };
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details,
      };
    },
  } satisfies ToolDefinition<typeof ListSubagentsParams>;
}
