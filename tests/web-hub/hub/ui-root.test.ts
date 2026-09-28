/**
 * P5a tests (vue-plan.md v2.1 §2.1/§4.2/§5.2): `verifyUiRoot` / `resolveUiRoot` /
 * `buildUiCandidates` / `createUiRootService` in `src/web-hub/hub/ui-root.ts`.
 * Real tmp directories + injected `UiRootFsDeps` (never a from-scratch fake fs).
 * This module is NOT wired into any server yet — the last `describe` block
 * asserts that lazily via a source scan.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat as realLstat, open as realOpen, realpath as realRealpath, utimes as realUtimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildUiCandidates,
  createUiRootService,
  isSafeHubVersion,
  resolveUiRoot,
  verifyUiRoot,
  type UiCandidatePlan,
  type UiRootExpect,
} from "../../../src/web-hub/hub/ui-root.js";

const realUid = process.getuid?.() ?? 0;
const EXPECT: UiRootExpect = { version: "1.2.3", protoMajor: 1 };

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "webhub-ui-root-")));
}

/**
 * A root directory candidate whose *parent* is trustworthy (owned by us, not
 * group/other-writable) — unlike the raw system tmpdir (`/tmp` is `1777`,
 * world-writable), which would legitimately fail step #2's parent-trust
 * check for reasons having nothing to do with what a given test wants to
 * exercise. Mirrors real usage: `dist/` (package candidate) or
 * `web-hub-ui/` (external candidate) is always a directory *we* created.
 */
function rootDir(): string {
  const base = tmp();
  const parent = join(base, "dist");
  mkdirSync(parent, { mode: 0o755 });
  chmodSync(parent, 0o755);
  return join(parent, "web-hub-ui");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Races `p` against a timer so a regression to a blocking `open()` fails the test instead of hanging the run. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: exceeded ${ms}ms (possible hang)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

const DEFAULT_INDEX = "<!doctype html><html><body>index</body></html>";
const DEFAULT_ASSET = "console.log('asset')";

/** Writes a valid root (index.html + assets/index-<hash>.js + build-info.json) into `dir`. */
function writeValidRoot(
  dir: string,
  opts?: {
    readonly version?: string;
    readonly protoMajor?: number;
    readonly commit?: string;
    readonly files?: readonly FixtureFile[];
    readonly extraTopLevelFile?: string; // written to disk, NOT in build-info.json
    readonly extraAssetFile?: string; // written under assets/, NOT in build-info.json
  },
): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  mkdirSync(join(dir, "assets"), { recursive: true, mode: 0o755 });
  const files: FixtureFile[] = opts?.files ?? [
    { path: "index.html", content: DEFAULT_INDEX },
    { path: "assets/index-abcd1234.js", content: DEFAULT_ASSET },
  ];
  const manifestEntries = files.map((f) => {
    writeFileSync(join(dir, f.path), f.content, { mode: 0o644 });
    return { path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256(Buffer.from(f.content)) };
  });
  if (opts?.extraTopLevelFile !== undefined) {
    writeFileSync(join(dir, opts.extraTopLevelFile), "extra", { mode: 0o644 });
  }
  if (opts?.extraAssetFile !== undefined) {
    writeFileSync(join(dir, "assets", opts.extraAssetFile), "extra-asset", { mode: 0o644 });
  }
  const info = {
    v: 1,
    version: opts?.version ?? EXPECT.version,
    proto: { major: opts?.protoMajor ?? EXPECT.protoMajor },
    builtAt: "2026-01-01T00:00:00.000Z",
    commit: opts?.commit ?? "abcdefabcdef",
    files: manifestEntries,
  };
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(info), { mode: 0o644 });
}

/** Writes a root whose `build-info.json` is raw JSON text (bypassing our own manifest builder). */
function writeRawBuildInfo(dir: string, json: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(json), { mode: 0o644 });
}

describe("isSafeHubVersion", () => {
  it("accepts plain semver and semver with pre-release/build metadata", () => {
    expect(isSafeHubVersion("1.2.3")).toBe(true);
    expect(isSafeHubVersion("0.2.1")).toBe(true);
    expect(isSafeHubVersion("1.2.3-beta.1")).toBe(true);
    expect(isSafeHubVersion("1.2.3+build5")).toBe(true);
  });

  it("rejects non-semver and anything containing '..'", () => {
    expect(isSafeHubVersion("../../etc/passwd")).toBe(false);
    expect(isSafeHubVersion("1.2.3-..")).toBe(false);
    expect(isSafeHubVersion("v1.2.3")).toBe(false);
    expect(isSafeHubVersion("")).toBe(false);
    expect(isSafeHubVersion("1.2")).toBe(false);
  });
});

describe("verifyUiRoot: happy path", () => {
  it("verifies a well-formed root and caches every manifest file's bytes + hash", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.root.info.version).toBe("1.2.3");
    expect(outcome.root.files.size).toBe(2);
    const index = outcome.root.files.get("index.html");
    expect(index?.bytes.toString("utf8")).toBe(DEFAULT_INDEX);
    expect(index?.sha256).toBe(sha256(Buffer.from(DEFAULT_INDEX)));
  });

  it("accepts a root owned by uid 0 from a non-root caller (injected getuid; owner check is uid ∈ {self, 0})", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    // Trust checks read ownership two ways: `lstat` (directories, via `checkTrustedEntry`) and
    // `open(...).stat()` (files, via the O_NOFOLLOW-opened fstat) — fake uid 0 on both paths.
    const fakeLstat: typeof realLstat = async (p, ...rest) => {
      const st = await realLstat(p, ...(rest as []));
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 0 });
    };
    const fakeOpen: typeof realOpen = async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      const originalStat = handle.stat.bind(handle);
      return Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, {
        stat: async (...statArgs: Parameters<typeof originalStat>) => {
          const st = await originalStat(...statArgs);
          return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 0 });
        },
      });
    };
    const outcome = await verifyUiRoot(dir, EXPECT, {
      lstat: fakeLstat,
      open: fakeOpen,
      getuid: () => realUid + 1,
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("verifyUiRoot: traversal-shaped manifest paths (raw build-info.json, bypassing our own builder)", () => {
  it.each([
    ["..", "assets/../../etc/passwd"],
    ["absolute", "/etc/passwd"],
    ["backslash", "assets\\index.js"],
    ["multi-level", "assets/a/b.js"],
    ["percent-encoded ..", "assets/%2e%2e/index.js"],
  ])("rejects manifest path shape: %s", async (_label, badPath) => {
    const dir = rootDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeRawBuildInfo(dir, {
      v: 1,
      version: EXPECT.version,
      proto: { major: EXPECT.protoMajor },
      builtAt: "2026-01-01T00:00:00.000Z",
      commit: "abcdefabcdef",
      files: [
        { path: "index.html", bytes: 1, sha256: "0".repeat(64) },
        { path: badPath, bytes: 1, sha256: "1".repeat(64) },
      ],
    });
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("build-info"); // rejected by isAllowedUiPath inside parseUiBuildInfo
  });
});

describe("verifyUiRoot: symlinks", () => {
  it("rejects when the root itself is a symlink", async () => {
    const base = tmp();
    const real = join(base, "real");
    writeValidRoot(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    const outcome = await verifyUiRoot(link, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "symlink" });
  });

  it("rejects when a subdirectory (assets/) is a symlink", async () => {
    const dir = rootDir();
    mkdirSync(dir, { mode: 0o755 });
    const realAssets = join(tmp(), "real-assets");
    mkdirSync(realAssets, { mode: 0o755 });
    symlinkSync(realAssets, join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), DEFAULT_INDEX, { mode: 0o644 });
    writeFileSync(
      join(dir, "build-info.json"),
      JSON.stringify({
        v: 1,
        version: EXPECT.version,
        proto: { major: EXPECT.protoMajor },
        builtAt: "2026-01-01T00:00:00.000Z",
        commit: "abcdefabcdef",
        files: [
          { path: "index.html", bytes: Buffer.byteLength(DEFAULT_INDEX), sha256: sha256(Buffer.from(DEFAULT_INDEX)) },
        ],
      }),
    );
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "symlink" });
  });

  it("rejects when build-info.json is a symlink", async () => {
    const dir = rootDir();
    mkdirSync(dir, { mode: 0o755 });
    const realInfo = join(tmp(), "real-info.json");
    writeFileSync(realInfo, "{}");
    symlinkSync(realInfo, join(dir, "build-info.json"));
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "symlink" });
  });

  it("rejects when a manifest-listed file is a symlink pointing inside the root", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const assetPath = join(dir, "assets/index-abcd1234.js");
    const real = readFileSync(assetPath);
    rmSync(assetPath);
    const decoy = join(dir, "assets", "decoy.js");
    writeFileSync(decoy, real);
    symlinkSync(decoy, assetPath);
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "symlink" });
  });

  it("rejects when a manifest-listed file is a symlink pointing outside the root", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const assetPath = join(dir, "assets/index-abcd1234.js");
    rmSync(assetPath);
    const outsideDir = tmp();
    const outsideFile = join(outsideDir, "evil.js");
    writeFileSync(outsideFile, DEFAULT_ASSET);
    symlinkSync(outsideFile, assetPath);
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "symlink" });
  });
});

describe("verifyUiRoot: untrusted owner/mode (private-dir style checks)", () => {
  it("rejects a group-writable root directory", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    chmodSync(dir, 0o775);
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "mode" });
  });

  it("rejects a world-writable assets/ subdirectory", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    chmodSync(join(dir, "assets"), 0o757);
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "mode" });
  });

  it("rejects build-info.json owned by a different, non-root uid (injected getuid)", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const outcome = await verifyUiRoot(dir, EXPECT, { getuid: () => realUid + 1 });
    expect(outcome).toMatchObject({ ok: false, reason: "owner-mismatch" });
  });

  it("rejects a group/world-writable manifest-listed asset file (P1 review fix: per-file mode check is no longer skipped)", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    chmodSync(join(dir, "assets/index-abcd1234.js"), 0o664);
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "mode" });
  });

  it("rejects a manifest-listed asset file owned by a different uid even when build-info.json's own owner matches (P1 review fix: per-file owner check is no longer skipped)", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const assetPath = join(dir, "assets/index-abcd1234.js");
    // Only fakes the *asset* file's reported owner — build-info.json goes through real `open`/`stat`
    // untouched, so a pass here can only be explained by the asset file's own check having run.
    const fakeOpen: typeof realOpen = async (...args) => {
      const [p] = args as Parameters<typeof realOpen>;
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      if (p !== assetPath) return handle;
      const originalStat = handle.stat.bind(handle);
      return Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, {
        stat: async (...statArgs: Parameters<typeof originalStat>) => {
          const st = await originalStat(...statArgs);
          return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: realUid + 1 });
        },
      });
    };
    const outcome = await verifyUiRoot(dir, EXPECT, { open: fakeOpen });
    expect(outcome).toMatchObject({ ok: false, reason: "owner-mismatch" });
  });
});

describe("verifyUiRoot: FIFO in place of a trust-checked file (P2 review fix: must reject promptly, never hang)", () => {
  it("rejects (and never hangs on) build-info.json being a FIFO instead of a regular file", async () => {
    if (process.platform === "win32") return; // FIFOs are POSIX-only
    const dir = rootDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const fifoPath = join(dir, "build-info.json");
    execFileSync("mkfifo", [fifoPath], { timeout: 5000 });
    const outcome = await withTimeout(verifyUiRoot(dir, EXPECT), 3000, "verifyUiRoot(build-info.json FIFO)");
    expect(outcome).toMatchObject({ ok: false, reason: "build-info" });
  });

  it("rejects (and never hangs on) a manifest-listed asset file being a FIFO instead of a regular file", async () => {
    if (process.platform === "win32") return; // FIFOs are POSIX-only
    const dir = rootDir();
    writeValidRoot(dir);
    const assetPath = join(dir, "assets/index-abcd1234.js");
    rmSync(assetPath);
    execFileSync("mkfifo", [assetPath], { timeout: 5000 });
    const outcome = await withTimeout(verifyUiRoot(dir, EXPECT), 3000, "verifyUiRoot(asset FIFO)");
    expect(outcome).toMatchObject({ ok: false, reason: "not-file" });
  });
});

describe("verifyUiRoot: version / protocol mismatch", () => {
  it("rejects a version mismatch", async () => {
    const dir = rootDir();
    writeValidRoot(dir, { version: "9.9.9" });
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "version-mismatch" });
  });

  it("rejects a proto major mismatch", async () => {
    const dir = rootDir();
    writeValidRoot(dir, { protoMajor: 99 });
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "proto-mismatch" });
  });
});

describe("verifyUiRoot: manifest/content integrity", () => {
  it("rejects a hash mismatch (on-disk content edited after the manifest was written)", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    writeFileSync(join(dir, "index.html"), `${DEFAULT_INDEX}<!--tampered-->`, { mode: 0o644 });
    const outcome = await verifyUiRoot(dir, EXPECT);
    // size changed too, but our check order tries size first — either is an integrity rejection.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(["hash", "size"]).toContain(outcome.reason);
  });

  it("rejects when on-disk content differs but stays the same byte length (size passes, hash catches it)", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const same = "x".repeat(DEFAULT_ASSET.length);
    writeFileSync(join(dir, "assets/index-abcd1234.js"), same, { mode: 0o644 });
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "hash" });
  });

  it("rejects a manifest-listed file that does not exist on disk", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    rmSync(join(dir, "assets/index-abcd1234.js"));
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "not-file" });
  });

  it("does not fail the candidate for an extra file present on disk but absent from the manifest — recorded, not fatal", async () => {
    const dir = rootDir();
    writeValidRoot(dir, { extraAssetFile: "orphan-9999.js" });
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.root.extraFiles).toContain("assets/orphan-9999.js");
    expect(outcome.root.files.has("assets/orphan-9999.js")).toBe(false);
  });

  it("rejects a manifest/parse-time budget overrun as its own 'too-large' reason (not the generic 'build-info')", async () => {
    const dir = rootDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const files = Array.from({ length: 65 }, (_, i) => ({
      path: `assets/f${i}-aaaaaaaa.js`,
      bytes: 1,
      sha256: "0".repeat(64),
    }));
    writeRawBuildInfo(dir, {
      v: 1,
      version: EXPECT.version,
      proto: { major: EXPECT.protoMajor },
      builtAt: "2026-01-01T00:00:00.000Z",
      commit: "abcdefabcdef",
      files,
    });
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("rejects a candidate whose realpath escapes the root (injected realpath — defends a TOCTOU window even though symlinks are already blocked earlier)", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const outsideDir = tmp();
    const outcome = await verifyUiRoot(dir, EXPECT, {
      realpath: async (p, ...rest) => {
        const s = String(p);
        if (s.endsWith("assets/index-abcd1234.js")) return join(outsideDir, "index-abcd1234.js");
        return realRealpath(p, ...(rest as []));
      },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "escape" });
  });
});

describe("resolveUiRoot: timeout", () => {
  it("bails with reason 'timeout' when a candidate's check hangs past the deadline", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const plans: UiCandidatePlan[] = [{ ok: true, spec: { kind: "package", dir } }];
    const hangingLstat: typeof realLstat = () => new Promise(() => {}); // never resolves
    const result = await resolveUiRoot(plans, EXPECT, { lstat: hangingLstat }, { timeoutMs: 30 });
    expect(result.status.state).toBe("unbuilt");
    if (result.status.state !== "unbuilt") throw new Error("unreachable");
    expect(result.status.candidates).toEqual([{ kind: "package", dir, reason: "timeout" }]);
  });
});

describe("resolveUiRoot: candidate fallback (§2.1 'first to succeed wins')", () => {
  it("falls back to external when package is broken and external is good", async () => {
    const brokenPackage = join(tmp(), "missing-package-dist");
    const goodExternal = rootDir();
    writeValidRoot(goodExternal);
    const plans: UiCandidatePlan[] = [
      { ok: true, spec: { kind: "package", dir: brokenPackage } },
      { ok: true, spec: { kind: "external", dir: goodExternal } },
    ];
    const result = await resolveUiRoot(plans, EXPECT);
    expect(result.status.state).toBe("ok");
    if (result.status.state !== "ok") throw new Error("unreachable");
    expect(result.status.source).toBe("external");
    expect(result.status.candidates).toHaveLength(1);
    expect(result.status.candidates[0]).toMatchObject({ kind: "package", dir: brokenPackage, reason: "missing" });
    expect(result.root?.kind).toBe("external");
  });

  it("reports unbuilt with two rejection reasons when both candidates are broken", async () => {
    const brokenPackage = join(tmp(), "missing-package-dist");
    const brokenExternal = join(tmp(), "missing-external");
    const plans: UiCandidatePlan[] = [
      { ok: true, spec: { kind: "package", dir: brokenPackage } },
      { ok: true, spec: { kind: "external", dir: brokenExternal } },
    ];
    const result = await resolveUiRoot(plans, EXPECT);
    expect(result.status.state).toBe("unbuilt");
    if (result.status.state !== "unbuilt") throw new Error("unreachable");
    expect(result.status.candidates).toHaveLength(2);
    expect(result.status.candidates.map((c) => c.kind)).toEqual(["package", "external"]);
    expect(result.status.candidates.every((c) => c.reason === "missing")).toBe(true);
  });
});

describe("buildUiCandidates", () => {
  it("builds package + external in fixed order for a safe version", () => {
    const plans = buildUiCandidates({ home: "/home/u", hubVersion: "1.2.3", packageDir: "/pkg/dist" });
    expect(plans).toEqual([
      { ok: true, spec: { kind: "package", dir: "/pkg/dist" } },
      { ok: true, spec: { kind: "external", dir: "/home/u/.pi/agent/web-hub-ui/1.2.3/" } },
    ]);
  });

  it("pre-rejects the external candidate as version-unsafe without touching disk, but keeps package", () => {
    const plans = buildUiCandidates({ home: "/home/u", hubVersion: "../../etc/passwd", packageDir: "/pkg/dist" });
    expect(plans[0]).toEqual({ ok: true, spec: { kind: "package", dir: "/pkg/dist" } });
    expect(plans[1]?.ok).toBe(false);
    if (plans[1]?.ok !== false) throw new Error("unreachable");
    expect(plans[1].result.reason).toBe("version-unsafe");
    expect(plans[1].result.dir).toBe("/home/u/.pi/agent/web-hub-ui");
  });
});

describe("TOCTOU: verify caches bytes; a later on-disk edit that doesn't touch build-info.json is invisible", () => {
  it("verifyUiRoot's own returned root keeps serving the bytes it read, even after the file is edited on disk", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const outcome = await verifyUiRoot(dir, EXPECT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const cachedBefore = outcome.root.files.get("index.html")?.bytes.toString("utf8");
    // Mutate on-disk content without touching build-info.json.
    writeFileSync(join(dir, "index.html"), "<html>mutated-after-verify</html>", { mode: 0o644 });
    // The already-resolved root's cached buffer is unaffected — nothing re-reads disk.
    expect(outcome.root.files.get("index.html")?.bytes.toString("utf8")).toBe(cachedBefore);
    expect(outcome.root.files.get("index.html")?.bytes.toString("utf8")).not.toBe("<html>mutated-after-verify</html>");
  });
});

describe("createUiRootService: 换代 (redeploy) detection via build-info.json fingerprint", () => {
  it("re-resolves on a '/' request ≥1s after build-info.json changed; a resource request never probes at all", async () => {
    const dir = rootDir();
    // Same version throughout (a redeploy keeps serving the same hub version, e.g. a rebuilt
    // commit) — only `commit` differs, so a version-mismatch rejection can't mask the probe result.
    writeValidRoot(dir, { version: EXPECT.version, commit: "aaaaaaaaaaaa" });
    // Force a distinguishable mtime/ctime for the fingerprint (real fs mtime resolution can
    // coincide with the very next synchronous write below, which would make this test flaky —
    // `utimes` deterministically pins a value and, as a metadata change, also bumps ctime).
    const buildInfoPath = join(dir, "build-info.json");
    await realUtimes(buildInfoPath, new Date(1_000_000), new Date(1_000_000));
    const plans: UiCandidatePlan[] = [{ ok: true, spec: { kind: "package", dir } }];
    let clock = 0;
    const svc = createUiRootService(plans, EXPECT, undefined, {
      probeThrottleMs: 1000,
      now: () => clock,
    });
    const first = await svc.resolve();
    expect(first.status.state).toBe("ok");
    expect(first.status.state === "ok" && first.status.commit).toBe("aaaaaaaaaaaa");

    // Redeploy — same dir, fresh build-info.json (new fingerprint), different commit.
    writeValidRoot(dir, { version: EXPECT.version, commit: "bbbbbbbbbbbb" });
    await realUtimes(buildInfoPath, new Date(2_000_000), new Date(2_000_000));

    // Immediately after (same millisecond): throttled, still serving the old snapshot.
    const stillOld = await svc.maybeRefresh("/");
    expect(stillOld.status.state === "ok" && stillOld.status.commit).toBe("aaaaaaaaaaaa");

    // A resource request never probes, no matter how much time passes.
    clock += 5000;
    const resourceReq = await svc.maybeRefresh("/assets/index-abcd1234.js");
    expect(resourceReq.status.state === "ok" && resourceReq.status.commit).toBe("aaaaaaaaaaaa");

    // Now a '/' request ≥1s after the change: probes, notices the fingerprint changed, re-resolves.
    const refreshed = await svc.maybeRefresh("/");
    expect(refreshed.status.state === "ok" && refreshed.status.commit).toBe("bbbbbbbbbbbb");
  });

  it("does not re-resolve when nothing changed, even past the throttle window", async () => {
    const dir = rootDir();
    writeValidRoot(dir);
    const plans: UiCandidatePlan[] = [{ ok: true, spec: { kind: "package", dir } }];
    let clock = 0;
    const svc = createUiRootService(plans, EXPECT, undefined, { probeThrottleMs: 1000, now: () => clock });
    const first = await svc.resolve();
    expect(first.status.state).toBe("ok");
    clock += 5000;
    const a = await svc.maybeRefresh("/");
    const b = await svc.maybeRefresh("/index.html");
    expect(a.status).toEqual(first.status);
    expect(b.status).toEqual(first.status);
  });
});

describe("ui-root.ts is wired into production code (vue-plan.md v2.1 §2.1, §5.2 — P5b's atomic switch)", () => {
  it("exactly the P5b files that were granted the switch import ui-root.js — nothing else", async () => {
    const { readdirSync, readFileSync: readFileSyncFn, statSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const srcRoot = joinPath(import.meta.dirname, "..", "..", "..", "src");

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const p = joinPath(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (entry.endsWith(".ts")) out.push(p);
      }
      return out;
    }

    // P5b's own independent-file list (vue-plan.md v2.1 §5.2) — the only production files
    // allowed to import `ui-root.js` once the atomic switch landed.
    const EXPECTED_IMPORTERS = new Set(
      [
        joinPath("hub", "static.ts"),
        joinPath("hub", "http.ts"),
        joinPath("hub", "hub-json.ts"),
        joinPath("hub", "ports.ts"),
        joinPath("agent", "index.ts"),
        joinPath("agent", "ui-status.ts"),
      ].map((rel) => joinPath(srcRoot, "web-hub", rel)),
    );

    const files = walk(srcRoot);
    const importers: string[] = [];
    for (const file of files) {
      if (file.endsWith(joinPath("hub", "ui-root.ts"))) continue;
      if (file.endsWith(joinPath("hub", "unbuilt.ts"))) continue; // unbuilt.ts imports a *type* from ui-root.ts
      const text = readFileSyncFn(file, "utf8");
      if (/from\s+["']\.{0,2}\/?.*ui-root\.js["']/.test(text)) importers.push(file);
    }
    expect(new Set(importers)).toEqual(EXPECTED_IMPORTERS);
  });
});
