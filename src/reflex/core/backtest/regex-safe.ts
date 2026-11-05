/**
 * jev-reflex · #25 B2 regex-safe — the ONLY producer of draft intent template sources (BA §4.4,
 * plan B2 step 1). Draft templates are never hand-written regex strings: the generator builds
 * DRX ASTs and emits them through `drxToSource`, so every product is canonical and stays inside
 * the finite grammar by construction. Each product is round-trip verified with `parseDrx` — an
 * emission that would not parse back is a GENERATOR bug, reported as `{ok:false}` and never
 * emitted (defence in depth on top of `validateDraft` rule ⑥).
 *
 * `<n>` placeholders become `\d{1,4}` (at most one per branch, non-digit literal neighbours —
 * enforced HERE before emission, mirroring the parser's own rule); the only optional tail is the
 * fixed `(?:吗|呢)?`. Pure functions, pi-free (R-I10), no module-scope mutable state (I4).
 */

import { drxToSource, parseDrx, type DrxSeq, type DrxUnit } from "../draft-regex.js";

/** A built source: `{ok:true, src}` or the reason the requested shape is not expressible. */
export type SafeSource = { readonly ok: true; readonly src: string } | { readonly ok: false; readonly problem: string };

/** One piece of a strong branch: a literal run, or the single bounded digit unit. */
export type StrongPart = { readonly t: "lit"; readonly text: string } | { readonly t: "digits" };

const IS_DIGIT = /[0-9]/;

/**
 * Build ONE strong alternation branch (emitted as a standalone source — `intent.strong` holds one
 * entry per branch, so tightening = removing entries, never re-joining a shared alternation).
 * Rejects: no parts, empty literal runs, a second `\d{1,4}`, or a digit literal adjacent to the
 * digit unit (the parser would reject the emission; failing here keeps the caller in control).
 */
export function branchSource(parts: readonly StrongPart[], opts?: { readonly tail?: boolean }): SafeSource {
  const units: DrxUnit[] = [];
  let digits = 0;
  for (const [i, part] of parts.entries()) {
    if (part.t === "digits") {
      digits += 1;
      if (digits > 1) return { ok: false, problem: "a strong branch may contain at most one \\d{1,4}" };
      const before = parts[i - 1];
      if (before !== undefined && before.t === "lit" && IS_DIGIT.test(before.text[before.text.length - 1]!))
        return { ok: false, problem: "the literal before \\d{1,4} must not end with a digit" };
      const after = parts[i + 1];
      if (after !== undefined && after.t === "lit" && IS_DIGIT.test(after.text[0]!))
        return { ok: false, problem: "the literal after \\d{1,4} must not start with a digit" };
      units.push({ t: "digits" });
      continue;
    }
    if (part.text.length === 0) return { ok: false, problem: "empty literal part" };
    for (const ch of part.text) units.push({ t: "lit", ch });
  }
  if (units.length === 0) return { ok: false, problem: "empty branch" };
  const seq: DrxSeq = { units, ...(opts?.tail === true ? { tail: "吗|呢" as const } : {}) };
  const src = drxToSource({ role: "strong", seqs: [seq] });
  const back = parseDrx(src, "strong");
  if (!back.ok) return { ok: false, problem: `generator bug — emission rejected by DRX: ${back.problem}` };
  return { ok: true, src };
}

/**
 * Build a weak/exclude source: a pure-literal substring anchor (DRX `LIT{1,40}`, ≤160 chars,
 * enforced by the round-trip parse). Digits are ordinary literals here — weak/exclude carry no
 * quantifiers, so digit runs cannot blow up match cost.
 */
export function literalSource(text: string, role: "weak" | "exclude"): SafeSource {
  if (text.length === 0) return { ok: false, problem: "empty literal" };
  const src = drxToSource({ role, lits: Array.from(text) });
  const back = parseDrx(src, role);
  if (!back.ok) return { ok: false, problem: `literal rejected by DRX: ${back.problem}` };
  return { ok: true, src };
}
