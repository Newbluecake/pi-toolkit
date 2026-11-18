import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/sysload/settings.js";
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

  // darwin-plan §2.8（修订 #2）：平台化只改 gate 链的 fallback 命令；缺省与 "linux" 必须与改动前
  // 字节相同（不依赖宿主 process.platform，旧测试/旧调用方在 mac 上也得到原串）。
  const GNU_FALLBACK = "top snapshot unavailable; run `ps -eo pid,comm,%cpu,rss --sort=-%cpu | head`";
  const BSD_FALLBACK = "top snapshot unavailable; run `ps -A -r -o pid,pcpu,rss,comm | head`";
  const ORIGINAL_PLAIN =
    "load gate: 系统负载过高（crit），本次派发已拒绝，未创建任何 run / label / worktree。\n[load] crit · CPU 97% (PSI 74%) · MEM 6% avail · DISK / 3.1G free · since 14:02 (2m)\nloadavg 18.2 / 15.1 / 9.8 (16 cores)\n" +
    GNU_FALLBACK +
    "\n可二选一：① 排查负载来源；② 等待回落后在下一轮继续派发。";
  const ORIGINAL_NESTED =
    "load gate: 系统负载过高（crit），本次嵌套派发已拒绝，未创建任何 run / label / worktree。\n[load] crit · CPU 97% (PSI 74%) · MEM 6% avail · DISK / 3.1G free · since 14:02 (2m)\nloadavg 18.2 / 15.1 / 9.8 (16 cores)\n" +
    GNU_FALLBACK +
    "\n请不要再委派：自己完成剩余工作，或带着现状说明交回上层。";

  it("keeps the pre-darwin gate text byte-identical for the default and non-darwin platforms", () => {
    for (const platform of [undefined, "linux", "win32"] as const) {
      const plain = evaluateLoadGate(verdict, parseLoadSettings({}), { platform });
      const nested = evaluateLoadGate(verdict, parseLoadSettings({}), { platform, nested: true });
      expect(plain.message).toBe(ORIGINAL_PLAIN);
      expect(nested.message).toBe(ORIGINAL_NESTED);
      expect(plain.message).toContain(GNU_FALLBACK);
    }
  });

  it("swaps in the BSD fallback command on darwin, in both message templates", () => {
    const plain = evaluateLoadGate(verdict, parseLoadSettings({}), { platform: "darwin" });
    const nested = evaluateLoadGate(verdict, parseLoadSettings({}), { platform: "darwin", nested: true });
    expect(plain.blocked).toBe(true);
    expect(plain.message).toContain(BSD_FALLBACK);
    expect(nested.message).toContain(BSD_FALLBACK);
    for (const message of [plain.message, nested.message]) {
      expect(message).not.toContain("--sort");
      expect(message).not.toContain(GNU_FALLBACK);
    }
    expect(nested.message).toContain("请不要再委派");
    expect(plain.message).toContain("可二选一");
  });
});
