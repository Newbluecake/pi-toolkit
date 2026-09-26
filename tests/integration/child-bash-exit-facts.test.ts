import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeliveryPayload, RunExitFacts } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import { formatExitFacts } from "../../src/tools/result-text.js";
import { createPiOutboxStore, OUTBOX_CUSTOM_TYPE, type PiOutboxHost } from "../../src/adapters/pi-outbox-store.js";
import { createNotifier, type PersistedDelivery } from "../../src/delivery/notifier.js";

/**
 * bash-timeout-grace plan §3.2/§3.7/§3.8 (P5, T25-T27): the value chain from
 * a sealed run's `RunExitFacts` all the way to `get_subagent_result`'s
 * rendered text, exercised through `createRuntimeRunnerAdapter` with a fake
 * driver (same harness shape as tests/service/runtime-adapter-x3-x10.test.ts)
 * so this covers the ACTUAL wiring this package added (`RuntimeAdapterDeps.
 * sealSession`/`onSessionSeen`), not just the P0b state-machine mechanics
 * already proven by tests/runtime/runner-session-hooks.test.ts's I-SEAL.
 */
function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "child-session-1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
    ...overrides,
  };
}
function buildAdapter(clock: FakeClock, overrides: Partial<RuntimeAdapterDeps> & { driver: SessionDriver }) {
  const pool = new SingleSlotPool(clock, 1);
  const store = overrides.store ?? new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const notifier = overrides.notifier ?? {
    enqueue: () => undefined,
    finalize: () => "missing" as const,
    settleBatch: () => undefined,
    peek: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
  };
  return createRuntimeRunnerAdapter({ clock, pool, store, watchdog, reaper, notifier, ...overrides });
}
function spec(type: AgentTypeConfig, overrides: Partial<RunnerSpec["request"]> = {}): RunnerSpec {
  return { runId: "r1", type, request: { type: type.name, prompt: "hi", ...overrides }, budget: fastBudget() };
}
function plainType(): AgentTypeConfig {
  return { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };
}
function makeFacts(tag: string): RunExitFacts {
  return {
    bashJobs: [
      {
        jobId: `j_${tag}`,
        commandPreview: "sleep 30",
        state: "terminating",
        exitCode: null,
        logPath: `/tmp/${tag}.log`,
        durationMs: 12_000,
        seen: false,
      },
    ],
  };
}

/**
 * T26/T27 (P5b item 4): the REAL persistence path (`createPiOutboxStore` +
 * `createNotifier`, byte-identical wiring to `src/stack.ts`'s own
 * `outbox`/`notifier` construction) backed by a plain array standing in for
 * `pi.sessionManager.getEntries()` — `appendEntry` pushes into it
 * synchronously, exactly like the real `pi.appendEntry`. A "restart" is
 * modeled the same way `buildSessionStack` itself models `/reload`: a
 * SECOND `createPiOutboxStore` fed the SAME array as `prefetched`. No
 * `buildSessionStack` call is involved (nothing here touches `~/.pi/agent`
 * or any real filesystem/session-manager state), so `sandboxHome()` does
 * not apply — this is the "equivalent real persistence path" the P5b task
 * calls for as an alternative to a full stack rebuild.
 */
function realOutboxHost(
  entries: { type: string; customType?: string; data?: unknown }[],
  prefetched?: readonly { type: string; customType?: string; data?: unknown }[],
): { host: PiOutboxHost; outbox: ReturnType<typeof createPiOutboxStore<PersistedDelivery>> } {
  const host: PiOutboxHost = {
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
    },
    sessionManager: { getEntries: () => entries },
  };
  const outbox = createPiOutboxStore<PersistedDelivery>(host, OUTBOX_CUSTOM_TYPE, prefetched);
  return { host, outbox };
}

describe("exit facts value chain (T25-T27)", () => {
  it("T25: sealSession's facts land in the outcome, the store snapshot, AND get_subagent_result's rendered text", async () => {
    const clock = new FakeClock();
    const facts = makeFacts("t25");
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const store = new MemoryRunStore();
    const runner = buildAdapter(clock, {
      driver,
      store,
      sealSession: (runId, sessionId) => {
        expect(sessionId).toBe("child-session-1");
        return runId === "r1" ? facts : undefined;
      },
    });
    const outcome = await runner.run(spec(plainType()));
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.exitFacts).toEqual(facts);
    // persist_snapshot (state-machine finish()) — the store snapshot mirrors it (P0b, frozen).
    expect(store.get("r1")?.outcome?.diag.exitFacts).toEqual(facts);
    // get_subagent_result's formatOutcome (this package's T25 wiring).
    const rendered = formatExitFacts(outcome.diag.exitFacts);
    expect(rendered).toContain("j_t25");
    expect(rendered).toContain("terminating");
  });

  it("T25: sealSession returning undefined (no bash jobs) leaves diag.exitFacts absent", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, sealSession: () => undefined });
    const outcome = await runner.run(spec(plainType()));
    expect(outcome.diag.exitFacts).toBeUndefined();
    expect(formatExitFacts(outcome.diag.exitFacts)).toBeUndefined();
  });

  it("T26: enqueue_delivery's payload lands in a REAL outbox (createPiOutboxStore) synchronously — no crash window between finish() and persistence", async () => {
    const clock = new FakeClock();
    const facts = makeFacts("t26");
    const entries: { type: string; customType?: string; data?: unknown }[] = [];
    const { outbox } = realOutboxHost(entries);
    const sent: DeliveryPayload[] = [];
    const notifier = createNotifier({
      store: outbox,
      clock,
      maxAttempts: 3,
      backoffMs: 1_000,
      reconcileTtlMs: 24 * 60 * 60 * 1_000,
      maxReconcileRounds: 3,
      maxBatch: 10,
      cancelBuffered: () => undefined,
      sender: (payload) => {
        sent.push(payload);
      },
    });
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, notifier, sealSession: () => facts });
    const outcome = await runner.run(spec(plainType()));

    // The crash-window claim (§3.7): `sealSession → exit_facts → finish() →
    // enqueue_delivery → notifier.enqueue → outbox.put → pi.appendEntry` all
    // happen inside ONE synchronous call stack (no `await` in between) — so by
    // the time `run()` has already resolved, the REAL entry log (`entries`,
    // standing in for `pi.sessionManager.getEntries()`) must already contain
    // the persisted record. This is the actual `createPiOutboxStore.put()`
    // code path, not a manual JSON round-trip.
    const persisted = entries.find(
      (e) => e.customType === OUTBOX_CUSTOM_TYPE && (e.data as PersistedDelivery | undefined)?.runId === "r1",
    );
    expect(persisted).toBeDefined();
    const persistedPayload = persisted!.data as PersistedDelivery;
    expect(persistedPayload.exitFacts).toEqual(facts);
    expect(persistedPayload.exitFacts).toEqual(outcome.diag.exitFacts);
    // The notifier's own immediate delivery attempt also carries it (model-facing send).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.exitFacts).toEqual(facts);
  });

  it("T27: a fresh createPiOutboxStore fed the SAME entry log after a simulated restart recovers exitFacts and redelivers", async () => {
    const clock = new FakeClock();
    const facts = makeFacts("t27");
    const entries: { type: string; customType?: string; data?: unknown }[] = [];
    const { outbox: outboxBeforeCrash } = realOutboxHost(entries);
    const notifierBeforeCrash = createNotifier({
      store: outboxBeforeCrash,
      clock,
      maxAttempts: 3,
      backoffMs: 1_000,
      reconcileTtlMs: 24 * 60 * 60 * 1_000,
      maxReconcileRounds: 3,
      maxBatch: 10,
      cancelBuffered: () => undefined,
      // The crash happens BEFORE delivery is confirmed (the realistic window
      // §3.7 cares about — a record already "delivered" needs no redelivery
      // at all, so that case would prove nothing here): the first send throws,
      // leaving the persisted record in state "pending" (`settleFailed`,
      // attempts=1 < maxAttempts=3), exactly as if the process died before
      // the notification actually reached anyone.
      sender: () => {
        throw new Error("simulated crash before delivery confirmed");
      },
    });
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, notifier: notifierBeforeCrash, sealSession: () => facts });
    await runner.run(spec(plainType()));
    expect(entries.length).toBeGreaterThan(0); // sanity: something really was persisted before "crashing"

    // Simulate a restart: a brand-new process re-imports the SAME persisted
    // entry log as `prefetchedEntries` (`src/stack.ts`'s own `/reload`/resume
    // wiring, byte-identical call shape: `createPiOutboxStore(host,
    // OUTBOX_CUSTOM_TYPE, prefetchedEntries)`) — no shared in-memory state
    // with the pre-crash notifier/outbox beyond the plain entry array.
    const sentAfterRestart: DeliveryPayload[] = [];
    const { outbox: outboxAfterRestart } = realOutboxHost([], entries);
    const notifierAfterRestart = createNotifier({
      store: outboxAfterRestart,
      clock,
      maxAttempts: 3,
      backoffMs: 1_000,
      reconcileTtlMs: 24 * 60 * 60 * 1_000,
      maxReconcileRounds: 3,
      maxBatch: 10,
      cancelBuffered: () => undefined,
      sender: (payload) => {
        sentAfterRestart.push(payload);
      },
    });

    const report = notifierAfterRestart.reconcile();
    expect(report.redelivered).toEqual(["r1:1"]);
    expect(sentAfterRestart).toHaveLength(1);
    expect(sentAfterRestart[0]!.exitFacts).toEqual(facts);
    expect(formatExitFacts(sentAfterRestart[0]!.exitFacts)).toBe(formatExitFacts(facts));
  });

  it("onReaped forwards sessionId as a defensive fan-out point (E18 late-arrival call sites)", async () => {
    const clock = new FakeClock();
    const seen: Array<{ runId: string; forkSessionFrom?: string; sessionId?: string }> = [];
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, {
      driver,
      onReaped: (runId, forkSessionFrom, sessionId) => {
        seen.push({ runId, ...(forkSessionFrom !== undefined ? { forkSessionFrom } : {}), sessionId });
      },
    });
    await runner.run(spec(plainType()));
    // `notifyReaped` (runner.ts) is chained onto reap's own promise via
    // `.then()`, fired-and-forgotten — it can land a tick or two after
    // `run()` itself resolves. Poll briefly instead of asserting instantly.
    await vi.waitFor(() => {
      expect(seen.some((entry) => entry.runId === "r1" && entry.sessionId === "child-session-1")).toBe(true);
    });
  });
});
