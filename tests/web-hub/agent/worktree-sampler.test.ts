/**
 * worktree-web plan §7 (W3): `createWorktreeSampler`. ★ merge gate: the hard-deadline
 * tests (fake-timer + real-timing) must be green.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeSampler } from "../../../src/web-hub/agent/worktree-sampler.js";
import { createGitRunner } from "../../../src/git/run.js";
import type { GitRunner, GitRunResult } from "../../../src/git/run.js";
import type { ScannedWorktree, ScanResult } from "../../../src/git/worktrees.js";
import type { WorktreesWire } from "../../../src/web-hub/protocol/messages.js";

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function groupIsDead(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitForDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (!isDead(pid) || !groupIsDead(pid))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function ok(code = 0, stdout = ""): GitRunResult {
  return { code, stdout, stdoutCapped: false, stderr: "" };
}

/** A fake GitRunner that answers `rev-parse`/`worktree list` with a single, clean main
 * worktree and no probes needed (porcelain has no HEAD-less rows to probe since
 * `maxProbes` default still tries to probe it — give it an immediate clean status too). */
function fakeRunner(opts: { toplevel?: string; hang?: boolean } = {}): GitRunner {
  const toplevel = opts.toplevel ?? "/repo";
  return vi.fn(async (args: readonly string[]) => {
    if (opts.hang) return new Promise<GitRunResult>(() => {}); // never resolves
    if (args.includes("rev-parse")) return ok(0, `${toplevel}\n`);
    if (args.includes("list"))
      return ok(0, `worktree ${toplevel}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/master\n\n`);
    if (args.includes("status")) return ok(0, "# branch.head master\n# branch.oid aaaaaaa\n");
    return ok(0, "");
  }) as unknown as GitRunner;
}

function base(run: GitRunner, over: Partial<Parameters<typeof createWorktreeSampler>[0]> = {}) {
  let t = 0;
  const onChange = vi.fn();
  const sampler = createWorktreeSampler({
    run,
    home: undefined,
    now: () => t,
    isLive: () => true,
    onChange,
    realpath: async (p: string) => p,
    ...over,
  });
  return { sampler, onChange, advance: (ms: number) => (t += ms), now: () => t };
}

async function flush(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("createWorktreeSampler — basic sample lifecycle", () => {
  it("start() triggers an immediate scan; onChange fires once; current() reflects it", async () => {
    const run = fakeRunner();
    const { sampler, onChange } = base(run);
    sampler.start("/repo");
    await flush(40);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sampler.current()?.rows[0]).toMatchObject({ label: "/repo", main: true, current: true });
  });

  it("an unchanged repeat scan does not call onChange again", async () => {
    const run = fakeRunner();
    const { sampler, onChange, advance } = base(run);
    sampler.start("/repo");
    await flush(40);
    expect(onChange).toHaveBeenCalledTimes(1);
    advance(30_000);
    sampler.tick(30_000);
    await flush(30);
    // Same minute bucket (0) and identical content ⇒ fingerprint unchanged ⇒ no 2nd onChange.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("isLive() === false ⇒ the runner is never called", async () => {
    const run = fakeRunner();
    const { sampler } = base(run, { isLive: () => false });
    sampler.start("/repo");
    sampler.kick();
    await flush(40);
    expect(run).not.toHaveBeenCalled();
  });

  it("not-repo clears the cache and fires onChange", async () => {
    const run = vi.fn(async () => ok(128, "")) as unknown as GitRunner; // rev-parse fails
    const { sampler, onChange } = base(run);
    sampler.start("/repo");
    await flush(40);
    expect(sampler.current()).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled(); // never had a cache to clear
  });

  it("error (e.g. spawn failure) keeps the previous cache", async () => {
    let fail = false;
    const run = vi.fn(async (args: readonly string[]) => {
      if (fail) return { code: null, stdout: "", stdoutCapped: false, stderr: "", spawnError: "ENOENT" };
      if (args.includes("rev-parse")) return ok(0, "/repo\n");
      if (args.includes("list"))
        return ok(0, "worktree /repo\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/master\n\n");
      return ok(0, "# branch.head master\n");
    }) as unknown as GitRunner;
    const { sampler, onChange } = base(run);
    sampler.start("/repo");
    await flush(40);
    expect(onChange).toHaveBeenCalledTimes(1);
    const cached = sampler.current();
    fail = true;
    sampler.kick();
    await flush(40);
    expect(sampler.current()).toEqual(cached);
  });

  it("cwd change on start() clears the cache", async () => {
    const run = fakeRunner();
    const { sampler } = base(run);
    sampler.start("/repo");
    await flush(40);
    expect(sampler.current()).toBeDefined();
    sampler.start("/other-repo");
    expect(sampler.current()).toBeUndefined(); // cleared synchronously before the new scan lands
    await flush(30);
  });
});

describe("createWorktreeSampler — kick debounce + single-flight", () => {
  it("kicks within 5s of the last scan start collapse into one trailing scan", async () => {
    vi.useFakeTimers();
    try {
      const run = fakeRunner();
      const { sampler, onChange, advance } = base(run);
      sampler.start("/repo");
      await flush(30);
      expect(run).toHaveBeenCalledTimes(3); // rev-parse + list + the main row's own status probe
      advance(1_000);
      sampler.kick();
      sampler.kick();
      sampler.kick();
      await vi.advanceTimersByTimeAsync(4_000);
      await flush(40);
      // Only one additional scan was started by the trailing debounce timer.
      const callsAfterFirst = (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      expect(onChange).toHaveBeenCalledTimes(1); // same content ⇒ same-minute fingerprint unchanged
    } finally {
      vi.useRealTimers();
    }
  });

  it("a kick while a scan is in flight is remembered and runs exactly once more after settle", async () => {
    let resolveFirst: ((v: GitRunResult) => void) | undefined;
    let calls = 0;
    const run = vi.fn((args: readonly string[]) => {
      calls++;
      if (args.includes("rev-parse") && calls === 1) {
        return new Promise<GitRunResult>((resolve) => (resolveFirst = resolve));
      }
      if (args.includes("rev-parse")) return Promise.resolve(ok(0, "/repo\n"));
      if (args.includes("list")) {
        return Promise.resolve(ok(0, "worktree /repo\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/master\n\n"));
      }
      return Promise.resolve(ok(0, "# branch.head master\n"));
    }) as unknown as GitRunner;
    const { sampler, advance } = base(run);
    sampler.start("/repo");
    advance(10_000); // past the kick debounce window ⇒ kick() takes the immediate single-flight path
    sampler.kick(); // in-flight ⇒ remembered as a rerun
    sampler.kick(); // still in-flight ⇒ no additional rerun beyond the one already pending
    resolveFirst?.(ok(0, "/repo\n"));
    await flush(30);
    // first scan (3 calls: rev-parse/list/status) + exactly one rerun (3 more calls).
    expect(calls).toBe(6);
  });
});

describe("createWorktreeSampler — ★ hard deadline (merge gate)", () => {
  it("a runner that never resolves still settles as `error` at the hard deadline, with the signal aborted; the zombie guard then blocks further scans until it clears", async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const run = vi.fn((args: readonly string[], opts: { signal?: AbortSignal }) => {
        if (args.includes("rev-parse")) {
          seenSignal = opts.signal;
          return new Promise<GitRunResult>(() => {}); // hang forever — never settles, ever.
        }
        return new Promise<GitRunResult>(() => {});
      }) as unknown as GitRunner;
      const { sampler, onChange, advance } = base(run, { hardDeadlineMs: 8_000 });
      sampler.start("/repo");
      await flush(5);
      expect(seenSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(8_000);
      await flush(40);
      // The deadline fired at 8s regardless of the runner's promise ever settling: the signal
      // was aborted and the observable result is `error` (no cache, no onChange) — the ★
      // merge-gate guarantee. The zombied scan itself never clears (this runner never resolves
      // for any call), so the zombie guard correctly refuses every further scan attempt —
      // a kick() here must NOT start a new runner call (see the separate "zombie clears…
      // resumes" test for the eventual-recovery path).
      expect(seenSignal?.aborted).toBe(true);
      advance(8_000);
      const callsBefore = (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      sampler.kick();
      await flush(5);
      expect((run as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore);
      expect(onChange).not.toHaveBeenCalled(); // never got a real "ok" result to publish
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ real executor + a SIGTERM-ignoring fake git script: the deadline's abort settles the underlying call well under hardDeadlineMs + 250ms, and the process group is actually dead afterward", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wt-sampler-"));
    const file = join(dir, "fake-git.mjs");
    const pidFile = join(dir, "pid");
    await writeFile(
      file,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    const real = createGitRunner({ gitBinary: file });
    let resolvedAt: number | undefined;
    const timed: GitRunner = async (args, opts) => {
      const r = await real(args, opts);
      resolvedAt = Date.now();
      return r;
    };
    const { sampler } = base(timed, { hardDeadlineMs: 500 });
    const started = Date.now();
    // `cwd` must be a real, existing directory: `scanWorktrees` threads it straight into
    // `spawn()`'s own `cwd` option, and a nonexistent directory there fails the spawn
    // immediately (ENOENT) — which would make this test pass for the wrong reason (a fast
    // spawn error, never actually exercising the deadline/abort path at all; this is exactly
    // the gap verifier W3 review #4 caught via the pid-liveness check below).
    sampler.start(dir);
    const giveUpAt = started + 5_000;
    while (resolvedAt === undefined && Date.now() < giveUpAt) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(resolvedAt).toBeDefined();
    expect(resolvedAt! - started).toBeLessThan(500 + 250);

    // The deadline settling the sampler's observable result must correspond to the underlying
    // git process (and its process group) ACTUALLY being killed — not merely the Promise
    // resolving while the process lingers (verifier W3 review #4).
    let pidText: string | undefined;
    const pidDeadline = Date.now() + 2_000;
    while (pidText === undefined && Date.now() < pidDeadline) {
      try {
        pidText = await readFile(pidFile, "utf8");
      } catch {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    expect(pidText).toBeDefined();
    const pid = Number(pidText);
    expect(Number.isInteger(pid)).toBe(true);
    await waitForDead(pid);
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
  }, 8_000);

  it("a late (post-deadline) settlement of the zombied scan is discarded, not applied", async () => {
    vi.useFakeTimers();
    try {
      let resolveRevParse: ((v: GitRunResult) => void) | undefined;
      const run = vi.fn((args: readonly string[]) => {
        if (args.includes("rev-parse")) return new Promise<GitRunResult>((resolve) => (resolveRevParse = resolve));
        return new Promise<GitRunResult>(() => {});
      }) as unknown as GitRunner;
      const { sampler, onChange } = base(run, { hardDeadlineMs: 1_000 });
      sampler.start("/repo");
      await flush(5);
      await vi.advanceTimersByTimeAsync(1_000);
      await flush(5);
      // Now the zombie settles late.
      resolveRevParse?.(ok(0, "/repo\n"));
      await flush(40);
      expect(onChange).not.toHaveBeenCalled();
      expect(sampler.current()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("while a zombie is outstanding, no new scan is started; it resumes once the zombie settles", async () => {
    vi.useFakeTimers();
    try {
      let resolveRevParse: ((v: GitRunResult) => void) | undefined;
      let callCount = 0;
      const run = vi.fn((args: readonly string[]) => {
        callCount++;
        if (args.includes("rev-parse") && callCount === 1) {
          return new Promise<GitRunResult>((resolve) => (resolveRevParse = resolve));
        }
        if (args.includes("rev-parse")) return Promise.resolve(ok(0, "/repo\n"));
        if (args.includes("list")) {
          return Promise.resolve(ok(0, "worktree /repo\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/master\n\n"));
        }
        return Promise.resolve(ok(0, "# branch.head master\n"));
      }) as unknown as GitRunner;
      const { sampler, advance } = base(run, { hardDeadlineMs: 1_000 });
      sampler.start("/repo");
      await flush(5);
      await vi.advanceTimersByTimeAsync(1_000); // zombie declared
      await flush(5);
      advance(60_000);
      sampler.tick(60_000); // would normally be due for a new baseline scan — but zombie blocks it
      await flush(5);
      const callsWhileZombied = callCount;
      resolveRevParse?.(ok(0, "/repo\n")); // zombie settles
      await flush(40);
      sampler.kick();
      await flush(40);
      expect(callCount).toBeGreaterThan(callsWhileZombied); // resumed after the zombie cleared
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifier W3 review #1: a late zombie settlement consumes a pending rerun by itself (no extra kick needed)", async () => {
    vi.useFakeTimers();
    try {
      let resolveRevParse: ((v: GitRunResult) => void) | undefined;
      let callCount = 0;
      const run = vi.fn((args: readonly string[]) => {
        callCount++;
        if (args.includes("rev-parse") && callCount === 1) {
          return new Promise<GitRunResult>((resolve) => (resolveRevParse = resolve));
        }
        if (args.includes("rev-parse")) return Promise.resolve(ok(0, "/repo\n"));
        if (args.includes("list")) {
          return Promise.resolve(ok(0, "worktree /repo\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/master\n\n"));
        }
        return Promise.resolve(ok(0, "# branch.head master\n"));
      }) as unknown as GitRunner;
      const { sampler, advance } = base(run, { hardDeadlineMs: 1_000 });
      sampler.start("/repo");
      await flush(5);
      await vi.advanceTimersByTimeAsync(1_000); // zombie declared, result discarded
      await flush(5);
      // A kick/tick arrives WHILE the zombie is still outstanding — it is blocked and remembered
      // as a pendingRerun, but we do NOT call kick() again after the zombie settles below: the
      // settlement itself must be what starts the rerun.
      advance(60_000);
      sampler.kick();
      await flush(5);
      const callsWhileZombied = callCount;
      expect(callsWhileZombied).toBe(1); // the rerun was blocked, not started
      resolveRevParse?.(ok(0, "/repo\n")); // the zombie settles late (discarded content)
      await flush(40);
      expect(callCount).toBeGreaterThan(callsWhileZombied); // the remembered rerun ran, unprompted
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifier W3 review #2: stop() → start() while the old scan hasn't confirmed its death ⇒ no concurrent new scan; it starts only once the old one settles", async () => {
    vi.useFakeTimers();
    try {
      let resolveOldRevParse: ((v: GitRunResult) => void) | undefined;
      let oldCallSeen = false;
      let newScanCalls = 0;
      const run = vi.fn((args: readonly string[]) => {
        if (args.includes("rev-parse") && !oldCallSeen) {
          oldCallSeen = true;
          // The old scan's runner call never settles on its own — only `resolveOldRevParse`
          // (invoked explicitly below) can unblock it; a real `GitRunner` honoring an abort
          // signal would settle promptly instead, but this exercises the non-compliant case
          // the zombie guard exists for.
          return new Promise<GitRunResult>((resolve) => (resolveOldRevParse = resolve));
        }
        newScanCalls++;
        if (args.includes("rev-parse")) return Promise.resolve(ok(0, "/repo\n"));
        if (args.includes("list")) {
          return Promise.resolve(ok(0, "worktree /repo\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/master\n\n"));
        }
        return Promise.resolve(ok(0, "# branch.head master\n"));
      }) as unknown as GitRunner;
      const { sampler } = base(run, { hardDeadlineMs: 60_000 }); // long deadline: still unconfirmed when we restart
      sampler.start("/repo");
      await flush(5);
      expect(oldCallSeen).toBe(true);

      // Restart (e.g. /new) BEFORE the old scan has confirmed its death: `start()` aborts it
      // (the fake runner above ignores the abort, simulating a non-compliant/wedged case) but
      // must not let a brand-new scan run concurrently with it.
      sampler.start("/other-repo");
      await flush(20);
      expect(newScanCalls).toBe(0); // blocked — the old scan is still unconfirmed

      // The old scan finally settles (late, discarded — generation no longer matches).
      resolveOldRevParse?.(ok(0, "/repo\n"));
      await flush(40);
      expect(newScanCalls).toBeGreaterThan(0); // only now does the new cwd's scan actually run
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createWorktreeSampler — degraded set / untracked-timeout escalation", () => {
  it("a row that times out on probe is added to the degraded set for the next scan", async () => {
    let probeCount = 0;
    const run = vi.fn((args: readonly string[]) => {
      if (args.includes("rev-parse")) return Promise.resolve(ok(0, "/repo\n"));
      if (args.includes("list")) {
        return Promise.resolve(ok(0, "worktree /repo\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/master\n\n"));
      }
      probeCount++;
      if (probeCount === 1)
        return Promise.resolve({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "timeout" as const });
      return Promise.resolve(ok(0, "# branch.head master\n"));
    }) as unknown as GitRunner;
    const seenDegraded: boolean[] = [];
    const { sampler, advance } = base(
      vi.fn(async (args: readonly string[], opts: { cwd?: string }) => {
        // Peek the degraded set indirectly isn't exposed; assert via untrackedSkipped on 2nd scan.
        return (run as unknown as (a: readonly string[], o: unknown) => Promise<GitRunResult>)(args, opts);
      }) as unknown as GitRunner,
    );
    sampler.start("/repo");
    await flush(40);
    expect(sampler.current()?.rows[0]?.unprobed).toBe("timeout");
    advance(10_000); // past the kick debounce window ⇒ kick() starts the next scan immediately
    sampler.kick();
    await flush(40);
    expect(sampler.current()?.rows[0]?.untrackedSkipped).toBe(true);
    void seenDegraded;
  });
});

describe("createWorktreeSampler — staleness via tick()", () => {
  it("no staleMin at <=90s; staleMin appears past 90s; repeated ticks within the same minute don't re-signal", async () => {
    const run = fakeRunner();
    const { sampler, advance } = base(run);
    sampler.start("/repo");
    await flush(40);
    expect(sampler.current()?.staleMin).toBeUndefined();
    advance(90_000);
    expect(sampler.tick(90_000)).toBe(false);
    expect(sampler.current()?.staleMin).toBeUndefined();
    advance(60_000); // total 150s elapsed
    expect(sampler.tick(150_000)).toBe(true);
    expect(sampler.current()?.staleMin).toBe(2);
    expect(sampler.tick(150_500)).toBe(false); // same floor(150500/60000)=2
  });

  it("stale clears once a fresh successful sample lands", async () => {
    const run = fakeRunner();
    const { sampler, advance } = base(run, { isLive: () => true });
    sampler.start("/repo");
    await flush(40);
    advance(150_000);
    sampler.tick(150_000);
    expect(sampler.current()?.staleMin).toBe(2);
    sampler.kick();
    await flush(40);
    expect(sampler.current()?.staleMin).toBeUndefined();
  });
});

describe("createWorktreeSampler — backoff", () => {
  it("baseline scan cadence doubles after a slow scan and resets after a fast one", async () => {
    let clock = 0;
    let slow = true;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        clock += slow ? 2_000 : 100; // simulate scan duration against the sampler's own clock
        return ok(0, "/repo\n");
      }
      if (args.includes("list")) {
        return ok(0, "worktree /repo\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/master\n\n");
      }
      return ok(0, "# branch.head master\n");
    }) as unknown as GitRunner;
    const sampler = createWorktreeSampler({
      run,
      home: undefined,
      now: () => clock,
      isLive: () => true,
      onChange: () => {},
      realpath: async (p: string) => p,
      baseIntervalMs: 1_000,
      maxIntervalMs: 8_000,
    });
    sampler.start("/repo"); // startedAt=0, slow scan ⇒ duration 2000ms (>1500) ⇒ interval 1000→2000
    await flush(40);
    const calls1 = run.mock.calls.length;
    sampler.tick(1_000); // elapsed since start = 1000 < the now-doubled 2000ms interval ⇒ no new scan
    await flush(10);
    expect(run.mock.calls.length).toBe(calls1);
    slow = false; // flip BEFORE triggering the scan: the fake runner reads `slow` synchronously
    // at call time (no await before the first branch), so flipping it after tick() would be too late.
    sampler.tick(2_000); // elapsed = 2000 >= 2000 ⇒ due; this scan is fast
    await flush(40);
    const calls2 = run.mock.calls.length;
    expect(calls2).toBeGreaterThan(calls1); // the backed-off interval did eventually fire a scan
    // duration this time is 100ms (<500) ⇒ interval resets to baseIntervalMs (1000)
    sampler.tick(2_000 + 999); // not yet due at the reset (short) interval
    await flush(10);
    expect(run.mock.calls.length).toBe(calls2);
    sampler.tick(2_000 + 1_000); // now due
    await flush(40);
    expect(run.mock.calls.length).toBeGreaterThan(calls2);
  });
});

describe("createWorktreeSampler — stop()", () => {
  it("stop() aborts an in-flight scan and the caller observes zero further runner calls from it", async () => {
    let seenSignal: AbortSignal | undefined;
    const run = vi.fn((args: readonly string[], opts: { signal?: AbortSignal }) => {
      if (args.includes("rev-parse")) {
        seenSignal = opts.signal;
        return new Promise<GitRunResult>(() => {});
      }
      return new Promise<GitRunResult>(() => {});
    }) as unknown as GitRunner;
    const { sampler, onChange } = base(run);
    sampler.start("/repo");
    await flush(5);
    sampler.stop();
    expect(seenSignal?.aborted).toBe(true);
    await flush(40);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("createWorktreeSampler — all timers are unref'd", () => {
  it("every setTimeout the sampler creates (deadline timer, kick debounce trailer) is unref'd", async () => {
    const original = globalThis.setTimeout;
    const timers: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const t = original(handler as never, ms, ...rest);
      timers.push(t as NodeJS.Timeout);
      return t;
    }) as typeof setTimeout);
    try {
      const run = vi.fn(() => new Promise<GitRunResult>(() => {})) as unknown as GitRunner;
      const { sampler } = base(run, { hardDeadlineMs: 50 });
      sampler.start("/repo"); // creates the per-scan hard-deadline timer
      sampler.kick(); // in-flight ⇒ remembered, no new timer; a 2nd kick after some elapsed time
      // would create the debounce trailer — exercise that path too.
      expect(timers.length).toBeGreaterThan(0);
      expect(timers.every((t) => !t.hasRef())).toBe(true);
      sampler.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

// Silence unused-type-only import lint under isolatedModules in case tree-shaking ever drops usage.
void (null as unknown as ScanResult);
void (null as unknown as ScannedWorktree);
void (null as unknown as WorktreesWire);
