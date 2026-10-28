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
 * makeArchiveRoom) and are additionally covered by the A1 dedup guard (sameArchiveState
 * vs ArchiveControl.lastPersisted). This suite pins the WRITE RATE itself, so any
 * reappearance of either form goes red. The counterfactual block at the bottom replays
 * BOTH pre-fix sweep loops (inlined from git history, seed-deterministic) against the
 * same candidate streams and asserts this suite's checker DOES flag them — proving the
 * gate has teeth rather than passing vacuously.
 *
 * Timer arming itself is covered by tests/archive/control.test.ts; here fake timers
 * just drive the sweep cadence (60 s of wall time per sweep, `now` advancing with it,
 * exactly like the incident sessions where every rewrite carried the sweep instant).
 */
import { describe, expect, it, vi } from "vitest";
import { ArchiveControl } from "../../src/archive/control.js";
import {
  ARCHIVE_ENTRY_TYPE,
  archiveItem,
  autoArchiveDue,
  emptyArchiveState,
  isArchived,
  readArchiveState,
  sameArchiveState,
  type ArchiveState,
} from "../../src/archive/state.js";
import type { ArchiveCandidate } from "../../src/archive/sweep.js";
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

/** `kind\0id\0auto` of entries + full holds, both sorted — everything but entries' `at`. */
function semanticKey(s: ArchiveState): string {
  const entries = s.entries.map((e) => `${e.kind}\u0000${e.id}\u0000${e.auto === true}`).sort();
  const held = s.held.map((h) => `${h.kind}\u0000${h.id}\u0000${h.at}`).sort();
  return JSON.stringify([entries, held]);
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
