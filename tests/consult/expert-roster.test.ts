import { describe, expect, it } from "vitest";
import type { ConsultExpertRef, RunId } from "../../src/core/types.js";
import { EXPERT_TASK_SUMMARY_CHARS, summarizeExpertTask } from "../../src/consult/expert-index.js";
import { renderExpertRoster } from "../../src/consult/tool.js";

describe("summarizeExpertTask", () => {
  it("collapses whitespace and keeps short tasks verbatim", () => {
    expect(summarizeExpertTask("  Find the\n\n  quota   refresh path ")).toBe("Find the quota refresh path");
  });

  it("truncates to the code-point limit with an ellipsis (CJK counted per character)", () => {
    const long = "阅读".repeat(200);
    const out = summarizeExpertTask(long)!;
    expect([...out].length).toBe(EXPERT_TASK_SUMMARY_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns undefined for blank or non-string input", () => {
    expect(summarizeExpertTask("   \n ")).toBeUndefined();
    expect(summarizeExpertTask(undefined)).toBeUndefined();
    expect(summarizeExpertTask(42)).toBeUndefined();
  });
});

describe("renderExpertRoster", () => {
  const base: ConsultExpertRef = {
    runId: "r_EQEVN83D" as RunId,
    label: "quota-expert",
    sessionFile: "/s/a.jsonl",
    agentType: "Explore",
    model: { provider: "zai", id: "glm-5.3" },
    task: 'Read service.ts "carefully"',
  };

  it("lists label, run id, type, model, state and the quoted task", () => {
    expect(renderExpertRoster([base], 2)).toBe(
      "Experts you can consult (up to 2 at once):\n" +
        '- quota-expert (r_EQEVN83D) — Explore · zai/glm-5.3 · finished — task: "Read service.ts \\"carefully\\""',
    );
  });

  it("marks pending experts, omits missing fields, and falls back to the run id", () => {
    const bare: ConsultExpertRef = {
      runId: "r_BARE00001" as RunId,
      sessionFile: "/s/b.jsonl",
      agentType: "",
      pending: true,
    };
    expect(renderExpertRoster([bare], 0)).toBe(
      "Experts you can consult:\n- r_BARE00001 — agent · still running when you were dispatched; consult nacks until it finishes",
    );
  });
});
