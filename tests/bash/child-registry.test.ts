import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RunExitFacts } from "../../src/core/types.js";
import {
  CHILD_BASH_REGISTRY_KEY,
  HOST_VIEW_CAPABILITY,
  KILL_ALL_BACKSTOP_MARGIN_MS,
  REGISTRY_CAP,
  declareHostBashViewCapability,
  getChildBashRegistry,
  hostBashViewCapabilityDeclared,
  type ChildBashEntry,
  type ChildBashRegistry,
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

describe("child-registry: resume unseal (todo #30)", () => {
  const hostView = (runId: string) => ({
    runId,
    watchdogDueAt: () => undefined,
    hardDeadlineAt: () => undefined,
    maxExtensions: () => 0,
    stopping: () => false,
    noteToolReturn: () => undefined,
  });

  /**
   * Reproduces the bug exactly (fixed by this change, fails without it): a
   * child session's bash manager is sealed at run-1's settle time
   * (`sealAndKill(sid, ..., runId1)`, mirroring `sealBeforeTerminal`/
   * `sealSession`). `resume` (same session file ⇒ pi's `SessionManager`
   * reproduces the exact same sessionId) starts run-2: the host attaches a
   * NEW runId for the same sessionId (`attachHost`, mirroring
   * `onSessionSeen`) before the child ever calls bash, then the child's
   * lazily-built manager calls `register()` on its first bash/bash_job
   * tool call. Before the fix this permanently threw "run is ending; no
   * new bash jobs" for the entire resumed run because `sealed` never
   * expires and is keyed only by sessionId, not by runId.
   */
  it("register() admits a resumed run's manager after a prior run of the SAME sessionId sealed it", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const runId1 = randomUUID();
    const runId2 = randomUUID();

    // run-1: attach host, register, then settle (seal).
    registry.attachHost(sid, hostView(runId1));
    const run1 = fakeEntry(sid);
    registry.register(run1.entry);
    const sealed1 = registry.sealAndKill(sid, 0, runId1);
    expect(sealed1).toBeDefined();
    expect(registry.isSealed(sid)).toBe(true);

    // resume: a NEW run for the SAME sessionId. The host attaches its view
    // (a fresh runId) before the child's manager ever registers — exactly
    // the ordering `onSessionSeen`/`onStateChange` guarantee (session_created
    // dispatches before extension_bind, long before any tool call).
    registry.attachHost(sid, hostView(runId2));
    const run2 = fakeEntry(sid);
    const result = registry.register(run2.entry);
    expect(result.generation).toBeGreaterThan(0);
    expect(run2.sealedCalls).toBe(0); // NOT immediately sealed — this is the fix
    expect(registry.isSealed(sid)).toBe(false); // admit() reads this directly

    // The resumed run's own eventual settle can seal it again, independently.
    const sealed2 = registry.sealAndKill(sid, 0, runId2);
    expect(sealed2).toBeDefined();
    expect(registry.isSealed(sid)).toBe(true);
    expect(run2.sealedCalls).toBe(1);
    await Promise.all([sealed1?.done, sealed2?.done]);
  });

  it("isSealed() alone (the admit() closure's own check) also unseals a resumed run's sessionId", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const runId1 = randomUUID();
    const runId2 = randomUUID();

    registry.attachHost(sid, hostView(runId1));
    registry.sealAndKill(sid, 0, runId1);
    expect(registry.isSealed(sid)).toBe(true);

    registry.attachHost(sid, hostView(runId2));
    expect(registry.isSealed(sid)).toBe(false); // unsealed as a side effect
    expect(registry.isSealed(sid)).toBe(false); // stays unsealed on repeat reads
  });

  it("a same-run late register (no host-view change) stays sealed — no regression on the original race", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const runId1 = randomUUID();

    registry.attachHost(sid, hostView(runId1));
    registry.sealAndKill(sid, 0, runId1); // no entry registered yet — sealed anyway (documented behavior)
    const late = fakeEntry(sid);
    const result = registry.register(late.entry); // same runId still attached — must NOT unseal
    expect(result.generation).toBeGreaterThan(0);
    expect(late.sealedCalls).toBe(1); // still immediately sealed
    expect(registry.isSealed(sid)).toBe(true);
  });

  /**
   * P1 review fix (bash-timeout-grace / todo #30 follow-up, §3.3/§3.9): reproduces the SECOND
   * bug the review found (fails without the fix — verified manually by reverting the
   * stale-caller guard at the top of `sealAndKill`). The prior test above covers the ORIGINAL
   * (already-fixed) shape: a resume's own `register()`/`isSealed()` correctly unseals a
   * sessionId a PRIOR run sealed. This one covers the OPPOSITE, previously-unhandled ordering:
   * run-1's own on-time `sealAndKill` already sealed and killed ITS entry; a resume (run-2) then
   * attaches its host view and registers a brand-new entry FOR THE SAME sessionId (exactly as
   * `onSessionSeen`/`register()` guarantee — host attaches before any tool call); only THEN does
   * run-1's late, defensive `onReaped` fan-out (`src/stack.ts`'s `sealAndKill(sid, grace, runId1)`
   * second call) finally arrive, well after run-2 is already live. Before the fix this re-sealed
   * the (now current) sessionId under run-1's stale runId and deleted+onSealed()+killAll()'d
   * run-2's OWN freshly-registered entry — a completely live, unrelated run silently losing bash
   * admission and having its jobs killed out from under it.
   */
  it("a stale caller's late sealAndKill (old run's defensive onReaped fan-out) after a resume's host+entry are already live must not touch the new run's entry (P1 §3.3/§3.9)", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const runId1 = randomUUID();
    const runId2 = randomUUID();

    // run-1: normal on-time seal (mirrors sealBeforeTerminal, synchronous, ahead of onReaped).
    registry.attachHost(sid, hostView(runId1));
    const run1 = fakeEntry(sid);
    registry.register(run1.entry);
    const sealed1 = registry.sealAndKill(sid, 0, runId1);
    expect(sealed1).toBeDefined();
    await sealed1?.done;

    // resume: run-2 attaches its host view and registers ITS OWN entry — fully live before
    // run-1's late fan-out ever arrives.
    registry.attachHost(sid, hostView(runId2));
    const run2 = fakeEntry(sid);
    registry.register(run2.entry);
    expect(registry.isSealed(sid)).toBe(false);
    expect(run2.sealedCalls).toBe(0);

    // LATE: run-1's own defensive onReaped fan-out finally fires (a second, redundant
    // `sealAndKill(sid, grace, runId1)` call for the SAME already-sealed-and-killed run-1) —
    // this must be a complete no-op now that run-2 owns the sessionId.
    const lateResult = registry.sealAndKill(sid, 0, runId1);
    expect(lateResult).toBeUndefined();

    // run-2's live entry must be completely untouched: not sealed, onSealed() never called a
    // second time, killAll() never invoked against it.
    expect(registry.isSealed(sid)).toBe(false);
    expect(run2.sealedCalls).toBe(0);
    expect(run2.killAllCallCount()).toBe(0);

    // run-2's own eventual settle can still seal it normally, independently.
    const sealed2 = registry.sealAndKill(sid, 0, runId2);
    expect(sealed2).toBeDefined();
    expect(run2.sealedCalls).toBe(1);
    await sealed2?.done;
  });

  it("without a fresher attachHost (no host wiring at all, or the pre-fix caller that omits runId), the seal stays sticky — conservative fallback", () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    registry.sealAndKill(sid, 0); // no runId passed (back-compat call shape)
    expect(registry.isSealed(sid)).toBe(true);
    const late = fakeEntry(sid);
    registry.register(late.entry);
    expect(late.sealedCalls).toBe(1);
    expect(registry.isSealed(sid)).toBe(true);
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

  it(`FIFO-caps whenSealed waiters at ${REGISTRY_CAP} sessionIds and RESOLVES the evicted oldest's waiters (never left pending, no timer involved)`, async () => {
    const registry = getChildBashRegistry();
    const prefix = `waiters-${randomUUID()}-`;
    let oldestWoke = false;
    const oldestP = registry
      .whenSealed(`${prefix}0`)
      .then(() => {
        oldestWoke = true;
      })
      .then(() => "woke"); // resolved ⇒ the chain settles, so awaiting cannot hang
    for (let i = 1; i <= REGISTRY_CAP; i++) void registry.whenSealed(`${prefix}${i}`); // 513 keys total ⇒ key 0 evicted while inserting key 512
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(oldestWoke).toBe(true); // resolved early — the sealed-waiter degradation, synchronously, without any timer
    await oldestP; // already settled; awaiting pins that the chain can never hang
    // The newest waiter is NOT resolved by the cap: it stays pending until its session actually seals.
    const newest = `${prefix}${REGISTRY_CAP}`;
    let newestWoke = false;
    const newestP = registry.whenSealed(newest).then(() => {
      newestWoke = true;
    });
    await Promise.resolve();
    expect(newestWoke).toBe(false);
    registry.sealAndKill(newest, 0);
    await newestP;
    expect(newestWoke).toBe(true);
  }, 20_000);

  it("re-touching an existing whenSealed key refreshes recency instead of evicting its own waiters", async () => {
    const registry = getChildBashRegistry();
    const sid = randomUUID();
    const other = randomUUID();
    let woke = false;
    const p = registry.whenSealed(sid).then(() => {
      woke = true;
    });
    void registry.whenSealed(other);
    void registry.whenSealed(sid); // re-insert: recency refresh, no eviction of `sid`
    await Promise.resolve();
    expect(woke).toBe(false); // still pending — not spuriously resolved by its own re-registration
    registry.sealAndKill(sid, 0);
    await p;
    expect(woke).toBe(true);
  });

  it("bounded degradation: a very-late register after its sealed tombstone was FIFO-evicted is retained and may be sealed a second time — safe because the entry's killAll is contractually memoized (§3.3 S3/S4)", async () => {
    const registry = getChildBashRegistry();
    const sid = `evicted-tombstone-${randomUUID()}`;
    registry.register(fakeEntry(sid).entry);
    await registry.sealAndKill(sid, 0)!.done; // first seal consumes the original entry
    // Push the tombstone out of the 512-cap sealed set.
    for (let i = 0; i <= REGISTRY_CAP; i++) registry.sealAndKill(`${sid}-pad-${i}`, 0);
    expect(registry.isSealed(sid)).toBe(false); // the documented sealed-set degradation
    // A register arriving AFTER the eviction falls into the retain path (register's comment)…
    let killCalls = 0;
    let memo: Promise<KillAllReport> | undefined;
    const late = fakeEntry(sid, {
      killAll: () => {
        killCalls++;
        memo ??= Promise.resolve(EMPTY_REPORT); // memoized per §3.3 S3 — the contract that makes the second seal kill-free
        return memo;
      },
    });
    registry.register(late.entry);
    // …so a later sealAndKill for the same id runs a SECOND seal of that sessionId.
    const second = registry.sealAndKill(sid, 0);
    expect(second).toBeDefined();
    await second!.done;
    expect(late.sealedCalls).toBe(1); // the late entry was sealed (its first and only)
    expect(killCalls).toBe(1); // but the memoized killAll still killed at most once across both seals
    // And the entry still unregisters normally (no zombie in `entries`).
  });
});

describe("child-registry: host capability declaration (child-bash no-host-view diag, L1 todo #20)", () => {
  it("is undeclared by default for a name nobody has declared yet", () => {
    const registry = getChildBashRegistry();
    expect(registry.hasHostCapability(`nobody-declared-${randomUUID()}`)).toBe(false);
  });

  it("declareHostCapability makes hasHostCapability true until release() is called", () => {
    const registry = getChildBashRegistry();
    const name = `cap-${randomUUID()}`;
    const release = registry.declareHostCapability(name, 1);
    expect(registry.hasHostCapability(name)).toBe(true);
    release();
    expect(registry.hasHostCapability(name)).toBe(false);
  });

  it("release() is idempotent: calling it twice never under-releases a DIFFERENT still-live declaration", () => {
    const registry = getChildBashRegistry();
    const name = `cap-idempotent-${randomUUID()}`;
    const releaseA = registry.declareHostCapability(name, 1);
    const releaseB = registry.declareHostCapability(name, 1); // a second, independent "stack" declares the same name
    releaseA();
    releaseA(); // double-release must not decrement twice
    expect(registry.hasHostCapability(name)).toBe(true); // B's declaration is still live
    releaseB();
    expect(registry.hasHostCapability(name)).toBe(false);
  });

  it("reference-counts across multiple concurrent declarations — releasing one never clears another still-live one (multi-stack-in-one-process safety)", () => {
    const registry = getChildBashRegistry();
    const name = `cap-refcount-${randomUUID()}`;
    const release1 = registry.declareHostCapability(name, 1);
    const release2 = registry.declareHostCapability(name, 1);
    const release3 = registry.declareHostCapability(name, 1);
    release1();
    expect(registry.hasHostCapability(name)).toBe(true);
    release2();
    expect(registry.hasHostCapability(name)).toBe(true);
    release3();
    expect(registry.hasHostCapability(name)).toBe(false);
  });

  it("declareHostBashViewCapability / hostBashViewCapabilityDeclared use HOST_VIEW_CAPABILITY and never throw against an OLD-shaped registry object missing the new methods (cross-module-version safety)", () => {
    // Mirrors a registry object created by an older child-registry.ts module
    // version sharing this process's `Symbol.for` singleton slot — it has
    // every method THIS test file's real registry needs elsewhere, but not
    // the two new capability methods.
    const oldShaped = {
      register: () => ({ generation: 1, unregister: () => undefined }),
      attachHost: () => undefined,
      hostView: () => undefined,
      isSealed: () => false,
      whenSealed: () => Promise.resolve(),
      sealAndKill: () => undefined,
      sealAll: () => Promise.resolve(),
      // declareHostCapability / hasHostCapability deliberately absent.
    } as unknown as ChildBashRegistry;
    expect(() => declareHostBashViewCapability(oldShaped)).not.toThrow();
    const release = declareHostBashViewCapability(oldShaped);
    expect(() => release()).not.toThrow(); // the no-op release must also be safe to call
    expect(() => hostBashViewCapabilityDeclared(oldShaped)).not.toThrow();
    expect(hostBashViewCapabilityDeclared(oldShaped)).toBe(false); // undeclared reads as silent-default
  });

  it("declareHostBashViewCapability / hostBashViewCapabilityDeclared round-trip through HOST_VIEW_CAPABILITY on a real (current) registry", () => {
    const registry = getChildBashRegistry();
    expect(hostBashViewCapabilityDeclared(registry)).toBe(registry.hasHostCapability(HOST_VIEW_CAPABILITY));
    const release = declareHostBashViewCapability(registry);
    expect(hostBashViewCapabilityDeclared(registry)).toBe(true);
    release();
  });
});
