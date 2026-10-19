import { Agent, request } from "node:http";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createLanTransport } from "../../../src/web-hub/hub/http.js";
import { createConnGuard } from "../../../src/web-hub/hub/conn-guard.js";
import { createClientAllowGuard } from "../../../src/web-hub/hub/client-allow.js";
import type { HostSnapshot } from "../../../src/web-hub/hub/ports.js";
import { captureLog } from "./helpers.js";

function snapshot(proxy = false): HostSnapshot {
  return {
    gen: 1,
    computedAt: 0,
    omitted: [],
    hostKeys: new Set(["127.0.0.1:80"]),
    externalOrigins: new Set(["https://hub.example"]),
    trustProxyFrom: new Set(proxy ? ["127.0.0.1"] : []),
  };
}

describe("LAN allowlist transport integration (I1)", () => {
  it("denied direct TCP client receives no bytes and never takes a connection lease", async () => {
    const guard = createClientAllowGuard({ entries: [], implicitLoopback: false });
    const connGuard = createConnGuard();
    const admit = vi.spyOn(connGuard, "admit");
    const handleRequest = vi.fn();
    const handle = await createLanTransport({
      clientAllow: guard.forListener("lan"),
      connGuard,
      log: captureLog(),
      handleRequest,
    }).bind(0, snapshot(), new AbortController().signal);
    try {
      const bytes = await new Promise<number>((resolve, reject) => {
        const socket = connect(handle.port, "127.0.0.1");
        let n = 0;
        socket.setTimeout(1000, () => socket.destroy(new Error("deny did not close")));
        socket.on("data", (b: Buffer) => {
          n += b.length;
        });
        socket.on("error", (e: NodeJS.ErrnoException) => {
          if (e.code !== "ECONNRESET") reject(e);
        });
        socket.on("close", () => resolve(n));
      });
      expect(bytes).toBe(0);
      expect(admit).not.toHaveBeenCalled();
      expect(handleRequest).not.toHaveBeenCalled();
      expect(guard.snapshot().denied?.total).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("judges allowed → denied → missing XFF independently on ONE trusted-proxy keepalive socket", async () => {
    const guard = createClientAllowGuard({ entries: ["192.0.2.0/24"] });
    const contexts: unknown[] = [];
    const admit = vi.spyOn(createConnGuard(), "admit");
    const handle = await createLanTransport({
      clientAllow: guard.forListener("lan"),
      connGuard: { admit },
      log: captureLog(),
      async handleRequest(_req, res, ctx) {
        contexts.push(ctx);
        res.end("allowed");
      },
    }).bind(0, snapshot(true), new AbortController().signal);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const sockets: unknown[] = [];
    const get = (xff?: string): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: handle.port,
            agent,
            headers: {
              Host: "proxy.local",
              "X-Forwarded-Proto": "https",
              "X-Forwarded-Host": "hub.example",
              ...(xff === undefined ? {} : { "X-Forwarded-For": xff }),
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (b: string) => {
              text += b;
            });
            res.on("end", () => resolve({ status: res.statusCode!, text }));
          },
        );
        req.on("socket", (s) => sockets.push(s));
        req.setTimeout(1000, () => req.destroy(new Error("request timeout")));
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await get("192.0.2.5")).toEqual({ status: 200, text: "allowed" });
      expect(await get("198.51.100.1")).toMatchObject({ status: 403 });
      const missing = await get();
      expect(missing.status).toBe(403);
      expect(JSON.parse(missing.text)).toEqual({ error: "E_CLIENT" });
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ clientIp: "192.0.2.5", xffUsable: true });
      expect(sockets[0]).toBe(sockets[1]);
      expect(sockets[1]).toBe(sockets[2]);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(guard.snapshot().denied?.total).toBe(2);
    } finally {
      agent.destroy();
      await handle.close();
    }
  });
});
