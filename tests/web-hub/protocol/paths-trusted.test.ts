/**
 * P5a tests (vue-plan.md v2.1 §2.1/§5.2) for `paths.ts`'s three P5a additions:
 * `packageUiDistDir`, `webHubUiDir`, and `checkTrustedEntry`.
 * `tests/web-hub/protocol/paths.test.ts` (existing) and
 * `paths-private-dir.test.ts` (existing) keep covering everything else in
 * this frozen-face-adjacent file; this file only exercises the P5a additions.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod as realChmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkTrustedEntry, packageUiDistDir, webHubUiDir } from "../../../src/web-hub/protocol/paths.js";

const isRoot = process.getuid?.() === 0;
const realUid = process.getuid?.() ?? 0;

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "webhub-ui-trust-")));
}

describe("packageUiDistDir", () => {
  it("resolves to <packageRoot>/dist/web-hub-ui/", () => {
    const dir = packageUiDistDir();
    expect(dir.endsWith("/dist/web-hub-ui/")).toBe(true);
    // paths.ts lives at src/web-hub/protocol/paths.ts — three levels up is the package root.
    expect(dir).not.toContain("src/web-hub");
  });

  it("is stable across calls (pure, no fs access)", () => {
    expect(packageUiDistDir()).toBe(packageUiDistDir());
  });
});

describe("webHubUiDir", () => {
  it("is <home>/.pi/agent/web-hub-ui", () => {
    expect(webHubUiDir("/home/u")).toBe("/home/u/.pi/agent/web-hub-ui");
  });

  it("shares the .pi/agent parent with webHubStateDir's home", async () => {
    const { webHubStateDir } = await import("../../../src/web-hub/protocol/paths.js");
    const home = "/home/example";
    expect(webHubUiDir(home).startsWith(`${home}/.pi/agent`)).toBe(true);
    expect(webHubStateDir(home).startsWith(`${home}/.pi/agent`)).toBe(true);
  });
});

describe("checkTrustedEntry", () => {
  it("accepts a 0755 directory owned by us (public content, not secret)", async () => {
    const dir = join(tmp(), "pub");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const id = await checkTrustedEntry(dir, "dir");
    expect(id.ino).toBeGreaterThan(0);
  });

  it("accepts a 0644 file owned by us", async () => {
    const dir = tmp();
    const file = join(dir, "index.html");
    writeFileSync(file, "hi", { mode: 0o644 });
    await realChmod(file, 0o644);
    await expect(checkTrustedEntry(file, "file")).resolves.toBeDefined();
  });

  it("rejects a symlinked directory even if the target is trustworthy", async () => {
    const dir = tmp();
    const target = join(dir, "real");
    mkdirSync(target, { mode: 0o755 });
    const link = join(dir, "link");
    symlinkSync(target, link);
    await expect(checkTrustedEntry(link, "dir")).rejects.toMatchObject({ reason: "symlink" });
  });

  it("rejects a symlinked file", async () => {
    const dir = tmp();
    const target = join(dir, "real.js");
    writeFileSync(target, "x");
    const link = join(dir, "link.js");
    symlinkSync(target, link);
    await expect(checkTrustedEntry(link, "file")).rejects.toMatchObject({ reason: "symlink" });
  });

  it("rejects a file when a directory was expected, and vice versa", async () => {
    const dir = tmp();
    const file = join(dir, "f");
    writeFileSync(file, "x");
    await expect(checkTrustedEntry(file, "dir")).rejects.toMatchObject({ reason: "not-directory" });
    await expect(checkTrustedEntry(dir, "file")).rejects.toMatchObject({ reason: "not-directory" });
  });

  it("rejects group-writable (0775) even though owner-writable is fine", async () => {
    const dir = join(tmp(), "gw");
    mkdirSync(dir, { mode: 0o775 });
    chmodSync(dir, 0o775);
    await expect(checkTrustedEntry(dir, "dir")).rejects.toMatchObject({ reason: "mode" });
  });

  it("rejects world-writable (0757)", async () => {
    const dir = join(tmp(), "ow");
    mkdirSync(dir, { mode: 0o757 });
    chmodSync(dir, 0o757);
    await expect(checkTrustedEntry(dir, "dir")).rejects.toMatchObject({ reason: "mode" });
  });

  it("accepts world-readable+executable (0755) and group-readable (0754) — only the write bits matter", async () => {
    const dir1 = join(tmp(), "r1");
    mkdirSync(dir1, { mode: 0o755 });
    chmodSync(dir1, 0o755);
    await expect(checkTrustedEntry(dir1, "dir")).resolves.toBeDefined();
    const dir2 = join(tmp(), "r2");
    mkdirSync(dir2, { mode: 0o754 });
    chmodSync(dir2, 0o754);
    await expect(checkTrustedEntry(dir2, "dir")).resolves.toBeDefined();
  });

  it("rejects a mismatched owner (injected getuid, no root needed)", async () => {
    const dir = tmp();
    await expect(checkTrustedEntry(dir, "dir", { getuid: () => realUid + 1 })).rejects.toMatchObject({
      reason: "owner-mismatch",
    });
  });

  it("allows uid 0 (root-owned) regardless of the caller's own uid — system-wide installs stay usable (injected lstat)", async () => {
    const dir = tmp();
    const fakeStat = {
      isSymbolicLink: () => false,
      isDirectory: () => true,
      isFile: () => false,
      uid: 0,
      mode: 0o755,
      dev: 1,
      ino: 42,
    } as unknown as Awaited<ReturnType<typeof import("node:fs/promises").lstat>>;
    const id = await checkTrustedEntry(dir, "dir", { lstat: async () => fakeStat, getuid: () => realUid + 1 });
    expect(id).toEqual({ dev: 1, ino: 42 });
  });

  it.skipIf(!isRoot)("real root-owned entry is trusted from a non-root caller's perspective (root only)", async () => {
    const dir = tmp();
    chownSync(dir, 0, 0);
    try {
      await expect(checkTrustedEntry(dir, "dir", { getuid: () => 1 })).resolves.toBeDefined();
    } finally {
      chownSync(dir, realUid, process.getgid?.() ?? 0);
    }
  });

  it("never calls chmod/mkdir — check-only, unlike ensurePrivateDir", async () => {
    const dir = join(tmp(), "untouched");
    mkdirSync(dir, { mode: 0o755 });
    let chmodCalls = 0;
    const chmod: typeof realChmod = async (...args) => {
      chmodCalls++;
      return realChmod(...(args as Parameters<typeof realChmod>));
    };
    await checkTrustedEntry(dir, "dir", { chmod });
    expect(chmodCalls).toBe(0);
  });

  it("propagates a missing entry as PrivateDirError('io')", async () => {
    const dir = join(tmp(), "missing");
    await expect(checkTrustedEntry(dir, "dir")).rejects.toMatchObject({ reason: "io" });
  });
});
