import { describe, expect, it } from "vitest";
import { formatExitFacts, truncateResultText } from "../../src/tools/result-text.js";
import type { RunExitFacts } from "../../src/core/types.js";

describe("truncateResultText", () => {
  it("keeps head and tail, eliding the middle, and adds a transcript guide", () => {
    expect(truncateResultText("abcdefghij", 10)).toEqual({ text: "abcdefghij", truncated: false, totalChars: 10 });
    // maxChars 4 → head 70% = 2, tail 2; middle 6 elided.
    const result = truncateResultText("abcdefghij", 4, "/tmp/session.jsonl");
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(10);
    expect(result.text).toBe(
      "ab\n\n… [middle 6 of 10 chars omitted — showing first 2 + last 2]" +
        "; full session transcript: /tmp/session.jsonl — use the read tool to inspect it\n\nij",
    );
    expect(truncateResultText("abcdef", 0).text).toBe("abcdef");
    expect(truncateResultText("abcdef", -1).text).toBe("abcdef");
  });

  it("backs up the head cut when it would split a surrogate pair", () => {
    // "ab😀cd" = 6 UTF-16 units; maxChars 3 → head floor(2.1)=2 ("ab"), tail 1 ("d").
    const result = truncateResultText("ab😀cd", 3);
    expect(result.totalChars).toBe(6);
    expect(result.text.startsWith("ab")).toBe(true);
    expect(result.text.endsWith("d")).toBe(true);
    expect(result.text).not.toContain("\ud83d");
    expect(result.text).toContain("middle 3 of 6 chars omitted — showing first 2 + last 1");
  });

  it("advances the tail cut when it would split a surrogate pair", () => {
    // 70 x's + "😀" + 28 y's = 100 units; maxChars 96 → head 67, tail budget 29
    // → tailStart lands on the emoji's low surrogate and must advance past it.
    const text = "x".repeat(70) + "😀" + "y".repeat(28);
    const result = truncateResultText(text, 96);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("middle 5 of 100 chars omitted — showing first 67 + last 28");
    expect(result.text.startsWith("x".repeat(67))).toBe(true);
    expect(result.text.endsWith("y".repeat(28))).toBe(true);
    expect(result.text).not.toContain("😀");
    expect(result.text).not.toContain("\ude00");
  });
});

/**
 * bash-timeout-grace plan §3.7 (P0b, frozen): formatExitFacts renders
 * RunOutcome.diag.exitFacts into the trailing lines a later package's
 * `formatOutcome`/completion notice appends. Pure text formatting only.
 */
describe("formatExitFacts (bash-timeout-grace plan \u00a73.7)", () => {
  it("undefined facts ⇒ undefined (nothing to append)", () => {
    expect(formatExitFacts(undefined)).toBeUndefined();
  });

  it("empty bashJobs and no hold info ⇒ undefined", () => {
    expect(formatExitFacts({ bashJobs: [] })).toBeUndefined();
  });

  it("renders the plan's own worked example verbatim", () => {
    const facts: RunExitFacts = {
      bashJobs: [
        {
          jobId: "j_7K2",
          commandPreview: "go test ./...",
          state: "terminating",
          exitCode: null,
          logPath: "/tmp/j_7K2.log",
          durationMs: 723_000, // 12m03s
          seen: false,
        },
        {
          jobId: "j_9Z1",
          commandPreview: "make lint",
          state: "completed",
          exitCode: 0,
          logPath: "/tmp/j_9Z1.log",
          durationMs: 4_000,
          seen: false,
        },
      ],
    };
    expect(formatExitFacts(facts)).toBe(
      "Background bash jobs at exit: " +
        "j_7K2 `go test ./...` terminating (ran 12m03s) \u00b7 log /tmp/j_7K2.log; " +
        "j_9Z1 `make lint` completed exit 0 (not seen by the subagent) \u00b7 log /tmp/j_9Z1.log",
    );
  });

  it("a seen job never gets the (not seen by the subagent) marker", () => {
    const facts: RunExitFacts = {
      bashJobs: [
        {
          jobId: "j_1",
          commandPreview: "echo hi",
          state: "failed",
          exitCode: 1,
          logPath: "/l",
          durationMs: 1,
          seen: true,
        },
      ],
    };
    expect(formatExitFacts(facts)).toBe("Background bash jobs at exit: j_1 `echo hi` failed exit 1 \u00b7 log /l");
  });

  it("a null exitCode on a terminal state omits the exit-code suffix (killed by signal / never spawned)", () => {
    const facts: RunExitFacts = {
      bashJobs: [
        {
          jobId: "j_k",
          commandPreview: "sleep 99",
          state: "killed",
          exitCode: null,
          logPath: "/l",
          durationMs: 1,
          seen: false,
        },
      ],
    };
    expect(formatExitFacts(facts)).toBe(
      "Background bash jobs at exit: j_k `sleep 99` killed (not seen by the subagent) \u00b7 log /l",
    );
  });

  it("appends the (+N more) suffix when bashJobsMore is set, even with an empty bashJobs array", () => {
    expect(formatExitFacts({ bashJobs: [], bashJobsMore: 3 })).toBe("Background bash jobs at exit:  (+3 more)");
    const facts: RunExitFacts = {
      bashJobs: [
        {
          jobId: "j_1",
          commandPreview: "x",
          state: "completed",
          exitCode: 0,
          logPath: "/l",
          durationMs: 1,
          seen: true,
        },
      ],
      bashJobsMore: 2,
    };
    expect(formatExitFacts(facts)).toBe(
      "Background bash jobs at exit: j_1 `x` completed exit 0 \u00b7 log /l (+2 more)",
    );
  });

  it("appends the settle-hold-exhausted line only when hold.exhausted is true", () => {
    const base: RunExitFacts = { bashJobs: [] };
    expect(formatExitFacts({ ...base, hold: { rounds: 10, cap: 40, exhausted: false } })).toBeUndefined();
    expect(formatExitFacts({ ...base, hold: { rounds: 40, cap: 40, exhausted: true } })).toBe(
      "Settle hold budget exhausted (40/40 reminders); the run was released with jobs still running.",
    );
  });

  it("combines the job line and the hold-exhausted line on two lines", () => {
    const facts: RunExitFacts = {
      bashJobs: [
        {
          jobId: "j_1",
          commandPreview: "sleep 999",
          state: "terminating",
          exitCode: null,
          logPath: "/l",
          durationMs: 1_000,
          seen: false,
        },
      ],
      hold: { rounds: 40, cap: 40, exhausted: true },
    };
    const text = formatExitFacts(facts)!;
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Background bash jobs at exit:");
    expect(lines[1]).toBe(
      "Settle hold budget exhausted (40/40 reminders); the run was released with jobs still running.",
    );
  });
});
