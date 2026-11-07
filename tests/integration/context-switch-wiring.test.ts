import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { SWITCH_RESUME_TEXT } from "../../src/context-switch/tool.js";
import { RESUME_TEXT as COMPACT_RESUME_TEXT } from "../../src/compact-hint/compact-tool.js";
import { DROP_ALL_SENTINEL } from "../../src/context-switch/hook.js";
import { resetSettingsFilesIn } from "./helpers/home-sandbox.js";

/**
 * context-switch 端到端接线（context-switch-plan §2/§3/§6）：
 * 工具 → ctx.compact() → session_before_compact 钩子回传模型自写的 summary → resume 消息。
 * 只有走真实 activate() 才能证明"默认替换 compact_context"和"钩子确实注册在主会话"。
 *
 * 与 merged-plugins-wiring 同约定：跑在一次性 $HOME 上，避免碰开发者真实设置文件。
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-switch-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const userMessages: string[] = [];
  /** `options` argument of every `pi.sendUserMessage` call, aligned with `userMessages` (pi-1.2-compat §6.1: the resume continuations must queue as followUp). */
  const userMessageOptions: unknown[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool as ToolDefinition);
    },
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    sendUserMessage(text: string, options?: unknown) {
      userMessages.push(text);
      userMessageOptions.push(options);
    },
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, tools, userMessages, userMessageOptions };
}

function writeSettings(raw: unknown): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  resetSettingsFilesIn(dirname(settingsPath));
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  resetSettingsFilesIn(dirname(settingsPath));
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

const handoff = {
  goal: "把压缩 hint 模块换成上下文切换工具，交接内容由模型自己写进工具参数。",
  progress: "钩子、store、工具与设置都已落地，单测全绿，正在补端到端接线测试。",
  next_steps: "跑 typecheck 与全量测试，再更新 README / AGENTS / CHANGELOG。",
  key_files: ["src/context-switch/hook.ts — 回传 summary 的钩子"],
};

function compactEvent() {
  return {
    reason: "manual" as const,
    preparation: {
      firstKeptEntryId: "entry-7",
      tokensBefore: 240_000,
      fileOps: { read: new Set(["r.ts"]), written: new Set(["w.ts"]), edited: new Set<string>() },
    },
  };
}

describe("context-switch wiring", () => {
  it("host session: switch_context replaces compact_context by default and installs the compaction hook", () => {
    // topic-switch (docs/dev/topic-switch/plan.md) registers its OWN session_before_compact
    // handler too (to track an in-progress compaction) — disabled here so this test keeps
    // counting exactly what it always counted: context-switch's own hook registration.
    writeSettings({ topicSwitch: { enabled: false } });
    const { pi, tools, handlers } = fakePi();
    activate(pi);
    expect(tools.has("switch_context")).toBe(true);
    expect(tools.has("compact_context")).toBe(false);
    expect(tools.has("set_compact_threshold")).toBe(true);
    expect(handlers.get("session_before_compact")).toHaveLength(1);
  });

  it("keepCompactTool keeps both tools; switchTool=false restores the legacy surface", () => {
    writeSettings({ compact: { keepCompactTool: true }, topicSwitch: { enabled: false } });
    const both = fakePi();
    activate(both.pi);
    expect(both.tools.has("switch_context")).toBe(true);
    expect(both.tools.has("compact_context")).toBe(true);

    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
    writeSettings({ compact: { switchTool: false }, topicSwitch: { enabled: false } });
    const legacy = fakePi();
    activate(legacy.pi);
    expect(legacy.tools.has("switch_context")).toBe(false);
    expect(legacy.tools.has("compact_context")).toBe(true);
    expect(legacy.handlers.get("session_before_compact")).toBeUndefined();
  });

  it("child session (HOST_KEY claimed) gets the boundary-mode switch_context tool but never compact_context/the main-session hook (child-context-switch plan.md)", () => {
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    const { pi, tools, handlers } = fakePi();
    activate(pi);
    // child-context-switch plan.md §2/§4 (P3): switch_context IS registered in child sessions
    // now — boundary mode, gated by compact.childSessions (default true) and the process-wide
    // capability state machine, wired by src/context-switch/child.ts (pre-guard).
    expect(tools.has("switch_context")).toBe(true);
    expect(tools.has("compact_context")).toBe(false);
    expect(handlers.get("session_before_compact")).toBeUndefined();
  });

  it("end to end: the tool's handoff becomes the compaction summary, then the model is resumed", async () => {
    const { pi, tools, handlers, userMessages, userMessageOptions } = fakePi();
    activate(pi);
    const tool = tools.get("switch_context")!;
    let callbacks: { onComplete: () => void; onError: (error: Error) => void } | undefined;
    const ctx = {
      mode: "tui",
      compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => {
        callbacks = options;
      },
      getContextUsage: () => ({ tokens: 240_000 }),
      ui: { notify: () => undefined },
      sessionManager: { getSessionFile: () => "/tmp/prev.jsonl", getBranch: () => [] },
    };
    const result = await tool.execute!("call", handoff as never, undefined as never, undefined as never, ctx as never);
    expect(result.details).toMatchObject({ ok: true, keepRecent: true });

    const hook = handlers.get("session_before_compact")![0]!;
    const hookResult = hook(compactEvent(), ctx) as { compaction: { summary: string; firstKeptEntryId: string } };
    expect(hookResult.compaction.firstKeptEntryId).toBe("entry-7");
    expect(hookResult.compaction.summary).toContain("把压缩 hint 模块换成上下文切换工具");
    expect(hookResult.compaction.summary).toContain("src/context-switch/hook.ts");
    expect(hookResult.compaction.summary).toContain("/tmp/prev.jsonl");
    expect(hookResult.compaction.summary).toContain("w.ts");

    callbacks!.onComplete();
    expect(userMessages).toContain(SWITCH_RESUME_TEXT);
    // pi-1.2-compat §6.1 (D3=B): the resume continuation must queue as followUp — pi 1.2 counts
    // the whole startup window as busy and silently drops a bare sendUserMessage there.
    const resumeIdx = userMessages.indexOf(SWITCH_RESUME_TEXT);
    expect(userMessageOptions[resumeIdx]).toEqual({ deliverAs: "followUp" });
  });

  it("legacy compact_context: the onComplete resume is sent with {deliverAs:'followUp'} (pi-1.2-compat §6.1)", async () => {
    writeSettings({ compact: { switchTool: false }, topicSwitch: { enabled: false } });
    const { pi, tools, userMessages, userMessageOptions } = fakePi();
    activate(pi);
    const tool = tools.get("compact_context")!;
    let callbacks:
      { onComplete: (result: { tokensBefore: number }) => void; onError: (error: Error) => void } | undefined;
    const ctx = {
      mode: "tui",
      compact: (options: {
        onComplete: (result: { tokensBefore: number }) => void;
        onError: (error: Error) => void;
      }) => {
        callbacks = options;
      },
      getContextUsage: () => ({ tokens: 240_000 }),
      ui: { notify: () => undefined },
    };
    await tool.execute!("call", {} as never, undefined as never, undefined as never, ctx as never);
    expect(callbacks).toBeDefined();
    callbacks!.onComplete({ tokensBefore: 240_000 });
    expect(userMessages).toEqual([COMPACT_RESUME_TEXT]);
    expect(userMessageOptions[0]).toEqual({ deliverAs: "followUp" });
  });

  it("compact-hint forced path (activate level): the force onComplete resume goes through the real src/index.ts closure with {deliverAs:'followUp'} (pi-1.2-compat §6.1)", async () => {
    // No settings file: defaults (compact enabled, switchTool, forceDemandTurns=1, forceAtPercent=88
    // anchored at a 1M window). This is deliberately NOT compact-hint-wiring.test.ts — that file's
    // `sendUserMessage: resume` is a dep-injected stub and can never see the real activate()-time
    // closure this pin guards (src/index.ts's createCompactHintHook wiring).
    const { pi, handlers, userMessages, userMessageOptions } = fakePi();
    activate(pi);

    // Build a real stack (the compact-hint state lives in holder.current, only set by the
    // session_start rebuild). Minimal ctx shape proven by compact-dynamic-wiring.test.ts.
    const sessionCtx = {
      mode: "tui",
      cwd: fakeHome,
      hasUI: false,
      sessionManager: { getEntries: () => [], getSessionId: () => "wiring-force", getBranch: () => [] },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: new Proxy(
        { notify: () => undefined, theme: { fg: (_color: string, text: string) => text } },
        {
          get: (target, prop) =>
            prop in target ? (target as Record<string | symbol, unknown>)[prop as string] : () => undefined,
        },
      ),
      getContextUsage: () => ({ percent: 95, contextWindow: 1_000_000, tokens: 950_000 }),
      model: {
        provider: "anthropic",
        id: "opus-5.5",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.test",
        contextWindow: 1_000_000,
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      },
    } as never;
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ reason: "new" }, sessionCtx);
    }

    // turn_end with usage past the force line: first call = the switch_context demand turn
    // (forceDemandTurns=1), second call = the actual forced compaction.
    const compactCalls: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
    const turnEndCtx = {
      mode: "tui",
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ percent: 95, tokens: 950_000, contextWindow: 1_000_000 }),
      compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => {
        compactCalls.push(options);
      },
    } as never;
    const runTurnEnd = () => {
      for (const handler of handlers.get("turn_end") ?? []) {
        try {
          const result = handler({}, turnEndCtx);
          if (result instanceof Promise) result.catch(() => undefined);
        } catch {
          /* isolate one listener's failure — same as topic-switch.test.ts's emit */
        }
      }
    };
    runTurnEnd(); // demand turn: no forced compaction yet
    expect(compactCalls).toHaveLength(0);
    runTurnEnd(); // demand exhausted: force fires
    expect(compactCalls).toHaveLength(1);

    compactCalls[0]!.onComplete();
    // The real src/index.ts closure queued the resume as followUp instead of a bare
    // sendUserMessage that pi 1.2 would silently drop when a run is starting.
    expect(userMessages).toHaveLength(1);
    expect(userMessageOptions[0]).toEqual({ deliverAs: "followUp" });
  });

  it("keep_recent=false drops everything before the cut point", async () => {
    const { pi, tools, handlers } = fakePi();
    activate(pi);
    const tool = tools.get("switch_context")!;
    const ctx = {
      mode: "tui",
      compact: () => undefined,
      getContextUsage: () => undefined,
      ui: { notify: () => undefined },
    };
    await tool.execute!(
      "call",
      { ...handoff, keep_recent: false } as never,
      undefined as never,
      undefined as never,
      ctx as never,
    );
    const hook = handlers.get("session_before_compact")![0]!;
    const hookResult = hook(compactEvent(), ctx) as { compaction: { firstKeptEntryId: string } };
    expect(hookResult.compaction.firstKeptEntryId).toBe(DROP_ALL_SENTINEL);
  });

  it("a compaction with no staged handoff leaves pi's own summarizer alone", () => {
    const { pi, handlers } = fakePi();
    activate(pi);
    const hook = handlers.get("session_before_compact")![0]!;
    expect(hook(compactEvent(), {})).toBeUndefined();
  });
});
