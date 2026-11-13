import { describe, expect, it } from "vitest";
import { createTerminalNegotiator } from "../../../src/web-hub/agent/commands.js";
import type { CmdFrame } from "../../../src/web-hub/protocol/messages.js";
import { type TermRes, type TerminalProtocolReadyProof } from "../../../src/web-hub/protocol/terminal.js";
const limits = { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
const command = (id = "command"): CmdFrame => ({
  t: "cmd",
  rid: "rid",
  id,
  deadlineMs: 3000,
  origin: { listener: "loopback", ip: "127.0.0.1", reqId: "req" },
  cmd: { op: "command", name: "webhub", args: "__terminal" },
});
function harness() {
  let time = 0,
    allowed = true;
  let scope = { localConnectionInstance: "connection", sessionId: "session", epoch: "epoch", ownerInstance: "owner" };
  const sent: TermRes[] = [],
    bound: Array<{ channel: string; proof: TerminalProtocolReadyProof }> = [];
  let minted = 0;
  const gate = createTerminalNegotiator({
    now: () => time,
    current: () => scope,
    allowed: () => allowed,
    limits,
    mintGrant: () => {
      minted++;
      return "private-grant";
    },
    send: (f) => sent.push(f),
    onBound: (channel, proof) => bound.push({ channel, proof }),
  });
  return {
    gate,
    sent,
    bound,
    get minted() {
      return minted;
    },
    setTime(t: number) {
      time = t;
    },
    disable() {
      allowed = false;
    },
    replaceConnection() {
      scope = { ...scope, localConnectionInstance: "different" };
    },
  };
}
function challenge(h: ReturnType<typeof harness>, mode: "negotiate" | "resource_inventory" = "negotiate") {
  const offer = h.gate.offer(command(), { v: 1, action: mode, requestNonce: "nonce" })!;
  expect(offer).toEqual({ v: 1, outcome: "handshake-required", offerId: expect.any(String) });
  expect(h.minted).toBe(0);
  const prep = {
    t: "term_req",
    v: 1,
    rid: "prepare",
    sessionId: "session",
    epoch: "epoch",
    op: "prepare_protocol",
    offerId: offer.offerId,
    hubNonce: "hub",
  };
  expect(h.gate.receive(prep)).toBe(true);
  expect(h.minted).toBe(0);
  const c = h.sent[0]!;
  if (c.op !== "protocol_challenge" || !c.ok) throw new Error("challenge missing");
  return {
    ...prep,
    rid: "ready",
    op: "protocol_ready",
    ownerInstance: c.ownerInstance,
    agentChallenge: c.agentChallenge,
  };
}
describe("terminal agent sending-side ready gate (§4.1(6), T-BIND/T-CACHE)", () => {
  it("mints exactly once after ready; bind consumes grant once without opening shell", () => {
    const h = harness(),
      ready = challenge(h);
    expect(h.gate.receive(ready)).toBe(true);
    expect(h.minted).toBe(1);
    expect(h.bound).toEqual([]);
    expect(h.gate.receive(ready)).toBe(false);
    expect(h.minted).toBe(1);
    const bind = { ...ready, rid: "bind", op: "bind", proposedChannelId: "channel", grant: "private-grant" };
    expect(h.gate.receive({ ...bind, grant: "forged" })).toBe(false);
    expect(h.gate.receive(bind)).toBe(true);
    expect(h.gate.receive(bind)).toBe(false);
    expect(h.bound).toHaveLength(1);
    expect(h.bound[0]!.proof.mode).toBe("interactive");
  });
  it.each(["wrong-challenge", "wrong-owner", "wrong-epoch", "connection", "expiry", "guard", "dispose"])(
    "%s rejects before mint/send",
    (fault) => {
      const h = harness(),
        ready = challenge(h);
      let request = { ...ready };
      if (fault === "wrong-challenge") request.agentChallenge = "wrong";
      if (fault === "wrong-owner") request.ownerInstance = "wrong";
      if (fault === "wrong-epoch") request.epoch = "wrong";
      if (fault === "connection") h.replaceConnection();
      if (fault === "expiry") h.setTime(3000);
      if (fault === "guard") h.disable();
      if (fault === "dispose") h.gate.dispose();
      expect(h.gate.receive(request)).toBe(false);
      expect(h.minted).toBe(0);
      expect(h.sent).toHaveLength(1);
      expect(h.bound).toEqual([]);
    },
  );
  it("resource-only ready never mints an interactive grant, cannot bind or upgrade", () => {
    const h = harness(),
      ready = challenge(h, "resource_inventory");
    expect(h.gate.receive(ready)).toBe(true);
    expect(h.minted).toBe(0);
    expect(h.sent[1]).toMatchObject({ op: "protocol_ready", mode: "resource-only" });
    expect(h.sent[1]).not.toHaveProperty("grant");
    expect(h.bound).toHaveLength(1);
    expect(h.bound[0]!.proof.mode).toBe("resource-only");
    expect(h.gate.receive({ ...ready, op: "bind", proposedChannelId: "channel", grant: "invented" })).toBe(false);
  });
  it("offers are bounded, command duplicates do not extend the original deadline", () => {
    const h = harness();
    const first = h.gate.offer(command(), { v: 1, action: "negotiate", requestNonce: "nonce" });
    h.setTime(2999);
    expect(h.gate.offer(command(), { v: 1, action: "negotiate", requestNonce: "nonce" })).toEqual(first);
    for (let i = 1; i < 64; i++)
      expect(h.gate.offer(command(`command-${i}`), { v: 1, action: "negotiate", requestNonce: "nonce" })).toBeDefined();
    expect(h.gate.offer(command("overflow"), { v: 1, action: "negotiate", requestNonce: "nonce" })).toBeUndefined();
    h.setTime(3000);
    expect(
      h.gate.receive({
        t: "term_req",
        v: 1,
        rid: "r",
        sessionId: "session",
        epoch: "epoch",
        op: "prepare_protocol",
        offerId: first!.offerId,
        hubNonce: "hub",
      }),
    ).toBe(false);
  });
});
