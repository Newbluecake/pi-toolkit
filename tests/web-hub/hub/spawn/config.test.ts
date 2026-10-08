/**
 * web-hub-spawn plan §SP2 验收：`parseHubSpawnConfig`（hub 侧防御性重校验，形状同
 * `lan-config.ts`）正反例 + `probePlatform`（arch §7.1 三项探针）的注入失败矩阵。
 *
 * 直接 import `hub/spawn/config.js`（不是 `hub/main.ts`——后者模块顶层 `void main()` 会
 * 在测试进程里 `process.exit`，见 `hub-lan-config.test.ts` 头注释）。
 */
import { describe, expect, it } from "vitest";
import { parseHubSpawnConfig, probePlatform } from "../../../../src/web-hub/hub/spawn/config.js";
import type { HubSpawnConfig } from "../../../../src/web-hub/protocol/spawn.js";

const valid: HubSpawnConfig = {
  roots: [],
  maxProcesses: 4,
  maxPerPrincipal: 2,
  ratePerMinute: 3,
  maxLifetimeMinutes: 720,
  registerTimeoutS: 30,
  lan: "off",
};

describe("parseHubSpawnConfig (web-hub-spawn §SP2, hub-side strict re-validation)", () => {
  it("accepts a minimal valid config (empty roots) and returns it verbatim", () => {
    expect(parseHubSpawnConfig(valid)).toEqual({ ok: true, spawn: valid });
  });

  it("accepts /- and ~-prefixed roots entries", () => {
    const cfg = { ...valid, roots: ["/srv/work", "~/proj"] };
    const r = parseHubSpawnConfig(cfg);
    expect(r).toEqual({ ok: true, spawn: cfg });
  });

  it("accepts boundary values of every numeric range (arch §6.2)", () => {
    const r = parseHubSpawnConfig({
      ...valid,
      maxProcesses: 16,
      maxPerPrincipal: 1,
      ratePerMinute: 30,
      maxLifetimeMinutes: 10_080,
      registerTimeoutS: 120,
      lan: "roots",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    for (const raw of [undefined, null, "x", 42, true, [], ["/ok"]]) {
      const r = parseHubSpawnConfig(raw);
      expect(r.ok, String(JSON.stringify(raw))).toBe(false);
      if (!r.ok) expect(r.detail).toContain("not an object");
    }
  });

  it("rejects roots that is not a string array", () => {
    for (const roots of ["/srv", 7, ["/ok", 42], { 0: "/ok" }]) {
      const r = parseHubSpawnConfig({ ...valid, roots });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toContain("roots");
    }
  });

  it("rejects individual bad roots entries with the index in the detail", () => {
    const rel = parseHubSpawnConfig({ ...valid, roots: ["~/ok", "relative"] });
    expect(rel.ok).toBe(false);
    if (!rel.ok) expect(rel.detail).toContain("roots[1]");

    const nul = parseHubSpawnConfig({ ...valid, roots: ["/a\0b"] });
    expect(nul.ok).toBe(false);
    if (!nul.ok) expect(nul.detail).toContain("NUL");

    const long = parseHubSpawnConfig({ ...valid, roots: ["/" + "x".repeat(4096)] }); // 4097 bytes
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.detail).toContain("4096");
  });

  it("rejects more than 16 roots entries", () => {
    const roots = Array.from({ length: 17 }, (_, i) => `/r${String(i)}`);
    const r = parseHubSpawnConfig({ ...valid, roots });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("max 16");
  });

  it("rejects every out-of-range / non-integer / non-number numeric field, naming the field", () => {
    const cases: Array<[keyof HubSpawnConfig, unknown, string]> = [
      ["maxProcesses", 0, "maxProcesses=0"],
      ["maxProcesses", 17, "maxProcesses=17"],
      ["maxProcesses", 2.5, "maxProcesses=2.5"],
      ["maxPerPrincipal", 0, "maxPerPrincipal=0"],
      ["maxPerPrincipal", 99, "maxPerPrincipal=99"],
      ["ratePerMinute", 0, "ratePerMinute=0"],
      ["ratePerMinute", 31, "ratePerMinute=31"],
      ["maxLifetimeMinutes", 9, "maxLifetimeMinutes=9"],
      ["maxLifetimeMinutes", 10_081, "maxLifetimeMinutes=10081"],
      ["registerTimeoutS", 9, "registerTimeoutS=9"],
      ["registerTimeoutS", 121, "registerTimeoutS=121"],
      ["maxProcesses", "4", "maxProcesses=4"], // string form: hub never clamps/coerces
    ];
    for (const [key, value, detailPrefix] of cases) {
      const r = parseHubSpawnConfig({ ...valid, [key]: value });
      expect(r.ok, `${String(key)}=${String(value)}`).toBe(false);
      if (!r.ok) expect(r.detail).toContain(detailPrefix);
    }
    // unlike the settings layer there is NO clamping: 0 stays rejected, not clamped to 1
    const zero = parseHubSpawnConfig({ ...valid, maxProcesses: 0 });
    expect(zero.ok).toBe(false);
  });

  it("web-hub-spawn-restore D18: restore is an optional bool — absent stays absent (⇒ false), present round-trips, non-bool rejects the block", () => {
    const absent = parseHubSpawnConfig(valid);
    expect(absent.ok && absent.spawn.restore).toBeUndefined();
    expect(absent.ok && absent.spawn.restore === true).toBe(false);
    for (const v of [true, false]) {
      const r = parseHubSpawnConfig({ ...valid, restore: v });
      expect(r).toEqual({ ok: true, spawn: { ...valid, restore: v } });
    }
    for (const bad of ["true", 1, null, {}]) {
      const r = parseHubSpawnConfig({ ...valid, restore: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.detail).toMatch(/^restore=/);
    }
  });

  it("session-history §3.7 (P-cfg): history is an optional bool — absent stays absent (⇒ false), present round-trips, non-bool rejects the block", () => {
    const absent = parseHubSpawnConfig(valid);
    expect(absent.ok && absent.spawn.history).toBeUndefined();
    expect(absent.ok && absent.spawn.history === true).toBe(false);
    for (const v of [true, false]) {
      const r = parseHubSpawnConfig({ ...valid, history: v });
      expect(r).toEqual({ ok: true, spawn: { ...valid, history: v } });
    }
    for (const bad of ["true", 1, null, {}]) {
      const r = parseHubSpawnConfig({ ...valid, history: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.detail).toMatch(/^history=/);
    }
  });

  it("dispatcher ruling (session-history P-cfg): unknown keys — seam names included — are ignored, never read or forwarded", () => {
    // Rejecting unknown keys would let a newer agent disable spawn on an older hub; instead pin
    // that the hub-internal seam/injection names can never leak from input into the parsed config.
    const r = parseHubSpawnConfig({
      ...valid,
      history: true,
      historyProcFs: { readDir: "evil" },
      wrapHistory: (): undefined => undefined,
      procFs: 42,
      spawnSeams: "no",
    });
    expect(r).toEqual({ ok: true, spawn: { ...valid, history: true } });
    const keys = Object.keys(r.ok ? r.spawn : {});
    for (const seam of ["historyProcFs", "wrapHistory", "procFs", "spawnSeams"]) {
      expect(keys, seam).not.toContain(seam);
    }
  });

  it("rejects a bad lan value", () => {
    for (const lan of ["OFF", "any", 42, undefined, null]) {
      const r = parseHubSpawnConfig({ ...valid, lan });
      expect(r.ok, String(lan)).toBe(false);
      if (!r.ok) expect(r.detail).toContain("off|known|roots");
    }
  });

  it("round-trips the exact seven-field HubSpawnConfig shape (no extra keys, enabled never appears)", () => {
    const r = parseHubSpawnConfig({ ...valid, roots: ["~"], enabled: true });
    expect(r).toEqual({
      ok: true,
      spawn: {
        roots: ["~"],
        maxProcesses: 4,
        maxPerPrincipal: 2,
        ratePerMinute: 3,
        maxLifetimeMinutes: 720,
        registerTimeoutS: 30,
        lan: "off",
      },
    });
  });
});

// ── probePlatform (arch §7.1: three procfs probes, fail closed) ────────────

/** A `/proc/self/stat`-shaped line whose starttime (field 22) = 999888777 and pgrp (field 5) = 42. */
const FAKE_STAT = "4242 (hub (worker)) S 1 4242 42 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 999888777 123456";
const FAKE_BOOT_ID = "1a2b3c4d-0000-4000-8000-5e6f7a8b9c0d\n";

/** Fully-injected deps that make every probe pass without touching the real fs. */
function greenDeps(): Parameters<typeof probePlatform>[0] {
  return {
    platform: "linux",
    readFileSync: (path: string) => {
      if (path === "/proc/self/stat") return FAKE_STAT;
      if (path === "/proc/sys/kernel/random/boot_id") return FAKE_BOOT_ID;
      throw new Error(`unexpected read: ${path}`);
    },
    openSync: () => 9,
    statSync: () => ({ isDirectory: () => true }),
    closeSync: () => undefined,
  };
}

describe("probePlatform (arch §7.1 — Linux + procfs, fail closed)", () => {
  it("passes with every probe green (full injection)", () => {
    expect(probePlatform(greenDeps())).toEqual({ ok: true });
  });

  it("closes the /proc/self/fd descriptor on success and on stat failure", () => {
    const closed: number[] = [];
    const base = greenDeps();
    const withClose = { ...base, closeSync: (fd: number) => closed.push(fd) };
    expect(probePlatform(withClose)).toEqual({ ok: true });
    expect(closed).toEqual([9]);

    closed.length = 0;
    const statFails = {
      ...withClose,
      statSync: () => {
        throw new Error("ENOENT");
      },
    };
    expect(probePlatform(statFails).ok).toBe(false);
    expect(closed).toEqual([9]); // finally-close ran even on the failing path
  });

  it("fails on non-Linux platforms (darwin / win32 / freebsd)", () => {
    for (const platform of ["darwin", "win32", "freebsd"]) {
      const r = probePlatform({ ...greenDeps(), platform });
      expect(r.ok, platform).toBe(false);
      if (!r.ok) expect(r.detail).toContain(`platform=${platform}`);
    }
  });

  it("fails when /proc/self/stat is unreadable or unparseable", () => {
    const unreadable = {
      ...greenDeps(),
      readFileSync: () => {
        throw new Error("ENOENT");
      },
    };
    const unparseable = { ...greenDeps(), readFileSync: () => "no closing paren" };
    for (const deps of [unreadable, unparseable]) {
      const r = probePlatform(deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toContain("/proc/self/stat");
    }
    // starttime parseable but pgrp missing (truncated after field 3) also fails
    const truncated = {
      ...greenDeps(),
      readFileSync: (path: string) => (path === "/proc/self/stat" ? "1 (x) R 2 3" : FAKE_BOOT_ID),
    };
    expect(probePlatform(truncated).ok).toBe(false);
  });

  it("fails when boot_id is missing/unreadable or empty", () => {
    const throws = {
      ...greenDeps(),
      readFileSync: (path: string) => {
        if (path === "/proc/sys/kernel/random/boot_id") throw new Error("ENOENT");
        return FAKE_STAT;
      },
    };
    const rThrow = probePlatform(throws);
    expect(rThrow.ok).toBe(false);
    if (!rThrow.ok) expect(rThrow.detail).toContain("boot_id");

    const empty = {
      ...greenDeps(),
      readFileSync: (path: string) => (path === "/proc/sys/kernel/random/boot_id" ? "  \n" : FAKE_STAT),
    };
    const rEmpty = probePlatform(empty);
    expect(rEmpty.ok).toBe(false);
    if (!rEmpty.ok) expect(rEmpty.detail).toContain("boot_id: empty");
  });

  it("fails when /proc/self/fd cannot be opened (O_DIRECTORY) — SP3's pin mechanism unavailable", () => {
    const r = probePlatform({
      ...greenDeps(),
      openSync: () => {
        throw new Error("EACCES");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("/proc/self/fd");
  });

  it("fails when the /proc/self/fd/<fd> path does not stat as a directory", () => {
    const r = probePlatform({ ...greenDeps(), statSync: () => ({ isDirectory: () => false }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("not a directory");
  });

  it("real-machine check: on this Linux host the un-injected probe succeeds", () => {
    if (process.platform !== "linux") return; // matrix listed per-platform, arch §7.1
    expect(probePlatform()).toEqual({ ok: true });
  });
});
