import { CONSULT_READONLY_TOOLS } from "../runtime/tool-scope.js";

/**
 * consult (docs/dev/consult/plan.md §4.1): the question prompt sent to a
 * forked expert copy, verbatim as the run prompt. The runtime adapter
 * deliberately bypasses `buildPrompt`'s agent-type prefix for consult runs
 * (§5.4 B-4) — the type's task instructions are already in the fork's
 * history, so this prompt is the *only* new instruction the expert sees.
 *
 * The read-only tool declaration is derived from `CONSULT_READONLY_TOOLS`
 * (single source with the pi-level allowlist and the tool-scope enforcer —
 * never a second hand-written list).
 */
export function buildConsultPrompt(opts: {
  question: string;
  /** Hard answer-length instruction (= settings.consult.maxAnswerChars). */
  maxAnswerChars: number;
  /**
   * §15 #4: appended when `maxCostUsd - est < est` — the expert has roughly
   * one turn of budget left, so it must answer from context instead of
   * burning the turn on tool calls.
   */
  budgetNote: boolean;
}): string {
  const lines = [
    "[consult] You are being consulted by a downstream agent that cannot see your session.",
    "Answer from your own context. Lead with the conclusion (<=3 lines), then expand only as needed.",
    `Hard limit: <= ${opts.maxAnswerChars} characters.`,
    `In this consult you ONLY have read-only tools: ${CONSULT_READONLY_TOOLS.join(", ")}. Do not attempt any other tool`,
    "(bash/edit/write/Agent/... from your history are unavailable). Prefer not to call tools unless the",
    "answer strictly requires a fresh environment fact.",
    "",
    "Question:",
    opts.question,
  ];
  if (opts.budgetNote) {
    // §4.1: appended at the tail of the question prompt.
    lines.push("Budget note: you have roughly one turn — answer directly from your context, do not call tools.");
  }
  return lines.join("\n");
}
