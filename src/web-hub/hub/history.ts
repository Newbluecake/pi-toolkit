/**
 * History replay (plan §包 B, arch §7): read the agent-reported session file,
 * walk the branch back from the snapshot's leaf, reconcile with the agent's
 * `recent` window, and fill the event blind spot (idle custom messages that
 * never produce an extension `message_end`) by diffing the file tail on leaf
 * changes.
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
import { readFile, realpath, stat } from "node:fs/promises";
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
import { HubError, type Registry } from "./registry.js";

export const DEFAULT_TAIL_ENTRIES = 400;
export const DEFAULT_MAX_FILE_BYTES = 256 << 20;
export const LEAF_DEBOUNCE_MS = 500;
export const APPEND_TAIL_ENTRIES = 64;
export const DELIVERED_CAP = 512;
const FILE_CACHE_SIZE = 4;
const PAGE_MAX = 400;

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
}

type SnapshotReply = Extract<AgentFrame, { t: "snapshot_reply" }>;
type BranchReply = Extract<AgentFrame, { t: "branch_reply" }>;

export function createHistoryService(deps: {
  registry: Registry;
  log: HubLog;
  tailEntries?: number; /* 400 */
}): HistoryService & { dispose(): void } {
  const { registry, log } = deps;
  const tailEntries = deps.tailEntries ?? DEFAULT_TAIL_ENTRIES;
  const cache = createFileCache();
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

  const readBranch = (file: string, leafId: string): Promise<ReadResult> =>
    readBranchCached(file, leafId, DEFAULT_MAX_FILE_BYTES, cache);

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
      const res = await readBranch(file, leaf);
      if (!res.ok) return; // leaf not flushed yet / unreadable: retry on the next leaf change
      if (st.delivered === undefined || states.get(agentKey) !== st) return; // session changed meanwhile
      const tail = res.entries.slice(-APPEND_TAIL_ENTRIES);
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

  const loadBranch = async (
    agentKey: string,
    file: string | undefined,
    leafId: string,
    remaining: () => number,
  ): Promise<{ entries: WireEntry[]; source: "file" | "agent"; truncated: boolean }> => {
    if (file !== undefined) {
      const res = await readBranch(file, leafId);
      if (res.ok) return { entries: res.entries, source: "file", truncated: false };
      log.info("history file read fell back to branch_req", { agentKey, reason: res.reason });
    }
    const br = await registry.request<BranchReply>(
      agentKey,
      { t: "branch_req", rid: "", maxBytes: LIMITS.branchReplyBytes },
      remaining(),
    );
    const cut = br.entries.findIndex((e) => e.id === leafId);
    const entries = cut === -1 ? br.entries : br.entries.slice(0, cut + 1);
    return { entries, source: "agent", truncated: br.truncated };
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
            ? { entries: [] as WireEntry[], source: "file" as const, truncated: false }
            : await loadBranch(
                agentKey,
                reply.sessionFile ?? registry.get(agentKey)?.session?.sessionFile,
                reply.leafId,
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

        const payload: HistoryPayload = {
          agentKey,
          entries,
          tailMessages: merged.tailMessages,
          fromSeq: merged.fromSeq,
          hasMore: merged.entries.length > entries.length || base.truncated,
          source: base.source,
        };
        if (merged.inflight !== undefined) payload.inflight = merged.inflight;
        const oldest = entries[0]?.id;
        if (oldest !== undefined) payload.oldestEntryId = oldest;
        return payload;
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
        const base = await loadBranch(agentKey, view.session?.sessionFile, leaf, remaining);
        const idx = base.entries.findIndex((e) => e.id === beforeEntryId);
        if (idx === -1) throw new HubError("E_NOT_FOUND");
        const start = Math.max(0, idx - lim);
        const entries = base.entries.slice(start, idx);
        const payload: HistoryPayload = {
          agentKey,
          entries,
          tailMessages: [],
          fromSeq: view.seq + 1,
          hasMore: start > 0 || base.truncated,
          source: base.source,
        };
        const oldest = entries[0]?.id;
        if (oldest !== undefined) payload.oldestEntryId = oldest;
        return payload;
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
