/**
 * web-resume plan §2.4/§2.5 — `commands.ts handleCommand`'s thenable READ branch (only
 * `resume __list`), the quiet ledger settle (sessions stripped, no origin notify), the
 * `resume:scanning` deadline race, `switchInFlight`'s web-prompt guard, and the pin that every
 * other op stays a plain synchronous settle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { OriginEntryPort } from "../../../src/web-hub/agent/origin-entry.js";
import type {
  CmdFrame,
  CmdLateFrame,
  CmdOrigin,
  CmdResultFrame,
  ResumeSessionsWire,
} from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

function frameOf(id: string, args: string, over: Partial<CmdFrame> = {}): CmdFrame {
  return {
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: ORIGIN,
    cmd: { op: "command", name: "resume", args },
    ...over,
  };
}

interface Harness {
  handler: ReturnType<typeof createCommandHandler>;
  deps: CommandHandlerDeps;
  sent: Array<CmdResultFrame | CmdLateFrame>;
  timers: ReturnType<typeof fakeTimerQueue>;
  notify: ReturnType<typeof vi.fn>;
  ctxState: ReturnType<typeof fakeCtx>["state"];
  sendUserMessages: Array<{ text: string; options?: unknown }>;
}

function makeHarness(
  over: {
    bridgeExecute?: BuiltinBridge["execute"];
    isQuiet?: (frame: CmdFrame) => boolean;
    switchInFlight?: () => boolean;
    now?: () => number;
  } = {},
): Harness {
  const { pi } = fakePi();
  const { ctx, state } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const timers = fakeTimerQueue();
  const notify = vi.fn();
  const bridge: BuiltinBridge = {
    execute:
      over.bridgeExecute ?? vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
    isQuiet:
      over.isQuiet ??
      ((frame) =>
        (frame.cmd as { name?: string }).name === "resume" &&
        (frame.cmd as { args?: string }).args?.startsWith("__list") === true),
  };
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => state.sessionId,
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: {
      get manualCompacting() {
        return false;
      },
      dispose() {},
    },
    originEntry: { appendOrigin: vi.fn(), notify, dispose: vi.fn() } as unknown as OriginEntryPort,
    builtinBridge: bridge,
    controlEnabled: () => true,
    now: over.now ?? (() => 1000),
    send: (f) => sent.push(f),
    onChanged: () => undefined,
    setTimer: timers.setTimer,
    ...(over.switchInFlight !== undefined ? { switchInFlight: over.switchInFlight } : {}),
  };
  return {
    handler: createCommandHandler(deps),
    deps,
    sent,
    timers,
    notify,
    ctxState: state,
    sendUserMessages: (pi as unknown as { sendUserMessage: (t: string, o?: unknown) => void }).sendUserMessage
      ? []
      : [],
  };
}

const sessionsWire = (rows: number): ResumeSessionsWire => ({
  v: 1,
  scope: "recent",
  windowHours: 48,
  gen: "0123456789abcdef",
  total: rows,
  rows: Array.from({ length: rows }, (_, i) => ({
    id: `s${i}`,
    title: `row ${i}`,
    titleSource: "first" as const,
    modifiedMs: 1,
  })),
  provenance: "complete",
  builtAt: 1,
});

describe("handleCommand — thenable `resume __list` (§2.4)", () => {
  it("settles from the promise, sends the full sessions payload, strips it from the ledger, stays quiet", async () => {
    const wire = sessionsWire(3);
    const h = makeHarness({
      bridgeExecute: () =>
        Promise.resolve({ ok: true, data: { op: "command", kind: "builtin", completion: "sync", sessions: wire } }),
    });
    h.handler.handle(frameOf("c1", '__list {"scope":"recent"}'));
    expect(h.sent).toHaveLength(0); // not settled synchronously
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toHaveLength(1);
    const reply = h.sent[0] as CmdResultFrame;
    expect(reply.ok).toBe(true);
    expect((reply.data as { sessions?: ResumeSessionsWire }).sessions).toEqual(wire); // full payload out
    const entry = h.deps.ledger.get("c1");
    expect(entry?.state).toBe("ok");
    expect((entry?.result as { data?: { sessions?: unknown } }).data.sessions).toBeUndefined(); // ledger stripped
    expect(h.timers.pendingCount()).toBe(0); // the race timer was cancelled
    expect(h.notify).not.toHaveBeenCalled(); // quiet: no origin notify for __list
  });

  it("times out with E_DEADLINE retryable effect none `resume:scanning`; a late completion is dropped", async () => {
    let release: (() => void) | undefined;
    const late = vi.fn();
    const h = makeHarness({
      bridgeExecute: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: { op: "command", kind: "builtin", completion: "sync", sessions: sessionsWire(1) },
            });
        }),
    });
    h.handler.handle(frameOf("c1", '__list {"scope":"recent"}'));
    h.timers.fireByMs(6_000); // min(6000, opTotal 7700)
    expect(h.sent).toHaveLength(1);
    const reply = h.sent[0] as CmdResultFrame;
    expect(reply).toMatchObject({
      ok: false,
      code: "E_DEADLINE",
      retryable: true,
      effect: "none",
      message: "resume:scanning",
    });
    expect(h.deps.ledger.get("c1")).toBeUndefined(); // retryable+none ⇒ deleted ⇒ same-id retry re-executes
    release!();
    late();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toHaveLength(1); // exactly one settle; the late completion is dropped
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a rejected promise settles E_UNSUPPORTED once", async () => {
    const h = makeHarness({ bridgeExecute: () => Promise.reject(new Error("boom")) });
    h.handler.handle(frameOf("c1", '__list {"scope":"recent"}'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
  });

  it("every other op stays a plain synchronous settle (R4 pin)", async () => {
    const h = makeHarness({
      bridgeExecute: vi.fn(() => ({ ok: true, data: { op: "command", kind: "builtin", completion: "sync" } })),
      isQuiet: () => false,
    });
    h.handler.handle(frameOf("c1", "session", { cmd: { op: "command", name: "session", args: "" } }));
    expect(h.sent).toHaveLength(1); // same tick, no pending timers
    expect(h.timers.pendingCount()).toBe(0);
    expect(h.notify).toHaveBeenCalledTimes(1); // non-quiet success still notifies
  });
});

describe("handlePrompt — switchInFlight guard (§2.5 step c)", () => {
  it("refuses web prompts with E_STALE_CTX retryable effect none while a resume switch runs", () => {
    let inflight = false;
    const h = makeHarness({ switchInFlight: () => inflight });
    const send = vi.spyOn(h.deps.pi, "sendUserMessage");
    inflight = true;
    h.handler.handle({
      t: "cmd",
      rid: "r-p1",
      id: "p1",
      deadlineMs: 8_000,
      origin: ORIGIN,
      cmd: { op: "prompt", text: "hello", deliver: "steer" },
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_STALE_CTX", retryable: true, effect: "none" });
    expect(send).not.toHaveBeenCalled(); // refused BEFORE any dispatch — effect none is honest
    inflight = false;
    h.handler.handle({
      t: "cmd",
      rid: "r-p2",
      id: "p2",
      deadlineMs: 8_000,
      origin: ORIGIN,
      cmd: { op: "prompt", text: "hello", deliver: "steer" },
    });
    h.timers.fireByMs(3_000); // no observation will land in a fake — the HTTP wait settles it
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.ok).toBe(true); // dispatches normally once the switch window closed
    expect(send).toHaveBeenCalled();
  });
});
