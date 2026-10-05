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
  // F5 (fleet-drawer §6.5): the run-method surface — `runSubscribeResults` is consumed one per
  // call (shift); the last entry repeats, so a single default `{ok:true}` means "always 202".
  let runSubscribeResults: Array<{ ok: boolean; error?: string; reason?: string }> = [{ ok: true }];
  let runPageResult: Result<{ entries: unknown[]; hasMore: boolean; oldestEntryId?: string }> = {
    ok: true,
    data: { entries: [], hasMore: false },
  };

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
    runSubscribe: async (clientId, agentKey, runId) => {
      calls.push({ method: "runSubscribe", args: [clientId, agentKey, runId] });
      const r = runSubscribeResults.length > 1 ? runSubscribeResults.shift()! : runSubscribeResults[0]!;
      return r;
    },
    runUnsubscribe: async (clientId, agentKey, runId) => {
      calls.push({ method: "runUnsubscribe", args: [clientId, agentKey, runId] });
    },
    runPage: async (agentKey, runId, before, limit) => {
      calls.push({ method: "runPage", args: [agentKey, runId, before, limit] });
      return runPageResult as Result<unknown>;
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
    setRunSubscribeResults: (r: Array<{ ok: boolean; error?: string; reason?: string }>) => (runSubscribeResults = r),
    setRunPageResult: (r: typeof runPageResult) => (runPageResult = r),
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

describe("useHub: spawn wiring (web-hub-spawn SP11)", () => {
  /** Minimal harness with a spawn-capable fake transport. */
  function makeSpawnHub() {
    const clock = fakeClock();
    const starts: unknown[] = [];
    const transport: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => {},
      page: async () => ({ ok: true, data: {} }),
      command: async () => ({ ok: true }),
      dialog: async () => ({ ok: true }),
      spawn: {
        list: async () => ({ ok: false as const, error: "E_NOT_FOUND", status: 404 }),
        dirs: async () => ({ ok: false as const, error: "E_NOT_FOUND", status: 404 }),
        start: async (req) => {
          starts.push(req);
          return { ok: true, data: { spawnId: "sp1", state: "starting" as const, cwd: "/real/p" } };
        },
        stop: async () => ({ ok: true as const, state: "stopping" as const }),
      },
    };
    const hub = useHub({
      createTransport: () => transport,
      ...alwaysVisible(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
    });
    return { hub, clock, starts };
  }

  it("handle.spawn is always constructed (list/dirs/start/stop + newSession); a transport without spawn degrades to E_UNSUPPORTED", async () => {
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: fakeClock().setTimeout,
      clearTimeout: fakeClock().clearTimeout,
    });
    expect(hub.spawn).toBeDefined();
    expect(hub.spawn!.newSession.flow.value.phase).toBe("idle");
    expect(await hub.spawn!.list()).toEqual({ ok: false, error: "E_UNSUPPORTED", status: 0 });
    expect(await hub.spawn!.start({ id: "x".repeat(22), cwd: "/tmp" })).toEqual({
      ok: false,
      error: "E_UNSUPPORTED",
      retryable: false,
    });
    hub.dispose();
  });

  it("a spawns SSE frame lands in state.spawns AND settles an awaiting new-session flow (noteSpawns wiring)", async () => {
    const { hub } = makeSpawnHub();
    await hub.spawn!.newSession.submit({ cwd: "~/p", firstPrompt: { text: "body", deliver: "steer" } });
    expect(hub.spawn!.newSession.flow.value.phase).toBe("awaiting");

    hub.dispatch({
      event: "spawns",
      data: {
        items: [
          {
            spawnId: "sp1",
            state: "live",
            agentKey: "A",
            createdAt: 1,
            updatedAt: 2,
            cwdLabel: "p",
            origin: { listener: "loopback", reqId: "nope" },
            firstPrompt: { state: "delivered" },
          },
        ],
        active: 1,
        max: 4,
      },
    });
    await flush();
    expect(hub.state.value.spawns).toMatchObject({ active: 1, max: 4 });
    expect(hub.spawn!.newSession.flow.value).toMatchObject({ phase: "done", agentKey: "A" });
    expect(hub.spawn!.newSession.stats().retainedTexts).toBe(0);
    hub.dispose();
  });

  it("dispose() disposes the new-session orchestrator (watchdog cleared, retention emptied)", async () => {
    const { hub, clock } = makeSpawnHub();
    await hub.spawn!.newSession.submit({ cwd: "~/p", firstPrompt: { text: "body" } });
    expect(clock.pending()).toBeGreaterThan(0);
    hub.dispose();
    expect(hub.spawn!.newSession.stats().retainedTexts).toBe(0);
  });

  it("a successful list() caches the policy for the awaiting watchdog (registerTimeoutS from the hub)", async () => {
    const clock = fakeClock();
    const starts: unknown[] = [];
    const transport: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => {},
      page: async () => ({ ok: true, data: {} }),
      command: async () => ({ ok: true }),
      dialog: async () => ({ ok: true }),
      spawn: {
        list: async () => ({
          ok: true as const,
          policy: {
            allowed: true,
            confirm: "unknown-dir" as const,
            scope: "known" as const,
            max: 4,
            maxPerPrincipal: 2,
            active: 0,
            activeMine: 0,
            registerTimeoutS: 5,
            maxLifetimeMinutes: 720,
          },
          items: [],
        }),
        dirs: async () => ({ ok: true as const, recent: [] }),
        start: async (req) => {
          starts.push(req);
          return { ok: true, data: { spawnId: "sp1", state: "starting" as const, cwd: "/real/p" } };
        },
        stop: async () => ({ ok: true as const, state: "stopping" as const }),
      },
    };
    const hub = useHub({
      createTransport: () => transport,
      ...alwaysVisible(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
    });
    await hub.spawn!.list(); // caches registerTimeoutS: 5
    await hub.spawn!.newSession.submit({ cwd: "~/p" });
    clock.advance(5_000 + 15_000); // policy-driven watchdog, not the 30s default
    expect(hub.spawn!.newSession.flow.value.phase).toBe("unknown");
    hub.dispose();
  });
});

// ---------------------------------------------------------------------------
// fleet-drawer plan §3.3/§6.5 (package F5): run-transcript wiring — subscription ownership,
// watchdog, E_BUSY self-heal, hello re-subscribe, agent-switch ordering (§6.4 #7), paging.
// ---------------------------------------------------------------------------

describe("useHub: fleet-drawer run wiring (§6.5, F5)", () => {
  const RUN = "r_AB12CD34";
  // Distinct timestamps per id — messageKey dedupes `role:timestamp`, so identical stamps
  // would make separate entries look like duplicates.
  const entry = (id: string, role = "user") => ({
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(1000 + id.charCodeAt(1)).toISOString(),
    message: { role, content: `m-${id}`, timestamp: 1000 + id.charCodeAt(1) },
  });

  function make(opts: { resyncMinIntervalMs?: number; runPendingWatchdogMs?: number } = {}) {
    const clock = fakeClock();
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      ...(opts.resyncMinIntervalMs === undefined ? {} : { resyncMinIntervalMs: opts.resyncMinIntervalMs }),
      ...(opts.runPendingWatchdogMs === undefined ? {} : { runPendingWatchdogMs: opts.runPendingWatchdogMs }),
    });
    // The real token/password clients report conn "open" on the SSE hello BEFORE the hello
    // frame dispatch; runFleetEffects gates on it (no subscribing with a dead stream).
    t.hooks().onConn("open");
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A"), card("B")] });
    return { t, hub, clock };
  }

  /** Select agent A + run, then deliver its snapshot — a loaded, subscribed runTx. */
  function loadedRun(hub: ReturnType<typeof make>["hub"], runId = RUN, fromSeq = 11) {
    hub.selectRun("A", runId);
    hub.dispatch({
      event: "run_history",
      data: {
        agentKey: "A",
        runId,
        entries: [entry("e1")],
        tailMessages: [],
        tapId: "tap_1",
        fromSeq,
        hasMore: false,
        source: "live",
        terminal: false,
        status: "running",
        live: true,
      },
    });
  }

  it("selectRun dispatches run_select and fires exactly one runSubscribe (202), no watchdog retry once history lands", async () => {
    const { t, hub, clock } = make();
    loadedRun(hub);
    await flush();
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toEqual([
      { method: "runSubscribe", args: ["c1", "A", RUN] },
    ]);
    const tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx).toMatchObject({ runId: RUN, history: "loaded", lastSeq: 10, pendingSince: undefined });
    clock.advance(60_000); // nothing pending — watchdog never fires
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(1);
    hub.dispose();
  });

  it("selectRun(null) unsubscribes the run; switching runs tears the previous one down eagerly", async () => {
    const { t, hub } = make({ resyncMinIntervalMs: 0 });
    loadedRun(hub);
    await flush();
    t.calls.length = 0;
    hub.selectRun("A", null);
    await flush();
    expect(t.calls.filter((c) => c.method === "runUnsubscribe")).toEqual([
      { method: "runUnsubscribe", args: ["c1", "A", RUN] },
    ]);

    // run→run switch from a subscribed run: the old unsubscribe goes out, then the new subscribe
    loadedRun(hub);
    await flush();
    t.calls.length = 0;
    hub.selectRun("A", "r_EF56GH78");
    await flush();
    expect(t.calls.filter((c) => c.method === "runUnsubscribe")).toEqual([
      { method: "runUnsubscribe", args: ["c1", "A", RUN] },
    ]);
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toEqual([
      { method: "runSubscribe", args: ["c1", "A", "r_EF56GH78"] },
    ]);
    hub.dispose();
  });

  it("U6/§6.4 #7: switching agents calls runUnsubscribe(旧 run) BEFORE unsubscribe(旧 agent)", async () => {
    const { t, hub } = make({ resyncMinIntervalMs: 0 });
    loadedRun(hub);
    await flush();
    t.calls.length = 0;
    hub.dispatch({ event: "route", data: { agentKey: "B" } });
    await flush();
    const idxRun = t.calls.findIndex((c) => c.method === "runUnsubscribe");
    const idxMain = t.calls.findIndex((c) => c.method === "unsubscribe");
    expect(idxRun).toBeGreaterThanOrEqual(0);
    expect(idxMain).toBeGreaterThanOrEqual(0);
    expect(idxRun).toBeLessThan(idxMain);
    expect(t.calls[idxRun]!.args).toEqual(["c1", "A", RUN]);
    hub.dispose();
  });

  it("U13 watchdog: no run_history within the window ⇒ resubscribe twice, then error state (manual retry via re-select)", async () => {
    const { t, hub, clock } = make({ runPendingWatchdogMs: 10_000, resyncMinIntervalMs: 0 });
    hub.selectRun("A", RUN);
    await flush();
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(1);
    clock.advance(10_000); // retry #1
    await flush();
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(2);
    const tx1 = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx1).toMatchObject({ pendingSince: expect.any(Number) as unknown, retries: 1, history: "waiting" });
    clock.advance(10_000); // retry #2
    await flush();
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(3);
    clock.advance(10_000); // third fire: retries already 2 ⇒ error
    await flush();
    const tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx).toMatchObject({ history: "error", historyError: "E_DEADLINE" });
    clock.advance(30_000); // no further attempts from the error state
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(3);
    // manual retry: re-select resets the slot and subscribes again
    hub.selectRun("A", RUN);
    await flush();
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(4);
    hub.dispose();
  });

  it("E_BUSY self-heal (§6.5): one immediate retry after dropping the other runs; persistent busy ⇒ error state", async () => {
    const { t, hub } = make({ resyncMinIntervalMs: 0 });
    t.setRunSubscribeResults([{ ok: false, error: "E_BUSY" }, { ok: true }]);
    hub.selectRun("A", RUN);
    await flush();
    // busy once → retried once → 202; exactly two POSTs, no error state
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(2);
    const tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx.history).not.toBe("error");

    t.setRunSubscribeResults([
      { ok: false, error: "E_BUSY" },
      { ok: false, error: "E_BUSY" },
    ]);
    hub.selectRun("A", "r_EF56GH78"); // fresh select, fresh attempt
    await flush();
    const tx2 = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx2).toMatchObject({ history: "error", historyError: "E_BUSY" });
    hub.dispose();
  });

  it("a failed runSubscribe POST (non-busy) lands in the error state immediately, no watchdog retry", async () => {
    const { t, hub, clock } = make({ runPendingWatchdogMs: 10_000 });
    t.setRunSubscribeResults([{ ok: false, error: "E_NOT_FOUND", reason: "unknown_run" }]);
    hub.selectRun("A", RUN);
    await flush();
    const tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx).toMatchObject({ history: "error", historyError: "E_NOT_FOUND", reason: "unknown_run" });
    clock.advance(30_000);
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(1);
    hub.dispose();
  });

  it("§6.5 hello (clientId change): runTx content survives, the run re-subscribes under the new clientId", async () => {
    const { t, hub } = make({ resyncMinIntervalMs: 0 });
    loadedRun(hub);
    await flush();
    t.calls.length = 0;
    hub.dispatch({ event: "hello", data: { clientId: "c2" } });
    await flush();
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toEqual([
      { method: "runSubscribe", args: ["c2", "A", RUN] },
    ]);
    const tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx).toMatchObject({
      history: "loaded", // content preserved behind the reconnect badge…
      pendingSince: expect.any(Number) as unknown, // …which is exactly the fresh pendingSince
    });
    hub.dispose();
  });

  it("a §3.3 hole (seq jump) re-subscribes once rate-limit allows; the snapshot heals needsResync", async () => {
    const { t, hub, clock } = make({ resyncMinIntervalMs: 2_000 });
    loadedRun(hub); // lastSeq 10
    await flush();
    t.calls.length = 0;
    hub.dispatch({
      event: "run_ev",
      data: { agentKey: "A", runId: RUN, tapId: "tap_1", seq: 14, e: { type: "turn_start" } },
    });
    await flush();
    let tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx.needsResync).toBe(true);
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(0); // inside the resync window
    clock.advance(2_000);
    await flush();
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(1);
    hub.dispatch({
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN,
        entries: [entry("e1"), entry("e2")],
        tailMessages: [],
        tapId: "tap_2",
        fromSeq: 20,
        hasMore: false,
        source: "live",
        terminal: false,
        status: "running",
        live: true,
      },
    });
    await flush(); // let the render gate commit before reading state.value
    tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx.needsResync).toBe(false);
    expect(tx.lastSeq).toBe(19);
    hub.dispose();
  });

  it("pageRun(): pages the run's oldest boundary through runPage and prepends; a not_persisted failure disables load-older", async () => {
    const { t, hub } = make();
    hub.selectRun("A", RUN);
    hub.dispatch({
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN,
        entries: [entry("e5")],
        tailMessages: [],
        tapId: "tap_1",
        fromSeq: 11,
        hasMore: true,
        oldestEntryId: "e5",
        source: "live",
        terminal: false,
        status: "running",
        live: true,
      },
    });
    await flush();
    t.setRunPageResult({ ok: true, data: { entries: [entry("e1")], hasMore: false, oldestEntryId: "e1" } });
    hub.pageRun("A");
    await flush();
    expect(t.calls.filter((c) => c.method === "runPage")).toEqual([
      { method: "runPage", args: ["A", RUN, "e5", undefined] },
    ]);
    let tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect((tx.items as Array<{ entryId?: string }>).map((i) => i.entryId)).toEqual(["e1", "e5"]);
    expect(tx.hasMore).toBe(false);

    // deny-class failure on the next page
    hub.dispatch({
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN,
        entries: [entry("e5")],
        tailMessages: [],
        tapId: "tap_1",
        fromSeq: 11,
        hasMore: true,
        oldestEntryId: "e5",
        source: "live",
        terminal: false,
        status: "running",
        live: true,
      },
    });
    t.setRunPageResult({ ok: false, error: "E_NOT_FOUND" });
    hub.pageRun("A");
    await flush();
    tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    // no reason in the Result shape ⇒ retryable (hasMore kept) — the reason-carrying path is
    // pinned at the reducer level (logic-run-tx.test.ts); here we pin the transport round-trip
    expect(tx.paging).toBe(false);
    hub.dispose();
  });

  it("a transport without the run methods degrades to an E_UNSUPPORTED error state (never throws)", async () => {
    const clock = fakeClock();
    const transport: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => {},
      page: async () => ({ ok: true, data: {} }),
      command: async () => ({ ok: true }),
      dialog: async () => ({ ok: true }),
    };
    let hooks: TransportHooks | undefined;
    const hub = useHub({
      createTransport: (h) => {
        hooks = h;
        return transport;
      },
      ...alwaysVisible(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
    });
    hooks!.onConn("open");
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    hub.selectRun("A", RUN);
    await flush();
    const tx = (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
    expect(tx).toMatchObject({ history: "error", historyError: "E_UNSUPPORTED" });
    hub.dispose();
  });

  it("dispose() clears the run watchdog (no post-dispose attempts)", async () => {
    const { t, hub, clock } = make({ runPendingWatchdogMs: 10_000 });
    hub.selectRun("A", RUN);
    await flush();
    hub.dispose();
    clock.advance(60_000);
    expect(t.calls.filter((c) => c.method === "runSubscribe")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Acceptance fixes (F5 有条件通过): per-runKey watchdogs (#1), settle-cleared retry budget
// (#2), and generation-guarded async callbacks (#3).
// ---------------------------------------------------------------------------

describe("useHub: run wiring acceptance fixes", () => {
  const RUN_A = "r_AB12CD34";
  const RUN_B = "r_EF56GH78";
  const entry = (id: string, ts: number) => ({
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: `m-${id}`, timestamp: ts },
  });

  function make() {
    const clock = fakeClock();
    const t = fakeTransport();
    const hub = useHub({
      createTransport: t.createTransport,
      ...alwaysVisible(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      resyncMinIntervalMs: 0,
      runPendingWatchdogMs: 10_000,
    });
    t.hooks().onConn("open");
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });
    return { t, hub, clock };
  }
  const txOf = (hub: ReturnType<typeof make>["hub"]) =>
    (hub.state.value.agents.get("A") as unknown as { runTx: Record<string, unknown> }).runTx!;
  const subCalls = (t: ReturnType<typeof make>["t"], runId: string) =>
    t.calls.filter((c) => c.method === "runSubscribe" && c.args[2] === runId).length;

  it("#1 two concurrently-pending runKeys keep independent watchdogs (each fires, neither eats the other)", async () => {
    const { t, hub, clock } = make();
    // Key 1: a subscribed, pending run for A…
    hub.selectRun("A", RUN_B);
    await flush();
    expect(subCalls(t, RUN_B)).toBe(1);
    // Key 2: a SECOND pending run for the same agent via a raw `run_select` dispatch — a legal
    // reducer input (HubHandle.dispatch is public) that bypasses selectRun's eager teardown,
    // leaving two runSubs entries with two armed watchdogs (the multi-key tenancy #1 protects).
    hub.dispatch({ event: "run_select", data: { agentKey: "A", runId: RUN_A } });
    await flush();
    expect(subCalls(t, RUN_A)).toBe(1);
    expect(txOf(hub).runId).toBe(RUN_A);

    // Both watchdogs fire at the window; the CURRENT key retries, the superseded one
    // self-cleans without a retry — and crucially neither key's timer was destroyed by the
    // other's arming (single-global-timer behavior).
    clock.advance(10_000);
    await flush();
    expect(subCalls(t, RUN_A)).toBe(2); // current key's watchdog fired ⇒ retry #1
    expect(subCalls(t, RUN_B)).toBe(1); // superseded key's watchdog fired ⇒ self-clean, no retry
    clock.advance(10_000);
    await flush();
    expect(subCalls(t, RUN_A)).toBe(3); // retry #2
    expect(txOf(hub).history).not.toBe("error");
    clock.advance(10_000);
    await flush();
    expect(txOf(hub)).toMatchObject({ history: "error", historyError: "E_DEADLINE" }); // full U13 budget, not shortened

    // The self-cleaned key starts a fresh episode with a full watchdog budget of its own.
    hub.selectRun("A", RUN_B);
    await flush();
    expect(subCalls(t, RUN_B)).toBe(2);
    clock.advance(10_000);
    await flush();
    expect(subCalls(t, RUN_B)).toBe(3); // independent timer, not inherited from RUN_A's episode
    hub.dispose();
  });

  it("#2 a successful run_history settles the episode: retries reset, so the NEXT pending episode runs the full U13 budget", async () => {
    const { t, hub, clock } = make();
    hub.selectRun("A", RUN_A);
    await flush();
    clock.advance(10_000); // watchdog fire #1 of episode 1 (retries 0→1)
    await flush();
    expect(subCalls(t, RUN_A)).toBe(2);
    expect(txOf(hub)).toMatchObject({ retries: 1, history: "waiting" });

    // The retried attempt succeeds: run_history lands ⇒ settle clears the retry counter
    // (and the armed watchdog) for this key.
    hub.dispatch({
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN_A,
        entries: [entry("e1", 1001)],
        tailMessages: [],
        tapId: "tap_1",
        fromSeq: 11,
        hasMore: false,
        source: "live",
        terminal: false,
        status: "running",
        live: true,
      },
    });
    await flush();
    expect(txOf(hub)).toMatchObject({ history: "loaded", pendingSince: undefined });

    // A NEW pending episode (a §3.3 hole ⇒ re-subscribe) must start from retries 0 — with a
    // stale inherited counter it would error one fire early. The re-subscribe itself fires
    // synchronously inside the hole dispatch's effects, consuming needsResync on the way.
    hub.dispatch({
      event: "run_ev",
      data: { agentKey: "A", runId: RUN_A, tapId: "tap_1", seq: 40, e: { type: "turn_start" } },
    });
    await flush();
    expect(subCalls(t, RUN_A)).toBe(3); // episode 2's initial subscribe
    expect(txOf(hub)).toMatchObject({ pendingSince: expect.any(Number) as unknown, retries: 0 }); // ← the #2 pin

    clock.advance(10_000);
    await flush();
    // fire #1: retry, NOT error. history stays "loaded" (episode 2's re-subscribe keeps the
    // received content behind the pending badge — §6.5); the in-flight mark is pendingSince.
    expect(txOf(hub)).toMatchObject({ retries: 1, history: "loaded", pendingSince: expect.any(Number) as unknown });
    clock.advance(10_000);
    await flush();
    expect(txOf(hub)).toMatchObject({ retries: 2, history: "loaded", pendingSince: expect.any(Number) as unknown }); // fire #2: retry, NOT error
    clock.advance(10_000);
    await flush();
    expect(txOf(hub)).toMatchObject({ history: "error", historyError: "E_DEADLINE" }); // fire #3: budget exhausted
    expect(subCalls(t, RUN_A)).toBe(5); // ep2 initial + 2 retries; ep1 contributed 2
    hub.dispose();
  });

  it("#3 a stale subscribe POST resolving after a hello (clientId change) is dropped — the new generation's state stays clean", async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    /** Deferred controllers for runSubscribe call #N (index 0-based), so the test can resolve
     * old promises AFTER the generation moved on. Unlisted calls resolve {ok:true}. */
    const deferreds: Array<{ resolve: (r: { ok: boolean; error?: string; reason?: string }) => void }> = [];
    const transport: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => {},
      page: async () => ({ ok: true, data: {} }),
      runSubscribe: (_c, _a, _r) => {
        calls.push({ method: "runSubscribe", args: [_c, _a, _r] });
        const i = calls.filter((x) => x.method === "runSubscribe").length - 1;
        if (i < 2) {
          return new Promise((resolve) => void deferreds.push({ resolve }));
        }
        return Promise.resolve({ ok: true });
      },
      runUnsubscribe: async (_c, a, r) => {
        calls.push({ method: "runUnsubscribe", args: [_c, a, r] });
      },
      runPage: async () => ({ ok: true, data: {} }),
      command: async () => ({ ok: true }),
      dialog: async () => ({ ok: true }),
    };
    let hooks: TransportHooks | undefined;
    const hub = useHub({
      createTransport: (h) => {
        hooks = h;
        return transport;
      },
      ...alwaysVisible(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      resyncMinIntervalMs: 0,
      runPendingWatchdogMs: 10_000,
    });
    hooks!.onConn("open");
    hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    hub.dispatch({ event: "agents", data: [card("A")] });

    // Attempt #1 under c1 — its POST stays pending.
    hub.selectRun("A", RUN_A);
    await flush();
    expect(calls.filter((c) => c.method === "runSubscribe")).toHaveLength(1);

    // The SSE reconnects: hello hands out a NEW clientId, the run re-subscribes (attempt #2).
    hub.dispatch({ event: "hello", data: { clientId: "c2" } });
    await flush();
    expect(calls.filter((c) => c.method === "runSubscribe").map((c) => c.args[0])).toEqual(["c1", "c2"]);
    expect(txOf(hub)).toMatchObject({ history: "waiting", pendingSince: expect.any(Number) as unknown });

    // NOW attempt #1's promise resolves with a hard failure — a stale generation's result: it
    // must be dropped (no error state, no teardown of the live attempt, no E_BUSY self-heal).
    deferreds[0]!.resolve({ ok: false, error: "E_NOT_FOUND", reason: "unknown_run" });
    await flush();
    expect(txOf(hub).history).toBe("waiting"); // not poisoned into error
    expect(calls.some((c) => c.method === "runUnsubscribe")).toBe(false); // finishRunError never ran

    // Attempt #2 is the second deferred; resolving it with E_BUSY must ALSO be generation-safe
    // once superseded — one more hello supersedes it, then it resolves stale.
    hub.dispatch({ event: "hello", data: { clientId: "c3" } });
    await flush();
    expect(calls.filter((c) => c.method === "runSubscribe").map((c) => c.args[0])).toEqual(["c1", "c2", "c3"]);
    deferreds[1]!.resolve({ ok: false, error: "E_BUSY" });
    await flush();
    expect(txOf(hub).history).toBe("waiting"); // stale E_BUSY did NOT trigger dropOtherRuns/retry/error
    expect(calls.some((c) => c.method === "runUnsubscribe")).toBe(false);

    // The live generation (#3, immediate {ok:true}) still settles normally.
    hub.dispatch({
      event: "run_history",
      data: {
        agentKey: "A",
        runId: RUN_A,
        entries: [entry("e1", 1001)],
        tailMessages: [],
        tapId: "tap_3",
        fromSeq: 5,
        hasMore: false,
        source: "live",
        terminal: false,
        status: "running",
        live: true,
      },
    });
    await flush();
    expect(txOf(hub)).toMatchObject({ history: "loaded", lastSeq: 4 });
    hub.dispose();
  });
});
