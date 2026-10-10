import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { LoadAdmission } from "../../src/sysload/types.js";
import {
  attachHostCallHandler,
  type ChildOutcome,
  type ChildSpawner,
  type WorkflowChildEvent,
} from "../../src/workflow/host.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

const BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 2_000,
  terminateConfirmMs: 500,
  workflowTotalMs: 10_000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 5_000,
  maxParallel: 1,
  maxChildren: 20,
  maxBatchItems: 32,
  childBudgetPolicy: "inherit_remaining",
};

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function admission(initialBlocked: boolean) {
  let blocked = initialBlocked;
  const listeners = new Set<() => void>();
  let unsubscribeCount = 0;
  const port: LoadAdmission = {
    blocked: () => blocked,
    onGateCleared(fn) {
      listeners.add(fn);
      return () => {
        unsubscribeCount += 1;
        listeners.delete(fn);
      };
    },
  };
  return {
    port,
    setBlocked(value: boolean) {
      blocked = value;
    },
    clear() {
      blocked = false;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

function testHarness(loadAdmission: LoadAdmission | undefined, onChildEvent?: (event: WorkflowChildEvent) => void) {
  const clock = new FakeClock();
  const worker = fakeSpawnWorkerFactory();
  const workerHost = createWorkerHost({ clock, spawnWorker: worker.spawnWorker });
  const sent: unknown[] = [];
  const spawns: Array<{ prompt: string; runId: string }> = [];
  const outcomes = new Map<string, (outcome: { settled: ChildOutcome[]; pending: string[] }) => void>();
  const spawner: ChildSpawner = {
    ...(loadAdmission !== undefined ? { loadAdmission } : {}),
    spawn: async (request) => {
      const runId = `run-${spawns.length + 1}`;
      spawns.push({ prompt: request.prompt, runId });
      return { runId };
    },
    abort: async () => true,
    waitAll: ({ runIds }) =>
      new Promise((resolve) => {
        outcomes.set(runIds[0]!, resolve);
      }),
  };
  return {
    clock,
    worker,
    sent,
    spawns,
    outcomes,
    spawner,
    async boot() {
      await workerHost.boot({
        scriptSource: 'export const meta = { name: "load-test", description: "load-test" };',
        scriptSliceMs: 1_000,
        heartbeatMs: 0,
        workerBootMs: 1_000,
        terminateConfirmMs: 500,
      });
      worker.workerData().commPort.on("message", (message) => sent.push(message));
    },
    attach() {
      return attachHostCallHandler({
        clock,
        workerHost,
        spawner,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        budget: BUDGET,
        workflowDeadlineAt: 10_000,
        ...(onChildEvent !== undefined ? { onChildEvent } : {}),
      });
    },
    post(id: string, prompt: string) {
      worker.workerData().commPort.postMessage({ kind: "host_call", id, op: "agent", args: { prompt, opts: null } });
    },
  };
}

describe("workflow P2b: load admission shares the host FIFO", () => {
  it("queues while blocked, wakes on gateCleared, and preserves FIFO", async () => {
    const gate = admission(true);
    const events: WorkflowChildEvent[] = [];
    const h = testHarness(gate.port, (event) => events.push(event));
    await h.boot();
    h.attach();

    h.post("1", "first");
    h.post("2", "second");
    await flush();

    expect(h.spawns).toEqual([]);
    expect(events.filter((event) => event.kind === "queued")).toEqual([
      expect.objectContaining({ callId: "1", reason: "load" }),
      expect.objectContaining({ callId: "2", reason: "maxParallel" }),
    ]);

    gate.clear();
    await flush();
    expect(h.spawns).toEqual([{ prompt: "first", runId: "run-1" }]);

    h.outcomes.get("run-1")!({
      settled: [{ runId: "run-1", status: "completed", text: "one" }],
      pending: [],
    });
    await flush();
    expect(h.spawns).toEqual([
      { prompt: "first", runId: "run-1" },
      { prompt: "second", runId: "run-2" },
    ]);
  });

  it("does not gate replay hits, and reports maxParallel when load is clear", async () => {
    const gate = admission(false);
    const events: WorkflowChildEvent[] = [];
    const h = testHarness(gate.port, (event) => events.push(event));
    await h.boot();
    h.attach();

    h.post("1", "first");
    h.post("2", "second");
    await flush();
    expect(events.find((event) => event.callId === "2" && event.kind === "queued")).toMatchObject({
      reason: "maxParallel",
    });
    expect(h.spawns).toHaveLength(1);
  });

  it("withholds a call that is still load-blocked at the workflow hard deadline", async () => {
    const gate = admission(true);
    const h = testHarness(gate.port);
    await h.boot();
    const handler = h.attach();
    h.post("1", "deadline");
    await flush();

    h.clock.advance(10_000);
    gate.clear();
    await flush();

    expect(h.spawns).toEqual([]);
    expect(handler.children).toEqual([expect.objectContaining({ callId: "1", status: "withheld" })]);
    expect(h.sent.find((message) => (message as { kind?: string }).kind === "host_settle")).toEqual(
      expect.objectContaining({ callId: "1", ok: false, error: { message: "workflow deadline reached while queued" } }),
    );
  });

  it("withholds blocked calls on stop, unsubscribes, and ignores a late gate clear", async () => {
    const gate = admission(true);
    const h = testHarness(gate.port);
    await h.boot();
    const handler = h.attach();
    h.post("1", "waiting");
    await flush();

    expect(gate.listenerCount).toBe(1);
    const stopping = handler.stopOwned("user_stop", 0);
    await stopping;
    await flush();

    expect(gate.unsubscribeCount).toBe(1);
    expect(gate.listenerCount).toBe(0);
    gate.clear();
    await flush();
    expect(h.spawns).toEqual([]);
    expect(handler.children).toEqual([expect.objectContaining({ callId: "1", status: "withheld" })]);
    expect(h.sent.find((message) => (message as { kind?: string }).kind === "host_settle")).toEqual(
      expect.objectContaining({ callId: "1", ok: false, error: { message: "workflow terminating (user_stop)" } }),
    );
  });

  it("fails open when the optional admission port throws", async () => {
    const h = testHarness({
      blocked: () => {
        throw new Error("load unavailable");
      },
      onGateCleared: () => {
        throw new Error("subscribe unavailable");
      },
    });
    await h.boot();
    h.attach();
    h.post("1", "runs");
    await flush();
    expect(h.spawns).toEqual([{ prompt: "runs", runId: "run-1" }]);
  });
});
