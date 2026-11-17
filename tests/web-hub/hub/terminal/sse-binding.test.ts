import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { constants, gunzipSync, type Gzip } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleTerminal } from "../../../../src/web-hub/hub/assembly-terminal.js";
import type { HubAssembly } from "../../../../src/web-hub/hub/assembly.js";
import { createPrivacyStore } from "../../../../src/web-hub/hub/privacy/store.js";
import { TERMINAL_LOCAL_DIR } from "../../../../src/web-hub/protocol/terminal-local.js";
import { TERMINAL_UI_CAP } from "../../../../src/web-hub/protocol/version.js";
import { config, memLog, tmpDirs } from "../helpers.js";
import type { AuthIdentity } from "../../../../src/web-hub/hub/auth-identity.js";
import { createSseHub, formatSseFrame } from "../../../../src/web-hub/hub/sse.js";
import { TerminalRevocationFence } from "../../../../src/web-hub/hub/terminal/revocation-fence.js";
import { TerminalSseBindings } from "../../../../src/web-hub/hub/terminal/sse-binding.js";

class Response extends Writable {
  chunks: Buffer[] = [];
  headers: Record<string, string> = {};
  status = 0;
  stalled = false;
  release: (() => void) | undefined;
  constructor() {
    super({ highWaterMark: 16 });
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    if (this.stalled) this.release = cb;
    else cb();
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(encoding: "identity" | "gzip") {
  let now = 0;
  const hub = createSseHub({ now: () => now });
  const fence = new TerminalRevocationFence(() => now);
  const bindings = new TerminalSseBindings(fence, () => now);
  const identity: AuthIdentity = {
    listener: "loopback",
    principal: "test",
    sidTag: "sid",
    parentExpiresAt: 60_000,
  };
  expect(fence.loginComplete(identity, 1, 0)).toBe(true);
  function attach(lastEventId?: number) {
    const req = Object.assign(new EventEmitter(), {
      headers: { "accept-encoding": encoding },
      socket: { setNoDelay() {} },
    }) as unknown as IncomingMessage;
    const res = new Response();
    let compressor: Gzip | undefined;
    res.once("pipe", (src: Gzip) => (compressor = src));
    const client = hub.attach(req, res as unknown as ServerResponse, lastEventId);
    function text(complete = false) {
      const bytes = Buffer.concat(res.chunks);
      return (
        encoding === "gzip" ? gunzipSync(bytes, complete ? {} : { finishFlush: constants.Z_SYNC_FLUSH }) : bytes
      ).toString("utf8");
    }
    function frames() {
      const body = text();
      expect(body.endsWith("\n\n")).toBe(true);
      return body
        .slice(0, -2)
        .split("\n\n")
        .map((frame) => {
          const lines = frame.split("\n");
          const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
          expect(event).toBeDefined();
          expect(data).toBeDefined();
          return { event, data: JSON.parse(data!), id: lines.find((line) => line.startsWith("id: ")) };
        });
    }
    return { req, res, client, text, frames, compressor: () => compressor };
  }
  const conn = attach();
  function connect() {
    const binding = bindings.connect(
      conn.req,
      conn.res as unknown as ServerResponse,
      identity,
      conn.client.id,
      "http://localhost",
      conn.client.output,
    )!;
    expect(binding.metadata.live).toBe(true);
    expect(
      bindings.resolve(identity, {
        clientId: conn.client.id,
        connectionInstance: binding.metadata.connectionInstance,
        connectionToken: binding.metadata.connectionToken,
      }),
    ).toBe(binding);
    return binding;
  }
  cleanups.push(() => {
    bindings.dispose();
    hub.closeAll();
    fence.dispose();
  });
  return { ...conn, hub, bindings, fence, identity, connect, attach, expire: () => (now = 60_000) };
}

async function until(assertion: () => void) {
  await vi.waitFor(assertion, { interval: 5, timeout: 1_000 });
}

describe.each(["identity", "gzip"] as const)("private terminal SSE through %s output", (encoding) => {
  it.each(["local-unavailable", "privacy-missing", "privacy-degraded"])(
    "keeps public SSE and client alive for early %s without a private binding",
    async (reason) => {
      const tmp = tmpDirs();
      cleanups.push(() => tmp.cleanup());
      const stateDir = tmp.make("terminal-sse-");
      if (reason === "local-unavailable") mkdirSync(join(stateDir, TERMINAL_LOCAL_DIR), { mode: 0o700 });
      if (reason === "privacy-degraded") writeFileSync(join(stateDir, "privacy.json"), "corrupt", { mode: 0o600 });
      const privacy = createPrivacyStore({ stateDir });
      await privacy.load();
      expect(privacy.degraded).toBe(reason === "privacy-degraded");
      // Only the assembly's terminal dependencies are needed; no frontend/agent/backend is created.
      const ctx = {
        config: config({
          terminal: {
            maxPerSession: 2,
            maxPerPrincipal: 2,
            maxTotal: 8,
            inputIdleMs: 3600000,
            maxLifetimeMs: 28800000,
          },
        }),
        now: () => 0,
        paths: { stateDir },
        log: memLog(),
        startup: new AbortController(),
        cleanup: [],
        privacyStore: reason === "privacy-missing" ? undefined : privacy,
      } as unknown as HubAssembly;
      const terminal = (await assembleTerminal(ctx))!;
      cleanups.push(() => terminal.dispose());
      expect(terminal.status.state).toBe(reason === "local-unavailable" ? "unavailable" : "ready");
      const f = setup(encoding);
      const abort = vi.spyOn(f.client.output, "abort");
      const finish = vi.spyOn(f.client.output, "finish");
      const connect = vi.spyOn(terminal.service.bindings, "connect");
      const capability = { caps: [TERMINAL_UI_CAP] };
      f.client.send("hub", capability);
      f.client.send("agents", { agents: [] });
      terminal.routes.openSse(
        f.req,
        f.res as unknown as ServerResponse,
        f.identity,
        f.client.id,
        "http://localhost",
        f.client.output,
      );
      expect(finish).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(f.hub.count()).toBe(1);
      expect(f.client.send("ping", { late: true })).toBe(true);
      await until(() => expect(f.frames().at(-1)?.event).toBe("ping"));
      expect(f.res.writableFinished).toBe(false);
      expect(f.res.status).toBe(200);
      expect(f.res.headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
      expect(f.res.headers["Content-Encoding"]).toBe(encoding === "gzip" ? "gzip" : undefined);
      expect(f.text()).toBe(
        formatSseFrame("hello", { clientId: f.client.id }) +
          formatSseFrame("hub", capability) +
          formatSseFrame("agents", { agents: [] }) +
          formatSseFrame("ping", { late: true }),
      );
      expect(f.frames().map((frame) => frame.event)).toEqual(["hello", "hub", "agents", "ping"]);
    },
  );

  it("interleaves public/private frames in one encoder FIFO, flushes private frames while open, never replays them", async () => {
    const f = setup(encoding);
    f.client.send("hub", { phase: "before" });
    const binding = f.connect(); // terminal_connection must follow hello + hub, even during async gzip
    f.client.send("agents", { agents: [] });
    expect(binding.send("terminal", { bytesB64: "5Lit5paHCg==" })).toBe(true);
    f.hub.publish("status", { phase: "after" });
    await until(() => {
      expect(f.frames().map((frame) => frame.event)).toEqual([
        "hello",
        "hub",
        "terminal_connection",
        "agents",
        "terminal",
        "status",
      ]);
    });
    expect(f.res.headers["Content-Encoding"]).toBe(encoding === "gzip" ? "gzip" : undefined);
    const connection = {
      connectionInstance: binding.metadata.connectionInstance,
      connectionToken: binding.metadata.connectionToken,
      expiresAt: binding.metadata.parentExpiresAt,
    };
    const expected =
      formatSseFrame("hello", { clientId: f.client.id }) +
      formatSseFrame("hub", { phase: "before" }) +
      formatSseFrame("terminal_connection", connection) +
      formatSseFrame("agents", { agents: [] }) +
      formatSseFrame("terminal", { bytesB64: "5Lit5paHCg==" }) +
      formatSseFrame("status", { phase: "after" }, 1);
    expect(f.text()).toBe(expected);
    expect(
      f
        .frames()
        .filter((frame) => frame.id !== undefined)
        .map((frame) => frame.event),
    ).toEqual(["status"]);
    // No later public frame, ping or end can be responsible for making this private frame visible.
    expect(binding.send("terminal", { text: "private flush 中文" })).toBe(true);
    await until(() =>
      expect(f.frames().at(-1)).toEqual({ event: "terminal", data: { text: "private flush 中文" }, id: undefined }),
    );
    expect(f.res.writableEnded).toBe(false);
    const finalText = expected + formatSseFrame("terminal", { text: "private flush 中文" });
    const finished = new Promise<void>((resolve) => f.res.once("finish", resolve));
    f.client.close();
    await finished;
    expect(f.text(true)).toBe(finalText); // verify the gzip trailer too, not just a tolerant partial decode
    const replay = f.attach(0);
    await until(() => expect(replay.frames().map((frame) => frame.event)).toEqual(["hello", "status"]));
    expect(replay.text()).not.toContain(connection.connectionToken);
  });

  it("queues private frames behind socket backpressure and resumes in order on drain", async () => {
    const f = setup(encoding);
    const binding = f.connect();
    await until(() => expect(f.frames()).toHaveLength(2));
    const prefix = f.text();
    const chunks = f.res.chunks.length;
    f.res.stalled = true;
    f.client.send("hub", { phase: "blocked" });
    expect(binding.send("terminal", { text: "after drain" })).toBe(true);
    f.client.send("agents", { agents: [] });
    await until(() => expect(f.res.chunks.length).toBe(chunks + 1));
    expect(f.res.writableNeedDrain).toBe(true);
    f.res.stalled = false;
    f.res.release!();
    await until(() =>
      expect(f.text()).toBe(
        prefix +
          formatSseFrame("hub", { phase: "blocked" }) +
          formatSseFrame("terminal", { text: "after drain" }) +
          formatSseFrame("agents", { agents: [] }),
      ),
    );
    expect(binding.metadata.live).toBe(true);
  });

  it("counts queued/compressor input as pressure, revokes and discards frames not yet written", async () => {
    const f = setup(encoding);
    const binding = f.connect();
    await until(() => expect(f.frames()).toHaveLength(2));
    f.res.stalled = true;
    f.client.send("history", { text: "x".repeat(96 * 1024) });
    expect(f.client.output.pendingBytes()).toBeGreaterThan(65_536);
    // In gzip mode the large input is still in the encoder, not response.writableLength.
    if (encoding === "gzip") expect(f.res.writableLength).toBe(0);
    expect(binding.send("terminal", { text: "must not escape" })).toBe(false);
    expect(binding.metadata.live).toBe(false);
    expect(f.res.destroyed).toBe(true);
    const bytes = Buffer.concat(f.res.chunks);
    await until(() => expect(f.hub.count()).toBe(0));
    expect(Buffer.concat(f.res.chunks)).toEqual(bytes);
    expect(f.client.output.send(formatSseFrame("terminal", { text: "late" }))).toBe(false);
  });

  it("revocation drops accepted private frames waiting behind another frame", async () => {
    const f = setup(encoding);
    const binding = f.connect();
    await until(() => expect(f.frames()).toHaveLength(2));
    f.res.stalled = true;
    f.client.send("hub", { phase: "blocked" });
    expect(binding.send("terminal", { text: "queued secret" })).toBe(true);
    const bytes = Buffer.concat(f.res.chunks);
    const abort = vi.spyOn(f.client.output, "abort");
    const finish = vi.spyOn(f.client.output, "finish");
    f.fence.revoke({ sidTag: f.identity.sidTag });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    expect(f.res.writableFinished).toBe(false);
    expect(binding.metadata.live).toBe(false); // fence/binding denial is synchronous
    expect(f.res.destroyed).toBe(true);
    await until(() => expect(f.res.closed).toBe(true));
    f.res.stalled = false;
    f.res.release?.();
    expect(Buffer.concat(f.res.chunks)).toEqual(bytes);
    expect(f.hub.count()).toBe(0);
    expect(binding.send("terminal", { text: "late secret" })).toBe(false);
  });

  const stops = ["revoke", "close", "disconnect", "error", "expiry", ...(encoding === "gzip" ? ["encoder-error"] : [])];
  it.each(stops)("rejects writes and releases binding after %s", async (stop) => {
    const f = setup(encoding);
    const binding = f.connect();
    const onRevoke = vi.fn();
    binding.onRevoke(onRevoke);
    await until(() => expect(f.frames()).toHaveLength(2));
    if (stop === "revoke") f.fence.revoke({ sidTag: f.identity.sidTag });
    else if (stop === "close") f.client.close();
    else if (stop === "disconnect") f.res.destroy();
    else if (stop === "error") f.res.destroy(new Error("socket failure"));
    else if (stop === "encoder-error") f.compressor()!.destroy(new Error("encoder failure"));
    else {
      f.expire();
      expect(binding.send("terminal", { text: "expired" })).toBe(false);
    }
    await until(() => {
      expect(binding.metadata.live).toBe(false);
      expect(f.hub.count()).toBe(0);
    });
    const bytes = Buffer.concat(f.res.chunks);
    expect(binding.send("terminal", { text: "late private" })).toBe(false);
    expect(binding.send("terminal_connection", { text: "late token" })).toBe(false);
    expect(f.client.send("hub", { text: "late public" })).toBe(false);
    expect(f.client.output.send(formatSseFrame("terminal", { text: "late raw" }))).toBe(false);
    expect(Buffer.concat(f.res.chunks)).toEqual(bytes);
    expect(binding.active).toBe(false);
    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(() =>
      f.bindings.resolve(f.identity, {
        clientId: f.client.id,
        connectionInstance: binding.metadata.connectionInstance,
        connectionToken: binding.metadata.connectionToken,
      }),
    ).toThrow("E_AUTH");
  });
});
