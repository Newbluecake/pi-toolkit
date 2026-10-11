import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { parseLoadSettings } from "../../src/config/settings.js";
import { createLoadActivation, escalated } from "../../src/sysload/activation.js";
import { IoLedger } from "../../src/sysload/io-ledger.js";
import { aggregateTop } from "../../src/sysload/top.js";

describe("sysload activation and IO ledger", () => {
  it("treats every rise into warn/crit as an escalation that refreshes top", () => {
    expect(escalated("ok", "warn")).toBe(true);
    expect(escalated("ok", "crit")).toBe(true);
    expect(escalated("warn", "crit")).toBe(true);
    expect(escalated("unknown", "warn")).toBe(true);
    expect(escalated("unknown", "ok")).toBe(false);
    expect(escalated("crit", "warn")).toBe(false);
    expect(escalated("warn", "warn")).toBe(false);
    expect(escalated("crit", "unknown")).toBe(false);
  });

  it("does not start in print/json and dispose is idempotent", () => {
    const clock = new FakeClock();
    const activation = createLoadActivation({ settings: parseLoadSettings({}), clock, mono: () => 0, wall: () => 0 });
    activation.start({ mode: "print" });
    expect(clock.pendingTimers).toBe(0);
    activation.dispose();
    activation.dispose();
    expect(activation.port().verdict().gating).toBe(false);
  });

  it("carries the previous top table across refreshes", async () => {
    let monoNow = 0;
    const previousOptions: unknown[] = [];
    const snapshots = [
      aggregateTop([{ pid: 7, comm: "node", utime: 10, stime: 0, starttime: 3, rssPages: 1 }], undefined, 0, {
        userHz: 100,
        pageSize: 4096,
      }),
      aggregateTop([{ pid: 7, comm: "node", utime: 20, stime: 0, starttime: 3, rssPages: 1 }], undefined, 0, {
        userHz: 100,
        pageSize: 4096,
      }),
    ];
    let call = 0;
    const activation = createLoadActivation({
      settings: parseLoadSettings({}),
      mono: () => monoNow,
      wall: () => monoNow,
      scanTop: async (_ledger, options) => {
        previousOptions.push(options.previous);
        options.onPrevious?.({ mono: monoNow, processes: new Map([[7, { starttime: 3, cpuTicks: 10 }]]) });
        return snapshots[call++] ?? snapshots[1]!;
      },
    });
    activation.port().refreshTop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    monoNow = 30_000;
    activation.port().refreshTop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previousOptions[0]).toBeUndefined();
    expect(previousOptions[1]).toMatchObject({ processes: new Map([[7, { starttime: 3, cpuTicks: 10 }]]) });
  });

  it("keeps one lease per key and releases only explicitly", async () => {
    const ledger = new IoLedger({ active: new Map(), capacity: 2 });
    const first = ledger.tryAcquire("a");
    expect(first).toBeDefined();
    expect(ledger.tryAcquire("a")).toBeUndefined();
    const pending = new Promise<void>((resolve) => setTimeout(resolve, 5));
    const lease = ledger.tryAcquire("b");
    expect(lease).toBeDefined();
    expect(ledger.tryAcquire("c")).toBeUndefined();
    await pending;
    first?.release();
    expect(ledger.tryAcquire("c")).toBeDefined();
    lease?.release();
  });
});
