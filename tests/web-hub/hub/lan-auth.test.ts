/**
 * `runLanLogin` (plan §6.1, `hub/lan-auth.ts`, LC) unit tests that don't need a real HTTP
 * server — LC review fixes (lan-plan.md §15.9 #2/#4): the 429 `kind` discriminator that
 * `hub/http.ts` uses to pick `E_RATE` vs. the new `E_LOCKED`, and the §5.1 "读取校验" corrupt-KDF
 * -params fail-closed path. `tests/web-hub/http/lan-login.test.ts` / `lan-password-client.test.ts`
 * cover the same pipeline end-to-end through real HTTP; these are the narrower, deterministic
 * complements for branches that are awkward to force through real admission/rate-limiting timing.
 */
import { describe, expect, it } from "vitest";
import { scryptSync } from "node:crypto";
import { runLanLogin } from "../../../src/web-hub/hub/lan-auth.js";
import { fakeKdf, fakeLanStore, fakeLoginLimiter, type FakeLanStore } from "../contract/fakes.js";
import type { KdfAdmissionPort, LoginLimiterPort, RequestContext } from "../../../src/web-hub/hub/ports.js";

/** Mirrors `tests/web-hub/http/lan-helpers.ts`'s `seedLanUser` (real scrypt so `fakeKdf()`'s real
 * `scrypt` run actually matches) with an escape hatch for injecting corrupt KDF params. */
function seedUser(
  store: FakeLanStore,
  username: string,
  password: string,
  override: Partial<{ n: number; r: number; p: number }> = {},
): void {
  const salt = Buffer.alloc(16, 7);
  const n = override.n ?? 16384;
  const r = override.r ?? 8;
  const p = override.p ?? 1;
  const hash =
    Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0 && 128 * n * r <= 32 * 1024 * 1024
      ? scryptSync(password, salt, 32, { N: n, r, p, maxmem: 128 * n * r + 1024 * 1024 })
      : Buffer.alloc(32, 1); // corrupt params never actually get fed to scrypt for real
  store.seedUser({
    id: 1,
    username,
    kdf: "scrypt",
    n,
    r,
    p,
    salt,
    hash,
    epoch: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function ctx(clientIp = "10.0.0.5"): RequestContext {
  return {
    kind: "lan",
    peerIp: clientIp,
    viaTrustedProxy: false,
    clientIp,
    scheme: "http",
    hostKey: "hub.local:7879",
    externalOrigin: "http://hub.local:7879",
  };
}

function alwaysAdmits(): KdfAdmissionPort {
  return { acquire: async () => ({ ok: true, release: () => {} }) };
}

describe("runLanLogin 429 discriminator (plan §6.2; LC review fix, lan-plan.md §15.9 #4)", () => {
  it('an ordinary per-IP backoff lockout (limiter.admit fails, not saturated) is kind:"backoff"', async () => {
    const store = fakeLanStore();
    seedUser(store, "alice", "correct-horse-battery");
    const limiter: LoginLimiterPort = {
      admit: () => ({ ok: false, retryAfterMs: 30_000 }),
      fail: () => {},
      succeed: () => {},
      unlock: () => {},
    };
    const outcome = await runLanLogin(
      ctx(),
      { username: "alice", password: "wrong" },
      { store, kdf: fakeKdf(), limiter, admission: alwaysAdmits() },
      Date.now(),
    );
    expect(outcome).toMatchObject({ status: 429, kind: "backoff", retryAfterMs: 30_000 });
    expect(outcome).not.toHaveProperty("saturated");
  });

  it('the saturated sub-case is still kind:"backoff" (it is the same limiter.admit gate) and carries saturated:true', async () => {
    const store = fakeLanStore();
    const limiter: LoginLimiterPort = {
      admit: () => ({ ok: false, retryAfterMs: 60_000, saturated: true }),
      fail: () => {},
      succeed: () => {},
      unlock: () => {},
    };
    const outcome = await runLanLogin(
      ctx(),
      { username: "alice", password: "wrong" },
      { store, kdf: fakeKdf(), limiter, admission: alwaysAdmits() },
      Date.now(),
    );
    expect(outcome).toMatchObject({ status: 429, kind: "backoff", saturated: true, retryAfterMs: 60_000 });
  });

  it('the KDF fair-scheduling admission queue rejecting (capacity/timeout) is kind:"admission"', async () => {
    const store = fakeLanStore();
    seedUser(store, "alice", "correct-horse-battery");
    const limiter = fakeLoginLimiter();
    const admission: KdfAdmissionPort = {
      acquire: async () => ({ ok: false, retryAfterMs: 2_000 }),
    };
    const outcome = await runLanLogin(
      ctx(),
      { username: "alice", password: "correct-horse-battery" },
      { store, kdf: fakeKdf(), limiter, admission },
      Date.now(),
    );
    expect(outcome).toEqual({ status: 429, kind: "admission", retryAfterMs: 2_000 });
  });
});

describe('runLanLogin corrupt KDF params (plan §5.1 "读取校验"; LC review fix, lan-plan.md §15.9 #2)', () => {
  it("a stored user with n out of range fails closed (401), never runs scrypt with the corrupt params, and reports onCorruptKdfParams tagged for db-invalid:kdf logging", async () => {
    const store = fakeLanStore();
    seedUser(store, "alice", "correct-horse-battery", { n: 12_345 /* not a power of 2 */ });
    const seenReasons: Array<{ username: string; reason: string }> = [];
    const outcome = await runLanLogin(
      ctx(),
      { username: "alice", password: "correct-horse-battery" },
      {
        store,
        kdf: fakeKdf(),
        limiter: fakeLoginLimiter(),
        admission: alwaysAdmits(),
        onCorruptKdfParams: (username, reason) => seenReasons.push({ username, reason }),
      },
      Date.now(),
    );
    expect(outcome).toEqual({ status: 401 });
    expect(seenReasons).toHaveLength(1);
    expect(seenReasons[0]!.username).toBe("alice");
    expect(seenReasons[0]!.reason).toMatch(/n=12345/);
  });

  it("a corrupt record still costs exactly one KDF run (constant-work timing, §5.1), using the dummy params rather than the corrupt ones", async () => {
    const store = fakeLanStore();
    seedUser(store, "alice", "correct-horse-battery", { n: 999_999_999 });
    let calls = 0;
    let sawCorruptN = false;
    const kdf = {
      run: async (_password: string, params: { n: number }) => {
        calls++;
        if (params.n === 999_999_999) sawCorruptN = true;
        return new Uint8Array(32);
      },
    };
    await runLanLogin(
      ctx(),
      { username: "alice", password: "correct-horse-battery" },
      { store, kdf, limiter: fakeLoginLimiter(), admission: alwaysAdmits() },
      Date.now(),
    );
    expect(calls).toBe(1);
    expect(sawCorruptN).toBe(false);
  });
});
