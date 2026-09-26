import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { appendPromptNotes, createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 50,
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
function buildAdapter(
  clock: FakeClock,
  driver: SessionDriver,
  extensions: SubagentExtensionPoints[],
  extra: Partial<Parameters<typeof createRuntimeRunnerAdapter>[0]> = {},
) {
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const notifier = {
    enqueue: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
  };
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    extensions,
    ...extra,
  });
  return { runner, pool, store };
}
function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return { runId: "r1", type, request: { type: "worker", prompt: "hi" }, budget: fastBudget(), ...overrides };
}
async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("appendPromptNotes (pure function boundary cases)", () => {
  it("undefined/empty notes return the SAME string reference (byte-identical, no allocation)", () => {
    const prompt = "the task prompt";
    expect(appendPromptNotes(prompt)).toBe(prompt);
    expect(appendPromptNotes(prompt, [])).toBe(prompt);
  });

  it("joins multiple notes with a blank line, appended after a blank line", () => {
    expect(appendPromptNotes("base", ["note one", "note two"])).toBe("base\n\nnote one\n\nnote two");
  });
});

describe("runtime-adapter: promptNotes -> prompt (workflow-worktree plan D9, v2.1 condition 4)", () => {
  it("appends the note to the actual handle.prompt() bytes when H2 sets SessionSpec.promptNotes", async () => {
    const clock = new FakeClock();
    let createArgs: unknown;
    let promptedWith: string | undefined;
    const driver: SessionDriver = {
      create: async (s) => {
        createArgs = s;
        return handle({ prompt: async (text) => void (promptedWith = text) });
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: (s) => ({ ...s, cwd: "/worktrees/r1", promptNotes: ["Worktree isolation note: READ-ONLY."] }),
    };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 30);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    // the driver never sees a `promptNotes` key at all
    expect(Object.keys(createArgs as object)).not.toContain("promptNotes");
    expect((createArgs as { prompt?: string }).prompt).toBe("hi\n\nWorktree isolation note: READ-ONLY.");
    // plan §6 test #5: the bytes the model actually receives
    expect(promptedWith).toBe("hi\n\nWorktree isolation note: READ-ONLY.");
  });

  it("appends the note for prompt_mode:append types (systemPrompt prefix preserved, note appended last)", async () => {
    const clock = new FakeClock();
    let createArgs: unknown;
    const appendType: AgentTypeConfig = { ...type, systemPrompt: "You are a worker.", promptMode: "append" };
    const driver: SessionDriver = {
      create: async (s) => ((createArgs = s), handle()),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = { resolveSessionSpec: (s) => ({ ...s, promptNotes: ["note"] }) };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec({ type: appendType }));
    await drain(clock, 30);
    await p;
    expect((createArgs as { prompt?: string }).prompt).toBe("You are a worker.\n\nhi\n\nnote");
  });

  it("appends the note for prompt_mode:replace types too (systemPrompt travels separately, task prompt still gets the note)", async () => {
    const clock = new FakeClock();
    let createArgs: unknown;
    const replaceType: AgentTypeConfig = { ...type, systemPrompt: "REPLACED PROMPT", promptMode: "replace" };
    const driver: SessionDriver = {
      create: async (s) => ((createArgs = s), handle()),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = { resolveSessionSpec: (s) => ({ ...s, promptNotes: ["note"] }) };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec({ type: replaceType }));
    await drain(clock, 30);
    await p;
    expect((createArgs as { systemPrompt?: string }).systemPrompt).toBe("REPLACED PROMPT");
    expect((createArgs as { prompt?: string }).prompt).toBe("hi\n\nnote");
  });

  it("resume also gets the note appended (the convention is still in effect on a continuation)", async () => {
    const clock = new FakeClock();
    let resumeArgs: unknown;
    const driver: SessionDriver = {
      create: async () => handle(),
      resume: async (_sessionFile, s) => ((resumeArgs = s), handle()),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = { resolveSessionSpec: (s) => ({ ...s, promptNotes: ["note"] }) };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec({ request: { type: "worker", prompt: "continue", resumeFrom: "/tmp/x.jsonl" } }));
    await drain(clock, 30);
    await p;
    expect((resumeArgs as { prompt?: string } | undefined)?.prompt).toBe("continue\n\nnote");
  });

  it("linkPaths=[] (no promptNotes at all) leaves the prompt byte-identical to buildPrompt(spec)", async () => {
    const clock = new FakeClock();
    let createArgs: unknown;
    const driver: SessionDriver = {
      create: async (s) => ((createArgs = s), handle()),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { runner } = buildAdapter(clock, driver, []); // no extensions at all ⇒ no H2, no promptNotes
    const p = runner.run(spec());
    await drain(clock, 30);
    await p;
    expect((createArgs as { prompt?: string }).prompt).toBe("hi");
  });

  it("a consult run's prompt is the raw question, never gets a note appended even if H2 sets one", async () => {
    const clock = new FakeClock();
    let createArgs: unknown;
    const driver: SessionDriver = {
      create: async (s) => ((createArgs = s), handle()),
      resume: async (_sessionFile, s) => ((createArgs = s), handle()),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = { resolveSessionSpec: (s) => ({ ...s, promptNotes: ["note"] }) };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(
      spec({ request: { type: "worker", prompt: "consult question", forkSessionFrom: "/tmp/f.jsonl" } }),
    );
    await drain(clock, 30);
    await p;
    expect((createArgs as { prompt?: string }).prompt).toBe("consult question");
  });
});
