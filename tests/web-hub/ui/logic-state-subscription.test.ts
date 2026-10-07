// @vitest-environment node
/**
 * Main-subscription reducer transitions (web-hub-session-switch plan §1.5 — D2 package,
 * 一般-11: the state-transition table BEFORE the behavior) plus the Major-9 order matrix and
 * the R2-2 rulings (ev/append share history's abandoned + sessionId gating).
 *
 * Every case drives the pure reducer directly — no useHub, no transport — because these are
 * table rows, not effect ordering (that's use-hub.test.ts's "D2 keep-alive" suite).
 */
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";

type Msg = { event: string; data: any; id?: number };
const run = (msgs: Msg[], s = initialState()) => msgs.reduce((acc, m) => reduce(acc, m), s);

const card = (agentKey: string, extra: Record<string, unknown> = {}) => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd: "/tmp/p",
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  session: {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
  },
  prompts: [],
  ...extra,
});

const entry = (id: string, ts: number) => ({
  id,
  parentId: null,
  type: "message",
  timestamp: new Date(ts).toISOString(),
  message: { role: "user", content: `m-${id}`, timestamp: ts },
});

const historyMsg = (extra: Record<string, unknown> = {}) => ({
  event: "history",
  data: {
    agentKey: "A",
    entries: [entry("e1", 1000)],
    tailMessages: [],
    fromSeq: 10,
    hasMore: false,
    source: "file",
    ...extra,
  },
});

/** hello + agents [A] + subscribing + subscribed + history ⇒ A loaded under c1. */
function loaded() {
  return run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("A")] },
    { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    { event: "subscribed", data: { agentKey: "A" } },
    historyMsg(),
  ]);
}
const A = (s: ReturnType<typeof initialState>) => s.agents.get("A")!;
const ev = (seq: number, e: Record<string, unknown>): Msg => ({ event: "ev", data: { agentKey: "A", seq, e } });
const append = (id: string, ts: number): Msg => ({
  event: "append",
  data: { agentKey: "A", entries: [entry(id, ts)] },
});

describe("§1.5 state table — subscribing / subscribed / subscribe_failed / unsubscribed", () => {
  it("subscribing: pending sub, needsResync cleared, history loaded stays loaded else waiting, abandoned cleared", () => {
    const fresh = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    ]);
    expect(A(fresh)).toMatchObject({ sub: { clientId: "c1", pending: true }, history: "waiting", needsResync: false });

    const fromLoaded = reduce(loaded(), { event: "subscribing", data: { agentKey: "A", clientId: "c1" } });
    expect(A(fromLoaded).history).toBe("loaded"); // no skeleton flash on a warm re-subscribe

    // after unsubscribed (abandoned=true), a new attempt clears the flag
    const afterUnsub = run([{ event: "unsubscribed", data: { agentKey: "A" } }], loaded());
    expect(A(afterUnsub).abandoned).toBe(true);
    const resub = reduce(afterUnsub, { event: "subscribing", data: { agentKey: "A", clientId: "c1" } });
    expect(A(resub).abandoned).toBe(false);
    expect(A(resub).history).toBe("waiting"); // unsubscribed reset it to none → waiting again
  });

  it("subscribed: clears pending only when a sub exists (no-op otherwise)", () => {
    const s = reduce(loaded(), { event: "subscribed", data: { agentKey: "A" } });
    expect(A(s).sub).toEqual({ clientId: "c1", pending: false });
    const noSub = reduce(loaded(), { event: "unsubscribed", data: { agentKey: "A" } });
    expect(reduce(noSub, { event: "subscribed", data: { agentKey: "A" } })).toBe(noSub); // no-op ⇒ same state
  });

  it("subscribe_failed: failed sub, history=error, abandoned=true", () => {
    const s = reduce(loaded(), { event: "subscribe_failed", data: { agentKey: "A", error: "E_AGENT_GONE" } });
    expect(A(s)).toMatchObject({
      sub: { clientId: "c1", pending: false, failed: true },
      history: "error",
      historyError: "E_AGENT_GONE",
      abandoned: true,
    });
  });

  it("unsubscribed: sub/history/needsResync/paging reset, abandoned=true, ITEMS RETAINED (D2-9)", () => {
    const s0 = loaded();
    const s = reduce(s0, { event: "unsubscribed", data: { agentKey: "A" } });
    expect(A(s)).toMatchObject({ sub: null, history: "none", needsResync: false, paging: false, abandoned: true });
    expect(A(s).items.map((i) => i.id)).toEqual(A(s0).items.map((i) => i.id));
  });

  it("retry: sub=null + needsResync (existing logic unchanged; abandoned survives until subscribing)", () => {
    const failed = reduce(loaded(), { event: "subscribe_failed", data: { agentKey: "A", error: "x" } });
    const s = reduce(failed, { event: "retry", data: { agentKey: "A" } });
    expect(A(s)).toMatchObject({ sub: null, needsResync: true, abandoned: true }); // no live attempt yet
  });
});

describe("§1.5 state table — hello / gap / resync / session / agents / agent_removed", () => {
  it("hello: sub=null + abandoned=true for sub holders; sub-less agents untouched (same object)", () => {
    const s0 = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A"), card("B")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    ]);
    const s = reduce(s0, { event: "hello", data: { clientId: "c2" } });
    expect(s.clientId).toBe("c2");
    expect(A(s)).toMatchObject({ sub: null, abandoned: true });
    expect(s.agents.get("B")).toBe(s0.agents.get("B")); // never had a sub ⇒ identical object
    expect(A(s).history).toBe("waiting"); // history slot untouched by hello
  });

  it("gap / resync: history≠none ⇒ needsResync=true; needsResync already set stays", () => {
    const s = reduce(loaded(), { event: "gap", data: { agentKey: "A", fromSeq: 12 } });
    expect(A(s).needsResync).toBe(true);
    const s2 = reduce(s, { event: "gap", data: { agentKey: "A", fromSeq: 13 } });
    expect(A(s2)).toBe(A(s)); // idempotent no-op
    const none = run([{ event: "agents", data: [card("A")] }]);
    expect(A(reduce(none, { event: "gap", data: { agentKey: "A" } })).needsResync).toBe(false); // history none
  });

  it("session replacement: transcript cleared, waiting, needsResync=true, sub untouched (existing logic)", () => {
    const s = reduce(loaded(), {
      event: "session",
      data: {
        agentKey: "A",
        session: {
          sessionId: "s2",
          sessionFile: "/tmp/s2.jsonl",
          cwd: "/tmp/p",
          reason: "user",
          leafId: null,
          mode: "tui",
        },
      },
    });
    expect(A(s)).toMatchObject({
      history: "waiting",
      needsResync: true,
      items: [],
      sub: { clientId: "c1", pending: false },
    });
  });

  it("agents / agent_up: subscription fields survive a card merge; agent_removed drops the agent", () => {
    const s0 = loaded();
    const s = reduce(s0, { event: "agent_up", data: { agent: card("A", { state: "live" }) } });
    expect(A(s).sub).toEqual(A(s0).sub);
    expect(A(s).abandoned).toBe(A(s0).abandoned);
    const gone = reduce(s0, { event: "agent_removed", data: { agentKey: "A" } });
    expect(gone.agents.has("A")).toBe(false);
  });
});

describe("§1.5 — history gating (abandoned / sessionId)", () => {
  it("abandoned (unsubscribed) ⇒ a snapshot (and an error snapshot) is dropped wholesale", () => {
    const dropped = run([{ event: "unsubscribed", data: { agentKey: "A" } }], loaded());
    const s = reduce(dropped, historyMsg({ entries: [entry("e9", 9000)] }));
    expect(A(s)).toBe(A(dropped)); // byte-identical — not even a sub.pending touch
    const err = reduce(dropped, historyMsg({ entries: undefined, error: "E_DEADLINE" }));
    expect(A(err)).toBe(A(dropped));
  });

  it("sessionId both present and unequal ⇒ dropped, sub.pending=false, needsResync=true", () => {
    const replaced = reduce(loaded(), {
      event: "session",
      data: {
        agentKey: "A",
        session: {
          sessionId: "s2",
          sessionFile: "/tmp/s2.jsonl",
          cwd: "/tmp/p",
          reason: "user",
          leafId: null,
          mode: "tui",
        },
      },
    });
    const stale = reduce(replaced, historyMsg({ sessionId: "s1" }));
    expect(A(stale).history).toBe("waiting");
    expect(A(stale).items).toHaveLength(0); // old-session entries did NOT land
    expect(A(stale).needsResync).toBe(true);
    expect(A(stale).sub).toEqual({ clientId: "c1", pending: false });
  });

  it("sessionId missing on either side ⇒ applied (compat window, R2-2 residual)", () => {
    const replaced = reduce(loaded(), {
      event: "session",
      data: {
        agentKey: "A",
        session: {
          sessionId: "s2",
          sessionFile: "/tmp/s2.jsonl",
          cwd: "/tmp/p",
          reason: "user",
          leafId: null,
          mode: "tui",
        },
      },
    });
    // frame without sessionId (old hub/agent)
    const noField = reduce(replaced, historyMsg());
    expect(A(noField).history).toBe("loaded");
    // frame WITH it, agent session undefined (no session yet)
    const bare = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [{ ...card("A"), session: undefined }] },
    ]);
    const applied = reduce(bare, historyMsg({ sessionId: "s1" }));
    expect(A(applied).history).toBe("loaded");
  });

  it("matching sessionId ⇒ applied normally", () => {
    const s = reduce(loaded(), historyMsg({ sessionId: "s1" }));
    expect(A(s).history).toBe("loaded");
  });
});

describe("§1.5 — ev / append gating (R2-2)", () => {
  it("R2-2: hello → late ev is dropped (retained transcript unpolluted)", () => {
    const s0 = loaded();
    const helloed = reduce(s0, { event: "hello", data: { clientId: "c2" } });
    const s = reduce(
      helloed,
      ev(10, { type: "message_end", message: { role: "user", content: "late", timestamp: 42 } }),
    );
    expect(A(s).items.map((i) => i.id)).toEqual(A(s0).items.map((i) => i.id));
    expect(A(s).lastSeq).toBe(A(s0).lastSeq);
  });

  it("R2-2: hello → late append is dropped", () => {
    const s0 = loaded();
    const helloed = reduce(s0, { event: "hello", data: { clientId: "c2" } });
    const s = reduce(helloed, append("late1", 9001));
    expect(A(s).items.map((i) => i.id)).toEqual(A(s0).items.map((i) => i.id));
  });

  it("R2-2: session replacement → old append is dropped (transcript stays cleared)", () => {
    const replaced = reduce(loaded(), {
      event: "session",
      data: {
        agentKey: "A",
        session: {
          sessionId: "s2",
          sessionFile: "/tmp/s2.jsonl",
          cwd: "/tmp/p",
          reason: "user",
          leafId: null,
          mode: "tui",
        },
      },
    });
    const s = reduce(replaced, append("old1", 9002));
    expect(A(s).items).toHaveLength(0);
  });

  it("R2-2: a stale-session ev is dropped too (frame carries a differing sessionId)", () => {
    const replaced = reduce(loaded(), {
      event: "session",
      data: {
        agentKey: "A",
        session: {
          sessionId: "s2",
          sessionFile: "/tmp/s2.jsonl",
          cwd: "/tmp/p",
          reason: "user",
          leafId: null,
          mode: "tui",
        },
      },
    });
    const s = reduce(replaced, {
      event: "ev",
      data: {
        agentKey: "A",
        seq: 10,
        sessionId: "s1",
        e: { type: "message_end", message: { role: "user", content: "x", timestamp: 9 } },
      },
    });
    expect(A(s).items).toHaveLength(0);
  });

  it("a healthy ev/append still lands (loaded, not abandoned, session matches)", () => {
    const s = reduce(
      loaded(),
      ev(10, { type: "message_end", message: { role: "user", content: "ok", timestamp: 43 } }),
    );
    expect(A(s).items).toHaveLength(2);
    const s2 = reduce(loaded(), append("a1", 9003));
    expect(A(s2).items.map((i) => i.entryId)).toContain("a1");
  });
});

describe("Major-9 order matrix (session replacement vs history/gap arrival order)", () => {
  const replace: Msg = {
    event: "session",
    data: {
      agentKey: "A",
      session: {
        sessionId: "s2",
        sessionFile: "/tmp/s2.jsonl",
        cwd: "/tmp/p",
        reason: "user",
        leafId: null,
        mode: "tui",
      },
    },
  };

  it("session(replace) → gap → history(new sessionId) ⇒ loaded with the new content", () => {
    const s = run(
      [
        replace,
        { event: "gap", data: { agentKey: "A" } },
        historyMsg({ sessionId: "s2", entries: [entry("n1", 5000)], fromSeq: 3 }),
      ],
      loaded(),
    );
    expect(A(s).history).toBe("loaded");
    expect(A(s).items.map((i) => i.entryId)).toEqual(["n1"]);
    expect(A(s).needsResync).toBe(false);
  });

  it("history → session(replace) ⇒ waiting + needsResync", () => {
    const s = reduce(loaded(), replace);
    expect(A(s)).toMatchObject({ history: "waiting", needsResync: true, items: [] });
  });

  it("session(replace) → old history(old sessionId) ⇒ dropped, pending=false, needsResync=true", () => {
    const s = run([replace, historyMsg({ sessionId: "s1" })], loaded());
    expect(A(s).history).toBe("waiting");
    expect(A(s).items).toHaveLength(0);
    expect(A(s).needsResync).toBe(true);
    expect(A(s).sub).toEqual({ clientId: "c1", pending: false });
  });

  it("agent_down → agent_up → gap ⇒ needsResync (existing gap rules compose)", () => {
    const s = run(
      [
        { event: "agent_down", data: { agentKey: "A", reason: "reap" } },
        { event: "agent_up", data: { agent: card("A") } },
        { event: "gap", data: { agentKey: "A" } },
      ],
      loaded(),
    );
    expect(A(s).needsResync).toBe(true);
  });

  it("hello → (no subscribing) history ⇒ dropped", () => {
    const s = run([{ event: "hello", data: { clientId: "c2" } }, historyMsg({ sessionId: "s1" })], loaded());
    expect(A(s).items).toHaveLength(1); // only the original entry
    expect(A(s).sub).toBeNull();
  });

  it("unsubscribed → history ⇒ dropped (the eviction case)", () => {
    const s = run([{ event: "unsubscribed", data: { agentKey: "A" } }, historyMsg({ sessionId: "s1" })], loaded());
    expect(A(s).history).toBe("none");
    expect(A(s).items).toHaveLength(1); // retained, not replaced
  });

  it("subscribe_failed → old history ⇒ stays error; history → subscribe_failed ⇒ error", () => {
    const failed = reduce(loaded(), { event: "subscribe_failed", data: { agentKey: "A", error: "x" } });
    const s = reduce(failed, historyMsg({ sessionId: "s1" }));
    expect(A(s).history).toBe("error");
    const s2 = reduce(loaded(), { event: "subscribe_failed", data: { agentKey: "A", error: "x" } });
    expect(A(s2).history).toBe("error");
  });

  it("subscribing clears abandoned ⇒ the following history is accepted", () => {
    const s = run(
      [
        { event: "unsubscribed", data: { agentKey: "A" } },
        { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
        historyMsg({ sessionId: "s1", entries: [entry("n2", 6000)] }),
      ],
      loaded(),
    );
    expect(A(s).history).toBe("loaded");
    expect(A(s).items.map((i) => i.entryId)).toEqual(["n2"]);
  });
});
