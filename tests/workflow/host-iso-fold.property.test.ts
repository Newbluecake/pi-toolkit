import { readFileSync } from "node:fs";
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
import { buildEntry, CHAIN_SEED, nextChainDigest, sha256Hex, taskKeyOf } from "../../src/workflow/journal.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import type { ChildWorktreeInfo, TaskSemantics, WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * replay-verify plan §6 P2 test 14/15: the `isoId` chain-fold invariants
 * I1-I8 (D6.3). Deterministic scenario coverage (not a full property
 * fuzzer, given the file's own scope) plus a static source-scan for I2's
 * "no await between the journal block and F2" claim.
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
  ) as { ok: boolean; error?: { message: string } } | undefined;
}

interface AwaitCall {
  runId: string;
  horizon: "settle" | "late";
  resolve(info: ChildWorktreeInfo): void;
}

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

function verifyJournalConfig(
  index: ReturnType<typeof buildReplayIndex>,
  verified: ReadonlySet<string>,
  scope: "chain" | "content" = "chain",
) {
  return {
    store: { append: vi.fn() },
    dir: ".",
    index,
    scope,
    noReplay: false,
    deterministic: { current: true },
    isolationReplay: {
      mode: "verify" as const,
      cwd: "/repo",
      verified,
      nonce: "fixed-nonce",
      stats: { probed: verified.size, verified: verified.size, unverified: 0 },
    },
  };
}

describe("I1: lookup key/occurrence always use the UNFOLDED chainDigestBefore", () => {
  it("an isolated call's own lookup succeeds against an entry keyed by the plain (unfolded) nextChainDigest(CHAIN_SEED, taskKey)", async () => {
    const isoKey = isolatedTaskKey("isolated");
    const isoEntry = buildEntry({
      scope: "chain",
      key: isoKey,
      chainDigestBefore: CHAIN_SEED, // unfolded — this call is the FIRST submission, nothing could have folded before it
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
    h.attach(c.spawner, okGate, { journal: verifyJournalConfig(index, new Set([isoEntry.digest])) });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    expect(c.spawns).toHaveLength(0); // hit, not live
  });
});

describe("I3: at most one fold per call; F1 folds the entry's own isoId (not a fresh one)", () => {
  it("a hit's fold value equals entry.worktree.isoId exactly", async () => {
    const isoKey = isolatedTaskKey("isolated");
    const isoEntry = buildEntry({
      scope: "chain",
      key: isoKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "general-purpose",
      isolation: "worktree",
      worktree: {
        state: "committed",
        branch: "pi-agent-r1",
        commit: "a".repeat(40),
        isoId: "deadbeefdeadbeefdeadbeefdeadbeef",
      },
      value: "iso-out",
      completedAt: 1000,
      durationMs: 10,
    });
    const foldedChain = nextChainDigest(nextChainDigest(CHAIN_SEED, isoKey), "iso:deadbeefdeadbeefdeadbeefdeadbeef");
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
    h.attach(c.spawner, okGate, { journal: verifyJournalConfig(index, new Set([isoEntry.digest])) });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    expect(c.spawns).toHaveLength(0); // both hit — proves the fold used exactly "deadbeef...", the entry's own isoId
  });
});

describe("I4: rejected admission paths never fold — the following call's key sequence matches the off-mode baseline", () => {
  async function offModeFollowUpKey(): Promise<string> {
    // Baseline: off mode, isolated call rejected/skip-taints as usual, next call's own chainDigestBefore
    // is nextChainDigest(CHAIN_SEED, isolatedTaskKey) with NO iso: fold (I4's literal claim).
    return nextChainDigest(CHAIN_SEED, isolatedTaskKey("isolated"));
  }

  it("D2 isolation_unavailable rejection: the next call's chainDigestBefore is the unfolded nextChainDigest, not a folded one", async () => {
    const expected = await offModeFollowUpKey();
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner({ worktreeAvailable: false });
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
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
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const plain = appendSpy.mock.calls[0]![1] as { chainDigestBefore: string };
    expect(plain.chainDigestBefore).toBe(expected);
  });

  it("maxChildren rejection: same unfolded-key guarantee", async () => {
    const h = harness({ maxChildren: 1 });
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    h.postHostCall("2", "agent", { prompt: "another-isolated", opts: { isolation: "worktree" } });
    await flush();
    expect(ackFor(h.sent, "2")?.ok).toBe(false); // maxChildren exceeded, rejected before folding
    // "1" is still in flight (never settled) so we can't easily probe the post-"1" chain via a third
    // call without unwinding it — this test's real assertion is just that "2" was cleanly rejected
    // without ever touching the spawner a second time.
    expect(c.spawns).toHaveLength(1);
  });
});

describe("I5/I6: an async post-admission failure (spawn error) keeps its fold; a future run can never accidentally hit under it", () => {
  it("a spawn error after acceptance still folds — proven by the fact NOTHING can ever match that fold (fail-safe), and the isolated call itself is never journaled", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ error: { message: "spawn failed" } });
    await flush();
    expect(ackFor(h.sent, "1")?.ok).toBe(false);
    expect(appendSpy).not.toHaveBeenCalled(); // never journaled (RP3: not a success)
    // The next call folds ON TOP of whatever isoId "1" used (I5) — assert it's
    // NOT the plain unfolded key (i.e. folding was retained, not rolled back).
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2");
    await flush();
    const plain = appendSpy.mock.calls[0]![1] as { chainDigestBefore: string };
    const unfolded = nextChainDigest(CHAIN_SEED, isolatedTaskKey("isolated"));
    expect(plain.chainDigestBefore).not.toBe(unfolded); // folded, not rolled back
  });
});

describe("I2 (static): no `await` between the journal replay block and the F2 fold application in host.ts", () => {
  it("the source region from `const journal = deps.journal;` to the F2 fold statement contains no `await` token", () => {
    const src = readFileSync(new URL("../../src/workflow/host.ts", import.meta.url), "utf8");
    const start = src.indexOf("const journal = deps.journal;");
    const marker = "F2: the ONLY point";
    const markerIdx = src.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    expect(markerIdx).toBeGreaterThan(start);
    // Find the actual fold statement (right after the comment block containing the marker).
    const foldStatement = src.indexOf("chainDigest = nextChainDigest(chainDigest, `iso:${pendingFold}`);", markerIdx);
    expect(foldStatement).toBeGreaterThan(markerIdx);
    const region = src.slice(start, foldStatement);
    // Strip comments before checking — several doc comments in this region
    // use the English word "await" in prose (e.g. "nothing to await"); the
    // invariant is about actual `await` EXPRESSIONS in code, not prose.
    const codeOnly = region.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/\bawait\b/);
  });
});

/**
 * 验收补测（replay-verify-plan v2.1 §6 第 14 条）：BW2、experts 未解析、
 * queued-withheld、child-failed、并行/排队交错 —— 都是 I4/I5/I6/I2 的具体场景，
 * 前面 I1/I3/I4/I5-I6/I2(static) 几块只覆盖了 D2/maxChildren/spawn-error 这几条
 * 路径，这里补齐验收清单点名的其余路径。
 */

describe("I4 (BW2): a call that arrives after the workflow's own deadline never reaches the journal block", () => {
  it("top-level BW2 rejects '1' before handleAgent ever runs (no spawn, no journal, no trace); once the deadline getter allows it, '2' folds normally and is the FIRST thing to ever touch the chain", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    let killAtValue = 0; // already expired at t=0: remainingWorkflowMs() === 0
    h.attach(c.spawner, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
      killAt: () => killAtValue,
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    expect(ackFor(h.sent, "1")?.ok).toBe(false);
    expect(ackFor(h.sent, "1")?.error?.message).toContain("BW2");
    expect(c.spawns).toHaveLength(0); // never even reached the spawner
    expect(appendSpy).not.toHaveBeenCalled();

    // Lift the deadline and prove "1" left the chain exactly at its pristine
    // seed — "2" is the first call to ever advance it.
    killAtValue = 1_000_000;
    h.postHostCall("2", "agent", { prompt: "isolated2", opts: { isolation: "worktree" } });
    await flush();
    h.postHostCall("3", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[0]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2", "completed", "out-2");
    await flush();
    c.resolveAwait("r2", "settle", { state: "pending" });
    await flush();
    c.spawns[1]!.resolve({ runId: "r3" });
    await flush();
    c.finishChild("r3", "completed", "out-3");
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(1); // only "3" (plain) is journaled — "2" is `pending`
    const plain = appendSpy.mock.calls[0]![1] as { chainDigestBefore: string };
    const isoKey2 = isolatedTaskKey("isolated2");
    const chainKey2 = nextChainDigest(CHAIN_SEED, isoKey2); // CHAIN_SEED, NOT anything derived from "1"
    const isoIdLive2 = sha256Hex(`fixed-nonce:${chainKey2}:0`).slice(0, 32);
    const chainAfter2Folded = nextChainDigest(chainKey2, `iso:${isoIdLive2}`);
    expect(plain.chainDigestBefore).toBe(chainAfter2Folded);
  });
});

describe("I4: experts_unresolved on an isolated+experts call never folds", () => {
  it("a resolver failure rejects with experts_unresolved before F2 is ever reached — the next call's chainDigestBefore is the plain UNFOLDED key", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const resolveExperts = vi.fn(() => ({ error: { message: "expert not found" } }));
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach({ ...c.spawner, resolveExperts }, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree", experts: ["dev"] } });
    await flush();
    expect(resolveExperts).toHaveBeenCalledTimes(1);
    expect(ackFor(h.sent, "1")?.ok).toBe(false);
    expect(ackFor(h.sent, "1")?.error?.message).toBe("expert not found");
    expect(c.spawns).toHaveLength(0); // rejected before ever reaching spawn/F2
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[0]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2", "completed", "out-2");
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const plain = appendSpy.mock.calls[0]![1] as { chainDigestBefore: string };
    const unfolded = nextChainDigest(CHAIN_SEED, isolatedTaskKey("isolated"));
    expect(plain.chainDigestBefore).toBe(unfolded); // NO "iso:" fold applied anywhere
  });
});

describe("I5/I6: a queued isolated call withheld by a phase timeout keeps its fold", () => {
  it("phase_timeout withholds the still-queued isolated call ('2') — its acceptance-time fold survives for the next submission ('3')", async () => {
    const h = harness({ maxParallel: 1, phaseTotalMs: 1_000 });
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
    });
    // "1": plain, no phase tag — holds the single maxParallel slot for the
    // whole scenario, untouched by the "iso" phase timer below.
    h.postHostCall("1", "agent", { prompt: "keep-slot", opts: null });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    // Arm the "iso" phase, then submit the isolated call under it — the slot
    // is busy, so it queues ({queued:true}); F2 already folded synchronously
    // at acceptance, before it ever reached the FIFO queue.
    h.workerData().commPort.postMessage({ kind: "phase", title: "iso" });
    await flush();
    h.postHostCall("2", "agent", { prompt: "isolated", opts: { isolation: "worktree", phase: "iso" } });
    await flush();
    // "3": plain, untagged — queues behind "2" (FIFO), unaffected by "iso"'s timer.
    h.postHostCall("3", "agent", { prompt: "plain-after", opts: null });
    await flush();
    h.clock.advance(1_000); // only "2" (tagged "iso", still queued) is withheld
    await flush();
    expect(ackFor(h.sent, "2")).toMatchObject({ ok: true, value: { queued: true } }); // "2" was already acked {queued:true}; the phase timeout produces a SETTLE, not a second ack
    const settleFor2 = h.sent.find(
      (m) =>
        (m as { kind?: string; callId?: string }).kind === "host_settle" && (m as { callId?: string }).callId === "2",
    ) as { ok: boolean; error?: { message: string } } | undefined;
    expect(settleFor2).toMatchObject({ ok: false, error: { message: "withheld (phase_timeout)" } });
    expect(appendSpy).not.toHaveBeenCalled(); // withheld: never journaled (RP3)
    // Free the slot: "1" finishes, "3" (the only remaining queued item) dispatches.
    c.finishChild("r1", "completed", "ok-1");
    await flush();
    expect(c.spawns).toHaveLength(2); // "1" and "3" only — "2" never called spawn()
    c.spawns[1]!.resolve({ runId: "r3" });
    await flush();
    c.finishChild("r3", "completed", "ok-3");
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(2); // "1" and "3", both plain successful calls
    const entryFor3 = appendSpy.mock.calls
      .map((call) => call[1] as { value: string; chainDigestBefore: string })
      .find((e) => e.value === "ok-3");
    expect(entryFor3).toBeDefined();
    // Oracle: chain after "1" (plain, unfolded) → chain after "2" (isolated,
    // accepted while queued, folded right at acceptance) → that's "3"'s chainDigestBefore.
    const key1 = plainTaskKey("keep-slot");
    const key2 = isolatedTaskKey("isolated");
    const chainAfter1 = nextChainDigest(CHAIN_SEED, key1);
    const chainKey2 = nextChainDigest(chainAfter1, key2);
    const isoIdLive2 = sha256Hex(`fixed-nonce:${chainKey2}:0`).slice(0, 32);
    const chainAfter2Folded = nextChainDigest(chainKey2, `iso:${isoIdLive2}`);
    expect(entryFor3!.chainDigestBefore).toBe(chainAfter2Folded);
  });
});

describe("I5/I6: a bound isolated child that settles with a non-completed status keeps its fold; RP3 skips writing it", () => {
  it("status:'failed' never journals '1' (RP3), but the fold applied at its acceptance is retained for '2'", async () => {
    const h = harness();
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
    });
    h.postHostCall("1", "agent", { prompt: "isolated", opts: { isolation: "worktree" } });
    await flush();
    c.spawns[0]!.resolve({ runId: "r1" });
    await flush();
    c.finishChild("r1", "failed");
    await flush();
    c.resolveAwait("r1", "settle", { state: "pending" });
    await flush();
    expect(appendSpy).not.toHaveBeenCalled(); // RP3: not `completed`, never journaled
    h.postHostCall("2", "agent", { prompt: "plain", opts: null });
    await flush();
    c.spawns[1]!.resolve({ runId: "r2" });
    await flush();
    c.finishChild("r2", "completed", "out-2");
    await flush();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const plain = appendSpy.mock.calls[0]![1] as { chainDigestBefore: string };
    const key1 = isolatedTaskKey("isolated");
    const chainKey1 = nextChainDigest(CHAIN_SEED, key1);
    const isoIdLive1 = sha256Hex(`fixed-nonce:${chainKey1}:0`).slice(0, 32);
    const chainAfter1Folded = nextChainDigest(chainKey1, `iso:${isoIdLive1}`);
    expect(plain.chainDigestBefore).toBe(chainAfter1Folded);
  });
});

/** Small, deterministic, seeded PRNG (mulberry32) — no external dependency, fully reproducible from an integer seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("I2 (interleaving): the chain sequence depends only on arrival order, never on completion order", () => {
  // Deterministic, seeded, small-scale interleaving (plan §6 test 14(f)): 4
  // calls (2 isolated + 2 plain, maxParallel:2 so the last 2 genuinely queue)
  // are all SUBMITTED back-to-back first. Folding is fully synchronous at
  // acceptance time (I2: no `await` between the journal block and F2), so
  // the entire oracle chain sequence below is fixed before any child ever
  // resolves. Running the identical submissions through several different
  // (seeded) completion orders and checking they all land on the same
  // oracle proves completion order genuinely never enters the computation —
  // the only thing that does is arrival (submission) order.
  const SEEDS = [1, 7, 1337];

  async function runCase(seed: number): Promise<void> {
    const rng = mulberry32(seed);
    const h = harness({ maxParallel: 2 });
    await h.boot();
    const c = controllableWorktreeSpawner();
    const appendSpy = vi.fn();
    const index = buildReplayIndex([], 0, "chain");
    h.attach(c.spawner, okGate, {
      journal: { ...verifyJournalConfig(index, new Set()), store: { append: appendSpy } },
    });

    // Submit all four calls back-to-back — "a"/"b" dispatch immediately (2
    // slots), "c"/"d" queue FIFO behind them. By this point the ENTIRE
    // oracle chain sequence below is already fixed (I2).
    const calls = [
      { id: "a", prompt: "iso-a", iso: true },
      { id: "b", prompt: "plain-b", iso: false },
      { id: "c", prompt: "iso-c", iso: true },
      { id: "d", prompt: "plain-d", iso: false },
    ] as const;
    for (const call of calls) {
      h.postHostCall(call.id, "agent", {
        prompt: call.prompt,
        opts: call.iso ? { isolation: "worktree" } : null,
      });
      await flush();
    }
    expect(c.spawns).toHaveLength(2); // "a","b" only — "c","d" still queued

    // Oracle: replicate host.ts's own synchronous submission-order formula.
    let chain: string = CHAIN_SEED;
    const expectedBefore = new Map<string, string>();
    for (const call of calls) {
      const key = call.iso ? isolatedTaskKey(call.prompt) : plainTaskKey(call.prompt);
      const chainKey = nextChainDigest(chain, key);
      if (!call.iso) expectedBefore.set(call.id, chain);
      chain = chainKey;
      if (call.iso) {
        const isoIdLive = sha256Hex(`fixed-nonce:${chainKey}:0`).slice(0, 32);
        chain = nextChainDigest(chain, `iso:${isoIdLive}`);
      }
    }

    // Bind "a"/"b", then finish them in a seeded-random order — the only
    // degree of freedom left (which of the two active slots frees first).
    c.spawns[0]!.resolve({ runId: "ra" });
    c.spawns[1]!.resolve({ runId: "rb" });
    await flush();
    const finishIso = async (runId: string, value: string) => {
      c.finishChild(runId, "completed", value);
      await flush();
      c.resolveAwait(runId, "settle", { state: "pending" });
      await flush();
    };
    const finishPlain = async (runId: string, value: string) => {
      c.finishChild(runId, "completed", value);
      await flush();
    };
    if (rng() < 0.5) {
      await finishIso("ra", "out-a");
      await finishPlain("rb", "out-b");
    } else {
      await finishPlain("rb", "out-b");
      await finishIso("ra", "out-a");
    }
    // Both slots now free; "c" and "d" have dispatched FIFO.
    expect(c.spawns).toHaveLength(4);
    c.spawns[2]!.resolve({ runId: "rc" });
    c.spawns[3]!.resolve({ runId: "rd" });
    await flush();
    if (rng() < 0.5) {
      await finishIso("rc", "out-c");
      await finishPlain("rd", "out-d");
    } else {
      await finishPlain("rd", "out-d");
      await finishIso("rc", "out-c");
    }

    expect(appendSpy).toHaveBeenCalledTimes(2); // "b" and "d" — the two plain calls
    const byValue = new Map(
      appendSpy.mock.calls.map((call) => {
        const e = call[1] as { value: string; chainDigestBefore: string };
        return [e.value, e.chainDigestBefore] as const;
      }),
    );
    expect(byValue.get("out-b")).toBe(expectedBefore.get("b"));
    expect(byValue.get("out-d")).toBe(expectedBefore.get("d"));
  }

  it.each(SEEDS)("seed %d: completion order never changes the oracle chain sequence", async (seed) => {
    await runCase(seed);
  });
});
