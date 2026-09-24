import { describe, expect, it } from "vitest";
import {
  appendAvailableModelsToSystemPrompt,
  formatAvailableModelsForPrompt,
} from "../../src/config/available-models.js";
import { foldSections } from "../../src/prompt-sections/fold.js";
import {
  POINTED,
  SKIP,
  UPDATE_LIMITS,
  forgetAnnounced,
  initialSectionState,
  markStale,
  resolveAtSeed,
  resolveAtTurn,
} from "../../src/prompt-sections/stable-section.js";

describe("prompt section state machine", () => {
  it("refreshes only on stale and SKIP never advances", () => {
    const initial = initialSectionState();
    expect(resolveAtTurn(initial, SKIP).state).toEqual(initial);
    const refreshed = resolveAtTurn(initial, "one");
    expect(refreshed).toEqual({
      state: { snapshot: "one", announced: "one", stale: false, sentCount: 0, sentBytes: 0 },
      text: "one",
    });
    expect(resolveAtTurn(refreshed.state, "two").update).toEqual({ kind: "update", content: "two" });
    expect(resolveAtTurn(refreshed.state, SKIP).state).toEqual(refreshed.state);
  });
  it("handles removal, limits, pointer, stale and seed", () => {
    let state = resolveAtTurn(initialSectionState(), "a").state;
    const removed = resolveAtTurn(state, "");
    expect(removed.update).toEqual({ kind: "removed" });
    state = removed.state;
    const capped = resolveAtTurn(state, "b", { maxCount: 1, maxBytes: 1 });
    expect(capped.update).toEqual({ kind: "pointer" });
    state = capped.state;
    expect(resolveAtTurn(state, "cc", { maxCount: 1, maxBytes: 1 }).update).toBeUndefined();
    expect(resolveAtTurn({ ...state, announced: POINTED }, "dd").update).toBeUndefined();
    expect(resolveAtSeed(markStale(state), () => "seed").text).toBe("seed");
    expect(forgetAnnounced(state).announced).toBe(state.snapshot);
    expect(UPDATE_LIMITS).toEqual({ maxCount: 3, maxBytes: 32768 });
  });
});

describe("foldSections", () => {
  it("matches the existing available-model appender byte-for-byte", () => {
    const models = [{ provider: "p", id: "m", name: "Model" }];
    expect(foldSections("BASE", [formatAvailableModelsForPrompt(models)])).toBe(
      appendAvailableModelsToSystemPrompt("BASE", models),
    );
  });

  it("matches append chaining and skips empty sections", () => {
    expect(foldSections("BASE", ["A", "", "B"])).toBe("BASE\n\nA\n\nB");
    expect(foldSections("BASE", ["", ""])).toBe("BASE");
  });
});
