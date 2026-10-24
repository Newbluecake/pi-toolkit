/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import activate from "../../src/index.js";
import type { RunOutcome } from "../../src/core/types.js";
import type { SpawnServiceDeps } from "../../src/service/spawn-service.js";
import {
  BASELINE,
  emit,
  fakeCtx,
  fakePi,
  persistWake,
  resetGlobals,
  sandbox,
  SID,
  userTrigger,
  wakeEvent,
  type FakeCtx,
  type FakePi,
} from "./helpers/schedule-activate.js";

/**
 * scheduled-reports I1 (plan r3 §14, SC1/SC2/SC3/SC4/SC9/SC10 agent half): REAL `activate()` × fake pi ×
 * real ledger/clock/executors, with the spawn service replaced by a controllable fake (no child sessions).
 * Pins the production wiring that only I1 owns: `installScheduleExecutors` (background + message attach +
 * handoff adapter), `installMessageScheduler` events, notes flush/settled, shutdown order, revocation,
 * `/schedule repair` + `/fabric fence reset` blocker reset, mode refusals.
 */
const harness = vi.hoisted(() => ({
  requests: [] as any[],
  outcome: undefined as undefined | ((req: any, runId: string) => RunOutcome),
  seq: 0,
  gate: undefined as undefined | Promise<void>,
  spawnDeps: undefined as SpawnServiceDeps | undefined,
}));

vi.mock("../../src/service/spawn-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/service/spawn-service.js")>();
  return {
    ...original,
    createSpawnService: (deps: SpawnServiceDeps) => {
      harness.spawnDeps = deps;
      const runs = new Map<string, any>();
      return {
        spawn: async (req: any) => {
          harness.requests.push(req);
          const runId = `r_bg${++harness.seq}`;
          runs.set(runId, req);
          return { runId, slots: { limit: 4, inUse: 1, free: 3 } };
        },
        waitOutcome: async (runId: string) => {
          await harness.gate;
          return { kind: "settled" as const, outcome: harness.outcome!(runs.get(runId), runId) };
        },
        spawnAndWait: async () => {
          throw new Error("unused");
        },
        abort: async () => false,
        waitAll: async () => ({ settled: [], pending: [] }),
        stopChildrenOf: async () => ({ stopped: [], pending: [] }),
        resolveRun: () => ({ ok: false as const, error: "unused" }),
        resolveResume: () => ({ ok: false as const, error: "unused" }),
        snapshots: () => [],
      };
    },
  };
});

function outcomeOf(runId: string, status: RunOutcome["status"], text: string): RunOutcome {
  return {
    runId,
    status,
    text,
    turns: 1,
    durationMs: 5,
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
  };
}

const sb = sandbox();
afterAll(() => sb.cleanup());
let sessionN = 0;
let schedDir = "";

beforeEach(() => {
  resetGlobals();
  harness.requests.length = 0;
  harness.seq = 0;
  harness.gate = undefined;
  harness.outcome = (_req, runId) => outcomeOf(runId, "completed", "昨日提交共 3 条。");
  schedDir = join(sb.home, `sched-${++sessionN}`);
  sb.writeSettings({ ...BASELINE, schedule: { enabled: true, dir: schedDir } });
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
});

interface Session {
  h: FakePi;
  c: FakeCtx;
  file: string;
  tool: (params: Record<string, unknown>) => Promise<any>;
  cmd: (args: string) => Promise<void>;
  shutdown: () => Promise<void>;
  ledger: () => any;
  stateFile: string;
}

async function openSession(opts: { sid?: string; mode?: string } = {}): Promise<Session> {
  const h = fakePi();
  activate(h.pi);
  const file = join(sb.home, `s-${++sessionN}.jsonl`);
  writeFileSync(file, '{"type":"session"}\n');
  h.sessionFile.path = file;
  const c = fakeCtx(sb.home, {
    file,
    ...(opts.sid ? { sid: opts.sid } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
  const sid = opts.sid ?? SID;
  const stateFile = join(schedDir, sid, "state.json");
  return {
    h,
    c,
    file,
    stateFile,
    tool: (params) => h.tools.get("schedule").execute("c1", params, undefined, undefined, c.ctx),
    cmd: (args) => h.commands.get("schedule").handler(args, c.ctx),
    shutdown: async () => void (await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx)),
    ledger: () => JSON.parse(readFileSync(stateFile, "utf8")),
  };
}

async function until(cond: () => boolean, label: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${label}`);
}

describe("background form: create → approve → run → report → note", () => {
  it("AI creates (pending), user approves, /schedule run executes through the real executor; result is a QUIET message with a report file and a note that becomes `written`", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "daily",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "summarize commits",
    });
    expect(r.details).toMatchObject({ ok: true, pending: true });
    const id = r.details.id as string;
    // not approved ⇒ a run is refused (S2)
    await s.cmd(`run ${id}`);
    expect(s.c.notices.at(-1)).toMatch(/E_UNAPPROVED/);
    expect(harness.requests).toHaveLength(0);

    await s.cmd(`approve ${id}`); // ctx.ui.confirm → true (review dialog)
    await s.cmd(`run ${id}`);
    await until(() => s.ledger().runs.some((x: any) => x.state === "completed"), "run completed");

    // A1 SpawnRequest mapping (callerOwned / suppressDelivery / fixed deadline)
    expect(harness.requests[0]).toMatchObject({
      type: "general-purpose",
      prompt: expect.stringContaining("summarize commits"),
      suppressDelivery: true,
      callerOwned: true,
      timeoutPolicy: "fixed",
    });
    const run = s.ledger().runs[0];
    expect(run).toMatchObject({ form: "background", kind: "manual", state: "completed", runId: "r_bg1" });
    const report = join(schedDir, SID, run.reportFile);
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8")).toContain("昨日提交共 3 条。");

    // quiet result message (no new turn), persisted by the fake like pi does
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "result"), "result message");
    const sent = s.h.sent.find((m) => m.message.details?.kind === "result")!;
    expect(sent.options).toEqual({ triggerTurn: false });
    expect(sent.message.content).toContain("昨日提交共 3 条。");
    expect(readFileSync(s.file, "utf8")).toContain(sent.message.details.noteId);

    // agent_settled → quiet period → file proof → note `written`
    await emit(s.h, "agent_settled", { aborted: false }, s.c.ctx);
    await until(() => s.ledger().runs[0].note === "written", "note written");
    await s.shutdown();
  });
});

describe("note proof is driven by agent_settled", () => {
  it("a result delivered while the session is BUSY is only proven after the next agent_settled + quiet period (the A1 notes hook)", async () => {
    const s = await openSession();
    const r = await s.tool({ action: "create", name: "busy", cron: "0 8 * * *", tz: "UTC", prompt: "p" });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    s.c.state.idle = false; // pi is streaming: no idle-time proof can run
    await s.cmd(`run ${id}`);
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "result"), "result sent");
    await new Promise((r2) => setTimeout(r2, 1_400));
    expect(s.ledger().runs[0].note).toBe("pending"); // nothing settled yet
    s.c.state.idle = true;
    await emit(s.h, "agent_settled", { aborted: false }, s.c.ctx);
    await until(() => s.ledger().runs[0].note === "written", "note written after settled");
    await s.shutdown();
  });
});

describe("handoff and its fall-back", () => {
  it("handoff task: the finished background run wakes the main session through the message scheduler (defHash-bound), and a dropped handoff falls back to a quiet recap with the SAME noteId", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "ho",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "check",
      handoff: true,
    });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    await emit(s.h, "before_agent_start", userTrigger(), s.c.ctx); // capability: unknown → observed
    await s.cmd(`run ${id}`);
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "handoff"), "handoff wake sent");
    const wake = s.h.sent.find((m) => m.message.details?.kind === "handoff")!;
    expect(wake.options).toEqual({ triggerTurn: true });
    expect(wake.message.content).toContain("请接手处理。");
    const noteId = wake.message.details.noteId as string;
    const run = s.ledger().runs[0];
    expect(noteId).toBe(run.noteId);

    // authorized start → settle: the main session took the report over
    s.c.state.idle = false;
    await emit(s.h, "before_agent_start", wakeEvent(wake.message.details), s.c.ctx);
    expect(s.c.aborts.n).toBe(0);
    await emit(s.h, "agent_start", { type: "agent_start" }, s.c.ctx);
    await emit(
      s.h,
      "message_start",
      { message: { role: "custom", customType: "subagent:schedule", details: wake.message.details } },
      s.c.ctx,
    );
    await emit(s.h, "context", { messages: [] }, s.c.ctx);
    persistWake(s.h, wake.message);
    await emit(
      s.h,
      "message_end",
      { message: { role: "assistant", content: [{ type: "text", text: "已处理" }] } },
      s.c.ctx,
    );
    s.c.state.idle = true;
    await emit(s.h, "agent_settled", { aborted: false }, s.c.ctx);
    await s.shutdown();
  });

  it("capability absent (legacy trigger shape) ⇒ the handoff is dropped(capability) by A2 and A1 writes a quiet handoff-recap carrying the same noteId", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "ho2",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "check",
      handoff: true,
    });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    await emit(
      s.h,
      "before_agent_start",
      { type: "before_agent_start", prompt: "legacy shape", systemPrompt: "" },
      s.c.ctx,
    );
    await s.cmd(`run ${id}`);
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "handoff-recap"), "recap");
    const recap = s.h.sent.find((m) => m.message.details?.kind === "handoff-recap")!;
    expect(recap.options).toEqual({ triggerTurn: false });
    expect(recap.message.content).not.toContain("请接手处理。");
    expect(s.h.sent.some((m) => m.options?.triggerTurn === true)).toBe(false);
    expect(readFileSync(s.file, "utf8")).toContain(recap.message.details.noteId);
    await s.shutdown();
  });
});

describe("pause revokes a QUEUED handoff in the in-memory dispatcher", () => {
  it("handoff waiting for the trigger capability: /schedule pause ⇒ revokeTask ⇒ dropped(task-changed) ⇒ the adapter falls back to a quiet recap NOW (not after 30 min)", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "ho3",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "check",
      handoff: true,
    });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    await s.cmd(`run ${id}`); // capability stays `unknown` ⇒ the handoff is queued in the dispatcher
    await until(() => s.ledger().runs[0]?.state === "completed", "bg completed");
    await new Promise((r2) => setTimeout(r2, 300));
    expect(s.h.sent.some((m) => m.message.details?.kind === "handoff-recap")).toBe(false);
    await s.cmd(`pause ${id}`);
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "handoff-recap"), "recap after pause");
    expect(s.h.sent.some((m) => m.options?.triggerTurn === true)).toBe(false);
    await s.shutdown();
  });
});

describe("I1 review r1 #3: pause while an AUTO once background run is still working", () => {
  async function autoOnceHandoff(pauseWhileRunning: boolean) {
    vi.useFakeTimers({
      now: Date.parse("2026-01-01T00:00:30Z"),
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    let release!: () => void;
    harness.gate = new Promise<void>((res) => (release = res));
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "once-ho",
      at: "2026-01-01T00:01",
      tz: "UTC",
      prompt: "check",
      handoff: true,
    });
    expect(r.details).toMatchObject({ ok: true });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    await emit(s.h, "before_agent_start", userTrigger(), s.c.ctx); // capability observed
    for (let i = 0; i < 80 && harness.requests.length === 0; i++) await vi.advanceTimersByTimeAsync(500);
    expect(harness.requests).toHaveLength(1); // the auto claim ran: the once task is now enabled:false (the claim's own write)
    expect(s.ledger().tasks.find((t: any) => t.id === id).enabled).toBe(false);
    if (pauseWhileRunning) {
      await vi.advanceTimersByTimeAsync(3_000);
      await s.cmd(`pause ${id}`); // nothing is queued in the dispatcher at this moment
    }
    release(); // the background run completes → A1 hands the report to the dispatcher
    for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(500);
    return s;
  }

  it("control: without a pause the finished run's handoff wakes the main session (claim-disabled once task is forgiven)", async () => {
    const s = await autoOnceHandoff(false);
    expect(s.h.sent.some((m) => m.message.details?.kind === "handoff")).toBe(true);
    await s.shutdown();
  });

  it("pause during the run: the later handoff is REFUSED — a quiet recap with the same noteId, never a wake", async () => {
    const s = await autoOnceHandoff(true);
    expect(s.h.sent.some((m) => m.message.details?.kind === "handoff")).toBe(false);
    expect(s.h.sent.some((m) => m.options?.triggerTurn === true && m.message.details?.kind !== "result")).toBe(false);
    const recaps = s.h.sent.filter((m) => m.message.details?.kind === "handoff-recap");
    expect(recaps).toHaveLength(1); // exactly one quiet recap
    expect(recaps[0]!.message.details.noteId).toBe(s.ledger().runs[0].noteId);
    await s.shutdown();
  });
});

describe("message form: authorization + settle", () => {
  it("manual run of a message task: queued → sent with a token → authorized by before_agent_start → settled with the report; a forged / orphan trigger is aborted", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "msg",
      form: "message",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "say hi",
      feishu: true,
    });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    await emit(s.h, "before_agent_start", userTrigger(), s.c.ctx);
    await s.cmd(`run ${id}`);
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "message"), "message wake sent");
    const wake = s.h.sent.find((m) => m.message.details?.kind === "message")!;
    expect(wake.options).toEqual({ triggerTurn: true });

    // a forged token is an orphan: aborted on sight
    await emit(
      s.h,
      "before_agent_start",
      wakeEvent({ kind: "message", token: "forged", runKey: "x", noteId: "n" }),
      s.c.ctx,
    );
    expect(s.c.aborts.n).toBe(1);

    s.c.state.idle = false;
    await emit(s.h, "before_agent_start", wakeEvent(wake.message.details), s.c.ctx);
    expect(s.c.aborts.n).toBe(1);
    await emit(s.h, "agent_start", { type: "agent_start" }, s.c.ctx);
    await emit(
      s.h,
      "message_start",
      { message: { role: "custom", customType: "subagent:schedule", details: wake.message.details } },
      s.c.ctx,
    );
    await emit(s.h, "context", { messages: [] }, s.c.ctx);
    await emit(
      s.h,
      "message_end",
      { message: { role: "assistant", content: [{ type: "text", text: "hi!" }] } },
      s.c.ctx,
    );
    s.c.state.idle = true;
    await emit(s.h, "agent_settled", { aborted: false }, s.c.ctx);
    await until(() => s.ledger().runs[0].state === "settled", "message run settled");
    expect(s.ledger().runs[0].reportFile).toBeDefined();
    await s.shutdown();
  });

  it("pause / delete revoke the QUEUED run of a message task before it is sent (A2 residual 3)", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "msg",
      form: "message",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "say hi",
    });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    // capability stays `unknown` (no union-shaped event yet) ⇒ the run waits in the queue
    await s.cmd(`run ${id}`);
    await until(() => s.ledger().runs.some((x: any) => x.state === "queued"), "queued");
    await s.cmd(`pause ${id}`);
    await until(() => s.ledger().runs[0].state === "dropped", "revoked");
    expect(s.ledger().runs[0].reason).toBe("task-changed");
    // observing the capability afterwards must NOT send the revoked run
    await emit(s.h, "before_agent_start", userTrigger(), s.c.ctx);
    await new Promise((r2) => setTimeout(r2, 300));
    expect(s.h.sent.some((m) => m.options?.triggerTurn === true)).toBe(false);
    await s.shutdown();
  });
});

describe("local escape hatches", () => {
  it("`/schedule repair` (local) resets the dispatcher's blockers: a lost ui_prompt_end keeps dispatch blocked until it runs", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "msg",
      form: "message",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "say hi",
    });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    await emit(s.h, "before_agent_start", userTrigger(), s.c.ctx);
    await emit(s.h, "ui_prompt_start", { kind: "select", title: "pick" }, s.c.ctx); // its `end` is lost
    await s.cmd(`run ${id}`);
    await new Promise((r2) => setTimeout(r2, 400));
    expect(s.h.sent.some((m) => m.options?.triggerTurn === true)).toBe(false);
    await s.cmd("repair");
    expect(s.c.notices.at(-1)).toMatch(/已重置/);
    await until(() => s.h.sent.some((m) => m.options?.triggerTurn === true), "dispatch resumes after the local reset");
    await s.shutdown();
  });
});

describe("modes and teardown", () => {
  it("print mode: no executors, no arming, a run is refused (E_MODE) and shutdown is clean", async () => {
    const s = await openSession({ mode: "print" });
    const r = await s.tool({ action: "list" });
    expect(r.details.ok === true || r.details.code !== undefined).toBe(true);
    const created = await s.tool({ action: "create", name: "x", cron: "0 8 * * *", tz: "UTC", prompt: "p" });
    expect(created.details).toMatchObject({ ok: false, code: "E_MODE" });
    expect(harness.requests).toHaveLength(0);
    await s.shutdown();
  });

  it("shutdown closes a running background run as unknown(owner-closed) BEFORE the late outcome; the late `completed` only becomes lateOutcome (no report overwrite)", async () => {
    const s = await openSession();
    let release!: () => void;
    harness.gate = new Promise<void>((r2) => (release = r2));
    const r = await s.tool({
      action: "create",
      name: "bg",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "slow",
      feishu: true,
    });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    await s.cmd(`run ${id}`);
    await until(() => s.ledger().runs[0]?.state === "running", "running");
    await s.shutdown(); // schedule.shutdown() (closeEpoch) first, then background.dispose()
    expect(s.ledger().runs[0]).toMatchObject({ state: "unknown", reason: "owner-closed" });
    release();
    await new Promise((r2) => setTimeout(r2, 300));
    const run = s.ledger().runs[0];
    expect(run.state).toBe("unknown");
    expect(run.reportFile).toBeUndefined();
    expect(typeof run.lateOutcome === "string" || run.lateOutcome === undefined).toBe(true);
  });
});

describe("clock: due time fires the executor", () => {
  it("a cron task fires at its minute boundary by itself (real SessionClock → real background executor); the run is `auto` and its tolerance window never leaks a second fire", async () => {
    vi.useFakeTimers({
      now: Date.parse("2026-01-01T00:00:30Z"),
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "every-min",
      cron: "* * * * *",
      tz: "UTC",
      prompt: "ping",
      feishu: true,
    });
    expect(r.details).toMatchObject({ ok: true });
    const id = r.details.id as string;
    await s.cmd(`approve ${id}`);
    for (let i = 0; i < 80 && !(s.ledger().runs ?? []).some((x: any) => x.state === "completed"); i++)
      await vi.advanceTimersByTimeAsync(500);
    const runs = s.ledger().runs as any[];
    expect(runs.filter((x) => x.state === "completed")).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: "auto",
      form: "background",
      scheduledAt: Date.parse("2026-01-01T00:01:00Z"),
    });
    expect(harness.requests).toHaveLength(1);
    // pending report is indexed for the hub (feishu on) and the quiet note went out
    expect(s.ledger().pendingReports).toHaveLength(1);
    expect(s.h.sent.filter((m) => m.message.details?.kind === "result")).toHaveLength(1);
    await s.shutdown();
  });
});

describe("refusals", () => {
  it("a subagent (child) session file never schedules: create ⇒ E_CHILD, no executor, no ledger directory", async () => {
    const h = fakePi();
    activate(h.pi);
    const c = fakeCtx(sb.home, { file: join(sb.home, "child.jsonl") });
    c.ctx.sessionManager.getEntries = () => [
      { type: "session" },
      { type: "custom", customType: "subagent:child", data: {} },
    ];
    await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
    const r = await h.tools
      .get("schedule")
      .execute(
        "c1",
        { action: "create", name: "x", cron: "0 8 * * *", tz: "UTC", prompt: "p" },
        undefined,
        undefined,
        c.ctx,
      );
    expect(r.details).toMatchObject({ ok: false, code: "E_CHILD" });
    expect(existsSync(join(schedDir, SID))).toBe(false);
    await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx);
  });
});
