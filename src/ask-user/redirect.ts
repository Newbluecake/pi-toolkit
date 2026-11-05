import type { AskRedirectDetails, Question } from "./types.js";

/**
 * #21 xs ask-redirect · ask-user half of the §2.0 frozen shared contract (plan
 * docs/dev/xs-ask-redirect/plan.md r3). The fabric half (B1) never imports this file — it
 * only matches these shapes structurally, so the types below are copied VERBATIM from §2.0:
 * do not add, remove, or rename fields.
 *
 * Semantics (root ruling 2026-11-05, mirrored in plan §2.0): `requestId` is ALWAYS the
 * intermediate ask ticket (q2); the answered variant additionally carries the required
 * `originRequestId` — the ORIGINAL delegation replyTo id the model needs to deliver its
 * final result (q2 is consumed by the answer and of no further use to it).
 */

export type AskRedirectReason =
  | "detached"
  | "origin_window"
  | "run_window"
  | "queue_window"
  | "level_limit"
  | "limit"
  | "too_large"
  | "no_ticket"
  | `send_none:${string}`;

export type AskUserRedirectResult =
  | {
      kind: "answered";
      answerText: string;
      originRequestId: string;
      requestId: string;
      attempt: number;
      limit: number;
    }
  | { kind: "timeout"; requestId: string; attempt: number; limit: number; waitedS: number }
  | { kind: "not_woken"; requestId: string; downgrade: string; attempt: number; limit: number }
  | { kind: "unavailable"; reason: AskRedirectReason; limit: number; attempt?: number; requestId?: string }
  | { kind: "aborted" }
  | { kind: "disposed" };

export interface AskUserRedirectPort {
  /** 同步：undefined ⇔ O 类（调用方走原路径）。render(budget) 返回 undefined ⇔ too_large。 */
  ask(input: {
    render: (budgetChars: number) => string | undefined;
    signal?: AbortSignal;
  }): Promise<AskUserRedirectResult> | undefined;
}

/**
 * D8 compression ladder for the message body sent to the delegating requester. The question
 * text and every option label are NEVER truncated — only option descriptions and context
 * compress, in this fixed order: full → drop option descriptions → truncate context to 120
 * chars → drop context. Nothing that fits even the last stage is cut further; if the minimal
 * body still exceeds the budget, renderRedirectBody returns undefined (⇒ `too_large`, the
 * ask is never sent and no admission is reserved).
 */
export const REDIRECT_CONTEXT_TRUNCATE_CHARS = 120;

interface BodyStage {
  withDescriptions: boolean;
  context: "full" | "truncate" | "none";
}

const BODY_STAGES: BodyStage[] = [
  { withDescriptions: true, context: "full" },
  { withDescriptions: false, context: "full" },
  { withDescriptions: false, context: "truncate" },
  { withDescriptions: false, context: "none" },
];

function buildRedirectBody(questions: Question[], stage: BodyStage): string {
  const blocks: string[] = [];
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    if (question === undefined) continue;
    const lines: string[] = [
      `${index + 1}) ${question.question}${question.multiSelect === true ? " (multi-select)" : ""}`,
    ];
    if (stage.context !== "none" && question.context !== undefined && question.context !== "") {
      const text =
        stage.context === "truncate" ? question.context.slice(0, REDIRECT_CONTEXT_TRUNCATE_CHARS) : question.context;
      lines.push(`Context: ${text}`);
    }
    for (const option of question.options) {
      const description = stage.withDescriptions && option.description !== undefined ? ` — ${option.description}` : "";
      lines.push(`- ${option.label}${description}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** D8: render the ask body within `budgetChars` (JS string length), or undefined when even the
 *  minimal body (full questions + labels only) does not fit. Pure function. */
export function renderRedirectBody(questions: Question[], budgetChars: number): string | undefined {
  for (const stage of BODY_STAGES) {
    const body = buildRedirectBody(questions, stage);
    if (body.length <= budgetChars) return body;
  }
  return undefined;
}

/** D8 U-class guidance appended to every non-answered terminal text (English — ask_user
 *  result texts are English by D8). */
const REDIRECT_GUIDANCE =
  "continue with a defensible default, and list the questions and the defaults you chose in your final result to the original replyTo";

/** D8 (r3) extra note for timeout / not_woken only: two reply windows, no absolute
 *  "will not wake you again" claim. */
const REDIRECT_TICKET_NOTE =
  "This ask has ended; later replies are still handled by the ticket and receive policy: a normal reply arriving before dueAt may still wake you, and a late reply within the grace period after the ticket expires is delivered only and does not wake you";

/** D8: the model-visible ask_user result text for each redirect terminal state. `answered`
 *  returns the D8 text verbatim (with attempt/limit, the ORIGINAL replyTo id — from
 *  `originRequestId`, NOT the consumed q2 `requestId` — and the answer); every other state
 *  starts with "Do not assume an answer." followed by the reason token and the U-class
 *  guidance; timeout/not_woken additionally carry the ticket/grace note. */
export function redirectResultText(result: AskUserRedirectResult): string {
  switch (result.kind) {
    case "answered":
      return `The requester answered (host-redirected ask_user, ${result.attempt}/${result.limit} this run). Treat it as the requester's decision; deliver your FINAL result with the ORIGINAL replyTo ${result.originRequestId}. The same reply also appears as a separate xs message — do not answer it again.\n${result.answerText}`;
    case "timeout":
      return `Do not assume an answer. Redirected ask_user ended with timeout after ${result.waitedS}s (${result.attempt}/${result.limit} this run); ${REDIRECT_GUIDANCE}. ${REDIRECT_TICKET_NOTE}.`;
    case "not_woken":
      return `Do not assume an answer. Redirected ask_user ended with not_woken:${result.downgrade} (${result.attempt}/${result.limit} this run); ${REDIRECT_GUIDANCE}. ${REDIRECT_TICKET_NOTE}.`;
    case "unavailable":
      return `Do not assume an answer. Redirected ask_user is unavailable (${result.reason}); ${REDIRECT_GUIDANCE}.`;
    case "aborted":
      return `Do not assume an answer. Redirected ask_user was aborted; ${REDIRECT_GUIDANCE}.`;
    case "disposed":
      return `Do not assume an answer. Redirected ask_user was disposed (session stack teardown); ${REDIRECT_GUIDANCE}.`;
  }
}

/** D8: `details.redirected` for each terminal state — `{state, attempt?, limit?, requestId?,
 *  reason?}`; not_woken carries its downgrade token as `reason`. */
export function redirectDetails(result: AskUserRedirectResult): AskRedirectDetails {
  const state = result.kind satisfies AskRedirectDetails["state"];
  switch (result.kind) {
    case "answered":
    case "timeout":
      return { state, attempt: result.attempt, limit: result.limit, requestId: result.requestId };
    case "not_woken":
      return {
        state,
        attempt: result.attempt,
        limit: result.limit,
        requestId: result.requestId,
        reason: result.downgrade,
      };
    case "unavailable": {
      const details: AskRedirectDetails = { state, reason: result.reason };
      if (result.attempt !== undefined) details.attempt = result.attempt;
      if (result.limit !== undefined) details.limit = result.limit;
      if (result.requestId !== undefined) details.requestId = result.requestId;
      return details;
    }
    case "aborted":
    case "disposed":
      return { state };
  }
}

/** D8 renderResult marker: `↪ requester answered 1/2` for an answered redirect,
 *  `↪ requester <state>` otherwise (compact inline marker — English tokens only). */
export function redirectRenderMarker(details: AskRedirectDetails): string {
  if (details.state === "answered") {
    return details.attempt !== undefined && details.limit !== undefined
      ? `↪ requester answered ${details.attempt}/${details.limit}`
      : "↪ requester answered";
  }
  return `↪ requester ${details.state}`;
}
