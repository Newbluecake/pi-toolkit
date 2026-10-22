import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../../src/core/clock.js";
import type { RootWakeDispatchResult, RootWakeRequest } from "../../../src/fabric/root-wake.js";
import { XsDedup } from "../../../src/fabric/xs/dedup.js";
import { createSessionFence } from "../../../src/fabric/xs/fence.js";
import { XsInbox } from "../../../src/fabric/xs/inbox.js";
import { XsMembership } from "../../../src/fabric/xs/membership.js";
import { XsReceiver, type XsDeliverHost, type XsDeliverInput } from "../../../src/fabric/xs/receiver.js";
import type { XsBroadcastTicket } from "../../../src/web-hub/hub/xs/limits.js";
import type { XsDeliverFrame, XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { BCAST_LIMITS, CHANNEL_CAPS, rig, type Rig } from "./xs-fixtures.js";

/**
 * Channel-plan CH1 §9.1 property: hub broadcast fan-out against REAL `XsReceiver` instances as the
 * ack source (incl. the "Controller dispatched, post-dispatch verify failed ⇒ unknown + woke:false"
 * path, C6), with random silent peers (hub deadline), disconnects and router disposal.
 *
 * Invariants per broadcast:
 *   I1 every recipient sees ≤ 1 `xs_deliver` for it;
 *   I2 fanout.applied + none + unknown = total = N = results.length;
 *   I3 effect "none" ⇔ every row is provably none (ambiguous / the receiver's own none);
 *   I4 the in-flight slot is released exactly once (settleBroadcast per ticket, first call settles);
 *   I5 broadcast-wake reservations are never refunded: across the hour, wake-reserved broadcasts
 *      never exceed the hard 2, whatever the acks said.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mode = "answer" | "silent" | "disconnect";
type Ctrl = "none" | "applied" | "verify_fail" | "downgrade" | "deferred";

interface Peer {
  key: string;
  sessionId: string;
  mode: Mode;
  delivered: XsDeliverFrame[];
  receiver: XsReceiver;
  gone: boolean;
}

const SA = "sess-SENDER00";

function makePeer(r: Rig, rnd: () => number, idx: number, clock: Clock): Peer {
  const sessionId = `sess-${idx}PEER-0000000`;
  const membership = new XsMembership({ sessionId, clock, persist: () => {} });
  membership.attach();
  const joinRes = membership.join(rnd() < 0.3 ? ["default", "team"] : ["team"]);
  expect(joinRes.ok).toBe(true);
  let armed = false;
  const fence = createSessionFence({ clock, ports: { webExec: () => armed } });
  const ctrlMode: Ctrl = (["none", "applied", "verify_fail", "downgrade", "deferred"] as const)[Math.floor(rnd() * 5)]!;
  let idle = rnd() < 0.7;
  const leaves: Array<{ type: string; customType?: string; details?: unknown }> = [];
  const host: XsDeliverHost = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sendMessage(message, options) {
      if (options.triggerTurn) idle = false;
      else if (idle) leaves.push({ type: "custom_message", customType: message.customType, details: message.details });
    },
    getLeafEntry: () => leaves.at(-1),
  };
  const controller =
    ctrlMode === "none"
      ? undefined
      : {
          dispatch(req: RootWakeRequest): RootWakeDispatchResult {
            void req;
            if (ctrlMode === "downgrade") return { dispatched: false, wakeDowngraded: "busy" };
            if (ctrlMode === "verify_fail") armed = true; // fence re-opens between dispatch and verify
            if (ctrlMode === "deferred")
              return { dispatched: true, effect: "unknown", reason: "start_deferred", woke: true, token: "t" };
            return { dispatched: true, effect: "applied", woke: true, token: "t" };
          },
        };
  const receiver = new XsReceiver({
    sessionId,
    membership,
    fence,
    inbox: new XsInbox(12, clock),
    recvPerHour: 30,
    wakesInPerHour: 12,
    ...(controller === undefined ? {} : { controller }),
    host,
    hubChannelCap: () => true,
    dedup: new XsDedup(256, clock),
    clock,
    warn: () => {},
  });
  const peer: Peer = { key: "", sessionId, mode: "answer", delivered: [], receiver, gone: false };
  const a = r.agent({
    pid: 100 + idx,
    sessionId,
    name: `p${idx}`,
    caps: CHANNEL_CAPS,
    epoch: membership.epoch,
    channels: membership.effective().filter(() => true) as string[],
    receive: rnd() < 0.2 ? "deliver" : "wake",
  });
  peer.key = a.key;
  // bridge: the fake conn hands every xs_deliver to the real receiver (or swallows it)
  const send = a.conn.send;
  a.conn.send = (f) => {
    send(f);
    if ((f as { t?: string }).t !== "xs_deliver") return;
    const d = f as XsDeliverFrame;
    peer.delivered.push(d);
    if (peer.mode !== "answer" || peer.gone) return;
    const { t: _t, rid, ...input } = d;
    queueMicrotask(() => {
      const verdict = receiver.deliver(input as XsDeliverInput);
      r.registry.onFrame(a.key, { t: "xs_ack", rid, xid: d.xid, ...verdict });
    });
  };
  return peer;
}

describe("xs broadcast property (real receivers as the ack source)", () => {
  it("I1–I5 hold over random fan-outs, silences, disconnects and disposal", async () => {
    let checkedRows = 0;
    let sawVerifyUnknown = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = mulberry32(seed);
      const r = rig(600, { maxRecipients: 16, wakeMaxRecipients: 4 });
      const clock: Clock = { now: () => r.clock.t, setTimer: () => ({ id: 0 }), clearTimer: () => {} };
      const sender = r.agent({
        pid: 1,
        sessionId: SA,
        caps: CHANNEL_CAPS,
        channels: ["default", "team"],
        limits: {
          ...BCAST_LIMITS,
          sendsOutPerMin: 60,
          sendsOutPerHour: 600,
          wakesOutPerHour: 60,
          pairWakesPerHour: 20,
          inFlightPerSession: 16,
          broadcastsOutPerHour: 60,
          broadcastMinIntervalMs: 10_000,
          broadcastWakesOutPerHour: 2,
        },
      });
      const peers = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => makePeer(r, rnd, i, clock));
      // a sometimes-present second holder of peer 0's session in another channel (⇒ ambiguous row)
      if (peers.length > 0 && rnd() < 0.25) {
        r.agent({ pid: 99, sessionId: peers[0]!.sessionId, caps: CHANNEL_CAPS, channels: ["elsewhere"] });
      }
      const settles = new Map<XsBroadcastTicket, number>();
      const origSettle = r.relay.limits.settleBroadcast.bind(r.relay.limits);
      r.relay.limits.settleBroadcast = (t) => {
        settles.set(t, (settles.get(t) ?? 0) + 1);
        expect(t.settled).toBe(false); // the router releases exactly once
        origSettle(t);
      };
      const tickets: XsBroadcastTicket[] = [];
      const origAdmit = r.relay.limits.admitBroadcast.bind(r.relay.limits);
      r.relay.limits.admitBroadcast = (args) => {
        const out = origAdmit(args);
        if (out.ok) tickets.push(out.ticket);
        return out;
      };

      const rounds = 1 + Math.floor(rnd() * 4);
      let disposed = false;
      for (let round = 0; round < rounds && !disposed; round++) {
        for (const p of peers) {
          p.mode = (["answer", "answer", "answer", "silent", "disconnect"] as const)[Math.floor(rnd() * 5)]!;
          p.delivered = [];
        }
        const frame: XsReqFrame = {
          t: "xs_req",
          rid: `s${seed}-${round}`,
          op: "broadcast",
          origin: { sessionId: SA, epoch: 1 },
          channel: "team",
          text: `round ${round}`,
          ...(rnd() < 0.7 ? { wake: true, level: rnd() < 0.85 ? 0 : 1 } : {}),
        };
        const out: XsResFrame[] = [];
        r.relay.router.handle(sender.key, frame, (x) => out.push(x));
        for (const p of peers)
          if (p.mode === "disconnect" && !p.gone) {
            p.gone = true;
            r.registry.onClose(p.key, false);
          }
        if (rnd() < 0.08) {
          disposed = true;
          r.relay.dispose();
        }
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(out, `seed ${seed}`).toHaveLength(1);
        const res = out[0]!;
        // I1
        for (const p of peers) expect(p.delivered.length, `seed ${seed}`).toBeLessThanOrEqual(1);
        if (res.fanout !== undefined) {
          const f = res.fanout;
          const rows = res.results ?? [];
          // I2
          expect(f.applied + f.none + f.unknown).toBe(f.total);
          expect(rows).toHaveLength(f.total);
          expect(f.woke).toBe(rows.filter((x) => x.woke).length);
          // I3
          expect(res.effect === "none").toBe(rows.every((x) => x.effect === "none"));
          for (const row of rows) {
            checkedRows++;
            if (row.effect === "unknown" && row.reason === "accept_unverified" && !row.woke) sawVerifyUnknown++;
            const peer = peers.find((p) => p.sessionId.startsWith(row.ref));
            if (row.effect === "none" && row.reason !== "ambiguous") {
              // a provable none only ever comes from the receiver's own verdict on an answered deliver
              expect(peer?.mode).toBe("answer");
            }
            if (peer !== undefined && peer.mode !== "answer" && row.reason !== "ambiguous") {
              expect(row.effect).toBe("unknown");
            }
          }
        } else {
          expect(res.effect).toBe("none"); // a refusal or no_recipients
        }
        r.clock.t += 11_000;
      }
      // I4: every admitted ticket released exactly once
      for (const t of tickets) expect(settles.get(t), `seed ${seed}`).toBe(1);
      // I5: never more than the hard 2 broadcast-wake reservations inside the hour (no refunds)
      expect(tickets.filter((t) => t.wakeReserved).length).toBeLessThanOrEqual(2);
    }
    expect(checkedRows).toBeGreaterThan(100);
    expect(sawVerifyUnknown).toBeGreaterThan(0); // the C6 path was really exercised
  });
});
