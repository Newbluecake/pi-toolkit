import { describe, expect, it } from "vitest";
import {
  BUILTIN_USAGE,
  TOOLKIT_USAGE,
  clampUsageLine,
  resolveCommandUsage,
  usageFromDescription,
} from "../../../src/web-hub/agent/command-usage.js";
import { CMD_ARGS } from "../../../src/web-hub/protocol/command-args.js";

describe("command-usage — table bounds (r1 #3: handwritten table stays within the cap)", () => {
  it("every TOOLKIT_USAGE value is single-line, control-free and ≤ usageMaxChars", () => {
    for (const [name, usage] of Object.entries(TOOLKIT_USAGE)) {
      expect(usage.length, `${name} usage length`).toBeLessThanOrEqual(CMD_ARGS.usageMaxChars);
      expect(usage, `${name} single line`).not.toMatch(/[\r\n\x00-\x08\x0b-\x1f]/);
    }
  });

  it("every BUILTIN_USAGE value is within the cap", () => {
    for (const [name, usage] of Object.entries(BUILTIN_USAGE)) {
      expect(usage.length, `${name}`).toBeLessThanOrEqual(CMD_ARGS.usageMaxChars);
    }
  });

  it("the cache-ttl entry is the r1 #3 condensed form (fits, no 'usage:' prefix)", () => {
    expect(TOOLKIT_USAGE["cache-ttl"]).not.toContain("usage:");
    expect(TOOLKIT_USAGE["cache-ttl"].length).toBeLessThanOrEqual(CMD_ARGS.usageMaxChars);
  });

  it("commands with no arguments have no entry (never invent usage)", () => {
    expect(TOOLKIT_USAGE.clear).toBeUndefined();
    expect(TOOLKIT_USAGE.tasklist).toBeUndefined();
    expect(TOOLKIT_USAGE.watch).toBeUndefined();
  });
});

describe("command-usage — clampUsageLine (r1 #3 truncation rule)", () => {
  it("short lines pass through unchanged (already single-lined)", () => {
    expect(clampUsageLine("a | b <c>")).toBe("a | b <c>");
  });

  it("collapses runs of whitespace and strips ANSI/control bytes", () => {
    expect(clampUsageLine(" a\x1b[31mred\x1b[0m\t b  c ")).toBe("ared b c");
  });

  it("over-cap lines truncate at the last whitespace before the cap and end with …", () => {
    const words = Array.from({ length: 60 }, (_, i) => `tok${i}`);
    const long = words.join(" ");
    const out = clampUsageLine(long);
    expect(out.length).toBeLessThanOrEqual(CMD_ARGS.usageMaxChars);
    expect(out.endsWith("…")).toBe(true);
    // cut happened at a whitespace boundary: the last token before … is a complete word
    const lastWord = out.slice(0, -1).split(" ").pop()!;
    expect(words).toContain(lastWord);
  });

  it("a single over-cap token hard-cuts rather than leaving a stub", () => {
    const out = clampUsageLine("x".repeat(400));
    expect(out.length).toBe(CMD_ARGS.usageMaxChars);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("command-usage — usageFromDescription heuristic (§3.2, D5)", () => {
  it("extracts the command's own /name <…> fragment (sentence boundary at the end)", () => {
    expect(usageFromDescription("mem", "Project memory. /mem <list> [--force] [slug|all] and more.")).toBe(
      "<list> [--force] [slug|all] and more",
    );
  });

  it("a /other <x> mention is not our usage", () => {
    expect(usageFromDescription("mem", "see /other <thing> for details")).toBeUndefined();
  });

  it("fragments not starting with < or [ produce nothing (the frozen anchor)", () => {
    expect(usageFromDescription("mem", "memory: /mem list [--force] here")).toBeUndefined();
  });

  it("multi-space fragments are collapsed and trailing punctuation trimmed", () => {
    expect(usageFromDescription("g", "do things: /g  <a>   [b]")).toBe("<a> [b]");
  });

  it("descriptions without a usage-shaped fragment produce nothing (never invented)", () => {
    expect(usageFromDescription("mem", "Project memory manager")).toBeUndefined();
    expect(usageFromDescription("mem", undefined)).toBeUndefined();
  });
});

describe("command-usage — resolveCommandUsage priority chain (§3.2)", () => {
  it("toolkit table wins over builtin table and heuristic (even with a conflicting description)", () => {
    // "model" has a builtin hint; give the description a conflicting form — builtin still wins
    expect(resolveCommandUsage("model", "builtin", "/model <wrong>")).toBe("<provider/model>");
    // a toolkit-named command reported as builtin still gets the toolkit line
    expect(resolveCommandUsage("mem", "builtin", "ignore me")).toBe(TOOLKIT_USAGE.mem);
  });

  it("builtin table wins over the heuristic", () => {
    expect(resolveCommandUsage("thinking", "builtin", "/thinking [whatever]")).toBe("<level>");
  });

  it("heuristic applies only when neither table knows the name", () => {
    expect(resolveCommandUsage("third", "extension", "tool: /third <a|b> choices")).toBe("<a|b> choices");
  });

  it("no source ⇒ undefined (UI falls back to the description)", () => {
    expect(resolveCommandUsage("third", "extension", "no hints here")).toBeUndefined();
  });
});
