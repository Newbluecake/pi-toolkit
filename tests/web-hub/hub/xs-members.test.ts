import { describe, expect, it } from "vitest";
import { clampMemberLimits } from "../../../src/web-hub/hub/xs/members.js";
import { LIMITS, memberFrame, rig, session } from "./xs-fixtures.js";

describe("xs members: effective-member validity (phase2 §8.1)", () => {
  it("a connected live record with session + xs_member + xs.v1 cap is effective", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", name: "alpha" });
    const m = r.relay.members.effective(a.key);
    expect(m).toMatchObject({ sessionId: "sess-A", epoch: 1, joined: true, receive: "wake", name: "alpha" });
  });

  it("no xs.v1 in hello caps ⇒ never effective (old peer / xs off)", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", caps: ["ev.v1"] });
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    expect(r.relay.members.effectiveAll()).toEqual([]);
  });

  it("no xs_member frame yet ⇒ not effective", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", skipMember: true });
    expect(r.relay.members.effective(a.key)).toBeUndefined();
  });

  it("session frame with ANOTHER id voids the record; same id keeps it; a fresh xs_member revives", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.registry.onFrame(a.key, session({ sessionId: "sess-A", reason: "reload" }));
    expect(r.relay.members.effective(a.key)).toBeDefined();
    r.registry.onFrame(a.key, session({ sessionId: "sess-B" }));
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    expect(r.relay.members.size()).toBe(0);
    r.registry.onFrame(a.key, memberFrame({ sessionId: "sess-B", epoch: 2 }));
    expect(r.relay.members.effective(a.key)).toMatchObject({ sessionId: "sess-B", epoch: 2 });
  });

  it("session/status are separate frames: an old joined never spills onto the new session", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    // /new: session_detached → session(new id) arrives BEFORE any new xs_member
    r.registry.onFrame(a.key, { t: "session_detached", reason: "new" } as never);
    r.registry.onFrame(a.key, session({ sessionId: "sess-B" }));
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    expect(r.relay.members.effectiveAll()).toEqual([]);
  });

  it("an xs_member whose sessionId disagrees with the record's session is stored but NOT effective", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", skipMember: true });
    r.registry.onFrame(a.key, memberFrame({ sessionId: "sess-OTHER" }));
    expect(r.relay.members.effective(a.key)).toBeUndefined();
  });

  it("session_detached voids immediately (even for the same session id re-attach until a new xs_member)", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.registry.onFrame(a.key, { t: "session_detached", reason: "reload" } as never);
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    r.registry.onFrame(a.key, session({ sessionId: "sess-A" }));
    expect(r.relay.members.effective(a.key)).toBeUndefined(); // still void: only xs_member revives
    r.registry.onFrame(a.key, memberFrame({ sessionId: "sess-A", epoch: 2 }));
    expect(r.relay.members.effective(a.key)).toMatchObject({ epoch: 2 });
  });

  it("socket close (claim window) voids; reclaim by the same agentId stays void until a new xs_member", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.registry.onClose(a.key, false);
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    // reconnect: same agentId ⇒ reclaim (agentKey kept)
    const conn2 = { send: () => {}, close: () => {} };
    r.registry.register(
      {
        t: "hello",
        proto: { major: 1, minor: 0 },
        pluginVersion: "1.2.3",
        buildId: "b",
        agentId: { pid: 1, nonce: `nonce${"1".padStart(15, "0")}` },
        epoch: "e1",
        kind: "tui",
        launcher: ["/usr/bin/node", "/usr/bin/pi"],
        cwd: "/tmp/work",
        caps: ["ev.v1", "xs.v1"],
      },
      conn2,
    );
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    r.registry.onFrame(a.key, memberFrame({ sessionId: "sess-A", epoch: 3 }));
    expect(r.relay.members.effective(a.key)).toMatchObject({ epoch: 3 });
  });

  it("reclaim that drops the xs.v1 cap ⇒ a re-sent xs_member is still not effective", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.registry.onClose(a.key, false);
    r.registry.register(
      {
        t: "hello",
        proto: { major: 1, minor: 0 },
        pluginVersion: "1.2.3",
        buildId: "b",
        agentId: { pid: 1, nonce: `nonce${"1".padStart(15, "0")}` },
        epoch: "e1",
        kind: "tui",
        launcher: ["/usr/bin/node", "/usr/bin/pi"],
        cwd: "/tmp/work",
        caps: ["ev.v1"],
      },
      { send: () => {}, close: () => {} },
    );
    r.registry.onFrame(a.key, memberFrame({ sessionId: "sess-A" }));
    expect(r.relay.members.effective(a.key)).toBeUndefined();
  });

  it("down (bye quit / remove) drops the record for good", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.registry.onFrame(a.key, { t: "bye", reason: "quit" } as never);
    r.registry.onClose(a.key, true);
    expect(r.registry.get(a.key)).toBeUndefined();
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    expect(r.relay.members.size()).toBe(0);
  });

  it("stale phase (claim window elapsed) is not effective", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.registry.onClose(a.key, false);
    r.clock.t += 60 * 60 * 1000;
    r.registry.tick(r.clock.t);
    expect(r.relay.members.effective(a.key)).toBeUndefined();
  });

  it("another agent's record is unaffected by an invalidation", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    const b = r.agent({ pid: 2, sessionId: "sess-B" });
    r.registry.onFrame(a.key, session({ sessionId: "sess-A2" }));
    expect(r.relay.members.effective(a.key)).toBeUndefined();
    expect(r.relay.members.effective(b.key)).toBeDefined();
    expect(r.relay.members.effectiveAll().map((m) => m.agentKey)).toEqual([b.key]);
  });

  it("two agents holding one sessionId are BOTH effective (the router refuses them, XR5)", () => {
    const r = rig();
    r.agent({ pid: 1, sessionId: "dup" });
    r.agent({ pid: 2, sessionId: "dup" });
    expect(r.relay.members.effectiveAll()).toHaveLength(2);
  });

  it("busy comes from the status frame, activity from status/ev frames", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    expect(r.relay.members.effective(a.key)?.busy).toBe(false);
    r.clock.t += 5_000;
    r.registry.onFrame(a.key, { t: "status", leafId: null, busy: true, pending: false });
    const m = r.relay.members.effective(a.key)!;
    expect(m.busy).toBe(true);
    expect(m.activityAt).toBe(r.clock.t);
  });
});

describe("xs members: limits clamping (§4.6)", () => {
  it("clamps every declared limit into the schema bounds; junk falls to the lower bound", () => {
    const c = clampMemberLimits({
      sendsOutPerMin: 9_999,
      sendsOutPerHour: 0,
      wakesOutPerHour: -3,
      pairMinIntervalMs: 1,
      pairWakesPerHour: 1_000,
      inFlightPerSession: Number.NaN,
      listPerMin: "x",
    });
    expect(c).toEqual({
      sendsOutPerMin: 60,
      sendsOutPerHour: 1,
      wakesOutPerHour: 0,
      pairMinIntervalMs: 5_000,
      pairWakesPerHour: 20,
      inFlightPerSession: 1,
      listPerMin: 1,
    });
  });

  it("in-bounds values pass through unchanged", () => {
    expect(clampMemberLimits({ ...LIMITS })).toEqual(LIMITS);
  });
});
