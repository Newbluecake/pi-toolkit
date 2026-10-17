/**
 * `hub/proxy/routes.ts` (web-hub-proxy plan v2 §3.8, X1c): the route frontend against a fake
 * service + fake `ProxyRouteIo`. Asserts the X1b hand-off contract point by point: seq0 captured
 * BEFORE identity resolution, host-part-only `browserHost`, trusted-reverse-proxy refusal at the
 * route gate, `closing`+`retryable` ⇒ identity re-resolve (stale/revoked ⇒ 401), error mapping,
 * per-principal bucket, never-throws.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthIdentity,
  IdentityResult,
  ProxyOpenOutcome,
  ProxyRouteIo,
  ProxyService,
} from "../../../../src/web-hub/hub/ports.js";
import { createProxyRoutes } from "../../../../src/web-hub/hub/proxy/routes.js";
import {
  PROXY_LIST_PATH,
  PROXY_OPEN_BUCKET_CAPACITY,
  PROXY_OPEN_BUCKET_REFILL_MS,
  PROXY_OPEN_MAX_BODY_BYTES,
  PROXY_OPEN_PATH,
  PROXY_STOP_PATH,
} from "../../../../src/web-hub/protocol/proxy.js";

const ID: AuthIdentity = {
  listener: "loopback",
  principal: "p".repeat(43),
  sidTag: "p".repeat(43),
  parentExpiresAt: Number.MAX_SAFE_INTEGER,
};
const OK_RESULT = {
  instanceId: "inst-12345678",
  origin: "http://127.0.0.1:7901",
  enterUrl: "http://127.0.0.1:7901/__pwh_proxy__/enter?c=x",
  target: { host: "127.0.0.1", port: 3000, cls: "loopback" as const },
};

interface Sent {
  status: number;
  body: unknown;
  headers?: Record<string, string> | undefined;
}

function harness(
  over: {
    identity?: () => IdentityResult | Promise<IdentityResult>;
    answerOnAuthFail?: boolean;
    service?: Partial<ProxyService> | null;
    io?: Partial<ProxyRouteIo>;
    body?: unknown | (() => unknown);
    now?: () => number;
  } = {},
) {
  const order: string[] = [];
  const sent: Sent[] = [];
  const logs: unknown[] = [];
  const res = { headersSent: false, writableEnded: false, destroy: vi.fn() } as unknown as ServerResponse;
  const mark = (s: Sent) => {
    sent.push(s);
    (res as { writableEnded: boolean }).writableEnded = true;
  };
  const service: ProxyService | null =
    over.service === null
      ? null
      : {
          currentSeq: () => {
            order.push("seq");
            return 41;
          },
          revokedSince: () => false,
          open: vi.fn(async () => ({ ok: true, result: OK_RESULT }) as ProxyOpenOutcome),
          list: vi.fn(() => ({ items: [], policy: { maxProxies: 8, portRange: [7900, 7949], lan: false } })),
          stop: vi.fn(async () => ({ ok: true as const })),
          revoke: vi.fn(),
          activeConnections: () => 0,
          dispose: async () => {},
          ...over.service,
        };
  const io: ProxyRouteIo = {
    listener: "loopback",
    expectedOrigin: "http://127.0.0.1:7878",
    browserHost: "127.0.0.1",
    viaTrustedProxy: false,
    strictCsrfOk: () => true,
    xPwhOk: () => true,
    resolveIdentity: async () => {
      order.push("identity");
      const r = await (over.identity?.() ?? { ok: true, id: ID });
      if (!r.ok && over.answerOnAuthFail === true) mark({ status: 401, body: { error: "E_AUTH", reason: "answered" } });
      return r;
    },
    readJson: async () => {
      order.push("body");
      const b = typeof over.body === "function" ? (over.body as () => unknown)() : over.body;
      return b;
    },
    sendJson: (_res, status, body, headers) => mark({ status, body, headers }),
    sendError: (_res, status, code) => mark({ status, body: { error: code } }),
    ...over.io,
  };
  const routes = createProxyRoutes({
    service: () => service ?? undefined,
    log: { info: (...a: unknown[]) => void logs.push(a) } as never,
    ...(over.now === undefined ? {} : { now: over.now }),
  });
  const call = (method: string, path: string) => routes.handle({} as IncomingMessage, res, method, path, io);
  return { call, sent, order, service, logs, res };
}

describe("createProxyRoutes — dispatch", () => {
  it("answers only the three proxy routes; any other method/path ⇒ false (original 404 applies)", async () => {
    const h = harness();
    expect(await h.call("GET", PROXY_OPEN_PATH)).toBe(false);
    expect(await h.call("POST", PROXY_LIST_PATH)).toBe(false);
    expect(await h.call("GET", PROXY_STOP_PATH)).toBe(false);
    expect(await h.call("POST", "/api/proxy/other")).toBe(false);
    expect(await h.call("DELETE", PROXY_OPEN_PATH)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.order).toEqual([]);
  });
});

describe("POST /api/proxy/open", () => {
  it("captures seq0 BEFORE identity resolution and passes (identity, target, browserHost, seq0) verbatim", async () => {
    const h = harness({ body: { target: "127.0.0.1:3000" } });
    expect(await h.call("POST", PROXY_OPEN_PATH)).toBe(true);
    expect(h.order).toEqual(["seq", "identity", "body"]);
    expect(h.service!.open).toHaveBeenCalledWith(ID, "127.0.0.1:3000", "127.0.0.1", 41);
    expect(h.sent).toEqual([{ status: 200, body: OK_RESULT, headers: undefined }]);
  });

  it("CSRF gate first: no identity resolution, no service call", async () => {
    const h = harness({ io: { strictCsrfOk: () => false } });
    await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent).toEqual([{ status: 403, body: { error: "E_CSRF" } }]);
    expect(h.order).toEqual([]);
  });

  it("identity failure the resolver did NOT answer ⇒ 401 / 429 / 503 by code; an answered one is not answered twice", async () => {
    for (const [code, status] of [
      ["E_AUTH", 401],
      ["E_RATE", 429],
      ["E_DB", 503],
    ] as const) {
      const h = harness({ identity: () => ({ ok: false, code }) });
      await h.call("POST", PROXY_OPEN_PATH);
      expect(h.sent).toEqual([{ status, body: { error: code } }]);
      expect(h.service!.open).not.toHaveBeenCalled();
    }
    const answered = harness({
      identity: () => ({ ok: false, code: "E_AUTH", conflict: true }),
      answerOnAuthFail: true,
    });
    await answered.call("POST", PROXY_OPEN_PATH);
    expect(answered.sent).toHaveLength(1);
    expect(answered.sent[0]!.body).toEqual({ error: "E_AUTH", reason: "answered" });
  });

  it("refuses a trusted-reverse-proxy mint with 409 reverse-proxy and never reaches the service (stop too)", async () => {
    const h = harness({ io: { viaTrustedProxy: true }, body: { target: "127.0.0.1:3000" } });
    await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent).toEqual([
      { status: 409, body: { error: "E_PROXY_UNAVAILABLE", reason: "reverse-proxy" }, headers: undefined },
    ]);
    expect(h.service!.open).not.toHaveBeenCalled();
    // audited through the whitelisted proxy-open event, reason only
    expect(h.logs).toEqual([["proxy-open", expect.objectContaining({ ok: false, reason: "reverse-proxy" })]]);
    const s = harness({ io: { viaTrustedProxy: true }, body: { instanceId: "inst-12345678" } });
    await s.call("POST", PROXY_STOP_PATH);
    expect(s.sent[0]).toMatchObject({ status: 409, body: { reason: "reverse-proxy" } });
    expect(s.service!.stop).not.toHaveBeenCalled();
  });

  it("body: non-object / missing / non-string target ⇒ 400 E_BAD_REQUEST; reader HttpErrors keep their status/code; size cap is the frozen 2 KiB", async () => {
    for (const body of [undefined, null, [], "x", { target: 1 }, {}]) {
      const h = harness({ body });
      await h.call("POST", PROXY_OPEN_PATH);
      expect(h.sent).toEqual([{ status: 400, body: { error: "E_BAD_REQUEST" } }]);
    }
    const tooBig = harness({
      body: () => {
        throw Object.assign(new Error("body too large"), { status: 413, code: "E_BAD_REQUEST" });
      },
    });
    await tooBig.call("POST", PROXY_OPEN_PATH);
    expect(tooBig.sent).toEqual([{ status: 413, body: { error: "E_BAD_REQUEST" } }]);
    const readJson = vi.fn(async () => ({ target: "x" }));
    const cap = harness({ io: { readJson } });
    await cap.call("POST", PROXY_OPEN_PATH);
    expect(readJson).toHaveBeenCalledWith(expect.anything(), PROXY_OPEN_MAX_BODY_BYTES);
    const garbage = harness({
      body: () => {
        throw new Error("boom");
      },
    });
    await garbage.call("POST", PROXY_OPEN_PATH);
    expect(garbage.sent).toEqual([{ status: 400, body: { error: "E_BAD_REQUEST" } }]);
  });

  it("maps every service failure shape to its status + {error, reason}; 503/429 carry Retry-After, 4xx/409 don't", async () => {
    const cases: Array<[ProxyOpenOutcome, number, unknown, boolean]> = [
      [
        { ok: false, status: 403, error: "E_PROXY_DENIED", reason: "public" },
        403,
        { error: "E_PROXY_DENIED", reason: "public" },
        false,
      ],
      [
        { ok: false, status: 400, error: "E_PROXY_DENIED", reason: "syntax" },
        400,
        { error: "E_PROXY_DENIED", reason: "syntax" },
        false,
      ],
      [
        { ok: false, status: 409, error: "E_LIMIT", reason: "proxies" },
        409,
        { error: "E_LIMIT", reason: "proxies" },
        false,
      ],
      [
        { ok: false, status: 409, error: "E_LIMIT", reason: "ports-exhausted" },
        409,
        { error: "E_LIMIT", reason: "ports-exhausted" },
        false,
      ],
      [
        { ok: false, status: 503, error: "E_PROXY_UNAVAILABLE", reason: "port-busy" },
        503,
        { error: "E_PROXY_UNAVAILABLE", reason: "port-busy" },
        true,
      ],
      [
        { ok: false, status: 503, error: "E_PROXY_UNAVAILABLE", reason: "ports-store" },
        503,
        { error: "E_PROXY_UNAVAILABLE", reason: "ports-store" },
        true,
      ],
      [
        { ok: false, status: 503, error: "E_PROXY_UNAVAILABLE", reason: "listen-timeout" },
        503,
        { error: "E_PROXY_UNAVAILABLE", reason: "listen-timeout" },
        true,
      ],
      [{ ok: false, status: 429, error: "E_RATE", reason: "codes" }, 429, { error: "E_RATE", reason: "codes" }, true],
    ];
    for (const [outcome, status, body, retry] of cases) {
      const h = harness({ body: { target: "x" }, service: { open: async () => outcome } });
      await h.call("POST", PROXY_OPEN_PATH);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.status).toBe(status);
      expect(h.sent[0]!.body).toEqual(body);
      expect(h.sent[0]!.headers?.["Retry-After"] !== undefined).toBe(retry);
    }
  });

  it("closing+retryable ⇒ re-resolve identity: stale/revoked ⇒ 401, still-valid ⇒ retryable 503 (never both)", async () => {
    const closing: ProxyOpenOutcome = {
      ok: false,
      status: 503,
      error: "E_PROXY_UNAVAILABLE",
      reason: "closing",
      retryable: true,
    };
    // identity goes stale between the two resolutions
    let n = 0;
    const stale = harness({
      body: { target: "x" },
      service: { open: async () => closing },
      identity: () => (++n === 1 ? { ok: true, id: ID } : { ok: false, code: "E_AUTH" }),
    });
    await stale.call("POST", PROXY_OPEN_PATH);
    expect(stale.order.filter((o) => o === "identity")).toHaveLength(2);
    expect(stale.sent).toEqual([{ status: 401, body: { error: "E_AUTH" } }]);

    // revoked since seq0 although the cookie still resolves
    const revoked = harness({
      body: { target: "x" },
      service: { open: async () => closing, revokedSince: () => true },
    });
    await revoked.call("POST", PROXY_OPEN_PATH);
    expect(revoked.sent).toEqual([{ status: 401, body: { error: "E_AUTH" } }]);

    // a genuinely closing service with a valid identity ⇒ 503 retryable
    const live = harness({ body: { target: "x" }, service: { open: async () => closing } });
    await live.call("POST", PROXY_OPEN_PATH);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]).toMatchObject({
      status: 503,
      body: { error: "E_PROXY_UNAVAILABLE", reason: "closing" },
      headers: { "Retry-After": "1" },
    });

    // a NON-retryable closing never re-resolves
    const plain = harness({
      body: { target: "x" },
      service: { open: async () => ({ ...closing, retryable: undefined }) as ProxyOpenOutcome },
    });
    await plain.call("POST", PROXY_OPEN_PATH);
    expect(plain.order.filter((o) => o === "identity")).toHaveLength(1);
  });

  it("service not constructed (yet / construction failed) ⇒ 503 closing AFTER the csrf+auth gates", async () => {
    const h = harness({ service: null, body: { target: "x" } });
    await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent[0]).toMatchObject({ status: 503, body: { error: "E_PROXY_UNAVAILABLE", reason: "closing" } });
    const unauth = harness({ service: null, identity: () => ({ ok: false, code: "E_AUTH" }) });
    await unauth.call("POST", PROXY_OPEN_PATH);
    expect(unauth.sent).toEqual([{ status: 401, body: { error: "E_AUTH" } }]);
  });

  it("per-principal bucket: capacity 10, then 429 with Retry-After, +1 token per 6 s; other principals unaffected", async () => {
    let t = 1_000_000;
    const other = { ...ID, principal: "q".repeat(43), sidTag: "q".repeat(43) };
    let who: AuthIdentity = ID;
    const h = harness({ body: { target: "x" }, now: () => t, identity: () => ({ ok: true, id: who }) });
    for (let i = 0; i < PROXY_OPEN_BUCKET_CAPACITY; i++) await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent.every((s) => s.status === 200)).toBe(true);
    await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent.at(-1)).toMatchObject({ status: 429, body: { error: "E_RATE" }, headers: { "Retry-After": "1" } });
    who = other;
    await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent.at(-1)!.status).toBe(200);
    who = ID;
    t += PROXY_OPEN_BUCKET_REFILL_MS;
    await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent.at(-1)!.status).toBe(200);
    await h.call("POST", PROXY_OPEN_PATH);
    expect(h.sent.at(-1)!.status).toBe(429);
  });
});

describe("GET /api/proxy", () => {
  it("needs X-PWH then identity; returns the service list for that identity", async () => {
    const no = harness({ io: { xPwhOk: () => false } });
    await no.call("GET", PROXY_LIST_PATH);
    expect(no.sent).toEqual([{ status: 403, body: { error: "E_CSRF" } }]);
    expect(no.order).toEqual([]);
    const h = harness();
    await h.call("GET", PROXY_LIST_PATH);
    expect(h.service!.list).toHaveBeenCalledWith(ID);
    expect(h.sent[0]!.status).toBe(200);
    const unauth = harness({ identity: () => ({ ok: false, code: "E_AUTH" }) });
    await unauth.call("GET", PROXY_LIST_PATH);
    expect(unauth.sent).toEqual([{ status: 401, body: { error: "E_AUTH" } }]);
  });

  it("is not blocked by the reverse-proxy refusal (read-only listing)", async () => {
    const h = harness({ io: { viaTrustedProxy: true } });
    await h.call("GET", PROXY_LIST_PATH);
    expect(h.sent[0]!.status).toBe(200);
  });
});

describe("POST /api/proxy/stop", () => {
  it("validates the instanceId grammar, stops, 200 {ok:true}; unknown ⇒ 404 E_NOT_FOUND", async () => {
    for (const body of [{}, { instanceId: "short" }, { instanceId: "has space/../x" }, { instanceId: 7 }]) {
      const h = harness({ body });
      await h.call("POST", PROXY_STOP_PATH);
      expect(h.sent).toEqual([{ status: 400, body: { error: "E_BAD_REQUEST" } }]);
    }
    const ok = harness({ body: { instanceId: "inst-12345678" } });
    await ok.call("POST", PROXY_STOP_PATH);
    expect(ok.service!.stop).toHaveBeenCalledWith("inst-12345678", ID);
    expect(ok.sent).toEqual([{ status: 200, body: { ok: true }, headers: undefined }]);
    const gone = harness({
      body: { instanceId: "inst-12345678" },
      service: { stop: async () => ({ ok: false as const, code: "E_NOT_FOUND" as const }) },
    });
    await gone.call("POST", PROXY_STOP_PATH);
    expect(gone.sent).toEqual([{ status: 404, body: { error: "E_NOT_FOUND" } }]);
  });
});

describe("never throws", () => {
  it("a throwing service answers 500 E_INTERNAL (no message), logs only a code, still resolves true", async () => {
    const h = harness({
      body: { target: "x" },
      service: {
        open: async () => {
          throw new Error("secret path /home/x/.ssh");
        },
      },
    });
    await expect(h.call("POST", PROXY_OPEN_PATH)).resolves.toBe(true);
    expect(h.sent).toEqual([{ status: 500, body: { error: "E_INTERNAL" } }]);
    expect(JSON.stringify(h.logs)).not.toContain("secret path");
    expect(JSON.stringify(h.logs)).not.toContain(".ssh");
  });

  it("a throw after the response was written destroys the response instead of writing twice", async () => {
    const h = harness({
      body: { target: "x" },
      io: {
        sendJson: () => {
          (h.res as { writableEnded: boolean }).writableEnded = true;
          throw new Error("late");
        },
      },
    });
    await expect(h.call("POST", PROXY_OPEN_PATH)).resolves.toBe(true);
    expect((h.res as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
  });
});
