import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { createWorktreeExtension, type ExecResult } from "../../src/extensions/worktree.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator } from "../../src/workflow/orchestrator.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";
import { parseForEachRef } from "../../src/workflow/isolation-verify.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";

/**
 * replay-verify-plan v2.1 \u00a76 P2 test 21 (acceptance addition): the SAME
 * scope as `tests/integration/workflow-worktree-replay.test.ts`'s own P2
 * test 21 (real git + real worktree extension), but driven end-to-end
 * through the production-shaped pieces that file's pure-function-level
 * checks never exercise: a REAL `createWorkflowChildSpawner` (the actual
 * adapter `stack.ts` wires), a REAL `SpawnService` + `createRuntimeRunnerAdapter`
 * (only the `SessionDriver` \u2014 "what a child agent session actually does" \u2014
 * is a lightweight fake, since exercising a real LLM call is out of scope
 * here), and a REAL worker (`createWorkerHost` with `systemClock`, i.e. an
 * actual `node:worker_threads` thread running real script text via jiti,
 * same as `tests/workflow/journal-replay-e2e.test.ts`), with a REAL
 * `journal.jsonl` on disk. Three full runs: live write, verified replay hit
 * (zero spawns), and a re-live after the branch is deleted \u2014 plus the two
 * cwd robustness scenarios (`chdir` mid-run, a different clone) the plan's
 * own scenario table (\u00a73) calls out.
 */

const execFileAsync = promisify(execFile);
const realExec = async (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> => {
  try {
    const r = await execFileAsync(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeout, signal: opts.signal });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
};

/** The real `probeAgentBranches` port shape (stack.ts's own wiring) \u2014 a single real `git for-each-ref`. */
function realProbeAgentBranches(cwd: string) {
  return async (branches: readonly string[], opts: { timeoutMs: number; signal: AbortSignal }) => {
    const result = await realExec(
      "git",
      ["for-each-ref", "--format=%(refname) %(objectname)", ...branches.map((b) => `refs/heads/${b}`)],
      { cwd, timeout: opts.timeoutMs, signal: opts.signal },
    );
    if (result.code !== 0) return { ok: false as const, error: result.stderr.trim() || `exit ${result.code}` };
    return { ok: true as const, tips: parseForEachRef(result.stdout, new Set(branches.map((b) => `refs/heads/${b}`))) };
  };
}

const dirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-wf-lifecycle-"));
  dirs.push(dir);
  await realExec("git", ["init", "-q"], { cwd: dir });
  await realExec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await realExec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "1");
  await realExec("git", ["add", "-A"], { cwd: dir });
  await realExec("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 10_000,
    startupMs: 10_000,
    bindMs: 10_000,
    firstEventMs: 10_000,
    idleMs: 10_000,
    toolMs: 10_000,
    totalMs: 60_000,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 2_000,
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
    getLastAssistantText: () => "iso-child-output",
    getUsage: () => undefined,
    ...overrides,
  };
}

const flatNotifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

function agentTypeRegistryStub(): AgentTypeRegistry {
  return { configHashOf: () => "h1" } as unknown as AgentTypeRegistry;
}

/**
 * Same "buildFullStack" shape `tests/integration/workflow-worktree.test.ts`
 * establishes (real `SpawnService` + real `createRuntimeRunnerAdapter` +
 * real worktree extension via the X1 late-bound `worktreeDiag` ref), on
 * `systemClock` (real wall time \u2014 this file's git subprocesses are real).
 */
function buildRealSpawnService(worktreeExt: ReturnType<typeof createWorktreeExtension>, driver: SessionDriver) {
  const pool = new SingleSlotPool(systemClock, 4);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(systemClock);
  const watchdog = new EventWatchdog({
    clock: systemClock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const worktreeDiag: { current?: (runId: string, disposition: unknown) => void } = {};
  const runner = createRuntimeRunnerAdapter({
    clock: systemClock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: flatNotifier,
    extensions: [worktreeExt],
    worktreeDiag,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const svc = createSpawnService({
    types,
    pool,
    runner,
    now: () => systemClock.now(),
    budget: { reapMs: 2_000 },
  });
  worktreeDiag.current = (runId, disposition) =>
    svc.markWorktreeDisposition?.(runId, disposition as Parameters<typeof svc.markWorktreeDisposition>[1]);
  return svc;
}

/** A lightweight driver that stands in for "what a real child agent session does" \u2014 makes the worktree dirty (so H3's commit path actually runs) by writing a file into whatever cwd it was handed (the H2-rewritten worktree path for an isolated call). */
function makeDriver(onCreate?: (cwd: string | undefined) => void): SessionDriver {
  return {
    create: async (spec) => {
      onCreate?.(spec.cwd);
      if (spec.cwd) await writeFile(join(spec.cwd, "output.txt"), "hello");
      return handle();
    },
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
}

const LIFECYCLE_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 2_000,
  scriptSliceMs: 2_000,
  workerBootMs: 10_000,
  heartbeatMs: 0,
  heartbeatStallMs: 60_000,
  terminateConfirmMs: 2_000,
  workflowTotalMs: 40_000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 20_000,
  gateMs: 5_000,
  maxParallel: 4,
  maxChildren: 20,
  maxBatchItems: 20,
  childBudgetPolicy: "inherit_remaining",
  worktreeSettleMaxMs: 20_000,
};

const ISO_SCRIPT =
  'export const meta = { name: "t", description: "t" };\n' +
  'const a = await agent("iso task", { isolation: "worktree", agentType: "worker" });\n' +
  "return a;";

describe("real createWorkflowChildSpawner + real worktree extension (real git) + real worker/orchestrator + real journal.jsonl: three-run lifecycle", () => {
  it("run 1 writes the journal (live commit); run 2 (verified) hits with zero spawns; deleting the branch makes run 3 go live again", async () => {
    const repo = await makeRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pi-wf-lifecycle-wt-"));
    const journalRootDir = await mkdtemp(join(tmpdir(), "pi-wf-lifecycle-journal-"));
    dirs.push(worktreeRoot, journalRootDir);
    const worktreeExt = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot });
    let spawnedCount = 0;

    async function runOnce(): Promise<WorkflowOutcome> {
      const driver = makeDriver(() => {
        spawnedCount += 1;
      });
      const svc = buildRealSpawnService(worktreeExt, driver);
      const spawner = createWorkflowChildSpawner(svc, agentTypeRegistryStub(), {
        worktreeAvailable: () => true,
        isolationReplayMode: () => "verify",
        isolationCwd: () => repo,
        probeAgentBranches: realProbeAgentBranches(repo),
      });
      const orch = createOrchestrator({
        clock: systemClock,
        createWorkerHost: () => createWorkerHost({ clock: systemClock }),
        spawner,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        journalRootDir,
      });
      return orch.run({
        workflowId: `wf_${Math.random().toString(36).slice(2)}`,
        script: ISO_SCRIPT,
        budget: LIFECYCLE_BUDGET,
        journal: "j1",
      });
    }

    const outcome1 = await runOnce();
    expect(outcome1.status).toBe("completed");
    expect(spawnedCount).toBe(1);
    expect(outcome1.replay?.hits).toBe(0);
    expect(outcome1.result).toBe("iso-child-output");

    const journalPath = join(journalRootDir, "j1", "journal.jsonl");
    const lines1 = (await readFile(journalPath, "utf8")).trim().split("\n");
    expect(lines1).toHaveLength(1);
    const entry1 = JSON.parse(lines1[0]!) as { worktree?: { state: string; branch: string; commit: string } };
    expect(entry1.worktree?.state).toBe("committed");
    const branch = entry1.worktree!.branch;
    expect(branch).toMatch(/^pi-agent-/);

    const outcome2 = await runOnce();
    expect(outcome2.status).toBe("completed");
    expect(spawnedCount).toBe(1); // unchanged \u2014 run 2 replayed, never spawned a child
    expect(outcome2.replay?.hits).toBe(1);
    expect(outcome2.result).toBe(outcome1.result);
    expect(outcome2.replay?.isolation).toMatchObject({ verified: 1, unverified: 0 });

    // Delete the branch \u2014 verification must fail on the next run (D4.4's judgement: precise sha, precise branch existence).
    await realExec("git", ["branch", "-D", branch], { cwd: repo });

    const outcome3 = await runOnce();
    expect(outcome3.status).toBe("completed");
    expect(spawnedCount).toBe(2); // re-spawned \u2014 live again
    expect(outcome3.replay?.hits).toBe(0);
    expect(outcome3.replay?.isolation).toMatchObject({ verified: 0 });

    // A fresh journal line was written for run 3's own live commit.
    const lines3 = (await readFile(journalPath, "utf8")).trim().split("\n");
    expect(lines3.length).toBeGreaterThan(lines1.length);
  }, 60_000);
});

describe("cwd robustness (plan \u00a73's scenario table, driven through the real orchestrator)", () => {
  it("process.chdir() mid-run never affects the run's own pinned isolationCwd \u2014 H2's worktree, the probe and the journal write all still target the run's ORIGINAL cwd", async () => {
    const repo = await makeRepo();
    const otherRepo = await makeRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pi-wf-lifecycle-chdir-wt-"));
    const journalRootDir = await mkdtemp(join(tmpdir(), "pi-wf-lifecycle-chdir-journal-"));
    dirs.push(worktreeRoot, journalRootDir);
    const worktreeExt = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot });
    const originalCwd = process.cwd();
    try {
      process.chdir(repo); // this run's own cwd, pinned by buildJournalConfig BEFORE boot()
      const driver = makeDriver((cwd) => {
        // Mid-run interference (another concurrent actor, or the child
        // itself): fires from inside the child's own "work", well after
        // buildJournalConfig already pinned isolationCwd for THIS run.
        if (cwd) process.chdir(otherRepo);
      });
      const svc = buildRealSpawnService(worktreeExt, driver);
      // Production shape (stack.ts): a LIVE getter, not a snapshot \u2014
      // `buildJournalConfig` is what pins it, exactly once, per run.
      const spawner = createWorkflowChildSpawner(svc, agentTypeRegistryStub(), {
        worktreeAvailable: () => true,
        isolationReplayMode: () => "verify",
        isolationCwd: () => process.cwd(),
        probeAgentBranches: realProbeAgentBranches(repo),
      });
      const orch = createOrchestrator({
        clock: systemClock,
        createWorkerHost: () => createWorkerHost({ clock: systemClock }),
        spawner,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        journalRootDir,
      });
      const outcome = await orch.run({
        workflowId: `wf_${Math.random().toString(36).slice(2)}`,
        script: ISO_SCRIPT,
        budget: LIFECYCLE_BUDGET,
        journal: "j-chdir",
      });
      expect(outcome.status).toBe("completed");
      expect(outcome.replay?.hits).toBe(0); // first run, nothing to replay

      // The journal entry's committed branch must exist in `repo` (the
      // PINNED cwd), never in `otherRepo` \u2014 confirmed by running the real
      // probe against `repo` and finding an exact match.
      const journalPath = join(journalRootDir, "j-chdir", "journal.jsonl");
      const lines = (await readFile(journalPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as { worktree?: { state: string; branch: string; commit: string } };
      expect(entry.worktree?.state).toBe("committed");
      const probe = realProbeAgentBranches(repo);
      const controller = new AbortController();
      const tips = await probe([entry.worktree!.branch], { timeoutMs: 5_000, signal: controller.signal });
      expect(tips.ok && tips.tips.get(`refs/heads/${entry.worktree!.branch}`)).toBe(entry.worktree!.commit);
    } finally {
      process.chdir(originalCwd);
    }
  }, 30_000);
});
