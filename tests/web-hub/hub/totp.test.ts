import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { totpCode, verifyTotpCandidates, type TotpCrypto } from "../../../src/web-hub/hub/totp.js";
import { hashSid, publicSessionId } from "../../../src/web-hub/hub/sid-hash.js";

const crypto: TotpCrypto = {
  hmacSha1: (secret, message) => createHmac("sha1", secret).update(message).digest(),
  timingSafeEqual,
};
const secret = Buffer.from("12345678901234567890");

describe("TOTP RFC 6238 SHA1 / 6 digits", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("matches the RFC vector at %i seconds (last six digits)", (seconds, expected) => {
    expect(totpCode(secret, Math.floor(Number(seconds) / 30), crypto)).toBe(expected);
  });

  it.each([-1, 0, 1])("computes and compares all three fixed-six-byte candidates for match at offset %i", (offset) => {
    const now = 1234567890000,
      step = Math.floor(now / 30000);
    const hmacSha1 = vi.fn(crypto.hmacSha1),
      compare = vi.fn(timingSafeEqual);
    const code = totpCode(secret, step + offset, crypto);
    expect(verifyTotpCandidates(secret, code, now, { hmacSha1, timingSafeEqual: compare })).toBe(step + offset);
    expect(hmacSha1).toHaveBeenCalledTimes(3);
    expect(compare).toHaveBeenCalledTimes(3);
    expect(compare.mock.calls.every(([a, b]) => a.byteLength === 6 && b.byteLength === 6)).toBe(true);
    expect(compare.mock.calls.map(([, b]) => Buffer.from(b).toString())).toEqual(
      [-1, 0, 1].map((delta) => totpCode(secret, step + delta, crypto)),
    );
  });

  it("still compares three times on a wrong code and never runs crypto for malformed codes", () => {
    const compare = vi.fn(() => false);
    expect(verifyTotpCandidates(secret, "123456", 60000, { ...crypto, timingSafeEqual: compare })).toBeUndefined();
    expect(compare).toHaveBeenCalledTimes(3);
    compare.mockClear();
    for (const code of ["12345", "1234567", "１２３４５６", "12345x"]) {
      expect(verifyTotpCandidates(secret, code, 60000, { ...crypto, timingSafeEqual: compare })).toBeUndefined();
    }
    expect(compare).not.toHaveBeenCalled();
  });

  it("returns the highest matching step even for a deliberate collision", () => {
    const compare = vi.fn(() => true);
    expect(verifyTotpCandidates(secret, "000000", 60000, { ...crypto, timingSafeEqual: compare })).toBe(3);
    expect(compare).toHaveBeenCalledTimes(3);
  });

  it("works after Function.toString embedding without imports", () => {
    const run = new Function(
      "crypto",
      `const totpCode = ${totpCode.toString()}; const verify = ${verifyTotpCandidates.toString()}; return verify(new Uint8Array(${JSON.stringify([...secret])}), '287082', 59000, crypto);`,
    );
    expect(run(crypto)).toBe(1);
  });
});

it("public session ids are deterministic, domain-separated, fixed-width and never raw hashes", () => {
  const sidHash = hashSid("secret cookie");
  expect(publicSessionId(sidHash)).toMatch(/^[A-Za-z0-9_-]{16}$/);
  expect(publicSessionId(sidHash)).toBe(publicSessionId(sidHash));
  expect(publicSessionId(sidHash)).not.toBe(sidHash.slice(0, 16));
  expect(publicSessionId(hashSid("different"))).not.toBe(publicSessionId(sidHash));
});

it("#66 frozen v0.10 reader anchor: only 20B TOTP (not 53B) is accepted", () => {
  // v0.10.0 db-child.ts factorRowValid's TOTP clause, deliberately frozen, NOT production import.
  const legacyTotpClause = (row: { totp_secret: Uint8Array | null; totp_last_step: number }) =>
    row.totp_secret === null ||
    (row.totp_secret.length === 20 && Number.isSafeInteger(row.totp_last_step) && row.totp_last_step >= 0);
  expect(legacyTotpClause({ totp_secret: Buffer.alloc(20), totp_last_step: 1 })).toBe(true);
  const encrypted = Buffer.alloc(53);
  encrypted[0] = 1;
  expect(legacyTotpClause({ totp_secret: encrypted, totp_last_step: 1 })).toBe(false);
});
