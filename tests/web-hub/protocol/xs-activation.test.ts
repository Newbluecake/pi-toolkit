import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import { XS_AGENT_CAPS, XS_REQ_DEADLINE_MS, xsReqDeadlineMs, XsReqSchema } from "../../../src/web-hub/protocol/xs.js";
import {
  XS_ACTIVATE_AGENT_CAP,
  XS_ACTIVATE_HUB_CAP,
  XS_ACTIVATE_RELAY_EXPIRY_MS,
  XS_ACTIVATE_REQ_DEADLINE_MS,
  XS_ACTIVATE_STATUSES,
  XS_EVIDENCES,
  XS_OBSERVATIONS,
  XS_PHASES,
  XS_RECEIPT_DEADLINE_MS,
  XS_REQUESTS_MAX_ROWS,
  XS_STATE_AGENT_CAP,
  XS_STATE_HUB_CAP,
  XS_TRACK_DEFAULT_MS,
  XsActivateAckSchema,
  XsActivateSchema,
  XsProgressSchema,
  XsRequestsStatusSchema,
  XsStateSchema,
  XsWakeViewSchema,
  xsTrackOpen,
  xsTrackUntilMs,
} from "../../../src/web-hub/protocol/xs-activation.js";
import * as legacy from "../../fixtures/legacy-xs-v071/src/web-hub/protocol/xs.js";

/**
 * fabric-xs-activation plan §3 P0 self-tests: the frozen activation wire contract — caps,
 * xs_req op/deadline mounts, the three new frame schemas (strict, both decode directions),
 * the StatusInfo.xsRequests slot bound, and the trackUntil pure helpers. P1/P3 own the routing.
 */

const SID = "01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a";
const SID2 = "01994410-3d3e-7ccf-8f1f-2b2c8d22b22b";
const origin = { sessionId: SID, epoch: 2 };

const wake = { requested: true, decision: "deliver_only" } as const;
const progress = {
  messageId: "x0000000000000000ab",
  revision: 3,
  deliveryEffect: "applied",
  phase: "delivered",
  deliveredAt: 1_769_000_000_000,
  observation: "live",
  wake,
};

describe("xs-activation P0: caps, ops and deadlines", () => {
  it("declares the two dual-surface caps with stable names", () => {
    expect(XS_STATE_HUB_CAP).toBe("xs.state.v1");
    expect(XS_STATE_AGENT_CAP).toBe("xs.state.v1");
    expect(XS_ACTIVATE_HUB_CAP).toBe("xs.activate.v1");
    expect(XS_ACTIVATE_AGENT_CAP).toBe("xs.activate.v1");
  });
  it("mounts the new xs_req ops and deadlines; the frozen legacy deadlines are untouched", () => {
    expect(XS_RECEIPT_DEADLINE_MS).toBe(3_000);
    expect(XS_ACTIVATE_REQ_DEADLINE_MS).toBe(8_000);
    expect(XS_ACTIVATE_RELAY_EXPIRY_MS).toBe(5_000);
    expect(XS_REQ_DEADLINE_MS.receipt).toBe(3_000);
    expect(XS_REQ_DEADLINE_MS.activate).toBe(8_000);
    expect(xsReqDeadlineMs("receipt")).toBe(3_000);
    expect(xsReqDeadlineMs("activate")).toBe(8_000);
    // the pre-activation ops keep their captured values (I10)
    for (const op of ["list", "resolve", "info", "send"] as const) {
      expect(XS_REQ_DEADLINE_MS[op]).toBe(legacy.XS_REQ_DEADLINE_MS[op]);
    }
    expect(Object.keys(XS_REQ_DEADLINE_MS).filter((k) => k !== "receipt" && k !== "activate")).toEqual([
      "list",
      "resolve",
      "info",
      "send",
      "broadcast",
      "channels",
      "alias",
    ]);
    // the appended entries are trailing — the key order of the frozen prefix is unchanged
    expect(Object.keys(XS_REQ_DEADLINE_MS).slice(0, -2)).toEqual([
      "list",
      "resolve",
      "info",
      "send",
      "broadcast",
      "channels",
      "alias",
    ]);
  });
  it("XS_AGENT_CAPS stays frozen (off goldens)", () => {
    expect(XS_AGENT_CAPS).toEqual(["xs.v1"]);
  });
});

describe("xs-activation P0: xs_req receipt/activate payload mounts", () => {
  const receipt = { t: "xs_req", rid: "r1", op: "receipt", origin, messageId: "x000000000000000001" };
  it("decodes the two new ops with their payload fields (agent→hub)", () => {
    expect(decodeAgentFrame(receipt)).toEqual(receipt);
    const activate = {
      t: "xs_req",
      rid: "r2",
      op: "activate",
      origin,
      to: SID2,
      messageId: "x000000000000000001",
      activationKey: "k000000000000000001",
      level: 1,
    };
    expect(decodeAgentFrame(activate)).toEqual(activate);
  });
  it("rejects malformed payload fields (silent drop)", () => {
    expect(decodeAgentFrame({ ...receipt, messageId: "" })).toBeUndefined();
    expect(decodeAgentFrame({ ...receipt, messageId: "x".repeat(65) })).toBeUndefined();
    expect(decodeAgentFrame({ ...receipt, activationKey: 7 })).toBeUndefined();
    expect(decodeAgentFrame({ ...receipt, bogus: 1 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "xs_req", rid: "r3", op: "wake", origin })).toBeUndefined();
  });
  it("a legacy decoder (v0.7.1 schema) rejects the new ops and fields — hence cap-gating (I10)", () => {
    expect(Value.Check(legacy.XsReqSchema, receipt)).toBe(false);
    expect(Value.Check(legacy.XsReqSchema, { ...receipt, op: "list", messageId: "x" })).toBe(false);
  });
  it("old frame shapes decode byte-identically on both the new and the legacy schema", () => {
    const old = { t: "xs_req", rid: "r4", op: "send", origin, to: SID2, text: "hi" };
    expect(Value.Check(XsReqSchema, old)).toBe(true);
    expect(Value.Check(legacy.XsReqSchema, old)).toBe(true);
    expect(decodeAgentFrame(old)).toEqual(old);
    // and the schema's property order keeps the frozen prefix (key-order pin)
    expect(Object.keys(XsReqSchema.properties).slice(0, -2)).toEqual([
      "t",
      "rid",
      "op",
      "origin",
      "query",
      "scope",
      "to",
      "text",
      "wake",
      "level",
      "expect",
      "channel",
      "replyTo",
      "alias",
      "clear",
      "take",
      "intent",
      "prevSessionId",
    ]);
  });
});

describe("xs-activation P0: xs_state (receiver→hub / hub→source)", () => {
  const state = { t: "xs_state", ...progress };
  it("decodes in BOTH directions (agent→hub and hub→source)", () => {
    expect(decodeAgentFrame(state)).toEqual(state);
    expect(decodeHubFrame(state)).toEqual(state);
  });
  it("hub→source may carry sourceRid; receiver-side frames never need it", () => {
    const mirrored = { ...state, sourceRid: "r9" };
    expect(decodeHubFrame(mirrored)).toEqual(mirrored);
    expect(decodeAgentFrame(mirrored)).toEqual(mirrored); // the agent map allows the field too (strict, same schema)
  });
  it("is strict and bounded", () => {
    expect(decodeAgentFrame({ ...state, bogus: 1 })).toBeUndefined();
    expect(decodeAgentFrame({ ...state, reason: "x".repeat(65) })).toBeUndefined();
    expect(decodeAgentFrame({ ...state, wake: { ...wake, reason: "x".repeat(49) } })).toBeUndefined();
    expect(decodeAgentFrame({ ...state, revision: -1 })).toBeUndefined();
    expect(decodeAgentFrame({ ...state, observation: "sideways" })).toBeUndefined();
    // the stricter 16 KiB xs_* byte cap applies (a >16 KiB frame drops before the schema)
    expect(decodeAgentFrame({ ...state, reason: "x".repeat(20_000) })).toBeUndefined();
    expect(Value.Check(XsStateSchema, { t: "xs_state", ...progress, text: "never" })).toBe(false);
  });
});

describe("xs-activation P0: xs_activate / xs_activate_ack", () => {
  const activate = {
    t: "xs_activate",
    rid: "ra1",
    to: { sessionId: SID2, epoch: 4 },
    from: { sessionId: SID, ref: "01993f4e-6c9", cwdLabel: "~/ai/pi-toolkit", agentId: "a".repeat(8) },
    messageId: "x0000000000000000cd",
    activationKey: "k0000000000000000cd",
    expiresAt: 1_769_000_005_000,
    level: 1,
  };
  const ack = {
    t: "xs_activate_ack",
    rid: "ra1",
    messageId: "x0000000000000000cd",
    activationKey: "k0000000000000000cd",
    status: "refused",
    effect: "none",
    retryable: true,
    retryAfterAt: 1_769_000_600_000,
    wakeDowngraded: "pair_wake_rate",
  };
  it("decodes on the correct directions only (hub→agent relay, agent→hub ack)", () => {
    expect(decodeHubFrame(activate)).toEqual(activate);
    expect(decodeAgentFrame(ack)).toEqual(ack);
    expect(decodeAgentFrame(activate)).toBeUndefined(); // the agent never sends the relay
    expect(decodeHubFrame(ack)).toBeUndefined(); // the hub never sends the ack
  });
  it("the relay schema has NO text field at all (U6: activate never re-sends the body)", () => {
    expect("text" in XsActivateSchema.properties).toBe(false);
    expect(Value.Check(XsActivateSchema, { ...activate, text: "hi" })).toBe(false);
  });
  it("the ack may carry dup and a progress snapshot; the status set is the closed arch §4.4 enum", () => {
    const withProgress = { ...ack, status: "accepted", effect: "applied", retryable: false, dup: true, progress };
    expect(decodeAgentFrame(withProgress)).toEqual(withProgress);
    expect([...XS_ACTIVATE_STATUSES]).toEqual([
      "accepted",
      "already_active",
      "already_started",
      "already_replied",
      "refused",
      "unknown",
      "unsupported",
    ]);
    expect(decodeAgentFrame({ ...ack, status: "nope" })).toBeUndefined();
  });
  it("rejects malformed control frames (strict)", () => {
    expect(decodeHubFrame({ ...activate, expiresAt: -1 })).toBeUndefined();
    expect(decodeHubFrame({ ...activate, level: 32 })).toBeUndefined();
    expect(decodeHubFrame({ ...activate, from: { ...activate.from, sessionId: "" } })).toBeUndefined();
    expect(decodeAgentFrame({ ...ack, retryable: "yes" })).toBeUndefined();
    expect(decodeAgentFrame({ ...ack, effect: "maybe" })).toBeUndefined();
  });
});

describe("xs-activation P0: progress vocabulary", () => {
  it("declares the four phases, the evidence triple and the observation set (U1/arch §4.1)", () => {
    expect([...XS_PHASES]).toEqual(["queued", "delivered", "started", "replied"]);
    expect([...XS_EVIDENCES]).toEqual(["none", "unknown", "applied"]);
    expect([...XS_OBSERVATIONS]).toEqual(["live", "offline", "expired", "unavailable"]);
  });
  it("the wake view is strict and its decision/ended sets are closed", () => {
    expect(Value.Check(XsWakeViewSchema, { requested: false, decision: "deliver_only" })).toBe(true);
    expect(
      Value.Check(XsWakeViewSchema, {
        requested: true,
        decision: "dispatch_accepted",
        stage: "hub",
        ended: "aborted",
        authorizedAt: 5,
        retryAfterAt: 9,
        defaulted: true,
        reason: "busy",
      }),
    ).toBe(true);
    for (const bad of [
      { decision: "woke" },
      { requested: true },
      { requested: true, decision: "downgraded", stage: "peer" },
      { requested: true, decision: "downgraded", ended: "expired" },
      { requested: true, decision: "downgraded", reason: "x".repeat(49) },
      { requested: true, decision: "downgraded", authorizedAt: -1 },
    ]) {
      expect(Value.Check(XsWakeViewSchema, bad)).toBe(false);
    }
  });
  it("a progress snapshot validates with every optional axis field present", () => {
    const full = {
      messageId: "x0000000000000000ef",
      revision: 0,
      deliveryEffect: "unknown",
      phase: "replied",
      queuedAt: 1,
      deliveredAt: 2,
      startedAt: 3,
      repliedAt: 4,
      requestId: "q0011be4d8364f39be6",
      replyState: "pending",
      observation: "offline",
      reason: "queued",
      wake: { requested: true, defaulted: true, stage: "sender", decision: "downgraded", reason: "level_limit" },
      activationKey: "k0000000000000000ef",
      activationUntil: 5,
      entryId: "e0000000000000000ef",
    };
    expect(Value.Check(XsProgressSchema, full)).toBe(true);
  });
});

describe("xs-activation P0: StatusInfo.xsRequests slot", () => {
  const base = { t: "status", leafId: null, busy: false, pending: false };
  it("a status frame carrying the slot decodes; the slot stays bounded (≤ XS_REQUESTS_MAX_ROWS)", () => {
    const body = { sessionId: SID, revision: 2, rows: [progress] };
    const frame = { ...base, xsRequests: body };
    expect(decodeAgentFrame(frame)).toEqual(frame); // status rides the agent→hub direction
    expect(XS_REQUESTS_MAX_ROWS).toBe(256);
    const tooMany = {
      sessionId: SID,
      revision: 2,
      rows: Array.from({ length: XS_REQUESTS_MAX_ROWS + 1 }, () => progress),
    };
    expect(Value.Check(XsRequestsStatusSchema, tooMany)).toBe(false);
    expect(decodeAgentFrame({ ...base, xsRequests: tooMany })).toBeUndefined(); // bounded ⇒ the whole frame drops, xsInbox posture
    expect(Value.Check(XsRequestsStatusSchema, { sessionId: SID, revision: 2, rows: [], omitted: 3 })).toBe(true);
    expect(Value.Check(XsRequestsStatusSchema, { sessionId: SID, rows: [] })).toBe(false); // revision required
    expect(Value.Check(XsRequestsStatusSchema, { sessionId: "", revision: 0, rows: [] })).toBe(false);
  });
  it("a status frame WITHOUT the slot still decodes (off ⇒ byte-equal posture)", () => {
    expect(decodeAgentFrame(base)).toEqual(base);
  });
});

describe("xs-activation P0: trackUntil pure helpers (arch §4.5)", () => {
  const reply = { replyMaxTimeoutMs: 86_400_000, replyLateGraceMs: 600_000 };
  it("plain tracking = createdAt + 30 min", () => {
    expect(XS_TRACK_DEFAULT_MS).toBe(30 * 60_000);
    expect(xsTrackUntilMs({ createdAt: 1_000, ...reply })).toBe(1_000 + 30 * 60_000);
  });
  it("expect tracking = createdAt + timeoutMs + lateGraceMs, ceilinged along maxTimeout + lateGrace", () => {
    expect(xsTrackUntilMs({ createdAt: 1_000, expect: { timeoutMs: 60_000, lateGraceMs: 10_000 }, ...reply })).toBe(
      1_000 + 70_000,
    );
    // an over-ceiling ticket clamps to reply.maxTimeoutS + lateGraceS
    expect(
      xsTrackUntilMs({ createdAt: 1_000, expect: { timeoutMs: 90_000_000, lateGraceMs: 600_000 }, ...reply }),
    ).toBe(1_000 + 86_400_000 + 600_000);
  });
  it("lateGraceMs = 0 is a LEGAL grace — the ceiling stays replyMaxTimeoutMs + 0, never Infinity (P0 regression)", () => {
    // ceiling computation: only replyMaxTimeoutMs must be > 0; grace 0 clamps, not uncaps
    expect(
      xsTrackUntilMs({
        createdAt: 1_000,
        expect: { timeoutMs: 90_000_000, lateGraceMs: 600_000 },
        replyMaxTimeoutMs: 86_400_000,
        replyLateGraceMs: 0,
      }),
    ).toBe(1_000 + 86_400_000);
    // plain window is also ceilinged when the ticket span exceeds a grace-0 ceiling
    expect(xsTrackUntilMs({ createdAt: 1_000, replyMaxTimeoutMs: 60_000, replyLateGraceMs: 0 })).toBe(1_000 + 60_000);
  });
  it("malformed inputs never yield NaN — they fall back to the plain window / an uncapped ceiling", () => {
    expect(xsTrackUntilMs({ createdAt: 1_000, expect: { timeoutMs: Number.NaN, lateGraceMs: 0 }, ...reply })).toBe(
      1_000 + 30 * 60_000,
    );
    expect(
      xsTrackUntilMs({
        createdAt: 1_000,
        expect: { timeoutMs: 60_000, lateGraceMs: 10_000 },
        replyMaxTimeoutMs: 0,
        replyLateGraceMs: -1,
      }),
    ).toBe(1_000 + 70_000);
    expect(xsTrackUntilMs({ createdAt: -5, ...reply })).toBe(30 * 60_000);
  });
  it("expiry: an expired packet is refused first — a later now closes the window", () => {
    const until = xsTrackUntilMs({ createdAt: 0, ...reply });
    expect(xsTrackOpen(until, until - 1)).toBe(true);
    expect(xsTrackOpen(until, until)).toBe(false); // expiry at exactly trackUntil
    // total under a NaN clock: no evidence of expiry ⇒ still open (never fabricates expiry)
    expect(xsTrackOpen(until, Number.NaN)).toBe(true);
  });
});
