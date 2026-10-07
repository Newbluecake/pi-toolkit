import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { RuntimeRunner } from "../../src/runtime/runner.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import { RPC_REQUEST_CHANNEL, RPC_VERSION, replyChannel } from "../../src/rpc/protocol.js";

/**
 * agent-explicit-timeout-extend plan §7 收尾 X1-X6 (★ 真实程序生产者入口):
 * every program-derived producer keeps its fixed deadline — asserted by
 * intercepting the exact (ResolvedSpawnRequest, DeadlineBudget) pair the REAL
 * RuntimeRunner would execute (`vi.spyOn(RuntimeRunner.prototype, "run")`,
 * calling through), driven from each producer's REAL entry point through the
 * REAL activate()/stack (only the child-session process is a PiSessionDriver
 * stub — a fake driver must never bypass the SpawnService).
 *
 *  X1 workflow child run  — real SubagentWorkflow(timeout_s) → child pinned
 *     to W.hardAt (fixed, factor 1) while the workflow itself stays 2×.
 *  X2 consult fork        — the injected consult tool ("main" expert).
 *  X3 /goal verifier      — the /goal command + loop hook.
 *  X4 memory tidy         — the /mem tidy command (readonly tool domain).
 *  X5 RPC spawn           — the stack's RPC server on the events bus; a
 *                           request smuggling `timeoutPolicy` is rejected.
 *  X6 literal guard       — the only `timeoutPolicy: "extendable"` write in
 *                           src/ is the Agent tool (auxiliary, not a shape test).
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const STATUS_KEY = Symbol.for("pi-subagent:background-status");

type Handler = (event: unknown, ctx: unknown) => unknown;
type Sent = { message: { customType: string; content: string; details: any }; options?: { triggerTurn?: boolean } };
type Cmd = { description: string; handler: (args: string, ctx: unknown) => Promise<void> };

function fakePi(branch: unknown[]) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Cmd>();
  const sent: Sent[] = [];
  const busEvents: { channel: string; payload: any }[] = [];
  const busListeners = new Map<string, Array<(payload: unknown) => void>>();
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool as ToolDefinition);
    },
    registerCommand(name: string, options: Cmd) {
      commands.set(name, options);
    },
    registerEntryRenderer() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(message: Sent["message"], options?: Sent["options"]) {
      sent.push({ message, ...(options ? { options } : {}) });
      branch.push({
        type: "custom_message",
        customType: message.customType,
        details: message.details,
        timestamp: new Date().toISOString(),
      });
    },
    sendUserMessage() {},
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
    events: {
      on(channel: string, listener: (payload: unknown) => void) {
        busListeners.set(channel, [...(busListeners.get(channel) ?? []), listener]);
        return () => {
          const list = busListeners.get(channel) ?? [];
          const idx = list.indexOf(listener);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      emit(channel: string, payload: unknown) {
        busEvents.push({ channel, payload });
        for (const listener of [...(busListeners.get(channel) ?? [])]) listener(payload);
      },
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  const baseCtx = {
    cwd: process.env.HOME,
    hasUI: false,
    mode: "print",
    sessionManager: {
      getEntries: () => branch,
      getBranch: () => branch,
      getSessionId: () => `explicit-timeout-producers-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      getSessionFile: () => undefined,
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: () => undefined },
  };
  const ctx = (overrides: Record<string, unknown> = {}) =>
    ({ ...baseCtx, ...overrides }) as unknown as ExtensionContext;
  const emit = async (event: string, payload: unknown = {}, eventCtx?: ExtensionContext) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, eventCtx ?? ctx());
  };
  const call = async (name: string, params: Record<string, unknown>, callCtx?: ExtensionContext) =>
    (await tools.get(name)!.execute!(
      "tc",
      params as never,
      undefined as never,
      undefined as never,
      (callCtx ?? ctx()) as never,
    )) as {
      content: { type: string; text: string }[];
      details: any;
    };
  return { pi: pi as unknown as ExtensionAPI, tools, commands, sent, busEvents, emit, call, ctx };
}

function writeAgentFiles(home: string) {
  const dir = join(home, ".pi", "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.md"), "---\nname: worker\ndescription: worker\n---\nYou work.\n");
}

function writeSettings(home: string, extra: Record<string, unknown> = {}) {
  const settingsPath = join(home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        budget: { totalGraceS: 1, maxExtensions: 2, abortGraceS: 0.05, reapS: 0.05 }, // factor stays the DEFAULT 2 (X1's 120s arithmetic)
        fleetWidget: false,
        quota: { enabled: false },
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}

let home = "";
let realHome: string | undefined;
let scratch = "";

beforeEach(() => {
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  home = mkdtempSync(join(tmpdir(), "pi-producers-home-"));
  realHome = process.env.HOME;
  process.env.HOME = home;
  scratch = mkdtempSync(join(tmpdir(), "pi-producers-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function until(pred: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface DriverCall {
  kind: "create" | "resume";
  spec: { customTools?: unknown[] };
}
let handleSeq = 0;
function makeHandle(dir: string, hang: boolean) {
  const file = join(dir, `child-${++handleSeq}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: `c${handleSeq}` })}\n`);
  return {
    sessionId: `c${handleSeq}`,
    sessionFile: file,
    prompt: () => (hang ? new Promise<void>(() => undefined) : Promise.resolve()),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello from subagent",
    getUsage: () => undefined,
  };
}
/** create() and resume() hang independently configurable (consult: hanging
 *  parent, resolving fork; everything else: one flag for both). */
function stubDriver(hang: { create: () => boolean; resume?: () => boolean }) {
  const calls: DriverCall[] = [];
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async (spec) => {
    calls.push({ kind: "create", spec: spec as DriverCall["spec"] });
    return makeHandle(scratch, hang.create()) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async (_file, spec) => {
    calls.push({ kind: "resume", spec: spec as DriverCall["spec"] });
    return makeHandle(scratch, hang.resume?.() ?? hang.create()) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "bind").mockResolvedValue(undefined);
  return { calls };
}

interface Captured {
  req: {
    runId: string;
    timeoutPolicy?: string;
    parentRunId?: string;
    deadlineAt?: number;
    forkSessionFrom?: string;
    // label/budgetOverride/toolDomain are consumed before the runner (NOT_THREADED);
    // the runner sees label via displayMeta and the readonly domain via toolScope.policy.
    displayMeta?: { label?: string };
    toolScope?: { policy?: { allow?: ReadonlySet<string> } };
  };
  budget: { maxTotalFactor: number; maxExtensions: number; totalMs: number };
}
function spyRunnerRun() {
  const captured: Captured[] = [];
  const original = RuntimeRunner.prototype.run;
  vi.spyOn(RuntimeRunner.prototype, "run").mockImplementation(function (this: RuntimeRunner, req, budget) {
    captured.push({ req: req as Captured["req"], budget });
    return original.call(this, req, budget);
  });
  return captured;
}

const toolOf = (spec: { customTools?: unknown[] }, name: string) =>
  (spec.customTools ?? []).find((t) => (t as { name?: string }).name === name) as
    | {
        execute: (
          id: string,
          params: Record<string, unknown>,
          u1: undefined,
          u2: undefined,
          u3: undefined,
        ) => Promise<{ content: { type: string; text: string }[]; details: any }>;
      }
    | undefined;

describe("program-derived producers stay fixed (X1-X6, real entries)", () => {
  it("X1: a SubagentWorkflow(timeout_s) child run is fixed and pinned to W.hardAt while the workflow keeps factor 2", async () => {
    writeAgentFiles(home);
    writeSettings(home, { workflow: { enabled: true } });
    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver({ create: () => true }); // the child never finishes; we stop early
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    const script =
      'export const meta = { name: "fixed-child-flow", description: "t" };\nphase("work");\nconst r = await agent("child that never finishes");\nreturn r;';
    const started = await host.call("SubagentWorkflow", { script, timeout_s: 60 });
    const wfId = started.details.workflowId as string;
    // The workflow itself is extendable: 60s × default factor 2 = 120s hard ceiling.
    expect(started.content[0]!.text).toContain("budget: 1m00s (extendable up to 2m00s)");

    await until(() => captured.some((c) => c.req.parentRunId === wfId));
    const child = captured.find((c) => c.req.parentRunId === wfId)!;
    expect(child.req.timeoutPolicy).toBe("fixed"); // E2: children never widen
    expect(child.budget.maxTotalFactor).toBe(1);

    // Pinned: the child's absolute deadline IS the workflow's hard ceiling,
    // read exactly through the real extend tool's result (hardDeadlineAt).
    const wfStartedWall = Date.now();
    const ext = await host.call("extend_subagent_timeout", { run_id: wfId, extend_s: 1, reason: "read ceiling" });
    expect(ext.details).toMatchObject({ ok: true, workflowId: wfId });
    const wfHardAt = ext.details.hardDeadlineAt as number;
    expect(child.req.deadlineAt).toBe(wfHardAt);
    // H = start + ceil(2 × 60s): bracket the start with the wall clock taken
    // right after the (sub-second) dispatch returned.
    expect(wfHardAt - wfStartedWall).toBeGreaterThan(119_000);
    expect(wfHardAt - wfStartedWall).toBeLessThanOrEqual(120_000 + 1_000);

    // Clean up: stop the workflow; its child must not outlive it.
    await host.call("abort_subagent", { run_id: wfId });
    await until(async () => {
      const read = await host.call("get_subagent_result", { run_id: wfId });
      return read.details.status !== "running";
    });
    await until(async () => {
      const read = await host.call("get_subagent_result", { run_id: child.req.runId });
      return ["aborted", "timed_out", "failed"].includes(String(read.details?.status));
    });
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it('X2: a consult run (injected consult tool, "main" expert) is fixed at settings.consult.timeoutMs', async () => {
    writeAgentFiles(home);
    writeSettings(home, { consult: { enabled: true, timeoutS: 20 } });
    // A valid "main session" file the consult fork machinery can read.
    const mainSessionFile = join(scratch, "main-session.jsonl");
    writeFileSync(
      mainSessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "host", timestamp: "t", cwd: scratch })}\n`,
    );
    const branch: unknown[] = [];
    const host = fakePi(branch);
    const driver = stubDriver({ create: () => true, resume: () => false }); // parent hangs, fork resolves
    const captured = spyRunnerRun();
    activate(host.pi);
    const ctx = host.ctx({
      sessionManager: {
        getEntries: () => branch,
        getBranch: () => branch,
        getSessionId: () => "producers-consult",
        getSessionFile: () => mainSessionFile,
      },
      model: { provider: "acme", id: "host-model" },
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 1 }),
    });
    await host.emit("session_start", { reason: "startup" }, ctx);

    // Real entry: the top-level Agent tool's `experts` param resolves through
    // the stack's consult wiring, and the child session really gets the tool.
    const started = await host.call(
      "Agent",
      { description: "asker", prompt: "ask the host", subagent_type: "worker", experts: ["main"] },
      ctx,
    );
    const askerRunId = started.details.runId as string;
    await until(() => driver.calls.some((c) => toolOf(c.spec, "consult") !== undefined));
    const consultTool = toolOf(driver.calls.find((c) => toolOf(c.spec, "consult") !== undefined)!.spec, "consult")!;

    const answer = await consultTool.execute(
      "consult-1",
      { expert: "main", question: "what did we decide?" },
      undefined,
      undefined,
      undefined,
    );
    expect(answer.details).toMatchObject({ expertRunId: "main" });

    await until(() => captured.some((c) => c.req.forkSessionFrom !== undefined));
    const consultRun = captured.find((c) => c.req.forkSessionFrom !== undefined)!;
    expect(consultRun.req.parentRunId).toBe(askerRunId);
    expect(consultRun.req.timeoutPolicy).toBe("fixed");
    expect(consultRun.budget.maxTotalFactor).toBe(1);
    expect(consultRun.budget.totalMs).toBe(20_000); // settings.consult.timeoutS (merged into the budget)
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("X3: the /goal verifier run is fixed at settings.goal.evalTimeoutMs (real /goal + loop hook)", async () => {
    writeAgentFiles(home);
    writeSettings(home, { hud: { enabled: false }, goal: { verifierType: "worker", evalTimeoutS: 20 } });
    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver({ create: () => false, resume: () => false }); // the verifier settles at once
    const captured = spyRunnerRun();
    activate(host.pi);
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = host.ctx({
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      hasPendingMessages: () => false,
      cwd: scratch,
      // The default goal.verifierModelHint is a strict pair — admission checks
      // it against the host registry, so expose exactly that model.
      modelRegistry: {
        getAvailable: () => [{ provider: "cloudrouter-anthropic", id: "claude-sonnet-5", name: "Verifier" }],
        find: (provider: string, id: string) =>
          provider === "cloudrouter-anthropic" && id === "claude-sonnet-5"
            ? { provider, id, name: "Verifier" }
            : undefined,
      },
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
        setStatus: () => undefined,
        setEditorComponent: () => () => undefined,
        getEditorComponent: () => undefined,
        setFooter: () => () => undefined,
        addAutocompleteProvider: () => undefined,
      },
    });
    await host.emit("session_start", { reason: "startup" }, ctx);

    // Real entry: the /goal command handler activate() registered.
    const goal = host.commands.get("goal");
    expect(goal).toBeDefined();
    await goal!.handler('fix the tests --until "all tests green" --max-turns 5', ctx);

    // Real entry: the loop hook's agent_end/agent_settled pair drives evaluate().
    await host.emit(
      "agent_end",
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            usage: { input: 100, output: 50, cacheRead: 0, cost: { total: 0.02 } },
          },
        ],
      },
      ctx,
    );
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);

    await until(() => captured.some((c) => c.req.displayMeta?.label === "goal-eval-1"));
    const verifier = captured.find((c) => c.req.displayMeta?.label === "goal-eval-1")!;
    expect(verifier.req.timeoutPolicy).toBe("fixed");
    expect(verifier.budget.maxTotalFactor).toBe(1);
    expect(verifier.budget.totalMs).toBe(20_000); // settings.goal.evalTimeoutS (merged into the budget)
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("X4: a /mem tidy proposal run is fixed, factor 1, readonly tool domain (real /mem command)", async () => {
    writeAgentFiles(home);
    writeSettings(home, { hud: { enabled: false }, memory: { tidy: { agentType: "worker" } } });
    const proj = join(scratch, "proj");
    mkdirSync(proj, { recursive: true });
    const memRoot = join(scratch, "mem");
    const slugDir = join(memRoot, proj.replace(/\/+$/, "").replace(/\//g, "-"));
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "core.md"), "# Notes\n\nkeep this tidy\n");
    vi.stubEnv("ARMORY_MEMORY_ROOT", memRoot);

    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver({ create: () => false, resume: () => false }); // the proposal run settles
    const captured = spyRunnerRun();
    activate(host.pi);
    const ctx = host.ctx({
      hasUI: true,
      mode: "tui",
      cwd: proj,
      model: { provider: "acme", id: "tidy-model" },
      ui: {
        notify: () => undefined,
        confirm: async () => true,
        setStatus: () => undefined,
        setEditorComponent: () => () => undefined,
        getEditorComponent: () => undefined,
        setFooter: () => () => undefined,
        addAutocompleteProvider: () => undefined,
      },
    });
    await host.emit("session_start", { reason: "startup" }, ctx);

    // Real entry: the /mem command handler activate() registered; the tidy
    // port reaches the CURRENT session's real SpawnService (index.ts wiring).
    const mem = host.commands.get("mem");
    expect(mem).toBeDefined();
    await mem!.handler("tidy", ctx);

    await until(() => captured.some((c) => c.req.displayMeta?.label === "mem-tidy"));
    const tidy = captured.find((c) => c.req.displayMeta?.label === "mem-tidy")!;
    expect(tidy.req.timeoutPolicy).toBe("fixed");
    expect(tidy.budget.maxTotalFactor).toBe(1);
    // P0-r: toolDomain is consumed by the adapter (NOT_THREADED) — the
    // runner-visible footprint of the readonly domain is the toolScope policy's
    // allow set (the builtin readonly four).
    const allow = tidy.req.toolScope?.policy?.allow;
    expect(allow).toBeInstanceOf(Set);
    for (const name of ["read", "grep", "find", "ls"]) expect(allow!.has(name)).toBe(true);
    expect(tidy.budget.totalMs).toBe(180_000); // memory.tidy.timeoutMs default (merged into the budget)
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("X5: an RPC spawn is fixed; a request smuggling timeoutPolicy is schema-rejected", async () => {
    writeAgentFiles(home);
    writeSettings(home);
    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver({ create: () => false, resume: () => false });
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // The fake pi's events bus dispatches to listeners — the stack's RPC
    // server subscribed at session_start, so emitting a request reaches it.
    const emitRpc = (requestId: string, params: Record<string, unknown>) => {
      (host.pi as unknown as { events: { emit: (c: string, p: unknown) => void } }).events.emit(RPC_REQUEST_CHANNEL, {
        version: RPC_VERSION,
        requestId,
        method: "spawn",
        params,
      });
    };
    // A legitimate remote spawn with an explicit budget: fixed, factor 1.
    emitRpc("req-ok", {
      type: "worker",
      prompt: "remote job",
      label: "rpc-fixed",
      budgetOverride: { totalMs: 30_000 },
    });
    await until(() => host.busEvents.some((e) => e.channel === replyChannel("req-ok")));
    await until(() => captured.some((c) => c.req.displayMeta?.label === "rpc-fixed"));
    const rpcRun = captured.find((c) => c.req.displayMeta?.label === "rpc-fixed")!;
    expect(rpcRun.req.timeoutPolicy).toBe("fixed");
    expect(rpcRun.budget.maxTotalFactor).toBe(1);
    expect(rpcRun.budget.totalMs).toBe(30_000);
    await until(() =>
      host.busEvents.some((e) => e.channel === replyChannel("req-ok") && (e.payload as { ok?: boolean }).ok === true),
    );

    // Smuggled policy: SpawnParamsSchema (additionalProperties: false) rejects
    // it — no run is ever created (C11: the whitelist structurally cannot
    // carry the field) and the reply is an error.
    emitRpc("req-smuggle", {
      type: "worker",
      prompt: "try to widen me",
      label: "rpc-smuggle",
      budgetOverride: { totalMs: 30_000 },
      timeoutPolicy: "extendable",
    });
    await until(() => host.busEvents.some((e) => e.channel === replyChannel("req-smuggle")));
    const smuggleReply = host.busEvents.find((e) => e.channel === replyChannel("req-smuggle"))!.payload as {
      ok: boolean;
      error?: { message: string };
    };
    expect(smuggleReply.ok).toBe(false);
    expect(smuggleReply.error?.message).toContain("invalid spawn params");
    expect(captured.filter((c) => c.req.displayMeta?.label === "rpc-smuggle")).toHaveLength(0);
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("X6 (auxiliary guard): the extendable literal is written only by the Agent tool", () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else if (name.endsWith(".ts") && readFileSync(path, "utf8").match(/timeoutPolicy:\s*["']extendable["']/))
          hits.push(path);
      }
    };
    walk(srcRoot);
    expect(hits).toEqual([join(srcRoot, "tools", "agent-tool.ts")]);
  });
});
