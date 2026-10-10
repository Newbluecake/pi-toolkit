import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/config/settings.js";
import { evaluateLoadGate } from "../../src/sysload/gate.js";
import { buildLoadEscalationText } from "../../src/sysload/render.js";
import type { LoadVerdict } from "../../src/sysload/types.js";

const verdict: LoadVerdict = {
  level: "crit",
  gating: true,
  metrics: {
    cpu: { level: "crit", busyPct: 97, psiPct: 74 },
    mem: { level: "ok", availPct: 6 },
    disk: [{ label: "/", state: { level: "crit", freeBytes: 3.1 * 2 ** 30, mountPath: "/" } }],
  },
  mono: 120_000,
  at: Date.UTC(2026, 0, 1, 14, 4),
  gatingSinceMono: 0,
  loadavg: [18.2, 15.1, 9.8],
  cores: 16,
};

describe("sysload gate and render", () => {
  it("is zero-IO and gives nested copy", () => {
    const decision = evaluateLoadGate(verdict, parseLoadSettings({}), { nested: true });
    expect(decision.blocked).toBe(true);
    expect(decision.message).toContain("请不要再委派");
    expect(decision.message).toContain("CPU 97% (PSI 74%)");
    expect(decision.message).toContain("MEM 6% avail");
    expect(decision.message).toContain("DISK / 3.1G free");
    expect(decision.message).toContain("loadavg 18.2 / 15.1 / 9.8 (16 cores)");
    expect(decision.message).toContain("since");
    expect(buildLoadEscalationText({ ...verdict, gating: false }, {})).toContain("仅提示");
  });

  it("gate=false always fails open", () => {
    expect(evaluateLoadGate(verdict, parseLoadSettings({ gate: false })).blocked).toBe(false);
  });
});
