import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFeishuApi } from "../../../../src/web-hub/hub/feishu/api.js";
import type { FeishuApi } from "../../../../src/web-hub/hub/feishu/api.js";
import { createFeishuHttp } from "../../../../src/web-hub/hub/feishu/http.js";
import type { FeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import {
  FEISHU_OUTBOX_POLICY,
  FEISHU_TARGET_GONE_CODES,
  OUTBOX_FAIL_CODES,
  createFeishuOutbox,
  deriveSendId,
} from "../../../../src/web-hub/hub/feishu/outbox.js";
import type {
  EnqueueFinalInput,
  FeishuOutbox,
  FeishuOutboxPolicy,
  OutboxEvent,
  OutboxTarget,
  SettledGroup,
} from "../../../../src/web-hub/hub/feishu/outbox.js";
import { renderReply } from "../../../../src/web-hub/hub/feishu/render.js";
import {
  FEISHU_OUTBOX_FINAL_RESERVE,
  FEISHU_OUTBOX_SETTLED_TTL_MS,
  createFeishuState,
} from "../../../../src/web-hub/hub/feishu/state.js";
import type { FeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import { createTokenManager } from "../../../../src/web-hub/hub/feishu/token.js";
import { FEISHU_CAPS, FEISHU_REPLY_LIMITS } from "../../../../src/web-hub/protocol/feishu.js";
import { createFakeClock, createFakeFeishu, settle } from "../../../fixtures/feishu/fake-http.js";
import type { FakeClock, FakeFeishu } from "../../../fixtures/feishu/fake-http.js";

const REPLY_RE = /\/messages\/[^/]+\/reply$/;
const SEND_PATH = /\/open-apis\/im\/v1\/messages$/;
const OPEN_ID = "ou_0123456789abcdef";
const T0 = 1_760_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feishu-outbox-"));
});
const live: Array<{ state?: FeishuState; outbox?: FeishuOutbox }> = [];
afterEach(async () => {
  const states: FeishuState[] = [];
  for (const l of live.splice(0)) {
    l.outbox?.dispose();
    l.state?.dispose();
    if (l.state) states.push(l.state);
  }
  // a disposed state may still have ONE atomic write (unlink/open/write/rename chain) in flight, and the
  // synchronous rmSync below blocks the event loop so it can never be out-waited by rm retries: wait for
  // the writer to go idle (dispose guarantees nothing new starts), then remove the dir exactly once.
  await Promise.all(states.map((s) => s.whenIdle()));
  rmSync(root, { recursive: true, force: true });
});

interface Rig {
  clock: FakeClock;
  fake: FakeFeishu;
  state: FeishuState;
  outbox: FeishuOutbox;
  api: FeishuApi;
  settled: SettledGroup[];
  events: OutboxEvent[];
  /** next N message POSTs reach the platform (and deliver) but the response is lost */
  loseResponses(n: number): void;
  handler: { fail: boolean };
  /** simulate a process restart: flush, drop the old objects, rebuild over the same state dir */
  reboot(over?: { policy?: Partial<FeishuOutboxPolicy> }): Promise<void>;
  setCommit(fn: (() => Promise<boolean>) | undefined): void;
}

async function mkRig(
  opts: {
    policy?: Partial<FeishuOutboxPolicy>;
    start?: boolean;
    clock?: FakeClock;
    fake?: FakeFeishu;
    targetGoneCodes?: readonly number[];
  } = {},
): Promise<Rig> {
  const clock = opts.clock ?? createFakeClock(T0);
  const fake = opts.fake ?? createFakeFeishu();
  const settled: SettledGroup[] = [];
  const events: OutboxEvent[] = [];
  const handler = { fail: false };
  let lose = 0;
  let commitOverride: (() => Promise<boolean>) | undefined;
  // state: fake time, but REAL (short, unref'd) timers so group commits need no clock advance
  const stateClock: FeishuClock = {
    now: () => clock.now(),
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms <= 100 ? 1 : ms); // group commit (100 ms) fires fast; deadlines stay real
      h.unref();
      return h;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const rig = { settled, events, handler } as unknown as Rig;
  rig.clock = clock;
  rig.fake = fake;
  rig.loseResponses = (n) => {
    lose = n;
  };
  rig.setCommit = (fn) => {
    commitOverride = fn;
  };
  async function build(over: { policy?: Partial<FeishuOutboxPolicy> } | undefined, start: boolean): Promise<void> {
    const dir = join(root, "feishu-bot");
    const state = createFeishuState({ dir, clock: stateClock });
    await state.load();
    const wrapped = {
      outbox: state.outbox,
      commit: () => (commitOverride !== undefined ? commitOverride() : state.commit()),
    };
    const creds = { appId: fake.appId, appSecret: fake.appSecret, gen: 1 };
    let token: ReturnType<typeof createTokenManager>;
    const http = createFeishuHttp({
      apiBase: "https://open.feishu.cn",
      fetch: async (url, init) => {
        const res = await fake.fetch(url, init);
        if (lose > 0 && init.method === "POST" && /\/im\/v1\/messages/.test(url)) {
          lose--;
          throw new TypeError("connection reset");
        }
        return res;
      },
      clock,
      secrets: () => [creds.appSecret, ...(token?.peek() ? [token.peek()!] : [])],
    });
    token = createTokenManager({ http, clock, credentials: () => creds });
    const api = createFeishuApi({ http, token });
    const outbox = createFeishuOutbox({
      state: wrapped,
      api,
      clock,
      random: (n) => new Uint8Array(n).fill(7),
      onSettled: async (g) => {
        if (handler.fail) throw new Error("handler down");
        settled.push(g);
      },
      onEvent: (e) => events.push(e),
      ...(over?.policy ? { policy: over.policy } : {}),
      ...(opts.targetGoneCodes ? { targetGoneCodes: opts.targetGoneCodes } : {}),
    });
    live.push({ state, outbox });
    rig.state = state;
    rig.outbox = outbox;
    rig.api = api;
    if (start) outbox.start();
  }
  rig.reboot = async (over) => {
    await rig.state.commit();
    rig.outbox.dispose();
    rig.state.dispose();
    // the old state's last atomic write must be finished before the new one touches the same files
    await rig.state.whenIdle();
    await build(over ?? (opts.policy ? { policy: opts.policy } : undefined), true);
    await settle(20);
  };
  await build(opts.policy ? { policy: opts.policy } : undefined, opts.start !== false);
  return rig;
}

async function tick(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await settle(60);
}
async function run(clock: FakeClock, totalMs: number, stepMs: number): Promise<void> {
  for (let t = 0; t < totalMs; t += stepMs) await tick(clock, Math.min(stepMs, totalMs - t));
}
async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("until: timed out");
}

/** advance fake time in small steps (lane gaps / backoffs) interleaved with real I/O until `n` groups settled */
async function waitSettled(r: Rig, n: number): Promise<void> {
  for (let i = 0; i < 400 && r.settled.length < n; i++) {
    await tick(r.clock, 250);
    await new Promise((res) => setTimeout(res, 2));
  }
  expect(r.settled.length).toBeGreaterThanOrEqual(n);
}

const p2pReply = (messageId = "om_trigger"): OutboxTarget => ({ scope: "p2p", via: "reply", messageId });
const topic = (messageId = "om_topic_last"): OutboxTarget => ({ scope: "topic", messageId });
const card = (text: string) => renderReply({ kind: "done", label: "api · a1b2c3", text }).parts[0]!;
const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ msgType: "interactive" as const, content: card(`part ${i + 1}`).content }));
function final(over: Partial<EnqueueFinalInput> = {}, n = 1): EnqueueFinalInput {
  return { requestId: "fsREQ0001", target: p2pReply(), messages: msgs(n), ...over };
}
const replyCalls = (r: Rig) => r.fake.callsTo("POST", REPLY_RE);
const sendCalls = (r: Rig) => r.fake.callsTo("POST", SEND_PATH);
const bodyOf = (c: { json: unknown }) => c.json as Record<string, unknown>;

describe("sendId / uuid", () => {
  it("is deterministic, ≤50 chars of [A-Za-z0-9_-], distinct per part and seed", () => {
    const a = deriveSendId("fsREQ0001", 1);
    expect(deriveSendId("fsREQ0001", 1)).toBe(a);
    expect(a).toMatch(/^fo[A-Za-z0-9_-]{40}$/);
    expect(a.length).toBeLessThanOrEqual(50);
    const ids = new Set([
      a,
      deriveSendId("fsREQ0001", 2),
      deriveSendId("fsREQ0001~p2p", 1),
      deriveSendId("fsREQ0002", 1),
    ]);
    expect(ids.size).toBe(4);
  });
  it("the policy mirrors the frozen reply limits", () => {
    expect(FEISHU_OUTBOX_POLICY.maxRetries).toBe(FEISHU_REPLY_LIMITS.maxRetries);
    expect(FEISHU_OUTBOX_POLICY.taskBudgetMs).toBe(FEISHU_REPLY_LIMITS.taskBudgetMs);
    expect(FEISHU_OUTBOX_POLICY.perLaneMinGapMs).toBe(FEISHU_REPLY_LIMITS.perChatMinGapMs);
    expect(FEISHU_OUTBOX_POLICY.globalPerSecond).toBe(FEISHU_REPLY_LIMITS.globalPerSecond);
    expect(FEISHU_OUTBOX_POLICY.uuidSafeWindowMs).toBeLessThan(HOUR);
    expect(Object.isFrozen(FEISHU_OUTBOX_POLICY)).toBe(true);
  });
});

describe("delivery: happy path", () => {
  it("persists first, sends parts IN ORDER with the persisted sendId as uuid, then settles `delivered` and removes the group", async () => {
    const r = await mkRig();
    const res = await r.outbox.enqueueFinal(final({}, 3));
    expect(res).toMatchObject({ ok: true, durable: true, duplicate: false });
    if (!res.ok) throw new Error();
    expect(res.sendIds).toEqual([1, 2, 3].map((i) => deriveSendId("fsREQ0001", i)));
    // intent is on disk as queued before/while sending
    await settle(30);
    await waitSettled(r, 1);
    const wire = replyCalls(r);
    expect(wire).toHaveLength(3);
    expect(wire.map((c) => bodyOf(c)["uuid"])).toEqual(res.sendIds);
    expect(wire.map((c) => c.path)).toEqual(Array(3).fill("/open-apis/im/v1/messages/om_trigger/reply"));
    expect(wire.map((c) => JSON.parse(bodyOf(c)["content"] as string).header.title.content)).toEqual([
      "pi · api · a1b2c3",
      "pi · api · a1b2c3",
      "pi · api · a1b2c3",
    ]);
    expect(bodyOf(wire[0]!)["reply_in_thread"]).toBeFalsy();
    const g = r.settled[0]!;
    expect(g).toMatchObject({
      kind: "final",
      requestId: "fsREQ0001",
      outcome: "delivered",
      replyFailed: false,
      recovered: false,
    });
    expect(g.parts.map((p) => [p.part, p.state])).toEqual([
      [1, "sent"],
      [2, "sent"],
      [3, "sent"],
    ]);
    expect(g.parts.every((p) => typeof p.messageId === "string")).toBe(true);
    expect(g.target).toEqual({ route: "reply", targetId: "om_trigger", inThread: false });
    expect(r.state.outbox.size).toBe(0); // handler resolved ⇒ records removed
    expect(r.outbox.stats()).toMatchObject({ queued: 0, inFlight: 0, sent: 3, failed: 0 });
  });
  it("part N+1 is never sent before part N has been delivered (strict order), and spaced ≥250 ms on the same lane", async () => {
    const r = await mkRig();
    await r.outbox.enqueueFinal(final({}, 3));
    await settle(30);
    expect(replyCalls(r)).toHaveLength(1); // 250 ms lane gap holds back parts 2 and 3
    await tick(r.clock, 249);
    expect(replyCalls(r)).toHaveLength(1);
    await tick(r.clock, 1);
    expect(replyCalls(r)).toHaveLength(2);
    await tick(r.clock, 250);
    expect(replyCalls(r)).toHaveLength(3);
  });
  it("topic scope ⇒ reply with reply_in_thread:true; group-root keeps its flag and surfaces the thread id", async () => {
    const r = await mkRig();
    await r.outbox.enqueueFinal(final({ requestId: "fsTOPIC01", target: topic() }));
    await r.outbox.enqueueFinal(
      final({ requestId: "fsROOT001", target: { scope: "group-root", messageId: "om_root", inThread: true } }),
    );
    await r.outbox.enqueueFinal(
      final({ requestId: "fsROOT002", target: { scope: "group-root", messageId: "om_root2" } }),
    );
    await waitSettled(r, 3);
    const byPath = new Map(replyCalls(r).map((c) => [c.path, bodyOf(c)["reply_in_thread"]]));
    expect(byPath.get("/open-apis/im/v1/messages/om_topic_last/reply")).toBe(true);
    expect(byPath.get("/open-apis/im/v1/messages/om_root/reply")).toBe(true);
    expect(byPath.get("/open-apis/im/v1/messages/om_root2/reply")).toBeFalsy();
    const root = r.settled.find((g) => g.requestId === "fsROOT001")!;
    expect(root.parts[0]!.threadId).toBe("omt_fake_om_root"); // V8: binding comes from the reply response
    expect(root.target.inThread).toBe(true);
  });
  it("p2p proactive send uses receive_id_type=open_id (or chat_id) and never a reply", async () => {
    const r = await mkRig();
    await r.outbox.enqueueNotice({
      target: { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: OPEN_ID },
      message: { msgType: "text", content: '{"text":"hi"}' },
      key: "k1",
    });
    await r.outbox.enqueueNotice({
      target: { scope: "p2p", via: "send", receiveIdType: "chat_id", receiveId: "oc_p2p1" },
      message: { msgType: "text", content: '{"text":"hi2"}' },
      key: "k2",
    });
    await waitSettled(r, 2);
    expect(replyCalls(r)).toHaveLength(0);
    expect(
      sendCalls(r)
        .map((c) => c.query["receive_id_type"])
        .sort(),
    ).toEqual(["chat_id", "open_id"]);
    expect(r.settled.every((g) => g.kind === "notice" && g.outcome === "delivered")).toBe(true);
  });
  it("a duplicate enqueue (same request + variant) is recognised and sends nothing twice", async () => {
    const r = await mkRig();
    const a = await r.outbox.enqueueFinal(final({}, 2));
    const b = await r.outbox.enqueueFinal(final({}, 2));
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(a.ok && b.ok && a.sendIds).toEqual(b.ok && b.sendIds);
    await run(r.clock, 2_000, 100);
    expect(r.fake.sent).toHaveLength(2);
  });
  it("sent records drop their content; queued records keep exactly the route/inThread they were created with", async () => {
    const r = await mkRig({ start: false });
    await r.outbox.enqueueFinal(final({ target: topic() }, 2));
    const q = r.state.outbox.list();
    expect(q.map((p) => [p.state, p.route, p.inThread, p.part, p.parts, p.requestId, typeof p.content])).toEqual([
      ["queued", "reply", true, 1, 2, "fsREQ0001", "string"],
      ["queued", "reply", true, 2, 2, "fsREQ0001", "string"],
    ]);
    r.outbox.start();
    await waitSettled(r, 1);
  });
});

describe("target safety (never widen a topic reply)", () => {
  it("rejects malformed / forbidden targets before anything is stored", async () => {
    const r = await mkRig({ start: false });
    const bad: unknown[] = [
      { scope: "topic", receiveId: "oc_chat" },
      { scope: "topic", via: "send", receiveIdType: "chat_id", receiveId: "oc_chat" },
      { scope: "group-root", via: "send", receiveIdType: "chat_id", receiveId: "oc_chat" },
      { scope: "group", via: "send", receiveIdType: "chat_id", receiveId: "oc_chat" },
      { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: "not-an-open-id" },
      { scope: "p2p", via: "reply", messageId: "bad id/with space" },
      { scope: "p2p", via: "other" },
      { scope: "topic", messageId: "" },
      null,
      "om_x",
    ];
    for (const t of bad) {
      expect(await r.outbox.enqueueFinal(final({ target: t as OutboxTarget })), JSON.stringify(t)).toEqual({
        ok: false,
        refused: "invalid-target",
      });
      expect(
        await r.outbox.enqueueNotice({ target: t as OutboxTarget, message: { msgType: "text", content: "{}" } }),
      ).toEqual({ ok: false, refused: "invalid-target" });
    }
    expect(r.state.outbox.size).toBe(0);
  });
  it("validates requests, variants, messages and part counts", async () => {
    const r = await mkRig({ start: false });
    for (const requestId of ["", "has space", "a~b", "x".repeat(101)])
      expect(await r.outbox.enqueueFinal(final({ requestId }))).toEqual({ ok: false, refused: "invalid-request" });
    expect(await r.outbox.enqueueFinal(final({ variant: "bad variant" }))).toEqual({
      ok: false,
      refused: "invalid-request",
    });
    expect(await r.outbox.enqueueFinal(final({ messages: [] }))).toEqual({ ok: false, refused: "invalid-message" });
    expect(await r.outbox.enqueueFinal(final({ messages: [{ msgType: "interactive", content: "" }] }))).toEqual({
      ok: false,
      refused: "invalid-message",
    });
    expect(await r.outbox.enqueueFinal(final({ messages: [{ msgType: "video" as never, content: "{}" }] }))).toEqual({
      ok: false,
      refused: "invalid-message",
    });
    expect(
      await r.outbox.enqueueFinal(
        final({ messages: [{ msgType: "text", content: "x".repeat(FEISHU_REPLY_LIMITS.maxCardBytes + 1) }] }),
      ),
    ).toEqual({ ok: false, refused: "invalid-message" });
    expect(await r.outbox.enqueueFinal(final({}, 9))).toEqual({ ok: false, refused: "too-many-parts" });
    expect(
      await r.outbox.enqueueNotice({
        target: p2pReply(),
        message: { msgType: "text", content: "{}" },
        key: "has space",
      }),
    ).toEqual({ ok: false, refused: "invalid-request" });
    expect(r.state.outbox.size).toBe(0);
  });
  it("a deleted/withdrawn TOPIC reply target ⇒ failed(target-gone), exactly one API call, NO chat-level fallback, rest skipped", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 400, json: { code: 230011, msg: "The message was withdrawn." } });
    await r.outbox.enqueueFinal(final({ target: topic() }, 3));
    await waitSettled(r, 1);
    await run(r.clock, 5_000, 250);
    expect(replyCalls(r)).toHaveLength(1);
    expect(sendCalls(r)).toHaveLength(0);
    expect(r.fake.sent).toHaveLength(0);
    const g = r.settled[0]!;
    expect(g).toMatchObject({ outcome: "failed", replyFailed: true, code: OUTBOX_FAIL_CODES.targetGone });
    expect(g.parts.map((p) => p.code)).toEqual(["target-gone", "skipped:target-gone", "skipped:target-gone"]);
    expect(g.parts.every((p) => p.undelivered !== undefined && p.undelivered.content.length > 0)).toBe(true);
    expect(r.events).toContainEqual({ event: "failed", kind: "final", code: "target-gone" });
  });
  it("the target-gone codes are the documented defaults and are injectable", async () => {
    expect(FEISHU_TARGET_GONE_CODES).toEqual([230011, 231003, 230002]);
    const r = await mkRig({ targetGoneCodes: [999999] });
    r.fake.script("POST", REPLY_RE, { status: 400, json: { code: 999999, msg: "gone" } });
    await r.outbox.enqueueFinal(final());
    await waitSettled(r, 1);
    expect(r.settled[0]!.code).toBe("target-gone");
  });
  it("p2p target-gone: the caller may re-enqueue the undelivered content as a NEW variant via proactive send (different uuid)", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 400, json: { code: 231003, msg: "not found" } });
    await r.outbox.enqueueFinal(final({}, 2));
    await waitSettled(r, 1);
    const first = r.settled[0]!;
    expect(first.replyFailed).toBe(true);
    const redo = await r.outbox.enqueueFinal({
      requestId: first.requestId!,
      variant: "p2p",
      target: { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: OPEN_ID },
      messages: first.parts.map((p) => p.undelivered!),
    });
    expect(redo).toMatchObject({ ok: true, duplicate: false });
    await waitSettled(r, 2);
    expect(r.settled[1]).toMatchObject({ requestId: "fsREQ0001", variant: "p2p", outcome: "delivered" });
    expect(r.fake.sent).toHaveLength(2);
    expect(new Set(r.fake.sent.map((s) => s.uuid)).size).toBe(2);
    expect(r.fake.sent.every((s) => s.kind === "send")).toBe(true);
  });
});

describe("retry / backoff / same uuid", () => {
  it("retries a transport failure with the SAME uuid on the 1 s / 3 s backoff and delivers exactly once", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { networkError: true }, { networkError: true });
    await r.outbox.enqueueFinal(final());
    await settle(30);
    expect(replyCalls(r)).toHaveLength(1);
    await tick(r.clock, 999);
    expect(replyCalls(r)).toHaveLength(1);
    await tick(r.clock, 1);
    expect(replyCalls(r)).toHaveLength(2);
    await tick(r.clock, 2_999);
    expect(replyCalls(r)).toHaveLength(2);
    await tick(r.clock, 1);
    expect(replyCalls(r)).toHaveLength(3);
    await waitSettled(r, 1);
    const uuids = new Set(replyCalls(r).map((c) => bodyOf(c)["uuid"]));
    expect(uuids.size).toBe(1);
    expect(r.fake.sent).toHaveLength(1);
    expect(r.settled[0]).toMatchObject({ outcome: "delivered" });
    expect(r.events.filter((e) => e.event === "retry")).toHaveLength(2);
  });
  it("a LOST RESPONSE (message delivered, client saw a failure) does not duplicate: same uuid ⇒ platform dedup", async () => {
    const r = await mkRig();
    r.loseResponses(1);
    await r.outbox.enqueueFinal(final());
    await settle(30);
    expect(r.fake.sent).toHaveLength(1); // it DID go out
    await run(r.clock, 1_500, 250);
    await waitSettled(r, 1);
    expect(replyCalls(r)).toHaveLength(2);
    expect(r.fake.sent).toHaveLength(1);
    expect(r.settled[0]!.parts[0]!.messageId).toBe(r.fake.sent[0]!.messageId);
  });
  it("230020 (send-uncertain) is retried with the same uuid", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 200, json: { code: 230020, msg: "frequency" } });
    await r.outbox.enqueueFinal(final());
    await settle(30);
    await run(r.clock, 1_500, 250);
    await waitSettled(r, 1);
    expect(new Set(replyCalls(r).map((c) => bodyOf(c)["uuid"])).size).toBe(1);
  });
  it("persists attempts and the effect marker (u: unknown / n: none) on every failed try", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 429, json: { code: 99991400, msg: "rate" } }, { networkError: true });
    await r.outbox.enqueueFinal(final());
    await settle(30);
    let rec = r.state.outbox.list()[0]!;
    expect(rec).toMatchObject({ state: "queued", attempts: 1 });
    expect(rec.code!.startsWith("n:")).toBe(true);
    await tick(r.clock, 1_000);
    rec = r.state.outbox.list()[0]!;
    expect(rec.attempts).toBe(2);
    expect(rec.code!.startsWith("u:")).toBe(true); // sticky once an attempt had unknown effect
    await run(r.clock, 3_000, 250);
    await waitSettled(r, 1);
  });
  it("a cycle ends after 1+maxRetries tries; the part stays queued and a new cycle starts on the 30 s ladder", async () => {
    const r = await mkRig();
    r.fake.on("POST", REPLY_RE, () => ({ networkError: true }));
    await r.outbox.enqueueFinal(final());
    await settle(30);
    await run(r.clock, 4_100, 100);
    expect(replyCalls(r)).toHaveLength(3);
    const rec = r.state.outbox.list()[0]!;
    expect(rec).toMatchObject({ state: "queued", attempts: 3 });
    await run(r.clock, 25_000, 1_000);
    expect(replyCalls(r)).toHaveLength(3); // ladder[0] = 30 s after the cycle end
    await run(r.clock, 6_000, 500);
    expect(replyCalls(r).length).toBeGreaterThanOrEqual(4);
    expect(r.settled).toHaveLength(0); // queued is not failed
  });
  it("a never-answering endpoint is aborted by the 8 s call deadline and retried", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { hang: true });
    await r.outbox.enqueueFinal(final());
    await until(() => replyCalls(r).length === 1);
    await settle(30);
    await tick(r.clock, 8_000);
    await tick(r.clock, 1_000);
    expect(replyCalls(r)).toHaveLength(2);
    await waitSettled(r, 1);
  });
  it("parts of a group are sent strictly in order even while an earlier part is retrying", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { networkError: true });
    await r.outbox.enqueueFinal(final({}, 2));
    await settle(30);
    expect(replyCalls(r)).toHaveLength(1);
    await tick(r.clock, 500);
    expect(replyCalls(r)).toHaveLength(1); // part 2 waits for part 1
    await run(r.clock, 2_000, 250);
    await waitSettled(r, 1);
    const order = r.fake.sent.map((s) => JSON.parse(String(s.body["content"])).body.elements[0].content);
    expect(order).toEqual(["part 1", "part 2"]);
  });
});

describe("expiry is explicit, never silent", () => {
  it("an unknown-effect part is failed `expired-uncertain` once the uuid-safe window passes (no further sends)", async () => {
    const r = await mkRig();
    r.fake.on("POST", REPLY_RE, () => ({ networkError: true }));
    await r.outbox.enqueueFinal(final());
    await settle(30);
    await run(r.clock, 49 * MIN, 30_000);
    expect(r.settled).toHaveLength(0);
    const calls = replyCalls(r).length;
    await run(r.clock, 3 * MIN, 15_000);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "failed", replyFailed: true, code: "expired-uncertain" });
    expect(r.settled[0]!.parts[0]!.undelivered).toBeDefined();
    expect(replyCalls(r).length).toBeLessThanOrEqual(calls + 1);
    const after = replyCalls(r).length;
    await run(r.clock, 2 * HOUR, 10 * MIN);
    expect(replyCalls(r)).toHaveLength(after);
  });
  it("a part that only ever failed with provable no-effect keeps retrying (throttled) until the 24 h max age, then `expired`", async () => {
    const r = await mkRig();
    r.fake.on("POST", REPLY_RE, () => ({ status: 429, json: { code: 99991400, msg: "rate" } }));
    await r.outbox.enqueueFinal(final());
    await settle(30);
    await run(r.clock, 23 * HOUR, 5 * MIN);
    expect(r.settled).toHaveLength(0);
    expect(r.state.outbox.list({ state: "queued" })).toHaveLength(1); // never evicted by the state sweep either
    const n = replyCalls(r).length;
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(60); // ladder keeps it cheap
    await run(r.clock, 2 * HOUR, 5 * MIN);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "failed", code: "expired", replyFailed: true });
  });
  it("notices expire after 10 minutes", async () => {
    const r = await mkRig();
    r.fake.on("POST", SEND_PATH, () => ({ status: 429, json: { code: 99991400, msg: "rate" } }));
    await r.outbox.enqueueNotice({
      target: { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: OPEN_ID },
      message: { msgType: "text", content: '{"text":"x"}' },
    });
    await settle(30);
    await run(r.clock, 9 * MIN, 30_000);
    expect(r.settled).toHaveLength(0);
    await run(r.clock, 2 * MIN, 30_000);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ kind: "notice", outcome: "failed", code: "expired", replyFailed: true });
  });
});

describe("timer hygiene", () => {
  it("an in-flight call older than its max age does not busy-spin the timer; it expires once the call returns", async () => {
    const r = await mkRig({ policy: { noticeMaxAgeMs: 1_000 } });
    r.fake.on("POST", REPLY_RE, () => ({ hang: true }));
    await r.outbox.enqueueNotice({
      target: p2pReply(),
      message: { msgType: "text", content: '{"text":"x"}' },
      key: "k",
    });
    await settle(30);
    expect(r.outbox.stats().inFlight).toBe(1);
    await tick(r.clock, 3_000); // would never return before the fix (zero-delay re-arm loop)
    expect(r.clock.pending()).toBeLessThanOrEqual(3);
    await tick(r.clock, 6_000); // the 8 s call deadline fires
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "failed", code: "expired" });
  });
});

describe("failure classification", () => {
  it("a plain rejection of one part fails only that part: the group continues and settles `partial`", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 400, json: { code: 230001, msg: "invalid param" } });
    await r.outbox.enqueueFinal(final({}, 3));
    await run(r.clock, 2_000, 250);
    await waitSettled(r, 1);
    const g = r.settled[0]!;
    expect(g).toMatchObject({ outcome: "partial", replyFailed: true, code: "rejected:api-code-230001" });
    expect(g.parts.map((p) => p.state)).toEqual(["failed", "sent", "sent"]);
    expect(r.fake.sent).toHaveLength(2);
  });
  it("capability-denied (99991672) fails the group without retry and raises the capability event", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 400, json: { code: 99991672, msg: "Access denied. scope: im:message" } });
    await r.outbox.enqueueFinal(final({}, 2));
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "failed", code: "capability-denied" });
    expect(r.settled[0]!.parts.map((p) => p.code)).toEqual(["capability-denied", "skipped:capability-denied"]);
    expect(r.events).toContainEqual({ event: "capability-denied", msgType: "interactive" });
    expect(replyCalls(r)).toHaveLength(1);
  });
  it("an unrecognised rejection code is failed `rejected:api-code-N` (no retry, no widening)", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 400, json: { code: 230099, msg: "weird" } });
    await r.outbox.enqueueFinal(final());
    await waitSettled(r, 1);
    expect(r.settled[0]!.code).toBe("rejected:api-code-230099");
  });
});

describe("auth failure pauses, never fails (except by max age)", () => {
  it("pauses on a bad token, probes once a minute, resumes on success and then delivers", async () => {
    const r = await mkRig();
    let bad = true;
    r.fake.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () =>
      bad ? { json: { code: 10014, msg: "app secret invalid" } } : undefined,
    );
    await r.outbox.enqueueFinal(final({}, 2));
    await settle(30);
    expect(r.events.filter((e) => e.event === "paused")).toEqual([{ event: "paused", reason: "auth_failed" }]);
    expect(r.outbox.stats()).toMatchObject({ paused: "auth_failed", queued: 2, failed: 0 });
    expect(replyCalls(r)).toHaveLength(0);
    const tokenCalls = () => r.fake.callsTo("POST", "/open-apis/auth/v3/tenant_access_token/internal").length;
    const before = tokenCalls();
    await run(r.clock, 59_000, 1_000);
    expect(tokenCalls()).toBe(before);
    await run(r.clock, 2_000, 500);
    expect(tokenCalls()).toBeGreaterThan(before);
    expect(r.settled).toHaveLength(0);
    // credentials fixed: resume() probes immediately
    bad = false;
    await tick(r.clock, 31_000); // clear the token manager's 30 s negative cache
    r.outbox.resume();
    await settle(30);
    await run(r.clock, 2_000, 250);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "delivered" });
    expect(r.events).toContainEqual({ event: "resumed" });
    expect(r.outbox.stats().paused).toBeUndefined();
  });
  it("a paused queue still ages out explicitly", async () => {
    const r = await mkRig();
    r.fake.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({ json: { code: 10014, msg: "bad" } }));
    await r.outbox.enqueueNotice({ target: p2pReply(), message: { msgType: "text", content: '{"text":"x"}' } });
    await run(r.clock, 11 * MIN, 30_000);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "failed", code: "expired" });
  });
});

describe("rate limits", () => {
  it("global ≤20 sends per second, ≤4 in flight", async () => {
    const r = await mkRig({ start: false });
    for (let i = 0; i < 30; i++)
      await r.outbox.enqueueNotice({
        target: { scope: "p2p", via: "reply", messageId: `om_${i}` },
        message: { msgType: "text", content: '{"text":"n"}' },
        key: `k${i}`,
      });
    r.outbox.start();
    await settle(60);
    expect(replyCalls(r)).toHaveLength(20);
    await tick(r.clock, 1_001);
    await settle(30);
    expect(replyCalls(r)).toHaveLength(30);
  });
  it("at most maxInFlight calls are concurrently outstanding", async () => {
    const r = await mkRig({ start: false });
    r.fake.on("POST", REPLY_RE, () => ({ hang: true }));
    for (let i = 0; i < 10; i++)
      await r.outbox.enqueueNotice({
        target: { scope: "p2p", via: "reply", messageId: `om_${i}` },
        message: { msgType: "text", content: '{"text":"n"}' },
        key: `k${i}`,
      });
    r.outbox.start();
    await settle(40);
    expect(replyCalls(r)).toHaveLength(4);
    expect(r.outbox.stats().inFlight).toBe(4);
  });
  it("different groups to the same lane are spaced ≥250 ms; laneKey groups distinct targets into one chat lane", async () => {
    const r = await mkRig();
    for (const [i, id] of ["fsA", "fsB"].entries())
      await r.outbox.enqueueFinal(final({ requestId: id, target: p2pReply(`om_${i}`), laneKey: "oc_chat" }));
    await settle(40);
    expect(replyCalls(r)).toHaveLength(1);
    await tick(r.clock, 250);
    expect(replyCalls(r)).toHaveLength(2);
  });
});

describe("caps: finals are never silently dropped", () => {
  it("notices stop at cap−64 while finals can use the reserve; a refused final says so loudly and leaves nothing half-written", async () => {
    const r = await mkRig({ start: false });
    const noticeCap = FEISHU_CAPS.outboxParts - FEISHU_OUTBOX_FINAL_RESERVE;
    for (let i = 0; i < noticeCap; i++) {
      const res = await r.outbox.enqueueNotice({
        target: p2pReply(`om_n${i}`),
        message: { msgType: "text", content: '{"text":"n"}' },
        key: `n${i}`,
      });
      expect(res.ok).toBe(true);
    }
    expect(
      await r.outbox.enqueueNotice({
        target: p2pReply("om_x"),
        message: { msgType: "text", content: '{"text":"n"}' },
        key: "overflow",
      }),
    ).toEqual({ ok: false, refused: "cap" });
    // 64 reserved slots: a 4-part final fits 16 times
    for (let i = 0; i < 16; i++)
      expect((await r.outbox.enqueueFinal(final({ requestId: `fsF${i}` }, 4))).ok).toBe(true);
    expect(r.state.outbox.size).toBe(FEISHU_CAPS.outboxParts);
    const refused = await r.outbox.enqueueFinal(final({ requestId: "fsLATE" }, 3));
    expect(refused).toEqual({ ok: false, refused: "cap" });
    expect(r.state.outbox.size).toBe(FEISHU_CAPS.outboxParts); // no partial group left behind
    expect(r.state.outbox.list().filter((p) => p.requestId === "fsLATE")).toHaveLength(0);
    expect(r.events).toContainEqual({ event: "refused", kind: "final", refused: "cap" });
  });
  it("a group that does not entirely fit is rolled back atomically", async () => {
    const r = await mkRig({ start: false });
    const noticeCap = FEISHU_CAPS.outboxParts - FEISHU_OUTBOX_FINAL_RESERVE;
    for (let i = 0; i < noticeCap + 62; i++) {
      const res =
        i < noticeCap
          ? await r.outbox.enqueueNotice({
              target: p2pReply(`om_n${i}`),
              message: { msgType: "text", content: '{"text":"n"}' },
              key: `n${i}`,
            })
          : await r.outbox.enqueueFinal(final({ requestId: `fsX${i}`, messages: msgs(1) }));
      expect(res.ok).toBe(true);
    }
    const size = r.state.outbox.size;
    expect(await r.outbox.enqueueFinal(final({ requestId: "fsBIG" }, 4))).toEqual({ ok: false, refused: "cap" });
    expect(r.state.outbox.size).toBe(size);
  }, 20_000);
});

describe("durability & crash matrix", () => {
  it("never sends before the queued record is durable; sends once the commit succeeds", async () => {
    const r = await mkRig();
    r.setCommit(async () => false);
    const res = await r.outbox.enqueueFinal(final());
    expect(res).toMatchObject({ ok: true, durable: false });
    await run(r.clock, 3_000, 500);
    expect(replyCalls(r)).toHaveLength(0);
    r.setCommit(undefined);
    await run(r.clock, 2_000, 500);
    await waitSettled(r, 1);
    expect(replyCalls(r)).toHaveLength(1);
  });
  it("crash after commit, before send: the restarted outbox sends the persisted part (same uuid)", async () => {
    const r = await mkRig({ start: false });
    const res = await r.outbox.enqueueFinal(final({}, 2));
    if (!res.ok) throw new Error();
    await r.reboot();
    await run(r.clock, 1_000, 250);
    await waitSettled(r, 1);
    expect(r.fake.sent.map((s) => s.uuid)).toEqual(res.sendIds);
    expect(r.settled[0]).toMatchObject({ outcome: "delivered", recovered: false });
  });
  it("crash after the platform accepted the send but before `sent` was persisted: the restart resends the SAME uuid ⇒ no duplicate message", async () => {
    const r = await mkRig({ start: false });
    const res = await r.outbox.enqueueFinal(final());
    if (!res.ok) throw new Error();
    // the platform got it (e.g. the process died right after the HTTP response), the store still says queued
    const direct = await r.api.reply({
      messageId: "om_trigger",
      msgType: "interactive",
      content: card("part 1").content,
      uuid: res.sendIds[0]!,
    });
    expect(direct.ok).toBe(true);
    await r.reboot();
    await run(r.clock, 1_000, 250);
    await waitSettled(r, 1);
    expect(r.fake.sent).toHaveLength(1);
    expect(r.settled[0]!.outcome).toBe("delivered");
  });
  it("crash with an in-flight call: stop() aborts it, the part stays queued, the restart delivers it", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { hang: true });
    const res = await r.outbox.enqueueFinal(final());
    if (!res.ok) throw new Error();
    await settle(30);
    expect(r.outbox.stats().inFlight).toBe(1);
    const stopping = r.outbox.stop(2_000);
    await tick(r.clock, 2_000);
    await tick(r.clock, 100);
    expect(await stopping).toEqual({ drained: false, aborted: 1 });
    expect(r.state.outbox.get(res.sendIds[0]!)).toMatchObject({ state: "queued" });
    expect(r.settled).toHaveLength(0);
    await r.reboot();
    await run(r.clock, 1_000, 250);
    await waitSettled(r, 1);
    expect(r.fake.sent).toHaveLength(1);
  });
  it("stop() lets a fast in-flight call finish inside the drain budget (drained:true) and then sends nothing more", async () => {
    const r = await mkRig();
    await r.outbox.enqueueFinal(final({}, 3));
    await settle(30);
    const done = await r.outbox.stop(2_000);
    expect(done.aborted).toBe(0);
    const n = replyCalls(r).length;
    await run(r.clock, 5_000, 250);
    expect(replyCalls(r)).toHaveLength(n); // unsent parts stay queued ON DISK
    expect(r.state.outbox.list({ state: "queued" }).length).toBe(3 - n);
    expect(r.clock.pending()).toBe(0); // no timer left behind
    // enqueue after stop still persists (shutdown-time results are not lost) but sends nothing
    const late = await r.outbox.enqueueFinal(final({ requestId: "fsLATE001" }));
    expect(late).toMatchObject({ ok: true, durable: true });
    await run(r.clock, 2_000, 250);
    expect(replyCalls(r)).toHaveLength(n);
    await r.reboot();
    await run(r.clock, 3_000, 250);
    await waitSettled(r, 2);
  });
  it("crash after everything settled but before the handler consumed it: the restart re-emits the group (recovered:true); a resolved handler removes it", async () => {
    const r = await mkRig();
    r.handler.fail = true;
    await r.outbox.enqueueFinal(final({}, 2));
    await run(r.clock, 1_000, 250);
    await settle(30);
    expect(r.settled).toHaveLength(0);
    expect(r.state.outbox.list({ state: "sent" })).toHaveLength(2); // still on disk
    expect(r.state.outbox.list().every((p) => p.content === undefined)).toBe(true);
    await r.reboot();
    r.handler.fail = false;
    await r.reboot();
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ recovered: true, outcome: "delivered", requestId: "fsREQ0001" });
    expect(r.settled[0]!.parts.map((p) => p.state)).toEqual(["sent", "sent"]);
    await until(() => r.state.outbox.size === 0);
  });
  it("a failing handler is retried after settleRetryMs, in-process, without a restart", async () => {
    const r = await mkRig();
    r.handler.fail = true;
    await r.outbox.enqueueFinal(final());
    await settle(30);
    expect(r.events).toContainEqual({ event: "settle-error" });
    r.handler.fail = false;
    await tick(r.clock, FEISHU_OUTBOX_POLICY.settleRetryMs);
    await settle(30);
    await waitSettled(r, 1);
    expect(r.settled[0]!.recovered).toBe(true);
    expect(r.state.outbox.size).toBe(0);
    expect(r.fake.sent).toHaveLength(1);
  });
  it("a failed group survives a restart with its failure code and is re-reported (replyFailed)", async () => {
    const r = await mkRig();
    r.handler.fail = true;
    r.fake.script("POST", REPLY_RE, { status: 400, json: { code: 230011, msg: "withdrawn" } });
    await r.outbox.enqueueFinal(final({ target: topic() }, 2));
    await settle(40);
    await r.reboot();
    r.handler.fail = false;
    await r.reboot();
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "failed", replyFailed: true, code: "target-gone", recovered: true });
    expect(r.settled[0]!.target).toEqual({ route: "reply", targetId: "om_topic_last", inThread: true });
    expect(r.settled[0]!.parts.every((p) => p.undelivered === undefined)).toBe(true); // content is gone across a restart
  });
  it("a restarted retry keeps the unknown-effect marker (uuid window still bounded by createdAt)", async () => {
    const r = await mkRig();
    r.fake.on("POST", REPLY_RE, () => ({ networkError: true }));
    await r.outbox.enqueueFinal(final());
    await settle(30);
    await run(r.clock, 2 * MIN, 5_000);
    await r.reboot();
    expect(r.state.outbox.list()[0]!.code!.startsWith("u:")).toBe(true);
    await run(r.clock, 52 * MIN, 30_000);
    await waitSettled(r, 1);
    expect(r.settled[0]!.code).toBe("expired-uncertain");
  });
  it("settled records are swept by the state after 1 h, queued ones never", async () => {
    const r = await mkRig({ start: false });
    r.handler.fail = true;
    await r.outbox.enqueueFinal(final({ requestId: "fsSENT01" }));
    await r.outbox.enqueueFinal(final({ requestId: "fsQUEUED1", target: p2pReply("om_other") }));
    r.fake.on("POST", /\/messages\/om_other\/reply$/, () => ({ status: 429, json: { code: 99991400, msg: "rate" } }));
    r.outbox.start();
    await run(r.clock, 5_000, 250);
    expect(r.state.outbox.list({ state: "sent" })).toHaveLength(1);
    r.clock.advance(FEISHU_OUTBOX_SETTLED_TTL_MS + 1);
    r.state.sweep();
    expect(r.state.outbox.list({ state: "sent" })).toHaveLength(0);
    expect(r.state.outbox.list({ state: "queued" })).toHaveLength(1);
  });
});

describe("settled sibling swept while others are still queued (r_ASBT6095 F5)", () => {
  async function sweptGroup(): Promise<{ r: Rig; failing: { on: boolean } }> {
    const r = await mkRig();
    const failing = { on: false };
    let calls = 0;
    r.fake.on("POST", REPLY_RE, () => {
      calls++;
      return calls > 1 && failing.on ? { status: 429, json: { code: 99991400, msg: "rate" } } : undefined;
    });
    failing.on = true;
    await r.outbox.enqueueFinal(final({}, 2)); // part 1 delivers, part 2 keeps getting 429
    await run(r.clock, 3_000, 250);
    expect(r.state.outbox.list({ state: "sent" })).toHaveLength(1);
    // > 1 h later the state sweeps the settled part-1 record; part 2 is still queued
    await run(r.clock, 70 * MIN, 60_000);
    r.state.sweep();
    expect(r.state.outbox.list({ state: "sent" })).toHaveLength(0);
    expect(r.state.outbox.list({ state: "queued" })).toHaveLength(1);
    return { r, failing };
  }
  it("in-process: the group still settles, remembering the swept part from its tombstone (no `swept`)", async () => {
    const { r, failing } = await sweptGroup();
    failing.on = false;
    await run(r.clock, 70 * MIN, 60_000);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "delivered", replyFailed: false, requestId: "fsREQ0001" });
    expect(r.settled[0]!.parts.map((p) => [p.part, p.state])).toEqual([
      [1, "sent"],
      [2, "sent"],
    ]);
    expect(r.settled[0]!.swept).toBeUndefined();
    expect(r.fake.sent).toHaveLength(2);
  });
  it("after a restart the swept part is unknown: the group still settles and says how many parts were swept", async () => {
    const { r, failing } = await sweptGroup();
    failing.on = false;
    await r.reboot();
    await run(r.clock, 70 * MIN, 60_000);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "delivered", swept: 1, recovered: false });
    expect(r.settled[0]!.parts.map((p) => p.part)).toEqual([2]);
    await until(() => r.state.outbox.size === 0);
  });
  it("a swept FAILED sibling is still reported as failed in-process (partial)", async () => {
    const r = await mkRig();
    let calls = 0;
    let throttled = true;
    r.fake.on("POST", REPLY_RE, () => {
      calls++;
      if (calls === 1) return { status: 400, json: { code: 230001, msg: "invalid" } };
      return throttled ? { status: 429, json: { code: 99991400, msg: "rate" } } : undefined;
    });
    await r.outbox.enqueueFinal(final({}, 2));
    await run(r.clock, 3_000, 250);
    await run(r.clock, 70 * MIN, 60_000);
    r.state.sweep();
    expect(r.state.outbox.list({ state: "failed" })).toHaveLength(0);
    expect(r.settled).toHaveLength(0);
    throttled = false;
    await run(r.clock, 70 * MIN, 60_000);
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ outcome: "partial", replyFailed: true, code: "rejected:api-code-230001" });
    expect(r.settled[0]!.parts.map((p) => p.state)).toEqual(["failed", "sent"]);
  });
});

describe("hygiene", () => {
  it("events and settled targets carry no content, ids or secrets", async () => {
    const r = await mkRig();
    r.fake.script(
      "POST",
      REPLY_RE,
      { networkError: true },
      { status: 400, json: { code: 230011, msg: `gone ${r.fake.appSecret}` } },
    );
    await r.outbox.enqueueFinal(final({ target: topic("om_secret_msg") }, 2));
    await run(r.clock, 3_000, 250);
    await waitSettled(r, 1);
    const dump = JSON.stringify(r.events);
    for (const needle of ["om_secret_msg", r.fake.appSecret, "part 1", "fo", "uuid", "https://"])
      expect(dump).not.toContain(needle);
  });
  it("failure codes persisted on parts are ≤64 chars and printable", async () => {
    const r = await mkRig();
    r.fake.script("POST", REPLY_RE, { status: 200, text: "<html>not json" });
    await r.outbox.enqueueFinal(final());
    await settle(30);
    const rec = r.state.outbox.list()[0]!;
    expect(rec.code!.length).toBeLessThanOrEqual(64);
    expect(rec.code).toMatch(/^[un]:[\x20-\x7e]+$/);
    await run(r.clock, 2_000, 250);
  });
  it("dispose() leaves no timer and refuses further enqueues", async () => {
    const r = await mkRig();
    r.fake.on("POST", REPLY_RE, () => ({ networkError: true }));
    await r.outbox.enqueueFinal(final());
    await settle(30);
    r.outbox.dispose();
    expect(r.clock.pending()).toBe(0);
    expect(await r.outbox.enqueueFinal(final({ requestId: "fsAFTER01" }))).toEqual({ ok: false, refused: "disposed" });
  });
  it("start() is idempotent", async () => {
    const r = await mkRig();
    r.outbox.start();
    r.outbox.start();
    await r.outbox.enqueueFinal(final());
    await waitSettled(r, 1);
    expect(r.fake.sent).toHaveLength(1);
  });
});

describe("notice tag (feishu-xs-mirror §4.2/§4.6)", () => {
  const T = { scope: "p2p", via: "send", receiveIdType: "chat_id", receiveId: "oc_p2p1" } as const;
  const msg = { msgType: "text", content: '{"text":"x"}' } as const;
  it("a valid tag is persisted as requestId; seed/sendId equal the untagged notice", async () => {
    const r = await mkRig({ start: false });
    const tagged = await r.outbox.enqueueNotice({ target: T, message: msg, key: "kk", tag: "xsm:abc_-9" });
    expect(tagged).toMatchObject({ ok: true, duplicate: false });
    const rec = r.state.outbox.list({ state: "queued" })[0]!;
    expect(rec.requestId).toBe("xsm:abc_-9");
    if (!tagged.ok) throw new Error();
    expect(tagged.sendIds).toEqual([deriveSendId("notice\nkk", 1)]); // seed unchanged by the tag
  });
  it("an invalid tag is refused invalid-request; no tag leaves the record byte-identical (no requestId)", async () => {
    const r = await mkRig({ start: false });
    for (const tag of ["", "xsm:", "xsm:a b", "other:abc", `xsm:${"a".repeat(61)}`])
      expect(await r.outbox.enqueueNotice({ target: T, message: msg, tag })).toEqual({
        ok: false,
        refused: "invalid-request",
      });
    expect(r.state.outbox.size).toBe(0);
  });
  it("the same tag while its record exists is a duplicate (nothing added)", async () => {
    const r = await mkRig({ start: false });
    await r.outbox.enqueueNotice({ target: T, message: msg, key: "xsm:dup", tag: "xsm:dup" });
    const again = await r.outbox.enqueueNotice({ target: T, message: msg, key: "xsm:dup", tag: "xsm:dup" });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(r.state.outbox.size).toBe(1);
  });
  it("a tagged notice settles with kind notice + the tag as requestId, then its record is deleted (R7 pinned)", async () => {
    const r = await mkRig();
    await r.outbox.enqueueNotice({ target: T, message: msg, key: "xsm:s1", tag: "xsm:s1" });
    await waitSettled(r, 1);
    expect(r.settled[0]).toMatchObject({ kind: "notice", requestId: "xsm:s1", outcome: "delivered" });
    await settle(30);
    expect(r.state.outbox.list()).toHaveLength(0);
  });
});
