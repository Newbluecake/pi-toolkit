/**
 * jev-reflex · #25 B0 DRX — the finite draft-regex grammar (BA §4.5, Blocker 1 / K4). Draft intent
 * regexes are NOT arbitrary RegExp sources: they must parse under DRX, a deliberately tiny
 * language whose match cost is provably linear-ish in the input length, so a draft file can never
 * smuggle in catastrophic backtracking.
 *
 *   strong  := seq ('|' seq){0,11}            — matched as ^(?:…)$ by compileCatalog (unchanged)
 *   seq     := unit+ tail?
 *   unit    := LIT | DIGITS
 *   LIT     := 非元字符 | '\' 元字符            — 元字符 = \ ^ $ . | ? * + ( ) [ ] { }
 *   DIGITS  := '\d{1,4}'                       — ≤1 per seq; adjacent units must be non-digit LITs
 *                                                or seq boundaries
 *   tail    := '(?:吗|呢)?'                    — fixed literal tail, ≤1 per seq, seq-final only
 *   weak / exclude := LIT{1,40}                — pure literals, substring match
 *
 * Safety argument (BA §4.5): every seq has at most ONE bounded quantifier `\d{1,4}` whose digit
 * class is disjoint from any neighbouring literal character ⇒ ≤4 ways to split at each start; the
 * tail is one of two fixed literals ⇒ ×3; ≤12 alternation branches ⇒ ≤12·4·3 paths per start,
 * total O(12·12·n) for n ≤ 120cp. weak/exclude are literal scans. Nothing here can blow up with
 * input length — which is exactly why the reject set is enforced by the PARSER, not by scanning
 * for suspicious shapes (a blacklist let `(a+)+` shapes through; K4).
 *
 * `parseDrx` never compiles the source as RegExp for matching — it only decides membership.
 * `drxToSource` emits the canonical form (generators build an AST and round-trip through it).
 * Pure functions, no module-scope mutable state (I4).
 */

export type DrxRole = "strong" | "weak" | "exclude";

export type DrxUnit = { readonly t: "lit"; readonly ch: string } | { readonly t: "digits" };

/** One alternation branch of a strong source (`tail` present ⇔ the seq ends with `(?:吗|呢)?`). */
export interface DrxSeq {
  readonly units: readonly DrxUnit[];
  readonly tail?: "吗|呢";
}

export type DrxAst =
  | { readonly role: "strong"; readonly seqs: readonly DrxSeq[] }
  | { readonly role: "weak" | "exclude"; readonly lits: readonly string[] };

export type DrxParseResult =
  { readonly ok: true; readonly ast: DrxAst } | { readonly ok: false; readonly problem: string };

/** Hard length cap for any DRX source (BA §4.5). */
export const DRX_MAX_SOURCE_CHARS = 160;
/** Alternation branches per strong source (≤12, BA §4.5). */
export const DRX_MAX_ALTERNATION = 12;
/** Literal units per weak/exclude source (1–40, BA §4.5). */
export const DRX_MAX_WEAK_LITS = 40;

/** The regex metacharacters that MUST be escaped to appear as literals (BA §4.5). */
const METACHARS = new Set(["\\", "^", "$", ".", "|", "?", "*", "+", "(", ")", "[", "]", "{", "}"]);
const DIGITS_LITERAL = "\\d{1,4}";
const TAIL_LITERAL = "(?:吗|呢)?";
const NON_DIGIT = (ch: string): boolean => !/[0-9]/.test(ch);

/** Recursive-descent cursor over the source. */
class Cursor {
  readonly src: string;
  pos = 0;
  constructor(src: string) {
    this.src = src;
  }
  peek(offset = 0): string | undefined {
    return this.src[this.pos + offset];
  }
  startsWith(lit: string): boolean {
    return this.src.startsWith(lit, this.pos);
  }
  eat(lit: string): boolean {
    if (this.startsWith(lit)) {
      this.pos += lit.length;
      return true;
    }
    return false;
  }
  eof(): boolean {
    return this.pos >= this.src.length;
  }
}

/** LIT := one non-metachar char, or '\' + metachar. Returns the literal CHARACTER it denotes. */
function parseLit(c: Cursor): string | undefined {
  const ch = c.peek();
  if (ch === undefined) return undefined;
  if (ch === "\\") {
    const escaped = c.peek(1);
    // Only metacharacters may be escaped; '\d' outside the exact DIGITS unit, '\1', '\w', … are all
    // rejected — backreferences and shorthand classes are not in the grammar.
    if (escaped === undefined || !METACHARS.has(escaped)) return undefined;
    c.pos += 2;
    return escaped;
  }
  if (METACHARS.has(ch)) return undefined; // unescaped metachar — reject (incl. '.', '?', '*' …)
  c.pos += 1;
  return ch;
}

interface SeqResult {
  seq: DrxSeq;
  digits: number;
}

/** seq := unit+ tail? — at most one DIGITS unit, whose in-seq neighbours must be non-digit LITs. */
function parseSeq(c: Cursor): SeqResult | { problem: string } {
  const units: DrxUnit[] = [];
  let digits = 0;
  let digitsAt = -1;
  while (!c.eof()) {
    if (c.startsWith(TAIL_LITERAL)) break; // tail handled by caller after units
    if (c.peek() === "|") break; // alternation separator — caller handles
    if (c.startsWith(DIGITS_LITERAL)) {
      if (digits >= 1) return { problem: `more than one ${DIGITS_LITERAL} in one alternation branch` };
      c.pos += DIGITS_LITERAL.length;
      units.push({ t: "digits" });
      digits += 1;
      digitsAt = units.length - 1;
      continue;
    }
    const lit = parseLit(c);
    if (lit === undefined) {
      const at = c.src.slice(c.pos, c.pos + 2);
      return {
        problem: `not a DRX literal at "${at}" (position ${c.pos}): escape metacharacters, no classes/groups/quantifiers`,
      };
    }
    units.push({ t: "lit", ch: lit });
  }
  if (units.length === 0) return { problem: "empty alternation branch" };
  if (digits === 1) {
    // The neighbours of the DIGITS unit must be non-digit literals (or the seq boundary) so the
    // bounded quantifier's class never overlaps an adjacent literal — the disjointness premise of
    // the safety argument (rejects `\d{1,4}2`, `3\d{1,4}`, `\d{1,4}\d{1,4}` shapes).
    const before = units[digitsAt - 1];
    if (before !== undefined && (before.t !== "lit" || !NON_DIGIT(before.ch)))
      return { problem: `${DIGITS_LITERAL} must be preceded by a non-digit literal or branch boundary` };
    const after = units[digitsAt + 1];
    if (after !== undefined && (after.t !== "lit" || !NON_DIGIT(after.ch)))
      return { problem: `${DIGITS_LITERAL} must be followed by a non-digit literal or branch boundary` };
  }
  const tail = c.eat(TAIL_LITERAL) ? ("吗|呢" as const) : undefined;
  return { seq: { units, ...(tail !== undefined ? { tail } : {}) }, digits };
}

/** weak / exclude := LIT{1,40} — pure literals only, substring semantics. */
function parseLitOnly(c: Cursor): { lits: string[] } | { problem: string } {
  const lits: string[] = [];
  while (!c.eof()) {
    if (c.startsWith(DIGITS_LITERAL)) return { problem: `${DIGITS_LITERAL} is only allowed in strong templates` };
    const lit = parseLit(c);
    if (lit === undefined) {
      const at = c.src.slice(c.pos, c.pos + 2);
      return { problem: `not a DRX literal at "${at}" (position ${c.pos}): weak/exclude are pure literals` };
    }
    lits.push(lit);
    if (lits.length > DRX_MAX_WEAK_LITS) return { problem: `more than ${DRX_MAX_WEAK_LITS} literals` };
  }
  if (lits.length === 0) return { problem: "empty source" };
  return { lits };
}

/**
 * Parse a DRX source for the given role. Never throws, never constructs a RegExp: acceptance is
 * purely syntactic (BA §4.5 "测试编排" ① — the reject set is asserted WITHOUT executing anything).
 */
export function parseDrx(src: string, role: DrxRole): DrxParseResult {
  if (typeof src !== "string" || src.length === 0) return { ok: false, problem: "empty source" };
  if (src.length > DRX_MAX_SOURCE_CHARS)
    return { ok: false, problem: `source longer than ${DRX_MAX_SOURCE_CHARS} chars (${src.length})` };
  const c = new Cursor(src);
  if (role === "strong") {
    const seqs: DrxSeq[] = [];
    for (;;) {
      const r = parseSeq(c);
      if ("problem" in r) return { ok: false, problem: r.problem };
      seqs.push(r.seq);
      if (c.eof()) break;
      if (!c.eat("|")) {
        return { ok: false, problem: `unexpected "${c.src.slice(c.pos, c.pos + 2)}" (position ${c.pos}) after branch` };
      }
      if (seqs.length >= DRX_MAX_ALTERNATION)
        return { ok: false, problem: `more than ${DRX_MAX_ALTERNATION} alternation branches` };
    }
    return { ok: true, ast: { role: "strong", seqs } };
  }
  const r = parseLitOnly(c);
  if ("problem" in r) return { ok: false, problem: r.problem };
  return { ok: true, ast: { role, lits: r.lits } };
}

/** Escape a single character for canonical emission. */
const escapeLit = (ch: string): string => (METACHARS.has(ch) ? `\\${ch}` : ch);

/**
 * Canonical source emission (BA §4.5): generators construct an AST and emit through this so the
 * output is normalized (metacharacters escaped, `\d{1,4}` / tail spelled exactly). Round-trip
 * guarantee: `parseDrx(drxToSource(ast), ast.role)` succeeds with an equal AST.
 */
export function drxToSource(ast: DrxAst): string {
  if (ast.role === "strong") {
    return ast.seqs
      .map((seq) => {
        const units = seq.units.map((u) => (u.t === "lit" ? escapeLit(u.ch) : DIGITS_LITERAL)).join("");
        return units + (seq.tail !== undefined ? TAIL_LITERAL : "");
      })
      .join("|");
  }
  return ast.lits.map(escapeLit).join("");
}
