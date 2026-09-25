import { afterEach, describe, expect, it } from "vitest";
import { createClient, readHashToken, TOKEN_KEY, REQUEST_TIMEOUT_MS } from "../../../src/web-hub/web/app.js";
import { SILENCE_MS } from "../../../src/web-hub/web/contract.js";

/** Deterministic timer queue (no real timers, nothing can hang). */
function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    pending: () => timers.size,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  closed = false;
  listeners = new Map<string, Array<(ev: any) => void>>();
  constructor(readonly url: string) {
    FakeES.all.push(this);
  }
  addEventListener(name: string, fn: (ev: any) => void) {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  emit(name: string, data: unknown, lastEventId = "") {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data), lastEventId });
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    for (const fn of this.listeners.get("error") ?? []) fn({});
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

type Resp = { ok: boolean; status: number; json(): Promise<any> };
const resp = (status: number, body: unknown = {}): Resp => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function env(opts: { hash?: string; stored?: string; fetch?: (url: string, init: any) => Promise<Resp> } = {}) {
  const c = clock();
  const store = new Map<string, string>();
  if (opts.stored) store.set(TOKEN_KEY, opts.stored);
  const calls: Array<{ url: string; init: any }> = [];
  const messages: any[] = [];
  const conns: string[] = [];
  const replaced: string[] = [];
  const location = { hash: opts.hash ?? "", pathname: "/", search: "?x=1" };
  const client = createClient({
    fetch: (url: string, init: any) => {
      calls.push({ url, init });
      return opts.fetch ? opts.fetch(url, init) : Promise.resolve(resp(200));
    },
    EventSource: FakeES as any,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    location,
    history: {
      replaceState: (_d: unknown, _u: string, url?: string) => {
        replaced.push(String(url));
        location.hash = "";
      },
    },
    setTimeout: c.setTimeout as any,
    clearTimeout: c.clearTimeout as any,
    now: c.now,
    onMessage: (m) => messages.push(m),
    onConn: (s) => conns.push(s),
  });
  return { c, store, calls, messages, conns, replaced, client, location };
}

afterEach(() => {
  FakeES.all = [];
});

describe("readHashToken", () => {
  it("parses #t= among params; rejects missing/oversized", () => {
    expect(readHashToken("#t=abc")).toBe("abc");
    expect(readHashToken("#x=1&t=a-b_c")).toBe("a-b_c");
    expect(readHashToken("")).toBeUndefined();
    expect(readHashToken("#t=")).toBeUndefined();
    expect(readHashToken("t=abc")).toBeUndefined();
    expect(readHashToken(`#t=${"a".repeat(600)}`)).toBeUndefined();
    expect(readHashToken(undefined)).toBeUndefined();
  });
});

describe("createClient", () => {
  it("hash token → POST /api/login with X-PWH:1 → stored → hash cleared → one EventSource", async () => {
    const e = env({ hash: "#t=tok123" });
    await e.client.start();
    expect(e.calls[0]!.url).toBe("/api/login");
    expect(e.calls[0]!.init.method).toBe("POST");
    expect(e.calls[0]!.init.headers).toMatchObject({ "Content-Type": "application/json", "X-PWH": "1" });
    expect(JSON.parse(e.calls[0]!.init.body)).toEqual({ token: "tok123" });
    expect(e.store.get(TOKEN_KEY)).toBe("tok123");
    expect(e.replaced).toEqual(["/?x=1"]);
    expect(FakeES.all).toHaveLength(1);
    expect(FakeES.all[0]!.url).toBe("/api/events");
    e.client.close();
    expect(e.c.pending()).toBe(0);
  });

  it("no hash: opens the stream directly with the existing cookie", async () => {
    const e = env();
    await e.client.start();
    expect(e.calls).toHaveLength(0);
    expect(FakeES.all).toHaveLength(1);
    e.client.close();
  });

  it("frames are parsed and forwarded with numeric ids; malformed JSON ignored; hello ⇒ open", async () => {
    const e = env();
    await e.client.start();
    const es = FakeES.all[0]!;
    es.emit("hello", { clientId: "c1" }, "5");
    es.emit("ping", {});
    for (const fn of es.listeners.get("ev") ?? []) fn({ data: "{not json", lastEventId: "6" });
    expect(e.messages).toEqual([
      { event: "hello", data: { clientId: "c1" }, id: 5 },
      { event: "ping", data: {} },
    ]);
    expect(e.conns.at(-1)).toBe("open");
    e.client.close();
  });

  it("45s without any frame ⇒ closes and reopens exactly one stream", async () => {
    const e = env();
    await e.client.start();
    const first = FakeES.all[0]!;
    await e.c.advance(SILENCE_MS - 5_000);
    first.emit("ping", {}); // keeps it alive
    await e.c.advance(SILENCE_MS - 5_000);
    expect(FakeES.all).toHaveLength(1);
    await e.c.advance(10_000);
    expect(FakeES.all).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(FakeES.all.filter((x) => !x.closed)).toHaveLength(1);
    // frames from the stale stream are dropped
    first.emit("hello", { clientId: "old" });
    expect(e.messages.some((m) => m.data?.clientId === "old")).toBe(false);
    e.client.close();
    expect(e.c.pending()).toBe(0);
  });

  it("stream CLOSED (401) ⇒ one silent re-login with the stored token, then reopen", async () => {
    const e = env({ stored: "saved" });
    await e.client.start();
    FakeES.all[0]!.fail(true);
    await flush();
    expect(e.calls.map((x) => x.url)).toEqual(["/api/login"]);
    expect(JSON.parse(e.calls[0]!.init.body)).toEqual({ token: "saved" });
    await e.c.advance(1_000);
    expect(FakeES.all).toHaveLength(2);
    // second failure before any hello: no second re-login (only once), backoff grows
    FakeES.all[1]!.fail(true);
    await flush();
    expect(e.calls).toHaveLength(1);
    await e.c.advance(1_999);
    expect(FakeES.all).toHaveLength(2);
    await e.c.advance(1);
    expect(FakeES.all).toHaveLength(3);
    // hello resets the one-shot re-login
    FakeES.all[2]!.emit("hello", { clientId: "c" });
    FakeES.all[2]!.fail(true);
    await flush();
    expect(e.calls).toHaveLength(2);
    e.client.close();
  });

  it("CLOSED without any stored token ⇒ conn=auth (still retries with backoff)", async () => {
    const e = env();
    await e.client.start();
    FakeES.all[0]!.fail(true);
    await flush();
    expect(e.conns.at(-1)).toBe("auth");
    await e.c.advance(1_000);
    expect(FakeES.all).toHaveLength(2);
    e.client.close();
  });

  it("transient error (CONNECTING) leaves reconnection to EventSource", async () => {
    const e = env();
    await e.client.start();
    FakeES.all[0]!.fail(false);
    await flush();
    expect(e.conns.at(-1)).toBe("reconnecting");
    expect(e.calls).toHaveLength(0);
    expect(FakeES.all).toHaveLength(1);
    e.client.close();
  });

  it("API 401 ⇒ re-login once and retry; second 401 is returned as error", async () => {
    let subscribeCalls = 0;
    const e = env({
      stored: "saved",
      fetch: async (url) => {
        if (url === "/api/login") return resp(200);
        subscribeCalls++;
        return subscribeCalls === 1 ? resp(401, { error: "E_AUTH" }) : resp(200);
      },
    });
    await e.client.start();
    expect(await e.client.subscribe("c1", "A")).toEqual({ ok: true });
    expect(e.calls.map((x) => x.url)).toEqual(["/api/subscribe", "/api/login", "/api/subscribe"]);
    expect(JSON.parse(e.calls[0]!.init.body)).toEqual({ clientId: "c1", agentKey: "A" });
    expect(e.calls[0]!.init.headers["X-PWH"]).toBe("1");
    e.client.close();
  });

  it("API requests have a deadline: a hung fetch resolves as E_DEADLINE", async () => {
    const e = env({ fetch: () => new Promise<Resp>(() => {}) });
    await e.client.start();
    const p = e.client.page("A", "e1", 9999);
    await e.c.advance(REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ ok: false, error: "E_DEADLINE" });
    expect(e.calls[0]!.url).toBe("/api/history?agent=A&before=e1&limit=400");
    e.client.close();
  });

  it("page returns parsed payload; error bodies surface their code", async () => {
    const e = env({
      fetch: async (url) =>
        url.includes("agent=B") ? resp(404, { error: "E_NOT_FOUND" }) : resp(200, { agentKey: "A", entries: [] }),
    });
    await e.client.start();
    expect(await e.client.page("A", "x")).toEqual({ ok: true, data: { agentKey: "A", entries: [] } });
    expect(await e.client.page("B", "x")).toEqual({ ok: false, error: "E_NOT_FOUND" });
    e.client.close();
  });

  it("failed hash login falls back to the stored token and still clears the hash", async () => {
    const e = env({
      hash: "#t=bad",
      stored: "good",
      fetch: async (_u, init) => (JSON.parse(init.body).token === "good" ? resp(200) : resp(401)),
    });
    await e.client.start();
    expect(e.calls.map((x) => JSON.parse(x.init.body).token)).toEqual(["bad", "good"]);
    expect(e.store.get(TOKEN_KEY)).toBe("good");
    expect(e.location.hash).toBe("");
    e.client.close();
  });

  it("close() stops everything: no reopen after close", async () => {
    const e = env();
    await e.client.start();
    e.client.close();
    FakeES.all[0]!.fail(true);
    await e.c.advance(120_000);
    expect(FakeES.all).toHaveLength(1);
    expect(e.c.pending()).toBe(0);
  });
});
