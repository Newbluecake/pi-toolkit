/**
 * web-hub-spawn plan §SP7 acceptance (arch v2 §4.2/#12): the launcher version chain.
 *
 * `checkLauncherAsync` — the init-time check — over every failure reason
 * ({missing, not-file, unverifiable, incompatible}) plus the happy path's fingerprint capture;
 * `recheckLauncherSync` — the per-spawn sync re-check — over drift in each stat field;
 * `compareDotVersions`/`versionInRange`/`findPiPackageVersion` pin the pure helpers.
 */
import { describe, expect, it } from "vitest";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import {
  checkLauncherAsync,
  compareDotVersions,
  findPiPackageVersion,
  recheckLauncherSync,
  type LauncherFs,
} from "../../../../src/web-hub/hub/spawn/launcher-check.js";

interface FakeStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isFile(): boolean;
}

function st(over: Partial<FakeStat> = {}): FakeStat {
  return {
    dev: over.dev ?? 1,
    ino: over.ino ?? 10,
    size: over.size ?? 100,
    mtimeMs: over.mtimeMs ?? 1_000,
    isFile: over.isFile ?? (() => true),
  };
}

interface FakeFsOpts {
  /** realpath results keyed by input (missing key ⇒ resolve to input). */
  realpaths?: Record<string, string>;
  /** stat results keyed by path (missing key ⇒ default `st()`). */
  stats?: Record<string, FakeStat>;
  statSyncStats?: Record<string, FakeStat>;
  /** package.json contents keyed by path. */
  files?: Record<string, string>;
  statSyncThrows?: boolean;
}

function fakeFs(opts: FakeFsOpts = {}): LauncherFs {
  return {
    realpath: async (p) => opts.realpaths?.[p] ?? p,
    stat: async (p) => opts.stats?.[p] ?? st(),
    readFileSync: (p, o) => {
      const f = opts.files?.[p];
      if (f === undefined) {
        const err = new Error("ENOENT");
        if (typeof err === "object" && err !== null && "code" in err) err.code = "ENOENT";
        throw err;
      }
      return f;
    },
    statSync: (p) => {
      if (opts.statSyncThrows) throw new Error("gone");
      return opts.statSyncStats?.[p] ?? opts.stats?.[p] ?? st();
    },
  };
}

const LAUNCHER: readonly [string, string] = ["/usr/bin/node", "/repo/cli.js"];
const D = (): ReturnType<typeof createReqDeadline> => createReqDeadline(Date.now, 1_000);

function pkg(version: string): string {
  return JSON.stringify({ name: "@earendil-works/pi-coding-agent", version });
}

describe("compareDotVersions / versionInRange (pure helpers)", () => {
  it("orders dot versions and treats missing parts as 0", () => {
    expect(compareDotVersions("1.0.2", "1.0.2")).toBe(0);
    expect(compareDotVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareDotVersions("1.1", "1.0.9")).toBeGreaterThan(0);
    expect(compareDotVersions("0.87.5", "1.0.0")).toBeLessThan(0);
  });
});

describe("checkLauncherAsync (arch §4.2 init check)", () => {
  it("undefined / relative paths ⇒ missing", async () => {
    expect((await checkLauncherAsync(undefined, D(), fakeFs())).ok).toBe(false);
    const rel = (await checkLauncherAsync(["node", "/repo/cli.js"], D(), fakeFs())) as {
      ok: false;
      reason: string;
    };
    expect(rel.reason).toBe("missing");
  });

  it("realpath ENOENT ⇒ missing; stat not a regular file ⇒ not-file", async () => {
    const fs = fakeFs({ realpaths: {} });
    // make realpath throw ENOENT for the interpreter
    const throwing: LauncherFs = {
      ...fs,
      realpath: async () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      },
    };
    const miss = (await checkLauncherAsync(LAUNCHER, D(), throwing)) as { ok: false; reason: string };
    expect(miss.reason).toBe("missing");

    const notFile = (await checkLauncherAsync(
      LAUNCHER,
      D(),
      fakeFs({ stats: { "/repo/cli.js": st({ isFile: () => false }) } }),
    )) as { ok: false; reason: string };
    expect(notFile.reason).toBe("not-file");
  });

  it("entry without .js/.mjs/.cjs ⇒ unverifiable", async () => {
    const res = (await checkLauncherAsync(["/usr/bin/node", "/repo/cli.bin"], D(), fakeFs())) as {
      ok: false;
      reason: string;
    };
    expect(res.reason).toBe("unverifiable");
  });

  it("no pi package.json within 5 levels ⇒ unverifiable", async () => {
    const fs = fakeFs({ files: { "/other/package.json": pkg("1.0.2") } });
    const res = (await checkLauncherAsync(LAUNCHER, D(), fs)) as { ok: false; reason: string; detail?: string };
    expect(res.reason).toBe("unverifiable");
    expect(res.detail).toContain("pi-coding-agent");
  });

  it("version outside SUPPORTED_PI_RANGE ⇒ incompatible", async () => {
    for (const v of ["0.99.0", "1.1.0", "2.0.0"]) {
      const fs = fakeFs({ files: { "/repo/package.json": pkg(v) } });
      const res = (await checkLauncherAsync(LAUNCHER, D(), fs)) as { ok: false; reason: string; detail?: string };
      expect(res.reason).toBe("incompatible");
      expect(res.detail).toContain(v);
    }
  });

  it("happy path captures BOTH fingerprints and the version", async () => {
    const fs = fakeFs({
      stats: { "/usr/bin/node": st({ ino: 10, size: 50_000_000, mtimeMs: 5 }), "/repo/cli.js": st({ ino: 11 }) },
      files: { "/repo/package.json": pkg("1.0.5") },
    });
    const res = await checkLauncherAsync(LAUNCHER, D(), fs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe("1.0.5");
    expect(res.fp[0]).toMatchObject({ realpath: "/usr/bin/node", ino: 10, size: 50_000_000, mtimeMs: 5 });
    expect(res.fp[1]).toMatchObject({ realpath: "/repo/cli.js", ino: 11 });
  });

  it("SHARED 1s total budget: a slow fs serializes into unverifiable at ~1s, not 2s (review re-run #4)", async () => {
    const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
    const slowFs: LauncherFs = {
      realpath: async (p) => {
        await delay(250);
        return p;
      },
      stat: async () => {
        await delay(300); // per-step cap alone (500ms) would let this pass at ~1.1s total
        return st();
      },
      readFileSync: (p) => {
        if (p === "/repo/package.json") return pkg("1.0.5");
        throw new Error("ENOENT");
      },
      statSync: () => {
        throw new Error("unused");
      },
    };
    const t0 = Date.now();
    const res = await checkLauncherAsync(LAUNCHER, D(), slowFs);
    const elapsed = Date.now() - t0;
    expect(res).toMatchObject({ ok: false, reason: "unverifiable" });
    expect(elapsed).toBeGreaterThanOrEqual(900); // it really ran until the pool drained
    expect(elapsed).toBeLessThan(1_400); // capped by the shared budget (250+250+300 = 1.05s uncapped)
  });

  it("the package.json walk-up is budget-checked too (review re-run #4)", async () => {
    const fs = fakeFs({ files: { "/repo/package.json": pkg("1.0.5") } });
    // budget exhausted before the first level ⇒ unverifiable, no file read at all
    expect(findPiPackageVersion("/repo/cli.js", fs, () => 0)).toBeUndefined();
    expect(findPiPackageVersion("/repo/cli.js", fs, () => 1)).toBe("1.0.5");
  });

  it("deadline exhausted ⇒ unverifiable (fail closed, restart re-runs the check)", async () => {
    const hung: LauncherFs = {
      ...fakeFs(),
      realpath: (p) => new Promise((resolve) => setTimeout(() => resolve(p), 5_000)),
    };
    const res = (await checkLauncherAsync(LAUNCHER, createReqDeadline(Date.now, 20), hung)) as {
      ok: false;
      reason: string;
    };
    expect(res.reason).toBe("unverifiable");
  });
});

describe("findPiPackageVersion (≤5-level walk-up)", () => {
  const fs = fakeFs({
    files: {
      "/repo/dist/node_modules/@earendil-works/pi-coding-agent/package.json": pkg("1.0.9"),
    },
  });
  it("finds the package from a nested entry", () => {
    expect(findPiPackageVersion("/repo/dist/node_modules/@earendil-works/pi-coding-agent/cli.js", fs)).toBe("1.0.9");
  });
  it("misses beyond 5 levels", () => {
    expect(
      findPiPackageVersion("/a/b/c/d/e/f/g/node_modules/@earendil-works/pi-coding-agent/cli.js", fs),
    ).toBeUndefined();
  });
});

describe("recheckLauncherSync (per-spawn sync re-check)", () => {
  const fpBase = [
    { realpath: "/usr/bin/node", dev: 1, ino: 10, size: 100, mtimeMs: 1_000 },
    { realpath: "/repo/cli.js", dev: 1, ino: 11, size: 200, mtimeMs: 2_000 },
  ] as const;
  const matchingFs = fakeFs({
    statSyncStats: { "/repo/cli.js": st({ ino: 11, size: 200, mtimeMs: 2_000 }) },
  });

  it("exact match ⇒ true", () => {
    expect(recheckLauncherSync(fpBase, matchingFs)).toBe(true);
  });

  it("drift in any of dev/ino/size/mtimeMs ⇒ false", () => {
    for (const key of ["dev", "ino", "size", "mtimeMs"] as const) {
      const drifted = fakeFs({ statSyncStats: { "/repo/cli.js": st({ [key]: 42 }) } });
      expect(recheckLauncherSync(fpBase, drifted)).toBe(false);
    }
  });

  it("statSync throwing (launcher deleted mid-flight) ⇒ false", () => {
    expect(recheckLauncherSync(fpBase, fakeFs({ statSyncThrows: true }))).toBe(false);
  });
});
