import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireConnection, releaseConnection, type HubConnection } from "../../src/web-hub/agent/connection.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createReqDeadline } from "../../src/web-hub/hub/req-deadline.js";
import { parseHubSpawnConfig } from "../../src/web-hub/hub/spawn/config.js";
import type { SpawnSupervisor } from "../../src/web-hub/hub/spawn/supervisor.js";
import type { FrontendFactory, LanAssembly } from "../../src/web-hub/hub/ports.js";
import { LanAssemblyOffError } from "../../src/web-hub/hub/lan-assembly.js";
import { SUPERSEDE_YIELD_MS } from "../../src/web-hub/hub/supersede.js";
import { resolveHubPaths, webHubSpawnFiles } from "../../src/web-hub/protocol/paths.js";
import { SETTINGS } from "../web-hub/agent/helpers.js";
import { config, connectClient, hello, tmpDirs, waitFor, type TestClient } from "../web-hub/hub/helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];
const clients: TestClient[] = [];
const connections: HubConnection[] = [];
const children: ChildProcess[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const c of connections.splice(0)) {
    c.close("test");
    releaseConnection(c);
  }
  for (const c of clients.splice(0)) c.sock.destroy();
  for (const h of hubs.splice(0)) await h.close("test");
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5_000);
    }
  }
  tmp.cleanup();
});

function latch() {
  let release = (): void => {};
  const pending = new Promise<void>((r) => {
    release = r;
  });
  releases.push(release);
  return { pending, release };
}

function assertClosed(home: string, reason: string) {
  const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
  expect(existsSync(paths.hubJson)).toBe(false);
  expect(existsSync(paths.socketPath)).toBe(false);
  const logs = readFileSync(paths.logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { msg: string; reason?: string });
  expect(logs.filter((l) => l.msg === "hub started")).toEqual([]);
  expect(logs.filter((l) => l.msg === "supersede restart failed")).toEqual([]);
  expect(logs.filter((l) => l.msg === "hub closing")).toEqual([expect.objectContaining({ reason })]);
  expect(logs.filter((l) => l.msg === "hub closed")).toEqual([expect.objectContaining({ reason })]);
}

function newerAgent(home: string): HubConnection {
  const c = acquireConnection({
    pluginVersion: "2.0.0",
    buildId: "2.0.0@early-close",
    kind: "tui",
    cwd: home,
    paths: resolveHubPaths({ home, uid: process.getuid?.() ?? 0 }),
    settings: { ...SETTINGS, autoStart: false },
    launcher: { error: "no auto spawn in acceptance" },
    now: Date.now,
    random: () => 0.5,
    capsExtra: () => ["dialog.v1"],
  });
  connections.push(c);
  c.setSlot("dialogs", { t: "dialogs", epoch: c.epoch, open: [], closed: [] });
  return c;
}

describe("real startHub early close", () => {
  it("higher-version real connection supersedes once while post-registration ui.refresh is blocked", async () => {
    const home = tmp.make("wh-sup-early-");
    const gate = latch();
    let refreshing = false;
    const frontendClose = vi.fn();
    const frontend: FrontendFactory = (deps) => {
      const fe = createHttpFrontend(deps);
      const refresh = fe.ui.refresh;
      const close = fe.close;
      return {
        ...fe,
        close: async () => {
          frontendClose();
          await close();
        },
        ui: {
          ...fe.ui,
          refresh: async () => {
            refreshing = true;
            await gate.pending;
            return refresh();
          },
        },
      };
    };
    const started = startHub(config({ home }), frontend);
    await waitFor(() => refreshing);
    newerAgent(home);
    await expect(started).resolves.toEqual({ exists: false, closed: true, reason: "superseded" });
    expect(frontendClose).toHaveBeenCalledTimes(1);
    const log = readFileSync(resolveHubPaths({ home, uid: process.getuid?.() ?? 0 }).logFile, "utf8");
    expect(log.match(/"op":"supersede"/g)).toHaveLength(1);
    expect(log).toContain('"from":"1.2.3","to":"2.0.0"');
    assertClosed(home, "superseded");
    gate.release();
    await Promise.resolve();
    assertClosed(home, "superseded");
  }, 15_000);

  it("admin restart in the earlier LAN assembly window broadcasts own-version superseded once, then closes", async () => {
    const home = tmp.make("wh-admin-early-");
    const gate = latch();
    let assembling = false;
    const cleanup = vi.fn();
    const frontend = vi.fn(createHttpFrontend);
    const lanAssembly: LanAssembly = {
      build: async ({ scope }) => {
        assembling = true;
        await gate.pending;
        scope.defer(cleanup);
        throw new LanAssemblyOffError("db-unavailable");
      },
    };
    const started = startHub(
      config({ home, lan: { port: 40002, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } }),
      frontend,
      { lanAssembly },
    );
    await waitFor(() => assembling);
    const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
    const c = await connectClient(paths.socketPath);
    clients.push(c);
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "hub_ctl", rid: "admin-early", op: "shutdown", reason: "restart" });
    await c.waitFrame((f) => f["t"] === "hub_ctl_ack");
    await c.waitFrame((f) => f["t"] === "superseded");
    await expect(started).resolves.toEqual({ exists: false, closed: true, reason: "restart" });
    expect(c.frames.filter((f) => (f as { t?: string }).t === "superseded")).toEqual([
      { t: "superseded", nextVersion: "1.2.3", yieldMs: SUPERSEDE_YIELD_MS },
    ]);
    expect(frontend).not.toHaveBeenCalled();
    assertClosed(home, "restart");
    gate.release();
    await waitFor(() => cleanup.mock.calls.length === 1);
    assertClosed(home, "restart");
  }, 15_000);

  it("real main.ts exits 0 for the closed-during-startup result without publishing running", async () => {
    const home = tmp.make("wh-main-closed-");
    // Block identityFields in the real entry process without adding a resource or ref'd timer.
    const loader = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const read = fs.readFile;
      fs.readFile = async function(path, ...args) {
        if (path === "/proc/self/stat") {
          console.log("IDENTITY_BLOCKED");
          await new Promise(() => {});
        }
        return read.call(this, path, ...args);
      };
      syncBuiltinESMExports();
    `;
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(loader)}`,
        "--import",
        "tsx",
        resolve("src/web-hub/hub/main.ts"),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, PI_WEBHUB_CONFIG: JSON.stringify(config({ home })) },
      },
    );
    children.push(child);
    let output = "";
    let errors = "";
    child.stdout!.on("data", (b) => {
      output += String(b);
    });
    child.stderr!.on("data", (b) => {
      errors += String(b);
    });
    await waitFor(() => output.includes("IDENTITY_BLOCKED") || child.exitCode !== null, 10_000);
    expect(output, errors).toContain("IDENTITY_BLOCKED");
    newerAgent(home);
    await waitFor(() => child.exitCode !== null, 10_000);
    expect(child.exitCode, errors).toBe(0);
    assertClosed(home, "superseded");
    const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
    expect(readFileSync(paths.logFile, "utf8")).toContain('"msg":"hub closed during startup, exiting"');
  }, 25_000);

  const historicalTagsAvailable = ["v0.3.0", "v0.4.0"].every((tag) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${tag}:src/web-hub/agent/connection.ts`], {
        timeout: 10_000,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false; // Shallow CI checkouts may omit historical tags; current-protocol tests still run.
    }
  });
  it.skipIf(!historicalTagsAvailable).each(["v0.3.0", "v0.4.0"])(
    "%s historical agent artifact understands admin restart's unchanged superseded frame",
    async (tag) => {
      const home = tmp.make("wh-compat-");
      const artifact = join(home, "artifact");
      mkdirSync(artifact);
      // Build/load the actual tagged implementation, not the current code with a changed label.
      const archive = execFileSync("git", ["archive", tag, "src/web-hub"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      execFileSync("tar", ["-x", "-C", artifact], { input: archive, timeout: 10_000 });
      writeFileSync(join(artifact, "package.json"), JSON.stringify({ type: "module" }));
      symlinkSync(resolve("node_modules"), join(artifact, "node_modules"), "dir");
      const hub = await startHub(config({ home, pluginVersion: "0.4.0" }), createHttpFrontend);
      if ("exists" in hub) throw new Error("compat hub not running");
      hubs.push(hub);
      const entry = pathToFileURL(join(artifact, "src/web-hub/agent/connection.ts")).href;
      const source = `
      const { acquireConnection } = await import(${JSON.stringify(entry)});
      const conn = acquireConnection({
        pluginVersion: ${JSON.stringify(tag.slice(1))}, buildId: ${JSON.stringify(tag)}, kind: "tui", cwd: ${JSON.stringify(home)},
        paths: ${JSON.stringify(hub.paths)}, settings: { autoStart: false },
        launcher: { error: "compatibility probe" }, now: Date.now,
      });
      conn.attach({
        onStateChange(v) { if (v.state === "live") console.log("READY"); },
        onSnapshotReq() {}, onBranchReq() {},
        onSuperseded(frame) {
          console.log(JSON.stringify({ frame, remaining: conn.yieldUntil - Date.now() }));
          conn.close("probe complete");
          process.exit(0);
        },
      }, { sessionId: "compat", cwd: ${JSON.stringify(home)}, reason: "startup", mode: "tui", leafId: null });
      const deadline = setTimeout(() => process.exit(2), 10000);
      deadline.unref();
      // A standalone agent probe needs one ref'd lifetime handle, like the real TUI.
      process.stdin.resume();
    `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: home },
      });
      children.push(child);
      let output = "";
      let errors = "";
      child.stdout!.on("data", (b) => {
        output += String(b);
      });
      child.stderr!.on("data", (b) => {
        errors += String(b);
      });
      await waitFor(() => output.includes("READY") || child.exitCode !== null, 10_000);
      expect(output, errors).toContain("READY");
      const c = await connectClient(hub.paths.socketPath);
      clients.push(c);
      c.send(hello({ pluginVersion: "0.4.0" }));
      await c.waitFrame((f) => f["t"] === "hello_ack");
      c.send({ t: "hub_ctl", rid: `compat-${tag}`, op: "shutdown", reason: "restart" });
      await hub.closed;
      await waitFor(() => child.exitCode !== null, 10_000);
      expect(child.exitCode, errors).toBe(0);
      const result = JSON.parse(output.split("\n").find((l) => l.startsWith("{"))!) as {
        frame: object;
        remaining: number;
      };
      expect(result.frame).toEqual({ t: "superseded", nextVersion: "0.4.0", yieldMs: SUPERSEDE_YIELD_MS });
      if (tag === "v0.3.0") {
        expect(result.remaining).toBeGreaterThan(9_000);
        expect(result.remaining).toBeLessThanOrEqual(SUPERSEDE_YIELD_MS);
      } else {
        expect(result.remaining).toBeLessThanOrEqual(0);
      }
    },
    25_000,
  );

  it.skipIf(process.platform !== "linux")(
    "L6: after early supersede, successor cannot restore-fork until the old child's death is confirmed",
    async () => {
      const home = tmp.make("wh-sup-l6-");
      const cwd = join(home, "proj");
      mkdirSync(cwd);
      writeFileSync(join(cwd, ".fake-pi-switches"), "--ignore-eof\n--ignore-term\n--no-hello\n");
      const pkg = join(home, "node_modules/@earendil-works/pi-coding-agent");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.2" }),
      );
      const cli = join(pkg, "pi.mjs");
      copyFileSync(resolve("tests/integration/fixtures/fake-rpc-pi.mjs"), cli);
      const spawnId = "earlyclosel60001";
      const old = spawn(process.execPath, [cli, "--mode", "rpc"], {
        cwd,
        stdio: "ignore",
        detached: true,
        env: { ...process.env, HOME: home, PI_WEBHUB_SPAWN_ID: spawnId },
      });
      children.push(old);
      await waitFor(() => existsSync(join(cwd, ".fake-pi-argv.log")), 5_000);
      const pid = old.pid!;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      const sessionFile = join(home, "old.jsonl");
      writeFileSync(
        sessionFile,
        JSON.stringify({ type: "session", version: 3, id: "sess-old", cwd, timestamp: new Date().toISOString() }) +
          "\n",
      );
      const st = statSync(cwd);
      writeFileSync(
        webHubSpawnFiles(paths.stateDir).spawnsJson,
        JSON.stringify({
          v: 2,
          gen: 1,
          writer: { pid: 1, startedAt: 0, bootId },
          records: [
            {
              spawnId,
              state: "live",
              cwd,
              dev: st.dev,
              ino: st.ino,
              createdAt: Date.now() - 60_000,
              updatedAt: Date.now(),
              owner: { listener: "loopback", reqId: "req-early-l60001" },
              pid,
              procStartTicks: ticks,
              bootId,
              uid: process.getuid?.() ?? 0,
              agentKey: "kold",
              sessionId: "sess-old",
              sessionFile,
              sessionPersisted: true,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const parsed = parseHubSpawnConfig({
        roots: [home],
        restore: true,
        history: false,
        maxProcesses: 4,
        maxPerPrincipal: 2,
        ratePerMinute: 30,
        maxLifetimeMinutes: 720,
        registerTimeoutS: 10,
        lan: "off",
      });
      if (!parsed.ok) throw new Error(parsed.detail);
      const cfg = config({ home, launcher: [process.execPath, cli], spawn: parsed.spawn });
      const gate = latch();
      let refreshing = false;
      let predecessorSup: SpawnSupervisor | undefined;
      const first = startHub(
        cfg,
        (deps) => {
          const fe = createHttpFrontend(deps);
          return {
            ...fe,
            ui: {
              ...fe.ui,
              refresh: async () => {
                refreshing = true;
                await gate.pending;
                return fe.ui.refresh();
              },
            },
          };
        },
        {
          spawnSeams: {
            // Keep the old process alive across close so successor's L6 proof is exercised,
            // rather than letting a real predecessor reaper make the assertion vacuous.
            reaper: {
              start: async () => true,
              available: true,
              track: () => {},
              untrack: () => {},
              close: () => {},
              onUnavailable: () => () => {},
              onRestart: () => () => {},
            },
            wrapSupervisor: (sup) => {
              predecessorSup = sup;
              return { ...sup, shutdown: (_deadline, opts) => sup.shutdown(createReqDeadline(Date.now, 0), opts) };
            },
          },
        },
      );
      await waitFor(() => refreshing);
      expect(predecessorSup!.deathOf(spawnId)).toBe("alive");
      newerAgent(home);
      await expect(first).resolves.toEqual({ exists: false, closed: true, reason: "superseded" });
      assertClosed(home, "superseded");
      expect(old.exitCode).toBeNull();
      expect(old.signalCode).toBeNull();
      gate.release();
      for (const c of connections.splice(0)) {
        c.close("successor test");
        releaseConnection(c);
      }
      let successorSup: SpawnSupervisor | undefined;
      const deathAtFork: string[] = [];
      const successor = await startHub({ ...cfg, pluginVersion: "2.0.0" }, createHttpFrontend, {
        spawnSeams: {
          wrapSupervisor: (sup) => {
            successorSup = sup;
            return sup;
          },
          spawnFn: (cmd, args, opts) => {
            // restoreForkSync clears the old identity from the record before spawnFn;
            // independently re-prove its death from the captured old pid at the fork instant.
            let death = "unknown";
            try {
              const s = readFileSync(`/proc/${pid}/stat`, "utf8");
              const fields = s.slice(s.lastIndexOf(")") + 2).split(" ");
              death = fields[0] === "Z" || Number(fields[19]) !== ticks ? "confirmed" : "alive";
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ENOENT") death = "confirmed";
            }
            deathAtFork.push(death);
            const child = spawn(cmd, args, opts);
            children.push(child);
            return child;
          },
        },
      });
      if ("exists" in successor) throw new Error("successor failed to run");
      hubs.push(successor);
      expect(successorSup!.deathOf(spawnId)).toBe("alive");
      expect(deathAtFork).toEqual([]);
      await waitFor(() => deathAtFork.length === 1, 12_000);
      expect(deathAtFork).toEqual(["confirmed"]);
      await waitFor(() => old.signalCode !== null, 5_000);
      expect(old.signalCode).toBe("SIGKILL");
    },
    30_000,
  );
});
