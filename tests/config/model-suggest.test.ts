import { describe, expect, it } from "vitest";
import { formatUnknownModelError, suggestModelRefs, type ModelCandidate } from "../../src/config/model-hint.js";
import { registryModelExists } from "../../src/config/available-models.js";

const registry: ModelCandidate[] = [
  { provider: "zai", id: "glm-5.3" },
  { provider: "cr-anthropic", id: "claude-sonnet-5" },
  { provider: "cr-anthropic", id: "claude-opus-5-5" },
  { provider: "cr-anthropic", id: "claude-opus-5" },
  { provider: "newapi-aws", id: "claude-opus-5-5" },
  { provider: "kimi-coding", id: "kimi-k3" },
];
const refs = (cs: readonly ModelCandidate[]) => cs.map((c) => `${c.provider}/${c.id}`);

describe("suggestModelRefs", () => {
  it("renamed provider: offers the same id under the other providers first", () => {
    const got = suggestModelRefs({ provider: "cloudrouter-anthropic", id: "claude-opus-5-5" }, registry);
    // Tier 0 (same id) ranked by provider-name distance: cr-anthropic is the closer rename.
    expect(refs(got).slice(0, 2)).toEqual(["cr-anthropic/claude-opus-5-5", "newapi-aws/claude-opus-5-5"]);
    expect(got.length).toBeLessThanOrEqual(3);
  });

  it("unknown id under a known provider: similar ids of that provider", () => {
    const got = suggestModelRefs({ provider: "cr-anthropic", id: "claude-opus-5-6" }, registry);
    expect(refs(got)[0]).toBe("cr-anthropic/claude-opus-5-5");
    expect(refs(got)).toContain("cr-anthropic/claude-opus-5");
    expect(refs(got)).not.toContain("zai/glm-5.3");
  });

  it("case-only mismatch is the top suggestion (pi's lookup is exact)", () => {
    const got = suggestModelRefs({ provider: "CR-Anthropic", id: "claude-sonnet-5" }, registry);
    expect(refs(got)[0]).toBe("cr-anthropic/claude-sonnet-5");
  });

  it("never offers an unrelated model and honours the limit", () => {
    expect(suggestModelRefs({ provider: "openai", id: "gpt-9-turbo" }, registry)).toEqual([]);
    expect(suggestModelRefs({ provider: "x", id: "claude-opus-5-5" }, registry, 1)).toHaveLength(1);
  });

  it("dedupes repeated candidates", () => {
    const got = suggestModelRefs({ provider: "old", id: "kimi-k3" }, [...registry, ...registry]);
    expect(refs(got)).toEqual(["kimi-coding/kimi-k3"]);
  });
});

describe("formatUnknownModelError", () => {
  it("names the model, says no run started and lists suggestions", () => {
    const msg = formatUnknownModelError({ provider: "cloudrouter-anthropic", id: "claude-opus-5-5" }, registry);
    expect(msg).toContain('Unknown model "cloudrouter-anthropic/claude-opus-5-5"');
    expect(msg).toContain("no run was started");
    expect(msg).toContain("Did you mean: cr-anthropic/claude-opus-5-5");
  });

  it("falls back to the available list when nothing is similar, and carries source + annotate", () => {
    const msg = formatUnknownModelError({ provider: "openai", id: "gpt-9-turbo" }, registry.slice(0, 2), {
      source: 'agent type "Plan" frontmatter model',
      annotate: (c) => (c.provider === "zai" ? " [5h 93%]" : undefined),
    });
    expect(msg).toContain('(agent type "Plan" frontmatter model)');
    expect(msg).not.toContain("Did you mean");
    expect(msg).toContain("Available: zai/glm-5.3 [5h 93%], cr-anthropic/claude-sonnet-5");
  });
});

describe("registryModelExists", () => {
  const find = (p: string, id: string) => registry.find((c) => c.provider === p && c.id === id);
  it("true for a known pair, false for an unknown one", () => {
    const reg = { find, getAll: () => registry };
    expect(registryModelExists(reg, { provider: "cr-anthropic", id: "claude-opus-5-5" })).toBe(true);
    expect(registryModelExists(reg, { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" })).toBe(false);
  });
  it("undefined (never blocks) when the registry is missing, throws, or knows no models", () => {
    const ref = { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" };
    expect(registryModelExists(undefined, ref)).toBeUndefined();
    expect(registryModelExists({}, ref)).toBeUndefined();
    expect(
      registryModelExists(
        {
          find: () => {
            throw new Error("registry gone");
          },
        },
        ref,
      ),
    ).toBeUndefined();
    expect(registryModelExists({ find: () => undefined, getAll: () => [] }, ref)).toBeUndefined();
    expect(registryModelExists({ find: () => undefined, getAvailable: () => [] }, ref)).toBeUndefined();
    // getAll wins over getAvailable: a model that exists but has no auth is still "known".
    expect(registryModelExists({ find: () => undefined, getAll: () => registry, getAvailable: () => [] }, ref)).toBe(
      false,
    );
  });
});
