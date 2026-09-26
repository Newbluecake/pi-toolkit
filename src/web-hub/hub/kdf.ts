/**
 * KDF port implementation (plan §5.1; `hub/kdf.ts`, S1-W2 LS 包 / LC review-fix
 * 包 B, lan-plan.md §15.9 #2): an async wrapper over `node:crypto`'s scrypt
 * for `KdfPort.run`, now *with* §5.1's "并发 2，内存预算 64 MiB" pool — the pool
 * lives here (not in `hub/kdf-admission.ts`) so it applies to *every* caller
 * of `KdfPort.run`, regardless of how (or whether) that caller went through
 * §6.2's fair-scheduling admission queue first. `run()` acquires one of
 * `KDF_POOL_MAX_CONCURRENT` (2) semaphore slots — queueing internally when
 * both are taken — before ever calling `node:crypto`'s `scrypt`, and always
 * releases the slot in a `finally` (a thrown/aborted run still frees it).
 * Memory: every *validated* stored record's `maxmem` is ≤ 32 MiB
 * (`validateKdfParams`'s own `128·n·r ≤ 32 MiB` bound below), so concurrency
 * 2 alone keeps two stored-record KDF runs within the 64 MiB budget;
 * `defaultKdfParams()`'s *new-write* shape (≈ 33 MiB, used only by the rare
 * admin `setPassword` path, never by the LAN login/attack surface) means two
 * concurrent password changes can reach ≈ 66 MiB — accepted (lan-plan.md
 * §15.9 #2), not enforced by a separate byte-accounting admission layered on
 * top of the concurrency limit.
 *
 * `hub/kdf-admission.ts`'s `KdfAdmissionPort.acquire()` remains §6.2's own
 * concern (rate/fairness *admission* into a login attempt, before this pool
 * is ever touched) and its `release()` is correctly a no-op — it already
 * hands the waiter its result at grant time, before the caller has even
 * called `kdf.run()`; there is nothing left for it to release once this
 * module's own semaphore is what actually gates concurrent scrypt calls.
 *
 * Also exports `validateKdfParams` (§5.1 "读取校验" — every field read back
 * from storage must be re-validated before it's fed to `scrypt`, since a
 * corrupted row could otherwise be turned into an memory/time DoS) and the
 * default parameters for *new* password writes.
 */
import { randomBytes, scrypt as scryptAsync } from "node:crypto";
import type { KdfParams, KdfPort, LanUserRecord, PortOptions } from "./ports.js";

// ---------------------------------------------------------------------------
// §5.1 "参数" — new-write defaults
// ---------------------------------------------------------------------------

export const DEFAULT_KDF_N = 32768;
export const DEFAULT_KDF_R = 8;
export const DEFAULT_KDF_P = 1;
export const DEFAULT_KDF_KEY_LEN = 32;
export const DEFAULT_KDF_SALT_BYTES = 16;

export function maxmemFor(n: number, r: number): number {
  return 128 * n * r + 1024 * 1024;
}

export function defaultKdfParams(): KdfParams {
  return {
    n: DEFAULT_KDF_N,
    r: DEFAULT_KDF_R,
    p: DEFAULT_KDF_P,
    keyLen: DEFAULT_KDF_KEY_LEN,
    salt: randomBytes(DEFAULT_KDF_SALT_BYTES),
  };
}

// ---------------------------------------------------------------------------
// §5.1 "读取校验" — bounds every stored KDF record must satisfy
// ---------------------------------------------------------------------------

const N_MIN = 2 ** 14; // 16384
const N_MAX = 2 ** 16; // 65536
const R_MIN = 1;
const R_MAX = 16;
const P_MIN = 1;
const P_MAX = 2;
const MAX_MAXMEM_BYTES = 32 * 1024 * 1024; // 128·N·r ≤ 32 MiB
const SALT_MIN_BYTES = 16;
const SALT_MAX_BYTES = 64;
const HASH_BYTES = 32;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * §5.1: "全部是安全整数；N 为 2 的幂且在 2^14..2^16；r 在 1..16；p 在 1..2；
 * 128·N·r ≤ 32 MiB；salt 16..64B；hash 恰好 32B；kdf==='scrypt'。任一不满足
 * ⇒ corrupt". Takes the subset of `LanUserRecord` the check applies to so
 * callers can pass either a full record or just the KDF-relevant fields.
 */
export function validateKdfParams(
  rec: Pick<LanUserRecord, "kdf" | "n" | "r" | "p" | "salt" | "hash">,
): { ok: true } | { ok: false; reason: string } {
  if (rec.kdf !== "scrypt") return { ok: false, reason: "kdf !== 'scrypt'" };
  for (const [name, v] of [
    ["n", rec.n],
    ["r", rec.r],
    ["p", rec.p],
  ] as const) {
    if (!Number.isSafeInteger(v)) return { ok: false, reason: `${name} is not a safe integer` };
  }
  if (!isPowerOfTwo(rec.n) || rec.n < N_MIN || rec.n > N_MAX) {
    return { ok: false, reason: `n=${rec.n} out of range [${N_MIN}..${N_MAX}] or not a power of 2` };
  }
  if (rec.r < R_MIN || rec.r > R_MAX) return { ok: false, reason: `r=${rec.r} out of range [${R_MIN}..${R_MAX}]` };
  if (rec.p < P_MIN || rec.p > P_MAX) return { ok: false, reason: `p=${rec.p} out of range [${P_MIN}..${P_MAX}]` };
  if (128 * rec.n * rec.r > MAX_MAXMEM_BYTES) {
    return { ok: false, reason: `128*n*r=${128 * rec.n * rec.r} exceeds ${MAX_MAXMEM_BYTES}` };
  }
  const saltLen = rec.salt.byteLength;
  if (saltLen < SALT_MIN_BYTES || saltLen > SALT_MAX_BYTES) {
    return { ok: false, reason: `salt length ${saltLen} out of range [${SALT_MIN_BYTES}..${SALT_MAX_BYTES}]` };
  }
  if (rec.hash.byteLength !== HASH_BYTES) {
    return { ok: false, reason: `hash length ${rec.hash.byteLength} !== ${HASH_BYTES}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §5.1 "池" — concurrency=2 semaphore (LC review-fix, lan-plan.md §15.9 #2)
// ---------------------------------------------------------------------------

export const KDF_POOL_MAX_CONCURRENT = 2;

interface Waiter {
  resolve(release: () => void): void;
  reject(err: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** A tiny counting semaphore: `acquire()` resolves with a `release()` callback once a slot is
 * free (queueing internally otherwise); `release()` is idempotent. Exported so it can be unit
 * tested in isolation (deterministic, no real `scrypt` calls) — `createKdf()` below is the only
 * production caller. */
export function createKdfSemaphore(maxConcurrent: number): { acquire(signal?: AbortSignal): Promise<() => void> } {
  let active = 0;
  const waiters: Waiter[] = [];

  function handOff(): void {
    const next = waiters.shift();
    if (next === undefined) {
      active--;
      return;
    }
    if (next.signal !== undefined && next.onAbort !== undefined) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    // Slot count is unchanged: it moves directly from the releasing holder to `next`.
    next.resolve(makeRelease());
  }

  function makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      handOff();
    };
  }

  function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(toAbortError(signal));
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve(makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal !== undefined) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(toAbortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  return { acquire };
}

function runScryptOnce(password: string, params: KdfParams, opts: PortOptions | undefined): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    if (opts?.signal?.aborted === true) {
      reject(toAbortError(opts.signal));
      return;
    }
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(toAbortError(opts?.signal));
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    scryptAsync(
      password,
      Buffer.from(params.salt),
      params.keyLen,
      { N: params.n, r: params.r, p: params.p, maxmem: maxmemFor(params.n, params.r) },
      (err, derivedKey) => {
        opts?.signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        resolve(new Uint8Array(derivedKey.buffer, derivedKey.byteOffset, derivedKey.byteLength));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// §5.1 KdfPort
// ---------------------------------------------------------------------------

export function createKdf(opts: { maxConcurrent?: number } = {}): KdfPort {
  const pool = createKdfSemaphore(opts.maxConcurrent ?? KDF_POOL_MAX_CONCURRENT);
  return {
    async run(password: string, params: KdfParams, callOpts?: PortOptions): Promise<Uint8Array> {
      const release = await pool.acquire(callOpts?.signal);
      try {
        return await runScryptOnce(password, params, callOpts);
      } finally {
        release();
      }
    },
  };
}

function toAbortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "web-hub kdf: aborted");
}
