/**
 * wtgraph.files.v1 — `GET /api/worktree-graph/files`: the pure Gf argv/parser/projection, the
 * served-window gate, and the route pipeline over the fake fs + scripted runner (gate before any
 * spawn, denylist, cache, attr-changed discard, error mapping), plus one real-git pass that pins
 * the M/A/D/R + numstat semantics, the first-parent merge rule and the root-commit rule.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { WTDIFF_GIT_PATH, WT_PINNED_PREFIX } from "../../../../src/git/diff.js";
import { createGitRunner } from "../../../../src/git/run.js";
import { WTGRAPH_AUDIT_KEYS } from "../../../../src/web-hub/hub/audit.js";
import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import {
  ServedCommitWindows,
  parseCommitFilesZ,
  projectCommitFiles,
  wtGraphFilesArgs,
} from "../../../../src/web-hub/hub/worktree-graph/commit-files.js";
import { createWorktreeGraphRoutes } from "../../../../src/web-hub/hub/worktree-graph/routes.js";
import {
  WTGRAPH_FILES_MAX,
  parseWtGraphCommitFiles,
  parseWtGraphPayload,
  type WtGraphCommitFiles,
  type WtGraphPayload,
} from "../../../../src/web-hub/protocol/worktree-graph.js";
import {
  AGENT,
  HEAD_SHA1,
  LINKED,
  REPO,
  REPO_GIT,
  SESSION,
  fakeIo,
  fakeRegistry,
  fakeReq,
  fakeRes,
  glStdout,
  grStdout,
  isCcArgv,
  memLog,
  okRun,
  oidOf,
  query,
  repoFixture,
  type RepoFixture,
} from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
const P1 = oidOf(9001);
const NOT_SERVED = oidOf(7777);

const isGfArgv = (argv: readonly string[]): boolean => argv.includes("log") && argv.includes("--no-walk");

// ---------------------------------------------------------------------------
// pure: argv
// ---------------------------------------------------------------------------

describe("wtGraphFilesArgs (Gf argv)", () => {
  it("is pinned, hardened, first-parent, and the oid is the only request value (before `--`)", () => {
    const argv = wtGraphFilesArgs(HEAD_SHA1, "sha1", ["lfs"]);
    expect(argv.slice(0, WT_PINNED_PREFIX.length)).toEqual([...WT_PINNED_PREFIX]);
    for (const flag of [
      "--no-lazy-fetch",
      "--no-replace-objects",
      "--no-walk",
      "--max-count=1",
      "--raw",
      "--numstat",
      "-M",
      "-z",
      "--format=",
      "-O/dev/null",
      "--diff-merges=first-parent",
      "--ignore-submodules=none",
      "--no-textconv",
      "--no-ext-diff",
    ]) {
      expect(argv, flag).toContain(flag);
    }
    expect(argv).toContain("--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(argv).toContain("filter.lfs.smudge=");
    expect(argv).toContain("diff.lfs.textconv=");
    expect(argv).toContain("diff.external=");
    expect(argv).toContain("log.showRoot=true");
    expect(argv).not.toContain("diff-tree"); // diff-tree reads the index + work tree (see module header)
    expect(argv.slice(-2)).toEqual([HEAD_SHA1, "--"]);
  });

  it("throws (fail-closed) on a non-hex / wrong-length oid or an unsafe driver name", () => {
    expect(() => wtGraphFilesArgs("HEAD", "sha1", [])).toThrow();
    expect(() => wtGraphFilesArgs(HEAD_SHA1.toUpperCase(), "sha1", [])).toThrow();
    expect(() => wtGraphFilesArgs(HEAD_SHA1, "sha256", [])).toThrow();
    expect(() => wtGraphFilesArgs(HEAD_SHA1, "sha1", ["a b"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// pure: parser + projection
// ---------------------------------------------------------------------------

const Z = "0".repeat(40);
const raw = (st: string, ...paths: string[]): string => `:100644 100644 ${Z} ${Z} ${st}\0${paths.join("\0")}\0`;

describe("parseCommitFilesZ", () => {
  it("joins raw status with positional numstat: M/A/D/T, R with orig, binary", () => {
    const out =
      raw("M", "src/a.ts") +
      raw("R087", "old name.txt", "new name.txt") +
      raw("A", "bin.png") +
      raw("D", "gone.md") +
      raw("T", "link") +
      "3\t1\tsrc/a.ts\0" +
      "2\t2\t\0old name.txt\0new name.txt\0" +
      "-\t-\tbin.png\0" +
      "0\t9\tgone.md\0" +
      "1\t1\tlink\0";
    expect(parseCommitFilesZ(out, false)).toEqual({
      capped: false,
      entries: [
        { path: "src/a.ts", status: "M", add: 3, del: 1 },
        { path: "new name.txt", orig: "old name.txt", status: "R", add: 2, del: 2 },
        { path: "bin.png", status: "A", binary: true },
        { path: "gone.md", status: "D", add: 0, del: 9 },
        { path: "link", status: "T", add: 1, del: 1 },
      ],
    });
  });

  it("a capped stream drops the partial tail; numstat cut away ⇒ counts absent, never misattributed", () => {
    const out = raw("M", "a") + raw("M", "b") + "5\t5\ta\0" + "7\t7\tb";
    const r = parseCommitFilesZ(out, true);
    expect(r.capped).toBe(true);
    expect(r.entries).toEqual([
      { path: "a", status: "M", add: 5, del: 5 },
      { path: "b", status: "M" },
    ]);
  });

  it("a numstat path mismatch stops attaching (later entries keep no counts)", () => {
    const out = raw("M", "a") + raw("M", "b") + "1\t1\tzzz\0" + "2\t2\tb\0";
    expect(parseCommitFilesZ(out, false).entries).toEqual([
      { path: "a", status: "M" },
      { path: "b", status: "M" },
    ]);
  });

  it("empty output (empty commit / merge identical to parent 1) ⇒ no entries", () => {
    expect(parseCommitFilesZ("", false)).toEqual({ entries: [], capped: false });
  });
});

describe("projectCommitFiles", () => {
  it("denylist hits are hidden AND not counted; output-capped lists are truncated", () => {
    const parsed = parseCommitFilesZ(raw("M", "ok.ts") + raw("M", ".env") + "1\t0\tok.ts\0" + "1\t0\t.env\0", true);
    const p = projectCommitFiles(HEAD_SHA1, parsed, (path) => path === ".env", false);
    expect(p.entries).toEqual([{ path: "ok.ts", status: "M", add: 1, del: 0 }]);
    expect(p.total).toBe(1);
    expect(p.truncated).toBe(true);
    expect(p.limits).toEqual({ files: false, bytes: false, output: true });
    expect(parseWtGraphCommitFiles(p, Buffer.byteLength(JSON.stringify(p)))).toEqual(p);
  });

  it("over WTGRAPH_FILES_MAX ⇒ limits.files; over the byte cap ⇒ tail dropped + limits.bytes, still parser-clean", () => {
    const n = WTGRAPH_FILES_MAX + 5;
    const entries = Array.from({ length: n }, (_, i) => ({ path: `dir/file-${i}.txt`, status: "A" as const }));
    const many = projectCommitFiles(HEAD_SHA1, { entries, capped: false }, () => false, false);
    expect(many.entries).toHaveLength(WTGRAPH_FILES_MAX);
    expect(many.total).toBe(n);
    expect(many.limits.files).toBe(true);
    expect(many.truncated).toBe(true);

    const small = projectCommitFiles(HEAD_SHA1, { entries, capped: false }, () => false, true, 4096);
    const bytes = Buffer.byteLength(JSON.stringify(small));
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(small.limits.bytes).toBe(true);
    expect(small.entries.length).toBeGreaterThan(0);
    expect(small.entries.length).toBeLessThan(WTGRAPH_FILES_MAX);
    expect(small.shallow).toBe(true);
    expect(parseWtGraphCommitFiles(small, bytes)).toEqual(small);
  });
});

describe("ServedCommitWindows", () => {
  it("answers only served oids, per repo key, within the TTL; per-repo + repo LRU bounds hold", () => {
    const w = new ServedCommitWindows({ ttlMs: 1000, perRepoMax: 3, reposMax: 2 });
    w.record("r1", ["a", "b"], 0);
    expect(w.has("r1", "a", 500)).toBe(true);
    expect(w.has("r2", "a", 500)).toBe(false);
    expect(w.has("r1", "a", 1001)).toBe(false);
    w.record("r1", ["c", "d"], 10); // a falls out (per-repo max 3)
    expect(w.has("r1", "a", 20)).toBe(false);
    expect(w.has("r1", "d", 20)).toBe(true);
    w.record("r2", ["x"], 20);
    w.record("r3", ["y"], 20); // r1 evicted (repos max 2)
    expect(w.has("r1", "d", 30)).toBe(false);
    expect(w.has("r3", "y", 30)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// route pipeline (fake fs + scripted runner)
// ---------------------------------------------------------------------------

interface FKit {
  fx: RepoFixture;
  routes: ReturnType<typeof createWorktreeGraphRoutes>;
  log: ReturnType<typeof memLog>;
  graph(): Promise<WtGraphPayload>;
  files(h: string, extra?: Record<string, string>): Promise<{ status: number; body: unknown }>;
  gfCalls(): string[][];
}

function fkit(gfOut: () => string = () => raw("M", "src/a.ts") + "3\t1\tsrc/a.ts\0"): FKit {
  const fx = repoFixture();
  const log = memLog();
  fx.runner.setHandler((call) => {
    const j = call.argv.join(" ");
    if (j.includes("--git-common-dir")) return okRun("/w/repo/.git\n");
    if (j.includes("worktree list --porcelain")) return okRun(fx.porcelain);
    if (call.argv.includes("for-each-ref"))
      return okRun(grStdout([{ type: "commit", oid: HEAD_SHA1, refname: "refs/heads/feat" }]));
    if (call.argv.includes("--date-order"))
      return okRun(
        glStdout([
          { h: HEAD_SHA1, p: [P1], at: 5000 },
          { h: P1, at: 4000 },
        ]),
      );
    if (isCcArgv(call.argv)) return { code: 1, stdout: "", stdoutCapped: false, stderr: "" };
    if (isGfArgv(call.argv)) return okRun(gfOut());
    return { code: 128, stdout: "", stdoutCapped: false, stderr: `unexpected git call: ${j}` };
  });
  const routes = createWorktreeGraphRoutes({
    mode: "on",
    denyCtx: DENY,
    registry: fakeRegistry(REPO),
    run: fx.runner,
    log,
    now: Date.now,
    fs: fx.fs,
  });
  const base = { agentKey: AGENT, sessionId: SESSION, wt: LINKED };
  return {
    fx,
    routes,
    log,
    async graph() {
      const io = fakeIo();
      await routes.handle(fakeReq({ "x-pwh": "1" }), fakeRes(), query(base), io);
      const p = parseWtGraphPayload(io.sent[0]!.body);
      if (p === null) throw new Error(`graph failed: ${JSON.stringify(io.sent[0])}`);
      return p;
    },
    async files(h, extra = {}) {
      const io = fakeIo();
      await routes.handleFiles!(fakeReq({ "x-pwh": "1" }), fakeRes(), query({ ...base, h, ...extra }), io);
      return { status: io.sent[0]!.status, body: io.sent[0]!.body };
    },
    gfCalls: () => fx.runner.calls.filter((c) => isGfArgv(c.argv)).map((c) => c.argv),
  };
}

describe("files route — served-window gate", () => {
  it("an oid never served by a graph answer ⇒ 409 E_STALE_CTX{commit} and NO git-phase spawn", async () => {
    const k = fkit();
    const r = await k.files(HEAD_SHA1);
    expect(r).toEqual({ status: 409, body: { error: "E_STALE_CTX", reason: "commit" } });
    expect(k.fx.runner.calls.some((c) => isCcArgv(c.argv) || isGfArgv(c.argv))).toBe(false);
    await k.graph();
    const r2 = await k.files(NOT_SERVED);
    expect(r2.status).toBe(409);
    expect(k.gfCalls()).toHaveLength(0);
  });

  it("served oid ⇒ 200, strict-parser clean; Gf argv is exactly wtGraphFilesArgs(h)", async () => {
    const k = fkit();
    await k.graph();
    const r = await k.files(HEAD_SHA1);
    expect(r.status).toBe(200);
    const body = parseWtGraphCommitFiles(r.body, Buffer.byteLength(JSON.stringify(r.body)));
    expect(body).toEqual({
      v: 1,
      h: HEAD_SHA1,
      entries: [{ path: "src/a.ts", status: "M", add: 3, del: 1 }],
      total: 1,
      truncated: false,
      limits: { files: false, bytes: false, output: false },
    } satisfies WtGraphCommitFiles);
    expect(k.gfCalls()).toEqual([wtGraphFilesArgs(HEAD_SHA1, "sha1", [])]);
  });

  it("bad parameters ⇒ 400 before anything else (h must be full-length lowercase hex)", async () => {
    const k = fkit();
    for (const h of ["", "HEAD", HEAD_SHA1.slice(0, 39), HEAD_SHA1.toUpperCase(), `${HEAD_SHA1}^`]) {
      expect((await k.files(h)).status, h).toBe(400);
    }
    expect(k.fx.runner.calls).toHaveLength(0);
  });
});

describe("files route — cache, denylist, recheck, errors", () => {
  it("a second request for the same commit is served from the hub cache (no new Gf; Cc still runs)", async () => {
    const k = fkit();
    await k.graph();
    await k.files(HEAD_SHA1);
    const ccBefore = k.fx.runner.calls.filter((c) => isCcArgv(c.argv)).length;
    const r = await k.files(HEAD_SHA1);
    expect(r.status).toBe(200);
    expect(k.gfCalls()).toHaveLength(1);
    expect(k.fx.runner.calls.filter((c) => isCcArgv(c.argv)).length).toBe(ccBefore + 1);
    const audits = k.log.lines.filter((l) => l.msg === "wtgraph").map((l) => l.data as Record<string, unknown>);
    expect(audits.at(-1)).toMatchObject({ phase: "files", ok: true, files: 1, cached: true });
    for (const a of audits)
      for (const key of Object.keys(a))
        expect(key === "audit" || (WTGRAPH_AUDIT_KEYS as readonly string[]).includes(key), key).toBe(true);
  });

  it("denylisted paths are hidden from entries and total", async () => {
    const k = fkit(
      () => raw("M", "ok.ts") + raw("A", ".pi/agent/auth.json") + "1\t1\tok.ts\0" + "2\t0\t.pi/agent/auth.json\0",
    );
    // the fixture repo is not under the deny home, so put the hit through the agent-dir layer
    const routes = createWorktreeGraphRoutes({
      mode: "on",
      denyCtx: denyCtxOf("/home/tester", `${LINKED}/.pi/agent`),
      registry: fakeRegistry(REPO),
      run: k.fx.runner,
      log: k.log,
      now: Date.now,
      fs: k.fx.fs,
    });
    const base = { agentKey: AGENT, sessionId: SESSION, wt: LINKED };
    await routes.handle(fakeReq({ "x-pwh": "1" }), fakeRes(), query(base), fakeIo());
    const io = fakeIo();
    await routes.handleFiles!(fakeReq({ "x-pwh": "1" }), fakeRes(), query({ ...base, h: HEAD_SHA1 }), io);
    const body = io.sent[0]!.body as WtGraphCommitFiles;
    expect(io.sent[0]!.status).toBe(200);
    expect(body.entries.map((e) => e.path)).toEqual(["ok.ts"]);
    expect(body.total).toBe(1);
  });

  it("info/attributes changing during Gf ⇒ 503 E_BUSY{attr-changed}, nothing cached (next request re-runs Gf)", async () => {
    const INFO = `${REPO_GIT}/info/attributes`;
    let mutate = true;
    const k = fkit(() => {
      if (mutate) k.fx.fs.writeFile(INFO, "*.txt -diff\n");
      return raw("M", "a") + "1\t1\ta\0";
    });
    await k.graph();
    const first = await k.files(HEAD_SHA1);
    expect(first).toEqual({ status: 503, body: { error: "E_BUSY", reason: "attr-changed" } });
    mutate = false;
    k.fx.fs.writeFile(INFO, "");
    expect((await k.files(HEAD_SHA1)).status).toBe(200);
    expect(k.gfCalls()).toHaveLength(2);
  });

  it("Gf exit classification: missing-object ⇒ 503, git-failed ⇒ 500; capped output ⇒ 200 with limits.output", async () => {
    let mode: "missing" | "failed" | "capped" = "missing";
    const k = fkit();
    k.fx.runner.setHandler((call) => {
      const j = call.argv.join(" ");
      if (j.includes("--git-common-dir")) return okRun("/w/repo/.git\n");
      if (j.includes("worktree list --porcelain")) return okRun(k.fx.porcelain);
      if (call.argv.includes("for-each-ref"))
        return okRun(grStdout([{ type: "commit", oid: HEAD_SHA1, refname: "refs/heads/feat" }]));
      if (call.argv.includes("--date-order"))
        return okRun(
          glStdout([
            { h: HEAD_SHA1, p: [P1], at: 5000 },
            { h: P1, at: 4000 },
          ]),
        );
      if (isCcArgv(call.argv)) return { code: 1, stdout: "", stdoutCapped: false, stderr: "" };
      if (mode === "missing")
        return { code: 128, stdout: "", stdoutCapped: false, stderr: `fatal: bad object ${HEAD_SHA1}\n` };
      if (mode === "failed") return { code: 128, stdout: "", stdoutCapped: false, stderr: "fatal: something else\n" };
      return {
        code: null,
        stdout: raw("M", "a") + raw("M", "b") + "1\t1\ta\0" + "2\t",
        stdoutCapped: true,
        stderr: "",
        killed: "overflow" as const,
      };
    });
    await k.graph();
    const missing = await k.files(HEAD_SHA1);
    expect(missing.status).toBe(503);
    expect(missing.body).toMatchObject({ error: "E_WTDIFF_UNSUPPORTED" });
    mode = "failed";
    expect(await k.files(P1)).toEqual({ status: 500, body: { error: "E_INTERNAL", reason: "git-failed" } });
    mode = "capped";
    const capped = await k.files(P1);
    expect(capped.status).toBe(200);
    expect(capped.body).toMatchObject({ truncated: true, limits: { output: true }, total: 2 });
  });

  it("dispose: a files request after dispose answers 503 E_HUB_RESTARTING", async () => {
    const k = fkit();
    await k.graph();
    await k.routes.dispose("close", { at: Date.now() + 1000, remaining: () => 1000, expired: () => false });
    expect((await k.files(HEAD_SHA1)).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// real git (pins the semantics the hub promises; Linux + git only)
// ---------------------------------------------------------------------------

const TEST_HOME = mkdtempSync(join(tmpdir(), "pwh-wgf-home-"));
const SAFE_ENV: NodeJS.ProcessEnv = {
  PATH: WTDIFF_GIT_PATH,
  HOME: TEST_HOME,
  XDG_CONFIG_HOME: TEST_HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const hasGit = spawnSync("git", ["--version"], { env: SAFE_ENV, timeout: 5000 }).status === 0;
const realOk = hasGit && process.platform === "linux";
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe.runIf(realOk)("files route — real git", () => {
  it("M/A/D/R + numstat + binary; merge = first parent; root = against the empty tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "pwh-wgf-repo-"));
    roots.push(root);
    let tick = 0;
    const git = (...args: string[]): string => {
      const date = `${1700000000 + tick++} +0000`;
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...SAFE_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      }).trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@e.st");
    git("config", "user.name", "T");
    writeFileSync(join(root, "a.txt"), "1\n2\n3\n");
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0]));
    git("add", ".");
    git("commit", "-qm", "root");
    const rootH = git("rev-parse", "HEAD");
    git("checkout", "-qb", "side");
    writeFileSync(join(root, "side.txt"), "s\n");
    git("add", ".");
    git("commit", "-qm", "side");
    git("checkout", "-q", "main");
    git("mv", "a.txt", "b c.txt");
    writeFileSync(join(root, "n.txt"), "new\nfile\n");
    git("rm", "-q", "bin.dat");
    git("add", ".");
    git("commit", "-qm", "main1");
    const main1 = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-edit", "side");
    const merge = git("rev-parse", "HEAD");

    const log = memLog();
    const routes = createWorktreeGraphRoutes({
      mode: "on",
      denyCtx: DENY,
      registry: fakeRegistry(root),
      run: createGitRunner(),
      log,
      now: Date.now,
    });
    const base = { agentKey: AGENT, sessionId: SESSION, wt: root };
    const gio = fakeIo();
    await routes.handle(fakeReq({ "x-pwh": "1" }), fakeRes(), query(base), gio);
    expect(gio.sent[0]!.status).toBe(200);
    const files = async (h: string): Promise<WtGraphCommitFiles> => {
      const io = fakeIo();
      await routes.handleFiles!(fakeReq({ "x-pwh": "1" }), fakeRes(), query({ ...base, h }), io);
      expect(io.sent[0]!.status, JSON.stringify(io.sent[0]!.body)).toBe(200);
      const b = io.sent[0]!.body;
      const parsed = parseWtGraphCommitFiles(b, Buffer.byteLength(JSON.stringify(b)));
      expect(parsed).not.toBeNull();
      return parsed!;
    };
    expect((await files(main1)).entries).toEqual([
      { path: "b c.txt", orig: "a.txt", status: "R", add: 0, del: 0 },
      { path: "bin.dat", status: "D", binary: true },
      { path: "n.txt", status: "A", add: 2, del: 0 },
    ]);
    // merge commit: ONLY what it brought onto its first parent (side.txt), never main1's changes
    expect((await files(merge)).entries).toEqual([{ path: "side.txt", status: "A", add: 1, del: 0 }]);
    expect((await files(rootH)).entries).toEqual([
      { path: "a.txt", status: "A", add: 3, del: 0 },
      { path: "bin.dat", status: "A", binary: true },
    ]);
    await routes.dispose("close", { at: Date.now() + 1000, remaining: () => 1000, expired: () => false });
  });
});
