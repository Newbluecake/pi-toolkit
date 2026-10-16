/**
 * web-hub-version plan §3.3: the version panel's git reader. Built on `src/git/run.ts`'s bounded
 * runner (hard deadline, process-group kill, stdout cap, unref'd timers) and graph.ts's hardening
 * precedent. Every command carries the SAME frozen prefix (`versionGitArgs`, pinned byte-for-byte
 * by tests):
 *   --no-lazy-fetch --no-replace-objects --no-pager --no-optional-locks
 *   -c core.hooksPath=/dev/null -c core.fsmonitor=false
 * `--no-lazy-fetch` needs git ≥ 2.45; an older git answers exit 129 and that maps to
 * `git-too-old` — the hardening is NEVER dropped to retry. Read-only commands only, minimal env,
 * no author name/email ever collected. Never throws; stderr never leaves this module.
 */
import { realpath } from "node:fs/promises";
import { WTDIFF_GIT_PATH } from "../../git/diff.js";
import { createGitRunner, type GitRunner, type GitRunResult } from "../../git/run.js";
import { VERSION_LIMITS, type CommitRef, type SectionError } from "../protocol/version-info.js";

/** Frozen argv prefix of every version-info git command. */
export const VERSION_GIT_PREFIX: readonly string[] = [
  "--no-lazy-fetch",
  "--no-replace-objects",
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

/** Extra hardening on every `log`. */
const LOG_HARDENING: readonly string[] = [
  "-c",
  "log.showSignature=false",
  "-c",
  "log.mailmap=false",
  "log",
  "--no-show-signature",
  "--no-use-mailmap",
  "--no-notes",
  "--no-decorate",
  "--no-color",
];

/** Frozen argv constructors (tests pin them byte-for-byte). `tag` is always a `v[0-9]*` name
 *  git itself reported (`describe --match v[0-9]*`) — never request input. */
export const versionGitArgs = {
  toplevel: (): string[] => [...VERSION_GIT_PREFIX, "rev-parse", "--show-toplevel"],
  head: (): string[] => [...VERSION_GIT_PREFIX, ...LOG_HARDENING, "-1", "--format=%h%x09%ct"],
  status: (): string[] => [
    ...VERSION_GIT_PREFIX,
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--ignore-submodules=all",
  ],
  describe: (): string[] => [...VERSION_GIT_PREFIX, "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"],
  commits: (range: string): string[] => [
    ...VERSION_GIT_PREFIX,
    ...LOG_HARDENING,
    "-n",
    String(VERSION_LIMITS.commits),
    "--format=%h%x09%ct%x09%s",
    range,
    "--",
  ],
  count: (range: string): string[] => [...VERSION_GIT_PREFIX, "rev-list", "--count", range, "--"],
};

export interface GitCtx {
  readonly pkgRoot: string;
  readonly runner: GitRunner;
  /** Service-level abort (budget expiry / dispose). */
  readonly signal: AbortSignal;
  /** Absolute `now()`-clock deadline of the whole git phase. */
  readonly deadlineAt: number;
  readonly now: () => number;
  readonly realpath?: (p: string) => Promise<string>;
}

export function defaultGitRunner(): GitRunner {
  return createGitRunner();
}

type Step = { ok: true; stdout: string } | { ok: false; error: SectionError | "failed"; code: number | null };

async function step(ctx: GitCtx, args: string[]): Promise<Step> {
  const remaining = ctx.deadlineAt - ctx.now();
  if (remaining <= 0 || ctx.signal.aborted) return { ok: false, error: "timeout", code: null };
  let r: GitRunResult;
  try {
    r = await ctx.runner(args, {
      cwd: ctx.pkgRoot,
      timeoutMs: Math.max(1, Math.min(remaining, VERSION_LIMITS.gitStepMs)),
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 1024,
      signal: ctx.signal,
      envPolicy: "minimal",
      pathOverride: WTDIFF_GIT_PATH,
    });
  } catch {
    return { ok: false, error: "unavailable", code: null };
  }
  if (r.killed === "timeout" || r.killed === "abort") return { ok: false, error: "timeout", code: null };
  if (r.killed === "overflow" || r.stdoutCapped) return { ok: false, error: "unavailable", code: null };
  if (r.spawnError !== undefined) return { ok: false, error: "unavailable", code: null };
  if (r.code === 129) return { ok: false, error: "git-too-old", code: 129 };
  if (r.code !== 0) return { ok: false, error: "failed", code: r.code };
  return { ok: true, stdout: r.stdout };
}

export type GitHeadResult =
  { kind: "absent" } | { kind: "error"; error: SectionError } | { kind: "ok"; head: CommitRef; lastTag?: string };

const HEX_RE = /^[0-9a-f]{7,64}$/;
const TAG_RE = /^v[0-9][0-9A-Za-z._+-]{0,99}$/;

function sectionError(s: Extract<Step, { ok: false }>): SectionError {
  return s.error === "failed" ? "unavailable" : s.error;
}

/** Stages 1 + 2: toplevel gate, then HEAD ∥ dirty ∥ last tag. */
export async function gitHead(ctx: GitCtx): Promise<GitHeadResult> {
  const top = await step(ctx, versionGitArgs.toplevel());
  if (!top.ok) {
    // exit 128 (not a repository / unsafe ownership) ⇒ not "our" repo: omit the whole section.
    if (top.error === "failed") return { kind: "absent" };
    if (top.error === "unavailable" && top.code === null) return { kind: "absent" };
    return { kind: "error", error: top.error as SectionError };
  }
  const rp = ctx.realpath ?? realpath;
  let same = false;
  try {
    same = (await rp(top.stdout.trim())) === (await rp(ctx.pkgRoot));
  } catch {
    same = false;
  }
  if (!same) return { kind: "absent" };

  const [log, status, describe] = await Promise.all([
    step(ctx, versionGitArgs.head()),
    step(ctx, versionGitArgs.status()),
    step(ctx, versionGitArgs.describe()),
  ]);
  if (!log.ok) return { kind: "error", error: sectionError(log) };
  const [hash, ct] = log.stdout.trim().split("\t");
  if (hash === undefined || !HEX_RE.test(hash)) return { kind: "error", error: "unavailable" };
  const time = ct !== undefined && /^\d{1,12}$/.test(ct) ? Number(ct) : undefined;
  const dirty = status.ok && status.stdout.trim() !== "";
  const tag = describe.ok ? describe.stdout.trim() : "";
  return {
    kind: "ok",
    head: { commit: hash, ...(time === undefined ? {} : { time }), ...(dirty ? { dirty: true as const } : {}) },
    ...(TAG_RE.test(tag) ? { lastTag: tag } : {}),
  };
}

export interface GitCommitsResult {
  commits?: { commit: string; time: number; subject: string }[];
  commitsTotal?: number;
  error?: SectionError;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function clipSubject(raw: string): string {
  const clean = raw.replace(CONTROL_RE, " ").trim();
  const chars = Array.from(clean);
  return chars.length > VERSION_LIMITS.subjectChars ? chars.slice(0, VERSION_LIMITS.subjectChars).join("") : clean;
}

/** Stage 3: ≤20 commits since the last tag (or from HEAD when untagged) ∥ their total count. */
export async function gitCommits(ctx: GitCtx, lastTag: string | undefined): Promise<GitCommitsResult> {
  const range = lastTag === undefined ? "HEAD" : `${lastTag}..HEAD`;
  const [log, count] = await Promise.all([
    step(ctx, versionGitArgs.commits(range)),
    step(ctx, versionGitArgs.count(range)),
  ]);
  if (!log.ok) return { error: sectionError(log) };
  const commits: { commit: string; time: number; subject: string }[] = [];
  for (const line of log.stdout.split("\n")) {
    if (line === "") continue;
    const a = line.indexOf("\t");
    const b = a < 0 ? -1 : line.indexOf("\t", a + 1);
    if (a < 0 || b < 0) continue;
    const hash = line.slice(0, a);
    const ct = line.slice(a + 1, b);
    if (!HEX_RE.test(hash) || !/^\d{1,12}$/.test(ct)) continue;
    commits.push({ commit: hash, time: Number(ct), subject: clipSubject(line.slice(b + 1)) });
    if (commits.length >= VERSION_LIMITS.commits) break;
  }
  const total = count.ok && /^\d{1,9}$/.test(count.stdout.trim()) ? Number(count.stdout.trim()) : undefined;
  return { commits, ...(total === undefined ? {} : { commitsTotal: total }) };
}
