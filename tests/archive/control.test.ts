/**
 * ArchiveControl (src/archive/control.ts): persistence discipline (one full-snapshot entry per
 * change), restore, the manual archive/unarchive terminality gate, the auto sweep (batch
 * commit, holds) and dispose.
 */
import { describe, expect, it, vi } from "vitest";
import { ArchiveControl } from "../../src/archive/control.js";
import { ARCHIVE_ENTRIES_CAP, ARCHIVE_ENTRY_TYPE } from "../../src/archive/state.js";
import type { JobRecord } from "../../src/bash/types.js";
import type { RunSnapshot } from "../../src/core/types.js";

function runSnap(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "r-1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: {},
    diag: { createdAt: 0, phase: "settled", phaseEnteredAt: 0, escalation: [] },
    updatedAt: 1000,
    ...over,
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

function job(over: Partial<JobRecord> = {}): JobRecord {
  return { ...baseJob, ...over } as JobRecord;
}

function makeControl(
  over: {
    runs?: RunSnapshot[];
    jobs?: JobRecord[];
    now?: () => number;
    sweepMs?: number;
  } = {},
) {
  const runs = over.runs ?? [];
  const jobs = over.jobs ?? [];
  let now = over.now?.() ?? 1_000_000;
  const appended: Array<{ type: string; data: unknown }> = [];
  const control = new ArchiveControl(
    { runs: () => runs, bashJobs: () => jobs },
    {
      appendEntry: (type, data) => appended.push({ type, data }),
      now: () => now,
      ...(over.sweepMs !== undefined ? { sweepMs: over.sweepMs } : {}),
    },
  );
  return {
    control,
    appended,
    runs,
    jobs,
    setNow: (n: number) => {
      now = n;
    },
  };
}

/** The run horizon of the LAST persisted snapshot (undefined ⇒ −∞ at the caller). */
function horizonRun(h: ReturnType<typeof makeControl>): number | undefined {
  const last = h.appended[h.appended.length - 1]?.data as { horizon?: { run?: number } } | undefined;
  return last?.horizon?.run;
}

/** A `subagent:archive` branch entry carrying `data` (the snapshot payload). */
function branchEntry(data: unknown): { type: string; customType: string; data: unknown } {
  return { type: "custom", customType: ARCHIVE_ENTRY_TYPE, data };
}

describe("ArchiveControl: manual archive/unarchive", () => {
  it("archives a terminal run, persists one snapshot entry, and bumps the wire", () => {
    const h = makeControl({ runs: [runSnap()] });
    expect(h.control.setArchived("run", "r-1", "archive")).toEqual({ ok: true, changed: true });
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toEqual({
      type: ARCHIVE_ENTRY_TYPE,
      data: { entries: [{ kind: "run", id: "r-1", at: 1_000_000 }], held: [] },
    });
    // #91 review #4: a session with no live eviction writes NO horizon key (I9 spirit).
    expect("horizon" in (h.appended[0]!.data as object)).toBe(false);
    expect(h.control.wire()).toEqual({ rev: 1, entries: [{ kind: "run", id: "r-1", at: 1_000_000 }] });
    expect(h.control.view().runs.has("r-1")).toBe(true);
  });

  it("refuses a RUNNING run with not_terminal (no persist)", () => {
    const h = makeControl({ runs: [runSnap({ status: "running", phase: "model_turn" })] });
    expect(h.control.setArchived("run", "r-1", "archive")).toEqual({ ok: false, reason: "not_terminal" });
    expect(h.appended).toHaveLength(0);
  });

  it("refuses a RUNNING bash job; accepts a terminal one", () => {
    const h = makeControl({ jobs: [job(), job({ jobId: "b_DONE", status: "completed", endedAt: 500 })] });
    expect(h.control.setArchived("bash", "b_JOB0001", "archive")).toEqual({ ok: false, reason: "not_terminal" });
    expect(h.control.setArchived("bash", "b_DONE", "archive")).toEqual({ ok: true, changed: true });
  });

  it("accepts an id no longer in the live lists (idempotent archive of an evicted row)", () => {
    const h = makeControl();
    expect(h.control.setArchived("run", "gone-run", "archive")).toEqual({ ok: true, changed: true });
  });

  it("idempotent repeat and unarchive (hold recorded, wire empties)", () => {
    const h = makeControl({ runs: [runSnap()] });
    h.control.setArchived("run", "r-1", "archive");
    expect(h.control.setArchived("run", "r-1", "archive")).toEqual({ ok: true, changed: false });
    expect(h.appended).toHaveLength(1);
    expect(h.control.setArchived("run", "r-1", "unarchive")).toEqual({ ok: true, changed: true });
    expect(h.control.wire()).toBeUndefined(); // empty ⇒ absent on the wire
    // The unarchive persisted a hold alongside the emptied entries.
    expect(h.appended[1]).toEqual({
      type: ARCHIVE_ENTRY_TYPE,
      data: { entries: [], held: [{ kind: "run", id: "r-1", at: 1_000_000 }] },
    });
  });
});

describe("ArchiveControl: setArchivedMany (2026-10-28 fleet bash「归档 N 条」)", () => {
  it("archives N ids in ONE session entry (one appendEntry, one rev bump)", () => {
    const h = makeControl({
      jobs: [
        job({ jobId: "b-1", status: "completed", endedAt: 10 }),
        job({ jobId: "b-2", status: "failed", endedAt: 20 }),
        job({ jobId: "b-3", status: "timed_out", endedAt: 30 }),
      ],
    });
    expect(h.control.setArchivedMany("bash", ["b-1", "b-2", "b-3"])).toBe(3);
    expect(h.appended).toHaveLength(1);
    expect(h.control.wire()).toEqual({
      rev: 1,
      entries: [
        { kind: "bash", id: "b-1", at: 1_000_000 },
        { kind: "bash", id: "b-2", at: 1_000_000 },
        { kind: "bash", id: "b-3", at: 1_000_000 },
      ],
    });
    expect([...h.control.view().bash]).toEqual(["b-1", "b-2", "b-3"]);
  });

  it("skips already-archived ids and returns 0 (no second entry) when nothing is new", () => {
    const h = makeControl({ jobs: [job({ jobId: "b-1", status: "completed", endedAt: 10 })] });
    h.control.setArchived("bash", "b-1", "archive");
    expect(h.appended).toHaveLength(1);
    expect(h.control.setArchivedMany("bash", ["b-1", "b-1"])).toBe(0);
    expect(h.appended).toHaveLength(1);
    expect(h.control.currentRev()).toBe(1);
  });

  it("never archives a RUNNING job, even when the caller names it", () => {
    const h = makeControl({
      jobs: [job({ jobId: "b-live", status: "running" }), job({ jobId: "b-done", status: "completed", endedAt: 10 })],
    });
    expect(h.control.setArchivedMany("bash", ["b-live", "b-done"])).toBe(1);
    expect(h.control.view().bash.has("b-live")).toBe(false);
    expect(h.control.view().bash.has("b-done")).toBe(true);
  });

  it("stores ids under the requested kind only (a run id never enters the run fold)", () => {
    const h = makeControl({ runs: [runSnap({ runId: "r-1" })] });
    expect(h.control.setArchivedMany("bash", ["r-1"])).toBe(1);
    expect(h.control.view().runs.has("r-1")).toBe(false);
    expect(h.control.view().bash.has("r-1")).toBe(true);
  });

  it("cap overflow keeps the NEWEST entries and still writes exactly one entry", () => {
    const jobs = Array.from({ length: 300 }, (_, i) => job({ jobId: `b-${i}`, status: "completed", endedAt: i }));
    const h = makeControl({ jobs });
    expect(
      h.control.setArchivedMany(
        "bash",
        jobs.map((j) => j.jobId),
      ),
    ).toBe(300);
    expect(h.appended).toHaveLength(1);
    const entries = h.control.wire()?.entries ?? [];
    expect(entries).toHaveLength(ARCHIVE_ENTRIES_CAP);
    expect(entries[0]?.id).toBe("b-44");
    expect(entries[entries.length - 1]?.id).toBe("b-299");
  });

  it("an auto-archived id re-marked manual is NOT counted in `changed` (it was already archived)", () => {
    const h = makeControl({
      jobs: [
        job({ jobId: "b-auto", status: "completed", endedAt: 10 }),
        job({ jobId: "b-new", status: "completed", endedAt: 20 }),
      ],
    });
    h.control.restore([
      {
        type: "custom",
        customType: ARCHIVE_ENTRY_TYPE,
        data: { entries: [{ kind: "bash", id: "b-auto", at: 5, auto: true }], held: [] },
      },
    ]);
    // Only the genuinely new id counts: the caller's "archived N" toast must not claim b-auto.
    expect(h.control.setArchivedMany("bash", ["b-auto", "b-new"])).toBe(1);
    // …but the auto→manual transition is still persisted (the `auto` badge drops), once.
    expect(h.appended).toHaveLength(1);
    expect(h.control.wire()?.entries).toEqual([
      { kind: "bash", id: "b-auto", at: 1_000_000 },
      { kind: "bash", id: "b-new", at: 1_000_000 },
    ]);
  });

  it("re-marking ONLY auto-archived ids: changed is 0, yet the manual state is persisted", () => {
    const h = makeControl({ jobs: [job({ jobId: "b-auto", status: "completed", endedAt: 10 })] });
    h.control.restore([
      {
        type: "custom",
        customType: ARCHIVE_ENTRY_TYPE,
        data: { entries: [{ kind: "bash", id: "b-auto", at: 5, auto: true }], held: [] },
      },
    ]);
    expect(h.control.setArchivedMany("bash", ["b-auto"])).toBe(0);
    expect(h.control.wire()?.entries).toEqual([{ kind: "bash", id: "b-auto", at: 1_000_000 }]);
    expect(h.appended).toHaveLength(1);
  });

  it("an empty list is a no-op (no entry, rev unchanged)", () => {
    const h = makeControl();
    expect(h.control.setArchivedMany("bash", [])).toBe(0);
    expect(h.appended).toHaveLength(0);
    expect(h.control.currentRev()).toBe(0);
  });

  it("dispose makes it a no-op", () => {
    const h = makeControl({ jobs: [job({ jobId: "b-1", status: "completed", endedAt: 10 })] });
    h.control.dispose();
    expect(h.control.setArchivedMany("bash", ["b-1"])).toBe(0);
    expect(h.appended).toHaveLength(0);
  });
});

describe("ArchiveControl: restore", () => {
  it("re-seeds from the last branch entry", () => {
    const h = makeControl();
    h.control.restore([
      {
        type: "custom",
        customType: ARCHIVE_ENTRY_TYPE,
        data: { entries: [{ kind: "bash", id: "b1", at: 9, auto: true }] },
      },
    ]);
    expect(h.control.wire()?.entries).toEqual([{ kind: "bash", id: "b1", at: 9, auto: true }]);
  });
});

describe("ArchiveControl: auto sweep above the 256-entry archive cap (flip-flop regression)", () => {
  // Field evidence: a session whose fleet held 687 terminal runs committed a full 256-entry
  // snapshot EVERY sweep (4882 `subagent:archive` entries in 3.5 days), alternating between two
  // disjoint id sets — the sweep selected every run beyond the keep count, FIFO eviction dropped
  // the oldest-inserted ones, and the evicted (still live) runs were re-selected next minute.
  const manyRuns = (n: number) => Array.from({ length: n }, (_, i) => runSnap({ runId: `r-${i}`, updatedAt: i }));
  const archivedRuns = (h: ReturnType<typeof makeControl>) => [...h.control.view().runs].sort();

  it("converges: once the cap is full, further sweeps neither change the set nor write entries", () => {
    vi.useFakeTimers();
    try {
      const h = makeControl({ runs: manyRuns(300), sweepMs: 1000 });
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      const first = archivedRuns(h);
      expect(first).toHaveLength(256);
      expect(h.appended).toHaveLength(1);
      for (let i = 0; i < 5; i++) vi.advanceTimersByTime(1000);
      expect(archivedRuns(h)).toEqual(first); // no A/B alternation
      expect(h.appended).toHaveLength(1); // no per-minute re-commit of an unchanged-in-spirit snapshot
      // The rows a user can actually see (newest terminal) are the ones archived: r-293 is the
      // newest run beyond the keep-6 window (r-294..r-299 stay live).
      expect(h.control.view().runs.has("r-293")).toBe(true);
      expect(h.control.view().runs.has("r-299")).toBe(false);
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a manual archive is not erased by later sweeps", () => {
    vi.useFakeTimers();
    try {
      const h = makeControl({ runs: manyRuns(700), sweepMs: 1000 });
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      expect(h.control.setArchived("run", "r-699", "archive")).toEqual({ ok: true, changed: true });
      for (let i = 0; i < 5; i++) vi.advanceTimersByTime(1000);
      expect(h.control.view().runs.has("r-699")).toBe(true);
      expect(h.control.wire()?.entries.find((e) => e.id === "r-699")?.auto).toBeUndefined();
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // #91 rework — two branches where the old test asserted only the first:
  // gone entries are ALWAYS the preferred evictees, but when they do not cover the
  // overflow, the oldest-SETTLED live auto entries go instead (and raise the horizon).
  // The pre-#91 “live entries are never evicted” stance is exactly what made a full
  // cap of live entries stall auto-archive forever (docs/dev/archive-full/forensics.md).
  it("gone-enough: evicts only gone entries (P1), never live ones; the horizon does not move", () => {
    vi.useFakeTimers();
    try {
      const runs = manyRuns(300);
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      const before = archivedRuns(h);
      expect(before).toHaveLength(256);
      // 20 archived runs vanish from memory, 5 new terminal runs appear (5 < 20 gone).
      const gone = new Set(before.slice(0, 20));
      for (let i = runs.length - 1; i >= 0; i--) if (gone.has(runs[i]!.runId)) runs.splice(i, 1);
      for (let i = 0; i < 5; i++) runs.push(runSnap({ runId: `n-${i}`, updatedAt: 1000 + i }));
      vi.advanceTimersByTime(1000);
      const after = archivedRuns(h);
      expect(after).toHaveLength(256);
      for (const id of before) if (!gone.has(id)) expect(after).toContain(id); // live entries survive
      // Only the overflow (5) was taken from the gone pool — oldest-INSERTED first;
      // the other 15 gone entries stay archived until the next overflow needs them.
      for (let i = 100; i <= 104; i++) expect(after).not.toContain(`r-${i}`);
      for (let i = 105; i <= 119; i++) expect(after).toContain(`r-${i}`);
      expect(after).toContain("r-298"); // the 5 selections (r-294..r-298, oldest-settled)
      expect(after).not.toContain("r-299");
      for (let i = 0; i <= 4; i++) expect(after).not.toContain(`n-${i}`); // arrivals stay live
      // Gone victims never move the watermark — it stays at the first sweep's 37.
      expect(horizonRun(h)).toBe(37);
      vi.advanceTimersByTime(3000);
      expect(archivedRuns(h)).toEqual(after); // stable
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gone-short: makes up the shortfall from the oldest-SETTLED live auto entries and raises the horizon (#91)", () => {
    vi.useFakeTimers();
    try {
      const runs = manyRuns(300);
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      const before = archivedRuns(h); // r-38..r-293
      expect(horizonRun(h)).toBe(37);
      // No run leaves; 6 new terminal runs arrive (counted 12 > keep 6 ⇒ 6 selected).
      for (let i = 0; i < 6; i++) runs.push(runSnap({ runId: `n-${i}`, updatedAt: 1000 + i }));
      vi.advanceTimersByTime(1000);
      const after = archivedRuns(h);
      expect(after).toHaveLength(256);
      // The 6 OLDEST-SETTLED live entries — r-38..r-43 — were evicted (intentional
      // inversion of the old “live is never evicted”): progression over preservation.
      for (let i = 38; i <= 43; i++) expect(after).not.toContain(`r-${i}`);
      for (let i = 44; i <= 293; i++) expect(after).toContain(`r-${i}`);
      // The selection itself (r-294..r-299, older-settled than nothing here) survived.
      for (let i = 294; i <= 299; i++) expect(after).toContain(`r-${i}`);
      for (let i = 0; i <= 5; i++) expect(after).not.toContain(`n-${i}`); // arrivals stay live
      expect(horizonRun(h)).toBe(43); // max settledAt of the evicted live victims
      // The evicted ids never come back (implicit: settled ≤ horizon) and the fleet is stable.
      vi.advanceTimersByTime(5000);
      expect(archivedRuns(h)).toEqual(after);
      expect(before.filter((id) => !after.includes(id))).toEqual(["r-38", "r-39", "r-40", "r-41", "r-42", "r-43"]);
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ArchiveControl: auto sweep", () => {
  it("archives terminal runs and bash jobs past the threshold in ONE batch commit", () => {
    vi.useFakeTimers();
    try {
      const h = makeControl({
        runs: [runSnap({ runId: "r-old", updatedAt: 0 }), runSnap({ runId: "r-fresh", updatedAt: 999_999 })],
        jobs: [job({ jobId: "b-old", status: "completed", endedAt: 0 })],
        sweepMs: 1000,
      });
      h.control.start(30 * 60_000, 0, 0); // threshold 1_800_000; now = 1_000_000
      vi.advanceTimersByTime(1000);
      // r-old settled at 0 (age 1_000_000 < 1_800_000) — NOT due yet; nothing committed.
      expect(h.appended).toHaveLength(0);
      h.setNow(2_000_000);
      vi.advanceTimersByTime(1000);
      expect(h.appended).toHaveLength(1); // one batch entry
      expect(h.control.wire()?.entries).toEqual([
        { kind: "run", id: "r-old", at: 2_000_000, auto: true },
        { kind: "bash", id: "b-old", at: 2_000_000, auto: true },
      ]);
      // r-fresh (settled 999_999, age 1_000_001 < 1_800_000) still live.
      expect(h.control.view().runs.has("r-fresh")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses default keep counts and commits the oldest excess run/bash in one snapshot", () => {
    vi.useFakeTimers();
    try {
      const h = makeControl({
        runs: Array.from({ length: 7 }, (_, i) => runSnap({ runId: `r-${i}`, updatedAt: i })),
        jobs: Array.from({ length: 6 }, (_, i) => job({ jobId: `b-${i}`, status: "completed", endedAt: i })),
        sweepMs: 1000,
      });
      h.control.start(60_000);
      vi.advanceTimersByTime(1000);
      expect(h.appended).toHaveLength(1);
      expect(h.control.wire()?.entries).toEqual([
        { kind: "run", id: "r-0", at: 1_000_000, auto: true },
        { kind: "bash", id: "b-0", at: 1_000_000, auto: true },
      ]);
      vi.advanceTimersByTime(1000);
      expect(h.appended).toHaveLength(1);
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("0 disables the sweep (timer never armed)", () => {
    const h = makeControl({ runs: [runSnap({ updatedAt: 0 })], sweepMs: 1000 });
    h.control.start(0);
    // No timer was armed — nothing to advance; direct proof: no persist ever.
    expect((h.control as unknown as { timer: unknown }).timer).toBeUndefined();
  });

  it("never re-archives an unarchived item (hold exemption)", () => {
    vi.useFakeTimers();
    try {
      const h = makeControl({ runs: [runSnap({ runId: "r-1", updatedAt: 0 })], sweepMs: 1000 });
      h.control.setArchived("run", "r-1", "archive");
      h.control.setArchived("run", "r-1", "unarchive");
      h.control.start(60_000, 0, 0);
      h.setNow(10_000_000);
      vi.advanceTimersByTime(10_000);
      expect(h.control.wire()).toBeUndefined(); // still unarchived
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose stops the sweep and the manual paths", () => {
    vi.useFakeTimers();
    try {
      const h = makeControl({ runs: [runSnap({ updatedAt: 0 })], sweepMs: 1000 });
      h.control.start(60_000);
      h.control.dispose();
      h.setNow(10_000_000);
      vi.advanceTimersByTime(10_000);
      expect(h.appended).toHaveLength(0);
      expect(h.control.setArchived("run", "r-1", "archive")).toEqual({ ok: false, reason: "not_found" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// #91 cap-full progression (docs/dev/archive-full/plan.md §6.2 T1–T6): a 256-cap
// full of LIVE entries must not stall auto-archive. The pre-#91 selectAutoArchives
// truncated the selection to `archiveRoom` = free + gone, which is 0 on a full live
// fleet — the field-verified stall (forensics.md: 741-run session, 5,526 snapshots,
// zero progression for 18.7 h).
// ---------------------------------------------------------------------------
describe("ArchiveControl: cap-full progression (#91)", () => {
  /** The stall detector's arm: unarchived non-held terminal runs settled above the horizon. */
  const overHorizon = (h: ReturnType<typeof makeControl>): number => {
    const horizon = horizonRun(h) ?? -Infinity;
    const archived = h.control.view().runs;
    const seen = new Set<string>();
    let n = 0;
    for (const snap of h.runs) {
      if (seen.has(snap.runId)) continue;
      seen.add(snap.runId);
      if (snap.status !== "completed") continue;
      if (archived.has(snap.runId)) continue;
      if ((snap.diag.settledAt ?? snap.updatedAt) > horizon) n += 1;
    }
    return n;
  };

  it("T1 stall reproduced and fixed: a full cap of live entries still archives new arrivals, and the OLD entries settle into the horizon", () => {
    vi.useFakeTimers();
    try {
      // The forensic shape: 256 auto-archived LIVE runs (none gone) + fresh arrivals.
      const runs = Array.from({ length: 256 }, (_, i) => runSnap({ runId: `r-${i}`, updatedAt: i }));
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.restore([
        branchEntry({
          entries: runs.map((snap, i) => ({ kind: "run" as const, id: snap.runId, at: 1, auto: true as const })),
          held: [],
        }),
      ]);
      // 20 new terminal runs (past the age gate, over keep-6 ⇒ 14 due).
      for (let i = 0; i < 20; i++) runs.push(runSnap({ runId: `n-${i}`, updatedAt: 1000 + i }));
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      // One sweep, one write: the 14 OLDEST arrivals are archived (pre-#91: room=0 ⇒
      // nothing selected, zero writes — the stall).
      expect(h.appended).toHaveLength(1);
      const archived = h.control.view().runs;
      for (let i = 0; i <= 13; i++) expect(archived.has(`n-${i}`)).toBe(true);
      for (let i = 14; i <= 19; i++) expect(archived.has(`n-${i}`)).toBe(false);
      // The other half of progression (review #7): the 14 OLDEST-SETTLED old entries
      // were evicted to make room, folding into the horizon at their max settledAt —
      // not left squatting on keep slots.
      for (let i = 0; i <= 13; i++) expect(archived.has(`r-${i}`)).toBe(false);
      for (let i = 14; i <= 255; i++) expect(archived.has(`r-${i}`)).toBe(true);
      expect(horizonRun(h)).toBe(13);
      expect(overHorizon(h)).toBeLessThanOrEqual(6); // detector arm: no stall
      // And it stays settled — no further writes on a quiet fleet.
      vi.advanceTimersByTime(5000);
      expect(h.appended).toHaveLength(1);
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T2 eviction priority: gone (P1) → oldest-settled live auto (P2) → live manual last (P3); live victims raise the horizon", () => {
    vi.useFakeTimers();
    try {
      const runs: RunSnapshot[] = [];
      // The full-cap state, in insertion order: 3 gone autos, 6 live autos (settled
      // 200..205), 1 live MANUAL (settled 300 — older than the fillers!), 246 filler
      // live autos (settled 400..645).
      const entries = [
        ...Array.from({ length: 3 }, (_, i) => ({ kind: "run" as const, id: `g-${i}`, at: 1, auto: true as const })),
        ...Array.from({ length: 6 }, (_, i) => ({ kind: "run" as const, id: `a-${i}`, at: 1, auto: true as const })),
        { kind: "run" as const, id: "m-0", at: 1 },
        ...Array.from({ length: 246 }, (_, i) => ({ kind: "run" as const, id: `f-${i}`, at: 1, auto: true as const })),
      ];
      const live = (id: string, settledAt: number) => runs.push(runSnap({ runId: id, updatedAt: settledAt }));
      for (let i = 0; i < 6; i++) live(`a-${i}`, 200 + i);
      live("m-0", 300);
      for (let i = 0; i < 246; i++) live(`f-${i}`, 400 + i);
      for (let i = 0; i < 6; i++) live(`k-${i}`, 700 + i); // the keep-6 window
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.restore([branchEntry({ entries, held: [] })]);
      h.control.start(60_000, 6, 5);
      const archived = () => h.control.view().runs;
      // 12 arrivals, one per sweep: each makes exactly ONE selection → ONE eviction.
      for (let sweep = 0; sweep < 12; sweep++) {
        live(`n-${sweep}`, 800 + sweep);
        vi.advanceTimersByTime(1000);
        expect(archived().size).toBe(256); // the cap is maintained every sweep
      }
      // P1 first, insertion order: all three gone entries evicted, horizon untouched.
      for (let i = 0; i < 3; i++) expect(archived().has(`g-${i}`)).toBe(false);
      // P2 next, oldest-SETTLED live auto: a-200..a-205 (settled < the fillers < manual's
      // P3 tier), each live victim raising the horizon to its settledAt.
      for (let i = 0; i < 6; i++) expect(archived().has(`a-${i}`)).toBe(false);
      // Then the oldest-settled FILLERS — and the manual entry (settled 300, older than
      // every filler!) SURVIVES while any auto remains.
      expect(archived().has("m-0")).toBe(true);
      for (let i = 0; i < 3; i++) expect(archived().has(`f-${i}`)).toBe(false);
      expect(archived().has("f-3")).toBe(true);
      expect(horizonRun(h)).toBe(402); // max settledAt of the live victims (f-2)
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T3 held × horizon: a hold below the horizon still counts toward keep, is never selected, and a manual re-archive lifts it", () => {
    vi.useFakeTimers();
    try {
      const runs = [
        runSnap({ runId: "r-hold", updatedAt: 150 }), // settled BELOW the horizon
        ...Array.from({ length: 6 }, (_, i) =>
          runSnap({ runId: `r-${String.fromCharCode(97 + i)}`, updatedAt: 300 + i }),
        ),
      ];
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.restore([
        branchEntry({ entries: [], held: [{ kind: "run", id: "r-hold", at: 1 }], horizon: { run: 200 } }),
      ]);
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      // hold + 6 fresh = 7 counted > keep 6 ⇒ 1 selected — the oldest NON-held item,
      // never the (older) hold.
      expect([...h.control.view().runs]).toEqual(["r-a"]);
      expect(h.appended).toHaveLength(1);
      // Unarchive it → hold; with r-a held the next-oldest fresh item goes instead.
      expect(h.control.setArchived("run", "r-a", "unarchive")).toEqual({ ok: true, changed: true });
      vi.advanceTimersByTime(1000);
      expect(h.control.view().runs.has("r-a")).toBe(false);
      expect(h.control.view().runs.has("r-b")).toBe(true);
      expect(h.control.view().runs.has("r-hold")).toBe(false); // never selected
      // Manual re-archive lifts the hold and makes it an explicit entry again.
      expect(h.control.setArchived("run", "r-a", "archive")).toEqual({ ok: true, changed: true });
      expect(h.control.view().runs.has("r-a")).toBe(true);
      const last = h.appended[h.appended.length - 1]!.data as { entries: unknown[]; held: unknown[] };
      expect(last.held).toEqual([{ kind: "run", id: "r-hold", at: 1 }]); // r-a's hold lifted; r-hold stays
      expect(last.entries.find((e) => (e as { id: string }).id === "r-a")).toEqual({
        kind: "run",
        id: "r-a",
        at: 1_000_000,
      });
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T4 manual archive at a full cap evicts the oldest-SETTLED auto (not the oldest-inserted), raises the horizon, and the fleet then converges", () => {
    vi.useFakeTimers();
    try {
      // 255 live autos whose settledAt DECREASES with insertion order, plus a live
      // manual — so FIFO (oldest-inserted) and oldest-settled point at different ids.
      const runs: RunSnapshot[] = [];
      const entries = [
        ...Array.from({ length: 255 }, (_, i) => ({ kind: "run" as const, id: `a-${i}`, at: 1, auto: true as const })),
        { kind: "run" as const, id: "m-0", at: 1 },
      ];
      for (let i = 0; i < 255; i++) runs.push(runSnap({ runId: `a-${i}`, updatedAt: 1000 - i })); // a-0: 1000 … a-254: 746
      runs.push(runSnap({ runId: "m-0", updatedAt: 500 }));
      runs.push(runSnap({ runId: "fresh", updatedAt: 5_000 }));
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.restore([branchEntry({ entries, held: [] })]);
      expect(h.control.setArchived("run", "fresh", "archive")).toEqual({ ok: true, changed: true });
      const archived = h.control.view().runs;
      expect(archived.size).toBe(256);
      expect(archived.has("a-0")).toBe(true); // oldest-INSERTED survives (pre-#91 FIFO evicted it)
      expect(archived.has("a-254")).toBe(false); // oldest-SETTLED auto is the victim
      expect(archived.has("m-0")).toBe(true); // P3 not reached while autos remain
      expect(archived.has("fresh")).toBe(true);
      expect(horizonRun(h)).toBe(746);
      expect("horizon" in (h.appended[0]!.data as object)).toBe(true);
      // The keep slots are not squatted: 60 further sweeps write NOTHING.
      h.control.start(60_000, 6, 5);
      for (let i = 0; i < 60; i++) vi.advanceTimersByTime(1000);
      expect(h.appended).toHaveLength(1);
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T5 retention-window bash entries are not evicted before far older run entries", () => {
    vi.useFakeTimers();
    try {
      const runs = [...Array.from({ length: 256 }, (_, i) => runSnap({ runId: `r-${i}`, updatedAt: 100 + i }))];
      const jobs = Array.from({ length: 6 }, (_, i) =>
        job({ jobId: `b-${i}`, status: "completed", endedAt: 5_000 + i }),
      );
      const h = makeControl({ runs, jobs, sweepMs: 1000 });
      // The forensic 250+6 split, all auto, all live; bash settled far NEWER than runs.
      h.control.restore([
        branchEntry({
          entries: [
            ...Array.from({ length: 250 }, (_, i) => ({
              kind: "run" as const,
              id: `r-${i}`,
              at: 1,
              auto: true as const,
            })),
            ...Array.from({ length: 6 }, (_, i) => ({
              kind: "bash" as const,
              id: `b-${i}`,
              at: 1,
              auto: true as const,
            })),
          ],
          held: [],
        }),
      ]);
      runs.push(runSnap({ runId: "n-0", updatedAt: 4_000 })); // one arrival (counted 7 > keep 6)
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      const view = h.control.view();
      expect(view.runs.size + view.bash.size).toBe(256);
      for (let i = 0; i < 6; i++) expect(view.bash.has(`b-${i}`)).toBe(true); // bash survives
      expect(view.runs.has("r-0")).toBe(false); // the oldest-settled RUN was the victim
      expect(view.runs.has("r-250")).toBe(true); // the arrival's pressure settled the oldest run
      const horizon = (h.appended[0]!.data as { horizon?: { run?: number; bash?: number } }).horizon;
      expect(horizon).toEqual({ run: 100 }); // run horizon only — no bash key
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T6 implicit entries: unarchive is a no-op (no hold), manual archive makes them explicit", () => {
    vi.useFakeTimers();
    try {
      const runs = [runSnap({ runId: "r-imp", updatedAt: 300 }), runSnap({ runId: "r-x", updatedAt: 400 })];
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.restore([
        branchEntry({ entries: [{ kind: "run", id: "r-x", at: 5 }], held: [], horizon: { run: 500 } }),
      ]);
      // r-imp is implicitly archived (settled 300 ≤ horizon 500, not in entries):
      // unarchive ⇒ changed:false, NO hold recorded.
      expect(h.control.setArchived("run", "r-imp", "unarchive")).toEqual({ ok: true, changed: false });
      expect(h.appended).toHaveLength(0);
      // Manual archive ⇒ an explicit entry (allowed, harmless), despite s ≤ horizon.
      expect(h.control.setArchived("run", "r-imp", "archive")).toEqual({ ok: true, changed: true });
      expect(h.control.view().runs.has("r-imp")).toBe(true);
      const data = h.appended[0]!.data as { entries: unknown[]; held: unknown[] };
      expect(data.held).toEqual([]);
      expect(data.entries.find((e) => (e as { id: string }).id === "r-imp")).toEqual({
        kind: "run",
        id: "r-imp",
        at: 1_000_000,
      });
      // And the sweep leaves the explicit entry alone (archived ⇒ never re-selected).
      h.control.start(60_000, 0, 0); // keep 0: maximum pressure
      h.setNow(10_000_000);
      vi.advanceTimersByTime(1000);
      expect(h.control.view().runs.has("r-imp")).toBe(true);
      h.control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
