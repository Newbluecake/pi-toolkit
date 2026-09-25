import type { Millis } from "../core/types.js";
import type { WorkflowId, WorkflowTerminalStatus } from "./types.js";

/**
 * M3.6 (workflow design §9.3 Fleet UI / §9.4 `/agent status --workflow`):
 * the minimal live-activity view this milestone can honestly provide.
 *
 * Documented simplification (in the same spirit as every other M3.x
 * narrowing in this codebase): `Orchestrator` (orchestrator.ts) exposes
 * `outcomeAt1()`/`settled()` snapshots only *after* it has decided to stop
 * — there is no live "still running" snapshot API (no `WorkflowState`/
 * `reduceWorkflow` pure state machine backs it, see orchestrator.ts's own
 * module doc on what is and is not reproduced from the full §3.4 design).
 * So this registry never polls the engine; it tracks exactly what the tool
 * layer (the only caller of `Orchestrator.run()`) and the
 * `subagent:workflow:*` event stream already know: which workflows are
 * currently in flight, their declared name, when they started, their
 * absolute deadline, and their most recently entered `phase(title)` label.
 *
 * M10 (live workflow tool card) extends that bar with a per-child view —
 * still without touching `Orchestrator` internals: the data comes from
 * host.ts's `WorkflowChildEvent` feed (`subagent:workflow:child` events,
 * relayed by orchestrator.ts), i.e. the exact same chokepoint that records
 * `WorkflowOutcome.children`. "spawned" adds an active row (keyed by
 * callId), "settled" removes it and appends to a capped recent-settled
 * list with running totals. A "settled" with no preceding "spawned" (replay
 * hits, withheld calls, spawn-error paths — none of which ever announce a
 * spawn) is counted but has no active row to remove; duplicate settles of
 * the same callId count once (the map delete is idempotent, the totals are
 * guarded by a settled-callId set).
 *
 * M11 (fleet-widget pipeline view) adds the per-phase layer plus a terminal
 * linger, both fed from the same two event channels:
 *  - `register` takes an optional `plannedPhases` list (statically scanned
 *    from the script source by `phase-scan.ts`); those phases show up as
 *    `pending` chips before the script ever calls `phase()`.
 *  - Every phase the runtime actually observes (a `phase` enter event, a
 *    spawned/settled child carrying that phaseId) is tracked in entry order
 *    with spawned/settled/failed counts. The snapshot's `phases` chain is
 *    entered-phases-in-entry-order followed by planned-but-never-entered
 *    ones in scan order; a runtime phase unknown to the scan simply appends
 *    to the entered segment (chain tail among entered phases). Children
 *    without any phaseId fall into an implicit bucket that never appears on
 *    the chain but still counts in the workflow-level totals.
 *  - `unregister(id, { status })` freezes the final snapshot and keeps it in
 *    a separate lingering map for `terminalLingerMs`, exposed ONLY through
 *    `listForDisplay()` — never through `list()`. This split is load-bearing:
 *    `list()` is the "background busy" counter for keepalive
 *    (stack.ts backgroundBusy), deferred `/reload` (index.ts
 *    activeSubagentRunCount, re-counted on WORKFLOW_SETTLED_EVENT — a
 *    lingering entry there would strand the reload forever, since no event
 *    fires when the linger expires) and `/agent status` countBusy.
 */

/** M10: one in-flight child of a workflow run, as announced by host.ts's `"spawned"` event. */
export interface WorkflowChildActivity {
  readonly callId: string;
  readonly runId?: string;
  readonly label?: string;
  readonly agentType?: string;
  readonly phaseId?: string;
  readonly enteredAt: Millis;
}

/** M10: one recently settled child (capped list, most recent last) — feeds the tool card's ✓/✗ trail. */
export interface WorkflowSettledChild {
  readonly callId: string;
  readonly label?: string;
  readonly status: string;
  readonly source: "live" | "replay";
  readonly durationMs: Millis;
  /** M11: absolute settle time (the event's `at`) — the pipeline view's recent-children linger window filters on it. */
  readonly settledAt: Millis;
}

/**
 * M11: one phase chip of the pipeline chain. `state`: current phase = active;
 * an earlier-entered phase that still has unsettled children = draining (the
 * script moved on, its stragglers did not — never shown as ✓); an
 * earlier-entered phase whose children all settled = done; never-entered =
 * pending. Frozen (terminal) snapshots have neither active nor draining.
 */
export interface WorkflowPhaseActivity {
  readonly id: string;
  readonly state: "pending" | "active" | "draining" | "done";
  readonly spawned: number;
  readonly settled: number;
  /** Settled children with `status !== "completed"`. */
  readonly failed: number;
}

/** M11: stamped onto the frozen snapshot when the background registry settles the workflow. `"terminal"` = caller had no terminal status to pass. */
export interface WorkflowTerminalMark {
  readonly status: WorkflowTerminalStatus | "terminal";
  readonly endedAt: Millis;
}

export interface WorkflowActivitySnapshot {
  readonly workflowId: WorkflowId;
  readonly name: string;
  readonly startedAt: Millis;
  readonly deadlineAt?: Millis;
  readonly currentPhaseId?: string;
  /** M10: children announced as spawned and not yet settled, in announcement order. */
  readonly activeChildren: readonly WorkflowChildActivity[];
  /** M10: most recent settled children (oldest dropped past `MAX_SETTLED_KEPT`). */
  readonly settledChildren: readonly WorkflowSettledChild[];
  /** M10: totals since run start (settledChildren is capped; these are not). */
  readonly settledTotal: number;
  readonly completedTotal: number;
  readonly replayTotal: number;
  /** M11: the phase chain — entered phases in entry order, then planned-but-pending in scan order. */
  readonly phases: readonly WorkflowPhaseActivity[];
  /** M11: present only on a lingering frozen snapshot (see `listForDisplay`). */
  readonly terminal?: WorkflowTerminalMark;
}

export interface WorkflowActivityRegistryOptions {
  /** M11: wall clock for terminal-linger expiry (default `Date.now`); no timers are armed. */
  readonly now?: () => Millis;
  /** M11: how long a frozen terminal snapshot stays visible via `listForDisplay()` (default 5000; 0 removes immediately). */
  readonly terminalLingerMs?: Millis;
}

export interface WorkflowActivityRegistry {
  /**
   * Register an in-flight workflow. `plannedPhases` (optional, from
   * `scanPlannedPhases(script)`) pre-lays the chain as pending chips;
   * runtime-entered phases keep their scan slot, unknown ones append.
   */
  register(
    workflowId: WorkflowId,
    name: string,
    startedAt: Millis,
    deadlineAt?: Millis,
    plannedPhases?: readonly string[],
  ): void;
  /** Wired as (part of) the `Orchestrator`'s `emit` so `subagent:workflow:phase`/"child" events update the row without the tool needing to poll anything. */
  onEvent(channel: string, payload: unknown): void;
  /**
   * Remove the workflow from the running set. With a `status` (background.ts
   * finalize has the outcome) the frozen snapshot carries it; without one it
   * is marked `"terminal"`. The frozen copy lingers `terminalLingerMs` for
   * display — `list()` never returns it, only `listForDisplay()` does.
   */
  unregister(workflowId: WorkflowId, terminal?: { status?: WorkflowTerminalStatus }): void;
  /** Running workflows only — the "background busy" contract (keepalive / deferred reload / status). Never includes lingering terminal snapshots. */
  list(): readonly WorkflowActivitySnapshot[];
  /** Running workflows plus non-expired frozen terminal snapshots — the fleet widget's pipeline freeze. */
  listForDisplay(): readonly WorkflowActivitySnapshot[];
}

/** M10: how many settled rows the snapshot keeps for display; `settledTotal` & friends stay exact regardless. */
const MAX_SETTLED_KEPT = 8;

/** M11: default terminal linger (matches the fleet widget's run-linger default). */
const DEFAULT_TERMINAL_LINGER_MS: Millis = 5_000;

interface MutableEntry {
  name: string;
  startedAt: Millis;
  deadlineAt?: Millis;
  currentPhaseId?: string;
  plannedPhases: string[];
  enteredOrder: string[];
  enteredSet: Set<string>;
  phaseStats: Map<string, PhaseStats>;
  activeChildren: Map<string, WorkflowChildActivity>;
  settledChildren: WorkflowSettledChild[];
  settledCallIds: Set<string>;
  settledTotal: number;
  completedTotal: number;
  replayTotal: number;
}

interface PhaseStats {
  spawned: number;
  settled: number;
  failed: number;
  enteredAt: Millis;
}

/** M11: a frozen snapshot kept past `unregister` — `terminal` is always present on these. */
type LingeringSnapshot = WorkflowActivitySnapshot & { readonly terminal: WorkflowTerminalMark };

function isPhaseEnterEvent(
  channel: string,
  payload: unknown,
): payload is { workflowId: WorkflowId; phaseId: string; kind: "enter" } {
  if (channel !== "subagent:workflow:phase" || payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return typeof p.workflowId === "string" && typeof p.phaseId === "string" && p.kind === "enter";
}

/** M10: the relayed `WorkflowChildEvent` plus the orchestrator-added `workflowId`. */
type ChildEventPayload = {
  workflowId: WorkflowId;
  callId: string;
  at: Millis;
  kind: "spawned" | "settled";
  runId?: string;
  label?: string;
  agentType?: string;
  phaseId?: string;
  status?: string;
  source?: "live" | "replay";
  durationMs?: Millis;
};

/** M10: structural validation for the relayed `WorkflowChildEvent` — unknown/malformed payloads are ignored, never fatal. */
function asChildEvent(channel: string, payload: unknown): ChildEventPayload | undefined {
  if (channel !== "subagent:workflow:child" || payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.workflowId !== "string" || typeof p.callId !== "string") return undefined;
  if (p.kind !== "spawned" && p.kind !== "settled") return undefined;
  if (typeof p.at !== "number") return undefined;
  return p as unknown as ChildEventPayload;
}

export function createWorkflowActivityRegistry(
  options: WorkflowActivityRegistryOptions = {},
): WorkflowActivityRegistry {
  const now = options.now ?? (() => Date.now());
  const terminalLingerMs = options.terminalLingerMs ?? DEFAULT_TERMINAL_LINGER_MS;
  const entries = new Map<WorkflowId, MutableEntry>();
  const lingering = new Map<WorkflowId, LingeringSnapshot>();

  function statsFor(entry: MutableEntry, phaseId: string): PhaseStats {
    const existing = entry.phaseStats.get(phaseId);
    if (existing !== undefined) return existing;
    const created: PhaseStats = { spawned: 0, settled: 0, failed: 0, enteredAt: now() };
    entry.phaseStats.set(phaseId, created);
    return created;
  }

  /** First observation wins the chain slot; later re-entries keep the original position. */
  function markEntered(entry: MutableEntry, phaseId: string): void {
    if (entry.enteredSet.has(phaseId)) return;
    entry.enteredSet.add(phaseId);
    entry.enteredOrder.push(phaseId);
  }

  /** Entered phases in entry order, then planned-but-never-entered in scan order. Frozen (terminal) snapshots show no active chip. */
  function phasesOf(entry: MutableEntry, frozen: boolean): WorkflowPhaseActivity[] {
    const ordered = [...entry.enteredOrder];
    for (const planned of entry.plannedPhases) {
      if (!entry.enteredSet.has(planned)) ordered.push(planned);
    }
    return ordered.map((id) => {
      const stats = entry.phaseStats.get(id);
      const entered = entry.enteredSet.has(id);
      const unsettled = (stats?.spawned ?? 0) > (stats?.settled ?? 0);
      const state: WorkflowPhaseActivity["state"] =
        !frozen && id === entry.currentPhaseId
          ? "active"
          : !entered
            ? "pending"
            : !frozen && unsettled
              ? "draining"
              : "done";
      return {
        id,
        state,
        spawned: stats?.spawned ?? 0,
        settled: stats?.settled ?? 0,
        failed: stats?.failed ?? 0,
      };
    });
  }

  function snapshotOf(workflowId: WorkflowId, e: MutableEntry, frozen: boolean): WorkflowActivitySnapshot {
    return {
      workflowId,
      name: e.name,
      startedAt: e.startedAt,
      ...(e.deadlineAt !== undefined ? { deadlineAt: e.deadlineAt } : {}),
      ...(e.currentPhaseId !== undefined ? { currentPhaseId: e.currentPhaseId } : {}),
      activeChildren: [...e.activeChildren.values()],
      settledChildren: [...e.settledChildren],
      settledTotal: e.settledTotal,
      completedTotal: e.completedTotal,
      replayTotal: e.replayTotal,
      phases: phasesOf(e, frozen),
    };
  }

  function pruneLingering(): void {
    if (terminalLingerMs <= 0) {
      lingering.clear();
      return;
    }
    const at = now();
    for (const [id, snap] of lingering) {
      if (at - snap.terminal.endedAt > terminalLingerMs) lingering.delete(id);
    }
  }

  return {
    register(workflowId, name, startedAt, deadlineAt, plannedPhases) {
      // A lingering frozen copy of a recycled id would double-render; the live entry replaces it.
      lingering.delete(workflowId);
      entries.set(workflowId, {
        name,
        startedAt,
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        plannedPhases: plannedPhases === undefined ? [] : [...plannedPhases],
        enteredOrder: [],
        enteredSet: new Set(),
        phaseStats: new Map(),
        activeChildren: new Map(),
        settledChildren: [],
        settledCallIds: new Set(),
        settledTotal: 0,
        completedTotal: 0,
        replayTotal: 0,
      });
    },
    onEvent(channel, payload) {
      const phase = isPhaseEnterEvent(channel, payload) ? payload : undefined;
      if (phase !== undefined) {
        const entry = entries.get(phase.workflowId);
        if (entry) {
          entry.currentPhaseId = phase.phaseId;
          markEntered(entry, phase.phaseId);
        }
        return;
      }
      const child = asChildEvent(channel, payload);
      if (child === undefined) return;
      const entry = entries.get(child.workflowId);
      if (!entry) return;
      if (child.kind === "spawned") {
        entry.activeChildren.set(child.callId, {
          callId: child.callId,
          ...(child.runId !== undefined ? { runId: child.runId } : {}),
          ...(child.label !== undefined ? { label: child.label } : {}),
          ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
          ...(child.phaseId !== undefined ? { phaseId: child.phaseId } : {}),
          enteredAt: child.at,
        });
        if (child.phaseId !== undefined) {
          markEntered(entry, child.phaseId);
          statsFor(entry, child.phaseId).spawned += 1;
        }
        return;
      }
      // kind === "settled" — the phase comes from the event itself, else from
      // the spawned row we are about to remove (callId lookup).
      const active = entry.activeChildren.get(child.callId);
      const phaseId = child.phaseId ?? active?.phaseId;
      entry.activeChildren.delete(child.callId);
      if (entry.settledCallIds.has(child.callId)) return; // defensive: count each call exactly once.
      entry.settledCallIds.add(child.callId);
      entry.settledTotal += 1;
      if (child.status === "completed") entry.completedTotal += 1;
      if (child.source === "replay") entry.replayTotal += 1;
      if (phaseId !== undefined) {
        markEntered(entry, phaseId);
        const stats = statsFor(entry, phaseId);
        stats.settled += 1;
        if (child.status !== "completed") stats.failed += 1;
      }
      entry.settledChildren.push({
        callId: child.callId,
        ...(child.label !== undefined ? { label: child.label } : {}),
        status: child.status ?? "unknown",
        source: child.source ?? "live",
        durationMs: child.durationMs ?? 0,
        settledAt: child.at,
      });
      if (entry.settledChildren.length > MAX_SETTLED_KEPT) {
        entry.settledChildren.splice(0, entry.settledChildren.length - MAX_SETTLED_KEPT);
      }
    },
    unregister(workflowId, terminal) {
      const entry = entries.get(workflowId);
      if (entry === undefined) return;
      entries.delete(workflowId);
      if (terminalLingerMs <= 0) return;
      const mark: WorkflowTerminalMark = { status: terminal?.status ?? "terminal", endedAt: now() };
      lingering.set(workflowId, { ...snapshotOf(workflowId, entry, true), terminal: mark });
    },
    list() {
      pruneLingering();
      return [...entries.entries()].map(([workflowId, e]) => snapshotOf(workflowId, e, false));
    },
    listForDisplay() {
      const live = this.list();
      return live.length > 0 || lingering.size > 0 ? [...live, ...lingering.values()] : live;
    },
  };
}
