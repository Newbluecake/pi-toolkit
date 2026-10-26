import { afterEach, describe, expect, it, vi } from "vitest";
import { createReloadCommandPort } from "../../src/reload/command-port.js";
import { consumeReloadContinue } from "../../src/reload/continue.js";
import { createStatusCommand } from "../../src/commands/status.js";
import type { StatusCommandDeps } from "../../src/commands/status.js";
import { DeferredReloadController } from "../../src/reload/defer.js";
import type { RunSnapshot } from "../../src/core/types.js";

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
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
    },
    updatedAt: 0,
    ...overrides,
  };
}

function baseDeps(runs: RunSnapshot[]) {
  return {
    query: {
      list: () => runs,
      get: () => undefined,
      wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    },
    orphans: {
      register: () => undefined,
      recordLateRecovered: () => undefined,
      recent: [],
      totalCount: 0,
      lateRecoveredCount: 0,
      countInWindow: () => 0,
      byReason: new Map(),
      resetCircuit: () => undefined,
    },
    notifier: {
      enqueue: () => undefined,
      consume: () => false,
      reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
      verifyPersisted: () => ({ missing: [] }),
      stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      degraded: [],
    },
  };
}

interface Harness {
  deps: StatusCommandDeps;
  ctl: DeferredReloadController;
  notified: string[];
  reload: ReturnType<typeof vi.fn>;
  fire: ReturnType<typeof vi.fn>;
  ctx: ReturnType<typeof commandContext>;
  sendMessage: ReturnType<typeof vi.fn>;
  state: { idle: boolean; queued: boolean };
}

function commandContext(state: { idle: boolean; queued: boolean }) {
  return {
    mode: "tui",
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
    waitForIdle: async () => {
      state.idle = true;
    },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" },
  };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:reload-continue")];
});

function harness(runs: RunSnapshot[], opts: { withReload?: boolean; withCtxReload?: boolean } = {}): Harness {
  const fire = vi.fn();
  const ctl = new DeferredReloadController({ fire });
  const sendMessage = vi.fn();
  const deps = {
    ...baseDeps(runs),
    reload: createReloadCommandPort(() => ctl, { sendMessage }),
  } as unknown as StatusCommandDeps;
  if (opts.withReload === false) delete (deps as { reload?: unknown }).reload;
  const notified: string[] = [];
  const reload = vi.fn(async () => undefined);
  const state = { idle: true, queued: false };
  const ctx = {
    ...commandContext(state),
    ui: { notify: (m: string) => notified.push(m) },
    ...(opts.withCtxReload === false ? {} : { reload }),
  };
  return { deps, ctl, notified, reload, fire, ctx, sendMessage, state };
}

describe("/agent reload", () => {
  it("arms and notifies when runs are active; does not reload", async () => {
    const h = harness([snapshot({ status: "running" }), snapshot({ status: "completed" })]);
    await createStatusCommand(h.deps).handler("reload", h.ctx as never);
    expect(h.ctl.pending).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.notified[0]).toContain("1 run(s) active");
    expect(h.notified[0]).toContain("/agent reload now");
    expect(h.notified[0]).toContain("/agent reload cancel");
  });

  it("reloads immediately when the fleet is idle", async () => {
    const h = harness([snapshot({ status: "completed" })]);
    await createStatusCommand(h.deps).handler("reload", h.ctx as never);
    expect(h.ctl.pending).toBe(false);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("counts active workflows as busy", async () => {
    const h = harness([]);
    (h.deps as { workflow?: unknown }).workflow = {
      activity: { list: () => [{ workflowId: "w1" }] },
    };
    await createStatusCommand(h.deps).handler("reload", h.ctx as never);
    expect(h.ctl.pending).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("cancel disarms and reports", async () => {
    const h = harness([snapshot({ status: "running" })]);
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    expect(h.ctl.pending).toBe(true);
    await cmd.handler("reload cancel", h.ctx as never);
    expect(h.ctl.pending).toBe(false);
    expect(h.notified.at(-1)).toContain("cancelled");
    // settling after cancel must not fire the deferred reload
    h.ctl.handleRunSettled(0);
    expect(h.fire).not.toHaveBeenCalled();
  });

  it("now forces a reload and disarms", async () => {
    const h = harness([snapshot({ status: "running" })]);
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    await cmd.handler("reload now", h.ctx as never);
    expect(h.ctl.pending).toBe(false);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("fire re-checks: still busy → stays armed, no reload", async () => {
    const h = harness([snapshot({ status: "running" })]);
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    await cmd.handler("reload fire", h.ctx as never);
    expect(h.ctl.pending).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.notified.at(-1)).toContain("stays deferred");
  });

  it("fire re-checks: drained → disarm, notify, reload", async () => {
    const runs = [snapshot({ status: "running" })];
    const h = harness(runs);
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    // the run settles between arming and the followUp fire landing
    runs[0] = snapshot({ status: "completed" });
    await cmd.handler("reload fire", h.ctx as never);
    expect(h.ctl.pending).toBe(false);
    expect(h.notified.at(-1)).toContain("settled");
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  // admitted-run-visibility fix (2026-10-08 incident): the registry can show ZERO
  // runs (the only one in flight is a resume whose runner has not emitted its
  // first snapshot yet) while SpawnService's own admission-time truth
  // (`running` set, surfaced as `admittedRunIds`) still knows about it — the fire
  // re-count must union the two, or `/agent reload fire` reloads a run straight
  // out from under tracking (the actual incident this fix addresses).
  it("fire re-checks: admitted-but-unobserved run (empty registry) → stays deferred", async () => {
    const runs = [snapshot({ status: "running" })];
    const h = harness(runs);
    (h.deps as { admittedRunIds?: () => readonly string[] }).admittedRunIds = () => ["r_ADMITTED"];
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    expect(h.ctl.pending).toBe(true);
    // the tracked run settles, but the admitted-but-unobserved run is still
    // reported as admitted (no registry snapshot for it exists yet)
    runs.length = 0;
    await cmd.handler("reload fire", h.ctx as never);
    expect(h.ctl.pending).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.notified.at(-1)).toContain("stays deferred");
  });

  it("controller end-to-end: arm via command, settle event fires the callback", async () => {
    const h = harness([snapshot({ status: "running" })]);
    await createStatusCommand(h.deps).handler("reload", h.ctx as never);
    h.ctl.handleRunSettled(0);
    expect(h.fire).toHaveBeenCalledTimes(1);
    // Keep dispatches blocked until the queued command actually reloads.
    expect(h.ctl.pending).toBe(true);
  });

  it("without a wired controller, points at the built-in /reload", async () => {
    const h = harness([], { withReload: false });
    await createStatusCommand(h.deps).handler("reload", h.ctx as never);
    expect(h.notified[0]).toContain("built-in /reload");
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("degrades to a manual hint when ctx.reload is unavailable", async () => {
    const h = harness([], { withCtxReload: false });
    await createStatusCommand(h.deps).handler("reload", h.ctx as never);
    expect(h.notified[0]).toContain("run /reload manually");
  });

  it("rejects unknown actions with usage", async () => {
    const h = harness([]);
    await createStatusCommand(h.deps).handler("reload frobnicate", h.ctx as never);
    expect(h.notified[0]).toContain("Unknown reload action");
    expect(h.reload).not.toHaveBeenCalled();
  });
});

describe("reload model coordination", () => {
  it.each([true, false])("first arm notifies exactly once (idle=%s)", async (idle) => {
    const h = harness([snapshot({ status: "running" })]);
    h.state.idle = idle;
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    h.state.idle = !idle;
    await cmd.handler("reload", h.ctx as never);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(
      { customType: "subagent:reload-pending", display: true, content: expect.stringContaining("等待 1 个") },
      { deliverAs: idle ? "nextTurn" : "steer" },
    );
    const content = h.sendMessage.mock.calls[0]![0].content;
    expect(content).toContain("Agent / SubagentWorkflow（会被拒绝）");
    expect(content).toContain("后台 bash 任务");
    expect(content).toContain("自动通知你继续");
    expect(h.ctl.interruptedAtArm).toBe(!idle);
  });

  it.each([true, false])("cancel notifies only if pending, using current idle=%s", async (idle) => {
    const h = harness([snapshot({ status: "running" })]);
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    h.sendMessage.mockClear();
    h.state.idle = idle;
    await cmd.handler("reload cancel", h.ctx as never);
    await cmd.handler("reload cancel", h.ctx as never);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(
      { customType: "subagent:reload-pending", display: true, content: expect.stringContaining("reload 已取消") },
      { deliverAs: idle ? "nextTurn" : "steer" },
    );
    expect(h.ctl.interruptedAtArm).toBe(false);
  });

  it("cancel after drain invalidates the queued fire", async () => {
    const runs = [snapshot({ status: "running" })];
    const h = harness(runs);
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", h.ctx as never);
    runs.length = 0;
    h.ctl.handleRunSettled(0);
    await cmd.handler("reload cancel", h.ctx as never);
    await cmd.handler("reload fire", h.ctx as never);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it.each([
    { armStreaming: true, streaming: false, queued: false, expected: true },
    { armStreaming: false, streaming: true, queued: false, expected: true },
    { armStreaming: false, streaming: false, queued: true, expected: true },
    { armStreaming: false, streaming: false, queued: false, expected: false },
  ])("fire records unfinished work: %j", async ({ armStreaming, streaming, queued, expected }) => {
    const runs = [snapshot({ status: "running" })];
    const h = harness(runs);
    const cmd = createStatusCommand(h.deps);
    h.state.idle = !armStreaming;
    await cmd.handler("reload", h.ctx as never);
    h.state.idle = !streaming;
    h.state.queued = queued;
    runs.length = 0;
    h.ctl.handleRunSettled(0);
    h.reload.mockImplementation(async () => {
      // Assert the handoff exists BEFORE invoking the actual reload implementation.
      expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(expected);
    });
    await cmd.handler("reload fire", h.ctx as never);
    if (streaming) {
      expect(h.reload).not.toHaveBeenCalled();
      // The parked wait re-sends a fire; this harness records it instead of dispatching.
      await Promise.resolve();
      await Promise.resolve();
      await cmd.handler("reload fire", h.ctx as never);
    }
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.ctl.pending).toBe(false);
  });

  it.each(["reload now"])("%s immediately marks only unfinished work, without pending messages", async (action) => {
    const h = harness([]);
    h.state.idle = false;
    await createStatusCommand(h.deps).handler(action, h.ctx as never);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
  });

  it("now preserves the first-arm interruption even if currently idle", async () => {
    const h = harness([snapshot({ status: "running" })]);
    const cmd = createStatusCommand(h.deps);
    h.state.idle = false;
    await cmd.handler("reload", h.ctx as never);
    h.state.idle = true;
    await cmd.handler("reload now", h.ctx as never);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
    expect(h.sendMessage).toHaveBeenCalledTimes(1); // arm only, never cancel on force
  });

  it("failed reload rolls back the continuation handoff", async () => {
    const h = harness([]);
    h.state.queued = true;
    h.reload.mockRejectedValue(new Error("reload failed"));
    await expect(createStatusCommand(h.deps).handler("reload now", h.ctx as never)).rejects.toThrow("reload failed");
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
  });

  it.each(["rpc", "print"])("missing reload API in %s has no coordination side effects", async (mode) => {
    const h = harness([snapshot({ status: "running" })], { withCtxReload: false });
    h.state.idle = false;
    const ctx = { ...h.ctx, mode };
    const cmd = createStatusCommand(h.deps);
    await cmd.handler("reload", ctx as never);
    await cmd.handler("reload now", ctx as never);
    expect(h.ctl.pending).toBe(false);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    expect(consumeReloadContinue(ctx as never, "reload")).toBe(false);
  });
});
