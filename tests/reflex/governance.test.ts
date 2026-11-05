/**
 * jev-reflex R2b: G2/G3/G4 source scans over `src/reflex/**` — no `Symbol.for` globals (R-I8), no bare timers (only the
 * injected Clock, I5), no way to inject a turn or rewrite input (R-I3). Comments are stripped before matching so
 * the explanatory header text can name the forbidden identifiers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "src", "reflex");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Strip block + line comments (naïve but sufficient: no `//` inside string literals in src/reflex). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const files = walk(ROOT).map((f) => ({ f: f.slice(ROOT.length + 1), src: code(readFileSync(f, "utf8")) }));

function offenders(re: RegExp): string[] {
  return files.filter(({ src }) => re.test(src)).map(({ f }) => f);
}

/**
 * From the index JUST AFTER a call's `(`, scan the call's argument list and report how many TOP-LEVEL commas it
 * has and its first non-whitespace character (a single object-literal argument ⇒ 0 and "{").
 */
function callArguments(src: string, afterOpen: number): { topLevelCommas: number; firstChar: string } {
  let depth = 1; // already inside the call's argument list
  let topLevelCommas = 0;
  let firstChar = "";
  for (let i = afterOpen; i < src.length; i++) {
    const ch = src[i]!;
    if (firstChar === "" && !/\s/.test(ch)) firstChar = ch;
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return { topLevelCommas, firstChar };
    } else if (ch === "," && depth === 1) topLevelCommas += 1;
  }
  return { topLevelCommas, firstChar }; // unterminated: fail via mismatched expectations
}

describe("src/reflex governance scans", () => {
  it("sees the reflex tree (guards against a vacuous scan)", () => {
    const names = files.map((x) => x.f);
    expect(names).toEqual(expect.arrayContaining(["wire.ts", "command.ts", "core/gate.ts", "ports/index.ts"]));
  });

  it("G2: no Symbol.for global anywhere in src/reflex", () => {
    expect(offenders(/Symbol\s*\.\s*for\s*\(/)).toEqual([]);
  });

  it("G3: no bare setTimeout / setInterval / setImmediate (timers only via the injected Clock)", () => {
    expect(offenders(/\b(?:setTimeout|setInterval|setImmediate)\s*\(/)).toEqual([]);
  });

  it("G4: never sendUserMessage / triggerTurn / transform (R-I3); sendMessage is the wire's subagent:reflex AUTO answer only", () => {
    expect(offenders(/sendUserMessage|triggerTurn|["']transform["']|action\s*:\s*["']transform["']/)).toEqual([]);
    // R3a (root ruling 2026-11-05): the AUTO answer is the single sanctioned sendMessage. Only wire.ts
    // may call it; every call site must be the `subagent:reflex` custom message (R-I9), carry NO
    // second `options` argument (idle append, no run — C-R3), and at least one call site must exist.
    expect(offenders(/\.sendMessage\s*\(/)).toEqual(["wire.ts"]);
    const wire = files.find((x) => x.f === "wire.ts")!.src;
    const sites = [...wire.matchAll(/\.sendMessage\s*\(/g)];
    expect(sites.length).toBeGreaterThan(0);
    for (const m of sites) {
      const near = wire.slice(m.index!, m.index! + 240);
      expect(near, `call site at ${m.index}`).toMatch(/customType:\s*"subagent:reflex"/);
      expect(near).not.toMatch(/triggerTurn|deliverAs/);
      // exactly ONE top-level argument, and it is an object literal (paren/brace balance scan)
      const call = callArguments(wire, m.index! + m[0].length);
      expect(call.topLevelCommas).toBe(0);
      expect(call.firstChar).toBe("{");
    }
  });

  // ---- G5 (#25 B4, R-I12): the draft layer can never reach AUTO or the builtin state machine ----
  it("G5a: `runAuto(` has exactly ONE call site (the builtin AUTO branch, behind admitAuto)", () => {
    const wire = files.find((x) => x.f === "wire.ts")!.src;
    const calls = [...wire.matchAll(/\brunAuto\s*\(/g)];
    // definition `const runAuto = async (` is not a call (no `(` right after the name); one real call remains
    expect(calls).toHaveLength(1);
    const around = wire.slice(Math.max(0, calls[0]!.index! - 160), calls[0]!.index!);
    expect(around).toMatch(/inFlight = true/);
    expect(wire.slice(0, calls[0]!.index!)).toMatch(/if \(admitAuto\(script\.id\)\)/);
    expect(offenders(/\brunAuto\s*\(/)).toEqual(["wire.ts"]);
  });

  it("G5b: catalog.ts contains no `draft.` literal (builtin ids never live in the draft namespace)", () => {
    const catalog = files.find((x) => x.f === "core/catalog.ts")!.src;
    expect(catalog).not.toMatch(/draft\./);
  });

  it('G5c: every `accountBuiltin(` call site is guarded by an `origin === "builtin"` check just before it', () => {
    const wire = files.find((x) => x.f === "wire.ts")!.src;
    const sites = [...wire.matchAll(/\baccountBuiltin\s*\(/g)].filter(
      // the definition is `const accountBuiltin = (` — its name is followed by ` =`, not `(`
      (m) => !wire.slice(Math.max(0, m.index! - 6), m.index!).includes("const "),
    );
    expect(sites.length).toBeGreaterThanOrEqual(2); // shadow-port path + AUTO fallback path
    for (const m of sites) {
      const before = wire.slice(Math.max(0, m.index! - 220), m.index!);
      expect(before, `call site at ${m.index}`).toMatch(/origin === "builtin"/);
    }
    // and nothing outside wire.ts may call it
    expect(offenders(/\baccountBuiltin\s*\(/)).toEqual(["wire.ts"]);
  });

  it("G5d: the draft candidate path never touches the builtin state machine or AUTO", () => {
    const wire = files.find((x) => x.f === "wire.ts")!.src;
    const start = wire.indexOf("const draftCandidate");
    expect(start).toBeGreaterThan(0);
    const end = wire.indexOf('pi.on("input"', start);
    const body = wire.slice(start, end);
    for (const forbidden of [
      /\bstateOf\s*\(/,
      /\beffectiveState\s*\(/,
      /\brunAuto\s*\(/,
      /\baccountBuiltin\s*\(/,
      /\brtOf\s*\(/,
      /runtimes\./,
      /\bonExecOutcome\b/,
      /\bonRepeat\b/,
      /\bonCorrected\b/,
    ]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("G5e: the scan self-test — a guard-less call site would be flagged", () => {
    const bad = code("const x = () => { accountBuiltin(script, outcome, () => 1); };");
    const m = [...bad.matchAll(/\baccountBuiltin\s*\(/g)][0]!;
    expect(bad.slice(Math.max(0, m.index! - 220), m.index!)).not.toMatch(/origin === "builtin"/);
  });

  it("the scan itself detects violations (self-test of the stripping + patterns)", () => {
    const bad = code("const a = Symbol.for('x'); setTimeout(() => 1, 1); pi.sendUserMessage('x');");
    expect(/Symbol\s*\.\s*for\s*\(/.test(bad)).toBe(true);
    expect(/\b(?:setTimeout|setInterval|setImmediate)\s*\(/.test(bad)).toBe(true);
    expect(/sendUserMessage/.test(bad)).toBe(true);
    expect(/Symbol\s*\.\s*for/.test(code("// Symbol.for(\n/* setTimeout( */"))).toBe(false);
    // callArguments: one object literal ⇒ 0 commas / "{"; two arguments / leading non-object ⇒ detected
    expect(callArguments('pi.sendMessage({ customType: "subagent:reflex", details: { a: 1 } })', 15)).toEqual({
      topLevelCommas: 0,
      firstChar: "{",
    });
    expect(callArguments("pi.sendMessage({ a: 1 }, { triggerTurn: true })", 15).topLevelCommas).toBe(1);
    expect(callArguments('pi.sendMessage("x", {})', 15).firstChar).toBe('"');
  });
});
