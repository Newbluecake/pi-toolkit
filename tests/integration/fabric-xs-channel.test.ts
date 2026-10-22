import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, list, send, until, type Peer } from "./helpers/fabric-xs-harness.js";

/**
 * channel-plan §9.2 (CHW): channels end to end — a real hub child (`xs.channel.v1`) × 3–6 real
 * activate()-built stacks over real sockets. Only the pi host/provider is fake.
 */

let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 30_000);

/** Agents share one HOME (one settings file, written at boot): boot SEQUENTIALLY so each agent's env
 *  config is the one its activate() reads, and so UUIDv7 session refs (12-char, ~16ms granularity)
 *  never collide between peers. */
async function agents(...specs: Array<[string, Record<string, string>?]>): Promise<Peer[]> {
  const out: Peer[] = [];
  for (const [name, env] of specs) out.push(await h.boot("agent", name, undefined, true, false, env ?? {}));
  return out;
}
const cmd = (p: Peer, args: string) => p.rpc("cmd", { args });
const listIn = (p: Peer, channel: string) => p.rpc("tool", { name: "list_sessions", params: { channel } });
const bcast = (p: Peer, channel: string, text: string, wake?: boolean) =>
  p.rpc("tool", { name: "message_channel", params: { channel, text, ...(wake === undefined ? {} : { wake }) } });
const sid = async (p: Peer): Promise<string> => (await p.rpc("inspect")).sessionId;
const refsOf = (out: { rows?: Array<{ ref: string }> }) => (out.rows ?? []).map((r) => r.ref).sort();
const ref = (id: string) => id.slice(0, 12);
async function sees(p: Peer, ids: string[], label: string): Promise<void> {
  const want = ids.map(ref).sort();
  let last: unknown;
  try {
    await until(
      async () => {
        await new Promise((r) => setTimeout(r, 400)); // stay under the hub's listPerMin (60)
        return (last = await list(p));
      },
      (l) => JSON.stringify(refsOf(l)) === JSON.stringify(want),
      label,
    );
  } catch (err) {
    throw new Error(`${(err as Error).message} — last list: ${JSON.stringify(last)} want ${JSON.stringify(want)}`);
  }
}
const xsMessages = async (p: Peer, text: string) =>
  ((await p.rpc("inspect")).messages as Array<{ content: string; details?: Record<string, unknown> }>).filter((m) =>
    m.content.includes(text),
  );

describe("channel-plan §9.2 (CHW): channels over a real hub", () => {
  it("#1 same-channel scope, #2 union visibility (rows carry the shared non-default set)", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const [a, b, c, d] = (await agents(["alpha"], ["beta"], ["gamma"], ["delta"])) as [Peer, Peer, Peer, Peer];
    const [aid, bid, cid, did] = await Promise.all([a, b, c, d].map(sid));
    expect(await cmd(a, "join #a")).toContain("#a");
    await cmd(b, "join #a");
    await cmd(c, "join"); // #default only
    await cmd(d, "join #b");
    // #1: A sees only B; A→C and C→A are NO_TARGET (unknown ≡ other channel, XI5).
    await sees(a, [bid], "A sees B only");
    expect((await list(a)).rows).toEqual([expect.objectContaining({ ref: ref(bid), channels: ["a"] })]);
    await sees(c, [], "C sees nobody");
    expect(await send(a, cid, "a to c")).toMatchObject({ status: "no_target", effect: "none" });
    expect(await send(c, aid, "c to a")).toMatchObject({ status: "no_target", effect: "none" });
    expect(await send(a, bid, "a to b")).toMatchObject({ effect: "applied" });
    expect(await xsMessages(b, "a to b")).toHaveLength(1);
    // #2: A in [a,b] sees B (#a) and D (#b); B sees A but never D.
    expect(await cmd(a, "join #b")).toContain("#b");
    await sees(a, [bid, did], "A sees B and D");
    const rows = (await list(a)).rows as Array<{ ref: string; channels?: string[] }>;
    expect(rows.find((r) => r.ref === ref(bid))?.channels).toEqual(["a"]);
    expect(rows.find((r) => r.ref === ref(did))?.channels).toEqual(["b"]);
    await sees(b, [aid], "B sees A only");
    await sees(d, [aid], "D sees A only");
    // list's channel filter (channel instance of list_sessions).
    expect(refsOf(await listIn(a, "b"))).toEqual([ref(did)]);
    expect(await listIn(b, "b")).toMatchObject({ status: "bad_channel" }); // not my channel ⇒ local refusal
    expect(await send(b, did, "b to d")).toMatchObject({ status: "no_target" });
    // /fabric status shows the channel line; /fabric channels lists hub channels with counts.
    expect(await cmd(a, "status")).toMatch(/channels #a #b \(2\/4\) · hub-cap on/);
    const listing = await cmd(a, "channels");
    expect(listing).toContain("#a");
    expect(listing).toContain("#b");
  }, 60_000);

  it("#3 broadcast: fanout, no loop-back, deliver downgrade, replies invisible, level-0 wake, woken re-broadcast level_limit, sender maxLevel=0", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const [a, b, c, d, f] = (await agents(
      ["alpha"],
      ["beta"],
      ["gamma", { XW_RECEIVE: "deliver" }],
      ["delta", { XW_RECEIVE: "replies" }],
      ["phi", { XW_WAKE_MAX_LEVEL: "0" }],
    )) as [Peer, Peer, Peer, Peer, Peer];
    const [aid, bid, cid, , fid] = await Promise.all([a, b, c, d, f].map(sid));
    await Promise.all([a, b, c, d, f].map((p) => cmd(p, "join #team")));
    await sees(a, [bid, cid, fid], "A sees team (replies-only D hidden)");
    // host capability observed ⇒ the per-row downgrades below reflect policy, not host_unverified
    await Promise.all([b, c, f].map((p) => p.rpc("prime")));

    // deliver-only broadcast from C: recipients A, B, F; never C itself, never D (replies).
    const out1 = await bcast(c, "team", "hello team");
    expect(out1).toMatchObject({ status: "sent", effect: "applied", channel: "team" });
    expect(out1.fanout).toMatchObject({ total: 3, applied: 3, none: 0, unknown: 0 });
    expect((out1.results as Array<{ ref: string }>).map((r) => r.ref).sort()).toEqual([aid, bid, fid].map(ref).sort());
    expect(await xsMessages(c, "hello team")).toHaveLength(0);
    expect(await xsMessages(d, "hello team")).toHaveLength(0);
    const got = (await xsMessages(a, "hello team"))[0]!;
    expect(got.details).toMatchObject({ bc: { channel: "team" } });
    expect(got.content).toContain('channel="#team" kind="broadcast"');
    // channel-plan §12.7: a broadcast counts toward the receiver's inbox badge.
    const statuses = (await a.rpc("inspect")).statuses as Array<{ key: string; text?: string }>;
    expect(statuses.filter((s) => s.key === "pi-subagent:xs-inbox").at(-1)?.text).toBe("inbox 1");

    // level-0 wake from A: B woken, C (deliver) and F (maxLevel 0) downgraded per row.
    const out2 = await bcast(a, "team", "wake team", true);
    expect(out2).toMatchObject({ status: "sent", channel: "team" });
    expect(out2.fanout).toMatchObject({ total: 3, woke: 1 });
    const rows2 = out2.results as Array<{ ref: string; effect: string; woke: boolean; wakeDowngraded?: string }>;
    expect(rows2.find((r) => r.ref === ref(bid))).toMatchObject({ effect: "applied", woke: true });
    expect(rows2.find((r) => r.ref === ref(cid))).toMatchObject({ woke: false, wakeDowngraded: "receiver_policy" });
    expect(rows2.find((r) => r.ref === ref(fid))).toMatchObject({ woke: false, wakeDowngraded: "level_limit" });
    const woken = (await xsMessages(b, "wake team"))[0] as { details?: Record<string, unknown> } & {
      triggerTurn?: boolean;
    };
    expect(woken.triggerTurn).toBe(true);
    expect(woken.details).toMatchObject({ xsWake: true, bc: { channel: "team" } });

    // the woken run (level 1) cannot start a waking broadcast: local level_limit, sent deliver-only.
    const out3 = await bcast(b, "team", "woken re-broadcast", true);
    expect(out3).toMatchObject({ status: "sent", wakeDowngraded: "level_limit" });
    expect(out3.fanout?.woke ?? 0).toBe(0);

    // sender maxLevel=0 ⇒ local downgrade (hopAllowed fails at level 0).
    const out4 = await bcast(f, "team", "phi wake", true);
    expect(out4).toMatchObject({ status: "sent", wakeDowngraded: "level_limit" });
    expect(out4.fanout?.woke ?? 0).toBe(0);
  }, 70_000);

  it("#4 limits: per-hour cap, min interval, fan-out cap, #default refused", async () => {
    h = new XsHarness();
    await h.boot("hub", "hub", undefined, true, false, {
      XW_HUB_CHANNELS_JSON: JSON.stringify({ maxRecipients: 2, wakeMaxRecipients: 2 }),
    });
    const [a, b, c, d, e] = (await agents(
      ["alpha"],
      ["beta"],
      ["gamma"],
      ["delta", { XW_CHANNELS_JSON: JSON.stringify({ broadcast: { outPerHour: 1 } }) }],
      ["eps"],
    )) as [Peer, Peer, Peer, Peer, Peer];
    const [, bid, cid, did, eid] = await Promise.all([a, b, c, d, e].map(sid));
    await Promise.all([a, b, c, d].map((p) => cmd(p, "join #x")));
    await Promise.all([d, e].map((p) => cmd(p, "join #y")));
    await sees(a, [bid, cid, did], "A sees #x");
    await until(
      () => listIn(e, "y"),
      (l) => JSON.stringify(refsOf(l)) === JSON.stringify([ref(did)]),
      "E sees D in #y",
    );
    // fan-out cap (hub maxRecipients 2; #x has 3 recipients besides A).
    expect(await bcast(a, "x", "too many")).toMatchObject({
      status: "fanout_too_large",
      effect: "none",
      code: "E_XS_FANOUT_TOO_LARGE",
    });
    // per-hour cap: D may broadcast once an hour — the next one is refused (nothing consumed).
    expect(await bcast(d, "y", "first")).toMatchObject({ status: "sent", effect: "applied" });
    expect(await bcast(d, "y", "second")).toMatchObject({ effect: "none", reason: "rate_broadcast_hour" });
    expect(await xsMessages(e, "second")).toHaveLength(0);
    // min interval (default 60s): E's second broadcast right after the first is refused.
    expect(await bcast(e, "y", "e first")).toMatchObject({ status: "sent", effect: "applied" });
    expect(await bcast(e, "y", "e again")).toMatchObject({ effect: "none", reason: "rate_broadcast_interval" });
    // Q2: #default can never be broadcast to (local refusal, nothing sent).
    await cmd(b, "join");
    expect(await bcast(b, "default", "everyone")).toMatchObject({ status: "default_channel", effect: "none" });
    expect(await bcast(b, "#Default", "everyone")).toMatchObject({ status: "default_channel" });
    expect(eid).toBeTruthy();
  }, 70_000);

  it("#5 linearization: leave before stage 3 ⇒ none{rejected}; leave after dispatch ⇒ applied (no rollback)", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    const [a, b] = (await agents(["alpha"], ["beta"])) as [Peer, Peer];
    const bid = await sid(b);
    await cmd(a, "join #a");
    await cmd(b, "join #a #b");
    await sees(a, [bid], "A sees B");
    // (a) the hub has stamped via=[a]; B leaves #a before its receiver runs stage 3.
    await hub.rpc("hold", { mode: "before" });
    let delivered = hub.event("deliver");
    let pending = send(a, bid, "before stage 3");
    const frame = (await delivered).frame as { via?: string[] };
    expect(frame.via).toEqual(["a"]);
    await cmd(b, "leave #a"); // still joined via #b — the channel check alone rejects
    await hub.rpc("release");
    expect(await pending).toMatchObject({ effect: "none", reason: "rejected" });
    expect(await xsMessages(b, "before stage 3")).toHaveLength(0);
    // (b) re-share; B leaves only after its receiver applied (before A has the ack).
    await cmd(b, "join #a");
    await sees(a, [bid], "A sees B again");
    await new Promise((r) => setTimeout(r, 5_200)); // pairMinIntervalMs (5s) between the two sends
    await hub.rpc("hold", { mode: "after" });
    delivered = hub.event("acked");
    pending = send(a, bid, "after dispatch");
    await delivered;
    await cmd(b, "leave #a");
    await hub.rpc("release");
    expect(await pending).toMatchObject({ effect: "applied" });
    expect(await xsMessages(b, "after dispatch")).toHaveLength(1);
  }, 50_000);

  it("#6 a cross-channel double holder is AMBIGUOUS (uniqueness judged before visibility)", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const [a, b] = (await agents(["alpha"], ["beta"])) as [Peer, Peer];
    const { sessionId: bid, sessionFile } = await b.rpc("inspect");
    await cmd(a, "join #a");
    await cmd(b, "join #a");
    await sees(a, [bid], "A sees B");
    // A second process restores the SAME session and joins a channel A cannot see.
    const twin = await h.boot("agent", "twin", sessionFile);
    expect(await sid(twin)).toBe(bid);
    await cmd(twin, "join #z");
    await until(
      () => send(a, bid, "to the double holder"),
      (out) => out.status === "ambiguous",
      "double holder ambiguous",
    );
    const out = await send(a, bid, "to the double holder");
    expect(out).toMatchObject({ status: "ambiguous", effect: "none" });
    expect(await xsMessages(b, "to the double holder")).toHaveLength(0);
    expect(await xsMessages(twin, "to the double holder")).toHaveLength(0);
  }, 50_000);

  it("#7 hub restart, /reload, fork (no inheritance), suspend on channels.enabled=false and restore", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    const [a, b] = (await agents(["alpha"], ["beta"])) as [Peer, Peer];
    const [aid, bid] = await Promise.all([a, b].map(sid));
    await cmd(a, "join #a");
    await cmd(b, "join #a");
    await sees(a, [bid], "A sees B");
    // hub restart: the member slots replay with their channels.
    await hub.kill();
    await h.boot("hub");
    await sees(a, [bid], "A sees B after hub restart");
    expect((await list(a)).rows?.[0]?.channels).toEqual(["a"]);
    // /reload keeps the persisted channel set.
    await a.rpc("reload");
    await sees(a, [bid], "A sees B after reload");
    expect(await cmd(a, "status")).toMatch(/channels #a \(1\/4\)/);
    // fork: a new sessionId never inherits the membership.
    const fork = await b.rpc("replace", { reason: "fork" });
    expect(fork.sessionId).not.toBe(bid);
    expect(await b.rpc("cmd")).toContain("not joined");
    await sees(a, [], "fork hidden");
    // back to a joined B (fresh session) for the suspend check.
    await cmd(b, "join #a");
    const bid2 = await sid(b);
    await sees(a, [bid2], "A sees new B");
    // suspend: channels.enabled=false + reload ⇒ #a suspended (not folded into #default), entry untouched.
    const membersBefore = (await a.rpc("inspect")).members.length;
    await a.rpc("settingsChannels", { channels: { enabled: false } });
    await a.rpc("reload");
    expect((await a.rpc("inspect")).toolNames).not.toContain("message_channel");
    const st = await cmd(a, "status");
    expect(st).toContain("not joined");
    expect(st).toContain("suspended #a (channels.enabled=false)");
    await sees(b, [], "suspended A invisible to B");
    expect((await a.rpc("inspect")).members.length).toBe(membersBefore);
    // restore: enabled again + reload ⇒ back in #a.
    await a.rpc("settingsChannels", { channels: { enabled: true } });
    await a.rpc("reload");
    await sees(a, [bid2], "A restored in #a");
    await sees(b, [aid], "B sees restored A");
  }, 70_000);
});
