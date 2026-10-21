import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, joinedPair, list, send, until } from "./helpers/fabric-xs-harness.js";

let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 20_000);

describe("XW real hub child × two activate-built stacks × real sockets", () => {
  it("join/list, deliver-only evidence, N1 then applied wake, reply, busy queued, goal downgrade and mutation fences", async () => {
    h = new XsHarness();
    const { a, b, aid, bid } = await joinedPair(h);
    expect((await list(a)).rows).toEqual([expect.objectContaining({ ref: bid.slice(0, 12), receive: "wake" })]);
    expect(await a.rpc("cmd", { name: "agent", args: "status" })).toContain("xs joined · recv wake · cap unknown");
    expect(await send(a, bid, "deliver-only")).toMatchObject({ effect: "applied" });
    // Different direction avoids pairMinInterval; a fresh host is still unverified (N1).
    expect(await send(b, aid, "N1", true)).toMatchObject({ effect: "applied", wakeDowngraded: "host_unverified" });
    await b.rpc("prime");
    // New hub quota window without sleeps (also exercises member replay).
    const reset = await a.rpc("replace");
    await a.rpc("cmd", { args: "join" });
    await until(
      () => list(b),
      (l) => l.rows?.some((r: any) => reset.sessionId.startsWith(r.ref)),
      "new identity",
    );
    expect(await send(a, bid, "wake B", true)).toMatchObject({ effect: "applied", woke: true });
    let state = await b.rpc("inspect");
    expect(state.messages.at(-1)).toMatchObject({ triggerTurn: true, details: { xsWake: true } });
    expect(state.capability).toBe("verified");
    expect(await b.rpc("cmd", { name: "agent", args: "status" })).toContain("cap verified");
    expect(state.owned).toBe(true);
    await b.rpc("settle");
    expect((await b.rpc("inspect")).ledger).toHaveLength(0);
    expect(await send(b, reset.sessionId, "reply via from.ref")).toMatchObject({ effect: "applied" });
    // Change sender identity between cases rather than sleeping across pair throttles.
    async function freshSender() {
      await a.rpc("replace");
      await a.rpc("cmd", { args: "join" });
      await until(
        () => list(a),
        (l) => l.status === "ok",
        "sender slot",
      );
    }
    await freshSender();
    await b.rpc("busy", { busy: true });
    expect(await send(a, bid, "queued while streaming", true)).toMatchObject({
      effect: "unknown",
      reason: "queued",
      wakeDowngraded: "busy",
    });
    expect((await b.rpc("inspect")).queued).toBe(1);
    await b.rpc("settle");
    await b.rpc("cmd", { name: "goal", args: "do work --until-cmd true" });
    await freshSender();
    expect(await send(a, bid, "goal deliver without wake", true)).toMatchObject({
      effect: "applied",
      wakeDowngraded: "goal",
    });
    await b.rpc("cmd", { name: "goal", args: "clear" });
    await b.rpc("event", { type: "session_before_compact" });
    await freshSender();
    const before = (await b.rpc("inspect")).messages.length;
    expect(await send(a, bid, "reject during compaction", true)).toMatchObject({
      effect: "none",
      reason: "fenced:compaction",
    });
    expect((await b.rpc("inspect")).messages).toHaveLength(before);
    await b.rpc("event", { type: "session_compact_failed", extra: { aborted: true, reason: "manual" } });
    await freshSender();
    expect(await send(a, bid, "compaction ended")).toMatchObject({ effect: "applied" });
    await b.rpc("event", { type: "session_before_switch", extra: { reason: "new" } });
    await b.rpc("input"); // M1: input does not cancel a pending mutation
    await freshSender();
    expect(await send(a, bid, "still switching")).toMatchObject({ effect: "none", reason: "fenced:switch" });
    await b.rpc("cmd", { args: "fence reset" });
    expect(await a.rpc("stop")).toEqual({ listeners: 0, ledger: 0 });
    expect(await b.rpc("stop")).toEqual({ listeners: 0, ledger: 0 });
  }, 35_000);

  it("not joined is invisible/undeliverable; leave rejects an already stamped in-flight deliver; fork does not inherit", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    const [a, b] = await Promise.all([h.boot("agent", "alpha"), h.boot("agent", "beta")]);
    const bid = (await b.rpc("inspect")).sessionId;
    await a.rpc("cmd", { args: "join" });
    expect((await list(a)).rows).toEqual([]);
    expect(await send(a, bid, "not joined")).toMatchObject({ effect: "none", status: "no_target" });
    await b.rpc("cmd", { args: "join" });
    await until(
      () => list(a),
      (l) => l.rows?.length === 1,
      "B joined",
    );
    await hub.rpc("hold", { mode: "before" });
    const delivered = hub.event("deliver");
    const pending = send(a, bid, "old epoch delivery");
    await delivered;
    await b.rpc("cmd", { args: "leave" });
    await hub.rpc("release");
    expect(await pending).toMatchObject({ effect: "none", reason: "rejected" });
    expect((await b.rpc("inspect")).messages).toEqual([]);
    await b.rpc("cmd", { args: "join" });
    const fork = await b.rpc("replace", { reason: "fork" });
    expect(fork.sessionId).not.toBe(bid);
    expect(await b.rpc("cmd")).toContain("not joined");
    await until(
      () => list(a),
      (l) => l.rows?.length === 0,
      "fork hidden",
    );
  }, 30_000);

  it("send resolve racing /new never emits send; reload reclaims Controller and dedup replays the first verdict", async () => {
    h = new XsHarness();
    const { hub, a, b, bid } = await joinedPair(h);
    await a.rpc("holdResolve");
    const resolved = a.event("resolved");
    const pending = send(a, bid, "must not send after new");
    await resolved;
    await a.rpc("replace");
    await a.rpc("releaseResolve");
    expect(await pending).toMatchObject({ effect: "none", reason: "origin_changed" });
    expect((await hub.rpc("inspect")).deliveries).toEqual([]);
    await a.rpc("cmd", { args: "join" });
    await b.rpc("prime");
    await until(
      () => list(a),
      (l) => l.status === "ok",
      "new origin member",
    );
    expect(await send(a, bid, "wake survives reload", true)).toMatchObject({ effect: "applied", woke: true });
    const initial = await b.rpc("inspect");
    expect(initial.owned).toBe(true);
    const reload = await b.rpc("reload");
    expect(reload.ledger).toBe(1);
    const recovered = await b.rpc("inspect");
    expect(recovered.owned).toBe(true);
    expect(recovered.ledger[0].deadlineAt).toBe(initial.ledger[0].deadlineAt);
    await until(
      () => list(a),
      (l) => l.rows?.length === 1,
      "reload republish",
    );
    expect(await hub.rpc("replay")).toMatchObject({ t: "xs_ack", effect: "applied", woke: true });
    expect((await b.rpc("inspect")).messages).toHaveLength(1);
    await b.rpc("settle");
    expect((await b.rpc("inspect")).ledger).toEqual([]);
  }, 30_000);

  it("hub death after receiver ack returns unknown; restart reconstructs members without resending; reload dedup survives", async () => {
    h = new XsHarness();
    const { hub, a, b, bid } = await joinedPair(h);
    await hub.rpc("hold", { mode: "after" });
    const acked = hub.event("acked");
    const pending = send(a, bid, "accepted before disconnect");
    await acked;
    expect((await b.rpc("inspect")).messages).toHaveLength(1);
    await hub.kill();
    expect(await pending).toMatchObject({ effect: "unknown", reason: "link_lost" });
    await h.boot("hub");
    await until(
      () => list(a),
      (l) => l.rows?.length === 1,
      "members rebuilt after hub death",
    );
    await b.rpc("reload");
    await until(
      () => list(a),
      (l) => l.rows?.length === 1,
      "reload attach",
    );
    expect((await b.rpc("inspect")).messages).toHaveLength(1);
    // A fresh request is a new xid; the old text is never implicitly retransmitted.
    await a.rpc("replace");
    await a.rpc("cmd", { args: "join" });
    await until(
      () => list(a),
      (l) => l.status === "ok",
      "new sender attached",
    );
    expect(await send(a, bid, "new explicit message")).toMatchObject({ effect: "applied" });
    expect((await b.rpc("inspect")).messages.map((m: any) => m.content.includes("accepted before disconnect"))).toEqual(
      [true, false],
    );
  }, 35_000);
});

it("old-cap peers stay invisible and an old-cap hub returns off without sending", async () => {
  h = new XsHarness();
  const hub = await h.boot("hub");
  const a = await h.boot("agent", "alpha");
  await a.rpc("cmd", { args: "join" });
  const oldPeer = await h.boot("agent", "old-peer", undefined, false);
  const bid = (await oldPeer.rpc("inspect")).sessionId;
  expect((await list(a)).rows).toEqual([]);
  expect(await send(a, bid, "old-cap recipient")).toMatchObject({ effect: "none", status: "no_target" });
  expect((await oldPeer.rpc("inspect")).messages).toEqual([]);
  await hub.kill();
  await h.boot("hub", "old-hub", undefined, false);
  await until(
    () => a.rpc("inspect"),
    (s) => s.conn?.state === "live",
    "old hub reconnect",
  );
  expect(await send(a, bid, "no xs hub", true)).toMatchObject({ effect: "none", status: "off" });
}, 25_000);

it("autoJoin publishes the joined member AFTER webhub session_start's session slot; fork never auto-joins", async () => {
  h = new XsHarness();
  const hub = await h.boot("hub");
  const a = await h.boot("agent", "auto", undefined, true, true);
  const b = await h.boot("agent", "viewer");
  await b.rpc("cmd", { args: "join" });
  const aid = (await a.rpc("inspect")).sessionId;
  await until(
    () => list(b),
    (l) => l.rows?.some((r: any) => aid.startsWith(r.ref)),
    "auto joined",
  );
  const frames = (await hub.rpc("inspect")).slotFrames.filter((f: any) => f.sessionId === aid);
  const memberIndex = frames.findIndex((f: any) => f.t === "xs_member" && f.joined);
  expect(memberIndex).toBeGreaterThan(0);
  expect(frames.slice(0, memberIndex).some((f: any) => f.t === "session")).toBe(true);
  const fork = await a.rpc("replace", { reason: "fork" });
  expect(fork.sessionId).not.toBe(aid);
  expect(await a.rpc("cmd")).toContain("not joined");
  await until(
    () => list(b),
    (l) => l.rows?.length === 0,
    "fork hidden",
  );
}, 30_000);

it("web /new exec claim fences actual socket ingress before its command trampoline runs", async () => {
  h = new XsHarness();
  const { hub, a, b, bid } = await joinedPair(h);
  expect(await hub.rpc("webNew", { sessionId: bid })).toMatchObject({ ok: true });
  expect(await send(a, bid, "during actual web exec claim")).toMatchObject({
    effect: "none",
    reason: "fenced:web_exec",
  });
  expect((await b.rpc("inspect")).messages).toHaveLength(0);
}, 25_000);
