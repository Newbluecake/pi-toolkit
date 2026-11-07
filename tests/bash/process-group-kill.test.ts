import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore } from "../../src/bash/job-store.js";
import { createBashJobManager, type BashJobManager } from "../../src/bash/manager.js";
import { createProcessPort, probePid, type ProcessPort, type SpawnedJob } from "../../src/bash/process.js";
import { isTerminalJobStatus } from "../../src/bash/types.js";
import { systemClock } from "../../src/core/clock.js";
import {
  createOrphanFixture,
  killGroup,
  liveGroupMembers,
  until,
  type OrphanFixture,
} from "./helpers/orphan-fixtures.js";

/**
 * reaper-orphans plan §7: killJobTree judges "done" by process-GROUP emptiness,
 * so a SIGTERM-resistant member left behind by a dead leader still gets SIGKILLed.
 * Real processes only. Every case force-kills what it recorded in `finally`/afterEach.
 */
const GRACE = 300;
const pgids: number[] = [];
let fixture: OrphanFixture | undefined;
let manager: BashJobManager | undefined;
let dir: string | undefined;

afterEach(async () => {
  manager?.dispose();
  manager = undefined;
  for (const g of pgids.splice(0)) killGroup(g);
  fixture?.cleanup();
  fixture = undefined;
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  dir = undefined;
});

const groupEmpty = (pgid: number): Promise<boolean> => until(() => liveGroupMembers(pgid) === 0, 5_000);

async function launch(port: ProcessPort, command: string): Promise<SpawnedJob> {
  const job = await port.spawnJob(command, process.cwd());
  pgids.push(job.pgid);
  return job;
}

describe.skipIf(process.platform !== "linux")("killJobTree: group-emptiness semantics (ProcessPort)", () => {
  it("SIGTERM-resistant member with a live leader ⇒ killed and group empty", async () => {
    fixture = createOrphanFixture();
    const port = createProcessPort();
    const job = await launch(port, fixture.command("alive"));
    expect(await until(() => fixture!.workerPid() !== undefined)).toBe(true);
    const outcome = await port.killJobTree(job.pid, { graceMs: GRACE });
    expect(outcome).toBe("killed");
    expect(await groupEmpty(job.pgid)).toBe(true);
  });

  it("ordinary sleep children die on SIGTERM ⇒ terminated and group empty", async () => {
    const port = createProcessPort();
    const job = await launch(port, "sleep 60 & sleep 60 & wait");
    expect(await until(() => liveGroupMembers(job.pgid) >= 3)).toBe(true);
    expect(await port.killJobTree(job.pid, { graceMs: 2_000 })).toBe("terminated");
    expect(await groupEmpty(job.pgid)).toBe(true);
  });

  it("leader already dead but a resistant member remains ⇒ killed and group empty", async () => {
    fixture = createOrphanFixture();
    const port = createProcessPort();
    const job = await launch(port, fixture.command("exit"));
    await job.processExitPromise;
    expect(probePid(job.pid)).toBe(false);
    expect(liveGroupMembers(job.pgid)).toBeGreaterThan(0);
    expect(await port.killJobTree(job.pid, { graceMs: GRACE })).toBe("killed");
    expect(await groupEmpty(job.pgid)).toBe(true);
  });

  it("empty group ⇒ already-dead (idempotent second call)", async () => {
    const port = createProcessPort();
    const job = await launch(port, "sleep 60");
    expect(await port.killJobTree(job.pid, { graceMs: 2_000 })).toBe("terminated");
    expect(await groupEmpty(job.pgid)).toBe(true);
    expect(await port.killJobTree(job.pid, { graceMs: GRACE })).toBe("already-dead");
  });

  it("starttime mismatch ⇒ refused and nothing was signalled", async () => {
    const port = createProcessPort();
    const job = await launch(port, "sleep 60");
    expect(await port.killJobTree(job.pid, { graceMs: GRACE, expectedProcStartTime: "1" })).toBe("refused");
    expect(probePid(job.pid)).toBe(true);
    expect(liveGroupMembers(job.pgid)).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform !== "linux")("BashJobManager.kill against a SIGTERM-resistant group member", () => {
  async function build(): Promise<BashJobManager> {
    dir = await mkdtemp(join(tmpdir(), "pi-orphan-mgr-"));
    const store = createJobStore({ dir, retentionMs: 86_400_000, clock: systemClock });
    manager = createBashJobManager({ store, processPort: createProcessPort(), clock: systemClock, sessionId: "s1" });
    return manager;
  }

  it("kill of a running job reaches a terminal state and leaves no live group member", async () => {
    fixture = createOrphanFixture();
    const m = await build();
    const { jobId, started } = m.reserve({ command: fixture.command("alive"), cwd: process.cwd() });
    const s = await started;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    pgids.push(s.job.pid);
    expect(await until(() => fixture!.workerPid() !== undefined)).toBe(true);
    const result = await m.kill(jobId, { graceMs: GRACE });
    // Issue #73 changed *which* outcome this is, not the guarantee: the job's
    // stdio is a plain file now, so SIGTERM takes down `dd`/`cat` with the
    // leader and the trapped `TERM` in the worker no longer keeps the tree
    // alive for the full grace window — the group empties in the grace, i.e.
    // "terminated" (a SIGTERM-resistant *writer* used to hold a pipe open;
    // with a file fd there is nothing to hold). A group that does outlive the
    // grace is still SIGKILLed ("killed", covered by the ProcessPort cases
    // above); what must never change is "terminal + group empty".
    expect(["terminated", "killed"]).toContain(result.outcome);
    const record = await s.job.exit;
    expect(record.status).toBe("killed");
    expect(await groupEmpty(s.job.pid)).toBe(true);
  }, 15_000);

  it("a descendant that outlives the leader keeps the job running until it is killed", async () => {
    fixture = createOrphanFixture();
    const m = await build();
    const { jobId, started } = m.reserve({ command: fixture.command("exit"), cwd: process.cwd() });
    const s = await started;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    pgids.push(s.job.pid);
    expect(await until(() => fixture!.workerPid() !== undefined)).toBe(true);

    // Issue #73 topology: the leader cannot exit while a descendant still
    // holds the log fd (the wrapper's pipeline — `dd`/`cat` — waits for the
    // last writer, exactly like the old pipe did). So "leader gone, workers
    // survive" is no longer reachable: the job is still *running* and
    // `kill()` must take the normal path and reap the whole group.
    expect(probePid(s.job.pid)).toBe(true);
    expect(liveGroupMembers(s.job.pid)).toBeGreaterThan(0);
    expect(isTerminalJobStatus(m.get(jobId)!.status)).toBe(false);

    const result = await m.kill(jobId, { graceMs: GRACE });
    expect(result.alreadyTerminal).toBe(false);
    expect(["terminated", "killed"]).toContain(result.outcome);
    const record = await s.job.exit;
    expect(record.status).toBe("killed");
    expect(await groupEmpty(s.job.pid)).toBe(true);
  }, 15_000);

  it("kill() on a settled job whose group is empty is already-terminal, not a second signal", async () => {
    const m = await build();
    const { jobId, started } = m.reserve({ command: "exit 3", cwd: process.cwd() });
    const s = await started;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const record = await s.job.exit;
    expect(record.status).toBe("failed");
    expect(record.exitCode).toBe(3);
    const result = await m.kill(jobId, { graceMs: GRACE });
    expect(result).toMatchObject({ alreadyTerminal: true, outcome: "already-terminal" });
  }, 15_000);
});
