// external-agent plan §6.2 P4a：`availableModelsSection` 的可选 `externalModels`
// dep（§5.3 冻结面）。缺席 ⇒ provider 输出与改动前逐字节一致（与直接调
// `formatAvailableModelsForPrompt(resolved)` 对比）；P5 注入后追加 external 子块；
// 端口抛错/返回非数组 ⇒ 降级为纯 pi 输出，绝不崩提示词路径。

import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatAvailableModelsForPrompt,
  type AvailableModelEntry,
  type ExternalPromptModels,
} from "../../src/config/available-models.js";
import { availableModelsSection } from "../../src/sysprompt/core-sections.js";
import type { SectionProviderInput } from "../../src/sysprompt/hub.js";

const STACK: AvailableModelEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { provider: "openai", id: "gpt-5.2" },
];

const DROID: ExternalPromptModels = {
  provider: "droid",
  models: [{ provider: "droid", id: "gpt-5.3", name: "GPT-5.3", note: "×1" }],
  total: 1,
};

function fakeCtx(overrides: Partial<Record<"scopedModels" | "modelRegistry", unknown>> = {}): ExtensionContext {
  return {
    cwd: "/proj",
    scopedModels: [],
    modelRegistry: { getAvailable: (): AvailableModelEntry[] => [] },
    ...overrides,
  } as unknown as ExtensionContext;
}

function input(ctx: ExtensionContext): SectionProviderInput {
  return { ctx, promptText: "" };
}

describe("availableModelsSection externalModels dep (§5.3, P4a)", () => {
  it("without externalModels: provider output is byte-identical to the plain pi format", () => {
    const registration = availableModelsSection({ stackAvailable: () => STACK });
    const out = registration.provider(input(fakeCtx()));
    expect(out).toBe(formatAvailableModelsForPrompt(STACK));
    expect(out).not.toContain("External agent models");
    expect(registration.title).toBe("## Available models (pi-subagent)");
  });

  it("with externalModels: appends the external sub-block to the resolved pi list", () => {
    const registration = availableModelsSection({ stackAvailable: () => STACK, externalModels: () => [DROID] });
    const out = registration.provider(input(fakeCtx()));
    expect(out).toBe(formatAvailableModelsForPrompt(STACK, [DROID]));
    expect(out).toContain("### External agent models (droid)");
    expect(out).toContain("- droid/gpt-5.3 — GPT-5.3 (×1)");
  });

  it("externalModels returning undefined/[] degrades to the plain pi output", () => {
    const ctx = fakeCtx();
    const expected = formatAvailableModelsForPrompt(STACK);
    expect(
      availableModelsSection({ stackAvailable: () => STACK, externalModels: () => undefined }).provider(input(ctx)),
    ).toBe(expected);
    expect(availableModelsSection({ stackAvailable: () => STACK, externalModels: () => [] }).provider(input(ctx))).toBe(
      expected,
    );
  });

  it("a throwing externalModels port degrades to the plain pi output (prompt path never crashes)", () => {
    const registration = availableModelsSection({
      stackAvailable: () => STACK,
      externalModels: () => {
        throw new Error("port gone");
      },
    });
    expect(registration.provider(input(fakeCtx()))).toBe(formatAvailableModelsForPrompt(STACK));
  });

  it("a non-array externalModels value degrades to the plain pi output", () => {
    const registration = availableModelsSection({
      stackAvailable: () => STACK,
      externalModels: () => "droid" as unknown as readonly ExternalPromptModels[],
    });
    expect(registration.provider(input(fakeCtx()))).toBe(formatAvailableModelsForPrompt(STACK));
  });

  it("keeps the existing scoped-models priority: scoped wins over stack, external still appended", () => {
    const scoped = [{ model: { provider: "zai", id: "glm-5.3" } }];
    const ctx = fakeCtx({ scopedModels: scoped });
    const registration = availableModelsSection({ stackAvailable: () => STACK, externalModels: () => [DROID] });
    const out = registration.provider(input(ctx));
    expect(out).toBe(formatAvailableModelsForPrompt([{ provider: "zai", id: "glm-5.3" }], [DROID]));
    expect(out).toContain("- zai/glm-5.3");
    expect(out).not.toContain("- anthropic/claude-opus-4-5");
  });

  it("empty pi models + external: still emits the section (title + external sub-block)", () => {
    const registration = availableModelsSection({ stackAvailable: () => [], externalModels: () => [DROID] });
    const out = registration.provider(input(fakeCtx()));
    expect(out.split("\n")[0]).toBe("## Available models (pi-subagent)");
    expect(out).toContain("### External agent models (droid)");
  });
});
