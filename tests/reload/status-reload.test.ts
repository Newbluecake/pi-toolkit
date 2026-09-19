import { describe, expect, it, vi } from "vitest";
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
  ctx: unknown;
}

function harness(runs: RunSnapshot[], opts: { withReload?: boolean; withCtxReload?: boolean } = {}): Harness {
  const fire = vi.fn();
  const ctl = new DeferredReloadController({ fire });
  const deps = { ...baseDeps(runs), reload: ctl } as unknown as StatusCommandDeps;
  if (opts.withReload === false) delete (deps as { reload?: unknown }).reload;
  const notified: string[] = [];
  const reload = vi.fn(async () => undefined);
  const ctx = {
    mode: "tui",
    ui: { notify: (m: string) => notified.push(m) },
    ...(opts.withCtxReload === false ? {} : { reload }),
  };
  return { deps, ctl, notified, reload, fire, ctx };
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

  it("controller end-to-end: arm via command, settle event fires the callback", async () => {
    const h = harness([snapshot({ status: "running" })]);
    await createStatusCommand(h.deps).handler("reload", h.ctx as never);
    h.ctl.handleRunSettled(0);
    expect(h.fire).toHaveBeenCalledTimes(1);
    expect(h.ctl.pending).toBe(false);
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
