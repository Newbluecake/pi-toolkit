// Sidecar index (`<slug>/.jev/index.json`) and project taxonomy file
// (`<slug>/.jev/taxonomy.json`) store (jev-arch §4.3.1/§4.4, jev-plan J4).
//
// Both files are derived/config data the memory corpus can live without:
//  - reads are tolerant (missing ⇒ empty + NOT rebuilt; bad JSON ⇒ empty +
//    `rebuilt: true` so `/mem jev` can say `index rebuilt`);
//  - writes run their whole synchronous read → merge-by-hash → atomic
//    replace cycle INSIDE `withMemoryDirLock` (a lock held elsewhere ⇒ the
//    patch is dropped with "busy", never thrown, never queued — the next
//    tagging run rewrites the same data);
//  - `.jev/` is 0700 (`ensurePrivateDir` — refuses symlinks), files 0600
//    (`writeTempRegular` + `replaceAtomic`);
//  - caps (2000 entries / 1MB) are enforced on every write: `gcIndex` first
//    drops hashes that are no longer in the live corpus, then falls back to
//    oldest-`at` eviction; `writeIndexPatch` (which has no corpus view) skips
//    the corpus pass and only does the blind cap.
//
// No direct `node:fs` import (tests/memory/fs-guard.test.ts): every touch
// goes through `../safe-fs.js`. Pi-free root; no module-scope state (I4).

import { join } from "node:path";
import { MemoryError } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import { ensurePrivateDir, readRegular, replaceAtomic, unlinkRegular, writeTempRegular } from "../safe-fs.js";
import {
  A_INJECTED_AT_MAX,
  P_INJECTED_AT_MAX,
  SIDECAR_MAX_BYTES,
  SIDECAR_MAX_ENTRIES,
  type DismissedPair,
  type EntryHash,
  type EntryTags,
  type IndexPatch,
  type JevIndexV1,
  type ReviewSuggestionKind,
  type ReviewState,
  type ReviewSuggestion,
  type TaxonomyFileV1,
} from "./contracts.js";
import { mergeTaxonomy } from "./taxonomy.js";

/** `.jev/` under the canonical memory slug directory. */
export const JEV_DIR_NAME = ".jev";
const INDEX_NAME = "index.json";
const TAXONOMY_NAME = "taxonomy.json";
const INDEX_FILE_MODE = 0o600;

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function emptyIndex(): JevIndexV1 {
  return { v: 1, entries: {} };
}

// ───────────────────────────── shape validation (read tolerance) ─────────────────────────────

const ENTRY_TYPES: readonly string[] = ["rule", "pitfall", "procedure", "preference", "fact", "pointer"];
const TEMPORAL: readonly string[] = ["permanent", "dated", "event"];
/** #36 P0（arch r5 §4.4）：sanitizeSuggestions/sanitizeDismissed 共用的
 *  ReviewSuggestionKind 白名单 —— 必须与 contracts.ts 的联合类型逐字同步
 *  （由 tests/memory/jev/index-store.test.ts 的漂移测试钉住：联合 ↔ 本表
 *  双向一致，含编译期 `readonly ReviewSuggestionKind[]` 可赋值检查）。 */
export const REVIEW_SUGGESTION_KINDS: readonly ReviewSuggestionKind[] = [
  "duplicate",
  "supersedes",
  "conflict",
  "obsolete",
  "user-like",
  "expired-user",
  "until-check",
  "snapshot",
  "pointer",
  "oversize",
  "resident-budget",
  "scope-check",
  "legacy-drift",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeEntryTags(v: unknown): EntryTags | undefined {
  if (!isPlainObject(v)) return undefined;
  const tags: Record<string, { p: number; rev: number }> = {};
  if (isPlainObject(v["tags"])) {
    for (const [id, tv] of Object.entries(v["tags"])) {
      if (!isPlainObject(tv) || typeof tv["p"] !== "number" || typeof tv["rev"] !== "number") continue;
      tags[id] = { p: tv["p"], rev: tv["rev"] };
    }
  }
  if (
    typeof v["file"] !== "string" ||
    typeof v["type"] !== "string" ||
    !ENTRY_TYPES.includes(v["type"]) ||
    typeof v["typeP"] !== "number" ||
    typeof v["importance"] !== "number" ||
    ![0, 1, 2, 3].includes(v["importance"]) ||
    typeof v["guard"] !== "number" ||
    typeof v["temporal"] !== "string" ||
    !TEMPORAL.includes(v["temporal"]) ||
    typeof v["userLike"] !== "number" ||
    typeof v["model"] !== "string" ||
    typeof v["at"] !== "string" ||
    typeof v["taxonomyRev"] !== "string"
  ) {
    return undefined;
  }
  // #36 P0: keep the g1 scope-question answer when present; absent stays
  // absent so pre-#36 sidecars read/write byte-identically (old data first,
  // appended last — key order of the old serialization is unchanged).
  const globalP = typeof v["globalP"] === "number" && Number.isFinite(v["globalP"]) ? v["globalP"] : undefined;
  return {
    file: v["file"],
    type: v["type"] as EntryTags["type"],
    typeP: v["typeP"],
    importance: v["importance"] as EntryTags["importance"],
    tags,
    guard: v["guard"],
    temporal: v["temporal"] as EntryTags["temporal"],
    userLike: v["userLike"],
    model: v["model"],
    at: v["at"],
    taxonomyRev: v["taxonomyRev"],
    ...(globalP === undefined ? {} : { globalP }),
  };
}

function sanitizeSuggestions(v: unknown): readonly ReviewSuggestion[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ReviewSuggestion[] = [];
  for (const item of v) {
    if (!isPlainObject(item)) continue;
    const a = item["a"];
    const b = item["b"];
    if (
      typeof item["id"] !== "string" ||
      typeof item["kind"] !== "string" ||
      !REVIEW_SUGGESTION_KINDS.includes(item["kind"] as ReviewSuggestionKind) ||
      !isPlainObject(a) ||
      typeof a["hash"] !== "string" ||
      typeof a["anchor"] !== "string" ||
      typeof item["p"] !== "number" ||
      typeof item["at"] !== "string" ||
      (b !== undefined && (!isPlainObject(b) || typeof b["hash"] !== "string" || typeof b["anchor"] !== "string"))
    ) {
      continue;
    }
    out.push({
      id: item["id"],
      kind: item["kind"] as ReviewSuggestion["kind"],
      a: { hash: a["hash"], anchor: a["anchor"] },
      ...(isPlainObject(b) ? { b: { hash: b["hash"] as string, anchor: b["anchor"] as string } } : {}),
      p: item["p"],
      at: item["at"],
    });
  }
  return out;
}

function sanitizeDismissed(v: unknown): readonly DismissedPair[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: DismissedPair[] = [];
  for (const item of v) {
    if (isPlainObject(item) && typeof item["hashKey"] === "string" && typeof item["anchorKey"] === "string") {
      // #36 P0: optional kind/until ride along when valid (per-field read
      // tolerance — an invalid value drops just that field, the dismissal
      // itself survives with its legacy pairwise semantics).
      const kind =
        typeof item["kind"] === "string" && REVIEW_SUGGESTION_KINDS.includes(item["kind"] as ReviewSuggestionKind)
          ? (item["kind"] as DismissedPair["kind"])
          : undefined;
      const until =
        typeof item["until"] === "string" && Number.isFinite(Date.parse(item["until"])) ? item["until"] : undefined;
      out.push({
        hashKey: item["hashKey"],
        anchorKey: item["anchorKey"],
        ...(kind === undefined ? {} : { kind }),
        ...(until === undefined ? {} : { until }),
      });
    }
  }
  return out;
}

function sanitizeReview(v: unknown): ReviewState | undefined {
  if (!isPlainObject(v)) return undefined;
  const suggestions = sanitizeSuggestions(v["suggestions"]);
  const dismissed = sanitizeDismissed(v["dismissed"]);
  if (
    typeof v["lastRunAt"] !== "string" ||
    typeof v["corpusFp"] !== "string" ||
    suggestions === undefined ||
    dismissed === undefined
  ) {
    return undefined;
  }
  return { lastRunAt: v["lastRunAt"], corpusFp: v["corpusFp"], suggestions, dismissed };
}

/** Sanitize an A/P-layer cooldown map: string values with a parseable date
 *  survive, anything else is dropped per key (read tolerance). */
function sanitizeCooldownMap(v: unknown): Record<EntryHash, string> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<EntryHash, string> = {};
  for (const [hash, at] of Object.entries(v)) {
    if (typeof at === "string" && Number.isFinite(Date.parse(at))) out[hash] = at;
  }
  return out;
}

/** Bad/foreign JSON ⇒ `{index: empty, rebuilt: true}`; missing ⇒ empty, NOT
 *  rebuilt (a fresh project has not lost anything). Structurally-invalid
 *  entry values are dropped individually (the rest of the index survives). */
export function readIndex(dir: string): { index: JevIndexV1; rebuilt: boolean } {
  let text: string;
  try {
    text = readRegular(join(dir, JEV_DIR_NAME), INDEX_NAME).text;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return { index: emptyIndex(), rebuilt: false };
    return { index: emptyIndex(), rebuilt: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { index: emptyIndex(), rebuilt: true };
  }
  if (!isPlainObject(parsed) || parsed["v"] !== 1 || !isPlainObject(parsed["entries"])) {
    return { index: emptyIndex(), rebuilt: true };
  }
  const entries: Record<EntryHash, EntryTags> = {};
  for (const [hash, v] of Object.entries(parsed["entries"])) {
    const tags = sanitizeEntryTags(v);
    if (tags !== undefined) entries[hash] = tags;
  }
  const review = sanitizeReview(parsed["review"]);
  const aInjectedAt = sanitizeCooldownMap(parsed["aInjectedAt"]);
  const pInjectedAt = sanitizeCooldownMap(parsed["pInjectedAt"]);
  return {
    index: {
      v: 1,
      entries,
      ...(typeof parsed["lastTaggedAt"] === "string" ? { lastTaggedAt: parsed["lastTaggedAt"] } : {}),
      ...(review === undefined ? {} : { review }),
      ...(aInjectedAt === undefined || Object.keys(aInjectedAt).length === 0 ? {} : { aInjectedAt }),
      ...(pInjectedAt === undefined || Object.keys(pInjectedAt).length === 0 ? {} : { pInjectedAt }),
    },
    rebuilt: false,
  };
}

// ───────────────────────────── merge + caps ─────────────────────────────

/** Pure read → patch → merged (no fs). Upserts overwrite by hash; `remove`
 *  wins over an upsert of the same hash (explicit deletion); `review` and
 *  `lastTaggedAt` replace wholesale when present. */
export function mergeIndex(index: JevIndexV1, patch: IndexPatch): JevIndexV1 {
  const entries: Record<EntryHash, EntryTags> = { ...index.entries };
  for (const [hash, tags] of Object.entries(patch.upsert ?? {})) {
    entries[hash] = tags;
  }
  for (const hash of patch.remove ?? []) delete entries[hash];
  const aInjectedAt: Record<EntryHash, string> = { ...index.aInjectedAt, ...patch.aInjectedAt };
  const pInjectedAt: Record<EntryHash, string> = { ...index.pInjectedAt, ...patch.pInjectedAt };
  return {
    v: 1,
    entries,
    ...(patch.lastTaggedAt !== undefined || index.lastTaggedAt !== undefined
      ? { lastTaggedAt: patch.lastTaggedAt ?? index.lastTaggedAt }
      : {}),
    ...(patch.review !== undefined
      ? { review: patch.review }
      : index.review !== undefined
        ? { review: index.review }
        : {}),
    ...(Object.keys(aInjectedAt).length > 0 ? { aInjectedAt } : {}),
    ...(Object.keys(pInjectedAt).length > 0 ? { pInjectedAt } : {}),
  };
}

/** Keep the newest `keep` stamps (ISO 8601 UTC sorts lexicographically). */
function trimCooldownMap(map: Readonly<Record<EntryHash, string>>, keep: number): Record<EntryHash, string> {
  const keys = Object.keys(map);
  if (keys.length <= keep) return { ...map };
  const ordered = [...keys].sort((a, b) => {
    const atA = map[a]!;
    const atB = map[b]!;
    if (atA !== atB) return atA < atB ? -1 : 1; // oldest first
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const out: Record<EntryHash, string> = {};
  for (const key of ordered.slice(ordered.length - keep)) out[key] = map[key]!;
  return out;
}

function serializedBytes(entries: Readonly<Record<EntryHash, EntryTags>>): number {
  return Buffer.byteLength(JSON.stringify({ v: 1, entries }), "utf8");
}

function dropOldest(entries: Record<EntryHash, EntryTags>, keep: number): Record<EntryHash, EntryTags> {
  const keys = Object.keys(entries);
  if (keys.length <= keep) return entries;
  // Oldest `at` first — keep the NEWEST `keep` records (evict stale ones).
  const ordered = [...keys].sort((a, b) => {
    const atA = entries[a]!.at;
    const atB = entries[b]!.at;
    if (atA !== atB) return atA < atB ? -1 : 1; // oldest `at` first
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const out: Record<EntryHash, EntryTags> = {};
  for (const key of ordered.slice(ordered.length - keep)) out[key] = entries[key]!;
  return out;
}

function capBlind(index: JevIndexV1): JevIndexV1 {
  let entries = dropOldest({ ...index.entries }, SIDECAR_MAX_ENTRIES);
  while (Object.keys(entries).length > 1 && serializedBytes(entries) > SIDECAR_MAX_BYTES) {
    entries = dropOldest(entries, Object.keys(entries).length - 1);
  }
  const aInjectedAt =
    index.aInjectedAt === undefined ? undefined : trimCooldownMap(index.aInjectedAt, A_INJECTED_AT_MAX);
  const pInjectedAt =
    index.pInjectedAt === undefined ? undefined : trimCooldownMap(index.pInjectedAt, P_INJECTED_AT_MAX);
  return {
    ...index,
    entries,
    ...(aInjectedAt !== undefined && Object.keys(aInjectedAt).length > 0 ? { aInjectedAt } : {}),
    ...(pInjectedAt !== undefined && Object.keys(pInjectedAt).length > 0 ? { pInjectedAt } : {}),
  };
}

/** Corpus-aware GC (jev-arch §4.4): only acts when a cap is exceeded, and
 *  then FIRST drops hashes no longer present in the live corpus (their
 *  entries were edited or deleted — the tags are unreachable), falling back
 *  to oldest-`at` eviction if a cap is still exceeded. Under the caps the
 *  index is returned unchanged (temporarily-hidden entries — archived files
 *  — keep their tags). */
export function gcIndex(index: JevIndexV1, liveHashes: ReadonlySet<EntryHash>): JevIndexV1 {
  const count = Object.keys(index.entries).length;
  const aStampCount = Object.keys(index.aInjectedAt ?? {}).length;
  const pStampCount = Object.keys(index.pInjectedAt ?? {}).length;
  if (
    count <= SIDECAR_MAX_ENTRIES &&
    serializedBytes(index.entries) <= SIDECAR_MAX_BYTES &&
    aStampCount <= A_INJECTED_AT_MAX &&
    pStampCount <= P_INJECTED_AT_MAX
  )
    return index;
  const entries: Record<EntryHash, EntryTags> = {};
  for (const [hash, tags] of Object.entries(index.entries)) {
    if (liveHashes.has(hash)) entries[hash] = tags;
  }
  const aStamps: Record<EntryHash, string> = {};
  for (const [hash, at] of Object.entries(index.aInjectedAt ?? {})) {
    if (liveHashes.has(hash)) aStamps[hash] = at;
  }
  const pStamps: Record<EntryHash, string> = {};
  for (const [hash, at] of Object.entries(index.pInjectedAt ?? {})) {
    if (liveHashes.has(hash)) pStamps[hash] = at;
  }
  return capBlind({
    ...index,
    entries,
    ...(Object.keys(aStamps).length > 0 ? { aInjectedAt: aStamps } : {}),
    ...(Object.keys(pStamps).length > 0 ? { pInjectedAt: pStamps } : {}),
  });
}

/** Deterministic serialization: entry keys sorted so two runs tagging the
 *  same set produce byte-identical files. */
function serializeIndex(index: JevIndexV1): Buffer {
  const entries: Record<EntryHash, EntryTags> = {};
  for (const hash of Object.keys(index.entries).sort()) entries[hash] = index.entries[hash]!;
  const aInjectedAt: Record<EntryHash, string> = {};
  for (const hash of Object.keys(index.aInjectedAt ?? {}).sort()) aInjectedAt[hash] = index.aInjectedAt![hash]!;
  const pInjectedAt: Record<EntryHash, string> = {};
  for (const hash of Object.keys(index.pInjectedAt ?? {}).sort()) pInjectedAt[hash] = index.pInjectedAt![hash]!;
  return Buffer.from(
    JSON.stringify({
      ...index,
      entries,
      ...(Object.keys(aInjectedAt).length > 0 ? { aInjectedAt } : {}),
      ...(Object.keys(pInjectedAt).length > 0 ? { pInjectedAt } : {}),
    }),
    "utf8",
  );
}

// ───────────────────────────── writes ─────────────────────────────

function isLockBusy(err: unknown): boolean {
  return err instanceof MemoryError && err.message.includes("memory dir busy");
}

/** Read → merge-by-hash → atomic replace, inside the directory lock. Lock
 *  busy ⇒ "busy" (the patch is dropped, never thrown); genuine fs errors
 *  propagate. */
export async function writeIndexPatch(dir: string, patch: IndexPatch): Promise<"ok" | "busy"> {
  try {
    return await withMemoryDirLock(
      dir,
      () => {
        const jdir = join(dir, JEV_DIR_NAME);
        ensurePrivateDir(jdir);
        const merged = capBlind(mergeIndex(readIndex(dir).index, patch));
        const tmp = writeTempRegular(jdir, INDEX_NAME, serializeIndex(merged), INDEX_FILE_MODE);
        replaceAtomic(jdir, tmp, INDEX_NAME);
        return "ok" as const;
      },
      { timeoutMs: 0, log: () => {} },
    );
  } catch (err) {
    if (isLockBusy(err)) return "busy";
    throw err;
  }
}

/** Remove the sidecar index (taxonomy file kept). Missing file is a no-op. */
export async function removeIndex(dir: string): Promise<"ok" | "busy"> {
  try {
    return await withMemoryDirLock(
      dir,
      () => {
        try {
          unlinkRegular(join(dir, JEV_DIR_NAME), INDEX_NAME);
        } catch (err) {
          if (!isErrno(err, "ENOENT")) throw err;
        }
        return "ok" as const;
      },
      { timeoutMs: 0, log: () => {} },
    );
  } catch (err) {
    if (isLockBusy(err)) return "busy";
    throw err;
  }
}

// ───────────────────────────── taxonomy file ─────────────────────────────

function sanitizeTaxonomyTags(v: unknown): readonly TaxonomyFileV1["tags"][number][] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TaxonomyFileV1["tags"][number][] = [];
  for (const item of v) {
    if (!isPlainObject(item)) return undefined;
    const match = item["match"];
    if (
      typeof item["id"] !== "string" ||
      typeof item["label"] !== "string" ||
      typeof item["description"] !== "string" ||
      (item["risk"] !== "normal" && item["risk"] !== "high") ||
      (item["source"] !== "preset" && item["source"] !== "user") ||
      typeof item["rev"] !== "number" ||
      (match !== undefined && !isPlainObject(match))
    ) {
      return undefined;
    }
    out.push({
      id: item["id"],
      label: item["label"],
      description: item["description"],
      risk: item["risk"],
      ...(isPlainObject(match)
        ? {
            match: {
              ...(Array.isArray(match["tools"]) ? { tools: match["tools"] as string[] } : {}),
              ...(Array.isArray(match["commands"]) ? { commands: match["commands"] as string[] } : {}),
              ...(Array.isArray(match["paths"]) ? { paths: match["paths"] as string[] } : {}),
            },
          }
        : {}),
      source: item["source"],
      rev: item["rev"],
    });
  }
  return out;
}

/** `<slug>/.jev/taxonomy.json`; missing / unreadable / bad JSON / wrong shape
 *  ⇒ `undefined` (callers fall back to presets — `mergeTaxonomy()`). */
export function readTaxonomyFile(dir: string): TaxonomyFileV1 | undefined {
  let text: string;
  try {
    text = readRegular(join(dir, JEV_DIR_NAME), TAXONOMY_NAME).text;
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || parsed["v"] !== 1) return undefined;
  const tags = sanitizeTaxonomyTags(parsed["tags"]);
  if (tags === undefined) return undefined;
  const disabled = parsed["disabledPresets"];
  if (!Array.isArray(disabled) || disabled.some((id) => typeof id !== "string")) return undefined;
  return { v: 1, tags, disabledPresets: disabled as string[] };
}

/** Atomic taxonomy write, inside the directory lock (busy ⇒ "busy"). The
 *  file must still merge to a valid taxonomy (≤64 enabled tags, unique
 *  valid ids) — otherwise the write is refused with a throw BEFORE the
 *  current file is touched. */
export async function writeTaxonomyFile(dir: string, file: TaxonomyFileV1): Promise<"ok" | "busy"> {
  const merged = mergeTaxonomy(file);
  if (!merged.ok) throw new MemoryError(`refusing to write invalid taxonomy file: ${merged.error}`);
  try {
    return await withMemoryDirLock(
      dir,
      () => {
        const jdir = join(dir, JEV_DIR_NAME);
        ensurePrivateDir(jdir);
        const data = Buffer.from(
          JSON.stringify({ v: 1, tags: file.tags, disabledPresets: file.disabledPresets }, null, 2) + "\n",
          "utf8",
        );
        const tmp = writeTempRegular(jdir, TAXONOMY_NAME, data, INDEX_FILE_MODE);
        replaceAtomic(jdir, tmp, TAXONOMY_NAME);
        return "ok" as const;
      },
      { timeoutMs: 0, log: () => {} },
    );
  } catch (err) {
    if (isLockBusy(err)) return "busy";
    throw err;
  }
}
