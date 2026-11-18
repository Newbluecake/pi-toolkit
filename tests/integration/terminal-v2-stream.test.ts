/** Isolated real HTTP + production v2 routes/views + production public SSE encoder.
 * Auth/service are explicit typed doubles: NOT real startHub/SQLite/PTy/auth integration. */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createGunzip } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../src/web-hub/hub/ports.js";
import { createSseHub } from "../../src/web-hub/hub/sse.js";
import { createTerminalRoutesV2, dispatchTerminalV2 } from "../../src/web-hub/hub/terminal/v2/routes.js";
import type { TerminalViewFrameV2 } from "../../src/web-hub/protocol/terminal-v2.js";
import { envelope, fixture, hubInstance } from "../web-hub/hub/terminal/v2/fixture.js";
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function setup() {
  const f = fixture();
  const other = fixture();
  const otherTermId = "o".repeat(24);
  const otherRuntime = { ...other.runtime, termId: otherTermId };
  vi.mocked(f.service.runtime).mockImplementation(async (_id, input) => ({
    ok: true,
    runtime: input.termId === otherTermId ? otherRuntime : f.runtime,
  }));
  const sse = createSseHub({ now: Date.now });
  const routes = createTerminalRoutesV2({
    service: f.service,
    views: f.views,
    auth: f.fence,
    notifications: f.fence,
    hubInstance,
  });
  const errors: unknown[] = [];
  let origin = "";
  const server = createServer((req, res) => {
    if (req.url === "/api/events") {
      sse.attach(req, res, undefined);
      return;
    }
    const ctx: RequestContext = {
      kind: "loopback",
      peerIp: "127.0.0.1",
      clientIp: "127.0.0.1",
      viaTrustedProxy: false,
      scheme: "http",
      hostKey: req.headers.host!,
      externalOrigin: origin,
    };
    void dispatchTerminalV2(
      { routes, auth: f.fence, authenticate: async () => ({ ok: true, identity: f.id }) },
      req,
      res,
      ctx,
      new AbortController().signal,
    ).catch((error: unknown) => {
      errors.push(error);
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  origin = `http://127.0.0.1:${address.port}`;
  const sockets: IncomingMessage[] = [];
  closers.push(async () => {
    for (const response of sockets) response.destroy();
    sse.closeAll();
    await routes.dispose();
    f.dispose();
    other.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    expect(errors).toEqual([]);
  });
  async function http(path: string, input?: unknown, gzip = false): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request(
        origin + path,
        {
          method: input === undefined ? "GET" : "POST",
          agent: false,
          headers: {
            origin,
            "x-pwh": "1",
            "content-type": "application/json",
            ...(gzip ? { "accept-encoding": "gzip" } : {}),
          },
        },
        (res) => {
          sockets.push(res);
          resolve(res);
        },
      );
      req.once("error", reject);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async function json(op: string, input: unknown) {
    const res = await http(`/api/terminal/v2/${op}`, input);
    const buffers: Buffer[] = [];
    for await (const chunk of res) buffers.push(Buffer.from(chunk));
    return {
      status: res.statusCode,
      body: JSON.parse(Buffer.concat(buffers).toString("utf8")) as Record<string, unknown>,
    };
  }
  return { f, other, otherTermId, sse, http, json };
}
function decoder(response: IncomingMessage) {
  const frames: TerminalViewFrameV2[] = [];
  const waiting: Array<{
    predicate: (frame: TerminalViewFrameV2) => boolean;
    resolve: (frame: TerminalViewFrameV2) => void;
  }> = [];
  let partial = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    partial += chunk;
    while (partial.includes("\n")) {
      const end = partial.indexOf("\n");
      const frame = JSON.parse(partial.slice(0, end)) as TerminalViewFrameV2;
      partial = partial.slice(end + 1);
      frames.push(frame);
      for (const item of [...waiting])
        if (item.predicate(frame)) {
          waiting.splice(waiting.indexOf(item), 1);
          item.resolve(frame);
        }
    }
  });
  return {
    frames,
    next(predicate: (frame: TerminalViewFrameV2) => boolean): Promise<TerminalViewFrameV2> {
      const old = frames.find(predicate);
      if (old) return Promise.resolve(old);
      return new Promise((resolve) => {
        waiting.push({ predicate, resolve });
      });
    },
  };
}
describe("terminal-v2-stream real response isolation", () => {
  it.each([false, true])(
    "ACK cutover, unknown query, pressure detach leaves original public SSE/clientId intact (gzip=%s)",
    async (gzip) => {
      const { f, other, otherTermId, sse, http, json } = await setup();
      const publicResponse = await http("/api/events", undefined, gzip);
      const publicText: string[] = [];
      const publicReader = gzip ? publicResponse.pipe(createGunzip()) : publicResponse;
      publicReader.setEncoding("utf8");
      let signalPublic!: () => void;
      const after = new Promise<void>((resolve) => {
        signalPublic = resolve;
      });
      publicReader.on("data", (text: string) => {
        publicText.push(text);
        if (publicText.join("").includes("after-terminal-pressure")) signalPublic();
      });
      const client = sse.list()[0]!;
      expect(sse.count()).toBe(1);
      const slow = await http("/api/terminal/v2/view", envelope, gzip);
      expect(slow.statusCode).toBe(200);
      expect(slow.headers["content-encoding"]).toBe("identity");
      expect(slow.headers["cache-control"]).toBe("no-store");
      const slowDecoder = decoder(slow);
      const attached = await slowDecoder.next((frame) => frame.t === "attached");
      if (attached.t !== "attached") throw new Error("missing attached");
      await slowDecoder.next((frame) => frame.t === "replay-end");
      const writer = { ...envelope, viewId: attached.viewId };
      expect((await json("input", { ...writer, seq: 0, bytesB64: "YQ==", kind: "user" })).body.code).toBe(
        "E_NOT_READY",
      );
      expect((await json("ack", { ...writer, offset: 0, replayComplete: true })).body.ok).toBe(true);
      await slowDecoder.next((frame) => frame.t === "ready");
      expect((await json("input", { ...writer, seq: 1, bytesB64: "YQ==", kind: "user" })).body).toEqual({
        ok: true,
        acceptedThrough: 1,
      });
      expect((await json("input", { ...writer, seq: 1, queryOnly: true })).body).toEqual({
        ok: true,
        acceptedThrough: 1,
      });
      expect((await json("input", { ...writer, seq: 2, queryOnly: true })).body).toEqual({
        ok: false,
        code: "E_INPUT_UNKNOWN",
        effect: "unknown",
      });
      expect(f.runtime.write).toHaveBeenCalledOnce();
      const healthy = await http("/api/terminal/v2/view", { ...envelope, termId: otherTermId }, gzip);
      const healthyDecoder = decoder(healthy);
      const otherAttached = await healthyDecoder.next((frame) => frame.t === "attached");
      if (otherAttached.t !== "attached") throw new Error("missing attached");
      await healthyDecoder.next((frame) => frame.t === "replay-end");
      const otherWriter = { ...envelope, termId: otherTermId, viewId: otherAttached.viewId };
      await json("ack", { ...otherWriter, offset: 0, replayComplete: true });
      await healthyDecoder.next((frame) => frame.t === "ready");
      const closed = new Promise<void>((resolve) => {
        slow.once("close", resolve);
      });
      slow.pause(); // No renderer ACK and no network reader for this response.
      f.append(Buffer.alloc(65_536, 120));
      f.append(Buffer.alloc(8192, 121)); // deterministic raw queue cap; no OS-buffer-size assumptions.
      await closed;
      expect(sse.get(client.id)).toBe(client);
      expect(sse.count()).toBe(1);
      expect((await json("input", { ...writer, seq: 1, queryOnly: true })).body.code).toBe("E_VIEW_CHANGED");
      other.append(Buffer.from("healthy"));
      const output = await healthyDecoder.next((frame) => frame.t === "output");
      expect(output).toMatchObject({ bytesB64: Buffer.from("healthy").toString("base64") });
      expect((await json("ack", { ...otherWriter, offset: 7 })).body.ok).toBe(true);
      client.send("hub", { marker: "after-terminal-pressure" });
      await after;
      expect(publicText.join("")).toContain("event: hello");
      expect(publicText.join("")).not.toMatch(/viewId|attached|replay-end|bytesB64|\/isolated/);
      expect(f.service.create).not.toHaveBeenCalled();
      expect(f.service.close).not.toHaveBeenCalled();
      expect(healthy.destroyed).toBe(false);
      healthy.destroy();
      publicResponse.destroy();
    },
  );
  it("net ACK stalls at 2s even when duplicate ACKs arrive; another response stays writable", async () => {
    const { f, sse, http, json } = await setup();
    const publicResponse = await http("/api/events");
    publicResponse.resume();
    const stream = await http("/api/terminal/v2/view", envelope);
    const d = decoder(stream);
    const attached = await d.next((frame) => frame.t === "attached");
    if (attached.t !== "attached") throw new Error("missing attached");
    await d.next((frame) => frame.t === "replay-end");
    const writer = { ...envelope, viewId: attached.viewId };
    await json("ack", { ...writer, offset: 0, replayComplete: true });
    await d.next((frame) => frame.t === "ready");
    f.append(Buffer.from("unconsumed"));
    await d.next((frame) => frame.t === "output");
    expect((await json("ack", { ...writer, offset: 0 })).body.ok).toBe(true);
    await new Promise<void>((resolve) => stream.once("close", resolve));
    expect(sse.count()).toBe(1);
    expect(publicResponse.destroyed).toBe(false);
    expect(f.service.close).not.toHaveBeenCalled();
  });
});
