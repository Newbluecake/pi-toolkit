/**
 * #21 T11 — THE launch gate (plan `docs/dev/xs-ask-redirect/plan.md` §3 T11): the full
 * host-redirect loop over REAL `AgentSession`s. Every hop is real:
 *
 *   A (real session, scripted model) ──message_session expectReply+wake──▶ real relay/registry
 *   │                                    real deliver → real receiver → real RootWakeController
 *   │                                    dispatch → REAL pi run on B (BAS-bound, askOrigin captured)
 *   ▼                                                                        ▼
 *   B's model calls the REAL ask_user (real `wireAskUser`, wired with the B3 line
 *   `redirect: () => stack.askRedirect`) → real `createXsAskRedirect` → real `createXsSender`
 *   → the SAME real relay → A is woken (a REAL second run) → A's model answers with the q2
 *   replyTo → B receives the reply MID-RUN (deliver-only write, D1) → the tap resolves the ask
 *   → ask_user returns `answered` → B's model continues IN THE SAME RUN and delivers the FINAL
 *   result with the ORIGINAL replyTo (q1) → A accepts (solicited wake, third real run).
 *
 * Also covers, each with the same real plumbing: A never answers ⇒ `timeout` (a real 60 s wait —
 * the parser floor for `askRedirect.timeoutS`, so this case is honestly slow); A in `replies`
 * mode ⇒ hub admission refuses the q2 ⇒ `unavailable(send_none:rejected)` with the admission
 * refunded; a proven pair-wake downgrade ⇒ `not_woken(pair_wake_rate)`; and the third ask of
 * one run ⇒ `unavailable(limit)`.
 *
 * Simulation boundary (deliberate, per plan T11): no web-hub SOCKET and no `activate()` — both
 * are impossible here (one HOST_KEY claim per process; the socket layer needs the hub daemon).
 * The activate×socket wiring is covered by `fabric-xs-ask-redirect-wiring.test.ts` and the real
 * hub subprocess by `fabric-xs-ask-redirect.test.ts`. Everything below — the pi host, both
 * sessions, both xs stacks, the relay, both bridges — is real.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import { buildStackXs, type StackXs } from "../../src/fabric/xs/stack.js";
import { createXsSender, type XsSender } from "../../src/fabric/xs/sender.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import { createXsAgentBridge } from "../../src/web-hub/agent/xs.js";
import type { HubConnection } from "../../src/web-hub/agent/connection.js";
import type { XsMemberLimitsWire, XsReqFrame } from "../../src/web-hub/protocol/xs.js";
import wireAskUser from "../../src/ask-user/index.js";
import { rig, type Rig } from "../web-hub/hub/xs-fixtures.js";
import {
  assistantToolCallMsg,
  fakeModel,
  fakeModelRuntime,
  textTurn,
  toolTurn,
  type ScriptedTurn,
} from "../conformance/tui-harness.js";
import { getXsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import { getXsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";

const CAPS = ["ev.v1", "xs.v1", "xs.reply.v1"];
const ASK = { questions: [{ question: "Ship or hold?", options: [{ label: "ship it" }, { label: "hold" }] }] };

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const timer = setTimeout(r, ms);
    timer.unref();
  });
async function until(check: () => boolean, label: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(20);
  if (!check()) throw new Error(`timeout waiting for ${label}`);
}

/** Bounded poll-gate for scripted turns: release once `check` holds (or fail after 30s). */
function gateUntil(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + 30_000;
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > end) {
        clearInterval(timer);
        reject(new Error("gate timeout"));
      }
    }, 10);
    timer.unref();
  });
}

/** A tool turn whose ARGS are computed at stream time — the flow refs (q1/q2/peer sid) are only
 * known once the real messages are on the wire, which is always before the turn is consumed. */
function lazyToolTurn(name: string, id: string, args: () => Record<string, unknown>): ScriptedTurn {
  return {
    toolCall: true,
    build: (model) => assistantToolCallMsg(model, id, name, args()),
  };
}

/** An ask_user turn that waits for A to be fully idle first: the delegation fires B's run while
 * A is still streaming, and a q2 into that busy window would be deferred deliver-only (the wake
 * lost). Gating the model call makes every q2 meet an idle requester — the deterministic window
 * the plan's D7 "queued" branch describes. `aRef` is filled by bootPair before the prompt. */
function gatedAskTurn(id: string, aRef: { settledCount?: () => number }, afterSettles: number): ScriptedTurn {
  const turn = lazyToolTurn("ask_user", id, () => ASK);
  turn.gate = gateUntil(() => (aRef.settledCount?.() ?? 0) >= afterSettles);
  return turn;
}

interface Flow {
  aSid: string;
  bSid: string;
  /** the ORIGINAL delegation ticket (A's expectReply) — where the final result must go */
  q1?: string;
  /** every intermediate ask ticket (B's redirected q2s), oldest first — what A's answers consume */
  q2s: string[];
}

interface Side {
  session: AgentSession;
  stack: StackXs;
  holder: {
    stack?: StackXs;
    sender?: XsSender;
    bridge?: ReturnType<typeof createXsAgentBridge>;
  };
  requests: XsReqFrame[];
  callCount: () => number;
  requestMessages: unknown[][];
  errors: unknown[];
  /** How many of this side's agent runs have settled (a wake-free idleness signal). */
  settledCount(): number;
  /** Ledger snapshots (askUsed of the delegated-run record) taken at each ask_user tool_result —
   * the tool_result fires while the run is still open, i.e. before the record is released. */
  askLedger: Array<{ askUsed?: number }>;
  dispose(): Promise<void>;
}

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  const g = globalThis as Record<symbol, unknown>;
  for (const name of [
    "xs-wake-ledger",
    "xs-host-cap",
    "xs-reply-ledger",
    "xs-progress",
    "xs-unread",
    "xs-activation-park",
  ])
    delete g[Symbol.for(`pi-subagent:${name}`)];
});

function xsSettings(over: {
  askTimeoutS?: number;
  limits?: Partial<AgentSettings["fabric"]["crossSession"]["limits"]>;
}): AgentSettings {
  const cs = DEFAULT_SETTINGS.fabric.crossSession;
  return {
    ...DEFAULT_SETTINGS,
    fabric: {
      ...DEFAULT_SETTINGS.fabric,
      enabled: true,
      wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: true, rootRunMaxS: 900 },
      crossSession: {
        ...cs,
        enabled: true,
        autoJoin: true,
        limits: { ...cs.limits, ...(over.limits ?? {}) },
        askRedirect: { enabled: true, timeoutS: over.askTimeoutS ?? 600, maxPerRun: 2 },
        channels: { ...cs.channels, enabled: false },
        alias: { ...cs.alias, enabled: false },
        activation: { ...cs.activation, enabled: false },
      },
    },
  };
}

/** A real AgentSession whose extension builds a REAL xs stack + REAL sender + REAL ask_user
 * (the B3 wiring line) and forwards the wake-relevant pi events. */
async function bootSide(
  name: string,
  scripted: ScriptedTurn[],
  settings: AgentSettings,
  flow: Flow,
  role: "a" | "b",
): Promise<Side> {
  const cwd = mkdtempSync(join(tmpdir(), `xs-ask-t11-${name}-`));
  dirs.push(cwd);
  const holder: Side["holder"] = {};
  const requests: XsReqFrame[] = [];
  const errors: unknown[] = [];
  const askLedger: Array<{ askUsed?: number }> = [];
  let settled = 0;
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, scripted);
  let stackRef: StackXs | undefined;
  const levelRef = createCausalLevel({
    maxLevel: 3,
    initialRoot: 0,
    runLevel: () => 0,
    raiseRun() {},
    persistRoot() {},
  });
  let sidOf = (): string => "unbooted";

  const factory = (pi: ExtensionAPI): void => {
    const sender = createXsSender({
      port: {
        list: (args) => holder.bridge?.hubPort().list(args) ?? Promise.resolve({ kind: "off" }),
        resolve: (args) => holder.bridge?.hubPort().resolve(args) ?? Promise.resolve({ kind: "off" }),
        send: (args) => holder.bridge?.hubPort().send(args) ?? Promise.resolve({ kind: "off" }),
        replyCapable: () => holder.bridge !== undefined,
      },
      origin: { current: () => ({ sessionId: sidOf(), epoch: stackRef?.membership.epoch ?? 1 }) },
      reply: {
        ledger: getXsReplyLedger(),
        defaultTimeoutS: 1800,
        maxTimeoutS: 86400,
        lateGraceS: 600,
        maxPending: 8,
        maxPendingPerTarget: 3,
        receivable: (target: string) => stackRef?.reply?.receivable(target) ?? "not_joined",
        inbound: (requestId: string) => stackRef?.reply?.inbound(requestId),
      },
      wakeOn: true,
      level: {
        levelOfRoot: () => levelRef.root,
        hopAllowed: (lv: number) => levelRef.hopAllowed(lv),
      },
    });
    holder.sender = sender;
    pi.registerTool(createMessageSessionTool({ sender, reply: true }));
    // ── the ONE #21 B3 wiring line (mirrors src/index.ts): the redirect port is late-bound ──
    wireAskUser(pi, { redirect: () => holder.stack?.askRedirect });
    pi.on("session_start", (_event, ctx) => {
      stackRef = buildStackXs(pi, ctx as ExtensionContext, settings, "startup", levelRef, {
        askRedirect: {
          send: (args) => holder.sender?.message(args),
          wakeHopAllowed: () => levelRef.hopAllowed(levelRef.root),
          attached: () => stackRef !== undefined,
        },
      });
      holder.stack = stackRef;
    });
    pi.on("before_agent_start", (event) => {
      console.log("T11 EVT before_agent_start", (event as { messageType?: string })?.messageType);
      holder.stack?.beforeAgentStart(event);
    });
    pi.on("tool_call", (event) => {
      console.log("T11 EVT tool_call", (event as { toolName?: string }).toolName);
    });
    pi.on("tool_result", (event) => {
      console.log(
        "T11 EVT tool_result",
        (event as { toolName?: string }).toolName,
        (event as { isError?: boolean }).isError,
      );
    });
    pi.on("agent_end", () => console.log("T11 EVT agent_end"));
    pi.on("turn_end", () => console.log("T11 EVT turn_end"));
    pi.on("context", (event) => {
      holder.stack?.context(event);
    });
    pi.on("agent_settled", () => {
      settled += 1;
      holder.stack?.settled();
    });
    pi.on("tool_result", (event) => {
      if ((event as { toolName?: string }).toolName !== "ask_user") return;
      const rec = getXsWakeLedger()
        .entries()
        .find((r) => r.sessionId === sidOf() && r.askOrigin !== undefined);
      askLedger.push({ ...(rec?.askUsed !== undefined ? { askUsed: rec.askUsed } : {}) });
    });
    pi.on("message_start", (event) => {
      const message = (event as { message?: { role?: string; customType?: string; details?: Record<string, unknown> } })
        .message;
      const reply = message?.details?.reply as { requestId?: unknown } | undefined;
      const requestId = typeof reply?.requestId === "string" ? reply.requestId : undefined;
      if (message?.role === "custom" && message.customType === "subagent:xs" && requestId !== undefined) {
        // a fresh expectReply wake body: on B it is the delegation (q1), on A a redirected ask (q2)
        if (role === "b") flow.q1 ??= requestId;
        else if (!flow.q2s.includes(requestId)) flow.q2s.push(requestId);
      }
    });
  };

  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: [factory] as never,
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  sidOf = () => sessionManager.getSessionId();
  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
  });
  await session.bindExtensions({ mode: "rpc", onError: (e) => errors.push(e) });
  return {
    session,
    stack: holder.stack!,
    holder,
    requests,
    callCount: modelRuntime.callCount,
    requestMessages: modelRuntime.requestMessages,
    errors,
    askLedger,
    settledCount: () => settled,
    dispose: async () => {
      try {
        await session.abort();
      } catch {
        /* already idle */
      }
      session.dispose();
    },
  };
}

/** Wire one side onto the shared in-process relay: agent→hub requests reach the REAL router,
 * hub→agent deliveries reach the REAL bridge (the fabric-xs-activate-session pattern). */
function wireSide(
  r: Rig,
  side: Side,
  opts: { pid: number; limits?: Partial<XsMemberLimitsWire>; receive?: "wake" | "replies" },
): void {
  const sessionId = side.stack.membership.sessionId;
  const limits = { ...DEFAULT_SETTINGS.fabric.crossSession.limits, ...(opts.limits ?? {}) };
  const agent = r.agent({
    pid: opts.pid,
    sessionId,
    caps: CAPS,
    epoch: side.stack.membership.epoch,
    ...(opts.receive ? { receive: opts.receive } : {}),
    limits,
  });
  const conn = {
    caps: CAPS,
    setSlot: () => {},
    status: () => ({ state: "live", attached: true }),
    request: (frame: XsReqFrame) =>
      new Promise((resolve) => {
        side.requests.push(frame);
        r.relay.router.handle(agent.key, frame, resolve);
      }),
    send: (frame: { t: string }) => {
      if (frame.t === "xs_ack") r.registry.onFrame(agent.key, frame as never);
      else r.relay.router.onAgentFrame(agent.key, frame as never);
    },
  } as unknown as HubConnection;
  const bridge = createXsAgentBridge({
    conn: () => conn,
    port: {
      stack: () => side.holder.stack,
      // the SAME limits the rig registration declared — the bridge republishes xs_member and
      // must not overwrite the hub's view with the 30s default pair interval
      memberLimits: () => limits,
      hubSendsPerMin: () => 600,
      replyEnabled: () => true,
    },
  });
  side.holder.bridge = bridge;
  const orig = agent.conn.send;
  agent.conn.send = (frame: { t: string }) => {
    orig(frame);
    if (frame.t === "xs_deliver") bridge.onDeliver(frame as never);
  };
}

/** All toolResult texts of one provider request. */
function toolResultTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role !== "toolResult" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; text?: string }>)
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

/** The nth redirected-ask toolResult text (across ALL of B's provider requests, in order) —
 * robust against pi splitting turns so the results land in shared requests. */
function askResultTexts(b: Side): string[] {
  const all: string[] = [];
  for (const messages of b.requestMessages) {
    for (const text of toolResultTexts(messages)) {
      // every provider request replays the whole history ⇒ dedupe (each result text embeds unique ids)
      if ((text.includes("Redirected ask_user") || text.includes("host-redirected ask_user")) && !all.includes(text))
        all.push(text);
    }
  }
  return all;
}

/** True when the injected custom message carrying `marker` sits strictly AFTER the request's
 * last toolResult — pi's D1 premise (an answer sent mid-execute lands after the tool result). */
function customAfterToolResult(messages: unknown[], marker: string): boolean {
  let lastToolResult = -1;
  let custom = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role === "toolResult") lastToolResult = i;
    if (msg?.role === "user" && Array.isArray(msg.content)) {
      const block = (msg.content as Array<{ type?: string; text?: string }>)[0];
      if (block?.type === "text" && block.text?.includes(marker)) custom = i;
    }
  }
  return lastToolResult >= 0 && custom > lastToolResult;
}

/** The token of B's currently-dispatched delegated run (the one carrying askOrigin). Must be
 * read while the run is still open — the ledger record (and its askUsed) is released at settle. */
function bDelegationToken(b: Side): string | undefined {
  const sid = b.stack.sessionId();
  for (const rec of getXsWakeLedger().entries()) {
    if (rec.sessionId === sid && rec.askOrigin !== undefined) return rec.token;
  }
  return undefined;
}

async function bootPair(
  opts: {
    flow: Flow;
    /** filled with A's settledCount before the prompt — the ask gates read it lazily */
    aRef?: { settledCount?: () => number };
    aScripted: ScriptedTurn[];
    bScripted: ScriptedTurn[];
    askTimeoutS?: number;
    bLimits?: Partial<XsMemberLimitsWire>;
    aReceive?: "wake" | "replies";
    settingsLimits?: Partial<AgentSettings["fabric"]["crossSession"]["limits"]>;
  },
  promptA: (session: AgentSession) => Promise<unknown>,
): Promise<{ flow: Flow; a: Side; b: Side }> {
  const flow = opts.flow;
  const settings = xsSettings({ askTimeoutS: opts.askTimeoutS, limits: opts.settingsLimits });
  const r = rig(600);
  // the rig's clock starts frozen (t=1e6): make it LIVE — the router stamps every frame's
  // expiresAt with it, and a frozen clock "expires" all deliveries once real time moves on.
  Object.defineProperty(r.clock, "t", { get: () => Date.now() });
  cleanups.push(() => r.relay.dispose());
  const a = await bootSide("a", opts.aScripted, settings, flow, "a");
  const b = await bootSide("b", opts.bScripted, settings, flow, "b");
  if (a.holder.stack === undefined || b.holder.stack === undefined)
    throw new Error(
      `stack build failed — a: ${a.errors.map((e) => String((e as Error)?.stack ?? e)).join(" | ")} b: ${b.errors.map((e) => String((e as Error)?.stack ?? e)).join(" | ")}`,
    );
  flow.aSid = a.stack.membership.sessionId;
  flow.bSid = b.stack.membership.sessionId;
  wireSide(r, a, { pid: 1, ...(opts.aReceive ? { receive: opts.aReceive } : {}) });
  wireSide(r, b, { pid: 2, ...(opts.bLimits ? { limits: opts.bLimits } : {}) });
  if (opts.aRef) opts.aRef.settledCount = a.settledCount;
  cleanups.push(() => {
    void a.dispose();
    void b.dispose();
  });
  await promptA(a.session);
  return { flow, a, b };
}

describe("#21 T11 launch gate: real sessions × real stacks × real relay", () => {
  it("the full loop: delegate → redirected ask_user → requester answers → same-run continue → original replyTo delivered and accepted", async () => {
    const flow = { q2s: [] } as Flow;
    const aRef: { settledCount?: () => number } = {};
    const { a, b } = await bootPair(
      {
        flow,
        aRef,
        aScripted: [
          lazyToolTurn("message_session", "tc-a-delegate", () => ({
            to: flow.bSid,
            text: "please do the delegated thing",
            wake: true,
            expectReply: { timeoutS: 600 },
          })),
          textTurn("delegated"),
          lazyToolTurn("message_session", "tc-a-answer", () => ({
            to: flow.bSid,
            text: "1: ship it",
            replyTo: flow.q2s[0] ?? "",
          })),
          textTurn("requester done"),
        ],
        bScripted: [
          gatedAskTurn("tc-b-ask", aRef, 1),
          lazyToolTurn("message_session", "tc-b-final", () => ({
            to: flow.aSid,
            text: "FINAL: shipped per your answer",
            replyTo: flow.q1 ?? "",
          })),
          textTurn("worker done"),
        ],
      },
      (session) => session.prompt("delegate the task to the worker"),
    );

    // A delegated (q1 minted + pending), B was woken and its run started
    await until(() => flow.q1 !== undefined, "q1 minted");
    await until(() => b.callCount() >= 1, "B's delegated run started");
    const token = bDelegationToken(b);
    expect(token).toBeDefined();
    // the redirected q2 reached A and woke its second run; A answered it
    await until(() => flow.q2s.length >= 1, "q2 delivered");
    // D4: the ask reserved synchronously; its tool_result snapshot (taken while the run was
    // still open) must show exactly one billed ask.
    await until(() => b.askLedger.length >= 1, "the redirected ask settled");
    expect(b.askLedger[0]).toEqual({ askUsed: 1 });
    await until(() => a.callCount() >= 3, "A answered the q2 (run 2)");
    // B got the answer, continued in the SAME run (model call 2 carries the ask's toolResult)
    await until(() => b.callCount() >= 2, "B continued after the answered ask");

    // B request 2 (the ask_user toolResult + the injected answer): D8 answered text, verbatim
    const bAskResults = toolResultTexts(b.requestMessages[1] ?? []);
    expect(bAskResults.join("\n")).toContain("The requester answered (host-redirected ask_user, 1/2 this run)");
    expect(bAskResults.join("\n")).toContain("1: ship it");
    expect(bAskResults.join("\n")).toContain(flow.q1!); // the ORIGINAL replyTo id is in the text
    // pi's D1 premise held: the answer custom message sits AFTER the toolResult in the same request
    expect(customAfterToolResult(b.requestMessages[1] ?? [], "1: ship it")).toBe(true);
    // host-only details never reach the provider payload
    expect(JSON.stringify(b.requestMessages[1])).not.toContain("wakeToken");
    expect(JSON.stringify(b.requestMessages[1])).not.toContain('"xsWake"');

    // B delivered the final with the ORIGINAL q1; A's third run consumed it (solicited wake)
    await until(() => a.callCount() >= 4, "A accepted the final result");
    await until(() => b.callCount() >= 3, "B's run closed");
    expect(toolResultTexts(b.requestMessages[2] ?? []).join("\n")).toContain("accepted");
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 60_000);

  it("timeout: A never answers — after the real 60s floor the ask ends, B continues and the ORIGINAL q1 still accepts the final", async () => {
    const flow = { q2s: [] } as Flow;
    const aRef: { settledCount?: () => number } = {};
    const { a, b } = await bootPair(
      {
        flow,
        aRef,
        askTimeoutS: 60,
        aScripted: [
          lazyToolTurn("message_session", "tc-a-delegate", () => ({
            to: flow.bSid,
            text: "delegate with a long horizon",
            wake: true,
            expectReply: { timeoutS: 600 },
          })),
          textTurn("delegated"),
          textTurn("seen, choosing not to answer"), // A's q2-woken run deliberately does not reply
        ],
        bScripted: [
          gatedAskTurn("tc-b-ask", aRef, 1),
          lazyToolTurn("message_session", "tc-b-final", () => ({
            to: flow.aSid,
            text: "FINAL: proceeded with the defensible default",
            replyTo: flow.q1 ?? "",
          })),
          textTurn("worker done"),
        ],
      },
      (session) => session.prompt("delegate the task"),
    );
    await until(() => flow.q2s.length >= 1, "q2 delivered to A");
    await until(() => a.callCount() >= 3, "A's q2-woken run (no answer)");
    await until(() => b.callCount() >= 1, "B's run started");
    const token = bDelegationToken(b);
    expect(token).toBeDefined();
    await until(() => b.askLedger.length >= 1, "the timeout-bound ask settled", 90_000);
    // the ask times out after ~60s (t0 + timeoutS; the run deadline 900s and q1 dueAt are looser)
    await until(() => b.callCount() >= 2, "B's ask timed out and the run continued", 90_000);
    const results = toolResultTexts(b.requestMessages[1] ?? []).join("\n");
    expect(results).toContain("Do not assume an answer.");
    expect(results).toContain("timeout after 60s (1/2 this run)");
    expect(results).not.toContain("The requester answered");
    expect(b.askLedger[0]).toEqual({ askUsed: 1 }); // the timeout billed the ask
    await until(() => b.callCount() >= 3, "final delivered");
    expect(toolResultTexts(b.requestMessages[2] ?? []).join("\n")).toContain("accepted");
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 150_000);

  it("unavailable: A is in replies mode — the hub refuses the q2 (send_none:rejected), the admission is refunded, the final still delivers", async () => {
    const flow = { q2s: [] } as Flow;
    const aRef: { settledCount?: () => number } = {};
    const { a, b } = await bootPair(
      {
        flow,
        aRef,
        aReceive: "replies",
        aScripted: [
          lazyToolTurn("message_session", "tc-a-delegate", () => ({
            to: flow.bSid,
            text: "delegate to a replies-mode requester",
            wake: true,
            expectReply: { timeoutS: 600 },
          })),
          textTurn("delegated"),
        ],
        bScripted: [
          gatedAskTurn("tc-b-ask", aRef, 1),
          lazyToolTurn("message_session", "tc-b-final", () => ({
            to: flow.aSid,
            text: "FINAL: chose the default myself",
            replyTo: flow.q1 ?? "",
          })),
          textTurn("worker done"),
        ],
      },
      (session) => session.prompt("delegate the task"),
    );
    await until(() => b.callCount() >= 1, "B's run started");
    const token = bDelegationToken(b);
    expect(token).toBeDefined();
    await until(
      () => toolResultTexts(b.requestMessages[1] ?? []).some((t) => t.includes("send_none:rejected")),
      "the refusal is model-visible",
    );
    const results = toolResultTexts(b.requestMessages[1] ?? []).join("\n");
    expect(results).toContain("Do not assume an answer.");
    // a provable none refunded the admission — the run could ask again if it wanted
    expect(b.askLedger[0]).toEqual({ askUsed: 0 });
    // no q2 ever reached A
    expect(flow.q2s).toEqual([]);
    // the reply (inReplyTo) is exactly what replies-mode still accepts: the final goes through
    await until(() => b.callCount() >= 3, "final delivered");
    expect(toolResultTexts(b.requestMessages[2] ?? []).join("\n")).toContain("accepted");
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 60_000);

  it("not_woken: the pair-wake quota is spent — the q2 is delivered without a wake ⇒ proven downgrade, immediate return, billed", async () => {
    const flow = { q2s: [] } as Flow;
    const aRef: { settledCount?: () => number } = {};
    const { a, b } = await bootPair(
      {
        flow,
        aRef,
        // B declares a 1/h pair-wake budget to the hub: ask #1's q2 wake is the one reserved…
        bLimits: { pairWakesPerHour: 1, pairMinIntervalMs: 5_000 },
        settingsLimits: { pairMinIntervalMs: 6_000 },
        aScripted: [
          lazyToolTurn("message_session", "tc-a-delegate", () => ({
            to: flow.bSid,
            text: "delegate; you will need to ask twice",
            wake: true,
            expectReply: { timeoutS: 600 },
          })),
          textTurn("delegated"),
          lazyToolTurn("message_session", "tc-a-answer", () => ({
            to: flow.bSid,
            text: "1: ship it",
            replyTo: flow.q2s[0] ?? "",
          })),
          textTurn("requester done"),
        ],
        bScripted: [
          gatedAskTurn("tc-b-ask1", aRef, 1),
          gatedAskTurn("tc-b-ask2", aRef, 2),
          lazyToolTurn("message_session", "tc-b-final", () => ({
            to: flow.aSid,
            text: "FINAL: shipped after one answer and one proven downgrade",
            replyTo: flow.q1 ?? "",
          })),
          textTurn("worker done"),
        ],
      },
      (session) => session.prompt("delegate the task"),
    );
    await until(() => b.callCount() >= 1, "B's run started");
    const token = bDelegationToken(b);
    expect(token).toBeDefined();
    // ask #1 is answered for real (the only wake the pair budget allows)
    await until(() => flow.q2s.length >= 1, "first q2 delivered");
    await until(() => a.callCount() >= 3, "A answered ask #1");
    // ask #2 rides the pair interval (5s) then gets downgraded by the REAL relay
    await until(() => b.callCount() >= 3, "ask #2 returned not_woken", 60_000);
    const asks = askResultTexts(b);
    expect(asks[1]).toContain("Do not assume an answer.");
    expect(asks[1]).toContain("not_woken:pair_wake_rate");
    // a proven downgrade BILLS (no refund): ask #1 answered + ask #2 not_woken
    expect(b.askLedger[1]).toEqual({ askUsed: 2 });
    await until(() => b.callCount() >= 4, "final delivered");
    expect(toolResultTexts(b.requestMessages[3] ?? []).join("\n")).toContain("accepted");
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 90_000);

  it("limit: two answered asks of one run — the third is refused synchronously with unavailable(limit), never sent", async () => {
    const flow = { q2s: [] } as Flow;
    const aRef: { settledCount?: () => number } = {};
    const { a, b } = await bootPair(
      {
        flow,
        aRef,
        bLimits: { pairMinIntervalMs: 5_000 },
        settingsLimits: { pairMinIntervalMs: 6_000 },
        aScripted: [
          lazyToolTurn("message_session", "tc-a-delegate", () => ({
            to: flow.bSid,
            text: "delegate; you will need to ask three times",
            wake: true,
            expectReply: { timeoutS: 600 },
          })),
          textTurn("delegated"),
          lazyToolTurn("message_session", "tc-a-answer1", () => ({
            to: flow.bSid,
            text: "1: ship it",
            replyTo: flow.q2s[0] ?? "",
          })),
          textTurn("first answer given"),
          lazyToolTurn("message_session", "tc-a-answer2", () => ({
            to: flow.bSid,
            text: "1: hold",
            replyTo: flow.q2s[1] ?? flow.q2s[0] ?? "",
          })),
          textTurn("requester done"),
        ],
        bScripted: [
          gatedAskTurn("tc-b-ask1", aRef, 1),
          gatedAskTurn("tc-b-ask2", aRef, 2),
          gatedAskTurn("tc-b-ask3", aRef, 3),
          lazyToolTurn("message_session", "tc-b-final", () => ({
            to: flow.aSid,
            text: "FINAL: shipped after two answers",
            replyTo: flow.q1 ?? "",
          })),
          textTurn("worker done"),
        ],
      },
      (session) => session.prompt("delegate the task"),
    );
    await until(() => b.callCount() >= 1, "B's run started");
    const token = bDelegationToken(b);
    expect(token).toBeDefined();
    await until(() => a.callCount() >= 4, "A answered both asks", 60_000);
    await until(() => b.callCount() >= 4, "all three asks settled (2×5s pair interval included)", 90_000);
    const asks = askResultTexts(b);
    expect(asks).toHaveLength(3);
    expect(asks[0]).toContain("The requester answered (host-redirected ask_user, 1/2 this run)");
    expect(asks[1]).toContain("The requester answered (host-redirected ask_user, 2/2 this run)");
    expect(asks[2]).toContain("Do not assume an answer.");
    expect(asks[2]).toContain("unavailable (limit)");
    // ask #3 was refused at admission — no third q2 send ever hit the relay
    const sendOps = b.requests.filter((f) => f.op === "send" && (f as { expect?: unknown }).expect !== undefined);
    expect(sendOps).toHaveLength(2);
    // both surviving asks billed; the refused third added nothing
    expect(b.askLedger[2]).toEqual({ askUsed: 2 });
    await until(() => b.callCount() >= 5, "final delivered");
    expect(toolResultTexts(b.requestMessages[4] ?? []).join("\n")).toContain("accepted");
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 120_000);
});
