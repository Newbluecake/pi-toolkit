import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { InputSchema, ResultSchema } from "../../src/ask-user/types.js";

const validInput = {
  questions: [
    {
      question: "Which option?",
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

describe("ask_user schema compatibility", () => {
  it("accepts the documented input shape and preserves cardinality keywords", () => {
    expect(Value.Check(InputSchema, validInput)).toBe(true);
    // questions is optional at the schema level since r4 (dismissParked); the 1-4 cardinality
    // for actual asks is enforced in execute() with a model-actionable error.
    expect(InputSchema.properties.questions.maxItems).toBe(4);
    expect(InputSchema.properties.questions.items.properties.options.minItems).toBe(2);
    expect(InputSchema.properties.questions.items.properties.options.maxItems).toBe(4);
  });

  it("r4: dismissParked is accepted alone and questions may be omitted", () => {
    expect(Value.Check(InputSchema, { dismissParked: true })).toBe(true);
    expect(Value.Check(InputSchema, {})).toBe(true); // schema-valid; execute() rejects without dismissParked
    expect(Value.Check(InputSchema, { ...validInput, dismissParked: true })).toBe(true); // schema-valid; execute() rejects the combo
    expect(Value.Check(InputSchema, { dismissParked: "yes" })).toBe(false);
  });

  it("rejects too few options", () => {
    expect(
      Value.Check(InputSchema, {
        questions: [{ question: "Which option?", options: [{ label: "A" }] }],
      }),
    ).toBe(false);
  });

  it("accepts a valid result schema and rejects invalid cancellation values", () => {
    expect(
      Value.Check(ResultSchema, {
        questions: validInput.questions,
        answers: {},
        cancelled: false,
      }),
    ).toBe(true);
    expect(
      Value.Check(ResultSchema, {
        questions: validInput.questions,
        answers: {},
        cancelled: "no",
      }),
    ).toBe(false);
  });

  it("accepts skipped answers in the result schema (and rejects a non-boolean skipped)", () => {
    const base = { questions: validInput.questions, cancelled: false };
    expect(
      Value.Check(ResultSchema, {
        ...base,
        answers: { "Which option?": { selected: [], other: null, skipped: true } },
      }),
    ).toBe(true);
    expect(
      Value.Check(ResultSchema, {
        ...base,
        answers: { "Which option?": { selected: [], other: null, skipped: "yes" } },
      }),
    ).toBe(false);
  });
});
