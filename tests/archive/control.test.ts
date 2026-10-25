/**
 * ArchiveControl (src/archive/control.ts): persistence discipline (one full-snapshot entry per
 * change), restore, the manual archive/unarchive terminality gate, the auto sweep (batch
 * commit, holds) and dispose.
 */
import { describe, expect, it, vi } from "vitest";
import { ArchiveControl } from "../../src/archive/control.js";
import { ARCHIVE_ENTRY_TYPE } from "../../src/archive/state.js";
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

describe("ArchiveControl: auto sweep", () => {
  it("archives terminal runs and bash jobs past the threshold in ONE batch commit", () => {
    vi.useFakeTimers();
    try {
      const h = makeControl({
        runs: [runSnap({ runId: "r-old", updatedAt: 0 }), runSnap({ runId: "r-fresh", updatedAt: 999_999 })],
        jobs: [job({ jobId: "b-old", status: "completed", endedAt: 0 })],
        sweepMs: 1000,
      });
      h.control.start(30 * 60_000); // threshold 1_800_000; now = 1_000_000
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
      h.control.start(60_000);
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
