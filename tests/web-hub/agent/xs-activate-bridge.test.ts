import { describe, expect, it, vi } from "vitest";
import { createXsAgentBridge, type XsAgentPort } from "../../../src/web-hub/agent/xs.js";
import type { HubConnection } from "../../../src/web-hub/agent/connection.js";
import type { XsActivateFrame } from "../../../src/web-hub/protocol/xs-activation.js";

/** fabric-xs-activation P3: the bridge's activate cap, inertness, and exactly-one-ack contract. */
const frame: XsActivateFrame = {
  t: "xs_activate",
  rid: "a1",
  to: { sessionId: "s", epoch: 1 },
  from: { sessionId: "src", ref: "src", cwdLabel: "~", agentId: "ag" },
  messageId: "m1",
  activationKey: "k1",
  expiresAt: 9e12,
};
const basePort = (over: Partial<XsAgentPort> = {}): XsAgentPort => ({
  stack: () => undefined,
  memberLimits: () => ({}) as never,
  hubSendsPerMin: () => 60,
  ...over,
});
const conn = (caps: string[], state = "live") => {
  const sent: unknown[] = [];
  const request = vi.fn(async () => ({ t: "xs_res", rid: "r", ok: true }));
  return {
    sent,
    request,
    c: {
      caps,
      status: () => ({ state }),
      send: (f: unknown) => sent.push(f),
      request,
    } as unknown as HubConnection,
  };
};

describe("xs bridge activation (P3)", () => {
  it("declares xs.activate.v1 only when activation effective ∧ activateEnabled; the state cap stays independent", () => {
    const mk = (port: Partial<XsAgentPort>) =>
      createXsAgentBridge({ conn: () => undefined, port: basePort(port) }).caps();
    expect(mk({})).not.toContain("xs.activate.v1");
    expect(mk({ activationEnabled: () => true })).toContain("xs.state.v1");
    expect(mk({ activationEnabled: () => true })).not.toContain("xs.activate.v1");
    expect(mk({ activateEnabled: () => true })).not.toContain("xs.activate.v1"); // needs activation effective too
    expect(mk({ activationEnabled: () => true, activateEnabled: () => true })).toContain("xs.activate.v1");
  });

  it("onActivate is inert (no ack, no stack call) unless enabled; enabled with no stack ⇒ exactly one refused ack", () => {
    const off = conn(["xs.state.v1", "xs.activate.v1"]);
    createXsAgentBridge({ conn: () => off.c, port: basePort({ activationEnabled: () => true }) }).onActivate(frame);
    expect(off.sent).toEqual([]);
    const on = conn(["xs.state.v1", "xs.activate.v1"]);
    createXsAgentBridge({
      conn: () => on.c,
      port: basePort({ activationEnabled: () => true, activateEnabled: () => true }),
    }).onActivate(frame);
    expect(on.sent).toHaveLength(1);
    expect(on.sent[0]).toMatchObject({
      t: "xs_activate_ack",
      rid: "a1",
      status: "refused",
      effect: "none",
      retryable: false,
    });
  });

  it("a throwing receiver half still yields ONE refused none ack (receiver_error), never silence", () => {
    const c = conn(["xs.state.v1", "xs.activate.v1"]);
    const stack = {
      sessionId: () => "s",
      activation: {
        handle: () => {
          throw new Error("x");
        },
      },
    } as never;
    createXsAgentBridge({
      conn: () => c.c,
      port: basePort({ stack: () => stack, activationEnabled: () => true, activateEnabled: () => true }),
    }).onActivate(frame);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ status: "refused", reason: "receiver_error" });
  });

  it("hubPort.activate: no link ⇒ not_sent (provably none); live link lacking the hub cap ⇒ off with NOTHING sent", async () => {
    const enabled = basePort({ activationEnabled: () => true, activateEnabled: () => true });
    const none = createXsAgentBridge({ conn: () => undefined, port: enabled }).hubPort();
    const args = { origin: { sessionId: "s", epoch: 1 }, to: "t", messageId: "m", activationKey: "k" };
    expect(await none.activate!(args)).toEqual({ kind: "not_sent" });
    const old = conn(["xs.v1", "xs.state.v1"]); // hub never declared xs.activate.v1
    const bridge = createXsAgentBridge({ conn: () => old.c, port: enabled });
    expect(bridge.hubPort().activateCapable!()).toBe(false);
    expect(await bridge.hubPort().activate!(args)).toEqual({ kind: "off" });
    expect(old.request).not.toHaveBeenCalled();
    const disabled = createXsAgentBridge({ conn: () => old.c, port: basePort({ activationEnabled: () => true }) });
    expect(await disabled.hubPort().activate!(args)).toEqual({ kind: "not_sent" });
  });
});
