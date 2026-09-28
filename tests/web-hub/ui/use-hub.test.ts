// @vitest-environment node
import { describe, expect, it } from "vitest";
import { useHub } from "../../../src/web-hub/ui/src/composables/useHub.js";
import type { CmdOutcome, HubTransport, Result, TransportHooks } from "../../../src/web-hub/ui/src/transport/types.js";

/** Deterministic fake timer queue (see render-gate.test.ts for the same shape). */
function fakeClock() {
  // Start at a realistic-looking epoch millisecond value — real `Date.now()` is always far
  // larger than any `resyncMinIntervalMs`, so starting at 0 would make the very first subscribe
  // attempt in a test spuriously look rate-limited (`0 + resyncMinIntervalMs - 0 > 0`), a purely
  // fake-clock artifact `useHub`'s real callers never hit.
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number): void => void timers.delete(id),
    pending: () => timers.size,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

/** Always-visible fake doc/win (renderGate hidden-page behavior has its own dedicated suite). */
function alwaysVisible() {
  return {
    doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
    win: { addEventListener: () => {}, removeEventListener: () => {} },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type Call = { method: string; args: unknown[] };

function fakeTransport() {
  const calls: Call[] = [];
  let hooksRef: TransportHooks | undefined;
  let subscribeResult: { ok: boolean; error?: string } = { ok: true };
  let pageResult: Result<{ entries: unknown[]; hasMore: boolean; oldestEntryId?: string }> = {
    ok: true,
    data: { entries: [], hasMore: false },
  };
  let commandResult: CmdOutcome = { ok: true, data: {} };
  let dialogResult: CmdOutcome = { ok: true, data: {} };

  const transport: HubTransport = {
    mode: "token",
    start: async () => void calls.push({ method: "start", args: [] }),
    close: () => calls.push({ method: "close", args: [] }),
    subscribe: async (clientId, agentKey) => {
      calls.push({ method: "subscribe", args: [clientId, agentKey] });
      return subscribeResult;
    },
    unsubscribe: async (clientId, agentKey) => {
      calls.push({ method: "unsubscribe", args: [clientId, agentKey] });
    },
    page: async (agentKey, before, limit) => {
      calls.push({ method: "page", args: [agentKey, before, limit] });
      return pageResult as Result<unknown>;
    },
    command: async (req) => {
      calls.push({ method: "command", args: [req] });
      return commandResult;
    },
    dialog: async (req) => {
      calls.push({ method: "dialog", args: [req] });
      return dialogResult;
    },
  };

  return {
    calls,
    setSubscribeResult: (r: { ok: boolean; error?: string }) => (subscribeResult = r),
    setPageResult: (r: typeof pageResult) => (pageResult = r),
    setCommandResult: (r: CmdOutcome) => (commandResult = r),
    setDialogResult: (r: CmdOutcome) => (dialogResult = r),
    hooks: () => hooksRef!,
    createTransport: (hooks: TransportHooks): HubTransport => {
      hooksRef = hooks;
      return transport;
    },
  };
}

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

describe("useHub (vue-plan.md v2.1 §3.3, §5.2 — P1): dispatch, subscribe effects, routing, paging", () => {
  it("dispatch feeds the reducer and commits to state (via renderGate, dedup'd to the next microtask)", async () => {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    expect(hub.state.value.order).toEqual([]); // not committed yet — still pending the microtask
    await flush();
    expect(hub.state.value.order).toEqual(["A"]);
    expect(hub.state.value.selected).toBe("A");
    hub.dispose();
  });

  it("subscribe effect: selecting the auto-picked agent subscribes it exactly once, and clears the pending flag once the transport resolves", async () => {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    await flush();
    expect(t.calls.filter((c) => c.method === "subscribe")).toEqual([{ method: "subscribe", args: ["c1", "A"] }]);
    expect(hub.state.value.agents.get("A")?.sub).toEqual({ clientId: "c1", pending: false });
    hub.dispose();
  });

  it("route (§3.7 deep link source of truth): selecting a different agent unsubscribes the old one and subscribes the new one, rate-limited", async () => {
    const clock = fakeClock();
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      resyncMinIntervalMs: 2_000,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A"), card("B")] });
    await flush();
    hub.dispatch({ event: "subscribed", data: { agentKey: "A" } });
    await flush();
    t.calls.length = 0;

    hub.dispatch({ event: "route", data: { agentKey: "B" } });
    await flush();
    expect(hub.state.value.selected).toBe("B");
    expect(t.calls).toEqual([
      { method: "unsubscribe", args: ["c1", "A"] },
      { method: "subscribe", args: ["c1", "B"] },
    ]);

    // Routing straight back to A within the resync window doesn't storm /api/subscribe — it waits.
    t.calls.length = 0;
    hub.dispatch({ event: "subscribed", data: { agentKey: "B" } });
    await flush();
    hub.dispatch({ event: "route", data: { agentKey: "A" } });
    await flush();
    expect(t.calls.some((c) => c.method === "subscribe")).toBe(false);
    clock.advance(2_000);
    expect(t.calls.filter((c) => c.method === "subscribe")).toEqual([{ method: "subscribe", args: ["c1", "A"] }]);
    hub.dispose();
  });

  it("route to a key not (yet) in agents clears selection without ever calling subscribe for it", async () => {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "route", data: { agentKey: "ghost" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    await flush();
    expect(hub.state.value.selected).toBeNull();
    expect(t.calls.some((c) => c.method === "subscribe")).toBe(false);
    hub.dispose();
  });

  it("subscribe_failed surfaces as history=error without an automatic retry loop", async () => {
    const t = fakeTransport();
    t.setSubscribeResult({ ok: false, error: "E_AGENT_GONE" });
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    await flush();
    expect(hub.state.value.agents.get("A")?.history).toBe("error");
    expect(t.calls.filter((c) => c.method === "subscribe")).toHaveLength(1); // no storm of retries
    hub.dispose();
  });

  it("loadOlder(): pages the oldest boundary, prepends the result, and is a no-op without hasMore", async () => {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    await flush();
    hub.dispatch({ event: "subscribed", data: { agentKey: "A" } });
    hub.dispatch({
      event: "history",
      data: {
        agentKey: "A",
        entries: [
          {
            id: "e1",
            parentId: null,
            type: "message",
            timestamp: "t",
            message: { role: "user", content: "hi", timestamp: 1 },
          },
        ],
        tailMessages: [],
        fromSeq: 1,
        hasMore: true,
        oldestEntryId: "e1",
        source: "file",
      },
    });
    await flush();

    // no-op: unknown agent
    hub.loadOlder("nope");
    await flush();
    expect(t.calls.some((c) => c.method === "page")).toBe(false);

    t.setPageResult({
      ok: true,
      data: {
        entries: [
          {
            id: "e0",
            parentId: null,
            type: "message",
            timestamp: "t",
            message: { role: "user", content: "older", timestamp: 0 },
          },
        ],
        hasMore: false,
        oldestEntryId: "e0",
      },
    });
    hub.loadOlder("A");
    expect(hub.state.value.agents.get("A")?.paging).toBe(false); // still pending the microtask commit
    await flush();
    expect(t.calls.filter((c) => c.method === "page")).toEqual([{ method: "page", args: ["A", "e1", undefined] }]);
    expect(hub.state.value.agents.get("A")?.paging).toBe(false);
    expect(hub.state.value.agents.get("A")?.hasMore).toBe(false);
    expect(hub.state.value.agents.get("A")?.items.map((i) => i.entryId)).toEqual(["e0", "e1"]);

    // no-op now: hasMore is false
    t.calls.length = 0;
    hub.loadOlder("A");
    await flush();
    expect(t.calls).toEqual([]);
    hub.dispose();
  });

  it("loadOlder() page_failed keeps items intact and clears the paging flag", async () => {
    const t = fakeTransport();
    t.setPageResult({ ok: false, error: "E_DEADLINE" } as never);
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    hub.dispatch({ event: "subscribed", data: { agentKey: "A" } });
    hub.dispatch({
      event: "history",
      data: {
        agentKey: "A",
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: true,
        oldestEntryId: "e1",
        source: "file",
      },
    });
    await flush();
    hub.loadOlder("A");
    await flush();
    expect(hub.state.value.agents.get("A")?.paging).toBe(false);
    hub.dispose();
  });

  it("dispose(): closes the transport, and further inbound messages are ignored", async () => {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    await flush();
    hub.dispose();
    expect(t.calls.filter((c) => c.method === "close")).toHaveLength(1);
    const before = hub.state.value;
    t.hooks().onMessage({ event: "agents", data: [card("A")] });
    await flush();
    expect(hub.state.value).toBe(before); // dispatch() is inert once disposed
  });

  it("onConn hook feeds a 'conn' event into the reducer", async () => {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    t.hooks().onConn("open");
    await flush();
    expect(hub.state.value.conn).toBe("open");
    hub.dispose();
  });
});

// ---------------------------------------------------------------------------
// control plane (control-plan v2.1 §7.1/§7.7, package C4)
// ---------------------------------------------------------------------------

describe("useHub — control plane (§7.1/§7.7)", () => {
  function make() {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    return { t, hub };
  }
  const pendingOf = (hub: ReturnType<typeof make>["hub"], id: string) =>
    (hub.state.value.agents.get("A")?.pendingCtl as Array<Record<string, unknown>> | undefined)?.find(
      (i) => i.id === id,
    );

  it("control.sendPrompt: optimistic ctl_send lands in state; D21 expect.sessionId comes from the agent's session", async () => {
    const { t, hub } = make();
    const p = hub.control!.sendPrompt("A", "hello", "steer");
    await flush();
    const outcome = await p;
    expect(outcome).toEqual({ ok: true, data: {} });
    const req = t.calls.find((c) => c.method === "command")!.args[0] as Record<string, unknown>;
    expect(req).toMatchObject({ agentKey: "A", op: "prompt", text: "hello", deliver: "steer" });
    expect(req.expect).toEqual({ sessionId: "s1" }); // card("A")'s session.sessionId — D21 (§7.7)
    const item = pendingOf(hub, String(req.id));
    // prompt ok without a delivery ⇒ unobserved (§7.3: afterwards the ctl slot drives progress)
    expect(item).toMatchObject({ state: "unobserved" });
    hub.dispose();
  });

  it("unknown outcome ⇒ exactly ONE automatic queryOnly while the agent is live (§3.5), never a re-execution", async () => {
    const { t, hub } = make();
    t.setCommandResult({ ok: false, error: "E_DEADLINE", retryable: true, effect: "unknown" });
    await hub.control!.sendPrompt("A", "hello", "steer");
    await flush();
    const cmds = t.calls.filter((c) => c.method === "command");
    expect(cmds).toHaveLength(2); // the original send + one auto queryOnly
    const original = cmds[0]!.args[0] as Record<string, unknown>;
    const query = cmds[1]!.args[0] as Record<string, unknown>;
    expect(query).toMatchObject({ id: original.id, op: "prompt", text: "hello", queryOnly: true });

    // the query answer (E_DEADLINE again) drops the item back to unknown — but the one-shot
    // guard blocks any further automatic query
    await flush();
    expect(t.calls.filter((c) => c.method === "command")).toHaveLength(2);
    expect(pendingOf(hub, String(original.id))).toMatchObject({ state: "unknown" });
    hub.dispose();
  });

  it("queryOnly answer ok ⇒ the pending item is done (dup semantics, §4.5)", async () => {
    const { t, hub } = make();
    t.setCommandResult({ ok: false, error: "E_DEADLINE", retryable: true, effect: "unknown" });
    await hub.control!.steerSub("A", "r_1", "focus");
    await flush();
    const cmds = () => t.calls.filter((c) => c.method === "command");
    expect(cmds()).toHaveLength(2); // send + the one automatic queryOnly (shot consumed)
    const id = String((cmds()[0]!.args[0] as Record<string, unknown>).id);
    expect(pendingOf(hub, id)).toMatchObject({ state: "unknown" }); // query also failed ⇒ stays unknown

    // the one-shot guard blocks further AUTOMATIC queries…
    hub.dispatch({ event: "agent_stale", data: { agentKey: "A" } });
    await flush();
    expect(cmds()).toHaveLength(2);

    // …but a MANUAL query is always allowed, and an ok answer resolves the item
    t.setCommandResult({ ok: true, data: { op: "query", state: "ok", result: { ok: true, data: {} } } });
    await hub.control!.query("A", id);
    await flush();
    expect(cmds()).toHaveLength(3);
    expect(pendingOf(hub, id)).toBeUndefined(); // resolved ⇒ removed from pendingCtl
    hub.dispose();
  });

  it("agent_down marks in-flight items offline; agent_up re-arms exactly one auto query (§3.5)", async () => {
    const { t, hub } = make();
    // the agent is already down when the (possibly-executed) result arrives ⇒ no auto query
    hub.dispatch({ event: "agent_down", data: { agentKey: "A", reason: "reap" } });
    t.setCommandResult({ ok: false, error: "E_DEADLINE", retryable: true, effect: "unknown" });
    await hub.control!.sendPrompt("A", "hello", "steer");
    await flush();
    const id = String((t.calls.find((c) => c.method === "command")!.args[0] as Record<string, unknown>).id);
    expect(pendingOf(hub, id)).toMatchObject({ state: "unknown" });
    expect(t.calls.filter((c) => c.method === "command")).toHaveLength(1); // down ⇒ no query

    t.setCommandResult({ ok: true, data: { op: "query", state: "ok", result: { ok: true, data: {} } } });
    hub.dispatch({ event: "agent_up", data: { agent: card("A") } });
    await flush();
    const cmds = t.calls.filter((c) => c.method === "command");
    expect(cmds).toHaveLength(2); // the original send + the one re-armed auto queryOnly
    expect(cmds[1]!.args[0]).toMatchObject({ id, queryOnly: true });
    expect(pendingOf(hub, id)).toBeUndefined();
    await flush();
    expect(t.calls.filter((c) => c.method === "command")).toHaveLength(2); // still one shot
    hub.dispose();
  });

  it("cmd_late for a pending command item arms exactly one output-fetching query (v2.1 §7.7)", async () => {
    const { t, hub } = make();
    t.setCommandResult({ ok: true, data: { completion: "async" } });
    await hub.control!.runCommand("A", "compact", "");
    await flush();
    const id = String((t.calls.find((c) => c.method === "command")!.args[0] as Record<string, unknown>).id);
    expect(pendingOf(hub, id)).toMatchObject({ state: "running" });

    t.setCommandResult({
      ok: true,
      data: { op: "query", state: "ok", result: { ok: true, data: { output: { entries: [] } } } },
    });
    hub.dispatch({ event: "cmd_late", data: { agentKey: "A", id, op: "command", ok: true } });
    await flush();
    const queries = t.calls.filter((c) => c.method === "command" && (c.args[0] as { queryOnly?: boolean }).queryOnly);
    expect(queries).toHaveLength(1); // the output fetch — SSE cmd_late never carries output (§6.6)
    expect(pendingOf(hub, id)).toBeUndefined(); // query answered ok ⇒ done
    await flush();
    expect(
      t.calls.filter((c) => c.method === "command" && (c.args[0] as { queryOnly?: boolean }).queryOnly),
    ).toHaveLength(1);
    hub.dispose();
  });
});
