import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  TfaReqSchema,
  TfaResSchema,
  type TfaReqFrame,
  type TfaResFrame,
} from "../../../src/web-hub/protocol/lan-2fa.js";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import { encodeFrame } from "../../../src/web-hub/protocol/ndjson.js";
import { requestTfa } from "../../../src/web-hub/agent/twofa-cmd.js";
import { LAN_2FA_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
const requests: TfaReqFrame[] = [
  { t: "tfa_req", rid: "r", op: "status" },
  { t: "tfa_req", rid: "r", op: "totp_begin" },
  { t: "tfa_req", rid: "r", op: "totp_begin", replace: true },
  { t: "tfa_req", rid: "r", op: "totp_confirm", code: "123456" },
  { t: "tfa_req", rid: "r", op: "feishu", on: true },
  { t: "tfa_req", rid: "r", op: "feishu", on: false },
  { t: "tfa_req", rid: "r", op: "recovery_regen" },
  { t: "tfa_req", rid: "r", op: "reset", confirm: true },
  { t: "tfa_req", rid: "r", op: "forget_ips" },
  { t: "tfa_req", rid: "r", op: "repair", confirm: true },
];
const codes = Array.from({ length: 10 }, (_, i) => String(i).padStart(12, "0"));
const responses: TfaResFrame[] = [
  {
    t: "tfa_res",
    rid: "r",
    ok: true,
    data: { kind: "status", state: "none", totp: false, feishu: false, recoveryLeft: 0, knownIps: 0 },
  },
  {
    t: "tfa_res",
    rid: "r",
    ok: true,
    data: {
      kind: "status",
      state: "inconsistent",
      totp: false,
      feishu: false,
      recoveryLeft: 0,
      knownIps: 1,
      repairNeeded: "2fa-schema",
    },
  },
  {
    t: "tfa_res",
    rid: "r",
    ok: true,
    data: {
      kind: "totp_begin",
      otpauthUri: "otpauth://totp/pi?secret=ABCDEFGHIJKLMNOP",
      secretB32: "ABCDEFGHIJKLMNOP",
    },
  },
  { t: "tfa_res", rid: "r", ok: true, data: { kind: "totp_confirm", recoveryCodes: codes } },
  { t: "tfa_res", rid: "r", ok: true, data: { kind: "recovery_regen", recoveryCodes: codes } },
  { t: "tfa_res", rid: "r", ok: true, data: { kind: "ok" } },
  { t: "tfa_res", rid: "r", ok: false, code: "E_DB", message: "unavailable" },
];
describe("tfa socket frames (LAN security P0)", () => {
  for (const frame of requests)
    it(`round trips ${frame.op} ${JSON.stringify(frame)}`, () => {
      expect(Value.Check(TfaReqSchema, frame)).toBe(true);
      expect(decodeAgentFrame(JSON.parse(encodeFrame(frame).toString()))).toEqual(frame);
      expect(decodeHubFrame(frame)).toBeUndefined();
    });
  for (const frame of responses)
    it(`round trips ${frame.ok ? frame.data.kind : frame.code}`, () => {
      expect(Value.Check(TfaResSchema, frame)).toBe(true);
      expect(decodeHubFrame(JSON.parse(encodeFrame(frame).toString()))).toEqual(frame);
      expect(decodeAgentFrame(frame)).toBeUndefined();
    });
  it("strict request schemas reject secrets/extras, missing confirms and malformed codes", () => {
    const bad = [
      { t: "tfa_req", rid: "r", op: "status", secretB32: "secret" },
      { t: "tfa_req", rid: "r", op: "totp_confirm", code: "12345" },
      { t: "tfa_req", rid: "r", op: "repair" },
      { t: "tfa_req", rid: "r", op: "reset", confirm: false },
      { t: "tfa_req", rid: "", op: "status" },
      { t: "tfa_req", rid: "r", op: "feishu", on: "yes" },
      { t: "tfa_req", rid: "r", op: "unknown" },
    ];
    for (const frame of bad) expect(decodeAgentFrame(frame)).toBeUndefined();
  });
  it("secrets exist only in the three allowed response variants", () => {
    for (const data of [
      { kind: "status", state: "none", totp: false, feishu: false, recoveryLeft: 0, knownIps: 0, secretB32: "secret" },
      { kind: "ok", recoveryCodes: codes },
      { kind: "totp_begin", otpauthUri: "otpauth://totp/x", secretB32: "ABCDEFGHIJKLMNOP", recoveryCodes: codes },
      { kind: "recovery_regen", recoveryCodes: codes.slice(1) },
      { kind: "totp_confirm", recoveryCodes: Array(10).fill(codes[0]) },
    ]) {
      expect(decodeHubFrame({ t: "tfa_res", rid: "r", ok: true, data })).toBeUndefined();
    }
    expect(
      decodeHubFrame({ t: "tfa_res", rid: "r", ok: false, code: "E_DB", message: "bad", secretB32: "secret" }),
    ).toBeUndefined();
    expect(decodeHubFrame({ ...responses[0], data: undefined })).toBeUndefined();
  });
  it.each([false, true])("new agent → hub with cap=%s: old hub sees zero new frames", async (cap) => {
    const request = vi.fn(async () => responses[0]!);
    const result = await requestTfa({ hasCap: (c) => cap && c === LAN_2FA_HUB_CAP, request }, requests[0]!);
    expect(request).toHaveBeenCalledTimes(cap ? 1 : 0);
    if (cap) expect(request).toHaveBeenCalledWith(requests[0], LAN_2FA_HUB_CAP);
    else expect(result).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
  });
  it("old agent → new decoder keeps legacy LAN frames byte-identical", () => {
    const frame = { t: "lan_req", rid: "r", op: "info" };
    expect(decodeAgentFrame(frame)).toEqual(frame);
    expect(decodeHubFrame({ t: "lan_res", rid: "r", ok: true })).toEqual({ t: "lan_res", rid: "r", ok: true });
    expect(decodeAgentFrame({ t: "future_security_frame", rid: "r" })).toBeUndefined();
  });
});
