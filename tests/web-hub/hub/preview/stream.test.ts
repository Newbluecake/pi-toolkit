/**
 * web-hub-preview plan v3 §4.5.2 / PV2a acceptance — `hub/preview/stream.ts`.
 *
 * Text truncation + UTF-8 cut point; images at exactly the byte cap and cap+1 (the kernel is
 * boundary-agnostic — §3.1 ⑧ owns the 413); grow/shrink; slow client; abort closes the fd;
 * hub-close before/after the head; image hash-mismatch/identity-change ⇒ destroy with
 * bytes < size; images never call verifyWhole and re-hash every run; the source-order
 * assertion (verifyWhole only inside streamText, before its writeHead); the text cache-hit /
 * post-changed path falling back to single-flight BEFORE the head; every timer unref'd.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewHandle, PreviewStat } from "../../../../src/web-hub/hub/preview/admit.js";
import { readAndStream } from "../../../../src/web-hub/hub/preview/stream.js";
import type { PreviewSink, StreamOutcome } from "../../../../src/web-hub/hub/preview/stream.js";
import { createUploadVerifier } from "../../../../src/web-hub/hub/preview/verify.js";
import type { Identity, UploadVerifier } from "../../../../src/web-hub/hub/preview/verify.js";
import {
  PREVIEW_HDR,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
} from "../../../../src/web-hub/protocol/preview.js";
import { FakeHandle, FakeSink, fakeStat, fakeTaskFs, memLog, neverAbort } from "./helpers.js";

const KIB = 1024;
const MIB = 1024 * 1024;
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

const pngSniff = { kind: "image" as const, mime: "image/png" as const, dims: { w: 2, h: 3 } };

interface Src {
  fh: PreviewHandle;
  size: number;
  sniff: { kind: "image"; mime: "image/png"; dims: { w: number; h: number } } | { kind: "text" };
  sample: Buffer;
  verify?: { uploadId: string; sha256: string };
}

function imageSrc(content: Buffer, expectedSha?: string): Src {
  return {
    fh: new FakeHandle(content),
    size: content.length,
    sniff: pngSniff,
    sample: content.subarray(0, Math.min(content.length, 64 * KIB)),
    verify: expectedSha === undefined ? undefined : { uploadId: "u1", sha256: expectedSha },
  };
}

function textSrc(content: Buffer, size = content.length, verify?: { uploadId: string; sha256: string }): Src {
  return {
    fh: new FakeHandle(content),
    size,
    sniff: { kind: "text" },
    sample: content.subarray(0, Math.min(content.length, 64 * KIB)),
    verify,
  };
}

const fakeVerifier = (
  ret: "cached" | "hashed" | "joined" | { fail: "hash-mismatch" | "verify-timeout" | "verify-deadline" | "io" },
): UploadVerifier & { calls: number; remembered: { uploadId: string; identity: Identity }[] } => {
  const v = {
    calls: 0,
    remembered: [] as { uploadId: string; identity: Identity }[],
    verifyWhole: async () => {
      v.calls += 1;
      return ret;
    },
    remember: (uploadId: string, identity: Identity) => {
      v.remembered.push({ uploadId, identity });
    },
    dispose: () => undefined,
  };
  return v as unknown as UploadVerifier & { calls: number; remembered: { uploadId: string; identity: Identity }[] };
};

const opts = (over: Partial<Parameters<typeof readAndStream>[2]> = {}) => ({
  signal: neverAbort(),
  streamAt: 5_000,
  textMax: PREVIEW_TEXT_MAX_BYTES,
  now: Date.now,
  verifier: fakeVerifier("cached"),
  ...over,
});

/** FakeHandle whose stat() answers from a scripted queue (TOCTOU/identity scripting). */
class ScriptedHandle extends FakeHandle {
  private readonly queue: PreviewStat[];

  constructor(content: Buffer, stats: PreviewStat[]) {
    super(content);
    this.queue = [...stats];
  }

  stat(): Promise<PreviewStat> {
    const s = this.queue.length > 0 ? this.queue.shift()! : this.stat_;
    return Promise.resolve({ ...s, isFile: () => s.isFile() });
  }
}

/** FakeHandle with slow positioned reads (abort windows). */
class SlowReadHandle extends FakeHandle {
  constructor(
    content: Buffer,
    private readonly ms: number,
  ) {
    super(content);
  }

  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        super.read(buf, off, len, pos).then(resolve);
      }, this.ms);
      t.unref();
    });
  }
}

/** FakeHandle whose stat() is slow (pre-head abort window). */
class SlowStatHandle extends FakeHandle {
  constructor(
    content: Buffer,
    private readonly ms: number,
  ) {
    super(content);
  }

  stat(): Promise<PreviewStat> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ...this.stat_, isFile: () => this.stat_.isFile() }), this.ms);
      t.unref();
    });
  }
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

describe("stream: text", () => {
  it("small text streams verbatim with the right headers", async () => {
    const content = Buffer.from("héllo wörld", "utf8");
    const sink = new FakeSink();
    const out = await readAndStream(textSrc(content), sink, opts());
    expect(out).toEqual({ ok: true, bytes: content.length, truncated: false });
    expect(sink.body().toString("utf8")).toBe("héllo wörld");
    expect(sink.head?.status).toBe(200);
    expect(sink.head?.headers).toMatchObject({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(content.length),
      [PREVIEW_HDR.kind]: "text",
      [PREVIEW_HDR.size]: String(content.length),
      [PREVIEW_HDR.truncated]: "0",
      "Content-Disposition": 'attachment; filename="preview"',
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    expect(sink.ended).toBe(true);
  });

  it("truncation cuts on a UTF-8 character boundary", async () => {
    // 256 KiB - 1 bytes of 'a', then a 2-byte é whose LEAD byte is the last included byte
    const prefix = Buffer.alloc(PREVIEW_TEXT_MAX_BYTES - 1, 0x61);
    const content = Buffer.concat([prefix, Buffer.from("éöö", "utf8"), Buffer.alloc(64, 0x62)]);
    expect(content[PREVIEW_TEXT_MAX_BYTES - 1]).toBe(0xc3); // é straddles the cap exactly
    const sink = new FakeSink();
    const out = await readAndStream(textSrc(content), sink, opts());
    expect(out).toEqual({ ok: true, bytes: PREVIEW_TEXT_MAX_BYTES - 1, truncated: true });
    expect(sink.body().length).toBe(PREVIEW_TEXT_MAX_BYTES - 1);
    expect(sink.head?.headers[PREVIEW_HDR.truncated]).toBe("1");
    expect(sink.head?.headers[PREVIEW_HDR.size]).toBe(String(content.length));
    expect(sink.head?.headers["Content-Length"]).toBe(String(PREVIEW_TEXT_MAX_BYTES - 1));
    // the served prefix is valid UTF-8 (no split é)
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(sink.body())).not.toThrow();
  });

  it("cwd text: identity change between pre and post ⇒ fail BEFORE the head (no body sent)", async () => {
    const content = Buffer.from("stable text");
    const fh = new ScriptedHandle(content, [
      fakeStat({ size: content.length, ctimeMs: 1000 }),
      fakeStat({ size: content.length, ctimeMs: 2000 }),
    ]);
    const sink = new FakeSink();
    const out = await readAndStream(
      { fh, size: content.length, sniff: { kind: "text" }, sample: content },
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "identity-changed", headersSent: false });
    expect(sink.head).toBeUndefined();
    expect(sink.ended).toBe(false);
    expect(fh.closeCount).toBe(1);
  });

  it("upload text: verify tags propagate (joined) and cwd text carries no verify tag", async () => {
    const content = Buffer.from("tagged");
    const v = fakeVerifier("joined");
    const sink = new FakeSink();
    const out = await readAndStream(
      {
        fh: new FakeHandle(content),
        size: content.length,
        sniff: { kind: "text" },
        sample: content,
        verify: { uploadId: "u1", sha256: "00" },
      },
      sink,
      opts({ verifier: v }),
    );
    expect(out).toEqual({ ok: true, bytes: 6, truncated: false, verify: "joined" });

    const sink2 = new FakeSink();
    const out2 = await readAndStream(textSrc(content), sink2, opts({ verifier: v }));
    expect(out2).toEqual({ ok: true, bytes: 6, truncated: false });
    expect(v.calls).toBe(1); // the cwd run never consulted it
  });

  it("upload text: verify failure maps to its stream reason, head never sent", async () => {
    const content = Buffer.from("x");
    for (const fail of ["verify-timeout", "verify-deadline", "hash-mismatch", "io"] as const) {
      const sink = new FakeSink();
      const out = await readAndStream(
        {
          fh: new FakeHandle(content),
          size: 1,
          sniff: { kind: "text" },
          sample: content,
          verify: { uploadId: "u1", sha256: "00" },
        },
        sink,
        opts({ verifier: fakeVerifier({ fail }) }),
      );
      expect(out).toEqual({ ok: false, reason: fail, headersSent: false });
      expect(sink.head).toBeUndefined();
    }
  });

  it("upload text: cache hit but post changed ⇒ single-flight BEFORE the head ⇒ hash-mismatch, no 200", async () => {
    const original = Buffer.from("v1"); // sha over this is the recorded digest
    const current = Buffer.from("v2-CHANGED!");
    const pre = fakeStat({ dev: 11, ino: 22, size: original.length, ctimeMs: 1000 });
    const postChanged = fakeStat({ dev: 11, ino: 22, size: current.length, ctimeMs: 2000 });
    const fh = new ScriptedHandle(current, [pre, postChanged]); // pre=A, cached-check post=B
    const log = memLog();
    const taskFs = fakeTaskFs(new Map([[fh.fd, () => new FakeHandle(current)]]));
    const verifier = createUploadVerifier({ fs: taskFs, log, now: Date.now });
    verifier.remember("u1", { dev: 11, ino: 22, size: original.length, ctimeMs: 1000 });

    const sink = new FakeSink();
    const out = await readAndStream(
      {
        fh,
        size: original.length,
        sniff: { kind: "text" },
        sample: current.subarray(0, 2),
        verify: { uploadId: "u1", sha256: sha(original) },
      },
      sink,
      opts({ verifier }),
    );
    expect(out).toEqual({ ok: false, reason: "hash-mismatch", headersSent: false });
    expect(sink.head).toBeUndefined(); // the client can never get a complete 200 (ruling #4)
    expect(taskFs.opens).toEqual([`/proc/self/fd/${fh.fd}`]); // really fell through to single-flight
    expect(log.lines.filter((l) => l.level === "error")).toHaveLength(1);
    expect(fh.closeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

describe("stream: images", () => {
  it("streams byte-exact at exactly the loopback cap (16 MiB) with the streaming hash", async () => {
    const content = Buffer.alloc(PREVIEW_IMAGE_MAX_BYTES.loopback);
    for (let i = 0; i < content.length; i += 4096) content[i] = (i / 4096) & 0xff; // deterministic non-uniform fill
    const sink = new FakeSink();
    const out = await readAndStream(imageSrc(content, sha(content)), sink, opts());
    expect(out).toEqual({ ok: true, bytes: content.length, truncated: false });
    expect(sink.body().equals(content)).toBe(true);
    expect(sink.head?.headers["Content-Length"]).toBe(String(content.length));
    expect(sink.head?.headers[PREVIEW_HDR.dims]).toBe("2x3");
    expect(sink.ended).toBe(true);
    expect(sink.destroyed).toBe(false);
  });

  it("cap+1: the kernel stays boundary-agnostic — §3.1 ⑧ owns the 413, not this layer", async () => {
    const content = Buffer.alloc(PREVIEW_IMAGE_MAX_BYTES.loopback + 1, 0x7f);
    const sink = new FakeSink();
    const out = await readAndStream(imageSrc(content, sha(content)), sink, opts());
    expect(out).toEqual({ ok: true, bytes: content.length, truncated: false });
    expect(sink.body().equals(content)).toBe(true);
  });

  it("cwd image (no expected sha): full body on identity match", async () => {
    const content = Buffer.alloc(150 * KIB, 0x55);
    const sink = new FakeSink();
    const out = await readAndStream(imageSrc(content), sink, opts());
    expect(out).toEqual({ ok: true, bytes: content.length, truncated: false });
    expect(sink.body().equals(content)).toBe(true);
  });

  it("file GREW: only the first `size` bytes are read, then the identity change destroys", async () => {
    const admitted = 100 * KIB;
    const grown = Buffer.alloc(150 * KIB, 0x66);
    const pre = fakeStat({ size: admitted, ctimeMs: 1000 });
    const post = fakeStat({ size: grown.length, ctimeMs: 2000 });
    const fh = new ScriptedHandle(grown, [pre, post]);
    const sink = new FakeSink();
    const out = await readAndStream(
      { fh, size: admitted, sniff: pngSniff, sample: grown.subarray(0, 64 * KIB) },
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "identity-changed", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.ended).toBe(false);
    expect(sink.bytes).toBeLessThan(admitted); // last chunk held back, never sent
  });

  it("file SHRANK: EOF before `size` ⇒ shrunk, destroy, bytes < size", async () => {
    const admitted = 100 * KIB;
    const shrunken = Buffer.alloc(80 * KIB, 0x77);
    const sink = new FakeSink();
    const out = await readAndStream(
      { fh: new FakeHandle(shrunken), size: admitted, sniff: pngSniff, sample: shrunken.subarray(0, 64 * KIB) },
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "shrunk", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.bytes).toBeLessThan(admitted);
    expect(sink.bytes).toBe(64 * KIB); // sample written after the first (partial) read proved non-final
  });

  it("hash mismatch ⇒ destroy and the client's body is short of Content-Length", async () => {
    const content = Buffer.alloc(100 * KIB, 0x88);
    const sink = new FakeSink();
    const out = await readAndStream(imageSrc(content, sha(Buffer.alloc(100 * KIB, 0x99))), sink, opts());
    expect(out).toEqual({ ok: false, reason: "hash-mismatch", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.ended).toBe(false);
    expect(sink.bytes).toBeLessThan(content.length);
  });

  it("images NEVER call verifyWhole, and the hash is recomputed on every run", async () => {
    const content = Buffer.alloc(70 * KIB, 0x11);
    const verifier = fakeVerifier("cached");
    // run 1: correct sha ⇒ ok
    const sink1 = new FakeSink();
    expect(await readAndStream(imageSrc(content, sha(content)), sink1, opts({ verifier }))).toMatchObject({ ok: true });
    // run 2: wrong sha on the SAME content ⇒ mismatch — proof the digest was recomputed
    const sink2 = new FakeSink();
    expect(
      await readAndStream(imageSrc(content, sha(Buffer.alloc(70 * KIB, 0x22))), sink2, opts({ verifier })),
    ).toMatchObject({
      ok: false,
      reason: "hash-mismatch",
    });
    expect(verifier.calls).toBe(0);
  });

  it("§4.5.2 image rule 4: a verified upload image WRITES the identity cache via remember", async () => {
    const content = Buffer.alloc(70 * KIB, 0x31);
    const verifier = fakeVerifier("cached");
    const sink = new FakeSink();
    const out = await readAndStream(imageSrc(content, sha(content)), sink, opts({ verifier }));
    expect(out).toMatchObject({ ok: true });
    expect(verifier.remembered).toEqual([
      { uploadId: "u1", identity: { dev: 11, ino: 22, size: content.length, ctimeMs: 1000 } },
    ]);
    // a cwd-class image (no verify record) never touches the cache either
    const verifier2 = fakeVerifier("cached");
    await readAndStream(imageSrc(content), new FakeSink(), opts({ verifier: verifier2 }));
    expect(verifier2.remembered).toEqual([]);
  });

  it("source-order: verifyWhole appears ONLY inside streamText, before its writeHead", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../../src/web-hub/hub/preview/stream.ts", import.meta.url)),
      "utf8",
    );
    const imageStart = source.indexOf("async function streamImage");
    const textStart = source.indexOf("async function streamText");
    expect(imageStart).toBeGreaterThan(0);
    expect(textStart).toBeGreaterThan(imageStart);
    expect(source.slice(imageStart, textStart)).not.toContain("verifyWhole");
    const textRegion = source.slice(textStart);
    const verifyIdx = textRegion.indexOf("verifyWhole");
    const headIdx = textRegion.indexOf("writeHead");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(headIdx).toBeGreaterThan(verifyIdx); // ruling #4: NEVER verify after the head
  });
});

// ---------------------------------------------------------------------------
// lifecycle: aborts, deadlines, slow clients, fd ownership, unref'd timers
// ---------------------------------------------------------------------------

describe("stream: lifecycle", () => {
  it("client abort mid-read ⇒ client-abort, destroyed, fd closed exactly once", async () => {
    const content = Buffer.alloc(150 * KIB, 0x33);
    const fh = new SlowReadHandle(content, 400);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort("client-abort"), 60);
    t.unref();
    const sink = new FakeSink();
    const out = await readAndStream(
      { fh, size: content.length, sniff: pngSniff, sample: content.subarray(0, 64 * KIB) },
      sink,
      opts({ signal: ctl.signal }),
    );
    clearTimeout(t);
    expect(out).toEqual({ ok: false, reason: "client-abort", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(fh.closeCount).toBe(1); // §3.1 ⑩: the stream owns the handle
  });

  it("hub-close BEFORE the head ⇒ hub-close, no destroy (routes still answers 503)", async () => {
    const content = Buffer.from("tiny");
    const fh = new SlowStatHandle(content, 400);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort("hub-close"), 60);
    t.unref();
    const sink = new FakeSink();
    const out = await readAndStream(
      { fh, size: content.length, sniff: { kind: "text" }, sample: content },
      sink,
      opts({ signal: ctl.signal }),
    );
    clearTimeout(t);
    expect(out).toEqual({ ok: false, reason: "hub-close", headersSent: false });
    expect(sink.head).toBeUndefined();
    expect(sink.destroyed).toBe(false);
    expect(fh.closeCount).toBe(1);
  });

  it("hub-close AFTER the head ⇒ destroyed", async () => {
    const content = Buffer.alloc(150 * KIB, 0x44);
    const fh = new SlowReadHandle(content, 400);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort("hub-close"), 60);
    t.unref();
    const sink = new FakeSink();
    const out = await readAndStream(
      { fh, size: content.length, sniff: pngSniff, sample: content.subarray(0, 64 * KIB) },
      sink,
      opts({ signal: ctl.signal }),
    );
    clearTimeout(t);
    expect(out).toEqual({ ok: false, reason: "hub-close", headersSent: true });
    expect(sink.destroyed).toBe(true);
  });

  it("slow client (drain never comes) ⇒ stream-deadline + destroy", async () => {
    const content = Buffer.alloc(150 * KIB, 0x55);
    const sink = new FakeSink({ hang: true });
    sink.backpressure = false; // every write reports backpressure
    const t0 = Date.now();
    const out = await readAndStream(
      { fh: new FakeHandle(content), size: content.length, sniff: pngSniff, sample: content.subarray(0, 64 * KIB) },
      sink,
      opts({ streamAt: 200 }),
    );
    expect(out).toEqual({ ok: false, reason: "stream-deadline", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.drainWaiters).toBeGreaterThanOrEqual(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("every timer created during a stream is unref'd", async () => {
    const orig = globalThis.setTimeout;
    const records: { unrefCalled: boolean }[] = [];
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      const handle = orig(fn, ms, ...rest);
      const rec = { unrefCalled: false };
      const origUnref = handle.unref.bind(handle);
      handle.unref = (): void => {
        rec.unrefCalled = true;
        origUnref();
      };
      records.push(rec);
      return handle;
    }) as typeof setTimeout;
    try {
      const content = Buffer.alloc(150 * KIB, 0x66);
      const sink = new FakeSink({ hang: true });
      sink.backpressure = false;
      await readAndStream(
        { fh: new FakeHandle(content), size: content.length, sniff: pngSniff, sample: content.subarray(0, 64 * KIB) },
        sink,
        opts({ streamAt: 120 }),
      );
    } finally {
      globalThis.setTimeout = orig;
    }
    expect(records.length).toBeGreaterThanOrEqual(1); // at least the deadline race timer
    expect(records.every((r) => r.unrefCalled)).toBe(true);
  });
});
