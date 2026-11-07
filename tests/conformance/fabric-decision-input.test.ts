/**
 * #61 P0 · decision-wake INPUT CAPABILITY PROOF (offline, real seams — plan §3).
 *
 * What this suite pins, per ingress (evidence is BEHAVIOUR on the real SDK/production code, not
 * a restatement of `InputEvent.source`'s weakness):
 *
 *  - TUI-shaped submit — the real interactive loop calls `session.prompt(text)` with NO options
 *    (`pi-coding-agent/dist/modes/interactive/interactive-mode.js`, main loop `await
 *    this.session.prompt(userInput)`). We submit exactly that shape on a REAL AgentSession and
 *    capture the REAL `input` event: it carries {text, source:"interactive"} and NO unique
 *    submission id — and a programmatic in-process `prompt()` call produces a byte-identical
 *    event. ⇒ NO host-observable seam can bind a private inputId for the TUI entry:
 *    `provenance_unavailable` (product limitation reported to Root; NOT claimed supported).
 *
 *  - Generic RPC — the real rpc-mode stamps EVERY prompt/steer/follow_up `source:"rpc"`
 *    (`dist/modes/rpc/rpc-mode.js`, handleCommand "prompt"/"steer"/"follow_up") and the command
 *    `id` is client-chosen, so a machine client and a human at an RPC terminal are
 *    indistinguishable ⇒ also `provenance_unavailable`.
 *
 *  - Machine injections — `session.sendUserMessage` (the pi extension API) is `source:
 *    "extension"`; a custom message (`sendMessage`) fires NO input event at all. Neither may
 *    ever construct a decision proof.
 *
 *  - Web prompt — the REAL production command handler (`src/web-hub/agent/commands.ts`)
 *    settles `prompt` ops through the server-side ledger `begin()` (cmdId dedup + digest
 *    mismatch check + capacity), records the origin (Feishu refused before dispatch), and — only
 *    while xs human-enhancement is ON — registers a ONE-SHOT {inputId: cmdId, sessionId, owner}
 *    web proof (`noteWebProof` → `noteHumanWebDispatch`) immediately before exactly one
 *    `sendUserMessage`. Positive + replay + Feishu + digest-mismatch negatives are driven through
 *    the real handler here. ⇒ the seam EXISTS and binds a private inputId/owner/session;
 *    PRODUCTION WIRING for the decision ledger is P2 and MUST be an independent tree-only
 *    callback (today's proof is gated on xs enhanced — decision wake must NOT require xs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withSession, disposeHarnessDirs } from "./agent-session-harness.js";
import { createDecisionInputObserver, isDecisionHumanProof } from "../../src/fabric/decision-input.js";
import { createCommandHandler, type CommandHandlerDeps } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import type { BuiltinBridge } from "../../src/web-hub/agent/builtin-bridge.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../src/web-hub/protocol/messages.js";
import { takeHumanWebDispatch } from "../../src/fabric/xs/human-grant.js";
import { fakeCtx, fakePi, fakeTimerQueue, type FakeTimerQueue } from "../web-hub/agent/helpers.js";

afterEach(disposeHarnessDirs);

interface CapturedInputEvent {
  text: string;
  source: string;
  keys: string[];
}

/** Real AgentSession + a real extension `input` handler (the same registration the production
 *  wake-input hook uses); every submission below goes through the REAL dispatch path. */
async function withInputCapture(
  run: (env: {
    session: Awaited<ReturnType<typeof withSession>>["session"];
    pi: ExtensionAPI;
    events: CapturedInputEvent[];
  }) => Promise<void>,
): Promise<void> {
  const events: CapturedInputEvent[] = [];
  let pi!: ExtensionAPI;
  await withSession(
    {
      scripted: [
        {
          toolCall: false,
          build: (m) => ({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: m.id,
            usage: { input: 1, output: 1 },
          }),
        },
      ],
      extensionFactories: [
        (api: ExtensionAPI) => {
          pi = api;
          api.on("input", (event: { text: string; source: string }) => {
            events.push({ text: event.text, source: event.source, keys: Object.keys(event).sort() });
          });
        },
      ],
    },
    async ({ session }) => {
      await run({ session, pi, events });
    },
  );
  return events;
}

describe("#61 P0 · real SDK submission seams (TUI / RPC / extension / custom)", () => {
  it("TUI-shaped and programmatic prompt() produce IDENTICAL input events with NO unique id (seam unavailable)", async () => {
    const events = await withInputCapture(async ({ session }) => {
      // POSITIVE (trusted ingress exists): the TUI-shaped submit fires a real input event.
      await session.prompt("hello from tui");
      // The exact same call from arbitrary in-process code — indistinguishable bytes.
      await session.prompt("hello from tui");
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(events[1]); // ← the INDISTINGUISHABILITY proof
    expect(events[0]!.source).toBe("interactive");
    // the public payload has NO field a private observation point could bind an inputId to
    for (const key of ["id", "inputId", "origin", "cmdId", "nonce", "token", "user"])
      expect(events[0]!.keys, `unexpected authority field ${key}`).not.toContain(key);
  });

  it("RPC-shaped prompt is source:'rpc' with no unique id — a machine client is indistinguishable (rpc-mode.js 293-328)", async () => {
    const events = await withInputCapture(async ({ session }) => {
      await session.prompt("rpc prompt", { source: "rpc" }); // rpc-mode handleCommand "prompt"
    });
    expect(events.map((e) => e.source)).toEqual(["rpc"]);
    for (const key of ["id", "inputId", "origin", "cmdId", "nonce", "token"])
      expect(events[0]!.keys, `unexpected authority field ${key}`).not.toContain(key);
  });

  it("machine paths never look human: pi.sendUserMessage is 'extension', custom messages fire NO input event", async () => {
    await withInputCapture(async ({ session, pi, events }) => {
      await session.sendUserMessage("machine user message"); // → prompt(source:"extension")
      pi.sendMessage({ customType: "machine", content: "custom injection" });
      expect(events.map((e) => e.source)).toEqual(["extension"]); // custom message: NO input event
    });
  });
});

const WEB_ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const FEISHU_ORIGIN: CmdOrigin = { listener: "feishu", ip: "feishu", reqId: "abcdef0123456789" };

interface WebHarness {
  handle(frame: CmdFrame): void;
  sent: Array<CmdResultFrame | CmdLateFrame>;
  userMessages: Array<{ text: string }>;
  timers: FakeTimerQueue;
}

function webHarness(sessionId: string, enhanced: boolean): WebHarness {
  const { pi, sentUserMessages } = fakePi();
  const { ctx } = fakeCtx({ sessionId });
  const ledger = createCommandLedger();
  const timers = fakeTimerQueue();
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
    isQuiet: () => false,
  };
  const deps: CommandHandlerDeps = {
    pi,
    getCtx: () => ctx,
    getSessionId: () => sessionId,
    ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
    builtinBridge,
    controlEnabled: () => true,
    now: () => 1000,
    send: (f) => sent.push(f),
    onChanged: () => {},
    setTimer: timers.setTimer,
    mention: () =>
      ({
        sessions: { enhanced: () => enhanced },
      }) as never,
  };
  const handler = createCommandHandler(deps);
  return {
    handle: (frame) => handler.handle(frame),
    sent,
    userMessages: sentUserMessages,
    timers,
  };
}

/** The web-proof park is process-global (Symbol.for) — same reset discipline as xs tests. */
function beforeEach_resetGlobalProofPark(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-human-web-inputs")];
}

let seq = 0;
function promptFrame(text: string, origin: CmdOrigin = WEB_ORIGIN, id?: string): CmdFrame {
  seq += 1;
  return {
    t: "cmd",
    rid: `r-dw${seq}`,
    id: id ?? `dw${seq}`,
    deadlineMs: 8000,
    origin,
    cmd: { op: "prompt", text, deliver: "steer" },
  };
}

describe("#61 P0 · real web command handler seam (cmdId/origin/admission)", () => {
  beforeEach(beforeEach_resetGlobalProofPark);
  afterEach(beforeEach_resetGlobalProofPark);

  it("POSITIVE: an admitted web prompt dispatches exactly one sendUserMessage and one one-shot proof bound to {cmdId, session, owner}", () => {
    const h = webHarness("sess-web", true);
    h.handle(promptFrame("decide please"));
    expect(h.userMessages).toEqual([
      { text: "decide please", options: { deliverAs: "steer", expandPromptTemplates: false } },
    ]);
    const proof = takeHumanWebDispatch("sess-web", "decide please");
    expect(proof).toMatchObject({ inputId: "dw1", sessionId: "sess-web", text: "decide please" });
    expect(typeof proof!.owner).toBe("string");
    expect(takeHumanWebDispatch("sess-web", "decide please")).toBeUndefined(); // one-shot
  });

  it("NEGATIVE replay: the same cmdId is a ledger dup — no second dispatch, no second proof", () => {
    const h = webHarness("sess-web", true);
    const frame = promptFrame("decide please", WEB_ORIGIN, "fixed-cmd");
    h.handle(frame);
    h.handle(promptFrame("decide please", WEB_ORIGIN, "fixed-cmd"));
    expect(h.userMessages).toHaveLength(1);
    expect(takeHumanWebDispatch("sess-web", "decide please")).toMatchObject({ inputId: "fixed-cmd" });
    expect(takeHumanWebDispatch("sess-web", "decide please")).toBeUndefined();
  });

  it("NEGATIVE digest mismatch: cmdId reuse with different text is E_BAD_REQUEST, zero dispatch", () => {
    const h = webHarness("sess-web", true);
    h.handle(promptFrame("first text", WEB_ORIGIN, "reused-id"));
    h.handle(promptFrame("OTHER text", WEB_ORIGIN, "reused-id"));
    expect(h.userMessages).toHaveLength(1);
    const dup = h.sent.at(-1) as { ok: boolean; error?: { code?: string } };
    expect(dup.ok).toBe(false);
    expect(JSON.stringify(dup)).toContain("E_BAD_REQUEST");
  });

  it("NEGATIVE Feishu origin: a dispatched Feishu prompt NEVER yields a proof (noteWebProof skips Feishu)", () => {
    const h = webHarness("sess-web", true);
    h.handle(promptFrame("decide via feishu", FEISHU_ORIGIN, "feishu-1"));
    // read-only prompt text from Feishu is still dispatched as input (F6 forwards prompt/dialog
    // ops) — but the PROOF port hard-skips Feishu origins, so no decision budget may ever open.
    expect(h.userMessages).toHaveLength(1);
    expect(takeHumanWebDispatch("sess-web", "decide via feishu")).toBeUndefined();
  });

  it("NEGATIVE xs-enhanced OFF: today's proof registration is xs-gated (P2 must add an independent tree-only callback)", () => {
    const h = webHarness("sess-web", false);
    h.handle(promptFrame("decide please"));
    expect(h.userMessages).toHaveLength(1); // dispatch still happens
    expect(takeHumanWebDispatch("sess-web", "decide please")).toBeUndefined(); // but NO proof today
  });
});

describe("#61 P0 · decision proof port binding (pure observer fed by the web seam)", () => {
  it("the web-shaped {sessionId, owner, inputId: cmdId} satisfies the port EXACTLY ONCE; model-shaped carriers never validate", () => {
    beforeEach_resetGlobalProofPark();
    const observer = createDecisionInputObserver({ sessionId: "sess-web", owner: "owner-1" });
    // positive: the web seam's binding (P2 producer contract) opens exactly one window
    expect(observer.observe("dw1")).toEqual({ status: "new_proof", epoch: 1 });
    expect(observer.observe("dw1")).toEqual({ status: "replay" }); // replay of the same cmdId
    // a forged proof carrying model-visible fields (text/role/source) fails the exact key set
    expect(
      isDecisionHumanProof({
        v: 1,
        sessionId: "s",
        owner: "o",
        inputId: "i",
        at: 1,
        provenance: "web_prompt",
        text: "x",
        source: "interactive",
      }),
    ).toBe(false);
    expect(isDecisionHumanProof({ v: 1, sessionId: "s", owner: "o", inputId: "i", at: 1, provenance: "rpc" })).toBe(
      false,
    );
  });
});
