/**
 * AL1 (alias-plan r4 §3) — hub alias binding table: load tri-state, the §3.2 state-transition table
 * (incl. common step G), presence / read-time expiry, bounded IO (slow / hung / failing rename,
 * zombies, queue), take-token lifecycle and the real-fs atomic write.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createXsAliasStore,
  isAliasShaped,
  resolveXsAliasHubParams,
  sanitizeAliasCwdLabel,
  xsAliasFailureWire,
  XS_ALIAS_FILE,
  XS_ALIAS_MAX_RECORDS,
  XS_ALIAS_TOKENS_MAX,
  type XsAliasFs,
  type XsAliasRequester,
  type XsAliasStore,
  type XsAliasTimer,
  type XsAliasWriteResult,
} from "../../../src/web-hub/hub/xs/aliases.js";
import { XS_ALIAS_TAKE_TOKEN_RE } from "../../../src/web-hub/protocol/xs-alias.js";

// ----------------------------------------------------------------- harness

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STATE = "/state";
const FILE = `${STATE}/${XS_ALIAS_FILE}`;

class Clock {
  t = 1_800_000_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  timer: XsAliasTimer = (fn, ms) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return { cancel: () => void this.timers.delete(id) };
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) next = e;
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
    await settle();
  }
}
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
}

type Beh = "ok" | "fail" | "hang";
interface Hung {
  op: "read" | "write" | "rename";
  path: string;
  release(ok: boolean): void;
}
class MemFs implements XsAliasFs {
  files = new Map<string, Uint8Array>();
  readBeh: Beh | { code: string } = "ok";
  writeBeh: Beh[] = [];
  renameBeh: Beh[] = [];
  hung: Hung[] = [];
  ops: string[] = [];
  tempsCreated: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private hang<T>(op: Hung["op"], path: string, effect: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.hung.push({
        op,
        path,
        release: (ok) => {
          if (ok) resolve(effect());
          else reject(Object.assign(new Error("late fail"), { code: "EIO" }));
        },
      });
    });
  }
  async read(path: string, maxBytes: number) {
    this.ops.push(`read ${path}`);
    const beh = this.readBeh;
    const effect = () => {
      const b = this.files.get(path);
      if (b === undefined) return { kind: "missing" as const };
      if (b.length > maxBytes) return { kind: "toolarge" as const };
      return { kind: "bytes" as const, bytes: b };
    };
    if (typeof beh === "object") throw Object.assign(new Error(beh.code), { code: beh.code });
    if (beh === "fail") throw Object.assign(new Error("EIO"), { code: "EIO" });
    if (beh === "hang") return this.hang("read", path, effect);
    return effect();
  }
  async writeTemp(path: string, bytes: Uint8Array) {
    this.ops.push(`write ${path}`);
    this.tempsCreated.push(path);
    const beh = this.writeBeh.shift() ?? "ok";
    const effect = () => {
      if (this.files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      this.files.set(path, bytes);
    };
    if (beh === "fail") throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (beh === "hang") return await this.hang("write", path, effect);
      effect();
    } finally {
      this.inFlight--;
    }
  }
  async rename(from: string, to: string) {
    this.ops.push(`rename ${from}`);
    const beh = this.renameBeh.shift() ?? "ok";
    const effect = () => {
      const b = this.files.get(from);
      if (b === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      this.files.delete(from);
      this.files.set(to, b);
    };
    if (beh === "fail") throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    if (beh === "hang") return this.hang("rename", from, effect);
    effect();
  }
  async unlink(path: string) {
    this.ops.push(`unlink ${path}`);
    this.files.delete(path);
  }
  async syncDir() {
    /* no-op */
  }
  text(): string | undefined {
    const b = this.files.get(FILE);
    return b === undefined ? undefined : new TextDecoder().decode(b);
  }
  json(): { records: { alias: string; sessionId: string; state: string; rev: number }[]; tombstones: unknown[] } {
    return JSON.parse(this.text() ?? "null");
  }
  temps(): string[] {
    return [...this.files.keys()].filter((k) => k.endsWith(".tmp"));
  }
}

class Members {
  online = new Map<string, number>();
  epochs = new Map<string, number>();
  up(sid: string, epoch = 1): XsAliasRequester {
    this.online.set(sid, (this.online.get(sid) ?? 0) + 1);
    this.epochs.set(sid, epoch);
    return { sessionId: sid, epoch };
  }
  down(sid: string): void {
    const n = (this.online.get(sid) ?? 0) - 1;
    if (n <= 0) this.online.delete(sid);
    else this.online.set(sid, n);
  }
  isOnline = (sid: string): boolean => (this.online.get(sid) ?? 0) > 0;
  isLive = (r: XsAliasRequester): boolean => this.isOnline(r.sessionId) && this.epochs.get(r.sessionId) === r.epoch;
}

let hexSeq = 0;
const hexSource = (n: number): string =>
  (++hexSeq)
    .toString(16)
    .padStart(n * 2, "0")
    .slice(-n * 2);

interface Rig {
  clock: Clock;
  fs: MemFs;
  mem: Members;
  store: XsAliasStore;
  restart(): Promise<XsAliasStore>;
}
async function rig(opts: { params?: object; preload?: string | Uint8Array; noLoad?: boolean } = {}): Promise<Rig> {
  const clock = new Clock();
  const fs = new MemFs();
  const mem = new Members();
  if (opts.preload !== undefined)
    fs.files.set(FILE, typeof opts.preload === "string" ? new TextEncoder().encode(opts.preload) : opts.preload);
  const make = () =>
    createXsAliasStore({
      stateDir: STATE,
      params: opts.params as never,
      isOnline: mem.isOnline,
      isRequesterLive: mem.isLive,
      fs,
      now: clock.now,
      timer: clock.timer,
      randomHex: hexSource,
    });
  const r: Rig = {
    clock,
    fs,
    mem,
    store: make(),
    async restart() {
      r.store.close();
      r.store = make();
      await r.store.load();
      return r.store;
    },
  };
  if (opts.noLoad !== true) await r.store.load();
  return r;
}

function ok(r: XsAliasWriteResult): void {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.failure)}`);
}
function code(r: { ok: boolean; failure?: unknown }): string {
  if (r.ok) return "ok";
  return xsAliasFailureWire((r as { failure: Parameters<typeof xsAliasFailureWire>[0] }).failure).code;
}

/** Holder `sid` goes offline and the store notices (stamp at the current instant). */
function offline(r: Rig, sid: string): void {
  r.mem.down(sid);
  r.store.touchPresence(sid);
}

// ----------------------------------------------------------------- helpers

describe("xs aliases: pure helpers", () => {
  it("resolveXsAliasHubParams clamps every leaf; missing ⇒ defaults, never off", () => {
    expect(resolveXsAliasHubParams(undefined)).toEqual({ offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 });
    expect(resolveXsAliasHubParams({ offlineLeaseH: 0, coolMin: 99999, takeMinOfflineMin: 0 })).toEqual({
      offlineLeaseH: 1,
      coolMin: 1440,
      takeMinOfflineMin: 10, // NQ1 floor
    });
    expect(resolveXsAliasHubParams({ offlineLeaseH: "x", coolMin: Number.NaN })).toEqual({
      offlineLeaseH: 168,
      coolMin: 10,
      takeMinOfflineMin: 10,
    });
  });
  it("failure wire: detail in braces; only UNKNOWN is effect unknown", () => {
    expect(xsAliasFailureWire({ code: "E_XS_ALIAS_TAKEN", detail: "confusable" })).toEqual({
      code: "E_XS_ALIAS_TAKEN{confusable}",
      effect: "none",
    });
    expect(xsAliasFailureWire({ code: "E_XS_ALIAS_FULL" })).toEqual({ code: "E_XS_ALIAS_FULL", effect: "none" });
    expect(xsAliasFailureWire({ code: "E_XS_ALIAS_UNKNOWN" })).toEqual({
      code: "E_XS_ALIAS_UNKNOWN",
      effect: "unknown",
    });
  });
  it("isAliasShaped never strips @; sanitizeAliasCwdLabel strips \\p{C} and caps 120", () => {
    expect(isAliasShaped("前端")).toBe(true);
    expect(isAliasShaped("@前端")).toBe(false);
    expect(isAliasShaped("0123abcd")).toBe(false);
    expect(sanitizeAliasCwdLabel("~/a\u0000b\u202ec\n")).toBe("~/abc");
    expect(Array.from(sanitizeAliasCwdLabel("界".repeat(200)))).toHaveLength(120);
  });
});

// ----------------------------------------------------------------- load

describe("xs aliases: load tri-state (§3.3)", () => {
  it("missing file ⇒ ready (empty), advertised, nothing created", async () => {
    const r = await rig();
    expect(r.store.advertised).toBe(true);
    expect(r.store.status()).toMatchObject({ state: "ready", records: 0, advertised: true });
    expect(r.fs.files.size).toBe(0);
    expect(r.fs.ops.filter((o) => !o.startsWith("read"))).toEqual([]);
  });

  it("before load: not advertised, reads empty, writes busy", async () => {
    const r = await rig({ noLoad: true });
    expect(r.store.advertised).toBe(false);
    expect(r.store.status().state).toBe("loading");
    expect(code(await r.store.set(r.mem.up("A"), "web", "~/a"))).toBe("E_XS_ALIAS_BUSY{io}");
  });

  const corruptCases: [string, string | Uint8Array][] = [
    ["bad json", "{not json"],
    ["bad version", JSON.stringify({ version: 2, skeletonVersion: 1, seq: 0, records: [], tombstones: [] })],
    [
      "I1 duplicate alias",
      JSON.stringify({
        version: 1,
        skeletonVersion: 1,
        seq: 2,
        records: [
          { alias: "web", skeleton: "web", sessionId: "A", state: "held", rev: 1, cwdLabel: "" },
          { alias: "web", skeleton: "web", sessionId: "B", state: "cooling", coolUntil: 1, rev: 2, cwdLabel: "" },
        ],
        tombstones: [],
      }),
    ],
    [
      "I2 two held for one sid",
      JSON.stringify({
        version: 1,
        skeletonVersion: 1,
        seq: 2,
        records: [
          { alias: "web", skeleton: "web", sessionId: "A", state: "held", rev: 1, cwdLabel: "" },
          { alias: "api", skeleton: "apl", sessionId: "A", state: "held", rev: 2, cwdLabel: "" },
        ],
        tombstones: [],
      }),
    ],
    [
      "held with coolUntil",
      JSON.stringify({
        version: 1,
        skeletonVersion: 1,
        seq: 1,
        records: [{ alias: "web", skeleton: "web", sessionId: "A", state: "held", coolUntil: 5, rev: 1, cwdLabel: "" }],
        tombstones: [],
      }),
    ],
    ["too large", new Uint8Array(64 * 1024 + 1).fill(0x20)],
    ["invalid utf-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ];
  for (const [name, bytes] of corruptCases) {
    it(`corrupt (${name}) ⇒ degraded, not advertised, file bytes untouched, stays degraded across restarts`, async () => {
      const r = await rig({ preload: bytes });
      const before = r.fs.files.get(FILE);
      expect(r.store.advertised).toBe(false);
      expect(r.store.status()).toMatchObject({ state: "degraded", degradedReason: "corrupt" });
      expect(code(await r.store.set(r.mem.up("A"), "web", "~/a"))).toBe("E_XS_ALIAS_BUSY{io}");
      expect(code(r.store.takePreview(r.mem.up("B"), "web"))).toBe("E_XS_ALIAS_BUSY{io}");
      expect(r.store.lookup("web")).toBeUndefined();
      expect(r.store.get({ sessionId: "A", epoch: 1 })).toEqual({ state: "none" });
      await r.restart();
      expect(r.store.status()).toMatchObject({ state: "degraded", degradedReason: "corrupt" });
      expect(r.fs.files.get(FILE)).toBe(before); // same bytes object: never rewritten
      expect([...r.fs.files.keys()]).toEqual([FILE]); // no .bak, no temp
      expect(r.fs.ops.filter((o) => !o.startsWith("read"))).toEqual([]);
    });
  }

  it("unreadable (EACCES) ⇒ degraded(unreadable); a human removing the file ⇒ next start ready (R1)", async () => {
    const r = await rig({ preload: "{}" });
    r.fs.readBeh = { code: "EACCES" };
    await r.restart();
    expect(r.store.status()).toMatchObject({ state: "degraded", degradedReason: "unreadable" });
    r.fs.readBeh = "ok";
    r.fs.files.delete(FILE);
    await r.restart();
    expect(r.store.status()).toMatchObject({ state: "ready", records: 0 });
  });

  it("slow load ⇒ degraded(timeout) after 2s; the late read is ignored; next start can be ready", async () => {
    const r = await rig({ noLoad: true });
    r.fs.readBeh = "hang";
    const p = r.store.load();
    await r.clock.advance(1_999);
    expect(r.store.status().state).toBe("loading");
    await r.clock.advance(2);
    expect(await p).toEqual({ state: "degraded", reason: "timeout" });
    r.fs.hung.shift()!.release(true);
    await settle();
    expect(r.store.status().state).toBe("degraded");
    expect(r.store.advertised).toBe(false);
    r.fs.readBeh = "ok";
    await r.restart();
    expect(r.store.status().state).toBe("ready");
  });

  it("load is idempotent", async () => {
    const r = await rig();
    const a = r.store.load();
    expect(r.store.load()).toBe(a);
    expect(r.fs.ops.filter((o) => o.startsWith("read"))).toHaveLength(1);
  });
});

// ----------------------------------------------------------------- transitions

describe("xs aliases: state transition table (§3.2)", () => {
  it("set on a free alias creates held(S); response + get + lookup + heldBy agree; disk has it", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    const res = await r.store.set(A, "@Web", "~/proj");
    expect(res).toEqual({ ok: true, res: { alias: "web", state: "held" } });
    expect(r.store.get(A)).toEqual({ alias: "web", state: "held" });
    expect(r.store.lookup("web")).toMatchObject({ sessionId: "A", state: "held", cwdLabel: "~/proj" });
    expect(r.store.heldBy("A")).toBe("web");
    expect(r.store.resolveQuery("WEB")).toMatchObject({ kind: "hit", record: { sessionId: "A" } });
    expect(r.store.resolveQuery("@web")).toEqual({ kind: "miss" });
    expect(r.fs.json().records).toEqual([expect.objectContaining({ alias: "web", sessionId: "A", state: "held" })]);
  });

  it("invalid input ⇒ E_XS_ALIAS_INVALID{reason} with zero IO", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    expect(code(await r.store.set(A, "a b", ""))).toBe("E_XS_ALIAS_INVALID{invalid}");
    expect(code(await r.store.set(A, "self", ""))).toBe("E_XS_ALIAS_INVALID{reserved}");
    expect(code(await r.store.set(A, "deadbeef", ""))).toBe("E_XS_ALIAS_INVALID{id_like}");
    expect(code(await r.store.set(A, "a".repeat(17), ""))).toBe("E_XS_ALIAS_INVALID{too_long}");
    expect(r.fs.ops.filter((o) => !o.startsWith("read"))).toEqual([]);
  });

  it("set of an alias already held by S with the same label is a no-op (no write)", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    ok(await r.store.set(A, "web", "~/a"));
    const writes = r.fs.ops.length;
    ok(await r.store.set(A, "web", "~/a"));
    expect(r.fs.ops.length).toBe(writes);
    ok(await r.store.set(A, "web", "~/b")); // label change is a real write
    expect(r.store.lookup("web")?.cwdLabel).toBe("~/b");
  });

  it("clear ⇒ cooling(S) 10 min; only S may reclaim during cooling; after cooling anyone may", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    const B = r.mem.up("B");
    ok(await r.store.set(A, "web", "~/a"));
    expect(await r.store.clear(A)).toEqual({ ok: true, res: { state: "none" } });
    expect(r.store.lookup("web")).toMatchObject({ state: "cooling", sessionId: "A" });
    expect(r.store.heldBy("A")).toBeUndefined();
    expect(code(await r.store.set(B, "web", "~/b"))).toBe("E_XS_ALIAS_TAKEN{taken}"); // I4
    await r.clock.advance(9 * MIN);
    ok(await r.store.set(A, "web", "~/a")); // reclaim within cooling
    ok(await r.store.clear(A));
    const writes = r.fs.ops.length;
    await r.clock.advance(10 * MIN + 1);
    expect(r.fs.ops.length).toBe(writes); // cooling expiry is a read-time predicate (I6)
    expect(r.store.lookup("web")).toBeUndefined();
    ok(await r.store.set(B, "web", "~/b"));
    const rec = r.store.lookup("web")!;
    expect(rec.sessionId).toBe("B");
    expect(r.fs.json().records.map((x) => x.alias)).toEqual(["web"]); // expired cooling replaced, not duplicated
  });

  it("clear without a held alias is a no-op", async () => {
    const r = await rig();
    expect(await r.store.clear(r.mem.up("A"))).toEqual({ ok: true, res: { state: "none" } });
    expect(r.fs.ops.filter((o) => !o.startsWith("read"))).toEqual([]);
  });

  it("held by another sid: online / offline-not-expired ⇒ taken; expired (>lease) ⇒ in-place transfer, tombstone, no cooling (NQ4)", async () => {
    const r = await rig();
    const H = r.mem.up("H");
    const S = r.mem.up("S");
    ok(await r.store.set(H, "web", "~/h"));
    expect(code(await r.store.set(S, "web", "~/s"))).toBe("E_XS_ALIAS_TAKEN{taken}");
    offline(r, "H");
    await r.clock.advance(7 * DAY);
    expect(code(await r.store.set(S, "web", "~/s"))).toBe("E_XS_ALIAS_TAKEN{taken}"); // == lease, not >
    await r.clock.advance(1);
    const before = r.store.lookup("web")!.rev;
    ok(await r.store.set(S, "web", "~/s"));
    const rec = r.store.lookup("web")!;
    expect(rec).toMatchObject({ sessionId: "S", state: "held" });
    expect(rec.rev).toBeGreaterThan(before);
    expect(r.store.inspect().records).toHaveLength(1); // H keeps no cooling
    expect(r.store.get({ sessionId: "H", epoch: 1 })).toEqual({
      state: "none",
      lost: { alias: "web", reason: "expired", at: r.clock.t },
    });
  });

  it("confusable: another sid's same-skeleton record ⇒ E_XS_ALIAS_TAKEN{confusable}, no echo of the existing alias", async () => {
    const r = await rig();
    ok(await r.store.set(r.mem.up("A"), "web0", ""));
    const res = await r.store.set(r.mem.up("B"), "webo", "");
    expect(res).toEqual({ ok: false, failure: { code: "E_XS_ALIAS_TAKEN", detail: "confusable" } });
    expect(JSON.stringify(res)).not.toContain("web0");
    ok(await r.store.set(r.mem.up("C"), "前端一", "")); // 一 → "-" (CJK↔ASCII skeleton)
    expect(code(await r.store.set(r.mem.up("D"), "前端-", ""))).toBe("E_XS_ALIAS_TAKEN{confusable}");
    expect(code(await r.store.set(r.mem.up("E"), "カ", ""))).toBe("ok"); // カ/力 deliberately not confusable (R4)
    expect(code(await r.store.set(r.mem.up("F"), "力", ""))).toBe("ok");
  });

  it("S renaming to a same-skeleton name drops its own old record outright (§2.2)", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    ok(await r.store.set(A, "web0", ""));
    ok(await r.store.set(A, "webo", ""));
    expect(r.store.inspect().records.map((x) => [x.alias, x.state])).toEqual([["webo", "held"]]);
  });

  describe("common step G: S already holding y gets x ⇒ only x held(S), y cooling(S) (I2)", () => {
    const expectG = (r: Rig) => {
      const recs = r.store.inspect().records.filter((x) => x.sessionId === "S");
      expect(recs.filter((x) => x.state === "held").map((x) => x.alias)).toEqual(["x"]);
      expect(recs.find((x) => x.alias === "y")).toMatchObject({ state: "cooling", coolUntil: r.clock.t + 10 * MIN });
    };
    it("via plain set", async () => {
      const r = await rig();
      const S = r.mem.up("S");
      ok(await r.store.set(S, "y", ""));
      ok(await r.store.set(S, "x", ""));
      expectG(r);
    });
    it("via expired takeover", async () => {
      const r = await rig();
      const S = r.mem.up("S");
      ok(await r.store.set(r.mem.up("H"), "x", ""));
      ok(await r.store.set(S, "y", ""));
      offline(r, "H");
      await r.clock.advance(7 * DAY + 1);
      ok(await r.store.set(S, "x", ""));
      expectG(r);
    });
    it("via take", async () => {
      const r = await rig();
      const S = r.mem.up("S");
      ok(await r.store.set(r.mem.up("H"), "x", ""));
      ok(await r.store.set(S, "y", ""));
      offline(r, "H");
      await r.clock.advance(10 * MIN);
      const pv = r.store.takePreview(S, "x");
      if (!pv.ok || !("take" in pv.res)) throw new Error("preview failed");
      ok(await r.store.take(S, "x", pv.res.take.token, ""));
      expectG(r);
    });
  });

  it("capacity: 256 records ⇒ new record FULL; expired takeover and take still succeed", async () => {
    const r = await rig();
    const L = "abcdefghjkmnpqrstuvwxyz"; // no i/l/o: no skeleton collisions among fillers
    const name = (i: number): string => `n${L[Math.floor(i / L.length)]}${L[i % L.length]}`;
    for (let i = 0; i < XS_ALIAS_MAX_RECORDS; i++) ok(await r.store.set(r.mem.up(`s${i}`), name(i), ""));
    expect(r.store.status().records).toBe(256);
    const N = r.mem.up("N");
    expect(code(await r.store.set(N, "brandnew", ""))).toBe("E_XS_ALIAS_FULL");
    offline(r, "s0");
    offline(r, "s1");
    await r.clock.advance(7 * DAY + 1);
    ok(await r.store.set(N, name(0), "")); // expired takeover: in place
    const M = r.mem.up("M");
    const pv = r.store.takePreview(M, name(1));
    if (!pv.ok || !("take" in pv.res)) throw new Error("preview failed");
    ok(await r.store.take(M, name(1), pv.res.take.token, ""));
    // a brand-new record is still FULL (G alone never frees or adds a slot)
    expect(code(await r.store.set(N, "another", ""))).toBe("E_XS_ALIAS_FULL");
    expect(r.store.status().records).toBe(256);
  });
});

// ----------------------------------------------------------------- presence / time

describe("xs aliases: presence is memory-only; expiry is read-time (§3.1)", () => {
  it("two processes for one sid: closing one keeps it online (take ⇒ online)", async () => {
    const r = await rig();
    const H = r.mem.up("H");
    r.mem.up("H");
    ok(await r.store.set(H, "web", ""));
    offline(r, "H");
    await r.clock.advance(DAY);
    expect(code(r.store.takePreview(r.mem.up("S"), "web"))).toBe("E_XS_ALIAS_TAKE{online}");
  });

  it("offline stamp is taken on the first observation (biased to the holder); reconnect resets it", async () => {
    const r = await rig();
    const H = r.mem.up("H");
    ok(await r.store.set(H, "web", ""));
    r.mem.down("H"); // nobody tells the store
    await r.clock.advance(3 * DAY);
    const S = r.mem.up("S");
    expect(code(r.store.takePreview(S, "web"))).toBe("E_XS_ALIAS_TAKE{recent}"); // stamped now
    await r.clock.advance(10 * MIN);
    expect(code(r.store.takePreview(S, "web"))).toBe("ok");
    r.mem.up("H");
    r.store.touchPresence("H");
    offline(r, "H");
    expect(code(r.store.takePreview(S, "web"))).toBe("E_XS_ALIAS_TAKE{recent}");
  });

  it("presence never reaches the disk; time passing writes nothing", async () => {
    const r = await rig();
    const H = r.mem.up("H");
    ok(await r.store.set(H, "web", ""));
    const before = r.fs.text();
    const ops = r.fs.ops.length;
    offline(r, "H");
    await r.clock.advance(30 * DAY);
    r.mem.up("H");
    r.store.touchPresence("H");
    r.store.lookup("web");
    r.store.status();
    expect(r.fs.text()).toBe(before);
    expect(r.fs.ops.length).toBe(ops);
    expect(before).not.toMatch(/offline|online|presence/i);
  });

  it("online 30 days → crash → restart → someone else asks first ⇒ NOT expired (lease restarts at load, R8)", async () => {
    const r = await rig();
    const H = r.mem.up("H");
    ok(await r.store.set(H, "web", ""));
    await r.clock.advance(30 * DAY);
    r.mem.down("H"); // crash: the hub dies with H attached
    await r.restart();
    const S = r.mem.up("S");
    expect(code(await r.store.set(S, "web", ""))).toBe("E_XS_ALIAS_TAKEN{taken}");
    expect(code(r.store.takePreview(S, "web"))).toBe("E_XS_ALIAS_TAKE{recent}");
    await r.clock.advance(7 * DAY);
    expect(code(await r.store.set(S, "web", ""))).toBe("E_XS_ALIAS_TAKEN{taken}");
    await r.clock.advance(1);
    ok(await r.store.set(S, "web", ""));
  });

  it("restart resets an offline holder's window (6 days offline before restart ⇒ full 7 days after)", async () => {
    const r = await rig();
    ok(await r.store.set(r.mem.up("H"), "web", ""));
    offline(r, "H");
    await r.clock.advance(6 * DAY);
    await r.restart();
    const S = r.mem.up("S");
    await r.clock.advance(2 * DAY);
    expect(code(await r.store.set(S, "web", ""))).toBe("E_XS_ALIAS_TAKEN{taken}");
    await r.clock.advance(5 * DAY + 1);
    ok(await r.store.set(S, "web", ""));
  });

  it("records + tombstones survive a restart; tokens do not", async () => {
    const r = await rig();
    const H = r.mem.up("H");
    const S = r.mem.up("S");
    ok(await r.store.set(H, "web", "~/h"));
    offline(r, "H");
    await r.clock.advance(10 * MIN);
    const pv = r.store.takePreview(S, "web");
    if (!pv.ok || !("take" in pv.res)) throw new Error("preview failed");
    await r.restart();
    expect(r.store.lookup("web")).toMatchObject({ sessionId: "H", cwdLabel: "~/h" });
    expect(code(await r.store.take(S, "web", pv.res.take.token, ""))).toBe("E_XS_ALIAS_TAKE{stale}");
  });
});

// ----------------------------------------------------------------- IO

describe("xs aliases: bounded writes (§3.3)", () => {
  it("temp write failure ⇒ BUSY{io}; memory and disk unchanged; temp removed", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    ok(await r.store.set(A, "web", ""));
    const before = r.fs.text();
    r.fs.writeBeh = ["fail"];
    expect(code(await r.store.set(A, "api", ""))).toBe("E_XS_ALIAS_BUSY{io}");
    expect(r.store.heldBy("A")).toBe("web");
    expect(r.fs.text()).toBe(before);
    expect(r.fs.temps()).toEqual([]);
  });

  it("hung temp write ⇒ BUSY{io} at 2s, zombie; late completion unlinks its temp; 3rd zombie ⇒ disabled (reads keep working)", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    ok(await r.store.set(A, "web", ""));
    const before = r.fs.text();
    for (let i = 1; i <= 3; i++) {
      r.fs.writeBeh = ["hang"];
      const p = r.store.set(A, `api${"abc"[i - 1]}`, "");
      await r.clock.advance(1_999);
      expect(r.store.status().queue).toBe(1);
      await r.clock.advance(1);
      expect(code(await p)).toBe("E_XS_ALIAS_BUSY{io}");
      expect(r.store.status().zombies).toBe(i);
      expect(r.store.status().state).toBe(i <= 2 ? "ready" : "disabled");
    }
    expect(r.store.status().disabledReason).toBe("zombie");
    expect(r.fs.text()).toBe(before);
    expect(r.store.heldBy("A")).toBe("web");
    for (const h of r.fs.hung.splice(0)) h.release(true);
    await settle();
    expect(r.fs.temps()).toEqual([]);
    expect(r.fs.text()).toBe(before);
    expect(code(await r.store.set(A, "zzz", ""))).toBe("E_XS_ALIAS_BUSY{io}");
    expect(r.store.lookup("web")?.sessionId).toBe("A");
  });

  it("rename failure ⇒ BUSY{io}, unchanged", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    r.fs.renameBeh = ["fail"];
    expect(code(await r.store.set(A, "web", ""))).toBe("E_XS_ALIAS_BUSY{io}");
    expect(r.store.heldBy("A")).toBeUndefined();
    expect(r.fs.text()).toBeUndefined();
    await settle();
    expect(r.fs.temps()).toEqual([]);
  });

  for (const lateOk of [true, false]) {
    it(`rename >1s ⇒ UNKNOWN + wedged (writes busy, reads keep the old table); late ${lateOk ? "success ⇒ applied" : "failure ⇒ unchanged"}, back to ready`, async () => {
      const r = await rig();
      const A = r.mem.up("A");
      const B = r.mem.up("B");
      ok(await r.store.set(A, "web", ""));
      r.fs.renameBeh = ["hang"];
      const p = r.store.set(A, "api", "");
      await r.clock.advance(1_000);
      expect(await p).toEqual({ ok: false, failure: { code: "E_XS_ALIAS_UNKNOWN" } });
      expect(r.store.status().state).toBe("wedged");
      expect(r.store.advertised).toBe(true); // advertising never changes mid-run
      expect(code(await r.store.set(B, "other", ""))).toBe("E_XS_ALIAS_BUSY{io}");
      expect(code(await r.store.clear(A))).toBe("E_XS_ALIAS_BUSY{io}");
      expect(code(r.store.takePreview(B, "web"))).toBe("E_XS_ALIAS_BUSY{io}");
      expect(r.store.lookup("web")?.sessionId).toBe("A"); // old table still served
      expect(r.store.heldBy("A")).toBe("web");
      r.fs.hung.shift()!.release(lateOk);
      await settle();
      expect(r.store.status().state).toBe("ready");
      expect(r.store.heldBy("A")).toBe(lateOk ? "api" : "web");
      expect(r.fs.json().records.find((x) => x.state === "held")?.alias).toBe(lateOk ? "api" : "web");
      expect(r.fs.temps()).toEqual([]);
      ok(await r.store.set(B, "other", ""));
    });
  }

  it("rename in flight >60s ⇒ disabled for the run; a later success still updates memory to match disk", async () => {
    const r = await rig();
    const A = r.mem.up("A");
    r.fs.renameBeh = ["hang"];
    const p = r.store.set(A, "web", "");
    await r.clock.advance(1_000);
    expect(code(await p)).toBe("E_XS_ALIAS_UNKNOWN");
    await r.clock.advance(60_000);
    expect(r.store.status().state).toBe("wedged");
    await r.clock.advance(1);
    expect(r.store.status()).toMatchObject({ state: "disabled", disabledReason: "wedge-timeout" });
    r.fs.hung.shift()!.release(true);
    await settle();
    expect(r.store.status().state).toBe("disabled");
    expect(r.store.heldBy("A")).toBe("web");
    expect(code(await r.store.set(A, "api", ""))).toBe("E_XS_ALIAS_BUSY{io}");
    await r.restart();
    expect(r.store.status().state).toBe("ready");
    expect(r.store.heldBy("A")).toBe("web");
  });

  it("queue: 1 running + 4 waiting; the 5th waiter ⇒ BUSY{queue}; waiters whose 4s budget can no longer fit write+rename ⇒ BUSY{queue}", async () => {
    const r = await rig();
    r.fs.writeBeh = ["hang", "hang", "hang", "hang", "hang"];
    const sids = ["a", "b", "c", "d", "e", "f"].map((s) => r.mem.up(s));
    const ps = sids.map((s, i) => r.store.set(s, `q${"abcdef"[i]}x`, ""));
    await settle();
    expect(code(await ps[5]!)).toBe("E_XS_ALIAS_BUSY{queue}");
    expect(r.store.status().queue).toBe(5);
    await r.clock.advance(2_000); // 1st write cap (2s) ⇒ zombie
    expect(code(await ps[0]!)).toBe("E_XS_ALIAS_BUSY{io}");
    await r.clock.advance(1_000); // 2nd got only 4s - 1s(rename) - 2s(queued) = 1s of write budget
    expect(code(await ps[1]!)).toBe("E_XS_ALIAS_BUSY{io}");
    // the rest waited 3s: no room left for write + the 1s rename window ⇒ BUSY{queue}, zero IO
    expect((await Promise.all(ps.slice(2, 5))).map(code)).toEqual(Array(3).fill("E_XS_ALIAS_BUSY{queue}"));
    expect(r.fs.tempsCreated).toHaveLength(2);
    expect(r.store.status()).toMatchObject({ queue: 0, zombies: 2, state: "ready" });
    for (const h of r.fs.hung.splice(0)) h.release(true);
    await settle();
    expect(r.fs.temps()).toEqual([]);
  });

  it("concurrent writes serialize: one physical write at a time, no lost update, temp names never reused", async () => {
    const r = await rig();
    const sids = Array.from({ length: 5 }, (_, i) => r.mem.up(`s${i}`));
    const results = await Promise.all(sids.map((s, i) => r.store.set(s, `w${"abcde"[i]}x`, "")));
    results.forEach(ok);
    expect(r.fs.maxInFlight).toBe(1);
    expect(
      r.fs
        .json()
        .records.map((x) => x.alias)
        .sort(),
    ).toEqual(["wax", "wbx", "wcx", "wdx", "wex"]);
    expect(new Set(r.fs.tempsCreated).size).toBe(r.fs.tempsCreated.length);
    await r.restart();
    expect(r.store.status().records).toBe(5);
  });

  it("temp-name reservations are released once the file is provably gone (bounded set, never a live collision)", async () => {
    const clock = new Clock();
    const fs = new MemFs();
    const mem = new Members();
    const store = createXsAliasStore({
      stateDir: STATE,
      isOnline: mem.isOnline,
      isRequesterLive: mem.isLive,
      fs,
      now: clock.now,
      timer: clock.timer,
      randomHex: (n) => "ab".repeat(n), // every attempt yields the SAME temp name
    });
    await store.load();
    const A = mem.up("A");
    // committed (renamed) ⇒ name released ⇒ the next transaction may reuse it
    ok(await store.set(A, "one", ""));
    ok(await store.set(A, "two", ""));
    // failed write ⇒ unlinked ⇒ released
    fs.writeBeh = ["fail"];
    expect(code(await store.set(A, "three", ""))).toBe("E_XS_ALIAS_BUSY{io}");
    await settle();
    ok(await store.set(A, "three", ""));
    // zombie write: its temp may still appear ⇒ the name stays reserved (no live collision) ...
    fs.writeBeh = ["hang"];
    const p = store.set(A, "four", "");
    await clock.advance(2_000);
    expect(code(await p)).toBe("E_XS_ALIAS_BUSY{io}");
    expect(code(await store.set(A, "four", ""))).toBe("E_XS_ALIAS_BUSY{io}"); // all 8 attempts collide
    expect(fs.tempsCreated).toHaveLength(5); // one, two, three×2, four — the refused attempt never touched the disk
    // ... until it settles and is unlinked
    fs.hung.shift()!.release(true);
    await settle();
    expect(fs.temps()).toEqual([]);
    ok(await store.set(A, "four", ""));
    expect(store.heldBy("A")).toBe("four");
  });

  it("close(): waiting transactions resolve BUSY{io}; tokens dropped; writes refused", async () => {
    const r = await rig();
    r.fs.writeBeh = ["hang"];
    const p1 = r.store.set(r.mem.up("a"), "aaa", "");
    const p2 = r.store.set(r.mem.up("b"), "bbb", "");
    await settle();
    r.store.close();
    expect(code(await p2)).toBe("E_XS_ALIAS_BUSY{io}");
    await r.clock.advance(2_000);
    expect(code(await p1)).toBe("E_XS_ALIAS_BUSY{io}");
    expect(code(await r.store.set(r.mem.up("c"), "ccc", ""))).toBe("E_XS_ALIAS_BUSY{io}");
  });
});

describe("xs aliases: state × behaviour matrix (§3.3, R3-2)", () => {
  type Row = { state: string; advertised: boolean; reads: boolean; writes: string };
  async function reach(state: "ready" | "wedged" | "disabled" | "degraded"): Promise<Rig> {
    if (state === "degraded") return rig({ preload: "{bad" });
    const r = await rig();
    ok(await r.store.set(r.mem.up("A"), "前端", "~/a"));
    if (state === "wedged" || state === "disabled") {
      r.fs.renameBeh = ["hang"];
      const p = r.store.set(r.mem.up("Z"), "zzz", "");
      await r.clock.advance(1_000);
      expect(code(await p)).toBe("E_XS_ALIAS_UNKNOWN");
      if (state === "disabled") await r.clock.advance(60_001);
    }
    return r;
  }
  const rows: Row[] = [
    { state: "ready", advertised: true, reads: true, writes: "ok" },
    { state: "wedged", advertised: true, reads: true, writes: "E_XS_ALIAS_BUSY{io}" },
    { state: "disabled", advertised: true, reads: true, writes: "E_XS_ALIAS_BUSY{io}" },
    { state: "degraded", advertised: false, reads: false, writes: "E_XS_ALIAS_BUSY{io}" },
  ];
  for (const row of rows) {
    it(`${row.state}: advertised=${row.advertised}, reads=${row.reads ? "memory table" : "none"}, writes=${row.writes}`, async () => {
      const r = await reach(row.state as never);
      expect(r.store.status().state).toBe(row.state);
      expect(r.store.advertised).toBe(row.advertised);
      if (row.reads) {
        expect(r.store.resolveQuery("前端")).toMatchObject({ kind: "hit", record: { sessionId: "A" } });
        expect(r.store.heldBy("A")).toBe("前端");
      } else {
        expect(r.store.resolveQuery("前端")).toEqual({ kind: "miss" });
        expect(r.store.heldBy("A")).toBeUndefined();
      }
      expect(code(await r.store.set(r.mem.up("W"), "wq", ""))).toBe(row.writes);
      expect(code(await r.store.clear(r.mem.up("A")))).toBe(row.writes === "ok" ? "ok" : row.writes);
      for (const h of r.fs.hung.splice(0)) h.release(false);
    });
  }
});

// ----------------------------------------------------------------- rename-before re-check interleavings

describe("xs aliases: rename-before re-check (§3.3-4)", () => {
  async function takeSetup() {
    const r = await rig();
    const H = r.mem.up("H");
    const S = r.mem.up("S");
    ok(await r.store.set(H, "web", "~/h"));
    offline(r, "H");
    await r.clock.advance(10 * MIN);
    const pv = r.store.takePreview(S, "web");
    if (!pv.ok || !("take" in pv.res)) throw new Error("preview failed");
    return { r, H, S, token: pv.res.take.token };
  }

  it("holder reconnects during the temp write ⇒ take stale; nothing written; holder keeps it", async () => {
    const { r, S, token } = await takeSetup();
    const before = r.fs.text();
    r.fs.writeBeh = ["hang"];
    const p = r.store.take(S, "web", token, "~/s");
    await settle();
    r.mem.up("H");
    r.store.touchPresence("H");
    r.fs.hung.shift()!.release(true);
    expect(code(await p)).toBe("E_XS_ALIAS_TAKE{stale}");
    await settle();
    expect(r.fs.text()).toBe(before);
    expect(r.fs.temps()).toEqual([]);
    expect(r.store.lookup("web")?.sessionId).toBe("H");
  });

  it("holder reconnects AND drops again during the write ⇒ offlineSince changed ⇒ stale", async () => {
    const { r, S, token } = await takeSetup();
    r.fs.writeBeh = ["hang"];
    const p = r.store.take(S, "web", token, "");
    await settle();
    r.mem.up("H");
    r.store.touchPresence("H");
    await r.clock.advance(1);
    offline(r, "H");
    r.fs.hung.shift()!.release(true);
    expect(code(await p)).toBe("E_XS_ALIAS_TAKE{stale}");
  });

  it("requester switches session during the write ⇒ stale (take) / busy (set); nothing committed", async () => {
    const { r, S, token } = await takeSetup();
    r.fs.writeBeh = ["hang"];
    const p = r.store.take(S, "web", token, "");
    await settle();
    r.mem.down("S");
    r.fs.hung.shift()!.release(true);
    expect(code(await p)).toBe("E_XS_ALIAS_TAKE{stale}");
    const X = r.mem.up("X");
    r.fs.writeBeh = ["hang"];
    const q = r.store.set(X, "xxx", "");
    await settle();
    r.mem.epochs.set("X", 2); // same sid, new epoch (switched away and back)
    r.fs.hung.shift()!.release(true);
    expect(code(await q)).toBe("E_XS_ALIAS_BUSY{io}");
    expect(r.store.heldBy("X")).toBeUndefined();
  });

  it("another token commits first ⇒ the second take is stale (rev changed)", async () => {
    const { r, token } = await takeSetup();
    const T = r.mem.up("T");
    const pv2 = r.store.takePreview(T, "web");
    if (!pv2.ok || !("take" in pv2.res)) throw new Error("preview failed");
    ok(await r.store.take(T, "web", pv2.res.take.token, ""));
    expect(code(await r.store.take(r.mem.up("S"), "web", token, ""))).toBe("E_XS_ALIAS_TAKE{stale}");
    expect(r.store.lookup("web")?.sessionId).toBe("T");
  });

  it("expired takeover: holder reconnects during the write ⇒ taken; nothing committed", async () => {
    const r = await rig();
    ok(await r.store.set(r.mem.up("H"), "web", ""));
    offline(r, "H");
    await r.clock.advance(7 * DAY + 1);
    const S = r.mem.up("S");
    r.fs.writeBeh = ["hang"];
    const p = r.store.set(S, "web", "");
    await settle();
    r.mem.up("H");
    r.store.touchPresence("H");
    r.fs.hung.shift()!.release(true);
    expect(code(await p)).toBe("E_XS_ALIAS_TAKEN{taken}");
    expect(r.store.lookup("web")?.sessionId).toBe("H");
  });

  it("a write landing just inside its cap still has the 1s rename window reserved ⇒ commits", async () => {
    const r = await rig();
    r.fs.writeBeh = ["hang"];
    const A = r.mem.up("A");
    const p = r.store.set(A, "web", "");
    await r.clock.advance(1_999);
    r.fs.hung.shift()!.release(true);
    ok(await p);
    expect(r.fs.ops.some((o) => o.startsWith("rename"))).toBe(true);
    expect(r.store.status().zombies).toBe(0);
  });
});

// ----------------------------------------------------------------- take tokens

describe("xs aliases: take preview + token lifecycle (§3.5)", () => {
  async function base() {
    const r = await rig();
    const H = r.mem.up("H");
    ok(await r.store.set(H, "web", "~/proj\u0007/x"));
    offline(r, "H");
    return { r, S: r.mem.up("S") };
  }
  const tok = (pv: ReturnType<XsAliasStore["takePreview"]>): string => {
    if (!pv.ok || !("take" in pv.res)) throw new Error(`preview failed ${JSON.stringify(pv)}`);
    return pv.res.take.token;
  };

  it("preview refusals: recent (<10 min), online, not_held (none / cooling / self), invalid", async () => {
    const { r, S } = await base();
    expect(code(r.store.takePreview(S, "web"))).toBe("E_XS_ALIAS_TAKE{recent}");
    expect(code(r.store.takePreview(S, "nobody"))).toBe("E_XS_ALIAS_TAKE{not_held}");
    expect(code(r.store.takePreview(S, "a b"))).toBe("E_XS_ALIAS_INVALID{invalid}");
    const O = r.mem.up("O");
    ok(await r.store.set(O, "on", ""));
    expect(code(r.store.takePreview(S, "on"))).toBe("E_XS_ALIAS_TAKE{online}");
    expect(code(r.store.takePreview(O, "on"))).toBe("E_XS_ALIAS_TAKE{not_held}"); // self
    ok(await r.store.clear(O));
    expect(code(r.store.takePreview(S, "on"))).toBe("E_XS_ALIAS_TAKE{not_held}"); // cooling
  });

  it("preview shape: sanitized cwdLabel, offlineForS, k+16hex token, 5 min expiry — never ref/name", async () => {
    const { r, S } = await base();
    await r.clock.advance(3 * DAY + 4 * HOUR);
    const pv = r.store.takePreview(S, "@WEB");
    expect(pv).toEqual({
      ok: true,
      res: {
        take: {
          cwdLabel: "~/proj/x",
          offlineForS: (3 * DAY + 4 * HOUR) / 1000,
          token: expect.stringMatching(XS_ALIAS_TAKE_TOKEN_RE),
          expiresAt: r.clock.t + 5 * MIN,
        },
      },
    });
    expect(Object.keys((pv as { res: { take: object } }).res.take).sort()).toEqual([
      "cwdLabel",
      "expiresAt",
      "offlineForS",
      "token",
    ]);
  });

  it("execute: success transfers in place, tombstone(taken) for the holder, holder keeps no cooling", async () => {
    const { r, S } = await base();
    await r.clock.advance(10 * MIN);
    ok(await r.store.take(S, "web", tok(r.store.takePreview(S, "web")), "~/s"));
    expect(r.store.lookup("web")).toMatchObject({ sessionId: "S", state: "held", cwdLabel: "~/s" });
    expect(r.store.inspect().records).toHaveLength(1);
    expect(r.store.get({ sessionId: "H", epoch: 1 }).lost).toEqual({ alias: "web", reason: "taken", at: r.clock.t });
    r.mem.up("H");
    ok(await r.store.set({ sessionId: "H", epoch: 1 }, "home", "")); // H's own set clears its tombstone
    expect(r.store.get({ sessionId: "H", epoch: 1 }).lost).toBeUndefined();
  });

  it("same token twice concurrently ⇒ second is stale", async () => {
    const { r, S } = await base();
    await r.clock.advance(10 * MIN);
    const t = tok(r.store.takePreview(S, "web"));
    const [a, b] = await Promise.all([r.store.take(S, "web", t, ""), r.store.take(S, "web", t, "")]);
    expect([code(a), code(b)]).toEqual(["ok", "E_XS_ALIAS_TAKE{stale}"]);
  });

  it("token bound to requester / alias; expired; garbage ⇒ stale — and each attempt consumes it", async () => {
    const { r, S } = await base();
    await r.clock.advance(10 * MIN);
    const T = r.mem.up("T");
    let t = tok(r.store.takePreview(S, "web"));
    expect(code(await r.store.take(T, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}"); // other requester
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}"); // consumed
    t = tok(r.store.takePreview(S, "web"));
    expect(code(await r.store.take(S, "other", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}"); // other alias
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}");
    t = tok(r.store.takePreview(S, "web"));
    expect(code(await r.store.take(S, "a b", t, ""))).toBe("E_XS_ALIAS_INVALID{invalid}"); // invalid consumes too
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}");
    t = tok(r.store.takePreview(S, "web"));
    await r.clock.advance(5 * MIN);
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}"); // expired
    expect(code(await r.store.take(S, "web", "knotatoken", ""))).toBe("E_XS_ALIAS_TAKE{stale}");
    expect(r.store.lookup("web")?.sessionId).toBe("H");
  });

  it("holder changed since preview (expired takeover by someone else) ⇒ stale", async () => {
    const { r, S } = await base();
    await r.clock.advance(7 * DAY + 1);
    const t = tok(r.store.takePreview(S, "web"));
    ok(await r.store.set(r.mem.up("Q"), "web", ""));
    r.mem.down("Q");
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}");
  });

  it("IO failure consumes the token; a retry with it is stale (must re-preview)", async () => {
    const { r, S } = await base();
    await r.clock.advance(10 * MIN);
    const t = tok(r.store.takePreview(S, "web"));
    r.fs.writeBeh = ["fail"];
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_BUSY{io}");
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}");
    ok(await r.store.take(S, "web", tok(r.store.takePreview(S, "web")), ""));
  });

  it("busy (queue/io) also consumes the token", async () => {
    const { r, S } = await base();
    await r.clock.advance(10 * MIN);
    const t = tok(r.store.takePreview(S, "web"));
    r.fs.renameBeh = ["hang"];
    const p = r.store.set(r.mem.up("Z"), "zzz", "");
    await r.clock.advance(1_000);
    expect(code(await p)).toBe("E_XS_ALIAS_UNKNOWN");
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_BUSY{io}");
    r.fs.hung.shift()!.release(true);
    await settle();
    expect(code(await r.store.take(S, "web", t, ""))).toBe("E_XS_ALIAS_TAKE{stale}");
  });

  it("32 live tokens ⇒ BUSY{tokens} (no eviction); expired ones free their slots", async () => {
    const { r, S } = await base();
    await r.clock.advance(10 * MIN);
    for (let i = 0; i < XS_ALIAS_TOKENS_MAX; i++) tok(r.store.takePreview(S, "web"));
    expect(r.store.status().tokens).toBe(32);
    expect(code(r.store.takePreview(S, "web"))).toBe("E_XS_ALIAS_BUSY{tokens}");
    await r.clock.advance(5 * MIN);
    expect(code(r.store.takePreview(S, "web"))).toBe("ok");
    expect(r.store.status().tokens).toBe(1);
  });
});

// ----------------------------------------------------------------- real filesystem

describe("xs aliases: real fs (0600 atomic write, symlink / dir / size refusal)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "xs-aliases-"));
    dirs.push(d);
    return d;
  };
  const mk = (stateDir: string) => {
    const online = new Set<string>(["A"]);
    return createXsAliasStore({
      stateDir,
      isOnline: (s) => online.has(s),
      isRequesterLive: (r) => online.has(r.sessionId),
    });
  };

  it("set writes a 0600 file via a temp + rename; a fresh store reads it back; no temp left", async () => {
    const d = tmp();
    const s = mk(d);
    expect(await s.load()).toEqual({ state: "ready", records: 0, fresh: true });
    expect(readdirSync(d)).toEqual([]);
    ok(await s.set({ sessionId: "A", epoch: 1 }, "前端", "~/web"));
    const f = join(d, XS_ALIAS_FILE);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual([XS_ALIAS_FILE]);
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    expect(parsed).toMatchObject({ version: 1, skeletonVersion: 1, records: [{ alias: "前端", sessionId: "A" }] });
    const s2 = mk(d);
    expect(await s2.load()).toMatchObject({ state: "ready", records: 1 });
    expect(s2.heldBy("A")).toBe("前端");
  });

  it("symlinked file ⇒ unreadable; directory ⇒ unreadable; >64KiB ⇒ corrupt; bytes never touched", async () => {
    const d1 = tmp();
    writeFileSync(join(d1, "real.json"), "{}");
    symlinkSync(join(d1, "real.json"), join(d1, XS_ALIAS_FILE));
    expect(await mk(d1).load()).toEqual({ state: "degraded", reason: "unreadable" });
    const d2 = tmp();
    mkdirSync(join(d2, XS_ALIAS_FILE));
    expect(await mk(d2).load()).toEqual({ state: "degraded", reason: "unreadable" });
    const d3 = tmp();
    const big = "x".repeat(64 * 1024 + 10);
    writeFileSync(join(d3, XS_ALIAS_FILE), big);
    const s3 = mk(d3);
    expect(await s3.load()).toEqual({ state: "degraded", reason: "corrupt" });
    expect(code(await s3.set({ sessionId: "A", epoch: 1 }, "web", ""))).toBe("E_XS_ALIAS_BUSY{io}");
    expect(readFileSync(join(d3, XS_ALIAS_FILE), "utf8")).toBe(big);
    expect(readdirSync(d3)).toEqual([XS_ALIAS_FILE]);
  });
});
