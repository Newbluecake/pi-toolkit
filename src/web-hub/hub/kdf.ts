/**
 * KDF port implementation (plan §5.1; `hub/kdf.ts`, S1-W2 LS 包 / LC review-fix
 * 包 B, lan-plan.md §15.9 #2): an async wrapper over `node:crypto`'s scrypt
 * for `KdfPort.run` with §5.1's "并发 2" pool. The pool lives here (not in
 * `hub/kdf-admission.ts`) so it applies to *every* caller of `KdfPort.run`,
 * regardless of how (or whether) that caller went through §6.2's
 * fair-scheduling admission queue first.
 *
 * #66 hardening (docs/dev/web-hub-auth-hardening/plan.md §4.1): a pool slot is released when the
 * *physical* scrypt computation completes — NOT when the caller aborts. A caller's `AbortSignal`
 * still rejects its promise immediately (so login deadlines keep working), but the libuv thread
 * keeps computing until scrypt calls back, and the slot stays taken until then. Physical
 * concurrency is therefore ≤ `KDF_POOL_MAX_CONCURRENT` (2) regardless of the libuv pool size
 * (4 by default), which both caps memory (2 × ≈129 MiB at N=2^17, instead of 4 ×) and leaves
 * threads for fs/dns. scrypt always calls back (it never hangs), so no slot can leak (I1).
 *
 * `runPadded` (D6 timing compensation): ONE slot acquisition covers the real computation plus a
 * compensation computation, so a cheaper-than-target stored record costs the same pool time and
 * queueing as the dummy path. The caller gets the REAL result only after both finish.
 *
 * `hub/kdf-admission.ts`'s `KdfAdmissionPort.acquire()` remains §6.2's own concern (rate/fairness
 * *admission* into a login attempt, before this pool is ever touched).
 *
 * Also exports `validateKdfParams` (§5.1 "读取校验" — every field read back from storage must be
 * re-validated before it's fed to `scrypt`, since a corrupted row could otherwise be turned into
 * a memory/time DoS) and the parameter helpers for *new* password writes / dummy / padding.
 */
import { randomBytes, scrypt as scryptAsync } from "node:crypto";
import type { KdfParams, KdfPort, LanUserRecord, PortOptions } from "./ports.js";

// ---------------------------------------------------------------------------
// §5.1 "参数" — new-write defaults, targets, cost helpers
// ---------------------------------------------------------------------------

export const DEFAULT_KDF_N = 32768;
export const DEFAULT_KDF_R = 8;
export const DEFAULT_KDF_P = 1;
export const DEFAULT_KDF_KEY_LEN = 32;
export const DEFAULT_KDF_SALT_BYTES = 16;

/** Shape of a KDF cost target (no salt/hash — those are per-record). */
export interface KdfShape {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLen: number;
  readonly saltBytes: number;
}

/** What v0.10 writes (and what phase 1 keeps writing): N=2^15 r=8 p=1. */
export const KDF_LEGACY: KdfShape = Object.freeze({
  n: DEFAULT_KDF_N,
  r: DEFAULT_KDF_R,
  p: DEFAULT_KDF_P,
  keyLen: DEFAULT_KDF_KEY_LEN,
  saltBytes: DEFAULT_KDF_SALT_BYTES,
});

/** The phase-2 write target: N=2^17 (the reader side accepts it from phase 1 on). */
export const KDF_PHASE2: KdfShape = Object.freeze({ ...KDF_LEGACY, n: 2 ** 17 });

/** The write target for the current writer verdict (see `hub/hardening.ts`). */
export function effectiveWriteTarget(writerActive: boolean): KdfShape {
  return writerActive ? KDF_PHASE2 : KDF_LEGACY;
}

/** Relative scrypt work: n·r·p (memory × time proxy used for dummy/padding decisions). */
export function kdfCost(s: { n: number; r: number; p: number }): number {
  return s.n * s.r * s.p;
}

export function maxmemFor(n: number, r: number): number {
  return 128 * n * r + 1024 * 1024;
}

/** Fresh parameters (random salt) for a NEW password write at `target`. */
export function newKdfParams(target: KdfShape): KdfParams {
  return { n: target.n, r: target.r, p: target.p, keyLen: target.keyLen, salt: randomBytes(target.saltBytes) };
}

/** v0.10-compatible alias: `newKdfParams(KDF_LEGACY)`. */
export function defaultKdfParams(): KdfParams {
  return newKdfParams(KDF_LEGACY);
}

/** Fixed-salt parameters shaped like `target` — the "no such user / corrupt record" work. Never protects a secret. */
export function dummyParams(target: KdfShape): KdfParams {
  return { n: target.n, r: target.r, p: target.p, keyLen: target.keyLen, salt: new Uint8Array(target.saltBytes) };
}

const PAD_P_MAX = 64;

/**
 * Compensation parameters so `cost(rec) + cost(pad) ≥ cost(target)`: same N as the record (so the
 * memory footprint is a real, smaller scrypt), `r` of the target, and enough `p` to close the gap
 * (capped at 64 — in the validated parameter range it never exceeds 8). `undefined` ⇒ the record
 * already costs at least as much as `target`; no padding.
 */
export function padParamsFor(rec: { n: number; r: number; p: number }, target: KdfShape): KdfParams | undefined {
  const gap = kdfCost(target) - kdfCost(rec);
  if (!(gap > 0)) return undefined;
  const p = Math.min(PAD_P_MAX, Math.max(1, Math.ceil(gap / (rec.n * target.r))));
  return { n: rec.n, r: target.r, p, keyLen: target.keyLen, salt: new Uint8Array(target.saltBytes) };
}

/**
 * The shape every login/verify is timed against: the stronger of the write target and the
 * strongest stored record (`maxStored`, from the maintenance open check). An out-of-range
 * `maxStored` (a corrupt row) is ignored — corrupt rows only ever run the dummy.
 */
export function computeVerifyTarget(
  writeTarget: KdfShape,
  maxStored: { n: number; r: number; p: number } | undefined,
): KdfShape {
  if (maxStored === undefined) return writeTarget;
  const probe = {
    kdf: "scrypt" as const,
    n: maxStored.n,
    r: maxStored.r,
    p: maxStored.p,
    salt: new Uint8Array(16),
    hash: new Uint8Array(32),
  };
  if (!validateKdfParams(probe).ok) return writeTarget;
  if (kdfCost(maxStored) <= kdfCost(writeTarget)) return writeTarget;
  return {
    n: maxStored.n,
    r: maxStored.r,
    p: maxStored.p,
    keyLen: writeTarget.keyLen,
    saltBytes: writeTarget.saltBytes,
  };
}

/** Upgrade-only: a valid scrypt record cheaper than `target` should be re-hashed (never downgraded). */
export function needsRehash(
  rec: Pick<LanUserRecord, "kdf" | "n" | "r" | "p" | "salt" | "hash">,
  target: KdfShape,
): boolean {
  if (!validateKdfParams(rec).ok) return false;
  return kdfCost(rec) < kdfCost(target);
}

// ---------------------------------------------------------------------------
// §5.1 "读取校验" — bounds every stored KDF record must satisfy
// ---------------------------------------------------------------------------

const N_MIN = 2 ** 14; // 16384
const N_MAX = 2 ** 17; // 131072 (#66: the reader accepts the phase-2 write target)
const R_MIN = 1;
const R_MAX = 16;
const P_MIN = 1;
const P_MAX = 2;
const MAX_MAXMEM_BYTES = 128 * 1024 * 1024; // 128·N·r ≤ 128 MiB
const SALT_MIN_BYTES = 16;
const SALT_MAX_BYTES = 64;
const HASH_BYTES = 32;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * §5.1: "全部是安全整数；N 为 2 的幂且在 2^14..2^17；r 在 1..16；p 在 1..2；
 * 128·N·r ≤ 128 MiB；salt 16..64B；hash 恰好 32B；kdf==='scrypt'。任一不满足
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

/** `crypto.scrypt` shape (injectable for deterministic pool tests). */
export type ScryptFn = (
  password: string,
  salt: Buffer,
  keyLen: number,
  options: { N: number; r: number; p: number; maxmem: number },
  cb: (err: Error | null, derivedKey: Buffer) => void,
) => void;

// ---------------------------------------------------------------------------
// §5.1 KdfPort
// ---------------------------------------------------------------------------

export function createKdf(opts: { maxConcurrent?: number; scrypt?: ScryptFn } = {}): KdfPort {
  const pool = createKdfSemaphore(opts.maxConcurrent ?? KDF_POOL_MAX_CONCURRENT);
  const scrypt: ScryptFn = opts.scrypt ?? (scryptAsync as unknown as ScryptFn);

  /**
   * One pool slot, `passes` run back-to-back (pass 0 is the REAL computation whose result is
   * returned). The slot is released only when the last started pass has physically called back —
   * an abort rejects the caller at once and merely stops later passes from starting.
   */
  async function runInSlot(
    password: string,
    passes: readonly KdfParams[],
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const release = await pool.acquire(signal);
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      let finished = false;
      let real: Uint8Array | undefined;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      const finish = (): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        release();
      };
      const onAbort = (): void => settle(() => reject(toAbortError(signal)));
      if (signal?.aborted === true) {
        finish();
        settle(() => reject(toAbortError(signal)));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const step = (i: number): void => {
        if (i >= passes.length) {
          finish();
          settle(() => resolve(real!));
          return;
        }
        if (i > 0 && signal?.aborted === true) {
          finish();
          return;
        }
        const params = passes[i]!;
        try {
          scrypt(
            password,
            Buffer.from(params.salt),
            params.keyLen,
            { N: params.n, r: params.r, p: params.p, maxmem: maxmemFor(params.n, params.r) },
            (err, derivedKey) => {
              if (err) {
                finish();
                settle(() => reject(err));
                return;
              }
              if (i === 0) real = new Uint8Array(derivedKey.buffer, derivedKey.byteOffset, derivedKey.byteLength);
              step(i + 1);
            },
          );
        } catch (err) {
          finish();
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      };
      step(0);
    });
  }

  return {
    run(password: string, params: KdfParams, callOpts?: PortOptions): Promise<Uint8Array> {
      return runInSlot(password, [params], callOpts?.signal);
    },
    runPadded(password: string, params: KdfParams, pad: KdfParams, callOpts?: PortOptions): Promise<Uint8Array> {
      return runInSlot(password, [params, pad], callOpts?.signal);
    },
  };
}

function toAbortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "web-hub kdf: aborted");
}
