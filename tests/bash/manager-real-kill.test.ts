import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashJobManager, type BashJobManager } from "../../src/bash/manager.js";
import { createJobStore } from "../../src/bash/job-store.js";
import { createProcessPort, probePid } from "../../src/bash/process.js";
import { systemClock } from "../../src/core/clock.js";

/**
 * bash-timeout-grace P3+P4 verifier round 5 (suggestion): T4b
 * (tests/tools/bash-tool.test.ts) proves the *shape* of "abort after output,
 * before drain" against a fake process whose stream ending is entirely under
 * the test's own control — stronger than what a real SIGTERM actually
 * guarantees (nothing lets a test manufacture output landing in a real
 * kernel pipe buffer after the signal). This file proves the weaker, real
 * property instead: `cancelReserve`'s synchronous SIGTERM (plan §3.6) does
 * not itself close the process's pipes — the kernel does that once the
 * process actually dies — so output the process already wrote *before* the
 * signal is still delivered through the manager's tee before the job
 * settles `killed`. Real processes only, no fakes (mirrors
 * `tests/bash/process.test.ts`'s own rationale).
 */

const posix = process.platform !== "win32";

/** Poll until `predicate` holds; generous budget so CI/load never flakes it. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe.skipIf(!posix)("bash job manager: cancelReserve against a real process (P3+P4 round 5)", () => {
  let dir: string | undefined;
  let manager: BashJobManager | undefined;
  const spawnedPids: number[] = [];

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    // Belt-and-braces reaper (mirrors process.test.ts): kill anything this
    // test left running, even if an assertion failed before cancelReserve().
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("output written before a synchronous cancelReserve survives the real SIGTERM (no lost bytes, no leaked process)", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-subagent-bash-real-kill-"));
    const store = createJobStore({ dir, retentionMs: 86_400_000, clock: systemClock });
    manager = createBashJobManager({
      store,
      processPort: createProcessPort(),
      clock: systemClock,
      sessionId: "s1",
    });

    // Writes its output, flushes it (so it is not merely stdio-buffered
    // inside the shell), then sleeps well past anything this test needs.
    const command = 'printf "hello-before-abort\\n"; sleep 60';
    const { jobId, started } = manager.reserve({ command, cwd: process.cwd() });

    const startedResult = await started;
    expect(startedResult.ok).toBe(true);
    if (!startedResult.ok) return; // unreachable, narrows the type below
    const pid = startedResult.job.pid;
    expect(pid).toBeGreaterThan(0);
    spawnedPids.push(pid);

    // Wait for the scripted output to actually land on disk before aborting
    // — the property under test is "output already delivered when the
    // signal is sent survives it", not "output racing the signal happens
    // to survive it" (that race is covered, deterministically, by the fake
    // in tests/tools/bash-tool.test.ts's T4b).
    expect(await until(() => (manager?.get(jobId)?.logBytes ?? 0) > 0)).toBe(true);

    // §3.6: the abort/cancel path sends the signal synchronously — no
    // deferral, no waiting for anything else.
    manager.cancelReserve(jobId);

    const record = await startedResult.job.exit;
    expect(record.status).toBe("killed");

    // The pre-abort output was not lost: a real kill signal does not itself
    // close the pipe, so bytes already written into it before the signal
    // are still delivered through the tee.
    const read = await manager.readOutput(jobId, { offset: 0 });
    expect(read.content).toContain("hello-before-abort");

    // No leaked process: the group leader is actually gone.
    expect(await until(() => !probePid(pid))).toBe(true);
  }, 15_000);
});
