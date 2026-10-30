// Secret detection shared by doctor D13 and the Jev entry index (jev-arch
// §4.1's `secret` field: body hits SECRET_PATTERNS or the loose key/value
// rule). MOVED VERBATIM out of `doctor.ts` (J1, pure move — doctor's D13
// output must stay byte-identical, pinned by tests/fixtures/memory/
// doctor-golden/); `looksSecret` is the new boolean wrapper the Jev entry
// index uses so both consumers stay same-source by construction.
//
// Zero pi/typebox imports; pi-free root (tests/boundary/pi-free.test.ts).

// High-confidence literal shapes — reported as-is (whole match masked).
export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /xox[bap]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

// Loose `password|secret|token <sep> value` rule. Two gates, both required:
//
// 1. Word boundary before the keyword: `(?<![A-Za-z0-9])`. `_` and `-` count
//    as separators, NOT as word characters — that is a deliberate choice so
//    `api_token=` / `x-auth-token:` / `TOKEN=` still hit, while pure-letter
//    adjacency (`hasUsableAccessToken=`, `tokenizer=`) never does. The
//    trade-off: snake-case constants (`JUDGE_BYTES_PER_TOKEN=4`) still
//    keyword-match and rely on gate 2 (the value filter) to stay silent.
//
// 2. The value must LOOK like a credential (after de-quoting). Excluded
//    outright: env refs (`$VAR` / `${VAR}` / `%VAR%`), `<…>` placeholders,
//    `(…)` parenthesized notes, boolean-ish literals, pure numbers (incl.
//    thousands separators/decimals), masked remainders (`***`, `xxxx`, `…`).
//    What remains is reported only if it is credential-like — thresholds
//    pinned by tests/memory/doctor.test.ts "D13":
//      · de-quoted length ≥ 12 AND contains BOTH a letter and a digit, or
//      · length ≥ 20 entirely within the base64/hex-ish charset
//        `[A-Za-z0-9+/=._-]` (catches long letter-only passphrases).
// An optional closing quote may sit between keyword and separator, so quoted
// keys (`"token": "…"`, `'secret': …`) de-quote and hit too.
const LOOSE_KV_SECRET_RE =
  /(?<![A-Za-z0-9])(?:password|secret|token)["']?[ \t]*[:=][ \t]*("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\S+)/gi;

const ENV_REF_RE = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}\n]+\}|%[A-Za-z_][A-Za-z0-9_]*%)$/;
const PLACEHOLDER_RE = /^<[^<>\n]*>$/;
const PURE_NUMBER_RE = /^-?\d[\d,.]*$/;
const BOOLEANISH_RE = /^(?:true|false|null|undefined|none)$/i;

/** Symmetric surrounding quotes ("…" / '…' / `…`) — JSON/YAML values are
 * judged de-quoted, so `"token": "hunter2hunter2"` still reports. */
function dequote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]!;
    const last = value[value.length - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Gate 2 for the loose rule: does this raw captured value look like a
 * real credential? See LOOSE_KV_SECRET_RE's comment for the rule set. */
function looseValueLooksLikeSecret(raw: string): boolean {
  const dequoted = dequote(raw);
  // `(octet-stream)`-style notes describe the syntax, not a secret.
  if (dequoted.startsWith("(") && dequoted.endsWith(")")) return false;
  let v = dequoted;
  // A backtick mid-value means `\S+` crossed a markdown inline-code span
  // boundary (`…TOKEN=4``other-span`…`): the real value ends at the fence.
  const tick = v.indexOf("`");
  if (tick > 0) v = v.slice(0, tick);
  v = v.replace(/[.,;]+$/, "");
  if (v === "") return false;
  if (ENV_REF_RE.test(v)) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  if (BOOLEANISH_RE.test(v)) return false;
  if (PURE_NUMBER_RE.test(v)) return false;
  // Masked remainders: strip the mask charset and nothing alphanumeric stays
  // (`********`, `xxxx`, `…` — but `x0x0` keeps a digit and stays in play).
  if (!/[0-9A-Za-z]/.test(v.replace(/[*xX….]+/g, ""))) return false;
  if (v.length >= 12 && /[A-Za-z]/.test(v) && /\d/.test(v)) return true;
  return v.length >= 20 && /^[A-Za-z0-9+/=._-]+$/.test(v);
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** "打码为前 4 字符 + …" (§6.1 D13) — code-point safe (never splits a
 * surrogate pair). */
function maskSecret(text: string): string {
  const chars = Array.from(text);
  return `${chars.slice(0, 4).join("")}…`;
}

export function findSecrets(content: string): { line: number; snippet: string }[] {
  const found: { line: number; snippet: string }[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const whole = m[0];
      found.push({ line: lineOf(content, m.index), snippet: maskSecret(whole) });
      if (whole.length === 0) re.lastIndex++; // never loop forever on a zero-length match
    }
  }
  const loose = new RegExp(LOOSE_KV_SECRET_RE.source, LOOSE_KV_SECRET_RE.flags);
  let lm: RegExpExecArray | null;
  while ((lm = loose.exec(content)) !== null) {
    const whole = lm[0];
    if (looseValueLooksLikeSecret(lm[1] ?? whole)) {
      found.push({ line: lineOf(content, lm.index), snippet: maskSecret(whole) });
    }
  }
  found.sort((a, b) => a.line - b.line);
  return found;
}

/** jev-arch §4.1 `secret`: does this text hit any secret shape (literal
 * patterns or the loose key/value rule)? Same-source with doctor D13 —
 * `looksSecret(t) === (findSecrets(t).length > 0)` by construction. */
export function looksSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}
