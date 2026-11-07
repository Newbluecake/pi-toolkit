/**
 * 2026-10-28 rework: `bashJobsProjection` (status-slots.ts) feeds `ArchiveControl.view().bash` into
 * `projectBashJobs`, so archiving the `(+N more)` tail makes `omitted` drop to zero on the very
 * next status frame. No archive source ⇒ the wire is byte-identical to the pre-change projection.
 */
import { describe, expect, it } from "vitest";
import { ArchiveControl } from "../../../src/archive/control.js";
import type { JobRecord } from "../../../src/bash/types.js";
import { createStatusSlotProjections } from "../../../src/web-hub/agent/status-slots.js";
import type { BashJobsSource } from "../../../src/web-hub/agent/bash-jobs-sampler.js";

const NOW = 1_790_000_000_000;
const gen = {};

const terminal = (i: number): JobRecord =>
  ({
    v: 1,
    jobId: `b-${String(i).padStart(2, "0")}`,
    command: "echo hi",
    cwd: "/w",
    sessionId: "s",
    hostPid: 1,
    status: "completed",
    createdAt: NOW - 100_000 - i,
    spawnedAt: NOW - 100_000 - i,
    backgroundedAt: NOW - 100_000 - i,
    exitCode: 0,
    logPath: "/x.log",
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
    endedAt: NOW - 1_000 - i,
  }) as JobRecord;

function make(opts: { withArchive: boolean; archiveThrows?: boolean }) {
  const jobs = Array.from({ length: 15 }, (_, i) => terminal(i));
  const control = new ArchiveControl(
    { runs: () => [], bashJobs: () => jobs },
    { appendEntry: () => {}, now: () => NOW },
  );
  const source: BashJobsSource = { gen, list: () => jobs, tail: async () => undefined };
  const slots = createStatusSlotProjections({
    sources: {
      bashJobs: { current: () => source, retentionMs: () => 0 },
      ...(opts.withArchive
        ? {
            archive: () => {
              if (opts.archiveThrows === true) throw new Error("boom");
              return control;
            },
          }
        : {}),
    },
    conn: () => undefined,
    bashTails: () => undefined,
    now: () => NOW,
  });
  return { slots, control, jobs };
}

describe("status-slots bashJobsProjection — archive-aware omitted", () => {
  it("archiving the omitted tail drops `omitted` to zero while rows stay (fold keeps them)", () => {
    const h = make({ withArchive: true });
    const before = h.slots.bashJobsProjection()!;
    expect(before.rows).toHaveLength(12);
    expect(before.omitted).toBe(3);
    h.control.setArchivedMany("bash", ["b-12", "b-13", "b-14"]);
    const after = h.slots.bashJobsProjection()!;
    expect(after.omitted).toBeUndefined();
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id));
  });

  it("no archive source ⇒ same wire as an archive source with nothing archived", () => {
    const withNone = make({ withArchive: true }).slots.bashJobsProjection();
    const without = make({ withArchive: false }).slots.bashJobsProjection();
    expect(JSON.stringify(without)).toBe(JSON.stringify(withNone));
    expect(without!.omitted).toBe(3);
  });

  it("a throwing archive getter degrades to the no-archive wire (never takes the frame down)", () => {
    const h = make({ withArchive: true, archiveThrows: true });
    expect(h.slots.bashJobsProjection()!.omitted).toBe(3);
  });
});
