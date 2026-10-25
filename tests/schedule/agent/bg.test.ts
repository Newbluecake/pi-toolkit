import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBackgroundExecutor, mapBackgroundOutcome } from "../../../src/schedule/agent/bg.js";
import { createScheduleAgent, type ScheduleAgent } from "../../../src/schedule/agent/wire.js";
import { FakeClock } from "../../../src/core/clock.js";
import type { RunOutcome, SpawnRequest } from "../../../src/core/types.js";
import { manualClaim } from "../../../src/schedule/core/claim.js";
import { readReportFile } from "../../../src/schedule/core/reader.js";
import { addTask, approve, env, makeTask, readOk, self, SID, type Env } from "../core/fixtures.js";

const environments: Env[] = [];
const agents: ScheduleAgent[] = [];
afterEach(() => {
  for (const a of agents.splice(0)) a.dispose();
  for (const e of environments.splice(0)) e.cleanup();
});
function outcome(status: RunOutcome["status"], extra: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "r_background",
    status,
    text: "正文：结果",
    turns: 1,
    durationMs: 1,
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
    ...extra,
  };
}
async function setup() {
  const e = env(Date.now());
  environments.push(e);
  const file = join(e.dir, "session.jsonl");
  writeFileSync(file, '{"type":"session"}\n');
  const clock = new FakeClock(e.clock.t);
  let sid = SID;
  const a = createScheduleAgent({
    ctx: { sessionManager: { getSessionId: () => sid } } as never,
    mode: { kind: "interactive", arm: true },
    sessionId: SID,
    self: self(),
    dir: e.storeDir,
    plain: true,
    inVault: () => false,
    clock,
    warn: () => undefined,
    router: undefined,
  });
  agents.push(a);
  const task = approve(makeTask({ ownerCwd: e.dir }));
  const store = a.ensureStore();
  await addTask(store, task, e.clock.t);
  const claim = await manualClaim(store, { taskId: task.id, reqId: "background_request1", holder: a.holder! });
  if (claim.kind !== "started" || !claim.run) throw new Error("fixture claim");
  const sendMessage = vi.fn();
  return {
    e,
    a,
    store,
    task,
    run: claim.run,
    clock,
    file,
    sendMessage,
    switchTo: (s: string) => {
      sid = s;
    },
    notes: { currentSessionId: () => sid, sessionFile: () => file, isIdle: () => true, sendMessage },
  };
}

describe("background executor", () => {
  it.each(["completed", "failed", "timed_out", "aborted"] as const)(
    "maps %s, commits report/index and only sends one quiet note",
    async (status) => {
      const f = await setup();
      const o = outcome(status, {
        error: { kind: "model", message: "provider failed", retryable: false },
        timeoutReason: "queue_timeout",
        diag: { ...outcome(status).diag, stopCause: "user_stop" },
      });
      const spawn = {
        spawn: vi.fn(async () => ({ runId: o.runId, slots: { limit: 1, inUse: 1, free: 0 } })),
        waitOutcome: vi.fn(async () => ({ kind: "settled" as const, outcome: o })),
      };
      const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
      bg.dispatch(f.run, f.task);
      await bg.drain();
      const state = readOk(f.store);
      const run = state.runs[0]!;
      expect(run.state).toBe(status);
      expect(run.reason).toBe(
        { completed: undefined, failed: "model", timed_out: "queue_timeout", aborted: "user_stop" }[status],
      );
      expect(run.note).toBe("pending");
      expect(run.noteHolder).toEqual(f.a.holder);
      expect(state.pendingReports).toHaveLength(1);
      const report = readReportFile(f.store.root, f.store.dirName, run.reportFile!);
      expect(report.kind).toBe("ok");
      if (report.kind === "ok") expect(report.text).toContain("正文：结果");
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
      await bg.notes.flush();
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      bg.dispose();
    },
  );

  it("maps the real SpawnRequest without pool/load rejection policies and without any consult experts", async () => {
    const f = await setup();
    f.task.bg = {
      ...f.task.bg!,
      model: { provider: "p", id: "m" },
      thinking: "high",
      isolation: "worktree",
      timeoutS: 60,
    };
    const spawn = {
      spawn: vi.fn(async (_req: SpawnRequest) => ({ runId: "r_background", slots: { limit: 1, inUse: 1, free: 0 } })),
      waitOutcome: vi.fn(async () => ({ kind: "settled" as const, outcome: outcome("completed") })),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch(f.run, f.task);
    await bg.drain();
    const req = spawn.spawn.mock.calls[0]![0];
    expect(req).toMatchObject({
      type: f.task.bg.type,
      cwd: f.e.dir,
      label: `sched:${f.task.name}`,
      budgetOverride: { totalMs: 60000 },
      timeoutPolicy: "fixed",
      callerOwned: true,
      suppressDelivery: true,
      modelOverride: f.task.bg.model,
      thinkingOverride: "high",
      isolation: "worktree",
    });
    expect(req).not.toHaveProperty("poolFullPolicy");
    expect(req).not.toHaveProperty("loadPolicy");
    expect(req.prompt).toContain("立即运行");
    expect(req.prompt).toContain(f.task.prompt);
    bg.dispose();
  });

  it("legacy bg.consultMain:true is ignored with a visible note and the run is dispatched as an ordinary background run", async () => {
    const f = await setup();
    f.task.bg!.consultMain = true;
    const spawn = {
      spawn: vi.fn(async (_req: SpawnRequest) => ({ runId: "r_background", slots: { limit: 1, inUse: 1, free: 0 } })),
      waitOutcome: vi.fn(async () => ({ kind: "settled" as const, outcome: outcome("completed") })),
    };
    const bg = installBackgroundExecutor(f.a, {
      spawn,
      notes: f.notes,
      clock: f.clock,
    });
    bg.dispatch(f.run, f.task);
    await bg.drain();
    expect(spawn.spawn).toHaveBeenCalledTimes(1);
    expect(f.sendMessage.mock.calls[0]![0].content).toContain("consult-main 已移除");
    bg.dispose();
  });

  it("admission refusal has a report and result", async () => {
    const f = await setup();
    const spawn = {
      spawn: vi.fn(async (_req: SpawnRequest) => ({
        error: { kind: "config" as const, reason: "quota" as const, message: "quota denied", retryable: false },
      })),
      waitOutcome: vi.fn(),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch(f.run, f.task);
    await bg.drain();
    const run = readOk(f.store).runs[0]!;
    expect(run.state).toBe("refused");
    expect(run.reason).toBe("admission:quota");
    expect(f.sendMessage.mock.calls[0]![0].content).toContain("quota denied");
    expect(spawn.waitOutcome).not.toHaveBeenCalled();
    bg.dispose();
  });

  it("pending loops stop at the defensive hard bound and produce unknown(no-outcome)", async () => {
    const f = await setup();
    f.task.bg!.timeoutS = 60;
    let mono = 0;
    const spawn = {
      spawn: vi.fn(async () => ({ runId: "r_background", slots: { limit: 1, inUse: 1, free: 0 } })),
      waitOutcome: vi.fn(async () => {
        mono += 60000;
        return { kind: "pending" as const };
      }),
    };
    const bg = installBackgroundExecutor(f.a, {
      spawn,
      notes: f.notes,
      clock: f.clock,
      monotonic: () => mono,
      waitGraceMs: 60000,
    });
    bg.dispatch(f.run, f.task);
    await bg.drain();
    expect(spawn.waitOutcome).toHaveBeenCalledTimes(2);
    expect(readOk(f.store).runs[0]).toMatchObject({ state: "unknown", reason: "no-outcome" });
    bg.dispose();
  });

  it("close wins: a late outcome only adds audit, with no report, index, message or old ctx access", async () => {
    const f = await setup();
    let settle!: (value: { kind: "settled"; outcome: RunOutcome }) => void;
    const spawn = {
      spawn: vi.fn(async () => ({ runId: "r_background", slots: { limit: 1, inUse: 1, free: 0 } })),
      waitOutcome: vi.fn(
        () =>
          new Promise<{ kind: "settled"; outcome: RunOutcome }>((r) => {
            settle = r;
          }),
      ),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch(f.run, f.task);
    await vi.waitFor(() => expect(spawn.waitOutcome).toHaveBeenCalledOnce());
    await f.a.shutdown();
    f.notes.currentSessionId = () => {
      throw new Error("stale ctx");
    };
    settle({
      kind: "settled",
      outcome: outcome("aborted", { diag: { ...outcome("aborted").diag, stopCause: "shutdown" } }),
    });
    await bg.drain();
    const run = readOk(f.store).runs[0]!;
    expect(run).toMatchObject({ state: "unknown", reason: "owner-closed", lateOutcome: "aborted:shutdown" });
    expect(run.reportFile).toBeUndefined();
    expect(readOk(f.store).pendingReports).toHaveLength(0);
    expect(existsSync(join(f.store.root.real, f.store.dirName, "reports"))).toBe(false);
    expect(f.sendMessage).not.toHaveBeenCalled();
    bg.dispose();
  });

  it("throwing admission is refused and reports the actual exception", async () => {
    const f = await setup();
    const spawn = {
      spawn: vi.fn(async () => {
        throw new Error("admission exploded");
      }),
      waitOutcome: vi.fn(),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch(f.run, f.task);
    await bg.drain();
    expect(readOk(f.store).runs[0]).toMatchObject({ state: "refused", reason: "admission:internal" });
    expect(f.sendMessage.mock.calls[0]![0].content).toContain("admission exploded");
    expect(spawn.waitOutcome).not.toHaveBeenCalled();
    bg.dispose();
  });

  it("a port that ignores waitMs cannot hang the executor", async () => {
    const f = await setup();
    const spawn = {
      spawn: vi.fn(async () => ({ runId: "r_background", slots: { limit: 1, inUse: 1, free: 0 } })),
      waitOutcome: vi.fn(() => new Promise<never>(() => {})),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch(f.run, f.task);
    await vi.waitFor(() => expect(spawn.waitOutcome).toHaveBeenCalledTimes(1));
    // I1 hardening: never rely on ONE advance landing exactly after the deadline timer was armed — keep
    // advancing the fake clock until the run is terminal (a busy host could interleave the async chain).
    for (let i = 0; i < 20 && readOk(f.store).runs[0]?.state === "running"; i++) {
      f.clock.advance(61_000);
      await new Promise((r) => setTimeout(r, 10));
    }
    await bg.drain();
    expect(readOk(f.store).runs[0]).toMatchObject({ state: "unknown", reason: "no-outcome" });
    bg.dispose();
    f.a.dispose(); // schedule.changed() may have armed A0's next occurrence; clear its own timer.
    await new Promise((r) => setTimeout(r, 10)); // let any late changed()/note continuation settle, then dispose again
    f.a.dispose();
    bg.dispose();
    expect(f.clock.pendingTimers).toBe(0);
  });

  it("executor-only dispose closes its epoch before a late child result", async () => {
    const f = await setup();
    let settle!: (v: { kind: "settled"; outcome: RunOutcome }) => void;
    const spawn = {
      spawn: vi.fn(async () => ({ runId: "r_background", slots: { limit: 1, inUse: 1, free: 0 } })),
      waitOutcome: vi.fn(
        () =>
          new Promise<{ kind: "settled"; outcome: RunOutcome }>((r) => {
            settle = r;
          }),
      ),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch(f.run, f.task);
    await vi.waitFor(() => expect(spawn.waitOutcome).toHaveBeenCalledTimes(1));
    bg.dispose();
    await vi.waitFor(() => expect(readOk(f.store).runs[0]?.state).toBe("unknown"));
    settle({ kind: "settled", outcome: outcome("completed") });
    await bg.drain();
    expect(readOk(f.store).runs[0]).toMatchObject({
      state: "unknown",
      reason: "owner-closed",
      lateOutcome: "completed",
    });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects foreign holder and deduplicates dispatch callbacks", async () => {
    const f = await setup();
    const spawn = {
      spawn: vi.fn(async () => ({ error: { kind: "config" as const, message: "no", retryable: false } })),
      waitOutcome: vi.fn(),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch({ ...f.run, holder: { ...f.run.holder, epoch: "foreign" } }, f.task);
    await bg.drain();
    expect(spawn.spawn).not.toHaveBeenCalled();
    bg.dispatch(f.run, f.task);
    bg.dispatch(f.run, f.task);
    await bg.drain();
    expect(spawn.spawn).toHaveBeenCalledTimes(1);
    bg.dispose();
  });

  it("does not write through the old owner after the current session changes", async () => {
    const f = await setup();
    let finish!: (v: { kind: "settled"; outcome: RunOutcome }) => void;
    const spawn = {
      spawn: vi.fn(async () => ({ runId: "r_background", slots: { limit: 1, inUse: 1, free: 0 } })),
      waitOutcome: vi.fn(
        () =>
          new Promise<{ kind: "settled"; outcome: RunOutcome }>((r) => {
            finish = r;
          }),
      ),
    };
    const bg = installBackgroundExecutor(f.a, { spawn, notes: f.notes, clock: f.clock });
    bg.dispatch(f.run, f.task);
    await vi.waitFor(() => expect(spawn.waitOutcome).toHaveBeenCalledOnce());
    f.switchTo("other");
    finish({ kind: "settled", outcome: outcome("completed") });
    await bg.drain();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(readOk(f.store).runs[0]).toMatchObject({ state: "unknown", reason: "owner-closed" });
    expect(existsSync(join(f.store.root.real, f.store.dirName, "reports"))).toBe(false);
    bg.dispose();
  });
});

// The implementation's never branch is checked by tsc; all actual outcome states remain accepted.
const _exhaustive: (o: RunOutcome) => { state: RunOutcome["status"]; reason?: string; text: string } =
  mapBackgroundOutcome;
void _exhaustive;
