// Live gate evidence (jev-arch §6.4.2, §7.1; Q30; jev-plan §4 J7):
// `running` (named programs only — bashJobs + Linux /proc), `branch`
// (.git/HEAD, worktree-aware), `staged` (git commit only, bounded git
// runner) and the evidence fingerprint feeding the verdict-cache key.
//
// Rules this file pins:
//  · a process counts only when its PROGRAM IDENTITY (argv0 basename, or the
//    script an interpreter runs — shell-parse `programIdentity`) is one of
//    the candidate entries' named programs: `vim scripts/release/release.sh`
//    is `vim`, not `release.sh`;
//  · /proc is Linux-only (non-Linux: bash jobs only; child sessions get no
//    bash jobs — the caller passes none), current uid only, ≤4096 pids, a
//    2s result cache, a 1.5s scan deadline, and the scan NEVER throws (a pid
//    that vanishes mid-walk is skipped);
//  · every collected command line goes through `redactForJev(…, "running")`
//    before it can reach Jev (token masking, 120 code points, ≤10 items);
//  · any probe that fails is simply omitted.
//
// Pi-free root; no direct node:fs (fs-guard — reads go through safe-fs
// primitives); no module-scope mutable state (I4): the /proc cache is an
// instance the wire closure owns (`createProcCache`). I5: the one timer
// (probe deadline) is unref'd.

import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { clampSpanMs } from "../../core/deadline.js";
import type { GitRunner } from "../../git/run.js";
import { listDirNames, readRegularHead } from "../safe-fs.js";
import {
  PROC_CACHE_MS,
  PROC_MAX_PIDS,
  type GateCandidate,
  type GateEvidence,
  type JevBashJobsPort,
  type SimpleCommand,
} from "./contracts.js";
import { redactForJev } from "./redact.js";
import { parseShell, programIdentity } from "./shell-parse.js";

/** Whole-evidence worst case (jev-arch §6.4.2). */
export const EVIDENCE_BUDGET_MS = 1_500;
const RUNNING_MAX = 10;
const STAGED_MAX = 50;
const STAGED_TIMEOUT_MS = 1_000;
const STAGED_MAX_STDOUT = 64 * 1024;
const CMDLINE_MAX_BYTES = 4_096;
const STATUS_MAX_BYTES = 2_048;
const HEAD_MAX_BYTES = 512;
const GIT_WALK_MAX = 32;

// ───────────────────────────── fs port ─────────────────────────────

/** Minimal read-only fs surface (tests inject a fake tree; production reads
 *  through safe-fs). Both methods are total: failure ⇒ []/undefined. */
export interface ProbeFs {
  listDir(path: string): readonly string[];
  readHead(path: string, maxBytes: number): string | undefined;
}

export const SAFE_PROBE_FS: ProbeFs = {
  listDir: (path) => listDirNames(path),
  readHead: (path, maxBytes) => {
    try {
      const slash = path.lastIndexOf("/");
      const dir = slash <= 0 ? "/" : path.slice(0, slash);
      return readRegularHead(dir, path.slice(slash + 1), maxBytes).text;
    } catch {
      return undefined;
    }
  },
};

// ───────────────────────────── /proc scan (Linux, Q30) ─────────────────────────────

export interface ProcProcess {
  readonly pid: number;
  /** shell-parse `programIdentity` of the argv. */
  readonly program: string;
  /** argv joined by spaces (raw — redact before it leaves the machine). */
  readonly command: string;
}

/** 2s /proc result cache — one instance per wire closure (I4). */
export interface ProcCache {
  entry: { at: number; root: string; uid: number; procs: readonly ProcProcess[] } | undefined;
}

export function createProcCache(): ProcCache {
  return { entry: undefined };
}

/** Drop the cached scan (a `bash-job:notification` arrived — a job ended). */
export function clearProcCache(cache: ProcCache): void {
  cache.entry = undefined;
}

export interface ScanProcOptions {
  readonly fs?: ProbeFs;
  readonly now?: () => number;
  /** Scan deadline (ms from start); remaining pids are skipped. */
  readonly deadlineMs?: number;
  readonly maxPids?: number;
}

function realUid(status: string): number | undefined {
  const m = /^Uid:\s+(\d+)/m.exec(status);
  return m === null ? undefined : Number(m[1]);
}

/** Every process of `uid` under `procRoot` whose program identity is in
 *  `wanted`. Linux-only by contract (callers check the platform). Never
 *  throws; vanished pids / unreadable files are skipped. */
export function scanProc(
  procRoot: string,
  uid: number,
  wanted: ReadonlySet<string>,
  cache: ProcCache,
  opts: ScanProcOptions = {},
): readonly ProcProcess[] {
  try {
    if (wanted.size === 0) return [];
    const fs = opts.fs ?? SAFE_PROBE_FS;
    const now = opts.now ?? ((): number => Date.now());
    const t0 = now();
    const hit = cache.entry;
    let procs: readonly ProcProcess[];
    if (hit !== undefined && hit.root === procRoot && hit.uid === uid && t0 - hit.at < PROC_CACHE_MS) {
      procs = hit.procs;
    } else {
      const deadline = t0 + (opts.deadlineMs ?? EVIDENCE_BUDGET_MS);
      const max = opts.maxPids ?? PROC_MAX_PIDS;
      const out: ProcProcess[] = [];
      let seen = 0;
      for (const name of fs.listDir(procRoot)) {
        if (!/^\d+$/.test(name)) continue;
        if (seen >= max || now() > deadline) break;
        seen += 1;
        const pid = Number(name);
        if (pid === process.pid) continue;
        const status = fs.readHead(`${procRoot}/${name}/status`, STATUS_MAX_BYTES);
        if (status === undefined || realUid(status) !== uid) continue; // vanished or other uid
        const raw = fs.readHead(`${procRoot}/${name}/cmdline`, CMDLINE_MAX_BYTES);
        if (raw === undefined || raw === "") continue; // vanished / kernel thread
        const argv = raw.split("\u0000").filter((a) => a !== "");
        if (argv.length === 0) continue;
        out.push({ pid, program: programIdentity(argv), command: argv.join(" ") });
      }
      procs = out;
      cache.entry = { at: t0, root: procRoot, uid, procs };
    }
    return procs.filter((p) => wanted.has(p.program));
  } catch {
    return [];
  }
}

// ───────────────────────────── git HEAD / staged ─────────────────────────────

/** Current branch of the repo containing `cwd` (walks up to the `.git`
 *  entry; a `.git` FILE is a worktree/submodule `gitdir:` pointer).
 *  Detached ⇒ `detached@<sha7>`; not a repo / unreadable ⇒ undefined. */
export function readGitHead(cwd: string, fs: ProbeFs = SAFE_PROBE_FS): string | undefined {
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < GIT_WALK_MAX; i++) {
      const inDir = fs.readHead(join(dir, ".git", "HEAD"), HEAD_MAX_BYTES);
      let head = inDir;
      if (head === undefined) {
        const pointer = fs.readHead(join(dir, ".git"), HEAD_MAX_BYTES);
        const m = pointer === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
        if (m !== null) {
          const gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
          head = fs.readHead(join(gitdir, "HEAD"), HEAD_MAX_BYTES);
          if (head === undefined) return undefined;
        }
      }
      if (head !== undefined) {
        const text = head.trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
        if (ref !== null) return ref[1]!;
        if (/^[0-9a-f]{7,64}$/i.test(text)) return `detached@${text.slice(0, 7)}`;
        return undefined;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) return undefined;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Staged files (`git diff --cached --name-only`) through the bounded git
 *  runner: ≤50 complete lines; non-zero exit / spawn error / timeout ⇒
 *  undefined (omitted). Capped stdout keeps only complete lines. */
export async function stagedFiles(git: GitRunner, cwd: string): Promise<readonly string[] | undefined> {
  try {
    const r = await git(["-C", cwd, "diff", "--cached", "--name-only"], {
      timeoutMs: STAGED_TIMEOUT_MS,
      maxStdoutBytes: STAGED_MAX_STDOUT,
    });
    if (r.code !== 0 || r.spawnError !== undefined || (r.killed !== undefined && r.killed !== "overflow")) {
      return undefined;
    }
    let lines = r.stdout.split("\n");
    if (r.stdoutCapped || r.killed === "overflow") lines = lines.slice(0, -1); // drop the partial tail
    return lines.filter((l) => l !== "").slice(0, STAGED_MAX);
  } catch {
    return undefined;
  }
}

// ───────────────────────────── fingerprint & shape ─────────────────────────────

/** sha1(sorted running program identities + branch + sorted staged) — the
 *  verdict-cache `evidenceFp` (jev-arch §6.4.4). Labels/command lines are
 *  NOT part of it: the same program still running keeps the verdict. */
export function evidenceFingerprint(ev: GateEvidence): string {
  const programs = [...new Set(ev.running.map((r) => r.program))].sort();
  const staged = [...ev.staged].sort();
  return createHash("sha1")
    .update(`${programs.join("\u0001")}\u0000${ev.branch ?? ""}\u0000${staged.join("\u0001")}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

/** Sorted unique "program subcommand" set, e.g. `["git add","git commit"]`
 *  (the verdict-cache `shape`, and the state's `programs`). */
export function commandShape(parsed: readonly SimpleCommand[]): readonly string[] {
  const out = new Set<string>();
  for (const c of parsed) {
    if (c.program === "") continue;
    const sub = c.positionals[0];
    out.add(sub === undefined ? c.program : `${c.program} ${sub}`);
  }
  return [...out].sort();
}

/** `git commit` anywhere in the parsed command list. */
export function isGitCommit(parsed: readonly SimpleCommand[]): boolean {
  return parsed.some((c) => c.program === "git" && c.positionals[0] === "commit");
}

/** Path-like word in a rule body (`src/foo.ts`, `tests/fixtures/`,
 *  `package.json`) — gates the staged probe (jev-arch §6.4.2). */
export function hasPathLikeWord(body: string): boolean {
  return /(?:^|[\s`'"(（「])[\w.@-]+\/[\w./@*-]*|(?:^|[\s`'"(（「])[\w@-]+\.(?:ts|js|mjs|cjs|json|md|ya?ml|toml|lock|sh|py)\b/.test(
    body,
  );
}

// ───────────────────────────── collectEvidence ─────────────────────────────

const TIMEOUT: unique symbol = Symbol("probe-timeout");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  const span = clampSpanMs(ms);
  if (span === undefined) return Promise.resolve(TIMEOUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((res) => {
    timer = setTimeout(() => res(TIMEOUT), span);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, t]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function ageLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export interface CollectEvidenceInput {
  readonly cands: readonly GateCandidate[];
  /** Raw bash command ("" for non-bash tools). */
  readonly command: string;
  /** Pre-parsed command (falls back to parsing `command`). */
  readonly parsed?: readonly SimpleCommand[];
  readonly platform: NodeJS.Platform;
  /** Main session only — child sessions pass none (jev-arch §8). */
  readonly bashJobs?: JevBashJobsPort | undefined;
  readonly isChild: boolean;
  readonly git: GitRunner;
  readonly cwd: string;
  readonly procRoot?: string;
  readonly now: () => number;
  readonly procCache: ProcCache;
  readonly uid?: number;
  readonly fs?: ProbeFs;
}

/** Parallel evidence collection, ≤1.5s worst case; every failed probe is
 *  omitted. Never rejects. */
export async function collectEvidence(input: CollectEvidenceInput): Promise<GateEvidence> {
  const fs = input.fs ?? SAFE_PROBE_FS;
  const wanted = new Set<string>();
  for (const c of input.cands) for (const p of c.entry.namedPrograms) wanted.add(p);
  const parsed = input.parsed ?? parseShell(input.command).commands;

  const running = (): GateEvidence["running"] => {
    const out: { label: string; program: string; command: string }[] = [];
    if (wanted.size === 0) return out;
    const seenCommands = new Set<string>();
    const push = (label: string, program: string, command: string): void => {
      if (out.length >= RUNNING_MAX || seenCommands.has(command)) return;
      seenCommands.add(command);
      out.push({ label: redactForJev(label, "running"), program, command: redactForJev(command, "running") });
    };
    if (!input.isChild && input.bashJobs !== undefined) {
      try {
        for (const job of input.bashJobs.list()) {
          if (job.status !== "running") continue;
          const ids = parseShell(job.command).commands.map((c) => programIdentity(c.argv));
          const program = ids.find((id) => wanted.has(id));
          if (program === undefined) continue;
          push(`${job.id} (${ageLabel(input.now() - job.startedAt)}) ${job.command}`, program, job.command);
        }
      } catch {
        /* omitted */
      }
    }
    if (input.platform === "linux") {
      const uid = input.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
      if (uid !== undefined) {
        for (const p of scanProc(input.procRoot ?? "/proc", uid, wanted, input.procCache, { fs, now: input.now })) {
          push(`pid ${p.pid} ${p.command}`, p.program, p.command);
        }
      }
    }
    return out;
  };

  const staged = async (): Promise<readonly string[] | undefined> => {
    if (!isGitCommit(parsed) || !input.cands.some((c) => hasPathLikeWord(c.entry.body))) return undefined;
    const files = await stagedFiles(input.git, gitCwd(parsed, input.cwd));
    return files?.map((f) => redactForJev(f, "staged"));
  };

  const [runningR, branchR, stagedR] = await Promise.all([
    withTimeout(Promise.resolve().then(running), EVIDENCE_BUDGET_MS).catch((): typeof TIMEOUT => TIMEOUT),
    withTimeout(
      Promise.resolve().then(() => readGitHead(gitCwd(parsed, input.cwd), fs)),
      EVIDENCE_BUDGET_MS,
    ).catch((): typeof TIMEOUT => TIMEOUT),
    withTimeout(staged(), EVIDENCE_BUDGET_MS).catch((): typeof TIMEOUT => TIMEOUT),
  ]);
  return {
    running: runningR === TIMEOUT ? [] : runningR,
    ...(branchR === TIMEOUT || branchR === undefined ? {} : { branch: branchR }),
    staged: stagedR === TIMEOUT || stagedR === undefined ? [] : stagedR,
  };
}

/** `git -C <dir> …` targets another repo — use it (relative to cwd). */
function gitCwd(parsed: readonly SimpleCommand[], cwd: string): string {
  const g = parsed.find((c) => c.program === "git" && c.cwd !== undefined);
  if (g?.cwd === undefined) return cwd;
  return isAbsolute(g.cwd) ? g.cwd : resolve(cwd, g.cwd);
}
