import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import {
  attachHostCallHandler,
  type ChildOutcome,
  type ChildSpawner,
  type ChildSpawnResult,
  type GateRunner,
} from "../../src/workflow/host.js";
import type { ChildWorktreeInfo, WorkflowRunBudget } from "../../src/workflow/types.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * workflow-worktree plan §6 P2 tests 14-18/21: `agent(prompt, {
 * isolation: "worktree" })` end-to-end through host.ts's own logic (D1
 * transfer, D2 availability gate, D5 settle-wait/late-listener, D7 stop
 * behavior, D3 replay skip/taint) — driven entirely by `FakeClock` + the
 * same fake-worker harness `host.test.ts` uses, mirroring its structure so
 * a reviewer can diff the two files directly.
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
  worktreeSettleMaxMs: 6_000,
};

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
    attach(
      spawner: ChildSpawner,
      gateRunner: GateRunner,
      workflowDeadlineAt?: number,
      extra: Record<string, unknown> = {},
    ) {
      return attachHostCallHandler({
        clock,
        workerHost,
        spawner,
        gateRunner,
        budget: { ...BASE_BUDGET, ...budgetOverrides },
        ...(workflowDeadlineAt !== undefined ? { workflowDeadlineAt } : {}),
        ...extra,
      });
    },
  };
}

async function flush(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const okGate: GateRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

interface AwaitCall {
  runId: string;
  horizon: "settle" | "late";
  capMs?: number;
  resolve(info: ChildWorktreeInfo): void;
}

/**
 * A `ChildSpawner` double with fully manual control over spawn/waitAll/
 * awaitWorktree, so tests can interleave "outcome arrives" and "H3 mark
 * arrives" in either order and assert on the in-flight state in between.
 */
function controllableWorktreeSpawner(opts: { worktreeAvailable?: boolean; noAwaitWorktree?: boolean } = {}) {
  const spawns: Array<{
    req: Parameters<ChildSpawner["spawn"]>[0];
    resolve(r: ChildSpawnResult | { error: { message: string } }): void;
  }> = [];
  const waiters = new Map<string, (o: ChildOutcome) => void>();
  const awaitCalls: AwaitCall[] = [];
  const base: ChildSpawner = {
    spawn: (req) => new Promise((resolve) => spawns.push({ req, resolve })),
    abort: async () => true,
    waitAll: ({ runIds }) =>
      new Promise((resolve) => {
        const runId = runIds[0]!;
        waiters.set(runId, (o) => resolve({ settled: [o], pending: [] }));
      }),
    worktreeAvailable: () => opts.worktreeAvailable ?? true,
  };
  const spawner: ChildSpawner = opts.noAwaitWorktree
    ? base
    : {
        ...base,
        awaitWorktree: (runId, waitOpts) =>
          new Promise((resolve) => {
            awaitCalls.push({ runId, horizon: waitOpts.horizon, capMs: waitOpts.capMs, resolve });
          }),
      };
  return {
    spawner,
    spawns,
    awaitCalls,
    finishChild(runId: string, status: ChildOutcome["status"] = "completed", text = "ok") {
      const w = waiters.get(runId);
      if (!w) throw new Error(`no waitAll registered for ${runId}`);
      waiters.delete(runId);
      w({ runId, status, text });
    },
    resolveAwait(runId: string, horizon: "settle" | "late", info: ChildWorktreeInfo) {
      const idx = awaitCalls.findIndex((c) => c.runId === runId && c.horizon === horizon);
      if (idx === -1) throw new Error(`no awaitWorktree(${horizon}) registered for ${runId}`);
      const [call] = awaitCalls.splice(idx, 1);
      call!.resolve(info);
    },
    hasAwait(runId: string, horizon: "settle" | "late"): boolean {
      return awaitCalls.some((c) => c.runId === runId && c.horizon === horizon);
    },
  };
}

function settleFor(sent: unknown[], callId: string) {
  return sent.find(
    (m) =>
      (m as { kind?: string; callId?: string }).kind === "host_settle" && (m as { callId?: string }).callId === callId,
  ) as { ok: boolean; value?: unknown; error?: { message: string }; worktree?: ChildWorktreeInfo } | undefined;
}
function ackFor(sent: unknown[], id: string) {
  return sent.find(
    (m) => (m as { kind?: string; id?: string }).kind === "host_ack" && (m as { id?: string }).id === id,
  ) as { ok: boolean; error?: { message: string } } | undefined;
}

describe("host.ts: D1 isolation transfer to ChildSpawner.spawn()", () => {
  it("forwards isolation on the immediate-dispatch path", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    expect(c.spawns[0]!.req).toMatchObject({ isolation: "worktree" });
  });

  it("forwards isolation on the queued-dispatch path (beyond maxParallel)", async () => {
    const h = harness({ maxParallel: 1 });
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p1", opts: { isolation: "worktree" } });
    await flush();
    h.postHostCall("2", "agent", { prompt: "p2", opts: { isolation: "worktree" } });
    await flush();
    expect(c.spawns).toHaveLength(1); // "2" is still queued
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "clean" });
    await flush();
    expect(c.spawns).toHaveLength(2);
    expect(c.spawns[1]!.req).toMatchObject({ isolation: "worktree" });
  });

  it("an ordinary call never carries an isolation key at all", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: null });
    await flush();
    expect(c.spawns[0]!.req).not.toHaveProperty("isolation");
  });
});

describe("host.ts: D2 availability gate (no fallback, decision 1)", () => {
  it("worktreeAvailable() !== true rejects with isolation_unavailable, never reaches spawn()", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner({ worktreeAvailable: false });
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    expect(c.spawns).toHaveLength(0);
    const ack = ackFor(h.sent, "1");
    expect(ack?.ok).toBe(false);
    expect(ack?.error?.message).toMatch(/isolation_unavailable|worktree\.enabled/);
    expect(ack?.error?.message).toContain('isolation:"worktree"');
  });

  it("an absent worktreeAvailable() (older/fake ChildSpawner) fails closed the same way", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "unused" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    h.attach(spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    const ack = ackFor(h.sent, "1");
    expect(ack?.ok).toBe(false);
  });

  it("a rejected isolation call never taints the chain (D3) — a later plain call still journals", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner({ worktreeAvailable: false });
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, undefined, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    expect(ackFor(h.sent, "1")?.ok).toBe(false);
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[0]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2");
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(1); // not tainted by the rejected isolation call
  });

  it("an ACCEPTED isolation call DOES taint the chain — a later plain call is chain_tainted and never journaled", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    const handler = h.attach(c.spawner, okGate, undefined, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "clean" });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2");
    await flush();
    expect(appendSpy).not.toHaveBeenCalled(); // the isolated call itself is never journaled either
    expect(handler.replayStats).toMatchObject({ tainted: true });
  });
});

describe("host.ts: D5 settle-wait for an isolated call", () => {
  it("outcome then a settled disposition (kept path/committed branch) both land in the summary and the settle envelope", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree", fullResult: true } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1", "completed", "child text");
    await flush();
    expect(c.hasAwait("r1", "settle")).toBe(true);
    c.resolveAwait("r1", "settle", { state: "committed", branch: "pi-agent-r1" });
    await flush();
    const settle = settleFor(h.sent, "1");
    expect(settle?.ok).toBe(true);
    expect(settle?.worktree).toEqual({ state: "committed", branch: "pi-agent-r1" });
  });

  it("a disposition already resolved by the time the host asks resolves the settle without waiting", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    expect(c.hasAwait("r1", "settle")).toBe(true);
    c.resolveAwait("r1", "settle", { state: "kept", path: "/tmp/wt/r1" });
    await flush();
    const settle = settleFor(h.sent, "1");
    expect(settle?.worktree).toEqual({ state: "kept", path: "/tmp/wt/r1" });
  });

  it("a settle-horizon timeout (host's own withDeadline fires first) settles as pending", async () => {
    const h = harness({ worktreeSettleMaxMs: 2_000 });
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate, h.clock.now() + 60_000);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    expect(c.awaitCalls[0]).toMatchObject({ runId: "r1", horizon: "settle", capMs: 2_000 });
    h.clock.advance(2_001);
    await flush();
    const settle = settleFor(h.sent, "1");
    expect(settle?.ok).toBe(true);
    expect(settle?.worktree).toEqual({ state: "pending" });
    // no second message ever follows for this callId (D5: pending is frozen once handed to the worker).
    const before = h.sent.filter((m) => (m as { callId?: string }).callId === "1").length;
    c.resolveAwait("r1", "late", { state: "committed", branch: "pi-agent-r1" });
    await flush();
    expect(h.sent.filter((m) => (m as { callId?: string }).callId === "1").length).toBe(before);
  });

  it("a REJECTING awaitWorktree (contract violation) settles as pending, never none (§6 #15)", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const spawner: ChildSpawner = { ...c.spawner, awaitWorktree: async () => Promise.reject(new Error("port broke")) };
    h.attach(spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree", fullResult: true } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    const settle = settleFor(h.sent, "1");
    expect(settle?.ok).toBe(true);
    expect(settle?.worktree).toEqual({ state: "pending" });
  });

  it("an absent awaitWorktree (older/fake ChildSpawner) degrades to worktree:none rather than hanging", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner({ noAwaitWorktree: true });
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    const settle = settleFor(h.sent, "1");
    expect(settle?.worktree).toEqual({ state: "none" });
  });

  it("the settle-wait cap follows budget.worktreeSettleMaxMs, bounded by remainingWorkflowMs", async () => {
    const h = harness({ worktreeSettleMaxMs: 90_000 });
    await h.boot();
    const c = controllableWorktreeSpawner();
    // remainingWorkflowMs (10_000) is smaller than worktreeSettleMaxMs (90_000) -> the cap must be the smaller one.
    h.attach(c.spawner, okGate, h.clock.now() + 10_000);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    expect(c.awaitCalls[0]?.capMs).toBe(10_000);
  });

  it("an isolated call keeps its maxParallel slot for the whole settle-wait (D8) — a later call queues behind it", async () => {
    const h = harness({ maxParallel: 1 });
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p1", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1"); // outcome landed, but the settle-wait for "1" is still in flight (awaitWorktree unresolved)
    await flush();
    h.postHostCall("2", "agent", { prompt: "p2", opts: null });
    await flush();
    expect(c.spawns).toHaveLength(1); // "2" is still queued — slot #1 is not released yet
    c.resolveAwait("r1", "settle", { state: "clean" });
    await flush();
    expect(c.spawns).toHaveLength(2); // released once "1" fully settles
  });
});

describe("host.ts: D5 late disposition folds into worktreeFinal (read-time, never mutates the frozen worktree field)", () => {
  it("a late mark that arrives is only visible on a `children` read taken AFTER it resolves", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "pending" } as never); // simulate a settle-horizon give-up mapped by the adapter
    await flush();
    const before = handler.children.find((ch) => ch.callId === "1");
    expect(before?.worktree).toEqual({ state: "pending" });
    expect(before?.worktreeFinal).toBeUndefined();

    c.resolveAwait("r1", "late", { state: "committed", branch: "pi-agent-r1" });
    await flush();
    const after = handler.children.find((ch) => ch.callId === "1");
    expect(after?.worktree).toEqual({ state: "pending" }); // frozen — never mutated
    expect(after?.worktreeFinal).toEqual({ state: "committed", branch: "pi-agent-r1" });
  });

  it("a late mark that resolves to pending/none is discarded, never surfacing as worktreeFinal", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "pending" } as never);
    await flush();
    c.resolveAwait("r1", "late", { state: "pending" });
    await flush();
    expect(handler.children.find((ch) => ch.callId === "1")?.worktreeFinal).toBeUndefined();
  });
});

describe("host.ts: D7 stopOwned/onTerminating force-settles an isolated bound call as pending and still starts a late listener", () => {
  it("stopOwned during the settle-wait force-settles as aborted+pending, and the late listener resolving folds into worktreeFinal", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    // waitAll() never resolves — the child is still "running" from the host's point of view.
    const stopP = handler.stopOwned("user_stop", 10);
    h.clock.advance(20);
    await flush();
    await stopP;
    const settle = settleFor(h.sent, "1");
    expect(settle?.ok).toBe(false);
    const summary = handler.children.find((ch) => ch.callId === "1");
    expect(summary?.status).toBe("aborted");
    expect(summary?.worktree).toEqual({ state: "pending" });

    expect(c.hasAwait("r1", "late")).toBe(true);
    c.resolveAwait("r1", "late", { state: "kept", path: "/tmp/wt/r1" });
    await flush();
    expect(handler.children.find((ch) => ch.callId === "1")?.worktreeFinal).toEqual({
      state: "kept",
      path: "/tmp/wt/r1",
    });
  });

  it("onTerminating (HR8) force-settles a still-running isolated call the same way", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    await h.workerHost.terminate("shutdown");
    await flush();
    const settle = settleFor(h.sent, "1");
    expect(settle?.ok).toBe(false);
  });

  it("a real outcome arriving after a force-settle does not double-record or re-send", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const handler = h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "p", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    const stopP = handler.stopOwned("user_stop", 10);
    h.clock.advance(20);
    await flush();
    await stopP;
    expect(handler.children.filter((ch) => ch.callId === "1")).toHaveLength(1);
    c.finishChild("r1", "completed", "late text"); // the real child settles for real, after the force-settle
    await flush();
    expect(handler.children.filter((ch) => ch.callId === "1")).toHaveLength(1); // still exactly one record
    expect(
      h.sent.filter(
        (m) => (m as { callId?: string }).callId === "1" && (m as { kind?: string }).kind === "host_settle",
      ),
    ).toHaveLength(1);
  });
});
