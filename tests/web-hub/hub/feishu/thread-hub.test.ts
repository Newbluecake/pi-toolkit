import { afterEach, describe, expect, it, vi } from "vitest";
import {
  feishuHandbackBody,
  feishuHandbackNote,
  feishuThreadHandle,
  feishuThreadMetaFor,
  parseThreadRoutedResult,
} from "../../../../src/web-hub/hub/feishu/thread-hub.js";
import { THREAD_POST_TEXT_MAX_BYTES } from "../../../../src/web-hub/protocol/thread.js";
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
    const threads = createFeishuThreads({
      clock,
      config: CONFIG,
      state,
      installation: () => ({ appId: "cli_test", gen: 1, ownerOpenId: OWNER, installSecret: "s", active: true }),
      transport: () => ({ getCaps: () => ["thr.v1"], send: () => true }),
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
    return { clock, state, threads, seed };
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
