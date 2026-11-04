/**
 * 2026-11-04 mention-handled fix: `CommandHandler.onInputHandled` — the report port behind
 * `WebHubControl.noteInputHandled` / `MentionRouteDeps.onHandled`. A mention input interceptor
 * that answers pi `{action:"handled"}` short-circuits the input chain, so the observer in
 * `onInputEvent` never attributes the dispatch; without the report the entry decays
 * `dispatched` → 3s `unobserved` HTTP reply → 30s `unconfirmed(unobserved)` ("sent ·
 * unconfirmed") even though the mention router really applied the message.
 *
 * Pinned here: dispatched → consumed (+ onChanged); the 30s unobserved finalize never
 * overwrites consumed; a late report still upgrades an already-`unconfirmed` entry; and the
 * attribution safety — wrong text / another session's entry / ambiguous same-text candidates
 * are all no-ops (a cmdId is never guessed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue, type FakeTimerQueue } from "./helpers.js";

// The command ledger is process-global (Symbol.for) — same reset discipline as commands.test.ts.
const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
const WEB_ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const FINALIZE_MS = 30_000; // PROMPT_UNOBSERVED_FINALIZE_MS
const HTTP_WAIT_MS = 3_000; // PROMPT_HTTP_WAIT_MS

let seq = 0;
function frame(text: string): CmdFrame {
  seq += 1;
  return {
    t: "cmd",
    rid: `r-ih${seq}`,
    id: `ih${seq}`,
    deadlineMs: 8000,
    origin: WEB_ORIGIN,
    cmd: { op: "prompt", text, deliver: "steer" },
  };
}

interface Harness {
  handle(text: string): CmdFrame;
  handler: ReturnType<typeof createCommandHandler>;
  ledger: ReturnType<typeof createCommandLedger>;
  timers: FakeTimerQueue;
  onChangedCalls: () => number;
  sent: Array<CmdResultFrame | CmdLateFrame>;
  stateOf(id: string): string | undefined;
  setSessionId(sid: string): void;
  dispose(): void;
}

function makeHarness(sessionId = "s1"): Harness {
  const { pi } = fakePi();
  const { ctx } = fakeCtx({ mode: "tui", sessionId });
  const ledger = createCommandLedger();
  const timers = fakeTimerQueue();
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  let sid = sessionId;
  let changed = 0;
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
    isQuiet: () => false,
  };
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => sid,
    ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
    builtinBridge,
    controlEnabled: () => true,
    now: () => 1000,
    send: (f) => sent.push(f),
    onChanged: () => {
      changed += 1;
    },
    setTimer: timers.setTimer,
  };
  const handler = createCommandHandler(deps);
  return {
    handle: (text) => {
      const f = frame(text);
      handler.handle(f);
      return f;
    },
    handler,
    ledger,
    timers,
    onChangedCalls: () => changed,
    sent,
    stateOf: (id) => ledger.frame(sid, "epoch", 1000).items.find((i) => i.cmdId === id)?.state,
    setSessionId: (next) => {
      sid = next;
    },
    dispose: () => handler.dispose(),
  };
}

describe("CommandHandler.onInputHandled (2026-11-04 mention-handled fix)", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
  });

  it("flips the matching dispatched prompt to consumed and republishes", () => {
    const h = makeHarness();
    const f = h.handle("@worker hello from the web");
    expect(h.stateOf(f.id)).toBe("dispatched");
    const before = h.onChangedCalls();
    h.handler.onInputHandled("@worker hello from the web");
    expect(h.stateOf(f.id)).toBe("consumed");
    expect(h.onChangedCalls()).toBe(before + 1);
    h.dispose();
  });

  it("the 30s unobserved finalize never overwrites consumed (and a late report upgrades unconfirmed)", () => {
    const h = makeHarness();
    const consumed = h.handle("@a consumed early");
    h.handler.onInputHandled("@a consumed early");
    h.timers.fireByMs(HTTP_WAIT_MS); // the 3s HTTP reply still goes out — ctl stays authoritative
    h.timers.fireByMs(FINALIZE_MS);
    expect(h.stateOf(consumed.id)).toBe("consumed");

    // Counterpart: a report arriving only after the finalize still finds `unconfirmed`
    // (findDispatchedByText matches dispatched|unconfirmed) and upgrades it to consumed.
    const late = h.handle("@b reported late");
    h.timers.fireByMs(FINALIZE_MS);
    expect(h.stateOf(late.id)).toBe("unconfirmed");
    h.handler.onInputHandled("@b reported late");
    expect(h.stateOf(late.id)).toBe("consumed");
    h.dispose();
  });

  it("wrong text ⇒ no-op (the dispatched entry still decays on its own)", () => {
    const h = makeHarness();
    const f = h.handle("@worker the real text");
    h.handler.onInputHandled("some other text entirely");
    expect(h.stateOf(f.id)).toBe("dispatched");
    h.timers.fireByMs(FINALIZE_MS);
    expect(h.stateOf(f.id)).toBe("unconfirmed");
    h.dispose();
  });

  it("another session's dispatched entry is never stolen", () => {
    const h = makeHarness("s1");
    const f = h.handle("@worker cross session");
    h.setSessionId("s2"); // a later session (or a /reload mismatch) reports the same text
    h.handler.onInputHandled("@worker cross session");
    h.setSessionId("s1");
    expect(h.stateOf(f.id)).toBe("dispatched");
    h.dispose();
  });

  it("two same-text dispatched candidates ⇒ ambiguity ⇒ no-op on both", () => {
    const h = makeHarness();
    const a = h.handle("@worker ambiguous");
    const b = h.handle("@worker ambiguous");
    h.handler.onInputHandled("@worker ambiguous");
    expect(h.stateOf(a.id)).toBe("dispatched");
    expect(h.stateOf(b.id)).toBe("dispatched");
    h.dispose();
  });

  it("no dispatched entry at all (TUI-only mention, web-hub off moments) ⇒ silent no-op", () => {
    const h = makeHarness();
    expect(() => h.handler.onInputHandled("@never-dispatched hi")).not.toThrow();
    expect(h.onChangedCalls()).toBe(0);
    h.dispose();
  });
});
