/**
 * web-hub-preview-windows plan r2 §5.6 (W3): the pure MRU-ring helpers for the
 * conversation ⇄ window switcher (`Ctrl+`` / `Ctrl+Shift+``).
 */
import { describe, expect, it } from "vitest";
import { previewCycleRing, previewCycleStep } from "../../../src/web-hub/ui/src/logic/previewWindowCycle.js";

describe("logic/previewWindowCycle.ts — ring construction", () => {
  it("builds [page, active, …older] from the manager's activation order (last = active)", () => {
    expect(previewCycleRing([1, 2, 3])).toEqual(["page", 3, 2, 1]);
    expect(previewCycleRing([7])).toEqual(["page", 7]);
  });

  it("empty order degenerates to just the page (the composable's no-windows guard covers it)", () => {
    expect(previewCycleRing([])).toEqual(["page"]);
  });

  it("drops duplicate ids defensively (a manager defect must not double a window on the ring)", () => {
    expect(previewCycleRing([1, 2, 1])).toEqual(["page", 1, 2]);
  });
});

describe("logic/previewWindowCycle.ts — stepping", () => {
  const ring = previewCycleRing([1, 2, 3]); // ["page", 3, 2, 1]

  it("forward from the page lands on the ACTIVE window", () => {
    expect(previewCycleStep(ring, "page", 1)).toBe(3);
  });

  it("forward walks the FROZEN ring toward older windows and wraps back to the page", () => {
    expect(previewCycleStep(ring, 3, 1)).toBe(2); // NOT 3 again — no ping-pong
    expect(previewCycleStep(ring, 2, 1)).toBe(1);
    expect(previewCycleStep(ring, 1, 1)).toBe("page");
  });

  it("backward from the page wraps to the OLDEST window", () => {
    expect(previewCycleStep(ring, "page", -1)).toBe(1);
    expect(previewCycleStep(ring, 1, -1)).toBe(2);
    expect(previewCycleStep(ring, 3, -1)).toBe("page");
  });

  it("a single window cycles page ⇄ window in both directions", () => {
    const one = previewCycleRing([5]);
    expect(previewCycleStep(one, "page", 1)).toBe(5);
    expect(previewCycleStep(one, 5, 1)).toBe("page");
    expect(previewCycleStep(one, "page", -1)).toBe(5);
  });

  it("stepping from an entry not on the ring answers null (caller must re-snapshot)", () => {
    expect(previewCycleStep(ring, 99, 1)).toBeNull();
    expect(previewCycleStep([], "page", 1)).toBeNull();
  });

  it("frozen-ring stepping ignores a NEWER activation order — the anti-ping-pong property", () => {
    // After landing on window 2 the manager raises it: order [1,3,2]. A ring rebuilt NOW
    // would be ["page",2,3,1] and step from 2 back to 3 — a bounce. The frozen ring steps
    // 2 → 1 instead (this is exactly what the composable must keep doing).
    const frozen = previewCycleRing([1, 2, 3]);
    const rebuilt = previewCycleRing([1, 3, 2]);
    expect(previewCycleStep(frozen, 2, 1)).toBe(1);
    expect(previewCycleStep(rebuilt, 2, 1)).toBe(3); // demonstrates why rebuilding bounces
  });
});
