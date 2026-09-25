import { describe, expect, it } from "vitest";
import { chownSync, chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOCKET_PATH_MAX_BYTES,
  ensurePrivateDir,
  resolveHubPaths,
  webHubStateDir,
} from "../../../src/web-hub/protocol/paths.js";

const SUFFIX = "/.pi/agent/web-hub/hub.sock";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "webhub-paths-"));
}

describe("resolveHubPaths", () => {
  it("uses stateDir for a short HOME", () => {
    const p = resolveHubPaths({ home: "/home/u", uid: 1000 });
    expect(p).toEqual({
      stateDir: "/home/u/.pi/agent/web-hub",
      socketPath: `/home/u${SUFFIX}`,
      hubJson: "/home/u/.pi/agent/web-hub/hub.json",
      tokenFile: "/home/u/.pi/agent/web-hub/token",
      logFile: "/home/u/.pi/agent/web-hub/hub.log",
      startLock: "/home/u/.pi/agent/web-hub/start.lock",
    });
  });

  it("keeps a socket path of exactly SOCKET_PATH_MAX_BYTES", () => {
    const home = `/${"h".repeat(SOCKET_PATH_MAX_BYTES - SUFFIX.length - 1)}`;
    expect(Buffer.byteLength(home + SUFFIX)).toBe(SOCKET_PATH_MAX_BYTES);
    expect(resolveHubPaths({ home, uid: 1000 }).socketPath).toBe(home + SUFFIX);
  });

  it("falls back to XDG_RUNTIME_DIR when the primary socket path exceeds the budget", () => {
    const home = `/${"h".repeat(SOCKET_PATH_MAX_BYTES - SUFFIX.length)}`;
    expect(Buffer.byteLength(home + SUFFIX)).toBe(SOCKET_PATH_MAX_BYTES + 1);
    const p = resolveHubPaths({ home, uid: 1000, xdgRuntimeDir: "/run/user/1000" });
    expect(p.socketPath).toBe("/run/user/1000/pi-webhub.sock");
    // files never move
    expect(p.stateDir).toBe(webHubStateDir(home));
    expect(p.hubJson).toBe(`${webHubStateDir(home)}/hub.json`);
  });

  it("falls back to /tmp/pi-webhub-<uid>/hub.sock when XDG is missing", () => {
    const home = `/${"h".repeat(80)}`;
    expect(resolveHubPaths({ home, uid: 1234 }).socketPath).toBe("/tmp/pi-webhub-1234/hub.sock");
  });

  it("skips an oversized XDG candidate too", () => {
    const home = `/${"h".repeat(80)}`;
    const xdg = `/${"x".repeat(100)}`;
    const p = resolveHubPaths({ home, uid: 1000, xdgRuntimeDir: xdg });
    expect(Buffer.byteLength(`${xdg}/pi-webhub.sock`)).toBeGreaterThan(SOCKET_PATH_MAX_BYTES);
    expect(p.socketPath).toBe("/tmp/pi-webhub-1000/hub.sock");
  });

  it("counts bytes, not chars (multi-byte home)", () => {
    // 40 chars → 120 bytes > 100
    const home = `/${"你".repeat(40)}`;
    expect(resolveHubPaths({ home, uid: 1000, xdgRuntimeDir: "/run/user/0" }).socketPath).toBe(
      "/run/user/0/pi-webhub.sock",
    );
  });

  it("webHubStateDir is <home>/.pi/agent/web-hub", () => {
    expect(webHubStateDir("/home/u")).toBe("/home/u/.pi/agent/web-hub");
  });
});

describe("ensurePrivateDir", () => {
  const isRoot = process.getuid?.() === 0;

  it("creates a nested dir with mode 0700", () => {
    const dir = join(tmp(), "a/b/c");
    ensurePrivateDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("repairs an existing 0755 dir to 0700", () => {
    const dir = join(tmp(), "d");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("is idempotent for an already-private dir", () => {
    const dir = join(tmp(), "e");
    ensurePrivateDir(dir);
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("throws when the path exists as a file", () => {
    const file = join(tmp(), "f");
    writeFileSync(file, "x");
    expect(() => ensurePrivateDir(file)).toThrow(/not a directory/);
  });

  it.skipIf(!isRoot)("throws when the dir is owned by another uid", () => {
    const dir = join(tmp(), "g");
    ensurePrivateDir(dir);
    chownSync(dir, 1, 1);
    try {
      expect(() => ensurePrivateDir(dir)).toThrow(/owned by uid/);
    } finally {
      chownSync(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
    }
  });
});
