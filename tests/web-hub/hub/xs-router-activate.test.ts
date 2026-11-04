import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import type { XsActivateFrame, XsActivateAckFrame } from "../../../src/web-hub/protocol/xs-activation.js";
import { rig, type Rig } from "./xs-fixtures.js";

/**
 * fabric-xs-activation plan §3 P3 (arch §4.4–§4.6): the HUB side of `xs_req{op:"activate"}` —
 * relation/key/target pin, idempotency (started/replied no-op, pending/consumed/unknown dup),
 * quota (a NEW control cost: pair 2/h ⇒ refused pair_wake_rate + authoritative retryAfterAt, no
 * relay, no wake charge), ack settlement (none refunds ONLY this attempt's wake reservation,
 * unknown never refunds), the 5s relay deadline, late ack, cap gates. Real router + registry.
 */

const B_ID = "sess-BBBBBBBBBBBB-long";
const CAPS = ["ev.v1", "xs.v1", "xs.reply.v1", "xs.state.v1", "xs.activate.v1"];
const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
const req = (over: Partial<XsReqFrame> & Pick<XsReqFrame, "op">, sessionId = "sess-A", epoch = 1): XsReqFrame => ({
  t: "xs_req",
  rid: `q${++seq}`,
  origin: { sessionId, epoch },
  ...over,
});
const call = (r: Rig, key: string, frame: XsReqFrame): XsResFrame[] => {
  const out: XsResFrame[] = [];
  r.relay.router.handle(key, frame, (res) => out.push(res));
  return out;
};
const sentOf = <T extends { t: string }>(conn: { sent: unknown[] }, t: string): T[] =>
  conn.sent.filter((x) => (x as { t?: string }).t === t) as T[];

function pair(opts: { targetCaps?: string[]; sourceCaps?: string[] } = {}) {
  const r = rig(600, undefined, true);
  r.clock.t = Date.now();
  const a = r.agent({
    pid: 1,
    sessionId: "sess-A",
    name: "alpha",
    caps: opts.sourceCaps ?? CAPS,
    limits: { pairMinIntervalMs: 0, wakesOutPerHour: 20 },
  });
  const b = r.agent({ pid: 2, sessionId: B_ID, name: "beta", caps: opts.targetCaps ?? CAPS });
  return { r, a, b };
}

/** Send one body A→B, ack it applied, and push the receiver's `delivered` snapshot. */
async function sendDelivered(
  r: Rig,
  a: { key: string },
  b: { key: string; conn: { sent: unknown[] } },
  opts: { wake?: boolean; woke?: boolean; phase?: "delivered" | "queued" | undefined; longTicket?: boolean } = {},
) {
  const res = call(
    r,
    a.key,
    req({
      op: "send",
      to: B_ID,
      text: "secret-body",
      ...(opts.wake === true ? { wake: true } : {}),
      // an expectReply ticket widens the tracking window (arch §4.5: up to the reply ceiling)
      ...(opts.longTicket === true
        ? { expect: { requestId: `q${String(++seq).padStart(18, "0")}`, timeoutMs: 86_400_000 } }
        : {}),
    }),
  );
  const deliver = sentOf<{ rid: string; xid: string }>(b.conn, "xs_deliver").at(-1)!;
  r.registry.onFrame(b.key, {
    t: "xs_ack",
    rid: deliver.rid,
    xid: deliver.xid,
    effect: "applied",
    woke: opts.woke === true,
  });
  await vi.advanceTimersByTimeAsync(0);
  const phase = "phase" in opts ? opts.phase : "delivered";
  r.relay.router.onAgentFrame(b.key, {
    t: "xs_state",
    messageId: deliver.xid,
    revision: 1,
    deliveryEffect: "applied",
    ...(phase !== undefined ? { phase } : {}),
    observation: "live",
    wake: { requested: opts.wake === true, decision: opts.woke === true ? "dispatch_accepted" : "deliver_only" },
  });
  const states = sentOf<{ messageId: string; activationKey?: string }>(a.conn, "xs_state");
  const key = states.find((s) => s.messageId === deliver.xid)!.activationKey!;
  void res;
  return { messageId: deliver.xid, key };
}

const activate = (r: Rig, a: { key: string }, m: { messageId: string; key: string }, extra: Partial<XsReqFrame> = {}) =>
  call(r, a.key, req({ op: "activate", to: B_ID, messageId: m.messageId, activationKey: m.key, level: 0, ...extra }));
const relays = (b: { conn: { sent: unknown[] } }) => sentOf<XsActivateFrame>(b.conn, "xs_activate");
const ackOf = (frame: XsActivateFrame, over: Partial<XsActivateAckFrame> = {}): XsActivateAckFrame => ({
  t: "xs_activate_ack",
  rid: frame.rid,
  messageId: frame.messageId,
  activationKey: frame.activationKey,
  status: "accepted",
  effect: "applied",
  retryable: false,
  ...over,
});

describe("hub xs activate (fabric-xs-activation P3)", () => {
  it("relays ONE text-free xs_activate, settles accepted, and a repeat is a dup no-op (no relay, no charge)", async () => {
    const { r, a, b } = pair();
    const m = await sendDelivered(r, a, b);
    const out = activate(r, a, m);
    expect(out).toEqual([]); // answered only after the target's ack
    const frames = relays(b);
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f).toMatchObject({
      to: { sessionId: B_ID },
      from: { sessionId: "sess-A" },
      messageId: m.messageId,
      activationKey: m.key,
      level: 0,
    });
    expect(f.expiresAt).toBe(r.clock.t + 5_000);
    expect(JSON.stringify(f)).not.toContain("secret-body"); // never text
    expect("text" in f).toBe(false);
    r.relay.router.onAgentFrame(b.key, ackOf(f));
    expect(out[0]).toMatchObject({
      ok: true,
      effect: "applied",
      activation: { status: "accepted", effect: "applied", messageId: m.messageId, retryable: false },
    });
    const again = activate(r, a, m);
    expect(again[0]).toMatchObject({ ok: true, activation: { status: "already_active", effect: "none", dup: true } });
    expect(relays(b)).toHaveLength(1);
  });

  it("pair wake window full (2/h) ⇒ refused pair_wake_rate + authoritative retryAfterAt, NO relay, NO new wake charge", async () => {
    const { r, a, b } = pair();
    const t0 = r.clock.t;
    await sendDelivered(r, a, b, { wake: true, woke: true }); // pair wake #1 (not refunded: woke)
    r.clock.t += 60_000;
    await sendDelivered(r, a, b, { wake: true, woke: true }); // pair wake #2
    r.clock.t += 60_000;
    const m = await sendDelivered(r, a, b, { longTicket: true }); // deliver-only, delivered, unstarted
    const out = activate(r, a, m);
    expect(out[0]).toMatchObject({
      ok: true,
      effect: "none",
      wakeDowngraded: "pair_wake_rate",
      activation: { status: "refused", effect: "none", wakeDowngraded: "pair_wake_rate", retryable: true },
    });
    expect(out[0]!.activation!.retryAfterAt).toBe(t0 + HOUR); // sliding window: oldest occupant + 1h
    expect(relays(b)).toHaveLength(0);
    // a second refused try changes nothing (still no relay, same authoritative instant)
    const out2 = activate(r, a, m);
    expect(out2[0]!.activation!.retryAfterAt).toBe(t0 + HOUR);
    expect(relays(b)).toHaveLength(0);
    // once the oldest occupant ages out the SAME key goes through (one relay)
    r.clock.t = t0 + HOUR + 1;
    activate(r, a, m);
    expect(relays(b)).toHaveLength(1);
  });

  it("a none-effect ack refunds ONLY this attempt's wake reservation (second attempt still admitted at the cap)", async () => {
    const { r, a, b } = pair();
    await sendDelivered(r, a, b, { wake: true, woke: true }); // pair wake #1 → 1 of 2 used
    r.clock.t += 60_000;
    const m = await sendDelivered(r, a, b);
    const out = activate(r, a, m); // attempt #1 takes the 2nd (last) slot
    r.relay.router.onAgentFrame(
      b.key,
      ackOf(relays(b)[0]!, { status: "refused", effect: "none", reason: "receiver_policy" }),
    );
    expect(out[0]).toMatchObject({ activation: { status: "refused", reason: "receiver_policy" } });
    // inside the retry floor (floor = ack time, but the hub's own 30s attempt spacing applies)
    const early = activate(r, a, m);
    expect(early[0]!.activation).toMatchObject({ status: "refused", retryable: true });
    expect(relays(b)).toHaveLength(1);
    r.clock.t += 31_000;
    activate(r, a, m); // refunded slot ⇒ admitted again (would be pair_wake_rate without the refund)
    expect(relays(b)).toHaveLength(2);
  });

  it("relay deadline without an ack ⇒ unknown (no refund); later activates are unknown dups; a late applied ack ⇒ consumed", async () => {
    const { r, a, b } = pair();
    const m = await sendDelivered(r, a, b);
    const out = activate(r, a, m);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(out[0]).toMatchObject({
      ok: true,
      effect: "unknown",
      activation: { status: "unknown", effect: "unknown", reason: "activate_deadline", retryable: false },
    });
    const dup = activate(r, a, m);
    expect(dup[0]!.activation).toMatchObject({ status: "unknown", effect: "unknown", dup: true });
    expect(relays(b)).toHaveLength(1);
    r.relay.router.onAgentFrame(b.key, ackOf(relays(b)[0]!)); // late proof the action landed
    const after = activate(r, a, m);
    expect(after[0]!.activation).toMatchObject({ status: "already_active", dup: true });
    expect(relays(b)).toHaveLength(1);
  });

  it("known facts need no quota and no relay: started / replied are none no-ops", async () => {
    const { r, a, b } = pair();
    const m = await sendDelivered(r, a, b);
    r.relay.router.onAgentFrame(b.key, {
      t: "xs_state",
      messageId: m.messageId,
      revision: 2,
      deliveryEffect: "applied",
      phase: "started",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
    });
    expect(activate(r, a, m)[0]!.activation).toMatchObject({ status: "already_started", effect: "none" });
    r.relay.router.onAgentFrame(b.key, {
      t: "xs_state",
      messageId: m.messageId,
      revision: 3,
      deliveryEffect: "applied",
      phase: "replied",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
    });
    expect(activate(r, a, m)[0]!.activation).toMatchObject({ status: "already_replied", effect: "none" });
    expect(relays(b)).toHaveLength(0);
  });

  it("a plain (30-min) ticket that lapses before the quota recovers is NOT extended: later activate is not_tracked", async () => {
    const { r, a, b } = pair();
    const t0 = r.clock.t;
    await sendDelivered(r, a, b, { wake: true, woke: true });
    r.clock.t += 60_000;
    await sendDelivered(r, a, b, { wake: true, woke: true });
    r.clock.t += 60_000;
    const m = await sendDelivered(r, a, b);
    expect(activate(r, a, m)[0]!.activation).toMatchObject({ wakeDowngraded: "pair_wake_rate", retryable: true });
    r.clock.t = t0 + HOUR + 1;
    expect(activate(r, a, m)[0]).toMatchObject({ ok: false, code: "E_XS_NOT_TRACKED" });
    expect(relays(b)).toHaveLength(0);
  });

  it("U6: only an already-delivered original — queued / unconfirmed is refused not_delivered, no relay", async () => {
    const { r, a, b } = pair();
    const queued = await sendDelivered(r, a, b, { phase: "queued" });
    expect(activate(r, a, queued)[0]!.activation).toMatchObject({
      status: "refused",
      reason: "not_delivered",
      retryable: true,
    });
    const nophase = await sendDelivered(r, a, b, { phase: undefined });
    expect(activate(r, a, nophase)[0]!.activation).toMatchObject({ status: "refused", reason: "not_delivered" });
    expect(relays(b)).toHaveLength(0);
  });

  it("key / source / target pin and expiry: unknown id, foreign source, stale key, wrong target all refuse without a relay", async () => {
    const { r, a, b } = pair();
    const m = await sendDelivered(r, a, b);
    expect(call(r, a.key, req({ op: "activate", messageId: "x-unknown", activationKey: "k" }))[0]).toMatchObject({
      ok: false,
      code: "E_XS_NOT_TRACKED",
    });
    expect(activate(r, a, { messageId: m.messageId, key: "kforged" })[0]).toMatchObject({
      ok: false,
      code: "E_XS_STALE_KEY",
    });
    expect(activate(r, a, m, { to: "sess-OTHERSESSION" })[0]).toMatchObject({ ok: false, code: "E_XS_BAD_TARGET" });
    // a third session is NOT the source: indistinguishable not-tracked
    const c = r.agent({ pid: 3, sessionId: "sess-C", caps: CAPS });
    expect(
      call(r, c.key, req({ op: "activate", to: B_ID, messageId: m.messageId, activationKey: m.key }, "sess-C"))[0],
    ).toMatchObject({ ok: false, code: "E_XS_NOT_TRACKED" });
    r.clock.t += 31 * 60_000; // past the plain 30-min window
    expect(activate(r, a, m)[0]).toMatchObject({ ok: false, code: "E_XS_NOT_TRACKED" });
    expect(relays(b)).toHaveLength(0);
  });

  it("capability gates: requester without xs.activate.v1 ⇒ E_XS_OFF; target without it ⇒ unsupported (never simulated)", async () => {
    const noReq = pair({ sourceCaps: ["ev.v1", "xs.v1", "xs.state.v1"] });
    const m1 = await sendDelivered(noReq.r, noReq.a, noReq.b);
    expect(activate(noReq.r, noReq.a, m1)[0]).toMatchObject({ ok: false, code: "E_XS_OFF" });
    const noTarget = pair({ targetCaps: ["ev.v1", "xs.v1", "xs.state.v1"] });
    const m2 = await sendDelivered(noTarget.r, noTarget.a, noTarget.b);
    expect(activate(noTarget.r, noTarget.a, m2)[0]!.activation).toMatchObject({
      status: "unsupported",
      effect: "none",
    });
    expect(relays(noTarget.b)).toHaveLength(0);
  });

  it("an ack from the wrong socket or with a stale key is ignored and never settles the pending attempt", async () => {
    const { r, a, b } = pair();
    const m = await sendDelivered(r, a, b);
    const out = activate(r, a, m);
    const f = relays(b)[0]!;
    r.relay.router.onAgentFrame(a.key, ackOf(f)); // the SOURCE socket cannot settle it
    r.relay.router.onAgentFrame(b.key, ackOf(f, { activationKey: "kforged" }));
    expect(out).toEqual([]);
    r.relay.router.onAgentFrame(b.key, ackOf(f)); // the real one
    expect(out[0]).toMatchObject({ ok: true, activation: { status: "accepted" } });
    r.relay.router.onAgentFrame(b.key, ackOf(f)); // a duplicate settles nothing twice
    expect(out).toHaveLength(1);
  });
});
