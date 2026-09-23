import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { InputSchema, type Question } from "../../src/ask-user/types.js";
import { validateInput } from "../../src/ask-user/validate.js";

const question = (overrides: Partial<Question> = {}): Question => ({
  question: "Q1",
  options: [{ label: "A" }, { label: "B" }],
  ...overrides,
});

describe("validateInput", () => {
  it("accepts valid single and multi-question inputs", () => {
    expect(validateInput([question()])).toBeNull();
    expect(
      validateInput([question({ question: "Q1", header: "First" }), question({ question: "Q2", header: "Second" })]),
    ).toBeNull();
  });

  it("runs question length before duplicate, option, and header checks", () => {
    const tooLong = "x".repeat(QUESTION_LIMIT + 1);
    const result = validateInput([
      { question: tooLong, header: "same header", options: ["A", "B"] },
      {
        question: tooLong,
        header: "same header",
        options: [{ label: "A" }, { label: "B" }],
      },
    ]);

    expect(result).toContain("Question text exceeds");
  });

  it("rejects duplicate questions", () => {
    expect(
      validateInput([question({ question: "Same", header: "A" }), question({ question: "Same", header: "B" })]),
    ).toContain("Duplicate question");
  });

  it("rejects string options with a correction example", () => {
    const result = validateInput([{ question: "Which DB?", options: ["Postgres", "SQLite"] }]);

    expect(result).toContain("objects, not strings");
    expect(result).toContain('Correct: "options":[{"label"');
    expect(Value.Check(InputSchema, { questions: [{ question: "Which DB?", options: ["A", "B"] }] })).toBe(true);
  });

  it.each(["Other", "other", " Other ", "oThEr"])("rejects an explicitly supplied %s option", (label) => {
    expect(validateInput([question({ options: [{ label }, { label: "A" }] })])).toContain(
      'Do not include an "Other" option',
    );
  });

  it("allows labels containing Other as a non-equal word", () => {
    expect(validateInput([question({ options: [{ label: "Other options" }, { label: "A" }] })])).toBeNull();
  });

  it("rejects empty and duplicate labels after the Other check", () => {
    expect(validateInput([question({ options: [{ label: "  " }, { label: "A" }] })])).toContain("must not be empty");
    expect(validateInput([question({ options: [{ label: "A" }, { label: "A" }] })])).toContain(
      "Duplicate option label",
    );
  });

  it("requires unique headers for multiple questions", () => {
    expect(
      validateInput([question({ question: "Q1", header: "Same" }), question({ question: "Q2", header: " Same " })]),
    ).toContain("Duplicate header");
  });
});

const QUESTION_LIMIT = 1000;
