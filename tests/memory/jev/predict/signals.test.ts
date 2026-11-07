// signals.ts unit tests (plan.md v3.2 section 2.1 limits).

import { describe, expect, it } from "vitest";
import {
  buildPredictInput,
  capBashJobs,
  capRecentTools,
  capTodo,
  classifyPathClass,
  clampSubagents,
  stripSkillBlocks,
  truncateCodepoints,
} from "../../../../src/memory/jev/predict/signals.js";

describe("truncateCodepoints", () => {
  it("does not split a surrogate pair", () => {
    const emoji = "\u{1F600}"; // 1 codepoint, 2 UTF-16 units
    const text = `a${emoji}b`;
    expect(truncateCodepoints(text, 2)).toBe(`a${emoji}`);
  });

  it("leaves short text untouched", () => {
    expect(truncateCodepoints("abc", 10)).toBe("abc");
  });
});

describe("stripSkillBlocks", () => {
  it("removes a skill expansion block", () => {
    const text = '前缀<skill name="x" location="y">body</skill>后缀';
    expect(stripSkillBlocks(text)).toBe("前缀后缀");
  });
});

describe("clampSubagents", () => {
  it.each([
    [-5, 0],
    [0, 0],
    [42, 42],
    [99, 99],
    [150, 99],
    [Number.NaN, 0],
    [3.7, 3],
  ])("clampSubagents(%d) === %d", (input, expected) => {
    expect(clampSubagents(input)).toBe(expected);
  });
});

describe("classifyPathClass", () => {
  it.each([
    ["src/memory/jev/wire.ts", "src"],
    ["tests/memory/jev/wire.test.ts", "tests"],
    ["tests/fixtures/golden.json", "fixtures"],
    ["src/__fixtures__/x.ts", "fixtures"],
    ["docs/dev/memory-predict/plan.md", "docs"],
    [".env", "credentials"],
    [".env.local", "credentials"],
    ["auth.json", "credentials"],
    ["id_rsa.pem", "credentials"],
    ["package.json", "pkg"],
    ["pnpm-lock.yaml", "pkg"],
    ["tsconfig.build.json", "pkg"],
    ["settings.json", "config"],
    ["config/foo.yaml", "config"],
    ["README.md", "docs"],
    ["scripts/release/release.sh", "other"],
  ])("%s -> %s", (path, expected) => {
    expect(classifyPathClass(path)).toBe(expected);
  });

  it("classifies tests/fixtures/* as fixtures, not tests (order-sensitive)", () => {
    expect(classifyPathClass("tests/fixtures/memory-tool-surface.json")).toBe("fixtures");
  });
});

describe("capTodo", () => {
  it("prioritizes in_progress over pending and caps at 12", () => {
    const todo = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: i, subject: `pending ${i}`, status: "pending" as const })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: 100 + i,
        subject: `active ${i}`,
        status: "in_progress" as const,
      })),
    ];
    const capped = capTodo(todo);
    expect(capped).toHaveLength(12);
    expect(capped.slice(0, 5).every((t) => t.status === "in_progress")).toBe(true);
  });

  it("drops completed todos", () => {
    const todo = [{ id: 1, subject: "done", status: "completed" }];
    expect(capTodo(todo)).toEqual([]);
  });

  it("truncates subject to 200 codepoints", () => {
    const todo = [{ id: 1, subject: "x".repeat(300), status: "in_progress" as const }];
    expect(capTodo(todo)[0]?.subject.length).toBe(200);
  });
});

describe("capRecentTools", () => {
  it("keeps only the most recent 20, in order", () => {
    const tools = Array.from({ length: 25 }, (_, i) => ({ tool: `t${i}` }));
    const capped = capRecentTools(tools);
    expect(capped).toHaveLength(20);
    expect(capped[0]?.tool).toBe("t5");
    expect(capped[19]?.tool).toBe("t24");
  });

  it("leaves a short list untouched", () => {
    const tools = [{ tool: "bash" }];
    expect(capRecentTools(tools)).toEqual(tools);
  });
});

describe("capBashJobs", () => {
  it("caps at 10 and truncates command to 500 codepoints", () => {
    const jobs = Array.from({ length: 15 }, (_, i) => ({ status: "running" as const, command: `cmd ${i}` }));
    expect(capBashJobs(jobs)).toHaveLength(10);
    const long = capBashJobs([{ status: "running", command: "x".repeat(600) }]);
    expect(long[0]?.command.length).toBe(500);
  });

  it("normalizes unknown statuses to 'other'", () => {
    expect(capBashJobs([{ status: "zombie", command: "x" }])[0]?.status).toBe("other");
  });
});

describe("buildPredictInput", () => {
  it("assembles and limits every field from raw input", () => {
    const input = buildPredictInput({
      prompt: '<skill name="a" location="b">junk</skill>提交一下',
      todo: [{ id: 1, subject: "fix", status: "in_progress" }],
      recentTools: [{ tool: "bash" }],
      bashJobs: [{ status: "running", command: "npm test" }],
      activeSubagents: 200,
      session: "main",
    });
    expect(input.prompt).toBe("提交一下");
    expect(input.activeSubagents).toBe(99);
    expect(input.todo).toHaveLength(1);
    expect(input.session).toBe("main");
    expect(input.previousPrompt).toBeUndefined();
    expect(input.git).toBeUndefined();
  });

  it("truncates prompt to 4000 codepoints and previousPrompt to 1000", () => {
    const input = buildPredictInput({
      prompt: "a".repeat(5000),
      previousPrompt: "b".repeat(2000),
      todo: [],
      recentTools: [],
      bashJobs: [],
      activeSubagents: 0,
      session: "main",
    });
    expect(input.prompt.length).toBe(4000);
    expect(input.previousPrompt?.length).toBe(1000);
  });
});
