import { afterEach, describe, expect, it, vi } from "vitest";
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
const gates: ReturnType<typeof createTerminalNegotiator>[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function harness() {
  let time = 0,
    allowed = true;
  type Scope = { localConnectionInstance: string; sessionId: string; epoch: string; ownerInstance: string };
  let scope: Scope | undefined = {
    localConnectionInstance: "connection",
    sessionId: "session",
    epoch: "epoch",
    ownerInstance: "owner",
  };
  let times: number[] = [];
  let onMint: (() => void) | undefined;
  let onSend: (() => void) | undefined;
  const sent: TermRes[] = [],
    bound: Array<{ channel: string; proof: TerminalProtocolReadyProof }> = [];
  let minted = 0;
  const gate = createTerminalNegotiator({
    now: () => (times.length ? (time = times.shift()!) : time),
    current: () => scope,
    allowed: () => allowed,
    limits,
    mintGrant: () => {
      minted++;
      onMint?.();
      return "private-grant";
    },
    send: (f) => {
      sent.push(f);
      onSend?.();
    },
    onBound: (channel, proof) => bound.push({ channel, proof }),
  });
  gates.push(gate);
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
      scope = { ...scope!, localConnectionInstance: "different" };
    },
    changeScope(field: keyof Scope) {
      scope = { ...scope!, [field]: "different" };
    },
    loseScope() {
      scope = undefined;
    },
    clockSequence(values: number[]) {
      times = [...values];
    },
    onMint(fn: () => void) {
      onMint = fn;
    },
    onSend(fn: () => void) {
      onSend = fn;
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
    const bind = { ...ready, rid: "bind", op: "bind", proposedChannelId: "channel", grant: "private-grant" };
    expect(h.gate.receive(bind)).toBe(true);
    expect(h.gate.receive(bind)).toBe(false);
    expect(h.bound).toHaveLength(1);
    expect(h.bound[0]!.proof.mode).toBe("interactive");
  });
  it.each([
    "proof.ownerInstance",
    "proof.hubNonce",
    "proof.agentChallenge",
    "frame.sessionId",
    "frame.epoch",
    "current.localConnectionInstance",
    "current.sessionId",
    "current.epoch",
    "current.ownerInstance",
    "current.absent",
    "expiry",
    "allowed",
    "dispose",
  ])("single binding: %s rejects before mint/send", (fault) => {
    const h = harness(),
      ready = challenge(h);
    const request = { ...ready };
    if (fault.startsWith("proof.") || fault.startsWith("frame."))
      Object.assign(request, { [fault.split(".")[1]!]: "wrong" });
    if (fault.startsWith("current.")) {
      const field = fault.split(".")[1]!;
      if (field === "absent") h.loseScope();
      else h.changeScope(field as "localConnectionInstance" | "sessionId" | "epoch" | "ownerInstance");
    }
    if (fault === "expiry") h.setTime(3000);
    if (fault === "allowed") h.disable();
    if (fault === "dispose") h.gate.dispose();
    expect(h.gate.receive(request)).toBe(false);
    expect(h.minted).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.bound).toEqual([]);
  });
  it("single binding: prepare phase rejects replay", () => {
    const h = harness(),
      ready = challenge(h);
    const { ownerInstance: _owner, agentChallenge: _challenge, ...prep } = ready;
    expect(h.gate.receive({ ...prep, op: "prepare_protocol" })).toBe(false);
    expect(h.sent).toHaveLength(1);
    expect(h.minted).toBe(0);
  });
  it("single binding: admission rechecks live after prune", () => {
    const h = harness();
    const offer = h.gate.offer(command(), { v: 1, action: "negotiate", requestNonce: "nonce" })!;
    // A real clock can cross the deadline between successive synchronous guard reads.
    h.clockSequence([2999, 3000]);
    expect(
      h.gate.receive({
        t: "term_req",
        v: 1,
        rid: "prep",
        sessionId: "session",
        epoch: "epoch",
        op: "prepare_protocol",
        offerId: offer.offerId,
        hubNonce: "hub",
      }),
    ).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.minted).toBe(0);
  });
  it("single binding: pre-mint live check forbids even minting after deadline", () => {
    const h = harness(),
      ready = challenge(h);
    h.clockSequence([2999, 2999, 3000]);
    expect(h.gate.receive(ready)).toBe(false);
    expect(h.minted).toBe(0);
    expect(h.sent).toHaveLength(1);
  });
  it("single binding: post-mint live check forbids sending after port revocation", () => {
    const h = harness(),
      ready = challenge(h);
    h.onMint(() => h.disable());
    expect(h.gate.receive(ready)).toBe(false);
    expect(h.minted).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.bound).toEqual([]);
  });
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

/** Observe the actual private Map, not a production debug surface or a fake registry.
 * Retain detached rows too: the cleanup must erase their capability fields, not just keys. */
function observeOffers() {
  const rows: Record<string, unknown>[] = [];
  let offers: Map<unknown, unknown> | undefined;
  const set = Map.prototype.set;
  vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    if (
      value &&
      typeof value === "object" &&
      value.phase === "offered" &&
      typeof value.offerId === "string" &&
      value.scope
    ) {
      offers = this;
      rows.push(value as Record<string, unknown>);
    }
    return set.call(this, key, value);
  });
  return {
    rows,
    get map() {
      if (!offers) throw new Error("offer Map not observed");
      return offers;
    },
  };
}
function scrubbed(row: Record<string, unknown>) {
  for (const key of ["timer", "grant", "proof", "hubNonce", "agentChallenge"]) expect(row).not.toHaveProperty(key);
  expect(row.phase).toBe("closed");
}
function readyWithGrant() {
  const h = harness(),
    ready = challenge(h);
  expect(h.gate.receive(ready)).toBe(true);
  const bind = { ...ready, rid: "bind", op: "bind", proposedChannelId: "channel", grant: "private-grant" };
  return { ...h, ready, bind };
}
describe("terminal offer expiry/material reclamation (r_TJ5QEN3F Major)", () => {
  it.each(["offered", "challenged", "ready"])("%s expires without any later offer or receive", (phase) => {
    vi.useFakeTimers();
    const observed = observeOffers();
    const h = harness();
    if (phase === "offered")
      expect(h.gate.offer(command(), { v: 1, action: "negotiate", requestNonce: "nonce" })).toBeDefined();
    else {
      const ready = challenge(h);
      if (phase === "ready") expect(h.gate.receive(ready)).toBe(true);
    }
    const row = observed.rows[0]!;
    if (phase === "ready") expect(row.grant).toBe("private-grant");
    h.setTime(3000);
    vi.advanceTimersByTime(3000); // No gate method/next request performs cleanup.
    expect(observed.map.size).toBe(0);
    scrubbed(row);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("expired bind prunes and scrubs even before the expiry callback is dispatched", () => {
    vi.useFakeTimers();
    const observed = observeOffers();
    const h = readyWithGrant();
    h.setTime(10001); // Wall-clock has advanced; deliberately do not run the scheduled timer.
    expect(h.gate.receive(h.bind)).toBe(false);
    expect(observed.map.size).toBe(0);
    scrubbed(observed.rows[0]!);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["allowed", "scope"])("invalid receive prunes revoked %s entries before schema validation", (fault) => {
    vi.useFakeTimers();
    const observed = observeOffers();
    const h = readyWithGrant();
    if (fault === "allowed") h.disable();
    else h.replaceConnection();
    expect(h.gate.receive({ t: "invalid" })).toBe(false);
    expect(observed.map.size).toBe(0);
    scrubbed(observed.rows[0]!);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["bind-success", "bind-rejected", "ready-replayed", "invalid-correlated", "invalidate", "dispose"])(
    "%s clears the row, timer and private material",
    (outcome) => {
      vi.useFakeTimers();
      const observed = observeOffers();
      const h = readyWithGrant();
      if (outcome === "bind-success") expect(h.gate.receive(h.bind)).toBe(true);
      if (outcome === "bind-rejected") expect(h.gate.receive({ ...h.bind, grant: "wrong" })).toBe(false);
      if (outcome === "ready-replayed") expect(h.gate.receive(h.ready)).toBe(false);
      if (outcome === "invalid-correlated") expect(h.gate.receive({ ...h.bind, extra: true })).toBe(false);
      if (outcome === "invalidate") h.gate.invalidate();
      if (outcome === "dispose") h.gate.dispose();
      expect(observed.map.size).toBe(0);
      scrubbed(observed.rows[0]!);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.gate.receive(h.bind)).toBe(false);
    },
  );
  it("unrefs every timer and dispose clears all timers, including more than one offer", () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const observed = observeOffers();
    const h = harness();
    for (let n = 0; n < 3; n++)
      expect(h.gate.offer(command(`command-${n}`), { v: 1, action: "negotiate", requestNonce: "nonce" })).toBeDefined();
    expect(vi.getTimerCount()).toBe(3);
    expect(timers.mock.results).toHaveLength(3);
    for (const result of timers.mock.results) expect((result.value as NodeJS.Timeout).hasRef()).toBe(false);
    h.gate.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(observed.map.size).toBe(0);
    for (const row of observed.rows) scrubbed(row);
  });
  it("resource-only successful ready clears bootstrap timer and proof row before handing off the channel", () => {
    vi.useFakeTimers();
    const observed = observeOffers();
    const h = harness(),
      ready = challenge(h, "resource_inventory");
    expect(h.gate.receive(ready)).toBe(true);
    expect(h.bound).toHaveLength(1);
    expect(observed.map.size).toBe(0);
    scrubbed(observed.rows[0]!);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("terminal admission binding audit", () => {
  it.each(["allowed", "dispose", "current"])("single binding: offer admission %s", (fault) => {
    const h = harness();
    if (fault === "allowed") h.disable();
    if (fault === "dispose") h.gate.dispose();
    if (fault === "current") h.loseScope();
    expect(h.gate.offer(command(), { v: 1, action: "negotiate", requestNonce: "nonce" })).toBeUndefined();
    expect(h.minted).toBe(0);
    expect(h.sent).toEqual([]);
  });
  it.each(["negotiate", "resource_inventory"] as const)(
    "single binding: %s bind before ready has no grant/proof authority",
    (mode) => {
      const h = harness(),
        ready = challenge(h, mode);
      expect(h.gate.receive({ ...ready, op: "bind", grant: "invented", proposedChannelId: "channel" })).toBe(false);
      expect(h.bound).toEqual([]);
      expect(h.sent).toHaveLength(1);
      expect(h.minted).toBe(0);
    },
  );
});

it.each(["resource-only", "bind"])("single binding: %s handoff rechecks after transport callback", (mode) => {
  const h = harness(),
    ready = challenge(h, mode === "resource-only" ? "resource_inventory" : "negotiate");
  if (mode === "bind") expect(h.gate.receive(ready)).toBe(true);
  h.onSend(() => h.disable());
  const request =
    mode === "bind" ? { ...ready, op: "bind", grant: "private-grant", proposedChannelId: "channel" } : ready;
  expect(h.gate.receive(request)).toBe(true); // reply was sent before revocation
  expect(h.bound).toEqual([]); // but no backend handoff may cross it
});
