import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createBashJobManager, type BashJobManager } from "../../src/bash/manager.js";
import { createJobStore } from "../../src/bash/job-store.js";
import type {
  JobExit,
  KillJobTreeOptions,
  KillOutcome,
  PidIdentity,
  PidOwnership,
  ProcessPort,
  SpawnedJob,
} from "../../src/bash/process.js";
import { FakeClock } from "../../src/core/clock.js";
import { killAllNonTerminal } from "../../src/bash/child.js";

/**
 * bash-timeout-grace plan §3.3 S2 (P5b, item 3): dedicated race coverage for
 * `killAllNonTerminal`'s `staged` branch (`src/bash/child.ts`) — the piece
 * that routes a still-spawning job through `cancelReserve` + `waitExit`
 * instead of `manager.kill()` (§2.4 R12: a plain `kill()` on a `staged`
 * entry would stamp a stale terminal record while the real spawn is still
 * resolving, racing R12's own "pid returned ⇒ check cancelled" check).
 *
 * `manager.cancelReserve()` itself is already exhaustively raced at the
 * manager level (`tests/bash/manager.test.ts`'s "spawn-window cancellation
 * (R12)" — persisting/spawning/running/unknown). What is NOT covered there
 * is `killAllNonTerminal`'s OWN bucketing (`killed`/`alreadyDone`/`orphaned`/
 * `pending`) when called DURING that race, and — the concrete ask here —
 * that a pid which DOES eventually surface after the cancel is always
 * killed, never left running.
 *
 * The process boundary is faked (mirrors `manager.test.ts`), so "no leaked
 * process" is verified through the fake's own bookkeeping
 * (`port.killCalls` covering every `port.spawns` pid) rather than a real
 * `probePid` — `tests/integration/child-bash-jobs-process.test.ts` already
 * covers the real-process side of `sealAndKill` end-to-end.
 */

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
  constructor(readonly pid: number) {}

  get spawned(): SpawnedJob {
    return {
      pid: this.pid,
      pgid: this.pid,
      stdout: this.stdout,
      stderr: this.stderr,
      processExitPromise: this.processExitPromise,
      drainedPromise: this.drainedPromise,
    };
  }

  exitOnly(exit: Partial<JobExit> = {}): void {
    if (this.lastExit) return;
    this.lastExit = { exitCode: 0, signal: null, ...exit };
    this.settleExit(this.lastExit);
  }

  exit(exit: Partial<JobExit> = {}): void {
    this.exitOnly(exit);
    this.stdout.end();
    this.stderr.end();
    this.settleDrain({ exit: this.lastExit!, stop: "ended" });
  }
}

class FakePort implements ProcessPort {
  readonly procs: FakeProc[] = [];
  readonly spawns: { command: string; cwd: string }[] = [];
  readonly killCalls: { pid: number; options?: KillJobTreeOptions }[] = [];
  killOutcome: KillOutcome = "terminated";
  nextPid = 9000;
  readonly alivePids = new Set<number>();
  /** Test hook: gate `spawnJob` so a test can deterministically land in the "spawning" sub-state. */
  spawnGate: (() => Promise<void>) | undefined;
  onSpawnEntered: (() => void) | undefined;

  async spawnJob(command: string, cwd: string): Promise<SpawnedJob> {
    this.onSpawnEntered?.();
    if (this.spawnGate) await this.spawnGate();
    this.spawns.push({ command, cwd });
    const proc = new FakeProc(this.nextPid++);
    this.procs.push(proc);
    this.alivePids.add(proc.pid);
    return proc.spawned;
  }

  async killJobTree(pid: number, options?: KillJobTreeOptions): Promise<KillOutcome> {
    this.killCalls.push({ pid, ...(options !== undefined ? { options } : {}) });
    this.alivePids.delete(pid);
    return this.killOutcome;
  }

  probePid(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  readProcStartTime(): string | undefined {
    return undefined;
  }

  checkPidOwnership(identity: PidIdentity): PidOwnership {
    return identity.pid === undefined ? "dead" : this.alivePids.has(identity.pid) ? "alive" : "dead";
  }

  last(): FakeProc {
    const proc = this.procs[this.procs.length - 1];
    if (!proc) throw new Error("no fake process spawned");
    return proc;
  }
}

const managers: BashJobManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

async function harness(): Promise<{ manager: BashJobManager; port: FakePort; clock: FakeClock; warnings: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-kill-all-staged-"));
  const clock = new FakeClock(1_000);
  const port = new FakePort();
  const warnings: string[] = [];
  const store = createJobStore({
    dir: join(root, "jobs"),
    retentionMs: 86_400_000,
    clock,
    warn: (m) => warnings.push(m),
  });
  const manager = createBashJobManager({
    store,
    processPort: port,
    clock,
    sessionId: "s1",
    hostPid: 4242,
    warn: (m) => warnings.push(m),
  });
  managers.push(manager);
  return { manager, port, clock, warnings };
}

describe("killAllNonTerminal — staged race (§3.3 S2, item 3)", () => {
  it("staged(persisting): cancelled before any spawn ever happens — unique terminal state, no process, bucketed as killed", async () => {
    const { manager, port } = await harness();
    // No `await` yet — `reserve()`'s async flow is suspended at its own
    // first `await` (E33), so this call synchronously observes "persisting".
    const { jobId } = manager.reserve({ command: "sleep 30", cwd: "/repo" });
    expect(manager.get(jobId)?.status).toBe("staged");

    const report = await killAllNonTerminal(manager, 200);

    expect(report).toEqual({ killed: [jobId], alreadyDone: [], orphaned: [], pending: [] });
    expect(manager.get(jobId)?.status).toBe("killed");
    expect(port.spawns).toHaveLength(0); // never spawned ⇒ trivially "no leaked process"
    expect(port.killCalls).toHaveLength(0); // nothing to signal — it never existed

    // A second killAllNonTerminal (idempotent seal/killAll fan-out) must not
    // flip the already-terminal record or double-count it — the top-level
    // `!isTerminalJobStatus` filter excludes it from every bucket entirely.
    const again = await killAllNonTerminal(manager, 200);
    expect(again).toEqual({ killed: [], alreadyDone: [], orphaned: [], pending: [] });
    expect(manager.get(jobId)?.status).toBe("killed");
  });

  it("staged(spawning): killAllNonTerminal races a real pid surfacing AFTER the cancel — the pid is always killed, never leaked", async () => {
    const { manager, port } = await harness();
    let spawnEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      spawnEntered = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    port.onSpawnEntered = spawnEntered;
    port.spawnGate = () => gate;

    const { jobId } = manager.reserve({ command: "sleep 30", cwd: "/repo" });
    await entered; // deterministically at stage "spawning": spawnJob was called and is now gated on `release()`
    expect(manager.get(jobId)?.status).toBe("staged");

    // killAllNonTerminal starts its race WHILE the pid is still unknown.
    const reportPromise = killAllNonTerminal(manager, 200);
    // The real spawn resolves with a pid only AFTER killAllNonTerminal has
    // already called cancelReserve (that call is synchronous inside the
    // `staged` branch, so by the time this line runs the cancellation flag
    // is already set — mirrors manager.test.ts's own "spawning" race).
    release();
    // R12's synchronous "pid returned ⇒ check cancelled" check fires the
    // real kill; simulate the process actually dying from that signal.
    await new Promise((resolve) => setImmediate(resolve));
    expect(port.spawns).toHaveLength(1); // the pid DID surface
    expect(port.killCalls).toHaveLength(1); // …and was immediately signalled — never left running
    expect(port.killCalls[0]?.pid).toBe(port.last().pid);
    port.last().exit({ exitCode: null, signal: "SIGTERM" });

    const report = await reportPromise;
    expect(report).toEqual({ killed: [jobId], alreadyDone: [], orphaned: [], pending: [] });
    expect(manager.get(jobId)?.status).toBe("killed"); // unique terminal state
    expect(port.probePid(port.last().pid)).toBe(false); // no leaked process
  });

  it("mixed batch: a persisting job and a spawning job are both resolved correctly in the SAME killAllNonTerminal call", async () => {
    const { manager, port } = await harness();
    let releaseB: () => void = () => {};
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let bEntered: () => void = () => {};
    const bEnteredPromise = new Promise<void>((resolve) => {
      bEntered = resolve;
    });
    let gateArmed = false;
    port.spawnGate = () => {
      if (!gateArmed) return Promise.resolve(); // job A: spawn immediately, unaffected
      bEntered();
      return gateB;
    };

    // Job A: allowed to spawn freely and reach `running` before killAll runs.
    const jobA = await manager.create({ command: "sleep 30", cwd: "/repo" });
    await manager.markBackgrounded(jobA.jobId);

    // Job B: gated — still "staged(spawning)" when killAllNonTerminal starts.
    gateArmed = true;
    const { jobId: jobBId } = manager.reserve({ command: "sleep 30", cwd: "/repo" });
    await bEnteredPromise;
    expect(manager.get(jobBId)?.status).toBe("staged");

    const reportPromise = killAllNonTerminal(manager, 200);
    // Job A (already running) is killed through the plain `kill()` path —
    // let its process actually die.
    await new Promise((resolve) => setImmediate(resolve));
    const aProc = port.procs.find((p) => p.pid === jobA.pid);
    aProc?.exit({ exitCode: null, signal: "SIGTERM" });

    releaseB();
    await new Promise((resolve) => setImmediate(resolve));
    const bProc = port.procs.find((p) => p.pid !== jobA.pid);
    bProc?.exit({ exitCode: null, signal: "SIGTERM" });

    const report = await reportPromise;
    expect(new Set(report.killed)).toEqual(new Set([jobA.jobId, jobBId]));
    expect(report.alreadyDone).toEqual([]);
    expect(report.orphaned).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(manager.get(jobA.jobId)?.status).toBe("killed");
    expect(manager.get(jobBId)?.status).toBe("killed");
    // Every pid that ever surfaced was signalled — none left running.
    const killedPids = new Set(port.killCalls.map((c) => c.pid));
    for (const proc of port.procs) expect(killedPids.has(proc.pid)).toBe(true);
  });
});
