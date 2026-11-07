// Bash command parsing into SimpleCommand[] (v4.1 §2.7.1, adopted verbatim
// by jev-arch §6.4 / jev-plan J1). Coarse filters and matchers use it to tell
// `git -C x push` (a real push) from `echo "git push"` (a print).
//
// Handles: quoting (single/double/backslash), `&&`/`||`/`;`/`|`/`&`/newline
// splitting, `$( … )` / backtick / `( … )` recursion (depth ≤2, inner commands
// merged into the flat result — they run for real), `bash|sh|zsh|dash -c "…"`
// string recursion, leading `VAR=…` assignments, wrapper unwrapping
// (env/sudo/command/builtin/exec/nohup/time/nice/timeout), heredoc body
// skipping, `cd` tracking along command chains (subshell groups keep cwd
// changes local), and git global-option stripping (`-C <path>` lands in
// `cwd`). Known blind spots (v4.1 r3 #7, fail-open by design): commands
// hidden behind ssh/xargs/find -exec/eval/watch and inside scripts — only the
// outer program is visible.
//
// Input truncated to 8KB; NEVER throws — parse problems yield `{ok:false}`
// plus the commands completed before the problem (callers fall back to
// substring matching). Pi-free root; no module-scope state at all (I4).

import type { SimpleCommand } from "./contracts.js";

export interface ParseShellResult {
  /** false ⇒ quotes/parens were unbalanced etc.; `commands` is best-effort. */
  readonly ok: boolean;
  readonly commands: readonly SimpleCommand[];
  /** A `<`/`>` redirect (incl. `>>`, heredocs, `2>&1`; process substitution
   *  `<( … )` is not one) was seen anywhere — top level or nested. Redirects
   *  are dropped together with their target, so an argv-only view of a
   *  redirect-bearing command is incomplete: read-only whitelists must not
   *  exempt it. */
  readonly hasRedirect: boolean;
}

const MAX_INPUT_UNITS = 8_192; // 8KB window (UTF-16 units — cheap, total)
const MAX_DEPTH = 2;
const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "node", "python", "python3"]);
const WRAPPER_NO_ARG = new Set(["command", "builtin", "exec", "nohup", "time"]);
const WRAPPER_WITH_VALUE_OPTS = new Set(["-k", "-s", "--signal", "--kill-after", "-u", "-n"]);
const DURATION_RE = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/;

class ShellParseError extends Error {}

/** Cross-recursion flag holder: set when the tokenizer drops a redirect. */
interface ParseFlags {
  redirect: boolean;
}

// ───────────────────────────── tokenizer ─────────────────────────────

type Token = { kind: "word"; text: string } | { kind: "op"; text: string };

/** Tokenize one command string into words and operators. Operators:
 *  `&&` `||` `;` `|` `&` `(` `)` newline; redirects (`<`, `>`, `>>`, `2>`,
 *  `<<…` heredoc openers, `<<<`) are dropped together with their target
 *  word and any glued fd digit. Command substitutions `$( … )`, backticks
 *  and `<( … )` recurse via `parseInto` (their inner commands go straight
 *  into the shared sink) and leave an empty placeholder word. */
function tokenize(src: string, depth: number, sink: SimpleCommand[], flags: ParseFlags): Token[] {
  const tokens: Token[] = [];
  const pushWord = (text: string): void => {
    if (text !== "") tokens.push({ kind: "word", text });
  };
  const dropTrailingFd = (): void => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === "word" && /^\d+$/.test(last.text)) tokens.pop();
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) throw new ShellParseError("unterminated single quote");
      const [next, word] = slurpWord(src, close + 1, src.slice(i + 1, close), depth, sink, flags);
      pushWord(word);
      i = next;
      continue;
    }
    if (ch === '"') {
      let word = "";
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") {
          if (i + 1 >= n) throw new ShellParseError("unterminated double quote");
          word += src[i + 1]!;
          i += 2;
          continue;
        }
        word += src[i]!;
        i++;
      }
      if (i >= n) throw new ShellParseError("unterminated double quote");
      i++;
      const [next, joined] = slurpWord(src, i, word, depth, sink, flags);
      pushWord(joined);
      i = next;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= n) throw new ShellParseError("trailing backslash");
      const [next, word] = slurpWord(src, i + 2, src[i + 1]!, depth, sink, flags);
      pushWord(word);
      i = next;
      continue;
    }
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close === -1) throw new ShellParseError("unterminated backtick");
      parseInto(src.slice(i + 1, close).replace(/\\`/g, "`"), depth + 1, sink, flags);
      const [next, word] = slurpWord(src, close + 1, "", depth, sink, flags);
      pushWord(word);
      i = next;
      continue;
    }
    if (ch === "$" && src[i + 1] === "(") {
      const close = findCloseParen(src, i + 1);
      if (close === -1) throw new ShellParseError("unterminated $()");
      parseInto(src.slice(i + 2, close), depth + 1, sink, flags);
      const [next, word] = slurpWord(src, close + 1, "", depth, sink, flags);
      pushWord(word);
      i = next;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "op", text: ch });
      i++;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(src[i - 1]!))) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      tokens.push({ kind: "op", text: ";" });
      i++;
      continue;
    }
    if (ch === "&" && src[i + 1] === "&") {
      tokens.push({ kind: "op", text: "&&" });
      i += 2;
      continue;
    }
    if (ch === "|" && src[i + 1] === "|") {
      tokens.push({ kind: "op", text: "||" });
      i += 2;
      continue;
    }
    if (ch === "&" || ch === "|") {
      tokens.push({ kind: "op", text: ch });
      i++;
      continue;
    }
    if (ch === "<" || ch === ">") {
      if (ch === "<" && src[i + 1] === "(") {
        const close = findCloseParen(src, i + 1);
        if (close === -1) throw new ShellParseError("unterminated <()");
        parseInto(src.slice(i + 2, close), depth + 1, sink, flags);
        i = close + 1;
        continue;
      }
      dropTrailingFd(); // `2>` — the fd digit is not an argument
      flags.redirect = true; // dropped below ⇒ argv alone is not the whole story
      while (i < n && src[i] === ch) i++; // > >> < << <<<
      while (i < n && (src[i] === " " || src[i] === "\t")) i++;
      if (src[i] === "&") {
        i++; // 2>&1
        continue;
      }
      if (i < n && src[i] !== "\n" && !";|&()".includes(src[i]!)) {
        if (src[i] === '"' || src[i] === "'") {
          const q = src[i]!;
          const close = src.indexOf(q, i + 1);
          if (close === -1) throw new ShellParseError("unterminated redirect target");
          i = close + 1;
        } else {
          while (i < n && !/[\s;|&()<>]/.test(src[i]!)) i++;
        }
      }
      continue;
    }
    if (/\s/.test(ch)) {
      // ANY whitespace separates tokens (incl. \u00a0/\u2028 — `\s` in JS is
      // unicode-aware, and a narrower skip would let slurpWord return an
      // empty word without advancing → infinite loop).
      i++;
      continue;
    }
    const [next, word] = slurpWord(src, i, "", depth, sink, flags);
    pushWord(word);
    i = next;
  }
  return tokens;
}

/** Slurp the unquoted tail of a word that began as a quoted/escaped
 *  fragment, until a shell delimiter. */
function slurpWord(
  src: string,
  i: number,
  prefix: string,
  depth: number,
  sink: SimpleCommand[],
  flags: ParseFlags,
): [number, string] {
  let word = prefix;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/[\s;|&()<>]/.test(c) || c === "'" || c === '"' || c === "`") break;
    if (c === "\\") {
      if (i + 1 >= n) throw new ShellParseError("trailing backslash");
      word += src[i + 1]!;
      i += 2;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const close = findCloseParen(src, i + 1);
      if (close === -1) throw new ShellParseError("unterminated $()");
      parseInto(src.slice(i + 2, close), depth + 1, sink, flags);
      i = close + 1;
      continue;
    }
    word += c;
    i++;
  }
  return [i, word];
}

/** Index of the `)` matching the `(` at `open` (-1 when unterminated). */
function findCloseParen(src: string, open: number): number {
  let level = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === '"') {
      const close = src.indexOf('"', i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === "(") level++;
    else if (c === ")") {
      level--;
      if (level === 0) return i;
    }
  }
  return -1;
}

// ───────────────────────────── heredoc preprocessing ─────────────────────────────

/** Remove heredoc BODIES from the raw text (the `<<TAG … TAG` opener stays —
 *  the tokenizer drops it as a redirect). The body runs from the line after
 *  the opener to the first line whose trimmed content is the tag; an missing
 *  terminator swallows the rest. Total: any anomaly leaves the text as-is. */
function stripHeredocBodies(src: string): string {
  // `g` flag with a fresh exec from 0 each round (a `y`-sticky match would
  // only ever test position 0); the lookahead keeps redirect shapes out.
  const markerRe = /(<<-?)([A-Za-z_][A-Za-z0-9_]*|'[^'\n]*'|"[^"\n]*")(?=[\s;&|)]|$)/g;
  let out = "";
  let rest = src;
  for (;;) {
    markerRe.lastIndex = 0;
    const m = markerRe.exec(rest);
    if (m === null) break;
    const tag = m[2]!.replace(/^['"]|['"]$/g, "");
    const bodyStart = rest.indexOf("\n", m.index + m[0].length);
    out += rest.slice(0, m.index + m[0].length);
    if (bodyStart === -1) {
      rest = "";
      break;
    }
    const termRe = new RegExp(`(?:\\n|^)[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*(?=\\n|$)`);
    const term = termRe.exec(rest.slice(bodyStart + 1));
    const consumed = term === null ? rest.length : bodyStart + 1 + term.index + term[0].length;
    rest = rest.slice(consumed);
  }
  return out + rest;
}

// ───────────────────────────── words → SimpleCommands ─────────────────────────────

interface CwdBox {
  value: string | undefined;
}

/** Group a token stream into simple commands. `(` `)` subshell groups
 *  recurse (their cwd changes stay local — a fresh box is passed down);
 *  every other operator flushes the current argv. */
function tokensToCommands(
  tokens: readonly Token[],
  depth: number,
  sink: SimpleCommand[],
  flags: ParseFlags,
): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const cwdBox: CwdBox = { value: undefined };
  let argv: string[] = [];
  const flush = (): void => {
    if (argv.length === 0) return;
    const built = buildCommand(argv, cwdBox, depth, sink, flags);
    argv = [];
    if (built !== undefined) commands.push(built);
  };
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]!;
    if (t.kind === "op") {
      if (t.text === "(") {
        flush();
        let level = 1;
        const group: Token[] = [];
        idx++;
        while (idx < tokens.length) {
          const g = tokens[idx]!;
          if (g.kind === "op" && g.text === "(") level++;
          if (g.kind === "op" && g.text === ")") {
            level--;
            if (level === 0) break;
          }
          group.push(g);
          idx++;
        }
        // Fresh cwd box: `cd` inside the group does not leak out.
        commands.push(...tokensToCommands(group, depth, sink, flags));
        continue;
      }
      flush(); // ; && || | & newline all separate commands
      continue;
    }
    if (t.text === "") continue; // $()/backtick placeholder
    argv.push(t.text);
  }
  flush();
  return commands;
}

/** Apply assignment-skipping, wrapper unwrapping, `cd` tracking (mutates the
 *  box), git global-option stripping and program/positional extraction.
 *  Returns undefined for empty segments and for `cd` itself (cd is not a
 *  matchable command, it only moves the chain's cwd). */
function buildCommand(
  rawArgv: readonly string[],
  cwdBox: CwdBox,
  depth: number,
  sink: SimpleCommand[],
  flags: ParseFlags,
): SimpleCommand | undefined {
  let argv = [...rawArgv];
  while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) argv.shift();
  if (argv.length === 0) return undefined;

  // Wrapper unwrapping (§2.7.1): env/sudo/nice/timeout/command/builtin/exec/
  // nohup/time.
  for (;;) {
    const base = basename(argv[0]!);
    if (base === "env") {
      argv = argv.slice(1);
      while (argv.length > 0 && (argv[0] === "-i" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!))) argv.shift();
    } else if (base === "sudo") {
      argv = argv.slice(1);
      while (argv.length > 0 && argv[0]!.startsWith("-") && argv[0] !== "--") {
        argv = WRAPPER_WITH_VALUE_OPTS.has(argv[0]!) ? argv.slice(2) : argv.slice(1);
      }
      if (argv[0] === "--") argv.shift();
    } else if (base === "nice") {
      argv = argv.slice(1);
      while (argv.length > 0 && argv[0]!.startsWith("-") && argv[0] !== "--") {
        argv = argv[0] === "-n" ? argv.slice(2) : argv.slice(1);
      }
    } else if (base === "timeout") {
      argv = argv.slice(1);
      while (argv.length > 0 && argv[0]!.startsWith("-") && argv[0] !== "--") {
        argv = WRAPPER_WITH_VALUE_OPTS.has(argv[0]!) ? argv.slice(2) : argv.slice(1);
      }
      if (argv[0] === "--") argv.shift();
      if (argv.length > 0 && DURATION_RE.test(argv[0]!)) argv.shift();
    } else if (WRAPPER_NO_ARG.has(base)) {
      argv = argv.slice(1);
      while (argv.length > 0 && argv[0]!.startsWith("-") && argv[0] !== "--") argv.shift();
      if (argv[0] === "--") argv.shift();
    } else {
      break;
    }
    if (argv.length === 0) return undefined;
  }

  // cd tracking along `cd <dir> &&` chains.
  if (basename(argv[0]!) === "cd") {
    const target = argv[1];
    if (target !== undefined && !target.startsWith("-")) cwdBox.value = joinCwd(cwdBox.value, target);
    return undefined;
  }

  // git global options: -C <path> (→ cwd), -c k=v, --git-dir/--work-tree (=
  // and separate forms), --no-pager, -P, then the subcommand.
  let cwd = cwdBox.value;
  if (basename(argv[0]!) === "git") {
    let i = 1;
    for (;;) {
      const a = argv[i];
      if (a === undefined || a === "--" || !a.startsWith("-")) break;
      if (a === "-C") {
        cwd = joinCwd(cwd, argv[i + 1] ?? ".");
        i += 2;
        continue;
      }
      if (a === "-c" || a === "--git-dir" || a === "--work-tree") {
        i += 2;
        continue;
      }
      if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
        i += 1;
        continue;
      }
      i += 1; // --no-pager, -P, any other global flag
    }
    argv = ["git", ...argv.slice(i)];
  }

  // `bash -c "<script>"` — parse the script string too (depth-bounded).
  const base0 = basename(argv[0]!);
  if (INTERPRETERS.has(base0)) {
    const script = interpreterScript(argv);
    if (script !== undefined && depth < MAX_DEPTH) parseInto(script, depth + 1, sink, flags);
  }

  const program = programIdentity(argv);
  const positionals = argv.slice(1).filter((a) => !a.startsWith("-"));
  return { argv, program, positionals, ...(cwd === undefined ? {} : { cwd }) };
}

/** First operand of an interpreter argv and whether a `-c`-style flag came
 *  before it. Short-flag clusters that contain `c` (`-lc`, `-ic`, `-xec`) count
 *  as `-c`; `-o`/`+o` (alone or ending a cluster) consume the next argument;
 *  long options are skipped. Per sh/bash semantics the first operand is the
 *  command string after `-c`, otherwise the script file. */
function interpreterOperand(argv: readonly string[]): { operand: string | undefined; sawC: boolean } {
  let sawC = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return { operand: argv[i + 1], sawC };
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a.startsWith("-") && a.includes("c")) sawC = true;
      if (a.endsWith("o")) i += 1;
      continue;
    }
    if (a.startsWith("-")) continue; // --login, --norc, -m=…
    return { operand: a, sawC };
  }
  return { operand: undefined, sawC };
}

/** The `-c` command string of an interpreter argv (see `interpreterOperand`). */
function interpreterScript(argv: readonly string[]): string | undefined {
  const { operand, sawC } = interpreterOperand(argv);
  return sawC ? operand : undefined;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Lexical path join for `cd`/`git -C` tracking (absolute `dir` resets;
 *  `.`/`..` collapsed; no fs access). */
function joinCwd(cwd: string | undefined, dir: string): string {
  const parts =
    `${dir.startsWith("/") ? "" : (cwd ?? "")}${cwd !== undefined && !dir.startsWith("/") ? "/" : ""}${dir}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

// ───────────────────────────── program identity (§2.7.1) ─────────────────────────────

/** argv0's basename; when argv0 is an interpreter WITHOUT `-c`, the first
 *  non-option argument's basename — so `bash scripts/release/release.sh
 *  0.10.3` ⇒ `release.sh`. */
export function programIdentity(argv: readonly string[]): string {
  if (argv.length === 0) return "";
  const base = basename(argv[0]!);
  if (INTERPRETERS.has(base)) {
    const { operand, sawC } = interpreterOperand(argv);
    if (!sawC && operand !== undefined) return basename(operand);
  }
  return base;
}

// ───────────────────────────── entry points ─────────────────────────────

/** Parse one (possibly nested) command string; commands land in `sink`
 *  (inner-substitution commands first, then the outer list). */
function parseInto(src: string, depth: number, sink: SimpleCommand[], flags: ParseFlags): boolean {
  if (depth > MAX_DEPTH) return true;
  let ok = true;
  let text = src;
  try {
    text = stripHeredocBodies(src);
  } catch {
    ok = false;
  }
  let tokens: Token[];
  try {
    tokens = tokenize(text, depth, sink, flags);
  } catch {
    ok = false;
    tokens = [];
  }
  let commands: SimpleCommand[] = [];
  try {
    commands = tokensToCommands(tokens, depth, sink, flags);
  } catch {
    ok = false;
  }
  sink.push(...commands);
  return ok;
}

/** Parse a bash command line. Never throws. */
export function parseShell(cmd: string): ParseShellResult {
  const sink: SimpleCommand[] = [];
  const flags: ParseFlags = { redirect: false };
  const ok = parseInto(cmd.slice(0, MAX_INPUT_UNITS), 0, sink, flags);
  return { ok, commands: sink, hasRedirect: flags.redirect };
}
