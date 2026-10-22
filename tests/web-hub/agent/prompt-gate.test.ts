/**
 * agent-side command dispatcher — topic-switch web-prompt claim port (plan P4, D2/#5; arch §15
 * r2 row 1). `createCommandHandler`'s `handlePrompt` consults an optional, late-bound
 * `PromptGatePort` right after the compaction check and before the hold-driver branch; this
 * suite proves the port is byte-identical-when-absent and the claim/release contract end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import { createHoldBuffer } from "../../../src/web-hub/agent/hold.js";
import { createHoldDriver, type HoldDriver } from "../../../src/web-hub/agent/hold-driver.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { OriginEntryPort } from "../../../src/web-hub/agent/origin-entry.js";
import type { PromptGatePort, WebPromptRelease } from "../../../src/web-hub/agent/prompt-gate.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

function frame(id: string, cmd: CmdFrame["cmd"], over: Partial<CmdFrame> = {}): CmdFrame {
  return { t: "cmd", rid: `r-${id}`, id, deadlineMs: 8000, origin: ORIGIN, cmd, ...over };
}

interface Harness {
  handler: ReturnType<typeof createCommandHandler>;
  deps: CommandHandlerDeps;
  sent: Array<CmdResultFrame | CmdLateFrame>;
  sentUserMessages: ReturnType<typeof fakePi>["sentUserMessages"];
  onChanged: ReturnType<typeof vi.fn>;
  timers: ReturnType<typeof fakeTimerQueue>;
  ctxState: ReturnType<typeof fakeCtx>["state"];
  compaction: { manualCompacting: boolean };
  originEntry: OriginEntryPort & { appendOrigin: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

function makeHarness(
  over: { promptGate?: () => PromptGatePort | undefined; hold?: HoldDriver | undefined; idle?: boolean } = {},
): Harness {
  const { pi, sentUserMessages } = fakePi();
  const { ctx, state } = fakeCtx({ mode: "tui", idle: over.idle ?? true });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const onChanged = vi.fn();
  const timers = fakeTimerQueue();
  const compaction = { manualCompacting: false };
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
  };
  const originEntry = { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() };
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => state.sessionId,
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: {
      get manualCompacting() {
        return compaction.manualCompacting;
      },
      dispose() {},
    },
    originEntry,
    builtinBridge,
    controlEnabled: () => true,
    now: () => 1000,
    send: (f) => sent.push(f),
    onChanged,
    setTimer: timers.setTimer,
    ...(over.promptGate !== undefined ? { promptGate: over.promptGate } : {}),
    ...(over.hold !== undefined ? { hold: () => over.hold } : {}),
  };
  const handler = createCommandHandler(deps);
  return { handler, deps, sent, sentUserMessages, onChanged, timers, ctxState: state, compaction, originEntry };
}

/** Captures the `release` object `tryClaim` was handed so a test can invoke `current()`/
 * `elsewhere()` later, exactly like topic-switch's own asynchronous judge/confirm window would. */
function fakeGate(claims: boolean | (() => boolean)): {
  gate: PromptGatePort;
  tryClaim: ReturnType<typeof vi.fn>;
  release: { current?: WebPromptRelease };
} {
  const release: { current?: WebPromptRelease } = {};
  const tryClaim = vi.fn((_req: { cmdId: string; text: string }, _ctx: unknown, rel: WebPromptRelease) => {
    release.current = rel;
    return typeof claims === "function" ? claims() : claims;
  });
  return { gate: { tryClaim }, tryClaim, release };
}

describe("createCommandHandler — handlePrompt, no promptGate wired (byte-identical to pre-feature)", () => {
  it("behaves exactly like the plain native dispatch path (no promptGate dep at all)", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dispatched", text: "hi" });
    expect(h.sent).toHaveLength(0); // still waiting on observation, same as commands.test.ts
  });

  it("promptGate getter present but returns undefined (feature wired off) ⇒ native path unchanged", () => {
    const h = makeHarness({ promptGate: () => undefined });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dispatched", text: "hi" });
  });
});

describe("createCommandHandler — handlePrompt, promptGate declines (tryClaim ⇒ false)", () => {
  it("falls straight through to the native dispatch path — identical result to the no-gate case", () => {
    const { gate, tryClaim } = fakeGate(false);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(tryClaim).toHaveBeenCalledTimes(1);
    expect(tryClaim).toHaveBeenCalledWith({ cmdId: "c1", text: "hi" }, expect.anything(), expect.anything());
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dispatched", text: "hi" });
  });

  it("decline still falls into the hold branch when a hold driver is also wired (gate runs BEFORE hold)", () => {
    const { gate, tryClaim } = fakeGate(false);
    const drv: HoldDriver = {
      canHold: vi.fn(() => true),
      hold: vi.fn(() => true),
      recall: vi.fn(),
      onContext: vi.fn(),
      onAssistantMessageStart: vi.fn(),
      onTurnStart: vi.fn(),
      onTurnEnd: vi.fn(() => undefined),
      onAgentEnd: vi.fn(() => undefined),
      onAgentSettled: vi.fn(),
      onObserved: vi.fn(),
      onConsumed: vi.fn(),
      onWebAbort: vi.fn(),
      onSessionStart: vi.fn(),
      onSessionShutdown: vi.fn(),
      onTick: vi.fn(),
      heldCount: vi.fn(() => 0),
      phase: vi.fn(() => "armed"),
      inflightCmdId: vi.fn(() => undefined),
      dispose: vi.fn(),
    };
    const h = makeHarness({ promptGate: () => gate, hold: drv });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(tryClaim).toHaveBeenCalledTimes(1);
    expect(drv.canHold).toHaveBeenCalledTimes(1);
    expect(h.deps.ledger.get("c1")?.promptState).toBe("held");
    expect(h.sentUserMessages).toHaveLength(0);
  });
});

describe("createCommandHandler — handlePrompt, promptGate claims (tryClaim ⇒ true)", () => {
  it("one immediate reply {delivery:observed, behavior:idle}, no sendUserMessage, ledger observed/idle", () => {
    const { gate, tryClaim } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(tryClaim).toHaveBeenCalledTimes(1);
    expect(h.sentUserMessages).toHaveLength(0);
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: "r-c1",
        id: "c1",
        ok: true,
        data: { op: "prompt", delivery: "observed", behavior: "idle" },
      },
    ]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "observed", behavior: "idle" });
  });

  it("never consults the hold driver once claimed (claim happens first and short-circuits)", () => {
    const { gate } = fakeGate(true);
    const drv: HoldDriver = {
      canHold: vi.fn(() => true),
      hold: vi.fn(() => true),
      recall: vi.fn(),
      onContext: vi.fn(),
      onAssistantMessageStart: vi.fn(),
      onTurnStart: vi.fn(),
      onTurnEnd: vi.fn(() => undefined),
      onAgentEnd: vi.fn(() => undefined),
      onAgentSettled: vi.fn(),
      onObserved: vi.fn(),
      onConsumed: vi.fn(),
      onWebAbort: vi.fn(),
      onSessionStart: vi.fn(),
      onSessionShutdown: vi.fn(),
      onTick: vi.fn(),
      heldCount: vi.fn(() => 0),
      phase: vi.fn(() => "armed"),
      inflightCmdId: vi.fn(() => undefined),
      dispose: vi.fn(),
    };
    const h = makeHarness({ promptGate: () => gate, hold: drv });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(drv.canHold).not.toHaveBeenCalled();
    expect(drv.hold).not.toHaveBeenCalled();
  });
});

describe("createCommandHandler — handlePrompt, promptGate skipped while streaming", () => {
  it("ctx not idle ⇒ tryClaim is never called at all; native dispatch proceeds", () => {
    const { gate, tryClaim } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate, idle: false });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(tryClaim).not.toHaveBeenCalled();
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
  });

  it("manual compaction ⇒ replies E_BUSY_COMPACTING before the gate is ever consulted", () => {
    const { gate, tryClaim } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.compaction.manualCompacting = true;
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(tryClaim).not.toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_BUSY_COMPACTING" });
  });
});

describe("createCommandHandler — handlePrompt, promptGate throws ⇒ fail-open native dispatch", () => {
  it("tryClaim throwing synchronously ⇒ falls through exactly like a decline", () => {
    const gate: PromptGatePort = {
      tryClaim: () => {
        throw new Error("boom");
      },
    };
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dispatched", text: "hi" });
    expect(h.sent).toHaveLength(0);
  });

  it("the promptGate getter itself throwing is also fail-open (native dispatch, no throw)", () => {
    const h = makeHarness({
      promptGate: () => {
        throw new Error("getter boom");
      },
    });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
  });
});

describe("createCommandHandler — WebPromptRelease.current() (plan P4 'dispatchHeld 同款无回复路径')", () => {
  it("exactly one sendUserMessage({deliverAs:followUp}), no HTTP reply, and the observation chain continues as usual", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sent).toHaveLength(1); // the claim's own observed/idle reply — nothing more yet
    expect(release.current).toBeDefined();

    const outcome = release.current!.current();
    expect(outcome).toBe("dispatched");
    expect(h.sentUserMessages).toEqual([
      { text: "hi", options: { deliverAs: "followUp", expandPromptTemplates: false } },
    ]);
    expect(h.sent).toHaveLength(1); // current() never replies over HTTP
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dispatched", text: "hi" });

    // the observation chain still works normally off the back of this re-dispatch.
    h.handler.onInputEvent({ text: "hi", source: "extension" });
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "observed", behavior: "idle" });
    h.handler.onMessageStart({ message: { role: "user", content: "hi" } });
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });

  it("30s unobserved finalize still fires after current() if nothing ever observes it", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    release.current!.current();
    h.timers.fireByMs(30_000);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "unconfirmed", reason: "unobserved" });
  });

  it("called twice ⇒ only the first takes effect (exactly one sendUserMessage, second call refused)", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(release.current!.current()).toBe("dispatched");
    expect(release.current!.current()).toBe("refused");
    expect(h.sentUserMessages).toHaveLength(1);
  });

  it("elsewhere() first, then current() ⇒ current() is a no-op (no sendUserMessage, ledger stays consumed)", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    release.current!.elsewhere();
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
    expect(release.current!.current()).toBe("refused");
    expect(h.sentUserMessages).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" }); // untouched
  });

  it("precondition failure (ctx gone) ⇒ 'refused', no ledger mutation, no sendUserMessage", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.deps.getCtx = () => undefined;
    expect(release.current!.current()).toBe("refused");
    expect(h.sentUserMessages).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "observed", behavior: "idle" }); // untouched
  });

  it("precondition failure (session changed) ⇒ 'refused' — a release landing after a session hop never dispatches into the new session", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.ctxState.sessionId = "a-different-session";
    expect(release.current!.current()).toBe("refused");
    expect(h.sentUserMessages).toHaveLength(0);
  });

  it("precondition failure (manual compacting) ⇒ 'refused'", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.compaction.manualCompacting = true;
    expect(release.current!.current()).toBe("refused");
    expect(h.sentUserMessages).toHaveLength(0);
  });
});

describe("createCommandHandler — WebPromptRelease.elsewhere() (plan P4: freezes the bubble)", () => {
  it("marks the ledger entry consumed and republishes, no sendUserMessage", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.onChanged.mockClear();
    release.current!.elsewhere();
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
    expect(h.sentUserMessages).toHaveLength(0);
    expect(h.onChanged).toHaveBeenCalled();
  });

  it("called twice ⇒ second call is a no-op (idempotent)", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    release.current!.elsewhere();
    release.current!.elsewhere();
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });

  it("bug repro: elsewhere() after the session moved on ⇒ the NEW session's ctl slot projects `consumed` (no forever 'sent · unconfirmed' row)", () => {
    // Real sequence (topic-switch "开新会话"): web prompt claimed under sess-1 (ledger observed/idle,
    // HTTP reply observed ⇒ the browser row shows "sent · unconfirmed"), `/topic-switch __go`
    // runs `ctx.newSession` — the bound session is now sess-2 — and only then wire.ts's
    // `onSwitchEntered` calls `release.elsewhere()`. The ctl slot is published for the CURRENT
    // session; the browser clears its row only on a ctl `consumed` for this cmdId.
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.deps.ledger.frame("sess-1", "ep", 1000).items).toContainEqual(
      expect.objectContaining({ cmdId: "c1", state: "observed" }),
    );
    h.ctxState.sessionId = "sess-2"; // newSession resolved before onSwitchEntered
    release.current!.elsewhere();
    const ctl = h.deps.ledger.frame("sess-2", "ep", 1000);
    expect(ctl.items).toContainEqual(expect.objectContaining({ cmdId: "c1", state: "consumed" }));
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed", sessionId: "sess-2" });
  });

  it("elsewhere() while the current session id is unreadable ⇒ entry becomes session-agnostic (still projected)", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.deps.getSessionId = () => {
      throw new Error("stale ctx");
    };
    release.current!.elsewhere();
    expect(h.deps.ledger.get("c1")?.sessionId).toBeUndefined();
    expect(h.deps.ledger.frame("any-session", "ep", 1000).items).toContainEqual(
      expect.objectContaining({ cmdId: "c1", state: "consumed" }),
    );
  });

  it("elsewhere() within the claim-time session ⇒ session binding untouched", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    release.current!.elsewhere();
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed", sessionId: "sess-1" });
  });

  it("current() first, then elsewhere() ⇒ elsewhere() is a no-op (dispatch already happened, stays dispatched)", () => {
    const { gate, release } = fakeGate(true);
    const h = makeHarness({ promptGate: () => gate });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    release.current!.current();
    release.current!.elsewhere();
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dispatched", text: "hi" });
    expect(h.sentUserMessages).toHaveLength(1);
  });
});

describe("createCommandHandler — real HoldDriver interplay (gate present but skipped mid-turn, hold claims as usual)", () => {
  it("ctx not idle (mid-turn) ⇒ the gate is never consulted at all and the real hold driver claims the prompt exactly as commands-hold.test.ts documents", () => {
    const { gate, tryClaim } = fakeGate(false);
    const buffer = createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
    let handler!: ReturnType<typeof createCommandHandler>;
    const { pi, sentUserMessages } = fakePi();
    const { ctx } = fakeCtx({ mode: "tui", idle: false, pending: true });
    const sent: Array<CmdResultFrame | CmdLateFrame> = [];
    const timers = fakeTimerQueue();
    const ledger = createCommandLedger();
    let drv: HoldDriver | undefined;
    const deps: CommandHandlerDeps = {
      pi,
      getCtx: () => ctx,
      getSessionId: () => "sess-1",
      ledger,
      queueMirror: createQueueMirror(),
      compactionState: { manualCompacting: false, dispose() {} },
      originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
      builtinBridge: { execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })) },
      controlEnabled: () => true,
      now: () => Date.now(),
      send: (f) => sent.push(f),
      onChanged: () => undefined,
      setTimer: timers.setTimer,
      owner: "owner-1",
      promptGate: () => gate,
      hold: () => drv,
    };
    handler = createCommandHandler(deps);
    drv = createHoldDriver({
      buffer,
      owner: "owner-1",
      getSessionId: () => "sess-1",
      holdCap: () => true,
      dispatchToPi: (item) => handler.dispatchHeld(item),
      onReturned: () => undefined,
      publish: () => undefined,
      now: () => Date.now(),
      setRefTimer: (_ms, fn) => {
        const t = setImmediate(fn);
        return { cancel: () => clearImmediate(t) };
      },
      nextMacrotask: () => new Promise((r) => setImmediate(r)),
    });
    drv.onContext(ctx);
    handler.handle(frame("c1", { op: "prompt", text: "S1", deliver: "steer" }));
    expect(tryClaim).not.toHaveBeenCalled();
    expect(ledger.get("c1")?.promptState).toBe("held");
    expect(sentUserMessages).toHaveLength(0);
  });
});
