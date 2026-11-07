import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import type { MemoryBindRequest } from "../../src/memory/scopes/child-bind.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";

// Real runner + production driver, with ONLY SDK construction held pending.
const sdkFixture = vi.hoisted(() => ({
  pending: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
  buses: [] as Array<{
    emit: (name: string, value: unknown) => void;
    on: (name: string, listener: () => void) => unknown;
  }>,
  probe: vi.fn(),
  bind: vi.fn(),
  dispose: vi.fn(),
  prompt: vi.fn(async () => {}),
  receiverDispose: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../src/secure/domain.js", () => ({
  secureChildSessionDir: () => undefined,
  assertSessionFileInDomain: () => undefined,
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  const manager = () => ({ appendCustomEntry() {}, getBranch: () => [], getCwd: () => "/isolated" });
  return {
    ...sdk,
    SettingsManager: { create: () => ({}) },
    getAgentDir: () => "/isolated/agent",
    SessionManager: { create: manager, inMemory: manager, open: manager },
    DefaultResourceLoader: class {
      constructor(readonly options: { eventBus?: ReturnType<typeof sdk.createEventBus> }) {}
      async reload() {
        const bus = this.options.eventBus;
        if (!bus) return;
        sdkFixture.buses.push(bus);
        bus.on("probe", sdkFixture.probe);
        bus.on("subagent:memory-bind", (value) => {
          sdkFixture.bind(value);
          (value as MemoryBindRequest).reply({
            v: 1,
            wired: true,
            dispose: sdkFixture.receiverDispose,
          });
        });
      }
    },
    createAgentSession: vi.fn((options: Record<string, unknown>) => {
      sdkFixture.options.push(options);
      const bus = sdkFixture.buses.at(-1);
      return new Promise((resolve, reject) => {
        sdkFixture.pending.push({
          reject,
          resolve: () => {
            // SDK extensions may install listeners even after cancellation. Driver's
            // repeated cleanup must clear those too, without emitting FastBind.
            bus?.on("late-probe", sdkFixture.probe);
            resolve({
              session: {
                sessionId: "sdk-session",
                sessionFile: undefined,
                dispose: sdkFixture.dispose,
                prompt: sdkFixture.prompt,
                abort: async () => {},
                subscribe: () => () => {},
              },
            });
          },
        });
      });
    }),
  };
});
import { PiSessionDriver, type SessionDriver } from "../../src/runtime/session-driver.js";

const budget = { ...DEFAULT_BUDGET, startupMs: 100, totalMs: 1000, totalGraceMs: 0, abortGraceMs: 5, reapMs: 5 };
const drain = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

function harness(driver: SessionDriver, beforeReap?: RunnerDeps["beforeReap"]) {
  const clock = new FakeClock();
  const pool = new SingleSlotPool(clock, 1);
  const reaper = new EscalatingReaper(clock);
  const late = vi.spyOn(reaper, "disposeLate");
  let runner!: RuntimeRunner;
  const watchdog = new EventWatchdog({
    clock,
    budget,
    tickMs: 10,
    getState: (id, gen) => runner.getRunState(id, gen),
    dispatch: (id, gen, input) => {
      if (input.kind === "deadline_fired") runner.fireDeadline(id, gen, input);
    },
  });
  runner = new RuntimeRunner({
    clock,
    driver,
    memoryBindingEnabled: true,
    pool,
    reaper,
    watchdog,
    ...(beforeReap ? { beforeReap } : {}),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
  });
  const deadline = vi.spyOn(runner, "fireDeadline");
  return { runner, clock, pool, late, watchdog, deadline };
}
beforeEach(() => {
  vi.clearAllMocks();
  sdkFixture.pending = [];
  sdkFixture.buses = [];
  sdkFixture.options = [];
});

describe("memory-only internal cancellation during pending SDK create", () => {
  for (const resume of [false, true]) {
    it.each(["abort", "watchdog"] as const)(`${resume ? "resume" : "create"}/%s`, async (cancelBy) => {
      const driver = new PiSessionDriver(true, undefined, undefined, undefined, undefined, { strict: true });
      const create = vi.spyOn(driver, "create");
      const open = vi.spyOn(driver, "resume");
      const h = harness(driver);
      const external = new AbortController();
      const req: ResolvedSpawnRequest = {
        runId: "child",
        prompt: "never prompt",
        signal: external.signal,
        ...(resume ? { resumeFrom: "owned-file" } : {}),
      };
      const run = h.runner.run(req, budget);
      await drain();
      expect(sdkFixture.pending).toHaveLength(1);
      const forwarded = (resume ? open.mock.calls[0]![1] : create.mock.calls[0]![0]) as ResolvedSpawnRequest;
      expect(forwarded).not.toBe(req);
      expect(forwarded.signal).not.toBe(external.signal);
      expect(Object.hasOwn(sdkFixture.options[0]!, "signal")).toBe(false);
      const bus = sdkFixture.buses[0]!;
      bus.emit("probe", 1);
      expect(sdkFixture.probe).toHaveBeenCalledTimes(1);
      const cancellation = cancelBy === "abort" ? h.runner.abortRun("child") : undefined;
      if (cancelBy === "watchdog") {
        h.watchdog.arm("child", 1);
        h.clock.advance(100);
      }
      expect(forwarded.signal?.aborted).toBe(true);
      expect(external.signal.aborted).toBe(false);
      bus.emit("probe", 2);
      expect(sdkFixture.probe).toHaveBeenCalledTimes(1);
      if (cancellation) await cancellation;
      await run;
      expect(h.pool.stats.inUse).toBe(0);
      sdkFixture.pending[0]!.resolve();
      await drain();
      expect(sdkFixture.dispose).toHaveBeenCalledTimes(1);
      expect(sdkFixture.bind).not.toHaveBeenCalled();
      expect(sdkFixture.receiverDispose).not.toHaveBeenCalled();
      expect(sdkFixture.prompt).not.toHaveBeenCalled();
      bus.emit("late-probe", 3);
      expect(sdkFixture.probe).toHaveBeenCalledTimes(1);
      expect(h.clock.pendingTimers).toBe(0);
    });
  }
});

import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { RunnerSpec } from "../../src/service/ports.js";

describe("actual adapter -> Runner -> memory-only driver internal cancellation", () => {
  it.each(["abort", "watchdog"] as const)("%s cannot bind late SDK or recover poison", async (cancelBy) => {
    const clock = new FakeClock(),
      pool = new SingleSlotPool(clock, 1),
      store = new MemoryRunStore();
    const reaper = new EscalatingReaper(clock);
    const driver = new PiSessionDriver(false, undefined, undefined, undefined, undefined, { strict: true });
    const create = vi.spyOn(driver, "create");
    let adapter: ReturnType<typeof createRuntimeRunnerAdapter>;
    const watchdog = new EventWatchdog({
      clock,
      budget,
      tickMs: 10,
      getState: (id, gen) => adapter.getRunState?.(id, gen),
      dispatch: (id, gen, input) => {
        if (input.kind === "deadline_fired") adapter.fireDeadline?.(id, gen, input);
      },
    });
    const notifier = {
      enqueue() {},
      finalize: () => "missing" as const,
      settleBatch() {},
      ack: () => false,
      peek: () => undefined,
      ackedSuppressions: 0,
      dispose() {},
      consume: () => false,
      reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
      verifyPersisted: () => ({ missing: [] }),
      stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      degraded: [],
    };
    adapter = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store,
      watchdog,
      reaper,
      notifier,
      memoryBindingEnabled: true,
    });
    const external = new AbortController();
    const spec: RunnerSpec = {
      runId: "adapter-child",
      type: { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" },
      request: { type: "worker", prompt: "never prompt", signal: external.signal },
      budget,
    };
    const run = adapter.run(spec);
    // Adapter normalizes a pending-startup abort separately; observe result without an unhandled rejection.
    const settled = run.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await drain();
    expect(sdkFixture.pending).toHaveLength(1);
    const internal = (create.mock.calls[0]![0] as ResolvedSpawnRequest).signal!;
    expect(internal).toBeInstanceOf(AbortSignal);
    expect(internal).not.toBe(external.signal);
    const bus = sdkFixture.buses[0]!;
    bus.emit("probe", 1);
    const cancellation = cancelBy === "abort" ? adapter.abort?.("adapter-child") : undefined;
    if (cancelBy === "watchdog") {
      watchdog.arm("adapter-child", 1);
      clock.advance(100);
    }
    expect(internal.aborted).toBe(true);
    expect(external.signal.aborted).toBe(false);
    bus.emit("probe", 2);
    expect(sdkFixture.probe).toHaveBeenCalledTimes(1);
    if (cancellation) await cancellation;
    await settled;
    sdkFixture.pending[0]!.resolve();
    await drain();
    expect(sdkFixture.bind).not.toHaveBeenCalled();
    expect(sdkFixture.dispose).toHaveBeenCalledTimes(1);
    expect(sdkFixture.prompt).not.toHaveBeenCalled();
    expect(pool.stats.inUse).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });
});
