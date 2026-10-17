import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProxyPortsMap,
  parseProxyPortsFile,
  type ProxyPortsFs,
  type ProxyPortsHandle,
} from "../../../../src/web-hub/hub/proxy/ports-map.js";
import { canonicalAddr, parseProxyTarget, proxyTargetKey } from "../../../../src/web-hub/hub/proxy/target.js";
import { PROXY_PORT_BIND_ATTEMPTS } from "../../../../src/web-hub/protocol/proxy.js";
import { deferred, flush, manualClock } from "./helpers.js";

const range = [7900, 7902] as const;
const stateDir = "/state";
const file = "/state/proxy/ports.json";
const key = (i: number) => `127.0.0.1|${3000 + i}|localhost:${3000 + i}`;
const entry = (i: number, port = 7900 + i) => ({ key: key(i), port, boundAt: 1000 });
const json = (entries: unknown[], v = 1) => JSON.stringify({ v, entries });
const error = (code: string) => Object.assign(new Error("DO_NOT_LOG"), { code });

function memoryFs(initial?: string) {
  const data = new Map<string, Buffer>();
  if (initial !== undefined) data.set(file, Buffer.from(initial));
  const events: string[] = [];
  const opens: Array<{ path: string; flags: number; mode: number | undefined }> = [];
  const modes = new Map<string, number>();
  let outstanding = 0;
  let maxOutstanding = 0;
  const hook = { run: async (_step: string) => {} };
  const step = async <T>(event: string, fn: () => T): Promise<T> => {
    events.push(event);
    outstanding += 1;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    try {
      await hook.run(event);
      return fn();
    } finally {
      outstanding -= 1;
    }
  };
  const port: ProxyPortsFs = {
    async open(path, flags, mode) {
      opens.push({ path, flags, mode });
      const kind = path === file ? "file" : path.endsWith(".tmp") ? "temp" : "dir";
      return step(`open-${kind}`, () => {
        if (kind === "file" && !data.has(path)) throw error("ENOENT");
        if (kind === "temp") {
          if (data.has(path)) throw error("EEXIST");
          data.set(path, Buffer.alloc(0));
          modes.set(path, mode!);
        }
        const handle: ProxyPortsHandle = {
          stat: () => step(`stat-${kind}`, () => ({ size: data.get(path)?.length ?? 0, isFile: () => kind !== "dir" })),
          read: (buffer, offset, length, position) =>
            step(`read-${kind}`, () => ({
              bytesRead: data.get(path)!.copy(buffer, offset, position, position + length),
            })),
          chmod: (m) =>
            step(`chmod-${kind}`, () => {
              modes.set(path, m);
            }),
          writeFile: (text) =>
            step(`write-${kind}`, () => {
              data.set(path, Buffer.from(text));
            }),
          sync: () => step(`sync-${kind}`, () => {}),
          close: () => step(`close-${kind}`, () => {}),
        };
        return handle;
      });
    },
    mkdir: () => step("mkdir", () => undefined),
    rename: (from, to) =>
      step("rename", () => {
        data.set(to, data.get(from)!);
        data.delete(from);
        modes.set(to, modes.get(from)!);
        modes.delete(from);
      }),
    unlink: (path) =>
      step("unlink", () => {
        if (!data.delete(path)) throw error("ENOENT");
      }),
  };
  return {
    fs: port,
    data,
    events,
    opens,
    modes,
    hook,
    outstanding: () => outstanding,
    maxOutstanding: () => maxOutstanding,
  };
}
function fixture(initial?: string, r: readonly [number, number] = range, maxBytes?: number) {
  const clock = manualClock();
  const mem = memoryFs(initial);
  let serial = 0;
  const store = createProxyPortsMap({
    stateDir,
    range: r,
    fs: mem.fs,
    now: clock.now,
    timer: clock.timer,
    tempId: () => `test-${++serial}`,
    ...(maxBytes === undefined ? {} : { budgets: { maxBytes } }),
  });
  return { store, mem, clock };
}
function listener(value = "listener") {
  return { value, close: vi.fn() };
}

describe("T-F5 strict permanent ports.json", () => {
  it("missing means empty, read-once, zero disk creation until a real bind", async () => {
    const f = fixture();
    expect(await Promise.all([f.store.load(), f.store.load()])).toEqual([true, true]);
    expect(f.store.status()).toBe("ok");
    expect(f.store.entries()).toEqual([]);
    expect(f.mem.events).toEqual(["open-dir", "close-dir", "open-file"]);
    expect(f.mem.data.size).toBe(0);
    expect(f.clock.pending()).toBe(0);
  });
  it.each([
    "not json",
    "\ufeff" + json([]),
    '{"v":1,"v":1,"entries":[]}',
    String.raw`{"v":1,"\u0076":1,"entries":[]}`,
    `{"v":1,"entries":[${JSON.stringify(entry(0))}],"entries":[]}`,
    `{"v":1,"entries":[{"key":"${key(0)}","port":7900,"port":7901,"boundAt":1000}]}`,
    String.raw`{"v":1,"entries":[{"key":"127.0.0.1|3000|localhost:3000","port":7900,"\u0070ort":7901,"boundAt":1000}]}`,
    "null",
    "[]",
    "{}",
    json([], 2),
    JSON.stringify({ v: 1, entries: [], extra: 1 }),
    json([{ ...entry(0), unknown: "field" }]),
    json([{ key: key(0), port: 7900 }]),
    json([entry(0), entry(1, 7900)]),
    json([entry(0), { ...entry(0), port: 7901 }]),
    json([entry(0, 7899)]),
    json([entry(0, 7903)]),
    json([{ ...entry(0), port: 7900.5 }]),
    json([{ ...entry(0), boundAt: -1 }]),
    json([{ ...entry(0), boundAt: 1.5 }]),
    json([{ ...entry(0), boundAt: "1000" }]),
    json([{ ...entry(0), key: "127.1|3000|localhost:3000" }]),
    json([{ ...entry(0), key: "127.0.0.1|03000|localhost:3000" }]),
    json([{ ...entry(0), key: "127.0.0.1|3000|localhost:3001" }]),
    json([{ ...entry(0), key: "8.8.8.8|3000|localhost:3000" }]),
    " ".repeat(65537),
    json(Array.from({ length: 4 }, (_, i) => entry(i))),
  ])("corrupt/wrong/duplicate/oversize => permanently broken, file unchanged (%s)", async (initial) => {
    const f = fixture(initial);
    const before = f.mem.data.get(file)!.toString("hex");
    const dial = vi.fn();
    expect(await f.store.load()).toBe(false);
    expect(f.store.status()).toBe("broken");
    for (let i = 0; i < 2; i++) expect(await f.store.bind(key(0), dial)).toEqual({ ok: false, reason: "ports-store" });
    expect(dial).not.toHaveBeenCalled();
    expect(f.mem.data.get(file)!.toString("hex")).toBe(before);
    expect(f.mem.events).not.toContain("mkdir");
    expect(f.mem.events).not.toContain("rename");
    expect(f.mem.events).not.toContain("unlink");
    expect(f.mem.events.filter((e) => e === "open-file")).toHaveLength(1);
  });
  it("unreadable is NOT ENOENT; invalid UTF8 refuses; only regular files accepted", async () => {
    const f = fixture(json([]));
    f.mem.hook.run = async (e) => {
      if (e === "open-file") throw error("EACCES");
    };
    expect(await f.store.load()).toBe(false);
    expect(f.store.status()).toBe("broken");
    expect(f.mem.data.get(file)!.toString()).toBe(json([]));
    const g = fixture();
    g.mem.data.set(file, Buffer.from([0xff]));
    expect(await g.store.load()).toBe(false);
    const h = fixture();
    const directoryHandle = await h.mem.fs.open("/directory", constants.O_RDONLY);
    const io: ProxyPortsFs = { ...h.mem.fs, open: async () => directoryHandle };
    const store = createProxyPortsMap({ stateDir, range, fs: io, now: h.clock.now, timer: h.clock.timer });
    expect(await store.load()).toBe(false);
  });
  it("strict parser accepts configured range up to 256 (not a hard-coded 50), default authority and canonical IPv6", () => {
    const entries = Array.from({ length: 256 }, (_, i) => ({ key: key(i), port: 8000 + i, boundAt: 0 }));
    expect(parseProxyPortsFile(json(entries), [8000, 8255])).toEqual(entries);
    const forms = ["127.0.0.1|80|localhost", "fd12::1|80|[fd12::1]", "127.0.0.1|3000|127.0.0.1:3000"];
    expect(parseProxyPortsFile(String.raw`{"\u0076":1,"entries":[]}`, range)).toEqual([]);
    expect(
      parseProxyPortsFile(json([{ ...entry(0), key: "127.0.0.1|3000|[::ffff:7f00:1]:3000" }]), range),
    ).toBeUndefined();
    for (const k of forms) expect(parseProxyPortsFile(json([{ key: k, port: 7900, boundAt: 0 }]), range)).toBeDefined();
    expect(
      parseProxyPortsFile(json([{ key: "::ffff:7f00:1|80|localhost", port: 7900, boundAt: 0 }]), range),
    ).toBeUndefined();
  });
  it("sticky reuse, lowest unmapped, permanent exhaustion => ports-exhausted without ever reassigning", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++)
      expect(await f.store.bind(key(i), async () => listener(`l${i}`))).toEqual({
        ok: true,
        port: 7900 + i,
        reused: false,
        value: `l${i}`,
      });
    const before = f.mem.data.get(file)!.toString();
    const events = f.mem.events.length;
    const known = vi.fn(async () => listener("reused"));
    expect(await f.store.bind(key(0), known)).toEqual({ ok: true, port: 7900, reused: true, value: "reused" });
    expect(known).toHaveBeenCalledWith(7900);
    expect(f.mem.events.length).toBe(events);
    const dial = vi.fn();
    expect(await f.store.bind(key(9), dial)).toEqual({ ok: false, reason: "ports-exhausted" });
    expect(dial).not.toHaveBeenCalled();
    expect(f.mem.data.get(file)!.toString()).toBe(before);
    expect(f.store.reserved).toBe(0);
    const again = fixture(before);
    expect(await again.store.bind(key(1), async () => listener("after restart"))).toMatchObject({
      ok: true,
      port: 7901,
      reused: true,
    });
  });
  it("mapped IPv6 and IPv4 literal aliases reuse ONE permanent port and canonical Host", async () => {
    const f = fixture();
    let expected: string | undefined;
    for (const input of ["[::ffff:7f00:1]:80", "127.0.0.1:80", "[::ffff:127.0.0.1]:80"]) {
      const parsed = parseProxyTarget(input);
      if (!parsed.ok) throw new Error("parse failed");
      expect(parsed.target.hostHeader).toBe("127.0.0.1");
      const k = proxyTargetKey(canonicalAddr(parsed.target.host)!, parsed.target);
      expected ??= k;
      expect(k).toBe(expected);
      expect(await f.store.bind(k, async () => listener())).toMatchObject({ ok: true, port: 7900 });
    }
    expect(f.store.entries()).toEqual([{ key: "127.0.0.1|80|127.0.0.1", port: 7900, boundAt: 1000 }]);
    expect(f.mem.events.filter((e) => e === "rename")).toHaveLength(1);
    const restarted = fixture(f.mem.data.get(file)!.toString());
    expect(await restarted.store.bind(expected!, async () => listener())).toMatchObject({
      ok: true,
      port: 7900,
      reused: true,
    });
  });
  it("serialization capacity rejects only that bind; queued smaller binds and known bindings still work", async () => {
    const host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    const f = fixture(json([entry(0)]), range, 250);
    const tooLarge = `127.0.0.1|4000|${host}:4000`;
    expect(Buffer.byteLength(json([entry(0), { key: tooLarge, port: 7901, boundAt: 1000 }]))).toBeGreaterThan(250);
    const rejected = listener("too large");
    const accepted = listener("fits");
    const [a, b] = await Promise.all([
      f.store.bind(tooLarge, async () => rejected),
      f.store.bind(key(1), async () => accepted),
    ]);
    expect(a).toEqual({ ok: false, reason: "ports-store" });
    expect(b).toMatchObject({ ok: true, value: "fits" });
    expect(rejected.close).toHaveBeenCalledOnce();
    expect(accepted.close).not.toHaveBeenCalled();
    expect(f.store.status()).toBe("ok");
    expect(f.store.reserved).toBe(0);
    expect(await f.store.bind(key(0), async () => listener())).toMatchObject({ ok: true, port: 7900, reused: true });
    expect(JSON.parse(f.mem.data.get(file)!.toString()).entries.map((e: { key: string }) => e.key)).toEqual([
      key(0),
      key(1),
    ]);
  });
  it("an actual >64 KiB serialization does not break the loaded store or overwrite existing bytes", async () => {
    const host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    const entries: Array<{ key: string; port: number; boundAt: number }> = [];
    let next!: { key: string; port: number; boundAt: number };
    for (let i = 0; i < 256; i++) {
      next = { key: `127.0.0.1|${3000 + i}|${host}:${3000 + i}`, port: 8000 + i, boundAt: 1000 };
      if (Buffer.byteLength(json([...entries, next])) > 64 * 1024) break;
      entries.push(next);
    }
    const initial = json(entries);
    expect(Buffer.byteLength(initial)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(json([...entries, next]))).toBeGreaterThan(64 * 1024);
    const f = fixture(initial, [8000, 8255]);
    const lease = listener();
    expect(await f.store.bind(next.key, async () => lease)).toEqual({ ok: false, reason: "ports-store" });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(f.store.status()).toBe("ok");
    expect(f.store.reserved).toBe(0);
    expect(f.mem.data.get(file)!.toString()).toBe(initial);
    expect(f.mem.events).not.toContain("write-temp");
    expect(await f.store.bind(entries[0]!.key, async () => listener())).toMatchObject({
      ok: true,
      port: 8000,
      reused: true,
    });
  });
  it("EADDRINUSE skips only for NEW targets, at most eight; mapped targets never move", async () => {
    const f = fixture();
    const dial = vi.fn(async (port: number) => {
      if (port === 7900) throw error("EADDRINUSE");
      return listener();
    });
    expect(await f.store.bind(key(0), dial)).toMatchObject({ ok: true, port: 7901 });
    expect(dial.mock.calls).toEqual([[7900], [7901]]);
    const known = vi.fn(async () => {
      throw error("EADDRINUSE");
    });
    expect(await f.store.bind(key(0), known)).toEqual({ ok: false, reason: "port-busy" });
    expect(known).toHaveBeenCalledTimes(1);
    expect(known).toHaveBeenCalledWith(7901);
    const g = fixture(undefined, [7900, 7949]);
    const busy = vi.fn(async () => {
      throw error("EADDRINUSE");
    });
    expect(await g.store.bind(key(0), busy)).toEqual({ ok: false, reason: "port-busy" });
    expect(busy).toHaveBeenCalledTimes(PROXY_PORT_BIND_ATTEMPTS);
    expect(g.store.entries()).toEqual([]);
    expect(g.store.status()).toBe("ok");
    expect(g.store.reserved).toBe(0);
    const other = vi.fn(async () => {
      throw error("EACCES");
    });
    expect(await g.store.bind(key(0), other)).toEqual({ ok: false, reason: "port-busy" });
    expect(other).toHaveBeenCalledOnce();
  });
  it("atomic write/fsync/rename/dir-fsync/0600 order; code boundary sees the durable map", async () => {
    const f = fixture();
    const events = f.mem.events;
    const lease = listener();
    const makeCode = vi.fn(() => {
      expect(f.mem.data.get(file)!.toString()).toBe(json([entry(0)]));
      expect(events.at(-1)).toBe("close-dir");
      return "code";
    });
    const result = await f.store.bind(key(0), async (port) => {
      events.push(`listen-${port}`);
      return lease;
    });
    if (result.ok) makeCode();
    expect(makeCode).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "open-dir",
      "close-dir",
      "open-file",
      "listen-7900",
      "mkdir",
      "open-dir",
      "open-temp",
      "chmod-temp",
      "write-temp",
      "sync-temp",
      "close-temp",
      "rename",
      "sync-dir",
      "close-dir",
    ]);
    expect(f.mem.modes.get(file)).toBe(0o600);
    expect(lease.close).not.toHaveBeenCalled();
    const temp = f.mem.opens.find((o) => o.path.endsWith(".tmp"))!;
    expect(temp.flags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(temp.flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(temp.mode).toBe(0o600);
    expect(f.mem.maxOutstanding()).toBe(1);
    expect(f.clock.pending()).toBe(0);
  });
  it.each(["mkdir", "open-temp", "chmod-temp", "write-temp", "sync-temp", "rename", "open-dir", "sync-dir"])(
    "failed %s closes listener, releases reservation, no code, permanent fail-closed",
    async (stage) => {
      const original = json([entry(0)]);
      const f = fixture(original);
      expect(await f.store.load()).toBe(true);
      const lease = listener();
      const makeCode = vi.fn();
      f.mem.hook.run = async (event) => {
        if (event === stage) throw error("EACCES");
      };
      const r = await f.store.bind(key(1), async () => lease);
      if (r.ok) makeCode();
      expect(r).toEqual({ ok: false, reason: "ports-store" });
      expect(f.store.status()).toBe("broken");
      expect(lease.close).toHaveBeenCalledOnce();
      expect(makeCode).not.toHaveBeenCalled();
      expect(f.store.reserved).toBe(0);
      const after = f.mem.data.get(file)!.toString();
      if (stage !== "sync-dir") expect(after).toBe(original);
      expect(JSON.parse(after).entries).toContainEqual(entry(0));
      const count = f.mem.events.length;
      expect(await f.store.bind(key(2), vi.fn())).toEqual({ ok: false, reason: "ports-store" });
      expect(f.mem.events.length).toBe(count);
      expect(f.mem.data.get(file)!.toString()).toBe(after); // no cleanup/reset of committed file
    },
  );
  it("EEXIST temp file is not ours: never unlink it or rewrite the final file", async () => {
    const f = fixture(json([]));
    const temp = "/state/proxy/.ports.json.test-1.tmp";
    f.mem.data.set(temp, Buffer.from("somebody else's bytes"));
    expect(await f.store.bind(key(0), async () => listener())).toEqual({ ok: false, reason: "ports-store" });
    expect(f.mem.data.get(temp)!.toString()).toBe("somebody else's bytes");
    expect(f.mem.events).not.toContain("unlink");
    expect(f.mem.data.get(file)!.toString()).toBe(json([]));
  });
  it("concurrent binds reserve distinct lowest ports, write single-flight, no lost updates", async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.mem.hook.run = async (e) => {
      if (e === "write-temp") await gate.promise;
    };
    const a = f.store.bind(key(0), async () => listener("a"));
    await flush();
    const b = f.store.bind(key(1), async () => listener("b"));
    const c = f.store.bind(key(2), async () => listener("c"));
    await flush();
    expect(f.store.reserved).toBe(3);
    expect(f.mem.outstanding()).toBe(1);
    gate.resolve();
    const all = await Promise.all([a, b, c]);
    expect(all.map((r) => r.ok && r.port)).toEqual([7900, 7901, 7902]);
    expect(f.mem.maxOutstanding()).toBe(1);
    expect(f.store.entries()).toEqual([entry(0), entry(1), entry(2)]);
    expect(f.store.reserved).toBe(0);
    expect(JSON.parse(f.mem.data.get(file)!.toString()).entries).toEqual([entry(0), entry(1), entry(2)]);
  });
  it("transient reservations are port-busy, not permanent exhaustion; same-key duplicate never dials", async () => {
    const f = fixture(undefined, [7900, 7900]);
    const gate = deferred<ReturnType<typeof listener>>();
    const first = f.store.bind(key(0), () => gate.promise);
    await flush();
    const dial = vi.fn();
    expect(await f.store.bind(key(0), dial)).toEqual({ ok: false, reason: "port-busy" });
    expect(await f.store.bind(key(1), dial)).toEqual({ ok: false, reason: "port-busy" });
    expect(dial).not.toHaveBeenCalled();
    gate.resolve(listener());
    expect(await first).toMatchObject({ ok: true, port: 7900 });
    expect(await f.store.bind(key(1), dial)).toEqual({ ok: false, reason: "ports-exhausted" });
  });
  it("a real write failure latches broken BEFORE the next queued writer is released", async () => {
    const f = fixture(json([]));
    const gate = deferred<void>();
    const a = listener("a");
    const b = listener("b");
    f.mem.hook.run = async (e) => {
      if (e === "write-temp") {
        await gate.promise;
        throw error("EIO");
      }
    };
    const first = f.store.bind(key(0), async () => a);
    await flush();
    const second = f.store.bind(key(1), async () => b);
    await flush();
    gate.resolve();
    expect(await first).toEqual({ ok: false, reason: "ports-store" });
    expect(await second).toEqual({ ok: false, reason: "ports-store" });
    expect(f.mem.events.filter((e) => e === "open-temp")).toHaveLength(1);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(f.store.reserved).toBe(0);
    expect(f.mem.data.get(file)!.toString()).toBe(json([]));
  });
  it("load timeout refuses forever, holds zombie IO; late open closes, no later read/write", async () => {
    const f = fixture(json([]));
    const gate = deferred<void>();
    f.mem.hook.run = async (e) => {
      if (e === "open-file") await gate.promise;
    };
    const load = f.store.load();
    await flush();
    f.clock.advance(1000);
    expect(await load).toBe(false);
    expect(f.store.status()).toBe("broken");
    expect(f.mem.outstanding()).toBe(1);
    expect(await f.store.bind(key(0), vi.fn())).toEqual({ ok: false, reason: "ports-store" });
    gate.resolve();
    await flush();
    expect(f.mem.events).toEqual(["open-dir", "close-dir", "open-file", "close-file"]);
    expect(f.mem.outstanding()).toBe(0);
    expect(f.store.status()).toBe("broken");
  });
  it.each(["load", "write"] as const)(
    "late no-follow directory open after %s timeout is closed without further IO",
    async (phase) => {
      const f = fixture(json([]));
      if (phase === "write") expect(await f.store.load()).toBe(true);
      const start = f.mem.events.length;
      const gate = deferred<void>();
      const lease = listener();
      f.mem.hook.run = async (event) => {
        if (event === "open-dir") await gate.promise;
      };
      const pending = phase === "load" ? f.store.load() : f.store.bind(key(0), async () => lease);
      await flush();
      f.clock.advance(phase === "load" ? 1000 : 2000);
      expect(await pending).toEqual(phase === "load" ? false : { ok: false, reason: "ports-store" });
      expect(f.store.status()).toBe("broken");
      expect(f.mem.outstanding()).toBe(1);
      expect(f.store.reserved).toBe(0);
      if (phase === "write") expect(lease.close).toHaveBeenCalledOnce();
      gate.resolve();
      await flush();
      expect(f.mem.events.slice(start)).toEqual(
        phase === "load" ? ["open-dir", "close-dir"] : ["mkdir", "open-dir", "close-dir"],
      );
      expect(f.mem.outstanding()).toBe(0);
      expect(f.mem.maxOutstanding()).toBe(1);
      expect(f.mem.data.get(file)!.toString()).toBe(json([]));
    },
  );
  it("write timeout closes listener+reservation NOW, late write is fenced before fsync/rename, queued work never starts", async () => {
    const f = fixture(json([]));
    const gate = deferred<void>();
    const a = listener("a");
    const b = listener("b");
    f.mem.hook.run = async (e) => {
      if (e === "write-temp") await gate.promise;
    };
    const first = f.store.bind(key(0), async () => a);
    await flush();
    const second = f.store.bind(key(1), async () => b);
    await flush();
    f.clock.advance(2000);
    expect(await first).toEqual({ ok: false, reason: "ports-store" });
    expect(await second).toEqual({ ok: false, reason: "ports-store" });
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(f.store.reserved).toBe(0);
    expect(f.mem.outstanding()).toBe(1);
    gate.resolve();
    await flush();
    expect(f.mem.events).not.toContain("sync-temp");
    expect(f.mem.events).not.toContain("rename");
    expect(f.mem.events.filter((e) => e === "open-temp")).toHaveLength(1);
    expect(f.mem.data.get(file)!.toString()).toBe(json([]));
    expect(f.mem.outstanding()).toBe(0);
    expect(f.mem.maxOutstanding()).toBe(1);
  });
  it("timeout after rename never clears the new binding; close only after real directory sync settles", async () => {
    const f = fixture(json([entry(0)]));
    const gate = deferred<void>();
    const lease = listener();
    f.mem.hook.run = async (e) => {
      if (e === "sync-dir") await gate.promise;
    };
    const pending = f.store.bind(key(1), async () => lease);
    await flush();
    const renamed = f.mem.data.get(file)!.toString();
    expect(JSON.parse(renamed).entries).toEqual([entry(0), entry(1)]);
    f.clock.advance(2000);
    expect(await pending).toEqual({ ok: false, reason: "ports-store" });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(f.store.reserved).toBe(0);
    const dial = vi.fn();
    expect(await f.store.bind(key(2), dial)).toEqual({ ok: false, reason: "ports-store" });
    expect(dial).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(f.mem.data.get(file)!.toString()).toBe(renamed);
    expect(f.mem.events.at(-1)).toBe("close-dir");
    expect(f.mem.events).not.toContain("unlink");
    expect(f.store.status()).toBe("broken");
    expect(f.mem.outstanding()).toBe(0);
  });
  it("late bind after another transaction breaks the store self-closes before commit", async () => {
    const f = fixture();
    const gate = deferred<ReturnType<typeof listener>>();
    const late = listener();
    const slow = f.store.bind(key(0), () => gate.promise);
    await flush();
    f.mem.hook.run = async (e) => {
      if (e === "write-temp") throw error("EIO");
    };
    expect(await f.store.bind(key(1), async () => listener())).toEqual({ ok: false, reason: "ports-store" });
    gate.resolve(late);
    expect(await slow).toEqual({ ok: false, reason: "ports-store" });
    expect(late.close).toHaveBeenCalledOnce();
    expect(f.store.reserved).toBe(0);
  });
});

describe("T-F5 real filesystem atomic persistence", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  });
  it("roundtrips exact v1, 0600; restart reuse; corrupt file byte-preserved; symlink refused", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pwh-proxy-"));
    dirs.push(dir);
    const opts = { stateDir: dir, range, fs, now: () => 1000 };
    const first = createProxyPortsMap(opts);
    expect(await first.bind(key(0), async () => listener())).toMatchObject({ ok: true, port: 7900 });
    const path = join(dir, "proxy", "ports.json");
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    const before = await fs.readFile(path);
    expect(JSON.parse(before.toString())).toEqual({ v: 1, entries: [entry(0)] });
    const next = createProxyPortsMap(opts);
    expect(await next.bind(key(0), async () => listener())).toMatchObject({ ok: true, reused: true, port: 7900 });
    const corrupt = Buffer.from('{"v":1,"entries":BROKEN}\n');
    await fs.writeFile(path, corrupt);
    const broken = createProxyPortsMap(opts);
    expect(await broken.load()).toBe(false);
    expect(await fs.readFile(path)).toEqual(corrupt);
    await fs.rename(path, `${path}.original`);
    await fs.symlink(`${path}.original`, path);
    const symlink = createProxyPortsMap(opts);
    expect(await symlink.load()).toBe(false);
    expect(await fs.readFile(`${path}.original`)).toEqual(corrupt);
    expect((await fs.readdir(join(dir, "proxy"))).sort()).toEqual(["ports.json", "ports.json.original"]);
  });
  it.each([false, true])("refuses symlinked proxy/ before reading or writing (existing map=%s)", async (hasMap) => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pwh-proxy-symlink-"));
    dirs.push(dir);
    const outside = join(dir, "outside");
    await fs.mkdir(outside);
    const before = json([entry(0)]);
    if (hasMap) await fs.writeFile(join(outside, "ports.json"), before);
    await fs.symlink(outside, join(dir, "proxy"), "dir");
    const opened: string[] = [];
    const io: ProxyPortsFs = {
      ...fs,
      open: async (path, flags, mode) => {
        opened.push(path);
        return fs.open(path, flags, mode);
      },
    };
    const store = createProxyPortsMap({ stateDir: dir, range, fs: io, now: () => 1000 });
    const dial = vi.fn();
    expect(await store.load()).toBe(false);
    expect(store.status()).toBe("broken");
    expect(await store.bind(key(1), dial)).toEqual({ ok: false, reason: "ports-store" });
    expect(dial).not.toHaveBeenCalled();
    expect(opened).toEqual([join(dir, "proxy")]);
    expect(await fs.readdir(outside)).toEqual(hasMap ? ["ports.json"] : []);
    if (hasMap) expect(await fs.readFile(join(outside, "ports.json"), "utf8")).toBe(before);
  });
  it("directory changed to a symlink after load is refused BEFORE any temp write", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pwh-proxy-swap-"));
    dirs.push(dir);
    const proxy = join(dir, "proxy");
    await fs.mkdir(proxy);
    const before = json([entry(0)]);
    await fs.writeFile(join(proxy, "ports.json"), before);
    const created: string[] = [];
    const io: ProxyPortsFs = {
      ...fs,
      open: async (path, flags, mode) => {
        if ((flags & constants.O_CREAT) !== 0) created.push(path);
        return fs.open(path, flags, mode);
      },
    };
    const store = createProxyPortsMap({ stateDir: dir, range, fs: io, now: () => 1000 });
    expect(await store.load()).toBe(true);
    const outside = join(dir, "moved");
    await fs.rename(proxy, outside);
    await fs.symlink(outside, proxy, "dir");
    const lease = listener();
    expect(await store.bind(key(1), async () => lease)).toEqual({ ok: false, reason: "ports-store" });
    expect(store.status()).toBe("broken");
    expect(lease.close).toHaveBeenCalledOnce();
    expect(store.reserved).toBe(0);
    expect(created).toEqual([]);
    expect(await fs.readdir(outside)).toEqual(["ports.json"]);
    expect(await fs.readFile(join(outside, "ports.json"), "utf8")).toBe(before);
  });
});
