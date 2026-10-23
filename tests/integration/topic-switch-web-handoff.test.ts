/**
 * todo #8 — a web prompt claimed by topic-switch's web gate, then `session_shutdown` BEFORE the
 * user decided (reducer ⇒ `persist-pending`). The real topic-switch wiring + the real web-hub
 * command handler + the real (process-global) command ledger + the real browser reducer, end to
 * end: the browser's optimistic queue row must reach a terminal state instead of sticking at
 * "sent · unconfirmed" (`observed`) until the ledger's 30 min TTL.
 *
 *  - `/new` (and every non-reload reason): recovery only refills the terminal editor ⇒ the row
 *    ends `dropped`, projected into the NEXT session's ctl slot.
 *  - `/reload`: recovery auto-redelivers the same text into the same session through the content
 *    path ⇒ the NEXT module instance attributes it to the original cmdId ⇒ `consumed` ⇒ the row
 *    clears; exactly one delivery, never a second row for the same cmdId.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { wireTopicSwitch, type TopicSwitchDeps } from "../../src/topic-switch/wire.js";
import { DEFAULT_TOPIC_SWITCH_SETTINGS, type TopicSwitchSettings } from "../../src/topic-switch/settings.js";
import { ENTRY_TYPE } from "../../src/topic-switch/records.js";
import { createCommandHandler, type CommandHandlerDeps } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger, type CommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import type { HoldDriver } from "../../src/web-hub/agent/hold-driver.js";
import type { PromptGatePort } from "../../src/web-hub/agent/prompt-gate.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../src/web-hub/protocol/messages.js";
import { initialState, reduce } from "../../src/web-hub/ui/src/logic/state.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
const TRANSFER_KEY = Symbol.for("pi-subagent:topic-switch-transfer");
beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
  delete (globalThis as Record<symbol, unknown>)[TRANSFER_KEY];
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
  delete (globalThis as Record<symbol, unknown>)[TRANSFER_KEY];
});

const TEXT = "please refactor the entire billing subsystem to support multi-currency ledgers";
const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const CMD_ID = "cmd-web-handoff-0001";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** One pi activation (module instance): topic-switch registers its handlers here. A plain-content
 *  `sendUserMessage` emits `input` (source extension) to the web-hub observer FIRST (web-hub is
 *  registered before topic-switch in src/index.ts), then topic-switch's own handler, then — the
 *  session being idle — the user `message_start`, exactly the real pi order. */
class FakePi {
  handlers = new Map<string, Handler[]>();
  entries: Array<{ customType: string; data: unknown }> = [];
  sentTexts: string[] = [];
  commands = new Map<string, unknown>();
  observer: ReturnType<typeof createCommandHandler> | undefined;
  ctx: unknown;
  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {};
  }
  emit(event: string, payload: unknown, ctx: unknown): unknown {
    let result: unknown;
    for (const h of this.handlers.get(event) ?? []) result = h(payload, ctx);
    return result;
  }
  sendUserMessage(content: unknown, options?: { deliverAs?: "steer" | "followUp" }): void {
    if (typeof content === "string" && content.startsWith("/")) return; // slash trampoline (S3)
    const text =
      typeof content === "string"
        ? content
        : ((content as Array<{ type: string; text?: string }>).find((b) => b.type === "text")?.text ?? "");
    this.sentTexts.push(text);
    this.observer?.onInputEvent({ text, source: "extension" });
    this.emit("input", { type: "input", text, source: "extension", streamingBehavior: undefined }, this.ctx);
    void options;
    this.observer?.onMessageStart({ message: { role: "user", content: text } });
  }
  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ customType, data });
  }
  registerCommand(name: string, options: unknown): void {
    this.commands.set(name, options);
  }
  getSessionName(): string | undefined {
    return undefined;
  }
}

function makeCtx(sessionId: string, editorTexts: string[] = []) {
  return {
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
    model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
    modelRegistry: {
      find: () => ({ provider: "anthropic", id: "claude" }),
      complete: () => new Promise(() => {}), // judge never answers ⇒ the hold stays in `judging`
    },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" },
        },
      ],
      getSessionId: () => sessionId,
    },
    ui: { setStatus: () => {}, notify: () => {}, setEditorText: (t: string) => editorTexts.push(t) },
  };
}

function topicDeps(clock: FakeClock): TopicSwitchDeps {
  const settings: TopicSwitchSettings = { ...DEFAULT_TOPIC_SWITCH_SETTINGS };
  return {
    settings: () => settings,
    titleModel: "",
    warmth: { assess: () => ({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" }) },
    stack: () => ({ activeRuns: () => 0, backgroundBash: () => 0, goalBusy: () => false }),
    remote: () => undefined,
    clock,
  };
}

const noopHold = (): HoldDriver =>
  ({
    canHold: () => false,
    hold: () => false,
    recall: vi.fn(),
    onContext: vi.fn(),
    onAssistantMessageStart: vi.fn(),
    onTurnStart: vi.fn(),
    onTurnEnd: () => undefined,
    onAgentEnd: () => undefined,
    onAgentSettled: vi.fn(),
    onObserved: vi.fn(),
    onConsumed: vi.fn(),
    onWebAbort: vi.fn(),
    onSessionStart: vi.fn(),
    onSessionShutdown: vi.fn(),
    onTick: vi.fn(),
    heldCount: () => 0,
    phase: () => "idle",
    inflightCmdId: () => undefined,
    dispose: vi.fn(),
  }) as unknown as HoldDriver;

/** One web-hub module instance's command handler (owner = its MODULE_INSTANCE). */
function webHub(opts: {
  owner: string;
  ledger: CommandLedger;
  session: { id: string };
  ctx: () => unknown;
  gate?: () => PromptGatePort | undefined;
  holdOn: boolean;
}) {
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const hold = opts.holdOn ? noopHold() : undefined;
  const deps: CommandHandlerDeps = {
    pi: { sendUserMessage: vi.fn() } as never,
    getCtx: () => opts.ctx() as never,
    getSessionId: () => opts.session.id,
    ledger: opts.ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
    builtinBridge: { execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })) },
    controlEnabled: () => true,
    now: () => Date.now(),
    send: (f) => sent.push(f),
    onChanged: () => {},
    setTimer: () => ({ cancel() {} }),
    owner: opts.owner,
    ...(hold !== undefined ? { hold: () => hold } : {}),
    ...(opts.gate !== undefined ? { promptGate: opts.gate } : {}),
  };
  return { handler: createCommandHandler(deps), sent };
}

function promptFrame(): CmdFrame {
  return {
    t: "cmd",
    rid: "r-1",
    id: CMD_ID,
    deadlineMs: 8000,
    origin: ORIGIN,
    cmd: { op: "prompt", text: TEXT, deliver: "steer" },
  };
}

/** Browser side: the optimistic row for CMD_ID after the claim's HTTP reply (`observed`). */
function browserAfterClaim() {
  const card = {
    agentKey: "A",
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    pluginVersion: "1.0.0",
    outdated: false,
    session: {
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      cwd: "/tmp/p",
      reason: "startup",
      leafId: null,
      mode: "tui",
    },
    prompts: [],
  };
  let s = initialState();
  for (const m of [
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card] },
    { event: "ctl_send", data: { agentKey: "A", item: { id: CMD_ID, kind: "prompt", state: "sending", at: 1 } } },
    {
      event: "ctl_result",
      data: {
        agentKey: "A",
        id: CMD_ID,
        transition: { type: "result", outcome: { ok: true, data: { delivery: "observed", behavior: "idle" } } },
      },
    },
  ]) {
    s = reduce(s, m);
  }
  return s;
}
const row = (s: ReturnType<typeof initialState>) => s.agents.get("A")!.pendingCtl.find((i) => i.id === CMD_ID);
const ctlFrame = (ledger: CommandLedger, sessionId: string) => ({
  event: "ctl",
  data: { agentKey: "A", ...ledger.frame(sessionId, "ep", Date.now()) },
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Claim under activation #1, still judging when the shutdown lands. */
function claimInGen1(holdOn: boolean) {
  const clock = new FakeClock();
  const session = { id: "s1" };
  const pi1 = new FakePi();
  const ctx1 = makeCtx("s1");
  pi1.ctx = ctx1;
  const wiring1 = wireTopicSwitch(pi1 as never, topicDeps(clock));
  const ledger = createCommandLedger();
  const hub1 = webHub({ owner: "inst-1", ledger, session, ctx: () => ctx1, gate: () => wiring1.webGate, holdOn });
  pi1.observer = hub1.handler;
  hub1.handler.handle(promptFrame());
  return { clock, session, pi1, ctx1, ledger, hub1 };
}

for (const holdOn of [false, true]) {
  describe(`topic-switch web claim × session_shutdown before the decision (hold ${holdOn ? "on" : "off"})`, () => {
    it("claim precondition: the web gate claimed it (observed/idle reply, nothing dispatched yet)", () => {
      const { ledger, hub1, pi1 } = claimInGen1(holdOn);
      expect(ledger.get(CMD_ID)).toMatchObject({ promptState: "observed", behavior: "idle" });
      expect(hub1.sent).toHaveLength(1);
      expect(pi1.sentTexts).toEqual([]);
      expect(row(browserAfterClaim())).toMatchObject({ state: "observed" }); // "sent · unconfirmed"
    });

    it("/new from the terminal: the NEW session's ctl slot carries a terminal `dropped` ⇒ the browser row stops being 'sent · unconfirmed'", async () => {
      const { clock, session, pi1, ctx1, ledger } = claimInGen1(holdOn);
      await flush();
      pi1.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx1);
      expect(
        pi1.entries.some((e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "pending"),
      ).toBe(true);

      // pi replaces the session: a fresh activation, session_start(new) ⇒ recovery refills the editor.
      session.id = "s2";
      const editorTexts: string[] = [];
      const pi2 = new FakePi();
      const ctx2 = makeCtx("s2", editorTexts);
      pi2.ctx = ctx2;
      wireTopicSwitch(pi2 as never, topicDeps(clock));
      const hub2 = webHub({ owner: "inst-1", ledger, session, ctx: () => ctx2, holdOn });
      pi2.observer = hub2.handler;
      pi2.emit("session_start", { type: "session_start", reason: "new" }, ctx2);
      expect(editorTexts).toEqual([TEXT]);

      let s = browserAfterClaim();
      s = reduce(s, {
        event: "session",
        data: { agentKey: "A", session: { ...s.agents.get("A")!.session, sessionId: "s2" } },
      });
      s = reduce(s, ctlFrame(ledger, "s2"));
      expect(row(s)).toMatchObject({ state: "dropped" });

      // the user re-sends from the terminal editor via `/topic-switch last --send`-style content:
      // the same cmdId never comes back to life.
      pi2.sendUserMessage([{ type: "text", text: TEXT }], { deliverAs: "followUp" });
      s = reduce(s, ctlFrame(ledger, "s2"));
      expect(row(s)).toMatchObject({ state: "dropped" });
      expect(ledger.get(CMD_ID)).toMatchObject({ promptState: "dropped", reason: "session" });
    });

    it("/reload: recovery redelivers exactly once into the same session, the next module instance attributes it ⇒ `consumed` ⇒ the row clears (no second row)", async () => {
      const { clock, session, pi1, ctx1, ledger } = claimInGen1(holdOn);
      await flush();
      pi1.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx1);

      // `/reload`: a NEW module instance (new owner) re-activates against the SAME session.
      const pi2 = new FakePi();
      const ctx2 = makeCtx("s1");
      pi2.ctx = ctx2;
      wireTopicSwitch(pi2 as never, topicDeps(clock));
      const hub2 = webHub({ owner: "inst-2", ledger, session, ctx: () => ctx2, holdOn });
      pi2.observer = hub2.handler;
      pi2.emit("session_start", { type: "session_start", reason: "reload" }, ctx2);
      for (let i = 0; i < 4; i += 1) await flush();

      expect([...pi1.sentTexts, ...pi2.sentTexts]).toEqual([TEXT]); // I5: at most one auto-delivery
      expect(ledger.get(CMD_ID)).toMatchObject({ promptState: "consumed" });

      let s = browserAfterClaim();
      s = reduce(s, ctlFrame(ledger, "s1"));
      expect(row(s)).toBeUndefined();
      // later projections never resurrect it (the reducer never creates rows from ctl entries).
      s = reduce(s, ctlFrame(ledger, "s1"));
      expect(s.agents.get("A")!.pendingCtl).toEqual([]);
    });
  });
}
