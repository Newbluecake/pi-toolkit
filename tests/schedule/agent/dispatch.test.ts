/**
 * A2 — message scheduler state machine (plan r3 §6.2, §14 「调度器（R2-4）」).
 * Real SessionStore (flock) + FakeClock + fake host; the pi-free `createMessageScheduler` only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock, TimerHandle } from "../../../src/core/clock.js";
import { FakeClock } from "../../../src/core/clock.js";
import { XsHostCapability } from "../../../src/fabric/xs/host-cap.js";
import {
  createMessageScheduler,
  createProcessOccupancy,
  readScheduleTrigger,
  SCHED_MSG_ABORT_GRACE_MS,
  SCHED_MSG_POLL_MS,
  type HandoffOutcome,
  type MessageScheduler,
  type MessageSchedulerDeps,
  createProcessRunRegistry,
  judgeScheduledContext,
  type OccupancySlot,
  type ScheduledRunRegistry,
  type SchedResultSink,
} from "../../../src/schedule/agent/dispatch.js";
import {
  SCHED_CAPABILITY_UNKNOWN_MAX_MS,
  SCHED_CUSTOM_TYPE,
  SCHED_QUIET_MS,
  SCHED_RUN_MAX_MS,
  SCHED_START_TIMEOUT_MS,
  type RunRecord,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../../../src/schedule/core/spec.js";
import { addTask, approve, env, holder, makeTask, readOk, SID, utc, type Env } from "../core/fixtures.js";

const T0 = utc("2026-01-01T00:00:00Z");
const EPOCH = "ep-1";

interface Sent {
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown> };
  options: { triggerTurn: boolean };
}

class Host {
  idle = true;
  pending = false;
  sent: Sent[] = [];
  aborts = 0;
  throwOnSend = false;
  abortThrows = false;
  onSend: (() => void) | undefined;
  isIdle = (): boolean => this.idle;
  hasPendingMessages = (): boolean => this.pending;
  sendMessage = (message: Sent["message"], options: Sent["options"]): void => {
    if (this.throwOnSend) throw new Error("boom");
    this.sent.push({ message, options });
    this.onSend?.();
  };
  abort = (): void => {
    this.aborts += 1;
    if (this.abortThrows) throw new Error("stale ctx");
  };
}

interface SettledCall {
  runKey: string;
  text: string;
  reason: string | undefined;
}

let e: Env;
let fake: FakeClock;
let host: Host;
let cap: XsHostCapability;
let occ: OccupancySlot;
let reg: ScheduledRunRegistry;
let disposedEpochs: Set<string>;
let settledCalls: SettledCall[];
let notices: Array<{ reason: string; runKey: string }>;
let notifies: string[];
let schedulers: MessageScheduler[];
let seq: number;

beforeEach(() => {
  e = env(T0);
  fake = new FakeClock(T0);
  e.clock.now = () => fake.now();
  host = new Host();
  cap = new XsHostCapability();
  cap.observe({ messageType: "user", prompt: "x" }); // union shape ⇒ observed
  occ = createProcessOccupancy(() => false, `occ-test-${Math.random()}`);
  reg = createProcessRunRegistry(`reg-test-${Math.random()}`);
  disposedEpochs = new Set();
  settledCalls = [];
  notices = [];
  notifies = [];
  schedulers = [];
  seq = 0;
});
afterEach(() => {
  for (const s of schedulers) s.shutdown();
  e.cleanup();
});

function build(over: Partial<MessageSchedulerDeps> = {}, epoch = EPOCH): MessageScheduler {
  const store = e.store(SID, { now: () => fake.now(), epoch });
  const sink: SchedResultSink = {
    settled: async (info) => {
      settledCalls.push({ runKey: info.run.runKey, text: info.text, reason: info.reason });
      const r = await store.transact((draft, ctx) => {
        const run = draft.runs.find((x) => x.runKey === info.run.runKey)!;
        run.state = "settled";
        if (info.reason !== undefined) run.reason = info.reason;
        run.endedAt = ctx.now;
        return { value: true, write: true };
      });
      return r.ok;
    },
  };
  const s = createMessageScheduler({
    sessionId: SID,
    holder: holder(epoch),
    store: () => store,
    gate: () => undefined,
    isDisposed: () => false,
    changed: () => undefined,
    host,
    results: sink,
    contentFor: (run, task) => `${task.name}:${run.runKey}`,
    notice: (info) => notices.push({ reason: info.reason, runKey: info.run.runKey }),
    notify: (m) => notifies.push(m),
    clock: fake,
    capability: cap,
    occupancy: occ,
    registry: reg,
    epochDisposed: (ep) => disposedEpochs.has(ep),
    newId: () => `id${++seq}`,
    ...over,
  });
  schedulers.push(s);
  return s;
}

async function mkRun(
  task: ScheduleTask,
  t = fake.now(),
  over: Partial<RunRecord> = {},
  epoch = EPOCH,
): Promise<RunRecord> {
  const store = e.store(SID, { now: () => fake.now() });
  const run: RunRecord = {
    runKey: `${task.id}@${t}`,
    taskId: task.id,
    kind: "auto",
    form: "message",
    scheduledAt: t,
    defHash: task.approval!.hash,
    state: "queued",
    holder: holder(epoch),
    startedAt: t,
    note: "none",
    ...over,
  };
  const r = await store.transact((d: ScheduleStateFile) => {
    d.runs.push(run);
    return { value: undefined, write: true };
  });
  if (!r.ok) throw new Error(r.detail);
  return run;
}

async function mkTask(over: Partial<ScheduleTask> = {}): Promise<ScheduleTask> {
  const task = approve(makeTask({ form: "message", feishu: false, ...over }));
  const store = e.store(SID, { now: () => fake.now() });
  await addTask(store, task, fake.now());
  return task;
}

const stateOf = (): ScheduleStateFile => readOk(e.store(SID, { now: () => fake.now() }));
const runOf = (key: string): RunRecord => stateOf().runs.find((r) => r.runKey === key)!;

/** Let the scheduler's pump run (timer 0 + pending ledger work). */
async function drive(s: MessageScheduler, advanceMs = 0): Promise<void> {
  fake.advance(advanceMs);
  await s.idle();
  fake.advance(0);
  await s.idle();
}

const wakeEvent = (token: string, kind = "message", extra: Record<string, unknown> = {}) => ({
  type: "before_agent_start",
  messageType: "custom",
  message: { customType: SCHED_CUSTOM_TYPE, details: { kind, token, runKey: "x", noteId: "n", ...extra } },
});
const userEvent = { type: "before_agent_start", messageType: "user", prompt: "hi" };
const customStart = (token: string, kind = "message") => ({
  role: "custom",
  customType: SCHED_CUSTOM_TYPE,
  details: { kind, token },
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** enqueue + drive until the message was sent; returns the token. */
async function sendOne(s: MessageScheduler, task: ScheduleTask): Promise<{ run: RunRecord; token: string }> {
  const run = await mkRun(task);
  s.enqueue(run, task);
  await drive(s);
  expect(host.sent.length).toBeGreaterThan(0);
  const last = host.sent[host.sent.length - 1]!;
  return { run, token: last.message.details.token as string };
}

/** Full happy start: sent → authorized → bound → first model call. */
async function startRun(s: MessageScheduler, task: ScheduleTask) {
  const out = await sendOne(s, task);
  host.idle = false;
  expect(s.onBeforeAgentStart(wakeEvent(out.token))).toBe("authorized");
  s.onAgentStart();
  s.onMessageStart(customStart(out.token));
  s.onContext();
  await s.idle();
  return out;
}

describe("readScheduleTrigger", () => {
  it("classifies our wake kinds, quiet kinds and foreign triggers", () => {
    expect(readScheduleTrigger(userEvent)).toEqual({ kind: "none" });
    expect(readScheduleTrigger({ messageType: "custom", message: { customType: "subagent:xs" } })).toEqual({
      kind: "none",
    });
    expect(readScheduleTrigger(wakeEvent("t1"))).toEqual({ kind: "wake", wake: "message", token: "t1" });
    expect(readScheduleTrigger(wakeEvent("t2", "handoff"))).toEqual({ kind: "wake", wake: "handoff", token: "t2" });
    expect(readScheduleTrigger(wakeEvent("t3", "result"))).toEqual({ kind: "quiet" });
    expect(readScheduleTrigger({ messageType: "custom", message: { customType: SCHED_CUSTOM_TYPE } })).toEqual({
      kind: "wake",
      wake: "unknown",
    });
  });
});

describe("happy path (§6.2 状态机)", () => {
  it("queued → dispatched → authorized → bound → settled, with ledger transitions and one send", async () => {
    const s = build();
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.options).toEqual({ triggerTurn: true });
    expect(host.sent[0]!.message.customType).toBe(SCHED_CUSTOM_TYPE);
    expect(host.sent[0]!.message.display).toBe(true);
    expect(host.sent[0]!.message.details).toMatchObject({ kind: "message", runKey: run.runKey, token });
    expect(typeof host.sent[0]!.message.details.noteId).toBe("string");
    expect(runOf(run.runKey).state).toBe("dispatched");

    host.idle = false;
    expect(s.onBeforeAgentStart(wakeEvent(token))).toBe("authorized");
    expect(host.aborts).toBe(0);
    s.onAgentStart();
    s.onMessageStart(customStart(token));
    await s.idle();
    expect(runOf(run.runKey).state).toBe("bound");
    s.onContext();
    s.onMessageEnd(assistant("first"));
    s.onMessageEnd(assistant("final answer"));
    host.idle = true;
    s.onAgentSettled({ aborted: false });
    await s.idle();
    expect(settledCalls).toEqual([{ runKey: run.runKey, text: "final answer", reason: undefined }]);
    expect(runOf(run.runKey).state).toBe("settled");
    expect(host.aborts).toBe(0);
  });

  it("D13: a newer queued entry of the same task supersedes the older in memory; only one send", async () => {
    const s = build();
    const task = await mkTask();
    host.idle = false; // nothing may send yet
    const a = await mkRun(task, fake.now());
    s.enqueue(a, task);
    // S1 claim marks the older one dropped(coalesced) in the ledger before the new run exists.
    const store = e.store(SID, { now: () => fake.now() });
    await store.transact((d: ScheduleStateFile) => {
      const r = d.runs.find((x) => x.runKey === a.runKey)!;
      r.state = "dropped";
      r.reason = "coalesced";
      return { value: undefined, write: true };
    });
    const b = await mkRun(task, fake.now() + 60_000);
    s.enqueue(b, task);
    host.idle = true;
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.message.details.runKey).toBe(b.runKey);
    expect(runOf(a.runKey).state).toBe("dropped");
  });

  it("a queued run the ledger no longer shows as queued is discarded without sending", async () => {
    const s = build();
    const task = await mkTask();
    const a = await mkRun(task);
    const store = e.store(SID, { now: () => fake.now() });
    await store.transact((d: ScheduleStateFile) => {
      d.runs.find((x) => x.runKey === a.runKey)!.state = "dropped";
      return { value: undefined, write: true };
    });
    s.enqueue(a, task);
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
  });

  it("a task paused or redefined after queueing is never sent (dropped task-changed)", async () => {
    const s = build();
    const task = await mkTask();
    const a = await mkRun(task);
    const store = e.store(SID, { now: () => fake.now() });
    await store.transact((d: ScheduleStateFile) => {
      d.tasks.find((t) => t.id === task.id)!.enabled = false;
      return { value: undefined, write: true };
    });
    s.enqueue(a, task);
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    expect(runOf(a.runKey)).toMatchObject({ state: "dropped", reason: "task-changed" });
  });
});

describe("能力门控 (fail closed)", () => {
  it("unknown ⇒ stays queued (msg ?), sends once evidence arrives", async () => {
    cap = new XsHostCapability();
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    s.enqueue(run, task);
    await drive(s, 10_000);
    expect(host.sent).toHaveLength(0);
    expect(runOf(run.runKey).state).toBe("queued");
    expect(s.statusSuffix()).toBe(" · msg ?");
    s.onBeforeAgentStart(userEvent); // observes the union shape
    host.idle = true;
    s.onAgentSettled({});
    await drive(s, SCHED_QUIET_MS + 10);
    expect(host.sent).toHaveLength(1);
    expect(s.statusSuffix()).toBe("");
  });

  it("unknown for 30 min ⇒ dropped(capability-unknown) with a quiet notice", async () => {
    cap = new XsHostCapability();
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    s.enqueue(run, task);
    await drive(s, SCHED_CAPABILITY_UNKNOWN_MAX_MS - 5_000);
    expect(runOf(run.runKey).state).toBe("queued");
    await drive(s, 10_000);
    expect(runOf(run.runKey)).toMatchObject({ state: "dropped", reason: "capability-unknown" });
    expect(notices).toEqual([{ reason: "capability-unknown", runKey: run.runKey }]);
    expect(host.sent).toHaveLength(0);
  });

  it("absent (legacy shape) ⇒ dropped(capability), notice + one-time notify, handoff degraded", async () => {
    cap = new XsHostCapability();
    cap.observe({ prompt: "legacy" }); // no messageType ⇒ legacy
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    const outcomes: HandoffOutcome[] = [];
    s.enqueue(run, task);
    const task2 = await mkTask({ name: "other" });
    expect(
      s.enqueueHandoff({
        runKey: "bg@1",
        taskId: task2.id,
        task: task2,
        defHash: task2.approval!.hash,
        noteId: "n1",
        content: "handoff",
        onEnd: (o) => outcomes.push(o),
      }),
    ).toBe(true);
    await drive(s);
    expect(host.sent).toHaveLength(0);
    expect(runOf(run.runKey)).toMatchObject({ state: "dropped", reason: "capability" });
    expect(notices).toEqual([{ reason: "capability", runKey: run.runKey }]);
    expect(notifies).toHaveLength(1);
    expect(outcomes).toEqual([{ kind: "dropped", reason: "capability" }]);
    expect(s.statusSuffix()).toBe(" · msg off");
  });
});

describe("调度条件", () => {
  it("静默期: not within 1s of the last settle, not after a later agent_start", async () => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    s.onAgentStart();
    s.onAgentSettled({});
    s.enqueue(run, task);
    await drive(s, SCHED_QUIET_MS - 100);
    expect(host.sent).toHaveLength(0);
    s.onAgentStart(); // a new run starts inside the quiet window
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0); // still running
    s.onAgentSettled({});
    await drive(s, SCHED_QUIET_MS - 1);
    expect(host.sent).toHaveLength(0);
    await drive(s, 2);
    expect(host.sent).toHaveLength(1);
  });

  it.each([
    ["not idle", () => (host.idle = false)],
    ["pending messages", () => (host.pending = true)],
  ])("%s blocks, then releases", async (_name, block) => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    block();
    s.enqueue(run, task);
    await drive(s, 10_000);
    expect(host.sent).toHaveLength(0);
    host.idle = true;
    host.pending = false;
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
  });

  it("rootWake busy / xs wake owner / goal / open ui prompt / compaction window all defer", async () => {
    let rootBusy = true;
    let xsOwned = true;
    let goal: boolean | undefined = true;
    const s = build({
      rootWakeBusy: () => rootBusy,
      xsWakeOwned: () => xsOwned,
      fencePorts: { goal: () => goal },
    });
    const task = await mkTask();
    const run = await mkRun(task);
    s.enqueue(run, task);
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    rootBusy = false;
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    xsOwned = false;
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0); // goal still running ⇒ defer (never reject)
    goal = undefined;
    s.onUiPrompt(true);
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    s.onUiPrompt(false);
    s.onFenceEvent({ type: "session_before_compact" });
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    expect(runOf(run.runKey).state).toBe("queued");
    s.onFenceEvent({ type: "session_compact" });
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
  });

  it.each([
    ["tree", { type: "session_before_tree" }],
    ["switch", { type: "session_before_switch" }],
    ["fork", { type: "session_before_fork" }],
  ] as const)("a %s window defers until a closing event", async (_n, open) => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    s.onFenceEvent(open);
    s.enqueue(run, task);
    await drive(s, 10_000);
    expect(host.sent).toHaveLength(0);
    s.onFenceEvent({ type: "session_start" }); // fresh state closes every window
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
  });

  it("process-level occupancy: a second scheduler (other epoch) cannot dispatch while one is in flight", async () => {
    const a = build({}, "ep-a");
    const b = build({}, "ep-b");
    const task = await mkTask();
    const run = await mkRun(task, fake.now(), {}, "ep-a");
    a.enqueue(run, task);
    await drive(a);
    expect(host.sent).toHaveLength(1);
    const task2 = await mkTask({ name: "two" });
    const run2 = await mkRun(task2, fake.now() + 1, {}, "ep-b");
    b.enqueue(run2, task2);
    await drive(b, 10_000);
    expect(host.sent).toHaveLength(1); // b blocked
    a.shutdown(); // releases
    await drive(b, 3_000);
    expect(host.sent).toHaveLength(2);
  });

  it("an occupant whose epoch is known disposed does not block", () => {
    const disposed = new Set<string>();
    const slot = createProcessOccupancy((ep) => disposed.has(ep), `occ-test-${Math.random()}`);
    expect(slot.tryClaim("ep-old", "r1")).toBe(true);
    expect(slot.tryClaim("ep-new", "r2")).toBe(false);
    disposed.add("ep-old");
    expect(slot.tryClaim("ep-new", "r2")).toBe(true);
  });

  it("the default occupancy is one process-wide slot on Symbol.for(sched-dispatch)", () => {
    const key = `occ-test-${Math.random()}`;
    const one = createProcessOccupancy(() => false, key);
    const two = createProcessOccupancy(() => false, key); // a fresh module instance after /reload
    expect(one.tryClaim("a", "r")).toBe(true);
    expect(two.tryClaim("b", "r")).toBe(false);
    one.release("a", "r");
    expect(two.tryClaim("b", "r")).toBe(true);
  });

  it("gate refusal (session switched) ⇒ dropped(owner-closed), no send, no notice", async () => {
    const s = build({ gate: () => ({ code: "E_NOT_OWNER", detail: "x" }) });
    const task = await mkTask();
    const run = await mkRun(task);
    s.enqueue(run, task);
    await drive(s);
    expect(host.sent).toHaveLength(0);
    expect(runOf(run.runKey)).toMatchObject({ state: "dropped", reason: "owner-closed" });
    expect(notices).toEqual([]);
  });

  it("a synchronous sendMessage throw reverts to queued and retries later", async () => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    host.throwOnSend = true;
    s.enqueue(run, task);
    await drive(s, 1_000);
    expect(host.sent).toHaveLength(0);
    expect(runOf(run.runKey).state).toBe("queued");
    host.throwOnSend = false;
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
  });

  it("fence generation moved inside the send block ⇒ token void, run unknown(owner-closed)", async () => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    host.onSend = () => s.onFenceEvent({ type: "session_start" });
    s.enqueue(run, task);
    await drive(s);
    expect(host.sent).toHaveLength(1);
    const token = host.sent[0]!.message.details.token as string;
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "owner-closed" });
    // the trigger may still start later: it is an orphan now
    expect(s.onBeforeAgentStart(wakeEvent(token))).toBe("aborted");
    expect(host.aborts).toBe(1);
  });

  it("a disposed stack never sends", async () => {
    let disposed = false;
    const s = build({ isDisposed: () => disposed });
    const task = await mkTask();
    const run = await mkRun(task);
    disposed = true;
    s.enqueue(run, task);
    await drive(s, 10_000);
    expect(host.sent).toHaveLength(0);
  });
});

describe("before_agent_start 授权与孤儿 abort", () => {
  it("an unknown / missing token, or a token from another epoch's scheduler ⇒ synchronous abort", async () => {
    const s = build();
    expect(s.onBeforeAgentStart(wakeEvent("nope"))).toBe("aborted");
    expect(host.aborts).toBe(1);
    expect(s.onBeforeAgentStart({ messageType: "custom", message: { customType: SCHED_CUSTOM_TYPE } })).toBe("aborted");
    expect(host.aborts).toBe(2);

    const task = await mkTask();
    const { token } = await sendOne(s, task);
    const other = build({}, "ep-other");
    expect(other.onBeforeAgentStart(wakeEvent(token))).toBe("aborted");
    expect(host.aborts).toBe(3);
  });

  it("user prompts, foreign custom triggers and quiet kinds are never aborted", () => {
    const s = build();
    expect(s.onBeforeAgentStart(userEvent)).toBe("other");
    expect(s.onBeforeAgentStart({ messageType: "custom", message: { customType: "subagent:xs", details: {} } })).toBe(
      "other",
    );
    expect(s.onBeforeAgentStart(wakeEvent("t", "digest"))).toBe("other");
    expect(host.aborts).toBe(0);
  });

  it("observes the trigger shape into the shared capability", () => {
    cap = new XsHostCapability();
    const s = build();
    s.onBeforeAgentStart(wakeEvent("nope"));
    expect(cap.state).toBe("observed");
  });

  it("a token bound to a run is authorized once; a forged second token aborts", async () => {
    const s = build();
    const task = await mkTask();
    const { token } = await sendOne(s, task);
    expect(s.onBeforeAgentStart(wakeEvent(token))).toBe("authorized");
    expect(s.onBeforeAgentStart(wakeEvent("forged"))).toBe("aborted");
  });
});

describe("启动超时与 prepare 卡住 (R2-4)", () => {
  it("not authorized within 60s ⇒ unknown(start-timeout), token void, late trigger aborted", async () => {
    const s = build();
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    await drive(s, SCHED_START_TIMEOUT_MS + 1);
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "start-timeout" });
    expect(host.aborts).toBe(1); // r1 #2: our trigger may be stuck in prepare / compaction ⇒ always stop it
    expect(s.onBeforeAgentStart(wakeEvent(token))).toBe("aborted");
    expect(host.aborts).toBe(2);
  });

  it("authorized but stuck in prepare past 60s ⇒ void token + ctx.abort() + aborting; the later context blocks the first model call; settle ⇒ dropped(start-timeout)", async () => {
    const s = build();
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    host.idle = false;
    fake.advance(59_000);
    expect(s.onBeforeAgentStart(wakeEvent(token))).toBe("authorized");
    s.onAgentStart();
    s.onMessageStart(customStart(token));
    await drive(s, 2_000); // 61s after the send, no `context` yet
    expect(host.aborts).toBe(1);
    expect(runOf(run.runKey).state).toBe("aborting");
    // the run limps on: its first model call is blocked by the context re-check
    s.onContext();
    expect(host.aborts).toBe(2);
    host.idle = true;
    s.onAgentSettled({ aborted: true });
    await s.idle();
    expect(runOf(run.runKey)).toMatchObject({ state: "dropped", reason: "start-timeout" });
    expect(settledCalls).toEqual([]);
  });

  it("same, but the aborted run already produced output ⇒ unknown(start-timeout)", async () => {
    const s = build();
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    s.onAgentStart();
    s.onMessageStart(customStart(token));
    await drive(s, SCHED_START_TIMEOUT_MS + 1);
    expect(runOf(run.runKey).state).toBe("aborting");
    s.onMessageEnd(assistant("partial"));
    host.idle = true;
    s.onAgentSettled({ aborted: true });
    await s.idle();
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "start-timeout" });
  });

  it("an authorized run that reached its first model call before 60s is NOT aborted", async () => {
    const s = build();
    const task = await mkTask();
    const { run } = await startRun(s, task);
    await drive(s, SCHED_START_TIMEOUT_MS * 3);
    expect(host.aborts).toBe(0);
    expect(runOf(run.runKey).state).toBe("bound");
  });

  it("the context re-check aborts when the bound token was voided meanwhile", async () => {
    const s = build();
    const task = await mkTask();
    const { token } = await sendOne(s, task);
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    s.shutdown(); // r1 #1: a supervised run must not outlive its supervisor ⇒ aborted AND voided
    expect(host.aborts).toBe(1);
    s.onContext();
    expect(host.aborts).toBe(2);
  });

  it("an aborting run that never settles: result downgraded after the grace window, slot held until idle evidence", async () => {
    const s = build();
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    s.onMessageStart(customStart(token));
    await drive(s, SCHED_START_TIMEOUT_MS + 1);
    expect(runOf(run.runKey).state).toBe("aborting");
    await drive(s, SCHED_MSG_ABORT_GRACE_MS + 1);
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "no-outcome" });
    // the RESULT is downgraded, but the slot is held: a timer is not evidence the run ended (r1 #10)
    expect(occ.tryClaim("someone-else", "r")).toBe(false);
    expect(s.diagnostics().stuck).toBe(true);
    await drive(s, SCHED_MSG_POLL_MS * 3); // host still busy ⇒ still held
    expect(occ.tryClaim("someone-else", "r")).toBe(false);
    host.idle = true; // reliable idle evidence (two observations) stands in for the missing settle
    await drive(s, SCHED_MSG_POLL_MS * 3);
    expect(s.diagnostics().stuck).toBe(false);
    expect(occ.tryClaim("someone-else", "r")).toBe(true);
  });
});

describe("3600s 上限与人工交接 (N2)", () => {
  it("authorized + 3600s ⇒ abort ⇒ settle ⇒ settled(run-max) with the partial output", async () => {
    const s = build();
    const task = await mkTask();
    const { run } = await startRun(s, task);
    s.onMessageEnd(assistant("partial work"));
    await drive(s, SCHED_RUN_MAX_MS - 1_000);
    expect(host.aborts).toBe(0);
    await drive(s, 2_000);
    expect(host.aborts).toBe(1);
    expect(runOf(run.runKey).state).toBe("aborting");
    s.onContext(); // token void ⇒ any further model call is blocked
    expect(host.aborts).toBe(2);
    host.idle = true;
    s.onAgentSettled({ aborted: true });
    await s.idle();
    expect(settledCalls).toEqual([{ runKey: run.runKey, text: "partial work", reason: "run-max" }]);
  });

  it("the limit runs from authorizedAt, not from the send", async () => {
    const s = build();
    const task = await mkTask();
    const { token } = await sendOne(s, task);
    host.idle = false;
    fake.advance(50_000);
    s.onBeforeAgentStart(wakeEvent(token));
    s.onMessageStart(customStart(token));
    s.onContext();
    await drive(s, SCHED_RUN_MAX_MS - 1_000);
    expect(host.aborts).toBe(0);
    await drive(s, 2_000);
    expect(host.aborts).toBe(1);
  });

  it("human input hands over: continued, limit cancelled, no report, later context not aborted", async () => {
    const s = build();
    const task = await mkTask();
    const { run } = await startRun(s, task);
    s.onInput({ text: "extension chatter", source: "extension" }); // not human proof
    await s.idle();
    expect(runOf(run.runKey).state).toBe("bound");
    s.onInput({ text: "hello", source: "interactive" });
    await s.idle();
    expect(runOf(run.runKey).state).toBe("continued");
    await drive(s, SCHED_RUN_MAX_MS + 10_000);
    expect(host.aborts).toBe(0);
    s.onContext();
    expect(host.aborts).toBe(0);
    s.onAgentSettled({});
    await s.idle();
    expect(settledCalls).toEqual([]);
    expect(runOf(run.runKey).state).toBe("continued");
  });

  it("a web-attributed extension prompt counts as human input", async () => {
    const s = build({ attributeInput: () => (text) => (text === "from web" ? "web_prompt" : undefined) });
    const task = await mkTask();
    const { run } = await startRun(s, task);
    s.onInput({ text: "from web", source: "extension" });
    await s.idle();
    expect(runOf(run.runKey).state).toBe("continued");
  });

  it("input before our own run has started proves nothing", async () => {
    const s = build();
    const task = await mkTask();
    const { run } = await sendOne(s, task);
    s.onInput({ text: "hello", source: "interactive" });
    await s.idle();
    expect(runOf(run.runKey).state).toBe("dispatched");
  });
});

describe("merged", () => {
  it("our message entering a human-started run ⇒ bound(merged), no limit, settled(merged)", async () => {
    const s = build();
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    host.idle = false;
    expect(s.onBeforeAgentStart(userEvent)).toBe("other"); // a user run starts first
    s.onAgentStart();
    s.onMessageStart(customStart(token));
    s.onContext();
    s.onMessageEnd(assistant("answer"));
    await drive(s, SCHED_START_TIMEOUT_MS * 2 + SCHED_RUN_MAX_MS);
    expect(host.aborts).toBe(0);
    expect(runOf(run.runKey).state).toBe("bound");
    host.idle = true;
    s.onAgentSettled({});
    await s.idle();
    expect(settledCalls).toEqual([{ runKey: run.runKey, text: "answer", reason: "merged" }]);
  });
});

describe("handoff", () => {
  const bgTask = (over: Partial<ScheduleTask> = {}) =>
    mkTask({
      form: "background",
      bg: { type: "general-purpose", timeoutS: 60, consultMain: false, handoff: true },
      ...over,
    });
  const input = (task: ScheduleTask, outcomes: HandoffOutcome[], runKey = "bg@1") => ({
    runKey,
    taskId: task.id,
    task,
    defHash: task.approval!.hash,
    noteId: "note-1",
    content: "[接手] result",
    onEnd: (o: HandoffOutcome) => outcomes.push(o),
  });

  it("sends the handoff message, settles with the last reply, no ledger run involved", async () => {
    const s = build();
    const task = await bgTask();
    const outcomes: HandoffOutcome[] = [];
    expect(s.enqueueHandoff(input(task, outcomes))).toBe(true);
    await drive(s);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.message.content).toBe("[接手] result");
    expect(host.sent[0]!.message.details).toMatchObject({ kind: "handoff", runKey: "bg@1", noteId: "note-1" });
    const token = host.sent[0]!.message.details.token as string;
    host.idle = false;
    expect(s.onBeforeAgentStart(wakeEvent(token, "handoff"))).toBe("authorized");
    s.onMessageStart(customStart(token, "handoff"));
    s.onContext();
    s.onMessageEnd(assistant("handled"));
    host.idle = true;
    s.onAgentSettled({});
    await s.idle();
    expect(outcomes).toEqual([{ kind: "settled", text: "handled", merged: false, runMax: false }]);
    expect(stateOf().runs).toHaveLength(0);
  });

  it("a newer handoff of the same task supersedes the older one (dropped coalesced)", async () => {
    const s = build();
    const task = await bgTask();
    const o1: HandoffOutcome[] = [];
    const o2: HandoffOutcome[] = [];
    host.idle = false;
    s.enqueueHandoff(input(task, o1, "bg@1"));
    s.enqueueHandoff(input(task, o2, "bg@2"));
    expect(o1).toEqual([{ kind: "dropped", reason: "coalesced" }]);
    host.idle = true;
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.message.details.runKey).toBe("bg@2");
    expect(o2).toEqual([]);
  });

  it("human interjection ⇒ continued", async () => {
    const s = build();
    const task = await bgTask();
    const o: HandoffOutcome[] = [];
    s.enqueueHandoff(input(task, o));
    await drive(s);
    const token = host.sent[0]!.message.details.token as string;
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token, "handoff"));
    s.onMessageStart(customStart(token, "handoff"));
    s.onContext();
    s.onInput({ text: "x", source: "rpc" });
    expect(o).toEqual([{ kind: "continued" }]);
  });

  it("never authorized within 60s ⇒ unknown(start-timeout)", async () => {
    const s = build();
    const task = await bgTask();
    const o: HandoffOutcome[] = [];
    s.enqueueHandoff(input(task, o));
    await drive(s);
    expect(host.sent).toHaveLength(1);
    await drive(s, SCHED_START_TIMEOUT_MS + 1);
    expect(o).toEqual([{ kind: "unknown", reason: "start-timeout" }]);
  });

  it("shutdown while queued ⇒ dropped(owner-closed); later enqueues are refused", async () => {
    const s = build();
    const task = await bgTask();
    host.idle = false;
    const o: HandoffOutcome[] = [];
    s.enqueueHandoff(input(task, o, "bg@4"));
    s.shutdown();
    expect(o).toEqual([{ kind: "dropped", reason: "owner-closed" }]);
    expect(s.enqueueHandoff(input(task, o, "bg@5"))).toBe(false);
  });
});

describe("zero-hang", () => {
  it("shutdown clears every timer; nothing fires into a dead stack", async () => {
    const s = build();
    const task = await mkTask();
    const { token } = await sendOne(s, task);
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    s.shutdown();
    expect(host.aborts).toBe(1); // the shutdown abort of the supervised run
    await drive(s, SCHED_RUN_MAX_MS * 2);
    expect(fake.pendingTimers).toBe(0);
    expect(host.aborts).toBe(1);
  });

  it("an idle scheduler with an empty queue holds no timer", async () => {
    const s = build();
    await drive(s, 10_000);
    expect(fake.pendingTimers).toBe(0);
    s.shutdown();
  });
});

/** FakeClock + `jump`: time moves but due timers do NOT run (a long synchronous handler delayed them). */
class HybridClock implements Clock {
  t: number;
  private n = 1;
  private entries = new Map<number, { due: number; fn: () => void }>();
  constructor(start: number) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimer(ms: number, fn: () => void): TimerHandle {
    const id = this.n++;
    this.entries.set(id, { due: this.t + Math.max(0, ms), fn });
    return { id };
  }
  clearTimer(h: TimerHandle): void {
    this.entries.delete(h.id);
  }
  jump(ms: number): void {
    this.t += ms;
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.entries].filter(([, x]) => x.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.t = Math.max(this.t, due[1].due);
      this.entries.delete(due[0]);
      due[1].fn();
    }
    this.t = target;
  }
}

describe("review r1 — /reload 后的监督 (#1)", () => {
  it("shutdown aborts a supervised authorized run and voids its record; a later stack's context refuses its model calls", async () => {
    const s1 = build();
    const task = await mkTask();
    const { token } = await startRun(s1, task);
    expect(reg.get()).toMatchObject({ token, voided: false });
    host.abortThrows = true; // the shutdown abort itself is lost (stale ctx)
    s1.shutdown();
    expect(host.aborts).toBe(1);
    expect(reg.get()?.voided).toBe(true);
    const s2 = build({}, "ep-2"); // the new stack after /reload: no flight, no runToken
    s2.onContext();
    expect(host.aborts).toBe(2); // blocked by the registry although s2 never saw the authorization
  });

  it("an un-voided record whose epoch is known disposed is refused by any later scheduler", async () => {
    const s1 = build();
    const task = await mkTask();
    await startRun(s1, task);
    const s2 = build({}, "ep-2");
    s2.onContext();
    expect(host.aborts).toBe(0); // epoch still alive: fine
    disposedEpochs.add("ep-1");
    s2.onContext();
    expect(host.aborts).toBe(1);
  });

  it("a handed-over (human) run survives its supervisor's shutdown untouched", async () => {
    const s1 = build();
    const task = await mkTask();
    await startRun(s1, task);
    s1.onInput({ text: "hi", source: "interactive" });
    s1.shutdown();
    expect(host.aborts).toBe(0);
    const s2 = build({}, "ep-2");
    s2.onContext();
    expect(host.aborts).toBe(0);
  });

  it("an unprovable scheduled wake is recorded as a void run: its model calls are refused even if the abort was lost", () => {
    const s = build();
    host.abortThrows = true;
    expect(s.onBeforeAgentStart(wakeEvent("nope"))).toBe("aborted");
    expect(host.aborts).toBe(1);
    s.onContext();
    expect(host.aborts).toBe(2);
    s.onAgentSettled({});
    s.onContext(); // the run ended: no record, nothing to refuse
    expect(host.aborts).toBe(2);
  });
});

describe("review r1 — 启动预算 (#2)", () => {
  it("stuck in prepare / pre-start compaction: a dispatched flight past 60s is aborted (not only recorded)", async () => {
    const s = build();
    const task = await mkTask();
    const { run } = await sendOne(s, task);
    host.idle = false; // pi is busy preparing our trigger (e.g. compacting)
    await drive(s, SCHED_START_TIMEOUT_MS + 1);
    expect(host.aborts).toBe(1);
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "start-timeout" });
    expect(s.diagnostics().inflight).toBe("aborting"); // capacity held until the run settles
  });

  it("…but a human's own run that started meanwhile is never aborted", async () => {
    const s = build();
    const task = await mkTask();
    const { run } = await sendOne(s, task);
    host.idle = false;
    expect(s.onBeforeAgentStart(userEvent)).toBe("other"); // somebody else's run began
    await drive(s, SCHED_START_TIMEOUT_MS + 1);
    expect(host.aborts).toBe(0);
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "start-timeout" });
    expect(s.diagnostics().inflight).toBeUndefined();
  });
});

describe("review r1 — 绝对截止时间 (#6)", () => {
  async function sendHybrid(task: ScheduleTask) {
    const hc = new HybridClock(T0);
    const s = build({ clock: hc });
    const run = await mkRun(task, T0);
    s.enqueue(run, task);
    hc.advance(0);
    await s.idle();
    hc.advance(0);
    await s.idle();
    expect(host.sent).toHaveLength(1);
    return { hc, s, run, token: host.sent[0]!.message.details.token as string };
  }

  it("before_agent_start refuses to authorize after sentAt+60s although the timer callback has not run yet", async () => {
    const task = await mkTask();
    const { hc, s, run, token } = await sendHybrid(task);
    hc.jump(SCHED_START_TIMEOUT_MS + 1); // timer due, not yet fired
    host.idle = false;
    expect(s.onBeforeAgentStart(wakeEvent(token))).toBe("aborted");
    expect(host.aborts).toBeGreaterThanOrEqual(1);
    await s.idle();
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "start-timeout" });
    s.onContext(); // the run it started stays refused
    expect(host.aborts).toBeGreaterThanOrEqual(2);
  });

  it("the 60s first-model-call budget is enforced at `context` itself", async () => {
    const task = await mkTask();
    const { hc, s, run, token } = await sendHybrid(task);
    host.idle = false;
    expect(s.onBeforeAgentStart(wakeEvent(token))).toBe("authorized");
    s.onMessageStart(customStart(token));
    hc.jump(SCHED_START_TIMEOUT_MS + 1);
    s.onContext(); // the first model call arrives late: refused
    expect(host.aborts).toBeGreaterThanOrEqual(1);
    await s.idle();
    expect(runOf(run.runKey).state).toBe("aborting");
  });

  it("the 3600s limit is enforced at `context` itself (timer delayed)", async () => {
    const task = await mkTask();
    const { hc, s, run, token } = await sendHybrid(task);
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    s.onMessageStart(customStart(token));
    s.onContext();
    expect(host.aborts).toBe(0);
    hc.jump(SCHED_RUN_MAX_MS + 1);
    s.onContext();
    expect(host.aborts).toBeGreaterThanOrEqual(1);
    await s.idle();
    expect(runOf(run.runKey).state).toBe("aborting");
  });

  it("a later stack enforces the registry's absolute deadline although it never saw the authorization", async () => {
    const task = await mkTask();
    const { hc, s } = await sendHybrid(task);
    host.idle = false;
    const { token } = { token: host.sent[0]!.message.details.token as string };
    s.onBeforeAgentStart(wakeEvent(token));
    s.onContext();
    const s2 = build({ clock: hc }, "ep-2");
    s2.onContext();
    expect(host.aborts).toBe(0);
    hc.jump(SCHED_RUN_MAX_MS + 1);
    s2.onContext();
    expect(host.aborts).toBe(1);
  });
});

describe("review r1 — handoff 同一 CAS + 批准复核 (#3)", () => {
  const bgTask = (over: Partial<ScheduleTask> = {}) =>
    mkTask({
      form: "background",
      bg: { type: "general-purpose", timeoutS: 60, consultMain: false, handoff: true },
      ...over,
    });
  const hin = (task: ScheduleTask, out: HandoffOutcome[], defHashOverride?: string) => ({
    runKey: "bg@1",
    taskId: task.id,
    task,
    defHash: defHashOverride ?? task.approval!.hash,
    noteId: "n",
    content: "[接手]",
    onEnd: (o: HandoffOutcome) => out.push(o),
  });
  const mutate = async (fn: (t: ScheduleTask) => void, id: string) => {
    const store = e.store(SID, { now: () => fake.now() });
    await store.transact((d: ScheduleStateFile) => {
      fn(d.tasks.find((x) => x.id === id)!);
      return { value: undefined, write: true };
    });
  };

  it.each([
    ["paused", (t: ScheduleTask) => (t.enabled = false)],
    ["edited ⇒ pending approval", (t: ScheduleTask) => (t.prompt = "something else")],
    ["handoff switched off", (t: ScheduleTask) => (t.bg!.handoff = false)],
  ])("%s while queued ⇒ nothing is sent, the owner falls back (dropped task-changed)", async (_n, change) => {
    const s = build();
    const task = await bgTask();
    const out: HandoffOutcome[] = [];
    host.idle = false;
    s.enqueueHandoff(hin(task, out));
    await mutate(change, task.id);
    host.idle = true;
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    expect(out).toEqual([{ kind: "dropped", reason: "task-changed" }]);
  });

  it("an auto once task (disabled by its own claim) may still hand off", async () => {
    const s = build();
    const task = await bgTask({ when: { kind: "once", at: "2026-01-01T00:00", tz: "UTC" } });
    const out: HandoffOutcome[] = [];
    await mutate((t) => (t.enabled = false), task.id); // what autoClaim does for once
    s.enqueueHandoff({ ...hin(task, out), runKey: `${task.id}@${T0}` });
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
  });
});

describe("review r1 — 发送的定义 = CAS 校验的定义 (#4) 与 once (#5)", () => {
  it("the content comes from the ledger's validated definition, not the stale queued snapshot", async () => {
    const s = build({ contentFor: (_run, t) => `PROMPT:${t.prompt}` });
    const task = await mkTask({ prompt: "NEW prompt" });
    const stale: ScheduleTask = { ...task, prompt: "OLD prompt" }; // A0 captured H0 before the edit to H1
    const run = await mkRun(task);
    s.enqueue(run, stale);
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.message.content).toBe("PROMPT:NEW prompt");
  });

  it("the settled sink receives the validated snapshot too (feishu flag comes from it)", async () => {
    let seenFeishu: boolean | undefined;
    const s = build({
      results: {
        settled: async (info) => {
          seenFeishu = info.task.feishu;
          return true;
        },
      },
    });
    const task = await mkTask({ feishu: true });
    const stale: ScheduleTask = { ...task, feishu: false };
    const run = await mkRun(task);
    s.enqueue(run, stale);
    await drive(s, 3_000);
    const token = host.sent[0]!.message.details.token as string;
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    s.onMessageStart(customStart(token));
    s.onContext();
    host.idle = true;
    s.onAgentSettled({});
    await s.idle();
    expect(seenFeishu).toBe(true);
  });

  async function disable(id: string): Promise<void> {
    const store = e.store(SID, { now: () => fake.now() });
    await store.transact((d: ScheduleStateFile) => {
      d.tasks.find((x) => x.id === id)!.enabled = false;
      return { value: undefined, write: true };
    });
  }

  it("an auto once message (claim already disabled it) is sent, not dropped task-changed", async () => {
    const s = build();
    const task = await mkTask({ when: { kind: "once", at: "2026-01-01T00:00", tz: "UTC" } });
    await disable(task.id);
    const run = await mkRun(task);
    s.enqueue(run, task);
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
    expect(runOf(run.runKey).state).toBe("dispatched");
  });

  it("…but a MANUAL run of a disabled once task, and any recurring disabled task, is still refused", async () => {
    const s = build();
    const once = await mkTask({ when: { kind: "once", at: "2026-01-01T00:00", tz: "UTC" } });
    await disable(once.id);
    const manual = await mkRun(once, fake.now(), { kind: "manual", runKey: `${once.id}@m-aaaaaaaa` });
    s.enqueue(manual, once);
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(0);
    expect(runOf(manual.runKey)).toMatchObject({ state: "dropped", reason: "task-changed" });
  });
});

describe("review r1 — uncertain 意图写入 (#7)", () => {
  it("an uncertain queued→dispatched commit is never sent nor lost: converges to unknown(no-outcome)", async () => {
    const real = e.store(SID, { now: () => fake.now() });
    let n = 0;
    const wrapped = {
      ...real,
      transact: async (body: never) => {
        const r = await real.transact(body);
        n += 1;
        // the rename landed, the directory fsync failed
        return n === 1 && r.ok
          ? { ok: false as const, code: "E_DEGRADED" as const, detail: "fsync", uncertain: true }
          : r;
      },
    };
    const s = build({ store: () => wrapped as never });
    const task = await mkTask();
    const run = await mkRun(task);
    n = 0;
    s.enqueue(run, task);
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    expect(runOf(run.runKey)).toMatchObject({ state: "unknown", reason: "no-outcome" });
    await drive(s, 10_000);
    expect(host.sent).toHaveLength(0); // never re-queued, never re-sent
    expect(s.status().queued).toBe(0);
  });
});

describe("review r1 — ui_prompt 对账与 fence 人工恢复 (#8 #9)", () => {
  it("an end that overtakes its start is reconciled by the sum, not clamped (no permanent block)", async () => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    s.onUiPrompt(false); // end first (async observer ordering)
    s.onUiPrompt(true);
    s.enqueue(run, task);
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
  });

  it("a lost end blocks with a diagnosable reason; the local reset is the only exit", async () => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    s.onUiPrompt(true);
    s.enqueue(run, task);
    await drive(s, 60 * 60_000);
    expect(host.sent).toHaveLength(0); // age never opens it
    expect(s.diagnostics()).toMatchObject({ uiPrompts: 1, queued: 1 });
    expect(s.diagnostics().uiBlockedSince).toBeDefined();
    s.resetBlockers();
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
    expect(s.diagnostics().uiPrompts).toBe(0);
  });

  it("a cancelled tree/switch (no completion event) keeps fencing — input / run start do not open it — until the local reset", async () => {
    const s = build();
    const task = await mkTask();
    const run = await mkRun(task);
    s.onFenceEvent({ type: "session_before_switch" });
    s.enqueue(run, task);
    s.onBeforeAgentStart(userEvent);
    s.onInput({ text: "hello", source: "interactive" });
    s.onAgentSettled({});
    await drive(s, 10 * 60_000);
    expect(host.sent).toHaveLength(0);
    expect(s.diagnostics().fence.open).toEqual(["switch"]);
    expect(s.diagnostics().fence.stuck).toEqual(["switch"]);
    s.resetBlockers();
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
  });
});

describe("review r1 — sched_bound (验收 major) 与其余", () => {
  it("bound ⇒ onBound(runKey) exactly once for a run WE started; never for a merged (human) run", async () => {
    const bound: string[] = [];
    const s = build({ onBound: (k) => bound.push(k) });
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    expect(bound).toEqual([]);
    s.onMessageStart(customStart(token));
    s.onMessageStart(customStart(token));
    expect(bound).toEqual([run.runKey]);
    s.onAgentSettled({});
    await s.idle();

    const merged: string[] = [];
    const s2 = build({ onBound: (k) => merged.push(k) }, "ep-2");
    const t2 = await mkTask({ name: "two" });
    host.sent = [];
    host.idle = true;
    const run2 = await mkRun(t2, fake.now(), {}, "ep-2");
    s2.enqueue(run2, t2);
    await drive(s2, 3_000);
    expect(host.sent).toHaveLength(1);
    const token2 = host.sent[0]!.message.details.token as string;
    host.idle = false;
    s2.onBeforeAgentStart(userEvent);
    s2.onMessageStart(customStart(token2));
    expect(merged).toEqual([]);
  });

  it("an onBound that throws never disturbs the run", async () => {
    const s = build({
      onBound: () => {
        throw new Error("x");
      },
    });
    const task = await mkTask();
    const { run, token } = await sendOne(s, task);
    host.idle = false;
    s.onBeforeAgentStart(wakeEvent(token));
    s.onMessageStart(customStart(token));
    await s.idle();
    expect(runOf(run.runKey).state).toBe("bound");
  });

  it("a newer entry that kills the head while its CAS is in flight: the dead one is dropped from the queue, not looped", async () => {
    const s = build();
    const task = await mkTask();
    const a = await mkRun(task, fake.now());
    const b = await mkRun(task, fake.now() + 60_000);
    s.enqueue(a, task);
    fake.advance(0); // the pump starts and parks inside A's CAS
    s.enqueue(b, task); // A is now dead
    await s.idle();
    fake.advance(0);
    await s.idle();
    await drive(s, 3_000);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.message.details.runKey).toBe(b.runKey);
    expect(s.status().queued).toBe(0);
  });
});

describe("review r2 — dispatched 阶段的 reload (#1)", () => {
  it("a stack torn down while our trigger is still preparing (pre-start compaction) stops that prepare; the old token is an orphan next door", async () => {
    const s1 = build();
    const task = await mkTask();
    const { token } = await sendOne(s1, task);
    host.idle = false; // pi is busy preparing OUR trigger; no before_agent_start yet
    s1.shutdown();
    expect(host.aborts).toBe(1);
    const s2 = build({}, "ep-2");
    expect(s2.onBeforeAgentStart(wakeEvent(token))).toBe("aborted"); // never authorized by the new stack
    expect(host.aborts).toBe(2);
    s2.onContext();
    expect(host.aborts).toBe(3); // and its model calls stay refused (void orphan record)
  });

  it("…even when the shutdown abort itself is lost, the trigger cannot pass the next stack", async () => {
    const s1 = build();
    const task = await mkTask();
    const { token } = await sendOne(s1, task);
    host.abortThrows = true;
    s1.shutdown();
    const s2 = build({}, "ep-2");
    expect(s2.onBeforeAgentStart(wakeEvent(token))).toBe("aborted");
    s2.onContext();
    expect(host.aborts).toBe(3);
  });

  it("a human's run that started meanwhile (foreignStart) is NOT aborted by the teardown", async () => {
    const s1 = build();
    const task = await mkTask();
    await sendOne(s1, task);
    host.idle = false;
    s1.onBeforeAgentStart(userEvent);
    s1.shutdown();
    expect(host.aborts).toBe(0);
  });
});

describe("review r2 — handed 运行与 disposed epoch (#2)", () => {
  it("a handed-over run is never refused: not by a disposed supervisor epoch (the real reload marking), not by the deadline", async () => {
    const s1 = build();
    const task = await mkTask();
    const { run } = await startRun(s1, task);
    s1.onInput({ text: "hi", source: "interactive" });
    await s1.idle();
    expect(runOf(run.runKey).state).toBe("continued");
    s1.shutdown();
    disposedEpochs.add("ep-1"); // what wire.ts's markEpochDisposed does on dispose
    const s2 = build({}, "ep-2");
    s2.onContext();
    expect(host.aborts).toBe(0);
    expect(reg.get()).toMatchObject({ handed: true, voided: false });
  });

  it("judgeScheduledContext order: handed ⇒ ok even with a disposed epoch and a passed deadline; voided still refuses", () => {
    const registry = createProcessRunRegistry(`reg-judge-${Math.random()}`);
    const base = { token: "t", epoch: "e", deadlineAt: 10, voided: false, handed: true };
    registry.set(base);
    expect(judgeScheduledContext(registry, 1_000, () => true)).toBe("ok");
    registry.set({ ...base, handed: false });
    expect(judgeScheduledContext(registry, 1_000, () => false)).toBe("abort"); // deadline
    registry.set({ ...base, handed: false, deadlineAt: 5_000 });
    expect(judgeScheduledContext(registry, 1_000, () => true)).toBe("abort"); // disposed epoch
    expect(judgeScheduledContext(registry, 1_000, () => false)).toBe("ok");
    registry.set({ ...base, handed: false, deadlineAt: 5_000, voided: true });
    expect(judgeScheduledContext(registry, 1_000, () => false)).toBe("abort");
  });
});

describe("review r2 — once 的豁免只在任务自 claim 起未被改动时成立 (#3)", () => {
  const onceWhen = { kind: "once", at: "2026-01-01T00:00", tz: "UTC" } as const;
  async function patch(id: string, fn: (t: ScheduleTask) => void): Promise<void> {
    const store = e.store(SID, { now: () => fake.now() });
    await store.transact((d: ScheduleStateFile) => {
      fn(d.tasks.find((x) => x.id === id)!);
      return { value: undefined, write: true };
    });
  }

  it("message: claim-disabled once, then ANY edit before the send ⇒ dropped(task-changed); a delete too", async () => {
    for (const change of ["rename", "delete"] as const) {
      const s = build({}, "ep-1");
      const task = await mkTask({ when: onceWhen, name: `once-${change}` });
      await patch(task.id, (t) => (t.enabled = false)); // the claim's own write
      const run = await mkRun(task);
      host.idle = false; // busy ⇒ stays queued
      s.enqueue(run, task);
      if (change === "rename") await patch(task.id, (t) => (t.name = "renamed by the user"));
      else {
        const store = e.store(SID, { now: () => fake.now() });
        await store.transact((d: ScheduleStateFile) => {
          d.tasks = d.tasks.filter((x) => x.id !== task.id);
          return { value: undefined, write: true };
        });
      }
      host.idle = true;
      await drive(s, 5_000);
      expect(host.sent).toHaveLength(0);
      const rec = stateOf().runs.find((r) => r.runKey === run.runKey);
      // (deleting a task also sweeps its runs on the next write — either way nothing was sent)
      if (change === "rename") expect(rec).toMatchObject({ state: "dropped", reason: "task-changed" });
      else expect(rec === undefined || rec.state === "dropped").toBe(true);
      s.shutdown();
    }
  });

  it("message: untouched since the claim ⇒ still sent (the exemption itself)", async () => {
    const s = build();
    const task = await mkTask({ when: onceWhen });
    await patch(task.id, (t) => (t.enabled = false));
    const run = await mkRun(task);
    host.idle = false;
    s.enqueue(run, task);
    host.idle = true;
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(1);
  });

  it("without evidence of the claim-time state (no ledger read) the exemption is off — fail closed", async () => {
    const real = e.store(SID, { now: () => fake.now() });
    let calls = 0;
    // the claim-time read (first store access, at enqueue) fails; the later CAS has the ledger
    const s = build({ store: () => (calls++ === 0 ? undefined : real) });
    const task = await mkTask({ when: onceWhen });
    await patch(task.id, (t) => (t.enabled = false));
    const run = await mkRun(task);
    s.enqueue(run, task);
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
  });

  it("handoff of a once background task: an edit between enqueue and send ⇒ dropped(task-changed)", async () => {
    const s = build();
    const task = await mkTask({
      form: "background",
      when: onceWhen,
      bg: { type: "general-purpose", timeoutS: 60, consultMain: false, handoff: true },
    });
    await patch(task.id, (t) => (t.enabled = false));
    const out: HandoffOutcome[] = [];
    host.idle = false;
    s.enqueueHandoff({
      runKey: `${task.id}@${T0}`,
      taskId: task.id,
      task,
      defHash: task.approval!.hash,
      noteId: "n",
      content: "c",
      onEnd: (o) => out.push(o),
    });
    await patch(task.id, (t) => (t.name = "touched"));
    host.idle = true;
    await drive(s, 5_000);
    expect(host.sent).toHaveLength(0);
    expect(out).toEqual([{ kind: "dropped", reason: "task-changed" }]);
  });
});

describe("review r2 — ui_prompt 代次 / 对话身份 (#4)", () => {
  const A = { kind: "confirm", title: "A" };
  const B = { kind: "select", title: "B" };
  const blocked = async (s: MessageScheduler): Promise<boolean> => {
    const task = await mkTask({ name: `t${Math.random()}` });
    const run = await mkRun(task);
    host.sent = [];
    s.enqueue(run, task);
    await drive(s, 3_000);
    return host.sent.length === 0;
  };

  it("reset + a late end of the OLD dialog + a NEW dialog's start ⇒ still blocked (no stale credit)", async () => {
    const s = build();
    s.onUiPrompt(true, A);
    s.resetBlockers();
    s.onUiPrompt(false, A); // the old dialog's end arrives after the reset (async observer)
    s.onUiPrompt(true, A); // a new dialog of the same kind/title opens
    expect(s.diagnostics().uiPrompts).toBe(1);
    expect(await blocked(s)).toBe(true);
  });

  it("different dialogs never cancel each other (end of A before its start must not hide B)", async () => {
    const s = build();
    s.onUiPrompt(true, B);
    s.onUiPrompt(false, A); // A's end overtook A's start
    expect(s.diagnostics().uiPrompts).toBe(1);
    expect(await blocked(s)).toBe(true);
    s.onUiPrompt(true, A); // A's late start cancels A's credit only
    expect(s.diagnostics().uiPrompts).toBe(1);
    s.onUiPrompt(false, B);
    expect(s.diagnostics().uiPrompts).toBe(0);
  });

  it("an old dialog's late end can never close a newer one with the same identity (ghost is consumed first)", () => {
    const s = build();
    s.onUiPrompt(true, A);
    s.resetBlockers();
    s.onUiPrompt(true, A); // new generation
    s.onUiPrompt(false, A); // old end (ghost) — swallowed
    expect(s.diagnostics().uiPrompts).toBe(1);
    s.onUiPrompt(false, A); // the new dialog's end
    expect(s.diagnostics().uiPrompts).toBe(0);
  });

  it("the open count never goes below zero and credits are bounded", () => {
    const s = build();
    for (let i = 0; i < 50; i++) s.onUiPrompt(false, A);
    expect(s.diagnostics().uiPrompts).toBe(0);
    s.onUiPrompt(true, B);
    expect(s.diagnostics().uiPrompts).toBe(1);
  });
});
