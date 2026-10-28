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

describe("ArchiveControl: manual archive/unarchive", () => {
  it("archives a terminal run, persists one snapshot entry, and bumps the wire", () => {
    const h = makeControl({ runs: [runSnap()] });
    expect(h.control.setArchived("run", "r-1", "archive")).toEqual({ ok: true, changed: true });
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toEqual({
      type: ARCHIVE_ENTRY_TYPE,
      data: { entries: [{ kind: "run", id: "r-1", at: 1_000_000 }], held: [] },
    });
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

  it("makes room by dropping archive entries whose run is gone, not live ones", () => {
    vi.useFakeTimers();
    try {
      const runs = manyRuns(300);
      const h = makeControl({ runs, sweepMs: 1000 });
      h.control.start(60_000, 6, 5);
      vi.advanceTimersByTime(1000);
      const before = archivedRuns(h);
      // 20 archived runs vanish from memory, 20 new terminal runs appear.
      const gone = new Set(["r-0", "r-1", "r-2"].concat(before.slice(0, 17)));
      for (let i = runs.length - 1; i >= 0; i--) if (gone.has(runs[i]!.runId)) runs.splice(i, 1);
      for (let i = 0; i < 20; i++) runs.push(runSnap({ runId: `n-${i}`, updatedAt: 1000 + i }));
      vi.advanceTimersByTime(1000);
      const after = archivedRuns(h);
      expect(after).toHaveLength(256);
      for (const id of before) if (!gone.has(id)) expect(after).toContain(id); // live entries survive
      expect(after.filter((id) => gone.has(id))).toEqual([]); // gone ones were the evictees
      expect(after).toContain("n-13"); // newest beyond keep-6 (n-14..n-19 stay live)
      vi.advanceTimersByTime(3000);
      expect(archivedRuns(h)).toEqual(after);
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
