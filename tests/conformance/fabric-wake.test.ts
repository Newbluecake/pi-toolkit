/**
 * W2 peer-upgrade gates C-P1/C-P2, W6 gate C-P3, G gates C-P4/C-P5 (fabric-cross-session plan v3 §8/R10).
 * Real pi AgentSession + SessionManager.open + PiSessionDriver + RuntimeRunner.
 * Only the provider is scripted, using the existing boundary harness: no network,
 * API keys or opt-in required. These tests assert events AND the resulting evidence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { DriverEvent } from "../../src/core/types.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { MessageAgentParams, MessageAgentParamsWithWake } from "../../src/tools/message-agent-tool.js";
import { snapshot, target } from "../helpers/fabric-inbox.js";
import { applyDiag } from "../helpers/fabric-revive.js";
import { sandboxHome } from "../integration/helpers/home-sandbox.js";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { RunState, SessionSpec } from "../../src/core/types.js";
import { RuntimeRunner, BasicEffectInterpreter } from "../../src/runtime/runner.js";
import {
  PiSessionDriver,
  PiSessionHandle,
  type SessionDriver,
  type SessionHandle,
} from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { assistantTextMsg, disposeHarnessDirs, withSession } from "./agent-session-harness.js";

afterEach(disposeHarnessDirs);
const scripted = [
  { toolCall: false, build: (model: Parameters<typeof assistantTextMsg>[0]) => assistantTextMsg(model, "answer") },
];
const budget = { ...DEFAULT_BUDGET, totalMs: 60_000, totalGraceMs: 0 };
function runner(driver: SessionDriver) {
  const clock = new FakeClock();
  const states: RunState[] = [];
  const store = new MemoryRunStore();
  const runtime = new RuntimeRunner({
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store,
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter({
      persist_snapshot: (e) => {
        if (e.kind === "persist_snapshot") store.put(e.snapshot);
      },
    }),
    emit() {},
    deliver() {},
    onStateChange: (_id, state) => {
      states.push(state);
    },
  });
  return { runtime, states, store };
}

describe("fabric wake input markers — real pi contracts", () => {
  it("C-P1: resume prompt emits user message_end for NEW input, and persists inputAcceptedAt", async () => {
    await withSession({ scripted, persist: true, tools: [] }, async ({ session, cwd, modelRuntime }) => {
      await session.prompt("previous turn (must not be mistaken for acceptance)");
      const file = session.sessionFile!;
      expect(existsSync(file)).toBe(true);
      const pi = new PiSessionDriver();
      const raw: Array<{ type: string; message?: { role?: string; content?: unknown } }> = [];
      let resumed: PiSessionHandle | undefined;
      const driver: SessionDriver = {
        create: (spec) => pi.create(spec),
        resume: async (path, spec) => {
          // Dependency injection follows agent-session-harness: real pi, scripted provider only.
          const options = {
            ...spec,
            cwd,
            agentDir: join(cwd, ".pi-agent"),
            modelRuntime,
            resourceLoader: session.resourceLoader,
            settingsManager: session.settingsManager,
            tools: [],
          };
          resumed = (await pi.resume(path, options)) as PiSessionHandle;
          resumed.session.subscribe((event) => raw.push(event as never));
          return resumed;
        },
        bind: (h, cb) => pi.bind(h, cb),
        onLateArrival: (p, cb) => pi.onLateArrival(p, cb),
      };
      const t = runner(driver);
      const outcome = await t.runtime.run(
        { runId: "r_resume_input", prompt: "new resumed input", resumeFrom: file, trackInput: true },
        budget,
      );
      expect(outcome.status).toBe("completed");
      const users = raw.filter((e) => e.type === "message_end" && e.message?.role === "user");
      expect(users).toHaveLength(1);
      expect(JSON.stringify(users[0]!.message?.content)).toContain("new resumed input");
      expect(JSON.stringify(users)).not.toContain("previous turn");
      expect(raw.some((e) => e.type === "turn_start")).toBe(true);
      expect(outcome.diag.promptDispatchedAt).toBe(0);
      expect(outcome.diag.inputAcceptedAt).toBe(0);
      expect(outcome.diag).not.toHaveProperty("promptOutcome");
      expect(t.states.some((s) => s.status !== "completed" && s.diag.inputAcceptedAt === 0)).toBe(true);
      expect(t.store.get("r_resume_input")?.outcome?.diag.inputAcceptedAt).toBe(0);
      expect(
        resumed!.session.sessionManager
          .getBranch()
          .some(
            (e) =>
              e.type === "message" &&
              e.message.role === "user" &&
              JSON.stringify(e.message.content).includes("new resumed input"),
          ),
      ).toBe(true);
    });
  });

  it("C-P2: invalid (missing) model rejects prompt before turn_start / user acceptance", async () => {
    await withSession({ scripted, tools: [] }, async ({ session, modelRuntime }) => {
      // AgentSession's documented prompt preflight: no selected model. Public Agent state,
      // not a mocked prompt or injected rejection; no provider request should be made.
      session.agent.state.model = undefined as never;
      const raw: Array<{ type: string; message?: { role?: string } }> = [];
      session.subscribe((event) => raw.push(event as never));
      const pi = new PiSessionDriver();
      const handle = new PiSessionHandle(session);
      const driver: SessionDriver = {
        create: async (_spec: SessionSpec) => handle,
        bind: (h, cb) => pi.bind(h, cb),
        onLateArrival: (p, cb) => pi.onLateArrival(p, cb),
      };
      const t = runner(driver);
      const outcome = await t.runtime.run(
        { runId: "r_rejected_input", prompt: "refuse this before run", trackInput: true },
        budget,
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.message).toMatch(/no model/i);
      expect(raw.filter((e) => e.type === "turn_start")).toEqual([]);
      expect(raw.filter((e) => e.type === "message_end" && e.message?.role === "user")).toEqual([]);
      expect(modelRuntime.callCount()).toBe(0);
      expect(outcome.diag.promptDispatchedAt).toBe(0);
      expect(outcome.diag).not.toHaveProperty("inputAcceptedAt");
      expect(outcome.diag).not.toHaveProperty("lastTurnStartAt");
      expect(outcome.diag.promptOutcome).toBe("rejected_pre_accept");
      expect(t.store.get("r_rejected_input")?.outcome?.diag.promptOutcome).toBe("rejected_pre_accept");
    });
  });
});

/**
 * C-P3 (W6, plan §3.7/§8): a QUIET completion notice — `sendMessage({customType:"subagent:notification",…},
 * {triggerTurn:false})`, which is exactly `session.sendCustomMessage` — never starts a turn and never steers, whether the
 * session is idle or streaming. This is the pi fact the whole quiet path (stack.ts `sendFormatted`, no hub token, no
 * ask_user interrupt) rests on; the `triggerTurn:true` controls prove the harness WOULD see a turn/steer.
 */
describe("C-P3: quiet completion notice does not start a turn (real pi)", () => {
  const quiet = (content: string) =>
    ({
      customType: "subagent:notification",
      content,
      display: true,
      details: { quiet: true },
    }) as const;
  const noticeEntries = (session: { sessionManager: { getBranch(): unknown[] } }, content: string) =>
    session.sessionManager
      .getBranch()
      .filter((e) => (e as { type?: string; content?: unknown }).type === "custom_message")
      .filter((e) => JSON.stringify((e as { content?: unknown }).content) === JSON.stringify(content));
  const tick = () => new Promise((r) => setTimeout(r, 25));

  it("idle: triggerTurn:false appends the notice with no turn and no provider call; triggerTurn:true (control) starts a run", async () => {
    await withSession({ scripted, tools: [] }, async ({ session, modelRuntime }) => {
      const events: string[] = [];
      session.subscribe((e) => events.push((e as { type: string }).type));
      await session.prompt("first");
      expect(modelRuntime.callCount()).toBe(1);
      const before = events.filter((t) => t === "agent_start").length;

      await session.sendCustomMessage(quiet("quiet-idle"), { triggerTurn: false });
      await tick();
      expect(modelRuntime.callCount()).toBe(1);
      expect(session.isStreaming).toBe(false);
      expect(events.filter((t) => t === "agent_start").length).toBe(before);
      expect(noticeEntries(session, "quiet-idle")).toHaveLength(1); // persisted in the session branch

      // control: the very same message WITH triggerTurn starts a new run
      await session.sendCustomMessage(quiet("loud-idle"), { triggerTurn: true });
      await vi_waitFor(() => modelRuntime.callCount() === 2);
    });
  });

  it("streaming: triggerTurn:false is NOT steered (no queued message, no extra turn); triggerTurn:true (control) is", async () => {
    // a provider that holds the response open ⇒ the session is genuinely streaming
    await withSession({ scripted, tools: [] }, async ({ session, modelRuntime }) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const requests: unknown[][] = [];
      const base = modelRuntime.streamSimple;
      (modelRuntime as { streamSimple: unknown }).streamSimple = (m: unknown, context: { messages?: unknown[] }) => {
        requests.push(context.messages ?? []);
        if (requests.length > 1) return base(m, context);
        const stream = createAssistantMessageEventStream();
        void gate.then(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: assistantTextMsg(m as Parameters<typeof assistantTextMsg>[0], "answer") as never,
          }),
        );
        return stream;
      };
      const events: string[] = [];
      session.subscribe((e) => events.push((e as { type: string }).type));
      const run = session.prompt("long run");
      await vi_waitFor(() => session.isStreaming && requests.length === 1);

      await session.sendCustomMessage(quiet("quiet-stream"), { triggerTurn: false });
      expect(session.agent.hasQueuedMessages()).toBe(false); // not a steer
      await tick();
      expect(requests).toHaveLength(1); // no extra provider request while streaming

      release();
      await run;
      await tick();
      // no extra turn once the run ended either: still exactly the one request, one agent run
      expect(requests).toHaveLength(1);
      expect(events.filter((t) => t === "agent_start")).toHaveLength(1);
      expect(session.isStreaming).toBe(false);
      // …and the notice is not lost: it reached the persisted session branch exactly once
      expect(noticeEntries(session, "quiet-stream")).toHaveLength(1);
    });
  });

  it("streaming control: the same notice with triggerTurn:true IS queued as a steer (what the interrupt path relies on)", async () => {
    await withSession({ scripted, tools: [] }, async ({ session, modelRuntime }) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started = 0;
      const base = modelRuntime.streamSimple;
      (modelRuntime as { streamSimple: unknown }).streamSimple = (m: unknown, context: { messages?: unknown[] }) => {
        started += 1;
        if (started > 1) return base(m, context);
        const stream = createAssistantMessageEventStream();
        void gate.then(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: assistantTextMsg(m as Parameters<typeof assistantTextMsg>[0], "answer") as never,
          }),
        );
        return stream;
      };
      const run = session.prompt("long run");
      await vi_waitFor(() => session.isStreaming && started === 1);
      await session.sendCustomMessage(quiet("loud-stream"), { triggerTurn: true });
      expect(session.agent.hasQueuedMessages()).toBe(true);
      release();
      await run;
    });
  });
});

async function vi_waitFor(check: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 5; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}

/**
 * C-P4 (G, plan §8): the `message_agent` parameter schema, wake off / on, as a REAL pi AgentSession sees it after pi's own
 * tool registration — pi must neither mutate nor reorder it. Off ⇒ byte-identical to the S0 off-state golden (captured
 * before any wake code); on ⇒ today's three fields + one optional boolean `wake`, pinned by the W1 golden.
 */
describe("C-P4: message_agent schema golden through real pi tool registration", () => {
  const fixture = (name: string) =>
    JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as Record<string, unknown>;
  const registeredParameters = async (parameters: unknown): Promise<unknown> => {
    let seen: unknown;
    await withSession(
      {
        scripted,
        tools: ["message_agent"],
        extensionFactories: [
          (pi: { registerTool: (t: unknown) => void }) =>
            pi.registerTool({
              name: "message_agent",
              label: "message_agent",
              description: "conformance stand-in",
              parameters,
              execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
            }),
        ],
      },
      async ({ session }) => {
        const tool = session.getAllTools().find((t) => t.name === "message_agent");
        expect(tool).toBeDefined();
        seen = JSON.parse(JSON.stringify(tool!.parameters));
      },
    );
    return seen;
  };

  it("wake off: pi hands the model exactly the pre-wake schema (S0 golden, no `wake` property)", async () => {
    const seen = (await registeredParameters(MessageAgentParams)) as { properties: Record<string, unknown> };
    expect(seen).toEqual(fixture("fabric-wake-off-golden.json")["messageAgentSchema"]);
    expect(seen.properties).not.toHaveProperty("wake");
  });
  it("wake on: pi hands the model the W1 golden (three fields + optional boolean wake)", async () => {
    const seen = (await registeredParameters(MessageAgentParamsWithWake)) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(seen).toEqual(fixture("message-agent-wake-schema-golden.json"));
    expect(Object.keys(seen.properties).at(-1)).toBe("wake");
    expect(seen.required).not.toContain("wake");
  });
});

/**
 * C-P5 (G, plan §3.8/§8): a REAL in-memory pi session (`SessionManager.inMemory`, no session file) — a real stack's
 * inbox durability is `session-memory`; a `wake:false` finding to a finished run PARKS (via the real `message_agent`
 * tool, which reports `inboxDurability`) and the parked record is still pending, with the same hint in the status view,
 * after the stack is rebuilt on the same SessionManager (the /reload path).
 */
describe("C-P5: real in-memory session — park survives a stack rebuild and carries the durability hint", () => {
  const home = { current: undefined as ReturnType<typeof sandboxHome> | undefined };
  const dirs: string[] = [];
  const stacks: Stack[] = [];
  afterEach(() => {
    for (const st of stacks.splice(0)) {
      st.fabric?.dispose();
      st.worktreeLate?.dispose();
      st.bashJobs?.dispose();
      st.keepalive?.dispose();
      st.quota?.dispose();
    }
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    home.current?.restore();
  });
  const worker = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" as const };
  const sender = { ...worker, name: "waker", canMessage: ["sibling" as const] };
  const types = {
    get: (n: string) => (n === "worker" ? worker : n === "waker" ? sender : undefined),
    list: () => [worker, sender],
    reload: async () => ({ types: [worker, sender], errors: [] }),
    configHashOf: () => undefined,
  } as AgentTypeRegistry;
  const settings: AgentSettings = {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    fabric: {
      ...DEFAULT_SETTINGS.fabric,
      enabled: true,
      wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: true },
      minIntervalMs: 0,
      rootMinIntervalMs: 0,
    },
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  };
  async function until(check: () => boolean, ms = 4000) {
    for (let i = 0; i < ms / 5; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(check()).toBe(true);
  }
  type MessageTool = { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> };

  it("session-memory durability, `inboxDurability` hint on the park, record still parked after a rebuild", async () => {
    home.current = sandboxHome();
    const sm = SessionManager.inMemory(process.cwd());
    expect(sm.getSessionFile()).toBeUndefined(); // the real pi fact C-P5 rests on
    const dir = mkdtempSync(join(tmpdir(), "cp5-"));
    dirs.push(dir);
    const file = join(dir, "child.jsonl");
    writeFileSync(file, "persisted child session");
    const prev = snapshot(target, { status: "completed", phase: "settled", updatedAt: Date.now() });
    applyDiag(prev.diag, { sessionFile: file, agentType: "worker", label: "old-worker", wakeExclusion: "none" });
    sm.appendCustomEntry("subagent:run", prev);
    const pi = {
      appendEntry: (k: string, d: unknown) => sm.appendCustomEntry(k, d),
      sendMessage: vi.fn(),
      registerEntryRenderer() {},
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
      events: { on: () => () => undefined, emit() {} },
    } as unknown as ExtensionAPI;
    const ctx = {
      sessionManager: sm,
      cwd: process.cwd(),
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: {},
    } as unknown as ExtensionContext;

    const tools: MessageTool[] = [];
    const callbacks = new Map<SessionHandle, (e: DriverEvent) => void>();
    vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation((async (spec: { customTools?: unknown[] }) => {
      tools.push(
        (spec.customTools ?? []).find((t) => (t as { name?: string }).name === "message_agent") as MessageTool,
      );
      const handle: SessionHandle = {
        sessionId: "cp5-child",
        sessionFile: undefined,
        steer: async () => undefined,
        requestAbort: async () => undefined,
        dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
        killableHandles: new Set(),
        setActiveTools() {},
        getActiveTools: () => [],
        getLastAssistantText: () => "",
        getUsage: () => undefined,
        prompt: () => {
          callbacks.get(handle)?.({ t: "turn_start" });
          return new Promise<void>(() => undefined);
        },
      };
      return handle;
    }) as never);
    vi.spyOn(PiSessionDriver.prototype, "bind").mockImplementation((async (
      h: SessionHandle,
      cb: (e: DriverEvent) => void,
    ) => {
      callbacks.set(h, cb);
    }) as never);

    const stack = buildSessionStack(pi, ctx, settings, types, []);
    stacks.push(stack);
    expect(stack.wake!.status().durability).toBe("session-memory");
    const spawned = await stack.spawn.spawn({ type: "waker", prompt: "i am a sender" });
    if (!("runId" in spawned)) throw new Error(spawned.error.message);
    await until(() => stack.query.get(spawned.runId)?.status === "running" && tools.length === 1);

    const sent = await tools[0]!.execute("t1", {
      to: target,
      kind: "finding",
      text: "keep this for later",
      wake: false,
    });
    expect(sent.details).toMatchObject({
      ok: true,
      status: "accepted",
      wake: false,
      inboxDurability: "session-memory",
    });
    expect(sent.details).not.toHaveProperty("parkUnavailable");
    expect(stack.wake!.status().parked).toBe(1);

    // /reload path: a NEW stack on the SAME in-memory SessionManager still sees the parked, undelivered record
    stack.fabric!.dispose();
    const rebuilt = buildSessionStack(pi, ctx, settings, types, []);
    stacks.push(rebuilt);
    rebuilt.fabric!.pump();
    expect(rebuilt.wake!.status()).toMatchObject({ durability: "session-memory", parked: 1 });
    const records = sm
      .getEntries()
      .filter((e) => e.type === "custom" && e.customType === "subagent:fabric")
      .map((e) => (e as { data: { state: string; parked?: { reason: string }; to: string } }).data)
      .filter((d) => d.to === target);
    expect(records.at(-1)).toMatchObject({ state: "pending", parked: { reason: "wake_false" } });
  });
});
