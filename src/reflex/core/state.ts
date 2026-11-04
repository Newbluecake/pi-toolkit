/**
 * jev-reflex · per-script state machine + repeat/correction bookkeeping (plan R1 step 8;
 * arch §4.7, PD5/PD6/PD12). Pure reducers: every function returns a NEW runtime object,
 * nothing mutates in place, no module state (I4). Callers (R2b/R3a) keep runtimes inside the
 * `wireReflex` closure (R-I8).
 *
 * PD5 (root ruling 2026-11-05): `onRepeat`/`onCorrected` take an OPTIONAL effective state —
 * when supplied and not "auto" they never demote; the two-arg form demotes unconditionally and
 * is reserved for call sites that are in the AUTO branch by construction.
 */

import { CORRECTION_RE } from "./gate.js";
import { requestDigest } from "./digest.js";
import { CORRECTION_WINDOW_MS, DEMOTE_AFTER_STRIKES } from "./budget.js";
import type { ExecOutcome, ReflexCorrectionV1, ScriptRuntime, ScriptState } from "./types.js";

export function effectiveState(id: string, autoResolve: readonly string[], rt: ScriptRuntime): ScriptState {
  if (rt.demoted) return "demoted";
  return autoResolve.includes(id) ? "auto" : "shadow";
}

export interface ExecOutcomeResult {
  rt: ScriptRuntime;
  /** True exactly once, when the demote overlay was set by THIS call (caller notifies once). */
  demotedNow: boolean;
}

/**
 * Strike accounting: error|timeout ⇒ +1 strike, `DEMOTE_AFTER_STRIKES` consecutive strikes set
 * the overlay (reason "strikes"); ok ⇒ strikes reset to 0 (the overlay itself persists until
 * `/reflex reset` or `/reload` — arch §4.7); uncertain|unavailable ⇒ untouched (no strike).
 */
export function onExecOutcome(rt: ScriptRuntime, o: ExecOutcome, now: number): ExecOutcomeResult {
  if (o.kind === "ok") return { rt: { ...rt, strikes: 0 }, demotedNow: false };
  if (o.kind === "uncertain" || o.kind === "unavailable") return { rt, demotedNow: false };
  const strikes = rt.strikes + 1;
  if (!rt.demoted && strikes >= DEMOTE_AFTER_STRIKES) {
    return {
      rt: { ...rt, strikes, demoted: true, demotedAt: now, demoteReason: "strikes" },
      demotedNow: true,
    };
  }
  return { rt: { ...rt, strikes }, demotedNow: false };
}

function demoteFor(
  rt: ScriptRuntime,
  now: number,
  reason: "repeat" | "corrected",
  state: ScriptState | undefined,
): ExecOutcomeResult {
  if (state !== undefined && state !== "auto") return { rt, demotedNow: false }; // PD5
  if (rt.demoted) return { rt, demotedNow: false }; // overlay set: the first reason wins
  return { rt: { ...rt, demoted: true, demotedAt: now, demoteReason: reason }, demotedNow: true };
}

/** PD5: an AUTO script that re-asked the same question demotes immediately (reason "repeat"). */
export function onRepeat(rt: ScriptRuntime, now: number, state?: ScriptState): ExecOutcomeResult {
  return demoteFor(rt, now, "repeat", state);
}

/** PD5: an AUTO answer that got corrected demotes immediately (reason "corrected"). */
export function onCorrected(rt: ScriptRuntime, now: number, state?: ScriptState): ExecOutcomeResult {
  return demoteFor(rt, now, "corrected", state);
}

/** `/reflex reset [id]`: clears strikes AND the demote overlay (pure — returns a fresh runtime). */
export function reset(rt: ScriptRuntime): ScriptRuntime {
  return { strikes: 0, demoted: false };
}

/** The most recent candidate (shadow) or reflex answer, as kept by the wire's memo. */
export interface CorrectionMemo {
  kind: "shadow" | "answer";
  scriptId: string;
  scriptVer: number;
  digest: string;
  /** When the candidate settled / the answer was sent (window anchor, PD12). */
  settledAt: number;
  /** Already corrected once — each target is recorded at most once. */
  corrected: boolean;
}

/**
 * PD12: pure detection. A correction counts when the normalized input hits `CORRECTION_RE`,
 * the memo exists, is un-corrected, and `now` is within `CORRECTION_WINDOW_MS` after
 * `settledAt`. Returns the entry to persist (`subagent:reflex-correction`) or undefined;
 * flipping `memo.corrected` (and demoting an AUTO target) is the caller's job.
 */
export function detectCorrection(
  norm: string,
  memo: CorrectionMemo | undefined,
  now: number,
): ReflexCorrectionV1 | undefined {
  if (memo === undefined) return undefined;
  if (memo.corrected) return undefined;
  const delta = now - memo.settledAt;
  if (delta < 0 || delta > CORRECTION_WINDOW_MS) return undefined;
  if (!CORRECTION_RE.test(norm)) return undefined;
  return {
    v: 1,
    at: now,
    targetKind: memo.kind,
    targetScriptId: memo.scriptId,
    targetScriptVer: memo.scriptVer,
    targetDigest: memo.digest,
    deltaMs: delta,
    correctionDigest: requestDigest(norm),
  };
}
