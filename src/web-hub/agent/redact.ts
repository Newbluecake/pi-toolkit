/**
 * bash-jobs-panel plan §3.3 / D2a (包 A): agent-side redaction + tail sanitization for the
 * `StatusInfo.bashJobs` projection.
 *
 * **脱敏是 best-effort 卫生，明确不是安全边界** (plan D2a, user ruling #1/#2): the same command
 * text already reaches the web transcript verbatim through the bash ToolCard summary and the
 * completion notification card (10-line tail, `display:true`), so the panel does not widen the
 * exposure surface — this module only shrinks it. The panel's expanded view always shows the
 * fixed hint "命令与输出可能含敏感信息；脱敏仅尽力而为" (package B).
 *
 * `redactCommand` pipeline (D2a, 先匹配后截断): `raw.slice(0, 8192)` → `redactSecrets()` on the
 * RAW multi-line text (quotes / newlines / heredocs stay visible to the matcher) → whitespace
 * collapse to one line → char-truncate to 200 (`…`) → UTF-8 byte cap. Any token whose start is
 * <200 chars is therefore fully matched inside the 8 KiB window; content past 8 KiB is never
 * displayed and fragments crossing the 8 KiB edge are dropped by the truncation. `previewCommand`
 * is deliberately NOT reused (it truncates first).
 *
 * `sanitizeTail` pipeline (D2a): strip ANSI CSI/OSC sequences and all C0 controls except
 * `\n`/`\t` → if the read started mid-file (`logBytes > TAIL_READ_WINDOW_BYTES`), drop the first
 * (possibly half-) line — a half token prefix cannot be rule-matched anyway → per-line
 * `redactSecrets()` → line/byte cap (drop from the HEAD, keep the tail).
 */

/** The tail read window `stack.ts`'s `readBashJobTail` uses (`BASH_JOB_TAIL_BYTES`, 1 KiB). */
export const TAIL_READ_WINDOW_BYTES = 1024;
/** Max lines in a projected tail (`BASH_JOB_TAIL_LINES`, 10). */
export const TAIL_MAX_LINES = 10;
/** Command redaction window: raw text fed to the matcher before any truncation. */
export const CMD_SOURCE_WINDOW_CHARS = 8192;
/** Char cap of the projected command (D6: ≤200 chars). */
export const CMD_MAX_CHARS = 200;
/** Byte cap of the projected command (D6: ≤600 B). */
export const CMD_MAX_BYTES = 600;

// ------------------------------------------------------------ redactSecrets

/** D2a rule 1/5's sensitive-KEY substring alternation (case-insensitive, matched INSIDE an identifier). */
const KEY_SUBSTRINGS = "(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|auth|credential|cookie|session|private[_-]?key)";
/** A shell identifier that CONTAINS a sensitive substring, e.g. `GITHUB_TOKEN`, `aws_secret`.
 *  The prefix/suffix are `*` (not `+`) so a substring at position 0 (`TOKEN`, `password`) matches
 *  too — the `(?<![\w-])` lookbehind on the whole assignment anchors the identifier's true
 *  start, so `xtoken=…` still matches (prefix `x`) while `--author=…` cannot (blocked by `-`). */
const KEY_IDENT = `[A-Za-z0-9_]*${KEY_SUBSTRINGS}[A-Za-z0-9_]*`;
/** D2a rule 1's VAL grammar: quoted (double/single), `$(…)` command substitution, or one bare word. */
const VAL_GRAMMAR = `("[^"]*"|'[^']*'|\\$\\([^)]*\\)|\\S+)`;

const ASSIGNMENT_RE = new RegExp(`(?<![\\w?&/-])((?:export[ \\t]+)?${KEY_IDENT})=${VAL_GRAMMAR}`, "gi");

const FLAG_VALUE_RE = /(--(?:token|password|api-key|api_key|secret|auth)[= ]+)("[^"]*"|'[^']*'|[^\s"']+)/gi;

/** Commands whose tight `-p<password>` form counts as a secret flag (D2a rule 2: "仅 mysql/psql 类"). */
const P_TIGHT_COMMANDS = /\b(?:mysql|mysqldump|psql|pg_dump|pg_restore)\b/i;
const P_TIGHT_RE = /(?<![\w-])-p([^\s-][^\s]*)/g;

const HEADER_RE = /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-[\w-]*(?:Key|Token)):[ \t]*[^"'\n]*/gi;
const BEARER_RE = /\bBearer[ \t]+\S+/g;
const BASIC_RE = /\bBasic[ \t]+[A-Za-z0-9+/=]+/g;

const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]*:[^/@\s]*@/gi;
const URL_QUERY_RE = new RegExp(
  `([?&](?:token|access_token|api_key|key|sig|signature|password|secret)=)[^&\\s'"]*`,
  "gi",
);

const JSON_FIELD_RE = new RegExp(`"(${KEY_IDENT})"[ \\t]*:[ \\t]*"[^"]*"`, "gi");

const PREFIX_TOKENS_RE =
  /(?<![\w-])(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+|ghs_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[abp]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g;

const BASE64_CANDIDATE_RE = /[A-Za-z0-9+/]{64,}={0,2}/g;

/**
 * Best-effort secret redaction (D2a rules 1–7), applied to raw text (possibly multi-line).
 * Pure, total (never throws), and idempotent — running it over already-redacted text is a no-op
 * (`KEY=***` re-matches rule 1 and rewrites to itself), which the sampler relies on.
 */
export function redactSecrets(input: string): string {
  let s = input;
  // 1. KEY=VAL / export KEY=VAL assignments.
  s = s.replace(ASSIGNMENT_RE, "$1=***");
  // 2. Flag values: --token/--password/--api-key/--secret/--auth (space or `=` form) and the
  //    mysql/psql-style tight `-p<password>` form.
  s = s.replace(FLAG_VALUE_RE, "$1***");
  if (P_TIGHT_COMMANDS.test(input)) s = s.replace(P_TIGHT_RE, "-p***");
  // 3. Header lines (`Name: value` → `Name: ***`) and standalone Bearer/Basic credentials. The
  //    header rule runs first so `Authorization: Bearer x` loses its whole value in one pass.
  s = s.replace(HEADER_RE, "$1: ***");
  s = s.replace(BEARER_RE, "Bearer ***");
  s = s.replace(BASIC_RE, "Basic ***");
  // 4. URLs: userinfo (`://u:p@` → `://***@`) and sensitive query values (`=…` → `=***`).
  s = s.replace(URL_USERINFO_RE, "$1***@");
  s = s.replace(URL_QUERY_RE, "$1***");
  // 5. JSON string fields with sensitive keys (`"password":"p"` → `"password":"***"`).
  s = s.replace(JSON_FIELD_RE, '"$1":"***"');
  // 6. Known token prefixes (OpenAI sk-, GitHub ghp_/gho_/ghs_/github_pat_, Slack xox[abp]-,
  //    AWS AKIA…, JWT eyJ….….…).
  s = s.replace(PREFIX_TOKENS_RE, "***");
  // 7. Long base64 runs (≥64 chars) that mix upper + lower + digit — a 40-hex git sha or a
  //    64-hex sha256 has no uppercase and is deliberately left alone.
  s = s.replace(BASE64_CANDIDATE_RE, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m) ? "***" : m));
  return s;
}

// ------------------------------------------------------------ sanitizeTail

const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Every C0 control except `\t` (0x09) and `\n` (0x0a), plus DEL. */
const C0_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripAnsiAndControls(text: string): string {
  return text.replace(CSI_RE, "").replace(OSC_RE, "").replace(C0_RE, "");
}

/**
 * Tail pipeline (D2a): ANSI/control strip → mid-file first-line drop → per-line redaction →
 * head-drop line/byte cap. `logBytes` is the file size the sample itself saw
 * (`readBashJobTail`'s `logBytes`): `> TAIL_READ_WINDOW_BYTES` means the read started mid-file,
 * so the first line is likely half a line and is dropped (only when a later newline exists —
 * a lone trailing chunk IS the file's real last line).
 */
export function sanitizeTail(text: string, logBytes: number): string {
  let t = stripAnsiAndControls(text);
  if (logBytes > TAIL_READ_WINDOW_BYTES) {
    const nl = t.indexOf("\n");
    if (nl >= 0) t = t.slice(nl + 1);
  }
  t = t
    .split("\n")
    .map((line) => redactSecrets(line))
    .join("\n");
  return capTailText(t, TAIL_MAX_LINES, TAIL_READ_WINDOW_BYTES);
}

/**
 * Line/byte cap for tail text: keep at most `maxLines` lines, then at most `maxBytes` UTF-8
 * bytes, always dropping from the HEAD (keeping the tail). A single over-cap line falls back to
 * a UTF-8-boundary-safe tail byte slice. Shared by `sanitizeTail` and the projection's
 * budget-ladder tail shrinks.
 */
export function capTailText(text: string, maxLines: number, maxBytes: number): string {
  let lines = text.split("\n");
  if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines);
  let out = lines.join("\n");
  while (Buffer.byteLength(out, "utf8") > maxBytes && lines.length > 1) {
    lines = lines.slice(1);
    out = lines.join("\n");
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    const buf = Buffer.from(out, "utf8");
    let start = buf.length - maxBytes;
    while (start > 0 && (buf.readUInt8(start) & 0xc0) === 0x80) start--;
    out = buf.toString("utf8", start);
  }
  return out;
}

// ------------------------------------------------------------ redactCommand

export interface RedactedCommand {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Command pipeline (D2a, 先匹配后截断): match on the raw 8 KiB window (quotes/newlines/heredocs
 * intact), collapse whitespace to one line, char-truncate to `CMD_MAX_CHARS` with `…`, then
 * UTF-8 byte-cap to `CMD_MAX_BYTES`. `truncated` is true when EITHER cap fired (the wire's
 * `cmdTruncated`).
 */
export function redactCommand(raw: string): RedactedCommand {
  const matched = redactSecrets(raw.slice(0, CMD_SOURCE_WINDOW_CHARS));
  const oneLine = matched.replace(/\s+/g, " ").trim();
  let text = oneLine;
  let truncated = false;
  if (text.length > CMD_MAX_CHARS) {
    text = `${text.slice(0, CMD_MAX_CHARS - 1)}…`;
    truncated = true;
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.length > CMD_MAX_BYTES) {
    let end = CMD_MAX_BYTES;
    while (end > 0 && (buf.readUInt8(end) & 0xc0) === 0x80) end--;
    text = buf.toString("utf8", 0, end);
    truncated = true;
  }
  return { text, truncated };
}
