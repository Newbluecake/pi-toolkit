import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ConsultSettings } from "../../src/config/settings.js";
import type {
  ConsultExpertRef,
  ErrorInfo,
  RunDiagnostics,
  RunId,
  RunOutcome,
  RunSnapshot,
  SpawnRequest,
} from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import {
  CONSULT_MAX_CONTEXT_PERCENT,
  ConsultToolParams,
  createConsultTool,
  type ConsultForkStore,
  type ConsultSpawnPort,
} from "../../src/consult/tool.js";
import { CONSULT_READONLY_TOOLS } from "../../src/runtime/tool-scope.js";

/**
 * T-2/T-3/T-4/T-5 (consult plan §9): the consult tool's gate/nack surface,
 * success surface, failure surface and port contract. All dependencies are
 * injected fakes — the fork-store is stubbed per §10 (package C tests use a
 * stub until package B's real forkExpertSession lands).
 */

const FORK_PATH = "/cache/consult-sessions/fork-test.jsonl";
const SELF_RUN_ID: RunId = "r_ASKER01";
const SELF_CWD = "/home/asker/repo";

let expertDir: string;
let expertSessionFile: string;

beforeAll(() => {
  expertDir = mkdtempSync(join(tmpdir(), "consult-expert-"));
  expertSessionFile = join(expertDir, "expert.jsonl");
  writeFileSync(expertSessionFile, JSON.stringify({ type: "session", id: "s_expert" }) + "\n", "utf8");
});
afterAll(() => {
  rmSync(expertDir, { recursive: true, force: true });
});

const baseRef: ConsultExpertRef = {
  runId: "r_EXPERT1",
  label: "explorer",
  agentType: "explorer",
  model: { provider: "acme", id: "bigmodel" },
  contextPercent: 30,
  contextTokens: 150_000,
};

function ref(overrides: Partial<ConsultExpertRef> = {}): ConsultExpertRef {
  // sessionFile is resolved here (not in baseRef) because the tmp file only
  // exists after beforeAll — a module-level constant would capture undefined.
  return { ...baseRef, sessionFile: expertSessionFile, ...overrides };
}

// ── fakes ──────────────────────────────────────────────────────────────────

function fakeQuery(snapshots: readonly RunSnapshot[] = []): QueryService {
  return {
    get: (id) => snapshots.find((s) => s.runId === id),
    list: () => [...snapshots],
    wait: async () => ({ ok: false, reason: "wait_timeout" as const }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => ({ ok: false, reason: "not_running" as const }),
    setModel: async () => ({ ok: false, reason: "not_running" as const }),
    stop: async () => ({ ok: false, reason: "unknown_run" as const }),
    extendTimeout: () => ({ ok: false, reason: "unsupported" as const }),
  };
}

function liveSnapshot(opts: {
  runId: RunId;
  status?: RunSnapshot["status"];
  sessionFile?: string;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}): RunSnapshot {
  return {
    runId: opts.runId,
    generation: 1,
    status: opts.status ?? "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "model_turn",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(opts.sessionFile !== undefined ? { sessionFile: opts.sessionFile } : {}),
      ...(opts.contextUsage !== undefined ? { contextUsage: opts.contextUsage } : {}),
    },
    updatedAt: 0,
  };
}

class FakePort implements ConsultSpawnPort {
  readonly spawnCalls: SpawnRequest[] = [];
  spawnResult: { runId: RunId; label?: string } | { error: ErrorInfo } = { runId: "r_CONSULT1" };
  spawnShouldThrow: Error | undefined;
  readonly waitOutcomeCalls: RunId[] = [];
  outcome: RunOutcome = completedOutcome("short answer");
  readonly abortCalls: Array<{ runId: RunId; reason: string }> = [];
  readonly watchers = new Map<RunId, (s: RunSnapshot) => void>();
  async spawn(req: SpawnRequest) {
    this.spawnCalls.push(req);
    if (this.spawnShouldThrow) throw this.spawnShouldThrow;
    return this.spawnResult;
  }
  async waitOutcome(runId: RunId) {
    this.waitOutcomeCalls.push(runId);
    return this.outcome;
  }
  abortRun(runId: RunId, reason: string): void {
    this.abortCalls.push({ runId, reason });
  }
  watchRun(runId: RunId, cb: (s: RunSnapshot) => void): () => void {
    this.watchers.set(runId, cb);
    return () => {
      this.watchers.delete(runId);
    };
  }
}

function makeForkStore(opts: { fail?: boolean; cwd?: string } = {}) {
  const calls: Array<{ source: string; fallbackCwd: string }> = [];
  const removed: string[] = [];
  const store: ConsultForkStore = {
    forkExpertSession: (sourceFile, fallbackCwd) => {
      calls.push({ source: sourceFile, fallbackCwd });
      return opts.fail ? { ok: false, reason: "source file has no session header" } : { ok: true, path: FORK_PATH };
    },
    removeForkFile: (path) => {
      removed.push(path);
    },
    resolveForkCwd: (_source, fallbackCwd) => opts.cwd ?? fallbackCwd,
  };
  return { store, calls, removed };
}

function completedOutcome(text: string): RunOutcome {
  return outcome("completed", text);
}
function outcome(status: RunOutcome["status"], text?: string): RunOutcome {
  const diag: RunDiagnostics = {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 2,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    model: { provider: "acme", id: "bigmodel" },
    toolCounts: { read: 3, grep: 1 },
    ...(status !== "completed" ? {} : {}),
  };
  return {
    runId: "r_CONSULT1",
    status,
    ...(text !== undefined ? { text } : {}),
    ...(status === "failed" ? { error: { kind: "model", message: "boom", retryable: false } } : {}),
    ...(status === "timed_out" ? { timeoutReason: "total" } : {}),
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 1000, costUsd: 0.42 },
    turns: 2,
    durationMs: 12_345,
    diag,
  };
}

interface Harness {
  tool: ReturnType<typeof createConsultTool>;
  port: FakePort;
  fork: ReturnType<typeof makeForkStore>;
  priceOf: ReturnType<typeof vi.fn>;
  inflightCount: () => number;
  settings: ConsultSettings;
}

function harness(
  opts: {
    ref?: ConsultExpertRef;
    query?: QueryService;
    settings?: Partial<ConsultSettings>;
    fork?: ReturnType<typeof makeForkStore>;
    port?: FakePort;
  } = {},
): Harness {
  const port = opts.port ?? new FakePort();
  const fork = opts.fork ?? makeForkStore();
  const settings: ConsultSettings = { ...DEFAULT_SETTINGS.consult, ...opts.settings };
  const priceOf = vi.fn(() => ({ input: 3, cacheWrite: 5 }) as { input: number; cacheWrite: number } | undefined);
  const inFlight = { count: 0 };
  const tool = createConsultTool({
    selfRunId: SELF_RUN_ID,
    selfCwd: SELF_CWD,
    whitelist: [opts.ref ?? ref()],
    port,
    query: opts.query ?? fakeQuery(),
    forkStore: fork.store,
    priceOf,
    inflight: {
      tryAcquire: () => {
        inFlight.count += 1;
        return true;
      },
      release: () => {
        inFlight.count = Math.max(0, inFlight.count - 1);
      },
    },
    settings: () => settings,
  });
  return { tool, port, fork, priceOf, inflightCount: () => inFlight.count, settings };
}

const exec = (h: Harness, expert = "explorer", question = "What did you decide about X?", signal?: AbortSignal) =>
  h.tool.execute("call-1", { expert, question }, signal, undefined, undefined as never);

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  usage?: unknown;
};

// ── schema (review-1 #20) ──────────────────────────────────────────────────

describe("consult tool: schema carries only expert/question", () => {
  it("has exactly the two model-facing fields", () => {
    expect(Object.keys(ConsultToolParams.properties).sort()).toEqual(["expert", "question"]);
  });
});

// ── T-2: caller errors throw, everything else nacks ────────────────────────

describe("consult tool: caller mistakes throw (T-2)", () => {
  it("expert outside the whitelist throws with the allowed list", async () => {
    const h = harness();
    await expect(exec(h, "stranger")).rejects.toThrow(/not in this run's expert whitelist.*explorer.*r_EXPERT1/);
    expect(h.port.spawnCalls).toHaveLength(0);
    expect(h.fork.calls).toHaveLength(0);
  });

  it("empty question throws before anything else", async () => {
    const h = harness();
    await expect(exec(h, "explorer", "   ")).rejects.toThrow("question must not be empty");
    expect(h.fork.calls).toHaveLength(0);
  });

  it("whitelist matching accepts exact runId, exact label and unique runId prefix", async () => {
    for (const handle of ["explorer", "r_EXPERT1", "r_EXP"]) {
      const h = harness();
      const result = (await exec(h, handle)) as ToolResult;
      expect((result.details as { expertRunId?: string }).expertRunId).toBe("r_EXPERT1");
    }
  });
});

describe("consult tool: nack surface (T-2)", () => {
  it("disabled settings nack unavailable", async () => {
    const h = harness({ settings: { enabled: false } });
    const result = (await exec(h)) as ToolResult;
    expect(result.content[0]!.text).toContain("consult.enabled=false");
    expect(result.details.outcome).toBe("unavailable");
    expect(h.port.spawnCalls).toHaveLength(0);
  });

  it("busy when the concurrency gate refuses, and the gate is NOT consumed", async () => {
    // A gate that always refuses models wireConsult's per-asker/global caps.
    let allow = false;
    const port = new FakePort();
    const fork = makeForkStore();
    const tool = createConsultTool({
      selfRunId: SELF_RUN_ID,
      selfCwd: SELF_CWD,
      whitelist: [ref()],
      port,
      query: fakeQuery(),
      forkStore: fork.store,
      priceOf: () => undefined,
      inflight: { tryAcquire: () => allow, release: () => undefined },
      settings: () => DEFAULT_SETTINGS.consult,
    });
    const result = (await tool.execute(
      "c",
      { expert: "explorer", question: "q" },
      undefined,
      undefined,
      undefined as never,
    )) as ToolResult;
    expect(result.details.outcome).toBe("busy");
    expect(result.content[0]!.text).toContain("Too many concurrent consults");
    expect(port.spawnCalls).toHaveLength(0);
  });

  it("still_running when the expert runId is live non-terminal", async () => {
    const h = harness({
      query: fakeQuery([liveSnapshot({ runId: "r_EXPERT1", status: "running", sessionFile: expertSessionFile })]),
    });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("still_running");
    expect(result.content[0]!.text).toContain("still running");
    expect(h.fork.calls).toHaveLength(0);
  });

  it("still_running when a DIFFERENT running run holds the expert's sessionFile (resume double key)", async () => {
    const h = harness({
      query: fakeQuery([
        liveSnapshot({ runId: "r_RESUMED9", status: "running", sessionFile: expertSessionFile }),
        // the expert itself is terminal:
        liveSnapshot({ runId: "r_EXPERT1", status: "completed", sessionFile: expertSessionFile }),
      ]),
    });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("still_running");
  });

  it("unavailable when the expert's session file is gone", async () => {
    const h = harness({ ref: ref({ sessionFile: "/nonexistent/path.jsonl" }) });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("unavailable");
    expect(result.content[0]!.text).toContain("session file is missing");
  });

  it("context_too_large at >=75%, skipped on null/missing percent", async () => {
    const blocked = harness({ ref: ref({ contextPercent: 75 }) });
    expect(((await exec(blocked)) as ToolResult).details.outcome).toBe("context_too_large");
    expect(blocked.fork.calls).toHaveLength(0);

    const nullLive = harness({
      ref: ref({ contextPercent: 90 }),
      query: fakeQuery([
        liveSnapshot({
          runId: "r_EXPERT1",
          status: "completed",
          sessionFile: expertSessionFile,
          contextUsage: { tokens: 1000, contextWindow: 0, percent: null },
        }),
      ]),
    });
    const ok = (await exec(nullLive)) as ToolResult;
    expect(ok.details.outcome).toBe("completed"); // live says unknown ⇒ skip, don't fall back to the stale ref
    expect(nullLive.fork.calls).toHaveLength(1);

    const justUnder = harness({ ref: ref({ contextPercent: CONSULT_MAX_CONTEXT_PERCENT - 0.5 }) });
    expect(((await exec(justUnder)) as ToolResult).details.outcome).toBe("completed");
  });

  it("cost_too_high when the first-request estimate exceeds maxFirstRequestUsd — before any fork", async () => {
    // 500k tokens × $5/M (max(input=3, cacheWrite=5)) = $2.5 > $2
    const h = harness({ ref: ref({ contextTokens: 500_000 }) });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("cost_too_high");
    expect(result.content[0]!.text).toContain("first request alone");
    expect(h.fork.calls).toHaveLength(0);
    expect(h.port.spawnCalls).toHaveLength(0);
    expect(result.details.costEstimateUsd).toBeCloseTo(2.5, 6);
  });

  it("priceOf receives the expert model and live-ref token count; tiers selection is the caller's job", async () => {
    const h = harness({ ref: ref({ contextTokens: 123_456 }) });
    await exec(h);
    expect(h.priceOf).toHaveBeenCalledWith({ provider: "acme", id: "bigmodel" }, 123_456);
  });

  it("unknown price skips the pre-check (no estimate in details)", async () => {
    const h = harness({ ref: ref({ contextTokens: 500_000 }) });
    h.priceOf.mockReturnValue(undefined);
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(result.details.costEstimateUsd).toBeUndefined();
    expect(result.details.turnBudgetHint).toBeUndefined();
  });

  it("missing model skips the pre-check too", async () => {
    const h = harness({ ref: ref({ model: undefined }) });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(h.priceOf).not.toHaveBeenCalled();
  });

  it("fork failure ({ok:false}) nacks unavailable, never throws, never spawns (review-3 #2)", async () => {
    const h = harness({ fork: makeForkStore({ fail: true }) });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("unavailable");
    expect(result.content[0]!.text).toContain("could not fork the expert's session");
    expect(h.port.spawnCalls).toHaveLength(0);
    expect(h.fork.removed).toHaveLength(0);
  });

  it("nack and success paths both release the concurrency slot", async () => {
    const nackHarness = harness({
      query: fakeQuery([liveSnapshot({ runId: "r_EXPERT1", status: "running", sessionFile: expertSessionFile })]),
    });
    await exec(nackHarness);
    expect(nackHarness.inflightCount()).toBe(0);
    const okHarness = harness();
    await exec(okHarness);
    expect(okHarness.inflightCount()).toBe(0);
  });
});

// ── T-3: success surface ───────────────────────────────────────────────────

describe("consult tool: success surface (T-3)", () => {
  it("returns truncated text + usage + details; marker keeps head+tail and never points at the session file", async () => {
    const h = harness();
    h.port.outcome = completedOutcome("A".repeat(3000));
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(result.details.truncated).toBe(true);
    expect(result.content[0]!.text).toContain("chars omitted");
    expect(result.content[0]!.text).not.toContain("full session transcript");
    expect(result.content[0]!.text.startsWith("A".repeat(100))).toBe(true); // head 70%
    expect(result.content[0]!.text.endsWith("A".repeat(20))).toBe(true); // tail
    expect((result.usage as { cost: { total: number } }).cost.total).toBe(0.42);
    expect(result.details).toMatchObject({
      expertRunId: "r_EXPERT1",
      expertLabel: "explorer",
      consultRunId: "r_CONSULT1",
      model: "acme/bigmodel",
      costUsd: 0.42,
      durationMs: 12_345,
      turns: 2,
      toolCounts: { read: 3, grep: 1 },
    });
  });

  it("spawn request carries the readonly declaration, consult- label, hard budget, fork path and asker identity (T-5)", async () => {
    const fork = makeForkStore({ cwd: "/expert/worktree" });
    const h = harness({ fork });
    const controller = new AbortController();
    await exec(h, "explorer", "why?", controller.signal);
    const req = h.port.spawnCalls[0]!;
    expect(Object.keys(ConsultToolParams.properties).length).toBe(2); // schema still minimal
    expect(req.expectAck).toBe(true);
    expect(req.forkSessionFrom).toBe(FORK_PATH);
    expect(req.parentRunId).toBe(SELF_RUN_ID);
    expect(req.slotless).toBe(true);
    expect(req.budgetOverride).toEqual({ totalMs: DEFAULT_SETTINGS.consult.timeoutMs });
    expect(req.cwd).toBe("/expert/worktree"); // two-level resolution result
    expect(req.signal).toBe(controller.signal); // same signal, not detached
    expect(req.type).toBe("explorer");
    expect(req.modelOverride).toEqual({ provider: "acme", id: "bigmodel" });
    expect(req.label).toMatch(/^consult-[a-z0-9]{4}$/);
    expect(req.prompt).toContain(`ONLY have read-only tools: ${CONSULT_READONLY_TOOLS.join(", ")}`);
    expect(req.prompt).toContain("why?");
    expect(h.port.waitOutcomeCalls).toEqual(["r_CONSULT1"]);
  });

  it("fork is asked for the expert session with the asker cwd as fallback", async () => {
    const h = harness();
    await exec(h);
    expect(h.fork.calls).toEqual([{ source: expertSessionFile, fallbackCwd: SELF_CWD }]);
  });

  it("turnBudgetHint reflects the $2/$4 split (est 1.9 ⇒ hint 2, no budget note)", async () => {
    // 380k × $5/M = $1.9 — passes the $2 pre-check.
    const h = harness({ ref: ref({ contextTokens: 380_000 }) });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.costEstimateUsd).toBeCloseTo(1.9, 6);
    expect(result.details.turnBudgetHint).toBe(2);
    expect(h.port.spawnCalls[0]!.prompt).not.toContain("Budget note:");
  });

  it("remaining < est appends the Budget note line to the prompt", async () => {
    // est 1.9, maxCostUsd 2.5 ⇒ remaining 0.6 < 1.9.
    const h = harness({ ref: ref({ contextTokens: 380_000 }), settings: { maxCostUsd: 2.5 } });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.turnBudgetHint).toBe(1);
    expect(h.port.spawnCalls[0]!.prompt).toContain("Budget note: you have roughly one turn");
  });
});

// ── T-4: failure surface ───────────────────────────────────────────────────

describe("consult tool: failure surface (T-4)", () => {
  it("timeout without text nacks; aborted without text nacks; failed without text nacks", async () => {
    const cases: Array<[RunOutcome, string]> = [
      [outcome("timed_out"), "timeout"],
      [outcome("aborted"), "aborted"],
      [outcome("failed"), "failed"],
    ];
    for (const [oc, expectedTag] of cases) {
      const h = harness();
      h.port.outcome = oc;
      const result = (await exec(h)) as ToolResult;
      expect(result.details.outcome).toBe(expectedTag);
      expect(result.content[0]!.text).toContain("did not answer");
      expect(result.content[0]!.text).toContain("Fall back to your own investigation");
      expect(h.fork.removed).toHaveLength(0); // cleanup belongs to the runner now
    }
  });

  it("non-completed WITH text returns a partial answer", async () => {
    const h = harness();
    h.port.outcome = outcome("failed", "the answer is 42, though I got cut off");
    const result = (await exec(h)) as ToolResult;
    expect(result.details.partial).toBe(true);
    expect(result.details.outcome).toBe("failed");
    expect(result.content[0]!.text).toContain("the answer is 42");
    expect(result.content[0]!.text).toContain("⚠ partial answer — consult ended early");
    expect(h.fork.removed).toHaveLength(0);
  });

  it("spawn admission error nacks AND deletes the fork file immediately", async () => {
    const h = harness();
    h.port.spawnResult = {
      error: {
        kind: "config",
        message: "nested delegation depth 4 exceeds the configured maximum (3)",
        retryable: false,
      },
    };
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("unavailable");
    expect(result.details.configError).toContain("depth");
    expect(h.fork.removed).toEqual([FORK_PATH]);
  });

  it("spawn throw nacks AND deletes the fork file immediately", async () => {
    const h = harness();
    h.port.spawnShouldThrow = new Error("quota gate refused");
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("unavailable");
    expect(h.fork.removed).toEqual([FORK_PATH]);
  });

  it("never spawns without forkSessionFrom/expectAck (structural, every success path)", async () => {
    const h = harness();
    await exec(h);
    expect(h.port.spawnCalls[0]!.forkSessionFrom).toBeDefined();
    expect(h.port.spawnCalls[0]!.expectAck).toBe(true);
  });

  it("a turn-cap abort maps to details.outcome turn_cap (real reason, §15 #1)", async () => {
    const h = harness();
    const deferred = createDeferredSnapshots(h);
    const pending = exec(h);
    await flushMicrotasks(); // let spawn resolve + watcher register
    // turn1 start/end, turn2, turn3 end, turn4 start ⇒ turn_cap with maxTurns=3
    deferred.push({ lastTurnStartAt: 1, turns: 0, costUsd: 0.1 });
    deferred.push({ lastTurnStartAt: 1, turns: 0, costUsd: 0.2 });
    deferred.push({ lastTurnStartAt: 2, turns: 1, costUsd: 0.3 });
    deferred.push({ lastTurnStartAt: 3, turns: 2, costUsd: 0.4 });
    deferred.push({ lastTurnStartAt: 4, turns: 3, costUsd: 0.5 });
    await flushMicrotasks();
    expect(h.port.abortCalls).toEqual([{ runId: "r_CONSULT1", reason: "turn_cap" }]);
    h.port.outcome = outcome("aborted", "partial reasoning so far");
    deferred.settle();
    const result = (await pending) as ToolResult;
    expect(result.details.outcome).toBe("turn_cap");
    expect(result.details.partial).toBe(true);
    expect(h.fork.removed).toHaveLength(0);
  });

  it("abort is scheduled via queueMicrotask, never on the snapshot's synchronous stack", async () => {
    const h = harness();
    const deferred = createDeferredSnapshots(h);
    const pending = exec(h);
    await flushMicrotasks();
    deferred.push({ lastTurnStartAt: 1, turns: DEFAULT_SETTINGS.consult.maxTurns, costUsd: 0 });
    // Synchronous stack of the snapshot callback: abort must NOT have run.
    expect(h.port.abortCalls).toHaveLength(0);
    await flushMicrotasks();
    expect(h.port.abortCalls).toHaveLength(1);
    h.port.outcome = outcome("aborted");
    deferred.settle();
    await pending;
  });

  it("$2/$2 collapses maxTurns to 1 (turn2 start is cut); $2/$4 does not — the split-value regression (review-3 #4)", async () => {
    // Shared sequence: est 1.9 (380k×5/M); turn1 message_end settles actual
    // cost at 2.05 (> $2); turn2 starts.
    const sequence = (deferred: ReturnType<typeof createDeferredSnapshots>) => {
      deferred.push({ lastTurnStartAt: 1, turns: 0, costUsd: 1.9 });
      deferred.push({ lastTurnStartAt: 1, turns: 0, costUsd: 2.05 }); // message_end, same turn
    };
    const collapsed = harness({ ref: ref({ contextTokens: 380_000 }), settings: { maxCostUsd: 2 } });
    const d1 = createDeferredSnapshots(collapsed);
    const p1 = exec(collapsed);
    await flushMicrotasks();
    sequence(d1);
    d1.push({ lastTurnStartAt: 2, turns: 1, costUsd: 2.05 }); // turn2 start
    await flushMicrotasks();
    expect(collapsed.port.abortCalls.map((c) => c.reason)).toEqual(["cost_cap"]);
    collapsed.port.outcome = outcome("aborted");
    d1.settle();
    await p1;

    const healthy = harness({ ref: ref({ contextTokens: 380_000 }), settings: { maxCostUsd: 4 } });
    const d2 = createDeferredSnapshots(healthy);
    const p2 = exec(healthy);
    await flushMicrotasks();
    sequence(d2);
    d2.push({ lastTurnStartAt: 2, turns: 1, costUsd: 2.05 }); // turn2 start
    await flushMicrotasks();
    expect(healthy.port.abortCalls).toHaveLength(0);
    healthy.port.outcome = completedOutcome("done");
    d2.settle();
    const result = (await p2) as ToolResult;
    expect(result.details.turnBudgetHint).toBeGreaterThanOrEqual(2);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function createDeferredSnapshots(h: Harness) {
  // Patch waitOutcome to hang until settle() so snapshots can be pushed
  // through the registered watcher while the run is "in flight".
  const originalWait = h.port.waitOutcome.bind(h.port);
  let settled = false;
  h.port.waitOutcome = async (runId: RunId) => {
    return await new Promise<RunOutcome>((resolve) => {
      const poll = () => {
        if (settled) resolve(originalWait(runId) as unknown as RunOutcome);
        else queueMicrotask(poll);
      };
      poll();
    });
  };
  // Push a snapshot through the watcher the tool registered on the port.
  const push = (s: { lastTurnStartAt: number; turns: number; costUsd: number }) => {
    const cb = h.port.watchers.get("r_CONSULT1");
    if (!cb) throw new Error("watcher not registered yet — await flushMicrotasks() first");
    cb({
      runId: "r_CONSULT1",
      generation: 1,
      status: "running",
      phase: "model_turn",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      updatedAt: s.lastTurnStartAt,
      diag: {
        createdAt: 0,
        phase: "model_turn",
        phaseEnteredAt: 0,
        pendingTools: 0,
        turns: s.turns,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        lastTurnStartAt: s.lastTurnStartAt,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: s.costUsd },
      },
    });
  };
  return {
    push,
    settle() {
      settled = true;
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
