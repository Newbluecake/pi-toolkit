// #36 arch r5 §5.4 — auto-supersede thresholds. SINGLE SOURCE OF TRUTH: the
// tuning knobs live here and nowhere else (PG 调参只改这里；其它文件不得出
// 现这些字面量). P4 creates this module with the constants only — the write
// path's relation VERDICTS (write-port.ts) apply them at judgment time; the
// EXECUTION side (lock-internal seven-condition recheck + CAS replace) lands
// in P5a, which EXTENDS this file (root ruling 2026-11-06: P4 先建、P5a 改为
// 修改此文件). Pi-free.

/** Relation choice `supersedes` at or above this probability is auto-executed
 *  (matrix permitting). */
export const SUPERSEDE_AUTO_P = 0.85;

/** Relation choice `conflict` at or above this probability is auto-executed
 *  (matrix permitting). Between 0.75 and the threshold only a `conflict`
 *  review suggestion is emitted. */
export const CONFLICT_AUTO_P = 0.9;

/** Auto-executed relations per write, user+agent combined; the rest stay
 *  suggestions. */
export const AUTO_PER_WRITE_MAX = 2;
