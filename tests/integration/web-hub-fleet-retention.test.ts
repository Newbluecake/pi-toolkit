// @vitest-environment happy-dom
/**
 * #9 P5 — isolated, real fleet producer → NDJSON/socket → agent-server/registry →
 * loopback + LAN HTTP/cookie/SSE → reducer → mounted AgentDetail/Drawer DOM.
 * Fixtures supply pi lifecycle/query inputs, append sink, empty transcript history,
 * non-repository git verdict and LAN store/KDF. No daemon, user home, model, reload,
 * external network, handcrafted successful rows or fake event bus.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { mount } from "@vue/test-utils";
import { shallowRef, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveControl } from "../../src/archive/control.js";
import { ARCHIVE_ENTRY_TYPE } from "../../src/archive/state.js";
import type { RunSnapshot } from "../../src/core/types.js";
import { wireWebHub } from "../../src/web-hub/agent/index.js";
import { projectFleet, WEB_FLEET_FRAME_BYTES, WEB_FLEET_ROW_BYTES } from "../../src/web-hub/agent/status.js";
import { createAgentServer } from "../../src/web-hub/hub/agent-server.js";
import { createClientAllowGuard } from "../../src/web-hub/hub/client-allow.js";
import { createCommandRouter } from "../../src/web-hub/hub/commands.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createKdfAdmission } from "../../src/web-hub/hub/kdf-admission.js";
import { createScope } from "../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../src/web-hub/hub/net-hosts.js";
import { createLoginLimiter } from "../../src/web-hub/hub/ratelimit.js";
import { createRegistry } from "../../src/web-hub/hub/registry.js";
import { decodeAgentFrame, type FleetRowWire, type FleetOmitted } from "../../src/web-hub/protocol/messages.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";
import AgentDetail from "../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import { HUB_CTX } from "../../src/web-hub/ui/src/components/control/controlContext.js";
import { archiveSetOf, archivedOf, partitionArchived } from "../../src/web-hub/ui/src/components/fleet/archiveView.js";
import { initialState, reduce } from "../../src/web-hub/ui/src/logic/state.js";
import { newCmdId, outcomeFromHttp } from "../../src/web-hub/ui/src/logic/control.js";
import type { AgentState, CmdOutcome, ControlHandle, HubState } from "../../src/web-hub/ui/src/types.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS } from "../web-hub/agent/helpers.js";
import { fakeKdf, fakeLanStore } from "../web-hub/contract/fakes.js";
import { config as hubConfig, memLog } from "../web-hub/hub/helpers.js";

interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}
async function rawRequest(
  port: number,
  opts: { path: string; headers?: Record<string, string>; method?: string; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method ?? "GET",
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...opts.headers,
          ...(opts.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(opts.body)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          clearTimeout(deadline);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("HTTP deadline")), 5_000);
    deadline.unref();
    req.once("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end(opts.body);
  });
}
function lanPostJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return rawRequest(port, {
    path,
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-PWH": "1", Origin: `http://127.0.0.1:${port}`, ...headers },
  });
}
async function ownedPort() {
  const server = net.createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (addr === null || typeof addr === "string") throw new Error("missing owned port");
  return addr.port;
}
const TEST_KDF_POLICY = { verifyTarget: { n: 16384, r: 8, p: 1, keyLen: 32, saltBytes: 16 } } as const;
const NOW = 1_700_000_100_000;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    resetGlobals();
    vi.restoreAllMocks();
    document.body.textContent = "";
    localStorage.clear();
  }
  if (errors.length > 0) throw new AggregateError(errors, "owned fixture cleanup failed");
});

/** Every wait owns an unref'd deadline, and is cancelled/settled on close. */
async function until(pred: () => boolean, label: string, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`timeout: ${label}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10);
      timer.unref();
    });
  }
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}
interface FleetData {
  agentKey: string;
  runs: FleetRowWire[];
  omitted?: FleetOmitted;
}
interface Received {
  event: string;
  id?: number;
  data: unknown;
  /** Exact received JSON, not a reserialization of parsed data. */
  rawData: string;
  block: string;
}
function fleet(event: Received): FleetData {
  const value = record(event.data);
  if (event.event !== "fleet" || typeof value.agentKey !== "string" || !Array.isArray(value.runs)) {
    throw new Error("expected fleet SSE");
  }
  // Validate the actual received rows/counts with the production wire decoder before narrowing.
  const decoded = decodeAgentFrame({
    t: "fleet",
    runs: value.runs,
    ...(value.omitted === undefined ? {} : { omitted: value.omitted }),
  });
  if (decoded?.t !== "fleet") throw new Error("invalid fleet SSE");
  return {
    agentKey: value.agentKey,
    runs: decoded.runs,
    ...(decoded.omitted === undefined ? {} : { omitted: decoded.omitted }),
  };
}

async function openStream(port: number, cookie: string, lastEventId?: number) {
  const events: Received[] = [];
  let ended = false;
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/api/events",
    agent: false,
    headers: {
      Cookie: cookie,
      Accept: "text/event-stream",
      ...(lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) }),
    },
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("SSE response deadline"));
    }, 5_000);
    timer.unref();
    req.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.once("response", (res) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error(`SSE status ${res.statusCode}`));
        return;
      }
      let pending = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, end + 2);
          pending = pending.slice(end + 2);
          const lines = block.split("\n");
          const rawData = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (rawData === "") continue;
          const idLine = lines.find((line) => line.startsWith("id: "));
          events.push({
            event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message",
            data: JSON.parse(rawData) as unknown,
            rawData,
            block,
            ...(idLine === undefined ? {} : { id: Number(idLine.slice(4)) }),
          });
        }
      });
      const end = () => {
        ended = true;
      };
      res.on("end", end);
      res.on("close", end);
      res.on("error", end);
      resolve();
    });
  });
  const close = () => {
    ended = true;
    req.destroy();
  };
  cleanups.push(close);
  req.end();
  await ready;
  async function wait(pred: (e: Received) => boolean, label = "SSE event", start = 0): Promise<Received> {
    await until(() => events.slice(start).some(pred) || ended, label);
    const found = events.slice(start).find(pred);
    if (found === undefined) throw new Error(`SSE ended: ${label}`);
    return found;
  }
  await wait((e) => e.event === "agents");
  return { port, cookie, events, wait, close };
}
type Stream = Awaited<ReturnType<typeof openStream>>;

function snap(
  runId: string,
  opts: {
    active?: boolean;
    at?: number;
    title?: string;
    label?: string;
    parentRunId?: string;
    sessionFile?: string;
    model?: string;
  } = {},
): RunSnapshot {
  const at = opts.at ?? NOW - 10_000;
  const phase = opts.active ? "model_turn" : "settled";
  return {
    runId,
    generation: 1,
    status: opts.active ? "running" : "completed",
    phase,
    deadlines: { enqueuedAt: at - 1000, deadlineAt: undefined, queueDeadlineAt: undefined },
    updatedAt: at,
    ...(opts.parentRunId === undefined ? {} : { parentRunId: opts.parentRunId }),
    diag: {
      createdAt: at - 1_000,
      startedAt: at - 900,
      phase,
      phaseEnteredAt: at,
      ...(opts.active ? {} : { settledAt: at }),
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      title: opts.title ?? `Title ${runId}`,
      label: opts.label ?? `worker-${runId}`,
      model: { provider: "test", id: opts.model ?? "fixture" },
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 },
      ...(opts.sessionFile === undefined ? {} : { sessionFile: opts.sessionFile }),
    },
  };
}
function series(
  prefix: string,
  count: number,
  opts: { active?: boolean; at?: number; title?: string } = {},
): RunSnapshot[] {
  return Array.from({ length: count }, (_, i) =>
    snap(`${prefix}-${i}`, { ...opts, at: (opts.at ?? NOW - 10_000) + i }),
  );
}

async function startFixture() {
  resetGlobals();
  localStorage.clear();
  const dir = mkdtempSync(join(tmpdir(), "pwh-fleet-p5-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = memLog();
  const registry = createRegistry({ now: () => NOW, log, pidAlive: () => true, hubVersion: "0.11.0" });
  const scope = createScope({ log, now: () => NOW });
  cleanups.push(() => scope.dispose());
  const store = fakeLanStore();
  const salt = Buffer.alloc(16, 7);
  store.seedUser({
    id: 1,
    username: "fleet-test",
    kdf: "scrypt",
    n: 16384,
    r: 8,
    p: 1,
    salt,
    hash: scryptSync("only-this-test-password", salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }),
    epoch: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const limiter = createLoginLimiter({ now: () => NOW });
  const paths = pathsIn(dir);
  const frontend = createHttpFrontend({
    paths,
    config: hubConfig({ home: dir, port: 0 }),
    registry,
    bus: registry.bus,
    log,
    now: () => NOW,
    info: () => ({
      version: "0.11.0",
      buildId: "p5",
      pid: process.pid,
      startedAt: NOW,
      proto: PROTO,
      caps: ["cmd.v1"],
    }),
    history: {
      snapshot: async (agentKey) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      page: async (agentKey) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      onLeafChanged: () => undefined,
    },
    commands: createCommandRouter({ registry, log, now: () => NOW }),
    lan: {
      cfg: { port: await ownedPort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
      store,
      kdf: fakeKdf(),
      kdfPolicy: TEST_KDF_POLICY,
      limiter,
      admission: createKdfAdmission({ now: () => NOW, isTightened: limiter.isTightened }),
      clientAllow: createClientAllowGuard({ entries: ["127.0.0.1/32"] }),
      hosts: createHostsPort(),
      scope,
      onStatus: () => undefined,
    },
  });
  cleanups.push(() => frontend.close());
  const { port } = await frontend.listen();
  if (frontend.lan === undefined) throw new Error("missing LAN listener");
  // Production LAN binder hardcodes 0.0.0.0. Constrain ONLY this bind to loopback;
  // retain the real transport, host/origin/cookie gate, ConnGuard and route set.
  const originalListen = net.Server.prototype.listen;
  let constrained = 0;
  const binding = vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
    this: net.Server,
    ...args: unknown[]
  ) {
    if (typeof args[0] === "number" && args[1] === "0.0.0.0") {
      args[1] = "127.0.0.1";
      constrained++;
    }
    return Reflect.apply(originalListen, this, args) as net.Server;
  });
  let lanPort: number;
  try {
    const status = await frontend.lan.start();
    if (status.state !== "on") throw new Error(`LAN start failed: ${JSON.stringify(status)}`);
    lanPort = status.port;
    expect(constrained).toBe(1);
  } finally {
    binding.mockRestore();
  }
  const token = readFileSync(paths.tokenFile, "utf8").trim();
  const localLogin = await lanPostJson(port, "/api/login", { token });
  expect(localLogin.status).toBe(200);
  const cookie = localLogin.headers["set-cookie"]?.[0]?.split(";")[0];
  if (cookie === undefined) throw new Error("loopback did not set cookie");
  const lanLogin = await lanPostJson(lanPort, "/api/login", {
    username: "fleet-test",
    password: "only-this-test-password",
  });
  expect(lanLogin.status).toBe(200);
  const lanCookie = lanLogin.headers["set-cookie"]?.[0]?.split(";")[0];
  if (lanCookie === undefined) throw new Error("LAN did not set cookie");
  expect(lanCookie).toMatch(/^pwh_lan=/);
  expect((await rawRequest(lanPort, { path: "/api/events" })).status).toBe(401);
  const streams = [await openStream(port, cookie), await openStream(lanPort, lanCookie)];

  const wireLines: string[] = [];
  const decodeErrors: string[] = [];
  const wireFrames: ReturnType<typeof decodeAgentFrame>[] = [];
  const server = net.createServer((socket) => {
    socket.unref();
    let pending = "";
    const utf8 = new StringDecoder("utf8");
    const decoder = new NdjsonDecoder({
      onFrame: (raw) => wireFrames.push(decodeAgentFrame(raw)),
      onError: (err) => decodeErrors.push(String(err)),
    });
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      pending += utf8.write(chunk);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        wireLines.push(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
      }
    });
  });
  const sockPath = join(dir, "hub.sock");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  server.unref();
  const agentServer = createAgentServer(server, {
    registry,
    config: hubConfig({ home: dir }),
    log,
    now: () => NOW,
    httpPort: () => port,
  });
  cleanups.push(async () => {
    await agentServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const input = { snaps: [] as readonly RunSnapshot[] };
  const appends: unknown[] = [];
  const archiveReads = { count: 0 };
  const archive = new ArchiveControl(
    {
      runs: () => {
        archiveReads.count++;
        return input.snaps;
      },
      bashJobs: () => [],
    },
    { now: () => NOW, sweepMs: 25, appendEntry: (_type, data) => appends.push(data) },
  );
  cleanups.push(() => archive.dispose());
  const rawPi = fakePi();
  const sessionFile = join(dir, "main.jsonl");
  writeFileSync(sessionFile, "");
  const { ctx } = fakeCtx({ sessionFile, sessionId: "own-fleet-session", branch: [], leaf: null });
  ctx.cwd = dir;
  wireWebHub(rawPi.pi, {
    settings: SETTINGS,
    fleet: () => input.snaps,
    archive: () => archive,
    env: { HOME: dir },
    paths: pathsIn(dir),
    now: () => NOW,
    privateNs: () => ({ gate: "not-ns" }),
    netConnect: net.connect,
    buildInfo: async () => ({ pluginVersion: "0.11.0", buildId: "p5-test" }),
    argv1: join(dir, "no-pi"),
    gitRunner: async () => ({ code: 128, stdout: "", stderr: "own nonrepo", stdoutCapped: false }),
  });
  // Never fire session_shutdown/reload. Cleanup closes only this test-owned connection.
  cleanups.push(resetGlobals);
  rawPi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await until(() => registry.list().length === 1, "real hello registered");
  const agentKey = registry.list()[0]!.agentKey;
  await Promise.all(streams.map((stream) => stream.wait((e) => e.event === "agent_up")));
  await Promise.all(streams.map((stream) => stream.wait((e) => e.event === "fleet")));

  function restore(ids: readonly string[], held: readonly string[] = [], horizon?: number) {
    archive.restore([
      {
        type: "custom",
        customType: ARCHIVE_ENTRY_TYPE,
        data: {
          entries: ids.map((id, i) => ({ kind: "run", id, at: i + 1, auto: true })),
          held: held.map((id, i) => ({ kind: "run", id, at: i + 1 })),
          ...(horizon === undefined ? {} : { horizon: { run: horizon } }),
        },
      },
    ]);
  }
  async function update(snaps: readonly RunSnapshot[], configure: () => void = () => restore([])) {
    const starts = streams.map((stream) => stream.events.length);
    const wireStart = wireLines.length;
    input.snaps = snaps;
    configure();
    // Do not call projectFleet here: wait for wireWebHub's real existing 1Hz onTick.
    const expected = new Set(snaps.map((s) => s.runId));
    await until(
      () =>
        wireLines.slice(wireStart).some((line) => {
          const frame = decodeAgentFrame(JSON.parse(line) as unknown);
          return frame?.t === "fleet" && frame.runs.every((row) => expected.has(row.runId));
        }),
      "producer tick fleet",
    );
    const received = await Promise.all(
      streams.map((stream, i) => stream.wait((e) => e.event === "fleet", "realtime fleet", starts[i])),
    );
    expect(received[0]!.rawData).toBe(received[1]!.rawData);
    const frame = wireLines.slice(wireStart).find((line) => record(JSON.parse(line) as unknown).t === "fleet");
    if (frame === undefined) throw new Error("missing producer fleet");
    expect(decodeErrors).toEqual([]);
    expect(wireFrames.every((frame) => frame !== undefined)).toBe(true);
    const decoded = decodeAgentFrame(JSON.parse(frame) as unknown);
    expect(decoded?.t).toBe("fleet");
    if (decoded?.t !== "fleet") throw new Error("wire decoder failed");
    expect(fleet(received[0]!).runs).toEqual(decoded.runs);
    expect(fleet(received[0]!).omitted).toEqual(decoded.omitted);
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(512 * 1024);
    for (const row of decoded.runs) expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(4096);
    for (const event of received) expect(Buffer.byteLength(event.block)).toBeLessThanOrEqual(512 * 1024 + 1024);
    const active = snaps.filter((s) => s.status === "running").length;
    expect(decoded.omitted ?? { active: 0, terminal: 0 }).toEqual({
      active: active - decoded.runs.filter((r) => !r.terminal).length,
      terminal: snaps.length - active - decoded.runs.filter((r) => r.terminal).length,
    });
    return { events: received, data: fleet(received[0]!), wire: frame };
  }
  return {
    dir,
    registry,
    streams,
    archive,
    archiveReads,
    appends,
    input,
    restore,
    update,
    agentKey,
    wireLines,
    wireFrames,
  };
}
type Fixture = Awaited<ReturnType<typeof startFixture>>;

function stateOf(stream: Stream): ReturnType<typeof initialState> {
  let state = initialState();
  for (const event of stream.events)
    state = reduce(state, {
      event: event.event,
      data: event.data,
      ...(event.id === undefined ? {} : { id: event.id }),
      at: NOW,
    });
  return state;
}
function agentOf(stream: Stream, key: string): AgentState {
  const agent = stateOf(stream).agents.get(key);
  if (agent === undefined) throw new Error("reducer has no agent");
  return agent as AgentState;
}
function partition(agent: AgentState) {
  const decoded = decodeAgentFrame({ t: "fleet", runs: agent.fleet ?? [] });
  if (decoded?.t !== "fleet") throw new Error("invalid reducer rows");
  return partitionArchived(decoded.runs, archiveSetOf(archivedOf(agent), "run"));
}

async function mountUi(f: Fixture, stream: Stream) {
  // Component inputs are exclusively the state obtained by parsing this listener's real SSE.
  const state = shallowRef(stateOf(stream));
  const requests: Array<{ target: string; set: string; outcome?: CmdOutcome }> = [];
  const drafts = new Map<string, string>();
  const control: Pick<ControlHandle, "setArchived" | "draft" | "setDraft"> = {
    draft: (key) => drafts.get(key) ?? "",
    setDraft: (key, text) => {
      drafts.set(key, text);
    },
    async setArchived(agentKey, kind, target, set) {
      const entry: (typeof requests)[number] = { target, set };
      requests.push(entry);
      const result = await lanPostJson(
        stream.port,
        "/api/cmd",
        { agentKey, id: newCmdId(), op: "archive", kind, target, set },
        { Cookie: stream.cookie },
      );
      const outcome: CmdOutcome = outcomeFromHttp(result.status, JSON.parse(result.body) as unknown);
      entry.outcome = outcome;
      return outcome;
    },
  };
  // A deliberately narrow injection adapter: no successful operation stubs. The only control
  // used by this test is real HTTP; unrelated composer/navigation paths are not exercised.
  const wrapper = mount(AgentDetail, {
    props: { agent: agentOf(stream, f.agentKey), now: NOW, narrow: false },
    attachTo: document.body,
    global: {
      provide: {
        [HUB_CTX as symbol]: {
          state,
          control,
          selectRun: () => {
            throw new Error("unexpected transcript selection");
          },
        },
      },
    },
  });
  cleanups.push(() => wrapper.unmount());
  async function pump() {
    state.value = stateOf(stream);
    await wrapper.setProps({ agent: agentOf(stream, f.agentKey) });
    await nextTick();
  }
  async function open() {
    const button = wrapper.get('.fleet-summary-bar[data-panel="agent"]');
    if (button.attributes("aria-expanded") !== "true") await button.trigger("click", { detail: 1 });
    expect(wrapper.get("#fleet-drawer").attributes("data-open")).toBeDefined();
  }
  return { wrapper, pump, open, requests };
}

async function reconnect(stream: Stream, expected: Received, lastEventId?: number) {
  const reconnected = await openStream(stream.port, stream.cookie, lastEventId);
  const cached = await reconnected.wait((e) => e.event === "fleet" && e.id === undefined, "direct cached fleet");
  expect(cached.rawData).toBe(expected.rawData);
  const finalAgent = agentOf(reconnected, fleet(expected).agentKey);
  expect(finalAgent.fleet).toEqual(fleet(expected).runs);
  expect(finalAgent.fleetOmitted).toEqual(fleet(expected).omitted);
  return reconnected;
}

// ---------------------------------------------------------------------------
describe("#9 P5 real fleet-retention closed loop", () => {
  it("64 completed/58 archived reach both DOMs; shared child sessionFile keeps original/resume runId, and real unarchive targets its own id", async () => {
    const f = await startFixture();
    const sameChild = join(f.dir, "own-child.jsonl");
    writeFileSync(sameChild, "");
    const snaps = series("sample", 64).map((s, i) =>
      i < 2 ? { ...s, diag: { ...s.diag, sessionFile: sameChild } } : s,
    );
    const ids = snaps.slice(0, 58).map((s) => s.runId);
    const result = await f.update(snaps, () => f.restore(ids));
    expect(result.data.runs).toHaveLength(64);
    expect(result.data.omitted).toBeUndefined();
    expect(f.appends).toEqual([]);
    expect(new Set(result.data.runs.map((r) => r.runId)).size).toBe(64);
    for (const row of result.data.runs) {
      const source = snaps.find((s) => s.runId === row.runId)!;
      expect(row).toMatchObject({
        title: source.diag.title,
        costUsd: 0.25,
        startedAt: source.diag.createdAt,
        endedAt: source.diag.settledAt,
      });
    }
    const uis = [];
    for (const stream of f.streams) {
      const agent = agentOf(stream, f.agentKey);
      expect(partition(agent).live).toHaveLength(6);
      expect(partition(agent).archivedRows).toHaveLength(58);
      const ui = await mountUi(f, stream);
      uis.push(ui);
      await ui.open();
      const more = ui.wrapper.find(".run-more");
      if (more.exists()) await more.trigger("click");
      expect(
        ui.wrapper
          .findAll(".tree .run-name b")
          .map((el) => el.text())
          .sort(),
      ).toEqual(
        snaps
          .slice(58)
          .map((s) => s.diag.title!)
          .sort(),
      );
      expect(ui.wrapper.get(".fleet-archived-fold").text()).toBe("Archived 58");
      await ui.wrapper.get(".fleet-archived-fold").trigger("click");
      const archiveRows = ui.wrapper.findAll(".fleet-archived-list .arch-row");
      expect(archiveRows).toHaveLength(58);
      expect(archiveRows.map((el) => el.get(".arch-name b").text()).sort()).toEqual(
        snaps
          .slice(0, 58)
          .map((s) => s.diag.title!)
          .sort(),
      );
      expect(archiveRows.every((el) => el.get(".run-cost").text() === "$0.2500")).toBe(true);
      expect(archiveRows.every((el) => el.find(".run-meta").exists())).toBe(true);
    }
    // Counterfactual #1: exactly the old producer selection, no archive-view tail parameter.
    const old = projectFleet(snaps, NOW);
    const wrong = partitionArchived(old, archiveSetOf(f.archive.wire(), "run"));
    expect(old).toHaveLength(8);
    expect(wrong.live).toHaveLength(6);
    expect(wrong.archivedRows).toHaveLength(2);
    expect(result.data.runs.length).not.toBe(old.length);
    const ui = uis[0]!;
    const targetRow = ui.wrapper
      .findAll(".arch-row")
      .find((row) => row.get(".arch-name b").text() === "Title sample-0");
    if (targetRow === undefined) throw new Error("missing original run DOM");
    await targetRow.get(".arch-act").trigger("click");
    await until(() => ui.requests[0]?.outcome !== undefined, "real unarchive result");
    expect(ui.requests[0]).toMatchObject({ target: "sample-0", set: "unarchive", outcome: { ok: true } });
    expect(f.archive.runDisplayView().held.has("sample-0")).toBe(true);
    expect(f.archive.runDisplayView().archived.has("sample-1")).toBe(true);
    expect(f.appends).toHaveLength(1);
  }, 20_000);

  it("70 active +20 ordinary +58 archived: omitted survives realtime/direct cache/ring replay/resync on both listeners, then absent clears bytes/state", async () => {
    const f = await startFixture();
    const active = series("active", 70, { active: true });
    const ordinary = series("ordinary", 20, { at: NOW - 20_000 });
    const archives = series("archive", 58);
    const result = await f.update([...active, ...ordinary, ...archives], () => f.restore(archives.map((s) => s.runId)));
    expect(result.data.omitted).toEqual({ active: 6, terminal: 12 });
    expect(result.data.runs.filter((r) => !r.terminal)).toHaveLength(64);
    expect(result.data.runs.filter((r) => !r.terminal).map((r) => r.runId)).toEqual(
      active.slice(0, 64).map((s) => s.runId),
    );
    expect(result.data.runs.filter((r) => r.runId.startsWith("ordinary"))).toHaveLength(8);
    expect(result.data.runs.filter((r) => r.runId.startsWith("archive"))).toHaveLength(58);
    const oldHttpState = reduce(stateOf(f.streams[0]!), {
      event: "fleet",
      data: { agentKey: f.agentKey, runs: result.data.runs },
    }) as HubState;
    expect(oldHttpState.agents.get(f.agentKey)?.fleetOmitted).toBeUndefined();
    expect(agentOf(f.streams[0]!, f.agentKey).fleetOmitted).not.toEqual(
      oldHttpState.agents.get(f.agentKey)?.fleetOmitted,
    );
    const uis = [];
    for (const [i, stream] of f.streams.entries()) {
      const ui = await mountUi(f, stream);
      uis.push(ui);
      await ui.open();
      expect(ui.wrapper.get('[data-panel="agent"].fleet-summary-bar').attributes("aria-label")).toContain("listed");
      expect(
        ui.wrapper
          .findAll(".fleet-omitted")
          .map((el) => el.text())
          .join(" "),
      ).toMatch(/6[\s\S]*12/);
      const ev = result.events[i]!;
      expect(ev.id).toBeDefined();
      await reconnect(stream, ev);
      const replay = await reconnect(stream, ev, ev.id! - 1);
      const ringFleet = await replay.wait((e) => e.event === "fleet" && e.id === ev.id, "actual ring fleet");
      expect(ringFleet.block).toBe(ev.block); // includes real id/event/data bytes
      const resynced = await reconnect(stream, ev, 0);
      await resynced.wait((e) => e.event === "resync", "old id triggers resync");
    }
    // No omitted key (not zero/null/undefined fields), real next producer tick and cache replacement.
    const cleared = await f.update([snap("small", { title: "normal small row" })]);
    expect(cleared.data.omitted).toBeUndefined();
    for (const [i, stream] of f.streams.entries()) {
      const expected = JSON.stringify({ agentKey: f.agentKey, runs: cleared.data.runs });
      expect(cleared.events[i]!.rawData).toBe(expected);
      expect(Object.keys(record(cleared.events[i]!.data))).toEqual(["agentKey", "runs"]);
      expect(agentOf(stream, f.agentKey).fleetOmitted).toBeUndefined();
      await uis[i]!.pump();
      expect(uis[i]!.wrapper.findAll(".fleet-omitted")).toHaveLength(0);
      expect(uis[i]!.wrapper.get('[data-panel="agent"].fleet-summary-bar').attributes("aria-label")).not.toContain(
        "listed",
      );
      const replay = await reconnect(stream, cleared.events[i]!, cleared.events[i]!.id! - 1);
      expect((await replay.wait((e) => e.event === "fleet" && e.id === cleared.events[i]!.id)).rawData).toBe(expected);
      await reconnect(stream, cleared.events[i]!, 0);
    }
  }, 25_000);

  it("real archive cap overflow raises horizon; held below horizon is ordinary, implicit archives stay omitted and settled state performs no extra writes", async () => {
    const f = await startFixture();
    const old = series("old", 300, { at: NOW - 30_000 });
    const ordinary = series("new", 20, { at: NOW - 5_000 });
    const active = series("live", 70, { active: true });
    const result = await f.update([...old, ...ordinary, ...active], () => {
      expect(f.archive.setArchived("run", "old-0", "archive")).toMatchObject({ ok: true, changed: true });
      expect(f.archive.setArchived("run", "old-0", "unarchive")).toMatchObject({ ok: true, changed: true });
      expect(
        f.archive.setArchivedMany(
          "run",
          old.slice(1).map((s) => s.runId),
        ),
      ).toBe(299);
      expect(f.archive.runDisplayView().archived.size).toBe(256);
      expect(f.archive.runDisplayView().horizon).toBe(old[43]!.diag.settledAt);
      expect(f.archive.setArchived("run", "old-0", "unarchive").ok).toBe(true);
      // Give the hold a recently updated diagnostic (settledAt remains below horizon), so
      // it legitimately competes inside ordinary U8 rather than becoming an unbounded pin.
      f.input.snaps = f.input.snaps.map((s) => (s.runId === "old-0" ? { ...s, updatedAt: NOW } : s));
    });
    expect(result.data.runs).toHaveLength(328);
    expect(result.data.omitted).toEqual({ active: 6, terminal: 56 });
    expect(result.data.runs.some((r) => r.runId === "old-0")).toBe(true);
    expect(result.data.runs.some((r) => r.runId === "old-1")).toBe(false);
    expect(result.data.runs.filter((r) => r.runId.startsWith("old-") && r.runId !== "old-0")).toHaveLength(256);
    expect(f.appends).toHaveLength(3);
    const rev = f.archive.currentRev();
    f.archive.runDisplayView();
    f.archive.runDisplayView();
    expect(f.archive.currentRev()).toBe(rev);
    const reads = f.archiveReads.count;
    f.archive.start(true, 21); // 20 ordinary + one held; implicit H does not count.
    await until(() => f.archiveReads.count >= reads + 2, "two real steady-state auto sweeps");
    f.archive.start(false);
    expect(f.archive.currentRev()).toBe(rev);
    expect(f.appends).toHaveLength(3);
    for (const stream of f.streams) {
      const agent = agentOf(stream, f.agentKey);
      expect(partition(agent).live.some((r) => r.runId === "old-0")).toBe(true);
      expect(partition(agent).archivedRows).toHaveLength(256);
      const ui = await mountUi(f, stream);
      await ui.open();
      expect(ui.wrapper.get(".fleet-archived-fold").text()).toBe("Archived 256");
      expect(
        ui.wrapper
          .findAll(".fleet-omitted")
          .map((el) => el.text())
          .join(" "),
      ).toContain("56");
    }
  }, 20_000);

  it("UTF-8/JSON escape pressure remains within actual 512KiB frame+LF and 4KiB rows; huge identities drop whole and omitted-only AgentDetail stays openable", async () => {
    const f = await startFixture();
    expect(WEB_FLEET_FRAME_BYTES).toBe(512 * 1024);
    expect(WEB_FLEET_ROW_BYTES).toBe(4096);
    const title = "汉😀\\\n\t".repeat(240); // serialized bytes exceed UTF-16 char count
    const active = series("pressure-active", 64, { active: true, title });
    const ordinary = series("pressure-ordinary", 8, { title });
    const archived = series("pressure-archive", 200, { title });
    const snaps = [...active, ...ordinary, ...archived];
    const before = JSON.stringify(snaps);
    const result = await f.update(snaps, () => f.restore(archived.map((s) => s.runId)));
    expect(JSON.stringify(snaps)).toBe(before);
    expect(result.data.runs.filter((r) => !r.terminal)).toHaveLength(64);
    expect(result.data.runs.filter((r) => r.runId.startsWith("pressure-ordinary"))).toHaveLength(8);
    const selectedArchives = result.data.runs.filter((r) => r.runId.startsWith("pressure-archive"));
    expect(selectedArchives.length).toBeGreaterThan(0);
    expect(selectedArchives.length).toBeLessThan(200);
    expect(selectedArchives.map((row) => row.runId)).toEqual(
      archived
        .slice(-selectedArchives.length)
        .reverse()
        .map((s) => s.runId),
    );
    expect(result.data.omitted?.terminal).toBe(200 - selectedArchives.length);
    expect(Buffer.byteLength(result.wire)).toBeGreaterThan(result.wire.length);
    expect(Buffer.byteLength(result.wire)).toBeGreaterThan(400 * 1024);
    // Degrade long fields safely on an actual subsequent tick (including non-BMP pairs).
    const unicode = snap("unicode-row", {
      title: "汉😀\\\n\t".repeat(2_000),
      label: "标签🙂".repeat(1_000),
      model: "模型😀".repeat(2_000),
    });
    const shortened = await f.update([unicode]);
    expect(shortened.data.runs[0]!.title).toMatch(/…$/);
    expect(shortened.wire).not.toContain("�");
    expect(shortened.data.runs[0]!.runId).toBe("unicode-row");
    const huge = [snap("😀".repeat(3_000), { active: true }), snap("small-id", { parentRunId: "父😀".repeat(3_000) })];
    const omittedOnly = await f.update(huge);
    expect(omittedOnly.data).toEqual({ agentKey: f.agentKey, runs: [], omitted: { active: 1, terminal: 1 } });
    expect(omittedOnly.wire).not.toContain("small-id");
    for (const [i, stream] of f.streams.entries()) {
      const ui = await mountUi(f, stream);
      const button = ui.wrapper.get('[data-panel="agent"].fleet-summary-bar');
      expect(button.attributes("aria-label")).toContain("0 listed");
      await ui.open();
      expect(ui.wrapper.findAll(".fleet-omitted")).toHaveLength(2);
      expect(ui.wrapper.find(".arch-row").exists()).toBe(false);
      await reconnect(stream, omittedOnly.events[i]!, 0);
    }
  }, 25_000);

  it.each(["down", "removed"] as const)(
    "%s clears both listener caches; reconnect never resurrects rows/omitted; a new real agent_up accepts only new fleet",
    async (mode) => {
      const f = await startFixture();
      const result = await f.update(series("before", 20));
      expect(result.data.omitted).toEqual({ active: 0, terminal: 12 });
      const starts = f.streams.map((s) => s.events.length);
      if (mode === "removed") expect(f.registry.remove(f.agentKey, { allowConnected: true })).toBe("removed");
      else resetGlobals(); // real bye and socket close, not a synthetic bus event
      await Promise.all(
        f.streams.map((stream, i) =>
          stream.wait((e) => e.event === (mode === "down" ? "agent_down" : "agent_removed"), mode, starts[i]),
        ),
      );
      // Cache-only new connection, and resync (which MUST NOT replay pre-down ring state).
      for (const stream of f.streams) {
        for (const lastEventId of [undefined, 0]) {
          const fresh = await openStream(stream.port, stream.cookie, lastEventId);
          // End-of-connect marker from a real read-only HTTP request on this listener, then
          // allow one I/O turn; the complete initial SSE burst is already written before it.
          expect((await rawRequest(stream.port, { path: "/healthz", headers: { Cookie: stream.cookie } })).status).toBe(
            200,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(fresh.events.filter((e) => e.event === "fleet")).toEqual([]);
          expect(stateOf(fresh).agents.get(f.agentKey)?.fleetOmitted).toBeUndefined();
        }
      }
      expect(f.streams[0]!.events.some((e) => e.event === "fleet")).toBe(true); // offline historical UI is not erased by this fix
      // A second REAL activation on the same owned socket/home (no module reload or fake hello).
      resetGlobals();
      const raw = fakePi();
      const { ctx } = fakeCtx({
        sessionFile: join(f.dir, "new-session.jsonl"),
        sessionId: "own-new-session",
        leaf: null,
      });
      ctx.cwd = f.dir;
      const freshSnaps = [snap("after-reconnect")];
      wireWebHub(raw.pi, {
        settings: SETTINGS,
        fleet: () => freshSnaps,
        env: { HOME: f.dir },
        paths: pathsIn(f.dir),
        netConnect: net.connect,
        now: () => NOW,
        privateNs: () => ({ gate: "not-ns" }),
        buildInfo: async () => ({ pluginVersion: "0.11.0", buildId: "p5-new" }),
        argv1: join(f.dir, "no-pi"),
        gitRunner: async () => ({ code: 128, stdout: "", stderr: "own nonrepo", stdoutCapped: false }),
      });
      const nextStarts = f.streams.map((s) => s.events.length);
      raw.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
      for (const [i, stream] of f.streams.entries()) {
        await stream.wait((e) => e.event === "agent_up", "new real agent_up", nextStarts[i]);
        const next = await stream.wait(
          (e) => e.event === "fleet" && fleet(e).runs.some((r) => r.runId === "after-reconnect"),
          "new real fleet",
          nextStarts[i],
        );
        expect(fleet(next).omitted).toBeUndefined();
        expect(fleet(next).runs.map((r) => r.runId)).toEqual(["after-reconnect"]);
        await reconnect(stream, next);
      }
    },
    25_000,
  );
});
