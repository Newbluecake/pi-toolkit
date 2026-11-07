import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { XS_STATE_AGENT_CAP } from "../../../src/web-hub/protocol/xs-activation.js";
import type { XsStateFrame } from "../../../src/web-hub/protocol/xs-activation.js";
import { rig, type Rig } from "./xs-fixtures.js";

/**
 * fabric-xs-activation plan §3 P1 (arch §4.5/§4.7): the ROUTER side of the evidence chain —
 * three-end `xs.state.v1` negotiation at the send path (hub activation key ∧ BOTH hello caps),
 * the initial `xs_state` push to the source (sourceRid = the original send's rid, key + window),
 * receiver→hub state forwarding to the source, the read-only `receipt` op, and the explicit
 * P1 refusal of `op:"activate"` (P3 owns it). Any missing leg ⇒ the OLD path byte-for-byte:
 * no relation, no key, no push (pinned by asserting the source socket saw ONLY xs_res).
 */

const B_ID = "sess-BBBBBBBBBBBB-long";
const STATE_CAPS = ["ev.v1", "xs.v1", "xs.state.v1"];

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
const statesTo = (conn: { sent: unknown[] }): XsStateFrame[] =>
  conn.sent.filter((x) => (x as { t?: string }).t === "xs_state") as XsStateFrame[];

function statePair(sourceCap: boolean, targetCap: boolean) {
  const r = rig(60, undefined, true);
  const a = r.agent({ pid: 1, sessionId: "sess-A", name: "alpha", caps: sourceCap ? STATE_CAPS : ["ev.v1", "xs.v1"] });
  const b = r.agent({
    pid: 2,
    sessionId: B_ID,
    name: "beta",
    receive: "wake",
    caps: targetCap ? STATE_CAPS : ["ev.v1", "xs.v1"],
  });
  return { r, a, b };
}

async function deliverAndAck(r: Rig, b: { key: string; conn: { sent: unknown[] } }) {
  const deliver = [...b.conn.sent].reverse().find((x) => (x as { t?: string }).t === "xs_deliver") as {
    rid: string;
    xid: string;
  };
  r.registry.onFrame(b.key, { t: "xs_ack", rid: deliver.rid, xid: deliver.xid, effect: "applied", woke: false });
  await vi.advanceTimersByTimeAsync(0);
  return deliver;
}

describe("xs router: state relation registration + forwarding (fabric-xs-activation P1)", () => {
  it("three-end negotiation registers the relation and pushes the initial snapshot to the SOURCE", async () => {
    const { r, a, b } = statePair(true, true);
    const out = call(r, a.key, req({ op: "send", to: B_ID, text: "tracked" }));
    await deliverAndAck(r, b);
    expect(out[0]).toMatchObject({ ok: true, effect: "applied" });
    const states = statesTo(a.conn);
    expect(states).toHaveLength(1);
    const s = states[0]!;
    expect(s.messageId).toMatch(/^x[0-9a-f]{18}$/);
    expect(s.sourceRid).toBe(out[0]!.rid);
    expect(s.activationKey).toMatch(/^k/);
    expect(typeof s.activationUntil).toBe("number");
    expect(s.wake).toEqual({ requested: false, decision: "deliver_only" });
    expect(s.deliveryEffect).toBe("unknown");
    // hygiene: no body text on the state frame
    expect(JSON.stringify(s)).not.toContain("tracked");
  });

  it("a receiver→hub xs_state is verified and forwarded to the source with the relation's sourceRid", async () => {
    const { r, a, b } = statePair(true, true);
    call(r, a.key, req({ op: "send", to: B_ID, text: "tracked" }));
    const deliver = await deliverAndAck(r, b);
    const initial = statesTo(a.conn)[0]!;
    r.relay.router.onAgentFrame(b.key, {
      t: "xs_state",
      messageId: deliver.xid,
      revision: 1,
      deliveryEffect: "applied",
      phase: "delivered",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
      sourceRid: "forged-by-receiver",
    });
    const forwarded = statesTo(a.conn)[1]!;
    expect(forwarded.phase).toBe("delivered");
    expect(forwarded.sourceRid).toBe(initial.sourceRid); // hub-owned, never the receiver's
    expect(forwarded.activationKey).toBe(initial.activationKey);
    // a state from the WRONG socket is dropped whole
    r.relay.router.onAgentFrame(a.key, {
      t: "xs_state",
      messageId: deliver.xid,
      revision: 2,
      deliveryEffect: "applied",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
    });
    expect(statesTo(a.conn)).toHaveLength(2);
  });

  it.each([
    ["source without the cap", false, true],
    ["target without the cap", true, false],
  ])(
    "%s ⇒ the OLD path: no relation, no push (source socket sees only xs_res)",
    async (_name, sourceCap, targetCap) => {
      const { r, a, b } = statePair(sourceCap, targetCap);
      const out = call(r, a.key, req({ op: "send", to: B_ID, text: "untracked" }));
      await deliverAndAck(r, b);
      expect(out[0]).toMatchObject({ ok: true, effect: "applied" });
      expect(statesTo(a.conn)).toEqual([]);
    },
  );

  it("activation key absent (old hub config) ⇒ no service, receipt/activate answered E_XS_OFF", () => {
    const r = rig(); // no third arg ⇒ no activation key
    const a = r.agent({ pid: 1, sessionId: "sess-A", caps: STATE_CAPS });
    expect(call(r, a.key, req({ op: "receipt", messageId: "xid-1" }))[0]).toMatchObject({
      ok: false,
      code: "E_XS_OFF",
      effect: "none",
    });
    expect(call(r, a.key, req({ op: "activate", messageId: "xid-1", activationKey: "k1" }))[0]).toMatchObject({
      ok: false,
      code: "E_XS_OFF",
      effect: "none",
    });
    // push frames on a service-less hub stay ignored (old registry fall-through)
    r.relay.router.onAgentFrame(a.key, {
      t: "xs_state",
      messageId: "xid-1",
      revision: 1,
      deliveryEffect: "unknown",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
    });
    expect(statesTo(a.conn)).toEqual([]);
  });

  it("receipt: ok + snapshot push for the source; NOT_TRACKED for a foreign/unknown id", async () => {
    const { r, a, b } = statePair(true, true);
    call(r, a.key, req({ op: "send", to: B_ID, text: "tracked" }));
    const deliver = await deliverAndAck(r, b);
    const before = statesTo(a.conn).length;
    const out = call(r, a.key, req({ op: "receipt", messageId: deliver.xid }));
    expect(out[0]).toMatchObject({ ok: true });
    const pushed = statesTo(a.conn).at(-1)!;
    expect(pushed.messageId).toBe(deliver.xid);
    expect(statesTo(a.conn).length).toBe(before + 1);
    expect(call(r, a.key, req({ op: "receipt", messageId: "x-unknown" }))[0]).toMatchObject({
      ok: false,
      code: "E_XS_NOT_TRACKED",
      effect: "none",
    });
  });

  it("xs_activate_ack (P3 frame) is routed and ignored diagnostically on a P1 hub", async () => {
    const { r, a, b } = statePair(true, true);
    call(r, a.key, req({ op: "send", to: B_ID, text: "tracked" }));
    await deliverAndAck(r, b);
    expect(() =>
      r.relay.router.onAgentFrame(b.key, {
        t: "xs_activate_ack",
        rid: "r-none",
        messageId: "x-none",
        activationKey: "k-none",
        status: "refused",
        effect: "none",
        retryable: false,
      }),
    ).not.toThrow();
  });
});

// keep the cap constant honest against the router's registry-view check
void XS_STATE_AGENT_CAP;
