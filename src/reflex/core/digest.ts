/**
 * jev-reflex · request digest (plan R1 step 3; arch §4.8). `node:crypto` only — pi-free.
 * Records never store the original text, just this digest + length; 16 hex chars is enough
 * to key repeat/correction/agreement windows without being a content fingerprint.
 */

import { createHash } from "node:crypto";

/** sha256(norm) truncated to the first 16 hex chars. */
export function requestDigest(norm: string): string {
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16);
}
