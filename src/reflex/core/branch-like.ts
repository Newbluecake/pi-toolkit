/**
 * jev-reflex · shared adapter (#25 BA §4.1, moved verbatim from `wire.ts` in B0): pi branch entries →
 * the structural look-alike `core/agreement.ts` reads. Lives in core so the offline backtest
 * (B1 `core/backtest/**`) can reuse the exact same shape mapping without importing pi (R-I10).
 */

import type { BranchEntryLike } from "./agreement.js";

/** pi branch entries → the structural look-alike `core/agreement.ts` reads (no pi import in core). */
export function toBranchLike(entries: readonly unknown[]): BranchEntryLike[] {
  const out: BranchEntryLike[] = [];
  for (const raw of entries) {
    const e = raw as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (e === null || typeof e !== "object" || e.type !== "message" || e.message === undefined) {
      out.push({ role: "other" });
      continue;
    }
    const role = typeof e.message.role === "string" ? e.message.role : "other";
    const content = e.message.content;
    if (role === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((p: unknown) => {
                  const part = p as { type?: unknown; text?: unknown };
                  return part?.type === "text" && typeof part.text === "string" ? part.text : "";
                })
                .join("")
            : "";
      out.push({ role, text });
    } else if (role === "assistant" && Array.isArray(content)) {
      const toolCalls = content
        .filter((p: unknown) => (p as { type?: unknown })?.type === "toolCall")
        .map((p: unknown) => {
          const c = p as { name?: unknown; arguments?: unknown };
          return { name: typeof c.name === "string" ? c.name : "", arguments: c.arguments };
        });
      out.push({ role, toolCalls });
    } else {
      out.push({ role });
    }
  }
  return out;
}
