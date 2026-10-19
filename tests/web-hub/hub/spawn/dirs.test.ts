/**
 * web-hub-spawn plan §SP3 acceptance — `hub/spawn/dirs.ts` on a REAL tmpdir.
 *
 * Every bullet of plan §SP3's acceptance list is covered here: admit's input normalization
 * (`~` expansion, relative, NUL, over-long, missing, file, chmod 000), symlink escape and
 * segment alignment (`/tmp/r` vs `/tmp/r2`), `scope:"known"` refusing unknown dirs inside
 * roots, every `known()` source-② edge (broken header, >4 KiB first line, 30-day window,
 * deleted target, two session dirs → one realpath), slow-fs `partial:true`, and the cwd pin
 * (#7 hard gate): admit → rename-and-recreate ⇒ `changed`, admit → untouched ⇒ a real child
 * spawned with `cwdArg` lands in the pinned directory.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeSpawnRegistry } from "../../contract/fakes.js";
import type { FakeSpawnRegistry } from "../../contract/fakes.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import {
  ADMIT_REALPATH_BUDGET_MS,
  CREATED_PARTIAL_CACHE_MS,
  KNOWN_CACHE_MS,
  KNOWN_DIR_LIMIT,
  KNOWN_SESSION_MAX_AGE_MS,
  createDirService,
  defaultDirFs,
  parseSessionHeaderHead,
  withinRoot,
} from "../../../../src/web-hub/hub/spawn/dirs.js";
import type { DirFs } from "../../../../src/web-hub/hub/spawn/dirs.js";
import { CREATED_DIRS_TTL_MS, type CreatedDirRecord } from "../../../../src/web-hub/hub/spawn/created-dirs.js";
import type { SpawnRegistryPort } from "../../../../src/web-hub/hub/spawn/ports.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const isLinux = process.platform === "linux";

const root = mkdtempSync(join(tmpdir(), "dirs-test-"));
const home = join(root, "home");
mkdirSync(home);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const realNow = (): number => Date.now();
const dl = (ms = 2_000) => createReqDeadline(realNow, ms);

/** Unique per-test agent dir so every scan sees only the sessions the test itself wrote. */
function freshAgentDir(name: string): string {
  const dir = join(root, "agents", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface SvcOpts {
  agentDir?: string;
  roots?: readonly string[];
  registry?: FakeSpawnRegistry;
  spawnHistory?: () => readonly { cwd: string; updatedAt: number }[];
  now?: () => number;
  fs?: Partial<DirFs>;
  createdDirs?: () => readonly CreatedDirRecord[];
}

function makeSvc(opts: SvcOpts = {}) {
  const registry = opts.registry ?? fakeSpawnRegistry();
  const service = createDirService({
    home,
    agentDir: opts.agentDir ?? freshAgentDir(randomUUID()),
    roots: opts.roots ?? [],
    registry,
    spawnHistory: opts.spawnHistory ?? (() => []),
    now: opts.now ?? realNow,
    fs: opts.fs,
    ...(opts.createdDirs === undefined ? {} : { createdDirs: opts.createdDirs }),
  });
  return { service, registry };
}

function sessionLine(cwd: string): string {
  return JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd });
}

function writeSessionFile(agentDir: string, dirName: string, content: string, mtimeMs?: number): string {
  const dir = join(agentDir, "sessions", dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${randomUUID()}.jsonl`);
  writeFileSync(file, content);
  if (mtimeMs !== undefined) {
    const stamp = new Date(mtimeMs);
    utimesSync(file, stamp, stamp);
  }
  return file;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("parseSessionHeaderHead", () => {
  it("extracts cwd from a complete first line", () => {
    expect(parseSessionHeaderHead(`${sessionLine("/home/x/proj")}\n{"type":"message"}\n`)).toBe("/home/x/proj");
  });

  it("returns undefined when the head contains no newline (first line longer than the 4 KiB probe)", () => {
    // readHead delivers only the first 4 KiB — the \n sits beyond it, so the head has no line.
    const head = `{"pad":"${"x".repeat(5_000)}","cwd":"/a"}\n`.slice(0, 4_096);
    expect(parseSessionHeaderHead(head)).toBeUndefined();
  });

  it("returns undefined for non-JSON / non-object / cwd-less lines", () => {
    expect(parseSessionHeaderHead("this is not json\n")).toBeUndefined();
    expect(parseSessionHeaderHead("42\n")).toBeUndefined();
    expect(parseSessionHeaderHead('{"type":"session"}\n')).toBeUndefined();
    expect(parseSessionHeaderHead('{"cwd":123}\n')).toBeUndefined();
  });

  it("returns undefined for relative / over-long cwd values", () => {
    expect(parseSessionHeaderHead('{"cwd":"relative"}\n')).toBeUndefined();
    expect(parseSessionHeaderHead('{"cwd":""}\n')).toBeUndefined();
    expect(parseSessionHeaderHead(`{"cwd":"/${"a".repeat(4_097)}"}\n`)).toBeUndefined();
  });
});

describe("withinRoot (segment alignment)", () => {
  it("matches the root itself and real children, never a longer sibling", () => {
    expect(withinRoot("/home/a", "/home/a")).toBe(true);
    expect(withinRoot("/home/a", "/home/a/b/c")).toBe(true);
    expect(withinRoot("/home/a", "/home/ab")).toBe(false);
    expect(withinRoot("/home/a", "/home")).toBe(false);
  });

  it("normalizes a trailing slash and treats / as containing everything", () => {
    expect(withinRoot("/home/a/", "/home/a/b")).toBe(true);
    expect(withinRoot("/", "/anything/else")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// admit — step 1: input normalization
// ---------------------------------------------------------------------------

describe("admit: input normalization (arch §4.5 step 1)", () => {
  const { service } = makeSvc();

  it("rejects empty / NUL / over-long / non-absolute inputs", async () => {
    expect(await service.admit("", "known", dl())).toEqual({ ok: false, reason: "empty" });
    expect(await service.admit("/a\0b", "known", dl())).toEqual({ ok: false, reason: "nul" });
    expect(await service.admit(`/${"a".repeat(4_096)}`, "known", dl())).toEqual({ ok: false, reason: "too-long" });
    expect(await service.admit("relative/path", "known", dl())).toEqual({ ok: false, reason: "relative" });
    expect(await service.admit("~other/x", "known", dl())).toEqual({ ok: false, reason: "relative" });
  });

  it("lets exactly-4096-byte paths through the length gate (fails later as not-found)", async () => {
    expect(await service.admit(`/${"a".repeat(4_095)}`, "known", dl())).toEqual({ ok: false, reason: "not-found" });
  });

  it("expands ~ and ~/ against deps.home", async () => {
    const proj = mkdirp(join(home, "proj"));
    const { service } = makeSvc({ roots: [home] });
    const tilde = await service.admit("~", "roots", dl());
    expect(tilde).toEqual({
      ok: true,
      realpath: realpathSync(home),
      dev: statSync(realpathSync(home)).dev,
      ino: statSync(realpathSync(home)).ino,
      known: false,
    });
    expect(await service.admit("~/proj", "roots", dl())).toMatchObject({
      ok: true,
      realpath: realpathSync(proj),
    });
  });
});

// ---------------------------------------------------------------------------
// admit — step 2: filesystem checks
// ---------------------------------------------------------------------------

describe("admit: filesystem checks (arch §4.5 step 2)", () => {
  it("rejects a missing path as not-found", async () => {
    const { service } = makeSvc();
    expect(await service.admit(join(root, "missing"), "roots", dl())).toEqual({ ok: false, reason: "not-found" });
  });

  it("rejects a regular file (and a symlink to one) as not-dir", async () => {
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    const link = join(root, "file-link");
    symlinkSync(file, link);
    const { service } = makeSvc({ roots: [root] });
    expect(await service.admit(file, "roots", dl())).toEqual({ ok: false, reason: "not-dir" });
    expect(await service.admit(link, "roots", dl())).toEqual({ ok: false, reason: "not-dir" });
  });

  it.skipIf(isRoot)("rejects an unreadable/unenterable directory as no-access (chmod 000)", async () => {
    const dir = mkdirp(join(root, "locked"));
    chmodSync(dir, 0o000);
    try {
      const { service } = makeSvc({ roots: [root] });
      expect(await service.admit(dir, "roots", dl())).toEqual({ ok: false, reason: "no-access" });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("maps an exhausted realpath budget to not-found (bounded step)", async () => {
    const { service } = makeSvc({ fs: { realpath: () => new Promise<string>(() => {}) } });
    expect(await service.admit(join(root, "anywhere"), "known", dl(80))).toEqual({ ok: false, reason: "not-found" });
    expect(ADMIT_REALPATH_BUDGET_MS).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// admit — steps 3+4: known membership and roots
// ---------------------------------------------------------------------------

describe("admit: known membership (step 3)", () => {
  it("accepts a registry card's cwd with known:true and admits's dev/ino identity", async () => {
    const regDir = mkdirp(join(root, "reg-dir"));
    const { service, registry } = makeSvc();
    registry.seedAgent("k1", { cwd: regDir });
    const adm = await service.admit(regDir, "known", dl());
    const st = statSync(realpathSync(regDir));
    expect(adm).toEqual({ ok: true, realpath: realpathSync(regDir), dev: st.dev, ino: st.ino, known: true });
  });

  it("accepts a spawn-history cwd, resolving a symlinked raw input to the same realpath", async () => {
    const proj = mkdirp(join(root, "hist-proj"));
    const link = join(root, "hist-link");
    symlinkSync(proj, link);
    const { service } = makeSvc({ spawnHistory: () => [{ cwd: proj, updatedAt: realNow() }] });
    expect(await service.admit(link, "known", dl())).toMatchObject({
      ok: true,
      realpath: realpathSync(proj),
      known: true,
    });
  });
});

describe("admit: roots scope (step 4)", () => {
  const rRoot = mkdirp(join(root, "rt"));
  const sub = mkdirp(join(rRoot, "s"));
  const sibling = mkdirp(join(root, "rt2")); // plan's /tmp/r vs /tmp/r2 segment case

  it("allows a dir under a root with known:false, and the root itself", async () => {
    const { service } = makeSvc({ roots: [rRoot] });
    expect(await service.admit(sub, "roots", dl())).toEqual({
      ok: true,
      realpath: realpathSync(sub),
      dev: statSync(realpathSync(sub)).dev,
      ino: statSync(realpathSync(sub)).ino,
      known: false,
    });
    expect(await service.admit(rRoot, "roots", dl())).toMatchObject({ ok: true, realpath: realpathSync(rRoot) });
  });

  it("refuses the same dirs under scope 'known' (unknown dir inside a root is still unknown)", async () => {
    const { service } = makeSvc({ roots: [rRoot] });
    expect(await service.admit(sub, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("never matches a longer sibling (segment alignment)", async () => {
    const { service } = makeSvc({ roots: [rRoot] });
    expect(await service.admit(sibling, "roots", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("normalizes a trailing slash on the root, expands ~/ roots, and treats '/' as everything", async () => {
    const homeRoot = mkdirp(join(home, "hr"));
    const nested = mkdirp(join(homeRoot, "n"));
    expect(await makeSvc({ roots: [`${rRoot}/`] }).service.admit(sub, "roots", dl())).toMatchObject({ ok: true });
    expect(await makeSvc({ roots: ["~/hr"] }).service.admit(nested, "roots", dl())).toMatchObject({ ok: true });
    expect(await makeSvc({ roots: ["/"] }).service.admit(sibling, "roots", dl())).toMatchObject({ ok: true });
  });

  it("ignores roots that are relative, NUL-bearing, or nonexistent", async () => {
    const svcBad = makeSvc({ roots: ["relative", "/a\0b", join(root, "no-such-root")] });
    expect(await svcBad.service.admit(sub, "roots", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("a symlink inside the root cannot smuggle a dir outside it (realpath'd containment)", async () => {
    const base = mkdirp(join(root, "roots-x"));
    const inside = mkdirp(join(base, "inside"));
    const outside = mkdirp(join(root, "outside-x"));
    symlinkSync(outside, join(inside, "link"));
    const { service } = makeSvc({ roots: [base] });
    expect(await service.admit(join(inside, "link"), "roots", dl())).toEqual({ ok: false, reason: "not-allowed" });
    expect(await service.admit(outside, "roots", dl())).toEqual({ ok: false, reason: "not-allowed" });
    expect(await service.admit(inside, "roots", dl())).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// admit — session-history plan §4.6.1: opts.sessionBacked
// ---------------------------------------------------------------------------

describe("admit: opts.sessionBacked (session-history plan §4.6.1)", () => {
  it("skips the known/roots scan entirely — an unknown dir outside every root is admitted anyway", async () => {
    const dir = mkdirp(join(root, "sess-unknown"));
    const { service } = makeSvc({ roots: [] }); // no roots, no registry/history entries
    const adm = await service.admit(dir, "roots", dl(), { sessionBacked: true });
    expect(adm).toEqual({
      ok: true,
      realpath: realpathSync(dir),
      dev: statSync(realpathSync(dir)).dev,
      ino: statSync(realpathSync(dir)).ino,
      known: true,
    });
  });

  it("rp !== expanded (the literal resolved to a DIFFERENT path) ⇒ moved", async () => {
    const target = mkdirp(join(root, "sess-moved-target"));
    const link = join(root, "sess-moved-link");
    symlinkSync(target, link);
    const { service } = makeSvc();
    const adm = await service.admit(link, "known", dl(), { sessionBacked: true });
    expect(adm).toEqual({ ok: false, reason: "moved" });
  });

  it("still rejects not-found / not-dir / no-access the same as the non-session path (step 2 is shared)", async () => {
    const { service } = makeSvc();
    expect(await service.admit(join(root, "sess-missing"), "known", dl(), { sessionBacked: true })).toEqual({
      ok: false,
      reason: "not-found",
    });
    const file = join(root, "sess-a-file");
    writeFileSync(file, "x");
    expect(await service.admit(file, "known", dl(), { sessionBacked: true })).toEqual({
      ok: false,
      reason: "not-dir",
    });
  });

  it("omitted opts ⇒ the exact pre-feature code path (known/roots scan still runs)", async () => {
    const dir = mkdirp(join(root, "sess-no-opts"));
    const { service } = makeSvc({ roots: [] });
    expect(await service.admit(dir, "roots", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });
});

// ---------------------------------------------------------------------------
// known() — the three sources
// ---------------------------------------------------------------------------

describe("known(): sources and scan behavior", () => {
  it("merges registry cards, session headers and spawn history; labels are basename(realpath)", async () => {
    const agentDir = freshAgentDir("merge");
    const regDir = mkdirp(join(root, "k-reg"));
    const proj = mkdirp(join(root, "k-proj"));
    const histDir = mkdirp(join(root, "k-hist"));
    const mtime = realNow() - 3_600_000;
    writeSessionFile(agentDir, "s1", `${sessionLine(proj)}\n`, mtime);
    const { service, registry } = makeSvc({ agentDir, spawnHistory: () => [{ cwd: histDir, updatedAt: 1 }] });
    registry.seedAgent("k", { cwd: regDir });
    const r = await service.known(dl());
    expect(r.partial).toBe(false);
    const cwds = r.entries.map((e) => e.cwd);
    expect(cwds).toContain(realpathSync(regDir));
    expect(cwds).toContain(realpathSync(proj));
    expect(cwds).toContain(realpathSync(histDir));
    for (const e of r.entries) expect(e.label).toBe(e.cwd.split("/").filter(Boolean).pop());
  });

  it("reads only the NEWEST .jsonl of a session dir", async () => {
    const agentDir = freshAgentDir("newest");
    const oldProj = mkdirp(join(root, "n-old"));
    const newProj = mkdirp(join(root, "n-new"));
    writeSessionFile(agentDir, "s", `${sessionLine(oldProj)}\n`, realNow() - 5 * 86_400_000);
    writeSessionFile(agentDir, "s", `${sessionLine(newProj)}\n`, realNow() - 3_600_000);
    const r = await makeSvc({ agentDir }).service.known(dl());
    expect(r.entries.map((e) => e.cwd)).toEqual([realpathSync(newProj)]);
  });

  it("skips broken headers and first lines longer than the 4 KiB head", async () => {
    const agentDir = freshAgentDir("broken");
    writeSessionFile(agentDir, "s-bad", "this is not json\n", realNow());
    writeSessionFile(agentDir, "s-long", `{"pad":"${"x".repeat(5_000)}","cwd":"/x"}\n`, realNow());
    const r = await makeSvc({ agentDir }).service.known(dl());
    expect(r.entries).toEqual([]);
    expect(r.partial).toBe(false);
  });

  it("applies the 30-day window to the newest session file's mtime", async () => {
    const agentDir = freshAgentDir("window");
    const fresh = mkdirp(join(root, "w-fresh"));
    const stale = mkdirp(join(root, "w-stale"));
    writeSessionFile(agentDir, "s-fresh", `${sessionLine(fresh)}\n`, realNow() - 10 * 86_400_000);
    writeSessionFile(agentDir, "s-stale", `${sessionLine(stale)}\n`, realNow() - 40 * 86_400_000);
    const r = await makeSvc({ agentDir }).service.known(dl());
    expect(r.entries.map((e) => e.cwd)).toEqual([realpathSync(fresh)]);
    expect(KNOWN_SESSION_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("drops headers whose cwd no longer exists, and cards/history for gone dirs", async () => {
    const agentDir = freshAgentDir("gone");
    writeSessionFile(agentDir, "s-ghost", `${sessionLine(join(root, "ghost"))}\n`, realNow());
    const { service, registry } = makeSvc({
      agentDir,
      spawnHistory: () => [{ cwd: join(root, "ghost-hist"), updatedAt: realNow() }],
    });
    registry.seedAgent("g", { cwd: join(root, "ghost-reg") });
    const r = await service.known(dl());
    expect(r.entries).toEqual([]);
  });

  it("dedupes two session dirs whose headers resolve to the same realpath (keeps max at)", async () => {
    const agentDir = freshAgentDir("dedupe");
    const proj = mkdirp(join(root, "d-proj"));
    const link = join(root, "d-link");
    symlinkSync(proj, link);
    const oldAt = realNow() - 2 * 86_400_000;
    const newAt = realNow() - 3_600_000;
    writeSessionFile(agentDir, "s1", `${sessionLine(proj)}\n`, oldAt);
    writeSessionFile(agentDir, "s2", `${sessionLine(link)}\n`, newAt);
    const r = await makeSvc({ agentDir }).service.known(dl());
    // utimesSync's ms can come back as ms-0.001 (usec→ms rounding), so compare rounded.
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.cwd).toBe(realpathSync(proj));
    expect(r.entries[0]!.label).toBe("d-proj");
    expect(Math.round(r.entries[0]!.at)).toBe(newAt);
  });

  it("degrades to sources ①+③ when the sessions root does not exist (no partial)", async () => {
    const agentDir = freshAgentDir("nosessions"); // no sessions/ written
    const regDir = mkdirp(join(root, "ns-reg"));
    const { service, registry } = makeSvc({ agentDir });
    registry.seedAgent("k", { cwd: regDir });
    const r = await service.known(dl());
    expect(r.partial).toBe(false);
    expect(r.entries.map((e) => e.cwd)).toEqual([realpathSync(regDir)]);
  });

  it("survives a throwing registry.list()/spawnHistory() (those sources just vanish)", async () => {
    const dir = mkdirp(join(root, "throw-hist"));
    const badRegistry: Pick<SpawnRegistryPort, "list"> = {
      list: () => {
        throw new Error("boom");
      },
    };
    const service = createDirService({
      home,
      agentDir: freshAgentDir("throw"),
      roots: [],
      registry: badRegistry,
      spawnHistory: () => {
        throw new Error("boom");
      },
      now: realNow,
    });
    expect((await service.known(dl())).entries).toEqual([]);
    expect(await service.admit(dir, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("orders by last activity descending and caps the list at KNOWN_DIR_LIMIT", async () => {
    const agentDir = freshAgentDir("cap");
    const base = mkdirp(join(root, "cap-dirs"));
    const history: Array<{ cwd: string; updatedAt: number }> = [];
    for (let i = 0; i < 60; i++) {
      const dir = mkdirp(join(base, `d${String(i).padStart(2, "0")}`));
      history.push({ cwd: dir, updatedAt: 1_000_000 + i * 1_000 });
    }
    const r = await makeSvc({ agentDir, spawnHistory: () => history }).service.known(dl(5_000));
    expect(r.entries.length).toBe(KNOWN_DIR_LIMIT);
    expect(KNOWN_DIR_LIMIT).toBe(50);
    for (let i = 1; i < r.entries.length; i++) expect(r.entries[i]!.at).toBeLessThanOrEqual(r.entries[i - 1]!.at);
    expect(r.entries[0]!.cwd).toBe(realpathSync(history[59]!.cwd));
    expect(r.entries[49]!.cwd).toBe(realpathSync(history[10]!.cwd));
    // membership follows the cap: the 50th-newest is known, the 51st is not.
    const { service } = makeSvc({ agentDir, spawnHistory: () => history });
    expect(await service.admit(history[10]!.cwd, "known", dl())).toMatchObject({ ok: true });
    expect(await service.admit(history[9]!.cwd, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });
});

// ---------------------------------------------------------------------------
// known() — cache, single-flight, partial
// ---------------------------------------------------------------------------

describe("known(): cache and single-flight", () => {
  function countingFs(): { fs: DirFs; scans: () => number } {
    let sessionsReads = 0;
    return {
      fs: {
        ...defaultDirFs,
        readdirDirs: (dir: string) => {
          sessionsReads++;
          return defaultDirFs.readdirDirs(dir);
        },
      },
      scans: () => sessionsReads,
    };
  }

  it("caches for KNOWN_CACHE_MS (one scan for repeated calls), then rescans", async () => {
    const cf = countingFs();
    let t = realNow();
    const { service } = makeSvc({ agentDir: freshAgentDir("cache"), now: () => t, fs: cf.fs });
    await service.known(dl());
    await service.known(dl());
    expect(cf.scans()).toBe(1);
    t += KNOWN_CACHE_MS - 1_000;
    await service.known(dl());
    expect(cf.scans()).toBe(1);
    t += 2_000; // past the TTL
    await service.known(dl());
    expect(cf.scans()).toBe(2);
  });

  it("collapses concurrent calls into a single scan", async () => {
    const cf = countingFs();
    const delayed: DirFs = {
      ...cf.fs,
      readdirDirs: async (dir: string) => {
        await new Promise((r) => setTimeout(r, 40));
        return cf.fs.readdirDirs(dir);
      },
    };
    const { service } = makeSvc({ agentDir: freshAgentDir("concurrent"), fs: delayed });
    const [a, b] = await Promise.all([service.known(dl()), service.known(dl())]);
    expect(a).toEqual(b);
    expect(cf.scans()).toBe(1);
  });

  it("admit refreshes a stale cache once and then reuses it", async () => {
    const cf = countingFs();
    const agentDir = freshAgentDir("admit-cache");
    const rRoot = mkdirp(join(root, "ac-root"));
    const sub = mkdirp(join(rRoot, "sub"));
    const { service } = makeSvc({ agentDir, roots: [rRoot], fs: cf.fs });
    expect(await service.admit(sub, "roots", dl())).toMatchObject({ ok: true });
    expect(cf.scans()).toBe(1); // admit triggered the scan
    await service.known(dl());
    expect(cf.scans()).toBe(1); // known() reused admit's fresh cache
  });
});

describe("known(): partial scans", () => {
  function delayedDirFs(ms: number): DirFs {
    const d = (): Promise<void> => new Promise((r) => setTimeout(r, ms));
    return {
      ...defaultDirFs,
      readdirDirs: async (dir: string) => {
        await d();
        return defaultDirFs.readdirDirs(dir);
      },
      readdirFiles: async (dir: string) => {
        await d();
        return defaultDirFs.readdirFiles(dir);
      },
      readHead: async (path: string, bytes: number) => {
        await d();
        return defaultDirFs.readHead(path, bytes);
      },
    };
  }

  it("returns partial:true when the scan budget dies mid-scan (slow fs)", async () => {
    const agentDir = freshAgentDir("slow");
    const proj = mkdirp(join(root, "slow-proj"));
    for (let i = 0; i < 6; i++) writeSessionFile(agentDir, `s${i}`, `${sessionLine(proj)}\n`);
    const { service } = makeSvc({ agentDir, fs: delayedDirFs(25) });
    const r = await service.known(dl(120));
    expect(r.partial).toBe(true);
  });

  it("returns an empty partial result when the budget is already exhausted", async () => {
    const agentDir = freshAgentDir("zero");
    writeSessionFile(agentDir, "s", `${sessionLine(join(root, "z"))}\n`);
    const { service } = makeSvc({ agentDir });
    const r = await service.known(dl(0));
    expect(r).toEqual({ entries: [], partial: true });
  });
});

// ---------------------------------------------------------------------------
// pinSync — the pre-fork TOCTOU re-check (#7 hard gate)
// ---------------------------------------------------------------------------

describe("pinSync (arch §4.2/#7)", () => {
  async function admitFresh(dir: string, roots: readonly string[]) {
    const { service } = makeSvc({ roots });
    const adm = await service.admit(dir, "roots", dl());
    if (!adm.ok) throw new Error(`admit failed: ${adm.reason}`);
    return { service, admitted: adm };
  }

  it("pins the admitted inode and hands out /proc/self/fd/<fd>", async () => {
    const dir = mkdirp(join(root, "pin-ok"));
    const { service, admitted } = await admitFresh(dir, [root]);
    const pin = service.pinSync(admitted);
    expect(pin.ok).toBe(true);
    if (!pin.ok) return;
    expect(pin.fd).toBeGreaterThan(2);
    expect(pin.cwdArg).toBe(`/proc/self/fd/${String(pin.fd)}`);
    closeSync(pin.fd);
  });

  it("reports 'changed' when the directory was renamed away and a new one created at the path", async () => {
    const dir = mkdirp(join(root, "pin-change"));
    const { service, admitted } = await admitFresh(dir, [root]);
    renameSync(dir, `${dir}-moved`);
    mkdirSync(dir);
    expect(service.pinSync(admitted)).toEqual({ ok: false, reason: "changed" });
  });

  it("reports 'gone' when the directory was removed, or replaced by a file", async () => {
    const dir = mkdirp(join(root, "pin-gone"));
    const { service, admitted } = await admitFresh(dir, [root]);
    rmSync(dir, { recursive: true });
    expect(service.pinSync(admitted)).toEqual({ ok: false, reason: "gone" });

    const dir2 = mkdirp(join(root, "pin-file"));
    const s2 = await admitFresh(dir2, [root]);
    rmSync(dir2, { recursive: true });
    writeFileSync(dir2, "now a file");
    expect(s2.service.pinSync(s2.admitted)).toEqual({ ok: false, reason: "gone" });
  });

  it("reports 'gone' for a path that never existed", () => {
    const { service } = makeSvc();
    expect(service.pinSync({ realpath: join(root, "never"), dev: 1, ino: 1 })).toEqual({ ok: false, reason: "gone" });
  });

  it.skipIf(isRoot)("reports 'changed' when access was revoked after admit (open fails EACCES)", async () => {
    const dir = mkdirp(join(root, "pin-locked"));
    const { service, admitted } = await admitFresh(dir, [root]);
    chmodSync(dir, 0o000);
    try {
      expect(service.pinSync(admitted)).toEqual({ ok: false, reason: "changed" });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("reports 'changed' on a dev/ino mismatch seen by fstat (injected fs)", async () => {
    const dir = mkdirp(join(root, "pin-injected"));
    const st = statSync(dir);
    const { service } = makeSvc({
      roots: [root],
      fs: {
        fstatSync: () => ({ dev: st.dev, ino: st.ino + 1, mtimeMs: st.mtimeMs, isDirectory: () => true }),
      },
    });
    const adm = await service.admit(dir, "roots", dl());
    if (!adm.ok) throw new Error(`admit failed: ${adm.reason}`);
    expect(service.pinSync(adm)).toEqual({ ok: false, reason: "changed" });
  });

  it.skipIf(!isLinux)("an untouched pin makes a REAL child process start in the pinned directory (V7)", async () => {
    const dir = mkdirp(join(root, "pin-spawn"));
    const { service, admitted } = await admitFresh(dir, [root]);
    const pin = service.pinSync(admitted);
    expect(pin.ok).toBe(true);
    if (!pin.ok) return;
    try {
      const r = spawnSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
        cwd: pin.cwdArg,
        encoding: "utf8",
        timeout: 8_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(realpathSync(dir));
    } finally {
      closeSync(pin.fd); // caller-owned fd, closed after spawn per the contract
    }
  });
});

// ---------------------------------------------------------------------------
// created-dirs plan r2: independent source ④, union authorization + canonical pin
// ---------------------------------------------------------------------------
function createdRecord(path: string, at = realNow()): CreatedDirRecord {
  const st = statSync(path);
  return { path: realpathSync(path), dev: st.dev, ino: st.ino, createdAt: at, by: { listener: "lan" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("source ④: created dirs", () => {
  it("admits a created dir under known with known:true/viaCreated, and resolves roots only once per scan", async () => {
    const base = mkdirp(join(root, "created-known"));
    const dirs = [mkdirp(join(base, "a")), mkdirp(join(base, "b"))];
    let rootReads = 0;
    const { service } = makeSvc({
      roots: [base],
      createdDirs: () => dirs.map((d) => createdRecord(d)),
      fs: {
        realpath: (p) => {
          if (p === base) rootReads++;
          return defaultDirFs.realpath(p);
        },
      },
    });
    const known = await service.known(dl());
    expect(known.entries.map((e) => e.cwd).sort()).toEqual(dirs);
    expect(known.partial).toBe(false);
    expect(rootReads).toBe(1);
    expect(await service.admit(dirs[0]!, "known", dl())).toMatchObject({ ok: true, known: true, viaCreated: true });
    expect(rootReads).toBe(2); // cached source + freshly resolved roots at admit
  });

  it.each(["outside", "empty-roots", "missing-root"])("%s matches nothing in source ④", async (kind) => {
    const dir = mkdirp(join(root, `created-${kind}`));
    const roots = kind === "empty-roots" ? [] : [kind === "missing-root" ? join(root, "root-absent") : home];
    const { service } = makeSvc({ roots, createdDirs: () => [createdRecord(dir)] });
    expect((await service.known(dl())).entries).toEqual([]);
    expect(await service.admit(dir, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });

  it.each([false, true])(
    "scan/cached-admit reject replaced, symlinked, deleted, and root-changed dirs (cached=%s)",
    async (cached) => {
      for (const kind of ["replaced", "symlink", "deleted", "root-changed"]) {
        const base = mkdirp(join(root, `created-${String(cached)}-${kind}`));
        const dir = mkdirp(join(base, "child"));
        const rec = createdRecord(dir);
        const roots = [base];
        const { service } = makeSvc({ roots, createdDirs: () => [rec] });
        if (cached) expect((await service.known(dl())).entries.map((e) => e.cwd)).toEqual([dir]);
        if (kind === "root-changed") roots[0] = home;
        else if (kind === "deleted") rmSync(dir, { recursive: true });
        else {
          renameSync(dir, `${dir}-moved`);
          if (kind === "replaced") mkdirSync(dir);
          else symlinkSync(`${dir}-moved`, dir);
        }
        expect(await service.admit(dir, "known", dl())).toEqual({
          ok: false,
          reason: kind === "deleted" ? "not-found" : "not-allowed",
        });
        if (!cached) expect((await service.known(dl())).entries).toEqual([]);
      }
    },
  );

  it("fresh root resolution rejects a changed root symlink even while source cache is warm", async () => {
    const base = mkdirp(join(root, "created-root-target"));
    const dir = mkdirp(join(base, "child"));
    const link = join(root, "created-root-link");
    symlinkSync(base, link);
    const { service } = makeSvc({ roots: [link], createdDirs: () => [createdRecord(dir)] });
    await service.known(dl());
    rmSync(link);
    symlinkSync(home, link);
    expect(await service.admit(dir, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("50 legacy + 50 created: every legacy stays admitted while display alone is capped at 50", async () => {
    const base = mkdirp(join(root, "created-union"));
    const legacy = Array.from({ length: 50 }, (_, i) => mkdirp(join(base, `legacy-${i}`)));
    const created = Array.from({ length: 50 }, (_, i) => createdRecord(mkdirp(join(base, `new-${i}`))));
    const { service } = makeSvc({
      roots: [base],
      spawnHistory: () => legacy.map((cwd, i) => ({ cwd, updatedAt: i })),
      createdDirs: () => created,
    });
    const known = await service.known(dl(5_000));
    expect(known.entries).toHaveLength(50);
    expect(known.entries.every((e) => e.cwd.includes("/new-"))).toBe(true);
    for (const cwd of legacy) expect(await service.admit(cwd, "known", dl())).toMatchObject({ ok: true, known: true });
    for (const rec of created)
      expect(await service.admit(rec.path, "known", dl())).toMatchObject({ ok: true, known: true, viaCreated: true });
  });

  it("expiry on cached admit is checked without rescan (and does not leak into recent)", async () => {
    const base = mkdirp(join(root, "created-expiry"));
    const dir = mkdirp(join(base, "child"));
    let t = realNow();
    const rec = createdRecord(dir, t - CREATED_DIRS_TTL_MS + 1_000);
    let scans = 0;
    const { service } = makeSvc({
      roots: [base],
      now: () => t,
      createdDirs: () => {
        scans++;
        return [rec];
      },
    });
    expect(await service.admit(dir, "known", dl())).toMatchObject({ ok: true, viaCreated: true });
    t += 1_000;
    expect(await service.admit(dir, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
    expect((await service.known(dl())).entries).toEqual([]);
    expect(scans).toBe(1);
  });

  it("invalidate refreshes only source ④, never legacy cache; concurrent callers share the scan", async () => {
    const base = mkdirp(join(root, "created-invalidate"));
    const a = mkdirp(join(base, "a"));
    const b = mkdirp(join(base, "b"));
    let records = [createdRecord(a)];
    let sourceReads = 0;
    let legacyReads = 0;
    const { service } = makeSvc({
      roots: [base],
      createdDirs: () => {
        sourceReads++;
        return records;
      },
      fs: {
        readdirDirs: async () => {
          legacyReads++;
          return [];
        },
      },
    });
    const [one, two] = await Promise.all([service.known(dl()), service.known(dl())]);
    expect(one).toEqual(two);
    expect(sourceReads).toBe(1);
    records = [createdRecord(b)];
    expect((await service.known(dl())).entries.map((e) => e.cwd)).toEqual([a]);
    service.invalidate();
    expect((await service.known(dl())).entries.map((e) => e.cwd)).toEqual([b]);
    expect(legacyReads).toBe(1);
    expect(sourceReads).toBe(2);
  });

  it("an invalidated inflight old generation is neither joined nor cached", async () => {
    const base = mkdirp(join(root, "created-generation"));
    const a = mkdirp(join(base, "a"));
    const b = mkdirp(join(base, "b"));
    let records = [createdRecord(a)];
    const gate = deferred<string>();
    const entered = deferred<void>();
    let rootReads = 0;
    let sourceReads = 0;
    let t = realNow();
    const { service } = makeSvc({
      roots: [base],
      now: () => t,
      createdDirs: () => {
        sourceReads++;
        return records;
      },
      fs: {
        realpath: (p) => {
          if (p === base && ++rootReads === 1) {
            entered.resolve();
            return gate.promise;
          }
          return defaultDirFs.realpath(p);
        },
      },
    });
    const old = service.known(dl());
    await entered.promise;
    service.invalidate();
    records = [createdRecord(b)];
    const newer = await service.known(dl()); // busy ⇒ empty partial, not joined to old generation
    expect(newer).toEqual({ entries: [], partial: true });
    gate.resolve(base);
    expect((await old).entries).toEqual([]); // stale scan cannot publish standing either
    expect((await service.known(dl())).entries).toEqual([]); // old completion cannot overwrite newer cache
    t += CREATED_PARTIAL_CACHE_MS;
    expect((await service.known(dl())).entries.map((e) => e.cwd)).toEqual([b]);
    expect(sourceReads).toBe(2); // initial scan and post-partial retry only
  });

  it("one hung root: legacy admits do not wait, retries after 5s never start a second physical ④ op", async () => {
    const base = mkdirp(join(root, "created-zombie"));
    const dir = mkdirp(join(base, "child"));
    const legacy = mkdirp(join(root, "legacy-with-zombie"));
    let t = realNow();
    let active = 0;
    let maxActive = 0;
    let rootReads = 0;
    const { service } = makeSvc({
      roots: [base],
      now: () => t,
      spawnHistory: () => [{ cwd: legacy, updatedAt: t }],
      createdDirs: () => [createdRecord(dir, t)],
      fs: {
        realpath: (p) => {
          if (p !== base) return defaultDirFs.realpath(p);
          rootReads++;
          maxActive = Math.max(maxActive, ++active);
          return new Promise<string>(() => {});
        },
      },
    });
    expect(await service.admit(legacy, "known", dl(100))).toMatchObject({ ok: true, known: true });
    const partial = await service.known(dl(150));
    expect(partial.partial).toBe(true);
    expect(partial.entries.map((e) => e.cwd)).toEqual([legacy]);
    expect(await service.insideRoots(dir, dl())).toBe(false);
    t += CREATED_PARTIAL_CACHE_MS;
    expect((await service.known(dl())).partial).toBe(true);
    expect(await service.admit(dir, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
    expect(rootReads).toBe(1);
    expect(maxActive).toBe(1);
  });

  it("independent budget: a hung legacy scan cannot prevent source ④ from being scanned concurrently", async () => {
    const base = mkdirp(join(root, "created-independent"));
    const dir = mkdirp(join(base, "child"));
    let sourceReads = 0;
    const { service } = makeSvc({
      roots: [base],
      createdDirs: () => {
        sourceReads++;
        return [createdRecord(dir)];
      },
      fs: {
        readdirDirs: () => new Promise<string[]>(() => {}),
      },
    });
    const result = await service.known(dl(80));
    expect(result.partial).toBe(true);
    expect(result.entries.map((e) => e.cwd)).toEqual([dir]);
    expect(sourceReads).toBe(1);
  });

  it("createdDirs absent: exact legacy fs call log, including roots and pin without readlink", async () => {
    const calls: string[] = [];
    const dir = "/allowed/child";
    const st = { dev: 1, ino: 2, mtimeMs: 0, isDirectory: () => true };
    const { service } = makeSvc({
      roots: ["/allowed"],
      fs: {
        realpath: async (p) => {
          calls.push(`realpath:${p}`);
          return p;
        },
        stat: async (p) => {
          calls.push(`stat:${p}`);
          return st;
        },
        access: async (p) => {
          calls.push(`access:${p}`);
        },
        readdirDirs: async () => {
          calls.push("readdirDirs:sessions");
          return [];
        },
        openSync: (p) => {
          calls.push(`open:${p}`);
          return 17;
        },
        fstatSync: (fd) => {
          calls.push(`fstat:${fd}`);
          return st;
        },
        closeSync: (fd) => {
          calls.push(`close:${fd}`);
        },
        readlinkSync: (p) => {
          calls.push(`readlink:${p}`);
          return dir;
        },
      },
    });
    const admitted = await service.admit(dir, "roots", dl());
    expect(admitted).toEqual({ ok: true, realpath: dir, dev: 1, ino: 2, known: false });
    if (!admitted.ok) throw new Error("missing admission");
    expect(service.pinSync(admitted)).toEqual({ ok: true, fd: 17, cwdArg: "/proc/self/fd/17" });
    await service.known(dl());
    expect(calls).toEqual([
      "realpath:/allowed/child",
      "stat:/allowed/child",
      "access:/allowed/child",
      "readdirDirs:sessions",
      "realpath:/allowed",
      "open:/allowed/child",
      "fstat:17",
    ]);
  });
});

describe.skipIf(!isLinux)("pinSync canonical (created-only fresh starts)", () => {
  it.each(["directory", "parent"])(
    "detects %s moved outside roots + symlink back, while legacy pin stays unchanged",
    async (kind) => {
      const base = mkdirp(join(root, `canonical-${kind}`));
      const parent = mkdirp(join(base, "parent"));
      const dir = mkdirp(join(parent, "child"));
      const { service } = makeSvc({ roots: [base], createdDirs: () => [createdRecord(dir)] });
      const admitted = await service.admit(dir, "known", dl());
      if (!admitted.ok) throw new Error("admission failed");
      const moved = join(root, `canonical-${kind}-moved`);
      const src = kind === "parent" ? parent : dir;
      renameSync(src, moved);
      symlinkSync(moved, src);
      expect(service.pinSync(admitted, { canonical: true })).toEqual({ ok: false, reason: "changed" });
      const legacy = service.pinSync(admitted);
      expect(legacy.ok).toBe(true);
      if (legacy.ok) closeSync(legacy.fd);
    },
  );

  it("plain canonical pin succeeds and readlink errors/mismatch close the fd", async () => {
    const dir = mkdirp(join(root, "canonical-plain"));
    const { service } = makeSvc();
    const st = statSync(dir);
    const admitted = { realpath: dir, dev: st.dev, ino: st.ino };
    const pin = service.pinSync(admitted, { canonical: true });
    expect(pin.ok).toBe(true);
    if (pin.ok) closeSync(pin.fd);
    for (const failure of ["throw", "deleted"]) {
      let closed = false;
      const { service: bad } = makeSvc({
        fs: {
          readlinkSync: () => {
            if (failure === "throw") throw new Error("no procfs");
            return `${dir} (deleted)`;
          },
          closeSync: (fd) => {
            closed = true;
            closeSync(fd);
          },
        },
      });
      expect(bad.pinSync(admitted, { canonical: true })).toEqual({ ok: false, reason: "changed" });
      expect(closed).toBe(true);
    }
  });
});

describe("source ④: late completion boundaries", () => {
  it("a timed-out root releases only on physical settle; partial cache retries at 5s", async () => {
    const base = mkdirp(join(root, "created-late-root"));
    const dir = mkdirp(join(base, "child"));
    const gate = deferred<string>();
    let t = realNow();
    let rootReads = 0;
    const { service } = makeSvc({
      roots: [base],
      now: () => t,
      createdDirs: () => [createdRecord(dir, t)],
      fs: {
        realpath: (p) => {
          if (p === base && ++rootReads === 1) return gate.promise;
          return defaultDirFs.realpath(p);
        },
      },
    });
    expect(await service.known(dl(30))).toEqual({ entries: [], partial: true });
    expect(rootReads).toBe(1);
    gate.resolve(base);
    await gate.promise;
    await Promise.resolve();
    expect(await service.known(dl())).toEqual({ entries: [], partial: true });
    t += CREATED_PARTIAL_CACHE_MS;
    const retry = await service.known(dl());
    expect(retry.partial).toBe(false);
    expect(retry.entries.map((e) => e.cwd)).toEqual([dir]);
    expect(rootReads).toBe(2);
  });

  it.each(["expiry", "invalidate"])("%s while fresh roots resolve cannot grant stale cached standing", async (kind) => {
    const base = mkdirp(join(root, `created-admit-${kind}`));
    const dir = mkdirp(join(base, "child"));
    let t = realNow();
    const rec = createdRecord(dir, t - CREATED_DIRS_TTL_MS + 1_000);
    let rootReads = 0;
    const { service } = makeSvc({
      roots: [base],
      now: () => t,
      createdDirs: () => [rec],
      fs: {
        realpath: async (p) => {
          if (p === base && ++rootReads === 2) {
            if (kind === "expiry") t += 1_000;
            else service.invalidate();
          }
          return defaultDirFs.realpath(p);
        },
      },
    });
    await service.known(dl());
    expect(await service.admit(dir, "known", dl())).toEqual({ ok: false, reason: "not-allowed" });
  });
});
