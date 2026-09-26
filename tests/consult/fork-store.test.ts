import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  mkdirSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForkConsistency,
  consultSessionDir,
  FORK_TTL_MS,
  forkExpertSession,
  forkMainSessionSnapshot,
  readHeaderCwd,
  removeForkFile,
  resolveForkCwd,
  sweepForkDir,
  type SourceStatSignature,
} from "../../src/consult/fork-store.js";

/**
 * consult plan §9 T-6 (package B): the handwritten streaming fork, exercised
 * against real pi `SessionManager` files in temp dirs. F2's core assertion is
 * the sha256 of the source never changing; the fork must be a file pi itself
 * can open (`SessionManager.open`) with the exact header contract forkFrom
 * produced: new id, parentSession = resolved source, cwd = two-level pick.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "consult-fork-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A real expert session: pi-created header + real appended entries, in a private dir.
 * pi buffers entries until the first assistant message arrives (`_persist`'s
 * hasAssistant gate), so the fixture appends one — that is what makes the
 * header + everything before it actually hit the disk. */
function realExpertSession(label: string): { file: string; cwd: string; entries: number } {
  const cwd = tempDir();
  const srcDir = join(cwd, "sessions");
  const mgr = SessionManager.create(cwd, srcDir);
  mgr.appendMessage({ role: "user", content: [{ type: "text", text: `expert task ${label}` }] });
  mgr.appendCustomEntry("subagent:run", { label, done: true });
  mgr.appendMessage({ role: "assistant", content: [{ type: "text", text: "expert answer" }] });
  mgr.appendCustomMessageEntry("fabric:message", "hello from expert", false, { seq: 1 });
  return { file: mgr.getSessionFile()!, cwd, entries: mgr.getEntries().length };
}

function readHeader(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as Record<string, unknown>;
}

describe("consult fork-store: forkExpertSession (streaming fork, T-6)", () => {
  it("copies a real expert session byte-for-byte past a rewritten header, leaving the source untouched", () => {
    const src = realExpertSession("explorer");
    const before = sha256(src.file);
    const dir = tempDir();

    const result = forkExpertSession(src.file, "/fallback/cwd", dir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.path.startsWith(dir)).toBe(true);
    expect(sha256(src.file)).toBe(before); // F2: source never written

    const header = readHeader(result.path);
    const sourceHeader = readHeader(src.file);
    expect(header["type"]).toBe("session");
    expect(header["parentSession"]).toBe(resolve(src.file));
    expect(header["id"]).not.toBe(sourceHeader["id"]); // new id
    expect(typeof header["id"]).toBe("string");
    expect(header["cwd"]).toBe(resolve(src.cwd)); // header cwd exists → level 1

    // The fork is a file pi itself accepts: same non-header entries, header swapped
    // (pi's getEntries() deliberately excludes the `session` header line).
    const forked = SessionManager.open(result.path);
    expect(forked.getSessionId()).toBe(header["id"]);
    expect(forked.getEntries().length).toBe(src.entries);
    expect(forked.getEntries()).toEqual(SessionManager.open(src.file).getEntries());
  });

  it("falls back to the asking run's cwd when the header cwd no longer exists (two-level, review-2 #12)", () => {
    // The session FILE must outlive its header cwd (a deleted worktree):
    // sessions live under <home>/sessions while the cwd was <home>/worktree.
    const home = tempDir();
    const worktreeCwd = join(home, "worktree");
    mkdirSync(worktreeCwd);
    const mgr = SessionManager.create(worktreeCwd, join(home, "sessions"));
    mgr.appendMessage({ role: "user", content: [{ type: "text", text: "expert task" }] });
    mgr.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }] });
    const file = mgr.getSessionFile()!;
    rmSync(worktreeCwd, { recursive: true, force: true }); // header cwd gone, file alive

    const result = forkExpertSession(file, "/asker/checkout", tempDir());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(readHeader(result.path)["cwd"]).toBe(resolve("/asker/checkout"));
  });

  it("keeps `wx` semantics: never clobbers an existing target, source and target both untouched", () => {
    const src = realExpertSession("collide");
    const dir = tempDir();
    const fixedId = "0199fixed-fixed-fixed-fixed-fixed"; // valid session id charset
    // Freeze time: the target name is `<timestamp>_<id>.jsonl`, so without a
    // frozen clock two same-id forks can land in different milliseconds and
    // never collide (this exact test was flaky in the full-suite run).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      expect(readdirSync(dir)).toEqual([]); // empty — the first fork creates the target
      const first = forkExpertSession(src.file, "/c", dir, { newId: () => fixedId });
      expect(first.ok).toBe(true);
      const targetPath = first.ok ? first.path : "";
      const existingBytes = readFileSync(targetPath);

      const second = forkExpertSession(src.file, "/c", dir, { newId: () => fixedId });

      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected failure");
      expect(second.reason).toContain("already exists");
      expect(readFileSync(targetPath).equals(existingBytes)).toBe(true); // not clobbered
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps the four forkFrom failure classes to { ok:false, reason } without throwing (§15 #2)", () => {
    const dir = tempDir();
    // ① empty source
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(forkExpertSession(empty, "/c", dir)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("empty or invalid"),
    });
    // ① missing source
    expect(forkExpertSession(join(dir, "nope.jsonl"), "/c", dir)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("empty or invalid"),
    });
    // ② no header: first parsed entry is a message
    const noHeader = join(dir, "no-header.jsonl");
    writeFileSync(
      noHeader,
      `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t", message: {} })}\n`,
    );
    const noHeaderResult = forkExpertSession(noHeader, "/c", dir);
    expect(noHeaderResult).toMatchObject({ ok: false, reason: expect.stringContaining("no header") });
    // ② header-scan cap: first line exceeds 8 KB
    const longLine = join(dir, "long-line.jsonl");
    writeFileSync(longLine, `${"x".repeat(9 * 1024)}\n{"type":"session","id":"s"}\n`);
    expect(forkExpertSession(longLine, "/c", dir)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("header scan limit"),
    });
    // ④ write failure: target dir path exists as a plain file → mkdirSync throws
    const good = realExpertSession("write-fail");
    const dirAsFile = join(dir, "not-a-dir");
    writeFileSync(dirAsFile, "x");
    expect(forkExpertSession(good.file, "/c", join(dirAsFile, "sub")).ok).toBe(false);
    // sanity: the same source is forkable into a real dir (control group)
    expect(forkExpertSession(good.file, "/c", tempDir()).ok).toBe(true);
  });

  it("tolerates blank/garbage lines before the header and drops them from the copy", () => {
    const dir = tempDir();
    const header = { type: "session", version: 3, id: "src-id", timestamp: "t", cwd: dir };
    const message = { type: "message", id: "m1", parentId: null, timestamp: "t", message: {} };
    const src = join(dir, "leading-junk.jsonl");
    // SessionManager.create wrote a real file into <cwd>/sessions — build this one by hand.
    writeFileSync(src, `\nnot json at all\n${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);

    const result = forkExpertSession(src, dir, dir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    // pi can open the fork: junk dropped, message kept (getEntries excludes
    // the header line by design).
    const opened = SessionManager.open(result.path);
    expect(opened.getSessionId()).not.toBe("src-id");
    expect(opened.getEntries().map((e) => e.type)).toEqual(["message"]);
  });
});

/**
 * D10 (docs/dev/workflow-worktree/plan.md §2): `opts.forceCwd` — the
 * isolated-asker path. Test #9 in the plan's §6 test list.
 */
describe("consult fork-store: forkExpertSession opts.forceCwd (D10)", () => {
  it("forceCwd:true writes fallbackCwd as the fork header's cwd, even though the source header's cwd exists", () => {
    const src = realExpertSession("explorer");
    const dir = tempDir();

    const result = forkExpertSession(src.file, "/asker/worktree", dir, { forceCwd: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const header = readHeader(result.path);
    // The source header DOES have a live cwd (src.cwd) — forceCwd bypasses it entirely.
    expect(header["cwd"]).toBe(resolve("/asker/worktree"));
    expect(header["cwd"]).not.toBe(resolve(src.cwd));
  });

  it("without forceCwd (undefined, or omitted entirely) the two-level rule is unchanged", () => {
    const src = realExpertSession("explorer2");
    const dir = tempDir();

    const explicit = forkExpertSession(src.file, "/asker/worktree", dir, { forceCwd: undefined });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error(explicit.reason);
    expect(readHeader(explicit.path)["cwd"]).toBe(resolve(src.cwd)); // header cwd wins (level 1)

    const omitted = forkExpertSession(src.file, "/asker/worktree", dir);
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) throw new Error(omitted.reason);
    expect(readHeader(omitted.path)["cwd"]).toBe(resolve(src.cwd));
  });

  it("forceCwd:false behaves exactly like omitting the option (falsy, not just undefined)", () => {
    const src = realExpertSession("explorer3");
    const dir = tempDir();

    const result = forkExpertSession(src.file, "/asker/worktree", dir, { forceCwd: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(readHeader(result.path)["cwd"]).toBe(resolve(src.cwd));
  });

  it("forceCwd propagates through forkMainSessionSnapshot's retry wrapper (opts is forwarded verbatim)", () => {
    const src = realExpertSession("main-like");
    const dir = tempDir();

    const result = forkMainSessionSnapshot(src.file, "/asker/worktree", dir, { forceCwd: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(readHeader(result.path)["cwd"]).toBe(resolve("/asker/worktree"));
  });
});

describe("consult fork-store: resolveForkCwd / readHeaderCwd (T-6)", () => {
  it("resolveForkCwd picks the live header cwd, else the fallback", () => {
    const live = tempDir();
    const dead = tempDir();
    rmSync(dead, { recursive: true, force: true });
    const mkSource = (cwdValue: string): string => {
      const file = join(live, `src-${Math.random().toString(36).slice(2)}.jsonl`);
      writeFileSync(
        file,
        `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: cwdValue })}\n`,
      );
      return file;
    };
    expect(resolveForkCwd(mkSource(live), "/fallback")).toBe(resolve(live));
    expect(resolveForkCwd(mkSource(dead), "/fallback")).toBe(resolve("/fallback"));
    expect(resolveForkCwd(mkSource(dead), dead)).toBe(resolve(dead)); // fallback itself is used verbatim when alive
    // unreadable source → fallback (never throws)
    expect(resolveForkCwd(join(live, "missing.jsonl"), "/fallback")).toBe(resolve("/fallback"));
  });

  it("readHeaderCwd: bounded read, blank-line tolerance, undefined on garbage/over-limit", () => {
    const dir = tempDir();
    const mk = (body: string): string => {
      const f = join(dir, `h-${Math.random().toString(36).slice(2)}.jsonl`);
      writeFileSync(f, body);
      return f;
    };
    expect(readHeaderCwd(mk(`${JSON.stringify({ type: "session", id: "s", cwd: "/a/b" })}\n`))).toBe("/a/b");
    expect(readHeaderCwd(mk(`\n\n${JSON.stringify({ type: "session", id: "s", cwd: "/a/b" })}\n`))).toBe("/a/b");
    expect(readHeaderCwd(mk("plain text file\nsecond line\n"))).toBeUndefined();
    expect(readHeaderCwd(mk(`${JSON.stringify({ type: "message", id: "m" })}\n`))).toBeUndefined();
    expect(readHeaderCwd(mk(`${"y".repeat(9 * 1024)}\n`))).toBeUndefined();
    expect(readHeaderCwd(join(dir, "absent.jsonl"))).toBeUndefined();
  });
});

describe("consult fork-store: sweepForkDir (T-6, §5.1)", () => {
  it("keeps valid files inside the TTL, drops expired files and headerless fragments regardless of mtime", () => {
    const dir = tempDir();
    const valid = join(dir, "valid.jsonl");
    writeFileSync(valid, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir })}\n`);
    const expired = join(dir, "expired.jsonl");
    writeFileSync(expired, `${JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "t", cwd: dir })}\n`);
    const freshFragment = join(dir, "fresh-fragment.jsonl"); // _persist reborn after unlink — fresh mtime, no header
    writeFileSync(freshFragment, `${JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "t" })}\n`);
    const oldFragment = join(dir, "old-fragment.jsonl");
    writeFileSync(oldFragment, "not a session at all\n");

    const now = Date.now();
    utimesSync(expired, new Date(now - FORK_TTL_MS - 60_000), new Date(now - FORK_TTL_MS - 60_000));
    utimesSync(oldFragment, new Date(now - 3 * FORK_TTL_MS), new Date(now - 3 * FORK_TTL_MS));
    // valid + freshFragment keep their (fresh) mtimes.

    const result = sweepForkDir(dir, FORK_TTL_MS, now);

    // oldFragment is both old and headerless — the TTL rule fires first
    // (classification only matters for observability; deletion is what matters).
    expect(result).toEqual({ removedExpired: 2, removedFragments: 1, kept: 1, errors: 0 });
    expect(() => statSync(valid)).not.toThrow();
    expect(() => statSync(expired)).toThrow();
    expect(() => statSync(freshFragment)).toThrow(); // fragment rule ignores TTL
    expect(() => statSync(oldFragment)).toThrow();
  });

  it("never throws on a missing dir, ignores subdirectories, and is a no-op for an empty dir", () => {
    expect(sweepForkDir(join(tempDir(), "does-not-exist"), FORK_TTL_MS)).toEqual({
      removedExpired: 0,
      removedFragments: 0,
      kept: 0,
      errors: 0,
    });
    const dir = tempDir();
    mkdirSync(join(dir, "subdir"));
    expect(sweepForkDir(dir, FORK_TTL_MS)).toEqual({ removedExpired: 0, removedFragments: 0, kept: 0, errors: 0 });
    expect(() => statSync(join(dir, "subdir"))).not.toThrow(); // directories untouched
  });
});

describe("consult fork-store: removeForkFile / consultSessionDir", () => {
  it("deletes only inside the consult dir; ENOENT is silent (idempotent)", () => {
    const dir = tempDir();
    const inside = join(dir, "fork.jsonl");
    writeFileSync(inside, "{}\n");
    const outsideDir = tempDir();
    const outside = join(outsideDir, "precious.jsonl");
    writeFileSync(outside, "keep me\n");

    expect(removeForkFile(inside, dir)).toBe(true);
    expect(() => statSync(inside)).toThrow();
    expect(removeForkFile(inside, dir)).toBe(false); // ENOENT — silent, idempotent
    expect(removeForkFile(outside, dir)).toBe(false); // outside the dir — refused
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
    // traversal attempts resolving outside the dir are refused too
    expect(removeForkFile(join(dir, "..", "precious.jsonl"), dir)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
  });

  it("consultSessionDir is pi's agent dir cache (review-1 #15)", () => {
    expect(consultSessionDir()).toBe(join(getAgentDir(), "cache", "consult-sessions"));
  });
});

/**
 * consult (plan §16 rule 5): the host main session is live — unlike a
 * terminal expert, its file can be concurrently appended to or wholesale
 * rewritten (`_rewriteFile`, e.g. across `/compact`) at the exact moment a
 * background subagent calls `consult("main", …)`. `checkForkConsistency`
 * is the detection primitive; `forkMainSessionSnapshot` wraps it with one
 * retry. Genuinely racing a concurrent rewrite deterministically in a unit
 * test is impractical, so these tests exercise the SAME code path with a
 * hand-crafted source whose corruption is reproducible on every attempt —
 * `checkForkConsistency` cannot tell "a rewrite landed mid-copy" apart from
 * "the source's Nth line was already malformed", which is exactly the
 * point: it only needs to notice *some* line other than the last failed to
 * parse.
 */
describe("consult fork-store: checkForkConsistency (§16 rule 5)", () => {
  it("accepts a well-formed multi-line fork file", () => {
    const dir = tempDir();
    const file = join(dir, "good.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir }),
        JSON.stringify({ type: "message", id: "m1" }),
        JSON.stringify({ type: "message", id: "m2" }),
        "",
      ].join("\n"),
    );
    expect(checkForkConsistency(file)).toEqual({ ok: true });
  });

  it("tolerates a genuinely incomplete FINAL line (ordinary mid-append capture)", () => {
    const dir = tempDir();
    const file = join(dir, "trailing-partial.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir }),
        JSON.stringify({ type: "message", id: "m1" }),
        '{"type":"message","id":"m2", "unterminat', // no trailing newline — genuinely incomplete
      ].join("\n"),
    );
    expect(checkForkConsistency(file)).toEqual({ ok: true });
  });

  it("rejects a MIDDLE line that fails to parse (mid-file corruption signature)", () => {
    const dir = tempDir();
    const file = join(dir, "mid-corrupt.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir }),
        '{"type":"message", this is not valid json at all', // corrupted, NOT the last line
        JSON.stringify({ type: "message", id: "m2" }),
        "",
      ].join("\n"),
    );
    const check = checkForkConsistency(file);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("mid-fork");
  });

  it("rejects a header line that is not valid JSON, or not a session header", () => {
    const dir = tempDir();
    const badJson = join(dir, "bad-header.jsonl");
    writeFileSync(badJson, "not json at all\n");
    expect(checkForkConsistency(badJson).ok).toBe(false);

    const notHeader = join(dir, "not-a-header.jsonl");
    writeFileSync(notHeader, `${JSON.stringify({ type: "message", id: "m1" })}\n`);
    expect(checkForkConsistency(notHeader).ok).toBe(false);
  });

  it("rejects an empty file", () => {
    const dir = tempDir();
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(checkForkConsistency(empty).ok).toBe(false);
  });
});

describe("consult fork-store: forkMainSessionSnapshot (§16 rule 5)", () => {
  it("a consistent source forks successfully in a single attempt, same contract as forkExpertSession", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const source = join(dir, "main.jsonl");
    writeFileSync(
      source,
      [
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir }),
        JSON.stringify({ type: "message", id: "m1" }),
        "",
      ].join("\n"),
    );
    const result = forkMainSessionSnapshot(source, dir, targetDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(checkForkConsistency(result.path)).toEqual({ ok: true });
      expect(readFileSync(result.path, "utf8")).toContain('"parentSession"');
    }
  });

  it("retries once on a reproducibly-inconsistent source, then gives up and leaves no fork file behind", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const source = join(dir, "corrupt-main.jsonl");
    // A source whose SECOND (non-last) line is malformed: forkExpertSession's
    // verbatim byte copy reproduces it faithfully on EVERY attempt, so the
    // post-copy consistency check fails deterministically both times —
    // exercising the exact "detect, delete, retry once, still bad, give up"
    // path a genuine concurrent-rewrite race would also hit.
    writeFileSync(
      source,
      [
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir }),
        '{"type":"message", not valid json',
        JSON.stringify({ type: "message", id: "m2" }),
        "",
      ].join("\n"),
    );
    let n = 0;
    const result = forkMainSessionSnapshot(source, dir, targetDir, { newId: () => `attempt-${++n}` });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("inconsistent after retry") });
    if (!result.ok) expect(result.reason).toContain("mid-fork");
    // Both attempted copies were cleaned up — no residue in the target dir.
    expect(readdirSync(targetDir)).toHaveLength(0);
  });

  it("a hard forkExpertSession failure (e.g. unreadable source) surfaces immediately, no retry", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const result = forkMainSessionSnapshot(join(dir, "does-not-exist.jsonl"), dir, targetDir);
    expect(result.ok).toBe(false);
    expect(readdirSync(targetDir)).toHaveLength(0);
  });
});

/** A handcrafted main-session source: valid header + `count` valid JSON lines (tail line terminated). */
function mainSessionSource(dir: string, name: string, count: number): { file: string; original: string } {
  const file = join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir })];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify({ type: "message", id: `m${i}`, pad: "x".repeat(48) }));
  const original = `${lines.join("\n")}\n`;
  writeFileSync(file, original);
  return { file, original };
}

/**
 * ~12 KB source: over an injected 4 KB parse cap AND over the 8 KB tail
 * window, so the oversized path's window genuinely starts mid-line.
 */
function oversizedSource(dir: string, name: string): string {
  const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir })];
  for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ type: "message", id: `m${i}`, pad: "x".repeat(32) }));
  const file = join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** Bounded-reader spy mirroring the production default (fd + readSync), recording every request. */
function spyWindow(): {
  read: (path: string, start: number, length: number) => Buffer;
  calls: Array<{ start: number; length: number }>;
} {
  const calls: Array<{ start: number; length: number }> = [];
  return {
    read(path, start, length) {
      calls.push({ start, length });
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(length);
        let filled = 0;
        while (filled < buf.length) {
          const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
          if (n === 0) break;
          filled += n;
        }
        return filled === buf.length ? buf : buf.subarray(0, filled);
      } finally {
        closeSync(fd);
      }
    },
    calls,
  };
}

describe("consult fork-store: main-session snapshot stat-drift detection (§16 rule 5 follow-up)", () => {
  it("a source truncated while the copy runs is retried once, then nacked, leaving no fork file", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const { file } = mainSessionSource(dir, "truncated.jsonl", 60);
    // Every fire halves the source: attempt 1's post-stat sees the shrink
    // (size comparison — no mtime granularity involved), attempt 2 shrinks it
    // again, so the drift persists deterministically across both attempts.
    const shrink = () => truncateSync(file, Math.max(1, Math.floor(statSync(file).size / 2)));
    const result = forkMainSessionSnapshot(file, dir, targetDir, { onAfterCopy: shrink });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("inconsistent after retry") });
    if (!result.ok) expect(result.reason).toContain("source rewritten mid-fork");
    expect(readdirSync(targetDir)).toHaveLength(0);
  });

  it("a pure append while the copy runs passes — the snapshot is cut at copy time, whole lines only", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const { file, original } = mainSessionSource(dir, "appending.jsonl", 30);
    const appended = JSON.stringify({ type: "message", id: "appended-after-copy" });
    const result = forkMainSessionSnapshot(file, dir, targetDir, {
      onAfterCopy: () => appendFileSync(file, `${appended}\n`),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The copy is bounded by the scan-time size, so the post-copy append is
      // simply not part of the snapshot — no torn line, nothing to retry.
      const tail = original.slice(original.indexOf("\n") + 1);
      const fork = readFileSync(result.path, "utf8");
      expect(fork.endsWith(tail)).toBe(true);
      expect(fork).not.toContain("appended-after-copy");
      expect(checkForkConsistency(result.path)).toEqual({ ok: true });
    }
  });

  it("a same-length in-place rewrite (mtime advanced, size unchanged) is inconsistent on every attempt", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const { file } = mainSessionSource(dir, "same-size.jsonl", 30);
    const real = statSync(file);
    let clock = 0;
    // mtime granularity is filesystem-dependent, so the seam supplies the
    // signature directly: every observation a tick apart, size never moving.
    const statSource = vi.fn((): SourceStatSignature => ({
      size: real.size,
      mtimeMs: real.mtimeMs + ++clock,
      ino: Number(real.ino),
    }));
    const result = forkMainSessionSnapshot(file, dir, targetDir, { statSource });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("inconsistent after retry");
      expect(result.reason).toContain("non-appending write");
    }
    expect(readdirSync(targetDir)).toHaveLength(0);
    // pre+post per attempt — the seam really brackets the copy on both tries.
    expect(statSource).toHaveBeenCalledTimes(4);
  });

  it("a transient inode replacement is retried, then succeeds once the source settles", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const { file } = mainSessionSource(dir, "replaced.jsonl", 20);
    let n = 0;
    const result = forkMainSessionSnapshot(file, dir, targetDir, {
      statSource: () => {
        n += 1;
        const st = statSync(file);
        return { size: st.size, mtimeMs: st.mtimeMs, ino: n === 1 ? 111 : 222 };
      },
    });
    // Attempt 1: pre (inode 111) vs post (inode 222) → replaced → retry;
    // attempt 2: stable inode → no drift → the parse check passes.
    expect(result.ok).toBe(true);
  });

  it("the stat-drift check still runs for an oversized source, whose parse stays window-bounded", () => {
    const dir = tempDir();
    const okDir = tempDir();
    const badDir = tempDir();
    const file = oversizedSource(dir, "big-main.jsonl");

    const reads = spyWindow();
    const ok = forkMainSessionSnapshot(file, dir, okDir, { consistencyMaxBytes: 4096, readWindow: reads.read });
    expect(ok.ok).toBe(true);
    expect(reads.calls.length).toBeGreaterThanOrEqual(2); // header window + tail window
    expect(reads.calls.every((c) => c.length <= 8192)).toBe(true);
    expect(reads.calls.every((c) => c.length < statSync(file).size)).toBe(true); // never the whole file

    const real = statSync(file);
    let clock = 0;
    const bad = forkMainSessionSnapshot(file, dir, badDir, {
      consistencyMaxBytes: 4096,
      statSource: () => ({ size: real.size, mtimeMs: real.mtimeMs + ++clock, ino: Number(real.ino) }),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("non-appending write");
    expect(readdirSync(badDir)).toHaveLength(0);
  });
});

describe("consult fork-store: checkForkConsistency oversized regime (§16 rule 5 follow-up)", () => {
  it("validates header + tail window without reading the file whole (default reader)", () => {
    const dir = tempDir();
    const file = oversizedSource(dir, "big-ok.jsonl");
    expect(checkForkConsistency(file, { maxBytes: 4096 })).toEqual({ ok: true });
  });

  it("requests only bounded windows: header scan + one tail window, never the whole file", () => {
    const dir = tempDir();
    const file = oversizedSource(dir, "big-spied.jsonl");
    const size = statSync(file).size;
    const reads = spyWindow();
    expect(checkForkConsistency(file, { maxBytes: 4096, readWindow: reads.read })).toEqual({ ok: true });
    expect(reads.calls.length).toBe(2);
    expect(reads.calls[0]).toEqual({ start: 0, length: Math.min(size, 8192) });
    expect(reads.calls[1]).toEqual({ start: size - Math.min(size, 8192), length: Math.min(size, 8192) });
  });

  it("still rejects an oversized fork whose header line is not valid JSON, or not a session header", () => {
    const dir = tempDir();
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ type: "message", id: `m${i}`, pad: "x".repeat(32) }));
    const badJson = join(dir, "big-bad-json.jsonl");
    writeFileSync(badJson, `not json at all\n${lines.join("\n")}\n`);
    const check = checkForkConsistency(badJson, { maxBytes: 4096 });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("header line is not valid JSON");

    const notHeader = join(dir, "big-not-header.jsonl");
    writeFileSync(notHeader, `${JSON.stringify({ type: "message", id: "m0" })}\n${lines.join("\n")}\n`);
    const check2 = checkForkConsistency(notHeader, { maxBytes: 4096 });
    expect(check2.ok).toBe(false);
    if (!check2.ok) expect(check2.reason).toContain("first line is not a session header");
  });

  it("rejects a corrupt non-final line inside the tail window (mid-fork splice signature)", () => {
    const dir = tempDir();
    const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir })];
    for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ type: "message", id: `m${i}`, pad: "x".repeat(32) }));
    lines.push('{"type":"message", this splice line is not valid json'); // inside the 8 KB tail window, NOT final
    lines.push(JSON.stringify({ type: "message", id: "tail-1" }));
    lines.push(JSON.stringify({ type: "message", id: "tail-2" }));
    const file = join(dir, "big-splice.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const check = checkForkConsistency(file, { maxBytes: 4096 });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("tail window");
      expect(check.reason).toContain("mid-fork");
    }
  });

  it("tolerates a genuinely torn final line in an oversized fork", () => {
    const dir = tempDir();
    const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: dir })];
    for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ type: "message", id: `m${i}`, pad: "x".repeat(32) }));
    lines.push('{"type":"message","id":"torn", "unterminat'); // no trailing newline — mid-append capture
    const file = join(dir, "big-torn.jsonl");
    writeFileSync(file, lines.join("\n"));
    expect(checkForkConsistency(file, { maxBytes: 4096 })).toEqual({ ok: true });
  });
});
