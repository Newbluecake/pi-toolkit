/**
 * web-hub-spawn plan §SP7 (arch v2 §4.1/#3): the `hub/spawn/**` zero-`as` source scan.
 *
 * The whole spawn subsystem is written without a single type assertion (`as` casts): unknown
 * JSON narrows through type predicates / `in`-narrowing, test doubles line up with ports via
 * `satisfies`, and even import aliases are spelled namespace-style — because the plan's rule is
 * the plain token: "禁止 `as`（`as const` 除外）". The single sanctioned exception is `as const`
 * (literal freezing, e.g. `retry: true as const`).
 *
 * This test enforces exactly that, over EVERY `*.ts` file under `src/web-hub/hub/spawn/` (so
 * future packages are covered the moment they land): a small char-scanner blanks out comments,
 * string/template literals and regex literals (preserving line structure), then any remaining
 * `as` token that is not `as const` fails with file:line:col.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SPAWN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../src/web-hub/hub/spawn");

/** Keywords after which a `/` can only start a regex literal (never division). */
const REGEX_PRECEDING_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

type ScanState = "code" | "line" | "block" | "sq" | "dq" | "regex" | "tmpl";

/**
 * Blank out comments, string/template literals and regex literals, preserving offsets and
 * newlines. A pragmatic state machine (not a full parser): template `${}` nesting is tracked
 * with a context stack, regex-vs-division uses the standard preceding-token heuristic — enough
 * for this directory's controlled style. Misclassification only ever HIDES text from the `as`
 * hunt, never invents hits, and the review rule keeps tricky style out of the tree anyway.
 */
export function stripNoise(src: string): string {
  const out = src.split("");
  const stack: Array<"tmpl" | "brace"> = [];
  let state: ScanState = "code";
  // The two non-whitespace code chars preceding the cursor — the regex-vs-division heuristic's
  // whole state (review re-run #6: `a++ / b` is DIVISION even though the last char is `+`).
  const prevChars = { prev: "", prevPrev: "" };
  let word = "";

  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    const next = src[i + 1] ?? "";

    const keepCodeChar = (): void => {
      if (!/\s/.test(c)) {
        prevChars.prevPrev = prevChars.prev;
        prevChars.prev = c;
      }
    };

    if (state === "line") {
      if (c === "\n") state = "code";
      else out[i] = " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i++;
        state = "code";
      } else if (c !== "\n") out[i] = " ";
      continue;
    }
    if (state === "sq" || state === "dq" || state === "regex" || state === "tmpl") {
      if (c === "\\") {
        out[i] = " ";
        if (i + 1 < src.length) out[i + 1] = " ";
        i++;
        continue;
      }
      if (state === "tmpl" && c === "$" && next === "{") {
        // Enter the template's expression: push ONE context marker and consume BOTH chars —
        // letting the `{` reach the code-state handler would push a second (brace) entry and
        // desynchronize every later `}`.
        stack.push("tmpl");
        state = "code";
        out[i] = " ";
        out[i + 1] = " ";
        i++;
        prevChars.prevPrev = prevChars.prev;
        prevChars.prev = "{";
        word = "";
        continue;
      }
      if (
        (state === "sq" && c === "'") ||
        (state === "dq" && c === '"') ||
        (state === "regex" && c === "/") ||
        (state === "tmpl" && c === "`")
      ) {
        out[i] = " ";
        state = "code";
        continue;
      }
      if (state === "regex" && c === "\n") {
        state = "code"; // unterminated "regex" can only be a misclassified division
        continue;
      }
      if (c !== "\n") out[i] = " ";
      continue;
    }

    // state === "code"
    if (/[A-Za-z0-9_$]/.test(c)) {
      word += c;
      keepCodeChar();
      continue;
    }
    const finishedWord = word;
    if (c === "\n") word = "";
    else if (c !== " " && c !== "\t") word = "";

    if (c === "/" && next === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      i++;
      state = "line";
      continue;
    }
    if (c === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i++;
      state = "block";
      continue;
    }
    if (c === "'") {
      out[i] = " ";
      state = "sq";
      keepCodeChar();
      continue;
    }
    if (c === '"') {
      out[i] = " ";
      state = "dq";
      keepCodeChar();
      continue;
    }
    if (c === "`") {
      out[i] = " ";
      state = "tmpl";
      keepCodeChar();
      continue;
    }
    if (c === "/") {
      // Regex-vs-division (review re-run #6). Misreading division as regex HIDES text from
      // the `as` hunt, so every tie-break leans toward division: an identifier char, digit,
      // `)` or `]` before the slash, or an `++`/`--` tail, is division. A keyword
      // (`return /re/`) or an operator/anchor before it still opens a regex literal.
      const division =
        /[A-Za-z0-9_$)\]]/.test(prevChars.prev) ||
        (prevChars.prev === prevChars.prevPrev && (prevChars.prev === "+" || prevChars.prev === "-"));
      // A keyword (`return /re/`) ALWAYS opens a regex — division needs a left operand, and a
      // keyword cannot be one — so that check outranks the division heuristic.
      const startsRegex =
        REGEX_PRECEDING_WORDS.has(finishedWord) ||
        (!division && ("([=!:&|?;{},<>+-*%^~".includes(prevChars.prev) || prevChars.prev === ""));
      if (startsRegex) {
        out[i] = " ";
        state = "regex";
      }
      keepCodeChar();
      continue;
    }
    if (c === "{") {
      stack.push("brace");
      keepCodeChar();
      continue;
    }
    if (c === "}") {
      const top = stack.pop();
      if (top === "tmpl") {
        out[i] = " ";
        state = "tmpl";
        continue;
      }
      keepCodeChar();
      continue;
    }
    keepCodeChar();
  }
  return out.join("");
}

/** All `as` tokens that are not the sanctioned `as const`, as `line:col` entries. */
export function findBannedAs(stripped: string): Array<{ line: number; col: number; ctx: string }> {
  const hits: Array<{ line: number; col: number; ctx: string }> = [];
  const lines = stripped.split("\n");
  const re = /\bas\b(?! const\b)/g;
  for (let l = 0; l < lines.length; l++) {
    const text = lines[l] ?? "";
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      hits.push({ line: l + 1, col: m.index + 1, ctx: text.trim().slice(0, 120) });
      m = re.exec(text);
    }
  }
  return hits;
}

describe("hub/spawn zero-`as` source scan (plan §SP7, arch §4.1 #3)", () => {
  it("scanner self-check: comments, strings, templates and regexes are stripped", () => {
    const src = [
      "// comment as well",
      "const s = 'str as str' + `t ${1 as const} tail as end`;",
      "/* block as comment */ const re = /as x/; const div = total / 2;",
      "const keep = value as string;",
    ].join("\n");
    const hits = findBannedAs(stripNoise(src));
    expect(hits).toHaveLength(1); // only the real cast on the last line
    expect(hits[0]?.line).toBe(4);
  });

  it("scanner self-check: division after ++/--, ')' and ']' must not swallow the rest as a regex (review re-run #6)", () => {
    const src = [
      "const q = a++ / b as string;", // ++ tail then division — the cast must be CAUGHT
      "const r = c-- / d;", // -- tail then division
      "const s = f(x) / g(y);", // ')' then division
      "const t = arr[0] / 2;", // ']' then division
      "const u = 1 / 2;", // digit then division
      "const arrow = (v) => /as hidden/;", // '=>' then a REAL regex — hidden, as intended
      "function w() {",
      "  return /as also hidden/;", // keyword then a REAL regex — hidden, as intended
      "}",
    ].join("\n");
    const hits = findBannedAs(stripNoise(src));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(1); // a++ / b as string
  });

  it("every hub/spawn source file is free of `as` (except `as const`)", () => {
    const files = readdirSync(SPAWN_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(11); // config..supervisor, ports, this feature
    const violations: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(SPAWN_DIR, f), "utf8");
      for (const hit of findBannedAs(stripNoise(src))) {
        violations.push(`${f}:${String(hit.line)}:${String(hit.col)}: ${hit.ctx}`);
      }
    }
    expect(violations.join("\n")).toBe("");
  });

  // session-history plan §4.5 (P-scan): `hub/spawn/history/` is a dedicated zero-`as`
  // subdirectory of the same contract. The original scan above is deliberately non-recursive
  // (readdirSync without withFileTypes/recursive), so this extends coverage explicitly instead
  // of changing that scan's shape — a future subdirectory should get the same treatment.
  it("every hub/spawn/history source file is free of `as` (except `as const`)", () => {
    const historyDir = join(SPAWN_DIR, "history");
    const files = readdirSync(historyDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(10); // budget..service, head/title/pin/generation/index/cwd/proc/occupancy/snapshot, ports
    const violations: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(historyDir, f), "utf8");
      for (const hit of findBannedAs(stripNoise(src))) {
        violations.push(`history/${f}:${String(hit.line)}:${String(hit.col)}: ${hit.ctx}`);
      }
    }
    expect(violations.join("\n")).toBe("");
  });
});
