/**
 * Busy-steer false-drop regression (field repro): a steer sent from the web while busy is
 * delivered to pi just fine, but the queue mirror used to mark it "dropped" ("returned to
 * the terminal editor / discarded"), misleading the user into resending and duplicating the
 * message.
 *
 * Root cause (pi 1.0.x, `@earendil-works/pi-coding-agent` + `pi-agent-core`): the mirror's
 * enqueue/dequeue are driven by *extension events*, while the 1 Hz `hasPendingMessages()`
 * sample reads pi's internal `_steeringMessages`/`_followUpMessages` arrays synchronously —
 * the two are NOT atomic with respect to each other. Two interleaving windows exist, both
 * letting a 1 Hz tick observe "pi queue empty + mirror non-empty" while the message is in
 * fact alive:
 *
 *  - RC1 (enqueue→push): `prompt()` fires the extension `input` event at
 *    `agent-session.js:1502` (`_runInputHandlers`, per-handler awaited dispatch at
 *    `extensions/runner.js:1202`) and only pushes into `_steeringMessages` afterwards in
 *    `_queueSteer` (`agent-session.js:1697`). Web-hub's input handler runs LAST in that
 *    dispatch chain (input-order.test.ts) or anywhere among other extensions' handlers —
 *    any awaited real I/O in the chain yields to the event loop, and the 1 Hz interval
 *    (`index.ts`'s `onTick`) fires with the mirror item already enqueued but pi's arrays
 *    still empty.
 *  - RC2 (splice→dispatch): at delivery, `_handleAgentEvent` splices the text out of
 *    `_steeringMessages` (`agent-session.js:718-721`) BEFORE `await
 *    this._emitExtensionEvent(event)` (`agent-session.js:735`) reaches web-hub's
 *    `message_start` dequeue. A tick inside that awaited dispatch chain sees
 *    `hasPendingMessages()===false` with the mirror item still queued.
 *
 * Fix (option c of the plan, decision recorded in queue-mirror.ts): `clearIfEmpty` now
 * requires the empty condition to persist for a grace window before clearing — pi's real
 * queue-empty states (TUI Esc `clearQueue()`, abort-with-restore) persist and still get
 * marked dropped; the two race windows are one extension-dispatch chain wide and always
 * resolve before the grace expires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
function frame(id: string, cmd: CmdFrame["cmd"]): CmdFrame {
  return { t: "cmd", rid: `r-${id}`, id, deadlineMs: 8000, origin: ORIGIN, cmd };
}

/** Harness with a controllable clock so grace-window timing is deterministic. */
function makeHarness() {
  const { pi } = fakePi();
  const { ctx } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const timers = fakeTimerQueue();
  let clock = 0;
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => "sess-1",
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror({ now: () => clock }),
    compactionState: {
      get manualCompacting() {
        return false;
      },
      dispose() {},
    },
    originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
    builtinBridge: { execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }) },
    controlEnabled: () => true,
    now: () => clock,
    send: (f) => sent.push(f),
    onChanged: () => {},
    setTimer: timers.setTimer,
  };
  const handler = createCommandHandler(deps);
  return {
    handler,
    deps,
    sent,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("busy web steer — the two race windows must not mark dropped", () => {
  it("RC1 (input event dispatched, _queueSteer push pending): a 1 Hz tick inside the dispatch window leaves the item queued", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "插话：先看这里", deliver: "steer" }));
    // pi fires the extension input event from inside prompt()'s dispatch chain; web-hub's
    // observer runs there. _steeringMessages.push() has NOT happened yet.
    h.handler.onInputEvent({ text: "插话：先看这里", source: "extension", streamingBehavior: "steer" });
    expect(h.deps.queueMirror.items()).toHaveLength(1);

    // 1 Hz tick lands in the gap (hasPendingMessages() still false — RC1).
    h.advance(200);
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.items()).toHaveLength(1); // ← was falsely cleared before the fix
    expect(h.deps.queueMirror.takeDropped()).toEqual([]);
    expect(h.deps.ledger.get("c1")?.promptState).not.toBe("dropped");

    // The dispatch chain resolves; pi's queue is now visibly non-empty.
    h.advance(800);
    h.handler.onPendingSample(true);
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "queued" });

    // Delivered at the next turn boundary: message_start{user} dequeues → consumed, never dropped.
    h.handler.onMessageStart({ message: { role: "user", content: "插话：先看这里" } });
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
    expect(h.deps.queueMirror.takeDropped()).toEqual([]);
  });

  it("RC2 (steer spliced from pi's queue, message_start dispatch still in flight): a tick before the dequeue leaves it queued", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "course correct", deliver: "steer" }));
    h.handler.onInputEvent({ text: "course correct", source: "extension", streamingBehavior: "steer" });

    // Steer waits in pi's queue across a long tool call: every sample sees it pending.
    h.advance(1000);
    h.handler.onPendingSample(true);
    h.advance(1000);
    h.handler.onPendingSample(true);

    // Turn boundary: _handleAgentEvent splices _steeringMessages (hasPending flips false)
    // and starts the AWAITED extension dispatch of message_start. The 1 Hz tick fires in
    // that dispatch chain, before web-hub's message_start observer has dequeued (RC2).
    h.advance(1000);
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.items()).toHaveLength(1); // ← was falsely cleared before the fix
    expect(h.deps.ledger.get("c1")?.promptState).not.toBe("dropped");

    // The dispatch reaches web-hub: dequeue → consumed.
    h.handler.onMessageStart({ message: { role: "user", content: [{ type: "text", text: "course correct" }] } });
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });

    // A later empty sample over an EMPTY mirror is a plain no-op — nothing resurrected, nothing dropped.
    h.advance(1500);
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.takeDropped()).toEqual([]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });
});

describe("busy web steer — legitimate queue-empty states still reach dropped (TUI Esc path preserved)", () => {
  it("a web steer whose queue really stays empty past the grace window is marked dropped exactly once", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "lost steer", deliver: "steer" }));
    h.handler.onInputEvent({ text: "lost steer", source: "extension", streamingBehavior: "steer" });

    // TUI Esc: clearQueue() empties pi's arrays for good — every sample stays false.
    h.advance(100);
    h.handler.onPendingSample(false); // arms the grace, no clear yet
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    h.advance(1600); // past the grace window
    h.handler.onPendingSample(false); // still empty ⇒ this one really was cleared
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.queueMirror.takeDropped()).toEqual(["c1"]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dropped" });
    expect(h.deps.queueMirror.takeDropped()).toEqual([]); // one-shot
  });

  it("a TUI-sourced steer (Esc-cleared, no cmdId) still disappears from the mirror after the grace", () => {
    const h = makeHarness();
    // TUI typed a steer: input event with source "interactive" (commands.ts's tui/extension
    // mirror-enqueue path), pi queued it, then Esc restored it to the editor.
    h.handler.onInputEvent({ text: "typed then escaped", source: "interactive", streamingBehavior: "steer" });
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    h.advance(100);
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.items()).toHaveLength(1); // grace still running
    h.advance(1600);
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.items()).toHaveLength(0);
  });

  it("a hasPending=true sample inside the grace resets it — the next empty window needs a full grace again", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "flip flop", deliver: "steer" }));
    h.handler.onInputEvent({ text: "flip flop", source: "extension", streamingBehavior: "steer" });
    h.advance(100);
    h.handler.onPendingSample(false); // arm
    h.advance(1200);
    h.handler.onPendingSample(true); // pi's queue became visible — reset
    h.advance(1400); // < grace since the reset
    h.handler.onPendingSample(false); // re-arm, not a clear
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    h.advance(1400); // still < grace since the re-arm? no: 1400 < 1500
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    h.advance(200); // now past the grace since the re-arm
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.queueMirror.takeDropped()).toEqual(["c1"]);
  });
});

describe("long steer text (>200 chars) — dequeue matches full text, not the wire-clipped copy", () => {
  // Field bug: a steer whose full text exceeds the wire clip (plan §4.4 "截 200 字符") was
  // delivered and answered by pi, but `dequeueByText` compared the full `message_start` text
  // against the clipped store, so it never matched — the mirror item survived and the
  // clearIfEmpty grace expiry marked it `dropped` ("已退回终端编辑器或被丢弃"). The clip is a
  // wire-display concern; the match key is now the retained full text.
  const long = "先看这里：".repeat(60) + "尾部标记"; // > 200 chars, realistic multi-byte text

  it("a delivered 300+ char steer is consumed by the full message_start text and never dropped", () => {
    const h = makeHarness();
    expect(long.length).toBeGreaterThan(200);
    h.handler.handle(frame("c1", { op: "prompt", text: long, deliver: "steer" }));
    h.handler.onInputEvent({ text: long, source: "extension", streamingBehavior: "steer" });
    // wire stays display-clipped…
    expect(h.deps.queueMirror.items()[0]?.text).toHaveLength(200);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "queued" });

    // …but pi's full-text delivery dequeues it
    h.handler.onMessageStart({ message: { role: "user", content: long } });
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });

    // far past the grace window over a now-empty queue: nothing resurrected as dropped
    h.advance(5000);
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.takeDropped()).toEqual([]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });

  it("regression complement: a long steer whose message_start never arrives is still dropped after the grace", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: long, deliver: "steer" }));
    h.handler.onInputEvent({ text: long, source: "extension", streamingBehavior: "steer" });
    h.advance(100);
    h.handler.onPendingSample(false); // arm the grace
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    h.advance(1600); // past the grace — the TUI-Esc-style real drop is still detected
    h.handler.onPendingSample(false);
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.queueMirror.takeDropped()).toEqual(["c1"]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "dropped" });
  });
});

describe("regressions — existing semantics preserved", () => {
  it("followUp queued while busy dequeues normally on message_start, with a mid-grace empty sample not dropping it", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "then do this", deliver: "followUp" }));
    h.handler.onInputEvent({ text: "then do this", source: "extension", streamingBehavior: "followUp" });
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    h.advance(500);
    h.handler.onPendingSample(false); // race window or brief inter-turn gap — must not drop
    expect(h.deps.queueMirror.items()).toHaveLength(1);
    h.handler.onMessageStart({ message: { role: "user", content: "then do this" } });
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });

  it("steer consumption on message_start is immediate — the grace only gates clearIfEmpty, never dequeueByText", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "fast lane", deliver: "steer" }));
    h.handler.onInputEvent({ text: "fast lane", source: "extension", streamingBehavior: "steer" });
    h.handler.onMessageStart({ message: { role: "user", content: "fast lane" } }); // same tick
    expect(h.deps.queueMirror.items()).toHaveLength(0);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
  });

  it("a late duplicate message_start after the steer was consumed neither re-consumes nor touches a newer queued item", () => {
    const h = makeHarness();
    h.handler.handle(frame("c1", { op: "prompt", text: "same text", deliver: "steer" }));
    h.handler.onInputEvent({ text: "same text", source: "extension", streamingBehavior: "steer" });
    h.handler.onMessageStart({ message: { role: "user", content: "same text" } });
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });

    // A second, differently-queued message is pending when the duplicate message_start arrives.
    h.handler.handle(frame("c2", { op: "prompt", text: "different text", deliver: "followUp" }));
    h.handler.onInputEvent({ text: "different text", source: "extension", streamingBehavior: "followUp" });

    // The stale message_start (same text as the already-consumed steer) must not dequeue the
    // followUp item (exact-text match) and must not disturb c1's terminal state.
    h.handler.onMessageStart({ message: { role: "user", content: "same text" } });
    expect(h.deps.queueMirror.items().map((i) => i.text)).toEqual(["different text"]);
    expect(h.deps.ledger.get("c1")).toMatchObject({ promptState: "consumed" });
    expect(h.deps.ledger.get("c2")).toMatchObject({ promptState: "queued" });
  });

  it("enqueue during an armed grace restarts the grace (a new prompt must never inherit a stale empty window)", () => {
    let clock = 0;
    const m = createQueueMirror({ now: () => clock });
    m.enqueue({ text: "first", deliver: "steer", source: "web", cmdId: "a" });
    clock = 100;
    m.clearIfEmpty(false); // arm: emptySince = 100
    clock = 900; // still within the first grace
    m.enqueue({ text: "second", deliver: "steer", source: "web", cmdId: "b" }); // restarts the grace
    clock = 900 + 1400; // first false sample after the enqueue: arms here (a leaked 100-arm would clear)
    expect(m.clearIfEmpty(false)).toEqual([]);
    expect(m.items()).toHaveLength(2);
    clock = 900 + 1400 + 1500; // past the grace armed at 2300
    const cleared = m.clearIfEmpty(false);
    expect(cleared).toHaveLength(2);
    expect(m.takeDropped()).toEqual(["a", "b"]);
  });
});
