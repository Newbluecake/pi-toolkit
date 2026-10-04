/**
 * P1 outcome protocol (plan §5.1 mapping table, §10 P1-8 races, P1-11 result text):
 * every winner → InteractionOutcome → session.close mapping, the verbatim model-facing
 * texts, and first-claim-wins across abort / tui / web / background.
 */
import { describe, expect, it } from "vitest";
import { INTERRUPTED_RENDER_TEXT, deferredResultText, interruptedResultText } from "../../src/ask-user/interrupt.js";
import { stubTheme } from "./fixtures.js";
import { PARAMS, createBgHarness, flush, tuiContext } from "./bg-harness.js";

describe("§5.1 winner → outcome → session.close mapping", () => {
  it("tui submit → answered(tui) + close(tui, answered)", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    c.created[0]!.handleInput("\r");
    const result = await pending;
    expect(result.details.cancelled).toBe(false);
    expect(result.content[0].text).toBe('"Q" = "A"');
    expect(h.session!.closed).toEqual(["tui", "answered"]);
  });

  it("tui Esc → cancelled(tui) + close(tui, cancelled) + user-cancelled text", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    c.created[0]!.handleInput("\x1b");
    c.created[0]!.handleInput("\x1b");
    const result = await pending;
    expect(result.details.cancelled).toBe(true);
    expect(result.details.interrupted).toBeUndefined();
    expect(result.content[0].text).toContain("User cancelled");
    expect(h.session!.closed).toEqual(["tui", "cancelled"]);
  });

  it("web answer → answered(web) and NO session.close call", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    expect(h.session!.fire({ kind: "answer", answers: { Q: "B" }, origin: "web" })).toBe(true);
    const result = await pending;
    expect(result.details.answers.Q.selected).toEqual(["B"]);
    expect(h.session!.closed).toBeUndefined();
  });

  it("web cancel → cancelled(web) and NO session.close call", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    expect(h.session!.fire({ kind: "cancel", origin: "web" })).toBe(true);
    const result = await pending;
    expect(result.details.cancelled).toBe(true);
    expect(result.content[0].text).toContain("User cancelled");
    expect(h.session!.closed).toBeUndefined();
  });

  it("abort → aborted + close(abort, aborted) + agent-aborted text", async () => {
    const h = createBgHarness();
    const controller = new AbortController();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, controller.signal, undefined, c.ctx);
    await flush();
    controller.abort();
    const result = await pending;
    expect(result.content[0].text).toContain("Agent aborted");
    expect(h.session!.closed).toEqual(["abort", "aborted"]);
  });

  it("background → interrupted + close(background, aborted)", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    const result = await pending;
    expect(result.details.interrupted.kind).toBe("background");
    expect(h.session!.closed).toEqual(["background", "aborted"]);
  });

  it("deferred → no ui.custom + close(background, aborted)", async () => {
    const h = createBgHarness();
    h.port.tokens = 1;
    const c = tuiContext();
    const result = await h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    expect(c.customCalls).toBe(0);
    expect(result.details.interrupted.kind).toBe("deferred");
    expect(h.session!.closed).toEqual(["background", "aborted"]);
  });

  it("a throwing ui.custom → close(error, aborted) and the legacy error text", async () => {
    const h = createBgHarness();
    const ctx = {
      mode: "tui" as const,
      hasUI: true,
      ui: {
        custom: async (): Promise<never> => {
          throw new Error("boom");
        },
      },
    };
    await expect(h.tool.execute("id", PARAMS, undefined, undefined, ctx)).rejects.toThrow(
      /ask_user failed: boom\. Treat as cancelled/,
    );
    expect(h.session!.closed).toEqual(["error", "aborted"]);
  });
});

describe("§10 P1-8: first claim wins", () => {
  it("abort before background → aborted; the later window does nothing", async () => {
    const h = createBgHarness();
    const controller = new AbortController();
    let doneCalls = 0;
    const c = tuiContext(undefined, () => {
      doneCalls += 1;
    });
    const pending = h.tool.execute("id", PARAMS, controller.signal, undefined, c.ctx);
    await flush();
    h.port.fire();
    controller.abort();
    const result = await pending;
    expect(result.content[0].text).toContain("Agent aborted");
    h.clock.advance(60_000);
    await flush();
    expect(doneCalls).toBe(1);
    expect(h.session!.closed).toEqual(["abort", "aborted"]);
  });

  it("background before abort → interrupted; the later abort is a no-op", async () => {
    const h = createBgHarness();
    const controller = new AbortController();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, controller.signal, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    const result = await pending;
    controller.abort();
    await flush();
    expect(result.details.interrupted.kind).toBe("background");
    expect(h.session!.closed).toEqual(["background", "aborted"]);
  });

  it("background before tui submit → interrupted; the late submit is a no-op", async () => {
    const h = createBgHarness();
    let doneCalls = 0;
    const c = tuiContext(undefined, () => {
      doneCalls += 1;
    });
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    const result = await pending;
    c.created[0]!.handleInput("\r"); // too late: component already resolved
    await flush();
    expect(doneCalls).toBe(1);
    expect(result.details.interrupted.kind).toBe("background");
  });

  it("web before background → answered(web); the port subscription is gone", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.session!.fire({ kind: "answer", answers: { Q: "A" }, origin: "web" });
    const result = await pending;
    expect(result.details.answers.Q.selected).toEqual(["A"]);
    expect(h.port.listeners.size).toBe(0);
    h.port.fire();
    h.clock.advance(60_000);
    await flush();
    expect(h.clock.pending).toBe(0);
  });

  it("background before web → interrupted; the late web answer is refused", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    const result = await pending;
    expect(h.session!.fire({ kind: "answer", answers: { Q: "B" }, origin: "web" })).toBe(false);
    expect(result.details.interrupted.kind).toBe("background");
  });
});

describe("§6.2 result text (verbatim) and details", () => {
  it("interruptedResultText is the pinned model-facing string", () => {
    const text = interruptedResultText(
      [
        { kind: "subagent", count: 2 },
        { kind: "bash", count: 1 },
      ],
      2,
      3,
    );
    expect(text).toBe(
      "ask_user was interrupted before the user answered: 3 background tasks (2 subagent, 1 bash) finished in the background and the completion notice(s) arrive right after this result. The question(s) are NOT answered — do not assume an answer and do not answer on the user's behalf. First handle the notice(s); if the decision is still needed, call ask_user again with the same questions (the user's partial input is restored). If the background result already settles the question, proceed and say so explicitly. [interrupt 2/3]",
    );
    expect(text).toContain("NOT answered");
    expect(text).toContain("do not answer on the user's behalf");
  });

  it("deferredResultText is the pinned model-facing string", () => {
    expect(deferredResultText(2)).toBe(
      "ask_user was not shown yet: 2 background completion notice(s) are queued and will arrive next. Do not assume an answer. Read them, then call ask_user again with the same questions if the decision is still needed.",
    );
  });

  it("interrupted details carry cancelled:true, empty answers and the InterruptInfo", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    const result = await pending;
    expect(result.details.cancelled).toBe(true);
    expect(result.details.answers).toEqual({});
    expect(result.details.interrupted).toEqual({
      kind: "background",
      completions: [{ kind: "subagent", count: 1 }],
      attempt: 1,
      limit: 3,
      draftSaved: true,
    });
  });

  it("renderResult renders the interrupted marker before the generic cancelled branch", () => {
    const h = createBgHarness();
    const component = h.tool.renderResult(
      {
        content: [{ type: "text", text: "..." }],
        details: {
          questions: PARAMS.questions,
          answers: {},
          cancelled: true,
          interrupted: { kind: "background", completions: [], attempt: 1, limit: 3, draftSaved: false },
        },
      },
      { expanded: false, isPartial: false },
      stubTheme,
      { isError: false },
    );
    expect(component.render(100).join("\n")).toContain(INTERRUPTED_RENDER_TEXT);
    expect(INTERRUPTED_RENDER_TEXT).toBe("⏸ paused · bg done · will re-ask");
    const cancelled = h.tool.renderResult(
      {
        content: [{ type: "text", text: "..." }],
        details: { questions: PARAMS.questions, answers: {}, cancelled: true },
      },
      { expanded: false, isPartial: false },
      stubTheme,
      { isError: false },
    );
    expect(cancelled.render(100).join("\n")).toContain("Cancelled");
  });
});
