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
const hubInbox = async (hub: Peer, agentKey?: string) =>
  ((await hub.rpc("inspect")).statusInbox as Array<{ key: string; xsInbox: unknown }>).filter(
    (f) => agentKey === undefined || f.key === agentKey,
  );
const lastHubInbox = async (hub: Peer) => (await hubInbox(hub)).at(-1)?.xsInbox;
const turn = async (p: Peer) => {
  await p.rpc("event", { type: "turn_start" });
  await p.rpc("event", { type: "turn_end", extra: { messageEntryId: "x" } });
};

describe("IBW unread inbox (real stacks)", () => {
  it("exit 1 (receiver host): quiet deliver counts, shows badge + web field, clears on a later-started turn", async () => {
    h = new XsHarness();
    const { hub, a, b, bid } = await joinedPair(h);
    await b.rpc("prime");
    expect(await send(a, bid, "hello")).toMatchObject({ effect: "applied" });
    await until(
      () => lastBadge(b),
      (t) => t === "inbox 1",
      "badge",
    );
    await until(
      () => lastHubInbox(hub),
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
      () => lastHubInbox(hub),
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
      () => lastHubInbox(hub),
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
