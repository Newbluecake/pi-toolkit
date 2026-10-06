import { describe, expect, it } from "vitest";
import * as piAi from "@earendil-works/pi-ai";

describe("model switch conformance", () => {
  it("exposes pi-ai thinking-level capability and returns off for a non-reasoning model", () => {
    expect(typeof piAi.getSupportedThinkingLevels).toBe("function");
    const levels = piAi.getSupportedThinkingLevels({
      id: "plain-model",
      name: "Plain model",
      api: "anthropic-messages",
      provider: "fake-provider",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0 },
      contextWindow: 200_000,
      maxTokens: 4096,
    });
    expect(levels).toEqual(["off"]);
  });
});
