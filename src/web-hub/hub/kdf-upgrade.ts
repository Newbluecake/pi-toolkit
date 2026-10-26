/** #66 P2: opportunistic, login-only rehash. No queue (and therefore no queued plaintext),
 * one global job / per-user single flight, bounded failure cooldown, shared physical KDF pool.
 * A port ignoring abort keeps the sole slot quarantined until it settles; late results never
 * write. Production KDF/DB ports reject promptly on abort; physical scrypt is bounded by P1.
 * The HTTP frontend owns disposal. No mutable module-level state or externally awaited work. */
import { kdfCost, needsRehash, newKdfParams, validateKdfParams, type KdfShape } from "./kdf.js";
import type { HubLog, KdfPort, LanStorePort, LanUserRecord } from "./ports.js";

export interface KdfUpgrader {
  maybeRehash(user: LanUserRecord, password: string): void;
  dispose(): void;
}

const DEADLINE_MS = 20_000;
const COOLDOWN_MS = 300_000;
const COOLDOWN_MAX = 256;
// Mirror of core/deadline.ts (pi-free hub boundary): invalid spans use the safe default.
function clampSpanMs(ms: number): number | undefined {
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return Math.min(ms, 365 * 86_400_000);
}

export function createKdfUpgrader(deps: {
  kdf: KdfPort;
  store: Pick<LanStorePort, "rehashPassword">;
  log: HubLog;
  now(): number;
  target: KdfShape;
  deadlineMs?: number;
  cooldownMs?: number;
}): KdfUpgrader {
  // Test overrides may shorten bounds, but cannot turn an opportunistic job into a long timer.
  const deadlineMs = Math.min(DEADLINE_MS, clampSpanMs(deps.deadlineMs ?? DEADLINE_MS) ?? DEADLINE_MS);
  const cooldownMs = Math.min(COOLDOWN_MS, clampSpanMs(deps.cooldownMs ?? COOLDOWN_MS) ?? COOLDOWN_MS);
  const cooldown = new Map<number, number>();
  let disposed = false;
  let active: { abort: AbortController; timer: ReturnType<typeof setTimeout>; clearSecret(): void } | undefined;

  return {
    maybeRehash(user, password) {
      if (disposed || active || !deps.store.rehashPassword || !needsRehash(user, deps.target)) return;
      const now = deps.now();
      for (const [id, until] of cooldown) if (until <= now) cooldown.delete(id);
      if (cooldown.has(user.id)) return;
      // Copy byte arrays: a fake/caller mutating the verified snapshot cannot change the CAS.
      const old = { n: user.n, r: user.r, p: user.p, salt: user.salt.slice(), hash: user.hash.slice() };
      const userId = user.id;
      const abort = new AbortController();
      let secret = password;
      const clearSecret = () => {
        secret = "";
      };
      let failed = false;
      const fail = (code: "E_DEADLINE" | "E_REHASH" | "E_STALE") => {
        if (disposed || failed) return;
        failed = true;
        if (!cooldown.has(userId) && cooldown.size >= COOLDOWN_MAX) cooldown.delete(cooldown.keys().next().value!);
        cooldown.set(userId, deps.now() + cooldownMs);
        // Never pass raw errors (including message/stack), username, salt, hash or password.
        try {
          deps.log.warn("web-hub kdf upgrade failed", {
            userId,
            fromCost: kdfCost(old),
            toCost: kdfCost(deps.target),
            code,
          });
        } catch {
          /* a broken logger must not reject login or leak an unhandled rejection */
        }
      };
      const job = {
        abort,
        clearSecret,
        timer: setTimeout(() => {
          clearSecret();
          fail("E_DEADLINE");
          abort.abort();
        }, deadlineMs),
      };
      job.timer.unref();
      active = job;
      // Do not run the expensive computation synchronously on the login stack.
      void Promise.resolve()
        .then(async () => {
          if (disposed || abort.signal.aborted) return;
          const params = newKdfParams(deps.target);
          const computation = deps.kdf.run(secret, params, { signal: abort.signal });
          // Drop our plaintext reference immediately after handing it to scrypt; it is never
          // retained through DB work, or by an abort-ignoring port's pending promise.
          clearSecret();
          const hash = await computation;
          if (disposed || abort.signal.aborted) return;
          const next = { n: params.n, r: params.r, p: params.p, salt: params.salt, hash };
          if (!validateKdfParams({ ...next, kdf: "scrypt" }).ok) {
            fail("E_REHASH");
            return;
          }
          const result = await deps.store.rehashPassword!({ userId, old, next }, { signal: abort.signal });
          if (!result.ok) fail("E_STALE");
        })
        .catch(() => fail("E_REHASH"))
        .finally(() => {
          clearSecret();
          clearTimeout(job.timer);
          if (active === job) active = undefined;
        });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) {
        active.clearSecret();
        clearTimeout(active.timer);
        active.abort.abort();
      }
      cooldown.clear();
    },
  };
}
