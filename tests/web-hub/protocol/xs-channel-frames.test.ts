import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  XS_AGENT_CAPS,
  XS_BROADCAST_WAKES_PER_HOUR_HARD_MAX,
  XS_BROADCAST_WAKE_RECIPIENTS_HARD_MAX,
  XS_CHANNEL_AGENT_CAP,
  XS_CHANNEL_HUB_CAP,
  XS_CHANNEL_NAME_RE,
  XS_CHANNEL_RESULT_MAX_ROWS,
  XS_HUB_CAP,
  XS_MAX_CHANNELS,
  XsAckSchema,
  XsDeliverSchema,
  XsMemberSchema,
  XsReqSchema,
  XsResSchema,
  XsStatusSchema,
  xsReqDeadlineMs,
  type XsDeliverFrame,
  type XsMemberFrame,
  type XsReqFrame,
  type XsResFrame,
} from "../../../src/web-hub/protocol/xs.js";
import { channelsFieldToWrite, sharedFieldToWrite } from "../../../src/fabric/xs/channel.js";
import * as legacy from "../../fixtures/legacy-xs-v071/src/web-hub/protocol/xs.js";

const SID = "01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a";
const SID2 = "01994410-3d3e-7ccf-8f1f-2b2c8d22b22b";

const legacyMember: XsMemberFrame = {
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
const legacyReq: XsReqFrame = {
  t: "xs_req",
  rid: "rid-1",
  op: "send",
  origin: { sessionId: SID, epoch: 3 },
  to: SID2,
  text: "hi",
  wake: true,
  level: 1,
};
const legacyRes: XsResFrame = { t: "xs_res", rid: "rid-1", ok: true, effect: "applied", rows: [], candidates: [] };
const legacyDeliver: XsDeliverFrame = {
  t: "xs_deliver",
  rid: "rid-9",
  xid: "xid-1",
  to: { sessionId: SID2, epoch: 7 },
  from: { sessionId: SID, ref: "01993f4e-6c9", cwdLabel: "~/x", agentId: "pid:1/n" },
  text: "hi",
  wake: true,
  expiresAt: 1_769_000_005_000,
};
const legacyAck = { t: "xs_ack", rid: "r", xid: "x", effect: "applied", woke: false };
const legacyStatus = { joined: true, receive: "wake", blocked: 0 };

describe("channel caps & constants (CH0)", () => {
  it("cap strings; the frozen legacy cap arrays do NOT change", () => {
    expect(XS_CHANNEL_HUB_CAP).toBe("xs.channel.v1");
    expect(XS_CHANNEL_AGENT_CAP).toBe("xs.channel.v1");
    expect(XS_AGENT_CAPS).toEqual(["xs.v1"]);
    expect(XS_HUB_CAP).toBe("xs.v1");
  });

  it("limits and hard ceilings", () => {
    expect(XS_MAX_CHANNELS).toBe(4);
    expect(XS_BROADCAST_WAKES_PER_HOUR_HARD_MAX).toBe(2);
    expect(XS_BROADCAST_WAKE_RECIPIENTS_HARD_MAX).toBe(4);
    expect(XS_CHANNEL_RESULT_MAX_ROWS).toBe(32);
    expect(XS_CHANNEL_NAME_RE.test("team-1")).toBe(true);
    expect(XS_CHANNEL_NAME_RE.test("Team")).toBe(false);
    expect(xsReqDeadlineMs("broadcast")).toBe(8_000);
    expect(xsReqDeadlineMs("channels")).toBe(3_000);
    expect(xsReqDeadlineMs("send")).toBe(8_000);
  });
});

describe("new optional fields (CH0 §3.3)", () => {
  it("xs_member: channels + broadcast limit keys decode; omitted keeps the legacy shape", () => {
    const m: XsMemberFrame = {
      ...legacyMember,
      channels: ["default", "team"],
      limits: {
        ...legacyMember.limits,
        broadcastsOutPerHour: 6,
        broadcastMinIntervalMs: 60_000,
        broadcastWakesOutPerHour: 2,
      },
    };
    expect(decodeAgentFrame(m)).toEqual(m);
    expect(decodeAgentFrame(legacyMember)).toEqual(legacyMember);
    expect(Object.keys(decodeAgentFrame(legacyMember) as object)).not.toContain("channels");
  });

  it("xs_member bounds: ≤4 channels; wake hard max 2; interval ≥10s", () => {
    const base = legacyMember.limits;
    expect(decodeAgentFrame({ ...legacyMember, channels: ["a", "b", "c", "d", "e"] })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyMember, channels: [""] })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyMember, channels: "a" })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyMember, limits: { ...base, broadcastWakesOutPerHour: 3 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyMember, limits: { ...base, broadcastWakesOutPerHour: 0 } })).toBeDefined();
    expect(decodeAgentFrame({ ...legacyMember, limits: { ...base, broadcastMinIntervalMs: 9_999 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyMember, limits: { ...base, broadcastsOutPerHour: 61 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyMember, limits: { ...base, bogus: 1 } })).toBeUndefined();
  });

  it("xs_req: new ops and `channel` decode; unknown ops still rejected", () => {
    for (const op of ["broadcast", "channels"] as const) {
      const f = { ...legacyReq, op, channel: "team", to: undefined, wake: undefined, level: undefined };
      expect(decodeAgentFrame(f)).toEqual(f);
    }
    expect(decodeAgentFrame({ ...legacyReq, op: "list", channel: "team" })).toMatchObject({ channel: "team" });
    expect(decodeAgentFrame({ ...legacyReq, op: "multicast" })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyReq, channel: "" })).toBeUndefined();
    expect(decodeAgentFrame({ ...legacyReq, channel: 5 })).toBeUndefined();
    expect(decodeAgentFrame(legacyReq)).toEqual(legacyReq);
  });

  it("xs_res: fanout/results/channels decode, rows capped at 32, legacy shape unchanged", () => {
    const res = {
      ...legacyRes,
      fanout: { total: 2, applied: 1, none: 1, unknown: 0, woke: 0 },
      results: [{ ref: "a", effect: "applied", woke: false }],
      channels: [{ name: "team", members: 3, joined: true }],
      rows: [{ ref: "a", channels: ["team"] }],
      candidates: [{ ref: "a", channels: ["team"] }],
    };
    expect(decodeHubFrame(res)).toEqual(res);
    const row = { ref: "x", effect: "none", woke: false };
    expect(decodeHubFrame({ ...legacyRes, results: Array.from({ length: 32 }, () => row) })).toBeDefined();
    expect(decodeHubFrame({ ...legacyRes, results: Array.from({ length: 33 }, () => row) })).toBeUndefined();
    expect(decodeHubFrame({ ...legacyRes, channels: Array.from({ length: 33 }, () => ({})) })).toBeUndefined();
    expect(decodeHubFrame(legacyRes)).toEqual(legacyRes);
  });

  it("xs_deliver: via / bc decode; legacy shape unchanged", () => {
    const d = { ...legacyDeliver, via: ["default", "team"], bc: { channel: "team" } };
    expect(decodeHubFrame(d)).toEqual(d);
    expect(decodeHubFrame({ ...legacyDeliver, via: ["a", "b", "c", "d", "e"] })).toBeUndefined();
    expect(decodeHubFrame({ ...legacyDeliver, bc: { channel: "team", extra: 1 } })).toBeUndefined();
    expect(decodeHubFrame({ ...legacyDeliver, bc: {} })).toBeUndefined();
    expect(decodeHubFrame(legacyDeliver)).toEqual(legacyDeliver);
    expect(Object.keys(decodeHubFrame(legacyDeliver) as object)).not.toContain("via");
  });

  it("StatusInfo.xs channels (XsStatusSchema)", () => {
    expect(Value.Check(XsStatusSchema, legacyStatus)).toBe(true);
    expect(Value.Check(XsStatusSchema, { ...legacyStatus, channels: ["default", "a"] })).toBe(true);
    expect(Value.Check(XsStatusSchema, { ...legacyStatus, channels: ["a", "b", "c", "d", "e"] })).toBe(false);
  });
});

describe("old ⇄ new compatibility against the frozen v0.7.1 schemas", () => {
  const pairs: Array<[string, any, any, unknown]> = [
    ["xs_member", XsMemberSchema, legacy.XsMemberSchema, legacyMember],
    ["xs_req", XsReqSchema, legacy.XsReqSchema, legacyReq],
    ["xs_res", XsResSchema, legacy.XsResSchema, legacyRes],
    ["xs_deliver", XsDeliverSchema, legacy.XsDeliverSchema, legacyDeliver],
    ["xs_ack", XsAckSchema, legacy.XsAckSchema, legacyAck],
    ["xs_status", XsStatusSchema, legacy.XsStatusSchema, legacyStatus],
  ];
  it.each(pairs)("%s: legacy-valid frames stay valid under the new schema", (_n, current, old, frame) => {
    expect(Value.Check(old, frame)).toBe(true);
    expect(Value.Check(current, frame)).toBe(true);
  });

  const newShapes: Array<[string, any, any, unknown]> = [
    ["xs_member.channels", XsMemberSchema, legacy.XsMemberSchema, { ...legacyMember, channels: ["a"] }],
    [
      "xs_member.limits broadcast key",
      XsMemberSchema,
      legacy.XsMemberSchema,
      { ...legacyMember, limits: { ...legacyMember.limits, broadcastsOutPerHour: 1 } },
    ],
    ["xs_req op broadcast", XsReqSchema, legacy.XsReqSchema, { ...legacyReq, op: "broadcast", channel: "a" }],
    ["xs_req.channel", XsReqSchema, legacy.XsReqSchema, { ...legacyReq, op: "list", channel: "a" }],
    ["xs_res.fanout", XsResSchema, legacy.XsResSchema, { ...legacyRes, fanout: {} }],
    ["xs_deliver.via", XsDeliverSchema, legacy.XsDeliverSchema, { ...legacyDeliver, via: ["a"] }],
    ["xs_deliver.bc", XsDeliverSchema, legacy.XsDeliverSchema, { ...legacyDeliver, bc: { channel: "a" } }],
    ["status.channels", XsStatusSchema, legacy.XsStatusSchema, { ...legacyStatus, channels: ["a"] }],
  ];
  it.each(newShapes)("%s: accepted by the new schema, REJECTED by the frozen legacy one", (_n, current, old, frame) => {
    expect(Value.Check(current, frame)).toBe(true);
    expect(Value.Check(old, frame)).toBe(false);
  });

  it("the legacy cap/deadline surface is a strict subset of the new one", () => {
    expect(legacy.XS_AGENT_CAPS).toEqual(XS_AGENT_CAPS);
    expect(legacy.XS_HUB_CAP).toBe(XS_HUB_CAP);
    for (const op of ["list", "resolve", "info", "send"] as const) {
      expect(legacy.XS_REQ_DEADLINE_MS[op]).toBe(xsReqDeadlineMs(op));
    }
  });
});

describe("§3.2 write rules: default-only leaves legacy frame bytes untouched", () => {
  it("builds a member frame the way a writer must — no channels key for default-only", () => {
    const build = (effective: string[], hubCap: boolean): XsMemberFrame => {
      const channels = channelsFieldToWrite(effective, hubCap);
      return { ...legacyMember, ...(channels === undefined ? {} : { channels }) };
    };
    const old = JSON.stringify(legacyMember);
    expect(JSON.stringify(build(["default"], true))).toBe(old);
    expect(JSON.stringify(build(["default"], false))).toBe(old);
    expect(JSON.stringify(build(["default", "a"], false))).toBe(old); // old hub: slotFlush strips it
    expect(JSON.stringify(build(["a"], true))).not.toBe(old);
  });

  it("deliver `via` is omitted for a [default] share and for non-capable targets", () => {
    const build = (shared: string[], capable: boolean): XsDeliverFrame => {
      const via = sharedFieldToWrite(shared, capable);
      return { ...legacyDeliver, ...(via === undefined ? {} : { via }) };
    };
    const old = JSON.stringify(legacyDeliver);
    expect(JSON.stringify(build(["default"], true))).toBe(old);
    expect(JSON.stringify(build(["a"], false))).toBe(old);
    expect(build(["default", "a"], true).via).toEqual(["default", "a"]);
  });
});

describe("frozen schema file really is v0.7.1", () => {
  it("fixture xs.ts mirrors git's v0.7.1 blob (self-contained sanity)", () => {
    const src = readFileSync(join(__dirname, "../../fixtures/legacy-xs-v071/src/web-hub/protocol/xs.ts"), "utf8");
    expect(src).toContain("XS_REQ_DEADLINE_MS = { list: 3_000, resolve: 3_000, info: 3_000, send: 8_000 }");
  });
});
