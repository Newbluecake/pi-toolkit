import { describe, expect, it } from "vitest";
import factory from "../../src/ask-user/index.js";
import { AskUserComponent } from "../../src/ask-user/component.js";
import { mockTui, stubTheme } from "./fixtures.js";
import { createDialogRace, type AskUserRemoteSession, type RemoteOutcome } from "../../src/ask-user/remote.js";

const params = { questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }] };
type Tool = { execute: (...args: any[]) => Promise<any> };

class FakeSession implements AskUserRemoteSession {
  readonly request: unknown;
  private callback?: (outcome: RemoteOutcome) => boolean;
  closed?: [string, string];
  constructor(request: unknown) {
    this.request = request;
  }
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

function harness() {
  let tool: Tool | undefined;
  let session: FakeSession | undefined;
  const pi = {
    events: { emit: () => undefined },
    registerTool(definition: Tool) {
      tool = definition;
    },
    getAllTools: () => [{ name: "ask_user" }],
    setActiveTools: () => undefined,
  };
  const port = {
    open: (request: unknown) => {
      session = new FakeSession(request);
      return session;
    },
  };
  factory(pi as never, { remote: () => port });
  if (tool === undefined) throw new Error("tool not registered");
  return {
    tool,
    get session() {
      return session;
    },
  };
}

function tuiContext(onCreate: (component: AskUserComponent) => void) {
  return {
    mode: "tui" as const,
    hasUI: true,
    ui: {
      custom: async <T>(make: (...args: any[]) => any): Promise<T> =>
        new Promise<T>((resolve) => onCreate(make(mockTui, stubTheme, {}, resolve) as AskUserComponent)),
    },
  };
}

describe("ask_user remote race", () => {
  it("lets a web answer close a component that has already been created", async () => {
    const h = harness();
    const pending = h.tool.execute(
      "call",
      params,
      undefined,
      undefined,
      tuiContext(() => undefined),
    );
    await Promise.resolve();
    expect(h.session!.fire({ kind: "answer", answers: { Q: "A" }, origin: "web" })).toBe(true);
    const result = await pending;
    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers.Q.selected).toEqual(["A"]);
  });

  it("does not let a late web answer steal a TUI answer", async () => {
    const h = harness();
    let component: AskUserComponent | undefined;
    const pending = h.tool.execute(
      "call",
      params,
      undefined,
      undefined,
      tuiContext((value) => {
        component = value;
      }),
    );
    await Promise.resolve();
    component!.handleInput("\r");
    expect(h.session!.fire({ kind: "answer", answers: { Q: "B" }, origin: "web" })).toBe(false);
    const result = await pending;
    expect(result.details.answers.Q.selected).toEqual(["A"]);
  });

  it("uses the same decoding path in RPC mode", async () => {
    const h = harness();
    let resolveSelect!: (value: string | undefined) => void;
    const pending = h.tool.execute("call", params, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
      ui: {
        select: async () =>
          new Promise<string | undefined>((resolve) => {
            resolveSelect = resolve;
          }),
      },
    });
    await Promise.resolve();
    expect(h.session!.fire({ kind: "answer", answers: { Q: "B" }, origin: "web" })).toBe(true);
    resolveSelect(undefined);
    const result = await pending;
    expect(result.details.answers.Q.selected).toEqual(["B"]);
  });

  it("claims synchronously and only once", () => {
    const race = createDialogRace();
    expect(race.claim("web")).toBe(true);
    expect(race.claim("tui")).toBe(false);
    expect(race.winner).toBe("web");
  });
});
