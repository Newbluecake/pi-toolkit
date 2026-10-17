import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
 * consult A/B instrumentation plan (§5 P1b, tests): the runtime adapter's
 * share — diag experts/dispatchMeta/schemaPreset via displayMeta, the
 * readonly-domain/consult-fork exclusions, and the notification textPreview
 * switch to renderStructuredForHost.
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

const consultFactory = vi.fn(() => ({ name: "consult" }) as unknown as ToolDefinition);

const EXPERTS = [
  { runId: "r_E1", sessionFile: "/s/e1.jsonl", agentType: "explorer", label: "explorer" },
  { runId: "r_E2", sessionFile: "/s/e2.jsonl", agentType: "reviewer", kind: "main" as const, pending: true },
];

const META = { lane: "L2" as const, packageId: "pkg-2026-10-08-a", abArm: "experts" as const };

describe("runtime-adapter: consult A/B diag instrumentation (P1b)", () => {
  it("folds experts {refs, granted:true}, dispatchMeta and schemaPreset into diag when the consult tool is injected", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, store, consult: consultFactory });
    await runner.run(spec({ consultExperts: EXPERTS, dispatchMeta: META, schemaPreset: "verdict/v1" }));
    const diag = store.get("r1")?.diag;
    expect(diag?.experts).toEqual({
      refs: [
        { runId: "r_E1", label: "explorer", agentType: "explorer" },
        { runId: "r_E2", agentType: "reviewer", kind: "main", pending: true },
      ],
      granted: true,
    });
    expect(diag?.dispatchMeta).toEqual(META);
    expect(diag?.schemaPreset).toBe("verdict/v1");
    expect(consultFactory).toHaveBeenCalled();
  });

  it("mirrors the display-only consult marker into diag.consultOf (web fleet rows read it, never the label prefix)", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, store });
    await runner.run(spec({ forkSessionFrom: "/s/expert.jsonl", parentRunId: "r_asker" }));
    expect(store.get("r1")?.diag.consultOf).toEqual({ askerRunId: "r_asker" });
    // a plain run never carries the marker
    await runner.run(spec({}, "r2"));
    expect(store.get("r2")?.diag.consultOf).toBeUndefined();
  });

  it("records granted:false when the whitelist reached a non-readonly run but the consult tool was withheld (consult disabled)", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    // No `consult` dep — the wiring's disabled/inert shape.
    const runner = buildAdapter(clock, { driver, store });
    await runner.run(spec({ consultExperts: EXPERTS }));
    expect(store.get("r1")?.diag.experts).toEqual({
      refs: [
        { runId: "r_E1", label: "explorer", agentType: "explorer" },
        { runId: "r_E2", agentType: "reviewer", kind: "main", pending: true },
      ],
      granted: false,
    });
  });

  it("writes no experts key for a readonly-domain run even when consultExperts is (deliberately) carried", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, store, consult: consultFactory });
    await runner.run(spec({ toolDomain: "readonly", consultExperts: EXPERTS, dispatchMeta: META }));
    const diag = store.get("r1")?.diag;
    expect(diag).not.toHaveProperty("experts");
    // dispatchMeta still flows — readonly says nothing about enrollment meta.
    expect(diag?.dispatchMeta).toEqual(META);
  });

  it("writes no experts key for a consult fork (forkSessionFrom), and consultOf still marks it", async () => {
    const clock = new FakeClock();
    const captured: { spec?: SessionSpec } = {};
    const store = new MemoryRunStore();
    // A fork copy opens through the driver's resume seam (consult plan §4.4).
    const driver: SessionDriver = {
      create: async (s) => {
        captured.spec = s;
        return handle();
      },
      resume: async (_file, s) => {
        captured.spec = s;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, store, consult: consultFactory });
    await runner.run(
      spec({
        forkSessionFrom: "/cache/consult-sessions/fork-1.jsonl",
        parentRunId: "r_ASKER",
        consultExperts: EXPERTS,
      }),
    );
    const diag = store.get("r1")?.diag;
    expect(diag).not.toHaveProperty("experts");
    expect((captured.spec as { displayMeta?: { consultOf?: unknown } } | undefined)?.displayMeta?.consultOf).toEqual({
      askerRunId: "r_ASKER",
    });
  });

  it("runs without any new request fields produce a diag with none of the new keys (zero-change when absent)", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, store, consult: consultFactory });
    await runner.run(spec());
    const diag = store.get("r1")?.diag;
    for (const key of ["experts", "dispatchMeta", "schemaPreset", "consults"]) expect(diag).not.toHaveProperty(key);
  });

  it("caps experts.refs at EXPERTS_REFS_CAP (16), keeping the first entries", async () => {
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, store, consult: consultFactory });
    const many = Array.from({ length: 20 }, (_, i) => ({
      runId: `r_E${i}`,
      sessionFile: `/s/e${i}.jsonl`,
      agentType: "explorer",
    }));
    await runner.run(spec({ consultExperts: many }));
    const refs = store.get("r1")?.diag.experts?.refs;
    expect(refs).toHaveLength(16);
    expect(refs?.[0]).toMatchObject({ runId: "r_E0" });
    expect(refs?.[15]).toMatchObject({ runId: "r_E15" });
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
