export interface IndexLink {
  line: number;
  raw: string;
  label: string;
  target: string;
  name?: string;
  recognized: boolean;
  reason?: string;
}
export interface IndexManualReference {
  line: number;
  raw: string;
  target?: string;
  reason: string;
}
export interface IndexEditResult {
  text: string;
  removedLines: readonly number[];
  links: readonly IndexLink[];
  manual: readonly IndexManualReference[];
  references: readonly IndexLink[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u;
function isName(name: string): boolean {
  return NAME_RE.test(name) && name !== ".md" && name.length <= 128;
}
function normalizeTarget(raw: string): { value?: string; reason?: string } {
  let target = raw.trim();
  // Markdown permits an optional quoted title after the destination.
  if (target.startsWith("<") && target.includes(">")) target = target.slice(1, target.indexOf(">"));
  else {
    const quote = target.search(/\s+["']/u);
    if (quote >= 0) target = target.slice(0, quote);
  }
  target = target.replace(/[?#].*$/u, "").replace(/^\.\//u, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    return { reason: "invalid percent-encoding" };
  }
  if (target.includes("..") || target.startsWith("/") || target.includes("\\"))
    return { reason: "path is not a v2 memory name" };
  if (target.startsWith("archive/")) {
    const name = target.slice("archive/".length);
    return isName(name) ? { value: `archive/${name}` } : { reason: "archive target is not a v2 memory name" };
  }
  return isName(target) ? { value: target } : { reason: "target is not a v2 memory name" };
}
function inCode(line: string, position: number): boolean {
  return (line.slice(0, position).match(/`/gu)?.length ?? 0) % 2 === 1;
}

/** Parse only inline Markdown links. Reference links, HTML, bare names and code spans are reported. */
export function parseIndexLinks(text: string): {
  links: readonly IndexLink[];
  manual: readonly IndexManualReference[];
} {
  const links: IndexLink[] = [];
  const manual: IndexManualReference[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const seen = new Set<number>();
    const regex = /\[([^\]]*)\]\(([^)]*)\)/gu;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      if (inCode(line, match.index)) continue;
      seen.add(match.index);
      const target = match[2] ?? "";
      const normalized = normalizeTarget(target);
      const item: IndexLink = normalized.value
        ? { line: lineNo, raw: match[0], label: match[1] ?? "", target, name: normalized.value, recognized: true }
        : {
            line: lineNo,
            raw: match[0],
            label: match[1] ?? "",
            target,
            recognized: false,
            reason: normalized.reason ?? "unrecognized reference",
          };
      links.push(item);
      if (!item.recognized)
        manual.push({ line: lineNo, raw: match[0], target, reason: item.reason ?? "unrecognized reference" });
    }
    // Reference-style links and HTML links are intentionally never edited.
    if (/^\s*\[[^\]]+\]:\s*\S+/u.test(line) || /\[[^\]]+\]\[[^\]]*\]/u.test(line))
      manual.push({ line: lineNo, raw: line, reason: "reference-style link" });
    if (/<a\b[^>]*href=/iu.test(line)) manual.push({ line: lineNo, raw: line, reason: "HTML link" });
    if (seen.size === 0 && /`[^`]*\.md[^`]*`/u.test(line))
      manual.push({ line: lineNo, raw: line, reason: "code span" });
    if (
      seen.size === 0 &&
      /(?:^|[^/\w.-])[A-Za-z0-9][A-Za-z0-9._-]*\.md\b/u.test(line) &&
      !/^\s*\[[^\]]+\]:/u.test(line)
    )
      manual.push({ line: lineNo, raw: line, reason: "bare filename" });
  });
  return { links, manual };
}

function isSingleListLink(line: string, links: readonly IndexLink[]): boolean {
  return links.length === 1 && /^\s*[-*+]\s+\[[^\]]*\]\([^)]*\)\s*$/u.test(line);
}

/** Remove only safe one-line list entries; all other archive references are manual. */
export function editIndex(text: string, archivedNames: ReadonlySet<string> | readonly string[]): IndexEditResult {
  const archived = archivedNames instanceof Set ? archivedNames : new Set(archivedNames);
  const parsed = parseIndexLinks(text);
  const byLine = new Map<number, IndexLink[]>();
  for (const link of parsed.links) byLine.set(link.line, [...(byLine.get(link.line) ?? []), link]);
  const lines = text.split("\n");
  const remove = new Set<number>();
  const manual = [...parsed.manual];
  for (const [lineNo, links] of byLine) {
    const line = lines[lineNo - 1] ?? "";
    const target = links[0];
    if (!target?.recognized || !target.name || (!target.name.startsWith("archive/") && !archived.has(target.name)))
      continue;
    const baseName = target.name.startsWith("archive/") ? target.name.slice("archive/".length) : target.name;
    if (!archived.has(baseName)) continue;
    const next = lines[lineNo] ?? "";
    // A same-level next bullet is a separate item; only an indented line is
    // a continuation/sub-item of the link entry.
    const continuation = /^\s{2,}\S/u.test(next);
    if (isSingleListLink(line, links) && !continuation) remove.add(lineNo);
    else
      manual.push({ line: lineNo, raw: line, target: target.name, reason: "not a standalone single-link list item" });
  }
  const output = lines.filter((_, index) => !remove.has(index + 1)).join("\n");
  return {
    text: output,
    removedLines: [...remove].sort((a, b) => a - b),
    links: parsed.links,
    manual,
    references: parsed.links,
  };
}
