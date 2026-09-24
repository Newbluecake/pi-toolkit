import { describe, expect, it } from "vitest";
import {
  appendAvailableModelsToSystemPrompt,
  availableModelsFromRegistry,
  formatAvailableModelsForPrompt,
  readScopedModels,
  recommendableModels,
  resolvePromptModels,
  type AvailableModelEntry,
  type ScopedModelLike,
} from "../../src/config/available-models.js";

const model = (entry: Partial<AvailableModelEntry> = {}): AvailableModelEntry => ({
  provider: "anthropic",
  id: "claude-sonnet",
  ...entry,
});

describe("available models prompt", () => {
  it("deduplicates provider/id entries while preserving the first entry", () => {
    const output = formatAvailableModelsForPrompt([
      model({ name: "First" }),
      model({ name: "Second", reasoning: true }),
      model({ provider: "openai", id: "gpt-5" }),
    ]);

    expect(output.match(/^- /gm)).toHaveLength(2);
    expect(output).toContain("- anthropic/claude-sonnet — First");
    expect(output).not.toContain("Second");
    expect(output).toContain("- openai/gpt-5");
  });

  it("renders context windows compactly and keeps ctx before reasoning", () => {
    const output = formatAvailableModelsForPrompt([
      model({ id: "one-million", contextWindow: 1_000_000, reasoning: true }),
      model({ id: "fractional-million", contextWindow: 1_050_000 }),
      model({ id: "two-hundred-k", contextWindow: 200_000 }),
      model({ id: "small", contextWindow: 999 }),
      model({ id: "none" }),
    ]);

    expect(output).toContain("- anthropic/one-million (ctx 1M, reasoning)");
    expect(output).toContain("- anthropic/fractional-million (ctx 1.05M)");
    expect(output).toContain("- anthropic/two-hundred-k (ctx 200k)");
    expect(output).toContain("- anthropic/small (ctx 999)");
    expect(output).toContain("- anthropic/none");
    expect(output).not.toContain("anthropic/none (");
  });

  it("renders names and reasoning only when present", () => {
    const output = formatAvailableModelsForPrompt([
      model({ id: "named", name: "Named model", reasoning: true }),
      model({ id: "unnamed", reasoning: false }),
      model({ id: "plain" }),
    ]);

    expect(output).toContain("- anthropic/named — Named model (reasoning)");
    expect(output).toContain("- anthropic/unnamed");
    expect(output).not.toContain("anthropic/unnamed (");
    expect(output).toContain("- anthropic/plain");
  });

  it("limits the list to 30 unique models and reports the remainder", () => {
    const models = Array.from({ length: 31 }, (_, index) => model({ id: `model-${index}` }));
    const output = formatAvailableModelsForPrompt(models);

    expect(output.match(/^- /gm)).toHaveLength(31);
    expect(output).toContain("- anthropic/model-29");
    expect(output).not.toContain("- anthropic/model-30");
    expect(output).toContain("- ... and 1 more");
  });

  it("returns an empty section for an empty list", () => {
    expect(formatAvailableModelsForPrompt([])).toBe("");
  });

  it("demands the full provider/id (the provider prefix is not optional)", () => {
    const output = formatAvailableModelsForPrompt([model()]);
    expect(output).toContain("## Available models (pi-subagent)");
    expect(output).toMatch(/FULL `provider\/id`/);
    expect(output).toContain("the provider prefix is mandatory");
  });

  it("appends the section and preserves identity when there is nothing to append", () => {
    const prompt = "base system prompt";
    expect(appendAvailableModelsToSystemPrompt(prompt, [])).toBe(prompt);
    expect(appendAvailableModelsToSystemPrompt(prompt, [model()])).toBe(
      `${prompt}\n\n${formatAvailableModelsForPrompt([model()])}`,
    );
  });
});

describe("readScopedModels", () => {
  it("returns an empty list when no scoping is configured", () => {
    expect(readScopedModels(undefined)).toEqual([]);
    expect(readScopedModels([])).toEqual([]);
  });

  it("unwraps ScopedModel.model and keeps only the prompt-entry fields", () => {
    expect(
      readScopedModels([
        {
          model: {
            provider: "droid-completion",
            id: "kimi-k3",
            name: "Kimi K3",
            contextWindow: 256_000,
            extra: "must not leak",
          } as never,
          thinkingLevel: "high",
        } as never,
        { model: { provider: "cloudrouter-anthropic", id: "claude-opus-5" } },
      ]),
    ).toEqual([
      { provider: "droid-completion", id: "kimi-k3", name: "Kimi K3", contextWindow: 256_000 },
      { provider: "cloudrouter-anthropic", id: "claude-opus-5" },
    ]);
  });

  it("skips malformed entries instead of throwing", () => {
    expect(readScopedModels([undefined as never, { model: { provider: "p", id: "m" } }])).toEqual([
      { provider: "p", id: "m" },
    ]);
  });
});

describe("availableModelsFromRegistry", () => {
  it("returns an empty list for a missing or malformed registry", () => {
    expect(availableModelsFromRegistry(undefined)).toEqual([]);
    expect(availableModelsFromRegistry({} as never)).toEqual([]);
  });

  it("fails open when the registry throws", () => {
    const registry = {
      getAvailable() {
        throw new Error("models.json broke");
      },
    };
    expect(availableModelsFromRegistry(registry)).toEqual([]);
  });

  it("copies only the prompt-entry fields", () => {
    const registry = {
      getAvailable: () => [
        {
          provider: "anthropic",
          id: "claude-sonnet",
          name: "Claude Sonnet",
          reasoning: true,
          contextWindow: 200_000,
          extra: "must not leak",
        },
      ],
    };
    expect(availableModelsFromRegistry(registry)).toEqual([
      { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", reasoning: true, contextWindow: 200_000 },
    ]);
  });
});

describe("resolvePromptModels (sysprompt-stable plan.md §4.6 priority: scoped > stack port > registry)", () => {
  const scoped: ScopedModelLike[] = [{ model: model({ provider: "droid-completion", id: "kimi-k3" }) }];
  const stack: AvailableModelEntry[] = [model({ provider: "stack", id: "from-holder" })];
  const registry = { getAvailable: () => [model({ provider: "registry", id: "from-registry" })] };

  it("prefers session-scoped models over the stack port and the registry", () => {
    expect(resolvePromptModels(scoped, stack, registry)).toEqual([{ provider: "droid-completion", id: "kimi-k3" }]);
  });

  it("falls back to the session stack's model port when nothing is scoped", () => {
    expect(resolvePromptModels(undefined, stack, registry)).toEqual(stack);
    expect(resolvePromptModels([], stack, registry)).toEqual(stack);
  });

  it("falls back to a fresh registry snapshot when neither scope nor stack is available", () => {
    expect(resolvePromptModels(undefined, undefined, registry)).toEqual([
      { provider: "registry", id: "from-registry" },
    ]);
  });

  it("returns an empty list when nothing is available anywhere", () => {
    expect(resolvePromptModels(undefined, undefined, undefined)).toEqual([]);
  });

  it("treats an empty stack array as present (not a signal to fall back to the registry)", () => {
    expect(resolvePromptModels(undefined, [], registry)).toEqual([]);
  });
});

describe("recommendableModels (quota alternatives only suggest /models-scoped models)", () => {
  const ref = (m: AvailableModelEntry) => `${m.provider}/${m.id}`;
  const available = [
    model({ provider: "deepseek", id: "deepseek-flash" }),
    model({ provider: "newapi-aws", id: "claude-opus-5" }),
    model({ provider: "zai", id: "glm-4.7" }),
    model({ provider: "zai", id: "glm-5.3" }),
  ];

  it("restricts to the scope, in scope order, dropping scoped-but-unusable entries", () => {
    const scoped = [
      model({ provider: "zai", id: "glm-5.3" }),
      model({ provider: "kimi-coding", id: "k3" }), // scoped but not in available (no auth)
      model({ provider: "deepseek", id: "deepseek-flash" }),
      model({ provider: "zai", id: "glm-5.3" }), // duplicate
    ];
    expect(recommendableModels(scoped, available).map(ref)).toEqual(["zai/glm-5.3", "deepseek/deepseek-flash"]);
  });

  it("falls back to the full available list when no scope is configured", () => {
    expect(recommendableModels([], available).map(ref)).toEqual(available.map(ref));
  });
});
