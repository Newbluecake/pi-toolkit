/**
 * #39 P2 (memory-scopes arch §6.3): the workflow half of the memory-seed pipeline.
 * Each accepted `agent()` call captures ONCE — synchronously after structural
 * opts validation, before hash/replay/FIFO — independently of fastSeed. Two
 * sibling calls can carry different snapshots; a queued call never re-reads the
 * parent at dispatch; the seed never enters the journal taskKey, worker opts or
 * public `agent()` options; a capture failure rejects the call (fail closed).
 */
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { MemorySeedCapture } from "../../src/core/types.js";
import type { SpawnRequest } from "../../src/core/types.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { SpawnService } from "../../src/service/spawn-service.js";
import {
  attachHostCallHandler,
  type ChildOutcome,
  type ChildSpawner,
  type HostCallHandlerDeps,
  type JournalRunConfig,
} from "../../src/workflow/host.js";
import { buildEntry, CHAIN_SEED, taskKeyOf } from "../../src/workflow/journal.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";
import type { HostCallEnvelope, WorkerHost, WorkflowRunBudget } from "../../src/workflow/types.js";

const budget: WorkflowRunBudget = {
  scriptLoadMs: 1000,
  scriptSliceMs: 1000,
  workerBootMs: 1000,
  heartbeatMs: 0,
  heartbeatStallMs: 2000,
  terminateConfirmMs: 500,
  workflowTotalMs: 10000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 1000,
  gateMs: 1000,
  maxParallel: 1,
  maxChildren: 20,
  maxBatchItems: 32,
  childBudgetPolicy: "inherit_remaining",
};
const semantics = { agentType: "general-purpose", agentTypeConfigHash: "cfg", prompt: "p" };
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const STAMP = "2026-11-07T17:57:00.000Z";
const captureOf = (n: number): MemorySeedCapture => ({
  v: 1,
  state: "captured",
  seed: {
    v: 1,
    fromSid: `parent-${n}`,
    frozenAt: STAMP,
    items: [{ id: "n1", text: `v${n}`, authority: "agent", created: STAMP, updated: STAMP }],
    nextN: 2,
  },
});

function harness(extra: Partial<HostCallHandlerDeps> = {}) {
  const clock = new FakeClock();
  const sent: unknown[] = [];
  let receive!: (message: HostCallEnvelope) => void;
  const workerHost = {
    send: (message: unknown) => sent.push(message),
    events: {
      onHostCall: (fn: typeof receive) => {
        receive = fn;
      },
      onPhase: () => {},
      onTerminating: () => {},
    },
  } as unknown as WorkerHost;
  const requests: Parameters<ChildSpawner["spawn"]>[0][] = [];
  const outcomes = new Map<string, ReturnType<typeof deferred<{ settled: ChildOutcome[]; pending: string[] }>>>();
  const spawner: ChildSpawner = {
    spawn: vi.fn(async (request) => {
      requests.push(request);
      return { runId: `r${requests.length}` };
    }),
    abort: vi.fn(async () => true),
    waitAll: ({ runIds }) => {
      const d = deferred<{ settled: ChildOutcome[]; pending: string[] }>();
      outcomes.set(runIds[0]!, d);
      return d.promise;
    },
    configHashOf: () => "cfg",
  };
  const handler = attachHostCallHandler({
    clock,
    workerHost,
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    budget,
    workflowDeadlineAt: 10000,
    ...extra,
  });
  return {
    clock,
    sent,
    requests,
    outcomes,
    spawner,
    handler,
    post(id: string, args: unknown = { prompt: "p" }) {
      receive({ id, op: "agent", args });
    },
    async complete(runId: string) {
      outcomes.get(runId)!.resolve({ settled: [{ runId, status: "completed", text: "done" }], pending: [] });
      await flush();
    },
  };
}

describe("workflow memory-seed admission", () => {
  it("captures once per accepted agent() call and forwards a deep-frozen value", async () => {
    const capture = vi.fn(() => captureOf(1));
    const h = harness({ memoryWorkflow: { capture } });
    h.post("1");
    expect(capture).toHaveBeenCalledTimes(1); // synchronous, before any spawn await
    await flush();
    expect(h.requests).toHaveLength(1);
    const seed = h.requests[0]!.memorySeed!;
    expect(seed).toEqual(captureOf(1));
    expect(Object.isFrozen(seed)).toBe(true);
    expect(Object.isFrozen(seed.state === "captured" ? seed.seed : null)).toBe(true);
    expect(Object.isFrozen(seed.state === "captured" ? seed.seed.items : [])).toBe(true);
    await h.complete("r1");
  });

  it("two sibling calls can carry different snapshots (per-call, not per-dispatch)", async () => {
    let n = 0;
    const capture = vi.fn(() => captureOf(++n));
    const h = harness({ memoryWorkflow: { capture } });
    h.post("1", { prompt: "a" });
    await flush();
    h.post("2", { prompt: "b" }); // maxParallel=1 ⇒ queued behind call 1
    await flush();
    await h.complete("r1");
    expect(h.requests.map((r) => r.memorySeed)).toEqual([captureOf(1), captureOf(2)]);
    expect(capture).toHaveBeenCalledTimes(2);
    await h.complete("r2");
  });

  it("explicit empty travels as empty; absent port adds no key and no extra reads", async () => {
    const capture = vi.fn((): MemorySeedCapture => ({ v: 1, state: "empty" }));
    const h = harness({ memoryWorkflow: { capture } });
    h.post("1", { prompt: "e" });
    await flush();
    expect(h.requests[0]!.memorySeed).toEqual({ v: 1, state: "empty" });
    await h.complete("r1");

    const h2 = harness();
    h2.post("2", { prompt: "legacy" });
    await flush();
    expect(h2.requests[0]).not.toHaveProperty("memorySeed");
    await h2.complete("r1");
  });

  it("a queued call never re-reads the parent at dequeue", async () => {
    let n = 0;
    const capture = vi.fn(() => captureOf(++n));
    const h = harness({ memoryWorkflow: { capture } });
    h.post("1", { prompt: "first" });
    await flush();
    h.post("2", { prompt: "second" }); // maxParallel=1 ⇒ queued
    await flush();
    expect(h.handler.registry.resolve("2")?.phase).toBe("queued");
    n = 99; // parent memory changed while call 2 was queued
    await h.complete("r1");
    expect(h.requests[1]!.memorySeed).toEqual(captureOf(2)); // snapshot at admission, not dequeue
    expect(capture).toHaveBeenCalledTimes(2);
    await h.complete("r2");
  });

  it("capture failure rejects the call fail-closed (memory_capture_failed)", async () => {
    const capture = vi.fn(() => {
      throw new Error("storage-fault");
    });
    const h = harness({ memoryWorkflow: { capture } });
    h.post("1");
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1");
    expect(ack).toMatchObject({ ok: false, error: { message: "memory seed capture failed: storage-fault" } });
    expect(h.requests).toEqual([]);
    const invalid = vi.fn(() => ({ v: 1, state: "captured", seed: { fromSid: "x", frozenAt: "no" } }));
    const h2 = harness({ memoryWorkflow: { capture: invalid as never } });
    h2.post("2");
    await flush();
    expect(h2.sent.find((m) => (m as { id?: string }).id === "2")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("memory seed capture failed") },
    });
    expect(h2.requests).toEqual([]);
  });

  it("public agent() options expose no memorySeed (untrusted opts rejected before capture)", async () => {
    const capture = vi.fn(() => captureOf(1));
    const h = harness({ memoryWorkflow: { capture } });
    h.post("1", { prompt: "p", opts: { memorySeed: captureOf(1) } });
    await flush();
    expect(capture).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(h.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "1",
          ok: false,
          error: expect.objectContaining({ message: expect.stringContaining("label") }),
        }),
      ]),
    );
  });

  it("memorySeed never enters the journal taskKey: a replay hit still spawns nothing", async () => {
    const entry = buildEntry({
      scope: "content",
      key: taskKeyOf(semantics),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: semantics.agentType,
      value: "cached",
      completedAt: 0,
      durationMs: 1,
    });
    const journal: JournalRunConfig = {
      store: {
        load: async () => ({ entries: [], corruptLines: 0 }),
        append: vi.fn(),
        flush: async () => ({ written: 0, pending: 0 }),
      },
      dir: "/unused",
      index: buildReplayIndex([entry], 0, "content"),
      scope: "content",
      noReplay: false,
      deterministic: { current: true },
    };
    const capture = vi.fn(() => captureOf(1));
    const h = harness({ memoryWorkflow: { capture }, journal });
    h.post("1", { prompt: "p" }); // identical prompt/type ⇒ replay hit
    await flush();
    expect(capture).toHaveBeenCalledTimes(1); // captured even on an early hit…
    expect(h.requests).toEqual([]); // …but no child spawned, no journal append
    expect(journal.store.append).not.toHaveBeenCalled();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1");
    expect(ack).toMatchObject({ ok: true });
  });

  it("spawner-adapter forwards memorySeed and exposes memoryWorkflow", async () => {
    const spawned: SpawnRequest[] = [];
    const fakeService = {
      spawn: async (req: SpawnRequest) => {
        spawned.push(req);
        return { runId: "run-1", slots: { limit: 1, inUse: 0, free: 1 } };
      },
    } as unknown as SpawnService;
    const types = { configHashOf: () => "cfg" } as unknown as AgentTypeRegistry;
    const memoryWorkflow = { capture: () => captureOf(5) };
    const spawner = createWorkflowChildSpawner(fakeService, types, { memoryWorkflow });
    expect(spawner.memoryWorkflow).toBe(memoryWorkflow);
    await spawner.spawn({
      type: "general-purpose",
      prompt: "p",
      memorySeed: captureOf(3),
      fastSeed: { v: 1, mode: "on" },
    });
    expect(spawned[0]!.memorySeed).toEqual(captureOf(3));
    expect(spawned[0]!.fastSeed).toEqual({ v: 1, mode: "on" });
    // Absent seed ⇒ absent key (byte-identical legacy request).
    await spawner.spawn({ type: "general-purpose", prompt: "q" });
    expect(Object.hasOwn(spawned[1]!, "memorySeed")).toBe(false);
  });
});
