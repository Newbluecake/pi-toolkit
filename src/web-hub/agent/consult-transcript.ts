import { Buffer } from "node:buffer";
import type { WireEntry } from "../protocol/messages.js";
import { RUN_TX } from "../protocol/run-transcript.js";

/** Display-only diagnostic fields; consult identity never comes from a label or agent type. */
export interface ConsultTranscriptDiagnostics {
  consultOf?: { askerRunId?: string };
  taskPrompt?: string;
  text?: string;
  textFinal?: true;
}

/** Reconstruct only this consultation, never the expert fork's inherited conversation. */
export function consultTranscript(diag: ConsultTranscriptDiagnostics | undefined): WireEntry[] | undefined {
  if (diag?.consultOf === undefined || typeof diag.taskPrompt !== "string" || typeof diag.text !== "string")
    return undefined;
  const prompt = diag.taskPrompt;
  // Both the preserved-loadout and reserved-main prompts use this line. Only strip a
  // recognized generated preamble, and split at the FIRST marker (questions may contain one).
  const generated = prompt.startsWith("READ-ONLY CONSULT MODE\n") || prompt.startsWith("[consult] ");
  const marker = prompt.indexOf("\nQuestion:\n");
  let question = generated && marker !== -1 ? prompt.slice(marker + "\nQuestion:\n".length) : prompt;
  const budgetNote = "\nBudget note: you have roughly one turn — answer directly from your context, do not call tools.";
  if (generated && marker !== -1 && question.endsWith(budgetNote)) question = question.slice(0, -budgetNote.length);
  const timestamp = new Date(0).toISOString(); // no fabricated execution time
  const entries: WireEntry[] = [
    {
      id: "consult-question",
      parentId: null,
      type: "message",
      timestamp,
      message: { role: "user", content: question, consultSummary: true, consultPrompt: prompt },
    },
    {
      id: "consult-answer",
      parentId: "consult-question",
      type: "message",
      timestamp,
      message: { role: "assistant", content: diag.text, consultSummary: true },
    },
  ];
  // Never let diagnostic text defeat the existing transport budget. Oversized records
  // retain the existing explicit failure rather than silently presenting a partial answer.
  return Buffer.byteLength(JSON.stringify(entries), "utf8") < RUN_TX.maxBytes - 4096 ? entries : undefined;
}
