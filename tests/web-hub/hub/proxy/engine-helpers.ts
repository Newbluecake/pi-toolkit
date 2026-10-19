import { request, type Server, type IncomingHttpHeaders } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthIdentity, ProxyService } from "../../../../src/web-hub/hub/ports.js";
import type { ProxyOpenResult } from "../../../../src/web-hub/protocol/proxy.js";
import { createProxyService, type ProxyServiceDeps } from "../../../../src/web-hub/hub/proxy/service.js";
import { proxyUpstream } from "../../../fixtures/proxy-upstream.js";

export const identity = (n = 1, now = Date.now()): AuthIdentity => ({
  listener: "loopback",
  principal: String(n).padStart(43, "a"),
  sidTag: String(n).padStart(43, "a"),
  parentExpiresAt: now + 24 * 60 * 60_000,
});
export async function waitFor(check: () => boolean, ms = 4000) {
  const at = Date.now();
  while (!check()) {
    if (Date.now() - at > ms) throw new Error("condition not reached");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
export async function listen(server: Server, port: number, host: string) {
  server.listen(port, host);
  server.unref();
  await once(server, "listening");
}
export async function freeRange(exclude: readonly number[] = []): Promise<[number, number]> {
  // An ephemeral base can sit immediately below an already-bound upstream. Exclude its
  // whole candidate range (plus one guard port for tests that probe target port ±1).
  for (let attempt = 0; attempt < 64; attempt++) {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    probe.unref();
    await once(probe, "listening");
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (port + 16 > 65535 || exclude.some((n) => n >= port - 1 && n <= port + 16)) continue;
    return [port, port + 15];
  }
  throw new Error("no disjoint test port range");
}
export async function engine(overrides: Partial<ProxyServiceDeps> = {}) {
  let up = await proxyUpstream();
  // Some callers supply a fixed range (e.g. a prebuilt ports-map seam); in that case
  // re-pick the upstream instead of silently changing their map's configured range.
  for (
    let attempt = 0;
    overrides.config && up.port >= overrides.config.portRange[0] - 1 && up.port <= overrides.config.portRange[1] + 1;
    attempt++
  ) {
    await up.close();
    if (attempt >= 63) throw new Error("no disjoint test upstream port");
    up = await proxyUpstream();
  }
  let range: [number, number];
  try {
    range = overrides.config?.portRange ?? (await freeRange([up.port]));
  } catch (err) {
    await up.close();
    throw err;
  }
  const dir = await mkdtemp(join(tmpdir(), "pwh-proxy-engine-"));
  const servers: Server[] = [];
  const clients = new Set<Socket>();
  const accepted = new Set<Socket>();
  const logs: unknown[] = [];
  let service: ProxyService;
  try {
    service = await createProxyService({
      clientAllow: undefined,
      config: { maxProxies: 8, portRange: range },
      stateDir: dir,
      hubPort: 1,
      lan: false,
      lanHostSnapshot: () => undefined,
      log: { info: (...args) => logs.push(args) },
      ...overrides,
      listen: async (server, port, host) => {
        servers.push(server);
        server.on("connection", (s) => {
          accepted.add(s);
          s.on("close", () => accepted.delete(s));
        });
        await (overrides.listen ?? listen)(server, port, host);
      },
    });
  } catch (err) {
    await up.close();
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const http = (
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string; path?: string } = {},
  ) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        {
          host: "127.0.0.1",
          port: Number(u.port),
          path: opts.path ?? u.pathname + u.search,
          method: opts.method ?? "GET",
          headers: { Host: u.host, ...opts.headers },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (b) => chunks.push(b));
          res.on("error", reject);
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("socket", (s) => track(s));
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("test http timeout")));
      req.end(opts.body);
    });
  const track = (s: Socket) => {
    clients.add(s);
    s.unref();
    s.on("error", () => {});
    s.on("close", () => clients.delete(s));
  };
  const raw = async (port: number) => {
    const socket = connect(port, "127.0.0.1");
    track(socket);
    await once(socket, "connect");
    return socket;
  };
  const open = async (
    target = `127.0.0.1:${up.port}`,
    id = identity(1, overrides.now?.() ?? Date.now()),
    browserHost = "127.0.0.1",
  ) => {
    const result = await service.open(id, target, browserHost, service.currentSeq());
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.result;
  };
  const enter = async (opened: ProxyOpenResult) => {
    const res = await http(opened.enterUrl);
    if (res.status !== 303) throw new Error(`enter ${res.status} ${res.body}`);
    return { cookie: res.headers["set-cookie"]![0]!.split(";")[0]!, res };
  };
  const ws = async (
    opened: ProxyOpenResult,
    cookie: string,
    opts: { origin?: string | null; upgrade?: string; path?: string; head?: Buffer } = {},
  ) => {
    const socket = await raw(Number(new URL(opened.origin).port));
    const chunks: Buffer[] = [];
    let resolveHead!: () => void;
    const header = new Promise<void>((resolve) => {
      resolveHead = resolve;
    });
    const onData = (b: Buffer) => {
      chunks.push(b);
      if (Buffer.concat(chunks).includes("\r\n\r\n")) resolveHead();
    };
    socket.on("data", onData);
    socket.write(
      `GET ${opts.path ?? "/ws"} HTTP/1.1\r\nHost: ${new URL(opened.origin).host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: ${opts.upgrade ?? "websocket"}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${opts.origin === null ? "" : `Origin: ${opts.origin ?? opened.origin}\r\n`}\r\n`,
    );
    if (opts.head) socket.write(opts.head);
    await Promise.race([header, once(socket, "close").then(() => {})]);
    return { socket, chunks, text: () => Buffer.concat(chunks).toString(), off: () => socket.off("data", onData) };
  };
  return {
    service,
    up,
    dir,
    range,
    servers,
    clients,
    accepted,
    logs,
    http,
    raw,
    open,
    enter,
    ws,
    async close() {
      for (const s of clients) s.destroy();
      await service.dispose();
      await up.close();
      await waitFor(() => clients.size === 0 && servers.every((s) => !s.listening));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
