/**
 * web-hub session-history plan §4.5.3 (`index.ts`): the cross-gen header index + `page()`.
 *
 * The header-index cache (`key ⇒ {dev,ino,size,head|formatError}`) is service-scoped (survives
 * across generations — PD8's whole point: a file an earlier, now-expired gen already parsed
 * never needs a re-read unless its identity/size says otherwise). `page()` drives one gen
 * forward via `generation.ts`'s continuable `advance()`, then walks `pos..` applying PD7/PD8's
 * header rules, PD23's per-page sort, and the kind/q filters, through the SAME fd-anchored
 * discipline (dir fd per directory, reopened via `/proc/self/fd/<rootFd>/<dir>`, reused for
 * every file of that directory within the page, closed at the end).
 */
import type { ReqDeadline } from "../../req-deadline.js";
import type { AgentView } from "../../ports.js";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  HISTORY_Q_MAX_CHARS,
  type HistoryBlocked,
  type HistoryCwdState,
  type HistoryItemWire,
  type HistoryKind,
  type HistoryLiveWire,
  type HistoryPage,
} from "../../../protocol/session-history.js";
import type { HistoryListQuery, HistoryPageResult, ManagedSessionView } from "./ports.js";
import type { FileStat, GenStore } from "./generation.js";
import { createHeadParser, type HeadResult, type HeaderError } from "./head.js";
import { buildSearchBlob, resolveTitle } from "./title.js";
import type { FdLedger } from "./fd-ledger.js";
import {
  errCodeOf,
  fdPath,
  HISTORY_DIR_OPEN_FLAGS,
  HISTORY_FILE_OPEN_FLAGS,
  type HistoryFs,
  type HistoryHandle,
} from "./fs.js";
import { boundedClose, boundedFdOpen, historyStep, type HistoryIoGate } from "./budget.js";
import {
  HISTORY_HEAD_BLOCK_BYTES,
  HISTORY_HEAD_FILE_MS,
  HISTORY_HEAD_MAX_BYTES,
  HISTORY_PAGE_BYTES_MAX,
} from "./budget.js";
import type { CwdCache, CwdCheckDeps } from "./cwd.js";

interface IndexEntry {
  dev: number;
  ino: number;
  size: number;
  head?: HeadResult;
  formatError?: HeaderError;
}

export interface HeaderIndex {
  get(key: string): IndexEntry | undefined;
  set(key: string, entry: IndexEntry): void;
}

export function createHeaderIndex(): HeaderIndex {
  const map = new Map<string, IndexEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => map.set(key, entry),
  };
}

function abbreviateHome(path: string, home: string | undefined): string {
  if (home === undefined || home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function needsReread(prev: IndexEntry | undefined, dev: number, ino: number, size: number): boolean {
  if (prev === undefined) return true;
  if (prev.dev !== dev || prev.ino !== ino) return true;
  if (size < prev.size) return true;
  if (prev.head !== undefined && !prev.head.complete && size > prev.size) return true;
  return false;
}

export interface PageDeps {
  genStore: GenStore;
  fs: HistoryFs;
  gate: HistoryIoGate;
  ledger: FdLedger;
  uid: number;
  now(): number;
  home?: string;
  cwdCache: CwdCache;
  cwdFsDeps: CwdCheckDeps;
  registry: { list(): readonly AgentView[] };
  managed(): readonly ManagedSessionView[];
  headerIndex: HeaderIndex;
  /** cheap, cached page-level liveness hint (§4.5.5's C3, throttled to PROC_SCAN_CACHE_MS). */
  liveness(): "partial" | "no-proc" | undefined;
}

function cardLive(registry: { list(): readonly AgentView[] }, id: string): { name?: string; live?: HistoryLiveWire } {
  for (const card of registry.list()) {
    if (card.session?.sessionId !== id) continue;
    const live: HistoryLiveWire = { state: "open", by: "card" };
    if (card.agentKey !== undefined) live.agentKey = card.agentKey;
    if (card.pid !== undefined) live.pid = card.pid;
    const out: { name?: string; live?: HistoryLiveWire } = { live };
    if (card.session.name !== undefined) out.name = card.session.name;
    return out;
  }
  return {};
}

function managedLive(managed: readonly ManagedSessionView[], id: string): HistoryLiveWire | undefined {
  for (const rec of managed) {
    const targetId = rec.sessionTarget?.id ?? rec.sessionId;
    if (targetId !== id) continue;
    if (rec.state === "exited" || rec.state === "failed") continue;
    const live: HistoryLiveWire = { state: "open", by: "managed" };
    if (rec.pid !== undefined) live.pid = rec.pid;
    return live;
  }
  return undefined;
}

function blockedOf(cwdState: HistoryCwdState, idValid: boolean): HistoryBlocked | undefined {
  if (!idValid) return "invalid";
  if (cwdState === "ok" || cwdState === "unknown") return undefined;
  return cwdState;
}

async function readHeader(
  handle: HistoryHandle,
  size: number,
  deps: { gate: HistoryIoGate; now(): number; deadlineAt: number },
): Promise<HeadResult> {
  const parser = createHeadParser();
  const maxBytes = Math.min(size, HISTORY_HEAD_MAX_BYTES);
  let position = 0;
  while (position < maxBytes) {
    const blockLen = Math.min(HISTORY_HEAD_BLOCK_BYTES, maxBytes - position);
    const buf = Buffer.alloc(blockLen);
    const { bytesRead } = await historyStep(
      deps.gate,
      () => handle.read(buf, 0, blockLen, position),
      deps.deadlineAt,
      deps.now,
    );
    if (bytesRead <= 0) break;
    const chunk = bytesRead === blockLen ? buf : buf.subarray(0, bytesRead);
    position += bytesRead;
    if (parser.push(chunk) === "done") break;
  }
  return parser.finish();
}

const textEncoder = new TextEncoder();

export async function pageHistory(
  q: HistoryListQuery,
  deadline: ReqDeadline,
  deps: PageDeps,
): Promise<HistoryPageResult> {
  const cursor = q.cursor;
  const acq = await deps.genStore.acquire(cursor, deadline);
  if (acq.kind === "expired") return { ok: false, reason: "cursor-expired" };
  if (acq.kind === "create-failed") {
    return {
      ok: true,
      page: {
        items: [],
        partial: { reason: "enum" },
        stats: { files: 0, indexed: 0, enum: { complete: false, dirsDone: 0, dirsTotal: 0, dirsSkipped: 0 } },
      },
    };
  }
  const handle = acq.handle;
  const closeDeps = { gate: deps.gate, now: deps.now };
  const openDeps = { gate: deps.gate, ledger: deps.ledger, now: deps.now };
  try {
    const advanceResult = await handle.advance(deadline);
    // best-effort — a lock-acquire timeout just means this call skips the (idempotent)
    // opportunistic sort; the next page() for the same gen can still succeed.
    await handle.commitPaging(deadline.remaining(), () => handle.trySortIfFreshComplete());
    const snap = handle.snapshot();
    const pos = cursor?.pos ?? 0;

    const items: HistoryItemWire[] = [];
    const matched: HistoryItemWire[] = [];
    let nextPos = pos;
    let bodyBytes = 0;
    const limit = Math.min(q.limit > 0 ? q.limit : HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX);
    const qLower =
      q.q === undefined ? undefined : q.q.trim().slice(0, HISTORY_Q_MAX_CHARS).normalize("NFKC").toLowerCase();

    const dirHandles = new Map<string, { handle?: HistoryHandle; ok: boolean }>();
    let pagePartial: HistoryPage["partial"];

    // Finding 4 (c2) fix: every `.dir.name`-keyed retry counter lives in the SAME `ioFailures`
    // map `recordPagingFailure`/`recordPagingSuccess` already use for per-FILE keys — a
    // `__dir__/` prefix keeps the two namespaces disjoint (no real file key can start with it).
    const dirRetryKey = (dirName: string): string => `__dir__/${dirName}`;

    type DirOpenOutcome = { kind: "ok"; handle: HistoryHandle } | { kind: "changed" } | { kind: "retry" };

    /**
     * Finding 1 (late fds) + Finding 2a (temp fds never ledger-reserved) + Finding 3 (dir-open
     * errors ALL treated as deterministic "changed", never distinguishing a transient failure
     * from a real one) fixes, together: the dir fd is reserved via `boundedFdOpen` (kind
     * `"temp"`, released by the cleanup loop below once the whole page is done with it);
     * ENOENT/ENOTDIR/ELOOP (or an identity mismatch after a successful stat — TOCTOU) is
     * deterministic and is cached `{ok:false}` immediately; anything else (EIO/EACCES/a
     * `boundedFdOpen` busy/deadline outcome) is transient and goes through the SAME
     * consecutive-failure counter `recordPagingFailure` already provides, under the gen lock
     * (`handle.commitPaging`) — only the 3rd consecutive strike may consume it as "changed".
     */
    const openDirForPage = async (file: FileStat): Promise<DirOpenOutcome> => {
      const cached = dirHandles.get(file.dir.name);
      if (cached !== undefined) {
        return cached.ok && cached.handle !== undefined ? { kind: "ok", handle: cached.handle } : { kind: "changed" };
      }
      const retryKey = dirRetryKey(file.dir.name);
      const openRes = await boundedFdOpen(
        1,
        "temp",
        () => deps.fs.open(fdPath(snap.rootFd, file.dir.name), HISTORY_DIR_OPEN_FLAGS),
        deadline.at,
        openDeps,
      );
      if (!openRes.ok) {
        if (openRes.reason === "error") {
          const code = errCodeOf(openRes.err);
          if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
            dirHandles.set(file.dir.name, { ok: false });
            return { kind: "changed" };
          }
        }
        const commitRes = await handle.commitPaging(deadline.remaining(), () => handle.recordPagingFailure(retryKey));
        if (!commitRes.ok || !commitRes.value.skipped) return { kind: "retry" };
        dirHandles.set(file.dir.name, { ok: false });
        return { kind: "changed" };
      }
      const h = openRes.handle;
      let st: Awaited<ReturnType<HistoryHandle["stat"]>> | undefined;
      let statErr: unknown = undefined;
      try {
        st = await historyStep(deps.gate, () => h.stat(), deadline.at, deps.now);
      } catch (err) {
        statErr = err;
      }
      if (st === undefined) {
        await boundedClose(() => h.close(), closeDeps);
        deps.ledger.release(1, "temp");
        // Verifier round 3 (defect 1): a FAILED stat is deterministic ONLY when the errno
        // proves the pinned dir fd itself is gone (ENOENT/ENOTDIR/ELOOP); anything else —
        // EIO, a HistoryBusyError, the historyStep deadline race — is transient and goes
        // through the SAME 3-strike consecutive retry as the open failure above: strikes 1–2
        // keep the position (page breaks `partial io`), only the 3rd consecutive failure
        // consumes the entry (as a skip). The dir is never cached `{ok:false}` before then.
        const code = errCodeOf(statErr);
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") {
          const commitRes = await handle.commitPaging(deadline.remaining(), () => handle.recordPagingFailure(retryKey));
          if (!commitRes.ok || !commitRes.value.skipped) return { kind: "retry" };
        }
        dirHandles.set(file.dir.name, { ok: false });
        return { kind: "changed" };
      }
      if (!st.isDirectory() || st.dev !== file.dir.dev || st.ino !== file.dir.ino) {
        await boundedClose(() => h.close(), closeDeps);
        deps.ledger.release(1, "temp");
        dirHandles.set(file.dir.name, { ok: false });
        return { kind: "changed" };
      }
      await handle.commitPaging(deadline.remaining(), () => handle.recordPagingSuccess(retryKey));
      dirHandles.set(file.dir.name, { handle: h, ok: true });
      return { kind: "ok", handle: h };
    };

    while (nextPos < snap.files.length && matched.length < limit && bodyBytes < HISTORY_PAGE_BYTES_MAX) {
      if (deadline.expired()) {
        pagePartial = { reason: "budget" };
        break;
      }
      const file = snap.files[nextPos];
      if (file === undefined) break;
      const dirOutcome = await openDirForPage(file);
      if (dirOutcome.kind === "retry") {
        pagePartial = { reason: "io" };
        break;
      }
      if (dirOutcome.kind === "changed") {
        const cc = await handle.commitPaging(deadline.remaining(), () => handle.recordChanged());
        if (!cc.ok) {
          pagePartial = { reason: "io" };
          break;
        }
        nextPos += 1;
        continue;
      }
      const dirH = dirOutcome.handle;
      let entry = deps.headerIndex.get(file.key);
      if (needsReread(entry, file.dev, file.ino, file.size)) {
        const fileOpenRes = await boundedFdOpen(
          1,
          "temp",
          () => deps.fs.open(fdPath(dirH.fd, file.key.slice(file.dir.name.length + 1)), HISTORY_FILE_OPEN_FLAGS),
          deadline.at,
          openDeps,
        );
        if (!fileOpenRes.ok) {
          if (fileOpenRes.reason === "error") {
            const code = errCodeOf(fileOpenRes.err);
            if (code === "ENOENT" || code === "ENOTDIR") {
              const cc = await handle.commitPaging(deadline.remaining(), () => handle.recordVanished());
              if (!cc.ok) {
                pagePartial = { reason: "io" };
                break;
              }
              nextPos += 1;
              continue;
            }
          }
          const cc = await handle.commitPaging(deadline.remaining(), () => handle.recordPagingFailure(file.key));
          if (!cc.ok) {
            pagePartial = { reason: "io" };
            break;
          }
          if (!cc.value.skipped) {
            pagePartial = { reason: "io" };
            break;
          }
          nextPos += 1;
          continue;
        }
        const fileH = fileOpenRes.handle;
        let head: HeadResult;
        try {
          const st = await historyStep(deps.gate, () => fileH.stat(), deadline.at, deps.now);
          if (!st.isFile()) {
            await boundedClose(() => fileH.close(), closeDeps);
            const cc = await handle.commitPaging(deadline.remaining(), () => handle.recordInvalid());
            if (!cc.ok) {
              pagePartial = { reason: "io" };
              break;
            }
            entry = { dev: file.dev, ino: file.ino, size: file.size, formatError: "bad-header" };
            deps.headerIndex.set(file.key, entry);
            nextPos += 1;
            continue;
          }
          // Finding 3 (file-level TOCTOU) fix: the enumerated identity (dev/ino) plus ownership
          // and nlink must STILL match at paging time — a file swapped in between enumeration
          // and paging is never read; it is counted as `changed` (no headerIndex entry, so the
          // next page() re-checks fresh) instead of silently reading the new content.
          if (st.dev !== file.dev || st.ino !== file.ino || st.uid !== deps.uid || st.nlink !== 1) {
            await boundedClose(() => fileH.close(), closeDeps);
            const cc = await handle.commitPaging(deadline.remaining(), () => handle.recordChanged());
            if (!cc.ok) {
              pagePartial = { reason: "io" };
              break;
            }
            nextPos += 1;
            continue;
          }
          head = await readHeader(fileH, st.size, {
            gate: deps.gate,
            now: deps.now,
            deadlineAt: Math.min(deadline.at, deps.now() + HISTORY_HEAD_FILE_MS),
          });
          await boundedClose(() => fileH.close(), closeDeps);
        } catch {
          await boundedClose(() => fileH.close(), closeDeps);
          const cc = await handle.commitPaging(deadline.remaining(), () => handle.recordPagingFailure(file.key));
          if (!cc.ok) {
            pagePartial = { reason: "io" };
            break;
          }
          if (!cc.value.skipped) {
            pagePartial = { reason: "io" };
            break;
          }
          nextPos += 1;
          continue;
        }
        const successCommit = await handle.commitPaging(deadline.remaining(), () => {
          handle.recordPagingSuccess(file.key);
          if (head.error !== undefined) handle.recordInvalid();
        });
        if (!successCommit.ok) {
          pagePartial = { reason: "io" };
          break;
        }
        if (head.error !== undefined) {
          entry = { dev: file.dev, ino: file.ino, size: file.size, formatError: head.error };
        } else {
          entry = { dev: file.dev, ino: file.ino, size: file.size, head };
        }
        deps.headerIndex.set(file.key, entry);
      }
      nextPos += 1;
      if (entry === undefined || entry.formatError !== undefined || entry.head === undefined) continue; // invalid, already counted
      const head = entry.head;
      if (head.id === undefined || head.cwd === undefined) continue; // defensive — shouldn't happen when !ok

      if (q.kind !== "all" && head.kind === "sub") continue;
      const idValid = head.idValid === true;
      const { name: cardName, live: cardLiveWire } = cardLive(deps.registry, head.id);
      const title = resolveTitle({
        ...(cardName !== undefined ? { cardName } : {}),
        ...(head.name !== undefined ? { headerName: head.name } : {}),
        ...(head.firstMessage !== undefined ? { firstMessage: head.firstMessage } : {}),
      });
      if (qLower !== undefined && qLower.length > 0) {
        const blob = buildSearchBlob(head.cwd, title.title, head.firstMessage);
        if (!blob.includes(qLower)) continue;
      }

      const cwdState = await deps.cwdCache.check(head.cwd, deadline, deps.cwdFsDeps);
      const live = cardLiveWire ?? managedLive(deps.managed(), head.id);
      const item: HistoryItemWire = {
        key: file.key,
        id: head.id,
        cwd: head.cwd,
        cwdLabel: abbreviateHome(head.cwd, deps.home),
        startedAt: new Date(file.mtimeMs).toISOString(),
        mtimeMs: file.mtimeMs,
        size: file.size,
        titleSource: title.titleSource,
        kind: head.kind,
        cwdState,
        startable: idValid && (cwdState === "ok" || cwdState === "unknown"),
        indexed: true,
      };
      if (title.title !== undefined) item.title = title.title;
      if (head.forked === true) item.forked = true;
      const blocked = blockedOf(cwdState, idValid);
      if (blocked !== undefined) item.blocked = blocked;
      if (live !== undefined) item.live = live;
      else if (head.kind === "sub") item.forkOnly = "subagent";
      else if (head.kind === "unknown") {
        item.forkOnly = "unverified";
        item.proofGap = "kind";
      }
      matched.push(item);
      bodyBytes += textEncoder.encode(JSON.stringify(item)).length;
    }

    for (const d of dirHandles.values()) {
      if (d.handle !== undefined) {
        const h = d.handle;
        await boundedClose(() => h.close(), closeDeps);
        deps.ledger.release(1, "temp");
      }
    }

    items.push(...matched);
    const finalPartial =
      pagePartial ??
      (advanceResult.partial !== undefined && advanceResult.partial.reason !== "busy"
        ? { reason: advanceResult.partial.reason }
        : undefined);

    // Re-snapshot: the per-file loop above calls `handle.recordInvalid()`/`recordVanished()`/
    // `recordChanged()`/`recordPagingFailure()`, all of which mutate the gen's live counters
    // AFTER `snap` (taken right after `advance()`) was already captured as a frozen value. The
    // file list and enum/cursor fields are untouched by paging, so only the counters need a
    // fresh read.
    const finalSnap = handle.snapshot();

    const enumComplete = finalSnap.enum.complete;
    const hasMore = nextPos < finalSnap.files.length || !enumComplete;
    const incomplete =
      !enumComplete ||
      finalSnap.skipped > 0 ||
      finalSnap.enum.dirsSkipped > 0 ||
      finalSnap.changed > 0 ||
      finalSnap.enum.dirsTruncated === true ||
      finalSnap.enum.filesTruncated === true;

    const enumStats: HistoryPage["stats"]["enum"] = {
      complete: finalSnap.enum.complete,
      dirsDone: finalSnap.enum.dirsDone,
      dirsTotal: finalSnap.enum.dirsTotal,
      dirsSkipped: finalSnap.enum.dirsSkipped,
    };
    if (finalSnap.enum.dirsTruncated) enumStats.dirsTruncated = true;
    if (finalSnap.enum.filesTruncated) enumStats.filesTruncated = true;

    const page: HistoryPage = {
      items,
      stats: {
        files: finalSnap.files.length,
        indexed: items.length,
        invalid: finalSnap.invalid,
        vanished: finalSnap.vanished,
        skipped: finalSnap.skipped,
        changed: finalSnap.changed,
        enum: enumStats,
      },
    };
    if (hasMore) page.next = encodeHistoryCursor(finalSnap.genId, nextPos);
    if (finalPartial !== undefined) page.partial = finalPartial;
    if (incomplete) page.incomplete = true;
    const liveness = deps.liveness();
    if (liveness !== undefined) page.liveness = liveness;

    // best-effort, same as trySortIfFreshComplete above — a lock timeout here just means a
    // later page() call gets another chance to mark it.
    await handle.commitPaging(deadline.remaining(), () => handle.markPaged());
    return { ok: true, page };
  } finally {
    handle.release();
  }
}

export function parseCursor(raw: string | undefined): { genId: string; pos: number } | undefined | null {
  if (raw === undefined) return undefined;
  return decodeHistoryCursor(raw);
}

export type { HistoryKind };
