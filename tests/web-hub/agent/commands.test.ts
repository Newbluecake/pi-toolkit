/**
 * agent-side command dispatcher (plan §4.2/§4.3/§4.5/§4.6 delegation/D5/D13/D21, §9.1/§9.1 v2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
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

function makeHarness(over: { control?: boolean; query?: QueryControlPort; now?: () => number } = {}): Harness {
  const { pi } = fakePi();
  const { ctx, state } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const onChanged = vi.fn();
  const timers = fakeTimerQueue();
  const compaction = { manualCompacting: false };
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
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
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "/session", ORIGIN);
  });

  it("degrades to E_UNSUPPORTED while builtinBridge is the C0/C11-pending stub", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "command", name: "foo", args: "" }));
    expect(h.sent[0]).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
    expect(h.originEntry.notify).not.toHaveBeenCalled();
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
