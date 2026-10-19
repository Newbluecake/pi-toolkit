/**
 * created-dirs plan r2 §6 (P2) — real assembly: in-process real `startHub` (spawn + plaintext
 * LAN, `lan:"roots"` ⇒ the plaintext cap makes scope `known`) + real `createHttpFrontend` + a
 * REAL fake-pi child (mode B of web-hub-headless.test.ts). Flow: LAN mkdir inside the root ⇒
 * `known:true` ⇒ spawn (confirm always) ⇒ child live with cwd = the created dir (real `pinSync`
 * with `{canonical:true}`) ⇒ stop ⇒ a SECOND `startHub` on the same stateDir ⇒ the persisted
 * record is still honored; negative: a created dir moved out of the root with a symlink planted
 * back is refused and never forks. Linux-only (spawn is), needs node:sqlite (LAN accounts).
 * Lives outside the golden include globs on purpose.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { HubConfig, HubLanConfig } from "../../src/web-hub/hub/ports.js";
import { hasNodeSqlite } from "../../src/web-hub/hub/db.js";
import { webHubSpawnFiles } from "../../src/web-hub/protocol/paths.js";
import type { HubSpawnConfig } from "../../src/web-hub/protocol/spawn.js";
import type { LanInfoPayload, LanResFrame } from "../../src/web-hub/protocol/messages.js";
import { config as hubConfig, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { lanPostJson } from "../web-hub/http/lan-helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const IS_LINUX = process.platform === "linux";
const NO_NODE_SQLITE = !(await hasNodeSqlite());
const FAKE_PI = resolve("tests/integration/fixtures/fake-rpc-pi.mjs");

function fakeLauncher(root: string): readonly [string, string] {
  const pkgDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.2" }),
  );
  const entry = join(pkgDir, "pi.mjs");
  copyFileSync(FAKE_PI, entry);
  return [process.execPath, entry];
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.once("error", rej);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EPERM";
  }
}

interface Stored {
  spawnId: string;
  state?: string;
  pid?: number;
}
function recordOf(stateDir: string, spawnId: string): Stored | undefined {
  const file = webHubSpawnFiles(stateDir).spawnsJson;
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { records?: Stored[] };
  return parsed.records?.find((r) => r.spawnId === spawnId);
}

let idCounter = 0;
const reqId = (): string => {
  idCounter += 1;
  return `cd${Date.now().toString(36)}${idCounter.toString(36).padStart(8, "0")}`;
};

describe.skipIf(!IS_LINUX || NO_NODE_SQLITE)("created dirs — real startHub × LAN mkdir → spawn → restart", () => {
  let sandbox: ReturnType<typeof sandboxHome> | undefined;
  let foreign: string | undefined;
  let admin: TestClient | undefined;
  const hubs: RunningHub[] = [];
  const pids = new Set<number>();

  afterEach(async () => {
    admin?.sock.destroy();
    admin = undefined;
    for (const h of hubs.splice(0)) await h.close("test-teardown").catch(() => undefined);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    pids.clear();
    sandbox?.restore();
    sandbox = undefined;
    if (foreign !== undefined) rmSync(foreign, { recursive: true, force: true });
    foreign = undefined;
  });

  async function boot(home: string, lanPort: number): Promise<RunningHub> {
    const spawn: HubSpawnConfig = {
      roots: [home],
      maxProcesses: 4,
      maxPerPrincipal: 2,
      ratePerMinute: 30,
      maxLifetimeMinutes: 720,
      registerTimeoutS: 10,
      lan: "roots",
    };
    const lan: HubLanConfig = { port: lanPort, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
    const cfg: HubConfig = hubConfig({
      home,
      port: 0,
      idleExitMinutes: 10,
      pluginVersion: "1.2.3",
      launcher: fakeLauncher(home),
      spawn,
      lan,
    });
    const started = await startHub(cfg, createHttpFrontend, { uid: process.getuid?.() ?? 0, childUmask: 0o022 });
    if ("exists" in started) throw new Error("unexpected singleton collision");
    hubs.push(started);
    await waitUntil(() => started.lanStatus()?.state === "on", 15_000, "lan on");
    return started;
  }

  async function closeHub(h: RunningHub): Promise<void> {
    await h.close("test-restart");
    await h.closed;
    hubs.splice(hubs.indexOf(h), 1);
  }

  async function lanReq(frame: Record<string, unknown> & { op: string }): Promise<LanResFrame> {
    const rid = `t-${Math.random().toString(36).slice(2)}`;
    admin!.send({ ...frame, rid });
    return (await admin!.waitFrame((x) => x["t"] === "lan_res" && x["rid"] === rid, 5_000)) as unknown as LanResFrame;
  }

  async function login(h: RunningHub, lanPort: number, username: string, password: string): Promise<string> {
    void h;
    const r = await lanPostJson(lanPort, "/api/login", { username, password }, { Host: `127.0.0.1:${lanPort}` });
    if (r.status !== 200) throw new Error(`lan login failed: ${r.status} ${r.body}`);
    return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  }

  /** LAN two-step spawn (confirm:"always"): returns the final response. */
  async function spawnLan(lanPort: number, cookie: string, cwd: string) {
    const host = `127.0.0.1:${lanPort}`;
    const headers = { Cookie: cookie, Origin: `http://${host}`, Host: host };
    const id = reqId();
    const first = await lanPostJson(lanPort, "/api/headless", { id, cwd }, headers);
    if (first.status !== 409) return first;
    const resolved = (JSON.parse(first.body) as { resolvedCwd: string }).resolvedCwd;
    return lanPostJson(lanPort, "/api/headless", { id, cwd, confirm: true, expectCwd: resolved }, headers);
  }

  async function liveIn(stateDir: string, spawnId: string): Promise<number> {
    await waitUntil(() => recordOf(stateDir, spawnId)?.state === "live", 20_000, "record live");
    const pid = recordOf(stateDir, spawnId)!.pid!;
    pids.add(pid);
    return pid;
  }

  it("LAN mkdir → confirm → 202 → child cwd = created dir → stop → second startHub honors the record; moved+symlinked dir is refused", async () => {
    sandbox = sandboxHome();
    const home = sandbox.home;
    const lanPort = await freePort();
    let hub = await boot(home, lanPort);
    admin = await connectClient(hub.paths.socketPath);
    admin.send(hello({ agentId: { pid: process.pid, nonce: "cdadminnonce000001" }, epoch: "cd" }));
    await admin.waitFrame((f) => f["t"] === "hello_ack");
    const info = await lanReq({ t: "lan_req", op: "info" });
    if (!info.ok || info.info === undefined) throw new Error("lan info failed");
    const user = (info.info as LanInfoPayload).username;
    const pass = (info.info as LanInfoPayload).initialPassword;
    if (pass === undefined) throw new Error("no initial password");
    let cookie = await login(hub, lanPort, user, pass);
    const host = `127.0.0.1:${lanPort}`;

    // an unrecorded dir under the root is refused on plaintext LAN (control) …
    const plain = join(home, "plain-unrecorded");
    mkdirSync(plain);
    const refused = await spawnLan(lanPort, cookie, plain);
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ error: "E_DIR", reason: "not-allowed", detail: "plaintext-lan" });

    // … while a hub-created one is known
    const mk = await lanPostJson(
      lanPort,
      "/api/headless/mkdir",
      { path: home, name: "created-e2e" },
      { Cookie: cookie, Origin: `http://${host}`, Host: host },
    );
    expect(mk.status).toBe(200);
    const created = join(home, "created-e2e");
    expect(JSON.parse(mk.body)).toEqual({ ok: true, path: created, known: true });
    expect(statSync(webHubSpawnFiles(hub.paths.stateDir).createdDirsJson).mode & 0o777).toBe(0o600);

    const ok = await spawnLan(lanPort, cookie, created);
    expect(ok.status).toBe(202);
    const spawnId = (JSON.parse(ok.body) as { spawnId: string }).spawnId;
    const pid = await liveIn(hub.paths.stateDir, spawnId);
    expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(created);
    expect(existsSync(join(created, ".fake-pi-argv.log"))).toBe(true); // the child really ran there

    // negative (same hub): moved out of the root with a symlink planted back at the old path
    expect(
      (
        await lanPostJson(
          lanPort,
          "/api/headless/mkdir",
          { path: home, name: "to-move" },
          { Cookie: cookie, Origin: `http://${host}`, Host: host },
        )
      ).status,
    ).toBe(200);
    foreign = mkdtempSync(join(tmpdir(), "created-dirs-foreign-"));
    renameSync(join(home, "to-move"), join(foreign, "to-move"));
    symlinkSync(join(foreign, "to-move"), join(home, "to-move"));
    const moved = await spawnLan(lanPort, cookie, join(home, "to-move"));
    expect(moved.status).toBe(400);
    expect(JSON.parse(moved.body)).toMatchObject({ error: "E_DIR", reason: "not-allowed" });
    expect(existsSync(join(foreign, "to-move", ".fake-pi-argv.log"))).toBe(false); // never forked

    // stop the child, restart the hub on the SAME stateDir
    const stop = await lanPostJson(
      lanPort,
      `/api/headless/${spawnId}/stop`,
      {},
      { Cookie: cookie, Origin: `http://${host}`, Host: host },
    );
    expect(stop.status).toBe(202);
    await waitUntil(() => recordOf(hub.paths.stateDir, spawnId)?.state === "exited", 15_000, "child exited");
    admin.sock.destroy();
    admin = undefined;
    await closeHub(hub);

    const lanPort2 = await freePort();
    hub = await boot(home, lanPort2);
    cookie = await login(hub, lanPort2, user, pass);
    const again = await spawnLan(lanPort2, cookie, created);
    expect(again.status).toBe(202);
    const pid2 = await liveIn(hub.paths.stateDir, (JSON.parse(again.body) as { spawnId: string }).spawnId);
    expect(pid2).not.toBe(pid);
    expect(readlinkSync(`/proc/${pid2}/cwd`)).toBe(created);
    expect(pidAlive(pid2)).toBe(true);
  }, 120_000);
});
