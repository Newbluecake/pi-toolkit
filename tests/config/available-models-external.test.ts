// external-agent plan §6.2 P4a：`formatAvailableModelsForPrompt(models, external?)`
// 与 `formatExternalModelsForPrompt(ext)`（§5.3 冻结面）。
//
// 验收①：`(m)`、`(m, undefined)`、`(m, [])` 与改动前逐字节一致 —— golden
// （tests/fixtures/available-models-golden.txt）是在本次改动【之前】用当时的实现
// 生成的（scripts 见 PR 描述），此处三路对比锁定。验收②：external 子块文案
// （含 resume 钉目录一句）、`… +N more`、pi 为空时仍输出。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatAvailableModelsForPrompt,
  formatExternalModelsForPrompt,
  type AvailableModelEntry,
  type ExternalPromptModels,
} from "../../src/config/available-models.js";
import { externalModelsPromptHeader } from "../../src/external-agent/messages.js";

// 与 golden 生成时完全相同的确定性 fixture（>30 条 unique 以触发
// "- ... and N more" 截断行；含 name 有无 / 注解组合 / 1M ctx / 去重）。
function goldenModels(): AvailableModelEntry[] {
  return [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", reasoning: true, contextWindow: 200_000 },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
    { provider: "openai", id: "gpt-5.2", contextWindow: 1_000_000 },
    { provider: "kimi", id: "kimi-k2.5" },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
    { provider: "moonshot", id: "kimi-k2.5-turbo", contextWindow: 128_000 },
    ...Array.from({ length: 26 }, (_, i) => ({
      provider: `prov${i}`,
      id: `model-${i}`,
      name: `Filler ${i}`,
    })),
  ];
}

const golden = readFileSync(join(__dirname, "..", "fixtures", "available-models-golden.txt"), "utf8");

function ext(provider: string, models: ExternalPromptModels["models"], total = models.length): ExternalPromptModels {
  return { provider, models, total };
}

describe("formatAvailableModelsForPrompt golden (P4a 验收①)", () => {
  it("keeps (m) byte-identical to the pre-change golden", () => {
    expect(formatAvailableModelsForPrompt(goldenModels())).toBe(golden);
  });

  it("keeps (m, undefined) byte-identical", () => {
    expect(formatAvailableModelsForPrompt(goldenModels(), undefined)).toBe(golden);
  });

  it("keeps (m, []) byte-identical (empty external list)", () => {
    expect(formatAvailableModelsForPrompt(goldenModels(), [])).toBe(golden);
  });

  it("treats external entries with empty models arrays as absent (byte-identical)", () => {
    expect(formatAvailableModelsForPrompt(goldenModels(), [ext("droid", [], 0)])).toBe(golden);
  });

  it("empty pi list without external stays empty", () => {
    expect(formatAvailableModelsForPrompt([])).toBe("");
    expect(formatAvailableModelsForPrompt([], undefined)).toBe("");
    expect(formatAvailableModelsForPrompt([], [])).toBe("");
  });
});

describe("formatExternalModelsForPrompt (§5.3)", () => {
  it('returns "" when models is empty, regardless of total', () => {
    expect(formatExternalModelsForPrompt(ext("droid", [], 0))).toBe("");
    expect(formatExternalModelsForPrompt(ext("droid", [], 40))).toBe("");
  });

  it("renders the frozen sub-block: title, header line (incl. the resume-pinned sentence), model lines", () => {
    const out = formatExternalModelsForPrompt(
      ext("droid", [
        { provider: "droid", id: "claude-opus-4-5", name: "Claude Opus 4.5", note: "×1.5" },
        { provider: "droid", id: "gpt-5.3", name: "GPT-5.3" },
        { provider: "droid", id: "bare-id" },
      ]),
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("### External agent models (droid)");
    expect(lines[1]).toBe(externalModelsPromptHeader("droid"));
    // 验收②：resume 钉目录一句必须在文案里。
    expect(lines[1]).toContain("resuming is pinned to the original working directory");
    expect(lines[1]).toContain("Any droid model id is accepted");
    expect(lines[2]).toBe("- droid/claude-opus-4-5 — Claude Opus 4.5 (×1.5)");
    expect(lines[3]).toBe("- droid/gpt-5.3 — GPT-5.3");
    expect(lines[4]).toBe("- droid/bare-id");
    expect(lines).toHaveLength(5);
  });

  it("appends `… +N more` when total exceeds the listed models, and nothing when equal", () => {
    const withMore = formatExternalModelsForPrompt(ext("droid", [{ provider: "droid", id: "a" }], 4));
    expect(withMore.endsWith("- … +3 more")).toBe(true);
    const exact = formatExternalModelsForPrompt(ext("droid", [{ provider: "droid", id: "a" }], 1));
    expect(exact.endsWith("- … +0 more")).toBe(false);
    expect(exact.split("\n")).toHaveLength(3);
  });
});

describe("formatAvailableModelsForPrompt with external sub-blocks (§5.3)", () => {
  const pi: AvailableModelEntry[] = [{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" }];
  const piOnly = formatAvailableModelsForPrompt(pi);
  const droid = ext("droid", [{ provider: "droid", id: "gpt-5.3", name: "GPT-5.3", note: "×1" }], 2);

  it("appends the external sub-block after the pi block, separated by a blank line", () => {
    const out = formatAvailableModelsForPrompt(pi, [droid]);
    const extBlock = formatExternalModelsForPrompt(droid);
    expect(out).toBe(`${piOnly}\n\n${extBlock}`);
  });

  it("joins multiple providers in order with blank lines between sub-blocks", () => {
    const other = ext("cli2", [{ provider: "cli2", id: "m" }], 1);
    const out = formatAvailableModelsForPrompt(pi, [droid, other]);
    expect(out).toBe(`${piOnly}\n\n${formatExternalModelsForPrompt(droid)}\n\n${formatExternalModelsForPrompt(other)}`);
  });

  it("emits the same ## Available models title + provider/id instruction when the pi list is empty", () => {
    const out = formatAvailableModelsForPrompt([], [droid]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("## Available models (pi-subagent)");
    expect(lines[1]).toBe(piOnly.split("\n")[1]);
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("### External agent models (droid)");
    expect(out.endsWith(formatExternalModelsForPrompt(droid))).toBe(true);
  });

  it("keeps the pi 30-entry cap independent of external entries", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ provider: "p", id: `m${i}` }) as AvailableModelEntry);
    const out = formatAvailableModelsForPrompt(many, [droid]);
    expect(out).toContain("- ... and 3 more");
    expect(out).toContain("### External agent models (droid)");
  });
});
