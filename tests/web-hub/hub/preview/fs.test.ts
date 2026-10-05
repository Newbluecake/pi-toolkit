/**
 * web-hub-preview plan v3 §4.3 (mapping table) / PV2a — `hub/preview/fs.ts`.
 *
 * The fs error → HTTP mapping table row by row; `previewFsStep`'s lazy initiation and step
 * cap; the real adapter's roundtrip on a tmpdir (incl. the O_NOFOLLOW symlink refusal and the
 * idempotent close); `racePreviewIo`'s deadline/abort classification.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultPreviewFs,
  mapFsError,
  PREVIEW_READ_FLAGS,
  previewFsStep,
  PreviewIoError,
  racePreviewIo,
} from "../../../../src/web-hub/hub/preview/fs.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { deadline, neverAbort } from "./helpers.js";

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
        { now: Date.now },
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
        { now: Date.now },
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
