/** Offline transcript extraction (plan R3b). Pure, pi-free, no retained state or text output.
 *  #25 B0 (BD2): draft-era optional fields are accepted leniently (append-only compatibility);
 *  `scanReflexLine` additionally surfaces the entry id for fork deduplication. */
import type { PromotionRow } from "./promotion.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function version(value: unknown): value is number {
  return number(value) && Number.isInteger(value) && value > 0;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

/**
 * Recognize only the three persisted v1 entry envelopes. Validate fields used by the
 * promotion fold (and the v1 contract), rather than casting arbitrary JSON into stats.
 * Extra fields remain accepted for append-only compatibility; malformed rows are skipped.
 */
export function extractReflexRows(line: string): PromotionRow | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!object(entry)) return undefined;
  if (entry.type === "custom" && entry.customType === "subagent:reflex-record") {
    const rec = entry.data;
    if (
      !object(rec) ||
      rec.v !== 1 ||
      !oneOf(rec.kind, ["shadow", "fallback", "ambiguous", "repeat"]) ||
      !number(rec.at) ||
      !text(rec.scriptId) ||
      !version(rec.scriptVer) ||
      !oneOf(rec.state, ["shadow", "auto", "demoted"]) ||
      !oneOf(rec.band, ["high", "ambiguous"]) ||
      !text(rec.requestDigest) ||
      !number(rec.chars) ||
      (rec.candidates !== undefined && !strings(rec.candidates)) ||
      (rec.reasked !== undefined && rec.reasked !== true)
    )
      return undefined;
    if (
      rec.port !== undefined &&
      (!object(rec.port) ||
        !oneOf(rec.port.outcome, ["ok", "uncertain", "unavailable", "error", "timeout"]) ||
        !number(rec.port.ms) ||
        !version(rec.port.portVer) ||
        (rec.port.reason !== undefined && typeof rec.port.reason !== "string") ||
        // #25: draft rows name the port directly (BD11 — builtin rows never write it)
        (rec.port.portId !== undefined && !oneOf(rec.port.portId, PORT_ID_SET)))
    )
      return undefined;
    // #25 draft-era optional fields (BD11): only these shapes are accepted; absent on builtin rows.
    if (
      (rec.origin !== undefined && rec.origin !== "draft") ||
      (rec.draftHash !== undefined && typeof rec.draftHash !== "string") ||
      (rec.templateHash !== undefined && typeof rec.templateHash !== "string")
    )
      return undefined;
    if (
      rec.model !== undefined &&
      (!object(rec.model) ||
        !oneOf(rec.model.agree, ["agree", "no-tool", "diverge", "unknown"]) ||
        !strings(rec.model.tools))
    )
      return undefined;
    return { kind: "record", rec: rec as unknown as Extract<PromotionRow, { kind: "record" }>["rec"] };
  }
  if (entry.type === "custom" && entry.customType === "subagent:reflex-correction") {
    const c = entry.data;
    if (
      !object(c) ||
      c.v !== 1 ||
      !number(c.at) ||
      !oneOf(c.targetKind, ["shadow", "answer"]) ||
      !text(c.targetScriptId) ||
      !version(c.targetScriptVer) ||
      !text(c.targetDigest) ||
      !number(c.deltaMs) ||
      !text(c.correctionDigest) ||
      // #25 draft-targeted corrections (BA §4.5 写入面)
      (c.targetOrigin !== undefined && c.targetOrigin !== "draft") ||
      (c.targetTemplateHash !== undefined && typeof c.targetTemplateHash !== "string")
    )
      return undefined;
    return { kind: "correction", c: c as unknown as Extract<PromotionRow, { kind: "correction" }>["c"] };
  }
  if (entry.type === "custom_message" && entry.customType === "subagent:reflex") {
    const details = entry.details;
    if (
      !object(details) ||
      details.v !== 1 ||
      !text(details.scriptId) ||
      !version(details.scriptVer) ||
      !oneOf(details.portId, ["jobs.list", "fleet.status", "quota.summary", "git.status", "sessions.recent"]) ||
      !version(details.portVer) ||
      !number(details.ms) ||
      !text(details.requestDigest) ||
      !number(details.lines) ||
      typeof details.truncated !== "boolean" ||
      !object(details.facts) ||
      !Object.values(details.facts).every(
        (value) =>
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)),
      )
    )
      return undefined;
    return { kind: "answer", details: details as unknown as Extract<PromotionRow, { kind: "answer" }>["details"] };
  }
  return undefined;
}

const PORT_ID_SET: readonly string[] = ["jobs.list", "fleet.status", "quota.summary", "git.status", "sessions.recent"];

export interface ScannedLine {
  /** The session entry's envelope `id` (fork copies carry the SAME id — B5 dedupes on it). */
  readonly entryId?: string;
  readonly row?: PromotionRow;
}

/** #25 B0 (BD2): parse one jsonl line into `{entryId?, row}` — `extractReflexRows` unchanged and
 *  delegated to; reflex-shadow.mjs / the backtest scan use this for fork deduplication. */
export function scanReflexLine(line: string): ScannedLine {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return {};
  }
  if (!object(entry)) return {};
  const id = (entry as Record<string, unknown>).id;
  const entryId = typeof id === "string" && id.length > 0 ? id : undefined;
  const row = extractReflexRows(line);
  return { ...(entryId !== undefined ? { entryId } : {}), ...(row !== undefined ? { row } : {}) };
}
