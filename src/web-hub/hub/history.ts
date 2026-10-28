/**
 * History replay (plan §包 B, arch §7): read the agent-reported session file,
 * walk the branch back from the snapshot's leaf, reconcile with the agent's
 * `recent` window, and fill the event blind spot (idle custom messages that
 * never produce an extension `message_end`) by diffing the file tail on leaf
 * changes.
 *
 * File access (refresh-slow plan, `docs/dev/web-hub/refresh-slow/plan.md`):
 * `snapshot()`/`page()` ride a private reverse reader (`run-file-reader.ts`,
 * walk-branch parity — cost scales with the returned tail, never with the
 * file); `runTail` uses `readBranchTail` with the full cached reader as its
 * fallback. Nothing here parses a whole session file on the request path
 * anymore (a 193 MB / 30k-entry branch used to cost ~7 s of synchronous
 * main-thread CPU per snapshot).
 *
 * Alignment (spike K7②): the ONLY alignment point is the `leafId` the agent
 * read in the same tick as `snapshot_reply`. Entries appended after it are
 * ignored here (they arrive as `ev` / `append`); `turn_end.messageEntryId` is
 * never used as a "file caught up" fence. `session_compact` (id == leaf) is a
 * hard alignment point: subscribers get a `gap` and re-snapshot.
 *
 * Trust: the file path always comes from the agent (`snapshot_reply` /
 * `session`), never from the browser; it must end in `.jsonl` and resolve
 * (realpath) to a regular `.jsonl` file.
 */
import { Buffer } from "node:buffer";
import { open, readFile, realpath, stat } from "node:fs/promises";
import type { HistoryPayload } from "../protocol/http-contract.js";
import { diffAppended, entryKey, messageKey, projectSessionEntry, reconcileRecent } from "../protocol/keys.js";
import {
  LIMITS,
  TIMING,
  type AgentFrame,
  type InflightState,
  type SnapshotReplyBody,
  type WireEntry,
  type WireEvent,
  type WireMessage,
} from "../protocol/messages.js";
import type { HistoryService, HubLog } from "./ports.js";
import { createRunFileReader, type RunFileReadResult, type RunFileReaderStats } from "./run-file-reader.js";
import { HubError, type Registry } from "./registry.js";
import { formatSseFrame } from "./sse.js";

export const DEFAULT_TAIL_ENTRIES = 400;
export const DEFAULT_MAX_FILE_BYTES = 256 << 20;
export const LEAF_DEBOUNCE_MS = 500;
export const APPEND_TAIL_ENTRIES = 64;
/**
 * cmd-history §4.10 (M4): the `branch_req` budget for `runTail`'s ENOENT-only fallback —
 * deliberately tighter than `loadBranch`'s `LIMITS.branchReplyBytes` (2 MiB): only the last
 * `APPEND_TAIL_ENTRIES` entries are diffed, and the fallback fires in the window before the
 * session file's first user/assistant message, when the in-memory branch is small.
 */
export const RUNTAIL_BRANCH_FALLBACK_BYTES = 256 << 10;
export const DELIVERED_CAP = 512;
// Same budget as the agent-side branch_reply fallback (agent/snapshot.ts's `buildBranchReply`):
// `DEFAULT_TAIL_ENTRIES`/`PAGE_MAX` only cap entry COUNT — `projectSessionEntry` only bounds a
// single string field (`LIMITS.textTruncateBytes`, 64 KiB), so a tail full of large multi-block
// messages (many tool results/custom messages near the leaf) can still add up to tens of MB with
// no ceiling before this. `capEntriesByBytes` below trims from the OLDEST end to fit it.
export const MAX_HISTORY_PAYLOAD_BYTES = LIMITS.branchReplyBytes;
const FILE_CACHE_SIZE = 4;
const PAGE_MAX = 400;
/** `readBranchTail`: first positioned read from the end of the file, and the growth factor when the
 * leaf's ancestry does not fit in the chunk yet (geometric ⇒ total bytes read ≤ ~1.34× the final chunk). */
export const TAIL_CHUNK_BYTES = 512 << 10;
const TAIL_CHUNK_GROWTH = 4;
/** `readBranchTail` never reads more than this from the end: a leaf that is not on disk yet (the
 * "leaf not flushed" case) or an ancestry reaching further back falls to the full reader instead of
 * escalating to a whole-file read here (0.5 → 2 → 8 → 32 MiB ⇒ ≤ ~42 MiB total). */
export const TAIL_CHUNK_MAX_BYTES = 32 << 20;

/** refresh-slow plan §2.2 (`docs/dev/web-hub/refresh-slow/plan.md`): the history service's private
 * reverse reader — 512 KiB backward scan chunks bound the synchronous projection between
 * setImmediate yields; the cursor LRU is 8 (every append invalidates the active cursor's key, so
 * stale cursors only hold memory). A separate instance from the run-transcript reader: different
 * profile, and the two must not starve each other on the reader's ≤2 concurrency gate. */
const HISTORY_SCAN_CHUNK_BYTES = 512 << 10;
const HISTORY_CURSOR_CACHE = 8;
/** Snapshot reads `max(tailEntries, DELIVERED_CAP)` projected entries so the delivered baseline
 * (`pushDelivered` keeps the last `DELIVERED_CAP` keys) matches the old whole-branch read; the
 * limit doubles (≤ 8× MIN ⇒ ≤ 4096) while the merge window (2×|recent| message-like entries) is
 * not covered — each doubling resumes the cached cursor, never rescanning from EOF. */
const SNAPSHOT_READ_GROWTH_MAX = 8;
/** File-read sub-deadline for snapshot's reverse read: leaves ≥ half of `TIMING.snapshotMs` for
 * the `branch_req` fallback when the read cannot answer in time (`busy`). */
const SNAPSHOT_FILE_BUDGET_MS = TIMING.snapshotMs / 2;

type ReadFailure = "ENOENT" | "LEAF_NOT_FOUND" | "TOO_LARGE" | "PARSE";
type ReadResult = { ok: true; entries: WireEntry[] } | { ok: false; reason: ReadFailure };
type RawEntry = Record<string, unknown> & { id: string };

interface FileIndex {
  byId: Map<string, RawEntry>;
}

interface FileCache {
  get(real: string, size: number, mtimeMs: number): FileIndex | undefined;
  set(real: string, size: number, mtimeMs: number, index: FileIndex): void;
}

// ---------------------------------------------------------------------------
// file reading
// ---------------------------------------------------------------------------

export function readBranchFromFile(
  file: string,
  leafId: string,
  opts?: { maxFileBytes?: number },
): Promise<
  { ok: true; entries: WireEntry[] } | { ok: false; reason: "ENOENT" | "LEAF_NOT_FOUND" | "TOO_LARGE" | "PARSE" }
> {
  return readBranchCached(file, leafId, opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, undefined);
}

async function readBranchCached(
  file: string,
  leafId: string,
  maxFileBytes: number,
  cache: FileCache | undefined,
): Promise<ReadResult> {
  if (!file.endsWith(".jsonl")) return { ok: false, reason: "ENOENT" };
  let real: string;
  let size: number;
  let mtimeMs: number;
  try {
    real = await realpath(file);
    if (!real.endsWith(".jsonl")) return { ok: false, reason: "ENOENT" };
    const st = await stat(real);
    if (!st.isFile()) return { ok: false, reason: "ENOENT" };
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { ok: false, reason: "ENOENT" };
  }
  if (size > maxFileBytes) return { ok: false, reason: "TOO_LARGE" };

  let index = cache?.get(real, size, mtimeMs);
  if (index === undefined) {
    let text: string;
    try {
      text = await readFile(real, "utf8");
    } catch {
      return { ok: false, reason: "ENOENT" };
    }
    if (text.length > maxFileBytes) return { ok: false, reason: "TOO_LARGE" }; // grew between stat and read
    const parsed = parseIndex(text);
    if (parsed === undefined) return { ok: false, reason: "PARSE" };
    index = parsed;
    cache?.set(real, size, mtimeMs, index);
  }
  return walkBranch(index, leafId);
}

/**
 * `runTail`'s reader — the last `count` projected entries of the branch ending at `leafId`,
 * WITHOUT reading/parsing the whole session file. Perf incident 2026-10-28: a 193 MB live session
 * made every leaf change (500 ms debounce) re-read + `JSON.parse` the full file (size/mtime changed,
 * so `FileCache` always missed) and project the whole branch (`canonicalJson` per custom entry) only
 * to keep the last `APPEND_TAIL_ENTRIES` — 1–5 s of synchronous main-thread CPU per change, which
 * queued EVERY hub request (a /api/preview?dir=1 answered in ~3 ms of handler time but 1.8–5 s on
 * the wire).
 *
 * Reads positioned chunks from the end (`TAIL_CHUNK_BYTES`, ×`TAIL_CHUNK_GROWTH` until the ancestry
 * is covered). The chunk is cut at a newline BYTE (0x0A never occurs inside a UTF-8 sequence), so a
 * partial first line is dropped, never mis-decoded. The result equals `readBranchCached(...).entries
 * .slice(-count)` for every file the full reader accepts (projection is per-entry pure; duplicate ids
 * resolve last-wins in both). Returns `undefined` ⇒ "cannot answer from the tail" and the caller
 * falls back to the full reader: a corrupt NON-trailing line inside the chunk (the full reader's
 * PARSE failure), the chunk would cover the whole file anyway, or the `TAIL_CHUNK_MAX_BYTES` budget is spent. ENOENT / LEAF_NOT_FOUND
 * keep the full reader's exact meaning; TOO_LARGE never appears — the tail read is bounded by its
 * own chunk budget (`TAIL_CHUNK_MAX_BYTES`), not by the file size (refresh-slow plan §4.1 removed the
 * old `maxFileBytes` gate: a >256 MiB file whose ancestry sits in the tail now answers from the
 * tail instead of falling to the full reader's TOO_LARGE). `opts.onRead` is a test seam (bytes of
 * each positioned read).
 */
export async function readBranchTail(
  file: string,
  leafId: string,
  count: number,
  opts?: { onRead?: (bytes: number) => void },
): Promise<{ ok: true; entries: WireEntry[] } | { ok: false; reason: "ENOENT" | "LEAF_NOT_FOUND" } | undefined> {
  if (!file.endsWith(".jsonl")) return { ok: false, reason: "ENOENT" };
  let real: string;
  let size: number;
  try {
    real = await realpath(file);
    if (!real.endsWith(".jsonl")) return { ok: false, reason: "ENOENT" };
    const st = await stat(real);
    if (!st.isFile()) return { ok: false, reason: "ENOENT" };
    size = st.size;
  } catch {
    return { ok: false, reason: "ENOENT" };
  }

  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(real, "r");
  } catch {
    return { ok: false, reason: "ENOENT" };
  }
  try {
    let chunk = TAIL_CHUNK_BYTES;
    for (;;) {
      // the chunk is the whole file, or the tail budget is spent ⇒ the full (cached) reader's job
      if (chunk >= size || chunk > TAIL_CHUNK_MAX_BYTES) return undefined;
      const start = size - chunk;
      const buf = Buffer.allocUnsafe(chunk);
      let got = 0;
      while (got < chunk) {
        const { bytesRead } = await fh.read(buf, got, chunk - got, start + got);
        if (bytesRead === 0) break; // file shrank under us ⇒ let the full reader decide
        got += bytesRead;
      }
      opts?.onRead?.(got);
      if (got < chunk) return undefined;
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        chunk *= TAIL_CHUNK_GROWTH; // a single line longer than the chunk
        continue;
      }
      const lines = buf.toString("utf8", nl + 1, got).split("\n");
      const byId = new Map<string, RawEntry>();
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]!.trim();
        if (text === "") continue;
        let v: unknown;
        try {
          v = JSON.parse(text);
        } catch {
          if (isLastNonEmpty(lines, i)) continue; // writer mid-append
          return undefined; // corrupt non-trailing line: the full reader owns the PARSE verdict
        }
        if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
        const r = v as Record<string, unknown>;
        if (typeof r["id"] === "string") byId.set(r["id"], r as RawEntry);
      }
      // walk leaf → root, projecting newest-first until `count` entries exist
      const seen = new Set<string>();
      const out: WireEntry[] = [];
      let cur: string | null = leafId;
      let covered = true; // false ⇒ the ancestry continues before the chunk
      while (cur !== null && !seen.has(cur) && out.length < count) {
        seen.add(cur);
        const raw = byId.get(cur);
        if (raw === undefined) {
          covered = false;
          break;
        }
        const e = projectSessionEntry(raw);
        if (e !== undefined) out.push(e);
        const parent: unknown = raw["parentId"];
        cur = typeof parent === "string" ? parent : null;
      }
      if (out.length >= count || covered) {
        out.reverse();
        return { ok: true, entries: out };
      }
      chunk *= TAIL_CHUNK_GROWTH; // leaf/parent not in this chunk: look further back
    }
  } catch {
    return { ok: false, reason: "ENOENT" };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Every line must parse, except a trailing partial line (writer mid-append), which is skipped. */
function parseIndex(text: string): FileIndex | undefined {
  const byId = new Map<string, RawEntry>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      if (isLastNonEmpty(lines, i)) continue;
      return undefined;
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    if (typeof r["id"] === "string") byId.set(r["id"], r as RawEntry);
  }
  return { byId };
}

function isLastNonEmpty(lines: readonly string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim() !== "") return false;
  return true;
}

function walkBranch(index: FileIndex, leafId: string): ReadResult {
  if (!index.byId.has(leafId)) return { ok: false, reason: "LEAF_NOT_FOUND" };
  const chain: RawEntry[] = [];
  const seen = new Set<string>();
  let cur: string | null = leafId;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const raw = index.byId.get(cur);
    if (raw === undefined) break;
    chain.push(raw);
    const parent: unknown = raw["parentId"];
    cur = typeof parent === "string" ? parent : null;
  }
  chain.reverse();
  const entries: WireEntry[] = [];
  for (const raw of chain) {
    const e = projectSessionEntry(raw);
    if (e !== undefined) entries.push(e);
  }
  return { ok: true, entries };
}

/**
 * Trim `entries` (already `-tailEntries`/page-limit sliced, newest last) from the OLDEST end
 * until the serialized total fits `maxBytes`. The single newest entry is always kept even if it
 * alone exceeds the budget (never return an empty payload just because one entry is huge).
 */
export function capEntriesByBytes(
  entries: readonly WireEntry[],
  maxBytes: number,
): { entries: WireEntry[]; truncated: boolean } {
  if (entries.length === 0) return { entries: [], truncated: false };
  let total = 0;
  let cut = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(entries[i]), "utf8");
    if (i !== entries.length - 1 && total + size > maxBytes) break; // keep the newest unconditionally
    total += size;
    cut = i;
  }
  return { entries: entries.slice(cut), truncated: cut > 0 };
}

/**
 * Build the final `HistoryPayload` for `snapshot()`/`page()`, trimming `entries` (already
 * `-tailEntries`/page-limit sliced, newest last) so that the ACTUAL wire unit fits `maxBytes`
 * (§P1-2 regression: `capEntriesByBytes` above only sums each entry's own serialized bytes — it
 * has no idea about the JSON array's own brackets/commas, `HistoryPayload`'s other fields
 * (`tailMessages`/`inflight`/`agentKey`/`fromSeq`/`hasMore`/`source`/`oldestEntryId`), or, for
 * `snapshot()` specifically, the SSE `event: history\ndata: ...\n\n` frame wrapper that payload
 * actually goes out inside — `page()`'s payload instead goes out as a bare `sendJson` HTTP body,
 * a DIFFERENT real unit with no SSE wrapper at all. `build` renders the full payload for a
 * candidate entries array (so `hasMore`/`oldestEntryId` are always correct for THAT candidate,
 * not stale from before trimming) and `frame` renders the exact string the caller will actually
 * send for it (an SSE frame vs. a bare JSON body) — both are call-site-supplied so this stays
 * agnostic to which layer applies the budget. `capEntriesByBytes`'s per-entry pass runs first as
 * a cheap common-case fast path (avoids re-serializing the whole payload once per removed entry
 * for the overwhelmingly common case of already-well-under-budget histories); the loop below then
 * verifies against the real wire string and keeps trimming from the oldest end — keeping the
 * single newest entry unconditionally, exactly like `capEntriesByBytes` — if the first pass's
 * narrower budget still undershot (large `tailMessages`/`inflight`, many-entry separator
 * overhead, frame-wrapper bytes, ...).
 */
function buildCappedHistoryPayload(
  entries: readonly WireEntry[],
  maxBytes: number,
  build: (entries: WireEntry[]) => HistoryPayload,
  frame: (payload: HistoryPayload) => string,
): HistoryPayload {
  const first = capEntriesByBytes(entries, maxBytes);
  let capped = first.entries;
  let payload = build(capped);
  while (capped.length > 1 && Buffer.byteLength(frame(payload), "utf8") > maxBytes) {
    capped = capped.slice(1);
    payload = build(capped);
  }
  return payload;
}

function createFileCache(): FileCache {
  const map = new Map<string, { size: number; mtimeMs: number; index: FileIndex }>();
  return {
    get(real, size, mtimeMs) {
      const hit = map.get(real);
      if (hit === undefined || hit.size !== size || hit.mtimeMs !== mtimeMs) return undefined;
      map.delete(real);
      map.set(real, hit); // LRU touch
      return hit.index;
    },
    set(real, size, mtimeMs, index) {
      map.delete(real);
      map.set(real, { size, mtimeMs, index });
      while (map.size > FILE_CACHE_SIZE) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// merge (pure, §7 步骤 4)
// ---------------------------------------------------------------------------

/**
 * Pure merge of the file branch (already aligned at `reply.leafId`) with the
 * agent's snapshot: `recent` items not yet on disk (multiset reconciliation
 * against the last 2×|recent| message-like branch entries) become `tailMessages`;
 * `inflight` is attached; `fromSeq = reply.seq + 1`. Addition to the plan
 * signature: `buffered` returns the buffered events with `seq > reply.seq`, in
 * seq order, for the caller to replay after the history frame.
 */
export function mergeSnapshot(
  branch: readonly WireEntry[],
  reply: SnapshotReplyBody,
  buffered: ReadonlyArray<{ seq: number; e: WireEvent }>,
): {
  entries: WireEntry[];
  tailMessages: WireMessage[];
  inflight?: InflightState;
  fromSeq: number;
  buffered: Array<{ seq: number; e: WireEvent }>;
} {
  const recent = [...reply.recent].sort((a, b) => a.seq - b.seq);
  const messageLike = branch.filter((e) => e.type === "message" || e.type === "custom_message");
  // Window = 2×|recent| (plan: |recent|): message-like entries persisted without a
  // message_end (idle custom_message, K7④) would otherwise push genuine counterparts out
  // of the window and duplicate them. role:timestamp keys are unique, so widening only
  // risks a rare custom content-key false match — which the tail-fill path self-heals.
  const branchTail = recent.length === 0 ? [] : messageLike.slice(-2 * recent.length);
  const missing = reconcileRecent(branchTail, recent);
  const out: {
    entries: WireEntry[];
    tailMessages: WireMessage[];
    inflight?: InflightState;
    fromSeq: number;
    buffered: Array<{ seq: number; e: WireEvent }>;
  } = {
    entries: [...branch],
    tailMessages: missing.map((m) => m.message),
    fromSeq: reply.seq + 1,
    buffered: buffered.filter((b) => b.seq > reply.seq).sort((a, b) => a.seq - b.seq),
  };
  if (reply.inflight !== undefined) out.inflight = reply.inflight;
  return out;
}

/** refresh-slow plan §2.2: merge-window census — `messageLike` counts exactly the entry types
 * `mergeSnapshot`'s reconciliation window (`message` / `custom_message`) reconciles against. */
function countMessageLike(entries: readonly WireEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.type === "message" || e.type === "custom_message") n++;
  return n;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

interface AgentHist {
  delivered: string[] | undefined; // undefined = no snapshot baseline ⇒ nobody watching
  buffers: Set<Array<{ seq: number; e: WireEvent }>>;
  lastLeaf: string | null | undefined;
  pendingLeaf: string | null;
  leafTimer: ReturnType<typeof setTimeout> | undefined;
  reading: boolean;
  rerun: boolean;
  /** refresh-slow plan §4.3: ONE `runTail` TOO_LARGE warn per agent per contiguous over-cap
   * state (set on the first warn, reset by any later successful file tail/full read). */
  tailTooLargeWarned: boolean;
}

type SnapshotReply = Extract<AgentFrame, { t: "snapshot_reply" }>;
type BranchReply = Extract<AgentFrame, { t: "branch_reply" }>;

export function createHistoryService(deps: {
  registry: Registry;
  log: HubLog;
  tailEntries?: number; /* 400 */
  /** Test seam (refresh-slow plan §2.7): live counters of the service's private branch reader
   *  (read-amount / round-count gates). */
  readerStats?: RunFileReaderStats;
  /** Test seam (refresh-slow plan §2.7): snapshot's file-read sub-budget in ms (default
   *  `SNAPSHOT_FILE_BUDGET_MS`); 0 forces the busy → branch_req fallback deterministically. */
  snapshotFileBudgetMs?: number;
}): HistoryService & { dispose(): void } {
  const { registry, log } = deps;
  const tailEntries = deps.tailEntries ?? DEFAULT_TAIL_ENTRIES;
  const snapshotReadMin = Math.max(tailEntries, DELIVERED_CAP);
  const fileBudgetMs = deps.snapshotFileBudgetMs ?? SNAPSHOT_FILE_BUDGET_MS;
  const cache = createFileCache();
  const branchReader = createRunFileReader({
    fullReaderParity: true,
    cursorCacheSize: HISTORY_CURSOR_CACHE,
    scanChunkBytes: HISTORY_SCAN_CHUNK_BYTES,
    ...(deps.readerStats !== undefined ? { stats: deps.readerStats } : {}),
  });
  const states = new Map<string, AgentHist>();
  let disposed = false;

  const state = (agentKey: string): AgentHist => {
    let st = states.get(agentKey);
    if (st === undefined) {
      st = {
        delivered: undefined,
        buffers: new Set(),
        lastLeaf: undefined,
        pendingLeaf: null,
        leafTimer: undefined,
        reading: false,
        rerun: false,
        tailTooLargeWarned: false,
      };
      states.set(agentKey, st);
    }
    return st;
  };

  const pushDelivered = (st: AgentHist, keys: readonly string[]): void => {
    if (st.delivered === undefined) return;
    st.delivered.push(...keys);
    if (st.delivered.length > DELIVERED_CAP) st.delivered.splice(0, st.delivered.length - DELIVERED_CAP);
  };

  /** refresh-slow plan §2.5: only `runTail`'s full-reader fallback still uses the cached whole-file
   * reader (snapshot/page never do). */
  const readBranch = (file: string, leafId: string): Promise<ReadResult> =>
    readBranchCached(file, leafId, DEFAULT_MAX_FILE_BYTES, cache);

  /**
   * cmd-history §4.10 (M4) + refresh-slow plan §4.3: the runTail ENOENT/TOO_LARGE branch fallback.
   *
   * pi does not create the session file until the first user/assistant message lands
   * (`session-manager.js`'s "no file before the first conversation" behavior — the premise
   * conformance #5 pins), so a persisted-session report (a path exists, the file does not yet)
   * used to drop the real-time `append` for every idle custom entry written in that window —
   * exactly where a fresh session's first `subagent:cmd` records land. Since refresh-slow P1①③
   * the same fallback also serves TOO_LARGE: the file is over the full-read cap
   * (`DEFAULT_MAX_FILE_BYTES`) AND the tail read could not answer — real-time appends must not
   * silently stall on the far side of the 256 MiB cliff. Both ask the agent's in-memory branch:
   * the SAME `branch_req` frame `loadSnapshotBranch`'s agent path uses, with a tighter 256 KiB
   * budget, cut at the pending leaf. A reply that does not contain the leaf is treated as a read
   * failure (return `undefined`, wait for the next leaf change) so `diffAppended` never runs
   * against an unaligned branch.
   *
   * Errors — agent offline (`E_AGENT_GONE`), the `TIMING.snapshotMs` deadline (its timer is
   * unref'd inside `registry.request`), anything else — are logged (metadata only, never entry
   * content) and swallowed: this must never throw into `runTail`.
   *
   * Boundary (M4/R9, deliberate): this is a GENERAL hub fix — the hub cannot know the agent's
   * `cmdHistory` setting, so it also fires for old agents / cmdHistory:false sessions (their
   * pre-first-message idle custom entries start appearing live too; plan §1.3/§9-R9 discloses
   * this as outside the "switch off ⇒ unchanged" promise). `--no-session` sessions
   * (`file === undefined`) are NOT in scope and keep today's early return (M4).
   */
  const readTailFromAgent = async (agentKey: string, leafId: string): Promise<WireEntry[] | undefined> => {
    try {
      const br = await registry.request<BranchReply>(
        agentKey,
        { t: "branch_req", rid: "", maxBytes: RUNTAIL_BRANCH_FALLBACK_BYTES },
        TIMING.snapshotMs,
      );
      const cut = br.entries.findIndex((e) => e.id === leafId);
      if (cut === -1) return undefined;
      return br.entries.slice(0, cut + 1);
    } catch (err) {
      log.info("runTail branch fallback failed", { agentKey, error: String(err) });
      return undefined;
    }
  };

  const unsubscribe = registry.bus.subscribe((ev) => {
    switch (ev.type) {
      case "ev": {
        const st = states.get(ev.agentKey);
        if (st !== undefined) {
          for (const buf of st.buffers) buf.push({ seq: ev.seq, e: ev.e });
          if (ev.e.type === "message_end") {
            const m = asMessage(ev.e["message"]);
            if (m !== undefined) pushDelivered(st, [messageKey(m)]);
          }
        }
        if (ev.e.type === "session_compact") {
          // Hard alignment point: subscribers re-snapshot instead of splicing incrementally.
          registry.publish({ type: "gap", agentKey: ev.agentKey, fromSeq: ev.seq });
        }
        return;
      }
      case "status": {
        const st = state(ev.agentKey);
        if (ev.status.leafId !== st.lastLeaf) {
          st.lastLeaf = ev.status.leafId;
          historyService.onLeafChanged(ev.agentKey, ev.status.leafId);
        }
        return;
      }
      case "session": {
        const st = state(ev.agentKey);
        st.delivered = undefined; // new session: browsers re-snapshot; never diff against the old one
        st.lastLeaf = ev.session.leafId;
        if (st.leafTimer !== undefined) clearTimeout(st.leafTimer);
        st.leafTimer = undefined;
        return;
      }
      case "agent_down": {
        const st = states.get(ev.agentKey);
        if (st?.leafTimer !== undefined) clearTimeout(st.leafTimer);
        states.delete(ev.agentKey);
        return;
      }
      default:
        return;
    }
  });

  const runTail = async (agentKey: string): Promise<void> => {
    const st = states.get(agentKey);
    if (st === undefined || disposed) return;
    if (st.reading) {
      st.rerun = true;
      return;
    }
    const leaf = st.pendingLeaf;
    const file = registry.get(agentKey)?.session?.sessionFile;
    if (st.delivered === undefined || leaf === null || file === undefined) return;
    st.reading = true;
    try {
      // tail-only fast path; `undefined` ⇒ not answerable from the tail ⇒ the full cached reader
      const res = (await readBranchTail(file, leaf, APPEND_TAIL_ENTRIES)) ?? (await readBranch(file, leaf));
      let entries: readonly WireEntry[] | undefined;
      if (res.ok) {
        entries = res.entries;
        st.tailTooLargeWarned = false; // a timely file answer re-arms the one-shot warn below
      } else if (res.reason === "ENOENT" || res.reason === "TOO_LARGE") {
        // ENOENT — cmd-history §4.10: the file is not there YET (pre-first-message). TOO_LARGE —
        // refresh-slow plan §4.3: the file is over the full-read cap AND the tail read could not
        // answer; real-time appends must not silently stall on the far side of the 256 MiB cliff.
        // Both ask the agent's in-memory branch (256 KiB, cut at the pending leaf). Other failures
        // (PARSE / LEAF_NOT_FOUND) keep the plain retry-on-next-leaf-change behavior below.
        if (res.reason === "TOO_LARGE" && !st.tailTooLargeWarned) {
          st.tailTooLargeWarned = true; // once per agent per contiguous over-cap state
          log.warn(
            "runTail: session file over the full-read cap and the tail could not answer; using the agent branch",
            {
              agentKey,
              reason: "TOO_LARGE",
              maxFileBytes: DEFAULT_MAX_FILE_BYTES,
            },
          );
        }
        entries = await readTailFromAgent(agentKey, leaf);
      }
      if (entries === undefined) return; // leaf not flushed yet / unreadable: retry on the next leaf change
      if (st.delivered === undefined || states.get(agentKey) !== st) return; // session changed meanwhile
      const tail = entries.slice(-APPEND_TAIL_ENTRIES);
      const fresh = diffAppended(st.delivered, tail);
      if (fresh.length === 0) return;
      pushDelivered(
        st,
        fresh.map((e) => entryKey(e)).filter((k): k is string => k !== undefined),
      );
      registry.publish({ type: "append", agentKey, entries: fresh });
    } catch (err) {
      log.warn("tail read failed", { agentKey, error: String(err) });
    } finally {
      st.reading = false;
      if (st.rerun) {
        st.rerun = false;
        schedule(agentKey, st);
      }
    }
  };

  const schedule = (agentKey: string, st: AgentHist): void => {
    if (st.leafTimer !== undefined || disposed) return; // bounded latency: fires 500ms after the first change
    st.leafTimer = setTimeout(() => {
      st.leafTimer = undefined;
      void runTail(agentKey);
    }, LEAF_DEBOUNCE_MS);
    st.leafTimer.unref();
  };

  const withDeadline = <T>(fn: (remaining: () => number) => Promise<T>): Promise<T> => {
    const deadlineAt = Date.now() + TIMING.snapshotMs;
    const remaining = (): number => Math.max(0, deadlineAt - Date.now());
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new HubError("E_DEADLINE")), TIMING.snapshotMs);
      timer.unref();
      fn(remaining).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  };

  /**
   * refresh-slow plan §2.2: snapshot's tail read. `deadlineAt` is the file-read sub-budget
   * (`SNAPSHOT_FILE_BUDGET_MS`); a `busy` result falls back to `branch_req` instead of stalling
   * the request. Reads the newest `snapshotReadMin` projected entries and doubles the limit
   * (≤ 8×, resuming the cached cursor — never rescanning from EOF) until the merge window
   * carries `needMessageLike` (2 × |reply.recent|) message-like entries, the branch ends
   * (hasMore:false) or the cap hits. `maxBytes` is unbounded here: the wire byte budget is
   * applied downstream by `buildCappedHistoryPayload`, exactly as before.
   */
  const readTailForSnapshot = async (
    file: string,
    leafId: string,
    needMessageLike: number,
    deadlineAt: number,
  ): Promise<RunFileReadResult> => {
    let limit = snapshotReadMin;
    for (;;) {
      const r = await branchReader.read(file, leafId, { limit, maxBytes: Number.MAX_SAFE_INTEGER, deadlineAt });
      if (
        !r.ok ||
        !r.hasMore ||
        limit >= snapshotReadMin * SNAPSHOT_READ_GROWTH_MAX ||
        countMessageLike(r.entries) >= needMessageLike
      ) {
        return r;
      }
      limit *= 2;
    }
  };

  /**
   * The `branch_req` path snapshot and page share (the tail of the old `loadBranch`): the
   * agent's in-memory branch, cut at the leaf (`cut === -1` keeps the reply as-is — the leaf is
   * the newest entry in the normal case), `truncated` carrying `hasMore` when the agent budget
   * cut it.
   */
  const loadFromAgent = async (
    agentKey: string,
    leafId: string,
    remaining: () => number,
  ): Promise<{ entries: WireEntry[]; source: "agent"; truncated: boolean }> => {
    const br = await registry.request<BranchReply>(
      agentKey,
      { t: "branch_req", rid: "", maxBytes: LIMITS.branchReplyBytes },
      remaining(),
    );
    const cut = br.entries.findIndex((e) => e.id === leafId);
    const entries = cut === -1 ? br.entries : br.entries.slice(0, cut + 1);
    return { entries, source: "agent", truncated: br.truncated };
  };

  /**
   * refresh-slow plan §2.3 fallback matrix — snapshot's branch load. The reverse read answers
   * from the file tail (`source:"file"`); every failure mode (file_missing / leaf_missing /
   * parse_error / too_large / busy) falls back to `branch_req` — never to a whole-file read: any
   * verdict the full reader could add (LEAF_NOT_FOUND / PARSE / TOO_LARGE) would cost seconds of
   * main-thread CPU to re-derive what the reverse read already proved, and busy means the
   * sub-budget expired, where the agent answer is the only timely option. `more` is the reverse
   * read's exact hasMore (parity); the agent path has no such signal (`truncated` carries it).
   */
  const loadSnapshotBranch = async (
    agentKey: string,
    file: string | undefined,
    leafId: string,
    reply: SnapshotReplyBody,
    remaining: () => number,
  ): Promise<{ entries: WireEntry[]; source: "file" | "agent"; truncated: boolean; more: boolean }> => {
    if (file !== undefined) {
      const r = await readTailForSnapshot(file, leafId, 2 * reply.recent.length, Date.now() + fileBudgetMs);
      if (r.ok) return { entries: r.entries, source: "file", truncated: false, more: r.hasMore };
      log.info("history file read fell back to branch_req", { agentKey, reason: r.reason });
    }
    const agent = await loadFromAgent(agentKey, leafId, remaining);
    return { ...agent, more: false };
  };

  const historyService: HistoryService & { dispose(): void } = {
    snapshot(agentKey) {
      if (registry.get(agentKey) === undefined) return Promise.reject(new HubError("E_NOT_FOUND"));
      const st = state(agentKey);
      const buffer: Array<{ seq: number; e: WireEvent }> = [];
      st.buffers.add(buffer);
      return withDeadline(async (remaining) => {
        const reply = await registry.request<SnapshotReply>(agentKey, { t: "snapshot_req", rid: "" }, remaining());
        const base =
          reply.leafId === null
            ? { entries: [] as WireEntry[], source: "file" as const, truncated: false, more: false }
            : await loadSnapshotBranch(
                agentKey,
                reply.sessionFile ?? registry.get(agentKey)?.session?.sessionFile,
                reply.leafId,
                reply,
                remaining,
              );
        const merged = mergeSnapshot(base.entries, reply, buffer);
        const entries = merged.entries.slice(-tailEntries);

        // Delivery baseline for tail diffs: everything the browser now holds.
        const cur = states.get(agentKey);
        if (cur === st) {
          st.delivered = [];
          pushDelivered(st, [
            ...merged.entries.map((e) => entryKey(e)).filter((k): k is string => k !== undefined),
            ...merged.tailMessages.map((m) => messageKey(m)),
          ]);
          for (const b of merged.buffered) {
            if (b.e.type !== "message_end") continue;
            const m = asMessage(b.e["message"]);
            if (m !== undefined) pushDelivered(st, [messageKey(m)]);
          }
          if (st.lastLeaf === undefined) st.lastLeaf = reply.leafId;
          else if (st.lastLeaf !== reply.leafId) historyService.onLeafChanged(agentKey, st.lastLeaf);
        }

        return buildCappedHistoryPayload(
          entries,
          MAX_HISTORY_PAYLOAD_BYTES,
          (candidateEntries) => {
            const payload: HistoryPayload = {
              agentKey,
              entries: candidateEntries,
              tailMessages: merged.tailMessages,
              fromSeq: merged.fromSeq,
              hasMore:
                merged.entries.length > entries.length ||
                base.more ||
                base.truncated ||
                candidateEntries.length < entries.length,
              source: base.source,
            };
            // D2-7(c) (web-hub-session-switch plan §2.2 step 4): forward the agent-reported
            // session identity — a few dozen bytes, already inside the byte budget below via
            // the frame renderer. (`page()` deliberately does NOT forward it: the browser's
            // guard targets in-flight snapshots, not paged history of the current session.)
            if (reply.sessionId !== undefined) payload.sessionId = reply.sessionId;
            if (merged.inflight !== undefined) payload.inflight = merged.inflight;
            const oldest = candidateEntries[0]?.id;
            if (oldest !== undefined) payload.oldestEntryId = oldest;
            return payload;
          },
          // `snapshot()`'s payload always goes out as an SSE frame (`runSnapshot` in http.ts:
          // `client.send("history", payload)`), never a bare JSON body.
          (payload) => formatSseFrame("history", payload),
        );
      }).finally(() => {
        st.buffers.delete(buffer);
      });
    },

    page(agentKey, beforeEntryId, limit) {
      const view = registry.get(agentKey);
      if (view === undefined) return Promise.reject(new HubError("E_NOT_FOUND"));
      const lim = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : PAGE_MAX)));
      const leaf = view.status?.leafId ?? view.session?.leafId ?? null;
      if (leaf === null) return Promise.reject(new HubError("E_NOT_FOUND"));
      return withDeadline(async (remaining) => {
        // refresh-slow plan §3.2: page rides the same reverse reader as snapshot (shared cursor —
        // the first "Show earlier" after a snapshot is mostly a cache slice). The reader's
        // collect is exactly page's semantics: on the leaf's branch, strictly before
        // `beforeEntryId`, up to `lim` entries, byte-capped per entry with the newest kept
        // unconditionally (same accounting as capEntriesByBytes); buildCappedHistoryPayload
        // below still verifies the real wire unit.
        let entries: WireEntry[] | undefined;
        let more = false;
        let source: "file" | "agent" = "file";
        let agentTruncated = false;
        const file = view.session?.sessionFile;
        if (file !== undefined) {
          // 250 ms headroom so the reader's busy — E_BUSY (503, retryable; cursor progress is
          // kept) — beats the outer E_DEADLINE.
          const deadlineAt = Date.now() + Math.max(0, remaining() - 250);
          const r = await branchReader.read(file, leaf, {
            before: beforeEntryId,
            limit: lim,
            maxBytes: MAX_HISTORY_PAYLOAD_BYTES,
            deadlineAt,
          });
          if (r.ok) {
            entries = r.entries;
            more = r.hasMore;
            source = "file";
          } else if (r.reason === "busy") {
            throw new HubError("E_BUSY");
          }
          // file_missing / leaf_missing / parse_error / too_large → the agent path below. The
          // reader's leaf_missing here means "the walk terminated (root / file head / truncated
          // ancestry / cycle) without ever crossing `before`" — either `before` is genuinely not
          // on this branch, or the file cannot express the full chain; the agent answer (or its
          // E_NOT_FOUND when `before` is off-branch there too) is the same verdict the full
          // reader used to reach, at the cost of one extra branch_req round-trip.
        }
        if (entries === undefined) {
          const base = await loadFromAgent(agentKey, leaf, remaining);
          const idx = base.entries.findIndex((e) => e.id === beforeEntryId);
          if (idx === -1) throw new HubError("E_NOT_FOUND");
          const start = Math.max(0, idx - lim);
          entries = base.entries.slice(start, idx);
          more = start > 0;
          source = base.source;
          agentTruncated = base.truncated;
        }
        const pageEntries = entries;
        return buildCappedHistoryPayload(
          pageEntries,
          MAX_HISTORY_PAYLOAD_BYTES,
          (candidateEntries) => {
            const payload: HistoryPayload = {
              agentKey,
              entries: candidateEntries,
              tailMessages: [],
              fromSeq: view.seq + 1,
              hasMore: more || agentTruncated || candidateEntries.length < pageEntries.length,
              source,
            };
            const oldest = candidateEntries[0]?.id;
            if (oldest !== undefined) payload.oldestEntryId = oldest;
            return payload;
          },
          // `page()`'s payload goes out as a bare `sendJson` HTTP response body (http.ts's
          // `GET /api/history` handler), never wrapped in an SSE frame.
          (payload) => JSON.stringify(payload),
        );
      });
    },

    onLeafChanged(agentKey, leafId) {
      const st = states.get(agentKey);
      if (st === undefined || st.delivered === undefined || leafId === null || disposed) return;
      st.pendingLeaf = leafId;
      if (st.reading) {
        st.rerun = true;
        return;
      }
      schedule(agentKey, st);
    },

    dispose() {
      disposed = true;
      branchReader.dispose();
      unsubscribe();
      for (const st of states.values()) if (st.leafTimer !== undefined) clearTimeout(st.leafTimer);
      states.clear();
    },
  };
  return historyService;
}

function asMessage(v: unknown): WireMessage | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return typeof (v as Record<string, unknown>)["role"] === "string" ? (v as WireMessage) : undefined;
}
