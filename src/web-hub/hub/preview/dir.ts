/**
 * web-hub content-preview — the directory-listing kernel (dir-plan v3.1 §3.2/§3.3, P1b).
 *
 * `listPreviewDir` turns an ADMITTED directory fd (the fs admitter's `allowDir` branch, §3.1)
 * into a `PreviewDirListing`. The handle is listed EXCLUSIVELY through `/proc/self/fd/N`
 * (§3.6 — the listing is bound to the inode the admission re-verified; a by-path opendir would
 * re-walk the namespace and reopen the A→B→A swap window the plan refuses to linearize).
 * Every entry's `lstat("/proc/self/fd/N/<name>")` never follows the entry's own symlink.
 *
 * Budgets (§3.4): the listing runs on its OWN `PREVIEW_DIR_LIST_MS` (5 s) wall clock, appended
 * INDEPENDENTLY after the admission budget — opendir/readBatch/lstat are each a `previewFsStep`
 * (`min(2 s, listing-remaining)`) on the routes instance's tracker; a hung op surfaces as
 * 504 `E_DEADLINE` / 503 `E_BUSY`, an lstat-phase exhaustion only degrades to `statPartial`.
 *
 * Truncation priority is FIXED: scan (10 000 dirents, decides `complete`) → filter (denylist
 * hits vanish uncounted per §2.8 — no existence oracle; over-long names → `dropped`) →
 * entries (1 000, after the dirs-first sort) → bytes (512 KiB serialized envelope). The final
 * listing is serialized once more and asserted ≤ `PREVIEW_DIR_BODY_MAX_BYTES` — a defect in
 * the accumulation answers 500 `E_INTERNAL`, never an oversized body.
 *
 * Lifecycle (§3.3): the dir handle is closed in a `finally` through `boundedClose` (its own
 * 1 s deadline, no request signal); an opendir that resolves after its race gave up is handed
 * to `lateClose` — its OWN bounded race, counting its own zombie (§2.4's counting-ownership
 * rule). No name or path ever reaches the log.
 */

import {
  PREVIEW_DIR_BODY_MAX_BYTES,
  PREVIEW_DIR_ENTRIES_MAX,
  PREVIEW_DIR_LIST_MS,
  PREVIEW_DIR_NAME_MAX_BYTES,
  PREVIEW_DIR_SCAN_MAX,
  PREVIEW_DIR_STAT_CONCURRENCY,
  type PreviewDirEntry,
  type PreviewDirListing,
} from "../../protocol/preview.js";
import type { HubLog } from "../ports.js";
import { createReqDeadline } from "../req-deadline.js";
import {
  denyListHit,
  type PreviewDenyContext,
  type PreviewDirDirent,
  type PreviewDirHandle,
  type PreviewFs,
  type PreviewHandle,
} from "./admit.js";
import { boundedClose, isPreviewIoError, mapFsError, previewFsStep, type PreviewIoTracker } from "./fs.js";

/** §3.2: dirents fetched per `readBatch` call (≤ 40 calls to fill the 10 000 scan cap). */
const DIR_READ_BATCH = 256;

/** §3.2: serialized-envelope reserve for the non-`entries` fields of the listing object. */
const ENVELOPE_RESERVE_BYTES = 1024;

const textEncoder = new TextEncoder();
const utf8Len = (s: string): number => textEncoder.encode(s).length;

export interface ListPreviewDirInput {
  /** the admitted directory fd (fs admitter, `allowDir` branch). */
  fh: PreviewHandle;
  /** the admission's realpath result — the denylist re-check's anchor for entry names. */
  realpath: string;
  /** the request's original path spelling — the second denylist anchor (literal/canonical). */
  requestPath: string;
}

export interface ListPreviewDirDeps {
  fs: PreviewFs;
  now(): number;
  log: HubLog;
  tracker: PreviewIoTracker;
  denyCtx: PreviewDenyContext;
  /** per-step cap override; defaults to `PREVIEW_FS_STEP_MS` (exposed for fast tests only). */
  stepCapMs?: number;
}

export type ListPreviewDirResult =
  | { ok: true; listing: PreviewDirListing }
  | { ok: false; abort: true }
  | { ok: false; abort: false; status: number; code: string; retryAfterS?: number };

/** §3.2 dirs-first, name order (case-folded compare + codepoint tiebreak — locale-free). */
function compareDirents(a: PreviewDirDirent, b: PreviewDirDirent): number {
  const aDir = a.type === "dir";
  const bDir = b.type === "dir";
  if (aDir !== bDir) return aDir ? -1 : 1;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** errno code of a non-PreviewIoError throw, if any. */
function errnoOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export async function listPreviewDir(
  deps: ListPreviewDirDeps,
  input: ListPreviewDirInput,
  signal: AbortSignal,
): Promise<ListPreviewDirResult> {
  const deadline = createReqDeadline(deps.now, PREVIEW_DIR_LIST_MS); // §3.4: independent 5 s
  const step = <T>(lazy: () => Promise<T>): Promise<T> =>
    previewFsStep(
      lazy,
      deadline,
      signal,
      deps.stepCapMs === undefined
        ? { now: deps.now, tracker: deps.tracker }
        : { stepCapMs: deps.stepCapMs, now: deps.now, tracker: deps.tracker },
    );
  const mapped = (err: unknown): ListPreviewDirResult => {
    const m = mapFsError(err);
    if (m.kind === "abort") return { ok: false, abort: true };
    const base = {
      status: m.body.status,
      code: m.body.code,
      ...(m.body.reason === undefined ? {} : { reason: m.body.reason }),
    };
    return m.body.retryAfterS === undefined
      ? { ok: false, abort: false, ...base }
      : { ok: false, abort: false, ...base, retryAfterS: m.body.retryAfterS };
  };
  const dirPath = `/proc/self/fd/${input.fh.fd}`;
  const limits = { scan: false, entries: false, bytes: false };

  let dh: PreviewDirHandle | undefined;
  try {
    // -- opendir (late-resolving handles are recovered by lateClose, §3.3) -----------------
    let opendirInitiated: Promise<PreviewDirHandle> | undefined;
    const openPromise = step(() => {
      opendirInitiated = Promise.resolve().then(() => deps.fs.opendir(dirPath));
      return opendirInitiated;
    });
    openPromise.catch((err: unknown) => {
      if (opendirInitiated !== undefined && isPreviewIoError(err)) {
        // the race gave up, but the opendir may still hand us a handle — close it on its own
        // bounded race (§2.4: a recovery's I/O counts on ITS race, never another's)
        opendirInitiated.then((late) => boundedClose(() => late.close(), deps)).catch(() => undefined);
      }
    });
    dh = await openPromise;
    const handle: PreviewDirHandle = dh;

    // -- ① scan: `PREVIEW_DIR_SCAN_MAX` dirents decide `complete` --------------------------
    const raw: PreviewDirDirent[] = [];
    let scanned = 0;
    let complete = false;
    for (;;) {
      if (scanned >= PREVIEW_DIR_SCAN_MAX) {
        limits.scan = true;
        break;
      }
      const batch = await step(() => handle.readBatch(Math.min(DIR_READ_BATCH, PREVIEW_DIR_SCAN_MAX - scanned)));
      if (batch === null) {
        complete = true;
        break;
      }
      scanned += batch.length;
      raw.push(...batch);
    }

    // -- ② filter: denylist entries vanish UNCOUNTED (§2.8 — no existence oracle); over-long
    // names are dropped and counted; lossy-decoded names are flagged, kept.
    const filtered: PreviewDirDirent[] = [];
    let dropped = 0;
    for (const d of raw) {
      if (denyListHit(`${input.realpath}/${d.name}`, deps.denyCtx)) continue;
      if (denyListHit(`${input.requestPath}/${d.name}`, deps.denyCtx)) continue;
      if (utf8Len(d.name) > PREVIEW_DIR_NAME_MAX_BYTES) {
        dropped += 1;
        continue;
      }
      filtered.push(d);
    }
    let total = filtered.length;

    // -- ③ sort (dirs first) + entries cap ---------------------------------------------------
    filtered.sort(compareDirents);
    const kept = filtered.slice(0, PREVIEW_DIR_ENTRIES_MAX);
    limits.entries = filtered.length > PREVIEW_DIR_ENTRIES_MAX;

    // -- ④ lstat fan-out (concurrency `PREVIEW_DIR_STAT_CONCURRENCY`, shared deadline):
    // ENOENT ⇒ removed (vanished++, total−−); other errno ⇒ dirent type only; success ⇒ type
    // from lstat, size for files, floor'd mtimeMs; deadline/busy ⇒ stop issuing, statPartial.
    const entries: Array<PreviewDirEntry | undefined> = kept.map((d) => {
      const e: PreviewDirEntry = { name: d.name, type: d.type };
      if (d.name.includes("\uFFFD")) e.lossy = true;
      return e;
    });
    let vanished = 0;
    let statPartial = false;
    let aborted = false;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) {
          aborted = true;
          return;
        }
        // §3.2 (verifier 打回修复): once ANY worker hit deadline/busy, no NEW lstat is issued —
        // in-flight calls may still complete and apply their result, everything not yet
        // issued keeps its dirent type (statPartial:true tells the UI).
        if (statPartial) return;
        const i = next;
        next += 1;
        if (i >= entries.length) return;
        const entry = entries[i];
        if (entry === undefined) continue;
        let st: Awaited<ReturnType<PreviewFs["lstat"]>> | undefined;
        try {
          st = await step(() => deps.fs.lstat(`${dirPath}/${entry.name}`));
        } catch (err) {
          if (signal.aborted || (isPreviewIoError(err) && err.ioFail === "abort")) {
            aborted = true;
            return;
          }
          if (isPreviewIoError(err) && (err.ioFail === "deadline" || err.ioFail === "busy")) {
            statPartial = true; // stop issuing new lstats; the rest keep their dirent type
            return;
          }
          if (errnoOf(err) === "ENOENT") {
            entries[i] = undefined; // vanished between readdir and lstat
            vanished += 1;
            total -= 1;
            continue;
          }
          continue; // other errno ⇒ keep the dirent type, no size/mtime
        }
        const type: PreviewDirEntry["type"] = st.isDirectory()
          ? "dir"
          : st.isFile()
            ? "file"
            : st.isSymbolicLink()
              ? "symlink"
              : "other";
        const revised: PreviewDirEntry = { name: entry.name, type };
        if (type === "file") revised.size = st.size;
        revised.mtimeMs = Math.floor(st.mtimeMs);
        if (entry.lossy === true) revised.lossy = true;
        entries[i] = revised;
      }
    };
    if (entries.length > 0) {
      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < Math.min(PREVIEW_DIR_STAT_CONCURRENCY, entries.length); i += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);
    }
    if (aborted) return { ok: false, abort: true };
    const present = entries.filter((e): e is PreviewDirEntry => e !== undefined);

    // -- ⑤ byte budget: per-entry serialized size under the 512 KiB envelope (1 KiB reserve).
    let bytes = ENVELOPE_RESERVE_BYTES;
    let cut = present.length;
    for (let i = 0; i < present.length; i += 1) {
      const b = utf8Len(JSON.stringify(present[i])) + 1;
      if (bytes + b > PREVIEW_DIR_BODY_MAX_BYTES) {
        limits.bytes = true;
        cut = i;
        break;
      }
      bytes += b;
    }
    const finalEntries = present.slice(0, cut);

    const listing: PreviewDirListing = {
      entries: finalEntries,
      total,
      scanned,
      complete,
      truncated: finalEntries.length < total || !complete,
      limits,
      vanished,
      dropped,
      ...(statPartial ? { statPartial: true as const } : {}),
    };

    // -- defensive assert: the produced body must fit the wire cap (§3.2 tail).
    if (utf8Len(JSON.stringify(listing)) > PREVIEW_DIR_BODY_MAX_BYTES) {
      deps.log.error("preview dir listing exceeded its own byte budget", { event: "preview.dir_over_budget" });
      return { ok: false, abort: false, status: 500, code: "E_INTERNAL" };
    }
    return { ok: true, listing };
  } catch (err) {
    if (signal.aborted || (isPreviewIoError(err) && err.ioFail === "abort")) {
      return { ok: false, abort: true };
    }
    return mapped(err);
  } finally {
    const h = dh;
    if (h !== undefined) {
      await boundedClose(() => h.close(), deps); // §3.3: bounded, tracked, signal-free
    }
  }
}
