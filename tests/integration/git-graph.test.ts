/**
 * worktree-graph plan v2 §2.3/§7 P1 — real-git integration tests for `src/git/graph.ts`'s two
 * frozen commands (Gr/Gl). Every test is isolated from the executing user's real git
 * configuration: `HOME`/`GIT_CONFIG_GLOBAL` point at a throwaway temp directory and
 * `GIT_CONFIG_NOSYSTEM=1` is set for every git invocation (setup AND pinned runner calls), so
 * nothing here can read or write `~/.gitconfig`, `/etc/gitconfig`, or any real repository.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, open as fopen, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { WTDIFF_EMPTY_TREE, WTDIFF_GIT_PATH, WT_PINNED_PREFIX, wtDiffArgs } from "../../src/git/diff.js";
import { createGitRunner, type GitRunner } from "../../src/git/run.js";
import { classifyGraphExit, parseForEachRefZ, parseGraphLogZ, tipsFromRefs, wtGraphArgs } from "../../src/git/graph.js";
import { parseWorktreePorcelain } from "../../src/git/worktrees.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitInFixedPath = (() => {
  try {
    execFileSync("git", ["--version"], { env: { PATH: WTDIFF_GIT_PATH }, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (hasGit && !gitInFixedPath) {
  console.warn(`[git-graph] skipping: git is not reachable under the fixed PATH=${WTDIFF_GIT_PATH}`);
}

/** A throwaway HOME so no test can ever read/write the real user's git configuration. */
const TEST_HOME = mkdtempSync(join(tmpdir(), "pi-wg-home-"));
const SAFE_ENV: NodeJS.ProcessEnv = {
  PATH: WTDIFF_GIT_PATH,
  HOME: TEST_HOME,
  GIT_CONFIG_GLOBAL: join(TEST_HOME, "unused-gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** Injects the same HOME/GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM isolation into every pinned spawn. */
const isolatedSpawn: typeof spawn = ((command: string, args: readonly string[], options?: Record<string, unknown>) => {
  const env = {
    ...((options?.["env"] as NodeJS.ProcessEnv | undefined) ?? {}),
    HOME: TEST_HOME,
    GIT_CONFIG_GLOBAL: SAFE_ENV["GIT_CONFIG_GLOBAL"]!,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return spawn(command, args as string[], { ...(options ?? {}), env });
}) as typeof spawn;
const runner: GitRunner = createGitRunner({ spawnImpl: isolatedSpawn });

const tempRoots = new Set<string>();

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: SAFE_ENV });
}

async function repo(prefix: string, opts: { objectFormat?: "sha1" | "sha256" } = {}): Promise<string> {
  const root = await tempDir(prefix);
  const initArgs = ["init", "-q", "-b", "main"];
  if (opts.objectFormat !== undefined) initArgs.push("--object-format", opts.objectFormat);
  git(root, initArgs);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

async function commitFile(root: string, path: string, content: string, message: string): Promise<string> {
  await writeFile(join(root, path), content);
  git(root, ["add", path]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

interface Pins {
  wt: number;
  git: number;
  common: number;
  close(): Promise<void>;
}

function openFileHandle(path: string): ReturnType<typeof fopen> {
  return fopen(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
}

/** Membership-shaped pinning (simplified for the git layer, mirrors git-wtdiff.test.ts). */
async function pinWorktree(W: string): Promise<Pins> {
  const common0 = git(W, wtDiffArgs.commonDir(W).slice(2)).trim();
  const wtFh = await openFileHandle(W);
  const gitFh = await openFileHandle(join(W, ".git"));
  const commonFh = await openFileHandle(common0);
  return {
    wt: wtFh.fd,
    git: gitFh.fd,
    common: commonFh.fd,
    close: async () => {
      await Promise.all([wtFh.close(), gitFh.close(), commonFh.close()]);
    },
  };
}

function runPinned(pins: Pins, argv: readonly string[], opts: { maxStdoutBytes?: number } = {}) {
  return runner(argv, {
    timeoutMs: 8000,
    maxStdoutBytes: opts.maxStdoutBytes ?? 512 * 1024,
    signal: new AbortController().signal,
    envPolicy: "minimal",
    pathOverride: WTDIFF_GIT_PATH,
    pins: { wt: pins.wt, git: pins.git, common: pins.common },
  });
}

/**
 * Raw pinned spawn WITHOUT the runner-level `-c core.fsmonitor=false` — the fsmonitor pair's
 * control group. The fsmonitor hardening lives in `createGitRunner`'s own spawn line
 * (src/git/run.ts: `--no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false
 * …`), NOT in `wtGraphArgs`, so `withoutTokens` cannot strip it from the argv — the control must
 * bypass the runner entirely (same pins, same minimal env, same pinned prefix, minus exactly
 * that one `-c` item). Mirrors git-wtdiff.test.ts's `rawPinnedNoCommon` shape.
 */
function rawPinnedNoFsmonitor(
  pins: Pins,
  argv: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = isolatedSpawn("git", ["--no-optional-locks", "-c", "core.untrackedCache=false", ...argv], {
      cwd: "/",
      env: {
        PATH: WTDIFF_GIT_PATH,
        HOME: TEST_HOME,
        LC_ALL: "C",
        LANG: "C",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_COMMON_DIR: "/proc/self/fd/5",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe", pins.wt, pins.git, pins.common],
    });
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
    child.once("error", () => resolve({ code: null, stdout: "", stderr: "spawn error" }));
  });
}

async function markerScript(dir: string, name: string): Promise<{ script: string; markerFile: string }> {
  const markerFile = join(dir, `${name}-marker.txt`);
  const script = join(dir, `${name}.sh`);
  await writeFile(script, `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(markerFile)}\nexit 1\n`, { mode: 0o755 });
  return { script, markerFile };
}

async function markerCount(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((l) => l === "x").length;
  } catch {
    return 0;
  }
}

/** Recursive, sorted listing of every regular file under `.git/objects` (loose + pack). */
async function listObjects(root: string): Promise<string[]> {
  const base = join(root, ".git", "objects");
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  }
  await walk(base, "");
  return out.sort();
}

async function indexStat(root: string): Promise<string> {
  try {
    const s = await stat(join(root, ".git", "index"));
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "absent";
  }
}

/**
 * Recursive CONTENT snapshot of every loose ref file under `.git/refs` (keyed by relative
 * path → file content). A dir-level `stat()` cannot detect a ref being REWRITTEN in place
 * (same file, same size, nearby mtime granularity) — reading content is the only reliable
 * write-proof for loose refs.
 */
async function listLooseRefs(root: string): Promise<Map<string, string>> {
  const base = join(root, ".git", "refs");
  const out = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out.set(rel, await readFile(join(dir, entry.name), "utf8").catch(() => "<unreadable>"));
    }
  }
  await walk(base, "");
  return out;
}

function looseRefsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** `packed-refs` is a single file — mtime+size is enough to prove it was never rewritten. */
async function packedRefsStat(root: string): Promise<string> {
  try {
    const s = await stat(join(root, ".git", "packed-refs"));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

interface WriteSnapshot {
  objects: string[];
  looseRefs: Map<string, string>;
  packedRefs: string;
  index: string;
}

async function snapshotWrites(root: string): Promise<WriteSnapshot> {
  return {
    objects: await listObjects(root),
    looseRefs: await listLooseRefs(root),
    packedRefs: await packedRefsStat(root),
    index: await indexStat(root),
  };
}

function expectNoWrites(before: WriteSnapshot, after: WriteSnapshot): void {
  expect(after.objects).toEqual(before.objects);
  expect(looseRefsEqual(before.looseRefs, after.looseRefs)).toBe(true);
  expect(after.packedRefs).toBe(before.packedRefs);
  expect(after.index).toBe(before.index);
}

/**
 * Mutation-proofing helper (per-item hint): remove the first contiguous occurrence of each
 * token sequence in `toRemove` from `argv`. Building `control` this way from the REAL
 * `wtGraphArgs.*()` output (never a hand-written argv) means a future accidental removal of a
 * hardening item from `wtGraphArgs` itself collapses `hardened` to look like `control` — the
 * "hardened never triggers the marker" assertion then fails for real.
 */
function withoutTokens(argv: readonly string[], toRemove: readonly string[][]): string[] {
  let result = [...argv];
  for (const seq of toRemove) {
    for (let i = 0; i <= result.length - seq.length; i++) {
      if (seq.every((tok, j) => result[i + j] === tok)) {
        result = [...result.slice(0, i), ...result.slice(i + seq.length)];
        break;
      }
    }
  }
  return result;
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((dir) => rm(dir, { force: true, recursive: true })));
  tempRoots.clear();
});

afterAll(() => {
  rmSync(TEST_HOME, { force: true, recursive: true });
});

/** Run Gr → tipsFromRefs → Gl end-to-end against a real pinned repo and return parsed commits. */
async function fetchGraph(
  pins: Pins,
  extraHeads: string[] = [],
): Promise<{ commits: ReturnType<typeof parseGraphLogZ>["commits"]; format: "sha1" | "sha256" | undefined }> {
  const gr = await runPinned(pins, wtGraphArgs.refs());
  expect(gr.spawnError).toBeUndefined();
  expect(gr.code).toBe(0);
  const rows = parseForEachRefZ(gr.stdout, gr.stdoutCapped);
  const { tips, format } = tipsFromRefs(rows, extraHeads);
  if (tips.length === 0 || format === undefined) return { commits: [], format };
  const gl = await runPinned(pins, wtGraphArgs.log(tips));
  expect(gl.spawnError).toBeUndefined();
  expect(gl.code).toBe(0);
  const { commits } = parseGraphLogZ(gl.stdout, gl.stdoutCapped, format);
  return { commits, format };
}

describe.skipIf(!hasGit || !gitInFixedPath)("git-graph P1 (real git): basic topology", () => {
  it("branches: two independent branch tips both surface via Gr→tips→Gl", async () => {
    const root = await repo("pi-wg-branch-");
    const base = await commitFile(root, "a.txt", "a\n", "base");
    git(root, ["checkout", "-q", "-b", "feature"]);
    const tip = await commitFile(root, "f.txt", "f\n", "feature");
    git(root, ["checkout", "-q", "main"]);
    const pins = await pinWorktree(root);
    try {
      const { commits } = await fetchGraph(pins);
      const hashes = new Set(commits.map((c) => c.h));
      expect(hashes).toEqual(new Set([base, tip]));
    } finally {
      await pins.close();
    }
  });

  it("a 2-parent merge records both parents in order", async () => {
    const root = await repo("pi-wg-merge-");
    await commitFile(root, "a.txt", "a\n", "base");
    git(root, ["checkout", "-q", "-b", "feature"]);
    const featureTip = await commitFile(root, "f.txt", "f\n", "feature");
    git(root, ["checkout", "-q", "main"]);
    const mainTip = await commitFile(root, "m.txt", "m\n", "main2");
    git(root, ["merge", "-q", "--no-edit", "feature"]);
    const mergeOid = git(root, ["rev-parse", "HEAD"]).trim();
    const pins = await pinWorktree(root);
    try {
      const { commits } = await fetchGraph(pins);
      const merge = commits.find((c) => c.h === mergeOid)!;
      expect(merge.p).toEqual([mainTip, featureTip]);
    } finally {
      await pins.close();
    }
  });

  it("consecutive octopus merges: >2 parents each, correctly captured in order", async () => {
    const root = await repo("pi-wg-octopus-");
    await commitFile(root, "base.txt", "base\n", "c0");
    for (const b of ["b1", "b2", "b3"]) {
      git(root, ["checkout", "-q", "-b", b, "main"]);
      await commitFile(root, `${b}.txt`, b, b);
    }
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-edit", "b1", "b2", "b3"]);
    const octo1 = git(root, ["rev-parse", "HEAD"]).trim();
    const octo1Parents = git(root, ["log", "-1", "--format=%P", octo1]).trim().split(" ");
    expect(octo1Parents).toHaveLength(3);

    // A plain commit diverging main from octo1 — without this, merging two branches that are
    // both direct descendants of octo1 would just fast-forward the first one instead of
    // producing a real 3-parent octopus (git 2.53, field-verified).
    const mainDiverge = await commitFile(root, "main2.txt", "main2\n", "main continues");
    for (const b of ["b4", "b5"]) {
      git(root, ["checkout", "-q", "-b", b, octo1]);
      await commitFile(root, `${b}.txt`, b, b);
    }
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-edit", "b4", "b5"]);
    const octo2 = git(root, ["rev-parse", "HEAD"]).trim();
    const octo2Parents = git(root, ["log", "-1", "--format=%P", octo2]).trim().split(" ");
    expect(octo2Parents).toHaveLength(3);

    const pins = await pinWorktree(root);
    try {
      const { commits } = await fetchGraph(pins);
      const m1 = commits.find((c) => c.h === octo1)!;
      const m2 = commits.find((c) => c.h === octo2)!;
      expect(m1.p).toEqual(octo1Parents);
      expect(m1.p).toHaveLength(3);
      expect(m2.p).toEqual(octo2Parents);
      expect(m2.p).toContain(mainDiverge);
      expect(m2.p).not.toContain(octo1); // octo1 reaches m2 only transitively, through mainDiverge
    } finally {
      await pins.close();
    }
  });

  it("annotated, nested, and lightweight tags: nested resolves to the commit; all surface as tips", async () => {
    const root = await repo("pi-wg-tags-");
    const base = await commitFile(root, "a.txt", "a\n", "base");
    git(root, ["tag", "-a", "v1", "-m", "v1", base]);
    git(root, ["-c", "advice.nestedTag=false", "tag", "-a", "v1-nested", "-m", "nested", "v1"]);
    git(root, ["tag", "lightweight", base]);
    const pins = await pinWorktree(root);
    try {
      const gr = await runPinned(pins, wtGraphArgs.refs());
      const rows = parseForEachRefZ(gr.stdout, gr.stdoutCapped);
      const nested = rows.find((r) => r.refname === "refs/tags/v1-nested")!;
      // git's for-each-ref already fully dereferences nested tags to the first non-tag object.
      expect(nested.derefType).toBe("commit");
      expect(nested.derefName).toBe(base);
      const { tips } = tipsFromRefs(rows, []);
      expect(tips).toEqual([base]); // every ref/tag resolves to the SAME single commit, deduped
    } finally {
      await pins.close();
    }
  });

  it("bare origin + clone: refs/remotes/origin/* and origin/HEAD (symref) resolve correctly", async () => {
    const bareOrigin = await tempDir("pi-wg-bare-");
    git(bareOrigin, ["init", "-q", "-b", "main", "--bare", "."]);
    const seed = await repo("pi-wg-seed-");
    const base = await commitFile(seed, "a.txt", "a\n", "base");
    git(seed, ["remote", "add", "origin", bareOrigin]);
    git(seed, ["push", "-q", "origin", "main"]);
    const cloneDir = await tempDir("pi-wg-clone-parent-");
    git(cloneDir, ["clone", "-q", bareOrigin, "clone1"]);
    const clone1 = join(cloneDir, "clone1");
    const pins = await pinWorktree(clone1);
    try {
      const gr = await runPinned(pins, wtGraphArgs.refs());
      const rows = parseForEachRefZ(gr.stdout, gr.stdoutCapped);
      const headRow = rows.find((r) => r.refname === "refs/remotes/origin/HEAD")!;
      expect(headRow.symref).toBe("refs/remotes/origin/main");
      const { tips, format } = tipsFromRefs(rows, []);
      expect(tips).toEqual([base]);
      expect(format).toBe("sha1");
    } finally {
      await pins.close();
    }
  });

  it("linked worktree, detached, with a commit made only there: unreachable via any ref, surfaces only through extraHeads", async () => {
    const main = await repo("pi-wg-wt-main-");
    const base = await commitFile(main, "a.txt", "a\n", "base");
    await commitFile(main, "b.txt", "b\n", "second");
    const wtParent = await tempDir("pi-wg-wt-parent-");
    const detachedPath = join(wtParent, "detached");
    git(main, ["worktree", "add", "-q", "--detach", detachedPath, base]);
    try {
      // A commit made only inside the detached worktree: no branch or tag ever points to it.
      const orphanTip = await commitFile(detachedPath, "only-here.txt", "only-here\n", "orphan work");

      const list = git(main, ["worktree", "list", "--porcelain"]);
      const porcelain = parseWorktreePorcelain(list, false);
      const detachedRow = porcelain.find((w) => w.path === detachedPath)!;
      expect(detachedRow.detached).toBe(true);
      expect(detachedRow.head).toBe(orphanTip);

      const pins = await pinWorktree(main);
      try {
        const withoutHead = await fetchGraph(pins, []);
        expect(withoutHead.commits.map((c) => c.h)).not.toContain(orphanTip);
        const withHead = await fetchGraph(pins, [detachedRow.head!]);
        expect(withHead.commits.map((c) => c.h)).toContain(orphanTip);
        expect(withHead.commits.map((c) => c.h)).toContain(base); // orphanTip's own ancestor
      } finally {
        await pins.close();
      }
    } finally {
      git(main, ["worktree", "remove", "-f", detachedPath]);
    }
  });

  it("shallow clone: the shallow boundary commit parses with an EMPTY parent list (not an error)", async () => {
    const origin = await repo("pi-wg-shallow-origin-");
    const oids: string[] = [];
    for (let i = 0; i < 5; i++) oids.push(await commitFile(origin, "f.txt", `${i}\n`, `c${i}`));
    const cloneParent = await tempDir("pi-wg-shallow-clone-");
    git(cloneParent, ["clone", "-q", "--no-local", "--depth=1", origin, "shallow"]);
    const shallow = join(cloneParent, "shallow");
    const tip = git(shallow, ["rev-parse", "HEAD"]).trim();
    expect(tip).toBe(oids[oids.length - 1]);
    const pins = await pinWorktree(shallow);
    try {
      const { commits } = await fetchGraph(pins);
      expect(commits).toHaveLength(1);
      expect(commits[0]!.h).toBe(tip);
      expect(commits[0]!.p).toEqual([]);
    } finally {
      await pins.close();
    }
  });

  it("sha256 object format: tipsFromRefs picks sha256 and parseGraphLogZ parses 64-char hashes", async () => {
    const root = await repo("pi-wg-sha256-", { objectFormat: "sha256" });
    const base = await commitFile(root, "a.txt", "a\n", "base");
    expect(base).toHaveLength(64);
    const pins = await pinWorktree(root);
    try {
      const { commits, format } = await fetchGraph(pins);
      expect(format).toBe("sha256");
      expect(commits.map((c) => c.h)).toEqual([base]);
    } finally {
      await pins.close();
    }
  });

  it("unborn HEAD (no commits at all): Gr yields zero rows, tipsFromRefs yields zero tips — Gl must never run", async () => {
    const root = await repo("pi-wg-unborn-");
    const pins = await pinWorktree(root);
    try {
      const gr = await runPinned(pins, wtGraphArgs.refs());
      expect(gr.code).toBe(0);
      const rows = parseForEachRefZ(gr.stdout, gr.stdoutCapped);
      expect(rows).toEqual([]);
      const { tips, format } = tipsFromRefs(rows, []);
      expect(tips).toEqual([]);
      expect(format).toBeUndefined();
    } finally {
      await pins.close();
    }
  });

  it("DANGER documented: git log with zero explicit revs silently defaults to HEAD — this is exactly why a caller MUST skip Gl entirely when tips is empty, never call wtGraphArgs.log([])", async () => {
    const root = await repo("pi-wg-empty-tips-danger-");
    const base = await commitFile(root, "a.txt", "a\n", "base");
    const pins = await pinWorktree(root);
    try {
      const res = await runPinned(pins, wtGraphArgs.log([]));
      expect(res.code).toBe(0);
      // the frozen argv with NO explicit tips still returns HEAD's commit — proving the "tips
      // empty ⇒ never run Gl" rule (plan §2.2) is load-bearing, not just a performance shortcut.
      const { commits } = parseGraphLogZ(res.stdout, res.stdoutCapped, "sha1");
      expect(commits.map((c) => c.h)).toEqual([base]);
    } finally {
      await pins.close();
    }
  });

  it("real runner overflow (stdout capped): killed==='overflow', code===null; parseGraphLogZ keeps every complete record and drops only the trailing partial one — never reaches classifyGraphExit (§2.3 结果分类顺序)", async () => {
    const root = await repo("pi-wg-overflow-");
    const oids: string[] = [];
    for (let i = 0; i < 20; i++) {
      oids.push(
        await commitFile(
          root,
          "f.txt",
          `content-${i}-${"x".repeat(80)}\n`,
          `commit number ${i} with a longish subject line`,
        ),
      );
    }
    const pins = await pinWorktree(root);
    try {
      const gr = await runPinned(pins, wtGraphArgs.refs());
      const rows = parseForEachRefZ(gr.stdout, gr.stdoutCapped);
      const { tips, format } = tipsFromRefs(rows, []);
      expect(format).toBe("sha1");
      // A tiny cap guarantees overflow well before the 20-commit log finishes.
      const res = await runPinned(pins, wtGraphArgs.log(tips), { maxStdoutBytes: 200 });
      expect(res.killed).toBe("overflow");
      expect(res.code).toBeNull();
      expect(res.stdoutCapped).toBe(true);
      const result = parseGraphLogZ(res.stdout, res.stdoutCapped, format!);
      expect(result.commits.length).toBeGreaterThan(0);
      expect(result.badRecords).toBe(0); // the cut trailing record is excluded, never counted bad
      // Every kept commit is a COMPLETE, correctly-parsed record (not a half-parsed field).
      for (const c of result.commits) {
        expect(c.h).toMatch(/^[0-9a-f]{40}$/);
        expect(oids).toContain(c.h);
      }
      // §2.3: the hub routes this outcome to `degrade.logCapped` and returns 200 — it never
      // calls classifyGraphExit at all (code is null, not a real exit code). We don't call it
      // here either; this comment documents the contract this test exists to pin.
    } finally {
      await pins.close();
    }
  });
});

describe.skipIf(!hasGit || !gitInFixedPath)(
  "git-graph P1 (real git): §2.3 execution/read-surface matrix — paired tests",
  () => {
    it("gpg (log.showSignature / gpg.program), mutation-proof: repo config forces log.showSignature=true (the dangerous DEFAULT absent any CLI override); control (the REAL wtGraphArgs.log() minus the two hardening tokens) invokes gpg.program (marker=1); hardened (the REAL wtGraphArgs.log()) never does (marker stays 0)", async () => {
      const root = await repo("pi-wg-gpgsig-");
      const commitContent = [
        `tree ${WTDIFF_EMPTY_TREE.sha1}`,
        "author Test <test@example.invalid> 1700000000 +0000",
        "committer Test <test@example.invalid> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " ZmFrZS1zaWduYXR1cmUtbm90LXJlYWw=",
        " -----END PGP SIGNATURE-----",
        "",
        "signed commit",
        "",
      ].join("\n");
      const commitPath = join(root, "commit.txt");
      await writeFile(commitPath, commitContent);
      const commitOid = git(root, ["hash-object", "-t", "commit", "-w", commitPath]).trim();
      git(root, ["update-ref", "refs/heads/main", commitOid]);
      const { script, markerFile } = await markerScript(root, "gpg");
      git(root, ["config", "gpg.program", script]);
      // The load-bearing setup (verifier's fix): make the UNGUARDED default dangerous, so the
      // pair's only variable is the hardening itself, not whether anything asks for signature
      // checking at all. Without this, git's own default (neither flag given) never checks
      // signatures, and stripping the hardening tokens would be a no-op — a mutation that
      // deletes `--no-show-signature` from wtGraphArgs.log() would then NOT be caught.
      git(root, ["config", "log.showSignature", "true"]);

      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([commitOid]);
        const control = withoutTokens(hardened, [["-c", "log.showSignature=false"], ["--no-show-signature"]]);
        expect(control).not.toEqual(hardened); // the helper actually found and removed both tokens

        const controlRes = await runPinned(pins, control);
        expect(controlRes.code).toBe(0);
        expect(await markerCount(markerFile)).toBe(1); // the threat is real

        const hardenedRes = await runPinned(pins, hardened);
        expect(hardenedRes.code).toBe(0);
        expect(await markerCount(markerFile)).toBe(1); // unchanged — the hardened run never ran gpg
        const { commits } = parseGraphLogZ(hardenedRes.stdout, hardenedRes.stdoutCapped, "sha1");
        expect(commits.map((c) => c.h)).toEqual([commitOid]);
      } finally {
        await pins.close();
      }
    });

    it("write-proof: Gr+Gl write ZERO bytes to objects/loose-refs/packed-refs/index, on BOTH a clean success path and a missing-object failure path", async () => {
      // --- success path ---
      const root = await repo("pi-wg-nowrite-ok-");
      await commitFile(root, "a.txt", "a\n", "base");
      git(root, ["tag", "-a", "vok", "-m", "msg", "HEAD"]);
      git(root, ["pack-refs", "--all"]); // create packed-refs so its mtime/size is meaningful
      // Verifier fix (empty-comparison hole): `pack-refs --all` empties `.git/refs`, so the
      // original snapshot compared an EMPTY loose-ref map against an EMPTY loose-ref map — a
      // vacuous pass that could not detect a loose ref being created, deleted, or rewritten
      // in place. Create a real loose ref AFTER packing so the content snapshot is non-empty
      // and any write to `.git/refs` flips the comparison.
      const looseOid = git(root, ["rev-parse", "HEAD"]).trim();
      git(root, ["update-ref", "refs/heads/loose", looseOid]);
      const pins = await pinWorktree(root);
      try {
        const before = await snapshotWrites(root);
        // The comparison is meaningful: at least one loose ref exists with known content.
        expect(before.looseRefs.size).toBeGreaterThan(0);
        expect(before.looseRefs.get("heads/loose")!.trim()).toBe(looseOid);
        const gr = await runPinned(pins, wtGraphArgs.refs());
        expect(gr.code).toBe(0);
        const rows = parseForEachRefZ(gr.stdout, gr.stdoutCapped);
        const { tips, format } = tipsFromRefs(rows, []);
        const gl = await runPinned(pins, wtGraphArgs.log(tips));
        expect(gl.code).toBe(0);
        expect(format).toBe("sha1");
        expectNoWrites(before, await snapshotWrites(root));
      } finally {
        await pins.close();
      }

      // --- missing-object failure path (no promisor — see the dedicated test below for why
      // that distinction matters) — ALSO with a non-empty loose-ref snapshot. The loose ref
      // points at the still-present TIP (pointing it at the deleted ancestor would make Gr
      // itself fail on direct resolution — see the promisor Gr test's fixture note), while Gl
      // fails walking past the deleted parent. ---
      const failRoot = await repo("pi-wg-nowrite-fail-");
      const target = await commitFile(failRoot, "a.txt", "a\n", "base");
      const failTip = await commitFile(failRoot, "b.txt", "b\n", "second");
      git(failRoot, ["pack-refs", "--all"]);
      git(failRoot, ["update-ref", "refs/heads/loose", failTip]); // non-empty loose-ref snapshot
      await rm(join(failRoot, ".git", "objects", target.slice(0, 2), target.slice(2)));
      const failPins = await pinWorktree(failRoot);
      try {
        const before = await snapshotWrites(failRoot);
        expect(before.looseRefs.size).toBeGreaterThan(0);
        expect(before.looseRefs.get("heads/loose")!.trim()).toBe(failTip);
        const gr = await runPinned(failPins, wtGraphArgs.refs());
        expect(gr.code).toBe(0); // the missing object is a commit ancestor, not a ref target — Gr itself succeeds
        const rows = parseForEachRefZ(gr.stdout, gr.stdoutCapped);
        const { tips, format } = tipsFromRefs(rows, []);
        const gl = await runPinned(failPins, wtGraphArgs.log(tips));
        expect(gl.code).not.toBe(0);
        expect(classifyGraphExit(gl.code!, gl.stderr)).toBe("missing-object");
        void format;
        expectNoWrites(before, await snapshotWrites(failRoot));
      } finally {
        await failPins.close();
      }
    });

    it("promisor lazy-fetch via malicious core.sshCommand (Gr): control (real argv minus --no-lazy-fetch) invokes the fake ssh (marker>0) and recovers; hardened (the REAL wtGraphArgs.refs()) never invokes it, exits 128 'bad tag', and writes nothing", async () => {
      const root = await repo("pi-wg-partial-gr-");
      const target = await commitFile(root, "a.txt", "a\n", "base");
      git(root, ["tag", "-a", "vok", "-m", "msg", target]);
      // refs/heads/main must point at a DIFFERENT, still-present commit — otherwise for-each-ref's
      // own direct resolution of refs/heads/main fails first ("missing object ... for
      // refs/heads/main"), masking the tag-dereference failure this test targets ("bad tag").
      await commitFile(root, "b.txt", "b\n", "second");
      git(root, ["pack-refs", "--all"]);
      const scratch = await tempDir("pi-wg-partial-gr-scratch-");
      const { script, markerFile } = await markerScript(scratch, "ssh");
      git(root, ["config", "core.repositoryformatversion", "1"]);
      git(root, ["config", "extensions.partialClone", "origin"]);
      git(root, ["config", "remote.origin.promisor", "true"]);
      git(root, ["config", "remote.origin.url", "ssh://example.invalid/x"]);
      git(root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      git(root, ["config", "core.sshCommand", script]);
      // delete the loose object AFTER both the commit and the tag were created against it (tag
      // creation itself needs to read the target's type, so deletion must come last).
      await rm(join(root, ".git", "objects", target.slice(0, 2), target.slice(2)));

      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.refs();
        const control = withoutTokens(hardened, [["--no-lazy-fetch"]]);
        expect(control).not.toEqual(hardened); // the helper actually found and removed the token

        const controlRes = await runPinned(pins, control);
        expect(await markerCount(markerFile)).toBeGreaterThan(0); // the threat is real

        const before = await snapshotWrites(root);
        const markerBefore = await markerCount(markerFile);

        const hardenedRes = await runPinned(pins, hardened);
        expect(hardenedRes.code).toBe(128);
        expect(classifyGraphExit(hardenedRes.code!, hardenedRes.stderr)).toBe("missing-object");
        expect(await markerCount(markerFile)).toBe(markerBefore); // zero NEW ssh invocations

        expectNoWrites(before, await snapshotWrites(root));
        void controlRes;
      } finally {
        await pins.close();
      }
    });

    it("promisor lazy-fetch via malicious core.sshCommand (Gl, zero explicit tips): control (real wtGraphArgs.log([]) minus --no-lazy-fetch) invokes the fake ssh repeatedly (marker>0, matches a field-observed count of 6) while resolving/walking HEAD; hardened (the REAL wtGraphArgs.log([])) adds zero new invocations", async () => {
      const root = await repo("pi-wg-partial-gl-");
      await commitFile(root, "a.txt", "a\n", "base");
      const headOid = git(root, ["rev-parse", "HEAD"]).trim();
      const scratch = await tempDir("pi-wg-partial-gl-scratch-");
      const { script, markerFile } = await markerScript(scratch, "ssh");
      git(root, ["config", "core.repositoryformatversion", "1"]);
      git(root, ["config", "extensions.partialClone", "origin"]);
      git(root, ["config", "remote.origin.promisor", "true"]);
      git(root, ["config", "remote.origin.url", "ssh://example.invalid/x"]);
      git(root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      git(root, ["config", "core.sshCommand", script]);
      // Delete HEAD's OWN commit object (not just an ancestor): with zero explicit tips, `log`
      // must resolve+open HEAD itself first, which is exactly the step that (field-verified,
      // git 2.53) repeatedly retries the promisor transport before giving up.
      await rm(join(root, ".git", "objects", headOid.slice(0, 2), headOid.slice(2)));

      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([]); // the real "empty tips" shape — never used in
        // production (the hub always skips Gl when tips is empty), but it is exactly the argv
        // whose own --no-lazy-fetch is the ENTIRE defense once a caller bug ever did call it
        // this way, which is precisely why this pair must exist.
        const control = withoutTokens(hardened, [["--no-lazy-fetch"]]);
        expect(control).not.toEqual(hardened);

        const controlRes = await runPinned(pins, control);
        expect(controlRes.code).toBe(128);
        const markerAfterControl = await markerCount(markerFile);
        expect(markerAfterControl).toBeGreaterThan(0); // field-observed: 6

        const hardenedRes = await runPinned(pins, hardened);
        expect(hardenedRes.code).toBe(128);
        expect(await markerCount(markerFile)).toBe(markerAfterControl); // zero NEW ssh invocations
      } finally {
        await pins.close();
      }
    });

    it("promisor lazy-fetch via malicious core.sshCommand (Gl, EXPLICIT tip): the independently-reproduced fixture — the tip's OWN commit object is deleted (NOT an ancestor: field-verified git 2.53, a missing ANCESTOR during the walk fails with 'Could not read' WITHOUT any transport attempt — see the no-promisor test below for the non-promisor form of the same shape); control (real wtGraphArgs.log([tip]) minus --no-lazy-fetch) invokes the fake ssh (marker>0) while resolving the explicit tip; hardened (the REAL wtGraphArgs.log([tip])) exits 128 'bad object', adds zero new invocations, and writes nothing", async () => {
      const root = await repo("pi-wg-partial-gl-tip-");
      await commitFile(root, "a.txt", "a\n", "base");
      const tip = git(root, ["rev-parse", "HEAD"]).trim();
      const scratch = await tempDir("pi-wg-partial-gl-tip-scratch-");
      const { script, markerFile } = await markerScript(scratch, "ssh");
      git(root, ["config", "core.repositoryformatversion", "1"]);
      git(root, ["config", "extensions.partialClone", "origin"]);
      git(root, ["config", "remote.origin.promisor", "true"]);
      git(root, ["config", "remote.origin.url", "ssh://example.invalid/x"]);
      git(root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      git(root, ["config", "core.sshCommand", script]);
      // Delete the TIP's own commit object: `log` with an explicit revision must resolve THAT
      // object first, which is exactly the resolution step that consults the promisor remote
      // before giving up with 'fatal: bad object <oid>' (field-verified, git 2.53).
      await rm(join(root, ".git", "objects", tip.slice(0, 2), tip.slice(2)));

      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([tip]);
        const control = withoutTokens(hardened, [["--no-lazy-fetch"]]);
        expect(control).not.toEqual(hardened);

        const controlRes = await runPinned(pins, control);
        expect(controlRes.code).toBe(128);
        const markerAfterControl = await markerCount(markerFile);
        expect(markerAfterControl).toBeGreaterThan(0); // the threat is real (field-observed: 6)

        const before = await snapshotWrites(root);
        const hardenedRes = await runPinned(pins, hardened);
        expect(hardenedRes.code).toBe(128);
        expect(hardenedRes.stderr).toContain("bad object");
        expect(classifyGraphExit(hardenedRes.code!, hardenedRes.stderr)).toBe("missing-object");
        expect(await markerCount(markerFile)).toBe(markerAfterControl); // zero NEW ssh invocations
        expectNoWrites(before, await snapshotWrites(root));
      } finally {
        await pins.close();
      }
    });

    it("NOT a lazy-fetch proof: a missing parent WITHOUT any promisor remote configured fails closed (exit 128, missing-object) with marker=0 for BOTH control and hardened — this fixture alone proves nothing about --no-lazy-fetch", async () => {
      const root = await repo("pi-wg-missing-no-promisor-");
      const target = await commitFile(root, "a.txt", "a\n", "base");
      await commitFile(root, "b.txt", "b\n", "second");
      const tip = git(root, ["rev-parse", "HEAD"]).trim();
      await rm(join(root, ".git", "objects", target.slice(0, 2), target.slice(2)));
      const scratch = await tempDir("pi-wg-missing-no-promisor-scratch-");
      const { markerFile } = await markerScript(scratch, "unused-ssh"); // never wired to core.sshCommand

      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([tip]);
        const control = withoutTokens(hardened, [["--no-lazy-fetch"]]);
        expect(control).not.toEqual(hardened);

        const controlRes = await runPinned(pins, control);
        const hardenedRes = await runPinned(pins, hardened);
        expect(controlRes.code).toBe(128);
        expect(hardenedRes.code).toBe(128);
        expect(classifyGraphExit(controlRes.code!, controlRes.stderr)).toBe("missing-object");
        expect(classifyGraphExit(hardenedRes.code!, hardenedRes.stderr)).toBe("missing-object");
        expect(await markerCount(markerFile)).toBe(0); // no promisor remote ⇒ nothing was ever invoked
      } finally {
        await pins.close();
      }
    });

    it("replace refs (--no-replace-objects): control (real argv minus the flag) transparently substitutes a `git replace`d commit's subject/parents; hardened (the REAL wtGraphArgs.log()) reads the ORIGINAL object", async () => {
      const root = await repo("pi-wg-replace-");
      await commitFile(root, "a.txt", "a\n", "base");
      const second = await commitFile(root, "b.txt", "b\n", "second");
      const tree = git(root, ["rev-parse", `${second}^{tree}`]).trim();
      const altOid = git(root, ["commit-tree", tree, "-m", "REPLACED SUBJECT"]).trim(); // zero parents
      git(root, ["replace", second, altOid]);

      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([second]);
        const control = withoutTokens(hardened, [["--no-replace-objects"]]);
        expect(control).not.toEqual(hardened);

        const controlRes = await runPinned(pins, control);
        expect(controlRes.code).toBe(0);
        const controlParsed = parseGraphLogZ(controlRes.stdout, controlRes.stdoutCapped, "sha1");
        expect(controlParsed.commits[0]!.s).toBe("REPLACED SUBJECT"); // the threat is real: content substituted
        expect(controlParsed.commits[0]!.p).toEqual([]); // the replacement has no parent

        const hardenedRes = await runPinned(pins, hardened);
        expect(hardenedRes.code).toBe(0);
        const hardenedParsed = parseGraphLogZ(hardenedRes.stdout, hardenedRes.stdoutCapped, "sha1");
        expect(hardenedParsed.commits[0]!.s).toBe("second"); // the ORIGINAL subject
        expect(hardenedParsed.commits[0]!.p).toHaveLength(1); // the ORIGINAL parent chain
      } finally {
        await pins.close();
      }
    });

    it("notes (--no-notes): control (real argv minus the flag, format extended with %N) leaks the configured note text; hardened (same extension, %N left in the REAL argv's --no-notes-protected log) never interpolates %N at all", async () => {
      const root = await repo("pi-wg-notes-");
      const tip = await commitFile(root, "a.txt", "a\n", "base");
      git(root, ["notes", "add", "-m", "SECRET NOTE CONTENT", tip]);

      const pins = await pinWorktree(root);
      try {
        const realArgv = wtGraphArgs.log([tip]);
        const formatIndex = realArgv.findIndex((a) => a.startsWith("--format="));
        expect(formatIndex).toBeGreaterThan(-1);
        const withNotesProbe = [...realArgv];
        withNotesProbe[formatIndex] = "--format=%H%x1f%s%x1f%N"; // append a notes placeholder
        const hardened = withNotesProbe; // still carries the real --no-notes
        const control = withoutTokens(hardened, [["--no-notes"]]);
        expect(control).not.toEqual(hardened);

        const controlRes = await runPinned(pins, control);
        expect(controlRes.code).toBe(0);
        expect(controlRes.stdout).toContain("SECRET NOTE CONTENT"); // the threat is real

        const hardenedRes = await runPinned(pins, hardened);
        expect(hardenedRes.code).toBe(0);
        expect(hardenedRes.stdout).not.toContain("SECRET NOTE CONTENT");
        expect(hardenedRes.stdout).toContain("%N"); // --no-notes leaves the placeholder un-expanded
      } finally {
        await pins.close();
      }
    });

    it("hooks (core.hooksPath=/dev/null): a live marker hook proves the fixture is real (direct exec); neither control (real argv minus the override) nor hardened ever triggers it — log/for-each-ref are read-only and fire no hook regardless, so this hardening is defense-in-depth, not a closure of a reachable path", async () => {
      const root = await repo("pi-wg-hooks-");
      await commitFile(root, "a.txt", "a\n", "base");
      const hooksDir = await tempDir("pi-wg-hooks-dir-");
      const { script, markerFile } = await markerScript(hooksDir, "reference-transaction");
      await writeFile(join(hooksDir, "reference-transaction"), `#!/bin/sh\n${JSON.stringify(script)}\nexit 0\n`, {
        mode: 0o755,
      });
      // Prove the marker mechanism itself is live before trusting its silence.
      execFileSync("sh", ["-c", `${JSON.stringify(script)} || true`]);
      expect(await markerCount(markerFile)).toBe(1);
      await writeFile(markerFile, "");

      git(root, ["config", "core.hooksPath", hooksDir]);
      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.refs();
        const control = withoutTokens(hardened, [["-c", "core.hooksPath=/dev/null"]]);
        expect(control).not.toEqual(hardened);
        await runPinned(pins, control);
        await runPinned(pins, hardened);
        expect(await markerCount(markerFile)).toBe(0);
      } finally {
        await pins.close();
      }
    });

    it("pager (--no-pager + no PAGER env): a live marker pager proves the fixture is real (direct exec); neither control nor hardened invokes it through git — our pinned spawn's stdout is a pipe, never a TTY, so git's own auto-paging never engages regardless (defense-in-depth, not a closure of a reachable path)", async () => {
      const root = await repo("pi-wg-pager-");
      await commitFile(root, "a.txt", "a\n", "base");
      const scratch = await tempDir("pi-wg-pager-scratch-");
      const { script, markerFile } = await markerScript(scratch, "pager");
      execFileSync("sh", ["-c", `printf '' | ${JSON.stringify(script)} || true`]);
      expect(await markerCount(markerFile)).toBe(1);
      await writeFile(markerFile, "");

      git(root, ["config", "core.pager", script]);
      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.refs();
        const control = withoutTokens(hardened, [["--no-pager"]]);
        expect(control).not.toEqual(hardened);
        await runPinned(pins, control);
        await runPinned(pins, hardened);
        expect(await markerCount(markerFile)).toBe(0);
      } finally {
        await pins.close();
      }
    });

    it("pager for Gl (--no-pager, Gl's own copy): a live marker pager proves the fixture is real (direct exec); neither Gl control (real wtGraphArgs.log() minus --no-pager) nor hardened Gl invokes it through git — stdout is a pipe, never a TTY (same defense-in-depth as the Gr case above, now pinned for BOTH frozen commands)", async () => {
      const root = await repo("pi-wg-pager-gl-");
      const tip = await commitFile(root, "a.txt", "a\n", "base");
      const scratch = await tempDir("pi-wg-pager-gl-scratch-");
      const { script, markerFile } = await markerScript(scratch, "pager");
      execFileSync("sh", ["-c", `printf '' | ${JSON.stringify(script)} || true`]);
      expect(await markerCount(markerFile)).toBe(1);
      await writeFile(markerFile, "");

      git(root, ["config", "core.pager", script]);
      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([tip]);
        const control = withoutTokens(hardened, [["--no-pager"]]);
        expect(control).not.toEqual(hardened);
        await runPinned(pins, control);
        await runPinned(pins, hardened);
        expect(await markerCount(markerFile)).toBe(0);
      } finally {
        await pins.close();
      }
    });

    it("hooks for Gl (core.hooksPath=/dev/null, Gl's own copy): a live marker hook proves the fixture is real (direct exec); neither Gl control (real wtGraphArgs.log() minus the override) nor hardened Gl triggers it — log is read-only and fires no hook regardless (same defense-in-depth as the Gr case above, now pinned for BOTH frozen commands)", async () => {
      const root = await repo("pi-wg-hooks-gl-");
      const tip = await commitFile(root, "a.txt", "a\n", "base");
      const hooksDir = await tempDir("pi-wg-hooks-gl-dir-");
      const { script, markerFile } = await markerScript(hooksDir, "post-commit");
      await writeFile(join(hooksDir, "post-commit"), `#!/bin/sh\n${JSON.stringify(script)}\nexit 0\n`, {
        mode: 0o755,
      });
      // Prove the marker mechanism itself is live before trusting its silence.
      execFileSync("sh", ["-c", `${JSON.stringify(script)} || true`]);
      expect(await markerCount(markerFile)).toBe(1);
      await writeFile(markerFile, "");

      git(root, ["config", "core.hooksPath", hooksDir]);
      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([tip]);
        const control = withoutTokens(hardened, [["-c", "core.hooksPath=/dev/null"]]);
        expect(control).not.toEqual(hardened);
        await runPinned(pins, control);
        await runPinned(pins, hardened);
        expect(await markerCount(markerFile)).toBe(0);
      } finally {
        await pins.close();
      }
    });

    it(".mailmap (--no-use-mailmap -c log.mailmap=false, including mailmap.file/mailmap.blob): control (real argv minus both hardening items) reads it (observable via a permission-denied stderr line for the file form, and via a resolvable blob form); hardened never does", async () => {
      const root = await repo("pi-wg-mailmap-");
      const tip = await commitFile(root, "a.txt", "a\n", "base");
      await writeFile(join(root, ".mailmap"), "Mapped Name <test@example.invalid>\n");
      await chmod(join(root, ".mailmap"), 0o000);
      const pins = await pinWorktree(root);
      try {
        const hardened = wtGraphArgs.log([tip]);
        const control = withoutTokens(hardened, [["-c", "log.mailmap=false"], ["--no-use-mailmap"]]);
        expect(control).not.toEqual(hardened);

        const controlRes = await runPinned(pins, control);
        expect(controlRes.stderr).toMatch(/mailmap/i); // the default .mailmap FILE form is read

        const hardenedRes = await runPinned(pins, hardened);
        expect(hardenedRes.code).toBe(0);
        expect(hardenedRes.stderr).not.toMatch(/mailmap/i);
      } finally {
        await chmod(join(root, ".mailmap"), 0o644).catch(() => undefined);
        await pins.close();
      }

      // mailmap.blob form: a committed blob referenced by `mailmap.blob` config, the OTHER
      // mailmap source `--no-use-mailmap`/`log.mailmap=false` must also close.
      const blobRoot = await repo("pi-wg-mailmap-blob-");
      const blobTip = await commitFile(blobRoot, "a.txt", "a\n", "base");
      await writeFile(join(blobRoot, "mailmap-src"), "Mapped Name <test@example.invalid>\n");
      const blobOid = git(blobRoot, ["hash-object", "-w", join(blobRoot, "mailmap-src")]).trim();
      git(blobRoot, ["config", "mailmap.blob", blobOid]);
      const blobPins = await pinWorktree(blobRoot);
      try {
        const hardened = wtGraphArgs.log([blobTip]);
        const control = withoutTokens(hardened, [["-c", "log.mailmap=false"], ["--no-use-mailmap"]]);
        // Observe via %aN (mailmap-applied author name) in a probe format — the production
        // format uses raw %an, so this is a dedicated observation technique, not the real argv.
        const formatIndex = control.findIndex((a) => a.startsWith("--format="));
        const controlProbe = [...control];
        controlProbe[formatIndex] = "--format=%aN";
        const hardenedProbe = [...hardened];
        hardenedProbe[formatIndex] = "--format=%aN";

        const controlRes = await runPinned(blobPins, controlProbe);
        expect(controlRes.code).toBe(0);
        expect(controlRes.stdout).toContain("Mapped Name"); // the blob mailmap IS applied

        const hardenedRes = await runPinned(blobPins, hardenedProbe);
        expect(hardenedRes.code).toBe(0);
        expect(hardenedRes.stdout).not.toContain("Mapped Name"); // --no-use-mailmap suppresses it
      } finally {
        await blobPins.close();
      }

      // mailmap.file form (verifier gap): an EXPLICIT `mailmap.file` config pointing at an
      // unreadable absolute path — a SEPARATE mailmap source from the default `.mailmap`
      // worktree file above. Observable as a permission-denied stderr line in the control
      // (the real argv minus both hardening tokens, nothing added) and absent under hardening.
      const fileRoot = await repo("pi-wg-mailmap-file-");
      const fileTip = await commitFile(fileRoot, "a.txt", "a\n", "base");
      const secretPath = join(fileRoot, "secret-mailmap");
      await writeFile(secretPath, "Mapped Name <test@example.invalid>\n");
      await chmod(secretPath, 0o000);
      git(fileRoot, ["config", "mailmap.file", secretPath]);
      const filePins = await pinWorktree(fileRoot);
      try {
        const hardened = wtGraphArgs.log([fileTip]);
        const control = withoutTokens(hardened, [["-c", "log.mailmap=false"], ["--no-use-mailmap"]]);
        expect(control).not.toEqual(hardened);

        const controlRes = await runPinned(filePins, control);
        expect(controlRes.code).toBe(0);
        expect(controlRes.stderr).toMatch(/mailmap/i); // the configured mailmap.file IS read
        expect(controlRes.stderr).toContain("Permission denied");

        const hardenedRes = await runPinned(filePins, hardened);
        expect(hardenedRes.code).toBe(0);
        expect(hardenedRes.stderr).not.toMatch(/mailmap/i); // neither flag trips, so it is never opened
      } finally {
        await chmod(secretPath, 0o644).catch(() => undefined);
        await filePins.close();
      }
    });

    it("fsmonitor (core.fsmonitor=false prepended by createGitRunner itself, not by the graph argv): INERT SURFACE for Gr/Gl — git 2.53, field-verified, invokes the fsmonitor hook ONLY from worktree-scanning commands (status/diff); for-each-ref never touches the worktree, and log never touches it either (not even `log -p` or `log` with a live .mailmap in the worktree). The runner-level `-c core.fsmonitor=false` (run.ts:155) is therefore defense-in-depth for Gr/Gl, not a closure of a reachable path — pinned here with a live mechanism control so an inert-looking marker can never be mistaken for a broken fixture", async () => {
      const root = await repo("pi-wg-fsmonitor-");
      const tip = await commitFile(root, "a.txt", "a\n", "base");
      await commitFile(root, "b.txt", "b\n", "second");
      const scratch = await tempDir("pi-wg-fsmonitor-scratch-");
      const { script, markerFile } = await markerScript(scratch, "fsmonitor");
      git(root, ["config", "core.fsmonitor", script]);

      // Mechanism control (field-verified): `git status` in the SAME repo DOES invoke the
      // configured fsmonitor (twice per call, git 2.53) — proving the marker wiring is live
      // before trusting its silence under Gr/Gl. Run through plain execFileSync with the
      // same HOME isolation as every other setup call; `status` is a setup-phase command
      // (never one of the two frozen argvs), so it never runs through the pinned runner.
      execFileSync("git", ["status"], { cwd: root, encoding: "utf8", env: SAFE_ENV });
      const mechanismMarker = await markerCount(markerFile);
      expect(mechanismMarker).toBeGreaterThan(0); // the mechanism is REAL — this is not a
      // silent-because-broken fixture

      const pins = await pinWorktree(root);
      try {
        const markerBefore = await markerCount(markerFile);

        // Control: the REAL Gr/Gl argv run through a RAW pinned spawn WITHOUT run.ts's
        // `core.fsmonitor=false` prefix (the hardening lives in the runner, not the argv —
        // `withoutTokens` cannot strip what `wtGraphArgs` never emits). This mirrors
        // git-wtdiff.test.ts's `rawPinnedNoCommon` shape: same pins (fd 3/4/5), same minimal
        // env, minus exactly the runner-level fsmonitor item.
        const rawGr = await rawPinnedNoFsmonitor(pins, wtGraphArgs.refs());
        expect(rawGr.code).toBe(0);
        expect(await markerCount(markerFile)).toBe(markerBefore); // inert: no fsmonitor call

        const rawGl = await rawPinnedNoFsmonitor(pins, wtGraphArgs.log([tip]));
        expect(rawGl.code).toBe(0);
        expect(await markerCount(markerFile)).toBe(markerBefore); // inert: no fsmonitor call

        // Hardened: the REAL runner (its argv prepends `-c core.fsmonitor=false`). Also
        // asserted inert — the pair is (control inert, hardened inert) with the mechanism
        // proven live above, i.e. an honest "this surface is unreachable" pin, not a fake
        // positive control.
        const gr = await runPinned(pins, wtGraphArgs.refs());
        expect(gr.code).toBe(0);
        expect(parseForEachRefZ(gr.stdout, gr.stdoutCapped).length).toBeGreaterThan(0);
        const gl = await runPinned(pins, wtGraphArgs.log([tip]));
        expect(gl.code).toBe(0);
        expect(parseGraphLogZ(gl.stdout, gl.stdoutCapped, "sha1").commits.length).toBeGreaterThan(0);
        expect(await markerCount(markerFile)).toBe(markerBefore);

        // The REAL threat the runner-level flag closes (why the hardening is still worth its
        // bytes even though Gr/Gl cannot reach fsmonitor): a worktree-scanning command
        // through the same runner would invoke the hook when unhardened. One non-frozen
        // argv (status, carrying the same pinned prefix) through the hardened runner proves
        // the flag is actually in the spawn line and actually works: marker stays flat.
        const statusHardened = await runPinned(pins, [
          ...WT_PINNED_PREFIX,
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
        ]);
        expect(statusHardened.code).toBe(0);
        expect(await markerCount(markerFile)).toBe(markerBefore); // the runner flag WORKS
      } finally {
        await pins.close();
      }
    });

    it("--date-order: every parent edge has parent-row index > child-row index across a real branch+merge+octopus history", async () => {
      const root = await repo("pi-wg-dateorder-");
      await commitFile(root, "base.txt", "base\n", "c0");
      for (const b of ["b1", "b2", "b3"]) {
        git(root, ["checkout", "-q", "-b", b, "main"]);
        await commitFile(root, `${b}.txt`, b, b);
      }
      git(root, ["checkout", "-q", "main"]);
      git(root, ["merge", "-q", "--no-edit", "b1", "b2", "b3"]);
      git(root, ["checkout", "-q", "-b", "b4", "main"]);
      await commitFile(root, "b4.txt", "b4", "b4");
      git(root, ["checkout", "-q", "main"]);
      git(root, ["merge", "-q", "--no-edit", "b4"]);

      const pins = await pinWorktree(root);
      try {
        const { commits } = await fetchGraph(pins);
        expect(commits.length).toBeGreaterThanOrEqual(6);
        const indexOf = new Map(commits.map((c, i) => [c.h, i]));
        for (const commit of commits) {
          for (const parent of commit.p) {
            const parentIndex = indexOf.get(parent);
            if (parentIndex === undefined) continue; // outside the fetched set (not expected here)
            expect(parentIndex).toBeGreaterThan(indexOf.get(commit.h)!);
          }
        }
      } finally {
        await pins.close();
      }
    });
  },
);
