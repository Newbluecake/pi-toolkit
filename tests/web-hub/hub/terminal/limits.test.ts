import { describe, it, expect } from "vitest";
import { TerminalLimits, TERMINAL_QUEUE_ITEMS } from "../../../../src/web-hub/hub/terminal/limits.js";
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
  it("bounds zero-raw-byte controls by items AND retained serialized bytes behind exhausted credit", () => {
    const x = new TerminalLimits(config, () => 0);
    for (let i = 0; i < 16; i++) {
      expect(x.enqueue("t", 8192, () => true)).toBe(true);
      x.drain();
    }
    expect(x.enqueue("t", 8192, () => true)).toBe(true);
    x.drain();
    let accepted = 0;
    for (let i = 0; i < 20000; i++) if (x.enqueue("t", 0, () => true, false, { frameBytes: 100 })) accepted++;
    expect(accepted).toBe(TERMINAL_QUEUE_ITEMS - 1);
    expect(x.queuedItems()).toBe(TERMINAL_QUEUE_ITEMS);
    expect(x.queuedFrameBytes()).toBe(8192 + 512 + accepted * 100);
    x.drop("t");
    for (let i = 0; i < 8; i++) expect(x.enqueue("t", 0, () => true, false, { frameBytes: 16384 })).toBe(true);
    expect(x.enqueue("t", 0, () => true, false, { frameBytes: 1 })).toBe(false);
    expect(x.queuedFrameBytes()).toBe(L.nonRingPendingBytes);
    x.drop("t");
    expect(x.queuedItems()).toBe(0);
    expect(x.queuedFrameBytes()).toBe(0);
  });
  it("coalesces only adjacent state for the same writer, preserving latest state and barrier order", () => {
    let now = 0;
    const x = new TerminalLimits(config, () => now);
    const seen: string[] = [];
    for (let i = 0; i < 16; i++) {
      x.enqueue("t", 8192, () => true);
      x.drain();
    }
    x.enqueue("t", 1, () => {
      seen.push("data");
      return true;
    });
    for (let i = 0; i < 20000; i++)
      expect(
        x.enqueue(
          "t",
          0,
          () => {
            seen.push(`state-${i}`);
            return true;
          },
          false,
          { frameBytes: 400, coalesceKey: "writer" },
        ),
      ).toBe(true);
    expect(x.queuedItems()).toBe(2);
    expect(x.queuedFrameBytes()).toBe(513 + 400);
    x.enqueue(
      "t",
      0,
      () => {
        seen.push("gap");
        return true;
      },
      false,
      { frameBytes: 300 },
    );
    x.enqueue(
      "t",
      0,
      () => {
        seen.push("next-state");
        return true;
      },
      false,
      { frameBytes: 400, coalesceKey: "writer" },
    );
    x.enqueue(
      "t",
      0,
      () => {
        seen.push("other-writer");
        return true;
      },
      false,
      { frameBytes: 400, coalesceKey: "other" },
    );
    expect(x.queuedItems()).toBe(5);
    now = 1000;
    for (let i = 0; i < 5; i++) x.drain();
    expect(seen).toEqual(["data", "state-19999", "gap", "next-state", "other-writer"]);
    expect(x.queuedItems()).toBe(0);
    expect(x.queuedFrameBytes()).toBe(0);
  });
});
