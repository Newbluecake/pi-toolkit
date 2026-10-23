/**
 * AL1 property suite (alias-plan r4 §9 AL1): random set / clear / take-preview / take, members going
 * up and down, clock advances, IO faults (fail / hang / late success / late failure) and restarts.
 * After every step: I1–I3, I5, presence never on disk, a provably-none failure changes neither memory
 * nor disk, the main file only changes on a write step, temp names are never reused, and whenever no
 * rename is in flight memory equals the parsed disk. A restart always loads exactly the disk content.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aliasSkeleton } from "../../../src/web-hub/protocol/xs-alias.js";
import {
  createXsAliasStore,
  XS_ALIAS_FILE,
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

type Beh = "ok" | "fail" | "hang";
interface Hung {
  op: "write" | "rename";
  release(ok: boolean): void;
}
class MemFs implements XsAliasFs {
  files = new Map<string, Uint8Array>();
  writeBeh: Beh[] = [];
  renameBeh: Beh[] = [];
  hung: Hung[] = [];
  tempsCreated: string[] = [];
  private hang<T>(op: Hung["op"], effect: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.hung.push({ op, release: (ok) => (ok ? resolve(effect()) : reject(new Error("late fail"))) });
    });
  }
  async read(path: string, maxBytes: number) {
    const b = this.files.get(path);
    if (b === undefined) return { kind: "missing" as const };
    if (b.length > maxBytes) return { kind: "toolarge" as const };
    return { kind: "bytes" as const, bytes: b };
  }
  async writeTemp(path: string, bytes: Uint8Array) {
    this.tempsCreated.push(path);
    const beh = this.writeBeh.shift() ?? "ok";
    const effect = () => {
      if (this.files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      this.files.set(path, bytes);
    };
    if (beh === "fail") throw new Error("ENOSPC");
    if (beh === "hang") return this.hang("write", effect);
    effect();
  }
  async rename(from: string, to: string) {
    const beh = this.renameBeh.shift() ?? "ok";
    const effect = () => {
      const b = this.files.get(from);
      if (b === undefined) throw new Error("ENOENT");
      this.files.delete(from);
      this.files.set(to, b);
    };
    if (beh === "fail") throw new Error("EXDEV");
    if (beh === "hang") return this.hang("rename", effect);
    effect();
  }
  async unlink(path: string) {
    this.files.delete(path);
  }
  async syncDir() {}
}

const SIDS = ["A", "B", "C", "D"] as const;
const ALIASES = ["web", "web0", "webo", "api", "前端", "前端一", "前端-", "x"] as const;
const ADVANCES = [1_000, 3_000, 5 * MIN, 11 * MIN, DAY, 8 * DAY] as const;

type Cmd =
  | { k: "up"; sid: number }
  | { k: "down"; sid: number; touch: boolean }
  | { k: "advance"; i: number }
  | { k: "set"; sid: number; alias: number; label: number }
  | { k: "clear"; sid: number }
  | { k: "preview"; sid: number; alias: number }
  | { k: "take"; sid: number; alias: number; token: number }
  | { k: "fault"; write: Beh; rename: Beh }
  | { k: "release"; ok: boolean }
  | { k: "restart"; renameOk: boolean };

const sidArb = fc.integer({ min: 0, max: SIDS.length - 1 });
const aliasArb = fc.integer({ min: 0, max: ALIASES.length - 1 });
const behArb = fc.constantFrom<Beh>("ok", "ok", "ok", "fail", "hang");
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("up" as const), sid: sidArb }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("down" as const), sid: sidArb, touch: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("advance" as const), i: fc.integer({ min: 0, max: 5 }) }) },
  {
    weight: 6,
    arbitrary: fc.record({ k: fc.constant("set" as const), sid: sidArb, alias: aliasArb, label: fc.nat(2) }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("clear" as const), sid: sidArb }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("preview" as const), sid: sidArb, alias: aliasArb }) },
  {
    weight: 3,
    arbitrary: fc.record({ k: fc.constant("take" as const), sid: sidArb, alias: aliasArb, token: fc.nat(7) }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("fault" as const), write: behArb, rename: behArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("release" as const), ok: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("restart" as const), renameOk: fc.boolean() }) },
);

interface World {
  clock: Clock;
  fs: MemFs;
  online: Map<string, number>;
  epochs: Map<string, number>;
  store: XsAliasStore;
  tokens: { sid: string; alias: string; token: string }[];
  /** The transaction whose rename is still in flight (it answered UNKNOWN). Its eventual commit is
   *  attributed to that transaction: same actor, and I5 is judged against the online holders at the
   *  transaction's own step (§3.3-4: the linearization point is the rename-before re-check, so a
   *  holder reconnecting while the rename is pending is ordered AFTER the commit). */
  pendingRename?: { actor: string; onlineHeld: Map<string, string> };
}

function mkStore(w: Omit<World, "store" | "tokens">): XsAliasStore {
  let n = 0;
  const base = Math.floor(Math.random() * 0xffff) * 0x10000; // per store: restarts never reuse temp names
  return createXsAliasStore({
    stateDir: STATE,
    isOnline: (s) => (w.online.get(s) ?? 0) > 0,
    isRequesterLive: (r) => (w.online.get(r.sessionId) ?? 0) > 0 && w.epochs.get(r.sessionId) === r.epoch,
    fs: w.fs,
    now: w.clock.now,
    timer: w.clock.timer,
    randomHex: (bytes) =>
      (base + ++n)
        .toString(16)
        .padStart(bytes * 2, "0")
        .slice(-bytes * 2),
  });
}

const req = (w: World, sid: string): XsAliasRequester => ({ sessionId: sid, epoch: w.epochs.get(sid) ?? 1 });

async function drive(w: World, p: Promise<XsAliasWriteResult>): Promise<XsAliasWriteResult> {
  let done: XsAliasWriteResult | undefined;
  void p.then((v) => (done = v));
  for (let i = 0; i < 20 && done === undefined; i++) {
    await settle();
    if (done === undefined) await w.clock.advance(250);
  }
  if (done === undefined) throw new Error("transaction never settled (unbounded)");
  return done;
}

function diskState(fs: MemFs): { records: unknown[]; tombstones: unknown[] } | undefined {
  const b = fs.files.get(FILE);
  if (b === undefined) return undefined;
  const j = JSON.parse(new TextDecoder().decode(b)) as { records: unknown[]; tombstones: unknown[] };
  return { records: j.records, tombstones: j.tombstones };
}
function memState(store: XsAliasStore): { records: unknown[]; tombstones: unknown[] } {
  const s = store.inspect();
  const sortBy = <T>(xs: T[], k: (x: T) => string) => [...xs].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
  return {
    records: sortBy(s.records, (r) => r.alias).map((r) => ({
      alias: r.alias,
      skeleton: r.skeleton,
      sessionId: r.sessionId,
      state: r.state,
      ...(r.coolUntil !== undefined ? { coolUntil: r.coolUntil } : {}),
      rev: r.rev,
      cwdLabel: r.cwdLabel,
    })),
    tombstones: sortBy(s.tombstones, (x) => x.sessionId),
  };
}

function checkInvariants(w: World): void {
  const { records } = w.store.inspect();
  const t = w.clock.t;
  // I1
  expect(new Set(records.map((r) => r.alias)).size).toBe(records.length);
  // I2
  const held = records.filter((r) => r.state === "held");
  expect(new Set(held.map((r) => r.sessionId)).size).toBe(held.length);
  // I3 over held ∪ coolingLive
  const live = records.filter((r) => r.state === "held" || (r.coolUntil !== undefined && t < r.coolUntil));
  const bySkel = new Map<string, string>();
  for (const r of live) {
    expect(r.skeleton).toBe(aliasSkeleton(r.alias));
    const prev = bySkel.get(r.skeleton);
    if (prev !== undefined) expect(prev).toBe(r.sessionId);
    bySkel.set(r.skeleton, r.sessionId);
  }
  // presence never reaches the disk
  const text = w.fs.files.get(FILE);
  if (text !== undefined) expect(new TextDecoder().decode(text)).not.toMatch(/online|offlineSince|presence/);
  // temp names never reused
  expect(new Set(w.fs.tempsCreated).size).toBe(w.fs.tempsCreated.length);
  const st = w.store.status();
  expect(st.tokens).toBeLessThanOrEqual(32);
  expect(st.queue).toBe(0);
  // memory ≡ disk whenever no rename is in flight and the store is serving
  const renameInFlight = w.fs.hung.some((h) => h.op === "rename");
  if (!renameInFlight && st.state !== "degraded") {
    const disk = diskState(w.fs);
    if (disk === undefined) expect(memState(w.store)).toEqual({ records: [], tombstones: [] });
    else expect(memState(w.store)).toEqual(disk);
  }
}

async function step(w: World, c: Cmd): Promise<void> {
  const diskBefore = w.fs.files.get(FILE);
  const memBefore = JSON.stringify(memState(w.store));
  const onlineHeldBefore = new Map(
    w.store
      .inspect()
      .records.filter((r) => r.state === "held" && (w.online.get(r.sessionId) ?? 0) > 0)
      .map((r) => [r.alias, r.sessionId]),
  );
  let writeStep = false;
  let actor: string | undefined;
  /** I5 baseline: online holders at the linearization point of the change being judged. */
  let i5Base = onlineHeldBefore;
  /** I5 only skips holders that went offline when the change linearizes NOW (not for a late rename). */
  let i5SkipNowOffline = true;
  let result: XsAliasWriteResult | undefined;

  switch (c.k) {
    case "up": {
      const sid = SIDS[c.sid]!;
      w.online.set(sid, (w.online.get(sid) ?? 0) + 1);
      if (!w.epochs.has(sid)) w.epochs.set(sid, 1);
      w.store.touchPresence(sid);
      break;
    }
    case "down": {
      const sid = SIDS[c.sid]!;
      const n = (w.online.get(sid) ?? 0) - 1;
      if (n <= 0) w.online.delete(sid);
      else w.online.set(sid, n);
      if (c.touch) w.store.touchPresence(sid);
      break;
    }
    case "advance":
      await w.clock.advance(ADVANCES[c.i]!);
      break;
    case "fault":
      w.fs.writeBeh = [c.write];
      w.fs.renameBeh = [c.rename];
      break;
    case "release": {
      const h = w.fs.hung.shift();
      if (h !== undefined) {
        if (h.op === "rename") {
          writeStep = true;
          const pending = w.pendingRename;
          delete w.pendingRename;
          if (pending !== undefined) {
            actor = pending.actor;
            i5Base = pending.onlineHeld;
            i5SkipNowOffline = false;
          }
        }
        h.release(c.ok);
        await settle();
      }
      break;
    }
    case "set":
    case "clear":
    case "take": {
      const sid = SIDS[c.sid]!;
      if ((w.online.get(sid) ?? 0) === 0) break; // the router only admits effective members
      writeStep = true;
      actor = sid;
      if (c.k === "set") {
        result = await drive(w, w.store.set(req(w, sid), ALIASES[c.alias]!, `~/p${c.label}`));
      } else if (c.k === "clear") {
        result = await drive(w, w.store.clear(req(w, sid)));
      } else {
        const tok = w.tokens[c.token % Math.max(1, w.tokens.length)];
        const token = tok?.token ?? "k0000000000000000";
        result = await drive(w, w.store.take(req(w, sid), ALIASES[c.alias]!, token, "~/t"));
      }
      break;
    }
    case "preview": {
      const sid = SIDS[c.sid]!;
      if ((w.online.get(sid) ?? 0) === 0) break;
      const pv = w.store.takePreview(req(w, sid), ALIASES[c.alias]!);
      if (pv.ok && "take" in pv.res) w.tokens.push({ sid, alias: ALIASES[c.alias]!, token: pv.res.take.token });
      break;
    }
    case "restart": {
      // the old process dies: in-flight IO either landed or not
      for (const h of w.fs.hung.splice(0)) h.release(h.op === "rename" ? c.renameOk : false);
      delete w.pendingRename;
      await settle();
      w.store.close();
      w.store = mkStore(w);
      const lr = await w.store.load();
      expect(lr.state).toBe("ready"); // the store never writes a corrupt file
      w.tokens = [];
      const disk = diskState(w.fs);
      expect(memState(w.store)).toEqual(disk ?? { records: [], tombstones: [] });
      return;
    }
  }

  // a provably-none failure changes neither memory nor disk
  if (result !== undefined && !result.ok && result.failure.code !== "E_XS_ALIAS_UNKNOWN") {
    expect(JSON.stringify(memState(w.store))).toBe(memBefore);
    expect(w.fs.files.get(FILE)).toBe(diskBefore);
  }
  // UNKNOWN ⇒ wedged with the old table still served
  if (result !== undefined && !result.ok && result.failure.code === "E_XS_ALIAS_UNKNOWN") {
    expect(w.store.status().state).toBe("wedged");
    expect(JSON.stringify(memState(w.store))).toBe(memBefore);
    expect(w.pendingRename).toBeUndefined(); // wedged ⇒ at most one rename in flight
    w.pendingRename = { actor: actor!, onlineHeld: onlineHeldBefore };
  }
  // I6: the main file only changes on a write step (presence/time/preview never write)
  if (!writeStep) expect(w.fs.files.get(FILE)).toBe(diskBefore);
  // I5: an online holder never loses its held alias to someone else
  for (const [alias, sid] of i5Base) {
    if (sid === actor) continue;
    if (i5SkipNowOffline && (w.online.get(sid) ?? 0) === 0) continue;
    const rec = w.store.inspect().records.find((r) => r.alias === alias);
    expect(rec?.sessionId).toBe(sid);
  }
  checkInvariants(w);
}

/** Fixed seed by default (deterministic CI); `XS_ALIAS_PROP_SEED=random` explores fresh seeds. */
const SEED_ENV = process.env["XS_ALIAS_PROP_SEED"];
const SEED: number | undefined = SEED_ENV === "random" ? undefined : Number(SEED_ENV ?? 20261023);

describe("xs aliases: property (I1–I6, IO faults, restarts)", () => {
  it("random op sequences keep every invariant", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { minLength: 5, maxLength: 60, size: "max" }), async (cmds) => {
        const base = {
          clock: new Clock(),
          fs: new MemFs(),
          online: new Map<string, number>([
            ["A", 1],
            ["B", 1],
            ["C", 1],
          ]),
          epochs: new Map<string, number>([
            ["A", 1],
            ["B", 1],
            ["C", 1],
          ]),
        };
        const w: World = { ...base, store: mkStore(base), tokens: [] };
        await w.store.load();
        for (const c of cmds) await step(w, c);
        // quiesce: settle all IO, then a restart must reproduce memory exactly
        while (w.fs.hung.length > 0) await step(w, { k: "release", ok: true });
        const before = memState(w.store);
        await step(w, { k: "restart", renameOk: true });
        if (w.store.status().state === "ready") expect(memState(w.store)).toEqual(before);
      }),
      { numRuns: 200, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
  }, 120_000);
});
