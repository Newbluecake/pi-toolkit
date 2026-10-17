/**
 * web-hub-html-preview plan v2 T-H3 — `hub/preview/pv-admit.ts` against the REAL kernel
 * (tmp dirs + /proc/self/fd), with scripted-fs hooks for the swap-between-steps windows.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import type { PreviewFs, PreviewHandle } from "../../../../src/web-hub/hub/preview/admit.js";
import { defaultPreviewFs, PV_DIR_OPEN_FLAGS } from "../../../../src/web-hub/hub/preview/fs.js";
import { admitPvFile, dirTooBroad, pinPvDir, type PvAdmitDeps } from "../../../../src/web-hub/hub/preview/pv-admit.js";
import { createPvIoGate } from "../../../../src/web-hub/hub/preview/pv-io.js";
import { PV_FILE_MAX_BYTES } from "../../../../src/web-hub/protocol/preview-html.js";

const roots: string[] = [];
const toClose: PreviewHandle[] = [];
afterEach(async () => {
  for (const h of toClose.splice(0)) await h.close().catch(() => undefined);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const fdCount = (): number => readdirSync("/proc/self/fd").length;
const denyCtx = denyCtxOf("/nonexistent-home", "/nonexistent-home/.pi/agent");

function scratch(): { root: string; site: string; outside: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wh-pvadmit-")));
  roots.push(root);
  const site = join(root, "site");
  const outside = join(root, "outside");
  mkdirSync(site);
  mkdirSync(outside);
  return { root, site, outside };
}

function mkDeps(fs?: Partial<PreviewFs>): PvAdmitDeps {
  return { denyCtx, gate: createPvIoGate(), fs, now: Date.now };
}

async function pin(deps: PvAdmitDeps, site: string, entry: string): Promise<PreviewHandle> {
  const st = await defaultPreviewFs().stat(join(site, entry));
  const r = await pinPvDir(deps, {
    boundDir: site,
    entry,
    entryDev: st.dev,
    entryIno: st.ino,
    deadlineAt: Date.now() + 5000,
  });
  if (!r.ok) throw new Error(`pin failed ${r.code}`);
  toClose.push(r.dirFh);
  return r.dirFh;
}

const admit = (deps: PvAdmitDeps, dir: PreviewHandle, site: string, rel: string) =>
  admitPvFile(deps, { dirFd: dir.fd, dirPath: site, rel });

async function expectOk(r: Awaited<ReturnType<typeof admitPvFile>>): Promise<PreviewHandle> {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("not ok");
  toClose.push(r.fh);
  return r.fh;
}

describe("pinPvDir", () => {
  it("pins the directory and matches the entry's dev/ino", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "<p>x</p>");
    const deps = mkDeps();
    const dir = await pin(deps, site, "index.html");
    expect(dir.fd).toBeGreaterThan(2);
    expect(PV_DIR_OPEN_FLAGS).toBeGreaterThan(0);
  });

  it("entry identity mismatch ⇒ 409 and the dir fd is closed", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    const before = fdCount();
    const st = await defaultPreviewFs().stat(join(site, "index.html"));
    const r = await pinPvDir(mkDeps(), {
      boundDir: site,
      entry: "index.html",
      entryDev: st.dev,
      entryIno: st.ino + 1,
      deadlineAt: Date.now() + 5000,
    });
    expect(r).toMatchObject({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
    expect(fdCount()).toBe(before);
  });

  it("boundDir that is not the fd's own path (symlinked spelling) ⇒ refused, fd closed", async () => {
    const { root, site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    symlinkSync(site, join(root, "link"));
    const before = fdCount();
    const st = await defaultPreviewFs().stat(join(site, "index.html"));
    const r = await pinPvDir(mkDeps(), {
      boundDir: join(root, "link"),
      entry: "index.html",
      entryDev: st.dev,
      entryIno: st.ino,
      deadlineAt: Date.now() + 5000,
    });
    // O_DIRECTORY|O_NOFOLLOW refuses a symlinked dir outright (ENOTDIR ⇒ 404)
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(fdCount()).toBe(before);
  });

  it("a missing dir ⇒ 404", async () => {
    const { site } = scratch();
    const r = await pinPvDir(mkDeps(), {
      boundDir: join(site, "nope"),
      entry: "x.html",
      entryDev: 1,
      entryIno: 1,
      deadlineAt: Date.now() + 5000,
    });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe("admitPvFile — containment", () => {
  it("serves a file, a nested file and an in-dir symlink", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "<p>x</p>");
    mkdirSync(join(site, "css"));
    writeFileSync(join(site, "css", "a.css"), "body{}");
    symlinkSync("css/a.css", join(site, "alias.css"));
    const deps = mkDeps();
    const dir = await pin(deps, site, "index.html");
    const before = fdCount();
    for (const [rel, size] of [
      ["index.html", 8],
      ["css/a.css", 6],
      ["alias.css", 6],
    ] as const) {
      const r = await admit(deps, dir, site, rel);
      const fh = await expectOk(r);
      expect(r.ok && r.size).toBe(size);
      expect(r.ok && r.realpath.startsWith(`${site}/`)).toBe(true);
      await fh.close();
    }
    expect(fdCount()).toBe(before);
  });

  it("symlink to outside ⇒ 403 outside, no fd leaked", async () => {
    const { site, outside } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(site, "evil.txt"));
    symlinkSync(outside, join(site, "evildir"));
    const deps = mkDeps();
    const dir = await pin(deps, site, "index.html");
    const before = fdCount();
    expect(await admit(deps, dir, site, "evil.txt")).toMatchObject({ ok: false, status: 403, reason: "outside" });
    expect(await admit(deps, dir, site, "evildir/secret.txt")).toMatchObject({
      ok: false,
      status: 403,
      reason: "outside",
    });
    expect(fdCount()).toBe(before);
  });

  it("denylist: literal `.ssh/id_rsa` 403 with zero fs calls; resolved-path hits 403", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    mkdirSync(join(site, ".ssh"));
    writeFileSync(join(site, ".ssh", "id_rsa"), "k");
    writeFileSync(join(site, "id_ed25519"), "k");
    symlinkSync(".ssh/id_rsa", join(site, "innocent.txt"));
    const calls: string[] = [];
    const real = defaultPreviewFs();
    const deps = mkDeps({
      readlink: (p) => (calls.push("readlink"), real.readlink(p)),
      realpath: (p) => (calls.push("realpath"), real.realpath(p)),
    });
    const dir = await pin(deps, site, "index.html");
    calls.length = 0;
    expect(await admit(deps, dir, site, ".ssh/id_rsa")).toMatchObject({ ok: false, status: 403, reason: "denylist" });
    expect(await admit(deps, dir, site, "id_ed25519")).toMatchObject({ ok: false, status: 403, reason: "denylist" });
    expect(calls).toEqual([]); // literal prefilter is zero-fs
    expect(await admit(deps, dir, site, "innocent.txt")).toMatchObject({ ok: false, status: 403, reason: "denylist" });
  });

  it("missing file 404; directory 415; fifo 415 (O_NONBLOCK, no hang)", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    mkdirSync(join(site, "d"));
    execFileSync("mkfifo", [join(site, "pipe")]);
    const deps = mkDeps();
    const dir = await pin(deps, site, "index.html");
    const before = fdCount();
    expect(await admit(deps, dir, site, "nope.css")).toMatchObject({ ok: false, status: 404 });
    expect(await admit(deps, dir, site, "d")).toMatchObject({ ok: false, status: 415 });
    expect(await admit(deps, dir, site, "pipe")).toMatchObject({ ok: false, status: 415 });
    expect(fdCount()).toBe(before);
  });

  it("file over PV_FILE_MAX_BYTES ⇒ 413 and the fd is closed", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    writeFileSync(join(site, "big.bin"), "");
    truncateSync(join(site, "big.bin"), PV_FILE_MAX_BYTES + 1);
    writeFileSync(join(site, "ok.bin"), "");
    truncateSync(join(site, "ok.bin"), PV_FILE_MAX_BYTES);
    const deps = mkDeps();
    const dir = await pin(deps, site, "index.html");
    const before = fdCount();
    expect(await admit(deps, dir, site, "big.bin")).toMatchObject({ ok: false, status: 413 });
    expect(fdCount()).toBe(before);
    const fh = await expectOk(await admit(deps, dir, site, "ok.bin"));
    await fh.close();
  });
});

describe("admitPvFile — directory swap after mint (T-H3)", () => {
  it("rename the bound dir + mkdir the same name + plant files ⇒ still the held inode", async () => {
    const { root, site } = scratch();
    writeFileSync(join(site, "index.html"), "orig");
    writeFileSync(join(site, "a.css"), "orig-css");
    const deps = mkDeps();
    const dir = await pin(deps, site, "index.html");
    renameSync(site, join(root, "moved"));
    mkdirSync(site);
    writeFileSync(join(site, "planted.js"), "evil");
    writeFileSync(join(site, "a.css"), "EVIL-css");
    // the held inode is served (at its NEW path) …
    const r = await admit(deps, dir, site, "a.css");
    const fh = await expectOk(r);
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    expect(buf.subarray(0, bytesRead).toString()).toBe("orig-css");
    await fh.close();
    // … and planted files at the old path do not exist in it
    expect(await admit(deps, dir, site, "planted.js")).toMatchObject({ ok: false, status: 404 });
  });

  it("a deleted bound dir ⇒ 404 + revokeCap", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    const deps = mkDeps();
    const dir = await pin(deps, site, "index.html");
    rmSync(site, { recursive: true });
    expect(await admit(deps, dir, site, "index.html")).toMatchObject({ ok: false, status: 404, revokeCap: true });
  });
});

describe("admitPvFile — swaps between steps (scripted fs)", () => {
  function swapSetup() {
    const { site, outside } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    mkdirSync(join(site, "sub"));
    writeFileSync(join(site, "sub", "f.css"), "inside");
    writeFileSync(join(outside, "f.css"), "outside-secret");
    return { site, outside };
  }

  it("intermediate dir replaced by a symlink between stat and open ⇒ 409 (identity), nothing leaks", async () => {
    const { site, outside } = swapSetup();
    const real = defaultPreviewFs();
    const deps = mkDeps({
      stat: async (p) => {
        const st = await real.stat(p);
        if (p.endsWith("/sub/f.css")) {
          rmSync(join(site, "sub"), { recursive: true });
          symlinkSync(outside, join(site, "sub"));
        }
        return st;
      },
    });
    const dir = await pin(mkDeps(), site, "index.html");
    const before = fdCount();
    const r = await admit(deps, dir, site, "sub/f.css");
    expect(r).toMatchObject({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
    expect(fdCount()).toBe(before);
  });

  it("same swap but identity somehow equal ⇒ the authoritative fd-readlink check says 403 outside", async () => {
    const { site, outside } = swapSetup();
    const real = defaultPreviewFs();
    // hard-link the outside file's identity onto the stat result so only step 5 can catch it
    const deps = mkDeps({
      stat: async (p) => {
        const st = await real.stat(p);
        if (p.endsWith("/sub/f.css")) {
          rmSync(join(site, "sub"), { recursive: true });
          symlinkSync(outside, join(site, "sub"));
          const swapped = await real.stat(join(outside, "f.css"));
          return swapped;
        }
        return st;
      },
    });
    const dir = await pin(mkDeps(), site, "index.html");
    const before = fdCount();
    const r = await admit(deps, dir, site, "sub/f.css");
    expect(r).toMatchObject({ ok: false, status: 403, reason: "outside" });
    expect(fdCount()).toBe(before);
  });

  it("opened file's fd path resolving outside / into the denylist / (deleted) is refused", async () => {
    const { site } = swapSetup();
    const real = defaultPreviewFs();
    const mk = (answer: (p: string, n: number) => string | undefined) => {
      let fileReads = 0;
      return mkDeps({
        readlink: async (p) => {
          const v = await real.readlink(p);
          if (p === `/proc/self/fd/${currentFileFd}`) fileReads += 1;
          return answer(p, fileReads) ?? v;
        },
        open: async (p, flags) => {
          const h = await real.open(p, flags);
          if (p.endsWith("/sub/f.css")) currentFileFd = h.fd;
          return h;
        },
      });
    };
    let currentFileFd = -1;
    const dir = await pin(mkDeps(), site, "index.html");
    const before = fdCount();
    const outsideDeps = mk((p) => (p === `/proc/self/fd/${currentFileFd}` ? "/elsewhere/f.css" : undefined));
    expect(await admit(outsideDeps, dir, site, "sub/f.css")).toMatchObject({ status: 403, reason: "outside" });
    const denyDeps = mk((p) => (p === `/proc/self/fd/${currentFileFd}` ? `${site}/.ssh/id_rsa` : undefined));
    expect(await admit(denyDeps, dir, site, "sub/f.css")).toMatchObject({ status: 403, reason: "denylist" });
    const delDeps = mk((p) => (p === `/proc/self/fd/${currentFileFd}` ? `${site}/sub/f.css (deleted)` : undefined));
    expect(await admit(delDeps, dir, site, "sub/f.css")).toMatchObject({ status: 409 });
    expect(fdCount()).toBe(before);
  });
});

describe("admitPvFile — budgets", () => {
  it("a hung step ⇒ 504 within the deadline; abort ⇒ status 0", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    const dir = await pin(mkDeps(), site, "index.html");
    const hung = mkDeps({ realpath: () => new Promise<string>(() => undefined) });
    const t0 = Date.now();
    const r = await admitPvFile(hung, { dirFd: dir.fd, dirPath: site, rel: "index.html", deadlineAt: Date.now() + 80 });
    expect(r).toMatchObject({ ok: false, status: 504 });
    expect(Date.now() - t0).toBeLessThan(1500);
    const ctl = new AbortController();
    const p = admitPvFile(hung, { dirFd: dir.fd, dirPath: site, rel: "index.html", signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20).unref();
    expect(await p).toMatchObject({ ok: false, status: 0, code: "E_ABORT" });
  });

  it("slots exhausted by zombies ⇒ 503 busy (retryAfterS 1)", async () => {
    const { site } = scratch();
    writeFileSync(join(site, "index.html"), "x");
    const gate = createPvIoGate({ slots: 1, opTimeoutMs: 20 });
    const deps: PvAdmitDeps = { denyCtx, gate, now: Date.now };
    const dir = await pin(deps, site, "index.html");
    const hung: PvAdmitDeps = { ...deps, fs: { readlink: () => new Promise<string>(() => undefined) } };
    const first = await admitPvFile(hung, { dirFd: dir.fd, dirPath: site, rel: "index.html" });
    expect(first).toMatchObject({ ok: false, status: 504 });
    const second = await admitPvFile(deps, {
      dirFd: dir.fd,
      dirPath: site,
      rel: "index.html",
      deadlineAt: Date.now() + 40,
    });
    expect(second).toMatchObject({ ok: false, status: 503, code: "E_BUSY", retryAfterS: 1 });
  });
});

describe("dirTooBroad (D2)", () => {
  const ctx = denyCtxOf("/home/u", "/home/u/.pi/agent");
  it("refuses /, home, agent dir, uploads root and anything under uploads", () => {
    const uploads = ["/home/u/.pi/agent/web-hub/uploads"];
    expect(dirTooBroad("/", ctx, uploads)).toBe(true);
    expect(dirTooBroad("/home/u", ctx, uploads)).toBe(true);
    expect(dirTooBroad("/home/u/", ctx, uploads)).toBe(true);
    expect(dirTooBroad("/home/u/.pi/agent", ctx, uploads)).toBe(true);
    expect(dirTooBroad("/home/u/.pi/agent/web-hub/uploads", ctx, uploads)).toBe(true);
    expect(dirTooBroad("/home/u/.pi/agent/web-hub/uploads/abc", ctx, uploads)).toBe(true);
  });
  it("accepts ordinary and similarly-prefixed directories; canonical members count too", () => {
    const uploads = ["/u/up"];
    expect(dirTooBroad("/home/u/project", ctx, uploads)).toBe(false);
    expect(dirTooBroad("/home/u2", ctx, uploads)).toBe(false);
    expect(dirTooBroad("/u/upload", ctx, uploads)).toBe(false);
    const both = { homes: ["/home/u", "/data/home/u"], agentDirs: ["/home/u/.pi/agent"] };
    expect(dirTooBroad("/data/home/u", both)).toBe(true);
    expect(dirTooBroad("/tmp/x", ctx)).toBe(false);
  });
});
