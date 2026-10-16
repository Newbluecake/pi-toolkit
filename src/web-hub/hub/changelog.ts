/**
 * web-hub-version plan §3.2: pure CHANGELOG.md section parser. Pi-free, IO-free, never throws.
 *
 * Splits on `^## [` headings, skips an EMPTY `[Unreleased]` section, drops reference-style link
 * definitions (`[0.5.5]: https://…` — the generated footer), parses `## [0.5.5] - 2026-10-16`
 * into `{title, date}` and clips each section's body to a byte budget on a line boundary.
 */
import type { VersionChangelogSection } from "../protocol/version-info.js";

export interface ChangelogLimits {
  /** Max sections returned. */
  readonly changelogSections: number;
  /** Per-section markdown byte budget (UTF-8). */
  readonly sectionBytes: number;
}

const HEADING_RE = /^## \[([^\]\n]{1,100})\](?:\([^)\n]*\))?(?:\s+-\s+(\S{1,40}))?/;
const LINK_DEF_RE = /^\[[^\]\n]+\]:\s*\S.*$/;

/** Truncate `lines` to ≤ `maxBytes` UTF-8 bytes on a line boundary; a single line longer than the
 *  budget is cut at a code-point boundary. */
function clipLines(lines: readonly string[], maxBytes: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (used + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(line, "utf8").subarray(0, Math.max(0, maxBytes));
        let s = buf.toString("utf8");
        if (s.endsWith("\uFFFD")) s = s.slice(0, -1);
        out.push(s);
      }
      return { text: out.join("\n").trimEnd(), truncated: true };
    }
    out.push(line);
    used += size;
  }
  return { text: out.join("\n").trimEnd(), truncated: false };
}

export function parseChangelogSections(text: string, limits: ChangelogLimits): VersionChangelogSection[] {
  const sections: VersionChangelogSection[] = [];
  if (typeof text !== "string" || text === "") return sections;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let current: { title: string; date?: string; body: string[] } | undefined;

  const flush = (): void => {
    if (current === undefined || sections.length >= limits.changelogSections) {
      current = undefined;
      return;
    }
    const body = current.body.join("\n").trim();
    const isUnreleased = current.title.toLowerCase() === "unreleased";
    if (!(isUnreleased && body === "")) {
      const clipped = clipLines(body === "" ? [] : body.split("\n"), limits.sectionBytes);
      sections.push({
        title: current.title,
        ...(current.date === undefined ? {} : { date: current.date }),
        markdown: clipped.text,
        ...(clipped.truncated ? { truncated: true as const } : {}),
      });
    }
    current = undefined;
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m !== null) {
      flush();
      if (sections.length >= limits.changelogSections) break;
      current = { title: m[1]!.trim(), ...(m[2] === undefined ? {} : { date: m[2] }), body: [] };
      continue;
    }
    if (current === undefined) continue;
    if (LINK_DEF_RE.test(line)) continue;
    current.body.push(line);
  }
  flush();
  return sections;
}
