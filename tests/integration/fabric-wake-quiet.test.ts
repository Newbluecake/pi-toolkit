import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { makeMessageKey, type FabricRecord } from "../../src/core/message.js";
import type { DeliveryPayload, DriverEvent } from "../../src/core/types.js";
import { PiSessionDriver, type SessionHandle } from "../../src/runtime/session-driver.js";
import { buildSessionStack, createBackgroundCompletionEventHook } from "../../src/stack.js";
import { resetBackgroundCompletionHealthForTest } from "../../src/service/background-completions.js";
import activate from "../../src/index.js";
import { tuiContext } from "../ask-user/bg-harness.js";
import { inboxRecord, snapshot, target } from "../helpers/fabric-inbox.js";
import { applyDiag } from "../helpers/fabric-revive.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * W6 (fabric-cross-session plan §3.7, §R1 #16): a wake-revived run's completion is QUIET — no turn, no hub token, no
 * broadcast. Part A pins the sink on a real stack (single, digest split, re-delivery, message_start isolation); part B
 * drives the REAL `activate()` + REAL ask_user (TUI and RPC) + a REAL revive and shows an active dialog is untouched
 * while a normal completion still interrupts it.
 */
let home: ReturnType<typeof sandboxHome>;
const dirs: string[] = [];
beforeEach(() => {
  home = sandboxHome();
  resetBackgroundCompletionHealthForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  home.restore();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:host")];
});

// ── Part A: the sink on a real stack ──────────────────────────────────────────────────────────────────────────────
type Sent = { message: { customType: string; content: string; details?: Record<string, unknown> }; options?: unknown };
function fakePi() {
  const sent: Sent[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: () => undefined,
    sendMessage: (message: Sent["message"], options?: unknown) =>
      sent.push({ message, ...(options ? { options } : {}) }),
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, sent };
}
function fakeCtx(): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "quiet-test",
      getSessionFile: () => undefined,
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    cwd: process.cwd(),
    isIdle: () => false, // an agent run is in flight: the interrupt-relevant case
  } as unknown as ExtensionContext;
}
const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;
const settingsWith = (o: Partial<AgentSettings> = {}): AgentSettings => ({
  ...DEFAULT_SETTINGS,
  fleetWidget: false,
  bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  ...o,
});
const payload = (runId: string, quiet = false): DeliveryPayload => ({
  key: `${runId}:1`,
  runId,
  generation: 1,
  status: "completed",
  textPreview: `done ${runId}`,
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
  ...(quiet ? { quiet: true as const } : {}),
});

describe("W6 quiet sink (real stack, hub observed through its public port)", () => {
  it("a quiet completion is sent triggerTurn:false, mints no token and broadcasts nothing; a normal one still does", () => {
    const host = fakePi();
    const stack = buildSessionStack(host.pi, fakeCtx(), settingsWith(), types, []);
    const events: unknown[] = [];
    stack.backgroundCompletions.subscribe((e) => events.push(e));

    stack.notifier.enqueue(payload("r_quiet", true));
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.options).toEqual({ triggerTurn: false });
    expect(host.sent[0]!.message).toMatchObject({ customType: "subagent:notification", display: true });
    expect(host.sent[0]!.message.details).toMatchObject({ runId: "r_quiet", quiet: true });
    expect(events).toEqual([]);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(0);

    // control on the same stack: the legacy path is unchanged byte for byte
    stack.notifier.enqueue(payload("r_loud"));
    expect(host.sent[1]!.options).toEqual({ triggerTurn: true });
    expect(host.sent[1]!.message.details).not.toHaveProperty("quiet");
    expect(events).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(1);
  });

  it("a MIXED digest splits into two sends: the quiet half (no token) and the normal half (one token)", () => {
    const host = fakePi();
    const stack = buildSessionStack(
      host.pi,
      fakeCtx(),
      settingsWith({ coalesceWindowMs: 100, coalesceMaxBatch: 3 }),
      types,
      [],
    );
    const events: unknown[] = [];
    stack.backgroundCompletions.subscribe((e) => events.push(e));
    stack.notifier.enqueue(payload("q1", true));
    stack.notifier.enqueue(payload("n1"));
    stack.notifier.enqueue(payload("q2", true));
    expect(host.sent).toHaveLength(2);
    const [quiet, loud] = host.sent as [Sent, Sent];
    expect(quiet.options).toEqual({ triggerTurn: false });
    expect(quiet.message.details).toMatchObject({ kind: "digest", quiet: true });
    expect((quiet.message.details as { items: { runId: string }[] }).items.map((i) => i.runId)).toEqual(["q1", "q2"]);
    expect(loud.options).toEqual({ triggerTurn: true });
    expect(loud.message.details).toMatchObject({ runId: "n1" });
    expect(loud.message.details).not.toHaveProperty("quiet");
    expect(events).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);
  });

  it("an all-quiet digest is one quiet send with no token", () => {
    const host = fakePi();
    const stack = buildSessionStack(
      host.pi,
      fakeCtx(),
      settingsWith({ coalesceWindowMs: 100, coalesceMaxBatch: 2 }),
      types,
      [],
    );
    const events: unknown[] = [];
    stack.backgroundCompletions.subscribe((e) => events.push(e));
    stack.notifier.enqueue(payload("q1", true));
    stack.notifier.enqueue(payload("q2", true));
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.options).toEqual({ triggerTurn: false });
    expect(host.sent[0]!.message.details).toMatchObject({ kind: "digest", quiet: true });
    expect(events).toEqual([]);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(0);
  });

  it("a recovered / re-delivered quiet notice (outbox reconcile, later round) stays quiet", () => {
    const host = fakePi();
    const stack = buildSessionStack(host.pi, fakeCtx(), settingsWith(), types, []);
    const events: unknown[] = [];
    stack.backgroundCompletions.subscribe((e) => events.push(e));
    const now = Date.now();
    stack.notifier.reconcile([
      { ...payload("r_redeliver", true), createdAt: now, state: "pending", attempts: 0, reconcileRound: 0 },
      // a schema-held (staged) notice released by the pre-finalize fallback keeps its quiet marker too
      { ...payload("r_stale", true), createdAt: now, state: "staged", attempts: 0, reconcileRound: 0 },
    ]);
    expect(host.sent).toHaveLength(2);
    for (const sent of host.sent) {
      expect(sent.options).toEqual({ triggerTurn: false });
      expect(sent.message.details).toMatchObject({ quiet: true });
    }
    expect(host.sent.map((s) => s.message.details?.runId).sort()).toEqual(["r_redeliver", "r_stale"]);
    expect(events).toEqual([]);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(0);
  });

  it("message_start of a quiet notice neither confirms another notice's pending token nor counts as unmatched", () => {
    const host = fakePi();
    const stack = buildSessionStack(host.pi, fakeCtx(), settingsWith(), types, []);
    const hook = createBackgroundCompletionEventHook({ current: stack });
    stack.notifier.enqueue(payload("r_loud"));
    expect(stack.backgroundCompletions.tokenState(1)).toBe("pending");
    stack.notifier.enqueue(payload("r_quiet", true));
    const quiet = host.sent[1]!.message;
    hook.onMessageStart({
      message: { role: "custom", customType: quiet.customType, content: quiet.content, details: quiet.details },
    });
    expect(stack.backgroundCompletions.tokenState(1)).toBe("pending"); // NOT consumed by the quiet one
    expect(stack.backgroundCompletions.diag).toMatchObject({ mismatch: 0, unmatched: 0 });
    const loud = host.sent[0]!.message;
    hook.onMessageStart({
      message: { role: "custom", customType: loud.customType, content: loud.content, details: loud.details },
    });
    expect(stack.backgroundCompletions.tokenState(1)).toBe("consumed");
  });
});

// ── Part B: real activate() + real ask_user + real revive ───────────────────────────────────────────────────────────
const ASK = { questions: [{ question: "Quiet gate?", options: [{ label: "A" }, { label: "B" }] }] };
type Tool = { execute: (...args: never[]) => Promise<unknown> };

function activateHost(sm: SessionManager) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, Tool>();
  const sent: Sent[] = [];
  const pi = {
    registerTool: (tool: { name: string } & Tool) => {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    },
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: (message: Sent["message"], options?: unknown) =>
      sent.push({ message, ...(options ? { options } : {}) }),
    appendEntry: (kind: string, data: unknown) => sm.appendCustomEntry(kind, data),
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    getAllTools: () => [...tools.values()],
    setActiveTools: () => undefined,
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, emit, sent, tools };
}
function writeSettings(): void {
  const path = join(home.home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      askUser: { backgroundInterrupt: { delayS: 0, quietS: 0, maxDeferS: 0, reaskDwellS: 0, rpc: true } },
      fabric: { enabled: true, minIntervalS: 0, rootMinIntervalS: 0 },
      bashJobs: { autoBackgroundS: 0 },
    }),
  );
}
/** Scripted child sessions: `create` finishes at once (the control run); `resume` (the revive) finishes on demand. */
function scriptDrivers() {
  const callbacks = new Map<SessionHandle, (e: DriverEvent) => void>();
  let release: (() => void) | undefined;
  let resumed = false;
  const base = (): Omit<SessionHandle, "prompt"> => ({
    sessionId: "quiet-child",
    sessionFile: undefined,
    steer: async () => undefined,
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools() {},
    getActiveTools: () => [],
    getLastAssistantText: () => "revived text",
    getUsage: () => undefined,
  });
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation((async () => ({
    ...base(),
    prompt: () => Promise.resolve(),
  })) as never);
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation((async () => {
    resumed = true;
    const handle: SessionHandle = {
      ...base(),
      prompt: () => {
        callbacks.get(handle)?.({ t: "input_accepted" });
        callbacks.get(handle)?.({ t: "turn_start" });
        return new Promise<void>((r) => {
          release = r;
        });
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
  return { resumed: () => resumed, finish: () => release?.() };
}
function seedSession() {
  const sm = SessionManager.inMemory(process.cwd());
  const dir = mkdtempSync(join(tmpdir(), "w6-quiet-"));
  dirs.push(dir);
  const file = join(dir, "child.jsonl");
  writeFileSync(file, "persisted child session");
  const prev = snapshot(target, { status: "completed", phase: "settled", updatedAt: Date.now() });
  applyDiag(prev.diag, { sessionFile: file, agentType: "general-purpose", label: "old-worker", wakeExclusion: "none" });
  sm.appendCustomEntry("subagent:run", prev);
  // a root-authored wake:true directive to the finished run: revived the moment the stack starts
  const record: FabricRecord = inboxRecord({
    key: makeMessageKey("root", target, 1, 1),
    from: "root",
    kind: "directive",
    seq: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ttlMs: 600_000,
    wake: true,
    level: 0,
    payload: { text: "please look again" },
  });
  delete (record as { parked?: unknown }).parked;
  sm.appendCustomEntry("subagent:fabric", record);
  return sm;
}
function hangAsk(host: ReturnType<typeof activateHost>, mode: "tui" | "rpc") {
  const tool = host.tools.get("ask_user")!;
  let done = false;
  let cancel: () => void;
  let ctx: unknown;
  if (mode === "tui") {
    const tui = tuiContext();
    ctx = tui.ctx;
    cancel = () => tui.created.forEach((c) => c.cancel());
  } else {
    let resolveSelect: ((v: string | undefined) => void) | undefined;
    ctx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        select: (_t: string, _o: string[], opts?: { signal?: AbortSignal }) =>
          new Promise<string | undefined>((resolve) => {
            resolveSelect = resolve;
            opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      },
    };
    cancel = () => resolveSelect?.(undefined);
  }
  const promise = tool.execute(
    `c-${mode}`,
    ASK as never,
    undefined as never,
    undefined as never,
    ctx as never,
  ) as Promise<{
    content: { text?: string }[];
  }>;
  void promise.finally(() => {
    done = true;
  });
  return { promise, settled: () => done, cancel };
}

describe.each(["tui", "rpc"] as const)("W6 revive completion vs an active ask_user (%s dialog)", (mode) => {
  it("is delivered quietly and does NOT interrupt/defer the dialog; a normal completion on the same host still does", async () => {
    writeSettings();
    const drivers = scriptDrivers();
    const sm = seedSession();
    const host = activateHost(sm);
    activate(host.pi);
    const ctx = {
      sessionManager: sm,
      cwd: process.cwd(),
      hasUI: false,
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: {},
      isIdle: () => false,
    };
    await host.emit("session_start", {}, ctx);
    // the stack-start pump revived the finished run; its prompt is still running
    await vi.waitFor(() => expect(drivers.resumed()).toBe(true), { timeout: 5_000 });

    const ask = hangAsk(host, mode);
    await new Promise((r) => setTimeout(r, 50));
    drivers.finish();
    await vi.waitFor(() => expect(host.sent.some((s) => s.message.customType === "subagent:notification")).toBe(true), {
      timeout: 5_000,
    });
    const quiet = host.sent.find((s) => s.message.customType === "subagent:notification")!;
    expect(quiet.options).toEqual({ triggerTurn: false });
    expect(quiet.message.details).toMatchObject({ quiet: true, status: "completed" });
    // zero-delay interrupt timings: a broadcast would have interrupted by now
    await new Promise((r) => setTimeout(r, 300));
    expect(ask.settled(), "quiet completion must not interrupt the active ask_user").toBe(false);

    // control: a NORMAL background completion on the very same wiring interrupts the same dialog
    await (host.tools.get("Agent")!.execute as (...a: unknown[]) => Promise<unknown>)(
      "a-control",
      { description: "bg control", prompt: "finish", subagent_type: "general-purpose" },
      undefined,
    );
    const result = await ask.promise;
    expect(result.content[0]?.text).toMatch(/interrupt/i);
    expect(
      host.sent.filter((s) => (s.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === true),
    ).toHaveLength(1);
    await host.emit("session_shutdown", {}, ctx);
  }, 20_000);
});
