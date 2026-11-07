/**
 * scheduled-reports plan r3 §10.1/§10.3 (S0): `sched_*` frames folded into the two decode
 * tables (strict, direction-checked), the `sched.v1` cap constants and the
 * `HubConfig.schedule` normalizer.
 */
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  normalizeHubScheduleConfig,
  SCHED_AGENT_CAP,
  SCHED_AGENT_CAPS,
  SCHED_AGENT_FRAME_SCHEMAS,
  SCHED_HUB_CAP,
  SCHED_HUB_CAPS,
  SCHED_HUB_FRAME_SCHEMAS,
  SCHED_RECEIPTS_PER_FRAME,
  SCHED_TOLERANCE_S,
} from "../../../src/web-hub/protocol/schedule.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";

const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";
const HASH = "fd9fcbba309bbae09b0d3c6d69258712ce12370868bc09012b3649c28daa08e9";
const REQ = "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123";

const AGENT_FRAMES: Array<Record<string, unknown>> = [
  { t: "sched_changed", sessionId: SID },
  { t: "sched_bound", agentKey: "a1b2c3", runKey: "s_abcd2345@1761350400000" },
  { t: "sched_bound", agentKey: "a1b2c3", runKey: "s_abcd2345@m-20f1cd92" },
  { t: "sched_run_ack", reqId: REQ, result: "started" },
  { t: "sched_run_ack", reqId: REQ, result: "refused", reason: "E_OVERLAP" },
];
const HUB_FRAMES: Array<Record<string, unknown>> = [
  { t: "sched_run", reqId: REQ, sessionId: SID, taskId: "s_abcd2345", defHash: HASH, expiresAt: 1761350430000 },
  { t: "sched_receipts", sessionId: SID, reportIds: [HASH] },
  { t: "sched_receipts", sessionId: SID, reportIds: Array.from({ length: 64 }, () => HASH) },
];

describe("sched_* agent→hub frames", () => {
  it.each(AGENT_FRAMES)("round-trips %o", (frame) => {
    expect(decodeAgentFrame(frame)).toEqual(frame);
    expect(decodeHubFrame(frame)).toBeUndefined();
  });

  it.each([
    ["changed extra key", { t: "sched_changed", sessionId: SID, x: 1 }],
    ["changed empty sid", { t: "sched_changed", sessionId: "" }],
    ["changed path-ish sid", { t: "sched_changed", sessionId: "../etc" }],
    ["changed oversized sid", { t: "sched_changed", sessionId: "a".repeat(129) }],
    ["bound bad runKey", { t: "sched_bound", agentKey: "k", runKey: "s_abcd2345@01" }],
    ["bound uppercase task", { t: "sched_bound", agentKey: "k", runKey: "s_ABCD2345@1" }],
    ["bound empty agentKey", { t: "sched_bound", agentKey: "", runKey: "s_abcd2345@1" }],
    ["ack bad result", { t: "sched_run_ack", reqId: REQ, result: "ok" }],
    ["ack short reqId", { t: "sched_run_ack", reqId: "short", result: "started" }],
    ["ack empty reason", { t: "sched_run_ack", reqId: REQ, result: "refused", reason: "" }],
    ["ack oversized reason", { t: "sched_run_ack", reqId: REQ, result: "refused", reason: "x".repeat(129) }],
    ["ack extra key", { t: "sched_run_ack", reqId: REQ, result: "started", runKey: "s_abcd2345@1" }],
  ])("rejects %s", (_label, frame) => {
    expect(decodeAgentFrame(frame)).toBeUndefined();
  });
});

describe("sched_* hub→agent frames", () => {
  it.each(HUB_FRAMES)("round-trips %o", (frame) => {
    expect(decodeHubFrame(frame)).toEqual(frame);
    expect(decodeAgentFrame(frame)).toBeUndefined();
  });

  const RUN = HUB_FRAMES[0]!;
  it.each([
    ["run missing defHash", { ...RUN, defHash: undefined }],
    ["run short defHash", { ...RUN, defHash: HASH.slice(1) }],
    ["run uppercase defHash", { ...RUN, defHash: HASH.toUpperCase() }],
    ["run bad taskId", { ...RUN, taskId: "s_abc" }],
    ["run fractional expiresAt", { ...RUN, expiresAt: 1.5 }],
    ["run negative expiresAt", { ...RUN, expiresAt: -1 }],
    ["run extra key", { ...RUN, prompt: "x" }],
    ["receipts empty", { t: "sched_receipts", sessionId: SID, reportIds: [] }],
    ["receipts over 64", { t: "sched_receipts", sessionId: SID, reportIds: Array.from({ length: 65 }, () => HASH) }],
    ["receipts non-hash id", { t: "sched_receipts", sessionId: SID, reportIds: ["abc"] }],
  ])("rejects %s", (_label, frame) => {
    const clean = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
    expect(decodeHubFrame(clean)).toBeUndefined();
  });

  it("receipts per-frame cap is 64 (§10.1)", () => {
    expect(SCHED_RECEIPTS_PER_FRAME).toBe(64);
  });
});

describe("tables / caps (§10.1)", () => {
  it("eight frame types: five agent→hub and three hub→agent (#61 appended confirm frames)", () => {
    expect(Object.keys(SCHED_AGENT_FRAME_SCHEMAS)).toEqual([
      "sched_changed",
      "sched_bound",
      "sched_run_ack",
      "sched_offers",
      "sched_decide_ack",
    ]);
    expect(Object.keys(SCHED_HUB_FRAME_SCHEMAS)).toEqual(["sched_run", "sched_receipts", "sched_decide"]);
  });

  it("cap is sched.v1 on both sides; PROTO is not bumped (1.2)", () => {
    expect(SCHED_HUB_CAP).toBe("sched.v1");
    expect(SCHED_AGENT_CAP).toBe("sched.v1");
    expect([...SCHED_HUB_CAPS]).toEqual(["sched.v1"]);
    expect([...SCHED_AGENT_CAPS]).toEqual(["sched.v1"]);
    expect(PROTO).toEqual({ major: 1, minor: 2 });
  });
});

describe("normalizeHubScheduleConfig (§10.3)", () => {
  it("accepts the exact shape and returns a fresh copy without extra keys", () => {
    const raw = { dir: "/home/u/.pi/agent/schedules", toleranceS: 60, future: true };
    const out = normalizeHubScheduleConfig(raw);
    expect(out).toEqual({ dir: "/home/u/.pi/agent/schedules", toleranceS: 60 });
    expect(out).not.toBe(raw);
    expect(SCHED_TOLERANCE_S).toBe(60);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["array", []],
    ["string", "x"],
    ["missing dir", { toleranceS: 60 }],
    ["relative dir", { dir: "schedules", toleranceS: 60 }],
    ["empty dir", { dir: "", toleranceS: 60 }],
    ["NUL dir", { dir: "/a\0b", toleranceS: 60 }],
    ["oversized dir", { dir: `/${"a".repeat(4096)}`, toleranceS: 60 }],
    ["tolerance not 60", { dir: "/x", toleranceS: 30 }],
    ["tolerance missing", { dir: "/x" }],
    ["tolerance string", { dir: "/x", toleranceS: "60" }],
  ])("drops the key on %s", (_label, raw) => {
    expect(normalizeHubScheduleConfig(raw)).toBeUndefined();
  });
});
