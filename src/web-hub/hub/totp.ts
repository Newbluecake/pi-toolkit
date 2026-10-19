/** P0 B contract. Import-free functions can be embedded in db-child via .toString().
 * Crypto is injected INSIDE the child; every candidate comparison must run before deciding. */
export interface TotpCrypto {
  hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
export function totpCode(_secret: Uint8Array, _step: number, _crypto: TotpCrypto): string {
  throw new Error("LAN security P0: TOTP not implemented");
}
/** Highest matching step (t-1,t,t+1); undefined = bad. Store alone owns replay/gen CAS. */
export function verifyTotpCandidates(
  _secret: Uint8Array,
  _code: string,
  _now: number,
  _crypto: TotpCrypto,
): number | undefined {
  throw new Error("LAN security P0: TOTP verification not implemented");
}
