import { describe, expect, it } from "vitest";

import type { EnqueueNoticeInput, EnqueueResult } from "../../../../src/web-hub/hub/feishu/outbox.js";
import type { FeishuBinding } from "../../../../src/web-hub/hub/feishu/state.js";
import {
  XSM_GLOBAL_CARDS_PER_MIN,
  XSM_MAX_AGE_MS,
  XSM_PER_BINDING_PER_HOUR,
  XSM_PER_BINDING_PER_MIN,
  XSM_QUEUE_MAX,
  createFeishuXsMirror,
} from "../../../../src/web-hub/hub/feishu/xs-mirror.js";
import type { FeishuXsMirrorEvent } from "../../../../src/web-hub/hub/feishu/xs-mirror.js";

const SID = "sess-recv-0001";

function bind(key: string, over: Partial<FeishuBinding> = {}): FeishuBinding {
  return { key, rev: 1, sessionId: SID, chatId: `oc_${key}`, chatType: "p2p", updatedAt: 1, ...over };
}
function ev(n: number | string, over: Partial<FeishuXsMirrorEvent> = {}): FeishuXsMirrorEvent {
  return {
    sessionId: SID,
    agentKey: "agent-1",
    xid: `x${n}`,
    kind: "message",
    from: { ref: "019abc", name: "peer" },
    text: `hello ${n}`,
    ...over,
  };
}
const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

interface Pending {
  input: EnqueueNoticeInput;
  resolve(r: EnqueueResult): void;
  reject(e: unknown): void;
}
function rig(
  opts: {
    bindings?: FeishuBinding[];
    manual?: boolean;
    runOk?: () => boolean;
    usage?: () => { bytes: number; budget: number; reserve: number };
    queuedMirror?: () => number;
    outboxSize?: () => number;
    workSize?: () => number;
  } = {},
) {
  let now = 1_000_000;
  const bindings = new Map((opts.bindings ?? [bind("p2p:a")]).map((b) => [b.key, b]));
  const pending: Pending[] = [];
  const enqueued: EnqueueNoticeInput[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let runCalls = 0;
  const logs: { event: string; reason: string; code?: string }[] = [];
  const counts: Record<string, number> = {};
  const m = createFeishuXsMirror({
    state: {
      bindings: { list: () => [...bindings.values()], get: (k) => bindings.get(k) },
      outbox: {
        list: () => Array.from({ length: opts.queuedMirror?.() ?? 0 }, () => ({ kind: "notice", requestId: "xsm:x" })),
        get size() {
          return opts.outboxSize?.() ?? 0;
        },
      },
      usage: opts.usage ?? (() => ({ bytes: 1000, budget: 4 * 1024 * 1024, reserve: 0 })),
    },
    now: () => now,
    label: () => "api · a1b2c3",
    link: () => "http://h/#/agent/x",
    target: (b) => ({ scope: "p2p", via: "send", receiveIdType: "chat_id", receiveId: b.chatId }),
    enqueue: (input) => {
      enqueued.push(input);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      if (!opts.manual) {
        inflight--;
        return Promise.resolve({ ok: true, sendIds: ["s"], durable: true, duplicate: false });
      }
      return new Promise<EnqueueResult>((resolve, reject) => {
        pending.push({
          input,
          resolve: (r) => {
            inflight--;
            resolve(r);
          },
          reject: (e) => {
            inflight--;
            reject(e);
          },
        });
      });
    },
    run: (task) => {
      runCalls++;
      if (opts.runOk && !opts.runOk()) return false;
      void Promise.resolve().then(task);
      return true;
    },
    workSize: () => opts.workSize?.() ?? 0,
    log: (e) => logs.push(e),
    count: (r) => {
      counts[r] = (counts[r] ?? 0) + 1;
    },
  });
  return {
    m,
    bindings,
    pending,
    enqueued,
    logs,
    counts,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
    get maxInflight() {
      return maxInflight;
    },
    get runCalls() {
      return runCalls;
    },
  };
}
const okRes: EnqueueResult = { ok: true, sendIds: ["s"], durable: true, duplicate: false };
const mdOf = (i: EnqueueNoticeInput): string =>
  (JSON.parse(i.message.content) as { body: { elements: { content: string }[] } }).body.elements[0]!.content;

describe("filters", () => {
  it("only p2p, `p2p:`-keyed, online bindings of the receiving session", async () => {
    const r = rig({
      bindings: [
        bind("p2p:a"),
        bind("grp:b", { chatType: "group" }),
        bind("p2p:topic", { chatType: "group", threadId: "t" }),
        bind("p2p:off", { offline: "session-changed" }),
        bind("p2p:other", { sessionId: "someone-else" }),
        bind("xx:notp2pkey"),
      ],
    });
    r.m.deliver(ev(1));
    await tick();
    expect(r.enqueued).toHaveLength(1);
    expect(r.enqueued[0]!.target).toMatchObject({ receiveId: "oc_p2p:a" });
  });
  it("no matching binding is silent; invalid events are counted not thrown", async () => {
    const r = rig({ bindings: [] });
    r.m.deliver(ev(1));
    r.m.deliver({ ...ev(2), xid: "" });
    r.m.deliver(null as unknown as FeishuXsMirrorEvent);
    await tick();
    expect(r.enqueued).toHaveLength(0);
    expect(r.counts["xs-mirror-invalid"]).toBe(2);
    expect(r.runCalls).toBe(0);
  });
  it("dedups by (session, xid) and shapes key/tag as xsm:<hash>", async () => {
    const r = rig();
    r.m.deliver(ev(1));
    r.m.deliver(ev(1));
    await tick();
    expect(r.enqueued).toHaveLength(1);
    expect(r.counts["xs-mirror-dup"]).toBe(1);
    const i = r.enqueued[0]!;
    expect(i.tag).toMatch(/^xsm:[A-Za-z0-9_-]{40}$/);
    expect(i.key).toBe(i.tag);
    expect(i.laneKey).toBe("oc_p2p:a");
  });
});

describe("budgets", () => {
  it("per binding 6/min then 60/h", async () => {
    const r = rig();
    for (let i = 0; i < 8; i++) r.m.deliver(ev(i));
    await tick();
    expect(r.enqueued).toHaveLength(XSM_PER_BINDING_PER_MIN);
    expect(r.counts["xs-mirror-rate"]).toBe(2);
    // 6 per minute for 11 more minutes reaches the 60/h ceiling
    let sent = XSM_PER_BINDING_PER_MIN;
    for (let min = 1; min <= 12; min++) {
      r.advance(61_000);
      for (let i = 0; i < 6; i++) r.m.deliver(ev(`m${min}-${i}`));
      await tick();
      sent = r.enqueued.length;
    }
    expect(sent).toBeLessThanOrEqual(XSM_PER_BINDING_PER_HOUR);
    expect(sent).toBe(XSM_PER_BINDING_PER_HOUR);
  });
  it("global limit counts CARDS after fan-out (10 bindings × 6 events ⇒ exactly 30 accepted in a minute)", async () => {
    const bs = Array.from({ length: 10 }, (_, i) => bind(`p2p:b${i}`));
    const r = rig({ bindings: bs });
    for (let e = 0; e < 6; e++) {
      r.m.deliver(ev(e));
      await tick();
    }
    expect(r.enqueued).toHaveLength(XSM_GLOBAL_CARDS_PER_MIN);
    expect(r.counts["xs-mirror-rate"]).toBe(60 - XSM_GLOBAL_CARDS_PER_MIN);
  });
  it("fairness: scarce admission (queue 16 of 40 bindings) rotates by least-recently-served; nobody starves", async () => {
    const bs = Array.from({ length: 40 }, (_, i) => bind(`p2p:f${String(i).padStart(2, "0")}`));
    const r = rig({ bindings: bs });
    const servedRound: Set<string>[] = [];
    for (let round = 0; round < 3; round++) {
      r.advance(61_000);
      r.enqueued.length = 0;
      r.m.deliver(ev(`r${round}`));
      await tick();
      expect(r.enqueued).toHaveLength(XSM_QUEUE_MAX);
      servedRound.push(new Set(r.enqueued.map((i) => String(i.laneKey))));
    }
    // rounds are disjoint until everyone has been served once: 16 + 16 + 8 (+8 repeats)
    expect(servedRound[1]!.size).toBe(16);
    for (const k of servedRound[1]!) expect(servedRound[0]!.has(k)).toBe(false);
    const all = new Set([...servedRound[0]!, ...servedRound[1]!, ...servedRound[2]!]);
    expect(all.size).toBe(40);
  });
  it("a skipped binding's next card shows the right tail count", async () => {
    const bs = Array.from({ length: XSM_QUEUE_MAX + 1 }, (_, i) => bind(`p2p:t${String(i).padStart(2, "0")}`));
    const r = rig({ bindings: bs });
    r.m.deliver(ev("a"));
    await tick();
    expect(r.enqueued).toHaveLength(XSM_QUEUE_MAX);
    expect(r.enqueued.some((i) => i.laneKey === "oc_p2p:t16")).toBe(false); // sorted last by key ⇒ skipped (cap)
    r.advance(61_000);
    r.enqueued.length = 0;
    r.m.deliver(ev("b"));
    await tick();
    const mine = r.enqueued.find((i) => i.laneKey === "oc_p2p:t16")!;
    expect(mine).toBeDefined(); // least recently served now goes first
    expect(mdOf(mine)).toContain("此前另有 1 条");
    for (const i of r.enqueued.filter((x) => x !== mine)) expect(mdOf(i)).not.toContain("此前另有");
  });
});

describe("single worker", () => {
  it("at most one enqueue is ever in flight; run() starts one drain at a time", async () => {
    const r = rig({ bindings: Array.from({ length: 4 }, (_, i) => bind(`p2p:w${i}`)), manual: true });
    r.m.deliver(ev(1));
    r.m.deliver(ev(2));
    await tick();
    expect(r.pending).toHaveLength(1);
    expect(r.runCalls).toBe(1);
    for (let i = 0; i < 8; i++) {
      r.pending.shift()!.resolve(okRes);
      await tick();
      expect(r.maxInflight).toBe(1);
    }
    expect(r.enqueued).toHaveLength(8);
    expect(r.maxInflight).toBe(1);
  });
  it("run() === false ⇒ whole queue becomes omitted (work), enqueue untouched, can restart later", async () => {
    let ok = false;
    const r = rig({ runOk: () => ok });
    r.m.deliver(ev(1));
    await tick();
    expect(r.enqueued).toHaveLength(0);
    expect(r.counts["xs-mirror-work"]).toBe(1);
    expect(r.m.stats()).toEqual({ queued: 0, pumping: false });
    ok = true;
    r.m.deliver(ev(2));
    await tick();
    expect(r.enqueued).toHaveLength(1);
    // the earlier drop is reported on that next card
    expect(mdOf(r.enqueued[0]!)).toContain("此前另有 1 条");
  });
  it("work headroom: workSize ≥ 192 ⇒ worker does not start until pump() with room", async () => {
    let w = 200;
    const r = rig({ workSize: () => w });
    r.m.deliver(ev(1));
    await tick();
    expect(r.runCalls).toBe(0);
    expect(r.m.stats().queued).toBe(1);
    w = 0;
    r.m.pump();
    await tick();
    expect(r.enqueued).toHaveLength(1);
  });
  it("queue bound: a full queue omits with cap", async () => {
    const bs = Array.from({ length: XSM_QUEUE_MAX + 4 }, (_, i) => bind(`p2p:q${i}`));
    const r = rig({ bindings: bs, manual: true });
    r.m.deliver(ev(1));
    // synchronous: the worker has not run yet, so the queue holds the first 16
    expect(r.m.stats().queued).toBe(XSM_QUEUE_MAX);
    expect(r.counts["xs-mirror-cap"]).toBe(4);
  });
});

describe("omitted accounting (monotone dropped / reported watermark)", () => {
  it("success reports exactly the shown count; failure/throw leave it for the next card", async () => {
    const r = rig({ manual: true });
    const total = () => r.counts;
    // 6 accepted then 3 rate-dropped
    for (let i = 0; i < 9; i++) r.m.deliver(ev(i));
    expect(total()["xs-mirror-rate"]).toBe(3);
    // 1st card: shown=3 and fails ⇒ not reported
    await tick();
    expect(mdOf(r.pending[0]!.input)).toContain("此前另有 3 条");
    r.pending.shift()!.resolve({ ok: false, refused: "cap" });
    await tick();
    expect(total()["xs-mirror-refused"]).toBe(1);
    // 2nd card now shows 4 (3 + the refused one); throws ⇒ still unreported
    expect(mdOf(r.pending[0]!.input)).toContain("此前另有 4 条");
    r.pending.shift()!.reject(new Error("boom"));
    await tick();
    expect(mdOf(r.pending[0]!.input)).toContain("此前另有 5 条");
    // 3rd succeeds ⇒ reported := 5; the 4th card has no tail
    r.pending.shift()!.resolve(okRes);
    await tick();
    expect(mdOf(r.pending[0]!.input)).not.toContain("此前另有");
    r.pending.shift()!.resolve(okRes);
    await tick();
  });
  it("a drop that happens while a card is in flight is not swallowed by that card's confirmation", async () => {
    const r = rig({ manual: true });
    for (let i = 0; i < 7; i++) r.m.deliver(ev(i)); // 6 queued, 1 rate-drop
    await tick();
    expect(mdOf(r.pending[0]!.input)).toContain("此前另有 1 条");
    // another drop lands during the await (7th..8th over the minute window)
    r.m.deliver(ev("late1"));
    r.pending.shift()!.resolve(okRes); // reports 1 of 2
    await tick();
    expect(mdOf(r.pending[0]!.input)).toContain("此前另有 1 条");
  });
  it("accepted-nondurable still advances the watermark and is audited distinctly", async () => {
    const r = rig({ manual: true });
    for (let i = 0; i < 7; i++) r.m.deliver(ev(i));
    await tick();
    r.pending.shift()!.resolve({ ok: true, sendIds: ["s"], durable: false, duplicate: false });
    await tick();
    expect(r.logs.some((l) => l.reason === "accepted-nondurable")).toBe(true);
    expect(mdOf(r.pending[0]!.input)).not.toContain("此前另有");
  });
});

describe("worker gates", () => {
  it("stale cards (> 10 min in queue) are omitted", async () => {
    const r = rig({ manual: true });
    r.m.deliver(ev(1));
    r.m.deliver(ev(2));
    await tick();
    r.advance(XSM_MAX_AGE_MS + 1);
    r.pending.shift()!.resolve(okRes);
    await tick();
    expect(r.counts["xs-mirror-stale"]).toBe(1);
    expect(r.enqueued).toHaveLength(1);
  });
  it("binding removed or rebound while queued ⇒ unbound (not counted as omitted)", async () => {
    const r = rig({ manual: true });
    r.m.deliver(ev(1));
    r.m.deliver(ev(2));
    r.m.deliver(ev(3));
    await tick();
    r.bindings.delete("p2p:a");
    r.pending.shift()!.resolve(okRes);
    await tick();
    expect(r.counts["xs-mirror-unbound"]).toBe(2);
    expect(r.counts["xs-mirror-cap"]).toBeUndefined();
    expect(r.enqueued).toHaveLength(1);
  });
  it("slot gates: queued mirrors ≥16, outbox size ≥320, bytes headroom ⇒ cap / cap / bytes", async () => {
    const a = rig({ queuedMirror: () => 16 });
    a.m.deliver(ev(1));
    await tick();
    expect(a.counts["xs-mirror-cap"]).toBe(1);
    const b = rig({ outboxSize: () => 320 });
    b.m.deliver(ev(1));
    await tick();
    expect(b.counts["xs-mirror-cap"]).toBe(1);
    const c = rig({ usage: () => ({ bytes: 4 * 1024 * 1024 - 262_144 - 100, budget: 4 * 1024 * 1024, reserve: 0 }) });
    c.m.deliver(ev(1));
    await tick();
    expect(c.counts["xs-mirror-bytes"]).toBe(1);
    expect(c.enqueued).toHaveLength(0);
    const d = rig({ outboxSize: () => 319, queuedMirror: () => 15 });
    d.m.deliver(ev(1));
    await tick();
    expect(d.enqueued).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("dispose while a card is in flight: nothing is written afterwards; queue leftovers count stopped", async () => {
    const r = rig({ manual: true });
    for (let i = 0; i < 4; i++) r.m.deliver(ev(i));
    await tick();
    r.m.dispose();
    expect(r.counts["xs-mirror-stopped"]).toBe(3);
    const before = JSON.stringify(r.counts);
    r.pending.shift()!.resolve({ ok: false, refused: "cap" });
    await tick();
    expect(JSON.stringify(r.counts)).toBe(before); // no omit after dispose
    r.m.deliver(ev(99));
    r.m.pump();
    await tick();
    expect(r.enqueued).toHaveLength(1);
    expect(r.counts["xs-mirror-dup"]).toBeUndefined();
  });
  it("dispose + a throwing enqueue promise writes no omitted state (m1)", async () => {
    const r = rig({ manual: true });
    r.m.deliver(ev(1));
    await tick();
    r.m.dispose();
    r.pending.shift()!.reject(new Error("x"));
    await tick();
    expect(r.counts["xs-mirror-refused"]).toBeUndefined();
  });
  it("audit lines never carry content, names, ids or tags", async () => {
    const r = rig({ manual: true });
    for (let i = 0; i < 8; i++)
      r.m.deliver(ev(i, { text: "SECRETBODY", from: { ref: "REFXYZ", name: "NAMEQQ", alias: "ALIASZZ" } }));
    await tick();
    r.pending.shift()!.resolve(okRes);
    await tick();
    r.pending.shift()!.resolve({ ok: false, refused: "cap" });
    await tick();
    const dump = JSON.stringify(r.logs);
    for (const s of ["SECRETBODY", "REFXYZ", "NAMEQQ", "ALIASZZ", SID, "oc_", "xsm:", "agent-1", "x1"])
      expect(dump).not.toContain(s);
    expect(r.logs.length).toBeGreaterThan(0);
  });
});
