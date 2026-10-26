/**
 * A2 — `message.ts`: content builders, the settled-result sink (report + pendingReports in ONE commit),
 * the capability refusal helper, and `installMessageScheduler` (pi event wiring, executor
 * registration, orphan abort without a scheduler, late-bound holder).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import { XsHostCapability } from "../../../src/fabric/xs/host-cap.js";
import { createProcessOccupancy, createProcessRunRegistry } from "../../../src/schedule/agent/dispatch.js";
import {
  createLedgerResultSink,
  installMessageScheduler,
  installScheduleOrphanGuard,
  messageFormRefusal,
  renderReport,
  wakeContent,
  type MessageSchedulerInstall,
} from "../../../src/schedule/agent/message.js";
import { createScheduleAgent, type ScheduleAgent, type ScheduleAgentDeps } from "../../../src/schedule/agent/wire.js";
import { holderOf } from "../../../src/schedule/core/recovery.js";
import { writeReportLocked } from "../../../src/schedule/core/writer.js";
import {
  reportFileOf,
  reportIdOf,
  SCHED_CUSTOM_TYPE,
  SCHED_REPORT_MAX_BYTES,
  SCHED_START_TIMEOUT_MS,
  type RunRecord,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../../../src/schedule/core/spec.js";
import { addTask, approve, env, makeTask, readOk, self, SID, utc, type Env } from "../core/fixtures.js";

const T0 = utc("2026-01-01T00:00:30Z");
const T1 = utc("2026-01-01T00:01:00Z");

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  handlers = new Map<string, Handler[]>();
  sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
  on = (name: string, h: Handler): (() => void) => {
    const arr = this.handlers.get(name) ?? [];
    arr.push(h);
    this.handlers.set(name, arr);
    return () => undefined;
  };
  sendMessage = (message: Record<string, unknown>, options?: Record<string, unknown>): void => {
    this.sent.push({ message, options });
  };
  emit(name: string, event: unknown, ctx: unknown): void {
    for (const h of this.handlers.get(name) ?? []) h(event, ctx);
  }
}

function fakeCtx() {
  const c = {
    idle: true,
    pending: false,
    aborts: 0,
    notes: [] as string[],
    isIdle: () => c.idle,
    hasPendingMessages: () => c.pending,
    abort: () => {
      c.aborts += 1;
    },
    ui: { notify: (m: string) => c.notes.push(m) },
    sessionManager: { getSessionId: () => SID },
  };
  return c;
}

let e: Env;
let fake: FakeClock;
let pi: FakePi;
let cap: XsHostCapability;
let agents: ScheduleAgent[];
let installs: MessageSchedulerInstall[];

beforeEach(() => {
  e = env(T0);
  fake = new FakeClock(T0);
  pi = new FakePi();
  cap = new XsHostCapability();
  cap.observe({ messageType: "user", prompt: "x" });
  agents = [];
  installs = [];
});
afterEach(() => {
  for (const a of agents) a.dispose();
  e.cleanup();
});

function mkAgent(over: Partial<ScheduleAgentDeps> = {}): ScheduleAgent {
  const a = createScheduleAgent({
    ctx: { sessionManager: { getSessionId: () => SID } } as never,
    mode: { kind: "interactive", arm: true },
    sessionId: SID,
    self: self(),
    dir: e.storeDir,
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
  return a;
}

function mkInstall(holder: { current?: { schedule?: ScheduleAgent } }, extra = {}): MessageSchedulerInstall {
  const i = installMessageScheduler(pi as never, holder, {
    clock: fake,
    capability: cap,
    occupancy: createProcessOccupancy(() => false, `occ-msg-${Math.random()}`),
    registry: createProcessRunRegistry(`reg-msg-${Math.random()}`),
    xsWakeOwned: () => false,
    warn: () => undefined,
    ...extra,
  });
  installs.push(i);
  return i;
}

const wake = (token: string, kind = "message") => ({
  type: "before_agent_start",
  messageType: "custom",
  message: { customType: SCHED_CUSTOM_TYPE, details: { kind, token, runKey: "x", noteId: "n" } },
});

describe("content builders", () => {
  const task = makeTask({
    form: "message",
    name: "晨报",
    prompt: "总结昨日提交",
    when: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
  });
  const run = (over: Partial<RunRecord> = {}): RunRecord => ({
    runKey: `${task.id}@${Date.parse("2026-01-01T00:00:00Z")}`,
    taskId: task.id,
    kind: "auto",
    form: "message",
    scheduledAt: Date.parse("2026-01-01T00:00:00Z"),
    defHash: "h",
    state: "queued",
    holder: holderOf(self(), "ep"),
    startedAt: 0,
    note: "none",
    ...over,
  });

  it("wake content: header with the task-tz local time, says it is scheduled, carries the prompt", () => {
    const c = wakeContent(run(), task);
    expect(c.split("\n")[0]).toBe("[定时消息 晨报 · 2026-01-01 08:00]");
    expect(c).toContain("定时");
    expect(c.endsWith("总结昨日提交")).toBe(true);
  });

  it("manual runs say 立即运行", () => {
    expect(wakeContent(run({ kind: "manual" }), task).split("\n")[0]).toBe("[定时消息 晨报 · 立即运行]");
  });

  it("report: title + text, empty text gets a placeholder, bytes capped on a code point boundary", () => {
    const small = renderReport(task, run(), "结果");
    expect(small.toString("utf8")).toBe("# 晨报 · 2026-01-01 08:00\n\n结果\n");
    expect(renderReport(task, run(), "").toString("utf8")).toContain("没有文本输出");
    const big = renderReport(task, run(), "汉".repeat(SCHED_REPORT_MAX_BYTES));
    expect(big.length).toBeLessThanOrEqual(SCHED_REPORT_MAX_BYTES);
    expect(big.toString("utf8")).not.toContain("\uFFFD");
    expect(big.toString("utf8")).toContain("已截断");
  });

  it("messageFormRefusal: only an absent capability refuses (E_UNSUPPORTED)", () => {
    expect(messageFormRefusal(cap)).toBeUndefined();
    expect(messageFormRefusal(new XsHostCapability())).toBeUndefined(); // unknown ⇒ allowed, queued
    const absent = new XsHostCapability();
    absent.observe({ prompt: "legacy" });
    expect(messageFormRefusal(absent)?.code).toBe("E_UNSUPPORTED");
  });
});

describe("settled result sink (一次提交：终态 + 报告文件 + pendingReports)", () => {
  async function setup(over: Partial<ScheduleTask> = {}) {
    const store = e.store(SID, { now: () => fake.now() });
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message", ...over }));
    await addTask(store, task, fake.now());
    const run: RunRecord = {
      runKey: `${task.id}@${T1}`,
      taskId: task.id,
      kind: "auto",
      form: "message",
      scheduledAt: T1,
      defHash: task.approval!.hash,
      state: "bound",
      holder: holderOf(self(), "ep-1"),
      startedAt: T1,
      note: "none",
    };
    await store.transact((d: ScheduleStateFile) => {
      d.runs.push(run);
      return { value: undefined, write: true };
    });
    const sink = createLedgerResultSink({ store: () => store, sessionId: SID, now: () => fake.now() });
    return { store, task, run, sink };
  }

  it("feishu on: report file written, run settled, pendingReports entry — one commit", async () => {
    const { store, task, run, sink } = await setup({ feishu: true });
    expect(await sink.settled({ run, task, text: "daily result" })).toBe(true);
    const st = readOk(store);
    const rec = st.runs.find((r) => r.runKey === run.runKey)!;
    expect(rec).toMatchObject({
      state: "settled",
      reportFile: reportFileOf(task.id, run.scheduledAt, task.when.tz),
      note: "none",
    });
    expect(st.pendingReports).toHaveLength(1);
    expect(st.pendingReports[0]).toMatchObject({
      reportId: reportIdOf(SID, run.runKey),
      runKey: run.runKey,
      form: "message",
      reportFile: rec.reportFile,
    });
    const file = join(e.storeDir, store.dirName, rec.reportFile!);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("daily result");
  });

  it("a short-name collision keeps the existing file and records the allocated suffix in run and pendingReports", async () => {
    const { store, task, run, sink } = await setup({ feishu: true });
    const base = reportFileOf(task.id, run.scheduledAt, task.when.tz);
    expect(
      await writeReportLocked(store, { reportFile: base, data: Buffer.from("previous report"), now: fake.now() }),
    ).toMatchObject({ ok: true, value: { written: true } });
    expect(await sink.settled({ run, task, text: "current result" })).toBe(true);
    const path = base.replace(".md", "-2.md");
    const st = readOk(store);
    expect(st.runs[0]!.reportFile).toBe(path);
    expect(st.pendingReports[0]!.reportFile).toBe(path);
    expect(readFileSync(join(store.root.real, store.dirName, base), "utf8")).toBe("previous report");
    expect(readFileSync(join(store.root.real, store.dirName, path), "utf8")).toContain("current result");
    await sink.settled({ run, task, text: "duplicate result" });
    expect(readOk(store).pendingReports).toHaveLength(1);
    expect(readFileSync(join(store.root.real, store.dirName, path), "utf8")).not.toContain("duplicate result");
  });

  it("feishu off: settled with no report and no index entry", async () => {
    const { store, task, run, sink } = await setup({ feishu: false });
    expect(await sink.settled({ run, task, text: "x" })).toBe(true);
    const st = readOk(store);
    expect(st.runs[0]).toMatchObject({ state: "settled" });
    expect(st.runs[0]!.reportFile).toBeUndefined();
    expect(st.pendingReports).toEqual([]);
  });

  it("reason (run-max / merged) is recorded and an index entry still lands", async () => {
    const { store, task, run, sink } = await setup({ feishu: true });
    await sink.settled({ run, task, text: "partial", reason: "run-max" });
    const st = readOk(store);
    expect(st.runs[0]).toMatchObject({ state: "settled", reason: "run-max" });
    expect(st.pendingReports).toHaveLength(1);
  });

  it("over the report cap ⇒ settled(report-skipped(cap)), no index entry, no file", async () => {
    const { store, task, run } = await setup({ feishu: true });
    const sink = createLedgerResultSink({
      store: () => store,
      sessionId: SID,
      now: () => fake.now(),
      caps: { maxCount: 0, maxBytes: 0, retentionMs: 1 },
    });
    expect(await sink.settled({ run, task, text: "x" })).toBe(true);
    const st = readOk(store);
    expect(st.runs[0]).toMatchObject({ state: "settled", reason: "report-skipped(cap)" });
    expect(st.pendingReports).toEqual([]);
  });

  it("an already-terminal run is left alone (first terminal write wins), no report written", async () => {
    const { store, task, run, sink } = await setup({ feishu: true });
    await store.transact((d: ScheduleStateFile) => {
      d.runs[0]!.state = "unknown";
      d.runs[0]!.reason = "owner-closed";
      return { value: undefined, write: true };
    });
    expect(await sink.settled({ run, task, text: "late" })).toBe(true);
    const st = readOk(store);
    expect(st.runs[0]).toMatchObject({ state: "unknown", reason: "owner-closed" });
    expect(st.pendingReports).toEqual([]);
  });
});

describe("installMessageScheduler", () => {
  it("registers the pi events once and does nothing until a stack attaches", () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    mkInstall(holder);
    for (const name of [
      "before_agent_start",
      "context",
      "message_start",
      "message_end",
      "agent_start",
      "agent_settled",
      "input",
      "ui_prompt_start",
      "ui_prompt_end",
      "session_before_compact",
      "session_compact",
      "session_compact_failed",
      "session_before_tree",
      "session_tree",
      "session_before_switch",
      "session_before_fork",
      "session_shutdown",
      "session_start",
    ])
      expect(pi.handlers.get(name)?.length, name).toBe(1);
    expect(pi.sent).toEqual([]);
  });

  it("attach registers the message executor on an interactive agent only", () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const ctx = fakeCtx();
    const a = mkAgent();
    expect(install.attach(a, ctx as never)).toBeDefined();
    expect(a.gate({ ownerCwd: e.dir, form: "message" } as never)).toBeUndefined(); // executor present
    const printAgent = mkAgent({ mode: { kind: "print", arm: false } });
    expect(install.attach(printAgent, ctx as never)).toBeUndefined();
    expect(printAgent.gate({ ownerCwd: e.dir, form: "message" } as never)?.code).toBe("E_MODE");
    const noHolder = mkAgent({ self: undefined });
    expect(install.attach(noHolder, ctx as never)).toBeUndefined();
  });

  it("orphan abort works with NO scheduler: wake triggers abort, user prompts / foreign / quiet never", () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    mkInstall(holder);
    const ctx = fakeCtx();
    pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctx);
    pi.emit("before_agent_start", { messageType: "custom", message: { customType: "subagent:xs", details: {} } }, ctx);
    pi.emit("before_agent_start", wake("t", "digest"), ctx);
    expect(ctx.aborts).toBe(0);
    pi.emit("before_agent_start", wake("anything"), ctx);
    expect(ctx.aborts).toBe(1);
    pi.emit("before_agent_start", { messageType: "custom", message: { customType: SCHED_CUSTOM_TYPE } }, ctx);
    expect(ctx.aborts).toBe(2);
  });

  it("a stack from before /reload (disposed agent, token of an old epoch) is an orphan for the new stack", async () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const ctx = fakeCtx();
    const oldAgent = mkAgent();
    holder.current = { schedule: oldAgent };
    install.attach(oldAgent, ctx as never);
    const store = oldAgent.ensureStore();
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message", feishu: false }));
    await addTask(store, task, fake.now());
    const run: RunRecord = {
      runKey: `${task.id}@${T1}`,
      taskId: task.id,
      kind: "auto",
      form: "message",
      scheduledAt: T1,
      defHash: task.approval!.hash,
      state: "queued",
      holder: oldAgent.holder!,
      startedAt: T1,
      note: "none",
    };
    await store.transact((d: ScheduleStateFile) => {
      d.runs.push(run);
      return { value: undefined, write: true };
    });
    fake.advance(60_000);
    // drive the old scheduler to send
    install.scheduler(oldAgent)!.enqueue(run, task);
    fake.advance(0);
    await install.scheduler(oldAgent)!.idle();
    fake.advance(3_000);
    await install.scheduler(oldAgent)!.idle();
    expect(pi.sent).toHaveLength(1);
    const token = (pi.sent[0]!.message.details as { token: string }).token;
    // /reload: new stack, old one disposed
    oldAgent.dispose();
    const newAgent = mkAgent();
    holder.current = { schedule: newAgent };
    pi.emit("before_agent_start", wake(token), ctx);
    // 2 = the old scheduler's still-preparing dispatched flight stopped when the new stack attached (r2 #1)
    // + the new stack's orphan abort of the old token
    expect(ctx.aborts).toBe(2);
  });

  it("end to end: clock fires a message task → executor → send → authorize → settle → ledger + report", async () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const ctx = fakeCtx();
    const a = mkAgent();
    holder.current = { schedule: a };
    install.attach(a, ctx as never);
    const store = a.ensureStore();
    const task = approve(
      makeTask({
        ownerCwd: e.dir,
        form: "message",
        feishu: true,
        name: "晨报",
        when: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      }),
    );
    await addTask(store, task, T0);
    await a.start();
    fake.advance(T1 - T0 + 100); // the minute boundary fires the claim
    await a.clock!.idle();
    for (let i = 0; i < 6; i++) {
      await install.scheduler(a)!.idle();
      fake.advance(1_100);
    }
    await install.scheduler(a)!.idle();
    expect(pi.sent.length).toBeGreaterThanOrEqual(1);
    const msg = pi.sent[0]!;
    expect(msg.options).toEqual({ triggerTurn: true });
    expect(msg.message.customType).toBe(SCHED_CUSTOM_TYPE);
    expect(String(msg.message.content)).toContain("[定时消息 晨报");
    const details = msg.message.details as { runKey: string; token: string; kind: string };
    expect(details.kind).toBe("message");

    ctx.idle = false;
    pi.emit("before_agent_start", wake(details.token), ctx);
    expect(ctx.aborts).toBe(0);
    pi.emit("agent_start", { type: "agent_start" }, ctx);
    pi.emit("message_start", { message: { role: "custom", customType: SCHED_CUSTOM_TYPE, details } }, ctx);
    pi.emit("context", { messages: [] }, ctx);
    pi.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "已完成" }] } }, ctx);
    ctx.idle = true;
    pi.emit("agent_settled", { aborted: false }, ctx);
    await install.scheduler(a)!.idle();
    const st = readOk(store);
    const rec = st.runs.find((r) => r.runKey === details.runKey)!;
    expect(rec.state).toBe("settled");
    expect(st.pendingReports.map((p) => p.runKey)).toEqual([details.runKey]);
    expect(ctx.aborts).toBe(0);
  });

  it("human input via the pi input event hands the run over", async () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const ctx = fakeCtx();
    const a = mkAgent();
    holder.current = { schedule: a };
    install.attach(a, ctx as never);
    const sched = install.scheduler(a)!;
    const store = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message", feishu: false }));
    await addTask(store, task, fake.now());
    const run: RunRecord = {
      runKey: `${task.id}@${fake.now()}`,
      taskId: task.id,
      kind: "auto",
      form: "message",
      scheduledAt: fake.now(),
      defHash: task.approval!.hash,
      state: "queued",
      holder: a.holder!,
      startedAt: fake.now(),
      note: "none",
    };
    await store.transact((d: ScheduleStateFile) => {
      d.runs.push(run);
      return { value: undefined, write: true };
    });
    sched.enqueue(run, task);
    fake.advance(0);
    await sched.idle();
    fake.advance(3_000);
    await sched.idle();
    const details = pi.sent[0]!.message.details as { token: string };
    ctx.idle = false;
    pi.emit("before_agent_start", wake(details.token), ctx);
    pi.emit(
      "message_start",
      { message: { role: "custom", customType: SCHED_CUSTOM_TYPE, details: { ...details, kind: "message" } } },
      ctx,
    );
    pi.emit("context", {}, ctx);
    const result = pi.handlers.get("input")![0]!({ text: "hello", source: "interactive" }, ctx);
    expect(result === undefined || (result as { action?: string }).action === "continue").toBe(true);
    await sched.idle();
    expect(readOk(store).runs[0]!.state).toBe("continued");
  });

  it("session_shutdown tears the scheduler down (timers cleared, queued handoffs handed back)", async () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const ctx = fakeCtx();
    ctx.idle = false;
    const a = mkAgent();
    holder.current = { schedule: a };
    install.attach(a, ctx as never);
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message" }));
    const ended: unknown[] = [];
    expect(
      install.enqueueHandoff({
        runKey: "bg@1",
        taskId: task.id,
        task,
        noteId: "n",
        content: "c",
        onEnd: (o) => ended.push(o),
      }),
    ).toBe(true);
    pi.emit("session_shutdown", {}, ctx);
    expect(ended).toEqual([{ kind: "dropped", reason: "owner-closed" }]);
    fake.advance(SCHED_START_TIMEOUT_MS * 100);
    expect(install.statusSuffix()).toBe("");
  });

  it("enqueueHandoff with no attached scheduler is refused (caller falls back to a quiet note)", () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message" }));
    expect(
      install.enqueueHandoff({
        runKey: "bg@1",
        taskId: task.id,
        task,
        noteId: "n",
        content: "c",
        onEnd: () => undefined,
      }),
    ).toBe(false);
  });

  it("capability absent: the capability-drop writes a quiet note (never a trigger) and notifies once", async () => {
    const absent = new XsHostCapability();
    absent.observe({ prompt: "legacy" });
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder, { capability: absent });
    const ctx = fakeCtx();
    const a = mkAgent();
    holder.current = { schedule: a };
    install.attach(a, ctx as never);
    const store = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message", feishu: false, name: "晨报" }));
    await addTask(store, task, fake.now());
    const run: RunRecord = {
      runKey: `${task.id}@${fake.now()}`,
      taskId: task.id,
      kind: "auto",
      form: "message",
      scheduledAt: fake.now(),
      defHash: task.approval!.hash,
      state: "queued",
      holder: a.holder!,
      startedAt: fake.now(),
      note: "none",
    };
    await store.transact((d: ScheduleStateFile) => {
      d.runs.push(run);
      return { value: undefined, write: true };
    });
    install.scheduler(a)!.enqueue(run, task);
    fake.advance(0);
    await install.scheduler(a)!.idle();
    expect(readOk(store).runs[0]).toMatchObject({ state: "dropped", reason: "capability" });
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0]!.options).toEqual({ triggerTurn: false });
    expect(String(pi.sent[0]!.message.content)).toContain("晨报");
    expect(String(pi.sent[0]!.message.content)).toContain("不提供");
    expect((pi.sent[0]!.message.details as { kind: string }).kind).toBe("result");
    expect(ctx.notes).toHaveLength(1);
    expect(install.statusSuffix()).toBe(" · msg off");
  });
});

describe("review r1 — install 层回归", () => {
  async function queuedRun(a: ScheduleAgent) {
    const store = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message", feishu: false }));
    await addTask(store, task, fake.now());
    const run: RunRecord = {
      runKey: `${task.id}@${fake.now()}`,
      taskId: task.id,
      kind: "auto",
      form: "message",
      scheduledAt: fake.now(),
      defHash: task.approval!.hash,
      state: "queued",
      holder: a.holder!,
      startedAt: fake.now(),
      note: "none",
    };
    await store.transact((d: ScheduleStateFile) => {
      d.runs.push(run);
      return { value: undefined, write: true };
    });
    return { task, run };
  }
  async function sendVia(install: MessageSchedulerInstall, a: ScheduleAgent) {
    const sched = install.scheduler(a)!;
    const { task, run } = await queuedRun(a);
    sched.enqueue(run, task);
    fake.advance(0);
    await sched.idle();
    fake.advance(3_000);
    await sched.idle();
    return { sched, run, task, details: pi.sent[0]!.message.details as { token: string; kind: string } };
  }

  it("sched_bound: bound ⇒ coordinator.bound(agentKey, runKey) once; without an agentKey nothing is sent", async () => {
    for (const withKey of [true, false]) {
      pi = new FakePi();
      const calls: Array<[string, string]> = [];
      const real = mkAgent();
      const agent = Object.create(real, {
        coordinator: {
          value: { kind: "hub", changed: () => undefined, bound: (k: string, r: string) => calls.push([k, r]) },
        },
      }) as ScheduleAgent;
      const holder = { current: { schedule: agent } };
      const install = mkInstall(holder, withKey ? { agentKey: () => "agent-key-1" } : {});
      const ctx = fakeCtx();
      install.attach(agent, ctx as never);
      const { run, details } = await sendVia(install, agent);
      ctx.idle = false;
      pi.emit("before_agent_start", wake(details.token), ctx);
      pi.emit("message_start", { message: { role: "custom", customType: SCHED_CUSTOM_TYPE, details } }, ctx);
      expect(calls).toEqual(withKey ? [["agent-key-1", run.runKey]] : []);
    }
  });

  it("no scheduler: an orphan wake is recorded void — a lost abort cannot let its model calls through; settle clears", () => {
    const registry = createProcessRunRegistry(`reg-orphan-${Math.random()}`);
    mkInstall({}, { registry });
    const ctx = fakeCtx();
    ctx.abort = () => {
      ctx.aborts += 1;
      throw new Error("stale ctx");
    };
    pi.emit("before_agent_start", wake("forged"), ctx);
    expect(ctx.aborts).toBe(1);
    pi.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(2);
    pi.emit("agent_settled", {}, ctx);
    pi.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(2);
    pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctx);
    pi.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(2);
  });

  it("/reload while a scheduled run is mid-flight: the new activation (no scheduler yet) refuses its next model call", async () => {
    const registry = createProcessRunRegistry(`reg-reload-${Math.random()}`);
    const holder1: { current?: { schedule?: ScheduleAgent } } = {};
    const install1 = mkInstall(holder1, { registry });
    const ctx = fakeCtx();
    const a1 = mkAgent();
    holder1.current = { schedule: a1 };
    install1.attach(a1, ctx as never);
    const { details } = await sendVia(install1, a1);
    ctx.idle = false;
    pi.emit("before_agent_start", wake(details.token), ctx);
    expect(ctx.aborts).toBe(0);
    pi.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(0);
    // /reload: the old stack is disposed WITHOUT session_shutdown reaching the old scheduler
    a1.dispose(); // marks the epoch disposed process-wide
    const pi2 = new FakePi();
    installMessageScheduler(pi2 as never, {}, { registry, clock: fake, capability: cap, warn: () => undefined });
    pi2.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(1);
  });

  it("feature OFF after /reload: the standalone guard aborts a pending trigger and refuses a void run", () => {
    const registry = createProcessRunRegistry(`reg-guard-${Math.random()}`);
    const pi3 = new FakePi();
    installScheduleOrphanGuard(pi3 as never, { registry, clock: fake, capability: cap, warn: () => undefined });
    const ctx = fakeCtx();
    pi3.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctx);
    pi3.emit("before_agent_start", wake("digest-ish", "digest"), ctx);
    expect(ctx.aborts).toBe(0);
    pi3.emit("before_agent_start", wake("old-token"), ctx);
    expect(ctx.aborts).toBe(1);
    pi3.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(2);
    pi3.emit("agent_settled", {}, ctx);
    pi3.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(2);
    registry.set({ token: "t", epoch: "e", deadlineAt: fake.now() - 1, voided: false, handed: false });
    pi3.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(3); // absolute deadline passed without a hand-over
  });

  it("diagnostics / resetBlockers delegate to the attached scheduler; shutdown detaches it", async () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const ctx = fakeCtx();
    const a = mkAgent();
    holder.current = { schedule: a };
    expect(install.diagnostics()).toBeUndefined();
    install.attach(a, ctx as never);
    pi.emit("ui_prompt_start", {}, ctx);
    expect(install.diagnostics()).toMatchObject({ uiPrompts: 1 });
    install.resetBlockers();
    expect(install.diagnostics()).toMatchObject({ uiPrompts: 0 });
    pi.emit("session_shutdown", {}, ctx);
    expect(install.statusSuffix()).toBe("");
  });

  it("handoff through the install carries its defHash: a paused task falls back instead of waking the session", async () => {
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder);
    const ctx = fakeCtx();
    const a = mkAgent();
    holder.current = { schedule: a };
    install.attach(a, ctx as never);
    a.setExecutor("background", { dispatch: () => undefined }); // A1's executor (the gate requires one)
    const store = a.ensureStore();
    const task = approve(
      makeTask({
        ownerCwd: e.dir,
        form: "background",
        bg: { type: "general-purpose", timeoutS: 60, consultMain: false, handoff: true },
      }),
    );
    await addTask(store, task, fake.now());
    await store.transact((d: ScheduleStateFile) => {
      d.tasks[0]!.enabled = false;
      return { value: undefined, write: true };
    });
    const out: unknown[] = [];
    install.enqueueHandoff({
      runKey: "bg@1",
      taskId: task.id,
      task,
      defHash: task.approval!.hash,
      noteId: "n",
      content: "c",
      onEnd: (o) => out.push(o),
    });
    fake.advance(0);
    await install.scheduler(a)!.idle();
    fake.advance(3_000);
    await install.scheduler(a)!.idle();
    expect(pi.sent).toHaveLength(0);
    expect(out).toEqual([{ kind: "dropped", reason: "task-changed" }]);
  });
});

describe("review r2 — install 层", () => {
  it("real reload: a handed-over run survives agent.dispose() (wire.ts marks the epoch disposed) in a fresh activation", async () => {
    const registry = createProcessRunRegistry(`reg-r2-${Math.random()}`);
    const holder: { current?: { schedule?: ScheduleAgent } } = {};
    const install = mkInstall(holder, { registry });
    const ctx = fakeCtx();
    const a = mkAgent();
    holder.current = { schedule: a };
    install.attach(a, ctx as never);
    const store = a.ensureStore();
    const task = approve(makeTask({ ownerCwd: e.dir, form: "message", feishu: false }));
    await addTask(store, task, fake.now());
    const run: RunRecord = {
      runKey: `${task.id}@${fake.now()}`,
      taskId: task.id,
      kind: "auto",
      form: "message",
      scheduledAt: fake.now(),
      defHash: task.approval!.hash,
      state: "queued",
      holder: a.holder!,
      startedAt: fake.now(),
      note: "none",
    };
    await store.transact((d: ScheduleStateFile) => {
      d.runs.push(run);
      return { value: undefined, write: true };
    });
    const sched = install.scheduler(a)!;
    sched.enqueue(run, task);
    fake.advance(0);
    await sched.idle();
    fake.advance(3_000);
    await sched.idle();
    const details = pi.sent[0]!.message.details as { token: string };
    ctx.idle = false;
    pi.emit("before_agent_start", wake(details.token), ctx);
    pi.emit(
      "message_start",
      { message: { role: "custom", customType: SCHED_CUSTOM_TYPE, details: { ...details, kind: "message" } } },
      ctx,
    );
    pi.emit("context", {}, ctx);
    pi.handlers.get("input")![0]!({ text: "hello", source: "interactive" }, ctx);
    await sched.idle();
    pi.emit("session_shutdown", {}, ctx);
    a.dispose(); // marks the epoch disposed process-wide, like a real reload
    const pi2 = new FakePi();
    installMessageScheduler(pi2 as never, {}, { registry, clock: fake, capability: cap, warn: () => undefined });
    pi2.emit("context", {}, ctx);
    expect(ctx.aborts).toBe(0); // the human's run is not refused
  });
});
