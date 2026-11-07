/**
 * web-hub archive plan — the `archive` cmd op through the real createCommandHandler: ok /
 * not_terminal / unsupported paths, ledger dedupe (same id replays the SAME result with
 * dup:true), and that a real mutation fires onChanged (the immediate status republish).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import { ArchiveControl } from "../../../src/archive/control.js";
import {
  BASH_JOBS_WIRE_BUDGET_BYTES,
  bashJobsWireBytes,
  omittedTerminalJobIds,
  projectBashJobs,
  projectBashJobsDetail,
  selectJobs,
  type BashJobsTails,
} from "../../../src/web-hub/agent/bash-jobs.js";
import type { JobRecord } from "../../../src/bash/types.js";
import type { RunSnapshot } from "../../../src/core/types.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

function frame(id: string, cmd: CmdFrame["cmd"]): CmdFrame {
  return { t: "cmd", rid: `r-${id}`, id, deadlineMs: 8000, origin: ORIGIN, cmd };
}

function runSnap(status: string, updatedAt = 1000): RunSnapshot {
  return {
    runId: "r-1",
    generation: 1,
    status,
    phase: "settled",
    deadlines: {},
    diag: { createdAt: 0, phase: "settled", phaseEnteredAt: 0, escalation: [] },
    updatedAt,
  } as unknown as RunSnapshot;
}

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    v: 1,
    jobId: "b_JOB0001",
    command: "echo hi",
    cwd: "/tmp",
    sessionId: "s",
    hostPid: 1,
    status: "completed",
    createdAt: 0,
    spawnedAt: 0,
    backgroundedAt: 1,
    exitCode: 0,
    logPath: "/tmp/x.log",
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
    endedAt: 500,
    ...over,
  } as JobRecord;
}

const jobsGen = {};

function makeHarness(
  runs: readonly RunSnapshot[] = [],
  withControl = true,
  jobs: readonly JobRecord[] = [],
  tails?: BashJobsTails,
) {
  const { pi } = fakePi();
  const { ctx } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const onChanged = vi.fn();
  const appended: Array<{ type: string; data: unknown }> = [];
  const control = new ArchiveControl(
    { runs: () => runs, bashJobs: () => jobs },
    { appendEntry: (type, data) => appended.push({ type, data }), now: () => 1_000_000 },
  );
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => "s1",
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: {
      get manualCompacting() {
        return false;
      },
      dispose() {},
    } as unknown as CommandHandlerDeps["compactionState"],
    originEntry: { appendOrigin: () => {}, notify: () => {}, dispose: () => {} },
    builtinBridge: {
      execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }),
      isQuiet: () => false,
    } as unknown as CommandHandlerDeps["builtinBridge"],
    controlEnabled: () => true,
    now: () => 1_000_000,
    send: (f) => sent.push(f),
    onChanged,
    setTimer: () => ({ cancel: () => {} }),
    ...(withControl ? { archive: () => control } : {}),
    bashJobs: {
      current: () => ({ gen: jobsGen, list: () => jobs }),
      retentionMs: () => 0,
      tails: () => tails,
    },
  };
  return { handler: createCommandHandler(deps), sent, onChanged, control: control as ArchiveControl, appended };
}

describe("cmd op `archive`", () => {
  it("archives a terminal run: ok + changed + immediate onChanged", () => {
    const h = makeHarness([runSnap("completed")]);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" }));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      ok: true,
      data: { op: "archive", set: "archive", changed: true },
    });
    // settleAndReply's own onChanged = the immediate status republish.
    expect(h.onChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses a running run with E_BAD_REQUEST and no onChanged", () => {
    const h = makeHarness([runSnap("running")]);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_BAD_REQUEST", retryable: false });
    expect(h.onChanged).toHaveBeenCalledTimes(1); // the settle's republish only — no mutation
  });

  it("unarchive of a not-archived item is ok with changed:false (idempotent)", () => {
    const h = makeHarness([runSnap("completed")]);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "unarchive" }));
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "archive", set: "unarchive" } });
    expect((h.sent[0] as { data: { changed?: boolean } }).data.changed).toBeUndefined();
  });

  it("settles E_UNSUPPORTED when no archive control is wired", () => {
    const h = makeHarness([runSnap("completed")], false);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_UNSUPPORTED", retryable: false });
  });

  it("same cmdId replays the same result with dup:true (ledger dedupe)", () => {
    const h = makeHarness([runSnap("completed")]);
    const f = frame("aaaaaaaaaaaaaaaa", { op: "archive", kind: "run", id: "r-1", set: "archive" });
    h.handler.handle(f);
    h.handler.handle(f);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ ok: true, dup: true, data: { op: "archive", set: "archive", changed: true } });
  });
});

// ---------------------------------------------------------------------------
// 2026-10-28 user request: the fleet bash group's `(+N more)` must be actionable — one op
// archives every terminal job the wire could not carry. The id set is derived agent-side from
// the same ranking `projectBashJobs` uses (BASH_JOBS_MAX_TERMINAL_ROWS = 12), so the browser
// never enumerates rows it cannot see.
// ---------------------------------------------------------------------------
describe("cmd op `archive_omitted` (bash)", () => {
  /** 15 terminal jobs, newest first by endedAt: i=0 has the LATEST end. */
  const terminalJobs = (n: number): JobRecord[] =>
    Array.from({ length: n }, (_, i) =>
      job({ jobId: `b-${String(i).padStart(2, "0")}`, status: "completed", endedAt: 10_000 - i * 10 }),
    );

  it("archives the terminal tail beyond the wire's row cap and reports the count", () => {
    const jobs = terminalJobs(15);
    const h = makeHarness([], true, jobs);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive_omitted", kind: "bash" }));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: 3 } });
    // Exactly the 3 OLDEST terminal jobs (the wire's 12 newest stay visible), one entry written.
    expect(h.appended).toHaveLength(1);
    expect(h.control.view().bash).toEqual(new Set(["b-12", "b-13", "b-14"]));
    expect(h.onChanged).toHaveBeenCalledTimes(1);
  });

  it("a RUNNING job is never archived, even when the tail is filled with terminal rows", () => {
    const jobs = [job({ jobId: "b-live", status: "running", endedAt: undefined, exitCode: null }), ...terminalJobs(14)];
    const h = makeHarness([], true, jobs);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive_omitted", kind: "bash" }));
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: 2 } });
    expect(h.control.view().bash.has("b-live")).toBe(false);
    expect(h.control.view().bash).toEqual(new Set(["b-12", "b-13"]));
  });

  it("a second call returns changed:0 and writes nothing (idempotent)", () => {
    const jobs = terminalJobs(15);
    const h = makeHarness([], true, jobs);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive_omitted", kind: "bash" }));
    h.handler.handle(frame("bbbbbbbbbbbbbbbb", { op: "archive_omitted", kind: "bash" }));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: 0 } });
    expect(h.appended).toHaveLength(1); // the first call's single entry
  });

  it("nothing omitted ⇒ changed:0 and no entry", () => {
    const h = makeHarness([], true, terminalJobs(12));
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive_omitted", kind: "bash" }));
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: 0 } });
    expect(h.appended).toHaveLength(0);
  });

  it("cap-room (verify r2 P1): a batch bigger than the free archive room is sized to the OLDEST rows so the click converges", () => {
    // 300 terminal jobs ⇒ 288 omitted ids in wire order (newest first). Pre-fill the archive
    // set to the 256 cap with ids unrelated to the jobs, then evict 40 ⇒ room = 40. The op must
    // archive the 40 OLDEST of the 288-id tail (its last 40, since the wire ranks newest
    // first); `changed` counts only what was really persisted, and the click does not churn the
    // 256-entry window by evicting the newest archives each pass.
    const jobs = Array.from({ length: 300 }, (_, i) =>
      job({ jobId: `b-${String(i).padStart(3, "0")}`, status: "completed", createdAt: 100, endedAt: 10_000 - i }),
    );
    const h = makeHarness([], true, jobs);
    // Fill the cap: 256 archives that are NOT in the job list (foreign ids are allowed by
    // setArchived's idempotent branch).
    for (let i = 0; i < 256; i++) h.control.setArchived("bash", `foreign-${i}`, "archive");
    // Free 40 slots.
    for (let i = 0; i < 40; i++) h.control.setArchived("bash", `foreign-${i}`, "unarchive");
    expect(
      h.control.archiveRoomFor(
        "bash",
        terminalJobs(300).map((j) => j.jobId),
      ),
    ).toBe(40);
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive_omitted", kind: "bash" }));
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: 40 } });
    const archived = h.control.view().bash;
    // The 12 wire rows stay visible; the archived batch is the OLDEST 40 of the 288-id tail.
    expect(archived.has("b-000")).toBe(false); // newest wire row stays
    expect(archived.has("b-288")).toBe(true); // the very oldest of the tail
    expect(archived.has("b-260")).toBe(true); // newest still archived in this batch
    expect(archived.has("b-259")).toBe(false); // one slot above the room — still omitted
    // The foreign archives that were evicted by the batch are the ones that were already there:
    // with room=40 the batch appended 40 new entries and the 256 cap evicted the OLDEST 40 of
    // the pre-existing foreign set — i.e. foreign-40..foreign-255 survive, foreign-0..39 gone.
    expect(archived.has("foreign-40")).toBe(true);
    expect(archived.has("foreign-0")).toBe(false);
    // A second click now has room 40 again (the batch evicted the oldest 40 foreign entries) ⇒
    // it archives the next-oldest 40 of the remaining tail, moving the window forwards instead
    // of churning the same 256 ids.
    h.handler.handle(frame("bbbbbbbbbbbbbbbb", { op: "archive_omitted", kind: "bash" }));
    // Steady state: the archive set is at the 256 cap and every entry is already in the tail's
    // remaining ids ⇒ the room is 0, but the op must still archive the very OLDEST id (one row
    // at a time) instead of reporting `changed: 0` forever.
    expect(h.sent[1]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: 1 } });
    const after2 = h.control.view().bash;
    expect(after2.has("b-259")).toBe(true); // the oldest id of the remaining tail
    expect(after2.has("b-258")).toBe(false); // one slot above — still omitted, next click
    expect(after2.has("b-260")).toBe(true); // the first batch's ids stay archived
  });

  it("settles E_UNSUPPORTED without an archive control (web-hub off)", () => {
    const h = makeHarness([], false, terminalJobs(15));
    h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive_omitted", kind: "bash" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_UNSUPPORTED", retryable: false });
    expect(h.appended).toHaveLength(0);
  });

  // The acceptance blocker (2026-10-28): the op archived rows, but `omitted` — computed without
  // any knowledge of the archive set — never moved, so the click looked dead. These tests pin the
  // two halves together for every way `omitted` can arise: (a) the id set the op archives IS the
  // wire's `omitted` (length and membership), and (b) re-projecting with the new archive set
  // drops `omitted` to zero.
  describe("drift: archived set ↔ projected `omitted` (three shapes)", () => {
    const NOW_MS = 1_000_000;
    const running = (n: number): JobRecord[] =>
      Array.from({ length: n }, (_, i) =>
        job({
          jobId: `r-${String(i).padStart(2, "0")}`,
          status: "running",
          endedAt: undefined,
          exitCode: null,
          createdAt: 900_000 - i,
        }),
      );

    /** What the browser sees for `jobs` + an archive set, via the real projection. */
    const project = (jobs: readonly JobRecord[], archived: ReadonlySet<string>, tails?: BashJobsTails) =>
      projectBashJobsDetail(jobs, tails, NOW_MS, 0, archived);

    /** Run the op, then assert (a) and (b). Returns the wire before/after for shape-specific checks. */
    const driftCheck = (jobs: readonly JobRecord[], tails?: BashJobsTails) => {
      const h = makeHarness([], true, jobs, tails);
      const before = project(jobs, h.control.view().bash, tails);
      const omittedBefore = before.wire?.omitted ?? 0;
      expect(omittedBefore).toBeGreaterThan(0); // the shape really produced an `omitted`
      // (a) The op's id set IS the wire's `omitted`: same count, every id terminal + not on the wire.
      expect(before.omittedIds).toHaveLength(omittedBefore);
      const onWire = new Set(before.wire!.rows.map((r) => String(r.id)));
      for (const id of before.omittedIds) {
        expect(onWire.has(id)).toBe(false);
        expect(jobs.find((j) => j.jobId === id)?.status).not.toBe("running");
      }
      h.handler.handle(frame("aaaaaaaaaaaaaaaa", { op: "archive_omitted", kind: "bash" }));
      expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: omittedBefore } });
      expect(h.control.view().bash).toEqual(new Set(before.omittedIds));
      // (b) The regression: after archiving, `omitted` is GONE (rows keep the archived ones for the fold).
      const after = project(jobs, h.control.view().bash, tails);
      expect(after.wire?.omitted).toBeUndefined();
      expect(after.omittedIds).toEqual([]);
      expect(projectBashJobs(jobs, tails, NOW_MS, 0, h.control.view().bash)?.omitted).toBeUndefined();
      // A second click has nothing left to do — and the honest answer is changed:0, one entry total.
      h.handler.handle(frame("bbbbbbbbbbbbbbbb", { op: "archive_omitted", kind: "bash" }));
      expect(h.sent[1]).toMatchObject({ ok: true, data: { op: "archive_omitted", changed: 0 } });
      expect(h.appended).toHaveLength(1);
      return { before, after, h };
    };

    it("shape 1 — one running row, retention off: the terminal tail past 12 is archived and `omitted` clears", () => {
      const { before, after } = driftCheck([...running(1), ...terminalJobs(15)]);
      expect(before.wire!.rows).toHaveLength(13); // 1 running + 12 terminal
      expect(before.wire!.omitted).toBe(3);
      // The archived rows stay on the wire (the fold needs them) — rows do not shrink.
      expect(after.wire!.rows.map((r) => r.id)).toEqual(before.wire!.rows.map((r) => r.id));
    });

    it("shape 2 — more than 20 running rows: running overflow is NOT `omitted` and never inflates the button", () => {
      const jobs = [...running(25), ...terminalJobs(5)];
      // Pre-fix numbers for reference: total 30 − 20 rows = 10 `omitted`, but only 5 ids archivable.
      const probe = project(jobs, new Set());
      expect(probe.wire!.rows).toHaveLength(20);
      expect(probe.wire!.omitted).toBe(5); // the 5 terminal rows ONLY
      expect(probe.wire!.rowsOverflowRunning).toBe(5); // the other 5 are running, reported separately
      const { after } = driftCheck(jobs);
      // The running overflow is permanent (not archivable): it remains, but `omitted` — and the
      // `(+N more)` button — are gone.
      expect(after.wire!.omitted).toBeUndefined();
      expect(after.wire!.rowsOverflowRunning).toBe(5);
    });

    it("shape 3 — omitted caused PURELY by the D6 byte budget (no row cap involved)", () => {
      // 12 terminal + 8 running = 20 rows: the caps drop nothing. `"\u0001"` survives redaction and
      // JSON-escapes to 6 B per char, so 200-char commands blow the 24 KiB budget and pass ⑤ drops rows.
      const fatCmd = "\u0001".repeat(200);
      const jobs = [
        ...running(8).map((j) => ({ ...j, command: fatCmd })),
        ...terminalJobs(12).map((j) => ({ ...j, command: fatCmd })),
      ];
      expect(selectJobs(jobs, NOW_MS, 0).omitted).toBe(0); // nothing omitted at the cap stage …
      const probe = project(jobs, new Set());
      expect(bashJobsWireBytes(probe.wire!)).toBeLessThanOrEqual(BASH_JOBS_WIRE_BUDGET_BYTES);
      expect(probe.wire!.rows.length).toBeLessThan(20); // … the byte ladder dropped rows
      expect(probe.wire!.omitted).toBe(20 - probe.wire!.rows.length - (probe.wire!.rowsOverflowRunning ?? 0));
      // The pre-fix cap-only derivation returned [] here (the dead-button case); the selection stage
      // alone still does, the full derivation now matches the wire.
      expect(selectJobs(jobs, NOW_MS, 0).omittedIds).toEqual([]);
      expect(omittedTerminalJobIds(jobs, NOW_MS, 0)).toHaveLength(probe.wire!.omitted!);
      const { before } = driftCheck(jobs);
      expect(before.omittedIds.length).toBeGreaterThan(0);
    });

    it("a byte-budget run with an archived row among the drops: archived drops do not count as omitted", () => {
      const fatCmd = "\u0001".repeat(200);
      const jobs = [...running(8), ...terminalJobs(12)].map((j) => ({ ...j, command: fatCmd }));
      const probe = project(jobs, new Set());
      const dropped = probe.omittedIds;
      expect(dropped.length).toBeGreaterThan(0);
      // Archive ONE of the byte-dropped rows by hand: the next projection no longer counts it.
      const withOne = project(jobs, new Set([dropped[0]!]));
      expect(withOne.wire!.omitted).toBe(dropped.length - 1);
      expect(withOne.omittedIds).toEqual(dropped.slice(1));
    });
  });
});
