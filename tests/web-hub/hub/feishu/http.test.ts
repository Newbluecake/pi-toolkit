import { describe, expect, it } from "vitest";

import {
  createFeishuHttp,
  extractMissingScopes,
  makeFailure,
  redactSecrets,
  sanitizeApiMessage,
} from "../../../../src/web-hub/hub/feishu/http.js";
import type { FeishuHttpEvent, FeishuFailure } from "../../../../src/web-hub/hub/feishu/http.js";
import { createFakeClock, createFakeFeishu, settle } from "../../../fixtures/feishu/fake-http.js";

const BASE = "https://open.feishu.cn";
const SECRET = "s3cr3t-app-secret-value-9876543210";

function rig(opts: { base?: string; secrets?: () => readonly string[]; events?: FeishuHttpEvent[] } = {}) {
  const fake = createFakeFeishu();
  const clock = createFakeClock();
  const http = createFeishuHttp({
    apiBase: opts.base ?? BASE,
    fetch: fake.fetch,
    clock,
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...(opts.events ? { onEvent: (e) => opts.events!.push(e) } : {}),
  });
  return { fake, clock, http };
}

const get = (path: string, extra: Record<string, unknown> = {}) => ({
  op: "t",
  method: "GET" as const,
  path,
  ...extra,
});

function failure<T>(r: { ok: true; data: T } | FeishuFailure): FeishuFailure {
  if (r.ok) throw new Error("expected a failure");
  return r;
}

describe("destination allowlist (§2.2)", () => {
  it.each([
    "https://open.feishu.cn.evil.com",
    "http://open.feishu.cn",
    "https://open.feishu.cn/",
    "https://open.feishu.cn:8443",
    "https://evil.example",
    "https://user@open.feishu.cn",
    "",
  ])("refuses base %j without any fetch", async (base) => {
    const { fake, http } = rig({ base });
    const r = failure(await http.json(get("/open-apis/im/v1/x")));
    expect(r).toMatchObject({ kind: "destination", effect: "none", retryable: false });
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["https://open.feishu.cn", "https://open.larksuite.com"])("accepts frozen base %s", async (base) => {
    const { fake, http } = rig({ base });
    fake.on("GET", "/open-apis/ping", () => ({ json: { code: 0, data: {} } }));
    expect((await http.json(get("/open-apis/ping"))).ok).toBe(true);
    expect(fake.calls[0]!.url.startsWith(base + "/")).toBe(true);
  });

  it.each([
    "//evil.example/x",
    "https://evil.example/open-apis/x",
    "/other/x",
    "open-apis/x",
    "/open-apis/../admin",
    "/open-apis/a/./b",
    "/open-apis/a//b",
    "/open-apis/%2e%2e/x",
    "/open-apis/a%2fb",
    "/open-apis/a b",
    "/open-apis/a\\b",
    "/open-apis/x?y=1",
    "/open-apis/x#h",
    "/open-apis/@evil.example/x",
    "/callback",
  ])("refuses path %j", async (path) => {
    const { fake, http } = rig();
    expect(failure(await http.json(get(path))).kind).toBe("destination");
    expect(fake.calls).toHaveLength(0);
  });

  it("encoded id segments stay inside the base origin", async () => {
    const { fake, http } = rig();
    fake.on("GET", /.*/, () => ({ json: { code: 0 } }));
    await http.json(get(`/open-apis/im/v1/messages/${encodeURIComponent("a?c#d@e")}/x`));
    const url = new URL(fake.calls[0]!.url);
    expect(url.origin).toBe(BASE);
    expect(url.hash).toBe("");
    expect(url.search).toBe("");
  });

  it("always requests with redirect:'error' and a redirect-triggered fetch error is `unreachable`", async () => {
    const { fake, http } = rig();
    fake.on("GET", "/open-apis/r", () => ({ json: { code: 0 } }));
    await http.json(get("/open-apis/r"));
    expect(fake.calls[0]!.redirect).toBe("error");

    const failing = createFeishuHttp({
      apiBase: BASE,
      clock: createFakeClock(),
      fetch: () => Promise.reject(new TypeError("redirect mode is set to error: https://evil.example/?ticket=abc")),
    });
    const r = failure(await failing.json(get("/open-apis/r")));
    expect(r).toMatchObject({ kind: "unreachable", reason: "unreachable" });
    expect(JSON.stringify(r)).not.toContain("evil");
  });
});

describe("request shaping", () => {
  it("sends Bearer + JSON content type, query, extra headers; ignores reserved overrides", async () => {
    const { fake, http } = rig();
    fake.on("POST", "/open-apis/x", () => ({ json: { code: 0, data: { a: 1 } } }));
    const r = await http.json({
      op: "t",
      method: "POST",
      path: "/open-apis/x",
      query: { receive_id_type: "chat_id" },
      token: "t-abc",
      json: { k: "v" },
      headers: { locale: "zh", Authorization: "Bearer evil", "Content-Type": "text/plain", "bad name": "x" },
    });
    expect(r).toMatchObject({ ok: true, data: { status: 200, data: { a: 1 } } });
    const c = fake.calls[0]!;
    expect(c.headers["authorization"]).toBe("Bearer t-abc");
    expect(c.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(c.headers["locale"]).toBe("zh");
    expect(c.headers["bad name"]).toBeUndefined();
    expect(c.query).toEqual({ receive_id_type: "chat_id" });
    expect(c.json).toEqual({ k: "v" });
  });

  it("refuses oversize / unserializable request bodies locally", async () => {
    const { fake, http } = rig();
    const big = failure(
      await http.json({
        op: "t",
        method: "POST",
        path: "/open-apis/x",
        json: { s: "x".repeat(200) },
        maxRequestBytes: 100,
      }),
    );
    expect(big).toMatchObject({ kind: "bad-request", effect: "none" });
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(failure(await http.json({ op: "t", method: "POST", path: "/open-apis/x", json: cyc })).kind).toBe(
      "bad-request",
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("response classification", () => {
  it.each([
    [200, { code: 0, data: { z: 1 } }, "ok"],
    [200, { code: 99991672, msg: "scope" }, "api-code-99991672"],
    [400, { code: 99991663, msg: "invalid" }, "api-code-99991663"],
    [200, { msg: "no code" }, "protocol:invalid-api-response"],
  ])("HTTP %i %j ⇒ %s", async (status, body, expected) => {
    const { fake, http } = rig();
    fake.on("GET", "/open-apis/c", () => ({ status, json: body }));
    const r = await http.json(get("/open-apis/c"));
    if (expected === "ok") expect(r.ok).toBe(true);
    else expect(failure(r).reason).toBe(expected);
  });

  it("api failure beats http status when the body has a non-zero code, carrying status and code", async () => {
    const { fake, http } = rig();
    fake.on("GET", "/open-apis/c", () => ({ status: 400, json: { code: 230027, msg: "denied" } }));
    expect(failure(await http.json(get("/open-apis/c")))).toMatchObject({
      kind: "api",
      status: 400,
      code: 230027,
      effect: "none",
      retryable: false,
    });
  });

  it.each([
    [500, true, "unknown"],
    [502, true, "unknown"],
    [429, true, "none"],
    [408, true, "none"],
    [404, false, "none"],
    [403, false, "none"],
    [401, false, "none"],
  ])("code-less HTTP %i ⇒ http-%i retryable=%s effect=%s", async (status, retryable, effect) => {
    const { fake, http } = rig();
    fake.on("GET", "/open-apis/c", () => ({
      status,
      text: "<html>gateway</html>",
      headers: { "content-type": "text/html" },
    }));
    expect(failure(await http.json(get("/open-apis/c")))).toMatchObject({
      kind: "http",
      reason: `http-${status}`,
      retryable,
      effect,
    });
  });

  it("a 5xx with an api code is still effect unknown (server may have acted)", async () => {
    const { fake, http } = rig();
    fake.on("POST", "/open-apis/c", () => ({ status: 500, json: { code: 1234, msg: "boom" } }));
    expect(failure(await http.json({ op: "t", method: "POST", path: "/open-apis/c" }))).toMatchObject({
      kind: "api",
      effect: "unknown",
      retryable: true,
    });
  });

  it("2xx non-JSON / array body ⇒ protocol, effect unknown, no body text leaked", async () => {
    const { fake, http } = rig();
    fake.script("GET", "/open-apis/c", { text: "OK-but-not-json SECRET-BODY" }, { json: [1, 2, 3] });
    for (let i = 0; i < 2; i++) {
      const r = failure(await http.json(get("/open-apis/c")));
      expect(r).toMatchObject({ kind: "protocol", effect: "unknown", retryable: false });
      expect(JSON.stringify(r)).not.toContain("SECRET-BODY");
    }
  });

  it("transport error ⇒ unreachable (retryable, effect unknown); a sync-throwing/non-Error fetch never escapes", async () => {
    const { fake, http } = rig();
    fake.script("GET", "/open-apis/c", { networkError: true });
    expect(failure(await http.json(get("/open-apis/c")))).toMatchObject({
      kind: "unreachable",
      reason: "unreachable",
      retryable: true,
      effect: "unknown",
    });
    for (const thrower of [
      () => {
        throw new Error("sync boom");
      },
      () => Promise.reject("string rejection"),
      () => Promise.reject(undefined),
    ]) {
      const h = createFeishuHttp({ apiBase: BASE, fetch: thrower as never, clock: createFakeClock() });
      expect(failure(await h.json(get("/open-apis/c"))).kind).toBe("unreachable");
    }
  });

  it("JSON response cap: Content-Length precheck and streamed overflow without a length", async () => {
    const { fake, http } = rig();
    const big = new TextEncoder().encode(JSON.stringify({ code: 0, data: { s: "x".repeat(300) } }));
    fake.script(
      "GET",
      "/open-apis/c",
      { bytes: big, headers: { "content-length": String(big.length) } },
      { chunks: [big.slice(0, 100), big.slice(100)] },
      { chunks: [big.slice(0, 100), big.slice(100)] },
    );
    expect(failure(await http.json(get("/open-apis/c", { maxResponseBytes: 200 }))).kind).toBe("too-large");
    expect(failure(await http.json(get("/open-apis/c", { maxResponseBytes: 200 }))).kind).toBe("too-large");
    expect((await http.json(get("/open-apis/c", { maxResponseBytes: big.length }))).ok).toBe(true);
  });
});

describe("deadlines (clock + AbortSignal)", () => {
  it("a hanging call times out at the per-call deadline and releases its timer", async () => {
    const { fake, clock, http } = rig();
    fake.script("GET", "/open-apis/h", { hang: true });
    const p = http.json(get("/open-apis/h", { timeoutMs: 8_000 }));
    await settle(2);
    expect(clock.pending()).toBe(1);
    clock.advance(7_999);
    await settle(2);
    expect(clock.pending()).toBe(1);
    clock.advance(1);
    const r = failure(await p);
    expect(r).toMatchObject({ kind: "timeout", reason: "timeout", retryable: true, effect: "unknown" });
    expect(clock.pending()).toBe(0);
    expect(fake.calls[0]!.signal?.aborted).toBe(true);
  });

  it("default deadline is FEISHU_HTTP.defaultTimeoutMs (8 s)", async () => {
    const { fake, clock, http } = rig();
    fake.script("GET", "/open-apis/h", { hang: true });
    const p = http.json(get("/open-apis/h"));
    await settle(2);
    clock.advance(8_000);
    expect(failure(await p).kind).toBe("timeout");
  });

  it("the deadline also covers the body read (stalled stream)", async () => {
    const { fake, clock, http } = rig();
    fake.script("GET", "/open-apis/h", { chunks: [new TextEncoder().encode('{"code":0,')], hangAfter: true });
    const p = http.json(get("/open-apis/h"));
    await settle(3);
    clock.advance(8_000);
    expect(failure(await p).kind).toBe("timeout");
    expect(clock.pending()).toBe(0);
  });

  it("caller signal ⇒ aborted (not timeout); pre-aborted signal ⇒ no fetch", async () => {
    const { fake, clock, http } = rig();
    fake.script("GET", "/open-apis/h", { hang: true });
    const ac = new AbortController();
    const p = http.json(get("/open-apis/h", { signal: ac.signal }));
    await settle(2);
    ac.abort();
    expect(failure(await p)).toMatchObject({ kind: "aborted", effect: "unknown" });
    expect(clock.pending()).toBe(0);

    const before = fake.calls.length;
    const done = new AbortController();
    done.abort();
    expect(failure(await http.json(get("/open-apis/h", { signal: done.signal }))).kind).toBe("aborted");
    expect(fake.calls).toHaveLength(before);
  });

  it("timer is released after success too", async () => {
    const { fake, clock, http } = rig();
    fake.on("GET", "/open-apis/ok", () => ({ json: { code: 0 } }));
    await http.json(get("/open-apis/ok"));
    expect(clock.pending()).toBe(0);
  });
});

describe("streamed downloads", () => {
  const chunk = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
  const collect = () => {
    const got: Uint8Array[] = [];
    return { got, sink: (c: Uint8Array) => void got.push(c), size: () => got.reduce((n, c) => n + c.length, 0) };
  };
  const dl = { op: "dl", method: "GET" as const, path: "/open-apis/im/v1/messages/m/resources/k" };

  it("streams every chunk in order and reports bytes + content type", async () => {
    const { fake, http } = rig();
    fake.script("GET", dl.path, {
      chunks: [chunk(10, 1), chunk(20, 2), chunk(5, 3)],
      headers: { "content-type": "image/png" },
    });
    const c = collect();
    const r = await http.stream(dl, { maxBytes: 100, sink: c.sink });
    expect(r).toEqual({ ok: true, data: { bytes: 35, contentType: "image/png" } });
    expect(c.got.map((x) => x[0])).toEqual([1, 2, 3]);
  });

  it("Content-Length over the cap is refused before any byte reaches the sink", async () => {
    const { fake, http } = rig();
    fake.script("GET", dl.path, { bytes: chunk(50), headers: { "content-length": "50" } });
    const c = collect();
    expect(failure(await http.stream(dl, { maxBytes: 49, sink: c.sink })).kind).toBe("too-large");
    expect(c.got).toHaveLength(0);
  });

  it("unknown length: the running count trips the cap (partial bytes were already sunk — caller discards)", async () => {
    const { fake, http } = rig();
    fake.script("GET", dl.path, { chunks: [chunk(30), chunk(30), chunk(30)] });
    const c = collect();
    const r = failure(await http.stream(dl, { maxBytes: 70, sink: c.sink }));
    expect(r).toMatchObject({ kind: "too-large", effect: "unknown" });
    expect(c.size()).toBe(60);
  });

  it("a throwing sink aborts the download as aborted/sink-failed without leaking its message", async () => {
    const { fake, http } = rig();
    fake.script("GET", dl.path, { chunks: [chunk(5), chunk(5)] });
    const r = failure(
      await http.stream(dl, {
        maxBytes: 100,
        sink: () => {
          throw new Error("disk full /home/u/secret");
        },
      }),
    );
    expect(r).toMatchObject({ kind: "aborted", reason: "sink-failed" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("awaits an async sink (backpressure) before reading the next chunk", async () => {
    const { fake, http } = rig();
    fake.script("GET", dl.path, { chunks: [chunk(1), chunk(1), chunk(1)] });
    const order: string[] = [];
    await http.stream(dl, {
      maxBytes: 10,
      sink: async () => {
        order.push("start");
        await settle(1);
        order.push("end");
      },
    });
    expect(order).toEqual(["start", "end", "start", "end", "start", "end"]);
  });

  it("non-2xx error envelope is classified, never sunk", async () => {
    const { fake, http } = rig();
    fake.script("GET", dl.path, { status: 400, json: { code: 234043, msg: "no permission im:resource" } });
    const c = collect();
    const r = failure(await http.stream(dl, { maxBytes: 100, sink: c.sink }));
    expect(r).toMatchObject({ kind: "api", code: 234043, scopes: ["im:resource"] });
    expect(c.got).toHaveLength(0);
    fake.script("GET", dl.path, { status: 502, text: "bad gateway" });
    expect(failure(await http.stream(dl, { maxBytes: 100, sink: c.sink })).reason).toBe("http-502");
  });

  it("2xx JSON-typed tiny error envelope ⇒ api failure; a real JSON file is delivered intact", async () => {
    const { fake, http } = rig();
    const enc = new TextEncoder();
    fake.script(
      "GET",
      dl.path,
      { json: { code: 99991672, msg: "scope" } },
      { text: JSON.stringify({ hello: "world", code: 0 }), headers: { "content-type": "application/json" } },
      { text: JSON.stringify({ code: 7, data: "x".repeat(20_000) }), headers: { "content-type": "application/json" } },
    );
    const a = collect();
    expect(failure(await http.stream(dl, { maxBytes: 100_000, sink: a.sink })).code).toBe(99991672);
    expect(a.got).toHaveLength(0);

    const b = collect();
    expect((await http.stream(dl, { maxBytes: 100_000, sink: b.sink })).ok).toBe(true);
    expect(new TextDecoder().decode(b.got[0])).toBe(JSON.stringify({ hello: "world", code: 0 }));

    const big = collect();
    const r = await http.stream(dl, { maxBytes: 100_000, sink: big.sink });
    expect(r.ok).toBe(true);
    expect(big.size()).toBe(enc.encode(JSON.stringify({ code: 7, data: "x".repeat(20_000) })).length);
  });

  it("a stalled stream hits the deadline", async () => {
    const { fake, clock, http } = rig();
    fake.script("GET", dl.path, { chunks: [chunk(5)], hangAfter: true });
    const c = collect();
    const p = http.stream({ ...dl, timeoutMs: 30_000 }, { maxBytes: 100, sink: c.sink });
    await settle(3);
    clock.advance(30_000);
    expect(failure(await p).kind).toBe("timeout");
    expect(c.size()).toBe(5);
  });
});

describe("redaction (every error/log path)", () => {
  it("redactSecrets covers literals, Bearer, token shapes, credential pairs and URLs", () => {
    const text = [
      `bad secret ${SECRET} here`,
      "Authorization: Bearer t-abcdefghijklmnopqrstuvwxyz",
      "token t-0123456789abcdefABCDEF and u-0123456789abcdefABCDEF and a-0123456789abcdefABCDEF",
      `{"app_secret":"zzz","tenant_access_token":"yyy"} app_secret=xxx ticket=qqq device_code: ddd`,
      "see https://open.feishu.cn/document?x=1 and wss://msg-frontier.feishu.cn/ws?ticket=SECRETTICKET",
    ].join("\n");
    const out = redactSecrets(text, [SECRET]);
    for (const leak of [
      SECRET,
      "abcdefghijklmnopqrstuvwxyz",
      "0123456789abcdef",
      "zzz",
      "yyy",
      "xxx",
      "qqq",
      "ddd",
      "SECRETTICKET",
      "open.feishu.cn",
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  it("ignores too-short secrets (would shred ordinary words) but redacts normal ones", () => {
    expect(redactSecrets("a cat sat", ["a"])).toBe("a cat sat");
    expect(redactSecrets("abcd efgh", ["abcd"])).toBe("[redacted] efgh");
  });

  it("sanitizeApiMessage strips control chars (so a split secret cannot survive), caps length, drops empties", () => {
    expect(sanitizeApiMessage("sec\u0000ret", [])).toBe("sec ret");
    expect(sanitizeApiMessage(`x${"y".repeat(10_000)}`)!.length).toBeLessThanOrEqual(200);
    expect(sanitizeApiMessage("")).toBeUndefined();
    expect(sanitizeApiMessage("\u0001\u0002")).toBeUndefined();
    expect(sanitizeApiMessage(42)).toBeUndefined();
    expect(sanitizeApiMessage(`pre ${SECRET} post`, [SECRET])).toBe("pre [redacted] post");
  });

  it("extractMissingScopes: fixed namespaces only, no secrets/open_id lookalikes", () => {
    expect(
      extractMissingScopes(
        "need im:resource and im:message.reactions:write_only; contact:user.id:readonly foo:bar",
        [],
      ),
    ).toEqual(["im:resource", "im:message.reactions:write_only", "contact:user.id:readonly"]);
    expect(extractMissingScopes("im:open_id.secret", [])).toEqual([]);
    expect(extractMissingScopes(undefined)).toEqual([]);
  });

  it("an API error message carrying the app secret, the bearer token and a WS URL never reaches the failure or the event log", async () => {
    const events: FeishuHttpEvent[] = [];
    const token = "t-livetoken0123456789abcdefghij";
    const { fake, http } = rig({ secrets: () => [SECRET], events });
    fake.script("POST", "/open-apis/leak", {
      status: 400,
      json: {
        code: 4242,
        msg: `bad ${SECRET} / Bearer ${token} / ${token} / wss://msg-frontier.feishu.cn/ws?ticket=TKT123 / need im:resource`,
      },
    });
    const r = failure(await http.json({ op: "leak", method: "POST", path: "/open-apis/leak", token }));
    const dump = JSON.stringify([r, events]);
    for (const leak of [SECRET, token, "TKT123", "msg-frontier"]) expect(dump).not.toContain(leak);
    expect(r.scopes).toEqual(["im:resource"]);
    expect(r.msg).toContain("[redacted]");
  });

  it("per-call `secrets` are redacted too; `redact()` applies the same set", async () => {
    const { fake, http } = rig({ secrets: () => ["provider-secret-aaaa"] });
    fake.script("POST", "/open-apis/leak", { json: { code: 5, msg: "one-off-secret-bbbb provider-secret-aaaa" } });
    const r = failure(
      await http.json({ op: "x", method: "POST", path: "/open-apis/leak", secrets: ["one-off-secret-bbbb"] }),
    );
    expect(r.msg).not.toMatch(/bbbb|aaaa/);
    expect(http.redact("x provider-secret-aaaa y")).toBe("x [redacted] y");
  });

  it("a throwing secrets provider or onEvent observer never breaks a call", async () => {
    const fake = createFakeFeishu();
    const http = createFeishuHttp({
      apiBase: BASE,
      fetch: fake.fetch,
      clock: createFakeClock(),
      secrets: () => {
        throw new Error("provider");
      },
      onEvent: () => {
        throw new Error("observer");
      },
    });
    fake.script("GET", "/open-apis/e", { json: { code: 9, msg: "m" } });
    expect(failure(await http.json(get("/open-apis/e"))).code).toBe(9);
  });

  it("onEvent carries only op/ok/outcome/status/code/ms — no URL, id, header or body", async () => {
    const events: FeishuHttpEvent[] = [];
    const { fake, http } = rig({ events });
    fake.script(
      "GET",
      "/open-apis/im/v1/messages/om_SECRETID/x",
      { status: 400, json: { code: 77, msg: "m" } },
      { json: { code: 0, data: {} } },
    );
    await http.json({
      op: "probe",
      method: "GET",
      path: "/open-apis/im/v1/messages/om_SECRETID/x",
      token: "t-zzzzzzzzzzzzzzzzzzzz",
    });
    await http.json({
      op: "probe",
      method: "GET",
      path: "/open-apis/im/v1/messages/om_SECRETID/x",
      token: "t-zzzzzzzzzzzzzzzzzzzz",
    });
    expect(events).toEqual([
      { op: "probe", ok: false, outcome: "api-code-77", status: 400, code: 77, ms: 0 },
      { op: "probe", ok: true, outcome: "ok", status: 200, ms: 0 },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/SECRETID|zzzz|https/);
  });
});

describe("failure classification table", () => {
  it.each([
    ["destination", undefined, undefined, "none", false],
    ["bad-request", undefined, undefined, "none", false],
    ["auth", undefined, undefined, "none", false],
    ["unreachable", undefined, undefined, "unknown", true],
    ["timeout", undefined, undefined, "unknown", true],
    ["aborted", undefined, undefined, "unknown", false],
    ["too-large", undefined, undefined, "unknown", false],
    ["protocol", 200, undefined, "unknown", false],
    ["api", 200, 230020, "unknown", true],
    ["api", 200, 1, "none", true],
    ["api", 200, 1000040343, "none", true],
    ["api", 400, 99991672, "none", false],
    ["api", 502, 5, "unknown", true],
    ["http", 429, undefined, "none", true],
  ] as const)("%s status=%s code=%s ⇒ effect %s retryable %s", (kind, status, code, effect, retryable) => {
    const f = makeFailure(kind, "r", {
      ...(status !== undefined ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
    });
    expect({ effect: f.effect, retryable: f.retryable }).toEqual({ effect, retryable });
  });
});
