import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeliveryPayload, RunSnapshot, SessionSpec } from "../../src/core/types.js";
import { SCHEMA_PRESETS } from "../../src/core/verdict-schema.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

/**
 * Runtime adapter diag instrumentation: dispatchMeta/schemaPreset via displayMeta
 * (the consult experts/consultOf parts are retired — #40 PS1a), and the
 * notification textPreview switch to renderStructuredForHost.
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

async function drain(clock: FakeClock, ticks = 12, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

const workerType: AgentTypeConfig = { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };

function spec(overrides: Partial<RunnerSpec["request"]> = {}, runId = "r1"): RunnerSpec {
  return { runId, type: workerType, request: { type: "worker", prompt: "do it", ...overrides }, budget: fastBudget() };
}

const META = { lane: "L2" as const, packageId: "pkg-2026-10-08-a" };

describe("runtime-adapter: diag instrumentation (dispatchMeta / schemaPreset) and retired consult inputs (#40)", () => {
  function plainDriver(captured: { spec?: SessionSpec; resumed?: boolean } = {}): SessionDriver {
    return {
      create: async (s) => {
        captured.spec = s;
        return handle();
      },
      resume: async (_file, s) => {
        captured.spec = s;
        captured.resumed = true;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
  }

  it("folds dispatchMeta and schemaPreset into diag", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const runner = buildAdapter(clock, { driver: plainDriver(), store });
    await runner.run(spec({ dispatchMeta: META, schemaPreset: "verdict/v1" }));
    const diag = store.get("r1")?.diag;
    expect(diag?.dispatchMeta).toEqual(META);
    expect(diag?.schemaPreset).toBe("verdict/v1");
  });

  it("a readonly-domain run still folds dispatchMeta into diag", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const runner = buildAdapter(clock, { driver: plainDriver(), store });
    await runner.run(spec({ toolDomain: "readonly", dispatchMeta: META }));
    expect(store.get("r1")?.diag.dispatchMeta).toEqual(META);
  });

  it("runs without any new request fields produce a diag with none of the new keys (zero-change when absent)", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const runner = buildAdapter(clock, { driver: plainDriver(), store });
    await runner.run(spec());
    const diag = store.get("r1")?.diag;
    for (const key of ["dispatchMeta", "schemaPreset"]) expect(diag).not.toHaveProperty(key);
  });
});

describe("runtime-adapter: notification textPreview via renderStructuredForHost (P1b ③)", () => {
  function captureNotifier() {
    const enqueued: DeliveryPayload[] = [];
    const finalized: Array<{ runId: string; generation: number; patch: Partial<DeliveryPayload> }> = [];
    const captured = {
      ...notifier,
      enqueue: (payload: DeliveryPayload) => enqueued.push(payload),
      finalize: (runId: string, generation: number, patch: Partial<DeliveryPayload>) => {
        finalized.push({ runId, generation, patch });
        return "sent" as const;
      },
    };
    return { captured, enqueued, finalized };
  }

  const verdict = {
    verdict: "conditional_pass" as const,
    blockers: 1,
    findings: [{ severity: "blocker" as const, summary: "missing test" }],
    report: "## 验收报告\nmatrix here",
    packageId: "pkg-2026-10-08-a",
  };

  function schemaDriver(): SessionDriver {
    return {
      create: async (s: SessionSpec) => {
        const tool = (
          s.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> | undefined
        )?.find((t) => t.name === "StructuredOutput");
        return handle({
          prompt: async () => {
            await tool!.execute("tc", verdict, undefined, undefined, {});
          },
        });
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
  }

  it("renders a verdict/v1 structuredResult as report + one verdict line; structuredPreview stays raw JSON", async () => {
    const clock = new FakeClock();
    const capture = captureNotifier();
    const runner = buildAdapter(clock, {
      driver: schemaDriver(),
      notifier: capture.captured,
      store: new MemoryRunStore(),
    });
    const outcome = await runner.run(
      spec({ schema: SCHEMA_PRESETS["verdict/v1"], schemaPreset: "verdict/v1", dispatchMeta: META }),
    );
    expect(outcome.structuredResult).toEqual(verdict);
    expect(capture.finalized).toHaveLength(1);
    expect(capture.finalized[0]!.patch.textPreview).toBe(
      "## 验收报告\nmatrix here\n\nverdict: conditional_pass · blockers 1 · findings 1",
    );
    expect(capture.finalized[0]!.patch.structuredPreview).toBe(JSON.stringify(verdict));
  });

  it("a plain (non-preset) schema still stringifies the structuredResult for textPreview", async () => {
    const clock = new FakeClock();
    const capture = captureNotifier();
    const runner = buildAdapter(clock, {
      driver: schemaDriver(),
      notifier: capture.captured,
      store: new MemoryRunStore(),
    });
    const outcome = await runner.run(
      spec({ schema: { type: "object", required: ["report"], properties: { report: { type: "string" } } } }),
    );
    expect(outcome.structuredResult).toEqual(verdict);
    expect(capture.finalized[0]!.patch.textPreview).toBe(JSON.stringify(verdict));
  });

  it("a verdict preset whose payload fails validation never reaches the renderer (run fails(schema) instead)", async () => {
    const clock = new FakeClock();
    const capture = captureNotifier();
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        const tool = (
          s.customTools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> | undefined
        )?.find((t) => t.name === "StructuredOutput");
        return handle({
          prompt: async () => {
            // missing `report` — rejected by the tool, so nothing is captured
            await tool!.execute("tc", { verdict: "pass", blockers: 0, findings: [] }, undefined, undefined, {});
          },
        });
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, notifier: capture.captured, store: new MemoryRunStore() });
    const outcome = await runner.run(spec({ schema: SCHEMA_PRESETS["verdict/v1"], schemaPreset: "verdict/v1" }));
    expect(outcome.status).toBe("failed");
    // failed(schema) runs preview the last assistant text — the verdict
    // renderer is never reached (no structuredResult was captured).
    expect(capture.finalized[0]!.patch.textPreview).toBe("hello");
    expect(capture.finalized[0]!.patch).not.toHaveProperty("structuredPreview");
  });
});

/** Unused-variable guard for the shared snapshot type import some suites lean on. */
void (null as unknown as RunSnapshot | undefined);
