import { describe, expect, it } from "vitest";
import { aggregateTop, readTopUnits, scanTop } from "../../src/sysload/top.js";
import { IoLedger } from "../../src/sysload/io-ledger.js";
import { projectTop } from "../../src/sysload/wire.js";
import { parseLoadTopWire } from "../../src/web-hub/ui/src/logic/load.js";

describe("sysload top", () => {
  it("aggregates both columns by comm and matches pid lifetime", () => {
    const previous = { mono: 0, processes: new Map([[10, { starttime: 1, cpuTicks: 100 }]]) };
    const snapshot = aggregateTop(
      [
        { pid: 10, comm: "node", utime: 150, stime: 0, starttime: 1, rssPages: 10 },
        { pid: 11, comm: "node", utime: 200, stime: 0, starttime: 2, rssPages: 20, lifetimeSeconds: 2 },
        { pid: 12, comm: "java", utime: 1, stime: 0, starttime: 1, rssPages: 100 },
      ],
      previous,
      1_000,
      { userHz: 100, pageSize: 4096 },
    );
    expect(snapshot.byCpu[0]?.comm).toBe("node");
    expect(snapshot.byRss[0]?.comm).toBe("java");
    expect(snapshot.byCpu[0]?.count).toBe(2);
    expect(snapshot.byCpu[0]?.pids).toHaveLength(2);
  });

  it("uses lifetime average on pid reuse with a mismatched starttime", () => {
    const snapshot = aggregateTop(
      [{ pid: 10, comm: "node", utime: 100, stime: 0, starttime: 99, rssPages: 4, lifetimeSeconds: 2 }],
      { mono: 0, processes: new Map([[10, { starttime: 1, cpuTicks: 1 }]]) },
      1_000,
      { userHz: 100, pageSize: 4096 },
    );
    expect(snapshot.byCpu[0]).toMatchObject({ avg: true, cpuPct: 50 });
  });

  it("projects unavailable units as omitted n/a fields, never JSON null", () => {
    const snapshot = aggregateTop(
      [{ pid: 10, comm: "node", utime: 100, stime: 0, starttime: 1, rssPages: 4 }],
      undefined,
      0,
      undefined,
    );
    const projected = projectTop(snapshot);
    expect(projected?.byCpu[0]).not.toHaveProperty("cpuPct");
    expect(projected?.byCpu[0]).not.toHaveProperty("rssBytes");
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain(":null");
    expect(parseLoadTopWire(JSON.parse(encoded))).toEqual(projected);
  });

  it("keeps the second global IO slot available throughout a stuck scan", async () => {
    let releaseRead: (() => void) | undefined;
    const stuckRead = new Promise<{ readonly name: string } | null>((resolve) => {
      releaseRead = () => resolve(null);
    });
    const ledger = new IoLedger({ active: new Map(), capacity: 2 });
    const scan = scanTop(ledger, {
      deadlineMs: 5,
      now: () => 0,
      units: { userHz: 100, pageSize: 4096 },
      openProc: async () =>
        ({
          read: async () => stuckRead,
          close: async () => undefined,
        }) as never,
      readFile: async () => "0 0",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledger.tryAcquire("statfs:other")).toBeDefined();
    releaseRead?.();
    await scan;
  });

  it("is single-flight while an enumeration read is pending", async () => {
    let releaseRead: (() => void) | undefined;
    const stuckRead = new Promise<{ readonly name: string } | null>((resolve) => {
      releaseRead = () => resolve(null);
    });
    const ledger = new IoLedger({ active: new Map(), capacity: 2 });
    const first = scanTop(ledger, {
      deadlineMs: 5_000,
      now: () => 0,
      openProc: async () => ({ read: async () => stuckRead, close: async () => undefined }) as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await scanTop(ledger, { now: () => 0 });
    expect(second.partial).toBe(true);
    expect(second.byCpu).toEqual([]);
    releaseRead?.();
    await first;
  });

  it("reads authoritative auxv units and rejects incomplete data", () => {
    const bytes = new Uint8Array(16 * 3);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 17n, true);
    view.setBigUint64(8, 100n, true);
    view.setBigUint64(16, 6n, true);
    view.setBigUint64(24, 4096n, true);
    expect(readTopUnits(bytes)).toEqual({ userHz: 100, pageSize: 4096 });
    expect(readTopUnits(new Uint8Array(16))).toBeUndefined();
  });
});
