import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { constants, gunzipSync, type Gzip } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
// Composition-only test: no singleton/socket is constructed here. Substitute the
// recovery boundary with the REAL read-only initializer, not a usable-store stub.
// Ownership/retirement is separately exercised through real startHub in tier2.
vi.mock("../../../../src/web-hub/hub/terminal/authority-recovery.js", async () => {
  const { initializeTerminalStore } = await import("../../../../src/web-hub/protocol/terminal-local.js");
  return {
    prepareTerminalStore: (ctx: { paths: { stateDir: string } }) => initializeTerminalStore(ctx.paths.stateDir),
  };
});
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
  vi.useRealTimers();
});

function setup(encoding: "identity" | "gzip", audit = vi.fn()) {
  let now = 0;
  const hub = createSseHub({ now: () => now });
  const fence = new TerminalRevocationFence(() => now);
  const bindings = new TerminalSseBindings(fence, () => now, audit);
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
      if (bytes.length === 0) return "";
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
  async function connect(unavailable = vi.fn()) {
    bindings.connect(
      conn.req,
      conn.res as unknown as ServerResponse,
      identity,
      conn.client.id,
      "http://localhost",
      conn.client.output,
      unavailable,
    );
    await until(() => expect(conn.frames().some((f) => f.event === "terminal_connection")).toBe(true));
    const connection = conn.frames().find((f) => f.event === "terminal_connection")!.data;
    const binding = bindings.resolve(identity, { clientId: conn.client.id, ...connection });
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
  return {
    ...conn,
    hub,
    bindings,
    fence,
    identity,
    connect,
    attach,
    advance: (ms: number) => (now += ms),
    expire: () => (now = 60_000),
  };
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
        deps: {},
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

  it("defers the first private capability until a large public bootstrap actually drains", async () => {
    const audit = vi.fn();
    const f = setup(encoding, audit);
    f.res.stalled = true;
    f.client.send("fleet", { text: "x".repeat(96 * 1024) });
    expect(f.client.output.pendingBytes()).toBeGreaterThan(65_536);
    const abort = vi.spyOn(f.client.output, "abort");
    const unavailable = vi.fn();
    expect(
      f.bindings.connect(
        f.req,
        f.res as unknown as ServerResponse,
        f.identity,
        f.client.id,
        "http://localhost",
        f.client.output,
        unavailable,
      ),
    ).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
    expect(f.text()).not.toContain("terminal_connection");
    f.res.stalled = false;
    // gzip may still be processing hello; releasing an identity write is synchronous.
    f.res.release?.();
    await until(() => expect(f.frames().at(-1)?.event).toBe("terminal_connection"));
    expect(f.frames().map((frame) => frame.event)).toEqual(["hello", "fleet", "terminal_connection"]);
    const connection = f.frames().at(-1)!.data;
    const binding = f.bindings.resolve(f.identity, { clientId: f.client.id, ...connection });
    expect(binding.active).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(audit.mock.calls[0]![0]).toEqual({
      op: "sse",
      listener: "loopback",
      ok: false,
      code: "E_SSE_BOOTSTRAP",
      phase: "admission",
      encoding,
      pending: expect.any(Number),
    });
    expect(binding.send("terminal", { text: "after admission" })).toBe(true);
    await until(() => expect(f.frames().at(-1)?.data).toEqual({ text: "after admission" }));
    // Once private capability exists the original synchronous pressure abort is unchanged.
    f.res.stalled = true;
    for (let i = 0; i < 5; i++) expect(binding.send("terminal", { text: "p".repeat(20_000) })).toBe(i < 4);
    expect(binding.metadata.live).toBe(false);
    expect(f.res.destroyed).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("abandons admission after 2s without aborting public SSE, minting a token or admitting after late drain", async () => {
    const f = setup(encoding);
    // Do not let native gzip run before the deterministic admission deadline assertion.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.res.stalled = true;
    f.client.send("fleet", { text: "x".repeat(96 * 1024) });
    const abort = vi.spyOn(f.client.output, "abort");
    const unavailable = vi.fn();
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    expect(
      f.bindings.connect(
        f.req,
        f.res as unknown as ServerResponse,
        f.identity,
        f.client.id,
        "http://localhost",
        f.client.output,
        unavailable,
      ),
    ).toBeUndefined();
    expect((timeouts.mock.results.at(-1)!.value as NodeJS.Timeout).hasRef()).toBe(false);
    f.advance(2000);
    vi.advanceTimersByTime(2000);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(f.res.destroyed).toBe(false);
    expect(f.hub.get(f.client.id)).toBe(f.client);
    vi.useRealTimers();
    timeouts.mockRestore();
    f.res.stalled = false;
    f.res.release?.();
    f.client.send("ping", { afterDeadline: true });
    await until(() => expect(f.frames().at(-1)?.event).toBe("ping"));
    expect(f.text()).not.toMatch(/connectionToken|terminal_connection/);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(f.res.destroyed).toBe(false);
  });

  it.each(["fence", "close", "dispose"])(
    "cancels pending admission on %s without a late capability",
    async (reason) => {
      const f = setup(encoding);
      f.res.stalled = true;
      f.client.send("fleet", { text: "x".repeat(96 * 1024) });
      const unavailable = vi.fn();
      expect(
        f.bindings.connect(
          f.req,
          f.res as unknown as ServerResponse,
          f.identity,
          f.client.id,
          "http://localhost",
          f.client.output,
          unavailable,
        ),
      ).toBeUndefined();
      if (reason === "fence") f.fence.revoke("all");
      else if (reason === "close") f.res.destroy();
      else f.bindings.dispose();
      f.res.stalled = false;
      f.res.release?.();
      if (reason !== "close") {
        expect(f.client.send("ping", { afterCancel: true })).toBe(true);
        await until(() => expect(f.frames().at(-1)?.event).toBe("ping"));
        expect(f.res.destroyed).toBe(false);
      }
      expect(f.text()).not.toMatch(/connectionToken|terminal_connection/);
      expect(unavailable).not.toHaveBeenCalled();
    },
  );

  it("bounds body-free diagnostics to eight per second across bindings", async () => {
    const audit = vi.fn();
    const f = setup(encoding, audit);
    for (let i = 0; i < 12; i++) {
      const conn = f.attach();
      f.bindings.connect(
        conn.req,
        conn.res as unknown as ServerResponse,
        f.identity,
        conn.client.id,
        "http://localhost",
        conn.client.output,
      );
      await until(() => expect(conn.frames().at(-1)?.event).toBe("terminal_connection"));
      const connection = conn.frames().at(-1)!.data;
      f.bindings.resolve(f.identity, { clientId: conn.client.id, ...connection }).revoke();
    }
    expect(audit).toHaveBeenCalledTimes(8);
    for (const [record] of audit.mock.calls) {
      expect(record).toEqual({
        op: "sse",
        listener: "loopback",
        ok: false,
        code: "E_SSE_REVOKED",
        phase: "bound",
        encoding,
        pending: expect.any(Number),
      });
    }
  });

  it("interleaves public/private frames in one encoder FIFO, flushes private frames while open, never replays them", async () => {
    const f = setup(encoding);
    f.client.send("hub", { phase: "before" });
    const binding = await f.connect(); // terminal_connection must follow hello + hub, even during async gzip
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
    const binding = await f.connect();
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

  it("rejects private send on public-only pressure without aborting public SSE; refresh re-admits", async () => {
    const f = setup(encoding);
    const unavailable = vi.fn();
    const binding = await f.connect(unavailable);
    await until(() => expect(f.client.output.pendingBytes()).toBe(0));
    const prefix = f.text();
    const abort = vi.spyOn(f.client.output, "abort");
    f.res.stalled = true;
    const payload = { text: "x".repeat(96 * 1024) };
    f.client.send("history", payload);
    expect(f.client.output.pendingBytes()).toBeGreaterThan(65_536);
    expect(binding.send("terminal", { text: "must not escape" })).toBe(false);
    expect(binding.metadata.live).toBe(false);
    expect(binding.active).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(f.res.destroyed).toBe(false);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledWith("sse-public-pressure");
    expect(() =>
      f.bindings.resolve(f.identity, {
        clientId: f.client.id,
        connectionInstance: binding.metadata.connectionInstance,
        connectionToken: binding.metadata.connectionToken,
      }),
    ).toThrow("E_AUTH");
    // Nor can the revoked handle write after the negative hint.
    expect(binding.send("terminal", { text: "late secret" })).toBe(false);
    f.res.stalled = false;
    f.res.release?.();
    expect(f.client.send("ping", { alive: true })).toBe(true);
    await until(() => expect(f.client.output.pendingBytes()).toBe(0));
    expect(f.text()).toBe(prefix + formatSseFrame("history", payload) + formatSseFrame("ping", { alive: true }));
    expect(f.hub.get(f.client.id)).toBe(f.client);
    const refreshed = f.attach();
    f.bindings.connect(
      refreshed.req,
      refreshed.res as unknown as ServerResponse,
      f.identity,
      refreshed.client.id,
      "http://localhost",
      refreshed.client.output,
    );
    await until(() => expect(refreshed.frames().at(-1)?.event).toBe("terminal_connection"));
    const next = f.bindings.resolve(f.identity, { clientId: refreshed.client.id, ...refreshed.frames().at(-1)!.data });
    expect(next.send("terminal", { text: "recovered" })).toBe(true);
    await until(() => expect(refreshed.frames().at(-1)?.data).toEqual({ text: "recovered" }));
    expect(f.res.destroyed).toBe(false);
  });

  it("synchronously aborts pressure with private bytes still in flight, even mixed with public frames", async () => {
    const f = setup(encoding);
    const binding = await f.connect();
    await until(() => expect(f.client.output.pendingBytes()).toBe(0));
    f.res.stalled = true;
    expect(binding.send("terminal", { text: "in-flight private" })).toBe(true);
    f.client.send("history", { text: "x".repeat(96 * 1024) });
    expect(f.client.output.pendingBytes()).toBeGreaterThan(65_536);
    const abort = vi.spyOn(f.client.output, "abort");
    expect(binding.send("terminal", { text: "must not escape" })).toBe(false);
    expect(binding.metadata.live).toBe(false);
    expect(f.res.destroyed).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    const bytes = Buffer.concat(f.res.chunks);
    await until(() => expect(f.hub.count()).toBe(0));
    expect(Buffer.concat(f.res.chunks)).toEqual(bytes);
    expect(f.client.output.send(formatSseFrame("terminal", { text: "late" }))).toBe(false);
  });

  it("revocation drops accepted private frames waiting behind another frame", async () => {
    const f = setup(encoding);
    const binding = await f.connect();
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
    const binding = await f.connect();
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
