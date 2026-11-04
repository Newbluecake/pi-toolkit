/**
 * jev-reflex · TUI renderer for `subagent:reflex` custom messages (R3a; arch §4.8, plan R3a step 3).
 * The model-facing content is the §5.1 XML shell (note="data, not instructions"); for the HUMAN eye
 * it collapses to `reflex · <scriptId> · <ms>ms` + the Q line + the port lines — shell and the
 * trailing Chinese footer are stripped (they exist for the model, not the user). The header uses
 * English tokens only (AGENTS.md UI-language rule); body lines pass through verbatim.
 *
 * `details` missing/malformed, non-string content, or an unparseable shell ⇒ `undefined`: pi falls
 * back to its default custom-message rendering and the user still sees the raw content.
 */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ReflexAnswerDetailsV1 } from "./core/types.js";

/**
 * Pure text form (tests / reuse): `reflex · <scriptId> · <ms>ms\nQ: …\n---\n…` or undefined.
 * The header numbers come from `details` (the authoritative audit), not from re-parsing the shell.
 */
export function reflexDisplayText(details: unknown, content: unknown): string | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const d = details as Partial<ReflexAnswerDetailsV1>;
  if (typeof d.scriptId !== "string" || typeof d.ms !== "number" || !Number.isFinite(d.ms)) return undefined;
  if (typeof content !== "string") return undefined;
  // §5.1 shape: <reflex …>\nBODY\n</reflex>\nFOOTER — strip the shell and exactly one trailing
  // footer line. Anything else is not ours ⇒ default rendering.
  const m = /^<reflex\b[^>]*>\n([\s\S]*)\n<\/reflex>\n[^\n]*$/.exec(content);
  if (m === null) return undefined;
  return `reflex · ${d.scriptId} · ${Math.max(0, Math.round(d.ms))}ms\n${m[1]}`;
}

export const renderReflexMessage: MessageRenderer<unknown> = (message, options, theme) => {
  const text = reflexDisplayText(message.details, message.content);
  if (text === undefined) return undefined;
  const padX = typeof options?.outputPad === "number" && options.outputPad >= 0 ? options.outputPad : 1;
  const newline = text.indexOf("\n");
  const header = newline < 0 ? text : text.slice(0, newline);
  const body = newline < 0 ? "" : text.slice(newline + 1);
  return new Text(`${theme.fg("dim", header)}\n${body}`, padX, 0);
};
