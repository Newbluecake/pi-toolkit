/**
 * web-hub-preview plan v3 §4.3 (mapping table) / PV2a — `hub/preview/fs.ts`.
 *
 * The fs error → HTTP mapping table row by row; `previewFsStep`'s lazy initiation and step
 * cap; the real adapter's roundtrip on a tmpdir (incl. the O_NOFOLLOW symlink refusal and the
 * idempotent close); `racePreviewIo`'s deadline/abort classification.
 *
 * dir-plan v3.1 §2.4 (P1a) adds the `PreviewIoTracker` contract tests — the full §2.4 state
 * machine (slow-promise timeout ⇒ zombie, settle ⇒ 0; two concurrent timeouts ⇒ third step
 * busy WITHOUT calling lazy; duplicate race-side trips count once; sync-throw lazy counts
 * nothing; underlying REJECT also decrements; a fresh tracker starts at 0 — the /reload
 * shape; NO_TRACKER never trips) — and §2.6's `resolvePreviewDenyContext` (literal+canonical
 * dedupe, degradation WARN without paths, shared 2s budget).
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPreviewIoTracker,
  defaultPreviewFs,
  mapFsError,
  NO_TRACKER,
  PREVIEW_FS_ZOMBIE_MAX,
  PREVIEW_READ_FLAGS,
  previewFsStep,
  PreviewIoError,
  previewProcFdAvailable,
  racePreviewIo,
  resolvePreviewDenyContext,
} from "../../../../src/web-hub/hub/preview/fs.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { deadline, memLog, neverAbort } from "./helpers.js";

const errno = (code: string): Error => {
  const e = new Error(code) as Error & { code: string };
  e.code = code;
  return e;
};

describe("mapFsError (§4.3 fs 错误映射表)", () => {
  it("deadline ⇒ 504 E_DEADLINE", () => {
    expect(mapFsError(new PreviewIoError("deadline", "x"))).toEqual({
      kind: "response",
      body: { status: 504, code: "E_DEADLINE" },
    });
  });

  it("abort (native AbortError or raced) ⇒ the silent marker (caller decides)", () => {
    const native = new Error("aborted") as Error;
    native.name = "AbortError";
    expect(mapFsError(native)).toEqual({ kind: "abort" });
    expect(mapFsError(new PreviewIoError("abort", "x"))).toEqual({ kind: "abort" });
  });

  it.each([
    ["ENOENT", 404, "E_NOT_FOUND", undefined],
    ["ENOTDIR", 404, "E_NOT_FOUND", undefined],
    ["EACCES", 403, "E_PREVIEW_DENIED", "unreadable"],
    ["EPERM", 403, "E_PREVIEW_DENIED", "unreadable"],
    ["ELOOP", 409, "E_PREVIEW_CHANGED", undefined],
    ["EISDIR", 415, "E_PREVIEW_UNSUPPORTED", "not-regular"],
    ["EMFILE", 503, "E_BUSY", undefined],
    ["ENFILE", 503, "E_BUSY", undefined],
    ["EAGAIN", 503, "E_BUSY", undefined],
    ["EIO", 500, "E_INTERNAL", undefined],
  ])("%s ⇒ %s %s", (code, status, errCode, reason) => {
    const m = mapFsError(errno(code as string));
    expect(m.kind).toBe("response");
    if (m.kind === "response") {
      expect(m.body.status).toBe(status);
      expect(m.body.code).toBe(errCode);
      expect(m.body.reason).toBe(reason);
    }
  });

  it("EMFILE carries Retry-After 1s", () => {
    const m = mapFsError(errno("EMFILE"));
    expect(m.kind === "response" && m.body.retryAfterS).toBe(1);
  });

  it("busy (§2.4 tracker tripped) ⇒ 503 E_BUSY with Retry-After 1s", () => {
    expect(mapFsError(new PreviewIoError("busy", "x"))).toEqual({
      kind: "response",
      body: { status: 503, code: "E_BUSY", retryAfterS: 1 },
    });
  });

  it("non-error throws ⇒ 500 E_INTERNAL", () => {
    expect(mapFsError("just a string")).toEqual({ kind: "response", body: { status: 500, code: "E_INTERNAL" } });
  });
});

describe("previewFsStep (budget + lazy initiation)", () => {
  it("never initiates the call when the budget is exhausted", async () => {
    let initiated = false;
    await expect(
      previewFsStep(
        () => {
          initiated = true;
          return Promise.resolve(1);
        },
        createReqDeadline(Date.now, 0),
        neverAbort(),
        { now: Date.now, tracker: createPreviewIoTracker() },
      ),
    ).rejects.toMatchObject({ ioFail: "deadline" });
    expect(initiated).toBe(false);
  });

  it("never initiates the call when the signal is already aborted", async () => {
    let initiated = false;
    const ctl = new AbortController();
    ctl.abort("client-abort");
    await expect(
      previewFsStep(
        () => {
          initiated = true;
          return Promise.resolve(1);
        },
        deadline(8000),
        ctl.signal,
        { now: Date.now, tracker: createPreviewIoTracker() },
      ),
    ).rejects.toMatchObject({ ioFail: "abort" });
    expect(initiated).toBe(false);
  });

  it("a hung call surfaces as deadline at the step cap (min(cap, remaining))", async () => {
    const t0 = Date.now();
    await expect(
      previewFsStep(() => new Promise<number>(() => undefined), deadline(8000), neverAbort(), {
        stepCapMs: 60,
        now: Date.now,
        tracker: createPreviewIoTracker(),
      }),
    ).rejects.toMatchObject({ ioFail: "deadline" });
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

describe("racePreviewIo", () => {
  it("a late underlying resolution is harmless (no unhandled rejection, promise settles)", async () => {
    let resolveLate!: (v: number) => void;
    const p = new Promise<number>((r) => {
      resolveLate = r;
    });
    await expect(racePreviewIo(p, Date.now() + 30, neverAbort(), Date.now)).rejects.toMatchObject({
      ioFail: "deadline",
    });
    resolveLate(7); // fires into the void — must not produce an unhandled rejection
    await new Promise((r) => setTimeout(r, 10).unref?.());
  });
});

describe("defaultPreviewFs (real adapter)", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("stat/open/positioned-read roundtrip on a real file", async () => {
    const fs = defaultPreviewFs();
    const dir = mkdtempSync(join(tmpdir(), "wh-fs-"));
    dirs.push(dir);
    const file = join(dir, "f.bin");
    writeFileSync(file, Buffer.alloc(1000, 0xab));
    const st = await fs.stat(file);
    expect(st.size).toBe(1000);
    expect(st.isFile()).toBe(true);
    const fh = await fs.open(file, PREVIEW_READ_FLAGS);
    try {
      const buf = Buffer.alloc(10);
      const { bytesRead } = await fh.read(buf, 0, 10, 990);
      expect(bytesRead).toBe(10);
      expect(buf.every((b) => b === 0xab)).toBe(true);
      const fst = await fh.stat();
      expect(fst.dev).toBe(st.dev);
      expect(fst.ino).toBe(st.ino);
    } finally {
      await fh.close();
      await fh.close(); // idempotent by construction
    }
  });

  it("read flags carry O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY; a final symlink refuses with ELOOP", async () => {
    expect(PREVIEW_READ_FLAGS & fsConstants.O_ACCMODE).toBe(fsConstants.O_RDONLY);
    for (const flag of [fsConstants.O_NOFOLLOW, fsConstants.O_NONBLOCK, fsConstants.O_NOCTTY]) {
      expect(PREVIEW_READ_FLAGS & flag).toBe(flag);
    }
    const fs = defaultPreviewFs();
    const dir = mkdtempSync(join(tmpdir(), "wh-fs2-"));
    dirs.push(dir);
    const realFile = join(dir, "real");
    writeFileSync(realFile, "x");
    const link = join(dir, "link");
    symlinkSync(realFile, link);
    await expect(fs.open(link, PREVIEW_READ_FLAGS)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("readlink resolves through /proc/self/fd for an open handle (the step-12 primitive)", async () => {
    const fs = defaultPreviewFs();
    const dir = mkdtempSync(join(tmpdir(), "wh-fs3-"));
    dirs.push(dir);
    const file = join(dir, "f");
    writeFileSync(file, "x");
    const fh = await fs.open(file, PREVIEW_READ_FLAGS);
    try {
      const target = await fs.readlink(`/proc/self/fd/${fh.fd}`);
      expect(target).toBe(file);
      expect(fs.procFdAvailable()).toBe(process.platform === "linux" ? true : fs.procFdAvailable());
    } finally {
      await fh.close();
    }
  });

  it("the verify task's /proc/self/fd re-open yields an INDEPENDENT positioned handle", async () => {
    const fs = defaultPreviewFs();
    const dir = mkdtempSync(join(tmpdir(), "wh-fs4-"));
    dirs.push(dir);
    const file = join(dir, "f");
    writeFileSync(file, Buffer.alloc(10, 0x01));
    const fh = await fs.open(file, PREVIEW_READ_FLAGS);
    const reopened = await fs.open(`/proc/self/fd/${fh.fd}`, fsConstants.O_RDONLY);
    await fh.close(); // original closed — the independent fd must keep working
    const buf = Buffer.alloc(10);
    const { bytesRead } = await reopened.read(buf, 0, 10, 0);
    expect(bytesRead).toBe(10);
    await reopened.close();
  });

  it("a deleted file's /proc fd readlink carries the (deleted) marker", async () => {
    const fs = defaultPreviewFs();
    const dir = mkdtempSync(join(tmpdir(), "wh-fs5-"));
    dirs.push(dir);
    const file = join(dir, "gone");
    writeFileSync(file, "x");
    const fh = await fs.open(file, PREVIEW_READ_FLAGS);
    rmSync(file);
    const target = await fs.readlink(`/proc/self/fd/${fh.fd}`);
    await fh.close();
    expect(target.endsWith(" (deleted)")).toBe(true); // admit step 12 rejects exactly this
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 §2.4 (P1a): PreviewIoTracker — the zombie-fs circuit breaker
// ---------------------------------------------------------------------------

describe("PreviewIoTracker (§2.4 state machine)", () => {
  it("default max is PREVIEW_FS_ZOMBIE_MAX = 2; a fresh tracker starts at 0", () => {
    const t = createPreviewIoTracker();
    expect(t.max).toBe(PREVIEW_FS_ZOMBIE_MAX);
    expect(PREVIEW_FS_ZOMBIE_MAX).toBe(2);
    expect(t.zombies).toBe(0);
  });

  it("a slow promise raced out counts zombies=1, and 0 again once it settles", async () => {
    const t = createPreviewIoTracker();
    let resolveLate!: (v: number) => void;
    const p = new Promise<number>((r) => {
      resolveLate = r;
    });
    await expect(racePreviewIo(p, Date.now() + 30, neverAbort(), Date.now, t)).rejects.toMatchObject({
      ioFail: "deadline",
    });
    expect(t.zombies).toBe(1);
    resolveLate(7);
    await new Promise((r) => setTimeout(r, 10).unref?.());
    expect(t.zombies).toBe(0);
  });

  it("two concurrent raced-out steps ⇒ a third previewFsStep fast-fails busy WITHOUT calling lazy", async () => {
    const t = createPreviewIoTracker();
    const hang = (): Promise<number> => new Promise<number>(() => undefined);
    const r1 = previewFsStep(hang, deadline(8000), neverAbort(), { stepCapMs: 40, now: Date.now, tracker: t });
    const r2 = previewFsStep(hang, deadline(8000), neverAbort(), { stepCapMs: 40, now: Date.now, tracker: t });
    await expect(r1).rejects.toMatchObject({ ioFail: "deadline" });
    await expect(r2).rejects.toMatchObject({ ioFail: "deadline" });
    expect(t.zombies).toBe(2);

    let initiated = false;
    await expect(
      previewFsStep(
        () => {
          initiated = true;
          return Promise.resolve(1);
        },
        deadline(8000),
        neverAbort(),
        { now: Date.now, tracker: t },
      ),
    ).rejects.toMatchObject({ ioFail: "busy" });
    expect(initiated).toBe(false); // lazy never ran — nothing new to count either
    expect(t.zombies).toBe(2); // unchanged: the refused step added nothing
  });

  it("the race side trips at most once (deadline + abort together still count 1, never 2)", async () => {
    const t = createPreviewIoTracker();
    const ctl = new AbortController();
    let resolveLate!: (v: number) => void;
    const p = new Promise<number>((r) => {
      resolveLate = r;
    });
    const raced = racePreviewIo(p, Date.now() + 25, ctl.signal, Date.now, t);
    setTimeout(() => ctl.abort("client-abort"), 30).unref?.(); // fires right after the deadline
    await expect(raced).rejects.toSatisfy((e: unknown) => e instanceof PreviewIoError);
    expect(t.zombies).toBe(1); // done-flag: the second race-side trip never counts
    resolveLate(1);
    await new Promise((r) => setTimeout(r, 10).unref?.());
    expect(t.zombies).toBe(0);
  });

  it("a lazy that throws SYNCHRONOUSLY counts nothing (running→settled, no abandon edge)", async () => {
    const t = createPreviewIoTracker();
    await expect(
      previewFsStep(
        () => {
          throw new Error("sync boom");
        },
        deadline(8000),
        neverAbort(),
        { now: Date.now, tracker: t },
      ),
    ).rejects.toThrow("sync boom");
    expect(t.zombies).toBe(0);
  });

  it("an underlying REJECT (not resolve) after a raced-out deadline also decrements", async () => {
    const t = createPreviewIoTracker();
    let rejectLate!: (e: Error) => void;
    const p = new Promise<number>((_r, rej) => {
      rejectLate = rej;
    });
    await expect(racePreviewIo(p, Date.now() + 25, neverAbort(), Date.now, t)).rejects.toMatchObject({
      ioFail: "deadline",
    });
    expect(t.zombies).toBe(1);
    rejectLate(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 10).unref?.());
    expect(t.zombies).toBe(0); // and no unhandled rejection escaped
  });

  it("a fresh tracker starts from 0 while an old one still holds zombies (the /reload shape)", async () => {
    const old = createPreviewIoTracker();
    const hang = new Promise<number>(() => undefined);
    await expect(racePreviewIo(hang, Date.now() + 20, neverAbort(), Date.now, old)).rejects.toMatchObject({
      ioFail: "deadline",
    });
    expect(old.zombies).toBe(1);
    const fresh = createPreviewIoTracker();
    expect(fresh.zombies).toBe(0);
    expect(fresh.max).toBe(old.max);
  });

  it("NO_TRACKER never trips (max = Infinity) even after abandons land on it", async () => {
    expect(NO_TRACKER.max).toBe(Infinity);
    const hang = new Promise<number>(() => undefined);
    await expect(
      previewFsStep(() => hang, deadline(8000), neverAbort(), { stepCapMs: 25, now: Date.now, tracker: NO_TRACKER }),
    ).rejects.toMatchObject({ ioFail: "deadline" });
    await expect(
      previewFsStep(() => hang, deadline(8000), neverAbort(), { stepCapMs: 25, now: Date.now, tracker: NO_TRACKER }),
    ).rejects.toMatchObject({ ioFail: "deadline" });
    // third step still RUNS (initiated ⇒ resolves) — the sentinel never circuit-breaks
    const v = await previewFsStep(() => Promise.resolve(42), deadline(8000), neverAbort(), {
      now: Date.now,
      tracker: NO_TRACKER,
    });
    expect(v).toBe(42);
  });

  it("racePreviewIo without a tracker keeps pre-§2.4 semantics (verify/stream's call shape)", async () => {
    let resolveLate!: (v: string) => void;
    const p = new Promise<string>((r) => {
      resolveLate = r;
    });
    await expect(racePreviewIo(p, Date.now() + 20, neverAbort(), Date.now)).rejects.toMatchObject({
      ioFail: "deadline",
    });
    resolveLate("x"); // no tracker anywhere — nothing to count, nothing to throw
    await new Promise((r) => setTimeout(r, 5).unref?.());
  });

  it("a raced-out fd-producing promise can still be closed by its own recovery (late-open 回收)", async () => {
    let closeCount = 0;
    let resolveLate!: (v: { fd: number; close(): Promise<void> }) => void;
    const p = new Promise<{ fd: number; close(): Promise<void> }>((r) => {
      resolveLate = r;
    });
    await expect(
      racePreviewIo(p, Date.now() + 20, neverAbort(), Date.now, createPreviewIoTracker()),
    ).rejects.toMatchObject({
      ioFail: "deadline",
    });
    const handle = { fd: 9, close: (): Promise<void> => (closeCount++, Promise.resolve()) };
    resolveLate(handle); // the caller's own recovery consumes the late fd
    await p;
    await handle.close();
    expect(closeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 §2.6 (P1a): resolvePreviewDenyContext
// ---------------------------------------------------------------------------

describe("resolvePreviewDenyContext (§2.6)", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const deps = (over: { fs?: object; stepCapMs?: number } = {}) => ({
    tracker: createPreviewIoTracker(),
    now: Date.now,
    log: memLog(),
    ...(over.fs === undefined ? {} : { fs: over.fs as object }),
    ...(over.stepCapMs === undefined ? {} : { stepCapMs: over.stepCapMs }),
  });

  it("returns literal + canonical deduped for symlinked home/agentDir (real tmpdir)", async () => {
    const t = mkdtempSync(join(tmpdir(), "wh-denyctx-"));
    dirs.push(t);
    const realHome = join(t, "real-home");
    mkdirSync(join(realHome, ".pi", "agent"), { recursive: true });
    symlinkSync(realHome, join(t, "home-link"));

    const ctx = await resolvePreviewDenyContext(
      { home: join(t, "home-link"), agentDir: join(realHome, ".pi/agent") },
      deps(),
    );
    expect(ctx.homes).toEqual([join(t, "home-link"), realHome]);
    expect(ctx.agentDirs).toEqual([join(realHome, ".pi/agent")]); // canonical === literal ⇒ deduped to one
  });

  it("a FAILING realpath degrades to literal-only and writes the path-free WARN", async () => {
    const log = memLog();
    const failing = { realpath: () => Promise.reject(errno("EIO")) };
    const ctx = await resolvePreviewDenyContext(
      { home: "/home/gone", agentDir: "/home/gone/.pi/agent" },
      { tracker: createPreviewIoTracker(), now: Date.now, log, fs: failing },
    );
    expect(ctx).toEqual({ homes: ["/home/gone"], agentDirs: ["/home/gone/.pi/agent"] });
    const warns = log.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(2);
    for (const w of warns) {
      expect(w.msg).toBe("preview deny context: realpath failed");
      expect(w.data).toEqual({ event: "preview.deny_ctx_degraded", which: expect.any(String) });
      expect(JSON.stringify(w)).not.toContain("/home/gone"); // never a path
    }
    expect(new Set(warns.map((w) => (w.data as { which: string }).which))).toEqual(new Set(["home", "agentDir"]));
  });

  it("a HANGING realpath (deadline) also degrades — never rejects the hub start", async () => {
    const log = memLog();
    const hanging = { realpath: () => new Promise<string>(() => undefined) };
    const ctx = await resolvePreviewDenyContext(
      { home: "/home/stuck", agentDir: "/home/stuck/.pi/agent" },
      { tracker: createPreviewIoTracker(), now: Date.now, log, fs: hanging, stepCapMs: 30 },
    );
    expect(ctx.homes).toEqual(["/home/stuck"]);
    expect(
      log.lines.some((l) => l.level === "warn" && (l.data as { event?: string }).event === "preview.deny_ctx_degraded"),
    ).toBe(true);
  });

  it("trailing slashes are normalized so segment-aligned prefix matching stays exact", async () => {
    const ctx = await resolvePreviewDenyContext({ home: "/home/x/", agentDir: "/home/x/.pi/agent/" }, deps());
    expect(ctx.homes).toEqual(["/home/x"]);
    expect(ctx.agentDirs).toEqual(["/home/x/.pi/agent"]);
  });
});

// ---------------------------------------------------------------------------
// dir-plan §3.1/§3.6: previewProcFdAvailable (exported for P1b's cap gate)
// ---------------------------------------------------------------------------

describe("previewProcFdAvailable (§3.6)", () => {
  it("mirrors the fs adapter's own procFdAvailable()", () => {
    expect(previewProcFdAvailable()).toBe(defaultPreviewFs().procFdAvailable());
  });
});
