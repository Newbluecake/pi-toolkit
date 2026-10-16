/**
 * web-hub-version plan §3.4/§3.5: the version-info service behind `GET /api/version`.
 *
 * One computation round at a time (single-flight); waiters ≤ `VERSION_LIMITS.waiters`
 * (`E_BUSY` beyond); a fully-ok result is cached 30 s, a result with any failed section 10 s.
 * A round is two parallel parts under a 4 s total budget — the file part (CHANGELOG.md +
 * package.json, ≤ 1 s) and the git part (≤ 3 s, `AbortSignal` into git). File IO cannot be
 * cancelled, so the round's SLOT stays held until every underlying operation has really settled
 * (a late result is discarded by generation); while the slot is held past the round's result and
 * the cache has expired, new callers get `E_BUSY` instead of piling on more IO. A requester's
 * disconnect only detaches that waiter. No interval, no resident timer: the per-round timers are
 * unref'd and cleared on settle; git's own timers live in `src/git/run.ts`.
 *
 * Never imports pi. Responses never carry filesystem paths or git stderr (see `version-git.ts`).
 */
import { constants as fsConstants } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { join } from "node:path";
import {
  VERSION_LIMITS,
  type CommitRef,
  type SectionError,
  type VersionChangelogWire,
  type VersionInfoWire,
  type VersionRepoWire,
} from "../protocol/version-info.js";
import type { GitRunner } from "../../git/run.js";
import { parseChangelogSections } from "./changelog.js";
import { defaultGitRunner, gitCommits, gitHead, type GitCtx } from "./version-git.js";
import type { HubInfo, HubLog, VersionInfoOutcome, VersionInfoPort } from "./ports.js";

// ---------------------------------------------------------------------------
// readBounded (§3.4)
// ---------------------------------------------------------------------------

export interface BoundedFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number; dev: number; ino: number; mtimeMs: number }>;
  read(buf: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface VersionFsDeps {
  open(path: string, flags: number): Promise<BoundedFileHandle>;
}

export function defaultVersionFs(): VersionFsDeps {
  return { open: (p, flags) => fsOpen(p, flags) as unknown as Promise<BoundedFileHandle> };
}

export type ReadBoundedResult =
  | { ok: true; key: string; text: string }
  | { ok: false; error: SectionError }
  | { ok: true; key: string; text: undefined; unchanged: true };

/** `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` → fstat must be a regular file ≤ cap → ≤ cap+1 byte read →
 *  `finally close`. FIFO / symlink / oversized map to `unavailable` / `too-large`; a missing file
 *  to `missing`. `prevKey` lets the caller skip the read when `(dev,ino,size,mtimeMs)` is
 *  unchanged (the result then carries `unchanged:true`). Never throws. */
export async function readBounded(
  fs: VersionFsDeps,
  path: string,
  cap: number = VERSION_LIMITS.fileBytes,
  prevKey?: string,
): Promise<ReadBoundedResult> {
  let fh: BoundedFileHandle | undefined;
  try {
    fh = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, error: "unavailable" };
    if (st.size > cap) return { ok: false, error: "too-large" };
    const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (prevKey !== undefined && prevKey === key) return { ok: true, key, text: undefined, unchanged: true };
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    while (n < cap + 1) {
      const { bytesRead } = await fh.read(buf, n, cap + 1 - n, n);
      if (bytesRead <= 0) break;
      n += bytesRead;
    }
    if (n > cap) return { ok: false, error: "too-large" };
    return { ok: true, key, text: buf.subarray(0, n).toString("utf8") };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return { ok: false, error: code === "ENOENT" ? "missing" : "unavailable" };
  } finally {
    if (fh !== undefined) await fh.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export interface VersionInfoServiceOptions {
  /** Package root (git toplevel candidate; CHANGELOG.md / package.json live here). */
  readonly pkgRoot: string;
  /** The hub's live `HubInfo` — the service writes `bootHead` and reads pid/startedAt. */
  readonly info: HubInfo;
  readonly git?: GitRunner;
  readonly fs?: VersionFsDeps;
  readonly realpath?: (p: string) => Promise<string>;
  readonly now: () => number;
  readonly log: HubLog;
  /** Called after `info.bootHead` was set (hub.ts: `registry.publish({type:"hub"})`). */
  readonly publish?: () => void;
  /** Test seam: override the budget table. */
  readonly limits?: Partial<
    Pick<typeof VERSION_LIMITS, "requestMs" | "gitStepMs" | "fileMs" | "okTtlMs" | "failTtlMs">
  >;
}

export interface VersionInfoService extends VersionInfoPort {
  captureBootHead(): void;
  dispose(): void;
}

const GIT_PHASE_MS = 3000;

interface Round {
  /** Resolves once the round's RESULT is ready (budget or both parts). */
  readonly result: Promise<VersionInfoWire>;
  waiters: number;
  resultReady: boolean;
}

function hasError(x: unknown): boolean {
  return typeof x === "object" && x !== null && "error" in x;
}

/** Trim to `VERSION_LIMITS.bodyBytes`: changelog tail sections first, then the commits tail. */
export function fitBody(data: VersionInfoWire): VersionInfoWire {
  const size = (): number => Buffer.byteLength(JSON.stringify(data), "utf8");
  let truncated = false;
  const cl = data.changelog;
  if (cl !== undefined && !hasError(cl)) {
    const sections = (cl as VersionChangelogWire).sections;
    while (size() > VERSION_LIMITS.bodyBytes && sections.length > 0) {
      sections.pop();
      truncated = true;
    }
  }
  const repo = data.repo;
  if (repo !== undefined && !hasError(repo)) {
    const commits = (repo as VersionRepoWire).commits;
    while (commits !== undefined && size() > VERSION_LIMITS.bodyBytes && commits.length > 0) {
      commits.pop();
      truncated = true;
    }
  }
  if (truncated) data.truncated = true;
  return data;
}

export function createVersionInfoService(opts: VersionInfoServiceOptions): VersionInfoService {
  const L = { ...VERSION_LIMITS, ...(opts.limits ?? {}) };
  const fs = opts.fs ?? defaultVersionFs();
  const runner = opts.git ?? defaultGitRunner();
  const lifetime = new AbortController();
  let disposed = false;
  let generation = 0;
  let round: Round | undefined;
  /** True from round start until every underlying operation really settled. */
  let slotHeld = false;
  let cache: { data: VersionInfoWire; expiresAt: number } | undefined;
  let bootCaptured = false;
  const fileKeys = new Map<string, { key: string; text: string }>();

  async function readCached(name: string): Promise<ReadBoundedResult> {
    const prev = fileKeys.get(name);
    const r = await readBounded(fs, join(opts.pkgRoot, name), VERSION_LIMITS.fileBytes, prev?.key);
    if (r.ok && "unchanged" in r && prev !== undefined) return { ok: true, key: r.key, text: prev.text };
    if (r.ok && r.text !== undefined) fileKeys.set(name, { key: r.key, text: r.text });
    else if (!r.ok) fileKeys.delete(name);
    return r;
  }

  function gitCtx(signal: AbortSignal, startedAt: number): GitCtx {
    return {
      pkgRoot: opts.pkgRoot,
      runner,
      signal,
      deadlineAt: startedAt + GIT_PHASE_MS,
      now: opts.now,
      ...(opts.realpath === undefined ? {} : { realpath: opts.realpath }),
    };
  }

  /** Bounded wait that never rejects; the underlying promise keeps running. */
  function raceTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const t = setTimeout(() => resolve(onTimeout), Math.max(1, ms));
      t.unref();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve(onTimeout);
        },
      );
    });
  }

  interface FilePart {
    changelog?: VersionChangelogWire | { error: SectionError };
    packageVersion?: string;
  }
  interface GitPart {
    repo?: VersionRepoWire | { error: SectionError };
  }

  async function readFiles(): Promise<FilePart> {
    const [cl, pkg] = await Promise.all([readCached("CHANGELOG.md"), readCached("package.json")]);
    const out: FilePart = {};
    if (cl.ok && cl.text !== undefined) {
      out.changelog = {
        sections: parseChangelogSections(cl.text, {
          changelogSections: VERSION_LIMITS.changelogSections,
          sectionBytes: VERSION_LIMITS.sectionBytes,
        }),
      };
    } else if (!cl.ok) {
      out.changelog = { error: cl.error };
    }
    if (pkg.ok && pkg.text !== undefined) {
      try {
        const v = (JSON.parse(pkg.text) as { version?: unknown } | null)?.version;
        if (typeof v === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(v)) out.packageVersion = v;
      } catch {
        // unreadable package.json: packageVersion simply stays absent.
      }
    }
    return out;
  }

  async function readGit(ctx: GitCtx): Promise<GitPart> {
    const head = await gitHead(ctx);
    if (head.kind === "absent") return {};
    if (head.kind === "error") return { repo: { error: head.error } };
    const c = await gitCommits(ctx, head.lastTag);
    const repo: VersionRepoWire = {
      head: head.head,
      ...(head.lastTag === undefined ? {} : { lastTag: head.lastTag }),
      ...(c.commits === undefined ? {} : { commits: c.commits }),
      ...(c.commitsTotal === undefined ? {} : { commitsTotal: c.commitsTotal }),
    };
    return { repo };
  }

  function startRound(): Round {
    const gen = ++generation;
    const startedAt = opts.now();
    const ac = new AbortController();
    const onLifetimeAbort = (): void => ac.abort();
    lifetime.signal.addEventListener("abort", onLifetimeAbort, { once: true });
    slotHeld = true;

    const rawFiles = readFiles();
    const rawGit = readGit(gitCtx(ac.signal, startedAt));
    const timeoutFiles: FilePart = { changelog: { error: "timeout" } };
    const timeoutGit: GitPart = { repo: { error: "timeout" } };
    const filesP = raceTimeout(rawFiles, L.fileMs, timeoutFiles);
    const gitP = raceTimeout(rawGit, GIT_PHASE_MS, timeoutGit);

    // The slot is released only when the real operations settled (late results are dropped).
    void Promise.allSettled([rawFiles, rawGit]).finally(() => {
      lifetime.signal.removeEventListener("abort", onLifetimeAbort);
      if (generation === gen) {
        slotHeld = false;
        if (round !== undefined && round.resultReady) round = undefined;
      }
    });

    const r: Round = {
      waiters: 0,
      resultReady: false,
      result: raceTimeout(
        Promise.all([filesP, gitP]).then(([f, g]) => ({ f, g })),
        L.requestMs,
        { f: timeoutFiles, g: timeoutGit },
      ).then(({ f, g }) => {
        ac.abort(); // anything still running in git is over budget now
        const data: VersionInfoWire = {
          v: 1,
          checkedAt: opts.now(),
          hub: { pid: opts.info.pid, startedAt: opts.info.startedAt },
        };
        if (g.repo !== undefined) {
          if (!hasError(g.repo) && f.packageVersion !== undefined) {
            (g.repo as VersionRepoWire).packageVersion = f.packageVersion;
          }
          data.repo = g.repo;
        }
        if (f.changelog !== undefined) data.changelog = f.changelog;
        fitBody(data);
        const failed = hasError(data.repo) || hasError(data.changelog);
        cache = { data, expiresAt: opts.now() + (failed ? L.failTtlMs : L.okTtlMs) };
        r.resultReady = true;
        if (!slotHeld && generation === gen) round = undefined;
        return data;
      }),
    };
    return r;
  }

  async function snapshot(signal: AbortSignal): Promise<VersionInfoOutcome> {
    if (disposed || signal.aborted) return { ok: false, code: "E_DEADLINE" };
    if (cache !== undefined && cache.expiresAt > opts.now()) return { ok: true, data: cache.data };
    let r = round;
    if (r !== undefined && r.resultReady) {
      // Result delivered but the IO slot is still held and the cache has expired: do not start a
      // second round on top of IO that has not settled.
      return { ok: false, code: "E_BUSY" };
    }
    if (r === undefined) {
      if (slotHeld) return { ok: false, code: "E_BUSY" };
      r = startRound();
      round = r;
    }
    if (r.waiters >= L.waiters) return { ok: false, code: "E_BUSY" };
    r.waiters++;
    const joined = r;
    return await new Promise<VersionInfoOutcome>((resolve) => {
      let done = false;
      const settle = (o: VersionInfoOutcome): void => {
        if (done) return;
        done = true;
        joined.waiters--;
        signal.removeEventListener("abort", onAbort);
        resolve(o);
      };
      const onAbort = (): void => settle({ ok: false, code: "E_DEADLINE" });
      signal.addEventListener("abort", onAbort, { once: true });
      joined.result.then(
        (data) => settle({ ok: true, data }),
        () => settle({ ok: false, code: "E_DEADLINE" }),
      );
    });
  }

  function captureBootHead(): void {
    if (bootCaptured || disposed) return;
    bootCaptured = true;
    const ctx = gitCtx(lifetime.signal, opts.now());
    void gitHead(ctx)
      .then((h) => {
        if (disposed || h.kind !== "ok") return;
        const head: CommitRef = h.head;
        opts.info.bootHead = head;
        opts.publish?.();
      })
      .catch((err: unknown) => opts.log.warn("web-hub: boot head capture failed", { error: String(err) }));
  }

  return {
    snapshot,
    captureBootHead,
    dispose(): void {
      disposed = true;
      lifetime.abort();
    },
  };
}
