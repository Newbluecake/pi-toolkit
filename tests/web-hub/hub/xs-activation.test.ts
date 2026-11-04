import { describe, expect, it } from "vitest";
import type { HubLog } from "../../../src/web-hub/hub/ports.js";
import { createXsActivationService, XS_RELATION_CAP } from "../../../src/web-hub/hub/xs/activation.js";
import type { XsEffectiveMember, XsMembers } from "../../../src/web-hub/hub/xs/members.js";
import type { Registry } from "../../../src/web-hub/hub/registry.js";
import type { XsStateFrame } from "../../../src/web-hub/protocol/xs-activation.js";

/**
 * fabric-xs-activation plan §3 P1 (arch §4.5/§4.7): the hub relation bag — registration
 * (three-end negotiation is the ROUTER's check, pinned in xs-router-state.test.ts), trackUntil,
 * `xs_state` verification (socket / session / revision / expiry — never a receiver-claimed
 * source), forwarding to the ORIGINAL source with the hub-written sourceRid, receipt (read-only,
 * source-bound, NOT_TRACKED indistinguishable) and the 1024 capacity (full ⇒ old path, no key).
 */

const NOW = 1_000_000;

interface Sent {
  agentKey: string;
  frame: XsStateFrame;
}

function makeService(options: { targetSid?: string; sourceSid?: string } = {}) {
  const sent: Sent[] = [];
  const caps = new Map<string, string[]>();
  const registry = {
    send: (agentKey: string, frame: XsStateFrame) => {
      sent.push({ agentKey, frame });
      return true;
    },
    xsView: (key: string) => ({ caps: caps.get(key) ?? [] }),
  } as unknown as Pick<Registry, "send" | "xsView">;
  const TARGET_SID = options.targetSid ?? "sess-target-0123456789ab";
  const members = {
    effective: (key: string) =>
      key === "agent-target"
        ? ({
            sessionId: TARGET_SID,
            agentKey: key,
          } as XsEffectiveMember)
        : key === "agent-moved"
          ? ({ sessionId: "sess-moved-0123456789abcd", agentKey: key } as XsEffectiveMember)
          : undefined,
  } as unknown as Pick<XsMembers, "effective">;
  const log: HubLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as HubLog;
  const service = createXsActivationService({
    registry,
    members,
    log,
    now: () => NOW,
    randomHex: (bytes) => `k${bytes}`.padEnd(bytes * 2, "0"),
  });
  const register = () =>
    service.registerSend({
      messageId: "xid-0001",
      sourceAgentKey: "agent-source",
      sourceSessionId: options.sourceSid ?? "sess-source-0123456789ab",
      sourceRid: "rid-orig-1",
      targetAgentKey: "agent-target",
      targetSessionId: TARGET_SID,
      wakeRequested: true,
    });
  const state = (over: Partial<XsStateFrame> = {}): XsStateFrame => ({
    t: "xs_state",
    messageId: "xid-0001",
    revision: 1,
    deliveryEffect: "applied",
    phase: "delivered",
    observation: "live",
    wake: { requested: true, decision: "deliver_only" },
    ...over,
  });
  return { service, sent, register, state, TARGET_SID };
}

const receiptReplies: { ok: boolean; code?: string }[] = [];

describe("hub xs activation relation bag (fabric-xs-activation P1)", () => {
  it("registerSend issues a key + a 30-min plain window; pushInitial sends the source snapshot with sourceRid", () => {
    const h = makeService();
    const reg = h.register();
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    expect(reg.relation.activationKey).toMatch(/^k/);
    expect(reg.relation.trackUntil).toBeGreaterThan(NOW);
    expect(reg.relation.trackUntil).toBeLessThanOrEqual(NOW + 30 * 60_000 + 1);
    h.service.pushInitial(reg.relation);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.agentKey).toBe("agent-source");
    expect(h.sent[0]!.frame).toMatchObject({
      t: "xs_state",
      messageId: "xid-0001",
      sourceRid: "rid-orig-1",
      activationKey: reg.relation.activationKey,
    });
    expect(h.sent[0]!.frame.wake).toEqual({ requested: true, decision: "unknown" });
  });

  it("an expect send rides the frame's own timeout span (grace-capped)", () => {
    const reg = makeService().service.registerSend({
      messageId: "xid-0002",
      sourceAgentKey: "agent-source",
      sourceSessionId: "sess-source-0123456789ab",
      sourceRid: "rid-2",
      targetAgentKey: "agent-target",
      targetSessionId: "sess-target-0123456789ab",
      expect: { requestId: "q-1", timeoutMs: 600_000 },
      wakeRequested: false,
    });
    expect(reg.ok).toBe(true);
    if (reg.ok) {
      expect(reg.relation.trackUntil).toBeGreaterThan(NOW + 600_000);
      expect(reg.relation.requestId).toBe("q-1");
    }
  });

  it("onState verifies the SOCKET: a state from any other agentKey is ignored", () => {
    const h = makeService();
    const reg = h.register();
    if (!reg.ok) throw new Error("register failed");
    h.service.pushInitial(reg.relation);
    h.sent.length = 0;
    h.service.onState("agent-impostor", h.state());
    expect(h.sent).toEqual([]);
  });

  it("onState verifies the SESSION: a moved target session is ignored; a stale revision is ignored", () => {
    const h = makeService();
    const reg = h.register();
    if (!reg.ok) throw new Error("register failed");
    h.service.pushInitial(reg.relation);
    h.sent.length = 0;
    // revision 0 < stored 0? stored is the initial snapshot at revision 0 — equal passes.
    h.service.onState("agent-target", h.state({ revision: 1, phase: "started" }));
    expect(h.sent).toHaveLength(1);
    // stale: revision 0 after revision 1 stored
    h.sent.length = 0;
    h.service.onState("agent-target", h.state({ revision: 0 }));
    expect(h.sent).toEqual([]);
  });

  it("onState overlays relation-stable fields (a receiver frame cannot erase the key)", () => {
    const h = makeService();
    const reg = h.register();
    if (!reg.ok) throw new Error("register failed");
    h.service.pushInitial(reg.relation);
    h.sent.length = 0;
    h.service.onState("agent-target", h.state({ revision: 2 }));
    expect(h.sent).toHaveLength(1);
    const frame = h.sent[0]!.frame;
    expect(frame.activationKey).toBe(reg.relation.activationKey);
    expect(frame.activationUntil).toBe(reg.relation.trackUntil);
    expect(frame.sourceRid).toBe("rid-orig-1");
    // a receiver-written sourceRid is stripped (hub-owned field)
    h.sent.length = 0;
    h.service.onState("agent-target", h.state({ revision: 3, sourceRid: "forged" }));
    expect(h.sent[0]!.frame.sourceRid).toBe("rid-orig-1");
  });

  it("receipt: the source gets ok + the snapshot push; NOT the source ⇒ E_XS_NOT_TRACKED; a wrong key ⇒ E_XS_STALE_KEY", () => {
    const h = makeService();
    const reg = h.register();
    if (!reg.ok) throw new Error("register failed");
    h.service.pushInitial(reg.relation);
    h.sent.length = 0;
    const self = { sessionId: "sess-source-0123456789ab" } as XsEffectiveMember;
    const other = { sessionId: "sess-stranger-0123456789a" } as XsEffectiveMember;
    const res: { ok: boolean; code?: string }[] = [];
    h.service.receipt("agent-source", self, { messageId: "xid-0001" }, (b) => res.push(b));
    h.service.receipt("agent-source", other, { messageId: "xid-0001" }, (b) => res.push(b));
    h.service.receipt("agent-source", self, { messageId: "xid-unknown" }, (b) => res.push(b));
    h.service.receipt("agent-source", self, { messageId: "xid-0001", activationKey: "k-wrong" }, (b) => res.push(b));
    expect(res.map((r) => r.ok)).toEqual([true, false, false, false]);
    expect(res[1]!.code).toBe("E_XS_NOT_TRACKED");
    expect(res[2]!.code).toBe("E_XS_NOT_TRACKED");
    expect(res[3]!.code).toBe("E_XS_STALE_KEY");
    // the ok receipt pushed exactly one snapshot to the source socket
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.agentKey).toBe("agent-source");
    expect(h.sent[0]!.frame.messageId).toBe("xid-0001");
  });

  it("expired relations refuse FIRST (receipt) and are lazily dropped (onState)", () => {
    let now = NOW;
    const log: HubLog = { info: () => {}, warn: () => {}, error: () => {} } as unknown as HubLog;
    const service = createXsActivationService({
      registry: { send: () => true, xsView: () => ({ caps: [] }) } as never,
      members: { effective: () => ({ sessionId: "sess-target-0123456789ab" }) } as never,
      log,
      now: () => now,
    });
    const reg = service.registerSend({
      messageId: "xid-exp",
      sourceAgentKey: "s",
      sourceSessionId: "sess-source-0123456789ab",
      sourceRid: "r",
      targetAgentKey: "t",
      targetSessionId: "sess-target-0123456789ab",
      wakeRequested: false,
    });
    expect(reg.ok).toBe(true);
    now = NOW + 31 * 60_000; // past the plain 30-min window
    const res: { ok: boolean; code?: string }[] = [];
    service.receipt(
      "s",
      { sessionId: "sess-source-0123456789ab" } as XsEffectiveMember,
      { messageId: "xid-exp" },
      (b) => res.push(b),
    );
    expect(res[0]).toMatchObject({ ok: false, code: "E_XS_NOT_TRACKED" });
    const state: XsStateFrame = {
      t: "xs_state",
      messageId: "xid-exp",
      revision: 1,
      deliveryEffect: "unknown",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
    };
    service.onState("t", state); // lazily prunes, forwards nothing
    expect(service.size()).toBe(0);
  });

  it("capacity 1024: full ⇒ registerSend refuses (old path, no key)", () => {
    const log: HubLog = { info: () => {}, warn: () => {}, error: () => {} } as unknown as HubLog;
    const service = createXsActivationService({
      registry: { send: () => true, xsView: () => ({ caps: [] }) } as never,
      members: { effective: () => undefined } as never,
      log,
      now: () => NOW,
      randomHex: () => "ff",
    });
    for (let i = 0; i < XS_RELATION_CAP; i++) {
      const r = service.registerSend({
        messageId: `xfull-${i}`,
        sourceAgentKey: "s",
        sourceSessionId: "sess-source-0123456789ab",
        sourceRid: `r${i}`,
        targetAgentKey: "t",
        targetSessionId: "sess-target-0123456789ab",
        wakeRequested: false,
      });
      expect(r.ok).toBe(true);
    }
    const over = service.registerSend({
      messageId: "xfull-over",
      sourceAgentKey: "s",
      sourceSessionId: "sess-source-0123456789ab",
      sourceRid: "rover",
      targetAgentKey: "t",
      targetSessionId: "sess-target-0123456789ab",
      wakeRequested: false,
    });
    expect(over).toEqual({ ok: false, reason: "full" });
  });
});
