import { describe, expect, it } from "vitest";
import { TIMING, type AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import { createRegistry, HubError, type Registry } from "../../../src/web-hub/hub/registry.js";
import { fakeConn, hello, memLog, recordBus } from "./helpers.js";

interface Harness {
  reg: Registry;
  events: HubEvent[];
  clock: { t: number };
  alive: Set<number>;
}

function harness(hubVersion?: string): Harness {
  const clock = { t: 1_000_000 };
  const alive = new Set<number>([4242, 5151]);
  const reg = createRegistry({
    now: () => clock.t,
    log: memLog(),
    pidAlive: (pid) => alive.has(pid),
    ...(hubVersion === undefined ? {} : { hubVersion }),
  });
  return { reg, events: recordBus(reg), clock, alive };
}

const types = (events: HubEvent[]): string[] => events.map((e) => e.type);

const session = (over: Partial<Extract<AgentFrame, { t: "session" }>> = {}): AgentFrame => ({
  t: "session",
  sessionId: "s1",
  sessionFile: "/tmp/s1.jsonl",
  cwd: "/tmp/work",
  reason: "startup",
  leafId: "L1",
  mode: "tui",
  ...over,
});

describe("registry state matrix", () => {
  type Step =
    | { do: "close"; bye?: string }
    | { do: "advance"; ms: number }
    | { do: "reconnect"; epoch?: string }
    | { do: "kill" };
  const rows: Array<{
    name: string;
    steps: Step[];
    state: "live" | "stale" | "down";
    events: string[]; // bus events after the initial agent_up
  }> = [
    { name: "live → close w/o bye → claiming (silent)", steps: [{ do: "close" }], state: "live", events: [] },
    {
      name: "claiming → detachGraceMs → stale",
      steps: [{ do: "close" }, { do: "advance", ms: TIMING.detachGraceMs }],
      state: "stale",
      events: ["agent_stale"],
    },
    {
      name: "stale → reapMs since disconnect → down",
      steps: [{ do: "close" }, { do: "advance", ms: TIMING.detachGraceMs }, { do: "advance", ms: TIMING.reapMs }],
      state: "down",
      events: ["agent_stale", "agent_down"],
    },
    {
      name: "stale → same agentId reconnects → live, agentKey kept (agent_up)",
      steps: [{ do: "close" }, { do: "advance", ms: TIMING.detachGraceMs }, { do: "reconnect" }],
      state: "live",
      events: ["agent_stale", "agent_up"],
    },
    {
      name: "bye{quit} → down immediately",
      steps: [{ do: "close", bye: "quit" }],
      state: "down",
      events: ["agent_down"],
    },
    {
      name: "bye{detach-timeout} → down immediately",
      steps: [{ do: "close", bye: "detach-timeout" }],
      state: "down",
      events: ["agent_down"],
    },
    {
      name: "bye{handover} → claim window, same epoch reconnect ⇒ zero bus events",
      steps: [{ do: "close", bye: "handover" }, { do: "advance", ms: 5_000 }, { do: "reconnect" }],
      state: "live",
      events: [],
    },
    {
      name: "bye{handover} → reconnect with new epoch ⇒ only gap",
      steps: [
        { do: "close", bye: "handover" },
        { do: "reconnect", epoch: "epoch-2" },
      ],
      state: "live",
      events: ["gap"],
    },
    {
      name: "bye{handover} → window expires ⇒ agent_stale",
      steps: [
        { do: "close", bye: "handover" },
        { do: "advance", ms: TIMING.detachGraceMs },
      ],
      state: "stale",
      events: ["agent_stale"],
    },
    { name: "pidAlive=false → next tick down (live)", steps: [{ do: "kill" }], state: "down", events: ["agent_down"] },
    {
      name: "pidAlive=false → next tick down (claiming)",
      steps: [{ do: "close" }, { do: "kill" }],
      state: "down",
      events: ["agent_down"],
    },
  ];

  it.each(rows)("$name", ({ steps, state, events }) => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    h.events.length = 0;
    for (const s of steps) {
      switch (s.do) {
        case "close":
          if (s.bye !== undefined) h.reg.onFrame(agentKey, { t: "bye", reason: s.bye });
          h.reg.onClose(agentKey, s.bye !== undefined);
          break;
        case "advance":
          h.clock.t += s.ms;
          h.reg.tick(h.clock.t);
          break;
        case "reconnect": {
          const r = h.reg.register(hello(s.epoch === undefined ? {} : { epoch: s.epoch }), fakeConn());
          expect(r).toEqual({ agentKey, reclaimed: true });
          break;
        }
        case "kill":
          h.alive.delete(4242);
          h.reg.tick(h.clock.t);
          break;
      }
    }
    const v = h.reg.get(agentKey);
    expect(v === undefined ? "down" : v.state).toBe(state);
    expect(types(h.events)).toEqual(events);
    if (state === "down") expect(h.reg.list()).toHaveLength(0);
  });
});

describe("registry register / frames", () => {
  it("agentKey = a<pid>-<nonce[0..6]>; distinct agentIds get distinct records", () => {
    const h = harness();
    const a = h.reg.register(hello(), fakeConn());
    const b = h.reg.register(hello({ agentId: { pid: 5151, nonce: "otherNonceBBBBBBBBBB" } }), fakeConn());
    expect(a).toEqual({ agentKey: "a4242-nonceA", reclaimed: false });
    expect(b.agentKey).toBe("a5151-otherN");
    expect(h.reg.list().map((v) => v.agentKey)).toEqual(["a4242-nonceA", "a5151-otherN"]);
    expect(types(h.events)).toEqual(["agent_up", "agent_up"]);
    const up = h.events[0];
    expect(up?.type === "agent_up" && up.agent).toMatchObject({
      agentKey: "a4242-nonceA",
      kind: "tui",
      pid: 4242,
      state: "live",
      outdated: false,
      prompts: [],
    });
  });

  it("reclaiming while the old connection is still open closes the old conn silently", () => {
    const h = harness();
    const c1 = fakeConn();
    const { agentKey } = h.reg.register(hello(), c1);
    h.events.length = 0;
    const c2 = fakeConn();
    expect(h.reg.register(hello(), c2)).toEqual({ agentKey, reclaimed: true });
    expect(c1.closedWith).toEqual(["reclaimed"]);
    expect(h.events).toEqual([]);
  });

  it("outdated = agent plugin older than the hub", () => {
    const h = harness("2.0.0");
    const { agentKey } = h.reg.register(hello({ pluginVersion: "1.9.9" }), fakeConn());
    expect(h.reg.get(agentKey)?.outdated).toBe(true);
    const b = h.reg.register(
      hello({ agentId: { pid: 5151, nonce: "otherNonceBBBBBBBBBB" }, pluginVersion: "2.0.0" }),
      fakeConn(),
    );
    expect(h.reg.get(b.agentKey)?.outdated).toBe(false);
  });

  it("session/status/fleet/ev/gap update the record and are broadcast; re-sent session adds gap", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    h.events.length = 0;
    h.reg.onFrame(agentKey, session());
    h.reg.onFrame(agentKey, { t: "status", leafId: "L1", busy: true, pending: false, costUsd: 0.5 });
    h.reg.onFrame(agentKey, {
      t: "fleet",
      runs: [
        {
          runId: "r1",
          status: "running",
          phaseLabel: "x",
          elapsedMs: 1,
          phaseMs: 1,
          highlight: "none",
          terminal: false,
        },
      ],
    });
    h.reg.onFrame(agentKey, { t: "ev", seq: 7, e: { type: "turn_start" } });
    h.reg.onFrame(agentKey, { t: "gap", fromSeq: 3 });
    h.reg.onFrame(agentKey, session({ sessionId: "s2", sessionFile: "/tmp/s2.jsonl", reason: "new" }));
    expect(types(h.events)).toEqual(["session", "status", "fleet", "ev", "gap", "session", "gap"]);
    const v = h.reg.get(agentKey)!;
    expect(v.session).toMatchObject({ sessionId: "s2", sessionFile: "/tmp/s2.jsonl" });
    expect(v.status).toMatchObject({ busy: true, costUsd: 0.5 });
    expect(v.seq).toBe(7);
    expect(h.events[4]).toEqual({ type: "gap", agentKey, fromSeq: 3 });
    expect(h.events[6]).toEqual({ type: "gap", agentKey, fromSeq: 8 });
  });

  it("ui_prompt_start/end maintain prompts (nested, paired) and broadcast prompt", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    h.events.length = 0;
    h.reg.onFrame(agentKey, { t: "ev", seq: 1, e: { type: "ui_prompt_start", kind: "select", title: "Pick" } });
    h.reg.onFrame(agentKey, { t: "ev", seq: 2, e: { type: "ui_prompt_start", kind: "custom" } });
    expect(h.reg.get(agentKey)?.prompts.map((p) => p.kind)).toEqual(["select", "custom"]);
    expect(h.reg.get(agentKey)?.prompts[0]).toEqual({ kind: "select", title: "Pick", since: h.clock.t });
    h.reg.onFrame(agentKey, { t: "ev", seq: 3, e: { type: "ui_prompt_end", kind: "custom" } });
    expect(h.reg.get(agentKey)?.prompts.map((p) => p.kind)).toEqual(["select"]);
    h.reg.onFrame(agentKey, { t: "ev", seq: 4, e: { type: "ui_prompt_end", kind: "select" } });
    expect(h.reg.get(agentKey)?.prompts).toEqual([]);
    expect(types(h.events)).toEqual(["ev", "prompt", "ev", "prompt", "ev", "prompt", "ev", "prompt"]);
  });

  it("frames for unknown agentKeys are ignored", () => {
    const h = harness();
    h.reg.onFrame("nope", session());
    h.reg.onClose("nope", false);
    expect(h.events).toEqual([]);
  });

  it("a throwing bus listener does not break others", () => {
    const h = harness();
    h.reg.bus.subscribe(() => {
      throw new Error("boom");
    });
    const seen: string[] = [];
    h.reg.bus.subscribe((e) => seen.push(e.type));
    h.reg.register(hello(), fakeConn());
    expect(seen).toEqual(["agent_up"]);
  });

  it("publish() lets hub-internal producers use the bus", () => {
    const h = harness();
    h.reg.publish({ type: "append", agentKey: "k", entries: [] });
    expect(types(h.events)).toEqual(["append"]);
  });
});

describe("registry.request", () => {
  it("assigns rids, resolves on the matching reply", async () => {
    const h = harness();
    const conn = fakeConn();
    const { agentKey } = h.reg.register(hello(), conn);
    const p = h.reg.request(agentKey, { t: "branch_req", rid: "", maxBytes: 10 }, 1000);
    const sent = conn.sent.at(-1) as { t: string; rid: string };
    expect(sent.t).toBe("branch_req");
    expect(sent.rid).toMatch(/^r\d+$/);
    h.reg.onFrame(agentKey, { t: "branch_reply", rid: "wrong", entries: [], truncated: false });
    h.reg.onFrame(agentKey, { t: "branch_reply", rid: sent.rid, entries: [], truncated: true });
    await expect(p).resolves.toMatchObject({ t: "branch_reply", truncated: true });
  });

  it("rejects E_DEADLINE on timeout", async () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    const p = h.reg.request(agentKey, { t: "snapshot_req", rid: "" }, 20);
    await expect(p).rejects.toMatchObject({ code: "E_DEADLINE" });
    await expect(p).rejects.toBeInstanceOf(HubError);
  });

  it("rejects E_AGENT_GONE when the connection closes, and when no connection exists", async () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    const p = h.reg.request(agentKey, { t: "snapshot_req", rid: "" }, 5000);
    h.reg.onClose(agentKey, false);
    await expect(p).rejects.toMatchObject({ code: "E_AGENT_GONE" });
    await expect(h.reg.request(agentKey, { t: "snapshot_req", rid: "" }, 5000)).rejects.toMatchObject({
      code: "E_AGENT_GONE",
    });
    await expect(h.reg.request("missing", { t: "snapshot_req", rid: "" }, 5000)).rejects.toMatchObject({
      code: "E_AGENT_GONE",
    });
  });

  it("a reclaim rejects requests pending on the old connection", async () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    const p = h.reg.request(agentKey, { t: "snapshot_req", rid: "" }, 5000);
    h.reg.register(hello({ epoch: "epoch-2" }), fakeConn());
    await expect(p).rejects.toMatchObject({ code: "E_AGENT_GONE" });
  });

  it("snapshot_reply prompts overwrite the record's prompts", async () => {
    const h = harness();
    const conn = fakeConn();
    const { agentKey } = h.reg.register(hello(), conn);
    const p = h.reg.request(agentKey, { t: "snapshot_req", rid: "" }, 1000);
    const rid = (conn.sent.at(-1) as { rid: string }).rid;
    h.reg.onFrame(agentKey, {
      t: "snapshot_reply",
      rid,
      seq: 9,
      leafId: null,
      recent: [],
      prompts: [{ kind: "select", since: 1 }],
      status: { leafId: null, busy: false, pending: false },
      fleet: [],
    });
    await p;
    expect(h.reg.get(agentKey)?.prompts).toEqual([{ kind: "select", since: 1 }]);
    expect(h.reg.get(agentKey)?.seq).toBe(9);
  });
});
