import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeadlineBudget, RunSnapshot, TimeoutPolicy } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { RuntimeRunner } from "../../src/runtime/runner.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * U2 (agent-explicit-timeout-extend plan §2.2 / §7): the spawn-admission
 * resolution formula, driven through the REAL seam — createSpawnService +
 * createRuntimeRunnerAdapter — with `RuntimeRunner.prototype.run` spied so
 * the exact (ResolvedSpawnRequest, DeadlineBudget) pair the runner would
 * execute is captured: `req.timeoutPolicy` (the resolved definite value the
 * adapter threads through), `budget.maxTotalFactor` (the fixed-deadline
 * clamp) and `budget.maxExtensions` (the extend.enabled kill switch), plus
 * the terminal snapshot's `diag.timeoutPolicy`.
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

const baseBudget: DeadlineBudget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 2_000,
  startupMs: 20_000,
  bindMs: 2_000,
  firstEventMs: 2_000,
  idleMs: 2_000,
  toolMs: 2_000,
  totalMs: 30_000,
  totalGraceMs: 0,
  abortGraceMs: 20,
  steerMs: 10,
  reapMs: 30,
};

function handle(sessionFile: string): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
  };
}

const flatNotifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

interface Captured {
  req: { runId: string; timeoutPolicy?: TimeoutPolicy };
  budget: DeadlineBudget;
}

function buildStack(
  clock: FakeClock,
  sessionFile: string,
  extensionsEnabled = true,
  durableRecords?: () => readonly RunSnapshot[],
) {
  const driver: SessionDriver = {
    create: async () => handle(sessionFile),
    resume: async (file: string) => handle(file),
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  const pool = new SingleSlotPool(clock, 4);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: baseBudget,
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: flatNotifier,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const snapshots: RunSnapshot[] = [];
  const svc = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
    budget: baseBudget,
    onSnapshot: (s: RunSnapshot) => snapshots.push(s),
    extensionsEnabled,
    ...(durableRecords === undefined ? {} : { durableRecords }),
  });
  return { svc, snapshots, clock, store };
}

let dir: string;
let fileSeq = 0;
const nextSessionFile = () => {
  const file = join(dir, `sess-${++fileSeq}.jsonl`);
  writeFileSync(file, "{}\n");
  return file;
};

describe("spawn admission timeoutPolicy resolution (§2.2, U2)", () => {
  let captured: Captured[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "timeout-policy-"));
    captured = [];
    const original = RuntimeRunner.prototype.run;
    spy = vi.spyOn(RuntimeRunner.prototype, "run").mockImplementation(function (this: RuntimeRunner, req, budget) {
      captured.push({ req: req as Captured["req"], budget });
      return original.call(this, req, budget);
    });
  });
  afterEach(() => {
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  async function drain(clock: FakeClock, ticks = 40, stepMs = 1) {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
      clock.advance(stepMs);
      await Promise.resolve();
    }
  }

  it.each<{
    name: string;
    request: { budgetOverride?: { totalMs: number }; timeoutPolicy?: TimeoutPolicy };
    extensionsEnabled?: boolean;
    policy: TimeoutPolicy;
    factor: number;
    extensions: number;
  }>([
    {
      name: "no override → extendable (shape ③, no totalMs)",
      request: {},
      policy: "extendable",
      factor: 2,
      extensions: 3,
    },
    {
      name: "budgetOverride.totalMs alone → fixed (programmatic explicit budget)",
      request: { budgetOverride: { totalMs: 5_000 } },
      policy: "fixed",
      factor: 1,
      extensions: 3,
    },
    {
      name: "budgetOverride.totalMs + explicit timeoutPolicy extendable → ① wins over shape",
      request: { budgetOverride: { totalMs: 5_000 }, timeoutPolicy: "extendable" },
      policy: "extendable",
      factor: 2,
      extensions: 3,
    },
    {
      name: "explicit timeoutPolicy fixed without totalMs → default budget hard-capped",
      request: { timeoutPolicy: "fixed" },
      policy: "fixed",
      factor: 1,
      extensions: 3,
    },
    {
      name: "explicit timeoutPolicy extendable alone → extendable",
      request: { timeoutPolicy: "extendable" },
      policy: "extendable",
      factor: 2,
      extensions: 3,
    },
    {
      name: "extensionsEnabled:false × extendable → policy survives, extensions zeroed (D-16)",
      request: { timeoutPolicy: "extendable" },
      extensionsEnabled: false,
      policy: "extendable",
      factor: 2,
      extensions: 0,
    },
  ])("%s", async ({ request, extensionsEnabled, policy, factor, extensions }) => {
    const clock = new FakeClock();
    const sessionFile = nextSessionFile();
    const { svc, snapshots } = buildStack(clock, sessionFile, extensionsEnabled ?? true);

    const spawned = await svc.spawn({ type: "worker", prompt: "x", ...request });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain(clock);

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const hit = captured.at(-1)!;
    expect(hit.req.runId).toBe(spawned.runId);
    expect(hit.req.timeoutPolicy).toBe(policy); // resolved definite value threads through
    expect(hit.budget.maxTotalFactor).toBe(factor);
    expect(hit.budget.maxExtensions).toBe(extensions);
    const terminal = snapshots.filter((s) => s.runId === spawned.runId && s.status === "completed").at(-1);
    expect(terminal?.diag.timeoutPolicy).toBe(policy); // mirrored into diag at enqueued
  });

  it("resume without an explicit policy inherits the original run's fixed policy (R-inherit ②)", async () => {
    const clock = new FakeClock();
    const { svc, snapshots } = buildStack(clock, nextSessionFile());

    // Original run: programmatic explicit budget ⇒ fixed, completes.
    const first = await svc.spawn({ type: "worker", prompt: "first", budgetOverride: { totalMs: 5_000 } });
    if ("error" in first) throw new Error(first.error.message);
    await drain(clock);
    expect(snapshots.filter((s) => s.runId === first.runId && s.status === "completed").length).toBeGreaterThan(0);

    // Resume with NO timeout_s / timeoutPolicy on the new request ⇒ inherit fixed.
    const resumed = await svc.spawn({ type: "worker", prompt: "again", resumeFrom: first.runId });
    if ("error" in resumed) throw new Error(resumed.error.message);
    await drain(clock);

    const hit = captured.find((c) => c.req.runId === resumed.runId);
    expect(hit?.req.timeoutPolicy).toBe("fixed");
    expect(hit?.budget.maxTotalFactor).toBe(1);
    const terminal = snapshots.filter((s) => s.runId === resumed.runId && s.status === "completed").at(-1);
    expect(terminal?.diag.timeoutPolicy).toBe("fixed");
  });

  it("resume of an extendable original inherits extendable; an explicit timeout_s policy still wins (① > ②)", async () => {
    const clock = new FakeClock();
    const { svc } = buildStack(clock, nextSessionFile());

    // Original: Agent-style request (timeout_s ⇒ extendable).
    const first = await svc.spawn({
      type: "worker",
      prompt: "first",
      budgetOverride: { totalMs: 5_000 },
      timeoutPolicy: "extendable",
    });
    if ("error" in first) throw new Error(first.error.message);
    await drain(clock);

    // Plain resume inherits extendable.
    const r1 = await svc.spawn({ type: "worker", prompt: "again", resumeFrom: first.runId });
    if ("error" in r1) throw new Error(r1.error.message);
    await drain(clock);
    expect(captured.find((c) => c.req.runId === r1.runId)?.req.timeoutPolicy).toBe("extendable");

    // And an explicit fixed policy on a fixed original still resolves fixed either way.
    const r2 = await svc.spawn({ type: "worker", prompt: "third", resumeFrom: first.runId, timeoutPolicy: "fixed" });
    if ("error" in r2) throw new Error(r2.error.message);
    await drain(clock);
    expect(captured.find((c) => c.req.runId === r2.runId)?.req.timeoutPolicy).toBe("fixed");
  });

  it("resume of an old (field-less) record falls through to the request shape (③)", async () => {
    const clock = new FakeClock();
    // A genuine pre-upgrade record: terminal, carries a session file, and never
    // had `diag.timeoutPolicy` persisted (live views AND the tombstone are
    // absent — injected as the durable-record view so nothing re-stamps it).
    const legacyFile = nextSessionFile();
    const legacy: RunSnapshot = {
      runId: "r_LEGACY01",
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: {
        createdAt: 0,
        phase: "settled",
        phaseEnteredAt: 0,
        pendingTools: 0,
        turns: 1,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        sessionFile: legacyFile,
      },
      updatedAt: 0,
    };
    const { svc } = buildStack(clock, nextSessionFile(), true, () => [legacy]);

    // Plain resume (no timeout_s / timeoutPolicy): ② finds nothing to inherit,
    // so ③ request shape decides — a plain request ⇒ default budget ⇒ extendable.
    // An explicit fixed original would resolve fixed under ② (proven above), so
    // this expectation only holds if the field-less fallback really reaches ③.
    const r1 = await svc.spawn({ type: "worker", prompt: "again", resumeFrom: legacy.runId });
    if ("error" in r1) throw new Error(r1.error.message);
    await drain(clock);
    const hit = captured.find((c) => c.req.runId === r1.runId);
    expect(hit?.req.timeoutPolicy).toBe("extendable");
    expect(hit?.budget.maxTotalFactor).not.toBe(1);
  });
});
