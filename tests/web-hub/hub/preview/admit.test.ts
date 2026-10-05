/**
 * web-hub-preview plan v3 §4.3 / PV2a acceptance — `hub/preview/admit.ts`.
 *
 * Coverage per the plan's PV2a checklist: every §4.3 row; steps 1–4 make ZERO fs calls;
 * virtual roots (incl. a cwd symlink resolving into /proc and a `/proc/self/environ` symlink);
 * the denylist (every category, via the pure predicate AND through real admission); home as
 * cwd (U2 matrix); `/tmp/r` vs `/tmp/r2` segment alignment; cwd-as-symlink; FIFO; chmod 000;
 * the four TOCTOU cases (HP2) plus the `procFdAvailable=false` residual; per-step slow
 * injection ⇒ 504 within the step cap; the errno mapping table; the late-open recovery; and
 * the hardlink behaviour pinned per §5.3 (allowed, `nlink > 1` is not a refusal).
 *
 * Real kernel semantics wherever possible: syscalls are real (tmpdir), only timing/failures
 * are scripted through `hookedFs` — except the pure zero-fs rows and the late-open case.
 */

import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCwdAdmitter, denyListHit } from "../../../../src/web-hub/hub/preview/admit.js";
import type { CwdAdmitterDeps, PreviewHandle } from "../../../../src/web-hub/hub/preview/admit.js";
import {
  defaultPreviewFs,
  isPreviewIoError,
  mapFsError,
  previewFsStep,
  PreviewIoError,
} from "../../../../src/web-hub/hub/preview/fs.js";
import { abortAfter, deadline, FakeHandle, hookedFs, memLog, neverAbort } from "./helpers.js";
import type { FsHooks, FsMethodName } from "./helpers.js";

const HOME = "/home/tester";

function admitter(hooks?: FsHooks, over: Partial<CwdAdmitterDeps> = {}) {
  const log = memLog();
  const fs = hookedFs(hooks ?? { counts: {} });
  const a = createCwdAdmitter({ home: HOME, fs, log, now: Date.now, ...over });
  return { a, fs, log };
}

function errnoError(code: string): Error {
  const e = new Error(`injected ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

// scratch dirs cleaned per test
let dirs: string[] = [];
const scratch = (prefix = "wh-admit-"): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const okPath = (root: string, rel = "note.txt", content = "hello preview"): string => {
  const p = join(root, rel);
  writeFileSync(p, content);
  return p;
};

// ---------------------------------------------------------------------------
// steps 1–4: literal decisions, ZERO fs
// ---------------------------------------------------------------------------

describe("admit: steps 1–4 (literal, zero fs)", () => {
  it.each([
    ["root not absolute", { root: "relative/root", path: "/etc/passwd", reason: "root-too-broad" }],
    ["root is /", { root: "/", path: "/etc/passwd", reason: "root-too-broad" }],
    ["root is /proc", { root: "/proc", path: "/proc/x", reason: "virtual-fs" }],
    ["root under /sys", { root: "/sys/kernel", path: "/sys/kernel/a", reason: "virtual-fs" }],
    ["path outside root prefix", { root: "/tmp/r", path: "/tmp/r2/f.txt", reason: "outside" }],
    ["path is the root itself", { root: "/tmp/r", path: "/tmp/r", reason: "outside" }],
    ["denylist literal", { root: "/tmp/r", path: "/tmp/r/.ssh/config", reason: "denylist" }],
    ["path under /dev", { root: "/dev", path: "/dev/nullx", reason: "virtual-fs" }],
  ])("%s ⇒ 403 %s, zero fs calls", async (_name, { root, path, reason }) => {
    const { a, fs } = admitter();
    const res = await a.admit({ root, path } as { root: string; path: string }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason });
    expect(Object.keys(fs.counts).filter((k) => (fs.counts[k] ?? 0) > 0)).toEqual([]);
  });

  it("/tmp/r vs /tmp/r2 both directions (segment-aligned prefix)", async () => {
    const { a } = admitter();
    const r2 = await a.admit({ root: "/tmp/r2", path: "/tmp/r/f.txt" }, deadline(8000), neverAbort());
    expect(r2).toMatchObject({ ok: false, reason: "outside" });
  });
});

// ---------------------------------------------------------------------------
// happy path & realpath layers
// ---------------------------------------------------------------------------

describe("admit: realpath layers", () => {
  it("regular file inside cwd ⇒ ok (fd open, size, realpath)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter();
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.size).toBe(13);
      expect(res.realpath).toBe(await defaultPreviewFs().realpath(file));
      await res.fh.close();
    }
  });

  it("cwd itself is a symlink ⇒ still ok (root realpathed)", async () => {
    const real = scratch();
    const link = join(scratch(), "link");
    symlinkSync(real, link);
    const file = okPath(real);
    const { a } = admitter();
    const res = await a.admit({ root: link, path: join(link, "note.txt") }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.realpath).toBe(file);
      await res.fh.close();
    }
  });

  it("a symlink INSIDE cwd to another file inside cwd resolves and is allowed", async () => {
    const root = scratch();
    const target = okPath(root, "real.txt");
    symlinkSync("real.txt", join(root, "alias.txt"));
    const { a } = admitter();
    const res = await a.admit({ root, path: join(root, "alias.txt") }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.realpath).toBe(target);
      await res.fh.close();
    }
  });

  it("symlink escaping cwd (/proc/self/environ) ⇒ 403 outside via realpath", async () => {
    const root = scratch();
    symlinkSync("/proc/self/environ", join(root, "env"));
    const { a } = admitter();
    const res = await a.admit({ root, path: join(root, "env") }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, reason: "outside" });
  });

  it("cwd resolving INTO a virtual root (root realpath check, step 5) ⇒ virtual-fs", async () => {
    const holder = scratch();
    const link = join(holder, "intoproc");
    symlinkSync("/proc/self", link);
    const { a } = admitter();
    const res = await a.admit({ root: link, path: join(link, "cmdline") }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, reason: "virtual-fs" });
  });
});

// ---------------------------------------------------------------------------
// denylist — pure predicate matrix + U2 (home as cwd)
// ---------------------------------------------------------------------------

describe("admit: denylist (§4.3 拒绝列表)", () => {
  it("prefixes under the hub's own home", () => {
    for (const p of [
      `${HOME}/.pi/agent/web-hub`,
      `${HOME}/.pi/agent/web-hub/uploads/x`,
      `${HOME}/.pi/agent/auth.json`,
      `${HOME}/.pi/agent/models.json`,
      `${HOME}/.config/pi/web-search.env`,
    ]) {
      expect(denyListHit(p, HOME)).toBe(true);
    }
    // segment alignment: a look-alike prefix must NOT hit
    expect(denyListHit(`${HOME}/.pi/agent/web-hub-other/f`, HOME)).toBe(false);
  });

  it("single segments", () => {
    for (const seg of [
      ".ssh",
      ".gnupg",
      ".aws",
      ".azure",
      ".kube",
      ".docker",
      ".password-store",
      ".mozilla",
      ".thunderbird",
      ".terraform.d",
    ]) {
      expect(denyListHit(`${HOME}/proj/${seg}/x`, HOME)).toBe(true);
    }
  });

  it("consecutive segment pairs", () => {
    for (const pair of [
      ".config/gcloud",
      ".config/gh",
      ".config/hub",
      ".config/google-chrome",
      ".config/chromium",
      ".config/BraveSoftware",
      ".local/share/keyrings",
      ".git/config",
      ".cargo/credentials",
      ".cargo/credentials.toml",
    ]) {
      expect(denyListHit(`${HOME}/x/${pair}/y`, HOME)).toBe(true);
      expect(denyListHit(`${HOME}/x/${pair}`, HOME)).toBe(true);
    }
    // non-consecutive must not hit
    expect(denyListHit(`${HOME}/.config/other/gh/hosts.yml`, HOME)).toBe(false);
  });

  it("basenames", () => {
    for (const base of [
      ".netrc",
      ".pgpass",
      ".git-credentials",
      ".npmrc",
      ".pypirc",
      ".bash_history",
      ".zsh_history",
      ".python_history",
      ".psql_history",
      ".mysql_history",
      ".node_repl_history",
      ".lesshst",
      ".viminfo",
    ]) {
      expect(denyListHit(`${HOME}/proj/${base}`, HOME)).toBe(true);
    }
  });

  it("basename patterns (.env*, id_* keys)", () => {
    for (const base of [
      ".env",
      ".env.local",
      ".env.production",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
      "id_dsa",
      "id_rsa.pub",
    ]) {
      expect(denyListHit(`${HOME}/p/${base}`, HOME)).toBe(true);
    }
    expect(denyListHit(`${HOME}/p/id_foo`, HOME)).toBe(false);
    expect(denyListHit(`${HOME}/p/envy`, HOME)).toBe(false);
  });

  it("extensions, case-insensitive", () => {
    for (const base of ["cert.pem", "cert.PEM", "k.key", "a.p12", "b.pfx", "c.kdbx"]) {
      expect(denyListHit(`${HOME}/p/${base}`, HOME)).toBe(true);
    }
    expect(denyListHit(`${HOME}/p/pemx`, HOME)).toBe(false);
    expect(denyListHit(`${HOME}/p/cert.pemap`, HOME)).toBe(false);
  });

  it("U2 matrix: home as cwd — normal file ok, secrets denied", async () => {
    const home = scratch("wh-home-");
    const okFile = join(home, "notes", "todo.md");
    mkdirSync(join(home, "notes"));
    writeFileSync(okFile, "plain");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "config"), "Host *");
    writeFileSync(join(home, ".zsh_history"), "cmd");
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "x");

    const { a, fs } = admitter();
    const good = await a.admit({ root: home, path: okFile }, deadline(8000), neverAbort());
    expect(good.ok).toBe(true);
    if (good.ok) await good.fh.close();
    expect(fs.counts.realpath ?? 0).toBe(2); // the ok case really did fs work

    for (const secret of [
      join(home, ".ssh", "config"),
      join(home, ".zsh_history"),
      join(home, ".config", "gh", "hosts.yml"),
    ]) {
      const res = await a.admit({ root: home, path: secret }, deadline(8000), neverAbort());
      expect(res).toMatchObject({ ok: false, status: 403, reason: "denylist" });
    }
  });

  it("denylist re-check on the RESOLVED path (step 8): in-cwd symlink to an in-cwd secret", async () => {
    const root = scratch();
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "config"), "Host *");
    mkdirSync(join(root, "pub"));
    symlinkSync(join(root, ".ssh", "config"), join(root, "pub", "leak")); // literal path is clean
    const { a } = admitter();
    const res = await a.admit({ root, path: join(root, "pub", "leak") }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, reason: "denylist" });
  });
});

// ---------------------------------------------------------------------------
// non-regular / unreadable
// ---------------------------------------------------------------------------

describe("admit: not-regular & unreadable", () => {
  it("FIFO ⇒ 415 not-regular (O_NONBLOCK open, fstat says not a file)", async () => {
    const root = scratch();
    const fifo = join(root, "pipe");
    execSync(`mkfifo '${fifo}'`);
    const { a } = admitter();
    const res = await a.admit({ root, path: fifo }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" });
  });

  it("directory ⇒ 415 not-regular", async () => {
    const root = scratch();
    const sub = join(root, "sub");
    mkdirSync(sub);
    const { a } = admitter();
    const res = await a.admit({ root, path: sub }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 415, reason: "not-regular" });
  });

  it("chmod 000 ⇒ 403 unreadable", async () => {
    const root = scratch();
    const f = okPath(root, "locked.txt");
    chmodSync(f, 0o000);
    const { a } = admitter();
    const res = await a.admit({ root, path: f }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason: "unreadable" });
    chmodSync(f, 0o600);
  });
});

// ---------------------------------------------------------------------------
// errno mapping through admission
// ---------------------------------------------------------------------------

describe("admit: errno mapping table", () => {
  const cases: Array<[string, number, string, string | undefined]> = [
    ["ENOENT", 404, "E_NOT_FOUND", undefined],
    ["ENOTDIR", 404, "E_NOT_FOUND", undefined],
    ["EACCES", 403, "E_PREVIEW_DENIED", "unreadable"],
    ["EPERM", 403, "E_PREVIEW_DENIED", "unreadable"],
    ["EMFILE", 503, "E_BUSY", undefined],
    ["ENFILE", 503, "E_BUSY", undefined],
    ["EAGAIN", 503, "E_BUSY", undefined],
    ["EIO", 500, "E_INTERNAL", undefined],
  ];
  for (const [code, status, errCode, reason] of cases) {
    it(`${code} on realpath(path) ⇒ ${status} ${errCode}`, async () => {
      const root = scratch();
      const file = okPath(root);
      const { a } = admitter({ counts: {}, failOn: { realpath: { call: 2, err: errnoError(code) } } });
      const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
      expect(res).toEqual(
        reason === undefined ? { ok: false, status, code: errCode } : { ok: false, status, code: errCode, reason },
      );
    });
  }

  it("ELOOP on open ⇒ 409", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter({ counts: {}, failOn: { open: { call: 1, err: errnoError("ELOOP") } } });
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("EISDIR ⇒ 415 not-regular", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter({ counts: {}, failOn: { open: { call: 1, err: errnoError("EISDIR") } } });
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" });
  });
});

// ---------------------------------------------------------------------------
// TOCTOU (HP2) — real syscalls, mutation injected between admission steps
// ---------------------------------------------------------------------------

describe("admit: TOCTOU (HP2)", () => {
  it("inode swapped between stat and open ⇒ 409 (dev/ino mismatch)", async () => {
    const root = scratch();
    const file = okPath(root, "f.txt", "old-content-longer");
    const replacement = join(root, "new.txt");
    writeFileSync(replacement, "new content");
    const { a } = admitter({
      counts: {},
      after: {
        stat: (p) => {
          if (p === file) renameSync(replacement, file); // swap AFTER stat captured the old inode
        },
      },
    });
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("final segment replaced by a symlink before open ⇒ 409 (ELOOP via O_NOFOLLOW)", async () => {
    const root = scratch();
    const file = okPath(root, "f.txt", "content");
    const { a } = admitter({
      counts: {},
      after: {
        realpath: (p) => {
          if (p === file) {
            rmSync(file);
            symlinkSync("/etc/hostname", file);
          }
        },
      },
    });
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("middle directory replaced by a symlink to a same-inode hardlink ⇒ 409 (readlink recheck)", async () => {
    const root = scratch();
    const mid = join(root, "a");
    mkdirSync(mid);
    const file = join(mid, "f.txt");
    writeFileSync(file, "payload");
    const elsewhere = scratch();
    const twin = join(elsewhere, "f.txt");
    linkSync(file, twin); // same inode behind the substituted path
    const { a } = admitter({
      counts: {},
      after: {
        realpath: (p) => {
          if (p === file) {
            rmSync(mid, { recursive: true });
            symlinkSync(elsewhere, mid);
          }
        },
      },
    });
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("readlink failing ⇒ 409 + warn (fail closed)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a, log } = admitter({ counts: {}, failOn: { readlink: { call: 1, err: errnoError("EIO") } } });
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("residual (R3): with procFdAvailable=false the readlink recheck is skipped entirely", async () => {
    const root = scratch();
    const mid = join(root, "a");
    mkdirSync(mid);
    const file = join(mid, "f.txt");
    writeFileSync(file, "payload");
    const elsewhere = scratch();
    linkSync(file, join(elsewhere, "f.txt"));
    const hooks: FsHooks = {
      counts: {},
      override: { procFdAvailable: false },
      after: {
        realpath: (p) => {
          if (p === file) {
            rmSync(mid, { recursive: true });
            symlinkSync(elsewhere, mid);
          }
        },
      },
    };
    const { a, fs } = admitter(hooks);
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true); // §4.3 step 12 skipped — the documented residual, pinned
    expect(fs.counts.readlink ?? 0).toBe(0);
    if (res.ok) await res.fh.close();
  });
});

// ---------------------------------------------------------------------------
// §5.3 hardlink pin
// ---------------------------------------------------------------------------

describe("admit: hardlink (§5.3 — not in the threat model, pinned)", () => {
  it("a hardlink inside cwd pointing at a file outside cwd ⇒ admitted (200 path)", async () => {
    const root = scratch();
    const outside = scratch();
    const original = join(outside, "real.txt");
    writeFileSync(original, "shared content");
    const inside = join(root, "link.txt");
    linkSync(original, inside);
    const { a } = admitter();
    const res = await a.admit({ root, path: inside }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.size).toBe(14);
      await res.fh.close();
    }
  });
});

// ---------------------------------------------------------------------------
// budgets: per-step caps, lazy initiation, late-open recovery, abort
// ---------------------------------------------------------------------------

describe("admit: budgets & step racing", () => {
  const STEP_CAP = 80;
  const SLOW = 400;

  /** admitter whose fs is real except one injected delay; `h` wraps the opened handle so
   * `fh.stat()` itself can be the slow step. */
  const slowAdmitter = (method: FsMethodName, delayHandleStat = false) => {
    const hooks: FsHooks = { counts: {}, delayMs: { [method]: SLOW } as Partial<Record<FsMethodName, number>> };
    const fs = hookedFs(hooks);
    const wrappedOpen = async (p: string, flags: number): Promise<PreviewHandle> => {
      const h = await fs.open(p, flags);
      if (!delayHandleStat) return h;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
      return {
        fd: h.fd,
        stat: async () => {
          await sleep(SLOW);
          return h.stat();
        },
        read: (b, o, l, pos) => h.read(b, o, l, pos),
        close: () => h.close(),
      };
    };
    const a = createCwdAdmitter({
      home: HOME,
      fs: { ...fs, open: wrappedOpen },
      log: memLog(),
      now: Date.now,
      stepCapMs: STEP_CAP,
    });
    return { a, counts: fs.counts };
  };

  it.each([
    ["realpath(root)", "realpath", false],
    ["realpath(path)", "realpath", false],
    ["stat(rp)", "stat", false],
    ["open", "open", false],
    ["fh.stat()", "open", true], // handle-level stat is the slow step
    ["readlink(/proc/self/fd/N)", "readlink", false],
  ] as const)("slow %s ⇒ 504 E_DEADLINE at the step cap, not the 8s total", async (_name, method, wrapStat) => {
    const root = scratch();
    const file = okPath(root);
    const { a } = slowAdmitter(method, wrapStat);
    const t0 = Date.now();
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    const elapsed = Date.now() - t0;
    expect(res).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(elapsed).toBeLessThan(STEP_CAP * 3);
  });

  it("exhausted deadline ⇒ 504 without initiating the fs call (lazy)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a, fs } = admitter();
    const res = await a.admit({ root, path: file }, deadline(0), neverAbort());
    expect(res).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(fs.counts.realpath ?? 0).toBe(0);
  });

  it("a raced-out open that resolves late is closed (迟到回收)", async () => {
    const root = scratch();
    const file = okPath(root);
    const real = defaultPreviewFs();
    const late = new Promise<PreviewHandle>((resolve) => {
      const t = setTimeout(() => resolve(new FakeHandle(Buffer.from("late"))), 300);
      t.unref();
    });
    const fs = { ...real, open: () => late, counts: {} as Record<string, number> };
    const a = createCwdAdmitter({ home: HOME, fs, log: memLog(), now: Date.now, stepCapMs: 60 });
    const t0 = Date.now();
    const res = await a.admit({ root, path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(Date.now() - t0).toBeLessThan(250);
    const handle = await late;
    await new Promise((r) => setTimeout(r, 20));
    expect(handle.closeCount).toBe(1);
  });

  it("abort mid-step ⇒ silent result (status 0, E_ABORT)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter(
      { counts: {}, delayMs: { realpath: SLOW } as Record<string, number> },
      { stepCapMs: 10_000 },
    );
    const { signal, cancel } = abortAfter(60, "client-abort");
    const res = await a.admit({ root, path: file }, deadline(8000), signal);
    cancel();
    expect(res).toEqual({ ok: false, status: 0, code: "E_ABORT" });
  });

  it("pre-aborted signal ⇒ E_ABORT with zero fs calls", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a, fs } = admitter();
    const ctl = new AbortController();
    ctl.abort("hub-close");
    const res = await a.admit({ root, path: file }, deadline(8000), ctl.signal);
    expect(res).toEqual({ ok: false, status: 0, code: "E_ABORT" });
    expect(Object.keys(fs.counts).filter((k) => (fs.counts[k] ?? 0) > 0)).toEqual([]);
  });

  it("steps 7/8 (sniff sample + JPEG continuation reads) race the same cap via previewFsStep", async () => {
    const dl = deadline(8000);
    const slow = new Promise<{ bytesRead: number }>(() => undefined);
    await expect(previewFsStep(() => slow, dl, neverAbort(), { stepCapMs: 60, now: Date.now })).rejects.toSatisfy(
      isPreviewIoError,
    );
    expect(mapFsError(new PreviewIoError("deadline", "x"))).toEqual({
      kind: "response",
      body: { status: 504, code: "E_DEADLINE" },
    });
    // and the JPEG continuation variant: same helper, still inside the shared 8s budget
    await expect(previewFsStep(() => slow, dl, neverAbort(), { stepCapMs: 60, now: Date.now })).rejects.toSatisfy(
      (e: unknown) => isPreviewIoError(e) && e.ioFail === "deadline",
    );
  });
});
