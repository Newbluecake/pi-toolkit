import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/config/settings.js";
import { buildLoadEscalationText, buildLoadRecoveryText } from "../../src/sysload/render.js";
import { aggregateTop } from "../../src/sysload/top.js";
import type { LoadVerdict } from "../../src/sysload/types.js";

const verdict = (level: LoadVerdict["level"], gating: boolean): LoadVerdict => ({
  level,
  gating,
  metrics: { cpu: { level }, mem: { level: "ok" }, disk: [] },
  mono: 1,
  at: 1,
});

const top = aggregateTop(
  [{ pid: 1, comm: "node", utime: 1, stime: 0, starttime: 1, rssPages: 2, lifetimeSeconds: 1 }],
  undefined,
  0,
  { userHz: 100, pageSize: 4096 },
);

describe("sysload render", () => {
  it("renders nested and non-nested escalation choices", () => {
    expect(buildLoadEscalationText(verdict("crit", true), { nested: true, top })).toContain("请不要再委派");
    expect(buildLoadEscalationText(verdict("crit", true), { top })).toContain("可二选一");
  });

  it("renders gate-on and gate-off phrasing", () => {
    expect(buildLoadEscalationText(verdict("crit", true), { top })).toContain("已暂停派发");
    expect(buildLoadEscalationText(verdict("crit", false), { top })).toContain("仅提示");
    expect(buildLoadRecoveryText(verdict("ok", false), false)).toContain("闸门已关闭");
    expect(buildLoadRecoveryText(verdict("ok", true), true)).toContain("可以继续派发");
  });

  it("renders labels, empty top rows, and unavailable units without NaN", () => {
    expect(buildLoadEscalationText(verdict("unknown", false), { top: { ...top, byCpu: [], byRss: [] } })).toContain(
      "unknown",
    );
    const unavailable = { ...top, unitsAvailable: false };
    const text = buildLoadEscalationText(verdict("crit", true), { top: unavailable });
    expect(text).toContain("node×1 n/a");
    expect(text).not.toContain("NaN");
  });

  it("keeps the configured threshold copy independent of render inputs", () => {
    const settings = parseLoadSettings({ gate: false });
    expect(settings.gate).toBe(false);
    expect(buildLoadRecoveryText(verdict("ok", false), settings.gate)).toContain("仅提示");
  });
});
