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

  it("G4: never sendUserMessage / triggerTurn / transform (R-I3); R2b sends no message at all", () => {
    expect(offenders(/sendUserMessage|triggerTurn|["']transform["']|action\s*:\s*["']transform["']/)).toEqual([]);
    // R2b is shadow-only: sendMessage belongs to R3a (AUTO answer) — wire.ts must not call it yet.
    expect(files.find((x) => x.f === "wire.ts")!.src).not.toMatch(/\bsendMessage\b/);
  });

  it("the scan itself detects violations (self-test of the stripping + patterns)", () => {
    const bad = code("const a = Symbol.for('x'); setTimeout(() => 1, 1); pi.sendUserMessage('x');");
    expect(/Symbol\s*\.\s*for\s*\(/.test(bad)).toBe(true);
    expect(/\b(?:setTimeout|setInterval|setImmediate)\s*\(/.test(bad)).toBe(true);
    expect(/sendUserMessage/.test(bad)).toBe(true);
    expect(/Symbol\s*\.\s*for/.test(code("// Symbol.for(\n/* setTimeout( */"))).toBe(false);
  });
});
