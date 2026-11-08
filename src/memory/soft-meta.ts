/** Read-only compatibility for legacy over-limit metadata. No data is written.
 * Soft diagnostics are never notified at startup: /mem doctor displays them on demand.
 * Each directory/field/value is recorded once per process without retaining the value. */
import { createHash } from "node:crypto";
import { parseFrontmatter, stripLeadingDriftHeader } from "./frontmatter.js";
import { META_LIMITS, truncateMeta } from "./blocks/format.js";

export type SoftMetaField = keyof typeof META_LIMITS;
const KEY = Symbol.for("pi-subagent:memory-soft-meta-diagnostics");
const CAP = 4096;
type State = Map<string, { dir: string; field: SoftMetaField; bytes: number; limit: number }>;
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  return (g[KEY] ??= new Map());
}
/** Deduplicate without retaining the potentially private value. No startup notification is emitted. */
export function recordSoftMeta(dir: string, field: SoftMetaField, value: string): void {
  const key = createHash("sha256")
    .update(JSON.stringify([dir, field, value]))
    .digest("hex");
  const s = state();
  // Replace entries from the old reload-persistent shape which had no byte counts.
  const old = s.get(key);
  if (old && Number.isSafeInteger(old.bytes) && old.limit === META_LIMITS[field]) return;
  if (!old && s.size >= CAP) s.delete(s.keys().next().value!);
  s.set(key, { dir, field, bytes: Buffer.byteLength(value), limit: META_LIMITS[field] });
}
export function softMetaDiagnostics(
  dir: string,
): readonly { code: "E_META_SOFT"; field: SoftMetaField; bytes: number; limit: number }[] {
  return [...state().values()]
    .filter((d) => d.dir === dir && Number.isSafeInteger(d.bytes) && Number.isSafeInteger(d.limit))
    .map((d) => ({ code: "E_META_SOFT", field: d.field, bytes: d.bytes, limit: d.limit }));
}
/** Match the serializer's JSON decoding, retaining the legacy fallback for non-JSON quotes. */
export function decodeSoftScalar(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string" && !/[\r\n]/.test(parsed)) return parsed;
    } catch {
      /* legacy quoted literal; do not interpret invalid JSON */
    }
  }
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
    return value.slice(1, -1);
  return value;
}
/** Normalize only a parseable legacy frontmatter, preserving line count and original source on disk. */
export function softLegacyMetadata(raw: string, dir: string): string {
  const effective = stripLeadingDriftHeader(raw);
  const fm = parseFrontmatter(effective);
  if (!fm) return raw;
  const prefix = raw.slice(0, raw.length - effective.length);
  const head = effective
    .slice(0, fm.bodyStart)
    .replace(/^(title|when|section|heading|until)[ \t]*:([^\r\n]*)/gm, (line, key: SoftMetaField, part: string) => {
      const value = decodeSoftScalar(part.trim());
      if (/[\r\n]/.test(value) || Buffer.byteLength(value) <= META_LIMITS[key]) return line;
      recordSoftMeta(dir, key, value);
      return `${key}: ${JSON.stringify(truncateMeta(value, META_LIMITS[key]))}`;
    });
  return prefix + head + effective.slice(fm.bodyStart);
}
