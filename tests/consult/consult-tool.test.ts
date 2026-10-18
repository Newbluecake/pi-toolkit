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
  consultRunLabel,
  createConsultTool,
  type ConsultForkStore,
  type ConsultSpawnPort,
} from "../../src/consult/tool.js";
import { CONSULT_READONLY_TOOLS } from "../../src/runtime/tool-scope.js";
import { CONSULT_MAIN_AGENT_TYPE, CONSULT_MAIN_EXPERT_ID } from "../../src/core/types.js";
import type { MainSessionFacts } from "../../src/consult/main-facts.js";
import type { ExpertSnapshotScanResult } from "../../src/consult/fork-store.js";
import { CONSULT_NOT_IN_WHITELIST_MARK, CONSULT_OUTCOMES } from "../../src/core/consult-summary.js";
import { registerConsultGuard, releaseConsultGuard } from "../../src/consult/preserve-guard.js";

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

/**
 * consult (plan §16 "consult the main session"): the reserved-id ref
 * `wireConsult.resolveExperts(["main"])` produces (see tests/consult/wire.test.ts
 * for the resolution side) — a whitelist entry a subagent's OWN consult
 * tool receives after `Agent({ experts: ["main"] })`.
 */
function mainRef(overrides: Partial<ConsultExpertRef> = {}): ConsultExpertRef {
  return {
    runId: CONSULT_MAIN_EXPERT_ID,
    label: CONSULT_MAIN_EXPERT_ID,
    sessionFile: expertSessionFile,
    agentType: CONSULT_MAIN_AGENT_TYPE,
    kind: "main",
    ...overrides,
  };
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

function makeForkStore(
  opts: {
    fail?: boolean;
    cwd?: string;
    withMainSession?: boolean;
    snapshot?: ExpertSnapshotScanResult;
  } = {},
) {
  const calls: Array<{ source: string; fallbackCwd: string; forceCwd?: boolean }> = [];
  const mainCalls: Array<{ source: string; fallbackCwd: string; forceCwd?: boolean }> = [];
  const removed: string[] = [];
  let resolveForkCwdCalls = 0;
  const store: ConsultForkStore = {
    forkExpertSession: (sourceFile, fallbackCwd, forkOpts) => {
      calls.push({ source: sourceFile, fallbackCwd, ...(forkOpts?.forceCwd ? { forceCwd: true } : {}) });
      return opts.fail ? { ok: false, reason: "source file has no session header" } : { ok: true, path: FORK_PATH };
    },
    removeForkFile: (path) => {
      removed.push(path);
    },
    scanExpertSnapshot: () =>
      opts.snapshot ?? {
        ok: true as const,
        snapshot: {
          tools: [
            { name: "read", description: "read", parameters: { type: "object" } },
            { name: "grep", description: "grep", parameters: { type: "object" } },
            { name: "find", description: "find", parameters: { type: "object" } },
            { name: "ls", description: "ls", parameters: { type: "object" } },
          ],
          systemSections: {},
          sourceSessionId: "s_expert",
        },
      },
    resolveForkCwd: (_source, fallbackCwd) => {
      resolveForkCwdCalls += 1;
      return opts.cwd ?? fallbackCwd;
    },
    ...(opts.withMainSession
      ? {
          forkMainSession: (sourceFile, fallbackCwd, forkOpts) => {
            mainCalls.push({ source: sourceFile, fallbackCwd, ...(forkOpts?.forceCwd ? { forceCwd: true } : {}) });
            return opts.fail
              ? { ok: false, reason: "source file has no session header" }
              : { ok: true, path: FORK_PATH };
          },
        }
      : {}),
  };
  return { store, calls, mainCalls, removed, resolveForkCwdCalls: () => resolveForkCwdCalls };
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
  selfCwdCallCount: () => number;
}

function harness(
  opts: {
    ref?: ConsultExpertRef;
    query?: QueryService;
    settings?: Partial<ConsultSettings>;
    fork?: ReturnType<typeof makeForkStore>;
    port?: FakePort;
    mainSessionFacts?: () => MainSessionFacts;
    prefixProbeRegistry?: {
      get: (runId: string) => import("../../src/consult/prefix-probe.js").RunPrefixRecord | undefined;
    };
    /** D10 (workflow-worktree plan §2): drives the asker cwd cell's `isolated` flag. */
    isolated?: boolean;
    selfCwd?: string;
    /** cache-thread plan: extra ConsultDeps (threads / anchorLedger / displayMeta / anchorOf / routeApi / now). */
    extra?: Partial<import("../../src/consult/tool.js").ConsultDeps>;
  } = {},
): Harness {
  const port = opts.port ?? new FakePort();
  const fork = opts.fork ?? makeForkStore();
  const settings: ConsultSettings = { ...DEFAULT_SETTINGS.consult, ...opts.settings };
  const priceOf = vi.fn(() => ({ input: 3, cacheWrite: 5 }) as { input: number; cacheWrite: number } | undefined);
  const inFlight = { count: 0 };
  const selfCwdCalls = { count: 0 };
  const tool = createConsultTool({
    selfRunId: SELF_RUN_ID,
    selfCwd: () => {
      selfCwdCalls.count += 1;
      return { cwd: opts.selfCwd ?? SELF_CWD, isolated: opts.isolated ?? false };
    },
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
    ...(opts.mainSessionFacts !== undefined ? { mainSessionFacts: opts.mainSessionFacts } : {}),
    ...(opts.prefixProbeRegistry !== undefined ? { prefixProbeRegistry: opts.prefixProbeRegistry } : {}),
    ...(opts.extra ?? {}),
  });
  return {
    tool,
    port,
    fork,
    priceOf,
    inflightCount: () => inFlight.count,
    settings,
    selfCwdCallCount: () => selfCwdCalls.count,
  };
}

const exec = (h: Harness, expert = "explorer", question = "What did you decide about X?", signal?: AbortSignal) =>
  h.tool.execute("call-1", { expert, question }, signal, undefined, undefined as never);

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  usage?: unknown;
};

// ── schema (review-1 #20) ──────────────────────────────────────────────────

describe("consult tool: schema carries only expert/question/fresh", () => {
  it("has exactly the three model-facing fields (fresh is optional, cache-thread plan user ruling)", () => {
    expect(Object.keys(ConsultToolParams.properties).sort()).toEqual(["expert", "fresh", "question"]);
    expect(ConsultToolParams.required).toEqual(["expert", "question"]);
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

  // consult A/B instrumentation plan (§5 P1b): the throw text now references
  // core's CONSULT_NOT_IN_WHITELIST_MARK — this locks the FULL message
  // byte-for-byte against the pre-P1b literal so `classifyConsultToolEnd`'s
  // bad_ref substring detection can never drift from what the tool throws.
  it("whitelist-mismatch throw is byte-identical and carries the classifier's mark", async () => {
    const h = harness();
    const err = await exec(h, "stranger").then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(CONSULT_NOT_IN_WHITELIST_MARK);
    expect(err!.message).toBe(
      'consult: expert "stranger" is not in this run\'s expert whitelist (allowed: explorer (r_EXPERT1)). ' +
        "Ask your dispatcher to add it, or answer from your own context.",
    );
    expect(err!.message).toBe(
      'consult: expert "stranger" ' +
        CONSULT_NOT_IN_WHITELIST_MARK +
        " (allowed: explorer (r_EXPERT1)). " +
        "Ask your dispatcher to add it, or answer from your own context.",
    );
  });

  // §5 P1b: ConsultOutcome is derived from core's frozen CONSULT_OUTCOMES —
  // lock the values so the tool's details.outcome vocabulary and the
  // diag-side classifier share one source (the type equality itself is
  // compile-time, inside src/consult/tool.ts).
  it("the tool's outcome vocabulary equals core's frozen CONSULT_OUTCOMES", () => {
    expect([...CONSULT_OUTCOMES]).toEqual([
      "completed",
      "unavailable",
      "still_running",
      "busy",
      "context_too_large",
      "cost_too_high",
      "timeout",
      "turn_cap",
      "cost_cap",
      "failed",
      "aborted",
      "identity_mismatch",
      "guard_unavailable",
      "blocked_cap",
    ]);
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

  it("accepts the whitelist description's own `label (r_xxx)` display format (eval-2026-10.md \u00a74 tool-friction)", async () => {
    for (const handle of [
      "explorer (r_EXPERT1)",
      "  explorer (r_EXPERT1)  ",
      "explorer(r_EXPERT1)",
      "mislabeled (r_EXPERT1)", // run id inside parens wins over a wrong label part
    ]) {
      const h = harness();
      const result = (await exec(h, handle)) as ToolResult;
      expect((result.details as { expertRunId?: string }).expertRunId).toBe("r_EXPERT1");
    }
  });

  it("a `label (id)` form whose id is unknown falls back to the (matching) label part", async () => {
    const h = harness();
    const result = (await exec(h, "explorer (r_NOPE)")) as ToolResult;
    expect((result.details as { expertRunId?: string }).expertRunId).toBe("r_EXPERT1");
  });

  it("a `label (id)` form whose id AND label are both unknown throws with the allowed list", async () => {
    const h = harness();
    await expect(exec(h, "stranger (r_NOPE)")).rejects.toThrow(/not in this run's expert whitelist/);
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
      selfCwd: () => ({ cwd: SELF_CWD, isolated: false }),
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

  it("snapshot identity failures refuse before spawn with the exact §3.6 text", async () => {
    for (const code of ["identity_mismatch:no-recorded-loadout", "identity_mismatch:unreadable-snapshot"] as const) {
      const h = harness({ fork: makeForkStore({ snapshot: { ok: false, code, reason: code } }) });
      const result = (await exec(h)) as ToolResult;
      expect(result.details.outcome).toBe("identity_mismatch");
      expect(result.content[0]!.text).toBe(
        `Expert "explorer" could not be consulted without changing its tool definitions (${code}); the consult was refused to keep its read-only guarantee and prompt cache. Fall back to your own investigation.`,
      );
      expect(h.fork.removed).toEqual([FORK_PATH]);
      expect(h.port.spawnCalls).toHaveLength(0);
    }
  });

  it("maps preserve failures from spawn throw, admission error, and terminal outcome", async () => {
    const cases: Array<{
      setup: (h: Harness) => void;
      code: "identity_mismatch:tool-definition:read" | "guard_unavailable:agent-hooks";
      outcome: "identity_mismatch" | "guard_unavailable";
    }> = [
      {
        setup: (h) => {
          h.port.spawnShouldThrow = new Error("[consult-preserve:identity_mismatch:tool-definition:read] mismatch");
        },
        code: "identity_mismatch:tool-definition:read",
        outcome: "identity_mismatch",
      },
      {
        setup: (h) => {
          h.port.spawnResult = {
            error: {
              kind: "config",
              message: "[consult-preserve:guard_unavailable:agent-hooks] missing hook",
              retryable: false,
            },
          };
        },
        code: "guard_unavailable:agent-hooks",
        outcome: "guard_unavailable",
      },
      {
        setup: (h) => {
          h.port.outcome = {
            ...outcome("failed", "partial answer"),
            error: {
              kind: "config",
              message: "[consult-preserve:identity_mismatch:tool-definition:read] mismatch",
              retryable: false,
            },
          };
        },
        code: "identity_mismatch:tool-definition:read",
        outcome: "identity_mismatch",
      },
    ];
    for (const testCase of cases) {
      const h = harness();
      testCase.setup(h);
      const result = (await exec(h)) as ToolResult;
      expect(result.details.outcome).toBe(testCase.outcome);
      expect(result.details.configError).toContain(testCase.code);
      expect(result.content[0]!.text).toBe(
        `Expert "explorer" could not be consulted without changing its tool definitions (${testCase.code}); the consult was refused to keep its read-only guarantee and prompt cache. Fall back to your own investigation.`,
      );
      if (testCase.outcome === "identity_mismatch")
        expect((result.details.cacheProbe as { identity: { preflight: string } }).identity.preflight).toBe(
          `fail:${testCase.code}`,
        );
    }
  });

  it("guard termination maps to blocked_cap while preserving partial-answer behavior", async () => {
    const guard = {
      preflight: () => ({ ok: true as const }),
      install: () => undefined,
      counters: () => ({ calls: 3, batches: 2, terminated: true, identity: 0, nested: 0, costAfterUsd: 0 }),
    };
    registerConsultGuard("r_CONSULT1", guard);
    try {
      const h = harness();
      h.port.outcome = outcome("failed", "partial answer");
      const result = (await exec(h)) as ToolResult;
      expect(result.details.outcome).toBe("blocked_cap");
      expect(result.details.partial).toBe(true);
      expect(result.content[0]!.text).toContain("partial answer");
      expect(result.content[0]!.text).toContain("partial answer — consult ended early");
    } finally {
      releaseConsultGuard("r_CONSULT1");
    }
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
    h.port.outcome = completedOutcome("A".repeat(9000));
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(result.details.truncated).toBe(true);
    expect(result.content[0]!.text).toContain("chars omitted");
    expect(result.content[0]!.text).not.toContain("full session transcript");
    expect(result.content[0]!.text.startsWith("A".repeat(100))).toBe(true); // head 70%
    expect(result.content[0]!.text).toContain("A".repeat(20) + "\n\n\u26a0 answer truncated"); // tail, then note
    expect(result.content[0]!.text).toContain("ask a narrower follow-up");
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
    expect(Object.keys(ConsultToolParams.properties).length).toBe(3); // schema still minimal
    expect(req.expectAck).toBe(true);
    expect(req.forkSessionFrom).toBe(FORK_PATH);
    expect(req.parentRunId).toBe(SELF_RUN_ID);
    expect(req.slotless).toBe(true);
    expect(req.budgetOverride).toEqual({ totalMs: DEFAULT_SETTINGS.consult.timeoutMs });
    expect(req.cwd).toBe("/expert/worktree"); // two-level resolution result
    expect(req.signal).toBe(controller.signal); // same signal, not detached
    expect(req.type).toBe("explorer");
    expect(req.modelOverride).toEqual({ provider: "acme", id: "bigmodel" });
    expect(req.label).toMatch(/^consult-explorer-[a-z0-9]{4}$/);
    expect(req.prompt).toContain(`Allowed tools: ${CONSULT_READONLY_TOOLS.join(", ")}`);
    expect(req.prompt).toContain("why?");
    expect(h.port.waitOutcomeCalls).toEqual(["r_CONSULT1"]);
  });

  it("folds the host-side prefix probe into the consult result for the diagnostic reducer", async () => {
    const h = harness({
      prefixProbeRegistry: {
        get: (runId) =>
          runId === "r_EXPERT1"
            ? {
                runId,
                latest: {
                  seq: 0,
                  startedAt: 10,
                  endedAt: 20,
                  fieldHashes: { model: "m", tools: "t", system: "s", thinking: "h" },
                },
              }
            : runId === "r_CONSULT1"
              ? {
                  runId,
                  api: "anthropic-messages",
                  provider: "anthropic",
                  model: "model",
                  first: {
                    seq: 0,
                    startedAt: 100,
                    fieldHashes: { model: "m", tools: "t", system: "s", thinking: "h" },
                  },
                  requests: [
                    {
                      seq: 0,
                      startedAt: 100,
                      fieldHashes: {},
                      usage: { input: 10, cacheRead: 20, cacheWrite: 0, output: 5, costUsd: 0.1 },
                    },
                  ],
                }
              : undefined,
      },
    });
    const result = (await exec(h)) as ToolResult;
    const probe = result.details.cacheProbe as { identity: { wire?: unknown }; requests?: unknown[] };
    expect(probe.identity.wire).toEqual({ model: true, tools: true, system: true, thinking: true });
    expect(probe.requests).toHaveLength(1);
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

// D10 (docs/dev/workflow-worktree/plan.md §2): isolated-asker cwd (test #10)

describe("consult tool: isolated asker cwd (D10, test #10)", () => {
  it("isolated:true ⇒ fork gets forceCwd, spawn cwd is the asker's worktree, resolveForkCwd is never called", async () => {
    const WORKTREE = "/repo/.pi-worktrees/wt-r1";
    const fork = makeForkStore({ cwd: "/would-be-two-level-cwd" }); // if consulted, this proves the two-level path was skipped
    const h = harness({ fork, isolated: true, selfCwd: WORKTREE });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(h.fork.calls).toEqual([{ source: expertSessionFile, fallbackCwd: WORKTREE, forceCwd: true }]);
    expect(h.fork.resolveForkCwdCalls()).toBe(0); // never consulted for an isolated asker
    const req = h.port.spawnCalls[0]!;
    expect(req.cwd).toBe(WORKTREE); // NOT the two-level result
  });

  it("isolated:false ⇒ call parameters are byte-identical to the pre-D10 baseline (fallback/resolveForkCwd path)", async () => {
    const fork = makeForkStore({ cwd: "/expert/worktree" });
    const h = harness({ fork, isolated: false });
    await exec(h);
    // No forceCwd key at all — matches the exact shape asserted pre-D10.
    expect(h.fork.calls).toEqual([{ source: expertSessionFile, fallbackCwd: SELF_CWD }]);
    expect(h.fork.resolveForkCwdCalls()).toBe(1); // two-level rule still consulted
    const req = h.port.spawnCalls[0]!;
    expect(req.cwd).toBe("/expert/worktree"); // resolveForkCwd's result, unchanged
  });

  it("the getter is read exactly once per execute() call", async () => {
    const h = harness({ isolated: true, selfCwd: "/wt/r1" });
    await exec(h);
    expect(h.selfCwdCallCount()).toBe(1);
  });

  it('the reserved "main" expert follows the same isolated-asker rule', async () => {
    const WORKTREE = "/repo/.pi-worktrees/wt-asker";
    const fork = makeForkStore({ cwd: "/would-be-two-level-cwd", withMainSession: true });
    const h = harness({
      fork,
      isolated: true,
      selfCwd: WORKTREE,
      ref: mainRef(),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "bigmodel" },
        contextTokens: 1000,
        contextPercent: 10,
      }),
    });
    const result = (await exec(h, CONSULT_MAIN_EXPERT_ID)) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(h.fork.mainCalls).toEqual([{ source: expertSessionFile, fallbackCwd: WORKTREE, forceCwd: true }]);
    expect(h.fork.calls).toHaveLength(0); // the plain expert path was not used
    expect(h.fork.resolveForkCwdCalls()).toBe(0);
    const req = h.port.spawnCalls[0]!;
    expect(req.cwd).toBe(WORKTREE);
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

  it("timed_out states the real elapsed wall-clock time, not the configured timeout budget", async () => {
    const h = harness();
    h.port.outcome = outcome("timed_out"); // durationMs 12_345 ≈ 12s
    const result = (await exec(h)) as ToolResult;
    expect(result.content[0]!.text).toContain("wall-clock timeout after 12s");
    expect(result.content[0]!.text).not.toContain(`${Math.round(DEFAULT_SETTINGS.consult.timeoutMs / 1000)}s`);
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
    // eval-2026-10.md §4: the message must state the real cause (turn cap) and
    // the real elapsed time (outcome().durationMs = 12_345ms ≈ 12s), never the
    // unrelated configured timeout budget (DEFAULT_SETTINGS.consult.timeoutMs).
    expect(result.content[0]!.text).toContain("turn cap reached (3 turns) after 12s");
    expect(result.content[0]!.text).not.toContain(`${Math.round(DEFAULT_SETTINGS.consult.timeoutMs / 1000)}s`);
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

// ── §16: consulting the reserved "main" expert ───────────────────────────

describe('consult tool: consulting the reserved "main" expert (§16)', () => {
  it("skips the still_running nack entirely, even if a live run happens to share its runId/sessionFile", async () => {
    const h = harness({
      ref: mainRef(),
      // A live, non-terminal run that (contrived) shares BOTH main's runId
      // and its sessionFile — structurally impossible in production, but
      // proves the still_running re-check is skipped for kind:"main"
      // rather than merely "never matching in practice".
      query: fakeQuery([liveSnapshot({ runId: "main", status: "running", sessionFile: expertSessionFile })]),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "host-model" },
        contextTokens: 1_000,
        contextPercent: 10,
      }),
    });
    const result = (await exec(h, "main")) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(h.port.spawnCalls).toHaveLength(1);
  });

  it("nacks unavailable when the host session has no persisted file right now (--no-session)", async () => {
    const h = harness({ ref: mainRef(), mainSessionFacts: () => ({}) });
    const result = (await exec(h, "main")) as ToolResult;
    expect(result.details.outcome).toBe("unavailable");
    expect(result.content[0]!.text).toContain("--no-session");
    expect(h.port.spawnCalls).toHaveLength(0);
  });

  it("nacks unavailable (never throws) when the first-request cost cannot be estimated (missing tokens)", async () => {
    const h = harness({
      ref: mainRef(),
      mainSessionFacts: () => ({ sessionFile: expertSessionFile, model: { provider: "acme", id: "host-model" } }),
    });
    const result = (await exec(h, "main")) as ToolResult;
    expect(result.details.outcome).toBe("unavailable");
    expect(result.content[0]!.text).toContain("cannot estimate the first-request cost");
    expect(h.fork.calls).toHaveLength(0);
    expect(h.port.spawnCalls).toHaveLength(0);
  });

  it("nacks unavailable when the model is missing (tokens present)", async () => {
    const h = harness({
      ref: mainRef(),
      mainSessionFacts: () => ({ sessionFile: expertSessionFile, contextTokens: 50_000 }),
    });
    const result = (await exec(h, "main")) as ToolResult;
    expect(result.details.outcome).toBe("unavailable");
    expect(result.content[0]!.text).toContain("cannot estimate the first-request cost");
  });

  it("the real expert path is UNCHANGED by §16: missing tokens still just skip the pre-check (not a hard nack)", async () => {
    const h = harness({ ref: ref({ contextTokens: undefined, model: undefined }) });
    const result = (await exec(h)) as ToolResult;
    expect(result.details.outcome).toBe("completed"); // no nack — turn-boundary cap is the guard, as before §16
  });

  it("context_too_large still fires for main, sourced from LIVE mainSessionFacts (not a stale dispatch snapshot)", async () => {
    const h = harness({
      ref: mainRef(),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "host-model" },
        contextTokens: 190_000,
        contextPercent: 95,
      }),
    });
    const result = (await exec(h, "main")) as ToolResult;
    expect(result.details.outcome).toBe("context_too_large");
    expect(h.fork.calls).toHaveLength(0);
  });

  it("forks via forkMainSession (the consistency-checked path) when the store provides it", async () => {
    const h = harness({
      ref: mainRef(),
      fork: makeForkStore({ withMainSession: true }),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "host-model" },
        contextTokens: 1_000,
        contextPercent: 5,
      }),
    });
    const result = (await exec(h, "main")) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(h.fork.calls).toHaveLength(0); // NOT the plain expert path
    expect(h.fork.mainCalls).toHaveLength(1);
    expect(h.fork.mainCalls[0]!.source).toBe(expertSessionFile);
  });

  it("falls back to forkExpertSession when the store does not implement forkMainSession", async () => {
    const h = harness({
      ref: mainRef(),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "host-model" },
        contextTokens: 1_000,
        contextPercent: 5,
      }),
    });
    const result = (await exec(h, "main")) as ToolResult;
    expect(result.details.outcome).toBe("completed");
    expect(h.fork.calls).toHaveLength(1);
  });

  it("passes the host's live model as modelOverride, not a stale ref value", async () => {
    const h = harness({
      ref: mainRef({ model: { provider: "stale", id: "dispatch-time-model" } }),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "live-model" },
        contextTokens: 1_000,
        contextPercent: 5,
      }),
    });
    await exec(h, "main");
    expect(h.port.spawnCalls[0]!.modelOverride).toEqual({ provider: "acme", id: "live-model" });
  });

  it("the prompt carries the main-specific clauses (§16 rule 7)", async () => {
    const h = harness({
      ref: mainRef(),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "host-model" },
        contextTokens: 1_000,
        contextPercent: 5,
      }),
    });
    await exec(h, "main", "what did we decide about X?");
    const prompt = h.port.spawnCalls[0]!.prompt;
    expect(prompt).toContain("You are the host main session");
    expect(prompt).toContain("say so plainly instead of guessing");
    expect(prompt).toContain("what did we decide about X?");
  });

  it("an unlisted subagent cannot reach main through its own consult tool (whitelist, not a global bypass)", async () => {
    // A run whose OWN whitelist does not contain "main" gets the ordinary
    // "not in this run's expert whitelist" throw — the reserved id changes
    // WHAT "main" resolves to, never WHO may ask for it.
    const h = harness({ ref: ref() }); // whitelist = [explorer], no main entry
    await expect(exec(h, "main")).rejects.toThrow(/not in this run's expert whitelist/);
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

describe("consultRunLabel", () => {
  it("names the expert and keeps a random base36 suffix", () => {
    expect(consultRunLabel("re-review-bash-v3")).toMatch(/^consult-re-review-bash-v3-[a-z0-9]{4}$/);
    expect(consultRunLabel("main")).toMatch(/^consult-main-[a-z0-9]{4}$/);
  });

  it("slugs unsafe characters and caps long names at 32 chars", () => {
    expect(consultRunLabel("bash-timeout-grace-plan-v4-(fable)")).toMatch(
      /^consult-bash-timeout-grace-plan-v4-fable-[a-z0-9]{4}$/,
    );
    expect(consultRunLabel("web hub / LAN plan")).toMatch(/^consult-web-hub-LAN-plan-[a-z0-9]{4}$/);
    const slug = consultRunLabel("x".repeat(80)).slice("consult-".length, -5);
    expect(slug).toBe("x".repeat(32));
  });

  it("falls back to consult-<rand4> when there is no usable name", () => {
    expect(consultRunLabel()).toMatch(/^consult-[a-z0-9]{4}$/);
    expect(consultRunLabel("()")).toMatch(/^consult-[a-z0-9]{4}$/);
  });
});

// ── cache-thread plan (package C): threads, first lines, predicted, ledger ─────

import { createConsultThreads } from "../../src/consult/threads.js";
import { createAnchorLedger } from "../../src/consult/anchor-ledger.js";
import type { ConsultDisplayMeta } from "../../src/consult/tool.js";
import type { AnchorIdentity } from "../../src/core/types.js";
import type { AnchorObservation } from "../../src/consult/anchor.js";
import type { RunPrefixRecord } from "../../src/consult/prefix-probe.js";
import { resolveAnchor } from "../../src/consult/anchor.js";

const MiB = 1024 * 1024;
const CAPTURED_IDENTITY: AnchorIdentity = {
  k: 9,
  block: 1,
  blockType: "text",
  blockHash: "bh",
  prefixHash: "ph",
  systemHash: "sh",
  toolsHash: "th",
  route: { provider: "acme", model: "bigmodel", api: "anthropic-messages" },
  ttl: "",
};

function threadHarness(
  opts: {
    ref?: ConsultExpertRef;
    anchor?: AnchorObservation | undefined;
    firstValid?: boolean;
    now?: () => number;
    tokens?: number;
    price?: { input: number; cacheWrite: number } | undefined;
    settings?: Partial<ConsultSettings>;
    scanVariants?: Array<ExpertSnapshotScanResult | undefined>;
    firstUsage?: { input: number; cacheRead: number; cacheWrite: number };
    /** B follow-up: `first.responseOk` and an optional later successful attempt. */
    firstResponseOk?: boolean;
    firstSuccessfulUsage?: { input: number; cacheRead: number; cacheWrite: number };
  } = {},
) {
  let t = 5_000_000;
  const now = opts.now ?? (() => t);
  const sizes = new Map<string, number>([[expertSessionFile, 2 * MiB]]);
  const removedByThreads: string[] = [];
  const threads = createConsultThreads({
    epoch: "ce_tool",
    now,
    fs: {
      size: (p) => sizes.get(p),
      remove: (p) => {
        removedByThreads.push(p);
        sizes.delete(p);
      },
    },
  });
  const ledger = createAnchorLedger({ now });
  const metas = new Map<string, ConsultDisplayMeta>();
  const metaLog: Array<{ path: string; meta: ConsultDisplayMeta }> = [];
  let forkSeq = 0;
  const forkSources: string[] = [];
  const removed: string[] = [];
  let scanCalls = 0;
  const defaultScan: ExpertSnapshotScanResult = {
    ok: true as const,
    snapshot: {
      tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
      systemSections: {},
      sourceSessionId: "s_expert",
      model: { provider: "acme", id: "bigmodel" },
      lastRequestUsage: { input: 10, cacheRead: 100_000, cacheWrite: 0 },
    },
  };
  const store: ConsultForkStore = {
    forkExpertSession: (source) => {
      forkSources.push(source);
      const path = `/cache/consult-sessions/fork-${++forkSeq}.jsonl`;
      sizes.set(path, 1 * MiB);
      return { ok: true, path };
    },
    removeForkFile: (p) => {
      removed.push(p);
    },
    scanExpertSnapshot: () => {
      const v = opts.scanVariants?.[scanCalls];
      scanCalls += 1;
      return v ?? defaultScan;
    },
  };
  const registryRecord = (): RunPrefixRecord => ({
    runId: "r_CONSULT1",
    ...(opts.firstSuccessfulUsage === undefined
      ? {}
      : {
          firstSuccessful: {
            seq: 2,
            startedAt: now() - 1500,
            endedAt: now() - 500,
            fieldHashes: {},
            responseOk: true,
            ...(opts.anchor === undefined ? {} : { anchor: opts.anchor }),
            usage: { ...opts.firstSuccessfulUsage, output: 20, costUsd: 0.3 },
          },
        }),
    ...(opts.anchor === undefined ? {} : { anchor: opts.anchor }),
    first: {
      seq: 1,
      startedAt: now() - 2000,
      endedAt: now() - 1000,
      fieldHashes: {},
      ...(opts.anchor === undefined ? {} : { anchor: opts.anchor }),
      ...(opts.firstValid === undefined ? {} : { anchorIdentityValid: opts.firstValid }),
      ...(opts.firstResponseOk === undefined ? {} : { responseOk: opts.firstResponseOk }),
      usage: {
        ...(opts.firstUsage ?? { input: 5, cacheRead: 0, cacheWrite: 100_000 }),
        output: 20,
        costUsd: 0.3,
      },
    },
  });
  const port = new FakePort();
  const outcomeWithCtx = (text: string): RunOutcome => {
    const o = completedOutcome(text);
    return {
      ...o,
      diag: { ...o.diag, contextUsage: { tokens: opts.tokens ?? 5000, contextWindow: 200_000, percent: 2.5 } },
    };
  };
  port.outcome = outcomeWithCtx("answer one");
  const h = harness({
    port,
    fork: { store, calls: [], mainCalls: [], removed, resolveForkCwdCalls: () => 0 },
    ref: opts.ref ?? ref(),
    ...(opts.settings === undefined ? {} : { settings: opts.settings }),
    prefixProbeRegistry: { get: (id) => (id === "r_CONSULT1" ? registryRecord() : undefined) },
    extra: {
      threads,
      anchorLedger: ledger,
      routeApi: () => "anthropic-messages",
      displayMeta: {
        put: (path, meta) => {
          metas.set(path, meta);
          metaLog.push({ path, meta });
        },
        drop: (path) => {
          metas.delete(path);
        },
      },
      ...(opts.anchor === undefined ? {} : {}),
      now,
    },
  });
  if (opts.price !== undefined || "price" in opts) h.priceOf.mockImplementation(() => opts.price);
  const call = (params: { question?: string; fresh?: boolean; expert?: string } = {}) =>
    h.tool.execute(
      "call-t",
      {
        expert: params.expert ?? "explorer",
        question: params.question ?? "Q?",
        ...(params.fresh ? { fresh: true } : {}),
      },
      undefined,
      undefined,
      undefined as never,
    ) as Promise<ToolResult>;
  return {
    h,
    port,
    threads,
    ledger,
    sizes,
    metas,
    metaLog,
    forkSources,
    removed,
    removedByThreads,
    call,
    advance: (ms: number) => {
      t += ms;
    },
    setOutcome: (text: string, status: RunOutcome["status"] = "completed") => {
      port.outcome = status === "completed" ? outcomeWithCtx(text) : outcome(status, text);
    },
    reap: (index: number, disposed = true) => {
      const path = `/cache/consult-sessions/fork-${index}.jsonl`;
      return threads.onReaped(path, { disposed });
    },
  };
}

const firstLine = (r: ToolResult): string => r.content[0]!.text.split("\n")[0]!;

describe("consult threads through the tool (cache-thread plan §4.5/§5.1)", () => {
  const goodAnchor: AnchorObservation = { state: "added", identity: CAPTURED_IDENTITY };

  it("first consult: `new thread` first line, forks the original, predicted+thread meta written ONCE keyed by fork path", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    const r = await e.call();
    expect(firstLine(r)).toBe("[new consult thread — no earlier Q/A with this expert]");
    expect(r.content[0]!.text).toContain("answer one");
    expect(e.forkSources).toEqual([expertSessionFile]);
    const logged = e.metaLog[0]!;
    expect(logged.path).toBe("/cache/consult-sessions/fork-1.jsonl");
    expect(logged.meta.consultCache.v).toBe(1);
    expect(logged.meta.consultCache.predicted.state).toBe("unknown");
    const probeThread = (r.details.cacheProbe as { thread: { id: string; seq: number; mode: string } }).thread;
    // ONE fact, two projections (A hand-off): consult-run meta === asker probe
    expect(logged.meta.consultThread).toEqual({ threadId: probeThread.id, seq: probeThread.seq });
    expect(probeThread.mode).toBe("new");
    // the spawn request carries the host anchor spec with the EXACT prompt text and no base on a new thread
    const req = e.port.spawnCalls[0]!;
    expect(req.consultAnchor).toEqual({ prompt: req.prompt });
    // the take-once entry is dropped by the tool's finally if the adapter never took it
    expect(e.metas.size).toBe(0);
  });

  it("every consult run gets `predicted`: main, no evidence and OAuth-style all yield {state:'unknown'}", async () => {
    // main: never a thread, never a first line
    const m = threadHarness({
      ref: mainRef(),
      settings: {},
    });
    const mh = harness({
      ref: mainRef(),
      mainSessionFacts: () => ({
        sessionFile: expertSessionFile,
        model: { provider: "acme", id: "bigmodel" },
        contextTokens: 1000,
        contextPercent: 1,
      }),
      extra: {
        threads: m.threads,
        anchorLedger: m.ledger,
        displayMeta: { put: (p, meta) => m.metaLog.push({ path: p, meta }), drop: () => undefined },
      },
    });
    const mr = (await mh.tool.execute(
      "c",
      { expert: "main", question: "q" },
      undefined,
      undefined,
      undefined as never,
    )) as ToolResult;
    expect(mr.content[0]!.text).not.toMatch(/^\[/);
    expect(m.metaLog).toHaveLength(1);
    expect(m.metaLog[0]!.meta.consultCache.predicted).toEqual({ state: "unknown", reason: "main" });
    expect(m.metaLog[0]!.meta.consultThread).toBeUndefined();
    expect(m.threads.views()).toEqual([]); // main never builds a thread
    expect(mr.details.outcome).toBe("completed");
    expect((mr.details.cacheProbe as { warm: unknown }).warm).toEqual({ state: "unknown", reason: "main" });

    // no ledger wired (legacy deps) still writes unknown
    const metaLog: ConsultDisplayMeta[] = [];
    const bare = harness({
      extra: { displayMeta: { put: (_p, meta) => metaLog.push(meta), drop: () => undefined } },
    });
    await exec(bare);
    expect(metaLog[0]!.consultCache.predicted.state).toBe("unknown");

    // OAuth-degraded earlier touch ⇒ unknown(degraded-anchor)
    const o = threadHarness({ anchor: { state: "relocated", identity: CAPTURED_IDENTITY, degraded: true } });
    await o.call({ question: "one" });
    o.reap(1);
    await o.call({ question: "two" });
    expect(o.metaLog[1]!.meta.consultCache.predicted).toMatchObject({ state: "unknown" });
  });

  it("follow-up after a sealed answer: continued #2, forks the head, prompt has the follow-up line, base is passed", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call({ question: "first" });
    expect(e.reap(1)).toBe("keep"); // sealed + eligible ⇒ promoted
    e.setOutcome("answer two");
    const r2 = await e.call({ question: "second" });
    const id = (e.metaLog[0]!.meta.consultThread as { threadId: string }).threadId;
    expect(firstLine(r2)).toBe(
      `[consult thread ${id} #2 — the expert sees your previous 1 question(s) and its full answers]`,
    );
    expect(e.forkSources).toEqual([expertSessionFile, "/cache/consult-sessions/fork-1.jsonl"]);
    const req2 = e.port.spawnCalls[1]!;
    expect(req2.prompt).toContain(
      "This is follow-up #2 in this consult thread; your earlier answers above are complete",
    );
    expect(req2.prompt.indexOf("This is follow-up #2")).toBeLessThan(req2.prompt.indexOf("\nQuestion:\n"));
    expect(req2.prompt.startsWith("READ-ONLY CONSULT MODE\n")).toBe(true);
    expect(req2.consultAnchor).toEqual({ prompt: req2.prompt, base: CAPTURED_IDENTITY });
    expect(e.metaLog[1]!.meta.consultThread).toEqual({ threadId: id, seq: 2 });
  });

  it("answer not sealed yet ⇒ `previous answer not yet retained` and the unsealed file is never forked", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call();
    const r2 = await e.call(); // fork-1 not reaped yet
    expect(firstLine(r2)).toBe(
      "[previous answer not yet retained — the expert sees no earlier Q/A in this thread yet]",
    );
    expect(e.forkSources).toEqual([expertSessionFile, expertSessionFile]);
    expect(e.threads.views()[0]!.headFile).toBeUndefined();
  });

  it("a disposed:false reap never promotes: the next consult is a new thread again", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call();
    expect(e.reap(1, false)).toBe("delete");
    const r2 = await e.call();
    expect(firstLine(r2)).toBe("[new consult thread — no earlier Q/A with this expert]");
  });

  it("fresh:true drops the thread and says so; its answer is the new thread's #1", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call();
    e.reap(1);
    const r = await e.call({ fresh: true });
    expect(firstLine(r)).toBe(
      "[fresh consult (fresh:true) — earlier Q/A in this thread were dropped and will not be retained]",
    );
    expect(e.forkSources[1]).toBe(expertSessionFile);
    expect(e.removedByThreads).toContain("/cache/consult-sessions/fork-1.jsonl");
    e.reap(2);
    expect(e.threads.views()[0]!.seq).toBe(1);
    expect(e.threads.views()[0]!.headFile).toBe("/cache/consult-sessions/fork-2.jsonl");
  });

  it("head context ≥75% ⇒ reset(context): forks the original, honest first line", async () => {
    const e = threadHarness({ anchor: goodAnchor, tokens: 160_000 });
    await e.call();
    e.reap(1);
    // head.percent = 2.5 from diag in the helper; force via a high percent outcome
    e.port.outcome = {
      ...completedOutcome("big"),
      diag: {
        ...completedOutcome("big").diag,
        contextUsage: { tokens: 160_000, contextWindow: 200_000, percent: 80 },
      },
    };
    await e.call(); // #2 consult continues (head tokens were from #1 = 160k, percent 2.5) …
    e.reap(2);
    const r = await e.call(); // … now the head carries percent 80
    expect(firstLine(r)).toBe("[thread reset (context) — the expert does NOT see your earlier questions]");
    expect(e.forkSources.at(-1)).toBe(expertSessionFile);
  });

  it("head first-request cost is estimated as a conservative COLD write ⇒ reset(cost) when over maxFirstRequestUsd", async () => {
    // price: input 3, write 5 $/M; head 100k tokens ⇒ 0.5$; cap 0.4$
    const e = threadHarness({
      anchor: goodAnchor,
      tokens: 100_000,
      settings: { maxFirstRequestUsd: 0.4 },
      ref: ref({ contextTokens: 10_000 }), // the original (10k ⇒ $0.05) passes the existing gate
    });
    await e.call();
    e.reap(1);
    const r = await e.call();
    expect(firstLine(r)).toBe("[thread reset (cost) — the expert does NOT see your earlier questions]");
  });

  it("a concurrent second consult is a parallel branch (not kept)", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call();
    e.reap(1);
    // hold #2 in flight, ask #3 meanwhile
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const origWait = e.port.waitOutcome.bind(e.port);
    let n = 0;
    e.port.waitOutcome = async (id) => {
      n += 1;
      if (n === 1) await gate;
      return origWait(id);
    };
    const p2 = e.call({ question: "two" });
    await new Promise((r) => setTimeout(r, 0));
    const r3 = await e.call({ question: "three" });
    expect(firstLine(r3)).toBe(
      `[parallel branch — the expert sees thread #1; this answer will NOT be kept for follow-ups]`,
    );
    release();
    await p2;
  });

  /** Hold consult #2 in flight (gate), run `during` (a concurrent branch), then release #2. */
  async function withInFlightSecond(
    e: ReturnType<typeof threadHarness>,
    during: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const origWait = e.port.waitOutcome.bind(e.port);
    let n = 0;
    e.port.waitOutcome = async (id) => {
      n += 1;
      if (n === 1) await gate;
      return origWait(id);
    };
    const p2 = e.call({ question: "two" });
    await new Promise((r) => setTimeout(r, 0));
    const branch = await during();
    release();
    await p2;
    return branch;
  }

  it("a branch consult runs the SAME head admission: over the cold-write cost line ⇒ original session + truthful reset(cost) line (follow-up r_38A7HG4K #1)", async () => {
    const e = threadHarness({
      anchor: goodAnchor,
      tokens: 100_000, // head 100k ⇒ conservative cold write $0.50
      ref: ref({ contextTokens: 10_000 }), // the original session ($0.05) passes the existing gate
    });
    await e.call(); // #1 under the default (lenient) cap
    e.reap(1);
    const before = e.forkSources.length;
    // #2 is admitted as a continued consult; while it is in flight the cap drops below the head's cold-write cost,
    // so the concurrent #3 (a branch) must NOT slip past the preflight.
    const branch = await withInFlightSecond(e, () => {
      e.h.settings.maxFirstRequestUsd = 0.4;
      return e.call({ question: "three" });
    });
    expect(firstLine(branch)).toBe("[thread reset (cost) — the expert does NOT see your earlier questions]");
    expect(e.forkSources.slice(before)).toEqual(["/cache/consult-sessions/fork-1.jsonl", expertSessionFile]);
    expect(branch.content[0]!.text).not.toContain("sees thread #");
    expect(e.threads.views().length).toBe(1); // the writer's thread survives the side lease
  });

  it("branch with the head file gone ⇒ original session + truthful reset(identity) line (follow-up #3)", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call();
    e.reap(1);
    const before = e.forkSources.length;
    const branch = await withInFlightSecond(e, async () => {
      e.sizes.delete("/cache/consult-sessions/fork-1.jsonl"); // head vanished while #2 is in flight
      return e.call({ question: "three" });
    });
    expect(firstLine(branch)).toBe("[thread reset (identity) — the expert does NOT see your earlier questions]");
    expect(e.forkSources[before + 1]).toBe(expertSessionFile);
    expect(branch.content[0]!.text).not.toContain("sees thread #");
    // the thread itself (its writer #2) was NOT dropped by the side lease
    expect(e.threads.views().length).toBe(1);
  });

  it("partial answers use the plan's 'not retained' truncation wording when a thread lease exists (follow-up #5)", async () => {
    const e = threadHarness({ anchor: goodAnchor, settings: { maxAnswerChars: 100 } });
    e.setOutcome("y".repeat(300), "failed");
    const r = await e.call();
    expect(r.content[0]!.text).toContain("⚠ partial answer");
    expect(r.content[0]!.text).toContain(
      "⚠ answer truncated at 100 chars; this answer is not retained — ask a narrower follow-up.",
    );
    expect(r.content[0]!.text).not.toContain("ask a narrower follow-up.\n⚠");
  });

  it("truncation notes depend on retention: kept in the thread vs not retained", async () => {
    const long = "x".repeat(300);
    const e = threadHarness({ anchor: goodAnchor, settings: { maxAnswerChars: 100 } });
    e.setOutcome(long);
    const kept = await e.call();
    expect(kept.content[0]!.text).toContain(
      '⚠ answer truncated at 100 chars; it will be kept in this consult thread once this consult closes — consult again (e.g. "continue from where you were cut off") to get the rest.',
    );
    // while #1 is unsealed, #2 is `pending` ⇒ not retained
    const notKept = await e.call();
    expect(notKept.content[0]!.text).toContain(
      "⚠ answer truncated at 100 chars; this answer is not retained — ask a narrower follow-up.",
    );
    expect(notKept.details.truncated).toBe(true);
  });

  it("only a clean completed answer is eligible: a failed consult never becomes the head", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    e.setOutcome("partial text", "failed");
    await e.call();
    e.reap(1);
    expect(e.threads.views()[0]!.headFile).toBeUndefined();
    expect(e.threads.stats().promotions).toBe(0);
  });

  it("spawn admission failure releases the lease and removes the pending metadata; the thread can continue", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    e.port.spawnShouldThrow = new Error("admission boom");
    await e.call();
    expect(e.removed).toContain("/cache/consult-sessions/fork-1.jsonl");
    expect(e.metas.size).toBe(0);
    e.port.spawnShouldThrow = undefined;
    const r = await e.call();
    expect(firstLine(r)).toBe("[new consult thread — no earlier Q/A with this expert]");
    expect(e.threads.views()[0]!.busy).toBe(false);
  });

  it("loadout drift on a thread head ⇒ identity reset from the original (never continue on a different prefix)", async () => {
    const otherSnapshot: ExpertSnapshotScanResult = {
      ok: true,
      snapshot: {
        tools: [{ name: "read", description: "CHANGED", parameters: { type: "object" } }],
        systemSections: {},
        sourceSessionId: "s_expert",
        model: { provider: "acme", id: "bigmodel" },
        lastRequestUsage: { input: 10, cacheRead: 100_000, cacheWrite: 0 },
      },
    };
    // scan #1 (first consult) default; scan #2 (follow-up from the head) drifted; scan #3 (retry) default
    const e = threadHarness({ anchor: goodAnchor, scanVariants: [undefined, otherSnapshot, undefined] });
    await e.call();
    e.reap(1);
    const r = await e.call();
    expect(firstLine(r)).toBe("[thread reset (identity) — the expert does NOT see your earlier questions]");
    expect(e.forkSources).toEqual([expertSessionFile, "/cache/consult-sessions/fork-1.jsonl", expertSessionFile]);
    expect(e.removed).toContain("/cache/consult-sessions/fork-2.jsonl"); // drifted copy deleted
  });
});

describe("anchor ledger + prediction through the tool (§5.1)", () => {
  const goodAnchor: AnchorObservation = { state: "added", identity: CAPTURED_IDENTITY };

  it("a proven touch makes the NEXT consult (even a first consult by another asker) predicted warm, bound to request START", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call();
    expect(e.ledger.size()).toBe(1);
    e.advance(30_000);
    // a fresh thread for the same expert ⇒ same route/digest ⇒ warm
    await e.call({ fresh: true });
    const predicted = e.metaLog[1]!.meta.consultCache.predicted;
    expect(predicted.state).toBe("warm");
    expect(predicted.evidence?.source).toBe("anchor-ledger");
    // touch time = first.startedAt (now−2000 at the time of the call), not dispatch time
    expect(predicted.evidence?.lastProvenTouchAt).toBe(5_000_000 - 2000);
  });

  it("the warm window expires: > TTL later the prediction is cold", async () => {
    const e = threadHarness({ anchor: goodAnchor });
    await e.call();
    e.advance(5 * 60_000 + 1000);
    await e.call({ fresh: true });
    expect(e.metaLog[1]!.meta.consultCache.predicted.state).toBe("cold");
  });

  it("no touch when the anchor is skipped / absent, usage is too small, or identity drifted (anchorIdentityValid === false)", async () => {
    for (const variant of [
      { anchor: { state: "skipped:shape" } as AnchorObservation },
      { anchor: undefined },
      { anchor: goodAnchor, firstUsage: { input: 5, cacheRead: 100, cacheWrite: 100 } }, // < 0.9 × 100010
      { anchor: goodAnchor, firstValid: false },
    ]) {
      const e = threadHarness(variant);
      await e.call();
      expect(e.ledger.size()).toBe(0);
    }
  });

  it("a failed/superseded first attempt (responseOk === false) proves nothing; a later firstSuccessful does", async () => {
    // failed first attempt, no successful one ⇒ no warm proof and an n/a cacheResult (usage of a failed attempt is untrusted)
    const failed = threadHarness({ anchor: goodAnchor, firstResponseOk: false });
    const r = await failed.call();
    expect(failed.ledger.size()).toBe(0);
    failed.reap(1);
    await failed.call();
    // …and the failed attempt's anchor is never stored as the thread base either
    expect(failed.port.spawnCalls[1]!.consultAnchor?.base).toBeUndefined();
    expect((r.details.cacheProbe as { cacheResult: { label: string } }).cacheResult.label).toBe("n/a");

    // strict-tool fallback: attempt 1 superseded, attempt 2 succeeded ⇒ evidence comes from firstSuccessful
    const retried = threadHarness({
      anchor: goodAnchor,
      firstResponseOk: false,
      firstUsage: { input: 1, cacheRead: 0, cacheWrite: 0 }, // would never qualify
      firstSuccessfulUsage: { input: 2, cacheRead: 99_000, cacheWrite: 1_000 },
    });
    const r2 = await retried.call();
    expect(retried.ledger.size()).toBe(1);
    expect((r2.details.cacheProbe as { cacheResult: { label: string } }).cacheResult.label).toBe("hit");
    retried.advance(1000);
    await retried.call({ fresh: true });
    expect(retried.metaLog[1]!.meta.consultCache.predicted.evidence?.lastProvenTouchAt).toBe(5_000_000 - 1500);

    // an unmarked first (responseOk undefined, legacy record) still counts
    const legacy = threadHarness({ anchor: goodAnchor });
    await legacy.call();
    expect(legacy.ledger.size()).toBe(1);
  });

  it("OAuth follow-up (E1 blocker): a relocated+degraded first anchor still yields a base, so the follow-up is skipped:limit with pi's marker intact", async () => {
    const model = { provider: "acme", id: "bigmodel", api: "anthropic-messages" };
    const cc = { type: "ephemeral" };
    const sys = [
      { type: "text", text: "You are Claude Code.", cache_control: cc },
      { type: "text", text: "SYS", cache_control: cc },
    ];
    const tools = [{ name: "read", description: "r", input_schema: { type: "object" }, cache_control: cc }];
    const history = [
      { role: "user", content: [{ type: "text", text: "expert task" }] },
      { role: "assistant", content: [{ type: "text", text: "expert answer" }] },
    ];
    const withMarker = (text: string) => ({ role: "user", content: [{ type: "text", text, cache_control: cc }] });
    // consult #1 on an OAuth 4-breakpoint route: system(1) + system(2) + tools + last message = 4 ⇒ must relocate
    const p1 = "Q1 prompt";
    const body1 = { system: sys, tools, messages: [...history, withMarker(p1)] };
    const d1 = resolveAnchor(body1, { prompt: p1 }, model, { first: true });
    expect(d1).toMatchObject({ state: "relocated", degraded: true });
    if (d1.state !== "relocated") throw new Error("setup: expected relocated");

    const e = threadHarness({ anchor: { state: "relocated", identity: d1.identity, degraded: true } });
    await e.call({ question: "q1" });
    e.reap(1);
    await e.call({ question: "q2" });
    const spec2 = e.port.spawnCalls[1]!.consultAnchor!;
    expect(spec2.base).toEqual(d1.identity); // retained despite degraded

    // consult #2's real wire body: history + Q1 + A1 + Q2 with pi's four default breakpoints again
    const unmarked = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });
    const body2 = {
      system: sys,
      tools,
      messages: [...history, unmarked("user", p1), unmarked("assistant", "A1"), withMarker(spec2.prompt)],
    };
    // Without a base (the pre-fix behaviour) the same body would be treated as a fresh first request and relocated:
    expect(resolveAnchor(body2, { prompt: spec2.prompt }, model, { first: true }).state).toBe("relocated");
    const d2 = resolveAnchor(body2, spec2, model, { first: true });
    expect(d2.state).toBe("skipped:limit");
    expect(d2.payload).toEqual(body2); // pi's last-message marker untouched, nothing relocated
    const last = (d2.payload as typeof body2).messages.at(-1)!;
    expect(last.content[0]).toHaveProperty("cache_control");
  });

  it("the base is NOT retained for identity drift or a failed/superseded first attempt (degraded or not)", async () => {
    const degradedAnchor: AnchorObservation = { state: "relocated", identity: CAPTURED_IDENTITY, degraded: true };
    for (const variant of [{ firstValid: false }, { firstResponseOk: false }]) {
      const e = threadHarness({ anchor: degradedAnchor, ...variant });
      await e.call();
      e.reap(1);
      await e.call();
      expect(e.port.spawnCalls[1]!.consultAnchor?.base).toBeUndefined();
    }
    const ok = threadHarness({ anchor: degradedAnchor });
    await ok.call();
    ok.reap(1);
    await ok.call();
    expect(ok.port.spawnCalls[1]!.consultAnchor?.base).toEqual(CAPTURED_IDENTITY);
    // …but a degraded anchor still never counts as warm-proof evidence (plan §3.4: OAuth predicts unknown)
    expect(
      ok.ledger.predict({
        expertRunId: "r_EXPERT1",
        api: "anthropic-messages",
        route: { provider: "acme", model: "bigmodel" },
        snapDigest: "x",
      }).state,
    ).not.toBe("warm");
    expect(ok.metaLog[1]!.meta.consultCache.predicted).toMatchObject({ state: "unknown", reason: "degraded-anchor" });
  });

  it("a drifted baseline is also never stored as a thread base", async () => {
    const e = threadHarness({ anchor: goodAnchor, firstValid: false });
    await e.call();
    e.reap(1);
    await e.call();
    expect(e.port.spawnCalls[1]!.consultAnchor).toEqual({ prompt: e.port.spawnCalls[1]!.prompt }); // no base
    expect(e.metaLog[1]!.meta.consultCache.predicted).toMatchObject({ state: "unknown", reason: "degraded-anchor" });
  });

  it("probe carries anchor + cacheResult (v1 metric) + warm from the same prediction", async () => {
    const e = threadHarness({ anchor: goodAnchor, firstUsage: { input: 2, cacheRead: 99_000, cacheWrite: 1_000 } });
    const r = await e.call();
    const probe = r.details.cacheProbe as {
      anchor: { state: string };
      cacheResult: { label: string; v: number; anchor: string };
      warm: { state: string };
    };
    expect(probe.anchor.state).toBe("added");
    expect(probe.cacheResult).toMatchObject({ v: 1, label: "hit", anchor: "added" });
    expect(probe.warm).toEqual(e.metaLog[0]!.meta.consultCache.predicted);
  });
});
