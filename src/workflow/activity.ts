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
 *  - The chain's unit is a VISIT (one entry into a phase name), not the
 *    name: loops that re-enter `phase("draft")` append `draft#2`, `draft#3` …
 *    at the chain tail instead of jumping back to the first slot, so a loop
 *    always reads as moving forward. A consecutive `phase(X)` (X already the
 *    current visit) opens nothing; a name never entered before opens a visit
 *    with the bare name — if it is a planned phase, that planned slot is the
 *    one it occupies (moved out of the pending tail, as before). Every phase
 *    the runtime actually observes (a `phase` enter event, a spawned/settled
 *    child carrying that phaseId) opens visits the same way; a runtime phase
 *    unknown to the scan simply appends to the entered segment. Children
 *    without any phaseId fall into an implicit bucket that never appears on
 *    the chain but still counts in the workflow-level totals.
 *  - Count attribution is per visit: a spawned child counts against its
 *    phase's LATEST visit at spawn time (recorded by callId), and a settle
 *    resolves through that recorded visit — never re-resolved by name, so a
 *    late settle from a previous loop round can never leak into the fresh
 *    visit. A settle with no spawned row but a phaseId (journal replay hits,
 *    withheld calls) counts against that name's latest visit and is tallied
 *    separately as `replayed` (replay hits carry no spawn and no duration).
 *    Past `MAX_VISITS` (32) entered visits the oldest DONE visit is dropped
 *    (the current visit and any draining one never are); `collapsedVisits`
 *    counts the drops so the widget can render `…+N` at the chain head.
 *  - `unregister(id, { status })` freezes the final snapshot and keeps it in
 *    a separate lingering map for `terminalLingerMs`, exposed ONLY through
 *    `listForDisplay()` — never through `list()`. This split is load-bearing:
 *    `list()` is the "background busy" counter for keepalive
 *    (stack.ts backgroundBusy), deferred `/reload` (index.ts
 *    activeSubagentRunCount, re-counted on WORKFLOW_SETTLED_EVENT — a
 *    lingering entry there would strand the reload forever, since no event
 *    fires when the linger expires) and `/agent status` countBusy.
 */

/**
 * workflow-agent-queue §5 (stage A): the same `subagent:workflow:child` feed
 * also carries `"queued"` (an `agent()` call acked while every maxParallel
 * slot was busy — kept in FIFO order in `queuedChildren` until its
 * "spawned"/"settled"/"rejected") and `"rejected"` (admission/dispatch
 * failures, counted once per callId in `rejectedTotal`); the separate
 * `subagent:workflow:stage_error` channel (a parallel()/pipeline() stage or an
 * unhandled rejection settled to null) is counted in `stageErrorTotal`.
 * Cancellation-class outcomes never reach either counter.
 */
/*
 * workflow-agent-queue §5 (stage B): `subagent:workflow:deadline` (kind
 * "grace" | "extended") moves the row's `deadlineAt` in place and carries
 * `graceUntil` (set on "grace", cleared on "extended" — a rescue),
 * `hardDeadlineAt` and `extensions` (granted so far) for the fleet widget's
 * `⏳grace 58s` / `⏳12m+1` header marker.
 */
export interface WorkflowQueuedChild {
  readonly callId: string;
  readonly label?: string;
  readonly agentType?: string;
  readonly phaseId?: string;
  readonly queuedAt: Millis;
}

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
 * M11 (M12 visit semantics): one chip of the pipeline chain — a VISIT of a
 * phase, not the phase name: `draft` first visit, `draft#2` re-entry (the
 * original name is kept in `name`). `state`: the current visit = active; an
 * earlier visit that still has unsettled live children = draining (the script
 * moved on, its stragglers did not — never shown as ✓); an earlier visit
 * whose live children all settled = done; planned-but-never-entered = pending
 * (name-less, `id` is the bare phase name). Frozen (terminal) snapshots have
 * neither active nor draining.
 */
export interface WorkflowPhaseActivity {
  /** Display id: the bare phase name for the first visit, `name#n` from the second entry on. */
  readonly id: string;
  /** The original phase name — present only on repeat visits (`id !== name`). */
  readonly name?: string;
  readonly state: "pending" | "active" | "draining" | "done";
  /** Live children spawned into this visit. */
  readonly spawned: number;
  /** Live children settled into this visit — replay hits are tallied in `replayed`, not here. */
  readonly settled: number;
  /** Settled children (any source) with `status !== "completed"`. */
  readonly failed: number;
  /** Journal-replay hits settled into this visit (`source === "replay"` — no spawn, no duration). */
  readonly replayed: number;
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
  /** Current soft deadline — moved in place by `subagent:workflow:deadline` events (stage B). */
  readonly deadlineAt?: Millis;
  /** Stage B: end of the current timeout grace window (present only inside one). */
  readonly graceUntil?: Millis;
  /** Stage B: the static hard ceiling, known from the first deadline event on. */
  readonly hardDeadlineAt?: Millis;
  /** Stage B: extensions granted so far (present once ≥ 1). */
  readonly extensions?: number;
  readonly currentPhaseId?: string;
  /** M10: children announced as spawned and not yet settled, in announcement order. */
  readonly activeChildren: readonly WorkflowChildActivity[];
  /** M10: most recent settled children (oldest dropped past `MAX_SETTLED_KEPT`). */
  readonly settledChildren: readonly WorkflowSettledChild[];
  /** M10: totals since run start (settledChildren is capped; these are not). */
  readonly settledTotal: number;
  readonly completedTotal: number;
  readonly replayTotal: number;
  /** workflow-agent-queue §5: calls waiting for a maxParallel slot, FIFO (oldest first). */
  readonly queuedChildren: readonly WorkflowQueuedChild[];
  /** workflow-agent-queue §5: `agent()` calls rejected at admission or dispatch (once per callId). */
  readonly rejectedTotal: number;
  /** workflow-agent-queue §5: stage errors reported by the worker (parallel/pipeline/unhandled). */
  readonly stageErrorTotal: number;
  /** M11: the phase chain — entered visits in entry order, then planned-but-pending names in scan order. */
  readonly phases: readonly WorkflowPhaseActivity[];
  /** M12: visits collapsed off the chain head past `MAX_VISITS` (oldest done ones; current/draining never). */
  readonly collapsedVisits?: number;
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

/** M12: hard cap on ENTERED visits kept on the chain; the oldest done ones collapse past it. */
const MAX_VISITS = 32;

/** M12: one visit of a phase name (the chain unit — re-entries are new tail visits, not jumps back). */
interface VisitEntry {
  /** The original phase name as spoken by `phase()`/child events. */
  readonly name: string;
  /** Display id: `name` for the first visit, `name#n` from the second entry on. */
  readonly id: string;
  spawned: number;
  settled: number;
  failed: number;
  replayed: number;
  enteredAt: Millis;
}

interface MutableEntry {
  name: string;
  startedAt: Millis;
  deadlineAt?: Millis;
  graceUntil?: Millis;
  hardDeadlineAt?: Millis;
  extensions: number;
  currentPhaseId?: string;
  plannedPhases: string[];
  visits: VisitEntry[];
  /** Index into `visits`; -1 until the first `phase` enter event. Only `enterPhase` moves it, always forward. */
  currentVisitIdx: number;
  /** Phase name → how many visits of that name were opened (drives `#n` ids and planned-slot occupation). */
  nameEntries: Map<string, number>;
  /** callId → the visit a spawned child counts against (settles resolve through it, never by name). */
  callVisits: Map<string, number>;
  collapsedVisits: number;
  activeChildren: Map<string, WorkflowChildActivity>;
  /** Insertion order = queue order (FIFO). */
  queuedChildren: Map<string, WorkflowQueuedChild>;
  rejectedCallIds: Set<string>;
  stageErrorTotal: number;
  settledChildren: WorkflowSettledChild[];
  settledCallIds: Set<string>;
  settledTotal: number;
  completedTotal: number;
  replayTotal: number;
}

/** M11: a frozen snapshot kept past `unregister` — `terminal` is always present on these. */
type LingeringSnapshot = WorkflowActivitySnapshot & { readonly terminal: WorkflowTerminalMark };

function asStageErrorEvent(channel: string, payload: unknown): { workflowId: WorkflowId } | undefined {
  if (channel !== "subagent:workflow:stage_error" || payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p.workflowId === "string" ? { workflowId: p.workflowId } : undefined;
}

/** Stage B: the `subagent:workflow:deadline` payload (orchestrator announceDeadline). Malformed → ignored. */
function asDeadlineEvent(
  channel: string,
  payload: unknown,
):
  | {
      workflowId: WorkflowId;
      kind: "grace" | "extended";
      deadlineAt: Millis;
      graceUntil?: Millis;
      hardDeadlineAt: Millis;
      extensionsUsed: number;
    }
  | undefined {
  if (channel !== "subagent:workflow:deadline" || payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.workflowId !== "string" || (p.kind !== "grace" && p.kind !== "extended")) return undefined;
  if (typeof p.deadlineAt !== "number" || typeof p.hardDeadlineAt !== "number") return undefined;
  if (typeof p.extensionsUsed !== "number") return undefined;
  return {
    workflowId: p.workflowId,
    kind: p.kind,
    deadlineAt: p.deadlineAt,
    ...(typeof p.graceUntil === "number" ? { graceUntil: p.graceUntil } : {}),
    hardDeadlineAt: p.hardDeadlineAt,
    extensionsUsed: p.extensionsUsed,
  };
}

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
  kind: "queued" | "spawned" | "settled" | "rejected";
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
  if (p.kind !== "queued" && p.kind !== "spawned" && p.kind !== "settled" && p.kind !== "rejected") return undefined;
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

  /**
   * M12: open a NEW visit for `name` (appended at the chain tail) without
   * touching the current-visit pointer. Ids are `name` (first visit) /
   * `name#n` (re-entry, n from 2). Callers responsible for "same name as the
   * current visit reuses it" must go through `enterPhase` instead.
   */
  function openVisit(entry: MutableEntry, name: string): number {
    collapseDoneVisits(entry);
    const ordinal = (entry.nameEntries.get(name) ?? 0) + 1;
    entry.nameEntries.set(name, ordinal);
    entry.visits.push({
      name,
      id: ordinal === 1 ? name : `${name}#${ordinal}`,
      spawned: 0,
      settled: 0,
      failed: 0,
      replayed: 0,
      enteredAt: now(),
    });
    return entry.visits.length - 1;
  }

  /** `phase(X)` semantics: X already the current visit → reuse it (no new visit); else open one and make it current. */
  function enterPhase(entry: MutableEntry, name: string): void {
    if (entry.currentVisitIdx >= 0 && entry.visits[entry.currentVisitIdx]!.name === name) return;
    entry.currentVisitIdx = openVisit(entry, name);
    entry.currentPhaseId = name;
  }

  /** Latest visit of `name`; opens one (not current — only a `phase` enter event moves the pointer) when never entered. */
  function latestVisitIdxOf(entry: MutableEntry, name: string): number {
    for (let i = entry.visits.length - 1; i >= 0; i -= 1) {
      if (entry.visits[i]!.name === name) return i;
    }
    return openVisit(entry, name);
  }

  /**
   * M12: keep entered visits bounded — before appending a visit that would
   * exceed `MAX_VISITS`, drop the OLDEST done visit (the current visit and
   * any draining one are never dropped). An all-draining pathological chain
   * may exceed the cap; the next settle or entry trims it again.
   */
  function collapseDoneVisits(entry: MutableEntry): void {
    while (entry.visits.length + 1 > MAX_VISITS) {
      const dropIdx = entry.visits.findIndex(
        (visit, i) => i !== entry.currentVisitIdx && visit.spawned <= visit.settled,
      );
      if (dropIdx < 0) return;
      entry.visits.splice(dropIdx, 1);
      entry.collapsedVisits += 1;
      if (dropIdx < entry.currentVisitIdx) entry.currentVisitIdx -= 1;
      // callVisits reindex: a done visit holds no pending call (unsettled
      // children keep it draining), so `=== dropIdx` entries are defensive
      // deletions; everything above shifts down one.
      for (const [callId, idx] of entry.callVisits) {
        if (idx === dropIdx) entry.callVisits.delete(callId);
        else if (idx > dropIdx) entry.callVisits.set(callId, idx - 1);
      }
    }
  }

  /** Entered visits in entry order, then planned-but-never-entered names in scan order. Frozen (terminal) snapshots show no active/draining chip. */
  function phasesOf(entry: MutableEntry, frozen: boolean): WorkflowPhaseActivity[] {
    const chips: WorkflowPhaseActivity[] = entry.visits.map((visit, idx) => {
      const state: WorkflowPhaseActivity["state"] =
        !frozen && idx === entry.currentVisitIdx
          ? "active"
          : !frozen && visit.spawned > visit.settled
            ? "draining"
            : "done";
      return {
        id: visit.id,
        ...(visit.id !== visit.name ? { name: visit.name } : {}),
        state,
        spawned: visit.spawned,
        settled: visit.settled,
        failed: visit.failed,
        replayed: visit.replayed,
      };
    });
    for (const planned of entry.plannedPhases) {
      if ((entry.nameEntries.get(planned) ?? 0) === 0) {
        chips.push({ id: planned, state: "pending", spawned: 0, settled: 0, failed: 0, replayed: 0 });
      }
    }
    return chips;
  }

  function snapshotOf(workflowId: WorkflowId, e: MutableEntry, frozen: boolean): WorkflowActivitySnapshot {
    return {
      workflowId,
      name: e.name,
      startedAt: e.startedAt,
      ...(e.deadlineAt !== undefined ? { deadlineAt: e.deadlineAt } : {}),
      // A frozen (terminal) snapshot is past any grace window.
      ...(e.graceUntil !== undefined && !frozen ? { graceUntil: e.graceUntil } : {}),
      ...(e.hardDeadlineAt !== undefined ? { hardDeadlineAt: e.hardDeadlineAt } : {}),
      ...(e.extensions > 0 ? { extensions: e.extensions } : {}),
      ...(e.currentPhaseId !== undefined ? { currentPhaseId: e.currentPhaseId } : {}),
      activeChildren: [...e.activeChildren.values()],
      settledChildren: [...e.settledChildren],
      settledTotal: e.settledTotal,
      completedTotal: e.completedTotal,
      replayTotal: e.replayTotal,
      queuedChildren: [...e.queuedChildren.values()],
      rejectedTotal: e.rejectedCallIds.size,
      stageErrorTotal: e.stageErrorTotal,
      phases: phasesOf(e, frozen),
      ...(e.collapsedVisits > 0 ? { collapsedVisits: e.collapsedVisits } : {}),
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
        extensions: 0,
        plannedPhases: plannedPhases === undefined ? [] : [...plannedPhases],
        visits: [],
        currentVisitIdx: -1,
        nameEntries: new Map(),
        callVisits: new Map(),
        collapsedVisits: 0,
        activeChildren: new Map(),
        queuedChildren: new Map(),
        rejectedCallIds: new Set(),
        stageErrorTotal: 0,
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
        if (entry) enterPhase(entry, phase.phaseId);
        return;
      }
      const moved = asDeadlineEvent(channel, payload);
      if (moved !== undefined) {
        const entry = entries.get(moved.workflowId);
        if (!entry) return;
        entry.deadlineAt = moved.deadlineAt;
        entry.hardDeadlineAt = moved.hardDeadlineAt;
        entry.extensions = Math.max(entry.extensions, moved.extensionsUsed);
        if (moved.kind === "grace" && moved.graceUntil !== undefined) entry.graceUntil = moved.graceUntil;
        else delete entry.graceUntil; // "extended" = back to normal execution
        return;
      }
      const stageError = asStageErrorEvent(channel, payload);
      if (stageError !== undefined) {
        const entry = entries.get(stageError.workflowId);
        if (entry) entry.stageErrorTotal += 1;
        return;
      }
      const child = asChildEvent(channel, payload);
      if (child === undefined) return;
      const entry = entries.get(child.workflowId);
      if (!entry) return;
      if (child.kind === "queued") {
        if (entry.settledCallIds.has(child.callId)) return; // defensive: never resurrect a settled call.
        entry.queuedChildren.set(child.callId, {
          callId: child.callId,
          ...(child.label !== undefined ? { label: child.label } : {}),
          ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
          ...(child.phaseId !== undefined ? { phaseId: child.phaseId } : {}),
          queuedAt: child.at,
        });
        return;
      }
      // Any later lifecycle event means the call is no longer waiting for a slot.
      entry.queuedChildren.delete(child.callId);
      if (child.kind === "rejected") {
        entry.rejectedCallIds.add(child.callId);
        return;
      }
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
          const idx = latestVisitIdxOf(entry, child.phaseId);
          entry.callVisits.set(child.callId, idx);
          entry.visits[idx]!.spawned += 1;
        }
        return;
      }
      // kind === "settled" — the visit comes from the spawn row we are about
      // to remove (callId lookup, never re-resolved by name so a late settle
      // from an earlier loop round cannot leak into the fresh visit);
      // without a spawn row (replay hits, withheld calls) the event's own
      // phaseId attributes to that name's LATEST visit.
      const recordedVisit = entry.callVisits.get(child.callId);
      entry.activeChildren.delete(child.callId);
      entry.callVisits.delete(child.callId);
      if (entry.settledCallIds.has(child.callId)) return; // defensive: count each call exactly once.
      entry.settledCallIds.add(child.callId);
      entry.settledTotal += 1;
      if (child.status === "completed") entry.completedTotal += 1;
      if (child.source === "replay") entry.replayTotal += 1;
      const visitIdx =
        recordedVisit ?? (child.phaseId !== undefined ? latestVisitIdxOf(entry, child.phaseId) : undefined);
      if (visitIdx !== undefined) {
        const visit = entry.visits[visitIdx]!;
        if (child.source === "replay") visit.replayed += 1;
        else visit.settled += 1;
        if (child.status !== "completed") visit.failed += 1;
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
