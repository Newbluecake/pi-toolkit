import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { FastMode, FastSeed, SpawnRequest } from "../../src/core/types.js";
import type { FastWorkflowPort } from "../../src/fast/ports.js";
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
function journal(mode?: "on" | "off"): JournalRunConfig {
  const entry = buildEntry({
    scope: "content",
    key: taskKeyOf({ ...semantics, ...(mode ? { fastMode: mode } : {}) }),
    chainDigestBefore: CHAIN_SEED,
    occurrence: 0,
    agentType: semantics.agentType,
    value: "cached",
    completedAt: 0,
    durationMs: 1,
  });
  return {
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
}
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

describe("workflow Fast admission snapshot", () => {
  it.each<FastMode | undefined>(["on", "off", "inherit", undefined])(
    "captures %s once and forwards only pure seed fields",
    async (mode) => {
      const seed = mode === undefined ? undefined : { v: 1 as const, mode, revision: 7, incarnation: {} };
      const capture = vi.fn(() => seed);
      const h = harness({ fastWorkflow: { capture } });
      h.post("1");
      expect(capture).toHaveBeenCalledTimes(1); // synchronous, before any spawn await
      await flush();
      expect(h.requests).toHaveLength(1);
      if (seed) {
        expect(h.requests[0]!.fastSeed).toEqual({ v: 1, mode });
        expect(h.requests[0]!.fastSeed).not.toBe(seed);
        expect(Object.isFrozen(h.requests[0]!.fastSeed)).toBe(true);
      } else expect(h.requests[0]).not.toHaveProperty("fastSeed");
      await h.complete("r1");
    },
  );

  it("does not capture invalid prompt/opts or accept public Fast options", async () => {
    const capture = vi.fn(() => ({ v: 1 as const, mode: "on" as const }));
    const h = harness({ fastWorkflow: { capture } });
    h.post("1", { prompt: 3 });
    h.post("2", { prompt: "p", opts: { fastSeed: { v: 1, mode: "on" } } });
    h.post("3", { prompt: "p", opts: { fastMode: "on" } });
    await flush();
    expect(capture).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(h.sent).toEqual(
      expect.arrayContaining([1, 2, 3].map((id) => expect.objectContaining({ id: String(id), ok: false }))),
    );
  });

  it("keeps FIFO seeds when the trusted port reuses and mutates one readonly-typed object", async () => {
    const source: { v: 1; mode: FastMode } = { v: 1, mode: "on" };
    const capture = vi.fn((): FastSeed => source);
    const h = harness({ fastWorkflow: { capture } });
    h.post("1");
    await flush();
    source.mode = "off";
    h.post("2");
    await flush();
    source.mode = "inherit";
    h.post("3");
    await flush();
    source.mode = "on";
    expect(h.requests).toHaveLength(1);
    expect(h.handler.registry.resolve("2")?.phase).toBe("queued");
    await h.complete("r1");
    expect(h.requests[1]!.fastSeed).toEqual({ v: 1, mode: "off" });
    await h.complete("r2");
    expect(h.requests[2]!.fastSeed).toEqual({ v: 1, mode: "inherit" });
    expect(h.requests[0]!.fastSeed).toEqual({ v: 1, mode: "on" });
    expect(capture).toHaveBeenCalledTimes(3);
    await h.complete("r3");
  });

  it.each(["cancel", "deadline"] as const)("withholds FIFO calls on %s without re-capture/spawn", async (cause) => {
    const capture = vi.fn(() => ({ v: 1 as const, mode: "off" as const }));
    const h = harness({ fastWorkflow: { capture } });
    h.post("1");
    await flush();
    h.post("2");
    await flush();
    if (cause === "cancel") h.handler.cancelAllChildren("parent_abort");
    else h.clock.advance(10000);
    await h.complete("r1");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.fastSeed).toEqual({ v: 1, mode: "off" });
    expect(h.handler.children).toContainEqual(expect.objectContaining({ callId: "2", status: "withheld" }));
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each(["on", "off", "inherit", undefined] as const)(
    "captures before an early %s cache hit, with zero spawn or journal append",
    async (mode) => {
      const capture = vi.fn(() => (mode === undefined ? undefined : { v: 1 as const, mode }));
      const j = journal(mode === "inherit" ? undefined : mode);
      const h = harness({ fastWorkflow: { capture }, journal: j });
      h.post("1");
      expect(capture).toHaveBeenCalledTimes(1);
      await flush();
      expect(h.requests).toEqual([]);
      expect(j.store.append).not.toHaveBeenCalled();
      expect(h.handler.children).toContainEqual(expect.objectContaining({ source: "replay" }));
      expect(h.sent).toContainEqual(expect.objectContaining({ kind: "host_settle", value: "cached" }));
    },
  );

  it("switching on to off misses, while missing port keeps the legacy cache key", async () => {
    const h = harness({ fastWorkflow: { capture: () => ({ v: 1, mode: "off" }) }, journal: journal("on") });
    h.post("1");
    await flush();
    expect(h.requests[0]!.fastSeed).toEqual({ v: 1, mode: "off" });
    await h.complete("r1");
    const legacy = harness({ journal: journal() });
    legacy.post("1");
    await flush();
    expect(legacy.requests).toEqual([]);
    expect(legacy.handler.replayStats?.hits).toBe(1);
  });

  it("preserves the seed during admission timeout, and aborts a late admitted child", async () => {
    const pending = deferred<{ runId: string }>();
    const accepted: Parameters<ChildSpawner["spawn"]>[0][] = [];
    const abort = vi.fn(async () => true);
    const source: { v: 1; mode: FastMode } = { v: 1, mode: "on" };
    const capture = vi.fn(() => source);
    const h = harness({
      fastWorkflow: { capture },
      spawner: {
        spawn: async (request) => {
          accepted.push(request);
          return pending.promise;
        },
        abort,
        waitAll: async () => ({ settled: [], pending: [] }),
      },
    });
    h.post("1");
    await flush();
    source.mode = "off";
    h.clock.advance(1000);
    await flush();
    expect(h.sent).toContainEqual(expect.objectContaining({ id: "1", ok: false }));
    expect(h.handler.children).toContainEqual(expect.objectContaining({ callId: "1", status: "withheld" }));
    pending.resolve({ runId: "late" });
    await flush();
    expect(abort).toHaveBeenCalledWith("late", "host_call_timeout");
    expect(accepted[0]!.fastSeed).toEqual({ v: 1, mode: "on" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("retains queued seed on dispatch rejection and frees the FIFO slot for the next call", async () => {
    const requests: Parameters<ChildSpawner["spawn"]>[0][] = [];
    const first = deferred<{ settled: ChildOutcome[]; pending: string[] }>();
    const capture = vi.fn(() => ({ v: 1 as const, mode: "off" as const }));
    const h = harness({
      fastWorkflow: { capture },
      spawner: {
        spawn: async (request) => {
          requests.push(request);
          return requests.length === 2 ? { error: { message: "pool full" } } : { runId: `r${requests.length}` };
        },
        abort: async () => true,
        waitAll: ({ runIds }) =>
          runIds[0] === "r1"
            ? first.promise
            : Promise.resolve({ settled: [{ runId: runIds[0]!, status: "completed", text: "ok" }], pending: [] }),
      },
    });
    h.post("1");
    await flush();
    h.post("2");
    h.post("3");
    await flush();
    first.resolve({ settled: [{ runId: "r1", status: "completed", text: "ok" }], pending: [] });
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.fastSeed)).toEqual(Array.from({ length: 3 }, () => ({ v: 1, mode: "off" })));
    expect(h.handler.children).toContainEqual(expect.objectContaining({ callId: "2", status: "withheld" }));
    expect(h.handler.children).toContainEqual(expect.objectContaining({ callId: "3", status: "completed" }));
    expect(capture).toHaveBeenCalledTimes(3);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("binds independent parent session ports rather than querying the active session", async () => {
    const a = harness({ fastWorkflow: { capture: () => ({ v: 1, mode: "on" }) } });
    const b = harness({ fastWorkflow: { capture: () => ({ v: 1, mode: "off" }) } });
    a.post("1");
    b.post("1");
    await flush();
    expect(a.requests[0]!.fastSeed?.mode).toBe("on");
    expect(b.requests[0]!.fastSeed?.mode).toBe("off");
    await a.complete("r1");
    await b.complete("r1");
  });
});

describe("Fast key and production spawner boundary", () => {
  it("preserves the exact pre-Fast hash bytes; only on/off are semantic", () => {
    expect(taskKeyOf(semantics)).toBe("442c58eefbaa85bb938abfea39411cc9");
    expect(taskKeyOf({ ...semantics, fastMode: "on" })).not.toBe(taskKeyOf(semantics));
    expect(taskKeyOf({ ...semantics, fastMode: "off" })).not.toBe(taskKeyOf({ ...semantics, fastMode: "on" }));
  });

  it("carries the admitted seed through the adapter into a controlled lower slot queue", async () => {
    const accepted: SpawnRequest[] = [];
    const slot = deferred<{ runId: string }>();
    const service = {
      abort: async () => true,
      waitAll: () => new Promise(() => {}),
      spawn: vi.fn((request: SpawnRequest) => {
        accepted.push(request);
        return slot.promise;
      }),
    } as unknown as SpawnService;
    const source: { v: 1; mode: FastMode } = { v: 1, mode: "on" };
    const capture = vi.fn(() => source);
    const port: FastWorkflowPort = { capture };
    const adapter = createWorkflowChildSpawner(service, {} as AgentTypeRegistry, { fastWorkflow: port });
    const h = harness({ spawner: adapter });
    h.post("1");
    await flush();
    expect(accepted).toHaveLength(1);
    source.mode = "off";
    expect(accepted[0]!.fastSeed).toEqual({ v: 1, mode: "on" });
    expect(accepted[0]!.budgetOverride).toMatchObject({ totalMs: 10000 });
    expect(accepted[0]!.callerOwned).toBe(true);
    slot.resolve({ runId: "slot-run" });
    await flush();
    expect(accepted[0]!.fastSeed).toEqual({ v: 1, mode: "on" });
    expect(capture).toHaveBeenCalledTimes(1);
    const stopped = h.handler.stopOwned("test", 0);
    h.clock.advance(0);
    await stopped;
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("adapter leaves the legacy request free of undefined Fast keys", async () => {
    const spawn = vi.fn(async (_req: SpawnRequest) => ({ runId: "r" }));
    const adapter = createWorkflowChildSpawner({ spawn } as unknown as SpawnService, {} as AgentTypeRegistry);
    expect(adapter).not.toHaveProperty("fastWorkflow");
    await adapter.spawn({ type: "general", prompt: "p" });
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty("fastSeed");
  });
});
