/**
 * worktree-diff plan §5 D6 — the endpoint-layer integration suite.
 *
 * Everything is real:
 * - REAL hub assembly: an in-process `startHub` + `createHttpFrontend` with `preview:"on"`
 *   (the preview-e2e harness shape — D3 wires the wtdiff routes into exactly this assembly),
 *   PLUS a real hub CHILD PROCESS (jiti, the production fork path from web-hub-headless mode A)
 *   for the process-level close/residual assertions;
 * - REAL git, REAL temporary repositories (a main worktree + a linked worktree each);
 * - the ONLY seam is `StartHubDeps.gitRunner` (hub.ts:180 — the D3 injection point the plan
 *   itself specifies), wrapped around the REAL runner to (a) observe the frozen argv traffic
 *   and (b) reproduce §2.6.3's "window injection" TOCTOU timing exactly as designed: a hook
 *   fires after Cc/info/attributes have been read and before C2 spawns, rewriting config or
 *   attributes with real git while the request is in flight.
 *
 * Coverage (plan §5 D6, line by line):
 * - list grammar M/A/D/R/?/nested-untracked/binary across the main + linked worktrees, with
 *   numstat counts and the file endpoint's patch/untracked/binary/rename payloads;
 * - `.env` modified ⇒ absent from the list, excluded from `total`, a direct file ask 403;
 * - arbitrary-history read (#1): an older commit's OID as base ⇒ 409 `base`; current HEAD +
 *   a historically-deleted path ⇒ 409 `entry`;
 * - §2.6.3 endpoint-layer driver scenarios T1–T12 (H1; T11 rides the runner seam — a fake
 *   129 exit; T13 is a unit-test-only env assertion, pinned in tests/git/run.test.ts);
 * - H4: `.git/index` stat byte-identical across requests, hook marker 0;
 * - non-member directories ⇒ 403 (a plain dir and ANOTHER repo's worktree);
 * - hub close: the in-flight request terminates (503 E_HUB_RESTARTING), the dispose abort
 *   reaches the shared execution's signal, pinned fds are closed (/proc/self/fd), no residual
 *   git children; the child-process case proves the SIGTERM path leaves no orphaned git
 *   process-group leaders behind.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, stat, utimes, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { WTDIFF_GIT_PATH } from "../../src/git/diff.js";
import type { GitRunner, GitRunResult } from "../../src/git/run.js";
import { createGitRunner } from "../../src/git/run.js";
import { spawnHub, resolveJitiCli, type LauncherPlan } from "../../src/web-hub/agent/launcher.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import {
  WTDIFF_FILE_PATH,
  WTDIFF_FILES_PATH,
  parseWtDiffFileList,
  type WtDiffFileEntry,
  type WtDiffFileList,
} from "../../src/web-hub/protocol/worktree-diff.js";
import { config as hubConfig, connectClient, hello, type Hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, rawRequest, type RawResponse } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";

// ---------------------------------------------------------------------------
// environment probes (the git-wtdiff D1 pattern)
// ---------------------------------------------------------------------------

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Every hub-side git call runs envPolicy:"minimal" + pathOverride:WTDIFF_GIT_PATH — the whole
 * suite requires git inside the fixed PATH (plan §5 D1; same skip as git-wtdiff). */
const gitInFixedPath = (() => {
  const probe = spawnSync("git", ["--version"], { env: { PATH: WTDIFF_GIT_PATH }, encoding: "utf8" });
  return probe.status === 0;
})();

const IS_LINUX = process.platform === "linux";
/** The three-fd pin (and the whole feature, D21) is /proc-dependent — POSIX-only, fail-closed. */
const hasProcFd = IS_LINUX && existsSync("/proc/self/fd");

if (hasGit && gitInFixedPath && !hasProcFd) {
  console.warn("[web-hub-worktree-diff] skipping: /proc/self/fd unavailable (D21 fail-closed)");
}

// ---------------------------------------------------------------------------
// shared git fixtures (the git-wtdiff D1 helpers, endpoint-flavored)
// ---------------------------------------------------------------------------

const tempRoots = new Set<string>();
const homes = new Set<string>(); // hub homes live PAST afterEach — cleaned after hub close

/** sync mkdtemp registered for afterEach cleanup */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(dir);
  return dir;
}

/** A hub home — kept alive across its (shared-hub) tests; removed after hub close. */
function hubHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.add(dir);
  return dir;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...(env !== undefined ? { env } : {}) });
}

async function repo(prefix: string, opts: { objectFormat?: "sha1" | "sha256" } = {}): Promise<string> {
  const root = tempDir(prefix);
  const initArgs = ["init", "-q", "-b", "main"];
  if (opts.objectFormat !== undefined) initArgs.push("--object-format", opts.objectFormat);
  git(root, initArgs);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

async function commitFile(root: string, path: string, content: string | Buffer, message: string): Promise<string> {
  await writeFile(join(root, path), content);
  git(root, ["add", path]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

/** SAME-SIZE rewrite with an explicit distinct mtime — the two preconditions at once: the
 *  stat mismatch makes status re-hash content (running any clean filter — the marker
 *  scenarios), and the changed content keeps the file IN the changeset (the entry
 *  assertions). A size change alone would NOT re-hash (§2.6.1) and same-content would
 *  NOT appear in the list. */
async function rehashTouch(file: string, content: string): Promise<void> {
  await writeFile(file, content);
  const distinct = new Date(Date.now() - 10_000);
  await utimes(file, distinct, distinct);
}

async function markerDriver(prefix: string, name: string): Promise<{ script: string; markerFile: string }> {
  const markerDir = tempDir(prefix);
  const markerFile = join(markerDir, "marker.txt");
  const script = join(markerDir, `${name}.sh`);
  await writeFile(script, `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(markerFile)}\ncat\n`, { mode: 0o755 });
  return { script, markerFile };
}

async function markerCount(file: string): Promise<number> {
  try {
    return (await readFileSafe(file)).split("\n").filter((l) => l === "x").length;
  } catch {
    return 0;
  }
}

async function readFileSafe(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}

async function indexStatOf(gitdir: string): Promise<string> {
  const s = await stat(join(gitdir, "index"));
  return `${s.mtimeMs}:${s.size}:${s.ino}`;
}

// ---------------------------------------------------------------------------
// /proc probes (the residual-process / pinned-fd assertions)
// ---------------------------------------------------------------------------

interface ProcStat {
  pid: number;
  comm: string;
  ppid: number;
  pgrp: number;
  starttimeTicks: number;
}

function readProcStat(pid: number): ProcStat | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const open = raw.indexOf("(");
    const close = raw.lastIndexOf(")");
    if (open === -1 || close === -1) return undefined;
    const pidNum = Number(raw.slice(0, open));
    const comm = raw.slice(open + 1, close);
    const fields = raw.slice(close + 2).split(" ");
    return {
      pid: pidNum,
      comm,
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      starttimeTicks: Number(fields[19]), // field 22 (1-based) = index 19 after state(3)
    };
  } catch {
    return undefined;
  }
}

function allProcStats(): ProcStat[] {
  const out: ProcStat[] = [];
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      const s = readProcStat(Number(name));
      if (s !== undefined) out.push(s);
    }
  } catch {
    /* /proc unreadable */
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EPERM";
  }
}

/** Any live git process whose parent is `parent` (hub-spawned git, per §1.8's plain spawn). */
function gitChildrenOf(parent: number): number[] {
  return allProcStats()
    .filter((s) => s.comm === "git" && s.ppid === parent)
    .map((s) => s.pid);
}

/** Detached-spawned git is its OWN process-group leader (`detached:true`, run.ts) — after the
 * hub dies, a survivor shows up as ppid==1 && pgrp==pid && comm=="git", fresh since `since`. */
function orphanGitLeadersSince(sinceTicks: number): number[] {
  return allProcStats()
    .filter((s) => s.comm === "git" && s.ppid === 1 && s.pgrp === s.pid && s.starttimeTicks >= sinceTicks)
    .map((s) => s.pid);
}

/** File descriptors (of this process or a hub child) pointing INTO the test's temp roots —
 * the three pinned worktree/gitdir/commondir fds + the untracked handle all live there. */
function fdsIntoTempRoots(pid: number | "self"): string[] {
  const hits: string[] = [];
  try {
    for (const name of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${name}`);
        for (const root of tempRoots) {
          if (target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}-`)) {
            hits.push(`${name}->${target}`);
            break;
          }
        }
      } catch {
        /* raced close */
      }
    }
  } catch {
    /* gone */
  }
  return hits;
}

// ---------------------------------------------------------------------------
// the spy/wrap runner — the ONLY test seam (StartHubDeps.gitRunner, plan §1.6)
// ---------------------------------------------------------------------------

const isCc = (argv: readonly string[]): boolean => argv.includes("config") && argv.includes("--get-regexp");
const isC2 = (argv: readonly string[]): boolean => argv.includes("status") && argv.includes("--porcelain=v2");
/** the full-mode changeset C2 only — the session-settle probe runs `untracked=no`, whose C2
 *  fills a DIFFERENT cache key and must not pollute "C2 never executed" assertions. */
const isC2All = (argv: readonly string[]): boolean => isC2(argv) && argv.includes("--untracked-files=all");

interface SpyHooks {
  /** §2.6.3 window injection: runs after Cc/info/attributes were read and BEFORE the C2
   * spawn — the exact TOCTOU window the plan's three-layer mitigation is designed against. */
  beforeC2?: () => Promise<void>;
  /** Hold the C2 result away from the route until `gate` resolves (the in-flight fixture). */
  holdC2?: boolean;
  /** T11: answer every attr-source-carrying command with git 2.53's "unknown option" 129. */
  fakeGitTooOld?: boolean;
}

interface RunnerSpy {
  runner: GitRunner;
  /** every argv forwarded to the real runner, in order */
  commands: string[][];
  /** C2 argv observed (status --porcelain=v2) — "C2 never executed" assertions read this. */
  c2Count: () => number;
  /** full-mode (`--untracked-files=all`) C2 count — what the D6 assertions mean by C2. */
  c2AllCount: () => number;
  /** the AbortSignal the latest C2 call ran under (the SHARED EXECUTION's signal, §1.10). */
  c2Signal: () => AbortSignal | undefined;
  /** resolves once a held C2 call has reached the real runner (the in-flight fixture's sync point) */
  c2Started: Promise<void>;
  /** releases the held C2 result to the route */
  releaseC2: () => void;
  hooks: SpyHooks;
}

function spyRunner(real: GitRunner = createGitRunner()): RunnerSpy {
  const spy: RunnerSpy = {
    commands: [],
    c2Count: () => spy.commands.filter(isC2).length,
    c2AllCount: () => spy.commands.filter(isC2All).length,
    c2Signal: () => lastC2Signal,
    c2Started: Promise.resolve(),
    releaseC2: () => {
      if (gateResolve !== undefined) gateResolve();
    },
    hooks: {},
    runner: (argv, opts) => {
      spy.commands.push([...argv]);
      // T11: `--attr-source`/`--source=` unknown to the installed git ⇒ exit 129 "unknown option"
      if (
        spy.hooks.fakeGitTooOld === true &&
        argv.some((a) => a.startsWith("--attr-source") || a.startsWith("--source="))
      ) {
        return Promise.resolve({
          code: 129,
          stdout: "",
          stdoutCapped: false,
          stderr: "error: unknown option `attr-source'",
        } satisfies GitRunResult);
      }
      if (isC2(argv)) {
        lastC2Signal = opts.signal;
        const run = real(argv, opts);
        if (startedResolve !== undefined) {
          startedResolve();
        } else {
          spy.c2Started = new Promise<void>((r) => {
            startedResolve = r;
            r();
          });
        }
        const pre = spy.hooks.beforeC2 ? spy.hooks.beforeC2() : Promise.resolve();
        const held = gate.then(() => undefined);
        return (async () => {
          await pre;
          const result = await run;
          if (spy.hooks.holdC2 === true) await held;
          return result;
        })();
      }
      return real(argv, opts);
    },
  };
  let lastC2Signal: AbortSignal | undefined;
  let startedResolve: (() => void) | undefined;
  let gateResolve: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    gateResolve = r;
  });
  return spy;
}

// ---------------------------------------------------------------------------
// the in-process harness (preview-e2e shape: real startHub + socket fake agent)
// ---------------------------------------------------------------------------

const AGENT_PID = 424242;
const AGENT_NONCE = "wtdiffe2enonce00";
const AGENT_KEY = `a${AGENT_PID}-${AGENT_NONCE.slice(0, 6)}`;
const SESSION = "wtd-e2e-session";

interface Live {
  hub: RunningHub;
  agent: TestClient;
  port: number;
  cookie: string;
  spy: RunnerSpy;
}

function filesPath(wt: string, over: { untracked?: "no" } = {}): string {
  const q = new URLSearchParams({ agentKey: AGENT_KEY, sessionId: SESSION, wt });
  if (over.untracked === "no") q.set("untracked", "no");
  return `${WTDIFF_FILES_PATH}?${q.toString()}`;
}

function filePath(wt: string, base: string, path: string, orig?: string): string {
  const q = new URLSearchParams({ agentKey: AGENT_KEY, sessionId: SESSION, wt, base, path });
  if (orig !== undefined) q.set("orig", orig);
  return `${WTDIFF_FILE_PATH}?${q.toString()}`;
}

async function bootLive(spy: RunnerSpy, home: string): Promise<Live> {
  const hub = await startHub(hubConfig({ home, port: 0, preview: "on" }), createHttpFrontend, {
    uid: process.getuid?.() ?? 0,
    gitRunner: spy.runner,
  });
  if ("exists" in hub) throw new Error("hub startLock conflict — home not fresh");
  const agent = await connectClient(hub.paths.socketPath);
  agent.send(hello({ agentId: { pid: AGENT_PID, nonce: AGENT_NONCE }, cwd: home, caps: [] }));
  const ack = await agent.waitFrame((f) => f["t"] === "hello_ack");
  expect(ack["agentKey"]).toBe(AGENT_KEY);
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);
  return { hub, agent, port: hub.httpPort, cookie, spy };
}

/** Point the fake agent's session at `cwd` and settle the registry. The session frame has
 *  no ack; the hub-side onFrame is synchronous on the socket data event, so a short lead-in
 *  plus a probe (retry while membership still answers from a deleted previous cwd) settles
 *  it. Probe with wt=cwd itself: settled fixtures all carry working-tree dirt ⇒ 200. */
async function setSessionCwd(live: Live, cwd: string): Promise<void> {
  live.agent.send({ t: "session", sessionId: SESSION, cwd, reason: "d6", leafId: null, mode: "tui" });
  await sleep(30);
  const deadline = Date.now() + 5_000;
  for (;;) {
    // probe in `untracked=no` mode: it fills a DIFFERENT changeset cache key, so the test's
    // own full-mode request still executes C2 (the window-injection scenarios depend on it)
    const r = await wtFiles(live, cwd, { untracked: "no" });
    if (!r.body.includes('"reason":"not-repo"')) return; // settled (200 or a case-specific error)
    if (Date.now() > deadline) throw new Error(`session never moved to ${cwd}: ${r.status} ${r.body}`);
    await sleep(15);
  }
}

/** A files/file ask with 429 backoff — the shared hub's wtdiff token bucket (20, +1/250 ms)
 *  is small against a 13-case suite that probes its session first (§1.7 ④). */
async function withRateRetry(fn: () => Promise<RawResponse>, tries = 40): Promise<RawResponse> {
  for (let i = 0; ; i += 1) {
    const r = await fn();
    if (r.status !== 429 || i >= tries) return r;
    await sleep(300);
  }
}

function wtFiles(live: Live, wt: string, over: { untracked?: "no"; timeoutMs?: number } = {}): Promise<RawResponse> {
  return withRateRetry(() =>
    rawRequest(live.port, {
      method: "GET",
      path: filesPath(wt, over.untracked === undefined ? {} : { untracked: over.untracked }),
      headers: { "X-PWH": "1", Cookie: live.cookie },
      timeoutMs: over.timeoutMs ?? 10_000,
    }),
  );
}

function wtFile(
  live: Live,
  wt: string,
  base: string,
  path: string,
  orig?: string,
  over: { timeoutMs?: number } = {},
): Promise<RawResponse> {
  return withRateRetry(() =>
    rawRequest(live.port, {
      method: "GET",
      path: filePath(wt, base, path, orig),
      headers: { "X-PWH": "1", Cookie: live.cookie },
      timeoutMs: over.timeoutMs ?? 10_000,
    }),
  );
}

function bodyJson(r: RawResponse): Record<string, unknown> {
  return JSON.parse(r.body) as Record<string, unknown>;
}

function listEntries(payload: WtDiffFileList): Map<string, WtDiffFileEntry> {
  return new Map(payload.entries.map((e) => [e.path, e]));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the shared repo fixture: main worktree + linked worktree, full grammar
// ---------------------------------------------------------------------------

/** The §5 D6 list fixture — a repo whose working tree carries every status the endpoint
 *  understands: M (tracked.txt), A (added.txt, staged), R (old.txt→new.txt, staged rename),
 *  D-in-history (gone.txt: present at HEAD~1, deleted at HEAD), ? (top.txt + the nested
 *  deep/nested/dir/leaf.txt), binary M (bin.bin), and a modified committed .env (hidden). */
async function grammarRepo(prefix: string): Promise<{ root: string; linked: string; head: string; older: string }> {
  const root = await repo(prefix);
  const binHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 4, 5, 6]);
  await writeFile(join(root, "tracked.txt"), "aaa\n");
  await writeFile(join(root, "gone.txt"), "historical file\n");
  await writeFile(join(root, "old.txt"), "rename me\n");
  await writeFile(join(root, "bin.bin"), binHead);
  await writeFile(join(root, ".env"), "SECRET=1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const older = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["rm", "-q", "gone.txt"]);
  git(root, ["commit", "-qm", "delete gone"]); // HEAD: gone.txt no longer exists
  const head = git(root, ["rev-parse", "HEAD"]).trim();

  // working tree, unstaged + staged mixes
  await writeFile(join(root, "tracked.txt"), "bbb\n");
  await writeFile(join(root, "added.txt"), "brand new\n");
  git(root, ["add", "added.txt"]); // staged A
  await rename(join(root, "old.txt"), join(root, "new.txt"));
  git(root, ["add", "-A"]); // staged R (old.txt → new.txt)
  await writeFile(
    join(root, "bin.bin"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 9, 9, 9, 9, 9, 9]),
  );
  await writeFile(join(root, ".env"), "SECRET=2\n"); // hidden item
  await mkdir(join(root, "deep", "nested", "dir"), { recursive: true });
  await writeFile(join(root, "deep", "nested", "dir", "leaf.txt"), "leaf\n");
  await writeFile(join(root, "top.txt"), "top\n");

  // the linked worktree — its own M + ?
  const linked = `${root}-linked`;
  git(root, ["worktree", "add", "-q", "-b", "linked", linked]);
  await writeFile(join(linked, "linked-mod.txt"), "lm\n");
  await writeFile(join(linked, "linked-new.txt"), "ln\n");
  return { root, linked, head, older };
}

// ---------------------------------------------------------------------------
// A — list grammar / denylist / arbitrary-history / non-member / fd hygiene
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath || !hasProcFd)("web-hub worktree-diff D6 — real hub, real repos", () => {
  let live: Live;
  let home: string;

  beforeAll(async () => {
    home = hubHome("pwh-wtd-e2e-home-");
    live = await bootLive(spyRunner(), home);
  }, 30_000);

  afterAll(async () => {
    live?.agent.sock.destroy();
    if (live !== undefined) await live.hub.close("d6-done");
    rmSync(home, { recursive: true, force: true });
  }, 20_000);

  it(
    "list grammar: M/A/R/?/nested-untracked/binary on the main worktree; numstat counts; file payloads " +
      "(patch / untracked synth / binary / rename); H4 index stat untouched (§5 D6 row 1)",
    async () => {
      const f = await grammarRepo("pwh-wtd-grammar-");
      await setSessionCwd(live, f.root);

      const indexBefore = await indexStatOf(join(f.root, ".git"));

      const r = await wtFiles(live, f.root);
      expect(r.status).toBe(200);
      const payload = parseWtDiffFileList(bodyJson(r), Buffer.byteLength(r.body));
      expect(payload).not.toBeNull();
      expect(payload!.base).toBe(f.head);
      expect(payload!.truncated).toBe(false);
      const byPath = listEntries(payload!);
      expect(byPath.get("tracked.txt")).toMatchObject({ status: "M", add: 1, del: 1 });
      expect(byPath.get("added.txt")).toMatchObject({ status: "A", add: 1 });
      expect(byPath.get("new.txt")).toMatchObject({ status: "R", orig: "old.txt" });
      expect(byPath.get("bin.bin")).toMatchObject({ status: "M", binary: true });
      expect(byPath.get("top.txt")).toMatchObject({ status: "?" });
      expect(byPath.get("deep/nested/dir/leaf.txt")).toMatchObject({ status: "?" }); // nested untracked
      expect([...byPath.keys()].some((p) => p.endsWith("/"))).toBe(false); // no directory rows (#5)
      expect(byPath.has(".env")).toBe(false); // D14 hidden — see the dedicated case below
      expect(byPath.has("gone.txt")).toBe(false); // deleted at HEAD, not in the changeset
      expect(payload!.total).toBe(payload!.entries.length); // nothing hidden-but-counted

      // file payloads, one per kind
      const patch = await wtFile(live, f.root, f.head, "tracked.txt");
      expect(patch.status).toBe(200);
      const pj = bodyJson(patch);
      expect(pj["kind"]).toBe("patch");
      expect(String(pj["patch"])).toContain("-aaa\n");
      expect(String(pj["patch"])).toContain("+bbb\n");
      expect(pj["untracked"]).toBeUndefined();

      const untracked = await wtFile(live, f.root, f.head, "deep/nested/dir/leaf.txt");
      expect(untracked.status).toBe(200);
      const uj = bodyJson(untracked);
      expect(uj["untracked"]).toBe(true);
      expect(uj["kind"]).toBe("patch");
      expect(String(uj["patch"])).toContain("+leaf"); // synthesized new-file hunk (§3.1.1)

      const binary = await wtFile(live, f.root, f.head, "bin.bin");
      expect(binary.status).toBe(200);
      const bj = bodyJson(binary);
      expect(bj["kind"]).toBe("binary");
      expect(bj["patch"]).toBe("");

      const renamed = await wtFile(live, f.root, f.head, "new.txt", "old.txt");
      expect(renamed.status).toBe(200);
      const rj = bodyJson(renamed);
      // §3.3: a pure (100%) staged rename has zero hunks ⇒ kind "empty" with the rename-only
      // banner rendered UI-side — exactly the file table's rename row
      expect(rj["kind"]).toBe("empty");
      expect(rj["patch"]).toBe("");

      // the linked worktree — its own changes, same HEAD family
      const lr = await wtFiles(live, f.linked);
      expect(lr.status).toBe(200);
      const lp = parseWtDiffFileList(bodyJson(lr), Buffer.byteLength(lr.body));
      const lby = listEntries(lp!);
      expect(lby.get("linked-mod.txt")).toMatchObject({ status: "?" }); // untracked in the linked tree
      expect(lby.get("linked-new.txt")).toMatchObject({ status: "?" });
      // membership really is repo-scoped: the MAIN worktree's dirt is invisible from linked
      expect(lby.has("tracked.txt")).toBe(false);

      // H4: the whole exchange left .git/index byte-identical
      expect(await indexStatOf(join(f.root, ".git"))).toBe(indexBefore);
    },
    45_000,
  );

  it("`.env` modified ⇒ hidden from the list, excluded from total; a direct file ask ⇒ 403 denylist (§5 D6 row 2)", async () => {
    const root = await repo("pwh-wtd-env-");
    await commitFile(root, "ok.txt", "ok\n", "base");
    await commitFile(root, ".env", "SECRET=1\n", "creds");
    await writeFile(join(root, ".env"), "SECRET=2\n"); // the modification
    await writeFile(join(root, "ok.txt"), "ok too\n");
    await setSessionCwd(live, root);

    const r = await wtFiles(live, root);
    expect(r.status).toBe(200);
    const payload = parseWtDiffFileList(bodyJson(r), Buffer.byteLength(r.body));
    const byPath = listEntries(payload!);
    expect(byPath.has(".env")).toBe(false); // never listed
    expect(payload!.total).toBe(1); // never counted (D14: "已解析且未隐藏")
    expect(byPath.get("ok.txt")).toMatchObject({ status: "M" });

    const head = payload!.base;
    const direct = await wtFile(live, root, head, ".env");
    expect(direct.status).toBe(403);
    expect(direct.body).toBe('{"error":"E_WTDIFF_DENIED","reason":"denylist"}'); // literal, before any git
  }, 30_000);

  it("arbitrary-history read (#1): an older commit's OID as base ⇒ 409 base; current HEAD + a historically-deleted path ⇒ 409 entry (§5 D6 row 3)", async () => {
    const f = await grammarRepo("pwh-wtd-hist-");
    await setSessionCwd(live, f.root);

    // an EARLIER commit's oid is a well-formed base — it must still be refused
    const stale = await wtFile(live, f.root, f.older, "tracked.txt");
    expect(stale.status).toBe(409);
    expect(stale.body).toBe('{"error":"E_STALE_CTX","reason":"base"}');

    // gone.txt existed at HEAD~1 and was deleted — current HEAD + that path is not in the
    // changeset, and the entry check refuses it without revealing why (zero oracle, §2.8)
    const deleted = await wtFile(live, f.root, f.head, "gone.txt");
    expect(deleted.status).toBe(409);
    expect(deleted.body).toBe('{"error":"E_STALE_CTX","reason":"entry"}');

    // control: the same fixture answers 200 for a live entry — the 409s are semantic, not wiring
    const ok = await wtFile(live, f.root, f.head, "tracked.txt");
    expect(ok.status).toBe(200);
  }, 30_000);

  it("non-member directories ⇒ 403 not-worktree: a plain dir, and ANOTHER repo's worktree (§5 D6 row 5 / W6)", async () => {
    const f = await grammarRepo("pwh-wtd-member-");
    await setSessionCwd(live, f.root);

    const plain = join(home, "plain-dir");
    mkdirSync(plain, { recursive: true });
    const r1 = await wtFiles(live, plain);
    expect(r1.status).toBe(403);
    expect(r1.body).toBe('{"error":"E_WTDIFF_DENIED","reason":"not-worktree"}');

    // a REAL worktree of a DIFFERENT repo — real rows exist, just not for this session's repo
    const other = await repo("pwh-wtd-other-");
    await commitFile(other, "o.txt", "o\n", "base");
    const otherWt = `${other}-wt`;
    git(other, ["worktree", "add", "-q", "-b", "victim", otherWt]);
    const r2 = await wtFiles(live, otherWt);
    expect(r2.status).toBe(403);
    expect(r2.body).toBe('{"error":"E_WTDIFF_DENIED","reason":"not-worktree"}');
  }, 30_000);

  it("pinned fds never leak: after the requests above, no fd of this process points into any temp root (§5 D6 / R8)", async () => {
    // every completed request's ⑬ finally must have closed its three pins (+ any untracked
    // handle) — a leaked pin would show as an open fd into one of the temp roots
    expect(fdsIntoTempRoots("self")).toEqual([]);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// B — §2.6.3 endpoint-layer driver scenarios (H1)
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath || !hasProcFd)(
  "web-hub worktree-diff D6 — driver neutralization at the endpoint (§2.6.3, H1)",
  () => {
    let live: Live;
    let home: string;
    let spy: RunnerSpy;

    beforeAll(async () => {
      home = hubHome("pwh-wtd-drv-home-");
      spy = spyRunner();
      live = await bootLive(spy, home);
    }, 30_000);

    afterAll(async () => {
      live?.agent.sock.destroy();
      if (live !== undefined) await live.hub.close("d6-drv-done");
      rmSync(home, { recursive: true, force: true });
    }, 20_000);

    /** armed repo + session + a fresh marker driver; the endpoint ask runs files (and optionally
     *  file) while the optional window hook rewrites config/attributes between Cc and C2. */
    async function armed(
      prefix: string,
      name: string,
    ): Promise<{ root: string; file: string; drv: { script: string; markerFile: string } }> {
      const root = await repo(prefix);
      await commitFile(root, "tracked.txt", "aaa\n", "base");
      const drv = await markerDriver(`${prefix}drv-`, name);
      await rehashTouch(join(root, "tracked.txt"), "zzz\n"); // same size (4B), different content
      await setSessionCwd(live, root);
      return { root, file: join(root, "tracked.txt"), drv };
    }

    it("T1: committed .gitattributes + config injected after the scan — L1 keeps the filter unexecuted (marker 0); L3 sees the config move and discards (503 attr-changed)", async () => {
      const { root, drv } = await armed("pwh-wtd-t1-", "p");
      await writeFile(join(root, ".gitattributes"), "*.txt filter=p\n");
      git(root, ["add", ".gitattributes"]);
      git(root, ["commit", "-qm", "attrs"]);
      const hook = async (): Promise<void> => {
        git(root, ["config", "filter.p.clean", drv.script]); // the window injection
      };
      spy.hooks.beforeC2 = hook;
      try {
        const r = await wtFiles(live, root);
        // L3 fail-closed (§2.6.2 #3): the injected config moved the driver set ⇒ the result is
        // discarded — 503 attr-changed, never a list computed under the injected config
        expect(r.status).toBe(503);
        expect(r.body).toBe('{"error":"E_BUSY","reason":"attr-changed"}');
        // marker 0 despite C2 having really run: L1 (empty-tree attr source) disconnected the
        // committed .gitattributes from the path⇒driver mapping — the injected command has
        // nothing to be invoked through (constructor-layer control: git-wtdiff T1)
        expect(await markerCount(drv.markerFile)).toBe(0);
      } finally {
        spy.hooks.beforeC2 = undefined;
      }
    }, 30_000);

    it("T2: info/attributes + late config — the name was visible at scan time, so L2's unconditional blanking covers the injected command (200, marker 0, L3 not even needed)", async () => {
      const { root, drv } = await armed("pwh-wtd-t2-", "q");
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, ".git", "info", "attributes"), "*.txt filter=q\n"); // visible at scan time (names), config not
      const hook = async (): Promise<void> => {
        git(root, ["config", "filter.q.clean", drv.script]); // the command appears only now
      };
      spy.hooks.beforeC2 = hook;
      try {
        const r = await wtFiles(live, root);
        // q was in the scan-time union (info/attributes names) ⇒ the injected COMMAND changes
        // nothing the attrSig covers — no L3 trip, the request completes normally (§2.6.2: “为任
        // 何已被引用或已被配置的名字新增/修改命令”不再能引发执行). info/attributes is NOT
        // covered by L1, so this C2 really ran with the q mapping live and the injected command
        // in place — marker 0 can only come from L2 blanking q on the command line.
        expect(r.status).toBe(200);
        expect(await markerCount(drv.markerFile)).toBe(0);
        // the injection was armed: L1-without-L2 (git-wtdiff T2's constructor-layer control) runs
        // the filter in the same window — the endpoint result above is the neutralization working
      } finally {
        spy.hooks.beforeC2 = undefined;
      }
    }, 30_000);

    it("T3: macro attribute lines are extracted and neutralized (200, marker 0)", async () => {
      const { root, drv } = await armed("pwh-wtd-t3-", "r");
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, ".git", "info", "attributes"), "[attr]m filter=r\n*.txt m\n");
      git(root, ["config", "filter.r.clean", drv.script]);
      const r = await wtFiles(live, root);
      expect(r.status).toBe(200);
      expect(await markerCount(drv.markerFile)).toBe(0);
    }, 30_000);

    it("T4: global core.attributesFile + global config — attributesFile=/dev/null kills it (200, marker 0)", async () => {
      const { root, drv } = await armed("pwh-wtd-t4-", "s");
      const fakeHome = tempDir("pwh-wtd-t4-home-");
      await writeFile(join(fakeHome, "global-attrs"), "*.txt filter=s\n");
      await writeFile(
        join(fakeHome, ".gitconfig"),
        `[core]\n\tattributesFile = ${JSON.stringify(join(fakeHome, "global-attrs"))}\n[filter "s"]\n\tclean = ${JSON.stringify(drv.script)}\n`,
      );
      const originalHome = process.env.HOME;
      process.env.HOME = fakeHome; // minimal env inherits HOME at spawn time (§2.7)
      try {
        const r = await wtFiles(live, root);
        expect(r.status).toBe(200);
        expect(await markerCount(drv.markerFile)).toBe(0);
      } finally {
        process.env.HOME = originalHome;
      }
    }, 30_000);

    it("T5: filter.lfs full set + committed filter=lfs — neutralized, entry marked filtered, file ask 409 entry (200, marker 0)", async () => {
      const { root, drv } = await armed("pwh-wtd-t5-", "lfs");
      await writeFile(join(root, ".gitattributes"), "*.txt filter=lfs\n");
      git(root, ["add", ".gitattributes"]);
      git(root, ["commit", "-qm", "attrs"]);
      git(root, ["config", "filter.lfs.clean", drv.script]);
      git(root, ["config", "filter.lfs.smudge", drv.script]);
      git(root, ["config", "filter.lfs.process", drv.script]);
      git(root, ["config", "filter.lfs.required", "true"]);
      const r = await wtFiles(live, root);
      expect(r.status).toBe(200); // required=true is blanked too — no 128 "clean filter failed"
      expect(await markerCount(drv.markerFile)).toBe(0);
      const payload = parseWtDiffFileList(bodyJson(r), Buffer.byteLength(r.body));
      const entry = listEntries(payload!).get("tracked.txt");
      expect(entry).toMatchObject({ status: "M", filtered: true }); // Ca marked it via the base tree
      const ask = await wtFile(live, root, payload!.base, "tracked.txt");
      expect(ask.status).toBe(409); // filtered is not requestable (§2.4)
      expect(ask.body).toBe('{"error":"E_STALE_CTX","reason":"entry"}');
    }, 30_000);

    it("T6: textconv / diff.external / host GIT_EXTERNAL_DIFF never run under the frozen argv (200 both endpoints, marker 0)", async () => {
      const { root, drv } = await armed("pwh-wtd-t6-", "ext");
      await writeFile(join(root, ".gitattributes"), "*.txt diff=t\n");
      git(root, ["add", ".gitattributes"]);
      git(root, ["commit", "-qm", "attrs"]);
      git(root, ["config", "diff.t.textconv", drv.script]);
      git(root, ["config", "diff.external", drv.script]);
      const before = await markerCount(drv.markerFile);
      process.env.GIT_EXTERNAL_DIFF = drv.script; // minimal env strips it (§2.7 allowlist)
      try {
        const list = await wtFiles(live, root);
        expect(list.status).toBe(200);
        const payload = parseWtDiffFileList(bodyJson(list), Buffer.byteLength(list.body));
        const ask = await wtFile(live, root, payload!.base, "tracked.txt");
        expect(ask.status).toBe(200);
        expect(bodyJson(ask)["kind"]).toBe("patch");
      } finally {
        delete process.env.GIT_EXTERNAL_DIFF;
      }
      expect(await markerCount(drv.markerFile)).toBe(before); // nothing ran
    }, 30_000);

    it("T7 + H4: post-index-change hook never fires; .git/index stat byte-identical across both endpoints", async () => {
      const root = await repo("pwh-wtd-t7-");
      await commitFile(root, "f.txt", "same length\n", "base");
      const drv = await markerDriver("pwh-wtd-t7-hook-", "post-index-change");
      await writeFile(
        join(root, ".git", "hooks", "post-index-change"),
        `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(drv.markerFile)}\n`,
        { mode: 0o755 },
      );
      await rehashTouch(join(root, "f.txt"), "same LENGT\n"); // same size, distinct mtime, different content
      await setSessionCwd(live, root);
      const before = await indexStatOf(join(root, ".git"));

      const list = await wtFiles(live, root);
      expect(list.status).toBe(200);
      expect(await indexStatOf(join(root, ".git"))).toBe(before);
      const payload = parseWtDiffFileList(bodyJson(list), Buffer.byteLength(list.body));
      const ask = await wtFile(live, root, payload!.base, "f.txt");
      expect(ask.status).toBe(200);
      expect(bodyJson(ask)["kind"]).toBe("patch");
      expect(await indexStatOf(join(root, ".git"))).toBe(before); // H4: unchanged
      expect(await markerCount(drv.markerFile)).toBe(0); // hooksPath=/dev/null
    }, 30_000);

    it("T8: submodule-internal filters are not invoked (--ignore-submodules=all)", async () => {
      const root = await repo("pwh-wtd-t8-");
      await commitFile(root, "top.txt", "top\n", "base");
      const sub = await repo("pwh-wtd-t8-sub-");
      const drv = await markerDriver("pwh-wtd-t8-drv-", "sub");
      await writeFile(join(sub, "inner.txt"), "inner\n");
      await writeFile(join(sub, ".gitattributes"), "*.txt filter=sub\n");
      git(sub, ["add", "."]);
      git(sub, ["commit", "-qm", "attrs"]);
      git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
      git(root, ["commit", "-qm", "submodule"]);
      expect(await markerCount(drv.markerFile)).toBe(0); // the add itself never fired it
      git(join(root, "sub"), ["config", "filter.sub.clean", drv.script]); // arm INSIDE the submodule
      await writeFile(join(root, "top.txt"), "top2\n");
      await setSessionCwd(live, root);
      const before = await markerCount(drv.markerFile);
      const r = await wtFiles(live, root);
      expect(r.status).toBe(200);
      expect(await markerCount(drv.markerFile)).toBe(before); // never entered the submodule
    }, 45_000);

    it("T9: the residual is real — a simultaneous info/attributes + config window injection runs once, L3 sees it: 503 attr-changed, one warn line, no result sent", async () => {
      const { root, drv } = await armed("pwh-wtd-t9-", "z");
      const logFile = live.hub.paths.logFile;
      const logLenBefore = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
      const hook = async (): Promise<void> => {
        // the double-file window: a BRAND-NEW name in info/attributes AND its config command,
        // both landing after Cc/info read (§2.6.2's documented residual)
        await mkdir(join(root, ".git", "info"), { recursive: true });
        await writeFile(join(root, ".git", "info", "attributes"), "*.txt filter=z\n");
        git(root, ["config", "filter.z.clean", drv.script]);
      };
      spy.hooks.beforeC2 = hook;
      try {
        const r = await wtFiles(live, root);
        expect(r.status).toBe(503);
        expect(r.body).toBe('{"error":"E_BUSY","reason":"attr-changed"}'); // L3: discarded, never sent
      } finally {
        spy.hooks.beforeC2 = undefined;
      }
      expect(await markerCount(drv.markerFile)).toBeGreaterThanOrEqual(1); // the residual is REAL (the
      // endpoint's files ask runs C2 AND C3 unneutralized — git-wtdiff T9 pins the constructor-layer
      // count at exactly 1 per command; here at least one execution proves the residual survives)
      const log = readFileSync(logFile, "utf8").slice(logLenBefore);
      expect(log.includes("wtdiff.attr_changed")).toBe(true); // the L3 warn (no path, no driver name)
    }, 30_000);

    it("T10: unsafe names / >16 drivers in info/attributes ⇒ 415 filter-config and C2 never executed", async () => {
      const a = await armed("pwh-wtd-t10a-", "x");
      await mkdir(join(a.root, ".git", "info"), { recursive: true });
      await writeFile(join(a.root, ".git", "info", "attributes"), "*.txt filter=a=b\n");
      const c2Before = live.spy.c2AllCount();
      const r1 = await wtFiles(live, a.root);
      expect(r1.status).toBe(415);
      expect(r1.body).toBe('{"error":"E_WTDIFF_UNSUPPORTED","reason":"filter-config"}');
      expect(live.spy.c2AllCount()).toBe(c2Before); // C2 never spawned

      const b = await armed("pwh-wtd-t10b-", "y");
      await mkdir(join(b.root, ".git", "info"), { recursive: true });
      await writeFile(
        join(b.root, ".git", "info", "attributes"),
        `${Array.from({ length: 17 }, (_, i) => `*.d${i} filter=d${i}`).join("\n")}\n`,
      );
      const r2 = await wtFiles(live, b.root);
      expect(r2.status).toBe(415);
      expect(r2.body).toBe('{"error":"E_WTDIFF_UNSUPPORTED","reason":"filter-config"}');
      expect(live.spy.c2AllCount()).toBe(c2Before); // still never spawned
      expect(await markerCount(a.drv.markerFile)).toBe(0);
      expect(await markerCount(b.drv.markerFile)).toBe(0);
    }, 30_000);

    it("T11: git too old for --attr-source ⇒ 503 git-too-old (never a 415, never a degrade)", async () => {
      const { root } = await armed("pwh-wtd-t11-", "w");
      spy.hooks.fakeGitTooOld = true;
      try {
        const r = await wtFiles(live, root);
        expect(r.status).toBe(503);
        expect(r.body).toBe('{"error":"E_WTDIFF_UNSUPPORTED","reason":"git-too-old"}');
      } finally {
        spy.hooks.fakeGitTooOld = false;
      }
    }, 30_000);

    it("T12: sha256 repositories — the sha256 empty tree, full list + patch", async () => {
      const root = await repo("pwh-wtd-t12-", { objectFormat: "sha256" });
      await commitFile(root, "f.txt", "content\n", "base");
      await writeFile(join(root, "f.txt"), "changed\n");
      await setSessionCwd(live, root);
      const r = await wtFiles(live, root);
      expect(r.status).toBe(200);
      const payload = parseWtDiffFileList(bodyJson(r), Buffer.byteLength(r.body));
      expect(payload!.base).toMatch(/^[0-9a-f]{64}$/);
      const ask = await wtFile(live, root, payload!.base, "f.txt");
      expect(ask.status).toBe(200);
      expect(String(bodyJson(ask)["patch"])).toContain("+changed");
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// D — hub close: in-flight termination, dispose abort propagation, fd close, no git residue
// ---------------------------------------------------------------------------

describe.skipIf(!hasGit || !gitInFixedPath || !hasProcFd)("web-hub worktree-diff D6 — hub close mid-request", () => {
  it("close while C2 is in flight: the request answers 503 E_HUB_RESTARTING, the abort reaches the shared exec signal, pins close, no git child left", async () => {
    const home = hubHome("pwh-wtd-close-home-");
    const spy = spyRunner();
    const live = await bootLive(spy, home);
    try {
      const root = await repo("pwh-wtd-close-");
      await commitFile(root, "f.txt", "content\n", "base");
      await writeFile(join(root, "f.txt"), "modified\n");
      await writeFile(join(root, "g.txt"), "untracked\n");
      await setSessionCwd(live, root);

      // the in-flight fixture: hold the (real) C2 result away from the route, wait for the
      // NEXT full-mode C2 to reach the real runner — the session-settle probe above also ran a
      // (`untracked=no`) C2, so the wait is sequence-based, never the first C2
      const c2Before = spy.c2AllCount();
      spy.hooks.holdC2 = true;
      const pending = wtFiles(live, root, { timeoutMs: 20_000 });
      await waitUntil(() => spy.c2AllCount() > c2Before, 5_000, "held C2 reached the runner");

      const t0 = Date.now();
      await live.hub.close("d6-close-test"); // dispose: closing → abortAll → bounded pin close
      expect(Date.now() - t0).toBeLessThan(10_000); // HUB_CLOSE_DEADLINE_MS

      const r = await pending;
      expect(r.status).toBe(503); // hub-close abort answer, not a hang and not a crash
      expect(r.body).toBe('{"error":"E_HUB_RESTARTING"}');
      expect(spy.c2Signal()?.aborted).toBe(true); // dispose aborted the SHARED EXECUTION

      spy.releaseC2(); // let the held result settle so nothing dangles
      await sleep(200); // the ⑬ finally's boundedClose (1 s each) has had its window

      expect(fdsIntoTempRoots("self")).toEqual([]); // the three pins are closed
      expect(gitChildrenOf(process.pid)).toEqual([]); // no residual hub-spawned git
    } finally {
      live.agent.sock.destroy();
      await live.hub.close("d6-close-cleanup").catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }, 45_000);
});

// ---------------------------------------------------------------------------
// E — a REAL hub child process (jiti, the production fork path): smoke + SIGTERM hygiene
// ---------------------------------------------------------------------------

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const HUB_MAIN = resolve("src/web-hub/hub/main.ts");

const PLAN: LauncherPlan | undefined = (() => {
  if (!IS_LINUX) return undefined;
  if (!existsSync(PI_CLI)) {
    console.log(`web-hub-worktree-diff: SKIP child hub — pi CLI not found at ${PI_CLI}`);
    return undefined;
  }
  const r = resolveJitiCli({ argv1: PI_CLI, override: "" });
  if (!r.ok) {
    console.log(`web-hub-worktree-diff: SKIP child hub — ${r.reason}`);
    return undefined;
  }
  return { execPath: process.execPath, jitiCli: r.jitiCli, argv1: PI_CLI };
})();

describe.skipIf(!hasGit || !gitInFixedPath || !hasProcFd || PLAN === undefined)(
  "web-hub worktree-diff D6 — real hub child process (jiti)",
  () => {
    it("boot → serve a real repo list (linked worktree) → SIGTERM mid-C2 → graceful exit, no orphaned git group leaders, no fd residue", async () => {
      const home = hubHome("pwh-wtd-child-home-");
      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });

      // the repo: HEAD + a large untracked tree so C2 (--untracked-files=all) provably runs long
      // enough to observe a live hub-child git while the SIGTERM lands
      const root = await repo("pwh-wtd-child-");
      await commitFile(root, "f.txt", "content\n", "base");
      const linked = `${root}-linked`;
      git(root, ["worktree", "add", "-q", "-b", "linked", linked]);
      await writeFile(join(linked, "mod.txt"), "mod\n");
      const bulk = join(root, "bulk");
      await mkdir(bulk, { recursive: true });
      for (let i = 0; i < 8_000; i += 1) {
        await writeFile(join(bulk, `f${String(i).padStart(5, "0")}.txt`), "x\n");
      }

      spawnHub(PLAN!, HUB_MAIN, hubConfig({ home, port: 0, preview: "on", idleExitMinutes: 10 }));
      await waitUntil(
        () => {
          try {
            const j = JSON.parse(readFileSync(paths.hubJson, "utf8")) as { pid?: unknown; port?: unknown };
            return typeof j.pid === "number" && typeof j.port === "number" && pidAlive(j.pid);
          } catch {
            return false;
          }
        },
        20_000,
        "child hub up",
      );
      const hubJson = JSON.parse(readFileSync(paths.hubJson, "utf8")) as { pid: number; port: number };
      const hubPid = hubJson.pid;
      let agent: TestClient | undefined;
      try {
        agent = await connectClient(paths.socketPath);
        agent.send(hello({ agentId: { pid: AGENT_PID, nonce: AGENT_NONCE }, cwd: root, caps: [] }));
        await agent.waitFrame((f) => f["t"] === "hello_ack");
        agent.send({ t: "session", sessionId: SESSION, cwd: root, reason: "d6-child", leafId: null, mode: "tui" });
        const cookie = await login(hubJson.port, paths.tokenFile);

        const filesOf = (wt: string): Promise<RawResponse> =>
          rawRequest(hubJson.port, {
            method: "GET",
            path: filesPath(wt),
            headers: { "X-PWH": "1", Cookie: cookie },
            timeoutMs: 20_000,
          });
        await sleep(50); // the hub-side onFrame is synchronous on the socket data event

        // smoke: a REAL hub PROCESS served a REAL repo — the linked worktree lists
        const linkedList = await filesOf(linked);
        expect(linkedList.status).toBe(200);
        const payload = parseWtDiffFileList(bodyJson(linkedList), Buffer.byteLength(linkedList.body));
        expect(listEntries(payload!).get("mod.txt")).toMatchObject({ status: "?" }); // untracked in the linked worktree

        // the close fixture: fire the big-list request, wait for a hub-child git to exist, SIGTERM
        const sinceTicks = readProcStat(process.pid)!.starttimeTicks;
        const pending = filesOf(root); // C2 will scan the 8k-file bulk tree
        await waitUntil(() => gitChildrenOf(hubPid).length > 0, 10_000, "hub-child git observed");
        process.kill(hubPid, "SIGTERM");
        await waitUntil(() => !pidAlive(hubPid), 15_000, "child hub exited after SIGTERM");
        await sleep(500); // killGroup + reaping slack

        // the request terminated (any settle is fine: abort answer or socket death — never a hang)
        const settled = await Promise.race([pending.then(() => true), sleep(2_000).then(() => false)]);
        expect(settled).toBe(true);

        // §5 D6: no residual git — no children of the (dead) hub, no orphaned group leaders born
        // since the test started, and none of the hub's fds left open pointing into the repos
        expect(orphanGitLeadersSince(sinceTicks)).toEqual([]);
        expect(gitChildrenOf(hubPid)).toEqual([]);
        expect(fdsIntoTempRoots(hubPid)).toEqual([]);
      } finally {
        agent?.sock.destroy();
        try {
          process.kill(hubPid, "SIGKILL");
        } catch {
          /* already gone */
        }
        rmSync(home, { recursive: true, force: true });
      }
    }, 90_000);
  },
);

// ---------------------------------------------------------------------------
// cleanup — repos/markers go after every test; hub homes outlive their shared hubs
// ---------------------------------------------------------------------------

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.clear();
});
