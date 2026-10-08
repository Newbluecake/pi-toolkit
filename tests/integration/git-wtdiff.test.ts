import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open as fopen,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  WTDIFF_EMPTY_TREE,
  WTDIFF_GIT_PATH,
  attrSourceArgs,
  combinedStatus,
  driverNamesFromAttributes,
  neutralizeArgs,
  parseCheckAttrZ,
  parseDriverScan,
  parseHeadProbe,
  parseNumstatZ,
  parseStatusV2Z,
  wtDiffArgs,
  type StatusV2Z,
} from "../../src/git/diff.js";
import { createGitRunner } from "../../src/git/run.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Every pinned call runs with envPolicy:"minimal" + pathOverride:WTDIFF_GIT_PATH, so the
 * whole suite requires git inside the fixed PATH (plan §5 D1: "git 不在该 PATH 时整组 skip
 * 并打印原因"). Node resolves the executable through the CHILD env's PATH, which is exactly
 * the property the fixed-constant PATH defends (§2.7).
 */
const gitInFixedPath = (() => {
  const probe = spawnSync("git", ["--version"], { env: { PATH: WTDIFF_GIT_PATH }, encoding: "utf8" });
  return probe.status === 0;
})();

if (hasGit && !gitInFixedPath) {
  // Printed even when skipped so CI logs carry the reason.
  console.warn(`[git-wtdiff] skipping: git is not reachable under the fixed PATH=${WTDIFF_GIT_PATH}`);
}

const tempRoots = new Set<string>();
const runner = createGitRunner();

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...(env !== undefined ? { env } : {}) });
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(dir);
  return dir;
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

async function openDir(path: string): Promise<number> {
  const fh = await fopen(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
  return fh.fd;
}

async function openFileHandle(path: string): Promise<Awaited<ReturnType<typeof fopen>>> {
  return fopen(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
}

/**
 * Membership-shaped pinning (plan §2.3, simplified for the git layer): pin W, its gitdir
 * (via W/.git) and the commondir (via C1a by path, before any tampering). Returns live fds
 * that only the caller closes.
 */
async function pinWorktree(W: string): Promise<Pins> {
  const dotGit = await stat(join(W, ".git"));
  let gitdir: string;
  if (dotGit.isDirectory()) gitdir = join(W, ".git");
  else {
    const text = await readFile(join(W, ".git"), "utf8");
    const match = text.match(/^gitdir: (.+)\n?$/);
    if (match === null) throw new Error(`unexpected .git pointer: ${JSON.stringify(text)}`);
    gitdir = match[1]!;
  }
  const common0 = git(W, wtDiffArgs.commonDir(W).slice(2)).trim();
  const wtFh = await openFileHandle(W);
  const gitFh = await openFileHandle(gitdir);
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

/** Raw pinned spawn WITHOUT GIT_COMMON_DIR — the v2 control group (plan §5 D1). */
function rawPinnedNoCommon(
  pins: Pins,
  argv: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...argv],
      {
        cwd: "/",
        env: {
          PATH: WTDIFF_GIT_PATH,
          HOME: process.env.HOME,
          LC_ALL: "C",
          LANG: "C",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ATTR_NOSYSTEM: "1",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", pins.wt, pins.git, pins.common],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
    child.once("error", () => resolve({ code: null, stdout: "", stderr: "spawn error" }));
  });
}

async function markerDriver(
  prefix: string,
  name: string,
): Promise<{ script: string; markerFile: string; markerDir: string }> {
  const markerDir = await tempDir(prefix);
  const markerFile = join(markerDir, "marker.txt");
  const script = join(markerDir, `${name}.sh`);
  await writeFile(script, `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(markerFile)}\ncat\n`, { mode: 0o755 });
  return { script, markerFile, markerDir };
}

async function markerCount(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((l) => l === "x").length;
  } catch {
    return 0;
  }
}

async function indexStat(gitdir: string): Promise<string> {
  const s = await stat(join(gitdir, "index"));
  return `${s.mtimeMs}:${s.size}:${s.ino}`;
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.clear();
});

describe.skipIf(!hasGit || !gitInFixedPath)("git-wtdiff D1 (real git)", () => {
  it("C0/Cc/C2/C3/C4 flow on a linked worktree under PATH=/usr/bin:/bin: parsers accept real bytes, nested untracked files expand per-file (#5)", async () => {
    const root = await repo("pi-wtd-flow-");
    const mainOid = await commitFile(root, "base.txt", "base\n", "base");
    const linked = `${root}-linked`;
    git(root, ["worktree", "add", "-q", "-b", "linked", linked]);
    await writeFile(join(linked, "mod.txt"), "one\ntwo\nthree\n");
    git(linked, ["add", "mod.txt"]);
    git(linked, ["commit", "-qm", "add mod"]);
    // staged rename first (git add -A would stage anything else)
    await writeFile(join(linked, "oldname.txt"), "rename me\n");
    git(linked, ["add", "oldname.txt"]);
    git(linked, ["commit", "-qm", "old"]);
    await rename(join(linked, "oldname.txt"), join(linked, "newname.txt"));
    git(linked, ["add", "-A"]);
    // then the unstaged modification and untracked files
    await writeFile(join(linked, "mod.txt"), "one\nTWO\nthree\n");
    await mkdir(join(linked, "deep", "nested", "dir"), { recursive: true });
    await writeFile(join(linked, "deep", "nested", "dir", "leaf.txt"), "leaf\n");
    await writeFile(join(linked, "top.txt"), "top\n");
    const pins = await pinWorktree(linked);
    try {
      // C0 — the single HEAD resolution point
      const c0 = await runPinned(pins, wtDiffArgs.head());
      expect(c0.code).toBe(0);
      const head = parseHeadProbe(c0.stdout);
      expect(head?.format).toBe("sha1");
      expect(head?.oid).toMatch(/^[0-9a-f]{40}$/);
      // Cc — no drivers configured
      const cc = await runPinned(pins, wtDiffArgs.driverScan());
      expect(cc.code === 0 || cc.code === 1).toBe(true);
      expect(parseDriverScan(cc.code === 0 ? cc.stdout : "", cc.stdoutCapped)).toEqual({ names: [] });
      // C2 — changeset
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(c2.code).toBe(0);
      const status = parseStatusV2Z(c2.stdout, c2.stdoutCapped);
      expect(status.oid).toBe(head?.oid);
      const byPath = new Map(status.entries.map((e) => [e.path, e]));
      expect(byPath.get("mod.txt")).toMatchObject({ xy: ".M", kind: "1" });
      expect(byPath.get("newname.txt")).toMatchObject({ orig: "oldname.txt", kind: "2" });
      // #5: --untracked-files=all lists every file inside untracked directories individually
      expect(byPath.get("deep/nested/dir/leaf.txt")).toMatchObject({ kind: "?" });
      expect(byPath.get("top.txt")).toMatchObject({ kind: "?" });
      expect([...byPath.keys()].some((p) => p.endsWith("/"))).toBe(false); // no directory records
      expect(combinedStatus(byPath.get("newname.txt")!)).toBe("R");
      expect(combinedStatus(byPath.get("deep/nested/dir/leaf.txt")!)).toBe("?");
      // C3 — numstat incl. the rename triple
      const c3 = await runPinned(pins, wtDiffArgs.numstat(attrSourceArgs("sha1"), neutralizeArgs([]), head!.oid!));
      expect(c3.code).toBe(0);
      const numstat = parseNumstatZ(c3.stdout, c3.stdoutCapped);
      expect(numstat.find((e) => e.path === "mod.txt")).toMatchObject({ add: 1, del: 1 });
      expect(numstat.find((e) => e.path === "newname.txt")).toMatchObject({ orig: "oldname.txt" });
      // C4 — single-file patch
      const c4 = await runPinned(
        pins,
        wtDiffArgs.diff(attrSourceArgs("sha1"), neutralizeArgs([]), head!.oid!, "mod.txt"),
      );
      expect(c4.code).toBe(0);
      expect(c4.stdout).toContain("diff --git a/mod.txt b/mod.txt");
      expect(c4.stdout).toContain("@@ -1,3 +1,3 @@");
      expect(c4.stdout).toContain("-two");
      expect(c4.stdout).toContain("+TWO");
      // C4 rename — both pathspecs, orig first
      const c4r = await runPinned(
        pins,
        wtDiffArgs.diff(attrSourceArgs("sha1"), neutralizeArgs([]), head!.oid!, "newname.txt", "oldname.txt"),
      );
      expect(c4r.code).toBe(0);
      expect(c4r.stdout).toContain("rename from oldname.txt");
      expect(c4r.stdout).toContain("rename to newname.txt");
      // membership constructors work by path (unpinned)
      expect(git(root, wtDiffArgs.commonDir(root).slice(2)).trim()).toBe(join(root, ".git"));
      expect(git(root, wtDiffArgs.worktreeList(root).slice(2))).toContain(linked);
      expect(mainOid).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await pins.close();
    }
  });

  it("H3: pinned commands survive rename+decoy, symlink swap and .git pointer rewrite; by-path controls prove each race is real", async () => {
    const root = await repo("pi-wtd-race-");
    await commitFile(root, "f.txt", "content\n", "base");
    const other = await repo("pi-wtd-other-");
    const otherOid = await commitFile(other, "other.txt", "other\n", "other");
    const W = `${root}-wt`;
    git(root, ["worktree", "add", "-q", "-b", "raced", W]);
    await writeFile(join(W, "dirty.txt"), "dirty\n");
    const pins = await pinWorktree(W);
    const headOf = (s: StatusV2Z) => s.oid;
    try {
      const pinnedHead = async (): Promise<string | undefined> => {
        const r = await runPinned(pins, wtDiffArgs.head());
        expect(r.code).toBe(0);
        return parseHeadProbe(r.stdout)?.oid;
      };
      const pinnedStatus = async (): Promise<StatusV2Z> => {
        const r = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
        expect(r.code).toBe(0);
        return parseStatusV2Z(r.stdout, r.stdoutCapped);
      };
      const baselineHead = await pinnedHead();
      const baseline = await pinnedStatus();
      expect(baseline.entries.some((e) => e.path === "dirty.txt")).toBe(true);

      // — race 1: rename W, put an empty decoy dir at the original path —
      await rename(W, `${W}-moved`);
      await mkdir(W);
      expect(await pinnedHead()).toBe(baselineHead);
      expect(headOf(await pinnedStatus())).toBe(baselineHead);
      expect((await pinnedStatus()).entries.some((e) => e.path === "dirty.txt")).toBe(true);
      // by-path control: the decoy is not a repo — the race is real
      expect(() => git(W, ["rev-parse", "HEAD"])).toThrow();

      // race 3: replace the original path with a symlink to another repo (the pinned dir still
      // lives at W-moved — only the PATH is swapped)
      await rm(W, { recursive: true, force: true }); // remove the decoy dir
      await symlink(other, W);
      expect(await pinnedHead()).toBe(baselineHead);
      expect(headOf(await pinnedStatus())).toBe(baselineHead);
      // by-path control: the swapped path now resolves the OTHER repo
      expect(git(W, ["rev-parse", "HEAD"]).trim()).toBe(otherOid);

      // — race 2: delete the pinned directory entirely — non-zero, no hang —
      await rm(`${W}-moved`, { recursive: true, force: true }); // now the pinned dir is gone
      await rm(W, { force: true }); // remove the symlink
      const W2 = `${root}-wt2`;
      git(root, ["worktree", "add", "--force", "-q", "-b", "raced2", W2]);
      await writeFile(join(W2, "dirty.txt"), "dirty\n");
      const pins2 = await pinWorktree(W2);
      try {
        await rm(W2, { recursive: true, force: true });
        const started = Date.now();
        const r = await runPinned(pins2, wtDiffArgs.head());
        expect(r.code).not.toBe(0);
        expect(r.killed).toBeUndefined(); // not a timeout kill — it failed fast
        expect(Date.now() - started).toBeLessThan(8000);
      } finally {
        await pins2.close();
      }
    } finally {
      await pins.close();
    }
  });

  it("H3: linked worktree .git pointer rewrite does not affect pinned commands", async () => {
    const root = await repo("pi-wtd-dotgit-");
    await commitFile(root, "f.txt", "content\n", "base");
    const other = await repo("pi-wtd-dotgit-other-");
    await commitFile(other, "o.txt", "o\n", "o");
    const otherWt = `${other}-wt`;
    git(other, ["worktree", "add", "-q", "-b", "victim", otherWt]);
    const otherGitdir = git(otherWt, ["rev-parse", "--absolute-git-dir"]).trim();
    const W = `${root}-wt`;
    git(root, ["worktree", "add", "-q", "-b", "pinned", W]);
    await writeFile(join(W, "dirty.txt"), "dirty\n");
    const pins = await pinWorktree(W);
    try {
      const c0a = await runPinned(pins, wtDiffArgs.head());
      const baseline = parseHeadProbe(c0a.stdout)?.oid;
      // rewrite W/.git to point at the OTHER repo's worktree entry
      await writeFile(join(W, ".git"), `gitdir: ${otherGitdir}\n`);
      const c0b = await runPinned(pins, wtDiffArgs.head());
      expect(c0b.code).toBe(0);
      expect(parseHeadProbe(c0b.stdout)?.oid).toBe(baseline); // still the original repo's HEAD
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(parseStatusV2Z(c2.stdout, c2.stdoutCapped).entries.some((e) => e.path === "dirty.txt")).toBe(true);
      // by-path control: the rewritten pointer really leads to the other repo
      expect(git(W, ["rev-parse", "HEAD"]).trim()).toBe(git(otherWt, ["rev-parse", "HEAD"]).trim());
    } finally {
      await pins.close();
    }
  });

  it("H3: commondir rewrite — pinned chain cannot read the other repo's content; the no-env control leaks it (v2 flaw proof)", async () => {
    const root = await repo("pi-wtd-common-");
    await commitFile(root, "a.txt", "A\n", "a");
    const W = `${root}-wt`;
    git(root, ["worktree", "add", "-q", "-b", "shared", W]);
    const other = await repo("pi-wtd-common-other-");
    await commitFile(other, "bsecret.txt", "B-SECRET\n", "b");
    git(other, ["branch", "shared"]); // the other repo CAN resolve the worktree's branch name
    const otherOid = git(other, ["rev-parse", "shared"]).trim();
    const pins = await pinWorktree(W);
    try {
      const c0a = await runPinned(pins, wtDiffArgs.head());
      const baseline = parseHeadProbe(c0a.stdout)?.oid;
      const gitdir = await readFile(join(W, ".git"), "utf8");
      const g0 = gitdir.match(/^gitdir: (.+)\n?$/)?.[1]!;
      // rewrite <gitdir>/commondir to the other repo
      await writeFile(join(g0, "commondir"), `${other}/.git\n`);
      const c0b = await runPinned(pins, wtDiffArgs.head());
      // Pinned reality (git 2.53): the refs backend still follows the commondir FILE, so
      // rev-parse may resolve the other repo's ref — but objects stay pinned, so every
      // content-producing command fails closed and no other-repo content is reachable.
      expect(c0b.code).toBe(0);
      const redirected = parseHeadProbe(c0b.stdout)?.oid;
      expect(redirected).toBe(otherOid); // oid confusion is the residual (same-uid scope, plan §2.3)
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(c2.code).not.toBe(0); // "bad object HEAD" — objects pinned to the real repo
      const c4 = await runPinned(
        pins,
        wtDiffArgs.diff(attrSourceArgs("sha1"), neutralizeArgs([]), redirected!, "bsecret.txt"),
      );
      expect(c4.code).not.toBe(0);
      expect(c4.stdout).not.toContain("B-SECRET");
      // control: identical fds/argv WITHOUT GIT_COMMON_DIR reads the other repo's objects
      const ctrl = await rawPinnedNoCommon(
        pins,
        wtDiffArgs.diff(attrSourceArgs("sha1"), neutralizeArgs([]), otherOid, "bsecret.txt"),
      );
      expect(ctrl.code).toBe(0);
      expect(ctrl.stdout).toContain("B-SECRET"); // the v2 flaw the env pin closes
      expect(baseline).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await pins.close();
    }
  });

  it("I15: after C0, moving HEAD does not change C4's explicit-oid diff; C2 detects the drift", async () => {
    const root = await repo("pi-wtd-head-");
    await commitFile(root, "f.txt", "v1\n", "one");
    await writeFile(join(root, "f.txt"), "v2\n");
    git(root, ["add", "f.txt"]);
    git(root, ["commit", "-qm", "two"]);
    const older = git(root, ["rev-parse", "HEAD~1"]).trim();
    await writeFile(join(root, "f.txt"), "v2-modified\n");
    const pins = await pinWorktree(root);
    try {
      const c0 = await runPinned(pins, wtDiffArgs.head());
      const oid = parseHeadProbe(c0.stdout)?.oid!;
      const l1 = attrSourceArgs("sha1");
      const before = await runPinned(pins, wtDiffArgs.diff(l1, neutralizeArgs([]), oid, "f.txt"));
      expect(before.code).toBe(0);
      // move HEAD back one commit — the symbolic ref now points elsewhere
      git(root, ["update-ref", "refs/heads/main", older]);
      const after = await runPinned(pins, wtDiffArgs.diff(l1, neutralizeArgs([]), oid, "f.txt"));
      expect(after.code).toBe(0);
      expect(after.stdout).toBe(before.stdout); // byte-identical: bound to the explicit C0 oid
      expect(after.stdout).toContain("+v2-modified");
      // sanity: the moved HEAD would give a DIFFERENT diff — the binding matters
      const moved = await runPinned(pins, [
        "-C",
        "/proc/self/fd/3",
        "--git-dir=/proc/self/fd/4",
        "--work-tree=/proc/self/fd/3",
        "--literal-pathspecs",
        "diff-index",
        "-p",
        "-M",
        "--unified=3",
        "--no-color",
        "--no-textconv",
        "--no-ext-diff",
        "HEAD",
        "--",
        "f.txt",
      ]);
      expect(moved.stdout).not.toBe(before.stdout);
      // C2's branch.oid reflects the moved HEAD — the hub-side consistency check sees the drift
      const c2 = await runPinned(pins, wtDiffArgs.status(l1, neutralizeArgs([]), "all"));
      const status = parseStatusV2Z(c2.stdout, c2.stdoutCapped);
      expect(status.oid).toBe(older);
      expect(status.oid).not.toBe(oid);
    } finally {
      await pins.close();
    }
  });

  it("H4: status/diff-index leave the index stat byte-identical and never fire post-index-change", async () => {
    const root = await repo("pi-wtd-h4-");
    await commitFile(root, "f.txt", "same length\n", "base");
    const hook = await markerDriver("pi-wtd-h4-hook-", "post-index-change");
    const hooksDir = join(root, ".git", "hooks");
    await writeFile(
      join(hooksDir, "post-index-change"),
      `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(hook.markerFile)}\n`,
      {
        mode: 0o755,
      },
    );
    // stat-mismatch fixture: same byte length (12) but different content, plus an explicit
    // distinct mtime (rapid successive writes could share mtime with the checkout) — this is
    // the exact precondition under which status re-hashes content (and would run clean filters).
    await writeFile(join(root, "f.txt"), "same LENGTH\n");
    const distinct = new Date(Date.now() - 10_000);
    await utimes(join(root, "f.txt"), distinct, distinct);
    const pins = await pinWorktree(root);
    try {
      const l1 = attrSourceArgs("sha1");
      const n = neutralizeArgs([]);
      const before = await indexStat(join(root, ".git"));
      const c0 = await runPinned(pins, wtDiffArgs.head());
      const oid = parseHeadProbe(c0.stdout)?.oid!;
      await runPinned(pins, wtDiffArgs.status(l1, n, "all"));
      expect(await indexStat(join(root, ".git"))).toBe(before);
      await runPinned(pins, wtDiffArgs.numstat(l1, n, oid));
      expect(await indexStat(join(root, ".git"))).toBe(before);
      await runPinned(pins, wtDiffArgs.diff(l1, n, oid, "f.txt"));
      expect(await indexStat(join(root, ".git"))).toBe(before);
      expect(await markerCount(hook.markerFile)).toBe(0); // hook never fired
    } finally {
      await pins.close();
    }
  });
});

describe.skipIf(!hasGit || !gitInFixedPath)("git-wtdiff D1 driver neutralization (real git, §2.6.3)", () => {
  async function armedRepo(prefix: string): Promise<{ root: string; file: string }> {
    const root = await repo(prefix);
    await commitFile(root, "tracked.txt", "aaa\n", "base");
    return { root, file: join(root, "tracked.txt") };
  }

  /** Same-size rewrite with an explicit distinct mtime — guarantees the stat mismatch that
   *  makes status re-hash content (the precondition every marker-based scenario depends on). */
  async function rehashTouch(file: string, content: string): Promise<void> {
    await writeFile(file, content);
    const distinct = new Date(Date.now() - 10_000);
    await utimes(file, distinct, distinct);
  }

  it("T1: committed .gitattributes + config written after the scan — L1 kills the attribute source (marker 0)", async () => {
    const { root } = await armedRepo("pi-wtd-t1-");
    const drv = await markerDriver("pi-wtd-t1-drv-", "p");
    await writeFile(join(root, ".gitattributes"), "*.txt filter=p\n");
    git(root, ["add", ".gitattributes"]);
    git(root, ["commit", "-qm", "attrs"]);
    await rehashTouch(join(root, "tracked.txt"), "aaa\n");
    const pins = await pinWorktree(root);
    try {
      // Cc at scan time: no config yet → no names (the name only lives in committed .gitattributes)
      const cc = await runPinned(pins, wtDiffArgs.driverScan());
      expect(parseDriverScan(cc.stdout, cc.stdoutCapped)).toEqual({ names: [] });
      // window injection: the config command appears AFTER the scan
      git(root, ["config", "filter.p.clean", drv.script]);
      // control: default attribute sources (no L1) — the committed .gitattributes filter fires
      const control = await runPinned(pins, [
        "-C",
        "/proc/self/fd/3",
        "--git-dir=/proc/self/fd/4",
        "--work-tree=/proc/self/fd/3",
        "status",
        "--porcelain=v2",
        "--branch",
      ]);
      expect(control.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(1); // the threat is real
      // L1 (--attr-source=empty tree): the committed attribute source is gone → no run
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(c2.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(1); // marker count unchanged
    } finally {
      await pins.close();
    }
  });

  it("T2: info/attributes + late config — L2 unconditional neutralization covers the residual source (marker 0)", async () => {
    const { root } = await armedRepo("pi-wtd-t2-");
    const drv = await markerDriver("pi-wtd-t2-drv-", "q");
    await rehashTouch(join(root, "tracked.txt"), "aaa\n");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "attributes"), "*.txt filter=q\n");
    const pins = await pinWorktree(root);
    try {
      // Cc at scan time: no config yet → no names; attributes file carries q (hub-side read)
      const cc = await runPinned(pins, wtDiffArgs.driverScan());
      expect(parseDriverScan(cc.stdout, cc.stdoutCapped)).toEqual({ names: [] });
      const attrs = await readFile(join(root, ".git", "info", "attributes"), "utf8");
      expect(driverNamesFromAttributes(attrs)).toEqual({ names: ["q"] });
      const names = ["q"]; // union of scan ∪ attributes
      // control: L1 only (no L2) — info/attributes survives attr-source → filter runs
      const control = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(control.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(0); // no config yet — nothing to run
      // window injection: config appears AFTER the scan
      git(root, ["config", "filter.q.clean", drv.script]);
      const l2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs(names), "all"));
      expect(l2.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(0); // L2 blanked the late config
      // prove the injection was armed: L1 without L2 now runs the filter
      const armed = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(armed.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(1);
    } finally {
      await pins.close();
    }
  });

  it("T3: macro attribute lines are extracted and neutralized", async () => {
    const { root } = await armedRepo("pi-wtd-t3-");
    const drv = await markerDriver("pi-wtd-t3-drv-", "r");
    await rehashTouch(join(root, "tracked.txt"), "aaa\n");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "attributes"), "[attr]m filter=r\n*.txt m\n");
    git(root, ["config", "filter.r.clean", drv.script]);
    expect(driverNamesFromAttributes("[attr]m filter=r\n*.txt m\n")).toEqual({ names: ["r"] });
    const pins = await pinWorktree(root);
    try {
      const cc = await runPinned(pins, wtDiffArgs.driverScan());
      expect(parseDriverScan(cc.stdout, cc.stdoutCapped)).toEqual({ names: ["r"] });
      const control = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(await markerCount(drv.markerFile)).toBe(1); // macro-referenced filter runs without L2
      const neutralized = await runPinned(
        pins,
        wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs(["r"]), "all"),
      );
      expect(neutralized.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(1); // no further run
    } finally {
      await pins.close();
    }
  });

  it("T4: global core.attributesFile + global config — attributesFile=/dev/null kills it", async () => {
    const { root } = await armedRepo("pi-wtd-t4-");
    const drv = await markerDriver("pi-wtd-t4-drv-", "s");
    const home = await tempDir("pi-wtd-t4-home-");
    await writeFile(join(home, "global-attrs"), "*.txt filter=s\n");
    await writeFile(
      join(home, ".gitconfig"),
      `[core]\n\tattributesFile = ${JSON.stringify(join(home, "global-attrs"))}\n[filter "s"]\n\tclean = ${JSON.stringify(drv.script)}\n`,
    );
    await rehashTouch(join(root, "tracked.txt"), "aaa\n");
    const originalHome = process.env.HOME;
    process.env.HOME = home; // minimal env inherits HOME at spawn time
    const pins = await pinWorktree(root);
    try {
      const cc = await runPinned(pins, wtDiffArgs.driverScan());
      expect(parseDriverScan(cc.stdout, cc.stdoutCapped)).toEqual({ names: ["s"] }); // global config visible via inherited HOME
      // control: default attribute sources (no L1) → global attributes file fires the filter
      const control = await runPinned(pins, [
        "-C",
        "/proc/self/fd/3",
        "--git-dir=/proc/self/fd/4",
        "--work-tree=/proc/self/fd/3",
        "status",
        "--porcelain=v2",
        "--branch",
      ]);
      expect(await markerCount(drv.markerFile)).toBe(1);
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs(["s"]), "all"));
      expect(c2.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(1); // no new run
    } finally {
      await pins.close();
      process.env.HOME = originalHome;
    }
  });

  it("T5: filter.lfs.{clean,smudge,process,required=true} + committed filter=lfs — neutralized; check-attr marks the entry", async () => {
    const { root } = await armedRepo("pi-wtd-t5-");
    const drv = await markerDriver("pi-wtd-t5-drv-", "lfs");
    await writeFile(join(root, ".gitattributes"), "*.txt filter=lfs\n");
    git(root, ["add", ".gitattributes"]);
    git(root, ["commit", "-qm", "attrs"]);
    git(root, ["config", "filter.lfs.clean", drv.script]);
    git(root, ["config", "filter.lfs.smudge", drv.script]);
    git(root, ["config", "filter.lfs.process", drv.script]);
    git(root, ["config", "filter.lfs.required", "true"]);
    await rehashTouch(join(root, "tracked.txt"), "aaa\n");
    const pins = await pinWorktree(root);
    try {
      const cc = await runPinned(pins, wtDiffArgs.driverScan());
      expect(parseDriverScan(cc.stdout, cc.stdoutCapped)).toEqual({ names: ["lfs"] });
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs(["lfs"]), "all"));
      expect(c2.code).toBe(0); // required=true is blanked too — no 128 "clean filter failed"
      expect(await markerCount(drv.markerFile)).toBe(0);
      // Ca marks filter-managed entries via the immutable base tree
      const c0 = await runPinned(pins, wtDiffArgs.head());
      const oid = parseHeadProbe(c0.stdout)?.oid!;
      const ca = await runPinned(pins, wtDiffArgs.checkAttr(oid, ["tracked.txt"])[0]!);
      expect(ca.code).toBe(0);
      expect(parseCheckAttrZ(ca.stdout).get("tracked.txt")).toBe("lfs");
    } finally {
      await pins.close();
    }
  });

  it("T6: textconv / diff.external / GIT_EXTERNAL_DIFF never run under the frozen argv", async () => {
    const { root } = await armedRepo("pi-wtd-t6-");
    const drv = await markerDriver("pi-wtd-t6-drv-", "ext");
    await writeFile(join(root, ".gitattributes"), "*.txt diff=t\n");
    git(root, ["add", ".gitattributes"]);
    git(root, ["commit", "-qm", "attrs"]);
    git(root, ["config", "diff.t.textconv", drv.script]);
    git(root, ["config", "diff.external", drv.script]);
    await rehashTouch(join(root, "tracked.txt"), "zzz\n");
    const pins = await pinWorktree(root);
    try {
      const c0 = await runPinned(pins, wtDiffArgs.head());
      const oid = parseHeadProbe(c0.stdout)?.oid!;
      const cc = await runPinned(pins, wtDiffArgs.driverScan());
      const names = parseDriverScan(cc.stdout, cc.stdoutCapped);
      expect(names).toEqual({ names: ["t"] });
      // control: default attrs + textconv-allowed porcelain diff fires the driver
      git(root, ["diff", "HEAD"], {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_EXTERNAL_DIFF: drv.script,
      });
      expect(await markerCount(drv.markerFile)).toBeGreaterThan(0);
      const c4 = await runPinned(
        pins,
        wtDiffArgs.diff(attrSourceArgs("sha1"), neutralizeArgs(["t"]), oid, "tracked.txt"),
      );
      expect(c4.code).toBe(0);
      const before = await markerCount(drv.markerFile);
      expect(before).toBeGreaterThanOrEqual(1);
      // minimal env does not carry GIT_EXTERNAL_DIFF and the argv disables textconv/ext-diff
      const c4again = await runPinned(
        pins,
        wtDiffArgs.diff(attrSourceArgs("sha1"), neutralizeArgs(["t"]), oid, "tracked.txt"),
      );
      expect(c4again.stdout).toBe(c4.stdout);
      expect(await markerCount(drv.markerFile)).toBe(before); // nothing new ran
    } finally {
      await pins.close();
    }
  });

  it("T7: submodule-internal filters are not invoked (--ignore-submodules=all)", async () => {
    const root = await repo("pi-wtd-t7-");
    await commitFile(root, "top.txt", "top\n", "base");
    const sub = await repo("pi-wtd-t7-sub-");
    const drv = await markerDriver("pi-wtd-t7-drv-", "sub");
    await writeFile(join(sub, "inner.txt"), "inner\n");
    await writeFile(join(sub, ".gitattributes"), "*.txt filter=sub\n");
    git(sub, ["add", "."]);
    git(sub, ["commit", "-qm", "attrs"]);
    // add the submodule FIRST (no filter config in it yet — submodule add itself must not fire)
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
    git(root, ["commit", "-qm", "submodule"]);
    expect(await markerCount(drv.markerFile)).toBe(0);
    // now arm the submodule's own filter and create a stat mismatch inside it
    git(join(root, "sub"), ["config", "filter.sub.clean", drv.script]);
    await writeFile(join(root, "sub", "inner.txt"), "inner\n");
    const pins = await pinWorktree(root);
    try {
      const before = await markerCount(drv.markerFile);
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(c2.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(before); // never entered the submodule
      // control: the submodule's own filter is armed — running status inside it fires
      git(join(root, "sub"), ["status", "--porcelain=v2"]);
      expect(await markerCount(drv.markerFile)).toBeGreaterThan(before);
    } finally {
      await pins.close();
    }
  });

  it("T9: the residual is real (simultaneous info/attributes + config injection runs once) and L3 detection sees the change", async () => {
    const { root } = await armedRepo("pi-wtd-t9-");
    const drv = await markerDriver("pi-wtd-t9-drv-", "z");
    await rehashTouch(join(root, "tracked.txt"), "aaa\n");
    const pins = await pinWorktree(root);
    try {
      const cc0 = await runPinned(pins, wtDiffArgs.driverScan());
      const names0 = parseDriverScan(cc0.stdout, cc0.stdoutCapped);
      expect(names0).toEqual({ names: [] });
      const attrs0 = ""; // ENOENT = empty (plan §2.6.2)
      expect(driverNamesFromAttributes(attrs0)).toEqual({ names: [] });
      // the double-file window: brand-new name in info/attributes AND its config command
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, ".git", "info", "attributes"), "*.txt filter=z\n");
      git(root, ["config", "filter.z.clean", drv.script]);
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha1"), neutralizeArgs([]), "all"));
      expect(c2.code).toBe(0);
      expect(await markerCount(drv.markerFile)).toBe(1); // residual: ran exactly once
      // L3: re-scan detects both halves of the change → hub would 503 attr-changed and drop the result
      const cc1 = await runPinned(pins, wtDiffArgs.driverScan());
      expect(parseDriverScan(cc1.stdout, cc1.stdoutCapped)).toEqual({ names: ["z"] });
      const attrs1 = await readFile(join(root, ".git", "info", "attributes"), "utf8");
      expect(driverNamesFromAttributes(attrs1)).toEqual({ names: ["z"] });
      expect(driverNamesFromAttributes(attrs1)).not.toEqual(driverNamesFromAttributes(attrs0));
    } finally {
      await pins.close();
    }
  });

  it("T10: unsafe names / >16 drivers / capped scan are fail-closed before C2 could ever run", async () => {
    expect(driverNamesFromAttributes("*.txt filter=a=b\n")).toEqual({ unsafe: true });
    const seventeen = Array.from({ length: 17 }, (_, i) => `filter.d${i}.clean\nx`).join("\0") + "\0";
    expect(parseDriverScan(seventeen, false)).toEqual({ unsafe: true });
    expect(parseDriverScan("filter.x.clean\nx\0filter", true)).toEqual({ unsafe: true }); // capped mid-key
    // with an unsafe union the hub never constructs C2; the constructors reflect that by contract
    expect(neutralizeArgs(["a=b"])).toEqual([]);
  });

  it("T12: sha256 repositories use the sha256 empty tree and the full frozen argv", async () => {
    const root = await repo("pi-wtd-256-", { objectFormat: "sha256" });
    await commitFile(root, "f.txt", "content\n", "base");
    await writeFile(join(root, "f.txt"), "changed\n");
    // verify the sha256 empty tree against this git's own hashing
    expect(git(root, ["hash-object", "-t", "tree", "--no-filters", "/dev/null"]).trim()).toBe(WTDIFF_EMPTY_TREE.sha256);
    const pins = await pinWorktree(root);
    try {
      const c0 = await runPinned(pins, wtDiffArgs.head());
      const head = parseHeadProbe(c0.stdout);
      expect(head?.format).toBe("sha256");
      expect(head?.oid).toMatch(/^[0-9a-f]{64}$/);
      const c2 = await runPinned(pins, wtDiffArgs.status(attrSourceArgs("sha256"), neutralizeArgs([]), "all"));
      expect(c2.code).toBe(0);
      const status = parseStatusV2Z(c2.stdout, c2.stdoutCapped);
      expect(status.oid).toBe(head?.oid);
      expect(status.entries.some((e) => e.path === "f.txt")).toBe(true);
      const c4 = await runPinned(
        pins,
        wtDiffArgs.diff(attrSourceArgs("sha256"), neutralizeArgs([]), head!.oid!, "f.txt"),
      );
      expect(c4.stdout).toContain("+changed");
    } finally {
      await pins.close();
    }
  });
});
