/**
 * D + A, end to end with REAL processes: a real `hub/main.ts` child (booted with a STALE launcher
 * config, like a pi that activated before the release) is restarted by the real
 * `scripts/release/restart-hub.ts` CLI over hub.sock; then a second stale-config "session"
 * respawns the hub (what a reconnecting pi does) and the CLI must observe a new hub whose version
 * equals this checkout's package.json — i.e. whoever respawns, the version is the disk's.
 * Also pins the two skip branches (no hub; stop marker) at process level.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HUB_MAIN = resolve("src/web-hub/hub/main.ts");
const CLI = resolve("scripts/release/restart-hub.ts");
const PKG_VERSION = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }).version;

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null) {
      c.kill("SIGKILL");
      await new Promise<void>((r) => c.once("exit", () => r()));
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "pwh-rs-"));
  dirs.push(d);
  return d;
}

function staleConfig(home: string): string {
  return JSON.stringify({
    v: 1,
    home,
    port: 0,
    idleExitMinutes: 10,
    pluginVersion: "0.0.1-stale",
    buildId: "0.0.1-stale@deadbeef",
  });
}

function startHubChild(home: string): ChildProcess {
  const c = spawn(process.execPath, ["--import", "tsx", HUB_MAIN], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: home, PI_WEBHUB_CONFIG: staleConfig(home) },
  });
  children.push(c);
  return c;
}

function readHubJson(home: string): { pid?: number; version?: string; buildId?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(home, ".pi", "agent", "web-hub", "hub.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function until<T>(fn: () => T | undefined | false, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    await sleep(50);
  }
  return undefined;
}

function runCli(home: string, args: string[] = []): { done: Promise<{ code: number | null; out: string }> } {
  const c = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home },
  });
  children.push(c);
  let out = "";
  c.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
  c.stderr?.on("data", (b: Buffer) => (out += b.toString("utf8")));
  return { done: new Promise((r) => c.once("exit", (code) => r({ code, out }))) };
}

describe("restart-hub CLI × real hub", () => {
  it("restarts a stale-config hub; a stale-config respawn comes up at the disk version", async () => {
    const home = tmpHome();
    const hubA = startHubChild(home);
    const recA = await until(() => {
      const r = readHubJson(home);
      return r?.pid === hubA.pid ? r : undefined;
    }, 30_000);
    expect(recA, "hub A did not publish hub.json").toBeDefined();
    expect(recA!.version).toBe(PKG_VERSION); // A: even the FIRST hub is already self-versioned

    const cli = runCli(home, ["--wait-ms", "30000"]);
    // Once hub A has exited, play the reconnecting pi session: respawn with the SAME stale config.
    await new Promise<void>((r) => hubA.once("exit", () => r()));
    const hubB = startHubChild(home);

    const { code, out } = await cli.done;
    expect(code, out).toBe(0);
    expect(out).toContain(`new pid ${hubB.pid}`);
    expect(out).toContain(`v${PKG_VERSION} (matches package.json)`);
    expect(out).toContain("[OK]");
    const recB = readHubJson(home);
    expect(recB?.pid).toBe(hubB.pid);
    expect(recB?.version).toBe(PKG_VERSION);
    expect(hubA.exitCode).toBe(0); // the restart was a graceful close, not a kill
  }, 90_000);

  it("no hub running ⇒ exit 0 with a single INFO (release never blocked)", async () => {
    const home = tmpHome();
    const { code, out } = await runCli(home).done;
    expect(code, out).toBe(0);
    expect(out).toContain("[INFO]");
    expect(out).toContain("nothing to restart");
  }, 30_000);

  it("stop marker present ⇒ the running hub is left alone", async () => {
    const home = tmpHome();
    const hub = startHubChild(home);
    await until(() => readHubJson(home)?.pid === hub.pid || undefined, 30_000);
    const stateDir = join(home, ".pi", "agent", "web-hub");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "stopped"), `${JSON.stringify({ v: 1, at: Date.now(), pid: 1, by: "test" })}\n`);
    const { code, out } = await runCli(home).done;
    expect(code, out).toBe(0);
    expect(out).toContain("leaving it stopped");
    await sleep(300);
    expect(hub.exitCode).toBeNull(); // still running
  }, 60_000);
});
