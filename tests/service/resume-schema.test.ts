import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeadlineBudget, RunSnapshot } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { SCHEMA_PRESETS } from "../../src/core/verdict-schema.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * U2 (agent-explicit-timeout-extend plan §2.2 / §7): the spawn-admission
 * resolution formula, driven through the REAL seam — createSpawnService +
 * createRuntimeRunnerAdapter — with `RuntimeRunner.prototype.run` spied so
 * the exact (ResolvedSpawnRequest, DeadlineBudget) pair the runner would
 * execute is captured: `req.timeoutPolicy` (the resolved definite value the
 * adapter threads through), `budget.maxTotalFactor` (the fixed-deadline
 * clamp) and `budget.maxExtensions` (the extend.enabled kill switch), plus
 * the terminal snapshot's `diag.timeoutPolicy`.
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

const baseBudget: DeadlineBudget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 2_000,
  startupMs: 20_000,
  bindMs: 2_000,
  firstEventMs: 2_000,
  idleMs: 2_000,
  toolMs: 2_000,
  totalMs: 30_000,
  totalGraceMs: 0,
  abortGraceMs: 20,
  steerMs: 10,
  reapMs: 30,
};

type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
const structuredTool = (spec: SessionSpec): Tool | undefined =>
  (spec.customTools as Tool[] | undefined)?.find((t) => t.name === "StructuredOutput");

function handle(sessionFile: string, spec: SessionSpec): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile,
    prompt: async () => {
      const tool = structuredTool(spec);
      if (tool !== undefined && submit !== undefined) await tool.execute("tc", submit(), undefined, undefined, {});
    },
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
  };
}

const flatNotifier = {
  enqueue: () => undefined,
  finalize: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

const specs: Array<{ kind: "create" | "resume"; spec: SessionSpec }> = [];
let submit: (() => unknown) | undefined;

function buildStack(
  clock: FakeClock,
  sessionFile: string,
  extensionsEnabled = true,
  durableRecords?: () => readonly RunSnapshot[],
) {
  const driver: SessionDriver = {
    create: async (spec: SessionSpec) => {
      specs.push({ kind: "create", spec });
      return handle(sessionFile, spec);
    },
    resume: async (file: string, spec: SessionSpec) => {
      specs.push({ kind: "resume", spec });
      return handle(file, spec);
    },
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  const pool = new SingleSlotPool(clock, 4);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: baseBudget,
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: flatNotifier,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const snapshots: RunSnapshot[] = [];
  const svc = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
    budget: baseBudget,
    onSnapshot: (s: RunSnapshot) => snapshots.push(s),
    extensionsEnabled,
    ...(durableRecords === undefined ? {} : { durableRecords }),
  });
  return { svc, snapshots, clock, store };
}

let dir: string;
let fileSeq = 0;
const nextSessionFile = () => {
  const file = join(dir, `sess-${++fileSeq}.jsonl`);
  writeFileSync(file, "{}\n");
  return file;
};

const verdict = {
  verdict: "pass",
  blockers: 0,
  findings: [],
  report: "all good",
};
const INLINE = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

async function drain(clock: FakeClock, ticks = 60) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(1);
    await Promise.resolve();
  }
}

describe("#68 resume inherits the original run's schema", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resume-schema-"));
    specs.length = 0;
    submit = undefined;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function run(
    clock: FakeClock,
    svc: ReturnType<typeof buildStack>["svc"],
    req: Record<string, unknown>,
  ): Promise<string> {
    const r = await svc.spawn({ type: "worker", prompt: "x", ...req });
    if ("error" in r) throw new Error(r.error.message);
    await drain(clock);
    return r.runId;
  }
  const last = () => specs.at(-1)!;

  it("failed schema run + schema-less inheriting resume ⇒ StructuredOutput present and result re-validated (preset)", async () => {
    const clock = new FakeClock();
    const { svc, snapshots } = buildStack(clock, nextSessionFile());
    // first run never submits ⇒ failed(schema), but its session is resumable
    const first = await run(clock, svc, { schema: SCHEMA_PRESETS["verdict/v1"], schemaPreset: "verdict/v1" });
    expect(snapshots.filter((s) => s.runId === first).at(-1)?.status).toBe("failed");
    expect(snapshots.filter((s) => s.runId === first).at(-1)?.diag.schemaPreset).toBe("verdict/v1");

    submit = () => verdict;
    const second = await run(clock, svc, { resumeFrom: first, inheritSchema: true });
    expect(last().kind).toBe("resume");
    expect(structuredTool(last().spec)).toBeDefined();
    const terminal = snapshots.filter((s) => s.runId === second).at(-1)!;
    expect(terminal.status).toBe("completed");
    expect(terminal.outcome?.structuredResult).toEqual(verdict);
    expect(terminal.diag.schemaPreset).toBe("verdict/v1");

    // host re-validation still applies: a payload violating the preset fails the run
    submit = () => ({ verdict: "pass" });
    const third = await run(clock, svc, { resumeFrom: first, inheritSchema: true });
    expect(snapshots.filter((s) => s.runId === third).at(-1)?.status).toBe("failed");
  });

  it("inline (non-preset) schema is inherited too, and persisted on diag", async () => {
    const clock = new FakeClock();
    const { svc, snapshots } = buildStack(clock, nextSessionFile());
    submit = () => ({ ok: true });
    const first = await run(clock, svc, { schema: INLINE });
    expect(snapshots.filter((s) => s.runId === first).at(-1)?.diag.schema).toEqual(INLINE);
    const second = await run(clock, svc, { resumeFrom: first, inheritSchema: true });
    expect(structuredTool(last().spec)).toBeDefined();
    const terminal = snapshots.filter((s) => s.runId === second).at(-1)!;
    expect(terminal.outcome?.structuredResult).toEqual({ ok: true });
    expect(terminal.diag.schema).toEqual(INLINE);
    submit = () => ({ ok: "nope" });
    const third = await run(clock, svc, { resumeFrom: first, inheritSchema: true });
    expect(snapshots.filter((s) => s.runId === third).at(-1)?.status).toBe("failed");
  });

  it("an explicit schema overrides the inherited one", async () => {
    const clock = new FakeClock();
    const { svc, snapshots } = buildStack(clock, nextSessionFile());
    submit = () => ({ ok: true });
    const first = await run(clock, svc, { schema: INLINE });
    const other = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
    submit = () => ({ n: 1 });
    const second = await run(clock, svc, { resumeFrom: first, schema: other });
    const terminal = snapshots.filter((s) => s.runId === second).at(-1)!;
    expect(terminal.outcome?.structuredResult).toEqual({ n: 1 });
    expect(terminal.diag.schema).toEqual(other);
  });

  it("original run without a schema ⇒ resume has no StructuredOutput", async () => {
    const clock = new FakeClock();
    const { svc } = buildStack(clock, nextSessionFile());
    const first = await run(clock, svc, {});
    await run(clock, svc, { resumeFrom: first, inheritSchema: true });
    expect(last().kind).toBe("resume");
    expect(structuredTool(last().spec)).toBeUndefined();
  });

  it("no inheritSchema flag (mention/wake/RPC resume) ⇒ no inheritance", async () => {
    const clock = new FakeClock();
    const { svc } = buildStack(clock, nextSessionFile());
    submit = () => ({ ok: true });
    const first = await run(clock, svc, { schema: INLINE });
    await run(clock, svc, { resumeFrom: first });
    expect(structuredTool(last().spec)).toBeUndefined();
  });

  it("legacy record without a schema field ⇒ no inheritance", async () => {
    const clock = new FakeClock();
    const legacyFile = nextSessionFile();
    const legacy: RunSnapshot = {
      runId: "r_LEGACY01",
      generation: 1,
      status: "failed",
      phase: "settled",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: {
        createdAt: 0,
        phase: "settled",
        phaseEnteredAt: 0,
        pendingTools: 0,
        turns: 1,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        sessionFile: legacyFile,
      },
      updatedAt: 0,
    };
    const { svc } = buildStack(clock, nextSessionFile(), true, () => [legacy]);
    await run(clock, svc, { resumeFrom: legacy.runId, inheritSchema: true });
    expect(last().kind).toBe("resume");
    expect(structuredTool(last().spec)).toBeUndefined();
  });

  it("an oversize inline schema is not persisted ⇒ not inherited", async () => {
    const clock = new FakeClock();
    const { svc, snapshots } = buildStack(clock, nextSessionFile());
    const big = { type: "object", description: "x".repeat(20_000) };
    submit = () => ({});
    const first = await run(clock, svc, { schema: big });
    expect(snapshots.filter((s) => s.runId === first).at(-1)?.diag.schema).toBeUndefined();
    await run(clock, svc, { resumeFrom: first, inheritSchema: true });
    expect(structuredTool(last().spec)).toBeUndefined();
  });
});
