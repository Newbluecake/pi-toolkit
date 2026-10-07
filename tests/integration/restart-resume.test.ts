import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_CUSTOM_TYPE, seedRunStoreFromEntries, wrapWithRunLog } from "../../src/adapters/pi-run-log.js";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunSnapshot } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createQueryService } from "../../src/service/query-service.js";
import { createLiveRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * run-persistence plan §5 P3 core acceptance (docs/dev/subagent-run-persistence/plan.md):
 * a run that was still in flight when "process 1" died (hard kill: every object
 * simply dropped, nothing settles) is resumable and gettable in "process 2"
 * purely from the session log — the `entries` array stands in for the main
 * session jsonl that `wrapWithRunLog` writes through `pi.appendEntry`.
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

/** One simulated pi process: real adapter + spawn-service + query over a (possibly seeded) store. */
function proc(entries: Entry[], opts: { sessionFile: string; promptHangs: boolean; seed: boolean }) {
  const clock = new FakeClock();
  clock.advance(1_000_000);
  const base = new MemoryRunStore();
  if (opts.seed) seedRunStoreFromEntries(base, entries);
  const runLog = wrapWithRunLog(base, {
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
    sessionManager: { getEntries: () => entries },
  });
  const resumedFiles: string[] = [];
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
    create: async () => handle(),
    resume: async (file) => {
      resumedFiles.push(file);
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
  return { clock, base, runner, spawn, query, resumedFiles };
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
const journalEntries = (entries: Entry[]) =>
  entries.filter((e) => e.customType === RUN_CUSTOM_TYPE).map((e) => e.data as RunSnapshot);

describe("restart → resume of a run that was still in flight (run-persistence plan §5 P3)", () => {
  let dir: string | undefined;
  afterEach(() => {
    simulateProcessDeath();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  function childSessionFile(): string {
    dir = mkdtempSync(join(tmpdir(), "pi-restart-resume-"));
    const file = join(dir, "child.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "child" })}\n`);
    return file;
  }

  async function processOne(entries: Entry[], file: string) {
    const p1 = proc(entries, { sessionFile: file, promptHangs: true, seed: false });
    const started = await p1.spawn.spawn({ type: "worker", prompt: "build the thing", label: "builder" });
    if (!("runId" in started)) throw new Error(`spawn failed: ${JSON.stringify(started)}`);
    await flushMicrotasks(p1.clock);
    return { p1, runId: started.runId };
  }

  it("hard kill: process 2 gets an aborted outcome immediately and resumes by label and by runId", async () => {
    const file = childSessionFile();
    const entries: Entry[] = [];
    const { p1, runId } = await processOne(entries, file);
    // Process 1 journaled the in-flight run at session_created; the run is still live.
    const journaled = journalEntries(entries);
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({ runId, status: "starting", journal: { kind: "session_created" } });
    expect(p1.base.get(runId)).toBeUndefined(); // J1/I4 in process 1 too
    // …hard kill: drop every process-1 object without settling anything.

    const p2 = proc(entries, { sessionFile: file, promptHangs: false, seed: true });
    const got = p2.query.get(runId);
    expect(got?.status).toBe("aborted");
    expect(got?.outcome?.error?.message).toContain("interrupted by a pi restart (crash/kill)");
    expect(got?.diag.restartInterrupted?.source).toBe("session_created");
    const waited = await p2.query.wait(runId);
    expect(waited).toMatchObject({ ok: true, outcome: { status: "aborted" } });

    // Same OS process (the /reload shape, D8): process 1's run was never
    // reaped, so its child session file is still marked live — refused.
    const refused = await p2.spawn.spawn({ type: "worker", prompt: "continue", resumeFrom: "builder" });
    expect(refused).toMatchObject({ error: { message: expect.stringContaining("still being closed") } });
    // A real hard kill takes the whole process — and its Symbol.for registry — with it.
    simulateProcessDeath();

    const byLabel = await p2.spawn.spawn({ type: "worker", prompt: "continue", resumeFrom: "builder" });
    if (!("runId" in byLabel)) throw new Error(`resume by label failed: ${JSON.stringify(byLabel)}`);
    await flushMicrotasks(p2.clock);
    await p2.spawn.waitAll({ waitMs: 1_000 });
    const byId = await p2.spawn.spawn({ type: "worker", prompt: "continue again", resumeFrom: runId });
    if (!("runId" in byId)) throw new Error(`resume by runId failed: ${JSON.stringify(byId)}`);
    await flushMicrotasks(p2.clock);
    await p2.spawn.waitAll({ waitMs: 1_000 });
    expect(p2.resumedFiles).toEqual([file, file]);
  });

  it("/reload variant: the shutdown flush entry supplies source and usage", async () => {
    const file = childSessionFile();
    const entries: Entry[] = [];
    const { p1, runId } = await processOne(entries, file);
    expect(p1.runner.flushJournal!([runId], { kind: "shutdown_flush", shutdownReason: "reload" })).toBe(1);
    expect(journalEntries(entries).map((s) => s.journal?.kind)).toEqual(["session_created", "shutdown_flush"]);

    const p2 = proc(entries, { sessionFile: file, promptHangs: false, seed: true });
    const got = p2.query.get(runId)!;
    expect(got.status).toBe("aborted");
    expect(got.diag.restartInterrupted).toMatchObject({ source: "shutdown_flush", shutdownReason: "reload" });
    expect(got.outcome?.usage).toEqual(USAGE);
    expect(got.outcome?.error?.message).toContain("interrupted by a pi restart (reload)");
  });

  it("negative: the child session file is gone ⇒ not seeded, resume target not found", async () => {
    const file = childSessionFile();
    const entries: Entry[] = [];
    const { runId } = await processOne(entries, file);
    rmSync(file);
    const p2 = proc(entries, { sessionFile: file, promptHangs: false, seed: true });
    expect(p2.query.get(runId)).toBeUndefined();
    expect(p2.base.list()).toEqual([]);
    const resumed = await p2.spawn.spawn({ type: "worker", prompt: "continue", resumeFrom: "builder" });
    expect(resumed).toMatchObject({ error: { message: expect.stringContaining("resume target not found") } });
    expect(p2.resumedFiles).toEqual([]);
  });
});
