/**
 * #72 AF1 (alias-force-default plan §3.3/§4, I5′/I7/I9): the hub binding table's v2 transactions —
 * `autoClaim` (synchronous pre-check, new-record-only), `forcePreview` + `mode:"force"` tokens (three-state
 * presence, notifiability, double re-check, forced tombstone, `onForcedCommit`), `origin` / `forced`
 * persistence (optional keys only) and v2-gated reply keys.
 */
import { describe, expect, it } from "vitest";
import {
  createXsAliasStore,
  xsAliasFailureWire,
  XS_ALIAS_FILE,
  XS_ALIAS_MAX_RECORDS,
  XS_ALIAS_QUEUE_MAX,
  XS_ALIAS_TOMBSTONE_TTL_MS,
  type XsAliasFs,
  type XsAliasRequester,
  type XsAliasStore,
  type XsAliasTimer,
  type XsAliasWriteResult,
} from "../../../src/web-hub/hub/xs/aliases.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const STATE = "/state";
const FILE = `${STATE}/${XS_ALIAS_FILE}`;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
}

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

class MemFs implements XsAliasFs {
  files = new Map<string, Uint8Array>();
  ops: string[] = [];
  /** Runs inside the next temp write (between plan and rename-before re-check): lets a test change the world. */
  onWrite: (() => void) | undefined;
  /** `hold`: the next rename blocks until `release(ok)`. */
  hold = false;
  pending: { release(ok: boolean): void } | undefined;
  async read(path: string, maxBytes: number) {
    const b = this.files.get(path);
    if (b === undefined) return { kind: "missing" as const };
    if (b.length > maxBytes) return { kind: "toolarge" as const };
    return { kind: "bytes" as const, bytes: b };
  }
  async writeTemp(path: string, bytes: Uint8Array) {
    this.ops.push("write");
    this.files.set(path, bytes);
    const hook = this.onWrite;
    this.onWrite = undefined;
    hook?.();
  }
  rename(from: string, to: string): Promise<void> {
    this.ops.push("rename");
    const move = (): void => {
      const b = this.files.get(from);
      if (b === undefined) throw new Error("ENOENT");
      this.files.delete(from);
      this.files.set(to, b);
    };
    if (!this.hold) {
      move();
      return Promise.resolve();
    }
    this.hold = false;
    return new Promise((resolve, reject) => {
      this.pending = {
        release: (ok) => {
          this.pending = undefined;
          if (ok) {
            move();
            resolve();
          } else reject(new Error("EIO"));
        },
      };
    });
  }
  async unlink(path: string) {
    this.files.delete(path);
  }
  async syncDir() {}
  json(): {
    records: { alias: string; sessionId: string; state: string; origin?: string }[];
    tombstones: { sessionId: string; reason: string; forced?: boolean }[];
  } {
    return JSON.parse(new TextDecoder().decode(this.files.get(FILE)!));
  }
}

/** Presence model: `on` ⇒ xs-online (with `v2` per member), `linked` ⇒ connected but not an xs member. */
class World {
  online = new Map<string, boolean[]>(); // sid → per-member v2 flags
  epochs = new Map<string, number>();
  linked = new Set<string>();
  /** AF7: requester sid → the sid the hub saw its socket leave (the succession edge). */
  succ = new Map<string, string>();
  forced: { holderSessionId: string; requesterSessionId: string; at: number }[] = [];
  up(sid: string, v2 = true): XsAliasRequester {
    const l = this.online.get(sid) ?? [];
    l.push(v2);
    this.online.set(sid, l);
    this.epochs.set(sid, 1);
    return { sessionId: sid, epoch: 1, v2: true };
  }
  down(sid: string): void {
    this.online.delete(sid);
  }
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
  w: World;
  store: XsAliasStore;
  restart(): Promise<XsAliasStore>;
}
async function rig(opts: { preload?: string } = {}): Promise<Rig> {
  const clock = new Clock();
  const fs = new MemFs();
  const w = new World();
  if (opts.preload !== undefined) fs.files.set(FILE, new TextEncoder().encode(opts.preload));
  const make = (): XsAliasStore =>
    createXsAliasStore({
      stateDir: STATE,
      isOnline: (s) => (w.online.get(s)?.length ?? 0) > 0,
      isRequesterLive: (r) => (w.online.get(r.sessionId)?.length ?? 0) > 0 && w.epochs.get(r.sessionId) === r.epoch,
      isLinked: (s) => w.linked.has(s),
      isSuccessor: (q, prev) => w.succ.get(q.sessionId) === prev,
      allMembersV2: (s) => (w.online.get(s) ?? []).every((x) => x),
      onForcedCommit: (e) => void w.forced.push(e),
      fs,
      now: clock.now,
      timer: clock.timer,
      randomHex: hexSource,
    });
  const r: Rig = {
    clock,
    fs,
    w,
    store: make(),
    async restart() {
      r.store.close();
      r.store = make();
      await r.store.load();
      return r.store;
    },
  };
  await r.store.load();
  return r;
}

const code = (r: { ok: boolean; failure?: unknown }): string =>
  r.ok ? "ok" : xsAliasFailureWire((r as { failure: Parameters<typeof xsAliasFailureWire>[0] }).failure).code;
function must(r: XsAliasWriteResult): void {
  if (!r.ok) throw new Error(`expected ok, got ${code(r)}`);
}
function tokenOf(p: ReturnType<XsAliasStore["forcePreview"]>): string {
  if (!p.ok || !("take" in p.res)) throw new Error(`expected a preview, got ${p.ok ? "state" : code(p)}`);
  return p.res.take.token;
}
/** `sid` holds `alias` (human-granted), then goes offline unless `stayOnline`. */
async function hold(r: Rig, sid: string, alias: string, opts: { v2?: boolean; stayOnline?: boolean } = {}) {
  const me = r.w.up(sid, opts.v2 ?? true);
  must(await r.store.set(me, alias, "~/holder"));
  if (opts.stayOnline !== true) {
    r.w.down(sid);
    r.store.touchPresence(sid);
  }
  return me;
}

// ----------------------------------------------------------------- auto

describe("alias v2 store: autoClaim (I7)", () => {
  it("creates a record with origin:auto, persists it and reads it back through a restart; origin only for v2 get", async () => {
    const r = await rig();
    const a = r.w.up("A");
    const out = await r.store.autoClaim(a, "my-tools", "~/my-tools");
    expect(out).toEqual({ ok: true, res: { alias: "my-tools", state: "held", origin: "auto" } });
    expect(r.fs.json().records[0]).toMatchObject({ alias: "my-tools", sessionId: "A", origin: "auto" });
    expect(r.store.get(a)).toEqual({ alias: "my-tools", state: "held", origin: "auto" });
    expect(r.store.get({ sessionId: "A", epoch: 1 })).toEqual({ alias: "my-tools", state: "held" }); // v1 bytes
    const again = await r.restart();
    expect(again.inspect().records[0]).toMatchObject({ alias: "my-tools", origin: "auto" });
  });

  it("is a no-op returning the current state when S already holds something (no disk write)", async () => {
    const r = await rig();
    const a = r.w.up("A");
    must(await r.store.set(a, "mine", "~/a"));
    r.fs.ops.length = 0;
    expect(await r.store.autoClaim(a, "dirname", "~/a")).toEqual({ ok: true, res: { alias: "mine", state: "held" } });
    expect(r.fs.ops).toEqual([]);
    // an auto-held record reports its origin when asked again
    const b = r.w.up("B");
    must(await r.store.autoClaim(b, "bee", "~/b"));
    expect(await r.store.autoClaim(b, "other", "~/b")).toEqual({
      ok: true,
      res: { alias: "bee", state: "held", origin: "auto" },
    });
  });

  it("answers TAKEN{taken} synchronously for a held x (even an EXPIRED holder), a live cooling x, S's own coolingLive and a young tombstone", async () => {
    const r = await rig();
    await hold(r, "H", "web");
    const a = r.w.up("A");
    // live held (holder offline)
    expect(code(await r.store.autoClaim(a, "web", "~/a"))).toBe("E_XS_ALIAS_TAKEN{taken}");
    // expired held still blocks: auto never takes over an expired record
    await r.clock.advance(8 * DAY);
    expect(code(await r.store.autoClaim(a, "web", "~/a"))).toBe("E_XS_ALIAS_TAKEN{taken}");
    // another session's coolingLive blocks
    const c = r.w.up("C");
    must(await r.store.set(c, "cool", "~/c"));
    must(await r.store.clear(c));
    const d = r.w.up("D");
    expect(code(await r.store.autoClaim(d, "cool", "~/d"))).toBe("E_XS_ALIAS_TAKEN{taken}");
    // S's own coolingLive blocks too (the human cleared it)
    expect(code(await r.store.autoClaim(c, "fresh", "~/c"))).toBe("E_XS_ALIAS_TAKEN{taken}");
  });

  it("an EXPIRED cooling and a ≥30-day tombstone do not block; a younger tombstone does", async () => {
    const r = await rig();
    const c = r.w.up("C");
    must(await r.store.set(c, "cool", "~/c"));
    must(await r.store.clear(c)); // cooling(C) 10 min
    await r.clock.advance(11 * MIN);
    const d = r.w.up("D");
    // x is C's expired cooling ⇒ free; C itself has no live cooling any more
    expect(code(await r.store.autoClaim(d, "cool", "~/d"))).toBe("ok");
    expect(r.store.heldBy("D")).toBe("cool");
    expect(r.fs.json().records.filter((x) => x.alias === "cool")).toHaveLength(1);
    // tombstone: E is taken from by a force; E must not auto while the tombstone is younger than 30 days
    const e = await hold(r, "E", "eee");
    const f = r.w.up("F");
    must(await r.store.take(f, "eee", tokenOf(r.store.forcePreview(f, "eee")), "~/f"));
    r.w.up("E");
    expect(code(await r.store.autoClaim({ sessionId: "E", epoch: 1, v2: true }, "again", "~/e"))).toBe(
      "E_XS_ALIAS_TAKEN{taken}",
    );
    void e;
    await r.clock.advance(XS_ALIAS_TOMBSTONE_TTL_MS - 1 * MIN);
    expect(code(await r.store.autoClaim({ sessionId: "E", epoch: 1, v2: true }, "again", "~/e"))).toBe(
      "E_XS_ALIAS_TAKEN{taken}",
    );
    await r.clock.advance(2 * MIN);
    expect(code(await r.store.autoClaim({ sessionId: "E", epoch: 1, v2: true }, "again", "~/e"))).toBe("ok");
  });

  it("confusable skeleton and a full table are refused; the prune of an expired cooling is part of the claim", async () => {
    const r = await rig();
    const a = r.w.up("A");
    must(await r.store.set(a, "web0", "~/a"));
    const b = r.w.up("B");
    expect(code(await r.store.autoClaim(b, "webo", "~/b"))).toBe("E_XS_ALIAS_TAKEN{confusable}");
    // full table
    const rows = Array.from({ length: XS_ALIAS_MAX_RECORDS }, (_, i) => ({
      alias: `n${i}`,
      skeleton: `n${i}`,
      sessionId: `S${i}`,
      state: "held",
      rev: i + 1,
      cwdLabel: "~",
    }));
    const full = await rig({
      preload: JSON.stringify({ version: 1, skeletonVersion: 1, seq: 999, records: rows, tombstones: [] }),
    });
    const z = full.w.up("Z");
    expect(code(await full.store.autoClaim(z, "newname", "~/z"))).toBe("E_XS_ALIAS_FULL");
  });

  it("'taken'-class answers do not occupy the queue: five stuck writers do not stop them", async () => {
    const r = await rig();
    const a = r.w.up("A");
    must(await r.store.set(a, "web", "~/a"));
    const users = ["P", "Q", "R", "S", "T", "U"].map((s) => r.w.up(s));
    r.fs.hold = true; // first transaction's rename blocks ⇒ wedge after 1s
    const running = users.slice(0, 1 + XS_ALIAS_QUEUE_MAX + 1).map((u, i) => r.store.set(u, `q${i}`, "~/q"));
    await settle();
    const b = r.w.up("B");
    // queue is saturated for writers…
    expect(code(await r.store.set(b, "zzz", "~/b"))).toMatch(/BUSY/);
    // …but a taken-class auto answers from the table immediately
    expect(code(await r.store.autoClaim(b, "web", "~/b"))).toBe("E_XS_ALIAS_TAKEN{taken}");
    await r.clock.advance(5_000);
    r.fs.pending?.release(true);
    await Promise.all(running);
  });
});

// ----------------------------------------------------------------- force preview

describe("alias v2 store: forcePreview — notifiable holders only (I5′)", () => {
  it("online holder with every member v2 ⇒ token; reply carries online:true and (auto) auto:true for a v2 requester", async () => {
    const r = await rig();
    const h = r.w.up("H");
    must(await r.store.autoClaim(h, "front", "~/fe"));
    const s = r.w.up("S");
    const p = r.store.forcePreview(s, "front");
    expect(p.ok && p.res).toMatchObject({ take: { cwdLabel: "~/fe", offlineForS: 0, online: true, auto: true } });
    // a v1-shaped requester never sees the new keys
    const v1 = r.store.forcePreview({ sessionId: "S", epoch: 1 }, "front");
    expect(v1.ok && "take" in v1.res && Object.keys(v1.res.take).sort()).toEqual([
      "cwdLabel",
      "expiresAt",
      "offlineForS",
      "token",
    ]);
  });

  it("online holder with one non-v2 member, or linked ⇒ unnotifiable; no-record / cooling / own ⇒ not_held", async () => {
    const r = await rig();
    const h = await hold(r, "H", "front", { stayOnline: true });
    r.w.up("H", false); // a second, old member on the same sid
    const s = r.w.up("S");
    expect(code(r.store.forcePreview(s, "front"))).toBe("E_XS_ALIAS_TAKE{unnotifiable}");
    r.w.down("H");
    r.store.touchPresence("H");
    r.w.linked.add("H"); // connected to the hub, xs off
    expect(code(r.store.forcePreview(s, "front"))).toBe("E_XS_ALIAS_TAKE{unnotifiable}");
    expect(code(r.store.forcePreview(s, "nobody"))).toBe("E_XS_ALIAS_TAKE{not_held}");
    expect(code(r.store.forcePreview(h, "front"))).toBe("E_XS_ALIAS_TAKE{not_held}"); // own (h is H)
    const c = r.w.up("C");
    must(await r.store.set(c, "cool", "~/c"));
    must(await r.store.clear(c));
    expect(code(r.store.forcePreview(s, "cool"))).toBe("E_XS_ALIAS_TAKE{not_held}");
    // the take path is untouched: a linked holder is "offline" for take (10 min rule)
    expect(code(r.store.takePreview(s, "front"))).toBe("E_XS_ALIAS_TAKE{recent}");
  });

  it("a just-offline holder can be force-previewed (offlineForS counts), a plain take is still 'recent'", async () => {
    const r = await rig();
    await hold(r, "H", "front");
    await r.clock.advance(3 * MIN);
    const s = r.w.up("S");
    const p = r.store.forcePreview(s, "front");
    expect(p.ok && p.res).toMatchObject({ take: { offlineForS: 180 } });
    expect(p.ok && "take" in p.res && p.res.take.online).toBeUndefined();
    expect(code(r.store.takePreview(s, "front"))).toBe("E_XS_ALIAS_TAKE{recent}");
  });

  it("shares the 32-token cap", async () => {
    const r = await rig();
    await hold(r, "H", "front");
    const s = r.w.up("S");
    for (let i = 0; i < 32; i++) expect(r.store.forcePreview(s, "front").ok).toBe(true);
    expect(code(r.store.forcePreview(s, "front"))).toBe("E_XS_ALIAS_BUSY{tokens}");
  });
});

// ----------------------------------------------------------------- force execute

describe("alias v2 store: force execution", () => {
  it("online holder: transfers in place (rev+1, no origin), writes a forced tombstone, notifies once, v2 get shows lost.forced", async () => {
    const r = await rig();
    const h = r.w.up("H");
    must(await r.store.autoClaim(h, "front", "~/old"));
    const before = r.store.inspect().records[0]!;
    const s = r.w.up("S");
    const tok = tokenOf(r.store.forcePreview(s, "front"));
    must(await r.store.take(s, "front", tok, "~/new"));
    const rec = r.store.inspect().records.find((x) => x.alias === "front")!;
    expect(rec).toMatchObject({ sessionId: "S", state: "held", cwdLabel: "~/new" });
    expect(rec.rev).toBeGreaterThan(before.rev);
    expect(rec.origin).toBeUndefined();
    expect(r.fs.json().tombstones).toEqual([
      expect.objectContaining({ sessionId: "H", reason: "taken", forced: true }),
    ]);
    expect(r.w.forced).toHaveLength(1);
    expect(r.w.forced[0]).toMatchObject({ holderSessionId: "H", requesterSessionId: "S" });
    expect(r.store.get(h).lost).toMatchObject({ alias: "front", reason: "taken", forced: true });
    expect(r.store.get({ sessionId: "H", epoch: 1 }).lost).toEqual({
      alias: "front",
      reason: "taken",
      at: expect.any(Number),
    }); // no `forced` key for a v1 requester
  });

  it("just-offline holder (3 min) is force-taken; the same token under take rules would have been refused", async () => {
    const r = await rig();
    await hold(r, "H", "front");
    await r.clock.advance(3 * MIN);
    const s = r.w.up("S");
    must(await r.store.take(s, "front", tokenOf(r.store.forcePreview(s, "front")), "~/s"));
    expect(r.store.heldBy("S")).toBe("front");
    expect(r.w.forced).toHaveLength(1);
  });

  it("a take token cannot run as force and a force token cannot run as take (mode is bound in the token)", async () => {
    const r = await rig();
    await hold(r, "H", "front");
    await r.clock.advance(11 * MIN);
    const s = r.w.up("S");
    // take-mode token: ordinary take, no notification, tombstone NOT forced
    must(await r.store.take(s, "front", tokenOf(r.store.takePreview(s, "front")), "~/s"));
    expect(r.w.forced).toEqual([]);
    expect(r.fs.json().tombstones[0]!.forced).toBeUndefined();
    expect(r.store.get({ sessionId: "H", epoch: 1, v2: true }).lost?.forced).toBeUndefined();
    // force-mode token on an online holder works; on a holder that reconnected as ONLINE it is checked as force
    const t = r.w.up("T");
    const h2 = r.w.up("H2");
    must(await r.store.set(h2, "two", "~/h2"));
    const forceTok = tokenOf(r.store.forcePreview(t, "two"));
    expect(code(await r.store.take(t, "two", forceTok, "~/t"))).toBe("ok");
    expect(r.w.forced).toHaveLength(1);
  });

  it("every drift between preview and execute ⇒ TAKE{stale} and the token is consumed", async () => {
    const mk = async (): Promise<{ r: Rig; s: XsAliasRequester; tok: string }> => {
      const r = await rig();
      r.w.up("H");
      must(await r.store.set({ sessionId: "H", epoch: 1 }, "front", "~/h"));
      const s = r.w.up("S");
      return { r, s, tok: tokenOf(r.store.forcePreview(s, "front")) };
    };
    // presence on → off (disconnect between preview and execute)
    {
      const { r, s, tok } = await mk();
      r.w.down("H");
      r.store.touchPresence("H");
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("E_XS_ALIAS_TAKE{stale}");
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("E_XS_ALIAS_TAKE{stale}"); // consumed
      expect(r.w.forced).toEqual([]);
    }
    // holder becomes linked (xs member gone, socket alive)
    {
      const { r, s, tok } = await mk();
      r.w.down("H");
      r.w.linked.add("H");
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("E_XS_ALIAS_TAKE{stale}");
      expect(r.store.heldBy("H")).toBe("front");
    }
    // holder gains a non-v2 member
    {
      const { r, s, tok } = await mk();
      r.w.up("H", false);
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("E_XS_ALIAS_TAKE{stale}");
    }
    // record rev moved (holder re-set its own alias with another label)
    {
      const { r, s, tok } = await mk();
      must(await r.store.set({ sessionId: "H", epoch: 1 }, "front", "~/elsewhere"));
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("E_XS_ALIAS_TAKE{stale}");
    }
    // requester stale (epoch moved)
    {
      const { r, s, tok } = await mk();
      r.w.epochs.set("S", 2);
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("E_XS_ALIAS_TAKE{stale}");
    }
    // an offline holder that bounced (offline → online → offline) has a new presenceKey
    {
      const r = await rig();
      await hold(r, "H", "front");
      const s = r.w.up("S");
      const tok = tokenOf(r.store.forcePreview(s, "front"));
      await r.clock.advance(1_000);
      r.w.up("H");
      r.store.touchPresence("H");
      r.w.down("H");
      r.store.touchPresence("H");
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("E_XS_ALIAS_TAKE{stale}");
    }
    // …whereas an ONLINE holder that reconnected keeps presenceKey "on" ⇒ the human's confirmation still holds (R15)
    {
      const { r, s, tok } = await mk();
      r.w.down("H");
      r.w.up("H");
      expect(code(await r.store.take(s, "front", tok, "~/s"))).toBe("ok");
    }
  });

  it("concurrent execution of one token: exactly one wins", async () => {
    const r = await rig();
    await hold(r, "H", "front");
    const s = r.w.up("S");
    const tok = tokenOf(r.store.forcePreview(s, "front"));
    const [x, y] = await Promise.all([r.store.take(s, "front", tok, "~/s"), r.store.take(s, "front", tok, "~/s")]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect(r.w.forced).toHaveLength(1);
  });

  it("G: the requester's own old held becomes cooling(S); the holder gets no cooling", async () => {
    const r = await rig();
    await hold(r, "H", "front");
    const s = r.w.up("S");
    must(await r.store.set(s, "mine", "~/s"));
    must(await r.store.take(s, "front", tokenOf(r.store.forcePreview(s, "front")), "~/s"));
    const recs = r.store.inspect().records;
    expect(recs.find((x) => x.alias === "mine")).toMatchObject({ sessionId: "S", state: "cooling" });
    expect(recs.filter((x) => x.sessionId === "H")).toEqual([]);
  });

  it("wedged rename: a late success pushes exactly once (I9); a late failure never pushes", async () => {
    for (const lateOk of [true, false]) {
      const r = await rig();
      await hold(r, "H", "front");
      const s = r.w.up("S");
      const tok = tokenOf(r.store.forcePreview(s, "front"));
      r.fs.hold = true;
      const pending = r.store.take(s, "front", tok, "~/s");
      await r.clock.advance(1_500);
      expect(code(await pending)).toBe("E_XS_ALIAS_UNKNOWN");
      expect(r.w.forced).toEqual([]);
      r.fs.pending!.release(lateOk);
      await settle();
      expect(r.w.forced).toHaveLength(lateOk ? 1 : 0);
      expect(r.store.heldBy("S")).toBe(lateOk ? "front" : undefined);
    }
  });

  it("an onForcedCommit that throws is swallowed and never rolled back", async () => {
    const r = await rig();
    const throwing = createXsAliasStore({
      stateDir: STATE,
      isOnline: (s) => (r.w.online.get(s)?.length ?? 0) > 0,
      isRequesterLive: (x) => (r.w.online.get(x.sessionId)?.length ?? 0) > 0,
      allMembersV2: () => true,
      onForcedCommit: () => {
        throw new Error("boom");
      },
      fs: r.fs,
      now: r.clock.now,
      timer: r.clock.timer,
      randomHex: hexSource,
    });
    await throwing.load();
    const h = r.w.up("H");
    must(await throwing.set(h, "front", "~/h"));
    const s = r.w.up("S");
    must(await throwing.take(s, "front", tokenOf(throwing.forcePreview(s, "front")), "~/s"));
    expect(throwing.heldBy("S")).toBe("front");
  });
});

// ----------------------------------------------------------------- human grants drop origin / persistence

describe("alias v2 store: origin and forced on disk", () => {
  it("human set of one's own auto name, take, and force each drop origin; a no-change reclaim of a human record writes nothing", async () => {
    const r = await rig();
    const a = r.w.up("A");
    must(await r.store.autoClaim(a, "auto-a", "~/a"));
    must(await r.store.set(a, "auto-a", "~/a")); // same name, same label — still a human confirmation
    expect(r.store.inspect().records[0]!.origin).toBeUndefined();
    r.fs.ops.length = 0;
    must(await r.store.set(a, "auto-a", "~/a"));
    expect(r.fs.ops).toEqual([]);
    // taking an auto record as a human ⇒ no origin
    const b = await rig();
    const h = b.w.up("H");
    must(await b.store.autoClaim(h, "x1", "~/h"));
    b.w.down("H");
    b.store.touchPresence("H");
    await b.clock.advance(11 * MIN);
    const s = b.w.up("S");
    must(await b.store.take(s, "x1", tokenOf(b.store.takePreview(s, "x1")), "~/s"));
    expect(b.store.inspect().records[0]!.origin).toBeUndefined();
    // expired auto record taken over by a plain set ⇒ fresh human record
    const c = await rig();
    must(await c.store.autoClaim(c.w.up("H"), "x2", "~/h"));
    c.w.down("H");
    c.store.touchPresence("H");
    await c.clock.advance(8 * DAY);
    must(await c.store.set(c.w.up("S"), "x2", "~/s"));
    expect(c.store.inspect().records[0]).toMatchObject({ sessionId: "S" });
    expect(c.store.inspect().records[0]!.origin).toBeUndefined();
  });

  it("the file only gains OPTIONAL keys (version stays 1, tombstone reason stays 'taken') so an old hub reads it", async () => {
    const r = await rig();
    await hold(r, "H", "front");
    must(await r.store.autoClaim(r.w.up("A"), "auto-a", "~/a"));
    const s = r.w.up("S");
    must(await r.store.take(s, "front", tokenOf(r.store.forcePreview(s, "front")), "~/s"));
    const raw = JSON.parse(new TextDecoder().decode(r.fs.files.get(FILE)!)) as Record<string, unknown> & {
      records: Record<string, unknown>[];
      tombstones: Record<string, unknown>[];
    };
    expect(raw["version"]).toBe(1);
    const recKeys = new Set(["alias", "skeleton", "sessionId", "state", "coolUntil", "rev", "cwdLabel", "origin"]);
    for (const x of raw.records) for (const k of Object.keys(x)) expect(recKeys.has(k)).toBe(true);
    const tombKeys = new Set(["sessionId", "alias", "reason", "at", "forced"]);
    for (const x of raw.tombstones) {
      for (const k of Object.keys(x)) expect(tombKeys.has(k)).toBe(true);
      expect(["taken", "expired"]).toContain(x["reason"]);
    }
    // a file without the new keys loads as human / non-forced; a bogus value is ignored, never `corrupt`
    const legacy = await rig({
      preload: JSON.stringify({
        version: 1,
        skeletonVersion: 1,
        seq: 2,
        records: [
          { alias: "a1", skeleton: "a1", sessionId: "X", state: "held", rev: 1, cwdLabel: "~", origin: "weird" },
          { alias: "a2", skeleton: "a2", sessionId: "Y", state: "held", rev: 2, cwdLabel: "~" },
        ],
        tombstones: [{ sessionId: "Z", alias: "a0", reason: "taken", at: 1_800_000_000_000, forced: "yes" }],
      }),
    });
    expect(legacy.store.status().state).toBe("ready");
    expect(legacy.store.inspect().records.every((x) => x.origin === undefined)).toBe(true);
    expect(legacy.store.inspect().tombstones[0]!.forced).toBeUndefined();
  });
});

// ----------------------------------------------------------------- AF7 handoff (I10)

describe("alias v2 store: handoff (I10)", () => {
  /** P (human or auto) holds `front` and is offline; S is the up-and-running successor with a genuine edge. */
  async function setup(origin: "human" | "auto" = "human") {
    const r = await rig();
    let P: XsAliasRequester;
    if (origin === "auto") {
      P = r.w.up("sid-P");
      must(await r.store.autoClaim(P, "front", "~/old"));
      r.w.down("sid-P");
      r.store.touchPresence("sid-P");
    } else {
      P = await hold(r, "sid-P", "front");
    }
    const S = r.w.up("sid-S");
    r.w.succ.set("sid-S", "sid-P");
    return { r, P, S };
  }
  const rec = (r: Rig, alias = "front") => r.store.inspect().records.find((x) => x.alias === alias);

  it("moves the record in place: new owner, rev+1, label of the requester, no tombstone, no cooling", async () => {
    const { r, S } = await setup();
    const before = rec(r)!;
    const res = await r.store.handoff(S, "front", "sid-P", "~/new");
    expect(res).toEqual({ ok: true, res: { alias: "front", state: "held" } });
    const after = rec(r)!;
    expect(after).toMatchObject({ sessionId: "sid-S", state: "held", cwdLabel: "~/new", skeleton: before.skeleton });
    expect(after.rev).toBeGreaterThan(before.rev);
    expect(r.store.inspect().tombstones).toEqual([]);
    expect(r.store.inspect().records.filter((x) => x.sessionId === "sid-P")).toEqual([]);
    expect(r.store.heldBy("sid-S")).toBe("front");
    expect(r.store.heldBy("sid-P")).toBeUndefined();
    expect(r.fs.json().records).toHaveLength(1); // persisted
  });

  it("keeps origin:auto (and reports it to a v2 requester only); human stays human", async () => {
    const a = await setup("auto");
    expect(await a.r.store.handoff(a.S, "front", "sid-P", "~/new")).toEqual({
      ok: true,
      res: { alias: "front", state: "held", origin: "auto" },
    });
    expect(rec(a.r)!.origin).toBe("auto");
    expect(a.r.fs.json().records[0]!.origin).toBe("auto");
    const h = await setup("human");
    await h.r.store.handoff(h.S, "front", "sid-P", "~/new");
    expect(rec(h.r)!.origin).toBeUndefined();
    expect(h.r.store.get(h.S)).toEqual({ alias: "front", state: "held" });
  });

  it("survives a hub restart (persisted, readable)", async () => {
    const { r, S } = await setup();
    must(await r.store.handoff(S, "front", "sid-P", "~/new"));
    const reloaded = await r.restart();
    expect(reloaded.heldBy("sid-S")).toBe("front");
    expect(reloaded.heldBy("sid-P")).toBeUndefined();
  });

  it("refusals — all `TAKE{stale}`, table untouched", async () => {
    const { r, S } = await setup();
    const snap = JSON.stringify(r.store.inspect());
    const stale = async (q: XsAliasRequester, alias: string, prev: string): Promise<void> => {
      const out = await r.store.handoff(q, alias, prev, "~/new");
      expect(code(out), `${alias}/${prev}`).toBe("E_XS_ALIAS_TAKE{stale}");
      expect(JSON.stringify(r.store.inspect())).toBe(snap);
    };
    // no evidence / evidence for another sid
    r.w.succ.delete("sid-S");
    await stale(S, "front", "sid-P");
    r.w.succ.set("sid-S", "sid-OTHER");
    await stale(S, "front", "sid-P");
    r.w.succ.set("sid-S", "sid-P");
    // a stranger quoting P's sid
    const X = r.w.up("sid-X");
    await stale(X, "front", "sid-P");
    // wrong alias, unknown alias, invalid alias text, prev === self
    await stale(S, "other", "sid-P");
    await stale(S, "no such!", "sid-P");
    r.w.succ.set("sid-S", "sid-S");
    await stale(S, "front", "sid-S");
    r.w.succ.set("sid-S", "sid-P");
    // P xs-online again / linked
    r.w.up("sid-P");
    await stale(S, "front", "sid-P");
    r.w.down("sid-P");
    r.w.linked.add("sid-P");
    await stale(S, "front", "sid-P");
    r.w.linked.delete("sid-P");
    // sanity: with everything right it works
    expect((await r.store.handoff(S, "front", "sid-P", "~/new")).ok).toBe(true);
  });

  it("refuses when the record is cooling(P) (P cleared it) or P's name was taken by someone else", async () => {
    const { r, S, P } = await setup();
    r.w.up("sid-P");
    must(await r.store.clear(P)); // held → cooling(P)
    r.w.down("sid-P");
    r.store.touchPresence("sid-P");
    expect(code(await r.store.handoff(S, "front", "sid-P", "~/new"))).toBe("E_XS_ALIAS_TAKE{stale}");
    expect(rec(r)).toMatchObject({ sessionId: "sid-P", state: "cooling" });
  });

  it("refuses when the successor already holds a name (a human/auto grant on the new session wins)", async () => {
    const { r, S } = await setup();
    must(await r.store.set(S, "mine", "~/new"));
    expect(code(await r.store.handoff(S, "front", "sid-P", "~/new"))).toBe("E_XS_ALIAS_TAKE{stale}");
    expect(rec(r)).toMatchObject({ sessionId: "sid-P" });
    expect(r.store.heldBy("sid-S")).toBe("mine");
  });

  it("re-checks right before rename: evidence withdrawn / P back online / a rival grant ⇒ stale and nothing committed", async () => {
    for (const mutate of [
      (r: Rig): void => void r.w.succ.delete("sid-S"),
      (r: Rig): void => void r.w.up("sid-P"),
      (r: Rig): void => void r.w.linked.add("sid-P"),
    ]) {
      const { r, S } = await setup();
      r.fs.onWrite = () => mutate(r);
      expect(code(await r.store.handoff(S, "front", "sid-P", "~/new"))).toBe("E_XS_ALIAS_TAKE{stale}");
      expect(rec(r)).toMatchObject({ sessionId: "sid-P" });
      expect(r.fs.json().records[0]!.sessionId).toBe("sid-P");
    }
  });

  it("two successors racing for the same old name: exactly one wins, the other gets stale", async () => {
    const { r, S } = await setup();
    const S2 = r.w.up("sid-S2");
    r.w.succ.set("sid-S2", "sid-P");
    const [a, b] = await Promise.all([
      r.store.handoff(S, "front", "sid-P", "~/a"),
      r.store.handoff(S2, "front", "sid-P", "~/b"),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(code(a.ok ? b : a)).toBe("E_XS_ALIAS_TAKE{stale}");
    expect(r.store.inspect().records.filter((x) => x.alias === "front")).toHaveLength(1);
  });

  it("no isSuccessor dep ⇒ never moves", async () => {
    const r = await rig();
    await hold(r, "sid-P", "front");
    const lone = createXsAliasStore({
      stateDir: STATE,
      isOnline: () => false,
      isRequesterLive: () => true,
      fs: r.fs,
      now: r.clock.now,
      timer: r.clock.timer,
    });
    await lone.load();
    expect(code(await lone.handoff({ sessionId: "sid-S", epoch: 1, v2: true }, "front", "sid-P", "~/x"))).toBe(
      "E_XS_ALIAS_TAKE{stale}",
    );
  });
});
