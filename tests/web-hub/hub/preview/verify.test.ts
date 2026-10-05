/**
 * web-hub-preview plan v3 §4.5.3 / PV2a acceptance — `hub/preview/verify.ts`.
 *
 * Single-flight: 3 concurrent waiters on one identity ⇒ exactly ONE whole-file read (1
 * `hashed` + 2 `joined`); different identities never merge; a waiter disconnecting leaves the
 * task running for the others; the LAST waiter leaving aborts the task mid-read; task-budget
 * exhaustion ⇒ `verify-timeout` for everyone; a waiter's own earlier `waitUntil` ⇒
 * `verify-deadline` for it alone; hash-mismatch logs `error` exactly once; the identity cache
 * short-circuits (with a post re-stat) and is FIFO-capped; `dispose()` aborts everything.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PreviewHandle, PreviewStat } from "../../../../src/web-hub/hub/preview/admit.js";
import { isPreviewIoError } from "../../../../src/web-hub/hub/preview/fs.js";
import { createUploadVerifier } from "../../../../src/web-hub/hub/preview/verify.js";
import type { Identity } from "../../../../src/web-hub/hub/preview/verify.js";
import { fakeTaskFs, FakeHandle, memLog, neverAbort } from "./helpers.js";

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const KIB = 1024;

/** FakeHandle with sleeping reads — keeps the single-flight task alive long enough to join. */
class SlowHandle extends FakeHandle {
  constructor(
    content: Buffer,
    private readonly ms: number,
    private readonly readLog?: number[],
  ) {
    super(content);
  }

  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        super.read(buf, off, len, pos).then((r) => {
          this.readLog?.push(r.bytesRead);
          resolve(r);
        });
      }, this.ms);
      t.unref();
    });
  }
}

interface Rig {
  verifier: ReturnType<typeof createUploadVerifier>;
  log: ReturnType<typeof memLog>;
  taskOpens: string[];
  taskReads: number[];
  taskHandles: FakeHandle[];
  content: Buffer;
  waiter(
    uploadId?: string,
    identity?: Identity,
    over?: { waitUntil?: number; signal?: AbortSignal },
  ): {
    p: Promise<
      "cached" | "hashed" | "joined" | { fail: "hash-mismatch" | "verify-timeout" | "verify-deadline" | "io" }
    >;
    fh: PreviewHandle;
  };
}

function rig(content: Buffer, readMs = 20, verifyMs?: number): Rig {
  const log = memLog();
  const taskReads: number[] = [];
  const taskHandles: FakeHandle[] = [];
  const fs = fakeTaskFs(
    new Map<number, () => PreviewHandle>([
      [
        22, // FakeHandle.fd === stat ino
        () => {
          const h = new SlowHandle(content, readMs, taskReads);
          taskHandles.push(h);
          return h;
        },
      ],
    ]),
  );
  const verifier = createUploadVerifier({ fs, log, now: Date.now, verifyMs });
  const waiter: Rig["waiter"] = (uploadId = "u1", identity, over) => {
    const fh = new FakeHandle(content);
    const ident = identity ?? identityOf(fh);
    return {
      fh,
      p: verifier.verifyWhole(
        { uploadId, sha256: sha(content), fh, identity: ident },
        {
          signal: over?.signal ?? neverAbort(),
          waitUntil: over?.waitUntil ?? Date.now() + 5_000,
        },
      ),
    };
  };
  return { verifier, log, taskOpens: fs.opens, taskReads, taskHandles, content, waiter };
}

function identityOf(fh: PreviewHandle): Identity {
  // FakeHandle's synchronous stat shape — read without racing (test-only)
  return identityFrom((fh as FakeHandle).stat_);
}

function identityFrom(st: PreviewStat): Identity {
  return { dev: st.dev, ino: st.ino, size: st.size, ctimeMs: st.ctimeMs };
}

const totalOf = (reads: number[]): number => reads.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------

describe("verify: single-flight", () => {
  it("3 concurrent waiters on one identity ⇒ ONE whole-file read, 1 hashed + 2 joined", async () => {
    const content = Buffer.alloc(100 * KIB, 0x21); // 2 chunks
    const r = rig(content, 20);
    const [a, b, c] = [r.waiter(), r.waiter(), r.waiter()];
    const results = await Promise.all([a.p, b.p, c.p]);
    expect(results.sort()).toEqual(["hashed", "joined", "joined"]);
    expect(totalOf(r.taskReads)).toBe(content.length); // the file was hashed exactly once
    expect(r.taskHandles).toHaveLength(1);
    for (const h of r.taskHandles) expect(h.closeCount).toBe(1); // task fd closed
    for (const w of [a, b, c]) expect(w.fh.readCalls).toBe(0); // waiters' own fhs untouched
  });

  it("different identities of the same upload NEVER merge (two full reads, two hashed)", async () => {
    const content = Buffer.alloc(70 * KIB, 0x22);
    const r = rig(content, 10);
    const idA = { dev: 11, ino: 22, size: content.length, ctimeMs: 1000 };
    const idB = { dev: 11, ino: 22, size: content.length, ctimeMs: 2000 };
    const [ra, rb] = await Promise.all([r.waiter("u1", idA).p, r.waiter("u1", idB).p]);
    expect(ra).toBe("hashed");
    expect(rb).toBe("hashed");
    expect(totalOf(r.taskReads)).toBe(content.length * 2);
    expect(r.taskHandles).toHaveLength(2);
  });

  it("one waiter disconnecting does not disturb the others", async () => {
    const content = Buffer.alloc(70 * KIB, 0x23);
    const r = rig(content, 30);
    const a = r.waiter();
    const b = r.waiter();
    const ctl = new AbortController();
    const c = r.waiter("u1", undefined, { signal: ctl.signal });
    const t = setTimeout(() => ctl.abort("client-abort"), 10);
    t.unref();
    await expect(c.p).rejects.toSatisfy((e: unknown) => isPreviewIoError(e) && e.ioFail === "abort");
    const [ra, rb] = await Promise.all([a.p, b.p]);
    expect([ra, rb].sort()).toEqual(["hashed", "joined"]);
    expect(totalOf(r.taskReads)).toBe(content.length);
  });

  it("the LAST waiter leaving aborts the task mid-read (no orphan hashing)", async () => {
    const content = Buffer.alloc(200 * KIB, 0x24); // 4 chunks × 40ms
    const r = rig(content, 40);
    const ctl = new AbortController();
    const w = r.waiter("u1", undefined, { signal: ctl.signal });
    const t = setTimeout(() => ctl.abort("client-abort"), 10);
    t.unref();
    await expect(w.p).rejects.toSatisfy((e: unknown) => isPreviewIoError(e));
    await new Promise((res) => setTimeout(res, 150).unref?.()); // let the one in-flight read settle
    const settled = r.taskReads.length;
    expect(settled).toBeLessThan(4); // aborted before finishing the file
    await new Promise((res) => setTimeout(res, 120).unref?.());
    expect(r.taskReads.length).toBe(settled); // no NEW reads initiated after the abort
    expect(r.taskHandles[0]?.closeCount).toBe(1); // task fd still recovered
  });

  it("task budget exhausted ⇒ verify-timeout for every waiter, single error-free log", async () => {
    const content = Buffer.alloc(130 * KIB, 0x25);
    const r = rig(content, 200, 60); // first read alone blows the 60ms budget
    const [a, b] = [r.waiter(), r.waiter()];
    const [ra, rb] = await Promise.all([a.p, b.p]);
    expect(ra).toEqual({ fail: "verify-timeout" });
    expect(rb).toEqual({ fail: "verify-timeout" });
    expect(r.log.lines.filter((l) => l.level === "error")).toHaveLength(0);
  });

  it("a waiter's own waitUntil hitting first ⇒ verify-deadline for it alone", async () => {
    const content = Buffer.alloc(70 * KIB, 0x26);
    const r = rig(content, 120); // task needs ~240ms
    const patient = r.waiter(); // creator — stays for the whole task
    const early = r.waiter("u1", undefined, { waitUntil: Date.now() + 40 });
    expect(await early.p).toEqual({ fail: "verify-deadline" });
    expect(await patient.p).toBe("hashed"); // task kept running for the patient waiter
  });

  it("hash mismatch ⇒ every waiter fails, log.error recorded exactly ONCE", async () => {
    const content = Buffer.alloc(70 * KIB, 0x27);
    const log = memLog();
    const taskReads: number[] = [];
    const fs = fakeTaskFs(new Map([[22, () => new SlowHandle(content, 10, taskReads)]]));
    const verifier = createUploadVerifier({ fs, log, now: Date.now });
    const wrongSha = sha(Buffer.alloc(70 * KIB, 0x99));
    const mk = () => {
      const fh = new FakeHandle(content);
      return verifier.verifyWhole(
        { uploadId: "u1", sha256: wrongSha, fh, identity: identityOf(fh) },
        {
          signal: neverAbort(),
          waitUntil: Date.now() + 5_000,
        },
      );
    };
    const results = await Promise.all([mk(), mk(), mk()]);
    expect(results).toEqual([{ fail: "hash-mismatch" }, { fail: "hash-mismatch" }, { fail: "hash-mismatch" }]);
    expect(log.lines.filter((l) => l.level === "error")).toHaveLength(1);
    expect(totalOf(taskReads)).toBe(content.length); // still hashed only once
  });
});

// ---------------------------------------------------------------------------

describe("verify: identity cache", () => {
  it("remember + same identity + stable post ⇒ cached, zero task opens", async () => {
    const content = Buffer.from("cached content");
    const r = rig(content, 1);
    const fh = new FakeHandle(content);
    const ident = identityOf(fh);
    r.verifier.remember("u1", ident);
    const res = await r.verifier.verifyWhole(
      { uploadId: "u1", sha256: sha(content), fh, identity: ident },
      {
        signal: neverAbort(),
        waitUntil: Date.now() + 5_000,
      },
    );
    expect(res).toBe("cached");
    expect(r.taskOpens).toEqual([]);
  });

  it("cache is FIFO-capped: 512+ other entries evict the oldest", async () => {
    const content = Buffer.from("old identity");
    const r = rig(content, 1);
    const fh = new FakeHandle(content);
    const ident = identityOf(fh);
    r.verifier.remember("u-old", ident);
    for (let i = 0; i < 512; i += 1) {
      r.verifier.remember(`u-${i}`, { dev: 1, ino: i, size: 1, ctimeMs: 1 });
    }
    // u-old was the oldest insert → evicted → this falls through to single-flight
    const res = await r.verifier.verifyWhole(
      { uploadId: "u-old", sha256: sha(content), fh, identity: ident },
      {
        signal: neverAbort(),
        waitUntil: Date.now() + 5_000,
      },
    );
    expect(res).toBe("hashed");
    expect(r.taskOpens.length).toBe(1);
  });
});

describe("verify: dispose", () => {
  it("dispose aborts in-flight tasks (and is idempotent)", async () => {
    const content = Buffer.alloc(200 * KIB, 0x28);
    const r = rig(content, 40);
    const w = r.waiter();
    // give the task one read, then dispose
    const t = setTimeout(() => r.verifier.dispose(), 15);
    t.unref();
    // the waiter's OWN signal never aborted — the task was killed underneath it, which maps
    // to a fail-closed {fail:"io"} (PV3 aborts request signals around dispose anyway)
    expect(await w.p).toEqual({ fail: "io" });
    await new Promise((res) => setTimeout(res, 150).unref?.()); // in-flight read settles
    const reads = r.taskReads.length;
    await new Promise((res) => setTimeout(res, 120).unref?.());
    expect(r.taskReads.length).toBe(reads);
    expect(() => r.verifier.dispose()).not.toThrow(); // idempotent
  });
});
