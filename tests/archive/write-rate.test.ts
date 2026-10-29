/**
 * Archive WRITE-RATE invariants (#89 A2) — the regression gate for the two historical
 * runaway-write bugs, driven through a simulated 24 h sweep sequence (1,440 sweeps):
 *
 *  - phase 1 (998dce27): the per-item sweep loop re-archived the same 256 ids every
 *    minute ⇒ snapshots whose id set NEVER changed, only `at` ("at 全换" — 4,790 of
 *    5,524 adjacent pairs in the 193 MB session file);
 *  - phase 2 (43d892fd): selection exceeded the 256-entry cap ⇒ the archived id set
 *    flipped between two disjoint groups A/B/A every minute (659 pairs).
 *
 * Both were fixed by the convergence rework (cd57bdf9: room-capped selection +
 * makeArchiveRoom — itself superseded by the #91 horizon model) and are additionally
 * covered by the A1 dedup guard (sameArchiveState
 * vs ArchiveControl.lastPersisted). This suite pins the WRITE RATE itself, so any
 * reappearance of either form goes red. The counterfactual block at the bottom replays
 * BOTH pre-fix sweep loops (inlined from git history, seed-deterministic) against the
 * same candidate streams and asserts this suite's checker DOES flag them — proving the
 * gate has teeth rather than passing vacuously. A third counterfactual (CF3) inlines
 * the cd57bdf9 sweep itself and shows it stalls on the #91 forensic fleet.
 *
 * Timer arming itself is covered by tests/archive/control.test.ts; here fake timers
 * just drive the sweep cadence (60 s of wall time per sweep, `now` advancing with it,
 * exactly like the incident sessions where every rewrite carried the sweep instant).
 */
import { describe, expect, it, vi } from "vitest";
import { ArchiveControl } from "../../src/archive/control.js";
import {
  ARCHIVE_ENTRIES_CAP,
  ARCHIVE_ENTRY_TYPE,
  archiveItem,
  autoArchiveDue,
  emptyArchiveState,
  isArchived,
  readArchiveState,
  sameArchiveState,
  type ArchiveState,
} from "../../src/archive/state.js";
import { selectAutoArchives, type ArchiveCandidate } from "../../src/archive/sweep.js";
import type { JobRecord } from "../../src/bash/types.js";
import type { RunSnapshot } from "../../src/core/types.js";

const SWEEP_MS = 1_000; // fake-timer period; `now` advances 60_000 per sweep (real cadence)
const AFTER_MS = 60_000;
const RUNS = 700;
const BASH = 40;
const SWEEPS = 1_440; // 24 h at one sweep per minute

// -- fixtures ---------------------------------------------------------------

function runSnap(runId: string, updatedAt: number): RunSnapshot {
  return {
    runId,
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: {},
    diag: { createdAt: 0, phase: "settled", phaseEnteredAt: 0, escalation: [] },
    updatedAt,
  } as unknown as RunSnapshot;
}

const baseJob: JobRecord = {
  v: 1,
  jobId: "b_JOB0001",
  command: "echo hi",
  cwd: "/tmp",
  sessionId: "s",
  hostPid: 1,
  status: "running",
  createdAt: 0,
  spawnedAt: 0,
  backgroundedAt: 1,
  exitCode: null,
  logPath: "/tmp/x.log",
  logBytes: 0,
  outputTruncated: false,
  readCursor: 0,
};

function job(jobId: string, endedAt: number): JobRecord {
  return { ...baseJob, jobId, status: "completed", endedAt } as JobRecord;
}

/** Deterministic LCG (seed named in the describe title) — reproducible failures. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

function makeControl(runs: RunSnapshot[], jobs: JobRecord[], failFirstAppend = false) {
  let now = 10_000_000; // everything settled 0..~15k is long past AFTER_MS
  const appended: Array<{ type: string; data: ArchiveState }> = [];
  let appendBroken = failFirstAppend;
  const control = new ArchiveControl(
    { runs: () => runs, bashJobs: () => jobs },
    {
      appendEntry: (type, data) => {
        if (appendBroken) {
          appendBroken = false;
          throw new Error("simulated disk failure");
        }
        appended.push({ type, data: data as ArchiveState });
      },
      now: () => now,
      sweepMs: SWEEP_MS,
    },
  );
  return {
    control,
    appended,
    tick: () => {
      now += 60_000;
    },
  };
}

/** Drive the armed sweep `n` times; `before` runs ahead of each sweep (candidate churn). */
function drive(control: ArchiveControl, n: number, tick: () => void, before?: (i: number) => void): void {
  for (let i = 1; i <= n; i++) {
    tick();
    before?.(i);
    vi.advanceTimersByTime(SWEEP_MS);
  }
}

// -- the invariant checker (shared by the green scenarios and the counterfactuals) --

type WriteRateViolation = { i: number; kind: "identical" | "at-only" | "aba" };

/** `kind\0id\0auto` of entries + full holds, both sorted — everything but entries' `at`
 *  and the horizon. #91: the horizon IS semantic state (a horizon-only write is a
 *  real, bounded write — the post-upgrade first sweep — and must not be mistaken
 *  for an at-only rewrite). */
function semanticKey(s: ArchiveState): string {
  const entries = s.entries.map((e) => `${e.kind}\u0000${e.id}\u0000${e.auto === true}`).sort();
  const held = s.held.map((h) => `${h.kind}\u0000${h.id}\u0000${h.at}`).sort();
  return JSON.stringify([entries, held, s.horizon?.run ?? null, s.horizon?.bash ?? null]);
}

function idSetKey(s: ArchiveState): string {
  return JSON.stringify(s.entries.map((e) => `${e.kind}\u0000${e.id}`).sort());
}

/**
 * The write-rate invariants over a stream of persisted snapshots:
 *  - "identical": two adjacent snapshots are literally equal — the A1 dedup guard
 *    (sameArchiveState vs lastPersisted) must have suppressed the second write.
 *  - "at-only": adjacent snapshots whose ids/auto/held all match — only entries' `at`
 *    moved. The 998dce27 form; outlawed because the honest fix is convergence, and
 *    silently deduping it would hide the bug behind a growing at drift.
 *  - "aba": snapshots i-2 and i hold the SAME id set while i-1 differs — the 43d892fd
 *    A/B flip form.
 */
function checkWriteRateInvariants(appended: readonly ArchiveState[]): WriteRateViolation[] {
  const violations: WriteRateViolation[] = [];
  for (let i = 1; i < appended.length; i++) {
    const a = appended[i - 1]!;
    const b = appended[i]!;
    if (sameArchiveState(a, b)) violations.push({ i, kind: "identical" });
    else if (semanticKey(a) === semanticKey(b)) violations.push({ i, kind: "at-only" });
  }
  for (let i = 2; i < appended.length; i++) {
    const s0 = idSetKey(appended[i - 2]!);
    if (s0 === idSetKey(appended[i]!) && s0 !== idSetKey(appended[i - 1]!)) violations.push({ i, kind: "aba" });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

describe("archive write-rate invariants (#89 A2, LCG seed 0x5eed89)", () => {
  it("S1 stable large fleet: 1,440 sweeps (24 h) write at most once, and never churn ids", () => {
    vi.useFakeTimers();
    try {
      const runs = Array.from({ length: RUNS }, (_, i) => runSnap(`r-${i}`, i));
      const jobs = Array.from({ length: BASH }, (_, i) => job(`b-${i}`, 500 + i));
      const h = makeControl(runs, jobs);
      h.control.start(AFTER_MS, 6, 5);
      drive(h.control, SWEEPS, h.tick);
      h.control.dispose();
      // Bounded writes: the first sweep fills the 256 cap (one batch commit); a stable
      // fleet must then converge to ZERO further writes — not one 16.5 KB entry per minute.
      expect(h.appended).toHaveLength(1);
      expect(h.appended[0]!.type).toBe(ARCHIVE_ENTRY_TYPE);
      // #91: the initial fill evicted the 473 oldest-settled of the 729 selected items —
      // the first (and only) snapshot now carries the horizon (review #4's mirror image).
      expect((h.appended[0]!.data as ArchiveState).horizon).toEqual({ run: 472 });
      expect(checkWriteRateInvariants(h.appended.map((a) => a.data))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("S2 rolling recycle (every 10 sweeps one arrival + one departure): writes ≤ arrivals + 1, no at-only rewrites, no A/B/A flips", () => {
    vi.useFakeTimers();
    try {
      const rng = lcg(0x5eed89);
      const runs = Array.from({ length: RUNS }, (_, i) => runSnap(`r-${i}`, i));
      const h = makeControl(runs, []);
      let arrivals = 0;
      h.control.start(AFTER_MS, 6, 5);
      drive(h.control, SWEEPS, h.tick, (i) => {
        if (i % 10 !== 0) return;
        arrivals += 1;
        // One archived-and-still-live run leaves the registry (a visible row recycles);
        // jitter the pick among the oldest few so the departure order is not fixed.
        const archived = h.control.view().runs;
        const archivedLive = runs
          .map((snap, idx) => ({ snap, idx }))
          .filter(({ snap }) => archived.has(snap.runId))
          .sort((a, b) => a.snap.updatedAt - b.snap.updatedAt);
        const pick = archivedLive[Math.floor(rng() * Math.min(3, archivedLive.length))] ?? archivedLive[0];
        runs.splice(pick!.idx, 1);
        // One fresh terminal run arrives, settled long ago (immediately due) but NEWER
        // than every old row so the room clamp prefers it.
        runs.push(runSnap(`n-${arrivals}`, 10_000 + Math.floor(rng() * 5_000) + arrivals));
      });
      h.control.dispose();
      // Bounded by the number of real changes (+ the initial fill): 143 arrivals here.
      expect(arrivals).toBeGreaterThan(0);
      expect(h.appended.length).toBeLessThanOrEqual(arrivals + 1);
      expect(h.appended.length).toBeGreaterThanOrEqual(2); // the scenario is not vacuous
      const violations = checkWriteRateInvariants(h.appended.map((a) => a.data));
      expect(violations).toEqual([]); // no at-only rewrites, no A/B/A flips, no identical pairs
    } finally {
      vi.useRealTimers();
    }
  });

  it("S3 restore equivalence: the branch read-back equals memory, and a freshly restored control writes NOTHING", () => {
    vi.useFakeTimers();
    try {
      // Reuse the S2 shape: a stream with real writes, ending in a mixed archive state.
      const rng = lcg(0x5eed89);
      const runs = Array.from({ length: RUNS }, (_, i) => runSnap(`r-${i}`, i));
      const h = makeControl(runs, []);
      h.control.start(AFTER_MS, 6, 5);
      let arrivals = 0;
      drive(h.control, 300, h.tick, (i) => {
        if (i % 10 !== 0) return;
        arrivals += 1;
        const archived = h.control.view().runs;
        const archivedLive = runs
          .map((snap, idx) => ({ snap, idx }))
          .filter(({ snap }) => archived.has(snap.runId))
          .sort((a, b) => a.snap.updatedAt - b.snap.updatedAt);
        const pick = archivedLive[Math.floor(rng() * Math.min(3, archivedLive.length))] ?? archivedLive[0];
        runs.splice(pick!.idx, 1);
        runs.push(runSnap(`n-${arrivals}`, 10_000 + Math.floor(rng() * 5_000) + arrivals));
      });
      h.control.dispose();
      expect(h.appended.length).toBeGreaterThanOrEqual(2);

      // The session file (what /reload, session_tree and forks see) is the appended stream.
      const branch = h.appended.map((a) => ({ type: "custom", customType: ARCHIVE_ENTRY_TYPE, data: a.data }));
      const readback = readArchiveState(branch);
      expect(readback).toEqual(h.appended[h.appended.length - 1]!.data); // last-write-wins round-trip
      expect(readback.entries).toEqual(h.control.wire()?.entries); // disk == in-memory state

      // A FRESH control restored from that branch, swept over the same live fleet:
      // zero writes. The lastPersisted baseline is seeded by restore(), so reload /
      // fork / tree-switch never replay history as new snapshots.
      const h2 = makeControl(runs, []);
      h2.control.restore(branch);
      h2.control.start(AFTER_MS, 6, 5);
      drive(h2.control, 60, h2.tick);
      h2.control.dispose();
      expect(h2.appended).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("S4 a failed append advances nothing: no write on the following no-op, and the missed change rides the next real write", () => {
    const runs = [runSnap("r-x", 1), runSnap("r-y", 2)];
    const h = makeControl(runs, [], true); // the FIRST appendEntry throws
    // Real change X: the append fails (swallowed, best-effort) — memory serves the session…
    expect(h.control.setArchived("run", "r-x", "archive")).toEqual({ ok: true, changed: true });
    expect(h.appended).toHaveLength(0);
    expect(h.control.wire()?.entries.map((e) => e.id)).toEqual(["r-x"]);
    // …but the persisted baseline did NOT advance, so a no-op must not retry (no write)…
    expect(h.control.setArchived("run", "r-x", "archive")).toEqual({ ok: true, changed: false });
    expect(h.appended).toHaveLength(0);
    // …while the next REAL change re-appends the full state: Y and the missed X, together.
    expect(h.control.setArchived("run", "r-y", "archive")).toEqual({ ok: true, changed: true });
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.data.entries.map((e) => e.id)).toEqual(["r-x", "r-y"]);
  });

  // -------------------------------------------------------------------------
  // #91 cap-full progression scenarios (plan §6.2 S5–S7). Shared fixture: the
  // forensic fleet shape — a candidate list that NEVER shrinks (the run registry
  // reseeds every terminal run from the session log) fed by a slow arrival stream.
  // -------------------------------------------------------------------------

  /** One S5-style arrival: settled far below `now` (past the age gate — `now` starts
   *  at 10_000_000 and grows 60_000/sweep while arrivals live at ~10_000+) and strictly
   *  NEWER than every pre-existing candidate (≤ 699) and than the horizon can ever be
   *  (the horizon only reaches a PREVIOUS arrival's settledAt; arrivals are monotone)
   *  — review #1's fixture constraint, so a green ① can only come from real progression. */
  const arrivalSnap = (n: number): RunSnapshot => runSnap(`n-${n}`, 10_000 + n);

  /** Drive the arrival flow for `sweeps` sweeps (one arrival every 3), probing after
   *  EVERY sweep: the stall detector (①), the horizon sequence (⑤) and every eviction
   *  event (④). Caller owns the fake timers and disposes the control. */
  function driveArrivalFlow(runs: RunSnapshot[], sweeps: number, h: ReturnType<typeof makeControl>) {
    let arrivals = 0;
    const detector: number[] = [];
    const horizons: number[] = [];
    const evictions: Array<{ at: number; id: string }> = [];
    const idSets: Array<Set<string>> = [];
    for (let i = 1; i <= sweeps; i++) {
      h.tick();
      if (i % 3 === 0) {
        arrivals += 1;
        runs.push(arrivalSnap(arrivals));
      }
      vi.advanceTimersByTime(SWEEP_MS);
      const last = h.appended[h.appended.length - 1]?.data;
      const horizon = last?.horizon?.run ?? -Infinity;
      const archived = h.control.view().runs;
      const seen = new Set<string>();
      let over = 0;
      for (const snap of runs) {
        if (seen.has(snap.runId)) continue;
        seen.add(snap.runId);
        if (snap.status !== "completed") continue;
        if (archived.has(snap.runId)) continue;
        if ((snap.diag.settledAt ?? snap.updatedAt) > horizon) over += 1;
      }
      detector.push(over);
      if (last !== undefined) {
        horizons.push(last.horizon?.run ?? -Infinity);
        const ids = new Set(last.entries.filter((e) => e.kind === "run").map((e) => e.id));
        if (idSets.length > 0)
          for (const id of idSets[idSets.length - 1]!) if (!ids.has(id)) evictions.push({ at: idSets.length, id });
        idSets.push(ids);
      }
    }
    return { arrivals, detector, horizons, evictions, idSets };
  }

  it("S5 never-shrinking fleet + arrivals: progression never stalls, evicted ids never return, horizon monotone", () => {
    vi.useFakeTimers();
    try {
      const runs = Array.from({ length: RUNS }, (_, i) => runSnap(`r-${i}`, i));
      const h = makeControl(runs, []);
      h.control.start(AFTER_MS, 6, 5);
      const { arrivals, detector, horizons, evictions, idSets } = driveArrivalFlow(runs, SWEEPS * 3, h);
      h.control.dispose();
      expect(arrivals).toBe(1_440); // the scenario is not vacuous
      // ① the stall detector: after EVERY sweep, unarchived non-held terminal runs
      // settled above the horizon stay within the keep count — the pre-#91 sweep left
      // this monotonically growing past keepRuns (CF3 proves the detector has teeth).
      // (Plain loops + one assertion each: 4k+ vitest `expect` calls dominate runtime.)
      expect(Math.max(...detector)).toBeLessThanOrEqual(6);
      // ② bounded writes: the initial fill + one per arrival + at most one horizon-only.
      expect(h.appended.length).toBeLessThanOrEqual(arrivals + 2);
      expect(h.appended.length).toBeGreaterThanOrEqual(arrivals); // …and really progressed
      // ③ no identical / at-only / A/B/A pairs.
      expect(checkWriteRateInvariants(h.appended.map((a) => a.data))).toEqual([]);
      // ④ evicted ids NEVER return to any later snapshot.
      const returns = evictions.filter((ev) => idSets.slice(ev.at).some((s) => s.has(ev.id)));
      expect(returns).toEqual([]);
      expect(evictions.length).toBeGreaterThan(0); // ④ is not vacuous
      // ⑤ the horizon sequence is monotone non-decreasing.
      const drops: Array<[number, number, number]> = [];
      for (let i = 1; i < horizons.length; i++)
        if (horizons[i]! < horizons[i - 1]!) drops.push([i, horizons[i - 1]!, horizons[i]!]);
      expect(drops).toEqual([]);
      // The explicit set stays capped, and the fill really evicted live entries.
      expect(h.control.wire()?.entries).toHaveLength(256);
      expect(horizons[horizons.length - 1]).toBeGreaterThan(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("S6 restart equivalence: a mid-flow branch restores 1:1 (horizon included) and a fresh control writes NOTHING", () => {
    vi.useFakeTimers();
    try {
      const runs = Array.from({ length: RUNS }, (_, i) => runSnap(`r-${i}`, i));
      const h = makeControl(runs, []);
      h.control.start(AFTER_MS, 6, 5);
      driveArrivalFlow(runs, 900, h); // 300 arrivals → a real mixed state WITH a horizon
      h.control.dispose();
      expect(h.appended.length).toBeGreaterThanOrEqual(2);
      const branch = h.appended.map((a) => ({ type: "custom", customType: ARCHIVE_ENTRY_TYPE, data: a.data }));
      const readback = readArchiveState(branch);
      const last = h.appended[h.appended.length - 1]!.data;
      expect(readback.entries).toEqual(last.entries); // disk == memory, entries …
      expect(readback.horizon).toEqual(last.horizon); // …and horizon alike
      expect(readback.horizon?.run).toBeGreaterThan(400); // a REAL horizon, not -∞
      const h2 = makeControl(runs, []);
      h2.control.restore(branch);
      h2.control.start(AFTER_MS, 6, 5);
      for (let i = 0; i < 60; i++) {
        h2.tick();
        vi.advanceTimersByTime(SWEEP_MS);
      }
      h2.control.dispose();
      expect(h2.appended).toHaveLength(0); // the restored baseline holds: zero replay
    } finally {
      vi.useRealTimers();
    }
  });

  it("S7 upgrade first sweep: a legacy full-cap snapshot (no horizon) settles in EXACTLY one horizon-only write, then goes quiet", () => {
    vi.useFakeTimers();
    try {
      // The forensic scene: 741 runs, the newest 256 auto-archived, no horizon field.
      const runs = Array.from({ length: 741 }, (_, i) => runSnap(`r-${i}`, i));
      const h = makeControl(runs, []);
      h.control.restore([
        {
          type: "custom",
          customType: ARCHIVE_ENTRY_TYPE,
          data: {
            entries: Array.from({ length: 256 }, (_, i) => ({
              kind: "run",
              id: `r-${485 + i}`,
              at: 1,
              auto: true,
            })),
            held: [],
          },
        },
      ]);
      h.control.start(AFTER_MS, 6, 5);
      vi.advanceTimersByTime(SWEEP_MS);
      // First sweep: the 479 selected all-older-than-the-window items lose the trim
      // contest — entries UNCHANGED, horizon folded in, exactly ONE write.
      expect(h.appended).toHaveLength(1);
      const data = h.appended[0]!.data;
      expect(data.horizon).toEqual({ run: 478 });
      expect(data.entries.map((e) => e.id)).toEqual(Array.from({ length: 256 }, (_, i) => `r-${485 + i}`));
      expect(checkWriteRateInvariants(h.appended.map((a) => a.data))).toEqual([]);
      // Then quiet: the 6 keep-window runs sit exactly at the count gate.
      for (let i = 0; i < 60; i++) vi.advanceTimersByTime(SWEEP_MS);
      expect(h.appended).toHaveLength(1);
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// counterfactuals: both pre-fix sweep loops, inlined from git history
// ---------------------------------------------------------------------------

/**
 * The 998dce27 sweep (verbatim semantics of `git show 998dce27:src/archive/control.ts`
 * sweep(): per-item loop over runs-then-bash, no keep counts, no room handling; it had
 * separate run/bash loops, folded here into one kind-tagged pass). Reuses the CURRENT
 * state.ts pure functions — legitimate because state.ts is byte-identical since
 * 998dce27 (`git diff 998dce27 43d892fd -- src/archive/state.ts` and
 * `git diff cd57bdf9 HEAD -- src/archive/state.ts` are both empty).
 *
 * Bug form: with more due candidates than the 256 cap, capTail evicts within the same
 * round, every candidate is "not archived" again when its turn comes, and the loop
 * re-archives the SAME final 256 ids each sweep with a fresh `at` — the "at 全换" writes.
 */
function legacySweepAtRewrite(
  state: ArchiveState,
  candidates: readonly ArchiveCandidate[],
  now: number,
): ArchiveState | undefined {
  let next = state;
  let changed = false;
  for (const item of candidates) {
    if (!item.terminal) continue;
    if (!autoArchiveDue(next, item, item.settledAt, now, AFTER_MS)) continue;
    const after = archiveItem(next, { kind: item.kind, id: item.id, auto: true, now });
    if (after !== undefined) {
      next = after;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

/**
 * The 43d892fd sweep: `git show 43d892fd:src/archive/sweep.ts` selectAutoArchives —
 * identical to today's EXCEPT it had no `archiveRoom` clamp (that clamp + makeArchiveRoom
 * ARE the cd57bdf9 fix), so it returned ALL excess; the control loop then archived every
 * selected item and capTail kept the newest-inserted 256. With 700 due runs the surviving
 * id set alternates between {r-438..r-693} and {r-182..r-437} — the A/B flip writes.
 */
function legacySelectNoRoom(
  state: ArchiveState,
  candidates: readonly ArchiveCandidate[],
  now: number,
  keepRuns: number,
  keepBash: number,
): ArchiveCandidate[] {
  const selected: ArchiveCandidate[] = [];
  for (const kind of ["run", "bash"] as const) {
    const seen = new Set<string>();
    const remaining = candidates.filter((item) => {
      if (item.kind !== kind || !item.terminal || isArchived(state, item) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    const keep = kind === "run" ? keepRuns : keepBash;
    const excess = keep === 0 ? remaining.length : Math.max(0, remaining.length - keep);
    selected.push(
      ...remaining
        .filter((item) => autoArchiveDue(state, item, item.settledAt, now, AFTER_MS))
        .sort((a, b) => a.settledAt - b.settledAt)
        .slice(0, excess),
    );
  }
  return selected;
}

function legacySweepIdFlip(
  state: ArchiveState,
  candidates: readonly ArchiveCandidate[],
  now: number,
): ArchiveState | undefined {
  let next = state;
  let changed = false;
  for (const item of legacySelectNoRoom(state, candidates, now, 6, 5)) {
    const after = archiveItem(next, { kind: item.kind, id: item.id, auto: true, now });
    if (after !== undefined) {
      next = after;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

/** Run a legacy sweep loop over the S1 fleet, `now` advancing per sweep like the incident. */
function runLegacySweep(
  sweep: (state: ArchiveState, candidates: readonly ArchiveCandidate[], now: number) => ArchiveState | undefined,
  candidates: readonly ArchiveCandidate[],
  sweeps: number,
): ArchiveState[] {
  let state = emptyArchiveState();
  const appended: ArchiveState[] = [];
  let now = 10_000_000;
  for (let i = 0; i < sweeps; i++) {
    now += 60_000;
    const next = sweep(state, candidates, now);
    if (next !== undefined) {
      state = next;
      appended.push({ entries: state.entries.map((e) => ({ ...e })), held: [] });
    }
  }
  return appended;
}

describe("archive write-rate counterfactuals: the gate goes red against both historical bugs", () => {
  // The S1 candidate stream as ArchiveCandidates (control.sweep's own mapping).
  const candidates: ArchiveCandidate[] = [
    ...Array.from({ length: RUNS }, (_, i) => ({ kind: "run" as const, id: `r-${i}`, terminal: true, settledAt: i })),
    ...Array.from({ length: BASH }, (_, i) => ({
      kind: "bash" as const,
      id: `b-${i}`,
      terminal: true,
      settledAt: 500 + i,
    })),
  ];

  it("the 998dce27 loop writes EVERY sweep with unchanged ids (at-only) — S1's bound and the checker both flag it", () => {
    const appended = runLegacySweep(legacySweepAtRewrite, candidates, 30);
    expect(appended).toHaveLength(30); // 30 writes in 30 sweeps — S1 asserts ≤1 over 1,440
    const violations = checkWriteRateInvariants(appended);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.kind === "at-only")).toBe(true); // the "at 全换" form
    // Sanity: the ids really never moved — this is what the at-only rule is aimed at.
    const first = new Set(appended[0]!.entries.map((e) => e.id));
    expect(new Set(appended[29]!.entries.map((e) => e.id))).toEqual(first);
    expect(appended[29]!.entries.some((e) => e.at !== appended[0]!.entries[0]!.at)).toBe(true);
  });

  it("the 43d892fd loop flips the archived id set A/B/A every sweep — the checker's aba rule flags it", () => {
    const appended = runLegacySweep(legacySweepIdFlip, candidates, 30);
    expect(appended).toHaveLength(30); // again: every sweep wrote
    const violations = checkWriteRateInvariants(appended);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.kind === "aba")).toBe(true); // the id-flip form
    // Sanity: adjacent snapshots really do swap the whole 256-id set.
    const diff = (a: ArchiveState, b: ArchiveState) => {
      const sa = new Set(a.entries.map((e) => e.id));
      return b.entries.filter((e) => !sa.has(e.id)).length;
    };
    expect(diff(appended[0]!, appended[1]!)).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------
// CF3 (#91): the cd57bdf9 sweep — the very code this change replaced, inlined —
// stalls on a never-shrinking fleet. Proves S5's ① detector is not vacuous: the
// same arrival stream that the new sweep keeps within keepRuns drives the old one
// monotonically past it, and the old selectAutoArchives (room-clamped) returns []
// exactly where the new one keeps selecting.
// ---------------------------------------------------------------------------

describe("archive write-rate counterfactual CF3: the cd57bdf9 room clamp stalls (#91)", () => {
  /** HEAD's selectAutoArchives at the time #91 landed, verbatim semantics: the count
   *  gates above are today's; the tail is the deleted `archiveRoom` truncation. */
  function cfRoomSelect(
    state: ArchiveState,
    candidates: readonly ArchiveCandidate[],
    now: number,
    afterMs: number,
    keepRuns: number,
    keepBash: number,
  ): ArchiveCandidate[] {
    const live = new Set(candidates.map((c) => `${c.kind}\u0000${c.id}`));
    const gone = state.entries.filter((e) => !live.has(`${e.kind}\u0000${e.id}`));
    const room = Math.max(0, ARCHIVE_ENTRIES_CAP - state.entries.length) + gone.length;
    const selected: ArchiveCandidate[] = [];
    for (const kind of ["run", "bash"] as const) {
      const seen = new Set<string>();
      const remaining = candidates.filter((item) => {
        if (item.kind !== kind || !item.terminal || isArchived(state, item) || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
      const keep = kind === "run" ? keepRuns : keepBash;
      const excess = keep === 0 ? remaining.length : Math.max(0, remaining.length - keep);
      selected.push(
        ...remaining
          .filter((item) => autoArchiveDue(state, item, item.settledAt, now, afterMs))
          .sort((a, b) => a.settledAt - b.settledAt)
          .slice(0, excess),
      );
    }
    if (selected.length <= room) return selected;
    const keep = new Set(
      selected
        .slice()
        .sort((a, b) => b.settledAt - a.settledAt)
        .slice(0, room),
    );
    return selected.filter((item) => keep.has(item));
  }

  /** HEAD's control.sweep: select (room-clamped) → makeArchiveRoom → fold with the
   *  archiveItem FIFO cap. States carry no horizon, so today's autoArchiveDue behaves
   *  exactly like the historical one for this loop. */
  function cfStallSweep(
    state: ArchiveState,
    candidates: readonly ArchiveCandidate[],
    now: number,
  ): ArchiveState | undefined {
    const selected = cfRoomSelect(state, candidates, now, AFTER_MS, 6, 5);
    if (selected.length === 0) return undefined;
    const live = new Set(candidates.map((c) => `${c.kind}\u0000${c.id}`));
    const needed = state.entries.length + selected.length - ARCHIVE_ENTRIES_CAP;
    let base = state;
    if (needed > 0) {
      const drop = state.entries.filter((e) => !live.has(`${e.kind}\u0000${e.id}`)).slice(0, needed);
      if (drop.length > 0)
        base = {
          entries: state.entries.filter((e) => !drop.some((d) => d.kind === e.kind && d.id === e.id)),
          held: [],
        };
    }
    let next = base;
    let changed = base !== state;
    for (const item of selected) {
      const after = archiveItem(next, { kind: item.kind, id: item.id, auto: true, now });
      if (after !== undefined) {
        next = after;
        changed = true;
      }
    }
    return changed ? next : undefined;
  }

  it("on the S5 arrival stream the old sweep's unarchived count grows monotonically past keepRuns, while the new one keeps selecting", () => {
    // The S5 stream, scaled to 600 sweeps (200 arrivals): enough to blow far past
    // keepRuns without burning the suite's time budget — the stall is structural.
    const runs = Array.from({ length: RUNS }, (_, i) => ({
      kind: "run" as const,
      id: `r-${i}`,
      terminal: true,
      settledAt: i,
    }));
    let state = emptyArchiveState();
    let now = 10_000_000;
    const detector: number[] = [];
    let arrivals = 0;
    for (let sweep = 1; sweep <= 600; sweep++) {
      now += 60_000;
      if (sweep % 3 === 0) {
        arrivals += 1;
        runs.push({ kind: "run", id: `n-${arrivals}`, terminal: true, settledAt: 10_000 + arrivals });
      }
      const next = cfStallSweep(state, runs, now);
      if (next !== undefined) state = next;
      const archived = new Set(state.entries.filter((e) => e.kind === "run").map((e) => e.id));
      detector.push(runs.filter((c) => c.terminal && !archived.has(c.id)).length);
    }
    // The stall: after the initial fill (256 archived, 444 left over), EVERY arrival
    // stays unarchived forever — monotone growth, never within keepRuns again.
    expect(detector[0]).toBe(RUNS - 256);
    for (let i = 1; i < detector.length; i++) expect(detector[i]).toBeGreaterThanOrEqual(detector[i - 1]!);
    expect(detector[detector.length - 1]).toBe(RUNS - 256 + arrivals);
    expect(Math.max(...detector)).toBeGreaterThan(6); // S5's ① detector goes RED here
    // The teeth: the CURRENT selectAutoArchives on that same stalled state selects
    // the over-keep excess (progression) where the room clamp returned [].
    expect(cfRoomSelect(state, runs, now, AFTER_MS, 6, 5)).toHaveLength(0); // the old way: nothing
    expect(
      selectAutoArchives(state, runs, now, { afterMs: AFTER_MS, keepRuns: 6, keepBash: 5 }).length,
    ).toBeGreaterThan(0); // the new way: progression
  });
});
