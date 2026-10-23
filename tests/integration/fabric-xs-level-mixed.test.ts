import { afterEach, expect, it } from "vitest";
import { XsHarness, joinedPair, list, send, until } from "./helpers/fabric-xs-harness.js";

let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 20_000);

it("one causal chain: tree mailbox → root → xs wake → tree carry → xs wake → max-level downgrade; only human resets", async () => {
  h = new XsHarness();
  const { a, b, aid, bid } = await joinedPair(h);
  // Seed an actual pending tree mailbox record, as fabric-wake-level.test.ts does. The REAL
  // stack rebuild/pump must dispatch it and persist L1+1; no direct level mutation in this test.
  await a.rpc("seedTree", { level: 1, wake: true });
  await a.rpc("reload");
  await a.rpc("settle");
  expect((await a.rpc("inspect")).level).toBe(2);
  await b.rpc("prime");
  await until(
    () => list(a),
    (l) => l.status === "ok",
    "reload origin",
  );
  expect(await send(a, bid, "tree L2 across session", true)).toMatchObject({ effect: "applied", woke: true });
  expect((await b.rpc("inspect")).level).toBe(3);
  await b.rpc("settle");
  await b.rpc("seedTree", { level: 4, wake: false });
  await b.rpc("reload");
  expect((await b.rpc("inspect")).level).toBe(4);
  await until(
    () => list(b),
    (l) => l.status === "ok",
    "B reload origin",
  );
  expect(await send(b, aid, "tree carried L4 then xs hop", true)).toMatchObject({ effect: "applied", woke: true });
  expect((await a.rpc("inspect")).level).toBe(5);
  await a.rpc("settle");
  // A new hub gives an empty pair-rate ledger without changing either root's causal level.
  await h.peers[0]!.kill();
  await h.boot("hub");
  await until(
    () => list(a),
    (l) => l.rows?.length === 1,
    "member replay",
  );
  expect(await send(a, bid, "L5 cannot add a sixth hop", true)).toMatchObject({
    effect: "applied",
    wakeDowngraded: "level_limit",
  });
  expect((await b.rpc("inspect")).level).toBe(5);
  await b.rpc("input", { source: "extension" });
  expect((await b.rpc("inspect")).level).toBe(5);
  await b.rpc("input");
  expect((await b.rpc("inspect")).level).toBe(0);
  expect((await a.rpc("inspect")).level).toBe(5);
}, 30_000);
