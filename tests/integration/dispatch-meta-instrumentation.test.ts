import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_CUSTOM_TYPE, seedRunStoreFromEntries, wrapWithRunLog } from "../../src/adapters/pi-run-log.js";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunSnapshot, SessionSpec } from "../../src/core/types.js";
import { SCHEMA_PRESETS } from "../../src/core/verdict-schema.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createQueryService } from "../../src/service/query-service.js";
import { createLiveRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * dispatch-meta persistence integration (formerly consult A/B instrumentation; the A/B arm was removed with consult, #40):
 * `wrapWithRunLog` + fake host — (a) a schema run's LATEST `subagent:run` entry
 * carries `outcome.structuredResult` (post-policy entry) and `diag.schemaPreset`;
 * (b) resume inherits `dispatchMeta` from the terminal snapshot, an explicit
 * request value overrides; (c) a run interrupted from the journal (crash) keeps
 * `dispatchMeta` through `interruptedFromJournal`, and a resume from that
 * snapshot inherits it.
 */
type Entry = { type: string; customType?: string; data?: unknown };
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const USAGE = { input: 11, output: 22, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 };

function budget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 1_000,
    startupMs: 1_000,
    bindMs: 1_000,
    firstEventMs: 100_000,
    idleMs: 100_000,
    toolMs: 100_000,
    totalMs: 500_000,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
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

const VERDICT = {
  verdict: "conditional_pass" as const,
  blockers: 1,
  findings: [{ severity: "blocker" as const, summary: "missing case" }],
  report: "## Report\nmatrix + commands",
  packageId: "pkg-2026-10-08-a",
};

/** One simulated pi process: real adapter + spawn-service + query over a (possibly seeded) store. */
function proc(
  entries: Entry[],
  opts: {
    sessionFile: string;
    promptHangs: boolean;
    seed: boolean;
    /** When set, the fake host submits this payload through the injected StructuredOutput tool. */
    submitStructured?: unknown;
    /** Captures every SessionSpec handed to driver.create (post-H2 spec incl. customTools). */
    createdSpecs?: SessionSpec[];
    /** Captures every (file, spec) the driver's resume seam saw. */
    resumedReqs?: Array<{ file: string; spec: SessionSpec }>;
  },
) {
  const clock = new FakeClock();
  clock.advance(1_000_000);
  const base = new MemoryRunStore();
  if (opts.seed) seedRunStoreFromEntries(base, entries);
  const runLog = wrapWithRunLog(base, {
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
    sessionManager: { getEntries: () => entries },
  });
  const handle = (): SessionHandle => ({
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    sessionFile: opts.sessionFile,
    prompt: () => (opts.promptHangs ? new Promise<void>(() => undefined) : Promise.resolve()),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "resumed and done",
    getUsage: () => undefined,
  });
  const driver: SessionDriver = {
    create: async (s) => {
      opts.createdSpecs?.push(s);
      if (opts.submitStructured !== undefined) {
        const tool = (
          s.customTools as Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> | undefined
        )?.find((t) => t.name === "StructuredOutput");
        if (tool) await tool.execute("tc-verdict", opts.submitStructured, undefined, undefined, {});
      }
      return handle();
    },
    resume: async (file, s) => {
      opts.resumedReqs?.push({ file, spec: s });
      return handle();
    },
    bind: async (_h, onEvent) => {
      onEvent({ t: "turn_start" });
      onEvent({ t: "message_end", usage: USAGE });
    },
    onLateArrival: () => undefined,
  };
  const pool = new SingleSlotPool(clock, 4);
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store: runLog,
    watchdog: new EventWatchdog({ clock, budget: budget(), getState: () => undefined, dispatch: () => undefined }),
    reaper: new EscalatingReaper(clock),
    notifier,
    journal: (snapshot) => runLog.journal(snapshot),
  });
  const spawn = createSpawnService({
    types: { get: () => type, list: () => [type], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    now: () => clock.now(),
    budget: budget(),
    durableRecords: () => runLog.list(),
  });
  const query = createQueryService({ registry: createLiveRunRegistry(spawn, runLog), runner, clock });
  return { clock, base, runner, spawn, query };
}

async function flushMicrotasks(clock: FakeClock, n = 40) {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
    clock.advance(1);
    await Promise.resolve();
  }
}
/** The live-session-file registry (run-persistence plan D8) is process-wide; a dead process leaves none. */
const LIVE_FILES_KEY = Symbol.for("pi-subagent:live-session-files");
function simulateProcessDeath(): void {
  delete (globalThis as Record<symbol, unknown>)[LIVE_FILES_KEY];
}
const runEntries = (entries: Entry[]) =>
  entries.filter((e) => e.customType === RUN_CUSTOM_TYPE).map((e) => e.data as RunSnapshot);
/** Seed semantics (pi-run-log): updatedAt `>=` — on a tie the LATER entry in the file wins. */
function latestRunEntry(entries: Entry[], runId: string): RunSnapshot | undefined {
  return runEntries(entries)
    .filter((s) => s.runId === runId)
    .reduce<RunSnapshot | undefined>(
      (best, s) => (best === undefined || s.updatedAt >= best.updatedAt ? s : best),
      undefined,
    );
}

describe("dispatch-meta instrumentation: persisted run-log surface", () => {
  let dir: string | undefined;
  afterEach(() => {
    simulateProcessDeath();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  function childSessionFile(name = "child.jsonl"): string {
    dir = mkdtempSync(join(tmpdir(), "pi-dispatch-meta-"));
    const file = join(dir, name);
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "child" })}\n`);
    return file;
  }

  it("a verdict/v1 schema run's latest subagent:run entry carries structuredResult + diag.schemaPreset (§6 item 6)", async () => {
    const file = childSessionFile();
    const entries: Entry[] = [];
    const META = { lane: "L2" as const, packageId: "pkg-2026-10-08-a" };
    const p1 = proc(entries, { sessionFile: file, promptHangs: false, seed: false, submitStructured: VERDICT });
    const started = await p1.spawn.spawn({
      type: "worker",
      prompt: "verify the package",
      schema: SCHEMA_PRESETS["verdict/v1"],
      schemaPreset: "verdict/v1",
      dispatchMeta: META,
    });
    if (!("runId" in started)) throw new Error(`spawn failed: ${JSON.stringify(started)}`);
    await flushMicrotasks(p1.clock);
    await p1.spawn.waitAll({ waitMs: 1_000 });

    const all = runEntries(entries);
    expect(all.length).toBeGreaterThanOrEqual(2); // first terminal put + the later post-policy put
    const latest = latestRunEntry(entries, started.runId);
    expect(latest?.diag.schemaPreset).toBe("verdict/v1");
    expect(latest?.diag.dispatchMeta).toEqual(META);
    expect(latest?.outcome?.structuredResult).toMatchObject({ verdict: "conditional_pass", blockers: 1 });
    // Every earlier terminal entry of the same run lacks the structuredResult…
    const first = runEntries(entries).filter((s) => s.runId === started.runId)[0];
    expect(first?.outcome?.structuredResult).toBeUndefined();
    // …so the analyzer's "latest updatedAt wins" rule genuinely needs the tie order.
    expect(latest!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);
  });

  it("resume inherits dispatchMeta from the terminal snapshot; an explicit value overrides (D3)", async () => {
    const file = childSessionFile();
    const entries: Entry[] = [];
    const META = { lane: "L2" as const, packageId: "pkg-2026-10-08-a" };
    // Process 1: an enrolled run completes and lands its terminal entry.
    const p1 = proc(entries, { sessionFile: file, promptHangs: false, seed: false });
    const first = await p1.spawn.spawn({ type: "worker", prompt: "dev", dispatchMeta: META, label: "dev" });
    if (!("runId" in first)) throw new Error(`spawn failed: ${JSON.stringify(first)}`);
    await flushMicrotasks(p1.clock);
    await p1.spawn.waitAll({ waitMs: 1_000 });
    const terminal = latestRunEntry(entries, first.runId);
    expect(terminal?.status).toBe("completed");
    expect(terminal?.diag.dispatchMeta).toEqual(META);
    expect(terminal?.diag.sessionFile).toBe(file);

    // Process 2 (restart): the seeded terminal entry is the resume source.
    simulateProcessDeath();
    const resumedReqs: Array<{ file: string; spec: SessionSpec }> = [];
    const p2 = proc(entries, { sessionFile: file, promptHangs: false, seed: true, resumedReqs });
    const inherited = await p2.spawn.spawn({ type: "worker", prompt: "rework", resumeFrom: first.runId });
    if (!("runId" in inherited)) throw new Error(`resume failed: ${JSON.stringify(inherited)}`);
    await flushMicrotasks(p2.clock);
    await p2.spawn.waitAll({ waitMs: 1_000 });
    expect(resumedReqs).toHaveLength(1);
    // dispatchMeta is NOT_THREADED (Gate A): it never rides the driver spec
    // directly — the inherited value surfaces as displayMeta.dispatchMeta and
    // lands in the resumed run's own persisted diag.
    expect((resumedReqs[0]!.spec as { displayMeta?: { dispatchMeta?: unknown } }).displayMeta?.dispatchMeta).toEqual(
      META,
    );
    const resumedTerminal = latestRunEntry(entries, inherited.runId);
    expect(resumedTerminal?.diag.dispatchMeta).toEqual(META);

    const explicit = { lane: "L3" as const, packageId: "pkg-other" };
    const overridden = await p2.spawn.spawn({
      type: "worker",
      prompt: "rework 2",
      resumeFrom: inherited.runId,
      dispatchMeta: explicit,
    });
    if (!("runId" in overridden)) throw new Error(`override resume failed: ${JSON.stringify(overridden)}`);
    await flushMicrotasks(p2.clock);
    await p2.spawn.waitAll({ waitMs: 1_000 });
    expect(resumedReqs[1]!.spec).toMatchObject({
      displayMeta: { dispatchMeta: explicit },
    });
    expect(latestRunEntry(entries, overridden.runId)?.diag.dispatchMeta).toEqual(explicit);
  });

  it("a run interrupted from the journal keeps dispatchMeta, and resuming that snapshot inherits it (review §8 #1)", async () => {
    const file = childSessionFile();
    const entries: Entry[] = [];
    const META = { lane: "L3" as const, packageId: "pkg-2026-10-08-b", feature: "ab-instrumentation" };
    // Process 1: an enrolled run is in flight when the process dies — the
    // journal (session_created) entry is the only record left, carrying the
    // projected dispatchMeta (JOURNAL_DIAG_FIELDS, P1a).
    const p1 = proc(entries, { sessionFile: file, promptHangs: true, seed: false });
    const started = await p1.spawn.spawn({ type: "worker", prompt: "dev", dispatchMeta: META, label: "dev2" });
    if (!("runId" in started)) throw new Error(`spawn failed: ${JSON.stringify(started)}`);
    await flushMicrotasks(p1.clock);
    const journaled = runEntries(entries);
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({
      runId: started.runId,
      status: "starting",
      journal: { kind: "session_created" },
    });
    expect(journaled[0]!.diag.dispatchMeta).toEqual(META);
    // …hard kill: drop every process-1 object without settling anything.

    simulateProcessDeath();
    const resumedReqs: Array<{ file: string; spec: SessionSpec }> = [];
    const p2 = proc(entries, { sessionFile: file, promptHangs: false, seed: true, resumedReqs });
    const seeded = p2.query.get(started.runId);
    expect(seeded?.status).toBe("aborted");
    expect(seeded?.diag.restartInterrupted?.source).toBe("session_created");
    expect(seeded?.diag.dispatchMeta).toEqual(META); // survived interruptedFromJournal

    const resumed = await p2.spawn.spawn({ type: "worker", prompt: "continue", resumeFrom: started.runId });
    if (!("runId" in resumed)) throw new Error(`resume failed: ${JSON.stringify(resumed)}`);
    await flushMicrotasks(p2.clock);
    await p2.spawn.waitAll({ waitMs: 1_000 });
    expect(resumedReqs).toHaveLength(1);
    // Same as above: inherited meta surfaces via displayMeta and the run's own diag.
    expect((resumedReqs[0]!.spec as { displayMeta?: { dispatchMeta?: unknown } }).displayMeta?.dispatchMeta).toEqual(
      META,
    );
    expect(latestRunEntry(entries, resumed.runId)?.diag.dispatchMeta).toEqual(META);
  });
});
