import { describe, expect, it } from "vitest";

import { createFeishuHttp } from "../../../../src/web-hub/hub/feishu/http.js";
import type { FeishuFailure, FeishuHttpEvent } from "../../../../src/web-hub/hub/feishu/http.js";
import { createTokenManager } from "../../../../src/web-hub/hub/feishu/token.js";
import type { TokenCredentials } from "../../../../src/web-hub/hub/feishu/token.js";
import { createFakeClock, createFakeFeishu, settle } from "../../../fixtures/feishu/fake-http.js";
import type { FakeFeishuOptions } from "../../../fixtures/feishu/fake-http.js";

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";

function rig(opts: { fake?: FakeFeishuOptions; base?: string; cooldownMs?: number; events?: FeishuHttpEvent[] } = {}) {
  const fake = createFakeFeishu(opts.fake);
  const clock = createFakeClock();
  const state: { creds: TokenCredentials | undefined } = {
    creds: { appId: fake.appId, appSecret: fake.appSecret, gen: 1 },
  };
  const http = createFeishuHttp({
    apiBase: opts.base ?? "https://open.feishu.cn",
    fetch: fake.fetch,
    clock,
    ...(opts.events ? { onEvent: (e) => opts.events!.push(e) } : {}),
  });
  const mgr = createTokenManager({
    http,
    clock,
    credentials: () => state.creds,
    ...(opts.cooldownMs !== undefined ? { authFailedCooldownMs: opts.cooldownMs } : {}),
  });
  return { fake, clock, state, http, mgr };
}

async function must(p: ReturnType<ReturnType<typeof rig>["mgr"]["get"]>) {
  const r = await p;
  if (!r.ok) throw new Error(`token failed: ${r.reason}`);
  return r.data;
}
function fail(r: Awaited<ReturnType<ReturnType<typeof rig>["mgr"]["get"]>>): FeishuFailure {
  if (r.ok) throw new Error("expected failure");
  return r;
}

describe("token cache", () => {
  it("fetches with the probe-verified request shape and serves the cache afterwards", async () => {
    const { fake, mgr } = rig();
    const a = await must(mgr.get());
    const b = await must(mgr.get());
    expect(b.token).toBe(a.token);
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(1);
    const c = fake.calls[0]!;
    expect(c.json).toEqual({ app_id: fake.appId, app_secret: fake.appSecret });
    expect(c.headers["authorization"]).toBeUndefined();
    expect(mgr.peek()).toBe(a.token);
  });

  it("refreshes exactly at expire − 300 s", async () => {
    const { fake, clock, mgr } = rig();
    const a = await must(mgr.get());
    clock.advance(6_899_999);
    expect((await must(mgr.get())).token).toBe(a.token);
    expect(fake.tokensIssued()).toBe(1);
    clock.advance(1); // 6 900 000 ms = 7200 s − 300 s
    const b = await must(mgr.get());
    expect(b.token).not.toBe(a.token);
    expect(fake.tokensIssued()).toBe(2);
  });

  it("a lifetime ≤ the margin is cached for half its lifetime (no refetch loop, no stale reuse)", async () => {
    const { fake, clock, mgr } = rig({ fake: { tokenExpireS: 200 } });
    await must(mgr.get());
    clock.advance(99_999);
    await must(mgr.get());
    expect(fake.tokensIssued()).toBe(1);
    clock.advance(1);
    await must(mgr.get());
    expect(fake.tokensIssued()).toBe(2);
  });

  it("a response without a usable `expire` is served once and never cached", async () => {
    const { fake, mgr } = rig();
    fake.on("POST", TOKEN_PATH, () => ({ json: { code: 0, tenant_access_token: `t-noexpire${"a".repeat(20)}` } }));
    const a = await must(mgr.get());
    const b = await must(mgr.get());
    expect(a.token).toBe(b.token); // same string from the handler…
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(2); // …but fetched twice
    expect(mgr.peek()).toBeUndefined();
  });

  it("single-flight: concurrent callers share one refresh", async () => {
    const { fake, mgr } = rig();
    const rs = await Promise.all(Array.from({ length: 8 }, () => mgr.get()));
    expect(new Set(rs.map((r) => (r.ok ? r.data.token : "x"))).size).toBe(1);
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(1);
  });

  it("invalidate(token) drops only that exact cached token", async () => {
    const { fake, mgr } = rig();
    const a = await must(mgr.get());
    expect(mgr.invalidate("t-someone-else")).toBe(false);
    expect(mgr.peek()).toBe(a.token);
    expect(mgr.invalidate(a.token)).toBe(true);
    expect(mgr.peek()).toBeUndefined();
    const b = await must(mgr.get());
    expect(b.token).not.toBe(a.token);
    expect(mgr.invalidate(a.token)).toBe(false); // stale token must not evict the new one
    expect(mgr.peek()).toBe(b.token);
    expect(fake.tokensIssued()).toBe(2);
  });
});

describe("failure classification", () => {
  it("wrong secret (V11: HTTP 200 + 10014) ⇒ auth_failed, negative-cached for the cooldown, then retried", async () => {
    const { fake, clock, state, mgr } = rig({ cooldownMs: 30_000 });
    state.creds = { ...state.creds!, appSecret: "wrong-secret-0123456789" };
    const f = fail(await mgr.get());
    expect(f).toMatchObject({ kind: "auth", auth: "auth_failed", code: 10014, effect: "none", retryable: false });
    expect(fail(await mgr.get()).auth).toBe("auth_failed");
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(1); // cooldown: no second platform hit
    clock.advance(29_999);
    await mgr.get();
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(1);
    clock.advance(1);
    await mgr.get();
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(2);
  });

  it.each([514, 403, 10003, 10014, 1000040345, 99999])("code %i ⇒ auth_failed", async (code) => {
    const { fake, mgr } = rig();
    fake.on("POST", TOKEN_PATH, () => ({ json: { code, msg: "nope" } }));
    expect(fail(await mgr.get())).toMatchObject({ kind: "auth", auth: "auth_failed", code });
  });

  it.each([1, 1000040343, 1000040350])(
    "busy/internal/conn-limit code %i ⇒ transient (never auth_failed), not cached",
    async (code) => {
      const { fake, mgr } = rig();
      fake.script("POST", TOKEN_PATH, { json: { code, msg: "busy" } });
      expect(fail(await mgr.get())).toMatchObject({ kind: "auth", auth: "transient", code, retryable: true });
      expect((await mgr.get()).ok).toBe(true); // next call retries immediately and succeeds
    },
  );

  it("network error / 5xx / timeout ⇒ transient, effect none for the caller's request, never cached", async () => {
    const { fake, clock, mgr } = rig();
    fake.script("POST", TOKEN_PATH, { networkError: true }, { status: 503, text: "x" }, { hang: true });
    expect(fail(await mgr.get())).toMatchObject({ auth: "transient", reason: "unreachable", effect: "none" });
    expect(fail(await mgr.get())).toMatchObject({ auth: "transient", reason: "http-503" });
    const p = mgr.get();
    await settle(2);
    clock.advance(8_000);
    expect(fail(await p)).toMatchObject({ auth: "transient", reason: "timeout" });
    expect((await mgr.get()).ok).toBe(true);
  });

  it("a malformed success body is transient", async () => {
    const { fake, mgr } = rig();
    fake.script(
      "POST",
      TOKEN_PATH,
      { json: { code: 0, expire: 7200 } },
      { json: { code: 0, tenant_access_token: "has space", expire: 7200 } },
      { json: { code: 0, tenant_access_token: "", expire: 7200 } },
    );
    for (let i = 0; i < 3; i++) expect(fail(await mgr.get())).toMatchObject({ auth: "transient" });
  });

  it("a disallowed base is refused without a fetch", async () => {
    const { fake, mgr } = rig({ base: "https://evil.example" });
    expect(fail(await mgr.get())).toMatchObject({ kind: "auth", auth: "refused" });
    expect(fake.calls).toHaveLength(0);
  });

  it("the platform message is redacted: the app secret echoed back never surfaces", async () => {
    const events: FeishuHttpEvent[] = [];
    const { fake, mgr } = rig({ events });
    fake.on("POST", TOKEN_PATH, () => ({ json: { code: 10014, msg: `invalid secret ${fake.appSecret}` } }));
    const f = fail(await mgr.get());
    expect(JSON.stringify([f, events])).not.toContain(fake.appSecret);
    expect(f.msg).toContain("[redacted]");
  });
});

describe("credentials / generation", () => {
  it("unconfigured while credentials() is undefined (and drops any cache)", async () => {
    const { fake, state, mgr } = rig();
    await must(mgr.get());
    state.creds = undefined;
    expect(fail(await mgr.get())).toMatchObject({ kind: "auth", auth: "unconfigured", effect: "none" });
    expect(mgr.peek()).toBeUndefined();
    state.creds = { appId: fake.appId, appSecret: fake.appSecret, gen: 1 };
    await must(mgr.get());
    expect(fake.tokensIssued()).toBe(2); // the cache did not survive the reset
  });

  it("a generation change invalidates the cache and uses the NEW credentials", async () => {
    const { fake, state, mgr } = rig();
    const a = await must(mgr.get());
    state.creds = { appId: fake.appId, appSecret: fake.appSecret, gen: 2 };
    const b = await must(mgr.get());
    expect(b.token).not.toBe(a.token);
    expect(b.gen).toBe(2);
    expect(fake.tokensIssued()).toBe(2);
  });

  it("a generation change clears the auth_failed cooldown at once", async () => {
    const { fake, state, mgr } = rig();
    state.creds = { appId: fake.appId, appSecret: "wrong-secret-0123456789", gen: 1 };
    expect(fail(await mgr.get()).auth).toBe("auth_failed");
    state.creds = { appId: fake.appId, appSecret: fake.appSecret, gen: 2 };
    expect((await mgr.get()).ok).toBe(true);
  });

  it("a refresh completing after the generation moved on is discarded (never cached for the new credentials)", async () => {
    const { fake, state, mgr } = rig();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    fake.on("POST", TOKEN_PATH, async (call) => {
      if (!first) return undefined;
      first = false;
      await gate;
      return { json: { code: 0, tenant_access_token: `t-oldgen${"o".repeat(24)}`, expire: 7200 } };
    });
    const old = mgr.get(); // gen 1, parked at the gate
    await settle(2);
    state.creds = { appId: fake.appId, appSecret: fake.appSecret, gen: 2 };
    const fresh = await must(mgr.get()); // gen 2: its own flight, not the parked gen-1 one
    expect(fresh.gen).toBe(2);
    release();
    expect(fail(await old)).toMatchObject({ kind: "auth", auth: "stale", retryable: true });
    expect(mgr.peek()).toBe(fresh.token); // the late old-gen token did not overwrite
    expect(JSON.stringify(await mgr.get())).not.toContain("oldgen");
  });

  it("dispose ⇒ unconfigured forever, cache empty", async () => {
    const { mgr } = rig();
    await must(mgr.get());
    mgr.dispose();
    expect(mgr.peek()).toBeUndefined();
    expect(fail(await mgr.get()).auth).toBe("unconfigured");
  });
});

describe("caller abort", () => {
  it("an aborted waiter returns aborted but the shared refresh still completes and caches", async () => {
    const { fake, mgr } = rig();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    fake.on("POST", TOKEN_PATH, async () => {
      if (!first) return undefined;
      first = false;
      await gate;
      return undefined; // fall through to the default handler
    });
    const ac = new AbortController();
    const waiter = mgr.get({ signal: ac.signal });
    const other = mgr.get();
    await settle(2);
    ac.abort();
    expect(fail(await waiter)).toMatchObject({ auth: "aborted" });
    release();
    const t = await must(other);
    expect(mgr.peek()).toBe(t.token);
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(1);
    // a cache hit needs no network, so a pre-aborted signal still gets the token…
    const done = new AbortController();
    done.abort();
    expect((await mgr.get({ signal: done.signal })).ok).toBe(true);
    // …but a miss with a pre-aborted signal starts no refresh at all
    mgr.invalidate(t.token);
    expect(fail(await mgr.get({ signal: done.signal })).auth).toBe("aborted");
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(1);
  });
});
