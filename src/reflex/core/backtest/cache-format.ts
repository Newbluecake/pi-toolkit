/** B3 application cache. Text is private cache data, never an export DTO. Pi-free. */
import { createHash } from "node:crypto";
import { CORRECTION_RE } from "../gate.js";
import { normalizeInput } from "../normalize.js";
import type { CorrectionFact, SessionHeaderFact, Turn } from "../types.js";
import type { LiveEvidenceRow } from "../promotion.js";
import { MARKERS_VERSION } from "./markers.js";

export interface FileStamp {
  file: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}
export interface CacheVersions {
  cacheV: number;
  normalizeVersion: string;
  markersVersion: string;
  correctionHash: string;
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** No upstream normalizeVersion exists: fingerprint the actual implementation, not a duplicate constant. */
export function cacheVersions(): CacheVersions {
  return {
    cacheV: 2,
    normalizeVersion: hash(normalizeInput.toString()),
    markersVersion: String(MARKERS_VERSION),
    correctionHash: hash(CORRECTION_RE.source),
  };
}
export function invalidationKey(files: readonly FileStamp[], versions = cacheVersions()): string {
  return hash(JSON.stringify({ versions, files: [...files].sort((a, b) => a.file.localeCompare(b.file)) }));
}
export interface CachedFile {
  stamp: FileStamp;
  header: SessionHeaderFact;
  lines: number;
  lastEntryId: string;
}
export interface CorpusCache {
  key: string;
  files: readonly CachedFile[];
  turns: readonly Turn[];
  corrections: readonly CorrectionFact[];
  liveRows: readonly LiveEvidenceRow[];
  counts: Readonly<Record<string, number>>;
}
export function encodeCache(cache: CorpusCache): string {
  return (
    [
      JSON.stringify({ k: "meta", v: 2, key: cache.key, counts: cache.counts }),
      ...cache.files.map((value) => JSON.stringify({ k: "file", value })),
      ...cache.turns.map((value) => JSON.stringify({ k: "turn", value })),
      ...cache.corrections.map((value) => JSON.stringify({ k: "correction", value })),
      ...cache.liveRows.map((value) => JSON.stringify({ k: "live", value })),
      JSON.stringify({ k: "end", hash: hash(JSON.stringify(cache)) }),
    ].join("\n") + "\n"
  );
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
export function decodeCache(text: string, expectedKey: string): CorpusCache | undefined {
  try {
    const rows: unknown[] = text
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    const first = rows.shift(),
      end = rows.pop();
    if (
      !obj(first) ||
      first["k"] !== "meta" ||
      first["v"] !== 2 ||
      first["key"] !== expectedKey ||
      !obj(first["counts"]) ||
      !Object.values(first["counts"]).every(num) ||
      !obj(end) ||
      end["k"] !== "end"
    )
      return undefined;
    const files: CachedFile[] = [],
      turns: Turn[] = [],
      corrections: CorrectionFact[] = [],
      liveRows: LiveEvidenceRow[] = [];
    for (const row of rows) {
      if (!obj(row) || !obj(row["value"])) return undefined;
      const v = row["value"];
      if (row["k"] === "file") {
        if (!obj(v["stamp"]) || !obj(v["header"]) || !num(v["lines"]) || typeof v["lastEntryId"] !== "string")
          return undefined;
        const s = v["stamp"],
          h = v["header"];
        if (
          typeof s["file"] !== "string" ||
          ![s["size"], s["mtimeMs"], s["dev"], s["ino"]].every(num) ||
          typeof h["file"] !== "string" ||
          typeof h["id"] !== "string" ||
          typeof h["cwd"] !== "string" ||
          !num(h["timestamp"])
        )
          return undefined;
        files.push(v as unknown as CachedFile);
      } else if (row["k"] === "turn" || row["k"] === "correction") {
        if (
          typeof v["session"] !== "string" ||
          typeof v["entryId"] !== "string" ||
          !num(v["at"]) ||
          !["tui", "web", "replay", "injected", "steer"].includes(String(v["origin"]))
        )
          return undefined;
        if (row["k"] === "correction") {
          if (typeof v["corrHit"] !== "boolean") return undefined;
          corrections.push(v as unknown as CorrectionFact);
        } else {
          if (
            typeof v["text"] !== "string" ||
            typeof v["digest"] !== "string" ||
            typeof v["cwd"] !== "string" ||
            !num(v["settledAt"]) ||
            !num(v["imageCount"]) ||
            !num(v["toolCount"]) ||
            typeof v["hasWrite"] !== "boolean" ||
            !strings(v["shapes"]) ||
            !strings(v["unknownFacts"]) ||
            !(v["unknownFacts"] as string[]).every((x) =>
              ["idle", "pendingMessages", "topicSwitchActive", "goalBusy", "inFlight", "sourceMode"].includes(x),
            ) ||
            !["train", "holdout", "unscored"].includes(String(v["split"]))
          )
            return undefined;
          turns.push(v as unknown as Turn);
        }
      } else if (row["k"] === "live") {
        if (!["record", "answer", "correction"].includes(String(v["kind"]))) return undefined;
        liveRows.push(v as unknown as LiveEvidenceRow);
      } else return undefined;
    }
    const cache: CorpusCache = {
      key: expectedKey,
      files,
      turns,
      corrections,
      liveRows,
      counts: first["counts"] as Record<string, number>,
    };
    return end["hash"] === hash(JSON.stringify(cache)) ? cache : undefined;
  } catch {
    return undefined;
  }
}
