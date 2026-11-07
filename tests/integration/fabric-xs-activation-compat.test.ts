import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, list, send, until } from "./helpers/fabric-xs-harness.js";

/**
 * fabric-xs-activation P5 — MIXED-VERSION COMPATIBILITY (plan §3 P5 / §6.3, I10 append-only wire): old/new hub ×
 * old/new agent over a REAL hub child process and two real activate()-built stacks. Scope: wire/byte
 * compatibility of the cross-session send path only. It complements — and is unrelated to — the extension
 * tool-surface suite `fabric-xs-activation.test.ts` (activate() registration) and the end-to-end wake_session suite
 * `fabric-xs-activate-session.test.ts`.
 *
 * "old" is produced by the helper's test-only knobs (committed default = activation ON on both sides):
 *   agent: XW_ACTIVATION_OFF (config off) / XW_STRIP_STATE (wire-only: hides xs.state.v1/xs.activate.v1 caps)
 *   hub:   XW_HUB_ACTIVATION_OFF (config key absent) / XW_HUB_STRIP_STATE (wire-only)
 * Anchor: the old/old frame is the pre-feature byte shape; every other old-side combination must reproduce it.
 */
let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 30_000);

interface Combo {
  name: string;
  hub: Record<string, string>;
  agent: Record<string, string>;
  tracked: boolean;
}
const COMBOS: Combo[] = [
  {
    name: "old hub × old agent",
    hub: { XW_HUB_ACTIVATION_OFF: "1" },
    agent: { XW_ACTIVATION_OFF: "1" },
    tracked: false,
  },
  { name: "old hub × new agent", hub: { XW_HUB_ACTIVATION_OFF: "1" }, agent: {}, tracked: false },
  { name: "new hub × old agent", hub: {}, agent: { XW_ACTIVATION_OFF: "1" }, tracked: false },
  {
    name: "new hub (state caps hidden on wire) × new agent",
    hub: { XW_HUB_STRIP_STATE: "1" },
    agent: {},
    tracked: false,
  },
  {
    name: "new hub × new agent (state caps hidden by agents)",
    hub: {},
    agent: { XW_STRIP_STATE: "1" },
    tracked: false,
  },
  { name: "new hub × new agent", hub: {}, agent: {}, tracked: true },
];

async function observe(c: Combo) {
  h = new XsHarness();
  await h.boot("hub", "hub", undefined, true, false, c.hub);
  const a = await h.boot("agent", "alpha", undefined, true, false, c.agent);
  const b = await h.boot("agent", "beta", undefined, true, false, c.agent);
  await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
  const bid = (await b.rpc("inspect")).sessionId as string;
  await until(
    () => list(a),
    (l) => l.rows?.some((r: any) => bid.startsWith(r.ref)),
    "membership publish",
  );
  const outcome = await send(a, bid, "COMPAT-BODY", false);
  const hub = h.peers[0]!;
  const { deliveries } = await hub.rpc("inspect");
  const frame = deliveries.at(-1)!.frame as Record<string, unknown>;
  const received = ((await b.rpc("inspect")).messages as Array<{ content: string }>).filter((m) =>
    m.content.includes("COMPAT-BODY"),
  );
  await h.close();
  return { outcome, frameKeys: Object.keys(frame), frame, received: received.length };
}

describe("fabric-xs-activation mixed versions (I10)", () => {
  it("every combination delivers the body once; only new×new×new adds tracking, and old-side combos stay on the legacy byte shape", async () => {
    const results: Array<Awaited<ReturnType<typeof observe>>> = [];
    for (const c of COMBOS) results.push(await observe(c));
    const base = results[0]!;
    expect(base.outcome).toMatchObject({ effect: "applied" });
    expect(base.outcome.track).toBeUndefined();
    COMBOS.forEach((c, i) => {
      const r = results[i]!;
      expect(r.received, `${c.name}: body delivered exactly once`).toBe(1);
      expect(r.outcome, c.name).toMatchObject({ effect: "applied" });
      if (!c.tracked) {
        expect(r.outcome.track, `${c.name}: no invented track`).toBeUndefined();
        expect(r.outcome.progress, `${c.name}: no invented progress`).toBeUndefined();
        // legacy byte shape: same top-level keys in the same order as the pre-feature anchor
        expect(r.frameKeys, `${c.name}: xs_deliver key set/order`).toEqual(base.frameKeys);
      } else {
        expect(r.outcome.track).toMatchObject({ messageId: expect.any(String) });
        // append-only: every legacy key still present, in the original relative order
        const legacy = base.frameKeys;
        expect(r.frameKeys.filter((k) => legacy.includes(k))).toEqual(legacy);
      }
    });
  }, 120_000);
});
