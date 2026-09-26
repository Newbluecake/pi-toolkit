import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBashJobManager,
  EXTEND_PERSIST_TIMEOUT_MS,
  formatLogTruncationNotice,
  shouldNotifyJob,
  STAGE_PERSIST_TIMEOUT_MS,
  type BashJobManager,
  type BashJobManagerOptions,
} from "../../src/bash/manager.js";
import { createJobStore, type JobStore } from "../../src/bash/job-store.js";
import type {
  JobExit,
  KillJobTreeOptions,
  KillOutcome,
  PidIdentity,
  PidOwnership,
  ProcessPort,
  SpawnedJob,
} from "../../src/bash/process.js";
import {
  createJobRecord,
  formatJobLogFooter,
  transitionJob,
  type JobDeadlinePolicy,
  type JobRecord,
  type JobStatus,
} from "../../src/bash/types.js";
import { FakeClock } from "../../src/core/clock.js";
import { handoffInProcess } from "../../src/bash/session-dirs.js";

/**
 * §3 manager suite. The process boundary is faked (`tests/bash/process.test.ts`
 * owns the real-spawn contract), the clock is fake, but the job store is the
 * real one over a `mkdtemp` directory — log tee, cursor persistence and
 * recovery are all filesystem behaviour and fakes would prove nothing.
 */

const HOST_PID = 4242;

class FakeProc {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private settleExit!: (exit: JobExit) => void;
  private settleDrain!: (result: { exit: JobExit; stop: "ended" | "idle" | "capped" | "error" }) => void;
  private lastExit: JobExit | undefined;
  readonly processExitPromise = new Promise<JobExit>((resolve) => {
    this.settleExit = resolve;
  });
  readonly drainedPromise = new Promise<{ exit: JobExit; stop: "ended" | "idle" | "capped" | "error" }>((resolve) => {
    this.settleDrain = resolve;
  });
  constructor(
    readonly pid: number,
    readonly procStartTime: string | undefined,
  ) {}

  get spawned(): SpawnedJob {
    return {
      pid: this.pid,
      pgid: this.pid,
      stdout: this.stdout,
      stderr: this.stderr,
      processExitPromise: this.processExitPromise,
      drainedPromise: this.drainedPromise,
      ...(this.procStartTime !== undefined ? { procStartTime: this.procStartTime } : {}),
    };
  }

  exitOnly(exit: Partial<JobExit> = {}): void {
    if (this.lastExit) return;
    this.lastExit = { exitCode: 0, signal: null, ...exit };
    this.settleExit(this.lastExit);
  }

  drain(stop: "ended" | "idle" | "capped" | "error" = "ended"): void {
    if (!this.lastExit) this.exitOnly();
    this.stdout.end();
    this.stderr.end();
    this.settleDrain({ exit: this.lastExit!, stop });
  }

  exit(exit: Partial<JobExit> = {}): void {
    this.exitOnly(exit);
    this.drain();
  }
}

class FakePort implements ProcessPort {
  readonly procs: FakeProc[] = [];
  readonly spawns: { command: string; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  readonly killCalls: { pid: number; options?: KillJobTreeOptions }[] = [];
  killOutcome: KillOutcome = "terminated";
  spawnError: Error | undefined;
  procStartTime: string | undefined = "1000";
  nextPid = 5000;
  readonly ownership = new Map<number, PidOwnership>();
  readonly alivePids = new Set<number>();

  async spawnJob(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnedJob> {
    this.spawns.push({ command, cwd, ...(env !== undefined ? { env } : {}) });
    if (this.spawnError) throw this.spawnError;
    const proc = new FakeProc(this.nextPid++, this.procStartTime);
    this.procs.push(proc);
    this.ownership.set(proc.pid, "alive");
    this.alivePids.add(proc.pid);
    return proc.spawned;
  }

  async killJobTree(pid: number, options?: KillJobTreeOptions): Promise<KillOutcome> {
    this.killCalls.push({ pid, ...(options !== undefined ? { options } : {}) });
    return this.killOutcome;
  }

  probePid(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  readProcStartTime(): string | undefined {
    return this.procStartTime;
  }

  checkPidOwnership(identity: PidIdentity): PidOwnership {
    return identity.pid === undefined ? "dead" : (this.ownership.get(identity.pid) ?? "dead");
  }

  last(): FakeProc {
    const proc = this.procs[this.procs.length - 1];
    if (!proc) throw new Error("no fake process spawned");
    return proc;
  }
}

interface Harness {
  dir: string;
  store: JobStore;
  clock: FakeClock;
  port: FakePort;
  warnings: string[];
  notified: JobRecord[];
  notifyError: () => Error | undefined;
  setNotifyError: (error: Error | undefined) => void;
  manager: BashJobManager;
  /** Rebuild a manager over the same directory (the `/reload` scenario). */
  rebuild(overrides?: Partial<BashJobManagerOptions>): BashJobManager;
}

const managers: BashJobManager[] = [];

/** Drain the microtask + immediate queues so stream/fs callbacks land. */
async function settle(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `pushWrite` chains log writes asynchronously, so draining the event loop a
 * fixed number of times does *not* guarantee the bytes reached the file — under
 * full-suite CPU contention a pending chunk can still be in flight (observed as
 * a ~1-in-5 flake on the log-cap assertion). `readOutput` awaits that chain by
 * contract, so it is the deterministic way to sync before reading the log file
 * directly.
 */
async function flushLog(manager: BashJobManager, jobId: string): Promise<void> {
  await manager.readOutput(jobId, { offset: 0, advanceCursor: false, maxBytes: 1 });
}

/**
 * The notification poll is fire-and-forget (`void tick()`) and each step is a
 * real filesystem round-trip, so poll-driven assertions wait for the observable
 * effect rather than for a fixed number of event-loop turns.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function harness(
  overrides: Partial<BashJobManagerOptions> = {},
  options: { retentionMs?: number } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-bash-manager-"));
  const dir = join(root, "bash-jobs");
  const clock = new FakeClock(1_000);
  const port = new FakePort();
  const warnings: string[] = [];
  const notified: JobRecord[] = [];
  let notifyError: Error | undefined;
  const store = createJobStore({
    dir,
    retentionMs: options.retentionMs ?? 86_400_000,
    clock,
    warn: (m) => warnings.push(m),
  });
  const build = (extra: Partial<BashJobManagerOptions> = {}): BashJobManager => {
    const manager = createBashJobManager({
      store,
      processPort: port,
      clock,
      sessionId: "s1",
      hostPid: HOST_PID,
      warn: (m) => warnings.push(m),
      notify: (record) => {
        if (notifyError) throw notifyError;
        notified.push(record);
      },
      ...overrides,
      ...extra,
    });
    managers.push(manager);
    return manager;
  };
  return {
    dir,
    store,
    clock,
    port,
    warnings,
    notified,
    notifyError: () => notifyError,
    setNotifyError: (error) => {
      notifyError = error;
    },
    manager: build(),
    rebuild: build,
  };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

/** Write a record straight to disk, bypassing the manager (recovery fixtures). */
async function seed(
  store: JobStore,
  jobId: string,
  patch: Partial<JobRecord> & { status?: JobStatus } = {},
): Promise<JobRecord> {
  const base = createJobRecord({
    jobId,
    command: "sleep 600",
    cwd: "/repo",
    sessionId: "s0",
    hostPid: HOST_PID,
    logPath: store.logPath(jobId),
    createdAt: 500,
  });
  const record = { ...base, ...patch } as JobRecord;
  await store.save(record);
  return record;
}

describe("bash job manager: create and terminal settlement", () => {
  it("spawns, tees both pipes into the log, relays onData and persists the running record", async () => {
    const h = await harness();
    const relayed: string[] = [];
    const job = await h.manager.create({
      command: "npm test",
      cwd: "/repo",
      env: { PI_X: "1" },
      onData: (chunk) => relayed.push(chunk),
    });

    expect(h.port.spawns).toEqual([{ command: "npm test", cwd: "/repo", env: { PI_X: "1" } }]);
    expect(job.jobId).toMatch(/^b_[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(job.record.status).toBe("running");
    expect(job.record.pid).toBe(job.pid);
    expect(job.record.pgid).toBe(job.pgid);
    expect(job.record.procStartTime).toBe("1000");
    expect(job.record.spawnedAt).toBe(1_000);

    const proc = h.port.last();
    proc.stdout.write("out\n");
    proc.stderr.write("err\n");
    await settle();
    await flushLog(h.manager, job.jobId);

    expect(relayed).toEqual(["out\n", "err\n"]);
    expect(await readFile(job.logPath, "utf8")).toBe("out\nerr\n");

    const stored = await h.store.load(job.jobId);
    expect(stored?.status).toBe("running");
    expect(stored?.pid).toBe(job.pid);
  });

  it("settles completed / failed / killed / timed_out and persists the terminal record", async () => {
    const cases: { exit: Partial<JobExit>; note?: "killed" | "timed_out"; status: JobStatus; code: number | null }[] = [
      { exit: { exitCode: 0 }, status: "completed", code: 0 },
      { exit: { exitCode: 3 }, status: "failed", code: 3 },
      { exit: { exitCode: null, signal: "SIGTERM" }, status: "killed", code: null },
      { exit: { exitCode: null, signal: "SIGTERM" }, note: "timed_out", status: "timed_out", code: null },
    ];
    for (const testCase of cases) {
      const h = await harness();
      const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
      if (testCase.note) h.manager.noteTermination(job.jobId, testCase.note);
      h.clock.advance(5_000);
      h.port.last().exit(testCase.exit);

      const final = await job.exit;
      expect(final.status).toBe(testCase.status);
      expect(final.exitCode).toBe(testCase.code);
      expect(final.endedAt).toBe(6_000);
      expect((await h.store.load(job.jobId))?.status).toBe(testCase.status);
      expect(h.manager.get(job.jobId)?.status).toBe(testCase.status);
    }
  });

  it("records a post-spawn error as finalText and never rejects the exit promise", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: null, signal: null, error: new Error("pipe blew up") });
    const final = await job.exit;
    expect(final.status).toBe("failed");
    expect(final.finalText).toBe("pipe blew up");
  });

  it("maps a spawn failure to staged -> failed, persists it and rethrows", async () => {
    const h = await harness();
    h.port.spawnError = new Error("spawn bash ENOENT");
    await expect(h.manager.create({ command: "cmd", cwd: "/nope" })).rejects.toThrow(/ENOENT/);

    const records = await h.store.loadAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.finalText).toContain("ENOENT");
    // A foreground spawn failure is reported through the tool call itself.
    expect(shouldNotifyJob(records[0] as JobRecord)).toBe(false);
  });

  it("accepts the inner tool's final text before and after settlement", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 1 });
    await job.exit;

    const updated = await h.manager.setFinalText(job.jobId, "boom\n\nCommand exited with code 1");
    expect(updated?.finalText).toBe("boom\n\nCommand exited with code 1");
    expect((await h.store.load(job.jobId))?.finalText).toContain("Command exited with code 1");
  });
});

describe("bash job manager: log cap (§3.4)", () => {
  it("stops writing past maxLogBytes, appends the marker once and persists outputTruncated", async () => {
    const h = await harness({ maxLogBytes: 10 });
    const job = await h.manager.create({ command: "yes", cwd: "/repo" });
    const proc = h.port.last();
    proc.stdout.write("0123456");
    proc.stdout.write("789abcdef");
    proc.stdout.write("ignored entirely");
    await settle();
    await flushLog(h.manager, job.jobId);

    const log = await readFile(job.logPath, "utf8");
    expect(log).toBe(`0123456789${formatLogTruncationNotice(10)}`);
    expect(h.manager.get(job.jobId)?.outputTruncated).toBe(true);
    expect((await h.store.load(job.jobId))?.outputTruncated).toBe(true);

    proc.exit({ exitCode: 0 });
    const final = await job.exit;
    expect(final.outputTruncated).toBe(true);
    // Change B: the terminal footer is appended even though the cap was hit —
    // the conclusion of a log must never be swallowed by a capacity policy, so
    // the file is allowed to end up slightly over maxLogBytes.
    const capped = await readFile(job.logPath, "utf8");
    expect(capped.startsWith(log)).toBe(true);
    expect(capped.trimEnd().endsWith(`job ${job.jobId} completed (exit 0) after 0ms`)).toBe(true);
    expect(capped.length).toBeGreaterThan(10);
    expect(final.logBytes).toBe(capped.length);
    // The cap protects the disk; it is never a reason to kill the process.
    expect(h.port.killCalls).toEqual([]);
  });
});

describe("bash job manager: readOutput cursor (§4.3)", () => {
  it("reads incrementally, advances the persisted cursor and honours explicit offsets", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const proc = h.port.last();
    proc.stdout.write("hello ");
    await settle();

    const first = await h.manager.readOutput(job.jobId);
    expect(first.content).toBe("hello ");
    expect(first.startOffset).toBe(0);
    expect(first.nextOffset).toBe(6);
    expect(first.state).toBe("running");
    expect(first.logTruncated).toBe(false);
    expect((await h.store.load(job.jobId))?.readCursor).toBe(6);

    // Nothing new: an empty increment, cursor unchanged.
    expect((await h.manager.readOutput(job.jobId)).content).toBe("");

    proc.stdout.write("world");
    await settle();
    const second = await h.manager.readOutput(job.jobId);
    expect(second.content).toBe("world");
    expect(second.nextOffset).toBe(11);

    // Explicit replay must not rewind the persisted cursor (store is monotonic).
    const replay = await h.manager.readOutput(job.jobId, { offset: 0 });
    expect(replay.content).toBe("hello world");
    expect((await h.store.load(job.jobId))?.readCursor).toBe(11);

    // maxBytes caps one increment; the rest stays reachable.
    const capped = await h.manager.readOutput(job.jobId, { offset: 0, maxBytes: 5, advanceCursor: false });
    expect(capped.content).toBe("hello");
    expect(capped.nextOffset).toBe(5);

    proc.exit({ exitCode: 2 });
    await job.exit;
    await h.manager.setFinalText(job.jobId, "Command exited with code 2");
    const closing = await h.manager.readOutput(job.jobId);
    expect(closing.state).toBe("failed");
    expect(closing.exitCode).toBe(2);
    expect(closing.finalText).toBe("Command exited with code 2");
    // 11 bytes of output + the terminal footer line (change B).
    const withFooter = await readFile(job.logPath, "utf8");
    expect(closing.logBytes).toBe(withFooter.length);
    expect(withFooter.startsWith("hello world\n[pi-subagent] job ")).toBe(true);
  });

  it("reports an empty read for a job whose log never materialised", async () => {
    const h = await harness();
    await seed(h.store, "b_MSSNG001", { status: "exited_unknown", endedAt: 900 });
    await h.manager.recover();
    const read = await h.manager.readOutput("b_MSSNG001");
    expect(read.content).toBe("");
    expect(read.logBytes).toBe(0);
    expect(read.state).toBe("exited_unknown");
  });

  it("throws for an unknown job id", async () => {
    const h = await harness();
    await expect(h.manager.readOutput("b_NPENPE99")).rejects.toThrow(/not found/);
  });
});

describe("bash job manager: resolution (§4.3)", () => {
  it("resolves exact ids and unique prefixes, and lists candidates otherwise", async () => {
    const h = await harness();
    await seed(h.store, "b_AAAA1111", { status: "completed", endedAt: 700, exitCode: 0, command: "npm test" });
    await seed(h.store, "b_AAAA2222", { status: "completed", endedAt: 700, exitCode: 0 });
    await seed(h.store, "b_BBBB3333", { status: "completed", endedAt: 700, exitCode: 0 });
    await h.manager.recover();

    expect(h.manager.resolve("b_AAAA1111")).toBe("b_AAAA1111");
    expect(h.manager.resolve("b_B")).toBe("b_BBBB3333");
    expect(() => h.manager.resolve("b_AAAA")).toThrow(/ambiguous bash job target: b_AAAA\. Candidates: \[/);
    expect(() => h.manager.resolve("b_AAAA")).toThrow(/b_AAAA1111 → \$ npm test \(completed, \dm ago\)/);
    expect(() => h.manager.resolve("b_ZZZZ")).toThrow(/bash job not found: b_ZZZZ\. Candidates: \[/);
    expect(() => h.manager.resolve("")).toThrow(/not found/);
  });

  it("reports 'none' as the candidate list when nothing is known", async () => {
    const h = await harness();
    expect(() => h.manager.resolve("b_X")).toThrow(/Candidates: \[none\]/);
  });
});

describe("bash job manager: background slots (§3.8)", () => {
  it("counts this host's running, backgrounded jobs only", async () => {
    const h = await harness({ maxBackgroundJobs: 2 });
    expect(h.manager.maxBackgroundJobs).toBe(2);
    const a = await h.manager.create({ command: "a", cwd: "/repo" });
    const b = await h.manager.create({ command: "b", cwd: "/repo" });

    // Foreground jobs do not occupy a slot.
    expect(h.manager.backgroundJobCount()).toBe(0);
    expect(h.manager.hasBackgroundCapacity()).toBe(true);

    await h.manager.markBackgrounded(a.jobId);
    expect(h.manager.backgroundJobCount()).toBe(1);
    await h.manager.markBackgrounded(b.jobId);
    expect(h.manager.backgroundJobCount()).toBe(2);
    expect(h.manager.hasBackgroundCapacity()).toBe(false);

    // markBackgrounded is idempotent (the timestamp is not rewritten).
    const at = h.manager.get(a.jobId)?.backgroundedAt;
    h.clock.advance(1_000);
    await h.manager.markBackgrounded(a.jobId);
    expect(h.manager.get(a.jobId)?.backgroundedAt).toBe(at);

    // A terminal job releases its slot.
    h.port.procs[0]?.exit({ exitCode: 0 });
    await a.exit;
    expect(h.manager.backgroundJobCount()).toBe(1);
    expect(h.manager.hasBackgroundCapacity()).toBe(true);
  });
});

describe("bash job manager: completion notifications (§5)", () => {
  it("notifies a backgrounded job exactly once and stamps notifiedAt", async () => {
    const h = await harness({ pollMs: 2_000 });
    const job = await h.manager.create({ command: "npm test", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    expect(h.notified).toHaveLength(0);

    h.clock.advance(2_000);
    await waitFor(() => h.manager.get(job.jobId)?.notifiedAt !== undefined, "notifiedAt stamped");
    expect(h.notified.map((r) => r.jobId)).toEqual([job.jobId]);
    expect(h.manager.get(job.jobId)?.notifiedAt).toBe(3_000);
    expect((await h.store.load(job.jobId))?.notifiedAt).toBe(3_000);

    // Further ticks are silent, and the poll stops once there is no work.
    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("never notifies a job that was not backgrounded", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "echo hi", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toEqual([]);
  });

  it("retries on the next tick when the sink throws, then stamps once", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "npm test", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.setNotifyError(new Error("sendMessage exploded"));
    h.port.last().exit({ exitCode: 1 });
    await job.exit;

    h.clock.advance(2_000);
    await settle();
    expect(h.notified).toEqual([]);
    expect(h.manager.get(job.jobId)?.notifiedAt).toBeUndefined();
    expect(h.warnings.some((w) => w.includes("notification failed"))).toBe(true);

    h.setNotifyError(undefined);
    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "retried notification");
    expect(h.notified.map((r) => r.jobId)).toEqual([job.jobId]);

    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toHaveLength(1);
  });

  it("re-sends nothing that a previous session already announced (disk idempotency)", async () => {
    const h = await harness();
    await seed(h.store, "b_DNE00001", {
      status: "completed",
      exitCode: 0,
      backgroundedAt: 600,
      endedAt: 700,
      notifiedAt: 800,
    });
    const summary = await h.manager.recover();
    expect(summary.pendingNotices).toEqual([]);
    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toEqual([]);
  });
});

describe("bash job manager: kill (§3.3)", () => {
  it("runs the ladder for a local job and labels the exit killed", async () => {
    const h = await harness({ killGraceMs: 500 });
    const job = await h.manager.create({ command: "sleep 600", cwd: "/repo" });
    const result = await h.manager.kill(job.jobId);

    expect(result.outcome).toBe("terminated");
    expect(result.alreadyTerminal).toBe(false);
    expect(h.port.killCalls).toEqual([{ pid: job.pid, options: { graceMs: 500, expectedProcStartTime: "1000" } }]);

    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    const final = await job.exit;
    expect(final.status).toBe("killed");
  });

  it("is idempotent: a terminal job reports already-terminal without signalling", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;

    const result = await h.manager.kill(job.jobId);
    expect(result).toMatchObject({ outcome: "already-terminal", alreadyTerminal: true });
    expect(result.record.status).toBe("completed");
    expect(h.port.killCalls).toEqual([]);
  });

  it("T10/T13: a killJobTree rejection is absorbed and the terminal state lands exactly once", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = await harness();
      const job = await h.manager.create({ command: "sleep 600", cwd: "/repo" });
      await h.manager.markBackgrounded(job.jobId);
      // The signal was genuinely sent, but the transport reports a rejection
      // instead of an outcome — exactly the R12 "rejection absorbed" case.
      let killCalls = 0;
      h.port.killJobTree = async () => {
        killCalls += 1;
        throw new Error("kill transport hiccup");
      };

      // The tool's abort path (cancelReserve → kill) absorbs the rejection
      // internally — nothing throws, nothing becomes unhandled.
      h.manager.cancelReserve(job.jobId);
      expect(killCalls).toBe(1);
      // The absorption itself is a fire-and-forget `.catch` — one microtask later.
      await waitFor(
        () => h.warnings.some((w) => w.includes("cancelReserve kill failed")),
        "the kill rejection to be absorbed with a warning",
      );
      // The process still dies from the delivered signal: the exit event —
      // not the rejected kill — is the one authority, and the terminal
      // transition lands exactly once.
      h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
      await waitFor(() => h.manager.get(job.jobId)?.status === "killed", "the job to settle killed");
      const record = h.manager.get(job.jobId)!;
      expect(record.status).toBe("killed");
      expect(record.endedAt).toBe(1_000);
      await settle();
      expect(unhandled).toEqual([]);

      // A kill on the now-terminal job neither signals again nor throws.
      const again = await h.manager.kill(job.jobId);
      expect(again.alreadyTerminal).toBe(true);
      expect(killCalls).toBe(1);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("refuses to kill an adopted job with unverifiable ownership and marks it orphaned", async () => {
    const h = await harness();
    await seed(h.store, "b_NSAFE001", { status: "running", pid: 9001, spawnedAt: 600, hostPid: HOST_PID });
    h.port.ownership.set(9001, "alive");
    await h.manager.recover();
    // Identity became unverifiable between adoption and the kill request.
    h.port.ownership.set(9001, "unsafe");

    const result = await h.manager.kill("b_NSAFE001");
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/cannot be safely killed/);
    expect(result.record.status).toBe("orphaned");
    expect(h.port.killCalls).toEqual([]);
    // Orphans are displayed, never announced (§3.6).
    expect(shouldNotifyJob(result.record)).toBe(false);
  });

  it("refuses when the ladder itself refuses (pid reuse guard) and does not lose the record", async () => {
    const h = await harness();
    await seed(h.store, "b_RCYC0001", {
      status: "running",
      pid: 9002,
      spawnedAt: 600,
      procStartTime: "77",
      hostPid: HOST_PID,
    });
    h.port.ownership.set(9002, "alive");
    h.port.killOutcome = "refused";
    await h.manager.recover();

    const result = await h.manager.kill("b_RCYC0001");
    expect(result.outcome).toBe("refused");
    expect(result.record.status).toBe("orphaned");
    expect((await h.store.load("b_RCYC0001"))?.status).toBe("orphaned");
  });

  it("kills an adopted live job and settles it as killed", async () => {
    const h = await harness();
    await seed(h.store, "b_ADPT0001", { status: "running", pid: 9003, spawnedAt: 600, backgroundedAt: 650 });
    h.port.ownership.set(9003, "alive");
    h.port.alivePids.add(9003);
    h.port.killOutcome = "killed";
    await h.manager.recover();

    const result = await h.manager.kill("b_ADPT0001");
    expect(result.outcome).toBe("killed");
    expect(result.record.status).toBe("killed");
    expect((await h.store.load("b_ADPT0001"))?.status).toBe("killed");
  });

  it("marks an adopted job whose pid is already gone as exited_unknown", async () => {
    const h = await harness();
    await seed(h.store, "b_GNE00001", { status: "running", pid: 9004, spawnedAt: 600 });
    h.port.ownership.set(9004, "alive");
    await h.manager.recover();
    // The process died between recovery and the kill request.
    h.port.ownership.set(9004, "dead");

    const result = await h.manager.kill("b_GNE00001");
    expect(result.outcome).toBe("already-dead");
    expect(result.record.status).toBe("exited_unknown");
    expect(h.port.killCalls).toEqual([]);
  });

  it("throws for an unknown job id", async () => {
    const h = await harness();
    await expect(h.manager.kill("b_NPENPE99")).rejects.toThrow(/not found/);
  });
});

describe("bash job manager: waitExit", () => {
  it("resolves when the job settles", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const waiting = h.manager.waitExit(job.jobId, 60_000);
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    expect((await waiting)?.status).toBe("completed");
    // The waiter's own timer is cleared eagerly; the notification poll retires
    // itself once there is nothing left to do — including the pending discard
    // of this foreground job's record (default 5s grace).
    h.clock.advance(2_000);
    await settle();
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(5_000);
    await waitFor(() => h.manager.get(job.jobId) === undefined, "record discarded");
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("returns the current record on timeout instead of failing (Z1)", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const waiting = h.manager.waitExit(job.jobId, 30_000);
    h.clock.advance(30_000);
    const record = await waiting;
    expect(record?.status).toBe("running");
  });

  it("resolves immediately for an already terminal job and undefined for an unknown one", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    expect((await h.manager.waitExit(job.jobId, 1_000))?.status).toBe("completed");
    expect(await h.manager.waitExit("b_NPENPE99", 1_000)).toBeUndefined();
  });

  it("releases pending waiters on dispose", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const waiting = h.manager.waitExit(job.jobId, 60_000);
    h.manager.dispose();
    expect((await waiting)?.status).toBe("running");
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("settles early when the abort signal fires, clearing the waiter's timer", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const controller = new AbortController();
    const waiting = h.manager.waitExit(job.jobId, 60_000, { signal: controller.signal });
    const armed = h.clock.pendingTimers;
    controller.abort();
    expect((await waiting)?.status).toBe("running");
    // The waiter's timer is cleared eagerly on abort, not left to burn down
    // to the wait_ms deadline.
    expect(h.clock.pendingTimers).toBe(armed - 1);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const controller = new AbortController();
    controller.abort();
    expect((await h.manager.waitExit(job.jobId, 60_000, { signal: controller.signal }))?.status).toBe("running");
  });
});

describe("bash job manager: handoff ownership (§3.6)", () => {
  it("exports only backgrounded local jobs", async () => {
    const h = await harness();
    const foreground = await h.manager.create({ command: "foreground", cwd: "/repo" });
    expect(h.manager.exportLocalJobs()).toEqual([]);
    await h.manager.markBackgrounded(foreground.jobId);
    expect(h.manager.exportLocalJobs().map((handoff) => handoff.jobId)).toEqual([foreground.jobId]);
  });

  it("transfers ownership through A to B to C and settles exactly once", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 1", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    const first = h.manager.exportLocalJobs();
    const b = h.rebuild();
    b.adoptLocalJobs(first);
    const second = b.exportLocalJobs();
    const c = h.rebuild();
    c.adoptLocalJobs(second);

    h.port.last().exit({ exitCode: 7 });
    await waitFor(() => c.get(job.jobId)?.status === "failed", "C finalization");
    const stored = await h.store.load(job.jobId);
    expect(stored?.status).toBe("failed");
    expect(stored?.exitCode).toBe(7);
    const log = await readFile(job.logPath, "utf8");
    expect((log.match(/\[pi-subagent\] job .* failed/g) ?? []).length).toBe(1);
  });

  it("updates the in-memory log path before cross-directory adoption", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "path", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    const nextDir = join(h.dir, "next");
    const nextStore = createJobStore({ dir: nextDir, retentionMs: 86_400_000, clock: h.clock });
    const next = h.rebuild({ store: nextStore, sessionId: "s2" });
    await handoffInProcess(h.manager, next, {
      rootDir: h.dir,
      sessionId: "s2",
      retentionMs: 86_400_000,
      clock: h.clock,
      processPort: h.port,
    });
    expect(next.get(job.jobId)?.logPath).toBe(join(nextDir, `${job.jobId}.log`));
    h.port.last().stdout.write("visible\n");
    await settle();
    expect((await next.readOutput(job.jobId, { offset: 0, advanceCursor: false })).content).toContain("visible");
  });

  it("keeps the terminal result when exit races with export", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "race", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.port.last().exit({ exitCode: 7 });
    const handoff = h.manager.exportLocalJobs();
    const next = h.rebuild();
    next.adoptLocalJobs(handoff);
    await waitFor(() => next.get(job.jobId)?.status === "failed", "raced finalization");
    expect((await h.store.load(job.jobId))?.exitCode).toBe(7);
  });
});

describe("bash job manager: notification convergence", () => {
  it("marks memory notified when the record is externally removed", async () => {
    const h = await harness({ pollMs: 1_000 });
    const job = await h.manager.create({ command: "notify", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    await h.store.remove(job.jobId);
    h.clock.advance(1_000);
    await waitFor(() => h.notified.length === 1, "notification after external removal");
    h.clock.advance(5_000);
    await settle();
    expect(h.notified).toHaveLength(1);
    expect(h.manager.get(job.jobId)?.notifiedAt).toBeTypeOf("number");
  });
});

describe("bash job manager: dispose (§3.6 reload safety)", () => {
  it("clears timers, kills nothing and stops notifying while still persisting terminal state", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "npm test", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.manager.dispose();

    expect(h.clock.pendingTimers).toBe(0);
    expect(h.port.killCalls).toEqual([]);

    // The old manager's in-flight exit callback must only write to disk.
    h.port.last().exit({ exitCode: 0 });
    const final = await job.exit;
    expect(final.status).toBe("completed");
    expect((await h.store.load(job.jobId))?.status).toBe("completed");
    h.clock.advance(60_000);
    await settle();
    expect(h.notified).toEqual([]);

    // ...and the next stack picks the notice up through the single channel.
    const next = h.rebuild();
    h.port.ownership.clear();
    const summary = await next.recover();
    expect(summary.pendingNotices).toEqual([job.jobId]);
    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "notice picked up by the next stack");
    expect(h.notified.map((r) => r.jobId)).toEqual([job.jobId]);
  });
});

describe("bash job manager: recover (§3.6)", () => {
  it("adopts a verifiable running job, polls it and announces its exit", async () => {
    const h = await harness();
    await seed(h.store, "b_AVE00001", { status: "running", pid: 9101, spawnedAt: 600, command: "npm run build" });
    h.port.ownership.set(9101, "alive");

    const summary = await h.manager.recover();
    expect(summary).toMatchObject({ adopted: ["b_AVE00001"], exitedUnknown: [], orphaned: [], foreign: [] });
    // Adoption makes the job ownerless → notification eligible.
    expect(h.manager.get("b_AVE00001")?.backgroundedAt).toBe(1_000);

    // Still alive: the poll leaves it running.
    h.clock.advance(2_000);
    await settle();
    expect(h.manager.get("b_AVE00001")?.status).toBe("running");
    expect(h.notified).toEqual([]);

    h.port.ownership.set(9101, "dead");
    h.clock.advance(2_000);
    await waitFor(() => h.manager.get("b_AVE00001")?.status === "exited_unknown", "adopted job settled");
    expect((await h.store.load("b_AVE00001"))?.status).toBe("exited_unknown");

    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "adopted job notified");
    expect(h.notified.map((r) => r.jobId)).toEqual(["b_AVE00001"]);
  });

  it("marks a dead pid exited_unknown and an unverifiable one orphaned", async () => {
    const h = await harness();
    await seed(h.store, "b_DEAD0001", { status: "running", pid: 9102, spawnedAt: 600, backgroundedAt: 650 });
    await seed(h.store, "b_NSRE0001", { status: "running", pid: 9103, spawnedAt: 600, backgroundedAt: 650 });
    h.port.ownership.set(9102, "dead");
    h.port.ownership.set(9103, "unsafe");

    const summary = await h.manager.recover();
    expect(summary.exitedUnknown).toEqual(["b_DEAD0001"]);
    expect(summary.orphaned).toEqual(["b_NSRE0001"]);
    expect(summary.pendingNotices).toEqual(["b_DEAD0001"]);
    expect(h.port.killCalls).toEqual([]);

    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "dead job notified");
    await settle();
    // The orphan is displayed but never announced.
    expect(h.notified.map((r) => r.jobId)).toEqual(["b_DEAD0001"]);
    expect(h.manager.get("b_NSRE0001")?.status).toBe("orphaned");
  });

  it("leaves jobs owned by another live pi process untouched", async () => {
    const h = await harness();
    await seed(h.store, "b_FRGN0001", { status: "running", pid: 9104, spawnedAt: 600, hostPid: 777 });
    h.port.alivePids.add(777);
    h.port.ownership.set(9104, "alive");

    const summary = await h.manager.recover();
    expect(summary.foreign).toEqual(["b_FRGN0001"]);
    expect(summary.adopted).toEqual([]);
    expect(h.manager.get("b_FRGN0001")?.status).toBe("running");
    expect(h.manager.get("b_FRGN0001")?.backgroundedAt).toBeUndefined();

    // The dead-host case is adoptable instead.
    await seed(h.store, "b_DEADHST1", { status: "running", pid: 9105, spawnedAt: 600, hostPid: 778 });
    h.port.ownership.set(9105, "alive");
    const next = await h.manager.recover();
    expect(next.adopted).toEqual(["b_DEADHST1"]);
  });

  it("fails a staged job whose spawn outcome was lost with the previous process", async () => {
    const h = await harness();
    await seed(h.store, "b_STAGED01", { status: "staged" });
    const summary = await h.manager.recover();
    expect(summary.lostStaged).toEqual(["b_STAGED01"]);
    const stored = await h.store.load("b_STAGED01");
    expect(stored?.status).toBe("failed");
    expect(stored?.finalText).toMatch(/spawn was confirmed/);
    expect(shouldNotifyJob(stored as JobRecord)).toBe(false);
  });

  it("never adjudicates a job it created itself (recover racing a fresh create)", async () => {
    const h = await harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawnJob = h.port.spawnJob.bind(h.port);
    h.port.spawnJob = async (command, cwd, env) => {
      await gate;
      return spawnJob(command, cwd, env);
    };

    const creating = h.manager.create({ command: "npm test", cwd: "/repo" });
    // The `staged` record is on disk while the spawn is still in flight —
    // exactly what a session_start `recover()` scan can observe.
    await settle();
    const jobId = h.manager.list()[0]!.jobId;
    expect((await h.store.load(jobId))?.status).toBe("staged");

    const summary = await h.manager.recover();
    expect(summary.lostStaged).toEqual([]);
    expect((await h.store.load(jobId))?.status).toBe("staged");

    release();
    const job = await creating;
    // The real transition still applies: a mislabelled `failed` here would
    // reject it and leave a live process with no persisted pid.
    expect(h.manager.get(job.jobId)?.status).toBe("running");
    expect((await h.store.load(job.jobId))?.pid).toBe(job.pid);
  });

  it("prunes expired terminal jobs and skips corrupt records", async () => {
    const h = await harness({}, { retentionMs: 1_000 });
    const old = await seed(h.store, "b_EXPRD001", { status: "completed", exitCode: 0, endedAt: -10_000 });
    await seed(h.store, "b_FRESH001", { status: "completed", exitCode: 0, endedAt: 900 });
    await writeFile(join(h.dir, "b_BRKEN001.json"), "{not json", "utf8");

    const summary = await h.manager.recover();
    expect(summary.pruned).toEqual([old.jobId]);
    expect(h.manager.list().map((r) => r.jobId)).toEqual(["b_FRESH001"]);
    expect(h.warnings.some((w) => w.includes("b_BRKEN001"))).toBe(true);
    // The fake clock sits far behind the corrupt file's real mtime, so its age
    // is not computable and it is (deliberately) kept rather than guessed at.
    expect(summary.prunedFiles).toEqual([]);
  });

  it("reports swept non-record files in prunedFiles", async () => {
    const h = await harness();
    // The sweep judges nameless litter by file mtime (real wall-clock time), so
    // this case needs a clock that can outrun it — hence a store of its own.
    const clock = new FakeClock(Date.now());
    const store = createJobStore({ dir: h.dir, retentionMs: 1_000, clock, warn: (m) => h.warnings.push(m) });
    const manager = h.rebuild({ store, clock });
    await mkdir(h.dir, { recursive: true });
    await writeFile(join(h.dir, "b_0RPHAN11.log"), "left behind", "utf8");
    clock.advance(60_000);

    const summary = await manager.recover();
    expect(summary.prunedFiles).toEqual(["b_0RPHAN11.log"]);
    expect(summary.pruned).toEqual([]);
  });

  it("is safe to run twice (terminal states are sinks)", async () => {
    const h = await harness();
    await seed(h.store, "b_DEAD0002", { status: "running", pid: 9106, spawnedAt: 600, backgroundedAt: 650 });
    h.port.ownership.set(9106, "dead");
    const first = await h.manager.recover();
    const second = await h.manager.recover();
    expect(first.exitedUnknown).toEqual(["b_DEAD0002"]);
    expect(second.exitedUnknown).toEqual([]);
    expect(second.pendingNotices).toEqual(["b_DEAD0002"]);
    expect(h.manager.get("b_DEAD0002")?.endedAt).toBe(1_000);
  });

  // ── §2.5 step 4 linearization: an abort landing inside the transition /
  // patch phase (not just the prune phase) must not fold results, mutate
  // memory, rearm timers, or start any further store write. ─────────────────

  it("an abort mid-transition discards the in-flight write: no fold, no further writes, no timers", async () => {
    const h = await harness();
    await seed(h.store, "b_P0A00001", { status: "running", pid: 9301, spawnedAt: 600, backgroundedAt: 650 });
    await seed(h.store, "b_P0B00002", { status: "running", pid: 9302, spawnedAt: 600, backgroundedAt: 650 });
    await seed(h.store, "b_P0C00003", { status: "running", pid: 9303, spawnedAt: 600, backgroundedAt: 650 });
    h.port.ownership.set(9301, "dead");
    h.port.ownership.set(9302, "dead");
    h.port.ownership.set(9303, "dead");

    const controller = new AbortController();
    const realUpdate = h.store.update.bind(h.store);
    let writes = 0;
    h.store.update = (jobId: string, mutate: (record: JobRecord) => JobRecord | undefined) => {
      writes += 1;
      // The linearization point: abort fires while write #2 is between the
      // pre-call checkpoint and the actual fs round-trip (in flight).
      if (writes === 2) controller.abort();
      return realUpdate(jobId, mutate);
    };

    const summary = await h.manager.recover(controller.signal);
    expect(summary.partial).toBe(true);
    // Write #1 completed before the abort: folded and reported.
    expect(summary.exitedUnknown).toEqual(["b_P0A00001"]);
    expect(h.manager.get("b_P0A00001")?.status).toBe("exited_unknown");
    // Write #2 was in flight: allowed to settle on disk, but NOT folded —
    // the memory entry keeps its pre-abort state.
    expect((await h.store.load("b_P0B00002"))?.status).toBe("exited_unknown");
    expect(h.manager.get("b_P0B00002")?.status).toBe("running");
    // Record #3 was never reached: no memory entry, nothing queued for it.
    expect(h.manager.get("b_P0C00003")).toBeUndefined();
    // No further store writes after the abort point, and nothing rearmed.
    const afterAbort = writes;
    await settle();
    expect(writes).toBe(afterAbort);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("an abort mid-patch (adoption) discards the backgroundedAt fold the same way", async () => {
    const h = await harness();
    await seed(h.store, "b_P0D00004", { status: "running", pid: 9304, spawnedAt: 600 });
    await seed(h.store, "b_P0E00005", { status: "running", pid: 9305, spawnedAt: 600 });
    h.port.ownership.set(9304, "alive");
    h.port.ownership.set(9305, "alive");

    const controller = new AbortController();
    const realUpdate = h.store.update.bind(h.store);
    let writes = 0;
    h.store.update = (jobId: string, mutate: (record: JobRecord) => JobRecord | undefined) => {
      writes += 1;
      if (writes === 1) controller.abort(); // abort during the very first adoption patch
      return realUpdate(jobId, mutate);
    };

    const summary = await h.manager.recover(controller.signal);
    expect(summary.partial).toBe(true);
    expect(summary.adopted).toEqual([]);
    // The patch settled on disk but the fold was discarded: no backgroundedAt
    // in memory, so the job is not notification-eligible from this scan.
    expect((await h.store.load("b_P0D00004"))?.backgroundedAt).toBe(1_000);
    expect(h.manager.get("b_P0D00004")?.backgroundedAt).toBeUndefined();
    expect(h.manager.get("b_P0D00004")?.status).toBe("running");
    expect(h.manager.get("b_P0E00005")).toBeUndefined();
    const afterAbort = writes;
    await settle();
    expect(writes).toBe(afterAbort);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.notified).toEqual([]);
  });

  it("an abort landing between the identity check and the signal never kills the process (§2.5 step 4, subagent recovery)", async () => {
    // §3.9: `record.owner === "subagent"` routes through `kill(jobId, {}, aborted)`
    // inside recover(); for an adopted job (no local handle) that branch does
    // a synchronous `checkPidOwnership` immediately followed by
    // `processPort.killJobTree` — with zero `await` in between in today's
    // code, so nothing can flip `aborted()` in that exact window through a
    // *real* AbortSignal. The guard right before `killJobTree` is still the
    // correct defensive checkpoint (§2.5 step 4's "every I/O/signal-send
    // gated immediately before it" rule), and this test proves it by forcing
    // the interleaving directly in the identity check itself — exactly the
    // shape a future refactor (or another guarded caller) could reintroduce.
    const h = await harness();
    await seed(h.store, "b_P0F00006", { status: "running", pid: 9306, spawnedAt: 600, owner: "subagent" });
    const controller = new AbortController();
    const original = h.port.checkPidOwnership.bind(h.port);
    h.port.checkPidOwnership = (identity) => {
      const ownership = identity.pid === 9306 ? "alive" : original(identity);
      if (identity.pid === 9306) controller.abort(); // lands right after the identity check
      return ownership;
    };

    const summary = await h.manager.recover(controller.signal);
    expect(summary.partial).toBe(true);
    expect(summary.subagentKilled).toEqual([]);
    // No signal was ever sent — the guard caught it before `killJobTree`.
    expect(h.port.killCalls).toEqual([]);
    expect(h.manager.get("b_P0F00006")?.status).toBe("running");
    await settle();
    expect(h.port.killCalls).toEqual([]);
    expect(h.manager.get("b_P0F00006")?.status).toBe("running");
  });
});

describe("bash job manager: listing and lookups", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("lists jobs oldest first and exposes memory/disk lookups", async () => {
    const a = await h.manager.create({ command: "a", cwd: "/repo" });
    h.clock.advance(10);
    const b = await h.manager.create({ command: "b", cwd: "/repo" });
    expect(h.manager.list().map((r) => r.jobId)).toEqual([a.jobId, b.jobId]);
    expect(h.manager.get(a.jobId)?.command).toBe("a");
    expect((await h.manager.load(b.jobId))?.command).toBe("b");
    expect(h.manager.get("b_NPENPE99")).toBeUndefined();
    expect(await h.manager.load("b_NPENPE99")).toBeUndefined();
  });

  it("keeps live byte counters visible while the record on disk stays throttled", async () => {
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().stdout.write("12345");
    await settle();
    expect(h.manager.get(job.jobId)?.logBytes).toBe(5);
    // A disk read must not rewind the in-memory counter.
    expect((await h.manager.load(job.jobId))?.logBytes).toBe(5);
    expect((await h.store.load(job.jobId))?.logBytes).toBe(0);
  });
});

describe("transition guards", () => {
  it("warns instead of throwing when a terminal record is re-settled", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;

    // Simulate the /reload race: a stale closure tries to settle again.
    const stored = await h.store.load(job.jobId);
    expect(stored).toBeDefined();
    expect(transitionJob(stored as JobRecord, "killed", { at: 9_000 }).ok).toBe(false);
    await h.manager.kill(job.jobId);
    expect((await h.store.load(job.jobId))?.status).toBe("completed");
  });
});

describe("foreground record discard", () => {
  it("drops the record and log of a job that never reached the model", async () => {
    const h = await harness({ pollMs: 1_000, discardGraceMs: 5_000 });
    const job = await h.manager.create({ command: "echo hi", cwd: "/repo" });
    h.port.last().stdout.write("hi\n");
    h.port.last().exit({ exitCode: 0 });
    await job.exit;

    // Inside the grace the record is still fully readable.
    h.clock.advance(1_000);
    await settle();
    expect(h.manager.get(job.jobId)?.status).toBe("completed");
    expect((await h.manager.readOutput(job.jobId)).content).toContain("hi\n");

    h.clock.advance(5_000);
    await waitFor(() => h.manager.get(job.jobId) === undefined, "record discarded");
    expect(h.manager.list()).toHaveLength(0);
    expect(await h.store.load(job.jobId)).toBeUndefined();
    expect(
      await readFile(h.store.logPath(job.jobId), "utf8").then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    // A foreground job is never announced, so nothing was lost by dropping it.
    expect(h.notified).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("keeps a job backgrounded in the same tick as its exit (threshold race)", async () => {
    const h = await harness({ pollMs: 1_000, discardGraceMs: 0 });
    const job = await h.manager.create({ command: "sleep 300", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    // The threshold fires just after the process settled: the record must
    // survive, because the tool already handed its job_id to the model.
    await h.manager.markBackgrounded(job.jobId);

    h.clock.advance(1_000);
    await waitFor(() => h.notified.length === 1, "notification delivered");
    expect(h.manager.get(job.jobId)?.status).toBe("completed");
    expect(await h.store.load(job.jobId)).toBeDefined();
  });

  it("discards foreground leftovers of a previous process on recover", async () => {
    const h = await harness({ pollMs: 1_000, discardGraceMs: 5_000 });
    const stale = createJobRecord({
      jobId: "b_STAX0001",
      command: "echo leftover",
      cwd: "/repo",
      sessionId: "s0",
      hostPid: HOST_PID,
      logPath: h.store.logPath("b_STAX0001"),
      createdAt: 100,
    });
    const settled = transitionJob(stale, "running", { at: 150, pid: 6_001, pgid: 6_001 });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    const done = transitionJob(settled.record, "completed", { at: 200, exitCode: 0 });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    await h.store.save(done.record);
    await writeFile(h.store.logPath("b_STAX0001"), "leftover\n");

    const next = h.rebuild();
    await next.recover();
    h.clock.advance(5_000);
    await waitFor(() => next.get("b_STAX0001") === undefined, "leftover discarded");
    expect(await h.store.load("b_STAX0001")).toBeUndefined();
    expect(h.notified).toHaveLength(0);
  });
});

/**
 * §15 change C — a session that never reloads must still clean up. The sweep
 * rides on `create()` behind a throttle: no new timer, no blocking the spawn.
 */
describe("bash job manager: in-session retention sweep (§15)", () => {
  /** Counts sweeps and lets a test make the sweep fail. */
  interface Counting {
    readonly store: JobStore;
    calls(): number;
    fail(error: Error): void;
  }
  function countingStore(store: JobStore): Counting {
    let calls = 0;
    let failure: Error | undefined;
    return {
      store: {
        ...store,
        pruneExpired: (pruneOptions) => {
          calls++;
          return failure ? Promise.reject(failure) : store.pruneExpired(pruneOptions);
        },
      },
      calls: () => calls,
      fail: (error) => {
        failure = error;
      },
    };
  }

  it("sweeps once per interval across back-to-back creates, then again after the interval", async () => {
    const h = await harness();
    const counting = countingStore(h.store);
    const manager = h.rebuild({ store: counting.store, sweepIntervalMs: 600_000 });

    await manager.create({ command: "a", cwd: "/repo" });
    await manager.create({ command: "b", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(1);

    // Still inside the window.
    h.clock.advance(599_000);
    await manager.create({ command: "c", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(1);

    h.clock.advance(1_000);
    await manager.create({ command: "d", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(2);
  });

  it("adds no timer of its own (the poll timer stays the only one)", async () => {
    const h = await harness();
    const counting = countingStore(h.store);
    const manager = h.rebuild({ store: counting.store, sweepIntervalMs: 1_000 });

    await manager.create({ command: "a", cwd: "/repo" });
    await settle();
    const armed = h.clock.pendingTimers;
    expect(armed).toBe(1); // the notification poll

    h.clock.advance(2_000);
    await manager.create({ command: "b", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(2);
    expect(h.clock.pendingTimers).toBe(armed);
  });

  it("never lets a failing sweep break create()", async () => {
    const h = await harness();
    const counting = countingStore(h.store);
    counting.fail(new Error("disk on fire"));
    const manager = h.rebuild({ store: counting.store });

    const job = await manager.create({ command: "npm test", cwd: "/repo" });
    await settle();
    expect(manager.get(job.jobId)?.status).toBe("running");
    expect(counting.calls()).toBe(1);
    expect(h.warnings.some((w) => w.includes("retention sweep failed") && w.includes("disk on fire"))).toBe(true);
  });

  it("treats a live job's log as tracked, never as an orphan", async () => {
    const h = await harness();
    const seen: (((jobId: string) => boolean) | undefined)[] = [];
    const store: JobStore = {
      ...h.store,
      pruneExpired: (pruneOptions) => {
        seen.push(pruneOptions?.isTracked);
        return h.store.pruneExpired(pruneOptions);
      },
    };
    const manager = h.rebuild({ store });
    const job = await manager.create({ command: "npm test", cwd: "/repo" });
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.(job.jobId)).toBe(true);
    expect(seen[0]?.("b_M1SS1NG1")).toBe(false);
  });
});

/**
 * Change B — the log is self-contained: its last line states the outcome, so
 * `tail -3 <log>` answers "how did this end?" without a tool call.
 */
describe("bash job manager: terminal log footer (change B)", () => {
  it("appends exactly one footer line, counted in logBytes, on a normal exit", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "echo hi", cwd: "/repo" });
    h.port.last().stdout.write("hi\n");
    await settle();
    h.clock.advance(2_000);
    h.port.last().exit({ exitCode: 0 });
    const final = await job.exit;

    const log = await readFile(job.logPath, "utf8");
    expect(log).toBe(
      `hi\n${formatJobLogFooter({ jobId: job.jobId, status: "completed", exitCode: 0, duration: "2s" })}\n`,
    );
    expect(final.logBytes).toBe(Buffer.byteLength(log, "utf8"));
    expect((await h.store.load(job.jobId))?.logBytes).toBe(final.logBytes);

    // Idempotent: a repeated terminal settlement must not write a second line.
    h.port.last().exit({ exitCode: 0 });
    await settle();
    expect(await readFile(job.logPath, "utf8")).toBe(log);
    expect((log.match(/\[pi-subagent\]/g) ?? []).length).toBe(1);
  });

  it("starts the footer on its own line when the output has no trailing newline", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "printf x", cwd: "/repo" });
    h.port.last().stdout.write("no-newline");
    await settle();
    h.port.last().exit({ exitCode: 1 });
    await job.exit;
    const lines = (await readFile(job.logPath, "utf8")).split("\n");
    expect(lines[0]).toBe("no-newline");
    expect(lines[1]).toBe(formatJobLogFooter({ jobId: job.jobId, status: "failed", exitCode: 1, duration: "0ms" }));
  });

  it.each([
    ["killed", { signal: "SIGTERM" as const, exitCode: null }, /killed after/],
    ["timed out", { signal: "SIGKILL" as const, exitCode: null }, /timed out after/],
  ])("writes no invented exit code for a %s job", async (label, exit, expected) => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 300", cwd: "/repo" });
    h.manager.noteTermination(job.jobId, label === "killed" ? "killed" : "timed_out");
    h.port.last().exit(exit);
    await job.exit;
    const log = await readFile(job.logPath, "utf8");
    expect(log).toMatch(expected);
    expect(log).not.toMatch(/exit /);
  });

  it("is visible to readOutput, which sees exactly what the file holds", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "echo done", cwd: "/repo" });
    h.port.last().stdout.write("done\n");
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    const read = await h.manager.readOutput(job.jobId, { offset: 0, advanceCursor: false });
    expect(read.content).toBe(await readFile(job.logPath, "utf8"));
    expect(read.content.trimEnd().endsWith(`job ${job.jobId} completed (exit 0) after 0ms`)).toBe(true);
    expect(read.logBytes).toBe(Buffer.byteLength(read.content, "utf8"));
  });
});

// ── bash-timeout-grace plan §2.3–§2.5 (P3): job-level deadlines, the shared
// write chain's manager-side consumers, and cancellable spawn/recovery ──────

/** A `JobStore` whose named methods can be told to never settle, on demand. */
function makeHangableStore(real: JobStore): {
  store: JobStore;
  hang: { save: boolean; update: boolean; upsert: boolean; loadAll: boolean; pruneExpired: boolean };
} {
  const hang = { save: false, update: false, upsert: false, loadAll: false, pruneExpired: false };
  const store: JobStore = {
    ...real,
    save: (record) => (hang.save ? new Promise<void>(() => {}) : real.save(record)),
    update: (jobId, mutate) =>
      hang.update ? new Promise<JobRecord | undefined>(() => {}) : real.update(jobId, mutate),
    upsert: (jobId, mutate) =>
      hang.upsert ? new Promise<JobRecord | undefined>(() => {}) : real.upsert(jobId, mutate),
    loadAll: () => (hang.loadAll ? new Promise<JobRecord[]>(() => {}) : real.loadAll()),
    pruneExpired: (options) =>
      hang.pruneExpired ? new Promise<{ jobs: string[]; files: string[] }>(() => {}) : real.pruneExpired(options),
  };
  return { store, hang };
}

const FAST_POLICY: JobDeadlinePolicy = { graceMs: 500, maxExtensions: 2, maxTimeoutFactor: 5 };
const NO_GRACE_POLICY: JobDeadlinePolicy = { graceMs: 0, maxExtensions: 2, maxTimeoutFactor: 5 };
const NO_EXTEND_POLICY: JobDeadlinePolicy = { graceMs: 500, maxExtensions: 0, maxTimeoutFactor: 5 };

/** Installs a `process.on("unhandledRejection")` guard for the duration of a describe block. */
function trackUnhandledRejections(): { count(): number } {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  beforeEach(() => {
    seen.length = 0;
    process.on("unhandledRejection", onRejection);
  });
  afterEach(() => {
    process.removeListener("unhandledRejection", onRejection);
  });
  return { count: () => seen.length };
}

describe("bash job manager: job-level deadlines (§2.3, T9)", () => {
  it("kills a still-foreground job immediately when its deadline fires (U5: no grace while foreground)", async () => {
    const h = await harness({ deadlinePolicy: FAST_POLICY });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    // Never backgrounded — the job is still "foreground" from the deadline's point of view.
    h.clock.advance(1_000);
    expect(h.port.killCalls).toHaveLength(1);
    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    await job.exit;
    expect(h.manager.get(job.jobId)?.status).toBe("timed_out");
  });

  it("enters grace exactly once, notifies once, then kills on grace expiry", async () => {
    const notifications: { record: JobRecord; kind: "grace" | "extended" }[] = [];
    const h = await harness({
      deadlinePolicy: FAST_POLICY,
      onDeadline: (record, kind) => notifications.push({ record, kind }),
    });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);

    h.clock.advance(1_000); // reach dueAt (2000)
    expect(h.port.killCalls).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.kind).toBe("grace");
    expect(h.manager.get(job.jobId)?.deadline?.graceUntil).toBe(2_500);
    expect(h.manager.get(job.jobId)?.deadline?.graces).toBe(1);
    expect(h.manager.get(job.jobId)?.deadline?.graceNotified).toBe(1);

    h.clock.advance(500); // reach graceUntil (2500)
    expect(h.port.killCalls).toHaveLength(1);
    // Grace notification is deduplicated to exactly one for this episode.
    expect(notifications.filter((n) => n.kind === "grace")).toHaveLength(1);
    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    await job.exit;
    expect(h.manager.get(job.jobId)?.status).toBe("timed_out");
  });

  it("D-6: maxExtensions=0 disables grace too — a backgrounded job is killed outright at dueAt", async () => {
    const notifications: string[] = [];
    const h = await harness({
      deadlinePolicy: NO_EXTEND_POLICY,
      onDeadline: (_record, kind) => notifications.push(kind),
    });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    h.clock.advance(1_000);
    expect(h.port.killCalls).toHaveLength(1);
    expect(notifications).toEqual([]);
  });
});

describe("bash job manager: deadline race matrix (T10)", () => {
  it("R4: a natural exit racing the due timer wins — never relabelled timed_out", async () => {
    const h = await harness({ deadlinePolicy: FAST_POLICY });
    const job = await h.manager.create({ command: "npm test", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    expect(h.manager.get(job.jobId)?.status).toBe("completed");
    // The due timer would have fired at t=2000 and the grace timer at t=2500;
    // advancing well past both must not touch the already-terminal job.
    h.clock.advance(10_000);
    expect(h.port.killCalls).toHaveLength(0);
    expect(h.manager.get(job.jobId)?.status).toBe("completed");
  });

  it("extend() reschedules the due timer — the old dueAt no longer kills, the new one does", async () => {
    const h = await harness({ deadlinePolicy: NO_GRACE_POLICY });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    const outcome = await h.manager.extend(job.jobId, 5_000);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.record.deadline?.dueAt).toBe(6_000); // capped at hardAt

    h.clock.advance(1_000); // the old dueAt (2000) — must not kill
    expect(h.port.killCalls).toHaveLength(0);

    h.clock.advance(4_000); // now at 6000 == hardAt, no grace (policy) => kill
    expect(h.port.killCalls).toHaveLength(1);
  });

  describe("spawn-window cancellation (R12)", () => {
    const guard = trackUnhandledRejections();

    it("cancelReserve during 'persisting' kills synchronously in memory and never spawns", async () => {
      const h = await harness();
      const { jobId, started } = h.manager.reserve({ command: "sleep 1", cwd: "/repo" });
      // No `await` has happened yet — reserve()'s async flow is still
      // suspended at its first `await` (E33), so this observes stage "persisting".
      h.manager.cancelReserve(jobId);
      const result = await started;
      expect(result.ok).toBe(false);
      expect(h.manager.get(jobId)?.status).toBe("killed");
      expect(h.port.spawns).toHaveLength(0);
      expect(guard.count()).toBe(0);
    });

    it("cancelReserve during 'spawning' (pid not yet known) kills the process once the pid returns", async () => {
      const h = await harness();
      let spawnEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        spawnEntered = resolve;
      });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realSpawn = h.port.spawnJob.bind(h.port);
      h.port.spawnJob = async (command, cwd, env) => {
        spawnEntered();
        await gate;
        return realSpawn(command, cwd, env);
      };
      const { jobId, started } = h.manager.reserve({ command: "sleep 1", cwd: "/repo" });
      await entered; // deterministically at stage "spawning": spawnJob was called and is now gated
      expect(h.manager.get(jobId)?.status).toBe("staged");
      h.manager.cancelReserve(jobId);
      release();
      const result = await started;
      expect(result.ok).toBe(false);
      expect(h.port.spawns).toHaveLength(1);
      // R12: the cancel-after-spawn path calls `processPort.killJobTree` directly
      // (graceMs 0), not through `kill()` — same FakePort bookkeeping either way.
      expect(h.port.killCalls).toHaveLength(1);
      expect(h.port.killCalls[0]?.options?.graceMs).toBe(0);
      h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
      await waitFor(() => h.manager.get(jobId)?.status === "killed", "cancelled-after-spawn finalization");
      expect(guard.count()).toBe(0);
    });

    it("cancelReserve after 'running' behaves like kill()", async () => {
      const h = await harness();
      const job = await h.manager.create({ command: "sleep 100", cwd: "/repo" });
      h.manager.cancelReserve(job.jobId);
      expect(h.port.killCalls).toHaveLength(1);
      h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
      await job.exit;
      expect(h.manager.get(job.jobId)?.status).toBe("killed");
      expect(guard.count()).toBe(0);
    });

    it("cancelReserve on an unknown jobId is a total no-op", async () => {
      const h = await harness();
      expect(() => h.manager.cancelReserve("b_MISSING1")).not.toThrow();
    });
  });
});

describe("bash job manager: I/O permanently hung (T11)", () => {
  it("reserve().started resolves {ok:false} after 30s when the staged save never settles, and never spawns", async () => {
    const h = await harness();
    const { store: hangStore, hang } = makeHangableStore(h.store);
    const manager = h.rebuild({ store: hangStore });
    hang.save = true;
    const { jobId, started } = manager.reserve({ command: "sleep 1", cwd: "/repo" });
    h.clock.advance(STAGE_PERSIST_TIMEOUT_MS);
    const result = await started;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/did not persist the staged record within 30s/);
    expect(h.port.spawns).toHaveLength(0);
    expect(manager.get(jobId)?.status).toBe("failed");
    // The late-arriving save is still queued behind on the store's chain and
    // will eventually land, but by then `failed` is what the chain writes
    // last (the update enqueued after it) — spawning is what must never happen.
    hang.save = false;
  });

  it("extend() waits at most 2s for the disk write and reports persistPending on timeout", async () => {
    const h = await harness({ deadlinePolicy: NO_GRACE_POLICY });
    const { store: hangStore, hang } = makeHangableStore(h.store);
    const manager = h.rebuild({ store: hangStore });
    const job = await manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await manager.markBackgrounded(job.jobId);
    hang.upsert = true;
    const pending = manager.extend(job.jobId, 5_000);
    h.clock.advance(EXTEND_PERSIST_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.persistPending).toBe(true);
      expect(outcome.record.deadline?.dueAt).toBe(6_000); // in-memory effect is immediate regardless
    }
    hang.upsert = false;
  });

  it("dispose() clears every deadline timer — no further kill after disposal even if time passes", async () => {
    const h = await harness({ deadlinePolicy: FAST_POLICY });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    h.manager.dispose();
    managers.splice(managers.indexOf(h.manager), 1); // avoid double-dispose in afterEach
    h.clock.advance(10_000);
    expect(h.port.killCalls).toHaveLength(0);
  });

  it("R9: putRecord/load never regresses a higher-seq in-memory deadline", async () => {
    const h = await harness({ deadlinePolicy: NO_GRACE_POLICY });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    const extended = await h.manager.extend(job.jobId, 500);
    expect(extended.ok).toBe(true);
    expect(h.manager.get(job.jobId)?.deadline?.seq).toBe(1);

    // Simulate a stale write landing on disk (e.g. a late old-manager write, R11):
    // the same record but with the pre-extend deadline (seq 0).
    const current = await h.store.load(job.jobId);
    const stale: JobRecord = { ...current!, deadline: { ...current!.deadline!, dueAt: 2_000, seq: 0 } };
    await h.store.save(stale);

    const reloaded = await h.manager.load(job.jobId);
    expect(reloaded?.deadline?.seq).toBe(1);
    expect(reloaded?.deadline?.dueAt).toBe(2_500);
    expect(h.manager.get(job.jobId)?.deadline?.seq).toBe(1);
  });
});

describe("bash job manager: reload continuity (T12)", () => {
  it("adoptLocalJobs rearms an already-due job synchronously and kills it with zero extra I/O wait", async () => {
    const h = await harness({ deadlinePolicy: FAST_POLICY });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    const handoffs = h.manager.exportLocalJobs();
    h.clock.advance(10_000); // past dueAt, hardAt and any grace window
    const next = h.rebuild();
    next.adoptLocalJobs(handoffs);
    // Synchronous: no `await` happened between adopt and this assertion.
    expect(h.port.killCalls).toHaveLength(1);
    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    await waitFor(() => next.get(job.jobId)?.status === "timed_out", "adopted job's deadline finalization");
  });

  it("adoptLocalJobs does not duplicate the grace notification across a handoff (R6)", async () => {
    const notifications: string[] = [];
    const h = await harness({ deadlinePolicy: FAST_POLICY, onDeadline: (_r, kind) => notifications.push(kind) });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    h.clock.advance(1_000); // enters grace on the old manager
    expect(notifications).toEqual(["grace"]);

    const handoffs = h.manager.exportLocalJobs();
    const next = h.rebuild({ onDeadline: (_r, kind) => notifications.push(kind) });
    next.adoptLocalJobs(handoffs);
    expect(notifications).toEqual(["grace"]); // adopting mid-grace does not re-notify
    expect(next.get(job.jobId)?.deadline?.graceUntil).toBe(2_500);

    h.clock.advance(500); // graceUntil reached on the new manager
    expect(h.port.killCalls).toHaveLength(1);
    expect(notifications).toEqual(["grace"]);
  });

  it("extend() works immediately after adoption", async () => {
    const h = await harness({ deadlinePolicy: NO_GRACE_POLICY });
    const job = await h.manager.create({ command: "sleep 100", cwd: "/repo", timeoutMs: 1_000 });
    await h.manager.markBackgrounded(job.jobId);
    const handoffs = h.manager.exportLocalJobs();
    const next = h.rebuild();
    next.adoptLocalJobs(handoffs);
    const outcome = await next.extend(job.jobId, 1_000);
    expect(outcome.ok).toBe(true);
  });

  it("relocateLog updates the in-memory logPath and persists it through this manager's own store chain", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "path", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    // Mirrors real usage (`handoffInProcess`, §2.5 step 3): the manager calling
    // `relocateLog` already owns a store pointed at the job's *new* directory
    // — the method repoints `logPath`, it does not itself move directories.
    const newLogPath = join(h.dir, "relocated", `${job.jobId}.log`);
    await h.manager.relocateLog(job.jobId, newLogPath);
    expect(h.manager.get(job.jobId)?.logPath).toBe(newLogPath);
    const onDisk = await h.store.load(job.jobId);
    expect(onDisk?.logPath).toBe(newLogPath);
  });
});

describe("bash job manager: seal / reserve (T13)", () => {
  const guard = trackUnhandledRejections();

  it("reserve() throws synchronously when admit() refuses, and spawns nothing", async () => {
    const h = await harness({ admit: () => false });
    expect(() => h.manager.reserve({ command: "sleep 1", cwd: "/repo" })).toThrow(/run is ending/);
    expect(h.port.spawns).toHaveLength(0);
  });

  it("reserve() throws 'stale bash job manager' after dispose()", async () => {
    const h = await harness();
    h.manager.dispose();
    managers.splice(managers.indexOf(h.manager), 1);
    expect(() => h.manager.reserve({ command: "sleep 1", cwd: "/repo" })).toThrow(/stale bash job manager/);
  });

  it("extend() throws 'stale bash job manager' after dispose()", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 1", cwd: "/repo", timeoutMs: 1_000 });
    h.manager.dispose();
    managers.splice(managers.indexOf(h.manager), 1);
    await expect(h.manager.extend(job.jobId, 500)).rejects.toThrow(/stale bash job manager/);
  });

  it("admit() refusing mid-flow (sealed after reserve, before spawn) kills without spawning — never rejects", async () => {
    const h = await harness();
    let sealed = false;
    const manager = h.rebuild({ admit: () => !sealed });
    const { jobId, started } = manager.reserve({ command: "sleep 1", cwd: "/repo" });
    sealed = true;
    const result = await started;
    expect(result.ok).toBe(false);
    expect(manager.get(jobId)?.status).toBe("killed");
    expect(h.port.spawns).toHaveLength(0);
    expect(guard.count()).toBe(0);
  });

  it("started never rejects even when spawnJob throws", async () => {
    const h = await harness();
    h.port.spawnError = new Error("spawn bash ENOENT");
    const { started } = h.manager.reserve({ command: "cmd", cwd: "/nope" });
    const result = await started;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/ENOENT/);
    expect(guard.count()).toBe(0);
  });

  // ── §3.6 P4 follow-up: cancelReserve's abort-time kill is synchronous ───────
  // (the plan's own wording), so a same-tick dispose()/reload-handoff/seal
  // can never race it into a no-op (leak) or observe it as "not yet sent".

  it("cancelReserve signals synchronously; a same-tick dispose() neither re-signals nor drops the eventual exit (no leak)", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 600", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.manager.cancelReserve(job.jobId);
    // The signal is already in flight, synchronously, by the time
    // cancelReserve() returns — dispose() (R8: clears timers/waiters only,
    // never signals a process, §3.7) cannot race it into a no-op.
    expect(h.port.killCalls).toHaveLength(1);
    h.manager.dispose();
    managers.splice(managers.indexOf(h.manager), 1); // avoid double-dispose in afterEach
    expect(h.port.killCalls).toHaveLength(1); // dispose() itself never signals
    // The process still dies from that one signal; the exit event is
    // processed normally even after dispose() — nothing is leaked.
    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    const record = await job.exit;
    expect(record.status).toBe("killed");
  });

  it("cancelReserve signals synchronously; a same-tick reload handoff still settles the job exactly once in the next manager (no leak)", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 600", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.manager.cancelReserve(job.jobId);
    expect(h.port.killCalls).toHaveLength(1);
    // Same tick: the reload handoff runs immediately after — the signal was
    // already sent before `exportLocalJobs()` even starts, so it cannot see
    // (and delete) the entry before the signal goes out.
    const handoffs = h.manager.exportLocalJobs();
    expect(handoffs).toHaveLength(1);
    const next = h.rebuild();
    next.adoptLocalJobs(handoffs);
    expect(h.port.killCalls).toHaveLength(1); // still exactly one signal
    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    await waitFor(() => next.get(job.jobId)?.status === "killed", "the handed-off job to settle killed");
    expect(next.get(job.jobId)?.status).toBe("killed");
  });

  it("cancelReserve signals synchronously; a same-tick explicit kill() (a seal/killAll fan-out hitting the same job) still settles it exactly once", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 600", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.manager.cancelReserve(job.jobId);
    // A concurrent "seal" kill (e.g. a session-shutdown killAll fan-out)
    // targeting the same job in the same tick — SIGTERM is idempotent
    // (§3.3/process.ts), so a second signal is harmless; what matters is
    // that the job still settles to exactly one terminal state, with no
    // throw and no leak.
    await h.manager.kill(job.jobId).catch(() => undefined);
    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    const record = await job.exit;
    expect(record.status).toBe("killed");
    expect(h.manager.get(job.jobId)?.status).toBe("killed");
  });
});

describe("bash job manager: recover() §3.9 subagent branch (T14)", () => {
  it("owner:subagent staged job is failed, same as a generic staged job", async () => {
    const h = await harness();
    await seed(h.store, "b_AGT00001", { status: "staged", owner: "subagent" });
    const summary = await h.manager.recover();
    expect(summary.lostStaged).toEqual(["b_AGT00001"]);
    expect(summary.subagentKilled).toEqual([]);
  });

  it("owner:subagent running+verified-alive job is actively killed (not merely adopted)", async () => {
    const h = await harness();
    await seed(h.store, "b_AGT00002", { status: "running", pid: 9201, spawnedAt: 600, owner: "subagent" });
    h.port.ownership.set(9201, "alive");
    h.port.killOutcome = "terminated";
    const summary = await h.manager.recover();
    expect(summary.subagentKilled).toEqual(["b_AGT00002"]);
    expect(h.port.killCalls.map((c) => c.pid)).toContain(9201);
    expect(h.manager.get("b_AGT00002")?.status).toBe("killed");
    expect(
      h.warnings.some((w) => w.includes("1 subagent bash jobs") && w.includes("1 killed") && w.includes("0 orphaned")),
    ).toBe(true);
  });

  it("owner:subagent alive-but-kill-refused job becomes orphaned, never signalled twice", async () => {
    const h = await harness();
    await seed(h.store, "b_AGT00003", { status: "running", pid: 9202, spawnedAt: 600, owner: "subagent" });
    h.port.ownership.set(9202, "alive");
    h.port.killOutcome = "refused";
    const summary = await h.manager.recover();
    expect(summary.orphaned).toEqual(["b_AGT00003"]);
    expect(summary.subagentKilled).toEqual([]);
    expect(h.manager.get("b_AGT00003")?.status).toBe("orphaned");
  });

  it("owner:subagent dead-pid job becomes exited_unknown (no signal sent)", async () => {
    const h = await harness();
    await seed(h.store, "b_AGT00004", { status: "running", pid: 9203, spawnedAt: 600, owner: "subagent" });
    h.port.ownership.set(9203, "dead");
    const summary = await h.manager.recover();
    expect(summary.exitedUnknown).toEqual(["b_AGT00004"]);
    expect(h.port.killCalls).toHaveLength(0);
  });

  it("owner:subagent unverifiable-identity job becomes orphaned without ever signalling", async () => {
    const h = await harness();
    await seed(h.store, "b_AGT00005", { status: "running", pid: 9204, spawnedAt: 600, owner: "subagent" });
    // FakePort's checkPidOwnership defaults unknown pids to "dead"; force "unsafe" explicitly.
    const original = h.port.checkPidOwnership.bind(h.port);
    h.port.checkPidOwnership = (identity) => (identity.pid === 9204 ? "unsafe" : original(identity));
    const summary = await h.manager.recover();
    expect(summary.orphaned).toEqual(["b_AGT00005"]);
    expect(h.port.killCalls).toHaveLength(0);
  });

  it("recover(signal) aborted up front returns an empty, partial summary and touches nothing", async () => {
    const h = await harness();
    await seed(h.store, "b_PREAB0001", { status: "running", pid: 9205, spawnedAt: 600 });
    h.port.ownership.set(9205, "alive");
    const controller = new AbortController();
    controller.abort();
    const summary = await h.manager.recover(controller.signal);
    expect(summary.partial).toBe(true);
    expect(summary.adopted).toEqual([]);
    expect(h.manager.list()).toEqual([]);
  });

  it("recover(signal) aborted while pruneExpired is still in flight skips loadAll entirely", async () => {
    const h = await harness();
    const { store: hangStore, hang } = makeHangableStore(h.store);
    const manager = h.rebuild({ store: hangStore });
    let releasePrune: (result: { jobs: string[]; files: string[] }) => void = () => {};
    const gate = new Promise<{ jobs: string[]; files: string[] }>((resolve) => {
      releasePrune = resolve;
    });
    const realPrune = h.store.pruneExpired.bind(h.store);
    hangStore.pruneExpired = (opts) => {
      void realPrune(opts);
      return gate;
    };
    void hang; // silence unused-destructure lint; other fields intentionally unused here
    const controller = new AbortController();
    const pending = manager.recover(controller.signal);
    controller.abort();
    releasePrune({ jobs: ["b_ALREADY1"], files: [] });
    const summary = await pending;
    expect(summary.partial).toBe(true);
    expect(summary.pruned).toEqual(["b_ALREADY1"]);
    expect(manager.list()).toEqual([]);
  });
});
