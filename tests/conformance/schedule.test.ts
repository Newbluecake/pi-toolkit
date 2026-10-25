/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  AgentSessionRuntime,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { AnthropicStub } from "./fixtures/anthropic-stub.js";
import { FakeClock } from "../../src/core/clock.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { createProcessOccupancy, createProcessRunRegistry } from "../../src/schedule/agent/dispatch.js";
import { installMessageScheduler } from "../../src/schedule/agent/message.js";
import { createScheduleAgent, isEpochDisposed, type ScheduleAgent } from "../../src/schedule/agent/wire.js";
import { SCHED_CUSTOM_TYPE } from "../../src/schedule/core/spec.js";
import { addTask, approve, makeTask, self } from "../schedule/core/fixtures.js";

/**
 * scheduled-reports I1 (plan r3 §14 「真实 pi 一致性测试」, C-S1…C-S8) — pi peer-bump gate, same family as
 * C-X (fabric-xs) / consult-preserve: REAL pi runner + REAL extension event pipeline + REAL Anthropic HTTP adapter,
 * only the provider is a loopback stub (zero external network; `AnthropicStub`). The schedule side is the production
 * `installMessageScheduler` over a real `ScheduleAgent` + real ledger; its clock is injected (a FakeClock moves only the
 * dispatcher's own deadlines — never pi's).
 *
 * Self-gating: no flags / credentials needed, but C-S6 spawns a child Node process through `tsx` (skipped with a
 * recorded reason when `tsx` cannot be resolved). Run before any pi peer bump together with C-X1…C-X11 and C-P1–C-P5.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const timer = setTimeout(r, ms);
    timer.unref();
  });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean, label: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(5);
  expect(check(), label).toBe(true);
}

type Env = Awaited<ReturnType<typeof host>>;

async function host(
  options: {
    stub?: AnthropicStub;
    extensions?: Array<(pi: ExtensionAPI) => void>;
    /** Registered BEFORE the scheduler's own handlers — the production order (xs's compaction handler is ahead of A2's). */
    before?: Array<(pi: ExtensionAPI) => void>;
    /** Install the production message scheduler (default true). */
    scheduler?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "schedule-conformance-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  const stub = options.stub ?? (await AnthropicStub.start());
  const model = {
    id: "claude-sched",
    name: "schedule local stub",
    provider: "sched-local",
    api: "anthropic-messages" as const,
    baseUrl: `${stub.baseUrl}/v1`,
    reasoning: false,
    input: ["text" as const],
    contextWindow: 1000,
    maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
      retry: { enabled: false },
      cacheWarmer: { enabled: false },
    }),
  );
  const settings = SettingsManager.create(dir, agentDir);
  const clock = new FakeClock(Date.now());
  const cap = new XsHostCapability();
  const holder: { current?: { schedule?: ScheduleAgent } } = {};
  const triggers: any[] = [];
  const settled: boolean[] = [];
  const errors: unknown[] = [];
  const order: string[] = [];
  let pi!: ExtensionAPI, ctx!: ExtensionContext;
  let install: ReturnType<typeof installMessageScheduler> | undefined;
  let agent!: ScheduleAgent;
  const storeDir = join(dir, "schedules");
  const key = `conf-${Math.random().toString(36).slice(2)}`;
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      (api) => {
        pi = api;
        api.on("session_start", (_e, context) => {
          ctx = context;
        });
        api.on("before_agent_start", (event) => {
          triggers.push(event);
          order.push("before_agent_start");
        });
        api.on("agent_settled", (event) => {
          settled.push(event.aborted);
        });
        for (const early of options.before ?? []) early(api);
        if (options.scheduler !== false)
          install = installMessageScheduler(api, holder, {
            clock,
            capability: cap,
            occupancy: createProcessOccupancy(isEpochDisposed, `${key}-occ`),
            registry: createProcessRunRegistry(`${key}-reg`),
            notify: () => undefined,
            warn: () => undefined,
          });
      },
      ...(options.extensions ?? []),
    ],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    sessionManager: manager,
    model,
    modelRuntime: {
      streamSimple: (m: typeof model, c: Parameters<typeof streamSimple>[1], o: Parameters<typeof streamSimple>[2]) =>
        streamSimple(m, c, { ...o, apiKey: "local-stub-only" }),
      getModel: () => model,
      checkAuth: async () => ({ ok: true }),
      hasConfiguredAuth: () => true,
      getAuth: async () => ({ apiKey: "local-stub-only" }),
      isUsingOAuth: () => false,
      getAvailableSnapshot: () => [model],
    } as never,
    settingsManager: settings,
    resourceLoader: loader,
  });
  await session.bindExtensions({ mode: "rpc", onError: (e) => errors.push(e) });
  if (install !== undefined) {
    agent = createScheduleAgent({
      ctx: ctx as never,
      mode: { kind: "interactive", arm: true },
      sessionId: manager.getSessionId(),
      self: self(),
      dir: storeDir,
      plain: true,
      inVault: () => false,
      clock,
      monotonic: () => clock.now(),
      warn: () => undefined,
      router: undefined,
      storeOpts: { lockTimeoutMs: 2_000 },
    });
    holder.current = { schedule: agent };
    install.attach(agent, ctx);
  }
  cleanups.push(async () => {
    install?.scheduler(agent)?.shutdown();
    agent?.dispose();
    await session.abort();
    session.dispose();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** A manual run of an approved message task ⇒ claim ⇒ the production executor queues it in the dispatcher. */
  const queueRun = async (name = "定时消息") => {
    const store = agent.ensureStore();
    // A yearly cron: the harness advances the fake clock by minutes, and an hourly default would sometimes fire an AUTO run
    // of its own inside the window (wall-clock dependent) and contaminate the request counts.
    const task = approve(
      makeTask({
        name,
        form: "message",
        feishu: false,
        ownerCwd: dir,
        when: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" },
      }),
    );
    await addTask(store, task, clock.now());
    const r = await agent.runNow({ taskId: task.id, reqId: `req_${Math.random().toString(36).slice(2, 14)}_xxxx` });
    expect(r.kind).toBe("started");
    return { task, runKey: (r as { runKey: string }).runKey };
  };
  const runState = (runKey: string): string | undefined => {
    const s = agent.readState();
    return s.kind === "ok" ? s.state.runs.find((r) => r.runKey === runKey)?.state : undefined;
  };
  /** Advance the dispatcher's FakeClock while real pi does its (real) async work. */
  const drive = async (until_: () => boolean, label: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (!until_() && Date.now() < end) {
      clock.advance(1100);
      await sleep(10);
    }
    expect(until_(), label).toBe(true);
  };
  return {
    dir,
    agentDir,
    session,
    stub,
    manager,
    settings,
    clock,
    cap,
    holder,
    triggers,
    settled,
    errors,
    order,
    pi: () => pi,
    ctx: () => ctx,
    install: () => install!,
    agent: () => agent,
    queueRun,
    runState,
    drive,
  };
}
const prime = async (h: Env) => {
  await h.session.prompt("human first turn");
  if (h.holder.current !== undefined) expect(h.cap.state).toBe("observed"); // the dispatcher's own gate saw the union shape
};
const customEntries = (h: Env, noteId: string) =>
  h.manager
    .getEntries()
    .filter(
      (e: any) => e.type === "custom_message" && e.customType === SCHED_CUSTOM_TYPE && e.details?.noteId === noteId,
    );
const customStarts = (h: Env) =>
  h.triggers.filter((t) => t.messageType === "custom" && t.message?.customType === SCHED_CUSTOM_TYPE);

describe("schedule real pi contracts (C-S1…C-S8)", () => {
  it("C-S1: an IDLE quiet custom message is appended BEFORE its message_start; one sent while STREAMING stays in memory until the turn ends", async () => {
    const hold = deferred();
    let streaming = false;
    const atStart: boolean[] = [];
    let hRef!: Env;
    const stub = await AnthropicStub.start({
      respond: (_r, i) => (i === 1 && streaming ? hold.promise.then(() => undefined) : undefined),
    });
    const h = await host({
      stub,
      scheduler: false,
      extensions: [
        (api) =>
          api.on("message_start", (e: any) => {
            if (e.message?.customType === SCHED_CUSTOM_TYPE && e.message.details?.noteId === "n-idle")
              atStart.push(customEntries(hRef, "n-idle").length > 0);
          }),
      ],
    });
    hRef = h;
    await prime(h);
    // (a) idle: persisted synchronously with the call, before the message_start event is observed
    h.pi().sendMessage(
      {
        customType: SCHED_CUSTOM_TYPE,
        content: "idle quiet",
        display: true,
        details: { kind: "result", noteId: "n-idle" },
      },
      { triggerTurn: false },
    );
    await until(() => atStart.length > 0 || customEntries(h, "n-idle").length > 0, "idle message processed");
    expect(customEntries(h, "n-idle")).toHaveLength(1);
    if (atStart.length > 0) expect(atStart).toEqual([true]);
    // (b) streaming: the quiet message is held (NOT in the session) until the run ends
    streaming = true;
    const run = h.session.prompt("a long turn");
    await until(() => !h.session.isIdle && h.stub.requests.length >= 2, "second request in flight");
    h.pi().sendMessage(
      {
        customType: SCHED_CUSTOM_TYPE,
        content: "streaming quiet",
        display: true,
        details: { kind: "result", noteId: "n-busy" },
      },
      { triggerTurn: false },
    );
    await sleep(50);
    expect(customEntries(h, "n-busy")).toHaveLength(0);
    hold.resolve();
    await run;
    await until(() => customEntries(h, "n-busy").length === 1, "appended after the turn");
  }, 20_000);

  it("C-S2: a dispatch requested INSIDE the settled window (+ the dispatcher's own quiet period) produces exactly one trigger — no double trigger", async () => {
    let dispatchedInSettled = false;
    let hRef!: Env;
    const h = await host({
      stub: await AnthropicStub.start({ respond: (_r, i) => (i >= 2 ? { kind: "hang" } : undefined) }),
      extensions: [
        (api) =>
          api.on("agent_settled", async () => {
            if (dispatchedInSettled || hRef === undefined) return;
            dispatchedInSettled = true;
            await hRef.queueRun("inside settled");
          }),
      ],
    });
    hRef = h;
    await prime(h); // its agent_settled queues the run
    await until(() => dispatchedInSettled, "run queued inside agent_settled");
    expect(customStarts(h)).toHaveLength(0);
    // inside the quiet period (settled + 1 s) nothing may be sent …
    h.clock.advance(400);
    await sleep(40);
    expect(customStarts(h)).toHaveLength(0);
    // … after it exactly one trigger starts a run, and nothing else piles on while it is in flight
    await h.drive(() => customStarts(h).length === 1, "single trigger");
    for (let i = 0; i < 10; i++) {
      h.clock.advance(1100);
      await sleep(10);
    }
    expect(customStarts(h)).toHaveLength(1);
  }, 25_000);

  it("C-S3: an uncancelled-less tree window fences the dispatcher (cancelled navigateTree never lifts it by input); the local reset lifts it; a disposed session's late enqueue is inert", async () => {
    const h = await host({
      stub: await AnthropicStub.start({ respond: (_r, i) => (i >= 2 ? { kind: "hang" } : undefined) }),
      extensions: [(api) => api.on("session_before_tree", () => ({ cancel: true }))],
    });
    await prime(h);
    const target = h.manager.getLeafId()!;
    await h.session.prompt("second branch");
    expect(await h.session.navigateTree(target)).toMatchObject({ cancelled: true });
    const { runKey } = await h.queueRun();
    await h.session.extensionRunner!.emitInput("human input after the cancelled tree", undefined, "rpc");
    for (let i = 0; i < 12; i++) {
      h.clock.advance(1100);
      await sleep(10);
    }
    expect(customStarts(h)).toHaveLength(0); // M1: input proves nothing, the fence stays
    expect(h.runState(runKey)).toBe("queued");
    expect(h.install().diagnostics()?.fence.open.length ?? 0).toBeGreaterThan(0);
    h.install().resetBlockers(); // the local human escape (/fabric fence reset · /schedule repair)
    await h.drive(() => customStarts(h).length === 1, "dispatch after the local reset");
    // a replaced / disposed host: a late enqueue must be inert (no throw, no send)
    const sched = h.install().scheduler(h.agent())!;
    await until(() => h.stub.requests.length >= 3, "the scheduled run's request reached the provider");
    sched.shutdown();
    await sleep(30);
    const before = h.stub.requests.length;
    sched.enqueue(
      { runKey: "x@1", taskId: "s_aaaaaaaa", kind: "auto", form: "message" } as never,
      makeTask({ form: "message" }),
    );
    await sleep(30);
    expect(h.stub.requests.length).toBe(before);
  }, 30_000);

  it("C-S3b: a slow / cancelled session switch window rejects dispatch throughout", async () => {
    const entered = deferred();
    const release = deferred();
    const h = await host({
      stub: await AnthropicStub.start({ respond: (_r, i) => (i >= 2 ? { kind: "hang" } : undefined) }),
      extensions: [
        (api) =>
          api.on("session_before_switch", async () => {
            entered.resolve();
            await release.promise;
            return { cancel: true };
          }),
      ],
    });
    await prime(h);
    await h.queueRun();
    const runtime = new AgentSessionRuntime(h.session, { cwd: h.dir, agentDir: h.agentDir } as never, async () => {
      throw new Error("cancelled switch must not build a replacement");
    });
    const switching = runtime.newSession();
    await entered.promise;
    for (let i = 0; i < 12; i++) {
      h.clock.advance(1100);
      await sleep(10);
    }
    expect(customStarts(h)).toHaveLength(0);
    release.resolve();
    expect(await switching).toMatchObject({ cancelled: true });
    for (let i = 0; i < 6; i++) {
      h.clock.advance(1100);
      await sleep(10);
    }
    expect(customStarts(h)).toHaveLength(0); // a cancelled switch emits no completion evidence: still fenced
    h.install().resetBlockers();
    await h.drive(() => customStarts(h).length === 1, "dispatch after the reset");
  }, 30_000);

  it("C-S4: human input that beats the run to the session hands it over (continued) — no abort, the run limit is released", async () => {
    let customStarted = false;
    const h = await host({
      stub: await AnthropicStub.start({ respond: () => (customStarted ? { kind: "hang" } : undefined) }),
      extensions: [
        (api) => api.on("before_agent_start", (e: any) => void (e.messageType === "custom" && (customStarted = true))),
      ],
    });
    await prime(h);
    const { runKey } = await h.queueRun();
    await h.drive(() => customStarts(h).length === 1, "scheduled run started");
    await until(() => h.runState(runKey) === "bound", "bound");
    await h.session.extensionRunner!.emitInput("human takes over", undefined, "rpc");
    await until(() => h.runState(runKey) === "continued", "continued");
    h.clock.advance(4_000_000); // way past the 3600 s limit: a handed-over run is never aborted by it
    await sleep(40);
    expect(h.runState(runKey)).toBe("continued");
    expect(h.session.isIdle).toBe(false);
  }, 30_000);

  /** Near-threshold host: every reply reports 950/1000 input tokens, so pi compacts before the next run starts. */
  async function compactingHost(
    opts: {
      holdCompaction?: boolean;
      before?: Array<(pi: ExtensionAPI) => void>;
      extensions?: Array<(pi: ExtensionAPI) => void>;
    } = {},
  ) {
    const state = { hold: deferred(), held: false, customStarted: false, compactRequests: 0 };
    const stub = await AnthropicStub.start({
      reply: (_r, i) => ({ kind: "text", text: `answer ${i}`, usage: { input_tokens: 950 } }),
      respond: () => {
        if (opts.holdCompaction && !state.customStarted && !state.held && state.armed) {
          state.held = true;
          state.compactRequests++;
          return state.hold.promise.then(() => undefined);
        }
        return undefined;
      },
    } as never);
    (state as any).armed = false;
    const h = await host({
      stub,
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      extensions: [
        (api) =>
          api.on("before_agent_start", (e: any) => {
            if (e.messageType === "custom") state.customStarted = true;
          }),
        ...(opts.extensions ?? []),
      ],
    });
    await prime(h);
    await h.session.prompt("second turn with enough history for compaction");
    h.settings.setCompactionEnabled(true);
    return { h, state: state as typeof state & { armed: boolean }, stub };
  }

  it("C-S5: pre-start compaction fires SYNCHRONOUSLY inside sendCustomMessage and BEFORE the trigger's before_agent_start; our own send's compaction window does NOT void the dispatch — the scheduled message runs ONCE after the compaction (zero duplicates)", async () => {
    const order: string[] = [];
    let hRef!: Env;
    const { h, state } = await compactingHost({ holdCompaction: false });
    hRef = h;
    h.pi().on("session_before_compact", () => {
      order.push(/sendCustomMessage/.test(new Error().stack ?? "") ? "compact:inside-send" : "compact:elsewhere");
      order.push(`customStarts=${customStarts(hRef).length}`);
    });
    const { runKey } = await h.queueRun();
    const startsBefore = customStarts(h).length;
    await h.drive(() => h.runState(runKey) === "settled", "scheduled message settled after the compaction");
    expect(order.slice(0, 2)).toEqual(["compact:inside-send", `customStarts=${startsBefore}`]);
    expect(state.customStarted).toBe(true);
    expect(customStarts(h)).toHaveLength(startsBefore + 1); // exactly one start, never a re-send
    for (let i = 0; i < 6; i++) {
      h.clock.advance(1100);
      await sleep(10);
    }
    expect(customStarts(h)).toHaveLength(startsBefore + 1);
    expect(h.runState(runKey)).toBe("settled");
    expect(h.session.isIdle).toBe(true);
  }, 40_000);

  it("C-S5b: the 60 s start budget is PAUSED while our own compaction runs (65 s of fake time does not abort it), resumes after it, and a compaction that never ends is cut at the hard cap (600 s) with zero main requests", async () => {
    // (1) paused, then resumed and executed
    {
      const { h, state } = await compactingHost({ holdCompaction: true });
      state.armed = true;
      const { runKey } = await h.queueRun();
      await h.drive(() => state.held, "our compaction request reached the provider (held)");
      expect(h.install().scheduler(h.agent())!.status().inflight).toBe("dispatched");
      h.clock.advance(65_000); // > SCHED_START_TIMEOUT_MS: the pre-fix behaviour would have aborted here
      await sleep(40);
      expect(h.install().scheduler(h.agent())!.status().inflight).toBe("dispatched");
      expect(h.settled.at(-1)).not.toBe(true);
      state.hold.resolve();
      await until(() => state.customStarted, "authorized trigger started after the compaction");
      await h.drive(() => h.runState(runKey) === "settled", "settled");
    }
    // (2) a compaction that never ends: aborted at sentAt + 600 s, no main request, terminal state
    {
      const { h, state } = await compactingHost({ holdCompaction: true });
      state.armed = true;
      const { runKey } = await h.queueRun();
      await h.drive(() => state.held, "held");
      const requests = h.stub.requests.length;
      for (let i = 0; i < 12; i++) {
        h.clock.advance(60_000); // rolling start budget, cut at the 600 s hard cap
        await sleep(15);
      }
      await until(() => ["unknown", "dropped"].includes(h.runState(runKey) ?? ""), "cut at the hard cap");
      expect(h.stub.requests).toHaveLength(requests);
      expect(h.runState(runKey)).not.toBe("settled");
      state.hold.resolve();
    }
  }, 60_000);

  it("C-S5d (review r1 #1): PRODUCTION handler order — a compaction handler registered AHEAD of the scheduler's (xs's) delays our observation past the send's synchronous stack; the pause still applies (65 s of fake time does not abort), the run executes once", async () => {
    const seen: string[] = [];
    const { h, state } = await compactingHost({
      holdCompaction: true,
      before: [
        (api) => api.on("session_before_compact", () => void seen.push("ahead")), // synchronous handler, real runner still awaits it
        (api) =>
          api.on("session_before_compact", async () => {
            await sleep(15); // and an asynchronous one
            seen.push("ahead-async");
          }),
      ],
    });
    state.armed = true;
    const { runKey } = await h.queueRun();
    await h.drive(() => state.held, "our compaction request reached the provider (held)");
    expect(seen).toEqual(["ahead", "ahead-async"]);
    expect(h.install().scheduler(h.agent())!.status().inflight).toBe("dispatched");
    h.clock.advance(65_000);
    await sleep(40);
    expect(h.install().scheduler(h.agent())!.status().inflight).toBe("dispatched"); // paused although observed late
    state.hold.resolve();
    await until(() => state.customStarted, "authorized trigger started after the compaction");
    await h.drive(() => h.runState(runKey) === "settled", "settled");
    expect(customStarts(h)).toHaveLength(1);
  }, 40_000);

  it("C-S5e (review r1 #2): a session switch that opens (and stays pending in its before-handler) while OUR compaction runs stops the scheduled trigger — the first main request is never sent", async () => {
    const entered = deferred();
    const release = deferred();
    const { h, state, stub } = await compactingHost({
      holdCompaction: true,
      extensions: [
        (api) =>
          api.on("session_before_switch", async () => {
            entered.resolve();
            await release.promise;
            return { cancel: true };
          }),
      ],
    });
    state.armed = true;
    const { runKey } = await h.queueRun();
    await h.drive(() => state.held, "our compaction request reached the provider (held)");
    const runtime = new AgentSessionRuntime(h.session, { cwd: h.dir, agentDir: h.agentDir } as never, async () => {
      throw new Error("cancelled switch must not build a replacement");
    });
    const switching = runtime.newSession();
    await entered.promise; // the switch window is open and stays open
    const requests = stub.requests.length;
    state.hold.resolve(); // the compaction finishes; pi now goes on to start our trigger
    await until(() => ["unknown", "dropped"].includes(h.runState(runKey) ?? ""), "the trigger was refused");
    expect(h.runState(runKey)).toBe("unknown");
    await sleep(60);
    // no MAIN request (the compaction's own request is the only provider traffic since the hold)
    expect(stub.requests.length).toBeLessThanOrEqual(requests + 1);
    expect(stub.requests.slice(requests).some((r: any) => JSON.stringify(r.body ?? r).includes("定时消息"))).toBe(
      false,
    );
    release.resolve();
    await switching;
  }, 40_000);

  it("C-S5c: a FOREIGN compaction (not caused by our send) keeps the dispatcher fenced until it ends; then the message runs", async () => {
    const entered = deferred();
    const release = deferred();
    const h = await host({
      extensions: [
        (api) =>
          api.on("session_before_compact", async () => {
            entered.resolve();
            await release.promise;
            return { cancel: true };
          }),
      ],
    });
    await prime(h);
    await h.session.prompt("more history");
    const compacting = h.session.compact().catch((e: Error) => e.message);
    await entered.promise;
    const { runKey } = await h.queueRun();
    for (let i = 0; i < 12; i++) {
      h.clock.advance(1100);
      await sleep(10);
    }
    expect(customStarts(h)).toHaveLength(0); // fenced:compaction — an external window is NOT exempt
    expect(h.runState(runKey)).toBe("queued");
    release.resolve();
    expect(await compacting).toMatch(/cancel/i); // cancelled ⇒ session_compact_failed closes the window
    await h.drive(() => customStarts(h).length === 1, "dispatch after the foreign compaction ended");
  }, 30_000);

  it("C-S7: `context` fires after before_agent_start (and any pre-start compaction), before the first provider request; ctx.abort() there sends no request", async () => {
    const seq: string[] = [];
    let armed = false;
    let abortInContext = false;
    let hRef!: Env;
    const h = await host({
      scheduler: false,
      extensions: [
        (api) => {
          api.on("before_agent_start", (e: any) => {
            if (e.messageType === "custom") seq.push("before_agent_start");
          });
          api.on("context", () => {
            if (!armed) return;
            seq.push("context");
            if (abortInContext) hRef.ctx().abort();
          });
        },
      ],
    });
    hRef = h;
    await prime(h);
    armed = true;
    // ordinary custom trigger (a raw pi fact, independent of the dispatcher): order + provider traffic
    h.pi().sendMessage(
      { customType: "sched-probe", content: "probe", display: false, details: { token: "t" } },
      { triggerTurn: true },
    );
    await until(() => h.settled.length === 2, "first probe run settled");
    expect(seq.slice(0, 2)).toEqual(["before_agent_start", "context"]);
    expect(h.stub.requests.length).toBeGreaterThan(1);
    // now abort inside `context`: no provider request for that run
    abortInContext = true;
    const before = h.stub.requests.length;
    h.pi().sendMessage(
      { customType: "sched-probe", content: "probe 2", display: false, details: { token: "t2" } },
      { triggerTurn: true },
    );
    await until(() => h.settled.length === 3, "aborted run settled");
    expect(h.settled.at(-1)).toBe(true);
    expect(h.stub.requests).toHaveLength(before);
  }, 25_000);

  it("C-S8: a triggerTurn custom message reaches before_agent_start with union shape + details intact, and is persisted only AFTER the message_end extension event; the legacy shape reads as capability `absent`", async () => {
    const atEnd: boolean[] = [];
    let hRef!: Env;
    const h = await host({
      scheduler: false,
      extensions: [
        (api) =>
          api.on("message_end", (e: any) => {
            if (e.message?.customType === SCHED_CUSTOM_TYPE && e.message.details?.noteId === "n-wake")
              atEnd.push(customEntries(hRef, "n-wake").length > 0);
          }),
      ],
    });
    hRef = h;
    await prime(h);
    h.pi().sendMessage(
      {
        customType: SCHED_CUSTOM_TYPE,
        content: "wake",
        display: true,
        details: { kind: "message", token: "tok", noteId: "n-wake" },
      },
      { triggerTurn: true },
    );
    await until(() => h.settled.length === 2, "wake run settled");
    const trig = customStarts(h).at(-1);
    expect(trig).toMatchObject({
      messageType: "custom",
      message: { customType: SCHED_CUSTOM_TYPE, details: { kind: "message", token: "tok", noteId: "n-wake" } },
    });
    expect(atEnd).toEqual([false]); // not yet persisted when the extension saw message_end
    await until(() => customEntries(h, "n-wake").length === 1, "persisted after");
    // the legacy trigger shape (no messageType) turns the process capability into `absent` (⇒ dispatcher degrades)
    const legacy = new XsHostCapability();
    legacy.observe({ type: "before_agent_start", prompt: "legacy", systemPrompt: "" });
    expect(legacy.state).toBe("absent");
  }, 25_000);

  it("C-S6: in print mode the whole extension (schedule enabled) leaves no ref'd timer — the process exits by itself", async (ctx) => {
    let tsxOk = true;
    try {
      await import("tsx/esm/api");
    } catch {
      tsxOk = false;
    }
    if (!tsxOk) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), "schedule-print-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, "home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "pi-subagent.json"),
      JSON.stringify({
        schedule: { enabled: true, dir: join(dir, "sched") },
        webHub: { enabled: false },
        memory: { enabled: false },
        hud: { enabled: false },
        sessionNav: { enabled: false },
        askUser: { enabled: false },
        feishuNotify: { enabled: false },
        webSearch: { enabled: false },
        todo: { enabled: false },
      }),
    );
    const stub = await AnthropicStub.start();
    cleanups.push(() => stub.close());
    const script = resolve("tests/conformance/fixtures/schedule-print-child.mts");
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: resolve("."),
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        CHILD_DIR: join(dir, "work"),
        STUB_URL: stub.baseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (out += b.toString()));
    const code = await new Promise<number | null>((res) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        res(null);
      }, 40_000);
      child.once("exit", (c) => {
        clearTimeout(t);
        res(c);
      });
    });
    expect(out, out).toContain("DONE");
    expect(code, `child hung (${Date.now() - started} ms): ${out}`).toBe(0);
    expect(
      readFileSync(script, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, ""),
    ).not.toContain("process.exit");
  }, 60_000);
});
