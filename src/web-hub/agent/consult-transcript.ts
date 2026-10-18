import { Buffer } from "node:buffer";
import type { WireEntry } from "../protocol/messages.js";
import { RUN_TX } from "../protocol/run-transcript.js";
import type { ConsultCacheDiagnostics, ConsultThreadRef } from "../../core/types.js";
import { consultCacheMarkerOfDiag } from "../../core/consult-cache-marker.js";

/** Display-only diagnostic fields; consult identity never comes from a label or agent type. */
export interface ConsultTranscriptDiagnostics {
  consultOf?: { askerRunId?: string };
  taskPrompt?: string;
  text?: string;
  textFinal?: true;
  /** cache-thread plan §5.3 (U): the consult run's own cache facts — rendered
   *  as the `consultMark` custom message field on the question entry (open
   *  WireMessage schema, append-only; old hubs/UIs ignore it). */
  consultCache?: ConsultCacheDiagnostics;
  consultThread?: ConsultThreadRef;
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
  // cache-thread plan §5.3 (U): thread/warm-cold compact marker (`t#2
  // warm·hit 96%`) — undefined when the run carries none of the fields, and
  // the entries then stay byte-identical to the pre-feature shape.
  const consultMark = consultCacheMarkerOfDiag(diag);
  const entries: WireEntry[] = [
    {
      id: "consult-question",
      parentId: null,
      type: "message",
      timestamp,
      message: {
        role: "user",
        content: question,
        consultSummary: true,
        consultPrompt: prompt,
        ...(consultMark === undefined ? {} : { consultMark }),
      },
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
