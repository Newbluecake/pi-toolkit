import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunSnapshot, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "../../src/service/spawn-service.js";

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md \u00a76 D-group, \u00a77): real
 * `SpawnService` + `RuntimeRunner` integration coverage for the pieces this
 * package (`wf-experts`) actually owns end-to-end.
 *
 * **Scope note (mandatory reading before touching this file)**: tests
 * #27/#29/#30/#31 in the plan's \u00a76 test list depend on package B's
 * `spawn-service.ts` `stopping`-set fork-admission guard (\u00a74.7,
 * `fix(spawn): reject consult fork admission while the parent is stopping or
 * gone`) and/or package C's `resolveExperts(refs, { completedOnly })`
 * (`src/consult/index.ts`) \u2014 **neither file is in this package's domain**
 * (\u00a77's `wf-experts` globs). Per the task's file-domain constraint, this
 * suite only implements what is testable against the *current*, unmodified
 * `src/service/spawn-service.ts`: #28 (slotless consult-shaped admission
 * alongside a full workflow slot, unaffected by B) below. #27/#29/#30/#31
 * are left as explicit `it.skip` placeholders with the exact blocking
 * dependency named, per the task's "flag pending items rather than
 * approximate them" instruction \u2014 **re-run this file once B and C land**.
 */

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget(totalMs: number) {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 2_000,
    startupMs: 5_000,
    bindMs: 2_000,
    firstEventMs: 2_000,
    idleMs: 2_000,
    toolMs: 2_000,
    totalMs,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
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

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

function buildFullStack(clock: FakeClock, driver: SessionDriver, extensions: SubagentExtensionPoints[] = []) {
  const pool = new SingleSlotPool(clock, 1); // maxParallel-equivalent: exactly one global slot (test #28's setup)
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(30_000),
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
    extensions,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const svc: SpawnService & { snapshots(): readonly RunSnapshot[] } = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
  });
  return { pool, store, svc };
}

describe("workflow-experts \u00a76 D#28: consult spawn admission alongside a full workflow slot", () => {
  it("with the single global slot held by the workflow's own child R, a slotless fork-shaped consult spawn is admitted immediately; a second, non-slotless workflow agent() spawn still queues on the slot", async () => {
    const clock = new FakeClock();
    // R's own prompt() never resolves -- it must stay "running" (holding the
    // sole global slot) for the whole test, until explicitly aborted below.
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => new Promise(() => {}) }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc, pool } = buildFullStack(clock, driver);

    // R: the workflow's own first child, occupying the sole global slot.
    const r = await svc.spawn({ type: "worker", prompt: "R", budgetOverride: { totalMs: 60_000 } });
    if ("error" in r) throw new Error(r.error.message);
    await drain(clock, 3);
    expect(pool.stats.inUse).toBe(1); // R holds the one global slot

    // A consult-shaped spawn (forkSessionFrom + slotless: true, exactly how
    // the real consult tool dispatches -- forkSessionFrom skips the canSpawn
    // gate and the SlotPool entirely) must be admitted immediately, never
    // queued behind R.
    const forkDir = mkdtempSync(join(tmpdir(), "wf-experts-fork-"));
    const forkFile = join(forkDir, "expert-fork.jsonl");
    writeFileSync(forkFile, "");
    const consultSpawn = await svc.spawn({
      type: "worker",
      prompt: "consult-C",
      slotless: true,
      parentRunId: r.runId,
      forkSessionFrom: forkFile,
      budgetOverride: { totalMs: 10_000 },
    });
    expect("error" in consultSpawn).toBe(false);

    // The slotless consult call above must not have touched the SlotPool at
    // all -- R still alone holds the one global slot.
    expect(pool.stats.inUse).toBe(1);
    expect(pool.stats.slotless).toBe(1);

    // A second, ordinary (non-slotless) workflow agent() call still queues
    // behind R on the one global slot -- confirms the slotless consult call
    // above did not "steal" R's slot or otherwise perturb FIFO ordering.
    // (spawn() itself always resolves quickly with a runId regardless of
    // slot availability -- admission is synchronous, the real slot wait
    // happens inside the runner's own async start(), so `pool.stats` is the
    // only reliable signal here, not spawn()'s own resolution.)
    const second = await svc.spawn({ type: "worker", prompt: "second-child", budgetOverride: { totalMs: 60_000 } });
    if ("error" in second) throw new Error(second.error.message);
    await drain(clock, 3);
    expect(pool.stats.inUse).toBe(1); // still just R -- the second child is queued, not running
    expect(pool.stats.queued).toBe(1);

    await svc.abort(r.runId, "user_stop");
    await drain(clock, 5);
    expect(pool.stats.inUse).toBe(1); // the queued second child has now taken the freed slot
    expect(pool.stats.queued).toBe(0);
  });
});

describe("workflow-experts \u00a76 D#27/#29/#30/#31: blocked pending package B/C \u2014 re-run once merged", () => {
  it.skip("D#27: abort(R) racing a consult fork-spawn admission in the same tick rejects with 'parent run is stopping or gone' (needs spawn-service.ts's `stopping` set, package B \u00a74.7)", () => {
    // Intentionally not implemented here: this package's file domain
    // excludes src/service/spawn-service.ts. Once package B lands, port
    // tests/service/spawn-fork-admission.test.ts's scenarios (or extend
    // this file) to also exercise a real workflow R + a real consult-shaped
    // fork spawn racing abort(R) in the same synchronous tick.
  });

  it.skip("D#29: workflow stop/killAt aborts R, which cascades to abort a fork-spawned consult child C; stopOwned finishes within abortGraceMs with no leftover timers (needs package B's stopping guard to be meaningful \u2014 today's cascadeChildren already aborts a plain child, but the interesting race this test targets is B's)", () => {
    // Cascade-abort of an *already admitted* plain child is already covered
    // by existing spawn-service tests; the workflow-specific value of #29 is
    // asserting the *forkSessionFrom* path specifically, which is B's guard.
  });

  it.skip("D#30: normal completion path \u2014 R absorbs C's usage exactly once (absorbedRunIds), workflow aggregation and /agent costs do not double count (needs the real consult tool + resolveExperts wiring end-to-end, package C)", () => {
    // Package A's own contribution (SpawnRequest.consultExperts forwarding,
    // ChildSpawner.resolveExperts) is covered by spawner-adapter.test.ts and
    // host.test.ts; the usage-absorption accounting itself lives in
    // runtime-adapter.ts/request-threading.ts and is exercised by consult's
    // own existing test suite, not this package.
  });

  it.skip('D#31: consult in progress when R is aborted \u2014 workflow aggregation under-counts C\'s usage (known D20 gap), but global HUD/"+agents" still counts it (needs the real consult tool end-to-end, package C)', () => {
    // Same dependency as #30 \u2014 the cost-absorption machinery under test
    // here is entirely outside src/workflow/**/spawner-adapter.ts.
  });
});
