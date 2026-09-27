// §5 frontmatter contract + §2.1 section-splitting, both pure and reused by
// every later package (tiered rendering's "admitSections", the v2 tool's
// `view`/`--frontmatter`, the doctor). Line-level parsing only (no YAML dep) —
// builds on `frontmatter.ts`'s existing `parseFrontmatter`, does not
// duplicate it.
//
// Zero pi/typebox imports; independently unit-testable.

import { parseFrontmatter } from "./frontmatter.js";
import { stripDriftHeader } from "./render.js";
import type { MemoryMeta, MemoryMetaResult, MemoryStatus } from "./contracts.js";

const TOPIC_RE = /^[a-z0-9-]{1,48}$/;
const STATUSES: readonly MemoryStatus[] = ["active", "stale", "archived"];
const MAX_FRONTMATTER_LINES = 40;
const MAX_FRONTMATTER_BYTES = 2048;
const MAX_DESCRIPTION_BYTES = 160;
const MAX_READ_WHEN_BYTES = 240;

/** Strip one layer of matching `"…"` / `'…'` quotes (frontmatter values are
 *  otherwise taken verbatim by `parseFrontmatter`). */
function unquote(value: string): string {
  const m = /^(['"])(.*)\1$/.exec(value);
  return m?.[2] ?? value;
}

/** `;` or full-width `；`-separated keyword list, trimmed, empties dropped. */
export function splitReadWhen(raw: string): string[] {
  return raw
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a memory file's frontmatter into `MemoryMeta` (§5's table), never
 * throwing: structural problems are reported as `errors` for the doctor
 * (D07), not raised. `fallbackTopic` is normally the filename minus `.md`.
 */
export function parseMemoryMeta(raw: string, fallbackTopic: string): MemoryMetaResult {
  const errors: string[] = [];
  const fm = parseFrontmatter(raw);
  if (fm) {
    const block = raw.slice(0, fm.bodyStart);
    const lineCount = block.split("\n").length;
    if (Buffer.byteLength(block, "utf8") > MAX_FRONTMATTER_BYTES || lineCount > MAX_FRONTMATTER_LINES) {
      errors.push(
        `frontmatter exceeds ${MAX_FRONTMATTER_LINES} lines / ${MAX_FRONTMATTER_BYTES}B — treated as invalid`,
      );
    }
  }
  const get = (key: string): string | undefined => {
    const v = fm?.fields.get(key);
    return v === undefined ? undefined : unquote(v);
  };

  const description = get("description");
  if (description !== undefined && Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_BYTES}B`);
  }
  const readWhen = get("read_when");
  if (readWhen !== undefined && Buffer.byteLength(readWhen, "utf8") > MAX_READ_WHEN_BYTES) {
    errors.push(`read_when exceeds ${MAX_READ_WHEN_BYTES}B`);
  }
  const rawTopic = get("topic");
  const topic = rawTopic !== undefined && TOPIC_RE.test(rawTopic) ? rawTopic : fallbackTopic;

  const rawStatus = get("status");
  let status: MemoryStatus = "active";
  if (rawStatus !== undefined) {
    if ((STATUSES as readonly string[]).includes(rawStatus)) {
      status = rawStatus as MemoryStatus;
    } else {
      errors.push(`status ${JSON.stringify(rawStatus)} is not one of active|stale|archived`);
    }
  }

  const updated = get("updated");
  if (updated !== undefined) {
    const wellFormed = /^\d{4}-\d{2}-\d{2}/.test(updated) && !Number.isNaN(Date.parse(updated));
    if (!wellFormed) errors.push(`updated ${JSON.stringify(updated)} is not a parseable ISO date`);
  }

  const pin = get("pin") === "true";
  const source = get("source");

  const meta: MemoryMeta = {
    ...(description === undefined ? {} : { description }),
    ...(readWhen === undefined ? {} : { readWhen }),
    readWhenTerms: readWhen === undefined ? [] : splitReadWhen(readWhen),
    topic,
    status,
    ...(updated === undefined ? {} : { updated }),
    pin,
    ...(source === undefined ? {} : { source }),
  };
  return { meta, errors };
}

/** First `# ` (H1) heading, after stripping any drift-import header — used
 *  as the description fallback (§5: "缺失 ⇒ 首个 `# ` 标题"). */
export function firstHeading(bodyAfterFrontmatter: string): string | undefined {
  const stripped = stripDriftHeader(bodyAfterFrontmatter);
  const m = /^#\s+(.+)$/m.exec(stripped);
  return m?.[1]?.trim();
}

/** `meta.description`, or the H1 fallback, or the literal "(no description)". */
export function descriptionOrHeading(bodyAfterFrontmatter: string, meta: MemoryMeta): string {
  if (meta.description !== undefined) return meta.description;
  return firstHeading(bodyAfterFrontmatter) ?? "(no description)";
}

// ───────────────────────────── §2.1 section splitting ─────────────────────────────

export interface MemorySection {
  /** Heading text with the `## ` prefix and surrounding whitespace stripped. */
  heading: string;
  /** The heading line through (not including) the next section's heading line. */
  text: string;
}

export interface SplitSections {
  /** Everything before the first `## ` boundary (H1 title included). */
  preamble: string;
  sections: readonly MemorySection[];
}

const FENCE_RE = /^```/;
const H2_RE = /^##\s/;
const H1_RE = /^#\s/;

/**
 * Split a memory file's body into `preamble` + ordered `## ` sections
 * (§2.1's "整节准入算法" input). A code-fenced block's contents are never
 * treated as heading lines. `### `-and-deeper headings stay inside whatever
 * `## ` section contains them (they never start a new section); a bare `# `
 * heading appearing AFTER at least one `## ` has been seen closes the
 * currently-open section without opening a new one (rare — most files never
 * have more than one H1).
 */
export function splitSections(body: string): SplitSections {
  const lines = body.split("\n");
  let inFence = false;
  let sawH2 = false;
  const boundaries: number[] = []; // line indices that END the preceding section
  const sectionStarts: number[] = []; // subset of `boundaries` that also START a new section
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (H2_RE.test(line)) {
      sawH2 = true;
      boundaries.push(i);
      sectionStarts.push(i);
    } else if (H1_RE.test(line) && sawH2) {
      boundaries.push(i); // closes the open section, opens nothing
    }
  }
  const preambleEnd = boundaries[0] ?? lines.length;
  const preamble = lines.slice(0, preambleEnd).join("\n");
  const sections: MemorySection[] = [];
  for (const start of sectionStarts) {
    const nextBoundary = boundaries.find((b) => b > start);
    const end = nextBoundary ?? lines.length;
    sections.push({
      heading: (lines[start] ?? "").replace(H2_RE, "").trim(),
      text: lines.slice(start, end).join("\n"),
    });
  }
  return { preamble, sections };
}
