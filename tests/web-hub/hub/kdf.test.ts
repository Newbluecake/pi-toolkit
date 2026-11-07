/**
 * plan §5.1: `KdfPort.run` (real scrypt via `node:crypto`), `validateKdfParams`
 * bounds, and default-write params.
 */
import { scrypt as realScrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KdfParams } from "../../../src/web-hub/hub/ports.js";
import {
  computeVerifyTarget,
  createKdf,
  createKdfSemaphore,
  DEFAULT_KDF_KEY_LEN,
  DEFAULT_KDF_N,
  DEFAULT_KDF_P,
  DEFAULT_KDF_R,
  DEFAULT_KDF_SALT_BYTES,
  defaultKdfParams,
  dummyParams,
  effectiveWriteTarget,
  KDF_LEGACY,
  KDF_PHASE2,
  kdfCost,
  maxmemFor,
  needsRehash,
  newKdfParams,
  padParamsFor,
  validateKdfParams,
  type ScryptFn,
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

  it("accepts the boundary values (2^14, 2^17, r=1, r=16, p=1, p=2, salt=16, salt=64)", () => {
    expect(validateKdfParams(rec({ n: 2 ** 14, r: 1, p: 1 }))).toEqual({ ok: true });
    expect(validateKdfParams(rec({ n: 2 ** 14, r: 1, p: 2 }))).toEqual({ ok: true });
    expect(validateKdfParams(rec({ n: 2 ** 17, r: 8, p: 1 }))).toEqual({ ok: true }); // #66 phase-2 target
    expect(validateKdfParams(rec({ n: 2 ** 16, r: 16, p: 1, salt: new Uint8Array(64) }))).toEqual({ ok: true }); // 128 MiB exactly
    expect(validateKdfParams(rec({ n: 2 ** 16, r: 8, p: 2 }))).toEqual({ ok: true });
    expect(validateKdfParams(rec({ salt: new Uint8Array(64) }))).toEqual({ ok: true });
  });

  it("rejects kdf !== 'scrypt'", () => {
    expect(validateKdfParams({ ...rec(), kdf: "other" as never })).toEqual({
      ok: false,
      reason: expect.stringContaining("scrypt"),
    });
  });

  it("rejects non-power-of-2 n, and n outside [2^14..2^17]", () => {
    expect(validateKdfParams(rec({ n: 32000 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ n: 2 ** 13 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ n: 2 ** 18 }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects r/p out of range", () => {
    expect(validateKdfParams(rec({ r: 0 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ r: 17 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ p: 0 }))).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateKdfParams(rec({ p: 3 }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects 128*n*r exceeding 128 MiB even when n/r are individually in range", () => {
    expect(validateKdfParams(rec({ n: 2 ** 17, r: 16 }))).toEqual({ ok: false, reason: expect.any(String) });
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

describe("#66 targets and cost helpers", () => {
  it("KDF_LEGACY is the v0.10 shape and KDF_PHASE2 only raises N to 2^17", () => {
    expect(KDF_LEGACY).toEqual({ n: 32768, r: 8, p: 1, keyLen: 32, saltBytes: 16 });
    expect(KDF_PHASE2).toEqual({ n: 131072, r: 8, p: 1, keyLen: 32, saltBytes: 16 });
    expect(effectiveWriteTarget(false)).toBe(KDF_LEGACY);
    expect(effectiveWriteTarget(true)).toBe(KDF_PHASE2);
    expect(kdfCost(KDF_PHASE2) / kdfCost(KDF_LEGACY)).toBe(4);
  });

  it("newKdfParams carries the target shape with a fresh salt; defaultKdfParams is the legacy alias", () => {
    const a = newKdfParams(KDF_PHASE2);
    const b = newKdfParams(KDF_PHASE2);
    expect(a).toMatchObject({ n: 131072, r: 8, p: 1, keyLen: 32 });
    expect(Buffer.from(a.salt).equals(Buffer.from(b.salt))).toBe(false);
    expect(defaultKdfParams()).toMatchObject({ n: 32768, r: 8, p: 1, keyLen: 32 });
  });

  it("dummyParams has the target cost, the fixed all-zero salt, and is v0.10's DUMMY_PARAMS at the legacy target", () => {
    const d = dummyParams(KDF_LEGACY);
    expect(d).toEqual({ n: 32768, r: 8, p: 1, keyLen: 32, salt: new Uint8Array(16) });
    expect(kdfCost(dummyParams(KDF_PHASE2))).toBe(kdfCost(KDF_PHASE2));
  });

  it("padParamsFor closes the cost gap for every valid stored shape (p ≤ 8, never above the cap) and is undefined at/above the target", () => {
    for (const target of [KDF_LEGACY, KDF_PHASE2]) {
      for (const n of [2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17]) {
        for (const r of [1, 4, 8, 16]) {
          for (const p of [1, 2]) {
            const rec = { n, r, p };
            if (!validateKdfParams({ kdf: "scrypt", ...rec, salt: new Uint8Array(16), hash: new Uint8Array(32) }).ok)
              continue;
            const pad = padParamsFor(rec, target);
            if (kdfCost(rec) >= kdfCost(target)) {
              expect(pad).toBeUndefined();
              continue;
            }
            expect(pad).toBeDefined();
            expect(pad!.n).toBe(rec.n);
            expect(pad!.r).toBe(target.r);
            expect(pad!.p).toBeLessThanOrEqual(8);
            expect(kdfCost(rec) + kdfCost(pad!)).toBeGreaterThanOrEqual(kdfCost(target));
            // never grossly over-compensating: less than one extra `p` step
            expect(kdfCost(rec) + kdfCost(pad!) - kdfCost(target)).toBeLessThan(rec.n * target.r);
          }
        }
      }
    }
  });

  it("computeVerifyTarget follows the strongest valid stored record, ignores corrupt ones, never goes below the write target", () => {
    expect(computeVerifyTarget(KDF_LEGACY, undefined)).toBe(KDF_LEGACY);
    expect(computeVerifyTarget(KDF_LEGACY, { n: 2 ** 14, r: 8, p: 1 })).toBe(KDF_LEGACY);
    expect(computeVerifyTarget(KDF_LEGACY, { n: 2 ** 15, r: 8, p: 1 })).toBe(KDF_LEGACY);
    expect(computeVerifyTarget(KDF_LEGACY, { n: 2 ** 17, r: 8, p: 1 })).toEqual({
      n: 2 ** 17,
      r: 8,
      p: 1,
      keyLen: 32,
      saltBytes: 16,
    });
    expect(computeVerifyTarget(KDF_LEGACY, { n: 2 ** 16, r: 8, p: 2 })).toMatchObject({ n: 2 ** 16, p: 2 });
    // corrupt / out-of-range rows must not drag the timing target (they only ever run the dummy)
    expect(computeVerifyTarget(KDF_LEGACY, { n: 2 ** 20, r: 8, p: 1 })).toBe(KDF_LEGACY);
    expect(computeVerifyTarget(KDF_LEGACY, { n: 12345, r: 8, p: 1 })).toBe(KDF_LEGACY);
    expect(computeVerifyTarget(KDF_PHASE2, { n: 2 ** 15, r: 8, p: 1 })).toBe(KDF_PHASE2);
  });

  it("needsRehash is upgrade-only and never flags a corrupt record", () => {
    const rec = (n: number, r = 8, p = 1) => ({
      kdf: "scrypt" as const,
      n,
      r,
      p,
      salt: new Uint8Array(16),
      hash: new Uint8Array(32),
    });
    expect(needsRehash(rec(2 ** 15), KDF_PHASE2)).toBe(true);
    expect(needsRehash(rec(2 ** 17), KDF_PHASE2)).toBe(false);
    expect(needsRehash(rec(2 ** 17), KDF_LEGACY)).toBe(false); // never downgrade
    expect(needsRehash(rec(2 ** 15), KDF_LEGACY)).toBe(false);
    expect(needsRehash(rec(12345), KDF_PHASE2)).toBe(false);
  });
});

/** A scrypt double whose physical completion the test controls. Each result is `fill(N % 251)`. */
function controlledScrypt() {
  const started: Array<{ n: number; p: number; finish(err?: Error): void }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn: ScryptFn = (_pw, _salt, keyLen, options, cb) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let done = false;
    started.push({
      n: options.N,
      p: options.p,
      finish: (err) => {
        if (done) return;
        done = true;
        inFlight--;
        if (err) cb(err, Buffer.alloc(0));
        else cb(null, Buffer.alloc(keyLen, options.N % 251));
      },
    });
  };
  return { fn, started, inFlight: () => inFlight, maxInFlight: () => maxInFlight };
}
const tick = () => new Promise<void>((r) => setImmediate(r));
const P = (n: number): KdfParams => ({ n, r: 8, p: 1, keyLen: 32, salt: new Uint8Array(16) });

describe("createKdf pool releases on PHYSICAL completion (#66 plan §4.1)", () => {
  it("an aborted caller rejects at once but its slot stays taken until scrypt really calls back", async () => {
    const sc = controlledScrypt();
    const kdf = createKdf({ maxConcurrent: 2, scrypt: sc.fn });
    const ac = [new AbortController(), new AbortController(), new AbortController()];
    const runs = ac.map((c, i) => kdf.run(`pw${i}`, P(16384 + i * 0), { signal: c.signal }));
    const settled = runs.map((r) =>
      r.then(
        () => "ok",
        (e: Error) => `rej:${e.message}`,
      ),
    );
    await tick();
    expect(sc.started).toHaveLength(2); // third is queued behind the pool
    ac[0]!.abort(new Error("gone"));
    await tick();
    await expect(settled[0]).resolves.toBe("rej:gone"); // caller released immediately…
    expect(sc.started).toHaveLength(2); // …but the physical slot is not: 3rd must NOT have started
    expect(sc.inFlight()).toBe(2);
    sc.started[0]!.finish(); // the physical computation completes
    await tick();
    expect(sc.started).toHaveLength(3); // only now does the queued run start
    sc.started[1]!.finish();
    sc.started[2]!.finish();
    await expect(settled[1]).resolves.toBe("ok");
    await expect(settled[2]).resolves.toBe("ok");
    expect(sc.maxInFlight()).toBe(2);
    expect(sc.inFlight()).toBe(0);
  });

  it("an abort while still queued never starts scrypt and never takes a slot", async () => {
    const sc = controlledScrypt();
    const kdf = createKdf({ maxConcurrent: 1, scrypt: sc.fn });
    const first = kdf.run("a", P(16384));
    const ac = new AbortController();
    const queued = kdf.run("b", P(16384), { signal: ac.signal });
    await tick();
    ac.abort(new Error("queued-abort"));
    await expect(queued).rejects.toThrow("queued-abort");
    sc.started[0]!.finish();
    await first;
    await tick();
    expect(sc.started).toHaveLength(1);
    const third = kdf.run("c", P(16384));
    await tick();
    expect(sc.started).toHaveLength(2);
    sc.started[1]!.finish();
    await third;
  });

  it("a scrypt error and a synchronous throw both release the slot", async () => {
    const sc = controlledScrypt();
    const kdf = createKdf({ maxConcurrent: 1, scrypt: sc.fn });
    const bad = kdf.run("a", P(16384));
    await tick();
    sc.started[0]!.finish(new Error("boom"));
    await expect(bad).rejects.toThrow("boom");
    const throwing = createKdf({
      maxConcurrent: 1,
      scrypt: () => {
        throw new Error("sync-throw");
      },
    });
    await expect(throwing.run("x", P(16384))).rejects.toThrow("sync-throw");
    await expect(throwing.run("y", P(16384))).rejects.toThrow("sync-throw"); // slot was freed
  });

  it("abort-flood with REAL scrypt: physical concurrency never exceeds the pool size", async () => {
    let inFlight = 0;
    let max = 0;
    const counting: ScryptFn = (pw, salt, keyLen, options, cb) => {
      inFlight++;
      max = Math.max(max, inFlight);
      (realScrypt as unknown as ScryptFn)(pw, salt, keyLen, options, (err, key) => {
        inFlight--;
        cb(err, key);
      });
    };
    const kdf = createKdf({ maxConcurrent: 2, scrypt: counting });
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      const ac = new AbortController();
      runs.push(kdf.run(`pw${i}`, P(16384), { signal: ac.signal }).catch(() => undefined));
      setTimeout(() => ac.abort(new Error("flood")), 1).unref();
    }
    await Promise.all(runs);
    // callers are gone, but the physical work (and its slots) is still draining: wait for it
    const deadline = Date.now() + 15_000;
    while (inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(inFlight).toBe(0);
    expect(max).toBeLessThanOrEqual(2);
    // and the pool is fully usable again
    expect((await kdf.run("after", P(16384))).byteLength).toBe(32);
  }, 30_000);
});

describe("createKdf().runPadded (#66 D6)", () => {
  it("one pool slot covers real + compensation; resolves with the REAL result only after both finish", async () => {
    const sc = controlledScrypt();
    const kdf = createKdf({ maxConcurrent: 1, scrypt: sc.fn });
    const padded = kdf.runPadded!("pw", P(16384), P(32768));
    let resolved: Uint8Array | undefined;
    void padded.then((v) => (resolved = v));
    const next = kdf.run("other", P(65536)); // queued behind the single slot
    await tick();
    expect(sc.started.map((s) => s.n)).toEqual([16384]);
    sc.started[0]!.finish();
    await tick();
    expect(sc.started.map((s) => s.n)).toEqual([16384, 32768]); // compensation starts in the SAME slot
    expect(resolved).toBeUndefined(); // real result withheld until the compensation completes
    sc.started[1]!.finish();
    await tick();
    expect(resolved).toEqual(new Uint8Array(32).fill(16384 % 251));
    expect(sc.started.map((s) => s.n)).toEqual([16384, 32768, 65536]); // slot handed on exactly once
    sc.started[2]!.finish();
    await next;
    expect(sc.maxInFlight()).toBe(1);
  });

  it("abort during the real pass: caller rejects at once, compensation is skipped, slot freed on the physical callback", async () => {
    const sc = controlledScrypt();
    const kdf = createKdf({ maxConcurrent: 1, scrypt: sc.fn });
    const ac = new AbortController();
    const padded = kdf.runPadded!("pw", P(16384), P(32768), { signal: ac.signal });
    const settled = padded.then(
      () => "ok",
      (e: Error) => e.message,
    );
    const next = kdf.run("n", P(65536));
    await tick();
    ac.abort(new Error("cut"));
    await expect(settled).resolves.toBe("cut");
    expect(sc.started).toHaveLength(1);
    sc.started[0]!.finish();
    await tick();
    expect(sc.started.map((s) => s.n)).toEqual([16384, 65536]); // no compensation pass for the aborted call
    sc.started[1]!.finish();
    await next;
  });

  it("abort during the compensation pass: rejects at once, slot released once, only on the physical callback", async () => {
    const sc = controlledScrypt();
    const kdf = createKdf({ maxConcurrent: 1, scrypt: sc.fn });
    const ac = new AbortController();
    const padded = kdf.runPadded!("pw", P(16384), P(32768), { signal: ac.signal });
    const settled = padded.then(
      () => "ok",
      (e: Error) => e.message,
    );
    const next = kdf.run("n", P(65536));
    await tick();
    sc.started[0]!.finish();
    await tick();
    ac.abort(new Error("late"));
    await expect(settled).resolves.toBe("late");
    expect(sc.started.map((s) => s.n)).toEqual([16384, 32768]); // next still waiting: slot held
    sc.started[1]!.finish();
    await tick();
    expect(sc.started.map((s) => s.n)).toEqual([16384, 32768, 65536]);
    sc.started[2]!.finish();
    await next;
  });

  it("an error in the real pass rejects, skips the compensation and frees the slot; real scrypt result matches run()", async () => {
    const sc = controlledScrypt();
    const kdf = createKdf({ maxConcurrent: 1, scrypt: sc.fn });
    const padded = kdf.runPadded!("pw", P(16384), P(32768));
    await tick();
    sc.started[0]!.finish(new Error("real-fail"));
    await expect(padded).rejects.toThrow("real-fail");
    expect(sc.started).toHaveLength(1);
    const real = createKdf();
    const salt = new Uint8Array(16).fill(5);
    const params = { n: 16384, r: 8, p: 1, keyLen: 32, salt };
    const a = await real.run("pw", params);
    const b = await real.runPadded!("pw", params, { ...params, n: 16384, p: 2, salt: new Uint8Array(16) });
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });
});
