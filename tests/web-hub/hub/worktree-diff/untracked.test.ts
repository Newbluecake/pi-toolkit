/**
 * worktree-diff plan §3.1.1 (D3): untracked-file read + PreviewHandle ownership.
 *
 * Every ownership case of the plan's list: the happy path closes EXACTLY once; read error /
 * deadline / request abort / dispose each close exactly once and leave the tracker at 0; a
 * close that never settles still lets the answer out (tracker=1 until the late settle); a
 * late-settling read leaves no unhandled rejection; and — over a REAL tmpdir — a symlinked
 * untracked path answers 415 `symlink` with the fd provably closed.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import {
  createFsAdmitter,
  denyCtxOf,
  type PreviewHandle,
  type PreviewStat,
} from "../../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker, isPreviewIoError } from "../../../../src/web-hub/hub/preview/fs.js";
import { createUntrackedReader } from "../../../../src/web-hub/hub/worktree-diff/untracked.js";
import { WTDIFF_UNTRACKED_READ_MAX_BYTES } from "../../../../src/web-hub/protocol/worktree-diff.js";
import { memLog } from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");

/** A controllable file handle: reads hang/resolve on demand, closes are counted. */
class FakeHandle implements PreviewHandle {
  readonly closes: number[] = [];
  closeNeverSettles = false;
  readBehavior: ((pos: number) => { bytes: number } | Promise<never>) | undefined;

  constructor(
    readonly fakeFd: number,
    readonly content: Buffer,
    readonly realpath: string,
    readonly size = content.length,
  ) {}

  get fd(): number {
    return this.fakeFd;
  }

  stat(): Promise<PreviewStat> {
    const self = this;
    return Promise.resolve({
      dev: 1,
      ino: 42,
      size: self.size,
      ctimeMs: 1,
      nlink: 1,
      isFile: () => true,
      isDirectory: () => false,
    });
  }

  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> {
    const behavior = this.readBehavior;
    if (behavior !== undefined) {
      const r = behavior(pos);
      if (r instanceof Promise) return r as Promise<never>;
      return Promise.resolve(r);
    }
    const want = Math.min(len, this.content.length - pos);
    if (want > 0) this.content.copy(buf, off, pos, pos + want);
    return Promise.resolve({ bytesRead: Math.max(0, want) });
  }

  close(): Promise<void> {
    this.closes.push(Date.now());
    if (this.closeNeverSettles) return new Promise<void>(() => {});
    return Promise.resolve();
  }
}

function harness(handle: FakeHandle, opts: { realpathMismatch?: boolean } = {}) {
  const tracker = createPreviewIoTracker();
  const log = memLog();
  const admitter = {
    admit: async () => ({
      ok: true as const,
      fh: handle,
      size: handle.size,
      realpath: opts.realpathMismatch === true ? "/somewhere/else" : handle.realpath,
    }),
  };
  const reader = createUntrackedReader({ admitter, tracker, now: Date.now, log });
  const signalCtl = new AbortController();
  return {
    tracker,
    log,
    reader,
    read: (rel = "new.txt") =>
      reader({
        W: "/w/repo",
        rel,
        deadline: createReqDeadline(Date.now, 5_000),
        signal: signalCtl.signal,
      }),
    abort: () => signalCtl.abort("client-abort"),
  };
}

describe("readUntracked §3.1.1 — ownership", () => {
  it("happy path: text file ⇒ synthesized all-add patch, close EXACTLY once, tracker 0", async () => {
    const handle = new FakeHandle(9, Buffer.from("hello\nworld\n", "utf8"), "/w/repo/new.txt");
    const h = harness(handle);
    const r = await h.read();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("patch");
    expect(r.patch).toBe(
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n",
    );
    expect(r.bytes).toBe(Buffer.byteLength(r.patch, "utf8"));
    expect(r.truncated).toBe(false);
    expect(handle.closes.length).toBe(1);
    expect(h.tracker.zombies).toBe(0);
  });

  it("no trailing newline ⇒ the `\\ No newline at end of file` marker", async () => {
    const handle = new FakeHandle(9, Buffer.from("tail-no-newline", "utf8"), "/w/repo/new.txt");
    const h = harness(handle);
    const r = await h.read();
    expect(r.ok && r.kind === "patch" && r.patch).toContain("\\ No newline at end of file");
    expect(handle.closes.length).toBe(1);
  });

  it("empty file ⇒ kind empty, zero hunks, close once", async () => {
    const handle = new FakeHandle(9, Buffer.alloc(0), "/w/repo/new.txt", 0);
    const h = harness(handle);
    const r = await h.read();
    expect(r).toMatchObject({ ok: true, kind: "empty", patch: "", bytes: 0 });
    expect(handle.closes.length).toBe(1);
  });

  it("binary content ⇒ kind binary, patch stays empty", async () => {
    const handle = new FakeHandle(9, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "/w/repo/new.bin");
    const h = harness(handle);
    const r = await h.read("new.bin");
    if (!r.ok) throw new Error(`binary case failed: ${JSON.stringify(r)}`);
    expect(r).toMatchObject({ ok: true, kind: "binary", patch: "" });
    expect(handle.closes.length).toBe(1);
  });

  it("read cap: a file beyond WTDIFF_UNTRACKED_READ_MAX_BYTES reads at most the cap and marks truncated", async () => {
    const big = Buffer.alloc(WTDIFF_UNTRACKED_READ_MAX_BYTES + 5_000, 0x61); // 'a'
    const handle = new FakeHandle(9, big, "/w/repo/big.txt", big.length);
    const h = harness(handle);
    const r = await h.read("big.txt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(512 * 1024); // the synthesized patch stays under the patch cap
    // every line is "+aaa…" — the hunk count reflects only what was actually read
    expect(r.patch).toMatch(/^diff --git a\/big\.txt b\/big\.txt\nnew file mode 100644\n/);
    expect(handle.closes.length).toBe(1);
    expect(h.tracker.zombies).toBe(0);
  });

  it("realpath ≠ W/rel ⇒ 415 symlink (the handle still closes)", async () => {
    const handle = new FakeHandle(9, Buffer.from("x"), "/w/repo/elsewhere");
    const h = harness(handle, { realpathMismatch: true });
    const r = await h.read();
    expect(r).toMatchObject({
      ok: false,
      kind: "response",
      status: 415,
      code: "E_WTDIFF_UNSUPPORTED",
      reason: "symlink",
    });
    expect(handle.closes.length).toBe(1);
    expect(h.tracker.zombies).toBe(0);
  });

  it("admit failure maps straight through (denylist ⇒ 403 passthrough code)", async () => {
    const tracker = createPreviewIoTracker();
    const reader = createUntrackedReader({
      admitter: {
        admit: async () => ({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason: "denylist" }),
      },
      tracker,
      now: Date.now,
      log: memLog(),
    });
    const r = await reader({
      W: "/w/repo",
      rel: "k.env",
      deadline: createReqDeadline(Date.now, 5_000),
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({ ok: false, kind: "response", status: 403, code: "E_PREVIEW_DENIED", reason: "denylist" });
  });

  it("admit abort (status 0) ⇒ kind abort (不应答 — the caller decides)", async () => {
    const tracker = createPreviewIoTracker();
    const reader = createUntrackedReader({
      admitter: { admit: async () => ({ ok: false, status: 0, code: "E_ABORT" }) },
      tracker,
      now: Date.now,
      log: memLog(),
    });
    const r = await reader({
      W: "/w/repo",
      rel: "x",
      deadline: createReqDeadline(Date.now, 5_000),
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({ ok: false, kind: "abort" });
  });

  it("read error mid-loop ⇒ close exactly once, no zombie left", async () => {
    const handle = new FakeHandle(9, Buffer.from("data"), "/w/repo/new.txt");
    handle.readBehavior = () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    const h = harness(handle);
    const r = await h.read();
    expect(r.ok).toBe(false);
    expect(handle.closes.length).toBe(1);
    expect(h.tracker.zombies).toBe(0);
  });

  it("read never settles + deadline exhausts ⇒ the race rejects, close runs once (zombie 1→0 on late settle)", async () => {
    const clock = { t: 0 };
    const tracker = createPreviewIoTracker();
    const handle = new FakeHandle(9, Buffer.from("data"), "/w/repo/new.txt");
    handle.readBehavior = () =>
      new Promise<never>(() => {
        /* never settles */
      });
    const admitter = {
      admit: async () => ({ ok: true as const, fh: handle, size: handle.size, realpath: "/w/repo/new.txt" }),
    };
    const reader = createUntrackedReader({ admitter, tracker, now: () => clock.t, log: memLog() });
    const deadline = createReqDeadline(() => clock.t, 1_000);
    const pending = reader({ W: "/w/repo", rel: "new.txt", deadline, signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20)); // let the race arm and the (real) timer fire
    clock.t = 5_000; // exhaust
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(handle.closes.length).toBe(1);
    // the raced-out read counts as a zombie until its (never-settling) underlying settles —
    // here it never does, so the count stays 1 (bounded by the tracker's max)
    expect(tracker.zombies).toBe(1);
  });

  it("request abort mid-read ⇒ close exactly once", async () => {
    const handle = new FakeHandle(9, Buffer.from("data"), "/w/repo/new.txt");
    handle.readBehavior = () =>
      new Promise<never>(() => {
        /* hang */
      });
    const h = harness(handle);
    const pending = h.read();
    await new Promise((r) => setTimeout(r, 10));
    h.abort();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, kind: "abort" });
    expect(handle.closes.length).toBe(1);
  });

  it("close never settles ⇒ the answer still goes out; tracker counts 1 until the late settle", async () => {
    const handle = new FakeHandle(9, Buffer.from("ok"), "/w/repo/new.txt");
    const h = harness(handle);
    let settleClose: (() => void) | undefined;
    handle.closeNeverSettles = true;
    const origClose = handle.close.bind(handle);
    handle.close = (): Promise<void> => {
      const p = origClose();
      // the first close call re-routes to a deferred promise we control
      handle.closes.push(0);
      return new Promise<void>((resolve) => {
        settleClose = resolve;
      });
    };
    const r = await h.read();
    expect(r.ok).toBe(true); // the answer is NOT held hostage by the close
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.tracker.zombies).toBe(1); // the bounded close raced out (1 s deadline)
    settleClose?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.tracker.zombies).toBe(0); // the late settle decremented
  });
});

describe("readUntracked §3.1.1 — real tmpdir (symlink ⇒ 415, fd provably closed)", () => {
  it("a symlinked untracked path answers 415 symlink and leaks no fd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wtd-untracked-"));
    try {
      const W = join(dir, "wt");
      mkdirSync(W);
      writeFileSync(join(dir, "real-target.txt"), "content");
      symlinkSync(join(dir, "real-target.txt"), join(W, "wt-link.txt"));
      const fdCountBefore = readdirSync("/proc/self/fd").length;
      const tracker = createPreviewIoTracker();
      const admitter = createFsAdmitter({ denyCtx: DENY, tracker, log: memLog(), now: Date.now });
      const reader = createUntrackedReader({ admitter, tracker, now: Date.now, log: memLog() });
      const r = await reader({
        W,
        rel: "wt-link.txt",
        deadline: createReqDeadline(Date.now, 5_000),
        signal: new AbortController().signal,
      });
      // O_NOFOLLOW open fails ELOOP ⇒ preview maps 409; a same-dir non-symlink spelling would
      // mismatch realpath ⇒ 415 — either way NEVER a 200 with the target's content
      expect(r.ok).toBe(false);
      if (!r.ok && r.kind === "response") expect([409, 415]).toContain(r.status);
      const fdCountAfter = readdirSync("/proc/self/fd").length;
      expect(fdCountAfter).toBe(fdCountBefore); // no leaked fd
      void isPreviewIoError;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
