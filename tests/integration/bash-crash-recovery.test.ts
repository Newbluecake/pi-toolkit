import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Issue #73 — the end-to-end property the whole fix exists for: a background
 * job keeps running (and keeps logging, and keeps its exit code) after the pi
 * process that started it is **gone**, and the next pi process can recover the
 * result in full.
 *
 * This file drives that across a real process boundary on purpose. A fake
 * `ProcessPort` cannot prove it: the bug lived in *who owns the file
 * descriptors* — the old tee wrote the log from inside pi, so `SIGKILL`ing pi
 * (not even a graceful shutdown) closed the read end of the child's pipe and
 * the job died on its next write with SIGPIPE.
 *
 * Shape of every case:
 *   1. a child `node --import tsx` process builds a real `BashJobManager`
 *      against a real directory, starts a job, and prints its id;
 *   2. that child is `SIGKILL`ed (the harshest possible "pi died" — no
 *      teardown, no flush, no `dispose()`);
 *   3. a manager in *this* process `recover()`s the directory and must report
 *      the job's true terminal state, exit code and full log — including output
 *      produced entirely after the crash.
 *
 * POSIX only (`bashJobsEnabled` is false on win32).
 */
const posix = process.platform !== "win32";
const ROOT = resolve(import.meta.dirname, "../..");
/** Child-side driver: same module graph, real manager, real process port. */
const DRIVER = join(import.meta.dirname, "helpers", "bash-crash-driver.ts");

/** Generous: the driver boots tsx + the whole manager before spawning anything. */
const DRIVER_BOOT_TIMEOUT_MS = 60_000;

interface JobHandoff {
  readonly dir: string;
  readonly jobId: string;
  readonly logPath: string;
  readonly exitPath: string;
  /** Wall-clock at which the driver printed the handoff (ms since epoch). */
  readonly at: number;
}

const cleanups: { dir: string; pid?: number }[] = [];

afterEach(() => {
  for (const entry of cleanups.splice(0)) {
    if (entry.pid !== undefined) {
      // The job's own group leader; SIGKILL the whole group so a test failure
      // cannot leave a `sleep 30` behind (same doctrine as process.test.ts).
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

/**
 * Run the driver until it reports a spawned job, then `SIGKILL` it.
 * Returns the handoff plus the job's pgid so the caller can reap leftovers.
 */
async function startAndCrash(
  command: string,
  options: { maxLogBytes?: number; settleMs?: number } = {},
): Promise<{ handoff: JobHandoff; jobPid: number }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-bash-crash-"));
  const handoffFile = join(dir, "handoff.json");
  const args = [DRIVER, dir, command, handoffFile, String(options.maxLogBytes ?? 10 * 1024 * 1024)];
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push({ dir });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const handoff = await new Promise<JobHandoff>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`driver did not hand off a job within ${DRIVER_BOOT_TIMEOUT_MS}ms; stderr:\n${stderr}`));
    }, DRIVER_BOOT_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    const poll = setInterval(() => {
      if (!existsSync(handoffFile)) return;
      // `writeFileSync` is atomic enough at these sizes only if read after the
      // write returns — tolerate a torn read by retrying on JSON errors.
      let parsed: JobHandoff;
      try {
        parsed = JSON.parse(readFileSync(handoffFile, "utf8")) as JobHandoff;
      } catch {
        return;
      }
      if (typeof parsed.jobId !== "string" || parsed.jobId.length === 0) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolvePromise(parsed);
    }, 20);
    (poll as unknown as { unref?: () => void }).unref?.();
    child.once("exit", (code, signal) => {
      if (existsSync(handoffFile)) return; // the poll will pick it up
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`driver exited early (${code}/${signal}) without a handoff; stderr:\n${stderr}`));
    });
  });

  // The kill IS the scenario. Wait for the signal to land before letting the
  // recovery side read the directory, so "the previous pi died" is a fact.
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGKILL");
  await exited;
  // Give the job tree a moment past the crash: several cases assert *output
  // produced after* the driver died, so the recovery must run strictly later.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, options.settleMs ?? 1_200));

  const pidFile = join(dir, "job.pid");
  const jobPid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10) : undefined;
  cleanups[cleanups.length - 1]!.pid = Number.isInteger(jobPid) ? jobPid : undefined;
  return { handoff, jobPid: jobPid ?? 0 };
}

/** Recover the crashed driver's directory with a real manager in this process. */
async function recoverInProcess(dir: string, maxLogBytes?: number) {
  const { createJobStore } = await import("../../src/bash/job-store.js");
  const { createBashJobManager } = await import("../../src/bash/manager.js");
  const { createProcessPort } = await import("../../src/bash/process.js");
  const { systemClock } = await import("../../src/core/clock.js");
  const store = createJobStore({ dir, retentionMs: 86_400_000, clock: systemClock });
  const manager = createBashJobManager({
    store,
    processPort: createProcessPort(),
    clock: systemClock,
    sessionId: "recovering-session",
    ...(maxLogBytes !== undefined ? { maxLogBytes } : {}),
  });
  const summary = await manager.recover();
  return { manager, store, summary };
}

/** Poll until `predicate` holds (recovery settles asynchronously). */
async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return predicate();
}

describe.skipIf(!posix)("issue #73: a background job survives the pi process (real SIGKILL)", () => {
  it("silent-until-finish command: output written after the crash is in the log and the exit code survived", async () => {
    // The exact shape that produced the empty log in the bug report.
    const { handoff } = await startAndCrash("sleep 2; echo done-after-crash; exit 5", { settleMs: 3_000 });

    const { manager, store } = await recoverInProcess(handoff.dir);
    try {
      expect(await until(() => manager.get(handoff.jobId)?.status !== "running")).toBe(true);
      const record = manager.get(handoff.jobId);
      expect(record?.status).toBe("failed");
      expect(record?.exitCode).toBe(5);

      // The log is the whole point: it must contain the line the dead pi never
      // saw (it was produced after the crash).
      const raw = readFileSync(handoff.logPath, "utf8");
      expect(raw).toContain("done-after-crash");
      // …and its own footer, so `tail -1` answers "how did this end?".
      expect(raw.trimEnd().split("\n").at(-1)).toMatch(
        new RegExp(`\\[pi-subagent\\] job ${handoff.jobId} failed \\(exit 5\\) after `),
      );
      // Byte count came from the file, not from a counter that died with pi.
      expect(record?.logBytes).toBe(raw.length);
      expect(existsSync(store.exitPath(handoff.jobId))).toBe(true);
    } finally {
      manager.dispose();
    }
  }, 120_000);

  it("external writer (`sh -c 'echo a; sleep 1; echo b'` writing through the shell): both lines land", async () => {
    // Output interleaved with a sleep, written by a nested shell — the case the
    // report measured as "writer SIGPIPEd, shell kept running" before the fix.
    const { handoff } = await startAndCrash(`/usr/bin/env sh -c 'echo a; sleep 1; echo b'; exit 0`, {
      settleMs: 2_500,
    });

    const { manager } = await recoverInProcess(handoff.dir);
    try {
      expect(await until(() => manager.get(handoff.jobId)?.status !== "running")).toBe(true);
      const record = manager.get(handoff.jobId);
      expect(record?.status).toBe("completed");
      expect(record?.exitCode).toBe(0);
      const raw = readFileSync(handoff.logPath, "utf8");
      expect(raw).toContain("a\n");
      expect(raw).toContain("b\n");
      // Order preserved: the wrapper funnels both streams through one pipe.
      expect(raw.indexOf("a\n")).toBeLessThan(raw.indexOf("b\n"));
      expect(raw.trimEnd().split("\n").at(-1)).toContain(`job ${handoff.jobId} completed (exit 0)`);
    } finally {
      manager.dispose();
    }
  }, 120_000);

  it("output cap: the log stops at the cap, is marked truncated, and the command still finishes", async () => {
    const maxLogBytes = 4_096;
    // `yes` floods far past the cap; `echo tail-line; exit 9` after it proves
    // the writer kept running (no SIGPIPE) even though its output was dropped.
    const { handoff } = await startAndCrash(`yes 2>/dev/null | head -c 60000; echo tail-line; exit 9`, {
      maxLogBytes,
      settleMs: 2_500,
    });

    const { manager } = await recoverInProcess(handoff.dir, maxLogBytes);
    try {
      // The status was persisted by the driver before it died, so it is already
      // terminal on disk; what recovery still owes is the log reconciliation
      // (byte count, truncation flag, the notice a crashed finalization never
      // wrote). Wait for *that*, not for the status.
      expect(await until(() => manager.get(handoff.jobId)?.outputTruncated === true)).toBe(true);
      expect(await until(() => readFileSync(handoff.logPath, "utf8").includes("[log truncated at "))).toBe(true);
      const record = manager.get(handoff.jobId);
      expect(record?.status).toBe("failed");
      expect(record?.exitCode).toBe(9);
      expect(record?.outputTruncated).toBe(true);

      const raw = readFileSync(handoff.logPath, "utf8");
      // The cap is enforced by the wrapper's `dd`, in blocks of 512: the file
      // never exceeds the cap by more than one block (plus the footer line).
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(maxLogBytes + 512 + 200);
      expect(record?.outputTruncated).toBe(true);
      // A crash-time recovery has no live stream, so the notice is appended by
      // the recovery pass itself — the log stays self-describing.
      expect(raw).toContain("[log truncated at ");
      // The command did NOT die at the cap — it ran past it to its own
      // `exit 9`, which is exactly the code we recovered. (`tail-line` itself
      // was dropped *by design*: it was written after the cap, and the cap
      // keeps the job alive without keeping its output.)
      expect(raw).not.toContain("tail-line");
      expect(raw.trimEnd().split("\n").at(-1)).toContain(`job ${handoff.jobId} failed (exit 9)`);
    } finally {
      manager.dispose();
    }
  }, 120_000);

  it("a long-running job keeps writing after the crash, and losing its exit file still means exited_unknown", async () => {
    // Two properties in one run, both about "pi is gone but the job is not done":
    //   (a) a job still RUNNING at crash time is adopted and keeps logging — the
    //       old pipe tee killed it on its next write with SIGPIPE;
    //   (b) if its exit file never arrives (here: the whole group is SIGKILLed,
    //       so the wrapper never writes it), recovery must still be honest and
    //       report `exited_unknown` — the `failed(exit N)` cases above are only
    //       trustworthy because this one stays distinguishable.
    const { handoff, jobPid } = await startAndCrash("sleep 2; echo late-line; sleep 30", { settleMs: 500 });

    // The job is alive after the crash and has not written anything yet.
    expect(jobPid).toBeGreaterThan(1);
    expect(readFileSync(handoff.logPath, "utf8").length).toBe(0);

    // Let it reach the post-crash write, then SIGKILL its whole group so the
    // wrapper has no chance to persist a code (the honest "code lost" case).
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
    expect(readFileSync(handoff.logPath, "utf8")).toContain("late-line");
    try {
      process.kill(-jobPid, "SIGKILL");
    } catch {
      /* already gone */
    }

    const { manager } = await recoverInProcess(handoff.dir);
    try {
      expect(await until(() => manager.get(handoff.jobId)?.status !== "running")).toBe(true);
      const record = manager.get(handoff.jobId);
      expect(record?.status).toBe("exited_unknown");
      expect(record?.exitCode).toBeNull();
      // The output produced *after* the crash is still there (property (a)).
      expect(readFileSync(handoff.logPath, "utf8")).toContain("late-line");
    } finally {
      manager.dispose();
    }
  }, 120_000);
});
