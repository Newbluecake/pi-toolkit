/**
 * Perf gate for the run file reader (fleet-drawer plan §9 F3a row, §10 P1): a ~47MB session
 * jsonl must serve a tail-200 snapshot quickly, without stalling the event loop, and by scanning
 * only a small tail fraction of the file. Real timers, DEFAULT 1 MiB scan chunks (no
 * `scanChunkBytes` seam) — this file pins production parameters, not test-only ones.
 */
import { afterEach, describe, expect, it } from "vitest";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRunFileReader,
  createRunFileReaderStats,
  type RunFileReadQuery,
} from "../../../src/web-hub/hub/run-file-reader.js";
import { tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
afterEach(() => {
  tmp.cleanup();
});

const iso = (n: number): string => new Date(1_790_000_000_000 + n * 1000).toISOString();

/** Legal entry line whose id never matches a chain want and which is never projected (~1KB). */
const fillerLine = (id: string, pad: number): string =>
  `${JSON.stringify({ type: "label", id, parentId: "zz", timestamp: iso(0), label: "x".repeat(pad) })}\n`;

/** Chain message entry padded to ~20KB — realistic large assistant/tool messages. */
const chainLine = (id: string, parentId: string | null, n: number): string =>
  `${JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: iso(n),
    message: { role: n % 2 === 0 ? "user" : "assistant", content: `m-${id}-${"y".repeat(20_000)}` },
  })}\n`;

describe("run-file-reader perf (plan §10 P1)", () => {
  it(
    "47MB file: tail-200 snapshot is fast, keeps the event loop responsive, scans only the tail",
    { timeout: 120_000 }, // file construction dominates; the read itself is gated at 2s below
    async () => {
      const dir = tmp.make("wh-rfr-perf-");
      const file = join(dir, "perf.jsonl");
      // ~42MB of filler (~1KB lines: neither too short nor too long) + a 250-entry parent chain
      // (~5MB) at the very tail.
      const filler = Array.from({ length: 41_000 }, (_, i) => fillerLine(`f${i}`, 900)).join("");
      const chain: string[] = [];
      let parent: string | null = null;
      for (let i = 0; i < 250; i++) {
        chain.push(chainLine(`e${i}`, parent, i + 1));
        parent = `e${i}`;
      }
      writeFileSync(file, filler + chain.join(""));
      const size = statSync(file).size;
      expect(size).toBeGreaterThan(42 * (1 << 20)); // 47MB ±10%
      expect(size).toBeLessThan(52 * (1 << 20));

      const stats = createRunFileReaderStats();
      const reader = createRunFileReader({ stats }); // default 1 MiB chunks, real clock

      // ② Event-loop responsiveness probe: a setImmediate ping-pong running concurrently with
      // the read, recording the worst gap between iterations. Plan §10 P1 gates /healthz
      // p99 < 50ms at the hub layer; here we approximate it with an event-loop probe.
      let probing = true;
      let maxGapMs = 0;
      const probe = (async () => {
        let last = performance.now();
        while (probing) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const t = performance.now();
          if (t - last > maxGapMs) maxGapMs = t - last;
          last = t;
        }
      })();

      const q: RunFileReadQuery = { limit: 200, maxBytes: 8 << 20, deadlineAt: Date.now() + 60_000 };
      const t0 = performance.now();
      const r = await reader.read(file, "e249", q);
      const elapsedMs = performance.now() - t0;
      probing = false;
      await probe;

      if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
      expect(r.entries).toHaveLength(200);
      expect(r.entries[0]!.id).toBe("e50");
      expect(r.entries[199]!.id).toBe("e249");
      expect(r.hasMore).toBe(true); // 50 older chain entries remain unscanned

      // ① plan §10 P1 target is < 500ms; 2000ms leaves CI headroom (anti-regression only).
      expect(elapsedMs).toBeLessThan(2000);
      // ② worst event-loop stall during the scan.
      expect(maxGapMs).toBeLessThan(500);
      // ③ tail-only scan: disk bytes read are a small fraction of the 47MB file.
      expect(stats.bytes).toBeLessThan(size * 0.25);
      reader.dispose();

      console.log(
        `perf P1: file=${(size / (1 << 20)).toFixed(1)}MiB elapsed=${elapsedMs.toFixed(0)}ms ` +
          `maxEventLoopGap=${maxGapMs.toFixed(1)}ms scanned=${(stats.bytes / (1 << 20)).toFixed(2)}MiB ` +
          `(${((stats.bytes / size) * 100).toFixed(1)}% of file) chunks=${stats.chunks} yields=${stats.yields}`,
      );
    },
  );
});
