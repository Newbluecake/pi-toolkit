import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RunExitFacts } from "../../src/core/types.js";
import {
  CHILD_BASH_REGISTRY_KEY,
  KILL_ALL_BACKSTOP_MARGIN_MS,
  REGISTRY_CAP,
  getChildBashRegistry,
  type ChildBashEntry,
  type KillAllReport,
} from "../../src/bash/child-registry.js";

/**
 * bash-timeout-grace plan §3.1/§7 T2: the process-level child bash registry.
 * Every test uses a fresh `randomUUID()` sessionId — the registry is a real
 * process-wide `Symbol.for` singleton (mirrors worktree-origin.ts's pattern,
 * survives /reload by design) and sessionIds are never reused in practice, so
 * unique ids give full test isolation without needing (or wanting) a reset
 * hook. See tests/core/worktree-origin.test.ts for the same convention.
 */

const EMPTY_REPORT: KillAllReport = { killed: [], alreadyDone: [], orphaned: [], pending: [] };

function facts(n = 0): RunExitFacts {
  return {
    bashJobs: [
      {
        jobId: `j_${n}`,
        commandPreview: "sleep 5",
        state: "terminating",
        exitCode: null,
        logPath: `/tmp/j_${n}.log`,
        durationMs: 100,
        seen: false,
      },
    ],
  };
}

function fakeEntry(
  sessionId: string,
  opts: {
    exitFacts?: () => RunExitFacts;
    killAll?: (graceMs: number) => Promise<KillAllReport>;
    onSealed?: () => void;
  } = {},
): { entry: Omit<ChildBashEntry, "generation">; sealedCalls: number; killAllCallCount: () => number } {
  let sealedCalls = 0;
  let killAllCallCount = 0;
  const entry: Omit<ChildBashEntry, "generation"> = {
    sessionId,
    exitFacts: opts.exitFacts ?? (() => facts()),
    killAll: async (graceMs: number) => {
      killAllCallCount++;
      return (opts.killAll ?? (async () => EMPTY_REPORT))(graceMs);
    },
    onSealed: () => {
      sealedCalls++;
      opts.onSealed?.();
    },
  };
  return {
    entry,
    get sealedCalls() {
      return sealedCalls;
    },
    killAllCallCount: () => killAllCallCount,
  };
}

describe("child-registry: process-level singleton (bash-timeout-grace plan §3.1)", () => {
  it("getChildBashRegistry() returns the same instance across calls (Symbol.for singleton, survives /reload)", () => {
    expect(getChildBashRegistry()).toBe(getChildBashRegistry());
    const g = globalThis as Record<symbol, unknown>;
    expect(g[CHILD_BASH_REGISTRY_KEY]).toBe(getChildBashRegistry());
  });

  it("generation is monotonic per sessionId, independent across sessionIds", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const { entry } = fakeEntry(sid);
    const r1 = registry.register(entry);
    expect(r1.generation).toBe(1);
    r1.unregister();
    const r2 = registry.register(entry);
    expect(r2.generation).toBe(2);
    const other = randomUUID();
    const { entry: entry2 } = fakeEntry(other);
    expect(registry.register(entry2).generation).toBe(1);
  });

  it("unregister is a no-op once superseded by a later registration for the same sessionId (stale handle)", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const { entry } = fakeEntry(sid);
    const r1 = registry.register(entry);
    const r2 = registry.register(entry);
    r1.unregister(); // stale — must not remove r2's live entry
    const result = registry.sealAndKill(sid, 0);
    expect(result).toBeDefined(); // r2's entry is still registered
  });

  it("attachHost / hostView round-trip, undefined for an unknown sessionId", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    expect(registry.hostView(sid)).toBeUndefined();
    const view = {
      runId: "r1",
      watchdogDueAt: () => undefined,
      hardDeadlineAt: () => undefined,
      maxExtensions: () => 3,
      stopping: () => false,
      noteToolReturn: () => undefined,
    };
    registry.attachHost(sid, view);
    expect(registry.hostView(sid)).toBe(view);
  });
});

describe("child-registry: sealAndKill idempotency (T2)", () => {
  it("first call seals, reads exitFacts, calls onSealed, and starts killAll; second call returns undefined", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const f = facts(1);
    const state = fakeEntry(sid, { exitFacts: () => f, killAll: async () => EMPTY_REPORT });
    registry.register(state.entry);
    expect(registry.isSealed(sid)).toBe(false);

    const first = registry.sealAndKill(sid, 100);
    expect(first).toBeDefined();
    expect(first?.facts).toEqual(f);
    expect(registry.isSealed(sid)).toBe(true);
    expect(state.sealedCalls).toBe(1);

    const second = registry.sealAndKill(sid, 100);
    expect(second).toBeUndefined();
    expect(state.sealedCalls).toBe(1); // not called again

    await first?.done;
  });

  it("killAll is invoked exactly once even though sealAndKill can only ever succeed once (memoize via idempotency)", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const state = fakeEntry(sid, { killAll: async () => EMPTY_REPORT });
    registry.register(state.entry);
    const r1 = registry.sealAndKill(sid, 50);
    const r2 = registry.sealAndKill(sid, 50);
    const r3 = registry.sealAndKill(sid, 50);
    expect(r1).toBeDefined();
    expect(r2).toBeUndefined();
    expect(r3).toBeUndefined();
    await r1?.done;
    expect(state.killAllCallCount()).toBe(1);
  });

  it("registering into an already-sealed sessionId immediately seals the new entry and is not retained", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    registry.register(fakeEntry(sid).entry);
    registry.sealAndKill(sid, 0); // seals; the first entry is consumed/removed
    const late = fakeEntry(sid);
    const result = registry.register(late.entry);
    expect(result.generation).toBeGreaterThan(0);
    expect(late.sealedCalls).toBe(1); // onSealed called immediately on the late entry
    // Nothing left to seal a second time — the late entry was never retained.
    expect(registry.sealAndKill(sid, 0)).toBeUndefined();
  });

  it("a throwing exitFacts()/onSealed()/killAll() never breaks sealAndKill (best-effort diagnostics)", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const entry: Omit<ChildBashEntry, "generation"> = {
      sessionId: sid,
      exitFacts: () => {
        throw new Error("boom-facts");
      },
      onSealed: () => {
        throw new Error("boom-sealed");
      },
      killAll: async () => {
        throw new Error("boom-kill");
      },
    };
    registry.register(entry);
    const result = registry.sealAndKill(sid, 10);
    expect(result).toBeDefined();
    expect(result?.facts).toEqual({ bashJobs: [] }); // fallback on a throwing exitFacts
    await expect(result?.done).resolves.toEqual(EMPTY_REPORT); // a rejecting killAll resolves to the empty report, never throws
  });

  it("a sessionId with no registered entry still becomes sealed on first call but reports nothing", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    expect(registry.isSealed(sid)).toBe(false);
    expect(registry.sealAndKill(sid, 10)).toBeUndefined();
    expect(registry.isSealed(sid)).toBe(true); // sealed anyway (irreversible, session-level)
    expect(registry.sealAndKill(sid, 10)).toBeUndefined(); // still idempotent
  });
});

describe("child-registry: whenSealed (T2)", () => {
  it("resolves immediately for an already-sealed sessionId", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    registry.sealAndKill(sid, 0);
    await expect(registry.whenSealed(sid)).resolves.toBeUndefined();
  });

  it("resolves exactly when sealAndKill is called, for multiple concurrent waiters", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    registry.register(fakeEntry(sid).entry);
    let resolved = 0;
    const p1 = registry.whenSealed(sid).then(() => resolved++);
    const p2 = registry.whenSealed(sid).then(() => resolved++);
    await Promise.resolve();
    expect(resolved).toBe(0);
    registry.sealAndKill(sid, 0);
    await Promise.all([p1, p2]);
    expect(resolved).toBe(2);
  });
});

describe('child-registry: killAll backstop (T2 "unref 超时进 pending")', () => {
  it("resolves with the pre-seal facts folded into pending/alreadyDone once the entry's own killAll exceeds graceMs + backstop margin", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const f: RunExitFacts = {
      bashJobs: [
        {
          jobId: "j_run",
          commandPreview: "x",
          state: "terminating",
          exitCode: null,
          logPath: "/l1",
          durationMs: 1,
          seen: false,
        },
        {
          jobId: "j_done",
          commandPreview: "y",
          state: "completed",
          exitCode: 0,
          logPath: "/l2",
          durationMs: 1,
          seen: true,
        },
      ],
    };
    const state = fakeEntry(sid, {
      exitFacts: () => f,
      killAll: () => new Promise<KillAllReport>(() => undefined), // never resolves
    });
    registry.register(state.entry);
    // A short bound: graceMs negative enough that max(0,graceMs)+margin is tiny.
    const graceMs = -(KILL_ALL_BACKSTOP_MARGIN_MS - 15);
    const result = registry.sealAndKill(sid, graceMs);
    expect(result).toBeDefined();
    const report = await result!.done;
    expect(report.pending).toEqual(["j_run"]);
    expect(report.alreadyDone).toEqual(["j_done"]);
    expect(report.killed).toEqual([]);
    expect(report.orphaned).toEqual([]);
  });

  it("resolves with the entry's own report immediately when killAll settles before the backstop fires", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const real: KillAllReport = { killed: ["j_1"], alreadyDone: [], orphaned: [], pending: [] };
    const state = fakeEntry(sid, { killAll: async () => real });
    registry.register(state.entry);
    const result = registry.sealAndKill(sid, 1_000);
    await expect(result!.done).resolves.toEqual(real);
  });
});

describe("child-registry: sealAll (session_shutdown, S6)", () => {
  it("seals and awaits every currently-registered (unsealed) entry", async () => {
    const registry = getChildBashRegistry();
    const a = randomUUID();
    const b = randomUUID();
    const already = randomUUID();
    const calls: string[] = [];
    registry.register(fakeEntry(a, { killAll: async () => (calls.push("a"), EMPTY_REPORT) }).entry);
    registry.register(fakeEntry(b, { killAll: async () => (calls.push("b"), EMPTY_REPORT) }).entry);
    registry.sealAndKill(already, 0); // already sealed beforehand — sealAll must not double-seal it
    await registry.sealAll(50);
    expect(registry.isSealed(a)).toBe(true);
    expect(registry.isSealed(b)).toBe(true);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("never rejects even when every entry's killAll rejects", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    registry.register(
      fakeEntry(sid, {
        killAll: async () => {
          throw new Error("boom");
        },
      }).entry,
    );
    await expect(registry.sealAll(10)).resolves.toBeUndefined();
  });
});

describe("child-registry: FIFO capacity bound (T2, no blanket clear)", () => {
  it(`evicts the OLDEST unsealed entry past the ${REGISTRY_CAP} cap`, () => {
    const registry = getChildBashRegistry();
    const prefix = `fifo-${randomUUID()}-`;
    const first = `${prefix}0`;
    registry.register(fakeEntry(first).entry);
    for (let i = 1; i <= REGISTRY_CAP; i++) registry.register(fakeEntry(`${prefix}${i}`).entry);
    // REGISTRY_CAP + 1 total registrations over the cap → the very first is evicted.
    expect(registry.sealAndKill(first, 0)).toBeUndefined(); // evicted ⇒ "nothing registered" (but note: this ALSO marks it sealed)
    const stillThere = `${prefix}${REGISTRY_CAP}`;
    expect(registry.sealAndKill(stillThere, 0)).toBeDefined();
  }, 20_000);
});
