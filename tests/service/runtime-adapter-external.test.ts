import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, ExternalRunSpec } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import type { ExternalAgentsPort, PlanRunInput } from "../../src/external-agent/types.js";
import { VERDICT_SCHEMA_V1 } from "../../src/core/verdict-schema.js";
import { msgSchemaNoJson } from "../../src/external-agent/messages.js";

const budget = {
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
function handle(text: string): SessionHandle {
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
    getLastAssistantText: () => text,
    getUsage: () => undefined,
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
const EXT_SPEC: ExternalRunSpec = {
  provider: "droid",
  modelId: "gpt-6-luna",
  roleName: "worker",
  contextBlocks: [],
  persistTranscript: true,
  runId: "r1",
  pricing: { status: "unpriced", reason: "no_match" },
  degraded: [],
};
function fakePort(inputs: PlanRunInput[]): ExternalAgentsPort {
  return {
    owns: (p) => p === "droid",
    exists: () => true,
    unavailableReason: () => undefined,
    unknownModelMessage: () => "unknown",
    advertised: () => [],
    ownerOfSessionFile: () => undefined,
    planRun: (i) => {
      inputs.push(i);
      return EXT_SPEC;
    },
    pricingFor: () => EXT_SPEC.pricing,
    dispose: () => undefined,
  };
}
async function drain(clock: FakeClock, ticks = 12) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(1);
    await Promise.resolve();
  }
}
const type: AgentTypeConfig = {
  name: "worker",
  description: "x",
  systemPrompt: "ROLE",
  promptMode: "replace",
  canSpawn: ["worker"],
  tools: ["read"],
};
function rs(model: { provider: string; id: string }, schema?: object): RunnerSpec {
  return {
    runId: "r1",
    type,
    model,
    cwd: "/orig",
    request: { type: "worker", prompt: "hi", ...(schema ? { schema } : {}) } as RunnerSpec["request"],
    budget,
  };
}
async function runWith(
  runSpec: RunnerSpec,
  text: string,
  extra: Partial<RuntimeAdapterDeps> = {},
): Promise<{
  captured: SessionSpec | undefined;
  outcome: Awaited<ReturnType<ReturnType<typeof createRuntimeRunnerAdapter>["run"]>>;
}> {
  const clock = new FakeClock();
  let captured: SessionSpec | undefined;
  const driver: SessionDriver = {
    create: async (s: SessionSpec) => {
      captured = s;
      return handle(text);
    },
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  const runner = createRuntimeRunnerAdapter({
    clock,
    pool: new SingleSlotPool(clock, 1),
    store: new MemoryRunStore(),
    watchdog: new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined }),
    reaper: new EscalatingReaper(clock),
    notifier,
    driver,
    nestedSpawn: () => ({
      spawn: async () => ({ runId: "c" }),
      spawnAndWait: async () => {
        throw new Error("unused");
      },
    }),
    ...extra,
  });
  const p = runner.run(runSpec);
  await drain(clock);
  const outcome = await p;
  return { captured, outcome };
}
const h2 = {
  resolveSessionSpec: async (s: SessionSpec) => ({ ...s, cwd: "/wt" }),
};

describe("runtime-adapter: external (droid) runs", () => {
  it("driver spec has no customTools/toolScope/systemPrompt; external attached after H2 with post-H2 cwd", async () => {
    const inputs: PlanRunInput[] = [];
    const { captured } = await runWith(rs({ provider: "droid", id: "gpt-6-luna" }), "ok", {
      external: fakePort(inputs),
      extensions: [h2],
    });
    expect(captured).toBeDefined();
    const c = captured as Record<string, unknown>;
    expect(c.customTools).toBeUndefined();
    expect(c.toolScope).toBeUndefined();
    expect(c.systemPrompt).toBeUndefined();
    expect(c.tools).toBeUndefined();
    expect(c.external).toEqual(EXT_SPEC);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      cwd: "/wt",
      model: { provider: "droid", id: "gpt-6-luna" },
      rolePrompt: "ROLE",
      typeName: "worker",
      declaresTools: true,
      canSpawn: true,
      resume: false,
    });
  });

  it("pi run is untouched even when the port exists: tools injected, no external, systemPrompt kept", async () => {
    const inputs: PlanRunInput[] = [];
    const withPort = await runWith(rs({ provider: "anthropic", id: "x" }), "ok", { external: fakePort(inputs) });
    const without = await runWith(rs({ provider: "anthropic", id: "x" }), "ok");
    expect(inputs).toEqual([]);
    const a = withPort.captured as Record<string, any>;
    const b = without.captured as Record<string, any>;
    expect(a.external).toBeUndefined();
    expect(a.systemPrompt).toBe("ROLE");
    expect(a.toolScope).toBeDefined();
    expect(a.customTools.map((t: any) => t.name).sort()).toEqual(b.customTools.map((t: any) => t.name).sort());
    expect(a.tools).toEqual(b.tools);
  });

  it("without the port a droid/x model behaves exactly like any pi model (no external key)", async () => {
    const { captured } = await runWith(rs({ provider: "droid", id: "x" }), "ok");
    expect((captured as Record<string, unknown>).external).toBeUndefined();
    expect((captured as Record<string, unknown>).toolScope).toBeDefined();
  });

  it("§15-1 (P5): planRun persist falls back to externalPersistDefault (rememberAgents=false ⇒ no transcript)", async () => {
    // 三档：显式 persist 优先；缺省回落注入值（与 PiSessionDriver 的 ?? rememberAgents
    // 同口径）；未注入时保持 true（与改动前一致）。
    const explicit: PlanRunInput[] = [];
    await runWith(rs({ provider: "droid", id: "m" }), "ok", { external: fakePort(explicit) });
    expect(explicit[0]!.persist).toBe(true); // 未注入 ⇒ 默认 true（旧口径）
    const inherit: PlanRunInput[] = [];
    await runWith(rs({ provider: "droid", id: "m" }), "ok", {
      external: fakePort(inherit),
      externalPersistDefault: false,
    });
    expect(inherit[0]!.persist).toBe(false); // rememberAgents=false 兑底生效
  });

  const schema = { type: "object", properties: { v: { type: "number" } }, required: ["v"] };
  it("schema: final ```json block is extracted and validated", async () => {
    const { outcome } = await runWith(rs({ provider: "droid", id: "m" }, schema), 'done\n```json\n{"v":1}\n```', {
      external: fakePort([]),
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.structuredResult).toEqual({ v: 1 });
  });
  it("schema: missing json block fails as schema with msgSchemaNoJson", async () => {
    const { outcome } = await runWith(rs({ provider: "droid", id: "m" }, schema), "no json here", {
      external: fakePort([]),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toEqual({ kind: "schema", message: msgSchemaNoJson(), retryable: false });
  });
  it("schema: json that violates the schema fails host-side validation", async () => {
    const { outcome } = await runWith(rs({ provider: "droid", id: "m" }, schema), '```json\n{"v":"x"}\n```', {
      external: fakePort([]),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("schema");
    expect(outcome.error?.message).toContain("re-validation");
  });

  it("verdict/v1: semantic validation (blockers count) applies to the extracted json", async () => {
    const mk = (blockers: number) =>
      "```json\n" +
      JSON.stringify({ verdict: "reject", blockers, findings: [{ severity: "blocker", summary: "s" }], report: "r" }) +
      "\n```";
    const r = (text: string) =>
      runWith(
        {
          ...rs({ provider: "droid", id: "m" }, VERDICT_SCHEMA_V1),
          request: {
            type: "worker",
            prompt: "hi",
            schema: VERDICT_SCHEMA_V1,
            schemaPreset: "verdict/v1",
          } as RunnerSpec["request"],
        },
        text,
        { external: fakePort([]) },
      );
    const ok = await r(mk(1));
    expect(ok.outcome.status).toBe("completed");
    const bad = await r(mk(0));
    expect(bad.outcome.status).toBe("failed");
    expect(bad.outcome.error?.message).toContain("semantic validation");
  });
});
