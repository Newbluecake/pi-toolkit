/** Deterministic, pi-free migration planner. Root source bytes are never rewritten. */
import { createHash } from "node:crypto";
import { parseFrontmatter, stripFrontmatter, stripLeadingDriftHeader } from "../frontmatter.js";
import { entryHash, splitEntries, stripInlineMeta } from "../jev/entries.js";
import type { JevIndexV1, MemEntry, InlineMeta, ReviewSuggestion } from "../jev/contracts.js";
import { bodyBytes, serializeBlock, type BlockMeta } from "./format.js";
import { canonicalTopic } from "./naming.js";

export interface MigrationSource {
  name: string;
  raw: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}
export const sourceSha = (raw: string): string => createHash("sha256").update(raw).digest("hex");
export interface MigrationPlan {
  blocks: { name: string; content: string }[];
  sidecar: JevIndexV1;
  whole: string[];
  report: {
    files: {
      name: string;
      sha256: string;
      size: number;
      mtimeMs: number;
      frontmatter: Record<string, string>;
      h1: string[];
      blocks: string[];
      whole: boolean;
      mixedAuthority: boolean;
      retained?: true;
    }[];
    global: string[];
    pointers: string[];
    oversize: string[];
    audience: string[];
    merged: { topic: string; files: string[] }[];
    inlineErrors: { file: string; line: number; errors: readonly string[] }[];
    residue: { id: string; origin: string; bytes: number; preview: string }[];
    wholeInline: { file: string; line: number; meta: InlineMeta }[];
  };
}
export function planMigration(
  sources: readonly MigrationSource[],
  sidecar: JevIndexV1 = { v: 1, entries: {} },
  today = "1970-01-01",
): MigrationPlan {
  const plan: MigrationPlan = {
    blocks: [],
    sidecar: { ...sidecar, entries: {} },
    whole: [],
    report: {
      files: [],
      global: [],
      pointers: [],
      oversize: [],
      audience: [],
      merged: [],
      inlineErrors: [],
      residue: [],
      wholeInline: [],
    },
  };
  const seq = new Map<string, number>(),
    topics = new Map<string, string[]>();
  const suggestions: ReviewSuggestion[] = [...(sidecar.review?.suggestions ?? [])];
  for (const f of [...sources].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const effective = stripLeadingDriftHeader(f.raw.replace(/^\uFEFF/, ""));
    const fm = parseFrontmatter(effective),
      fields = fm?.fields ?? new Map<string, string>();
    const cc = /^(feedback|user|project|reference)_/.exec(f.name);
    const defaultAuthority = cc
      ? cc[1] === "feedback" || cc[1] === "user"
        ? "user"
        : "agent"
      : fields.get("source") === "agent"
        ? "agent"
        : "user";
    const entries = splitEntries(f.name, f.raw.replace(/^\uFEFF/, ""), {
      handWritten: defaultAuthority === "user",
      status: "active",
    });
    const mixedAuthority = entries.some((e) => e.authority !== defaultAuthority);
    const fileReport: MigrationPlan["report"]["files"][number] = {
      name: f.name,
      sha256: f.sha256,
      size: f.size,
      mtimeMs: f.mtimeMs,
      frontmatter: Object.fromEntries(fields),
      h1: effective.split(/\r?\n/).filter((l) => /^#\s/.test(l)),
      blocks: [],
      whole: false,
      mixedAuthority,
    };
    plan.report.files.push(fileReport);
    if (f.name === "MEMORY.md") {
      fileReport.retained = true;
      continue;
    }
    const explicitTopic = fields.get("topic"),
      validTopic = explicitTopic && canonicalTopic(explicitTopic) === explicitTopic ? explicitTopic : undefined;
    const topic =
      f.name === "core.md" || fields.get("pin") === "true"
        ? "general"
        : (validTopic ?? canonicalTopic(cc?.[1] ?? f.name.slice(0, -3)) ?? "general");
    topics.set(topic, [...(topics.get(topic) ?? []), f.name]);
    const lines = f.raw.split("\n"),
      covered = new Set<number>();
    // Mark only genuine headings outside opaque fences; code containing '# ' is not metadata.
    const prefixLength = f.raw.length - effective.length;
    const bodyStart = prefixLength + (fm?.bodyStart ?? 0);
    const startLine = f.raw.slice(0, bodyStart).split("\n").length - 1;
    for (let i = 0; i < startLine; i++) covered.add(i);
    let fence = false;
    for (let i = startLine; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(```|~~~)/.test(l)) {
        fence = !fence;
        continue;
      }
      if (!fence && (/^#{1,3}\s/.test(l) || !l.trim())) covered.add(i);
    }
    for (const e of entries) for (let i = e.lineStart - 1; i < e.lineEnd; i++) covered.add(i);
    const residue: [number, number][] = [];
    for (let i = startLine; i < lines.length; i++)
      if (!covered.has(i) && lines[i]!.trim()) {
        const start = i;
        while (i + 1 < lines.length && !covered.has(i + 1) && lines[i + 1]!.trim()) i++;
        residue.push([start, i]);
      }
    const add = (
      body: string,
      authority: "user" | "agent",
      entry?: MemEntry,
      span?: [number, number],
      wholeInline?: InlineMeta,
    ): void => {
      const inline = wholeInline ?? entry?.inline;
      const n = (seq.get(topic) ?? 0) + 1;
      seq.set(topic, n);
      const id = `${topic}.${String(n).padStart(3, "0")}`;
      const hash = entryHash(body),
        tags = sidecar.entries[hash];
      const stamp = tags?.at ?? fields.get("updated") ?? new Date(f.mtimeMs).toISOString();
      const at = Number.isFinite(Date.parse(stamp)) ? stamp : `${today}T00:00:00.000Z`;
      let scope: "global" | "topic" = f.name === "core.md" ? "global" : "topic";
      const pointer = /(?:docs\/|[A-Za-z0-9_./-]+\.md(?:#[^\s]+)?)/g;
      const stripped = body.replace(pointer, "").replace(/[\s\p{P}\p{S}]/gu, "");
      const suspected = pointer.test(body);
      const pure =
        (tags?.type === "pointer" && (tags.typeP ?? 0) >= 0.7) || (suspected && Array.from(stripped).length <= 30);
      if (authority === "user" && scope === "global" && pure) scope = "topic";
      const meta: BlockMeta = {
        kind: "block",
        authority,
        status: "active",
        created: at,
        updated: at,
        version: 1,
        ...(authority === "user" ? { scope } : {}),
        ...(authority === "user" && scope === "global" ? { audience: "main" as const } : {}),
        ...(entry?.section ? { section: entry.section } : {}),
        ...(entry?.heading ? { heading: entry.heading } : {}),
        ...(inline?.expires ? { expires: inline!.expires } : {}),
        ...(inline?.until ? { until: inline!.until } : {}),
        ...(inline?.isPrivate ? { private: true as const } : {}),
        ...(inline?.tagsAdd || inline?.tagsRemove
          ? { tags: { add: inline!.tagsAdd ?? [], remove: inline!.tagsRemove ?? [] } }
          : {}),
        ...(cc && fields.get("description") ? { title: fields.get("description")! } : {}),
        ...(cc && fields.get("read_when") ? { when: fields.get("read_when")! } : {}),
        ...(span
          ? { residue: true as const, origin: { file: f.name, lines: [span[0] + 1, span[1] + 1] as const } }
          : {}),
      };
      if (span) {
        let section = "",
          h3 = "";
        for (const l of lines.slice(startLine, span[0])) {
          if (/^##\s/.test(l)) {
            section = l.replace(/^##\s/, "").trim();
            h3 = "";
          } else if (/^###\s/.test(l)) h3 = l.replace(/^###\s/, "").trim();
        }
        if (section) meta.section = section;
        if (h3) meta.heading = section ? `${section} › ${h3}` : h3;
        plan.report.residue.push({
          id,
          origin: `${f.name}#L${span[0] + 1}-L${span[1] + 1}`,
          bytes: bodyBytes(body),
          preview: Array.from(body).slice(0, 80).join(""),
        });
      }
      const suggest = (kind: ReviewSuggestion["kind"]): void => {
        suggestions.push({ id: `migrate-${id}-${kind}`, kind, a: { hash, anchor: id }, p: 1, at });
      };
      if (meta.scope === "global") {
        plan.report.global.push(id);
        plan.report.audience.push(id);
      }
      if (suspected) {
        plan.report.pointers.push(id);
        if (!pure) suggest("pointer");
      }
      if (fields.get("pin") === "true" && f.name !== "core.md" && authority === "user") suggest("scope-check");
      if (bodyBytes(body) > 1024) {
        plan.report.oversize.push(id);
        suggest("oversize");
      }
      if (tags) plan.sidecar.entries[hash] = tags;
      fileReport.blocks.push(id);
      plan.blocks.push({
        name: `${id}.md`,
        content: serializeBlock(meta, stripInlineMeta(body), { allowOversize: true }),
      });
    };
    for (const e of entries)
      if (e.inlineErrors.length)
        plan.report.inlineErrors.push({ file: f.name, line: e.lineStart, errors: e.inlineErrors });
    if (!mixedAuthority && (residue.length > 0 || (entries.length === 0 && stripFrontmatter(effective).trim()))) {
      fileReport.whole = true;
      plan.whole.push(f.name);
      const common: {
        present: boolean;
        expires?: string;
        until?: string;
        tagsAdd?: readonly string[];
        tagsRemove?: readonly string[];
        isPrivate?: true;
      } = { present: false };
      let ambiguous = false;
      for (const key of ["expires", "until"] as const) {
        const values = entries.map((e) => e.inline[key]);
        if (
          values.length &&
          values.every((v) => JSON.stringify(v) === JSON.stringify(values[0])) &&
          values[0] !== undefined
        )
          Object.assign(common, { [key]: values[0] });
        else if (values.some((v) => v !== undefined)) ambiguous = true;
      }
      // tags is one field: never inherit only the add half when remove differs.
      const tagValues = entries.map((e) => ({ add: e.inline.tagsAdd, remove: e.inline.tagsRemove }));
      if (tagValues.length && tagValues.every((v) => JSON.stringify(v) === JSON.stringify(tagValues[0]))) {
        if (tagValues[0]!.add !== undefined) common.tagsAdd = tagValues[0]!.add;
        if (tagValues[0]!.remove !== undefined) common.tagsRemove = tagValues[0]!.remove;
      } else if (tagValues.some((v) => v.add !== undefined || v.remove !== undefined)) ambiguous = true;
      // Privacy is monotone: one private entry makes the whole fallback private.
      if (entries.some((e) => e.inline.isPrivate)) common.isPrivate = true;
      if (ambiguous || entries.some((e) => e.inline.isPrivate !== entries[0]?.inline.isPrivate))
        for (const e of entries) plan.report.wholeInline.push({ file: f.name, line: e.lineStart, meta: e.inline });
      add(stripInlineMeta(stripFrontmatter(effective)), defaultAuthority, undefined, undefined, common);
    } else {
      for (const e of entries) add(e.body, e.authority, e);
      for (const span of residue)
        add(stripInlineMeta(lines.slice(span[0], span[1] + 1).join("\n")), "agent", undefined, span);
    }
  }
  plan.report.merged = [...topics].filter(([, files]) => files.length > 1).map(([topic, files]) => ({ topic, files }));
  if (suggestions.length || sidecar.review)
    plan.sidecar = {
      ...plan.sidecar,
      review: {
        lastRunAt: sidecar.review?.lastRunAt ?? "",
        corpusFp: sidecar.review?.corpusFp ?? "",
        suggestions,
        dismissed: sidecar.review?.dismissed ?? [],
      },
    };
  return plan;
}
