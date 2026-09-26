import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import { RESERVED_TOOL_NAMES } from "../../src/runtime/tool-scope.js";

/**
 * child-context-switch plan.md §4/§7 (P3, T-S9): `childSwitchContextGrant` — switch_context is
 * granted to every non-consult child run when the wiring layer's live capability read says yes,
 * and merged into `sessionSpec.tools` for agent types that declare an allowlist (M1 rescue, same
 * mechanism `bash_job`/`Agent`/`set_model` already use).
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
  return { runId: "r1", type, request: { type: type.name, prompt: "hi", ...overrides }, budget: fastBudget() };
}

const readonlyType: AgentTypeConfig = {
  name: "explore",
  description: "x",
  systemPrompt: "",
  promptMode: "append",
  tools: ["read", "grep"],
};
const unrestrictedType: AgentTypeConfig = { name: "general", description: "x", systemPrompt: "", promptMode: "append" };

describe("RESERVED_TOOL_NAMES", () => {
  it("includes switch_context (T-S11: unconditional reservation, known & accepted difference)", () => {
    expect(RESERVED_TOOL_NAMES).toContain("switch_context");
  });
});

describe("runtime-adapter childSwitchContextGrant (T-S9)", () => {
  it("merges switch_context into sessionSpec.tools for an allow-listed agent type when granted", async () => {
    const clock = new FakeClock();
    let captured: SessionSpec | undefined;
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        captured = s;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, childSwitchContextGrant: () => true });
    const p = runner.run(spec(readonlyType));
    await drain(clock, 10);
    await p;
    expect(captured?.tools).toContain("switch_context");
  });

  it("does not grant when childSwitchContextGrant returns false", async () => {
    const clock = new FakeClock();
    let captured: SessionSpec | undefined;
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        captured = s;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, childSwitchContextGrant: () => false });
    const p = runner.run(spec(readonlyType));
    await drain(clock, 10);
    await p;
    expect(captured?.tools).not.toContain("switch_context");
  });

  it("does not grant when childSwitchContextGrant is absent (feature never wired)", async () => {
    const clock = new FakeClock();
    let captured: SessionSpec | undefined;
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        captured = s;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver });
    const p = runner.run(spec(unrestrictedType));
    await drain(clock, 10);
    await p;
    expect(captured?.tools).toBeUndefined(); // unrestricted type: no allowlist to merge into either way
  });

  it("a consult run (forkSessionFrom set) never gets switch_context, even when granted returns true", async () => {
    const clock = new FakeClock();
    let captured: SessionSpec | undefined;
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        captured = s;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, childSwitchContextGrant: () => true });
    const p = runner.run(spec(readonlyType, { forkSessionFrom: "/tmp/some-session.jsonl" }));
    await drain(clock, 10);
    await p;
    // Consult forces the read-only tool domain unconditionally (CONSULT_READONLY_TOOLS) — whether
    // or not `driver.create` was ever reached with a captured spec, switch_context must not
    // appear in it (this mirrors the existing `!isConsultRun` guard every other grant uses).
    expect(captured?.tools ?? []).not.toContain("switch_context");
  });
});
