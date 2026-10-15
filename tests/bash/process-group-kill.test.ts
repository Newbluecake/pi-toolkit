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
    expect(result.outcome).toBe("killed");
    const record = await s.job.exit;
    expect(record.status).toBe("killed");
    expect(await groupEmpty(s.job.pid)).toBe(true);
  }, 15_000);

  it("job already exited but a pipe holder survives ⇒ kill() SIGKILLs the leftover group", async () => {
    fixture = createOrphanFixture();
    const m = await build();
    const { jobId, started } = m.reserve({ command: fixture.command("exit"), cwd: process.cwd() });
    const s = await started;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    pgids.push(s.job.pid);
    // Leader gone while the worker still holds (and writes to) the inherited pipes ⇒ local handle still open.
    expect(await until(() => !probePid(s.job.pid))).toBe(true);
    // Under load the manager may not have processed the leader's exit yet; the
    // pipe-holder branch only runs once the record itself is terminal.
    expect(
      await until(() => {
        const r = m.get(jobId);
        return r !== undefined && isTerminalJobStatus(r.status);
      }),
    ).toBe(true);
    expect(liveGroupMembers(s.job.pid)).toBeGreaterThan(0);
    const result = await m.kill(jobId, { graceMs: GRACE });
    expect(result.reason).toMatch(/surviving pipe holders were terminated/);
    expect(result.outcome).toBe("killed");
    expect(await groupEmpty(s.job.pid)).toBe(true);
    // Wait for the job's final settle/flush so no async store write races afterEach's rm.
    await s.job.exit;
  }, 15_000);
});
