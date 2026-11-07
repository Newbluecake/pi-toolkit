import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import {
  createScheduleAgent,
  hasChildMarker,
  isEpochDisposed,
  markEpochDisposed,
  SCHED_DISPOSED_EPOCHS_MAX,
  vaultPredicateOf,
  wireSchedule,
  type ScheduleAgent,
  type ScheduleAgentDeps,
  type ScheduleExecutor,
} from "../../../src/schedule/agent/wire.js";
import type { SchedHubLink } from "../../../src/schedule/agent/coordinator.js";
import { legacyConsultForkDir } from "../../../src/runtime/legacy-consult-forks.js";
import type { SchedAgentFrame } from "../../../src/web-hub/protocol/schedule.js";
import type { RunRecord, ScheduleTask } from "../../../src/schedule/core/spec.js";
import { addTask, approve, makeTask, MIN, self, SID, utc } from "../core/fixtures.js";

const T0 = utc("2026-01-01T00:00:30Z");
const T1 = utc("2026-01-01T00:01:00Z");
const PLAIN = { kind: "plain", vaults: [], config: {} } as never;
const SETTINGS = (dir: string) => ({ enabled: true, dir, defaultTimeoutMs: 1_800_000, maxTimeoutMs: 14_400_000 });

let tmp: string | undefined;
const agents: ScheduleAgent[] = [];
afterEach(() => {
  for (const a of agents.splice(0)) a.dispose();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function mkTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "sched-a0-"));
  return tmp;
}

function ctxOf(over: { id?: string; file?: string | undefined; entries?: unknown[]; mode?: string } = {}) {
  const file = "file" in over ? over.file : "/home/u/.pi/sessions/x.jsonl";
  let id = over.id ?? SID;
  const ctx = {
    mode: over.mode ?? "tui",
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => file,
      getEntries: () => over.entries ?? [],
    },
  };
  return { ctx: ctx as never, switchTo: (next: string) => (id = next) };
}

function agentOn(dir: string, over: Partial<ScheduleAgentDeps> = {}, fake = new FakeClock(T0)) {
  const { ctx, switchTo } = ctxOf();
  const a = createScheduleAgent({
    ctx,
    mode: { kind: "interactive", arm: true },
    sessionId: SID,
    self: self(),
    dir,
    plain: true,
    inVault: () => false,
    clock: fake,
    monotonic: () => fake.now(),
    warn: () => undefined,
    router: undefined,
    storeOpts: { lockTimeoutMs: 300 },
    ...over,
  });
  agents.push(a);
  return { a, fake, switchTo };
}

function recorder(): ScheduleExecutor & { calls: Array<{ run: RunRecord; task: ScheduleTask }> } {
  const calls: Array<{ run: RunRecord; task: ScheduleTask }> = [];
  return { calls, dispatch: (run, task) => calls.push({ run, task }) };
}

const flush = async (a?: ScheduleAgent) => {
  for (let i = 0; i < 6; i++) {
    await a?.clock?.idle();
    await new Promise((r) => setImmediate(r));
  }
};

describe("wireSchedule (activate level)", () => {
  it("registers exactly one turn_start hook that pokes the current agent", () => {
    const on = vi.fn();
    const poke = vi.fn();
    wireSchedule({ on } as never, {
      settings: SETTINGS("/nonexistent/s"),
      agentDir: "/nonexistent",
      secure: PLAIN,
      webHub: false,
      current: () => ({ poke }) as never,
      flockProbe: () => true,
    });
    expect(on.mock.calls.map((c) => c[0])).toEqual(["turn_start"]);
    (on.mock.calls[0]![1] as () => void)();
    expect(poke).toHaveBeenCalledTimes(1);
  });

  it("webHubPort ⇔ webHub ∧ plain; hubConfig creates the store dir 0700 and returns its realpath", () => {
    const base = mkTmp();
    const dir = join(base, "a", "schedules");
    const mk = (webHub: boolean, secure = PLAIN) =>
      wireSchedule({ on: vi.fn() } as never, {
        settings: SETTINGS(dir),
        agentDir: base,
        secure,
        webHub,
        current: () => undefined,
        flockProbe: () => true,
      });
    expect(mk(false).webHubPort).toBeUndefined();
    expect(mk(true, { kind: "locked", reason: "x", vaults: [], config: {} } as never).webHubPort).toBeUndefined();
    const port = mk(true).webHubPort!;
    expect(existsSync(dir)).toBe(false); // nothing touches disk before the hub config is built
    expect(port.hubConfig()).toEqual({ dir, toleranceS: 60 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("a store dir inside a registered vault omits HubConfig.schedule and creates nothing", () => {
    const base = mkTmp();
    const vaultDir = join(base, "vault");
    const dir = join(vaultDir, "schedules");
    const warn = vi.fn();
    const roots = { vault: { dir: vaultDir }, root: vaultDir, mntReal: join(base, "mnt") };
    const w = wireSchedule({ on: vi.fn() } as never, {
      settings: SETTINGS(dir),
      agentDir: base,
      secure: { kind: "plain", vaults: [roots], config: {} } as never,
      webHub: true,
      current: () => undefined,
      flockProbe: () => true,
      warn,
    });
    expect(vaultPredicateOf({ vaults: [roots as never] })(dir)).toBe(true);
    expect(w.webHubPort!.hubConfig()).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    w.webHubPort!.hubConfig();
    expect(warn).toHaveBeenCalledTimes(1); // warned once
  });

  it("createAgent resolves the §3.3 mode from the ctx", () => {
    const w = wireSchedule({ on: vi.fn() } as never, {
      settings: SETTINGS("/nonexistent/s"),
      agentDir: "/nonexistent",
      secure: PLAIN,
      webHub: false,
      current: () => undefined,
      flockProbe: () => true,
    });
    const mode = (o: Parameters<typeof ctxOf>[0]) => {
      const a = w.createAgent({ ctx: ctxOf(o).ctx });
      agents.push(a);
      return a.mode.kind;
    };
    expect(mode({})).toBe("interactive");
    expect(mode({ mode: "rpc" })).toBe("interactive");
    expect(mode({ mode: "print" })).toBe("print");
    expect(mode({ file: undefined })).toBe("ephemeral");
    expect(mode({ entries: [{ type: "session" }, { type: "custom", customType: "subagent:child" }] })).toBe("child");
    expect(mode({ file: join(legacyConsultForkDir(), "fork.jsonl") })).toBe("child");
  });

  it("hasChildMarker only looks at the head entries and never throws on a stale ctx", () => {
    const head = (entries: unknown[]) => hasChildMarker(ctxOf({ entries }).ctx);
    expect(head([{ type: "custom", customType: "subagent:child" }])).toBe(true);
    expect(head([...Array(10).fill({ type: "message" }), { type: "custom", customType: "subagent:child" }])).toBe(
      false,
    );
    const stale = {
      sessionManager: {
        getEntries: () => {
          throw new Error("stale");
        },
      },
    };
    expect(hasChildMarker(stale as never)).toBe(false);
  });
});

describe("schedule agent (per session)", () => {
  it("is lazy: no directory until ensureStore(); readState absent before", () => {
    const base = mkTmp();
    const dir = join(base, "schedules");
    const { a } = agentOn(dir);
    expect(a.store()).toBeUndefined();
    expect(a.readState()).toEqual({ kind: "absent" });
    expect(existsSync(dir)).toBe(false);
    const s = a.ensureStore();
    expect(existsSync(dir)).toBe(true);
    expect(a.store()).toBe(s);
  });

  it("manual run: no executor ⇒ E_UNSUPPORTED and nothing written; with one ⇒ started once, replay never re-dispatches", async () => {
    const base = mkTmp();
    const { a } = agentOn(join(base, "schedules"));
    const s = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: base }));
    await addTask(s, task, T0);
    const rev = s.read().kind === "ok" ? (s.read() as { state: { rev: number } }).state.rev : -1;
    expect(await a.runNow({ taskId: task.id, reqId: "req-0123456789abcdef" })).toMatchObject({
      kind: "refused",
      code: "E_UNSUPPORTED",
    });
    expect((s.read() as { state: { rev: number } }).state.rev).toBe(rev);
    const exec = recorder();
    a.setExecutor("background", exec);
    expect(await a.runNow({ taskId: task.id, reqId: "req-0123456789abcdef" })).toMatchObject({
      kind: "started",
      replay: false,
    });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.run).toMatchObject({ kind: "manual", state: "dispatching", taskId: task.id });
    expect(exec.calls[0]!.task.id).toBe(task.id);
    expect(await a.runNow({ taskId: task.id, reqId: "req-0123456789abcdef" })).toMatchObject({
      kind: "started",
      replay: true,
    });
    expect(exec.calls).toHaveLength(1);
    // the auto watermark is untouched by a manual run (§4.5b)
    const st = (
      s.read() as { state: { occ: Record<string, { firedTotal: number }>; manualTotal: Record<string, number> } }
    ).state;
    expect(st.occ[task.id]!.firedTotal).toBe(0);
    expect(st.manualTotal[task.id]).toBe(1);
  });

  it("manual run refuses when the current session is no longer the owner (E_NOT_OWNER)", async () => {
    const base = mkTmp();
    const { a, switchTo } = agentOn(join(base, "schedules"));
    a.setExecutor("background", recorder());
    const task = approve(makeTask({ ownerCwd: base }));
    await addTask(a.ensureStore(), task, T0);
    switchTo("019a0000-aaaa-7bbb-8ccc-eeeeeeeeeeee");
    expect(await a.runNow({ taskId: task.id, reqId: "req-0123456789abcdef" })).toMatchObject({ code: "E_NOT_OWNER" });
  });

  it("auto fire goes to the registered executor; shutdown closes our open run as unknown(owner-closed)", async () => {
    const base = mkTmp();
    const fake = new FakeClock(T0);
    const { a } = agentOn(join(base, "schedules"), {}, fake);
    const exec = recorder();
    a.setExecutor("background", exec);
    const s = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: base, when: { kind: "cron", expr: "* * * * *", tz: "UTC" } }));
    await addTask(s, task, T0 - MIN);
    await a.start();
    fake.advance(T1 - T0);
    await flush(a);
    expect(exec.calls.map((c) => c.run.runKey)).toEqual([`${task.id}@${T1}`]);
    await a.shutdown();
    expect(a.isDisposed()).toBe(true);
    expect(isEpochDisposed(a.epoch)).toBe(true);
    const run = (s.read() as { state: { runs: RunRecord[] } }).state.runs[0]!;
    expect(run).toMatchObject({ state: "unknown", reason: "owner-closed" });
    expect(fake.pendingTimers).toBe(0);
  });

  it("a claimed run whose form has no executor is never stranded non-terminal", async () => {
    const base = mkTmp();
    const fake = new FakeClock(T0);
    const { a } = agentOn(join(base, "schedules"), {}, fake);
    const exec: ScheduleExecutor = {
      dispatch: () => {
        throw new Error("executor bug");
      },
    };
    a.setExecutor("background", exec);
    const s = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: base }));
    await addTask(s, task, T0);
    expect((await a.runNow({ taskId: task.id, reqId: "req-0123456789abcdef" })).kind).toBe("started");
    await flush();
    expect((s.read() as { state: { runs: RunRecord[] } }).state.runs[0]).toMatchObject({
      state: "refused",
      reason: "admission:executor-error",
    });
  });

  it("non-interactive modes never build a clock and refuse execution with their matrix code", async () => {
    const base = mkTmp();
    for (const [kind, code] of [
      ["print", "E_MODE"],
      ["child", "E_CHILD"],
      ["ephemeral", "E_EPHEMERAL"],
    ] as const) {
      const { a } = agentOn(join(base, "schedules"), { mode: { kind, arm: false } });
      expect(a.clock).toBeUndefined();
      expect(a.gate()?.code).toBe(code);
      expect(await a.runNow({ taskId: "s_abcdefgh", reqId: "req-0123456789abcdef" })).toMatchObject({ code });
    }
  });

  it("with a hub router: ledger writes push sched_changed, sched_run is answered, receipts remove pendingReports", async () => {
    const base = mkTmp();
    const sent: SchedAgentFrame[] = [];
    const l: SchedHubLink = { ready: () => true, send: (f) => sent.push(f) };
    const w = wireSchedule({ on: vi.fn() } as never, {
      settings: SETTINGS(join(base, "schedules")),
      agentDir: base,
      secure: PLAIN,
      webHub: true,
      current: () => undefined,
      flockProbe: () => true,
    });
    w.router!.bindLink(l);
    const a = w.createAgent({ ctx: ctxOf().ctx });
    agents.push(a);
    expect(a.coordinator.kind).toBe("hub");
    expect(w.router!.attached()).toBe(a.coordinator);
    const s = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: base }));
    await addTask(s, task, T0);
    a.setExecutor("background", recorder());
    w.router!.onSchedRun({
      t: "sched_run",
      reqId: "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      sessionId: SID,
      taskId: task.id,
      defHash: task.approval!.hash,
      expiresAt: Date.now() + 30_000,
    });
    await flush();
    await flush();
    expect(sent).toContainEqual({ t: "sched_run_ack", reqId: "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123", result: "started" });
    expect(sent).toContainEqual({ t: "sched_changed", sessionId: SID });
    // pendingReports removal through receipts
    const rid = "b".repeat(64);
    await s.transact((d) => {
      d.pendingReports.push({
        reportId: rid,
        runKey: `${task.id}@m-00000000`,
        taskId: task.id,
        form: "background",
        endedAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        reportFile: `reports/${rid}.md`,
        status: "completed",
      });
      return { value: undefined, write: true };
    });
    w.router!.onSchedReceipts({ t: "sched_receipts", sessionId: SID, reportIds: [rid] });
    await flush();
    await flush();
    expect((s.read() as { state: { pendingReports: unknown[] } }).state.pendingReports).toEqual([]);
    a.dispose();
    expect(w.router!.attached()).toBeUndefined();
  });
});

describe("disposed-epoch registry (process global, FIFO-capped)", () => {
  it("survives module identity (Symbol.for) and evicts the oldest beyond the cap", () => {
    markEpochDisposed("e-first");
    for (let i = 0; i < SCHED_DISPOSED_EPOCHS_MAX; i++) markEpochDisposed(`e-${i}`);
    expect(isEpochDisposed("e-first")).toBe(false);
    expect(isEpochDisposed(`e-${SCHED_DISPOSED_EPOCHS_MAX - 1}`)).toBe(true);
    const g = globalThis as Record<symbol, unknown>;
    expect(g[Symbol.for("pi-subagent:sched-disposed-epochs")]).toBeInstanceOf(Set);
  });
});

describe("ScheduleAgent.onChanged (#61)", () => {
  it("fires on every local ledger write signal, unsubscribes, survives a throwing listener, and is cleared on dispose", () => {
    const dir = join(mkTmp(), "schedules");
    const warns: string[] = [];
    const agent = createScheduleAgent({
      ctx: { sessionManager: { getSessionId: () => SID, getEntries: () => [] } } as never,
      mode: { kind: "interactive", arm: true },
      sessionId: SID,
      self: self(),
      dir,
      plain: true,
      inVault: () => false,
      clock: new FakeClock(T0),
      warn: (m) => void warns.push(m),
      router: undefined,
    });
    agents.push(agent);
    let a = 0;
    let b = 0;
    agent.onChanged(() => {
      throw new Error("bad listener");
    });
    const offA = agent.onChanged(() => void a++);
    agent.onChanged(() => void b++);
    agent.changed();
    expect([a, b]).toEqual([1, 1]);
    expect(warns.some((w) => w.includes("bad listener"))).toBe(true);
    offA();
    agent.changed();
    expect([a, b]).toEqual([1, 2]);
    agent.dispose();
    agent.changed();
    expect([a, b]).toEqual([1, 2]);
    expect(agent.onChanged(() => void a++)()).toBeUndefined(); // disposed: inert unsubscribe
  });
});
