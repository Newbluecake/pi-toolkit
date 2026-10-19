import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  LAN_2FA_LIMITS,
  NEW_IP_WINDOW_MS,
  LanFactorBodySchema,
  Lan2faChallengeSchema,
  LanLoginResponseSchema,
  normalizeRecoveryCode,
  TOTP_CODE_RE,
} from "../../../src/web-hub/protocol/lan-2fa.js";
import {
  LanSessionsResponseSchema,
  LanSessionRevokeBodySchema,
  LanSessionRevokeResponseSchema,
  LAN_SESSIONS_PER_USER_MAX,
  REVOKE_TOTAL_MS,
} from "../../../src/web-hub/protocol/lan-sessions.js";
import {
  LAN_2FA_HUB_CAP,
  LAN_SESSIONS_HUB_CAP,
  PROTO,
  P1_CAPS,
  P2_AGENT_CAPS,
  P2_HUB_CAPS,
} from "../../../src/web-hub/protocol/version.js";
import { publicSessionId, hashSid } from "../../../src/web-hub/hub/sid-hash.js";
describe("LAN security HTTP contracts", () => {
  it("pins bounds and declares (not advertises) caps", () => {
    expect(NEW_IP_WINDOW_MS).toBe(30 * 24 * 3_600_000);
    expect(LAN_2FA_LIMITS).toEqual({
      challengeMs: 300000,
      attempts: 5,
      challenges: 64,
      perIp: 4,
      methodAttempts: 10,
      methodWindowMs: 900000,
      approvalMs: 120000,
      approvalSendMs: 5000,
      cardsPerIp: 3,
      cardsGlobal: 6,
      cardWindowMs: 600000,
      postKdfMs: 10000,
      factorMs: 12000,
      completionReserveMs: 4000,
      waitHoldMs: 15000,
      waitReserveMs: 8000,
      pollTimeoutMs: 30000,
      recoveryCodes: 10,
      recoveryBits: 60,
      loginIps: 256,
    });
    expect(LAN_SESSIONS_PER_USER_MAX).toBe(32);
    expect(REVOKE_TOTAL_MS).toBe(10000);
    expect([LAN_2FA_HUB_CAP, LAN_SESSIONS_HUB_CAP]).toEqual(["lan.2fa.v1", "lan.sessions.v1"]);
    expect(PROTO).toEqual({ major: 1, minor: 2 });
    for (const caps of [P1_CAPS, P2_AGENT_CAPS, P2_HUB_CAPS]) {
      expect(caps).not.toContain(LAN_2FA_HUB_CAP);
      expect(caps).not.toContain(LAN_SESSIONS_HUB_CAP);
    }
  });
  it("validates codes strictly and normalizes Crockford recovery input", () => {
    for (const code of ["000001", "123456"])
      expect(Value.Check(LanFactorBodySchema, { method: "totp", code })).toBe(true);
    for (const code of ["12345", "１２３４５６", "1234567", "12345a", " 123456"]) {
      expect(TOTP_CODE_RE.test(code)).toBe(false);
      expect(Value.Check(LanFactorBodySchema, { method: "totp", code })).toBe(false);
    }
    expect(normalizeRecoveryCode("ab-cd ef-gh jk-oi")).toBe("ABCDEFGHJK01");
    expect(normalizeRecoveryCode("U23456789012")).toBeUndefined();
    expect(normalizeRecoveryCode("short")).toBeUndefined();
    expect(Value.Check(LanFactorBodySchema, { method: "recovery", code: "0123456789AB" })).toBe(true);
    expect(Value.Check(LanFactorBodySchema, { method: "feishu", code: "123456" })).toBe(false);
    expect(Value.Check(LanFactorBodySchema, { method: "totp", code: "123456", token: "secret" })).toBe(false);
  });
  it("does not put a token into the public challenge; exact method set", () => {
    const body = { error: "E_2FA", methods: ["totp", "recovery"], feishu: "unavailable", expiresAt: 300000 };
    expect(Value.Check(Lan2faChallengeSchema, body)).toBe(true);
    for (const extra of [
      { token: "secret" },
      { sidHash: "secret" },
      { methods: [] },
      { methods: ["totp", "totp"] },
      { methods: ["password"] },
    ])
      expect(Value.Check(Lan2faChallengeSchema, { ...body, ...extra })).toBe(false);
    expect(Value.Check(LanLoginResponseSchema, { error: "E_2FA_CODE", attemptsLeft: 4 })).toBe(true);
    expect(Value.Check(LanLoginResponseSchema, { error: "E_2FA_CODE", attemptsLeft: 6 })).toBe(false);
    expect(Value.Check(LanLoginResponseSchema, { state: "pending" })).toBe(true);
    expect(Value.Check(LanLoginResponseSchema, { ok: true, initialPassword: false })).toBe(true);
  });
  it("sessions are bounded, public ids are domain separated, bulk revocation is honest", () => {
    const id = publicSessionId("hash");
    expect(id).toBe("bj0liHEuX2vV88r4");
    expect(id).not.toBe(hashSid("hash").slice(0, 16));
    const row = {
      id,
      current: true,
      createdAt: 1,
      lastSeenAt: 2,
      expiresAt: 3,
      absoluteExpiresAt: 4,
      createdIp: "1.2.3.4",
    };
    const list = { idleMinutes: 720, absoluteDays: 7, max: 32, sessions: Array(32).fill(row) };
    expect(Value.Check(LanSessionsResponseSchema, list)).toBe(true);
    expect(Value.Check(LanSessionsResponseSchema, { ...list, sessions: Array(33).fill(row) })).toBe(false);
    expect(Value.Check(LanSessionsResponseSchema, { ...list, sessions: [{ ...row, sidHash: "private" }] })).toBe(false);
    expect(Value.Check(LanSessionRevokeBodySchema, { id })).toBe(true);
    expect(Value.Check(LanSessionRevokeBodySchema, { others: true })).toBe(true);
    for (const bad of [{ others: false }, { id, others: true }, { sidHash: "private" }, {}])
      expect(Value.Check(LanSessionRevokeBodySchema, bad)).toBe(false);
    expect(Value.Check(LanSessionRevokeResponseSchema, { ok: true, revoked: 2, complete: false })).toBe(true);
    expect(Value.Check(LanSessionRevokeResponseSchema, { ok: true, revoked: 2 })).toBe(false);
  });
});
