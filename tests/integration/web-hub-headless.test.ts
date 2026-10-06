/**
 * web-hub-spawn plan §SP13 — the S1 hard-gate integration suite (H1–H3, H5–H8 plus the
 * non-gate closure cases), run against REAL hub processes and REAL fake `pi --mode rpc` children.
 *
 * Two lift modes, both real:
 *
 *  A. REAL HUB CHILD PROCESSES (H1–H3): `spawnHub` + pi's bundled jiti — the exact production
 *     fork path from `agent/launcher.ts`, with `PI_WEBHUB_CONFIG` carrying a spawn-enabled
 *     `HubConfig` whose `launcher` points at a fixture tree (`node_modules/@earendil-works/
 *     pi-coding-agent/package.json` v1.0.2 + a `pi.mjs` copy of `fixtures/fake-rpc-pi.mjs`) so
 *     SP7's launcher version chain runs for real. Orphan/ladder semantics need the hub PROCESS
 *     to die — nothing in-process can reproduce that. Skipped when pi's bundled jiti is not
 *     resolvable (CI without the dev dependency) or off Linux (spawn is Linux-only, fail-closed).
 *
 *  B. IN-PROCESS REAL ASSEMBLY (H5–H8 + closure): real `startHub` + real `createHttpFrontend`
 *     in this process, but every spawn still forks a REAL fake-pi child (real /proc identity,
 *     real signals, real timing — only relaxed assertion bounds). The in-process mode alone
 *     skips `hub/main.ts`'s strict `parseHubSpawnConfig` re-validation, so these tests use
 *     sub-floor tunings (`registerTimeoutS: 2-3`, a 3s lifetime) as the H6 test hooks the
 *     plan intended; the production floor (10s / 10min) is enforced by SP2's own tests.
 *
 * Per-child behavior switches ride `.fake-pi-switches` in the spawn cwd (the hub's fork argv
 * and env stay byte-identical to production — see the fixture's header). Assertion bounds are
 * deliberately relaxed vs the wire constants (L3's 12s bound asserted as ≤14s wall clock):
 * these are real schedulers, not fake timers.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJitiCli, spawnHub, type LauncherPlan } from "../../src/web-hub/agent/launcher.js";

import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { HubConfig, HubLanConfig } from "../../src/web-hub/hub/ports.js";
import { hasNodeSqlite } from "../../src/web-hub/hub/db.js";
import { resolveHubPaths, webHubSpawnFiles } from "../../src/web-hub/protocol/paths.js";
import { STDERR_FILE_MAX } from "../../src/web-hub/protocol/spawn.js";
import type {
  HubSpawnConfig,
  SpawnsPayload,
  SpawnRecordPublic,
  SpawnRecordOwner,
} from "../../src/web-hub/protocol/spawn.js";
import type { LanInfoPayload, LanResFrame } from "../../src/web-hub/protocol/messages.js";
import { config as hubConfig, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, rawRequest, type SseConn } from "../web-hub/http/helpers.js";
import { lanPostJson, lanRequest } from "../web-hub/http/lan-helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const HUB_MAIN = resolve("src/web-hub/hub/main.ts");
const FAKE_PI = resolve("tests/integration/fixtures/fake-rpc-pi.mjs");
const IS_LINUX = process.platform === "linux";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function projDir(home: string, name: string, switches: string[] = []): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  if (switches.length > 0) writeFileSync(join(dir, ".fake-pi-switches"), `${switches.join("\n")}\n`);
  return dir;
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

async function waitPidGone(pid: number | undefined, ms: number, what: string): Promise<void> {
  await waitUntil(() => !pidAlive(pid), ms, what);
  expect(pidAlive(pid)).toBe(false);
}

function kill9(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Scan /proc for the hub's reaper watchdog (its inline script carries this literal). */
function findReaperPid(): number | undefined {
  if (!IS_LINUX) return undefined;
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      try {
        const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
        if (cmdline.includes("web-hub spawn reaper")) return Number(name);
      } catch {
        /* other uid / gone */
      }
    }
  } catch {
    /* /proc unreadable */
  }
  return undefined;
}

/** Fixture launcher tree satisfying SP7's version chain: a pi-named package v1.0.2 + a .mjs entry. */
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

interface StoredRecord {
  spawnId: string;
  state?: string;
  pid?: number;
  endReason?: string;
  procStartTicks?: number;
  hint?: string;
  firstPrompt?: { state?: string };
}

function readSpawnsJson(stateDir: string): StoredRecord[] {
  const file = webHubSpawnFiles(stateDir).spawnsJson;
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { records?: StoredRecord[] };
  return parsed.records ?? [];
}

function recordOf(stateDir: string, spawnId: string): StoredRecord | undefined {
  return readSpawnsJson(stateDir).find((r) => r.spawnId === spawnId);
}

function stderrLog(stateDir: string, spawnId: string): string {
  const file = join(webHubSpawnFiles(stateDir).logDir, `${spawnId}.stderr.log`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

let idCounter = 0;
function spawnReqId(): string {
  idCounter += 1;
  return `sp${Date.now().toString(36)}${idCounter.toString(36).padStart(8, "0")}`; // 2+8+8 = 18 chars (SPAWN_ID_RE ≥16)
}

function cleanupHome(sandbox: { home: string; restore: () => void } | undefined): void {
  if (sandbox === undefined) return;
  sandbox.restore();
  if (process.env.KEEP_SANDBOX === undefined) {
    rmSync(sandbox.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } else {
    console.log(`[KEEP_SANDBOX] home kept: ${sandbox.home}`);
  }
}

/** A pre-allocated fixed port — the LAN host allow-list keys carry the CONFIG port, so an
 * ephemeral `port: 0` would 421 every dial (the snapshot is computed before listen()). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// mode A — real hub child processes (jiti), H1–H3
// ---------------------------------------------------------------------------

function jitiPlan(): LauncherPlan | undefined {
  if (!existsSync(PI_CLI)) {
    console.log(`web-hub-headless: SKIP mode A — pi CLI not found at ${PI_CLI}`);
    return undefined;
  }
  const r = resolveJitiCli({ argv1: PI_CLI, override: "" });
  if (!r.ok) {
    console.log(`web-hub-headless: SKIP mode A — ${r.reason}`);
    return undefined;
  }
  return { execPath: process.execPath, jitiCli: r.jitiCli, argv1: PI_CLI };
}

const PLAN = jitiPlan();

function hubJsonOf(home: string): { pid?: number; port?: number } {
  const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
  try {
    const j = JSON.parse(readFileSync(paths.hubJson, "utf8")) as { pid?: unknown; port?: unknown };
    return {
      pid: typeof j.pid === "number" ? j.pid : undefined,
      port: typeof j.port === "number" ? j.port : undefined,
    };
  } catch {
    return {};
  }
}

interface ChildHub {
  home: string;
  stateDir: string;
  pid: number;
  port: number;
  cookie: string;
}

describe.skipIf(!IS_LINUX || PLAN === undefined)("web-hub headless e2e — real hub child processes (H1–H3)", () => {
  let sandbox: ReturnType<typeof sandboxHome> | undefined;
  const hubPids = new Set<number>();
  const extraPids = new Set<number>();

  function childSpawnCfg(home: string): HubSpawnConfig {
    return {
      roots: [home],
      maxProcesses: 4,
      maxPerPrincipal: 2,
      ratePerMinute: 30,
      maxLifetimeMinutes: 720,
      registerTimeoutS: 30,
      lan: "off",
    };
  }

  /** `excludePid`: a hub.json naming a hub we just SIGKILL'd is STALE — a re-boot on the same
   * home must wait for a pid that is different AND alive, never the dead incumbent's. */
  async function bootHub(home: string, excludePid?: number): Promise<ChildHub> {
    const cfg = hubConfig({
      home,
      port: 0,
      idleExitMinutes: 10,
      pluginVersion: "1.2.3",
      launcher: fakeLauncher(home),
      spawn: childSpawnCfg(home),
    });
    spawnHub(PLAN!, HUB_MAIN, cfg);
    await waitUntil(
      () => {
        const { pid } = hubJsonOf(home);
        return pid !== undefined && pid !== excludePid && pidAlive(pid);
      },
      15_000,
      `child hub up (exclude ${excludePid ?? "-"})`,
    );
    const { pid, port } = hubJsonOf(home);
    if (pid === undefined || port === undefined) throw new Error("hub.json missing pid/port");
    hubPids.add(pid);
    const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
    const cookie = await login(port, paths.tokenFile);
    return { home, stateDir: paths.stateDir, pid, port, cookie };
  }

  /** Two-step loopback spawn (a sandbox cwd is never in the known set); returns the 202 body. */
  async function spawnFake(hub: ChildHub, cwd: string, body: Record<string, unknown> = {}) {
    const id = spawnReqId();
    const headers = { Cookie: hub.cookie, Origin: `http://127.0.0.1:${hub.port}` };
    const first = await postJson(hub.port, "/api/headless", { id, cwd, ...body }, headers);
    expect([202, 409]).toContain(first.status);
    if (first.status === 202) return JSON.parse(first.body) as { spawnId: string; state: string };
    const resolved = JSON.parse(first.body) as { resolvedCwd: string };
    const second = await postJson(
      hub.port,
      "/api/headless",
      { id, cwd, confirm: true, expectCwd: resolved.resolvedCwd, ...body },
      headers,
    );
    expect(second.status).toBe(202);
    return JSON.parse(second.body) as { spawnId: string; state: string };
  }

  async function waitPidOf(hub: ChildHub, spawnId: string): Promise<number> {
    await waitUntil(() => recordOf(hub.stateDir, spawnId)?.pid !== undefined, 15_000, "record carries pid");
    return recordOf(hub.stateDir, spawnId)!.pid!;
  }

  afterEach(async () => {
    for (const pid of extraPids) kill9(pid);
    extraPids.clear();
    for (const pid of hubPids) kill9(pid);
    await waitUntil(() => [...hubPids].every((p) => !pidAlive(p)), 5_000, "child hubs killed").catch(() => undefined);
    hubPids.clear();
    cleanupHome(sandbox);
    sandbox = undefined;
  });

  it("H1: hub SIGKILL ⇒ stdin-EOF-answering child exits ≤4s (the orderly shutdown lever)", async () => {
    sandbox = sandboxHome();
    const hub = await bootHub(sandbox.home);
    const cwd = projDir(sandbox.home, "proj");
    const accepted = await spawnFake(hub, cwd);
    expect(accepted.state).toBe("starting");
    const childPid = await waitPidOf(hub, accepted.spawnId);
    kill9(hub.pid);
    await waitPidGone(childPid, 4_000, "H1 child exits after hub kill -9 (stdin EOF)");
  }, 40_000);

  it("H2: hub SIGKILL, ignore-eof child, no further hub ⇒ reaper ladder kills it ≤14s; reaper exits ≤11s (L2/L3)", async () => {
    sandbox = sandboxHome();
    const hub = await bootHub(sandbox.home);
    const cwd = projDir(sandbox.home, "proj", ["--ignore-eof", "--ignore-term"]);
    const accepted = await spawnFake(hub, cwd);
    const childPid = await waitPidOf(hub, accepted.spawnId);
    extraPids.add(childPid);
    await waitUntil(() => findReaperPid() !== undefined, 8_000, "reaper child visible in /proc");
    const reaperPid = findReaperPid()!;

    kill9(hub.pid);
    hubPids.delete(hub.pid);
    // no new hub is ever started for this home — the orphan must vanish via the reaper alone
    await waitPidGone(childPid, 14_000, "H2 orphan gone ≤14s (5s grace + TERM + 3s + KILL + slack)");
    await waitPidGone(reaperPid, 11_000, "H2 reaper itself exits ≤11s (10s hard cap + slack)");
  }, 45_000);

  it("H6 (flood/RSS cells): 50 MiB stderr flood ⇒ sink file capped, real hub process RSS growth <32 MiB", async () => {
    sandbox = sandboxHome();
    const hub = await bootHub(sandbox.home);
    const cwd = projDir(sandbox.home, "flood", ["--stderr-flood", "50"]);
    const vmRssKb = (): number => {
      const status = readFileSync(`/proc/${hub.pid}/status`, "utf8");
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      if (m === null) throw new Error("no VmRSS in hub /proc status");
      return Number(m[1]);
    };
    // Warmup first: a first 50 MiB burst grows V8's old space by ~30 MiB of pure allocator
    // retention (the ~800 pipe-chunk buffers await an idle major GC that a quiet hub may not
    // run for a long time) — that is Node behavior, not sink behavior. The gate's intent is
    // BOUNDED sink memory, so the measurement is the marginal steady-state delta: warm the
    // allocator with one small flood, settle, THEN measure the real 50 MiB pass against it.
    const warmup = await spawnFake(hub, projDir(sandbox!.home, "warm", ["--stderr-flood", "10"]));
    extraPids.add(await waitPidOf(hub, warmup.spawnId));
    const warmSink = join(webHubSpawnFiles(hub.stateDir).logDir, `${warmup.spawnId}.stderr.log`);
    await waitUntil(
      () => existsSync(warmSink) && readFileSync(warmSink, "utf8").includes("[truncated "),
      20_000,
      "warmup flood absorbed",
    );
    await new Promise((r) => setTimeout(r, 2_000)); // let the hub settle after boot+warmup
    const rssBeforeKb = vmRssKb();
    const accepted = await spawnFake(hub, cwd);
    const childPid = await waitPidOf(hub, accepted.spawnId);
    extraPids.add(childPid);
    const sinkFile = join(webHubSpawnFiles(hub.stateDir).logDir, `${accepted.spawnId}.stderr.log`);
    // The sink STOPS writing at STDERR_FILE_MAX with a `[truncated N bytes]` marker — the
    // fake's own trailing STDERR-FLOOD-DONE line can never land in the capped file, so the
    // marker IS the "flood fully absorbed" signal.
    await waitUntil(
      () => existsSync(sinkFile) && readFileSync(sinkFile, "utf8").includes("[truncated "),
      30_000,
      "stderr flood absorbed (sink hit its file cap)",
    );
    expect(statSync(sinkFile).size).toBeLessThanOrEqual(STDERR_FILE_MAX + 1_024);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(vmRssKb() - rssBeforeKb).toBeLessThan(32 * 1024);
  }, 120_000);

  it("H3: hub+reaper both SIGKILL ⇒ next hub's boot recovery TERM→KILL, record exited{orphan}; corrupted starttime ⇒ no signal", async () => {
    sandbox = sandboxHome();
    // ---- round 1: healthy recovery --------------------------------------
    let hub = await bootHub(sandbox.home);
    const cwd = projDir(sandbox.home, "proj", ["--ignore-eof", "--ignore-term"]);
    const accepted = await spawnFake(hub, cwd);
    const childPid = await waitPidOf(hub, accepted.spawnId);
    extraPids.add(childPid);
    await waitUntil(() => findReaperPid() !== undefined, 8_000, "reaper visible");
    const reaperPid = findReaperPid()!;
    kill9(reaperPid);
    kill9(hub.pid);
    hubPids.delete(hub.pid);
    await waitUntil(() => !pidAlive(hub.pid) && !pidAlive(reaperPid), 3_000, "hub+reaper dead");
    expect(pidAlive(childPid)).toBe(true); // orphaned; its record stays non-terminal on disk

    hub = await bootHub(sandbox.home, hub.pid); // the new hub's init() owns the recovery
    await waitUntil(
      () => recordOf(hub.stateDir, accepted.spawnId)?.endReason === "orphan",
      15_000,
      "recovered record exited{orphan}",
    );
    await waitPidGone(childPid, 12_000, "H3 orphan killed by boot recovery (setImmediate TERM, +3s KILL)");
    extraPids.delete(childPid);
    expect(recordOf(hub.stateDir, accepted.spawnId)!.state).toBe("exited");

    // ---- round 2: corrupted starttime ⇒ L5 verify fails ⇒ NO signal ever ------------
    const cwd2 = projDir(sandbox.home, "proj2", ["--ignore-eof", "--ignore-term"]);
    const accepted2 = await spawnFake(hub, cwd2);
    const child2 = await waitPidOf(hub, accepted2.spawnId);
    extraPids.add(child2);
    await waitUntil(() => findReaperPid() !== undefined, 8_000, "reaper 2 visible");
    const reaper2 = findReaperPid()!;
    kill9(reaper2);
    kill9(hub.pid);
    hubPids.delete(hub.pid);
    await waitUntil(() => !pidAlive(hub.pid), 3_000, "hub 2 dead");
    // corrupt the persisted starttime while nobody owns the file
    const spawnsFile = webHubSpawnFiles(hub.stateDir).spawnsJson;
    const raw = JSON.parse(readFileSync(spawnsFile, "utf8")) as { records?: StoredRecord[]; writer?: unknown };
    const rec2 = (raw.records ?? []).find((r) => r.spawnId === accepted2.spawnId);
    expect(rec2?.procStartTicks).toBeDefined();
    rec2!.procStartTicks = (rec2!.procStartTicks ?? 0) + 40;
    writeFileSync(spawnsFile, JSON.stringify(raw));

    const hub3 = await bootHub(sandbox.home, hub.pid);
    await waitUntil(
      () => recordOf(hub3.stateDir, accepted2.spawnId)?.endReason === "orphan",
      15_000,
      "corrupt round also finalizes the record (terminal without any signal)",
    );
    await new Promise((r) => setTimeout(r, 5_000)); // a mis-sent TERM would have landed by now
    expect(pidAlive(child2)).toBe(true); // L5: wrong starttime ⇒ no signal, process untouched
  }, 90_000);

  it("web-hub-delete-session plan v2 §7.3-4 (A9): live managed session remove() persists removeIntent → hub SIGKILL → next hub's boot recovery (TERM→KILL) + the §2.6 reconciliation timer confirm-delete it; the session jsonl is never touched", async () => {
    sandbox = sandboxHome();
    const hub = await bootHub(sandbox.home);
    // ignore-eof + ignore-term: the child must still be ALIVE the instant we SIGKILL the hub
    // (otherwise a plain stdin-EOF exit would race the crash and prove nothing about recovery).
    const cwd = projDir(sandbox.home, "proj", ["--ignore-eof", "--ignore-term"]);
    const accepted = await spawnFake(hub, cwd);
    const childPid = await waitPidOf(hub, accepted.spawnId);
    extraPids.add(childPid);

    // A real `pi` would own a session transcript under `<home>/.pi/agent/sessions/*.jsonl`;
    // fake-pi speaks no session protocol and writes none, so a sentinel file stands in for it —
    // the point is proving the WHOLE delete+recovery pipeline never touches anything outside
    // `spawns.json`, not re-deriving pi's own session-file naming scheme.
    const sessionsDir = join(sandbox.home, ".pi", "agent", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const jsonlFile = join(sessionsDir, "dummy-session.jsonl");
    const jsonlSentinel = `{"sentinel":"${Date.now().toString(36)}"}\n`;
    writeFileSync(jsonlFile, jsonlSentinel);

    // live: hello+session negotiate normally (only EOF/TERM are ignored)
    await waitUntil(() => recordOf(hub.stateDir, accepted.spawnId)?.state === "live", 15_000, "managed child live");

    const ownerRes = await rawRequest(hub.port, {
      path: "/api/headless",
      headers: { Cookie: hub.cookie, "X-PWH": "1" },
    });
    expect(ownerRes.status).toBe(200);
    const owner = JSON.parse(ownerRes.body) as { items: SpawnRecordOwner[] };
    const agentKey = owner.items.find((i) => i.spawnId === accepted.spawnId)?.agentKey;
    expect(agentKey).toBeDefined();

    const rm = await postJson(
      hub.port,
      "/api/agents/remove",
      { agentKey },
      { Cookie: hub.cookie, Origin: `http://127.0.0.1:${hub.port}` },
    );
    expect(rm.status).toBe(202);
    expect(JSON.parse(rm.body)).toMatchObject({ removed: false, pending: true, state: "stopping" });

    // §2.2 L1 discipline: the remove intent is synced to spawns.json BEFORE anything else, so it
    // survives a crash landing anywhere after the 202.
    await waitUntil(
      () => recordOf(hub.stateDir, accepted.spawnId)?.state === "stopping",
      5_000,
      "record entered stopping",
    );
    const spawnsFile = webHubSpawnFiles(hub.stateDir).spawnsJson;
    const onDiskBeforeKill = JSON.parse(readFileSync(spawnsFile, "utf8")) as {
      records?: Array<Record<string, unknown>>;
    };
    const recBeforeKill = (onDiskBeforeKill.records ?? []).find((r) => r["spawnId"] === accepted.spawnId);
    expect(recBeforeKill?.["removeIntent"]).toBe(true);
    expect(pidAlive(childPid)).toBe(true); // ignore-eof/ignore-term: still alive, deletion only pending

    // crash the hub mid-delete — the intent is already on disk, the child is still orphaned-alive
    kill9(hub.pid);
    hubPids.delete(hub.pid);
    await waitUntil(() => !pidAlive(hub.pid), 3_000, "hub dead");
    expect(pidAlive(childPid)).toBe(true); // orphaned, not yet reaped

    // the next hub's init() owns the recovery: boot-recovery TERM→KILL (same ladder as H3) kills
    // the orphan, and the §2.6 reconciliation timer (RECOVER_KILL_AFTER_MS + EXIT_GUARD_MS ≈ 8s
    // after boot) deletes the now-confirmed-dead record once probeIdentity sees it gone.
    const hub2 = await bootHub(sandbox.home, hub.pid);
    await waitPidGone(childPid, 14_000, "§7.3-4 orphan killed by boot recovery (setImmediate TERM, +3s KILL)");
    extraPids.delete(childPid);
    await waitUntil(
      () => recordOf(hub2.stateDir, accepted.spawnId) === undefined,
      15_000,
      "§2.6 reconciliation timer deleted the confirmed-dead record",
    );

    // the new hub's own card/record listing never carries the deleted session
    const after = await rawRequest(hub2.port, {
      path: "/api/headless",
      headers: { Cookie: hub2.cookie, "X-PWH": "1" },
    });
    const afterBody = JSON.parse(after.body) as { items: SpawnRecordOwner[] };
    expect(afterBody.items.find((i) => i.spawnId === accepted.spawnId)).toBeUndefined();

    // B-alive/B-stream were exercised above; the session jsonl — the one file the whole feature
    // is forbidden from ever touching — is byte-identical to what it was before any of this ran.
    expect(readFileSync(jsonlFile, "utf8")).toBe(jsonlSentinel);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// mode B — in-process real assembly × REAL fake-pi children (H5–H8 + closure)
// ---------------------------------------------------------------------------

const NO_NODE_SQLITE = !(await hasNodeSqlite());

interface ProcHub {
  hub: RunningHub;
  port: number;
  stateDir: string;
  cookie: string;
}

const procHubs: RunningHub[] = [];
const procChildren = new Set<number>();
const sseConns: SseConn[] = [];

/** In-process default cfg; sub-floor timeouts are the H6 test hook (module comment). */
function procSpawnCfg(over: Partial<HubSpawnConfig> = {}): HubSpawnConfig {
  return {
    roots: [],
    maxProcesses: 4,
    maxPerPrincipal: 2,
    ratePerMinute: 30,
    maxLifetimeMinutes: 720,
    registerTimeoutS: 3,
    lan: "off",
    ...over,
  };
}

async function bootProcHub(spawn: HubSpawnConfig | undefined, home: string, lan?: HubLanConfig): Promise<ProcHub> {
  const cfg: HubConfig = hubConfig({
    home,
    port: 0,
    idleExitMinutes: 10,
    pluginVersion: "1.2.3",
    launcher: fakeLauncher(home),
    ...(spawn === undefined ? {} : { spawn }),
    ...(lan === undefined ? {} : { lan }),
  });
  const started = await startHub(cfg, createHttpFrontend, { uid: process.getuid?.() ?? 0, childUmask: 0o022 });
  if ("exists" in started) throw new Error("unexpected singleton collision");
  procHubs.push(started);
  const cookie = await login(started.httpPort, started.paths.tokenFile);
  return { hub: started, port: started.httpPort, stateDir: started.paths.stateDir, cookie };
}

async function waitChildrenGone(deadlineMs = 8_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (procChildren.size > 0 && Date.now() < deadline) {
    for (const pid of [...procChildren]) if (!pidAlive(pid)) procChildren.delete(pid);
    if (procChildren.size > 0) await new Promise((r) => setTimeout(r, 200));
  }
  for (const pid of [...procChildren]) kill9(pid); // defensive
  procChildren.clear();
}

describe.skipIf(!IS_LINUX)("web-hub headless e2e — real assembly × real fake-pi children (H5–H8 + closure)", () => {
  let sandbox: ReturnType<typeof sandboxHome> | undefined;
  let hub: ProcHub | undefined;

  /** `spawnOver` receives the fresh sandbox home (it runs AFTER the sandbox exists, fixing the
   * arg-eval order); returning `undefined` (H8) keeps the hub spawn-free — the DEFAULT (no arg)
   * is the standard enabled cfg, deliberately not expressible as `cfg ?? default` (that made
   * H8's explicit "off" silently re-enable the feature). */
  async function bringUp(
    spawnOver: (home: string) => HubSpawnConfig | undefined = (home) => procSpawnCfg({ roots: [home] }),
    lan?: HubLanConfig,
  ): Promise<ProcHub> {
    cleanupHome(sandbox);
    sandbox = sandboxHome();
    const home = sandbox.home;
    hub = await bootProcHub(spawnOver(home), home, lan);
    return hub;
  }

  afterEach(async () => {
    for (const c of sseConns.splice(0)) c.close();
    if (hub !== undefined) await hub.hub.close("test-teardown").catch(() => undefined);
    hub = undefined;
    for (const h of procHubs.splice(0)) await h.close("test-teardown").catch(() => undefined);
    await waitChildrenGone();
    cleanupHome(sandbox);
    sandbox = undefined;
  });

  const originOf = (port: number): string => `http://127.0.0.1:${port}`;

  /** Two-step loopback spawn; returns the 202 body. */
  async function spawnOverHttp(
    h: ProcHub,
    cwd: string,
    body: Record<string, unknown> = {},
  ): Promise<{ spawnId: string; state: string }> {
    const id = spawnReqId();
    const headers = { Cookie: h.cookie, Origin: originOf(h.port) };
    const first = await postJson(h.port, "/api/headless", { id, cwd, ...body }, headers);
    expect([202, 409]).toContain(first.status);
    if (first.status === 202) return JSON.parse(first.body) as { spawnId: string; state: string };
    const resolved = JSON.parse(first.body) as { resolvedCwd: string };
    const second = await postJson(
      h.port,
      "/api/headless",
      { id, cwd, confirm: true, expectCwd: resolved.resolvedCwd, ...body },
      headers,
    );
    expect(second.status).toBe(202);
    return JSON.parse(second.body) as { spawnId: string; state: string };
  }

  async function getHeadless(
    port: number,
    cookie: string,
  ): Promise<{ status: number; items: SpawnRecordOwner[]; policy?: { allowed?: boolean } }> {
    const res = await rawRequest(port, { path: "/api/headless", headers: { Cookie: cookie, "X-PWH": "1" } });
    const body = JSON.parse(res.body) as { items?: SpawnRecordOwner[]; policy?: { allowed?: boolean } };
    return { status: res.status, items: body.items ?? [], policy: body.policy };
  }

  async function stopSpawn(h: ProcHub, spawnId: string): Promise<number> {
    const res = await postJson(
      h.port,
      `/api/headless/${spawnId}/stop`,
      {},
      { Cookie: h.cookie, Origin: originOf(h.port) },
    );
    return res.status;
  }

  async function waitRecord(
    stateDir: string,
    spawnId: string,
    pred: (rec: StoredRecord) => boolean,
    ms: number,
    what: string,
  ): Promise<StoredRecord> {
    let last: StoredRecord | undefined;
    await waitUntil(
      () => {
        last = recordOf(stateDir, spawnId);
        return last !== undefined && pred(last);
      },
      ms,
      what,
    );
    return last!;
  }

  /** Confirm-dance POST returning the FINAL response (202 or the gate's own reject) unasserted. */
  async function confirmedSpawn(
    h: ProcHub,
    cwd: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; body: string }> {
    const id = spawnReqId();
    const headers = { Cookie: h.cookie, Origin: originOf(h.port) };
    const first = await postJson(h.port, "/api/headless", { id, cwd, ...body }, headers);
    if (first.status !== 409) return first;
    const resolved = JSON.parse(first.body) as { resolvedCwd: string };
    return postJson(
      h.port,
      "/api/headless",
      { id, cwd, confirm: true, expectCwd: resolved.resolvedCwd, ...body },
      headers,
    );
  }

  async function trackChild(h: ProcHub, spawnId: string): Promise<number> {
    const pid = await (async () => {
      await waitUntil(() => recordOf(h.stateDir, spawnId)?.pid !== undefined, 10_000, "pid persisted");
      return recordOf(h.stateDir, spawnId)!.pid!;
    })();
    procChildren.add(pid);
    return pid;
  }

  it("closure: POST → 202/record → fork → hello/session → live → SSE spawns sequence → first prompt delivered once → stop → exited{user}", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj", ["--cmd-echo"]);
    const sse = await openSse(h.port, { cookie: h.cookie });
    sseConns.push(sse);
    await sse.waitFor((e) => e.event === "hello");

    const secret = `SECRETFP-${Date.now().toString(36)}`;
    const accepted = await spawnOverHttp(h, cwd, {
      firstPrompt: { text: `please echo ${secret}`, deliver: "followUp" },
    });
    expect(accepted.state).toBe("starting");

    // SSE pushes: starting … live for THIS spawnId; payload is the Public projection only
    await sse.waitFor(
      (e) =>
        e.event === "spawns" &&
        ((e.data as SpawnsPayload).items ?? []).some((i) => i.spawnId === accepted.spawnId && i.state === "live"),
      15_000,
    );
    const spawnsEvents = sse.events.filter((e) => e.event === "spawns");
    const states = spawnsEvents
      .flatMap((e) => (e.data as SpawnsPayload).items ?? [])
      .filter((i) => i.spawnId === accepted.spawnId)
      .map((i) => i.state);
    expect(states).toContain("starting");
    expect(states).toContain("live");
    for (const e of spawnsEvents) {
      expect(JSON.stringify(e.data)).not.toContain(secret);
      expect(JSON.stringify(e.data)).not.toContain('"cwd"');
    }

    // first prompt: exactly one fp_<spawnId> cmd reached the child over the agent socket
    await waitUntil(
      () => stderrLog(h.stateDir, accepted.spawnId).includes(`CMD fp_${accepted.spawnId}`),
      15_000,
      "fp cmd reached the child",
    );
    await waitRecord(h.stateDir, accepted.spawnId, (r) => r.firstPrompt?.state === "delivered", 10_000, "delivered");
    const log = stderrLog(h.stateDir, accepted.spawnId);
    expect(log.split(`CMD fp_${accepted.spawnId}`).length - 1).toBe(1);
    expect(log).toContain("FAKE-PI pid=");
    expect(log).toContain("umask=0o022"); // children inherit the USER's umask, not the hub's 0o077
    await trackChild(h, accepted.spawnId);

    // owner GET: loopback sees owner fields; the first-prompt text never rides any GET
    const owner = await getHeadless(h.port, h.cookie);
    const mine = owner.items.find((i) => i.spawnId === accepted.spawnId)!;
    expect(mine.cwd).toBe(cwd);
    expect(JSON.stringify(mine)).not.toContain(secret);

    // stop → exited{user}; the fake answers EOF instantly
    expect(await stopSpawn(h, accepted.spawnId)).toBe(202);
    const final = await waitRecord(
      h.stateDir,
      accepted.spawnId,
      (r) => r.state === "exited",
      10_000,
      "exited after stop",
    );
    expect(final.endReason).toBe("user");
  }, 60_000);

  it("dup replay: same id + same intent ⇒ 202 with dup:true, exactly one record", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj");
    const id = spawnReqId();
    const headers = { Cookie: h.cookie, Origin: originOf(h.port) };
    const first = await postJson(h.port, "/api/headless", { id, cwd }, headers);
    expect(first.status).toBe(409);
    const resolved = JSON.parse(first.body) as { resolvedCwd: string };
    const body = { id, cwd, confirm: true, expectCwd: resolved.resolvedCwd };
    const second = await postJson(h.port, "/api/headless", body, headers);
    expect(second.status).toBe(202);
    const spawnId = (JSON.parse(second.body) as { spawnId: string }).spawnId;
    const third = await postJson(h.port, "/api/headless", body, headers);
    expect(third.status).toBe(202);
    expect((JSON.parse(third.body) as { dup?: true }).dup).toBe(true);
    expect(readSpawnsJson(h.stateDir).filter((r) => r.spawnId === spawnId)).toHaveLength(1);
    await trackChild(h, spawnId);
  }, 30_000);

  it("browser-off delivery: no SSE at all ⇒ snapshot still shows delivered (delivery is hub-side)", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj", ["--cmd-echo"]);
    const accepted = await spawnOverHttp(h, cwd, { firstPrompt: { text: "hello there", deliver: "followUp" } });
    await waitRecord(
      h.stateDir,
      accepted.spawnId,
      (r) => r.firstPrompt?.state === "delivered",
      15_000,
      "delivered w/o browser",
    );
    await trackChild(h, accepted.spawnId);
    const snap = await getHeadless(h.port, h.cookie);
    const mine = snap.items.find((i) => i.spawnId === accepted.spawnId)!;
    expect(mine.firstPrompt?.state).toBe("delivered");
  }, 30_000);

  it("--no-hello ⇒ failed{register_timeout} + hint register-timeout-hello", async () => {
    const h = await bringUp((home) => procSpawnCfg({ roots: [home], registerTimeoutS: 2 }));
    const cwd = projDir(sandbox!.home, "proj", ["--no-hello"]);
    const accepted = await spawnOverHttp(h, cwd);
    const rec = await waitRecord(h.stateDir, accepted.spawnId, (r) => r.state === "failed", 12_000, "register timeout");
    expect(rec.endReason).toBe("register_timeout");
    expect(rec.hint).toBe("register-timeout-hello");
  }, 30_000);

  // -------------------------------------------------------------------------
  // web-hub-delete-session plan v2 §7.3 (P3): real-process delete-session acceptance
  // -------------------------------------------------------------------------

  async function removeOverHttp(h: ProcHub, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
    return postJson(h.port, "/api/agents/remove", body, { Cookie: h.cookie, Origin: originOf(h.port) });
  }

  it("§7.3-1 (A4): live managed session remove(agentKey) → 202 pending → confirmed exit → removed; spawns.json loses the record; the hub keeps serving", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj", ["--cmd-echo"]);
    const sse = await openSse(h.port, { cookie: h.cookie });
    sseConns.push(sse);
    await sse.waitFor((e) => e.event === "hello");
    const accepted = await spawnOverHttp(h, cwd);
    await waitRecord(h.stateDir, accepted.spawnId, (r) => r.state === "live", 15_000, "live");
    const pid = await trackChild(h, accepted.spawnId);
    const owner = await getHeadless(h.port, h.cookie);
    const mine = owner.items.find((i) => i.spawnId === accepted.spawnId)!;
    const agentKey = mine.agentKey!;
    expect(agentKey).toBeDefined();

    const res = await removeOverHttp(h, { agentKey });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ removed: false, pending: true, state: "stopping" });

    // B-stream: the hub broadcasts agent_removed once death is confirmed (stdin EOF ⇒ the fake
    // exits promptly, so this settles well inside the escalation ladder's first stage).
    await sse.waitFor((e) => e.event === "agent_removed" && e.data.agentKey === agentKey, 15_000);
    await waitPidGone(pid, 15_000, "removed child exited");
    await waitUntil(() => recordOf(h.stateDir, accepted.spawnId) === undefined, 15_000, "spawns.json record gone");

    // the hub itself is unharmed — GET reflects the deletion, no crash
    const after = await getHeadless(h.port, h.cookie);
    expect(after.status).toBe(200);
    expect(after.items.find((i) => i.spawnId === accepted.spawnId)).toBeUndefined();
  }, 30_000);

  it("§7.3-2 (A5): starting-phase (no hello yet) remove(spawnId) → 202 pending → the child is stopped → record deleted", async () => {
    const h = await bringUp((home) => procSpawnCfg({ roots: [home], registerTimeoutS: 30 }));
    const cwd = projDir(sandbox!.home, "proj", ["--no-hello"]);
    const accepted = await spawnOverHttp(h, cwd);
    expect(accepted.state).toBe("starting");
    const pid = await trackChild(h, accepted.spawnId);

    const res = await removeOverHttp(h, { spawnId: accepted.spawnId });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({
      removed: false,
      pending: true,
      spawnId: accepted.spawnId,
      state: "stopping",
    });

    await waitPidGone(pid, 15_000, "starting child stopped by remove()");
    await waitUntil(() => recordOf(h.stateDir, accepted.spawnId) === undefined, 15_000, "record deleted");
  }, 30_000);

  it("§7.3-3 (A7/B-fork): replaying the same create id after delete ⇒ 409 spawn-gone, no fresh fork, no new record", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj", ["--cmd-echo"]);
    const headers = { Cookie: h.cookie, Origin: originOf(h.port) };
    const id = spawnReqId();

    let first = await postJson(h.port, "/api/headless", { id, cwd }, headers);
    if (first.status === 409) {
      const resolved = JSON.parse(first.body) as { resolvedCwd: string };
      first = await postJson(
        h.port,
        "/api/headless",
        { id, cwd, confirm: true, expectCwd: resolved.resolvedCwd },
        headers,
      );
    }
    expect(first.status).toBe(202);
    const spawnId = (JSON.parse(first.body) as { spawnId: string }).spawnId;
    const pid = await trackChild(h, spawnId);

    const rm = await removeOverHttp(h, { spawnId });
    expect(rm.status).toBe(202);
    await waitPidGone(pid, 15_000, "deleted child stopped");
    await waitUntil(() => recordOf(h.stateDir, spawnId) === undefined, 15_000, "record gone");

    // replay the SAME id+cwd within the 10-minute idempotency TTL ⇒ 409 spawn-gone, never a
    // fresh fork (B-fork) — the idempotency LRU hit is detected but the record is gone.
    const replay = await postJson(h.port, "/api/headless", { id, cwd }, headers);
    expect(replay.status).toBe(409);
    expect(JSON.parse(replay.body)).toEqual({ error: "E_BAD_REQUEST", reason: "spawn-gone" });
    expect(readSpawnsJson(h.stateDir)).toHaveLength(0); // no new record of any spawnId appeared
  }, 30_000);

  it("H5: 1 MiB ui lines answered cancelled from the head ≤1.5s; bad head ⇒ failed{protocol_error} and the child is stopped", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj");
    for (const method of ["select", "confirm", "editor"] as const) {
      const dir = projDir(sandbox!.home, `huge-${method}`, [`--emit-ui-huge`, method]);
      const accepted = await spawnOverHttp(h, dir);
      await waitUntil(
        () => {
          const log = stderrLog(h.stateDir, accepted.spawnId);
          return log.includes(`UI-SENT ui-huge-${method}-`) && log.includes(`UI-RESP ui-huge-${method}-`);
        },
        15_000,
        `huge ${method} answered`,
      );
      const log = stderrLog(h.stateDir, accepted.spawnId);
      const sent = new RegExp(`UI-SENT (ui-huge-${method}-\\S+) (\\d+)`).exec(log)!;
      const resp = new RegExp(`UI-RESP ${sent[1]} cancelled=(\\S+) (\\d+) (\\d+)`).exec(log)!;
      expect(resp[1]).toBe("true");
      const latency = Number(resp[2]) - Number(resp[3]);
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(latency).toBeLessThanOrEqual(1_500); // answered from the ≤512B head, not the 1 MiB line
      // the session CONTINUES: record reaches live and stays there until we stop it
      await waitRecord(h.stateDir, accepted.spawnId, (r) => r.state === "live", 10_000, "still live after huge ui");
      await trackChild(h, accepted.spawnId);
      expect(await stopSpawn(h, accepted.spawnId)).toBe(202);
      await waitRecord(h.stateDir, accepted.spawnId, (r) => r.state === "exited", 10_000, "stopped");
      void cwd;
    }

    const badDir = projDir(sandbox!.home, "bad-head", ["--emit-ui-bad-head"]);
    const bad = await spawnOverHttp(h, badDir);
    // The bad line is emitted AFTER the session went live, so SP7's terminalState for a
    // protocol error on a live session is `exited` (failed is reserved for never-lived) —
    // endReason + hint are the protocol-error verdict either way.
    const rec = await waitRecord(
      h.stateDir,
      bad.spawnId,
      (r) => r.state === "exited" || r.state === "failed",
      15_000,
      "bad head terminalizes the record",
    );
    expect(rec.endReason).toBe("protocol_error");
    expect(rec.hint).toBe("protocol-error");
  }, 120_000);

  it("H6: principal/global limits 409, lifetime ⇒ exited{lifetime}, stderr flood capped, hub RSS bounded", async () => {
    // -- principal limit: maxPerPrincipal=1 ⇒ second same-principal POST 409 --------------
    let h = await bringUp((home) => procSpawnCfg({ roots: [home], maxPerPrincipal: 1, registerTimeoutS: 10 }));
    const cwdA = projDir(sandbox!.home, "projA");
    const ok = await confirmedSpawn(h, cwdA);
    expect(ok.status).toBe(202);
    await trackChild(h, (JSON.parse(ok.body) as { spawnId: string }).spawnId);
    // the confirm gate (unknown-dir) sits BEFORE the supervisor's limits — the 409-E_LIMIT
    // cell is only reachable through a fully confirmed second intent.
    const second = await confirmedSpawn(h, cwdA);
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({ error: "E_LIMIT", limit: "principal" });
    await h.hub.close("limits-1");
    procHubs.splice(procHubs.indexOf(h.hub), 1);
    await waitChildrenGone();

    // -- global limit + lifetime + stderr flood + RSS on a fresh hub ----------------------
    h = await bringUp((home) => procSpawnCfg({ roots: [home], maxProcesses: 2, maxLifetimeMinutes: 0.05 })); // 3s lifetime (test hook)
    const cwd = projDir(sandbox!.home, "projB");
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const accepted = await spawnOverHttp(h, cwd);
      ids.push(accepted.spawnId);
      await trackChild(h, accepted.spawnId);
    }
    const third = await confirmedSpawn(h, cwd);
    expect(third.status).toBe(409);
    expect(JSON.parse(third.body)).toMatchObject({ error: "E_LIMIT", limit: "global", max: 2 });

    // lifetime: 3s after createdAt the records go terminal via the stop escalation
    for (const sid of ids) {
      const rec = await waitRecord(h.stateDir, sid, (r) => r.state === "exited", 20_000, `lifetime expiry ${sid}`);
      expect(rec.endReason).toBe("lifetime");
    }

    // (the stderr-flood + hub-RSS cells live in the child-process describe below: the gate's
    // "hub RSS" is the REAL hub process, measured via /proc VmRSS — not this test runner's
    // heap, whose V8 retention between GCs drowns the sink's bounded 128 KiB.)
  }, 150_000);

  it("--flood 8 MiB of stdout junk keeps the hub responsive and the record live", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj", ["--flood", "8"]);
    const accepted = await spawnOverHttp(h, cwd);
    await waitUntil(() => stderrLog(h.stateDir, accepted.spawnId).includes("FLOOD-DONE"), 30_000, "flood drained");
    const snap = await getHeadless(h.port, h.cookie); // hub still answers
    expect(snap.status).toBe(200);
    const mine = snap.items.find((i) => i.spawnId === accepted.spawnId)!;
    expect(["live", "starting"]).toContain(mine.state);
    await trackChild(h, accepted.spawnId);
  }, 60_000);

  it("stop escalation ladder (real timing): ignore-eof+ignore-term ⇒ stdin.end → +5s TERM → +3s KILL ⇒ exited{user}", async () => {
    const h = await bringUp();
    const cwd = projDir(sandbox!.home, "proj", ["--ignore-eof", "--ignore-term"]);
    const accepted = await spawnOverHttp(h, cwd);
    await trackChild(h, accepted.spawnId);
    const t0 = Date.now();
    expect(await stopSpawn(h, accepted.spawnId)).toBe(202);
    const final = await waitRecord(
      h.stateDir,
      accepted.spawnId,
      (r) => r.state === "exited",
      16_000,
      "ladder terminal",
    );
    const dt = Date.now() - t0;
    expect(final.endReason).toBe("user");
    expect(dt).toBeGreaterThanOrEqual(5_000); // TERM never before STOP_TERM_MS
    expect(dt).toBeLessThanOrEqual(15_000);
  }, 40_000);

  it("hub close: every managed child exits on the stdin EOF and spawns.json is all-terminal (exited{hub})", async () => {
    const h = await bringUp();
    const a = await spawnOverHttp(h, projDir(sandbox!.home, "p1"));
    const b = await spawnOverHttp(h, projDir(sandbox!.home, "p2"));
    await trackChild(h, a.spawnId);
    await trackChild(h, b.spawnId);
    await h.hub.close("test-graceful");
    procHubs.splice(procHubs.indexOf(h.hub), 1);
    await Promise.all([
      waitRecord(h.stateDir, a.spawnId, (r) => r.state === "exited", 12_000, "a terminal"),
      waitRecord(h.stateDir, b.spawnId, (r) => r.state === "exited", 12_000, "b terminal"),
    ]);
    for (const rec of readSpawnsJson(h.stateDir)) {
      expect(["exited", "failed"]).toContain(rec.state);
      expect(rec.endReason).toBe("hub");
    }
  }, 40_000);

  it("H8 (loopback cells): not-enabled matrix on a real assembled hub — 401/403/404/501, SSE without spawns, caps without spawn.v1", async () => {
    const h = await bringUp(() => undefined); // NO config.spawn anywhere in this hub
    expect((await rawRequest(h.port, { path: "/api/headless" })).status).toBe(401); // unauthed GET
    expect(
      (await rawRequest(h.port, { path: "/api/headless", headers: { Cookie: h.cookie, "X-PWH": "1" } })).status,
    ).toBe(404);
    // GET with cookie but WITHOUT X-PWH: the not-enabled hub has no spawn route to enforce
    // the header, so the generic /api branch just 404s (the 403-E_CSRF cell belongs to the
    // ENABLED matrix, pinned by SP9's api-headless tests).
    expect((await rawRequest(h.port, { path: "/api/headless", headers: { Cookie: h.cookie } })).status).toBe(404);
    expect(
      (await rawRequest(h.port, { path: "/api/headless/dirs", headers: { Cookie: h.cookie, "X-PWH": "1" } })).status,
    ).toBe(404);
    // POST ladder: lenient-gate 403 (no Origin is fine there, but missing Origin+X-PWH…): use no-cookie 401 & authed 501
    expect((await postJson(h.port, "/api/headless", { id: "x".repeat(16), cwd: "/tmp" })).status).toBe(401);
    const authed = await postJson(
      h.port,
      "/api/headless",
      { id: "x".repeat(16), cwd: "/tmp" },
      { Cookie: h.cookie, Origin: originOf(h.port) },
    );
    expect(authed.status).toBe(501);
    expect(JSON.parse(authed.body)).toEqual({ error: "E_NOT_IMPLEMENTED" });
    // SSE flows (hello/hub), never spawns; caps lack spawn.v1 on both surfaces
    const sse = await openSse(h.port, { cookie: h.cookie });
    sseConns.push(sse);
    await sse.waitFor((e) => e.event === "hub");
    await new Promise((r) => setTimeout(r, 300));
    expect(sse.events.some((e) => e.event === "spawns")).toBe(false);
    expect(h.hub.info.caps).not.toContain("spawn.v1");
    const hubFrame = sse.events.find((e) => e.event === "hub");
    expect(JSON.stringify(hubFrame?.data)).not.toContain("spawn.v1");
    expect(existsSync(webHubSpawnFiles(h.stateDir).spawnsJson)).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// H7 — LAN two-principal visibility & trust (needs the real SQLite LAN stack)
// ---------------------------------------------------------------------------

describe.skipIf(!IS_LINUX || NO_NODE_SQLITE)("web-hub headless e2e — H7 LAN visibility/trust", () => {
  let sandbox: ReturnType<typeof sandboxHome> | undefined;
  let hub: ProcHub | undefined;
  let admin: TestClient | undefined;

  afterEach(async () => {
    for (const c of sseConns.splice(0)) c.close();
    admin?.sock.destroy();
    admin = undefined;
    if (hub !== undefined) await hub.hub.close("test-teardown").catch(() => undefined);
    hub = undefined;
    for (const h of procHubs.splice(0)) await h.close("test-teardown").catch(() => undefined);
    await waitChildrenGone();
    cleanupHome(sandbox);
    sandbox = undefined;
  });

  function lanPortOf(h: ProcHub): number {
    const status = h.hub.lanStatus();
    if (status === undefined || status.state !== "on" || status.port === undefined) throw new Error("lan not on");
    return status.port;
  }

  async function sendLanReq(frame: Record<string, unknown> & { op: string }): Promise<LanResFrame> {
    const rid = `t-${Math.random().toString(36).slice(2)}`;
    admin!.send({ ...frame, rid });
    const f = await admin!.waitFrame((x) => x["t"] === "lan_res" && x["rid"] === rid, 5_000);
    return f as unknown as LanResFrame;
  }

  it("B stops A's session; B sees no owner fields; the first-prompt body appears nowhere on disk or wire", async () => {
    sandbox = sandboxHome();
    // trustProxy stays EMPTY so a plain 127.0.0.1 dial is a genuine direct LAN connection
    // (any trustProxyFrom entry containing 127.0.0.1 would treat every dial as proxied ⇒ 400).
    const lan: HubLanConfig = {
      port: await freePort(),
      extraHosts: [],
      trustProxyFrom: [],
      externalOrigins: [],
    };
    hub = await bootProcHub(procSpawnCfg({ roots: [sandbox.home], lan: "known" }), sandbox.home, lan);
    await waitUntil(() => hub!.hub.lanStatus()?.state === "on", 15_000, "lan on");
    const lanPort = lanPortOf(hub);
    const host = `127.0.0.1:${lanPort}`;

    // admin socket: initial user + a second user ub
    admin = await connectClient(hub.hub.paths.socketPath);
    admin.send(hello({ agentId: { pid: process.pid, nonce: "h7adminnonce000001" }, epoch: "h7" }));
    await admin.waitFrame((f) => f["t"] === "hello_ack");
    const info = await sendLanReq({ t: "lan_req", op: "info" });
    if (!info.ok || info.info === undefined) throw new Error(`lan info failed: ${String(info.ok)}`);
    const ua = (info.info as LanInfoPayload).username;
    const uaPass = (info.info as LanInfoPayload).initialPassword;
    if (uaPass === undefined) throw new Error("no initial password");
    expect((await sendLanReq({ t: "lan_req", op: "passwd", username: "ub", password: "ub-password-1234" })).ok).toBe(
      true,
    );

    const loginAs = async (username: string, password: string): Promise<string> => {
      const r = await lanPostJson(lanPort, "/api/login", { username, password }, { Host: host });
      if (r.status !== 200) throw new Error(`lan login failed for ${username}: ${r.status} ${r.body}`);
      return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    };
    const cookieA = await loginAs(ua, uaPass);
    const cookieB = await loginAs("ub", "ub-password-1234");

    // ua spawns over LAN ⇒ confirm ALWAYS (even known dirs): 409 then confirmed 202.
    // `spawn.lan:"known"` caps the plaintext-direct scope at KNOWN dirs, so the cwd must be
    // seeded into the known set first — a session header whose first line carries the cwd
    // (dirs.ts source ②'s exact contract).
    const cwd = projDir(sandbox.home, "proj");
    const sessDir = join(sandbox.home, ".pi", "agent", "sessions", "seed-0001");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "session-seed.jsonl"), `${JSON.stringify({ cwd, at: Date.now() })}\n`);
    const secret = `H7SECRET-${Date.now().toString(36)}`;
    const first = await lanPostJson(
      lanPort,
      "/api/headless",
      { id: spawnReqId(), cwd },
      { Cookie: cookieA, Origin: `http://${host}` },
    );
    expect(first.status).toBe(409);
    expect(JSON.parse(first.body)).toMatchObject({ error: "E_CONFIRM_REQUIRED", reason: "always" });
    const resolved = JSON.parse(first.body) as { resolvedCwd: string };
    const second = await lanPostJson(
      lanPort,
      "/api/headless",
      {
        id: spawnReqId(),
        cwd,
        confirm: true,
        expectCwd: resolved.resolvedCwd,
        firstPrompt: { text: `say ${secret}`, deliver: "followUp" },
      },
      { Cookie: cookieA, Origin: `http://${host}` },
    );
    expect(second.status).toBe(202);
    const spawnId = (JSON.parse(second.body) as { spawnId: string }).spawnId;
    await waitUntil(() => recordOf(hub!.stateDir, spawnId)?.pid !== undefined, 15_000, "pid persisted");
    procChildren.add(recordOf(hub!.stateDir, spawnId)!.pid!);

    // B's SSE: record visible (Public projection) — owner fields and the secret never appear
    const sseB = await openSse(lanPort, { cookie: cookieB, host, destHost: "127.0.0.1" });
    sseConns.push(sseB);
    await sseB.waitFor((e) => e.event === "spawns", 10_000);
    await sseB.waitFor(
      (e) =>
        e.event === "spawns" &&
        ((e.data as SpawnsPayload).items ?? []).some((i) => i.spawnId === spawnId && i.state === "live"),
      15_000,
    );
    for (const e of sseB.events.filter((x) => x.event === "spawns")) {
      const payload = JSON.stringify(e.data);
      expect(payload).not.toContain(secret);
      expect(payload).not.toContain('"cwd"');
      expect(payload).not.toContain("stderrTail");
      expect(payload).not.toContain('"user"');
    }
    // B's GET: cwdLabel yes, real cwd / stderrTail / origin.user no
    const listB = await lanRequest(lanPort, {
      path: "/api/headless",
      headers: { Cookie: cookieB, "X-PWH": "1", Host: host },
      host,
    });
    expect(listB.status).toBe(200);
    const itemsB = (JSON.parse(listB.body) as { items: SpawnRecordPublic[] }).items;
    const bView = itemsB.find((i) => i.spawnId === spawnId)!;
    expect(bView.cwdLabel).toBe("proj");
    // arch §6.4's sanctioned non-owner exception: a LIVE record bound to an agent card exposes
    // the cwd the card itself already publicizes — exact value only, nothing more.
    expect(bView.cwd).toBe(cwd);
    // every OTHER owner-only field stays hidden from the non-owner LAN viewer
    expect(JSON.stringify(bView)).not.toContain("stderrTail");
    expect(JSON.stringify(bView)).not.toContain("hintDetail");
    expect(JSON.stringify(bView)).not.toContain(`"user"`);
    expect(bView.firstPrompt).toEqual({ state: expect.any(String) }); // no textLen/attempts (owner-only)

    // B stops A's session — same-hub full trust (user ruling #8) ⇒ 202
    const stopRes = await lanPostJson(
      lanPort,
      `/api/headless/${spawnId}/stop`,
      {},
      { Cookie: cookieB, Origin: `http://${host}` },
    );
    expect(stopRes.status).toBe(202);

    await waitUntil(() => recordOf(hub!.stateDir, spawnId)?.state === "exited", 12_000, "A's session terminal");
    // the first-prompt BODY appears nowhere: hub.log, spawns.json, child stderr log
    expect(readFileSync(join(hub.stateDir, "hub.log"), "utf8")).not.toContain(secret);
    expect(readFileSync(webHubSpawnFiles(hub.stateDir).spawnsJson, "utf8")).not.toContain(secret);
    expect(stderrLog(hub.stateDir, spawnId)).not.toContain(secret);
  }, 90_000);
});
