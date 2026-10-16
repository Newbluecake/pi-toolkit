/**
 * web-hub spawn-dirmkdir — hub-assembly wiring test for the post-create MODE (user ruling
 * 2026-10-16 「可以和终端一样是 775」): the mkdir service is constructed INSIDE `startHub`
 * (no seam exposes it), so the only honest pin is end-to-end — real `startHub` (fake
 * frontend, fake reaper, real tmp launcher fixture — hub-spawn.test.ts's lift) with
 * `StartHubDeps.childUmask` set, then driving the REAL spawn route frontend
 * (`FrontendDeps.spawn.handle`, file-search.test.ts's fake-io strategy) at
 * `POST /api/headless/mkdir` against the hub's own tmp home.
 *
 * Pins: `childUmask: 0o002` ⇒ the created directory is 0o775 on disk (the explicit fchmod
 * overrides whatever the TEST process's umask is — exactly the hub daemon's 0o077 situation);
 * `childUmask` absent ⇒ today's umask-masked mkdir result, byte-identical pre-feature.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub, type StartHubDeps } from "../../../src/web-hub/hub/hub.js";
import type { SpawnRouteIo } from "../../../src/web-hub/hub/spawn/ports.js";
import type { Reaper, ReaperTrackRecord } from "../../../src/web-hub/hub/spawn/reaper.js";
import type { HubSpawnConfig } from "../../../src/web-hub/protocol/spawn.js";
import { config, tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

// ---------------------------------------------------------------------------
// fixtures (hub-spawn.test.ts / hub-history-assembly.test.ts shapes, trimmed)
// ---------------------------------------------------------------------------

const SPAWN_CFG: HubSpawnConfig = {
  roots: [],
  maxProcesses: 4,
  maxPerPrincipal: 2,
  ratePerMinute: 3,
  maxLifetimeMinutes: 720,
  registerTimeoutS: 30,
  lan: "off",
};

function launcherFixture(home: string): [string, string] {
  const pkgDir = join(home, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.2" }),
  );
  writeFileSync(join(pkgDir, "cli.js"), "// test launcher entry\n");
  return [process.execPath, join(pkgDir, "cli.js")];
}

function fakeReaper(): Reaper {
  let started = false;
  return {
    start: async () => {
      started = true;
      return true;
    },
    track: (_rec: ReaperTrackRecord) => {},
    untrack: (_pid: number) => {},
    close: () => {},
    get available() {
      return started;
    },
    onUnavailable: () => () => {},
    onRestart: () => () => {},
  };
}

function fakeFrontend(): FrontendFactory & { deps: FrontendDeps[] } {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return {
      listen: async () => ({ port: 43213 }),
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  }) as ReturnType<typeof fakeFrontend>;
  f.deps = [];
  return f;
}

/** One POST /api/headless/mkdir through the REAL spawn route frontend + a minimal fake io
 * (strictCsrfOk/authorize/readJson/sendJson faked — file-search.test.ts's strategy). */
async function driveMkdir(
  fe: FrontendFactory & { deps: FrontendDeps[] },
  body: { path: string; name: string },
): Promise<{ status: number; body: unknown }> {
  const spawnPort = fe.deps[0]?.spawn;
  if (spawnPort === undefined) throw new Error("spawn route frontend not wired");
  const sent: Array<{ status: number; body: unknown }> = [];
  const io: SpawnRouteIo = {
    listener: "loopback",
    ip: "127.0.0.1",
    scheme: "http",
    viaTrustedProxy: false,
    strictCsrfOk: () => true,
    authorize: async () => ({ ip: "127.0.0.1" }),
    readJson: async () => body,
    sendJson: (_res, status, b) => {
      sent.push({ status, body: b });
    },
    sendError: (_res, status, code) => {
      sent.push({ status, body: { error: code } });
    },
    HttpError: class extends Error {
      readonly status: number;
      readonly code: string;
      constructor(status: number, code: string, message?: string) {
        super(message ?? code);
        this.status = status;
        this.code = code;
      }
    },
  };
  const req = { headers: {} } as unknown as IncomingMessage;
  const res = {} as unknown as ServerResponse;
  await spawnPort.handle(req, res, "POST", "/api/headless/mkdir", new URLSearchParams(), io);
  const first = sent[0];
  if (first === undefined) throw new Error("route produced no response");
  return first;
}

// ---------------------------------------------------------------------------

describe("hub wiring: mkdir dirMode follows the USER's umask (2026-10-16 ruling)", () => {
  it("childUmask 0o002 ⇒ the web-created directory is 0o775 on disk", async () => {
    const home = tmp.make("wh-mkdirmode-");
    const fe = fakeFrontend();
    const deps: StartHubDeps = {
      uid: process.getuid?.() ?? 0,
      childUmask: 0o002, // a terminal's umask — 0o777 & ~0o002 === 0o775
      spawnSeams: { reaper: fakeReaper() },
    };
    const hub = await startHub(config({ home, launcher: launcherFixture(home), spawn: SPAWN_CFG }), fe, deps);
    hubs.push(hub);
    const r = await driveMkdir(fe, { path: home, name: "mode-probe" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, path: join(home, "mode-probe") });
    // the explicit fchmod wins over the test process's own umask, whatever it is
    expect(statSync(join(home, "mode-probe")).mode & 0o777).toBe(0o775);
  });

  it("childUmask absent ⇒ today's behavior: the umask-masked mkdir result (0o777 & ~process umask)", async () => {
    const home = tmp.make("wh-mkdirnone-");
    const fe = fakeFrontend();
    const deps: StartHubDeps = {
      uid: process.getuid?.() ?? 0,
      spawnSeams: { reaper: fakeReaper() },
    };
    const hub = await startHub(config({ home, launcher: launcherFixture(home), spawn: SPAWN_CFG }), fe, deps);
    hubs.push(hub);
    const r = await driveMkdir(fe, { path: home, name: "no-umask" });
    expect(r.status).toBe(200);
    expect(statSync(join(home, "no-umask")).mode & 0o777).toBe(0o777 & ~process.umask());
  });
});
