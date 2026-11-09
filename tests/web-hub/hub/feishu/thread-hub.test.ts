import { afterEach, describe, expect, it, vi } from "vitest";
import {
  feishuHandbackBody,
  threadFinishGuarded,
  feishuHandbackNote,
  feishuThreadHandle,
  feishuThreadMetaFor,
  parseThreadRoutedResult,
} from "../../../../src/web-hub/hub/feishu/thread-hub.js";
import {
  THREAD_POST_TEXT_MAX_BYTES,
  type ThrPostReqFrame,
  type ThrResFrame,
} from "../../../../src/web-hub/protocol/thread.js";
import { createThreadChildTool, type ThreadChildOps } from "../../../../src/tools/thread-child-tool.js";
import type { HubConnection } from "../../../../src/web-hub/agent/connection.js";
import {
  createFeishuOutbox,
  type EnqueueResult,
  type EnqueueNoticeInput,
} from "../../../../src/web-hub/hub/feishu/outbox.js";
import type { FeishuRequestRecord } from "../../../../src/web-hub/hub/feishu/state.js";
import { createFeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import { createFeishuThreads } from "../../../../src/web-hub/hub/feishu/thread-hub.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { OWNER } from "../../../fixtures/feishu/f6.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECORD = (over: Partial<FeishuRequestRecord> = {}): FeishuRequestRecord => ({
  id: "fs" + "a".repeat(30),
  batchId: "b".repeat(64),
  state: "dispatching",
  createdAt: 1_790_000_000_000,
  stateAt: 1_790_000_000_000,
  sessionId: "session-1",
  agentKey: "agent-1",
  bindingKey: "grp:chat:t1",
  bindingRev: 1,
  senderOpenId: "ou_owner",
  senderDisplay: "Owner",
  chatLabel: "ProjTopic",
  chatId: "chat",
  chatType: "group",
  threadId: "t1",
  triggerMessageId: "m1",
  textDigest: "d".repeat(64),
  sourceCreatedAt: 1_790_000_000_123,
  ...over,
});

describe("finishRun guard predicate (§8.1, pure)", () => {
  it("guards ONLY accepted{thr:} while threads are on", () => {
    expect(threadFinishGuarded("accepted", "thr:routed", true)).toBe(true);
    expect(threadFinishGuarded("accepted", "thr:routed", false)).toBe(false); // old-hub rollback keeps the sweep
    expect(threadFinishGuarded("dispatching", "thr:routed", true)).toBe(false);
    expect(threadFinishGuarded("accepted", "spawn:xyz", true)).toBe(false);
    expect(threadFinishGuarded("accepted", undefined, true)).toBe(false);
    expect(threadFinishGuarded("uncertain", "thr:routed", true)).toBe(false);
  });
});

describe("thread handle mint (§3.1 D2)", () => {
  it("is fs: + 12 b64url chars, deterministic, secret- and key-dependent", () => {
    const h = feishuThreadHandle("secret", "grp:chat:t1");
    expect(h).toMatch(/^fs:[A-Za-z0-9_-]{12}$/);
    expect(feishuThreadHandle("secret", "grp:chat:t1")).toBe(h);
    expect(feishuThreadHandle("secret", "grp:chat:t2")).not.toBe(h);
    expect(feishuThreadHandle("rotated", "grp:chat:t1")).not.toBe(h);
  });
});

describe("cmd.thread attach gate (§4.2)", () => {
  const caps = ["cmd.v1", "thr.v1"];
  it("attaches {h,label,sentAt} for a group topic with the agent cap", () => {
    const meta = feishuThreadMetaFor({ record: RECORD(), agentKey: "agent-1", installSecret: "s", agentCaps: caps });
    expect(meta).toEqual({
      h: feishuThreadHandle("s", "grp:chat:t1"),
      label: "ProjTopic",
      sentAt: 1_790_000_000_123,
    });
  });
  it("stays absent for p2p, topic-less groups, cap-less agents and missing secrets", () => {
    expect(
      feishuThreadMetaFor({
        record: RECORD({ chatType: "p2p", bindingKey: "p2p:chat" }),
        agentKey: "a",
        installSecret: "s",
        agentCaps: caps,
      }),
    ).toBeUndefined();
    expect(
      feishuThreadMetaFor({
        record: RECORD({ threadId: undefined }),
        agentKey: "a",
        installSecret: "s",
        agentCaps: caps,
      }),
    ).toBeUndefined();
    expect(
      feishuThreadMetaFor({ record: RECORD(), agentKey: "a", installSecret: "s", agentCaps: ["cmd.v1"] }),
    ).toBeUndefined();
    expect(
      feishuThreadMetaFor({ record: RECORD(), agentKey: "a", installSecret: undefined, agentCaps: caps }),
    ).toBeUndefined();
    expect(
      feishuThreadMetaFor({ record: RECORD(), agentKey: undefined, installSecret: "s", agentCaps: caps }),
    ).toBeUndefined();
  });
  it("derives bypass from thb:/main: synthetic members only (never persisted)", () => {
    const bypass = feishuThreadMetaFor({
      record: RECORD({ payload: { body: "x", messageIds: ["thb:fs" + "a".repeat(30)], uploadIds: [] } }),
      agentKey: "a",
      installSecret: "s",
      agentCaps: caps,
    });
    expect(bypass?.bypass).toBe(true);
    const main = feishuThreadMetaFor({
      record: RECORD({ payload: { body: "x", messageIds: ["main:m1"], uploadIds: [] } }),
      agentKey: "a",
      installSecret: "s",
      agentCaps: caps,
    });
    expect(main?.bypass).toBe(true);
    const plain = feishuThreadMetaFor({
      record: RECORD({ payload: { body: "x", messageIds: ["m1"], uploadIds: [] } }),
      agentKey: "a",
      installSecret: "s",
      agentCaps: caps,
    });
    expect(plain && "bypass" in plain).toBe(false);
  });
});

describe("cmd.thread rev attach gate (rebind-plan r3 §6 实施要点 4 / §4.7, P0b)", () => {
  const caps = ["cmd.v1", "thr.v1"];
  it("pure: rev rides ONLY when the hub gate AND the agent's thr.rebind.v1 both hold", () => {
    const rec = RECORD({ bindingRev: 41 });
    const both = [...caps, "thr.rebind.v1"];
    const meta = feishuThreadMetaFor({ record: rec, agentKey: "a", installSecret: "s", agentCaps: both, rebind: true });
    expect(meta).toEqual({
      h: feishuThreadHandle("s", "grp:chat:t1"),
      label: "ProjTopic",
      sentAt: 1_790_000_000_123,
      rev: 41,
    });
    // hub gate off/absent ⇒ no rev even for a rebind-capable agent (A16 byte-parity)
    for (const rebind of [undefined, false] as const) {
      const m = feishuThreadMetaFor({ record: rec, agentKey: "a", installSecret: "s", agentCaps: both, rebind });
      expect(m).toBeDefined();
      expect(m).not.toHaveProperty("rev");
    }
    // old agent (no thr.rebind.v1) ⇒ no rev even with the hub gate on — the closed schema would
    // drop the whole cmd frame otherwise (R4)
    const old = feishuThreadMetaFor({ record: rec, agentKey: "a", installSecret: "s", agentCaps: caps, rebind: true });
    expect(old).toBeDefined();
    expect(old).not.toHaveProperty("rev");
  });

  it("module: metaFor sources the hub gate from feishuBot.threads.rebind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-thr-rev-"));
    const clock = createFakeClock(1_790_000_000_000);
    try {
      const state = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
      await state.load();
      const make = (rebind: boolean | undefined, agentCaps: string[]) =>
        createFeishuThreads({
          clock,
          config: {
            handbackWindowMin: 10,
            startTimeoutMin: 8,
            retainMin: 15,
            replyPerThreadPerMin: 6,
            replyPerThreadPerHour: 60,
            ...(rebind === undefined ? {} : { rebind }),
          },
          state,
          installation: () => ({ appId: "cli_test", gen: 1, ownerOpenId: OWNER, installSecret: "s", active: true }),
          transport: () => ({ getCaps: () => agentCaps, send: () => true }),
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
        });
      const rec = RECORD({ bindingRev: 7 });
      const on = make(true, ["thr.v1", "thr.rebind.v1"]);
      expect(on.metaFor(rec, "agent-1")).toMatchObject({ rev: 7 });
      on.dispose();
      const off = make(undefined, ["thr.v1", "thr.rebind.v1"]);
      expect(off.metaFor(rec, "agent-1")).not.toHaveProperty("rev");
      off.dispose();
      const oldAgent = make(true, ["thr.v1"]);
      expect(oldAgent.metaFor(rec, "agent-1")).not.toHaveProperty("rev");
      oldAgent.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("routed result validation (§8.1 step 1)", () => {
  const ok = (thread: unknown) => ({ op: "prompt", delivery: "observed", thread });
  it("accepts a well-formed routed payload", () => {
    expect(parseThreadRoutedResult(ok({ outcome: "routed", runs: [{ runId: "r_23456789", label: "w" }] }))).toEqual({
      outcome: "routed",
      runs: [{ runId: "r_23456789", label: "w" }],
    });
  });
  it("rejects non-prompt op, wrong outcome, empty/oversized runs, malformed ids/labels", () => {
    expect(parseThreadRoutedResult({ op: "query", ...ok({ outcome: "routed", runs: [] }) })).toBeUndefined();
    expect(parseThreadRoutedResult(ok({ outcome: "observed", runs: [] }))).toBeUndefined();
    expect(parseThreadRoutedResult(ok({ outcome: "routed", runs: [] }))).toBeUndefined();
    expect(
      parseThreadRoutedResult(
        ok({ outcome: "routed", runs: Array.from({ length: 5 }, () => ({ runId: "r_23456789", label: "w" })) }),
      ),
    ).toBeUndefined();
    expect(parseThreadRoutedResult(ok({ outcome: "routed", runs: [{ runId: "r_x", label: "w" }] }))).toBeUndefined();
    expect(
      parseThreadRoutedResult(ok({ outcome: "routed", runs: [{ runId: "r_23456789", label: "w".repeat(33) }] })),
    ).toBeUndefined();
    expect(parseThreadRoutedResult(undefined)).toBeUndefined();
    expect(parseThreadRoutedResult({ op: "prompt" })).toBeUndefined();
  });
  it("counts label CODE POINTS (a 32-cp astral label is legal)", () => {
    expect(
      parseThreadRoutedResult(ok({ outcome: "routed", runs: [{ runId: "r_23456789", label: "😀".repeat(32) }] })),
    ).toBeDefined();
  });
});

describe("handback note line and body budget (§5.5.3/§8.3 step 4)", () => {
  it("composes the host annotation with neutralized reason", () => {
    const line = feishuHandbackNote({
      by: { runId: "r_23456789", label: "w" },
      sourceCreatedAt: new Date("2026-11-02T12:34:00").getTime(),
      note: "超范围\n换人 · 处理",
    });
    expect(line).toBe("[thread handback · @w（run_id: r_23456789） · 原事件 12:34 · 原因: 超范围 换人 处理]");
  });
  it("marks system returns", () => {
    expect(feishuHandbackNote({ by: "system", sourceCreatedAt: 0, note: "订阅者启动失败" })).toContain("· system ·");
  });
  it("joins note + source; truncates only the note at the 16 KiB budget", () => {
    const small = feishuHandbackBody("[note]", "body");
    expect(small).toBe("[note]\nbody");
    const hugeSource = "x".repeat(16 * 1024 - 10);
    const body = feishuHandbackBody(
      "[thread handback · @w（run_id: r_23456789） · 原事件 12:34 · 原因: 超范围]",
      hugeSource,
    );
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024);
    expect(body.endsWith(hugeSource)).toBe(true);
    // A degenerate source leaves no room: the source survives verbatim.
    expect(feishuHandbackBody("[note]", "y".repeat(16 * 1024))).toBe("y".repeat(16 * 1024));
  });
  it("THREAD_POST_TEXT_MAX_BYTES is the 8 KiB byte budget (UTF-16 envelope parity)", () => {
    expect(THREAD_POST_TEXT_MAX_BYTES).toBe(8 << 10);
  });
});

describe("retention ledger (§8.1 step 4 / §8.2 restart)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0).reverse()) await rm(d, { recursive: true, force: true });
  });
  const CONFIG = {
    handbackWindowMin: 10,
    startTimeoutMin: 8,
    retainMin: 15,
    replyPerThreadPerMin: 6,
    replyPerThreadPerHour: 60,
  };
  async function rig() {
    const dir = await mkdtemp(join(tmpdir(), "feishu-thr-ret-"));
    dirs.push(dir);
    const clock = createFakeClock(1_790_000_000_000);
    const state = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    await state.load();
    await state.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
    state.tenant.pin("tenant");
    // The seed records carry bindingRev 1 for grp:c1:t1 — the binding must EXIST at rev 1 so
    // the §4.10 retention-expiry generation recheck (rebind-plan r3 P1) sees an unmoved
    // generation (the first store write lands at rev 1).
    state.bindings.set("grp:c1:t1", {
      chatId: "c1",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-1",
      offline: null,
    });
    await state.commit();
    const notices: string[] = [];
    const receiptCtl = { denied: false, addOk: true };
    const threads = createFeishuThreads({
      clock,
      config: CONFIG,
      state,
      installation: () => ({ appId: "cli_test", gen: 1, ownerOpenId: OWNER, installSecret: "s", active: true }),
      transport: () => ({ getCaps: () => ["thr.v1"], send: () => true }),
      agentForSession: () => "agent-1",
      sessionOf: () => "session-1",
      notice: async (_t, text) => {
        notices.push(text);
      },
      enqueueNotice: async () => ({ ok: true, sendIds: [], durable: true, duplicate: false }),
      addReceiptReaction: async () => receiptCtl.addOk,
      reactionsDenied: () => receiptCtl.denied,
      deleteTypingReaction: async () => {},
      run: (task) => void task(),
      label: (sid) => sid,
      targetFor: (r) => ({ scope: "topic", messageId: r.triggerMessageId }),
      log: () => {},
    });
    const seed = async (id: string, stateAt: number) => {
      state.requests.receive({
        id,
        batchId: "b".repeat(64),
        sessionId: "session-1",
        bindingKey: "grp:c1:t1",
        bindingRev: 1,
        senderOpenId: OWNER,
        senderDisplay: "Owner",
        chatLabel: "P",
        chatId: "c1",
        chatType: "group",
        threadId: "t1",
        triggerMessageId: "m1",
        textDigest: "d".repeat(64),
        payload: { body: "hello", messageIds: [id], uploadIds: [] },
        sourceCreatedAt: clock.now(),
        installGen: 1,
        tenantKey: "tenant",
      });
      state.requests.transition(id, "dispatching");
      const accepted = state.requests.transition(id, "accepted", { code: "thr:routed" });
      expect(accepted.ok).toBe(true);
      state.requests.patch(id, {}); // stateAt already `now`
      void stateAt;
    };
    return { clock, state, threads, seed, notices, receiptCtl };
  }
  it("onRestartRetained re-arms fresh records and finalizes already-expired ones", async () => {
    const r = await rig();
    await r.seed("fs" + "c".repeat(30), r.clock.now());
    const fresh = r.state.requests.get("fs" + "c".repeat(30))!;
    r.threads.onRestartRetained(fresh);
    expect(r.state.requests.get("fs" + "c".repeat(30))?.state).toBe("accepted");
    expect(r.threads.retainedCount).toBe(1);
    // Past the retention window on restart (the hub was down 16 minutes) ⇒ immediate finalize.
    await r.seed("fs" + "d".repeat(30), r.clock.now());
    r.clock.advance(16 * 60_000);
    const stale = r.state.requests.get("fs" + "d".repeat(30))!;
    r.threads.onRestartRetained(stale);
    expect(r.state.requests.get("fs" + "d".repeat(30))).toMatchObject({
      state: "replied",
      code: "thread-routed",
    });
  });
  it("the retention timer finalizes at stateAt+retainMin and re-checks state (first executor wins)", async () => {
    const r = await rig();
    await r.seed("fs" + "e".repeat(30), r.clock.now());
    const record = r.state.requests.get("fs" + "e".repeat(30))!;
    r.threads.onRouted({ request: record, runs: [], retained: true, recovered: false });
    // A handback finalizes the source first — the timer must not touch it afterwards.
    r.state.requests.transition("fs" + "e".repeat(30), "replied", { code: "thread-handback" });
    r.clock.advance(16 * 60_000);
    expect(r.state.requests.get("fs" + "e".repeat(30))?.code).toBe("thread-handback");
  });
  it("receipts: first event text, later emoji; emoji denied or failed ⇒ back to text (§8.1 step 3)", async () => {
    const r = await rig();
    await r.seed("fs" + "a".repeat(30), r.clock.now());
    const record = r.state.requests.get("fs" + "a".repeat(30))!;
    const runs = [{ runId: "r_23456789", label: "w" }];
    r.threads.onRouted({ request: record, runs, retained: false, recovered: false });
    expect(r.notices).toEqual([`已转交 @w（run_id: r_23456789）`]); // first ⇒ text
    r.threads.onRouted({ request: record, runs, retained: false, recovered: false });
    expect(r.notices.length).toBe(1); // emoji path, no new text
    // Capability denied ⇒ later events degrade back to text with the full subscriber list.
    r.receiptCtl.denied = true;
    r.threads.onRouted({ request: record, runs, retained: false, recovered: false });
    expect(r.notices[1]).toBe(`已转交 @w（run_id: r_23456789）`);
    // The emoji POST failing (not denied) ⇒ same text fallback (resolved past its await).
    r.receiptCtl.denied = false;
    r.receiptCtl.addOk = false;
    r.threads.onRouted({ request: record, runs, retained: false, recovered: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.notices[2]).toBe(`已转交 @w（run_id: r_23456789）`);
  });

  it("the retention timer finalizes a still-retained record", async () => {
    const r = await rig();
    await r.seed("fs" + "f".repeat(30), r.clock.now());
    const record = r.state.requests.get("fs" + "f".repeat(30))!;
    r.threads.onRouted({ request: record, runs: [], retained: true, recovered: false });
    r.clock.advance(14 * 60_000);
    expect(r.state.requests.get("fs" + "f".repeat(30))?.state).toBe("accepted");
    r.clock.advance(2 * 60_000);
    expect(r.state.requests.get("fs" + "f".repeat(30))).toMatchObject({
      state: "replied",
      code: "thread-routed",
    });
    expect(r.threads.retainedCount).toBe(0);
  });
});

describe("post ledger and real child → retry → hub entry (#84)", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });
  const QUEUED: EnqueueResult = { ok: true, sendIds: ["test-send"], durable: true, duplicate: false };
  async function rig(limit = 6) {
    const dir = await mkdtemp(join(tmpdir(), "feishu-thr-post-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const clock = createFakeClock(1_790_000_000_000);
    const state = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    await state.load();
    await state.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
    state.tenant.pin("tenant");
    state.bindings.set("grp:chat:t1", {
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      sessionId: "session-1",
      offline: null,
    });
    const seed = state.requests.receive({
      id: RECORD().id,
      batchId: RECORD().batchId,
      sessionId: "session-1",
      bindingKey: "grp:chat:t1",
      bindingRev: 1,
      senderOpenId: OWNER,
      senderDisplay: "Owner",
      chatLabel: "P",
      chatId: "chat",
      chatType: "group",
      threadId: "t1",
      triggerMessageId: "m1",
      textDigest: "d".repeat(64),
      payload: { body: "anchor", messageIds: ["m1"], uploadIds: [] },
      sourceCreatedAt: clock.now(),
      installGen: 1,
      tenantKey: "tenant",
    });
    expect(seed.ok).toBe(true);
    await state.commit();
    const enqueueNotice = vi.fn<(input: EnqueueNoticeInput) => Promise<EnqueueResult>>().mockResolvedValue(QUEUED);
    const targetFor = vi.fn((r: { triggerMessageId: string }) => ({
      scope: "topic" as const,
      messageId: r.triggerMessageId,
    }));
    const threads = createFeishuThreads({
      clock,
      config: {
        handbackWindowMin: 10,
        startTimeoutMin: 8,
        retainMin: 15,
        replyPerThreadPerMin: limit,
        replyPerThreadPerHour: limit * 10,
      },
      state,
      installation: () => ({ appId: "cli_test", gen: 1, ownerOpenId: OWNER, installSecret: "s", active: true }),
      transport: () => ({ getCaps: () => ["thr.v1"], send: () => true }),
      agentForSession: () => "agent-1",
      sessionOf: () => "session-1",
      notice: async () => {},
      enqueueNotice,
      addReceiptReaction: async () => true,
      reactionsDenied: () => false,
      deleteTypingReaction: async () => {},
      run: (task) => void task(),
      label: () => "project",
      targetFor,
      log: () => {},
    });
    cleanups.push(() => threads.dispose());
    const h = feishuThreadHandle("s", "grp:chat:t1");
    const frame = (seq = 1): ThrPostReqFrame => ({
      t: "thr_req",
      rid: `rid-${seq}`,
      op: "post",
      h,
      sessionId: "session-1",
      by: { runId: "r_23456789", label: "worker" },
      postId: `r_23456789:${seq}`,
      text: "worker reply",
    });
    const send = async (input = frame()): Promise<ThrResFrame> => {
      const replies: ThrResFrame[] = [];
      await threads.thrReq("agent-1", input, (res) => replies.push(res));
      expect(replies).toHaveLength(1);
      expect(replies[0]!.rid).toBe(input.rid);
      return replies[0]!;
    };
    const tool = (loseFirstAck = false) => {
      const recordReply = vi.fn();
      const request = vi.fn(async (f: ThrPostReqFrame) => {
        const result = await send(f);
        if (loseFirstAck && request.mock.calls.length === 1) throw new Error("transport lost response: secret");
        return result;
      });
      const conn = { request } as unknown as HubConnection;
      const ops: ThreadChildOps = {
        disposed: () => false,
        listForRun: () => [],
        activeSubOf: () => ({ subId: "t1", scope: "test" }),
        lastEventOf: () => undefined,
        unsubscribe: () => ({ ok: true }),
        requestHandback: () => ({ ok: true }),
        markHandback: () => ({ degrade: "none" }),
        noteRevokedHandback: () => {},
        sendHandbackReport: () => {},
        recordReply,
        hubCapable: () => true,
        sessionId: () => "session-1",
        conn: () => conn,
      };
      const child = createThreadChildTool({ runId: "r_23456789", label: "worker", ops });
      const execute = async () => {
        const res = await child.execute(
          "tc",
          { action: "reply", h, text: "worker reply" },
          undefined,
          undefined,
          {} as never,
        );
        return res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      };
      return { execute, request, recordReply };
    };
    return { clock, state, threads, enqueueNotice, targetFor, frame, send, tool, h };
  }

  it("audit reproduction: failed enqueue + lost response + same-post retry never fabricates queued", async () => {
    const r = await rig();
    let successfulEnqueues = 0;
    const commit = vi.fn().mockRejectedValue(new Error("before effect: credential must not leak"));
    r.enqueueNotice.mockImplementation(async () => {
      await commit();
      successfulEnqueues++;
      return QUEUED;
    });
    const child = r.tool(true);
    const content = await child.execute();
    expect(child.request).toHaveBeenCalledTimes(2);
    const posts = child.request.mock.calls.map(([f]) => f.postId);
    expect(posts).toEqual(["r_23456789:1", "r_23456789:1"]);
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(successfulEnqueues).toBe(0);
    expect(child.recordReply).not.toHaveBeenCalled();
    expect(content).toContain("E_THR_STATE (effect unknown)");
    expect(content).toContain("do NOT retry");
    expect(content).toContain("verify");
    expect(content).not.toContain("NOT sent");
    expect(content).not.toMatch(/^queued:/);
    expect(content).not.toContain("credential");
  });

  it.each([false, true])(
    "enqueue throw (side effect performed=%s) is sticky unknown, never re-enqueued",
    async (afterEffect) => {
      const r = await rig(1);
      let effects = 0;
      r.enqueueNotice.mockImplementation(async () => {
        if (afterEffect) effects++;
        throw new Error("injected enqueue failure");
      });
      expect(await r.send()).toMatchObject({ ok: false, code: "E_THR_STATE", effect: "unknown" });
      expect(await r.send()).toMatchObject({ ok: false, effect: "unknown" });
      expect(r.enqueueNotice).toHaveBeenCalledOnce();
      expect(effects).toBe(afterEffect ? 1 : 0);
      // Unknown consumed quota; another post cannot take its reservation.
      expect(await r.send(r.frame(2))).toMatchObject({ ok: false, code: "E_THR_RATE", effect: "none" });
      r.clock.advance(11 * 60_000); // unresolved entries must not expire at the ordinary dedup TTL
      expect(await r.send()).toMatchObject({ ok: false, effect: "unknown" });
      expect(r.enqueueNotice).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "cap",
    "budget",
    "invalid-target",
    "invalid-message",
    "invalid-request",
    "too-many-parts",
    "disposed",
  ] as const)("explicit pre-effect refusal %s allows same-post retry and refunds its quota", async (refused) => {
    const r = await rig(1);
    r.enqueueNotice.mockResolvedValueOnce({ ok: false, refused });
    expect(await r.send()).toMatchObject({ ok: false, code: "E_THR_STATE", effect: "none" });
    expect(await r.send()).toMatchObject({ ok: true, data: { queued: true } });
    expect(await r.send()).toMatchObject({ ok: true, data: { queued: true } });
    expect(r.enqueueNotice).toHaveBeenCalledTimes(2);
  });

  it("unavailable is an outbox catch, NOT proof of zero effect; it cannot be retried or refunded", async () => {
    const r = await rig(1);
    r.enqueueNotice.mockResolvedValueOnce({ ok: false, refused: "unavailable" });
    expect(await r.send()).toMatchObject({ ok: false, effect: "unknown" });
    expect(await r.send()).toMatchObject({ ok: false, effect: "unknown" });
    expect(await r.send(r.frame(2))).toMatchObject({ ok: false, code: "E_THR_RATE", effect: "none" });
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
  });

  it("durable:false already has intent, so it is unknown without a second enqueue", async () => {
    const r = await rig(1);
    r.enqueueNotice.mockResolvedValueOnce({ ok: true, sendIds: ["memory-only"], durable: false, duplicate: false });
    const child = r.tool();
    const content = await child.execute();
    expect(content).toContain("effect unknown");
    expect(child.recordReply).not.toHaveBeenCalled();
    expect(await r.send()).toMatchObject({ ok: false, effect: "unknown" });
    expect(await r.send(r.frame(2))).toMatchObject({ ok: false, code: "E_THR_RATE" });
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
  });

  it("concurrent duplicate is pending/unknown, then only confirmed success is replayed with the new rid", async () => {
    const r = await rig(1);
    let settle!: (r: EnqueueResult) => void;
    r.enqueueNotice.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const first = r.send();
    const dup = { ...r.frame(), rid: "duplicate-rid" };
    expect(await r.send(dup)).toEqual({
      t: "thr_res",
      rid: "duplicate-rid",
      ok: false,
      code: "E_THR_PENDING",
      effect: "unknown",
    });
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
    settle(QUEUED);
    expect(await first).toMatchObject({ ok: true, data: { queued: true } });
    expect(await r.send(dup)).toEqual({ t: "thr_res", rid: "duplicate-rid", ok: true, data: { queued: true } });
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
    expect(await r.send(r.frame(2))).toMatchObject({ ok: false, code: "E_THR_RATE" });
  });

  it("concurrent duplicate cannot make a failed pending enqueue succeed; a proven refusal can later retry", async () => {
    const r = await rig(1);
    let settle!: (r: EnqueueResult) => void;
    r.enqueueNotice.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const first = r.send();
    expect(await r.send()).toMatchObject({ ok: false, code: "E_THR_PENDING", effect: "unknown" });
    settle({ ok: false, refused: "cap" });
    expect(await first).toMatchObject({ ok: false, effect: "none" });
    expect(await r.send()).toMatchObject({ ok: true });
    expect(r.enqueueNotice).toHaveBeenCalledTimes(2);
  });

  it("validation and pure preparation failures never poison the postId", async () => {
    const r = await rig(1);
    expect(await r.send({ ...r.frame(), h: "fs:BBBBBBBBBBBB" })).toMatchObject({
      ok: false,
      code: "E_THR_UNKNOWN",
      effect: "none",
    });
    r.targetFor.mockImplementationOnce(() => {
      throw new Error("pure formatting failure");
    });
    expect(await r.send()).toMatchObject({ ok: false, code: "E_THR_STATE", effect: "none" });
    expect(r.enqueueNotice).not.toHaveBeenCalled();
    expect(await r.send()).toMatchObject({ ok: true });
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
  });

  it("lost success ACK traverses the real child helper and hub ledger without a second enqueue", async () => {
    const r = await rig(1);
    const child = r.tool(true);
    const content = await child.execute();
    expect(content).toBe("queued: the reply is in the hub outbox (best-effort delivery).");
    expect(child.request).toHaveBeenCalledTimes(2);
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
    expect(child.recordReply).toHaveBeenCalledOnce();
    expect(child.recordReply).toHaveBeenCalledWith("t1");
    expect(r.enqueueNotice.mock.calls[0]![0]).toMatchObject({
      target: { scope: "topic", messageId: "m1" },
      key: "thr-post-r_23456789:1",
      laneKey: "chat",
    });
    expect(r.enqueueNotice.mock.calls[0]![0].message.content).toContain("worker reply");
  });

  it("full pinned unknown ledger fails closed instead of evicting evidence or resending", async () => {
    const r = await rig(1000);
    r.enqueueNotice.mockRejectedValue(new Error("unknown effect"));
    for (let i = 1; i <= 256; i++) expect(await r.send(r.frame(i))).toMatchObject({ ok: false, effect: "unknown" });
    r.clock.advance(11 * 60_000);
    expect(await r.send(r.frame(257))).toMatchObject({ ok: false, code: "E_THR_STATE", effect: "none" });
    expect(await r.send(r.frame(1))).toMatchObject({ ok: false, effect: "unknown" });
    expect(r.enqueueNotice).toHaveBeenCalledTimes(256);
  });

  it("pending ledger is pinned past TTL and capacity pressure too", async () => {
    const r = await rig(1000);
    let settle!: (r: EnqueueResult) => void;
    r.enqueueNotice.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const first = r.send();
    for (let i = 2; i <= 256; i++) await r.send(r.frame(i));
    r.clock.advance(11 * 60_000);
    // Queued rows can expire, but the pending row cannot; a new post must not displace it.
    expect(await r.send(r.frame(257))).toMatchObject({ ok: true });
    expect(await r.send()).toMatchObject({ ok: false, code: "E_THR_PENDING", effect: "unknown" });
    settle(QUEUED);
    expect(await first).toMatchObject({ ok: true });
    expect(r.enqueueNotice).toHaveBeenCalledTimes(257);
  });

  it("REAL outbox outer catch can return unavailable AFTER store.add; hub never calls it again", async () => {
    const r = await rig(1);
    const outbox = createFeishuOutbox({
      state: r.state,
      clock: r.clock,
      api: { send: vi.fn(), reply: vi.fn() },
    });
    cleanups.push(() => outbox.dispose());
    const add = r.state.outbox.add.bind(r.state.outbox);
    vi.spyOn(r.state.outbox, "add").mockImplementation((input) => {
      const result = add(input);
      expect(result.ok).toBe(true);
      throw new Error("failure AFTER outbox mutation");
    });
    r.enqueueNotice.mockImplementation(outbox.enqueueNotice);
    expect(await r.send()).toMatchObject({ ok: false, code: "E_THR_STATE", effect: "unknown" });
    expect(r.state.outbox.list()).toHaveLength(1); // mutation exists despite refused:unavailable
    expect(await r.send()).toMatchObject({ ok: false, effect: "unknown" });
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
    expect(r.state.outbox.list()).toHaveLength(1);
  });

  it("REAL outbox nondurable commit keeps queued memory intent but tool returns unknown", async () => {
    const r = await rig(1);
    const outbox = createFeishuOutbox({
      state: r.state,
      clock: r.clock,
      api: { send: vi.fn(), reply: vi.fn() },
    });
    cleanups.push(() => outbox.dispose());
    vi.spyOn(r.state, "commit").mockResolvedValue(false);
    r.enqueueNotice.mockImplementation(outbox.enqueueNotice);
    const child = r.tool(true);
    expect(await child.execute()).toContain("effect unknown");
    expect(child.request).toHaveBeenCalledTimes(2);
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
    expect(r.state.outbox.list()).toHaveLength(1);
    expect(outbox.stats().queued).toBe(1);
    expect(child.recordReply).not.toHaveBeenCalled();
  });
  it("REAL durable enqueue then port throw remains unknown through the tool retry, without a second intent", async () => {
    const r = await rig(1);
    const outbox = createFeishuOutbox({
      state: r.state,
      clock: r.clock,
      api: { send: vi.fn(), reply: vi.fn() },
    });
    cleanups.push(() => outbox.dispose());
    let successfulEnqueues = 0;
    r.enqueueNotice.mockImplementation(async (input) => {
      const result = await outbox.enqueueNotice(input);
      expect(result).toMatchObject({ ok: true, durable: true });
      if (result.ok) successfulEnqueues++;
      throw new Error("lost completion AFTER durable enqueue: secret");
    });
    const child = r.tool(true);
    const content = await child.execute();
    expect(child.request).toHaveBeenCalledTimes(2);
    expect(r.enqueueNotice).toHaveBeenCalledOnce();
    expect(successfulEnqueues).toBe(1);
    expect(r.state.outbox.list()).toHaveLength(1);
    expect(outbox.stats().queued).toBe(1);
    expect(child.recordReply).not.toHaveBeenCalled();
    expect(content).toContain("effect unknown");
    expect(content).toContain("do NOT retry");
    expect(content).not.toContain("NOT sent");
    expect(content).not.toContain("secret");
  });

  it("confirmed queued evidence cannot be evicted within its dedup window either", async () => {
    const r = await rig(1000);
    for (let i = 1; i <= 256; i++) expect(await r.send(r.frame(i))).toMatchObject({ ok: true });
    expect(await r.send(r.frame(257))).toMatchObject({ ok: false, effect: "none" });
    expect(await r.send()).toMatchObject({ ok: true });
    expect(r.enqueueNotice).toHaveBeenCalledTimes(256);
    r.clock.advance(11 * 60_000);
    expect(await r.send(r.frame(257))).toMatchObject({ ok: true });
    expect(r.enqueueNotice).toHaveBeenCalledTimes(257);
  });
});
