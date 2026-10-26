/** P6: real hub/HTTP/socket/git, with only a real-runner observation/hold seam. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { WTDIFF_GIT_PATH } from "../../src/git/diff.js";
import { createGitRunner, type GitRunner } from "../../src/git/run.js";
import { WTGRAPH_AUDIT_KEYS } from "../../src/web-hub/hub/audit.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import type { RegistryView } from "../../src/web-hub/hub/ports.js";
import {
  WTGRAPH_PATH,
  WTGRAPH_MERGED_MAX,
  WTGRAPH_N,
  WTGRAPH_PARENTS_MAX,
  parseWtGraphPayload,
  type WtGraphPayload,
} from "../../src/web-hub/protocol/worktree-graph.js";
import { config, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, rawRequest, type RawResponse } from "../web-hub/http/helpers.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pwh-wg-git-home-"));
const SAFE_ENV: NodeJS.ProcessEnv = {
  PATH: WTDIFF_GIT_PATH,
  HOME: TEST_HOME,
  XDG_CONFIG_HOME: TEST_HOME,
  GIT_CONFIG_GLOBAL: join(TEST_HOME, "unused-gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const hasGit = spawnSync("git", ["--version"], { env: SAFE_ENV, timeout: 5000 }).status === 0;
const hasProcFd = process.platform === "linux" && existsSync("/proc/self/fd");
// a LIVE pid: the hub's 5s registry tick downs a dead-pid agent ("pid-dead") and every later
// request then 404s — a fixed fake pid made slow (loaded) runs fail once a tick elapsed.
const AGENT_PID = process.pid;
const NONCE = "wtgraphe2enonce00";
const AGENT_KEY = `a${AGENT_PID}-${NONCE.slice(0, 6)}`;
const SESSION = "wtgraph-p6-session";
const TOP_KEYS = ["v", "n", "format", "shallow", "empty", "head", "commits", "refs", "wtHeads", "degrade", "complete"];
const COMMIT_KEYS = ["h", "p", "pT", "a", "t", "s"];
const roots = new Set<string>();
const lives = new Set<Live>();
let tick = 0;

function git(cwd: string, args: string[]): string {
  const date = `${1700000000 + tick++} +0000`;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...SAFE_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pwh-wg-p6-"));
  roots.add(dir);
  return dir;
}

async function repo(): Promise<string> {
  const root = await tempDir();
  git(root, ["init", "-q", "-b", "main"]);
  // No detached auto-maintenance/gc after commit (newer git on CI): its transient writes under
  // .git/objects (maintenance.lock, packs) would race the write-proof snapshots taken below.
  git(root, ["config", "maintenance.auto", "false"]);
  git(root, ["config", "gc.auto", "0"]);
  git(root, ["config", "user.name", "P6 Author"]);
  git(root, ["config", "user.email", "p6@example.invalid"]);
  git(root, ["config", "commit.gpgSign", "false"]);
  git(root, ["config", "tag.gpgSign", "false"]);
  return root;
}

async function commit(root: string, name: string): Promise<string> {
  await writeFile(join(root, `${name}.txt`), `${name}\n`);
  git(root, ["add", `${name}.txt`]);
  git(root, ["commit", "-qm", name]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function until(check: () => boolean, label: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`timeout: ${label}`);
    await delay(10);
  }
}

interface Spy {
  run: GitRunner;
  commands: string[][];
  pids: Set<number>;
  openChildren: Set<number>;
  holdLog: boolean;
  held: boolean;
  logSignal: AbortSignal | undefined;
  stripLazyFetch: boolean;
  release(): void;
}

function spyRunner(): Spy {
  const pids = new Set<number>();
  const openChildren = new Set<number>();
  const isolatedSpawn: typeof spawn = ((
    file: string,
    args: readonly string[],
    options?: Parameters<typeof spawn>[2],
  ) => {
    const child = spawn(file, [...args], { ...options, env: { ...options?.env, ...SAFE_ENV } });
    if (child.pid !== undefined) {
      const pid = child.pid;
      pids.add(pid);
      openChildren.add(pid);
      child.once("close", () => openChildren.delete(pid));
    }
    return child;
  }) as typeof spawn;
  const real = createGitRunner({ spawnImpl: isolatedSpawn });
  let release: (() => void) | undefined;
  const spy: Spy = {
    commands: [],
    pids,
    openChildren,
    holdLog: false,
    held: false,
    logSignal: undefined,
    stripLazyFetch: false,
    release: () => release?.(),
    run: async (argv, opts) => {
      spy.commands.push([...argv]);
      const result = await real(
        spy.stripLazyFetch && argv.includes("for-each-ref") ? argv.filter((a) => a !== "--no-lazy-fetch") : argv,
        opts,
      );
      if (spy.holdLog && argv.includes("log")) {
        spy.logSignal = opts.signal;
        // Hold a REAL Gl result at the route boundary. Abort always releases the hold.
        await new Promise<void>((resolve) => {
          const done = (): void => {
            opts.signal?.removeEventListener("abort", done);
            resolve();
          };
          release = done;
          spy.held = true;
          if (opts.signal?.aborted) done();
          else opts.signal?.addEventListener("abort", done, { once: true });
        });
      }
      return result;
    },
  };
  return spy;
}

interface Live {
  hub: RunningHub;
  agent: TestClient;
  cookie: string;
  spy: Spy;
}

async function boot(root: string): Promise<Live> {
  const home = await tempDir();
  const spy = spyRunner();
  let registry: RegistryView | undefined;
  const hub = await startHub(
    config({ home, port: 0, preview: "on" }),
    (deps) => {
      registry = deps.registry;
      return createHttpFrontend(deps);
    },
    {
      uid: process.getuid?.() ?? 0,
      gitRunner: spy.run,
    },
  );
  if ("exists" in hub) throw new Error("fresh hub home unexpectedly locked");
  let agent: TestClient | undefined;
  try {
    agent = await connectClient(hub.paths.socketPath);
    agent.send(hello({ agentId: { pid: AGENT_PID, nonce: NONCE }, cwd: root, caps: [] }));
    const ack = await agent.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["agentKey"]).toBe(AGENT_KEY);
    agent.send({ t: "session", sessionId: SESSION, cwd: root, reason: "p6", leafId: null, mode: "tui" });
    const cookie = await login(hub.httpPort, hub.paths.tokenFile);
    const live = { hub, agent, cookie, spy };
    lives.add(live);
    // Observe the real assembly's registry; the one-way session frame has no ack.
    await until(() => registry?.get(AGENT_KEY)?.session?.sessionId === SESSION, "session registered");
    return live;
  } catch (err) {
    agent?.sock.destroy();
    await hub.close("p6-boot-failed");
    throw err;
  }
}

function request(live: Live, wt: string, extra: Record<string, string> = {}): Promise<RawResponse> {
  const query = new URLSearchParams({ agentKey: AGENT_KEY, sessionId: SESSION, wt, ...extra });
  return rawRequest(live.hub.httpPort, {
    path: `${WTGRAPH_PATH}?${query}`,
    headers: { "X-PWH": "1", Cookie: live.cookie },
    timeoutMs: extra["merged"] === "1" ? 48_000 : 35_000,
  });
}

function payload(response: RawResponse): WtGraphPayload {
  expect(response.status, response.body).toBe(200);
  const raw = JSON.parse(response.body) as WtGraphPayload;
  expect(parseWtGraphPayload(raw)).not.toBeNull();
  // Inspect RAW JSON too: parser output is not evidence of the actual wire key set.
  expect(Object.keys(raw).sort()).toEqual(
    TOP_KEYS.filter((k) => !["head", "empty", "shallow"].includes(k) || Object.hasOwn(raw, k)).sort(),
  );
  for (const c of raw.commits) {
    expect(Object.keys(c).sort()).toEqual(COMMIT_KEYS.filter((k) => k !== "pT" || c.pT === true).sort());
  }
  return raw;
}

function auditRecords(live: Live): Array<Record<string, unknown>> {
  return readFileSync(live.hub.paths.logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["msg"] === "wtgraph")
    .map(({ t: _t, level: _level, pid: _pid, msg: _msg, audit: _audit, ...record }) => record);
}

function repoFds(root: string): string[] {
  const hits: string[] = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      if (target === root || target.startsWith(`${root}/`)) hits.push(`${fd}->${target}`);
    } catch {
      /* concurrent close */
    }
  }
  return hits.sort();
}

async function expectReaped(spy: Spy): Promise<void> {
  await until(() => spy.openChildren.size === 0, "real git children reaped");
  for (const pid of spy.pids) expect(existsSync(`/proc/${pid}`), `git pid ${pid}`).toBe(false);
}

afterEach(async () => {
  for (const live of lives) {
    live.spy.release();
    live.agent.sock.destroy();
    await live.hub.close("p6-cleanup");
    await expectReaped(live.spy);
  }
  lives.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
}, 20_000);

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

describe.skipIf(!hasGit || !hasProcFd)("worktree-graph P6: real hub + temp repos", () => {
  it("date-order agrees with git, including merge, refs, detached HEAD and truncated parents; raw key sets match protocol", async () => {
    const root = await repo();
    const base = await commit(root, "base");
    git(root, ["checkout", "-qb", "feature"]);
    const feature = await commit(root, "feature");
    git(root, ["checkout", "-q", "main"]);
    await commit(root, "main2");
    git(root, ["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    const merge = git(root, ["rev-parse", "HEAD"]).trim();
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    const parents = [merge];
    for (let i = 0; i < 8; i++) parents.push(git(root, ["commit-tree", tree, "-p", base, "-m", `side${i}`]).trim());
    const wide = git(root, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "nine parents"]).trim();
    git(root, ["update-ref", "refs/heads/main", wide]);
    git(root, ["update-ref", "refs/remotes/origin/main", wide]);
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(root, ["tag", "-a", "v-p6", "-m", "tag", feature]);
    const detached = join(await tempDir(), "detached");
    git(root, ["worktree", "add", "-q", "--detach", detached, base]);
    const detachedTip = await commit(detached, "detached");
    const live = await boot(root);
    const response = await request(live, root);
    const graph = payload(response);

    // Independent oracle: known fixture tips, no production argv/parser reuse.
    const oracle = git(root, [
      "--no-replace-objects",
      "log",
      "--date-order",
      "-z",
      `--max-count=${WTGRAPH_N}`,
      "--no-show-signature",
      "--no-use-mailmap",
      "--no-notes",
      "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s",
      wide,
      feature,
      detachedTip,
      "--",
    ])
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const [h, parentText, a, t, s] = record.split("\x1f");
        const p = parentText === "" ? [] : parentText!.split(" ");
        return {
          h,
          p: p.slice(0, WTGRAPH_PARENTS_MAX),
          ...(p.length > WTGRAPH_PARENTS_MAX ? { pT: true } : {}),
          a,
          t: Number(t),
          s,
        };
      });
    expect(graph.commits).toEqual(oracle);
    expect(graph.commits.length).toBeGreaterThan(10);
    const positions = new Map(graph.commits.map((c, i) => [c.h, i]));
    for (const [i, c] of graph.commits.entries()) {
      for (const p of c.p) if (positions.has(p)) expect(positions.get(p)!).toBeGreaterThan(i);
    }
    expect(graph.commits.find((c) => c.h === merge)?.p).toHaveLength(2);
    expect(graph.commits.find((c) => c.h === wide)?.pT).toBe(true);
    expect(graph.head).toEqual({ h: wide, b: "main" });
    expect(graph.wtHeads).toContainEqual({ h: detachedTip, path: detached });
    expect(graph.refs).toEqual(
      expect.arrayContaining([
        { k: "branch", n: "main", h: wide },
        { k: "remote", n: "origin/main", h: wide },
        { k: "remote", n: "origin/HEAD", h: wide, sym: true },
        { k: "tag", n: "v-p6", h: feature },
      ]),
    );
    expect(graph.degrade).toEqual({ parentsTruncated: 1 });
    expect(graph.complete).toBe(false);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    const gr = live.spy.commands.filter((a) => a.includes("for-each-ref"));
    const gl = live.spy.commands.filter((a) => a.includes("log"));
    expect(gr).toHaveLength(1);
    expect(gl).toHaveLength(1);
    for (const argv of [...gr, ...gl]) expect(argv).toContain("--no-lazy-fetch");
    for (const forbidden of ["--all", "--branches", "--remotes", "--tags", "HEAD"])
      expect(gl[0]).not.toContain(forbidden);

    // Cover optional envelope flags and pT; optional fields are never required on every row.
    const shallow = join(await tempDir(), "shallow");
    git(root, ["clone", "-q", "--no-local", "--depth=1", root, shallow]);
    const shallowLive = await boot(shallow);
    const shallowGraph = payload(await request(shallowLive, shallow));
    expect(shallowGraph.shallow).toBe(true);
    expect(shallowGraph.commits).toHaveLength(1);
    expect(shallowGraph.commits[0]?.p).toEqual([]);
    const unborn = await repo();
    const emptyLive = await boot(unborn);
    const emptyGraph = payload(await request(emptyLive, unborn));
    expect(emptyGraph).toMatchObject({ empty: true, complete: true, commits: [], refs: [], wtHeads: [], degrade: {} });
    expect(emptyGraph.head).toBeUndefined();
    expect(emptyLive.spy.commands.some((a) => a.includes("log"))).toBe(false);
    expect([...new Set([graph, shallowGraph, emptyGraph].flatMap(Object.keys))].sort()).toEqual([...TOP_KEYS].sort());
    expect([...new Set(graph.commits.flatMap(Object.keys))].sort()).toEqual([...COMMIT_KEYS].sort());
    await until(() => auditRecords(live).length === 1, "graph audit flushed");
    const records = auditRecords(live);
    expect(records).toHaveLength(1);
    for (const fields of records) {
      expect(Object.keys(fields).every((k) => (WTGRAPH_AUDIT_KEYS as readonly string[]).includes(k))).toBe(true);
      expect(fields).toMatchObject({
        phase: "graph",
        ok: true,
        commits: graph.commits.length,
        refs: graph.refs.length,
        complete: false,
      });
      expect(fields["wtTag"]).toMatch(/^[0-9a-f]{12}$/);
      const text = JSON.stringify(fields);
      for (const privateValue of [root, wide, "P6 Author", "nine parents", "v-p6"])
        expect(text).not.toContain(privateValue);
    }
    await until(() => repoFds(root).length === 0, "completed request pins closed");
  }, 60_000);

  it("non-member wt is 403 for a plain directory and another repository", async () => {
    const root = await repo();
    await commit(root, "base");
    const live = await boot(root);
    const other = await repo();
    await commit(other, "other");
    for (const wt of [await tempDir(), other]) {
      const response = await request(live, wt);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "E_WTDIFF_DENIED", reason: "not-worktree" });
    }
    expect(live.spy.commands.some((a) => a.includes("for-each-ref") || a.includes("log"))).toBe(false);
  }, 30_000);

  it("hub close aborts an in-flight real Gl, closes its pins and leaves no git processes", async () => {
    const root = await repo();
    await commit(root, "base");
    const live = await boot(root);
    live.spy.holdLog = true;
    const outcome = request(live, root).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    await until(() => live.spy.held, "real Gl held at route boundary");
    expect(repoFds(root).length).toBeGreaterThanOrEqual(3);
    expect(live.spy.logSignal?.aborted).toBe(false);
    const started = Date.now();
    await live.hub.close("p6-close");
    expect(Date.now() - started).toBeLessThan(10_000);
    const result = await outcome;
    expect("response" in result).toBe(true);
    if (!("response" in result)) throw result.error;
    expect(result.response.status).toBe(503);
    expect(JSON.parse(result.response.body)).toEqual({ error: "E_HUB_RESTARTING" });
    expect(live.spy.logSignal?.aborted).toBe(true);
    expect(live.spy.pids.size).toBeGreaterThan(0);
    await until(() => repoFds(root).length === 0, "shutdown pins closed");
    expect(repoFds(root)).toEqual([]);
    await expectReaped(live.spy);
  }, 45_000);

  it("K8 partial clone: endpoint control attempts ssh; hardened missing-object is 503 with marker=0 and no writes", async () => {
    const root = await repo();
    const target = await commit(root, "base");
    git(root, ["tag", "-a", "missing-target", "-m", "tag", target]);
    await commit(root, "tip");
    git(root, ["pack-refs", "--all"]);
    const scratch = await tempDir();
    const marker = join(scratch, "ssh-marker");
    const script = join(scratch, "ssh.sh");
    await writeFile(script, `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.promisor", "true"],
      ["remote.origin.url", "ssh://example.invalid/x"],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["core.sshCommand", script],
    ])
      git(root, ["config", key!, value!]);
    await rm(join(root, ".git", "objects", target.slice(0, 2), target.slice(2)));
    const live = await boot(root);
    live.spy.stripLazyFetch = true;
    const control = await request(live, root);
    expect(control.status).toBe(503);
    expect(readFileSync(marker, "utf8").split("\n").filter(Boolean).length).toBeGreaterThan(0);
    await rm(marker);
    live.spy.stripLazyFetch = false;
    const snapshot = (): object => ({
      objects: readdirSync(join(root, ".git", "objects"), { recursive: true }).sort(),
      refs: readFileSync(join(root, ".git", "packed-refs"), "utf8"),
      index: readFileSync(join(root, ".git", "index")),
    });
    const before = snapshot();
    const hardened = await request(live, root);
    expect(hardened.status).toBe(503);
    expect(JSON.parse(hardened.body)).toEqual({ error: "E_WTDIFF_UNSUPPORTED", reason: "missing-object" });
    expect(existsSync(marker)).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(live.spy.commands.filter((a) => a.includes("for-each-ref"))).toHaveLength(2);
    expect(live.spy.commands.some((a) => a.includes("log"))).toBe(false);
    await until(() => repoFds(root).length === 0, "failure pins closed");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// merged-plan r3 §9 (P2): `merged=1` end to end — real hub, real HTTP, real git
// ---------------------------------------------------------------------------

type MergedWire = WtGraphPayload & {
  merged: {
    v: 1;
    base?: string;
    skipped?: string;
    omitted?: number;
    branches: Array<{ n: string; h: string; v: string; k?: number; t?: number; e?: string[]; why?: string; co?: true }>;
  };
};

function mergedPayload(response: RawResponse): MergedWire {
  expect(response.status, response.body).toBe(200);
  const raw = JSON.parse(response.body) as MergedWire;
  expect(parseWtGraphPayload(raw)).not.toBeNull(); // the real strict parser accepts the real wire
  expect(Object.keys(raw)).toContain("merged");
  return raw;
}

/** Independent oracle: the plain (un-hardened) cherry-mark on the same symmetric difference. */
function cherryOracle(root: string, head: string, tip: string): { eq: string[]; plus: string[] } {
  const lines = git(root, ["rev-list", "--cherry-mark", "--right-only", `${head}...${tip}`, "--"])
    .split("\n")
    .filter(Boolean);
  return {
    eq: lines.filter((l) => l.startsWith("=")).map((l) => l.slice(1)),
    plus: lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)),
  };
}

const gmCommands = (live: Live): string[][] => live.spy.commands.filter((a) => a.includes("--cherry-mark"));

describe.skipIf(!hasGit || !hasProcFd)("worktree-graph merged=1: real hub + temp repos (merged-plan P2)", () => {
  it("eq / part / none verdicts equal git's own cherry-mark; plain requests are unchanged; the second request spawns no Gm", async () => {
    const root = await repo();
    await commit(root, "base");
    // eq: one commit, later cherry-picked into main
    git(root, ["checkout", "-qb", "pi-agent-eq"]);
    const eq1 = await commit(root, "eq1");
    // part: two commits, only the first cherry-picked
    git(root, ["checkout", "-q", "main"]);
    git(root, ["checkout", "-qb", "pi-agent-part"]);
    const part1 = await commit(root, "part1");
    const part2 = await commit(root, "part2");
    // none: one commit never merged
    git(root, ["checkout", "-q", "main"]);
    git(root, ["checkout", "-qb", "pi-agent-none"]);
    await commit(root, "none1");
    git(root, ["checkout", "-q", "main"]);
    await commit(root, "main-diverge"); // HEAD must diverge BEFORE the picks (else the oids would coincide)
    git(root, ["cherry-pick", eq1]);
    git(root, ["cherry-pick", part1]);
    git(root, ["branch", "pi-agent-anc", "main~3"]); // an ancestor of HEAD: never a candidate
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const live = await boot(root);

    const plain = await request(live, root);
    const plainGraph = payload(plain);
    const response = await request(live, root, { merged: "1" });
    const graph = mergedPayload(response);
    expect(Object.keys(graph).sort()).toEqual(
      [...TOP_KEYS.filter((k) => Object.hasOwn(plainGraph, k)), "merged"].sort(),
    );
    // the graph itself is byte-for-byte the plain one — `merged` is purely additive
    const { merged, ...rest } = graph;
    expect(rest).toEqual(plainGraph);
    expect(merged.base).toBe(head);
    expect(merged.skipped).toBeUndefined();

    const byName = new Map(merged.branches.map((b) => [b.n, b]));
    expect([...byName.keys()].sort()).toEqual(["pi-agent-eq", "pi-agent-none", "pi-agent-part"]);
    for (const [name, entry] of byName) {
      const o = cherryOracle(root, head, entry.h);
      const t = o.eq.length + o.plus.length;
      expect(entry.t, name).toBe(t);
      expect(entry.k, name).toBe(o.eq.length);
    }
    expect(byName.get("pi-agent-eq")).toMatchObject({ v: "eq", k: 1, t: 1 });
    expect(byName.get("pi-agent-none")).toMatchObject({ v: "none", k: 0, t: 1 });
    expect(byName.get("pi-agent-part")).toMatchObject({ v: "part", k: 1, t: 2, e: [part1] });
    expect(part2).not.toBe(part1);
    // order = window row order (newest first), the same order the commits array has
    const rowOf = new Map(graph.commits.map((c, i) => [c.h, i]));
    const rows = merged.branches.map((b) => rowOf.get(b.h)!);
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);

    // hardening reached the real command line
    expect(gmCommands(live)).toHaveLength(3);
    for (const argv of gmCommands(live)) {
      for (const must of ["--no-lazy-fetch", "--no-replace-objects", "--right-only", "core.bigFileThreshold=512m"])
        expect(argv.join(" ")).toContain(must);
      expect(argv.some((a) => a.startsWith("--attr-source="))).toBe(true);
      expect(argv.join(" ")).toContain("core.hooksPath=/dev/null");
    }

    // second merged request: identical block, ZERO new Gm spawns (verdicts come from the cache)
    const again = mergedPayload(await request(live, root, { merged: "1" }));
    expect(again.merged).toEqual(merged);
    expect(gmCommands(live)).toHaveLength(3);

    await until(() => auditRecords(live).length === 3, "three graph audits flushed");
    const records = auditRecords(live);
    expect(records[0]!["mergedReq"]).toBeUndefined();
    expect(records[1]).toMatchObject({
      ok: true,
      mergedReq: 1,
      mergedCand: 3,
      mergedRun: 3,
      mergedHit: 0,
      mergedUnk: 0,
      mergedSkip: 0,
    });
    expect(records[2]).toMatchObject({ ok: true, mergedReq: 1, mergedCand: 3, mergedRun: 0, mergedHit: 3 });
    for (const r of records) {
      expect(Object.keys(r).every((k) => (WTGRAPH_AUDIT_KEYS as readonly string[]).includes(k))).toBe(true);
      const text = JSON.stringify(r);
      for (const secret of ["pi-agent-eq", "pi-agent-part", head, eq1, part1]) expect(text).not.toContain(secret);
    }
    await until(() => repoFds(root).length === 0, "all pins closed after merged requests");
  }, 90_000);

  it("30 candidate branches ⇒ 24 entries + omitted 6 over the real wire; Gm runs only for the 24 selected", async () => {
    const root = await repo();
    await commit(root, "base");
    for (let i = 0; i < 30; i++) {
      git(root, ["checkout", "-qb", `b${String(i).padStart(2, "0")}`, "main"]);
      await commit(root, `branch-${i}`);
    }
    git(root, ["checkout", "-q", "main"]);
    await commit(root, "main-tip");
    const live = await boot(root);
    const graph = mergedPayload(await request(live, root, { merged: "1" }));
    expect(graph.merged.branches).toHaveLength(WTGRAPH_MERGED_MAX);
    expect(graph.merged.omitted).toBe(6);
    expect(graph.merged.branches.every((b) => b.v === "none")).toBe(true);
    expect(gmCommands(live)).toHaveLength(WTGRAPH_MERGED_MAX);
    await until(() => auditRecords(live).length === 1, "audit flushed");
    expect(auditRecords(live)[0]).toMatchObject({ mergedCand: 24, mergedOmitted: 6, mergedRun: 24 });
    await until(() => repoFds(root).length === 0, "pins closed");
  }, 90_000);

  it("shallow clone ⇒ merged.skipped:'shallow' with base, and no Cc/Gm at all", async () => {
    const root = await repo();
    await commit(root, "base");
    git(root, ["checkout", "-qb", "side"]);
    await commit(root, "side1");
    git(root, ["checkout", "-q", "main"]);
    await commit(root, "main2");
    const shallow = join(await tempDir(), "shallow");
    git(root, ["clone", "-q", "--no-local", "--depth=1", "--no-single-branch", root, shallow]);
    const live = await boot(shallow);
    const graph = mergedPayload(await request(live, shallow, { merged: "1" }));
    expect(graph.shallow).toBe(true);
    expect(graph.merged).toEqual({ v: 1, base: graph.head!.h, skipped: "shallow", branches: [] });
    expect(gmCommands(live)).toHaveLength(0);
    expect(live.spy.commands.some((a) => a.includes("--get-regexp"))).toBe(false);
  }, 60_000);

  it("a missing blob in a partial clone ⇒ that branch is unk:missing-object, ssh marker=0, repository untouched", async () => {
    const root = await repo();
    await writeFile(join(root, "a.txt"), "base\n");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "-qm", "base"]);
    git(root, ["checkout", "-qb", "pi-agent-m"]);
    await writeFile(join(root, "a.txt"), "branch change\n");
    git(root, ["commit", "-qam", "branch edit"]);
    const blob = git(root, ["rev-parse", "pi-agent-m:a.txt"]).trim();
    git(root, ["checkout", "-q", "main"]);
    await writeFile(join(root, "a.txt"), "main change\n"); // same file on both sides ⇒ the full-blob path reads the branch blob
    git(root, ["commit", "-qam", "main edit"]);
    const scratch = await tempDir();
    const marker = join(scratch, "ssh-marker");
    const script = join(scratch, "ssh.sh");
    await writeFile(script, `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.promisor", "true"],
      ["remote.origin.url", "ssh://example.invalid/x"],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["core.sshCommand", script],
    ])
      git(root, ["config", key!, value!]);
    // objects are still loose (no gc ran): physically delete the branch's blob
    await rm(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    // CONTROL: the same symmetric difference WITHOUT --no-lazy-fetch really tries the transport,
    // so marker=0 below is evidence of the hardening and not of a vacuous fixture
    try {
      git(root, ["rev-list", "--cherry-mark", "--right-only", "main...pi-agent-m", "--"]);
    } catch {
      /* the fetch fails by design */
    }
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    const before = readdirSync(join(root, ".git", "objects"), { recursive: true }).sort();
    const live = await boot(root);
    const graph = mergedPayload(await request(live, root, { merged: "1" }));
    expect(graph.merged.branches).toEqual([
      expect.objectContaining({ n: "pi-agent-m", v: "unk", why: "missing-object" }),
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(join(root, ".git", "objects"), { recursive: true }).sort()).toEqual(before); // nothing fetched/written
    await until(() => repoFds(root).length === 0, "pins closed");
  }, 90_000);
});
