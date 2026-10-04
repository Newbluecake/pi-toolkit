/**
 * P1 regression (plan §10 R1–R4, review #2): the FIFO queue is an approved behavior change,
 * but the single-ask path must stay byte-for-byte identical, and RPC with
 * `backgroundInterrupt.rpc = false` must not gain interrupts or deferrals.
 */
import { describe, expect, it } from "vitest";
import factory from "../../src/ask-user/index.js";
import { ASK_USER_MARKER } from "../../src/ask-user/channel-handler.js";
import { AskUserComponent } from "../../src/ask-user/component.js";
import { mockTui, stubTheme } from "./fixtures.js";
import { PARAMS, PARAMS2, createBgHarness, flush, tuiContext, type Tool } from "./bg-harness.js";

/** Legacy wiring: no background port at all (pre-feature shape). */
function legacyHarness(): { tool: Tool } {
  let tool: Tool | undefined;
  const pi = {
    events: { emit: () => undefined },
    registerTool(definition: Tool) {
      tool = definition;
    },
    getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
    setActiveTools: () => undefined,
  };
  factory(pi as never);
  if (tool === undefined) throw new Error("tool not registered");
  return { tool };
}

describe("R1: single ask_user, no port — byte-identical to baseline", () => {
  it("calls ui.custom in execute's synchronous segment and returns the baseline result", async () => {
    const { tool } = legacyHarness();
    let component: AskUserComponent | undefined;
    let customCalled = false;
    const ctx = {
      mode: "tui" as const,
      hasUI: true,
      ui: {
        custom: async <T>(make: (...args: any[]) => any): Promise<T> =>
          new Promise<T>((resolve) => {
            customCalled = true;
            component = make(mockTui, stubTheme, {}, resolve) as AskUserComponent;
          }),
      },
    };
    const valid = {
      questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
    };
    // NO await between the execute() call and this assertion: ui.custom must already have
    // been invoked (no microtask yield in the fast path).
    const pending = tool.execute("id", valid, undefined, undefined, ctx);
    expect(customCalled).toBe(true);
    component!.handleInput("\r");
    const result = await pending;
    expect(result.details).toEqual({
      questions: valid.questions,
      answers: { "Which DB?": { selected: ["Postgres"], other: null } },
      cancelled: false,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('"Which DB?" = "Postgres"');
  });
});

describe("R2: single ask_user with a port but no completions", () => {
  it("behaves like R1 and leaves no timers or subscriptions behind", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    let customCalled = false;
    const ctx = {
      mode: "tui" as const,
      hasUI: true,
      ui: {
        custom: async <T>(make: (...args: any[]) => any): Promise<T> =>
          new Promise<T>((resolve) => {
            customCalled = true;
            const component = make(mockTui, stubTheme, {}, resolve) as AskUserComponent;
            c.created.push(component);
          }),
      },
    };
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, ctx);
    expect(customCalled).toBe(true);
    c.created[0]!.handleInput("\r");
    const result = await pending;
    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers.Q.selected).toEqual(["A"]);
    expect(result.content[0].text).toBe('"Q" = "A"');
    // Nothing answered from the parked registry, so no snapshot write happened either.
    expect(h.appended).toEqual([]);
    // No leftover timer, no leftover port subscription.
    expect(h.clock.pending).toBe(0);
    expect(h.port.listeners.size).toBe(0);
    // The port was subscribed while the dialog was open and unsubscribed at settle — and no
    // completion ever fired, so the render output kept its legacy shape (no notice line).
  });

  it("did not show a notice line for an undisturbed dialog", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    const baseline = c.created[0]!.render(100).join("\n");
    expect(baseline).not.toContain("bg done");
    c.created[0]!.handleInput("\r");
    await pending;
  });
});

describe("R3: two ask_user calls in one batch (approved behavior change)", () => {
  it("serializes: the second ui.custom fires only after the first settles; both get their own answers", async () => {
    const h = createBgHarness();
    const c1 = tuiContext();
    const c2 = tuiContext();
    const p1 = h.tool.execute("a", PARAMS, undefined, undefined, c1.ctx);
    const p2 = h.tool.execute("b", PARAMS2, undefined, undefined, c2.ctx);
    // The first acquires the mutex synchronously; the second is queued.
    expect(c1.customCalls).toBe(1);
    expect(c2.customCalls).toBe(0);
    c1.created[0]!.handleInput("\r");
    const r1 = await p1;
    await flush();
    // Only NOW is the second dialog presented.
    expect(c2.customCalls).toBe(1);
    c2.created[0]!.handleInput("\r");
    const r2 = await p2;
    expect(r1.details.answers.Q.selected).toEqual(["A"]);
    expect(r2.details.answers.Q2.selected).toEqual(["C"]);
    expect(h.port.listeners.size).toBe(0);
    expect(h.clock.pending).toBe(0);
  });

  it("control: pre-queue concurrent ui.custom dropped the first dialog (documented defect)", async () => {
    // Simulates showExtensionCustom's editorContainer.clear() semantics: a second concurrent
    // custom() call replaces the first component, whose promise then NEVER resolves — the
    // batch could only be escaped with Esc. This is the defect the FIFO queue fixes.
    const resolutions: string[] = [];
    const custom = (tag: string) =>
      new Promise<string>((resolve) => {
        if (tag === "second") {
          // editorContainer.clear(): the first component leaves the tree, nobody resolves it.
          resolve("second-answered");
        }
        // "first" simply never resolves (its component was cleared by the second call).
      });
    const first = custom("first").then((value) => {
      resolutions.push(value);
      return value;
    });
    const second = custom("second").then((value) => {
      resolutions.push(value);
      return value;
    });
    await second;
    await flush();
    expect(resolutions).toEqual(["second-answered"]);
    void first.catch(() => undefined);
  });
});

describe("R4: RPC with backgroundInterrupt.rpc = false (default)", () => {
  it("calls askUserInteract with today's arguments; completions neither interrupt nor defer", async () => {
    const h = createBgHarness(); // rpc defaults to false
    let selectCall: { title: string; options: string[]; opts: unknown } | undefined;
    let resolveSelect!: (value: string | undefined) => void;
    const ctx = {
      mode: "rpc" as const,
      hasUI: true,
      ui: {
        select: async (title: string, options: string[], opts: unknown) => {
          selectCall = { title, options, opts };
          return new Promise<string | undefined>((resolve) => {
            resolveSelect = resolve;
          });
        },
      },
    };
    const pending = h.tool.execute("call", PARAMS, undefined, undefined, ctx);
    await flush();
    // Wire-level arguments unchanged: the marker title, the JSON payload, an opts object.
    expect(selectCall?.title).toBe(ASK_USER_MARKER);
    expect(selectCall?.options).toHaveLength(1);
    const payload = JSON.parse(selectCall!.options[0]!);
    expect(payload.allowCancel).toBe(true);
    expect(payload.questions[0].question).toBe("Q");
    // Pending tokens + live completions: with rpc=false the RPC path ignores both (no
    // deferred check, no interrupt) — it stays on the select exactly like today.
    h.port.tokens = 2;
    h.port.fire();
    h.clock.advance(60_000);
    await flush();
    expect(h.port.listeners.size).toBe(0); // never subscribed
    resolveSelect(JSON.stringify({ Q: "B" }));
    const result = await pending;
    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers.Q.selected).toEqual(["B"]);
    expect(result.content[0].text).toBe('"Q" = "B"');
    expect(h.appended).toEqual([]);
  });
});
