import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Clock, FakeClock, systemClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, SubagentExtensionPoints, WorktreeDisposal } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "../../src/service/spawn-service.js";
import { createWorktreeExtension, type ExecResult, type WorktreeExec } from "../../src/extensions/worktree.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { attachHostCallHandler, type ChildSpawner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";
import { fakeSpawnWorkerFactory } from "../workflow/helpers.js";

/**
 * workflow-worktree plan §6 P2 test 24 ("integration/workflow-worktree: 真实
 * SpawnService 加 fake exec 扩展，端到端验证 H2 改写 cwd → H3 报告 → host 收到
 * branch；abort 用例里 children 带 worktree，没有 orphan") plus the P1 test #6
 * leftover this package unblocks ("顶层 Agent run 和 workflow 子 run 同时只读
 * 访问同一个 link path" — the workflow half only became meaningful once D1's
 * isolation transfer actually reached `ChildSpawner.spawn()`, hence its home
 * here rather than in P1's own `tests/integration/worktree-link-paths.test.ts`,
 * which is outside this package's file domain).
 *
 * Real `SpawnService` + real `createRuntimeRunnerAdapter` + the real
 * worktree extension (fake `exec`, no real git) + the real
 * `createWorkflowChildSpawner` adapter + `attachHostCallHandler` — the same
 * "buildFullStack" harness shape `tests/workflow/a2-window-real-spawn-service.test.ts`
 * already established, extended with the worktree extension and the
 * workflow host layer on top.
 */

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 2_000,
    startupMs: 2_000,
    bindMs: 2_000,
    firstEventMs: 2_000,
    idleMs: 2_000,
    toolMs: 2_000,
    totalMs: 30_000,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 500,
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

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

/** Mirrors `tests/extensions/worktree.test.ts`'s `fakeGit` — no real git, no real fs beyond what the extension itself does (mkdir(root)/(ownersDir), best-effort marker writes). */
function fakeGit(opts: { dirty?: boolean; addCode?: number; removeCode?: number; delayMs?: number } = {}) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const exec: WorktreeExec = async (_cmd, args, commandOpts) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    calls.push({ args: [...args], cwd: commandOpts.cwd });
    if (args[0] === "rev-parse") return ok("/repo\n");
    if (args[0] === "worktree" && args[1] === "add")
      return opts.addCode ? { code: opts.addCode, stdout: "", stderr: "cannot create" } : ok();
    if (args[0] === "status") return ok(opts.dirty === false ? "" : " M file.txt\n");
    if (args[0] === "switch") return ok();
    if (args[0] === "add") return ok(); // "git add -A" — "worktree add" is matched first above
    if (args[0] === "commit") return ok();
    if (args[0] === "worktree" && args[1] === "remove")
      return { code: opts.removeCode ?? 0, stdout: "", stderr: opts.removeCode ? "cannot remove" : "" };
    return ok();
  };
  return { exec, calls };
}

const flatNotifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

function buildFullStack(clock: Clock, driver: SessionDriver, extensions: SubagentExtensionPoints[]) {
  const pool = new SingleSlotPool(clock, 4);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  // Late-bound ref, exactly stack.ts's own wiring (X1): H3's
  // `ctx.setWorktreeDisposition` only ever reaches `SpawnService.
  // markWorktreeDisposition` through this indirection — without it, the
  // service's live `records` map never learns the final disposition, and
  // `waitWorktreeDisposition`'s waiter is only ever resolved by its own
  // (real, non-FakeClock) timeout.
  const worktreeDiag: { current?: (runId: string, disposition: WorktreeDisposal) => void } = {};
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: flatNotifier,
    extensions,
    worktreeDiag,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const svc: SpawnService = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
    budget: { reapMs: 500 },
  });
  worktreeDiag.current = (runId, disposition) => svc.markWorktreeDisposition?.(runId, disposition);
  return { pool, store, svc };
}

function agentTypeRegistryStub(): AgentTypeRegistry {
  return { configHashOf: () => "h1" } as unknown as AgentTypeRegistry;
}

async function drain(clock: FakeClock, ticks: number, stepMs = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // Real setTimeout(0), not just a microtask flush: `createWorkerHost`'s
    // MessagePort-based host_call/host_ack/host_settle traffic (and the
    // fake-worker harness's `commPort.postMessage`) needs a real event-loop
    // tick to be observed — a pure `Promise.resolve()` chain never lets it
    // through, which is why `tests/workflow/host.test.ts`'s own `flush()`
    // uses the same real-timer trick.
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

/** Same fake-worker harness `tests/workflow/host.test.ts`/`host-worktree.test.ts` use. */
function hostHarness(clock: FakeClock, spawner: ChildSpawner, budgetOverrides: Record<string, unknown> = {}) {
  const { spawnWorker, workerData } = fakeSpawnWorkerFactory();
  const workerHost = createWorkerHost({ clock, spawnWorker });
  const sent: unknown[] = [];
  return {
    workerHost,
    sent,
    async boot() {
      await workerHost.boot({
        scriptSource: 'export const meta = { name: "t", description: "t" };',
        scriptSliceMs: 1_000,
        heartbeatMs: 0,
        workerBootMs: 1_000,
        terminateConfirmMs: 500,
      });
      workerData().commPort.on("message", (m) => sent.push(m));
    },
    postHostCall(id: string, op: "agent" | "gate", args: unknown) {
      workerData().commPort.postMessage({ kind: "host_call", id, op, args });
    },
    attach() {
      return attachHostCallHandler({
        clock,
        workerHost,
        spawner,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        budget: {
          hostCallMs: 5_000,
          gateMs: 5_000,
          maxParallel: 4,
          maxChildren: 10,
          maxBatchItems: 10,
          childBudgetPolicy: "inherit_remaining" as const,
          worktreeSettleMaxMs: 10_000,
          ...budgetOverrides,
        },
        workflowDeadlineAt: clock.now() + 60_000,
        defaultAgentType: "worker",
      });
    },
  };
}

describe("workflow-worktree end-to-end (real SpawnService + worktree extension, D1/D2/D5/D7)", () => {
  it("agent({isolation:'worktree'}) rewrites cwd via H2, commits via H3, and the workflow settle carries the branch", async () => {
    const clock = new FakeClock();
    const fake = fakeGit({ dirty: true });
    const worktreeExt = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: await mkdtemp(join(tmpdir(), "pi-wf-wt-happy-")),
    });
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver, [worktreeExt]);
    const spawner = createWorkflowChildSpawner(svc, agentTypeRegistryStub(), { worktreeAvailable: () => true });
    const h = hostHarness(clock, spawner);
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "work", opts: { isolation: "worktree", fullResult: true } });
    await drain(clock, 80);
    const settle = h.sent.find(
      (m) =>
        (m as { kind?: string; callId?: string }).kind === "host_settle" && (m as { callId?: string }).callId === "1",
    ) as { ok: boolean; value?: unknown; worktree?: { state: string; branch?: string } } | undefined;
    expect(settle).toBeDefined();
    expect(settle?.ok).toBe(true);
    expect(settle?.worktree?.state).toBe("committed");
    expect(settle?.worktree?.branch).toMatch(/^pi-agent-/);
    expect(fake.calls.map((c) => c.args[0])).toEqual(
      expect.arrayContaining(["rev-parse", "worktree", "status", "switch", "add", "commit"]),
    );
  }, 15_000);

  it("a clean run (no changes) reports state:'clean' and removes the worktree without a branch", async () => {
    const clock = new FakeClock();
    const fake = fakeGit({ dirty: false });
    const worktreeExt = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: await mkdtemp(join(tmpdir(), "pi-wf-wt-clean-")),
    });
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver, [worktreeExt]);
    const spawner = createWorkflowChildSpawner(svc, agentTypeRegistryStub(), { worktreeAvailable: () => true });
    const h = hostHarness(clock, spawner);
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "work", opts: { isolation: "worktree" } });
    await drain(clock, 80);
    const settle = h.sent.find(
      (m) =>
        (m as { kind?: string; callId?: string }).kind === "host_settle" && (m as { callId?: string }).callId === "1",
    ) as { ok: boolean; worktree?: { state: string } } | undefined;
    expect(settle?.worktree?.state).toBe("clean");
    expect(fake.calls.some((c) => c.args[0] === "commit")).toBe(false);
  }, 15_000);

  it("D2: worktreeAvailable() === false rejects agent({isolation}) outright — H2 never runs, no worktree is ever created", async () => {
    const clock = new FakeClock();
    const fake = fakeGit({ dirty: true });
    const worktreeExt = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: await mkdtemp(join(tmpdir(), "pi-wf-wt-gate-")),
    });
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver, [worktreeExt]);
    const spawner = createWorkflowChildSpawner(svc, agentTypeRegistryStub(), { worktreeAvailable: () => false });
    const h = hostHarness(clock, spawner);
    await h.boot();
    h.attach();
    h.postHostCall("1", "agent", { prompt: "work", opts: { isolation: "worktree" } });
    await drain(clock, 20);
    const ack = h.sent.find(
      (m) => (m as { kind?: string; id?: string }).kind === "host_ack" && (m as { id?: string }).id === "1",
    ) as { ok: boolean; error?: { message: string } } | undefined;
    expect(ack?.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  }, 15_000);

  it("D7/D8: a workflow stop force-settles the isolated call as aborted+pending while H3 keeps running, and the late listener later reports committed — no orphaned worktree", async () => {
    const clock = new FakeClock();
    const fake = fakeGit({ dirty: true, delayMs: 5 }); // a tiny real delay so the stop genuinely races H3
    const worktreeExt = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: await mkdtemp(join(tmpdir(), "pi-wf-wt-abort-")),
    });
    // The session never finishes on its own — it stays genuinely "running"
    // until the runner's own abort sequence calls `requestAbort()`, which
    // here releases the pending prompt immediately (a compliant driver),
    // letting the run settle as `aborted` quickly instead of escalating
    // through the full (10s-default) abortGraceMs ladder.
    let releasePrompt: () => void = () => undefined;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const driver: SessionDriver = {
      create: async () =>
        handle({
          prompt: () => promptGate,
          requestAbort: async () => {
            releasePrompt();
          },
        }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc, store } = buildFullStack(clock, driver, [worktreeExt]);
    const spawner = createWorkflowChildSpawner(svc, agentTypeRegistryStub(), { worktreeAvailable: () => true });
    const h = hostHarness(clock, spawner);
    await h.boot();
    const handler = h.attach();
    h.postHostCall("1", "agent", { prompt: "work", opts: { isolation: "worktree" } });
    await drain(clock, 20); // let the spawn admit, H2 build the worktree, and the run actually bind+start (still "running": prompt() never resolves on its own)
    expect(handler.children.find((c) => c.callId === "1")).toBeUndefined(); // still active, not settled yet
    const stopP = handler.stopOwned("user_stop", 1); // a tiny host-level grace — force-settle wins the race against the real abort
    await drain(clock, 10);
    await stopP;
    const summary = handler.children.find((c) => c.callId === "1");
    expect(summary?.status).toBe("aborted");
    expect(summary?.worktree).toEqual({ state: "pending" });
    expect(summary?.runId).toBeDefined(); // has a runId (real spawn happened)

    // H3 keeps running in the background (D7) and eventually reports back —
    // the late listener folds it into worktreeFinal without ever touching the
    // already-sent (frozen) `pending` settle.
    await drain(clock, 400, 30);
    const final = handler.children.find((c) => c.callId === "1")?.worktreeFinal;
    expect(final).toBeDefined();
    expect(final?.state).toBe("committed"); // dirty tree ⇒ the commit chain ran to completion
    // plan §6 #17: the durable record (store ⇒ run log in production) and the
    // service's live record both converge on the final disposition.
    const runId = summary!.runId!;
    expect(store.get(runId)?.diag?.worktree).toMatchObject({ state: "committed" });
    expect(svc.snapshots().find((snap) => snap.runId === runId)?.diag?.worktree).toMatchObject({
      state: "committed",
    });
    // …and no waiter is left behind: a fresh wait resolves immediately as settled.
    await expect(svc.waitWorktreeDisposition!(runId, { horizon: "settle", capMs: 1 })).resolves.toMatchObject({
      kind: "settled",
    });
    // No orphan: exactly one settle for this callId, ever.
    expect(
      h.sent.filter(
        (m) => (m as { callId?: string }).callId === "1" && (m as { kind?: string }).kind === "host_settle",
      ),
    ).toHaveLength(1);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// P1 test #6 leftover: top-level Agent + workflow child concurrently reading
// the SAME real linkPath, read-only, at the same time — only meaningful once
// the workflow side of isolation actually reaches ChildSpawner.spawn() (D1),
// which is what this package (wf-isolation) delivers.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const realExec = async (cmd: string, args: readonly string[], opts: { cwd?: string; timeout?: number }) => {
  try {
    const r = await execFileAsync(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeout });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
};

async function makeRepoWithLinkPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wf-wt-linkpaths-"));
  await realExec("git", ["init", "-q"], { cwd: dir });
  await realExec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await realExec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, ".gitignore"), "vendor_link/\n");
  await writeFile(join(dir, "a.txt"), "1");
  await realExec("git", ["add", "-A"], { cwd: dir });
  await realExec("git", ["commit", "-qm", "init"], { cwd: dir });
  await mkdir(join(dir, "vendor_link"));
  await writeFile(join(dir, "vendor_link", "lib.js"), "module.exports = 1;\n");
  return dir;
}

describe("D9 linkPaths: top-level Agent AND a workflow child concurrently reading the same real link path (P1 test #6 leftover)", () => {
  it("both an isolated top-level-style spawn and an isolated workflow child commit successfully; the main checkout's linked file never changes", async () => {
    const repo = await makeRepoWithLinkPath();
    const originalCwd = process.cwd();
    // workflow children never carry an explicit `cwd` (D1: `spawner-adapter.ts`
    // doesn't forward one, matching the top-level Agent's own H2 fallback
    // `spec.cwd ?? process.cwd()`) — chdir into the synthetic repo so BOTH
    // sides resolve their worktree from the SAME repo under test, exactly
    // as they would inside a real session whose cwd IS the project root.
    process.chdir(repo);
    try {
      const clock = systemClock;
      const worktreeExt = createWorktreeExtension({
        exec: realExec as unknown as WorktreeExec,
        settings: { enabled: true, linkPaths: ["vendor_link"] },
        worktreeRoot: join(repo, ".wt-concurrent"),
      });
      // The session must stay genuinely "active" (worktree not yet reaped)
      // long enough for both sides to read/write concurrently — `prompt()`
      // never resolves on its own; `requestAbort()` (called by the runner's
      // own abort sequence) releases it, letting the run settle so H3 can
      // commit whatever real change was made in the meantime.
      const releasers: Array<() => void> = [];
      const driver: SessionDriver = {
        create: async () => {
          const idx = releasers.length;
          const gate = new Promise<void>((resolve) => {
            releasers[idx] = resolve;
          });
          return handle({
            prompt: () => gate,
            requestAbort: async () => {
              releasers[idx]?.();
            },
          });
        },
        bind: async () => undefined,
        onLateArrival: () => undefined,
      };
      const { svc } = buildFullStack(clock, driver, [worktreeExt]);

      // "top-level Agent": a direct SpawnService.spawn({isolation}) call —
      // exactly the request agent-tool.ts builds under the hood.
      const topLevel = await svc.spawn({ type: "worker", prompt: "top-level work", isolation: "worktree" });
      if ("error" in topLevel) throw new Error(topLevel.error.message);

      // "workflow child": the SAME svc, reached through the real
      // ChildSpawner adapter this package wires up.
      const spawner = createWorkflowChildSpawner(svc, agentTypeRegistryStub(), { worktreeAvailable: () => true });
      const workflowSpawn = await spawner.spawn({ type: "worker", prompt: "workflow work", isolation: "worktree" });
      if ("error" in workflowSpawn) throw new Error(workflowSpawn.error.message);

      const wtRoot = join(repo, ".wt-concurrent");
      const topWt = join(wtRoot, topLevel.runId);
      const wfWt = join(wtRoot, workflowSpawn.runId);

      // Wait for BOTH H2 hooks to fully finish (worktree + symlink built)
      // before touching any file — the directory existing is unambiguous
      // evidence `git worktree add` + the symlink setup both succeeded; the
      // hanging prompt above guarantees H3 hasn't reaped it out from under us.
      await vi.waitFor(
        async () => {
          const fs = await import("node:fs/promises");
          await fs.access(join(topWt, "vendor_link", "lib.js"));
          await fs.access(join(wfWt, "vendor_link", "lib.js"));
        },
        { timeout: 10_000, interval: 20 },
      );

      // Both worktrees exist and both read through the SAME symlinked
      // vendor_link concurrently — the read-only contract (D9) is exactly
      // "never write under it", so both sides just read.
      const [topLib, wfLib] = await Promise.all([
        import("node:fs/promises").then((fs) => fs.readFile(join(topWt, "vendor_link", "lib.js"), "utf8")),
        import("node:fs/promises").then((fs) => fs.readFile(join(wfWt, "vendor_link", "lib.js"), "utf8")),
      ]);
      expect(topLib).toBe("module.exports = 1;\n");
      expect(wfLib).toBe("module.exports = 1;\n");

      // Each side makes its OWN real change in its own worktree, then both
      // stop (releasing their prompt gate) so H3 can commit.
      await writeFile(join(topWt, "top-change.txt"), "top");
      await writeFile(join(wfWt, "wf-change.txt"), "wf");
      await Promise.all([
        svc.abort(topLevel.runId, "user_stop").catch(() => undefined),
        svc.abort(workflowSpawn.runId, "user_stop").catch(() => undefined),
      ]);
      await vi.waitFor(
        async () => {
          const topBranch = await realExec("git", ["branch", "--list", `pi-agent-${topLevel.runId}`], { cwd: repo });
          const wfBranch = await realExec("git", ["branch", "--list", `pi-agent-${workflowSpawn.runId}`], {
            cwd: repo,
          });
          if (!topBranch.stdout.trim() || !wfBranch.stdout.trim()) throw new Error("branches not committed yet");
        },
        { timeout: 10_000, interval: 100 },
      );

      const topBranch = await realExec("git", ["show", "--name-only", "--format=", `pi-agent-${topLevel.runId}`], {
        cwd: repo,
      });
      const wfBranch = await realExec("git", ["show", "--name-only", "--format=", `pi-agent-${workflowSpawn.runId}`], {
        cwd: repo,
      });
      expect(topBranch.stdout).toContain("top-change.txt");
      expect(topBranch.stdout).not.toContain("vendor_link");
      expect(wfBranch.stdout).toContain("wf-change.txt");
      expect(wfBranch.stdout).not.toContain("vendor_link");

      // The main checkout's linked file is untouched by either side.
      const mainContent = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(repo, "vendor_link", "lib.js"), "utf8"),
      );
      expect(mainContent).toBe("module.exports = 1;\n");
    } finally {
      process.chdir(originalCwd);
      await rm(repo, { recursive: true, force: true });
    }
  }, 20_000);
});
