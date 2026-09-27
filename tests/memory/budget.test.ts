// optimize-plan §4.4 / §10 I9 (todo #22 P2): findExactDuplicates + the T3
// budget line, including a FAKE `renderBlock` port (§14.1: "P2 的块估算调用
// P1 的 renderTiered" — a real `renderTiered` doesn't exist yet, so the port
// injection mechanism itself is what this suite verifies).

import { describe, expect, test, vi } from "vitest";
import { computeBudgetReport, findExactDuplicates } from "../../src/memory/budget.js";
import type { TieredRenderInput, TieredRenderResult } from "../../src/memory/contracts.js";

describe("findExactDuplicates", () => {
  test("no corpus ⇒ no hits", () => {
    expect(findExactDuplicates(["this line is definitely long enough"], [])).toEqual([]);
  });

  test("lines under 16 code points are never compared", () => {
    const hits = findExactDuplicates(["short"], [{ file: "a.md", lines: ["short"] }]);
    expect(hits).toEqual([]);
  });

  test("exact duplicate (after trim/whitespace-collapse/list-marker-strip/ASCII-lowercase) is reported", () => {
    const corpus = [{ file: "pitfalls.md", lines: ["- Some Long Enough Sentence Here"] }];
    const hits = findExactDuplicates(["  some   long enough sentence here  "], corpus);
    expect(hits).toEqual([{ line: "  some   long enough sentence here  ", alsoAt: "pitfalls.md:1" }]);
  });

  test("list-marker variants (-, *, N.) are treated as equivalent", () => {
    const corpus = [{ file: "a.md", lines: ["- this is a long enough line here"] }];
    expect(findExactDuplicates(["1. this is a long enough line here"], corpus)).toHaveLength(1);
    expect(findExactDuplicates(["* this is a long enough line here"], corpus)).toHaveLength(1);
  });

  test("distinct lines are not reported", () => {
    const corpus = [{ file: "a.md", lines: ["this is one long enough sentence"] }];
    expect(findExactDuplicates(["this is a totally different long sentence"], corpus)).toEqual([]);
  });

  test("capped at 3 hits", () => {
    const corpus = Array.from({ length: 5 }, (_, i) => ({
      file: `f${i}.md`,
      lines: [`duplicate line number ${i} here`],
    }));
    const newLines = corpus.map((c) => c.lines[0]!);
    expect(findExactDuplicates(newLines, corpus)).toHaveLength(3);
  });

  test("self-file duplication: corpus may include the SAME file's other lines", () => {
    const corpus = [{ file: "a.md", lines: ["an existing long enough line here", "another line"] }];
    const hits = findExactDuplicates(["an existing long enough line here"], corpus);
    expect(hits).toEqual([{ line: "an existing long enough line here", alsoAt: "a.md:1" }]);
  });
});

describe("computeBudgetReport", () => {
  const limits = { coreBytes: 1600, topicWarnBytes: 8192, topicMaxBytes: 16384 };

  test("layout=legacy equivalent: no renderBlock port ⇒ block segment omitted", () => {
    const report = computeBudgetReport({ file: { name: "quota.md", bytes: 2000, isCore: false }, limits });
    expect(report.line).toBe("budget: quota.md 2.0k/8k (hard 16k)");
    expect(report.line).not.toContain("block");
  });

  test("topic file under warn threshold: no warning", () => {
    const report = computeBudgetReport({ file: { name: "quota.md", bytes: 2000, isCore: false }, limits });
    expect(report.warnings).toEqual([]);
  });

  test("topic file over warn threshold: a warning is added", () => {
    const report = computeBudgetReport({ file: { name: "quota.md", bytes: 9000, isCore: false }, limits });
    expect(report.warnings.some((w) => w.includes("warn threshold"))).toBe(true);
  });

  test("core file uses coreBytes, not topicWarn/topicMax, and no separate 'core' segment", () => {
    const report = computeBudgetReport({ file: { name: "pitfalls.md", bytes: 1100, isCore: true }, limits });
    expect(report.line).toContain("(core)");
    expect(report.line).not.toMatch(/· core /);
  });

  test("topic file: coreFileBytes supplied ⇒ a separate 'core' segment is appended", () => {
    const report = computeBudgetReport({
      file: { name: "quota.md", bytes: 2000, isCore: false },
      coreFileBytes: 1100,
      limits,
    });
    expect(report.line).toMatch(/· core 1\.1k\/1\.6k/);
  });

  test("renderBlock port is called with the given input and its result formats the block segment", () => {
    const input: TieredRenderInput = {
      cwd: "/proj",
      profile: "full",
      access: "memory",
      coreBytes: 1600,
      blockBytes: 2400,
      indexMax: 15,
    };
    const result: TieredRenderResult = {
      text: "…",
      bytes: 2252,
      level: 2,
      omittedSections: [],
      demotedPinned: [],
      fullIndexLines: 3,
      tailKind: "compact",
    };
    const fn = vi.fn(() => result);
    const report = computeBudgetReport({
      file: { name: "quota.md", bytes: 2000, isCore: false },
      limits,
      renderBlock: { fn, input },
    });
    expect(fn).toHaveBeenCalledWith(input);
    expect(report.line).toMatch(/block 2\.2k\/2\.3k \(L2\)/);
  });

  test("duplicates fold into both `duplicates` and a warning per hit", () => {
    const report = computeBudgetReport({
      file: { name: "quota.md", bytes: 2000, isCore: false },
      limits,
      duplicates: [{ line: "some long enough duplicated sentence", alsoAt: "pitfalls.md:12" }],
    });
    expect(report.duplicates).toHaveLength(1);
    expect(report.warnings.some((w) => w.includes("pitfalls.md:12"))).toBe(true);
  });
});
