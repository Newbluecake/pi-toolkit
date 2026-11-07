/**
 * Pure cross-session receive/session-id rules that used to sit in `config/settings.ts` (#56 batch 2 ⑧; batch 1
 * Q1 deferred them here). No pi, no runtime imports — the mode type comes from `../settings.js` (type-only).
 */
import type { FabricXsReceiveMode } from "../settings.js";

/**
 * `effectiveReceive` (reply-plan §8.1, RX0 — the ONE downgrade rule, a pure function):
 * `replies` with the reply feature unavailable ⇒ `off`. Never `wake`, never any other value —
 * fail closed, same direction as the membership-entry `receivePref` persistence.
 */
export function effectiveReceive(pref: FabricXsReceiveMode, replyEnabled: boolean): FabricXsReceiveMode {
  return pref === "replies" && !replyEnabled ? "off" : pref;
}

/**
 * Full session-id shape, mirroring pi 1.3's `assertValidSessionId` regex
 * (`node_modules/…/dist/core/session-manager.js`): non-empty, only `[A-Za-z0-9._-]`, must start
 * and end with an alphanumeric. Kept as a local literal (no import needed; pi-free).
 */
export const FABRIC_XS_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Validate one `allowFrom` entry (review #14): full session ids only. */
export function isValidXsSessionId(id: string): boolean {
  return FABRIC_XS_SESSION_ID_RE.test(id);
}
