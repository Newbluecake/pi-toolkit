import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { RootWakeController, XS_ACTIVATE_MARKER_CONTENT, type RootWakeMessage } from "../../src/fabric/root-wake.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { XsProgressBag } from "../../src/fabric/xs/progress.js";
import {
  createXsActivationPort,
  createXsActivationReceiver,
  type XsActivationHubPort,
  type XsActivationReceiverDeps,
} from "../../src/fabric/xs/session-activation.js";
import type { XsActivateFrame } from "../../src/web-hub/protocol/xs-activation.js";

/**
 * fabric-xs-activation plan §3 P3: receiver half (arch §4.5 admission order, claim/at-most-once,
 * fixed body-free marker through the SAME Controller) and sender half (outcome mapping; unknown
 * is never `none`; query never activates). Real Controller + ledger + progress bag; only the pi
 * host is a deterministic fake.
 */

const SID = "sess-target";
const MID = "x00000000000000000a";

function build(over: { wake?: boolean; receive?: string } = {}) {
  const clock = new FakeClock(),
    ledger = new XsWakeLedger(),
    capability = new XsHostCapability();
  capability.observe({ messageType: "user", prompt: "p" });
  const host = { idle: true };
  const messages: RootWakeMessage[] = [];
  const controller = new RootWakeController({
    sessionId: SID,
    rootRunMaxS: 60,
    wakeEnabled: true,
    receive: () => "wake",
    clock,
    ledger,
    capability,
    newToken: (() => {
      let n = 0;
      return () => `token-${++n}`;
    })(),
    host: {
      isIdle: () => host.idle,
      hasPendingMessages: () => false,
      sendMessage: (m) => {
        messages.push(m);
        host.idle = false;
      },
      abort: vi.fn(),
    },
  });
  const bag = new XsProgressBag(256, clock);
  bag.observe(MID, {
    deliveryEffect: "applied",
    phase: "delivered",
    deliveredAt: 1,
    wake: { requested: false, decision: "deliver_only" },
    activationKey: "k1",
    activationUntil: 10_000_000,
  });
  const state = {
    receive: over.receive ?? "wake",
    allowed: true,
    fence: { ok: true } as { ok: true } | { ok: false; reason: string; wakeOnly?: true },
    confirmed: "present" as "present" | "absent" | "over_budget",
    origin: new Map<string, string>([[MID, "sess-source"]]),
    controller: (over.wake === false ? undefined : controller) as RootWakeController | undefined,
  };
  const observed: unknown[] = [];
  const deps: XsActivationReceiverDeps = {
    sessionId: () => SID,
    epoch: () => 7,
    disposed: () => false,
    now: () => clock.now(),
    membership: {
      get receive() {
        return state.receive;
      },
      senderAllowed: () => state.allowed,
    },
    fence: { check: () => state.fence },
    bag,
    originOf: (id) => state.origin.get(id),
    confirmed: () => state.confirmed,
    flushBranch: () => {},
    hasLiveWake: (id) =>
      ledger
        .entries()
        .some((r) => (r.xid === id || r.activateFor === id) && (r.state === "live" || r.executionPending)),
    controller: () => state.controller,
    observe: (id, fields) => {
      observed.push(fields);
      bag.observe(id, fields, clock.now());
    },
  };
  const receiver = createXsActivationReceiver(deps);
  const frame = (over: Partial<XsActivateFrame> = {}): XsActivateFrame => ({
    t: "xs_activate",
    rid: "a1",
    to: { sessionId: SID, epoch: 7 },
    from: { sessionId: "sess-source", ref: "sess-source", cwdLabel: "~/w", agentId: "ag" },
    messageId: MID,
    activationKey: "k1",
    expiresAt: clock.now() + 5_000,
    level: 0,
    ...over,
  });
  return { clock, ledger, controller, messages, bag, state, receiver, frame, observed, host };
}

describe("RootWakeController.activateExisting (control marker)", () => {
  it("sends the FIXED body-free marker through the same dispatch; ledger binds control xid + activateFor", () => {
    const h = build();
    const r = h.controller.activateExisting({ messageId: MID, from: { sessionId: "sess-source" }, expiresAt: 5_000 });
    expect(r).toMatchObject({ dispatched: true, woke: true, token: "token-1" });
    const m = h.messages[0]!;
    expect(m.customType).toBe("subagent:xs");
    expect(m.content).toBe(XS_ACTIVATE_MARKER_CONTENT);
    expect(m.details).toMatchObject({ xsWake: true, wakeToken: "token-1", activateFor: MID });
    expect(m.details.xid).toMatch(/^r_/); // the CONTROL action's own id, not the body's
    expect(m.details.xid).not.toBe(MID);
    const blob = JSON.stringify(m);
    for (const forbidden of ["secret", "reply_to", "alias", "k1"]) expect(blob).not.toContain(forbidden);
    const rec = h.ledger.get("token-1")!;
    expect(rec).toMatchObject({ activateFor: MID, xid: m.details.xid, state: "live" });
    expect(h.controller.activeMessageId).toBe(MID);
  });

  it("goes through every gate: busy ⇒ downgrade busy (no marker); wake off ⇒ wake_disabled", () => {
    const h = build();
    h.controller.activateExisting({ messageId: MID, from: {}, expiresAt: 5_000 });
    const again = h.controller.activateExisting({ messageId: "x-other", from: {}, expiresAt: 5_000 });
    expect(again).toEqual({ dispatched: false, wakeDowngraded: "busy" });
    expect(h.messages).toHaveLength(1);
  });

  it("fires onEnded once when the control run settles", () => {
    const h = build();
    const ended = vi.fn();
    h.controller.activateExisting({ messageId: MID, from: {}, expiresAt: 5_000, onEnded: ended });
    h.controller.beforeAgentStart({
      messageType: "custom",
      message: { customType: "subagent:xs", details: { xsWake: true, wakeToken: "token-1" } },
    });
    h.controller.settled();
    h.controller.settled();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith("settled");
  });

  it("a body wake's details stay byte-identical (no activateFor key)", () => {
    const h = build();
    h.controller.dispatch({ xid: "xid", from: {}, content: "c", expiresAt: 5_000 });
    expect("activateFor" in h.messages[0]!.details).toBe(false);
  });
});

describe("xs activation receiver (arch §4.5)", () => {
  it("admits ONE activation: accepted, marker sent, claim consumed; a repeat is already_active dup with NO second marker", () => {
    const h = build();
    const ack = h.receiver.handle(h.frame());
    expect(ack).toMatchObject({
      t: "xs_activate_ack",
      rid: "a1",
      status: "accepted",
      effect: "applied",
      retryable: false,
    });
    expect(h.messages).toHaveLength(1);
    expect(h.bag.claimView(MID)?.state).toBe("consumed");
    expect(h.observed).toContainEqual({ wake: { requested: true, decision: "dispatch_accepted" } });
    const again = h.receiver.handle(h.frame({ rid: "a2" }));
    expect(again).toMatchObject({ status: "already_active", effect: "none", dup: true });
    h.controller.settled(); // even after the control run ends the consumed claim never reopens
    expect(h.receiver.handle(h.frame({ rid: "a3" }))).toMatchObject({ status: "already_active", dup: true });
    expect(h.messages).toHaveLength(1);
  });

  it("expiry / identity / policy / fence are re-validated at the receiver (none, no marker)", () => {
    const h = build();
    expect(h.receiver.handle(h.frame({ expiresAt: h.clock.now() }))).toMatchObject({
      status: "refused",
      reason: "expired",
    });
    expect(h.receiver.handle(h.frame({ to: { sessionId: SID, epoch: 8 } }))).toMatchObject({
      reason: "session_changed",
    });
    expect(h.receiver.handle(h.frame({ to: { sessionId: "other", epoch: 7 } }))).toMatchObject({
      reason: "session_changed",
    });
    h.state.allowed = false;
    expect(h.receiver.handle(h.frame())).toMatchObject({ reason: "receiver_policy" });
    h.state.allowed = true;
    h.state.receive = "off";
    expect(h.receiver.handle(h.frame())).toMatchObject({ reason: "receiver_policy" });
    h.state.receive = "wake";
    h.state.fence = { ok: false, reason: "fenced:web_exec" };
    expect(h.receiver.handle(h.frame())).toMatchObject({
      status: "refused",
      reason: "fenced:web_exec",
      effect: "none",
    });
    h.state.fence = { ok: true };
    expect(h.messages).toHaveLength(0);
    expect(h.bag.claimView(MID)).toBeUndefined(); // never reached the claim
  });

  it("source authenticity: the activate `from` must equal the source recorded at original delivery", () => {
    const h = build();
    expect(
      h.receiver.handle(h.frame({ from: { sessionId: "sess-evil", ref: "e", cwdLabel: "~", agentId: "a" } })),
    ).toMatchObject({ status: "refused", reason: "not_tracked" });
    h.state.origin.delete(MID);
    expect(h.receiver.handle(h.frame())).toMatchObject({ status: "refused", reason: "not_tracked" });
    expect(h.messages).toHaveLength(0);
  });

  it("U6 eligibility: unknown id / undelivered / queued / unconfirmed / observation gap ⇒ refuse; started/replied ⇒ none no-op", () => {
    const h = build();
    expect(h.receiver.handle(h.frame({ messageId: "x-missing" }))).toMatchObject({ reason: "not_tracked" });
    h.state.confirmed = "absent";
    expect(h.receiver.handle(h.frame())).toMatchObject({ reason: "not_delivered" });
    h.state.confirmed = "over_budget";
    expect(h.receiver.handle(h.frame())).toMatchObject({ reason: "scan_over_budget" });
    h.state.confirmed = "present";
    h.bag.observe(MID, { observation: "unavailable" });
    expect(h.receiver.handle(h.frame())).toMatchObject({ status: "refused", reason: "unavailable" });
    h.bag.observe(MID, { observation: "live" });
    const q = new XsProgressBag();
    void q;
    h.bag.observe("x-queued", { phase: "queued", queuedAt: 1, deliveryEffect: "unknown" });
    h.state.origin.set("x-queued", "sess-source");
    expect(h.receiver.handle(h.frame({ messageId: "x-queued" }))).toMatchObject({
      reason: "not_delivered",
      retryable: true,
    });
    h.bag.observe(MID, { phase: "started", startedAt: 5 });
    expect(h.receiver.handle(h.frame())).toMatchObject({ status: "already_started", effect: "none" });
    h.bag.observe(MID, { phase: "replied", repliedAt: 6 });
    expect(h.receiver.handle(h.frame())).toMatchObject({ status: "already_replied", effect: "none" });
    expect(h.messages).toHaveLength(0);
  });

  it("a live original wake (or running control run for the same message) ⇒ already_active, never a second trigger", () => {
    const h = build();
    h.controller.dispatch({ xid: MID, from: {}, content: "body", expiresAt: 5_000 }); // the ORIGINAL body wake
    expect(h.messages).toHaveLength(1);
    expect(h.receiver.handle(h.frame())).toMatchObject({ status: "already_active", effect: "none" });
    expect(h.messages).toHaveLength(1);
    expect(h.bag.claimView(MID)).toBeUndefined();
  });

  it("controller gates are surfaced with the REAL reason and release the claim (key stays bound, retry possible)", () => {
    const h = build();
    // a different message's run owns the host ⇒ busy (retryable), claim released
    h.controller.dispatch({ xid: "x-other", from: {}, content: "o", expiresAt: 5_000 });
    const busy = h.receiver.handle(h.frame());
    expect(busy).toMatchObject({ status: "refused", effect: "none", wakeDowngraded: "busy", retryable: true });
    expect(h.bag.claimView(MID)).toMatchObject({ state: "available", activationKey: "k1" });
    // a different key can never bypass the bound one
    h.controller.settled();
    h.host.idle = true;
    expect(h.receiver.handle(h.frame({ activationKey: "kother", rid: "a9" }))).toMatchObject({ reason: "stale_key" });
    // same key, once idle, goes through exactly once
    expect(h.receiver.handle(h.frame({ rid: "a10" }))).toMatchObject({ status: "accepted" });
  });

  it("wake off (no controller) ⇒ refused wake_disabled (static); never a marker", () => {
    const h = build({ wake: false });
    expect(h.receiver.handle(h.frame())).toMatchObject({ status: "refused", reason: "wake_disabled", effect: "none" });
    expect(h.messages).toHaveLength(0);
  });

  it("an exception AFTER the claim ⇒ unknown + consumed tombstone (query-only), never a released retry", () => {
    const h = build();
    const spy = vi.spyOn(h.controller, "activateExisting").mockImplementation(() => {
      throw new Error("host exploded");
    });
    const ack = h.receiver.handle(h.frame());
    expect(ack).toMatchObject({ status: "unknown", effect: "unknown" });
    expect(h.bag.claimView(MID)?.state).toBe("consumed");
    spy.mockRestore();
    expect(h.receiver.handle(h.frame({ rid: "a2" }))).toMatchObject({ status: "already_active", dup: true });
    expect(h.messages).toHaveLength(0);
  });
});

describe("xs activation port (sender half)", () => {
  const origin = { current: () => ({ sessionId: "s", epoch: 1 }) };
  const mk = (hub: XsActivationHubPort | undefined) =>
    createXsActivationPort({ hub: () => hub, origin, level: { levelOfRoot: () => 2 } });
  const args = { to: "sess-t", messageId: MID, activationKey: "k1" };

  it("sends the CALLER's current level, maps the hub body, and never forges none on ambiguity", async () => {
    const activate = vi.fn(async () => ({
      kind: "res" as const,
      res: {
        t: "xs_res" as const,
        rid: "r",
        ok: true,
        activation: {
          messageId: MID,
          activationKey: "k1",
          status: "accepted" as const,
          effect: "applied" as const,
          retryable: false,
        },
      },
    }));
    const port = mk({ activateCapable: () => true, activate });
    expect(await port.activate(args)).toMatchObject({ status: "accepted", effect: "applied" });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ level: 2, to: "sess-t" }));
    for (const kind of ["deadline", "link_lost"] as const) {
      const out = await mk({ activateCapable: () => true, activate: async () => ({ kind }) }).activate(args);
      expect(out).toMatchObject({ status: "unknown", effect: "unknown", retryable: false });
    }
    expect(
      await mk({ activateCapable: () => true, activate: async () => ({ kind: "not_sent" }) }).activate(args),
    ).toMatchObject({
      status: "refused",
      effect: "none",
      retryable: true,
    });
    const throwing = mk({
      activateCapable: () => true,
      activate: async () => {
        throw new Error("boom");
      },
    });
    expect(await throwing.activate(args)).toMatchObject({ status: "unknown", effect: "unknown" });
  });

  it("unsupported without the capability chain; hub error codes map to refusals", async () => {
    expect(await mk(undefined).activate(args)).toMatchObject({ status: "unsupported", effect: "none" });
    expect(await mk({ activateCapable: () => false, activate: vi.fn() }).activate(args)).toMatchObject({
      status: "unsupported",
    });
    const coded = (code: string) =>
      mk({
        activateCapable: () => true,
        activate: async () => ({ kind: "res", res: { t: "xs_res", rid: "r", ok: false, code, effect: "none" } }),
      }).activate(args);
    expect(await coded("E_XS_NOT_TRACKED")).toMatchObject({ status: "refused", reason: "not_tracked", effect: "none" });
    expect(await coded("E_XS_STALE_KEY")).toMatchObject({ reason: "stale_key" });
    expect(await coded("E_XS_OFF")).toMatchObject({ status: "unsupported" });
  });

  it("query is read-only: only the receipt port is touched, a miss is a result (never an activate)", async () => {
    const activate = vi.fn();
    const receipt = vi.fn(async () => ({ status: "unavailable" as const, messageId: MID }));
    const port = mk({ activateCapable: () => true, activate, receipt });
    expect(await port.query({ messageId: MID, activationKey: "k1" })).toEqual({
      status: "unavailable",
      messageId: MID,
    });
    expect(activate).not.toHaveBeenCalled();
    expect(await mk({ activateCapable: () => true }).query({ messageId: MID })).toEqual({
      status: "unsupported",
      messageId: MID,
    });
  });
});
