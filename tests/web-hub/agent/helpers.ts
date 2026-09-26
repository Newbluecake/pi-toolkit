/**
 * Test helpers for package D (agent-client): a fake hub on a real unix socket,
 * a scriptable fake socket for fake-timer state-machine tests, fake pi / ctx.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeAgentFrame, type AgentFrame, type HubFrame } from "../../../src/web-hub/protocol/messages.js";
import { encodeFrame, NdjsonDecoder } from "../../../src/web-hub/protocol/ndjson.js";
import type { HubPaths } from "../../../src/web-hub/protocol/paths.js";
import type { WebHubSettings } from "../../../src/web-hub/agent/index.js";
import { testHubPaths } from "../helpers/paths.js";

export const CONN_KEY = Symbol.for("pi-subagent:web-hub");
export const AGENT_ID_KEY = Symbol.for("pi-subagent:web-hub:agent-id");

export function tmpDir(prefix = "wh-d-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function pathsIn(dir: string): HubPaths {
  return testHubPaths(dir);
}

export const SETTINGS: WebHubSettings = {
  enabled: true,
  autoStart: false,
  port: 0,
  idleExitMinutes: 10,
  nodeLoader: "",
};

/** Close whatever connection a test left in the process global. */
export function resetGlobals(): void {
  const g = globalThis as Record<symbol, unknown>;
  const c = g[CONN_KEY] as { close?: (r: string) => void } | undefined;
  try {
    c?.close?.("test-teardown");
  } catch {
    /* ignore */
  }
  delete g[CONN_KEY];
}

export function ackFrame(agentKey = "a1-abcdef", port = 4242, caps?: string[]): HubFrame {
  const base: HubFrame = {
    t: "hello_ack",
    hubVersion: "9.9.9",
    buildId: "hub-build",
    proto: { major: 1, minor: 0 },
    agentKey,
    pingMs: 10_000,
    leaseMs: 30_000,
    http: { port },
  };
  return caps === undefined ? base : { ...base, caps };
}

export async function waitUntil(pred: () => boolean, ms = 3_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ------------------------------------------------------------------ fake hub

export interface HubConn {
  socket: Socket;
  frames: AgentFrame[];
}

export interface FakeHub {
  server: Server;
  conns: HubConn[];
  /** All decoded frames from all connections, in arrival order. */
  all(): AgentFrame[];
  send(conn: HubConn, frame: HubFrame): void;
  close(): Promise<void>;
}

export async function startFakeHub(
  socketPath: string,
  opts: { autoAck?: boolean; pauseAfterAck?: boolean } = {},
): Promise<FakeHub> {
  const conns: HubConn[] = [];
  const arrival: AgentFrame[] = [];
  const server = createServer((socket) => {
    const conn: HubConn = { socket, frames: [] };
    conns.push(conn);
    const decoder = new NdjsonDecoder({
      onFrame: (raw) => {
        const f = decodeAgentFrame(raw);
        if (f === undefined) return;
        conn.frames.push(f);
        arrival.push(f);
        if (f.t === "hello" && opts.autoAck !== false) {
          socket.write(encodeFrame(ackFrame(`a${f.agentId.pid}-${f.agentId.nonce.slice(0, 6)}`)));
          if (opts.pauseAfterAck === true) socket.pause();
        }
      },
      onError: () => undefined,
    });
    socket.on("data", (c) => decoder.push(c));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    server,
    conns,
    all: () => arrival.slice(),
    send: (conn, frame) => {
      conn.socket.write(encodeFrame(frame));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of conns) c.socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// --------------------------------------------------------------- fake socket

/** Scriptable stand-in for net.Socket (no I/O): tests emit connect/data/error/close. */
export class FakeSocket extends EventEmitter {
  written: string[] = [];
  writableLength = 0;
  unrefCalls = 0;
  destroyed = false;
  ended = false;
  unref(): this {
    this.unrefCalls += 1;
    return this;
  }
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): this {
    this.ended = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  frames(): Array<Record<string, unknown>> {
    return this.written
      .join("")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  types(): string[] {
    return this.frames().map((f) => String(f.t));
  }
  hub(frame: HubFrame): void {
    this.emit("data", Buffer.from(encodeFrame(frame)));
  }
  fail(code: string): void {
    const err = Object.assign(new Error(code), { code });
    this.emit("error", err);
    this.emit("close");
  }
}

export function fakeNet(): {
  netConnect: typeof import("node:net").connect;
  sockets: FakeSocket[];
  calls: () => number;
} {
  const sockets: FakeSocket[] = [];
  const netConnect = ((..._args: unknown[]) => {
    const s = new FakeSocket();
    sockets.push(s);
    return s as unknown as Socket;
  }) as unknown as typeof import("node:net").connect;
  return { netConnect, sockets, calls: () => sockets.length };
}

// ----------------------------------------------------------------- fake pi

type Handler = (event: unknown, ctx: unknown) => unknown;

export function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  fire: (ev: string, event: unknown, ctx: unknown) => void;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
  };
  const fire = (ev: string, event: unknown, ctx: unknown): void => {
    for (const h of handlers.get(ev) ?? []) h(event, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, fire };
}

export interface FakeCtxState {
  mode: "tui" | "rpc" | "print" | "json";
  leaf: string | null;
  branch: unknown[];
  sessionFile?: string;
  sessionId: string;
  idle: boolean;
  statusCalls: Array<[string, string | undefined]>;
  hasUI?: boolean;
  uiInput?: (title: string, placeholder?: string) => Promise<string | undefined>;
  uiCustom?: (factory: unknown) => Promise<unknown>;
}

export function fakeCtx(init: Partial<FakeCtxState> = {}): { ctx: ExtensionContext; state: FakeCtxState } {
  const state: FakeCtxState = {
    mode: "tui",
    leaf: "e1",
    branch: [],
    sessionFile: "/tmp/fake-session.jsonl",
    sessionId: "sess-1",
    idle: true,
    statusCalls: [],
    ...init,
  };
  const ctx = {
    get mode() {
      return state.mode;
    },
    get hasUI() {
      return state.hasUI ?? true;
    },
    cwd: "/tmp/wa",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        state.statusCalls.push([key, text]);
      },
      input: (title: string, placeholder?: string) =>
        state.uiInput !== undefined ? state.uiInput(title, placeholder) : Promise.resolve(undefined),
      custom: (factory: unknown) =>
        state.uiCustom !== undefined ? state.uiCustom(factory) : Promise.reject(new Error("ui.custom not mocked")),
    },
    sessionManager: {
      getLeafId: () => state.leaf,
      getBranch: () => state.branch,
      getSessionFile: () => state.sessionFile,
      getSessionId: () => state.sessionId,
      getSessionName: () => undefined,
    },
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
  };
  return { ctx: ctx as unknown as ExtensionContext, state };
}
