/**
 * Command "de-shelling" for the fleet drawer's bash rows (variant C, 2026-10-17): pure,
 * DOM-free, conservative. Strips the mechanical wrapper the bash tool/agents put around a
 * command so the row can show the CORE command on line 1 and the wrapper facts (cwd,
 * timeout) as small labels on line 2:
 *
 *   cd <path> && / ;                       → cwd label
 *   timeout [-s SIG|-k N|--foreground…] D  → timeout label (`timeout D`)
 *   sh|bash|zsh -c|-lc '<inner>'           → `<inner>` (only when it is the whole remainder)
 *   (timeout N sh -c '<inner>') > log …    → `(<inner>) > log …`
 *
 * Any doubt (newline, here-doc, unbalanced / escaped / nested quotes, `$`/backtick inside a
 * double-quoted body, nothing left after stripping) returns the ORIGINAL command with no
 * labels — never a misleading command. The caller keeps the full original for title/expansion.
 */

export interface DeshelledCmd {
  /** The core command to display (equals the input when nothing could be stripped safely). */
  readonly cmd: string;
  /** Short cwd label (`~` prefix kept when the path had one, else `…/<last two segments>`). */
  readonly cwd?: string;
  /** Full cwd path, for the label's title. */
  readonly cwdFull?: string;
  /** `timeout <duration>` label. */
  readonly timeout?: string;
}

const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
const SIGNAL_RE = /^-?[A-Za-z0-9]+$/;
const SHELL_C_RE = /^(?:sh|bash|zsh)\s+-[a-z]*c\s+('[^']*'|"[^"\\$`]*")/;

function unquoteSimple(tok: string): string | undefined {
  const q = tok[0];
  if (q === "'" || q === '"') {
    if (tok.length < 2 || tok[tok.length - 1] !== q) return undefined;
    const body = tok.slice(1, -1);
    if (body.includes(q) || /[\\$`]/.test(body)) return undefined;
    return body;
  }
  return tok;
}

/** Parse one leading `cd <path> (&&|;)`; returns path + rest. */
function takeCd(s: string): { path: string; rest: string } | undefined {
  const m = /^cd\s+("[^"\\$`]*"|'[^']*'|[^\s'"`$\\;&|()<>]+)\s*(?:&&|;)\s*(\S[\s\S]*)$/.exec(s);
  if (m === null) return undefined;
  const path = unquoteSimple(m[1] as string);
  if (path === undefined || path === "" || path === "-") return undefined;
  return { path, rest: m[2] as string };
}

/** Parse one leading `timeout [opts] DUR`; returns the duration + rest. */
function takeTimeout(s: string): { dur: string; rest: string } | undefined {
  const toks = s.split(/\s+/);
  if (toks[0] !== "timeout") return undefined;
  let i = 1;
  for (;;) {
    const t = toks[i];
    if (t === undefined) return undefined;
    if (t === "--foreground" || t === "--preserve-status" || t === "-v" || t === "--verbose") i += 1;
    else if (/^--(?:signal|kill-after)=[A-Za-z0-9.]+$/.test(t)) i += 1;
    else if (t === "-s" || t === "-k") {
      const v = toks[i + 1];
      if (v === undefined || !(t === "-k" ? DURATION_RE.test(v) : SIGNAL_RE.test(v))) return undefined;
      i += 2;
    } else break;
  }
  const dur = toks[i];
  if (dur === undefined || !DURATION_RE.test(dur)) return undefined;
  // Re-derive `rest` from the source text so inner whitespace is preserved verbatim.
  let idx = 0;
  for (let k = 0; k <= i; k++) {
    const at = s.indexOf(toks[k] as string, idx);
    idx = at + (toks[k] as string).length;
  }
  const rest = s.slice(idx).replace(/^\s+/, "");
  return rest === "" ? undefined : { dur, rest };
}

interface Stripped {
  rest: string;
  cwdFull?: string;
  dur?: string;
}

/** Strip leading cd / timeout wrappers (any order, each at most once). */
function stripPrefixes(input: string): Stripped {
  let rest = input;
  let cwdFull: string | undefined;
  let dur: string | undefined;
  for (let n = 0; n < 2; n++) {
    if (cwdFull === undefined) {
      const c = takeCd(rest);
      if (c !== undefined) {
        cwdFull = c.path;
        rest = c.rest;
        continue;
      }
    }
    if (dur === undefined) {
      const t = takeTimeout(rest);
      if (t !== undefined) {
        dur = t.dur;
        rest = t.rest;
        continue;
      }
    }
    break;
  }
  // A second `cd` after the stripped one would make the cwd label lie about where the command
  // really runs — be conservative and strip nothing.
  if (cwdFull !== undefined && takeCd(rest) !== undefined) return { rest: input };
  return { rest, ...(cwdFull !== undefined ? { cwdFull } : {}), ...(dur !== undefined ? { dur } : {}) };
}

function unwrapQuoted(tok: string): string {
  return tok.slice(1, -1);
}

/** `…/<last two segments>` for long paths; `~`-rooted or short paths stay as they are. */
export function cwdLabel(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const segs = trimmed.split("/").filter((s) => s !== "");
  if (trimmed.startsWith("~")) return trimmed;
  if (segs.length <= 2) return trimmed;
  return `…/${segs.slice(-2).join("/")}`;
}

function result(core: string, s: Stripped, original: string): DeshelledCmd {
  const cmd = core.trim();
  if (cmd === "") return { cmd: original };
  // Quote ambiguity in what is left (odd quote count) ⇒ keep the original untouched.
  if ((cmd.match(/'/g)?.length ?? 0) % 2 === 1 || (cmd.match(/"/g)?.length ?? 0) % 2 === 1) return { cmd: original };
  return {
    cmd,
    ...(s.cwdFull !== undefined ? { cwd: cwdLabel(s.cwdFull), cwdFull: s.cwdFull } : {}),
    ...(s.dur !== undefined ? { timeout: `timeout ${s.dur}` } : {}),
  };
}

export function deshellCmd(original: string): DeshelledCmd {
  const raw = typeof original === "string" ? original : "";
  const src = raw.trim();
  if (src === "" || /[\r\n]/.test(raw) || src.includes("<<")) return { cmd: raw };

  // Shape: `( [cd …] [timeout …] [sh -c '<inner>' | plain] ) <tail>`
  if (src.startsWith("(")) {
    const s = stripPrefixes(src.slice(1).trimStart());
    if (s.cwdFull === undefined && s.dur === undefined) return { cmd: raw };
    const sh = SHELL_C_RE.exec(s.rest);
    let inner: string | undefined;
    let after: string;
    if (sh !== null) {
      inner = unwrapQuoted(sh[1] as string);
      after = s.rest.slice(sh[0].length);
    } else {
      const plain = /^([^()'"`$\\]+?)(\s*\)[\s\S]*)$/.exec(s.rest);
      if (plain === null) return { cmd: raw };
      inner = plain[1] as string;
      after = plain[2] as string;
    }
    const close = /^\s*\)([\s\S]*)$/.exec(after);
    if (close === null || inner.trim() === "") return { cmd: raw };
    return result(`(${inner.trim()})${close[1] as string}`, s, raw);
  }

  const s = stripPrefixes(src);
  if (s.cwdFull === undefined && s.dur === undefined && !SHELL_C_RE.test(s.rest)) return { cmd: raw };
  const sh = SHELL_C_RE.exec(s.rest);
  if (sh !== null && sh[0].length === s.rest.length) return result(unwrapQuoted(sh[1] as string), s, raw);
  if (s.cwdFull === undefined && s.dur === undefined) return { cmd: raw };
  return result(s.rest, s, raw);
}
