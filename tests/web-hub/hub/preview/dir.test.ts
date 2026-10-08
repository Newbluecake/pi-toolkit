/**
 * dir-plan v3.1 §3.2/§3.3/§3.4 (P1b) acceptance — `hub/preview/dir.ts`'s `listPreviewDir`.
 *
 * Strategy: the listing kernel is driven over a fully scripted `PreviewFs` (FakeDirHandle from
 * ./helpers + an lstat fake), one case per §3.2 line: scan cap / complete, filter (denylist
 * uncounted per §2.8, dropped, lossy), dirs-first sort, entries cap, the lstat fan-out
 * (type revision, vanish, other-errno, statPartial, abort), the byte budget (1 KiB envelope
 * reserve, 1024-byte names, control-char escape amplification) and the defensive ≤512 KiB
 * assert; every ok listing must survive `parsePreviewDirListing` (the §1.3 hub⇄UI runtime
 * contract). §3.3 lifecycle: bounded close (never-settling close, late-settling opendir ⇒
 * lateClose), abort mid-scan, 504 on a hung readBatch, busy through a tripped tracker.
 * §3.4: the 5 s listing budget is the listing's OWN — pinned with fake timers at 4.8 s (still
 * ok) and 5.1 s (504). Plus one REAL-Linux end-to-end over `defaultPreviewFs` on a tmpdir.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  denyCtxOf,
  type PreviewDirDirent,
  type PreviewDirHandle,
  type PreviewFs,
  type PreviewHandle,
  type PreviewLstat,
} from "../../../../src/web-hub/hub/preview/admit.js";
import {
  defaultPreviewFs,
  PREVIEW_READ_FLAGS,
  PreviewIoError,
  racePreviewIo,
} from "../../../../src/web-hub/hub/preview/fs.js";
import { createPreviewIoTracker, type PreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";
import { listPreviewDir, type ListPreviewDirDeps } from "../../../../src/web-hub/hub/preview/dir.js";
import {
  parsePreviewDirListing,
  PREVIEW_DIR_BODY_MAX_BYTES,
  PREVIEW_DIR_ENTRIES_MAX,
  PREVIEW_DIR_LIST_MS,
  PREVIEW_DIR_SCAN_MAX,
  type PreviewDirListing,
} from "../../../../src/web-hub/protocol/preview.js";
import { FakeDirHandle, FakeHandle, fakeLstat, memLog, neverAbort, type MemLog } from "./helpers.js";

const DENY_CTX = denyCtxOf("/home/nobody", "/home/nobody/.pi/agent");
const REALPATH = "/srv/data";
const REQUEST_PATH = "/link-to-data";

type DirType = PreviewDirDirent["type"];

/** Scripted lstat: name → result (or thrown Error); default = plain file. */
type LstatScript = Record<string, "ENOENT" | Error | PreviewLstat>;

function makeFs(
  handle: PreviewDirHandle | (() => PreviewDirHandle),
  lstatScript: LstatScript = {},
): PreviewFs & { openedAt: string[]; lstated: string[] } {
  const openedAt: string[] = [];
  const lstated: string[] = [];
  const fail = { ...defaultPreviewFs() };
  return {
    ...fail,
    openedAt,
    lstated,
    realpath: () => fail.realpath("/nonexistent"),
    stat: () => fail.stat("/nonexistent"),
    open: () => fail.open("/nonexistent", 0),
    readlink: () => fail.readlink("/nonexistent"),
    opendir: (p) => {
      openedAt.push(p);
      return Promise.resolve(typeof handle === "function" ? handle() : handle);
    },
    lstat: (p) => {
      lstated.push(p);
      const name = p.slice(p.lastIndexOf("/") + 1);
      const hit = lstatScript[name];
      if (hit === "ENOENT") {
        const err = new Error("enoent") as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      if (hit instanceof Error) return Promise.reject(hit);
      return Promise.resolve(hit ?? fakeLstat({ size: name.length }));
    },
  };
}

interface Ctx {
  log: MemLog;
  tracker: PreviewIoTracker;
  fh: PreviewHandle;
  deps(fs: PreviewFs, stepCapMs?: number): ListPreviewDirDeps;
}

function ctx(fd = 77): Ctx {
  const log = memLog();
  const tracker = createPreviewIoTracker();
  const fh = new FakeHandle(Buffer.alloc(0), { ino: fd, dev: 5 });
  return {
    log,
    tracker,
    fh,
    deps(fs, stepCapMs) {
      return stepCapMs === undefined
        ? { fs, now: Date.now, log, tracker, denyCtx: DENY_CTX }
        : { fs, now: Date.now, log, tracker, denyCtx: DENY_CTX, stepCapMs };
    },
  };
}

const dirent = (name: string, type: DirType): PreviewDirDirent => ({ name, type });

/** every ok listing must satisfy the frozen UI parser (§1.3 runtime contract). */
function assertParserOk(listing: PreviewDirListing): void {
  const serialized = JSON.stringify(listing);
  const parsed = parsePreviewDirListing(JSON.parse(serialized), Buffer.byteLength(serialized));
  expect(parsed, `parsePreviewDirListing must accept: ${serialized.slice(0, 200)}`).toEqual(listing);
}

async function listOk(c: Ctx, fs: PreviewFs, stepCapMs?: number): Promise<PreviewDirListing> {
  const res = await listPreviewDir(
    c.deps(fs, stepCapMs),
    { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH },
    neverAbort(),
  );
  expect(res.ok).toBe(true);
  if (res.ok) return res.listing;
  throw new Error("unreachable");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) dirs2rm(d);
  vi.useRealTimers();
});
const dirs2rm = (d: string): void => rmSync(d, { recursive: true, force: true });
beforeEach(() => {
  dirs = [];
});

// ---------------------------------------------------------------------------
// §3.2 — the listing shape, line by line
// ---------------------------------------------------------------------------

describe("dir: §3.2 listing semantics", () => {
  it("happy path: scan → complete, dirs-first sort, lstat types/sizes/floor'd mtime, no truncation", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([
      [dirent("b.txt", "file"), dirent("zeta", "dir"), dirent("a.md", "file")],
      [dirent("s.lnk", "symlink")],
    ]);
    const fs = makeFs(handle, {
      zeta: fakeLstat({ isDirectory: () => true, isFile: () => false, mtimeMs: 20_000.9 }),
      "s.lnk": fakeLstat({ isSymbolicLink: () => true, isFile: () => false, size: 12 }),
    });
    const l = await listOk(c, fs);
    expect(l.entries.map((e) => e.name)).toEqual(["zeta", "a.md", "b.txt", "s.lnk"]); // dirs first, name order
    const zeta = l.entries[0]!;
    expect(zeta.type).toBe("dir");
    expect(zeta.size).toBeUndefined(); // only files carry size
    expect(zeta.mtimeMs).toBe(20_000); // floor
    const a = l.entries[1]!;
    expect(a.type).toBe("file");
    expect(a.size).toBe("a.md".length); // the fake's size = name length
    expect(a.mtimeMs).toBe(1234); // fakeLstat default 1234.5 floored
    expect(l.entries[3]!.type).toBe("symlink");
    expect(l.total).toBe(4);
    expect(l.scanned).toBe(4);
    expect(l.complete).toBe(true);
    expect(l.truncated).toBe(false);
    expect(l.limits).toEqual({ scan: false, entries: false, bytes: false });
    expect(l.vanished).toBe(0);
    expect(l.dropped).toBe(0);
    expect(l.statPartial).toBeUndefined();
    // the handle was listed through /proc/self/fd/<fd>, bound to the admitted inode (§3.6);
    // the fan-out lstat'ed every entry through the same anchor (order is worker-nondeterministic)
    expect(fs.openedAt).toEqual([`/proc/self/fd/${c.fh.fd}`]);
    expect([...fs.lstated].sort()).toEqual(
      ["a.md", "b.txt", "s.lnk", "zeta"].map((n) => `/proc/self/fd/${c.fh.fd}/${n}`).sort(),
    );
    assertParserOk(l);
  });

  it("case-folded compare with codepoint tiebreak (locale-free ordering)", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([
      [
        dirent("Beta", "file"),
        dirent("alpha", "file"),
        dirent("ALPHA", "file"),
        dirent("é", "file"),
        dirent("Z", "file"),
      ],
      [],
    ]);
    const fs = makeFs(handle);
    const l = await listOk(c, fs);
    // casefold tie ⇒ raw codepoint: "ALPHA" (A=65) < "alpha" (a=97)
    expect(l.entries.map((e) => e.name)).toEqual(["ALPHA", "alpha", "Beta", "Z", "é"]);
  });

  it("dotfiles are listed (greyed-out is a UI concern, not a filter)", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent(".hidden", "file"), dirent("visible", "file")], []]);
    const l = await listOk(c, makeFs(handle));
    expect(l.entries.map((e) => e.name)).toEqual([".hidden", "visible"]);
    expect(l.total).toBe(2);
  });

  it("multibyte names survive byte accounting and sorting", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent("é.md", "file"), dirent("😀.txt", "file"), dirent("a", "file")], []]);
    const l = await listOk(c, makeFs(handle));
    expect(l.entries.map((e) => e.name)).toEqual(["a", "é.md", "😀.txt"]);
    assertParserOk(l);
  });

  it("scan cap: 100k-entry directory reads exactly SCAN_MAX, limits.scan, complete:false", async () => {
    const c = ctx();
    let left = 100_000;
    const handle: PreviewDirHandle = {
      readBatch: (max) => {
        const n = Math.min(max, left);
        left -= n;
        const out: PreviewDirDirent[] = [];
        for (let i = 0; i < n; i += 1) out.push(dirent(`f${String(left + i).padStart(6, "0")}`, "file"));
        return Promise.resolve(out);
      },
      close: () => Promise.resolve(),
    };
    const l = await listOk(c, makeFs(handle));
    expect(l.scanned).toBe(PREVIEW_DIR_SCAN_MAX);
    expect(l.complete).toBe(false);
    expect(l.limits.scan).toBe(true);
    expect(l.limits.entries).toBe(true); // 10 000 filtered > 1 000 kept
    expect(l.truncated).toBe(true);
    expect(l.entries.length).toBe(PREVIEW_DIR_ENTRIES_MAX);
    expect(l.total).toBe(PREVIEW_DIR_SCAN_MAX);
    assertParserOk(l);
  });

  it("truncated stays true on a scan cut even when every surviving entry fits (complete:false)", async () => {
    const c = ctx();
    // 10 000 raw, all but two denied ⇒ total 2, but the scan cut still marks incomplete
    const batches: PreviewDirDirent[][] = [];
    let emitted = 0;
    for (let b = 0; b < Math.ceil(PREVIEW_DIR_SCAN_MAX / 256); b += 1) {
      const batch: PreviewDirDirent[] = [];
      for (let i = 0; i < 256 && emitted < PREVIEW_DIR_SCAN_MAX; i += 1) {
        batch.push(
          dirent(emitted === 0 ? "keep-a" : emitted === 1 ? "keep-b" : ".ssh", emitted === 0 ? "file" : "file"),
        );
        emitted += 1;
      }
      batches.push(batch);
    }
    const handle = new FakeDirHandle(batches);
    const l = await listOk(c, makeFs(handle));
    expect(l.scanned).toBe(PREVIEW_DIR_SCAN_MAX);
    expect(l.total).toBe(2);
    expect(l.entries.map((e) => e.name)).toEqual(["keep-a", "keep-b"]);
    expect(l.complete).toBe(false);
    expect(l.truncated).toBe(true);
    expect(l.limits.scan).toBe(true);
    expect(l.limits.entries).toBe(false); // only 2 survived the filter
  });

  it("entries cap alone: 1005 filtered ⇒ 1000 kept, limits.entries, complete:true, truncated:true", async () => {
    const c = ctx();
    const batch: PreviewDirDirent[] = [];
    for (let i = 0; i < 1005; i += 1) batch.push(dirent(`n${String(i).padStart(4, "0")}`, "file"));
    const handle = new FakeDirHandle([batch]);
    const l = await listOk(c, makeFs(handle));
    expect(l.total).toBe(1005);
    expect(l.entries.length).toBe(1000);
    expect(l.complete).toBe(true);
    expect(l.truncated).toBe(true);
    expect(l.limits.entries).toBe(true);
    expect(l.limits.scan).toBe(false);
    assertParserOk(l);
  });

  it("denylist entries vanish from the listing AND the count (no hidden.denied, §2.8)", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([
      [
        dirent(".ssh", "dir"),
        dirent("id_rsa", "file"),
        dirent("creds.pem", "file"),
        dirent("ok.txt", "file"),
        dirent("notes", "dir"),
      ],
      [],
    ]);
    const l = await listOk(c, makeFs(handle));
    expect(l.entries.map((e) => e.name)).toEqual(["notes", "ok.txt"]);
    expect(l.total).toBe(2); // the three denied are NOT counted
    expect(l.scanned).toBe(5); // the raw read still saw them
    expect("dropped" in l && l.dropped).toBe(0);
    expect(JSON.stringify(l)).not.toContain("ssh");
    expect(JSON.stringify(l)).not.toContain("id_rsa");
    expect(JSON.stringify(l)).not.toContain("hidden"); // the v2 field is gone for good
  });

  it("the request-path spelling denies too (literal/canonical double anchor)", async () => {
    const c = ctx();
    // `.config/pi` is denied as a contiguous subpath — anchored at the REQUEST path here
    const handle = new FakeDirHandle([[dirent("web-search.env", "file")], []]);
    const fs = makeFs(handle);
    const res = await listPreviewDir(
      c.deps(fs),
      { fh: c.fh, realpath: "/srv/data", requestPath: "/home/nobody/.config/pi" },
      neverAbort(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.entries).toEqual([]);
      expect(res.listing.total).toBe(0);
      expect(res.listing.scanned).toBe(1);
    }
  });

  it("over-long names are dropped and counted (NAME_MAX_BYTES)", async () => {
    const c = ctx();
    const long = "x".repeat(1025); // 1025 UTF-8 bytes > 1024
    const handle = new FakeDirHandle([[dirent(long, "file"), dirent("ok", "file")], []]);
    const l = await listOk(c, makeFs(handle));
    expect(l.entries.map((e) => e.name)).toEqual(["ok"]);
    expect(l.dropped).toBe(1);
    expect(l.total).toBe(1); // dropped does not count toward total
    expect(l.scanned).toBe(2);
  });

  it("a lossy-decoded name (U+FFFD) survives with lossy:true", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent("bad\ufffdname", "file"), dirent("clean", "file")], []]);
    const l = await listOk(c, makeFs(handle));
    expect(l.entries[0]!.lossy).toBe(true);
    expect(l.entries[1]!.lossy).toBeUndefined();
    assertParserOk(l);
  });

  it("lstat revises the dirent type (type is lstat's word, not readdir's)", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent("actually-dir", "file"), dirent("actually-file", "dir")], []]);
    const fs = makeFs(handle, {
      "actually-dir": fakeLstat({ isDirectory: () => true, isFile: () => false }),
      "actually-file": fakeLstat({ isFile: () => true, isDirectory: () => false, size: 42 }),
    });
    const l = await listOk(c, fs);
    expect(l.entries.find((e) => e.name === "actually-dir")!.type).toBe("dir");
    const f = l.entries.find((e) => e.name === "actually-file")!;
    expect(f.type).toBe("file");
    expect(f.size).toBe(42);
  });

  it("vanished: lstat ENOENT removes the entry, counts vanished, decrements total", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent("a", "file"), dirent("gone", "file"), dirent("z", "file")], []]);
    const l = await listOk(c, makeFs(handle, { gone: "ENOENT" }));
    expect(l.entries.map((e) => e.name)).toEqual(["a", "z"]);
    expect(l.vanished).toBe(1);
    expect(l.total).toBe(2);
    expect(l.truncated).toBe(false);
  });

  it("other lstat errno ⇒ the entry survives with its dirent type only (no size/mtime)", async () => {
    const c = ctx();
    const eperm = new Error("nope") as Error & { code: string };
    eperm.code = "EPERM";
    const handle = new FakeDirHandle([[dirent("locked", "file")], []]);
    const l = await listOk(c, makeFs(handle, { locked: eperm }));
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]!.type).toBe("file");
    expect(l.entries[0]!.size).toBeUndefined();
    expect(l.entries[0]!.mtimeMs).toBeUndefined();
    expect(l.vanished).toBe(0);
  });

  it("a hung lstat ⇒ that entry keeps its dirent type and statPartial:true; others complete", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent("hang", "file"), dirent("ok", "file")], []]);
    const fs = makeFs(handle, {});
    const hung: PreviewFs = {
      ...fs,
      lstat: (p) => (p.endsWith("/hang") ? new Promise(() => undefined) : fs.lstat(p)),
    };
    const l = await listOk(c, hung, 60); // 60ms step cap ⇒ the hung lstat races out
    expect(l.statPartial).toBe(true);
    const hang = l.entries.find((e) => e.name === "hang")!;
    expect(hang.size).toBeUndefined(); // dirent type only
    const ok = l.entries.find((e) => e.name === "ok")!;
    expect(ok.size).toBe(2); // unaffected
    assertParserOk(l);
  });

  it("regression (verifier 打回): once a worker hits deadline/busy, NO new lstat is issued", async () => {
    // 16 entries, 8 workers: each worker parks its FIRST lstat behind a gate, and the middle
    // entry e06 rejects with a raced-out PreviewIoError(deadline) ⇒ that worker sets
    // statPartial and returns. Releasing the in-flight gates must let those calls COMPLETE
    // (results preserved) but the workers must then stop — no index beyond the first 8 may
    // ever be lstat'ed (§3.2 "停止发起新的 lstat").
    const c = ctx();
    const batch: PreviewDirDirent[] = [];
    for (let i = 0; i < 16; i += 1) batch.push(dirent(`e${String(i).padStart(2, "0")}`, "file"));
    const handle = new FakeDirHandle([batch]);
    const base = makeFs(handle);
    const releaseQueue: Array<() => void> = [];
    const gated: PreviewFs = {
      ...base,
      lstat: (p) => {
        base.lstated.push(p);
        const name = p.slice(p.lastIndexOf("/") + 1);
        if (name === "e06") {
          return Promise.reject(new PreviewIoError("deadline", "injected mid-fan-out"));
        }
        // the FIRST 8 calls (one per worker) park behind gates; anything after that resolves
        // immediately — under the regression the count assert fails cleanly instead of hanging
        if (base.lstated.length <= 8) {
          return new Promise<PreviewLstat>((resolve) => {
            releaseQueue.push(() => resolve(fakeLstat({ size: name.length })));
          });
        }
        return Promise.resolve(fakeLstat({ size: name.length }));
      },
    };
    const p = listPreviewDir(c.deps(gated), { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH }, neverAbort());
    await sleep(60); // all 8 workers issued their first lstat (7 parked, e06 already raced out)
    expect(base.lstated).toHaveLength(8); // exactly the first fan-out round, nothing more yet
    expect(releaseQueue).toHaveLength(7); // 8 issued − the rejected e06
    for (const release of releaseQueue.splice(0)) release(); // in-flight calls complete
    const res = await p;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const l = res.listing;
    expect(l.statPartial).toBe(true);
    // THE regression pin: still exactly 8 lstat calls — no worker took a 9th index after the
    // deadline landed
    expect(base.lstated).toHaveLength(8);
    expect(l.entries).toHaveLength(16);
    // in-flight results preserved (size applied)
    for (const n of ["e00", "e01", "e02", "e03", "e04", "e05", "e07"]) {
      expect(l.entries.find((e) => e.name === n)!.size).toBe(n.length);
    }
    // e06 (the deadline itself) and every never-issued index keep their dirent type only
    for (const e of l.entries) {
      if (!["e00", "e01", "e02", "e03", "e04", "e05", "e07"].includes(e.name)) {
        expect(e.size, e.name).toBeUndefined();
        expect(e.mtimeMs, e.name).toBeUndefined();
      }
    }
    assertParserOk(l);
  });

  it("byte cap: 1000 entries × 1024-byte names ⇒ limits.bytes and the body ≤ 512 KiB", async () => {
    const c = ctx();
    const batch: PreviewDirDirent[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const suffix = String(i).padStart(5, "0");
      batch.push(dirent("n".repeat(1024 - suffix.length) + suffix, "file")); // exactly 1024 bytes
    }
    const handle = new FakeDirHandle([batch]);
    const l = await listOk(c, makeFs(handle));
    expect(l.entries.every((e) => Buffer.byteLength(e.name) === 1024)).toBe(true);
    expect(l.limits.bytes).toBe(true);
    expect(l.entries.length).toBeGreaterThan(300);
    expect(l.entries.length).toBeLessThan(PREVIEW_DIR_ENTRIES_MAX);
    const serialized = Buffer.byteLength(JSON.stringify(l));
    expect(serialized).toBeLessThanOrEqual(PREVIEW_DIR_BODY_MAX_BYTES);
    expect(serialized).toBeGreaterThan(400 * 1024);
    expect(l.total).toBe(1000); // total keeps the FULL filtered count past the byte cut
    expect(l.truncated).toBe(true);
    assertParserOk(l);
  });

  it("control characters amplify under JSON escaping (≈6×) — the byte layer catches what naive byte math misses", async () => {
    const c = ctx();
    const batch: PreviewDirDirent[] = [];
    for (let i = 0; i < 400; i += 1) {
      // 301 UTF-8 bytes (< NAME_MAX) but ≈1806 serialized bytes ("\u0001" × 300)
      batch.push(dirent(`a${"".repeat(0)}${"\u0001".repeat(300)}${i}`, "file"));
    }
    const handle = new FakeDirHandle([batch]);
    const l = await listOk(c, makeFs(handle));
    expect(l.limits.bytes).toBe(true);
    const serialized = Buffer.byteLength(JSON.stringify(l));
    expect(serialized).toBeLessThanOrEqual(PREVIEW_DIR_BODY_MAX_BYTES);
    // without the escape amplification 400×(301+~90) ≈ 156 KiB would NOT have tripped the cap
    expect(l.entries.length).toBeLessThan(400);
    expect(l.total).toBe(400);
  });

  it("empty directory: zero entries, complete, not truncated, parser-ok", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[]]);
    const l = await listOk(c, makeFs(handle));
    expect(l.entries).toEqual([]);
    expect(l.total).toBe(0);
    expect(l.scanned).toBe(0);
    expect(l.complete).toBe(true);
    expect(l.truncated).toBe(false);
    assertParserOk(l);
  });
});

// ---------------------------------------------------------------------------
// §3.3 — lifecycle: bounded close, lateClose, abort, error mapping
// ---------------------------------------------------------------------------

describe("dir: §3.3 lifecycle", () => {
  it("a never-settling close: the listing still resolves (≤ ~1 s extra), zombie counted, late settle decrements", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent("a", "file")], []]);
    handle.closeGate = new Promise(() => undefined); // never settles
    const t0 = Date.now();
    const l = await listOk(c, makeFs(handle));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // boundedClose really waited…
    expect(Date.now() - t0).toBeLessThan(2_000); // …but gave up at the 1 s bound
    expect(l.entries).toHaveLength(1); // the answer itself was never at risk
    expect(c.tracker.zombies).toBe(1); // the timed-out close race
  });

  it("close settling late decrements the tracker back to 0", async () => {
    const c = ctx();
    const handle = new FakeDirHandle([[dirent("a", "file")], []]);
    let releaseClose!: () => void;
    handle.closeGate = new Promise<void>((r) => {
      releaseClose = r;
    });
    const p = listOk(c, makeFs(handle));
    setTimeout(() => releaseClose(), 1_400).unref?.(); // settles AFTER the 1 s bound
    await p;
    expect(c.tracker.zombies).toBe(1);
    await sleep(600); // let the late settle land
    expect(c.tracker.zombies).toBe(0);
  });

  it("a late-resolving opendir: the handle is lateClosed on its own bounded race (tracker returns to 0)", async () => {
    const c = ctx();
    let releaseOpen!: () => void;
    const gate = new Promise<void>((r) => {
      releaseOpen = r;
    });
    const lateHandle = new FakeDirHandle([[dirent("a", "file")], []]);
    const fs = makeFs(() => lateHandle);
    const fsGated: PreviewFs = {
      ...fs,
      opendir: (p) => {
        fs.openedAt.push(p);
        return gate.then(() => Promise.resolve(lateHandle));
      },
    };
    const res = await listPreviewDir(
      c.deps(fsGated, 50),
      { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH },
      neverAbort(),
    );
    expect(res).toMatchObject({ ok: false, abort: false, status: 504, code: "E_DEADLINE" }); // step cap raced out
    expect(c.tracker.zombies).toBe(1); // the opendir race
    releaseOpen();
    await sleep(80); // lateClose's own bounded race runs, the handle closes, both settle
    expect(lateHandle.closeCount).toBeGreaterThanOrEqual(1);
    expect(c.tracker.zombies).toBe(0);
  });

  it("a hung readBatch ⇒ 504 E_DEADLINE (opendir/readBatch 超时)", async () => {
    const c = ctx();
    const handle: PreviewDirHandle = {
      readBatch: () => new Promise(() => undefined),
      close: () => Promise.resolve(),
    };
    const res = await listPreviewDir(
      c.deps(makeFs(handle), 60),
      { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH },
      neverAbort(),
    );
    expect(res).toEqual({ ok: false, abort: false, status: 504, code: "E_DEADLINE" });
    expect(handle.close).toBeDefined;
  });

  it("a tripped tracker ⇒ 503 E_BUSY with Retry-After, before any opendir I/O", async () => {
    const c = ctx();
    // pre-trip: two raced-out raw racePreviewIo promises on the same tracker (§2.4 max = 2)
    const hang = new Promise<string>(() => undefined);
    void racePreviewIo(hang, Date.now() + 1, undefined, Date.now, c.tracker).catch(() => undefined);
    await sleep(20);
    void racePreviewIo(hang, Date.now() + 1, undefined, Date.now, c.tracker).catch(() => undefined);
    await sleep(20);
    expect(c.tracker.zombies).toBe(2);
    const fs = makeFs(new FakeDirHandle([[dirent("a", "file")], []]));
    const res = await listPreviewDir(
      c.deps(fs),
      { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH },
      neverAbort(),
    );
    expect(res).toMatchObject({ ok: false, abort: false, status: 503, code: "E_BUSY", retryAfterS: 1 });
    expect(fs.openedAt).toEqual([]); // busy fast-fails BEFORE the lazy opendir runs
  });

  it("mid-scan abort ⇒ {abort:true}, and the handle is still closed (bounded, signal-free)", async () => {
    const c = ctx();
    const ctl = new AbortController();
    let closeCount = 0;
    // the GATE lives on the handle (listPreviewDir drives handle.readBatch, not fs.readBatch)
    const parked: PreviewDirHandle = {
      readBatch: () => new Promise(() => undefined),
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
    };
    const fs = makeFs(() => parked);
    const res = listPreviewDir(c.deps(fs), { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH }, ctl.signal);
    setTimeout(() => ctl.abort("client-abort"), 30).unref?.();
    expect(await res).toEqual({ ok: false, abort: true });
    expect(closeCount).toBe(1); // the finally's boundedClose ran despite the abort
  });

  it("a raw fs error from opendir maps through mapFsError (EACCES ⇒ 403 unreadable)", async () => {
    const c = ctx();
    const eacces = new Error("x") as Error & { code: string };
    eacces.code = "EACCES";
    const fsGated: PreviewFs = { ...makeFs(new FakeDirHandle([])), opendir: () => Promise.reject(eacces) };
    const res = await listPreviewDir(
      c.deps(fsGated),
      { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH },
      neverAbort(),
    );
    expect(res).toEqual({ ok: false, abort: false, status: 403, code: "E_PREVIEW_DENIED", reason: "unreadable" });
  });
});

// ---------------------------------------------------------------------------
// §3.4 — the listing budget is the listing's OWN 5 s (fake-timer pinned)
// ---------------------------------------------------------------------------

describe("dir: §3.4 listing budget", () => {
  it("slow-but-inside batches: at ~4.8 s of the 5 s budget the listing still completes", async () => {
    vi.useFakeTimers();
    const c = ctx();
    const batches: PreviewDirDirent[][] = [];
    for (let i = 0; i < 8; i += 1) batches.push([dirent(`b${i}`, "file")]);
    const handle: PreviewDirHandle = {
      readBatch: async (max) => {
        void max;
        const b = batches.shift();
        if (b === undefined) return null; // EOF answers immediately (the data batches carry the delay)
        await sleep(600); // 8 × 600 ms = 4.8 s of the listing budget
        return b;
      },
      close: () => Promise.resolve(),
    };
    const fs = makeFs(handle);
    const p = listPreviewDir(
      { ...c.deps(fs, 6_000) }, // step cap ABOVE the listing budget ⇒ the listing cap is the binding one
      { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH },
      neverAbort(),
    );
    // drive 4.8 s of fake time; every batch lands inside the budget
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(600);
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.listing.entries).toHaveLength(8);
      expect(res.listing.complete).toBe(true);
    }
  });

  it("a readBatch hanging past 5 s ⇒ 504 E_DEADLINE (and not a step-cap artifact)", async () => {
    vi.useFakeTimers();
    const c = ctx();
    const handle: PreviewDirHandle = {
      readBatch: () => new Promise(() => undefined),
      close: () => Promise.resolve(),
    };
    const fs = makeFs(handle);
    const p = listPreviewDir(
      c.deps(fs, 6_000), // step cap 6 s > listing 5 s ⇒ only the LISTING deadline can fire
      { fh: c.fh, realpath: REALPATH, requestPath: REQUEST_PATH },
      neverAbort(),
    );
    await vi.advanceTimersByTimeAsync(4_900);
    // not yet rejected at 4.9 s — the listing budget has not expired
    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200); // 5.1 s total
    await expect(p).resolves.toMatchObject({ ok: false, abort: false, status: 504, code: "E_DEADLINE" });
  });
});

// ---------------------------------------------------------------------------
// real-Linux end-to-end: defaultPreviewFs opendir("/proc/self/fd/N") + lstat 不跟随
// ---------------------------------------------------------------------------

describe("dir: real /proc/self/fd listing (Linux)", () => {
  it("a real tmpdir lists through the admitted fd, with symlink entries typed by lstat", async () => {
    const real = defaultPreviewFs();
    if (!real.procFdAvailable()) return; // §3.6 residual
    const root = mkdtempSync(join(tmpdir(), "wh-p1b-dir-"));
    dirs.push(root);
    writeFileSync(join(root, "one.txt"), "12345");
    writeFileSync(join(root, "two.txt"), "1");
    mkdirSync(join(root, "sub"));
    symlinkSync("one.txt", join(root, "link.txt"));
    const fh = await real.open(root, PREVIEW_READ_FLAGS);
    try {
      const c = ctx(fh.fd);
      const res = await listPreviewDir(
        { fs: real, now: Date.now, log: c.log, tracker: c.tracker, denyCtx: DENY_CTX },
        { fh, realpath: root, requestPath: root },
        neverAbort(),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const l = res.listing;
      expect(l.entries.map((e) => e.name)).toEqual(["sub", "link.txt", "one.txt", "two.txt"]);
      const link = l.entries.find((e) => e.name === "link.txt")!;
      expect(link.type).toBe("symlink"); // lstat did NOT follow the entry's own symlink
      const one = l.entries.find((e) => e.name === "one.txt")!;
      expect(one.type).toBe("file");
      expect(one.size).toBe(5);
      expect(one.mtimeMs).toBeGreaterThan(0);
      const sub = l.entries.find((e) => e.name === "sub")!;
      expect(sub.type).toBe("dir");
      expect(sub.size).toBeUndefined();
      expect(l.complete).toBe(true);
      assertParserOk(l);
      // the on-disk readdir cross-check
      expect(readdirSync(root).sort()).toEqual(["link.txt", "one.txt", "sub", "two.txt"]);
    } finally {
      await fh.close();
    }
  });
});
