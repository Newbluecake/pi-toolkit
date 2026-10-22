import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { createXsAliasBinding, createXsRelay as createCurrentRelay } from "../../../src/web-hub/hub/xs/router.js";
import { XS_ALIAS_DEFAULT_PARAMS, XS_ALIAS_FILE, type XsAliasFs } from "../../../src/web-hub/hub/xs/aliases.js";
import { aliasSkeleton } from "../../../src/web-hub/protocol/xs-alias.js";
import type { AgentFrame, HubFrame } from "../../../src/web-hub/protocol/messages.js";
import type { XsMemberLimitsWire } from "../../../src/web-hub/protocol/xs.js";
// The FROZEN v0.7.1 hub-side sources (tests/fixtures/legacy-xs-v071, never modified). Only their
// own frozen `XS_*_FRAME_SCHEMAS` serve as the "old" decoder — the current messages.ts is not used.
import { createXsRelay as createLegacyRelay } from "../../fixtures/legacy-xs-v071/src/web-hub/hub/xs/router.js";
import {
  XS_AGENT_FRAME_SCHEMAS as LEGACY_AGENT_SCHEMAS,
  XS_HUB_FRAME_SCHEMAS as LEGACY_HUB_SCHEMAS,
} from "../../fixtures/legacy-xs-v071/src/web-hub/protocol/xs.js";
import { fakeConn, hello, memLog, type FakeConn, type MemLog } from "./helpers.js";

/**
 * Channel-plan §9.4-3 (CH1): hub-side differential anchor. The frozen v0.7.1 router and the
 * current router run on the SAME member table (every member default-only, `xs.channel.v1`
 * mixed in), the same fixed `now` and the same request/ack script; the produced `xs_res` /
 * `xs_deliver` frames (and audit lines) must be byte-equal after normalization (xid only — values
 * replaced, no key removed or reordered, so an extra `via` / `channels` key would show).
 *
 * Equivalence surface EXCLUDES NQ2 (user-ruled tightening: an `unknown` ack no longer refunds
 * the wake reservation) — the main script therefore never answers a wake send with
 * `unknown ∧ woke:false`; a directed test below pins that this is the ONLY difference.
 * A not-joined requester is also outside the surface (it is not default-only; §4.1 closes its
 * discovery on purpose — pinned in xs-router.test.ts).
 */

const FIXED_NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const OLD_CAPS = ["ev.v1", "xs.v1"];
const OLD_REPLY_CAPS = ["ev.v1", "xs.v1", "xs.reply.v1"];
const NEW_CAPS = ["ev.v1", "xs.v1", "xs.reply.v1", "xs.channel.v1"];
const NEW_NO_REPLY_CAPS = ["ev.v1", "xs.v1", "xs.channel.v1"];

const LIMITS: XsMemberLimitsWire = {
  sendsOutPerMin: 30,
  sendsOutPerHour: 600,
  wakesOutPerHour: 3,
  pairMinIntervalMs: 5_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 60,
};

interface MemberSpec {
  id: string;
  pid: number;
  sessionId: string;
  name?: string;
  cwd: string;
  caps: string[];
  receive?: "off" | "deliver" | "wake" | "replies";
  joined?: boolean;
}

/** Default-only table, channel capability mixed. */
const TABLE: MemberSpec[] = [
  { id: "A", pid: 1, sessionId: "sess-ALPHA-0001", name: "alpha", cwd: "/home/u/proj", caps: NEW_CAPS },
  { id: "B", pid: 2, sessionId: "sess-BETA-00002", name: "beta", cwd: "/home/u/proj/sub", caps: OLD_REPLY_CAPS },
  { id: "C", pid: 3, sessionId: "sess-GAMMA-0003", name: "Beta", cwd: "/elsewhere", caps: NEW_NO_REPLY_CAPS },
  { id: "D", pid: 4, sessionId: "sess-DELTA-0004", name: "delta", cwd: "/home/u", caps: OLD_CAPS, receive: "deliver" },
  { id: "E", pid: 5, sessionId: "sess-EPSIL-0005", name: "eps", cwd: "/home/u/proj", caps: NEW_CAPS, receive: "off" },
  { id: "F", pid: 6, sessionId: "sess-PHI00-0006", name: "phi", cwd: "/home/u/x", caps: NEW_CAPS, receive: "replies" },
  { id: "G1", pid: 7, sessionId: "sess-DUPLI-0007", name: "dup", cwd: "/tmp/a", caps: NEW_CAPS },
  { id: "G2", pid: 8, sessionId: "sess-DUPLI-0007", name: "dup", cwd: "/tmp/b", caps: OLD_CAPS },
  { id: "H", pid: 9, sessionId: "sess-ALPHA-0009", name: "alpha2", cwd: "/home/u/proj", caps: OLD_REPLY_CAPS },
  { id: "I", pid: 10, sessionId: "sess-IDLE0-0010", name: "idle", cwd: "/home/u", caps: NEW_CAPS, joined: false },
];

interface Side {
  registry: Registry;
  router: {
    handle(k: string, f: unknown, reply: (r: unknown) => void): void;
    rejectTooLarge(k: string, raw: unknown, reply: (r: unknown) => void): void;
  };
  dispose(): void;
  log: MemLog;
  clock: { t: number };
  agents: Map<string, { key: string; conn: FakeConn }>;
  transcript: unknown[];
}

type RelayFactory = (deps: {
  registry: Registry;
  config: { home: string; crossSession: { limits: { hubSendsPerMin: number } } };
  log: MemLog;
  now: () => number;
}) => { router: Side["router"]; dispose(): void };

/** The thin decoder: v0.7.1's frozen schemas (an old peer/hub would silently drop anything else). */
function legacyAccepts(frame: { t: string }, table: Readonly<Record<string, unknown>>): boolean {
  const schema = table[frame.t];
  return schema !== undefined && Value.Check(schema as never, frame);
}

function build(factory: RelayFactory, legacy: boolean, capsOf?: (m: MemberSpec) => string[]): Side {
  const clock = { t: FIXED_NOW };
  const log = memLog();
  const registry = createRegistry({ now: () => clock.t, log, pidAlive: () => true });
  const relay = factory({
    registry,
    config: { home: "/home/u", crossSession: { limits: { hubSendsPerMin: 600 } } },
    log,
    now: () => clock.t,
  });
  const agents = new Map<string, { key: string; conn: FakeConn }>();
  const transcript: unknown[] = [];
  for (const m of TABLE) {
    const conn = fakeConn();
    const send = conn.send;
    conn.send = (f: HubFrame) => {
      send(f);
      if ((f as { t: string }).t === "xs_deliver") {
        // what reaches the agent must be decodable by the v0.7.1 agent-side schema, on BOTH sides
        expect(legacyAccepts(f as { t: string }, LEGACY_HUB_SCHEMAS)).toBe(true);
        transcript.push({ to: m.id, frame: f });
      }
    };
    const { agentKey } = registry.register(
      hello({
        agentId: { pid: m.pid, nonce: `nonce${String(m.pid).padStart(15, "0")}` },
        caps: capsOf?.(m) ?? m.caps,
        cwd: m.cwd,
      }),
      conn,
    );
    registry.onFrame(agentKey, {
      t: "session",
      sessionId: m.sessionId,
      cwd: m.cwd,
      reason: "startup",
      leafId: "L1",
      mode: "tui",
      ...(m.name === undefined ? {} : { name: m.name }),
    } as AgentFrame);
    const member = {
      t: "xs_member" as const,
      sessionId: m.sessionId,
      epoch: 1,
      joined: m.joined ?? true,
      receive: m.receive ?? "wake",
      limits: { ...LIMITS },
    };
    if (legacy) expect(legacyAccepts(member, LEGACY_AGENT_SCHEMAS)).toBe(true);
    registry.onFrame(agentKey, member as AgentFrame);
    clock.t += 1; // distinct activityAt ⇒ deterministic ordering
    agents.set(m.id, { key: agentKey, conn });
  }
  return { registry, router: relay.router, dispose: () => relay.dispose(), log, clock, agents, transcript };
}

type Step =
  | { req: string; frame: Record<string, unknown> }
  | { ack: string; over?: Record<string, unknown> }
  | { advance: number }
  | { tooLarge: string; raw: unknown };

let rid = 0;
async function run(side: Side, script: Step[], decodeWith?: Readonly<Record<string, unknown>>): Promise<string> {
  for (const step of script) {
    if ("req" in step) {
      const who = side.agents.get(step.req)!;
      const spec = TABLE.find((m) => m.id === step.req)!;
      const frame = { t: "xs_req", rid: `q${++rid}`, origin: { sessionId: spec.sessionId, epoch: 1 }, ...step.frame };
      if (decodeWith !== undefined && !legacyAccepts(frame, decodeWith)) {
        side.transcript.push({ from: step.req, dropped: true });
        continue;
      }
      side.router.handle(who.key, frame, (res) => side.transcript.push({ from: step.req, res }));
      await vi.advanceTimersByTimeAsync(0);
    } else if ("ack" in step) {
      const who = side.agents.get(step.ack)!;
      const d = [...who.conn.sent].reverse().find((f) => (f as { t: string }).t === "xs_deliver") as
        { rid: string; xid: string } | undefined;
      if (d === undefined) {
        side.transcript.push({ ack: step.ack, noDeliver: true }); // e.g. a refused reply (no reply cap)
        continue;
      }
      side.registry.onFrame(who.key, {
        t: "xs_ack",
        rid: d.rid,
        xid: d.xid,
        effect: "applied",
        woke: false,
        ...step.over,
      } as AgentFrame);
      await vi.advanceTimersByTimeAsync(0);
    } else if ("advance" in step) {
      side.clock.t += step.advance;
      await vi.advanceTimersByTimeAsync(step.advance);
    } else {
      const who = side.agents.get(step.tooLarge)!;
      side.router.rejectTooLarge(who.key, step.raw, (res) => side.transcript.push({ from: step.tooLarge, res }));
    }
  }
  side.transcript.push({ audit: side.log.lines.filter((l) => l.msg === "xs" || l.msg.startsWith("xs ")) });
  return normalize(JSON.stringify(side.transcript));
}

/** Values only — never keys (an extra key must stay visible). */
function normalize(s: string): string {
  return s.replace(/x[0-9a-f]{18}/g, "<xid>");
}

const sid = (id: string): string => TABLE.find((m) => m.id === id)!.sessionId;
const QID1 = "q0123456789abcdef01";
const QID2 = "qfedcba9876543210ff";

/** The deterministic default-only script, run for each requester. */
function scriptFor(me: string): Step[] {
  const s: Step[] = [
    { req: me, frame: { op: "info" } },
    { req: me, frame: { op: "list" } },
    { req: me, frame: { op: "list", scope: "cwd" } },
    { req: me, frame: { op: "list", query: "be" } },
    { req: me, frame: { op: "list", query: "sess-ALP" } },
    { req: me, frame: { op: "list", query: "zzz" } },
    { req: me, frame: { op: "resolve", query: "beta" } },
    { req: me, frame: { op: "resolve", query: "BETA" } },
    { req: me, frame: { op: "resolve", query: "  delta  " } },
    { req: me, frame: { op: "resolve", query: "sess-ALP" } },
    { req: me, frame: { op: "resolve", query: "sess-ALPHA-00" } },
    { req: me, frame: { op: "resolve", query: sid("G1") } },
    { req: me, frame: { op: "resolve", query: "dup" } },
    { req: me, frame: { op: "resolve", query: "root" } },
    { req: me, frame: { op: "resolve", query: "r_abc" } },
    { req: me, frame: { op: "resolve", query: "nobody" } },
    { req: me, frame: { op: "resolve", query: sid("I") } },
    { req: me, frame: { op: "resolve", to: "phi" } },
    // sends
    { req: me, frame: { op: "send", to: "delta", text: "hi d", wake: true, level: 0 } },
    { ack: "D", over: { effect: "applied", woke: false, wakeDowngraded: "receiver_policy" } }, // refund (both)
    { req: me, frame: { op: "send", to: sid("G1"), text: "dup?" } },
    { req: me, frame: { op: "send", to: "eps", text: "off?" } },
    { req: me, frame: { op: "send", to: "phi", text: "replies?" } },
    { req: me, frame: { op: "send", to: "nobody", text: "x" } },
    { req: me, frame: { op: "send", to: "@label", text: "x" } },
    { req: me, frame: { op: "send", to: "beta", text: "" } },
    { req: me, frame: { op: "send", to: "beta", text: "x".repeat(16_100) } },
    { req: me, frame: { op: "send", to: "idle", text: "x" } },
    { advance: 6_000 },
    { req: me, frame: { op: "send", to: "beta", text: "wake beta", wake: true, level: 1 } },
    { ack: "B", over: { effect: "applied", woke: true } },
    { req: me, frame: { op: "send", to: "beta", text: "again" } }, // pair interval
    { advance: 6_000 },
    { req: me, frame: { op: "send", to: sid("B"), text: "ask", expect: { requestId: QID1, timeoutMs: 600_000 } } },
    { ack: "B", over: { effect: "applied", woke: false, reason: "queued" } },
    { req: me, frame: { op: "send", to: sid("F"), text: "answer", replyTo: QID2 } },
    { ack: "F", over: { effect: "applied", woke: false, reason: "reply_late" } },
    { req: me, frame: { op: "send", to: "beta", text: "bad", expect: { requestId: "nope", timeoutMs: 1 } } },
    { req: me, frame: { op: "send", to: sid("C"), text: "ans", replyTo: QID1 } },
    { req: me, frame: { op: "send", to: "Beta", text: "weird reason", wake: true, level: 0 } },
    { advance: 6_000 },
    { req: me, frame: { op: "send", to: "alpha2", text: "slow" } },
    { advance: 5_001 }, // hub deliver deadline ⇒ unknown{deliver_deadline}
    { req: me, frame: { op: "send", to: "alpha2", text: "mismatch", wake: true, level: 0 } },
    { ack: "H", over: { xid: "x-forged", effect: "applied", woke: true } },
    { advance: 5_001 },
    { tooLarge: me, raw: { t: "xs_req", rid: "big-1" } },
    { advance: 61_000 },
  ];
  // the requester never sends to itself: drop steps addressing my own names
  const self = TABLE.find((m) => m.id === me)!;
  return s.filter((st) => {
    if ("ack" in st) return st.ack !== me;
    if (!("req" in st)) return true;
    const to = (st.frame["to"] ?? "") as string;
    return to !== self.name && to !== self.sessionId;
  });
}

describe("§9.4-3 hub differential: v0.7.1 router vs current router (default-only table)", () => {
  it.each(["A", "B", "D", "H"])("requester %s: byte-equal xs_res / xs_deliver / audit transcript", async (me) => {
    rid = 0;
    const legacy = build(createLegacyRelay as unknown as RelayFactory, true);
    const legacyOut = await run(legacy, scriptFor(me), LEGACY_AGENT_SCHEMAS);
    rid = 0;
    const current = build(createCurrentRelay as unknown as RelayFactory, false);
    const currentOut = await run(current, scriptFor(me));
    legacy.dispose();
    current.dispose();
    expect(currentOut).toBe(legacyOut);
    // the script really exercised the surface: answers, deliveries, ambiguity, deadline
    expect(legacyOut).toContain('"E_XS_AMBIGUOUS"');
    expect(legacyOut).toContain('"candidates"');
    expect(legacyOut).toContain('"deliver_deadline"');
    expect(legacyOut).toContain('"xs_deliver"');
    expect(legacyOut).not.toContain('"dropped"');
  });

  it("negative control: the frozen decoder REJECTS channel-shaped frames and the new ops", () => {
    const base = { t: "xs_req", rid: "n1", origin: { sessionId: "s", epoch: 1 } };
    for (const f of [
      { ...base, op: "broadcast", channel: "team", text: "x" },
      { ...base, op: "channels" },
      { ...base, op: "list", channel: "team" },
      { t: "xs_member", sessionId: "s", epoch: 1, joined: true, receive: "wake", limits: LIMITS, channels: ["a"] },
      {
        t: "xs_member",
        sessionId: "s",
        epoch: 1,
        joined: true,
        receive: "wake",
        limits: { ...LIMITS, broadcastsOutPerHour: 6 },
      },
    ]) {
      expect(legacyAccepts(f, LEGACY_AGENT_SCHEMAS), JSON.stringify(f)).toBe(false);
    }
    const deliver = {
      t: "xs_deliver",
      rid: "r1",
      xid: "x1",
      to: { sessionId: "s", epoch: 1 },
      from: { sessionId: "f", ref: "f", cwdLabel: "~", agentId: "a" },
      text: "t",
      wake: false,
      expiresAt: 1,
    };
    expect(legacyAccepts(deliver, LEGACY_HUB_SCHEMAS)).toBe(true);
    expect(legacyAccepts({ ...deliver, via: ["a"] }, LEGACY_HUB_SCHEMAS)).toBe(false);
    expect(legacyAccepts({ ...deliver, bc: { channel: "a" } }, LEGACY_HUB_SCHEMAS)).toBe(false);
  });

  it("NQ2 directed: an unknown ∧ woke:false ack is the ONLY divergence (v0.7.1 refunds, current does not)", async () => {
    const script = (effect: "unknown" | "applied" | "none"): Step[] => [
      { req: "A", frame: { op: "send", to: "beta", text: "w1", wake: true, level: 0 } },
      { ack: "B", over: { effect, woke: false, ...(effect === "none" ? { reason: "rejected" } : {}) } },
      { advance: 6_000 },
      { req: "A", frame: { op: "send", to: "beta", text: "w2", wake: true, level: 0 } },
      { ack: "B", over: { effect: "applied", woke: true } },
    ];
    const outs: Record<string, { legacy: string; current: string }> = {};
    for (const effect of ["unknown", "applied", "none"] as const) {
      // A's wakesOutPerHour = 3 in the table: make the second wake depend on the refund by pre-spending one
      const pre: Step[] = [
        { req: "A", frame: { op: "send", to: "delta", text: "p", wake: true, level: 0 } },
        { ack: "D", over: { effect: "applied", woke: true } },
        { req: "A", frame: { op: "send", to: "alpha2", text: "p", wake: true, level: 0 } },
        { ack: "H", over: { effect: "applied", woke: true } },
      ];
      rid = 0;
      const legacy = build(createLegacyRelay as unknown as RelayFactory, true);
      const l = await run(legacy, [...pre, ...script(effect)], LEGACY_AGENT_SCHEMAS);
      rid = 0;
      const current = build(createCurrentRelay as unknown as RelayFactory, false);
      const c = await run(current, [...pre, ...script(effect)]);
      legacy.dispose();
      current.dispose();
      outs[effect] = { legacy: l, current: c };
    }
    expect(outs["applied"]!.current).toBe(outs["applied"]!.legacy);
    expect(outs["none"]!.current).toBe(outs["none"]!.legacy);
    expect(outs["unknown"]!.current).not.toBe(outs["unknown"]!.legacy);
    const secondWake = (s: string) =>
      (JSON.parse(s.replace(/<xid>/g, "X")) as Array<{ to?: string; frame?: { text: string; wake: boolean } }>).find(
        (x) => x.frame?.text === "w2",
      )!.frame!.wake;
    expect(secondWake(outs["unknown"]!.legacy)).toBe(true); // v0.7.1: refunded
    expect(secondWake(outs["unknown"]!.current)).toBe(false); // NQ2: still spent
  });
});

describe("AL2 (alias-plan §9 AL2 / NQ3): no-cap requesters × alias-holding members stay v0.7.1-equal", () => {
  /** Members C / E / G1 / I declare `xs.alias.v1` and hold aliases that COLLIDE with other members'
   *  names ("delta" is D's name, "beta" B's, "phi" F's, "alpha" A's). The requesters A/B/D/H have
   *  no alias cap ⇒ legacy four tiers, legacy rows/candidates/targets, legacy deliveries. */
  const ALIAS_HOLDERS: Record<string, string> = { C: "beta", E: "delta", G1: "phi", I: "alpha" };
  const capsOf = (m: MemberSpec): string[] => (m.id in ALIAS_HOLDERS ? [...m.caps, "xs.alias.v1"] : m.caps);

  function memFs(seed: Uint8Array): XsAliasFs {
    const files = new Map<string, Uint8Array>([[`/state/${XS_ALIAS_FILE}`, seed]]);
    return {
      read: async (path, max) => {
        const b = files.get(path);
        if (b === undefined) return { kind: "missing" };
        return b.length > max ? { kind: "toolarge" } : { kind: "bytes", bytes: b };
      },
      writeTemp: async (path, bytes) => void files.set(path, bytes),
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      unlink: async (path) => void files.delete(path),
      syncDir: async () => {},
    };
  }
  async function aliasFactory(): Promise<RelayFactory> {
    const records = Object.entries(ALIAS_HOLDERS)
      .map(([id, alias], i) => ({
        alias,
        skeleton: aliasSkeleton(alias),
        sessionId: sid(id),
        state: "held",
        rev: i + 1,
        cwdLabel: "~",
      }))
      .sort((a, b) => (a.alias < b.alias ? -1 : 1));
    const seed = new TextEncoder().encode(
      JSON.stringify({ version: 1, skeletonVersion: 1, seq: records.length, records, tombstones: [] }),
    );
    const binding = createXsAliasBinding({
      stateDir: "/state",
      params: { ...XS_ALIAS_DEFAULT_PARAMS },
      now: () => FIXED_NOW,
      fs: memFs(seed),
    });
    const loaded = await binding.store.load();
    expect(loaded.state).toBe("ready");
    expect(binding.store.advertised).toBe(true);
    return (deps) => createCurrentRelay({ ...deps, aliases: binding }) as unknown as ReturnType<RelayFactory>;
  }

  it.each(["A", "B", "D", "H"])("requester %s (no alias cap): byte-equal to the frozen v0.7.1 router", async (me) => {
    rid = 0;
    const legacy = build(createLegacyRelay as unknown as RelayFactory, true, capsOf);
    const legacyOut = await run(legacy, scriptFor(me), LEGACY_AGENT_SCHEMAS);
    rid = 0;
    const current = build(await aliasFactory(), false, capsOf);
    const currentOut = await run(current, scriptFor(me));
    legacy.dispose();
    current.dispose();
    expect(currentOut).toBe(legacyOut);
    expect(currentOut).not.toContain('"alias"');
    expect(legacyOut).toContain('"xs_deliver"');
  });

  it("control: an alias-capable requester on the same table DOES diverge (the alias tier is live)", async () => {
    const aliasCaps = (m: MemberSpec): string[] => (m.id === "A" ? [...m.caps, "xs.alias.v1"] : capsOf(m));
    const script: Step[] = [{ req: "A", frame: { op: "resolve", query: "delta" } }];
    rid = 0;
    const legacy = build(createLegacyRelay as unknown as RelayFactory, true, aliasCaps);
    const l = await run(legacy, script, LEGACY_AGENT_SCHEMAS);
    rid = 0;
    const current = build(await aliasFactory(), false, aliasCaps);
    const c = await run(current, script);
    legacy.dispose();
    current.dispose();
    expect(l).toContain(sid("D").slice(0, 12));
    // E holds "delta" but its receive is off — still the alias tier decides (E is in the visible pool)
    expect(c).toContain('"alias":"delta"');
    expect(c).not.toBe(l);
  });
});
