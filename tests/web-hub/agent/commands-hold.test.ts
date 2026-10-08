/**
 * agent-side command dispatcher — steer-recall hold branch (plan §4.4 A3, §9 anchor
 * `commands-hold.test.ts`). The hold DRIVER itself is faked here (unit-level) — the full real
 * integration (real `createHoldDriver` + real `createHoldBuffer`) is covered by
 * `tests/conformance/steer-hold-driver.test.ts` (G0 hard gate) and `hold-faults.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import { createHoldBuffer } from "../../../src/web-hub/agent/hold.js";
import { createHoldDriver } from "../../../src/web-hub/agent/hold-driver.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { OriginEntryPort } from "../../../src/web-hub/agent/origin-entry.js";
import type { HoldDriver } from "../../../src/web-hub/agent/hold-driver.js";
import type { HoldItem, RecallOutcome } from "../../../src/web-hub/agent/hold.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

function frame(id: string, cmd: CmdFrame["cmd"], over: Partial<CmdFrame> = {}): CmdFrame {
  return { t: "cmd", rid: `r-${id}`, id, deadlineMs: 8000, origin: ORIGIN, cmd, ...over };
}

function fakeHoldItem(cmdId: string, over: Partial<HoldItem> = {}): HoldItem {
  return {
    cmdId,
    sessionId: "sess-1",
    owner: "owner-1",
    text: `text-${cmdId}`,
    deliver: "steer",
    origin: ORIGIN,
    at: 1000,
    state: "held",
    updatedAt: 1000,
    ...over,
  };
}

function fakeHoldDriver(over: Partial<HoldDriver> = {}): HoldDriver {
  return {
    canHold: vi.fn(() => true),
    hold: vi.fn(() => true),
    recall: vi.fn((): RecallOutcome => ({ kind: "unknown" })),
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
    ...over,
  };
}

interface Harness {
  handler: ReturnType<typeof createCommandHandler>;
  deps: CommandHandlerDeps;
  sent: Array<CmdResultFrame | CmdLateFrame>;
  sentUserMessages: ReturnType<typeof fakePi>["sentUserMessages"];
  timers: ReturnType<typeof fakeTimerQueue>;
  ctxState: ReturnType<typeof fakeCtx>["state"];
  drv: HoldDriver;
  originEntry: OriginEntryPort & { appendOrigin: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

function makeHarness(over: { drv?: HoldDriver | undefined; owner?: string } = {}): Harness {
  const { pi, sentUserMessages, fire } = fakePi();
  const { ctx, state } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const timers = fakeTimerQueue();
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
  };
  const originEntry = { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() };
  const drv = over.drv === undefined && !("drv" in over) ? fakeHoldDriver() : over.drv;
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => state.sessionId,
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry,
    builtinBridge,
    controlEnabled: () => true,
    now: () => 1000,
    send: (f) => sent.push(f),
    onChanged: () => undefined,
    setTimer: timers.setTimer,
    owner: over.owner ?? "owner-1",
    ...(drv !== undefined ? { hold: () => drv } : {}),
  };
  const handler = createCommandHandler(deps);
  void fire;
  return { handler, deps, sent, sentUserMessages, timers, ctxState: state, drv: drv as HoldDriver, originEntry };
}

describe("createCommandHandler — handlePrompt hold branch (A3 point 2)", () => {
  it("canHold()+hold() success ⇒ ledger 'held', no sendUserMessage, immediate ok{delivery:held}", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toHaveLength(0);
    expect(h.deps.ledger.get("c1")?.promptState).toBe("held");
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "prompt", delivery: "held", behavior: "steer" } },
    ]);
    expect(h.drv.canHold).toHaveBeenCalledTimes(1);
    expect(h.drv.hold).toHaveBeenCalledTimes(1);
  });

  it("canHold()=false ⇒ falls through to the native dispatch path", () => {
    const drv = fakeHoldDriver({ canHold: vi.fn(() => false) });
    const h = makeHarness({ drv });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
    expect(h.deps.ledger.get("c1")?.promptState).toBe("dispatched");
    expect(drv.hold).not.toHaveBeenCalled();
  });

  it("canHold()=true but hold()=false (capacity race) ⇒ rolls back to the native path with text restored", () => {
    const drv = fakeHoldDriver({ hold: vi.fn(() => false) });
    const h = makeHarness({ drv });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toEqual([{ text: "hi", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dispatched", text: "hi" });
  });

  it("no hold driver attached (feature off) ⇒ native path, driver never touched", () => {
    const h = makeHarness({ drv: undefined });
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sentUserMessages).toHaveLength(1);
    expect(h.deps.ledger.get("c1")?.promptState).toBe("dispatched");
  });
});

describe("createCommandHandler — dispatchHeld (§5.3 P2-P5)", () => {
  /** Simulates the lifecycle lead-in: a real `held` ledger entry already exists (written by
   * `handlePrompt`'s hold branch) by the time the driver later calls `dispatchHeld`. */
  function beginHeld(h: Harness, cmdId: string, text: string): void {
    h.deps.ledger.begin(cmdId, "prompt", { op: "prompt", text }, 1000, { text, sessionId: "sess-1" });
    h.deps.ledger.updatePrompt(cmdId, { promptState: "held" }, 1000);
  }

  it("P5 success ⇒ 'sent', ledger dispatched+text, origin entry appended, 30s finalize scheduled", () => {
    const h = makeHarness();
    beginHeld(h, "held-1", "text-held-1");
    const outcome = h.handler.dispatchHeld(fakeHoldItem("held-1"));
    expect(outcome).toBe("sent");
    expect(h.sentUserMessages).toEqual([
      { text: "text-held-1", options: { deliverAs: "steer", expandPromptTemplates: false } },
    ]);
    expect(h.deps.ledger.get("held-1")).toMatchObject({ promptState: "dispatched", text: "text-held-1" });
    expect(h.originEntry.appendOrigin).toHaveBeenCalledWith("prompt", "held-1", ORIGIN, "steer");
    expect(h.timers.pendingCount()).toBeGreaterThan(0);
    h.timers.fireByMs(30_000);
    expect(h.deps.ledger.get("held-1")).toMatchObject({ promptState: "unconfirmed", reason: "unobserved" });
  });

  it("P2: no ctx ⇒ 'refused', no ledger write, no send", () => {
    const h = makeHarness();
    h.deps.getCtx = () => undefined;
    const outcome = h.handler.dispatchHeld(fakeHoldItem("held-1"));
    expect(outcome).toBe("refused");
    expect(h.deps.ledger.get("held-1")).toBeUndefined();
    expect(h.sentUserMessages).toHaveLength(0);
  });

  it("P2: session mismatch ⇒ 'refused'", () => {
    const h = makeHarness();
    const outcome = h.handler.dispatchHeld(fakeHoldItem("held-1", { sessionId: "other-session" }));
    expect(outcome).toBe("refused");
    expect(h.sentUserMessages).toHaveLength(0);
  });

  it("P2: manual compacting ⇒ 'refused'", () => {
    const h = makeHarness();
    (h.deps.compactionState as { manualCompacting: boolean }).manualCompacting = true;
    const outcome = h.handler.dispatchHeld(fakeHoldItem("held-1"));
    expect(outcome).toBe("refused");
    expect(h.sentUserMessages).toHaveLength(0);
  });

  it("P4: origin entry throwing never affects the outcome", () => {
    const h = makeHarness();
    h.originEntry.appendOrigin.mockImplementation(() => {
      throw new Error("boom");
    });
    const outcome = h.handler.dispatchHeld(fakeHoldItem("held-1"));
    expect(outcome).toBe("sent");
    expect(h.sentUserMessages).toHaveLength(1);
  });

  it("P5 fix (verifier r_BHFA552J P2): sendUserMessage throwing (even side-effect-then-throw) is reported 'sent', never 'threw'/'refused' — avoids a duplicate on resend", () => {
    const h = makeHarness();
    beginHeld(h, "held-1", "text-held-1");
    h.deps.pi.sendUserMessage = () => {
      throw new Error("boom (possibly after a real side effect inside pi)");
    };
    const outcome = h.handler.dispatchHeld(fakeHoldItem("held-1", { text: "text-held-1" }));
    expect(outcome).toBe("sent");
    // the ledger entry is left exactly as a normal send would leave it — "dispatched", decaying to
    // "unconfirmed" via the existing 30s timer if no observation ever lands — never force-returned.
    expect(h.deps.ledger.get("held-1")?.promptState).toBe("dispatched");
    h.timers.fireByMs(30_000);
    expect(h.deps.ledger.get("held-1")).toMatchObject({ promptState: "unconfirmed", reason: "unobserved" });
  });
});

describe("createCommandHandler — handleRecall (A3 point 4 / §5.8)", () => {
  it("driver missing ⇒ E_UNSUPPORTED", () => {
    const h = makeHarness({ drv: undefined });
    h.handler.handle(frame("c1", { op: "recall", target: "x".repeat(16) }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" },
    ]);
  });

  it("recalled ⇒ ok{outcome:recalled, from, deliver, text}; ledger target set to 'recalled'", () => {
    const target = fakeHoldItem("held-1", { text: "full original text", deliver: "followUp" });
    const drv = fakeHoldDriver({ recall: vi.fn(() => ({ kind: "recalled", item: target, from: "held" })) });
    const h = makeHarness({ drv });
    h.deps.ledger.begin("held-1", "prompt", { op: "prompt", text: "full original text" }, 1000, {
      sessionId: "sess-1",
    });
    h.handler.handle(frame("c1", { op: "recall", target: "held-1" }));
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: "r-c1",
        id: "c1",
        ok: true,
        data: { op: "recall", outcome: "recalled", from: "held", deliver: "followUp", text: "full original text" },
      },
    ]);
    expect(h.deps.ledger.get("held-1")?.promptState).toBe("recalled");
  });

  it("too_late ⇒ ok{outcome:too_late}", () => {
    const drv = fakeHoldDriver({ recall: vi.fn(() => ({ kind: "too_late" })) });
    const h = makeHarness({ drv });
    h.handler.handle(frame("c1", { op: "recall", target: "x".repeat(16) }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "recall", outcome: "too_late" } },
    ]);
  });

  it("buffer says unknown but the ledger shows a real prompt ⇒ too_late (already handed off)", () => {
    const drv = fakeHoldDriver({ recall: vi.fn(() => ({ kind: "unknown" })) });
    const h = makeHarness({ drv });
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "x" }, 1000, { sessionId: "sess-1" });
    h.deps.ledger.updatePrompt("p1", { promptState: "consumed" }, 1000);
    h.handler.handle(frame("c1", { op: "recall", target: "p1" }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "recall", outcome: "too_late" } },
    ]);
  });

  it("buffer says unknown and the target genuinely never existed ⇒ E_NOT_FOUND", () => {
    const drv = fakeHoldDriver({ recall: vi.fn(() => ({ kind: "unknown" })) });
    const h = makeHarness({ drv });
    h.handler.handle(frame("c1", { op: "recall", target: "x".repeat(16) }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_NOT_FOUND", retryable: false, effect: "none" },
    ]);
  });

  it("two tabs recalling the same target: the second ever-reaching-the-buffer call sees too_late (F19)", () => {
    let recalled = false;
    const target = fakeHoldItem("p1", { text: "x" });
    const drv = fakeHoldDriver({
      recall: vi.fn((): RecallOutcome => {
        if (recalled) return { kind: "unknown" };
        recalled = true;
        return { kind: "recalled", item: target, from: "held" };
      }),
    });
    const h = makeHarness({ drv });
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "x" }, 1000, { sessionId: "sess-1" });
    h.handler.handle(frame("c1", { op: "recall", target: "p1" }));
    h.handler.handle(frame("c2", { op: "recall", target: "p1" }));
    expect(h.sent[0]).toMatchObject({ ok: true, data: { outcome: "recalled" } });
    expect(h.sent[1]).toMatchObject({ ok: true, data: { outcome: "too_late" } });
  });
});

describe("createCommandHandler — handleAbort calls onWebAbort before ctx.abort() (A3 point 5)", () => {
  it("onWebAbort fires before ctx.abort()", () => {
    const order: string[] = [];
    const drv = fakeHoldDriver({ onWebAbort: vi.fn(() => order.push("onWebAbort")) });
    const h = makeHarness({ drv });
    const originalAbort = h.deps.getCtx()!.abort.bind(h.deps.getCtx());
    (h.deps.getCtx()! as unknown as { abort: () => void }).abort = () => {
      order.push("ctx.abort");
      originalAbort();
    };
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(order).toEqual(["onWebAbort", "ctx.abort"]);
  });

  it("no driver attached ⇒ abort still works (optional chaining is a no-op)", () => {
    const h = makeHarness({ drv: undefined });
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(h.sent[0]).toMatchObject({ ok: true });
  });
});

describe("createCommandHandler — onInputEvent / onMessageStart drive onObserved/onConsumed (Y1 E1/E2)", () => {
  it("a matching extension input event calls onObserved with the matched cmdId (E1, display-only)", () => {
    const h = makeHarness();
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "hi" }, 1000, {
      text: "hi",
      sessionId: "sess-1",
      owner: "owner-1",
    });
    h.deps.ledger.updatePrompt("p1", { promptState: "dispatched" }, 1000);
    h.handler.onInputEvent({ text: "hi", source: "extension", streamingBehavior: "steer" });
    expect(h.drv.onObserved).toHaveBeenCalledWith("p1");
  });

  it("ambiguous input event (two same-text dispatched entries) never calls onObserved", () => {
    const h = makeHarness();
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "hi" }, 1000, { text: "hi", sessionId: "sess-1" });
    h.deps.ledger.updatePrompt("p1", { promptState: "dispatched" }, 1000);
    h.deps.ledger.begin("p2", "prompt", { op: "prompt", text: "hi", deliver: "steer" }, 1001, {
      text: "hi",
      sessionId: "sess-1",
    });
    h.deps.ledger.updatePrompt("p2", { promptState: "dispatched" }, 1001);
    h.handler.onInputEvent({ text: "hi", source: "extension", streamingBehavior: "steer" });
    expect(h.drv.onObserved).not.toHaveBeenCalled();
  });

  it("verifier r_BHFA552J P2: with hold OFF (no driver attached), two same-text dispatched entries fall back to the OLD earliest-candidate match (never ambiguous-rejected)", () => {
    const h = makeHarness({ drv: undefined });
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "hi" }, 1000, { text: "hi", sessionId: "sess-1" });
    h.deps.ledger.updatePrompt("p1", { promptState: "dispatched" }, 1000);
    h.deps.ledger.begin("p2", "prompt", { op: "prompt", text: "hi", deliver: "steer" }, 1001, {
      text: "hi",
      sessionId: "sess-1",
    });
    h.deps.ledger.updatePrompt("p2", { promptState: "dispatched" }, 1001);
    h.handler.onInputEvent({ text: "hi", source: "extension", streamingBehavior: "steer" });
    // old behavior: earliest (p1) is matched and advanced (observed → queued, since behavior is
    // "steer" not "idle"); p2 is untouched.
    expect(h.deps.ledger.get("p1")?.promptState).toBe("queued");
    expect(h.deps.ledger.get("p2")?.promptState).toBe("dispatched");
  });

  it("a queued-then-consumed prompt calls onConsumed with the matched cmdId (E2, lifts B1)", () => {
    const h = makeHarness();
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "hi" }, 1000, { text: "hi", sessionId: "sess-1" });
    h.deps.ledger.updatePrompt("p1", { promptState: "dispatched" }, 1000);
    h.handler.onInputEvent({ text: "hi", source: "extension", streamingBehavior: "steer" });
    h.handler.onMessageStart({ message: { role: "user", content: "hi" } });
    expect(h.drv.onConsumed).toHaveBeenCalledWith("p1");
    expect(h.deps.ledger.get("p1")?.promptState).toBe("consumed");
  });

  it("a TUI message_start with no matching cmdId never calls onConsumed", () => {
    const h = makeHarness();
    h.handler.onMessageStart({ message: { role: "user", content: "unrelated tui text" } });
    expect(h.drv.onConsumed).not.toHaveBeenCalled();
  });

  it("verifier r_BHFA552J P1 (Y7.3): a same-text TUI mirror item enqueued BEFORE our held item is never consumed/removed by its message_start", () => {
    const h = makeHarness();
    // a TUI-sourced queue item with the identical text, already sitting in the mirror first.
    h.deps.queueMirror.enqueue({ text: "same-text", deliver: "steer", source: "tui" });
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "same-text" }, 1000, {
      text: "same-text",
      sessionId: "sess-1",
    });
    h.deps.ledger.updatePrompt("p1", { promptState: "dispatched" }, 1000);
    h.handler.onInputEvent({ text: "same-text", source: "extension", streamingBehavior: "steer" });
    expect(h.deps.ledger.get("p1")?.promptState).toBe("queued");
    h.handler.onMessageStart({ message: { role: "user", content: "same-text" } });
    // our entry is correctly attributed/consumed...
    expect(h.deps.ledger.get("p1")?.promptState).toBe("consumed");
    expect(h.drv.onConsumed).toHaveBeenCalledWith("p1");
    // ...and the TUI item (enqueued first, same text) is UNTOUCHED — a blind dequeueByText would
    // have grabbed it instead (FIFO: steer-first, same text).
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    expect(h.deps.queueMirror.items()[0]?.source).toBe("tui");
  });

  it("verifier r_BHFA552J P1 (Y7.3): with hold OFF, the OLD blind dequeueByText behavior is unchanged (byte-identical)", () => {
    const h = makeHarness({ drv: undefined });
    h.deps.queueMirror.enqueue({ text: "same-text", deliver: "steer", source: "tui" });
    h.deps.ledger.begin("p1", "prompt", { op: "prompt", text: "same-text" }, 1000, { text: "same-text" });
    h.deps.ledger.updatePrompt("p1", { promptState: "dispatched" }, 1000);
    h.handler.onInputEvent({ text: "same-text", source: "extension", streamingBehavior: "steer" });
    h.handler.onMessageStart({ message: { role: "user", content: "same-text" } });
    // old behavior: blind FIFO dequeueByText grabs the TUI item (enqueued first) — our ledger entry
    // is left "queued" (not consumed) since the dequeued item carries no cmdId.
    expect(h.deps.ledger.get("p1")?.promptState).toBe("queued");
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    expect(h.deps.queueMirror.items()[0]?.source).toBe("web");
  });
});

describe("createCommandHandler — Y8.1 stale-B1 liveness degrade (real driver + real buffer wired end-to-end)", () => {
  /** Unlike the fake-driver suites above, this harness wires a REAL `createHoldDriver` (real
   * buffer, `dispatchToPi` → the real handler's `dispatchHeld`) exactly the way index.ts will, so
   * the degrade's effect on the FULL prompt path — ledger, buffer, reply frame, sends — is proven
   * at the handler level (the real-pi path is G0's `steer-hold-driver.test.ts` row). */
  interface RealHarness {
    handler: ReturnType<typeof createCommandHandler>;
    drv: HoldDriver;
    buffer: ReturnType<typeof createHoldBuffer>;
    ledger: ReturnType<typeof createCommandLedger>;
    sent: Array<CmdResultFrame | CmdLateFrame>;
    sentUserMessages: Array<{ text: string; options?: unknown }>;
    timers: ReturnType<typeof fakeTimerQueue>;
    ctx: ReturnType<typeof fakeCtx>["ctx"];
  }
  function makeRealHarness(): RealHarness {
    const { pi, sentUserMessages } = fakePi();
    // idle:false (a busy run can hold), pending:true (confirm() skips its poll loop).
    const { ctx } = fakeCtx({ mode: "tui", idle: false, pending: true });
    const sent: Array<CmdResultFrame | CmdLateFrame> = [];
    const timers = fakeTimerQueue();
    const originEntry = { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() };
    const ledger = createCommandLedger();
    let drv: HoldDriver | undefined;
    const deps: CommandHandlerDeps = {
      pi,
      getCtx: () => ctx,
      getSessionId: () => "sess-1",
      ledger,
      queueMirror: createQueueMirror(),
      compactionState: { manualCompacting: false, dispose() {} },
      originEntry,
      builtinBridge: { execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })) },
      controlEnabled: () => true,
      now: () => Date.now(),
      send: (f) => sent.push(f),
      onChanged: () => undefined,
      setTimer: timers.setTimer,
      owner: "owner-1",
      hold: () => drv,
    };
    const handler = createCommandHandler(deps);
    const buffer = createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
    drv = createHoldDriver({
      buffer,
      owner: "owner-1",
      getSessionId: () => "sess-1",
      holdCap: () => true,
      dispatchToPi: (item) => handler.dispatchHeld(item),
      onReturned: () => undefined,
      publish: () => undefined,
      now: () => Date.now(), // real clock: confirm()'s poll loop bounds itself against now()
      setRefTimer: (_ms, fn) => {
        const h = setImmediate(fn);
        return { cancel: () => clearImmediate(h) };
      },
      nextMacrotask: () => new Promise((r) => setImmediate(r)),
    });
    return {
      handler,
      drv: drv as HoldDriver,
      buffer,
      ledger,
      sent,
      sentUserMessages,
      timers,
      ctx,
    };
  }

  /** Lead-in: run 1 holds S1 (c1), dispatches it at turn_end (delivered once through the REAL
   * dispatchHeld), then ends the run without E2 ever arriving — the canonical stale-B1 state. */
  async function leadStaleRun1(h: RealHarness): Promise<void> {
    h.drv.onContext(h.ctx); // run 1 arms
    h.handler.handle(frame("c1", { op: "prompt", text: "S1", deliver: "steer" }));
    expect(h.ledger.get("c1")?.promptState).toBe("held");
    await h.drv.onTurnEnd({ outcome: "completed" }, h.ctx);
    expect(h.sentUserMessages.filter((m) => m.text === "S1")).toHaveLength(1); // dispatched once
    expect(h.drv.inflightCmdId()).toBe("c1");
    h.drv.onAgentEnd(h.ctx); // run 1 ends — no onConsumed ever fires for c1
    h.drv.onContext(h.ctx); // run 2 arms
  }

  it("stale B1 from run N ⇒ a prompt in run N+1 goes NATIVE and is delivered exactly once (ledger dispatched, not held, not recallable, absent from the held projection)", async () => {
    const h = makeRealHarness();
    await leadStaleRun1(h);
    h.handler.handle(frame("c2", { op: "prompt", text: "S2", deliver: "steer" }));
    // native delivery: exactly one sendUserMessage for S2, on the existing native path…
    expect(h.sentUserMessages.filter((m) => m.text === "S2")).toHaveLength(1);
    // …the ledger shows a normal sent/dispatched entry (text retained), never "held"…
    expect(h.ledger.get("c2")).toMatchObject({ promptState: "dispatched", text: "S2" });
    // …and the stale item itself is never resent (still exactly one S1 send).
    expect(h.sentUserMessages.filter((m) => m.text === "S1")).toHaveLength(1);
    // projection consistency: the degraded prompt never entered the hold buffer, so the held
    // projection cannot include it; the stale inflight item was released on send (not held either).
    expect(h.buffer.held("sess-1")).toHaveLength(0);
    expect(h.buffer.project("sess-1", Date.now()).filter((r) => r.state === "held")).toHaveLength(0);
    // not recallable: a recall of c2 reports too_late (past held — it is already dispatched).
    h.handler.handle(frame("c3", { op: "recall", target: "c2" }));
    expect(h.sent.at(-1)).toMatchObject({ ok: true, data: { op: "recall", outcome: "too_late" } });
    // the native path's own 3s HTTP-wait reply fires unobserved (no input event in this harness)
    h.timers.fireByMs(3_000);
    expect(h.sent.find((f) => "id" in f && f.id === "c2")).toMatchObject({
      ok: true,
      data: { op: "prompt", delivery: "unobserved" },
    });
    // and B1 itself was never lifted by the degrade — only E2 / a boundary / dispose may do that.
    expect(h.drv.inflightCmdId()).toBe("c1");
  });

  it("late E2 for the stale item restores holding: the NEXT prompt is held again", async () => {
    const h = makeRealHarness();
    await leadStaleRun1(h);
    h.drv.onConsumed("c1"); // the stale item's E2 finally arrives
    expect(h.drv.inflightCmdId()).toBeUndefined();
    h.handler.handle(frame("c2", { op: "prompt", text: "S2", deliver: "steer" }));
    expect(h.ledger.get("c2")?.promptState).toBe("held"); // held again, not native
    expect(h.sentUserMessages.filter((m) => m.text === "S2")).toHaveLength(0); // nothing sent yet
    expect(h.sent.find((f) => "id" in f && f.id === "c2")).toMatchObject({
      ok: true,
      data: { op: "prompt", delivery: "held", behavior: "steer" },
    });
  });
});
