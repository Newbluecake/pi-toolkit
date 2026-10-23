/**
 * Encrypted-session env contract — pure, zero imports (data-encryption plan r4 §2.4/§2.5/§2.7).
 *
 * Shared with the launcher (P1, `src/secure/bin/helper.mjs`) by CONTRACT, not by import; the
 * parity fixture `tests/fixtures/secure-contract-parity.json` pins `hubSafeEnv` for both sides.
 *
 *   PI_SECURE_VAULT=<name>    launcher `run`: explicit domain (must be a registered, valid vault)
 *   PI_SECURE_SESSION=1       launcher `run`; the plugin also sets it in a secure domain
 *                             (traffic-record & co. skip persisting bodies — plan §2.6)
 *   PI_SECURE_ORIG_ENV        JSON {"TMPDIR": orig|null, "ARMORY_MEMORY_ROOT": orig|null}; written by
 *                             whichever side first enters secure (launcher pre-writes it; the plugin
 *                             writes it only when absent) — never overwritten
 *   TMPDIR / ARMORY_MEMORY_ROOT  <state>/tmp, <state>/memory in a secure domain
 *
 * Also imported by hub code (`web-hub/hub/spawn/supervisor.ts`): keep it import-free (boundary closure).
 */

export const PI_SECURE_PREFIX = "PI_SECURE_";
export const PI_SECURE_VAULT = "PI_SECURE_VAULT";
export const PI_SECURE_SESSION = "PI_SECURE_SESSION";
export const PI_SECURE_ORIG_ENV = "PI_SECURE_ORIG_ENV";
/** The env keys a secure domain overrides and `hubSafeEnv` restores. Order is the JSON key order. */
export const PI_SECURE_RESTORED_KEYS = ["TMPDIR", "ARMORY_MEMORY_ROOT"] as const;

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Parse PI_SECURE_ORIG_ENV. Malformed ⇒ undefined. Per key: string ⇒ restore, null ⇒ delete, missing ⇒ undefined. */
export function parseOrigEnv(raw: string | undefined): Partial<Record<string, string | null>> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Partial<Record<string, string | null>> = {};
    for (const key of PI_SECURE_RESTORED_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === "string" || v === null) out[key] = v;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The ORIG snapshot for the current env (what to write into PI_SECURE_ORIG_ENV). */
export function origEnvSnapshot(env: EnvLike): string {
  const snap: Record<string, string | null> = {};
  for (const key of PI_SECURE_RESTORED_KEYS) snap[key] = env[key] ?? null;
  return JSON.stringify(snap);
}

/**
 * The env a web-hub process (or a hub-managed child) must see: every `PI_SECURE_*` removed and
 * TMPDIR / ARMORY_MEMORY_ROOT restored to their pre-secure values.
 *
 * - No `PI_SECURE_*` key at all ⇒ returns the SAME object (identity — plain/off byte-compat).
 * - ORIG valid: per key, string ⇒ restore, null ⇒ delete, absent ⇒ (secure session ? delete : keep).
 * - ORIG missing/malformed and `PI_SECURE_SESSION=1` ⇒ delete both keys (they point into the vault).
 * - Otherwise the two keys are kept untouched.
 */
export function hubSafeEnv<E extends EnvLike>(env: E): E {
  const keys = Object.keys(env);
  if (!keys.some((k) => k.startsWith(PI_SECURE_PREFIX))) return env;
  const secureSession = env[PI_SECURE_SESSION] === "1";
  const orig = parseOrigEnv(env[PI_SECURE_ORIG_ENV]);
  const out: Record<string, string | undefined> = {};
  for (const k of keys) if (!k.startsWith(PI_SECURE_PREFIX)) out[k] = env[k];
  for (const key of PI_SECURE_RESTORED_KEYS) {
    const v = orig?.[key];
    if (typeof v === "string") out[key] = v;
    else if (v === null || secureSession) delete out[key];
  }
  return out as E;
}
