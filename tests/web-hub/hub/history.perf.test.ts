/**
 * Perf gate for the history service's reverse branch reader (refresh-slow plan §6.1,
 * `docs/dev/web-hub/refresh-slow/plan.md`): a ~44 MB synthetic session of `subagent:archive`
 * custom entries (the explore report's hot spot — `canonicalJson` over ~16.5 KB multi-key
 * payloads, 87 MB / 72% of the 190 MB incident session) must snapshot from the file tail
 * quickly, without stalling the event loop, scanning only a small tail fraction. This pins the
 * production profile (real timers, the service's own reader: parity, 512 KiB chunks, LRU 8).
 *
 * The old whole-file path (`readBranchFromFile`) is timed alongside and logged as evidence
 * (ratio only — the gate is the reverse reader).
 */
import { afterEach, describe, expect, it } from "vitest";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { createHistoryService, readBranchFromFile } from "../../../src/web-hub/hub/history.js";
import { createRunFileReaderStats } from "../../../src/web-hub/hub/run-file-reader.js";
import { createRegistry, type AgentConn } from "../../../src/web-hub/hub/registry.js";
import { hello, memLog, tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
afterEach(() => {
  tmp.cleanup();
});

const iso = (n: number): string => new Date(1_790_000_000_000 + n * 1000).toISOString();
const line = (o: object): string => `${JSON.stringify(o)}\n`;

/**
 * A realistic `subagent:archive` payload: several top-level keys, nested objects, string
 * values — exercising `canonicalJson`'s recursive key sort. ~23 KB serialized (the incident
 * session averaged 16.5 KB; this leaves headroom so the file lands at ~44 MB with 2,600 rows).
 */
function archiveData(i: number): Record<string, unknown> {
  const runs: Record<string, unknown> = {};
  for (let r = 0; r < 6; r++) {
    runs[`run-${i}-${r}`] = {
      state: "terminal",
      label: `worker-${r}`,
      startedAt: 1_790_000_000_000 + i,
      cost: { input: 12_345 + r, output: 6_789 + r, turns: 40 + r },
      note: `history-${i}-${r}:` + "a".repeat(3_000),
    };
  }
  return {
    v: 1,
    runs,
    bashJobs: {
      ["job-" + (i % 7)]: { cmd: "npm test", state: "running", pid: 100_000 + i, tail: "b".repeat(1_400) },
    },
    meta: { sweptAt: 1_790_000_100_000 + i, held: [], generation: i, filler: "c".repeat(2_600) },
  };
}

describe("history snapshot perf (refresh-slow plan §6.1)", () => {
  it(
    "~44 MB archive session: snapshot is fast, keeps the event loop responsive, scans only the tail; page(oldest,400) rides the cursor",
    { timeout: 120_000 }, // file construction dominates; the read itself is gated below
    async () => {
      const dir = tmp.make("wh-h-perf-");
      const file = join(dir, "perf.jsonl");
      const TOTAL = 2_600;
      const parts: string[] = [line({ type: "session", version: 3, id: "sess", timestamp: iso(0), cwd: "/tmp/w" })];
      let parent: string | null = null;
      let leaf = "";
      for (let i = 0; i < TOTAL; i++) {
        const id = i % 4 === 0 ? `m${i}` : `a${i}`; // every 4th entry is a message, all on-chain
        parts.push(
          i % 4 === 0
            ? line({
                type: "message",
                id,
                parentId: parent,
                timestamp: iso(i + 1),
                message: { role: "user", content: `msg-${i}` },
              })
            : line({
                type: "custom",
                id,
                parentId: parent,
                timestamp: iso(i + 1),
                customType: "subagent:archive",
                data: archiveData(i),
              }),
        );
        parent = id;
        leaf = id;
      }
      writeFileSync(file, parts.join(""));
      const size = statSync(file).size;
      expect(size).toBeGreaterThan(40 * (1 << 20)); // ~44 MB ±10%
      expect(size).toBeLessThan(52 * (1 << 20));

      // scripted agent: snapshot_reply with the file + leaf, empty recent
      const reg = createRegistry({ now: () => Date.now(), log: memLog(), pidAlive: () => true });
      let agentKey = "";
      const conn: AgentConn = {
        send(f) {
          if (f.t === "snapshot_req") {
            const body: AgentFrame = {
              t: "snapshot_reply",
              rid: f.rid,
              seq: 10,
              leafId: leaf,
              recent: [],
              prompts: [],
              status: { leafId: leaf, busy: false, pending: false },
              fleet: [],
              sessionFile: file,
            };
            queueMicrotask(() => reg.onFrame(agentKey, body));
          }
        },
        close() {},
      };
      agentKey = reg.register(hello(), conn).agentKey;
      reg.onFrame(agentKey, {
        t: "session",
        sessionId: "s",
        sessionFile: file,
        cwd: "/tmp/w",
        reason: "startup",
        leafId: leaf,
        mode: "tui",
      });

      const readerStats = createRunFileReaderStats();
      const h = createHistoryService({ registry: reg, log: memLog(), readerStats });

      // event-loop responsiveness probe running concurrently with the snapshot
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

      const t0 = performance.now();
      const p = await h.snapshot(agentKey);
      const snapMs = performance.now() - t0;
      probing = false;
      await probe;

      expect(p.source).toBe("file");
      expect(p.entries).toHaveLength(400); // tailEntries default
      expect(p.entries.at(-1)?.id).toBe(leaf);
      expect(p.hasMore).toBe(true);

      // gates (plan §6.1: local expectation ≪; CI headroom, anti-regression only)
      expect(snapMs).toBeLessThan(1_000);
      expect(maxGapMs).toBeLessThan(100);
      expect(readerStats.bytes).toBeLessThan(size * 0.25);

      // page rides the cursor: one incremental round, fast
      const idAt = (i: number): string => (i % 4 === 0 ? `m${i}` : `a${i}`);
      const rounds = readerStats.rounds;
      const t1 = performance.now();
      const page = await h.page(agentKey, p.oldestEntryId!, 400);
      const pageMs = performance.now() - t1;
      expect(page.source).toBe("file");
      expect(page.entries).toHaveLength(400);
      expect(p.entries[0]!.id).toBe(idAt(TOTAL - 1 - 399)); // snapshot oldest = 400th newest
      expect(page.entries.at(-1)?.id).toBe(idAt(TOTAL - 1 - 400)); // ends just before the snapshot's oldest
      expect(readerStats.rounds - rounds).toBeLessThanOrEqual(1);
      expect(pageMs).toBeLessThan(500);

      // evidence only (no gate): the old whole-file path on the same file
      const t2 = performance.now();
      const full = await readBranchFromFile(file, leaf);
      const fullMs = performance.now() - t2;
      expect(full.ok).toBe(true);
      console.log(
        `history perf: file=${(size / (1 << 20)).toFixed(1)}MiB entries=${TOTAL} ` +
          `snapshot=${snapMs.toFixed(0)}ms (full reader: ${fullMs.toFixed(0)}ms, ` +
          `${(fullMs / Math.max(1, snapMs)).toFixed(0)}×) maxEventLoopGap=${maxGapMs.toFixed(1)}ms ` +
          `scanned=${(readerStats.bytes / (1 << 20)).toFixed(2)}MiB (${((readerStats.bytes / size) * 100).toFixed(
            1,
          )}% of file) page=${pageMs.toFixed(0)}ms rounds=${readerStats.rounds}`,
      );
      h.dispose();
    },
  );
});
