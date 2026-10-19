/** Import-free primitives: embedded in the SQLite child with injected crypto. */
export interface TotpCrypto {
  hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

/** RFC 4226 dynamic truncation, RFC 6238 SHA1 / six digits. */
export function totpCode(secret: Uint8Array, step: number, crypto: TotpCrypto): string {
  if (!Number.isSafeInteger(step) || step < 0) throw new Error("Invalid TOTP step");
  const counter = new Uint8Array(8);
  let value = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = value % 256;
    value = Math.floor(value / 256);
  }
  const digest = crypto.hmacSha1(secret, counter);
  if (digest.length !== 20) throw new Error("Invalid SHA1 digest");
  const offset = digest[19]! & 15;
  const binary =
    ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Highest matching step; never short-circuits the three fixed-width comparisons. */
export function verifyTotpCandidates(
  secret: Uint8Array,
  code: string,
  now: number,
  crypto: TotpCrypto,
): number | undefined {
  if (!/^[0-9]{6}$/.test(code) || !Number.isSafeInteger(now) || now < 0) return undefined;
  const input = Uint8Array.from(code, (c) => c.charCodeAt(0));
  const step = Math.floor(now / 30_000);
  let matched: number | undefined;
  for (const candidate of [Math.max(0, step - 1), step, step + 1]) {
    const expected = Uint8Array.from(totpCode(secret, candidate, crypto), (c) => c.charCodeAt(0));
    const equal = crypto.timingSafeEqual(input, expected);
    if (equal) matched = candidate;
  }
  return matched;
}
