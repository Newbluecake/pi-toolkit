import { describe, expect, it } from "vitest";
import { xsOn } from "../../src/fabric/xs/switch.js";

/** fabric phase-2 XS0 (phase2-plan §4.1): `xsOn` truth table — all four prerequisites, AND only. */

const T = { enabled: true, crossSession: { enabled: true } };
const F = { enabled: false, crossSession: { enabled: true } };
const X = { enabled: true, crossSession: { enabled: false } };
const HUB_ON = { enabled: true, control: true };

describe("xsOn (phase2 §4.1)", () => {
  it("is on exactly when fabric ∧ crossSession ∧ webHub ∧ control", () => {
    expect(xsOn({ fabric: T, webHub: HUB_ON })).toBe(true);
    expect(xsOn({ fabric: F, webHub: HUB_ON })).toBe(false);
    expect(xsOn({ fabric: X, webHub: HUB_ON })).toBe(false);
    expect(xsOn({ fabric: T, webHub: { enabled: false, control: true } })).toBe(false);
    expect(xsOn({ fabric: T, webHub: { enabled: true, control: false } })).toBe(false);
    expect(
      xsOn({
        fabric: { enabled: false, crossSession: { enabled: false } },
        webHub: { enabled: false, control: false },
      }),
    ).toBe(false);
  });

  it("is a pure AND over the caller's booleans — no validation, no defaults (settings parsing owns validity)", () => {
    // every miss must flip the result, whatever the other three inputs are
    for (const miss of [
      { fabric: F, webHub: HUB_ON },
      { fabric: X, webHub: HUB_ON },
      { fabric: T, webHub: { enabled: false, control: true } },
      { fabric: T, webHub: { enabled: true, control: false } },
    ] as const) {
      expect(xsOn(miss)).toBe(false);
    }
    expect(xsOn({ fabric: T, webHub: HUB_ON })).toBe(true);
  });
});
