/**
 * worktree-graph plan v2 §2.6/§5 (P2) shared test harness. Reuses the worktree-diff D3 harness
 * (`../worktree-diff/helpers.js`) for the scripted git runner, the in-memory `PreviewFs`, the
 * standard repo fixture and the route-level fakes (io/req/res/registry) — those are NOT
 * reimplemented here, only graph-specific pieces: Gr/Gl stdout builders (the raw `%00`/`\x1f`
 * wire shapes `src/git/graph.ts` parses) and an admission script that pushes exactly the two
 * membership commands (`C1a`/`C1`) graph routes actually consume — NEVER wtdiff's own `C0`
 * (worktree-graph's routes never run a HEAD-resolution command at all, §2.2: "HEAD 取自
 * membership 的 porcelain 自身行").
 */

export {
  AGENT,
  HEAD_SHA1,
  LINKED,
  LINKED_GITDIR,
  REPO,
  REPO_GIT,
  SESSION,
  createFakeFs,
  fakeIo,
  fakeRegistry,
  fakeReq,
  fakeRes,
  memLog,
  okRun,
  query,
  repoFixture,
  scriptedRunner,
  type FakeFs,
  type RepoFixture,
  type Scripted,
  type ScriptedRunner,
} from "../worktree-diff/helpers.js";

import { HEAD_SHA1, okRun, type FakeFs, type RepoFixture } from "../worktree-diff/helpers.js";

/** Push exactly C1a + C1 (the two membership commands `createMembership` runs) — no C0. Mirrors
 * `RepoFixture.scriptAdmission` without its trailing C0 push, since worktree-graph routes never
 * run one. */
export function scriptGraphAdmission(fx: RepoFixture, opts: { commonDir?: string; list?: string } = {}): void {
  fx.runner.push(
    okRun((opts.commonDir ?? "/w/repo/.git") + "\n"), // C1a
    okRun(opts.list ?? fx.porcelain), // C1
  );
}

// ---------------------------------------------------------------------------
// Gr (for-each-ref) wire builders — src/git/graph.ts's `parseForEachRefZ`
// ---------------------------------------------------------------------------

export interface GrRowInput {
  type: "commit" | "tag" | "tree" | "blob" | "";
  oid: string;
  derefType?: "commit" | "tag" | "tree" | "blob" | "";
  derefOid?: string;
  refname: string;
  upstream?: string;
  symref?: string;
}

/** One `for-each-ref --format=%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)
 * %00%(refname)%00%(upstream:short)%00%(symref)` line (NUL-field, newline-record). */
export function grRow(r: GrRowInput): string {
  return [r.type, r.oid, r.derefType ?? "", r.derefOid ?? "", r.refname, r.upstream ?? "", r.symref ?? ""].join("\0");
}

/** Full Gr stdout: one `grRow` per line, trailing newline (git always terminates the last
 * record too — `parseForEachRefZ`'s non-capped path drops exactly one trailing empty split). */
export function grStdout(rows: readonly GrRowInput[]): string {
  return rows.map((r) => grRow(r)).join("\n") + (rows.length > 0 ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Gl (log -z) wire builders — src/git/graph.ts's `parseGraphLogZ`
// ---------------------------------------------------------------------------

export interface GlRecordInput {
  h: string;
  p?: readonly string[];
  an?: string;
  at?: number;
  s?: string;
}

/** One `log -z --format=%H%x1f%P%x1f%an%x1f%at%x1f%s` record (NUL-terminated, `\x1f` fields). */
export function glRecord(r: GlRecordInput): string {
  return [r.h, (r.p ?? []).join(" "), r.an ?? "author", String(r.at ?? 1_000), r.s ?? "subject"].join("\x1f");
}

/** Full Gl stdout: one `glRecord` per NUL-terminated record. */
export function glStdout(records: readonly GlRecordInput[]): string {
  return records.map((r) => `${glRecord(r)}\0`).join("");
}

/** A commit chain of `n` commits, newest (index 0) first, each parenting the next — handy for
 * `more`/windowing/trim tests. hashes are deterministic 40-hex. */
export function commitChain(n: number, startAt = 2_000_000): GlRecordInput[] {
  const hashOf = (i: number): string => i.toString(16).padStart(40, "0");
  const out: GlRecordInput[] = [];
  for (let i = 0; i < n; i++) {
    const parents = i + 1 < n ? [hashOf(i + 1)] : [];
    out.push({ h: hashOf(i), p: parents, an: `author${i}`, at: startAt - i, s: `commit ${i}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// merged-plan P2: the `merged=1` scenario harness (argv-shape routed runner handler)
// ---------------------------------------------------------------------------

import type { GitRunOptions, GitRunResult } from "../../../../src/git/run.js";
import type { ScriptedRunner } from "../worktree-diff/helpers.js";

/** Deterministic 40-hex oid from a small integer (never all-zero; ≥ 1). */
export function oidOf(i: number): string {
  return (0x1000 + i).toString(16).padStart(40, "a");
}

/** Gm stdout: `=<oid>` per patch-equivalent commit, `+<oid>` per other. */
export function cherryOut(eq: readonly string[], plus: readonly string[]): string {
  return [...eq.map((o) => `=${o}`), ...plus.map((o) => `+${o}`)].map((l) => `${l}\n`).join("");
}

export interface MergedScenario {
  /** Gr stdout */
  gr: string;
  /** Gl stdout */
  gl: string;
  /** Cc stdout / exit (default: no driver config, exit 1 = "no match") */
  cc?: { stdout?: string; code?: number } | undefined;
  /** runs when Cc executes (e.g. to advance a fake clock) */
  onCc?: (() => void) | undefined;
  /** Gm response per tip oid (receives the full call so a test can mutate fs/clock mid-run) */
  gm(tip: string, call: { argv: readonly string[]; opts: GitRunOptions }): GitRunResult | Promise<GitRunResult>;
}

export const isGmArgv = (argv: readonly string[]): boolean =>
  argv.includes("rev-list") && argv.includes("--cherry-mark");
export const isCcArgv = (argv: readonly string[]): boolean => argv.includes("config") && argv.includes("--get-regexp");

/** Route every runner call by argv shape (call ORDER stays observable via `runner.calls`). */
export function installMergedHandler(fx: { runner: ScriptedRunner; porcelain: string }, sc: MergedScenario): void {
  fx.runner.setHandler((call) => {
    const j = call.argv.join(" ");
    if (j.includes("--git-common-dir")) return okRun("/w/repo/.git\n");
    if (j.includes("worktree list --porcelain")) return okRun(fx.porcelain);
    if (call.argv.includes("for-each-ref")) return okRun(sc.gr);
    if (call.argv.includes("log") && call.argv.includes("--date-order")) return okRun(sc.gl);
    if (isCcArgv(call.argv)) {
      sc.onCc?.();
      return {
        code: sc.cc?.code ?? 1,
        stdout: sc.cc?.stdout ?? "",
        stdoutCapped: false,
        stderr: "",
      };
    }
    if (isGmArgv(call.argv)) {
      const range = call.argv[call.argv.indexOf("--right-only") + 1] ?? "";
      return sc.gm(range.split("...")[1] ?? "", call);
    }
    return { code: 128, stdout: "", stdoutCapped: false, stderr: `unexpected git call: ${j}` };
  });
}

/**
 * The standard merged window: HEAD (= HEAD_SHA1, parent P1) → P1 → P2; plus `sides` side commits
 * S_i (parent P2) each carrying a local branch `side-<i>`; `refs/heads/feat` (the self row's own
 * branch) sits on HEAD. Returns the Gr/Gl stdouts and the side tips.
 */
export function mergedWindow(sides: number): { gr: string; gl: string; tips: string[]; p1: string; p2: string } {
  const p1 = oidOf(9001);
  const p2 = oidOf(9002);
  const tips = Array.from({ length: sides }, (_, i) => oidOf(i + 1));
  const gl = glStdout([
    { h: HEAD_SHA1, p: [p1], at: 5_000 },
    ...tips.map((h, i) => ({ h, p: [p2], at: 4_000 - i })),
    { h: p1, p: [p2], at: 3_000 },
    { h: p2, p: [], at: 2_000 },
  ]);
  const gr = grStdout([
    { type: "commit", oid: HEAD_SHA1, refname: "refs/heads/feat" },
    ...tips.map((h, i) => ({ type: "commit" as const, oid: h, refname: `refs/heads/side-${i}` })),
  ]);
  return { gr, gl, tips, p1, p2 };
}

/** Count (and hook) the info/attributes opens and `shallow` stats the M phase performs. */
export function hookFs(
  fs: FakeFs,
  hooks: {
    onInfoOpen?: (n: number) => void | Promise<void>;
    onShallowStat?: (n: number) => void | Promise<void>;
  },
): FakeFs {
  let infoOpens = 0;
  let shallowStats = 0;
  const wrapped: FakeFs = { ...fs };
  wrapped.open = async (path, flags) => {
    if (path.endsWith("/info/attributes")) await hooks.onInfoOpen?.(++infoOpens);
    return fs.open(path, flags);
  };
  wrapped.stat = async (path) => {
    if (path.endsWith("/shallow")) await hooks.onShallowStat?.(++shallowStats);
    return fs.stat(path);
  };
  return wrapped;
}
