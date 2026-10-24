/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * scheduled-reports I1 — shared harness: a REAL `activate()` on a fake pi under a throwaway $HOME.
 * The fake pi records tools / commands / handlers; `sendMessage` mimics pi's persistence for the
 * custom messages the schedule feature proves through the session file (idle quiet messages are
 * appended immediately — C-S1 pins that fact against real pi).
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HOST_KEY = Symbol.for("pi-subagent:host");
export const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
export const HOST_CAP_KEY = Symbol.for("pi-subagent:xs-host-cap");
export const RUN_REGISTRY_KEY = Symbol.for("pi-subagent:sched-run");
export const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";

export type Handler = (event: any, ctx: any) => any;

export interface SentMessage {
  message: any;
  options: any;
}

export interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: Map<string, any>;
  tools: Map<string, any>;
  toolOrder: string[];
  commandOrder: string[];
  sent: SentMessage[];
  /** Session jsonl the fake persists custom messages into (set by `bindSessionFile`). */
  sessionFile: { path?: string };
}

export function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const toolOrder: string[] = [];
  const commandOrder: string[] = [];
  const sent: SentMessage[] = [];
  const sessionFile: { path?: string } = {};
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) {
        tools.set(tool.name, tool);
        toolOrder.push(tool.name);
      }
    },
    registerCommand(name: string, cmd: unknown) {
      if (!commands.has(name)) commandOrder.push(name);
      commands.set(name, cmd);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
      // pi appends an idle / quiet custom message BEFORE its message_start (C-S1); the proofs read the file.
      if (
        sessionFile.path !== undefined &&
        options?.triggerTurn !== true &&
        message?.customType === "subagent:schedule"
      )
        appendFileSync(
          sessionFile.path,
          JSON.stringify({ type: "custom_message", customType: message.customType, details: message.details }) + "\n",
        );
    },
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    commands,
    tools,
    toolOrder,
    commandOrder,
    sent,
    sessionFile,
  };
}

/** Persist a triggerTurn message the way pi does once its run starts (message_end). */
export function persistWake(h: FakePi, message: any): void {
  if (h.sessionFile.path === undefined) return;
  appendFileSync(
    h.sessionFile.path,
    JSON.stringify({ type: "custom_message", customType: message.customType, details: message.details }) + "\n",
  );
}

export interface Sandbox {
  home: string;
  settingsPath: string;
  writeSettings(raw: unknown): void;
  cleanup(): void;
}

export function sandbox(prefix = "pi-sched-i1-"): Sandbox {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  const settingsPath = join(home, ".pi", "agent", "pi-subagent.json");
  return {
    home,
    settingsPath,
    writeSettings(raw) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    },
    cleanup() {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function resetGlobals(): void {
  const g = globalThis as Record<symbol, unknown>;
  delete g[HOST_KEY];
  delete g[FEISHU_HOST_KEY];
  delete g[HOST_CAP_KEY];
  delete g[RUN_REGISTRY_KEY];
}

/** Everything unrelated to the feature off, so the fake ctx stays small. */
export const BASELINE = {
  webHub: { enabled: false },
  memory: { enabled: false },
  hud: { enabled: false },
  sessionNav: { enabled: false },
  askUser: { enabled: false },
  feishuNotify: { enabled: false },
  webSearch: { enabled: false },
  todo: { enabled: false },
};

export interface FakeCtx {
  ctx: any;
  statuses: Array<[string, string | undefined]>;
  notices: string[];
  aborts: { n: number };
  state: { idle: boolean; confirm: boolean };
}

export function fakeCtx(home: string, over: { sid?: string; file?: string; mode?: string } = {}): FakeCtx {
  const statuses: Array<[string, string | undefined]> = [];
  const notices: string[] = [];
  const aborts = { n: 0 };
  const state = { idle: true, confirm: true };
  const file = over.file ?? join(home, "s.jsonl");
  const sid = over.sid ?? SID;
  const ctx = {
    mode: over.mode ?? "rpc",
    hasUI: false,
    cwd: home,
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    abort: () => void aborts.n++,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => sid,
      getSessionFile: () => file,
      getSessionDir: () => home,
    },
    modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
    ui: {
      setWidget: () => undefined,
      setStatus: (k: string, v: string | undefined) => void statuses.push([k, v]),
      notify: (m: string) => void notices.push(m),
      confirm: async () => state.confirm,
      input: async () => undefined,
    },
  };
  return { ctx, statuses, notices, aborts, state };
}

export async function emit(h: FakePi, event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const fn of h.handlers.get(event) ?? []) out.push(await fn(payload, ctx));
  return out;
}

/** Fold the system prompt through every `before_agent_start` handler, like pi does. */
export async function systemPromptFor(h: FakePi, ctx: unknown, base = "BASE"): Promise<string> {
  let prompt = base;
  for (const fn of h.handlers.get("before_agent_start") ?? []) {
    const r = await fn(
      { type: "before_agent_start", prompt: "go", systemPrompt: prompt, systemPromptOptions: {} },
      ctx,
    );
    if (r?.systemPrompt !== undefined) prompt = r.systemPrompt;
  }
  return prompt;
}

/** union-shaped user trigger (pi ≥ 1.2): observed by the dispatcher's capability gate. */
export const userTrigger = (prompt = "hello") => ({
  type: "before_agent_start",
  messageType: "user",
  prompt,
  systemPrompt: "",
});
/** union-shaped custom trigger carrying our message (what pi emits for `sendMessage({triggerTurn:true})`). */
export const wakeEvent = (details: unknown) => ({
  type: "before_agent_start",
  messageType: "custom",
  message: { customType: "subagent:schedule", details },
});
