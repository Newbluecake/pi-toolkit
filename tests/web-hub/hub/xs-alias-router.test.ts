/**
 * AL2 (alias-plan r4 §3.3 matrix, §3.6, §5, §6): hub routing over the alias binding table.
 *
 * - `aliasUsable(self) = advertised ∧ caps ∋ xs.alias.v1`: alias tier (hit ⇒ that tier only, NQ2),
 *   rows/candidates/target `alias`, rows with an alias first (Q11), target always carries the full
 *   sessionId, plain send exact-only (§R3 M1), `from.alias` per RECIPIENT (send / reply / broadcast).
 * - state × behaviour matrix: ready → wedged → ready (late rename ok / failed), wedged → disabled —
 *   in every state "A holds 前端, B's display name is 前端" never reaches B for an aliasUsable requester.
 * - degraded: no cap, alias-shaped names ⇒ E_XS_ALIAS_UNAVAILABLE for an alias-capable requester
 *   (refs still work), no-cap requesters keep the legacy four tiers.
 * - key absent (no table handed in): no guard, op alias ⇒ BAD_FRAME, everything legacy.
 * - op:"alias" get/set/clear/take preview/take through the router, presence feed wiring, audit hygiene.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import {
  createXsAliasBinding,
  createXsRelay,
  hubXsAliasParamsOf,
  mergeHubXsAliasConfig,
  normalizeHubXsAliasConfig,
  type XsRelay,
} from "../../../src/web-hub/hub/xs/router.js";
import {
  XS_ALIAS_DEFAULT_PARAMS,
  XS_ALIAS_FILE,
  type XsAliasFs,
  type XsAliasTimer,
} from "../../../src/web-hub/hub/xs/aliases.js";
import { normalizeHubCrossSessionConfig } from "../../../src/web-hub/hub/xs/limits.js";
import { aliasSkeleton } from "../../../src/web-hub/protocol/xs-alias.js";
import type { XsAckFrame, XsDeliverFrame, XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { fakeConn, hello, memLog, type FakeConn, type MemLog } from "./helpers.js";
import { BCAST_LIMITS, CHANNEL_CAPS, LIMITS, memberFrame, session } from "./xs-fixtures.js";

const MIN = 60_000;
const STATE = "/state";
const FILE = `${STATE}/${XS_ALIAS_FILE}`;
const ALIAS_CAPS = [...CHANNEL_CAPS, "xs.alias.v1"];
const OLD_CAPS = ["ev.v1", "xs.v1"];

// ----------------------------------------------------------------- in-memory fs with a rename gate

class MemFs implements XsAliasFs {
  files = new Map<string, Uint8Array>();
  hangRename = false;
  readThrows = false;
  pending: { release(ok: boolean): void } | undefined;
  async read(path: string, maxBytes: number) {
    if (this.readThrows) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    const b = this.files.get(path);
    if (b === undefined) return { kind: "missing" as const };
    if (b.length > maxBytes) return { kind: "toolarge" as const };
    return { kind: "bytes" as const, bytes: b };
  }
  async writeTemp(path: string, bytes: Uint8Array) {
    if (this.files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.files.set(path, bytes);
  }
  rename(from: string, to: string): Promise<void> {
    const move = (): void => {
      const b = this.files.get(from);
      if (b === undefined) throw new Error("ENOENT");
      this.files.set(to, b);
      this.files.delete(from);
    };
    if (!this.hangRename) {
      move();
      return Promise.resolve();
    }
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
  text(): string | undefined {
    const b = this.files.get(FILE);
    return b === undefined ? undefined : new TextDecoder().decode(b);
  }
}

/** A persisted v1 file holding `records` (alias → sessionId, all held). */
function fileOf(records: Array<{ alias: string; sessionId: string }>): Uint8Array {
  const shape = {
    version: 1,
    skeletonVersion: 1,
    seq: records.length,
    records: records
      .slice()
      .sort((a, b) => (a.alias < b.alias ? -1 : 1))
      .map((r, i) => ({
        alias: r.alias,
        skeleton: aliasSkeleton(r.alias),
        sessionId: r.sessionId,
        state: "held",
        rev: i + 1,
        cwdLabel: "~/x",
      })),
    tombstones: [],
  };
  return new TextEncoder().encode(`${JSON.stringify(shape)}\n`);
}

// ----------------------------------------------------------------- rig

interface Agent {
  key: string;
  conn: FakeConn;
  sessionId: string;
}
interface AliasRig {
  clock: { t: number };
  registry: Registry;
  relay: XsRelay;
  log: MemLog;
  fs: MemFs;
  agent(o: {
    pid: number;
    sessionId: string;
    name?: string;
    cwd?: string;
    caps?: string[];
    joined?: boolean;
    channels?: string[];
    receive?: "off" | "deliver" | "wake" | "replies";
  }): Agent;
  close(a: Agent): void;
}

const timer: XsAliasTimer = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(h) };
};

async function aliasRig(opts: { table?: "none" | "fresh" | "corrupt"; fs?: MemFs } = {}): Promise<AliasRig> {
  const clock = { t: 1_800_000_000_000 };
  const log = memLog();
  const registry = createRegistry({ now: () => clock.t, log, pidAlive: () => true });
  const fs = opts.fs ?? new MemFs();
  if (opts.table === "corrupt") fs.files.set(FILE, new TextEncoder().encode("{not json"));
  let hex = 0;
  const binding =
    opts.table === "none"
      ? undefined
      : createXsAliasBinding({
          stateDir: STATE,
          params: { ...XS_ALIAS_DEFAULT_PARAMS },
          now: () => clock.t,
          fs,
          timer,
          randomHex: (bytes) => (++hex).toString(16).padStart(bytes * 2, "0"),
        });
  if (binding !== undefined) await binding.store.load();
  const relay = createXsRelay({
    registry,
    config: { home: "/home/u", crossSession: { limits: { hubSendsPerMin: 600 } } },
    log,
    now: () => clock.t,
    ...(binding === undefined ? {} : { aliases: binding }),
  });
  return {
    clock,
    registry,
    relay,
    log,
    fs,
    agent(o) {
      const conn = fakeConn();
      const { agentKey } = registry.register(
        hello({
          agentId: { pid: o.pid, nonce: `nonce${String(o.pid).padStart(15, "0")}` },
          caps: o.caps ?? ALIAS_CAPS,
          cwd: o.cwd ?? "/home/u/work",
        }),
        conn,
      );
      registry.onFrame(
        agentKey,
        session({
          sessionId: o.sessionId,
          cwd: o.cwd ?? "/home/u/work",
          ...(o.name !== undefined ? { name: o.name } : {}),
        }),
      );
      registry.onFrame(
        agentKey,
        memberFrame({
          sessionId: o.sessionId,
          joined: o.joined ?? true,
          receive: o.receive ?? "wake",
          limits: { ...LIMITS, listPerMin: 600, sendsOutPerMin: 600, sendsOutPerHour: 6000, ...BCAST_LIMITS },
          ...(o.channels === undefined ? {} : { channels: o.channels }),
        }),
      );
      clock.t += 1;
      return { key: agentKey, conn, sessionId: o.sessionId };
    },
    close(a) {
      registry.onClose(a.key, false);
    },
  };
}

let seq = 0;
function req(a: Agent, over: Partial<XsReqFrame> & Pick<XsReqFrame, "op">): XsReqFrame {
  return { t: "xs_req", rid: `a${++seq}`, origin: { sessionId: a.sessionId, epoch: 1 }, ...over };
}
/** Synchronous answer (resolve/list/send refusals). */
function call(r: AliasRig, a: Agent, over: Partial<XsReqFrame> & Pick<XsReqFrame, "op">): XsResFrame {
  const out: XsResFrame[] = [];
  r.relay.router.handle(a.key, req(a, over), (res) => out.push(res));
  expect(out.length).toBe(1);
  return out[0]!;
}
/** Asynchronous answer (alias writes): flush microtasks + store IO. */
async function callAsync(
  r: AliasRig,
  a: Agent,
  over: Partial<XsReqFrame> & Pick<XsReqFrame, "op">,
  advanceMs = 0,
): Promise<XsResFrame | undefined> {
  const out: XsResFrame[] = [];
  r.relay.router.handle(a.key, req(a, over), (res) => out.push(res));
  for (let i = 0; i < 10 && out.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
  if (out.length === 0 && advanceMs > 0) {
    r.clock.t += advanceMs;
    await vi.advanceTimersByTimeAsync(advanceMs);
  }
  return out[0];
}
async function setAlias(r: AliasRig, a: Agent, alias: string): Promise<void> {
  const res = await callAsync(r, a, { op: "alias", alias });
  expect(res, alias).toMatchObject({ ok: true, alias: { alias, state: "held" } });
}
const delivers = (conn: { sent: unknown[] }): XsDeliverFrame[] =>
  conn.sent.filter((x) => (x as { t?: string }).t === "xs_deliver") as XsDeliverFrame[];
async function ack(r: AliasRig, a: Agent, d: XsDeliverFrame, over: Partial<XsAckFrame> = {}): Promise<void> {
  r.registry.onFrame(a.key, { t: "xs_ack", rid: d.rid, xid: d.xid, effect: "applied", woke: false, ...over });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const SID_A = "0190a1b2-c3d4-7000-8000-00000000000a";
const SID_B = "0190a1b2-c3d4-7000-8000-00000000000b"; // same 12-char ref as A (UUIDv7 window)
const SID_C = "0190c0c0-0000-7000-8000-00000000000c";
const SID_D = "0190d0d0-0000-7000-8000-00000000000d";

/** A holds 前端 (alias cap), B is NAMED 前端, C/D are requesters (C aliasUsable, D no cap). */
async function standard(table: "fresh" | "none" = "fresh") {
  const r = await aliasRig({ table });
  const A = r.agent({ pid: 1, sessionId: SID_A, name: "alpha" });
  const B = r.agent({ pid: 2, sessionId: SID_B, name: "前端" });
  const C = r.agent({ pid: 3, sessionId: SID_C, name: "gamma" });
  const D = r.agent({ pid: 4, sessionId: SID_D, name: "delta", caps: OLD_CAPS });
  if (table === "fresh") await setAlias(r, A, "前端");
  return { r, A, B, C, D };
}

// ----------------------------------------------------------------- config

describe("crossSession.alias config (key-absent convention)", () => {
  it("normalizeHubXsAliasConfig: object ⇒ params (missing leaves default); malformed ⇒ undefined", () => {
    expect(normalizeHubXsAliasConfig({})).toEqual(XS_ALIAS_DEFAULT_PARAMS);
    expect(normalizeHubXsAliasConfig({ offlineLeaseH: 24, coolMin: 5, takeMinOfflineMin: 30 })).toEqual({
      offlineLeaseH: 24,
      coolMin: 5,
      takeMinOfflineMin: 30,
    });
    for (const bad of [
      undefined,
      null,
      true,
      [],
      "x",
      { offlineLeaseH: 0 },
      { offlineLeaseH: 721 },
      { coolMin: 1.5 },
      { takeMinOfflineMin: 9 }, // NQ1 floor
      { takeMinOfflineMin: "10" },
    ]) {
      expect(normalizeHubXsAliasConfig(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("mergeHubXsAliasConfig: raw alias absent ⇒ the SAME normalized object (byte-identical config)", () => {
    const raw = { limits: { hubSendsPerMin: 60 }, reply: true };
    const normalized = normalizeHubCrossSessionConfig(raw)!;
    const out = mergeHubXsAliasConfig(raw, normalized);
    expect(out.merged).toBe(normalized);
    expect(out.aliasDropped).toBe(false);
    expect(JSON.stringify(out.merged)).toBe(JSON.stringify(normalizeHubCrossSessionConfig(raw)));
    expect(hubXsAliasParamsOf(out.merged)).toBeUndefined();
  });

  it("mergeHubXsAliasConfig: valid alias merged back; malformed dropped alone (xs unaffected)", () => {
    const raw = { limits: { hubSendsPerMin: 60 }, alias: { offlineLeaseH: 48, coolMin: 10, takeMinOfflineMin: 10 } };
    const ok = mergeHubXsAliasConfig(raw, normalizeHubCrossSessionConfig(raw)!);
    expect(ok.merged).toEqual({
      limits: { hubSendsPerMin: 60 },
      alias: { offlineLeaseH: 48, coolMin: 10, takeMinOfflineMin: 10 },
    });
    expect(hubXsAliasParamsOf(ok.merged)).toEqual({ offlineLeaseH: 48, coolMin: 10, takeMinOfflineMin: 10 });
    const badRaw = { limits: { hubSendsPerMin: 60 }, alias: { takeMinOfflineMin: 0 } };
    const bad = mergeHubXsAliasConfig(badRaw, normalizeHubCrossSessionConfig(badRaw)!);
    expect(bad.aliasDropped).toBe(true);
    expect(bad.merged).toEqual({ limits: { hubSendsPerMin: 60 } });
  });
});

// ----------------------------------------------------------------- resolve / list

describe("§5.1 resolve: alias tier for aliasUsable requesters only", () => {
  it("C (aliasUsable) reaches the alias holder A; D (no cap) keeps the name tier and reaches B, byte-legacy", async () => {
    const { r, C, D } = await standard();
    const viaAlias = call(r, C, { op: "resolve", query: "前端" });
    expect(viaAlias).toEqual({
      t: "xs_res",
      rid: viaAlias.rid,
      ok: true,
      target: { ref: SID_A.slice(0, 12), alias: "前端", name: "alpha", sessionId: SID_A },
    });
    const legacy = call(r, D, { op: "resolve", query: "前端" });
    expect(legacy).toEqual({
      t: "xs_res",
      rid: legacy.rid,
      ok: true,
      target: { ref: SID_B.slice(0, 12), name: "前端" },
    });
    // the alias tier normalizes (full-width ⇒ canonical) without stripping `@`
    expect(call(r, C, { op: "resolve", query: "前端" }).target?.sessionId).toBe(SID_A);
  });

  it("op alias from a requester without the cap ⇒ BAD_FRAME (no write)", async () => {
    const { r, D } = await standard();
    const res = call(r, D, { op: "alias", alias: "dee" });
    expect(res).toMatchObject({ ok: false, code: "E_XS_BAD_FRAME", effect: "none" });
    expect(r.relay.aliases!.heldBy(SID_D)).toBeUndefined();
  });

  it("an aliasUsable target always carries the full sessionId (even without reply caps)", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, name: "alpha", caps: ["ev.v1", "xs.v1", "xs.alias.v1"] });
    const C = r.agent({ pid: 3, sessionId: SID_C, caps: ["ev.v1", "xs.v1", "xs.alias.v1"] });
    expect(call(r, C, { op: "resolve", query: "alpha" }).target).toEqual({
      ref: SID_A.slice(0, 12),
      name: "alpha",
      sessionId: SID_A,
    });
    void A;
  });

  it("alias tier is decisive: offline / not joined / other channel / self / cooling ⇒ NO_TARGET, never the same-named B", async () => {
    // offline
    {
      const { r, A, C } = await standard();
      r.close(A);
      expect(call(r, C, { op: "resolve", query: "前端" })).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
    }
    // not joined
    {
      const r = await aliasRig({ table: "fresh" });
      const A = r.agent({ pid: 1, sessionId: SID_A, name: "alpha" });
      r.agent({ pid: 2, sessionId: SID_B, name: "前端" });
      const C = r.agent({ pid: 3, sessionId: SID_C });
      await setAlias(r, A, "前端");
      r.registry.onFrame(A.key, memberFrame({ sessionId: SID_A, joined: false }));
      expect(call(r, C, { op: "resolve", query: "前端" })).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
    }
    // other channel
    {
      const r = await aliasRig({ table: "fresh" });
      const A = r.agent({ pid: 1, sessionId: SID_A, channels: ["team"] });
      r.agent({ pid: 2, sessionId: SID_B, name: "前端" });
      const C = r.agent({ pid: 3, sessionId: SID_C });
      await setAlias(r, A, "前端");
      expect(call(r, C, { op: "resolve", query: "前端" })).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
    }
    // self
    {
      const { r, A } = await standard();
      expect(call(r, A, { op: "resolve", query: "前端" })).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
    }
    // cooling (A cleared)
    {
      const { r, A, C } = await standard();
      expect(await callAsync(r, A, { op: "alias", clear: true })).toMatchObject({ ok: true, alias: { state: "none" } });
      expect(call(r, C, { op: "resolve", query: "前端" })).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
      // cooling over (10 min) ⇒ no record ⇒ the name tier again (R1-class, documented)
      r.clock.t += 10 * MIN + 1;
      expect(call(r, C, { op: "resolve", query: "前端" }).target?.ref).toBe(SID_B.slice(0, 12));
    }
  });

  it("no record ⇒ name tiers; sid exact / prefix tiers still run first", async () => {
    const { r, C } = await standard();
    expect(call(r, C, { op: "resolve", query: "Delta" }).target?.ref).toBe(SID_D.slice(0, 12));
    expect(call(r, C, { op: "resolve", query: SID_D.slice(0, 10) }).target?.ref).toBe(SID_D.slice(0, 12));
  });

  it("candidates carry alias only for an aliasUsable requester", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, name: "twin" });
    r.agent({ pid: 2, sessionId: SID_B, name: "twin" });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    const D = r.agent({ pid: 4, sessionId: SID_D, caps: OLD_CAPS });
    await setAlias(r, A, "web");
    const forC = call(r, C, { op: "resolve", query: "twin" }).candidates!;
    expect(forC.find((c) => c.name === "twin" && c.alias === "web")).toBeDefined();
    expect(forC.every((c) => Object.keys(c)[0] === "ref")).toBe(true);
    const forD = call(r, D, { op: "resolve", query: "twin" }).candidates!;
    expect(forD.some((c) => "alias" in c)).toBe(false);
  });
});

describe("§5.3 list: alias rows first + alias prefix query (aliasUsable only)", () => {
  it("C sees alias rows first with alias; D sees the legacy order and no alias key", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, name: "alpha" }); // oldest
    r.agent({ pid: 2, sessionId: SID_B, name: "beta" });
    const C = r.agent({ pid: 3, sessionId: SID_C, name: "gamma" });
    const D = r.agent({ pid: 4, sessionId: SID_D, name: "delta", caps: OLD_CAPS });
    await setAlias(r, A, "前端");
    const rowsC = call(r, C, { op: "list" }).rows!;
    expect(rowsC.map((x) => x.name)).toEqual(["alpha", "delta", "beta"]);
    expect(rowsC[0]).toMatchObject({ ref: SID_A.slice(0, 12), alias: "前端", name: "alpha" });
    expect(Object.keys(rowsC[0]!).slice(0, 3)).toEqual(["ref", "alias", "name"]);
    expect(rowsC.slice(1).some((x) => "alias" in x)).toBe(false);
    const rowsD = call(r, D, { op: "list" }).rows!;
    expect(rowsD.map((x) => x.name)).toEqual(["gamma", "beta", "alpha"]);
    expect(rowsD.some((x) => "alias" in x)).toBe(false);
    // alias prefix query (NFKC + lower-case): C matches A by 前; D does not
    expect(call(r, C, { op: "list", query: "前" }).rows!.map((x) => x.name)).toEqual(["alpha"]);
    expect(call(r, D, { op: "list", query: "前" }).rows).toEqual([]);
    await setAlias(r, A, "web");
    expect(call(r, C, { op: "list", query: "ＷＥ" }).rows!.map((x) => x.name)).toEqual(["alpha"]);
  });
});

// ----------------------------------------------------------------- send exact-only

describe("§5.2 send: aliasUsable plain send is exact-only on the full sessionId", () => {
  it("full sessionId delivers; a name / alias / ref / prefix as `to` is NO_TARGET (no fallback)", async () => {
    const { r, A, C } = await standard();
    const pending: XsResFrame[] = [];
    r.relay.router.handle(C.key, req(C, { op: "send", to: SID_A, text: "hi" }), (x) => pending.push(x));
    const d = delivers(A.conn);
    expect(d.length).toBe(1);
    await ack(r, A, d[0]!);
    expect(pending[0]).toMatchObject({ ok: true, effect: "applied", target: { alias: "前端", sessionId: SID_A } });
    for (const to of ["前端", "alpha", SID_A.slice(0, 12), SID_A.slice(0, 20), ` ${SID_A}`]) {
      expect(call(r, C, { op: "send", to, text: "x" }), to).toMatchObject({
        ok: false,
        code: "E_XS_NO_TARGET",
        effect: "none",
      });
    }
    expect(call(r, C, { op: "send", to: "root", text: "x" })).toMatchObject({ code: "E_XS_NO_TARGET" });
    expect(delivers(A.conn).length).toBe(1);
  });

  it("barrier 1: same-ref UUIDv7 A/B — A resolved, A leaves, B takes the alias — send to A's id ⇒ NO_TARGET", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, name: "alpha" });
    const B = r.agent({ pid: 2, sessionId: SID_B, name: "beta" });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    await setAlias(r, A, "前端");
    const target = call(r, C, { op: "resolve", query: "前端" }).target!;
    expect(target.sessionId).toBe(SID_A);
    expect(SID_A.slice(0, 12)).toBe(SID_B.slice(0, 12));
    r.close(A);
    r.clock.t += 11 * MIN;
    const prev = call(r, B, { op: "alias", alias: "前端", take: "preview" });
    const token = (prev.alias as { take: { token: string } }).take.token;
    expect(await callAsync(r, B, { op: "alias", alias: "前端", take: token })).toMatchObject({ ok: true });
    expect(call(r, C, { op: "send", to: target.sessionId!, text: "x" })).toMatchObject({ code: "E_XS_NO_TARGET" });
    expect(delivers(B.conn).length).toBe(0);
  });

  it("barrier 2: a visible B NAMED A's full sessionId ⇒ NO_TARGET for C (D without the cap keeps legacy)", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A });
    const B = r.agent({ pid: 2, sessionId: SID_B, name: SID_A });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    const D = r.agent({ pid: 4, sessionId: SID_D, caps: OLD_CAPS });
    r.close(A);
    expect(call(r, C, { op: "send", to: SID_A, text: "x" })).toMatchObject({ code: "E_XS_NO_TARGET" });
    expect(delivers(B.conn).length).toBe(0);
    // legacy requester: the name tier still applies (NQ3 — unchanged behaviour)
    r.relay.router.handle(D.key, req(D, { op: "send", to: SID_A, text: "x" }), () => {});
    expect(delivers(B.conn).length).toBe(1);
  });

  it("barrier 3: a custom sessionId prefixed by A's full id ⇒ NO_TARGET", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A });
    const X = r.agent({ pid: 2, sessionId: `${SID_A}-x` });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    r.close(A);
    expect(call(r, C, { op: "send", to: SID_A, text: "x" })).toMatchObject({ code: "E_XS_NO_TARGET" });
    expect(delivers(X.conn).length).toBe(0);
  });

  it("reply-shaped sends keep the legacy exact diagnostics (BAD_FRAME on a name)", async () => {
    const { r, C } = await standard();
    expect(
      call(r, C, {
        op: "send",
        to: "alpha",
        text: "x",
        expect: { requestId: "q0123456789abcdef01", timeoutMs: 600_000 },
      }),
    ).toMatchObject({ code: "E_XS_BAD_FRAME" });
  });
});

// ----------------------------------------------------------------- from.alias

describe("§6 from.alias is stamped per RECIPIENT (send / reply / broadcast)", () => {
  it("send + reply: alias-capable recipient gets from.alias; a no-cap recipient never does", async () => {
    const r = await aliasRig({ table: "fresh" });
    const S = r.agent({ pid: 1, sessionId: SID_A, name: "sender" });
    const T = r.agent({ pid: 2, sessionId: SID_B, name: "t" });
    const L = r.agent({ pid: 3, sessionId: SID_C, name: "legacy", caps: CHANNEL_CAPS });
    await setAlias(r, S, "前端");
    r.relay.router.handle(S.key, req(S, { op: "send", to: SID_B, text: "a" }), () => {});
    expect(delivers(T.conn)[0]!.from).toEqual({
      sessionId: SID_A,
      ref: SID_A.slice(0, 12),
      name: "sender",
      cwdLabel: "~/work",
      agentId: S.key.slice(0, 128),
      alias: "前端",
    });
    await ack(r, T, delivers(T.conn)[0]!);
    r.relay.router.handle(S.key, req(S, { op: "send", to: SID_C, text: "b" }), () => {});
    expect("alias" in delivers(L.conn)[0]!.from).toBe(false);
    await ack(r, L, delivers(L.conn)[0]!);
    r.clock.t += 6_000;
    r.relay.router.handle(
      S.key,
      req(S, { op: "send", to: SID_B, text: "ans", replyTo: "q0123456789abcdef01" }),
      () => {},
    );
    expect(delivers(T.conn)[1]!.from.alias).toBe("前端");
  });

  it("broadcast: per-recipient stamping", async () => {
    const r = await aliasRig({ table: "fresh" });
    const S = r.agent({ pid: 1, sessionId: SID_A, channels: ["team"] });
    const T = r.agent({ pid: 2, sessionId: SID_B, channels: ["team"] });
    const L = r.agent({ pid: 3, sessionId: SID_C, channels: ["team"], caps: CHANNEL_CAPS });
    await setAlias(r, S, "前端");
    r.relay.router.handle(S.key, req(S, { op: "broadcast", channel: "team", text: "all" }), () => {});
    expect(delivers(T.conn)[0]!.from.alias).toBe("前端");
    expect("alias" in delivers(L.conn)[0]!.from).toBe(false);
  });

  it("no alias held ⇒ from carries no alias key (byte-identical stamping)", async () => {
    const r = await aliasRig({ table: "fresh" });
    const S = r.agent({ pid: 1, sessionId: SID_A });
    const T = r.agent({ pid: 2, sessionId: SID_B });
    r.relay.router.handle(S.key, req(S, { op: "send", to: SID_B, text: "a" }), () => {});
    expect(Object.keys(delivers(T.conn)[0]!.from)).toEqual(["sessionId", "ref", "cwdLabel", "agentId"]);
  });
});

// ----------------------------------------------------------------- state × behaviour matrix

describe("§3.3 state × behaviour matrix (A holds 前端, B is named 前端)", () => {
  async function neverB(r: AliasRig, C: Agent, B: Agent): Promise<void> {
    const res = call(r, C, { op: "resolve", query: "前端" });
    expect(res.target?.sessionId).not.toBe(SID_B);
    if (res.target?.sessionId !== undefined) {
      r.relay.router.handle(C.key, req(C, { op: "send", to: res.target.sessionId, text: "x" }), () => {});
    }
    expect(delivers(B.conn).length).toBe(0);
  }

  it("ready → wedged (UNKNOWN) → ready via late rename SUCCESS", async () => {
    const { r, A, B, C } = await standard();
    expect(r.relay.aliases!.status().state).toBe("ready");
    await neverB(r, C, B);
    r.fs.hangRename = true;
    const res = await callAsync(r, A, { op: "alias", alias: "新名" }, 1_000);
    expect(res).toMatchObject({ ok: false, code: "E_XS_ALIAS_UNKNOWN", effect: "unknown" });
    expect(r.relay.aliases!.status().state).toBe("wedged");
    // reads keep the OLD table: 前端 still resolves to A
    expect(call(r, C, { op: "resolve", query: "前端" }).target?.sessionId).toBe(SID_A);
    await neverB(r, C, B);
    expect(await callAsync(r, C, { op: "alias", alias: "gg" })).toMatchObject({ code: "E_XS_ALIAS_BUSY{io}" });
    r.fs.pending!.release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.relay.aliases!.status().state).toBe("ready");
    expect(call(r, C, { op: "resolve", query: "新名" }).target?.sessionId).toBe(SID_A);
    // 前端 is now cooling(A) ⇒ still decisive, still never B
    expect(call(r, C, { op: "resolve", query: "前端" })).toMatchObject({ code: "E_XS_NO_TARGET" });
    await neverB(r, C, B);
  });

  it("ready → wedged → ready via late rename FAILURE (memory unchanged)", async () => {
    const { r, A, B, C } = await standard();
    r.fs.hangRename = true;
    await callAsync(r, A, { op: "alias", alias: "新名" }, 1_000);
    r.fs.pending!.release(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.relay.aliases!.status().state).toBe("ready");
    expect(call(r, C, { op: "resolve", query: "前端" }).target?.sessionId).toBe(SID_A);
    expect(call(r, C, { op: "resolve", query: "新名" })).toMatchObject({ code: "E_XS_NO_TARGET" });
    await neverB(r, C, B);
  });

  it("wedged → disabled (>60 s): alias tier unchanged, writes busy, cap/aliasUsable unchanged", async () => {
    const { r, A, B, C, D } = await standard();
    r.fs.hangRename = true;
    await callAsync(r, A, { op: "alias", alias: "新名" }, 1_000);
    r.clock.t += 61_000;
    expect(await callAsync(r, C, { op: "alias", alias: "gg" })).toMatchObject({ code: "E_XS_ALIAS_BUSY{io}" });
    expect(r.relay.aliases!.status().state).toBe("disabled");
    expect(r.relay.aliases!.advertised).toBe(true);
    expect(call(r, C, { op: "resolve", query: "前端" }).target?.sessionId).toBe(SID_A);
    await neverB(r, C, B);
    expect(call(r, C, { op: "alias" })).toMatchObject({ ok: true, alias: { state: "none" } }); // get still reads
    // the no-cap requester is legacy in every state
    expect(call(r, D, { op: "resolve", query: "前端" }).target?.ref).toBe(SID_B.slice(0, 12));
  });
});

// ----------------------------------------------------------------- degraded / key absent

describe("§5.1 degraded guard and the key-absent hub", () => {
  it("degraded: alias-shaped ⇒ UNAVAILABLE for alias-capable; refs + non-alias-shaped names work; no-cap legacy; file untouched", async () => {
    const r = await aliasRig({ table: "corrupt" });
    const before = r.fs.text();
    r.agent({ pid: 1, sessionId: SID_A, name: "a b" });
    r.agent({ pid: 2, sessionId: SID_B, name: "前端" });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    const D = r.agent({ pid: 4, sessionId: SID_D, caps: OLD_CAPS });
    expect(r.relay.aliases!.advertised).toBe(false);
    expect(r.relay.aliases!.status().state).toBe("degraded");
    expect(call(r, C, { op: "resolve", query: "前端" })).toMatchObject({
      ok: false,
      code: "E_XS_ALIAS_UNAVAILABLE",
      effect: "none",
    });
    expect(call(r, C, { op: "send", to: "前端", text: "x" })).toMatchObject({ code: "E_XS_ALIAS_UNAVAILABLE" });
    expect(call(r, C, { op: "resolve", query: SID_B }).target?.ref).toBe(SID_B.slice(0, 12));
    expect(call(r, C, { op: "resolve", query: SID_D.slice(0, 10) }).target?.ref).toBe(SID_D.slice(0, 12));
    expect(call(r, C, { op: "resolve", query: "a b" }).target?.ref).toBe(SID_A.slice(0, 12));
    // degraded ⇒ not aliasUsable ⇒ no sessionId pinning; target shape is legacy
    expect(call(r, C, { op: "alias" })).toMatchObject({ ok: false, code: "E_XS_BAD_FRAME" });
    expect(call(r, D, { op: "resolve", query: "前端" }).target).toEqual({ ref: SID_B.slice(0, 12), name: "前端" });
    expect(r.fs.text()).toBe(before);
  });

  it("key absent (no table): an alias-capable requester gets NO guard and op alias ⇒ BAD_FRAME", async () => {
    const r = await aliasRig({ table: "none" });
    r.agent({ pid: 2, sessionId: SID_B, name: "前端" });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    expect(r.relay.aliases).toBeUndefined();
    expect(call(r, C, { op: "resolve", query: "前端" }).target?.ref).toBe(SID_B.slice(0, 12));
    expect(call(r, C, { op: "alias", alias: "x" })).toMatchObject({ ok: false, code: "E_XS_BAD_FRAME" });
    expect(r.fs.files.size).toBe(0);
  });
});

// ----------------------------------------------------------------- op alias

describe("§3.4/§3.5 op:alias through the router", () => {
  it("get / set / clear / lost: state wire passes through", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A });
    expect(call(r, A, { op: "alias" })).toMatchObject({ ok: true, alias: { state: "none" } });
    expect(await callAsync(r, A, { op: "alias", alias: "@ＷＥＢ" })).toMatchObject({
      ok: true,
      alias: { alias: "web", state: "held" },
    });
    expect(call(r, A, { op: "alias" })).toMatchObject({ ok: true, alias: { alias: "web", state: "held" } });
    expect(await callAsync(r, A, { op: "alias", alias: "x y" })).toMatchObject({
      ok: false,
      code: "E_XS_ALIAS_INVALID{invalid}",
      effect: "none",
    });
    expect(await callAsync(r, A, { op: "alias", clear: true })).toMatchObject({ ok: true, alias: { state: "none" } });
    expect(r.fs.text()).toContain('"web"');
  });

  it("taken / confusable never echo the existing alias", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    await setAlias(r, A, "web0");
    const t = await callAsync(r, C, { op: "alias", alias: "web0" });
    expect(t).toEqual({ t: "xs_res", rid: t!.rid, ok: false, code: "E_XS_ALIAS_TAKEN{taken}", effect: "none" });
    const c = await callAsync(r, C, { op: "alias", alias: "webo" });
    expect(c).toEqual({ t: "xs_res", rid: c!.rid, ok: false, code: "E_XS_ALIAS_TAKEN{confusable}", effect: "none" });
  });

  it("malformed sub-op shapes ⇒ BAD_FRAME before the store", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A });
    for (const over of [
      { clear: true as const, alias: "web" },
      { take: "preview" },
      { alias: "web", take: "nottoken" },
      { alias: "web", clear: true as const, take: "preview" },
    ]) {
      expect(call(r, A, { op: "alias", ...over }), JSON.stringify(over)).toMatchObject({ code: "E_XS_BAD_FRAME" });
    }
    expect(r.fs.files.size).toBe(0);
  });

  it("presence feed: the holder's disconnect stamps offlineSince — take preview is recent before 10 min, ok after", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    await setAlias(r, A, "前端");
    expect(call(r, C, { op: "alias", alias: "前端", take: "preview" })).toMatchObject({
      code: "E_XS_ALIAS_TAKE{online}",
    });
    r.close(A); // presence feed: onInvalidate ⇒ touchPresence(SID_A) stamps offlineSince NOW
    r.clock.t += 9 * MIN;
    expect(call(r, C, { op: "alias", alias: "前端", take: "preview" })).toMatchObject({
      code: "E_XS_ALIAS_TAKE{recent}",
    });
    r.clock.t += MIN; // 10 min since the DISCONNECT (no read stamped it later)
    const prev = call(r, C, { op: "alias", alias: "前端", take: "preview" });
    expect(prev).toMatchObject({ ok: true, alias: { take: { cwdLabel: "~/work", offlineForS: 600 } } });
    const token = (prev.alias as { take: { token: string } }).take.token;
    expect(await callAsync(r, C, { op: "alias", alias: "前端", take: token })).toMatchObject({
      ok: true,
      alias: { alias: "前端", state: "held" },
    });
    // token consumed by any outcome
    expect(await callAsync(r, C, { op: "alias", alias: "前端", take: token })).toMatchObject({
      code: "E_XS_ALIAS_TAKE{stale}",
    });
    // A comes back: get reports lost{taken}
    const A2 = r.agent({ pid: 11, sessionId: SID_A });
    expect(call(r, A2, { op: "alias" })).toMatchObject({
      ok: true,
      alias: { state: "none", lost: { alias: "前端", reason: "taken" } },
    });
  });

  it("presence feed: a session switch takes the old sid offline at the switch time", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    await setAlias(r, A, "前端");
    r.registry.onFrame(A.key, session({ sessionId: SID_B, cwd: "/home/u/work" }));
    r.clock.t += 10 * MIN;
    expect(call(r, C, { op: "alias", alias: "前端", take: "preview" })).toMatchObject({ ok: true });
  });

  it("get and preview count against listPerMin", async () => {
    const r = await aliasRig({ table: "fresh" });
    const conn = fakeConn();
    const { agentKey } = r.registry.register(
      hello({ agentId: { pid: 9, nonce: "nonce000000000000009" }, caps: ALIAS_CAPS, cwd: "/home/u" }),
      conn,
    );
    r.registry.onFrame(agentKey, session({ sessionId: SID_D, cwd: "/home/u" }));
    r.registry.onFrame(agentKey, memberFrame({ sessionId: SID_D, limits: { ...LIMITS, listPerMin: 2 } }));
    const X: Agent = { key: agentKey, conn, sessionId: SID_D };
    expect(call(r, X, { op: "alias" }).ok).toBe(true);
    expect(call(r, X, { op: "alias", alias: "zz", take: "preview" })).toMatchObject({
      code: "E_XS_ALIAS_TAKE{not_held}",
    });
    expect(call(r, X, { op: "alias" })).toMatchObject({ ok: false, code: "E_XS_RATE_LIMITED" });
  });

  it("audit lines carry the sub-op and code only — never alias text, token or cwd", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, cwd: "/home/u/secret-proj" });
    const C = r.agent({ pid: 3, sessionId: SID_C });
    await setAlias(r, A, "前端");
    r.close(A);
    r.clock.t += 11 * MIN;
    const prev = call(r, C, { op: "alias", alias: "前端", take: "preview" });
    const token = (prev.alias as { take: { token: string } }).take.token;
    await callAsync(r, C, { op: "alias", alias: "前端", take: token });
    const lines = r.log.lines.filter((l) => l.msg === "xs" && (l.data as { op?: string }).op === "alias");
    expect(lines.map((l) => (l.data as { reason?: string }).reason)).toEqual(["set", "preview", "take"]);
    const text = JSON.stringify(r.log.lines.filter((l) => l.msg.startsWith("xs")));
    expect(text).not.toContain("前端");
    expect(text).not.toContain(token);
    expect(text).not.toContain("secret-proj");
  });
});
