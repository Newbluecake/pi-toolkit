import { describe, expect, it } from "vitest";
import {
  containsPlaceholderAppMarker,
  isStrictBodyMode,
  PLACEHOLDER_APP_MARKER,
} from "../../../scripts/web-hub/visual/checks-body.js";

/**
 * Verifier P1 fix: `checks-body.ts` used to degrade every missing-target-DOM check to an
 * informational pass unconditionally, which would keep silently passing even after P3 replaces
 * `App.vue` and a check's target DOM is genuinely missing (a real regression). These pure
 * helpers gate that degrade behind confirming the mounted app still carries P0's placeholder
 * marker, plus a strict-mode escape hatch (`PWH_VISUAL_STRICT_BODY=1`) that always fails instead.
 */
describe("checks-body.ts placeholder-App detection", () => {
  it("recognizes the exact P0 placeholder text as present in a larger body textContent", () => {
    const body = `\n    pi web-hub — UI under construction. See docs/dev/web-hub/vue-plan.md.\n  `;
    expect(containsPlaceholderAppMarker(body)).toBe(true);
  });

  it("does not recognize a real P3+ shell's body text as the placeholder", () => {
    const body = "Dashboard Agents Fleet worker-1 running";
    expect(containsPlaceholderAppMarker(body)).toBe(false);
  });

  it("does not false-positive on partial/mangled marker text", () => {
    expect(containsPlaceholderAppMarker("pi web-hub is under construction somewhere")).toBe(false);
    expect(containsPlaceholderAppMarker("")).toBe(false);
  });

  it("exports the marker string itself so callers/tests share one source of truth", () => {
    expect(PLACEHOLDER_APP_MARKER).toBe("pi web-hub — UI under construction");
  });

  describe("isStrictBodyMode", () => {
    it('is false when PWH_VISUAL_STRICT_BODY is unset or not exactly "1"', () => {
      expect(isStrictBodyMode({})).toBe(false);
      expect(isStrictBodyMode({ PWH_VISUAL_STRICT_BODY: "0" })).toBe(false);
      expect(isStrictBodyMode({ PWH_VISUAL_STRICT_BODY: "true" })).toBe(false);
    });

    it('is true only when PWH_VISUAL_STRICT_BODY is exactly "1"', () => {
      expect(isStrictBodyMode({ PWH_VISUAL_STRICT_BODY: "1" })).toBe(true);
    });
  });
});
