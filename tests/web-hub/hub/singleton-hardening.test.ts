/**
 * LP migration tests (plan §1.3.5): `singleton.ts`'s use of `verifyBoundSocket`
 * at bind time and in `startFence` — the parts `tests/web-hub/hub/singleton.test.ts`
 * (W1, unchanged except for the `inode` → `identity` rename already covered
 * there) exercised through W1's own minimal lstat-only identity computation.
 * This file exercises the hardened behavior LP wires in on top: policy
 * enforcement surfacing through `acquireSingleton`'s result, a real bind-time
 * TOCTOU rejection, and real (not mocked) directory-identity and socket-identity
 * drift detected by the fence via `verifyBoundSocket` + the frozen `fenceLossOf`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { lstat, chmod as realChmod } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { resolveHubPaths, SOCKET_PATH_MAX_BYTES, type HubPaths } from "../../../src/web-hub/protocol/paths.js";
import { acquireSingleton, startFence, type SingletonResult } from "../../../src/web-hub/hub/singleton.js";
import { tmpDirs, waitFor } from "./helpers.js";

const tmp = tmpDirs();
const owners: Array<Extract<SingletonResult, { kind: "owner" }>> = [];

afterEach(async () => {
  for (const o of owners.splice(0)) await o.release();
  tmp.cleanup();
});

function paths(): HubPaths {
  return resolveHubPaths({ home: tmp.make("wh-sh-"), uid: process.getuid?.() ?? 0 });
}

function track(r: SingletonResult): SingletonResult {
  if (r.kind === "owner") owners.push(r);
  return r;
}

describe("acquireSingleton: XDG/TMP socket-dir policy violations surface a precise reason", () => {
  it("a symlinked $XDG_RUNTIME_DIR candidate ⇒ {kind:'failed', reason:'symlink'}, never falls back", async () => {
    const home = join(tmp.make("wh-sh-xdg-home-"), "h".repeat(90)); // pad past SOCKET_PATH_MAX_BYTES
    const base = tmp.make("wh-sh-xdg-base-");
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const xdg = join(base, "link");
    symlinkSync(real, xdg);
    const p = resolveHubPaths({ home, uid: process.getuid?.() ?? 0, xdgRuntimeDir: xdg });
    expect(p.socketDir).toBe(xdg);
    expect(Buffer.byteLength(p.socketPath)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);

    const r = await acquireSingleton(p, { probeMs: 50, guardName: null });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.reason).toBe("symlink");
      expect(r.error).toContain(xdg);
      expect(r.error).toContain("XDG_RUNTIME_DIR");
    }
    expect(existsSync(join(real, "hub.sock"))).toBe(false); // no fallback candidate was ever tried
  });

  it("a $XDG_RUNTIME_DIR candidate owned by another uid (faked lstat.uid, real getuid untouched) ⇒ reason:'owner-mismatch', no chmod", async () => {
    const home = join(tmp.make("wh-sh-xdg-home2-"), "h".repeat(90));
    const xdg = tmp.make("wh-sh-xdg-owner-");
    const p = resolveHubPaths({ home, uid: process.getuid?.() ?? 0, xdgRuntimeDir: xdg });
    const realUid = process.getuid?.() ?? 0;
    let chmodCalls = 0;
    // Only `lstat` is faked, and only for the XDG candidate path — `STATE_DIR_POLICY`'s own
    // `stat`-based check (a different fs method) is untouched, so this isolates the XDG
    // candidate's owner-mismatch path instead of also tripping the (unrelated) state dir check.
    const fakeOwnerLstat = (async (path: Parameters<typeof lstat>[0]) => {
      const real = await lstat(path);
      if (path === xdg) (real as { uid: number }).uid = realUid + 1;
      return real;
    }) as typeof lstat;
    const r = await acquireSingleton(p, {
      probeMs: 50,
      guardName: null,
      fs: {
        lstat: fakeOwnerLstat,
        chmod: async (path: Parameters<typeof realChmod>[0], mode: Parameters<typeof realChmod>[1]) => {
          if (path === xdg) {
            chmodCalls++;
            return;
          }
          return realChmod(path, mode); // let the (unrelated) state dir's own chmods proceed normally
        },
      },
    });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toBe("owner-mismatch");
    expect(chmodCalls).toBe(0);
  });
});

describe("bind-time TOCTOU: socketDir identity changing between ensurePrivateDir and bind", () => {
  it("is rejected with reason:'socket-verify' and leaves no bound socket behind", async () => {
    const p = paths();
    let lstatCalls = 0;
    // With `socketDir === stateDir` (the default short-home layout) the *first* lstat call in
    // the whole `acquireSingleton` flow is `verifyBoundSocket`'s own socket-path lstat (during
    // bind); the *second* is its dir lstat. Tamper with exactly that second call's `ino` to
    // simulate "the socket directory got swapped for a different one" between the pre-bind
    // `ensurePrivateDir` check (which captured the *real* identity as `dirBefore`) and now.
    const flakyLstat = (async (path: Parameters<typeof lstat>[0]) => {
      const real = await lstat(path);
      lstatCalls++;
      if (lstatCalls === 2) (real as { ino: number }).ino = real.ino + 999_999;
      return real;
    }) as typeof lstat;

    const r = await acquireSingleton(p, { probeMs: 50, guardName: null, fs: { lstat: flakyLstat } });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toBe("socket-verify");
    expect(lstatCalls).toBe(2); // both the socket- and the dir-lstat ran before the rejection
    expect(existsSync(p.socketPath)).toBe(false); // closeServer's libuv unlink ran (it really was bound)
  });
});

describe("startFence: real (not mocked) directory-identity and socket-identity drift", () => {
  it("the socket directory being replaced (same-path socket preserved, new dir inode) ⇒ onLost('dir-replaced')", async () => {
    const p = paths();
    const o = track(await acquireSingleton(p, { probeMs: 50, guardName: null }));
    if (o.kind !== "owner") throw new Error("expected owner");

    let lost = 0;
    let why: string | undefined;
    const stop = startFence(
      p.socketPath,
      o.identity,
      (w) => {
        lost++;
        why = w;
      },
      20,
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(lost).toBe(0); // untouched so far

    // Replace the containing directory while preserving the *same* bound socket (same inode) at
    // the *same* final path string: rename the old dir out of the way, mkdir a fresh one at the
    // original path (new inode), then move the socket entry (not the socket itself — sockets are
    // inode-identified, not path-identified once bound) back under the same file name.
    const oldDir = `${p.socketDir}.old`;
    renameSync(p.socketDir, oldDir);
    mkdirSync(p.socketDir, { mode: 0o700 });
    renameSync(join(oldDir, "hub.sock"), p.socketPath);
    rmdirSync(oldDir);

    await waitFor(() => lost > 0, 2_000);
    expect(lost).toBe(1);
    expect(why).toBe("dir-replaced");
    stop();
  });

  it("the socket file being replaced by a *different* valid bound socket (same dir) ⇒ onLost('socket-replaced')", async () => {
    const p = paths();
    const o = track(await acquireSingleton(p, { probeMs: 50, guardName: null }));
    if (o.kind !== "owner") throw new Error("expected owner");

    let lost = 0;
    let why: string | undefined;
    const stop = startFence(
      p.socketPath,
      o.identity,
      (w) => {
        lost++;
        why = w;
      },
      20,
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(lost).toBe(0);

    // Unlink the original socket and bind a *new* one at the same path (same dir, different
    // socket inode) — a hygienic replacement, not a symlink/type/owner violation, so this can
    // only be caught via the `seen` vs. recorded `identity.socket` comparison.
    unlinkSync(p.socketPath);
    const impostor = net.createServer();
    await new Promise<void>((resolve, reject) => {
      impostor.once("error", reject);
      impostor.listen(p.socketPath, () => resolve());
    });

    await waitFor(() => lost > 0, 2_000);
    expect(lost).toBe(1);
    expect(why).toBe("socket-replaced");
    stop();
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
  });
});
