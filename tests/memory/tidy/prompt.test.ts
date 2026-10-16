// D04/tidy coupling (2026-10-16): `buildTidyPrompt` gains `topicWarnBytes` +
// `oversized` (doctor D04's findings) — absent (or nothing flagged) ⇒ the
// prompt bytes stay EXACTLY the legacy ones; present ⇒ the split rule and the
// by-name flagged list appear. Pure-function tests, no fs.

import { describe, expect, it } from "vitest";
import { buildTidyPrompt, type TidyPromptFile } from "../../../src/memory/tidy/prompt.js";

const files: TidyPromptFile[] = [
  { name: "core.md", body: "# Core\n", isPrimaryCore: true, handWritten: false },
  { name: "pitfalls.md", body: "# Pitfalls\n", isPrimaryCore: false, handWritten: false },
];

const base = { cwd: "/fixture/repo", files, migrationMode: false, coreBytes: 1600, topicMaxBytes: 16384 };

describe("buildTidyPrompt — D04 warn-threshold awareness", () => {
  it("absent inputs ⇒ legacy prompt bytes (no split rule, no threshold mention)", () => {
    const prompt = buildTidyPrompt(base);
    expect(prompt).not.toContain("doctor D04");
    expect(prompt).not.toContain("8192");
    expect(prompt).toContain("Any other file's final content must be ≤ 16384 bytes");
  });

  it("topicWarnBytes present but nothing flagged ⇒ still byte-identical to the legacy prompt", () => {
    expect(buildTidyPrompt({ ...base, topicWarnBytes: 8192, oversized: [] })).toBe(buildTidyPrompt(base));
    // undefined oversized degrades the same way
    expect(buildTidyPrompt({ ...base, topicWarnBytes: 8192 })).toBe(buildTidyPrompt(base));
  });

  it("flagged file ⇒ split rule names the threshold, the required actions, and the file", () => {
    const prompt = buildTidyPrompt({
      ...base,
      topicWarnBytes: 8192,
      oversized: [{ name: "pitfalls.md", bytes: 16200 }],
    });
    expect(prompt).toContain("8192-byte warn threshold (doctor D04)");
    expect(prompt).toContain('"create"');
    expect(prompt).toContain('"rewrite" or "delete"');
    expect(prompt).toContain("description/read_when");
    expect(prompt).toContain("Content conservation");
    expect(prompt).toContain("Over the warn threshold now: pitfalls.md (16200B)");
  });

  it("only the caller-supplied names appear in the flagged list (callers filter the primary core out)", () => {
    const prompt = buildTidyPrompt({
      ...base,
      topicWarnBytes: 8192,
      oversized: [{ name: "other.md", bytes: 9000 }],
    });
    expect(prompt).toContain("Over the warn threshold now: other.md (9000B)");
    expect(prompt).not.toContain("threshold now: core.md");
    expect(prompt).not.toContain("threshold now: pitfalls.md");
  });
});
