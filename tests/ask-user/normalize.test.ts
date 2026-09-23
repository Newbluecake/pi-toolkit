import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { HEADER_MAX_CHARS, type InputQuestion } from "../../src/ask-user/types.js";
import { normalizeQuestions } from "../../src/ask-user/normalize.js";
import { validateInput } from "../../src/ask-user/validate.js";

const q = (overrides: Partial<InputQuestion> = {}): InputQuestion => ({
  question: "Which DB?",
  options: [{ label: "A" }, { label: "B" }],
  ...overrides,
});

describe("normalizeQuestions", () => {
  it("keeps a single question's header undefined (RPC answer keys stay question-keyed)", () => {
    const { questions, derivedHeaders } = normalizeQuestions([q()]);
    expect(questions[0]?.header).toBeUndefined();
    expect(derivedHeaders).toBe(0);
  });

  it("never derives a header in single-question mode (RPC answer key stays the question text)", () => {
    const long = "x".repeat(HEADER_MAX_CHARS + 8);
    const { questions } = normalizeQuestions([q({ header: long })]);
    // The explicit header is still width-capped (see the dedicated test below),
    // but no header is ever invented for a single question.
    expect(questions[0]?.header).not.toBeUndefined();
    expect(normalizeQuestions([q()]).questions[0]?.header).toBeUndefined();
  });

  it("derives non-empty headers for multi-question calls that omit them", () => {
    const { questions, derivedHeaders } = normalizeQuestions([
      q({ question: "Which DB?" }),
      q({ question: "Which region?" }),
    ]);
    expect(questions[0]?.header).toBe("Which DB");
    expect(questions[1]?.header).toBe("Which region");
    expect(derivedHeaders).toBe(2);
  });

  it("truncates Chinese headers by display width, not character count", () => {
    const { questions } = normalizeQuestions([
      q({ question: "这是一个超级长的中文问题要怎么处理才好呢？" }),
      q({ header: "区域", question: "Which region?" }),
    ]);
    const header = questions[0]?.header;
    expect(header).toBe("这是一个..."); // 4 CJK chars (width 8) + "..." = width 11, not 12 chars
    expect(visibleWidth(header ?? "")).toBeLessThanOrEqual(HEADER_MAX_CHARS);
  });

  it("suffixes the second of two colliding derived headers and respects the width cap", () => {
    const { questions } = normalizeQuestions([
      q({ question: "Which DB do you want for the project?" }),
      q({ question: "Which DB do you need for the service?" }),
    ]);
    expect(questions[0]?.header).toBe("Which DB ...");
    expect(questions[1]?.header).toBe("Which DB...2");
    for (const question of questions) {
      expect(visibleWidth(question.header ?? "")).toBeLessThanOrEqual(HEADER_MAX_CHARS);
    }
    expect(validateInput(questions)).toBeNull();
  });

  it("preserves two identical explicit headers so validateInput still rejects them", () => {
    const { questions, derivedHeaders } = normalizeQuestions([
      q({ header: "Same", question: "Q one?" }),
      q({ header: "Same", question: "Q two?" }),
    ]);
    expect(questions.map((question) => question.header)).toEqual(["Same", "Same"]);
    expect(derivedHeaders).toBe(0);
    expect(validateInput(questions)).toContain("Duplicate header");
  });

  it("keeps a pristine explicit header and retro-bumps the derived one on collision", () => {
    const { questions } = normalizeQuestions([q({ question: "DB?" }), q({ header: "DB", question: "Which region?" })]);
    expect(questions.map((question) => question.header)).toEqual(["DB2", "DB"]);
    expect(validateInput(questions)).toBeNull();
  });

  it("truncates an over-long explicit header", () => {
    const { questions, derivedHeaders } = normalizeQuestions([
      q({ header: "abcdefghijkmnopqrst", question: "Q one?" }),
      q({ question: "Q two?" }),
    ]);
    expect(questions[0]?.header).toBe("abcdefghi...");
    expect(derivedHeaders).toBe(1); // truncation alone does not count as derived
  });

  it("collapses newlines, tabs, and control characters in question text to single spaces", () => {
    const single = normalizeQuestions([q({ question: "line1\nline2\tend  tail\u0007" })]);
    expect(single.questions[0]?.question).toBe("line1 line2 end tail");

    const multi = normalizeQuestions([q({ question: "Which\nDB?" }), q({ header: "X", question: "Q?" })]);
    expect(multi.questions[0]?.question).toBe("Which DB?");
    expect(multi.questions[0]?.header).toBe("Which DB"); // derived from the collapsed text
  });

  it("treats a whitespace-only header as missing and falls back to Q<n> for empty questions", () => {
    const { questions, derivedHeaders } = normalizeQuestions([
      q({ header: "   ", question: "   " }),
      q({ question: "Real?" }),
    ]);
    expect(questions[0]?.header).toBe("Q1");
    expect(questions[1]?.header).toBe("Real");
    expect(derivedHeaders).toBe(2);
  });

  it("width-caps an explicit header even in single-question mode (no silently over-long header)", () => {
    const { questions, derivedHeaders } = normalizeQuestions([q({ header: "X".repeat(40), question: "Q?" })]);
    const header = questions[0]?.header ?? "";
    expect(visibleWidth(header)).toBeLessThanOrEqual(HEADER_MAX_CHARS);
    expect(header).not.toMatch(/\u001b/);
    expect(derivedHeaders).toBe(0);
  });

  it("drops a blank single-question header so the RPC answer key stays the question text", () => {
    // `header: ""` is not nullish, so leaving it in place would key the RPC
    // answer on the empty string (channel-handler.ts `header ?? question`).
    const { questions } = normalizeQuestions([q({ header: "   ", question: "Only?" })]);
    expect(questions[0]).not.toHaveProperty("header");
  });

  it("resolves a retro-bumped header that collides with a later explicit header (3-way chain)", () => {
    const { questions } = normalizeQuestions([
      q({ question: "DB: postgres or sqlite?" }),
      q({ header: "DB", question: "Which region?" }),
      q({ header: "DB2", question: "Which cache?" }),
    ]);
    const headers = questions.map((question) => question.header);
    // Both model-written headers survive verbatim; only our derived one moves.
    expect(headers[1]).toBe("DB");
    expect(headers[2]).toBe("DB2");
    expect(new Set(headers).size).toBe(headers.length);
    expect(validateInput(questions)).toBeNull();
  });

  it("converges when a retro-bump has to move twice (4-way chain)", () => {
    const { questions } = normalizeQuestions([
      q({ question: "X: first?" }),
      q({ header: "X", question: "Second?" }),
      q({ header: "X2", question: "Third?" }),
      q({ header: "X3", question: "Fourth?" }),
    ]);
    const headers = questions.map((question) => question.header);
    expect(headers.slice(1)).toEqual(["X", "X2", "X3"]);
    expect(new Set(headers).size).toBe(4);
    expect(headers[0]).not.toMatch(/\u001b/);
    expect(validateInput(questions)).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = [q({ question: "a\nb" }), q({ question: "c?" })];
    const snapshot = JSON.stringify(input);
    normalizeQuestions(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("passes string options through untouched for validateInput to correct", () => {
    const { questions } = normalizeQuestions([q({ options: ["A", "B"] })]);
    expect(questions[0]?.options).toEqual(["A", "B"]);
    expect(validateInput(questions)).toContain("not strings");
  });
});
