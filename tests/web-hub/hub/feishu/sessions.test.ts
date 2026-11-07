import { afterEach, describe, expect, it } from "vitest";
import { cleanupF6, f6Rig, OWNER, OTHER } from "../../../fixtures/feishu/f6.js";
import { createFeishuSessions, feishuBindingKey } from "../../../../src/web-hub/hub/feishu/sessions.js";

afterEach(cleanupF6);
describe("F6 session directory", () => {
  it("keys p2p pointers by chat and group bindings by exact thread", () => {
    expect(feishuBindingKey("p2p", "c", "ignored")).toBe("p2p:c");
    expect(feishuBindingKey("group", "c", "t")).toBe("grp:c:t");
    expect(feishuBindingKey("group", "c")).toBeUndefined();
  });
  it("resolves exactly one live view; duplicate sessionId is always ambiguous", async () => {
    const r = await f6Rig();
    expect(r.sessions.resolve("session-1")).toMatchObject({ ok: true, agentKey: "agent-1" });
    r.live.push({ ...r.live[0]!, agentKey: "second" });
    expect(r.sessions.resolve("session-1")).toEqual({ ok: false, code: "ambiguous" });
    r.live[1]!.live = false;
    expect(r.sessions.resolve("session-1").ok).toBe(true);
    r.live[0]!.live = false;
    expect(r.sessions.resolve("session-1")).toEqual({ ok: false, code: "offline" });
  });
  it("lists live first, then offline bound only, labels and managed modes", async () => {
    const r = await f6Rig();
    r.state.bindings.set("p2p:old", { chatId: "old", chatType: "p2p", sessionId: "offline-2", label: "Old" });
    r.managed.push({ sessionId: "offline-2", cwd: "/work/old" }, { sessionId: "unbound-offline", cwd: "/hidden" });
    expect(r.sessions.rows()).toEqual([
      { sessionId: "session-1", cwd: "/repo", name: "One", label: "One · sessio", state: "idle", mode: "tui" },
      {
        sessionId: "offline-2",
        cwd: "/work/old",
        name: "Old",
        label: "Old · offlin",
        state: "offline",
        mode: "managed",
      },
    ]);
  });
  it("numeric selection is generation-bound and sender-specific, never uses current sort", async () => {
    const r = await f6Rig();
    r.sessions.list("chat", OWNER);
    r.live.unshift({ ...r.live[0]!, sessionId: "aaa", name: "AAA", agentKey: "a" });
    expect(r.sessions.select("chat", OWNER, "1")).toMatchObject({ ok: true, row: { sessionId: "session-1" } });
    expect(r.sessions.select("chat", OTHER, "1")).toEqual({ ok: false, code: "list-expired" });
    r.clock.advance(600_000);
    expect(r.sessions.select("chat", OWNER, "1")).toEqual({ ok: false, code: "list-expired" });
  });
  it("supports exact name/id/prefix and refuses ambiguous matches", async () => {
    const r = await f6Rig();
    expect(r.sessions.select("chat", OWNER, "One")).toMatchObject({ ok: true });
    expect(r.sessions.select("chat", OWNER, "sess")).toMatchObject({ ok: true });
    r.live.push({ ...r.live[0]!, sessionId: "session-2", agentKey: "other" });
    expect(r.sessions.select("chat", OWNER, "sess")).toEqual({ ok: false, code: "ambiguous" });
    expect(r.sessions.select("chat", OWNER, "One")).toEqual({ ok: false, code: "ambiguous" });
    expect(r.sessions.select("chat", OWNER, "session-1")).toMatchObject({ ok: true });
    expect(r.sessions.select("chat", OWNER, "nothing")).toEqual({ ok: false, code: "not-found" });
  });
  it("refuses a stale generation whose selected session became ambiguous", async () => {
    const r = await f6Rig();
    r.sessions.list("chat", OWNER);
    r.live.push({ ...r.live[0]!, agentKey: "second" });
    expect(r.sessions.select("chat", OWNER, "1")).toEqual({ ok: false, code: "ambiguous" });
  });
  it("bounds generations at four per chat without evicting selections; TTL reclaims", async () => {
    const r = await f6Rig();
    for (let i = 0; i < 4; i++) expect(r.sessions.list("chat", OWNER).ok).toBe(true);
    expect(r.sessions.list("chat", OWNER)).toEqual({ ok: false, code: "cap" });
    r.clock.advance(600_000);
    expect(r.sessions.list("chat", OWNER).ok).toBe(true);
    r.sessions.clear();
    expect(r.sessions.select("chat", OWNER, "1")).toEqual({ ok: false, code: "list-expired" });
  });
});

describe("F6 session directory × xs alias", () => {
  const mk = (alias?: (sid: string) => string | undefined) => {
    const views = ["a", "b", "c"].map((id) => ({
      sessionId: `sid-${id}00000`,
      agentKey: `k-${id}`,
      cwd: "/repo",
      name: id === "c" ? "A" : `n-${id}`,
      live: true,
      mode: "tui" as const,
      state: "idle" as const,
    }));
    return createFeishuSessions({
      views: () => views,
      managed: () => [],
      bindings: () => [],
      ...(alias === undefined ? {} : { alias }),
    });
  };
  const aliases: Record<string, string> = { "sid-a00000": "reviewer", "sid-b00000": "builder" };
  it("rows carry alias only when held; xs off (no port) ⇒ no alias key, selector behaves as before", () => {
    const withAlias = mk((sid) => aliases[sid]).rows();
    expect(withAlias.find((r) => r.sessionId === "sid-a00000")?.alias).toBe("reviewer");
    expect("alias" in withAlias.find((r) => r.sessionId === "sid-c00000")!).toBe(false);
    const off = mk().rows();
    expect(off.every((r) => !("alias" in r))).toBe(true);
    expect(mk().select("chat", "u", "@reviewer")).toEqual({ ok: false, code: "not-found" });
    expect(mk().select("chat", "u", "sid-")).toEqual({ ok: false, code: "ambiguous" });
  });
  it("select by @alias / bare alias (case-insensitive), alias wins over name, sid prefix still works", () => {
    const s = mk((sid) => aliases[sid]);
    expect(s.select("chat", "u", "@reviewer")).toMatchObject({ ok: true, row: { sessionId: "sid-a00000" } });
    expect(s.select("chat", "u", "Builder")).toMatchObject({ ok: true, row: { sessionId: "sid-b00000" } });
    expect(s.select("chat", "u", "@nobody")).toEqual({ ok: false, code: "not-found" });
    expect(s.select("chat", "u", "sid-b0")).toMatchObject({ ok: true, row: { sessionId: "sid-b00000" } });
    // "A" is both session c's name and (lowercased) not an alias ⇒ falls through to name match
    expect(s.select("chat", "u", "A")).toMatchObject({ ok: true, row: { sessionId: "sid-c00000" } });
  });
  it("an alias on a duplicated live session stays ambiguous", () => {
    const view = {
      sessionId: "s1",
      agentKey: "k1",
      cwd: "/r",
      name: "x",
      live: true,
      mode: "tui" as const,
      state: "idle" as const,
    };
    const s = createFeishuSessions({
      views: () => [view, { ...view, agentKey: "k2" }],
      managed: () => [],
      bindings: () => [],
      alias: () => "dup",
    });
    expect(s.select("chat", "u", "@dup")).toEqual({ ok: false, code: "ambiguous" });
  });
});
