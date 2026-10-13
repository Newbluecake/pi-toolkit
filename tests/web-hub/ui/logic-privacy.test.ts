/**
 * web-hub-privacy plan v2.1 (P1 测试锚点, UI 数据层): the `privacy` SSE frame reducer —
 * full-set overwrite semantics, `hello`/caps-drop resets, the fail-closed flag
 * (`cap && !ready` ⇒ P2 renders no session detail), and the client-side intersection
 * `lockedSet.has(agent.session?.sessionId)` (`isAgentLocked`).
 */
import { describe, expect, it } from "vitest";
import { initialState, isAgentLocked, privacyFailClosed, reduce } from "../../../src/web-hub/ui/src/logic/state.js";

type Msg = { event: string; data: any; id?: number; at?: number };
const run = (msgs: Msg[], s = initialState()) => msgs.reduce((acc, m) => reduce(acc, m), s);

const HUB_WITH_CAP = { event: "hub", data: { caps: ["cmd.v1", "privacy.v1"] } };
const HUB_NO_CAP = { event: "hub", data: { caps: ["cmd.v1"] } };

const card = (agentKey: string, sessionId: string | null) => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd: "/tmp/p",
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  ...(sessionId === null
    ? {}
    : {
        session: {
          sessionId,
          sessionFile: `/tmp/${sessionId}.jsonl`,
          cwd: "/tmp/p",
          reason: "startup",
          leafId: null,
          mode: "tui",
        },
      }),
  prompts: [],
});

describe("state.js privacy reducer (web-hub-privacy P1)", () => {
  it("initial state: cap off, not ready, empty set — byte-identical pre-feature posture", () => {
    const s = initialState();
    expect(s.privacy).toEqual({ cap: false, ready: false, locked: new Set() });
    expect(privacyFailClosed(s)).toBe(false);
  });

  it("privacy frame: full-set overwrite, ready flips true; malformed frames are dropped", () => {
    let s = run([HUB_WITH_CAP, { event: "privacy", data: { locked: ["s1", "s2"] } }]);
    expect(s.privacy.ready).toBe(true);
    expect([...s.privacy.locked].sort()).toEqual(["s1", "s2"]);
    expect(privacyFailClosed(s)).toBe(false);
    // overwrite (not merge) — the set is a full snapshot
    s = reduce(s, { event: "privacy", data: { locked: ["s3"] } });
    expect([...s.privacy.locked]).toEqual(["s3"]);
    // malformed: ignored wholesale
    for (const bad of [{ locked: "s1" }, { locked: [1] }, {}, null]) {
      expect(reduce(s, { event: "privacy", data: bad })).toBe(s);
    }
  });

  it("no-op ⇒ same-state invariant: an identical frame returns the SAME state object", () => {
    const s = run([HUB_WITH_CAP, { event: "privacy", data: { locked: ["s1"] } }]);
    expect(reduce(s, { event: "privacy", data: { locked: ["s1"] } })).toBe(s);
  });

  it("fail-closed window: cap present but no frame yet ⇒ gated; hub frame dropping the cap resets the whole slot", () => {
    const gated = run([HUB_WITH_CAP]);
    expect(privacyFailClosed(gated)).toBe(true); // cap 在而帧未到
    const ready = reduce(gated, { event: "privacy", data: { locked: [] } });
    expect(privacyFailClosed(ready)).toBe(false);
    // a later hub frame without privacy.v1 (older hub / feature turned off) ⇒ zero lock state
    const off = reduce(ready, HUB_NO_CAP);
    expect(off.privacy).toEqual({ cap: false, ready: false, locked: new Set() });
    expect(privacyFailClosed(off)).toBe(false);
  });

  it("hello (new SSE connection): ready drops back to false and the set clears — the hub re-sends the snapshot before agents", () => {
    const s = run([HUB_WITH_CAP, { event: "privacy", data: { locked: ["s1"] } }]);
    const re = reduce(s, { event: "hello", data: { clientId: "c2" } });
    expect(re.privacy.cap).toBe(true); // cap survives (the hub frame re-confirms it anyway)
    expect(re.privacy.ready).toBe(false);
    expect(re.privacy.locked.size).toBe(0);
    expect(privacyFailClosed(re)).toBe(true);
  });

  it("isAgentLocked: intersects the agent's CURRENT sessionId (/new 换 sessionId 自动正确)", () => {
    let s = run([HUB_WITH_CAP, { event: "privacy", data: { locked: ["s1"] } }]);
    s = reduce(s, { event: "agents", data: { agents: [card("A", "s1"), card("B", "s2"), card("C", null)] } });
    expect(isAgentLocked(s, "A")).toBe(true);
    expect(isAgentLocked(s, "B")).toBe(false);
    expect(isAgentLocked(s, "C")).toBe(false); // no session ⇒ never locked
    expect(isAgentLocked(s, "ghost")).toBe(false);
    // the session moves on (the /new race the 409 E_SESSION_CHANGED guard also covers)
    s = reduce(s, {
      event: "session",
      data: { agentKey: "A", session: { sessionId: "s9", cwd: "/tmp/p", reason: "new", leafId: null, mode: "tui" } },
    });
    expect(isAgentLocked(s, "A")).toBe(false);
  });
});
