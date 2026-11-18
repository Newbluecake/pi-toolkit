import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/sysload/settings.js";
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
    const gateOn = buildLoadRecoveryText(verdict("ok", true), true);
    expect(gateOn).toContain("可以继续派发");
    expect(gateOn.startsWith("[load 恢复]")).toBe(true);
    expect(gateOn).not.toMatch(/\b(warn|crit)\b/);
    // 负断言用 warn/crit 级别的 verdict：旧实现（`[load] warn · …`）会命中，新实现不命中。
    for (const level of ["warn", "crit"] as const) {
      for (const gate of [true, false]) {
        const text = buildLoadRecoveryText(verdict(level, gate), gate);
        expect(text.startsWith("[load 恢复]")).toBe(true);
        expect(text).not.toMatch(/\b(warn|crit)\b/);
      }
    }
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

  // darwin-plan §2.8（修订 #2）：render 链经 loadDetail 复用明细行，不含任何 ps 命令 —— 以下守卫把这一事实钉住，
  // 防止日后有人在 render 里加命令忘了平台化。涵盖 top 有/无、nested 有/无、ownRuns、darwin 形态 verdict。
  it("never renders a ps command or --sort, whatever the verdict shape (render chain is platform-free)", () => {
    const darwinShaped: LoadVerdict = {
      level: "crit",
      gating: true,
      metrics: {
        cpu: { level: "unknown" },
        mem: { level: "unknown", availPct: 3 },
        disk: [{ label: "/", state: { level: "crit", freeBytes: 3.1 * 2 ** 30, mountPath: "/" } }],
      },
      mono: 120_000,
      at: Date.UTC(2026, 0, 1, 14, 4),
      gatingSinceMono: 0,
      loadavg: [18.2, 15.1, 9.8],
      cores: 12,
    };
    for (const nested of [true, false]) {
      for (const withTop of [true, false]) {
        for (const ownRuns of [undefined, ["r1", "r2"]] as const) {
          const text = buildLoadEscalationText(darwinShaped, {
            nested,
            ...(withTop ? { top } : {}),
            ...(ownRuns === undefined ? {} : { ownRuns }),
          });
          expect(text).not.toContain("ps ");
          expect(text).not.toContain("--sort");
          expect(text).not.toContain("ps -eo");
        }
      }
    }
    // darwin 形态的明细行：CPU 读数缺席 → `CPU —`；核数来自 verdict.cores（sample.cores 回退）
    const detail = buildLoadEscalationText(darwinShaped, {});
    expect(detail).toContain("CPU —");
    expect(detail).toContain("loadavg 18.2 / 15.1 / 9.8 (12 cores)");
    expect(detail).toContain("MEM 3% avail");
  });
});
