import { describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome, SpawnRequest } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

/**
 * L1 (agent-tool pool-full plan §1/§2/§4): SpawnService-level admission
 * tests. A fake pool that exposes a live-updatable `.stats.limit` (the
 * atomicity anchor is spawn-service's own `slotfulLabel` bookkeeping, never
 * `pool.stats.inUse` — see the doc comment on the reject-check in
 * spawn-service.ts) and a fake runner whose `run()` never resolves, so an
 * admitted run stays "running" (occupying a conceptual slot) for the whole
 * test without needing a real session lifecycle.
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fakePool(limit: number): SlotPool {
  const state = { limit, inUse: 0, queued: 0, slotless: 0 };
  return {
    acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }),
    setLimit: (n) => {
      state.limit = n;
    },
    get stats() {
      return { ...state };
    },
  };
}

/** A runner whose run() hangs forever — the spawned run stays "running" (never calls finish()) for the test's lifetime. */
const hangingRunner: Runner = { run: () => new Promise<RunOutcome>(() => undefined) };

function deps(limit: number, runner: Runner = hangingRunner) {
  return {
    types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
    pool: fakePool(limit),
    runner,
    now: () => 0,
  };
}

async function spawnOk(service: ReturnType<typeof createSpawnService>, req: SpawnRequest) {
  const r = await service.spawn(req);
  if ("error" in r) throw new Error(r.error.message);
  return r;
}

describe("SpawnService pool-full admission (L1)", () => {
  it("rejects a reject-policy spawn immediately once the pool is full, naming the running count and labels", async () => {
    const d = deps(2);
    const service = createSpawnService(d);
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });
    await spawnOk(service, { type: "worker", prompt: "b", label: "task-b" });

    const rejected = await service.spawn({
      type: "worker",
      prompt: "c",
      label: "task-c",
      poolFullPolicy: "reject",
    });
    expect("error" in rejected).toBe(true);
    if (!("error" in rejected)) throw new Error("expected rejection");
    expect(rejected.error.message).toContain("slots: 2/2 in use, 0 free");
    expect(rejected.error.message).toContain("task-a");
    expect(rejected.error.message).toContain("task-b");
    expect(rejected.error.message).toMatch(/concurrencyLimit/);
  });

  it("creates no run, no label, no record for a rejected reject-policy spawn", async () => {
    const d = deps(1);
    const service = createSpawnService(d);
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });

    const rejected = await service.spawn({ type: "worker", prompt: "b", label: "task-b", poolFullPolicy: "reject" });
    expect("error" in rejected).toBe(true);
    // No label "task-b" was ever registered (the reject happens before the
    // label-planning/registration section runs at all).
    expect(service.getLabel?.("task-b")).toBeUndefined();
    // Nothing besides task-a shows up in the live snapshot list.
    expect(service.snapshots().map((s) => s.diag.label)).not.toContain("task-b");
  });

  it("never lets concurrent same-tick reject-policy dispatches exceed the limit (admission is atomic)", async () => {
    const d = deps(1);
    const service = createSpawnService(d);
    // Fired together, no await between them — spawn()'s admission section
    // has zero internal awaits, so each call's synchronous body (including
    // the reject-check + slotfulLabel reservation) runs to completion before
    // the next one starts, exactly like two Agent tool calls in one turn.
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        service.spawn({ type: "worker", prompt: `x${i}`, label: `x${i}`, poolFullPolicy: "reject" }),
      ),
    );
    const admitted = results.filter((r) => !("error" in r));
    const rejected = results.filter((r) => "error" in r);
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(3);
  });

  it("bypasses the reject check entirely for slotless requests (nested Agent tool)", async () => {
    const d = deps(1);
    const service = createSpawnService(d);
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });

    // Pool is "full" (1/1) from the reject-policy's point of view, but a
    // slotless request never occupies a conceptual slot and must never be
    // rejected regardless of poolFullPolicy.
    const nested = await service.spawn({
      type: "worker",
      prompt: "nested",
      label: "nested",
      slotless: true,
      poolFullPolicy: "reject",
    });
    expect("error" in nested).toBe(false);
  });

  it("§5 (user follow-up): every successful dispatch reports slots (limit/inUse/free), counted like SlotPool (slotless excluded)", async () => {
    const d = deps(3);
    const service = createSpawnService(d);
    const a = await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });
    expect(a.slots).toEqual({ limit: 3, inUse: 1, free: 2 });

    // A slotless request (nested Agent / consult) never occupies a slot
    // itself, but still reports the CURRENT ambient occupancy (1, from A) —
    // it does not appear in its own inUse count.
    const nested = await spawnOk(service, { type: "worker", prompt: "n", label: "n", slotless: true });
    expect(nested.slots).toEqual({ limit: 3, inUse: 1, free: 2 });

    const b = await spawnOk(service, { type: "worker", prompt: "b", label: "task-b" });
    expect(b.slots).toEqual({ limit: 3, inUse: 2, free: 1 });
  });

  it('§5: slots.free is omitted when concurrencyLimit is 0 (SlotPool\'s own "unlimited" sentinel)', async () => {
    const d = deps(0);
    const service = createSpawnService(d);
    const a = await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });
    expect(a.slots).toEqual({ limit: 0, inUse: 1 });
    expect(a.slots.free).toBeUndefined();
  });

  it("§5: the pool-full reject error message and a successful dispatch's slots use the identical counting basis", async () => {
    const d = deps(2);
    const service = createSpawnService(d);
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });
    const b = await spawnOk(service, { type: "worker", prompt: "b", label: "task-b" });
    expect(b.slots).toEqual({ limit: 2, inUse: 2, free: 0 });

    const rejected = await service.spawn({ type: "worker", prompt: "c", label: "c", poolFullPolicy: "reject" });
    expect("error" in rejected).toBe(true);
    if (!("error" in rejected)) throw new Error("unreachable");
    expect(rejected.error.message).toContain("slots: 2/2 in use, 0 free");
  });

  it("queue-policy (workflow/consult/resume/undefined) requests are never rejected when full, and report queued position/limit", async () => {
    const d = deps(1);
    const service = createSpawnService(d);
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });

    // No poolFullPolicy at all — the default for every caller except the
    // Agent tool (workflow children, consult, /task, resume).
    const queued = await service.spawn({ type: "worker", prompt: "b", label: "task-b" });
    expect("error" in queued).toBe(false);
    if ("error" in queued) throw new Error("unreachable");
    expect(queued.queued).toMatchObject({ position: 1, runningCount: 1, limit: 1 });
    expect(queued.queued?.queueWaitMs).toBeGreaterThan(0);
  });

  it("reports no queued info when the pool has room", async () => {
    const d = deps(3);
    const service = createSpawnService(d);
    const spawned = await service.spawn({ type: "worker", prompt: "a", label: "task-a" });
    expect("error" in spawned).toBe(false);
    if ("error" in spawned) throw new Error("unreachable");
    expect(spawned.queued).toBeUndefined();
  });

  it("P1 fix (todo #16 review): a queued (queueWhenFull=true) request's OWN slots readout never shows inUse over limit — the overflow is reported as `queued`, not folded into inUse", async () => {
    const d = deps(1);
    const service = createSpawnService(d);
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });

    // Pool is 1/1 already; this second non-slotless request is admitted
    // under queue policy (default, no poolFullPolicy) and queues behind it.
    const queued = await spawnOk(service, { type: "worker", prompt: "b", label: "task-b" });
    // Before the fix this was { limit: 1, inUse: 2, free: 0 } — an
    // impossible "2/1 in use" readout (queueing collapsed into inUse).
    expect(queued.slots).toEqual({ limit: 1, inUse: 1, free: 0, queued: 1 });

    // A third queues behind both of them: still capped inUse, queued grows.
    const queued2 = await spawnOk(service, { type: "worker", prompt: "c", label: "task-c" });
    expect(queued2.slots).toEqual({ limit: 1, inUse: 1, free: 0, queued: 2 });
  });

  it("P1 fix: concurrent same-tick queue-policy dispatches never display inUse above limit even though several are admitted past it", async () => {
    const d = deps(2);
    const service = createSpawnService(d);
    // Five requests fired with no await between them (queue policy, the
    // default) — all five are admitted (queue policy never rejects), but
    // only 2 can ever be "in use" for display purposes; the rest must show
    // up as `queued`, never as extra `inUse`.
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => service.spawn({ type: "worker", prompt: `x${i}`, label: `x${i}` })),
    );
    for (const r of results) {
      if ("error" in r) throw new Error("unreachable");
      expect(r.slots.inUse).toBeLessThanOrEqual(r.slots.limit);
    }
    // The last admitted call sees all 5 reservations ahead of it (itself
    // included): 2 capped inUse + 3 queued.
    const last = results[results.length - 1];
    if ("error" in last!) throw new Error("unreachable");
    expect(last.slots).toEqual({ limit: 2, inUse: 2, free: 0, queued: 3 });
  });

  it("P1 fix: limit=0 (unlimited pool) never reports `queued` — nothing ever queues against an unlimited pool", async () => {
    const d = deps(0);
    const service = createSpawnService(d);
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });
    const b = await spawnOk(service, { type: "worker", prompt: "b", label: "task-b" });
    expect(b.slots).toEqual({ limit: 0, inUse: 2 });
    expect(b.slots.queued).toBeUndefined();
    expect(b.queued).toBeUndefined();
  });

  it("setConcurrencyLimit forwards live to the pool", () => {
    const d = deps(2);
    const service = createSpawnService(d);
    expect(d.pool.stats?.limit).toBe(2);
    service.setConcurrencyLimit(5);
    expect(d.pool.stats?.limit).toBe(5);
  });

  it("frees the reservation once the run settles, letting the next reject-policy dispatch through", async () => {
    let resolveA: ((o: RunOutcome) => void) | undefined;
    const runner: Runner = {
      run: (spec) =>
        new Promise<RunOutcome>((resolve) => {
          resolveA = () =>
            resolve({
              runId: spec.runId,
              status: "completed",
              turns: 1,
              durationMs: 1,
              diag: {
                createdAt: 0,
                phase: "settled",
                phaseEnteredAt: 1,
                settledAt: 1,
                pendingTools: 0,
                turns: 1,
                escalation: [],
                orphaned: false,
                generation: 1,
                degraded: [],
                staleInputs: 0,
                unkillable: [],
              },
            });
        }),
    };
    const service = createSpawnService(deps(1, runner));
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });

    const rejected = await service.spawn({ type: "worker", prompt: "b", label: "task-b", poolFullPolicy: "reject" });
    expect("error" in rejected).toBe(true);

    resolveA?.({} as RunOutcome); // settle A
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const admitted = await service.spawn({ type: "worker", prompt: "c", label: "task-c", poolFullPolicy: "reject" });
    expect("error" in admitted).toBe(false);
  });
});

/** L1 todo #19 (list_subagents): `SpawnService.slots()` — same admission-time `slotfulLabel` accounting as the pool-full reject path above, read WITHOUT spawning. */
describe("SpawnService.slots() (L1 todo #19)", () => {
  it("reports free capacity before any admission", () => {
    const service = createSpawnService(deps(3));
    expect(service.slots()).toEqual({ limit: 3, inUse: 0, free: 3 });
  });

  it("reflects in-flight admissions, capped at the limit, with queued counting the overflow", async () => {
    const service = createSpawnService(deps(2));
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });
    expect(service.slots()).toEqual({ limit: 2, inUse: 1, free: 1 });
    await spawnOk(service, { type: "worker", prompt: "b", label: "task-b" });
    expect(service.slots()).toEqual({ limit: 2, inUse: 2, free: 0 });
    // A third, queue-policy admission is accepted past the limit (kept in `slotfulLabel`
    // as a queued occupant) instead of rejected — slots() must report it as queued, never
    // as extra inUse (inUse stays capped at limit, matching formatSlots' contract).
    const queued = service.spawn({ type: "worker", prompt: "c", label: "task-c", poolFullPolicy: "queue" });
    await new Promise((r) => setTimeout(r, 0));
    expect(service.slots()).toEqual({ limit: 2, inUse: 2, free: 0, queued: 1 });
    void queued; // never settles in this test (hangingRunner); just needed the admission side effect
  });

  it("reports the unlimited sentinel (limit<=0) as bare running-count, never free/queued", async () => {
    const service = createSpawnService(deps(0));
    await spawnOk(service, { type: "worker", prompt: "a", label: "task-a" });
    expect(service.slots()).toEqual({ limit: 0, inUse: 1 });
  });
});
