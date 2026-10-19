import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as coreModule from "../../../src/web-hub/hub/lan-login.js";
import { writeLanLoginReply } from "../../../src/web-hub/hub/http.js";
import { createSecurityEventBus, type SecurityEvent } from "../../../src/web-hub/hub/security-events.js";
import type { ConnLease, LoginIo } from "../../../src/web-hub/hub/ports.js";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";
import { captureLog } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());
const credentials = { username: "alice", password: "correct-horse-battery" };
function watchCore() {
  const real = coreModule.createLanLoginCore;
  const cores: ReturnType<typeof real>[] = [];
  vi.spyOn(coreModule, "createLanLoginCore").mockImplementation((deps) => {
    const core = real(deps);
    for (const key of ["submitFactor", "onRevoke", "dispose"] as const) vi.spyOn(core, key);
    cores.push(core);
    return core;
  });
  return cores;
}

describe("LAN-I login core HTTP integration", () => {
  it("all password successes (including known IP) use checked INSERT, record history and emit once after finish", async () => {
    const events: SecurityEvent[] = [];
    const security = createSecurityEventBus(captureLog());
    security.subscribe((e) => events.push(e));
    const h = await startLan({ security });
    try {
      seedLanUser(h.store, credentials);
      const legacy = vi.spyOn(h.store, "createSession");
      const checked = vi.spyOn(h.store, "createSessionChecked");
      const note = vi.spyOn(h.store, "noteLoginIp");
      for (let i = 0; i < 2; i++) {
        const r = await lanPostJson(h.port, "/api/login", credentials, { "User-Agent": "Linux Firefox/1" });
        expect(r.status).toBe(200);
        expect(r.headers["set-cookie"]).toHaveLength(2);
        expect(r.headers["set-cookie"]?.[1]).toContain(
          "pwh_lan2fa=; HttpOnly; SameSite=Strict; Path=/api/login; Max-Age=0",
        );
      }
      await vi.waitFor(() => expect(events.filter((e) => e.type === "login-success")).toHaveLength(2));
      expect(legacy).not.toHaveBeenCalled();
      expect(checked).toHaveBeenCalledTimes(2);
      expect(note).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        { type: "login-success", ip: "127.0.0.1", method: "password", device: "Linux · Firefox", newIp: true },
        { type: "login-success", ip: "127.0.0.1", method: "password", device: "Linux · Firefox", newIp: false },
      ]);
      expect(h.store.sessionsBySidHash.size).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  it("recovery success reaches the same checked completion and emits login-success plus recovery-used once", async () => {
    const events: SecurityEvent[] = [];
    const security = createSecurityEventBus(captureLog());
    security.subscribe((e) => events.push(e));
    const h = await startLan({ security, secondFactorEnabled: true });
    try {
      seedLanUser(h.store, credentials);
      const checked = vi.spyOn(h.store, "createSessionChecked");
      const { recoveryCodes } = await h.store.setFeishu2fa({ userId: 1, on: true, now: h.clock.now() });
      const challenge = await lanPostJson(h.port, "/api/login", credentials);
      expect(challenge.status).toBe(401);
      expect(checked).not.toHaveBeenCalled();
      const cookie = challenge.headers["set-cookie"]![0]!.split(";")[0]!;
      const success = await lanPostJson(
        h.port,
        "/api/login/2fa",
        { method: "recovery", code: recoveryCodes![0] },
        { Cookie: cookie },
      );
      expect(success.status).toBe(200);
      expect(success.headers["set-cookie"]).toHaveLength(2);
      await vi.waitFor(() => expect(events.filter((e) => e.type === "login-success")).toHaveLength(1));
      expect(checked).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === "login-success")).toEqual([
        { type: "login-success", ip: "127.0.0.1", method: "recovery", device: "Unknown · Browser", newIp: true },
      ]);
      expect(events.filter((e) => e.type === "recovery-used")).toEqual([{ type: "recovery-used", left: 9 }]);
      expect(h.store.sessionsBySidHash.size).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("staged rollout: an enrolled user's new-IP password login stays usable, second-factor routes stay 404", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, credentials);
      await h.store.setFeishu2fa({ userId: 1, on: true, now: h.clock.now() });
      expect(await h.store.isKnownIp("127.0.0.1", h.clock.now(), 30 * 86400000)).toBe(false);
      const r = await lanPostJson(h.port, "/api/login", credentials);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true, initialPassword: false });
      for (const path of ["/api/login/2fa", "/api/login/2fa/cancel"])
        expect((await lanPostJson(h.port, path, {})).status).toBe(404);
      expect((await lanRequest(h.port, { path: "/api/login/2fa/wait", headers: { "X-PWH": "1" } })).status).toBe(404);
    } finally {
      await h.cleanup();
    }
  });

  it("strictly validates method/code BEFORE calling core; recovery normalization keeps strict extra-key rejection", async () => {
    const cores = watchCore();
    const h = await startLan({ secondFactorEnabled: true });
    try {
      const core = cores[0]!;
      for (const body of [
        null,
        {},
        { method: "feishu", code: "123456" },
        { method: 1, code: "123456" },
        { method: "totp", code: "12345" },
        { method: "totp", code: "123456", extra: true },
        { method: "recovery", code: "bad" },
        { method: "recovery", code: "0123456789AB", extra: true },
      ]) {
        const r = await lanPostJson(h.port, "/api/login/2fa", body);
        expect(r.status).toBe(400);
        expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST" });
      }
      expect(core.submitFactor).not.toHaveBeenCalled();
      const r = await lanPostJson(h.port, "/api/login/2fa", { method: "recovery", code: "oI23-4567-89ab" });
      expect(r.status).toBe(409); // valid body reaches lookup, but no challenge cookie
      expect(core.submitFactor).toHaveBeenCalledTimes(1);
      expect(vi.mocked(core.submitFactor).mock.calls[0]?.[1]).toEqual({ method: "recovery", code: "0123456789AB" });
    } finally {
      await h.cleanup();
    }
  });

  it("facade user revoke reaches core and invalidates a pending challenge; close unsubscribes/disposes", async () => {
    const cores = watchCore();
    const h = await startLan({ secondFactorEnabled: true });
    try {
      seedLanUser(h.store, credentials);
      const { recoveryCodes } = await h.store.setFeishu2fa({ userId: 1, on: true, now: h.clock.now() });
      const login = await lanPostJson(h.port, "/api/login", credentials, { "User-Agent": "Firefox/1" });
      expect(login.status).toBe(401);
      expect(JSON.parse(login.body)).toMatchObject({ error: "E_2FA", methods: ["recovery"] });
      const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
      expect(cookie).toMatch(/^pwh_lan2fa=/);
      h.fe.lan!.revoke({ userId: 1 });
      expect(cores[0]!.onRevoke).toHaveBeenCalledWith({ sel: { userId: 1 }, reason: "passwd" });
      const r = await lanPostJson(
        h.port,
        "/api/login/2fa",
        { method: "recovery", code: recoveryCodes![0] },
        { Cookie: cookie, "User-Agent": "Firefox/1" },
      );
      expect(r.status).toBe(409);
      expect(h.store.sessionsBySidHash.size).toBe(0);
      await h.fe.lan!.close();
      expect(cores[0]!.dispose).toHaveBeenCalled();
      vi.mocked(cores[0]!.onRevoke).mockClear();
      h.fe.lan!.revoke({ userId: 1 });
      expect(cores[0]!.onRevoke).not.toHaveBeenCalled();
    } finally {
      await h.cleanup();
    }
  });
});

describe("LAN-I response finish adapter", () => {
  function response() {
    const emitter = new EventEmitter();
    const headers = new Map<string, unknown>();
    const res = Object.assign(emitter, {
      headersSent: false,
      destroyed: false,
      setHeader: (key: string, v: unknown) => {
        headers.set(key, v);
      },
      writeHead: vi.fn(),
      end: vi.fn(),
    }) as unknown as ServerResponse;
    const controller = new AbortController();
    const io: LoginIo = { ua: "", signal: controller.signal, responseOpen: () => !res.destroyed };
    const lease = { enterAuthed: vi.fn(), leaveLoginPending: vi.fn() } as unknown as ConnLease;
    const after = vi.fn(async () => {});
    const abort = vi.fn(() => controller.abort());
    return { res, headers, io, lease, after, abort };
  }
  it("registers exactly once before send, preserves cookie arrays, never runs after on close", async () => {
    const r = response();
    const cookies = ["session", "clear-challenge"];
    writeLanLoginReply(
      { status: 200, body: { ok: true }, headers: { "Set-Cookie": cookies }, after: r.after },
      r.res,
      r.io,
      r.lease,
      r.abort,
      captureLog(),
    );
    expect(r.res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(r.headers.get("Set-Cookie")).toBe(cookies);
    expect(r.lease.enterAuthed).toHaveBeenCalledTimes(1);
    expect(r.after).not.toHaveBeenCalled();
    r.res.emit("close");
    expect(r.after).not.toHaveBeenCalled();
    r.res.emit("finish");
    r.res.emit("finish");
    expect(r.after).toHaveBeenCalledTimes(1);
  });
  it("aborts the core-to-send gap on a closed response; never sends headers or registers after", () => {
    const r = response();
    r.res.destroyed = true;
    writeLanLoginReply(
      { status: 200, body: { ok: true }, after: r.after },
      r.res,
      r.io,
      r.lease,
      r.abort,
      captureLog(),
    );
    expect(r.abort).toHaveBeenCalledTimes(1);
    expect(r.io.signal.aborted).toBe(true);
    expect(r.res.writeHead).not.toHaveBeenCalled();
    expect(r.lease.leaveLoginPending).toHaveBeenCalledTimes(1);
    r.res.emit("finish");
    expect(r.after).not.toHaveBeenCalled();
  });
});
