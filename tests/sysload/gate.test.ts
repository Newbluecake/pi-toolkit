import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/config/settings.js";
import { evaluateLoadGate } from "../../src/sysload/gate.js";
import { buildLoadEscalationText } from "../../src/sysload/render.js";
import type { LoadVerdict } from "../../src/sysload/types.js";

const verdict: LoadVerdict = {
  level: "crit",
  gating: true,
  metrics: { cpu: { level: "crit" }, mem: { level: "ok" }, disk: [] },
  mono: 1,
  at: 1,
};

describe("sysload gate and render", () => {
  it("is zero-IO and gives nested copy", () => {
    const decision = evaluateLoadGate(verdict, parseLoadSettings({}), { nested: true });
    expect(decision.blocked).toBe(true);
    expect(decision.message).toContain("请不要再委派");
    expect(buildLoadEscalationText({ ...verdict, gating: false }, {})).toContain("仅提示");
  });

  it("gate=false always fails open", () => {
    expect(evaluateLoadGate(verdict, parseLoadSettings({ gate: false })).blocked).toBe(false);
  });
});
