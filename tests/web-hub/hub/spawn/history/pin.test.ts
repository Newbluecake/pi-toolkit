/**
 * web-hub session-history plan §4.5.6 (`pin.ts`): fd-anchored resolution, resume preflight, and
 * the path-based restore-preflight pair — all on a REAL tmp filesystem (E5/E8 mechanisms).
 */
import { linkSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import { createHistoryIoGate } from "../../../../../src/web-hub/hub/spawn/history/budget.js";
import { createFdLedger } from "../../../../../src/web-hub/hub/spawn/history/fd-ledger.js";
import {
  defaultHistoryFs,
  defaultHistorySyncFs,
  type HistoryFs,
} from "../../../../../src/web-hub/hub/spawn/history/fs.js";
import {
  createPinAdmission,
  getPinnedFileFd,
  makeCaptureSessionPathPin,
  makeVerifySessionPathPin,
  pinSession,
  verifyForSpawn,
  type PinAdmission,
} from "../../../../../src/web-hub/hub/spawn/history/pin.js";

const UID = process.getuid?.() ?? 0;

let root: string;
let sessionsDir: string;

function header(id: string, cwd: string): string {
  return `${JSON.stringify({ type: "session", id, cwd, timestamp: "t" })}\n`;
}

function deps(fs: HistoryFs = defaultHistoryFs(), admission: PinAdmission = createPinAdmission()) {
  return {
    agentDir: root,
    uid: UID,
    fs,
    gate: createHistoryIoGate(),
    ledger: createFdLedger(32),
    admission,
    now: () => Date.now(),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwh-pin-"));
  sessionsDir = join(root, "sessions");
  mkdirSync(join(sessionsDir, "d1"), { recursive: true });
  writeFileSync(join(sessionsDir, "d1", "f1.jsonl"), header("sess-aaaa1", "/w/p"));
});

describe("pinSession — happy path and fd anchoring", () => {
  it("resolves a valid key, returns the pin with correct fields, and release() is idempotent", async () => {
    const result = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.pin.id).toBe("sess-aaaa1");
    expect(result.pin.cwd).toBe("/w/p");
    expect(result.pin.abs.endsWith("/d1/f1.jsonl")).toBe(true);
    expect(getPinnedFileFd(result.pin)).toBeGreaterThan(0);
    result.pin.release();
    result.pin.release(); // idempotent
    expect(getPinnedFileFd(result.pin)).toBeUndefined();
  });

  it("invalid key shape ⇒ session-ref", async () => {
    const result = await pinSession(
      { key: "no-slash", id: "x" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(result).toMatchObject({ ok: false, status: 400, code: "E_BAD_REQUEST", reason: "session-ref" });
  });

  it("missing dir/file ⇒ session-missing", async () => {
    const r1 = await pinSession(
      { key: "nope/f.jsonl", id: "x" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(r1).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-missing" });
    const r2 = await pinSession(
      { key: "d1/nope.jsonl", id: "x" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(r2).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-missing" });
  });

  it("dir level is a symlink (E5b) ⇒ session-invalid", async () => {
    mkdirSync(join(sessionsDir, "outside"));
    symlinkSync(join(sessionsDir, "outside"), join(sessionsDir, "linkdir"));
    const result = await pinSession(
      { key: "linkdir/f1.jsonl", id: "x" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(result).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  });

  it("file is a symlink (E5c) ⇒ session-invalid", async () => {
    writeFileSync(join(sessionsDir, "d1", "real.jsonl"), header("sess-aaaa1", "/w/p"));
    symlinkSync(join(sessionsDir, "d1", "real.jsonl"), join(sessionsDir, "d1", "link.jsonl"));
    const result = await pinSession(
      { key: "d1/link.jsonl", id: "x" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(result).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  });

  it("file nlink > 1 (hardlink) ⇒ session-invalid", async () => {
    linkSync(join(sessionsDir, "d1", "f1.jsonl"), join(sessionsDir, "d1", "f1b.jsonl"));
    const result = await pinSession(
      { key: "d1/f1b.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(result).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  });

  it("header id/cwd mismatch ⇒ session-mismatch", async () => {
    const r1 = await pinSession(
      { key: "d1/f1.jsonl", id: "wrong-id" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(r1).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-mismatch" });
    const r2 = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/elsewhere",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    expect(r2).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-mismatch" });
  });

  it("owner mismatch (fake fstat) ⇒ session-invalid", async () => {
    const real = defaultHistoryFs();
    const fakeFs: HistoryFs = {
      ...real,
      open: async (p, flags, mode) => {
        const h = await real.open(p, flags, mode);
        return {
          fd: h.fd,
          read: (buf: Buffer, offset: number, length: number, position: number) =>
            h.read(buf, offset, length, position),
          write: (buf: Buffer, offset: number, length: number, position: number) =>
            h.write(buf, offset, length, position),
          truncate: (len: number) => h.truncate(len),
          close: () => h.close(),
          stat: async () => {
            const st = await h.stat();
            return { ...st, uid: st.uid + 999 };
          },
        };
      },
    };
    const result = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(fakeFs),
    );
    expect(result).toMatchObject({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  });

  it("resolve, then rename the dir and swap in a symlink ⇒ verifyForSpawn returns session-changed, and the PINNED fd still reads the ORIGINAL file (E5a)", async () => {
    const result = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    if (!result.ok) throw new Error("unreachable");
    const fd = getPinnedFileFd(result.pin);
    if (fd === undefined) throw new Error("unreachable");
    renameSync(join(sessionsDir, "d1"), join(sessionsDir, "d1.real"));
    symlinkSync(join(sessionsDir, "d1.real"), join(sessionsDir, "d1"));
    const verdict = verifyForSpawn(result.pin, defaultHistorySyncFs());
    expect(verdict).toEqual({ ok: false, reason: "session-changed" });
    // the fd still reads the original content via /proc/self/fd/<fd> even after the swap above
    const content = await readFile(`/proc/self/fd/${String(fd)}`, "utf8");
    expect(content).toContain("sess-aaaa1");
    result.pin.release();
  });

  it("an ancestor of sessionsRoot becomes a symlink ⇒ verifyForSpawn's realpath check fails", async () => {
    const result = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      deps(),
    );
    if (!result.ok) throw new Error("unreachable");
    renameSync(sessionsDir, `${sessionsDir}.real`);
    symlinkSync(`${sessionsDir}.real`, sessionsDir);
    const verdict = verifyForSpawn(result.pin, defaultHistorySyncFs());
    expect(verdict).toEqual({ ok: false, reason: "session-changed" });
    result.pin.release();
  });

  it("a timed-out budget ⇒ 504 E_DEADLINE, no fds leaked (ledger returns to 0)", async () => {
    const d = deps();
    const result = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 0),
      d,
    );
    expect(result).toMatchObject({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(d.ledger.counts().pin).toBe(0);
  });

  it("Finding 2b: a 5th concurrent pin ⇒ 504 E_DEADLINE (PinAdmission cap), never opens any fd", async () => {
    const admission = createPinAdmission();
    const sharedLedger = createFdLedger(32);
    const sharedGate = createHistoryIoGate();
    const sharedDeps = (): ReturnType<typeof deps> => ({
      agentDir: root,
      uid: UID,
      fs: defaultHistoryFs(),
      gate: sharedGate,
      ledger: sharedLedger,
      admission,
      now: () => Date.now(),
    });
    const pins: Array<{ release(): void }> = [];
    for (let i = 0; i < 4; i++) {
      const result = await pinSession(
        { key: "d1/f1.jsonl", id: "sess-aaaa1" },
        "/w/p",
        createReqDeadline(() => 0, 5000),
        sharedDeps(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) pins.push(result.pin);
    }
    expect(sharedLedger.counts().pin).toBe(12); // 4 pins * 3 fds each

    const fifth = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      sharedDeps(),
    );
    expect(fifth).toMatchObject({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(sharedLedger.counts().pin).toBe(12); // the 5th never opened any fd

    for (const pin of pins) pin.release();
    expect(sharedLedger.counts().pin).toBe(0);

    // the slot freed by a release() is immediately usable again.
    const again = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      sharedDeps(),
    );
    expect(again.ok).toBe(true);
    if (again.ok) again.pin.release();
  });

  it("Finding 1: a slow root open past the budget leaves a late open that boundedFdOpen closes, releasing the ledger back to baseline", async () => {
    const real = defaultHistoryFs();
    let resolveOpen: (() => void) | undefined;
    const closeSpy = vi.fn();
    const fakeFs: HistoryFs = {
      ...real,
      open: async (p, flags, mode) => {
        const isRoot = p === sessionsDir;
        if (isRoot) {
          await new Promise<void>((r) => (resolveOpen = r));
        }
        const h = await real.open(p, flags, mode);
        return {
          fd: h.fd,
          stat: () => h.stat(),
          read: (buf: Buffer, offset: number, length: number, position: number) =>
            h.read(buf, offset, length, position),
          write: (buf: Buffer, offset: number, length: number, position: number) =>
            h.write(buf, offset, length, position),
          truncate: (len: number) => h.truncate(len),
          close: () => {
            closeSpy();
            return h.close();
          },
        };
      },
    };
    const d = deps(fakeFs);
    const result = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5),
      d,
    );
    expect(result).toMatchObject({ ok: false, status: 504, code: "E_DEADLINE" });
    // the reservation stays held — the late open hasn't settled yet.
    expect(d.ledger.counts().pin).toBe(1);
    expect(closeSpy).not.toHaveBeenCalled();

    resolveOpen?.();
    await vi.waitFor(() => {
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(d.ledger.counts().pin).toBe(0);
    });
  });
});

describe("captureSessionPathPin (PD24 / v3.4 X1 — no sessionsRoot requirement)", () => {
  const capture = makeCaptureSessionPathPin(defaultHistorySyncFs());

  it("a well-formed abs path with a normal lstat chain ⇒ ok", () => {
    const abs = join(sessionsDir, "d1", "f1.jsonl");
    expect(capture(abs, UID).ok).toBe(true);
  });

  it("a path OUTSIDE any sessionsRoot concept still succeeds (X1 dropped the ownership check)", () => {
    const customDir = mkdtempSync(join(tmpdir(), "pwh-custom-"));
    mkdirSync(join(customDir, "sub"));
    writeFileSync(join(customDir, "sub", "s.jsonl"), "x");
    expect(capture(join(customDir, "sub", "s.jsonl"), UID).ok).toBe(true);
  });

  it("dir level is a symlink ⇒ fails", () => {
    mkdirSync(join(sessionsDir, "real2"));
    symlinkSync(join(sessionsDir, "real2"), join(sessionsDir, "link2"));
    writeFileSync(join(sessionsDir, "real2", "f.jsonl"), "x");
    expect(capture(join(sessionsDir, "link2", "f.jsonl"), UID).ok).toBe(false);
  });

  it("file nlink > 1 ⇒ fails", () => {
    linkSync(join(sessionsDir, "d1", "f1.jsonl"), join(sessionsDir, "d1", "hardlink.jsonl"));
    expect(capture(join(sessionsDir, "d1", "hardlink.jsonl"), UID).ok).toBe(false);
  });

  it("uid mismatch (fake sync fs) ⇒ fails", () => {
    const real = defaultHistorySyncFs();
    const fakeCapture = makeCaptureSessionPathPin({
      ...real,
      lstatSync: (p) => {
        const st = real.lstatSync(p);
        return p.endsWith("f1.jsonl") ? { ...st, uid: st.uid + 1 } : st;
      },
    });
    expect(fakeCapture(join(sessionsDir, "d1", "f1.jsonl"), UID).ok).toBe(false);
  });

  it("an ancestor symlink makes realpath(abs) !== abs ⇒ fails", () => {
    renameSync(sessionsDir, `${sessionsDir}.real`);
    symlinkSync(`${sessionsDir}.real`, sessionsDir);
    expect(capture(join(sessionsDir, "d1", "f1.jsonl"), UID).ok).toBe(false);
  });
});

describe("verifySessionPathPin", () => {
  const capture = makeCaptureSessionPathPin(defaultHistorySyncFs());
  const verify = makeVerifySessionPathPin(defaultHistorySyncFs());

  it("reported undefined ⇒ fails", () => {
    const pin = capture(join(sessionsDir, "d1", "f1.jsonl"), UID);
    if (!pin.ok) throw new Error("unreachable");
    expect(verify(pin.pin, undefined)).toEqual({ ok: false, detail: "sessionFile differs from launched path" });
  });

  it("reported with an extra trailing slash ⇒ fails (byte-equal required)", () => {
    const abs = join(sessionsDir, "d1", "f1.jsonl");
    const pin = capture(abs, UID);
    if (!pin.ok) throw new Error("unreachable");
    expect(verify(pin.pin, `${abs}/`).ok).toBe(false);
  });

  it("file replaced by a hardlink of itself inside a swapped directory ⇒ fails (dir dev/ino differ)", () => {
    const abs = join(sessionsDir, "d1", "f1.jsonl");
    const pin = capture(abs, UID);
    if (!pin.ok) throw new Error("unreachable");
    renameSync(join(sessionsDir, "d1"), join(sessionsDir, "d1.orig"));
    mkdirSync(join(sessionsDir, "d1"));
    linkSync(join(sessionsDir, "d1.orig", "f1.jsonl"), join(sessionsDir, "d1", "f1.jsonl"));
    expect(verify(pin.pin, abs).ok).toBe(false);
  });

  it("parent dir replaced by a symlink ⇒ fails", () => {
    const abs = join(sessionsDir, "d1", "f1.jsonl");
    const pin = capture(abs, UID);
    if (!pin.ok) throw new Error("unreachable");
    renameSync(join(sessionsDir, "d1"), join(sessionsDir, "d1.real"));
    symlinkSync(join(sessionsDir, "d1.real"), join(sessionsDir, "d1"));
    expect(verify(pin.pin, abs).ok).toBe(false);
  });

  it("unchanged ⇒ ok", () => {
    const abs = join(sessionsDir, "d1", "f1.jsonl");
    const pin = capture(abs, UID);
    if (!pin.ok) throw new Error("unreachable");
    expect(verify(pin.pin, abs)).toEqual({ ok: true });
  });
});
