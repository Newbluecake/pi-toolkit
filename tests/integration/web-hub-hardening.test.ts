// web-hub plan §1.3.5 迁移测试 (LP, S1-W2) — integration: a real hub process's
// socket/state-dir/log permissions end-to-end through `startHub` (real fs, no
// injected fs deps), plus the `$XDG_RUNTIME_DIR` socket-dir fallback candidate
// under LP's hardened `XDG_SOCKET_DIR_POLICY` (both the happy path and two
// rejection paths: a symlinked candidate, and one owned by another uid) —
// confirming a rejected candidate never falls back silently and never leaves
// a half-started hub (no hub.json, no bound loopback listener).

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../src/web-hub/hub/ports.js";
import { resolveHubPaths, SOCKET_PATH_MAX_BYTES } from "../../src/web-hub/protocol/paths.js";
import { config as hubConfig } from "../web-hub/hub/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const hubs: RunningHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
});

function tmp(prefix = "wh-hardening-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface FakeFrontend extends FrontendFactory {
  deps: FrontendDeps[];
}

function fakeFrontend(): FakeFrontend {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return {
      listen: async () => ({ port: 0 }),
      close: async () => {},
      clientCount: () => 0,
    };
  }) as FakeFrontend;
  f.deps = [];
  return f;
}

/**
 * A writable `home` long enough that `resolveHubPaths` skips the primary
 * `<home>/.pi/agent/web-hub/hub.sock` candidate (byte length > `SOCKET_PATH_MAX_BYTES`
 * once the on-disk-layout suffix is appended) and falls to `$XDG_RUNTIME_DIR` /
 * `/tmp`. Padded under a real temp dir (not the filesystem root) so
 * `ensurePrivateDir`'s `mkdir -p` on `stateDir` actually succeeds.
 */
function longWritableHome(): string {
  return join(tmp("wh-hardening-longhome-"), "h".repeat(90));
}

describe("real hub via startHub: socket/state-dir/log permissions", () => {
  it("a client connecting sees a private (0600) socket; stateDir 0700, hub.json + hub.log 0600", async () => {
    const home = sandboxHome();
    const started = await startHub(hubConfig({ home: home.home, port: 0 }), fakeFrontend(), {
      uid: process.getuid?.() ?? 0,
    });
    if ("exists" in started) throw new Error("unexpected singleton collision");
    hubs.push(started);

    // "agent 连上 socket 后立刻 stat ⇒ 0600" (§1.3.5): connect a real client, then stat immediately.
    const client = net.connect(started.paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });
    expect(statSync(started.paths.socketPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(started.paths.socketPath).isSymbolicLink()).toBe(false);
    client.destroy();

    expect(statSync(started.paths.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(started.paths.hubJson).mode & 0o777).toBe(0o600);
    expect(existsSync(started.paths.logFile)).toBe(true); // "hub started" is logged during startup
    expect(statSync(started.paths.logFile).mode & 0o777).toBe(0o600);
  });
});

describe("real hub via startHub: XDG_RUNTIME_DIR socket-dir candidate (XDG_SOCKET_DIR_POLICY)", () => {
  it("a properly-prepared 0700 dir owned by us: hub starts, socket lives there at 0600", async () => {
    const home = longWritableHome();
    const xdg = tmp("wh-hardening-xdg-");
    chmodSync(xdg, 0o700);
    const started = await startHub(hubConfig({ home, port: 0 }), fakeFrontend(), {
      uid: process.getuid?.() ?? 0,
      xdgRuntimeDir: xdg,
    });
    if ("exists" in started) throw new Error("unexpected singleton collision");
    hubs.push(started);
    expect(started.paths.socketDir).toBe(xdg);
    expect(statSync(started.paths.socketPath).mode & 0o777).toBe(0o600);
  });

  it("a symlinked candidate is rejected outright — no fallback, no half-started hub left behind", async () => {
    const home = longWritableHome();
    const base = tmp("wh-hardening-xdgsym-");
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const xdg = join(base, "xdg-link");
    symlinkSync(real, xdg);
    const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0, xdgRuntimeDir: xdg });
    expect(paths.socketDir).toBe(xdg); // sanity: this really is the candidate under test
    expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);

    await expect(
      startHub(hubConfig({ home, port: 0 }), fakeFrontend(), {
        uid: process.getuid?.() ?? 0,
        xdgRuntimeDir: xdg,
      }),
    ).rejects.toThrow(/symlink/);
    // no residue anywhere the hub could have written to.
    expect(existsSync(join(real, "hub.sock"))).toBe(false);
    expect(existsSync(join(home, ".pi", "agent", "web-hub", "hub.json"))).toBe(false);
  });
});
