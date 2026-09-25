import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunDiagnostics, RunSnapshot, SessionSpec } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { CONSULT_READONLY_TOOLS } from "../../src/runtime/tool-scope.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

/**
 * consult plan §9 T-12: the read-only tool domain for consult runs
 * (`forkSessionFrom !== undefined`) — pi-level `tools` forced to
 * CONSULT_READONLY_TOOLS after H2, toolScope policy from the same constant,
 * every injected tool skipped, prompt without the agent-type prefix — plus
 * the consult-tool injection for whitelisted runs, the early-exit onReaped
 * path (§4.4) and the displayMeta consultOf marker (§6 C-12).
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

/** Captures everything the driver sees, in both create() and resume() (package-B-proof). */
function captureDriver(captured: {
  spec?: SessionSpec & { toolScope?: unknown; displayMeta?: unknown };
}): SessionDriver {
  const capture = (s: SessionSpec) => {
    captured.spec = s as typeof captured.spec;
    return handle();
  };
  const resume = async (_sessionFile: string, s: SessionSpec) => capture(s);
  return { create: capture, resume, bind: async () => undefined, onLateArrival: () => undefined };
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
    request: { type: type.name, prompt: "the question", ...overrides },
    budget: fastBudget(),
  };
}

const expertType = (tools?: string[]): AgentTypeConfig => ({
  name: "explorer",
  description: "x",
  systemPrompt: "You are the explorer. Do the full task with bash.",
  promptMode: "append",
  ...(tools !== undefined ? { tools } : {}),
  canSpawn: ["worker"],
});

const consultRequest = {
  prompt: "[consult] You are being consulted…",
  forkSessionFrom: "/cache/consult-sessions/fork-1.jsonl",
  // Carried deliberately: the guard must be explicit, not premised on its
  // absence (review-2 #13).
  consultExperts: [{ runId: "r_E", sessionFile: "/s/e.jsonl", agentType: "explorer" }],
  schema: { type: "object" },
};

const toolNames = (spec: { customTools?: unknown[] }): string[] =>
  (spec.customTools ?? []).map((t) => (t as { name?: string }).name ?? "?");

describe("runtime-adapter: consult run read-only domain (T-12)", () => {
  it.each([
    ["type tools undefined", undefined],
    ["type tools bash/write", ["bash", "write"]],
  ] as const)("forces the read-only four after H2 (%s)", async (label, tools) => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec & { toolScope?: unknown } } = {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, {
      driver,
      extensions: [
        // H2 tries to widen the tool set — must be overridden for consult runs.
        {
          resolveSessionSpec: async (s) => ({ ...s, tools: ["bash", "edit", "write"], extra: true }),
        },
      ],
    });
    const p = runner.run(spec(expertType(tools), consultRequest));
    await drain(clock, 12);
    await p;
    expect(label).toBeTruthy();
    expect(captured.spec!.tools).toEqual([...CONSULT_READONLY_TOOLS]);
  });

  it("skips every injected tool: no Agent/message_agent/StructuredOutput/set_model/consult", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const fabricRouter = { admit: () => ({ ok: true }) } as never;
    const consultFactory = vi.fn(() => ({ name: "consult" }) as unknown as ToolDefinition);
    const runner = buildAdapter(clock, {
      driver,
      fabric: { router: fabricRouter },
      nestedSpawn: () => ({
        spawn: async () => ({ runId: "c" }),
        spawnAndWait: async () => {
          throw new Error("x");
        },
      }),
      consult: consultFactory,
    });
    const p = runner.run(spec(expertType(), consultRequest));
    await drain(clock, 12);
    await p;
    const names = toolNames(captured.spec!);
    for (const forbidden of ["Agent", "message_agent", "StructuredOutput", "set_model", "consult"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toEqual([]); // nothing at all is injected into a consult run
    expect(consultFactory).not.toHaveBeenCalled();
  });

  it("builds the toolScope policy from the same constant with no grants", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec & { toolScope?: { policy?: { allow?: Set<string>; deny?: Set<string> } } } } =
      {};
    const driver = captureDriver(captured);
    const runner = buildAdapter(clock, { driver });
    const p = runner.run(spec(expertType(), consultRequest));
    await drain(clock, 12);
    await p;
    const policy = captured.spec!.toolScope!.policy!;
    expect([...policy.allow!].sort()).toEqual([...CONSULT_READONLY_TOOLS].sort());
    // deny keeps the full reserved set (consult included) since nothing is granted.
    expect(policy.deny!.has("consult")).toBe(true);
    expect(policy.deny!.has("Agent")).toBe(true);
  });

  it("bypasses the agent-type prompt prefix but keeps replace-mode systemPrompt", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const appendRunner = buildAdapter(clock, { driver });
    const p = runnerRun(appendRunner, spec(expertType(), consultRequest), clock);
    await p;
    expect(captured.spec!.prompt).toBe("[consult] You are being consulted…");
    expect(captured.spec!.prompt).not.toContain("You are the explorer");

    const replaceType: AgentTypeConfig = {
      ...expertType(),
      promptMode: "replace",
    };
    const captured2: { spec?: SessionSpec } = {};
    const driver2 = captureDriver(captured2);
    const replaceRunner = buildAdapter(clock, { driver: driver2 });
    const p2 = runnerRun(replaceRunner, spec(replaceType, consultRequest), clock);
    await p2;
    expect(captured2.spec!.systemPrompt).toBe("You are the explorer. Do the full task with bash.");
    expect(captured2.spec!.prompt).toBe("[consult] You are being consulted…");
  });

  it("marks displayMeta.consultOf with the asking run", async () => {
    const clock = new FakeClock();
    const captured: { spec?: { displayMeta?: { consultOf?: { askerRunId?: string } } } } = {};
    const driver = captureDriver(captured as { spec?: SessionSpec });
    const runner = buildAdapter(clock, { driver });
    const p = runner.run(spec(expertType(), { ...consultRequest, parentRunId: "r_ASKER" }));
    await drain(clock, 12);
    await p;
    expect(captured.spec!.displayMeta!.consultOf).toEqual({ askerRunId: "r_ASKER" });
  });

  it("folds the main-session sentinel type to `main` in displayMeta (§16.5), raw type for everyone else", async () => {
    const clock = new FakeClock();
    const captured: { spec?: { displayMeta?: { agentType?: unknown } } } = {};
    const driver = captureDriver(captured as { spec?: SessionSpec });
    const runner = buildAdapter(clock, { driver });
    // The spawn-side spec carries the RAW sentinel (admission compares it);
    // only the display-only metadata is folded.
    const mainType: AgentTypeConfig = { ...expertType(), name: "consult:main-snapshot" };
    const p = runner.run(spec(mainType, consultRequest));
    await drain(clock, 12);
    await p;
    expect(captured.spec!.displayMeta!.agentType).toBe("main");

    const captured2: { spec?: { displayMeta?: { agentType?: unknown } } } = {};
    const driver2 = captureDriver(captured2 as { spec?: SessionSpec });
    const runner2 = buildAdapter(clock, { driver: driver2 });
    const p2 = runner2.run(spec(expertType(), consultRequest));
    await drain(clock, 12);
    await p2;
    expect(captured2.spec!.displayMeta!.agentType).toBe("explorer");
  });
});

// Small wrapper so the replace-mode case above can drain too.
async function runnerRun(runner: ReturnType<typeof buildAdapter>, s: RunnerSpec, clock: FakeClock) {
  const p = runner.run(s);
  await drain(clock, 12);
  return p;
}

describe("runtime-adapter: contrast — a normal nested run is untouched", () => {
  it("keeps type tools, all injections and the prompt prefix", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec & { toolScope?: unknown } } = {};
    const driver = captureDriver(captured);
    const consultFactory = vi.fn(
      () => ({ name: "consult", execute: async () => ({ content: [] }) }) as unknown as ToolDefinition,
    );
    const runner = buildAdapter(clock, {
      driver,
      nestedSpawn: () => ({
        spawn: async () => ({ runId: "c" }),
        spawnAndWait: async () => {
          throw new Error("x");
        },
      }),
      consult: consultFactory,
    });
    const type = expertType(["read", "grep"]);
    const p = runner.run(
      spec(type, {
        prompt: "do the task",
        parentRunId: "r_ASKER",
        consultExperts: [{ runId: "r_E", sessionFile: "/s/e.jsonl", agentType: "explorer" }],
        schema: { type: "object" },
      }),
    );
    await drain(clock, 12);
    await p;
    const names = toolNames(captured.spec!);
    // M1 merge: consult joins the declared pi-level allowlist.
    expect(captured.spec!.tools).toContain("consult");
    expect(names).toContain("consult"); // injected for a whitelisted non-consult run
    expect(names).toContain("Agent");
    expect(names).toContain("set_model");
    expect(names).toContain("StructuredOutput");
    expect(captured.spec!.prompt).toBe("You are the explorer. Do the full task with bash.\n\ndo the task");
  });

  it("does not inject consult when the whitelist is empty or the factory declines", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const driver = captureDriver(captured);
    const consultFactory = vi.fn(() => undefined);
    const runner = buildAdapter(clock, { driver, consult: consultFactory });
    const p = runner.run(spec(expertType(), { prompt: "x", consultExperts: [] }));
    await drain(clock, 12);
    await p;
    expect(consultFactory).not.toHaveBeenCalled();
    expect(toolNames(captured.spec!)).not.toContain("consult");
    expect(captured.spec!.tools).toBeUndefined(); // type without tools stays unset
  });
});

describe("runtime-adapter: early-exit onReaped (§4.4)", () => {
  it("deadlineAt already expired ⇒ runner never runs; onReaped fires once with the fork path", async () => {
    const clock = new FakeClock(1000);
    const onReaped = vi.fn();
    const create = vi.fn(async () => handle());
    const driver: SessionDriver = { create, bind: async () => undefined, onLateArrival: () => undefined };
    const runner = buildAdapter(clock, { driver, onReaped });
    const outcome = await runner.run(spec(expertType(), { ...consultRequest, deadlineAt: 500 }));
    expect(outcome.status).toBe("failed");
    expect(create).not.toHaveBeenCalled();
    expect(onReaped).toHaveBeenCalledTimes(1);
    expect(onReaped).toHaveBeenCalledWith("r1", "/cache/consult-sessions/fork-1.jsonl");
  });

  it("H2 hook throwing ⇒ same early-exit cleanup", async () => {
    const clock = new FakeClock();
    const onReaped = vi.fn();
    const driver = captureDriver({});
    const runner = buildAdapter(clock, {
      driver,
      onReaped,
      extensions: [
        {
          resolveSessionSpec: async () => {
            throw new Error("worktree unavailable");
          },
        },
      ],
    });
    const outcome = await runner.run(spec(expertType(), consultRequest));
    expect(outcome.status).toBe("failed");
    expect(onReaped).toHaveBeenCalledTimes(1);
    expect(onReaped).toHaveBeenCalledWith("r1", "/cache/consult-sessions/fork-1.jsonl");
  });

  it("non-consult runs never trigger the adapter's onReaped on failure", async () => {
    const clock = new FakeClock(1000);
    const onReaped = vi.fn();
    const driver = captureDriver({});
    const runner = buildAdapter(clock, { driver, onReaped });
    const outcome = await runner.run(spec(expertType(), { deadlineAt: 500 })); // no forkSessionFrom
    expect(outcome.status).toBe("failed");
    expect(onReaped).not.toHaveBeenCalled();
  });

  it("a consult run that enters the runner is left to the runner's own onReaped (adapter stays silent)", async () => {
    const clock = new FakeClock();
    const onReaped = vi.fn();
    const driver = captureDriver({});
    const runner = buildAdapter(clock, { driver, onReaped });
    const outcome = await runnerRun(
      runner,
      spec(expertType(), {
        prompt: consultRequest.prompt,
        forkSessionFrom: consultRequest.forkSessionFrom,
        parentRunId: "r_ASKER",
      }),
      clock,
    );
    expect(outcome.status).toBe("completed");
    // With package B's runner this may be called by RunnerDeps.onReaped (the
    // passthrough) — the adapter's OWN contribution is zero, so at most one
    // call arrives, always with the fork path.
    for (const call of onReaped.mock.calls) {
      expect(call[0]).toBe("r1");
      expect(call[1]).toBe("/cache/consult-sessions/fork-1.jsonl");
    }
    expect(onReaped.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("forwards onReaped into RunnerDeps (spread passthrough, §6 C-12)", async () => {
    // Structural: build the adapter with onReaped and verify a run completes —
    // the field reaches the runner through runnerDeps without type error
    // (compile-time guarantee) and without affecting run outcome (runtime).
    const clock = new FakeClock();
    const driver = captureDriver({});
    const runner = buildAdapter(clock, { driver, onReaped: () => undefined });
    const outcome = await runnerRun(runner, spec(expertType(), consultRequest), clock);
    expect(["completed", "failed"]).toContain(outcome.status);
  });
});

/** Unused-import guard for the shared snapshot helper shape. */
export type { RunSnapshot, RunDiagnostics };
