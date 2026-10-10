/**
 * `@logic/load.js` (sysload plan docs/dev/sysload/plan.md §7.4/§10 \u5305\u6ce8 P0\u00b7M9, package P4):
 * pure logic behind `LoadPill`/`LoadCard`/`FleetDrawer`'s banner and the `GET /api/load/top`
 * client parser. No DOM, no Vue \u2014 every function is a plain (input, now) \u2192 output mapping.
 */
import { describe, expect, it } from "vitest";
import {
  bannerView,
  elapsedSinceMs,
  fmtBytesShort,
  fmtDurationShort,
  fmtGiB,
  isLoadGateWireLike,
  isLoadStale,
  isLoadWireLike,
  levelRank,
  loadGateFromStatus,
  parseLoadTopWire,
  pct,
  pillView,
  topRowView,
} from "../../../src/web-hub/ui/src/logic/load.js";
import type { LoadGateWire, LoadTopRowWire, LoadWire } from "../../../src/web-hub/protocol/messages.js";

function wire(over: Partial<LoadWire> = {}): LoadWire {
  return {
    v: 1,
    at: 1_000,
    intervalMs: 5_000,
    scope: "host",
    level: "ok",
    thresholds: {
      cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
      mem: { warnAvailPercent: 15, critAvailPercent: 8 },
      disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
    },
    ...over,
  };
}

describe("levelRank", () => {
  it("maps ok/unknown to 0, warn to 1, crit to 3", () => {
    expect(levelRank("ok")).toBe(0);
    expect(levelRank("unknown")).toBe(0);
    expect(levelRank(undefined)).toBe(0);
    expect(levelRank("warn")).toBe(1);
    expect(levelRank("crit")).toBe(3);
  });
});

describe("elapsedSinceMs — receive-time anchor (\u00a710 \u5305\u6ce8 P0\u00b7M9)", () => {
  it("elapsed(now) = (now - receivedAt) + sinceAgoMs", () => {
    expect(elapsedSinceMs(1_000, 2_000, 1_500)).toBe(2_500);
  });
  it("never trusts load.at — only receivedAt and the browser's own now", () => {
    // Same sinceAgoMs, same receivedAt, different "now" ⇒ elapsed grows purely with browser time.
    expect(elapsedSinceMs(0, 0, 0)).toBe(0);
    expect(elapsedSinceMs(0, 0, 10_000)).toBe(10_000);
  });
  it("undefined/non-finite inputs ⇒ undefined (never garbage)", () => {
    expect(elapsedSinceMs(undefined, 100, 1_000)).toBeUndefined();
    expect(elapsedSinceMs(100, undefined, 1_000)).toBeUndefined();
    expect(elapsedSinceMs(100, Number.NaN, 1_000)).toBeUndefined();
    expect(elapsedSinceMs(100, -5, 1_000)).toBeUndefined();
  });
  it("clamps a negative raw elapsed (clock skew) to 0, never negative", () => {
    expect(elapsedSinceMs(10_000, 0, 1_000)).toBe(0);
  });
});

describe("isLoadStale — §7.4 client-receive-time staleness", () => {
  it("fresh within 4×intervalMs is not stale", () => {
    const l = wire({ intervalMs: 5_000 });
    expect(isLoadStale(l, 1_000, 1_000 + 4 * 5_000)).toBe(false);
  });
  it("beyond 4×intervalMs since RECEIPT is stale, regardless of load.at", () => {
    const l = wire({ intervalMs: 5_000, at: 999_999_999 });
    expect(isLoadStale(l, 1_000, 1_000 + 4 * 5_000 + 1)).toBe(true);
  });
  it("undefined load or receivedAt ⇒ stale (fail-open: nothing to show)", () => {
    expect(isLoadStale(undefined, 1_000, 2_000)).toBe(true);
    expect(isLoadStale(wire(), undefined, 2_000)).toBe(true);
  });
});

describe("isLoadWireLike — structural gate for the `load` SSE event", () => {
  it("accepts a well-formed wire", () => {
    expect(isLoadWireLike(wire())).toBe(true);
  });
  it("rejects non-objects, wrong v, bad level, non-host scope, missing thresholds", () => {
    expect(isLoadWireLike(null)).toBe(false);
    expect(isLoadWireLike(42)).toBe(false);
    expect(isLoadWireLike({ ...wire(), v: 2 })).toBe(false);
    expect(isLoadWireLike({ ...wire(), level: "bogus" })).toBe(false);
    expect(isLoadWireLike({ ...wire(), scope: "session" })).toBe(false);
    expect(isLoadWireLike({ ...wire(), thresholds: undefined })).toBe(false);
  });
  it("rejects a non-array disks field but tolerates an absent one", () => {
    expect(isLoadWireLike({ ...wire(), disks: "nope" })).toBe(false);
    expect(isLoadWireLike(wire())).toBe(true);
  });
});

describe("isLoadGateWireLike / loadGateFromStatus", () => {
  const g: LoadGateWire = { gating: true, level: "crit", sinceAgoMs: 1_000, at: 2_000 };
  it("accepts a well-formed gate", () => {
    expect(isLoadGateWireLike(g)).toBe(true);
  });
  it("sinceAgoMs is optional but must be finite when present", () => {
    expect(isLoadGateWireLike({ gating: false, level: "ok", at: 1 })).toBe(true);
    expect(isLoadGateWireLike({ gating: false, level: "ok", at: 1, sinceAgoMs: "x" })).toBe(false);
  });
  it("rejects malformed shapes", () => {
    expect(isLoadGateWireLike(null)).toBe(false);
    expect(isLoadGateWireLike({ gating: "yes", level: "ok", at: 1 })).toBe(false);
    expect(isLoadGateWireLike({ gating: true, level: "nope", at: 1 })).toBe(false);
  });
  it("loadGateFromStatus drops absent/malformed (same discipline as todoFromStatus)", () => {
    expect(loadGateFromStatus(undefined)).toBeUndefined();
    expect(loadGateFromStatus({})).toBeUndefined();
    expect(loadGateFromStatus({ loadGate: "nope" })).toBeUndefined();
    expect(loadGateFromStatus({ loadGate: g })).toEqual(g);
  });
});

describe("fmtGiB / fmtBytesShort — mockup tweak ② (disk free space in GiB)", () => {
  const GIB = 2 ** 30;
  it("rounds to a whole number at ≥10 GiB, one decimal below it", () => {
    expect(fmtGiB(112 * GIB)).toBe("112G");
    expect(fmtGiB(3.14 * GIB)).toBe("3.1G");
    expect(fmtGiB(0)).toBe("0G");
  });
  it("non-finite/negative ⇒ undefined", () => {
    expect(fmtGiB(undefined)).toBeUndefined();
    expect(fmtGiB(Number.NaN)).toBeUndefined();
    expect(fmtGiB(-1)).toBeUndefined();
  });
  it("fmtBytesShort switches to MiB under 1 GiB", () => {
    expect(fmtBytesShort(640 * 2 ** 20)).toBe("640M");
    expect(fmtBytesShort(1.8 * GIB)).toBe("1.8G");
    expect(fmtBytesShort(undefined)).toBe("—");
  });
});

describe("pct", () => {
  it("rounds; non-finite reads as 0 (defensive wire policy)", () => {
    expect(pct(41.6)).toBe(42);
    expect(pct(undefined)).toBe(0);
    expect(pct(Number.NaN)).toBe(0);
  });
});

describe("fmtDurationShort", () => {
  it("seconds under a minute, minutes under an hour, hours+minutes beyond", () => {
    expect(fmtDurationShort(45_000)).toBe("45s");
    expect(fmtDurationShort(120_000)).toBe("2m");
    expect(fmtDurationShort(72 * 60_000)).toBe("1h12m");
    expect(fmtDurationShort(60 * 60_000)).toBe("1h");
  });
});

describe("pillView — §7.4/视觉稿 topbar segments", () => {
  it("builds CPU/MEM/DISK segments with the worst segment's key", () => {
    const l = wire({
      level: "crit",
      cpu: { busyPct: 90, level: "crit", cores: 8 },
      mem: { usedPct: 94, availPct: 6, level: "crit" },
      disks: [
        { label: "~", path: "/home/u", usedPct: 58, freeBytes: 1, totalBytes: 2, level: "warn" },
        { label: "/", path: "/", usedPct: 64, freeBytes: 1, totalBytes: 2, level: "ok" },
      ],
    });
    const v = pillView(l, 1_000, 1_000)!;
    expect(v.level).toBe(3);
    expect(v.segs.map((s) => s.text)).toEqual(["CPU 90%", "MEM 94%", "DISK 58%"]);
    // worst disk among the two (warn > ok) drives the DISK segment's own level/value.
    expect(v.segs.find((s) => s.key === "disk")).toMatchObject({ level: 1, text: "DISK 58%" });
    expect(v.worstKey === "cpu" || v.worstKey === "mem").toBe(true);
  });
  it("stale or absent ⇒ null (no pill)", () => {
    expect(pillView(undefined, 1_000, 2_000)).toBeNull();
    expect(pillView(wire({ intervalMs: 1_000 }), 0, 100_000)).toBeNull();
  });
  it("no metrics at all ⇒ null", () => {
    expect(pillView(wire(), 1_000, 1_000)).toBeNull();
  });
});

describe("bannerView — FleetDrawer crit/warn banner, tweak ③ single-line duration", () => {
  it("gating + crit/warn with a known sinceAgoMs ⇒ a duration annex", () => {
    const v = bannerView({ gating: true, level: "crit", sinceAgoMs: 120_000, at: 1_000 }, 1_000, 1_000);
    expect(v).toEqual({ level: "crit", durationText: "2m" });
  });
  it("not gating, unknown level, or absent ⇒ null", () => {
    expect(bannerView({ gating: false, level: "crit", at: 1 }, 1_000, 1_000)).toBeNull();
    expect(bannerView({ gating: true, level: "unknown", at: 1 }, 1_000, 1_000)).toBeNull();
    expect(bannerView(undefined, 1_000, 1_000)).toBeNull();
  });
  it("gating without a resolvable duration still renders (duration omitted)", () => {
    const v = bannerView({ gating: true, level: "warn", at: 1 }, undefined, 1_000);
    expect(v).toEqual({ level: "warn", durationText: undefined });
  });
});

describe("topRowView — §5.5 comm-aggregated rows (server already aggregates; UI never re-aggregates)", () => {
  const row: LoadTopRowWire = {
    comm: "node",
    count: 3,
    cpuPct: 312,
    rssBytes: 1.8 * 2 ** 30,
    pids: [
      { pid: 100, cpuPct: 200, rssBytes: 900 * 2 ** 20 },
      { pid: 101, cpuPct: 112, rssBytes: 900 * 2 ** 20 },
    ],
  };
  it("cpu kind renders a percent value (can exceed 100%, §5.5)", () => {
    const v = topRowView(row, "cpu");
    expect(v).toMatchObject({ comm: "node", count: 3, valueText: "312%", avg: false });
    expect(v.pids).toEqual([
      { pid: 100, valueText: "200%" },
      { pid: 101, valueText: "112%" },
    ]);
  });
  it("rss kind renders a GiB/MiB value via fmtBytesShort", () => {
    const v = topRowView(row, "rss");
    expect(v.valueText).toBe("1.8G");
    expect(v.pids[0]).toEqual({ pid: 100, valueText: "900M" });
  });
  it("avg flag rides through untouched", () => {
    expect(topRowView({ ...row, avg: true }, "cpu").avg).toBe(true);
  });
});

describe("parseLoadTopWire — GET /api/load/top contract gate (no protocol-level parser exists)", () => {
  const good = {
    at: 1_000,
    byCpu: [{ comm: "node", count: 1, cpuPct: 10, rssBytes: 1, pids: [{ pid: 1, cpuPct: 10, rssBytes: 1 }] }],
    byRss: [],
  };
  it("accepts a well-formed body", () => {
    expect(parseLoadTopWire(good)).toEqual(good);
  });
  it("accepts the optional partial:true flag", () => {
    expect(parseLoadTopWire({ ...good, partial: true })).toEqual({ ...good, partial: true });
  });
  it("rejects malformed bodies wholesale (null on any off-contract shape)", () => {
    expect(parseLoadTopWire(null)).toBeNull();
    expect(parseLoadTopWire({ ...good, at: "x" })).toBeNull();
    expect(parseLoadTopWire({ ...good, byCpu: "x" })).toBeNull();
    expect(parseLoadTopWire({ ...good, byCpu: [{ comm: "node" }] })).toBeNull();
    expect(
      parseLoadTopWire({ ...good, byRss: [{ comm: "x", count: 1, cpuPct: 1, rssBytes: 1, pids: [{ pid: "x" }] }] }),
    ).toBeNull();
  });
});
