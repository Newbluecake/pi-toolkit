/**
 * P1 shared test harness (plan §10: "fake port + fake clock, harness 同 remote-race.test.ts").
 * Drives the REAL registered ask_user tool with a fake background-completion port and a
 * manual clock; only pi registration / the ui.custom boundary / session hooks are mocked.
 */
import factory from "../../src/ask-user/index.js";
import type {
  AskUserBackgroundPort,
  BackgroundCompletion,
  BackgroundCompletionKind,
} from "../../src/ask-user/background.js";
import { AskUserComponent } from "../../src/ask-user/component.js";
import type { Clock } from "../../src/ask-user/interrupt.js";
import type { AskUserRemoteSession, RemoteOutcome } from "../../src/ask-user/remote.js";
import { mockTui, stubTheme } from "./fixtures.js";

export const PARAMS = { questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }] };

export const PARAMS2 = { questions: [{ question: "Q2", options: [{ label: "C" }, { label: "D" }] }] };

export type Tool = { execute: (...args: any[]) => Promise<any>; renderResult: (...args: any[]) => any };

export class FakeClock implements Clock {
  t = 0;
  readonly timers: { at: number; fn: () => void }[] = [];
  now(): number {
    return this.t;
  }
  schedule(fn: () => void, delayMs: number): unknown {
    const handle = { at: this.t + delayMs, fn };
    this.timers.push(handle);
    return handle;
  }
  cancel(handle: unknown): void {
    const index = this.timers.indexOf(handle as never);
    if (index >= 0) this.timers.splice(index, 1);
  }
  /** Advance, firing timers in time order (a timer may reschedule into the same advance). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.timers.splice(this.timers.indexOf(next), 1);
      this.t = next.at;
      next.fn();
    }
    this.t = target;
  }
  get pending(): number {
    return this.timers.length;
  }
}

export class FakePort implements AskUserBackgroundPort {
  readonly listeners = new Set<(event: BackgroundCompletion) => void>();
  tokens = 0;
  disabled = false;
  private seq = 0;
  subscribe(listener: (event: BackgroundCompletion) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  pendingTokens(): number {
    return this.tokens;
  }
  tokenState(): "pending" | "consumed" | "orphaned" | undefined {
    return undefined;
  }
  fire(kind: BackgroundCompletionKind = "subagent", count = 1): void {
    this.seq += 1;
    const event: BackgroundCompletion = { kind, count, token: this.seq, at: 0 };
    for (const listener of [...this.listeners]) listener(event);
  }
}

export class FakeSession implements AskUserRemoteSession {
  private callback?: (outcome: RemoteOutcome) => boolean;
  closed?: [string, string];
  setOnRemote(callback: (outcome: RemoteOutcome) => boolean): void {
    this.callback = callback;
  }
  close(by: "tui" | "abort" | "error", outcome: "answered" | "cancelled" | "aborted"): void {
    this.closed = [by, outcome];
  }
  fire(outcome: RemoteOutcome): boolean {
    return this.callback?.(outcome) ?? false;
  }
}

export interface BgHarness {
  tool: Tool;
  port: FakePort;
  clock: FakeClock;
  emitted: string[];
  appended: { customType: string; data: unknown }[];
  sent: { message: any; options: any }[];
  handlers: Map<string, ((event: any, ctx: any) => unknown)[]>;
  readonly session: FakeSession | undefined;
  readonly active: string[] | undefined;
  /** Fire a registered pi event handler with a fake event/ctx. */
  trigger(name: string, event?: unknown, ctx?: unknown): void;
}

export function createBgHarness(rawSettings: unknown = {}): BgHarness {
  let tool: Tool | undefined;
  let session: FakeSession | undefined;
  let active: string[] | undefined;
  const emitted: string[] = [];
  const appended: BgHarness["appended"] = [];
  const sent: BgHarness["sent"] = [];
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const port = new FakePort();
  const clock = new FakeClock();
  const pi = {
    events: { emit: (name: string) => emitted.push(name) },
    registerTool(definition: Tool) {
      tool = definition;
    },
    getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
    setActiveTools(names: string[]) {
      active = names;
    },
    on(name: string, fn: (event: any, ctx: any) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  };
  const remote = {
    open: () => {
      session = new FakeSession();
      return session;
    },
  };
  factory(pi as never, { background: () => port, interrupt: () => rawSettings, clock, remote: () => remote });
  if (tool === undefined) throw new Error("tool not registered");
  return {
    tool,
    port,
    clock,
    emitted,
    appended,
    sent,
    handlers,
    get session() {
      return session;
    },
    get active() {
      return active;
    },
    trigger(name, event = {}, ctx = {}) {
      for (const fn of handlers.get(name) ?? []) fn(event, ctx);
    },
  };
}

/** ui.custom boundary capturing the created component(s); resolves when done() fires. */
export function tuiContext(onCreate?: (component: AskUserComponent) => void, onDone?: () => void) {
  const created: AskUserComponent[] = [];
  let customCalls = 0;
  const ctx = {
    mode: "tui" as const,
    hasUI: true,
    ui: {
      custom: async <T>(make: (...args: any[]) => any): Promise<T> =>
        new Promise<T>((resolve) => {
          customCalls += 1;
          const component = make(mockTui, stubTheme, {}, (value: T) => {
            onDone?.();
            resolve(value);
          }) as AskUserComponent;
          created.push(component);
          onCreate?.(component);
        }),
    },
  };
  return {
    ctx,
    created,
    get customCalls() {
      return customCalls;
    },
  };
}

export function renderText(component: { render(width: number): string[] }, width = 100): string {
  return component.render(width).join("\n");
}

/** Flush pending microtasks (lets resolved promises run their continuations). */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
