import { expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { engine, identity, listen, waitFor } from "./engine-helpers.js";
import { createProxyAdmission, createProxyForwarder } from "../../../../src/web-hub/hub/proxy/forward.js";
import { resolveProxyTarget } from "../../../../src/web-hub/hub/proxy/dns-gate.js";
import { createProxySessionStore } from "../../../../src/web-hub/hub/proxy/sessions.js";
import { sendProxyResponse } from "../../../../src/web-hub/hub/proxy/listener.js";

it("T-H4: real FIFO handoffs never enter http.Agent.requests, including ClientRequest.close-before-free ordering", async () => {
  const env = await engine();
  const sessions = createProxySessionStore({ now: Date.now });
  const mint = sessions.mintCode(0, identity(), { instanceId: "test-agent", origin: "http://local", nextPath: "/" });
  if (!mint.ok) throw new Error("mint failed");
  const exchange = sessions.exchange(mint.code, "test-agent", "http://local");
  if (!exchange.ok) throw new Error("exchange failed");
  const pinned = await resolveProxyTarget(
    `127.0.0.1:${env.up.port}`,
    {
      inflight: false,
      resolve: async () => {
        throw new Error("literal must not lookup");
      },
    },
    { hubPort: 1, proxyRange: env.range, localAddresses: [] },
  );
  if (!pinned.ok) throw new Error("pin failed");
  const traffic = { reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 };
  const admission = createProxyAdmission();
  const forward = createProxyForwarder({
    instanceId: "test-agent",
    pinned: pinned.pinned,
    sessions,
    sessionTraffic: () => traffic,
    admission,
    traffic,
    reply: sendProxyResponse,
    now: Date.now,
  });
  let maxAgentQueued = 0;
  // Instrument, do not stub: every request still runs the real Agent implementation.
  const agent = forward.agent as typeof forward.agent & { addRequest(...args: unknown[]): void };
  const realAdd = agent.addRequest;
  agent.addRequest = function (...args) {
    realAdd.apply(this, args);
    maxAgentQueued = Math.max(
      maxAgentQueued,
      Object.values(this.requests).reduce((n, a) => n + (a?.length ?? 0), 0),
    );
  };
  const server = createServer((req, res) =>
    forward.handle(req, res, {
      origin: "http://local",
      browserHost: "local",
      session: exchange.rec,
      traffic: { reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 },
    }),
  );
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.unref();
    s.on("close", () => sockets.delete(s));
  });
  let client: Socket | undefined;
  try {
    await listen(server, 0, "127.0.0.1");
    const port = (server.address() as { port: number }).port;
    client = await env.raw(port);
    let responses = 0;
    client.on("data", (b) => {
      responses += (b.toString().match(/HTTP\/1.1 200/g) ?? []).length;
    });
    client.write(Array.from({ length: 96 }, (_, i) => `GET /echo${i} HTTP/1.1\r\nHost: local\r\n\r\n`).join(""));
    await waitFor(() => responses === 96 && admission.stats().active === 0);
    expect(env.up.requests).toHaveLength(96);
    expect(maxAgentQueued).toBe(0);
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
    expect(Object.values(forward.agent.sockets).flat().length).toBeLessThanOrEqual(32);
    expect(Object.values(forward.agent.freeSockets).flat().length).toBeLessThanOrEqual(4);
  } finally {
    client?.destroy();
    forward.close();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await closed;
    await env.close();
  }
});
