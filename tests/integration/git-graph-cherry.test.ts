/**
 * worktree-graph merged-plan §3.3/§3.5/§4.1/§9 (P1) — real-git integration tests for Gm, the frozen
 * `rev-list --cherry-mark --right-only <H>...<B> --` built by `wtGraphArgs.cherry`.
 *
 * Gm READS OBJECT CONTENT (blobs, to compute patch-ids), so this file is the R11 evidence for it:
 * lazy-fetch pair (E1/E2), the 36-cell driver matrix with positive controls (E4), threshold /
 * UI-config pins (E5), attribute consumption (E11), `strace` of work-tree/index access (E12),
 * replace / gpg pairs, write-proof, the §9 judgement fixtures (sha1 + sha256) and a perf smoke.
 *
 * Isolation: every git call (setup AND pinned runner) gets a throwaway HOME / GIT_CONFIG_GLOBAL and
 * GIT_CONFIG_NOSYSTEM=1, so nothing reads or writes the user's real git configuration. Fixtures
 * ALWAYS diverge HEAD from the branch before cherry-picking (an undiverged cherry-pick recreates
 * the identical oid within the same second and the symmetric difference is empty).
 */
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open as fopen, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { WTDIFF_GIT_PATH, driverNamesFromAttributes, parseDriverScan, wtDiffArgs } from "../../src/git/diff.js";
import { classifyGraphExit, parseCherryMark, wtGraphArgs } from "../../src/git/graph.js";
import { createGitRunner, type GitRunner } from "../../src/git/run.js";

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

const hasStrace = (() => {
  try {
    execFileSync("strace", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (hasGit && !gitInFixedPath) {
  console.warn(`[git-graph-cherry] skipping: git is not reachable under the fixed PATH=${WTDIFF_GIT_PATH}`);
}
if (hasGit && !hasStrace) {
  console.warn(
    "[git-graph-cherry] E12 strace tests skipped: `strace` is not installed (chmod 000 fallback still runs)",
  );
}

const TEST_HOME = mkdtempSync(join(tmpdir(), "pi-wgc-home-"));
const SAFE_ENV: NodeJS.ProcessEnv = {
  PATH: WTDIFF_GIT_PATH,
  HOME: TEST_HOME,
  GIT_CONFIG_GLOBAL: join(TEST_HOME, "unused-gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

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
const openPins = new Set<Pins>();

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(dir);
  return dir;
}

function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...SAFE_ENV, ...extraEnv }, stdio: "pipe" });
}

/** Like `git` but never throws — for positive controls whose marker script deliberately exits 1. */
function gitLoose(cwd: string, args: string[]): void {
  try {
    git(cwd, args);
  } catch {
    /* the marker script exits non-zero on purpose */
  }
}

type Format = "sha1" | "sha256";

async function repo(prefix: string, format: Format = "sha1"): Promise<string> {
  const root = await tempDir(prefix);
  git(root, ["init", "-q", "-b", "main", "--object-format", format]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

async function commitFile(root: string, path: string, content: string, message: string): Promise<string> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
  git(root, ["add", path]);
  git(root, ["commit", "-qm", message]);
  return rev(root, "HEAD");
}

function rev(root: string, name: string): string {
  return git(root, ["rev-parse", name]).trim();
}

interface Pins {
  wt: number;
  git: number;
  common: number;
  close(): Promise<void>;
}

function openDir(path: string): ReturnType<typeof fopen> {
  return fopen(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
}

async function pinWorktree(W: string): Promise<Pins> {
  const common0 = git(W, wtDiffArgs.commonDir(W).slice(2)).trim();
  const wtFh = await openDir(W);
  const gitFh = await openDir(join(W, ".git"));
  const commonFh = await openDir(common0);
  const pins: Pins = {
    wt: wtFh.fd,
    git: gitFh.fd,
    common: commonFh.fd,
    close: async () => {
      openPins.delete(pins);
      await Promise.all([wtFh.close(), gitFh.close(), commonFh.close()]);
    },
  };
  openPins.add(pins);
  return pins;
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

afterEach(async () => {
  await Promise.all([...openPins].map((p) => p.close().catch(() => undefined)));
  await Promise.all(
    [...tempRoots].map(async (dir) => {
      await chmod(join(dir, ".gitattributes"), 0o644).catch(() => undefined);
      await chmod(join(dir, ".git", "index"), 0o644).catch(() => undefined);
      await rm(dir, { force: true, recursive: true });
    }),
  );
  tempRoots.clear();
});

afterAll(() => {
  rmSync(TEST_HOME, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Gm drivers
// ---------------------------------------------------------------------------

/** What P2 will do before Gm: Cc scan ∪ info/attributes names (both through the pins). */
async function driverNamesOf(pins: Pins, root: string): Promise<string[]> {
  const cc = await runPinned(pins, wtGraphArgs.driverScan());
  expect(cc.code === 0 || cc.code === 1).toBe(true); // git config --get-regexp: 1 = no match
  const scan = parseDriverScan(cc.stdout, cc.stdoutCapped);
  if ("unsafe" in scan) throw new Error("fixture produced an unsafe driver scan");
  const info = await readFile(join(root, ".git", "info", "attributes"), "utf8").catch(() => "");
  const fromInfo = driverNamesFromAttributes(info);
  if ("unsafe" in fromInfo) throw new Error("fixture produced an unsafe info/attributes driver name");
  return [...new Set([...scan.names, ...fromInfo.names])].sort();
}

/** The REAL hardened argv with every L1/L2/diff.external/threshold item stripped (the "未硬化" control). */
function unhardenedOf(hardened: readonly string[]): string[] {
  const GB_LEN = 9; // WT_PINNED_PREFIX(4) + --no-lazy-fetch + --no-replace-objects + --no-pager + -c core.hooksPath=/dev/null
  const at = hardened.indexOf("rev-list");
  expect(at).toBeGreaterThan(GB_LEN);
  return [...hardened.slice(0, GB_LEN), ...hardened.slice(at)];
}

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

interface Verdict {
  code: number | null;
  stderr: string;
  eq: string[];
  plus: string[];
  bad: boolean;
}

function verdictOf(res: Awaited<ReturnType<typeof runPinned>>, format: Format): Verdict {
  const parsed = parseCherryMark(res.stdout, res.stdoutCapped, format);
  return {
    code: res.code,
    stderr: res.stderr,
    eq: "bad" in parsed ? [] : parsed.eq,
    plus: "bad" in parsed ? [] : parsed.plus,
    bad: "bad" in parsed,
  };
}

/** Hardened Gm over (head, tip) exactly as P2 will run it. */
async function gm(root: string, headRev: string, tipRev: string, format: Format = "sha1"): Promise<Verdict> {
  const pins = await pinWorktree(root);
  try {
    const names = await driverNamesOf(pins, root);
    const argv = wtGraphArgs.cherry(rev(root, headRev), rev(root, tipRev), format, names);
    return verdictOf(await runPinned(pins, argv), format);
  } finally {
    await pins.close();
  }
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

async function listFiles(base: string): Promise<string[]> {
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

/** Content + mtime + size of every file under `.git` except lock-free runtime noise: the write-proof. */
async function snapshotGitDir(root: string): Promise<Map<string, string>> {
  const base = join(root, ".git");
  const map = new Map<string, string>();
  for (const rel of await listFiles(base)) {
    const s = await stat(join(base, rel));
    const body = rel.startsWith("objects/") ? "" : await readFile(join(base, rel), "utf8").catch(() => "<unreadable>");
    map.set(rel, `${s.size}:${s.mtimeMs}:${body}`);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const A_BASE = "one\ntwo three\nfour\n";
const A_TOPIC = "one\ntwo THREE\nfour\n";
const A_WS = "one\ntwo  THREE\nfour\n"; // whitespace-only variant of A_TOPIC (patch-id ignores whitespace)

/** base on main (a.txt, z.txt, c.txt), branch `topic` modifies a.txt, main then diverges via z.txt. */
async function diverged(prefix: string, format: Format = "sha1") {
  const root = await repo(prefix, format);
  await writeFile(join(root, "a.txt"), A_BASE);
  await writeFile(join(root, "z.txt"), "z0\n");
  await writeFile(join(root, "c.txt"), "c0\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const base = rev(root, "HEAD");
  git(root, ["checkout", "-q", "-b", "topic"]);
  const topicTip = await commitFile(root, "a.txt", A_TOPIC, "topic: a");
  git(root, ["checkout", "-q", "main"]);
  await commitFile(root, "z.txt", "z1\n", "main: z");
  return { root, base, topicTip, format };
}

const FORMATS: Format[] = ["sha1", "sha256"];

// ---------------------------------------------------------------------------
// §9 judgement fixtures (sha1 + sha256)
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath).each(FORMATS)("Gm judgement fixtures (%s)", (format) => {
  it("plain cherry-pick ⇒ `=`", async () => {
    const { root, topicTip } = await diverged("pi-wgc-plain-", format);
    git(root, ["cherry-pick", "topic"]);
    const v = await gm(root, "main", "topic", format);
    expect(v).toMatchObject({ code: 0, bad: false, eq: [topicTip], plus: [] });
  });

  it("`cherry-pick -x` ⇒ `=` (the trailer is message-only)", async () => {
    const { root, topicTip } = await diverged("pi-wgc-x-", format);
    git(root, ["cherry-pick", "-x", "topic"]);
    expect(git(root, ["log", "-1", "--format=%B"])).toContain("cherry picked from");
    const v = await gm(root, "main", "topic", format);
    expect(v).toMatchObject({ code: 0, eq: [topicTip], plus: [] });
  });

  it("conflict-resolved cherry-pick ⇒ `+`", async () => {
    const { root, topicTip } = await diverged("pi-wgc-conflict-", format);
    await commitFile(root, "a.txt", "one\ntwo OTHER\nfour\n", "main: conflicting a");
    try {
      git(root, ["cherry-pick", "topic"]);
      throw new Error("expected a conflict");
    } catch (e) {
      expect(String((e as { stderr?: string }).stderr ?? e)).toMatch(/conflict|could not apply/i);
    }
    await writeFile(join(root, "a.txt"), "one\ntwo RESOLVED\nfour\nfive\n");
    git(root, ["add", "a.txt"]);
    git(root, ["-c", "core.editor=true", "cherry-pick", "--continue"]);
    const v = await gm(root, "main", "topic", format);
    expect(v).toMatchObject({ code: 0, eq: [], plus: [topicTip] });
  });

  it("cherry-pick then amend with more content ⇒ `+`", async () => {
    const { root, topicTip } = await diverged("pi-wgc-amend-", format);
    git(root, ["cherry-pick", "topic"]);
    await writeFile(join(root, "a.txt"), "one\ntwo THREE\nfour\nextra\n");
    git(root, ["commit", "-qa", "--amend", "--no-edit"]);
    const v = await gm(root, "main", "topic", format);
    expect(v).toMatchObject({ code: 0, eq: [], plus: [topicTip] });
  });

  it("whitespace-only difference ⇒ `=` (patch-id ignores whitespace — pinned known behaviour)", async () => {
    const { root, topicTip } = await diverged("pi-wgc-ws-", format);
    await commitFile(root, "a.txt", A_WS, "main: whitespace variant");
    expect(rev(root, "main:a.txt")).not.toBe(rev(root, "topic:a.txt")); // blobs genuinely differ
    const v = await gm(root, "main", "topic", format);
    expect(v).toMatchObject({ code: 0, eq: [topicTip], plus: [] });
  });

  it("info/attributes `-diff` flips the same whitespace fixture to `+` even under L1 (E11); control without it is `=`", async () => {
    const { root, topicTip } = await diverged("pi-wgc-e11-", format);
    await commitFile(root, "a.txt", A_WS, "main: whitespace variant");
    expect(await gm(root, "main", "topic", format)).toMatchObject({ eq: [topicTip], plus: [] });
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "attributes"), "*.txt -diff\n");
    const v = await gm(root, "main", "topic", format);
    expect(v).toMatchObject({ code: 0, eq: [], plus: [topicTip] });
  });

  it("two-commit branch squashed by `rebase -i` onto main ⇒ BOTH original commits are `+`", async () => {
    const root = await repo("pi-wgc-squash-", format);
    await writeFile(join(root, "a.txt"), A_BASE);
    await writeFile(join(root, "c.txt"), "c0\n");
    await writeFile(join(root, "z.txt"), "z0\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    git(root, ["checkout", "-q", "-b", "topic"]);
    const t1 = await commitFile(root, "a.txt", A_TOPIC, "t1");
    const t2 = await commitFile(root, "c.txt", "c1\n", "t2");
    git(root, ["checkout", "-q", "-b", "topic-sq", "topic"]);
    git(root, ["rebase", "-i", "main"], {
      GIT_SEQUENCE_EDITOR: "sed -i '2s/^pick/squash/'",
      GIT_EDITOR: "true",
    });
    expect(git(root, ["rev-list", "--count", "main..topic-sq"]).trim()).toBe("1");
    git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "z.txt", "z1\n", "main: z");
    git(root, ["cherry-pick", "topic-sq"]);
    const v = await gm(root, "main", "topic", format);
    expect(v.code).toBe(0);
    expect(v.eq).toEqual([]);
    expect([...v.plus].sort()).toEqual([t1, t2].sort());
  });

  it("`merge --squash` of a two-commit branch ⇒ both `+`", async () => {
    const root = await repo("pi-wgc-msquash-", format);
    await writeFile(join(root, "a.txt"), A_BASE);
    await writeFile(join(root, "c.txt"), "c0\n");
    await writeFile(join(root, "z.txt"), "z0\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    git(root, ["checkout", "-q", "-b", "topic"]);
    const t1 = await commitFile(root, "a.txt", A_TOPIC, "t1");
    const t2 = await commitFile(root, "c.txt", "c1\n", "t2");
    git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "z.txt", "z1\n", "main: z");
    git(root, ["merge", "--squash", "topic"]);
    git(root, ["commit", "-qm", "squashed"]);
    const v = await gm(root, "main", "topic", format);
    expect(v.code).toBe(0);
    expect(v.eq).toEqual([]);
    expect([...v.plus].sort()).toEqual([t1, t2].sort());
  });

  it("merging HEAD's branch INTO the candidate afterwards ⇒ the original commit and the merge are both `+` (E6 phenomenon)", async () => {
    const { root, topicTip } = await diverged("pi-wgc-mergeback-", format);
    git(root, ["cherry-pick", "topic"]);
    git(root, ["checkout", "-q", "topic"]);
    git(root, ["merge", "-q", "--no-edit", "main"]);
    const mergeOid = rev(root, "HEAD");
    git(root, ["checkout", "-q", "main"]);
    const v = await gm(root, "main", "topic", format);
    expect(v.code).toBe(0);
    expect(v.eq).toEqual([]);
    expect([...v.plus].sort()).toEqual([mergeOid, topicTip].sort());
  });

  it("a merge commit INSIDE the branch counts `+` while its picked parents are `=`", async () => {
    const root = await repo("pi-wgc-innermerge-", format);
    await writeFile(join(root, "a.txt"), A_BASE);
    await writeFile(join(root, "c.txt"), "c0\n");
    await writeFile(join(root, "z.txt"), "z0\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    git(root, ["checkout", "-q", "-b", "side"]);
    const s1 = await commitFile(root, "c.txt", "c1\n", "side");
    git(root, ["checkout", "-q", "-b", "topic", "main"]);
    const t1 = await commitFile(root, "a.txt", A_TOPIC, "topic");
    git(root, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
    const mergeOid = rev(root, "HEAD");
    git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "z.txt", "z1\n", "main: z");
    git(root, ["cherry-pick", t1, s1]);
    const v = await gm(root, "main", "topic", format);
    expect(v.code).toBe(0);
    expect([...v.eq].sort()).toEqual([s1, t1].sort());
    expect(v.plus).toEqual([mergeOid]);
  });

  it("completely unmerged branch ⇒ `+`; fully merged-by-ancestry branch ⇒ empty output (t = 0)", async () => {
    const { root, topicTip } = await diverged("pi-wgc-unmerged-", format);
    expect(await gm(root, "main", "topic", format)).toMatchObject({ code: 0, eq: [], plus: [topicTip] });
    git(root, ["merge", "-q", "--no-edit", "topic"]); // now an ancestor of main
    const v = await gm(root, "main", "topic", format);
    expect(v).toMatchObject({ code: 0, bad: false, eq: [], plus: [] });
  });
});

// ---------------------------------------------------------------------------
// E1 / E2 — promisor lazy fetch (paired) and the file-header path
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath)("Gm lazy-fetch pair (E1/E2/E3)", () => {
  async function partial(prefix: string, picked: "ws" | "disjoint") {
    const { root, topicTip } = await diverged(prefix);
    // "ws": HEAD side edits the SAME file (different blob) ⇒ file-set collision ⇒ the full path reads blobs.
    // "disjoint": HEAD side never touches a.txt ⇒ headers differ ⇒ no blob is read at all.
    if (picked === "ws") await commitFile(root, "a.txt", A_WS, "main: ws variant");
    const scratch = await tempDir("pi-wgc-ssh-");
    const { script, markerFile } = await markerScript(scratch, "ssh");
    git(root, ["config", "core.repositoryformatversion", "1"]);
    git(root, ["config", "extensions.partialClone", "origin"]);
    git(root, ["config", "remote.origin.promisor", "true"]);
    git(root, ["config", "remote.origin.url", "ssh://example.invalid/x"]);
    git(root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(root, ["config", "core.sshCommand", script]);
    const blob = rev(root, "topic:a.txt");
    await rm(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    return { root, topicTip, markerFile };
  }

  it("E1/E2: control (real argv minus --no-lazy-fetch) fires the fake ssh (marker>0); hardened never does, exits 128 `missing-object`, writes nothing", async () => {
    const { root, topicTip, markerFile } = await partial("pi-wgc-e1-", "ws");
    const pins = await pinWorktree(root);
    try {
      const hardened = wtGraphArgs.cherry(rev(root, "main"), topicTip, "sha1", []);
      const control = withoutTokens(hardened, [["--no-lazy-fetch"]]);
      expect(control).not.toEqual(hardened);

      await runPinned(pins, control);
      const fired = await markerCount(markerFile);
      expect(fired).toBeGreaterThan(0); // the threat is real (E1 observed 2)

      const before = await snapshotGitDir(root);
      const res = await runPinned(pins, hardened);
      expect(res.code).toBe(128);
      expect(classifyGraphExit(res.code!, res.stderr)).toBe("missing-object");
      expect(await markerCount(markerFile)).toBe(fired); // zero NEW invocations
      const after = await snapshotGitDir(root);
      expect([...after.keys()]).toEqual([...before.keys()]); // no object/ref/config file created or removed
      for (const [k, v] of before) if (!k.startsWith("objects/")) expect(after.get(k)).toBe(v);
    } finally {
      await pins.close();
    }
  });

  it("E3: with disjoint file sets the blob is never read — unhardened and hardened both exit 0 `+` with marker=0", async () => {
    const { root, topicTip, markerFile } = await partial("pi-wgc-e3-", "disjoint");
    const pins = await pinWorktree(root);
    try {
      const hardened = wtGraphArgs.cherry(rev(root, "main"), topicTip, "sha1", []);
      const control = withoutTokens(hardened, [["--no-lazy-fetch"]]);
      const c = verdictOf(await runPinned(pins, control), "sha1");
      const h = verdictOf(await runPinned(pins, hardened), "sha1");
      expect(await markerCount(markerFile)).toBe(0);
      expect(c).toMatchObject({ code: 0, plus: [topicTip] });
      expect(h).toMatchObject({ code: 0, plus: [topicTip] });
    } finally {
      await pins.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E4 — the 36-cell driver matrix with positive controls
// ---------------------------------------------------------------------------

const KINDS = ["clean", "smudge", "process", "textconv", "command", "external"] as const;
const SOURCES = ["worktree", "info", "global"] as const;
type Kind = (typeof KINDS)[number];
type Source = (typeof SOURCES)[number];

const cellsRun = { n: 0 };

describe.skipIf(!hasGit || !gitInFixedPath)(
  "Gm driver matrix (E4): 6 kinds × 3 attribute sources × 2 paths = 36 cells",
  () => {
    async function matrixRepo(source: Source) {
      const root = await repo(`pi-wgc-m-${source}-`);
      const ATTRS = "*.txt filter=f diff=f\n";
      await writeFile(join(root, "a.txt"), A_BASE);
      await writeFile(join(root, "b.txt"), A_BASE);
      await writeFile(join(root, "z.txt"), "z0\n");
      if (source === "worktree") await writeFile(join(root, ".gitattributes"), ATTRS); // committed ⇒ tree + work tree
      git(root, ["add", "."]);
      git(root, ["commit", "-qm", "base"]);
      git(root, ["checkout", "-q", "-b", "hdr"]);
      const hdrTip = await commitFile(root, "a.txt", A_TOPIC, "hdr: a");
      git(root, ["checkout", "-q", "-b", "full", "main"]);
      const fullTip = await commitFile(root, "b.txt", A_TOPIC, "full: b");
      git(root, ["checkout", "-q", "main"]);
      await commitFile(root, "z.txt", "z1\n", "main: z");
      git(root, ["cherry-pick", "full"]); // HEAD side picks `full` only
      if (source === "info") {
        await mkdir(join(root, ".git", "info"), { recursive: true });
        await writeFile(join(root, ".git", "info", "attributes"), ATTRS);
      } else if (source === "global") {
        const f = join(await tempDir("pi-wgc-gattr-"), "attributes");
        await writeFile(f, ATTRS);
        git(root, ["config", "core.attributesFile", f]);
      }
      return { root, hdrTip, fullTip };
    }

    function configureDriver(root: string, kind: Kind, script: string): void {
      const key: Record<Kind, string> = {
        clean: "filter.f.clean",
        smudge: "filter.f.smudge",
        process: "filter.f.process",
        textconv: "diff.f.textconv",
        command: "diff.f.command",
        external: "diff.external",
      };
      git(root, ["config", key[kind], script]);
    }

    /** The positive control: a command that DOES consume this driver. */
    function controlCommand(kind: Kind): string[] {
      switch (kind) {
        case "clean":
          return ["hash-object", "--path=a.txt", "a.txt"];
        case "smudge":
        case "process":
          return ["cat-file", "--filters", "main:a.txt"];
        case "textconv":
          return ["cat-file", "--textconv", "main:a.txt"];
        case "command":
        case "external":
          return ["diff", "main~2", "hdr", "--", "a.txt"];
      }
    }

    for (const kind of KINDS) {
      for (const source of SOURCES) {
        it(`${kind} × ${source}: positive control fires; hardened AND unhardened Gm never execute the driver; verdicts hdr=\`+\`, full=\`=\``, async () => {
          const { root, hdrTip, fullTip } = await matrixRepo(source);
          const scratch = await tempDir("pi-wgc-drv-");
          const { script, markerFile } = await markerScript(scratch, "drv");
          configureDriver(root, kind, script);

          // Positive control — a fixture whose driver is never consulted would make the rest vacuous.
          gitLoose(root, controlCommand(kind));
          expect(await markerCount(markerFile), `${kind}×${source}: positive control must fire`).toBeGreaterThanOrEqual(
            1,
          );

          const pins = await pinWorktree(root);
          try {
            const names = await driverNamesOf(pins, root);
            if (kind !== "external") expect(names).toContain("f");
            const head = rev(root, "main");
            const cells: Array<[string, string, string[], string[]]> = [
              ["hdr", hdrTip, [], [hdrTip]], // file-header path: no blob read, `+`
              ["full", fullTip, [fullTip], []], // full blob path: patch-id equal, `=`
            ];
            for (const [label, tip, wantEq, wantPlus] of cells) {
              const hardened = wtGraphArgs.cherry(head, tip, "sha1", names);
              for (const [mode, argv] of [
                ["hardened", hardened],
                ["unhardened", unhardenedOf(hardened)],
              ] as const) {
                await rm(markerFile, { force: true });
                const v = verdictOf(await runPinned(pins, argv), "sha1");
                const where = `${kind}×${source}×${label}×${mode}`;
                expect(await markerCount(markerFile), `${where}: driver must not run`).toBe(0);
                expect(v.code, where).toBe(0);
                expect(v.eq, where).toEqual(wantEq);
                expect(v.plus, where).toEqual(wantPlus);
              }
              cellsRun.n++;
            }
          } finally {
            await pins.close();
          }
        }, 30_000);
      }
    }

    it("all 36 cells ran (6 kinds × 3 sources × 2 paths)", () => {
      expect(cellsRun.n).toBe(36);
    });
  },
);

// ---------------------------------------------------------------------------
// E5 / E11 — config & attribute consumption pins
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath)("Gm config / attribute consumption (E5, E11)", () => {
  async function wsFixture(prefix: string) {
    const { root, topicTip } = await diverged(prefix);
    await commitFile(root, "a.txt", A_WS, "main: whitespace variant"); // full blob path, expected `=`
    return { root, topicTip };
  }

  it("E5: a user core.bigFileThreshold=1 flips the UNHARDENED result to `+`; hardened (argv fixes 512m) stays `=`", async () => {
    const { root, topicTip } = await wsFixture("pi-wgc-e5-thr-");
    const pins = await pinWorktree(root);
    try {
      const hardened = wtGraphArgs.cherry(rev(root, "main"), topicTip, "sha1", []);
      expect(verdictOf(await runPinned(pins, unhardenedOf(hardened)), "sha1")).toMatchObject({ eq: [topicTip] });
      git(root, ["config", "core.bigFileThreshold", "1"]);
      expect(verdictOf(await runPinned(pins, unhardenedOf(hardened)), "sha1")).toMatchObject({
        code: 0,
        eq: [],
        plus: [topicTip],
      });
      expect(verdictOf(await runPinned(pins, hardened), "sha1")).toMatchObject({ code: 0, eq: [topicTip], plus: [] });
    } finally {
      await pins.close();
    }
  });

  it("E5: core.bigFileThreshold=bogus makes unhardened exit 128; hardened still answers `=`", async () => {
    const { root, topicTip } = await wsFixture("pi-wgc-e5-bogus-");
    git(root, ["config", "core.bigFileThreshold", "bogus"]);
    const pins = await pinWorktree(root);
    try {
      const hardened = wtGraphArgs.cherry(rev(root, "main"), topicTip, "sha1", []);
      expect((await runPinned(pins, unhardenedOf(hardened))).code).toBe(128);
      expect(verdictOf(await runPinned(pins, hardened), "sha1")).toMatchObject({ code: 0, eq: [topicTip], plus: [] });
    } finally {
      await pins.close();
    }
  });

  it("E5 (upgrade tripwire): bogus diff UI config (algorithm / renames / context / submodule / log.showSignature) is not consulted — hardened output is unchanged", async () => {
    const { root, topicTip } = await wsFixture("pi-wgc-e5-ui-");
    const clean = await gm(root, "main", "topic");
    for (const [k, v] of [
      ["diff.algorithm", "bogus"],
      ["diff.renames", "bogus"],
      ["diff.context", "bogus"],
      ["diff.submodule", "bogus"],
      ["log.showSignature", "bogus"],
    ] as const) {
      git(root, ["config", k, v]);
    }
    const noisy = await gm(root, "main", "topic");
    expect(noisy).toMatchObject({ code: 0, eq: [topicTip], plus: [] });
    expect(noisy).toEqual(clean);
  });

  it("E11: work-tree .gitattributes `-diff` flips UNHARDENED to `+`, hardened (L1) stays `=`; info/attributes survives L1", async () => {
    const { root, topicTip } = await wsFixture("pi-wgc-e11-wt-");
    await writeFile(join(root, ".gitattributes"), "*.txt -diff\n"); // untracked, work tree only
    const pins = await pinWorktree(root);
    try {
      const hardened = wtGraphArgs.cherry(rev(root, "main"), topicTip, "sha1", []);
      expect(verdictOf(await runPinned(pins, unhardenedOf(hardened)), "sha1")).toMatchObject({
        eq: [],
        plus: [topicTip],
      });
      expect(verdictOf(await runPinned(pins, hardened), "sha1")).toMatchObject({ eq: [topicTip], plus: [] });
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, ".git", "info", "attributes"), "*.txt -diff\n");
      expect(verdictOf(await runPinned(pins, hardened), "sha1")).toMatchObject({ eq: [], plus: [topicTip] });
    } finally {
      await pins.close();
    }
  });

  it("E11: `diff=x` + diff.x.binary=true is NOT consumed — the verdict stays `=`", async () => {
    const { root, topicTip } = await wsFixture("pi-wgc-e11-bin-");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "attributes"), "*.txt diff=x\n");
    git(root, ["config", "diff.x.binary", "true"]);
    const v = await gm(root, "main", "topic");
    expect(v).toMatchObject({ code: 0, eq: [topicTip], plus: [] });
  });
});

// ---------------------------------------------------------------------------
// E12 — no work-tree / index access (strace) + chmod 000 fallback
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath)("Gm never reads the work tree or index (E12)", () => {
  async function e12Fixture() {
    const root = await repo("pi-wgc-e12-");
    await writeFile(join(root, "a.txt"), A_BASE);
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "s.txt"), "s0\n");
    await writeFile(join(root, "z.txt"), "z0\n");
    await writeFile(join(root, ".gitattributes"), "*.txt diff=x\n");
    await writeFile(join(root, "sub", ".gitattributes"), "*.txt diff=y\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    git(root, ["checkout", "-q", "-b", "topic"]);
    await writeFile(join(root, "a.txt"), A_TOPIC);
    await writeFile(join(root, "sub", "s.txt"), "s1\n");
    git(root, ["commit", "-qam", "topic: a + sub"]);
    const topicTip = rev(root, "HEAD");
    git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "z.txt", "z1\n", "main: z");
    await writeFile(join(root, "a.txt"), A_WS);
    await writeFile(join(root, "sub", "s.txt"), "s1\n");
    git(root, ["commit", "-qam", "main: a + sub variants"]);
    return { root, topicTip };
  }

  /** Raw pinned spawn under strace; returns git's stdout and the strace file-syscall log. */
  async function traced(root: string, argv: readonly string[]): Promise<{ stdout: string; log: string }> {
    const pins = await pinWorktree(root);
    const dir = await tempDir("pi-wgc-strace-");
    const logFile = join(dir, "st.log");
    try {
      const stdout = await new Promise<string>((resolve) => {
        const out: Buffer[] = [];
        const child = isolatedSpawn(
          "strace",
          [
            "-f",
            "-qq",
            "-e",
            "trace=%file",
            "-o",
            logFile,
            "git",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            ...argv,
          ],
          {
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
            stdio: ["ignore", "pipe", "pipe", pins.wt, pins.git, pins.common],
          },
        );
        child.stdout?.on("data", (c: Buffer) => out.push(c));
        child.once("close", () => resolve(Buffer.concat(out).toString("utf8")));
        child.once("error", () => resolve(""));
      });
      return { stdout, log: await readFile(logFile, "utf8").catch(() => "") };
    } finally {
      await pins.close();
    }
  }

  /** Paths opened/stat'ed relative to the cwd (= the work tree) or through the work-tree fd. */
  function workTreeTouches(log: string): string[] {
    const hits: string[] = [];
    for (const line of log.split("\n")) {
      const m = /^\d+\s+\w+\(AT_FDCWD, "([^"]*)"/.exec(line) ?? /^\d+\s+\w+\("([^"]*)"/.exec(line);
      if (m === null) continue;
      const p = m[1]!;
      if (p.startsWith("/proc/self/fd/3/")) hits.push(p);
      else if (!p.startsWith("/") && p !== "." && !/^(\.\.?\/?)$/.test(p)) hits.push(p);
      if (/\/proc\/self\/fd\/4\/index$/.test(p) || p === ".git/index") hits.push(p);
    }
    return hits;
  }

  it.skipIf(!hasStrace)(
    "strace -f -e trace=%file: hardened Gm opens NO work-tree path (root or sub/ .gitattributes) and NO .git/index; the unhardened control does open .gitattributes",
    async () => {
      const { root, topicTip } = await e12Fixture();
      const head = rev(root, "main");
      const hardened = wtGraphArgs.cherry(head, topicTip, "sha1", []);

      const ctl = await traced(root, unhardenedOf(hardened));
      expect(ctl.log.length).toBeGreaterThan(0);
      const ctlTouches = workTreeTouches(ctl.log);
      expect(ctlTouches.some((p) => p.endsWith(".gitattributes"))).toBe(true); // tracer + fixture are live

      const hard = await traced(root, hardened);
      expect(hard.log.length).toBeGreaterThan(0);
      expect(hard.stdout.trim()).toBe(`=${topicTip}`);
      expect(workTreeTouches(hard.log)).toEqual([]);
      expect(hard.log).not.toMatch(/\.gitattributes/);
    },
    30_000,
  );

  it("chmod 000 on the work-tree .gitattributes and .git/index leaves the verdict unchanged", async () => {
    const { root, topicTip } = await e12Fixture();
    const before = await gm(root, "main", "topic");
    expect(before).toMatchObject({ code: 0, bad: false });
    expect([...before.eq, ...before.plus]).toEqual([topicTip]);
    await chmod(join(root, ".gitattributes"), 0o000);
    await chmod(join(root, ".git", "index"), 0o000);
    const after = await gm(root, "main", "topic");
    expect(after).toEqual(before);
    await chmod(join(root, ".gitattributes"), 0o644);
    await chmod(join(root, ".git", "index"), 0o644);
  });
});

// ---------------------------------------------------------------------------
// replace refs / gpg / write-proof
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath)("Gm replace / gpg / write-proof pairs", () => {
  it("replace refs: an unhardened run follows `git replace` (verdict changes), hardened (--no-replace-objects) does not", async () => {
    const root = await repo("pi-wgc-replace-");
    await writeFile(join(root, "a.txt"), A_BASE);
    await writeFile(join(root, "c.txt"), "c0\n");
    await writeFile(join(root, "z.txt"), "z0\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    git(root, ["checkout", "-q", "-b", "x"]);
    const x1 = await commitFile(root, "c.txt", "c1\n", "x: unmerged change");
    git(root, ["checkout", "-q", "-b", "y", "main"]);
    const y1 = await commitFile(root, "a.txt", A_TOPIC, "y: change main will pick");
    git(root, ["checkout", "-q", "main"]);
    await commitFile(root, "z.txt", "z1\n", "main: z");
    git(root, ["cherry-pick", y1]);
    // refs/replace/<x1> := y1 — anything resolving x1 with replace enabled sees y1's content.
    git(root, ["replace", x1, y1]);
    const pins = await pinWorktree(root);
    try {
      const hardened = wtGraphArgs.cherry(rev(root, "main"), x1, "sha1", []);
      const control = withoutTokens(hardened, [["--no-replace-objects"]]);
      expect(control).not.toEqual(hardened);
      const c = verdictOf(await runPinned(pins, control), "sha1");
      const h = verdictOf(await runPinned(pins, hardened), "sha1");
      expect(h).toMatchObject({ code: 0, eq: [], plus: [x1] }); // truth: x1 is unmerged
      expect(c).not.toMatchObject({ eq: [], plus: [x1] }); // the replace really changes what an unhardened run sees
    } finally {
      await pins.close();
    }
  });

  it("gpg: log.showSignature=true + gpg.program marker — positive control (`git log --show-signature`) fires, Gm never does", async () => {
    const { root, topicTip } = await diverged("pi-wgc-gpg-");
    // A signed-looking commit on the topic branch so that signature checking has something to chew on.
    const commitContent = [
      `tree ${rev(root, "topic^{tree}")}`,
      `parent ${rev(root, "topic~1")}`,
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
    const commitPath = join(root, "signed-commit.txt");
    await writeFile(commitPath, commitContent);
    const signed = git(root, ["hash-object", "-t", "commit", "-w", commitPath]).trim();
    git(root, ["update-ref", "refs/heads/topic", signed]);
    const scratch = await tempDir("pi-wgc-gpgm-");
    const { script, markerFile } = await markerScript(scratch, "gpg");
    git(root, ["config", "gpg.program", script]);
    git(root, ["config", "log.showSignature", "true"]);

    gitLoose(root, ["log", "-1", "--show-signature", "topic"]);
    expect(await markerCount(markerFile)).toBeGreaterThanOrEqual(1); // control: gpg.program IS reachable
    await rm(markerFile, { force: true });

    const v = await gm(root, "main", "topic");
    expect(v.code).toBe(0);
    expect([...v.eq, ...v.plus]).toEqual([signed]);
    expect(topicTip).not.toBe(signed);
    expect(await markerCount(markerFile)).toBe(0);
  });

  it("write-proof: Gm changes no file under .git (objects list, refs, packed-refs, index, config, info) on a success path and on a missing-object failure", async () => {
    const { root, topicTip } = await diverged("pi-wgc-nowrite-");
    await commitFile(root, "a.txt", A_WS, "main: ws variant");
    git(root, ["pack-refs", "--all"]);
    git(root, ["update-ref", "refs/heads/loose", rev(root, "main")]);
    const pins = await pinWorktree(root);
    try {
      const argv = wtGraphArgs.cherry(rev(root, "main"), topicTip, "sha1", []);
      const before = await snapshotGitDir(root);
      expect([...before.keys()].some((k) => k.startsWith("refs/heads/"))).toBe(true); // loose ref present ⇒ non-vacuous
      const ok = await runPinned(pins, argv);
      expect(ok.code).toBe(0);
      const mid = await snapshotGitDir(root);
      expect(mid).toEqual(before);

      const blob = rev(root, "topic:a.txt");
      await rm(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      const before2 = await snapshotGitDir(root);
      const bad = await runPinned(pins, argv);
      expect(bad.code).not.toBe(0);
      expect(classifyGraphExit(bad.code!, bad.stderr)).toBe("missing-object");
      expect(await snapshotGitDir(root)).toEqual(before2);
    } finally {
      await pins.close();
    }
  });
});

// ---------------------------------------------------------------------------
// perf smoke (§9): 2000 commits + 24 candidates × 3 commits
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath)("Gm perf smoke (§9)", () => {
  it("24 candidate branches × 3 commits over a 2000-commit history: all 24 Gm runs finish well inside the 14 s phase", async () => {
    const root = await repo("pi-wgc-smoke-");
    const lines: string[] = [];
    let mark = 0;
    const commit = (ref: string, msg: string, file: string, body: string, from?: string): number => {
      const id = ++mark;
      lines.push(`commit ${ref}`, `mark :${id}`, `committer T <t@e.invalid> ${1_700_000_000 + id} +0000`);
      lines.push(`data ${Buffer.byteLength(msg)}`, msg);
      if (from !== undefined) lines.push(`from ${from}`);
      lines.push(`M 100644 inline ${file}`, `data ${Buffer.byteLength(body)}`, body, "");
      return id;
    };
    let prev: number | undefined;
    for (let i = 0; i < 2000; i++) {
      prev = commit("refs/heads/main", `m${i}`, "a.txt", `line ${i}\n`, prev === undefined ? undefined : `:${prev}`);
    }
    const mainMark = prev!;
    for (let b = 0; b < 24; b++) {
      let p = mainMark;
      for (let c = 0; c < 3; c++)
        p = commit(`refs/heads/cand-${b}`, `c${b}-${c}`, `f${b}.txt`, `v${b}-${c}\n`, `:${p}`);
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["fast-import", "--quiet"], {
        cwd: root,
        env: SAFE_ENV,
        stdio: ["pipe", "ignore", "pipe"],
      });
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exit ${code}`))));
      child.stdin.end(lines.join("\n") + "\n");
    });
    git(root, ["reset", "-q", "--hard", "main"]);
    const head = rev(root, "main");
    const pins = await pinWorktree(root);
    try {
      const started = Date.now();
      let judged = 0;
      for (let b = 0; b < 24; b++) {
        const tip = rev(root, `cand-${b}`);
        const v = verdictOf(await runPinned(pins, wtGraphArgs.cherry(head, tip, "sha1", [])), "sha1");
        expect(v.code).toBe(0);
        expect(v.bad).toBe(false);
        expect(v.eq).toEqual([]);
        expect(v.plus).toHaveLength(3);
        judged++;
      }
      expect(judged).toBe(24);
      expect(Date.now() - started).toBeLessThan(14_000);
    } finally {
      await pins.close();
    }
  }, 60_000);
});
