import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, joinedPair, send, until, type Peer } from "./helpers/fabric-xs-harness.js";

/**
 * IBW: channel-plan §12.7 — the unread inbox on real activate-built stacks. Both host write exits
 * (receiver/Controller host, NoticeGate quiet host) count; turn events clear; web status republishes.
 * The fixture's pi double fires extension events on request (`event` op) — real pi's ordering facts
 * are pinned separately by conformance C-X10.
 */
let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 20_000);

const key = "pi-subagent:xs-inbox";
const lastBadge = async (p: Peer) =>
  ((await p.rpc("inspect")).statuses as Array<{ key: string; text?: string }>).filter((s) => s.key === key).at(-1)
    ?.text;
type InboxFrame = { key: string; xsInbox: unknown };
const hubFrames = async (hub: Peer) => (await hub.rpc("inspect")).statusInbox as InboxFrame[];
const hubInbox = (frames: InboxFrame[], agentKey: string) => frames.filter((f) => f.key === agentKey);
const lastHubInbox = async (hub: Peer, agentKey: string) => hubInbox(await hubFrames(hub), agentKey).at(-1)?.xsInbox;
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
/** Wait until the hub has received no new status frame for `quietMs` from ANY agent (steady state). */
async function untilQuiet(hub: Peer, quietMs = 500): Promise<InboxFrame[]> {
  let prev = await hubFrames(hub);
  // bounded: every agent publishes sparsely in steady state, so a quiet window appears within a few rounds
  for (let i = 0; i < 60; i++) {
    await sleep(quietMs);
    const now = await hubFrames(hub);
    if (now.length === prev.length) return now;
    prev = now;
  }
  throw new Error("hub status frames never went quiet");
}
/** Resolve an agent's hub-side key from its sessionId (alias-v2 convention: `inspect` agents[].session). */
async function agentKeyOf(hub: Peer, sessionId: string): Promise<string> {
  const hit = ((await hub.rpc("inspect")).agents as Array<{ agentKey: string; session?: { sessionId?: string } }>).find(
    (x) => x.session?.sessionId === sessionId,
  );
  if (hit === undefined) throw new Error(`hub does not know ${sessionId}`);
  return hit.agentKey;
}
const turn = async (p: Peer) => {
  await p.rpc("event", { type: "turn_start" });
  await p.rpc("event", { type: "turn_end", extra: { messageEntryId: "x" } });
};

describe("IBW unread inbox (real stacks)", () => {
  it("exit 1 (receiver host): quiet deliver counts, shows badge + web field, clears on a later-started turn", async () => {
    h = new XsHarness();
    const { hub, a, b, aid, bid } = await joinedPair(h);
    const aKey = await agentKeyOf(hub, aid);
    const bKey = await agentKeyOf(hub, bid);
    await b.rpc("prime");
    expect(await send(a, bid, "hello")).toMatchObject({ effect: "applied" });
    await until(
      () => lastBadge(b),
      (t) => t === "inbox 1",
      "badge",
    );
    // Deterministic regression (was ~1/8 flaky): in the quiet steady state make the SENDER alpha
    // publish exactly one more frame (`turn_end` ∈ STATUS_EVENTS ⇒ unconditional publishStatus). The
    // hub's overall last frame is then alpha's, which carries no xsInbox — a receiver-keyed read must
    // still see beta's unread frame, in ONE inspect with no retry polling to paper over the ordering.
    const before = await untilQuiet(hub);
    const bUnread = hubInbox(before, bKey).at(-1)?.xsInbox;
    expect((bUnread as { unread?: number } | undefined)?.unread).toBe(1); // receiver frame already landed
    await a.rpc("event", { type: "turn_end", extra: { messageEntryId: "x" } });
    let snap: InboxFrame[] | undefined;
    await until(
      async () => {
        const f = await hubFrames(hub);
        if (f.length === before.length + 1 && f.at(-1)?.key === aKey) snap = f;
        return f.length === before.length + 1;
      },
      (ok) => ok,
      "sender turn_end frame",
    );
    if (snap === undefined) throw new Error("beta republished after alpha's frame — ordering not deterministic");
    expect(snap.at(-1)?.xsInbox).toBeUndefined(); // alpha's own frame has no inbox
    // 修复前必红：the last OVERALL frame is alpha's; only the beta-keyed read sees unread 1.
    expect((hubInbox(snap, bKey).at(-1)?.xsInbox as { unread?: number } | undefined)?.unread).toBe(1);
    await until(
      () => lastHubInbox(hub, bKey),
      (v) => (v as any)?.unread === 1,
      "web xsInbox 1",
    );
    expect(await b.rpc("cmd")).toContain("inbox unread 1");
    await turn(b);
    await until(
      () => lastBadge(b),
      (t) => t === undefined,
      "badge cleared",
    );
    await until(
      () => lastHubInbox(hub, bKey),
      (v) => v === undefined,
      "web xsInbox absent at 0",
    );
    expect(await b.rpc("cmd")).toContain("inbox unread 0");
  }, 40_000);

  it("Controller wake write counts (trigger turn started after the write)", async () => {
    h = new XsHarness();
    const { a, b, bid } = await joinedPair(h);
    await a.rpc("prime");
    await b.rpc("prime");
    expect(await send(a, bid, "wake you", false, { wake: true })).toMatchObject({ effect: "applied" });
    await until(
      () => lastBadge(b),
      (t) => t === "inbox 1",
      "wake counted",
    );
    await turn(b);
    expect(await lastBadge(b)).toBeUndefined();
  }, 40_000);

  it("busy: a write inside turn k survives turn k's end and clears at turn k+1's", async () => {
    h = new XsHarness();
    const { a, b, bid } = await joinedPair(h);
    await b.rpc("prime");
    await b.rpc("event", { type: "turn_start" });
    await b.rpc("busy", { busy: true });
    expect(await send(a, bid, "mid-turn")).toMatchObject({ effect: expect.any(String) });
    await until(
      () => lastBadge(b),
      (t) => t === "inbox 1",
      "counted while busy",
    );
    await b.rpc("event", { type: "turn_end", extra: { messageEntryId: "x" } });
    expect(await lastBadge(b)).toBe("inbox 1");
    await b.rpc("settle");
    await turn(b);
    expect(await lastBadge(b)).toBeUndefined();
  }, 40_000);

  it("exit 2 (NoticeGate quiet host): a timeout notice counts without an xid", async () => {
    h = new XsHarness();
    const { a, bid } = await joinedPair(h);
    await a.rpc("event", { type: "before_agent_start", extra: { prompt: "legacy host" } }); // cap absent ⇒ quiet (wake-unknown-optimistic)
    await a.rpc("tool", { name: "message_session", params: { to: bid, text: "q", expectReply: { timeoutS: 60 } } });
    await a.rpc("skew", { ms: 61_000 });
    await a.rpc("settle");
    expect((await a.rpc("inspect")).replyNotices).toHaveLength(1);
    expect(await lastBadge(a)).toBe("inbox 1");
    await turn(a);
    expect(await lastBadge(a)).toBeUndefined();
  }, 40_000);

  it("agent_end fallback clears when turn_end never fires; /reload keeps the count", async () => {
    h = new XsHarness();
    const { hub, a, b, bid } = await joinedPair(h);
    const bKey = await agentKeyOf(hub, bid);
    await b.rpc("prime");
    await send(a, bid, "one");
    await until(
      () => lastBadge(b),
      (t) => t === "inbox 1",
      "counted",
    );
    await b.rpc("reload");
    expect(await lastBadge(b)).toBe("inbox 1");
    await until(
      () => lastHubInbox(hub, bKey),
      (v) => (v as any)?.unread === 1,
      "web retains after reload",
    );
    await b.rpc("event", { type: "turn_start" });
    await b.rpc("event", { type: "agent_end", extra: { messages: [] } });
    expect(await lastBadge(b)).toBeUndefined();
  }, 40_000);

  it("a rejected message (effect none) is not counted", async () => {
    h = new XsHarness();
    const { a, b, bid } = await joinedPair(h);
    await b.rpc("cmd", { args: "receive off" });
    await send(a, bid, "refused");
    expect(await lastBadge(b)).toBeUndefined();
    expect(await b.rpc("cmd")).toContain("inbox unread 0");
  }, 40_000);
});
