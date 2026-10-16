/** web-hub-version plan §3.4/§3.5/§3.11 — readBounded + the single-flight version service. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunResult, GitRunner } from "../../../src/git/run.js";
import type { HubInfo, HubLog } from "../../../src/web-hub/hub/ports.js";
import {
  createVersionInfoService,
  defaultVersionFs,
  fitBody,
  readBounded,
  type BoundedFileHandle,
  type VersionFsDeps,
} from "../../../src/web-hub/hub/version-info.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import {
  VERSION_LIMITS,
  parseVersionInfoWire,
  type VersionInfoWire,
} from "../../../src/web-hub/protocol/version-info.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pwh-vinfo-"));
  tmps.push(d);
  return d;
}
const noLog = { info() {}, warn() {}, error() {}, debug() {}, close() {} } as unknown as HubLog;
function mkInfo(): HubInfo {
  return { version: "1.0.0", buildId: "1.0.0@abc1234", pid: 4242, startedAt: 1111, proto: PROTO, caps: [] } as HubInfo;
}
const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stdoutCapped: false, stderr: "" });

/** A fake runner that answers every stage like a healthy repo; counts toplevel calls. */
function healthyRunner(
  pkgRoot: string,
  hooks: { gate?: Promise<void> } = {},
): GitRunner & { tops: number; calls: number } {
  const r = (async (args: readonly string[]) => {
    r.calls++;
    const a = args.join(" ");
    if (a.includes("--show-toplevel")) {
      r.tops++;
      if (hooks.gate !== undefined) await hooks.gate;
      return ok(`${pkgRoot}\n`);
    }
    if (a.includes("rev-list")) return ok("2\n");
    if (a.includes("--format=%h%x09%ct%x09%s")) return ok("abc1234\t100\tone\ndef5678\t99\ttwo\n");
    if (a.includes("--format=%h%x09%ct")) return ok("abc1234\t100\n");
    if (a.includes("status")) return ok("");
    if (a.includes("describe")) return ok("v1.0.0\n");
    return ok("");
  }) as GitRunner & { tops: number; calls: number };
  r.tops = 0;
  r.calls = 0;
  return r;
}

describe("readBounded (§3.4)", () => {
  it("reads a regular file; missing ⇒ missing; symlink ⇒ unavailable; oversize ⇒ too-large", async () => {
    const d = tmp();
    const fs = defaultVersionFs();
    writeFileSync(join(d, "a.md"), "hello");
    expect(await readBounded(fs, join(d, "a.md"))).toMatchObject({ ok: true, text: "hello" });
    expect(await readBounded(fs, join(d, "nope"))).toEqual({ ok: false, error: "missing" });
    symlinkSync(join(d, "a.md"), join(d, "link.md"));
    expect(await readBounded(fs, join(d, "link.md"))).toEqual({ ok: false, error: "unavailable" });
    writeFileSync(join(d, "big.md"), Buffer.alloc(2000, 97));
    expect(await readBounded(fs, join(d, "big.md"), 1000)).toEqual({ ok: false, error: "too-large" });
  });

  it("a FIFO swapped in for the file does not block (O_NONBLOCK) and is rejected as not-regular", async () => {
    const d = tmp();
    execFileSync("mkfifo", [join(d, "CHANGELOG.md")]);
    const t0 = Date.now();
    expect(await readBounded(defaultVersionFs(), join(d, "CHANGELOG.md"))).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("closes the handle on every path (success, not-regular, oversize, read error)", async () => {
    let closed = 0;
    const mk = (st: { isFile: boolean; size: number }, readErr = false): VersionFsDeps => ({
      open: async () =>
        ({
          stat: async () => ({ isFile: () => st.isFile, size: st.size, dev: 1, ino: 2, mtimeMs: 3 }),
          read: async (buf: Buffer) => {
            if (readErr) throw new Error("EIO");
            buf.write("x");
            return { bytesRead: 1 };
          },
          close: async () => {
            closed++;
          },
        }) as BoundedFileHandle,
    });
    await readBounded(mk({ isFile: true, size: 1 }), "/p");
    await readBounded(mk({ isFile: false, size: 1 }), "/p");
    await readBounded(mk({ isFile: true, size: 10 }), "/p", 5);
    await readBounded(mk({ isFile: true, size: 1 }, true), "/p");
    expect(closed).toBe(4);
  });

  it("an unchanged (dev,ino,size,mtimeMs) key skips the read", async () => {
    const d = tmp();
    writeFileSync(join(d, "a"), "abc");
    const first = await readBounded(defaultVersionFs(), join(d, "a"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await readBounded(defaultVersionFs(), join(d, "a"), 1 << 20, first.key)).toMatchObject({
      ok: true,
      unchanged: true,
    });
  });
});

function mkService(over: {
  pkgRoot: string;
  git?: GitRunner;
  fs?: VersionFsDeps;
  now?: () => number;
  info?: HubInfo;
  publish?: () => void;
  limits?: Record<string, number>;
}) {
  return createVersionInfoService({
    pkgRoot: over.pkgRoot,
    info: over.info ?? mkInfo(),
    git: over.git ?? healthyRunner(over.pkgRoot),
    realpath: async (p) => p,
    now: over.now ?? (() => Date.now()),
    log: noLog,
    ...(over.fs === undefined ? {} : { fs: over.fs }),
    ...(over.publish === undefined ? {} : { publish: over.publish }),
    ...(over.limits === undefined ? {} : { limits: over.limits }),
  });
}
const sig = (): AbortSignal => new AbortController().signal;

describe("version service (§3.5)", () => {
  it("a cold snapshot assembles repo + changelog + packageVersion and validates against the wire parser", async () => {
    const d = tmp();
    writeFileSync(join(d, "CHANGELOG.md"), "## [1.0.0] - 2026-01-01\n- thing\n");
    writeFileSync(join(d, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const svc = mkService({ pkgRoot: d });
    const out = await svc.snapshot(sig());
    svc.dispose();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data).toMatchObject({
      v: 1,
      hub: { pid: 4242, startedAt: 1111 },
      repo: {
        head: { commit: "abc1234", time: 100 },
        packageVersion: "1.0.0",
        lastTag: "v1.0.0",
        commitsTotal: 2,
        commits: [
          { commit: "abc1234", time: 100, subject: "one" },
          { commit: "def5678", time: 99, subject: "two" },
        ],
      },
      changelog: { sections: [{ title: "1.0.0", date: "2026-01-01", markdown: "- thing" }] },
    });
    expect(parseVersionInfoWire(JSON.parse(JSON.stringify(out.data)))).toEqual(out.data);
  });

  it("non-git package root ⇒ repo key absent; missing CHANGELOG ⇒ changelog.error=missing", async () => {
    const d = tmp();
    const git: GitRunner = async () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "fatal" });
    const svc = mkService({ pkgRoot: d, git });
    const out = await svc.snapshot(sig());
    svc.dispose();
    expect(out.ok && "repo" in out.data).toBe(false);
    expect(out.ok && out.data.changelog).toEqual({ error: "missing" });
  });

  it("success is cached 30s; a failed section only 10s (persistent failure ⇒ fail cache)", async () => {
    const d = tmp();
    writeFileSync(join(d, "CHANGELOG.md"), "## [1.0.0]\n- a\n");
    let t = 1_000_000;
    const git = healthyRunner(d);
    const svc = mkService({ pkgRoot: d, git, now: () => t });
    await svc.snapshot(sig());
    const afterFirst = git.tops;
    t += 29_000;
    await svc.snapshot(sig());
    expect(git.tops).toBe(afterFirst); // still cached
    t += 2_000;
    await svc.snapshot(sig());
    expect(git.tops).toBe(afterFirst + 1); // 31s ⇒ recomputed
    svc.dispose();

    // persistent failure
    const d2 = tmp(); // no CHANGELOG ⇒ changelog.error
    const git2 = healthyRunner(d2);
    let t2 = 5_000_000;
    const svc2 = mkService({ pkgRoot: d2, git: git2, now: () => t2 });
    await svc2.snapshot(sig());
    const n = git2.tops;
    t2 += 9_000;
    await svc2.snapshot(sig());
    expect(git2.tops).toBe(n); // 10s fail cache holds
    t2 += 1_500;
    await svc2.snapshot(sig());
    expect(git2.tops).toBe(n + 1); // expired ⇒ not served from the 30s window
    svc2.dispose();
  });

  it("single-flight: 8 concurrent waiters share ONE git round; the 9th gets E_BUSY", async () => {
    const d = tmp();
    writeFileSync(join(d, "CHANGELOG.md"), "## [1.0.0]\n- a\n");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const git = healthyRunner(d, { gate });
    const svc = mkService({ pkgRoot: d, git });
    const waiting = Array.from({ length: VERSION_LIMITS.waiters }, () => svc.snapshot(sig()));
    const ninth = await svc.snapshot(sig());
    expect(ninth).toEqual({ ok: false, code: "E_BUSY" });
    release();
    const all = await Promise.all(waiting);
    expect(all.every((o) => o.ok)).toBe(true);
    expect(git.tops).toBe(1);
    // and afterwards the cache serves everyone without more git
    await Promise.all(Array.from({ length: 20 }, () => svc.snapshot(sig())));
    expect(git.tops).toBe(1);
    svc.dispose();
  });

  it("a disconnect only detaches that waiter: the round completes for the others and the slot count frees", async () => {
    const d = tmp();
    writeFileSync(join(d, "CHANGELOG.md"), "## [1.0.0]\n- a\n");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const git = healthyRunner(d, { gate });
    const svc = mkService({ pkgRoot: d, git });
    const ac = new AbortController();
    const dropped = svc.snapshot(ac.signal);
    const kept = svc.snapshot(sig());
    ac.abort();
    expect(await dropped).toEqual({ ok: false, code: "E_DEADLINE" });
    // 7 more fit (8 total waiters, one freed by the abort)
    const more = Array.from({ length: 7 }, () => svc.snapshot(sig()));
    expect(await svc.snapshot(sig())).toEqual({ ok: false, code: "E_BUSY" });
    release();
    expect((await kept).ok).toBe(true);
    expect((await Promise.all(more)).every((o) => o.ok)).toBe(true);
    expect(git.tops).toBe(1);
    svc.dispose();
  });

  it("a FIFO swapped in for CHANGELOG.md answers quickly as unavailable", async () => {
    const d = tmp();
    execFileSync("mkfifo", [join(d, "CHANGELOG.md")]);
    const svc = mkService({ pkgRoot: d });
    const t0 = Date.now();
    const out = await svc.snapshot(sig());
    svc.dispose();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.ok && out.data.changelog).toEqual({ error: "unavailable" });
  });

  it("fs late completion: the section times out, the cache holds, but the slot stays occupied until the IO really settles", async () => {
    const d = tmp();
    let t = 10_000_000;
    let releaseOpen!: (h: BoundedFileHandle) => void;
    let opens = 0;
    const fs: VersionFsDeps = {
      open: () => {
        opens++;
        return new Promise<BoundedFileHandle>((r) => (releaseOpen = r));
      },
    };
    const svc = mkService({ pkgRoot: d, fs, now: () => t, limits: { fileMs: 40 } });
    const first = await svc.snapshot(sig());
    expect(first.ok && first.data.changelog).toEqual({ error: "timeout" });
    expect(opens).toBeGreaterThan(0);
    const openedByFirstRound = opens;
    // cache expired (fail ttl 10s) but the hung IO still owns the slot ⇒ no second round, no more IO
    t += 11_000;
    expect(await svc.snapshot(sig())).toEqual({ ok: false, code: "E_BUSY" });
    expect(opens).toBe(openedByFirstRound);
    // the late handle completes: it is closed and its result discarded; the slot frees
    let closed = 0;
    // both CHANGELOG.md and package.json opens are pending; only the LAST resolver is retained by
    // the stub, which is enough to prove release ⇒ the other stays pending ⇒ still busy
    releaseOpen({
      stat: async () => ({ isFile: () => true, size: 1, dev: 1, ino: 1, mtimeMs: 1 }),
      read: async () => ({ bytesRead: 0 }),
      close: async () => {
        closed++;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
    svc.dispose();
  });

  it("after the real IO settles the slot frees and the next snapshot recomputes", async () => {
    const d = tmp();
    let t = 20_000_000;
    const resolvers: Array<(h: BoundedFileHandle) => void> = [];
    let hang = true;
    const real = defaultVersionFs();
    const fs: VersionFsDeps = {
      open: (p, f) => (hang ? new Promise<BoundedFileHandle>((r) => resolvers.push(r)) : real.open(p, f)),
    };
    const svc = mkService({ pkgRoot: d, fs, now: () => t, limits: { fileMs: 30 } });
    await svc.snapshot(sig());
    t += 11_000;
    expect(await svc.snapshot(sig())).toEqual({ ok: false, code: "E_BUSY" });
    const h: BoundedFileHandle = {
      stat: async () => ({ isFile: () => false, size: 0, dev: 1, ino: 1, mtimeMs: 1 }),
      read: async () => ({ bytesRead: 0 }),
      close: async () => {},
    };
    for (const r of resolvers) r(h);
    hang = false;
    await new Promise((r) => setTimeout(r, 20));
    const again = await svc.snapshot(sig());
    expect(again.ok).toBe(true);
    svc.dispose();
  });

  it("bootHead is captured exactly once, written to HubInfo and announced exactly once", async () => {
    const d = tmp();
    const git = healthyRunner(d);
    const info = mkInfo();
    let published = 0;
    const svc = mkService({ pkgRoot: d, git, info, publish: () => published++ });
    svc.captureBootHead();
    svc.captureBootHead();
    await new Promise((r) => setTimeout(r, 50));
    expect(info.bootHead).toEqual({ commit: "abc1234", time: 100 });
    expect(published).toBe(1);
    expect(git.tops).toBe(1);
    svc.dispose();
  });

  it("bootHead failure is silent: no field, no broadcast, no retry", async () => {
    const d = tmp();
    const info = mkInfo();
    let published = 0;
    let calls = 0;
    const git: GitRunner = async () => {
      calls++;
      return { code: 128, stdout: "", stdoutCapped: false, stderr: "" };
    };
    const svc = mkService({ pkgRoot: d, git, info, publish: () => published++ });
    svc.captureBootHead();
    await new Promise((r) => setTimeout(r, 30));
    svc.captureBootHead();
    await new Promise((r) => setTimeout(r, 30));
    expect(info.bootHead).toBeUndefined();
    expect(published).toBe(0);
    expect(calls).toBe(1);
    svc.dispose();
  });

  it("dispose aborts in-flight git and refuses new snapshots", async () => {
    const d = tmp();
    const seen: AbortSignal[] = [];
    const git: GitRunner = (_a, o) =>
      new Promise((resolve) => {
        seen.push(o.signal!);
        o.signal!.addEventListener("abort", () =>
          resolve({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "abort" }),
        );
      });
    const svc = mkService({ pkgRoot: d, git });
    const p = svc.snapshot(sig());
    await new Promise((r) => setTimeout(r, 10));
    svc.dispose();
    const out = await p;
    expect(out.ok && out.data.repo).toEqual({ error: "timeout" });
    expect(await svc.snapshot(sig())).toEqual({ ok: false, code: "E_DEADLINE" });
  });
});

describe("fitBody", () => {
  it("trims changelog tail sections then commits tail until ≤ 64 KiB and sets truncated", () => {
    const big = "x".repeat(8000);
    const data: VersionInfoWire = {
      v: 1,
      checkedAt: 1,
      hub: { pid: 1, startedAt: 1 },
      repo: {
        head: { commit: "abc1234" },
        commits: Array.from({ length: 20 }, (_, i) => ({ commit: "abc1234", time: i, subject: "s".repeat(200) })),
      },
      changelog: { sections: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, markdown: big })) },
    };
    // inflate beyond the budget with an artificial extra payload on sections
    for (const s of (data.changelog as { sections: { markdown: string }[] }).sections) s.markdown = big.repeat(3);
    fitBody(data);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(VERSION_LIMITS.bodyBytes);
    expect(data.truncated).toBe(true);
  });
  it("leaves a small body untouched", () => {
    const data: VersionInfoWire = { v: 1, checkedAt: 1, hub: { pid: 1, startedAt: 1 } };
    expect(fitBody(data)).toEqual({ v: 1, checkedAt: 1, hub: { pid: 1, startedAt: 1 } });
  });
});
