/**
 * #72 AF2 (alias-force-default plan §3.2/§4/§9): hub routing of the alias v2 intents.
 *
 * - `intent` dispatch (auto / force preview / execute) and every illegal combination ⇒ E_XS_BAD_FRAME;
 *   a requester without `xs.alias.v2` can never use `intent`, and its replies never carry the new keys
 * - auto requires `joined`; force respects `notifiable` (non-v2 member / linked ⇒ unnotifiable)
 * - a committed force pushes `xs_alias_evt` to EVERY v2 effective member of the holder session only
 * - pin barrier (§2): a send resolved before the force still reaches the old holder; afterwards ⇒ NO_TARGET
 *   once the old holder is gone, never the new holder
 * - audit `reason` carries the new sub-ops and never alias text / token / cwd
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { createXsAliasBinding, createXsRelay, type XsRelay } from "../../../src/web-hub/hub/xs/router.js";
import {
  XS_ALIAS_DEFAULT_PARAMS,
  XS_ALIAS_FILE,
  type XsAliasFs,
  type XsAliasTimer,
} from "../../../src/web-hub/hub/xs/aliases.js";
import type { XsAckFrame, XsDeliverFrame, XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { fakeConn, hello, memLog, type FakeConn, type MemLog } from "./helpers.js";
import { BCAST_LIMITS, CHANNEL_CAPS, LIMITS, memberFrame, session } from "./xs-fixtures.js";

const MIN = 60_000;
const STATE = "/state";
const FILE = `${STATE}/${XS_ALIAS_FILE}`;
const ALIAS_CAPS = [...CHANNEL_CAPS, "xs.alias.v1"]; // v1 only: an alias-capable agent from before #72
const V2_CAPS = [...ALIAS_CAPS, "xs.alias.v2"];
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

const aliasOf = (res: XsResFrame | undefined): Record<string, unknown> => (res?.alias ?? {}) as Record<string, unknown>;
const evts = (conn: { sent: unknown[] }): { t: string; sessionId: string; at: number }[] =>
  conn.sent.filter((x) => (x as { t?: string }).t === "xs_alias_evt") as never;
async function forceTake(r: AliasRig, who: Agent, alias: string): Promise<XsResFrame | undefined> {
  const prev = call(r, who, { op: "alias", alias, take: "preview", intent: "force" });
  expect(prev, JSON.stringify(prev)).toMatchObject({ ok: true });
  const token = (prev.alias as { take: { token: string } }).take.token;
  return callAsync(r, who, { op: "alias", alias, take: token });
}

describe("intent dispatch and shape validation", () => {
  it("auto: a v2 joined requester gets the record with origin:auto; the cwdLabel is its own ~ cwd", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS, cwd: "/home/u/proj" });
    const res = await callAsync(r, A, { op: "alias", alias: "proj", intent: "auto" });
    expect(res).toMatchObject({ ok: true, alias: { alias: "proj", state: "held", origin: "auto" } });
    expect(call(r, A, { op: "alias" })).toMatchObject({ ok: true, alias: { alias: "proj", origin: "auto" } });
    const C = r.agent({ pid: 3, sessionId: SID_C, caps: V2_CAPS });
    const taken = await callAsync(r, C, { op: "alias", alias: "proj", intent: "auto" });
    expect(taken).toEqual({ t: "xs_res", rid: taken!.rid, ok: false, code: "E_XS_ALIAS_TAKEN{taken}", effect: "none" });
  });

  it("auto needs `joined` (BAD_FRAME, nothing written)", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS, joined: false });
    expect(call(r, A, { op: "alias", alias: "proj", intent: "auto" })).toMatchObject({ code: "E_XS_BAD_FRAME" });
    expect(r.fs.files.size).toBe(0);
  });

  it("every illegal combination ⇒ BAD_FRAME before the store", async () => {
    const r = await aliasRig({ table: "fresh" });
    const A = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS });
    const PREV = "0190a1b2-c3d4-7000-8000-0000000000ff";
    for (const over of [
      { intent: "auto" as const }, // no alias
      { alias: "web", intent: "auto" as const, take: "preview" },
      { alias: "web", intent: "auto" as const, take: "k0123456789abcdef" },
      { alias: "web", intent: "auto" as const, prevSessionId: PREV },
      { alias: "web", intent: "force" as const }, // force needs a take
      { intent: "force" as const, take: "preview" },
      { alias: "web", intent: "force" as const, clear: true as const },
      { clear: true as const, intent: "auto" as const },
      { alias: "web", prevSessionId: PREV }, // prevSessionId without handoff
      { alias: "web", intent: "handoff" as const, prevSessionId: PREV }, // AF7 — not implemented ⇒ unknown shape
      { alias: "web", intent: "handoff" as const },
    ]) {
      expect(call(r, A, { op: "alias", ...over }), JSON.stringify(over)).toMatchObject({ code: "E_XS_BAD_FRAME" });
    }
    expect(r.fs.files.size).toBe(0);
  });

  it("a requester WITHOUT xs.alias.v2 can never use intent / prevSessionId, and keeps v1 replies", async () => {
    const r = await aliasRig({ table: "fresh" });
    const OLD = r.agent({ pid: 1, sessionId: SID_A, caps: ALIAS_CAPS, cwd: "/home/u/old" });
    for (const over of [
      { alias: "old", intent: "auto" as const },
      { alias: "old", intent: "force" as const, take: "preview" },
      { alias: "old", intent: "handoff" as const, prevSessionId: SID_B },
      { alias: "old", prevSessionId: SID_B },
    ]) {
      expect(call(r, OLD, { op: "alias", ...over }), JSON.stringify(over)).toMatchObject({ code: "E_XS_BAD_FRAME" });
    }
    expect(r.fs.files.size).toBe(0);
    // a v1 set/get/take reply of an auto-held record never shows `origin`
    const V = r.agent({ pid: 2, sessionId: SID_B, caps: V2_CAPS, cwd: "/home/u/new" });
    await callAsync(r, V, { op: "alias", alias: "newauto", intent: "auto" });
    r.close(V);
    r.clock.t += 11 * MIN;
    expect(r.registry.list().length).toBeGreaterThan(0);
    const prev = call(r, OLD, { op: "alias", alias: "newauto", take: "preview" });
    expect(Object.keys((prev.alias as { take: object }).take).sort()).toEqual([
      "cwdLabel",
      "expiresAt",
      "offlineForS",
      "token",
    ]);
  });

  it("v2 gating is per requester: with the table advertised, aliasUsable-but-not-v2 is exactly the old behaviour", async () => {
    const r = await aliasRig({ table: "fresh" });
    const OLD = r.agent({ pid: 1, sessionId: SID_A, caps: ALIAS_CAPS });
    expect(await callAsync(r, OLD, { op: "alias", alias: "plain" })).toMatchObject({
      ok: true,
      alias: { alias: "plain", state: "held" },
    });
    expect(aliasOf(call(r, OLD, { op: "alias" }))).toEqual({ alias: "plain", state: "held" });
  });
});

describe("force: preview, notifiability, execute, evt push", () => {
  it("online v2 holder: preview carries online/auto, execution transfers and pushes ONE xs_alias_evt to the holder only", async () => {
    const r = await aliasRig({ table: "fresh" });
    const H = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS, cwd: "/home/u/fe" });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    const other = r.agent({ pid: 3, sessionId: SID_D, caps: V2_CAPS });
    await callAsync(r, H, { op: "alias", alias: "front", intent: "auto" });
    const prev = call(r, S, { op: "alias", alias: "front", take: "preview", intent: "force" });
    expect(prev.alias).toMatchObject({
      take: {
        cwdLabel: "~/fe",
        offlineForS: 0,
        online: true,
        auto: true,
      },
    });
    const token = (prev.alias as { take: { token: string } }).take.token;
    const res = await callAsync(r, S, { op: "alias", alias: "front", take: token });
    expect(res).toMatchObject({ ok: true, alias: { alias: "front", state: "held" } });
    expect(aliasOf(res)["origin"]).toBeUndefined();
    const pushed = evts(H.conn);
    expect(pushed).toEqual([{ t: "xs_alias_evt", sessionId: SID_A, at: expect.any(Number) }]);
    expect(evts(S.conn)).toEqual([]);
    expect(evts(other.conn)).toEqual([]);
    expect(JSON.stringify(pushed)).not.toContain("front"); // a nudge, never the alias text
    // H reconciles with get: lost.forced
    expect(call(r, H, { op: "alias" })).toMatchObject({
      ok: true,
      alias: { state: "none", lost: { alias: "front", reason: "taken", forced: true } },
    });
  });

  it("execution frame with intent:force is accepted and ignored; intent never decides the mode", async () => {
    const r = await aliasRig({ table: "fresh" });
    const H = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    await callAsync(r, H, { op: "alias", alias: "front" });
    const prev = call(r, S, { op: "alias", alias: "front", take: "preview" }); // plain take preview, holder online
    expect(prev).toMatchObject({ ok: false, code: "E_XS_ALIAS_TAKE{online}" });
    const fp = call(r, S, { op: "alias", alias: "front", take: "preview", intent: "force" });
    const token = (fp.alias as { take: { token: string } }).take.token;
    expect(await callAsync(r, S, { op: "alias", alias: "front", take: token, intent: "force" })).toMatchObject({
      ok: true,
    });
    expect(evts(H.conn)).toHaveLength(1);
  });

  it("holder with a non-v2 member, or only linked (xs off, still connected) ⇒ unnotifiable; no push, no write", async () => {
    const r = await aliasRig({ table: "fresh" });
    const OLD = r.agent({ pid: 1, sessionId: SID_A, caps: ALIAS_CAPS });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    await callAsync(r, OLD, { op: "alias", alias: "front" });
    expect(call(r, S, { op: "alias", alias: "front", take: "preview", intent: "force" })).toMatchObject({
      ok: false,
      code: "E_XS_ALIAS_TAKE{unnotifiable}",
      effect: "none",
    });
    // a v2 holder that is merely connected: the member frame is dropped by `joined`-less xs? — emulate by an agent with
    // NO xs.v1 cap at all (so it is never an effective member) but the same sessionId
    const V = r.agent({ pid: 4, sessionId: SID_D, caps: V2_CAPS });
    await callAsync(r, V, { op: "alias", alias: "vee" });
    r.close(V);
    const linkedConn = fakeConn();
    const { agentKey } = r.registry.register(
      hello({ agentId: { pid: 9, nonce: "nonce000000000000009" }, caps: ["ev.v1"], cwd: "/home/u/x" }),
      linkedConn,
    );
    r.registry.onFrame(agentKey, session({ sessionId: SID_D, cwd: "/home/u/x" }));
    expect(call(r, S, { op: "alias", alias: "vee", take: "preview", intent: "force" })).toMatchObject({
      code: "E_XS_ALIAS_TAKE{unnotifiable}",
    });
    expect(evts(linkedConn)).toEqual([]);
  });

  it("isLinked follows the registry: a record with the sid counts only while connected ∧ not stale; a different sid never does", async () => {
    const r = await aliasRig({ table: "fresh" });
    const V = r.agent({ pid: 4, sessionId: SID_D, caps: V2_CAPS });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    await callAsync(r, V, { op: "alias", alias: "vee" });
    r.close(V);
    const connect = (pid: number, sid: string) => {
      const { agentKey } = r.registry.register(
        hello({ agentId: { pid, nonce: `nonce${String(pid).padStart(15, "0")}` }, caps: ["ev.v1"], cwd: "/home/u/x" }),
        fakeConn(),
      );
      r.registry.onFrame(agentKey, session({ sessionId: sid, cwd: "/home/u/x" }));
      return agentKey;
    };
    const other = connect(8, SID_B); // another session: irrelevant
    expect(call(r, S, { op: "alias", alias: "vee", take: "preview", intent: "force" })).toMatchObject({ ok: true });
    const linkedKey = connect(9, SID_D);
    expect(call(r, S, { op: "alias", alias: "vee", take: "preview", intent: "force" })).toMatchObject({
      code: "E_XS_ALIAS_TAKE{unnotifiable}",
    });
    r.registry.onClose(linkedKey, false); // socket gone ⇒ no longer connected
    expect(call(r, S, { op: "alias", alias: "vee", take: "preview", intent: "force" })).toMatchObject({ ok: true });
    void other;
  });

  it("push reaches every v2 effective member of the holder session; a non-effective socket gets nothing", async () => {
    const r = await aliasRig({ table: "fresh" });
    const H1 = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS });
    const H2 = r.agent({ pid: 5, sessionId: SID_A, caps: V2_CAPS }); // the same session opened twice
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    await callAsync(r, H1, { op: "alias", alias: "front" });
    expect((await forceTake(r, S, "front"))?.ok).toBe(true);
    expect(evts(H1.conn)).toHaveLength(1);
    expect(evts(H2.conn)).toHaveLength(1);
  });

  it("a just-offline holder can be force-taken (no push target), plain take is still 'recent'", async () => {
    const r = await aliasRig({ table: "fresh" });
    const H = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    await callAsync(r, H, { op: "alias", alias: "front" });
    r.close(H);
    r.clock.t += 3 * MIN;
    expect(call(r, S, { op: "alias", alias: "front", take: "preview" })).toMatchObject({
      code: "E_XS_ALIAS_TAKE{recent}",
    });
    expect((await forceTake(r, S, "front"))?.ok).toBe(true);
    expect(evts(H.conn)).toEqual([]);
  });

  it("force preview counts against listPerMin like get / preview", async () => {
    const r = await aliasRig({ table: "fresh" });
    const H = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    await callAsync(r, H, { op: "alias", alias: "front" });
    let limited = 0;
    for (let i = 0; i < 700; i++) {
      const res = call(r, S, { op: "alias", alias: "front", take: "preview", intent: "force" });
      if (res.code === "E_XS_RATE_LIMITED") limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("pin barrier (§2): resolved-before-force still delivers to the old holder; once it is gone ⇒ NO_TARGET, never the new holder", async () => {
    const r = await aliasRig({ table: "fresh" });
    const H = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS, name: "alpha" });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS, name: "gamma" });
    const B = r.agent({ pid: 3, sessionId: SID_B, caps: V2_CAPS, name: "beta" });
    await callAsync(r, H, { op: "alias", alias: "front" });
    const resolved = call(r, B, { op: "resolve", to: "front" });
    expect(resolved).toMatchObject({ ok: true, target: { sessionId: SID_A } });
    expect((await forceTake(r, S, "front"))?.ok).toBe(true);
    // pinned send to the resolved full sessionId
    const out: XsResFrame[] = [];
    r.relay.router.handle(B.key, req(B, { op: "send", to: SID_A, text: "hi" }), (x) => out.push(x));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivers(H.conn)).toHaveLength(1);
    expect(delivers(S.conn)).toHaveLength(0);
    await ack(r, H, delivers(H.conn)[0]!);
    // the old holder leaves: the same pinned send is NO_TARGET and still never reaches S
    r.close(H);
    const out2: XsResFrame[] = [];
    r.relay.router.handle(B.key, req(B, { op: "send", to: SID_A, text: "again" }), (x) => out2.push(x));
    await vi.advanceTimersByTimeAsync(0);
    expect(out2[0]).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
    expect(delivers(S.conn)).toHaveLength(0);
    // a NEW resolve of the alias now reaches S
    expect(call(r, B, { op: "resolve", to: "front" })).toMatchObject({ ok: true, target: { sessionId: SID_C } });
  });

  it("audit: auto / force-preview / take are logged by sub-op only — no alias text, token or cwd", async () => {
    const r = await aliasRig({ table: "fresh" });
    const H = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS, cwd: "/home/u/secret-proj" });
    const S = r.agent({ pid: 2, sessionId: SID_C, caps: V2_CAPS });
    await callAsync(r, H, { op: "alias", alias: "前端", intent: "auto" });
    const prev = call(r, S, { op: "alias", alias: "前端", take: "preview", intent: "force" });
    const token = (prev.alias as { take: { token: string } }).take.token;
    await callAsync(r, S, { op: "alias", alias: "前端", take: token });
    const lines = r.log.lines.filter((l) => l.msg === "xs" && (l.data as { op?: string }).op === "alias");
    expect(lines.slice(0, 3).map((l) => (l.data as { reason?: string }).reason)).toEqual([
      "auto",
      "force-preview",
      "take",
    ]);
    const text = JSON.stringify(r.log.lines.filter((l) => l.msg.startsWith("xs")));
    expect(text).not.toContain("前端");
    expect(text).not.toContain(token);
    expect(text).not.toContain("secret-proj");
    expect(text).not.toContain(SID_B);
  });
});

describe("members: aliasV2Capable", () => {
  it("reflects hello caps ∋ xs.alias.v2 and is independent of v1", async () => {
    const r = await aliasRig({ table: "fresh" });
    const V = r.agent({ pid: 1, sessionId: SID_A, caps: V2_CAPS });
    const O = r.agent({ pid: 2, sessionId: SID_C, caps: ALIAS_CAPS });
    const N = r.agent({ pid: 3, sessionId: SID_D, caps: OLD_CAPS });
    const by = (a: Agent) => r.relay.members.effective(a.key)!;
    expect([by(V), by(O), by(N)].map((m) => [m.aliasCapable, m.aliasV2Capable])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
  });
});
