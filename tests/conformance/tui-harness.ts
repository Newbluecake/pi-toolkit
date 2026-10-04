/**
 * S0-A harness (ask-user-async plan §2.1): in-process conformance harness that drives the REAL
 * `InteractiveMode` against a fake `Terminal`, so `showExtensionCustom`'s close path
 * (restoreEditor / dispose / microtask mount gap) is exercised byte-for-byte as in production —
 * the thing review #1 demanded (no fake `ui.custom` for C1–C5).
 *
 * Pieces:
 *  - `FakeTerminal implements Terminal` — records everything written; `type()` synchronously feeds
 *    the saved input callback (the exact path a physical keystroke takes); `screen()` parses the
 *    last FULL frame out of the raw output stream (TuiMainScreen emits full frames bracketed by
 *    `\x1b[?2026h` … `\x1b[?2026l` after `renderNow(true)` resets the render state).
 *  - a scripted fake model runtime (same pattern as `pi-boundary.test.ts:15-60`) so model turns
 *    are deterministic tool calls / text, and every LLM request's message list is capturable.
 *  - `createTuiHarness()` builds the real `AgentSessionRuntime` + `InteractiveMode`, runs
 *    `await mode.init()` (NOT `run()`), and lets extensions bind through the REAL interactive
 *    uiContext — so a probe extension's `ctx.ui.custom` is the genuine `showExtensionCustom`.
 *
 * Hermeticity: temp cwd + temp agent dir, `PI_CODING_AGENT_DIR` pointed at it (getAgentDir() is
 * env-read per call, config.js:421), `PI_OFFLINE=1` so `ensureTool("fd"/"rg")` never downloads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSessionRuntime,
  DefaultResourceLoader,
  InteractiveMode,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Terminal } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// FakeTerminal
// ---------------------------------------------------------------------------

const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const APC = /\x1b_[^\x07]*\x07/g; // incl. pi-tui's CURSOR_MARKER

export function stripAnsi(text: string): string {
  return text.replace(APC, "").replace(OSC, "").replace(CSI, "");
}

/** Fake `Terminal` (pi-tui/dist/terminal.d.ts) with keystroke injection and frame capture. */
export class FakeTerminal implements Terminal {
  private inputCb: ((data: string) => void) | undefined;
  private resizeCb: (() => void) | undefined;
  private output = "";
  private _columns: number;
  private _rows: number;
  /** Every keystroke fed through `type()`, for input-routing assertions. */
  readonly typed: string[] = [];

  constructor(columns = 100, rows = 30) {
    this._columns = columns;
    this._rows = rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputCb = onInput;
    this.resizeCb = onResize;
  }
  stop(): void {
    this.inputCb = undefined;
    this.resizeCb = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  get columns(): number {
    return this._columns;
  }
  get rows(): number {
    return this._rows;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {
    this.output = "";
  }
  setTitle(): void {}
  setProgress(): void {}

  /** Feed a keystroke exactly like the OS would (synchronous input callback). */
  type(data: string): void {
    this.typed.push(data);
    this.inputCb?.(data);
  }
  resize(columns: number, rows: number): void {
    this._columns = columns;
    this._rows = rows;
    this.resizeCb?.();
  }

  raw(): string {
    return this.output;
  }

  /**
   * Visible lines of the last FULL frame. Call `renderFullFrame()` first: full frames are
   * bracketed by synchronized-output markers; everything between them is every rendered line
   * joined by `\r\n` (TuiMainScreen fullRender), so no cursor tracking is needed.
   */
  screen(): string[] {
    const begin = this.output.lastIndexOf("\x1b[?2026h");
    if (begin < 0) return [];
    let frame = this.output.slice(begin + "\x1b[?2026h".length);
    const end = frame.indexOf("\x1b[?2026l");
    if (end >= 0) frame = frame.slice(0, end);
    return frame
      .split("\r\n")
      .map((line) => stripAnsi(line).replace(/[ \t]+$/, ""))
      .filter((line, i, all) => !(line === "" && i === all.length - 1));
  }
}

// ---------------------------------------------------------------------------
// Scripted fake model (pattern lifted from tests/conformance/pi-boundary.test.ts:15-60)
// ---------------------------------------------------------------------------

export interface ScriptedTurn {
  toolCall: boolean;
  build: (model: FakeModel) => unknown;
  /** Hold this model call until the promise resolves (deterministic multi-turn orchestration). */
  gate?: Promise<void>;
}

export interface FakeModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number };
  contextWindow: number;
  maxTokens: number;
  baseUrl: string;
}

export function fakeModel(): FakeModel {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "anthropic-messages",
    provider: "fake-provider",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}

export interface FakeModelRuntime {
  streamSimple: (model: unknown, context: { messages?: unknown[] }) => unknown;
  requestMessages: unknown[][];
  requestSizes: number[];
  callCount: () => number;
}

export function fakeModelRuntime(
  model: FakeModel,
  scripted: ScriptedTurn[],
): FakeModelRuntime & Record<string, unknown> {
  let call = 0;
  const requestSizes: number[] = [];
  const requestMessages: unknown[][] = [];
  return {
    streamSimple: (_m: unknown, context: { messages?: unknown[] }) => {
      requestSizes.push(context.messages?.length ?? 0);
      requestMessages.push(context.messages ?? []);
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const finish = () => {
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: turn.toolCall ? "toolUse" : "stop",
          message: turn.build(model),
        } as never);
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
    requestSizes,
    requestMessages,
  };
}

/** pi-tui usage shape the interactive footer sums (usage.cost.total) — richer than
 *  pi-boundary.test.ts's bare fake because the REAL FooterComponent renders in this harness. */
const FAKE_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistantTextMsg(model: FakeModel, text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...FAKE_USAGE, cost: { ...FAKE_USAGE.cost } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function assistantToolCallMsg(
  model: FakeModel,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...FAKE_USAGE, cost: { ...FAKE_USAGE.cost } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

/** Convenience scripted turn: call a named tool with args. */
export function toolTurn(
  name: string,
  args: Record<string, unknown>,
  id = `tc-${name}-${Math.random().toString(36).slice(2, 8)}`,
): ScriptedTurn {
  return { toolCall: true, build: (m) => assistantToolCallMsg(m, id, name, args) };
}

export function textTurn(text: string): ScriptedTurn {
  return { toolCall: false, build: (m) => assistantTextMsg(m, text) };
}

// ---------------------------------------------------------------------------
// TUI harness
// ---------------------------------------------------------------------------

export interface TuiHarness {
  mode: InteractiveMode;
  session: AgentSession;
  terminal: FakeTerminal;
  modelRuntime: FakeModelRuntime;
  cwd: string;
  /** Force a FULL frame render and return its visible lines. */
  renderFullFrame(): string[];
  dispose(): Promise<void>;
}

export async function createTuiHarness(opts: {
  scripted: ScriptedTurn[];
  extensionFactories?: unknown[];
}): Promise<TuiHarness> {
  const cwd = mkdtempSync(join(tmpdir(), "ask-user-tui-harness-"));
  const agentDir = join(cwd, ".pi-agent");
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);

  const prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  const prevOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() reads env per call (config.js:421)
  process.env.PI_OFFLINE = "1"; // ensureTool("fd"/"rg") must never download inside init()

  let mode: InteractiveMode | undefined;
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: (opts.extensionFactories ?? []) as never,
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
    });
    // Hand-rolled AgentSessionServices (createAgentSessionServices would spin up a REAL
    // ModelRuntime); the runtime factory is only used for /new /resume /fork, which the
    // harness never triggers.
    const services = {
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      diagnostics: [],
    } as unknown as AgentSessionServices;
    const runtime = new AgentSessionRuntime(session, services, (async () => {
      throw new Error("tui-harness: session replacement is not supported");
    }) as never);

    const terminal = new FakeTerminal();
    mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular" });
    await mode.init(); // mounts the real TUI, binds extensions through the real interactive uiContext

    return {
      mode,
      session,
      terminal,
      modelRuntime,
      cwd,
      renderFullFrame: () => {
        // `ui` is private on InteractiveMode; the harness deliberately reaches the renderer to
        // force a FULL frame (renderNow(true) -> resetRenderState -> fullRender).
        const ui = (mode as unknown as { ui: { renderNow(force?: boolean): void } }).ui;
        ui.renderNow(true);
        return terminal.screen();
      },
      dispose: async () => {
        try {
          mode?.stop();
        } finally {
          session.dispose();
          if (prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
          if (prevOffline === undefined) delete process.env.PI_OFFLINE;
          else process.env.PI_OFFLINE = prevOffline;
          rmSync(cwd, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      mode?.stop();
    } catch {
      /* best effort */
    }
    if (prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
    if (prevOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = prevOffline;
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}
