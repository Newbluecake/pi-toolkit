/** #61 (C0): `sched.confirm.v1` frames — decode tables, strictness, caps, append-only wire. */
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  SCHED_CONFIRM_CAP,
  SCHED_CONFIRM_CLOSED_MAX,
  SCHED_CONFIRM_OFFERS_MAX,
  SCHED_HUB_CAPS,
  SCHED_AGENT_CAPS,
} from "../../../src/web-hub/protocol/schedule.js";

const SID = "sess-1";
const HASH = "fd9fcbba309bbae09b0d3c6d69258712ce12370868bc09012b3649c28daa08e9";
const OID = "offer_0123456789abcdef";
const REQ = "req_0123456789abcdef";
const closedBase = { offerId: OID, taskId: "s_abcd2345", defHash: HASH };
const offer = { offerId: OID, taskId: "s_abcd2345", defHash: HASH, expiresAt: 1761350400000 };

const AGENT: Array<Record<string, unknown>> = [
  { t: "sched_offers", sessionId: SID, open: [], closed: [] },
  {
    t: "sched_offers",
    sessionId: SID,
    open: [offer],
    closed: [
      { ...closedBase, outcome: "approved", by: "feishu" },
      { ...closedBase, outcome: "expired" },
    ],
  },
  { t: "sched_decide_ack", reqId: REQ, result: "approved" },
  { t: "sched_decide_ack", reqId: REQ, result: "refused", reason: "E_REV" },
];
const HUB: Array<Record<string, unknown>> = [
  {
    t: "sched_decide",
    reqId: REQ,
    sessionId: SID,
    offerId: OID,
    taskId: "s_abcd2345",
    defHash: HASH,
    decision: "reject",
    expiresAt: 1761350430000,
  },
];

describe("sched.confirm.v1 frames", () => {
  it("cap string and limits; sched.v1 caps untouched", () => {
    expect(SCHED_CONFIRM_CAP).toBe("sched.confirm.v1");
    expect(SCHED_CONFIRM_OFFERS_MAX).toBe(8);
    expect(SCHED_CONFIRM_CLOSED_MAX).toBe(8);
    expect([...SCHED_HUB_CAPS]).toEqual(["sched.v1"]);
    expect([...SCHED_AGENT_CAPS]).toEqual(["sched.v1"]);
  });

  it.each(AGENT)("agent→hub round-trips %o (and is not a hub frame)", (f) => {
    expect(decodeAgentFrame(f)).toEqual(f);
    expect(decodeHubFrame(f)).toBeUndefined();
  });
  it.each(HUB)("hub→agent round-trips %o (and is not an agent frame)", (f) => {
    expect(decodeHubFrame(f)).toEqual(f);
    expect(decodeAgentFrame(f)).toBeUndefined();
  });

  it.each([
    ["offers extra key", { t: "sched_offers", sessionId: SID, open: [], closed: [], x: 1 }],
    ["offers missing closed", { t: "sched_offers", sessionId: SID, open: [] }],
    ["offers 9 open", { t: "sched_offers", sessionId: SID, open: Array.from({ length: 9 }, () => offer), closed: [] }],
    [
      "offers 9 closed",
      {
        t: "sched_offers",
        sessionId: SID,
        open: [],
        closed: Array.from({ length: 9 }, () => ({ ...closedBase, outcome: "expired" })),
      },
    ],
    ["offer bad hash", { t: "sched_offers", sessionId: SID, open: [{ ...offer, defHash: "abc" }], closed: [] }],
    ["offer short id", { t: "sched_offers", sessionId: SID, open: [{ ...offer, offerId: "x" }], closed: [] }],
    ["offer extra key", { t: "sched_offers", sessionId: SID, open: [{ ...offer, reqId: REQ }], closed: [] }],
    [
      "closed bad outcome",
      { t: "sched_offers", sessionId: SID, open: [], closed: [{ ...closedBase, outcome: "done" }] },
    ],
    [
      "closed bad by",
      { t: "sched_offers", sessionId: SID, open: [], closed: [{ ...closedBase, outcome: "approved", by: "cli" }] },
    ],
    [
      "closed reqId echo (r2 removed)",
      { t: "sched_offers", sessionId: SID, open: [], closed: [{ ...closedBase, outcome: "approved", reqId: REQ }] },
    ],
    ["ack bad result", { t: "sched_decide_ack", reqId: REQ, result: "started" }],
    ["ack oversized reason", { t: "sched_decide_ack", reqId: REQ, result: "refused", reason: "x".repeat(129) }],
    ["ack extra key", { t: "sched_decide_ack", reqId: REQ, result: "approved", offerId: OID }],
  ])("rejects agent frame: %s", (_l, f) => {
    expect(decodeAgentFrame(f)).toBeUndefined();
  });

  it.each([
    ["bad decision", { ...HUB[0], decision: "maybe" }],
    ["missing offerId", { ...HUB[0], offerId: undefined }],
    ["extra key", { ...HUB[0], x: 1 }],
    ["short reqId", { ...HUB[0], reqId: "short" }],
    ["bad task id", { ...HUB[0], taskId: "nope" }],
    ["negative expiry", { ...HUB[0], expiresAt: -1 }],
  ])("rejects hub frame: %s", (_l, f) => {
    expect(decodeHubFrame(JSON.parse(JSON.stringify(f)))).toBeUndefined();
  });
});
