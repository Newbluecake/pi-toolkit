// @vitest-environment happy-dom
/**
 * Exited discovery r3 I1: fresh HTTP spawn -> real fake-pi process/session -> real v2 store
 * -> second real hub assembly -> reconnect SSE -> explicit SAME-spawnId HTTP relaunch.
 * No seeded terminal records, real sessions/credentials/vaults, or frozen-fixture updates.
 * Raw restart SSE also mounts the shipped modal/controller and clicks through real HTTP.
 * Happy DOM is component integration, not browser/layout E2E; layout/legacy gates are separate.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h as vnode, provide, ref, shallowRef } from "vue";
import SessionHistoryDialog from "../../src/web-hub/ui/src/components/spawn/SessionHistoryDialog.vue";
import { HUB_CTX } from "../../src/web-hub/ui/src/components/control/controlContext.js";
import { RETAINED_RELAUNCH, useRetainedRelaunch } from "../../src/web-hub/ui/src/composables/useRetainedRelaunch.js";
import type { HubHandle, HubState, NewSessionFlow } from "../../src/web-hub/ui/src/types.js";
import type { SpawnRelaunchOutcome } from "../../src/web-hub/ui/src/transport/types.js";
import { resolveJitiCli, spawnHub } from "../../src/web-hub/agent/launcher.js";
import { writeRestoreVetoSync } from "../../src/web-hub/agent/admin-cmds.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub, type StartHubDeps } from "../../src/web-hub/hub/hub.js";
import { defaultRetainedSessionFs } from "../../src/web-hub/hub/spawn/retained-session.js";
import type { StoredRecord } from "../../src/web-hub/hub/spawn/store.js";
import type { SpawnSupervisor } from "../../src/web-hub/hub/spawn/supervisor.js";
import { resolveHubPaths, webHubSpawnFiles } from "../../src/web-hub/protocol/paths.js";
import { SUPPORTED_PI_RANGE, type HubSpawnConfig, type SpawnsPayload } from "../../src/web-hub/protocol/spawn.js";
import { retainedRecoveryRows } from "../../src/web-hub/ui/src/logic/spawn.js";
import { config } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, type SseConn } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const FAKE = resolve("tests/integration/fixtures/fake-rpc-pi.mjs");
const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const JITI = resolveJitiCli({ argv1: PI_CLI, override: "" });
const hubs = new Set<RunningHub>();
const hubPids = new Set<number>();
const childPids = new Set<number>();
const streams: SseConn[] = [];
let sandbox: ReturnType<typeof sandboxHome> | undefined;
let freshPosts = 0;
const mounted: Array<ReturnType<typeof mount>> = [];

interface Hub {
  port: number;
  cookie: string;
  stateDir: string;
  running?: RunningHub;
  pid?: number;
  supervisor?: SpawnSupervisor;
}

function paths(home: string) {
  return resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
}
function launcher(home: string): readonly [string, string] {
  const pkg = join(home, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: SUPPORTED_PI_RANGE.min }),
  );
  const entry = join(pkg, "pi.mjs");
  copyFileSync(FAKE, entry);
  return [process.execPath, entry];
}
function cfg(home: string, over: Partial<HubSpawnConfig> = {}) {
  return config({
    home,
    port: 0,
    idleExitMinutes: 10,
    launcher: launcher(home),
    spawn: {
      roots: [home],
      maxProcesses: 4,
      maxPerPrincipal: 4,
      ratePerMinute: 30,
      maxLifetimeMinutes: 720,
      registerTimeoutS: 10,
      lan: "off",
      restore: true,
      history: false,
      ...over,
    },
  });
}
async function boot(
  home: string,
  over: Partial<HubSpawnConfig> = {},
  seams: StartHubDeps["spawnSeams"] = {},
): Promise<Hub> {
  let supervisor: SpawnSupervisor | undefined;
  const h = await startHub(cfg(home, over), createHttpFrontend, {
    uid: process.getuid?.() ?? 0,
    childUmask: 0o022,
    spawnSeams: {
      ...seams,
      wrapSupervisor: (sup) => {
        supervisor = sup;
        return sup;
      },
    },
  });
  if ("exists" in h) throw new Error("unexpected singleton");
  hubs.add(h);
  return {
    port: h.httpPort,
    stateDir: h.paths.stateDir,
    cookie: await login(h.httpPort, h.paths.tokenFile),
    running: h,
    supervisor: supervisor!,
  };
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* own process already exited */
  }
}
async function close(h: Hub, reason = "test-teardown"): Promise<void> {
  if (h.running) {
    await h.running.close(reason);
    await h.running.closed;
    hubs.delete(h.running);
  }
}
async function bootChild(home: string, exclude?: number, over: Partial<HubSpawnConfig> = {}): Promise<Hub> {
  if (!JITI.ok) throw new Error(JITI.reason);
  spawnHub(
    { execPath: process.execPath, argv1: PI_CLI, jitiCli: JITI.jitiCli },
    resolve("src/web-hub/hub/main.ts"),
    cfg(home, over),
  );
  let info: { pid?: number; port?: number } = {};
  await waitUntil(
    () => {
      try {
        info = JSON.parse(readFileSync(paths(home).hubJson, "utf8")) as typeof info;
      } catch {
        return false;
      }
      return info.pid !== undefined && info.pid !== exclude && alive(info.pid) && info.port !== undefined;
    },
    45_000,
    "real hub child ready",
  );
  hubPids.add(info.pid!);
  return {
    pid: info.pid!,
    port: info.port!,
    stateDir: paths(home).stateDir,
    cookie: await login(info.port!, paths(home).tokenFile),
  };
}
function records(h: Hub): StoredRecord[] {
  const file = webHubSpawnFiles(h.stateDir).spawnsJson;
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { records: StoredRecord[] }).records : [];
}
async function stored(h: Hub, id: string, pred: (r: StoredRecord) => boolean, what: string): Promise<StoredRecord> {
  let found: StoredRecord | undefined;
  await waitUntil(
    () => {
      found = records(h).find((r) => r.spawnId === id);
      if (found?.pid) childPids.add(found.pid);
      return found !== undefined && pred(found);
    },
    25_000,
    what,
  );
  return found!;
}
function work(
  home: string,
  switches = ["--write-session", "--default-session-tree", "--cmd-echo"],
  name = "work",
): string {
  const cwd = join(home, name);
  mkdirSync(cwd, { recursive: true });
  setSwitches(cwd, switches);
  return cwd;
}
function setSwitches(cwd: string, switches: string[]): void {
  writeFileSync(join(cwd, ".fake-pi-switches"), switches.join("\n") + "\n");
}
function forks(cwd: string): Array<{ pid: number; argv: string[] }> {
  const file = join(cwd, ".fake-pi-argv.log");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; argv: string[] })
    : [];
}
async function post(h: Hub, path: string, body: unknown) {
  if (path === "/api/headless") freshPosts++;
  return postJson(h.port, path, body, { Cookie: h.cookie, Origin: `http://127.0.0.1:${h.port}` });
}
async function fresh(h: Hub, cwd: string): Promise<StoredRecord> {
  const id = randomUUID();
  let res = await post(h, "/api/headless", { id, cwd });
  if (res.status === 409)
    res = await post(h, "/api/headless", {
      id,
      cwd,
      confirm: true,
      expectCwd: (JSON.parse(res.body) as { resolvedCwd: string }).resolvedCwd,
    });
  expect(res.status, res.body).toBe(202);
  const spawnId = (JSON.parse(res.body) as { spawnId: string }).spawnId;
  return stored(
    h,
    spawnId,
    (r) => r.state === "live" && r.sessionFile !== undefined,
    "fresh live session frame persisted",
  );
}
async function stop(h: Hub, r: StoredRecord): Promise<StoredRecord> {
  expect((await post(h, `/api/headless/${r.spawnId}/stop`, {})).status).toBe(202);
  const ended = await stored(h, r.spawnId, (x) => x.state === "exited", "terminal persisted");
  await waitUntil(() => !alive(r.pid!), 8_000, "own child exited");
  return ended;
}
async function snapshot(h: Hub, id: string): Promise<SpawnsPayload> {
  const sse = await openSse(h.port, { cookie: h.cookie });
  streams.push(sse);
  const hub = await sse.waitFor((e) => e.event === "hub");
  expect(hub.data.caps).toContain("spawn.exited.v1");
  expect(hub.data.caps).not.toContain("spawn.history.v1");
  const agents = await sse.waitFor((e) => e.event === "agents");
  expect(agents.data).toEqual({ agents: [] }); // no manufactured AgentCard on restart
  const ev = await sse.waitFor((e) => e.event === "spawns");
  const payload = ev.data as SpawnsPayload;
  expect(retainedRecoveryRows(payload, hub.data.caps).map((r) => r.spawnId)).toContain(id);
  const bytes = JSON.stringify(payload);
  for (const field of ["sessionFile", "sessionId", "sessionPersisted", "sessionGuard", "lazyIntent", "baseline"])
    expect(bytes).not.toContain(`"${field}"`);
  sse.close();
  return payload;
}
async function relaunch(h: Hub, old: StoredRecord): Promise<StoredRecord> {
  const posts = freshPosts;
  const res = await post(h, "/api/headless/relaunch", { spawnId: old.spawnId });
  expect(res.status, res.body).toBe(202);
  expect(JSON.parse(res.body)).toEqual({ spawnId: old.spawnId, state: "starting" });
  const live = await stored(
    h,
    old.spawnId,
    (r) => r.state === "live" && r.pid !== old.pid,
    "same spawnId restored live",
  );
  expect(live.sessionId).toBe(old.sessionId);
  expect(live.agentKey).not.toBe(old.agentKey);
  expect(freshPosts).toBe(posts); // no fresh endpoint fallback/replayed first prompt
  expect(records(h)).toHaveLength(1);
  return live;
}

/** Real restart SSE -> mounted production modal/controller -> explicit HTTP -> SSE-shaped
 * live update -> navigation. Transport adapter only supplies node HTTP cookies; no stub verdict. */
async function recoverViaUi(h: Hub, payload: SpawnsPayload, old: StoredRecord): Promise<StoredRecord> {
  const state = shallowRef({
    hub: { caps: ["spawn.v1", "spawn.relaunch.v1", "spawn.exited.v1"], pid: h.pid ?? process.pid, startedAt: 1 },
    conn: "connected",
    clientId: "I1-real-http",
    agents: new Map(),
    spawns: payload,
  } as unknown as HubState);
  let requests = 0,
    freshSubmits = 0,
    historyReads = 0;
  const posts = freshPosts;
  const handle = {
    state,
    spawn: {
      relaunch: async (spawnId: string): Promise<SpawnRelaunchOutcome> => {
        requests++;
        const res = await post(h, "/api/headless/relaunch", { spawnId });
        expect(res.status, res.body).toBe(202);
        const body = JSON.parse(res.body) as { spawnId: string; state: "starting" };
        expect(body).toEqual({ spawnId: old.spawnId, state: "starting" });
        return { ok: true, ...body };
      },
      history: async () => {
        historyReads++;
        throw new Error("managed-only UI must not scan history");
      },
      newSession: {
        flow: ref<NewSessionFlow>({ phase: "idle" }),
        submit: async () => {
          freshSubmits++;
          throw new Error("recovery must never submit fresh");
        },
        cancel: () => {},
      },
    },
  } as unknown as HubHandle;
  const open = ref(true);
  const Host = defineComponent({
    setup() {
      provide(HUB_CTX, handle);
      provide(RETAINED_RELAUNCH, useRetainedRelaunch(handle));
      return () =>
        open.value
          ? vnode(SessionHistoryDialog, {
              onClose: () => {
                open.value = false;
              },
            })
          : null;
    },
  });
  const wrapper = mount(Host, { attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  expect(requests).toBe(0);
  expect(freshSubmits).toBe(0);
  expect(historyReads).toBe(0);
  const button = document.body.querySelector<HTMLButtonElement>(".history-retained-row button");
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(false);
  button!.click();
  await waitUntil(() => requests === 1, 3_000, "explicit UI request");
  const live = await stored(h, old.spawnId, (r) => r.state === "live" && r.pid !== old.pid, "UI relaunch live");
  const stream = await openSse(h.port, { cookie: h.cookie });
  streams.push(stream);
  const ev = await stream.waitFor((e) => e.event === "spawns");
  state.value = { ...state.value, spawns: ev.data as SpawnsPayload };
  await flushPromises();
  expect(window.location.hash).toBe(`#/agent/${live.agentKey}`);
  expect(open.value).toBe(false);
  expect(requests).toBe(1);
  expect(freshSubmits).toBe(0);
  expect(historyReads).toBe(0);
  expect(freshPosts).toBe(posts);
  expect(live.sessionId).toBe(old.sessionId);
  stream.close();
  wrapper.unmount();
  mounted.splice(mounted.indexOf(wrapper), 1);
  return live;
}

/** Fill the two existing restore slots with real children that deliberately withhold their
 * session frames. The third HTTP 202 is provably queued, without patching production pumps. */
async function queueThird(
  h: Hub,
  home: string,
): Promise<{ target: StoredRecord; cwd: string; blockers: StoredRecord[] }> {
  const originals: StoredRecord[] = [];
  const cwds: string[] = [];
  for (let n = 0; n < 3; n++) {
    const cwd = work(home, undefined, `queue-${n}`);
    cwds.push(cwd);
    const r = await fresh(h, cwd);
    await stored(h, r.spawnId, (x) => x.sessionPersisted === true, "queue source file observed");
    await stop(h, r);
    originals.push(r);
  }
  const blockers: StoredRecord[] = [];
  for (let n = 0; n < 2; n++) {
    // --no-hello holds the existing registering slot until this owned child is killed.
    setSwitches(cwds[n]!, ["--default-session-tree", "--no-hello"]);
    expect((await post(h, "/api/headless/relaunch", { spawnId: originals[n]!.spawnId })).status).toBe(202);
    blockers.push(
      await stored(
        h,
        originals[n]!.spawnId,
        (r) => r.restore?.phase === "registering" && r.pid !== originals[n]!.pid,
        "blocking restore registered on disk",
      ),
    );
  }
  const target = originals[2]!;
  const res = await post(h, "/api/headless/relaunch", { spawnId: target.spawnId });
  expect(res.status, res.body).toBe(202);
  expect(records(h).find((r) => r.spawnId === target.spawnId)).toMatchObject({
    state: "starting",
    restore: { phase: "reaping" },
    sessionGuard: { kind: "default-tree-v1", baseline: expect.any(Object) },
  });
  expect(forks(cwds[2]!)).toHaveLength(1);
  return { target, cwd: cwds[2]!, blockers };
}
function readLedger(target: () => string | undefined) {
  const fs = defaultRetainedSessionFs();
  let reads = 0;
  return {
    fs: {
      ...fs,
      readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        if (readlinkSync(`/proc/self/fd/${fd}`) === target()) reads++;
        return fs.readSync(fd, buffer, offset, length, position);
      },
    },
    count: () => reads,
    clear: () => {
      reads = 0;
    },
  };
}
function replaceLeaf(file: string): void {
  const original = readFileSync(file);
  renameSync(file, `${file}.old-inode`);
  writeFileSync(file, original); // valid header/content, WRONG inode: D7 must never read it
}

afterEach(async () => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
  window.location.hash = "";
  localStorage.clear();
  for (const s of streams.splice(0)) s.close();
  for (const h of hubs) await h.close("test-teardown");
  hubs.clear();
  for (const p of hubPids) kill(p);
  await waitUntil(() => [...hubPids].every((p) => !alive(p)), 8_000, "test hubs gone").catch(() => undefined);
  hubPids.clear();
  for (const p of childPids) kill(p);
  await waitUntil(() => [...childPids].every((p) => !alive(p)), 8_000, "test children gone").catch(() => undefined);
  childPids.clear();
  sandbox?.restore();
  sandbox = undefined;
  freshPosts = 0;
});

describe.skipIf(process.platform !== "linux")("retained exited — real assembly/store/process lifecycle", () => {
  it.each(["normal exit", "lifetime", "fence orphan"])(
    "%s -> disk -> second hub SSE -> explicit same-session relaunch, never automatic fork",
    async (ending) => {
      sandbox = sandboxHome();
      const home = sandbox.home;
      const cwd = work(
        home,
        ending === "fence orphan"
          ? ["--write-session", "--default-session-tree", "--ignore-eof", "--ignore-term"]
          : undefined,
      );
      let h = await boot(home, ending === "lifetime" ? { maxLifetimeMinutes: 0.05 } : {});
      const first = await fresh(h, cwd);
      await stored(h, first.spawnId, (r) => r.sessionPersisted === true, "file observed");
      if (ending === "normal exit") {
        process.kill(first.pid!, "SIGINT"); // fake's normal code-0 exit, not supervisor.stop
        const ended = await stored(h, first.spawnId, (r) => r.state === "exited", "normal terminal");
        expect(ended.exit?.code).toBe(0);
        await close(h);
      } else if (ending === "lifetime") {
        const ended = await stored(h, first.spawnId, (r) => r.state === "exited", "lifetime terminal");
        expect(ended.endReason).toBe("lifetime");
        await close(h);
      } else {
        await close(h, "fence"); // production terminate mode, leaves stopping with no intent
        expect(records(h)[0]).toMatchObject({ state: "stopping", endReason: "hub" });
        expect(records(h)[0]?.restoreIntent).toBeUndefined();
      }
      await waitUntil(() => !alive(first.pid!), 20_000, "old identity dead");
      h = await boot(home);
      const terminal = await stored(h, first.spawnId, (r) => r.state === "exited", "loaded terminal/orphan");
      if (ending === "fence orphan") expect(terminal.endReason).toBe("orphan");
      expect(terminal).toMatchObject({ sessionId: first.sessionId, sessionFile: first.sessionFile });
      expect(forks(cwd)).toHaveLength(1);
      const payload = await snapshot(h, first.spawnId);
      await snapshot(h, first.spawnId); // browser refresh/reconnect, still no fork
      expect(forks(cwd)).toHaveLength(1);
      const next = ending === "normal exit" ? await recoverViaUi(h, payload, first) : await relaunch(h, first);
      expect(next.sessionFile).toBe(first.sessionFile);
      expect(forks(cwd)).toHaveLength(2);
      expect(forks(cwd)[1]!.argv).toEqual(["--mode", "rpc", "--session", first.sessionFile]);
      expect(existsSync(first.sessionFile!)).toBe(true);
    },
    60_000,
  );

  it("failed restore stays discoverable after a new hub; explicit retry uses same id with zero fresh submits", async () => {
    sandbox = sandboxHome();
    const home = sandbox.home;
    const cwd = work(home);
    let fail = false;
    let h = await boot(
      home,
      {},
      {
        spawnFn: (...args) => {
          if (fail) throw new Error("I1 pre-fork failure");
          return spawn(...args);
        },
      },
    );
    const first = await fresh(h, cwd);
    await stored(h, first.spawnId, (r) => r.sessionPersisted === true, "persisted");
    await stop(h, first);
    const posts = freshPosts;
    fail = true;
    expect((await post(h, "/api/headless/relaunch", { spawnId: first.spawnId })).status).toBe(202);
    const failed = await stored(h, first.spawnId, (r) => r.state === "failed", "restore failed");
    expect(failed.restore).toBeDefined();
    expect(failed.noProcess).toBe("never-forked");
    expect(forks(cwd)).toHaveLength(1);
    await close(h);
    h = await boot(home);
    const payload = await snapshot(h, first.spawnId);
    expect(payload.items.find((r) => r.spawnId === first.spawnId)).toMatchObject({
      state: "failed",
      restore: expect.any(Object),
    });
    await recoverViaUi(h, payload, first);
    expect(freshPosts).toBe(posts);
    expect(forks(cwd)).toHaveLength(2);
  }, 60_000);

  it("custom terminal and unknown-death orphan refuse relaunch without a fork", async () => {
    sandbox = sandboxHome();
    const home = sandbox.home;
    const cwd = work(home, ["--write-session"]);
    const h = await boot(home);
    const first = await fresh(h, cwd);
    await stored(h, first.spawnId, (r) => r.sessionPersisted === true, "custom file observed");
    await stop(h, first);
    let res = await post(h, "/api/headless/relaunch", { spawnId: first.spawnId });
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body)).toEqual({ error: "E_SPAWN_GONE", reason: "session-invalid" });
    // Targeted identity-evidence fault through the captured real supervisor; no arbitrary pid
    // is signalled and no terminal/store seed substitutes for the fresh lifecycle above.
    const rec = h.supervisor!.records()[0]!;
    delete rec.pid;
    delete rec.noProcess;
    rec.endReason = "orphan";
    rec.exit = { unconfirmed: true };
    res = await post(h, "/api/headless/relaunch", { spawnId: first.spawnId });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "E_AGENT_ONLINE", reason: "exit-unconfirmed" });
    expect(forks(cwd)).toHaveLength(1);
  }, 60_000);

  it.each([false, true])(
    "real HTTP queued 202 -> replaced leaf -> zero target content/new fork (history=%s)",
    async (history) => {
      sandbox = sandboxHome();
      const home = sandbox.home;
      let file: string | undefined;
      const ledger = readLedger(() => file);
      const h = await boot(home, { history }, { retainedSessionFs: ledger.fs });
      const { target, cwd, blockers } = await queueThird(h, home);
      file = target.sessionFile!;
      ledger.clear();
      replaceLeaf(file);
      for (const r of blockers) kill(r.pid!); // terminal events release the REAL two slots
      const failed = await stored(h, target.spawnId, (r) => r.state === "failed", "queued target rejected before read");
      expect(failed.restore?.failure).toBe("session-invalid");
      expect(failed.sessionGuard?.kind).toBe("default-tree-v1");
      expect(ledger.count()).toBe(0);
      expect(forks(cwd)).toHaveLength(1);
    },
    90_000,
  );

  it("static sessions-root alias never grants terminal coordinates without any relaunch click", async () => {
    sandbox = sandboxHome();
    const home = sandbox.home;
    const agentDir = join(home, ".pi/agent");
    const target = join(home, "owned-alias-target");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, join(agentDir, "sessions"));
    const cwd = work(home);
    const h = await boot(home);
    const first = await fresh(h, cwd);
    await stored(h, first.spawnId, (r) => r.sessionPersisted === true, "fake wrote through fixture alias");
    const terminal = await stop(h, first);
    expect(terminal.sessionId).toBeUndefined();
    expect(terminal.sessionFile).toBeUndefined();
    expect(terminal.sessionPersisted).toBeUndefined();
    expect(forks(cwd)).toHaveLength(1);
    expect(existsSync(first.sessionFile!)).toBe(true); // not deleted; simply not authorized
  }, 60_000);

  it("never-chat lazy relaunch migrates oldTs to newTs without file/prompt; first conversation persists and next hub restores exact newTs", async () => {
    sandbox = sandboxHome();
    const home = sandbox.home;
    const cwd = work(home, ["--lazy-new-timestamp", "--cmd-echo"]);
    let h = await boot(home);
    const first = await fresh(h, cwd);
    expect(first.sessionFile).toContain("2000-01-01T00-00-00-000Z_");
    expect(existsSync(first.sessionFile!)).toBe(false);
    await stop(h, first);
    await close(h);
    h = await boot(home);
    await snapshot(h, first.spawnId);
    const next = await relaunch(h, first);
    expect(next.sessionFile).not.toBe(first.sessionFile);
    expect(next.sessionFile?.slice(0, next.sessionFile.lastIndexOf("/"))).toBe(
      first.sessionFile?.slice(0, first.sessionFile.lastIndexOf("/")),
    );
    expect(next.sessionFile).toMatch(
      new RegExp(`\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${first.sessionId}\\.jsonl$`),
    );
    expect(existsSync(next.sessionFile!)).toBe(false);
    expect(next.sessionGuard?.lazyIntent).toBeUndefined();
    expect(forks(cwd)[1]!.argv).toEqual(["--mode", "rpc", "--session-id", first.sessionId]);
    const stderr = readFileSync(join(webHubSpawnFiles(h.stateDir).logDir, `${first.spawnId}.stderr.log`), "utf8");
    expect(stderr).not.toContain("CMD ");
    const prompt = await post(h, "/api/cmd", {
      id: randomUUID(),
      agentKey: next.agentKey,
      op: "prompt",
      text: "first conversation",
      deliver: "followUp",
    });
    expect(prompt.status, prompt.body).toBe(200);
    expect(JSON.parse(prompt.body)).toMatchObject({ ok: true, data: { op: "prompt" } });
    await stored(h, first.spawnId, (r) => r.sessionPersisted === true, "first conversation file observed");
    expect(readFileSync(next.sessionFile!, "utf8")).toContain("fake conversation");
    await close(h, "restart");
    h = await boot(home);
    const third = await stored(
      h,
      first.spawnId,
      (r) => r.state === "live" && r.pid !== next.pid,
      "exact newTs restored",
    );
    expect(third.sessionId).toBe(first.sessionId);
    expect(third.sessionFile).toBe(next.sessionFile);
    expect(forks(cwd)).toHaveLength(3);
    expect(forks(cwd)[2]!.argv).toEqual(["--mode", "rpc", "--session", next.sessionFile]);
  }, 90_000);

  it("lazy registering intent cannot resurrect a permit after hub restart or explicit retry", async () => {
    sandbox = sandboxHome();
    const home = sandbox.home;
    const cwd = work(home, ["--lazy-new-timestamp"]);
    let h = await boot(home);
    const first = await fresh(h, cwd);
    await stop(h, first);
    setSwitches(cwd, ["--lazy-new-timestamp", "--no-hello"]);
    expect((await post(h, "/api/headless/relaunch", { spawnId: first.spawnId })).status).toBe(202);
    const registering = await stored(
      h,
      first.spawnId,
      (r) => r.restore?.phase === "registering" && r.pid !== undefined,
      "lazy registering intent on disk",
    );
    expect(registering.sessionGuard?.lazyIntent).toBeDefined();
    await close(h, "crash");
    h = await boot(home);
    const failed = await stored(h, first.spawnId, (r) => r.state === "failed", "unresolved intent rejected");
    expect(failed.restore?.failure).toBe("session-invalid");
    expect(failed.sessionGuard?.lazyIntent).toEqual(registering.sessionGuard?.lazyIntent);
    await snapshot(h, first.spawnId);
    const res = await post(h, "/api/headless/relaunch", { spawnId: first.spawnId });
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body)).toEqual({ error: "E_SPAWN_GONE", reason: "session-invalid" });
    expect(forks(cwd)).toHaveLength(2);
    expect(existsSync(first.sessionFile!)).toBe(false);
  }, 90_000);
});

describe.skipIf(process.platform !== "linux" || !JITI.ok)("retained exited — actual hub SIGKILL classification", () => {
  it.each([false, true])(
    "real starting snapshot -> SIGKILL -> replaced leaf -> second hub rejects before content/fork (history=%s)",
    async (history) => {
      sandbox = sandboxHome();
      const home = sandbox.home;
      const h = await bootChild(home, undefined, { history });
      const { target, cwd } = await queueThird(h, home);
      const before = records(h).find((r) => r.spawnId === target.spawnId)!;
      expect(before.restore?.phase).toBe("reaping");
      const oldHub = h.pid!;
      kill(oldHub);
      await waitUntil(() => !alive(oldHub), 8_000, "crashed with queued starting snapshot");
      replaceLeaf(target.sessionFile!);
      const ledger = readLedger(() => target.sessionFile);
      const next = await boot(home, { history }, { retainedSessionFs: ledger.fs });
      const failed = await stored(next, target.spawnId, (r) => r.state === "failed", "reloaded sticky guard rejected");
      expect(failed.restore?.failure).toBe("session-invalid");
      expect(failed.sessionGuard?.kind).toBe("default-tree-v1");
      expect(ledger.count()).toBe(0);
      expect(forks(cwd)).toHaveLength(1);
    },
    120_000,
  );

  it.each(["terminal", "veto", "live custom"])(
    "%s before SIGKILL: terminal/veto zero auto fork; unmarked live custom keeps legacy automatic restore",
    async (kind) => {
      sandbox = sandboxHome();
      const home = sandbox.home;
      const cwd = work(
        home,
        kind === "live custom" ? ["--write-session"] : ["--write-session", "--default-session-tree"],
      );
      let h = await bootChild(home);
      const first = await fresh(h, cwd);
      await stored(h, first.spawnId, (r) => r.sessionPersisted === true, "file observed before crash");
      if (kind === "terminal") await stop(h, first);
      if (kind === "veto") expect(writeRestoreVetoSync(h.stateDir)).toEqual({ ok: true });
      kill(h.pid!);
      await waitUntil(() => !alive(h.pid!), 8_000, "hub SIGKILL confirmed");
      const oldHubPid = h.pid!;
      h = await bootChild(home, oldHubPid);
      if (kind === "live custom") {
        const next = await stored(
          h,
          first.spawnId,
          (r) => r.state === "live" && r.pid !== first.pid,
          "legacy live crash auto restore",
        );
        expect(next.sessionId).toBe(first.sessionId);
        expect(next.sessionFile).toBe(first.sessionFile);
        expect(forks(cwd)).toHaveLength(2);
        expect(forks(cwd)[1]!.argv).toEqual(["--mode", "rpc", "--session", first.sessionFile]);
      } else {
        const end = await stored(
          h,
          first.spawnId,
          (r) => r.state === "exited",
          "terminal loaded or veto orphan recovered",
        );
        if (kind === "veto") {
          expect(end.endReason).toBe("orphan");
          expect(existsSync(webHubSpawnFiles(h.stateDir).restoreVeto)).toBe(false);
        }
        await snapshot(h, first.spawnId);
        expect(forks(cwd)).toHaveLength(1);
        await relaunch(h, first);
        expect(forks(cwd)).toHaveLength(2);
      }
    },
    120_000,
  );
});
