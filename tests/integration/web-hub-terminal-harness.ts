/** Real socket → decoder → registry → dual real HTTP/SSE rings. Only auth DB/KDF
 * and session-file history are test fixtures; registry/bus/routes/ring are never mocked. */
import net from "node:net";
import { join } from "node:path";
import { createRegistry } from "../../src/web-hub/hub/registry.js";
import { createAgentServer } from "../../src/web-hub/hub/agent-server.js";
import { createCommandRouter } from "../../src/web-hub/hub/commands.js";
import { createAgentServer as createOldAgentServer } from "../web-hub/terminal-legacy/agent-server.js";
import { createCommandRouter as createOldCommandRouter } from "../web-hub/terminal-legacy/commands.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createHostsPort } from "../../src/web-hub/hub/net-hosts.js";
import { createScope } from "../../src/web-hub/hub/lifecycle.js";
import { createLoginLimiter } from "../../src/web-hub/hub/ratelimit.js";
import { createKdfAdmission } from "../../src/web-hub/hub/kdf-admission.js";
import { createClientAllowGuard } from "../../src/web-hub/hub/client-allow.js";
import type { TerminalIngressPort, HubEvent } from "../../src/web-hub/hub/ports.js";
import { fakeKdf, fakeLanStore } from "../web-hub/contract/fakes.js";
import { fakeDeps, login, makeTmp, openSse, postJson, type SseConn } from "../web-hub/http/helpers.js";
import { lanPostJson, seedLanUser, TEST_KDF_POLICY } from "../web-hub/http/lan-helpers.js";
import { connectClient, hello, memLog, waitFor } from "../web-hub/hub/helpers.js";
import { freePort } from "../helpers/free-port.js";

export async function terminalHarness(options: { legacy?: boolean; terminal?: TerminalIngressPort } = {}) {
  const tmp = makeTmp("pwh-t-");
  const now = () => 1_700_000_000_000;
  const log = memLog();
  const registry = createRegistry({ now, log, pidAlive: () => true });
  const bus: HubEvent[] = [];
  const unsub = registry.bus.subscribe((e) => bus.push(e));
  const deps = fakeDeps(tmp.dir);
  deps.now = now;
  deps.registry = registry;
  deps.bus = registry.bus;
  const router = (options.legacy ? createOldCommandRouter : createCommandRouter)({ registry, log, now });
  deps.commands = router;
  const scope = createScope({ log, now });
  const store = fakeLanStore();
  const limiter = createLoginLimiter({ now });
  deps.lan = {
    cfg: { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    store,
    kdf: fakeKdf(),
    limiter,
    admission: createKdfAdmission({ now, isTightened: limiter.isTightened }),
    hosts: createHostsPort(),
    scope,
    onStatus: () => {},
    clientAllow: createClientAllowGuard({}),
    kdfPolicy: TEST_KDF_POLICY,
  };
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const lanStatus = await fe.lan!.start();
  if (lanStatus.state !== "on") throw new Error(JSON.stringify(lanStatus));
  const lanPort = lanStatus.port;
  const cookies = [await login(port, deps.paths.tokenFile), ""];
  seedLanUser(store, { username: "alice", password: "owned-test-password" });
  const lanLogin = await lanPostJson(lanPort, "/api/login", { username: "alice", password: "owned-test-password" });
  if (lanLogin.status !== 200) throw new Error(`LAN login ${lanLogin.status}: ${lanLogin.body}`);
  cookies[1] = (lanLogin.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  const ports = [port, lanPort];
  const server = net.createServer();
  const sockPath = join(tmp.dir, "agent.sock");
  await new Promise<void>((r) => server.listen(sockPath, r));
  const serverDeps = {
    registry,
    config: deps.config,
    log,
    now,
    httpPort: () => 7878,
    ...(options.terminal ? { terminal: options.terminal } : {}),
  };
  const agentServer = (options.legacy ? createOldAgentServer : createAgentServer)(server, serverDeps);
  const client = await connectClient(sockPath);
  client.send(hello({ caps: ["ev.v1", "cmd.v1", "command.v1"] }));
  const helloAck = await client.waitFrame((f) => f.t === "hello_ack");
  const agentKey = String(helloAck.agentKey);
  client.send({ t: "session", sessionId: "session", cwd: "/tmp/work", reason: "startup", leafId: null, mode: "tui" });
  await waitFor(() => registry.get(agentKey)?.session?.sessionId === "session");
  const sses: SseConn[] = [];
  async function sse(index: number, lastEventId?: number, subscribe = true) {
    const c = await openSse(ports[index]!, {
      cookie: cookies[index]!,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    });
    sses.push(c);
    const h = await c.waitFor((e) => e.event === "hello");
    if (subscribe) {
      const r = await postJson(
        ports[index]!,
        "/api/subscribe",
        { clientId: h.data.clientId, agentKey },
        { Cookie: cookies[index]!, Origin: `http://127.0.0.1:${ports[index]}` },
      );
      if (r.status !== 202) throw new Error(`subscribe: ${r.status} ${r.body}`);
    }
    return c;
  }
  return {
    tmp,
    registry,
    bus,
    router,
    log,
    client,
    agentKey,
    helloAck,
    ports,
    cookies,
    serverDeps,
    sse,
    async barrier() {
      const ts = Date.now() + Math.random();
      client.send({ t: "ping", ts });
      await client.waitFrame((f) => f.t === "pong" && f.ts === ts);
    },
    async close() {
      for (const s of sses) s.close();
      client.sock.destroy();
      unsub();
      await agentServer.close();
      await new Promise<void>((r) => server.close(() => r()));
      await fe.close();
      await scope.dispose();
      tmp.cleanup();
    },
  };
}
export type TerminalHarness = Awaited<ReturnType<typeof terminalHarness>>;
