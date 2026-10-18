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

describe("consult prompt follow-up line (cache-thread plan §4.5)", () => {
  const FOLLOW =
    "This is follow-up #3 in this consult thread; your earlier answers above are complete even if the asker saw them truncated.";
  const base = { question: "next?", maxAnswerChars: 500, budgetNote: false, ...consultPromptLists(snapshot(["read"])) };

  it("inserts exactly one line after the R2 header and before `\\nQuestion:\\n`; without followUp the bytes are unchanged", () => {
    const plain = buildConsultPrompt(base);
    const withFollow = buildConsultPrompt({ ...base, followUp: 3 });
    expect(withFollow).toBe(plain.replace("\n\nQuestion:\n", `\n${FOLLOW}\n\nQuestion:\n`));
    expect(withFollow.startsWith("READ-ONLY CONSULT MODE\n")).toBe(true);
    expect(withFollow.indexOf(FOLLOW)).toBeLessThan(withFollow.indexOf("\nQuestion:\n"));
    expect(withFollow.slice(withFollow.indexOf("\nQuestion:\n") + "\nQuestion:\n".length)).toBe("next?");
  });

  it("followUp < 2 or absent adds nothing; the budget note still comes last", () => {
    expect(buildConsultPrompt({ ...base, followUp: 1 })).toBe(buildConsultPrompt(base));
    const withBudget = buildConsultPrompt({ ...base, budgetNote: true, followUp: 2 });
    expect(withBudget.endsWith("do not call tools.")).toBe(true);
    expect(withBudget).toContain("This is follow-up #2");
  });

  it("d2's transcript parser still extracts exactly the question from a follow-up prompt", async () => {
    const { consultTranscript } = await import("../../src/web-hub/agent/consult-transcript.js");
    const prompt = buildConsultPrompt({ ...base, followUp: 2 });
    const entries = consultTranscript({ consultOf: {}, taskPrompt: prompt, text: "the answer" } as never);
    const first = entries?.[0] as { message: { content: string } };
    expect(first.message.content).toBe("next?");
  });
});
