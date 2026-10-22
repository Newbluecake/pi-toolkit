import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, joinedPair, list, send, until, type Peer } from "./helpers/fabric-xs-harness.js";

/**
 * RXW: reply-plan §12.2 items 1–9 on real hub child × real activate-built stacks × real sockets.
 * Time is moved with the process fixture's `skew` op (Date.now offset; timers stay real) and
 * every notice flush is event driven (`settle` → agent_settled, fence close events, restore).
 */
let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 20_000);

const ask = (a: Peer, to: string, text: string, extra: Record<string, unknown> = {}, timeoutS = 600) =>
  a.rpc("tool", { name: "message_session", params: { to, text, expectReply: { timeoutS }, ...extra } });
const answer = (b: Peer, to: string, text: string, q: string) =>
  b.rpc("tool", { name: "message_session", params: { to, text, replyTo: q } });
const waitVisible = (viewer: Peer, id: string) =>
  until(
    () => list(viewer),
    (l) => l.rows?.some((r: any) => id.startsWith(r.ref)),
    "member visible",
  );
async function triple(): Promise<{ hub: Peer; a: Peer; b: Peer; c: Peer; aid: string; bid: string; cid: string }> {
  const hub = await h.boot("hub");
  const [a, b, c] = await Promise.all([h.boot("agent", "alpha"), h.boot("agent", "beta"), h.boot("agent", "gamma")]);
  await Promise.all([a, b, c].map((p) => p.rpc("cmd", { args: "join" })));
  const [aid, bid, cid] = (await Promise.all([a, b, c].map((p) => p.rpc("inspect")))).map((s: any) => s.sessionId);
  await waitVisible(a, bid!);
  await waitVisible(a, cid!);
  await waitVisible(b, aid!);
  return { hub, a, b, c, aid: aid!, bid: bid!, cid: cid! };
}

describe("RXW reply association (real hub × real stacks)", () => {
  it("#1 round trip: expectReply+wake ⇒ B header carries reply_to ⇒ B replyTo ⇒ A is woken", async () => {
    h = new XsHarness();
    const { a, b, aid, bid } = await joinedPair(h);
    await a.rpc("prime");
    await b.rpc("prime");
    const levelBefore = (await a.rpc("inspect")).level;
    const out = await ask(a, bid, "need an answer", { wake: true });
    expect(out).toMatchObject({ effect: "applied", reply: { state: "pending" } });
    expect(out.reply.requestId).toBeTruthy();
    const ticket = (await a.rpc("inspect")).replyTickets.find((t: any) => t.requestId === out.reply.requestId);
    const q: string = out.reply.requestId;
    const request = (await b.rpc("inspect")).messages.at(-1);
    expect(request.content).toContain(q);
    expect(request.content).toContain("reply_to");
    await b.rpc("settle");
    const back = await answer(b, aid, "the answer is 42", q);
    expect(back).toMatchObject({ effect: "applied", replyTo: { requestId: q, accepted: true } });
    const state = await a.rpc("inspect");
    expect(state.messages.at(-1)).toMatchObject({ triggerTurn: true, details: { xsWake: true, inReplyTo: q } });
    expect(state.messages.at(-1).content).toContain("the answer is 42");
    expect(state.replyTickets.find((t: any) => t.requestId === q)?.state).toBe("replied");
    // §12.2-1 / R3: the solicited wake returns A to requesterLevel — no +1 hop.
    expect(ticket?.requesterLevel).toBe(levelBefore);
    expect(state.level).toBe(levelBefore);
    expect(state.replyTickets.find((t: any) => t.requestId === q)?.requesterLevel).toBe(levelBefore);
  }, 35_000);

  it("#2 timeout, quiet path: two due tickets of one session merge into ONE notice and clear owed", async () => {
    h = new XsHarness();
    const { a, bid, cid } = await triple();
    const q1 = (await ask(a, bid, "one", {}, 60)).reply.requestId;
    const q2 = (await ask(a, cid, "two", {}, 60)).reply.requestId;
    await a.rpc("skew", { ms: 61_000 });
    await a.rpc("settle");
    const s = await a.rpc("inspect");
    expect(s.replyNotices).toHaveLength(1);
    expect(s.replyNotices[0]).toMatchObject({ triggerTurn: false, display: true });
    expect(s.replyNotices[0].details.requestIds.sort()).toEqual([q1, q2].sort());
    expect(s.replyTickets.every((t: any) => t.noticeOwed === undefined && t.state === "timed_out")).toBe(true);
    await a.rpc("settle");
    expect((await a.rpc("inspect")).replyNotices).toHaveLength(1); // never re-sent
  }, 35_000);

  it("#2 timeout, wake path: a primed requester is woken by its own timeout notice", async () => {
    h = new XsHarness();
    const { a, b, bid } = await joinedPair(h);
    await a.rpc("prime");
    await b.rpc("prime");
    const q = (await ask(a, bid, "will time out", { wake: true }, 60)).reply.requestId;
    await a.rpc("skew", { ms: 61_000 });
    await a.rpc("settle");
    const s = await a.rpc("inspect");
    expect(s.messages.at(-1)).toMatchObject({ triggerTurn: true, details: { xsWake: true } });
    expect(s.messages.at(-1).content).toContain(q);
    expect(s.replyNotices).toHaveLength(0);
  }, 35_000);

  it("#3a leave before due ⇒ nothing is written; at lateUntil the notice is dropped and counted", async () => {
    h = new XsHarness();
    const { a, bid } = await joinedPair(h);
    await ask(a, bid, "will leave", {}, 60);
    await a.rpc("cmd", { args: "leave" });
    await a.rpc("skew", { ms: 61_000 });
    await a.rpc("settle");
    let s = await a.rpc("inspect");
    expect(s.replyNotices).toHaveLength(0);
    expect(s.replyTickets[0].noticeOwed).toBe("timeout");
    await a.rpc("skew", { ms: 700_000 }); // past lateUntil (60s + 600s grace)
    await a.rpc("settle");
    s = await a.rpc("inspect");
    expect(s.replyNotices).toHaveLength(0);
    expect(s.replyTickets).toEqual([]);
    expect(s.dropped).toBe(1);
  }, 35_000);

  it("#3b compaction window at due time ⇒ no write; the fence-close event replays the owed notice", async () => {
    h = new XsHarness();
    const { a, bid } = await joinedPair(h);
    const q = (await ask(a, bid, "compaction", {}, 60)).reply.requestId;
    await a.rpc("event", { type: "session_before_compact" });
    await a.rpc("skew", { ms: 61_000 });
    await a.rpc("settle");
    expect((await a.rpc("inspect")).replyNotices).toHaveLength(0);
    await a.rpc("event", { type: "session_compact", extra: {} });
    const s = await a.rpc("inspect");
    expect(s.replyNotices).toHaveLength(1);
    expect(s.replyNotices[0].details.requestIds).toEqual([q]);
  }, 35_000);

  it("#3c slow session_before_switch ⇒ no write; a cancelled switch is closed by fence reset, then it flushes", async () => {
    h = new XsHarness();
    const { a, bid } = await joinedPair(h);
    const q = (await ask(a, bid, "switch", {}, 60)).reply.requestId;
    await a.rpc("event", { type: "session_before_switch", extra: { reason: "new" } });
    await a.rpc("skew", { ms: 61_000 });
    await a.rpc("settle");
    expect((await a.rpc("inspect")).replyNotices).toHaveLength(0);
    await a.rpc("cmd", { args: "fence reset" }); // human escape ⇒ onPolicyChange ⇒ flush
    const s = await a.rpc("inspect");
    expect(s.replyNotices[0].details.requestIds).toEqual([q]);
  }, 35_000);

  it("#3d switch away before due, due while away, switch back ⇒ owed notice appears on restore", async () => {
    h = new XsHarness();
    const { a, bid } = await joinedPair(h);
    const q = (await ask(a, bid, "away", {}, 60)).reply.requestId;
    const file = (await a.rpc("inspect")).sessionFile;
    await a.rpc("replace");
    await a.rpc("skew", { ms: 61_000 });
    expect((await a.rpc("inspect")).replyNotices).toHaveLength(0);
    await a.rpc("replace", { reason: "resume", file });
    const s = await a.rpc("inspect");
    expect(s.replyNotices.map((n: any) => n.details.requestIds).flat()).toEqual([q]);
  }, 35_000);

  it("#3e expiring entirely while away ⇒ one quiet summary on switch back", async () => {
    h = new XsHarness();
    const { a, bid } = await joinedPair(h);
    await ask(a, bid, "gone", {}, 60);
    const file = (await a.rpc("inspect")).sessionFile;
    await a.rpc("replace");
    await a.rpc("skew", { ms: 700_000 });
    await a.rpc("replace", { reason: "resume", file });
    const s = await a.rpc("inspect");
    expect(s.replyNotices).toHaveLength(1);
    expect(s.replyNotices[0].content).toContain("离开期间有 1 个");
    expect(s.dropped).toBe(0);
  }, 35_000);

  it("#4 receive=replies: unsolicited traffic is refused (hub early + injected bypass); a valid reply wakes", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    const a = await h.boot("agent", "alpha", undefined, true, false, { XW_RECEIVE: "replies" });
    const b = await h.boot("agent", "beta");
    await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
    const aid = (await a.rpc("inspect")).sessionId;
    const bid = (await b.rpc("inspect")).sessionId;
    await waitVisible(a, bid); // replies-mode members are deliberately absent from list (router.ts)
    await a.rpc("prime");
    await b.rpc("prime");
    expect(await send(b, aid, "unsolicited")).toMatchObject({ effect: "none" });
    expect((await a.rpc("inspect")).messages).toEqual([]);
    const out = await ask(a, bid, "question", { wake: true });
    const q = out.reply.requestId;
    // Bypass the hub: replay B's recorded delivery as a plain message "from B" straight into A.
    const epoch = (await a.rpc("inspect")).epoch;
    const injected = await hub.rpc("inject", {
      index: 0,
      xid: "inject-unsolicited",
      to: { sessionId: aid, epoch },
      patch: { from: { sessionId: bid, ref: bid.slice(0, 12), cwdLabel: "x", agentId: "x" }, reply: undefined },
    });
    expect(injected).toMatchObject({ effect: "none" });
    expect((await a.rpc("inspect")).messages).toEqual([]);
    await b.rpc("settle");
    expect(await answer(b, aid, "valid reply", q)).toMatchObject({ effect: "applied" });
    const s = await a.rpc("inspect");
    expect(s.messages.at(-1)).toMatchObject({ triggerTurn: true });
    expect(s.messages.at(-1).content).toContain("valid reply");
  }, 40_000);

  it("#5 late: inside the grace window a reply is delivered without waking; past it the reply is refused", async () => {
    h = new XsHarness();
    const { hub, a, aid, bid, cid } = await triple();
    await a.rpc("prime");
    const qb = (await ask(a, bid, "inside grace", {}, 600)).reply.requestId;
    const qc = (await ask(a, cid, "outside grace", {}, 60)).reply.requestId;
    // Only A's clock moves (B: due 600 + grace ⇒ late; C: lateUntil 660 ⇒ gone). Replies are injected
    // with a fresh frame expiry so the verdict comes from the credential, not from frame expiry.
    await a.rpc("skew", { ms: 700_000 });
    const epoch = (await a.rpc("inspect")).epoch;
    const reply = (xid: string, from: string, qid: string, text: string) =>
      hub.rpc("inject", {
        index: 0,
        xid,
        to: { sessionId: aid, epoch },
        patch: {
          from: { sessionId: from, ref: from.slice(0, 12), cwdLabel: "x", agentId: "x" },
          reply: undefined,
          inReplyTo: qid,
          text,
          wake: true, // requester's wakeOnReply decision — a LATE reply must still not wake
          expiresAt: Date.now() + 3_600_000,
        },
      }) as Promise<any>;
    const late = await reply("late-ok", bid, qb, "late but fine");
    expect(late).toMatchObject({ effect: "applied", reason: "reply_late" });
    let s = await a.rpc("inspect");
    const lateMsg = s.messages.find((m: any) => m.content.includes("late but fine"));
    expect(lateMsg).toMatchObject({ triggerTurn: false });
    expect(s.replyTickets.find((t: any) => t.requestId === qb)?.state).toBe("late_replied");
    const refused = await reply("too-late", cid, qc, "too late");
    expect(refused).toMatchObject({ effect: "none" });
    s = await a.rpc("inspect");
    expect(s.messages.some((m: any) => m.content.includes("too late"))).toBe(false);
  }, 40_000);

  it("#6 Blocker counterexample: duplicate reply after consumption (and after /tree) stays refused", async () => {
    h = new XsHarness();
    const { hub, a, b, aid, bid } = await joinedPair(h);
    const q = (await ask(a, bid, "once")).reply.requestId;
    expect(await answer(b, aid, "first", q)).toMatchObject({ effect: "applied" });
    const replyIndex = (await hub.rpc("inspect")).deliveries.findIndex((d: any) => d.frame.inReplyTo === q);
    const epoch = (await a.rpc("inspect")).epoch;
    const dup = (xid: string) =>
      hub.rpc("inject", {
        index: replyIndex,
        xid,
        to: { sessionId: aid, epoch },
        patch: { expiresAt: Date.now() + 3_600_000 }, // fresh: the refusal must come from the tombstone, not expiry
      }) as Promise<any>;
    await a.rpc("event", { type: "session_before_tree" });
    await a.rpc("event", { type: "session_tree" }); // back to before the consumption: no branch awareness
    const first = await dup("dup-1");
    expect(first).toMatchObject({ effect: "none" });
    expect(first.reason).not.toBe("expired");
    await a.rpc("skew", { ms: 300_000 }); // tombstone not yet deletable (lateUntil = 600+600s)
    expect(await dup("dup-2")).toMatchObject({ effect: "none" });
    const s = await a.rpc("inspect");
    expect(s.messages.filter((m: any) => m.content.includes("first"))).toHaveLength(1);
  }, 40_000);

  it("#7 /reload keeps the credential; a simulated pi restart refuses it with ONE invalidation notice", async () => {
    h = new XsHarness();
    const { a, b, aid, bid } = await joinedPair(h);
    const q = (await ask(a, bid, "survives reload")).reply.requestId;
    await a.rpc("reload");
    await waitVisible(b, aid);
    expect((await a.rpc("inspect")).replyTickets.find((t: any) => t.requestId === q)?.state).toBe("pending");
    expect(await answer(b, aid, "after reload", q)).toMatchObject({ effect: "applied" });
    // restart: new process ledger (Symbol cleared) + a fresh stack build on the same session file
    const { c, cid } = await (async () => {
      const c = await h.boot("agent", "gamma");
      await c.rpc("cmd", { args: "join" });
      return { c, cid: (await c.rpc("inspect")).sessionId as string };
    })();
    await waitVisible(a, cid);
    const q2 = (await ask(a, cid, "dies with the process")).reply.requestId;
    await a.rpc("clearReplyLedger");
    await a.rpc("reload");
    await waitVisible(c, aid);
    let s = await a.rpc("inspect");
    expect(s.replyNotices).toHaveLength(1);
    expect(s.replyNotices[0].content).toContain("reply-invalidated");
    expect(s.replyNotices[0].content).toContain(q2);
    expect(s.replyEntries.some((e: any) => e.op === "settle" && e.requestId === q2 && e.state === "invalidated")).toBe(
      true,
    );
    expect(await answer(c, aid, "stale credential", q2)).toMatchObject({ effect: "none" });
    expect((await a.rpc("inspect")).messages.some((m: any) => m.content.includes("stale credential"))).toBe(false);
    await a.rpc("clearReplyLedger");
    await a.rpc("reload"); // second restart: settle entry silences it
    s = await a.rpc("inspect");
    expect(s.replyNotices).toHaveLength(1);
  }, 50_000);

  it("#8 address pinning: a name rebound between resolve and send never reaches the new holder", async () => {
    h = new XsHarness();
    const { a, b, bid } = await joinedPair(h);
    await a.rpc("holdResolve");
    const resolved = a.event("resolved");
    const pending = ask(a, "beta", "who gets this");
    await resolved;
    await b.rpc("cmd", { args: "leave" });
    const c = await h.boot("agent", "beta");
    await c.rpc("cmd", { args: "join" });
    await a.rpc("releaseResolve");
    const out = await pending;
    expect(out.effect).toBe("none");
    expect((await c.rpc("inspect")).messages).toEqual([]);
    expect((await b.rpc("inspect")).messages).toEqual([]);
    void bid;
  }, 40_000);

  it("#9a old hub without the reply cap: expectReply is refused without a frame; receive=replies degrades to off", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, { XW_HUB_REPLY_OFF: "1" });
    const a = await h.boot("agent", "alpha", undefined, true, false, { XW_RECEIVE: "replies" });
    const b = await h.boot("agent", "beta");
    await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
    const aid = (await a.rpc("inspect")).sessionId;
    const bid = (await b.rpc("inspect")).sessionId;
    // receive:"replies" was downgraded to off on the wire (no cap on this hub): not listed, not reachable.
    expect((await list(b)).rows).toEqual([]);
    expect(await send(b, aid, "plain")).toMatchObject({ effect: "none" });
    await waitVisible(a, bid);
    const out = await ask(a, bid, "needs the cap");
    expect(out).toMatchObject({ effect: "none", status: "reply_unsupported" });
    expect((await hub.rpc("inspect")).deliveries).toEqual([]);
    expect((await a.rpc("inspect")).replyTickets).toEqual([]);
  }, 35_000);

  it("#9b old recipient (reply disabled) is refused without delivery; hub restart mid-reply ⇒ unknown ⇒ resend delivers at most once", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    const a = await h.boot("agent", "alpha");
    const old = await h.boot("agent", "old", undefined, true, false, { XW_REPLY_OFF: "1" });
    const b = await h.boot("agent", "beta");
    await Promise.all([a, old, b].map((p) => p.rpc("cmd", { args: "join" })));
    const [aid, oid, bid] = (await Promise.all([a, old, b].map((p) => p.rpc("inspect")))).map((s: any) => s.sessionId);
    await waitVisible(a, oid);
    await waitVisible(a, bid);
    await waitVisible(b, aid);
    expect(await ask(a, oid, "to the old one")).toMatchObject({ effect: "none" });
    expect((await old.rpc("inspect")).messages).toEqual([]);
    const q = (await ask(a, bid, "real request")).reply.requestId;
    await hub.rpc("hold", { mode: "after" });
    const acked = hub.event("acked");
    const pending = answer(b, aid, "reply across hub death", q);
    await acked;
    await hub.kill();
    expect(await pending).toMatchObject({ effect: "unknown" });
    await h.boot("hub");
    await waitVisible(b, aid);
    await waitVisible(a, bid);
    const again = await answer(b, aid, "reply across hub death", q);
    expect(again.effect).toBe("none"); // credential already consumed on A: not delivered twice
    const s = await a.rpc("inspect");
    expect(s.messages.filter((m: any) => m.content.includes("reply across hub death"))).toHaveLength(1);
  }, 50_000);
});
