import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandCompleteRoutes,
  trimCompleteItems,
  type CommandCompleteIo,
} from "../../../src/web-hub/hub/command-complete.js";
import { strictCsrfOk } from "../../../src/web-hub/hub/http.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { CMD_ARGS } from "../../../src/web-hub/protocol/command-args.js";
import type { CompleteReplyFrame, CompleteReqFrame } from "../../../src/web-hub/protocol/messages.js";
import { auditCommandComplete } from "../../../src/web-hub/hub/audit.js";
import { createCmdLimit } from "../../../src/web-hub/hub/cmd-limit.js";
import { fakeConn, hello, memLog } from "./helpers.js";

class Response extends EventEmitter {
  status = 0;
  body: unknown;
  headers: Record<string, string> = {};
  writableFinished = false;
  destroyed = false;
  get headersSent(): boolean {
    return this.status !== 0;
  }
  close(): void {
    this.destroyed = true;
    this.emit("close");
  }
}
const caps = ["cmd.v1", "command.v1", "cmd.args.v1"];
function setup() {
  const log = memLog();
  const reg = createRegistry({ now: Date.now, log, pidAlive: () => true });
  const conn = fakeConn();
  const key = reg.register(hello({ caps }), conn).agentKey;
  reg.onFrame(key, {
    t: "commands",
    epoch: "e",
    items: [
      { name: "mem", description: "memory", kind: "extension", policy: "allow" },
      { name: "secret", description: "secret", kind: "extension", policy: "deny" },
    ],
  });
  const routes = createCommandCompleteRoutes({ registry: reg, now: Date.now, log });
  const invoke = (
    body: unknown = { agentKey: key, name: "mem", prefix: "sensitive-token" },
    over: Partial<CommandCompleteIo> = {},
    headers: Record<string, string> = {},
  ) => {
    const res = new Response();
    const req = {
      headers: { "x-pwh": "1", "content-type": "application/json", origin: "http://localhost:1234", ...headers },
    } as unknown as IncomingMessage;
    const io: CommandCompleteIo = {
      listener: "loopback",
      ip: "127.0.0.1",
      expectedOrigin: "http://localhost:1234",
      strictCsrfOk: () => strictCsrfOk(req, "http://localhost:1234"),
      authorize: async () => ({ ip: "127.0.0.1" }),
      readJson: async () => body,
      sendJson: (_res, status, out, h) => {
        res.status = status;
        res.body = out;
        res.headers = h ?? {};
        res.writableFinished = true;
        res.emit("close");
      },
      ...over,
    };
    const done = routes.handle(req, res as unknown as ServerResponse, io);
    return { res, done };
  };
  const latest = (): CompleteReqFrame => conn.sent.filter((f): f is CompleteReqFrame => f.t === "complete_req").at(-1)!;
  const answer = (frame = latest()) =>
    reg.onFrame(key, {
      t: "complete_reply",
      rid: frame.rid,
      ok: true,
      source: "own",
      items: [{ value: "sensitive-result", label: "result", policy: "confirm" }],
    });
  return { log, reg, conn, key, routes, invoke, latest, answer };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("command-complete admission and privacy", () => {
  it.each([
    { origin: "http://evil.example" },
    { origin: "null" },
    { origin: "" },
    { "x-pwh": "" },
    { "content-type": "text/plain" },
    { "sec-fetch-site": "same-site" },
  ])("strict CSRF rejects before auth/agent: %j", async (headers) => {
    const h = setup();
    const auth = vi.fn(async () => ({ ip: "x" }));
    const r = h.invoke(undefined, { authorize: auth }, headers);
    await r.done;
    expect(r.res.status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
    expect(h.conn.sent).toHaveLength(0);
  });
  it("authentication rejects before body or agent", async () => {
    const h = setup();
    const body = vi.fn();
    const r = h.invoke(undefined, { authorize: async () => ({ handled: true, code: "E_AUTH" }), readJson: body });
    await r.done;
    expect(body).not.toHaveBeenCalled();
    expect(h.conn.sent).toHaveLength(0);
    expect(h.log.lines.at(-1)?.data).toMatchObject({ code: "E_AUTH" });
  });
  it.each(["\n", "\r", "\t", "\x1b", "\x7f", "\x85", "界".repeat(342)])(
    "rejects unsafe or >1KiB prefix",
    async (prefix) => {
      const h = setup();
      const r = h.invoke({ agentKey: h.key, name: "mem", prefix });
      await r.done;
      expect(r.res.status).toBe(400);
      expect(h.conn.sent).toHaveLength(0);
    },
  );
  it("missing cap is local E_UNSUPPORTED (no registry.request)", async () => {
    const h = setup();
    const spy = vi.spyOn(h.reg, "request");
    h.reg.register(hello({ caps: ["cmd.v1", "command.v1"] }), h.conn);
    const r = h.invoke();
    await r.done;
    expect(r.res.status).toBe(501);
    expect(spy).not.toHaveBeenCalled();
  });
  it("denied (resolved override) commands and unknown commands never invoke completers", async () => {
    const h = setup();
    for (const [name, status] of [
      ["secret", 403],
      ["missing", 404],
    ] as const) {
      const r = h.invoke({ agentKey: h.key, name, prefix: "" });
      await r.done;
      expect(r.res.status).toBe(status);
    }
    expect(h.conn.sent).toHaveLength(0);
  });
  it.each(["loopback", "lan"] as const)(
    "%s: returns bounded results, forwards only listener origin, audits no text",
    async (listener) => {
      const h = setup();
      const r = h.invoke(undefined, { listener });
      await flush();
      const f = h.latest();
      expect(f.origin).toEqual({ listener });
      expect(f.prefix).toBe("sensitive-token");
      expect(f.deadlineMs).toBeLessThanOrEqual(2000);
      h.answer();
      await r.done;
      expect(r.res.status).toBe(200);
      expect(r.res.headers["Cache-Control"]).toBe("no-store");
      expect(r.res.body).toEqual({
        source: "own",
        items: [{ value: "sensitive-result", label: "result", policy: "confirm" }],
      });
      const audit = h.log.lines.filter((l) => l.msg === "command-complete");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.data).toMatchObject({ listener, name: "mem", plen: 15, hits: 1, source: "own" });
      expect(JSON.stringify(audit)).not.toContain("sensitive");
    },
  );
  it("drops a pending response if policy becomes deny", async () => {
    const h = setup();
    const r = h.invoke();
    await flush();
    h.reg.onFrame(h.key, {
      t: "commands",
      epoch: "e",
      items: [{ name: "mem", kind: "extension", description: "", policy: "deny" }],
    });
    h.answer();
    await r.done;
    expect(r.res.status).toBe(403);
    expect(JSON.stringify(r.res.body)).not.toContain("sensitive");
  });
  it("whitelist cannot leak extra fields even from an accidentally widened audit object", () => {
    const log = memLog();
    auditCommandComplete(log, { listener: "lan", name: "mem", prefix: "secret", items: ["secret"] } as Parameters<
      typeof auditCommandComplete
    >[1]);
    expect(log.lines[0]?.data).toEqual({ listener: "lan", name: "mem" });
  });
});

describe("limits, deadlines and disconnect", () => {
  it("per-principal in-flight <=3, close releases immediately, abort audit exactly once and no late writes", async () => {
    const h = setup();
    const a = h.invoke(),
      b = h.invoke(),
      c = h.invoke();
    await flush();
    expect(h.conn.sent).toHaveLength(3);
    const d = h.invoke();
    await d.done;
    expect(d.res.status).toBe(429);
    const old = h.latest();
    c.res.close();
    await c.done;
    expect(h.log.lines.filter((l) => (l.data as { code?: string })?.code === "aborted")).toHaveLength(1);
    const e = h.invoke();
    await flush();
    expect(h.conn.sent).toHaveLength(4);
    h.answer(old);
    expect(c.res.status).toBe(0);
    a.res.close();
    b.res.close();
    e.res.close();
    await Promise.all([a.done, b.done, e.done]);
  });
  it("global in-flight <=8 across principals/listeners", async () => {
    const h = setup();
    const active = Array.from({ length: 8 }, (_, n) =>
      h.invoke(undefined, { listener: "lan", authorize: async () => ({ ip: "x", user: `u${n}` }) }),
    );
    await flush();
    expect(h.conn.sent).toHaveLength(8);
    const over = h.invoke(undefined, { authorize: async () => ({ ip: "x", user: "ninth" }) });
    await over.done;
    expect(over.res.status).toBe(503);
    active.forEach((r) => r.res.close());
    await Promise.all(active.map((r) => r.done));
  });
  it("complete bucket is private and exhausts at eight, with Retry-After", async () => {
    vi.useFakeTimers();
    const h = setup();
    const cmdLimit = createCmdLimit(Date.now);
    for (let i = 0; i < 8; i++) {
      const r = h.invoke();
      await flush();
      h.answer();
      await r.done;
      expect(r.res.status).toBe(200);
    }
    const r = h.invoke();
    await r.done;
    expect(r.res.status).toBe(429);
    expect(r.res.headers["Retry-After"]).toBe("1");
    expect(cmdLimit.admit("loopback:token:complete", 8, 200)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(200);
    const next = h.invoke();
    await flush();
    h.answer();
    await next.done;
    expect(next.res.status).toBe(200);
  });
  it("agent bucket caps at fifteen per second across principals", async () => {
    vi.useFakeTimers();
    const h = setup();
    for (let n = 0; n < 15; n++) {
      const r = h.invoke(undefined, { authorize: async () => ({ ip: "x", user: `u${n}` }) });
      await flush();
      h.answer();
      await r.done;
      expect(r.res.status).toBe(200);
    }
    const over = h.invoke(undefined, { authorize: async () => ({ ip: "x", user: "sixteenth" }) });
    await over.done;
    expect(over.res.status).toBe(429);
    expect(h.conn.sent).toHaveLength(15);
  });
  it("LAN-IP bucket caps at twenty per two seconds across users before parsing", async () => {
    vi.useFakeTimers();
    const h = setup();
    for (let n = 0; n < 20; n++) {
      const r = h.invoke({}, { listener: "lan", authorize: async () => ({ ip: "x", user: `u${n}` }) });
      await r.done;
      expect(r.res.status).toBe(400);
    }
    const read = vi.fn();
    const over = h.invoke({}, { listener: "lan", authorize: async () => ({ ip: "x", user: "u21" }), readJson: read });
    await over.done;
    expect(over.res.status).toBe(429);
    expect(read).not.toHaveBeenCalled();
    expect(h.conn.sent).toHaveLength(0);
  });
  it("registry timeout is relative, <=2.5s, not Date.now(); timer is unref'd", async () => {
    vi.useFakeTimers();
    const h = setup();
    const spy = vi.spyOn(h.reg, "request");
    const timers = vi.spyOn(globalThis, "setTimeout");
    const r = h.invoke();
    await flush();
    expect(spy.mock.calls[0]?.[2]).toBe(2500);
    expect(h.latest().deadlineMs).toBe(2000);
    for (const result of timers.mock.results) if (result.type === "return") expect(result.value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(2500);
    await r.done;
    expect(r.res.status).toBe(504);
    h.answer();
    expect(r.res.status).toBe(504);
  });
  it("4s route deadline bounds a stuck auth and prevents late dispatch", async () => {
    vi.useFakeTimers();
    const h = setup();
    let auth!: (v: { ip: string }) => void;
    const r = h.invoke(undefined, {
      authorize: () =>
        new Promise((resolve) => {
          auth = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(4000);
    await r.done;
    expect(r.res.status).toBe(504);
    auth({ ip: "x" });
    await flush();
    expect(h.conn.sent).toHaveLength(0);
  });
  it("body time is deducted from frame and registry budgets", async () => {
    vi.useFakeTimers();
    const h = setup();
    const spy = vi.spyOn(h.reg, "request");
    const r = h.invoke(undefined, {
      readJson: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { agentKey: h.key, name: "mem", prefix: "" };
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.latest().deadlineMs).toBe(700);
    expect(spy.mock.calls[0]?.[2]).toBe(1000);
    h.answer();
    await r.done;
    expect(r.res.status).toBe(200);
  });
});

describe("registry complete_reply correlation", () => {
  it("requires correct rid, agentKey and pending frame type; abort settles early", async () => {
    const h = setup();
    const other = h.reg.register(hello({ agentId: { pid: 5151, nonce: "other-nonce" } }), fakeConn()).agentKey;
    const r = h.invoke();
    await flush();
    const f = h.latest();
    h.reg.onFrame(other, { t: "complete_reply", rid: f.rid, ok: true, source: "own", items: [] });
    h.answer({ ...f, rid: "wrong" });
    await flush();
    expect(r.res.status).toBe(0);
    h.answer();
    await r.done;
    expect(r.res.status).toBe(200);
    const ctl = new AbortController();
    const pending = h.reg.request<CompleteReplyFrame>(h.key, { ...f, rid: "" }, 1000, ctl.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: "E_DEADLINE" });
    ctl.abort();
    await rejection;
    const snapCtl = new AbortController();
    const snapshot = h.reg.request(h.key, { t: "snapshot_req", rid: "" }, 1000, snapCtl.signal);
    const snapshotReject = expect(snapshot).rejects.toMatchObject({ code: "E_DEADLINE" });
    const snapRid = h.conn.sent.at(-1)! as { rid: string };
    h.reg.onFrame(h.key, { t: "complete_reply", rid: snapRid.rid, ok: true, source: "own", items: [] });
    let settled = false;
    void snapshot.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);
    snapCtl.abort();
    await snapshotReject;
  });
});

describe("defensive trim", () => {
  it("enforces count, UTF-8 value bytes, single lines, dedup, total JSON bytes and known fields", () => {
    const raw = Array.from({ length: 100 }, (_, i) => ({
      value: `${i}${"界".repeat(160)}`,
      label: "x".repeat(120),
      description: "界".repeat(200),
    }));
    const r = trimCompleteItems(raw);
    expect(r.truncated).toBe(true);
    expect(r.items.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(CMD_ARGS.itemsTotalMaxBytes);
    expect(
      trimCompleteItems(Array.from({ length: 51 }, (_, i) => ({ value: String(i), label: "x" }))).items,
    ).toHaveLength(50);
    expect(
      trimCompleteItems([
        { value: "界".repeat(171), label: "x" },
        { value: " leading", label: "x" },
        { value: "a\nb", label: "x" },
        { value: "ok", label: "x" },
        { value: "ok", label: "dup" },
      ]),
    ).toEqual({ items: [{ value: "ok", label: "x" }], truncated: true });
  });
});
