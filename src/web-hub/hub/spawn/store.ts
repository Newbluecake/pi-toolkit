/**
 * web-hub-spawn plan §SP5 (arch v2 §7.7): `<stateDir>/spawns.json` persistence — the L1 anchor.
 *
 * Every managed child process exists on disk BEFORE it is forked (L1: a `launching` record is
 * saved synchronously via `saveNow()`), and pid+identity land on disk in the same synchronous
 * segment right after fork. All writes are synchronous `writeFileSync(0600)` → `renameSync`
 * through a pid+gen-unique tmp name — the hub is single-threaded, so writes are naturally
 * serialized; a process crash needs no fsync (the page cache survives the process), and a
 * machine power loss kills the children too, so the shrunk file afterwards stays consistent.
 *
 * Close semantics (#5 hard gate): `flushAndClose()` cancels the debounce timer, writes pending
 * dirty data exactly once, then turns every later write into a no-op. Write failures (ENOSPC,
 * rename) mark the store unhealthy — the supervisor refuses NEW spawns while unhealthy ("if the
 * intent cannot be persisted, do not fork", L1) but keeps writing on every state transition; the
 * first success restores health. Error logs fire immediately on the first failure and then at
 * most once per 60 s.
 *
 * Sync IO is never pretend-cancellable (arch §7.6): request paths check their deadline BEFORE
 * calling in, and the work itself is bounded by size — payload ≤64 KiB (trim), read ≤256 KiB.
 * `flushAndClose` deliberately persists even at zero remaining budget, mirroring the crash path
 * ("budget 0: still one synchronous persist"): losing the final terminal state would orphan the
 * record, which is the worse failure.
 */
import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  SPAWN_NONTERMINAL_MAX,
  SPAWN_TERMINAL_KEEP,
  type FirstPromptState,
  type SpawnEndReason,
  type SpawnHint,
  type SpawnState,
} from "../../protocol/spawn.js";
import type { HubLog } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";

// ---------------------------------------------------------------------------
// on-disk shape (arch §7.7, format v2)
// ---------------------------------------------------------------------------

/** `launching` is the intent-only internal state — persisted, never put on the wire (SP9). */
export type StoredSpawnState = "launching" | SpawnState;

const TERMINAL_STATES: ReadonlySet<string> = new Set(["exited", "failed"]);
const ALL_STATES: ReadonlySet<string> = new Set(["launching", "starting", "live", "stopping", "exited", "failed"]);
const END_REASONS: ReadonlySet<string> = new Set([
  "user",
  "lifetime",
  "hub",
  "crash",
  "orphan",
  "protocol_error",
  "spawn_error",
  "register_timeout",
  "exited_early",
  "cwd_mismatch",
]);
const HINTS: ReadonlySet<string> = new Set([
  "register-timeout-hello",
  "register-timeout-session",
  "control-off",
  "newer-plugin",
  "cwd-mismatch",
  "protocol-error",
  "launcher-changed",
]);
const FIRST_PROMPT_STATES: ReadonlySet<string> = new Set(["pending", "sending", "delivered", "failed", "expired"]);

export function isTerminalSpawnState(state: StoredSpawnState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Who wrote the file — `bootId` drives the reboot-recovery rule (arch §7.7 recovery table). */
export interface WriterInfo {
  pid: number;
  startedAt: number;
  bootId: string;
}

export interface StoredOwner {
  listener: "loopback" | "lan";
  /** `null` on loopback (matches arch §7.7's `"user": null` example), absent-safe on load. */
  user?: string | null;
  reqId: string;
}

export interface StoredExit {
  code: number | null;
  signal: string | null;
  unconfirmed?: true;
}

export interface StoredFirstPrompt {
  state: FirstPromptState;
  /** The BODY is never persisted at any layer (arch §6.4) — only its length. */
  textLen: number;
  attempts?: number;
}

export interface StoredRecord {
  spawnId: string;
  state: StoredSpawnState;
  cwd: string;
  /** cwd pin (arch §4.5): dev/ino captured at admit, re-checked before fork. */
  dev: number;
  ino: number;
  createdAt: number;
  updatedAt: number;
  owner: StoredOwner;
  /** Identity quadruple — absent on `launching` records (arch §7.7). */
  pid?: number;
  procStartTicks?: number;
  bootId?: string;
  uid?: number;
  agentKey?: string;
  endReason?: SpawnEndReason | null;
  exit?: StoredExit | null;
  hint?: SpawnHint | null;
  firstPrompt?: StoredFirstPrompt;
  /** Basename of the stderr log inside the spawn logDir (SP5 `stderr-sink.ts`). */
  stderrLog?: string;
  /** web-hub-delete-session plan v2 §2.2/§2.6 (r1 #6): a delete was requested for this record
   * and has not yet been resolved (deleted, or abandoned per B-alive) — written synchronously
   * (`saveNow`, same L1 discipline as the intent/identity writes) BEFORE any further state
   * change, so a hub crash mid-delete still recovers the intent on the next boot. Absent means
   * "no delete in flight"; there is no `false` value on disk. */
  removeIntent?: true;
  /** web-hub-delete-session plan v2 §2.1 (C1): persisted evidence that this record's process was
   * NEVER forked (so a `pid === undefined` record can be judged `confirmed` dead instead of the
   * fail-closed `unknown` default) — `"never-forked"` when ①/③ failed before/during the fork
   * attempt itself, `"boot-changed"` when `init()` recovered the record after a machine reboot
   * (no process from a previous boot can possibly be this one). A `launching` record whose
   * crash-recovery environ scan merely found nothing (true miss vs. an inconclusive scan are
   * indistinguishable) carries NO evidence here on purpose — it stays `unknown`. */
  noProcess?: "never-forked" | "boot-changed";
}

// ---------------------------------------------------------------------------
// store limits (plan §SP5; size bounds are the sync-IO time bound, arch §7.6)
// ---------------------------------------------------------------------------

/** Envelope version of `spawns.json`. A file with any other `v` reads as corrupt. */
export const SPAWNS_FILE_VERSION = 2;
/** Read cap: a larger file is foreign/corrupt — ignored, never parsed (plan §SP5). */
export const SPAWNS_READ_MAX_BYTES = 256 * 1024;
/** Write target: trim terminal records until the serialized envelope fits (plan §SP5). */
export const SPAWNS_FILE_TARGET_BYTES = 64 * 1024;
/** `markDirty()` trailing debounce window (unref'd timer). */
export const SPAWNS_DEBOUNCE_MS = 200;
/** First write failure logs immediately; later ones at most once per this window. */
export const STORE_ERROR_LOG_THROTTLE_MS = 60_000;

// ---------------------------------------------------------------------------
// injectable sync fs surface (tests inject failures / observe tmp names)
// ---------------------------------------------------------------------------

export interface SyncFs {
  readFileSync(path: string, opts: { encoding: "utf8" }): string;
  writeFileSync(path: string, data: string, opts: { mode: number }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  statSync(path: string): { size: number };
  readdirSync(path: string): string[];
}

const REAL_SYNC_FS: SyncFs = {
  readFileSync: (p, o) => readFileSync(p, o),
  writeFileSync: (p, d, o) => writeFileSync(p, d, o),
  renameSync: (f, t) => renameSync(f, t),
  unlinkSync: (p) => unlinkSync(p),
  statSync: (p) => statSync(p),
  readdirSync: (p) => readdirSync(p),
};

// ---------------------------------------------------------------------------
// public result types
// ---------------------------------------------------------------------------

export interface SpawnStoreLoad {
  writer?: WriterInfo;
  records: StoredRecord[];
  /** Set when the previous file could not be trusted (renamed away or oversize-ignored). */
  corrupt?: true;
}

export type SpawnStoreWriteResult = { ok: true } | { ok: false; code: string };

export interface SpawnStore {
  /**
   * Synchronous startup read (≤256 KiB). Parse/shape failure renames the file to
   * `.corrupt-<ts>` (keeping only one) and yields empty records; an oversize file is ignored
   * in place. An already-expired deadline skips the read entirely (empty records) — checking
   * the budget before starting is the only deadline behavior sync IO promises (arch §7.6).
   */
  load(deadline: ReqDeadline): SpawnStoreLoad;
  /** Synchronous write NOW — the L1 path (intent, pid+identity), bypassing the debounce. */
  saveNow(records: readonly StoredRecord[]): SpawnStoreWriteResult;
  /** Trailing 200 ms debounce; `get` is re-invoked at fire time so the write sees fresh data. */
  markDirty(get: () => readonly StoredRecord[]): void;
  /** Idempotent close (#5): cancel timer → write dirty data once → writes become no-ops. */
  flushAndClose(deadline: ReqDeadline): void;
  /** False after a write failure, true again after the next successful write. */
  readonly healthy: boolean;
  readonly closed: boolean;
  /** Monotonic write counter — seeds from the loaded file so it survives hub restarts. */
  readonly gen: number;
}

export interface SpawnStoreDeps {
  /** Path of `spawns.json` (`webHubSpawnFiles(stateDir).spawnsJson`). */
  file: string;
  log: HubLog;
  now(): number;
  /** Partial override on top of the real sync fs (tests inject ENOSPC / rename failures). */
  fs?: Partial<SyncFs>;
  /** Defaults to `{pid: process.pid, startedAt: now(), bootId: /proc boot_id or ""}`. */
  writer?: WriterInfo;
}

/** On-disk envelope (arch §7.7): `{v: 2, gen, writer, records}` — validated in `load()`. */
export interface FileEnvelope {
  v: number;
  gen?: number;
  writer?: WriterInfo;
  records: StoredRecord[];
}

// ---------------------------------------------------------------------------
// load-side validation — these records feed kill decisions (L5), so a shape
// violation anywhere treats the WHOLE file as corrupt: partial state must never
// be trusted for signals (plan §SP5 "解析失败 ⇒ corrupt").
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRecordShapeOk(v: unknown): v is StoredRecord {
  if (!isRecord(v)) return false;
  const spawnId = v["spawnId"];
  if (typeof spawnId !== "string" || spawnId.length === 0) return false;
  const state = v["state"];
  if (typeof state !== "string" || !ALL_STATES.has(state)) return false;
  if (typeof v["cwd"] !== "string") return false;
  const dev = v["dev"];
  const ino = v["ino"];
  if (typeof dev !== "number" || !Number.isFinite(dev) || typeof ino !== "number" || !Number.isFinite(ino)) {
    return false;
  }
  const createdAt = v["createdAt"];
  const updatedAt = v["updatedAt"];
  if (
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt)
  ) {
    return false;
  }
  const owner = v["owner"];
  if (!isRecord(owner)) return false;
  const listener = owner["listener"];
  const reqId = owner["reqId"];
  if ((listener !== "loopback" && listener !== "lan") || typeof reqId !== "string" || reqId.length === 0) {
    return false;
  }
  const user = owner["user"];
  if (user !== undefined && user !== null && typeof user !== "string") return false;
  const pid = v["pid"];
  if (pid !== undefined && (typeof pid !== "number" || !Number.isFinite(pid))) return false;
  const procStartTicks = v["procStartTicks"];
  if (procStartTicks !== undefined && (typeof procStartTicks !== "number" || !Number.isFinite(procStartTicks))) {
    return false;
  }
  const uid = v["uid"];
  if (uid !== undefined && (typeof uid !== "number" || !Number.isFinite(uid))) return false;
  if (v["bootId"] !== undefined && typeof v["bootId"] !== "string") return false;
  if (v["agentKey"] !== undefined && typeof v["agentKey"] !== "string") return false;
  if (v["stderrLog"] !== undefined && typeof v["stderrLog"] !== "string") return false;
  // web-hub-delete-session plan v2 §2.2/§2.6/§2.1(C1): unknown-to-an-old-hub fields, so an
  // absent key is always fine (forward-compat); when present the value must be exactly what
  // this format defines — a shape violation anywhere treats the WHOLE file as corrupt (same
  // rule as every other field here, this file feeds kill decisions).
  const removeIntent = v["removeIntent"];
  if (removeIntent !== undefined && removeIntent !== true) return false;
  const noProcess = v["noProcess"];
  if (noProcess !== undefined && noProcess !== "never-forked" && noProcess !== "boot-changed") return false;
  const endReason = v["endReason"];
  if (endReason !== undefined && endReason !== null && !END_REASONS.has(String(endReason))) return false;
  const hint = v["hint"];
  if (hint !== undefined && hint !== null && !HINTS.has(String(hint))) return false;
  const exit = v["exit"];
  if (exit !== undefined && exit !== null) {
    if (!isRecord(exit)) return false;
    const code = exit["code"];
    if (code !== null && (typeof code !== "number" || !Number.isFinite(code))) return false;
    const signal = exit["signal"];
    if (signal !== null && typeof signal !== "string") return false;
    const unconfirmed = exit["unconfirmed"];
    if (unconfirmed !== undefined && unconfirmed !== true) return false;
  }
  const firstPrompt = v["firstPrompt"];
  if (firstPrompt !== undefined) {
    if (!isRecord(firstPrompt)) return false;
    const fpState = firstPrompt["state"];
    if (typeof fpState !== "string" || !FIRST_PROMPT_STATES.has(fpState)) return false;
    const textLen = firstPrompt["textLen"];
    if (typeof textLen !== "number" || !Number.isFinite(textLen)) return false;
    const attempts = firstPrompt["attempts"];
    if (attempts !== undefined && (typeof attempts !== "number" || !Number.isFinite(attempts))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// trim (plan §SP5: non-terminal ≤16, terminal ≤20, then envelope ≤64 KiB)
// ---------------------------------------------------------------------------

function recordAgeKey(r: StoredRecord, terminal: boolean): number {
  // Terminal age = when it ENDED (retention is a "recent history" list); non-terminal age =
  // when it was CREATED (they are all live bookkeeping).
  return terminal ? r.updatedAt : r.createdAt;
}

function capGroup(records: readonly StoredRecord[], terminal: boolean, max: number): StoredRecord[] {
  const members: Array<{ key: number; i: number }> = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r === undefined) continue; // noUncheckedIndexedAccess guard; unreachable for i < length
    if (isTerminalSpawnState(r.state) === terminal) members.push({ key: recordAgeKey(r, terminal), i });
  }
  if (members.length <= max) return [...records];
  members.sort((a, b) => a.key - b.key || a.i - b.i);
  const evict = new Set(members.slice(0, members.length - max).map((m) => m.i));
  return records.filter((_, i) => !evict.has(i));
}

function envelopeJson(records: readonly StoredRecord[], gen: number, writer: WriterInfo): string {
  return JSON.stringify({ v: SPAWNS_FILE_VERSION, gen, writer, records });
}

/** True when the final envelope still exceeds the target with no terminal records left. */
export function trimRecordsForWrite(
  records: readonly StoredRecord[],
  gen: number,
  writer: WriterInfo,
): { kept: StoredRecord[]; json: string; oversize: boolean } {
  let kept = capGroup(records, false, SPAWN_NONTERMINAL_MAX);
  kept = capGroup(kept, true, SPAWN_TERMINAL_KEEP);
  let json = envelopeJson(kept, gen, writer);
  while (Buffer.byteLength(json) > SPAWNS_FILE_TARGET_BYTES && kept.some((r) => isTerminalSpawnState(r.state))) {
    const terminalCount = kept.filter((r) => isTerminalSpawnState(r.state)).length;
    kept = capGroup(kept, true, terminalCount - 1);
    json = envelopeJson(kept, gen, writer);
  }
  return { kept, json, oversize: Buffer.byteLength(json) > SPAWNS_FILE_TARGET_BYTES };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export function createSpawnStore(deps: SpawnStoreDeps): SpawnStore {
  const fs: SyncFs = { ...REAL_SYNC_FS, ...deps.fs };
  const file = deps.file;
  const dir = dirname(file);
  const base = basename(file);
  const log = deps.log;
  const now = deps.now;

  // Sync boot_id read (readBootId in protocol/proc-identity.ts is async; the store is all-sync,
  // so it reads the same path through the injectable fs — "" when unavailable).
  let bootId = "";
  try {
    const raw = fs.readFileSync("/proc/sys/kernel/random/boot_id", { encoding: "utf8" }).trim();
    if (raw.length > 0) bootId = raw;
  } catch {
    /* non-Linux or unreadable — supervisor treats "" as unknown */
  }
  const writer: WriterInfo = deps.writer ?? { pid: process.pid, startedAt: now(), bootId };

  let gen = 0;
  let healthy = true;
  let closed = false;
  let dirty = false;
  let pendingGet: (() => readonly StoredRecord[]) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let loggedCloseNoop = false;
  let lastErrorLogAt = Number.NEGATIVE_INFINITY;

  const tmpName = (g: number): string => `${file}.tmp-${process.pid}-${g}`;
  const corruptPrefix = `${base}.corrupt-`;

  function logWriteFailure(code: string, detail: string): void {
    const t = now();
    if (t - lastErrorLogAt < STORE_ERROR_LOG_THROTTLE_MS) return;
    lastErrorLogAt = t;
    log.error("spawn store: write failed", { file, code, detail });
  }

  function errCode(err: unknown): string {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof err.code === "string" &&
      err.code.length > 0
    ) {
      return err.code;
    }
    return "E_IO";
  }

  function bestEffortUnlink(path: string): void {
    try {
      fs.unlinkSync(path);
    } catch {
      /* already gone / unwritable dir */
    }
  }

  function renameToCorrupt(): void {
    const target = `${dir}/${corruptPrefix}${now()}`;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(corruptPrefix)) bestEffortUnlink(`${dir}/${name}`);
      }
      fs.renameSync(file, target);
    } catch (err) {
      log.warn("spawn store: corrupt-rename failed", { file, code: errCode(err) });
    }
  }

  function writeNow(records: readonly StoredRecord[]): SpawnStoreWriteResult {
    gen += 1;
    const { json, oversize } = trimRecordsForWrite(records, gen, writer);
    if (oversize) {
      // Never drop a non-terminal record to satisfy a soft size cap — that would break L1/L4
      // recovery. The ≤256 KiB read cap still bounds the reader.
      log.warn("spawn store: envelope exceeds target with no terminal records left", {
        file,
        bytes: Buffer.byteLength(json),
      });
    }
    const tmp = tmpName(gen);
    try {
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      bestEffortUnlink(tmp);
      healthy = false;
      logWriteFailure(errCode(err), "write");
      return { ok: false, code: errCode(err) };
    }
    healthy = true;
    dirty = false;
    // The data just written supersedes whatever a pending debounce would flush; drop it so
    // "3 markDirty + saveNow" does not produce a duplicate write (plan §SP5 验收).
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    return { ok: true };
  }

  function fireDebounce(): void {
    timer = undefined;
    if (closed || !dirty) return;
    writeNow(pendingGet?.() ?? []);
  }

  return {
    load(deadline: ReqDeadline): SpawnStoreLoad {
      if (closed) {
        log.warn("spawn store: load() after close", { file });
        return { records: [] };
      }
      if (deadline.expired()) {
        log.warn("spawn store: load skipped, deadline expired", { file });
        return { records: [] };
      }
      let raw: string;
      try {
        if (fs.statSync(file).size > SPAWNS_READ_MAX_BYTES) {
          // Foreign/huge file: ignore in place (plan §SP5 "「>256 KiB 忽略」") — the next
          // successful write replaces it anyway.
          log.warn("spawn store: file over read cap, ignoring", { file });
          return { records: [], corrupt: true };
        }
        raw = fs.readFileSync(file, { encoding: "utf8" });
      } catch {
        return { records: [] }; // ENOENT (fresh state dir) or unreadable — nothing to recover
      }
      let loadedGen: number | undefined;
      let loadedWriter: WriterInfo | undefined;
      let loadedRecords: StoredRecord[];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) throw new Error("not-an-object");
        if (parsed["v"] !== SPAWNS_FILE_VERSION || !Array.isArray(parsed["records"])) {
          throw new Error("bad-envelope");
        }
        const rawRecords: unknown[] = parsed["records"];
        loadedRecords = [];
        for (const item of rawRecords) {
          if (!isRecordShapeOk(item)) throw new Error("bad-record");
          loadedRecords.push(item);
        }
        const rawWriter = parsed["writer"];
        if (rawWriter !== undefined) {
          if (!isRecord(rawWriter)) throw new Error("bad-writer");
          const wPid = rawWriter["pid"];
          const wStarted = rawWriter["startedAt"];
          if (
            typeof wPid !== "number" ||
            !Number.isFinite(wPid) ||
            typeof wStarted !== "number" ||
            !Number.isFinite(wStarted)
          ) {
            throw new Error("bad-writer");
          }
          const wBoot = rawWriter["bootId"];
          loadedWriter = { pid: wPid, startedAt: wStarted, bootId: typeof wBoot === "string" ? wBoot : "" };
        }
        const rawGen = parsed["gen"];
        loadedGen = typeof rawGen === "number" && Number.isFinite(rawGen) ? rawGen : undefined;
      } catch (err) {
        renameToCorrupt();
        log.warn("spawn store: corrupt spawns.json renamed, starting empty", {
          file,
          detail: err instanceof Error ? err.message : String(err),
        });
        return { records: [], corrupt: true };
      }
      if (loadedGen !== undefined && loadedGen >= gen && loadedGen < 1e9) {
        gen = loadedGen; // seed so file gen stays monotonic across hub restarts
      }
      return loadedWriter === undefined ? { records: loadedRecords } : { writer: loadedWriter, records: loadedRecords };
    },

    saveNow(records: readonly StoredRecord[]): SpawnStoreWriteResult {
      if (closed) return { ok: false, code: "E_CLOSED" };
      return writeNow(records);
    },

    markDirty(get: () => readonly StoredRecord[]): void {
      if (closed) {
        if (!loggedCloseNoop) {
          loggedCloseNoop = true;
          // HubLog has no debug level — info is the closest channel for a once-per-store note.
          log.info("spawn store: markDirty after close is a no-op", { file });
        }
        return;
      }
      dirty = true;
      pendingGet = get;
      if (timer === undefined) {
        timer = setTimeout(fireDebounce, SPAWNS_DEBOUNCE_MS);
        timer.unref();
      }
    },

    flushAndClose(deadline: ReqDeadline): void {
      if (closed) return; // idempotent, zero side effects on repeat calls
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (dirty) {
        // Sync IO is not cancellable and the crash path persists at budget 0 (arch §7.6) —
        // write even with an expired deadline, but say so.
        if (deadline.expired()) log.warn("spawn store: flushAndClose past deadline, persisting anyway", { file });
        writeNow(pendingGet?.() ?? []);
      }
      closed = true;
    },

    get healthy(): boolean {
      return healthy;
    },
    get closed(): boolean {
      return closed;
    },
    get gen(): number {
      return gen;
    },
  };
}
