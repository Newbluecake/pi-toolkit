// jev-plan §4 J7 probes: /proc scan (fake tree + real on-disk tree through
// safe-fs), git HEAD, staged files through a fake GitRunner, evidence
// fingerprint, collectEvidence (non-Linux, child, redaction, staged gating).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GitRunner, GitRunResult } from "../../../src/git/run.js";
import type { GateCandidate, GateEvidence, MemEntry } from "../../../src/memory/jev/contracts.js";
import { effectiveMeta } from "../../../src/memory/jev/decide.js";
import { splitEntries } from "../../../src/memory/jev/entries.js";
import {
  clearProcCache,
  collectEvidence,
  commandShape,
  createProcCache,
  evidenceFingerprint,
  hasPathLikeWord,
  isGitCommit,
  readGitHead,
  SAFE_PROBE_FS,
  scanProc,
  stagedFiles,
  type ProbeFs,
} from "../../../src/memory/jev/probes.js";
import { parseShell } from "../../../src/memory/jev/shell-parse.js";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";

const UID = 1000;

/** In-memory fs: `files` path → text; directories are implied by prefixes. */
function fakeFs(files: Record<string, string>, opts: { failList?: boolean } = {}) {
  const reads: string[] = [];
  const fs: ProbeFs = {
    listDir: (path) => {
      if (opts.failList === true) return [];
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]!);
      return [...names];
    },
    readHead: (path, max) => {
      reads.push(path);
      const t = files[path];
      return t === undefined ? undefined : t.slice(0, max);
    },
  };
  return { fs, reads, files };
}

const status = (uid: number) => `Name:\tx\nState:\tS\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
const argv = (...a: string[]) => `${a.join("\u0000")}\u0000`;

function procTree(): Record<string, string> {
  return {
    "/proc/100/status": status(UID),
    "/proc/100/cmdline": argv("bash", "scripts/release/release.sh", "0.10.3"),
    "/proc/101/status": status(UID),
    "/proc/101/cmdline": argv("vim", "scripts/release/release.sh"),
    "/proc/102/status": status(0), // other uid
    "/proc/102/cmdline": argv("bash", "scripts/release/release.sh"),
    "/proc/103/status": status(UID), // vanished: no cmdline any more
    "/proc/104/status": status(UID),
    "/proc/104/cmdline": argv("/usr/local/bin/release.sh", "--dry"),
    "/proc/self/status": status(UID),
    "/proc/105/status": status(UID),
    "/proc/105/cmdline": "", // kernel thread
  };
}

describe("scanProc (Linux /proc, Q30)", () => {
  test("only the current uid, identity from argv0/script (vim …/release.sh is vim), vanished pids skipped", () => {
    const { fs } = fakeFs(procTree());
    const hits = scanProc("/proc", UID, new Set(["release.sh"]), createProcCache(), { fs });
    expect(hits.map((h) => h.pid).sort()).toEqual([100, 104]);
    expect(hits.find((h) => h.pid === 100)?.command).toBe("bash scripts/release/release.sh 0.10.3");
    expect(scanProc("/proc", UID, new Set(["vim"]), createProcCache(), { fs }).map((h) => h.pid)).toEqual([101]);
  });

  test("empty wanted set ⇒ no fs access at all; readdir failure ⇒ []", () => {
    const a = fakeFs(procTree());
    expect(scanProc("/proc", UID, new Set(), createProcCache(), { fs: a.fs })).toEqual([]);
    expect(a.reads).toEqual([]);
    const b = fakeFs(procTree(), { failList: true });
    expect(scanProc("/proc", UID, new Set(["release.sh"]), createProcCache(), { fs: b.fs })).toEqual([]);
  });

  test("a throwing fs never escapes (scan never throws)", () => {
    const fs: ProbeFs = {
      listDir: () => {
        throw new Error("EACCES");
      },
      readHead: () => undefined,
    };
    expect(scanProc("/proc", UID, new Set(["release.sh"]), createProcCache(), { fs })).toEqual([]);
  });

  test("2s result cache; clearProcCache forces a rescan; the cache filters by the current wanted set", () => {
    const f = fakeFs(procTree());
    let t = 1_000;
    const cache = createProcCache();
    scanProc("/proc", UID, new Set(["release.sh"]), cache, { fs: f.fs, now: () => t });
    const first = f.reads.length;
    t += 1_500;
    expect(scanProc("/proc", UID, new Set(["vim"]), cache, { fs: f.fs, now: () => t }).map((h) => h.pid)).toEqual([
      101,
    ]);
    expect(f.reads.length).toBe(first); // cached
    clearProcCache(cache);
    scanProc("/proc", UID, new Set(["release.sh"]), cache, { fs: f.fs, now: () => t });
    expect(f.reads.length).toBe(first * 2);
    t += 2_001;
    scanProc("/proc", UID, new Set(["release.sh"]), cache, { fs: f.fs, now: () => t });
    expect(f.reads.length).toBe(first * 3);
  });

  test("pid cap and scan deadline bound the walk", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 50; i++) {
      files[`/proc/${1000 + i}/status`] = status(UID);
      files[`/proc/${1000 + i}/cmdline`] = argv("release.sh");
    }
    const f = fakeFs(files);
    expect(scanProc("/proc", UID, new Set(["release.sh"]), createProcCache(), { fs: f.fs, maxPids: 10 })).toHaveLength(
      10,
    );
    let t = 0;
    const slow = scanProc("/proc", UID, new Set(["release.sh"]), createProcCache(), {
      fs: f.fs,
      now: () => (t += 100),
      deadlineMs: 1_000,
    });
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.length).toBeLessThan(50);
  });

  describe("real on-disk tree through safe-fs (SAFE_PROBE_FS)", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "jev-proc-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    test("reads status/cmdline files; missing pid dir contents are skipped", () => {
      for (const [path, text] of Object.entries(procTree())) {
        const full = join(root, path.replace(/^\/proc\//, ""));
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, text);
      }
      mkdirSync(join(root, "999"), { recursive: true }); // empty pid dir (vanished)
      const hits = scanProc(root, UID, new Set(["release.sh"]), createProcCache(), { fs: SAFE_PROBE_FS });
      expect(hits.map((h) => h.pid).sort()).toEqual([100, 104]);
    });
  });

  test.runIf(process.platform === "linux")("the real /proc scan returns an array and never throws", () => {
    const uid = process.getuid?.() ?? 0;
    expect(Array.isArray(scanProc("/proc", uid, new Set(["node"]), createProcCache()))).toBe(true);
  });
});

describe("readGitHead", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jev-git-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("branch, walk-up from a subdirectory, detached HEAD, non-git", () => {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "src", "deep"), { recursive: true });
    writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/dev\n");
    expect(readGitHead(join(root, "repo"))).toBe("dev");
    expect(readGitHead(join(root, "repo", "src", "deep"))).toBe("dev");
    writeFileSync(join(root, "repo", ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    expect(readGitHead(join(root, "repo"))).toBe("detached@0123456");
    mkdirSync(join(root, "plain"), { recursive: true });
    expect(readGitHead(join(root, "plain"))).toBeUndefined();
  });

  test("worktree: `.git` file with a relative or absolute gitdir pointer", () => {
    mkdirSync(join(root, "main", ".git", "worktrees", "wt1"), { recursive: true });
    writeFileSync(join(root, "main", ".git", "worktrees", "wt1", "HEAD"), "ref: refs/heads/feat/x\n");
    mkdirSync(join(root, "wt1"), { recursive: true });
    writeFileSync(join(root, "wt1", ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "wt1")}\n`);
    expect(readGitHead(join(root, "wt1"))).toBe("feat/x");
    writeFileSync(join(root, "wt1", ".git"), "gitdir: ../main/.git/worktrees/wt1\n");
    expect(readGitHead(join(root, "wt1"))).toBe("feat/x");
    writeFileSync(join(root, "wt1", ".git"), "gitdir: ../missing\n");
    expect(readGitHead(join(root, "wt1"))).toBeUndefined();
  });
});

describe("stagedFiles (bounded git runner)", () => {
  const result = (over: Partial<GitRunResult>): GitRunResult => ({
    code: 0,
    stdout: "",
    stdoutCapped: false,
    stderr: "",
    ...over,
  });

  test("list ≤50 with the exact argv; exit 128 / timeout / spawn error ⇒ undefined; capped ⇒ partial tail dropped", async () => {
    let seen: readonly string[] = [];
    const lines = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`).join("\n");
    const ok: GitRunner = async (args, opts) => {
      seen = args;
      expect(opts.timeoutMs).toBeLessThanOrEqual(1_000);
      return result({ stdout: `${lines}\n` });
    };
    const files = await stagedFiles(ok, "/repo");
    expect(seen).toEqual(["-C", "/repo", "diff", "--cached", "--name-only"]);
    expect(files).toHaveLength(50);
    expect(await stagedFiles(async () => result({ code: 128, stderr: "not a git repository" }), "/x")).toBeUndefined();
    expect(await stagedFiles(async () => result({ code: null, killed: "timeout" }), "/x")).toBeUndefined();
    expect(await stagedFiles(async () => result({ code: null, spawnError: "ENOENT" }), "/x")).toBeUndefined();
    expect(await stagedFiles(async () => result({ stdout: "a.ts\nb.ts\nc.t", stdoutCapped: true }), "/x")).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(
      await stagedFiles(async () => {
        throw new Error("boom");
      }, "/x"),
    ).toBeUndefined();
  });
});

describe("fingerprint, shape, helpers", () => {
  test("evidenceFingerprint is order-independent, label-independent, and changes with programs/branch/staged", () => {
    const a: GateEvidence = {
      running: [
        { label: "job_1 (3m) bash scripts/release/release.sh 0.10.3", program: "release.sh", command: "x" },
        { label: "pid 9 deploy.py", program: "deploy.py", command: "y" },
      ],
      branch: "dev",
      staged: ["b.ts", "a.ts"],
    };
    const b: GateEvidence = {
      running: [
        { label: "pid 9 deploy.py --other-args", program: "deploy.py", command: "z" },
        { label: "job_7 (9m) other label", program: "release.sh", command: "w" },
      ],
      branch: "dev",
      staged: ["a.ts", "b.ts"],
    };
    expect(evidenceFingerprint(a)).toBe(evidenceFingerprint(b));
    expect(evidenceFingerprint({ ...a, branch: "master" })).not.toBe(evidenceFingerprint(a));
    expect(evidenceFingerprint({ ...a, staged: [] })).not.toBe(evidenceFingerprint(a));
    expect(evidenceFingerprint({ ...a, running: [] })).not.toBe(evidenceFingerprint(a));
    expect(evidenceFingerprint({ running: [], staged: [] })).toMatch(/^[0-9a-f]{12}$/);
  });

  test("commandShape / isGitCommit / hasPathLikeWord", () => {
    const parsed = parseShell("git add -A && git commit -m 'fix: x'").commands;
    expect(commandShape(parsed)).toEqual(["git add", "git commit"]);
    expect(isGitCommit(parsed)).toBe(true);
    expect(isGitCommit(parseShell('echo "git commit"').commands)).toBe(false);
    expect(isGitCommit(parseShell("git -C . commit -m x").commands)).toBe(true);
    expect(hasPathLikeWord("never commit tests/fixtures/ by hand")).toBe(true);
    expect(hasPathLikeWord("bump package.json first")).toBe(true);
    expect(hasPathLikeWord("禁止在发版中提交")).toBe(false);
  });
});

// ───────────────────────────── collectEvidence ─────────────────────────────

function cand(raw: string): GateCandidate {
  const [entry] = splitEntries("pitfalls.md", raw, { status: "active", handWritten: true }) as MemEntry[];
  const tax = mergeTaxonomy();
  if (!tax.ok) throw new Error("taxonomy");
  return { entry: entry!, meta: effectiveMeta(entry!, undefined, tax.taxonomy) };
}

const HOLD = "## 发版\n\n- release.sh 运行期间禁止 commit/tag/切分支 <!-- mem user gate=hold -->\n";
const PATHS =
  "## Fixtures\n\n- never commit tests/fixtures/ changes from release.sh runs <!-- mem user gate=hold -->\n";

describe("collectEvidence", () => {
  const gitCalls: string[][] = [];
  const git: GitRunner = async (args) => {
    gitCalls.push([...args]);
    return { code: 0, stdout: "tests/fixtures/x.json\n", stdoutCapped: false, stderr: "" };
  };
  const jobs = (command: string, status = "running") => ({
    list: () => [{ id: "job_42", status, command, startedAt: 0 }],
  });
  beforeEach(() => {
    gitCalls.length = 0;
  });

  test("Linux: bash jobs + /proc, named programs only, deduped, redacted (token masked)", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const f = fakeFs({
      ...procTree(),
      "/proc/200/status": status(UID),
      "/proc/200/cmdline": argv("bash", "scripts/release/release.sh", `--token=${secret}`),
    });
    const ev = await collectEvidence({
      cands: [cand(HOLD)],
      command: "git add -A && git commit -m x",
      platform: "linux",
      bashJobs: jobs(`GITHUB_TOKEN=${secret} bash scripts/release/release.sh 0.10.3`),
      isChild: false,
      git,
      cwd: "/nowhere",
      now: () => 180_000,
      procCache: createProcCache(),
      uid: UID,
      fs: f.fs,
    });
    expect(ev.running.map((r) => r.program)).toEqual(["release.sh", "release.sh", "release.sh", "release.sh"]);
    expect(ev.running[0]!.label).toMatch(/^job_42 \(3m\) /);
    const all = JSON.stringify(ev.running);
    expect(all).not.toContain(secret);
    expect(all).not.toContain("vim");
    for (const r of ev.running) expect(Array.from(r.label).length).toBeLessThanOrEqual(120);
    // `release.sh` is itself a path-like word ⇒ the staged probe ran too.
    expect(ev.staged).toEqual(["tests/fixtures/x.json"]);
  });

  test("non-Linux: bash jobs only (fs never touched); child: no bash jobs", async () => {
    const f = fakeFs(procTree());
    const base = {
      cands: [cand(HOLD)],
      command: "git commit -m x",
      git,
      cwd: "/nowhere",
      now: () => 0,
      procCache: createProcCache(),
      uid: UID,
      fs: f.fs,
    };
    const mac = await collectEvidence({
      ...base,
      platform: "darwin",
      isChild: false,
      bashJobs: jobs("bash release.sh"),
    });
    expect(mac.running.map((r) => r.label)).toEqual(["job_42 (0m) bash release.sh"]);
    expect(f.reads.filter((p) => p.startsWith("/proc"))).toEqual([]);
    const child = await collectEvidence({
      ...base,
      platform: "darwin",
      isChild: true,
      bashJobs: jobs("bash release.sh"),
    });
    expect(child.running).toEqual([]);
    const finished = await collectEvidence({
      ...base,
      platform: "darwin",
      isChild: false,
      bashJobs: jobs("bash release.sh", "completed"),
    });
    expect(finished.running).toEqual([]);
  });

  test("staged only for git commit with a path-like word in a candidate body; ≤50, failure omitted", async () => {
    const base = {
      cands: [cand(PATHS)],
      platform: "darwin" as const,
      isChild: false,
      git,
      cwd: "/repo",
      now: () => 0,
      procCache: createProcCache(),
    };
    const ev = await collectEvidence({ ...base, command: "git commit -m x" });
    expect(ev.staged).toEqual(["tests/fixtures/x.json"]);
    expect(gitCalls[0]).toEqual(["-C", "/repo", "diff", "--cached", "--name-only"]);
    await collectEvidence({ ...base, command: "git push" });
    expect(gitCalls).toHaveLength(1);
    const failing: GitRunner = async () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "fatal" });
    expect((await collectEvidence({ ...base, git: failing, command: "git commit -m x" })).staged).toEqual([]);
    await collectEvidence({ ...base, command: "git -C sub commit -m x" });
    expect(gitCalls[1]).toEqual(["-C", "/repo/sub", "diff", "--cached", "--name-only"]);
  });

  test("running list caps at 10 items", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      files[`/proc/${300 + i}/status`] = status(UID);
      files[`/proc/${300 + i}/cmdline`] = argv("release.sh", `--n=${i}`);
    }
    const ev = await collectEvidence({
      cands: [cand(HOLD)],
      command: "git commit",
      platform: "linux",
      isChild: true,
      git,
      cwd: "/nowhere",
      now: () => 0,
      procCache: createProcCache(),
      uid: UID,
      fs: fakeFs(files).fs,
    });
    expect(ev.running).toHaveLength(10);
  });
});
