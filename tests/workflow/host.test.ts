import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { ReplayIndex } from "../../src/workflow/types.js";
import type { JournalEntry } from "../../src/workflow/types.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import {
  attachHostCallHandler,
  type ChildOutcome,
  type ChildSpawner,
  type GateRunner,
  type WorkflowChildEvent,
} from "../../src/workflow/host.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * §3.3/§3.5/§4.4 host.ts: driven entirely by `FakeClock` + the same
 * fake-worker harness `orchestrator.test.ts`/`lifecycle.test.ts` use — the
 * worker side of the protocol is simulated by posting `host_call` envelopes
 * directly onto the fake `MessagePort`, exactly like `orchestrator.test.ts`
 * simulates `script_returned`. This isolates host.ts's own logic (HR2, the
 * budget derivation call site, maxParallel/maxChildren enforcement, HR8)
 * from the real embedded scaffold — the scaffold's own half of the protocol
 * (HR1, the actual `agent()`/`gate()` sandbox functions) is covered
 * end-to-end with a real worker thread in wc-host-call.test.ts.
 */

const BASE_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 2_000,
  terminateConfirmMs: 500,
  workflowTotalMs: 60_000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 5_000,
  maxParallel: 4,
  maxChildren: 500,
  maxBatchItems: 1024,
  childBudgetPolicy: "inherit_remaining",
};

function noopSpawner(): ChildSpawner {
  return {
    spawn: async () => ({ runId: "unused" }),
    abort: async () => true,
    waitAll: async () => ({ settled: [], pending: [] }),
  };
}

function harness(budgetOverrides: Partial<WorkflowRunBudget> = {}) {
  const clock = new FakeClock();
  const { spawnWorker, workerData } = fakeSpawnWorkerFactory();
  const workerHost = createWorkerHost({ clock, spawnWorker });
  const sent: unknown[] = [];
  return {
    clock,
    workerHost,
    workerData,
    sent,
    async boot() {
      await workerHost.boot({
        scriptSource: 'export const meta = { name: "t", description: "t" };',
        scriptSliceMs: 1_000,
        heartbeatMs: 0,
        workerBootMs: 1_000,
        terminateConfirmMs: 500,
      });
      workerData().commPort.on("message", (m) => sent.push(m));
    },
    postHostCall(id: string, op: "agent" | "gate", args: unknown) {
      workerData().commPort.postMessage({ kind: "host_call", id, op, args });
    },
    attach(spawner: ChildSpawner, gateRunner: GateRunner, workflowDeadlineAt?: number) {
      return attachHostCallHandler({
        clock,
        workerHost,
        spawner,
        gateRunner,
        budget: { ...BASE_BUDGET, ...budgetOverrides },
        ...(workflowDeadlineAt !== undefined ? { workflowDeadlineAt } : {}),
      });
    },
  };
}

async function flush(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("host.ts: agent() call/ack/settle (§3.3 HR3)", () => {
  it("ack returns immediately (before the child settles); a separate host_settle arrives once waitAll() resolves", async () => {
    const h = harness();
    await h.boot();
    let resolveOutcome!: (o: { settled: ChildOutcome[]; pending: string[] }) => void;
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: () => new Promise((resolve) => (resolveOutcome = resolve)),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));

    h.postHostCall("1", "agent", { prompt: "hello", opts: null });
    await flush();

    // HR3: the ack must have arrived even though waitAll() is still pending.
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as {
      ok: boolean;
      value: { callId: string; deadlineAt?: number };
    };
    expect(ack).toBeDefined();
    expect(ack.ok).toBe(true);
    expect(ack.value.callId).toBe("1");
    expect(h.sent.some((m) => (m as { kind?: string }).kind === "host_settle")).toBe(false);

    resolveOutcome({ settled: [{ runId: "run1", status: "completed", text: "the answer" }], pending: [] });
    await flush();

    const settle = h.sent.find((m) => (m as { callId?: string }).callId === "1") as {
      ok: boolean;
      value: unknown;
    };
    expect(settle).toBeDefined();
    expect(settle.ok).toBe(true);
    expect(settle.value).toBe("the answer");
  });

  it("a failed child settles ok:false with the child's error, distinct from an admission-time ack failure", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: async () => ({
        settled: [{ runId: "run1", status: "failed", error: { message: "boom" } }],
        pending: [],
      }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hello", opts: null });
    await flush();
    const settle = h.sent.find((m) => (m as { callId?: string }).callId === "1") as {
      ok: boolean;
      error?: { message: string };
    };
    expect(settle.ok).toBe(false);
    expect(settle.error?.message).toBe("boom");
  });

  it("an admission-time spawn error (e.g. unknown agent type) acks ok:false and never produces a settle", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ error: { message: "unknown agent type: bogus" } }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hello", opts: { agentType: "bogus" } });
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toMatch(/unknown agent type/);
    expect(h.sent.some((m) => (m as { kind?: string }).kind === "host_settle")).toBe(false);
  });

  it("prompt type validation rejects before ever calling spawn()", async () => {
    const h = harness();
    await h.boot();
    let spawnCalls = 0;
    const spawner: ChildSpawner = {
      spawn: async () => {
        spawnCalls += 1;
        return { runId: "run1" };
      },
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: 42, opts: null });
    await flush();
    expect(spawnCalls).toBe(0);
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean };
    expect(ack.ok).toBe(false);
  });
});

describe("host.ts: replay label echo (§5.3 P1b)", () => {
  it("omits runId/label from replay settle envelope but keeps the requested label in summary/event", async () => {
    const h = harness();
    await h.boot();
    const events: WorkflowChildEvent[] = [];
    const entry = {
      v: 1,
      scope: "content",
      key: "key",
      chainDigestBefore: "root",
      occurrence: 0,
      agentType: "worker",
      status: "completed",
      value: "cached",
      completedAt: 1,
      durationMs: 0,
      digest: "digest",
    } as JournalEntry;
    const index: ReplayIndex = {
      scope: "content",
      lookup: () => entry,
      stats: { loadedEntries: 1, corruptLines: 0, scopeMismatch: 0 },
    };
    const handler = attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner: { ...noopSpawner(), configHashOf: () => "hash" },
      gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      budget: BASE_BUDGET,
      onChildEvent: (event) => events.push(event),
      journal: {
        store: { append: () => undefined } as never,
        dir: ".",
        index,
        scope: "content",
        noReplay: false,
        deterministic: { current: true },
      },
    });
    h.postHostCall("replay-call", "agent", { prompt: "cached", opts: { label: "requested" } });
    await flush();
    const settle = h.sent.find((message) => (message as { callId?: string }).callId === "replay-call") as Record<
      string,
      unknown
    >;
    expect(settle).not.toHaveProperty("runId");
    expect(settle).not.toHaveProperty("label");
    expect(handler.children[0]).toMatchObject({ label: "requested", source: "replay" });
    expect(events.find((event) => event.kind === "settled")).toMatchObject({ label: "requested", source: "replay" });
  });
});

describe("host.ts: effective label propagation (§5.3)", () => {
  it("uses the spawner label in spawned, settled, children, and settle envelope", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "derived-run", label: "derived-1" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "derived-run", status: "completed", text: "ok" }], pending: [] }),
    };
    const events: WorkflowChildEvent[] = [];
    const handler = attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner,
      gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      budget: BASE_BUDGET,
      onChildEvent: (event) => events.push(event),
    });
    h.postHostCall("label-call", "agent", { prompt: "work", opts: { label: "requested" } });
    await flush();
    expect(events.find((event) => event.kind === "spawned")?.label).toBe("derived-1");
    expect(events.find((event) => event.kind === "settled")?.label).toBe("derived-1");
    expect(handler.children[0]?.label).toBe("derived-1");
    const settle = h.sent.find((message) => (message as { callId?: string }).callId === "label-call") as {
      runId?: string;
      label?: string;
    };
    expect(settle.runId).toBe("derived-run");
    expect(settle.label).toBe("derived-1");
  });
});

describe("host.ts: BW2 budget exhaustion (§4.4.3)", () => {
  it("agent() is rejected with WorkflowBudgetExhausted once the workflow has no remaining time", async () => {
    const h = harness();
    await h.boot();
    let spawnCalls = 0;
    const spawner: ChildSpawner = {
      spawn: async () => {
        spawnCalls += 1;
        return { runId: "run1" };
      },
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    // workflowDeadlineAt already in the past relative to the FakeClock's t=0.
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }), -1);
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(spawnCalls).toBe(0);
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toMatch(/WorkflowBudgetExhausted/);
  });

  it("§4.4.3 numeric check: a successful spawn's ack carries a deadlineAt <= the workflow's own deadline", async () => {
    const h = harness();
    await h.boot();
    let capturedDeadlineAt: number | undefined;
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        capturedDeadlineAt = req.deadlineAt;
        return { runId: "run1" };
      },
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const workflowDeadlineAt = 10_000;
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }), workflowDeadlineAt);
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(capturedDeadlineAt).toBeDefined();
    expect(capturedDeadlineAt).toBeLessThanOrEqual(workflowDeadlineAt);
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as {
      ok: boolean;
      value: { deadlineAt?: number };
    };
    expect(ack.value.deadlineAt).toBe(capturedDeadlineAt);
  });
});

describe("host.ts: maxParallel/maxChildren (§5.3)", () => {
  // workflow-agent-queue (plan §7): maxParallel no longer rejects — a call
  // beyond the cap is acked as queued and dispatched once a slot frees.
  it("maxParallel queues (ack {queued:true}) a new agent() call while the cap's worth of children are active, then dispatches it when a slot frees", async () => {
    const h = harness({ maxParallel: 1 });
    await h.boot();
    const resolvers: Array<(o: { settled: ChildOutcome[]; pending: string[] }) => void> = [];
    let spawnCount = 0;
    const spawner: ChildSpawner = {
      spawn: async () => {
        spawnCount += 1;
        return { runId: `run${spawnCount}` };
      },
      abort: async () => true,
      waitAll: () => new Promise((resolve) => resolvers.push(resolve)),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }), 60_000);
    h.postHostCall("1", "agent", { prompt: "one", opts: null });
    await flush();
    h.postHostCall("2", "agent", { prompt: "two", opts: null });
    await flush();
    expect(spawnCount).toBe(1); // the 2nd call waits in the queue, spawn() not called yet
    const ack2 = h.sent.find((m) => (m as { id?: string }).id === "2") as { ok: boolean; value?: unknown };
    expect(ack2).toEqual({
      kind: "host_ack",
      id: "2",
      ok: true,
      value: { callId: "2", deadlineAt: 60_000, queued: true },
    });
    resolvers[0]!({ settled: [{ runId: "run1", status: "completed", text: "ok" }], pending: [] });
    await flush();
    expect(spawnCount).toBe(2); // slot freed → the queued call is dispatched
    resolvers[1]!({ settled: [{ runId: "run2", status: "completed", text: "two done" }], pending: [] });
    await flush();
    const settle2 = h.sent.find((m) => (m as { callId?: string }).callId === "2") as { ok: boolean; value: unknown };
    expect(settle2).toMatchObject({ ok: true, value: "two done" });
  });

  it("maxChildren rejects once the workflow-wide cap is hit, even after earlier children have settled", async () => {
    const h = harness({ maxChildren: 1 });
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "run1", status: "completed", text: "ok" }], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "one", opts: null });
    await flush();
    h.postHostCall("2", "agent", { prompt: "two", opts: null });
    await flush();
    const ack2 = h.sent.find((m) => (m as { id?: string }).id === "2") as { ok: boolean; error?: { message: string } };
    expect(ack2.ok).toBe(false);
    expect(ack2.error?.message).toMatch(/maxChildren/);
  });
});

describe("host.ts: gate() (WT6)", () => {
  it("gate() ack carries the exec result (single-segment RPC)", async () => {
    const h = harness();
    await h.boot();
    const gateRunner: GateRunner = async (cmd) => ({ ok: true, code: 0, stdout: `ran: ${cmd}`, stderr: "" });
    h.attach(noopSpawner(), gateRunner);
    h.postHostCall("1", "gate", { cmd: "echo hi" });
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; value: { stdout: string } };
    expect(ack.ok).toBe(true);
    expect(ack.value.stdout).toBe("ran: echo hi");
  });

  it("gate() acks ok:false when the gateRunner rejects", async () => {
    const h = harness();
    await h.boot();
    const gateRunner: GateRunner = async () => {
      throw new Error("exec failed");
    };
    h.attach(noopSpawner(), gateRunner);
    h.postHostCall("1", "gate", { cmd: "false" });
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toBe("exec failed");
  });
});

describe("HR2: a host handler that hangs (spawner.spawn never resolves) is bounded by hostCallMs", () => {
  it("the ack times out at hostCallMs instead of hanging forever, and the eventual late spawn/settle is harmless", async () => {
    const h = harness({ hostCallMs: 1_000 });
    await h.boot();
    let resolveSpawn: ((r: { runId: string }) => void) | undefined;
    const spawner: ChildSpawner = {
      spawn: () => new Promise((resolve) => (resolveSpawn = resolve)), // never resolves within the test's timeline
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "run1", status: "completed", text: "late" }], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(h.sent.length).toBe(0); // nothing sent yet — spawn() is still hanging.

    h.clock.advance(1_000);
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack).toBeDefined();
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toMatch(/did not complete within 1000ms \(HR2\)/);

    // The late spawn eventually "resolves" (simulating a slow but not
    // infinitely-hung backend) — this must not crash or double-send onto an
    // already-answered call id.
    resolveSpawn?.({ runId: "run1" });
    await flush();
    expect(h.sent.filter((m) => (m as { id?: string }).id === "1").length).toBe(1); // still exactly one ack
  });
});

describe("HR8: terminate() rejects every pending host call (§3.3 HR8)", () => {
  it("a still-running child's pending settle is resolved as aborted the moment terminate() fires, not left dangling", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: () => new Promise(() => {}), // never settles on its own
    };
    const handler = h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(handler.registry.resolve("1")?.phase).toBe("running");

    await h.workerHost.terminate("workflow_completed");
    await flush();

    expect(handler.registry.resolve("1")?.phase).toBe("settled");
    const settleMsg = h.sent.find((m) => (m as { callId?: string }).callId === "1") as { ok: boolean };
    expect(settleMsg).toBeDefined();
    expect(settleMsg.ok).toBe(false);
    expect(handler.children.some((c) => c.callId === "1" && c.status === "aborted")).toBe(true);
  });

  it("a call still in admission when terminate() fires is recorded as withheld, not left unresolved", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: () => new Promise(() => {}), // never resolves — still in admission at terminate() time
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const handler = h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(handler.registry.resolve("1")?.phase).toBe("admission");

    await h.workerHost.terminate("workflow_timed_out");
    expect(handler.children.some((c) => c.callId === "1" && c.status === "withheld")).toBe(true);
  });

  it("a host_call arriving after terminate() has zero effect — S5 has already physically closed the port, so it is never even delivered to host.ts's listener", async () => {
    const h = harness();
    await h.boot();
    const handler = h.attach(noopSpawner(), async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    await h.workerHost.terminate("workflow_completed");
    h.postHostCall("1", "agent", { prompt: "too late", opts: null });
    await flush();
    // §2.3.1 S5 (WC09): the host's end of the `MessagePort` is closed before
    // `terminate()` resolves, independent of this module's own `terminated`
    // flag — the flag (checked in the `onHostCall` listener above) is
    // defense-in-depth for a delivery-ordering edge case that cannot actually
    // occur once S5 has run, not something this test can reach through the
    // port. The observable, physically-accurate guarantee is: nothing about
    // this call is ever recorded, and nothing is ever sent for it.
    expect(handler.registry.resolve("1")).toBeUndefined();
    expect(h.sent.find((m) => (m as { id?: string }).id === "1")).toBeUndefined();
  });
});

describe("host.ts: M10 child lifecycle events (onChildEvent)", () => {
  function harnessWithEvents(spawner: ChildSpawner) {
    const h = harness();
    const events: WorkflowChildEvent[] = [];
    return {
      ...h,
      events,
      attachWithEvents() {
        return attachHostCallHandler({
          clock: h.clock,
          workerHost: h.workerHost,
          spawner,
          gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
          budget: { ...BASE_BUDGET },
          onChildEvent: (e) => events.push(e),
        });
      },
    };
  }

  it("a successful live spawn fires 'spawned' (label/agentType/runId) after bind, then 'settled' once the child settles", async () => {
    let resolveOutcome!: (o: { settled: ChildOutcome[]; pending: string[] }) => void;
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: () => new Promise((resolve) => (resolveOutcome = resolve)),
    };
    const h = harnessWithEvents(spawner);
    await h.boot();
    const handler = h.attachWithEvents();

    h.postHostCall("1", "agent", { prompt: "task", opts: { label: "dev:a", agentType: "general-purpose" } });
    await flush();

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: "spawned",
      callId: "1",
      runId: "run1",
      label: "dev:a",
      agentType: "general-purpose",
    });

    resolveOutcome({ settled: [{ runId: "run1", status: "completed", text: "ok" }], pending: [] });
    await flush();

    expect(h.events).toHaveLength(2);
    expect(h.events[1]).toMatchObject({
      kind: "settled",
      callId: "1",
      runId: "run1",
      label: "dev:a",
      agentType: "general-purpose",
      status: "completed",
      source: "live",
    });
    // M10 side effect: the recorded summary itself now carries the label
    // (WorkflowChildSummary.label existed but was never populated).
    expect(handler.children[0]).toMatchObject({ callId: "1", label: "dev:a", status: "completed" });
  });

  // workflow-agent-queue §5: an admission-time spawn failure now also emits
  // "rejected" (stage admission) right before its withheld "settled".
  it("an admission-time spawn failure fires 'rejected' then 'settled' (withheld) — never a spawned-after-failure inversion", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ error: { message: "no slots" } }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const h = harnessWithEvents(spawner);
    await h.boot();
    h.attachWithEvents();

    h.postHostCall("1", "agent", { prompt: "task", opts: { label: "dev:b" } });
    await flush();

    expect(h.events).toHaveLength(2);
    expect(h.events[0]).toMatchObject({
      kind: "rejected",
      callId: "1",
      label: "dev:b",
      stage: "admission",
      reason: "spawn_error",
      message: "no slots",
    });
    expect(h.events[1]).toMatchObject({ kind: "settled", callId: "1", label: "dev:b", status: "withheld" });
    expect(h.events.some((e) => e.kind === "spawned")).toBe(false);
  });

  it("without an onChildEvent listener the handler behaves exactly as before (observational, never load-bearing)", async () => {
    const h = harness();
    await h.boot();
    const handler = h.attach(
      {
        spawn: async () => ({ runId: "run1" }),
        abort: async () => true,
        waitAll: async () => ({ settled: [{ runId: "run1", status: "completed", text: "ok" }], pending: [] }),
      },
      async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    );
    h.postHostCall("1", "agent", { prompt: "task", opts: null });
    await flush();
    expect(handler.children).toHaveLength(1);
    expect(handler.children[0]!.status).toBe("completed");
  });
});

/**
 * workflow-agent-queue D6–D8 (plan §3.3, review v1 Major-1 / #4): "whoever
 * flips a call to settled records it" — every exit path is guarded so each
 * callId gets exactly one `children[]` entry and at most one `host_settle`.
 */
function controllableSpawner() {
  const spawns: Array<{
    req: Parameters<ChildSpawner["spawn"]>[0];
    resolve(r: { runId: string; label?: string } | { error: { message: string } }): void;
    reject(e: unknown): void;
  }> = [];
  const aborts: Array<{ runId: string; cause?: string }> = [];
  const waiters = new Map<string, (o: ChildOutcome) => void>();
  const spawner: ChildSpawner = {
    spawn: (req) => new Promise((resolve, reject) => spawns.push({ req, resolve, reject })),
    abort: async (runId, cause) => {
      aborts.push({ runId, ...(cause !== undefined ? { cause } : {}) });
      return true;
    },
    waitAll: ({ runIds }) =>
      new Promise((resolve) => {
        const runId = runIds[0]!;
        waiters.set(runId, (o) => resolve({ settled: [o], pending: [] }));
      }),
  };
  return {
    spawner,
    spawns,
    aborts,
    finishChild(runId: string, status: ChildOutcome["status"] = "completed", text = "ok") {
      const w = waiters.get(runId);
      if (!w) throw new Error(`no waitAll registered for ${runId}`);
      waiters.delete(runId);
      w({ runId, status, text });
    },
    running(): string[] {
      return [...waiters.keys()];
    },
  };
}

function sentFor(sent: unknown[], id: string) {
  return {
    acks: sent.filter(
      (m) => (m as { kind?: string; id?: string }).kind === "host_ack" && (m as { id?: string }).id === id,
    ) as Array<Record<string, unknown>>,
    settles: sent.filter(
      (m) =>
        (m as { kind?: string; callId?: string }).kind === "host_settle" && (m as { callId?: string }).callId === id,
    ) as Array<Record<string, unknown>>,
  };
}

const okGate: GateRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

describe("host.ts: single-owner settlement (workflow-agent-queue D6–D8)", () => {
  it("D7: a phase timeout withholds an in-flight admission exactly once; a late successful spawn is orphan-aborted and the ack is cancelled", async () => {
    const h = harness({ phaseTotalMs: 1_000 });
    await h.boot();
    const c = controllableSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.workerData().commPort.postMessage({ kind: "phase", title: "p1" });
    await flush();
    h.postHostCall("1", "agent", { prompt: "slow spawn", opts: { phase: "p1" } });
    await flush();
    expect(c.spawns).toHaveLength(1);
    expect(handler.registry.resolve("1")?.phase).toBe("admission");

    h.clock.advance(1_000);
    await flush();
    // Previously: registry flipped to settled but nothing recorded / sent.
    expect(handler.children).toHaveLength(1);
    expect(handler.children[0]).toMatchObject({ callId: "1", status: "withheld", phaseId: "p1" });
    expect(sentFor(h.sent, "1").settles).toHaveLength(1);
    expect(sentFor(h.sent, "1").settles[0]).toMatchObject({
      ok: false,
      error: { message: "withheld (phase_timeout)" },
    });
    expect(sentFor(h.sent, "1").settles[0]).not.toHaveProperty("rejected");

    c.spawns[0]!.resolve({ runId: "late-run" });
    await flush();
    expect(c.aborts).toEqual([{ runId: "late-run", cause: "phase_timeout" }]);
    expect(sentFor(h.sent, "1").acks).toEqual([
      { kind: "host_ack", id: "1", ok: false, cancelled: true, cause: "phase_timeout" },
    ]);
    expect(handler.children).toHaveLength(1);
    expect(sentFor(h.sent, "1").settles).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("D7: a phase timeout followed by a late spawn *error* answers a cancelled ack and never records a second entry", async () => {
    const h = harness({ phaseTotalMs: 1_000 });
    await h.boot();
    const c = controllableSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.workerData().commPort.postMessage({ kind: "phase", title: "p1" });
    await flush();
    h.postHostCall("1", "agent", { prompt: "x", opts: { phase: "p1" } });
    await flush();
    h.clock.advance(1_000);
    await flush();
    c.spawns[0]!.resolve({ error: { message: "unknown agent type" } });
    await flush();
    expect(handler.children).toHaveLength(1);
    expect(handler.children[0]!.status).toBe("withheld");
    expect(sentFor(h.sent, "1").acks).toEqual([
      { kind: "host_ack", id: "1", ok: false, cancelled: true, cause: "phase_timeout" },
    ]);
    expect(sentFor(h.sent, "1").settles).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("D7: stopOwned() while spawn() is in flight, then spawn returns an error — exactly one children[] entry (was two)", async () => {
    const h = harness();
    await h.boot();
    const c = controllableSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "x", opts: null });
    await flush();
    const stopping = handler.stopOwned("user_stop", 1_000);
    await flush();
    expect(handler.children).toHaveLength(1);
    c.spawns[0]!.resolve({ error: { message: "spawn failed late" } });
    await flush();
    await stopping;
    expect(handler.children).toHaveLength(1);
    expect(handler.children[0]).toMatchObject({ callId: "1", status: "withheld" });
    expect(sentFor(h.sent, "1").settles).toHaveLength(1);
    expect(sentFor(h.sent, "1").settles[0]).toMatchObject({ error: { message: "workflow terminating (user_stop)" } });
  });

  it("D8: an HR2-timed-out admission is released at once (rejected settle, slot freed); the late spawn is orphan-aborted without a second record", async () => {
    const h = harness({ hostCallMs: 1_000, maxParallel: 1 });
    await h.boot();
    const c = controllableSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "hangs", opts: null });
    await flush();
    h.clock.advance(1_000);
    await flush();
    expect(sentFor(h.sent, "1").acks[0]).toMatchObject({ ok: false, error: { message: expect.stringMatching(/HR2/) } });
    expect(handler.registry.resolve("1")?.phase).toBe("settled");
    expect(handler.children).toEqual([expect.objectContaining({ callId: "1", status: "withheld" })]);
    expect(sentFor(h.sent, "1").settles).toEqual([
      expect.objectContaining({ ok: false, rejected: true, error: { message: expect.stringMatching(/HR2/) } }),
    ]);

    // The residual no longer occupies the single maxParallel slot.
    h.postHostCall("2", "agent", { prompt: "next", opts: null });
    await flush();
    expect(c.spawns).toHaveLength(2);
    c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    expect(sentFor(h.sent, "2").acks[0]).toMatchObject({ ok: true });

    c.spawns[0]!.resolve({ runId: "late-1" });
    await flush();
    expect(c.aborts).toEqual([{ runId: "late-1", cause: "host_call_timeout" }]);
    expect(handler.children.filter((s) => s.callId === "1")).toHaveLength(1);
    expect(sentFor(h.sent, "1").acks).toHaveLength(1);
    c.finishChild("r2");
    await flush();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("D8: a spawn() that throws acks the real error (not a fake HR2 timeout) and releases the admission", async () => {
    const h = harness({ maxParallel: 1 });
    await h.boot();
    const c = controllableSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "x", opts: null });
    await flush();
    c.spawns[0]!.reject(new Error("spawner exploded"));
    await flush();
    expect(sentFor(h.sent, "1").acks[0]).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/spawner exploded/) },
    });
    expect(handler.registry.resolve("1")?.phase).toBe("settled");
    expect(handler.children).toHaveLength(1);
    expect(handler.registry.listActive()).toEqual([]);
    expect(h.clock.pendingTimers).toBe(0);
  });
});

/**
 * workflow-agent-queue §3.3 D1–D5/D9 + §7 (stage A): agent() calls beyond
 * maxParallel are acked as queued and dispatched FIFO as slots free.
 */
describe("host.ts: FIFO queue beyond maxParallel (workflow-agent-queue D1–D5, D9)", () => {
  function queueHarness(overrides: Partial<WorkflowRunBudget> = {}, workflowDeadlineAt = 1_000_000) {
    const h = harness({ maxParallel: 1, ...overrides });
    const c = controllableSpawner();
    const events: WorkflowChildEvent[] = [];
    return {
      ...h,
      c,
      events,
      attachQ(extra: Partial<Parameters<typeof attachHostCallHandler>[0]> = {}) {
        return attachHostCallHandler({
          clock: h.clock,
          workerHost: h.workerHost,
          spawner: c.spawner,
          gateRunner: okGate,
          budget: { ...BASE_BUDGET, maxParallel: 1, ...overrides },
          workflowDeadlineAt,
          onChildEvent: (e) => events.push(e),
          ...extra,
        });
      },
      spawnedPrompts: () => c.spawns.map((s) => s.req.prompt),
    };
  }

  it("FIFO: queued calls are acked {queued:true} and dispatched in arrival order; a newcomer never jumps the queue", async () => {
    const h = queueHarness();
    await h.boot();
    const handler = h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    h.postHostCall("3", "agent", { prompt: "p3", opts: null });
    await flush();
    for (const id of ["2", "3"]) {
      expect(sentFor(h.sent, id).acks).toEqual([
        { kind: "host_ack", id, ok: true, value: { callId: id, deadlineAt: 1_000_000, queued: true } },
      ]);
    }
    expect(handler.registry.stats.queued).toBe(2);
    expect(h.spawnedPrompts()).toEqual(["p1"]);

    h.clock.advance(250);
    h.c.finishChild("r1");
    await flush();
    expect(h.spawnedPrompts()).toEqual(["p1", "p2"]);
    // p3 is still waiting even though the dispatch of p2 is in flight.
    h.postHostCall("4", "agent", { prompt: "p4", opts: null });
    await flush();
    expect(sentFor(h.sent, "4").acks[0]).toMatchObject({ ok: true, value: { queued: true } });
    h.c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    h.c.finishChild("r2", "completed", "two");
    await flush();
    expect(h.spawnedPrompts()).toEqual(["p1", "p2", "p3"]);
    h.c.spawns[2]!.resolve({ runId: "r3" });
    await flush();
    h.c.finishChild("r3");
    await flush();
    h.c.spawns[3]!.resolve({ runId: "r4" });
    await flush();
    h.c.finishChild("r4");
    await flush();
    expect(h.spawnedPrompts()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(handler.children.map((c) => c.callId)).toEqual(["1", "2", "3", "4"]);
    expect(handler.children[1]).toMatchObject({ status: "completed", queueWaitMs: 250 });
    expect(handler.children[0]).not.toHaveProperty("queueWaitMs"); // never queued
    expect(sentFor(h.sent, "2").settles).toEqual([expect.objectContaining({ ok: true, value: "two", runId: "r2" })]);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("the dispatched child gets the same deadline-capped budget as an immediate one (deriveChildBudget at dispatch time)", async () => {
    const h = queueHarness({}, 10_000);
    await h.boot();
    h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.clock.advance(4_000);
    h.c.finishChild("r1");
    await flush();
    expect(h.c.spawns[1]!.req).toMatchObject({
      prompt: "p2",
      deadlineAt: 10_000,
      budgetOverride: { totalMs: 6_000 },
    });
  });

  it("D9: stopOwned() withholds every queued call at once — one record each, spawn never called, no timers left", async () => {
    const h = queueHarness();
    await h.boot();
    const handler = h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    h.postHostCall("3", "agent", { prompt: "p3", opts: null });
    await flush();
    h.clock.advance(100);
    const stopping = handler.stopOwned("user_stop", 1_000);
    await flush();
    for (const id of ["2", "3"]) {
      expect(sentFor(h.sent, id).settles).toEqual([
        { kind: "host_settle", callId: id, ok: false, error: { message: "workflow terminating (user_stop)" } },
      ]);
    }
    expect(
      handler.children.filter((c) => c.status === "withheld").map((c) => [c.callId, c.durationMs, c.queueWaitMs]),
    ).toEqual([
      ["2", 100, 100],
      ["3", 100, 100],
    ]);
    expect(h.spawnedPrompts()).toEqual(["p1"]);
    h.clock.advance(1_000); // grace expires → the running child is force-settled
    await stopping;
    expect(handler.children.map((c) => c.callId).sort()).toEqual(["1", "2", "3"]);
    expect(handler.registry.listActive()).toEqual([]);
    expect(h.clock.pendingTimers).toBe(0);
    // The force-settled child's real outcome arriving later is ignored (single owner).
    h.c.finishChild("r1");
    await flush();
    expect(handler.children).toHaveLength(3);
    expect(sentFor(h.sent, "1").settles).toHaveLength(1);
  });

  it("D9: terminate() (onTerminating) withholds queued calls the same way", async () => {
    const h = queueHarness();
    await h.boot();
    const handler = h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    await flush();
    await h.workerHost.terminate("workflow_timed_out");
    expect(handler.children.map((c) => [c.callId, c.status])).toEqual([
      ["2", "withheld"],
      ["1", "aborted"],
    ]);
    expect(h.spawnedPrompts()).toEqual(["p1"]);
    expect(handler.registry.listActive()).toEqual([]);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("a phase timeout withholds only that phase's queued calls; other phases stay queued and dispatch later", async () => {
    const h = queueHarness({ phaseTotalMs: 1_000 });
    await h.boot();
    const handler = h.attachQ();
    const port = h.workerData().commPort;
    port.postMessage({ kind: "phase", title: "a" });
    await flush();
    h.postHostCall("1", "agent", { prompt: "a1", opts: { phase: "a" } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    h.postHostCall("2", "agent", { prompt: "a2", opts: { phase: "a" } });
    h.postHostCall("3", "agent", { prompt: "b1", opts: { phase: "b" } });
    await flush();
    h.clock.advance(1_000);
    await flush();
    expect(sentFor(h.sent, "2").settles).toEqual([
      expect.objectContaining({ ok: false, error: { message: "withheld (phase_timeout)" } }),
    ]);
    expect(h.c.aborts).toEqual([{ runId: "r1", cause: "phase_timeout" }]); // running child: A2 retry path
    expect(handler.registry.resolve("3")?.phase).toBe("queued");
    expect(h.spawnedPrompts()).toEqual(["a1"]);
    h.c.finishChild("r1", "aborted");
    await flush();
    expect(h.spawnedPrompts()).toEqual(["a1", "b1"]);
    expect(handler.children.map((c) => [c.callId, c.status])).toEqual([
      ["2", "withheld"],
      ["1", "aborted"],
    ]);
  });

  it("a phase timeout never dispatches a same-phase queued call while withholding its siblings", async () => {
    const h = queueHarness({ phaseTotalMs: 1_000 });
    await h.boot();
    const handler = h.attachQ();
    h.workerData().commPort.postMessage({ kind: "phase", title: "a" });
    await flush();
    for (const id of ["1", "2", "3"]) h.postHostCall(id, "agent", { prompt: `a${id}`, opts: { phase: "a" } });
    await flush();
    expect(handler.registry.resolve("1")?.phase).toBe("admission"); // spawn in flight
    h.clock.advance(1_000);
    await flush();
    expect(h.spawnedPrompts()).toEqual(["a1"]); // settling call 1 freed the slot, but a2/a3 were already withdrawn
    expect(handler.children.map((c) => c.callId).sort()).toEqual(["1", "2", "3"]);
    h.c.spawns[0]!.resolve({ runId: "late" });
    await flush();
    expect(h.c.aborts).toEqual([{ runId: "late", cause: "phase_timeout" }]);
    expect(handler.children).toHaveLength(3);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("dispatch-time BW2: a call that runs out of workflow budget while queued is withheld (null), not rejected", async () => {
    const h = queueHarness({}, 10_000);
    await h.boot();
    const handler = h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.clock.advance(10_000);
    h.c.finishChild("r1");
    await flush();
    expect(h.spawnedPrompts()).toEqual(["p1"]);
    expect(sentFor(h.sent, "2").settles).toEqual([
      { kind: "host_settle", callId: "2", ok: false, error: { message: "workflow deadline reached while queued" } },
    ]);
    expect(handler.children.find((c) => c.callId === "2")).toMatchObject({
      status: "withheld",
      durationMs: 10_000,
      queueWaitMs: 10_000,
    });
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("a dispatch-time spawn error settles rejected:true (worker rejects agent()) with one withheld record", async () => {
    const h = queueHarness();
    await h.boot();
    const handler = h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: { agentType: "bogus" } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    h.c.spawns[1]!.resolve({ error: { message: "unknown agent type: bogus" } });
    await flush();
    expect(sentFor(h.sent, "2").settles).toEqual([
      {
        kind: "host_settle",
        callId: "2",
        ok: false,
        error: { message: "unknown agent type: bogus" },
        rejected: true,
      },
    ]);
    expect(handler.children.filter((c) => c.callId === "2")).toEqual([expect.objectContaining({ status: "withheld" })]);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("review v2 #4 onSpawnThrew: a rejecting (or synchronously throwing) spawn() at dispatch settles rejected:true", async () => {
    const h = queueHarness();
    await h.boot();
    let calls = 0;
    const base = h.c.spawner;
    const spawner: ChildSpawner = {
      ...base,
      spawn: (req) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("spawn rejected"));
        if (calls === 3) throw new Error("spawn threw synchronously");
        return base.spawn(req);
      },
    };
    const handler = h.attachQ({ spawner });
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    h.postHostCall("3", "agent", { prompt: "p3", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    expect(sentFor(h.sent, "2").settles).toEqual([
      expect.objectContaining({ ok: false, rejected: true, error: { message: "spawn rejected" } }),
    ]);
    expect(sentFor(h.sent, "3").settles).toEqual([
      expect.objectContaining({ ok: false, rejected: true, error: { message: "spawn threw synchronously" } }),
    ]);
    expect(handler.children.map((c) => [c.callId, c.status])).toEqual([
      ["1", "completed"],
      ["2", "withheld"],
      ["3", "withheld"],
    ]);
    expect(handler.registry.listActive()).toEqual([]);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("review v1 Blocker-1: a dispatch spawn timeout settles rejected, frees the slot, and a late runId is orphan-aborted with no second settle", async () => {
    const h = queueHarness({ hostCallMs: 1_000 });
    await h.boot();
    const handler = h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    h.postHostCall("3", "agent", { prompt: "p3", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    expect(h.spawnedPrompts()).toEqual(["p1", "p2"]);
    h.clock.advance(1_000);
    await flush();
    expect(sentFor(h.sent, "2").settles).toEqual([
      {
        kind: "host_settle",
        callId: "2",
        ok: false,
        error: { message: "spawn did not complete within 1000ms" },
        rejected: true,
      },
    ]);
    expect(h.spawnedPrompts()).toEqual(["p1", "p2", "p3"]); // slot freed → p3 dispatched
    h.c.spawns[1]!.resolve({ runId: "late-2" });
    await flush();
    expect(h.c.aborts).toEqual([{ runId: "late-2", cause: "spawn_timeout" }]);
    expect(sentFor(h.sent, "2").settles).toHaveLength(1);
    expect(handler.children.filter((c) => c.callId === "2")).toHaveLength(1);
    h.c.spawns[2]!.resolve({ runId: "r3" });
    await flush();
    h.c.finishChild("r3");
    await flush();
    expect(h.clock.pendingTimers).toBe(0);
  });

  /**
   * review v1 Major-1: a queued dispatch whose spawn() is in flight is
   * withheld by a canceller (phase timeout / stopOwned); the spawn then ends
   * with an error, a success, or never (timeout). Every combination: exactly
   * one record, at most one settle, no armed timers.
   */
  for (const canceller of ["phase_timeout", "stopOwned"] as const) {
    for (const spawnEnd of ["error", "success", "timeout"] as const) {
      it(`Major-1 matrix: in-flight dispatch × ${canceller} × spawn ${spawnEnd} → exactly one record`, async () => {
        const h = queueHarness({ hostCallMs: 5_000, phaseTotalMs: 2_000 });
        await h.boot();
        const handler = h.attachQ();
        h.workerData().commPort.postMessage({ kind: "phase", title: "a" });
        await flush();
        h.postHostCall("1", "agent", { prompt: "p1", opts: { phase: "b" } });
        h.postHostCall("2", "agent", { prompt: "p2", opts: { phase: "a" } });
        await flush();
        h.c.spawns[0]!.resolve({ runId: "r1" });
        await flush();
        h.c.finishChild("r1");
        await flush();
        expect(handler.registry.resolve("2")?.phase).toBe("admission"); // dispatched, spawn in flight
        let stopping: Promise<unknown> | undefined;
        if (canceller === "phase_timeout") h.clock.advance(2_000);
        else stopping = handler.stopOwned("user_stop", 500);
        await flush();
        expect(handler.children.filter((c) => c.callId === "2")).toHaveLength(1);
        if (spawnEnd === "error") h.c.spawns[1]!.resolve({ error: { message: "late error" } });
        if (spawnEnd === "success") h.c.spawns[1]!.resolve({ runId: "late-2" });
        if (spawnEnd === "timeout") h.clock.advance(5_000);
        await flush();
        await stopping;
        expect(handler.children.filter((c) => c.callId === "2")).toHaveLength(1);
        expect(sentFor(h.sent, "2").settles).toHaveLength(1);
        expect(sentFor(h.sent, "2").settles[0]).not.toHaveProperty("rejected");
        const cause = canceller === "phase_timeout" ? "phase_timeout" : "user_stop";
        expect(h.c.aborts).toEqual(spawnEnd === "success" ? [{ runId: "late-2", cause }] : []);
        expect(h.clock.pendingTimers).toBe(0);
      });
    }
  }

  it("D8 + queue: an HR2-timed-out immediate admission releases its slot, so the queued call behind it dispatches", async () => {
    const h = queueHarness({ hostCallMs: 1_000 });
    await h.boot();
    h.attachQ();
    h.postHostCall("1", "agent", { prompt: "hangs", opts: null });
    await flush();
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    await flush();
    expect(sentFor(h.sent, "2").acks[0]).toMatchObject({ ok: true, value: { queued: true } });
    expect(h.spawnedPrompts()).toEqual(["hangs"]);
    h.clock.advance(1_000);
    await flush();
    expect(h.spawnedPrompts()).toEqual(["hangs", "p2"]);
  });

  it("maxChildren counts queued calls", async () => {
    const h = queueHarness({ maxChildren: 2 });
    await h.boot();
    h.attachQ();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    h.postHostCall("3", "agent", { prompt: "p3", opts: null });
    await flush();
    expect(sentFor(h.sent, "2").acks[0]).toMatchObject({ ok: true, value: { queued: true } });
    expect(sentFor(h.sent, "3").acks[0]).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/maxChildren \(2\)/) },
    });
  });

  it("a replay hit at full load settles immediately — it is never queued", async () => {
    const h = queueHarness();
    await h.boot();
    const entry = {
      v: 1,
      scope: "content",
      key: "key",
      chainDigestBefore: "root",
      occurrence: 0,
      agentType: "worker",
      status: "completed",
      value: "cached",
      completedAt: 1,
      durationMs: 0,
      digest: "digest",
    } as JournalEntry;
    let lookups = 0;
    const index: ReplayIndex = {
      scope: "content",
      lookup: () => (++lookups === 1 ? undefined : entry), // 1st call misses (live), 2nd hits
      stats: { loadedEntries: 1, corruptLines: 0, scopeMismatch: 0 },
    };
    const handler = h.attachQ({
      spawner: { ...h.c.spawner, configHashOf: () => "hash" },
      journal: {
        store: { append: () => undefined } as never,
        dir: ".",
        index,
        scope: "content",
        noReplay: false,
        deterministic: { current: true },
      },
    });
    h.postHostCall("1", "agent", { prompt: "live", opts: null });
    await flush();
    h.postHostCall("2", "agent", { prompt: "cached", opts: null });
    await flush();
    expect(sentFor(h.sent, "2").acks[0]).toMatchObject({ ok: true });
    expect(sentFor(h.sent, "2").acks[0]!.value).not.toHaveProperty("queued");
    expect(sentFor(h.sent, "2").settles).toEqual([expect.objectContaining({ ok: true, value: "cached" })]);
    expect(handler.registry.stats.queued).toBe(0);
    expect(handler.children).toEqual([expect.objectContaining({ callId: "2", source: "replay" })]);
  });
});

/** workflow-agent-queue D10/§5: queued / rejected events and their ordering. */
describe("host.ts: queued/rejected child events (workflow-agent-queue D10, §5)", () => {
  function eventHarness(overrides: Partial<WorkflowRunBudget> = {}, workflowDeadlineAt = 1_000_000) {
    const h = harness({ maxParallel: 1, ...overrides });
    const c = controllableSpawner();
    const events: WorkflowChildEvent[] = [];
    const attach = () =>
      attachHostCallHandler({
        clock: h.clock,
        workerHost: h.workerHost,
        spawner: c.spawner,
        gateRunner: okGate,
        budget: { ...BASE_BUDGET, maxParallel: 1, ...overrides },
        workflowDeadlineAt,
        onChildEvent: (e) => events.push(e),
      });
    const kindsOf = (callId: string) => events.filter((e) => e.callId === callId).map((e) => e.kind);
    return { ...h, c, events, attach, kindsOf };
  }

  it("a queued call emits queued → spawned → settled (settled carries queueWaitMs); an immediate one never emits queued", async () => {
    const h = eventHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p1", opts: { label: "first" } });
    h.postHostCall("2", "agent", { prompt: "p2", opts: { label: "second", agentType: "Explore", phase: "scan" } });
    await flush();
    expect(h.events.find((e) => e.kind === "queued")).toEqual({
      kind: "queued",
      callId: "2",
      label: "second",
      agentType: "Explore",
      phaseId: "scan",
      at: 0,
    });
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.clock.advance(300);
    h.c.finishChild("r1");
    await flush();
    h.c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    h.c.finishChild("r2");
    await flush();
    expect(h.kindsOf("1")).toEqual(["spawned", "settled"]);
    expect(h.kindsOf("2")).toEqual(["queued", "spawned", "settled"]);
    expect(h.events.find((e) => e.kind === "settled" && e.callId === "2")).toMatchObject({ queueWaitMs: 300 });
    expect(h.events.find((e) => e.kind === "settled" && e.callId === "1")).not.toHaveProperty("queueWaitMs");
  });

  it("cancellation-class outcomes (stop, phase timeout, out of budget while queued) emit only settled — never rejected", async () => {
    const h = eventHarness({ phaseTotalMs: 1_000 }, 5_000);
    await h.boot();
    const handler = h.attach();
    h.workerData().commPort.postMessage({ kind: "phase", title: "a" });
    await flush();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: { phase: "a" } }); // phase timeout while queued
    h.postHostCall("3", "agent", { prompt: "p3", opts: null }); // out of budget while queued
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.clock.advance(1_000);
    await flush();
    h.clock.advance(4_000);
    h.c.finishChild("r1");
    await flush();
    h.postHostCall("4", "agent", { prompt: "p4", opts: null });
    await flush();
    await handler.stopOwned("user_stop", 100);
    expect(h.kindsOf("2")).toEqual(["queued", "settled"]);
    expect(h.kindsOf("3")).toEqual(["queued", "settled"]);
    expect(h.events.some((e) => e.kind === "rejected" && e.callId !== "4")).toBe(false);
  });

  it("dispatch-stage rejections: rejected(stage dispatch) precedes the withheld settled — spawn_error and spawn_timeout", async () => {
    const h = eventHarness({ hostCallMs: 1_000 });
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: { label: "two" } });
    h.postHostCall("3", "agent", { prompt: "p3", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    h.c.spawns[1]!.resolve({ error: { message: "E".repeat(250) } });
    await flush();
    h.clock.advance(1_000); // p3's dispatch spawn times out
    await flush();
    expect(h.kindsOf("2")).toEqual(["queued", "rejected", "settled"]);
    expect(h.kindsOf("3")).toEqual(["queued", "rejected", "settled"]);
    const r2 = h.events.find((e) => e.kind === "rejected" && e.callId === "2")!;
    expect(r2).toMatchObject({ stage: "dispatch", reason: "spawn_error", label: "two", agentType: "general-purpose" });
    expect(r2.message).toHaveLength(200);
    expect(h.events.find((e) => e.kind === "rejected" && e.callId === "3")).toMatchObject({
      stage: "dispatch",
      reason: "spawn_timeout",
      message: "spawn did not complete within 1000ms",
    });
  });

  it("admission-stage rejections: invalid_args, max_children and budget_exhausted emit rejected only (no children[] record)", async () => {
    const h = eventHarness({ maxChildren: 1, maxParallel: 4 });
    await h.boot();
    const handler = h.attach();
    h.postHostCall("bad", "agent", { prompt: 42, opts: { label: "L" } });
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: { label: "over" } });
    await flush();
    expect(h.kindsOf("bad")).toEqual(["rejected"]);
    expect(h.events.find((e) => e.callId === "bad")).toMatchObject({
      stage: "admission",
      reason: "invalid_args",
      label: "L",
    });
    expect(h.kindsOf("2")).toEqual(["rejected"]);
    expect(h.events.find((e) => e.callId === "2")).toMatchObject({ reason: "max_children", label: "over" });
    expect(handler.children).toEqual([]);

    const h2 = eventHarness({}, -1); // workflow budget already exhausted
    await h2.boot();
    h2.attach();
    h2.postHostCall("x", "agent", { prompt: "p", opts: { agentType: "Plan" } });
    await flush();
    expect(h2.events).toEqual([
      expect.objectContaining({
        kind: "rejected",
        callId: "x",
        stage: "admission",
        reason: "budget_exhausted",
        agentType: "Plan",
      }),
    ]);
  });

  it("immediate-path spawn error and HR2 residual emit rejected(stage admission) → settled", async () => {
    const h = eventHarness({ hostCallMs: 1_000, maxParallel: 4 });
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ error: { message: "unknown agent type" } });
    await flush();
    h.clock.advance(1_000); // p2's spawn never answers → HR2
    await flush();
    expect(h.kindsOf("1")).toEqual(["rejected", "settled"]);
    expect(h.events.find((e) => e.kind === "rejected" && e.callId === "1")).toMatchObject({
      stage: "admission",
      reason: "spawn_error",
      message: "unknown agent type",
    });
    expect(h.kindsOf("2")).toEqual(["rejected", "settled"]);
    expect(h.events.find((e) => e.kind === "rejected" && e.callId === "2")).toMatchObject({
      stage: "admission",
      reason: "host_call_timeout",
    });
  });
});

describe("host.ts: agent() model/thinking overrides (Agent-tool model/thinking semantics)", () => {
  function modelHarness(budgetOverrides: Partial<WorkflowRunBudget> = {}) {
    const h = harness({ maxParallel: 4, ...budgetOverrides });
    const c = controllableSpawner();
    const events: WorkflowChildEvent[] = [];
    return {
      ...h,
      c,
      events,
      attach(extra: Partial<Parameters<typeof attachHostCallHandler>[0]> = {}) {
        return attachHostCallHandler({
          clock: h.clock,
          workerHost: h.workerHost,
          spawner: c.spawner,
          gateRunner: okGate,
          budget: { ...BASE_BUDGET, maxParallel: 4, ...budgetOverrides },
          workflowDeadlineAt: 1_000_000,
          onChildEvent: (e) => events.push(e),
          ...extra,
        });
      },
      kindsOf(callId: string): string[] {
        return events.filter((e) => e.callId === callId).map((e) => e.kind);
      },
    };
  }

  it("splits a strict provider/id pair into modelOverride on the spawn request (no hint field)", async () => {
    const h = modelHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p", opts: { model: "cr-anthropic/claude-sonnet-5" } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    expect(h.c.spawns[0]!.req).toMatchObject({ modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-5" } });
    expect(h.c.spawns[0]!.req).not.toHaveProperty("modelHintOverride");
    expect(h.c.spawns[0]!.req).not.toHaveProperty("thinkingOverride");
    h.c.finishChild("r1");
    await flush();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it('treats model: "" as no override (same rule as the Agent tool)', async () => {
    const h = modelHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p", opts: { model: "" } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    expect(h.c.spawns[0]!.req).not.toHaveProperty("modelOverride");
    expect(h.c.spawns[0]!.req).not.toHaveProperty("modelHintOverride");
    h.c.finishChild("r1");
    await flush();
  });

  it("keeps a non-pair model as modelHintOverride (fuzzy hint resolved at spawn admission)", async () => {
    const h = modelHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p", opts: { model: "sonnet" } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    expect(h.c.spawns[0]!.req).toMatchObject({ modelHintOverride: "sonnet" });
    expect(h.c.spawns[0]!.req).not.toHaveProperty("modelOverride");
    h.c.finishChild("r1");
    await flush();
  });

  it("threads opts.thinking as thinkingOverride (composable with model)", async () => {
    const h = modelHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p", opts: { model: "zai/glm-5.3", thinking: "high" } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    expect(h.c.spawns[0]!.req).toMatchObject({
      modelOverride: { provider: "zai", id: "glm-5.3" },
      thinkingOverride: "high",
    });
    h.c.finishChild("r1");
    await flush();
  });

  it("adds no override fields when the script passed neither (request shape unchanged)", async () => {
    const h = modelHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    expect(h.c.spawns[0]!.req).not.toHaveProperty("modelOverride");
    expect(h.c.spawns[0]!.req).not.toHaveProperty("modelHintOverride");
    expect(h.c.spawns[0]!.req).not.toHaveProperty("thinkingOverride");
    h.c.finishChild("r1");
    await flush();
  });

  it("a queued call carries its model/thinking overrides to the delayed dispatch", async () => {
    const h = modelHarness({ maxParallel: 1 });
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: { model: "cr-kimi/kimi-k3", thinking: "low" } });
    await flush();
    expect(sentFor(h.sent, "2").acks[0]).toMatchObject({ ok: true, value: { queued: true } });
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    h.c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    expect(h.c.spawns[1]!.req).toMatchObject({
      prompt: "p2",
      modelOverride: { provider: "cr-kimi", id: "kimi-k3" },
      thinkingOverride: "low",
    });
    h.c.finishChild("r2");
    await flush();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("rejects a non-string model / out-of-set thinking at admission (invalid_args) before spawn", async () => {
    const h = modelHarness();
    await h.boot();
    h.attach();
    h.postHostCall("m", "agent", { prompt: "p", opts: { model: 42 } });
    h.postHostCall("t", "agent", { prompt: "p", opts: { thinking: "max" } });
    await flush();
    expect(h.c.spawns).toHaveLength(0);
    expect(sentFor(h.sent, "m").acks[0]).toMatchObject({
      ok: false,
      error: { message: "agent(prompt, opts?): opts.model must be a string" },
    });
    expect(sentFor(h.sent, "t").acks[0]).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("opts.thinking must be one of") },
    });
    for (const id of ["m", "t"]) {
      expect(h.events.find((e) => e.kind === "rejected" && e.callId === id)).toMatchObject({
        stage: "admission",
        reason: "invalid_args",
      });
    }
  });

  it("an unknown-model spawn error acks ok:false with the spawn-service message verbatim (suggestions preserved)", async () => {
    const h = modelHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p", opts: { model: "cloudrouter-anthropic/claude-opus-5-5" } });
    await flush();
    const message =
      'Unknown model "cloudrouter-anthropic/claude-opus-5-5" \u2014 not in pi\'s model registry, so no run was ' +
      "started. Did you mean: cr-anthropic/claude-opus-5-5?";
    h.c.spawns[0]!.resolve({ error: { message } });
    await flush();
    expect(sentFor(h.sent, "1").acks[0]).toMatchObject({ ok: false, error: { message } });
    expect(h.events.find((e) => e.kind === "rejected" && e.callId === "1")).toMatchObject({
      stage: "admission",
      reason: "spawn_error",
      message: expect.stringContaining("Did you mean"),
    });
  });

  it("a queued call whose dispatch fails on the model settles rejected:true (worker-side agent() rejects)", async () => {
    const h = modelHarness({ maxParallel: 1 });
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p1", opts: null });
    h.postHostCall("2", "agent", { prompt: "p2", opts: { model: "ghost/model-x" } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    h.c.spawns[1]!.resolve({ error: { message: 'Unknown model "ghost/model-x". Did you mean: zai/glm-5.3?' } });
    await flush();
    expect(h.kindsOf("2")).toEqual(["queued", "rejected", "settled"]);
    expect(h.events.find((e) => e.kind === "rejected" && e.callId === "2")).toMatchObject({
      stage: "dispatch",
      reason: "spawn_error",
    });
    expect(sentFor(h.sent, "2").settles[0]).toMatchObject({
      ok: false,
      rejected: true,
      error: { message: expect.stringContaining("Did you mean") },
    });
    expect(h.clock.pendingTimers).toBe(0);
  });
});

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §4.1/§4.4, §6 A/B):
 * strict opts validation and the experts admission gate, driven through the
 * real host_call envelope path (no worker involved — the worker's own JS
 * mirror gets real-`vm` coverage in worker-host-call.test.ts).
 */
describe("host.ts: strict agent() opts validation (workflow-experts §4.1/§4.4)", () => {
  it("an unknown key on a raw envelope (no optsReport at all — host's own independent re-snapshot) is rejected with the allowed-key list", async () => {
    const h = harness();
    await h.boot();
    h.attach(noopSpawner(), okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { effort: "low" } });
    await flush();
    const ack = sentFor(h.sent, "1").acks[0] as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toContain('"effort"');
    expect(ack.error?.message).toContain("allowed:");
  });

  it("opts: false is rejected as not a plain object (D4 — no longer silently treated as {})", async () => {
    const h = harness();
    await h.boot();
    h.attach(noopSpawner(), okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: false });
    await flush();
    const ack = sentFor(h.sent, "1").acks[0] as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toContain("plain object");
  });

  it("the worker's own optsReport.defect is honored even when the transited opts object looks fine to the host", async () => {
    const h = harness();
    await h.boot();
    h.attach(noopSpawner(), okGate);
    h.postHostCall("1", "agent", {
      prompt: "p",
      opts: {},
      optsReport: { defect: { code: "accessor", key: "label" } },
    });
    await flush();
    const ack = sentFor(h.sent, "1").acks[0] as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toContain("label");
  });

  it("an invalid_args rejection never creates a children[] record (admission-stage, same as max_children/BW2)", async () => {
    const h = harness();
    await h.boot();
    const handler = h.attach(noopSpawner(), okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { effort: "low" } });
    await flush();
    expect(handler.children).toEqual([]);
  });
});

describe("host.ts: agent({ experts }) admission (workflow-experts §4.4, D9/D11)", () => {
  function expertsHarness(budgetOverrides: Partial<WorkflowRunBudget> = {}) {
    const h = harness({ maxParallel: 4, ...budgetOverrides });
    const c = controllableSpawner();
    const events: WorkflowChildEvent[] = [];
    return {
      ...h,
      c,
      events,
      attach(extra: Partial<Parameters<typeof attachHostCallHandler>[0]> = {}) {
        return attachHostCallHandler({
          clock: h.clock,
          workerHost: h.workerHost,
          spawner: c.spawner,
          gateRunner: okGate,
          budget: { ...BASE_BUDGET, maxParallel: 4, ...budgetOverrides },
          workflowDeadlineAt: 1_000_000,
          onChildEvent: (e) => events.push(e),
          ...extra,
        });
      },
      kindsOf(callId: string): string[] {
        return events.filter((e) => e.callId === callId).map((e) => e.kind);
      },
    };
  }

  it("rejects with 'not supported in this context' when no resolveExperts is wired at all (D17)", async () => {
    const h = expertsHarness();
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "p", opts: { experts: ["dev"] } });
    await flush();
    expect(h.c.spawns).toHaveLength(0);
    const ack = sentFor(h.sent, "1").acks[0] as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toContain("not supported in this context");
    expect(h.events.find((e) => e.kind === "rejected" && e.callId === "1")).toMatchObject({
      stage: "admission",
      reason: "experts_unresolved",
    });
  });

  it("a successful resolution forwards consultExperts on the spawn request and records experts on the settled summary", async () => {
    const h = expertsHarness();
    await h.boot();
    const refs = [{ runId: "r-expert", sessionFile: "/tmp/r-expert.jsonl", agentType: "gp" }];
    const resolveExperts = vi.fn(() => ({ refs }));
    const handler = h.attach({ spawner: { ...h.c.spawner, resolveExperts } });
    h.postHostCall("1", "agent", { prompt: "p", opts: { experts: ["outside"] } });
    await flush();
    expect(resolveExperts).toHaveBeenCalledWith(["outside"]);
    expect(h.c.spawns[0]!.req).toMatchObject({ consultExperts: refs });
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    expect(handler.children[0]).toMatchObject({ experts: ["r-expert"] });
  });

  it("a resolver failure rejects the call with experts_unresolved, never calls spawn, and records no children[] entry", async () => {
    const h = expertsHarness();
    await h.boot();
    const resolveExperts = vi.fn(() => ({ error: { message: "expert not found" } }));
    const handler = h.attach({ spawner: { ...h.c.spawner, resolveExperts } });
    h.postHostCall("1", "agent", { prompt: "p", opts: { experts: ["ghost"] } });
    await flush();
    expect(h.c.spawns).toHaveLength(0);
    expect(handler.children).toEqual([]);
    const ack = sentFor(h.sent, "1").acks[0] as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toBe("expert not found");
    expect(h.events.find((e) => e.kind === "rejected" && e.callId === "1")).toMatchObject({
      stage: "admission",
      reason: "experts_unresolved",
    });
  });

  it("a call with experts:[] (validated to undefined) never touches resolveExperts at all", async () => {
    const h = expertsHarness();
    await h.boot();
    const resolveExperts = vi.fn(() => ({ refs: [] }));
    h.attach({ spawner: { ...h.c.spawner, resolveExperts } });
    h.postHostCall("1", "agent", { prompt: "p", opts: { experts: [] } });
    await flush();
    expect(resolveExperts).not.toHaveBeenCalled();
    expect(h.c.spawns[0]!.req).not.toHaveProperty("consultExperts");
  });
});

describe("host.ts: chain-taint replay safety (workflow-experts D12-D15, §5)", () => {
  function taintHarness(budgetOverrides: Partial<WorkflowRunBudget> = {}) {
    const h = harness({ maxParallel: 4, ...budgetOverrides });
    const c = controllableSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    return {
      ...h,
      c,
      appendSpy,
      attach(extra: Partial<Parameters<typeof attachHostCallHandler>[0]> = {}) {
        return attachHostCallHandler({
          clock: h.clock,
          workerHost: h.workerHost,
          spawner: { ...c.spawner, configHashOf: () => "hash" },
          gateRunner: okGate,
          budget: { ...BASE_BUDGET, maxParallel: 4, ...budgetOverrides },
          workflowDeadlineAt: 1_000_000,
          journal: {
            store: { append: appendSpy } as never,
            dir: ".",
            index,
            scope: "chain",
            noReplay: false,
            deterministic: { current: true },
          },
          ...extra,
        });
      },
    };
  }

  it("an experts call itself is never journaled, even though it completes successfully", async () => {
    const h = taintHarness();
    await h.boot();
    const refs = [{ runId: "r-expert", sessionFile: "/tmp/r-expert.jsonl", agentType: "gp" }];
    const resolveExperts = vi.fn(() => ({ refs }));
    const handler = h.attach({ spawner: { ...h.c.spawner, resolveExperts } });
    h.postHostCall("1", "agent", { prompt: "p", opts: { experts: ["outside"] } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    expect(h.appendSpy).not.toHaveBeenCalled();
    expect(handler.replayStats).toMatchObject({ tainted: true });
  });

  it("a call submitted after a successful experts resolution is chain_tainted and never journaled, even though it declares no experts of its own", async () => {
    const h = taintHarness();
    await h.boot();
    const refs = [{ runId: "r-expert", sessionFile: "/tmp/r-expert.jsonl", agentType: "gp" }];
    const resolveExperts = vi.fn(() => ({ refs }));
    h.attach({ spawner: { ...h.c.spawner, resolveExperts } });
    h.postHostCall("1", "agent", { prompt: "expert-call", opts: { experts: ["outside"] } });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain-call", opts: null });
    await flush();
    h.c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    h.c.finishChild("r2");
    await flush();
    expect(h.appendSpy).not.toHaveBeenCalled();
  });

  it("a call BEFORE any taint is journaled normally (baseline, taint is not global-by-default)", async () => {
    const h = taintHarness();
    await h.boot();
    const handler = h.attach();
    h.postHostCall("1", "agent", { prompt: "plain-call", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    h.c.finishChild("r1");
    await flush();
    expect(h.appendSpy).toHaveBeenCalledTimes(1);
    expect(handler.replayStats).not.toHaveProperty("tainted");
  });

  it("a REJECTED experts call (resolver failure) never taints the chain — the next plain call still journals", async () => {
    const h = taintHarness();
    await h.boot();
    const resolveExperts = vi.fn(() => ({ error: { message: "nope" } }));
    const handler = h.attach({ spawner: { ...h.c.spawner, resolveExperts } });
    h.postHostCall("1", "agent", { prompt: "expert-call", opts: { experts: ["ghost"] } });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain-call", opts: null });
    await flush();
    h.c.spawns[0]!.resolve({ runId: "r2" });
    await flush();
    h.c.finishChild("r2");
    await flush();
    expect(h.appendSpy).toHaveBeenCalledTimes(1);
    expect(handler.replayStats).not.toHaveProperty("tainted");
  });
});
