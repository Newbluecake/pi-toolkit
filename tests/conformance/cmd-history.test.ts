/**
 * web-hub-cmd-history plan §8.3 — the CONFORMANCE half of the I1 package: the pi runtime
 * premises the whole command-history design stands on, pinned against the REAL devDependency
 * `pi-coding-agent` (in-process `AgentSession` / `AgentSessionRuntime` / `InteractiveMode`,
 * exactly the agent-session-harness / tui-harness / web-resume-C1 harness families).
 *
 * NOT part of the normal `npm test` gate in spirit: run `npm run test:conformance` before any
 * pi peer bump, alongside consult-preserve / fabric-wake / traffic (AGENTS.md Conventions).
 *
 * Premises (plan §8.3's six, numbered the same way):
 *  1. `pi.appendEntry` custom entries never reach the LLM: absent from
 *     `buildSessionContext().messages`, absent from the provider request payload, and the
 *     system prompt is unchanged (F1/G1: cards ride `custom` entries BECAUSE they are
 *     context-invisible).
 *  2. InteractiveMode renders NOTHING for a custom entry with no registered renderer (G4/D10:
 *     the TUI must stay clean without us registering `subagent:cmd`).
 *  3. Extension commands execute IMMEDIATELY while streaming, and the ONLY deferral source is
 *     the agent_settled emission window (`_isEmittingAgentSettled`), whose deferred actions
 *     then run IN ORDER (§1.1/G7 — the intent ledger's oldest-first match mirrors this).
 *  4. `sendUserMessage(text, {expandPromptTemplates:false})` (the DEFAULT) does NOT execute
 *     extension commands — the slash text lands as an ordinary user message (B2: the prompt op
 *     must never register intents because pi itself will never run them).
 *  5. `appendEntry` with no conversation yet does NOT create the session file — the entry
 *     stays in memory and flushes together with the first conversation (§4.10's ENOENT
 *     window premise).
 *  6. `ctx.newSession()` returns `{cancelled:true}` when a `session_before_switch` handler
 *     cancels (the ctx stays usable), returns `{cancelled:false}` on success, and AFTER a
 *     successful replacement every read of the OLD ctx throws the stale error (§4.4's leave
 *     interception: commitBeforeLeave must run before the call, the corrective second end
 *     only while the ctx is still valid).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSessionRuntime,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { assistantTextMsg, disposeHarnessDirs, fakeModel, withSession } from "./agent-session-harness.js";
import { createTuiHarness } from "./tui-harness.js";

afterEach(() => {
  disposeHarnessDirs();
});

const until = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${what}`);
};

// ---------------------------------------------------------------------------
// local harness pieces (gated runtime + runtime-switching session — the web-resume C1 shapes)
// ---------------------------------------------------------------------------

interface GateTurn {
  build: (model: ReturnType<typeof fakeModel>) => unknown;
  /** Hold this model call open until the promise resolves. */
  gate?: Promise<void>;
}

/** Like the shared harness's fakeModelRuntime, but each turn may be held open (streaming state)
 *  and the FULL provider request context is recorded (payload hygiene assertions). */
function gatedRuntime(model: ReturnType<typeof fakeModel>, scripted: GateTurn[]) {
  let call = 0;
  const requestContexts: unknown[] = [];
  return {
    streamSimple: (_m: unknown, context: unknown) => {
      requestContexts.push(context);
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const finish = () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: turn.build(model) } as never);
        return stream;
      };
      return turn.gate ? turn.gate.then(finish) : finish();
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    getError: () => undefined,
    refresh: async () => undefined,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
    requestContexts,
  };
}

const textTurn = (text: string): { toolCall: false; build: (m: ReturnType<typeof fakeModel>) => unknown } => ({
  toolCall: false,
  build: (m) => assistantTextMsg(m, text),
});

/** A gated-runtime AgentSession (premise #3's streaming half needs an open model call). */
async function withGatedSession(
  scripted: GateTurn[],
  extensionFactories: unknown[],
  run: (env: {
    session: import("@earendil-works/pi-coding-agent").AgentSession;
    modelRuntime: ReturnType<typeof gatedRuntime>;
    cwd: string;
  }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "cmdh-conf-gated-"));
  const dirs: string[] = [cwd];
  try {
    const agentDir = join(cwd, ".pi-agent");
    const model = fakeModel();
    const modelRuntime = gatedRuntime(model, scripted);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: extensionFactories as never,
    });
    await loader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      model: model as never,
      modelRuntime: modelRuntime as never,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      tools: [],
    });
    try {
      await run({ session, modelRuntime, cwd });
    } finally {
      session.dispose();
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

/** The web-resume C1 runtime harness (copied locally — that file is not an importable helper):
 *  a REAL AgentSessionRuntime with bindExtensions({mode:"tui", commandContextActions}) wiring
 *  ctx.newSession → runtime.newSession, re-bound after every replacement (premise #6). */
async function withRuntimeSession(
  extensionFactories: unknown[],
  run: (env: {
    runtime: import("@earendil-works/pi-coding-agent").AgentSessionRuntime;
    session: import("@earendil-works/pi-coding-agent").AgentSession;
    cwd: string;
    sessionDir: string;
  }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "cmdh-conf-rt-"));
  const agentDir = join(cwd, ".pi-agent");
  const sessionDir = join(cwd, "sessions");
  const model = fakeModel();
  const modelRuntime = gatedRuntime(model, [textTurn("ok")]);
  const factory = async (o: { cwd: string; agentDir: string; sessionManager: unknown }) => {
    const settingsManager = SettingsManager.create(o.cwd, o.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: o.cwd,
      agentDir: o.agentDir,
      settingsManager,
      extensionFactories: extensionFactories as never,
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: o.cwd,
      agentDir: o.agentDir,
      model: model as never,
      modelRuntime: modelRuntime as never,
      sessionManager: o.sessionManager as never,
      settingsManager,
      resourceLoader,
      tools: [],
    });
    return {
      ...result,
      services: { cwd: o.cwd, agentDir: o.agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] },
    } as never;
  };
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const runtime = await createAgentSessionRuntime(factory as never, { cwd, agentDir, sessionManager });
  const rebind = async (): Promise<void> => {
    const session = runtime.session;
    await session.bindExtensions({
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options: unknown) => runtime.newSession(options as never),
        fork: async (entryId: string, forkOptions: unknown) => ({
          cancelled: (await runtime.fork(entryId, forkOptions as never)).cancelled,
        }),
        navigateTree: async (targetId: string, options: unknown) => ({
          cancelled: (await session.navigateTree(targetId, options as never)).cancelled,
        }),
        switchSession: async (sessionPath: string, options: unknown) =>
          runtime.switchSession(sessionPath, options as never),
        reload: async () => {},
      },
    } as never);
  };
  runtime.setRebindSession(async () => {
    await rebind();
  });
  await rebind();
  try {
    await run({ runtime, session: runtime.session, cwd, sessionDir });
  } finally {
    try {
      runtime.session.dispose();
    } catch {
      /* already disposed by a replacement */
    }
  }
}

// ---------------------------------------------------------------------------
// #1 custom entries never reach the LLM
// ---------------------------------------------------------------------------

describe("cmd-history conformance #1 — appendEntry custom stays out of the LLM", () => {
  const PROBE = "CMDCONF-CUSTOM-PROBE-77f3";

  function probeExtension(seen: { appended: boolean }): ExtensionFactory {
    return (pi: {
      registerCommand: (
        name: string,
        def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
      ) => void;
      appendEntry: (customType: string, data: unknown) => void;
    }) => {
      pi.registerCommand("zzcmdh", {
        description: "cmd-history conformance probe",
        handler: async () => {
          pi.appendEntry("subagent:cmd", {
            v: 1,
            cmdId: "cconf77f3aaaaaaaaaaaa",
            phase: "end",
            name: "zzcmdh",
            args: "",
            source: "web",
            startedAt: 1,
            endedAt: 2,
            state: "done",
            output: { entries: [{ kind: "notify", level: "info", text: PROBE }] },
          });
          seen.appended = true;
        },
      });
    };
  }

  it("the entry is in the branch, absent from buildSessionContext, the provider payload and the system prompt", async () => {
    const seen = { appended: false };
    await withSession(
      { scripted: [textTurn("hello reply")], extensionFactories: [probeExtension(seen)] },
      async ({ session, modelRuntime, cwd }) => {
        void cwd;
        const systemBefore = session.systemPrompt;
        const ctxBefore = JSON.stringify(session.sessionManager.buildSessionContext().messages);
        await session.prompt("/zzcmdh"); // the command appends the custom entry; no model call
        expect(seen.appended).toBe(true);
        // In the branch (persisted shape) …
        expect(
          session.sessionManager.getBranch().some((e) => e.type === "custom" && e.customType === "subagent:cmd"),
        ).toBe(true);
        // … but NOT in the projected context, the system prompt, or any provider payload after it.
        const ctxAfter = JSON.stringify(session.sessionManager.buildSessionContext().messages);
        expect(ctxAfter.includes(PROBE)).toBe(false);
        expect(ctxAfter.length).toBe(ctxBefore.length); // zero messages contributed
        expect(session.systemPrompt).toBe(systemBefore);
        await session.prompt("hello"); // a real turn whose request must not see the entry
        const payloads = JSON.stringify((modelRuntime as unknown as { requestMessages: unknown[][] }).requestMessages);
        expect(payloads.includes(PROBE)).toBe(false);
        expect(payloads.includes("subagent:cmd")).toBe(false);
      },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #2 no renderer ⇒ InteractiveMode renders nothing
// ---------------------------------------------------------------------------

describe("cmd-history conformance #2 — an unrendered custom entry is invisible in the TUI", () => {
  const NOTIFY = "zzrender-cmd-ok-1a";
  const PROBE = "ZZCUSTOM-ENTRY-MUST-NOT-RENDER-9c2";

  it("the command's notify renders; the custom entry's payload never appears on screen", async () => {
    const factory: ExtensionFactory = (pi: {
      registerCommand: (
        name: string,
        def: {
          description: string;
          handler: (args: string, ctx: { ui: { notify: (m: string, t: "info") => void } }) => Promise<void>;
        },
      ) => void;
      appendEntry: (customType: string, data: unknown) => void;
    }) => {
      pi.registerCommand("zzrender", {
        description: "cmd-history TUI render probe",
        handler: async (_args, ctx) => {
          pi.appendEntry("subagent:cmd", {
            v: 1,
            cmdId: "cconf9c2aaaaaaaaaaaaa",
            phase: "end",
            name: "zzrender",
            args: "",
            source: "tui",
            startedAt: 1,
            endedAt: 2,
            state: "done",
            output: { entries: [{ kind: "notify", level: "info", text: PROBE }] },
          });
          ctx.ui.notify(NOTIFY, "info");
        },
      });
    };
    const harness = await createTuiHarness({ scripted: [], extensionFactories: [factory] });
    try {
      // The premise under test is RENDERING, not keystroke routing: drive the real AgentSession's
      // prompt() (the exact path pi's editor submit takes for slash text) — the command then runs
      // through the REAL extension runner with the REAL interactive uiContext.
      await harness.session.prompt("/zzrender");
      await until(() => harness.terminal.raw().includes(NOTIFY), 5_000, "the command's notify to render");
      const raw = harness.terminal.raw();
      expect(raw.includes(NOTIFY)).toBe(true); // the command really ran and the TUI is alive
      expect(raw.includes(PROBE)).toBe(false); // the custom entry payload is never rendered
      expect(raw.includes("subagent:cmd")).toBe(false);
      const screen = harness.renderFullFrame().join("\n");
      expect(screen.includes(PROBE)).toBe(false);
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #3 streaming-immediate + agent_settled-window deferral, in order
// ---------------------------------------------------------------------------

describe("cmd-history conformance #3 — command execution timing", () => {
  interface Probe {
    order: string[];
    settledEntered: boolean;
    /** Set by the deferral test: the agent_settled handler parks on this promise. */
    holdSettled?: Promise<void>;
    releaseSettled?: () => void;
  }

  function timingExtension(p: Probe): ExtensionFactory {
    return (pi: {
      registerCommand: (
        name: string,
        def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
      ) => void;
      on: (event: string, handler: () => unknown) => void;
    }) => {
      pi.registerCommand("zzcmdh", {
        description: "cmd-history timing probe",
        handler: async (args) => {
          p.order.push(`cmd:${args}`);
        },
      });
      pi.on("agent_settled", () => {
        p.settledEntered = true;
        if (p.holdSettled === undefined) {
          p.order.push("settled-done");
          return;
        }
        return p.holdSettled.then(() => {
          p.order.push("settled-done");
        });
      });
    };
  }

  it("a command runs IMMEDIATELY while the model call is still streaming (never queued)", async () => {
    const p: Probe = { order: [], settledEntered: false };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await withGatedSession(
      [{ build: textTurn("streaming reply"), gate }],
      [timingExtension(p)],
      async ({ session, modelRuntime }) => {
        const promptP = session.prompt("go");
        promptP.catch((e) => console.log("DBG promptP rejected", String(e)));
        await until(
          () => session.isStreaming || (modelRuntime as unknown as { callCount: () => number }).callCount() > 0,
          5_000,
          "session to start streaming",
        );
        await session.prompt("/zzcmdh during-stream");
        expect(p.order).toEqual(["cmd:during-stream"]); // ran inside the call, no streamingBehavior
        release();
        await promptP;
      },
    );
  }, 30_000);

  it("during the agent_settled emission window commands are DEFERRED and then run IN ORDER", async () => {
    const p: Probe = { order: [], settledEntered: false };
    p.holdSettled = new Promise<void>((r) => {
      p.releaseSettled = r;
    });
    await withGatedSession([textTurn("done")], [timingExtension(p)], async ({ session }) => {
      const promptP = session.prompt("go");
      await until(() => p.settledEntered, 5_000, "the settled handler to be entered");
      // Both calls return BEFORE their commands run (pi pushes them onto _deferredSettledActions).
      await session.prompt("/zzcmdh one");
      await session.prompt("/zzcmdh two");
      expect(p.order).toEqual([]); // deferred: neither executed yet
      p.releaseSettled!();
      await promptP;
      expect(p.order).toEqual(["settled-done", "cmd:one", "cmd:two"]); // handlers first, then IN ORDER
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #4 sendUserMessage never executes slash text by default
// ---------------------------------------------------------------------------

describe("cmd-history conformance #4 — sendUserMessage does not dispatch slash commands", () => {
  function probeExtension(order: string[]): ExtensionFactory {
    return (pi: {
      registerCommand: (
        name: string,
        def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
      ) => void;
    }) => {
      pi.registerCommand("zzcmdh", {
        description: "cmd-history sendUserMessage probe",
        handler: async (args) => {
          order.push(`cmd:${args}`);
        },
      });
    };
  }

  it("default (expand:false) sends the text as a plain user message; explicit true executes it", async () => {
    const order: string[] = [];
    await withSession(
      { scripted: [textTurn("reply one"), textTurn("reply two")], extensionFactories: [probeExtension(order)] },
      async ({ session, modelRuntime }) => {
        await session.sendUserMessage("/zzcmdh never-runs"); // no options ⇒ expandPromptTemplates:false
        expect(order).toEqual([]); // the command NEVER ran
        const requests = (modelRuntime as unknown as { requestMessages: unknown[][] }).requestMessages;
        const lastUser = JSON.stringify(requests.at(-1));
        expect(lastUser.includes("/zzcmdh never-runs")).toBe(true); // it became ordinary message text
        // Positive control: the builtin bridge's exact call shape DOES execute the command.
        await session.sendUserMessage("/zzcmdh runs", {
          expandPromptTemplates: true,
          deliverAs: "followUp",
        });
        expect(order).toEqual(["cmd:runs"]);
      },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #5 no conversation ⇒ appendEntry does not create the file
// ---------------------------------------------------------------------------

describe("cmd-history conformance #5 — the pre-first-message window keeps the file absent", () => {
  function probeExtension(ran: { at: number }): ExtensionFactory {
    return (pi: {
      registerCommand: (
        name: string,
        def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
      ) => void;
      appendEntry: (customType: string, data: unknown) => void;
    }) => {
      pi.registerCommand("zzboot", {
        description: "cmd-history pre-conversation probe",
        handler: async () => {
          pi.appendEntry("subagent:cmd", {
            v: 1,
            cmdId: "cconf5b1aaaaaaaaaaaaaa",
            phase: "end",
            name: "zzboot",
            args: "",
            source: "web",
            startedAt: 1,
            endedAt: 2,
            state: "done",
          });
          ran.at += 1;
        },
      });
    };
  }

  it("the entry stays in memory while the file does not exist; the first conversation flushes both", async () => {
    const ran = { at: 0 };
    await withSession(
      { scripted: [textTurn("first reply")], extensionFactories: [probeExtension(ran)], persist: true },
      async ({ session }) => {
        const file = session.sessionManager.getSessionFile();
        expect(file).toBeDefined();
        await session.prompt("/zzboot"); // a command in the fresh session: NO conversation message
        expect(ran.at).toBe(1);
        expect(
          session.sessionManager.getBranch().some((e) => e.type === "custom" && e.customType === "subagent:cmd"),
        ).toBe(true); // in the in-memory branch …
        expect(existsSync(file!)).toBe(false); // … but the file is NOT created (§4.10's premise)
        await session.prompt("first message");
        expect(existsSync(file!)).toBe(true); // the first conversation creates it …
        const lines = (await import("node:fs")).readFileSync(file!, "utf8");
        expect(lines.includes('"subagent:cmd"')).toBe(true); // … flushing the waiting entry too
      },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #6 newSession: {cancelled} semantics + stale ctx after a real replacement
// ---------------------------------------------------------------------------

describe("cmd-history conformance #6 — ctx.newSession return values and ctx invalidation", () => {
  interface LeaveProbe {
    results: string[];
    staleError: string | undefined;
    cancelNext: boolean;
  }

  function leaveExtension(p: LeaveProbe): ExtensionFactory {
    return (pi: {
      registerCommand: (
        name: string,
        def: {
          description: string;
          handler: (
            args: string,
            ctx: {
              newSession: (options?: unknown) => Promise<{ cancelled?: boolean }>;
              cwd: string;
            },
          ) => Promise<void>;
        },
      ) => void;
      on: (event: string, handler: (event: never) => unknown) => void;
    }) => {
      pi.registerCommand("zzleave", {
        description: "cmd-history leave probe",
        handler: async (_args, ctx) => {
          const rc = await ctx.newSession();
          p.results.push(JSON.stringify(rc));
          try {
            void ctx.cwd; // still readable when cancelled; throws after a real replacement
            p.staleError = undefined;
          } catch (err) {
            p.staleError = err instanceof Error ? err.message : String(err);
          }
        },
      });
      pi.on("session_before_switch", () => (p.cancelNext ? { cancel: true } : undefined));
    };
  }

  it("cancelled ⇒ {cancelled:true} with a still-usable ctx; success ⇒ {cancelled:false} and the old ctx throws", async () => {
    const p: LeaveProbe = {
      results: [],
      staleError: "unset",
      cancelNext: false,
    };
    await withRuntimeSession([leaveExtension(p)], async ({ session, runtime }) => {
      // cancelled path: a session_before_switch handler cancels BEFORE any teardown
      p.cancelNext = true;
      await session.prompt("/zzleave");
      expect(p.results).toEqual(['{"cancelled":true}']);
      expect(p.staleError).toBeUndefined(); // the ctx is untouched — a corrective record is legal
      const sidBefore = runtime.session.sessionManager.getSessionId();
      // success path: the replacement really happens
      p.cancelNext = false;
      await runtime.session.prompt("/zzleave");
      expect(p.results).toEqual(['{"cancelled":true}', '{"cancelled":false}']);
      expect(p.staleError).toMatch(/stale/i); // AFTER the switch every old-ctx read throws
      expect(runtime.session.sessionManager.getSessionId()).not.toBe(sidBefore);
    });
  }, 60_000);
});
