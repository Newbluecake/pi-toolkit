import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
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
    finalize: () => "missing" as const,
    settleBatch: () => undefined,
    ack: () => false,
    peek: () => undefined,
    ackedSuppressions: 0,
    dispose: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
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

describe("Fast request to actual driver SessionSpec", () => {
  it.each([undefined, "inherit", "on", "off"] as const)(
    "explicitly threads seed %s without prompt notes",
    async (mode) => {
      const clock = new FakeClock();
      let created: import("../../src/core/types.js").SessionSpec | undefined;
      let h2Seed: unknown;
      const driver: SessionDriver = {
        create: async (s) => {
          created = s;
          return handle();
        },
        bind: async () => {},
        onLateArrival() {},
      };
      const { runner } = buildAdapter(clock, driver, [
        {
          resolveSessionSpec: (s) => {
            h2Seed = s.fastSeed;
            return { ...s, promptNotes: ["unchanged note"] };
          },
        },
      ]);
      const p = runner.run(
        spec({ request: { type: "worker", prompt: "hi", ...(mode ? { fastSeed: { v: 1, mode } } : {}) } }),
      );
      await drain(clock, 30);
      expect((await p).status).toBe("completed");
      expect(created).toBeDefined();
      if (mode) {
        expect(created!.fastSeed).toEqual({ v: 1, mode });
        expect(h2Seed).toEqual({ v: 1, mode });
      } else {
        expect(Object.hasOwn(created!, "fastSeed")).toBe(false);
        expect(h2Seed).toBeUndefined();
      }
      expect(created!.prompt).toBe("hi\n\nunchanged note");
      expect(Object.hasOwn(created!, "promptNotes")).toBe(false);
    },
  );
  it("never forwards a pi Fast seed into external droid options/transcript", async () => {
    const clock = new FakeClock();
    let created: import("../../src/core/types.js").SessionSpec | undefined;
    const driver: SessionDriver = {
      create: async (s) => {
        created = s;
        return handle();
      },
      bind: async () => {},
      onLateArrival() {},
    };
    const planned: unknown[] = [];
    const external: import("../../src/external-agent/types.js").ExternalAgentsPort = {
      owns: (p) => p === "droid",
      exists: () => true,
      unavailableReason: () => undefined,
      unknownModelMessage: () => "unknown",
      advertised: () => [],
      ownerOfSessionFile: () => undefined,
      planRun: (i) => {
        planned.push(i);
        return {
          provider: "droid",
          modelId: "offline",
          roleName: "worker",
          contextBlocks: [],
          persistTranscript: false,
          runId: "r1",
          pricing: { status: "unpriced", reason: "no_match" },
          degraded: [],
        };
      },
      pricingFor: () => ({ status: "unpriced", reason: "no_match" }),
      dispose() {},
    };
    const { runner } = buildAdapter(clock, driver, [], { external });
    const p = runner.run(
      spec({
        model: { provider: "droid", id: "offline" },
        request: { type: "worker", prompt: "hi", fastSeed: { v: 1, mode: "on" } },
      }),
    );
    await drain(clock, 30);
    expect((await p).status).toBe("completed");
    expect(Object.hasOwn(created!, "fastSeed")).toBe(false);
    expect(created!.external?.provider).toBe("droid");
    expect(planned).toHaveLength(1);
    expect(JSON.stringify(planned)).not.toContain("fastSeed");
  });
});
