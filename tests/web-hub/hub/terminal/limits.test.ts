import { describe, it, expect } from "vitest";
import { TerminalLimits } from "../../../../src/web-hub/hub/terminal/limits.js";
import { TERMINAL_LIMITS as L } from "../../../../src/web-hub/protocol/terminal.js";
const config = {
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  inputIdleMs: L.inputIdleMs,
  maxLifetimeMs: L.maxLifetimeMs,
};
describe("terminal physical and forwarding limits (§6.3)", () => {
  it("2/session 2/principal 8/hub include closing/reaping/poison until proven release", () => {
    const x = new TerminalLimits(config, () => 0);
    x.reserve("r1", "s1", "p1");
    x.reserve("r2", "s1", "p1");
    expect(() => x.reserve("r3", "s1", "p2")).toThrow("E_LIMIT");
    expect(() => x.reserve("r3", "s2", "p1")).toThrow("E_LIMIT");
    for (let i = 2; i < 5; i++) {
      x.reserve(`r${i}a`, `s${i}`, `p${i}`);
      x.reserve(`r${i}b`, `s${i}`, `p${i}`);
    }
    expect(x.physicalUsed).toBe(8);
    expect(() => x.reserve("r9", "s9", "p9")).toThrow("E_LIMIT");
    expect(x.releaseProven("r1")).toBe(true);
    expect(x.releaseProven("r1")).toBe(false);
    expect(x.physicalUsed).toBe(7);
  });
  it("bounded per-terminal staging, one round-robin chunk per pass, reserved control/replay credits", () => {
    let now = 0;
    const x = new TerminalLimits(config, () => now),
      seen: string[] = [];
    for (let i = 0; i < 8; i++)
      for (let k = 0; k < 8; k++)
        expect(
          x.enqueue(`t${i}`, 8192, () => {
            seen.push(`t${i}`);
            return true;
          }),
        ).toBe(true);
    expect(x.enqueue("t0", 1, () => true)).toBe(false);
    expect(x.queuedBytes()).toBe(8 * 65536);
    x.drain();
    expect(seen).toEqual(Array.from({ length: 8 }, (_, i) => `t${i}`));
    for (let i = 0; i < 8; i++) x.drain();
    expect(seen.length * 8192).toBeLessThanOrEqual(L.hubRateBytes - L.replayRateBytes);
    now = 1000;
    const n = seen.length;
    x.drain();
    expect(seen.length - n).toBeGreaterThan(0);
    for (let i = 0; i < 8; i++) x.beginReplay(`a${i}`);
    expect(() => x.beginReplay("extra")).toThrow("E_REPLAY_BUSY");
    x.endReplay("a0");
    now = 2000;
    expect(x.beginReplay("extra")).toBe(16384);
    x.drop("t0");
    expect(x.queuedBytes()).toBeLessThanOrEqual(7 * 65536);
  });
});
