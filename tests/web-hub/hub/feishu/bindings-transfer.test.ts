/**
 * rebind-plan r3 §4.4 (P0a) — the shared binding write op (`bindings-transfer.ts`) R1–R8,
 * the D2 exactly-once idempotency key on `onBindingClosed`, and the `/use` migration
 * acceptance rows A1b / A3 / A3b / A3c.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBindingTransfer,
  type BindingTransfer,
  type TransferInput,
} from "../../../../src/web-hub/hub/feishu/bindings-transfer.js";
import { createFeishuState, type FeishuBinding, type FeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import {
  createFeishuThreads,
  feishuThreadHandle,
  type FeishuThreadTransport,
  type FeishuThreads,
} from "../../../../src/web-hub/hub/feishu/thread-hub.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";
import { messageEnvelope, OWNER } from "../../../fixtures/feishu/f6.js";
import { eventually, f8Rig } from "../../../fixtures/feishu/f8.js";
import type { CmdFrame } from "../../../../src/web-hub/protocol/messages.js";

const NOW = 1_790_000_000_000;
const KEY = "grp:chat:t1";
const THREADS_CONFIG = {
  handbackWindowMin: 10,
  startTimeoutMin: 8,
  retainMin: 15,
  replyPerThreadPerMin: 6,
  replyPerThreadPerHour: 60,
};

const dirs: string[] = [];
const states: FeishuState[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const s of states.splice(0).reverse()) s.dispose();
  for (const d of dirs.splice(0).reverse()) await rm(d, { recursive: true, force: true });
});

interface Rig {
  state: FeishuState;
  transfer: BindingTransfer;
  threads: FeishuThreads | undefined;
  fakeClosed: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  logs: Array<{ event: string; reason?: string }>;
  sent: Array<{ agentKey: string; frame: unknown }>;
}

async function rig(options: { realThreads?: boolean } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "feishu-bt-"));
  dirs.push(dir);
  const clock = createFakeClock(NOW);
  const state = createFeishuState({ dir, groupCommitMs: 0, clock: { ...systemFeishuClock, now: clock.now } });
  states.push(state);
  await state.load();
  await state.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
  state.tenant.pin("tenant");
  const sent: Rig["sent"] = [];
  const fakeClosed = vi.fn();
  const threads = options.realThreads
    ? createFeishuThreads({
        clock,
        config: THREADS_CONFIG,
        state,
        installation: () => ({ appId: "cli_test", gen: 1, ownerOpenId: OWNER, installSecret: "s", active: true }),
        transport: (): FeishuThreadTransport => ({
          getCaps: () => ["thr.v1"],
          send: (agentKey, frame) => {
            sent.push({ agentKey, frame });
            return true;
          },
        }),
        agentForSession: () => "agent-1",
        sessionOf: () => "session-1",
        notice: async () => {},
        enqueueNotice: async () => ({ ok: true, sendIds: [], durable: true, duplicate: false }),
        addReceiptReaction: async () => true,
        reactionsDenied: () => false,
        deleteTypingReaction: async () => {},
        run: (task) => void task(),
        label: (sid) => sid,
        targetFor: (r) => ({ scope: "topic", messageId: r.triggerMessageId }),
        log: () => {},
      })
    : undefined;
  const reconcile = vi.fn();
  const logs: Rig["logs"] = [];
  const transfer = createBindingTransfer({
    state,
    threads: (threads ?? ({ onBindingClosed: fakeClosed } as unknown as FeishuThreads)) as FeishuThreads,
    scheduleConfirm: { reconcile: (sid: string) => reconcile(sid) },
    log: (event, reason) => logs.push(reason === undefined ? { event } : { event, reason }),
  });
  return { state, transfer, threads, fakeClosed, reconcile, logs, sent };
}

const input = (over: Partial<TransferInput> = {}): TransferInput => ({
  key: KEY,
  target: { sessionId: "session-2", label: "Two" },
  identity: { chatId: "chat", chatType: "group", threadId: "t1" },
  reason: "rebound",
  notifyLifecycle: false,
  ...over,
});

const seedRetained = (state: FeishuState, id: string): void => {
  state.requests.receive({
    id,
    batchId: "b".repeat(64),
    sessionId: "session-1",
    bindingKey: KEY,
    bindingRev: 1,
    senderOpenId: OWNER,
    senderDisplay: "Owner",
    chatLabel: "P",
    chatId: "chat",
    chatType: "group",
    threadId: "t1",
    triggerMessageId: "m1",
    textDigest: "d".repeat(64),
    payload: { body: "event", messageIds: [id], uploadIds: [] },
    sourceCreatedAt: NOW,
    installGen: 1,
    tenantKey: "tenant",
  });
  expect(state.requests.transition(id, "dispatching").ok).toBe(true);
  expect(state.requests.transition(id, "accepted", { code: "thr:routed" }).ok).toBe(true);
};

describe("binding transfer (rebind-plan r3 §4.4)", () => {
  it("R1/A3: a first bind is a normal create path — never E_THR_NOT_BOUND", async () => {
    const r = await rig();
    const res = await r.transfer.transfer(input());
    expect(res).toMatchObject({ ok: true, created: true, changed: true });
    expect(r.state.bindings.size).toBe(1);
    expect(r.state.bindings.get(KEY)).toMatchObject({
      sessionId: "session-2",
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      label: "Two",
    });
    expect(r.reconcile.mock.calls.flat()).toEqual(["session-2"]);
  });

  it("R1: E_THR_NOT_BOUND exists ONLY on the CAS path (expect set, binding missing)", async () => {
    const r = await rig();
    const commitSpy = vi.spyOn(r.state, "commit");
    const res = await r.transfer.transfer(input({ expect: { rev: 3 } }));
    expect(res).toEqual({ ok: false, code: "E_THR_NOT_BOUND", effect: "none" });
    expect(r.state.bindings.size).toBe(0);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("A3b: re-bind after remove is a create again; the store-wide rev keeps climbing", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    const revBeforeRemove = r.state.bindings.get(KEY)!.rev;
    expect(r.state.bindings.remove(KEY)).toBe(true);
    await r.state.commit();
    const res = await r.transfer.transfer(input({ target: { sessionId: "session-3", label: "Three" } }));
    expect(res).toMatchObject({ ok: true, created: true, changed: true });
    const after = r.state.bindings.get(KEY)!;
    expect(after.sessionId).toBe("session-3");
    expect(after.rev).toBeGreaterThan(revBeforeRemove);
  });

  it("A3c: a target WITHOUT agentKey (offline /use selection) writes fine and clears offline", async () => {
    const r = await rig();
    const res = await r.transfer.transfer(input()); // no agentKey anywhere in the input
    expect(res).toMatchObject({ ok: true, created: true, changed: true });
    const b = r.state.bindings.get(KEY)!;
    expect(b.sessionId).toBe("session-2");
    expect(b.offline).toBeUndefined();
  });

  it("R2: same-target no-op — no set, no rev bump, no commit, no notify, no reconcile", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    const before = r.state.bindings.get(KEY)!;
    const commitSpy = vi.spyOn(r.state, "commit");
    r.fakeClosed.mockClear();
    r.reconcile.mockClear();
    const res = await r.transfer.transfer(input({ notifyLifecycle: true }));
    expect(res).toMatchObject({ ok: true, created: false, changed: false });
    expect(res.ok && res.binding.rev).toBe(before.rev);
    expect(r.state.bindings.get(KEY)!.rev).toBe(before.rev);
    expect(commitSpy).not.toHaveBeenCalled();
    expect(r.fakeClosed).not.toHaveBeenCalled();
    expect(r.reconcile).not.toHaveBeenCalled();
  });

  it("R2: an OFFLINE binding to the same session is not a no-op (offline gets cleared)", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    const before = r.state.bindings.get(KEY)!;
    r.state.bindings.set(KEY, { chatId: "chat", chatType: "group", offline: "session-changed" });
    expect(r.state.bindings.get(KEY)!.offline).toBe("session-changed");
    const res = await r.transfer.transfer(input());
    expect(res).toMatchObject({ ok: true, changed: true });
    const after = r.state.bindings.get(KEY)!;
    expect(after.offline).toBeUndefined();
    expect(after.rev).toBeGreaterThan(before.rev);
  });

  it("R3: expect.rev mismatch ⇒ E_THR_STALE/none, no write, no commit", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    const current = r.state.bindings.get(KEY)!;
    const commitSpy = vi.spyOn(r.state, "commit");
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-3", label: "T" }, expect: { rev: current.rev + 1 } }),
    );
    expect(res).toEqual({ ok: false, code: "E_THR_STALE", effect: "none" });
    expect(r.state.bindings.get(KEY)!.sessionId).toBe("session-2");
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("R3: expect.sessionId mismatch ⇒ E_THR_NO_OWNER/none, no write", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-3", label: "T" }, expect: { sessionId: "session-9" } }),
    );
    expect(res).toEqual({ ok: false, code: "E_THR_NO_OWNER", effect: "none" });
    expect(r.state.bindings.get(KEY)!.sessionId).toBe("session-2");
  });

  it("R3: a matching CAS passes and bumps rev exactly once", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    const current = r.state.bindings.get(KEY)!;
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-3", label: "T" }, expect: { sessionId: "session-2", rev: current.rev } }),
    );
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(r.state.bindings.get(KEY)!.rev).toBe(current.rev + 1);
  });

  it("R4: identity fields are preserved, the label is sanitized, offline is cleared", async () => {
    const r = await rig();
    r.state.bindings.set(KEY, {
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-1",
      offline: "session-changed",
    });
    const res = await r.transfer.transfer(input({ target: { sessionId: "session-2", label: "Evil\n·[#] label" } }));
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(r.state.bindings.get(KEY)).toMatchObject({
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-2",
      label: "Evil label",
    });
    expect(r.state.bindings.get(KEY)!.offline).toBeUndefined();
  });

  it("R5: a refused Admit ⇒ E_THR_STATE/none; memory untouched; no commit, no notify", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    vi.spyOn(r.state.bindings, "set").mockReturnValueOnce({ ok: false, refused: "cap" });
    const commitSpy = vi.spyOn(r.state, "commit");
    r.fakeClosed.mockClear();
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-3", label: "T" }, notifyLifecycle: true }),
    );
    expect(res).toEqual({ ok: false, code: "E_THR_STATE", effect: "none" });
    expect(r.state.bindings.get(KEY)!.sessionId).toBe("session-2");
    expect(commitSpy).not.toHaveBeenCalled();
    expect(r.fakeClosed).not.toHaveBeenCalled();
  });

  it("R6: commit failure ⇒ E_THR_COMMIT/unknown; memory moved; NO lifecycle notify, NO reconcile", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    r.fakeClosed.mockClear();
    r.reconcile.mockClear();
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-3", label: "T" }, notifyLifecycle: true }),
    );
    expect(res).toEqual({ ok: false, code: "E_THR_COMMIT", effect: "unknown" });
    expect(r.state.bindings.get(KEY)!.sessionId).toBe("session-3"); // memory already moved
    expect(r.fakeClosed).not.toHaveBeenCalled();
    expect(r.reconcile).not.toHaveBeenCalled();
  });

  it("R6: notifyLifecycle:true fires onBindingClosed AFTER the commit barrier + reconciles both sides", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    const before = r.state.bindings.get(KEY)!;
    r.fakeClosed.mockClear();
    r.reconcile.mockClear();
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-3", label: "T" }, notifyLifecycle: true }),
    );
    expect(res).toMatchObject({ ok: true, created: false, changed: true });
    expect(r.fakeClosed).toHaveBeenCalledTimes(1);
    expect(r.fakeClosed).toHaveBeenCalledWith(KEY, before, "rebound");
    expect(r.reconcile.mock.calls.flat()).toEqual(["session-2", "session-3"]);
  });

  it("R6/R7: notifyLifecycle:false never fires onBindingClosed (the durable hook owns it); reconcile still runs", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    r.fakeClosed.mockClear();
    r.reconcile.mockClear();
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-3", label: "T" }, notifyLifecycle: false }),
    );
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(r.fakeClosed).not.toHaveBeenCalled();
    expect(r.reconcile.mock.calls.flat()).toEqual(["session-2", "session-3"]);
  });

  it("R8: a throwing store is not swallowed — E_THR_STATE/unknown + a binding-transfer log line", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    vi.spyOn(r.state.bindings, "set").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const res = await r.transfer.transfer(input({ target: { sessionId: "session-9", label: "X" } }));
    expect(res).toEqual({ ok: false, code: "E_THR_STATE", effect: "unknown" });
    expect(r.logs.some((l) => l.event === "binding-transfer")).toBe(true);
  });

  it("R8: a throwing commit is not swallowed either", async () => {
    const r = await rig();
    await r.transfer.transfer(input());
    vi.spyOn(r.state, "commit").mockRejectedValueOnce(new Error("disk-on-fire"));
    const res = await r.transfer.transfer(input({ target: { sessionId: "session-9", label: "X" } }));
    expect(res).toEqual({ ok: false, code: "E_THR_STATE", effect: "unknown" });
    expect(r.logs.some((l) => l.event === "binding-transfer" && l.reason === "disk-on-fire")).toBe(true);
  });
});

describe("onBindingClosed idempotency (D2, (key, before.rev), Set 64 FIFO)", () => {
  it("A1b: the same write notified by BOTH sources takes effect exactly once", async () => {
    const r = await rig({ realThreads: true });
    r.state.bindings.set(KEY, {
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-1",
      label: "One",
      offline: null,
    });
    seedRetained(r.state, "fs" + "a".repeat(30));
    const before = r.state.bindings.get(KEY)!;
    // Source 1: the transfer itself (notifyLifecycle:true, the rebind shape).
    const res = await r.transfer.transfer(
      input({ target: { sessionId: "session-2", label: "Two" }, notifyLifecycle: true }),
    );
    expect(res.ok).toBe(true);
    const closes = () => r.sent.filter((s) => (s.frame as { t: string }).t === "thr_closed");
    expect(closes()).toEqual([
      { agentKey: "agent-1", frame: { t: "thr_closed", h: feishuThreadHandle("s", KEY), reason: "rebound" } },
    ]);
    expect(r.state.requests.get("fs" + "a".repeat(30))).toMatchObject({ state: "replied", code: "thread-closed" });
    // Source 2: the inbound durable hook fires for the SAME (key, before.rev) — a no-op.
    r.threads!.onBindingClosed(KEY, before, "rebound");
    expect(closes()).toHaveLength(1);
  });

  it("D2: a different rev for the same key is a DIFFERENT write and fires again", async () => {
    const r = await rig({ realThreads: true });
    const mk = (rev: number): FeishuBinding => ({
      key: KEY,
      rev,
      sessionId: "session-1",
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      updatedAt: NOW,
    });
    r.threads!.onBindingClosed(KEY, mk(1), "rebound");
    r.threads!.onBindingClosed(KEY, mk(1), "rebound");
    r.threads!.onBindingClosed(KEY, mk(2), "rebound");
    expect(r.sent).toHaveLength(2);
  });

  it("D2: the idempotency set is bounded (64 FIFO) — only the evicted oldest may fire again", async () => {
    const r = await rig({ realThreads: true });
    const mk = (i: number): FeishuBinding => ({
      key: `grp:chat:t${i}`,
      rev: i + 1,
      sessionId: "session-1",
      chatId: "chat",
      chatType: "group",
      threadId: `t${i}`,
      updatedAt: NOW,
    });
    for (let i = 0; i < 64; i++) r.threads!.onBindingClosed(`grp:chat:t${i}`, mk(i), "rebound");
    expect(r.sent).toHaveLength(64);
    r.threads!.onBindingClosed("grp:chat:t64", mk(64), "rebound"); // evicts t0
    expect(r.sent).toHaveLength(65);
    r.threads!.onBindingClosed("grp:chat:t0", mk(0), "rebound"); // evicted ⇒ fires again
    expect(r.sent).toHaveLength(66);
    r.threads!.onBindingClosed("grp:chat:t64", mk(64), "rebound"); // still remembered ⇒ no-op
    expect(r.sent).toHaveLength(66);
  });
});

describe("/use migration (A1b service level)", () => {
  const THREADS = THREADS_CONFIG;
  const ROUTED_DATA = {
    op: "prompt",
    delivery: "observed",
    behavior: "followUp",
    thread: { outcome: "routed", runs: [{ runId: "r_23456789", label: "worker" }] },
  };
  const TOPIC = { chatType: "group" as const, threadId: "t1", mentions: true };

  it("a /use switch fires thr_closed{rebound} and the retained finalization EXACTLY once", async () => {
    const sent: Array<{ agentKey: string; frame: unknown }> = [];
    const r = await f8Rig({}, { threads: THREADS });
    cleanups.push(() => r.close());
    await r.ready();
    r.service.setThreadTransport({
      getCaps: (agentKey) => (agentKey === "agent-1" ? ["thr.v1"] : undefined),
      send: (agentKey, frame) => {
        sent.push({ agentKey, frame });
        return true;
      },
    });
    r.views.push({
      sessionId: "session-2",
      agentKey: "agent-2",
      cwd: r.stateDir,
      name: "Two",
      mode: "tui",
      live: true,
      state: "idle",
    });
    await r.bind(TOPIC);
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: ROUTED_DATA as never,
    }));
    r.send(messageEnvelope("a1", "retained event", TOPIC));
    await eventually(() =>
      expect(
        r.request.mock.calls.map(([f]) => f as CmdFrame).filter((f) => f.cmd.op === "prompt" && !f.queryOnly).length,
      ).toBe(1),
    );
    const frame = r.request.mock.calls.map(([f]) => f as CmdFrame).find((f) => f.cmd.op === "prompt" && !f.queryOnly)!;
    const h = (frame.cmd as { thread?: { h: string } }).thread!.h;
    await eventually(async () => expect((await r.disk())["requests"][frame.id]?.code).toBe("thr:routed"));
    r.send(messageEnvelope("a2", "/use session-2", TOPIC));
    await eventually(async () => expect((await r.disk())["requests"][frame.id]?.code).toBe("thread-closed"));
    const closes = sent.filter((s) => (s.frame as { t: string }).t === "thr_closed");
    expect(closes).toEqual([{ agentKey: "agent-1", frame: { t: "thr_closed", h, reason: "rebound" } }]);
    const record = (await r.disk())["requests"][frame.id];
    expect(record).toMatchObject({ state: "replied", code: "thread-closed" });
  });
});
