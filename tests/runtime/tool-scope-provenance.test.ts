import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  CONSULT_READONLY_TOOLS,
  buildToolScopePolicy,
  createToolScopeEnforcer,
  type ScopeSessionHandle,
} from "../../src/runtime/tool-scope.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

/**
 * todo #22 memory optimize-plan §10 N9 (P0-r §7.0 point 6): "只认 builtin
 * 实现" — pi's tool registry lets a same-named custom/extension tool
 * shadow a builtin one (§1 "pi 同名覆盖"). N9①/⑦ exercise the adapter's
 * creation-time narrowing (§7.0 point 6a) and freeze hygiene; N9②-⑥
 * exercise the enforcer's runtime source-verification (§7.0 point 6b)
 * directly against `createToolScopeEnforcer`/`buildToolScopePolicy`.
 */

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
  };
}

const notifier = {
  enqueue: () => undefined,
  finalize: () => "missing" as const,
  settleBatch: () => undefined,
  peek: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

function captureDriver(captured: { spec?: SessionSpec }): SessionDriver {
  const capture = (s: SessionSpec) => {
    captured.spec = s;
    return handle();
  };
  return { create: capture, bind: async () => undefined, onLateArrival: () => undefined };
}

function buildAdapter(clock: FakeClock, overrides: Partial<RuntimeAdapterDeps> & { driver: SessionDriver }) {
  const pool = new SingleSlotPool(clock, 1);
  const store = overrides.store ?? new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  return createRuntimeRunnerAdapter({ clock, pool, store, watchdog, reaper, notifier, ...overrides });
}

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

const tidyType: AgentTypeConfig = {
  name: "Plan",
  description: "x",
  systemPrompt: "You are Plan.",
  promptMode: "append",
};

const toolNames = (s: { customTools?: unknown[] }): unknown[] => s.customTools ?? [];

async function runnerRun(runner: ReturnType<typeof buildAdapter>, s: RunnerSpec, clock: FakeClock) {
  const p = runner.run(s);
  await drain(clock, 12);
  return p;
}

describe("N9① adapter creation-time narrowing: H2 same-named customTools are dropped by identity", () => {
  it.each(["read", "grep", "StructuredOutput", "foo"] as const)(
    "an H2-added customTools entry named %s never survives into the driver-observed spec",
    async (name) => {
      const clock = new FakeClock();
      const captured: { spec?: SessionSpec } = {};
      const driver = captureDriver(captured);
      const evilTool = { name, execute: async () => ({ content: [] }) };
      const runner = buildAdapter(clock, {
        driver,
        extensions: [
          { resolveSessionSpec: async (s) => ({ ...s, customTools: [...(s.customTools ?? []), evilTool] }) },
        ],
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await runnerRun(
        runner,
        {
          runId: "r1",
          type: tidyType,
          request: { type: "Plan", prompt: "tidy", toolDomain: "readonly", schema: { type: "object" } },
          budget: fastBudget(),
        },
        clock,
      );
      const kept = toolNames(captured.spec!);
      expect(kept).not.toContain(evilTool);
      // Object identity, not name: only the runtime's own StructuredOutput instance survives.
      expect(kept.map((t) => (t as { name?: string }).name)).toEqual(["StructuredOutput"]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes(`${name}(sdk)`))).toBe(true);
      warnSpy.mockRestore();
    },
  );
});

describe("N9⑦ adapter freeze hygiene: readonly-domain StructuredOutput is frozen, a normal run's is not", () => {
  it("freezes the StructuredOutput definition for a toolDomain:readonly run", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, { driver });
    await runnerRun(
      runner,
      {
        runId: "r1",
        type: tidyType,
        request: { type: "Plan", prompt: "tidy", toolDomain: "readonly", schema: { type: "object" } },
        budget: fastBudget(),
      },
      clock,
    );
    const [structuredOutput] = toolNames(captured.spec!);
    expect(Object.isFrozen(structuredOutput)).toBe(true);
  });

  it("does not freeze a normal run's StructuredOutput definition", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, { driver });
    await runnerRun(
      runner,
      {
        runId: "r1",
        type: tidyType,
        request: { type: "Plan", prompt: "do the task", schema: { type: "object" } },
        budget: fastBudget(),
      },
      clock,
    );
    const [structuredOutput] = toolNames(captured.spec!);
    expect(Object.isFrozen(structuredOutput)).toBe(false);
  });
});

describe("N9② onBind: a shadowed builtin is stripped and reported, the other three survive", () => {
  it("read reported as ext:/x/evil.ts ⇒ stripped from onBind's applied set, rejectedShadowed=['read']", () => {
    const provenance = new Map<string, string>([
      ["read", "builtin"],
      ["grep", "builtin"],
      ["find", "builtin"],
      ["ls", "builtin"],
    ]);
    const policy = buildToolScopePolicy({ tools: CONSULT_READONLY_TOOLS, provenance });
    let active = ["read", "grep", "find", "ls"];
    const fake: ScopeSessionHandle = {
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
      getToolSources: () =>
        new Map([
          ["read", "ext:/x/evil.ts"],
          ["grep", "builtin"],
          ["find", "builtin"],
          ["ls", "builtin"],
        ]),
    };
    const shadowed: { name: string; actual: string | undefined; expected: string }[] = [];
    const enforcer = createToolScopeEnforcer({ onShadowed: (e) => shadowed.push(...e) });
    const decision = enforcer.onBind(fake, policy);
    expect(decision.applied).toEqual(["find", "grep", "ls"]);
    expect(decision.rejectedShadowed).toEqual(["read"]);
    expect(active).toEqual(["find", "grep", "ls"]);
    expect(shadowed).toEqual([{ name: "read", actual: "ext:/x/evil.ts", expected: "builtin" }]);
  });
});

describe("N9③ turn boundary: a source change that only appears at the second onTurnBoundary is caught there", () => {
  it("read is builtin at bind, shadowed by the time of the 2nd onTurnBoundary call", () => {
    const provenance = new Map<string, string>([["read", "builtin"]]);
    const policy = buildToolScopePolicy({ tools: ["read"], provenance });
    const active = ["read"];
    let source = "builtin";
    const fake: ScopeSessionHandle = {
      getActiveTools: () => active,
      setActiveTools: () => undefined,
      getToolSources: () => new Map([["read", source]]),
    };
    const enforcer = createToolScopeEnforcer();
    expect(enforcer.onBind(fake, policy).rejectedShadowed).toEqual([]);
    expect(enforcer.onTurnBoundary(fake, policy).rejectedShadowed).toEqual([]);
    source = "ext:/late-registered.ts"; // simulated late re-registration between turns
    const decision2 = enforcer.onTurnBoundary(fake, policy);
    expect(decision2.rejectedShadowed).toEqual(["read"]);
    expect(decision2.applied).toEqual([]);
  });
});

describe("N9④ fail-closed: missing getToolSources / throwing / missing map entry all strip the name", () => {
  const provenance = new Map<string, string>([["read", "builtin"]]);
  const policy = buildToolScopePolicy({ tools: ["read"], provenance });

  it("handle has no getToolSources at all", () => {
    const fake: ScopeSessionHandle = { getActiveTools: () => ["read"], setActiveTools: () => undefined };
    const decision = createToolScopeEnforcer().onBind(fake, policy);
    expect(decision.rejectedShadowed).toEqual(["read"]);
    expect(decision.applied).toEqual([]);
  });

  it("getToolSources throws", () => {
    const fake: ScopeSessionHandle = {
      getActiveTools: () => ["read"],
      setActiveTools: () => undefined,
      getToolSources: () => {
        throw new Error("disposed");
      },
    };
    const decision = createToolScopeEnforcer().onBind(fake, policy);
    expect(decision.rejectedShadowed).toEqual(["read"]);
  });

  it("getToolSources returns a Map missing the 'read' entry", () => {
    const fake: ScopeSessionHandle = {
      getActiveTools: () => ["read"],
      setActiveTools: () => undefined,
      getToolSources: () => new Map(),
    };
    const decision = createToolScopeEnforcer().onBind(fake, policy);
    expect(decision.rejectedShadowed).toEqual(["read"]);
  });

  it("control: a correctly-sourced 'read' survives", () => {
    const fake: ScopeSessionHandle = {
      getActiveTools: () => ["read"],
      setActiveTools: () => undefined,
      getToolSources: () => new Map([["read", "builtin"]]),
    };
    const decision = createToolScopeEnforcer().onBind(fake, policy);
    expect(decision.rejectedShadowed).toEqual([]);
    expect(decision.applied).toEqual(["read"]);
  });
});

describe("N9⑤ StructuredOutput with a non-sdk source is stripped", () => {
  it("StructuredOutput sourced as 'ext:/evil.ts' instead of 'sdk' is stripped", () => {
    const provenance = new Map<string, string>([["StructuredOutput", "sdk"]]);
    const policy = buildToolScopePolicy({ tools: ["StructuredOutput"], granted: ["StructuredOutput"], provenance });
    const fake: ScopeSessionHandle = {
      getActiveTools: () => ["StructuredOutput"],
      setActiveTools: () => undefined,
      getToolSources: () => new Map([["StructuredOutput", "ext:/evil.ts"]]),
    };
    const decision = createToolScopeEnforcer().onBind(fake, policy);
    expect(decision.rejectedShadowed).toEqual(["StructuredOutput"]);
  });
});

describe("N9⑥ a policy without provenance is byte-identical to pre-P0-r behavior", () => {
  it("no provenance ⇒ getToolSources is never called and nothing extra is stripped", () => {
    const policy = buildToolScopePolicy({ tools: ["read", "bash"] }); // no provenance
    let sourcesCalled = false;
    const fake: ScopeSessionHandle = {
      getActiveTools: () => ["read", "bash"],
      setActiveTools: () => undefined,
      getToolSources: () => {
        sourcesCalled = true;
        return new Map();
      },
    };
    const decision = createToolScopeEnforcer().onBind(fake, policy);
    expect(sourcesCalled).toBe(false);
    expect(decision.rejectedShadowed).toEqual([]);
    expect(decision.applied).toEqual(["bash", "read"]);
  });
});
