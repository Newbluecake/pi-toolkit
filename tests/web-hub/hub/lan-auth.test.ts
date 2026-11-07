/**
 * `login` (plan §6.1, `hub/lan-auth.ts`, LC) unit tests that don't need a real HTTP
 * server — LC review fixes (lan-plan.md §15.9 #2/#4): the 429 `kind` discriminator that
 * `hub/http.ts` uses to pick `E_RATE` vs. the new `E_LOCKED`, and the §5.1 "读取校验" corrupt-KDF
 * -params fail-closed path. `tests/web-hub/http/lan-login.test.ts` / `lan-password-client.test.ts`
 * cover the same pipeline end-to-end through real HTTP; these are the narrower, deterministic
 * complements for branches that are awkward to force through real admission/rate-limiting timing.
 */
import { describe, expect, it } from "vitest";
import { scryptSync } from "node:crypto";
import { createLanLoginCore } from "../../../src/web-hub/hub/lan-login.js";
import { createAuthRevokeBus } from "../../../src/web-hub/hub/auth-revoke.js";
import { createSecurityEventBus } from "../../../src/web-hub/hub/security-events.js";
import type { LanLoginCoreDeps } from "../../../src/web-hub/hub/ports.js";
import { memLog } from "./helpers.js";
import { kdfMatches, verifyPassword } from "../../../src/web-hub/hub/lan-auth.js";
import { KDF_LEGACY, KDF_PHASE2, kdfCost } from "../../../src/web-hub/hub/kdf.js";
import type { KdfParams, KdfPort, LanUserRecord } from "../../../src/web-hub/hub/ports.js";
async function login(
  ctx: RequestContext,
  body: unknown,
  deps: Pick<LanLoginCoreDeps, "store" | "kdf" | "limiter" | "admission" | "onCorruptKdfParams">,
  now: number,
) {
  const log = memLog();
  const core = createLanLoginCore({
    ...deps,
    approval: { request: async () => "unavailable", close() {} },
    security: createSecurityEventBus(log),
    authRevoke: createAuthRevokeBus(log),
    revokeSse() {},
    log,
    now: () => now,
  });
  try {
    return await core.passwordLogin(ctx, body, "", {
      ua: "",
      signal: new AbortController().signal,
      responseOpen: () => true,
    });
  } finally {
    core.dispose();
  }
}
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

describe("login 429 discriminator (plan §6.2; LC review fix, lan-plan.md §15.9 #4)", () => {
  it('an ordinary per-IP backoff lockout (limiter.admit fails, not saturated) is kind:"backoff"', async () => {
    const store = fakeLanStore();
    seedUser(store, "alice", "correct-horse-battery");
    const limiter: LoginLimiterPort = {
      admit: () => ({ ok: false, retryAfterMs: 30_000 }),
      fail: () => {},
      succeed: () => {},
      unlock: () => {},
    };
    const outcome = await login(
      ctx(),
      { username: "alice", password: "wrong" },
      { store, kdf: fakeKdf(), limiter, admission: alwaysAdmits() },
      Date.now(),
    );
    expect(outcome).toMatchObject({ status: 429, body: { error: "E_LOCKED", retryAfterMs: 30_000 } });
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
    const outcome = await login(
      ctx(),
      { username: "alice", password: "wrong" },
      { store, kdf: fakeKdf(), limiter, admission: alwaysAdmits() },
      Date.now(),
    );
    expect(outcome).toMatchObject({ status: 429, body: { error: "E_RATE", saturated: true, retryAfterMs: 60_000 } });
  });

  it('the KDF fair-scheduling admission queue rejecting (capacity/timeout) is kind:"admission"', async () => {
    const store = fakeLanStore();
    seedUser(store, "alice", "correct-horse-battery");
    const limiter = fakeLoginLimiter();
    const admission: KdfAdmissionPort = {
      acquire: async () => ({ ok: false, retryAfterMs: 2_000 }),
    };
    const outcome = await login(
      ctx(),
      { username: "alice", password: "correct-horse-battery" },
      { store, kdf: fakeKdf(), limiter, admission },
      Date.now(),
    );
    expect(outcome).toMatchObject({ status: 429, body: { error: "E_RATE", retryAfterMs: 2_000 } });
  });
});

describe('login corrupt KDF params (plan §5.1 "读取校验"; LC review fix, lan-plan.md §15.9 #2)', () => {
  it("a stored user with n out of range fails closed (401), never runs scrypt with the corrupt params, and reports onCorruptKdfParams tagged for db-invalid:kdf logging", async () => {
    const store = fakeLanStore();
    seedUser(store, "alice", "correct-horse-battery", { n: 12_345 /* not a power of 2 */ });
    const seenReasons: Array<{ username: string; reason: string }> = [];
    const outcome = await login(
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
    expect(outcome).toMatchObject({ status: 401, body: { error: "E_AUTH" } });
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
    await login(
      ctx(),
      { username: "alice", password: "correct-horse-battery" },
      { store, kdf, limiter: fakeLoginLimiter(), admission: alwaysAdmits() },
      Date.now(),
    );
    expect(calls).toBe(1);
    expect(sawCorruptN).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #66 D6: constant-work compensation (docs/dev/web-hub-auth-hardening/plan.md §4.1/§9 P1)
// ---------------------------------------------------------------------------

/** Records every pool entry (one `run` or `runPadded` call = one pool acquisition) and its work. */
function spyKdf(opts: { padded?: boolean } = {}) {
  const acquisitions: Array<{ via: "run" | "runPadded"; total: number }> = [];
  const runs: KdfParams[] = [];
  const answer = (password: string, params: KdfParams, hash: Uint8Array): Uint8Array =>
    password === "right" && Buffer.from(params.salt).equals(Buffer.alloc(params.salt.length, 7))
      ? hash
      : new Uint8Array(params.keyLen);
  let currentHash = new Uint8Array(32);
  const kdf: KdfPort = {
    async run(password, params) {
      acquisitions.push({ via: "run", total: kdfCost(params) });
      runs.push(params);
      return answer(password, params, currentHash);
    },
    ...(opts.padded === false
      ? {}
      : {
          async runPadded(password: string, params: KdfParams, pad: KdfParams) {
            acquisitions.push({ via: "runPadded", total: kdfCost(params) + kdfCost(pad) });
            runs.push(params, pad);
            return answer(password, params, currentHash);
          },
        }),
  };
  return {
    kdf,
    acquisitions,
    runs,
    setHash(h: Uint8Array) {
      currentHash = h;
    },
  };
}

function rec(over: Partial<LanUserRecord> = {}): LanUserRecord {
  return {
    id: 1,
    username: "alice",
    kdf: "scrypt",
    n: 32768,
    r: 8,
    p: 1,
    salt: new Uint8Array(16).fill(7),
    hash: new Uint8Array(32).fill(9),
    epoch: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

async function matchesWith(
  spy: ReturnType<typeof spyKdf>,
  user: LanUserRecord | undefined,
  password: string,
  verifyTarget?: typeof KDF_PHASE2,
): Promise<boolean> {
  if (user !== undefined) spy.setHash(user.hash);
  return kdfMatches(user, password, {
    store: fakeLanStore(),
    kdf: spy.kdf,
    limiter: fakeLoginLimiter(),
    admission: alwaysAdmits(),
    ...(verifyTarget === undefined ? {} : { kdfPolicy: { verifyTarget } }),
  });
}

describe("kdfMatches constant work (#66 D6)", () => {
  const T = KDF_PHASE2;
  const cases: Array<[string, LanUserRecord | undefined]> = [
    ["unknown user", undefined],
    ["2^17 record", rec({ n: 2 ** 17 })],
    ["2^15 record", rec({ n: 2 ** 15 })],
    ["2^14 record", rec({ n: 2 ** 14 })],
    ["N=2^16 p=2 strong record", rec({ n: 2 ** 16, p: 2 })],
    ["r=1 record", rec({ n: 2 ** 14, r: 1 })],
    ["corrupt record (n=12345)", rec({ n: 12345 })],
    ["corrupt record (bad hash length)", rec({ hash: new Uint8Array(5) })],
  ];

  for (const [label, user] of cases) {
    for (const password of ["right", "wrong"]) {
      it(`${label} / ${password} password: exactly ONE pool acquisition and total work ≥ the verify target (< one step over)`, async () => {
        const spy = spyKdf();
        await matchesWith(spy, user, password, T);
        expect(spy.acquisitions).toHaveLength(1);
        const total = spy.acquisitions[0]!.total;
        expect(total).toBeGreaterThanOrEqual(kdfCost(T));
        // never grossly over the target (one `p` step of the record's own N·T.r at most)
        expect(total - kdfCost(T)).toBeLessThan(Math.max(1, (user?.n ?? T.n) * T.r));
      });
    }
  }

  it("equal-cost records (2^15, 2^17, p=2) all total exactly the target; unknown user and corrupt record run only the dummy", async () => {
    for (const user of [
      undefined,
      rec({ n: 2 ** 17 }),
      rec({ n: 2 ** 15 }),
      rec({ n: 2 ** 16, p: 2 }),
      rec({ n: 777 }),
    ]) {
      const spy = spyKdf();
      await matchesWith(spy, user, "wrong", T);
      expect(spy.acquisitions[0]!.total).toBe(kdfCost(T));
    }
    const dummy = spyKdf();
    await matchesWith(dummy, undefined, "x", T);
    expect(dummy.acquisitions[0]!.via).toBe("run");
    expect(dummy.runs[0]).toMatchObject({ n: T.n, r: T.r, p: T.p, keyLen: 32 });
    expect(Buffer.from(dummy.runs[0]!.salt).equals(Buffer.alloc(16))).toBe(true);
  });

  it("verdicts are unchanged by the compensation (right password matches, wrong one does not)", async () => {
    const user = rec({ n: 2 ** 15 });
    expect(await matchesWith(spyKdf(), user, "right", T)).toBe(true);
    expect(await matchesWith(spyKdf(), user, "wrong", T)).toBe(false);
    expect(await matchesWith(spyKdf(), rec({ n: 777 }), "right", T)).toBe(false);
    expect(await matchesWith(spyKdf(), undefined, "right", T)).toBe(false);
  });

  it("a KdfPort without runPadded falls back to two plain runs, REAL result first", async () => {
    const spy = spyKdf({ padded: false });
    const ok = await matchesWith(spy, rec({ n: 2 ** 15 }), "right", T);
    expect(ok).toBe(true);
    expect(spy.acquisitions.map((a) => a.via)).toEqual(["run", "run"]);
    expect(spy.runs[0]).toMatchObject({ n: 2 ** 15 });
  });

  it("production default (no kdfPolicy) is byte-for-byte v0.10: 2^15 record and unknown user each run exactly one plain 2^15 KDF", async () => {
    for (const user of [undefined, rec({ n: 2 ** 15 }), rec({ n: 777 })]) {
      const spy = spyKdf();
      await matchesWith(spy, user, "wrong");
      expect(spy.acquisitions).toEqual([{ via: "run", total: kdfCost(KDF_LEGACY) }]);
      expect(spy.runs[0]).toMatchObject({ n: 32768, r: 8, p: 1, keyLen: 32 });
    }
  });

  it("production default with a cheaper (2^14) seed gets exactly one compensation (the declared behaviour change)", async () => {
    const spy = spyKdf();
    await matchesWith(spy, rec({ n: 2 ** 14 }), "wrong");
    expect(spy.acquisitions).toHaveLength(1);
    expect(spy.acquisitions[0]).toMatchObject({ via: "runPadded" });
    expect(spy.acquisitions[0]!.total).toBeGreaterThanOrEqual(kdfCost(KDF_LEGACY));
  });

  it("verifyPassword (privacy) shares the same policy: its work equals login's", async () => {
    const store = fakeLanStore();
    store.seedUser(rec({ n: 2 ** 15, username: "alice" }));
    const spy = spyKdf();
    spy.setHash(new Uint8Array(32).fill(9));
    await verifyPassword({ clientIp: "10.0.0.5" }, 1, "wrong", {
      store,
      kdf: spy.kdf,
      limiter: fakeLoginLimiter(),
      admission: alwaysAdmits(),
      kdfPolicy: { verifyTarget: KDF_PHASE2 },
    });
    expect(spy.acquisitions).toHaveLength(1);
    expect(spy.acquisitions[0]!.total).toBe(kdfCost(KDF_PHASE2));
  });
});
