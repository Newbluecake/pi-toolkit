/** Real both-listener/SQLite/native PTY fixture. Agent private context is explicitly
 * simulated; actual SDK evidence lives in terminal-v2-sdk/maintenance integrations.
 * Contract fixture marker is NOT a trusted fresh construction claim.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createTerminalTestBackend } from "../../../src/web-hub/hub/terminal/v2/backend.js";
import type { HubTerminalServiceV2 } from "../../../src/web-hub/hub/terminal/v2/service.js";
import type { TerminalFrontendDepsV2 } from "../../../src/web-hub/hub/terminal/v2/frontend.js";
import { webHubStateDir } from "../../../src/web-hub/protocol/paths.js";
import { NdjsonDecoder } from "../../../src/web-hub/protocol/ndjson.js";
import { makeTerminalFixture } from "../terminal-v2-backend-fixture.js";
import { config, connectClient, hello, type TestClient } from "../../web-hub/hub/helpers.js";
import { login, postJson } from "../../web-hub/http/helpers.js";
import { lanPostJson } from "../../web-hub/http/lan-helpers.js";
import { freePort } from "../../helpers/free-port.js";
export async function terminalV2AuthFixture(
  closers: Array<() => void | Promise<void>>,
  corrupt = false,
  terminalEnabled = true,
  options: {
    awaitTerminal?: boolean;
    retain?: boolean;
    /** Exercise real enabled-only first-use construction; never write contract files. */
    fresh?: boolean;
    beforeStart?(state: string): void;
    backendDoneBarrier?: Promise<void>;
    existing?: { privatePty: ReturnType<typeof makeTerminalFixture>; lanPort: number; password: string };
  } = {},
) {
  const privatePty = options.existing?.privatePty ?? makeTerminalFixture();
  if (!options.retain && !options.existing) closers.push(privatePty.cleanup);
  const home = privatePty.fixture.home,
    state = webHubStateDir(home),
    socketDir = join(privatePty.fixture.root, "s");
  if (!options.existing) {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    mkdirSync(socketDir, { mode: 0o700 });
    writeFileSync(
      join(home, ".pi/agent/pi-toolkit.json"),
      JSON.stringify({ webHub: { terminal: { enabled: terminalEnabled } } }),
      { mode: 0o600 },
    );
    if (!options.fresh) {
      // Contract fixture initialization, NOT a trusted fresh maintenance history claim.
      const marker = { v: 2, storeId: "s".repeat(24), initialization: "fresh", checkpointId: "c".repeat(24) };
      mkdirSync(join(state, "terminal-v2"), { mode: 0o700 });
      const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      put(join(state, ".terminal-initialized-v2"), marker);
      put(join(state, "terminal-v2/marker.json"), marker);
      put(
        join(state, "terminal-v2/ledger.json"),
        corrupt ? { broken: true } : { v: 2, storeId: marker.storeId, revision: 0, allocations: [] },
      );
    }
  }
  if (!options.existing) options.beforeStart?.(state);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi/agent"));
  vi.stubEnv("PI_WEBHUB_TERMINAL_SOURCE", "plain");
  const lanPort = options.existing?.lanPort ?? (await freePort());
  let initialized: Promise<void> | undefined, service: HubTerminalServiceV2 | undefined;
  let terminal: TerminalFrontendDepsV2["terminalV2"];
  let authStore: import("../../../src/web-hub/hub/ports.js").LanStorePort | undefined;
  let backendCalls = 0;
  const started = await startHub(
    config({
      home,
      lan: { port: lanPort, extraHosts: [], trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.test"] },
    }),
    (deps) => {
      terminal = (deps as typeof deps & TerminalFrontendDepsV2).terminalV2;
      authStore = deps.lan?.store;
      return createHttpFrontend(deps);
    },
    {
      xdgRuntimeDir: socketDir,
      terminalV2Test: {
        backend: (input) => {
          backendCalls++;
          const backend = createTerminalTestBackend(input, privatePty.fixture);
          if (!options.backendDoneBarrier) return backend;
          // Hold only the original real physical-result future. All methods/getters
          // delegate to the actual native backend; NEVER synthesize a proof/result.
          const done = backend.done.then(async (physical) => {
            await options.backendDoneBarrier;
            return physical;
          });
          return new Proxy(backend, {
            get(target, key) {
              if (key === "done") return done;
              const value = Reflect.get(target, key, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        ready: (work, owner) => {
          initialized = work;
          service = owner;
        },
      },
    },
  );
  if ("exists" in started || !("httpPort" in started)) throw new Error("private hub did not start");
  const hub: RunningHub = started;
  closers.push(() => hub.close("private-test"));
  if (options.awaitTerminal !== false) await initialized;
  if (terminalEnabled) {
    expect(terminal).toBeDefined();
    expect(service).toBeDefined();
  } else {
    expect(terminal).toBeUndefined();
    expect(service).toBeUndefined();
  }
  const agent = await connectClient(hub.paths.socketPath);
  closers.push(() => {
    agent.sock.destroy();
  });
  agent.send(hello({ agentId: { pid: process.pid, nonce: "v2-private-metadata" }, cwd: privatePty.fixture.cwd }));
  const ack = await agent.waitFrame((f) => f.t === "hello_ack"),
    key = ack.agentKey as string;
  const scope = { agentKey: key, sessionId: "private-session", epoch: "epoch-1" };
  const contextDecoder = new NdjsonDecoder({
    onFrame(raw) {
      const frame = raw as Record<string, unknown>;
      if (frame.t === "terminal_context_req")
        agent.send({
          t: "terminal_context_res",
          v: 2,
          ok: true,
          rid: frame.rid,
          sessionId: scope.sessionId,
          epoch: scope.epoch,
          contextGeneration: frame.contextGeneration,
          cwd: privatePty.fixture.cwd,
        });
    },
    onError() {
      throw new Error("bad private request");
    },
  });
  agent.sock.on("data", (chunk: Buffer) => contextDecoder.push(chunk));
  agent.send({
    t: "session",
    sessionId: scope.sessionId,
    cwd: privatePty.fixture.cwd,
    reason: "startup",
    leafId: null,
    mode: "tui",
  });
  agent.send({
    t: "status",
    leafId: null,
    busy: false,
    pending: false,
    terminalSessionV2: {
      v: 2,
      enabled: true,
      sessionId: scope.sessionId,
      epoch: scope.epoch,
      contextGeneration: 1,
      limits: { maxPerSession: 2, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
    },
  });
  // Stream ordering fence: this reply follows both declarations on the same UDS.
  agent.send({ t: "ping", ts: 771 });
  await agent.waitFrame((f) => f.t === "pong" && f.ts === 771);
  const loopCookie = await login(hub.httpPort, hub.paths.tokenFile);
  const info = await terminalV2Admin(agent, { op: "info" });
  if (!info.ok || !info.info) throw new Error("private LAN info failed");
  const lanHeaders = {
    Host: "hub.test",
    Origin: "https://hub.test",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "hub.test",
  };
  const lanLogin = await lanPostJson(
    lanPort,
    "/api/login",
    { username: info.info.username, password: options.existing?.password ?? info.info.initialPassword },
    lanHeaders,
  );
  expect(lanLogin.status).toBe(200);
  const lanCookie = lanLogin.headers["set-cookie"]?.[0]?.split(";")[0];
  expect(lanCookie).toBeDefined();
  const loop = async (op: string, body: unknown) => {
    const response = await postJson(hub.httpPort, `/api/terminal/v2/${op}`, body, {
      Cookie: loopCookie,
      Origin: `http://127.0.0.1:${hub.httpPort}`,
    });
    return { status: response.status, body: JSON.parse(response.body) as Record<string, any> };
  };
  const lan = async (op: string, body: unknown, cookie = lanCookie!) => {
    const response = await lanPostJson(lanPort, `/api/terminal/v2/${op}`, body, { ...lanHeaders, Cookie: cookie });
    return { status: response.status, body: JSON.parse(response.body) as Record<string, any> };
  };
  return {
    hub,
    state,
    agent,
    scope,
    loop,
    lan,
    authStore: authStore!,
    terminal: terminal!,
    service: service!,
    loopCookie,
    lanCookie: lanCookie!,
    lanHeaders,
    lanPort,
    username: info.info.username,
    privatePty,
    initialized,
    restart: async (password = options.existing?.password ?? info.info.initialPassword) => {
      agent.sock.destroy();
      await hub.close("auth-restart");
      // Existing original state/DB/marker/ledger bytes are NEVER initialized/healed.
      return terminalV2AuthFixture(closers, false, terminalEnabled, {
        ...options,
        existing: { privatePty, lanPort, password },
      });
    },
    get backendCalls() {
      return backendCalls;
    },
    loginLan: (password = options.existing?.password ?? info.info.initialPassword, username = info.info.username) =>
      lanPostJson(lanPort, "/api/login", { username, password }, lanHeaders),
  };
}
export async function terminalV2Admin(client: TestClient, input: Record<string, unknown>) {
  const rid = Math.random().toString(36).slice(2);
  client.send({ t: "lan_req", rid, ...input });
  return (await client.waitFrame((frame) => frame.t === "lan_res" && frame.rid === rid, 10000)) as Record<string, any>;
}
