/**
 * M11 (fleet-widget pipeline view): static pre-scan of a workflow script's
 * `phase(<literal>)` call sites.
 *
 * The registry's runtime feed (`subagent:workflow:phase` enter events) only
 * reveals phases one at a time, as the script actually calls `phase()`. To
 * lay out the whole chain from the first tick instead, `background.ts` scans
 * the script source once at `start()` and passes the result to
 * `WorkflowActivityRegistry.register` as `plannedPhases`.
 *
 * Documented scan policy (deliberately conservative — the runtime feed stays
 * authoritative for state and ordering):
 *  - Matched forms: `phase("x")`, `phase('x')`, ``phase(`x`)`` (no
 *    interpolation) and the tagged form ``phase`x` ``. Property accesses
 *    (`api.phase("x")`) count too; word-suffix identifiers (`myphase("x")`)
 *    do not (`\b` boundary).
 *  - Dynamic names are SKIPPED: interpolated templates (``phase(`p-${i}`)``),
 *    concatenated arguments (`phase("step " + i)`), and any argument form
 *    other than a single closing literal. Template literals containing `$`
 *    anywhere are skipped wholesale (conservative: an escaped `\$` still
 *    matches).
 *  - Comments are stripped only where they START a line (after indentation):
 *    whole-line `// ...` and block comments whose `/*` opens a line. Those are
 *    the realistic homes of commented-out or example `phase("x")` calls that
 *    would otherwise become permanent ghost `○` chips. Trailing `//` and
 *    mid-line `/*` are left alone on purpose — without a real tokenizer they
 *    are indistinguishable from URLs and globs (`src/**` + `/*.ts`) inside
 *    prompt strings. A residual ghost chip is harmless: it never claims
 *    progress, and runtime entry/append rules keep the entered segment truthful.
 *  - Labels are unescaped (`\'`, `\"`, ``\` ``, `\\`, `\n`, `\t`, `\r`),
 *    trimmed, de-duplicated in first-occurrence order and capped at
 *    MAX_PLANNED_PHASES.
 *
 * Pi-free by construction (pure string function, no imports).
 */

/** How many distinct planned phase labels the chain will pre-lay; further ones only appear at runtime. */
export const MAX_PLANNED_PHASES = 12;

/**
 * One `phase(<string-literal>)` call site. Alternation:
 *  - paren form: `phase` \s* `(` \s* (double | single | backtick literal) \s* `)`
 *    (the literal must be the complete argument — concatenated/dynamic args fail the closing `\s*\)`),
 *  - tagged form: `phase` \s* backtick-literal (no parens at all).
 * Every literal content class excludes `\` (escapes go through `\\.`) and `$`
 * (interpolation), so an unterminated/dynamic literal never matches.
 */
const PHASE_LITERAL =
  /\bphase\s*(?:\(\s*(?:"((?:\\.|[^"\\$])*)"|'((?:\\.|[^'\\$])*)'|`((?:\\.|[^\\`$])*)`)\s*\)|\s*`((?:\\.|[^\\`$])*)`)/g;

/** Whole-line `//` comments and line-leading block comments only (see the module doc for why nothing more). */
const LEADING_LINE_COMMENT = /^[ \t]*\/\/.*$/gm;
const LEADING_BLOCK_COMMENT = /^[ \t]*\/\*[\s\S]*?\*\//gm;

function stripLeadingComments(script: string): string {
  return script.replace(LEADING_BLOCK_COMMENT, "").replace(LEADING_LINE_COMMENT, "");
}

/** Minimal string-unescape for the escape sequences a phase title can realistically carry. */
function unescapeJsLiteral(raw: string): string {
  return raw.replace(/\\(.)/gs, (_all, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === "r") return "\r";
    return ch; // \' \" \` \\ and anything else: the character itself
  });
}

/**
 * Extract the planned phase labels from a workflow script, in first-occurrence
 * order, de-duplicated, at most MAX_PLANNED_PHASES of them. See the module
 * doc for the exact match/skip policy.
 */
export function scanPlannedPhases(script: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of stripLeadingComments(script).matchAll(PHASE_LITERAL)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (raw === undefined) continue;
    const label = unescapeJsLiteral(raw).trim();
    if (label === "" || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= MAX_PLANNED_PHASES) break;
  }
  return out;
}
