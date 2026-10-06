/**
 * web-hub-spawn plan §SP7 acceptance (arch v2 §3.1 table ①–⑩ + the 9 numbered cases):
 *
 * EventEmitter fake `ChildProcess` + PassThrough pipes + fake store/reaper/dirs + fake timers
 * (the real fork never runs here — SP13's integration suite owns that). Everything drives the
 * supervisor through its public surface plus the injected seams (`spawnFn`, `proc`, `kill`,
 * `umask`, `closeSync`, `launcherFs`).
 */
import { EventEmitter } from "node:events";
import { type ChildProcess, type SpawnOptions, spawn as realSpawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentView, HubEvent } from "../../../../src/web-hub/hub/ports.js";
import type { SpawnRegistryPort } from "../../../../src/web-hub/hub/spawn/ports.js";
import type { DirService } from "../../../../src/web-hub/hub/spawn/dirs.js";
import type { Reaper, ReaperTrackRecord } from "../../../../src/web-hub/hub/spawn/reaper.js";
import type {
  SpawnStore,
  SpawnStoreLoad,
  SpawnStoreWriteResult,
  StoredRecord,
} from "../../../../src/web-hub/hub/spawn/store.js";
import type { LauncherFs } from "../../../../src/web-hub/hub/spawn/launcher-check.js";
import {
  createSpawnSupervisor,
  MODEL_VERDICT_GRACE_MS,
  type AdmittedRequest,
  type SpawnAuditRecord,
  type SpawnSupervisor,
  type SpawnSupervisorDeps,
} from "../../../../src/web-hub/hub/spawn/supervisor.js";
import { createReqDeadline, type ReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import type { HubSpawnConfig } from "../../../../src/web-hub/protocol/spawn.js";
import { memLog } from "../helpers.js";

const BOOT = "11111111-2222-3333-4444-555555555555";
const REALPATH = "/w/proj";
const LAUNCHER: readonly [string, string] = ["/usr/bin/node", "/repo/cli.js"];

/** `/proc/<pid>/stat` text: rest[2] = pgrp, rest[19] = starttime (fields 5 and 22 overall). */
function statLine(pid: number, pgrp: number, startTicks: number, comm = "pi"): string {
  const rest = ["S", String(pid - 1), String(pgrp)];
  while (rest.length < 19) rest.push("0");
  rest.push(String(startTicks));
  return `${pid} (${comm}) ${rest.join(" ")}`;
}

function statusLine(real: number, effective: number): string {
  return `Name:\tpi\nUid:\t${real}\t${effective}\t${real}\t${effective}\nGid:\t100\t100\t100\t100\n`;
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly handleKills: string[] = [];
  stdinEndSpy: ReturnType<typeof vi.spyOn<PassThrough, "end">> | undefined;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  override kill(signal?: string): boolean {
    if (signal !== undefined) this.handleKills.push(signal);
    return true;
  }

  override unref(): void {}
}

interface FakeReg extends SpawnRegistryPort {
  events: HubEvent[];
  views: Map<string, AgentView>;
  seed(key: string, over: Partial<AgentView>, caps?: readonly string[]): void;
}

function fakeRegistry(): FakeReg {
  const views = new Map<string, AgentView>();
  const caps = new Map<string, readonly string[]>();
  const events: HubEvent[] = [];
  const listeners = new Set<(e: HubEvent) => void>();
  const port = {
    list: () => [...views.values()],
    get: (k: string) => views.get(k),
    bus: {
      subscribe: (fn: (e: HubEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    publish: (e: HubEvent) => {
      events.push(e);
      for (const fn of listeners) fn(e);
    },
    getCaps: (k: string) => caps.get(k),
  } satisfies SpawnRegistryPort;
  return {
    ...port,
    events,
    views,
    seed(key, over, capList) {
      const pid = over.pid ?? 5151;
      views.set(key, {
        agentKey: key,
        kind: "rpc",
        pid,
        cwd: "/w/proj",
        state: "live",
        pluginVersion: "1.0.2",
        outdated: false,
        prompts: [],
        agentId: { pid, nonce: "nonceAAAAAAAAAAAAAAA" },
        connectedAt: 0,
        lastFrameAt: 0,
        seq: 0,
        ...over,
      });
      if (capList !== undefined) caps.set(key, capList);
    },
  };
}

interface FakeStore {
  calls: Array<{ op: string; records?: StoredRecord[] }>;
  saveNowResults: SpawnStoreWriteResult[];
  loaded: SpawnStoreLoad;
  healthy: boolean;
  port: SpawnStore;
  dirtyGet(): readonly StoredRecord[] | undefined;
}

function fakeStore(order: string[]): FakeStore {
  const calls: Array<{ op: string; records?: StoredRecord[] }> = [];
  const saveNowResults: SpawnStoreWriteResult[] = [];
  let loaded: SpawnStoreLoad = { records: [] };
  let healthy = true;
  let closed = false;
  let dirtyGet: (() => readonly StoredRecord[]) | undefined;
  const port = {
    load: (_d: ReqDeadline): SpawnStoreLoad => {
      calls.push({ op: "load" });
      return loaded;
    },
    saveNow: (recs: readonly StoredRecord[]): SpawnStoreWriteResult => {
      order.push("saveNow");
      calls.push({ op: "saveNow", records: [...recs] });
      const r = saveNowResults.length > 0 ? saveNowResults[0] : { ok: true };
      if (saveNowResults.length > 0) saveNowResults.shift();
      return r;
    },
    markDirty: (get: () => readonly StoredRecord[]): void => {
      calls.push({ op: "markDirty" });
      dirtyGet = get;
    },
    flushAndClose: (_d: ReqDeadline): void => {
      calls.push({ op: "flushAndClose" });
      closed = true;
    },
    get healthy(): boolean {
      return healthy;
    },
    get closed(): boolean {
      return closed;
    },
    get gen(): number {
      return calls.filter((c) => c.op === "saveNow").length;
    },
  } satisfies SpawnStore;
  return {
    calls,
    saveNowResults,
    get loaded() {
      return loaded;
    },
    set loaded(v: SpawnStoreLoad) {
      loaded = v;
    },
    get healthy() {
      return healthy;
    },
    set healthy(v: boolean) {
      healthy = v;
    },
    port,
    dirtyGet: () => dirtyGet?.(),
  };
}

interface FakeReaper {
  trackCalls: ReaperTrackRecord[];
  untracks: number[];
  closes: number;
  startOk: boolean;
  unavailable: boolean;
  restartListeners: Set<() => void>;
  port: Reaper;
  fireRestart(): void;
}

function fakeReaper(order: string[]): FakeReaper {
  const trackCalls: ReaperTrackRecord[] = [];
  const untracks: number[] = [];
  let closes = 0;
  let startOk = true;
  let unavailable = false;
  const restartListeners = new Set<() => void>();
  const unavailableListeners = new Set<() => void>();
  const port = {
    start: async (_d: ReqDeadline): Promise<boolean> => startOk,
    track: (rec: ReaperTrackRecord): void => {
      trackCalls.push(rec);
      order.push("track");
    },
    untrack: (pid: number): void => {
      untracks.push(pid);
    },
    close: (): void => {
      closes += 1;
    },
    get available() {
      return !unavailable;
    },
    onUnavailable: (cb: () => void) => {
      unavailableListeners.add(cb);
      return () => unavailableListeners.delete(cb);
    },
    onRestart: (cb: () => void) => {
      restartListeners.add(cb);
      return () => restartListeners.delete(cb);
    },
  } satisfies Reaper;
  return {
    trackCalls,
    untracks,
    get closes() {
      return closes;
    },
    get startOk() {
      return startOk;
    },
    set startOk(v: boolean) {
      startOk = v;
    },
    get unavailable() {
      return unavailable;
    },
    set unavailable(v: boolean) {
      unavailable = v;
      if (v) for (const cb of unavailableListeners) cb();
    },
    restartListeners,
    port,
    fireRestart: () => {
      for (const cb of restartListeners) cb();
    },
  };
}

interface FakeDirs {
  pinResult: { ok: true; fd: number; cwdArg: string } | { ok: false; reason: "changed" | "gone" };
  port: DirService;
}

function fakeDirs(order: string[]): FakeDirs {
  let pinResult: FakeDirs["pinResult"] = { ok: true, fd: 7, cwdArg: "/proc/self/fd/7" };
  const port = {
    known: async () => ({ entries: [], partial: false }),
    admit: async () => ({ ok: false, reason: "not-allowed" }),
    pinSync: (_a: { realpath: string; dev: number; ino: number }) => {
      order.push("pinSync");
      return pinResult;
    },
  } satisfies DirService;
  return {
    get pinResult() {
      return pinResult;
    },
    set pinResult(v: FakeDirs["pinResult"]) {
      pinResult = v;
    },
    port,
  };
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness {
  sup: SpawnSupervisor;
  registry: FakeReg;
  store: FakeStore;
  reaper: FakeReaper;
  dirs: FakeDirs;
  order: string[];
  kills: Array<{ pid: number; signal: string }>;
  umaskCalls: number[];
  closeFds: number[];
  spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }>;
  spawnImpl: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  audits: SpawnAuditRecord[];
  onLive: Array<{ spawnId: string; agentKey?: string; sessionId?: string; control?: boolean }>;
  onLink: Array<{ spawnId: string; linked: boolean }>;
  onTerminal: Array<{ spawnId: string; reason: string }>;
  procCorrupt: boolean;
  recheckOk: boolean;
  children: FakeChild[];
}

function baseCfg(over: Partial<HubSpawnConfig> = {}): HubSpawnConfig {
  return {
    roots: [],
    maxProcesses: 4,
    maxPerPrincipal: 2,
    ratePerMinute: 3,
    maxLifetimeMinutes: 720,
    registerTimeoutS: 10,
    lan: "off",
    ...over,
  };
}

function makeHarness(over: Partial<SpawnSupervisorDeps> = {}): Harness {
  const order: string[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const umaskCalls: number[] = [];
  const closeFds: number[] = [];
  const spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
  const audits: SpawnAuditRecord[] = [];
  const onLive: Harness["onLive"] = [];
  const onLink: Harness["onLink"] = [];
  const onTerminal: Harness["onTerminal"] = [];
  const children: FakeChild[] = [];
  const h: Harness = {
    sup: undefined as unknown as Harness["sup"], // assigned below
    registry: fakeRegistry(),
    store: fakeStore(order),
    reaper: fakeReaper(order),
    dirs: fakeDirs(order),
    order,
    kills,
    umaskCalls,
    closeFds,
    spawnCalls,
    spawnImpl: () => {
      throw new Error("spawnImpl not set");
    },
    audits,
    onLive,
    onLink,
    onTerminal,
    procCorrupt: false,
    recheckOk: true,
    children,
  };
  h.spawnImpl = (cmd, args, opts): ChildProcess => {
    spawnCalls.push({ cmd, args, opts });
    const child = new FakeChild(1000 + children.length);
    children.push(child);
    // Tests only use `as` outside the scanned src tree — this is the seam the plan's fake-child
    // acceptance explicitly prescribes.
    return child as unknown as ChildProcess;
  };
  let nextPid = 1000 + 100; // stat/status fixture path space
  const procRead = (path: string): string => {
    if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
    if (path === "/proc/stat") return "btime 1759000000\n";
    const statMatch = /^\/proc\/(\d+)\/stat$/.exec(path);
    if (statMatch !== null) {
      order.push("readStatSync");
      const pid = Number(statMatch[1]);
      return statLine(pid, pid, h.procCorrupt ? 424242 : 100);
    }
    const statusMatch = /^\/proc\/(\d+)\/status$/.exec(path);
    if (statusMatch !== null) return statusLine(1000, 1000);
    throw new Error(`ENOENT: ${path}`);
  };
  const launcherFs: LauncherFs = {
    realpath: async (p) => p,
    stat: async (p) => ({
      dev: 1,
      ino: p.endsWith("cli.js") ? 11 : 10,
      size: p.endsWith("cli.js") ? 200 : 100,
      mtimeMs: p.endsWith("cli.js") ? 2_000 : 1_000,
      isFile: () => true,
    }),
    readFileSync: (p) => {
      if (p === "/repo/package.json") {
        return JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.2" });
      }
      throw new Error(`ENOENT: ${p}`);
    },
    statSync: (p) => {
      if (!h.recheckOk) return { dev: 1, ino: 999, size: 200, mtimeMs: 3_000, isFile: () => true };
      return {
        dev: 1,
        ino: p.endsWith("cli.js") ? 11 : 10,
        size: p.endsWith("cli.js") ? 200 : 100,
        mtimeMs: p.endsWith("cli.js") ? 2_000 : 1_000,
        isFile: () => true,
      };
    },
  };
  const deps: SpawnSupervisorDeps = {
    cfg: baseCfg(),
    registry: h.registry,
    log: memLog(),
    now: () => Date.now(),
    store: h.store.port,
    reaper: h.reaper.port,
    dirs: h.dirs.port,
    launcher: LAUNCHER,
    env: { KEEP: "yes", PI_WEBHUB_TOKEN: "secret", PI_WEBHUB_CONFIG: "json" },
    childUmask: 0o022,
    platform: { ok: true },
    spawnFn: ((cmd: string, args: string[], opts: SpawnOptions) => {
      order.push("spawnFn");
      return h.spawnImpl(cmd, args, opts);
      // The plan's own acceptance prescribes a fake child here; only the src tree is zero-`as`.
    }) as typeof realSpawn,
    proc: { readFileSync: procRead, platform: "linux" },
    audit: (r) => audits.push(r),
    onLive: (rec) =>
      onLive.push({ spawnId: rec.spawnId, agentKey: rec.agentKey, sessionId: rec.sessionId, control: rec.control }),
    onLink: (spawnId, linked) => onLink.push({ spawnId, linked }),
    onTerminal: (spawnId, reason) => onTerminal.push({ spawnId, reason }),
    closeSync: (fd) => closeFds.push(fd),
    umask: (mask: number) => {
      umaskCalls.push(mask);
      return 0o077;
    },
    kill: (pid, signal) => {
      kills.push({ pid, signal });
    },
    getuid: () => 1000,
    pluginVersion: "1.0.2",
    launcherFs,
    ...over,
  };
  h.sup = createSpawnSupervisor(deps);
  void nextPid;
  return h;
}

function deadline(ms = 10_000): ReqDeadline {
  return createReqDeadline(() => Date.now(), ms);
}

let seq = 0;
function req(over: Partial<AdmittedRequest> = {}): AdmittedRequest {
  seq += 1;
  return {
    spawnId: `sp${String(seq).padStart(16, "0")}`,
    admitted: { realpath: REALPATH, dev: 9, ino: 99, known: true },
    owner: { listener: "loopback", reqId: `r${seq}` },
    ...over,
  };
}

function sessionInfo(cwd = REALPATH): {
  sessionId: string;
  cwd: string;
  reason: string;
  leafId: string | null;
  mode: "rpc";
} {
  return { sessionId: "sess-1", cwd, reason: "new", leafId: null, mode: "rpc" };
}

/** Drive one started record to `live` (spawn event → agent_up with caps → session). */
async function driveToLive(
  h: Harness,
  key = "k1000",
  over: { cwd?: string; caps?: readonly string[] } = {},
): Promise<FakeChild> {
  const child = h.children[h.children.length - 1];
  if (child === undefined) throw new Error("no child");
  const cwd = over.cwd ?? REALPATH;
  h.registry.seed(key, { pid: child.pid, cwd }, over.caps ?? ["cmd.v1", "dialog.v1"]);
  child.emit("spawn");
  h.registry.publish({
    type: "agent_up",
    agent: {
      agentKey: key,
      kind: "rpc",
      pid: child.pid,
      cwd,
      state: "live",
      pluginVersion: "1.0.2",
      outdated: false,
      prompts: [],
    },
  });
  h.registry.publish({ type: "session", agentKey: key, session: sessionInfo(cwd) });
  await vi.advanceTimersByTimeAsync(0);
  return child;
}

function rec0(h: Harness) {
  return h.sup.records()[0];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// ①–④ synchronous stretch (L1 hard gate #1)
// ---------------------------------------------------------------------------

describe("supervisor ①–④: intent → pin → fork → identity (plan §3.1 rows 1–4)", () => {
  it("L1 order (#1 hard gate): saveNow(launching) → pinSync → spawnFn → readStatSync → saveNow(pid) → track", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    const res = h.sup.start(r, deadline());
    expect(res).toEqual({ ok: true, spawnId: r.spawnId });
    expect(h.order).toEqual(["saveNow", "pinSync", "spawnFn", "readStatSync", "saveNow", "track"]);
    const saves = h.store.calls.filter((c) => c.op === "saveNow");
    expect(saves[0]?.records?.find((x) => x.spawnId === r.spawnId)?.state).toBe("launching");
    expect(saves[1]?.records?.find((x) => x.spawnId === r.spawnId)?.state).toBe("starting");
    expect(h.reaper.trackCalls[0]).toMatchObject({
      spawnId: r.spawnId,
      pid: 1000,
      startTicks: 100,
      bootId: BOOT,
      uid: 1000,
    });
  });

  it("① saveNow failure ⇒ E_LAUNCHER{persist}, spawnFn never called, no record left", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.store.saveNowResults.push({ ok: false, code: "EIO" });
    const res = h.sup.start(req(), deadline());
    expect(res).toEqual({ ok: false, code: "E_LAUNCHER", reason: "persist" });
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.sup.records()).toHaveLength(0);
  });

  it("① deadline余量 < 500ms ⇒ E_DEADLINE, store untouched (beyond init's load)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const res = h.sup.start(
      req(),
      createReqDeadline(() => Date.now(), 300),
    );
    expect(res).toEqual({ ok: false, code: "E_DEADLINE" });
    expect(h.store.calls.filter((c) => c.op === "saveNow")).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("② pinSync changed ⇒ E_DIR{changed}, record failed{spawn_error}, breaker-EXEMPT (next start reaches pin again)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.dirs.pinResult = { ok: false, reason: "changed" };
    const r = req();
    const res = h.sup.start(r, deadline());
    expect(res).toEqual({ ok: false, code: "E_DIR", reason: "changed" });
    expect(h.spawnCalls).toHaveLength(0);
    const rec = h.sup.records()[0];
    expect(rec).toMatchObject({ state: "failed", endReason: "spawn_error" });
    // review re-run #5: the ONE terminal entry point also fired the SP8 bridge — the
    // forwarder's pending prompt expires instead of leaking
    expect(h.onTerminal).toEqual([{ spawnId: r.spawnId, reason: "never_live" }]);
    // breaker NOT tripped by ②: a second start passes the cooldown gate and reaches pinSync
    const callsBefore = h.store.calls.filter((c) => c.op === "saveNow").length;
    h.sup.start(req(), deadline());
    expect(h.store.calls.filter((c) => c.op === "saveNow").length).toBe(callsBefore + 1);
  });

  it("③ spawnFn sync throw ⇒ start still ok (202 contract), record failed{spawn_error}, breaker counts", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.spawnImpl = () => {
      throw new Error("spawn ENOENT");
    };
    const r = req();
    const res = h.sup.start(r, deadline());
    expect(res).toEqual({ ok: true, spawnId: r.spawnId });
    const rec = h.sup.records()[0];
    expect(rec).toMatchObject({ state: "failed", endReason: "spawn_error" });
    expect(rec.hintDetail).toContain("ENOENT");
    // breaker counted: a second immediate start now has cooldown [0] (still allowed), third 5s
    h.sup.start(req(), deadline());
    expect(h.sup.start(req(), deadline())).toMatchObject({ ok: false, code: "E_LAUNCHER", reason: "cooldown" });
  });

  it("④ L1 second saveNow failure ⇒ child stopped via escalation, failed{spawn_error}, 202 contract holds (review re-run #2)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.store.saveNowResults.push({ ok: true }, { ok: false, code: "ENOSPC" }); // write #1 ok, write #2 fails
    const r = req();
    const res = h.sup.start(r, deadline());
    expect(res).toEqual({ ok: true, spawnId: r.spawnId }); // record exists (①) ⇒ 202
    const rec = h.sup.records()[0];
    if (rec === undefined) throw new Error("record missing");
    expect(rec).toMatchObject({ state: "stopping", endReason: "spawn_error", pid: 1000 });
    expect(h.reaper.trackCalls).toHaveLength(1); // L2: in-memory identity still tracked
    const child = h.children[0];
    if (child === undefined) throw new Error("no child");
    expect(child.stdin.writableEnded).toBe(true); // escalation stage 0 ran immediately
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGTERM" }]); // verified signal
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
    // breaker counted this launch failure (not exempt): one MORE failure puts the next start
    // into the 5s cooldown
    h.spawnImpl = () => {
      throw new Error("boom");
    };
    expect(h.sup.start(req(), deadline()).ok).toBe(true); // failure #2 (202 contract)
    expect(h.sup.start(req(), deadline())).toMatchObject({ ok: false, code: "E_LAUNCHER", reason: "cooldown" });
  });

  it("④ L1 second saveNow failure: a later async child 'error' is handled, not unhandled (review re-run 2 #1)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.store.saveNowResults.push({ ok: true }, { ok: false, code: "ENOSPC" });
    const r = req();
    h.sup.start(r, deadline());
    expect(rec0(h)?.state).toBe("stopping");
    // an EventEmitter 'error' with no listener would THROW here and fail the test outright
    h.children[0]?.emit("error", new Error("spawn worker died"));
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
  });

  it("④ /proc stat unreadable ⇒ pid recorded, no identity, no track; exit ⇒ failed{exited_early}", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (path === "/proc/1000/stat") throw new Error("gone");
      if (/\/status$/.test(path)) return statusLine(1000, 1000);
      throw new Error(`ENOENT: ${path}`);
    };
    const h2 = makeHarness({ proc: { readFileSync: procRead, platform: "linux" } });
    void h;
    await h2.sup.init(deadline());
    h2.sup.start(req(), deadline());
    expect(h2.reaper.trackCalls).toHaveLength(0);
    const rec = rec0(h2);
    expect(rec.pid).toBe(1000);
    expect(rec.procStartTicks).toBeUndefined();
    h2.children[0]?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h2)).toMatchObject({ state: "failed", endReason: "exited_early" });
    expect(h2.onTerminal).toEqual([{ spawnId: rec0(h2)?.spawnId ?? "", reason: "never_live" }]);
  });
});

// ---------------------------------------------------------------------------
// ⑤–⑦ spawn event / hello / session
// ---------------------------------------------------------------------------

describe("supervisor ⑤⑥⑦: spawn event, hello bind, session live (plan §3.1 rows 5–7)", () => {
  it("⑤ no spawn event within SPAWN_EVENT_MS ⇒ identity-verified SIGKILL + failed{spawn_error}", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.kills).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGKILL" }]);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
  });

  it("⑤ timeout with a FAILED identity verify ⇒ NO signal at all (L5, review re-run #1)", async () => {
    // flavor A: ④ captured an identity, but /proc no longer agrees (tampered starttime)
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    h.procCorrupt = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.kills).toHaveLength(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });

    // flavor B: ④ never captured an identity (unreadable /proc) — same no-signal outcome
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (/\/stat$/.test(path)) throw new Error("gone");
      if (/\/status$/.test(path)) return statusLine(1000, 1000);
      throw new Error(`ENOENT: ${path}`);
    };
    const h2 = makeHarness({ proc: { readFileSync: procRead, platform: "linux" } });
    await h2.sup.init(deadline());
    h2.sup.start(req(), deadline());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h2.kills).toHaveLength(0);
    expect(rec0(h2)).toMatchObject({ state: "failed", endReason: "spawn_error" });
  });

  it("⑤ child 'error' event before spawn ⇒ failed{spawn_error}", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    h.children[0]?.emit("error", new Error("ENOENT"));
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
    expect(h.kills).toHaveLength(0); // no process ever existed
  });

  it("⑥ agent_up pid match + cwd mismatch ⇒ stop escalation + failed{cwd_mismatch}", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    const child = h.children[0];
    if (child === undefined) throw new Error("no child");
    child.emit("spawn");
    h.registry.seed("k1000", { pid: child.pid, cwd: "/elsewhere" }, ["cmd.v1"]);
    h.registry.publish({
      type: "agent_up",
      agent: {
        agentKey: "k1000",
        kind: "rpc",
        pid: child.pid,
        cwd: "/elsewhere",
        state: "live",
        pluginVersion: "1.0.2",
        outdated: false,
        prompts: [],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "stopping", endReason: "cwd_mismatch", hint: "cwd-mismatch" });
    expect(child.stdin.writableEnded).toBe(true); // stdin.end() fired immediately
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGTERM" }]);
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "cwd_mismatch" });
  });

  it("⑥⑦ register deadline: unbound ⇒ hint …-hello; bound-no-session ⇒ …-session", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    h.children[0]?.emit("spawn");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rec0(h)).toMatchObject({ state: "stopping", endReason: "register_timeout", hint: "register-timeout-hello" });

    const h2 = makeHarness();
    await h2.sup.init(deadline());
    h2.sup.start(req(), deadline());
    const child = h2.children[0];
    if (child === undefined) throw new Error("no child");
    child.emit("spawn");
    h2.registry.seed("k1000", { pid: child.pid }, ["cmd.v1"]);
    h2.registry.publish({
      type: "agent_up",
      agent: {
        agentKey: "k1000",
        kind: "rpc",
        pid: child.pid,
        cwd: REALPATH,
        state: "live",
        pluginVersion: "1.0.2",
        outdated: false,
        prompts: [],
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rec0(h2)).toMatchObject({
      state: "stopping",
      endReason: "register_timeout",
      hint: "register-timeout-session",
    });
  });

  it("⑦ agent_up with session already present ⇒ live directly; control from caps; breaker cleared", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    // prime the breaker with one launch failure first
    const origImpl = h.spawnImpl;
    h.spawnImpl = () => {
      throw new Error("nope");
    };
    h.sup.start(req(), deadline());
    h.spawnImpl = origImpl;
    const r = req();
    h.sup.start(r, deadline());
    const child = h.children[0];
    if (child === undefined) throw new Error("no child");
    const key = "k1001";
    h.registry.seed(key, { pid: child.pid, session: sessionInfo() }, ["cmd.v1", "dialog.v1"]);
    child.emit("spawn");
    h.registry.publish({
      type: "agent_up",
      agent: {
        agentKey: key,
        kind: "rpc",
        pid: child.pid,
        cwd: REALPATH,
        state: "live",
        pluginVersion: "1.0.2",
        outdated: false,
        prompts: [],
        session: sessionInfo(),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const rec = h.sup.records().find((x) => x.spawnId === r.spawnId);
    if (rec === undefined) throw new Error("record missing");
    expect(rec.state).toBe("live");
    expect(rec.control).toBe(true);
    expect(h.onLive).toEqual([{ spawnId: r.spawnId, agentKey: key, sessionId: "sess-1", control: true }]);
    // live cleared the breaker: an immediate next start is not cooldown-blocked
    expect(h.sup.start(req(), deadline()).ok).toBe(true);
  });

  it("⑦ live without cmd.v1 ⇒ control-off; onLive still fires with control=false", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    await driveToLive(h, "k1000", { caps: [] });
    expect(rec0(h)).toMatchObject({ state: "live", hint: "control-off", control: false });
    expect(h.onLive[0]?.control).toBe(false);
  });

  it("⑧ bridge: agent_down/agent_up drive onLink(false)/(true)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    h.registry.publish({ type: "agent_down", agentKey: "k1000", reason: "bye" });
    h.registry.publish({
      type: "agent_up",
      agent: {
        agentKey: "k1000",
        kind: "rpc",
        pid: 1000,
        cwd: REALPATH,
        state: "live",
        pluginVersion: "1.0.2",
        outdated: false,
        prompts: [],
      },
    });
    expect(h.onLink).toEqual([
      { spawnId: r.spawnId, linked: false },
      { spawnId: r.spawnId, linked: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ⑨⑩ lifetime & stop escalation
// ---------------------------------------------------------------------------

describe("supervisor ⑨⑩: lifetime & stop escalation (plan §3.1 rows 9–10)", () => {
  it("⑩ timeline 0/5/8/13s: stdin.end → TERM → KILL → guard terminal; identity verified before each signal", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const child = await driveToLive(h, "k1000");
    const statReads0 = h.order.filter((x) => x === "readStatSync").length;
    h.sup.stop(r.spawnId, false);
    expect(child.stdin.writableEnded).toBe(true); // t=0
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.kills).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); // t=5s
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGTERM" }]);
    const statReads5 = h.order.filter((x) => x === "readStatSync").length;
    expect(statReads5).toBeGreaterThan(statReads0); // L5: verified before TERM
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.kills).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // t=8s
    expect(h.kills).toEqual([
      { pid: -1000, signal: "SIGTERM" },
      { pid: -1000, signal: "SIGKILL" },
    ]);
    expect(h.order.filter((x) => x === "readStatSync").length).toBeGreaterThan(statReads5); // before KILL
    await vi.advanceTimersByTimeAsync(5_000); // t=13s guard
    const rec = rec0(h);
    expect(rec).toMatchObject({
      state: "exited",
      endReason: "user",
      exit: { code: null, signal: null, unconfirmed: true },
    });
    expect(h.reaper.untracks).toContain(1000);
  });

  it("⑩ L5: identity verify fails ⇒ NO signal at any stage, guard terminal with unconfirmed exit", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    h.procCorrupt = true; // starttime drifts — every verify now fails closed
    h.sup.stop(r.spawnId, false);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(h.kills).toHaveLength(0);
    expect(rec0(h)?.exit).toMatchObject({ unconfirmed: true });
    expect(rec0(h)?.state).toBe("exited");
  });

  it("⑩ exit during escalation ⇒ terminal with the stop's reason and the real exit", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const child = await driveToLive(h, "k1000");
    h.sup.stop(r.spawnId, false);
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({
      state: "exited",
      endReason: "user",
      exit: { code: 0, signal: null },
    });
  });

  it("⑨ lifetime deadline ⇒ exited{lifetime} via escalation", async () => {
    const h = makeHarness({ cfg: baseCfg({ maxLifetimeMinutes: 1 }) });
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rec0(h)).toMatchObject({ state: "stopping", endReason: "lifetime" });
    h.children[0]?.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "lifetime" });
  });

  it("live exit without stop ⇒ exited{crash}; stop after terminal is idempotent; unknown id 404", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const child = await driveToLive(h, "k1000");
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "crash" });
    expect(h.sup.stop(r.spawnId, false)).toEqual({ ok: true, state: "exited" });
    expect(h.sup.stop("nope", false)).toEqual({ ok: false, code: "E_NOT_FOUND" });
  });

  it("protocol_error from stdout ⇒ stopping (live ⇒ exited{protocol_error})", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const child = await driveToLive(h, "k1000");
    // a ui_request line with no extractable id — rpc-stdio reports ui-request-head
    child.stdout.write('{"type":"extension_ui_request","method":"select","title":"x"}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "stopping", endReason: "protocol_error", hint: "protocol-error" });
    expect(rec0(h)?.hintDetail).toBe("ui-request-head");
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "protocol_error" });
  });
});

// ---------------------------------------------------------------------------
// resources & breaker (case 4)
// ---------------------------------------------------------------------------

describe("supervisor resources & breaker (#11 hard gate, arch §6.5)", () => {
  it("global / principal limits ⇒ E_LIMIT with counters; existing records untouched", async () => {
    const h = makeHarness({ cfg: baseCfg({ maxProcesses: 2, maxPerPrincipal: 2 }) });
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    h.sup.start(req(), deadline());
    const before = h.sup.records().map((x) => x.state);
    expect(h.sup.start(req(), deadline())).toEqual({
      ok: false,
      code: "E_LIMIT",
      reason: "limit",
      limit: "global",
      active: 2,
      max: 2,
    });
    expect(h.sup.records().map((x) => x.state)).toEqual(before); // #11: a full table never disturbs existing records

    const hp = makeHarness({ cfg: baseCfg({ maxProcesses: 4, maxPerPrincipal: 1 }) });
    await hp.sup.init(deadline());
    hp.sup.start(req(), deadline());
    expect(hp.sup.start(req(), deadline())).toMatchObject({
      ok: false,
      code: "E_LIMIT",
      limit: "principal",
      active: 1,
      max: 1,
    });
    // a different principal passes the same principal cap
    expect(hp.sup.start(req({ owner: { listener: "loopback", user: "bob", reqId: "r-bob" } }), deadline()).ok).toBe(
      true,
    );
  });

  it("starting limit: SPAWN_STARTING_MAX concurrent starting records ⇒ E_LIMIT{starting}", async () => {
    const h = makeHarness({ cfg: baseCfg({ maxProcesses: 8, maxPerPrincipal: 8 }) });
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    h.sup.start(req(), deadline());
    expect(h.sup.start(req(), deadline())).toMatchObject({
      ok: false,
      code: "E_LIMIT",
      limit: "starting",
      active: 2,
      max: 2,
    });
    // driving one live frees a starting slot
    await driveToLive(h, "k1000");
    expect(h.sup.start(req(), deadline()).ok).toBe(true);
  });

  it("breaker ladder [0,5s,30s] → 10min open → half-open after expiry (db-client paradigm)", async () => {
    const h = makeHarness({ cfg: baseCfg({ maxProcesses: 64, maxPerPrincipal: 64 }) });
    await h.sup.init(deadline());
    h.spawnImpl = () => {
      throw new Error("boom");
    };
    const fail = (): void => void h.sup.start(req(), deadline());
    fail(); // #1 → cooldown 0
    fail(); // #2 → cooldown 5s
    const gate2 = h.sup.start(req(), deadline());
    expect(gate2).toMatchObject({ ok: false, code: "E_LAUNCHER", reason: "cooldown", retryAfterS: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    fail(); // #3 → cooldown 30s
    expect(h.sup.start(req(), deadline())).toMatchObject({
      ok: false,
      code: "E_LAUNCHER",
      reason: "cooldown",
      retryAfterS: 30,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    fail(); // #4 → breaker opens for 10 minutes
    const open = h.sup.start(req(), deadline());
    expect(open).toMatchObject({ ok: false, code: "E_LAUNCHER", reason: "breaker", retryAfterS: 600 });
    const attempts = (): number => h.order.filter((x) => x === "spawnFn").length;
    const spawned = attempts();
    await vi.advanceTimersByTimeAsync(600_000); // open period elapses
    fail(); // half-open probe goes through
    expect(attempts()).toBe(spawned + 1);
    fail(); // probe failed into an emptied window — allowed again (cooldown [0])
    expect(attempts()).toBe(spawned + 2);
  });

  it("live clears the breaker count (§3.1 ⑦: live 清零)", async () => {
    const h = makeHarness({ cfg: baseCfg({ maxProcesses: 64, maxPerPrincipal: 64 }) });
    await h.sup.init(deadline());
    const impl = h.spawnImpl;
    const boom = (): void => {
      h.spawnImpl = () => {
        throw new Error("boom");
      };
    };
    boom();
    h.sup.start(req(), deadline());
    h.sup.start(req(), deadline()); // 2 failures → next start cools 5s
    expect(h.sup.start(req(), deadline())).toMatchObject({ reason: "cooldown", retryAfterS: 5 });
    await vi.advanceTimersByTimeAsync(5_000); // cooldown elapses
    h.spawnImpl = impl;
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1002"); // live ⇒ count cleared
    expect(h.sup.policy("loopback:token", "loopback", "http", false).allowed).toBe(true);
    // two FRESH failures after the clear ladder back at step 2 (5s), not step 3 (30s)
    boom();
    h.sup.start(req(), deadline());
    h.sup.start(req(), deadline());
    expect(h.sup.start(req(), deadline())).toMatchObject({ reason: "cooldown", retryAfterS: 5 });
  });

  it("store unhealthy ⇒ E_LAUNCHER{persist}; reaper unavailable ⇒ E_LAUNCHER{reaper}", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.store.healthy = false;
    expect(h.sup.start(req(), deadline())).toEqual({ ok: false, code: "E_LAUNCHER", reason: "persist" });
    h.store.healthy = true;
    h.reaper.unavailable = true;
    expect(h.sup.start(req(), deadline())).toEqual({ ok: false, code: "E_LAUNCHER", reason: "reaper" });
    expect(h.sup.policy("loopback:token", "loopback", "http", false)).toMatchObject({
      allowed: false,
      reason: "reaper",
    });
  });

  it("reaper respawn re-tracks every non-terminal record with identity (L2)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    h.sup.start(req(), deadline());
    h.reaper.fireRestart();
    expect(h.reaper.trackCalls.length).toBeGreaterThanOrEqual(4); // initial + re-track for both
    expect(new Set(h.reaper.trackCalls.map((t) => t.spawnId)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// launcher chain (case 3)
// ---------------------------------------------------------------------------

describe("supervisor launcher chain (arch §4.2/#12)", () => {
  async function initWithFs(fs: LauncherFs): Promise<SpawnSupervisor> {
    const h = makeHarness({ launcherFs: fs });
    await h.sup.init(deadline());
    return h.sup;
  }

  const badPkgFs = (version: string): LauncherFs => ({
    realpath: async (p) => p,
    stat: async (p) => ({
      dev: 1,
      ino: 10,
      size: 1,
      mtimeMs: 1,
      isFile: () => true,
      ...(p.endsWith("cli.js") ? {} : {}),
    }),
    readFileSync: (p) => {
      if (p === "/repo/package.json") return JSON.stringify({ name: "@earendil-works/pi-coding-agent", version });
      throw new Error("ENOENT");
    },
    statSync: () => {
      throw new Error("unused");
    },
  });

  it("init failure reasons surface in policy + start", async () => {
    for (const [fs, reason] of [
      [badPkgFs("0.99.0"), "incompatible"],
      [badPkgFs("1.1.0"), "incompatible"],
    ] as const) {
      const sup = await initWithFs(fs);
      expect(sup.policy("p", "loopback", "http", false)).toMatchObject({ allowed: false, reason: "launcher" });
      expect(sup.start(req(), deadline())).toMatchObject({ ok: false, code: "E_LAUNCHER", reason });
    }
    // unverifiable: no package.json anywhere up
    const noPkg: LauncherFs = {
      ...badPkgFs("1.0.2"),
      readFileSync: () => {
        throw new Error("ENOENT");
      },
    };
    const sup2 = await initWithFs(noPkg);
    expect(sup2.start(req(), deadline())).toMatchObject({ ok: false, code: "E_LAUNCHER", reason: "unverifiable" });
    // missing: launcher absent from config
    const h3 = makeHarness({ launcher: undefined });
    await h3.sup.init(deadline());
    expect(h3.sup.start(req(), deadline())).toMatchObject({ ok: false, code: "E_LAUNCHER", reason: "missing" });
    expect(h3.sup.policy("p", "loopback", "http", false)).toMatchObject({ allowed: false, reason: "launcher" });
  });

  it("init ok, then launcher[1] stat drifts ⇒ E_LAUNCHER{changed} and policy degrades to launcher/changed", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    expect(h.sup.start(req(), deadline()).ok).toBe(true);
    h.recheckOk = false; // statSync now disagrees with the init fingerprint
    expect(h.sup.start(req(), deadline())).toEqual({ ok: false, code: "E_LAUNCHER", reason: "changed" });
    expect(h.sup.policy("p", "loopback", "http", false)).toMatchObject({
      allowed: false,
      reason: "launcher",
      detail: "changed",
    });
    // sticky: even a fresh stat would be ignored until /webhub restart
    h.recheckOk = true;
    expect(h.sup.start(req(), deadline())).toMatchObject({ ok: false, code: "E_LAUNCHER", reason: "changed" });
  });
});

// ---------------------------------------------------------------------------
// env / argv / umask (case 6)
// ---------------------------------------------------------------------------

describe("supervisor fork env, argv and umask (arch §4.2)", () => {
  it("argv fixed, cwd pinned to /proc/self/fd/N, PI_WEBHUB_* stripped, PWD set, umask [inherited, 0o077]", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const call = h.spawnCalls[0];
    if (call === undefined) throw new Error("no spawn");
    expect([call.cmd, call.args]).toEqual(["/usr/bin/node", ["/repo/cli.js", "--mode", "rpc"]]);
    expect(call.opts.cwd).toBe("/proc/self/fd/7");
    expect(call.opts.detached).toBe(true);
    expect(call.opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    const env = call.opts.env as Record<string, string | undefined>;
    expect(env.KEEP).toBe("yes");
    expect(env.PWD).toBe(REALPATH);
    expect(env.PI_WEBHUB_HEADLESS).toBe("1");
    expect(env.PI_WEBHUB_SPAWN_ID).toBe(r.spawnId);
    const webhubKeys = Object.keys(env)
      .filter((k) => k.startsWith("PI_WEBHUB_"))
      .sort();
    expect(webhubKeys).toEqual(["PI_WEBHUB_HEADLESS", "PI_WEBHUB_SPAWN_ID"]);
    expect(h.umaskCalls).toEqual([0o022, 0o077]);
    expect(h.closeFds).toEqual([7]);
  });

  it("childUmask undefined ⇒ no umask dance at all", async () => {
    const h = makeHarness({ childUmask: undefined });
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    expect(h.umaskCalls).toEqual([]);
    expect(h.closeFds).toEqual([7]);
  });
});

// ---------------------------------------------------------------------------
// shutdown (case 7) & platform (case 9)
// ---------------------------------------------------------------------------

describe("supervisor shutdown (arch §7.6 grading) & platform fail-closed (§7.1)", () => {
  it("normal 10s deadline: graceful wait ≤3s, then verified SIGTERM, flushAndClose + reaper.close once, start ⇒ closed", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const child = await driveToLive(h, "k1000");
    const t0 = Date.now();
    const p = h.sup.shutdown(deadline());
    expect(child.stdin.writableEnded).toBe(true); // EOF immediately
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.kills).toHaveLength(0); // still inside the graceful window
    await vi.advanceTimersByTimeAsync(1); // 3s budget exhausted
    await p;
    expect(Date.now() - t0).toBeLessThanOrEqual(3_100);
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGTERM" }]);
    expect(h.store.calls.filter((c) => c.op === "flushAndClose")).toHaveLength(1);
    expect(h.reaper.closes).toBe(1);
    expect(h.sup.start(req(), deadline())).toEqual({ ok: false, code: "E_LAUNCHER", reason: "closed" });
    // children that exit during the wait resolve shutdown early
  });

  it("children exiting within the budget ⇒ no signal at all", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    const child = await driveToLive(h, "k1000");
    const p = h.sup.shutdown(deadline());
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(h.kills).toHaveLength(0);
  });

  it("crash budget (remaining 2.5s): wait 0, immediate TERM", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    await driveToLive(h, "k1000");
    const p = h.sup.shutdown(createReqDeadline(() => Date.now(), 2_500));
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGTERM" }]);
  });

  it("platform.ok=false ⇒ policy reason platform, start E_SPAWN_DENIED{platform}, no store/reaper calls (§7.1)", async () => {
    const h = makeHarness({ platform: { ok: false, detail: "non-linux" } });
    await h.sup.init(deadline());
    expect(h.sup.policy("p", "loopback", "http", false)).toMatchObject({
      allowed: false,
      reason: "platform",
      detail: "non-linux",
    });
    expect(h.sup.start(req(), deadline())).toEqual({ ok: false, code: "E_SPAWN_DENIED", reason: "platform" });
    expect(h.store.calls).toHaveLength(0);
    expect(h.reaper.closes).toBe(0);
    expect(h.reaper.trackCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// versions, surface helpers, pushes (cases 8 + misc)
// ---------------------------------------------------------------------------

describe("supervisor surface: noteVersion, records, busy/live counts, spawns push", () => {
  it("noteVersion with a newer version ⇒ hint newer-plugin; equal version ⇒ untouched", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    await driveToLive(h, "k1000");
    h.sup.noteVersion("k1000", "9.9.9");
    expect(rec0(h)?.hint).toBe("newer-plugin");
    h.sup.noteVersion("k1000", "1.0.2"); // same version — no change
    expect(rec0(h)?.hint).toBe("newer-plugin"); // sticky until next event
    h.sup.noteVersion("unknown-key", "9.9.9"); // not managed — ignored
  });

  it("isManaged/liveCount/busyCount track the fleet", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    expect(h.sup.liveCount()).toBe(0);
    expect(h.sup.isManaged("k1000")).toBe(false);
    h.sup.start(req(), deadline());
    await driveToLive(h, "k1000", {});
    h.registry.seed("k1000", { pid: 1000, status: { leafId: null, busy: true, pending: false } });
    expect(h.sup.isManaged("k1000")).toBe(true);
    expect(h.sup.liveCount()).toBe(1);
    expect(h.sup.busyCount()).toBe(1);
    h.registry.seed("k1000", { pid: 1000, status: { leafId: null, busy: false, pending: false } });
    expect(h.sup.busyCount()).toBe(0);
    h.children[0]?.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sup.liveCount()).toBe(0);
    expect(h.sup.isManaged("k1000")).toBe(false);
  });

  it("spawns pushes merge per tick and carry ONLY the public projection (arch §6.4)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const pushes0 = h.registry.events.filter((e) => e.type === "spawns").length;
    const r = req({ firstPrompt: { textLen: 120, deliver: "steer" } });
    h.sup.start(r, deadline());
    await vi.advanceTimersByTimeAsync(0);
    const pushes = h.registry.events.filter((e) => e.type === "spawns");
    expect(pushes.length).toBe(pushes0 + 1); // one merged push for the whole synchronous stretch
    const payload = pushes[pushes.length - 1];
    if (payload.type !== "spawns") throw new Error("unreachable");
    const item = payload.payload.items.find((i) => i.spawnId === r.spawnId);
    expect(item).toMatchObject({ state: "starting", cwdLabel: "proj", pid: 1000 });
    expect(item && "cwd" in item).toBe(false); // full path is owner-only
    expect(item?.firstPrompt).toEqual({ state: "pending" });
    expect(payload.payload).toMatchObject({ active: 1, max: 4 });
    // first-prompt slice persisted on the record (length only — never text)
    expect(rec0(h)?.firstPrompt).toEqual({ state: "pending", textLen: 120 });
  });

  it("noteSpawnChanged (SP8 onChange landing) triggers a merged push + debounced persist", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await vi.advanceTimersByTimeAsync(0);
    const pushes0 = h.registry.events.filter((e) => e.type === "spawns").length;
    const dirty0 = h.store.calls.filter((c) => c.op === "markDirty").length;
    h.sup.noteSpawnChanged(r.spawnId);
    h.sup.noteSpawnChanged(r.spawnId);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.registry.events.filter((e) => e.type === "spawns").length).toBe(pushes0 + 1);
    expect(h.store.calls.filter((c) => c.op === "markDirty").length).toBe(dirty0 + 1);
  });

  it("policy(): scope/confirm per listener & transport (arch §6.2/§6.4)", async () => {
    const h = makeHarness({ cfg: baseCfg({ lan: "roots", maxProcesses: 3, maxPerPrincipal: 1 }) });
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    const loopback = h.sup.policy("loopback:token", "loopback", "http", false);
    expect(loopback).toMatchObject({
      allowed: true,
      scope: "roots",
      confirm: "unknown-dir",
      active: 1,
      activeMine: 1,
      max: 3,
    });
    const lanHttps = h.sup.policy("lan:bob", "lan", "https", true);
    expect(lanHttps).toMatchObject({ scope: "roots", confirm: "always", activeMine: 0 });
    const lanPlain = h.sup.policy("lan:bob", "lan", "http", false);
    expect(lanPlain).toMatchObject({ scope: "known" }); // plaintext direct is capped to known
    const otherPrincipal = h.sup.policy("lan:bob", "lan", "https", true);
    expect(otherPrincipal.activeMine).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// boot recovery (arch §7.7)
// ---------------------------------------------------------------------------

describe("supervisor init recovery (arch §7.7)", () => {
  function storedRecord(over: Partial<StoredRecord> = {}): StoredRecord {
    return {
      spawnId: "spold00000000001",
      state: "starting",
      cwd: REALPATH,
      dev: 9,
      ino: 99,
      createdAt: 1_000,
      updatedAt: 1_000,
      owner: { listener: "loopback", reqId: "r1" },
      pid: 1000,
      procStartTicks: 100,
      bootId: BOOT,
      uid: 1000,
      ...over,
    };
  }

  it("non-terminal record: exited{orphan} recorded synchronously, TERM deferred off init's stack (review re-run 2 #2)", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [storedRecord()], writer: { pid: 1, startedAt: 0, bootId: BOOT } };
    await h.sup.init(deadline());
    const rec = h.sup.records()[0];
    expect(rec).toMatchObject({ state: "exited", endReason: "orphan" }); // bookkeeping is sync
    expect(h.kills).toHaveLength(0); // …but the signal phase has NOT run yet — init is unblocked
    await vi.advanceTimersByTimeAsync(0); // flush the setImmediate task
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGTERM" }]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.kills).toEqual([
      { pid: -1000, signal: "SIGTERM" },
      { pid: -1000, signal: "SIGKILL" },
    ]);
  });

  it("orphan recovery with a doctored starttime ⇒ NO signal at any stage (L5, review re-run #3)", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [storedRecord({ procStartTicks: 424242 })],
      writer: { pid: 1, startedAt: 0, bootId: BOOT },
    };
    await h.sup.init(deadline());
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "orphan" });
    expect(h.kills).toHaveLength(0); // init returned before any signal could fire
    await vi.advanceTimersByTimeAsync(4_000); // deferred task + the +3s stage both ran
    expect(h.kills).toHaveLength(0); // sync verify inside the task failed closed — no signal
  });

  it("writer bootId differs (machine rebooted) ⇒ exited{orphan}, no signals", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [storedRecord()], writer: { pid: 1, startedAt: 0, bootId: "other-boot" } };
    await h.sup.init(deadline());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "orphan" });
    expect(h.kills).toHaveLength(0);
  });

  it("launching record with no matching environ ⇒ failed{spawn_error}, no signals", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [
        storedRecord({
          state: "launching",
          pid: undefined,
          procStartTicks: undefined,
          bootId: undefined,
          uid: undefined,
        }),
      ],
    };
    await h.sup.init(deadline());
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
    expect(h.kills).toHaveLength(0);
  });

  it("launching record whose environ scan finds the pid ⇒ orphan escalation runs", async () => {
    const h = makeHarness();
    // the scan reads the SAME fake /proc the identity seam uses
    h.store.loaded = {
      records: [
        storedRecord({
          state: "launching",
          pid: undefined,
          procStartTicks: undefined,
          bootId: undefined,
          uid: undefined,
        }),
      ],
    };
    const spawnId = "spold00000000001";
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (path === "/proc/stat") return "btime 1759000000\n";
      if (path === "/proc") throw new Error("dir");
      if (path === "/proc/2000/environ") return `PI_WEBHUB_SPAWN_ID=${spawnId}\0PATH=/bin\0`;
      if (path === "/proc/2000/comm") return "pi\n";
      if (path === "/proc/2000/stat") return statLine(2000, 2000, 15_790_000_000);
      if (path === "/proc/2000/status") return statusLine(1000, 1000);
      throw new Error(`ENOENT: ${path}`);
    };
    const readdir = (path: string): string[] => (path === "/proc" ? ["2000"] : []);
    const h2 = makeHarness({
      proc: { readFileSync: procRead, platform: "linux" },
      readdirSync: readdir,
    });
    void h;
    h2.store.loaded = {
      records: [
        storedRecord({
          state: "launching",
          pid: undefined,
          procStartTicks: undefined,
          bootId: undefined,
          uid: undefined,
        }),
      ],
    };
    await h2.sup.init(deadline());
    const rec = h2.sup.records()[0];
    expect(rec).toMatchObject({ state: "exited", endReason: "orphan", pid: 2000 });
    expect(h2.kills).toHaveLength(0); // deferred off init's synchronous stretch
    await vi.advanceTimersByTimeAsync(0); // flush the setImmediate signal task
    expect(h2.kills).toEqual([{ pid: -2000, signal: "SIGTERM" }]);
  });

  it("terminal records are revived as-is", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [storedRecord({ state: "exited", endReason: "user", exit: { code: 0, signal: null } })],
    };
    await h.sup.init(deadline());
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "user" });
    expect(h.kills).toHaveLength(0);
    expect(h.sup.liveCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// web-hub-delete-session plan v2 §2.1/§2.2/§2.6/§2.7 (r1 #1/#5/#6, C1)
// ---------------------------------------------------------------------------

function termRecord(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    spawnId: "spterm0000000001",
    state: "exited",
    cwd: REALPATH,
    dev: 9,
    ino: 99,
    createdAt: 1_000,
    updatedAt: 1_000,
    owner: { listener: "loopback", reqId: "r1" },
    pid: 1000,
    procStartTicks: 100,
    bootId: BOOT,
    uid: 1000,
    endReason: "user",
    exit: { code: null, signal: null, unconfirmed: true },
    ...over,
  };
}

describe("supervisor §2.1: deathOf (web-hub-delete-session plan v2)", () => {
  it("pid undefined, no noProcess evidence ⇒ unknown (C1: never treat a bare pid-less record as confirmed)", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [
        termRecord({ pid: undefined, procStartTicks: undefined, bootId: undefined, uid: undefined, exit: undefined }),
      ],
    };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("unknown");
  });

  it("pid undefined + noProcess:never-forked ⇒ confirmed", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [
        termRecord({
          pid: undefined,
          procStartTicks: undefined,
          bootId: undefined,
          uid: undefined,
          exit: undefined,
          noProcess: "never-forked",
        }),
      ],
    };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("pid undefined + noProcess:boot-changed ⇒ confirmed", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [
        termRecord({
          pid: undefined,
          procStartTicks: undefined,
          bootId: undefined,
          uid: undefined,
          exit: undefined,
          noProcess: "boot-changed",
        }),
      ],
    };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("a real (non-unconfirmed) exit event ⇒ confirmed, regardless of /proc", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [termRecord({ exit: { code: 0, signal: null } })] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("unconfirmed exit, /proc says the pid matches and is alive ⇒ alive", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [termRecord()] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("alive");
  });

  it("unconfirmed exit, /proc/<pid>/stat ENOENT ⇒ confirmed", async () => {
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (path === "/proc/1000/stat") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw new Error(`unexpected read: ${path}`);
    };
    const h = makeHarness({ proc: { readFileSync: procRead, platform: "linux" } });
    h.store.loaded = { records: [termRecord()] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("unconfirmed exit, /proc/<pid>/stat read fails with a non-ENOENT/ESRCH error ⇒ unknown (fail closed)", async () => {
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (path === "/proc/1000/stat") throw Object.assign(new Error("denied"), { code: "EACCES" });
      throw new Error(`unexpected read: ${path}`);
    };
    const h = makeHarness({ proc: { readFileSync: procRead, platform: "linux" } });
    h.store.loaded = { records: [termRecord()] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("unknown");
  });

  it("unconfirmed exit, starttime mismatch (pid reused) ⇒ confirmed", async () => {
    const h = makeHarness();
    h.procCorrupt = true; // the fixture's starttime drifts to 424242 ≠ the record's 100
    h.store.loaded = { records: [termRecord()] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("unconfirmed exit, zombie state (Z) ⇒ confirmed", async () => {
    const zombieStat = (pid: number, ppid: number, startTicks: number): string => {
      const rest = ["Z", String(ppid), String(pid)];
      while (rest.length < 19) rest.push("0");
      rest.push(String(startTicks));
      return `${pid} (pi) ${rest.join(" ")}`;
    };
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (path === "/proc/1000/stat") return zombieStat(1000, 999, 100);
      if (path === "/proc/1000/status") return statusLine(1000, 1000);
      throw new Error(`unexpected read: ${path}`);
    };
    const h = makeHarness({ proc: { readFileSync: procRead, platform: "linux" } });
    h.store.loaded = { records: [termRecord()] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("unconfirmed exit, /proc/<pid>/status uid differs ⇒ confirmed (pid reused by another user)", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [termRecord({ uid: 2000 })] }; // fixture status always says uid 1000
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("unconfirmed exit, stored bootId differs from the hub's own ⇒ confirmed (machine rebooted)", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [termRecord({ bootId: "some-other-boot-id" })] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("confirmed");
  });

  it("unconfirmed exit, identity quadruple incomplete (uid missing) ⇒ unknown", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [termRecord({ uid: undefined })] };
    await h.sup.init(deadline());
    expect(h.sup.deathOf("spterm0000000001")).toBe("unknown");
  });

  it("unknown spawnId ⇒ undefined", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    expect(h.sup.deathOf("nope")).toBeUndefined();
  });

  it("r1 #1 regression: exit undefined (failSpawnError's own path, e.g. ⑤ spawn-event timeout) still routes through the probe, never naively confirmed", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await vi.advanceTimersByTimeAsync(5_000); // ⑤ timeout → verified SIGKILL + failed{spawn_error}
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
    expect(rec0(h)?.exit).toBeUndefined();
    // the fixture's /proc still reports pid 1000 as alive — the harness never simulates the kill
    // actually taking effect, so this is exactly the "probe, don't assume" case the plan requires.
    expect(h.sup.deathOf(r.spawnId)).toBe("alive");
  });
});

describe("supervisor §2.1 (C1): noProcess evidence is written at every pid-less failure site", () => {
  it("② pin changed ⇒ noProcess:never-forked; a subsequent remove() succeeds (confirmed, never 409)", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.dirs.pinResult = { ok: false, reason: "changed" };
    const r = req();
    const res = h.sup.start(r, deadline());
    expect(res).toEqual({ ok: false, code: "E_DIR", reason: "changed" });
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error", noProcess: "never-forked" });
    expect(h.sup.remove(r.spawnId, deadline())).toEqual({ ok: true, outcome: "removed" });
    expect(h.sup.records()).toHaveLength(0);
  });

  it("③ spawnFn sync throw ⇒ noProcess:never-forked", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.spawnImpl = () => {
      throw new Error("EAGAIN");
    };
    const r = req();
    h.sup.start(r, deadline());
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error", noProcess: "never-forked" });
    expect(h.sup.remove(r.spawnId, deadline())).toEqual({ ok: true, outcome: "removed" });
  });

  it("③ spawnFn returns no child ⇒ noProcess:never-forked", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.spawnImpl = (() => undefined) as unknown as Harness["spawnImpl"];
    const r = req();
    h.sup.start(r, deadline());
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error", noProcess: "never-forked" });
  });

  it("init() bootChanged recovery ⇒ noProcess:boot-changed on the recovered record", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [termRecord({ state: "starting", exit: undefined })],
      writer: { pid: 1, startedAt: 0, bootId: "a-different-boot-id" },
    };
    await h.sup.init(deadline());
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "orphan", noProcess: "boot-changed" });
  });

  it("a launching record whose crash-recovery environ scan merely misses carries NO noProcess evidence — stays unknown, delete refused (R9)", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [
        termRecord({
          spawnId: "splaunch000001",
          state: "launching",
          pid: undefined,
          procStartTicks: undefined,
          bootId: undefined,
          uid: undefined,
          exit: undefined,
        }),
      ],
    };
    await h.sup.init(deadline());
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
    expect(rec0(h)?.noProcess).toBeUndefined();
    expect(h.sup.deathOf("splaunch000001")).toBe("unknown");
    expect(h.sup.remove("splaunch000001", deadline())).toEqual({
      ok: false,
      code: "E_AGENT_ONLINE",
      reason: "exit-unconfirmed",
    });
    expect(h.sup.records()).toHaveLength(1); // refused — record kept
  });
});

describe("supervisor §2.2: remove() (web-hub-delete-session plan v2)", () => {
  it("unknown spawnId ⇒ E_NOT_FOUND", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    expect(h.sup.remove("nope", deadline())).toEqual({ ok: false, code: "E_NOT_FOUND" });
  });

  it("non-terminal ⇒ pending: persists removeIntent synchronously (L1-style), enters stopping, removing:true rides the spawns push", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    const savesBefore = h.store.calls.filter((c) => c.op === "saveNow").length;
    const res = h.sup.remove(r.spawnId, deadline());
    expect(res).toEqual({ ok: true, outcome: "pending", state: "stopping" });
    expect(rec0(h)).toMatchObject({ state: "stopping", removePending: true });
    const saves = h.store.calls.filter((c) => c.op === "saveNow");
    expect(saves.length).toBe(savesBefore + 1);
    expect(saves.at(-1)?.records?.find((x) => x.spawnId === r.spawnId)?.removeIntent).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const push = h.registry.events.filter((e) => e.type === "spawns").at(-1);
    expect(push?.type).toBe("spawns");
    if (push?.type === "spawns") {
      const item = push.payload.items.find((i) => i.spawnId === r.spawnId);
      expect(item?.removing).toBe(true);
      expect(item?.state).toBe("stopping");
    }
  });

  it("repeated remove() while pending is idempotent — no extra saveNow, same pending reply", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    h.sup.remove(r.spawnId, deadline());
    const savesAfterFirst = h.store.calls.filter((c) => c.op === "saveNow").length;
    expect(h.sup.remove(r.spawnId, deadline())).toEqual({ ok: true, outcome: "pending", state: "stopping" });
    expect(h.store.calls.filter((c) => c.op === "saveNow").length).toBe(savesAfterFirst);
  });

  it("insufficient deadline on a non-pending non-terminal record ⇒ E_DEADLINE, no write, record untouched", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    const savesBefore = h.store.calls.filter((c) => c.op === "saveNow").length;
    const res = h.sup.remove(
      r.spawnId,
      createReqDeadline(() => Date.now(), 100),
    );
    expect(res).toEqual({ ok: false, code: "E_DEADLINE" });
    expect(rec0(h)).toMatchObject({ state: "live", removePending: false });
    expect(h.store.calls.filter((c) => c.op === "saveNow").length).toBe(savesBefore);
  });

  it("non-terminal remove() completes once the process confirms dead — deleteRecord fires onRemoved exactly once", async () => {
    const removed: Array<{ spawnId: string; agentKey: string | undefined }> = [];
    const h = makeHarness({ onRemoved: (spawnId, agentKey) => removed.push({ spawnId, agentKey }) });
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    h.sup.remove(r.spawnId, deadline());
    h.children[0]?.emit("exit", 0, null); // a REAL (confirmed) exit — not the unconfirmed guard
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sup.records()).toHaveLength(0);
    expect(removed).toEqual([{ spawnId: r.spawnId, agentKey: "k1000" }]);
  });

  it("terminal + confirmed dead ⇒ removed", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const child = await driveToLive(h, "k1000");
    child.emit("exit", 1, null); // live crash — a REAL exit event, confirmed
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "crash" });
    expect(h.sup.remove(r.spawnId, deadline())).toEqual({ ok: true, outcome: "removed" });
    expect(h.sup.records()).toHaveLength(0);
  });

  it("r1 #1 regression (B-alive, A6): terminal + unconfirmed/alive ⇒ 409 exit-unconfirmed, record kept; a second call still refuses; once /proc confirms gone, the SAME call succeeds", async () => {
    let dead = false;
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (path === "/proc/1000/stat") {
        if (dead) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return statLine(1000, 1000, 100);
      }
      if (path === "/proc/1000/status") return statusLine(1000, 1000);
      throw new Error(`unexpected read: ${path}`);
    };
    const h = makeHarness({ proc: { readFileSync: procRead, platform: "linux" } });
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    h.sup.remove(r.spawnId, deadline()); // stdin.end → TERM → KILL → guard, no "exit" ever fires
    await vi.advanceTimersByTimeAsync(13_000);
    expect(rec0(h)).toMatchObject({ state: "exited", exit: { unconfirmed: true } });
    // finalizeTerminal's own removePending resolution already ran: the process still reads
    // "alive", so removePending must have been cleared and the record kept (not silently deleted).
    expect(rec0(h)?.removePending).toBe(false);
    expect(h.sup.remove(r.spawnId, deadline())).toEqual({
      ok: false,
      code: "E_AGENT_ONLINE",
      reason: "exit-unconfirmed",
    });
    expect(h.sup.records()).toHaveLength(1);
    dead = true; // the process finally died
    expect(h.sup.remove(r.spawnId, deadline())).toEqual({ ok: true, outcome: "removed" });
    expect(h.sup.records()).toHaveLength(0);
  });
});

describe("supervisor §2.7 (r1 #5): delete event ordering is frozen", () => {
  it("within one macrotask: onRemoved (agent_down?+agent_removed, simulating registry.remove) fires BEFORE the deferred spawns push, which never carries the deleted record", async () => {
    const removedKeys: string[] = [];
    const h = makeHarness({
      onRemoved: (_spawnId, agentKey) => {
        if (agentKey === undefined) return;
        // Mirrors hub.ts's real wiring: registry.remove() → down() → agent_down → agent_removed,
        // all synchronous, all on registry's own bus (asserted here through the fake's `publish`).
        h.registry.publish({ type: "agent_down", agentKey, reason: "removed" });
        h.registry.publish({ type: "agent_removed", agentKey });
        removedKeys.push(agentKey);
      },
    });
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    const child = await driveToLive(h, "k1000");
    h.registry.events.length = 0;
    h.sup.remove(r.spawnId, deadline());
    child.emit("exit", 0, null); // confirmed exit → finalizeTerminal → deleteRecord → onRemoved, all sync
    // Still inside the synchronous turn: onRemoved's publishes already landed, the spawns push
    // (queued by schedulePush's queueMicrotask) has NOT fired yet.
    expect(h.registry.events.map((e) => e.type)).toEqual(["agent_down", "agent_removed"]);
    await vi.advanceTimersByTimeAsync(0); // flush the microtask
    const types = h.registry.events.map((e) => e.type);
    expect(types).toEqual(["agent_down", "agent_removed", "spawns"]);
    const spawnsEvent = h.registry.events.find((e) => e.type === "spawns");
    expect(spawnsEvent?.type).toBe("spawns");
    if (spawnsEvent?.type === "spawns") {
      expect(spawnsEvent.payload.items.find((i) => i.spawnId === r.spawnId)).toBeUndefined();
    }
    expect(removedKeys).toEqual(["k1000"]);
  });
});

describe("supervisor §2.6 (r1 #6): init recovery reconciles a persisted remove intent", () => {
  it("terminal record + removeIntent, confirmed dead on disk (real exit) ⇒ deleted immediately at init, no 8s wait needed", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [termRecord({ removeIntent: true, exit: { code: 0, signal: null } })],
    };
    await h.sup.init(deadline());
    expect(h.sup.records()).toHaveLength(0);
  });

  it("terminal record + removeIntent, unconfirmed exit and /proc still says alive ⇒ waits; at the deadline, process is still alive ⇒ intent abandoned, record kept, removePending cleared", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [termRecord({ removeIntent: true })] }; // exit.unconfirmed:true, /proc alive
    await h.sup.init(deadline());
    expect(h.sup.records()).toHaveLength(1); // not resolved yet
    await vi.advanceTimersByTimeAsync(8_000); // RECOVER_KILL_AFTER_MS(3s) + EXIT_GUARD_MS(5s)
    expect(h.sup.records()).toHaveLength(1);
    expect(rec0(h)).toMatchObject({ state: "exited", removePending: false });
  });

  it("terminal record + removeIntent, unconfirmed exit but /proc confirms gone before the deadline fires ⇒ deleted exactly when the reconciliation timer runs (not sooner, not later)", async () => {
    let dead = false;
    const procRead = (path: string): string => {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT}\n`;
      if (path === "/proc/1000/stat") {
        if (dead) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return statLine(1000, 1000, 100);
      }
      if (path === "/proc/1000/status") return statusLine(1000, 1000);
      throw new Error(`unexpected read: ${path}`);
    };
    const h = makeHarness({ proc: { readFileSync: procRead, platform: "linux" } });
    h.store.loaded = { records: [termRecord({ removeIntent: true })] };
    await h.sup.init(deadline());
    expect(h.sup.records()).toHaveLength(1); // alive at init — queued into the pending-confirm set
    dead = true; // the process finally dies sometime before the 8s reconciliation deadline
    await vi.advanceTimersByTimeAsync(7_999);
    expect(h.sup.records()).toHaveLength(1); // the timer has not fired yet
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sup.records()).toHaveLength(0);
  });

  it("non-terminal record + removeIntent ⇒ finalizeRecovered + recoverEscalate run as usual, THEN reconciled at the deadline (still alive ⇒ abandoned)", async () => {
    const h = makeHarness();
    h.store.loaded = {
      records: [termRecord({ state: "live", exit: undefined, removeIntent: true })],
      writer: { pid: 1, startedAt: 0, bootId: BOOT },
    };
    await h.sup.init(deadline());
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "orphan", removePending: true }); // sync bookkeeping
    await vi.advanceTimersByTimeAsync(0); // the setImmediate signal task (TERM)
    expect(h.kills).toEqual([{ pid: -1000, signal: "SIGTERM" }]);
    await vi.advanceTimersByTimeAsync(8_000); // +3s KILL, then the reconciliation deadline fires
    expect(h.sup.records()).toHaveLength(1); // /proc still says alive — abandoned, not deleted
    expect(rec0(h)?.removePending).toBe(false);
  });

  it("saveNow failure during a live remove() (D-6 degrade) never blocks the eventual delete once the process dies", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    const r = req();
    h.sup.start(r, deadline());
    await driveToLive(h, "k1000");
    h.store.saveNowResults.push({ ok: false, code: "ENOSPC" });
    const res = h.sup.remove(r.spawnId, deadline());
    expect(res).toEqual({ ok: true, outcome: "pending", state: "stopping" }); // degrade, not a failure
    expect(rec0(h)).toMatchObject({ state: "stopping", removePending: true });
    h.children[0]?.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sup.records()).toHaveLength(0); // the in-memory intent still resolved it
  });

  it("shutdown() clears the pending reconciliation timer (no stray fire after close)", async () => {
    const h = makeHarness();
    h.store.loaded = { records: [termRecord({ removeIntent: true })] };
    await h.sup.init(deadline());
    await h.sup.shutdown(deadline());
    await vi.advanceTimersByTimeAsync(8_000);
    // no throw, no crash; the record's fate was whatever shutdown's own flush left it as
    expect(() => h.sup.records()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// default-model plan D2/D3/D5: the --model fork tail + the delayed breaker verdict
// ---------------------------------------------------------------------------

describe("supervisor default-model: argv tail, persistence, projections (D2/D3)", () => {
  it("no model ⇒ argv element-for-element identical to the pre-feature fork, opts has no shell", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req(), deadline());
    const call = h.spawnCalls[0]!;
    expect(call.args).toEqual([LAUNCHER[1], "--mode", "rpc"]);
    expect(call.args).toHaveLength(3);
    expect(call.opts.shell).toBeUndefined();
    expect(call.opts.detached).toBe(true);
    expect(call.opts.cwd).toBe("/proc/self/fd/7");
  });

  it("with model ⇒ two INDEPENDENT trailing elements (--model, ref), no shell, never concatenated", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req({ model: "p1/my-model:high" }), deadline());
    const call = h.spawnCalls[0]!;
    expect(call.args).toEqual([LAUNCHER[1], "--mode", "rpc", "--model", "p1/my-model:high"]);
    expect(call.args[3]).toBe("--model"); // an argv ELEMENT, not a joined string
    expect(call.args[4]).toBe("p1/my-model:high");
    expect(call.opts.shell).toBeUndefined();
  });

  it("model persists in the stored snapshot, the state audit line and both public projections", async () => {
    const h = makeHarness();
    await h.sup.init(deadline());
    h.sup.start(req({ model: "p1/m" }), deadline());
    await driveToLive(h, "k1000");
    const stored = h.store.calls
      .filter((c) => c.op === "saveNow")
      .at(-1)
      ?.records?.find((r) => r.model !== undefined);
    expect(stored?.model).toBe("p1/m");
    expect(h.audits.some((a) => a.phase === "state" && a.state === "live" && a.model === "p1/m")).toBe(true);
    expect(h.sup.records()[0]).toMatchObject({ model: "p1/m" });
    expect(h.registry.events.some((e) => e.type === "spawns")).toBe(true);
  });
});

describe("supervisor default-model D5: delayed breaker verdict matrix", () => {
  const MODEL = "p1/my-model";
  const REJECT_NOT_FOUND = 'Error: Model "nosuch/x" not found. Use --list-models to see available models.\n';
  const REJECT_AMBIGUOUS =
    'Error: Model "dup/m" is ambiguous across providers: p1/dup/m, p2/dup/m. Use --provider or provider/model.\n';
  const WARN_CUSTOM_ID = 'Warning: Model "typo-xyz" not found for provider "p1". Using custom model id.\n';

  /** Start a fork (model or plain) and return its fake child + spawnId. */
  function startFork(h: Harness, model?: string): { spawnId: string; child: FakeChild } {
    const r = req(model === undefined ? {} : { model });
    const res = h.sup.start(r, deadline());
    if (!res.ok) throw new Error(`start rejected: ${JSON.stringify(res)}`);
    return { spawnId: r.spawnId, child: h.children[h.children.length - 1]! };
  }

  /** Exactly-one-terminal-settlement assertion: one `failed`/`exited` state line per record
   *  (the verdict's own `model-rejected` annotation line deliberately excluded — it is a
   *  post-terminal note, never a second settlement). */
  function terminalLines(h: Harness, spawnId: string): number {
    return h.audits.filter(
      (a) =>
        a.phase === "state" &&
        a.spawnId === spawnId &&
        (a.state === "failed" || a.state === "exited") &&
        a.code === undefined,
    ).length;
  }

  /**
   * The observable breaker count of a scenario: append ONE deterministic count (sync spawnFn
   * throw ⇒ failed{spawn_error}) and read the NEXT start's gate. Totals: 1 (scenario 0) ⇒
   * allowed; 2 (scenario 1) ⇒ cooldown 5s; 3 (scenario 2) ⇒ cooldown 30s; ≥4 ⇒ breaker.
   */
  function scenarioCount(h: Harness): number {
    const impl = h.spawnImpl;
    h.spawnImpl = () => {
      throw new Error("boom");
    };
    void h.sup.start(req(), deadline());
    h.spawnImpl = impl;
    const gate = h.sup.start(req(), deadline());
    if (gate.ok) return 0;
    if (gate.reason === "breaker") return 3;
    return gate.retryAfterS === 5 ? 1 : 2;
  }

  async function fresh(): Promise<Harness> {
    const h = makeHarness({ cfg: baseCfg({ maxProcesses: 64, maxPerPrincipal: 64 }) });
    await h.sup.init(deadline());
    return h;
  }

  it("data(reject)→exit→close: terminal once, breaker 0, post-terminal hint + audit + no cooldown", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8"));
    child.emit("exit", 1, null);
    child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "exited_early", hint: "model-rejected" });
    expect(terminalLines(h, spawnId)).toBe(1); // 终态恰一次
    expect(h.onTerminal).toEqual([{ spawnId, reason: "never_live" }]);
    expect(h.audits.some((a) => a.code === "model-rejected" && a.spawnId === spawnId)).toBe(true);
    expect(scenarioCount(h)).toBe(0); // 熔断计数恰 0 次
  });

  it("exit→data(reject)→close (stderr AFTER exit, sink already dropped): same verdict", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.emit("exit", 1, null); // finalizeTerminal ran; cleanupHandles dropped the sink
    child.stderr.emit("data", Buffer.from(REJECT_AMBIGUOUS, "utf8")); // probe still captures
    child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", hint: "model-rejected" });
    expect(terminalLines(h, spawnId)).toBe(1);
    expect(scenarioCount(h)).toBe(0);
  });

  it("exit→close with NO rejection stderr ⇒ terminal once, breaker counted once (fail-safe)", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from("some unrelated launcher noise\n", "utf8"));
    child.emit("exit", 1, null);
    child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "exited_early" });
    expect(rec0(h)?.hint).toBeUndefined();
    expect(terminalLines(h, spawnId)).toBe(1);
    expect(scenarioCount(h)).toBe(1); // 熔断计数恰 1 次
  });

  it("close never comes ⇒ the 250ms grace settles from the already-received tail", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8"));
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)?.hint).toBeUndefined(); // not settled yet — no hint before the grace
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS);
    expect(rec0(h)).toMatchObject({ hint: "model-rejected" });
    expect(terminalLines(h, spawnId)).toBe(1);
    expect(scenarioCount(h)).toBe(0);
  });

  it("grace settles, then a LATE close/data pair ⇒ no second settlement (count stays 1/0)", async () => {
    const h = await fresh();
    const { child } = startFork(h, MODEL);
    child.emit("spawn");
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS); // grace counts it (no rejection)
    child.emit("close");
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8")); // too late — cannot exempt
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS * 2);
    expect(rec0(h)?.hint).toBeUndefined();
    expect(scenarioCount(h)).toBe(1); // exactly one count, despite the late events
  });

  it("close settles, then the grace timer fires ⇒ no second settlement", async () => {
    const h = await fresh();
    const { child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8"));
    child.emit("exit", 1, null);
    child.emit("close"); // settles now (0 counts)
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS * 2); // grace fires into a done verdict
    expect(rec0(h)?.hint).toBe("model-rejected");
    expect(scenarioCount(h)).toBe(0);
  });

  it("ANSI-colored rejection (FORCE_COLOR shape: escape BEFORE the text) still matches after strip", async () => {
    const h = await fresh();
    const { child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(`\x1b[31m${REJECT_NOT_FOUND.trim()}\x1b[39m\n`, "utf8"));
    child.emit("exit", 1, null);
    child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)?.hint).toBe("model-rejected");
    expect(scenarioCount(h)).toBe(0);
  });

  it("`Warning: … Using custom model id.` (known provider, typo'd id) is NOT exempt ⇒ counted", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(WARN_CUSTOM_ID, "utf8"));
    child.emit("exit", 1, null);
    child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)?.hint).toBeUndefined(); // no model-rejected hint (R1/A6b territory)
    expect(terminalLines(h, spawnId)).toBe(1);
    expect(scenarioCount(h)).toBe(1);
  });

  it("record deleted during pending (remove() of the terminal record) ⇒ verdict still settles, no annotation", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8"));
    child.emit("exit", 1, null); // failed + pending
    const removed = h.sup.remove(spawnId, deadline()); // confirmed exit ⇒ deleted from memory
    expect(removed).toEqual({ ok: true, outcome: "removed" });
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS); // verdict runs on the dead record
    expect(h.sup.records().find((r) => r.spawnId === spawnId)).toBeUndefined();
    expect(scenarioCount(h)).toBe(0); // matching rejection — still no count, but no hint anywhere either
    expect(h.audits.some((a) => a.code === "model-rejected" && a.spawnId === spawnId)).toBe(false);
  });

  it("record deleted during pending with NON-matching tail ⇒ the count still settles", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.emit("exit", 1, null);
    expect(h.sup.remove(spawnId, deadline())).toEqual({ ok: true, outcome: "removed" });
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS);
    expect(scenarioCount(h)).toBe(1); // counted exactly once even though the record is gone
  });

  it("no-model exited_early counts SYNCHRONOUSLY (pre-feature behavior, no deferral)", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h); // no model
    child.emit("spawn");
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "exited_early" });
    expect(terminalLines(h, spawnId)).toBe(1);
    expect(scenarioCount(h)).toBe(1);
  });

  it("model record dying in `stopping` (user stop) ⇒ original path, no pending, no hint", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8"));
    h.sup.stop(spawnId, false); // user stop → stopping
    child.emit("exit", 0, null); // exit during stopping → exited{user}
    child.emit("close");
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS);
    expect(rec0(h)).toMatchObject({ state: "exited", endReason: "user" });
    expect(rec0(h)?.hint).toBeUndefined();
    expect(scenarioCount(h)).toBe(0); // user stops never entered the breaker to begin with
  });

  it("register_timeout with a model ⇒ counted immediately (no deferral), rejection text grants nothing", async () => {
    const h = await fresh();
    const { spawnId, child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8"));
    await vi.advanceTimersByTimeAsync(10_000); // registerTimeoutS: 10 → stopping{register_timeout}
    child.emit("exit", 0, null); // the escalated child dies → failed{register_timeout}
    child.emit("close");
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "register_timeout" });
    expect(rec0(h)?.hint).toBe("register-timeout-hello"); // the timeout hint, never model-rejected
    expect(terminalLines(h, spawnId)).toBe(1);
    expect(scenarioCount(h)).toBe(1);
  });

  it("spawn_error (sync fork throw) with a model ⇒ counted immediately", async () => {
    const h = await fresh();
    h.spawnImpl = () => {
      throw new Error("boom");
    };
    h.sup.start(req({ model: MODEL }), deadline());
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS);
    expect(rec0(h)).toMatchObject({ state: "failed", endReason: "spawn_error" });
    expect(scenarioCount(h)).toBe(1);
  });

  it("FIVE consecutive model rejections never open the breaker; FOUR plain early exits still do", async () => {
    const h = await fresh();
    for (let i = 0; i < 5; i++) {
      const { child } = startFork(h, MODEL);
      child.emit("spawn");
      child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8"));
      child.emit("exit", 1, null);
      child.emit("close");
      await vi.advanceTimersByTimeAsync(0);
    }
    // no breaker, no cooldown — a healthy next start goes straight through
    expect(scenarioCount(h)).toBe(0);
    expect(h.sup.policy("loopback:token", "loopback", "http", false).allowed).toBe(true);

    const h2 = await fresh();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(i === 1 ? 5_000 : i === 2 || i === 3 ? 30_000 : 0); // climb the cooldown ladder
      const { child } = startFork(h2);
      child.emit("spawn");
      child.emit("exit", 1, null);
      child.emit("close");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h2.sup.start(req(), deadline())).toMatchObject({ code: "E_LAUNCHER", reason: "breaker" });
  });

  it("shutdown() while pending ⇒ the verdict still settles afterwards (count observable via policy)", async () => {
    const h = await fresh();
    // 2 plain counts first (→ cooldown 5s), then a pending model verdict that must add #3 and #4
    for (let i = 0; i < 2; i++) {
      const { child } = startFork(h);
      child.emit("spawn");
      child.emit("exit", 1, null);
      child.emit("close");
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(5_000); // clear the 2-count cooldown before the model forks
    for (let i = 0; i < 2; i++) {
      const { child } = startFork(h, MODEL);
      child.emit("spawn");
      child.emit("exit", 1, null); // NO close — pending on the grace
    }
    await h.sup.shutdown(deadline());
    await vi.advanceTimersByTimeAsync(MODEL_VERDICT_GRACE_MS);
    // 4 counts ⇒ breaker OPEN (had the pending verdicts never settled, policy would say cooldown)
    expect(h.sup.policy("loopback:token", "loopback", "http", false)).toMatchObject({
      allowed: false,
      reason: "breaker",
    });
  });

  it("probe caps at 4 KiB (tail kept) — a late rejection line inside the window still matches", async () => {
    const h = await fresh();
    const { child } = startFork(h, MODEL);
    child.emit("spawn");
    child.stderr.emit("data", Buffer.concat([Buffer.alloc(8 * 1024, 0x65), Buffer.from("\n", "utf8")])); // 8 KiB junk, newline-terminated
    child.stderr.emit("data", Buffer.from(REJECT_NOT_FOUND, "utf8")); // the tail must survive
    child.emit("exit", 1, null);
    child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(rec0(h)?.hint).toBe("model-rejected");
    expect(scenarioCount(h)).toBe(0);
  });
});
