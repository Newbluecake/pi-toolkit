/** #39 P4a2: source-derived admission manifest. No SDK, I/O or runtime Jev state.
 * Renderers opt in, reserve BEFORE whole-unit admission, and record only admitted
 * source ranges. Locating a recorded chunk in the final assembly is offset mapping,
 * never parsing a prompt to infer authority or visibility. */
import { createHash } from "node:crypto";
import { parseFrontmatter } from "./frontmatter.js";
import { splitEntries } from "./jev/entries.js";
import type { ParsedBlock } from "./blocks/format.js";
import { looksSecret } from "./secret-patterns.js";
import {
  PRIORITY_NOTE,
  duplicateMarkerUtf8Bytes,
  projectedDuplicateMarkers,
  type ThreeLayerDuplicateCandidate,
  type ThreeLayerDuplicatePlan,
} from "./scopes/render.js";

export const projectAnchor = (path: string, first: number, last: number): string =>
  `p${createHash("sha256")
    .update(JSON.stringify([path, first, last]))
    .digest("hex")
    .slice(0, 24)}`;

/** Future legal anchors, NOT the current plan's hypothetical-loser bounds.
 * session n[1..6 digits]; hub [a-z0-9-]{1,48}.[0..6 digits]; project p+24hex.
 * A priority note and its separator are conservatively reserved PER ENTRY. */
export const PROJECT_MARKER_RESERVE = Math.max(
  duplicateMarkerUtf8Bytes({ layer: "session", id: "n999999" }),
  duplicateMarkerUtf8Bytes({ layer: "hub", id: `${"a".repeat(48)}.999999` }),
  duplicateMarkerUtf8Bytes({ layer: "project", id: `p${"f".repeat(24)}` }),
);
export const PROJECT_ENTRY_RESERVE = PROJECT_MARKER_RESERVE + Buffer.byteLength(`\n${PRIORITY_NOTE}`, "utf8");
export const legalProjectionAnchor = (c: ThreeLayerDuplicateCandidate): boolean =>
  c.layer === "project"
    ? /^p[0-9a-f]{24}$/.test(c.id)
    : c.layer === "session"
      ? /^n[0-9]{1,6}$/.test(c.id)
      : /^[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}$/.test(c.id);

export interface ProjectEntrySpan extends ThreeLayerDuplicateCandidate {
  readonly layer: "project";
  readonly visibility: "full";
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly start: number;
  readonly end: number;
  readonly markerAt: number;
  /** Exact emitted substring, distinct from the parser's normalized body. */
  readonly emitted: string;
}
export interface ProjectSource {
  readonly text: string;
  readonly entries: readonly ProjectEntrySpan[];
  readonly reservedBytes: number;
}
interface UnitEntry {
  candidate: ThreeLayerDuplicateCandidate;
  path: string;
  lineStart: number;
  lineEnd: number;
  start: number;
  end: number;
}
export interface ProjectUnit {
  readonly body: string;
  readonly entries: readonly UnitEntry[];
}
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}
const fullRange = (unit: ProjectUnit): SourceRange[] => [{ start: 0, end: unit.body.length }];
const contained = (entry: UnitEntry, ranges: readonly SourceRange[]): boolean =>
  ranges.some((r) => entry.start >= r.start && entry.end <= r.end);
export const projectReserve = (unit: ProjectUnit, ranges: readonly SourceRange[] = fullRange(unit)): number =>
  unit.entries.filter((e) => contained(e, ranges)).length * PROJECT_ENTRY_RESERVE;

/** A new capture per SOURCE render, never per layer/projection change. */
export class ProjectCapture {
  private readonly chunks: { text: string; entries: Omit<ProjectEntrySpan, "layer" | "visibility">[] }[] = [];
  readonly entryReserve = PROJECT_ENTRY_RESERVE;
  reserve(unit: ProjectUnit, ranges?: readonly SourceRange[]): number {
    return projectReserve(unit, ranges);
  }
  constructor(private readonly isChild = false) {}

  file(path: string, raw: string, body: string): ProjectUnit {
    const entries: UnitEntry[] = [];
    let cursor = 0;
    const lines = raw.split("\n");
    for (const e of splitEntries(path, raw, { handWritten: false, status: "active" })) {
      const exact = lines
        .slice(e.lineStart - 1, e.lineEnd)
        .join("\n")
        .trim();
      const start = body.indexOf(exact, cursor);
      if (start < 0 || exact === "") continue;
      cursor = start + exact.length;
      // Invalid metadata cannot assert authority or accidentally bypass privacy.
      if (
        e.inlineErrors.length > 0 ||
        e.inline.isPrivate ||
        e.secret ||
        (this.isChild ? e.inline.audience === "main" : e.inline.audience === "child")
      )
        continue;
      entries.push({
        candidate: {
          layer: "project",
          id: projectAnchor(path, e.lineStart, e.lineEnd),
          authority: e.authority,
          text: e.body,
          visibility: "full",
        },
        path,
        lineStart: e.lineStart,
        lineEnd: e.lineEnd,
        start,
        end: cursor,
      });
    }
    return { body, entries };
  }

  /** Whole section ranges come from the renderer's admission, not heading guesses. */
  ranges(unit: ProjectUnit, pieces: readonly string[]): SourceRange[] {
    let from = 0;
    return pieces.flatMap((piece) => {
      const start = unit.body.indexOf(piece, from);
      if (start < 0 || piece === "") return [];
      from = start + piece.length;
      return [{ start, end: from }];
    });
  }

  track(text: string, unit: ProjectUnit, ranges: readonly SourceRange[] = fullRange(unit)): void {
    const entries: Omit<ProjectEntrySpan, "layer" | "visibility">[] = [];
    let from = 0;
    for (const e of unit.entries) {
      if (!contained(e, ranges)) continue;
      const emitted = unit.body.slice(e.start, e.end);
      const start = text.indexOf(emitted, from);
      if (start < 0) continue;
      from = start + emitted.length;
      const newline = emitted.indexOf("\n");
      entries.push({
        ...e.candidate,
        path: e.path,
        lineStart: e.lineStart,
        lineEnd: e.lineEnd,
        start,
        end: from,
        markerAt: start + (newline < 0 ? emitted.length : newline),
        emitted,
      });
    }
    this.chunks.push({ text, entries });
  }

  block(b: ParsedBlock, rendered: string): void {
    if (
      b.errors.length > 0 ||
      b.body === "" ||
      b.meta.private ||
      looksSecret(b.body) ||
      (this.isChild ? b.meta.audience === "main" : b.meta.audience === "child")
    )
      return;
    const raw = b.raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const bodyAt = raw.indexOf(b.body, parseFrontmatter(raw)?.bodyStart ?? 0);
    if (bodyAt < 0) return; // no invented provenance for an inconsistent corpus DTO
    const path = `blocks/${b.id}.md`;
    const lineStart = raw.slice(0, bodyAt).split("\n").length;
    const lineEnd = lineStart + b.body.split("\n").length - 1;
    const firstEnd = rendered.indexOf("\n");
    this.chunks.push({
      text: rendered,
      entries: [
        {
          id: projectAnchor(path, lineStart, lineEnd),
          authority: b.meta.authority,
          text: b.body,
          path,
          lineStart,
          lineEnd,
          start: 0,
          end: rendered.length,
          markerAt: firstEnd < 0 ? rendered.length : firstEnd,
          emitted: rendered,
        },
      ],
    });
  }

  finish(text: string): ProjectSource {
    const entries: ProjectEntrySpan[] = [];
    let from = 0;
    for (const chunk of this.chunks) {
      const start = text.indexOf(chunk.text, from);
      if (start < 0) continue; // e.g. final frame-only fallback: no admitted body
      from = start + chunk.text.length;
      for (const e of chunk.entries)
        entries.push(
          Object.freeze({
            ...e,
            layer: "project",
            visibility: "full",
            start: start + e.start,
            end: start + e.end,
            markerAt: start + e.markerAt,
          }),
        );
    }
    return Object.freeze({
      text,
      entries: Object.freeze(entries),
      reservedBytes: entries.length * PROJECT_ENTRY_RESERVE,
    });
  }
}

/** Finalize once: no new candidates, no read/rerender/fixed point, no raw-body cut. */
export function projectSourceText(source: ProjectSource, plan?: ThreeLayerDuplicatePlan): string {
  if (plan === undefined) return source.text;
  const markers = projectedDuplicateMarkers(plan, "project", source.entries);
  const edits = source.entries.flatMap((e, i) => {
    const m = markers[i];
    if (
      m === undefined ||
      duplicateMarkerUtf8Bytes(m) > PROJECT_MARKER_RESERVE ||
      source.text.slice(e.start, e.end) !== e.emitted
    )
      return [];
    return [{ at: e.markerAt, text: ` (dup of ${m.layer} ${m.id})` }];
  });
  if (edits.length === 0) return source.text;
  let text = source.text;
  for (const edit of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, edit.at) + edit.text + text.slice(edit.at);
  const at = text.indexOf("\n");
  return at < 0 ? `${text}\n${PRIORITY_NOTE}` : `${text.slice(0, at)}\n${PRIORITY_NOTE}${text.slice(at)}`;
}
