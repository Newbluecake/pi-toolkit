import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock, systemClock } from "../../src/core/clock.js";
import { buildEntry, CHAIN_SEED, taskKeyOf } from "../../src/workflow/journal.js";
import type { JournalEntry, TaskSemantics } from "../../src/workflow/types.js";
import {
  collectProbeBranches,
  parseForEachRef,
  recheckBranches,
  runBoundedProbe,
  verifyIsolatedEntries,
  type ProbeAgentBranchesFn,
} from "../../src/workflow/isolation-verify.js";

const execFileAsync = promisify(execFile);

/**
 * replay-verify plan §6 P2 tests 9-10, 13: `isolation-verify.ts`'s pure
 * primitives (parse/collect), the bounded-probe wrapper's zero-hang
 * guarantee against a fake AND a real SIGTERM-resistant subprocess, and the
 * two higher-level probe/recheck functions built on top of it.
 */

describe("parseForEachRef", () => {
  it("keeps only exact matches for the wanted refname, with a valid sha", () => {
    const stdout = "refs/heads/pi-agent-a " + "a".repeat(40) + "\nrefs/heads/other " + "b".repeat(40) + "\n";
    const tips = parseForEachRef(stdout, new Set(["refs/heads/pi-agent-a"]));
    expect(tips.size).toBe(1);
    expect(tips.get("refs/heads/pi-agent-a")).toBe("a".repeat(40));
  });

  it("drops a line with a malformed objectname", () => {
    const stdout = "refs/heads/pi-agent-a not-a-sha\n";
    const tips = parseForEachRef(stdout, new Set(["refs/heads/pi-agent-a"]));
    expect(tips.size).toBe(0);
  });

  it("accepts a 64-hex (sha256) objectname too", () => {
    const stdout = `refs/heads/pi-agent-a ${"c".repeat(64)}\n`;
    const tips = parseForEachRef(stdout, new Set(["refs/heads/pi-agent-a"]));
    expect(tips.get("refs/heads/pi-agent-a")).toBe("c".repeat(64));
  });

  it("ignores blank lines and garbage lines without throwing", () => {
    const stdout = "\n\ngarbage-no-space\nrefs/heads/pi-agent-a " + "a".repeat(40) + "\n";
    const tips = parseForEachRef(stdout, new Set(["refs/heads/pi-agent-a"]));
    expect(tips.get("refs/heads/pi-agent-a")).toBe("a".repeat(40));
  });

  it("returns empty for an oversized stream (defensive 1 MiB cap)", () => {
    const huge = "refs/heads/pi-agent-a " + "a".repeat(40) + "\n" + "x".repeat(2 * 1024 * 1024);
    expect(parseForEachRef(huge, new Set(["refs/heads/pi-agent-a"])).size).toBe(0);
  });
});

const isoSem = (prompt: string): TaskSemantics => ({
  agentType: "gp",
  agentTypeConfigHash: "h1",
  prompt,
  isolation: "worktree",
});

function committedEntry(branch: string, commit: string, prompt = "p"): JournalEntry {
  return buildEntry({
    scope: "chain",
    key: taskKeyOf(isoSem(prompt)),
    chainDigestBefore: CHAIN_SEED,
    occurrence: 0,
    agentType: "gp",
    isolation: "worktree",
    worktree: { state: "committed", branch, commit, isoId: "b".repeat(32) },
    value: "v",
    completedAt: 1000,
    durationMs: 10,
  });
}

describe("collectProbeBranches", () => {
  it("dedupes branches across candidates", () => {
    const a = committedEntry("pi-agent-r1", "a".repeat(40), "p1");
    const b = committedEntry("pi-agent-r1", "a".repeat(40), "p2");
    const c = committedEntry("pi-agent-r2", "b".repeat(40), "p3");
    const { branches, truncated } = collectProbeBranches([a, b, c]);
    expect(branches.sort()).toEqual(["pi-agent-r1", "pi-agent-r2"]);
    expect(truncated).toBe(0);
  });

  it("caps at the given limit and reports the truncated count", () => {
    const entries = Array.from({ length: 5 }, (_, i) => committedEntry(`pi-agent-r${i}`, "a".repeat(40), `p${i}`));
    const { branches, truncated } = collectProbeBranches(entries, 3);
    expect(branches).toHaveLength(3);
    expect(truncated).toBe(2);
  });
});

describe("runBoundedProbe (D4.3/D10, §6 test 9): zero-hang guarantee against a fake port", () => {
  it("a port that never resolves: signal is aborted at timeoutMs, and the call returns by timeoutMs+500", async () => {
    const clock = new FakeClock();
    let sawAbortedAt: number | undefined;
    const promise = runBoundedProbe<void>(
      (signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            sawAbortedAt = clock.now();
          });
        }),
      { timeoutMs: 1_000, clock },
    );
    clock.advance(1_000);
    expect(sawAbortedAt).toBe(1_000);
    clock.advance(500);
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("a port that resolves AFTER the deadline is swallowed: no second callback, no unhandled rejection, verified state unchanged", async () => {
    const clock = new FakeClock();
    let resolveLate: (() => void) | undefined;
    let settleCount = 0;
    const promise = runBoundedProbe<string>(
      () =>
        new Promise<string>((resolve) => {
          resolveLate = () => resolve("late-value");
        }),
      { timeoutMs: 1_000, clock },
    ).then((r) => {
      settleCount += 1;
      return r;
    });
    clock.advance(1_500); // timeoutMs + 500
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(settleCount).toBe(1);
    // The late resolve now fires (simulating a slow git that eventually
    // returns) — must not throw, must not produce a second observable effect.
    expect(() => resolveLate?.()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(settleCount).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("a port that rejects AFTER the deadline is swallowed too (no unhandled rejection)", async () => {
    const clock = new FakeClock();
    let rejectLate: ((e: unknown) => void) | undefined;
    const promise = runBoundedProbe<string>(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectLate = reject;
        }),
      { timeoutMs: 1_000, clock },
    );
    clock.advance(1_500);
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(() => rejectLate?.(new Error("late failure"))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(clock.pendingTimers).toBe(0);
  });

  it("a port that resolves promptly returns ok:true well before the deadline, and clears its timer", async () => {
    const clock = new FakeClock();
    const result = await runBoundedProbe<string>(async () => "quick", { timeoutMs: 5_000, clock });
    expect(result).toEqual({ ok: true, value: "quick" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("a port whose invocation throws synchronously resolves ok:false, reason:error (never hangs, never throws)", async () => {
    const clock = new FakeClock();
    const result = await runBoundedProbe<string>(
      () => {
        throw new Error("boom");
      },
      { timeoutMs: 1_000, clock },
    );
    expect(result).toEqual({ ok: false, reason: "error", error: "boom" });
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("verifyIsolatedEntries", () => {
  it("zero candidates ⇒ zero probe calls", async () => {
    const probe = vi.fn();
    const result = await verifyIsolatedEntries([], probe, { cwd: "/repo", timeoutMs: 1_000, clock: new FakeClock() });
    expect(probe).not.toHaveBeenCalled();
    expect(result).toEqual({ verified: new Set(), stats: { probed: 0, verified: 0, unverified: 0 } });
  });

  it("no probe port ⇒ zero calls, every candidate unverified", async () => {
    const entry = committedEntry("pi-agent-r1", "a".repeat(40));
    const result = await verifyIsolatedEntries([entry], undefined, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.stats).toEqual({ probed: 1, verified: 0, unverified: 1 });
  });

  it("a matching tip verifies the entry (by digest)", async () => {
    const entry = committedEntry("pi-agent-r1", "a".repeat(40));
    const probe: ProbeAgentBranchesFn = async (branches) => ({
      ok: true,
      tips: new Map(branches.map((b) => [`refs/heads/${b}`, "a".repeat(40)])),
    });
    const result = await verifyIsolatedEntries([entry], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.verified).toEqual(new Set([entry.digest]));
    expect(result.stats).toEqual({ probed: 1, verified: 1, unverified: 0 });
  });

  it("a mismatching tip leaves the entry unverified", async () => {
    const entry = committedEntry("pi-agent-r1", "a".repeat(40));
    const probe: ProbeAgentBranchesFn = async (branches) => ({
      ok: true,
      tips: new Map(branches.map((b) => [`refs/heads/${b}`, "f".repeat(40)])),
    });
    const result = await verifyIsolatedEntries([entry], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.verified.size).toBe(0);
    expect(result.stats.unverified).toBe(1);
  });

  it("a missing branch tip leaves the entry unverified (branch deleted/merged-and-deleted)", async () => {
    const entry = committedEntry("pi-agent-r1", "a".repeat(40));
    const probe: ProbeAgentBranchesFn = async () => ({ ok: true, tips: new Map() });
    const result = await verifyIsolatedEntries([entry], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.verified.size).toBe(0);
  });

  it("a probe error surfaces as probeError, every candidate stays unverified (fail-closed)", async () => {
    const entry = committedEntry("pi-agent-r1", "a".repeat(40));
    const probe: ProbeAgentBranchesFn = async () => ({ ok: false, error: "not a git repo" });
    const result = await verifyIsolatedEntries([entry], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.verified.size).toBe(0);
    expect(result.probeError).toBe("not a git repo");
  });

  it("a probe that hangs times out and reports probeError without hanging the caller", async () => {
    const entry = committedEntry("pi-agent-r1", "a".repeat(40));
    const clock = new FakeClock();
    const probe: ProbeAgentBranchesFn = () => new Promise(() => {});
    const promise = verifyIsolatedEntries([entry], probe, { cwd: "/repo", timeoutMs: 1_000, clock });
    clock.advance(1_500);
    const result = await promise;
    expect(result.verified.size).toBe(0);
    expect(result.probeError).toBe("isolation verify probe timed out");
  });
});

describe("recheckBranches (D4.4 terminal diagnostic)", () => {
  it("no targets ⇒ zero probe calls", async () => {
    const probe = vi.fn();
    const result = await recheckBranches([], probe, { cwd: "/repo", timeoutMs: 1_000, clock: new FakeClock() });
    expect(probe).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it("a tip that still matches is not annotated at all", async () => {
    const probe: ProbeAgentBranchesFn = async () => ({
      ok: true,
      tips: new Map([["refs/heads/pi-agent-r1", "a".repeat(40)]]),
    });
    const result = await recheckBranches([{ branch: "pi-agent-r1", commit: "a".repeat(40) }], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.has("pi-agent-r1")).toBe(false);
  });

  it("a missing tip is annotated 'gone'", async () => {
    const probe: ProbeAgentBranchesFn = async () => ({ ok: true, tips: new Map() });
    const result = await recheckBranches([{ branch: "pi-agent-r1", commit: "a".repeat(40) }], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.get("pi-agent-r1")).toBe("gone");
  });

  it("a moved tip is annotated 'moved'", async () => {
    const probe: ProbeAgentBranchesFn = async () => ({
      ok: true,
      tips: new Map([["refs/heads/pi-agent-r1", "f".repeat(40)]]),
    });
    const result = await recheckBranches([{ branch: "pi-agent-r1", commit: "a".repeat(40) }], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.get("pi-agent-r1")).toBe("moved");
  });

  it("a probe failure/timeout never annotates anything (unknown, not staled)", async () => {
    const probe: ProbeAgentBranchesFn = async () => ({ ok: false, error: "boom" });
    const result = await recheckBranches([{ branch: "pi-agent-r1", commit: "a".repeat(40) }], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.size).toBe(0);
  });

  it("a throwing port never throws out of recheckBranches (D4.4: diagnostic-only)", async () => {
    const probe: ProbeAgentBranchesFn = () => {
      throw new Error("contract violation");
    };
    const result = await recheckBranches([{ branch: "pi-agent-r1", commit: "a".repeat(40) }], probe, {
      cwd: "/repo",
      timeoutMs: 1_000,
      clock: new FakeClock(),
    });
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Real subprocess coverage (§6 test 10): a genuine `pi.exec`-shaped port
// (SIGTERM → 5s → SIGKILL, exactly node_modules/@earendil-works/pi-coding-
// agent's own core/exec.js contract) driving `runBoundedProbe` against real
// child processes, using the SYSTEM clock (real wall time) since FakeClock
// cannot drive a real subprocess's real signal handling.
// ---------------------------------------------------------------------------

/** Mirrors pi-coding-agent's `core/exec.js` `execCommand`: resolves exactly once, never rejects, SIGTERM then a 5s SIGKILL fallback if the process has not actually exited by then. */
function realPiExecLike(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let exited = false;
    let timeoutId: NodeJS.Timeout | undefined;
    const killProcess = (): void => {
      if (killed) return;
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
      }, 5_000).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) killProcess();
      else opts.signal.addEventListener("abort", killProcess, { once: true });
    }
    if (opts.timeout && opts.timeout > 0) {
      timeoutId = setTimeout(killProcess, opts.timeout);
      timeoutId.unref();
    }
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => {
      exited = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, code: code ?? 0, killed });
    });
  });
}

describe("runBoundedProbe against real subprocesses (§6 test 10, real pi.exec-shaped port)", () => {
  const dirs: string[] = [];
  const pids: number[] = [];
  afterEach(async () => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("(a) an ordinary sleeping process (no signal trap): probe returns within timeoutMs+500, and SIGTERM makes it exit promptly", async () => {
    const clock = systemClock;
    const started = Date.now();
    const result = await runBoundedProbe((signal) => realPiExecLike("sleep", ["30"], { timeout: 300, signal }), {
      timeoutMs: 300,
      clock,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true); // the port itself resolves (killed:true) well before runBoundedProbe's own deadline
    if (result.ok) expect(result.value.killed).toBe(true);
    expect(elapsed).toBeLessThan(300 + 500 + 2_000); // generous CI slack
  }, 20_000);

  it("(b) a SIGTERM-resistant fake git: probe still returns within ~timeoutMs+500 (bounded RETURN, not bounded process death); the process is reaped by SIGKILL a few seconds later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-subagent-iso-verify-resist-"));
    dirs.push(dir);
    const script = join(dir, "resist.sh");
    await writeFile(script, "#!/bin/sh\ntrap '' TERM\necho $$ > " + join(dir, "pid") + "\nsleep 30\n");
    await chmod(script, 0o755);
    const clock = systemClock;
    const started = Date.now();
    const resultPromise = runBoundedProbe((signal) => realPiExecLike(script, [], { timeout: 300, signal }), {
      timeoutMs: 300,
      clock,
    });
    const result = await resultPromise;
    const elapsed = Date.now() - started;
    // Bounded return: well within timeoutMs+500 plus generous CI slack —
    // the process itself is allowed to still be alive at this point (D4.3/v2.1#2).
    expect(elapsed).toBeLessThan(300 + 500 + 2_000);
    expect(result.ok).toBe(false); // the real exec call is still in flight when runBoundedProbe's own deadline fires
    expect(result.reason).toBe("timeout");
    // The process survives the initial SIGTERM (trapped) — confirm it's still around briefly.
    let pidText = "";
    for (let i = 0; i < 20 && !pidText; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        pidText = (await execFileAsync("cat", [join(dir, "pid")])).stdout.trim();
      } catch {
        /* file not written yet */
      }
    }
    const pid = Number(pidText);
    if (pid > 0) {
      pids.push(pid);
      // Poll until SIGKILL reaps it (pi.exec's own ~5s fallback) — bounded wait, generous cap.
      const deadline = Date.now() + 10_000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false); // eventually reaped by SIGKILL, outside runBoundedProbe's own bound
    }
  }, 20_000);
});
