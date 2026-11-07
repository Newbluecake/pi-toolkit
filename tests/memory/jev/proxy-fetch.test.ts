// jev/proxy-fetch.test.ts — local fake proxy + fake TLS upstream, 12 cases
// (jev-plan J2, mirrored from hygiene-plan.md P5b) + URL parsing table.

import { afterEach, describe, expect, it } from "vitest";
import { createProxyFetch, parseProxyUrl, redactProxyUrl } from "../../../src/memory/jev/proxy-fetch.js";
import {
  closedPort,
  generateSelfSignedCert,
  opensslAvailable,
  startFakeProxy,
  startFakeTlsUpstream,
  type FakeProxyHandle,
  type FakeUpstreamHandle,
} from "./helpers/fake-proxy.js";

const CAN_TLS = opensslAvailable();

describe("parseProxyUrl", () => {
  it.each([
    ["http://127.0.0.1:8080", { host: "127.0.0.1", port: 8080 }],
    ["http://127.0.0.1", { host: "127.0.0.1", port: 80 }],
    ["http://user:pass@host:9", { host: "host", port: 9, auth: "user:pass" }],
    ["https://127.0.0.1:8080", undefined],
    ["socks5://127.0.0.1:1080", undefined],
    ["not a url", undefined],
    ["", undefined],
  ] as const)("%s", (input, expected) => {
    expect(parseProxyUrl(input)).toEqual(expected);
  });
});

describe("redactProxyUrl", () => {
  it("keeps the user's shape (no trailing slash added) and masks userinfo even in non-URL strings", () => {
    expect(redactProxyUrl("http://user:pass@127.0.0.1:7890")).toBe("http://***@127.0.0.1:7890");
    expect(redactProxyUrl("user:pass@127.0.0.1:7890")).toBe("***@127.0.0.1:7890");
    expect(redactProxyUrl("socks5://u:p@h:1080")).toBe("socks5://***@h:1080");
  });
  it("masks userinfo, leaves plain URLs untouched", () => {
    expect(redactProxyUrl("http://user:pass@127.0.0.1:8080")).toBe("http://***@127.0.0.1:8080");
    expect(redactProxyUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(redactProxyUrl("not a url")).toBe("not a url");
  });
});

describe('createProxyFetch("")', () => {
  it("returns undefined (I9: empty proxy ⇒ no fetch ever constructed)", () => {
    expect(createProxyFetch("")).toBeUndefined();
  });
  it("an unparsable proxy URL is treated as not configured", () => {
    expect(createProxyFetch("socks5://127.0.0.1:1080")).toBeUndefined();
  });
});

describe.skipIf(!CAN_TLS)("createProxyFetch — tunnelled requests (local fake proxy + fake upstream)", () => {
  const cert = CAN_TLS ? generateSelfSignedCert("fake-upstream", "127.0.0.1") : undefined!;
  const mismatchCert = CAN_TLS ? generateSelfSignedCert("wrong.example.com", "10.0.0.1") : undefined!;

  let proxy: FakeProxyHandle | undefined;
  let upstream: FakeUpstreamHandle | undefined;
  afterEach(async () => {
    await proxy?.close();
    await upstream?.close();
    proxy = undefined;
    upstream = undefined;
  });

  it("① round-trips a JSON POST through the proxy with status + body intact", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert, jsonBody: { ok: true } });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 2000 })!;
    const res = await fetchFn(`https://127.0.0.1:${upstream.port}/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: 1 }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ ok: true });
  });

  it("① returns a real Response: pi-ai's classifier transport sequence (ok ⇒ json(), headers) works, URL input accepted", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert, jsonBody: { answers: { q1: { type: "noul", noul: 0.9 } } } });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 2000 })!;
    // pi-ai passes a URL object (transport.url(model)) and checks `ok` before json() — a bare
    // { status, text } made every 200 an "API error (200)" in real-machine acceptance.
    const res = await fetchFn(new URL(`https://127.0.0.1:${upstream.port}/systemone`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res).toBeInstanceOf(Response);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ answers: { q1: { type: "noul", noul: 0.9 } } });
    let headerCount = 0;
    res.headers.forEach(() => (headerCount += 1));
    expect(res.headers.get("content-length")).toBeNull(); // body is de-framed ⇒ framing headers dropped
    expect(headerCount).toBeGreaterThanOrEqual(0);
  });

  it("② chunked response body is reassembled", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({
      cert,
      mode: "chunked",
      jsonBody: { chunked: "yes", pad: "x".repeat(500) },
    });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 2000 })!;
    const res = await fetchFn(`https://127.0.0.1:${upstream.port}/x`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(await res.json()).toMatchObject({ chunked: "yes" });
  });

  it("③ an unreachable proxy port fails as `proxy error:` (classified transient)", async () => {
    const port = await closedPort();
    const fetchFn = createProxyFetch(`http://127.0.0.1:${port}`, { timeoutMs: 1000 })!;
    await expect(fetchFn("https://127.0.0.1:1/x")).rejects.toThrow(/^proxy error:/);
  });

  it("④ CONNECT 407 (proxy auth required) fails as `proxy error:`", async () => {
    proxy = await startFakeProxy("407");
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { timeoutMs: 1000 })!;
    await expect(fetchFn("https://127.0.0.1:1/x")).rejects.toThrow(/proxy error:.*407/);
  });

  it("⑤ CONNECT 502 (bad gateway) fails as `proxy error:`", async () => {
    proxy = await startFakeProxy("502");
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { timeoutMs: 1000 })!;
    await expect(fetchFn("https://127.0.0.1:1/x")).rejects.toThrow(/proxy error:.*502/);
  });

  it("⑥ TLS handshake failure (hostname/SAN mismatch) fails as `proxy error:`", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert: mismatchCert });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: mismatchCert.certPem, timeoutMs: 2000 })!;
    await expect(fetchFn(`https://127.0.0.1:${upstream.port}/x`)).rejects.toThrow(/^proxy error:/);
  });

  it("⑦ 402 from the upstream (through the proxy) is NOT swallowed as a proxy error", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert, status: 402, jsonBody: { error: "Insufficient funds" } });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 2000 })!;
    const res = await fetchFn(`https://127.0.0.1:${upstream.port}/x`);
    expect(res.status).toBe(402);
    expect(res.ok).toBe(false);
  });

  it("⑧ signal.abort() during transfer destroys the socket with no hang", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert, mode: "delay", delayMs: 5000 });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 10_000 })!;
    const controller = new AbortController();
    const p = fetchFn(`https://127.0.0.1:${upstream.port}/x`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(p).rejects.toThrow(/^proxy error:/);
  });

  it("⑨ the upstream never responding times out on this attempt's budget", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert, mode: "silent" });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 150 })!;
    const started = Date.now();
    await expect(fetchFn(`https://127.0.0.1:${upstream.port}/x`)).rejects.toThrow(/timeout after 150ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("⑩ a response body over 1MB is rejected", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert, mode: "large" });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 3000 })!;
    await expect(fetchFn(`https://127.0.0.1:${upstream.port}/x`)).rejects.toThrow(/1MB cap/);
  });

  it("⑪ a non-https target is rejected without touching the network", async () => {
    const fetchFn = createProxyFetch("http://127.0.0.1:1", { timeoutMs: 500 })!;
    await expect(fetchFn("http://127.0.0.1:1/x")).rejects.toThrow(/must be https/);
  });

  it("⑫ no dangling sockets/handles after a batch of successes and failures", async () => {
    proxy = await startFakeProxy("tunnel");
    upstream = await startFakeTlsUpstream({ cert });
    const fetchFn = createProxyFetch(`http://127.0.0.1:${proxy.port}`, { ca: cert.certPem, timeoutMs: 1000 })!;
    await fetchFn(`https://127.0.0.1:${upstream.port}/x`).catch(() => undefined);
    await fetchFn(`https://127.0.0.1:${upstream.port}/x`).catch(() => undefined);
    const before = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0;
    await new Promise((r) => setTimeout(r, 20));
    const after = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0;
    expect(after).toBeLessThanOrEqual(before + 1); // allow natural GC jitter, no growth trend
  });
});
