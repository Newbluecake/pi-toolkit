import { parseFrontmatter, stripFrontmatter } from "../frontmatter.js";
import { MemoryError } from "../paths.js";
import { parseArchiveName } from "./naming.js";
import { computeRev } from "./rev.js";
export { computeRev } from "./rev.js";
export const BLOCK_BODY_MAX_BYTES = 1024;
export const MAX_FRONTMATTER_BYTES = 2048;
export interface BlockMeta {
  kind: "block";
  authority: "user" | "agent";
  scope?: "global" | "topic";
  /** #39 P3a hub compat append (Root-approved ONLY this field): marks a block owned by the
   * hub-memory store (`<stateDir>/hub-memory`). Hub blocks are always `authority:"user"`;
   * provenance (grant/src/from) lives in the hub store's own `items.json`, not here. */
  storageScope?: "hub";
  audience?: "all" | "main" | "child";
  expires?: string;
  until?: string;
  supersededBy?: string;
  status: "active" | "superseded" | "archived";
  section?: string;
  heading?: string;
  residue?: true;
  origin?: { file: string; lines: readonly [number, number] };
  tags?: { add: readonly string[]; remove: readonly string[] };
  private?: true;
  title?: string;
  when?: string;
  created: string;
  updated: string;
  version: number;
}
export interface ParsedBlock {
  id: string;
  topic: string;
  seq: number;
  meta: BlockMeta;
  body: string;
  raw: string;
  rev: string;
  errors: readonly string[];
}
export function bodyBytes(body: string): number {
  return Buffer.byteLength(stripFrontmatter(body.replace(/^\uFEFF/, "")).replace(/\s+$/, ""), "utf8");
}
export function isExpired(meta: BlockMeta, today: string): boolean {
  return meta.expires !== undefined && meta.expires < today;
}
export function isResident(meta: BlockMeta): boolean {
  return meta.authority === "user" && meta.scope === "global" && meta.status === "active";
}
const ORDER = [
  "kind",
  "authority",
  "scope",
  "storageScope",
  "audience",
  "expires",
  "until",
  "supersededBy",
  "status",
  "section",
  "heading",
  "residue",
  "origin",
  "tags",
  "private",
  "title",
  "when",
  "created",
  "updated",
  "version",
] as const;
export const META_LIMITS = { until: 120, section: 80, heading: 120, title: 110, when: 70 } as const;
const LIMITS: Record<string, number> = META_LIMITS;
/** Truncate at code point boundaries, including the UTF-8 ellipsis in the budget. */
export function truncateMeta(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  let out = "";
  for (const cp of value) {
    if (Buffer.byteLength(out + cp) > limit - 3) break;
    out += cp;
  }
  return out + "…";
}
function decode(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* invalid quotes remain visible */
    }
  }
  return value;
}
export function parseBlockFile(
  name: string,
  raw: string,
  opts?: { softLimits?: true; onSoftLimit?: (field: keyof typeof META_LIMITS, value: string) => void },
): ParsedBlock | { stray: true; name: string } {
  const parsed = parseArchiveName(name);
  const clean = raw.replace(/^\uFEFF/, "");
  const fm = parseFrontmatter(clean);
  if (!parsed || !fm || fm.fields.get("kind") !== "block") return { stray: true, name };
  const errors: string[] = [];
  if (
    Buffer.byteLength(clean.slice(0, fm.bodyStart)) > MAX_FRONTMATTER_BYTES ||
    clean.slice(0, fm.bodyStart).split("\n").length > 42
  )
    errors.push("frontmatter exceeds limit");
  const values = new Map([...fm.fields].map(([k, v]) => [k, decode(v)]));
  for (const key of values.keys())
    if (!(ORDER as readonly string[]).includes(key)) errors.push(`unknown field: ${key}`);
  const meta: BlockMeta = { kind: "block", authority: "agent", status: "active", created: "", updated: "", version: 1 };
  const enumField = (
    key: "authority" | "scope" | "storageScope" | "audience" | "status",
    allowed: readonly string[],
  ): void => {
    const value = values.get(key);
    if (value === undefined) return;
    if (!allowed.includes(value)) {
      errors.push(`invalid ${key}`);
      return;
    }
    Object.assign(meta, { [key]: value });
  };
  enumField("authority", ["user", "agent"]);
  enumField("scope", ["global", "topic"]);
  enumField("storageScope", ["hub"]);
  enumField("audience", ["all", "main", "child"]);
  enumField("status", ["active", "superseded", "archived"]);
  if (meta.authority === "agent" && meta.scope !== undefined) {
    delete meta.scope;
    errors.push("agent scope ignored");
  }
  if (meta.authority === "agent" && meta.storageScope !== undefined) {
    delete meta.storageScope;
    errors.push("agent storageScope ignored");
  }
  for (const key of ["until", "section", "heading", "title", "when"] as const) {
    const value = values.get(key);
    if (value === undefined) continue;
    if (/[\r\n]/.test(value)) errors.push(`invalid ${key}`);
    else if (opts?.softLimits && Buffer.byteLength(value) > LIMITS[key]!) {
      opts.onSoftLimit?.(key, value);
      meta[key] = truncateMeta(value, LIMITS[key]!);
      if (key === "section") errors.push("E_SECTION_TOO_LARGE");
      if (!errors.includes("E_META_SOFT")) errors.push("E_META_SOFT");
    } else if (key === "section") {
      meta.section = value;
      if (Buffer.byteLength(value) > LIMITS.section!) errors.push("E_SECTION_TOO_LARGE");
    } else if (Buffer.byteLength(value) > LIMITS[key]!) errors.push(`invalid ${key}`);
    else meta[key] = value;
  }
  const expires = values.get("expires");
  if (expires !== undefined) {
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(expires) &&
      Number.isFinite(Date.parse(expires)) &&
      new Date(expires).toISOString().slice(0, 10) === expires
    )
      meta.expires = expires;
    else errors.push("invalid expires");
  }
  const supersededBy = values.get("supersededBy");
  if (supersededBy !== undefined) {
    if (parseArchiveName(`${supersededBy}.md`)) {
      meta.supersededBy = supersededBy;
      meta.status = "superseded";
    } else errors.push("invalid supersededBy");
  }
  for (const key of ["private", "residue"] as const) {
    const value = values.get(key);
    if (value === "true") meta[key] = true;
    else if (value !== undefined) errors.push(`invalid ${key}`);
  }
  const origin = values.get("origin");
  if (origin !== undefined) {
    const m = /^([^/\r\n#]+\.md)#L([1-9][0-9]*)-L([1-9][0-9]*)$/.exec(origin);
    if (m && Number(m[2]) <= Number(m[3]) && Number.isSafeInteger(Number(m[3])))
      meta.origin = { file: m[1]!, lines: [Number(m[2]), Number(m[3])] };
    else errors.push("invalid origin");
  }
  const tags = values.get("tags");
  if (tags !== undefined) {
    const add: string[] = [],
      remove: string[] = [];
    for (const token of tags.split(",")) {
      if (/^[+-][a-z][a-z0-9-]{1,31}$/.test(token)) (token[0] === "+" ? add : remove).push(token.slice(1));
      else errors.push("invalid tags");
    }
    meta.tags = { add, remove };
  }
  for (const key of ["created", "updated"] as const) {
    const value = values.get(key);
    if (value !== undefined && Number.isFinite(Date.parse(value))) meta[key] = value;
    else errors.push(`invalid ${key}`);
  }
  const version = Number(values.get("version") ?? 1);
  if (Number.isSafeInteger(version) && version > 0) meta.version = version;
  else errors.push("invalid version");
  const body = stripFrontmatter(clean).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (bodyBytes(body) > BLOCK_BODY_MAX_BYTES) errors.push("E_TOO_LARGE");
  if (/<!--[ \t]*mem\b/.test(body)) errors.push("inline memory metadata remains");
  return {
    id: `${parsed.topic}.${name.split(".")[1]}`,
    topic: parsed.topic,
    seq: parsed.seq,
    meta,
    body,
    raw,
    rev: computeRev(meta.version, raw),
    errors,
  };
}
/** allowOversize is reserved for migration planning; normal create/replace never pass it. */
export function serializeBlock(meta: BlockMeta, body: string, opts?: { allowOversize?: true }): string {
  if (!opts?.allowOversize && bodyBytes(body) > BLOCK_BODY_MAX_BYTES)
    throw new MemoryError("E_TOO_LARGE: block body exceeds 1024 UTF-8 bytes");
  if (/<!--[ \t]*mem\b/.test(body))
    throw new MemoryError("E_META: inline memory metadata must be moved to frontmatter");
  const fields: string[] = [];
  for (const key of ORDER) {
    let value: unknown = meta[key];
    if (value === undefined || (key === "scope" && meta.authority !== "user")) continue;
    if (key === "storageScope" && meta.authority !== "user") continue;
    if (key === "origin" && meta.origin)
      value = `${meta.origin.file}#L${meta.origin.lines[0]}-L${meta.origin.lines[1]}`;
    if (key === "tags" && meta.tags)
      value = [...meta.tags.add.map((s) => `+${s}`), ...meta.tags.remove.map((s) => `-${s}`)].join(",");
    if (typeof value === "string") {
      if (/[\r\n]/.test(value)) throw new MemoryError(`E_META: invalid ${key}`);
      if (LIMITS[key] !== undefined && Buffer.byteLength(value) > LIMITS[key]!) {
        if (key === "section") {
          if (!opts?.allowOversize) throw new MemoryError("E_SECTION_TOO_LARGE: section exceeds 80 UTF-8 bytes");
        } else throw new MemoryError(`E_META: invalid ${key}`);
      }
      value = /["\\]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
    }
    fields.push(`${key}: ${String(value)}`);
  }
  const head = `---\n${fields.join("\n")}\n---\n\n`;
  if (Buffer.byteLength(head) > MAX_FRONTMATTER_BYTES || fields.length > 40)
    throw new MemoryError("E_META: frontmatter exceeds limit");
  const raw = head + body.replace(/\s+$/, "") + "\n";
  const check = parseBlockFile("general.001.md", raw);
  const errors =
    "stray" in check
      ? ["stray"]
      : check.errors.filter(
          (error) => !opts?.allowOversize || (error !== "E_TOO_LARGE" && error !== "E_SECTION_TOO_LARGE"),
        );
  if (errors.length) throw new MemoryError(`E_META: ${errors.join(", ")}`);
  return raw;
}
