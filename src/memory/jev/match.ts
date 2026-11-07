// Tag matchers, globs, lexical prefilter and named-program extraction
// (jev-arch §6.1.3, jev-plan J1). Zero-call fast path: a
// matcher is attached to a TAG (never to an entry — Q24), and matchers
// only feed the fast path. (The gate coarse-filter consumer was removed
// with the gate feature, 2026-11.)
//
// Pi-free root; no module-scope state (I4).

import type { SimpleCommand, Taxonomy } from "./contracts.js";
import { parseShell } from "./shell-parse.js";

// ───────────────────────────── glob matching ─────────────────────────────

/** Glob match for tag `paths` patterns, relative to the repo root:
 *  `*` within one segment, `?` one non-separator char, `**` any run of
 *  segments (a leading `**` + `/` also matches zero dirs; a trailing `**`
 *  after a `/` matches everything strictly under; `a` + `/**` + `b` any
 *  depth between — written spaced here so the `*` `/` pair never closes
 *  this comment). Other regex metacharacters match literally. */
export function globMatch(glob: string, path: string): boolean {
  const gParts = glob.split("/");
  const pParts = path.split("/");
  return matchSegments(gParts, 0, pParts, 0);
}

function matchSegments(g: readonly string[], gi: number, p: readonly string[], pi: number): boolean {
  if (gi === g.length) return pi === p.length;
  const part = g[gi]!;
  if (part === "**") {
    // `**` matches zero or more whole segments.
    for (let skip = pi; skip <= p.length; skip++) {
      if (matchSegments(g, gi + 1, p, skip)) return true;
    }
    return false;
  }
  if (pi >= p.length) return false;
  if (!matchSegment(part, p[pi]!)) return false;
  return matchSegments(g, gi + 1, p, pi + 1);
}

function matchSegment(pattern: string, text: string): boolean {
  // Single-segment wildcard match: `*` any run, `?` one char, rest literal.
  let pi = 0;
  let ti = 0;
  let star = -1;
  let starT = 0;
  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === text[ti])) {
      pi++;
      ti++;
      continue;
    }
    if (pi < pattern.length && pattern[pi] === "*") {
      star = pi++;
      starT = ti;
      continue;
    }
    if (star !== -1) {
      pi = star + 1;
      ti = ++starT;
      continue;
    }
    return false;
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

// ───────────────────────────── command patterns (v4.1 §2.7.1 `cmd=`) ─────────────────────────────

/** Match one command-pattern alternative against one SimpleCommand's
 *  stripped argv. Words split on whitespace; each word is a literal or a
 *  glob. Word 1 matches `program`; later words match a PREFIX of the
 *  argument sequence where non-option pattern words may skip over option
 *  args (`-x`) and option-like pattern words (e.g. `find -delete`) match the
 *  next equal arg literally. `git -C x push` ⇒ pattern `git push` hits;
 *  `echo "git push"` does not (program is `echo`). */
function commandMatchesArgv(patternWords: readonly string[], cmd: SimpleCommand): boolean {
  if (patternWords.length === 0) return false;
  const programWord = patternWords[0]!;
  if (!matchSegment(programWord, cmd.program)) return false;
  const argv = cmd.argv.slice(1);
  let ai = 0;
  for (let wi = 1; wi < patternWords.length; wi++) {
    const word = patternWords[wi]!;
    if (word.startsWith("-")) {
      let found = false;
      while (ai < argv.length) {
        if (matchSegment(word, argv[ai]!)) {
          found = true;
          break;
        }
        ai++;
      }
      if (!found) return false;
      ai++;
      continue;
    }
    while (ai < argv.length && argv[ai]!.startsWith("-")) ai++; // skip options
    if (ai >= argv.length || !matchSegment(word, argv[ai]!)) return false;
    ai++;
  }
  return true;
}

/** Match a command pattern alternative set (whitespace-`|`-separated, e.g.
 *  `"git commit|git -C * push"` — here each alternative is one array entry)
 *  against a raw bash command. Any SimpleCommand hitting any alternative ⇒
 *  match. When parsing fails (`ok:false`), fall back to substring matching
 *  of the alternative against the raw command (never worse than `arg=`,
 *  v4.1 §2.7.1). */
export function matchCommandPattern(pattern: string, cmd: string): boolean {
  const words = pattern
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return false;
  const parsed = parseShell(cmd);
  if (parsed.commands.some((c) => commandMatchesArgv(words, c))) return true;
  if (!parsed.ok && cmd.includes(pattern.trim())) return true; // degraded substring mode
  return false;
}

// ───────────────────────────── tool-call tag matching (§6.1.3) ─────────────────────────────

/** Candidate path strings mentioned in a tool input (shallow walk of string
 *  values under path-ish keys + any string that looks like a repo-relative
 *  path with a known file/dir shape). Used for tag `paths` matchers. */
function inputPaths(input: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/^[\w.@\/-]+$/.test(value) && /[.\/]/.test(value) && !value.includes(" ")) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (/(^|[^a-z])(file|path|dir|cwd|name|target|glob|files|paths)$/i.test(k)) visit(v, depth + 1);
        else visit(v, depth + 1);
      }
    }
  };
  visit(input, 0);
  return [...new Set(out)];
}

export interface MatchTagsCall {
  readonly tool: string;
  readonly input: unknown;
  /** Pre-parsed shell commands (per toolCallId cache); when omitted, a
   *  string `input.command` is parsed on the fly. */
  readonly parsed?: readonly SimpleCommand[];
}

/** Tag ids whose matchers hit this tool call: `tools` by tool name,
 *  `commands` against the bash command (parsed or raw `input.command`),
 *  `paths` by glob against paths mentioned in the input. Sorted, unique. */
export function matchTags(call: MatchTagsCall, tax: Taxonomy): readonly string[] {
  const hit = new Set<string>();
  const rawCommand =
    typeof (call.input as { command?: unknown } | null)?.command === "string"
      ? (call.input as { command: string }).command
      : undefined;
  const paths = inputPaths(call.input);
  for (const tag of tax.tags) {
    const m = tag.match;
    if (m === undefined) continue;
    if (m.tools !== undefined && m.tools.some((t) => t === call.tool)) {
      hit.add(tag.id);
      continue;
    }
    if (m.commands !== undefined && rawCommand !== undefined) {
      const parsed = call.parsed ?? parseShell(rawCommand).commands;
      if (parsed.some((c) => m.commands!.some((pattern) => commandMatchesArgv(pattern.trim().split(/\s+/), c)))) {
        hit.add(tag.id);
        continue;
      }
      // Degraded substring mode when the raw command failed to parse.
      if (!call.parsed && !parseShell(rawCommand).ok && m.commands.some((p) => rawCommand.includes(p.trim()))) {
        hit.add(tag.id);
        continue;
      }
    }
    if (m.paths !== undefined && m.paths.some((g) => paths.some((p) => globMatch(g, p)))) {
      hit.add(tag.id);
    }
  }
  return [...hit].sort();
}

// ───────────────────────────── named programs (§6.4.2) ─────────────────────────────

/** Generic programs that never count as “named” (arch §6.4.2) — `release.sh`
 * is extracted, `git` is not. */
export const GENERIC_PROGRAMS: readonly string[] = [
  "git",
  "npm",
  "npx",
  "node",
  "bash",
  "sh",
  "zsh",
  "pi",
  "gh",
  "ls",
  "cd",
  "cat",
  "echo",
  "timeout",
];
const GENERIC = new Set(GENERIC_PROGRAMS);
const NAMED_SUFFIX_RE = /^[A-Za-z0-9_@.\/+\-]+\.(?:sh|py|mjs|js|ts)$/;

/** Programs a rule body names explicitly: the first word of each backtick
 *  span, plus bare words ending in `.sh`/`.py`/`.mjs`/`.js`/`.ts`. Basenames
 *  only, generic programs removed, first-appearance order, deduped. */
export function namedPrograms(body: string): readonly string[] {
  const out: string[] = [];
  const push = (name: string | undefined): void => {
    if (name === undefined || name === "") return;
    const base = name.split("/").pop()!;
    if (GENERIC.has(base)) return;
    if (!out.includes(base)) out.push(base);
  };
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    push(m[1]!.trim().split(/\s+/)[0]);
  }
  for (const m of body.matchAll(/[A-Za-z0-9_@.\/+\-]+/g)) {
    if (NAMED_SUFFIX_RE.test(m[0])) push(m[0]);
  }
  return out;
}

// ───────────────────────────── lexical prefilter (§6.1.1 >360 case) ─────────────────────────────

/** Tokenize for lexical overlap: ASCII/latin word runs + CJK bigrams (a lone
 *  CJK char counts as one token). Lowercased. */
export function lexicalTokens(text: string): readonly string[] {
  const tokens: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) tokens.push(m[0].toLowerCase());
  for (const m of text.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = Array.from(m[0]);
    if (run.length === 1) {
      tokens.push(run[0]!);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) tokens.push(`${run[i]!}${run[i + 1]!}`);
  }
  return tokens;
}

/** Overlap score of `query` against `text`: |query ∩ text| / |query|
 *  (0 when the query has no tokens). CJK bigrams and ASCII words mix
 *  freely. */
export function lexicalScore(query: string, text: string): number {
  const q = lexicalTokens(query);
  if (q.length === 0) return 0;
  const t = new Set(lexicalTokens(text));
  let hits = 0;
  for (const token of q) if (t.has(token)) hits++;
  return hits / q.length;
}

/** Top-`n` items by lexical overlap with `query` (descending); `tieBreak`
 *  orders equal-score items (callers pass e.g. user-token-first). Stable:
 *  original order preserved for ties when no tieBreak is given. */
export function prefilter<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  query: string,
  n: number,
  tieBreak?: (a: T, b: T) => number,
): T[] {
  const scored = items.map((item, index) => ({ item, index, score: lexicalScore(query, textOf(item)) }));
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (tieBreak !== undefined) {
      const t = tieBreak(x.item, y.item);
      if (t !== 0) return t;
    }
    return x.index - y.index;
  });
  return scored.slice(0, Math.max(0, n)).map((s) => s.item);
}
