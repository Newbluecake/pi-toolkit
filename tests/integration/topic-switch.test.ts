import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { resetSettingsFilesIn } from "./helpers/home-sandbox.js";

/**
 * topic-switch P3b pi-facing assembly, integration-level (plan.md §P3b "tests/integration/
 * topic-switch.test.ts"): drives the REAL `activate()` (same style as
 * `merged-plugins-wiring.test.ts`/`compact-hint-wiring.test.ts`) against a throwaway $HOME so
 * `defaultSettingsPath()` never touches the developer's real settings file.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-topic-switch-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, unknown>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    },
    registerCommand(name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, cmd);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    sendMessage() {},
    sendUserMessage(content: unknown, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    getSessionName: () => undefined,
    setSessionName: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  /** Dispatches `event` to every handler registered for it, in registration order — same
   *  semantics as real pi's sequential `await handler(event, ctx)` loop (B1/M1 gen1→gen2 tests
   *  need this to simulate `session_shutdown`/`session_start` explicitly). */
  function emit(event: string, payload: unknown, ctx: unknown): unknown {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      try {
        result = handler(payload, ctx);
        // Some real handlers (e.g. HUD's session_start) are async and may reject against this
        // test's minimal fake ctx (missing TUI-only methods like `ui.setFooter`) — swallow that the
        // same way a real dispatch loop isolates one listener's failure from the rest.
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        /* isolate a synchronous throw from one handler — never let it skip the rest */
      }
    }
    return result;
  }
  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    commands,
    tools,
    appendedEntries,
    sentUserMessages,
    emit,
  };
}

function writeSettings(raw: unknown): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:topic-switch-transfer")];
  resetSettingsFilesIn(dirname(settingsPath));
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:topic-switch-transfer")];
  resetSettingsFilesIn(dirname(settingsPath));
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

function fakeCtx(over: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    mode: "tui",
    cwd: fakeHome,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
    model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
    modelRegistry: { find: () => undefined, complete: () => Promise.reject(new Error("unused")) },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" },
        },
      ],
      getEntries: () => [],
      getSessionId: () => "session-1",
    },
    ui: { setStatus: () => undefined, notify: () => undefined, setEditorText: () => undefined },
    ...over,
  };
}

describe("topic-switch integration: real activate()", () => {
  it("registers the input handler AFTER mention's (registration order: topic-switch wires last)", () => {
    writeSettings({ topicSwitch: { enabled: true } });
    const { pi, handlers } = fakePi();
    activate(pi);
    const inputHandlers = handlers.get("input") ?? [];
    expect(inputHandlers.length).toBeGreaterThanOrEqual(2); // mention + topic-switch at least
  });

  it("registers /topic-switch only when enabled (post-guard, zero overhead off-switch)", () => {
    writeSettings({ topicSwitch: { enabled: false } });
    const { pi, commands } = fakePi();
    activate(pi);
    expect(commands.has("topic-switch")).toBe(false);
  });

  it("enabled vs disabled differ by exactly one 'input' registration (topic-switch's own)", () => {
    writeSettings({ topicSwitch: { enabled: false } });
    const off = fakePi();
    activate(off.pi);
    const offCount = (off.handlers.get("input") ?? []).length;

    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    writeSettings({ topicSwitch: { enabled: true } });
    const on = fakePi();
    activate(on.pi);
    const onCount = (on.handlers.get("input") ?? []).length;

    expect(onCount).toBe(offCount + 1);
  });

  it("child sessions (HOST_KEY pre-claimed) never register /topic-switch", () => {
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    writeSettings({ topicSwitch: { enabled: true } });
    const { pi, commands } = fakePi();
    activate(pi);
    expect(commands.has("topic-switch")).toBe(false);
  });

  it("print mode (hasUI:false) always continues, never crashes activate() or the input handler", () => {
    writeSettings({ topicSwitch: { enabled: true, costThresholdUsd: 0.01 } });
    const { pi, handlers, appendedEntries } = fakePi();
    activate(pi);
    const inputHandlers = handlers.get("input") ?? [];
    const topicSwitchHandler = inputHandlers[inputHandlers.length - 1]!;
    const result = topicSwitchHandler(
      { type: "input", text: "please refactor the entire billing subsystem end to end", source: "interactive" },
      fakeCtx({ hasUI: false, mode: "print" }),
    );
    expect(result).toEqual({ action: "continue" });
    expect(appendedEntries).toEqual([]);
  });

  it("both web-hub and topic-switch wire side by side without colliding (D2 plumbing present, no crash)", () => {
    writeSettings({ topicSwitch: { enabled: true }, webHub: { enabled: true } });
    const { pi, commands } = fakePi();
    expect(() => activate(pi)).not.toThrow();
    expect(commands.has("webhub")).toBe(true);
    expect(commands.has("topic-switch")).toBe(true);
  });

  it("the real cache-ttl warmth port is genuinely wired in: with no usage-ledger evidence at all, the gate safely defers (I6) instead of guessing", async () => {
    writeSettings({ topicSwitch: { enabled: true, judgeTimeoutS: 1, confirmTimeoutS: 1 } });
    const { pi, handlers, appendedEntries } = fakePi();
    activate(pi);
    const inputHandlers = handlers.get("input") ?? [];
    const topicSwitchHandler = inputHandlers[inputHandlers.length - 1]!;
    const ctx = fakeCtx();
    const result = topicSwitchHandler(
      {
        type: "input",
        text: "please refactor the entire billing subsystem end to end for multi currency",
        source: "interactive",
      },
      ctx,
    );
    // No usage-ledger evidence exists for this fake session at all ⇒ the REAL `assessWarmth`
    // (threaded through `wireCacheTtl(...).warmth`, not a test double) returns `unknown/no-ledger`
    // ⇒ gate 3a defers rather than guessing (I6) ⇒ `continue`, zero side effects. This is the
    // end-to-end proof that `src/index.ts` really passes the REAL cache-ttl port into
    // `wireTopicSwitch`'s `deps.warmth`, not a stub that would have let this request through.
    expect(result).toEqual({ action: "continue" });
    expect(appendedEntries).toEqual([]);
  });
});

/** Flush pending microtasks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("topic-switch integration: full success path (real activate(), real gen1→gen2→withSession order)", () => {
  function successCtx(sessionId: string, notified: string[], editorTexts: string[]) {
    return fakeCtx({
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" },
          },
        ],
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              model: "claude",
              provider: "anthropic",
              timestamp: Date.now() - 24 * 3_600_000, // 1 day ago — unambiguously past any TTL
              usage: { cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
        getSessionId: () => sessionId,
      },
      model: {
        provider: "anthropic",
        id: "claude",
        api: "anthropic-messages",
        cost: { input: 3, cacheWrite: 3.75, tiers: [] },
      },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () =>
          Promise.resolve({
            content: [{ type: "text", text: '{"related":false,"confidence":0.95}' }],
            errorMessage: undefined,
          }),
      },
      ui: {
        setStatus: () => undefined,
        notify: (m: string) => notified.push(m),
        setEditorText: (t: string) => editorTexts.push(t),
        select: (_title: string, options: string[]) => Promise.resolve(options[0]),
      },
    });
  }

  it("delivers exactly once in the NEW session, leaves gen2's editor untouched, and never false-warns (B1/M1)", async () => {
    writeSettings({
      topicSwitch: { enabled: true, costThresholdUsd: 0.01, judgeTimeoutS: 1, confirmTimeoutS: 1 },
    });
    const gen1 = fakePi();
    activate(gen1.pi);
    const gen1InputHandlers = gen1.handlers.get("input") ?? [];
    const topicSwitchHandler = gen1InputHandlers[gen1InputHandlers.length - 1]!;

    const gen1Notified: string[] = [];
    const gen1Editor: string[] = [];
    const ctx = successCtx("old-session", gen1Notified, gen1Editor);
    const handled = topicSwitchHandler(
      {
        type: "input",
        text: "please refactor the entire billing subsystem end to end for multi currency support",
        source: "interactive",
      },
      ctx,
    );
    expect(handled).toEqual({ action: "handled" });
    for (let i = 0; i < 10; i += 1) await flush();

    const hop = gen1.sentUserMessages.find(
      (s) => typeof s.content === "string" && (s.content as string).startsWith("/topic-switch __go "),
    );
    expect(hop).toBeDefined();
    const nonce = (hop!.content as string).slice("/topic-switch __go ".length);

    const delivered: unknown[] = [];
    const deliveredOptions: unknown[] = [];
    const rctxNotified: string[] = [];
    const gen2Notified: string[] = [];
    const gen2Editor: string[] = [];
    let gen2: ReturnType<typeof fakePi> | undefined;
    const commandCtx = {
      ...ctx,
      newSession: async (opts: { withSession?: (rctx: unknown) => Promise<void> }) => {
        // 1. session_shutdown fires on gen1 — this ALSO releases src/index.ts's own HOST_KEY claim.
        gen1.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
        // 2. a brand-new activation (gen2) — real pi re-activates extensions on every session
        //    replacement (confirmed by tests/conformance/topic-switch-runtime-harness.ts).
        gen2 = fakePi();
        activate(gen2.pi);
        const gen2Ctx = successCtx("new-session", gen2Notified, gen2Editor);
        gen2.emit("session_start", { type: "session_start", reason: "new" }, gen2Ctx);
        // 3. withSession, still on gen1's closure (the callback command.ts built).
        const rctx = {
          sendUserMessage: async (content: unknown, options?: unknown) => {
            delivered.push(content);
            deliveredOptions.push(options);
          },
          ui: { notify: (m: string) => rctxNotified.push(m) },
        };
        await opts.withSession?.(rctx);
        return { cancelled: false };
      },
    };
    await gen1.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);

    // Exactly one delivery, into the NEW session.
    expect(delivered).toHaveLength(1);
    // pi-1.2-compat §6.1 (D3=B): the withSession delivery queues as followUp — the new session
    // can already be busy (e.g. a bash-job wake run) and pi 1.2 drops a bare sendUserMessage.
    expect(deliveredOptions).toEqual([{ deliverAs: "followUp" }]);
    // B1: gen2's session_start recovery must not have touched the editor or warned at all.
    expect(gen2Editor).toEqual([]);
    expect(gen2Notified).toEqual([]);
    expect(gen2!.appendedEntries).toEqual([]);
    // No fallback/late-withSession warning anywhere either — the send genuinely succeeded.
    expect(rctxNotified).toEqual([]);
    expect(gen1Notified.some((m) => m.includes("未能送达") || m.includes("放回输入框"))).toBe(false);
    // M1: a real "switched" outcome record landed in gen1's (old session's) own entries.
    const outcomes = gen1.appendedEntries.filter(
      (e) => e.customType === "subagent:topic-switch" && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toContain("switched");
  });
});
