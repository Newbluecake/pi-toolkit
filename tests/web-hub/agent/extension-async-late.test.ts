/**
 * fix (2026-10-22) — end-to-end repro for the "此命令的输出只在终端显示。" bug on pi-toolkit's
 * own async commands (e.g. `/fabric status`, whose handler awaits `hubInfo()` BEFORE its
 * `ctx.ui.notify`): the REAL stack pieces (`createCommandCaptureEngine` + `wrapCommandApi` +
 * `createBuiltinBridge` + `createCommandHandler` + the real ledger) wired together exactly like
 * `src/web-hub/agent/index.ts` wires them, driven through a fake pi whose `sendUserMessage`
 * synchronously dispatches the registered command (pi's idle path, §4.9 K20).
 *
 * Before the fix: `dispatchExtension` answered `completion:"unknown"` at bridge-return (the
 * window was still empty — the handler was awaiting) and NOTHING ever upgraded the ledger, so
 * the browser's one-shot queryOnly saw `captured:true` with no output — and DetailDock's query
 * handler read `captured` off the query WRAPPER, degrading to `captured:false` ⇒ the
 * terminal-only note. These tests pin the fixed contract:
 *   - `completion:"async"` while the capture window is open, the ledger entry staying `running`
 *     (so the browser's pendingCtl item survives the ctl-slot republish until `cmd_late`);
 *   - the window's finish (handler Promise settle OR the CAPTURE_MAX_MS settle-anyway expiry OR
 *     the session-boundary dispose) upgrading the ledger via sendLate/handleBridgeLate with the
 *     FULL collected output, queryable afterwards with `captured:true`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import {
  createCommandCaptureEngine,
  wrapCommandApi,
  type CommandCaptureEngine,
} from "../../../src/commands/capture.js";
import { createBuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import { parseSlashCommand } from "../../../src/web-hub/agent/slash.js";
import type {
  CmdFrame,
  CmdLateFrame,
  CmdOrigin,
  CmdResultBody,
  CmdResultFrame,
} from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakeTimerQueue } from "./helpers.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
beforeEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);
afterEach(() => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY]);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

function frame(id: string, name: string, args: string): CmdFrame {
  return {
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: ORIGIN,
    cmd: { op: "command", name, args },
  };
}

/** Fake terminal ui — records notify calls (the captured proxy forwards to it too). */
function fakeUi(): ExtensionUIContext {
  return {
    notify: () => {},
    setWidget: () => {},
    setStatus: () => {},
    editor: async () => undefined,
    select: async () => undefined,
    input: async () => undefined,
    confirm: async () => false,
    custom: async () => undefined,
  } as unknown as ExtensionUIContext;
}

/** The gate the registered handler awaits before its notify — resolved/rejected by the test. */
interface Gate {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function makeGate(): Gate {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface E2EOptions {
  /** The command handler registered through the wrapped pi. Default: await gate → notify. */
  handler?(args: string, ctx: ExtensionCommandContext, gate: Gate): Promise<void>;
  /** `sendLate` unwired (legacy degrade) when false. Default true. */
  sendLate?: boolean;
}

interface E2E {
  engine: CommandCaptureEngine;
  handler: ReturnType<typeof createCommandHandler>;
  sent: Array<CmdResultFrame | CmdLateFrame>;
  gate: Gate;
  ledger: ReturnType<typeof createCommandLedger>;
}

function makeE2E(opts: E2EOptions = {}): E2E {
  const ownedNames = new Set<string>();
  const engine = createCommandCaptureEngine({ ownedNames });
  const registered = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const { ctx } = fakeCtx({ mode: "tui" });
  const commandCtx = { mode: "tui", hasUI: true, ui: fakeUi(), cwd: "/tmp" } as unknown as ExtensionCommandContext;
  const gate = makeGate();
  const defaultHandler = async (args: string, c: ExtensionCommandContext, g: Gate): Promise<void> => {
    await g.promise;
    c.ui.notify(`fabric status ok (${args.trim() === "" ? "status" : args.trim()})`, "info");
  };
  const basePi = {
    getCommands: () => [{ name: "fabric", source: "extension" }],
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      registered.set(name, command);
    },
    sendUserMessage(text: string) {
      // pi's idle path: the registered handler's synchronous prefix runs inside this call stack.
      // A rejected handler is swallowed here exactly like pi's own emitError path — the capture
      // layer has already recorded the error entry and fired finish by then.
      const parsed = parseSlashCommand(text);
      if (parsed === undefined) return;
      const command = registered.get(parsed.name);
      if (command !== undefined) void Promise.resolve(command.handler(parsed.args, commandCtx)).catch(() => undefined);
    },
  };
  const wrappedPi = wrapCommandApi(basePi as unknown as ExtensionAPI, () => engine, ownedNames);
  wrappedPi.registerCommand("fabric", {
    description: "fabric",
    handler: (args: string, c: ExtensionCommandContext) => (opts.handler ?? defaultHandler)(args, c, gate),
  } as Omit<RegisteredCommand, "name" | "sourceInfo">);

  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const ledger = createCommandLedger();
  const timers = fakeTimerQueue();
  const now = () => 1000;
  const deps: CommandHandlerDeps = {
    pi: wrappedPi,
    getCtx: () => ctx,
    getSessionId: () => "sess-1",
    ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
    builtinBridge: undefined as unknown as CommandHandlerDeps["builtinBridge"],
    controlEnabled: () => true,
    now,
    send: (f) => sent.push(f),
    onChanged: () => {},
    setTimer: timers.setTimer,
  };
  const bridge = createBuiltinBridge({
    pi: wrappedPi,
    getCtx: () => ctx,
    getSessionId: () => "sess-1",
    now,
    capture: () => engine,
    ...(opts.sendLate === false
      ? {}
      : {
          sendLate: (f: CmdFrame, result: CmdResultBody) => {
            commandHandler.handleBridgeLate(f, result);
          },
        }),
  });
  deps.builtinBridge = bridge;
  const commandHandler = createCommandHandler(deps);
  return { engine, handler: commandHandler, sent, gate, ledger };
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("web command async-late channel — pi-toolkit command that awaits before its notify", () => {
  it("answers completion:async, keeps the ledger entry running, and the finish upgrades it with the notify entry", async () => {
    const e2e = makeE2E();
    e2e.handler.handle(frame("cmd-1", "fabric", "status"));

    // The HTTP reply went out with completion:async; the ledger entry must STILL be running so
    // the browser's pendingCtl item survives the ctl-slot republish until cmd_late.
    expect(e2e.sent).toHaveLength(1);
    expect(e2e.sent[0]).toMatchObject({
      t: "cmd_result",
      id: "cmd-1",
      ok: true,
      data: { op: "command", kind: "extension", completion: "async", captured: true },
    });
    expect(e2e.ledger.get("cmd-1")).toMatchObject({ state: "running" });

    // The handler's await resolves → notify lands in the window → finish → late upgrade.
    e2e.gate.resolve();
    await flushMicrotasks();

    expect(e2e.sent).toHaveLength(2);
    const late = e2e.sent[1] as CmdLateFrame;
    expect(late).toMatchObject({ t: "cmd_late", id: "cmd-1", op: "command", ok: true });
    expect((late as { data?: { output?: { entries?: unknown[] } } }).data?.output?.entries).toEqual([
      { kind: "notify", text: "fabric status ok (status)", level: "info" },
    ]);

    // The final queryable result carries the notify entry with captured:true — the exact
    // assertion that failed before the fix (the result existed but had no output at all).
    const snap = e2e.ledger.query("cmd-1");
    expect(snap).toMatchObject({ state: "ok", late: true });
    expect(snap?.result).toMatchObject({
      ok: true,
      data: {
        op: "command",
        kind: "extension",
        completion: "sync",
        captured: true,
        output: { entries: [{ kind: "notify", text: "fabric status ok (status)", level: "info" }] },
      },
    });
  });

  it("a handler that rejects after its await still settles late with the collected error entry", async () => {
    const e2e = makeE2E({
      handler: async (_args, c, g) => {
        await g.promise;
        c.ui.notify("before the boom", "info");
        throw new Error("boom");
      },
    });
    e2e.handler.handle(frame("cmd-2", "fabric", ""));
    e2e.gate.resolve();
    await flushMicrotasks();
    const snap = e2e.ledger.query("cmd-2");
    expect(snap?.result).toMatchObject({
      ok: true,
      data: {
        captured: true,
        output: {
          entries: [
            { kind: "notify", text: "before the boom", level: "info" },
            { kind: "error", text: "boom" },
          ],
        },
      },
    });
  });

  it("the CAPTURE_MAX_MS window expiry fires the same late channel (settle-anyway), exactly once", async () => {
    vi.useFakeTimers();
    try {
      const e2e = makeE2E();
      e2e.handler.handle(frame("cmd-3", "fabric", ""));
      expect(e2e.sent[0]).toMatchObject({ data: { completion: "async" } });
      // Handler never settles: the window's own 30s cap is the guarantee.
      vi.advanceTimersByTime(30_000);
      await flushMicrotasks();
      const snap = e2e.ledger.query("cmd-3");
      expect(snap).toMatchObject({ state: "ok", late: true });
      expect(snap?.result).toMatchObject({ ok: true, data: { captured: true } });
      // A very-late handler settle must NOT fire a second late frame.
      e2e.gate.resolve();
      await flushMicrotasks();
      expect(e2e.sent.filter((f) => f.t === "cmd_late")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the session-boundary dispose settles every pending window (timeout reason, collected output kept)", async () => {
    const e2e = makeE2E({
      handler: async (_args, c, g) => {
        c.ui.notify("collected before the boundary", "info");
        await g.promise;
      },
    });
    e2e.handler.handle(frame("cmd-4", "fabric", ""));
    e2e.engine.dispose();
    await flushMicrotasks();
    const snap = e2e.ledger.query("cmd-4");
    expect(snap?.result).toMatchObject({
      ok: true,
      data: {
        captured: true,
        output: { entries: [{ kind: "notify", text: "collected before the boundary", level: "info" }] },
      },
    });
  });

  it("without a sendLate channel the answer degrades to the legacy completion:unknown + immediate settle", () => {
    const e2e = makeE2E({ sendLate: false });
    e2e.handler.handle(frame("cmd-5", "fabric", ""));
    expect(e2e.sent).toHaveLength(1);
    expect(e2e.sent[0]).toMatchObject({
      data: { op: "command", kind: "extension", completion: "unknown", captured: true },
    });
    // Legacy shape: the ledger entry settles ok right away (no running-window promise made).
    expect(e2e.ledger.get("cmd-5")).toMatchObject({ state: "ok" });
  });

  it("(2026-10-22 fabric ruling) a SYNC mutation handler — join/leave/receive/unblock/fence-reset shaped — echoes its output in the immediate reply (completion:sync)", async () => {
    // `/fabric join` etc. have no await before their notify, so the K20 sync path applies: the
    // handler's synchronous prefix runs inside sendUserMessage's call stack and the output is
    // already collected when the bridge returns — the web UI renders it from the first reply,
    // no cmd_late needed.
    const e2e = makeE2E({
      handler: async (args, c) => {
        c.ui.notify(`已加入（epoch 1）。 (${args})`, "info");
      },
    });
    e2e.handler.handle(frame("cmd-6", "fabric", "join"));
    expect(e2e.sent).toHaveLength(1);
    expect(e2e.sent[0]).toMatchObject({
      t: "cmd_result",
      id: "cmd-6",
      ok: true,
      data: {
        op: "command",
        kind: "extension",
        completion: "sync",
        captured: true,
        output: { entries: [{ kind: "notify", text: "已加入（epoch 1）。 (join)", level: "info" }] },
      },
    });
    expect(e2e.ledger.get("cmd-6")).toMatchObject({ state: "ok" });
    await flushMicrotasks();
    expect(e2e.sent).toHaveLength(1); // nothing late — the sync reply was the whole settle
  });
});
