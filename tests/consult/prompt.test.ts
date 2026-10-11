import { describe, expect, it } from "vitest";
import { buildConsultPrompt, consultPromptLists } from "../../src/consult/prompt.js";
import type { ExpertRequestSnapshot } from "../../src/core/types.js";

const snapshot = (tools: string[]): ExpertRequestSnapshot => ({
  tools: tools.map((name) => ({ name, description: `${name} description`, parameters: { type: "object" } })),
  systemSections: {},
  sourceSessionId: "s_expert",
});

describe("consult prompt R2", () => {
  it("derives allowed tools from the snapshot and keeps disabled names in declaration order", () => {
    const lists = consultPromptLists(snapshot(["write", "read", "custom", "ls"]));
    expect(lists).toEqual({ allowed: ["read", "ls"], disabled: ["write", "custom"] });
    const prompt = buildConsultPrompt({
      question: "Which choice is correct?",
      maxAnswerChars: 1200,
      budgetNote: false,
      ...lists,
    });
    expect(prompt).toBe(
      [
        "READ-ONLY CONSULT MODE",
        "Allowed tools: read, ls",
        "Every other tool is disabled and any call to it will be refused: write, custom.",
        "Do not call disabled tools; each refused call wastes a turn. Answer from your existing context or use an allowed tool.",
        "Answer from your own context. Lead with the conclusion (<=3 lines), then expand only as needed.",
        "Hard limit: <= 1200 characters.",
        "",
        "Question:",
        "Which choice is correct?",
      ].join("\n"),
    );
  });

  it("uses the exact no-tool R2 wording", () => {
    const prompt = buildConsultPrompt({
      question: "q",
      maxAnswerChars: 100,
      budgetNote: true,
      allowed: [],
      disabled: [],
    });
    expect(prompt).toContain("Allowed tools: none — answer from your existing context only");
    expect(prompt).toContain("Every other tool is disabled and any call to it will be refused: none.");
    expect(prompt).toContain(
      "Budget note: you have roughly one turn — answer directly from your context, do not call tools.",
    );
  });

  it("keeps the reserved main prompt on the current read-only form", () => {
    const prompt = buildConsultPrompt({ question: "q", maxAnswerChars: 100, budgetNote: false, isMain: true });
    expect(prompt).toContain("ONLY have read-only tools: read, grep, find, ls");
    expect(prompt).not.toContain("READ-ONLY CONSULT MODE");
  });
});
