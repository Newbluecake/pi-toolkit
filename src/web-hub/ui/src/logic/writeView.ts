/**
 * `write` tool-call presentation model (#37, DOM-free, total — never throws).
 *
 * `buildWriteView` decides whether a `write` call's args can be shown as a code block
 * (real newlines, line numbers, highlight) instead of the generic escaped-JSON line, and
 * derives the compact facts the card header shows. Returning `null` means "keep the legacy
 * rendering byte-identical" (non-write tool, args not (yet) a complete object, `content`
 * missing / not a string).
 *
 * Scope notes (pinned by plan docs/dev/write-tool-render/plan.md):
 * - A string `args` that parses to an object is accepted on purpose (history / partial
 *   transport may hand the args over as a JSON string); a parse failure ⇒ `null`.
 * - `path` missing ⇒ still a code view, just without a path in the summary.
 * - The numbers describe the content RECEIVED by the UI. Args carry no truncation marker, so
 *   they must never be presented as the size of a complete file on disk.
 */
import { resolveFileLang } from "./highlight.js";

export interface WriteView {
  /** The file path argument; `null` when absent / not a string / empty. */
  readonly path: string | null;
  /** Prism grammar id resolved from the path's basename; `null` ⇒ plain text. */
  readonly lang: string | null;
  /** The `content` string, exactly as received (never trimmed, `\r` kept). */
  readonly content: string;
  readonly lines: number;
  /** UTF-8 byte length of `content`. */
  readonly bytes: number;
  /** Compact English-token summary: `N lines · M KB` (`M B` below 1 KiB). */
  readonly summary: string;
}

/**
 * One pass over `content`: logical line count (`\r\n` | `\n` | `\r` terminators; empty ⇒ 0;
 * ONE trailing terminator does not add a line) and UTF-8 byte length. Code-point stepping —
 * no `TextEncoder.encode` buffer for big content; a lone surrogate costs 3 bytes (matches
 * TextEncoder's U+FFFD substitution).
 */
export function measureContent(content: string): { readonly lines: number; readonly bytes: number } {
  const n = content.length;
  if (n === 0) return { lines: 0, bytes: 0 };
  let bytes = 0;
  let terminators = 0;
  let lastWasTerminator = false;
  for (let i = 0; i < n; i++) {
    const c = content.charCodeAt(i);
    lastWasTerminator = false;
    if (c < 0x80) {
      bytes += 1;
      if (c === 0x0a) {
        terminators += 1;
        lastWasTerminator = true;
      } else if (c === 0x0d) {
        if (content.charCodeAt(i + 1) === 0x0a) {
          bytes += 1;
          i += 1;
        }
        terminators += 1;
        lastWasTerminator = true;
      }
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = content.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return { lines: terminators + (lastWasTerminator ? 0 : 1), bytes };
}

export function formatByteSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function asArgsObject(args: unknown): Record<string, unknown> | null {
  let v = args;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export function buildWriteView(toolName: string, args: unknown): WriteView | null {
  if (toolName !== "write") return null;
  const obj = asArgsObject(args);
  if (obj === null) return null;
  const content = obj["content"];
  if (typeof content !== "string") return null;
  const rawPath = obj["path"];
  const path = typeof rawPath === "string" && rawPath !== "" ? rawPath : null;
  const { lines, bytes } = measureContent(content);
  let lang: string | null = null;
  if (path !== null) {
    const base = path.split(/[\\/]/).pop() ?? "";
    lang = resolveFileLang(base);
  }
  return { path, lang, content, lines, bytes, summary: `${lines} lines · ${formatByteSize(bytes)}` };
}

/** pi's exact success output for `write` (pinned peer: `Successfully wrote to ${path}`). */
export function isStandardWriteSuccess(wv: WriteView, result: unknown): boolean {
  return wv.path !== null && typeof result === "string" && result === `Successfully wrote to ${wv.path}`;
}
