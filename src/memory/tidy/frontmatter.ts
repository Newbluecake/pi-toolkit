// §7.4 `--frontmatter` deterministic metadata backfill — todo #22 P4. Zero
// model cost: pure function over already-parsed files. Idempotent by
// construction (checks RAW frontmatter field presence via `parseFrontmatter`,
// not the already-defaulted `MemoryMeta`, so a second run over an
// already-backfilled directory proposes nothing — §7.4).

import { firstHeading } from "../meta.js";
import { parseFrontmatter, stripFrontmatter } from "../frontmatter.js";
import type { MemoryMeta } from "../contracts.js";

export interface FrontmatterCandidateFile {
  name: string;
  /** Raw file bytes, including any existing frontmatter block. */
  body: string;
  meta: MemoryMeta;
  isPrimaryCore: boolean;
}

export interface FrontmatterProposal {
  name: string;
  patch: Partial<Pick<MemoryMeta, "description" | "topic" | "status">>;
}

/** Code-point-safe clip to `maxBytes` UTF-8 bytes, `…` appended when cut. */
function clipBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) break;
    bytes += b;
    end += ch.length;
  }
  return `${s.slice(0, end)}…`;
}

/** Filename → `[a-z0-9-]{1,48}` topic slug (§5's `topic` constraint). */
function slugTopic(name: string): string {
  const base = name
    .replace(/\.md$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "topic").slice(0, 48);
}

/**
 * Not model-generated — pure function; must be idempotent (a second run
 * over an already-backfilled directory produces `[]`, §7.4). Primary core
 * is never proposed a `description`/`read_when` backfill (§5), but topic/
 * status ARE still eligible for it like any other file.
 */
export function planFrontmatterBackfill(files: readonly FrontmatterCandidateFile[]): FrontmatterProposal[] {
  const out: FrontmatterProposal[] = [];
  for (const f of files) {
    if (f.meta.status === "archived") continue;
    const fm = parseFrontmatter(f.body);
    const patch: FrontmatterProposal["patch"] = {};
    if (!f.isPrimaryCore && fm?.fields.get("description") === undefined) {
      const h1 = firstHeading(stripFrontmatter(f.body));
      if (h1) patch.description = clipBytes(h1, 110);
    }
    if (fm?.fields.get("topic") === undefined) {
      patch.topic = slugTopic(f.name);
    }
    if (fm?.fields.get("status") === undefined) {
      patch.status = "active";
    }
    if (Object.keys(patch).length > 0) out.push({ name: f.name, patch });
  }
  return out;
}
