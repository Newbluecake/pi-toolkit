/**
 * Tail-truncation for an in-progress tool call's `partial` output (ui-design.md §6.6: "工具
 * partial 只保留最后 200 行 / 16 KiB 展示...全量仍在 state，展开'Show full output'时再渲染全量").
 * Pure, no DOM — `ToolCard.vue` calls this only for a `running` tool's `partial` text; finished
 * results are already bounded server-side (the hub's own 64 KiB cap, surfaced via the
 * `truncated` chip) and are never re-truncated here.
 */
export interface TailLinesResult {
  readonly text: string;
  readonly truncated: boolean;
}

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 16 * 1024;

export function tailLines(
  text: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxBytes: number = DEFAULT_MAX_BYTES,
): TailLinesResult {
  if (typeof text !== "string" || text === "") return { text: "", truncated: false };
  const lines = text.split("\n");
  let truncated = false;
  let sliced = lines;
  if (lines.length > maxLines) {
    sliced = lines.slice(lines.length - maxLines);
    truncated = true;
  }
  let out = sliced.join("\n");
  const bytes = new TextEncoder().encode(out);
  if (bytes.length > maxBytes) {
    // Trim from the front by bytes, then re-decode leniently (a multi-byte UTF-8 char cut in
    // half at the boundary becomes U+FFFD rather than throwing — acceptable for a display-only
    // truncation of the *tail* of arbitrary tool output).
    out = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(bytes.length - maxBytes));
    truncated = true;
  }
  return { text: out, truncated };
}
