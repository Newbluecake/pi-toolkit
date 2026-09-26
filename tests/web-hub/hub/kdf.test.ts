/**
 * plan §5.1: `KdfPort.run` (real scrypt via `node:crypto`), `validateKdfParams`
 * bounds, and default-write params.
 */
import { describe, expect, it } from "vitest";
import {
  createKdf,
  createKdfSemaphore,
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

describe('createKdfSemaphore (plan §5.1 "并发 2"; LC review fix, lan-plan.md §15.9 #2)', () => {
  it("admits up to maxConcurrent immediately, queues the rest", async () => {
    const sem = createKdfSemaphore(2);
    const order: string[] = [];
    let aResolved = false;
    let bResolved = false;
    let cResolved = false;
    void sem.acquire().then(() => {
      aResolved = true;
      order.push("a");
    });
    void sem.acquire().then(() => {
      bResolved = true;
      order.push("b");
    });
    const c = sem.acquire().then((release) => {
      cResolved = true;
      order.push("c");
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(aResolved).toBe(true);
    expect(bResolved).toBe(true);
    expect(cResolved).toBe(false); // 3rd caller queued — both slots already taken
    void c;
  });

  it("releasing a slot hands it directly to the oldest queued waiter (FIFO)", async () => {
    const sem = createKdfSemaphore(1);
    const order: string[] = [];
    const releaseA = await sem.acquire();
    const bPromise = sem.acquire().then((r) => {
      order.push("b");
      return r;
    });
    const cPromise = sem.acquire().then((r) => {
      order.push("c");
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual([]); // both still queued behind a
    releaseA();
    const releaseB = await bPromise;
    expect(order).toEqual(["b"]); // b, not c, gets the freed slot
    releaseB();
    await cPromise;
    expect(order).toEqual(["b", "c"]);
  });

  it("release() is idempotent — calling it twice only frees the slot once", async () => {
    const sem = createKdfSemaphore(1);
    const releaseA = await sem.acquire();
    releaseA();
    releaseA(); // must not double-free / hand the same slot to two different waiters
    const releaseB = await sem.acquire();
    let cResolved = false;
    void sem.acquire().then(() => {
      cResolved = true;
    });
    await Promise.resolve();
    expect(cResolved).toBe(false); // only one slot total — b holds it, c is still queued
    releaseB();
  });

  it("an already-aborted signal rejects immediately without consuming a slot", async () => {
    const sem = createKdfSemaphore(1);
    const ac = new AbortController();
    ac.abort(new Error("nope"));
    await expect(sem.acquire(ac.signal)).rejects.toThrow("nope");
    // the single slot is still free — a fresh acquire() resolves immediately.
    let resolved = false;
    void sem.acquire().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("aborting while queued (waiting for a slot) rejects and removes the waiter without ever taking the slot", async () => {
    const sem = createKdfSemaphore(1);
    const releaseA = await sem.acquire();
    const ac = new AbortController();
    const bPromise = sem.acquire(ac.signal);
    ac.abort(new Error("stop waiting"));
    await expect(bPromise).rejects.toThrow("stop waiting");
    // releasing a now hands the slot to a *new* caller (c), proving b was fully removed from the
    // queue rather than left as a dangling entry that would otherwise have been granted next.
    let cGotIt = false;
    void sem.acquire().then(() => {
      cGotIt = true;
    });
    releaseA();
    await Promise.resolve();
    expect(cGotIt).toBe(true);
  });
});

describe("createKdf({ maxConcurrent }) actually bounds concurrent scrypt calls (plan §5.1; LC review fix, lan-plan.md §15.9 #2)", () => {
  it("a 3rd concurrent run() only starts once one of the first two finishes, even though nothing else serializes them", async () => {
    const kdf = createKdf({ maxConcurrent: 2 });
    const params = { n: 32768, r: 8, p: 1, keyLen: 32, salt: new Uint8Array(16) };
    const started: number[] = [];
    const finished: number[] = [];
    const track = (i: number) => {
      started.push(i);
      return kdf.run(`pw-${i}`, params).finally(() => finished.push(i));
    };
    const all = [0, 1, 2].map(track);
    // give the first two real scrypt calls (≈100ms each per lan-plan.md's own measurement) a
    // moment to actually be running before asserting the 3rd hasn't started yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual([0, 1, 2]); // all three *called* run() already (JS-side, synchronous)
    expect(finished.length).toBeLessThan(1); // but none of the real ~100ms scrypt calls have finished yet
    await Promise.all(all);
    expect(finished).toHaveLength(3);
    // the 3rd one couldn't have finished before *both* of the first two slots were free at least
    // once — i.e. it necessarily finished no earlier than whichever of 0/1 finished first.
    const thirdIndex = finished.indexOf(2);
    expect(thirdIndex).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it("a run() that throws (bad scrypt params) still releases its slot for the next queued caller", async () => {
    const kdf = createKdf({ maxConcurrent: 1 });
    const badParams = { n: 32768, r: 8, p: 1, keyLen: 32, salt: new Uint8Array(16) };
    await expect(kdf.run("x", { ...badParams, keyLen: -1 })).rejects.toThrow();
    // if the slot weren't released in a `finally`, this would hang forever instead of resolving.
    const ok = await kdf.run("y", badParams);
    expect(ok.byteLength).toBe(32);
  }, 10_000);
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
