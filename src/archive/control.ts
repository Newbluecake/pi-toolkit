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
 *    get_run_result, /agent status, notifications or the runs themselves).
 *
 * Auto-archive (`webHub.archiveAfterMin`, default 30, 0 = off): a 60s unref'd
 * sweep over the terminal runs / terminal bash jobs supplied by the injected
 * candidate getters. Sweep-archived entries carry `auto: true`; anything the
 * user unarchived is `held` and never auto-archived again (state.ts).
 */
import {
  ARCHIVE_ENTRIES_CAP,
  archiveItem,
  emptyArchiveState,
  isArchived,
  readArchiveState,
  sameArchiveState,
  unarchiveItem,
  type ArchiveEntry,
  type ArchiveKind,
  type ArchiveState,
} from "./state.js";
import { makeArchiveRoom, selectAutoArchives, type ArchiveCandidate } from "./sweep.js";
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
  /** The last snapshot that ACTUALLY hit the session file (append succeeded). A
   *  commit equal to it writes nothing (#89 A1 dedup guard — defense in depth on
   *  top of the cd57bdf9 convergence fix; tests/archive/write-rate.test.ts pins the
   *  write rate). Per-instance on purpose: a Symbol.for global would survive into a
   * /new or /resume pointing at a DIFFERENT session file and mis-baseline it.
   *  Alias-safe: ArchiveState values are immutable (mutations return fresh objects). */
  private lastPersisted: ArchiveState = emptyArchiveState();
  private rev = 0;
  private readonly deps: ArchiveControlDeps;
  private readonly candidates: ArchiveCandidates;
  private timer: ReturnType<typeof setInterval> | undefined;
  private autoAfterMs = 0;
  private keepRuns = 6;
  private keepBash = 5;
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
    // The read-back IS the last snapshot persisted on this branch — seed the dedup
    // baseline with it, so a freshly restored (/reload, fork) control writes nothing.
    this.lastPersisted = this.state;
    this.rev++;
  }

  /** Start the auto-archive sweep. `afterMs <= 0` disables it (timer never armed). */
  start(afterMs: number, keepRuns = 6, keepBash = 5): void {
    if (this.disposed) return;
    this.autoAfterMs = Math.max(0, afterMs);
    this.keepRuns = keepRuns;
    this.keepBash = keepBash;
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

  /**
   * Size one `archive_omitted`-style batch (ids NEWEST-first, the wire's order) so it SETTLES:
   * the batch archives `ids.slice(-N)` — the OLDEST ids of the tail — and the archive set
   * afterwards holds every id the batch touched (it did not churn the 256-entry FIFO window,
   * 2026-10-28 verify r2 P1). Evicting FOREIGN archives (ids not in `ids`) is fine and moves
   * the window forward; what must not happen is evicting an id that is already in `ids` — it
   * would bounce back into `omitted` on the next projection, and the click would never
   * converge. The answer is `cap - alreadyArchivedOutsideIds`; it can be 0, in which case the
   * caller must still archive SOMETHING (see `archiveBatch`) rather than spin.
   */
  archiveRoomFor(kind: ArchiveKind, ids: readonly string[]): number {
    const inIds = new Set(ids);
    const outside = this.state.entries.filter((e) => e.kind === kind && !inIds.has(e.id)).length;
    return Math.max(0, ARCHIVE_ENTRIES_CAP - outside);
  }

  /**
   * The batch itself: `ids.slice(-N)` with N from `archiveRoomFor`, but at least one id (the
   * very oldest) even when the room is 0 — archiving one old id evicts exactly one older
   * archive and the tail strictly shrinks, so the click still converges one row at a time
   * instead of reporting `changed: 0` forever (the 256-cap steady state).
   */
  archiveBatch(kind: ArchiveKind, ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    const room = this.archiveRoomFor(kind, ids);
    return ids.slice(-Math.max(1, room));
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

  /**
   * 2026-10-28 (fleet bash 「(+N more)」 either shows or archives): archive MANY in ONE commit.
   * Same discipline as the auto sweep — N rows archived in one pass must not write N session
   * entries (each `commit` is one `appendEntry` + one rev bump), so this folds `archiveItem`
   * over the ids and commits exactly once.
   *
   * Counted semantics: `changed` = ids that went from NOT-archived to archived. An id that is
   * live-and-non-terminal is skipped defensively (`terminalInstant` `false`); an id that is
   * ALREADY archived — including a sweep-archived (`auto: true`) one being re-marked manual — is
   * NOT counted: from the caller's point of view nothing became hidden, so a caller that reports
   * `changed: 0` truthfully says "nothing to archive". 0 also means no entry was written at all.
   *
   * Cap overflow rides `archiveItem`'s own FIFO tail (`ARCHIVE_ENTRIES_CAP`): the oldest archive
   * entries are evicted, so a batch larger than the cap keeps its NEWEST rows — the same
   * semantics a per-id loop would have produced, just with one write. Batch callers should size
   * their batch to `archiveRoom(kind)` first so their batch converges instead of churning the
   * window (2026-10-28 verifier: the wire orders the ids NEWEST-first, which evicts the newest).
   *
   * Archive only (no `unarchive` arm): the only production caller is the `archive_omitted` op, and
   * un-archiving a batch has no such caller — a single row un-archives through `setArchived`, which
   * is the surface the drawer's undo/un-archive button uses. Keeping a second, untested write path
   * for an operation nobody performs was the cheaper thing to delete than to pin with tests.
   */
  setArchivedMany(kind: ArchiveKind, ids: readonly string[]): number {
    if (this.disposed) return 0;
    const now = this.deps.now();
    let next = this.state;
    let changed = 0;
    for (const id of ids) {
      if (this.terminalInstant(kind, id) === false) continue;
      const already = isArchived(next, { kind, id });
      const after = archiveItem(next, { kind, id, auto: false, now });
      if (after === undefined) continue;
      next = after;
      if (!already) changed += 1;
    }
    // An auto→manual re-mark changes the state (the badge drops) even though `changed` stays 0 —
    // commit it, or the entry would silently diverge from what the session file records.
    if (next !== this.state) this.commit(next);
    return changed;
  }

  // -- internals ------------------------------------------------------------

  private commit(next: ArchiveState): void {
    if (!sameArchiveState(next, this.state)) {
      this.state = next;
      this.rev++;
    }
    if (sameArchiveState(next, this.lastPersisted)) return; // the file already holds this exact content
    try {
      this.deps.appendEntry("subagent:archive", { entries: next.entries, held: next.held });
      this.lastPersisted = next; // advance ONLY on success: a failed append leaves the baseline behind,
      // so the next real change re-appends the full state — nothing is silently lost.
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
    const candidates: ArchiveCandidate[] = [
      ...this.candidates.runs().map((snap) => ({
        kind: "run" as const,
        id: snap.runId,
        terminal: isTerminalStatus(snap.status),
        settledAt: snap.diag.settledAt ?? snap.updatedAt,
      })),
      ...this.candidates.bashJobs().map((record) => ({
        kind: "bash" as const,
        id: record.jobId,
        terminal: isTerminalJobStatus(record.status),
        settledAt: record.endedAt ?? record.createdAt,
      })),
    ];
    const selected = selectAutoArchives(this.state, candidates, now, {
      afterMs: this.autoAfterMs,
      keepRuns: this.keepRuns,
      keepBash: this.keepBash,
    });
    if (selected.length === 0) return;
    // Evict gone entries (not live ones) so the state's FIFO cap never bites during a sweep.
    const base = makeArchiveRoom(this.state, candidates, selected.length);
    let next = base;
    let changed = base !== this.state;
    for (const item of selected) {
      const after = archiveItem(next, { kind: item.kind, id: item.id, auto: true, now });
      if (after !== undefined) {
        next = after;
        changed = true;
      }
    }
    if (changed) this.commit(next);
  }
}
