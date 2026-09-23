import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { SWITCH_RESUME_TEXT } from "../../src/tools/switch-context-tool.js";
import { DROP_ALL_SENTINEL } from "../../src/context-switch/hook.js";

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
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool as ToolDefinition);
    },
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    sendUserMessage(text: string) {
      userMessages.push(text);
    },
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, tools, userMessages };
}

function writeSettings(raw: unknown): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  rmSync(settingsPath, { force: true });
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  rmSync(settingsPath, { force: true });
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
    const { pi, tools, handlers } = fakePi();
    activate(pi);
    expect(tools.has("switch_context")).toBe(true);
    expect(tools.has("compact_context")).toBe(false);
    expect(tools.has("set_compact_threshold")).toBe(true);
    expect(handlers.get("session_before_compact")).toHaveLength(1);
  });

  it("keepCompactTool keeps both tools; switchTool=false restores the legacy surface", () => {
    writeSettings({ compact: { keepCompactTool: true } });
    const both = fakePi();
    activate(both.pi);
    expect(both.tools.has("switch_context")).toBe(true);
    expect(both.tools.has("compact_context")).toBe(true);

    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
    writeSettings({ compact: { switchTool: false } });
    const legacy = fakePi();
    activate(legacy.pi);
    expect(legacy.tools.has("switch_context")).toBe(false);
    expect(legacy.tools.has("compact_context")).toBe(true);
    expect(legacy.handlers.get("session_before_compact")).toBeUndefined();
  });

  it("child session (HOST_KEY claimed) never sees the switch tool or the hook", () => {
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    const { pi, tools, handlers } = fakePi();
    activate(pi);
    expect(tools.has("switch_context")).toBe(false);
    expect(tools.has("compact_context")).toBe(false);
    expect(handlers.get("session_before_compact")).toBeUndefined();
  });

  it("end to end: the tool's handoff becomes the compaction summary, then the model is resumed", async () => {
    const { pi, tools, handlers, userMessages } = fakePi();
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
