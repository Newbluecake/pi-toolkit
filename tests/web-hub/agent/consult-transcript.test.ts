import { describe, expect, it } from "vitest";
import { consultTranscript } from "../../../src/web-hub/agent/consult-transcript.js";
import { buildConsultPrompt } from "../../../src/consult/prompt.js";
import { RUN_TX } from "../../../src/web-hub/protocol/run-transcript.js";

describe("consult transcript reconstruction", () => {
  it.each([false, true])(
    "extracts the question from generated prompts (preserve=%s), preserving full prompt",
    (preserve) => {
      const question = "What did we decide?\nQuestion:\nKeep this literal line.\n中文 <script>alert(1)</script>";
      const prompt = buildConsultPrompt({
        question,
        maxAnswerChars: 1000,
        budgetNote: true,
        ...(preserve ? { allowed: ["read"] } : { isMain: true }),
      });
      const entries = consultTranscript({
        consultOf: { askerRunId: "r_ABCDEFGH" },
        taskPrompt: prompt,
        text: "Final answer",
        textFinal: true,
      });
      expect(entries).toHaveLength(2);
      expect(entries?.[0]?.message).toEqual({
        role: "user",
        content: question,
        consultSummary: true,
        consultPrompt: prompt,
      });
      expect(entries?.[1]?.message).toEqual({ role: "assistant", content: "Final answer", consultSummary: true });
      expect(entries?.[1]?.parentId).toBe(entries?.[0]?.id);
    },
  );

  it("does not infer consult identity from prompt text and preserves unknown prompt formats", () => {
    const prompt = "Unrecognized preamble\nQuestion:\nquestion";
    expect(consultTranscript({ taskPrompt: prompt, text: "answer" })).toBeUndefined();
    expect(consultTranscript({ consultOf: {}, taskPrompt: prompt, text: "answer" })?.[0]?.message?.content).toBe(
      prompt,
    );
    expect(consultTranscript({ consultOf: {}, taskPrompt: "question" })).toBeUndefined();
    expect(consultTranscript(undefined)).toBeUndefined();
  });

  it("keeps empty answers and refuses oversized diagnostics instead of overflowing the frame", () => {
    expect(consultTranscript({ consultOf: {}, taskPrompt: "q", text: "" })?.[1]?.message?.content).toBe("");
    expect(consultTranscript({ consultOf: {}, taskPrompt: "q", text: "x".repeat(RUN_TX.maxBytes) })).toBeUndefined();
  });
});

describe("consult transcript cache mark (cache-thread plan §5.3 U)", () => {
  it("attaches the compact marker to the question entry as a custom message field", () => {
    const entries = consultTranscript({
      consultOf: { askerRunId: "r_ABCDEFGH" },
      taskPrompt: "question",
      text: "answer",
      consultCache: { v: 1, predicted: { state: "warm" } },
      consultThread: { threadId: "c7k9q2mx", seq: 2 },
    });
    expect(entries?.[0]?.message?.consultMark).toBe("t#2 warm·…");
    expect(entries?.[1]?.message?.consultMark).toBeUndefined(); // answer stays untouched
  });

  it("carries the measured result once the first response landed", () => {
    const entries = consultTranscript({
      consultOf: {},
      taskPrompt: "q",
      text: "a",
      consultCache: {
        v: 1,
        predicted: { state: "unknown" },
        first: { v: 1, readShare: 0.235, label: "partial", anchor: "added", at: 5 },
      },
    });
    expect(entries?.[0]?.message?.consultMark).toBe("?·partial 24%");
  });

  it("entries without cache facts stay byte-identical (no consultMark key)", () => {
    const entries = consultTranscript({ consultOf: {}, taskPrompt: "q", text: "a" });
    expect(entries?.[0]?.message).toEqual({ role: "user", content: "q", consultSummary: true, consultPrompt: "q" });
    expect("consultMark" in (entries?.[0]?.message ?? {})).toBe(false);
  });
});
