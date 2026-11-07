// `preserveInlineMeta` prompt rule tests (jev-plan §4 J8): added ONLY when
// `preserveInlineMeta` is true AND at least one target file's body carries
// `<!-- mem`; otherwise byte-identical (I9 / off golden's `tidyPrompt`).

import { describe, expect, it } from "vitest";
import { buildTidyPrompt, type TidyPromptFile } from "../../../src/memory/tidy/prompt.js";

const plainFiles: TidyPromptFile[] = [
  { name: "core.md", body: "# Core\n\n## Rules\n\n- rule one\n", isPrimaryCore: true, handWritten: false },
];

const inlineFiles: TidyPromptFile[] = [
  {
    name: "core.md",
    body: "# Core\n\n## Rules\n\n- rule one <!-- mem user -->\n",
    isPrimaryCore: true,
    handWritten: false,
  },
];

const base = { cwd: "/fixture/repo", files: plainFiles, migrationMode: false, coreBytes: 1600, topicMaxBytes: 16384 };

describe("buildTidyPrompt — preserveInlineMeta (jev-plan §4 J8)", () => {
  it("absent ⇒ byte-identical to no preserveInlineMeta field at all", () => {
    expect(buildTidyPrompt(base)).toBe(buildTidyPrompt({ ...base, preserveInlineMeta: undefined }));
  });

  it("true but no file carries <!-- mem ⇒ no rule added, byte-identical", () => {
    expect(buildTidyPrompt({ ...base, preserveInlineMeta: true })).toBe(buildTidyPrompt(base));
  });

  it("false, even with an inline comment present ⇒ no rule added", () => {
    const withInline = { ...base, files: inlineFiles, preserveInlineMeta: false };
    const without = { ...base, files: inlineFiles };
    expect(buildTidyPrompt(withInline)).toBe(buildTidyPrompt(without));
  });

  it("true AND a file carries <!-- mem ⇒ the preserve-inline-comment rule appears", () => {
    const prompt = buildTidyPrompt({ ...base, files: inlineFiles, preserveInlineMeta: true });
    expect(prompt).toContain("<!-- mem");
    expect(prompt).toContain("Preserve every");
  });

  it("the rule composes with the migration-mode and D04 split-rule blocks without clobbering them", () => {
    const prompt = buildTidyPrompt({
      ...base,
      files: inlineFiles,
      preserveInlineMeta: true,
      migrationMode: true,
      topicWarnBytes: 8192,
      oversized: [{ name: "core.md", bytes: 9000 }],
    });
    expect(prompt).toContain("Migration mode");
    expect(prompt).toContain("doctor D04");
    expect(prompt).toContain("Preserve every");
  });
});
