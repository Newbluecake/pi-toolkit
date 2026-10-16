import { describe, expect, it } from "vitest";
import { parseChangelogSections } from "../../../src/web-hub/hub/changelog.js";

const LIM = { changelogSections: 5, sectionBytes: 8192 };

describe("parseChangelogSections (web-hub-version §3.2)", () => {
  it("splits on `## [` headings and parses `[x] - date`", () => {
    const text = `# Changelog\n\nintro\n\n## [0.5.5] - 2026-10-16\n\n### Features\n\n- a\n\n## [0.5.4] - 2026-10-10\n\n- b\n`;
    const out = parseChangelogSections(text, LIM);
    expect(out.map((s) => [s.title, s.date])).toEqual([
      ["0.5.5", "2026-10-16"],
      ["0.5.4", "2026-10-10"],
    ]);
    expect(out[0]!.markdown).toBe("### Features\n\n- a");
    expect(out[1]!.markdown).toBe("- b");
  });

  it("skips an EMPTY [Unreleased] but keeps a non-empty one", () => {
    expect(
      parseChangelogSections("## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n- x\n", LIM).map((s) => s.title),
    ).toEqual(["1.0.0"]);
    const kept = parseChangelogSections("## [Unreleased]\n- pending\n\n## [1.0.0] - 2026-01-01\n- x\n", LIM);
    expect(kept.map((s) => s.title)).toEqual(["Unreleased", "1.0.0"]);
  });

  it("strips reference-style link definitions (the generated footer)", () => {
    const out = parseChangelogSections(
      "## [1.0.0] - 2026-01-01\n- x\n\n[1.0.0]: https://example.test/compare/a...b\n[Unreleased]: https://example.test/x\n",
      LIM,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.markdown).toBe("- x");
  });

  it("handles a heading without date, a link heading, CRLF and empty input", () => {
    expect(parseChangelogSections("## [2.0.0]\r\n- y\r\n", LIM)).toEqual([{ title: "2.0.0", markdown: "- y" }]);
    expect(parseChangelogSections("## [2.0.0](https://x.test) - 2026-02-02\n- y\n", LIM)[0]).toMatchObject({
      title: "2.0.0",
      date: "2026-02-02",
    });
    expect(parseChangelogSections("", LIM)).toEqual([]);
    expect(parseChangelogSections("no headings here", LIM)).toEqual([]);
  });

  it("caps the section count", () => {
    const text = Array.from({ length: 9 }, (_, i) => `## [1.0.${i}] - 2026-01-0${i + 1}\n- n${i}\n`).join("\n");
    expect(parseChangelogSections(text, LIM)).toHaveLength(5);
  });

  it("clips a section to the byte budget on a line boundary and marks it truncated", () => {
    const body = Array.from({ length: 200 }, (_, i) => `- item ${i} ${"x".repeat(40)}`).join("\n");
    const [s] = parseChangelogSections(`## [1.0.0] - 2026-01-01\n${body}\n`, { ...LIM, sectionBytes: 500 });
    expect(s!.truncated).toBe(true);
    expect(Buffer.byteLength(s!.markdown)).toBeLessThanOrEqual(500);
    expect(s!.markdown.split("\n").every((l) => l.startsWith("- item"))).toBe(true);
  });

  it("clips one over-long line at a code point boundary", () => {
    const [s] = parseChangelogSections(`## [1.0.0]\n${"汉".repeat(1000)}\n`, { ...LIM, sectionBytes: 100 });
    expect(s!.truncated).toBe(true);
    expect(Buffer.byteLength(s!.markdown)).toBeLessThanOrEqual(100);
    expect(s!.markdown).not.toContain("\uFFFD");
  });
});
