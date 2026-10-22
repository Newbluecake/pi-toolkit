import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  XS_AGENT_CAPS,
  XS_EXPIRES_MS,
  XS_HUB_CAP,
  XS_HUB_DELIVER_MS,
  XS_LIST_MAX_ROWS,
  XS_MAX_FRAME_BYTES,
  XS_REPLY_AGENT_CAP,
  XS_REPLY_HUB_CAP,
  XS_REPLY_LATE_REASON,
  XS_REPLY_REQUEST_ID_RE,
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
    expect(XS_REQ_DEADLINE_MS).toEqual({
      list: 3_000,
      resolve: 3_000,
      info: 3_000,
      send: 8_000,
      broadcast: 8_000, // channel-plan §3.3 (CH0) — additive
      channels: 3_000,
    });
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

/** A plan-§3.1-shaped request id: `"q" + 18 hex` — not a secret, binding is elsewhere (§3.2). */
const QID = "q0123456789abcdef01";

describe("xs reply contract (reply-plan §5, RX0)", () => {
  it("xs_req carries the optional expect/replyTo and the pre-reply shapes still decode", () => {
    const withExpect: XsReqFrame = { ...req, to: SID2, expect: { requestId: QID, timeoutMs: 1_800_000 } };
    expect(decodeAgentFrame(withExpect)).toEqual(withExpect);
    const withReplyTo: XsReqFrame = { ...req, wake: undefined, level: undefined, replyTo: QID };
    expect(decodeAgentFrame(withReplyTo)).toEqual(withReplyTo);
    // the pre-reply constants (no new fields) decode byte-for-byte — the off goldens depend on it
    expect(decodeAgentFrame(req)).toEqual(req);
    expect(decodeAgentFrame(member)).toEqual(member);
    expect(decodeHubFrame(deliver)).toEqual(deliver);
    expect(decodeHubFrame(res)).toEqual(res);
    expect(decodeAgentFrame(ack)).toEqual(ack);
  });

  it("structural garbage in the new fields is rejected — additionalProperties never relaxed", () => {
    expect(decodeAgentFrame({ ...req, expect: { requestId: QID, timeoutMs: 1_800_000, extra: 1 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, expect: { requestId: QID } })).toBeUndefined(); // missing timeoutMs
    expect(decodeAgentFrame({ ...req, expect: { requestId: "", timeoutMs: 1 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, expect: { requestId: QID, timeoutMs: "soon" } })).toBeUndefined();
    // timeoutMs 0 rides the wire (policy range is the ROUTER's E_XS_BAD_FRAME, never a schema drop)
    expect(decodeAgentFrame({ ...req, expect: { requestId: QID, timeoutMs: 0 } })).toMatchObject({
      expect: { requestId: QID, timeoutMs: 0 },
    });
    expect(decodeAgentFrame({ ...req, expect: { requestId: QID, timeoutMs: -1 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, replyTo: 42 })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, replyTo: "" })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, replyTo: QID, unknownKey: true })).toBeUndefined(); // strict shape
    expect(decodeHubFrame({ ...deliver, reply: { requestId: QID, dueAt: 1, extra: true } })).toBeUndefined();
    expect(decodeHubFrame({ ...deliver, reply: { requestId: QID, dueAt: -1 } })).toBeUndefined();
    expect(decodeHubFrame({ ...deliver, reply: { requestId: QID } })).toBeUndefined(); // missing dueAt
    expect(decodeHubFrame({ ...deliver, inReplyTo: "" })).toBeUndefined();
    expect(decodeHubFrame({ ...deliver, inReplyTo: 7 })).toBeUndefined();
  });

  it("xs_deliver carries the optional reply stamp / inReplyTo; from.run stays rejected", () => {
    const withReply: XsDeliverFrame = {
      ...deliver,
      reply: { requestId: QID, dueAt: 1_769_001_800_000 },
    };
    expect(decodeHubFrame(withReply)).toEqual(withReply);
    const withInReplyTo: XsDeliverFrame = { ...deliver, inReplyTo: QID };
    expect(decodeHubFrame(withInReplyTo)).toEqual(withInReplyTo);
    expect(decodeHubFrame({ ...deliver, reply: { requestId: QID, dueAt: 0 } })).toMatchObject({
      reply: { requestId: QID, dueAt: 0 },
    });
    // the frozen phase-3 field is still rejected alongside the new optional fields
    expect(decodeHubFrame({ ...deliver, from: { ...deliver.from, run: "r_ABCDEFGH" } })).toBeUndefined();
  });

  it("xs_res.target may carry the optional sessionId backfill (open object, §5.2)", () => {
    const withSid: XsResFrame = { ...res, target: { ref: "01993f4e-6c9", sessionId: SID2 } };
    expect(decodeHubFrame(withSid)).toEqual(withSid);
    expect(decodeHubFrame({ ...res, target: { ref: "01993f4e-6c9" } })).toMatchObject({
      target: { ref: "01993f4e-6c9" },
    });
  });

  it("xs_member / xs_ack carry the replies vocabulary (XS_REPLY_LATE_REASON rides verbatim)", () => {
    expect(decodeAgentFrame({ ...member, receive: "replies" })).toMatchObject({ receive: "replies" });
    expect(decodeAgentFrame({ ...member, receive: "sometimes" })).toBeUndefined(); // still strict
    expect(decodeAgentFrame({ ...ack, effect: "applied", reason: XS_REPLY_LATE_REASON, woke: false })).toMatchObject({
      effect: "applied",
      reason: "reply_late",
    });
  });

  it("constants freeze the reply contract values", () => {
    expect(XS_REPLY_HUB_CAP).toBe("xs.reply.v1");
    expect(XS_REPLY_AGENT_CAP).toBe("xs.reply.v1");
    expect(XS_REPLY_LATE_REASON).toBe("reply_late");
    expect(XS_REPLY_REQUEST_ID_RE.test(QID)).toBe(true);
    expect(XS_REPLY_REQUEST_ID_RE.test("q0123456789abcdef0")).toBe(false); // 17 hex
    expect(XS_REPLY_REQUEST_ID_RE.test("q0123456789abcdef012")).toBe(false); // 19 hex
    expect(XS_REPLY_REQUEST_ID_RE.test("Q0123456789abcdef01")).toBe(false);
    expect(XS_REPLY_REQUEST_ID_RE.test("q0123456789ABCDEF01")).toBe(false); // lowercase hex only
    expect(XS_REPLY_REQUEST_ID_RE.test("r_ABCDEFGH")).toBe(false);
  });

  it("a reply-carrying worst-ish xs_req still fits the 16 KiB byte cap", () => {
    const worst: XsReqFrame = {
      ...req,
      to: "s".repeat(128),
      text: undefined,
      expect: { requestId: QID, timeoutMs: 86_400_000 },
      replyTo: QID,
    };
    expect(decodeAgentFrame(worst)).toEqual(worst);
    expect(JSON.stringify(worst).length).toBeLessThan(XS_MAX_FRAME_BYTES);
    expect(xsFrameBytesOk(worst)).toBe(true);
  });
});
