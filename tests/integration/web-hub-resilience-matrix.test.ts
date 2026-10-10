/**
 * P-Int — docs/dev/hub-resilience/plan.md §3 cross-domain acceptance matrix.
 *
 * Existing coverage (kept out of this file to avoid duplicate lifecycle tests):
 * 1 two-serving-hub       → `tests/web-hub/hub/hub-startup-gate.test.ts`: "admin close during
 *                           ...: all later handles stay unexposed and publication is skipped";
 *                           `tests/integration/web-hub-spawn.test.ts`: "3 concurrent hub spawns
 *                           converge to exactly one live hub pid".
 * 2 silent-successor      → this file: "a half-started successor can hold the singleton guard
 *                           without making the predecessor claim a successful handover".
 * 3 re-arm/close race     → this file: "fence-triggered and supersede-triggered close share one
 *                           teardown"; the unit baseline is `tests/web-hub/hub/hub.test.ts`:
 *                           "close() removes hub.sock and hub.json, closes the frontend, resolves
 *                           closed".
 * 4 managed-child L6      → `tests/integration/web-hub-supersede-early-close.test.ts`: "L6: after
 *                           early supersede, successor cannot restore-fork until the old child's
 *                           death is confirmed".
 * 5 journal-ownership     → the hub has no workflow journal of its own. This row maps only to
 *                           the hub-owned run-transcript resources: `tests/web-hub/hub/hub.test.ts`:
 *                           "FrontendDeps.runTx is the assembled RunTranscriptService and closes
 *                           cleanly". That assertion covers explicit runTx/reader disposal, but
 *                           does not claim an exactly-once workflow-journal proof; workflow journal
 *                           ownership is outside startHub.
 *
 * The new rows deliberately use a real
 * startHub(), real HTTP/SSE sockets, and the existing LAN contract fakes. The fake store is only
 * the DB/auth seam: persistence is shared across the two real hub instances, while restart and
 * slow-child hooks remain deterministic and do not require wall-clock sleeps.
 */

import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../src/web-hub/hub/db-client.js";
import { buildMaintScript } from "../../src/web-hub/hub/db-child.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createKdfAdmission } from "../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../src/web-hub/hub/ratelimit.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { acquireSingleton, startFence } from "../../src/web-hub/hub/singleton.js";
import type { HubConfig, LanAssembly } from "../../src/web-hub/hub/ports.js";
import { fakeKdf, fakeLanStore, type FakeLanStore } from "../web-hub/contract/fakes.js";
import { lanRequest, lanPostJson } from "../web-hub/http/lan-helpers.js";
import { openSse, type SseConn } from "../web-hub/http/helpers.js";
import { hashSid } from "../../src/web-hub/hub/sid-hash.js";
import { config as hubConfig, waitFor } from "../web-hub/hub/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";
import { seedLanUser } from "../web-hub/http/lan-helpers.js";

interface RestartableStore extends FakeLanStore {
  onRestartNeeded(cb: () => void): () => void;
  triggerRestart(): void;
}

function restartableStore(): RestartableStore {
  const store = fakeLanStore() as RestartableStore;
  const listeners = new Set<() => void>();
  store.onRestartNeeded = (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  store.triggerRestart = () => {
    for (const cb of [...listeners]) cb();
  };
  return store;
}

function assemblyFor(store: RestartableStore): LanAssembly {
  return {
    async build({ cfg, scope, onStatus }) {
      return {
        cfg,
        store,
        kdf: fakeKdf(),
        limiter: createLoginLimiter({ now: Date.now }),
        admission: createKdfAdmission({ now: Date.now, isTightened: () => false }),
        hosts: {
          compute: (lanCfg) => ({
            gen: 1,
            hostKeys: new Set<string>([`127.0.0.1:${lanCfg.port}`]),
            externalOrigins: new Set(lanCfg.externalOrigins),
            trustProxyFrom: new Set(lanCfg.trustProxyFrom),
            omitted: [],
            computedAt: Date.now(),
          }),
        },
        scope,
        onStatus,
      };
    },
  };
}

function lanConfig(port: number): NonNullable<HubConfig["lan"]> {
  return { port, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      server.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
  });
}

async function startLanHub(home: string, port: number, store: RestartableStore): Promise<RunningHub> {
  const started = await startHub(hubConfig({ home, port: 0, lan: lanConfig(port) }), createHttpFrontend, {
    lanAssembly: assemblyFor(store),
  });
  if ("exists" in started) throw new Error("test bug: unexpected hub singleton collision");
  await waitFor(() => started.lanStatus()?.state === "on", 10_000);
  return started;
}

function latch(): { pending: Promise<void>; release(): void } {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

function cookieOf(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : value;
  const cookie = first?.split(";")[0];
  if (cookie === undefined || cookie === "") throw new Error("test bug: login did not set a LAN cookie");
  return cookie;
}

function sidHash(cookie: string): string {
  const sid = cookie.slice(cookie.indexOf("=") + 1);
  return hashSid(sid);
}

async function login(port: number, username: string, password: string): Promise<string> {
  const response = await lanPostJson(port, "/api/login", { username, password });
  expect(response.status).toBe(200);
  return cookieOf(response);
}

describe("P-Int §3 LAN recovery and DB-load matrix", () => {
  const execFile = promisify(execFileCallback);

  async function migrateDb(dbFile: string): Promise<void> {
    await execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", buildMaintScript()], {
      env: { ...process.env, PI_WEBHUB_DB_PATH: dbFile, PI_WEBHUB_DB_OP: "open-check-migrate" },
      timeout: 5_000,
    });
  }

  const homes: Array<ReturnType<typeof sandboxHome>> = [];
  const hubs: RunningHub[] = [];
  const sse: SseConn[] = [];
  const dbClients: DbClient[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const singletonReleases: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stream of sse.splice(0)) stream.close();
    for (const hub of hubs.splice(0)) await hub.close("test-teardown").catch(() => undefined);
    for (const client of dbClients.splice(0)) await client.close().catch(() => undefined);
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const release of singletonReleases.splice(0)) await release().catch(() => undefined);
    for (const home of homes.splice(0)) {
      home.restore();
      rmSync(home.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });

  it("a half-started successor can hold the singleton guard without making the predecessor claim a successful handover", async () => {
    const home = sandboxHome();
    homes.push(home);
    const gate = latch();
    const store = fakeLanStore() as RestartableStore;
    const baseAssembly = assemblyFor(store);
    const lanPort = await freePort();
    const lanAssembly: LanAssembly = {
      async build(args) {
        // Keep the predecessor in its post-owner-release teardown window. The replacement below
        // acquires the real abstract/file singleton guard, but intentionally never reaches
        // startHub's publication/HTTP stages: it is the silent half-started successor.
        args.scope.defer(() => gate.pending);
        return baseAssembly.build(args);
      },
    };
    const started = await startHub(
      hubConfig({ home: home.home, port: 0, lan: lanConfig(lanPort) }),
      createHttpFrontend,
      { lanAssembly },
    );
    if ("exists" in started) throw new Error("test bug: predecessor did not start");
    hubs.push(started);

    let predecessorClosed = false;
    void started.closed.then(() => {
      predecessorClosed = true;
    });
    const predecessorClose = started.close("superseded");
    let successor: Awaited<ReturnType<typeof acquireSingleton>> | undefined;
    const successorPromise = (async () => {
      while (successor === undefined) {
        const result = await acquireSingleton(started.paths);
        if (result.kind === "owner") {
          successor = result;
          singletonReleases.push(result.release);
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();

    await waitFor(() => successor !== undefined, 10_000);
    await successorPromise;
    expect(successor?.kind).toBe("owner");
    // The predecessor's bounded root-scope teardown completed before the silent successor
    // acquired the guard. Because the successor never runs startHub's publication stages, its
    // guard ownership cannot be mistaken for a successful handover.
    expect(predecessorClosed).toBe(true);
    gate.release();
    await predecessorClose;
    expect(await started.closed).toBe("superseded");
    expect(existsSync(started.paths.hubJson)).toBe(false);
  }, 20_000);

  it("fence-triggered and supersede-triggered close share one teardown", async () => {
    const home = sandboxHome();
    homes.push(home);
    let frontendClosed = 0;
    const frontend = (deps: Parameters<typeof createHttpFrontend>[0]) => {
      const real = createHttpFrontend(deps);
      return {
        ...real,
        close: async () => {
          frontendClosed++;
          await real.close();
        },
      };
    };
    const started = await startHub(hubConfig({ home: home.home, port: 0 }), frontend);
    if ("exists" in started) throw new Error("test bug: hub did not start");
    hubs.push(started);

    let fenceTriggered = false;
    let fenceClose: Promise<void> | undefined;
    let supersedeClose: Promise<void> | undefined;
    const stopTestFence = startFence(
      started.paths.socketPath,
      started.identity,
      () => {
        fenceTriggered = true;
        // Both callers enter close() from the same fence callback turn, matching the real
        // fence/supersede re-entry hazard rather than merely making two sequential calls.
        fenceClose = started.close("fence");
        supersedeClose = started.close("superseded");
      },
      30_000,
      1,
    );
    unlinkSync(started.paths.socketPath);

    await waitFor(() => fenceTriggered, 5_000);
    await Promise.all([fenceClose!, supersedeClose!, started.closed]);
    stopTestFence();
    expect(frontendClosed).toBe(1);
    const lines = readFileSync(started.paths.logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg: string; reason?: string });
    expect(lines.filter((line) => line.msg === "hub closing")).toEqual([expect.objectContaining({ reason: "fence" })]);
    expect(lines.filter((line) => line.msg === "hub closed")).toEqual([expect.objectContaining({ reason: "fence" })]);
  }, 15_000);

  it("after DB self-restart, valid cookies and SSE reconnect while expired/revoked cookies stay rejected", async () => {
    const home = sandboxHome();
    homes.push(home);
    const store = restartableStore();
    seedLanUser(store, { username: "alice", password: "correct-horse-battery" });
    const port = await freePort();
    const first = await startLanHub(home.home, port, store);
    hubs.push(first);
    const lanPort = first.lanStatus();
    if (lanPort?.state !== "on") throw new Error("test bug: LAN did not start");

    const validCookie = await login(lanPort.port, "alice", "correct-horse-battery");
    const expiredCookie = await login(lanPort.port, "alice", "correct-horse-battery");
    const revokedCookie = await login(lanPort.port, "alice", "correct-horse-battery");
    const expiredRecord = store.sessionsBySidHash.get(sidHash(expiredCookie));
    if (expiredRecord === undefined) throw new Error("test bug: expired session was not persisted");
    expiredRecord.expiresAt = Date.now() - 1;

    const logout = await lanPostJson(lanPort.port, "/api/logout", {}, { Cookie: revokedCookie });
    expect(logout.status).toBe(200);

    const oldSse = await openSse(lanPort.port, { cookie: validCookie });
    sse.push(oldSse);
    await oldSse.waitFor((event) => event.event === "hello");

    // This is the shipped P-A' path: the DB client asks the hub to use the existing admin
    // restart path. No private close/re-open or LAN listener resurrection is used by the test.
    store.triggerRestart();
    await Promise.all([first.closed, oldSse.waitEnd(10_000)]);
    expect(await first.closed).toBe("restart");

    const successor = await startLanHub(home.home, lanPort.port, store);
    hubs.push(successor);
    const successorStatus = successor.lanStatus();
    if (successorStatus?.state !== "on") throw new Error("test bug: successor LAN did not start");

    const valid = await lanRequest(successorStatus.port, { path: "/api/session", headers: { Cookie: validCookie } });
    const expiredResponse = await lanRequest(successorStatus.port, {
      path: "/api/session",
      headers: { Cookie: expiredCookie },
    });
    const revoked = await lanRequest(successorStatus.port, {
      path: "/api/session",
      headers: { Cookie: revokedCookie },
    });
    expect(valid.status).toBe(200);
    expect(expiredResponse.status).toBe(401);
    expect(revoked.status).toBe(401);

    const reconnected = await openSse(successorStatus.port, { cookie: validCookie });
    sse.push(reconnected);
    await reconnected.waitFor((event) => event.event === "hello");
    expect(reconnected.status).toBe(200);
  }, 25_000);

  it("under sustained slow DB calls, interactive admission and child respawns stay bounded", async () => {
    const home = sandboxHome();
    homes.push(home);
    const store = fakeLanStore();
    seedLanUser(store, { username: "alice", password: "correct-horse-battery" });

    const dbFile = join(home.home, "slow.db");
    await migrateDb(dbFile);
    let spawnCount = 0;
    let dbAttempts = 0;
    let maxAdmitted = 0;
    let busyRejected = 0;
    const slowDb = createDbClient({
      dbFile,
      test: true,
      deadlineMs: 500,
      interactiveSlots: 2,
      queueSlots: 3,
      reservedQueueSlots: 1,
      backoffMs: [1],
      maxRestartsInWindow: 2,
      restartCooldownMs: 60_000,
      spawnFn: ((...args: Parameters<typeof spawn>) => {
        spawnCount++;
        const child = spawn(...args) as ChildProcessWithoutNullStreams;
        children.push(child);
        return child;
      }) as typeof spawn,
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    dbClients.push(slowDb);
    // Eagerly spawned children are observable only through a completed request; warm the
    // resident process before measuring admission so startup cannot make the first burst look
    // larger than the configured queue.
    await expect(slowDb.call("getUser", { username: "admin" })).resolves.toBeDefined();

    const trackedBlock = async (): Promise<void> => {
      dbAttempts++;
      try {
        await slowDb.call("__block", { ms: 10_000 });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as { code?: string }).code === "E_BUSY") {
          busyRejected++;
        }
        throw error;
      }
    };

    const originalTouch = store.touchSession;
    store.touchSession = async (sid, now, opts) => {
      await trackedBlock();
      return originalTouch(sid, now, opts);
    };

    const first = await startLanHub(home.home, await freePort(), store as RestartableStore);
    hubs.push(first);
    const status = first.lanStatus();
    if (status?.state !== "on") throw new Error("test bug: LAN did not start");
    // `/api/session` deliberately deduplicates concurrent validation of the same SID. Use
    // distinct real cookies so this matrix exercises the DB client's global interactive queue,
    // rather than the per-session waiter cap.
    const cookies: string[] = [];
    for (let i = 0; i < 8; i++) cookies.push(await login(status.port, "alice", "correct-horse-battery"));

    const wave = async (): Promise<void> => {
      const attemptsBefore = dbAttempts;
      const rejectedBefore = busyRejected;
      const responses = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          lanRequest(status.port, { path: "/api/session", headers: { Cookie: cookies[i % cookies.length]! } }).catch(
            () => undefined,
          ),
        ),
      );
      expect(responses).toHaveLength(24);
      // The HTTP layer has a per-SID coalescer, so the distinct real cookies above ensure this
      // matrix exercises the DB client's global queue through the actual LAN auth path.
      const admitted = dbAttempts - attemptsBefore - (busyRejected - rejectedBefore);
      maxAdmitted = Math.max(maxAdmitted, admitted);
    };

    await wave();
    await waitFor(() => spawnCount >= 2, 5_000);
    await wave();
    await waitFor(() => slowDb.unavailable, 5_000);

    // Open admission is fail-fast: once the breaker is open, no later call can create a third
    // child. The two slow waves above are enough to exercise both the active and queued paths.
    expect(maxAdmitted).toBeLessThanOrEqual(2 + 3);
    expect(maxAdmitted).toBeGreaterThan(0);
    expect(busyRejected).toBeGreaterThan(0);
    expect(spawnCount).toBe(2);
  }, 25_000);
});
