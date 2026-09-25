import { describe, expect, it } from "vitest";
import { MAX_PLANNED_PHASES, scanPlannedPhases } from "../../src/workflow/phase-scan.js";

/**
 * M11 pipeline view: the static pre-scan that lays out a workflow's phase
 * chain before the script ever calls `phase()`. Pure string function — every
 * policy branch (quotes, templates, dynamic skips, cap, comments) is pinned
 * here because the registry treats the result as planned-but-pending chips.
 */

describe("phase-scan: literal extraction", () => {
  it("extracts single- and double-quoted labels in source order, de-duplicated", () => {
    const script = [
      "export const meta = { name: 'demo', description: 'd' };",
      'phase("scan");',
      "await agent({ label: 'a' });",
      "phase('summarize');",
      'phase("scan");', // duplicate — kept once, at first-occurrence position
      'phase("report");',
    ].join("\n");
    expect(scanPlannedPhases(script)).toEqual(["scan", "summarize", "report"]);
  });

  it("extracts interpolation-free template literals, parenthesized and tagged", () => {
    expect(scanPlannedPhases("phase(`scan`);")).toEqual(["scan"]);
    expect(scanPlannedPhases("phase`report`;")).toEqual(["report"]);
    expect(scanPlannedPhases("phase  `spaced`  ;")).toEqual(["spaced"]);
  });

  it("skips dynamic names: interpolated templates, concatenation, bare identifiers, calls", () => {
    expect(scanPlannedPhases("phase(`step-${i}`);")).toEqual([]);
    expect(scanPlannedPhases('phase("step " + i);')).toEqual([]);
    expect(scanPlannedPhases("phase(prefix);")).toEqual([]);
    expect(scanPlannedPhases("phase(getName());")).toEqual([]);
    expect(scanPlannedPhases("phase();")).toEqual([]);
  });

  it("template literals containing $ anywhere are skipped wholesale (conservative); \\<char> escapes opt back in", () => {
    expect(scanPlannedPhases("phase(`cost $5`);")).toEqual([]);
    expect(scanPlannedPhases('phase("cost $5");')).toEqual([]); // same class, same rule
    expect(scanPlannedPhases('phase("cost \\$5");')).toEqual(["cost $5"]);
  });

  it("word-suffix identifiers are not phase calls; property accesses are", () => {
    expect(scanPlannedPhases('myphase("x"); rephase("y"); phase2("z");')).toEqual([]);
    expect(scanPlannedPhases('api.phase("warm");')).toEqual(["warm"]);
  });

  it("drops phases in line-leading comments (no ghost chips from commented-out/example calls)", () => {
    expect(scanPlannedPhases('// phase("skipped-idea");\nphase("real");')).toEqual(["real"]);
    expect(scanPlannedPhases('  // e.g. phase("example")\nphase("real");')).toEqual(["real"]);
    expect(scanPlannedPhases('/* phase("blocked") */ phase("real");')).toEqual(["real"]);
    expect(scanPlannedPhases('/**\n * Usage: phase("doc-example")\n */\nphase("a");\nphase("b");')).toEqual(["a", "b"]);
  });

  it("leaves trailing // and mid-line /* alone (URLs and globs inside prompt strings)", () => {
    expect(scanPlannedPhases('phase("a"); // phase("trailing-kept")')).toEqual(["a", "trailing-kept"]);
    expect(
      scanPlannedPhases('agent("see https://x.io and src/**/*.ts");\nphase("after-url");\nagent("more */");'),
    ).toEqual(["after-url"]);
  });

  it("unescapes simple escape sequences and drops blank labels", () => {
    expect(scanPlannedPhases('phase("a\\"b")')).toEqual(['a"b']);
    expect(scanPlannedPhases("phase('it\\'s')")).toEqual(["it's"]);
    expect(scanPlannedPhases('phase("tab\\there")')).toEqual(["tab\there"]);
    expect(scanPlannedPhases('phase("")')).toEqual([]);
    expect(scanPlannedPhases('phase("   ")')).toEqual([]);
  });

  it("caps the planned chain at MAX_PLANNED_PHASES distinct labels", () => {
    const script = Array.from({ length: MAX_PLANNED_PHASES + 3 }, (_, i) => `phase("p${i}");`).join("\n");
    const out = scanPlannedPhases(script);
    expect(out).toHaveLength(MAX_PLANNED_PHASES);
    expect(out[0]).toBe("p0");
    expect(out[out.length - 1]).toBe(`p${MAX_PLANNED_PHASES - 1}`);
  });

  it("returns [] for scripts with no phase calls", () => {
    expect(scanPlannedPhases("export const meta = {name:'x'}; return 1;")).toEqual([]);
    expect(scanPlannedPhases("")).toEqual([]);
    expect(scanPlannedPhases("const phases = 3;")).toEqual([]);
  });
});
