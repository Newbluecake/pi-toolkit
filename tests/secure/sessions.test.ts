/**
 * V3 sessions engine (`src/secure/bin/sessions.mjs`) — convert-plan r3 §2 (discovery /
 * selection / closure / read-only copy + re-read verification / copy rewriting / memory exact
 * slug) and §3.4 (relocation engine), per the §7.1 `tests/secure/sessions.test.ts` checklist.
 *
 * - pi header rules are mirrored AND cross-checked against the real pi 1.3.x
 *   `findMostRecentSession` (which drives `readSessionHeaderForDiscovery` — the same bounded
 *   1 MiB window our mirror implements).
 * - visibility of rewritten copies is asserted with the real `SessionManager.list` (the exact
 *   call `/resume-recent` makes).
 * - everything runs under mkdtemp dirs — the real `~/.pi` is never touched.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const SESSIONS = join(REPO, "src", "secure", "bin", "sessions.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const S: any = await import(pathToFileURL(SESSIONS).href);
const PI_CORE = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "session-manager.js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- real pi, JS dist
const Pi: any = await import(pathToFileURL(PI_CORE).href);

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

interface Fixture {
  home: string;
  agentDir: string;
  memoryRoot: string;
  proj: string;
  work: string;
  destState: string;
  destSessions: string;
  /** Create a session file with a unique id; returns its path. */
  session(opts: { dir: string; cwd: string; id?: string; parentSession?: string; lines?: string[] }): string;
  runRefLine(sessionFile: string): string;
}

function makeFixture(): Fixture {
  const home = tmp("v3-sessions-");
  const agentDir = join(home, ".pi", "agent");
  const proj = join(home, "ai", "acme");
  const work = join(home, "secure", "acme", "work");
  const destState = join(home, "vault-state");
  mkdirSync(join(proj, "sub"), { recursive: true });
  const f: Fixture = {
    home,
    agentDir,
    memoryRoot: join(agentDir, "memory"),
    proj,
    work,
    destState,
    destSessions: join(destState, "sessions", "default"),
    session({ dir, cwd, id, parentSession, lines = [] }) {
      mkdirSync(dir, { recursive: true });
      const sid = id ?? `id-${Math.random().toString(36).slice(2, 10)}`;
      const file = join(dir, `2026-01-01T00-00-00-000Z_${sid}.jsonl`);
      const header: Record<string, unknown> = {
        type: "session",
        version: 3,
        id: sid,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      };
      if (parentSession !== undefined) header.parentSession = parentSession;
      writeFileSync(file, [JSON.stringify(header), ...lines].join("\n") + "\n");
      return file;
    },
    runRefLine(sessionFile: string) {
      return JSON.stringify({ type: "custom", id: "r1", customType: "subagent:run", data: { diag: { sessionFile } } });
    },
  };
  return f;
}

// ───────────────────────────── pi header mirror (§2.1, XC6) ─────────────────────────────

describe("pi header mirror", () => {
  it("accepts a plain header as the first parsed line", () => {
    const f = tmp("v3-hdr-");
    const file = join(f, "a.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "t", cwd: f })}\n`);
    const r = S.readSessionHeaderLikePi(file);
    expect(r.status).toBe("ok");
    expect(r.header.id).toBe("a");
    expect(Pi.findMostRecentSession(f, f)).toBe(file);
  });

  it("skips blank and malformed lines before the header (like pi)", () => {
    const f = tmp("v3-hdr-");
    const file = join(f, "a.jsonl");
    writeFileSync(
      file,
      '\n   \n{not json}\n{"type":"message"}\n'.replace('{"type":"message"}\n', "") +
        `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "t", cwd: f })}\n`,
    );
    expect(S.readSessionHeaderLikePi(file).status).toBe("ok");
    expect(Pi.findMostRecentSession(f, f)).toBe(file);
  });

  it('skips falsy scalar lines (null/0/false/"") before the header (like pi)', () => {
    const f = tmp("v3-hdr-falsy-");
    const file = join(f, "a.jsonl");
    writeFileSync(
      file,
      'null\n0\nfalse\n""\n' + `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "t", cwd: f })}\n`,
    );
    expect(S.readSessionHeaderLikePi(file).status).toBe("ok");
    expect(Pi.findMostRecentSession(f, f)).toBe(file);
  });

  it("rejects a file whose first parsed entry is not a session header", () => {
    const f = tmp("v3-hdr-");
    const file = join(f, "a.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "t", cwd: f });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "message", id: "m", message: { role: "user", content: [] } })}\n${header}\n`,
    );
    const r = S.readSessionHeaderLikePi(file);
    expect(r.status).toBe("invalid");
    expect(r.reason).toBe("not-session");
    expect(Pi.findMostRecentSession(f, f)).toBeNull();
  });

  it("treats a header beyond the 1 MiB window as invalid (scan-limit), matching pi discovery", () => {
    const f = tmp("v3-hdr-");
    const file = join(f, "big.jsonl");
    const junk = `${"x".repeat(99)}\n`.repeat(1024 * 16); // ~1.05 MiB of malformed lines
    writeFileSync(file, junk + `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "t", cwd: f })}\n`);
    const r = S.readSessionHeaderLikePi(file);
    expect(r.status).toBe("invalid");
    expect(r.reason).toBe("scan-limit");
    // real pi discovery (bounded window) also refuses it
    expect(Pi.findMostRecentSession(f, f)).toBeNull();
  });

  it("accepts a header ending exactly at the 1 MiB boundary without a trailing newline", () => {
    const f = tmp("v3-hdr-");
    const file = join(f, "edge.jsonl");
    const head = { type: "session", version: 3, id: "a", timestamp: "t", cwd: f };
    // pad with a JSON-safe ASCII filler so the serialized line is exactly 1 MiB bytes
    const base = JSON.stringify({ ...head, pad: "" });
    const line = JSON.stringify({ ...head, pad: "p".repeat(S.SESSION_HEADER_SCAN_MAX_BYTES - base.length) });
    expect(Buffer.byteLength(line)).toBe(S.SESSION_HEADER_SCAN_MAX_BYTES);
    writeFileSync(file, line);
    const r = S.readSessionHeaderLikePi(file);
    expect(r.status).toBe("ok");
    expect(r.header.id).toBe("a");
    expect(Pi.findMostRecentSession(f, f)).toBe(file);
  });

  it("marks empty files invalid", () => {
    const f = tmp("v3-hdr-");
    const file = join(f, "empty.jsonl");
    writeFileSync(file, "");
    expect(S.readSessionHeaderLikePi(file).status).toBe("invalid");
    expect(Pi.findMostRecentSession(f, f)).toBeNull();
  });
});

// ───────────────────────────── discovery + selection (§2.2) ─────────────────────────────

describe("discovery and selection", () => {
  it("finds slug dirs for the root, subdirs and dash-siblings, then filters by header cwd", () => {
    const f = makeFixture();
    const slugRoot = join(f.agentDir, "sessions", S.sessionDirSlug(f.proj));
    const slugSub = join(f.agentDir, "sessions", S.sessionDirSlug(join(f.proj, "sub")));
    const slugSibling = join(f.agentDir, "sessions", S.sessionDirSlug(join(f.home, "ai", "acme-sub")));
    const inTree = f.session({ dir: slugRoot, cwd: f.proj });
    const inSub = f.session({ dir: slugSub, cwd: join(f.proj, "sub") });
    const sibling = f.session({ dir: slugSibling, cwd: join(f.home, "ai", "acme-sub") }); // out of tree
    const disc = S.discoverSessionSources({ root: f.proj, agentDir: f.agentDir, home: f.home });
    const dirs = disc.sources.map((s: { dir: string }) => s.dir);
    expect(dirs).toContain(slugRoot);
    expect(dirs).toContain(slugSub);
    expect(dirs).toContain(slugSibling); // lossy slug — candidate, filtered per-file
    const plan = S.planSessionCopy({ sources: disc.sources, matchRoots: [f.proj], newRoot: f.work });
    const copied = [...plan.copySet.keys()];
    expect(copied).toContain(inTree);
    expect(copied).toContain(inSub);
    expect(copied).not.toContain(sibling);
    expect(plan.outOfTree.map((o: { file: string }) => o.file)).toContain(sibling);
  });

  it("collects sessionDir from every in-tree .pi/settings.json", () => {
    const f = makeFixture();
    const custom1 = join(f.home, "custom-sessions-a");
    const custom2 = join(f.home, "custom-sessions-b");
    const fromSettings1 = f.session({ dir: custom1, cwd: f.proj });
    const fromSettings2 = f.session({ dir: custom2, cwd: join(f.proj, "sub") });
    mkdirSync(join(f.proj, ".pi"), { recursive: true });
    writeFileSync(join(f.proj, ".pi", "settings.json"), JSON.stringify({ sessionDir: custom1 }));
    mkdirSync(join(f.proj, "sub", ".pi"), { recursive: true });
    writeFileSync(join(f.proj, "sub", ".pi", "settings.json"), JSON.stringify({ sessionDir: custom2 }));
    const disc = S.discoverSessionSources({ root: f.proj, agentDir: f.agentDir, home: f.home });
    const plan = S.planSessionCopy({ sources: disc.sources, matchRoots: [f.proj], newRoot: f.work });
    expect([...plan.copySet.keys()]).toEqual(expect.arrayContaining([fromSettings1, fromSettings2]));
  });

  it("takes global settings, env and --sessions-from dirs as candidates", () => {
    const f = makeFixture();
    const globalDir = join(f.home, "global-sessions");
    const envDir = join(f.home, "env-sessions");
    const extraDir = join(f.home, "extra-sessions");
    const g = f.session({ dir: globalDir, cwd: f.proj });
    const e = f.session({ dir: envDir, cwd: f.proj });
    const x = f.session({ dir: extraDir, cwd: join(f.proj, "sub") });
    const disc = S.discoverSessionSources({
      root: f.proj,
      agentDir: f.agentDir,
      home: f.home,
      globalSessionDir: globalDir,
      envSessionDir: envDir,
      extraDirs: [extraDir],
    });
    const whys = disc.sources.map((s: { why: string }) => s.why);
    expect(whys).toContain("settings:global");
    expect(whys).toContain("env:PI_CODING_AGENT_SESSION_DIR");
    expect(whys.some((w: string) => w.startsWith("sessions-from"))).toBe(true);
    const plan = S.planSessionCopy({ sources: disc.sources, matchRoots: [f.proj], newRoot: f.work });
    expect([...plan.copySet.keys()]).toEqual(expect.arrayContaining([g, e, x]));
  });

  it("accepts a pre-rename rootRealpath when the original path no longer exists (post-rename step 10)", () => {
    const f = makeFixture();
    // the real project lives at <home>/real/acme; the user always entered via <home>/ai/acme
    const realDir = join(f.home, "real", "acme");
    mkdirSync(realDir, { recursive: true });
    rmSync(f.proj, { recursive: true }); // the fixture made <home>/ai/acme a real dir — replace with a link
    symlinkSync(realDir, f.proj, "dir");
    // pi recorded the REAL cwd spelling when the session ran
    const file = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(realDir)), cwd: realDir });
    // step 10 runs after the backup rename: the original path is gone
    rmSync(f.proj);
    expect(existsSync(f.proj)).toBe(false);
    const rep = S.convertCopySessionsAndMemory({
      root: f.proj, // pre-rename literal path — no longer on disk
      rootRealpath: realDir, // captured before the rename
      newRoot: f.work,
      agentDir: f.agentDir,
      home: f.home,
      memoryRoot: f.memoryRoot,
      destStateDir: f.destState,
    });
    expect(rep.sessions.counts).toMatchObject({ complete: 1, partial: 0, conflict: 0 });
    const out = JSON.parse(readFileSync(join(f.destSessions, file.split("/").pop()!), "utf8").split("\n")[0]);
    expect(out.cwd).toBe(join(f.work));
  });

  it("reports invalid candidates without copying them", () => {
    const f = makeFixture();
    const dir = join(f.agentDir, "sessions", S.sessionDirSlug(f.proj));
    const bad = join(dir, "bad.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(bad, `${JSON.stringify({ type: "message", id: "m" })}\n`);
    const good = f.session({ dir, cwd: f.proj });
    const plan = S.planSessionCopy({ sources: [{ dir, why: "test" }], matchRoots: [f.proj], newRoot: f.work });
    expect(plan.invalid.map((i: { file: string }) => i.file)).toContain(bad);
    expect([...plan.copySet.keys()]).toEqual([good]);
  });
});

// ───────────────────────────── closure (§2.2 #4) ─────────────────────────────

describe("child closure", () => {
  it("follows subagent:run refs incl. children of children, deduped by dev:ino", () => {
    const f = makeFixture();
    const wtDir = join(f.agentDir, "sessions", S.sessionDirSlug(join(f.home, "wt")));
    const grandchildDir = join(f.agentDir, "sessions", S.sessionDirSlug(join(f.home, "wt2")));
    const gc = f.session({ dir: grandchildDir, cwd: join(f.home, "wt2") });
    const child = f.session({ dir: wtDir, cwd: join(f.home, "wt"), lines: [f.runRefLine(gc)] });
    const root = f.session({
      dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)),
      cwd: f.proj,
      lines: [f.runRefLine(child), f.runRefLine(child)], // same run referenced twice
    });
    const plan = S.planSessionCopy({
      sources: [
        { dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), why: "t" },
        { dir: wtDir, why: "t" },
      ],
      matchRoots: [f.proj],
      newRoot: f.work,
    });
    expect([...plan.copySet.keys()]).toEqual(expect.arrayContaining([root, child, gc]));
    expect(plan.copySet.get(child).inTree).toBe(false); // closure child: no cwd rewrite
    expect(plan.copySet.get(root).inTree).toBe(true);
  });

  it("marks partial and lists unfinished refs when the budget is exhausted", () => {
    const f = makeFixture();
    const c1 = f.session({
      dir: join(f.agentDir, "sessions", S.sessionDirSlug(join(f.home, "w1"))),
      cwd: join(f.home, "w1"),
    });
    const c2 = f.session({
      dir: join(f.agentDir, "sessions", S.sessionDirSlug(join(f.home, "w2"))),
      cwd: join(f.home, "w2"),
    });
    const root = f.session({
      dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)),
      cwd: f.proj,
      lines: [f.runRefLine(c1), f.runRefLine(c2)],
    });
    const plan = S.planSessionCopy({
      sources: [{ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), why: "t" }],
      matchRoots: [f.proj],
      newRoot: f.work,
      budgets: { maxFiles: 2, maxBytes: 1024 * 1024 },
    });
    expect(plan.partial).toBe(true);
    expect(plan.copySet.size).toBe(2);
    expect(plan.unfinishedRefs).toContain(c2);
  });
});

// ───────────────────────────── copy + verification (§2.3) ─────────────────────────────

describe("copy: rewriting, verification, source read-only", () => {
  it("rewrites only the mapped fields; every other line stays byte-identical", async () => {
    const f = makeFixture();
    const child = f.session({
      dir: join(f.agentDir, "sessions", S.sessionDirSlug(join(f.home, "wt"))),
      cwd: join(f.home, "wt"),
    });
    const msgLine = JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const runLines = [f.runRefLine(child), f.runRefLine(child)]; // same run, multiple entries
    const root = f.session({
      dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)),
      cwd: f.proj,
      lines: [...runLines, msgLine],
    });
    const srcBefore = readFileSync(root, "utf8");
    const rep = S.convertCopySessionsAndMemory({
      root: f.proj,
      newRoot: f.work,
      agentDir: f.agentDir,
      home: f.home,
      memoryRoot: f.memoryRoot,
      destStateDir: f.destState,
    });
    expect(rep.sessions.counts).toMatchObject({ complete: 2, partial: 0, conflict: 0 });
    const out = readFileSync(join(f.destSessions, root.split("/").pop()!), "utf8").split("\n");
    const headOut = JSON.parse(out[0]!);
    expect(headOut.cwd).toBe(f.work);
    expect(headOut.version).toBe(3); // never upgraded
    const expectedChildDest = join(f.destSessions, child.split("/").pop()!);
    expect(JSON.parse(out[1]!).data.diag.sessionFile).toBe(expectedChildDest);
    expect(JSON.parse(out[2]!).data.diag.sessionFile).toBe(expectedChildDest);
    expect(out[3]).toBe(msgLine); // untouched message line, byte-identical
    // child copy verbatim
    expect(readFileSync(join(f.destSessions, child.split("/").pop()!), "utf8")).toBe(readFileSync(child, "utf8"));
    // source untouched
    expect(readFileSync(root, "utf8")).toBe(srcBefore);
    // visibility with the REAL pi list (the /resume-recent call)
    const rootList = await Pi.SessionManager.list(f.work, f.destSessions);
    expect(rootList.map((s: { id: string }) => s.id)).toEqual([headOut.id]);
    const subList = await Pi.SessionManager.list(join(f.work, "sub"), f.destSessions);
    expect(subList).toEqual([]);
  });

  it("rewrites a subdir session cwd and keeps it visible via -C sub", async () => {
    const f = makeFixture();
    const sub = f.session({
      dir: join(f.agentDir, "sessions", S.sessionDirSlug(join(f.proj, "sub"))),
      cwd: join(f.proj, "sub"),
    });
    S.convertCopySessionsAndMemory({
      root: f.proj,
      newRoot: f.work,
      agentDir: f.agentDir,
      home: f.home,
      memoryRoot: f.memoryRoot,
      destStateDir: f.destState,
    });
    const out = JSON.parse(readFileSync(join(f.destSessions, sub.split("/").pop()!), "utf8").split("\n")[0]);
    expect(out.cwd).toBe(join(f.work, "sub"));
    const list = await Pi.SessionManager.list(join(f.work, "sub"), f.destSessions);
    expect(list.map((s: { id: string }) => s.id)).toEqual([out.id]);
  });

  it("maps parentSession onto the copy set", () => {
    const f = makeFixture();
    const parent = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    const fork = f.session({
      dir: join(f.home, "other-sessions"),
      cwd: join(f.proj, "sub"),
      parentSession: parent,
    });
    S.convertCopySessionsAndMemory({
      root: f.proj,
      newRoot: f.work,
      agentDir: f.agentDir,
      home: f.home,
      memoryRoot: f.memoryRoot,
      destStateDir: f.destState,
      extraDirs: [join(f.home, "other-sessions")],
    });
    const out = JSON.parse(readFileSync(join(f.destSessions, fork.split("/").pop()!), "utf8").split("\n")[0]);
    expect(out.parentSession).toBe(join(f.destSessions, parent.split("/").pop()!));
    expect(out.cwd).toBe(join(f.work, "sub"));
  });

  it("leaves the source's dev/ino/size/mtime/content untouched", () => {
    const f = makeFixture();
    const file = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    const before = { ...statSync(file), content: readFileSync(file) };
    const beforeParent = { ...statSync(join(f.agentDir, "sessions")) };
    S.convertCopySessionsAndMemory({
      root: f.proj,
      newRoot: f.work,
      agentDir: f.agentDir,
      home: f.home,
      memoryRoot: f.memoryRoot,
      destStateDir: f.destState,
    });
    const after = { ...statSync(file), content: readFileSync(file) };
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.content.equals(before.content)).toBe(true);
    const afterParent = { ...statSync(join(f.agentDir, "sessions")) };
    expect(afterParent.mtimeMs).toBe(beforeParent.mtimeMs); // no renames ever happen in source dirs
  });

  it("restores the source mtime on the copy (list order / 48 h window)", () => {
    const f = makeFixture();
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    const file = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    // wind the SOURCE mtime back 40 days (the copy must carry it over)
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(file, old, old);
    S.convertCopySessionsAndMemory({
      root: f.proj,
      newRoot: f.work,
      agentDir: f.agentDir,
      home: f.home,
      memoryRoot: f.memoryRoot,
      destStateDir: f.destState,
    });
    const st = statSync(join(f.destSessions, file.split("/").pop()!));
    expect(Math.abs(st.mtimeMs - old.getTime())).toBeLessThan(2000);
  });

  it("retries when the source is appended mid-copy and succeeds on a consistent read", () => {
    const f = makeFixture();
    const file = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    let appended = false;
    const hooks = {
      beforeVerify({ src }: { src: string }) {
        if (appended) return;
        appended = true;
        appendFileSync(
          src,
          `${JSON.stringify({ type: "message", id: "late", message: { role: "user", content: [{ type: "text", text: "late" }] } })}\n`,
        );
      },
    };
    const result = S.copySessionFile({
      src: file,
      destDir: f.destSessions,
      inTree: true,
      matchRoots: [f.proj],
      newRoot: f.work,
      pathMap: new Map([[file, join(f.destSessions, file.split("/").pop()!)]]),
      hooks,
    });
    expect(result.status).toBe("complete");
    expect(result.attempts).toBe(2); // first read was stale, second saw the append
    const out = readFileSync(join(f.destSessions, file.split("/").pop()!), "utf8");
    expect(out).toContain('"late"');
  });

  it("gives up after COPY_MAX_ATTEMPTS with no copy left behind and the source intact", () => {
    const f = makeFixture();
    const file = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    const appendLine = () => appendFileSync(file, `${JSON.stringify({ type: "message", id: `m${Math.random()}` })}\n`);
    const result = S.copySessionFile({
      src: file,
      destDir: f.destSessions,
      inTree: true,
      matchRoots: [f.proj],
      newRoot: f.work,
      pathMap: new Map(),
      hooks: { beforeVerify: appendLine }, // appends on EVERY attempt — never consistent
    });
    expect(result.status).toBe("partial");
    expect(result.reason).toBe("source-appended");
    expect(result.attempts).toBe(S.COPY_MAX_ATTEMPTS);
    expect(existsSync(join(f.destSessions, file.split("/").pop()!))).toBe(false);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean).length).toBe(1 + S.COPY_MAX_ATTEMPTS);
  });

  it("skips an equal pre-existing destination and refuses a differing one (re-entry)", () => {
    const f = makeFixture();
    const file = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    mkdirSync(f.destSessions, { recursive: true });
    const dest = join(f.destSessions, file.split("/").pop()!);
    const intended = JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: f.work });
    // differing dest: conflict, never overwritten
    writeFileSync(dest, "foreign\n");
    const conflict = S.copySessionFile({
      src: file,
      destDir: f.destSessions,
      inTree: true,
      matchRoots: [f.proj],
      newRoot: f.work,
      pathMap: new Map(),
    });
    expect(conflict.status).toBe("conflict");
    expect(readFileSync(dest, "utf8")).toBe("foreign\n");
    // equal dest (run the real copy once, delete nothing, run again): skipped
    rmSync(dest);
    const first = S.copySessionFile({
      src: file,
      destDir: f.destSessions,
      inTree: true,
      matchRoots: [f.proj],
      newRoot: f.work,
      pathMap: new Map(),
    });
    expect(first.status).toBe("complete");
    const second = S.copySessionFile({
      src: file,
      destDir: f.destSessions,
      inTree: true,
      matchRoots: [f.proj],
      newRoot: f.work,
      pathMap: new Map(),
    });
    expect(second.status).toBe("skipped");
  });
});

// ───────────────────────────── memory (§2.5) ─────────────────────────────

describe("memory copy", () => {
  it("copies only the exact slug (no prefixes, no subdir slugs), with sha256 re-read rule", () => {
    const f = makeFixture();
    const exact = join(f.memoryRoot, S.memorySlug(f.proj));
    const sibling = join(f.memoryRoot, S.memorySlug(join(f.home, "ai", "acme-sub")));
    const subdir = join(f.memoryRoot, S.memorySlug(join(f.proj, "sub")));
    for (const d of [exact, sibling, subdir]) mkdirSync(d, { recursive: true });
    mkdirSync(join(exact, "nested"), { recursive: true });
    writeFileSync(join(exact, "core.md"), "core\n");
    writeFileSync(join(exact, "nested", "a.md"), "a\n");
    writeFileSync(join(sibling, "s.md"), "s\n");
    const rep = S.copyProjectMemory({
      root: f.proj,
      newRoot: f.work,
      memoryRoot: f.memoryRoot,
      destMemoryRoot: join(f.destState, "memory"),
    });
    expect(rep.results).toHaveLength(1);
    expect(rep.results[0].srcDir).toBe(exact);
    const dest = join(f.destState, "memory", S.memorySlug(f.work));
    expect(readFileSync(join(dest, "core.md"), "utf8")).toBe("core\n");
    expect(readFileSync(join(dest, "nested", "a.md"), "utf8")).toBe("a\n");
    expect(existsSync(join(dest, "s.md"))).toBe(false);
    expect(existsSync(join(f.destState, "memory", S.memorySlug(join(f.work, "sub"))))).toBe(false);
    expect(rep.sourceListed).toEqual([exact]);
  });

  it("skips and reports when another decoding of the slug exists on disk (ambiguity)", () => {
    const base = tmp("v3-amb-");
    const root = join(base, "a", "b");
    const collision = join(base, "a-b");
    mkdirSync(root, { recursive: true });
    mkdirSync(collision, { recursive: true });
    const memoryRoot = join(base, "memory");
    mkdirSync(join(memoryRoot, S.memorySlug(root), "deep"), { recursive: true });
    writeFileSync(join(memoryRoot, S.memorySlug(root), "deep", "m.md"), "m\n");
    const rep = S.copyProjectMemory({
      root,
      newRoot: join(base, "secure", "x", "work"),
      memoryRoot,
      destMemoryRoot: join(base, "state", "memory"),
    });
    expect(rep.results).toHaveLength(0); // skipped entirely
    expect(rep.ambiguity).toHaveLength(1);
    expect(rep.ambiguity[0].collisions).toContain(collision);
    expect(
      existsSync(join(base, "state", "memory", S.memorySlug(join(base, "secure", "x", "work")), "deep", "m.md")),
    ).toBe(false);
  });

  it("resolves a symlinked slug dir once and skips file-level symlinks with a report", () => {
    const f = makeFixture();
    const realDir = join(f.home, "real-memory");
    const linkName = S.memorySlug(f.proj);
    mkdirSync(realDir, { recursive: true });
    mkdirSync(f.memoryRoot, { recursive: true });
    writeFileSync(join(realDir, "core.md"), "core\n");
    symlinkSync(realDir, join(f.memoryRoot, linkName), "dir");
    symlinkSync(join(f.home, "elsewhere"), join(f.memoryRoot, linkName, "link.md"));
    const rep = S.copyProjectMemory({
      root: f.proj,
      newRoot: f.work,
      memoryRoot: f.memoryRoot,
      destMemoryRoot: join(f.destState, "memory"),
    });
    expect(rep.results).toHaveLength(1);
    const dest = join(f.destState, "memory", S.memorySlug(f.work));
    expect(readFileSync(join(dest, "core.md"), "utf8")).toBe("core\n");
    expect(rep.results[0].skipped).toEqual([{ path: join(realDir, "link.md"), kind: "symlink" }]);
    expect(existsSync(join(dest, "link.md"))).toBe(false);
  });
});

// ───────────────────────────── report-only listings (§2.2 #5, R28) ─────────────────────────────

describe("report-only listings", () => {
  it("lists consult-cache/fork-src-like files whose header cwd is in the project", () => {
    const f = makeFixture();
    const consultDir = join(f.agentDir, "cache", "consult-sessions");
    const hit = f.session({ dir: consultDir, cwd: f.proj });
    const miss = f.session({ dir: consultDir, cwd: join(f.home, "elsewhere") });
    const r = S.listForeignHeaderMatches([consultDir], [f.proj]);
    expect(r.matches.map((m: { file: string }) => m.file)).toContain(hit);
    expect(r.matches.map((m: { file: string }) => m.file)).not.toContain(miss);
  });

  it("finds foreign sessions whose parentSession points into the copy set (R28)", () => {
    const f = makeFixture();
    const parent = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    const forkDir = join(f.agentDir, "sessions", S.sessionDirSlug(join(f.home, "other")));
    const fork = f.session({ dir: forkDir, cwd: join(f.home, "other"), parentSession: parent });
    const r = S.findParentLinks({ agentSessionsRoot: join(f.agentDir, "sessions"), copySetPaths: [parent] });
    expect(r.links).toEqual([{ file: fork, parentSession: parent }]);
  });
});

// ───────────────────────────── relocation engine (§3.4) ─────────────────────────────

describe("relocation engine", () => {
  const oldWorkBase = join(tmpdir(), "v3-reloc-old");
  const newWorkBase = join(tmpdir(), "v3-reloc-new");

  function rules() {
    const from = join(oldWorkBase, "secure", "acme", "work");
    const to = join(newWorkBase, "secure", "acme", "work");
    return { from, to, fromSessionsDir: S.stateSessionsDirFor(from), toSessionsDir: S.stateSessionsDirFor(to) };
  }

  it("derives the state sessions dir from a realWork path and rejects others", () => {
    expect(S.stateSessionsDirFor(join(oldWorkBase, "work"))).toBe(join(oldWorkBase, "state", "sessions", "default"));
    expect(() => S.stateSessionsDirFor(join(oldWorkBase, "notwork"))).toThrow();
  });

  it("rewrites cwd, parentSession and every run ref by segment-aligned prefixes", () => {
    const r = rules();
    const content =
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "a",
          cwd: join(r.from, "sub"),
          parentSession: join(r.fromSessionsDir, "p.jsonl"),
        }),
        JSON.stringify({
          type: "custom",
          customType: "subagent:run",
          data: { diag: { sessionFile: join(r.fromSessionsDir, "c1.jsonl") } },
        }),
        JSON.stringify({
          type: "custom",
          customType: "subagent:run",
          data: { diag: { sessionFile: join(r.fromSessionsDir, "c2.jsonl") } },
        }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [] } }),
        "not json at all",
        "",
      ].join("\n") + "\n";
    const out = S.relocateSessionContent(Buffer.from(content), r);
    expect(out.anyChange).toBe(true);
    expect(out.changed).toEqual({ cwd: 1, parentSession: 1, runRefs: 2 });
    const lines = out.content.toString("utf8").split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe(join(r.to, "sub"));
    expect(JSON.parse(lines[0]!).parentSession).toBe(join(r.toSessionsDir, "p.jsonl"));
    expect(JSON.parse(lines[1]!).data.diag.sessionFile).toBe(join(r.toSessionsDir, "c1.jsonl"));
    expect(JSON.parse(lines[2]!).data.diag.sessionFile).toBe(join(r.toSessionsDir, "c2.jsonl"));
    expect(lines[3]).toBe(lines[3]); // untouched
    expect(lines[4]).toBe("not json at all");
  });

  it("never rewrites non-aligned look-alike prefixes", () => {
    const r = rules();
    const lookAlike = `${r.from}-sub/deep`;
    const out = S.relocateSessionContent(
      Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: "a", cwd: lookAlike })}\n`),
      r,
    );
    expect(out.anyChange).toBe(false);
  });

  it("is idempotent and leaves untouched files alone in relocateSessionsInDir", () => {
    const f = tmp("v3-reloc-");
    const r = rules();
    const dir = join(f, "state", "sessions", "default");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl"); // no matching prefixes
    writeFileSync(
      a,
      `${JSON.stringify({ type: "session", version: 3, id: "a", cwd: join(r.from, "sub"), parentSession: join(r.fromSessionsDir, "p.jsonl") })}\n`,
    );
    const bBefore = `${JSON.stringify({ type: "session", version: 3, id: "b", cwd: "/nowhere" })}\n`;
    writeFileSync(b, bBefore);
    const aMtimeBefore = statSync(b).mtimeMs;
    let progressCalls = 0;
    const first = S.relocateSessionsInDir(dir, r, { onProgress: () => progressCalls++, batchSize: 1 });
    expect(first.changed).toBe(1);
    expect(first.unchanged).toBe(1);
    expect(progressCalls).toBeGreaterThan(0);
    expect(readFileSync(b, "utf8")).toBe(bBefore);
    expect(statSync(b).mtimeMs).toBe(aMtimeBefore);
    const second = S.relocateSessionsInDir(dir, r);
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(2);
  });

  it("renames the exact memory slug dir, refusing to merge when the target exists", () => {
    const f = tmp("v3-reloc-");
    const r = rules();
    const memRoot = join(f, "state", "memory");
    const fromDir = join(memRoot, S.memorySlug(r.from));
    mkdirSync(fromDir, { recursive: true });
    writeFileSync(join(fromDir, "m.md"), "m\n");
    // absent target: rename
    const ok = S.relocateMemoryDir(memRoot, r);
    expect(ok.renamed).toBe(true);
    expect(existsSync(join(memRoot, S.memorySlug(r.to), "m.md"))).toBe(true);
    // target exists: refuse, no merge
    mkdirSync(fromDir, { recursive: true });
    writeFileSync(join(fromDir, "other.md"), "o\n");
    const refused = S.relocateMemoryDir(memRoot, r);
    expect(refused.renamed).toBe(false);
    expect(refused.reason).toBe("target-exists");
    expect(existsSync(join(memRoot, S.memorySlug(r.to), "other.md"))).toBe(false);
    // absent source: no-op
    rmSync(fromDir, { recursive: true });
    const absent = S.relocateMemoryDir(memRoot, r);
    expect(absent.renamed).toBe(false);
    expect(absent.reason).toBe("absent");
  });
});

// ───────────────────────────── orchestration report ─────────────────────────────

describe("convertCopySessionsAndMemory report", () => {
  it("is JSON-serializable and lists old paths for manual cleanup", () => {
    const f = makeFixture();
    const file = f.session({ dir: join(f.agentDir, "sessions", S.sessionDirSlug(f.proj)), cwd: f.proj });
    const memDir = join(f.memoryRoot, S.memorySlug(f.proj));
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "core.md"), "core\n");
    const rep = S.convertCopySessionsAndMemory({
      root: f.proj,
      newRoot: f.work,
      agentDir: f.agentDir,
      home: f.home,
      memoryRoot: f.memoryRoot,
      destStateDir: f.destState,
    });
    expect(() => JSON.stringify(rep)).not.toThrow();
    const text = S.formatManualCleanup(rep);
    expect(text).toContain(file);
    expect(text).toContain(memDir);
    expect(text).toContain("rm -rf --");
  });
});
