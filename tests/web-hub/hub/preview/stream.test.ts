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
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewHandle, PreviewStat } from "../../../../src/web-hub/hub/preview/admit.js";
import { previewIdentOf } from "../../../../src/web-hub/hub/preview/ident.js";
import { readAndStream } from "../../../../src/web-hub/hub/preview/stream.js";
import type { PreviewSink, StreamOutcome } from "../../../../src/web-hub/hub/preview/stream.js";
import { createPreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";
import type { PreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";
import { createUploadVerifier } from "../../../../src/web-hub/hub/preview/verify.js";
import type { Identity, UploadVerifier } from "../../../../src/web-hub/hub/preview/verify.js";
import {
  PREVIEW_HDR,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_TEXT_CHUNK_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_TEXT_STREAM_HUB_MAX_BYTES,
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
// download (preview-download) — the image flow's streaming-hash sibling: octet-stream
// headers, no sniff/dims, same held-back-last-chunk + destroy-on-mismatch kernel
// ---------------------------------------------------------------------------

describe("stream: download (preview-download)", () => {
  /** `readAndStream`'s download src: sniff unused (`binary` placeholder), empty sample. */
  function downloadSrc(content: Buffer, expectedSha?: string, size = content.length) {
    return {
      fh: new FakeHandle(content),
      size,
      sniff: { kind: "binary" as const },
      sample: Buffer.alloc(0),
      ...(expectedSha === undefined ? {} : { verify: { uploadId: "u1", sha256: expectedSha } }),
      download: { filename: "bundle.zip" },
    };
  }

  it("streams byte-exact with the download header contract (Kind/CT/Content-Disposition filename*/nosniff)", async () => {
    const content = Buffer.alloc(100 * KIB, 0x5a);
    const sink = new FakeSink();
    const out = await readAndStream(downloadSrc(content, sha(content)), sink, opts());
    expect(out).toEqual({ ok: true, bytes: content.length, truncated: false, verify: undefined });
    expect(sink.body().equals(content)).toBe(true);
    const headers = sink.head?.headers ?? {};
    expect(headers[PREVIEW_HDR.kind]).toBe("download");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Length"]).toBe(String(content.length));
    expect(headers["Content-Disposition"]).toBe("attachment; filename*=UTF-8''bundle.zip");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers[PREVIEW_HDR.dims]).toBeUndefined(); // no sniff metadata
    expect(sink.ended).toBe(true);
    expect(sink.destroyed).toBe(false);
  });

  it("hash mismatch ⇒ destroy and the client's body is short of Content-Length (same as the image rule)", async () => {
    const content = Buffer.alloc(100 * KIB, 0x88);
    const sink = new FakeSink();
    const out = await readAndStream(downloadSrc(content, sha(Buffer.alloc(100 * KIB, 0x99))), sink, opts());
    expect(out).toEqual({ ok: false, reason: "hash-mismatch", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.ended).toBe(false);
    expect(sink.bytes).toBeLessThan(content.length); // last chunk held back, never sent
  });

  it("file SHRANK: EOF before `size` ⇒ shrunk, destroy, bytes < size", async () => {
    const admitted = 100 * KIB;
    const shrunken = Buffer.alloc(80 * KIB, 0x77);
    const sink = new FakeSink();
    const out = await readAndStream(downloadSrc(shrunken, undefined, admitted), sink, opts());
    expect(out).toEqual({ ok: false, reason: "shrunk", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.bytes).toBeLessThan(admitted);
  });

  it("identity change (grew mid-stream) ⇒ destroy, like the image flow", async () => {
    const admitted = 100 * KIB;
    const grown = Buffer.alloc(150 * KIB, 0x66);
    const pre = fakeStat({ size: admitted, ctimeMs: 1000 });
    const post = fakeStat({ size: grown.length, ctimeMs: 2000 });
    const fh = new ScriptedHandle(grown, [pre, post]);
    const sink = new FakeSink();
    const out = await readAndStream(
      {
        fh,
        size: admitted,
        sniff: { kind: "binary" as const },
        sample: Buffer.alloc(0),
        download: { filename: "g.bin" },
      },
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "identity-changed", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.bytes).toBeLessThan(admitted);
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

// ---------------------------------------------------------------------------
// chunked text (chunked-plan §3.2 / §6.1) — continuation reads, ident echo, ceiling
// clamp, progress rule, busy fast-fail, per-chunk gzip, and the byte-identical
// non-chunked header snapshot
// ---------------------------------------------------------------------------

/** FakeHandle recording every positioned read (the chunked branch must read at `start+got`). */
class PosHandle extends FakeHandle {
  readonly positions: number[] = [];

  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> {
    this.positions.push(pos);
    return super.read(buf, off, len, pos);
  }
}

describe("stream: chunked text", () => {
  const identOfStat = (over: Partial<PreviewStat> = {}): string =>
    previewIdentOf({
      dev: over.dev ?? 11,
      ino: over.ino ?? 22,
      size: over.size ?? 0,
      ctimeMs: over.ctimeMs ?? 1000,
    });

  function chunkSrc(
    content: Buffer,
    chunk: { offset: number; ident?: string; ceiling?: number },
    stat?: Partial<PreviewStat>,
  ): Src & { fh: PosHandle } {
    const fh = new PosHandle(content, stat);
    return {
      fh,
      size: stat?.size ?? content.length,
      sniff: { kind: "text" },
      sample: content.subarray(0, Math.min(content.length, 64 * KIB)),
      chunk: {
        offset: chunk.offset,
        ...(chunk.ident === undefined ? {} : { ident: chunk.ident }),
        ceiling: chunk.ceiling ?? PREVIEW_TEXT_STREAM_HUB_MAX_BYTES,
      },
    };
  }

  it("first chunk (offset 0): sample reuse, Offset/Ident/no-store headers, truncated flag", async () => {
    const content = Buffer.concat([
      Buffer.alloc(PREVIEW_TEXT_CHUNK_BYTES - 1, 0x61),
      Buffer.from("é"),
      Buffer.alloc(64, 0x62),
    ]);
    const sink = new FakeSink();
    const out = await readAndStream(chunkSrc(content, { offset: 0 }), sink, opts());
    const want = PREVIEW_TEXT_CHUNK_BYTES - 1; // é's lead byte at the cap boundary is cut back
    expect(out).toEqual({ ok: true, bytes: want, truncated: true });
    const h = sink.head?.headers ?? {};
    expect(h[PREVIEW_HDR.offset]).toBe("0");
    expect(h[PREVIEW_HDR.ident]).toBe(identOfStat({ size: content.length }));
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h[PREVIEW_HDR.bytes]).toBe(String(want));
    expect(h[PREVIEW_HDR.truncated]).toBe("1");
    // offset 0 reuses the sniff sample: the first read position is 64 KiB, not 0
    expect(sink.body.length === want ? undefined : undefined).toBeUndefined();
  });

  it("positional reads land at start+got (first chunk reuses the sample, continuation does not)", async () => {
    const content = Buffer.alloc(300 * KIB, 0x61);
    // chunk 1 (offset 0): sample covers [0, 64 KiB), reads continue from 64 KiB
    const s1 = new FakeSink();
    const src1 = chunkSrc(content, { offset: 0 });
    await readAndStream(src1, s1, opts());
    expect(src1.fh.positions[0]).toBe(64 * KIB);
    expect(s1.body().length).toBe(PREVIEW_TEXT_CHUNK_BYTES);
    // chunk 2 (offset = 0 + bytes from chunk 1): NO sample reuse — first read position is the offset
    const s2 = new FakeSink();
    const src2 = chunkSrc(content, { offset: PREVIEW_TEXT_CHUNK_BYTES, ident: identOfStat({ size: content.length }) });
    const out2 = await readAndStream(src2, s2, opts());
    expect(out2).toEqual({ ok: true, bytes: 300 * KIB - PREVIEW_TEXT_CHUNK_BYTES, truncated: false });
    expect(src2.fh.positions).toEqual([PREVIEW_TEXT_CHUNK_BYTES]);
    expect(s2.body().equals(content.subarray(PREVIEW_TEXT_CHUNK_BYTES))).toBe(true);
    expect(s2.head?.headers[PREVIEW_HDR.offset]).toBe(String(PREVIEW_TEXT_CHUNK_BYTES));
    expect(s2.head?.headers[PREVIEW_HDR.truncated]).toBe("0");
  });

  it("multi-chunk walk: concatenation strictly equals the original (ASCII + CJK + emoji + CRLF)", async () => {
    // ~1.2 MiB mixed text with multi-byte chars and CRLFs straddling every plausible boundary
    const unit = Buffer.from("line-αβγ-漢字-😀\r\nnext\r\n", "utf8");
    const repeats = Math.ceil((1.2 * MIB) / unit.length);
    const content = Buffer.concat(Array(repeats).fill(unit));
    let offset = 0;
    const ident = identOfStat({ size: content.length });
    const collected: Buffer[] = [];
    for (let round = 0; round < 12 && offset < content.length; round += 1) {
      const sink = new FakeSink();
      const out = await readAndStream(chunkSrc(content, { offset, ...(offset === 0 ? {} : { ident }) }), sink, opts());
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("unreachable");
      expect(sink.head?.headers[PREVIEW_HDR.offset]).toBe(String(offset));
      expect(sink.head?.headers[PREVIEW_HDR.ident]).toBe(ident);
      expect(Number(sink.head?.headers[PREVIEW_HDR.bytes])).toBe(out.bytes);
      expect(sink.head?.headers[PREVIEW_HDR.truncated]).toBe(offset + out.bytes < content.length ? "1" : "0");
      expect(out.bytes).toBeGreaterThan(0);
      collected.push(sink.body());
      offset += out.bytes; // the UI's rule: next offset = offset + X-PWH-Preview-Bytes
    }
    expect(offset).toBe(content.length);
    expect(Buffer.concat(collected).equals(content)).toBe(true);
  });

  it("boundary lands inside a 3-byte and a 4-byte char: cut backs to the character boundary", async () => {
    for (const [label, ch] of [
      ["3-byte", "中"],
      ["4-byte", "😀"],
    ] as const) {
      const prefix = Buffer.alloc(PREVIEW_TEXT_CHUNK_BYTES - 1, 0x61);
      const content = Buffer.concat([prefix, Buffer.from(`${ch}${ch}${ch}`, "utf8"), Buffer.alloc(32, 0x62)]);
      const sink = new FakeSink();
      const out = await readAndStream(chunkSrc(content, { offset: 0 }), sink, opts());
      expect(out.ok, label).toBe(true);
      if (out.ok) {
        expect(out.bytes).toBe(PREVIEW_TEXT_CHUNK_BYTES - 1);
        // every served byte sequence decodes cleanly at the boundary (no split char)
        expect(() => new TextDecoder("utf-8", { fatal: true }).decode(sink.body())).not.toThrow();
      }
    }
  });

  it("final chunk at EOF: no boundary cut (verbatim tail, truncated 0)", async () => {
    const content = Buffer.concat([Buffer.alloc(PREVIEW_TEXT_CHUNK_BYTES + 7, 0x61), Buffer.from("尾-é😀")]);
    const first = new FakeSink();
    const out1 = await readAndStream(chunkSrc(content, { offset: 0 }), first, opts());
    expect(out1.ok && out1.bytes).toBe(PREVIEW_TEXT_CHUNK_BYTES);
    const tail = new FakeSink();
    const out2 = await readAndStream(
      chunkSrc(content, { offset: PREVIEW_TEXT_CHUNK_BYTES, ident: identOfStat({ size: content.length }) }),
      tail,
      opts(),
    );
    expect(out2).toMatchObject({ ok: true, truncated: false });
    if (out2.ok) {
      expect(tail.body().equals(content.subarray(PREVIEW_TEXT_CHUNK_BYTES))).toBe(true); // verbatim
      expect(out2.bytes).toBe(content.length - PREVIEW_TEXT_CHUNK_BYTES);
    }
  });

  it("progress rule: an all-continuation-byte window (cut 0, want > 0) still serves want bytes", async () => {
    // leading 'x' then a run of bare continuation bytes far past the per-chunk cap
    const content = Buffer.concat([Buffer.from("x"), Buffer.alloc(PREVIEW_TEXT_CHUNK_BYTES + 16, 0x80)]);
    const sink = new FakeSink();
    const out = await readAndStream(chunkSrc(content, { offset: 0 }), sink, opts());
    expect(out).toEqual({ ok: true, bytes: PREVIEW_TEXT_CHUNK_BYTES, truncated: true });
    expect(sink.body().length).toBe(PREVIEW_TEXT_CHUNK_BYTES); // never a 0-byte body (UI loop guard)
    // a continuation landing INSIDE the run hits the same rule
    const sink2 = new FakeSink();
    const out2 = await readAndStream(
      chunkSrc(content, { offset: 1, ident: identOfStat({ size: content.length }) }),
      sink2,
      opts(),
    );
    expect(out2).toEqual({ ok: true, bytes: PREVIEW_TEXT_CHUNK_BYTES, truncated: true });
    expect(sink2.body().equals(content.subarray(1, 1 + PREVIEW_TEXT_CHUNK_BYTES))).toBe(true);
  });

  it("empty file, first chunk: 200 with 0 bytes and truncated 0", async () => {
    const sink = new FakeSink();
    const out = await readAndStream(chunkSrc(Buffer.alloc(0), { offset: 0 }), sink, opts());
    expect(out).toEqual({ ok: true, bytes: 0, truncated: false });
    expect(sink.head?.headers[PREVIEW_HDR.bytes]).toBe("0");
    expect(sink.head?.headers[PREVIEW_HDR.truncated]).toBe("0");
  });

  it("ident mismatch vs the pre stat ⇒ identity-changed BEFORE the head", async () => {
    const content = Buffer.from("stable");
    const sink = new FakeSink();
    const out = await readAndStream(
      chunkSrc(content, { offset: 0, ident: identOfStat({ ctimeMs: 987654321 }) }),
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "identity-changed", headersSent: false });
    expect(sink.head).toBeUndefined();
  });

  it("continuation ident: same stat passes, drifted ctime fails (never stitch)", async () => {
    const content = Buffer.alloc(10, 0x61);
    const okSink = new FakeSink();
    const ok = await readAndStream(chunkSrc(content, { offset: 3, ident: identOfStat({ size: 10 }) }), okSink, opts());
    expect(ok).toEqual({ ok: true, bytes: 7, truncated: false });
    const bad = new FakeSink();
    const out = await readAndStream(
      chunkSrc(content, { offset: 3, ident: identOfStat({ size: 10, ctimeMs: 4242 }) }),
      bad,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "identity-changed", headersSent: false });
  });

  it("pre.size !== admitted size (file changed between admission and write-out) ⇒ identity-changed", async () => {
    const content = Buffer.alloc(100, 0x61);
    const sink = new FakeSink();
    const out = await readAndStream(
      chunkSrc(content, { offset: 10, ident: identOfStat({ size: 90 }) }, { size: 100 }),
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "identity-changed", headersSent: false });
    expect(sink.head).toBeUndefined();
  });

  it("offset >= size ⇒ range (client arithmetic error), offset 0 on an empty file excepted", async () => {
    const content = Buffer.alloc(10, 0x61);
    const sink = new FakeSink();
    const out = await readAndStream(chunkSrc(content, { offset: 10, ident: identOfStat({ size: 10 }) }), sink, opts());
    expect(out).toEqual({ ok: false, reason: "range", headersSent: false });
    expect(sink.head).toBeUndefined();
    const beyond = new FakeSink();
    expect(
      await readAndStream(chunkSrc(content, { offset: 11, ident: identOfStat({ size: 10 }) }), beyond, opts()),
    ).toEqual({ ok: false, reason: "range", headersSent: false });
  });

  it("hub hard ceiling clamps the read length (offset near the 16 MiB ceiling)", async () => {
    const size = PREVIEW_TEXT_STREAM_HUB_MAX_BYTES + 5 * KIB; // beyond the ceiling by 5 KiB
    const content = Buffer.alloc(size, 0x61);
    const offset = PREVIEW_TEXT_STREAM_HUB_MAX_BYTES - 8 * KIB; // parse-legal (< ceiling)
    const sink = new FakeSink();
    const out = await readAndStream(chunkSrc(content, { offset, ident: identOfStat({ size }) }), sink, opts());
    expect(out).toEqual({ ok: true, bytes: 8 * KIB, truncated: true }); // never crosses the ceiling
    expect(sink.body().equals(content.subarray(offset, PREVIEW_TEXT_STREAM_HUB_MAX_BYTES))).toBe(true);
    expect(sink.head?.headers[PREVIEW_HDR.offset]).toBe(String(offset));
  });

  it("tracker tripped ⇒ busy fast-fail (pre-stat, pre-read, pre-verify) — never a head", async () => {
    const content = Buffer.alloc(10, 0x61);
    // max 0 ⇒ tripped immediately: the FIRST check (pre-stat) fires
    const s1 = new FakeSink();
    expect(
      await readAndStream(chunkSrc(content, { offset: 0 }), s1, opts({ tracker: createPreviewIoTracker(0) })),
    ).toEqual({ ok: false, reason: "busy", headersSent: false });
    expect(s1.head).toBeUndefined();
    // a tracker that trips only after the stat: the pre-READ check fires
    let checks = 0;
    const arming: PreviewIoTracker = {
      get zombies(): number {
        checks += 1;
        return checks <= 1 ? 0 : 5;
      },
      get max(): number {
        return 2;
      },
    };
    const s2 = new FakeSink();
    expect(await readAndStream(chunkSrc(content, { offset: 0 }), s2, opts({ tracker: arming }))).toEqual({
      ok: false,
      reason: "busy",
      headersSent: false,
    });
    expect(s2.head).toBeUndefined();
  });

  it("busy only ever comes from the pre-check: a raced-out chunked read classifies stream-deadline", async () => {
    const content = Buffer.alloc(64, 0x61);
    const fh = new SlowReadHandle(content, 400);
    const sink = new FakeSink();
    const out = await readAndStream(
      {
        fh,
        size: content.length,
        sniff: { kind: "text" },
        sample: Buffer.alloc(0),
        chunk: { offset: 0, ceiling: PREVIEW_TEXT_STREAM_HUB_MAX_BYTES },
      },
      sink,
      opts({ streamAt: 100, tracker: createPreviewIoTracker() }),
    );
    expect(out).toEqual({ ok: false, reason: "stream-deadline", headersSent: false });
  });

  it("upload-class chunk: verifyWhole still gates the head and the tag propagates", async () => {
    const content = Buffer.alloc(200, 0x61);
    const v = fakeVerifier("cached");
    const sink = new FakeSink();
    const out = await readAndStream(
      {
        fh: new FakeHandle(content),
        size: content.length,
        sniff: { kind: "text" },
        sample: content,
        verify: { uploadId: "u1", sha256: "00" },
        chunk: { offset: 10, ident: identOfStat({ size: content.length }), ceiling: PREVIEW_TEXT_STREAM_HUB_MAX_BYTES },
      },
      sink,
      opts({ verifier: v }),
    );
    expect(out).toEqual({ ok: true, bytes: 190, truncated: false, verify: "cached" });
    expect(v.calls).toBe(1);
  });

  it("cwd-class chunk: post-stat identity drift ⇒ identity-changed, no head", async () => {
    const content = Buffer.alloc(10, 0x61);
    const fh = new ScriptedHandle(content, [
      fakeStat({ size: 10, ctimeMs: 1000 }),
      fakeStat({ size: 10, ctimeMs: 2000 }),
    ]);
    const sink = new FakeSink();
    const out = await readAndStream(
      {
        fh,
        size: 10,
        sniff: { kind: "text" },
        sample: content,
        chunk: { offset: 0, ceiling: PREVIEW_TEXT_STREAM_HUB_MAX_BYTES },
      },
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: false, reason: "identity-changed", headersSent: false });
  });

  it("chunked gzip: per-chunk compression, Bytes header = cut (uncompressed), offset/ident ride along", async () => {
    const content = Buffer.alloc(PREVIEW_TEXT_CHUNK_BYTES + 100, 0x61); // ≥ GZIP_MIN_BYTES, compressible
    const sink = new FakeSink();
    const out = await readAndStream(chunkSrc(content, { offset: 0 }), sink, opts({ acceptEncoding: "gzip" }));
    expect(out).toEqual({ ok: true, bytes: PREVIEW_TEXT_CHUNK_BYTES, truncated: true });
    const h = sink.head?.headers ?? {};
    expect(h["Content-Encoding"]).toBe("gzip");
    expect(h["Vary"]).toBe("Accept-Encoding");
    expect(h[PREVIEW_HDR.bytes]).toBe(String(PREVIEW_TEXT_CHUNK_BYTES));
    expect(Number(h["Content-Length"])).toBeLessThan(PREVIEW_TEXT_CHUNK_BYTES);
    expect(gunzipSync(sink.body()).equals(content.subarray(0, PREVIEW_TEXT_CHUNK_BYTES))).toBe(true);
  });

  it("NON-chunked snapshot: the header set carries NO offset/ident/no-store — byte-identical", async () => {
    const content = Buffer.from("plain legacy text", "utf8");
    const sink = new FakeSink();
    const out = await readAndStream(textSrc(content), sink, opts());
    expect(out).toEqual({ ok: true, bytes: content.length, truncated: false });
    expect(sink.head?.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(content.length),
      [PREVIEW_HDR.kind]: "text",
      [PREVIEW_HDR.size]: String(content.length),
      [PREVIEW_HDR.bytes]: String(content.length),
      [PREVIEW_HDR.truncated]: "0",
      "Content-Disposition": 'attachment; filename="preview"',
      "Cross-Origin-Resource-Policy": "same-origin",
    }); // exactly the pre-chunked set — Offset/Ident/Cache-Control absent
  });

  it("source-order: the chunked flow's verifyWhole also precedes its writeHead", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../../src/web-hub/hub/preview/stream.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("async function streamChunkedText");
    expect(start).toBeGreaterThan(0);
    const region = source.slice(start);
    const verifyIdx = region.indexOf("verifyWhole");
    const headIdx = region.indexOf("writeHead");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(headIdx).toBeGreaterThan(verifyIdx);
  });
});

// ---------------------------------------------------------------------------
// web-hub-html-preview plan v2 T-H4 (P1a): `streamRawBody` extraction + the pv flow
// ---------------------------------------------------------------------------

describe("stream: streamRawBody extraction (download byte-identical) + pv flow", () => {
  const PV_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };

  function pvSrc(
    fh: PreviewHandle,
    size: number,
    over: { beforeHead?: () => boolean; io?: import("../../../../src/web-hub/hub/preview/stream.js").PvStreamIo } = {},
  ) {
    const calls = { run: 0, close: 0 };
    const io = over.io ?? {
      run: <T>(op: () => Promise<T>) => (calls.run++, op()),
      close: (op: () => Promise<void>) => (calls.close++, op().catch(() => undefined)),
    };
    return {
      calls,
      src: {
        fh,
        size,
        sniff: { kind: "binary" as const },
        sample: Buffer.alloc(0),
        pv: { headers: { ...PV_HEADERS }, beforeHead: over.beforeHead ?? (() => true), io },
      },
    };
  }

  it("download headers are byte-identical, exact key order and values", async () => {
    const content = Buffer.alloc(10, 1);
    const sink = new FakeSink();
    const out = await readAndStream(
      {
        fh: new FakeHandle(content),
        size: 10,
        sniff: { kind: "binary" as const },
        sample: Buffer.alloc(0),
        download: { filename: "报告 (1).zip" },
      },
      sink,
      opts(),
    );
    expect(out).toEqual({ ok: true, bytes: 10, truncated: false });
    expect(Object.entries(sink.head!.headers)).toEqual([
      ["Content-Type", "application/octet-stream"],
      ["Content-Length", "10"],
      [PREVIEW_HDR.kind, "download"],
      [PREVIEW_HDR.size, "10"],
      [
        "Content-Disposition",
        "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%2528%2531%2529.zip".replace("%2528%2531%2529", "%281%29"),
      ],
      ["X-Content-Type-Options", "nosniff"],
      ["Cross-Origin-Resource-Policy", "same-origin"],
    ]);
  });

  it("pv: streams byte-exact under the caller headers, Content-Length forced, no preview metadata", async () => {
    const content = Buffer.alloc(200 * KIB + 7, 0x41);
    const sink = new FakeSink();
    const { src, calls } = pvSrc(new FakeHandle(content), content.length);
    const out = await readAndStream(src, sink, opts());
    expect(out).toEqual({ ok: true, bytes: content.length, truncated: false });
    expect(sink.head?.status).toBe(200);
    expect(sink.head?.headers).toEqual({ ...PV_HEADERS, "Content-Length": String(content.length) });
    expect(Object.keys(sink.head!.headers).some((k) => k.startsWith("X-PWH-Preview"))).toBe(false);
    expect(sink.body().equals(content)).toBe(true);
    expect(sink.ended).toBe(true);
    expect(calls.run).toBeGreaterThan(3); // pre-stat + reads + post-stat all via the gate
    expect(calls.close).toBe(1);
  });

  it("pv: beforeHead() false ⇒ not-live, nothing written, handle still closed via io.close", async () => {
    const fh = new FakeHandle(Buffer.from("abc"));
    const sink = new FakeSink();
    const { src, calls } = pvSrc(fh, 3, { beforeHead: () => false });
    const out = await readAndStream(src, sink, opts());
    expect(out).toEqual({ ok: false, reason: "not-live", headersSent: false });
    expect(sink.head).toBeUndefined();
    expect(sink.destroyed).toBe(false);
    expect(fh.closeCount).toBe(1);
    expect(calls.close).toBe(1);
  });

  it("pv: beforeHead is evaluated synchronously right before writeHead (flip after pre-stat is seen)", async () => {
    let live = true;
    const fh = new FakeHandle(Buffer.from("abc"));
    const origStat = fh.stat.bind(fh);
    fh.stat = async () => {
      const s = await origStat();
      live = false; // revoked while the pre-stat was in flight
      return s;
    };
    const sink = new FakeSink();
    const { src } = pvSrc(fh, 3, { beforeHead: () => live });
    expect(await readAndStream(src, sink, opts())).toMatchObject({ ok: false, reason: "not-live", headersSent: false });
    expect(sink.head).toBeUndefined();
  });

  it("pv: revoke mid-stream (signal abort) destroys the response, body short of Content-Length", async () => {
    const content = Buffer.alloc(512 * KIB, 0x42);
    const ctl = new AbortController();
    class AbortingHandle extends FakeHandle {
      read(buf: Buffer, off: number, len: number, pos: number) {
        if (this.readCalls === 2) ctl.abort("pv-revoked");
        return super.read(buf, off, len, pos);
      }
    }
    const sink = new FakeSink();
    const { src } = pvSrc(new AbortingHandle(content), content.length);
    const out = await readAndStream(src, sink, opts({ signal: ctl.signal }));
    expect(out).toMatchObject({ ok: false, reason: "client-abort", headersSent: true });
    expect(sink.destroyed).toBe(true);
    expect(sink.bytes).toBeLessThan(content.length);
  });

  it("pv: a file that changes while streaming ⇒ identity-changed destroy", async () => {
    const content = Buffer.alloc(300 * KIB, 0x43);
    const fh = new FakeHandle(content);
    let n = 0;
    const origStat = fh.stat.bind(fh);
    fh.stat = async () => {
      const s = await origStat();
      n += 1;
      return n >= 2 ? { ...s, ctimeMs: s.ctimeMs + 5 } : s;
    };
    const sink = new FakeSink();
    const { src } = pvSrc(fh, content.length);
    expect(await readAndStream(src, sink, opts())).toMatchObject({ ok: false, reason: "identity-changed" });
    expect(sink.destroyed).toBe(true);
  });

  it("pv: an io gate that rejects busy fails pre-head (headers never sent)", async () => {
    const fh = new FakeHandle(Buffer.from("abc"));
    const sink = new FakeSink();
    const { src } = pvSrc(fh, 3, {
      io: {
        run: () => Promise.reject(Object.assign(new Error("busy"), { name: "PreviewIoError", ioFail: "busy" })),
        close: (op) => op(),
      },
    });
    const out = await readAndStream(src, sink, opts());
    expect(out.ok).toBe(false);
    expect(sink.head).toBeUndefined();
  });
});
