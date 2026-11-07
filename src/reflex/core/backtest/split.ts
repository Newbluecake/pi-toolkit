/**
 * jev-reflex · #25 B1 family split (BA §4.2 / U3): 60/40 train-vs-holdout by fork-family ROOT
 * session, hashed so the assignment is stable across machines and file moves. Drafts are
 * generated from train only; promotion evidence counts holdout only — both sides of that
 * fence live elsewhere (B2/B5); this module is just the deterministic coin.
 *
 * Pure, pi-free, no state (I4/R-I10).
 */

import { createHash } from "node:crypto";
import type { Split } from "../types.js";

/** Percentage of family roots assigned to train (U3: 60/40). */
export const SPLIT_TRAIN_PERCENT = 60;

/**
 * `sha256(rootKey)` first 4 bytes, big-endian, mod 100 — "train" below the threshold.
 * `rootKey` is the root session's header id (stable under file renames; the same family
 * always lands on the same side). Deterministic: identical inputs across processes.
 */
export function splitOfRoot(rootKey: string): "train" | "holdout" {
  const bytes = createHash("sha256").update(rootKey, "utf8").digest();
  const prefix = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return prefix % 100 < SPLIT_TRAIN_PERCENT ? "train" : "holdout";
}

/**
 * A Turn's split given its family root: no root ⇔ unresolved ⇔ "unscored" (regression
 * report only — never train, never holdout; BA §4.2 / BD4).
 */
export function splitForRoot(rootKey: string | undefined): Split {
  return rootKey === undefined ? "unscored" : splitOfRoot(rootKey);
}
