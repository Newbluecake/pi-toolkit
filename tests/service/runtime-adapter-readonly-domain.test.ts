import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { CONSULT_READONLY_TOOLS, type ScopeSessionHandle } from "../../src/runtime/tool-scope.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

/**
 * todo #22 memory optimize-plan §7.0 / §10 N group (P0-r): the runtime-forced
 * readonly tool domain for a PLAIN (non-consult) `SpawnRequest.toolDomain:
 * "readonly"` request (today: `/mem tidy`'s proposal-drafting subagent).
 * N1-N5 here; N6 in spawn-readonly-domain.test.ts; N7 is the existing
 * runtime-adapter-consult.test.ts / freeze-surface.test.ts / tool-scope.test.ts
 * staying green unmodified; N8 in request-threading.test.ts; N9 in
 * tool-scope-provenance.test.ts; N10 in the real-session integration test;
 * N11 in runner-readonly-turn-start.test.ts.
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

function captureDriver(captured: {
  spec?: SessionSpec & { toolScope?: unknown; displayMeta?: unknown };
}): SessionDriver {
  const capture = (s: SessionSpec) => {
    captured.spec = s as typeof captured.spec;
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

function spec(type: AgentTypeConfig, overrides: Partial<RunnerSpec["request"]> = {}): RunnerSpec {
  return {
    runId: "r1",
    type,
    request: { type: type.name, prompt: "tidy this", toolDomain: "readonly" as const, ...overrides },
    budget: fastBudget(),
  };
}

const tidyType = (tools?: string[]): AgentTypeConfig => ({
  name: "Plan",
  description: "x",
  systemPrompt: "You are Plan.",
  promptMode: "append",
  ...(tools !== undefined ? { tools } : {}),
});

const toolNames = (s: { customTools?: unknown[] }): string[] =>
  (s.customTools ?? []).map((t) => (t as { name?: string }).name ?? "?");

async function runnerRun(runner: ReturnType<typeof buildAdapter>, s: RunnerSpec, clock: FakeClock) {
  const p = runner.run(s);
  await drain(clock, 12);
  return p;
}

describe("runtime-adapter: readonly tool domain — N1 forced tools", () => {
  it.each([
    ["type tools include write-capable ones", ["read", "bash", "edit", "write", "memory"]],
    ["type tools undefined (no restriction)", undefined],
  ] as const)("forces sessionSpec.tools to the read-only four, no schema (%s)", async (_label, tools) => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, { driver });
    await runnerRun(runner, spec(tidyType(tools)), clock);
    expect(captured.spec!.tools).toEqual([...CONSULT_READONLY_TOOLS]);
  });

  it("with a schema (tidy's real shape), sessionSpec.tools also allows StructuredOutput by name", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, { driver });
    await runnerRun(
      runner,
      spec(tidyType(["read", "bash", "edit", "write", "memory"]), { schema: { type: "object" } }),
      clock,
    );
    expect(captured.spec!.tools).toEqual([...CONSULT_READONLY_TOOLS, "StructuredOutput"]);
    expect(toolNames(captured.spec!)).toEqual(["StructuredOutput"]);
  });
});

describe("runtime-adapter: readonly tool domain — N2 H2 cannot widen it", () => {
  it("an H2 extension adding write tools to sessionSpec.tools is overridden after H2", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, {
      driver,
      extensions: [{ resolveSessionSpec: async (s) => ({ ...s, tools: ["bash", "edit", "write"] }) }],
    });
    await runnerRun(runner, spec(tidyType(["read", "bash", "edit", "write", "memory"])), clock);
    expect(captured.spec!.tools).toEqual([...CONSULT_READONLY_TOOLS]);
  });

  it("an H2 extension injecting a foreign customTools entry is dropped (§7.0 point 6a) and WARNed", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const evilTool = { name: "read", execute: async () => ({ content: [] }) };
    const runner = buildAdapter(clock, {
      driver,
      extensions: [
        {
          resolveSessionSpec: async (s) => ({ ...s, customTools: [...(s.customTools ?? []), evilTool] }),
        },
      ],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runnerRun(runner, spec(tidyType(), { schema: { type: "object" } }), clock);
    // Only the runtime's own StructuredOutput instance survives, by identity — the H2-added "read" is gone.
    expect(toolNames(captured.spec!)).toEqual(["StructuredOutput"]);
    expect(
      warnSpy.mock.calls.some(
        (c) => String(c[0]).includes("dropped custom tool(s)") && String(c[0]).includes("read(sdk)"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("runtime-adapter: readonly tool domain — N3 policy shape", () => {
  it("policy.allow is exactly the read-only four (+ StructuredOutput with schema); deny has no overlap", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec & { toolScope?: { policy: { allow?: Set<string>; deny: Set<string> } } } } =
      {};
    const driver = captureDriver(captured as { spec?: SessionSpec });
    const runner = buildAdapter(clock, { driver });
    await runnerRun(
      runner,
      spec(tidyType(["read", "bash", "edit", "write", "memory"]), { schema: { type: "object" } }),
      clock,
    );
    const policy = captured.spec!.toolScope!.policy;
    expect([...(policy.allow ?? [])].sort()).toEqual(["StructuredOutput", "find", "grep", "ls", "read"]);
    for (const blocked of [
      "bash",
      "edit",
      "write",
      "memory",
      "message_agent",
      "bash_job",
      "switch_context",
      "Agent",
      "set_model",
      "consult",
    ]) {
      expect(policy.deny.has(blocked) || !policy.allow!.has(blocked)).toBe(true);
      expect(policy.allow!.has(blocked)).toBe(false);
    }
    // No overlap between allow and deny (RESERVED_TOOL_NAMES minus StructuredOutput carve-out).
    for (const name of policy.allow ?? []) expect(policy.deny.has(name)).toBe(false);
  });

  it("a late-registered bash at a simulated turn boundary is stripped by the captured enforcer, and reported", async () => {
    const clock = new FakeClock();
    const captured: {
      spec?: SessionSpec & {
        toolScope?: { policy: unknown; enforcer: { onTurnBoundary: (h: ScopeSessionHandle, p: unknown) => unknown } };
      };
    } = {};
    const driver = captureDriver(captured as { spec?: SessionSpec });
    const runner = buildAdapter(clock, { driver });
    await runnerRun(runner, spec(tidyType()), clock);
    const { policy, enforcer } = captured.spec!.toolScope!;
    let active = [...CONSULT_READONLY_TOOLS, "bash"];
    const fake: ScopeSessionHandle = {
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const decision = enforcer.onTurnBoundary(fake, policy as never) as {
      applied: string[];
      blockedNewcomers: string[];
    };
    expect(decision.applied).not.toContain("bash");
    expect(decision.blockedNewcomers).toContain("bash");
    expect(active).not.toContain("bash");
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("bash"))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("runtime-adapter: readonly tool domain — N4 injection/authorization under the widest preconditions", () => {
  function widestDeps(driver: SessionDriver): Partial<RuntimeAdapterDeps> & { driver: SessionDriver } {
    const fabricRouter = { admit: () => ({ ok: true }) } as never;
    return {
      driver,
      fabric: { router: fabricRouter },
      childBashJobsEnabled: true,
      childSwitchContextGrant: () => true,
      nestedSpawn: () => ({
        spawn: async () => ({ runId: "c" }),
        spawnAndWait: async () => {
          throw new Error("x");
        },
      }),
      consult: vi.fn(() => ({ name: "consult" }) as never),
      consultResolveExperts: vi.fn(),
    };
  }

  it("readonly-domain run: H2-observed sessionSpec.tools and final tools/policy exclude every write/injected reserved tool", async () => {
    const clock = new FakeClock();
    const h2Seen: { tools?: string[] } = {};
    const captured: { spec?: SessionSpec & { toolScope?: { policy: { allow?: Set<string>; deny: Set<string> } } } } =
      {};
    const driver = captureDriver(captured as { spec?: SessionSpec });
    const runner = buildAdapter(clock, {
      ...widestDeps(driver),
      extensions: [
        {
          resolveSessionSpec: (s) => {
            h2Seen.tools = s.tools ? [...s.tools] : undefined;
            return s;
          },
        },
      ],
    });
    await runnerRun(
      runner,
      spec(tidyType(["read", "bash", "edit", "write", "memory"]), {
        schema: { type: "object" },
        consultExperts: [{ runId: "r_E", sessionFile: "/s/e.jsonl", agentType: "Plan" }],
      }),
      clock,
    );
    const reservedInjected = ["bash_job", "switch_context", "set_model", "message_agent", "Agent", "consult"];
    // ① H2's own input reflects grantedReserved's observable surface (the six
    // injected reserved names) — bash/edit/write/memory are the TYPE's own
    // declared tools and are legitimately still visible to H2 at this point;
    // it is the POST-H2 forcing (checked below) that narrows them away.
    for (const name of reservedInjected) {
      expect(h2Seen.tools ?? []).not.toContain(name);
    }
    // ② the final tools/policy exclude every write/injected reserved tool.
    for (const name of [...reservedInjected, "bash", "edit", "write", "memory"]) {
      expect(captured.spec!.tools ?? []).not.toContain(name);
      expect(captured.spec!.toolScope!.policy.allow?.has(name) ?? false).toBe(false);
    }
    expect(toolNames(captured.spec!)).toEqual(["StructuredOutput"]);
  });

  it("control group: the SAME preconditions without toolDomain grant bash_job and switch_context (proves the preconditions are sufficient)", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, widestDeps(driver));
    const type = tidyType(["read", "bash", "edit", "write", "memory"]);
    await runnerRun(
      runner,
      { runId: "r1", type, request: { type: type.name, prompt: "do the task" }, budget: fastBudget() },
      clock,
    );
    expect(captured.spec!.tools).toContain("bash_job");
    expect(captured.spec!.tools).toContain("switch_context");
  });
});

describe("runtime-adapter: readonly tool domain — N5 end-to-end write-blocked", () => {
  function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  /** Mirrors pi's `prepareToolCall`: look the name up in the effective active
   *  set; a miss returns "Tool <name> not found" and the action never runs. */
  function simulateToolCall(effectiveNames: ReadonlySet<string>, name: string, act: () => void): string {
    if (!effectiveNames.has(name)) return `Tool ${name} not found`;
    act();
    return "ok";
  }

  it("bash/write/edit/memory are all unreachable; the memory fixture is untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readonly-domain-"));
    const target = join(dir, "pitfalls.md");
    writeFileSync(target, "original content\n");
    const before = sha256(target);
    try {
      const clock = new FakeClock();
      const captured: { spec?: SessionSpec } = {};
      const driver = captureDriver(captured);
      const runner = buildAdapter(clock, {
        driver,
        childBashJobsEnabled: true,
        nestedSpawn: () => ({
          spawn: async () => ({ runId: "c" }),
          spawnAndWait: async () => {
            throw new Error("x");
          },
        }),
      });
      await runnerRun(
        runner,
        spec(tidyType(["read", "bash", "edit", "write", "memory"]), { schema: { type: "object" } }),
        clock,
      );
      const effective = new Set<string>([...(captured.spec!.tools ?? []), ...toolNames(captured.spec!)]);
      for (const name of ["bash", "write", "edit", "memory"]) {
        const result = simulateToolCall(effective, name, () => writeFileSync(target, "TAMPERED"));
        expect(result).toBe(`Tool ${name} not found`);
      }
      expect(sha256(target)).toBe(before);
      // Control: the simulator is not vacuous — a name that IS present actually runs.
      let ran = false;
      expect(simulateToolCall(effective, "StructuredOutput", () => (ran = true))).toBe("ok");
      expect(ran).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
