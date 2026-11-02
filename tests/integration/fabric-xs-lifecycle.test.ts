import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, joinedPair, list, send, until } from "./helpers/fabric-xs-harness.js";

let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 20_000);

describe("XW R1 minor: proof-driven ledger teardown and settled forwarding", () => {
  it.each(["new", "resume", "fork"])(
    "8 deferred tombstones survive reload but %s teardown frees ALL capacity",
    async (reason) => {
      h = new XsHarness();
      await h.boot("hub");
      const a = await h.boot("agent", "alpha");
      expect(await a.rpc("seedLedger", { count: 8 })).toBe(8);
      expect((await a.rpc("reload")).ledger).toBe(8); // reload is NEVER teardown proof
      expect((await a.rpc("replace", { reason })).ledger).toBe(0);
      expect(await a.rpc("seedLedger", { count: 8 })).toBe(8); // capacity is actually reusable
      expect(await a.rpc("stop")).toEqual({ listeners: 0, ledger: 0 });
    },
    20_000,
  );

  it("recover aborting→stuck; agent_settled releases owner and ledger without a second abort", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const a = await h.boot("agent", "alpha");
    await a.rpc("busy", { busy: true });
    await a.rpc("seedLedger", { stuck: true });
    await a.rpc("reload");
    expect(await a.rpc("cmd")).toContain("controller stuck");
    expect((await a.rpc("inspect")).owned).toBe(true);
    await a.rpc("settle");
    expect(await a.rpc("cmd")).toContain("controller idle");
    expect(await a.rpc("inspect")).toMatchObject({ ledger: [], owned: false, aborts: 0 });
  }, 20_000);

  it.each([false, true])(
    "an already-started wake remains owned after an xs/wake-off reload (wakeOnly=%s)",
    async (wakeOnly) => {
      h = new XsHarness();
      const { a, b, bid } = await joinedPair(h);
      await b.rpc("prime");
      expect(await send(a, bid, "still owned if setting disabled", true)).toMatchObject({
        effect: "applied",
        woke: true,
      });
      const before = await b.rpc("inspect");
      await b.rpc("settingsOff", { wakeOnly });
      await b.rpc("reload");
      const after = await b.rpc("inspect");
      expect(after.owned).toBe(true);
      expect(after.ledger[0].deadlineAt).toBe(before.ledger[0].deadlineAt);
      expect(after.toolNames.includes("message_session")).toBe(wakeOnly); // xs off adds NO tools
      await b.rpc("settle");
      expect((await b.rpc("inspect")).ledger).toEqual([]);
    },
    25_000,
  );

  it("xs-off reload still aborts a marked orphan before any provider work", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const a = await h.boot("agent", "alpha");
    await a.rpc("settingsOff");
    await a.rpc("reload");
    await a.rpc("event", {
      type: "before_agent_start",
      extra: {
        messageType: "custom",
        message: { customType: "subagent:xs", details: { xsWake: true, wakeToken: "not-authorized" } },
      },
    });
    expect(await a.rpc("inspect")).toMatchObject({ aborts: 1, ledger: [] });
    expect((await a.rpc("inspect")).toolNames).not.toContain("message_session");
  }, 20_000);

  it("rpc process restore: disk membership is reachable with a new agent id, capability restarts unknown", async () => {
    h = new XsHarness();
    const { a, b, bid } = await joinedPair(h);
    const old = await b.rpc("inspect");
    await b.rpc("stop");
    await b.kill();
    const restored = await h.boot("agent", "beta-restored", old.sessionFile);
    await until(
      () => list(a),
      (l) => l.rows?.length === 1,
      "restored member",
    );
    const now = await restored.rpc("inspect");
    expect(now.sessionId).toBe(bid);
    expect(now.conn.agentKey).not.toBe(old.conn.agentKey);
    expect(now.capability).toBe("unknown");
    // wake-unknown-optimistic: the unknown-capability receiver dispatches optimistically; the
    // host's BAS authorizes the token ⇒ verified (the old host_unverified downgrade is gone).
    expect(await send(a, bid, "reachable after rpc restore", true)).toMatchObject({ effect: "applied", woke: true });
    const woken = await restored.rpc("inspect");
    expect(woken.capability).toBe("verified");
    expect(woken.messages.at(-1)).toMatchObject({ triggerTurn: true, details: { xsWake: true } });
    await restored.rpc("settle");
    expect((await restored.rpc("inspect")).messages).toHaveLength(1);
  }, 25_000);
});

describe("wake-unknown-optimistic: legacy host (XW_LEGACY fake — no BAS, context instead)", () => {
  it("the first optimistic run is aborted before any provider call; capability goes absent; later wakes are host_unsupported", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const a = await h.boot("agent", "alpha");
    const b = await h.boot("agent", "beta-legacy", undefined, true, false, { XW_LEGACY: "1" });
    await a.rpc("cmd", { args: "join" });
    await b.rpc("cmd", { args: "join" });
    const bid = (await b.rpc("inspect")).sessionId;
    await until(
      () => list(a),
      (l) => l.rows?.some((r: any) => bid.startsWith(r.ref)),
      "membership",
    );
    expect(await send(a, bid, "legacy optimistic wake", true)).toMatchObject({ effect: "applied", woke: true });
    await until(
      () => b.rpc("inspect"),
      (s) => s.capability === "absent" && s.aborts === 1,
      "legacy first run aborted",
    );
    const state = await b.rpc("inspect");
    expect(state.providerCalls).toBe(0); // aborted BEFORE any provider request
    expect(state.messages.at(-1)).toMatchObject({ triggerTurn: true, details: { xsWake: true } });
    await b.rpc("settle");
    expect((await b.rpc("inspect")).ledger).toEqual([]);
    await new Promise<void>((r) => {
      const t = setTimeout(r, 5_300); // pairMinIntervalMs 5000 (hub-side pair throttle)
      t.unref?.();
    });
    expect(await send(a, bid, "second wake is deliver-only", true)).toMatchObject({
      effect: "applied",
      wakeDowngraded: "host_unsupported",
    });
    const after = await b.rpc("inspect");
    expect(after.messages.at(-1)?.triggerTurn).toBe(false);
    expect(after.providerCalls).toBe(0);
    expect(after.aborts).toBe(1);
    expect(await a.rpc("stop")).toEqual({ listeners: 0, ledger: 0 });
    expect(await b.rpc("stop")).toEqual({ listeners: 0, ledger: 0 });
  }, 30_000);
});
