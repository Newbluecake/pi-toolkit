/**
 * D15: steer/abort_subagent timeout ⇒ "late" state machine (running → late_ok | late_failed,
 * `cmd_late`), the per-runId busy lock, and the shared 8-hang cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import type { QueryControlPort } from "../../../src/web-hub/agent/index.js";
import type { CmdFrame, CmdOrigin, CmdLateFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
function frame(id: string, cmd: CmdFrame["cmd"]): CmdFrame {
  return { t: "cmd", rid: `r-${id}`, id, deadlineMs: 8000, origin: ORIGIN, cmd };
}

function makeHarness(query: QueryControlPort) {
  const { pi } = fakePi();
  const { ctx } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const timers = fakeTimerQueue();
  const originEntry = { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() };
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => "sess-1",
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: {
      get manualCompacting() {
        return false;
      },
      dispose() {},
    },
    originEntry,
    builtinBridge: { execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }) },
    query: () => query,
    controlEnabled: () => true,
    now: () => 1000,
    send: (f) => sent.push(f),
    onChanged: () => {},
    setTimer: timers.setTimer,
  };
  const handler = createCommandHandler(deps);
  return { handler, deps, sent, timers, originEntry };
}

describe("D15 — steer_subagent timeout ⇒ late", () => {
  it("a steer that never settles ⇒ 5s E_DEADLINE{effect:'unknown', retryable:true}; ledger stays running", () => {
    let neverResolve: Promise<{ ok: true }> = new Promise(() => {});
    const query: QueryControlPort = {
      get: () => ({ status: "running" }),
      steer: () => neverResolve as Promise<{ ok: true } | { ok: false; reason: string }>,
      stop: () => Promise.resolve({ ok: true, escalatedTo: "L2" }),
    };
    const h = makeHarness(query);
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    h.timers.fireByMs(5000);
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_DEADLINE", retryable: true, effect: "unknown" },
    ]);
    expect(h.deps.ledger.get("c1")?.state).toBe("running"); // D7 rule 4: stays running until the real result lands
    void neverResolve;
  });

  it("same runId while the original steer is late ⇒ E_BUSY_STEER (the lock survives the timeout)", () => {
    const query: QueryControlPort = {
      get: () => ({ status: "running" }),
      steer: () => new Promise(() => {}),
      stop: () => Promise.resolve({ ok: true, escalatedTo: "L2" }),
    };
    const h = makeHarness(query);
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    h.timers.fireByMs(5000);
    h.handler.handle(frame("c2", { op: "steer_subagent", runId: "r1", text: "again" }));
    expect(h.sent[1]).toMatchObject({ ok: false, code: "E_BUSY_STEER", retryable: true });
  });

  it("late settlement (ok) after the timeout ⇒ cmd_late, ledger transitions to late_ok, notify fires", async () => {
    let resolveIt: ((v: { ok: true }) => void) | undefined;
    const query: QueryControlPort = {
      get: () => ({ status: "running" }),
      steer: () => new Promise((resolve) => (resolveIt = resolve)),
      stop: () => Promise.resolve({ ok: true, escalatedTo: "L2" }),
    };
    const h = makeHarness(query);
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    h.timers.fireByMs(5000);
    resolveIt!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[1]).toEqual({
      t: "cmd_late",
      id: "c1",
      op: "steer_subagent",
      at: 1000,
      ok: true,
      data: { op: "steer_subagent" },
    });
    expect(h.deps.ledger.get("c1")).toMatchObject({ state: "ok", late: true });
    expect(h.originEntry.notify).toHaveBeenCalledWith(expect.anything(), "steer subagent r1", ORIGIN);
  });

  it("late settlement (failure) ⇒ cmd_late with the mapped error, ledger late_failed", async () => {
    let rejectIt: ((v: { ok: false; reason: string }) => void) | undefined;
    const query: QueryControlPort = {
      get: () => ({ status: "running" }),
      steer: () => new Promise((resolve) => (rejectIt = resolve)),
      stop: () => Promise.resolve({ ok: true, escalatedTo: "L2" }),
    };
    const h = makeHarness(query);
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    h.timers.fireByMs(5000);
    rejectIt!({ ok: false, reason: "steer_rejected" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[1]).toMatchObject({ t: "cmd_late", id: "c1", ok: false, code: "E_SUBAGENT_REJECTED" });
    const entry = h.deps.ledger.get("c1");
    expect(entry?.state).toBe("failed");
    expect(entry?.late).toBe(true);
  });

  it("the run reaching a terminal status releases the busy lock even before the late promise settles", () => {
    let status = "running";
    const query: QueryControlPort = {
      get: () => ({ status }),
      steer: () => new Promise(() => {}),
      stop: () => Promise.resolve({ ok: true, escalatedTo: "L2" }),
    };
    const h = makeHarness(query);
    h.handler.handle(frame("c1", { op: "steer_subagent", runId: "r1", text: "go" }));
    h.timers.fireByMs(5000);
    status = "completed";
    h.handler.handle(frame("c2", { op: "steer_subagent", runId: "r1", text: "again" }));
    // released the stale lock ⇒ falls through to the normal not-running precheck, not E_BUSY_STEER
    expect(h.sent[1]).toMatchObject({ ok: false, code: "E_NOT_RUNNING" });
  });

  it("8 concurrently-late steer/stop calls exhaust the shared cap ⇒ the 9th is rejected up front", () => {
    const query: QueryControlPort = {
      get: () => ({ status: "running" }),
      steer: () => new Promise(() => {}),
      stop: () => new Promise(() => {}),
    };
    const h = makeHarness(query);
    for (let i = 0; i < 4; i++) {
      h.handler.handle(frame(`steer${i}`, { op: "steer_subagent", runId: `run${i}`, text: "go" }));
    }
    for (let i = 0; i < 4; i++) {
      h.handler.handle(frame(`stop${i}`, { op: "abort_subagent", runId: `stoprun${i}` }));
    }
    h.timers.fireByMs(5000); // times out the 4 steers
    h.timers.fireByMs(6000); // times out the 4 stops ⇒ lateCount reaches 8
    h.handler.handle(frame("overflow", { op: "steer_subagent", runId: "run-overflow", text: "go" }));
    expect(h.sent.find((f) => f.id === "overflow")).toMatchObject({ ok: false, code: "E_BUSY_STEER" });
  });
});

describe("D15 — abort_subagent timeout ⇒ late", () => {
  it("a stop that never settles ⇒ 6s E_DEADLINE{effect:'unknown'}; late settlement ⇒ cmd_late", async () => {
    let resolveIt: ((v: { ok: true; escalatedTo: "L2" }) => void) | undefined;
    const query: QueryControlPort = {
      get: () => ({ status: "running" }),
      steer: () => Promise.resolve({ ok: true }),
      stop: () => new Promise((resolve) => (resolveIt = resolve)),
    };
    const h = makeHarness(query);
    h.handler.handle(frame("c1", { op: "abort_subagent", runId: "r1" }));
    h.timers.fireByMs(6000);
    expect(h.sent).toEqual([
      { t: "cmd_result", rid: "r-c1", id: "c1", ok: false, code: "E_DEADLINE", retryable: true, effect: "unknown" },
    ]);
    resolveIt!({ ok: true, escalatedTo: "L2" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent[1]).toMatchObject({ t: "cmd_late", id: "c1", ok: true });
  });
});
