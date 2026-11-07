/**
 * A (hub self-version) — `src/web-hub/hub/self-version.ts`.
 *
 * The unit matrix is deliberately exhaustive about the FALLBACK boundary: the launcher's pair
 * must survive byte-identically whenever the hub cannot prove a version of its own (missing /
 * unreadable / malformed package.json, non-string / empty / non-semver `version`), because that
 * is the pre-change behaviour every existing hub test and every `hub.json` consumer still
 * expects. `buildId` gets its own rows: same version ⇒ the launcher's commit survives; a
 * different version ⇒ `${version}@unknown` (never a build id that pairs one version with another
 * checkout's commit).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isSafeHubVersion } from "../../../src/web-hub/hub/ui-root.js";
import {
  buildIdVersion,
  isSafeSelfVersion,
  resolveSelfVersion,
  resolveSelfVersionHere,
  UNKNOWN_BUILD_COMMIT,
} from "../../../src/web-hub/hub/self-version.js";
import { packageRootDir } from "../../../src/web-hub/protocol/paths.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pkgRootWith(body: unknown | string): string {
  const dir = mkdtempSync(join(tmpdir(), "pwh-selfver-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return dir;
}

const LAUNCHER = { launcherVersion: "0.10.1", launcherBuildId: "0.10.1@abc1234" } as const;

describe("buildIdVersion", () => {
  it("splits <version>@<commit>[dirty] and rejects shapes without a version half", () => {
    expect(buildIdVersion("0.10.2@abc1234")).toBe("0.10.2");
    expect(buildIdVersion("0.10.2@abc1234*")).toBe("0.10.2");
    expect(buildIdVersion("0.10.2@nogit")).toBe("0.10.2");
    expect(buildIdVersion("@abc")).toBeUndefined();
    expect(buildIdVersion("nohalf")).toBeUndefined();
    expect(buildIdVersion("")).toBeUndefined();
  });
});

describe("resolveSelfVersion — the package version wins", () => {
  it("reads package.json and overrides a stale launcher version", () => {
    const pkgRoot = pkgRootWith({ name: "pi-toolkit", version: "0.10.2" });
    const r = resolveSelfVersion({ ...LAUNCHER, pkgRoot });
    expect(r).toEqual({ version: "0.10.2", buildId: "0.10.2@unknown", source: "package" });
    // no `fallback` key at all on the happy path (a field, not an undefined slot: `exactOptionalPropertyTypes`)
    expect("fallback" in r).toBe(false);
  });

  it("keeps the launcher's commit when the versions agree (byte-identical hub.json identity)", () => {
    const pkgRoot = pkgRootWith({ version: "0.10.2" });
    const r = resolveSelfVersion({
      launcherVersion: "0.10.2",
      launcherBuildId: "0.10.2@abc1234*", // dirty suffix survives verbatim
      pkgRoot,
    });
    expect(r).toEqual({ version: "0.10.2", buildId: "0.10.2@abc1234*", source: "package" });
  });

  it("drops a launcher build id whose version half merely PREFIXES the self version", () => {
    const pkgRoot = pkgRootWith({ version: "0.10.20" });
    const r = resolveSelfVersion({ launcherVersion: "0.10.2", launcherBuildId: "0.10.2@abc1234", pkgRoot });
    expect(r.version).toBe("0.10.20");
    expect(r.buildId).toBe(`0.10.20@${UNKNOWN_BUILD_COMMIT}`);
  });

  it("ignores unrelated package.json fields and a leading `v`", () => {
    // `isSafeHubVersion` accepts a `v` prefix through no path of its own — an npm version never
    // has one, so it must fall back rather than mint a weird path segment.
    const pkgRoot = pkgRootWith({ name: "x", version: "v1.2.3", dependencies: { a: "1" } });
    const r = resolveSelfVersion({ ...LAUNCHER, pkgRoot });
    expect(r.source).toBe("launcher");
    expect(r.fallback).toBe("not-semver");
  });

  it("accepts a prerelease / build-metadata version (semver-shaped, path-safe)", () => {
    for (const version of ["1.0.0-rc.1", "1.0.0+build.5"]) {
      const pkgRoot = pkgRootWith({ version });
      const r = resolveSelfVersion({ ...LAUNCHER, pkgRoot });
      expect(r.source).toBe("package");
      expect(r.version).toBe(version);
    }
  });
});

describe("resolveSelfVersion — fallbacks keep the launcher pair intact", () => {
  const cases: Array<[string, () => string, string]> = [
    [
      "missing package.json",
      () => {
        const dir = mkdtempSync(join(tmpdir(), "pwh-selfver-empty-"));
        dirs.push(dir);
        return dir;
      },
      "missing",
    ],
    ["unreadable (reader throws EACCES)", () => pkgRootWith({ version: "9.9.9" }), "unreadable"],
    ["malformed JSON", () => pkgRootWith("{not json"), "malformed"],
    ["JSON null", () => pkgRootWith("null"), "not-semver"],
    ["version missing", () => pkgRootWith({ name: "x" }), "not-semver"],
    ["version not a string", () => pkgRootWith({ version: 102 }), "not-semver"],
    ["version empty", () => pkgRootWith({ version: "" }), "not-semver"],
    ["version not semver", () => pkgRootWith({ version: "1.2" }), "not-semver"],
    ["version contains ..", () => pkgRootWith({ version: "1.2.3..4" }), "not-semver"],
    ["version would escape a path", () => pkgRootWith({ version: "../../etc" }), "not-semver"],
  ];

  it.each(cases)("%s ⇒ launcher version + buildId, tagged", (_name, make, reason) => {
    const pkgRoot = make();
    const readText =
      reason === "unreadable"
        ? (): string => {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
        : undefined;
    const r = resolveSelfVersion({ ...LAUNCHER, pkgRoot, ...(readText === undefined ? {} : { readText }) });
    expect(r).toEqual({
      version: LAUNCHER.launcherVersion,
      buildId: LAUNCHER.launcherBuildId,
      source: "launcher",
      fallback: reason,
    });
  });

  it("never throws on a throwing reader, whatever the error shape", () => {
    for (const thrown of ["boom", undefined, null, { weird: true }]) {
      const r = resolveSelfVersion({
        ...LAUNCHER,
        pkgRoot: "/nonexistent",
        readText: () => {
          throw thrown;
        },
      });
      expect(r).toMatchObject({ source: "launcher", version: LAUNCHER.launcherVersion });
    }
  });

  it("falls back to a launcher build id that carries no version half rather than inventing one", () => {
    const pkgRoot = pkgRootWith({ version: "0.10.2" });
    const r = resolveSelfVersion({ launcherVersion: "0.10.1", launcherBuildId: "legaсy-nohalf", pkgRoot });
    expect(r).toEqual({ version: "0.10.2", buildId: `0.10.2@${UNKNOWN_BUILD_COMMIT}`, source: "package" });
  });
});

describe("resolveSelfVersionHere (production entry)", () => {
  it("resolves against THIS package and agrees with its own package.json", () => {
    const r = resolveSelfVersionHere("0.0.0-stale", "0.0.0-stale@deadbeef");
    // The repo checkout always has a semver package.json, so the self read must win.
    expect(r.source).toBe("package");
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageRootDir()).not.toBe("");
    expect(r.buildId.startsWith(`${r.version}@`)).toBe(true);
  });
});

describe("isSafeSelfVersion ≡ ui-root's isSafeHubVersion (parity pin)", () => {
  it.each([
    "0.10.2",
    "1.0.0-rc.1",
    "1.0.0+build.5",
    "1.2",
    "v1.2.3",
    "1.2.3..4",
    "../../etc",
    "",
    "1.2.3 ",
    "1.2.3\n",
    "01.2.3",
    "1.2.3-",
    "1.2.3/x",
    "1.2.3-a..b",
  ])("%j", (v) => {
    expect(isSafeSelfVersion(v)).toBe(isSafeHubVersion(v));
  });
});
