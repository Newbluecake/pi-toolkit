// Line-level YAML-frontmatter parsing shared by store (provenance writes) and
// render (pin/source reads) — factored out so store ↔ render stay acyclic
// (方案 §2). Deliberately line-based: no YAML dependency, tolerant of non-kv
// lines, and only a frontmatter block at the very head of the file counts.
//
// Zero pi/typebox imports; independently unit-testable.

export interface Frontmatter {
  /** Parsed key/value pairs (later duplicate keys win). Values are trimmed. */
  readonly fields: ReadonlyMap<string, string>;
  /** Offset just past the closing fence line (including its trailing newline). */
  readonly bodyStart: number;
}

const OPEN_RE = /^---\r?\n/;
const KV_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/;

/**
 * Parse a leading `---\n…\n---` frontmatter block. Returns undefined when the
 * content does not start with `---` or the closing fence is missing.
 */
export function parseFrontmatter(content: string): Frontmatter | undefined {
  const open = OPEN_RE.exec(content);
  if (!open) return undefined;
  let offset = open[0].length;
  const fields = new Map<string, string>();
  while (offset < content.length) {
    const nl = content.indexOf("\n", offset);
    const lineEnd = nl === -1 ? content.length : nl;
    const line = content.slice(offset, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      return { fields, bodyStart: nl === -1 ? content.length : nl + 1 };
    }
    const kv = KV_RE.exec(line);
    if (kv && kv[1] !== undefined && kv[2] !== undefined) fields.set(kv[1], kv[2]);
    // non-kv lines are tolerated (skipped), per 方案 §7.2
    offset = nl === -1 ? content.length : nl + 1;
  }
  return undefined; // unterminated frontmatter
}

/** Remove the leading frontmatter block (and any blank lines right after it).
 *  Content without frontmatter is returned unchanged. */
export function stripFrontmatter(content: string): string {
  const fm = parseFrontmatter(content);
  if (!fm) return content;
  return content.slice(fm.bodyStart).replace(/^(?:\r?\n)+/, "");
}

/** `pin: true` in a head frontmatter block (line-level; `pin: yes` does NOT
 *  count, nor does a non-head block) — 方案 §5.1.2. */
export function isPinned(content: string): boolean {
  return parseFrontmatter(content)?.fields.get("pin") === "true";
}

/** The frontmatter `source` value (e.g. "agent"), or undefined when absent. */
export function frontmatterSource(content: string): string | undefined {
  return parseFrontmatter(content)?.fields.get("source");
}

/**
 * Insert or update frontmatter fields, preserving unrelated keys (e.g. a
 * user's `pin: true` survives a provenance upsert — 方案 §5.3).
 *
 * - No existing block: a new block is prepended as `---\n<k>: <v>\n…\n---\n\n`.
 * - Existing block: matching keys are updated in place (original order kept,
 *   non-kv lines preserved verbatim); missing keys are appended at the end in
 *   the order of `fields`.
 */
export function upsertFrontmatterFields(content: string, fields: Record<string, string>): string {
  const entries = Object.entries(fields);
  const fm = parseFrontmatter(content);
  if (!fm) {
    const head = `---\n${entries.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n`;
    return head + content;
  }
  // Rebuild the block: walk the original lines, updating consumed keys.
  const open = OPEN_RE.exec(content);
  const start = open ? open[0].length : 0; // always matched — parseFrontmatter succeeded
  const closeLineStart = findCloseLineStart(content, start, fm.bodyStart);
  const inner = content.slice(start, closeLineStart).replace(/\r?\n$/, "");
  const blockLines = inner === "" ? [] : inner.split("\n");
  const consumed = new Set<string>();
  const out: string[] = [];
  for (const rawLine of blockLines) {
    const line = rawLine.replace(/\r$/, "");
    const kv = KV_RE.exec(line);
    const key = kv?.[1];
    if (key !== undefined && Object.hasOwn(fields, key) && !consumed.has(key)) {
      consumed.add(key);
      out.push(`${key}: ${fields[key] ?? ""}`);
    } else {
      out.push(rawLine);
    }
  }
  for (const [k, v] of entries) {
    if (!consumed.has(k)) out.push(`${k}: ${v}`);
  }
  // closeLineStart points at the opening '-' of the closing fence; everything
  // from there on (fence + body) is preserved byte-for-byte.
  return `---\n${out.join("\n")}${out.length > 0 ? "\n" : ""}${content.slice(closeLineStart)}`;
}

/** Offset of the closing fence line's first character, given a parsed fm. */
function findCloseLineStart(content: string, scanStart: number, bodyStart: number): number {
  let offset = scanStart;
  while (offset < bodyStart) {
    const nl = content.indexOf("\n", offset);
    const lineEnd = nl === -1 ? content.length : nl;
    if (content.slice(offset, lineEnd).replace(/\r$/, "") === "---") return offset;
    offset = nl === -1 ? content.length : nl + 1;
  }
  return bodyStart; // unreachable for well-formed input; stay total
}
