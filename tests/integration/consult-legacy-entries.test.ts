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
import { createQueryService, type QueryService } from "../../src/service/query-service.js";
import { createLiveRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { renderRunDetail } from "../../src/commands/status.js";
import { buildFleetViewModel } from "../../src/ui/fleet-panel.js";
import { createListSubagentsTool } from "../../src/tools/list-subagents-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import { projectFleet } from "../../src/web-hub/agent/status.js";
import { revivable, reviveRig, target } from "../helpers/fabric-revive.js";

/**
 * #40 compat (docs/dev/consult-removal/plan.md §3.1): run entries written by a pre-removal version still carry the
 * retired consult diag fields (`experts`/`consults`/`consultOf`/`consultCache`/`consultThread`/
 * `consultIdentityPrediction`, `dispatchMeta.abArm`, the `consult:main-snapshot` agent type, `wakeExclusion:
 * "consult_fork"`). They must seed, render, resume and wake-judge without any special handling.
 */

type Entry = { type: string; customType?: string; data?: unknown };

const LEGACY_AGENT_TYPE = "consult:main-snapshot";
const RUN_ID = "r_LEGACY01";
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const USAGE = { input: 11, output: 22, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 };

/** The retired diag fields exactly as an old version persisted them. */
const LEGACY_DIAG = {
  experts: { refs: [{ runId: "r_EXPERT01", label: "arch", agentType: "architect", kind: "main" }], granted: true },
  consultOf: { askerRunId: "r_ASKER001" },
  consultCache: {
    v: 1,
    predicted: { state: "warm", evidence: { source: "anchor-ledger", ttlMs: 300_000 } },
    first: { v: 1, readShare: 0.93, label: "hit", anchor: "added", at: 5 },
  },
  consultThread: { threadId: "c7k9q2mx", seq: 2 },
  consultIdentityPrediction: { system: true, model: true },
  consults: {
    calls: 2,
    byResult: { completed: 1, bad_ref: 1 },
    truncated: 0,
    partial: 0,
    costUsd: 0.05,
    unpricedCalls: 0,
    latencyMs: 500,
    maxLatencyMs: 300,
    latencyUnknown: 0,
    byExpert: { r_EXPERT01: 2 },
  },
  dispatchMeta: { lane: "L2", packageId: "pkg-legacy", feature: "auth", abArm: "experts" },
};
const LEGACY_KEYS = Object.keys(LEGACY_DIAG).filter((k) => k !== "dispatchMeta");

function legacySnapshot(file: string): RunSnapshot {
  return {
    runId: RUN_ID,
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, hardDeadlineAt: 100_000, deadlineAt: 100_000, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 5,
      pendingTools: 0,
      turns: 2,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      label: "legacy-ask",
      agentType: LEGACY_AGENT_TYPE,
      model: { provider: "acme", id: "big" },
      sessionFile: file,
      usage: USAGE,
      wakeExclusion: "consult_fork",
      ...LEGACY_DIAG,
    } as unknown as RunSnapshot["diag"],
    outcome: {
      runId: RUN_ID,
      status: "completed",
      text: "the legacy answer",
      turns: 2,
      durationMs: 1_000,
      usage: USAGE,
      diag: { sessionFile: file } as never,
    } as never,
    updatedAt: 10,
  };
}

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

/** One simulated pi process whose run store is seeded from legacy session-log entries. */
function proc(entries: Entry[], sessionFile: string) {
  const clock = new FakeClock();
  clock.advance(1_000_000);
  const base = new MemoryRunStore();
  seedRunStoreFromEntries(base, entries);
  const runLog = wrapWithRunLog(base, {
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
    sessionManager: { getEntries: () => entries },
  });
  const resumed: Array<{ file: string; spec: unknown }> = [];
  const handle = (): SessionHandle => ({
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    sessionFile,
    prompt: () => Promise.resolve(),
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
    resume: async (file, spec) => {
      resumed.push({ file, spec });
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
  return { clock, base, spawn, query, resumed };
}

const LIVE_FILES_KEY = Symbol.for("pi-subagent:live-session-files");

describe("legacy consult run entries (#40 compat)", () => {
  let dir: string | undefined;
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[LIVE_FILES_KEY];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  function legacyEntries(): { entries: Entry[]; file: string; snap: RunSnapshot } {
    dir = mkdtempSync(join(tmpdir(), "pi-legacy-entries-"));
    const file = join(dir, "child.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "child" })}\n`);
    const snap = legacySnapshot(file);
    return { entries: [{ type: "custom", customType: RUN_CUSTOM_TYPE, data: snap }], file, snap };
  }
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
  const queryOf = (snap: RunSnapshot): QueryService => ({
    get: (id) => (id === snap.runId ? snap : undefined),
    list: () => [snap],
    wait: async () => ({ ok: true, outcome: snap.outcome! }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  });

  it("seeds from the session log and keeps the stored fields as inert extra properties", () => {
    const { entries, file } = legacyEntries();
    const p = proc(entries, file);
    const got = p.query.get(RUN_ID)!;
    expect(got.status).toBe("completed");
    expect(got.diag.label).toBe("legacy-ask");
    for (const key of LEGACY_KEYS) expect(got.diag).toHaveProperty(key); // seeding is a cast: nothing is stripped, nothing reads it
  });

  it("get_subagent_result, list_subagents, /agent status, the fleet view and the web projection render it as an ordinary run", async () => {
    const { snap } = legacyEntries();
    const query = queryOf(snap);
    const result = await createResultTool({ query }).execute(
      "tc1",
      { run_id: RUN_ID },
      undefined,
      () => undefined,
      {} as never,
    );
    const resultText = textOf(result as never);
    expect(resultText).toContain("the legacy answer");
    expect(resultText).not.toMatch(/consult|cache:|experts/i);

    const listed = await createListSubagentsTool({
      query,
      spawn: { slots: () => ({ limit: 4, inUse: 0, free: 4 }) },
      now: () => 20,
    }).execute("tc2", { recent: 5 }, undefined, () => undefined, {} as never);
    const listText = textOf(listed as never);
    expect(listText).toContain(RUN_ID);
    expect(listText).not.toMatch(/consult/i);

    const detail = renderRunDetail(query, RUN_ID);
    expect(detail).toContain("legacy-ask");
    expect(detail).toContain("main"); // `consult:main-snapshot` folds to the plain display name
    expect(detail).not.toMatch(/consult/i);

    const vm = buildFleetViewModel([snap], { now: 20, typeOf: () => LEGACY_AGENT_TYPE });
    const rowJson = JSON.stringify(vm.rows);
    expect(vm.rows).toHaveLength(1);
    expect(vm.rows[0]!.type).toBe("main");
    expect(rowJson).not.toMatch(/consult/i);

    const wire = projectFleet([snap], 20, () => LEGACY_AGENT_TYPE);
    expect(wire).toHaveLength(1);
    expect(JSON.stringify(wire)).not.toMatch(/consult/i);
  });

  it("resume of a legacy run opens its session file and writes a clean diag (no legacy fields, no abArm)", async () => {
    const { entries, file } = legacyEntries();
    const p = proc(entries, file);
    const resumedRun = await p.spawn.spawn({ type: "worker", prompt: "continue", resumeFrom: RUN_ID });
    if (!("runId" in resumedRun)) throw new Error(`resume failed: ${JSON.stringify(resumedRun)}`);
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      p.clock.advance(1);
      await Promise.resolve();
    }
    await p.spawn.waitAll({ waitMs: 1_000 });
    expect(p.resumed.map((r) => r.file)).toEqual([file]);
    const fresh = p.query.get(resumedRun.runId)!;
    expect(fresh.status).toBe("completed");
    for (const key of LEGACY_KEYS) expect(fresh.diag).not.toHaveProperty(key);
    expect(fresh.diag.dispatchMeta).toEqual({ lane: "L2", packageId: "pkg-legacy", feature: "auth" });
    expect(fresh.diag.dispatchMeta).not.toHaveProperty("abArm");
    expect(fresh.diag.wakeExclusion).not.toBe("consult_fork");
  });

  it("wake preflight still refuses a run whose admission verdict was the legacy consult_fork", () => {
    const { snap } = legacyEntries();
    const rig = reviveRig({ snapshots: [{ ...snap, runId: target } as RunSnapshot] });
    expect(rig.wake.preflight(target)).toEqual({ ok: false, reason: "consult_fork" });
    // …and the control: the same run with a current verdict is revivable.
    const ok = reviveRig({ snapshots: [revivable({ wakeExclusion: "none" })] });
    expect(ok.wake.preflight(target)).toMatchObject({ ok: true });
  });
});
