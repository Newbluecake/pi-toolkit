/**
 * web-resume plan §2.4 — the agent-side session-list generation for the web resume dialog
 * (`resume __list <json>` through the builtin bridge's `command` op).
 *
 * Never calls pi's `SessionManager.list` (r1 #7): every candidate file is opened through the
 * frozen §2.2 P1 core (`openSessionNoFollow`/`openSessionNoFollowAsync` — O_NOFOLLOW +
 * O_NONBLOCK + O_NOCTTY, regular-file-only, §2.2 "Open discipline") and read with the bounded
 * `readSessionHeadFd` (head ≤64 KiB, header line ≤4 KiB, tail ≤16 KiB only when size > 64 KiB).
 * No message text is ever retained — the generation keeps only id/title/flags plus the
 * `id → FileFact` index the pick path re-validates against (§2.5 b).
 *
 * Bounds (§2.4 table, all enforced here): files ≤5 000 newest-first (then `truncated`), rows
 * ≤2 000, build ≤64 MiB read + ≤5 s wall (`partial`, rows so far kept), provenance advance inside
 * the same 5 s with its own ≤2 s/≤64 MiB budget, ≤4 concurrent open fds per handle (the fs gate),
 * ≤1 build in flight per scope (single-flight), ≤2 total (there are exactly two scopes), ≤1 gen
 * retained per scope, first-page reuse only ≤10 s old, idle 120 s gens dropped lazily on the next
 * access (no timers — nothing here ever arms one). `session_shutdown` aborts in-flight builds
 * (AbortController into `advanceProvenance`) and bumps an epoch; a build finishing under an old
 * epoch is discarded — it never installs a gen (and the aborted provenance advance never writes
 * its cache).
 *
 * The P1 core is injected (`ResumeCorePort`, structurally the frozen §2.2 API) so every test can
 * drive this module without P1's disk code, while production wiring (`index.ts`) uses
 * `defaultResumeCore()` — the single import site of `src/session-nav/{session-head,provenance,
 * classify}.ts` in the agent package.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, type FileHandle } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import type {
  CmdArgs,
  CmdErrorCode,
  CmdFrame,
  CmdResultBody,
  ResumeSessionRowWire,
  ResumeSessionsWire,
} from "../protocol/messages.js";
import {
  openSessionNoFollow,
  openSessionNoFollowAsync,
  readSessionHeadFd,
  type FileFact,
  type HeadResult,
  type SessionHead,
} from "../../session-nav/session-head.js";
import { advanceProvenance, provenanceStatus, type ProvenanceIndex } from "../../session-nav/provenance.js";
import { displayTitle, isSubagentSession } from "../../session-nav/classify.js";

// ---------------------------------------------------------------------------
// the frozen §2.2 P1 core, as an injectable port
// ---------------------------------------------------------------------------

export type { FileFact, HeadResult, ProvenanceIndex, SessionHead };

/** Structural injection seam over the frozen §2.2 API (`src/session-nav/`). */
export interface ResumeCorePort {
  openSessionNoFollow(path: string): { fd: number; fact: FileFact } | undefined;
  openSessionNoFollowAsync(path: string): Promise<{ handle: FileHandle; fact: FileFact } | undefined>;
  readSessionHeadFd(fd: number, size: number): HeadResult;
  advanceProvenance(
    sessionDir: string,
    budget: { ms: number; bytes: number },
    signal?: AbortSignal,
  ): Promise<ProvenanceIndex>;
  isSubagentSession(absPath: string, head: { child: boolean } | undefined, index: ProvenanceIndex): boolean;
  displayTitle(head: SessionHead): { title: string; source: "name" | "first" | "none" };
}

/** Production core: the frozen §2.2 implementations. The ONLY import site of the P1 modules in
 *  the agent package — if P1's shapes drift, this object literal is where typecheck fails. */
export function defaultResumeCore(): ResumeCorePort {
  return {
    openSessionNoFollow,
    openSessionNoFollowAsync,
    readSessionHeadFd: (fd, size) => readSessionHeadFd(fd, size),
    advanceProvenance,
    isSubagentSession,
    displayTitle,
  };
}

// ---------------------------------------------------------------------------
// bounds (§2.4 table)
// ---------------------------------------------------------------------------

export const RESUME_WINDOW_HOURS = 48;
export const RESUME_WINDOW_MS = RESUME_WINDOW_HOURS * 3_600_000;
export const RESUME_FILES_MAX = 5_000;
export const RESUME_ROWS_MAX = 2_000;
export const RESUME_BUILD_TOTAL_MS = 5_000;
export const RESUME_BUILD_BYTES = 64 * 1024 * 1024;
export const RESUME_PROV_MS = 2_000;
export const RESUME_PROV_BYTES = 64 * 1024 * 1024;
export const RESUME_PAGE_ROWS = 100;
export const RESUME_PAGE_BYTES = 32 * 1024;
export const RESUME_TITLE_MAX_UTF16 = 120;
export const RESUME_GEN_REUSE_MS = 10_000;
export const RESUME_GEN_IDLE_MS = 120_000;
export const RESUME_Q_MAX = 128;
export const RESUME_CURSOR_MAX = 128;
export const RESUME_FS_GATE_SLOTS = 4;
/** Upper bound of one file's head/tail read cost used for the 64 MiB build budget. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 16 * 1024;

export type ResumeScope = "recent" | "all";

function errResult(code: CmdErrorCode, retryable: boolean, message?: string): CmdResultBody {
  return message !== undefined
    ? { ok: false, code, retryable, effect: "none", message }
    : { ok: false, code, retryable, effect: "none" };
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function qHashOf(q: string | undefined): string {
  return createHash("sha256")
    .update(q ?? "", "utf8")
    .digest("hex")
    .slice(0, 8);
}

/** §2.4 title bound: ≤120 UTF-16 units, surrogate-safe at the cut. `displayTitle` (P1) already
 *  guarantees this — the re-clip is a defensive backstop, never a semantic change. */
function clipTitle(title: string): string {
  if (title.length <= RESUME_TITLE_MAX_UTF16) return title;
  let cut = title.slice(0, RESUME_TITLE_MAX_UTF16);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // never split a surrogate pair
  return cut;
}

interface RowCore {
  id: string;
  title: string;
  titleSource: "name" | "first" | "none";
  modifiedMs: number;
  current: boolean;
  forked: boolean;
}

/** A retained generation: ≤1 per scope. Carries the pick path's `id → FileFact` index and the
 *  provenance index the exec re-validation re-uses (§2.5 b) — both bound to the same scan. */
export interface ResumeGenRecord {
  gen: string;
  scope: ResumeScope;
  builtAt: number;
  lastAccessAt: number;
  rows: readonly RowCore[];
  facts: Map<string, { path: string; fact: FileFact }>;
  index: ProvenanceIndex;
  provenance: "complete" | "partial" | "capacity";
  partial: boolean;
  truncated: boolean;
  ambiguous: number;
}

export interface ResumeListDeps {
  getSessionDir(): string;
  cwd(): string;
  currentSessionId(): string;
  now(): number;
  core?: ResumeCorePort;
}

export interface ResumeTarget {
  path: string;
  fact: FileFact;
  index: ProvenanceIndex;
}

export interface ResumeListHandle {
  /** §2.4 `__list`: build/reuse a generation and return the page. Never throws. */
  list(frame: CmdFrame, cmd: CmdArgs & { op: "command" }): Promise<CmdResultBody>;
  /** §2.5 step 4: the gen index lookup `id → FileFact` (+ the gen's provenance index). */
  lookup(genId: string, id: string): ResumeTarget | undefined;
  /** The retained gen id for a scope (test/diagnostic surface; the pick binds ids itself). */
  genOf(scope: ResumeScope): string | undefined;
  /** §2.4 fence: abort in-flight builds, bump the epoch, drop retained gens. */
  onShutdown(): void;
}

/** ≤4 concurrent open fds for this handle's head reads (both scopes share one gate). */
function createFsGate(slots: number) {
  let free = slots;
  const waiters: Array<() => void> = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      while (free === 0) await new Promise<void>((r) => waiters.push(r));
      free -= 1;
      try {
        return await fn();
      } finally {
        free += 1;
        waiters.shift()?.();
      }
    },
  };
}

const EMPTY_INDEX: ProvenanceIndex = { has: () => false, complete: true };

/** §2.4 wire enum — P1's `provenanceStatus` (complete / partial / capacity, r2 #7). */
function provenanceStateOf(index: ProvenanceIndex): "complete" | "partial" | "capacity" {
  return provenanceStatus(index);
}

function pageOfRows(rows: readonly RowCore[], q: string | undefined): RowCore[] {
  if (q === undefined || q === "") return rows.slice();
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "");
  if (tokens.length === 0) return rows.slice();
  return rows.filter((r) => {
    const title = r.title.toLowerCase();
    return tokens.every((t) => title.includes(t));
  });
}

function toWireRow(r: RowCore): ResumeSessionRowWire {
  const row: ResumeSessionRowWire = {
    id: r.id,
    title: r.title,
    titleSource: r.titleSource,
    modifiedMs: r.modifiedMs,
  };
  if (r.current) row.current = true;
  if (r.forked) row.forked = true;
  return row;
}

export function createResumeList(deps: ResumeListDeps): ResumeListHandle {
  const core = deps.core ?? defaultResumeCore();
  const now = (): number => deps.now();
  const gate = createFsGate(RESUME_FS_GATE_SLOTS);
  /** §2.4 fence epoch — bumped by every shutdown; a build completing under a stale one is
   *  discarded before it can install a gen. */
  let epoch = 0;
  const inflightAborts = new Set<AbortController>();
  const gens = new Map<ResumeScope, ResumeGenRecord>();
  const genById = new Map<string, ResumeGenRecord>();
  const building = new Map<ResumeScope, Promise<ResumeGenRecord | undefined>>();

  const touch = (rec: ResumeGenRecord): void => {
    rec.lastAccessAt = now();
  };

  /** §2.4 lifetime rule, lazily applied at every access (no timers): a gen idle >120 s is
   *  dropped rather than served. */
  const liveGen = (scope: ResumeScope): ResumeGenRecord | undefined => {
    const rec = gens.get(scope);
    if (rec === undefined) return undefined;
    if (now() - rec.lastAccessAt > RESUME_GEN_IDLE_MS) {
      gens.delete(scope);
      genById.delete(rec.gen);
      return undefined;
    }
    return rec;
  };

  const install = (rec: ResumeGenRecord): void => {
    const prev = gens.get(rec.scope);
    if (prev !== undefined) genById.delete(prev.gen);
    gens.set(rec.scope, rec);
    genById.set(rec.gen, rec);
  };

  async function build(scope: ResumeScope): Promise<ResumeGenRecord | undefined> {
    const myEpoch = epoch;
    const start = now();
    const ac = new AbortController();
    inflightAborts.add(ac);
    try {
      let dir = "";
      try {
        dir = deps.getSessionDir();
      } catch {
        return undefined;
      }
      if (dir === "") return undefined;
      const resolveCwd = resolve(deps.cwd());
      const currentId = safe(() => deps.currentSessionId(), "");

      // ① candidates: `.jsonl` lstat'd regular files, newest first, cap 5 000.
      let dirents: Dirent[] = [];
      try {
        dirents = (await readdir(dir, { withFileTypes: true })).filter((d) => d.name.endsWith(".jsonl") && d.isFile());
      } catch {
        dirents = []; // missing/unreadable dir ⇒ an empty, complete generation
      }
      interface Candidate {
        path: string;
        mtimeMs: number;
        size: number;
      }
      const windowFloor = scope === "recent" ? now() - RESUME_WINDOW_MS : -Infinity;
      const candidates: Candidate[] = [];
      for (const d of dirents) {
        if (ac.signal.aborted) break;
        const path = resolve(dir, d.name);
        try {
          const st = await lstat(path); // lstat: a symlink to a session file is not a candidate
          if (!st.isFile()) continue;
          if (st.mtimeMs < windowFloor) continue;
          candidates.push({ path, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          continue; // vanished between readdir and lstat — not a candidate
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const truncatedByFiles = candidates.length > RESUME_FILES_MAX;
      const files = truncatedByFiles ? candidates.slice(0, RESUME_FILES_MAX) : candidates;

      // ② provenance advance — whole-dir, budgeted, inside the same 5 s (§2.4).
      let index: ProvenanceIndex = EMPTY_INDEX;
      if (files.length > 0) {
        try {
          index = await core.advanceProvenance(dir, { ms: RESUME_PROV_MS, bytes: RESUME_PROV_BYTES }, ac.signal);
        } catch {
          index = { has: () => false, complete: false };
        }
      }

      // ③ bounded head reads under the ≤4-slot fs gate.
      const rows: RowCore[] = [];
      const facts = new Map<string, { path: string; fact: FileFact }>();
      const rowsById = new Map<string, RowCore[]>();
      let readBytes = 0;
      let partial = false;
      let truncated = truncatedByFiles;
      for (const f of files) {
        if (ac.signal.aborted) {
          partial = true;
          break;
        }
        if (now() - start >= RESUME_BUILD_TOTAL_MS) {
          partial = true; // rows so far are kept
          break;
        }
        readBytes += Math.min(f.size, HEAD_BYTES) + (f.size > HEAD_BYTES ? TAIL_BYTES : 0);
        if (readBytes > RESUME_BUILD_BYTES) {
          partial = true;
          break;
        }
        if (rows.length >= RESUME_ROWS_MAX) {
          truncated = true;
          break;
        }
        await gate.run(async () => {
          const opened = await core.openSessionNoFollowAsync(f.path);
          if (opened === undefined) return; // gone / symlink swap / non-regular — skipped
          try {
            const r = core.readSessionHeadFd(opened.handle.fd, opened.fact.size);
            if (!r.ok) return;
            const head = r.head;
            if (resolve(head.cwd) !== resolveCwd) return; // shared custom sessionDir (r1 #3)
            if (core.isSubagentSession(f.path, head, index)) return; // D1: dropped entirely
            const title = clipTitle(core.displayTitle(head).title);
            const source = core.displayTitle(head).source;
            const row: RowCore = {
              id: head.id,
              title,
              titleSource: source,
              modifiedMs: opened.fact.mtimeMs,
              current: head.id === currentId,
              forked: head.forked,
            };
            rows.push(row);
            const bucket = rowsById.get(head.id);
            if (bucket === undefined) rowsById.set(head.id, [row]);
            else bucket.push(row);
            facts.set(head.id, { path: f.path, fact: opened.fact });
          } finally {
            await opened.handle.close().catch(() => undefined);
          }
        });
      }

      // ④ duplicate header ids: all copies omitted, counted in `ambiguous` (r1 #10).
      let ambiguous = 0;
      const uniqueRows: RowCore[] = [];
      for (const [id, bucket] of rowsById) {
        if (bucket.length > 1) {
          ambiguous += 1;
          facts.delete(id);
          continue;
        }
        uniqueRows.push(bucket[0]!);
      }
      // ⑤ stable order: modifiedMs desc, then id asc.
      uniqueRows.sort((a, b) => b.modifiedMs - a.modifiedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      // ⑥ the fence: a build that raced a session boundary is discarded, never installed.
      if (myEpoch !== epoch || ac.signal.aborted) return undefined;
      const rec: ResumeGenRecord = {
        gen: randomBytes(8).toString("hex"),
        scope,
        builtAt: now(),
        lastAccessAt: now(),
        rows: uniqueRows,
        facts,
        index,
        provenance: provenanceStateOf(index),
        partial,
        truncated,
        ambiguous,
      };
      return rec;
    } finally {
      inflightAborts.delete(ac);
    }
  }

  /** First-page semantics (§2.4 lifetime): reuse a gen ≤10 s old, else single-flight rebuild. */
  async function currentGen(scope: ResumeScope): Promise<ResumeGenRecord | undefined> {
    const existing = liveGen(scope);
    if (existing !== undefined && now() - existing.builtAt <= RESUME_GEN_REUSE_MS) {
      touch(existing);
      return existing;
    }
    let p = building.get(scope);
    if (p === undefined) {
      p = build(scope).then((rec) => {
        building.delete(scope);
        if (rec !== undefined) install(rec);
        return rec;
      });
      building.set(scope, p);
      p.catch(() => building.delete(scope));
    }
    return p;
  }

  interface ListRequest {
    scope: ResumeScope;
    q: string | undefined;
    cursor: string | undefined;
  }

  function parseListArgs(
    cmd: CmdArgs & { op: "command" },
  ): { ok: true; req: ListRequest } | { ok: false; result: CmdResultBody } {
    const trimmed = cmd.args.trim();
    const head = trimmed.split(/\s+/)[0];
    if (head !== "__list") {
      return { ok: false, result: errResult("E_BAD_REQUEST", true, "expected __list") };
    }
    const rest = trimmed.slice(head.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rest === "" ? "{}" : rest);
    } catch {
      return { ok: false, result: errResult("E_BAD_REQUEST", true, "bad __list json") };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, result: errResult("E_BAD_REQUEST", true, "bad __list json") };
    }
    const o = parsed as Record<string, unknown>;
    const scope = o.scope;
    if (scope !== "recent" && scope !== "all") {
      return { ok: false, result: errResult("E_BAD_REQUEST", true, "bad scope") };
    }
    let q: string | undefined;
    if (o.q !== undefined) {
      if (typeof o.q !== "string" || o.q.length > RESUME_Q_MAX) {
        return { ok: false, result: errResult("E_BAD_REQUEST", true, "bad q") };
      }
      q = o.q;
    }
    let cursor: string | undefined;
    if (o.cursor !== undefined) {
      if (typeof o.cursor !== "string" || o.cursor.length === 0 || o.cursor.length > RESUME_CURSOR_MAX) {
        return { ok: false, result: errResult("E_BAD_REQUEST", true, "bad cursor") };
      }
      cursor = o.cursor;
    }
    return { ok: true, req: { scope, q, cursor } };
  }

  async function list(frame: CmdFrame, cmd: CmdArgs & { op: "command" }): Promise<CmdResultBody> {
    void frame;
    const parsed = parseListArgs(cmd);
    if (!parsed.ok) return parsed.result;
    const { scope, q, cursor } = parsed.req;
    const qHash = qHashOf(q);

    let rec: ResumeGenRecord | undefined;
    let offset = 0;
    let reset = false;
    if (cursor !== undefined) {
      // `<genId>.<offset>.<qHash>` — malformed ⇒ E_BAD_REQUEST; well-formed but stale ⇒ reset.
      const parts = cursor.split(".");
      if (
        parts.length !== 3 ||
        !/^[0-9a-f]{16}$/.test(parts[0]!) ||
        !/^\d+$/.test(parts[1]!) ||
        !/^[0-9a-f]{8}$/.test(parts[2]!)
      ) {
        return errResult("E_BAD_REQUEST", true, "bad cursor");
      }
      const hit = liveGen(scope) !== undefined ? genById.get(parts[0]!) : undefined;
      if (hit === undefined || hit.scope !== scope || parts[2] !== qHash) {
        reset = true; // gen gone (rebuild/idle-drop/shutdown) or q changed ⇒ fresh first page
      } else {
        rec = hit;
        touch(rec);
        offset = Math.min(Number.parseInt(parts[1]!, 10), Math.max(0, rec.rows.length));
      }
    }
    if (rec === undefined) {
      try {
        rec = await currentGen(scope);
      } catch {
        return errResult("E_UNSUPPORTED", false, "none"); // never-throw: a broken build is a clean error
      }
      if (rec === undefined) return errResult("E_STALE_CTX", true, "resume:scanning");
      offset = 0;
    }

    const filtered = pageOfRows(rec.rows, q);
    const total = filtered.length;
    const wireRows: ResumeSessionRowWire[] = [];
    let pageBytes = 0;
    for (let i = offset; i < total && wireRows.length < RESUME_PAGE_ROWS; i += 1) {
      const wire = toWireRow(filtered[i]!);
      const cost = byteLen(JSON.stringify(wire));
      if (pageBytes + cost > RESUME_PAGE_BYTES && wireRows.length > 0) break;
      wireRows.push(wire);
      pageBytes += cost;
    }
    const next = offset + wireRows.length < total ? `${rec.gen}.${offset + wireRows.length}.${qHash}` : undefined;
    const wire: ResumeSessionsWire = {
      v: 1,
      scope,
      windowHours: RESUME_WINDOW_HOURS,
      gen: rec.gen,
      total,
      rows: wireRows,
      provenance: rec.provenance,
      builtAt: rec.builtAt,
      ...(q !== undefined && q !== "" ? { q } : {}),
      ...(next !== undefined ? { next } : {}),
      ...(reset ? { reset: true } : {}),
      ...(rec.partial ? { partial: true } : {}),
      ...(rec.truncated ? { truncated: true } : {}),
      ...(rec.ambiguous > 0 ? { ambiguous: rec.ambiguous } : {}),
    };
    return { ok: true, data: { op: "command", kind: "builtin", completion: "sync", sessions: wire } };
  }

  return {
    list,
    lookup(genId, id) {
      const rec = genById.get(genId);
      if (rec === undefined) return undefined;
      touch(rec);
      const hit = rec.facts.get(id);
      if (hit === undefined) return undefined;
      return { path: hit.path, fact: hit.fact, index: rec.index };
    },
    genOf(scope) {
      return liveGen(scope)?.gen;
    },
    onShutdown() {
      epoch += 1;
      for (const ac of inflightAborts) {
        try {
          ac.abort();
        } catch {
          /* never throw */
        }
      }
      inflightAborts.clear();
      gens.clear();
      genById.clear();
    },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
