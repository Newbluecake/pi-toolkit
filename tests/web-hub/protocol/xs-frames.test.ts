import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  XS_AGENT_CAPS,
  XS_EXPIRES_MS,
  XS_HUB_CAP,
  XS_HUB_DELIVER_MS,
  XS_LIST_MAX_ROWS,
  XS_MAX_FRAME_BYTES,
  XS_REQ_DEADLINE_MS,
  XS_RESOLVE_MAX_CANDIDATES,
  XS_RESOLVE_PREFIX_MIN,
  xsFrameBytesOk,
  xsReqDeadlineMs,
  type XsAckFrame,
  type XsDeliverFrame,
  type XsMemberFrame,
  type XsReqFrame,
  type XsResFrame,
} from "../../../src/web-hub/protocol/xs.js";

/**
 * fabric phase-2 XS0 (phase2-plan §8.1/§8.2, §11.2 anchor): every xs frame decodes when valid
 * and is silently dropped when invalid — including the stricter 16 KiB xs byte cap and the
 * phase-3-only `from.run` field (rejected this phase, §4.2).
 */

const SID = "01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a";
const SID2 = "01994410-3d3e-7ccf-8f1f-2b2c8d22b22b";

const member: XsMemberFrame = {
  t: "xs_member",
  sessionId: SID,
  epoch: 3,
  joined: true,
  receive: "wake",
  limits: {
    sendsOutPerMin: 10,
    sendsOutPerHour: 60,
    wakesOutPerHour: 6,
    pairMinIntervalMs: 30_000,
    pairWakesPerHour: 2,
    inFlightPerSession: 4,
    listPerMin: 6,
  },
};

const req: XsReqFrame = {
  t: "xs_req",
  rid: "rid-1",
  op: "send",
  origin: { sessionId: SID, epoch: 3 },
  to: SID2,
  text: "hello",
  wake: true,
  level: 1,
};

const ack: XsAckFrame = {
  t: "xs_ack",
  rid: "rid-9",
  xid: "xid-1",
  effect: "applied",
  woke: true,
};

const res: XsResFrame = {
  t: "xs_res",
  rid: "rid-1",
  ok: true,
  effect: "applied",
};

const deliver: XsDeliverFrame = {
  t: "xs_deliver",
  rid: "rid-9",
  xid: "xid-1",
  to: { sessionId: SID2, epoch: 7 },
  from: { sessionId: SID, ref: "01993f4e-6c9", cwdLabel: "~/ai/pi-toolkit", agentId: "pid:1/nonce" },
  text: "hello",
  wake: true,
  level: 1,
  expiresAt: 1_769_000_005_000,
};

describe("xs frame decoding (XS0 §8.2)", () => {
  it("decodes every valid frame on its own direction and rejects it on the other", () => {
    expect(decodeAgentFrame(member)).toEqual(member);
    expect(decodeAgentFrame(req)).toEqual(req);
    expect(decodeAgentFrame(ack)).toEqual(ack);
    expect(decodeHubFrame(res)).toEqual(res);
    expect(decodeHubFrame(deliver)).toEqual(deliver);
    // direction discipline: agent frames are not hub frames and vice versa
    expect(decodeHubFrame(member)).toBeUndefined();
    expect(decodeHubFrame(ack)).toBeUndefined();
    expect(decodeAgentFrame(res)).toBeUndefined();
    expect(decodeAgentFrame(deliver)).toBeUndefined();
  });

  it("xs_req accepts every op with its optional fields and rejects malformed ones", () => {
    for (const op of ["list", "resolve", "send", "info"] as const) {
      const frame: XsReqFrame = { ...req, op, to: undefined, text: undefined, wake: undefined, level: undefined };
      expect(decodeAgentFrame(frame)).toEqual(frame);
    }
    // scope rides list only per contract, but the wire stays permissive-op (the hub router owns
    // op-specific validation, X1); the frame-level rejects below are structural:
    expect(decodeAgentFrame({ ...req, op: "list", scope: "cwd", query: "pi-toolkit" })).toMatchObject({
      op: "list",
      scope: "cwd",
    });
    expect(decodeAgentFrame({ ...req, op: "destroy" })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, wake: "yes" })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, level: -1 })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, level: 99 })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, origin: { sessionId: SID } })).toBeUndefined(); // missing epoch
    expect(decodeAgentFrame({ ...req, origin: { sessionId: SID, epoch: 3, extra: 1 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, unknownKey: true })).toBeUndefined(); // strict shape
    expect(decodeAgentFrame({ ...req, rid: "" })).toBeUndefined();
  });

  it("xs_member rejects unknown receive values, bad epochs and extra identity fields", () => {
    expect(decodeAgentFrame({ ...member, receive: "sometimes" })).toBeUndefined();
    expect(decodeAgentFrame({ ...member, epoch: -1 })).toBeUndefined();
    expect(decodeAgentFrame({ ...member, joined: "yes" })).toBeUndefined();
    expect(decodeAgentFrame({ ...member, agentId: "pid:1" })).toBeUndefined(); // identity is NOT here
    expect(decodeAgentFrame({ ...member, limits: { ...member.limits, sendsOutPerMin: 0 } })).toBeUndefined();
    // the schema bounds ARE the hub's clamping bounds (§4.6): out-of-schema limits are invalid
    expect(decodeAgentFrame({ ...member, limits: { ...member.limits, inboxCap: 12 } })).toBeUndefined();
  });

  it("xs_deliver rejects a from.run field (phase-3 only, §4.2) and every other extra identity", () => {
    expect(decodeHubFrame({ ...deliver, from: { ...deliver.from, run: "r_ABCDEFGH" } })).toBeUndefined();
    expect(decodeHubFrame({ ...deliver, from: { ...deliver.from, label: "worker" } })).toBeUndefined();
    expect(decodeHubFrame({ ...deliver, wake: undefined })).toBeUndefined(); // wake is required
    expect(decodeHubFrame({ ...deliver, expiresAt: -1 })).toBeUndefined();
    expect(decodeHubFrame({ ...deliver, text: 42 })).toBeUndefined();
  });

  it("xs_ack / xs_res accept the full reason surface and reject malformed effects", () => {
    // r3 M2: receiver_error exists on BOTH sides of the send/dispatch split
    expect(decodeAgentFrame({ ...ack, effect: "none", reason: "receiver_error" })).toMatchObject({
      effect: "none",
      reason: "receiver_error",
    });
    expect(decodeAgentFrame({ ...ack, effect: "unknown", reason: "receiver_error", woke: false })).toMatchObject({
      effect: "unknown",
    });
    expect(decodeAgentFrame({ ...ack, effect: "unknown", reason: "origin_changed_after_send" })).toMatchObject({
      reason: "origin_changed_after_send",
    });
    // r3 B1 / N1 downgrade tokens ride both reply shapes verbatim
    for (const d of ["ledger_full", "host_unverified", "busy"] as const) {
      expect(decodeAgentFrame({ ...ack, effect: "none", wakeDowngraded: d })).toMatchObject({ wakeDowngraded: d });
      expect(decodeHubFrame({ ...res, ok: false, code: "E_XS_STALE_ORIGIN", wakeDowngraded: d })).toMatchObject({
        wakeDowngraded: d,
      });
    }
    expect(decodeAgentFrame({ ...ack, effect: "maybe" })).toBeUndefined();
    expect(decodeHubFrame({ ...res, ok: "true" })).toBeUndefined();
    expect(decodeHubFrame({ ...res, code: "E_XS_OFF{hub}" })).toMatchObject({ code: "E_XS_OFF{hub}" });
  });

  it("the 16 KiB xs byte cap rejects oversize frames while the global budget would still pass", () => {
    // schema-permissive text (maxLength 16 384) means an oversize send is rejected by the
    // xs BYTE cap in decodeWith — not silently dropped by a schema bound:
    const big: XsReqFrame = { ...req, op: "send", text: "x".repeat(16_400) };
    expect(JSON.stringify(big).length).toBeGreaterThan(XS_MAX_FRAME_BYTES);
    expect(decodeAgentFrame(big)).toBeUndefined();
    const bigDeliver: XsDeliverFrame = { ...deliver, text: "x".repeat(16_400) };
    expect(decodeHubFrame(bigDeliver)).toBeUndefined();
    // just under the cap still decodes
    const okFrame: XsReqFrame = { ...req, op: "send", text: "x".repeat(15_500) };
    expect(JSON.stringify(okFrame).length).toBeGreaterThan(15_000);
    expect(JSON.stringify(okFrame).length).toBeLessThan(XS_MAX_FRAME_BYTES);
    expect(decodeAgentFrame(okFrame)).toEqual(okFrame);
    expect(xsFrameBytesOk(big)).toBe(false);
    expect(xsFrameBytesOk(okFrame)).toBe(true);
  });

  it("constants freeze the §8.2 contract values", () => {
    expect(XS_HUB_CAP).toBe("xs.v1");
    expect(XS_AGENT_CAPS).toEqual(["xs.v1"]);
    expect(XS_EXPIRES_MS).toBe(5_000);
    expect(XS_HUB_DELIVER_MS).toBe(5_000);
    expect(XS_REQ_DEADLINE_MS).toEqual({ list: 3_000, resolve: 3_000, info: 3_000, send: 8_000 });
    expect(xsReqDeadlineMs("send")).toBe(8_000);
    expect(xsReqDeadlineMs("list")).toBe(3_000);
    expect(XS_MAX_FRAME_BYTES).toBe(16 * 1024);
    expect(XS_LIST_MAX_ROWS).toBe(20);
    expect(XS_RESOLVE_PREFIX_MIN).toBe(8);
    expect(XS_RESOLVE_MAX_CANDIDATES).toBe(5);
  });

  it("xid-level frames never decode with unknown t values (silent-ignore posture, §8.5)", () => {
    expect(decodeAgentFrame({ ...member, t: "xs_member_x" })).toBeUndefined();
    expect(decodeHubFrame({ ...deliver, t: "xs_push" })).toBeUndefined();
    expect(decodeAgentFrame("xs_req")).toBeUndefined();
    expect(decodeHubFrame(null)).toBeUndefined();
  });
});
