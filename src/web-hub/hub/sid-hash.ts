/**
 * Shared session-id hashing helper (plan §6.4 "库中只存 sha256(sid)"; LC review fix,
 * lan-plan.md §15.9 #4/#5 -- actually the sid-hash dedup item, see docs list item 5):
 * `hub/lan-auth.ts` (the HTTP-facing cookie/session glue, LC) and `hub/lan-store.ts`
 * (the SQLite-backed store, LS) each need the exact same `sha256(sid) -> base64url`
 * scheme -- a raw session id only ever exists on the wire (the `pwh_lan` cookie) and
 * in this one hashing step; every persisted/looked-up form is the hash. Pulling this
 * one-liner out to a pi-free module (no imports beyond `node:crypto`) means both
 * call sites are byte-for-byte guaranteed to agree, instead of relying on two
 * independent implementations happening to stay in sync.
 */
import { createHash } from "node:crypto";

/** `sha256(sid)`, base64url -- the only hashing scheme `pwh_lan` session ids use. */
export function hashSid(sid: string): string {
  return createHash("sha256").update(sid).digest("base64url");
}
