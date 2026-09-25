import { describe, expect, it } from "vitest";
import { chownSync, chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod as realChmod } from "node:fs/promises";
import {
  SOCKET_PATH_MAX_BYTES,
  STATE_DIR_POLICY,
  XDG_SOCKET_DIR_POLICY,
  TMP_SOCKET_DIR_POLICY,
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
      socketDir: "/home/u/.pi/agent/web-hub",
      hubJson: "/home/u/.pi/agent/web-hub/hub.json",
      tokenFile: "/home/u/.pi/agent/web-hub/token",
      logFile: "/home/u/.pi/agent/web-hub/hub.log",
      startLock: "/home/u/.pi/agent/web-hub/start.lock",
      dbFile: "/home/u/.pi/agent/web-hub/hub.db",
      policies: { stateDir: STATE_DIR_POLICY, socketDir: STATE_DIR_POLICY },
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
    expect(p.socketDir).toBe("/run/user/1000");
    expect(p.policies.socketDir).toBe(XDG_SOCKET_DIR_POLICY);
  });

  it("falls back to /tmp/pi-webhub-<uid>/hub.sock when XDG is missing", () => {
    const home = `/${"h".repeat(80)}`;
    const p = resolveHubPaths({ home, uid: 1234 });
    expect(p.socketPath).toBe("/tmp/pi-webhub-1234/hub.sock");
    expect(p.socketDir).toBe("/tmp/pi-webhub-1234");
    expect(p.policies.socketDir).toBe(TMP_SOCKET_DIR_POLICY);
  });

  it("skips an oversized XDG candidate too", () => {
    const home = `/${"h".repeat(80)}`;
    const xdg = `/${"x".repeat(100)}`;
    const p = resolveHubPaths({ home, uid: 1000, xdgRuntimeDir: xdg });
    expect(Buffer.byteLength(`${xdg}/pi-webhub.sock`)).toBeGreaterThan(SOCKET_PATH_MAX_BYTES);
    expect(p.socketPath).toBe("/tmp/pi-webhub-1000/hub.sock");
    expect(p.policies.socketDir).toBe(TMP_SOCKET_DIR_POLICY);
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

  it("creates a nested dir with mode 0700", async () => {
    const dir = join(tmp(), "a/b/c");
    await ensurePrivateDir(dir, STATE_DIR_POLICY);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("repairs an existing 0755 dir to 0700", async () => {
    const dir = join(tmp(), "d");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await ensurePrivateDir(dir, STATE_DIR_POLICY);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("is idempotent for an already-private dir", async () => {
    const dir = join(tmp(), "e");
    await ensurePrivateDir(dir, STATE_DIR_POLICY);
    await ensurePrivateDir(dir, STATE_DIR_POLICY);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("throws when the path exists as a file", async () => {
    const file = join(tmp(), "f");
    writeFileSync(file, "x");
    await expect(ensurePrivateDir(file, STATE_DIR_POLICY)).rejects.toThrow(/not a directory/);
    await expect(ensurePrivateDir(file, STATE_DIR_POLICY)).rejects.toMatchObject({ reason: "not-directory" });
  });

  it.skipIf(!isRoot)("throws when the dir is owned by another uid", async () => {
    const dir = join(tmp(), "g");
    await ensurePrivateDir(dir, STATE_DIR_POLICY);
    chownSync(dir, 1, 1);
    try {
      await expect(ensurePrivateDir(dir, STATE_DIR_POLICY)).rejects.toThrow(/owned by uid/);
    } finally {
      chownSync(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
    }
  });

  it("injected getuid mismatch ⇒ owner-mismatch without touching chmod (no root needed)", async () => {
    const dir = join(tmp(), "h");
    await ensurePrivateDir(dir, STATE_DIR_POLICY);
    const realUid = process.getuid?.() ?? 0;
    let chmodCalls = 0;
    const chmod: typeof realChmod = async (...args) => {
      chmodCalls++;
      return realChmod(...(args as Parameters<typeof realChmod>));
    };
    await expect(ensurePrivateDir(dir, STATE_DIR_POLICY, { getuid: () => realUid + 1, chmod })).rejects.toMatchObject({
      reason: "owner-mismatch",
    });
    expect(chmodCalls).toBe(0);
  });

  it("XDG_SOCKET_DIR_POLICY / TMP_SOCKET_DIR_POLICY enforcement is LP's job in W1 (stub)", async () => {
    const dir = join(tmp(), "xdg");
    await expect(ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY)).rejects.toThrow("E_NOT_IMPLEMENTED:LP");
    await expect(ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY)).rejects.toThrow("E_NOT_IMPLEMENTED:LP");
  });
});
