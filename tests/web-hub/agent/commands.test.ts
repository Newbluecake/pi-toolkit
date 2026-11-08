/**
 * agent-side command dispatcher (plan §4.2/§4.3/§4.5/§4.6 delegation/D5/D13/D21, §9.1/§9.1 v2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import { createMentionRegistry } from "../../../src/mention/registry.js";
import type { OriginEntryPort } from "../../../src/web-hub/agent/origin-entry.js";
import type { QueryControlPort } from "../../../src/web-hub/agent/index.js";
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
  onChanged: ReturnType<typeof vi.fn>;
  timers: ReturnType<typeof fakeTimerQueue>;
  ctxState: ReturnType<typeof fakeCtx>["state"];
  compaction: { manualCompacting: boolean };
  query: QueryControlPort | undefined;
  builtinBridge: BuiltinBridge;
  originEntry: OriginEntryPort & { appendOrigin: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

function makeHarness(
  over: {
    control?: boolean;
    query?: QueryControlPort;
    now?: () => number;
    mention?: CommandHandlerDeps["mention"];
    promptGate?: CommandHandlerDeps["promptGate"];
    hold?: CommandHandlerDeps["hold"];
  } = {},
): Harness {
  const { pi } = fakePi();
  const { ctx, state } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const onChanged = vi.fn();
  const timers = fakeTimerQueue();
  const compaction = { manualCompacting: false };
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
    isQuiet: () => false, // web-resume §2.4: only the real bridge marks `resume __list` quiet
  };
  const originEntry = {
    appendOrigin: vi.fn(),
    notify: vi.fn(),
    dispose: vi.fn(),
  };
  let query = over.query;
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
    controlEnabled: () => over.control ?? true,
    now: over.now ?? (() => 1000),
    send: (f) => sent.push(f),
    onChanged,
    setTimer: timers.setTimer,
    ...(query !== undefined ? { query: () => query } : {}),
    ...(over.mention !== undefined ? { mention: over.mention } : {}),
    ...(over.promptGate !== undefined ? { promptGate: over.promptGate } : {}),
    ...(over.hold !== undefined ? { hold: over.hold } : {}),
  };
  const handler = createCommandHandler(deps);
  return { handler, deps, sent, onChanged, timers, ctxState: state, compaction, query, builtinBridge, originEntry };
}

describe("createCommandHandler — control disabled", () => {
  it("replies E_UNSUPPORTED and never touches the ledger", () => {
    const h = makeHarness({ control: false });
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" },
    ]);
    expect(h.deps.ledger.get("c1")).toBeUndefined();
  });
});

describe("createCommandHandler — prompt (§4.2/§4.3/D4/D5/D13/D21)", () => {
  it.each(["/mem", "/mem init", "  /mem session add x", "/mem\nhub rm x"])(
    "refuses memory prompts before routing or SDK dispatch: %s",
    (text) => {
      const h = makeHarness();
      const send = vi.spyOn(h.deps.pi, "sendUserMessage");
      h.handler.handle(frame("memory-prompt", { op: "prompt", text, deliver: "followUp" }));
      expect(h.sent).toMatchObject([{ ok: false, code: "E_COMMAND_DENIED", retryable: false, effect: "none" }]);
      expect(send).not.toHaveBeenCalled();
      expect(h.originEntry.appendOrigin).not.toHaveBeenCalled();
      h.handler.dispose();
    },
  );
  it.each([
    "/webhub 2fa enroll",
    "/webhub 2fa recovery",
    "/webhub 2fa reset --confirm",
    "/webhub passwd",
    "/webhub user list",
    "/webhub user delete admin",
  ])("prompt op cannot smuggle TUI auth administration: %s", (text) => {
    const h = makeHarness();
    const send = vi.spyOn(h.deps.pi, "sendUserMessage");
    h.handler.handle(frame("auth-admin", { op: "prompt", text, deliver: "steer" }));
    expect(h.sent).toMatchObject([{ ok: false, code: "E_COMMAND_DENIED", effect: "none" }]);
    expect(send).not.toHaveBeenCalled();
    expect(h.originEntry.appendOrigin).not.toHaveBeenCalled();
    h.handler.dispose();
  });

  it("routes a registered running mention before topic-switch/hold and settles exactly once", async () => {
    const registry = createMentionRegistry();
    registry.register("bot", { runId: "run-old", type: "general", parent: "root" });
    const steer = vi.fn(async () => ({ ok: true as const }));
    const gate = vi.fn(() => ({
      tryClaim: vi.fn(() => true),
      isIdle: vi.fn(() => true),
    }));
    const canHold = vi.fn(() => true);
    const hold = vi.fn(() => true);
    const h = makeHarness({
      mention: () => ({
        registry,
        query: { get: () => ({ status: "running", diag: { lastEventAt: 1 } }), steer },
        spawn: { spawn: vi.fn() as never },
        fabricEnabled: () => true,
      }),
      promptGate: gate,
      hold: () => ({ canHold, hold }) as never,
    });
    const send = vi.spyOn(h.deps.pi, "sendUserMessage");

    h.handler.handle(frame("c1", { op: "prompt", text: "@bot please rebase", deliver: "steer" }));
    await Promise.resolve();
    await Promise.resolve();

    // fabric wake seam B: a web @mention is a human act ⇒ origin level 0
    expect(steer).toHaveBeenCalledWith("run-old", expect.stringContaining("用户消息：\nplease rebase"), { level: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(canHold).not.toHaveBeenCalled();
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: "r-c1",
        id: "c1",
        ok: true,
        data: {
          op: "prompt",
          delivery: "observed",
          behavior: "steer",
          mention: { action: "steer", label: "bot", runId: "run-old" },
        },
      },
    ]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ state: "ok" });
    expect(h.sent).toHaveLength(1);
  });

  it("resumes a registered terminal mention with the same label", async () => {
    const registry = createMentionRegistry();
    registry.register("bot", { runId: "run-done", type: "general", parent: "root" });
    const spawn = vi.fn(async () => ({ runId: "run-new" }));
    const h = makeHarness({
      mention: () => ({
        registry,
        query: { get: () => ({ status: "completed" }), steer: vi.fn() },
        spawn: { spawn: spawn as never },
      }),
    });

    h.handler.handle(frame("c1", { op: "prompt", text: "@bot continue", deliver: "followUp" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ label: "bot", resumeFrom: "run-done", prompt: "continue" }),
    );
    expect(h.sent[0]).toMatchObject({
      ok: true,
      data: { mention: { action: "resume", label: "bot", runId: "run-new" } },
    });
  });

  it("leaves an unknown label on the legacy prompt path", () => {
    const registry = createMentionRegistry();
    const h = makeHarness({
      mention: () => ({
        registry,
        query: { get: () => undefined, steer: vi.fn() },
        spawn: { spawn: vi.fn() as never },
      }),
    });
    const send = vi.spyOn(h.deps.pi, "sendUserMessage");

    h.handler.handle(frame("c1", { op: "prompt", text: "@ghost hi", deliver: "steer" }));

    expect(send).toHaveBeenCalledWith("@ghost hi", { deliverAs: "steer", expandPromptTemplates: false });
  });

  it("reports a mention routing error while treating the input as handled", async () => {
    const registry = createMentionRegistry();
    registry.register("bot", { runId: "run-old", type: "general", parent: "root" });
    const reportError = vi.fn();
    const h = makeHarness({
      mention: () => ({
        registry,
        query: {
          get: () => ({ status: "running" }),
          steer: vi.fn(async () => ({ ok: false as const, reason: "busy", detail: "too late" })),
        },
        spawn: { spawn: vi.fn() as never },
        reportError,
      }),
    });

    h.handler.handle(frame("c1", { op: "prompt", text: "@bot stop", deliver: "steer" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith("cannot steer @bot: too late");
    expect(h.sent[0]).toMatchObject({
      ok: true,
      data: { mention: { action: "error", label: "bot", error: "cannot steer @bot: too late" } },
    });
    expect(h.sent).toHaveLength(1);
  });

  it("always passes deliverAs + expandPromptTemplates:false to sendUserMessage (D4)", () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.deps.pi, "sendUserMessage");
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "followUp" }));
    expect(spy).toHaveBeenCalledWith("hi", { deliverAs: "followUp", expandPromptTemplates: false });
  });

  it("writes the origin entry before dispatching", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.originEntry.appendOrigin).toHaveBeenCalledWith("prompt", "c1", ORIGIN, "steer");
  });

  it("a sendUserMessage that synchronously fires the observing input event in the same call stack is still observed (todo #32 finding 3: the real path can do exactly this)", () => {
    const h = makeHarness();
    // Simulate pi's real behaviour: `sendUserMessage` can, on some code paths (idle/streaming),
    // synchronously run the input handler chain \u2014 including web-hub's own observer \u2014 before
    // returning. If the pending-observation bookkeeping isn't in place *before* this call, the
    // observer finds nothing to settle and the reply wrongly falls through to the 3s timeout.
    h.deps.pi.sendUserMessage = (text: string) => {
      h.handler.onInputEvent({ text, source: "extension", streamingBehavior: "steer" });
    };
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: "r-c1",
        id: "c1",
        ok: true,
        data: { op: "prompt", delivery: "observed", behavior: "steer" },
      },
    ]);
    // the 3s timer must have been registered-then-cancelled, not left dangling to double-reply
    h.timers.fireByMs(3000);
    expect(h.sent).toHaveLength(1);
  });

  it("observed before the 3s window ⇒ ok{delivery:'observed', behavior} immediately, HTTP timer cancelled", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sent).toHaveLength(0); // still waiting on observation
    h.handler.onInputEvent({ text: "hi", source: "extension", streamingBehavior: "steer" });
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: "r-c1",
        id: "c1",
        ok: true,
        data: { op: "prompt", delivery: "observed", behavior: "steer" },
      },
    ]);
    h.timers.fireByMs(3000); // must be a no-op now — already replied
    expect(h.sent).toHaveLength(1);
  });

  it("onSessionBoundary: a queued web item ends dropped{session} AND unbound, so the next session's ctl slot still carries it (todo #8 residual #2)", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.handler.onInputEvent({ text: "hi", source: "extension", streamingBehavior: "steer" });
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "queued" });
    h.handler.onSessionBoundary(); // session_shutdown — the link may be down right now
    h.ctxState.sessionId = "sess-2";
    h.handler.onSessionBoundary(); // session_start of the replacement session: nothing left to clear
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dropped", reason: "session" });
    expect(h.deps.ledger.frame("sess-2", "ep", 1000).items).toContainEqual(
      expect.objectContaining({ cmdId: "c1", state: "dropped", reason: "session" }),
    );
  });

  it("unobserved after 3s ⇒ ok{delivery:'unobserved'} (D5: never a hard failure)", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.timers.fireByMs(3000);
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "prompt", delivery: "unobserved" } },
    ]);
  });

  it("still-dispatched 30s later ⇒ ledger promptState finalizes to unconfirmed(unobserved)", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.timers.fireByMs(3000);
    h.timers.fireByMs(30_000);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "unconfirmed", reason: "unobserved" });
  });

  it("idle prompt observed then a matching message_start ⇒ promptState transitions straight to 'consumed' (acc32-B2①: no dangling 'started')", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    // idle path: pi reports no streamingBehavior at all (agent was idle when it processed input)
    h.handler.onInputEvent({ text: "hi", source: "extension" });
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "observed", behavior: "idle" });
    h.handler.onMessageStart({ message: { role: "user", content: "hi" } });
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });

  it("steer/followUp prompt observed ⇒ queued in the mirror, then consumed on message_start", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    h.handler.onInputEvent({ text: "hi", source: "extension", streamingBehavior: "steer" });
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "queued" });
    h.handler.onMessageStart({ message: { role: "user", content: "hi" } });
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });

  it("empty text ⇒ E_BAD_REQUEST, effect none (deleted from ledger, retryable once fixed)", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "   ", deliver: "steer" }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_BAD_REQUEST", retryable: true, effect: "none" },
    ]);
    expect(h.deps.ledger.get("c1")).toBeUndefined();
  });

  it("oversized text (>48 KiB) ⇒ E_BAD_REQUEST", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "x".repeat(49 * 1024), deliver: "steer" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
  });

  it("manual compaction window ⇒ E_BUSY_COMPACTING, retryable (D13)", () => {
    const h = makeHarness();
    h.compaction.manualCompacting = true;
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_BUSY_COMPACTING", retryable: true, effect: "none" },
    ]);
  });

  it("expect.sessionId mismatch ⇒ E_SESSION_CHANGED, not retryable (D21)", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer", expect: { sessionId: "other" } }));
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: "r-c1",
        id: "c1",
        ok: false,
        code: "E_SESSION_CHANGED",
        retryable: false,
        effect: "none",
      },
    ]);
  });

  it("stale ctx (getCtx returns undefined) ⇒ E_STALE_CTX, retryable", () => {
    const h = makeHarness();
    h.deps.getCtx = () => undefined;
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_STALE_CTX", retryable: true, effect: "none" },
    ]);
  });

  it("sendUserMessage throwing synchronously ⇒ E_STALE_CTX", () => {
    const h = makeHarness();
    h.deps.pi.sendUserMessage = () => {
      throw new Error("detached");
    };
    h.handler.handle(frame("c1", { op: "prompt", text: "hi", deliver: "steer" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_STALE_CTX" });
  });
});

describe("createCommandHandler — abort (§4.2)", () => {
  it("reports wasBusy from !ctx.isIdle() and calls ctx.abort(); notifies (tui)", () => {
    const h = makeHarness();
    h.ctxState.idle = false;
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(h.ctxState.abortCalls).toBe(1);
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "abort", wasBusy: true } },
    ]);
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "abort", ORIGIN);
  });

  it("idle abort ⇒ wasBusy:false (idempotent)", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "abort", wasBusy: false } },
    ]);
  });

  it("ctx.abort() throwing ⇒ E_STALE_CTX, no notify", () => {
    const h = makeHarness();
    const { ctx } = fakeCtx({ mode: "tui" });
    (ctx as { abort: () => void }).abort = () => {
      throw new Error("gone");
    };
    h.deps.getCtx = () => ctx;
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_STALE_CTX" });
    expect(h.originEntry.notify).not.toHaveBeenCalled();
  });
});

describe("createCommandHandler — command (delegates to BuiltinBridge, §4.6 out of scope)", () => {
  it("forwards to builtinBridge.execute and notifies on success", () => {
    const h = makeHarness();
    (h.builtinBridge.execute as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "sync" },
    });
    h.handler.handle(frame("c1", { op: "command", name: "session", args: "" }));
    expect(h.builtinBridge.execute).toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({ ok: true });
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "/session", ORIGIN, {
      avoidStatusMerge: false,
    });
  });

  it("notifies on success for a CAPTURED extension command (own output already reaches the web via `capture`), plain style (no clobber risk)", () => {
    const h = makeHarness();
    (h.builtinBridge.execute as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: { op: "command", kind: "extension", completion: "sync", captured: true },
    });
    h.handler.handle(frame("c1", { op: "command", name: "agent", args: "status" }));
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "/agent", ORIGIN, { avoidStatusMerge: false });
  });

  it("still notifies on success for an UNCAPTURED (third-party) extension command, but with avoidStatusMerge:true so our attribution notify does not silently overwrite the command's own terminal notify (acc32-B5 revised per verifier r_29729WTC: plan §0.2/U6 requires the terminal notify even for third-party commands; pi's showStatus() merges back-to-back status lines, so origin-entry.ts routes this one through ctx.ui.notify(msg, \"warning\") instead of skipping it)", () => {
    const h = makeHarness();
    (h.builtinBridge.execute as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: { op: "command", kind: "extension", completion: "unknown", captured: false },
    });
    h.handler.handle(frame("c1", { op: "command", name: "probe-cmd", args: "x" }));
    expect(h.sent[0]).toMatchObject({ ok: true });
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "/probe-cmd", ORIGIN, {
      avoidStatusMerge: true,
    });
  });

  it("still notifies for template/skill-kind commands (never captured, but never emit their own ctx.ui.notify either — no clobber risk, plain style)", () => {
    const h = makeHarness();
    (h.builtinBridge.execute as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: { op: "command", kind: "template", completion: "unknown" },
    });
    h.handler.handle(frame("c1", { op: "command", name: "skill:x", args: "" }));
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "/skill:x", ORIGIN, {
      avoidStatusMerge: false,
    });
  });

  it("degrades to E_UNSUPPORTED while builtinBridge is the C0/C11-pending stub", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "command", name: "foo", args: "" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
    expect(h.originEntry.notify).not.toHaveBeenCalled();
  });

  // fix (2026-10-22): the async-late channel — an extension command answering completion:async
  // (capture window still open) replies WITHOUT settling the ledger, so the ctl-slot republish
  // keeps the browser's pendingCtl item alive until handleBridgeLate upgrades it with the output.
  it("completion:async extension command ⇒ reply-only (ledger stays running); handleBridgeLate settles it late with cmd_late", () => {
    const h = makeHarness();
    const f = frame("c1", { op: "command", name: "fabric", args: "status" });
    (h.builtinBridge.execute as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: { op: "command", kind: "extension", completion: "async", captured: true },
    });
    h.handler.handle(f);
    // The HTTP reply went out unchanged …
    expect(h.sent[0]).toMatchObject({
      t: "cmd_result",
      id: "c1",
      ok: true,
      data: { completion: "async", captured: true },
    });
    // … but the entry is still running (no ok-settle that would terminate the UI item early).
    expect(h.deps.ledger.get("c1")).toMatchObject({ state: "running" });
    expect(h.onChanged).not.toHaveBeenCalled();

    const lateBody = {
      ok: true,
      data: {
        op: "command",
        kind: "extension",
        completion: "sync",
        captured: true,
        output: { entries: [{ kind: "notify", text: "fabric status ok", level: "info" }] },
      },
    } as const;
    h.handler.handleBridgeLate(f, lateBody);
    expect(h.deps.ledger.get("c1")).toMatchObject({ state: "ok", late: true });
    expect(h.deps.ledger.query("c1")?.result).toEqual(lateBody);
    expect(h.sent[1]).toMatchObject({ t: "cmd_late", id: "c1", op: "command", ok: true });
    expect(h.onChanged).toHaveBeenCalled();
  });

  it("completion:async BUILTIN commands keep the legacy immediate settle (their cmd_late is an upgrade, not the primary settle)", () => {
    const h = makeHarness();
    (h.builtinBridge.execute as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "async" },
    });
    h.handler.handle(frame("c1", { op: "command", name: "compact", args: "" }));
    expect(h.sent[0]).toMatchObject({ ok: true, data: { completion: "async" } });
    expect(h.deps.ledger.get("c1")).toMatchObject({ state: "ok" }); // settled now, like before
    expect(h.onChanged).toHaveBeenCalled();
  });
});

describe("createCommandHandler — steer_subagent (D15, happy/error paths; timeout covered in steer-late.test.ts)", () => {
  function fakeQuery(over: Partial<QueryControlPort> = {}): QueryControlPort {
    return {
      get: () => ({ status: "running" }),
      steer: () => Promise.resolve({ ok: true }),
      stop: () => Promise.resolve({ ok: true, escalatedTo: "L2" }),
      ...over,
    };
  }

  it("no query port wired ⇒ E_UNSUPPORTED", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
  });

  it("unknown runId ⇒ E_NOT_FOUND", () => {
    const h = makeHarness({ query: fakeQuery({ get: () => undefined }) });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_NOT_FOUND" });
  });

  it("non-running snapshot ⇒ E_NOT_RUNNING", () => {
    const h = makeHarness({ query: fakeQuery({ get: () => ({ status: "completed" }) }) });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_NOT_RUNNING" });
  });

  it("oversized text (>16 KiB) ⇒ E_BAD_REQUEST", () => {
    const h = makeHarness({ query: fakeQuery() });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "x".repeat(17 * 1024) }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
  });

  it("passes a HUMAN origin (level 0) to the query port — a web steer never raises the target's causal level", async () => {
    const steer = vi.fn(() => Promise.resolve({ ok: true as const }));
    const h = makeHarness({ query: fakeQuery({ steer }) });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    await Promise.resolve();
    expect(steer).toHaveBeenCalledWith("r1", "go", { level: 0 });
  });

  it("successful steer ⇒ ok{} and notifies", async () => {
    const h = makeHarness({ query: fakeQuery() });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toEqual([{ t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "steer_subagent" } }]);
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "steer subagent r1", ORIGIN);
  });

  it("steer_rejected ⇒ E_SUBAGENT_REJECTED with detail", async () => {
    const h = makeHarness({
      query: fakeQuery({ steer: () => Promise.resolve({ ok: false, reason: "steer_rejected", detail: "nope" }) }),
    });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_SUBAGENT_REJECTED", message: "nope" });
  });

  it("not_running rejection ⇒ E_NOT_RUNNING", async () => {
    const h = makeHarness({ query: fakeQuery({ steer: () => Promise.resolve({ ok: false, reason: "not_running" }) }) });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_NOT_RUNNING" });
  });

  it("concurrent web steer on the same runId ⇒ E_BUSY_STEER (D15)", () => {
    let resolveFirst: ((v: { ok: true }) => void) | undefined;
    const h = makeHarness({
      query: fakeQuery({ steer: () => new Promise((resolve) => (resolveFirst = resolve)) }),
    });
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    h.handler.handle(frame("c2", { op: "steer_subagent", runId: "r1", text: "again" }));
    expect(h.sent.find((f) => f.id === "c2")).toMatchObject({ ok: false, code: "E_BUSY_STEER", retryable: true });
    void resolveFirst;
  });
});

describe("createCommandHandler — abort_subagent (§4.2 result-reason mapping)", () => {
  function fakeQuery(over: Partial<QueryControlPort> = {}): QueryControlPort {
    return {
      get: () => ({ status: "running" }),
      steer: () => Promise.resolve({ ok: true }),
      stop: () => Promise.resolve({ ok: true, escalatedTo: "L2" }),
      ...over,
    };
  }

  it("ok ⇒ ok{escalatedTo} and notifies", async () => {
    const h = makeHarness({ query: fakeQuery() });
    h.handler.handle(frame("c1", { op: "abort_subagent", runId: "r1" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: true, data: { op: "abort_subagent", escalatedTo: "L2" } },
    ]);
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "stop subagent r1", ORIGIN);
  });

  it("unknown_run ⇒ E_NOT_FOUND", async () => {
    const h = makeHarness({ query: fakeQuery({ stop: () => Promise.resolve({ ok: false, reason: "unknown_run" }) }) });
    h.handler.handle(frame("c1", { op: "abort_subagent", runId: "r1" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_NOT_FOUND" });
  });

  it("already_terminal ⇒ ok{alreadyTerminal:true} (idempotent, not an error)", async () => {
    const h = makeHarness({
      query: fakeQuery({ stop: () => Promise.resolve({ ok: false, reason: "already_terminal", status: "completed" }) }),
    });
    h.handler.handle(frame("c1", { op: "abort_subagent", runId: "r1" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "abort_subagent", alreadyTerminal: true } });
  });

  it("stop_failed ⇒ E_SUBAGENT_REJECTED", async () => {
    const h = makeHarness({
      query: fakeQuery({ stop: () => Promise.resolve({ ok: false, reason: "stop_failed", escalatedTo: "L4" }) }),
    });
    h.handler.handle(frame("c1", { op: "abort_subagent", runId: "r1" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_SUBAGENT_REJECTED" });
  });

  it("get(runId) undefined ⇒ E_NOT_FOUND without calling stop()", () => {
    const stop = vi.fn();
    const h = makeHarness({ query: fakeQuery({ get: () => undefined, stop }) });
    h.handler.handle(frame("c1", { op: "abort_subagent", runId: "r1" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_NOT_FOUND" });
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("createCommandHandler — idempotency (D7, ledger.test.ts covers the ledger unit itself)", () => {
  it("a duplicate id after a terminal result replies with dup:true and does not re-execute", () => {
    const h = makeHarness();
    h.ctxState.idle = false;
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(h.ctxState.abortCalls).toBe(1);
    h.handler.handle(frame("c1", { op: "abort" }));
    expect(h.ctxState.abortCalls).toBe(1); // not re-executed
    expect(h.sent[1]).toEqual({
      t: "cmd_result",
      rid: "r-c1",
      id: "c1",
      ok: true,
      dup: true,
      data: { op: "abort", wasBusy: true },
    });
  });

  it("same id, different payload ⇒ E_BAD_REQUEST (id reused) while the original is still in flight", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "a", deliver: "steer" }));
    h.handler.handle(frame("c1", { op: "prompt", text: "b", deliver: "steer" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
  });
});

describe("createCommandHandler — queryOnly (§3.4)", () => {
  it("unknown id ⇒ E_UNKNOWN_ID", () => {
    const h = makeHarness();
    h.handler.handle(frame("ghost", { op: "abort" }, { queryOnly: true }));
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: "r-ghost",
        id: "ghost",
        ok: false,
        code: "E_UNKNOWN_ID",
        retryable: false,
        effect: "none",
      },
    ]);
  });

  it("running id ⇒ ok{data:{op:'query', state:'running'}} without executing anything", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }, { queryOnly: true }));
    // never began (id unknown) ⇒ E_UNKNOWN_ID; begin a real running entry via steer with no query port
    // configured so it stays "running" is not directly reachable — assert against a manually begun entry:
    h.deps.ledger.begin("c2", "abort", { op: "abort" }, 1000);
    h.handler.handle(frame("c2", { op: "abort" }, { queryOnly: true }));
    expect(h.sent[1]).toEqual({
      t: "cmd_result",
      rid: "r-c2",
      id: "c2",
      ok: true,
      data: { op: "query", state: "running" },
    });
  });
});

describe("#40 raw slash prompt validation", () => {
  it.each([
    ["/名字\n raw  ", [], true, "sent"],
    ["/名字 raw", [{ name: "名字", source: "extension" }], true, "E_BAD_REQUEST"],
    ["/名字 raw", null, true, "E_UNSUPPORTED"],
    ["/legal-name bad args", null, true, "sent"],
    [" /名字", null, true, "sent"],
    ["//名字", null, true, "sent"],
    ["/名字", null, false, "sent"],
  ])("validates %s only in the enabled invalid-wire-name path", (text, commands, enabled, expected) => {
    const h = makeHarness();
    h.deps.unknownSlashTextEnabled = () => enabled as boolean;
    Object.assign(h.deps.pi, { getCommands: () => commands });
    const send = vi.spyOn(h.deps.pi, "sendUserMessage");
    h.handler.handle(frame("raw-slash", { op: "prompt", text: text as string, deliver: "followUp" }));
    if (expected === "sent") {
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(text, { deliverAs: "followUp", expandPromptTemplates: false });
      expect(h.originEntry.appendOrigin).toHaveBeenCalledTimes(1);
    } else {
      expect(send).not.toHaveBeenCalled();
      expect(h.originEntry.appendOrigin).not.toHaveBeenCalled();
      expect(h.sent).toMatchObject([{ ok: false, code: expected, effect: "none" }]);
      expect(h.deps.ledger.get("raw-slash")?.state).toBe("failed");
    }
    h.handler.dispose();
  });
  it("never classifies Feishu raw prompts", () => {
    const h = makeHarness();
    h.deps.unknownSlashTextEnabled = () => true;
    const read = vi.fn(() => {
      throw new Error("must skip");
    });
    Object.assign(h.deps.pi, { getCommands: read });
    const send = vi.spyOn(h.deps.pi, "sendUserMessage");
    h.handler.handle(
      frame("bot", { op: "prompt", text: "/名字 raw", deliver: "followUp" }, { origin: { ...ORIGIN, ip: "feishu" } }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    h.handler.dispose();
  });
});

it("#40 thread metadata skips W3 even when the wire name is invalid", () => {
  const h = makeHarness();
  h.deps.unknownSlashTextEnabled = () => true;
  const read = vi.fn(() => {
    throw new Error("must not classify threads");
  });
  Object.assign(h.deps.pi, { getCommands: read });
  const send = vi.spyOn(h.deps.pi, "sendUserMessage");
  h.handler.handle(
    frame("thread-raw", { op: "prompt", text: "/注册名 x", deliver: "followUp", thread: {} } as CmdFrame["cmd"]),
  );
  expect(read).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  h.handler.dispose();
});

describe("direct Web memory reads", () => {
  it.each([
    ["idle-busy", "E_COMMAND_DENIED"],
    ["pending", "E_COMMAND_DENIED"],
    ["compacting", "E_BUSY_COMPACTING"],
    ["switch", "E_STALE_CTX"],
    ["topic-switch", "E_STALE_CTX"],
  ] as const)("refuses %s before the real bridge invokes its read port", async (state, code) => {
    const { createBuiltinBridge } = await import("../../../src/web-hub/agent/builtin-bridge.js");
    const h = makeHarness();
    const send = vi.spyOn(h.deps.pi, "sendUserMessage");
    const read = vi.fn(() => ({ ok: true as const, output: "unexpected" }));
    const ctx = {
      ...h.deps.getCtx()!,
      cwd: "/tmp",
      isIdle: () => state !== "idle-busy",
      hasPendingMessages: () => state === "pending",
    };
    h.deps.getCtx = () => ctx;
    h.compaction.manualCompacting = state === "compacting";
    h.deps.switchInFlight = () => state === "switch";
    h.deps.topicSwitchActive = () => state === "topic-switch";
    h.deps.builtinBridge = createBuiltinBridge({
      getCtx: () => ctx,
      getSessionId: () => h.ctxState.sessionId,
      memoryRead: read,
    });
    const handler = createCommandHandler(h.deps);
    handler.handle(frame(`busy-${state}`, { op: "command", name: "mem", args: "list" }));
    expect(h.sent).toMatchObject([{ ok: false, code, effect: "none" }]);
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    handler.dispose();
    h.handler.dispose();
  });
  it("returns real readonly results without UI, SDK dispatch or mutations", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { executeMemoryRead } = await import("../../../src/memory/command-readonly.js");
    const { memoryDirFor } = await import("../../../src/memory/paths.js");
    const { createBuiltinBridge } = await import("../../../src/web-hub/agent/builtin-bridge.js");
    const root = mkdtempSync(join(tmpdir(), "web-mem-seam-"));
    try {
      const cwd = join(root, "project");
      const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
      const dir = memoryDirFor(cwd, paths);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "note.md"), "# Topic\n\nExample\n");
      const h = makeHarness();
      const send = vi.spyOn(h.deps.pi, "sendUserMessage");
      const confirm = vi.fn();
      const ctx = { ...h.deps.getCtx()!, cwd, ui: { confirm } };
      h.deps.builtinBridge = createBuiltinBridge({
        getCtx: () => ctx,
        getSessionId: () => h.ctxState.sessionId,
        memoryRead: (args, hostCwd) => executeMemoryRead(args, hostCwd, paths),
      });
      const handler = createCommandHandler(h.deps);
      for (const [id, args] of ["list", "path", "restore", "migrate --dry-run"].entries())
        handler.handle(frame(`read-${id}`, { op: "command", name: "mem", args }));
      expect(h.sent).toHaveLength(4);
      expect(h.deps.ledger.get("read-0")?.memoryCompletion).toBe(true);
      expect(h.deps.ledger.query("read-0")).toMatchObject({ state: "ok", result: { ok: true } });
      expect(h.sent[0]).toMatchObject({
        ok: true,
        data: { output: { entries: [{ text: expect.stringContaining("note.md") }] } },
      });
      expect(h.sent[1]).toMatchObject({ ok: true, data: { output: { entries: [{ text: `memory dir: ${dir}` }] } } });
      expect(h.sent[2]).toMatchObject({
        ok: true,
        data: { output: { entries: [{ text: "no backups or trash entries" }] } },
      });
      expect(h.sent[3]).toMatchObject({
        ok: true,
        data: { output: { entries: [{ text: expect.stringContaining("note.md") }] } },
      });
      for (const [id, args] of ["doctor", "init", "restore --trash abc"].entries())
        handler.handle(frame(`reject-${id}`, { op: "command", name: "mem", args }));
      expect(h.sent.slice(4)).toHaveLength(3);
      for (const result of h.sent.slice(4))
        expect(result).toMatchObject({
          ok: false,
          code: "E_UNSUPPORTED",
          message: expect.stringContaining("E_MEM_WEB_UNSUPPORTED"),
          effect: "none",
        });
      expect(confirm).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual(["note.md"]);
      expect(readFileSync(join(dir, "note.md"), "utf8")).toBe("# Topic\n\nExample\n");
      handler.dispose();
      h.handler.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing and throwing ports, with no SDK fallback", async () => {
    const { createBuiltinBridge } = await import("../../../src/web-hub/agent/builtin-bridge.js");
    for (const mode of ["missing", "throw"] as const) {
      const h = makeHarness();
      const send = vi.spyOn(h.deps.pi, "sendUserMessage");
      const ctx = { ...h.deps.getCtx()!, cwd: "/tmp" };
      h.deps.builtinBridge = createBuiltinBridge({
        getCtx: () => ctx,
        getSessionId: () => h.ctxState.sessionId,
        ...(mode === "throw"
          ? {
              memoryRead: () => {
                throw new Error("unavailable");
              },
            }
          : {}),
      });
      const handler = createCommandHandler(h.deps);
      for (const [id, args] of ["list", "init"].entries())
        handler.handle(frame(`${mode}-${id}`, { op: "command", name: "mem", args }));
      expect(h.sent).toHaveLength(2);
      for (const result of h.sent)
        expect(result).toMatchObject({
          ok: false,
          code: "E_UNSUPPORTED",
          message: expect.stringContaining("E_MEM_CONFIRM_UNAVAILABLE"),
          effect: "none",
        });
      expect(send).not.toHaveBeenCalled();
      handler.dispose();
      h.handler.dispose();
    }
  });
});

describe("memory completion lifecycle", () => {
  const mem = (id: string) => frame(id, { op: "command", name: "mem", args: "list" });
  it("settles mocked synchronous bridge results once and caches non-retryable failures", () => {
    const h = makeHarness();
    vi.mocked(h.builtinBridge.execute).mockReturnValue({
      ok: false,
      code: "E_UNSUPPORTED",
      retryable: true,
      effect: "none",
    });
    h.handler.handle(mem("mem-sync"));
    expect(h.deps.ledger.query("mem-sync")).toMatchObject({ state: "failed", result: { retryable: false } });
    h.handler.handleBridgeLate(mem("mem-sync"), { ok: true, data: { op: "abort" } });
    expect(h.deps.ledger.query("mem-sync")).toMatchObject({ state: "failed", result: { retryable: false } });
    expect(h.sent).toHaveLength(1);
  });
  it("expires at 29 minutes on query before the scheduled timer fires", async () => {
    let now = 1000;
    const h = makeHarness({ now: () => now });
    let resolve!: (value: never) => void;
    vi.mocked(h.builtinBridge.execute).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    h.handler.handle(mem("mem-timeout"));
    expect(h.deps.ledger.query("mem-timeout")?.state).toBe("running");
    now += 29 * 60_000;
    h.handler.handle(frame("mem-timeout", { op: "command", name: "mem", args: "list" }, { queryOnly: true }));
    expect(h.deps.ledger.query("mem-timeout")).toMatchObject({
      state: "failed",
      late: true,
      result: { code: "E_DEADLINE", retryable: false },
    });
    expect(h.timers.pendingCount()).toBe(0);
    expect(h.sent.filter((f) => f.t === "cmd_late")).toHaveLength(1);
    resolve({ ok: true, data: { op: "abort" } } as never);
    await Promise.resolve();
    expect(h.sent.filter((f) => f.t === "cmd_late")).toHaveLength(1);
  });
  it("settles the timeout when the deadline timer fires", () => {
    let now = 1000;
    const h = makeHarness({ now: () => now });
    vi.mocked(h.builtinBridge.execute).mockReturnValue(new Promise(() => {}));
    h.handler.handle(mem("mem-timer"));
    now += 29 * 60_000;
    h.timers.fireByMs(29 * 60_000);
    expect(h.deps.ledger.query("mem-timer")).toMatchObject({
      state: "failed",
      late: true,
      result: { code: "E_DEADLINE", retryable: false },
    });
    expect(h.timers.pendingCount()).toBe(0);
    expect(h.sent.filter((f) => f.t === "cmd_late")).toHaveLength(1);
  });
  it.each(["boundary", "dispose", "tree"])("clears in-flight waiters at %s", (kind) => {
    // Observe the private map without changing production surfaces or intercepting deletion.
    const originalSet = Map.prototype.set;
    let waiters: Map<unknown, unknown> | undefined;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (key === "mem-clean" && value && typeof value === "object" && "timer" in value && "frame" in value)
        waiters = this;
      return originalSet.call(this, key, value);
    });
    const h = makeHarness();
    vi.mocked(h.builtinBridge.execute).mockReturnValue(new Promise(() => {}));
    h.handler.handle(mem("mem-clean"));
    expect(h.timers.pendingCount()).toBe(1);
    expect(waiters?.size).toBe(1);
    if (kind === "boundary") h.handler.onSessionBoundary();
    else if (kind === "dispose") h.handler.dispose();
    else h.handler.clearMemoryWaiters();
    expect(h.timers.pendingCount()).toBe(0);
    expect(waiters?.size).toBe(0);
    spy.mockRestore();
    expect(h.deps.ledger.query("mem-clean")).toMatchObject({
      state: "failed",
      result: { code: "E_STALE_CTX", retryable: false },
    });
  });
});
