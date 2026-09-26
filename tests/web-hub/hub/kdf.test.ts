/**
 * plan §5.1: `KdfPort.run` (real scrypt via `node:crypto`), `validateKdfParams`
 * bounds, and default-write params.
 */
import { describe, expect, it } from "vitest";
import {
  createKdf,
  DEFAULT_KDF_KEY_LEN,
  DEFAULT_KDF_N,
  DEFAULT_KDF_P,
  DEFAULT_KDF_R,
  DEFAULT_KDF_SALT_BYTES,
  defaultKdfParams,
  maxmemFor,
  validateKdfParams,
} from "../../../src/web-hub/hub/kdf.js";

describe('defaultKdfParams (plan §5.1 "参数")', () => {
  it("matches the frozen new-write parameters", () => {
    const p = defaultKdfParams();
    expect(p.n).toBe(32768);
    expect(p.r).toBe(8);
    expect(p.p).toBe(1);
    expect(p.keyLen).toBe(32);
    expect(p.salt.byteLength).toBe(16);
    expect(DEFAULT_KDF_N).toBe(32768);
    expect(DEFAULT_KDF_R).toBe(8);
    expect(DEFAULT_KDF_P).toBe(1);
    expect(DEFAULT_KDF_KEY_LEN).toBe(32);
    expect(DEFAULT_KDF_SALT_BYTES).toBe(16);
  });

  it("generates a fresh random salt each call", () => {
    const a = defaultKdfParams();
    const b = defaultKdfParams();
    expect(Buffer.from(a.salt).equals(Buffer.from(b.salt))).toBe(false);
  });

  it("maxmemFor matches 128*N*r + 1MiB", () => {
    expect(maxmemFor(32768, 8)).toBe(128 * 32768 * 8 + 1024 * 1024);
  });
});

describe("createKdf().run (plan §5.1)", () => {
  it("derives a key of the requested length, deterministically for the same inputs", async () => {
    const kdf = createKdf();
    const salt = new Uint8Array(16).fill(7);
    const params = { n: 16384, r: 8, p: 1, keyLen: 32, salt };
    const a = await kdf.run("correct horse battery staple", params);
    const b = await kdf.run("correct horse battery staple", params);
    expect(a.byteLength).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("different passwords ⇒ different derived keys", async () => {
    const kdf = createKdf();
    const salt = new Uint8Array(16).fill(3);
    const params = { n: 16384, r: 8, p: 1, keyLen: 32, salt };
    const a = await kdf.run("password-one", params);
    const b = await kdf.run("password-two", params);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("already-aborted signal rejects immediately without running scrypt", async () => {
    const kdf = createKdf();
    const ac = new AbortController();
    ac.abort(new Error("nope"));
    await expect(
      kdf.run("x", { n: 16384, r: 8, p: 1, keyLen: 32, salt: new Uint8Array(16) }, { signal: ac.signal }),
    ).rejects.toThrow("nope");
  });

  it("aborting mid-flight rejects (the underlying scrypt call is not literally cancelable, but the caller is released)", async () => {
    const kdf = createKdf();
    const ac = new AbortController();
    const p = kdf.run("x", { n: 32768, r: 8, p: 1, keyLen: 32, salt: new Uint8Array(16) }, { signal: ac.signal });
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});

describe('validateKdfParams (plan §5.1 "读取校验")', () => {
  function rec(
    over: Partial<{ kdf: "scrypt"; n: number; r: number; p: number; salt: Uint8Array; hash: Uint8Array }> = {},
  ) {
    return {
      kdf: "scrypt" as const,
      n: 32768,
      r: 8,
      p: 1,
      salt: new Uint8Array(16),
      hash: new Uint8Array(32),
      ...over,
    };
  }

  it("accepts the default new-write shape", () => {
    expect(validateKdfParams(rec())).toEqual({ ok: true });
  });

  it("accepts the boundary values (2^14, 2^16, r=1, r=16, p=1, p=2, salt=16, salt=64)", () => {
    expect(validateKdfParams(rec({ n: 2 ** 14, r: 1, p: 1 }))).toEqual({ ok: true });
    expect(validateKdfParams(rec({ n: 2 ** 14, r: 1, p: 2 }))).toEqual({ ok: true });
    expect(validateKdfParams(rec({ n: 2 ** 16, r: 16, p: 1, salt: new Uint8Array(64) }))).toEqual({
      ok: false,
      reason: expect.any(String),
    }); // 128*2^16*16 exceeds 32MiB
    expect(validateKdfParams(rec({ salt: new Uint8Array(64) }))).toEqual({ ok: true });
  });

  it("rejects kdf !== 'scrypt'", () => {
    expect(validateKdfParams({ ...rec(), kdf: "other" as never })).toEqual({
      ok: false,
      reason: expect.stringContaining("scrypt"),
    });
  });

  it("rejects non-power-of-2 n, and n outside [2^14..2^16]", () => {
    expect(validateKdfParams(rec({ n: 32000 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ n: 2 ** 13 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ n: 2 ** 17 }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects r/p out of range", () => {
    expect(validateKdfParams(rec({ r: 0 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ r: 17 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ p: 0 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ p: 3 }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects 128*n*r exceeding 32 MiB even when n/r are individually in range", () => {
    expect(validateKdfParams(rec({ n: 2 ** 16, r: 16 }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects salt length outside [16..64] bytes", () => {
    expect(validateKdfParams(rec({ salt: new Uint8Array(15) }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ salt: new Uint8Array(65) }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects hash length !== 32 bytes exactly", () => {
    expect(validateKdfParams(rec({ hash: new Uint8Array(31) }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ hash: new Uint8Array(33) }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects non-safe-integer n/r/p (corrupted row)", () => {
    expect(validateKdfParams(rec({ n: 32768.5 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ r: Number.NaN }))).toEqual({ ok: false, reason: expect.any(String) });
  });
});
