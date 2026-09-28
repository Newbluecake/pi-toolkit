/**
 * §4.9 real command matrix (plan §4.9 points 3/4/5/7/8, package C12): exercises the actual
 * `createCommandCaptureEngine()` + `wrapCommandApi()` round trip a future dispatcher
 * (`builtin-bridge.ts`, package C11) will drive — `arm()` → pi invoking the wrapped
 * `registerCommand` handler (simulating `sendUserMessage`'s synchronous dispatch) → the real
 * command handler running against a captured `ctx`/`ctx.ui` → the resulting `CommandOutputWire`.
 *
 * `command-capture.test.ts` (existing, C0) already locks down the *fast path* (no capture wired,
 * or this specific invocation not claimed) byte-for-byte; this file is exclusively about the
 * *captured* path's behavior once a real engine claims an invocation.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import {
  createCommandCaptureEngine,
  isWebInvocation,
  wrapCommandApi,
  type CaptureInvocation,
  type CommandCaptureEngine,
} from "../../../src/web-hub/agent/command-capture.js";
import type { CmdOrigin } from "../../../src/web-hub/protocol/messages.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "req-1" };

function invocationOf(overrides: Partial<CaptureInvocation> = {}): CaptureInvocation {
  return {
    cmdId: "cmd-1",
    reqId: "req-1",
    origin: ORIGIN,
    name: "mycmd",
    args: "",
    deadlineAt: Date.now() + 10_000,
    ...overrides,
  };
}

/** Records every real `ctx.ui` call the wrapped handler's real terminal delegate ever sees. */
interface UiRecorder {
  notify: Array<{ message: string; type?: "info" | "warning" | "error" }>;
  setWidget: Array<{ key: string; content: unknown; options?: unknown }>;
  setStatus: Array<{ key: string; text: string | undefined }>;
  setEditorText: string[];
  pasteToEditor: string[];
  setTitle: string[];
}

function fakeUi(recorder: UiRecorder): ExtensionUIContext {
  const ui = {
    notify: (message: string, type?: "info" | "warning" | "error") => {
      recorder.notify.push({ message, ...(type !== undefined ? { type } : {}) });
    },
    setWidget: (key: string, content: unknown, options?: unknown) => {
      recorder.setWidget.push({ key, content, options });
    },
    setStatus: (key: string, text: string | undefined) => {
      recorder.setStatus.push({ key, text });
    },
    setEditorText: (text: string) => {
      recorder.setEditorText.push(text);
    },
    pasteToEditor: (text: string) => {
      recorder.pasteToEditor.push(text);
    },
    setTitle: (title: string) => {
      recorder.setTitle.push(title);
    },
    theme: { fg: (_c: string, s: string) => s },
    // The real terminal dialogs — asserted-never-called by every captured test below.
    editor: vi.fn(async () => "SHOULD-NOT-BE-CALLED"),
    select: vi.fn(async () => "SHOULD-NOT-BE-CALLED"),
    input: vi.fn(async () => "SHOULD-NOT-BE-CALLED"),
    confirm: vi.fn(async () => true),
    custom: vi.fn(async () => "SHOULD-NOT-BE-CALLED"),
  };
  return ui as unknown as ExtensionUIContext;
}

function fakeApi(): ExtensionAPI & { commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> } {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const api = {
    commands,
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, command);
    },
  };
  return api as unknown as ExtensionAPI & { commands: typeof commands };
}

function fakeCtx(ui: ExtensionUIContext, mode: "tui" | "rpc" = "tui"): ExtensionCommandContext {
  return { mode, hasUI: true, ui, cwd: "/tmp" } as unknown as ExtensionCommandContext;
}

/** Dispatches `capture.arm(inv)` then invokes the wrapped handler exactly like `pi` invoking the
 * command synchronously right after `sendUserMessage`, mirroring §4.9 point 3's "同步前缀". */
async function dispatch(
  api: ExtensionAPI & { commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> },
  engine: CommandCaptureEngine,
  invocation: CaptureInvocation,
  ctx: ExtensionCommandContext,
): Promise<unknown> {
  engine.arm(invocation);
  const command = api.commands.get(invocation.name);
  if (command === undefined) throw new Error(`command ${invocation.name} not registered`);
  return command.handler(invocation.args, ctx);
}

describe("createCommandCaptureEngine — arm/take/settleArm claiming (§4.9 point 3)", () => {
  it("take() returns the armed invocation on an exact name+args match and clears the slot", () => {
    const engine = createCommandCaptureEngine();
    const inv = invocationOf({ args: "foo" });
    engine.arm(inv);
    expect(engine.take("mycmd", "foo")).toEqual(inv);
    expect(engine.take("mycmd", "foo")).toBeUndefined(); // slot already cleared
  });

  it("take() with a different name or args does not match the sync slot", () => {
    const engine = createCommandCaptureEngine();
    engine.arm(invocationOf({ name: "mycmd", args: "foo" }));
    expect(engine.take("other", "foo")).toBeUndefined();
    expect(engine.take("mycmd", "bar")).toBeUndefined();
  });

  it("settleArm() moves an un-taken slot into the fallback queue, claimable later by take()", () => {
    const now = { t: 0 };
    const engine = createCommandCaptureEngine({ now: () => now.t });
    const inv = invocationOf({ deadlineAt: 10_000 });
    engine.arm(inv);
    engine.settleArm(); // never taken synchronously (the "settle-deferred" case)
    expect(engine.take(inv.name, inv.args)).toEqual(inv); // claimed later, from the queue
  });

  it("settleArm() after take() already claimed the slot is a no-op", () => {
    const engine = createCommandCaptureEngine();
    const inv = invocationOf();
    engine.arm(inv);
    expect(engine.take(inv.name, inv.args)).toEqual(inv);
    expect(() => engine.settleArm()).not.toThrow();
    // nothing left to claim
    expect(engine.take(inv.name, inv.args)).toBeUndefined();
  });

  it("fallback queue entries expire after min(5s, remaining deadline) and become unclaimable", () => {
    vi.useFakeTimers();
    try {
      const now = { t: 0 };
      const engine = createCommandCaptureEngine({ now: () => now.t });
      const inv = invocationOf({ deadlineAt: 100_000 }); // deadline far away ⇒ ttl caps at 5s
      engine.arm(inv);
      engine.settleArm();
      now.t = 4_000;
      vi.advanceTimersByTime(4_000);
      expect(engine.take(inv.name, inv.args)).toEqual(inv); // still alive just before 5s — re-arm to check the boundary case separately below
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fallback entry past its TTL is gone (never resurrected as a stale match for a later, unrelated invocation)", () => {
    vi.useFakeTimers();
    try {
      const now = { t: 0 };
      const engine = createCommandCaptureEngine({ now: () => now.t });
      const inv = invocationOf({ deadlineAt: 100_000 });
      engine.arm(inv);
      engine.settleArm();
      now.t = 5_001;
      vi.advanceTimersByTime(5_001);
      expect(engine.take(inv.name, inv.args)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the fallback TTL is capped by the invocation's own remaining deadline, not just the 5s ceiling", () => {
    vi.useFakeTimers();
    try {
      const now = { t: 0 };
      const engine = createCommandCaptureEngine({ now: () => now.t });
      const inv = invocationOf({ deadlineAt: 2_000 }); // only 2s left, below the 5s ceiling
      engine.arm(inv);
      engine.settleArm();
      now.t = 2_001;
      vi.advanceTimersByTime(2_001);
      expect(engine.take(inv.name, inv.args)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an invocation whose deadline has already elapsed by settleArm() time is dropped immediately, never queued", () => {
    const now = { t: 5_000 };
    const engine = createCommandCaptureEngine({ now: () => now.t });
    const inv = invocationOf({ deadlineAt: 1_000 }); // deadline already in the past
    engine.arm(inv);
    engine.settleArm();
    expect(engine.take(inv.name, inv.args)).toBeUndefined();
  });

  it("owns(name) is true once a name has been armed, false for anything never armed", () => {
    const engine = createCommandCaptureEngine();
    expect(engine.owns("mycmd")).toBe(false);
    engine.arm(invocationOf({ name: "mycmd" }));
    expect(engine.owns("mycmd")).toBe(true);
    expect(engine.owns("othercmd")).toBe(false);
  });

  it("FIFO: two queued invocations of the same name+args are claimed in arrival order", () => {
    const now = { t: 0 };
    const engine = createCommandCaptureEngine({ now: () => now.t });
    const first = invocationOf({ cmdId: "c1", deadlineAt: 10_000 });
    engine.arm(first);
    engine.settleArm();
    const second = invocationOf({ cmdId: "c2", deadlineAt: 10_000 });
    engine.arm(second);
    engine.settleArm();
    expect(engine.take(first.name, first.args)).toEqual(first);
    expect(engine.take(second.name, second.args)).toEqual(second);
  });
});

describe("wrapCommandApi captured path — the real ctx/ui table (§4.9 point 4/5)", () => {
  function setup() {
    const recorder: UiRecorder = {
      notify: [],
      setWidget: [],
      setStatus: [],
      setEditorText: [],
      pasteToEditor: [],
      setTitle: [],
    };
    const api = fakeApi();
    const engine = createCommandCaptureEngine();
    const pi = wrapCommandApi(api, () => engine);
    return { recorder, api, engine, pi };
  }

  it("notify: forwards to the real terminal ui AND is collected", async () => {
    const { recorder, api, engine, pi } = setup();
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.notify("hello web", "warning");
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ui = fakeUi(recorder);
    const ctx = fakeCtx(ui);
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);

    expect(recorder.notify).toEqual([{ message: "hello web", type: "warning" }]);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([{ kind: "notify", level: "warning", text: "hello web" }]);
  });

  it("notify with no explicit type collects level:'info'", async () => {
    const { recorder, api, engine, pi } = setup();
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.notify("plain");
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([{ kind: "notify", level: "info", text: "plain" }]);
  });

  it("setWidget(key, string[]): forwards AND collects the joined text", async () => {
    const { recorder, api, engine, pi } = setup();
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.setWidget("w1", ["line1", "line2"]);
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(recorder.setWidget).toEqual([{ key: "w1", content: ["line1", "line2"], options: undefined }]);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([{ kind: "widget", key: "w1", text: "line1\nline2" }]);
  });

  it("setWidget(key, factory-function): forwards AND collects a '(rendered in terminal)' placeholder", async () => {
    const { recorder, api, engine, pi } = setup();
    const factory = () => ({ render: () => "" });
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.setWidget("w1", factory);
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(recorder.setWidget[0]?.content).toBe(factory);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([
      { kind: "widget", key: "w1", text: "(rendered in terminal)" },
    ]);
  });

  it("setWidget(key, undefined) (clearing): forwards but is NOT collected", async () => {
    const { recorder, api, engine, pi } = setup();
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.setWidget("w1", undefined);
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(recorder.setWidget).toEqual([{ key: "w1", content: undefined, options: undefined }]);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([]);
  });

  it("setStatus(key, text): forwards AND collects; setStatus(key, undefined) forwards but is not collected", async () => {
    const { recorder, api, engine, pi } = setup();
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.setStatus("s1", "busy");
        ctx.ui.setStatus("s1", undefined);
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(recorder.setStatus).toEqual([
      { key: "s1", text: "busy" },
      { key: "s1", text: undefined },
    ]);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([{ kind: "status", key: "s1", text: "busy" }]);
  });

  it("editor(title, prefill): never opens the real dialog; collects the prefill as text plus an interactive marker; resolves undefined", async () => {
    const { recorder, api, engine, pi } = setup();
    let resolved: unknown = "not-set";
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        resolved = await ctx.ui.editor("memory doctor", "report body");
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ui = fakeUi(recorder);
    const ctx = fakeCtx(ui);
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(ui.editor).not.toHaveBeenCalled();
    expect(resolved).toBeUndefined();
    const out = engine.outputFor(inv.cmdId);
    expect(out?.entries).toEqual([
      { kind: "text", title: "memory doctor", text: "report body" },
      { kind: "interactive", text: "editor" },
    ]);
    expect(out?.needsTerminal).toBe(true);
  });

  it("select/input/confirm/custom: never open the real dialog; return the same synthetic 'declined' values a human would produce", async () => {
    const { recorder, api, engine, pi } = setup();
    const seen: Record<string, unknown> = {};
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        seen.select = await ctx.ui.select("pick one", ["a", "b"]);
        seen.input = await ctx.ui.input("name?");
        seen.confirm = await ctx.ui.confirm("sure?", "really?");
        seen.custom = await ctx.ui.custom(() => ({ render: () => "" }) as never);
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ui = fakeUi(recorder);
    const ctx = fakeCtx(ui);
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(seen).toEqual({ select: undefined, input: undefined, confirm: false, custom: undefined });
    const out = engine.outputFor(inv.cmdId);
    expect(out?.entries).toEqual([
      { kind: "interactive", title: "pick one", text: "select" },
      { kind: "interactive", title: "name?", text: "input" },
      { kind: "interactive", title: "sure?", text: "confirm" },
      { kind: "interactive", text: "custom" },
    ]);
    expect(out?.needsTerminal).toBe(true);
  });

  it("setEditorText/pasteToEditor: never forwarded (must not clobber a real terminal draft); recorded as an interactive entry", async () => {
    const { recorder, api, engine, pi } = setup();
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.setEditorText("draft one");
        ctx.ui.pasteToEditor("pasted text");
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(recorder.setEditorText).toEqual([]);
    expect(recorder.pasteToEditor).toEqual([]);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([
      { kind: "interactive", text: "editor-text" },
      { kind: "interactive", text: "editor-text" },
    ]);
  });

  it("other ui members (theme, setTitle) delegate untouched and are not collected", async () => {
    const { recorder, api, engine, pi } = setup();
    let themedText = "";
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        themedText = ctx.ui.theme.fg("dim", "hi");
        ctx.ui.setTitle("new title");
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await dispatch(api, engine, inv, ctx);
    expect(themedText).toBe("hi");
    expect(recorder.setTitle).toEqual(["new title"]);
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([]);
  });

  it("isWebInvocation(ctx) is true inside a captured handler, false for a plain (unclaimed) invocation", async () => {
    const { api, engine, pi } = setup();
    const seen: boolean[] = [];
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        seen.push(isWebInvocation(ctx));
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(
      fakeUi({ notify: [], setWidget: [], setStatus: [], setEditorText: [], pasteToEditor: [], setTitle: [] }),
    );

    // Claimed (web) invocation.
    await dispatch(api, engine, invocationOf({ args: "a" }), ctx);
    // Unclaimed (plain terminal) invocation — different args, so take() never matches.
    const command = api.commands.get("mycmd");
    await command?.handler("b", ctx);

    expect(seen).toEqual([true, false]);
  });

  it("a thrown error is collected as an 'error' entry and rethrown unchanged; finish still runs (window closes)", async () => {
    const { recorder, api, engine, pi } = setup();
    pi.registerCommand("mycmd", {
      handler: async () => {
        throw new Error("boom");
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(fakeUi(recorder));
    const inv = invocationOf();
    await expect(dispatch(api, engine, inv, ctx)).rejects.toThrow("boom");
    expect(engine.outputFor(inv.cmdId)?.entries).toEqual([{ kind: "error", text: "boom" }]);
  });

  it("finish() only runs once the handler's own Promise actually settles, not merely once it is obtained", async () => {
    const { api, engine, pi } = setup();
    let resolveHandler: (() => void) | undefined;
    const order: string[] = [];
    pi.registerCommand("mycmd", {
      handler: () =>
        new Promise<void>((resolve) => {
          order.push("handler-started");
          resolveHandler = () => {
            order.push("handler-resolving");
            resolve();
          };
        }),
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(
      fakeUi({ notify: [], setWidget: [], setStatus: [], setEditorText: [], pasteToEditor: [], setTitle: [] }),
    );
    const inv = invocationOf();
    engine.arm(inv);
    const pending = dispatch(api, engine, inv, ctx);
    // finish() must not have run yet — the window is still open while the handler is suspended.
    expect(engine.outputFor(inv.cmdId)).toBeDefined();
    order.push("about-to-resolve");
    resolveHandler?.();
    await pending;
    expect(order).toEqual(["handler-started", "about-to-resolve", "handler-resolving"]);
  });

  it("plain terminal invocation (take() doesn't match) never gets a captured ctx — real dialogs stay live", async () => {
    const { recorder, api, engine, pi } = setup();
    let sawSelect: unknown = "unset";
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        sawSelect = await ctx.ui.select("pick", ["x"]);
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ui = fakeUi(recorder);
    const ctx = fakeCtx(ui);
    // Arm for a DIFFERENT args string, so take("mycmd", "typed-by-human") never matches.
    engine.arm(invocationOf({ args: "web-args" }));
    const command = api.commands.get("mycmd");
    await command?.handler("typed-by-human", ctx);
    expect(ui.select).toHaveBeenCalledTimes(1); // the real dialog WAS opened — untouched passthrough
    expect(sawSelect).toBe("SHOULD-NOT-BE-CALLED");
  });
});

describe("truncation and window lifecycle (§4.9 point 7/8)", () => {
  it("a single entry over 8 KiB is clipped at a UTF-8-safe boundary with a trailing ellipsis", async () => {
    const api = fakeApi();
    const engine = createCommandCaptureEngine();
    const pi = wrapCommandApi(api, () => engine);
    const big = "é".repeat(5000); // 2 bytes each in UTF-8 ⇒ 10000 bytes, over the 8 KiB budget
    pi.registerCommand("mycmd", {
      handler: async (_args, ctx) => {
        ctx.ui.notify(big);
      },
    } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
    const ctx = fakeCtx(
      fakeUi({ notify: [], setWidget: [], setStatus: [], setEditorText: [], pasteToEditor: [], setTitle: [] }),
    );
    const inv = invocationOf();
    engine.arm(inv);
    await api.commands.get("mycmd")?.handler(inv.args, ctx);
    const entry = engine.outputFor(inv.cmdId)?.entries[0];
    expect(entry?.clipped).toBe(true);
    expect(entry?.text.endsWith("\u2026")).toBe(true);
    expect(Buffer.byteLength(entry?.text ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    // No mangled replacement characters from an unsafe multi-byte cut.
    expect(entry?.text).not.toContain("\uFFFD");
  });

  it("ANSI escape sequences and stray control bytes are stripped, \\n and \\t survive", () => {
    const engine = createCommandCaptureEngine();
    const inv = invocationOf();
    engine.arm(inv);
    engine.take(inv.name, inv.args);
    engine.collectFor(inv.cmdId, {
      kind: "notify",
      text: "\x1b[31mred\x1b[0m line1\nline2\ttabbed\x07bell",
    });
    expect(engine.outputFor(inv.cmdId)?.entries[0]?.text).toBe("red line1\nline2\ttabbedbell");
  });

  it("title/key are clamped to 200/64 characters respectively", () => {
    const engine = createCommandCaptureEngine();
    const inv = invocationOf();
    engine.arm(inv);
    engine.take(inv.name, inv.args);
    engine.collectFor(inv.cmdId, { kind: "widget", key: "k".repeat(100), title: "t".repeat(300), text: "x" });
    const entry = engine.outputFor(inv.cmdId)?.entries[0];
    expect(entry?.key).toHaveLength(64);
    expect(entry?.title).toHaveLength(200);
  });

  it("more than 64 entries: the front 64 are kept, the rest silently dropped and tallied", () => {
    const engine = createCommandCaptureEngine();
    const inv = invocationOf();
    engine.arm(inv);
    engine.take(inv.name, inv.args);
    for (let i = 0; i < 70; i++) engine.collectFor(inv.cmdId, { kind: "notify", text: `entry-${i}` });
    const out = engine.outputFor(inv.cmdId);
    expect(out?.entries).toHaveLength(64);
    expect(out?.entries[0]?.text).toBe("entry-0");
    expect(out?.entries[63]?.text).toBe("entry-63");
    expect(out?.truncated).toEqual({ droppedEntries: 6, droppedBytes: 6 * Buffer.byteLength("entry-69", "utf8") });
  });

  it("cumulative text over 32 KiB drops subsequent entries once the budget is exhausted", () => {
    const engine = createCommandCaptureEngine();
    const inv = invocationOf();
    engine.arm(inv);
    engine.take(inv.name, inv.args);
    const chunk = "x".repeat(4000); // 4000 bytes; 8 of these = 32000 bytes, just under 32 KiB
    for (let i = 0; i < 9; i++) engine.collectFor(inv.cmdId, { kind: "notify", text: chunk });
    const out = engine.outputFor(inv.cmdId);
    expect(out?.entries).toHaveLength(8);
    expect(out?.truncated).toEqual({ droppedEntries: 1, droppedBytes: 4000 });
  });

  it("needsTerminal is set as soon as any interactive entry is collected, even if that entry itself later gets dropped by truncation", () => {
    const engine = createCommandCaptureEngine();
    const inv = invocationOf();
    engine.arm(inv);
    engine.take(inv.name, inv.args);
    for (let i = 0; i < 64; i++) engine.collectFor(inv.cmdId, { kind: "notify", text: `entry-${i}` });
    engine.collectFor(inv.cmdId, { kind: "interactive", text: "select" }); // budget already exhausted
    const out = engine.outputFor(inv.cmdId);
    expect(out?.needsTerminal).toBe(true);
    expect(out?.truncated?.droppedEntries).toBe(1);
  });

  it("the 30s hard window cap stops further collection but real ui calls keep forwarding", async () => {
    vi.useFakeTimers();
    try {
      const recorder: UiRecorder = {
        notify: [],
        setWidget: [],
        setStatus: [],
        setEditorText: [],
        pasteToEditor: [],
        setTitle: [],
      };
      const api = fakeApi();
      const engine = createCommandCaptureEngine();
      const pi = wrapCommandApi(api, () => engine);
      let resolveHandler: (() => void) | undefined;
      pi.registerCommand("mycmd", {
        handler: (_args: string, ctx: ExtensionCommandContext) =>
          new Promise<void>((resolve) => {
            resolveHandler = () => {
              ctx.ui.notify("after timeout");
              resolve();
            };
          }),
      } as unknown as Omit<RegisteredCommand, "name" | "sourceInfo">);
      const ctx = fakeCtx(fakeUi(recorder));
      const inv = invocationOf();
      engine.arm(inv);
      const pending = api.commands.get("mycmd")?.handler(inv.args, ctx);
      vi.advanceTimersByTime(30_001); // window's hard cap fires while the handler is still running
      resolveHandler?.();
      await pending;
      // Real terminal notify still happened...
      expect(recorder.notify).toEqual([{ message: "after timeout" }]);
      // ...but it was not collected, since the window had already closed.
      expect(engine.outputFor(inv.cmdId)?.entries).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
