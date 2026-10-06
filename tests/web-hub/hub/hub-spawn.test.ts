/**
 * web-hub-spawn plan §SP10 acceptance: hub-assembly tests — the ONLY place SP1–SP9's parts are
 * proven to meet (and, with `config.spawn` absent, to stay away from) each other.
 *
 * Real `startHub` over a fake frontend (hub.test.ts's pattern) plus the SP10 test seams
 * (`StartHubDeps.spawnSeams`): a fake reaper (no watchdog child), a fake `spawnFn` (EventEmitter
 * `ChildProcess`, supervisor.test.ts's pattern), and a `wrapSupervisor` spy that records the
 * shutdown order/deadline without replacing the supervisor. The launcher fixture is a REAL tmp
 * tree (`node_modules/@earendil-works/pi-coding-agent/package.json` v0.87.1 + a .js entry) so the
 * SP7 version chain runs for real; the store writes a real tmp `spawns.json`.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as realSpawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrontendDeps, FrontendFactory, HubConfig, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { installProcessHandlers, startHub, type RunningHub, type StartHubDeps } from "../../../src/web-hub/hub/hub.js";
import { SPAWN_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { webHubSpawnFiles, webHubStateDir } from "../../../src/web-hub/protocol/paths.js";
import type { HubSpawnConfig } from "../../../src/web-hub/protocol/spawn.js";
import type { Reaper, ReaperTrackRecord } from "../../../src/web-hub/hub/spawn/reaper.js";
import type { SpawnSupervisor } from "../../../src/web-hub/hub/spawn/supervisor.js";
import type { FirstPromptForwarder } from "../../../src/web-hub/hub/spawn/first-prompt.js";
import { createReqDeadline, type ReqDeadline } from "../../../src/web-hub/hub/req-deadline.js";
import { config, connectClient, hello, memLog, tmpDirs, type Hello } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

// ---------------------------------------------------------------------------
// fixtures
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

/** A fake `ChildProcess` (supervisor.test.ts's FakeChild, trimmed to what the assembly needs). */
class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdin: PassThrough = new PassThrough();
  readonly stdout: PassThrough = new PassThrough();
  readonly stderr: PassThrough = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  override kill(): boolean {
    return true;
  }
  override unref(): void {}
}

/** A pid `/proc/<pid>` will never have in the test env (past the default pid_max). */
const FAKE_PID = 4_000_000;

/** Real tmp launcher tree satisfying SP7's init check (v1.0.0 ∈ SUPPORTED_PI_RANGE,
 * which is pinned to this package's pi peer range — NOT arch.md's prose "0.87.x"). */
function launcherFixture(root: string): readonly [string, string] {
  const pkgDir = `${root}/node_modules/@earendil-works/pi-coding-agent`;
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    `${pkgDir}/package.json`,
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }),
  );
  writeFileSync(`${pkgDir}/cli.js`, "// test launcher entry\n");
  return [process.execPath, `${pkgDir}/cli.js`];
}

function fakeReaper(order: string[]): Reaper {
  let started = false;
  return {
    start: async (_d: ReqDeadline) => {
      started = true;
      return true;
    },
    track: (_rec: ReaperTrackRecord) => {},
    untrack: (_pid: number) => {},
    close: () => {
      order.push("reaper.close");
    },
    get available() {
      return started;
    },
    onUnavailable: () => () => {},
    onRestart: () => () => {},
  };
}

interface SupSpy {
  order: string[];
  shutdownRemaining: number[];
  noteChanged: string[];
  sup: SpawnSupervisor | undefined;
  wrap(sup: SpawnSupervisor): SpawnSupervisor;
}

function supSpy(order: string[]): SupSpy {
  const spy: SupSpy = {
    order,
    shutdownRemaining: [],
    noteChanged: [],
    sup: undefined,
    wrap: () => {
      throw new Error("unreachable");
    },
  };
  spy.wrap = (sup: SpawnSupervisor): SpawnSupervisor => {
    spy.sup = sup;
    return {
      ...sup,
      shutdown: (d: ReqDeadline) => {
        order.push("spawn-shutdown:start");
        spy.shutdownRemaining.push(d.remaining());
        return sup.shutdown(d).finally(() => order.push("spawn-shutdown:end"));
      },
      noteSpawnChanged: (spawnId: string) => {
        spy.noteChanged.push(spawnId);
        return sup.noteSpawnChanged(spawnId);
      },
    };
  };
  return spy;
}

interface FakeFrontend extends FrontendFactory {
  deps: FrontendDeps[];
  closed: number;
  clients: number;
}

function fakeFrontend(order: string[], listenFails = false): FakeFrontend {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return {
      listen: async () => {
        if (listenFails) throw new Error("listen failed (test)");
        return { port: 43210 };
      },
      close: async () => {
        order.push("fe.close");
        f.closed++;
      },
      clientCount: () => f.clients,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  }) as FakeFrontend;
  f.deps = [];
  f.closed = 0;
  f.clients = 0;
  return f;
}

interface HubKit {
  hub: RunningHub;
  fe: FakeFrontend;
  order: string[];
  sup: SpawnSupervisor | undefined;
  child: FakeChild | undefined;
  shutdownRemaining: number[];
  noteChanged: string[];
  fwd: FirstPromptForwarder | undefined;
}

interface StartKitOpts {
  spawn?: HubSpawnConfig;
  probe?: NonNullable<StartHubDeps["spawnSeams"]>["probe"];
  withAssembly?: boolean;
  fakeTimers?: boolean;
  idleExitMinutes?: number;
  /** SP13 (SP10 acceptance leftover P3): make `fe.listen()` reject — startHub then runs the
   * reverse-order startup-failure unwind, whose spawn-shutdown/fe.close ORDER this kit pins. */
  listenFails?: boolean;
  /** web-hub-delete-session plan v2 §2.6/A9: called with `home` right after it is created, before
   * `startHub()` runs — lets a test pre-seed a REAL `spawns.json` file (simulating a previous
   * hub process that crashed mid-delete) so the restart-recovery path runs end-to-end through
   * the real file store, not just the fake-store unit matrix in `spawn/supervisor.test.ts`. */
  beforeStart?: (home: string) => void;
}

/** SP13 P3: the `order` capture of the most recent FAILED startKit (the kit object never
 * gets built on rejection — the order array is all that survives for the unwind assertions). */
let lastFailureOrder: string[] | undefined;

async function startKit(opts: StartKitOpts = {}): Promise<HubKit> {
  const home = tmp.make("wh-hubspawn-");
  opts.beforeStart?.(home);
  const order: string[] = [];
  const fe = fakeFrontend(order, opts.listenFails === true);
  const spy = opts.withAssembly === true ? supSpy(order) : undefined;
  const child = opts.withAssembly === true ? new FakeChild(FAKE_PID) : undefined;
  let fwd: FirstPromptForwarder | undefined;
  const launcher = launcherFixture(home);
  if (opts.fakeTimers === true) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  }
  const deps: StartHubDeps = {
    uid: process.getuid?.() ?? 0,
    childUmask: 0o022,
    ...(spy === undefined && child === undefined
      ? {}
      : {
          spawnSeams: {
            ...(spy === undefined ? {} : { wrapSupervisor: spy.wrap }),
            ...(opts.withAssembly === true ? { reaper: fakeReaper(order) } : {}),
            ...(child === undefined
              ? {}
              : {
                  spawnFn: ((_cmd: string, _args: readonly string[], _opts: SpawnOptions) => child) as typeof realSpawn,
                }),
            ...(opts.probe === undefined ? {} : { probe: opts.probe }),
            ...(opts.withAssembly === true
              ? { wrapFirstPrompt: (f: FirstPromptForwarder): FirstPromptForwarder => (fwd = f) }
              : {}),
          },
        }),
  };
  let hub: RunningHub;
  try {
    hub = await startHub(
      config({
        home,
        launcher,
        ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
        ...(opts.idleExitMinutes === undefined ? {} : { idleExitMinutes: opts.idleExitMinutes }),
      }),
      fe,
      deps,
    );
  } catch (err) {
    lastFailureOrder = order;
    throw err;
  }
  if ("exists" in hub) throw new Error("unexpected exists");
  hubs.push(hub);
  return {
    hub,
    fe,
    order,
    sup: spy?.sup,
    child,
    shutdownRemaining: spy?.shutdownRemaining ?? [],
    noteChanged: spy?.noteChanged ?? [],
    fwd,
  };
}

function managedHello(cwd: string): Partial<Hello> {
  return {
    agentId: { pid: FAKE_PID, nonce: "nonceCCCCCCCCCCCCCCC" },
    cwd,
    pluginVersion: "9.9.9",
    kind: "rpc",
  };
}

/** Drive `supervisor.start()` synchronously (①–④) against a real tmp cwd. */
function startManaged(
  kit: HubKit,
  over: { cwd?: string; firstPrompt?: { textLen: number; deliver: "steer" | "followUp" } } = {},
): { ok: true } | { ok: false; err: string } {
  const sup = kit.sup;
  if (sup === undefined) throw new Error("no supervisor captured");
  const cwd = over.cwd ?? tmp.make("wh-hubspawn-cwd-");
  const st = statSync(cwd);
  const result = sup.start(
    {
      spawnId: "sp_AssemblyTest0001",
      admitted: { realpath: cwd, dev: st.dev, ino: st.ino, known: true },
      owner: { listener: "loopback", reqId: "req-assembly-1" },
      ...(over.firstPrompt === undefined ? {} : { firstPrompt: over.firstPrompt }),
    },
    createReqDeadline(Date.now, 13_000),
  );
  return result.ok ? { ok: true } : { ok: false, err: `${result.code}:${result.reason ?? ""}` };
}

function readHubJson(kit: HubKit): Record<string, unknown> {
  return JSON.parse(readFileSync(kit.hub.paths.hubJson, "utf8")) as Record<string, unknown>;
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

// ---------------------------------------------------------------------------

describe("hub assembly × managed spawn (plan §SP10)", () => {
  it("no config.spawn ⇒ caps/hub.json/stateDir stay at the status quo, FrontendDeps has no spawn", async () => {
    const kit = await startKit();
    expect(kit.fe.deps[0]!.spawn).toBeUndefined();

    const c = await connectClient(kit.hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = [...(ack["caps"] as string[])];
    const browserCaps = [...kit.hub.info.caps];
    // Deep-equal both ways (order included) and free of spawn.v1 — with `config.spawn` absent
    // hello_ack.caps IS the pre-SP10 composition (its invariants are pinned by hub.test.ts /
    // agent-server-admin.test.ts), so this equality is the "byte-identical to the status quo"
    // assertion for the browser-facing surface.
    expect(browserCaps).toEqual(agentCaps);
    expect(browserCaps).not.toContain(SPAWN_HUB_CAP);
    c.sock.destroy();

    expect(readHubJson(kit)["spawn"]).toBeUndefined();
    const files = webHubSpawnFiles(kit.hub.paths.stateDir);
    expect(existsSync(files.spawnsJson)).toBe(false);
    expect(existsSync(files.logDir)).toBe(false);
  });

  it("config.spawn ⇒ both cap surfaces end with spawn.v1 and agree; hub.json carries spawn; FrontendDeps.spawn wired", async () => {
    const kit = await startKit({ spawn: SPAWN_CFG, withAssembly: true });
    const spawnDeps = kit.fe.deps[0]!.spawn;
    expect(typeof spawnDeps?.handle).toBe("function");
    expect(typeof spawnDeps?.publicPayload).toBe("function");

    const c = await connectClient(kit.hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = ack["caps"] as string[];
    expect(agentCaps[agentCaps.length - 1]).toBe(SPAWN_HUB_CAP);
    expect([...agentCaps].sort()).toEqual([...kit.hub.info.caps].sort());
    c.sock.destroy();

    expect(readHubJson(kit)["spawn"]).toEqual({ count: 0 }); // launcher fixture ok + fake reaper up ⇒ allowed
    expect(existsSync(webHubSpawnFiles(kit.hub.paths.stateDir).spawnsJson)).toBe(false); // nothing started ⇒ store never wrote
  });

  it("platform probe failure ⇒ fail closed: caps still carry spawn.v1, policy reason platform, no store file", async () => {
    const kit = await startKit({ spawn: SPAWN_CFG, withAssembly: true, probe: { platform: "darwin" } });
    expect(kit.hub.info.caps).toContain(SPAWN_HUB_CAP);

    const files = webHubSpawnFiles(kit.hub.paths.stateDir);
    expect(existsSync(files.spawnsJson)).toBe(false);
    expect(existsSync(files.logDir)).toBe(false);
    expect(readHubJson(kit)["spawn"]).toEqual({ count: 0, reason: "platform" });

    const policy = kit.sup!.policy("loopback:token", "loopback", "http", false);
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toBe("platform");
  });

  it("live managed record keeps the hub from idle-exiting; hub.json spawn.count follows via the registry tick", async () => {
    const kit = await startKit({ spawn: SPAWN_CFG, withAssembly: true, fakeTimers: true, idleExitMinutes: 1 });
    expect(kit.sup!.liveCount()).toBe(0);

    expect(startManaged(kit)).toEqual({ ok: true });
    kit.child!.emit("spawn"); // ⑤ settles; the record stays non-terminal
    expect(kit.sup!.liveCount()).toBe(1);

    // idleExitMinutes=1 with a live managed child ⇒ still open after 3× the window.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(existsSync(kit.hub.paths.hubJson)).toBe(true);
    expect(await Promise.race([kit.hub.closed.then(() => "closed"), Promise.resolve("open")])).toBe("open");

    // the 5s registry tick re-syncs hub.json's spawn summary (change-gated).
    await vi.advanceTimersByTimeAsync(6_000);
    expect(readHubJson(kit)["spawn"]).toEqual({ count: 1 });
  });

  it("a managed agent's newer plugin version never reaches supersede; a foreign agent's does (onVersion gate)", async () => {
    const kit = await startKit({ spawn: SPAWN_CFG, withAssembly: true });
    const cwd = tmp.make("wh-hubspawn-cwd-");
    expect(startManaged(kit, { cwd })).toEqual({ ok: true });
    kit.child!.emit("spawn");

    const managed = await connectClient(kit.hub.paths.socketPath);
    managed.send(hello(managedHello(cwd)));
    await managed.waitFrame((f) => f["t"] === "hello_ack");
    await settle(); // agent_up → bind → onVersion all synchronous, settle for good measure
    expect(kit.hub.info.supersedePending).toBeFalsy(); // gate held: observe() never ran

    const foreign = await connectClient(kit.hub.paths.socketPath);
    foreign.send(hello({ pluginVersion: "9.9.9", agentId: { pid: 4711, nonce: "nonceBBBBBBBBBBBBBBB" } }));
    await foreign.waitFrame((f) => f["t"] === "hello_ack");
    await settle();
    expect(kit.hub.info.supersedePending).toBe(true);
    expect(kit.hub.info.nextVersion).toBe("9.9.9");
    managed.sock.destroy();
    foreign.sock.destroy();
  });

  it("SP9 hand-off: a first-prompt state change syncs the supervisor record slice before the push", async () => {
    const kit = await startKit({ spawn: SPAWN_CFG, withAssembly: true });
    const cwd = tmp.make("wh-hubspawn-cwd-");
    expect(startManaged(kit, { cwd, firstPrompt: { textLen: 42, deliver: "steer" } })).toEqual({ ok: true });
    kit.child!.emit("spawn");
    expect(kit.sup!.records()[0]?.firstPrompt).toEqual({ state: "pending", textLen: 42 });

    // Hand the body to the forwarder exactly like SP9's POST path would (memory only)…
    kit.fwd!.accept(
      "sp_AssemblyTest0001",
      { text: "x".repeat(42), deliver: "steer" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "req-assembly-1" },
      Date.now() + 150_000,
    );

    // …then hello (bind, pid+cwd match) + session ⇒ goLive ⇒ forwarder.onLive with control=false
    // (the test agent declares no cmd.v1 cap) ⇒ failed{E_UNSUPPORTED} ⇒ onChange.
    const c = await connectClient(kit.hub.paths.socketPath);
    c.send(hello(managedHello(cwd)));
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "session", sessionId: "sess-1", cwd, reason: "new", leafId: null, mode: "rpc" });
    await settle();
    await settle();

    // The forwarder is authoritative; the assembly's onChange must have synced the record slice
    // (what the SSE `spawns` push renders) BEFORE noteSpawnChanged fired — SSE and the GET
    // snapshot (which reads the forwarder through SP9's routes) can never disagree.
    const rec = kit.sup!.records()[0];
    expect(rec?.state).toBe("live");
    expect(rec?.firstPrompt).toEqual({ state: "failed", textLen: 42, attempts: 0 });
    expect(kit.noteChanged).toContain("sp_AssemblyTest0001");
    c.sock.destroy();
  });

  it("SP13: managedBusy folds the first-prompt sending count into the supersede quiet gate (wiring pin)", async () => {
    // `busyCount` alone misses the window where a live record's first prompt is still sending
    // (agent not busy YET) — a hub replacement there ends the session mid-delivery. The wiring
    // is one expression in hub.ts; behavioral halves are pinned by first-prompt.test.ts
    // (sendingCount semantics) and supersede.test.ts (managedBusy blocks quiet), so this pins
    // the composition itself against silent removal.
    const src = readFileSync("src/web-hub/hub/hub.ts", "utf8");
    const m = /managedBusy:\s*\(\)\s*=>[^\n]+/.exec(src);
    expect(m).toBeDefined();
    expect(m![0]).toContain("busyCount()");
    expect(m![0]).toContain("sendingCount()");
  });

  it("close(): supervisor.shutdown runs BEFORE fe.close and receives ≥9.5s of the 10s budget", async () => {
    const kit = await startKit({ spawn: SPAWN_CFG, withAssembly: true });
    hubs.length = 0; // close() runs its own path below
    await kit.hub.close("signal");
    expect(kit.order.indexOf("spawn-shutdown:end")).toBeGreaterThanOrEqual(0);
    expect(kit.order.indexOf("spawn-shutdown:end")).toBeLessThan(kit.order.indexOf("fe.close"));
    expect(kit.shutdownRemaining[0]).toBeGreaterThanOrEqual(9_500);
    await kit.hub.closed;
  });

  it("startup failure (fe.listen rejects): reverse-order unwind still shuts the spawn domain down BEFORE fe.close (SP13 P3)", async () => {
    // The spawn shutdown entry used to be pushed at the assembly site (before the frontend's
    // own entry), so the reverse-order unwind ran it AFTER fe.close — contradicting both its
    // own comment and arch §7.6's domain-first order. SP13 moved the push next to fe.close's.
    await expect(startKit({ spawn: SPAWN_CFG, withAssembly: true, listenFails: true })).rejects.toThrow(
      "listen failed (test)",
    );
    hubs.length = 0; // startHub rejected — nothing was registered in `hubs`
    const order = lastFailureOrder;
    expect(order).toBeDefined();
    const shutdownEnd = order!.indexOf("spawn-shutdown:end");
    const feClose = order!.indexOf("fe.close");
    expect(shutdownEnd).toBeGreaterThanOrEqual(0);
    expect(feClose).toBeGreaterThanOrEqual(0);
    expect(shutdownEnd).toBeLessThan(feClose);
    expect(order!.indexOf("reaper.close")).toBeGreaterThanOrEqual(0); // shutdown ran to completion
  });

  it("deadline grading (#4): onCrash hands close() a ≤2.5s deadline; shutdown/reaper finish before process.exit", async () => {
    const kit = await startKit({ spawn: SPAWN_CFG, withAssembly: true });
    expect(startManaged(kit)).toEqual({ ok: true });
    kit.child!.emit("spawn");
    hubs.length = 0;

    const listeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      kit.order.push("exit");
      return undefined;
    }) as never);
    try {
      const uninstall = installProcessHandlers(kit.hub, memLog());
      process.emit("uncaughtException", new Error("boom"));
      await kit.hub.closed;
      await settle(); // close()'s `.finally(process.exit)` continuation runs after closed resolves
      await settle();
      // crash deadline = STEP_DEADLINE_MS - 500 ⇒ shutdown's wait budget derives to 0 and the
      // deadline it received is already at/below 2.5s.
      expect(kit.shutdownRemaining[0]).toBeLessThanOrEqual(2_500);
      // persist (flushAndClose) + reaper EOF happened INSIDE shutdown, all before process.exit.
      const exitIdx = kit.order.indexOf("exit");
      expect(exitIdx).toBeGreaterThanOrEqual(0);
      expect(kit.order.indexOf("spawn-shutdown:end")).toBeLessThan(exitIdx);
      expect(kit.order.indexOf("reaper.close")).toBeLessThan(exitIdx);
      uninstall();
    } finally {
      // Burn the 3s force timer under the mock BEFORE restoring the real exit.
      await new Promise((resolve) => setTimeout(resolve, 3_100));
      exitSpy.mockRestore();
      for (const l of listeners) process.on("uncaughtException", l);
    }
  });

  it("web-hub-delete-session plan v2 §2.6/A9: a REAL spawns.json with a terminal removeIntent record (confirmed exit) is reconciled — deleted — during the real file-store restart", async () => {
    let spawnsJsonPath = "";
    const kit = await startKit({
      spawn: SPAWN_CFG,
      withAssembly: true,
      beforeStart: (home) => {
        const stateDir = webHubStateDir(home);
        mkdirSync(stateDir, { recursive: true });
        const files = webHubSpawnFiles(stateDir);
        spawnsJsonPath = files.spawnsJson;
        const envelope = {
          v: 2,
          gen: 1,
          writer: { pid: 1, startedAt: 0, bootId: "previous-crashed-hub-boot-id" },
          records: [
            {
              spawnId: "sp_PrevHubDeleted01",
              state: "exited",
              cwd: "/tmp/does-not-matter",
              dev: 1,
              ino: 1,
              createdAt: 1,
              updatedAt: 1,
              owner: { listener: "loopback", reqId: "r1" },
              pid: 999999, // irrelevant: a real (non-unconfirmed) exit short-circuits deathOf to "confirmed"
              endReason: "crash",
              exit: { code: 1, signal: null },
              removeIntent: true,
            },
          ],
        };
        writeFileSync(spawnsJsonPath, JSON.stringify(envelope), { mode: 0o600 });
      },
    });
    // init() already ran (startHub awaits it) — the confirmed-dead record must be gone, both in
    // memory and in the very file it was loaded from (the reconciliation's own persistDebounced
    // write settles on the 200ms debounce; give it room).
    expect(kit.sup!.records().find((r) => r.spawnId === "sp_PrevHubDeleted01")).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const onDisk = JSON.parse(readFileSync(spawnsJsonPath, "utf8")) as { records: Array<{ spawnId: string }> };
    expect(onDisk.records.find((r) => r.spawnId === "sp_PrevHubDeleted01")).toBeUndefined();
  });
});
