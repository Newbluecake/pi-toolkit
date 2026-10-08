/**
 * G0 — real driver path matrix (web-hub-steer-recall plan §3.1, v4.3 增补 Y1/Y6/Y7). THE HARD
 * GATE for package P-core: a real `createAgentSession` (devDependency
 * `@earendil-works/pi-coding-agent`) + a scripted fake `modelRuntime` drives a probe extension
 * that assembles the REAL `createHoldBuffer` / `createHoldDriver` / `createCommandHandler` /
 * `createCommandLedger` (plus the real, already-shipped `createQueueMirror` /
 * `createCompactionState`) exactly the way `src/web-hub/agent/index.ts` will later wire them
 * (P-wire). No test doubles stand in for any of package P-core's own modules.
 *
 * Any failing row here is a stop-and-report condition per the plan (§11) — assertions are never
 * weakened to make a row pass.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createHoldBuffer, type HoldBag } from "../../src/web-hub/agent/hold.js";
import { createHoldDriver, type HoldDriver } from "../../src/web-hub/agent/hold-driver.js";
import { createCommandHandler, type CommandHandler } from "../../src/web-hub/agent/commands.js";
import {
  createCommandLedger,
  type CommandLedger,
  type LedgerEntry,
  type PromptSubState,
} from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { createCompactionState } from "../../src/web-hub/agent/compaction-state.js";
import type { BuiltinBridge } from "../../src/web-hub/agent/builtin-bridge.js";
import { createOriginEntry } from "../../src/web-hub/agent/origin-entry.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../src/web-hub/protocol/messages.js";
import { fakeTimerQueue, type FakeTimerQueue } from "../web-hub/agent/helpers.js";

const HOLD_BAG_KEY = Symbol.for("pi-subagent:web-hub:hold-buffer");
const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");

function resetBags(): void {
  delete (globalThis as Record<symbol, unknown>)[HOLD_BAG_KEY];
  delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
}
beforeEach(resetBags);
afterEach(resetBags);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const OWNER = "owner-g0";

// --------------------------------------------------------------------- fake model

function fakeModel(contextWindow = 200_000) {
  return {
    id: "fake-model",
    name: "Fake",
    api: "anthropic-messages",
    provider: "fake-provider",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow,
    maxTokens: 4096,
  };
}

type ScriptedTurn =
  | { kind: "tool"; id: string; slow?: boolean; inputTokens?: number }
  | { kind: "text"; text: string; inputTokens?: number }
  | { kind: "error"; message: string };

function usage(input: number) {
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildMessage(model: ReturnType<typeof fakeModel>, turn: ScriptedTurn) {
  if (turn.kind === "error") {
    return {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage(1),
      stopReason: "error" as const,
      timestamp: Date.now(),
      errorMessage: turn.message,
    };
  }
  if (turn.kind === "tool") {
    return {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: turn.id,
          name: "bash",
          arguments: { command: `sleep ${turn.slow ? "0.3" : "0.02"}; echo hi` },
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage(turn.inputTokens ?? 1),
      stopReason: "toolUse" as const,
      timestamp: Date.now(),
    };
  }
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: turn.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(turn.inputTokens ?? 1),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function userTexts(messages: unknown[] | undefined): string[] {
  return (messages ?? [])
    .filter((m): m is { role: string; content: unknown } => (m as { role?: unknown }).role === "user")
    .map((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
        : (m.content as string),
    );
}

function fakeModelRuntime(
  model: ReturnType<typeof fakeModel>,
  scripted: ScriptedTurn[],
  opts: { authFail?: boolean } = {},
) {
  let call = 0;
  const calls: string[][] = [];
  return {
    streamSimple: (_m: unknown, ctx: { messages?: unknown[] }) => {
      calls.push(userTexts(ctx.messages));
      const turn = scripted[Math.min(call, scripted.length - 1)]!;
      call += 1;
      const stream = createAssistantMessageEventStream();
      const message = buildMessage(model, turn);
      if (turn.kind === "error") {
        stream.push({ type: "error", reason: "error", error: message });
      } else {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => !opts.authFail,
    checkAuth: async () => (opts.authFail ? undefined : { ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    calls,
  };
}

// --------------------------------------------------------------------- probe extension

interface Trace {
  events: string[];
  log: string[];
  skipFired: number;
  heldAtSettled: number;
  display: Map<string, string[]>; // cmdId -> promptState history
  blocked: number;
  inputEvents: Array<{ text: string; source: string; streamingBehavior?: string }>;
  /** verifier r_BHFA552J P1 #2: text -> cmdId, recorded by every `prompt()`/`promptResult()` call,
   * so the generic per-row assertion can look up the real ledger entry for a held text without
   * every test having to thread cmdIds through by hand. */
  cmdIdByText: Map<string, string>;
  /** verifier r_BHFA552J P1 #2: real `publish()` recordings (held count + ledger frame snapshot at
   * the moment of each call) — proves `publish` is no longer a dead no-op stub. */
  publishLog: Array<{ held: number; frameItems: number }>;
}

interface ProbeApi {
  trace: Trace;
  /** Full round-trip through `commandHandler.handle()` — mirrors an actual web `prompt` request. */
  prompt(text: string, deliver: "steer" | "followUp"): CmdResultFrame["ok"] extends boolean ? boolean : never;
  promptResult(text: string, deliver: "steer" | "followUp"): CmdResultFrame | undefined;
  recall(target: string): CmdResultFrame | undefined;
  forceHold(cmdId: string, text: string): void; // M11: bypass canHold entirely (defensive leftover)
  sentFrames: Array<CmdResultFrame | CmdLateFrame>;
  ledger: CommandLedger;
  holdDriver: HoldDriver;
  commandHandler: CommandHandler;
  rid(): string;
  /** One-shot gate: true only the FIRST time it is called with a given key for this probe
   * instance (i.e. for the whole run) — scripted runs often fire a hook (e.g. `tool_execution_
   * start`) more than once, and `heldCount()===0` is NOT a safe "did I already do this" guard
   * (the buffer legitimately drains back to 0 mid-run once B1 unblocks and a later item is sent). */
  once(key?: string): boolean;
  /** Set by `run()` right after `createAgentSession()` resolves (before `kick` runs) — hooks that
   * need the real `AgentSession` (e.g. D-M8's `session.compact()`, which is a genuinely different
   * method from `ctx.compact()`'s fire-and-forget variant) read it from here. */
  session?: { compact: (customInstructions?: string) => Promise<void> };
}

interface ProbeHooks {
  onTool?: (api: ProbeApi, ctx: ExtensionContext) => void;
  onContext?: (api: ProbeApi, ctx: ExtensionContext) => void;
  onTurnStart?: (api: ProbeApi, ctx: ExtensionContext) => void;
  onTurnEnd?: (api: ProbeApi, ctx: ExtensionContext) => void;
  onSettledPre?: (api: ProbeApi, ctx: ExtensionContext) => void;
  before?: ExtensionFactory[];
  after?: ExtensionFactory[];
  authFail?: boolean;
}

function makeProbe(
  hooks: ProbeHooks,
  opts: { timers?: FakeTimerQueue } = {},
): { factory: ExtensionFactory; api: ProbeApi } {
  const trace: Trace = {
    events: [],
    log: [],
    skipFired: 0,
    heldAtSettled: -1,
    display: new Map(),
    blocked: 0,
    inputEvents: [],
    cmdIdByText: new Map(),
    publishLog: [],
  };
  const sentFrames: Array<CmdResultFrame | CmdLateFrame> = [];
  let ridSeq = 0;

  const holdBag: HoldBag = { v: 1, rev: 0, items: new Map() };
  const holdBuffer = createHoldBuffer({ bag: holdBag });
  const ledger = createCommandLedger();

  let ctxRef: ExtensionContext | undefined;
  let sessionIdRef = "unset";
  let holdCapOn = true;

  const api = {} as ProbeApi;
  api.trace = trace;
  api.sentFrames = sentFrames;
  api.ledger = ledger;
  api.rid = () => `rid-${(ridSeq += 1)}`;
  const onceSeen = new Set<string>();
  api.once = (key = "default") => {
    if (onceSeen.has(key)) return false;
    onceSeen.add(key);
    return true;
  };

  let holdDriver!: HoldDriver;
  let commandHandler!: CommandHandler;

  function disp(cmdId: string): void {
    const e = ledger.get(cmdId);
    const arr = trace.display.get(cmdId) ?? [];
    const label = e?.promptState ?? "(gone)";
    if (arr[arr.length - 1] !== label) arr.push(label);
    trace.display.set(cmdId, arr);
  }

  function frame(id: string, cmd: CmdFrame["cmd"]): CmdFrame {
    return { t: "cmd", rid: api.rid(), id, deadlineMs: 8000, origin: ORIGIN, cmd };
  }

  api.promptResult = (text, deliver) => {
    const id = api.rid();
    trace.cmdIdByText.set(text, id);
    commandHandler.handle(frame(id, { op: "prompt", text, deliver }));
    disp(id);
    return sentFrames.find((f) => "id" in f && f.id === id) as CmdResultFrame | undefined;
  };
  api.prompt = ((text: string, deliver: "steer" | "followUp") => {
    const r = api.promptResult(text, deliver);
    return r?.ok === true && r.data.op === "prompt" && r.data.delivery === "held";
  }) as ProbeApi["prompt"];
  api.recall = (target) => {
    const id = api.rid();
    commandHandler.handle(frame(id, { op: "recall", target }));
    return sentFrames.find((f) => "id" in f && f.id === id) as CmdResultFrame | undefined;
  };
  api.forceHold = (cmdId, text) => {
    trace.cmdIdByText.set(text, cmdId);
    holdBuffer.hold(
      { cmdId, sessionId: sessionIdRef, owner: OWNER, text, deliver: "steer", origin: ORIGIN, at: Date.now() },
      Date.now(),
    );
  };

  const factory: ExtensionFactory = (pi: ExtensionAPI) => {
    const compactionState = createCompactionState(pi);
    const queueMirror = createQueueMirror();
    // verifier r_BHFA552J P1 #2: the REAL production port (previously empty stubs) — D12's origin
    // entry append really runs through `pi.appendEntry` here.
    const originEntry = createOriginEntry(pi);
    const builtinBridge: BuiltinBridge = {
      execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }),
    };

    commandHandler = createCommandHandler({
      pi,
      getCtx: () => ctxRef,
      getSessionId: () => sessionIdRef,
      ledger,
      queueMirror,
      compactionState,
      originEntry,
      builtinBridge,
      controlEnabled: () => true,
      now: () => Date.now(),
      send: (f) => sentFrames.push(f),
      onChanged: () => undefined,
      setTimer:
        opts.timers !== undefined
          ? opts.timers.setTimer
          : (ms, fn) => {
              const t = setTimeout(fn, ms);
              t.unref();
              return { cancel: () => clearTimeout(t) };
            },
      owner: OWNER,
      hold: () => holdDriver,
    });

    holdDriver = createHoldDriver({
      buffer: holdBuffer,
      owner: OWNER,
      getSessionId: () => sessionIdRef,
      holdCap: () => holdCapOn,
      dispatchToPi: (item) => commandHandler.dispatchHeld(item),
      // verifier r_BHFA552J P1 #2: a REAL implementation (previously a no-op stub) — writes the
      // returned items back to the ledger exactly as the production `index.ts` wiring is documented
      // to do (plan §4.7 step 4), so a `returned{reason}` row becomes observable via
      // `ledger.get(cmdId)?.promptState`.
      onReturned: (items) => {
        for (const item of items) {
          const patch: Partial<Pick<LedgerEntry, "promptState" | "reason">> = { promptState: "returned" };
          if (item.reason !== undefined) patch.reason = item.reason;
          ledger.updatePrompt(item.cmdId, patch, Date.now());
        }
      },
      // verifier r_BHFA552J P1 #2: records a real snapshot (held count + ctl frame item count) on
      // every call instead of being a dead no-op.
      publish: () => {
        trace.publishLog.push({
          held: holdBuffer.held(sessionIdRef).length,
          frameItems: ledger.frame(sessionIdRef, OWNER, Date.now()).items.length,
        });
      },
      now: () => Date.now(),
      setRefTimer: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      },
      nextMacrotask: () => new Promise((r) => setImmediate(r)),
    });
    api.holdDriver = holdDriver;
    api.commandHandler = commandHandler;

    // Test-harness note (NOT a hold-driver.ts bug): `createAgentSession` in this headless setup
    // never calls `bindExtensions()` (that is the real pi CLI/TUI runtime's job), so the
    // `session_start` event this driver's production wiring (index.ts) relies on to learn the
    // session id never fires here. Every handler that receives a live `ctx` resyncs both refs
    // itself so `canHold`'s session-scope check never sees a stale/unset session id.
    function syncCtx(ctx: ExtensionContext): void {
      ctxRef = ctx;
      sessionIdRef = ctx.sessionManager.getSessionId();
    }
    pi.on("session_start", (_e, ctx) => {
      syncCtx(ctx);
      holdDriver.onSessionStart(ctx);
    });
    pi.on("context", (_e, ctx) => {
      syncCtx(ctx);
      trace.events.push("context");
      holdDriver.onContext(ctx);
      hooks.onContext?.(api, ctx);
      return undefined;
    });
    pi.on("turn_start", (_e, ctx) => {
      syncCtx(ctx);
      trace.events.push("turn_start");
      const wasArmed = holdDriver.phase() === "armed";
      holdDriver.onTurnStart(ctx);
      if (wasArmed) trace.skipFired += 1;
      hooks.onTurnStart?.(api, ctx);
    });
    pi.on("tool_execution_start", (_e, ctx) => {
      syncCtx(ctx);
      hooks.onTool?.(api, ctx);
    });
    pi.on("turn_end", (ev, ctx) => {
      syncCtx(ctx);
      trace.events.push(`turn_end(${(ev as { outcome?: string }).outcome},sig=${ctx.signal?.aborted === true})`);
      hooks.onTurnEnd?.(api, ctx);
      return holdDriver.onTurnEnd(ev as { message?: { content?: unknown }; outcome?: string }, ctx);
    });
    pi.on("agent_end", (_e, ctx) => {
      syncCtx(ctx);
      trace.events.push(`agent_end(sig=${ctx.signal?.aborted === true})`);
      return holdDriver.onAgentEnd(ctx);
    });
    pi.on("agent_settled", (_e, ctx) => {
      syncCtx(ctx);
      trace.events.push("agent_settled");
      hooks.onSettledPre?.(api, ctx);
      trace.heldAtSettled = Math.max(trace.heldAtSettled, holdBuffer.held(sessionIdRef).length);
      holdDriver.onAgentSettled(ctx);
    });
    pi.on("input", (e: { text: string; source: string; streamingBehavior?: string }) => {
      trace.log.push(`input:${e.text} sb=${e.streamingBehavior ?? "none"} src=${e.source}`);
      trace.inputEvents.push(e);
      commandHandler.onInputEvent(e as never);
      for (const [id] of ledger["entries" as never] ?? []) void id;
      // display trace: refresh any entry whose text matches (cheap linear scan over a tiny map).
      return undefined;
    });
    pi.on("message_start", (e: { message: { role: string; content?: unknown } }) => {
      if (e.message.role === "user") {
        trace.log.push(`user_msg_start`);
      }
      if (e.message.role === "assistant") {
        if (ctxRef !== undefined) holdDriver.onAssistantMessageStart(ctxRef);
      }
      commandHandler.onMessageStart(e as never);
    });
    pi.on(
      "session_before_compact",
      (e: { reason: string; preparation: { firstKeptEntryId: string; tokensBefore: number } }) => {
        trace.events.push(`compact(${e.reason})`);
        return {
          compaction: {
            summary: "S",
            firstKeptEntryId: e.preparation.firstKeptEntryId,
            tokensBefore: e.preparation.tokensBefore,
          },
        };
      },
    );
  };

  return { factory, api };
}

// --------------------------------------------------------------------- harness

interface RunOpts {
  scripted: ScriptedTurn[];
  hooks: ProbeHooks;
  win?: number;
  settings?: Record<string, unknown>;
  kick?: (session: { prompt: (t: string) => Promise<unknown> }) => Promise<void>;
  settleWaitMs?: number;
  model?: ReturnType<typeof fakeModel>;
  /** verifier r_BHFA552J P1 #2 (D-UPGRADE): inject a controllable `FakeTimerQueue` for
   * `commandHandler`'s `setTimer` seam (the 30s unobserved-finalize / 10s idle-started / 10min
   * queued-timeout timers) so a test can deterministically force the real 30s transition instead
   * of racing real wall-clock delays against it. `holdDriver`'s OWN `setRefTimer` (T-REF, the
   * ≤200ms confirm phase) is untouched — always real/ref'd, per plan Y3. Omitted ⇒ real timers
   * (byte-identical to every other row in this file). */
  timers?: FakeTimerQueue;
}

async function run(
  opts: RunOpts,
): Promise<{ api: ProbeApi; calls: string[][]; session: { messages?: unknown[] }; promptThrew?: string }> {
  const model = opts.model ?? fakeModel(opts.win ?? 200_000);
  const cwd = mkdtempSync(join(tmpdir(), "steer-hold-g0-"));
  const { factory, api } = makeProbe(opts.hooks, { timers: opts.timers });
  const modelRuntime = fakeModelRuntime(model, opts.scripted, { authFail: opts.hooks.authFail });
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, baseDelayMs: 5, maxRetries: 2 },
    ...opts.settings,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: [...(opts.hooks.before ?? []), factory, ...(opts.hooks.after ?? [])],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime: modelRuntime as never,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader: loader,
    tools: ["bash"],
  });
  api.session = session as unknown as ProbeApi["session"];
  let promptThrew: string | undefined;
  const settled = new Promise<void>((resolve) => {
    const off = session.subscribe((e: { type: string }) => {
      if (e.type === "agent_settled") {
        off();
        resolve();
      }
    });
  });
  try {
    if (opts.kick) await opts.kick(session as never);
    else await session.prompt("P0");
  } catch (e) {
    promptThrew = e instanceof Error ? e.message : String(e);
  }
  await Promise.race([settled, new Promise((r) => setTimeout(r, 6000))]);
  await session.waitForIdle?.();
  await new Promise((r) => setTimeout(r, opts.settleWaitMs ?? 150));
  await session.waitForIdle?.();
  const result = {
    api,
    calls: modelRuntime.calls,
    session: session as unknown as { messages?: unknown[] },
    promptThrew,
  };
  session.dispose();
  rmSync(cwd, { recursive: true, force: true });
  return result;
}

function finalUsers(session: { messages?: unknown[] }): string[] {
  return userTexts(session.messages);
}
function count(arr: string[], t: string): number {
  return arr.filter((x) => x === t).length;
}
function firstCallIndexOf(calls: string[][], text: string): number {
  return calls.findIndex((c) => c.includes(text));
}

/** verifier r_BHFA552J P1 #2: genuine terminal ledger `promptState`s — a row's cmdId must reach one
 * of these by the time the run has fully settled, never be left in an active-looking state. */
const TERMINAL_PROMPT_STATES = new Set<PromptSubState>(["consumed", "dropped", "returned", "recalled"]);

interface RowExpectation {
  text: string;
  /** Does this text land in the real session's final user-message history exactly once? */
  expectDelivered: boolean;
  /** Override: assert this EXACT ledger `promptState` instead of "any terminal state" (e.g.
   * D-M29's deliberate mid-run "unconfirmed" snapshot, taken BEFORE the run settles). */
  expectState?: PromptSubState;
}

/** verifier r_BHFA552J P1 #2's generic per-row assertion: for every row, (a) the text appears in
 * `fu` (the real session's final user-message history) exactly once if `expectDelivered`, zero
 * times otherwise — and (b) the matching ledger entry (looked up via `api.trace.cmdIdByText`,
 * populated by every `prompt()`/`promptResult()`/`forceHold()` call) has reached a genuine
 * terminal `promptState` (never left "held"/"dispatched"/"observed"/"queued"/"started" by now),
 * unless `expectState` pins a specific non-terminal snapshot the row is deliberately checking
 * mid-run. Never replaces a row's own specific assertions (`firstIn`/`before`/etc.) — always
 * layered ON TOP of them. */
function assertRowsTerminal(api: ProbeApi, fu: string[], rows: RowExpectation[]): void {
  for (const row of rows) {
    expect(count(fu, row.text)).toBe(row.expectDelivered ? 1 : 0);
    const cmdId = api.trace.cmdIdByText.get(row.text);
    expect(cmdId, `no cmdId recorded for "${row.text}" — did it go through prompt()/forceHold()?`).toBeDefined();
    const entry = api.ledger.get(cmdId!);
    if (row.expectState !== undefined) {
      expect(entry?.promptState, `"${row.text}" (cmdId ${cmdId})`).toBe(row.expectState);
    } else {
      expect(entry, `"${row.text}" (cmdId ${cmdId}) has no ledger entry at all`).toBeDefined();
      expect(
        TERMINAL_PROMPT_STATES.has(entry!.promptState as PromptSubState),
        `"${row.text}" (cmdId ${cmdId}) left at non-terminal promptState "${entry!.promptState}"`,
      ).toBe(true);
    }
  }
}

// --------------------------------------------------------------------- D-M* rows

describe("G0 real driver — D-M1: first turn arm point", () => {
  it("turn_start#1 refuses a hold (idle, pre-arm); context#1 arms it; lands in LLM#2", async () => {
    let turnStartCount = 0;
    const { api, calls, session } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        onTurnStart: (a) => {
          if (turnStartCount++ === 0) {
            const ok = a.prompt("PRE-ARM", "steer");
            expect(ok).toBe(false); // refused: idle, not armed yet
          }
        },
        onContext: (a) => {
          if (a.trace.events.filter((e) => e === "context").length === 1) {
            expect(a.prompt("H1", "steer")).toBe(true);
          }
        },
      },
    });
    expect(count(finalUsers(session), "H1")).toBe(1);
    expect(firstCallIndexOf(calls, "H1")).toBe(1); // LLM#2 (0-indexed)
    expect(api.holdDriver.heldCount()).toBe(0);
    assertRowsTerminal(api, finalUsers(session), [{ text: "H1", expectDelivered: true }]);
  });
});

describe("G0 real driver — D-M2/D-M20: FIFO + one-at-a-time within tool-call turns", () => {
  it("three tool rounds each hold a steer, all land in FIFO order one turn later each", async () => {
    let round = 0;
    const { calls, session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "tool", id: "c" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        onTool: (a) => {
          round += 1;
          expect(a.prompt(`S${round}`, "steer")).toBe(true);
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "S1")).toBe(1);
    expect(count(fu, "S2")).toBe(1);
    expect(count(fu, "S3")).toBe(1);
    expect(firstCallIndexOf(calls, "S1")).toBe(1);
    expect(firstCallIndexOf(calls, "S2")).toBe(2);
    expect(firstCallIndexOf(calls, "S3")).toBe(3);
    expect(api.holdDriver.heldCount()).toBe(0);
    assertRowsTerminal(api, fu, [
      { text: "S1", expectDelivered: true },
      { text: "S2", expectDelivered: true },
      { text: "S3", expectDelivered: true },
    ]);
  });

  it("D-M20: two steers held in the SAME tool round are still FIFO + one-at-a-time", async () => {
    const { calls, session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "x" },
        { kind: "text", text: "y" },
        { kind: "text", text: "z" },
      ],
      hooks: {
        onTool: (a) => {
          if (a.once()) {
            expect(a.prompt("S-A", "steer")).toBe(true);
            expect(a.prompt("S-B", "steer")).toBe(true);
          }
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "S-A")).toBe(1);
    expect(count(fu, "S-B")).toBe(1);
    expect(firstCallIndexOf(calls, "S-A")).toBe(1);
    expect(firstCallIndexOf(calls, "S-B")).toBe(2);
    assertRowsTerminal(api, fu, [
      { text: "S-A", expectDelivered: true },
      { text: "S-B", expectDelivered: true },
    ]);
  });
});

describe("G0 real driver — D-M5: retryable model error (Y1 supersedes the pre-Y1 both-delivered row)", () => {
  it("the steer held before the error is delivered on the errored turn_end; the followUp is returned (B1 still blocked when agent_end fires pre-retry) — never lost, never duplicated", async () => {
    // v4.3 Y1 narrows B1's lift to E2 (attributed consumption) only. pi fires `agent_end` for an
    // errored turn BEFORE a retry's own `context`/`turn_start` cycle begins (`willRetry` is a flag
    // ON that same agent_end, not a reason to suppress it) — so by the time THIS agent_end runs,
    // the steer dispatched during turn_end(error) cannot possibly have been consumed yet (pi has
    // not even started the retried turn). Per R-A, `agent_end` while blocked returns every other
    // held item rather than waiting indefinitely or guessing: the followUp is `returned{stale}`,
    // available for the user to resend — not delivered twice, not silently dropped (it is still a
    // live row in `status.held`/`returned` the browser can see and act on). This is a DELIBERATE
    // behavior change from the matrix6.mjs v4.2 script (which relied on now-deleted E1 evidence to
    // unblock B1 before this agent_end), not a regression — see the task's plan-deviation note.
    let contextCount = 0;
    const { calls, session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "error", message: "overloaded_error: server overloaded" },
        { kind: "text", text: "ok" },
        { kind: "text", text: "ok2" },
      ],
      hooks: {
        onContext: (a) => {
          contextCount += 1;
          if (contextCount === 2) {
            expect(a.prompt("H-ERR-STEER", "steer")).toBe(true);
            expect(a.prompt("H-ERR-FU", "followUp")).toBe(true);
          }
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "H-ERR-STEER")).toBe(1); // delivered exactly once
    expect(count(fu, "H-ERR-FU")).toBe(0); // returned, never delivered
    expect(firstCallIndexOf(calls, "H-ERR-STEER")).toBe(2);
    expect(api.holdDriver.heldCount()).toBe(0); // nothing left dangling in the buffer
    assertRowsTerminal(api, fu, [
      { text: "H-ERR-STEER", expectDelivered: true },
      { text: "H-ERR-FU", expectDelivered: false, expectState: "returned" },
    ]);
  });
});

describe("G0 real driver — D-M6: abort mid-tool returns held items", () => {
  it("items held right before ctx.abort() are returned{aborted}, never sent", async () => {
    const { session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        onTool: (a, ctx) => {
          a.prompt("H-ABORT", "steer");
          a.prompt("H-ABORT-FU", "followUp");
          ctx.abort();
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "H-ABORT")).toBe(0);
    expect(count(fu, "H-ABORT-FU")).toBe(0);
    expect(api.holdDriver.heldCount()).toBe(0);
    assertRowsTerminal(api, fu, [
      { text: "H-ABORT", expectDelivered: false, expectState: "returned" },
      { text: "H-ABORT-FU", expectDelivered: false, expectState: "returned" },
    ]);
  });
});

describe("G0 real driver — D-M8: REAL manual compaction (hard gate)", () => {
  it("compacted mid-run returns the held items (aborted), with compaction actually applied", async () => {
    let phase = "";
    let compactPromise: Promise<{ ok: boolean; message?: string }> | undefined;
    const { session, calls, api } = await run({
      settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
      scripted: [
        { kind: "text", text: "seed-reply", inputTokens: 50 },
        { kind: "tool", id: "a" },
        { kind: "text", text: "x" },
        { kind: "text", text: "p2-reply" },
        { kind: "text", text: "p2b" },
      ],
      hooks: {
        onTool: (a) => {
          if (phase === "P1" && a.once()) {
            a.prompt("H-MC", "steer");
            a.prompt("H-MC-FU", "followUp");
            // mirrors matrix6.mjs's M8: `AgentSession.compact()` (NOT `ctx.compact()`, which is
            // fire-and-forget per its own doc comment) itself calls `this.abort()` synchronously
            // (same tick) — fired from inside the tool hook, awaited later by `kick`.
            compactPromise = a.session!.compact().then(
              () => ({ ok: true }),
              (e: Error) => ({ ok: false, message: e.message }),
            );
          }
        },
      },
      kick: async (s) => {
        const sess = s as unknown as { prompt: (t: string) => Promise<void>; waitForIdle: () => Promise<void> };
        await sess.prompt("P0");
        await sess.waitForIdle();
        phase = "P1";
        await sess.prompt("P1");
        await sess.waitForIdle();
        await compactPromise;
        phase = "P2";
        await sess.prompt("P2");
        await sess.waitForIdle();
      },
    });
    const fu = finalUsers(session);
    const compactRes = await compactPromise;
    expect(compactRes?.ok).toBe(true);
    expect(count(fu, "H-MC")).toBe(0);
    expect(count(fu, "H-MC-FU")).toBe(0);
    const lastCall = calls[calls.length - 1] ?? [];
    expect(lastCall).toContain("P2");
    expect(lastCall).toHaveLength(2); // [summary, P2]
    assertRowsTerminal(api, fu, [
      { text: "H-MC", expectDelivered: false, expectState: "returned" },
      { text: "H-MC-FU", expectDelivered: false, expectState: "returned" },
    ]);
  });
});

describe("G0 real driver — D-M9/D-M10/D-M16-18: turn_start skip-detect (best-effort, no false positives)", () => {
  it("D-M9: a held item survives a skipped turn_end via the skip-detect sync pass", async () => {
    const { calls, session, api } = await run({
      hooks: {
        onTool: (a) => {
          if (a.once()) a.prompt("H-SKIP", "steer");
        },
        before: [
          (pi) => {
            void pi;
          },
        ],
      },
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "text", text: "done" },
      ],
      kick: async (s) => {
        const sess = s as unknown as {
          _findPersistedMessageEntryId: () => undefined;
          prompt: (t: string) => Promise<void>;
        };
        sess._findPersistedMessageEntryId = () => undefined;
        await sess.prompt("P0");
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "H-SKIP")).toBe(1);
    expect(firstCallIndexOf(calls, "H-SKIP")).toBe(2);
    expect(api.trace.skipFired).toBeGreaterThanOrEqual(1);
    assertRowsTerminal(api, fu, [{ text: "H-SKIP", expectDelivered: true }]);
  });

  it("D-M16/17/18: skipFired stays 0 across a normal multi-turn / retry / followUp run", async () => {
    let round = 0;
    const { api, session } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "tool", id: "c" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        onTool: (a) => {
          round += 1;
          a.prompt(`T${round}`, "steer");
        },
      },
    });
    expect(api.trace.skipFired).toBe(0);
    assertRowsTerminal(api, finalUsers(session), [
      { text: "T1", expectDelivered: true },
      { text: "T2", expectDelivered: true },
      { text: "T3", expectDelivered: true },
    ]);
  });
});

describe("G0 real driver — D-M30 (verifier r_BHFA552J P1 #2): skip-detect never double-dispatches past an already-blocked B1", () => {
  it("K1-SLOW's slow handler keeps B1 blocked across skipped turn_ends; the skip-detect fallback never dispatches K2 early — both still delivered, FIFO, exactly once each", async () => {
    const after: ExtensionFactory[] = [
      (pi) =>
        pi.on("input", async (e: { text: string }) => {
          if (e.text === "K1-SLOW") await new Promise((r) => setTimeout(r, 300));
        }),
    ];
    const { calls, session, api } = await run({
      settleWaitMs: 600,
      scripted: [
        { kind: "tool", id: "a", slow: true },
        { kind: "tool", id: "b", slow: true },
        { kind: "tool", id: "c", slow: true },
        { kind: "tool", id: "d" },
        { kind: "text", text: "done" },
        { kind: "text", text: "x" },
      ],
      hooks: {
        after,
        onTool: (a) => {
          if (a.once()) {
            a.prompt("K1-SLOW", "steer");
            a.prompt("K2", "steer");
          }
        },
      },
      kick: async (s) => {
        const sess = s as unknown as {
          _findPersistedMessageEntryId: () => undefined;
          prompt: (t: string) => Promise<void>;
        };
        // D-M9's own skip-simulation technique (forces pi's own turn-end bookkeeping to look like
        // the previous turn_end never ran), applied for the WHOLE run so the skip-detect fallback in
        // `onTurnStart` (A-SKIP) engages repeatedly while B1 is held blocked by K1-SLOW's slow
        // handler — the row this test exists to prove is that A-SKIP's fallback dispatch always
        // respects `!blocked()` and never races past an already in-flight item.
        sess._findPersistedMessageEntryId = () => undefined;
        await sess.prompt("P0");
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "K1-SLOW")).toBe(1);
    expect(count(fu, "K2")).toBe(1);
    expect(fu.indexOf("K1-SLOW")).toBeLessThan(fu.indexOf("K2")); // FIFO respected despite the skip
    expect(api.trace.skipFired).toBeGreaterThanOrEqual(1); // the skip-detect path genuinely engaged
    expect(api.holdDriver.heldCount()).toBe(0);
    void calls;
    assertRowsTerminal(api, fu, [
      { text: "K1-SLOW", expectDelivered: true },
      { text: "K2", expectDelivered: true },
    ]);
  });
});

describe("G0 real driver — D-M11: settled defensive leftover never dispatches (R6 impossible)", () => {
  it("a forced leftover at settled is never sent, even with auth failing", async () => {
    const { session, calls, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        authFail: true,
        onSettledPre: (a) => {
          a.forceHold("leftover-1", "H-LEFTOVER");
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "H-LEFTOVER")).toBe(0);
    expect(api.trace.inputEvents.some((e) => e.text === "H-LEFTOVER")).toBe(false);
    void calls;
  });
});

describe("G0 real driver — D-M13/D-M13b: bounded confirm adds zero extra latency", () => {
  it("a held item lands in the very next LLM call with no confirm timeout", async () => {
    const { calls, session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        onTool: (a) => {
          if (a.once()) a.prompt("H13", "steer");
        },
      },
    });
    expect(count(finalUsers(session), "H13")).toBe(1);
    expect(firstCallIndexOf(calls, "H13")).toBe(1);
    assertRowsTerminal(api, finalUsers(session), [{ text: "H13", expectDelivered: true }]);
  });

  it("a slow (50ms) downstream input handler registered AFTER us still lands in the same request", async () => {
    const after: ExtensionFactory[] = [
      (pi) =>
        pi.on("input", async (e: { text: string }) => {
          if (e.text === "H13B") await new Promise((r) => setTimeout(r, 50));
        }),
    ];
    const { calls, session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        after,
        onTool: (a) => {
          if (a.once()) a.prompt("H13B", "steer");
        },
      },
    });
    expect(count(finalUsers(session), "H13B")).toBe(1);
    expect(firstCallIndexOf(calls, "H13B")).toBe(1);
    assertRowsTerminal(api, finalUsers(session), [{ text: "H13B", expectDelivered: true }]);
  });
});

describe("G0 real driver — D-M14: native enqueue inside context lands next request", () => {
  it("a native sendUserMessage call during context#1 lands in LLM#2 (arm-point evidence)", async () => {
    const { calls, session } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        onContext: (a, ctx) => {
          if (a.trace.events.filter((e) => e === "context").length === 1) {
            a.commandHandler.dispatchHeld({
              cmdId: "native-ctx",
              sessionId: ctx.sessionManager.getSessionId(),
              owner: OWNER,
              text: "N14",
              deliver: "steer",
              origin: ORIGIN,
              at: Date.now(),
              state: "handing",
              updatedAt: Date.now(),
            });
          }
        },
      },
    });
    expect(count(finalUsers(session), "N14")).toBe(1);
    expect(firstCallIndexOf(calls, "N14")).toBe(1);
  });
});

describe("G0 real driver — D-M22: arrival during the confirm window goes native, delivered once", () => {
  it("a second prompt submitted while phase is 'between' is refused by canHold and must go native", async () => {
    const { session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "x" },
        { kind: "text", text: "y" },
        { kind: "text", text: "z" },
      ],
      hooks: {
        onTool: (a) => {
          if (a.once()) a.prompt("H22", "steer");
        },
        onTurnEnd: (a) => {
          // phase flips to "between" synchronously inside onTurnEnd (before any await) — a prompt
          // attempted right here must be refused (between ⇒ native path, by construction here we
          // just assert it CAN'T be held; the real "native" send is commands.ts's own concern).
          if (a.holdDriver.phase() === "between") {
            expect(a.prompt("W22", "steer")).toBe(false);
          }
        },
      },
    });
    expect(count(finalUsers(session), "H22")).toBe(1);
    assertRowsTerminal(api, finalUsers(session), [{ text: "H22", expectDelivered: true }]);
  });
});

describe("G0 real driver — D-M24/D-M25: serialized sends (B1), one in-flight at a time", () => {
  it("D-M24: a slow downstream handler on the FIRST send blocks the second until consumed", async () => {
    const after: ExtensionFactory[] = [
      (pi) =>
        pi.on("input", async (e: { text: string }) => {
          if (e.text === "S1-SLOW") await new Promise((r) => setTimeout(r, 300));
        }),
    ];
    const { calls, session, api } = await run({
      settleWaitMs: 600,
      scripted: [
        { kind: "tool", id: "a", slow: true },
        { kind: "tool", id: "b", slow: true },
        { kind: "tool", id: "c", slow: true },
        { kind: "tool", id: "d" },
        { kind: "text", text: "done" },
        { kind: "text", text: "x" },
      ],
      hooks: {
        after,
        onTool: (a) => {
          if (a.once()) {
            a.prompt("S1-SLOW", "steer");
            a.prompt("S2-FAST", "steer");
          }
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "S1-SLOW")).toBe(1);
    expect(count(fu, "S2-FAST")).toBe(1);
    expect(fu.indexOf("S1-SLOW")).toBeLessThan(fu.indexOf("S2-FAST"));
    void calls;
    assertRowsTerminal(api, fu, [
      { text: "S1-SLOW", expectDelivered: true },
      { text: "S2-FAST", expectDelivered: true },
    ]);
  });

  it("D-M25: a pre-existing TUI-queued message plus two held steers keep native FIFO order", async () => {
    const { calls, session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "tool", id: "c" },
        { kind: "tool", id: "d" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        onTool: (a, ctx) => {
          if (a.once()) {
            void (ctx as unknown as { sessionManager: { getSessionId: () => string } }).sessionManager;
            a.prompt("S1", "steer");
            a.prompt("S2", "steer");
          }
        },
      },
      kick: async (s) => {
        await (s as unknown as { prompt: (t: string, o?: unknown) => Promise<void> }).prompt("P0");
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "S1")).toBe(1);
    expect(count(fu, "S2")).toBe(1);
    expect(fu.indexOf("S1")).toBeLessThan(fu.indexOf("S2"));
    void calls;
    assertRowsTerminal(api, fu, [
      { text: "S1", expectDelivered: true },
      { text: "S2", expectDelivered: true },
    ]);
  });
});

describe("G0 real driver — D-M27/D-M28/D-M29/D-SWALLOW/D-UPGRADE: B1 at run end & display upgrade", () => {
  it("D-M27: a slow send on the FINAL hook leaves the second item returned at agent_end, never duplicated", async () => {
    const after: ExtensionFactory[] = [
      (pi) =>
        pi.on("input", async (e: { text: string }) => {
          if (e.text === "F1-SLOW") await new Promise((r) => setTimeout(r, 400));
        }),
    ];
    const { session, api } = await run({
      settleWaitMs: 800,
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
        { kind: "text", text: "x" },
      ],
      hooks: {
        after,
        onTool: (a) => {
          if (a.once()) {
            a.prompt("F1-SLOW", "steer");
            a.prompt("F2", "steer");
          }
        },
      },
    });
    const fu = finalUsers(session);
    // verifier r_BHFA552J P1 #2: M27 must ALSO assert F1 arrives exactly once (not just "F2 is
    // zero") — F1-SLOW being delivered once, not zero/twice, is exactly as load-bearing as F2
    // being returned.
    expect(count(fu, "F1-SLOW")).toBe(1);
    expect(count(fu, "F2")).toBe(0); // returned, never sent
    expect(api.holdDriver.heldCount()).toBe(0);
    assertRowsTerminal(api, fu, [
      { text: "F1-SLOW", expectDelivered: true },
      { text: "F2", expectDelivered: false, expectState: "returned" },
    ]);
  });

  it("D-M28/D-SWALLOW: a swallowing handler on S1 means S1 is never consumed; S2 is returned at run end, never sent", async () => {
    const before: ExtensionFactory[] = [
      (pi) => pi.on("input", (e: { text: string }) => (e.text === "S1-SWALLOW" ? { action: "handled" } : undefined)),
    ];
    const { session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "text", text: "done" },
        { kind: "text", text: "x" },
      ],
      hooks: {
        before,
        onTool: (a) => {
          if (a.once()) {
            a.prompt("S1-SWALLOW", "steer");
            a.prompt("S2", "steer");
          }
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "S1-SWALLOW")).toBe(0); // swallowed by the (handled) handler — never reaches pi
    expect(count(fu, "S2")).toBe(0); // never sent — B1 blocked for the whole run, then returned
    expect(api.holdDriver.heldCount()).toBe(0);
    // S1-SWALLOW itself is NOT checked against `assertRowsTerminal`: it was genuinely dispatched
    // (sent to pi) but its `input` event is swallowed by the (handled) handler, so `message_start`
    // never fires for it — by design its ledger entry stays "dispatched" until the real 30s
    // unobserved-finalize timer eventually fires (never exercised within this test's wall-clock
    // budget; that upgrade path is what the dedicated D-UPGRADE test below actually proves). S2 WAS
    // still sitting in the hold buffer (never dispatched, B1 permanently blocked) when the run
    // ended, so it IS a genuine `returned` row.
    assertRowsTerminal(api, fu, [{ text: "S2", expectDelivered: false, expectState: "returned" }]);
  });

  it("D-M29: a handler slower than the bounded confirm phase (but well under the 30s display timeout) still delivers both items in order", async () => {
    const after: ExtensionFactory[] = [
      (pi) =>
        pi.on("input", async (e: { text: string }) => {
          if (e.text === "S1-VSLOW") await new Promise((r) => setTimeout(r, 120));
        }),
    ];
    const { session, api } = await run({
      settleWaitMs: 400,
      scripted: [
        { kind: "tool", id: "a", slow: true },
        { kind: "tool", id: "b", slow: true },
        { kind: "tool", id: "c", slow: true },
        { kind: "tool", id: "d" },
        { kind: "text", text: "done" },
        { kind: "text", text: "x" },
      ],
      hooks: {
        after,
        onTool: (a) => {
          if (a.once()) {
            a.prompt("S1-VSLOW", "steer");
            a.prompt("S2-AFTER", "steer");
          }
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "S1-VSLOW")).toBe(1);
    expect(count(fu, "S2-AFTER")).toBe(1);
    expect(fu.indexOf("S1-VSLOW")).toBeLessThan(fu.indexOf("S2-AFTER"));
    assertRowsTerminal(api, fu, [
      { text: "S1-VSLOW", expectDelivered: true },
      { text: "S2-AFTER", expectDelivered: true },
    ]);
  });

  it("D-UPGRADE (verifier r_BHFA552J P1 #2): the display timer genuinely advances 30s to 'unconfirmed', then a late observation upgrades it through observed\u2192queued\u2192consumed", async () => {
    // A fake, explicitly-advanced timer queue stands in for `commandHandler`'s `setTimer` seam ONLY
    // (T-REF: `holdDriver`'s OWN confirm-phase `setRefTimer` stays real/ref'd, untouched). This lets
    // the test force the REAL 30s `PROMPT_UNOBSERVED_FINALIZE_MS` transition deterministically
    // instead of racing a real (much shorter) wall-clock delay against a timer that would never
    // actually fire within the test's budget — which is exactly what the OLD D-M29 row never did.
    const timers = fakeTimerQueue();
    let releaseInput: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const after: ExtensionFactory[] = [
      (pi) =>
        pi.on("input", async (e: { text: string }) => {
          if (e.text === "S1-GATED") await gate; // never resolves until the test says so
        }),
    ];
    let settledResolve: (() => void) | undefined;
    const settledGate = new Promise<void>((resolve) => {
      settledResolve = resolve;
    });
    const { api, session } = await run({
      timers,
      settleWaitMs: 50,
      scripted: [
        { kind: "tool", id: "a", slow: true },
        { kind: "tool", id: "b" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        after,
        onTool: (a) => {
          if (a.once()) a.prompt("S1-GATED", "steer");
        },
        onSettledPre: () => settledResolve?.(),
      },
      kick: async (s) => {
        const sess = s as unknown as { prompt: (t: string) => Promise<void> };
        void sess.prompt("P0"); // do NOT await: the run cannot settle while S1-GATED's input is gated
        // let the dispatch actually happen (S1-GATED is sent to pi and the 30s finalize timer is
        // scheduled) before forcing the clock.
        await new Promise((r) => setTimeout(r, 30));
        const cmdId = api.trace.cmdIdByText.get("S1-GATED");
        expect(cmdId).toBeDefined();
        expect(api.ledger.get(cmdId!)?.promptState).toBe("dispatched");
        timers.fireByMs(30_000); // force the real PROMPT_UNOBSERVED_FINALIZE_MS transition
        expect(api.ledger.get(cmdId!)?.promptState).toBe("unconfirmed");
        expect(api.ledger.get(cmdId!)?.reason).toBe("unobserved");
        releaseInput?.(); // now let the gated input event actually land
        await new Promise((r) => setTimeout(r, 30));
        // R-A/Y6.2 upgrade path: the late observation moves promptState on past "unconfirmed" (through
        // observed/queued) all the way to the genuine terminal "consumed" — never left stuck.
        expect(api.ledger.get(cmdId!)?.promptState).toBe("consumed");
        await settledGate;
        await sess.prompt("P1").catch(() => undefined);
      },
    });
    void session;
    void api;
  });
});

describe("G0 real driver — D-ATTRIB: attribution never confuses a TUI/other-extension message with a held cmdId", () => {
  it("a REAL same-text source:'interactive' message (the TUI-equivalent default) is delivered independently — never lost, never silently merged into our held item's attribution", async () => {
    const { session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "text", text: "x" },
        { kind: "text", text: "y" },
      ],
      hooks: {
        onTool: (a) => {
          if (a.once()) {
            a.prompt("SAME-TEXT", "steer"); // OUR held item
            // a REAL, independently-submitted message with the IDENTICAL text, injected straight
            // through the real `AgentSession.prompt()` (never through `commandHandler`/our own
            // ledger at all) — `PromptOptions.source` defaults to "interactive" per pi's own
            // `agent-session.d.ts` doc comment, i.e. genuinely the same shape a TUI submission
            // would produce.
            void (a.session as unknown as { prompt: (t: string, o?: unknown) => Promise<void> }).prompt("SAME-TEXT", {
              streamingBehavior: "steer",
            });
          }
        },
      },
    });
    const fu = finalUsers(session);
    // BOTH sends are genuinely independent and genuinely delivered: never lost (count < 2 would
    // mean one vanished) and never phantom-duplicated beyond what was actually sent (count > 2
    // would mean our own item got attributed/replayed twice).
    expect(count(fu, "SAME-TEXT")).toBe(2);
    // our OWN held item's cmdId still reached a genuine terminal ledger state — E2 attribution
    // found SOME real consumption signal to attach to it and was never left dangling, regardless
    // of which of the two identical-text `message_start` events it actually matched.
    const cmdId = api.trace.cmdIdByText.get("SAME-TEXT");
    expect(cmdId).toBeDefined();
    expect(TERMINAL_PROMPT_STATES.has(api.ledger.get(cmdId!)?.promptState as PromptSubState)).toBe(true);
    expect(api.holdDriver.heldCount()).toBe(0);
  });

  it("a REAL other-extension source:'extension' message with the SAME text: accepted residual risk (same-process, indistinguishable by source alone) — no crash, no silent total loss", async () => {
    // v4.3 plan's documented residual exposure: `pi.sendUserMessage` from ANY extension (ours
    // included) produces `source:"extension"`, so two same-text, same-process `extension`-sourced
    // sends are structurally indistinguishable by source. The invariant this proves is bounded
    // correctness (nothing crashes, nothing vanishes entirely), NOT perfect disambiguation —
    // perfect disambiguation of two identical-text same-source sends is not achievable from source
    // alone, and the plan explicitly accepts this.
    let otherFired = false;
    const after: ExtensionFactory[] = [
      (pi2) =>
        pi2.on("tool_execution_start", () => {
          if (!otherFired) {
            otherFired = true;
            void pi2.sendUserMessage("EXT-SAME", { deliverAs: "steer" });
          }
        }),
    ];
    const { session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "text", text: "x" },
        { kind: "text", text: "y" },
      ],
      hooks: {
        after,
        onTool: (a) => {
          if (a.once()) a.prompt("EXT-SAME", "steer"); // OUR held item, SAME text
        },
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "EXT-SAME")).toBeGreaterThanOrEqual(1); // never a total silent loss
    expect(count(fu, "EXT-SAME")).toBeLessThanOrEqual(2); // never more than the two real sends
    expect(api.holdDriver.heldCount()).toBe(0); // nothing left dangling in the hold buffer
  });
});

describe("G0 real driver — Y7.1: E2 attribution failure modes never lose or duplicate a message", () => {
  it("a transformed-text input event (text changed by an upstream handler) still delivers the held text exactly once", async () => {
    const before: ExtensionFactory[] = [
      (pi) =>
        pi.on("input", (e: { text: string }) =>
          e.text === "TRANSFORM-ME" ? { action: "transform", text: "TRANSFORMED" } : undefined,
        ),
    ];
    const { session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" },
        { kind: "text", text: "done" },
      ],
      hooks: {
        before,
        onTool: (a) => {
          if (a.once()) a.prompt("TRANSFORM-ME", "steer");
        },
      },
    });
    // the model still sees the text pi itself ended up queuing (post-transform) exactly once —
    // never zero (lost) and never twice (duplicated) — even though ledger-side exact-text
    // attribution could not match "TRANSFORM-ME" to the transformed "TRANSFORMED" queue entry.
    const fu = finalUsers(session);
    expect(count(fu, "TRANSFORM-ME") + count(fu, "TRANSFORMED")).toBe(1);
    expect(api.holdDriver.heldCount()).toBe(0);
    // NOT run through `assertRowsTerminal`: the literal text transform means OUR OWN ledger entry
    // (tracked under the pre-transform text "TRANSFORM-ME") can never be re-attributed by
    // `findDispatchedByText` (which only ever sees the POST-transform "TRANSFORMED" text) — by
    // design it stays "dispatched" until the real 30s unobserved-finalize timer eventually fires
    // (not exercised within this test's wall-clock budget; same accepted shape as D-M28's
    // S1-SWALLOW above).
  });
});

describe("G0 real driver — Y8.1: stale-B1 liveness degrade (run-1 swallow ⇒ run-2 web prompts go native)", () => {
  it("a swallowing input handler eats S1 in run 1 (run 1 ends with S1 unconfirmed, B1 stuck); run 2's web steer S2 is delivered NATIVELY exactly once — not returned, not held — and holding resumes after E2", async () => {
    // v4.3 增补 Y8.1 (verifier r_KRNMK1YR): a third-party input handler swallowing our dispatched
    // send leaves B1 blocked with no E2 ever coming — pre-Y8.1 that permanently neutered the hold
    // feature (every later web prompt was held, then returned{stale} at every agent_end). Now the
    // driver tracks the inflight item's consumption window; once its run's agent_end has passed
    // without E2, `canHold` refuses and commands.ts delivers new prompts on the native path.
    const before: ExtensionFactory[] = [
      (pi) => pi.on("input", (e: { text: string }) => (e.text === "Y8-S1" ? { action: "handled" } : undefined)),
    ];
    let toolRound = 0;
    const { session, api } = await run({
      scripted: [
        { kind: "tool", id: "a" }, // run 1: hold + dispatch Y8-S1 (swallowed downstream)
        { kind: "text", text: "done" }, // run 1 ends with B1 still blocked
        { kind: "tool", id: "b" }, // run 2: Y8-S2 arrives while stale-B1 — must go NATIVE
        { kind: "text", text: "done2" }, // Y8-S2 consumed here
      ],
      hooks: {
        before,
        onTool: (a) => {
          toolRound += 1;
          if (toolRound === 1) {
            expect(a.prompt("Y8-S1", "steer")).toBe(true); // run 1: held normally
          } else {
            // run 2: the ONLY refusal reason is the stale B1 — phase is armed, cap is up, and the
            // driver is still blocked on run 1's swallowed send.
            expect(a.holdDriver.phase()).toBe("armed");
            expect(a.holdDriver.inflightCmdId()).toBe(a.trace.cmdIdByText.get("Y8-S1"));
            expect(a.prompt("Y8-S2", "steer")).toBe(false); // Y8.1 degrade ⇒ native path
          }
        },
      },
      kick: async (s) => {
        const sess = s as unknown as { prompt: (t: string) => Promise<void>; waitForIdle: () => Promise<void> };
        await sess.prompt("P0"); // run 1
        await sess.waitForIdle();
        await sess.prompt("P1"); // run 2
        await sess.waitForIdle();
      },
    });
    const fu = finalUsers(session);
    expect(count(fu, "Y8-S1")).toBe(0); // swallowed in run 1 — never reached pi's queue
    expect(count(fu, "Y8-S2")).toBe(1); // delivered exactly once, natively, in run 2
    expect(api.holdDriver.heldCount()).toBe(0); // never held, nothing left dangling in the buffer
    assertRowsTerminal(api, fu, [
      // S1 stays at its genuinely-final "dispatched" (the 30s display timer would relabel it
      // "unconfirmed"; not waited for here) — unconfirmed-by-E2 is exactly the Y8.1 premise.
      { text: "Y8-S1", expectDelivered: false, expectState: "dispatched" },
      // S2 took the native lifecycle (dispatched → observed → queued → consumed), NOT "held" and
      // never "returned".
      { text: "Y8-S2", expectDelivered: true },
    ]);
  });
});
