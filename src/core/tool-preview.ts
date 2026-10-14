/**
 * M-A: single-line, truncated preview of a tool call's arguments for the
 * live trail UI. Picks the most informative scalar (bash command, file path,
 * pattern…) and falls back to compact JSON. Display-only — never fed back to
 * a model — and hard-capped so a huge prompt/file body cannot bloat diag.
 *
 * external-agent plan §2.4 (P1, frozen): moved verbatim from
 * src/runtime/session-driver.ts (which now re-exports it from here) so the
 * pi-free framework packages can consume it without importing the pi-facing
 * session driver. Behavior is byte-identical — the existing tests in
 * tests/core/presentation-diag.test.ts must keep passing unchanged.
 */
export function previewToolArgs(args: unknown, max = 80): string | undefined {
  if (args === null || args === undefined) return undefined;
  let text: string;
  if (typeof args === "string") text = args;
  else if (typeof args === "object") {
    const r = args as Record<string, unknown>;
    const str = (k: string): string | undefined =>
      typeof r[k] === "string" && (r[k] as string).trim().length > 0 ? (r[k] as string) : undefined;
    // Addressed tools (consult: expert+question; message_agent: to+text) read
    // best as "→ target: body" instead of a JSON blob.
    const target = str("expert") ?? str("to");
    const body = str("question") ?? str("text");
    const preferred = ["command", "path", "file_path", "pattern", "query", "description", "prompt", "url"];
    const key = preferred.find((k) => str(k) !== undefined);
    if (target !== undefined && body !== undefined) text = `→ ${target}: ${body}`;
    else if (key) text = r[key] as string;
    else {
      // Compact `key=value` pairs; only non-scalar values fall back to JSON.
      try {
        text = Object.entries(r)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) =>
            typeof v === "string" || typeof v === "number" || typeof v === "boolean"
              ? `${k}=${String(v)}`
              : `${k}=${JSON.stringify(v) ?? ""}`,
          )
          .join(" ");
      } catch {
        return undefined;
      }
    }
  } else text = String(args);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
