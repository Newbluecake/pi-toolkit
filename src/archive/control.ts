/**
 * ArchiveControl — the per-session owner of the archive state
 * (docs/dev/web-hub/archive-report.md). Built by `buildSessionStack` (gated on
 * `webHub.enabled`, the same lifecycle as the bash-jobs manager: a fresh
 * instance per session_start, previous one disposed at the top of the next
 * build AND on session_shutdown — a stale sweep MUST NOT appendEntry into the
 * NEW session's file), consumed by three surfaces:
 *
 *  - the web-hub status projection (`StatusInfo.archived`, agent/index.ts);
 *  - the `cmd` op `archive` (agent/commands.ts — manual archive/unarchive);
 *  - the TUI fleet widget's row filter (ui/fleet-widget.ts) and the web
 *    drawer's partition (both hide archived rows, display only — never
 *    get_subagent_result, /agent status, notifications or the runs themselves).
 *
 * Auto-archive (`webHub.archiveAfterMin`, default 30, 0 = off): a 60s unref'd
 * sweep over the terminal runs / terminal bash jobs supplied by the injected
 * candidate getters. Sweep-archived entries carry `auto: true`; anything the
 * user unarchived is `held` and never auto-archived again (state.ts).
 */
import {
  autoArchiveDue,
  archiveItem,
  emptyArchiveState,
  isArchived,
  readArchiveState,
  unarchiveItem,
  type ArchiveEntry,
  type ArchiveKind,
  type ArchiveState,
} from "./state.js";
import { isTerminalStatus } from "../core/status.js";
import { isTerminalJobStatus, type JobRecord } from "../bash/types.js";
import type { RunSnapshot } from "../core/types.js";

/** The widget's late-bound view: two id sets, re-read on every 1Hz tick. */
export interface FleetArchiveView {
  runs: ReadonlySet<string>;
  bash: ReadonlySet<string>;
}

export interface ArchiveCandidates {
  /** Live run snapshots (the stack's QueryService list). */
  runs(): readonly RunSnapshot[];
  /** Live in-memory bash job records (the stack's BashJobManager list). */
  bashJobs(): readonly JobRecord[];
}

export interface ArchiveControlDeps {
  appendEntry(customType: string, data: unknown): unknown;
  now(): number;
  /** Sweep period; also the resolution of "ended N minutes ago". */
  sweepMs?: number;
}

export type SetArchiveResult = { ok: true; changed: boolean } | { ok: false; reason: "not_found" | "not_terminal" };

const DEFAULT_SWEEP_MS = 60_000;

export class ArchiveControl {
  private state: ArchiveState = emptyArchiveState();
  private rev = 0;
  private readonly deps: ArchiveControlDeps;
  private readonly candidates: ArchiveCandidates;
  private timer: ReturnType<typeof setInterval> | undefined;
  private autoAfterMs = 0;
  private disposed = false;

  constructor(candidates: ArchiveCandidates, deps: ArchiveControlDeps) {
    this.candidates = candidates;
    this.deps = deps;
  }

  // -- lifecycle ----------------------------------------------------------

  /** Seed from the session branch (stack build / session_tree / session_compact). */
  restore(branch: readonly unknown[]): void {
    if (this.disposed) return;
    this.state = readArchiveState(branch);
    this.rev++;
  }

  /** Start the auto-archive sweep. `afterMs <= 0` disables it (timer never armed). */
  start(afterMs: number): void {
    if (this.disposed) return;
    this.autoAfterMs = Math.max(0, afterMs);
    if (this.autoAfterMs <= 0) return;
    const period = this.deps.sweepMs ?? DEFAULT_SWEEP_MS;
    this.timer = setInterval(() => this.sweep(), period);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.disposed = true;
  }

  // -- reads --------------------------------------------------------------

  view(): FleetArchiveView {
    const runs = new Set<string>();
    const bash = new Set<string>();
    for (const e of this.state.entries) (e.kind === "run" ? runs : bash).add(e.id);
    return { runs, bash };
  }

  /** Wire projection (`StatusInfo.archived`): entries snapshot + monotone rev.
   *  Empty ⇒ `undefined` so the status frame stays byte-equal (no archives). */
  wire(): { rev: number; entries: ArchiveEntry[] } | undefined {
    if (this.state.entries.length === 0) return undefined;
    return { rev: this.rev, entries: this.state.entries.slice() };
  }

  currentRev(): number {
    return this.rev;
  }

  // -- writes (web cmd op) --------------------------------------------------

  /**
   * Manual archive/unarchive from the web. Archiving requires the target to be
   * terminal (a running run/job is refused with `not_terminal`); an id that no
   * longer appears in the live lists is accepted (idempotent — the row is gone
   * from the UI anyway, and the entry may outlive the in-memory snapshot).
   */
  setArchived(kind: ArchiveKind, id: string, set: "archive" | "unarchive"): SetArchiveResult {
    if (this.disposed) return { ok: false, reason: "not_found" };
    if (set === "archive") {
      const term = this.terminalInstant(kind, id);
      // `undefined` ⇔ not in the live lists (evicted/foreign) — allow it.
      if (term === false) return { ok: false, reason: "not_terminal" };
      const next = archiveItem(this.state, { kind, id, auto: false, now: this.deps.now() });
      if (next === undefined) return { ok: true, changed: false };
      this.commit(next);
      return { ok: true, changed: true };
    }
    const next = unarchiveItem(this.state, { kind, id }, this.deps.now());
    if (next === undefined) return { ok: true, changed: false };
    this.commit(next);
    return { ok: true, changed: true };
  }

  // -- internals ------------------------------------------------------------

  private commit(next: ArchiveState): void {
    this.state = next;
    this.rev++;
    try {
      this.deps.appendEntry("subagent:archive", { entries: next.entries, held: next.held });
    } catch {
      // Persistence is best-effort: the in-memory state still serves this
      // session; the next change re-appends. Never take the caller down.
    }
  }

  /** `false` ⇔ live and non-terminal; `number` ⇔ terminal, settle instant; `undefined` ⇔ unknown id. */
  private terminalInstant(kind: ArchiveKind, id: string): number | false | undefined {
    if (kind === "run") {
      for (const snap of this.candidates.runs()) {
        if (snap.runId !== id) continue;
        if (!isTerminalStatus(snap.status)) return false;
        return snap.diag.settledAt ?? snap.updatedAt;
      }
      return undefined;
    }
    for (const record of this.candidates.bashJobs()) {
      if (record.jobId !== id) continue;
      if (!isTerminalJobStatus(record.status)) return false;
      return record.endedAt ?? record.createdAt;
    }
    return undefined;
  }

  /** One auto-archive pass. Batch-commits (one entry, one rev bump) — a sweep
   *  touching N rows must not write N session entries. */
  private sweep(): void {
    if (this.disposed || this.autoAfterMs <= 0) return;
    const now = this.deps.now();
    let next = this.state;
    let changed = false;
    for (const snap of this.candidates.runs()) {
      if (!isTerminalStatus(snap.status)) continue;
      const settled = snap.diag.settledAt ?? snap.updatedAt;
      if (!autoArchiveDue(next, { kind: "run", id: snap.runId }, settled, now, this.autoAfterMs)) continue;
      const after = archiveItem(next, { kind: "run", id: snap.runId, auto: true, now });
      if (after !== undefined) {
        next = after;
        changed = true;
      }
    }
    for (const record of this.candidates.bashJobs()) {
      if (!isTerminalJobStatus(record.status)) continue;
      const settled = record.endedAt ?? record.createdAt;
      if (!autoArchiveDue(next, { kind: "bash", id: record.jobId }, settled, now, this.autoAfterMs)) continue;
      const after = archiveItem(next, { kind: "bash", id: record.jobId, auto: true, now });
      if (after !== undefined) {
        next = after;
        changed = true;
      }
    }
    if (changed) this.commit(next);
  }
}
