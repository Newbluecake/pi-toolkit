import { consultAllowedTools, consultDisabledTools, CONSULT_REFUSAL_GUIDANCE } from "./preserve-guard.js";
import type { ExpertRequestSnapshot } from "../core/types.js";
import { CONSULT_READONLY_TOOLS } from "../runtime/tool-scope.js";

/**
 * Build the single user message appended to an expert fork.  C2 receives the
 * allow/deny lists reconstructed from the expert transcript; the `allowed` /
 * `disabled` omission is retained only for the reserved `main` path, whose
 * documented Q1 exception keeps today's read-only prompt byte-for-byte.
 */
export function buildConsultPrompt(opts: {
  question: string;
  maxAnswerChars: number;
  budgetNote: boolean;
  isMain?: boolean;
  allowed?: readonly string[];
  disabled?: readonly string[];
}): string {
  const c2 = opts.allowed !== undefined || opts.disabled !== undefined;
  const allowed = [...(opts.allowed ?? [])];
  const disabled = [...(opts.disabled ?? [])];
  const lines = c2
    ? [
        "READ-ONLY CONSULT MODE",
        `Allowed tools: ${allowed.length > 0 ? allowed.join(", ") : "none — answer from your existing context only"}`,
        `Every other tool is disabled and any call to it will be refused: ${disabled.length > 0 ? disabled.join(", ") : "none"}.`,
        `Do not call disabled tools; each refused call wastes a turn. ${CONSULT_REFUSAL_GUIDANCE} or use an allowed tool.`,
        "Answer from your own context. Lead with the conclusion (<=3 lines), then expand only as needed.",
        `Hard limit: <= ${opts.maxAnswerChars} characters.`,
      ]
    : [
        "[consult] You are being consulted by a downstream agent that cannot see your session.",
        "Answer from your own context. Lead with the conclusion (<=3 lines), then expand only as needed.",
        `Hard limit: <= ${opts.maxAnswerChars} characters.`,
        `In this consult you ONLY have read-only tools: ${CONSULT_READONLY_TOOLS.join(", ")}. Do not attempt any other tool`,
        "(bash/edit/write/Agent/... from your history are unavailable). Prefer not to call tools unless the",
        "answer strictly requires a fresh environment fact.",
      ];
  if (opts.isMain) {
    lines.push(
      "You are the host main session, consulted by one of your own subagents. Answer only the decisions,",
      "preferences and context relevant to its question — do not restate credentials or unrelated parts of",
      "the conversation. If your history does not contain the answer (it may have been compacted or handed",
      "off before this point), say so plainly instead of guessing.",
    );
  }
  lines.push("", "Question:", opts.question);
  if (opts.budgetNote)
    lines.push("Budget note: you have roughly one turn — answer directly from your context, do not call tools.");
  return lines.join("\n");
}

/** Build R2 lists directly from the same frozen snapshot used by the guard. */
export function consultPromptLists(snapshot: ExpertRequestSnapshot): { allowed: string[]; disabled: string[] } {
  return { allowed: consultAllowedTools(snapshot), disabled: consultDisabledTools(snapshot) };
}
