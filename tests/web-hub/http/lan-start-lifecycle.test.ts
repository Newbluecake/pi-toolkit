/**
 * `LanFacade.start()`/`close()` lifecycle (plan §1.4.2 / §3, W3 branch-acceptance item 1):
 * `LAN_START_DEADLINE_MS`, self-cleaning a bind attempt that never resolves, and the
 * `start()`∥`close()` race (§1.4 "close 与 start 并发") — `hub/http.ts` self-hosts this lifecycle
 * (§15.8's documented deviation), so it is exercised here directly against the real
 * `createHttpFrontend` LAN facade rather than a `lan-controller.ts` that was never built.
 *
 * Item 3's diagnostics fix (a real `listen()` failure must be reported as `off/listen-failed`,
 * never mislabeled `off/timeout`) is covered here too, since it's the same code path.
 */
import { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAN_START_DEADLINE_MS } from "../../../src/web-hub/hub/http.js";
import { lanRequest, startLan, type LanHarness } from "./lan-helpers.js";

/** Binds a plain TCP server on `port` so a subsequent LAN `start()` hits a real EADDRINUSE. */
async function occupyPort(port: number): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(port, "0.0.0.0", () => {
      resolve({ close: () => new Promise<void>((res) => srv.close(() => res())) });
    });
  });
}

/** Confirms the port is genuinely free (not just that our own facade thinks so) by binding a
 * throwaway plain server to it and releasing it again. */
async function assertPortIsFree(port: number): Promise<void> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "0.0.0.0", () => resolve());
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

const harnesses: LanHarness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe("LanFacade.start() deadline (plan §1.4/§3, LAN_START_DEADLINE_MS)", () => {
  it("resolves off/timeout (never hangs, never rejects) when the underlying bind never calls back; a later retry binds normally", async () => {
    const h = await startLan({ autoStart: false });
    harnesses.push(h);

    const listenSpy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
      // Simulate a bind() that never settles (adversarial fs/network stall) — never invoke the
      // real listen, never fire 'listening' or 'error'.
      return this;
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const startPromise = h.fe.lan!.start();
      await vi.advanceTimersByTimeAsync(LAN_START_DEADLINE_MS);
      const status = await startPromise;
      expect(status).toEqual({ state: "off", reason: "timeout" });
      expect(h.fe.lan!.status()).toEqual({ state: "off", reason: "timeout" });
    } finally {
      vi.useRealTimers();
      listenSpy.mockRestore();
    }

    // A timeout doesn't `close()` the facade — a fresh start() is allowed and, with the real
    // `listen()` restored, binds for real.
    const status2 = await h.fe.lan!.start();
    expect(status2.state).toBe("on");
  });
});

describe("LanFacade.start() diagnostics (plan §9.2/§9.3, W3 acceptance item 3)", () => {
  it("a real port conflict is reported as off/listen-failed with the errno as detail — never off/timeout — and loopback keeps working", async () => {
    const h = await startLan({ autoStart: false });
    harnesses.push(h);
    const occupied = await occupyPort(h.cfg.port);
    try {
      const status = await h.fe.lan!.start();
      expect(status.state).toBe("off");
      if (status.state === "off") {
        expect(status.reason).toBe("listen-failed");
        expect(status.detail).toMatch(/EADDRINUSE/);
      }
      expect(h.fe.lan!.status()).toEqual(status);

      // loopback (the main HTTP listener) is a completely separate `Server` — a LAN bind
      // failure must never take it down.
      const { port: loopbackPort } = await h.fe.listen();
      const res = await lanRequest(loopbackPort, { path: "/healthz" });
      expect(res.status).toBe(200);
    } finally {
      await occupied.close();
    }
  });
});

describe('LanFacade start()∥close() race (plan §1.4 "close 与 start 并发")', () => {
  it("close() while start() is still awaiting bind() aborts it: never reports on(), and the port is free again", async () => {
    const h = await startLan({ autoStart: false });
    harnesses.push(h);

    // No `await` between these two calls: `close()`'s synchronous prefix (abort every in-flight
    // start()) runs before `start()`'s own `await transport.bind(...)` has had any chance to
    // settle — exactly the race plan §1.4 describes, reproduced deterministically without mocks.
    const startPromise = h.fe.lan!.start();
    const closePromise = h.fe.lan!.close();
    const [startStatus] = await Promise.all([startPromise, closePromise]);

    expect(startStatus.state).not.toBe("on");
    expect(h.fe.lan!.status().state).not.toBe("on");
    await assertPortIsFree(h.cfg.port);
  });

  it("start() called after close() is a no-op: no listener is created, status is unchanged, the port stays free", async () => {
    const h = await startLan({ autoStart: false });
    harnesses.push(h);

    await h.fe.lan!.close();
    const statusBefore = h.fe.lan!.status();
    const statusAfter = await h.fe.lan!.start();

    expect(statusAfter).toEqual(statusBefore);
    expect(statusAfter.state).not.toBe("on");
    await assertPortIsFree(h.cfg.port);
  });
});
