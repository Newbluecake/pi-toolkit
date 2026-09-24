import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { Reaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";
import { removeForkFile } from "../../src/consult/fork-store.js";

/**
 * consult plan §9 T-15 (package B half): the fork-file cleanup matrix for
 * `RunnerDeps.onReaped(runId, forkSessionFrom?)` — normal settle, create
 * failure, late-arrival rebirth, non-fork runs — plus the T-21-order property
 * ("reap earlier than the caller observes the outcome") driven with explicit
 * deferred signals, never timing.
 *
 * The onReaped double below is exactly what wireConsult will wire in package C
 * (§4.4): removeForkFile on the threaded path — so the file-system state is
 * the assertion, not just callback bookkeeping.
 */

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 100,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 50,
  steerMs: 2,
};

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "answer",
    getUsage: () => undefined,
    ...overrides,
  };
}

class FakeWatchdog implements Watchdog {
  arm() {}
  disarm() {}
  tick() {}
}

interface Harness {
  clock: FakeClock;
  runner: RuntimeRunner;
  reaped: Array<{ runId: string; forkSessionFrom?: string }>;
  log: string[];
  releaseReapGate: () => void;
  releaseBeforeReapGate: () => void;
}

const tempDirs: string[] = [];
function consultDir(): string {
  const d = mkdtempSync(join(tmpdir(), "consult-reap-"));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeForkFile(dir: string): string {
  const f = join(dir, `fork-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "session", version: 3, id: "forked", timestamp: "t", cwd: dir })}\n`);
  return f;
}

async function drain(ticks = 60) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/**
 * Real EscalatingReaper wrapped in a recorder, with optional gates for reap
 * and beforeReap so tests can hold physical reclamation open deterministically.
 */
function harness(
  driver: SessionDriver,
  dir: string,
  opts: { gateReap?: boolean; gateBeforeReap?: boolean; onReapedThrows?: boolean } = {},
): Harness {
  const clock = new FakeClock();
  const log: string[] = [];
  const reaped: Harness["reaped"] = [];
  const real = new EscalatingReaper(clock);
  let releaseReap: () => void = () => undefined;
  const reapGate = new Promise<void>((r) => {
    releaseReap = r;
  });
  let releaseBeforeReap: () => void = () => undefined;
  const beforeReapGate = new Promise<void>((r) => {
    releaseBeforeReap = r;
  });
  const reaper: Reaper = {
    registry: real.registry,
    abortReap: (runId, gen) => real.abortReap(runId, gen),
    async reap(input) {
      log.push("reap:start");
      if (opts.gateReap) await reapGate;
      const out = await real.reap(input);
      log.push("reap:end");
      return out;
    },
    disposeLate(runId, gen, h) {
      real.disposeLate(runId, gen, h);
      log.push("disposeLate");
    },
  };
  const d: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    watchdog: new FakeWatchdog(),
    reaper,
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
    ...(opts.gateBeforeReap
      ? {
          beforeReap: async () => {
            log.push("beforeReap");
            await beforeReapGate;
          },
        }
      : {}),
    onReaped: (runId, forkSessionFrom) => {
      log.push("onReaped");
      reaped.push({ runId, forkSessionFrom });
      if (opts.onReapedThrows) throw new Error("cleanup hook exploded");
      if (forkSessionFrom !== undefined) removeForkFile(forkSessionFrom, dir); // package C's wireConsult semantics
    },
  };
  return {
    clock,
    runner: new RuntimeRunner(d),
    reaped,
    log,
    releaseReapGate: releaseReap,
    releaseBeforeReapGate: releaseBeforeReap,
  };
}

const baseDriver = (extra: Partial<SessionDriver> = {}): SessionDriver => ({
  create: async () => {
    throw new Error("fresh create must not run for a fork request");
  },
  bind: async () => undefined,
  onLateArrival() {},
  ...extra,
});

describe("RuntimeRunner consult fork: session_create dispatch (§4.4)", () => {
  it("opens forkSessionFrom through driver.resume and threads it to onReaped after reap (T-15 normal settle)", async () => {
    const dir = consultDir();
    const forkFile = makeForkFile(dir);
    let resumedWith = "";
    const h = harness(
      baseDriver({
        resume: async (file) => {
          resumedWith = file;
          return handle({ sessionFile: file });
        },
      }),
      dir,
      { gateBeforeReap: true, gateReap: true },
    );

    const runPromise = h.runner.run(
      { runId: "r-fork-ok", prompt: "q", forkSessionFrom: forkFile } satisfies ResolvedSpawnRequest,
      budget,
    );
    await drain();
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(resumedWith).toBe(forkFile);
    expect(existsSync(forkFile)).toBe(true); // nothing deleted yet — reap is gated open
    expect(h.reaped).toEqual([]);

    // Release order proves the chain: beforeReap → reaper.reap → onReaped.
    h.releaseBeforeReapGate();
    await drain();
    expect(h.log).toContain("beforeReap");
    expect(h.log).toContain("reap:start"); // reap entered, parked on its own gate
    expect(h.log).not.toContain("reap:end");
    expect(h.reaped).toEqual([]);
    h.releaseReapGate();
    await drain();
    expect(h.log.indexOf("reap:end")).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf("reap:end")).toBeLessThan(h.log.indexOf("onReaped"));
    expect(h.log.indexOf("beforeReap")).toBeLessThan(h.log.indexOf("reap:start"));
    expect(h.reaped).toEqual([{ runId: "r-fork-ok", forkSessionFrom: forkFile }]);
    expect(existsSync(forkFile)).toBe(false);
  });

  it("settles the run and deletes the fork when driver.resume rejects (T-15 create failure)", async () => {
    const dir = consultDir();
    const forkFile = makeForkFile(dir);
    const h = harness(
      baseDriver({
        resume: async () => {
          throw new Error("session file unreadable");
        },
      }),
      dir,
    );
    const outcome = await h.runner.run({ runId: "r-fork-fail", prompt: "q", forkSessionFrom: forkFile }, budget);
    await drain();
    // guard() reports a rejected create as reason "cancelled" which the runner
    // labels kind "timeout" ⇒ startup_failed settles timed_out (existing
    // semantics, unchanged by consult) — the cleanup seam is what we assert.
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("session_create");
    expect(h.reaped).toEqual([{ runId: "r-fork-fail", forkSessionFrom: forkFile }]);
    expect(existsSync(forkFile)).toBe(false);
    // A rejected create promise never reaches onLateArrival's callback —
    // exactly one onReaped, from the finally's runReap chain.
    expect(h.log.filter((l) => l === "onReaped")).toHaveLength(1);
    expect(h.log).not.toContain("disposeLate");
  });

  it("re-deletes the reborn fragment after disposeLate (T-15 late arrival, review-2 #10)", async () => {
    const dir = consultDir();
    const forkFile = makeForkFile(dir);
    let lateResolve: (h: SessionHandle) => void = () => undefined;
    const lateP = new Promise<SessionHandle>((r) => {
      lateResolve = r;
    });
    const driver = baseDriver({
      resume: () => lateP, // hangs past the startup budget
      onLateArrival(p, cb) {
        p.then(cb, () => undefined);
      },
    });
    const h = harness(driver, dir);

    const runPromise = h.runner.run({ runId: "r-fork-late", prompt: "q", forkSessionFrom: forkFile }, budget);
    await drain();
    h.clock.advance(11); // past startupMs=10 → create guard times out
    const outcome = await runPromise;
    await drain();
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("session_create");
    // First delete: runReap had no handle, so it completed immediately after settle.
    expect(h.reaped).toEqual([{ runId: "r-fork-late", forkSessionFrom: forkFile }]);
    expect(existsSync(forkFile)).toBe(false);

    // The late session finally arrives; its dispose() simulates pi's
    // `_persist` (appendFileSync) resurrecting a headerless fragment.
    lateResolve(
      handle({
        sessionFile: forkFile,
        dispose: () => {
          // Simulates pi's `_persist` (appendFileSync) resurrecting a
          // headerless fragment after the unlink.
          appendFileSync(forkFile, `${JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "t" })}\n`);
          return { returned: true, killed: 0, unkillable: [] };
        },
      }),
    );
    await drain();
    expect(h.log).toContain("disposeLate");
    expect(h.reaped).toHaveLength(2); // second, idempotent onReaped after disposeLate
    expect(existsSync(forkFile)).toBe(false); // reborn fragment deleted again
  });

  it("calls onReaped with forkSessionFrom === undefined for non-fork runs and deletes nothing", async () => {
    const dir = consultDir();
    const innocent = makeForkFile(dir);
    const h = harness(
      baseDriver({
        create: async () => handle({ sessionFile: innocent }), // a NORMAL run may legitimately create
      }),
      dir,
    );
    const outcome = await h.runner.run({ runId: "r-normal", prompt: "q" }, budget);
    await drain();
    expect(outcome.status).toBe("completed");
    expect(h.reaped).toEqual([{ runId: "r-normal", forkSessionFrom: undefined }]);
    expect(existsSync(innocent)).toBe(true); // undefined path ⇒ no deletion
  });

  it("never lets a throwing onReaped break the runner", async () => {
    const dir = consultDir();
    const forkFile = makeForkFile(dir);
    const h = harness(baseDriver({ resume: async (file) => handle({ sessionFile: file }) }), dir, {
      onReapedThrows: true,
    });
    const outcome = await h.runner.run({ runId: "r-throw", prompt: "q", forkSessionFrom: forkFile }, budget);
    await drain();
    expect(outcome.status).toBe("completed");
    expect(h.reaped).toHaveLength(1); // the hook ran (and threw); the runner settled fine
  });
});

describe("RuntimeRunner consult fork: reap-vs-outcome ordering (T-21 property, no timers)", () => {
  it("order A — outcome observed first, physical reap (and deletion) strictly later", async () => {
    const dir = consultDir();
    const forkFile = makeForkFile(dir);
    const h = harness(baseDriver({ resume: async (file) => handle({ sessionFile: file }) }), dir, {
      gateReap: true,
    });
    const runPromise = h.runner.run({ runId: "r-order-a", prompt: "q", forkSessionFrom: forkFile }, budget);
    await drain();
    const outcome = await runPromise; // caller observes the result while reap is gated open
    expect(outcome.status).toBe("completed");
    expect(h.reaped).toEqual([]); // nothing reaped yet
    expect(existsSync(forkFile)).toBe(true); // still intact — no deletion-before-reap race
    h.releaseReapGate();
    await drain();
    expect(h.reaped).toEqual([{ runId: "r-order-a", forkSessionFrom: forkFile }]);
    expect(existsSync(forkFile)).toBe(false);
  });

  it("order B — physical reap (and deletion) completes before the caller ever awaits the outcome", async () => {
    const dir = consultDir();
    const forkFile = makeForkFile(dir);
    const h = harness(
      baseDriver({
        resume: async () => {
          throw new Error("instant failure — reap is near-zero work");
        },
      }),
      dir,
    );
    const runPromise = h.runner.run({ runId: "r-order-b", prompt: "q", forkSessionFrom: forkFile }, budget);
    // Do NOT await runPromise yet: pump microtasks until onReaped has fired —
    // the run settles and is physically reaped entirely on its own chain.
    for (let i = 0; i < 200 && h.reaped.length === 0; i++) await Promise.resolve();
    expect(h.reaped).toEqual([{ runId: "r-order-b", forkSessionFrom: forkFile }]);
    expect(existsSync(forkFile)).toBe(false); // already deleted — the result is not lost for it
    const outcome = await runPromise; // late observer still gets the settled outcome immediately
    expect(outcome.status).toBe("timed_out"); // failed resume ⇒ timeoutReason session_create
  });
});
