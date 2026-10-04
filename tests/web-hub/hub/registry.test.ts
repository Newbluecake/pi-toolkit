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

describe("registry: P2 control-plane additions (plan §3.1/§3.2/§3.5/§6.1, C3)", () => {
  it("hello.caps flow into getCaps(); AgentCard.control/epoch are derived from them", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello({ caps: ["ev.v1", "cmd.v1", "dialog.v1"] }), fakeConn());
    expect(h.reg.getCaps(agentKey)).toEqual(["ev.v1", "cmd.v1", "dialog.v1"]);
    const card = h.reg.get(agentKey)!;
    expect(card.control).toBe(true);
    expect(card.epoch).toBe("epoch-1");
  });

  it("no cmd.v1 ⇒ control:false", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello({ caps: ["ev.v1"] }), fakeConn());
    expect(h.reg.get(agentKey)!.control).toBe(false);
  });

  it("web-hub-upload plan U1 #10: AgentCard.upload/uploadLan are derived from upload.v1/upload.lan.v1 caps", () => {
    const h = harness();
    const full = h.reg.register(hello({ caps: ["ev.v1", "cmd.v1", "upload.v1", "upload.lan.v1"] }), fakeConn());
    expect(h.reg.get(full.agentKey)!.upload).toBe(true);
    expect(h.reg.get(full.agentKey)!.uploadLan).toBe(true);

    const loopbackOnly = h.reg.register(hello({ caps: ["ev.v1", "cmd.v1", "upload.v1"] }), fakeConn());
    expect(h.reg.get(loopbackOnly.agentKey)!.upload).toBe(true);
    expect(h.reg.get(loopbackOnly.agentKey)!.uploadLan).toBe(false);

    const none = h.reg.register(hello({ caps: ["ev.v1", "cmd.v1"] }), fakeConn());
    expect(h.reg.get(none.agentKey)!.upload).toBe(false);
    expect(h.reg.get(none.agentKey)!.uploadLan).toBe(false);
  });

  it("getCaps/getLinkGen return undefined for an unknown agentKey", () => {
    const h = harness();
    expect(h.reg.getCaps("nope")).toBeUndefined();
    expect(h.reg.getLinkGen("nope")).toBeUndefined();
  });

  it("linkGen increments on every register()/reclaim, starting at 1", () => {
    const h = harness();
    const conn1 = fakeConn();
    const { agentKey } = h.reg.register(hello(), conn1);
    expect(h.reg.getLinkGen(agentKey)).toBe(1);
    h.reg.register(hello(), fakeConn()); // reclaim (same agentId, still "live")
    expect(h.reg.getLinkGen(agentKey)).toBe(2);
    h.reg.onClose(agentKey, false);
    h.clock.t += TIMING.detachGraceMs;
    h.reg.tick(h.clock.t);
    h.reg.register(hello(), fakeConn()); // stale → live reclaim
    expect(h.reg.getLinkGen(agentKey)).toBe(3);
  });

  it("reclaim refreshes caps (an agent that upgrades caps on reconnect is picked up)", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello({ caps: ["ev.v1"] }), fakeConn());
    expect(h.reg.getCaps(agentKey)).toEqual(["ev.v1"]);
    h.reg.register(hello({ caps: ["ev.v1", "cmd.v1"] }), fakeConn());
    expect(h.reg.getCaps(agentKey)).toEqual(["ev.v1", "cmd.v1"]);
  });

  it("dialogs/ctl/commands frames update the record and broadcast the matching bus event", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    h.events.length = 0;
    const dialogsFrame = {
      t: "dialogs" as const,
      epoch: "epoch-1",
      open: [
        {
          dialogId: "ask:1",
          source: "ask_user" as const,
          toolCallId: "tc1",
          questions: [{ question: "q?", options: [{ label: "a" }] }],
          allowCancel: true,
          openedAt: 1,
        },
      ],
      closed: [],
    };
    h.reg.onFrame(agentKey, dialogsFrame);
    h.reg.onFrame(agentKey, { t: "ctl", epoch: "epoch-1", sessionId: "s1", items: [] });
    h.reg.onFrame(agentKey, {
      t: "commands",
      epoch: "epoch-1",
      items: [{ name: "session", kind: "builtin", policy: "allow" }],
    });
    expect(types(h.events)).toEqual(["dialogs", "ctl", "commands"]);
    expect(h.events[0]).toMatchObject({ type: "dialogs", agentKey, open: dialogsFrame.open });
    expect(h.reg.get(agentKey)?.dialogs).toEqual({ epoch: "epoch-1", open: dialogsFrame.open, closed: [] });
    // accfix-N2: `commands` must be readable back off the record (mirrors the `dialogs`
    // assertion above) AND survive the `view()`/`card()` snapshot `list()`/`get()` return —
    // that snapshot is exactly what `http.ts`'s `toCard()` copies onto the wire `AgentCard` a
    // freshly-attaching browser tab receives.
    expect(h.reg.get(agentKey)?.commands).toEqual([{ name: "session", kind: "builtin", policy: "allow" }]);
    expect(h.reg.list().find((v) => v.agentKey === agentKey)?.commands).toEqual([
      { name: "session", kind: "builtin", policy: "allow" },
    ]);
  });

  it("cmd_result resolves a matching pending registry.request() by rid", async () => {
    const h = harness();
    const conn = fakeConn();
    const { agentKey } = h.reg.register(hello(), conn);
    const p = h.reg.request(
      agentKey,
      {
        t: "cmd",
        rid: "",
        id: "a".repeat(16),
        deadlineMs: 1000,
        origin: { listener: "loopback", ip: "127.0.0.1", reqId: "r".repeat(16) },
        cmd: { op: "abort" },
      },
      1000,
    );
    const rid = (conn.sent.at(-1) as { rid: string }).rid;
    h.reg.onFrame(agentKey, {
      t: "cmd_result",
      rid,
      id: "a".repeat(16),
      ok: true,
      data: { op: "abort", wasBusy: false },
    });
    await expect(p).resolves.toMatchObject({ ok: true, data: { wasBusy: false } });
  });

  it("a cmd_result whose rid has no pending entry is handed to setLateResultHandler and does not throw or crash", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    const seen: unknown[] = [];
    h.reg.setLateResultHandler((k, frame) => seen.push([k, frame]));
    h.reg.onFrame(agentKey, {
      t: "cmd_result",
      rid: "no-such-rid",
      id: "a".repeat(16),
      ok: true,
      data: { op: "abort", wasBusy: false },
    });
    expect(seen).toEqual([
      [
        agentKey,
        { t: "cmd_result", rid: "no-such-rid", id: "a".repeat(16), ok: true, data: { op: "abort", wasBusy: false } },
      ],
    ]);
  });

  it("cmd_late always goes to setLateResultHandler and publishes a cmd_late bus event", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    h.events.length = 0;
    const seen: unknown[] = [];
    h.reg.setLateResultHandler((k, frame) => seen.push([k, frame]));
    h.reg.onFrame(agentKey, {
      t: "cmd_late",
      id: "a".repeat(16),
      op: "steer_subagent",
      at: 1,
      ok: true,
      data: { op: "steer_subagent" },
    });
    expect(seen).toHaveLength(1);
    expect(types(h.events)).toEqual(["cmd_late"]);
    expect(h.events[0]).toMatchObject({
      type: "cmd_late",
      agentKey,
      id: "a".repeat(16),
      op: "steer_subagent",
      ok: true,
    });
  });

  it("a throwing setLateResultHandler is caught and logged, never crashes onFrame", () => {
    const h = harness();
    const { agentKey } = h.reg.register(hello(), fakeConn());
    h.reg.setLateResultHandler(() => {
      throw new Error("boom");
    });
    expect(() =>
      h.reg.onFrame(agentKey, {
        t: "cmd_late",
        id: "a".repeat(16),
        op: "abort",
        at: 1,
        ok: true,
        data: { op: "abort", wasBusy: false },
      }),
    ).not.toThrow();
  });
});
