import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hasNodeSqlite } from "../../src/web-hub/hub/db.js";
import { buildMaintScript } from "../../src/web-hub/hub/db-child.js";
import { createDbClient, type DbClient } from "../../src/web-hub/hub/db-client.js";
import { createKdf } from "../../src/web-hub/hub/kdf.js";
import { createKdfAdmission } from "../../src/web-hub/hub/kdf-admission.js";
import { createHostsPort } from "../../src/web-hub/hub/net-hosts.js";
import { createLoginLimiter } from "../../src/web-hub/hub/ratelimit.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { FrontendFactory, HttpFrontend, LanAssembly } from "../../src/web-hub/hub/ports.js";
import { createSelfRestartStore } from "../../src/web-hub/hub/self-restart.js";
import { fakeLanStore } from "../web-hub/contract/fakes.js";
import { config, connectClient, hello, memLog, type TestClient } from "../web-hub/hub/helpers.js";

const execFileP = promisify(execFileCb);
const skipIfNoSqlite = (await hasNodeSqlite()) ? describe : describe.skip;

async function migrate(dbFile: string): Promise<void> {
  const script = buildMaintScript();
  await execFileP(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
    env: { ...process.env, PI_WEBHUB_DB_PATH: dbFile, PI_WEBHUB_DB_OP: "open-check-migrate" },
    timeout: 5_000,
  });
}

skipIfNoSqlite("web-hub DB breaker self-restart integration", () => {
  const clients: DbClient[] = [];
  const hubs: RunningHub[] = [];
  const socketClients: TestClient[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const client of socketClients.splice(0)) client.sock.destroy();
    for (const hub of hubs.splice(0)) await hub.close("test");
    await Promise.all(clients.splice(0).map((client) => client.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeFrontend(): FrontendFactory {
    const frontend: HttpFrontend = {
      listen: async () => ({ port: 0 }),
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
    return () => frontend;
  }

  it("uses a real slow child, opens the breaker, and admits only two restart requests per hour", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-db-self-restart-int-"));
    dirs.push(dir);
    const dbFile = join(dir, "hub.db");
    const restartFile = join(dir, "self-restart.json");
    await migrate(dbFile);
    const gate = createSelfRestartStore(restartFile);
    const decisions: boolean[] = [];

    async function trigger(): Promise<void> {
      const client = createDbClient({
        dbFile,
        log: memLog(),
        test: true,
        deadlineMs: 40,
        backoffMs: [5],
        maxRestartsInWindow: 1,
        restartCooldownMs: 5,
      });
      clients.push(client);
      client.onRestartNeeded(() => decisions.push(gate.tryAcquire(Date.now()).allowed));
      await expect(client.call("__block", { ms: 1_000 })).rejects.toMatchObject({ code: "E_DB" });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    await trigger();
    await trigger();
    await trigger();
    expect(decisions).toEqual([true, true, false]);
  }, 15_000);

  it("restarts a real startHub through admin semantics and suppresses the third restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "wh-hub-self-restart-e2e-"));
    dirs.push(root);
    const home = join(root, "home");
    const dbFile = join(root, "hub.db");
    await migrate(dbFile);
    const pathsHome = config({ home, lan: { port: 0, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } });

    let activeClient: DbClient | undefined;
    const assembly: LanAssembly = {
      async build({ cfg, paths, log, now, scope, onStatus }) {
        activeClient = createDbClient({
          dbFile: paths.dbFile,
          log,
          now,
          test: true,
          deadlineMs: 40,
          backoffMs: [5],
          maxRestartsInWindow: 1,
          restartCooldownMs: 25,
        });
        clients.push(activeClient);
        activeClient.onUnavailable((reason) => onStatus({ state: "off", reason }));
        scope.defer(() => activeClient!.close());
        const store = {
          ...fakeLanStore(),
          onRestartNeeded: (cb: () => void) => activeClient!.onRestartNeeded(cb),
        };
        const limiter = createLoginLimiter({ now });
        return {
          cfg,
          store,
          kdf: createKdf(),
          limiter,
          admission: createKdfAdmission({ now, isTightened: () => limiter.isTightened() }),
          hosts: createHostsPort(),
          scope,
          onStatus,
        };
      },
    };

    async function boot(): Promise<RunningHub> {
      const hub = await startHub(pathsHome, fakeFrontend(), { lanAssembly: assembly });
      if (!("close" in hub)) throw new Error("hub did not start");
      hubs.push(hub);
      return hub;
    }

    const first = await boot();
    const firstClient = await connectClient(first.paths.socketPath);
    socketClients.push(firstClient);
    firstClient.send(hello({ agentId: { pid: process.pid, nonce: "self-restart-agent-1" } }));
    await firstClient.waitFrame((frame) => frame.t === "hello_ack");
    const firstDb = activeClient!;
    await expect(firstDb.call("__block", { ms: 1_000 })).rejects.toMatchObject({ code: "E_DB" });
    const superseded = await firstClient.waitFrame((frame) => frame.t === "superseded", 2_000);
    expect(superseded).toMatchObject({ t: "superseded", nextVersion: pathsHome.pluginVersion });
    await expect(first.closed).resolves.toBe("restart");
    expect(existsSync(first.paths.hubJson)).toBe(false);

    const second = await boot();
    const secondDb = activeClient!;
    await expect(secondDb.call("__block", { ms: 1_000 })).rejects.toMatchObject({ code: "E_DB" });
    await expect(second.closed).resolves.toBe("restart");
    expect(existsSync(second.paths.hubJson)).toBe(false);

    const third = await boot();
    const thirdDb = activeClient!;
    await expect(thirdDb.call("__block", { ms: 1_000 })).rejects.toMatchObject({ code: "E_DB" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(third.paths.hubJson)).toBe(true);
    const record = JSON.parse(readFileSync(third.paths.hubJson, "utf8")) as {
      lan?: { state?: string; detail?: string };
    };
    expect(record.lan).toMatchObject({ state: "off", detail: "self-restart-limit" });
    let thirdClosed = false;
    void third.closed.then(() => {
      thirdClosed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(thirdClosed).toBe(false);
    await third.close("test");
  }, 20_000);

  it("corrupt persisted restart state fails safe and never requests a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-db-self-restart-corrupt-"));
    dirs.push(dir);
    const dbFile = join(dir, "hub.db");
    const restartFile = join(dir, "self-restart.json");
    await migrate(dbFile);
    writeFileSync(restartFile, "{broken\n");
    const gate = createSelfRestartStore(restartFile);
    const client = createDbClient({
      dbFile,
      log: memLog(),
      test: true,
      deadlineMs: 40,
      backoffMs: [5],
      maxRestartsInWindow: 1,
      restartCooldownMs: 5,
    });
    clients.push(client);
    let requested = false;
    client.onRestartNeeded(() => {
      requested = gate.tryAcquire(Date.now()).allowed;
    });
    await expect(client.call("__block", { ms: 1_000 })).rejects.toMatchObject({ code: "E_DB" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requested).toBe(false);
  }, 10_000);
});
