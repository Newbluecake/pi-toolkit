/**
 * KDF port implementation (plan §5.1; `hub/kdf.ts`, S1-W2 LS 包): a thin async
 * wrapper over `node:crypto`'s scrypt for the single "run one KDF op" primitive
 * `KdfPort.run` — no concurrency pool here. §5.1's "并发 2、内存预算 64 MiB、
 * 排队由 §6.2 负责" describes `hub/kdf-admission.ts`'s `KdfAdmissionPort` (LC's
 * package, W2, admits/queues *before* ever calling `run`); this module is the
 * thing that eventually gets called once a caller already holds that slot.
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
// §5.1 KdfPort
// ---------------------------------------------------------------------------

export function createKdf(): KdfPort {
  return {
    run(password: string, params: KdfParams, opts?: PortOptions): Promise<Uint8Array> {
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
    },
  };
}

function toAbortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "web-hub kdf: aborted");
}
