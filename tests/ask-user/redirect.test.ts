import { describe, expect, it } from "vitest";

import factory from "../../src/ask-user/index.js";
import {
  REDIRECT_CONTEXT_TRUNCATE_CHARS,
  redirectDetails,
  redirectRenderMarker,
  redirectResultText,
  renderRedirectBody,
  type AskUserRedirectPort,
  type AskUserRedirectResult,
} from "../../src/ask-user/redirect.js";
import type { AskRedirectDetails, Question } from "../../src/ask-user/types.js";
import { AskUserComponent } from "../../src/ask-user/component.js";
import { mockTui, stubTheme } from "./fixtures.js";

/* ------------------------------------------------------------------ helpers */

interface Tool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (...args: any[]) => Promise<any>;
  renderCall: (...args: any[]) => any;
  renderResult: (...args: any[]) => any;
}

const valid = {
  questions: [
    {
      question: "Which DB?",
      context: "Need ACID.",
      options: [{ label: "Postgres", description: "Mature" }, { label: "SQLite" }],
    },
  ],
};

interface PortLog {
  askCalls: number;
  render?: (budgetChars: number) => string | undefined;
  signal?: AbortSignal;
}

function capture(redirect?: () => AskUserRedirectPort | undefined) {
  let tool: Tool | undefined;
  let active: string[] | undefined;
  const pi = {
    events: { emit: (): void => {} },
    registerTool(definition: Tool) {
      tool = definition;
    },
    getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
    setActiveTools(names: string[]) {
      active = names;
    },
  };
  factory(pi as never, redirect === undefined ? undefined : { redirect });
  if (!tool) throw new Error("tool was not registered");
  return {
    tool,
    get active() {
      return active;
    },
  };
}

/** A port that resolves `ask()` with a fixed result (or O-class undefined). */
function fixedPort(result: AskUserRedirectResult | undefined, log?: PortLog): AskUserRedirectPort {
  return {
    ask(input) {
      if (log) {
        log.askCalls += 1;
        log.render = input.render;
        log.signal = input.signal;
      }
      return result === undefined ? undefined : Promise.resolve(result);
    },
  };
}

/** tui context that never shows a dialog unless ui.custom is invoked (it records if so). */
function guardedTuiContext(dialogOpens: string[]) {
  return {
    mode: "tui" as const,
    hasUI: true,
    ui: {
      custom: async <T>(make: (...args: any[]) => any): Promise<T> => {
        dialogOpens.push("ui.custom");
        return make(mockTui, stubTheme, {}, () => {}) as T;
      },
    },
  };
}

/** Deterministic tui context that answers "first option" for a single-question dialog. */
function answeringTuiContext(onCreate?: (component: AskUserComponent) => void) {
  return {
    mode: "tui" as const,
    hasUI: true,
    ui: {
      custom: async <T>(make: (...args: any[]) => any): Promise<T> =>
        new Promise<T>((resolve) => {
          const component = make(mockTui, stubTheme, {}, resolve) as AskUserComponent;
          onCreate?.(component);
        }),
    },
  };
}

function renderText(component: { render(width: number): string[] }): string {
  return component.render(100).join("\n");
}

/* ------------------------------------------- renderRedirectBody (D8 budget) */

describe("renderRedirectBody compression ladder", () => {
  const longContext = "c".repeat(200);
  const bodyQuestions: Question[] = [
    {
      question: "Which database engine?",
      context: longContext,
      options: [
        { label: "Postgres", description: "Mature, strong consistency." },
        { label: "SQLite", description: "Zero-ops, embedded." },
      ],
    },
  ];

  const STAGE_FULL = [
    "1) Which database engine?",
    `Context: ${longContext}`,
    "- Postgres — Mature, strong consistency.",
    "- SQLite — Zero-ops, embedded.",
  ].join("\n");
  const STAGE_NO_DESC = ["1) Which database engine?", `Context: ${longContext}`, "- Postgres", "- SQLite"].join("\n");
  const STAGE_TRUNCATED_CONTEXT = [
    "1) Which database engine?",
    `Context: ${"c".repeat(REDIRECT_CONTEXT_TRUNCATE_CHARS)}`,
    "- Postgres",
    "- SQLite",
  ].join("\n");
  const STAGE_NO_CONTEXT = ["1) Which database engine?", "- Postgres", "- SQLite"].join("\n");

  it("keeps the full body when the budget fits (stage 1)", () => {
    expect(renderRedirectBody(bodyQuestions, STAGE_FULL.length)).toBe(STAGE_FULL);
    expect(renderRedirectBody(bodyQuestions, 1_000_000)).toBe(STAGE_FULL);
  });

  it("drops option descriptions first (stage 2)", () => {
    expect(renderRedirectBody(bodyQuestions, STAGE_FULL.length - 1)).toBe(STAGE_NO_DESC);
    expect(renderRedirectBody(bodyQuestions, STAGE_NO_DESC.length)).toBe(STAGE_NO_DESC);
  });

  it("truncates context to 120 chars second (stage 3)", () => {
    expect(renderRedirectBody(bodyQuestions, STAGE_NO_DESC.length - 1)).toBe(STAGE_TRUNCATED_CONTEXT);
    expect(STAGE_TRUNCATED_CONTEXT).toContain(`Context: ${"c".repeat(120)}`);
    expect(STAGE_TRUNCATED_CONTEXT).not.toContain(`Context: ${"c".repeat(121)}`);
  });

  it("drops context entirely third (stage 4)", () => {
    expect(renderRedirectBody(bodyQuestions, STAGE_TRUNCATED_CONTEXT.length - 1)).toBe(STAGE_NO_CONTEXT);
    expect(renderRedirectBody(bodyQuestions, STAGE_NO_CONTEXT.length)).toBe(STAGE_NO_CONTEXT);
  });

  it("returns undefined when even questions + labels do not fit (too_large)", () => {
    expect(renderRedirectBody(bodyQuestions, STAGE_NO_CONTEXT.length - 1)).toBeUndefined();
    expect(renderRedirectBody(bodyQuestions, 0)).toBeUndefined();
  });

  it("never truncates question text: oversized questions yield undefined, never a cut body", () => {
    const huge: Question[] = Array.from({ length: 4 }, (_, index) => ({
      question: `q${index} ${"x".repeat(990)}`,
      options: [{ label: "A", description: "d".repeat(50) }, { label: "B" }],
    }));
    for (const budget of [2_000, 4_000, 200, 1]) {
      const body = renderRedirectBody(huge, budget);
      if (body === undefined) continue;
      // Whenever a body IS produced, every question text and label is complete.
      for (const question of huge) {
        expect(body).toContain(question.question);
        for (const option of question.options) expect(body).toContain(option.label);
      }
    }
    // 4 x ~1000-char questions cannot fit the default 2000-char budget minus the header.
    expect(renderRedirectBody(huge, 1_500)).toBeUndefined();
  });

  it("a context shorter than the truncation cap survives the truncate stage unchanged", () => {
    const questions: Question[] = [
      {
        question: "Q?",
        context: "short context",
        options: [{ label: "A", description: "desc" }, { label: "B" }],
      },
    ];
    const stage2 = renderRedirectBody(questions, 10_000);
    expect(stage2).toContain("Context: short context");
    // Budgets that skip descriptions land on the same body (truncate is a no-op here).
    const tight = renderRedirectBody(questions, (stage2 ?? "").length - 1);
    expect(tight).toContain("Context: short context");
    expect(tight).not.toContain("desc");
  });

  it("marks multi-select questions", () => {
    const questions: Question[] = [
      { question: "Which features?", multiSelect: true, options: [{ label: "Auth" }, { label: "Search" }] },
    ];
    expect(renderRedirectBody(questions, 500)).toContain("1) Which features? (multi-select)");
  });
});

/* --------------------------------------------------- terminal texts (D8) */

describe("redirectResultText terminal texts", () => {
  const answered: AskUserRedirectResult = {
    kind: "answered",
    answerText: "1: Postgres",
    originRequestId: "req-origin-7",
    requestId: "q2-42",
    attempt: 1,
    limit: 2,
  };

  it("answered renders the D8 text verbatim; <origin> comes from originRequestId, NOT requestId", () => {
    expect(redirectResultText(answered)).toBe(
      "The requester answered (host-redirected ask_user, 1/2 this run). Treat it as the requester's decision; deliver your FINAL result with the ORIGINAL replyTo req-origin-7. The same reply also appears as a separate xs message — do not answer it again.\n1: Postgres",
    );
    // The q2 ticket id must NOT leak into the <origin> slot.
    expect(redirectResultText(answered)).not.toContain("replyTo q2-42");
  });

  it("timeout opens with Do-not-assume, carries the reason token and the two-window note", () => {
    const text = redirectResultText({
      kind: "timeout",
      requestId: "q2-9",
      attempt: 2,
      limit: 2,
      waitedS: 600,
    });
    expect(text.startsWith("Do not assume an answer.")).toBe(true);
    expect(text).toContain("timeout after 600s");
    expect(text).toContain("(2/2 this run)");
    expect(text).toContain("defensible default");
    expect(text).toContain("original replyTo");
    expect(text).toContain("may still wake you");
    expect(text).toContain("delivered only");
    // r3: no absolute "will not wake you again" claim.
    expect(text).not.toMatch(/won'?t wake you again/i);
  });

  it("not_woken carries the downgrade token and the two-window note", () => {
    const text = redirectResultText({
      kind: "not_woken",
      requestId: "q2-9",
      downgrade: "busy",
      attempt: 1,
      limit: 2,
    });
    expect(text.startsWith("Do not assume an answer.")).toBe(true);
    expect(text).toContain("not_woken:busy");
    expect(text).toContain("(1/2 this run)");
    expect(text).toContain("may still wake you");
    expect(text).not.toMatch(/won'?t wake you again/i);
  });

  it("unavailable carries the reason token and the guidance, without the ticket note", () => {
    for (const reason of ["detached", "limit", "too_large", "no_ticket", "send_none:rate_pair_interval"] as const) {
      const text = redirectResultText({ kind: "unavailable", reason, limit: 2 });
      expect(text.startsWith("Do not assume an answer.")).toBe(true);
      expect(text).toContain(`(${reason})`);
      expect(text).toContain("defensible default");
      expect(text).toContain("original replyTo");
      expect(text).not.toContain("This ask has ended");
    }
  });

  it("aborted and disposed open the same way and carry the guidance", () => {
    const aborted = redirectResultText({ kind: "aborted" });
    const disposed = redirectResultText({ kind: "disposed" });
    for (const text of [aborted, disposed]) {
      expect(text.startsWith("Do not assume an answer.")).toBe(true);
      expect(text).toContain("defensible default");
      expect(text).not.toContain("This ask has ended");
    }
    expect(aborted).toContain("aborted");
    expect(disposed).toContain("disposed");
  });
});

describe("redirectDetails mapping", () => {
  it("answered maps state/attempt/limit plus the q2 requestId (originRequestId is not a details field)", () => {
    expect(
      redirectDetails({
        kind: "answered",
        answerText: "1: a",
        originRequestId: "req-origin-7",
        requestId: "q2-42",
        attempt: 1,
        limit: 2,
      }),
    ).toStrictEqual({
      state: "answered",
      attempt: 1,
      limit: 2,
      requestId: "q2-42",
    } satisfies AskRedirectDetails);
  });

  it("timeout and not_woken map fully; not_woken carries the downgrade as reason", () => {
    expect(redirectDetails({ kind: "timeout", requestId: "q2", attempt: 1, limit: 2, waitedS: 5 })).toStrictEqual({
      state: "timeout",
      attempt: 1,
      limit: 2,
      requestId: "q2",
    });
    expect(
      redirectDetails({ kind: "not_woken", requestId: "q2", downgrade: "busy", attempt: 1, limit: 2 }),
    ).toStrictEqual({ state: "not_woken", attempt: 1, limit: 2, requestId: "q2", reason: "busy" });
  });

  it("unavailable keeps optional fields absent when not supplied (exactOptionalPropertyTypes)", () => {
    expect(redirectDetails({ kind: "unavailable", reason: "detached", limit: 2 })).toStrictEqual({
      state: "unavailable",
      reason: "detached",
      limit: 2,
    });
    expect(
      redirectDetails({ kind: "unavailable", reason: "limit", limit: 2, attempt: 2, requestId: "q2" }),
    ).toStrictEqual({ state: "unavailable", reason: "limit", limit: 2, attempt: 2, requestId: "q2" });
  });

  it("aborted and disposed map to state only", () => {
    expect(redirectDetails({ kind: "aborted" })).toStrictEqual({ state: "aborted" });
    expect(redirectDetails({ kind: "disposed" })).toStrictEqual({ state: "disposed" });
  });

  it('covers every result kind (state mirrors AskUserRedirectResult["kind"])', () => {
    const kinds: AskUserRedirectResult["kind"][] = [
      "answered",
      "timeout",
      "not_woken",
      "unavailable",
      "aborted",
      "disposed",
    ];
    const seen: string[] = [];
    for (const kind of kinds) {
      const result = (
        kind === "answered"
          ? { kind, answerText: "a", originRequestId: "o", requestId: "r", attempt: 1, limit: 2 }
          : kind === "timeout"
            ? { kind, requestId: "r", attempt: 1, limit: 2, waitedS: 1 }
            : kind === "not_woken"
              ? { kind, requestId: "r", downgrade: "busy", attempt: 1, limit: 2 }
              : kind === "unavailable"
                ? { kind, reason: "detached" as const, limit: 2 }
                : { kind }
      ) as AskUserRedirectResult;
      seen.push(redirectDetails(result).state);
    }
    expect(seen).toEqual(kinds);
  });
});

describe("redirectRenderMarker", () => {
  it("shows the attempt/limit for answered and the bare state otherwise", () => {
    expect(redirectRenderMarker({ state: "answered", attempt: 1, limit: 2, requestId: "r" })).toBe(
      "↪ requester answered 1/2",
    );
    expect(redirectRenderMarker({ state: "timeout", attempt: 2, limit: 2, requestId: "q2" })).toBe(
      "↪ requester timeout",
    );
    expect(redirectRenderMarker({ state: "unavailable", reason: "detached", limit: 2 })).toBe(
      "↪ requester unavailable",
    );
    expect(redirectRenderMarker({ state: "aborted" })).toBe("↪ requester aborted");
    expect(redirectRenderMarker({ state: "disposed" })).toBe("↪ requester disposed");
  });
});

/* ------------------------------------------------- execute integration */

describe("ask_user execute redirect branch (#21 B2)", () => {
  it("returns the redirect result directly without any local dialog (U-class)", async () => {
    const outcome: AskUserRedirectResult = { kind: "unavailable", reason: "detached", limit: 2 };
    const { tool } = capture(() => fixedPort(outcome));
    const dialogOpens: string[] = [];
    const result = await tool.execute("id", valid, undefined, undefined, guardedTuiContext(dialogOpens));
    expect(result.content).toEqual([{ type: "text", text: redirectResultText(outcome) }]);
    expect(result.details).toStrictEqual({
      questions: [
        {
          question: "Which DB?",
          context: "Need ACID.",
          options: [{ label: "Postgres", description: "Mature" }, { label: "SQLite" }],
        },
      ],
      answers: {},
      cancelled: true,
      redirected: { state: "unavailable", reason: "detached", limit: 2 },
    });
    expect(dialogOpens).toEqual([]);
  });

  it("works the same in rpc mode: ui.select is never consulted", async () => {
    const outcome: AskUserRedirectResult = { kind: "timeout", requestId: "q2", attempt: 1, limit: 2, waitedS: 600 };
    const { tool } = capture(() => fixedPort(outcome));
    const dialogOpens: string[] = [];
    const result = await tool.execute("id", valid, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
      ui: {
        select: async () => {
          dialogOpens.push("ui.select");
          return undefined;
        },
      },
    });
    expect(result.details.redirected).toEqual({ state: "timeout", attempt: 1, limit: 2, requestId: "q2" });
    expect(result.details.cancelled).toBe(true);
    expect(dialogOpens).toEqual([]);
  });

  it("answered maps to cancelled:false; details carry the q2 requestId", async () => {
    const outcome: AskUserRedirectResult = {
      kind: "answered",
      answerText: "1: Postgres",
      originRequestId: "req-origin-7",
      requestId: "q2-42",
      attempt: 1,
      limit: 2,
    };
    const { tool } = capture(() => fixedPort(outcome));
    const result = await tool.execute("id", valid, undefined, undefined, guardedTuiContext([]));
    expect(result.details.cancelled).toBe(false);
    expect(result.details.redirected).toEqual({ state: "answered", attempt: 1, limit: 2, requestId: "q2-42" });
    expect(result.content[0].text).toContain("ORIGINAL replyTo req-origin-7");
    expect(result.content[0].text).toContain("do not answer it again");
    expect(result.content[0].text).not.toContain("replyTo q2-42");
  });

  it("passes a render closure bound to the normalized questions plus the tool signal", async () => {
    const log: PortLog = { askCalls: 0 };
    const controller = new AbortController();
    const { tool } = capture(() => fixedPort({ kind: "aborted" }, log));
    const pending = tool.execute("id", valid, controller.signal, undefined, guardedTuiContext([]));
    expect(log.askCalls).toBe(1);
    expect(log.signal).toBe(controller.signal);
    expect(log.render).toBeTypeOf("function");
    // The closure is renderRedirectBody over the normalized questions.
    expect(log.render?.(1_000)).toContain("Which DB?");
    expect(log.render?.(1_000)).toContain("- Postgres — Mature");
    expect(log.render?.(1_000)).toBe(renderRedirectBody(valid.questions as Question[], 1_000));
    expect(log.render?.(1)).toBeUndefined(); // too_large ⇔ undefined
    await pending;
  });

  it("O-class (ask returns undefined) keeps the original local-dialog path byte-identical", async () => {
    const run = async (withRedirect: boolean) => {
      const { tool } = capture(withRedirect ? () => fixedPort(undefined, { askCalls: 0 }) : undefined);
      return tool.execute(
        "id",
        valid,
        undefined,
        undefined,
        answeringTuiContext((component) => component.handleInput("\r")),
      );
    };
    const [plain, redirected] = await Promise.all([run(false), run(true)]);
    expect(redirected).toStrictEqual(plain);
    expect(plain.details.cancelled).toBe(false); // the local dialog really ran
    expect(plain.details.answers["Which DB?"].selected).toEqual(["Postgres"]);
  });

  it("print mode still takes the HEADLESS path: the port is never consulted", async () => {
    const log: PortLog = { askCalls: 0 };
    const captured = capture(() => fixedPort({ kind: "aborted" }, log));
    await expect(
      captured.tool.execute("id", valid, undefined, undefined, { mode: "print", hasUI: false, ui: {} }),
    ).rejects.toThrow(/interactive session/);
    expect(log.askCalls).toBe(0);
    expect(captured.active).toEqual(["other"]);
  });

  it("a pre-aborted signal returns before the redirect branch is reached", async () => {
    const log: PortLog = { askCalls: 0 };
    const { tool } = capture(() => fixedPort({ kind: "aborted" }, log));
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute("id", valid, controller.signal, undefined, guardedTuiContext([]));
    expect(result.content[0].text).toContain("Agent aborted");
    expect(result.details.redirected).toBeUndefined();
    expect(log.askCalls).toBe(0);
  });

  it("dismissParked still short-circuits ahead of the redirect branch", async () => {
    const log: PortLog = { askCalls: 0 };
    const { tool } = capture(() => fixedPort({ kind: "aborted" }, log));
    const result = await tool.execute("id", { dismissParked: true }, undefined, undefined, guardedTuiContext([]));
    expect(result.content[0].text).toContain("parked");
    expect(log.askCalls).toBe(0);
  });
});

/* ------------------------------------------------------- renderResult */

describe("renderResult redirected branch", () => {
  const options = { expanded: false, isPartial: false };

  function renderDetails(details: AskRedirectDetails): string {
    const { tool } = capture();
    const component = tool.renderResult(
      {
        content: [{ type: "text", text: "redirect outcome" }],
        details: { questions: [], answers: {}, cancelled: details.state !== "answered", redirected: details },
      },
      options,
      stubTheme,
      { isError: false },
    );
    return renderText(component);
  }

  it("renders the answered marker with attempt/limit", () => {
    expect(renderDetails({ state: "answered", attempt: 1, limit: 2, requestId: "r" })).toContain(
      "↪ requester answered 1/2",
    );
  });

  it("renders the bare state for non-answered terminals instead of a generic Cancelled", () => {
    expect(renderDetails({ state: "timeout", attempt: 2, limit: 2, requestId: "q2" })).toContain("↪ requester timeout");
    expect(renderDetails({ state: "unavailable", reason: "detached", limit: 2 })).toContain("↪ requester unavailable");
  });
});
