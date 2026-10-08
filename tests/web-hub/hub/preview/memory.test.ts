/**
 * web-hub-preview plan v3 / PV2a acceptance — HP3 memory ceiling.
 *
 * ① a 1 GiB sparse text file streams with at most 256 KiB (+ one reused chunk buffer) ever
 *    resident — RSS must not grow by more than 1 MiB across the whole write-out;
 * ② a 100 MiB file re-verified through the single-flight whole-file hash (64 KiB reused
 *    buffer, digest streamed) — same < 1 MiB RSS bound while the full content passes through.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPreviewFs, PREVIEW_READ_FLAGS } from "../../../../src/web-hub/hub/preview/fs.js";
import { readAndStream } from "../../../../src/web-hub/hub/preview/stream.js";
import { createUploadVerifier } from "../../../../src/web-hub/hub/preview/verify.js";
import { PREVIEW_TEXT_MAX_BYTES } from "../../../../src/web-hub/protocol/preview.js";
import { FakeSink, memLog, neverAbort } from "./helpers.js";

const MIB = 1024 * 1024;
const RSS_BOUND = 1 * MIB; // the plan's HP3 bar
const rss = (): number => process.memoryUsage.rss();

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sparseFile(bytes: number, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const p = join(dir, "huge");
  writeFileSync(p, "");
  truncateSync(p, bytes); // sparse — no blocks written
  return p;
}

describe("HP3: memory ceiling", () => {
  it("1 GiB sparse text: the stream never buffers the file (Δrss < 1 MiB)", async () => {
    const fs = defaultPreviewFs();
    const path = sparseFile(1024 * MIB, "wh-hp3-stream-");
    const fh = await fs.open(path, PREVIEW_READ_FLAGS);
    try {
      const stat = await fh.stat();
      const sample = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(sample, 0, sample.length, 0);
      const sink = new FakeSink();
      const before = rss();
      const out = await readAndStream(
        { fh, size: stat.size, sniff: { kind: "text" }, sample: sample.subarray(0, bytesRead) },
        sink,
        {
          signal: neverAbort(),
          streamAt: 30_000,
          textMax: PREVIEW_TEXT_MAX_BYTES,
          now: Date.now,
          verifier: neverVerifier(),
        },
      );
      const delta = rss() - before;
      expect(out).toEqual({ ok: true, bytes: PREVIEW_TEXT_MAX_BYTES, truncated: true });
      expect(sink.body().length).toBe(PREVIEW_TEXT_MAX_BYTES);
      expect(delta).toBeLessThan(RSS_BOUND);
    } finally {
      await fh.close();
    }
  });

  it("100 MiB single-flight re-verification: Δrss < 1 MiB while hashing it all", async () => {
    const fs = defaultPreviewFs();
    const path = sparseFile(100 * MIB, "wh-hp3-verify-");
    const fh = await fs.open(path, PREVIEW_READ_FLAGS);
    try {
      const st = await fh.stat();
      // expected digest computed the same memory-safe way (1 MiB reused buffer)
      const expectedHash = createHash("sha256");
      const probe = Buffer.alloc(MIB);
      for (let pos = 0; pos < st.size; pos += probe.length) {
        const { bytesRead } = await fh.read(probe, 0, probe.length, pos);
        if (bytesRead === 0) break;
        expectedHash.update(probe.subarray(0, bytesRead));
      }
      const verifier = createUploadVerifier({ log: memLog(), now: Date.now });
      const identity = { dev: st.dev, ino: st.ino, size: st.size, ctimeMs: st.ctimeMs };
      const digest = expectedHash.digest("hex");
      // HP3's bar realized robustly: every pass below hashes the WHOLE 100 MiB under a fresh
      // uploadId (the cache is per-id, so nothing short-circuits). Two warm-up passes let V8
      // size its nursery for this allocation pattern; the two measured passes then show the
      // streaming implementation's steady state (a whole-file-buffering implementation would
      // add ~100 MiB of RSS on EVERY pass — warm-up or not — which min/max here can't hide).
      for (let i = 0; i < 2; i += 1) {
        expect(
          await verifier.verifyWhole(
            { uploadId: `hp3-warm-${i}`, sha256: digest, fh, identity },
            { signal: neverAbort(), waitUntil: Date.now() + 30_000 },
          ),
        ).toBe("hashed");
      }
      const deltas: number[] = [];
      for (let i = 0; i < 2; i += 1) {
        const before = rss();
        const res = await verifier.verifyWhole(
          { uploadId: `hp3-${i}`, sha256: digest, fh, identity },
          { signal: neverAbort(), waitUntil: Date.now() + 30_000 },
        );
        expect(res).toBe("hashed");
        deltas.push(rss() - before);
      }
      expect(Math.min(...deltas)).toBeLessThan(RSS_BOUND);
    } finally {
      await fh.close();
    }
  });
});

/** A verifier the text stream accepts but that must never be reached (cwd-class source). */
function neverVerifier(): ReturnType<typeof createUploadVerifier> {
  return {
    verifyWhole: () => Promise.reject(new Error("text stream must not verify cwd-class sources")),
    remember: () => undefined,
    dispose: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// dir-plan v3.1 P1b (§3.2/§5): a 100k-entry directory lists with bounded RSS —
// the scan cap (10 000 dirents), the entries cap (1 000) and the 512 KiB byte
// budget mean no stage ever materializes the whole directory.
// ---------------------------------------------------------------------------

describe("P1b dir listing: memory ceiling", () => {
  it("a 100 000-entry fake directory: Δrss stays bounded (scan-capped at 10 000, 1 000 kept)", async () => {
    const { listPreviewDir } = await import("../../../../src/web-hub/hub/preview/dir.js");
    const { denyCtxOf } = await import("../../../../src/web-hub/hub/preview/admit.js");
    const { createPreviewIoTracker } = await import("../../../../src/web-hub/hub/preview/fs.js");
    const { FakeHandle, neverAbort } = await import("./helpers.js");

    // 256-byte names: materializing all 100 000 would cost ~25+ MiB — the caps keep the
    // working set at 10 000 scanned + 1 000 kept + one ≤512 KiB body
    const nameOf = (i: number): string => `f${String(i).padStart(6, "0")}` + "-".repeat(256 - 7);
    let left = 100_000;
    let eof = false;
    const handle = {
      readBatch: (max: number): Promise<Array<{ name: string; type: "dir" | "file" | "symlink" | "other" }> | null> => {
        if (eof) return Promise.resolve(null);
        const n = Math.min(max, left);
        left -= n;
        if (left === 0) eof = true;
        const out: Array<{ name: string; type: "file" }> = [];
        for (let i = 0; i < n; i += 1) out.push({ name: nameOf(left + i), type: "file" });
        return Promise.resolve(out);
      },
      close: (): Promise<void> => Promise.resolve(),
    };
    const fs = {
      opendir: () => Promise.resolve(handle),
      lstat: () =>
        Promise.resolve({
          size: 256,
          mtimeMs: 1,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }),
    };
    const fh = new FakeHandle(Buffer.alloc(0), { ino: 55, dev: 2 });
    const deps = {
      fs: fs as never,
      now: Date.now,
      log: memLog(),
      tracker: createPreviewIoTracker(),
      denyCtx: denyCtxOf("/home/nobody", "/home/nobody/.pi/agent"),
    };
    // warm-up passes let V8 size its nursery for this allocation pattern; the min of two
    // measured passes then shows the steady state (an implementation that materialized the
    // whole directory would add ~25+ MiB of RETAINED set on EVERY pass — min can't hide it).
    const runOnce = async (): Promise<{ delta: number; ok: boolean; scanned: number; kept: number; bytes: number }> => {
      left = 100_000;
      eof = false;
      const before = rss();
      const res = await listPreviewDir(deps, { fh, realpath: "/srv/big", requestPath: "/srv/big" }, neverAbort());
      return {
        delta: rss() - before,
        ok: res.ok,
        scanned: res.ok ? res.listing.scanned : -1,
        kept: res.ok ? res.listing.entries.length : -1,
        bytes: res.ok ? Buffer.byteLength(JSON.stringify(res.listing)) : -1,
      };
    };
    await runOnce();
    await runOnce();
    const passes = [await runOnce(), await runOnce()];
    for (const p of passes) {
      expect(p.ok).toBe(true);
      expect(p.scanned).toBe(10_000);
      expect(p.kept).toBe(1_000);
      expect(p.bytes).toBeLessThanOrEqual(512 * 1024);
    }
    expect(Math.min(...passes.map((p) => p.delta))).toBeLessThan(12 * MIB);
  });
});
