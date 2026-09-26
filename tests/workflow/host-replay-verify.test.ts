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
import { buildEntry, CHAIN_SEED, nextChainDigest, taskKeyOf } from "../../src/workflow/journal.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import type { ChildWorktreeInfo, JournalEntry, TaskSemantics, WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * replay-verify plan §6 P2 test 11-13: `agent(prompt, {isolation:"worktree"})`
 * end-to-end through host.ts's `verify`-mode logic — D3 write conditions,
 * hit/miss/skip, chain/content/off scopes, cwd forwarding to the spawn
 * request, and the D4.4 terminal recheck. Mirrors host-worktree.test.ts's
 * harness shape so the two files diff cleanly.
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
    attach(spawner: ChildSpawner, gateRunner: GateRunner, extra: Record<string, unknown> = {}) {
      return attachHostCallHandler({
        clock,
        workerHost,
        spawner,
        gateRunner,
        budget: { ...BASE_BUDGET, ...budgetOverrides },
        ...extra,
      });
    },
  };
}

async function flush(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const okGate: GateRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

function ackFor(sent: unknown[], id: string) {
  return sent.find(
    (m) => (m as { kind?: string; id?: string }).kind === "host_ack" && (m as { id?: string }).id === id,
  ) as { ok: boolean; error?: { message: string }; value?: unknown } | undefined;
}
function settleFor(sent: unknown[], callId: string) {
  return sent.find(
    (m) =>
      (m as { kind?: string; callId?: string }).kind === "host_settle" && (m as { callId?: string }).callId === callId,
  ) as { ok: boolean; value?: unknown; worktree?: ChildWorktreeInfo } | undefined;
}

interface AwaitCall {
  runId: string;
  horizon: "settle" | "late";
  resolve(info: ChildWorktreeInfo): void;
}

/** Same shape as host-worktree.test.ts's controllableWorktreeSpawner, plus `configHashOf`/`probeAgentBranches`. */
function controllableWorktreeSpawner(opts: { worktreeAvailable?: boolean } = {}) {
  const spawns: Array<{
    req: Parameters<ChildSpawner["spawn"]>[0];
    resolve(r: ChildSpawnResult | { error: { message: string } }): void;
  }> = [];
  const waiters = new Map<string, (o: ChildOutcome) => void>();
  const awaitCalls: AwaitCall[] = [];
  const spawner: ChildSpawner = {
    spawn: (req) => new Promise((resolve) => spawns.push({ req, resolve })),
    abort: async () => true,
    waitAll: ({ runIds }) =>
      new Promise((resolve) => {
        const runId = runIds[0]!;
        waiters.set(runId, (o) => resolve({ settled: [o], pending: [] }));
      }),
    worktreeAvailable: () => opts.worktreeAvailable ?? true,
    configHashOf: () => "hash-v1",
    awaitWorktree: (runId, waitOpts) =>
      new Promise((resolve) => {
        awaitCalls.push({ runId, horizon: waitOpts.horizon, resolve });
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
  };
}

/** Computes the isolated/plain taskKey the way host.ts does, for asserting on written entries directly against the store. */
function isolatedTaskKey(prompt: string): string {
  const sem: TaskSemantics = {
    agentType: "general-purpose",
    agentTypeConfigHash: "hash-v1",
    prompt,
    isolation: "worktree",
  };
  return taskKeyOf(sem);
}
function plainTaskKey(prompt: string): string {
  const sem: TaskSemantics = { agentType: "general-purpose", agentTypeConfigHash: "hash-v1", prompt };
  return taskKeyOf(sem);
}

describe("host.ts verify mode (chain scope): D3 write + D6 fold end-to-end (§6 test 11)", () => {
  it("run 1 (miss): isolated committed call + downstream plain call both write, isolated entry carries an isoId", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n1",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40) });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2");
    await flush();

    expect(appendSpy).toHaveBeenCalledTimes(2);
    const isoEntry = appendSpy.mock.calls[0]![1] as JournalEntry;
    expect(isoEntry.key).toBe(isolatedTaskKey("isolated"));
    expect(isoEntry.worktree).toMatchObject({ state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40) });
    expect(isoEntry.worktree?.isoId).toMatch(/^[0-9a-f]{32}$/);
    const plainEntry = appendSpy.mock.calls[1]![1] as JournalEntry;
    expect(plainEntry.key).toBe(plainTaskKey("plain"));
    const unfolded = nextChainDigest(CHAIN_SEED, isolatedTaskKey("isolated"));
    expect(plainEntry.chainDigestBefore).not.toBe(unfolded);
    expect(plainEntry.chainDigestBefore).toBe(nextChainDigest(unfolded, `iso:${isoEntry.worktree!.isoId}`));
  });

  it("run 2, verification passes: isolated call AND downstream both hit, spawner.spawn is never called", async () => {
    const isoKey = isolatedTaskKey("isolated");
    const isoChainBefore = CHAIN_SEED;
    const isoEntry = buildEntry({
      scope: "chain",
      key: isoKey,
      chainDigestBefore: isoChainBefore,
      occurrence: 0,
      agentType: "general-purpose",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "iso-out",
      completedAt: 1000,
      durationMs: 10,
    });
    const foldedChain = nextChainDigest(nextChainDigest(isoChainBefore, isoKey), `iso:${isoEntry.worktree!.isoId}`);
    const plainKey = plainTaskKey("plain");
    const plainEntry = buildEntry({
      scope: "chain",
      key: plainKey,
      chainDigestBefore: foldedChain,
      occurrence: 0,
      agentType: "general-purpose",
      value: "plain-out",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([isoEntry, plainEntry], 0, "chain");

    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const handler = h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set([isoEntry.digest]),
          nonce: "n2",
          stats: { probed: 1, verified: 1, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();

    expect(c.spawns).toHaveLength(0);
    expect(appendSpy).not.toHaveBeenCalled();

    const settle1 = settleFor(h.sent, "1")!;
    expect(settle1.ok).toBe(true);
    expect(settle1.value).toBe("iso-out");
    expect(settle1.worktree).toEqual({ state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40) });
    const settle2 = settleFor(h.sent, "2")!;
    expect(settle2.ok).toBe(true);
    expect(settle2.value).toBe("plain-out");

    expect(handler.replayStats).toMatchObject({ hits: 2, misses: 0 });
    expect(handler.replayStats?.tainted).toBeUndefined();
  });

  it("verification fails: isolated call goes live, downstream misses and both write to a NEW chain", async () => {
    const isoKey = isolatedTaskKey("isolated");
    const isoEntry = buildEntry({
      scope: "chain",
      key: isoKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "general-purpose",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "iso-out",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([isoEntry], 0, "chain");

    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const handler = h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n3",
          stats: { probed: 1, verified: 0, unverified: 1 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    expect(c.spawns).toHaveLength(1);
    c.spawns[0]!.resolve({ runId: "r5" });
    await flush();
    c.finishChild("r5", "completed", "iso-out-2");
    await flush();
    c.resolveAwait("r5", "settle", { state: "committed", branch: "pi-agent-r5", commit: "c".repeat(40) });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[1]!.resolve({ runId: "r6" });
    await flush();
    c.finishChild("r6", "completed", "plain-out-2");
    await flush();

    expect(appendSpy).toHaveBeenCalledTimes(2);
    const newIso = appendSpy.mock.calls[0]![1] as JournalEntry;
    expect(newIso.worktree?.isoId).not.toBe(isoEntry.worktree!.isoId);
    expect(handler.replayStats).toMatchObject({ hits: 0, misses: 1, skipped: 1 });
  });
});

describe("host.ts verify mode: D3 write conditions (kept/pending/committed-without-sha never write; clean does)", () => {
  it("kept: no journal entry for the isolated call; downstream still journals under the fold", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n4",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "kept", path: "/tmp/wt/r1" });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2");
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect((appendSpy.mock.calls[0]![1] as JournalEntry).key).toBe(plainTaskKey("plain"));
  });

  it("committed without a sha never writes either", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n5",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "committed", branch: "pi-agent-r1" });
    await flush();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("clean writes an entry with isoId and no branch/commit", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n6",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
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
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect((appendSpy.mock.calls[0]![1] as JournalEntry).worktree).toEqual({
      state: "clean",
      isoId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("pending (settle-wait gave up) never writes", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n7",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "pending" });
    await flush();
    expect(appendSpy).not.toHaveBeenCalled();
  });
});

describe("host.ts verify mode: cwd forwarding to the spawn request (D4.1)", () => {
  it("an isolated call's spawn request carries the pinned isolationReplay.cwd; a plain call's does not", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: {
        store: { append: vi.fn() },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/pinned/repo",
          verified: new Set(),
          nonce: "n8",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    expect(c.spawns[0]!.req).toMatchObject({ isolation: "worktree", cwd: "/pinned/repo" });
    expect(c.spawns[1]!.req).not.toHaveProperty("cwd");
  });

  it("off mode: no cwd on the spawn request even for an isolated call (byte-identical D9 guarantee)", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    h.attach(c.spawner, okGate);
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    expect(c.spawns[0]!.req).not.toHaveProperty("cwd");
  });
});

describe("host.ts verify mode: content scope keeps the old taint rule (D6.4)", () => {
  it("a live (miss) isolated call still writes, and still taints subsequent calls under content scope", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "content");
    const handler = h.attach(c.spawner, okGate, {
      journal: {
        store: { append: appendSpy },
        dir: ".",
        index,
        scope: "content",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n9",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1");
    await flush();
    c.resolveAwait("r1", "settle", { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40) });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    // chain_tainted still DISPATCHES live (only replay/journaling is skipped —
    // same established behavior as a pre-P2 tainted call, host-worktree.test.ts).
    expect(c.spawns).toHaveLength(2);
    c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2");
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(1); // call "2" never journaled (tainted)
    expect(handler.replayStats).toMatchObject({ tainted: true });
  });

  it("a verified hit under content scope does NOT taint", async () => {
    const isoKey = isolatedTaskKey("isolated");
    const isoEntry = buildEntry({
      scope: "content",
      key: isoKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "general-purpose",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "iso-out",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([isoEntry], 0, "content");
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const handler = h.attach(c.spawner, okGate, {
      journal: {
        store: { append: vi.fn() },
        dir: ".",
        index,
        scope: "content",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set([isoEntry.digest]),
          nonce: "n10",
          stats: { probed: 1, verified: 1, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    expect(c.spawns).toHaveLength(1);
    expect(handler.replayStats?.tainted).toBeUndefined();
  });
});

describe("host.ts verify mode: an otherwise-valid isolated hit blocked by worktreeAvailable()===false (D7)", () => {
  it("falls through to the D2 gate and is rejected isolation_unavailable, never folds, counted as skipped not hit", async () => {
    const isoKey = isolatedTaskKey("isolated");
    const isoEntry = buildEntry({
      scope: "chain",
      key: isoKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "general-purpose",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "iso-out",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([isoEntry], 0, "chain");
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner({ worktreeAvailable: false });
    const handler = h.attach(c.spawner, okGate, {
      journal: {
        store: { append: vi.fn() },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set([isoEntry.digest]),
          nonce: "n11",
          stats: { probed: 1, verified: 1, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    expect(c.spawns).toHaveLength(0);
    const ack = ackFor(h.sent, "1");
    expect(ack?.ok).toBe(false);
    expect(ack?.error?.message).toMatch(/isolation_unavailable|worktree\.enabled/);
    expect(handler.replayStats).toMatchObject({ hits: 0, skipped: 1 });
  });
});

describe("host.ts: HostCallHandler.recheckReplayedIsolation (D4.4 terminal diagnostic)", () => {
  function isoHitIndex() {
    const isoKey = isolatedTaskKey("isolated");
    const isoEntry = buildEntry({
      scope: "chain",
      key: isoKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "general-purpose",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "iso-out",
      completedAt: 1000,
      durationMs: 10,
    });
    return { isoEntry, index: buildReplayIndex([isoEntry], 0, "chain") };
  }

  it("annotates replayStale:'gone' when the probe finds the branch missing", async () => {
    const { isoEntry, index } = isoHitIndex();
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const probe = vi.fn(async () => ({ ok: true as const, tips: new Map<string, string>() }));
    const handler = h.attach({ ...c.spawner, probeAgentBranches: probe }, okGate, {
      journal: {
        store: { append: vi.fn() },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set([isoEntry.digest]),
          nonce: "n12",
          stats: { probed: 1, verified: 1, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    await handler.recheckReplayedIsolation(2_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(handler.children[0]).toMatchObject({ source: "replay", replayStale: "gone" });
    expect(handler.replayStats?.isolation?.stale).toBe(1);
  });

  it("annotates 'moved' when the tip is a different sha", async () => {
    const { isoEntry, index } = isoHitIndex();
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const probe = vi.fn(async () => ({
      ok: true as const,
      tips: new Map([["refs/heads/pi-agent-r1", "f".repeat(40)]]),
    }));
    const handler = h.attach({ ...c.spawner, probeAgentBranches: probe }, okGate, {
      journal: {
        store: { append: vi.fn() },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set([isoEntry.digest]),
          nonce: "n13",
          stats: { probed: 1, verified: 1, unverified: 0 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    await handler.recheckReplayedIsolation(2_000);
    expect(handler.children[0]).toMatchObject({ replayStale: "moved" });
  });

  it("no committed replay hits this run ⇒ zero probe calls, no-op", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const probe = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    const handler = h.attach({ ...c.spawner, probeAgentBranches: probe }, okGate, {
      journal: {
        store: { append: vi.fn() },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(),
          nonce: "n14",
          stats: { probed: 0, verified: 0, unverified: 0 },
        },
      },
    });
    await handler.recheckReplayedIsolation(2_000);
    expect(probe).not.toHaveBeenCalled();
  });

  it("no journal at all ⇒ no-op, never throws", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const handler = h.attach(c.spawner, okGate);
    await expect(handler.recheckReplayedIsolation(2_000)).resolves.toBeUndefined();
  });

  it("a throwing probeAgentBranches never fails the caller", async () => {
    const { index } = isoHitIndex();
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const probe = vi.fn(() => {
      throw new Error("boom");
    });
    const handler = h.attach({ ...c.spawner, probeAgentBranches: probe }, okGate, {
      journal: {
        store: { append: vi.fn() },
        dir: ".",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
        isolationReplay: {
          mode: "verify",
          cwd: "/repo",
          verified: new Set(["nonexistent-digest"]),
          nonce: "n15",
          stats: { probed: 1, verified: 0, unverified: 1 },
        },
      },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    await expect(handler.recheckReplayedIsolation(2_000)).resolves.toBeUndefined();
  });
});
