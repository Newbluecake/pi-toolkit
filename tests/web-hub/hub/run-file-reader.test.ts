import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRunFileReader,
  createRunFileReaderStats,
  type RunFileReadQuery,
  type RunFileReadResult,
} from "../../../src/web-hub/hub/run-file-reader.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import type { WireEntry } from "../../../src/web-hub/protocol/messages.js";
import { tmpDirs, waitFor } from "./helpers.js";

const tmp = tmpDirs();
afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const line = (o: object): string => `${JSON.stringify(o)}\n`;
const iso = (n: number): string => new Date(1_790_000_000_000 + n * 1000).toISOString();

const msgEntry = (id: string, parentId: string | null, n: number, content?: unknown): Raw => ({
  type: "message",
  id,
  parentId,
  timestamp: iso(n),
  message: { role: n % 2 === 0 ? "user" : "assistant", content: content ?? `text-${id}` },
});

/** A linear parent chain `${prefix}0 .. ${prefix}${count - 1}` (root first). */
function chainRaw(prefix: string, count: number, opts?: { startN?: number; parent?: string | null }): Raw[] {
  const out: Raw[] = [];
  let p: string | null = opts?.parent ?? null;
  const startN = opts?.startN ?? 1;
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i}`;
    out.push(msgEntry(id, p, startN + i));
    p = id;
  }
  return out;
}

const sessionHeader = (over: Record<string, unknown> = {}): Raw => ({
  type: "session",
  version: 3,
  id: "sess",
  timestamp: iso(0),
  cwd: "/tmp/w",
  ...over,
});

const fillerLine = (id: string, pad: number): string =>
  line({ type: "label", id, parentId: "zz", timestamp: iso(0), label: "x".repeat(pad) });

/**
 * In-memory truth, mirroring `walkBranch` (hub/history.ts): walk `parentId` links from the leaf,
 * reverse to oldest-first, project, drop unprojectable entries.
 */
function walkExpected(raws: Raw[], leafId: string): WireEntry[] {
  const byId = new Map<string, Raw>();
  for (const r of raws) {
    if (typeof r["id"] === "string") byId.set(r["id"], r);
  }
  const chain: Raw[] = [];
  let cur: string | null = leafId;
  while (cur !== null) {
    const r = byId.get(cur);
    if (r === undefined) break;
    chain.push(r);
    const p: unknown = r["parentId"];
    cur = typeof p === "string" ? p : null;
  }
  chain.reverse();
  const out: WireEntry[] = [];
  for (const r of chain) {
    const e = projectSessionEntry(r);
    if (e !== undefined) out.push(e);
  }
  return out;
}

function writeJsonl(name: string, content: string): string {
  const file = join(tmp.make("wh-rfr-"), name);
  writeFileSync(file, content);
  return file;
}

const q = (over: Partial<RunFileReadQuery> = {}): RunFileReadQuery => {
  const base: RunFileReadQuery = { limit: 200, maxBytes: 4 << 20, deadlineAt: Date.now() + 30_000 };
  if (over.limit !== undefined) base.limit = over.limit;
  if (over.maxBytes !== undefined) base.maxBytes = over.maxBytes;
  if (over.deadlineAt !== undefined) base.deadlineAt = over.deadlineAt;
  if (over.before !== undefined) base.before = over.before;
  return base;
};

function okEntries(r: RunFileReadResult): WireEntry[] {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.entries;
}

const ids = (entries: WireEntry[]): string[] => entries.map((e) => e.id);

// ---------------------------------------------------------------------------
// T1–T6: terminal-leaf scenarios (plan §10)
// ---------------------------------------------------------------------------

describe("run-file-reader T scenarios", () => {
  it("T1: linear chain matches the in-memory walk from the final leaf", async () => {
    const raws = chainRaw("l", 12);
    const file = writeJsonl("t1.jsonl", line(sessionHeader()) + raws.map(line).join(""));
    const reader = createRunFileReader();
    const r = await reader.read(file, "l11", q());
    expect(r.ok).toBe(true);
    expect(okEntries(r)).toEqual(walkExpected(raws, "l11"));
    expect(ids(okEntries(r))).toEqual(ids(walkExpected(raws, "l11")));
    if (r.ok) expect(r.hasMore).toBe(false); // root reached, whole branch collected
    reader.dispose();
  });

  it("T2: trailing lines of an abandoned branch are never included", async () => {
    const main = chainRaw("m", 3); // m0 ← m1 ← m2 (leaf)
    const abandoned = chainRaw("x", 2, { startN: 10, parent: "m1" }); // m1 ← x0 ← x1, written last
    const file = writeJsonl("t2.jsonl", [...main, ...abandoned].map(line).join(""));
    const reader = createRunFileReader();
    const r = await reader.read(file, "m2", q());
    expect(ids(okEntries(r))).toEqual(["m0", "m1", "m2"]);
    // the abandoned branch is still readable through its own leaf
    const r2 = await reader.read(file, "x1", q());
    expect(ids(okEntries(r2))).toEqual(["m0", "m1", "x0", "x1"]);
    reader.dispose();
  });

  it("T3: a compaction entry appears on the chain in the right position", async () => {
    const c0 = msgEntry("c0", null, 1);
    const comp: Raw = {
      type: "compaction",
      id: "comp",
      parentId: "c0",
      timestamp: iso(2),
      summary: "compressed history",
      firstKeptEntryId: "c1",
    };
    const c1 = msgEntry("c1", "comp", 3);
    const c2 = msgEntry("c2", "c1", 4);
    const raws = [c0, comp, c1, c2];
    const file = writeJsonl("t3.jsonl", raws.map(line).join(""));
    const reader = createRunFileReader();
    const r = await reader.read(file, "c2", q());
    const entries = okEntries(r);
    expect(entries).toEqual(walkExpected(raws, "c2"));
    expect(ids(entries)).toEqual(["c0", "comp", "c1", "c2"]);
    expect(entries[1]!.type).toBe("compaction");
    expect(entries[1]!.summary).toBe("compressed history");
    expect(entries[1]!.firstKeptEntryId).toBe("c1");
    reader.dispose();
  });

  it("T4: a fork file with a parentSession header walks only its own chain", async () => {
    const header = sessionHeader({ id: "fork", parentSession: "/nonexistent/source.jsonl" });
    const raws = chainRaw("f", 3); // f0(parentId null) ← f1 ← f2, all inside this file
    const file = writeJsonl("t4.jsonl", line(header) + raws.map(line).join(""));
    const reader = createRunFileReader();
    const r = await reader.read(file, "f2", q());
    expect(r.ok).toBe(true); // the parentSession path is never consulted
    expect(okEntries(r)).toEqual(walkExpected(raws, "f2"));
    expect(ids(okEntries(r))).toEqual(["f0", "f1", "f2"]);
    reader.dispose();
  });

  it("T5: two runs sharing one file — A stops at A's leaf, B sees A + B", async () => {
    const a = chainRaw("a", 2); // run A: a0 ← a1 (A's leaf)
    const b = chainRaw("b", 2, { startN: 10, parent: "a1" }); // resumed run B: a1 ← b0 ← b1
    const file = writeJsonl("t5.jsonl", [...a, ...b].map(line).join(""));
    const reader = createRunFileReader();
    const ra = await reader.read(file, "a1", q());
    expect(ids(okEntries(ra))).toEqual(["a0", "a1"]);
    if (ra.ok) expect(ra.hasMore).toBe(false);
    const rb = await reader.read(file, "b1", q());
    expect(ids(okEntries(rb))).toEqual(["a0", "a1", "b0", "b1"]);
    reader.dispose();
  });

  it("T6: mixed entry types equal the in-memory walkBranch semantics", async () => {
    const raws: Raw[] = [
      { type: "model_change", id: "mc", parentId: null, timestamp: iso(1), provider: "p", modelId: "m" },
      msgEntry("u1", "mc", 2),
      {
        type: "custom_message",
        id: "cm",
        parentId: "u1",
        timestamp: iso(3),
        customType: "probe:x",
        content: "hello",
        display: true,
      },
      { type: "custom", id: "cd", parentId: "cm", timestamp: iso(4), customType: "state", data: { v: 1 } },
      { type: "compaction", id: "co", parentId: "cd", timestamp: iso(5), summary: "s" },
      { type: "branch_summary", id: "bs", parentId: "co", timestamp: iso(6), summary: "b" },
      { type: "thinking_level_change", id: "tl", parentId: "bs", timestamp: iso(7), thinkingLevel: "high" },
      { type: "label", id: "lb", parentId: "tl", timestamp: iso(8), label: "on-chain but unprojected" },
      msgEntry("a1", "lb", 9),
    ];
    const file = writeJsonl("t6.jsonl", line(sessionHeader()) + raws.map(line).join(""));
    const reader = createRunFileReader();
    const r = await reader.read(file, "a1", q());
    const expected = walkExpected(raws, "a1");
    expect(okEntries(r)).toEqual(expected);
    // the on-chain label is walked through but not projected
    expect(ids(okEntries(r))).toEqual(["mc", "u1", "cm", "cd", "co", "bs", "tl", "a1"]);
    expect(ids(okEntries(r))).not.toContain("lb");
    if (r.ok) expect(r.hasMore).toBe(false);
    reader.dispose();
  });
});

// ---------------------------------------------------------------------------
// paging / slicing edges
// ---------------------------------------------------------------------------

describe("run-file-reader paging", () => {
  it("before paging slices oldest-first with correct hasMore, reusing one scan round", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ stats });
    const raws = chainRaw("c", 10);
    const file = writeJsonl("page.jsonl", raws.map(line).join(""));

    const p1 = await reader.read(file, "c9", q({ limit: 4 }));
    expect(ids(okEntries(p1))).toEqual(["c6", "c7", "c8", "c9"]);
    if (p1.ok) expect(p1.hasMore).toBe(true);

    const p2 = await reader.read(file, "c9", q({ limit: 4, before: "c6" }));
    expect(ids(okEntries(p2))).toEqual(["c2", "c3", "c4", "c5"]);
    if (p2.ok) expect(p2.hasMore).toBe(true);

    const p3 = await reader.read(file, "c9", q({ limit: 4, before: "c2" }));
    expect(ids(okEntries(p3))).toEqual(["c0", "c1"]);
    if (p3.ok) expect(p3.hasMore).toBe(false);

    expect(stats.rounds).toBe(1); // the whole file fit one round; pages 2/3 were cache hits
    reader.dispose();
  });

  it("an unknown before on a fully-scanned branch is leaf_missing", async () => {
    const reader = createRunFileReader();
    const file = writeJsonl("unk.jsonl", chainRaw("u", 4).map(line).join(""));
    const r = await reader.read(file, "u3", q({ before: "nope" }));
    expect(r).toEqual({ ok: false, reason: "leaf_missing" });
    reader.dispose();
  });

  it("maxBytes trims the page from the oldest end but always keeps the newest entry", async () => {
    const reader = createRunFileReader();
    const raws = chainRaw("b", 5);
    const file = writeJsonl("cap.jsonl", raws.map(line).join(""));
    const r = await reader.read(file, "b4", q({ maxBytes: 1 }));
    expect(ids(okEntries(r))).toEqual(["b4"]);
    if (r.ok) expect(r.hasMore).toBe(true);
    reader.dispose();
  });
});

// ---------------------------------------------------------------------------
// scanning robustness edges
// ---------------------------------------------------------------------------

describe("run-file-reader scanning edges", () => {
  it("substring prefilter never false-matches parentId / toolCallId / escaped content", async () => {
    const e1 = msgEntry("e1", null, 1);
    const e2 = msgEntry("e2", "e1", 2);
    const e3 = msgEntry("e3", "e2", 3);
    // nested {"id":"e3"} inside content: prefilter hit, JSON.parse must reject it
    const d1 = msgEntry("d1", "zz", 6, [{ id: "e3", note: "nested object" }]);
    // toolCallId keeps a capital I: no prefilter hit for want="e2"
    const d2: Raw = {
      type: "message",
      id: "d2",
      parentId: "zz",
      timestamp: iso(4),
      message: { role: "toolResult", toolCallId: "e2", content: "result" },
    };
    // quotes inside a JSON string are escaped: \"id\":\"e2\" cannot match "id":"e2"
    const d3 = msgEntry("d3", "zz", 5, 'literal "id":"e2" in text');
    const file = writeJsonl("decoy.jsonl", [line(e1), line(e2), line(d2), line(d3), line(e3), line(d1)].join(""));
    const reader = createRunFileReader({ scanChunkBytes: 64 });
    const r = await reader.read(file, "e3", q());
    expect(okEntries(r)).toEqual(walkExpected([e1, e2, e3], "e3"));
    expect(ids(okEntries(r))).toEqual(["e1", "e2", "e3"]);
    reader.dispose();
  });

  it("stitches partial lines across chunk boundaries, including split multi-byte UTF-8", async () => {
    const raws = chainRaw("m", 12).map((r, i) => ({
      ...r,
      message: { role: "user", content: `你好🔥café-${i}-${"漢字".repeat(20)}` },
    }));
    const file = writeJsonl("utf8.jsonl", raws.map(line).join(""));
    const expected = walkExpected(raws, "m11");
    for (const scanChunkBytes of [8, 13, 37, 64, 100]) {
      const reader = createRunFileReader({ scanChunkBytes });
      const r = await reader.read(file, "m11", q());
      expect(r.ok).toBe(true);
      expect(okEntries(r)).toEqual(expected);
      reader.dispose();
    }
  });

  it("tolerates a truncated half-written line at the file tail", async () => {
    const raws = chainRaw("t", 5);
    // a half-written append that even prefilter-hits the current want must be skipped, never fatal
    const truncated = `{"type":"message","id":"t4","parentId":"t3","timestamp`;
    const file = writeJsonl("trunc.jsonl", raws.map(line).join("") + truncated);
    const reader = createRunFileReader({ scanChunkBytes: 64 });
    const r = await reader.read(file, "t4", q());
    expect(r.ok).toBe(true);
    expect(okEntries(r)).toEqual(walkExpected(raws, "t4"));
    reader.dispose();
  });

  it("leaf not present in the file ⇒ leaf_missing", async () => {
    const reader = createRunFileReader({ scanChunkBytes: 64 });
    const file = writeJsonl("noleaf.jsonl", chainRaw("n", 4).map(line).join(""));
    const r = await reader.read(file, "nope", q());
    expect(r).toEqual({ ok: false, reason: "leaf_missing" });
    reader.dispose();
  });

  it("non-.jsonl path or missing file ⇒ file_missing", async () => {
    const reader = createRunFileReader();
    const dir = tmp.make("wh-rfr-");
    const txt = join(dir, "s.txt");
    writeFileSync(txt, line(msgEntry("a", null, 1)));
    expect(await reader.read(txt, "a", q())).toEqual({ ok: false, reason: "file_missing" });
    expect(await reader.read(join(dir, "gone.jsonl"), "a", q())).toEqual({
      ok: false,
      reason: "file_missing",
    });
    reader.dispose();
  });

  it("scanning beyond maxScanBytes ⇒ too_large", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ stats, scanChunkBytes: 64, maxScanBytes: 100 });
    const raws = chainRaw("g", 3);
    const file = writeJsonl("large.jsonl", raws.map(line).join("") + fillerLine("pad", 2000));
    const r = await reader.read(file, "g2", q());
    expect(r).toEqual({ ok: false, reason: "too_large" });
    expect(stats.bytes).toBeGreaterThan(100);
    reader.dispose();
  });

  it("an already-past deadline ⇒ busy without scanning; disposed ⇒ busy", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ now: () => 1000, stats });
    const file = writeJsonl("busy.jsonl", chainRaw("d", 3).map(line).join(""));
    const r = await reader.read(file, "d2", q({ deadlineAt: 999 }));
    expect(r).toEqual({ ok: false, reason: "busy" });
    expect(stats.rounds).toBe(0);

    const reader2 = createRunFileReader();
    reader2.dispose();
    expect(await reader2.read(file, "d2", q())).toEqual({ ok: false, reason: "busy" });
    reader.dispose();
  });

  it("a cyclic parentId (corrupted file) terminates as leaf_missing instead of looping", async () => {
    const reader = createRunFileReader({ scanChunkBytes: 64 });
    // self-cycle: a ← a
    const self = writeJsonl("ring-self.jsonl", line(msgEntry("a", "a", 1)));
    // two-cycle via duplicated ids (rewritten/corrupted file): r←s, s←r, r←s (leaf last)
    const dup = writeJsonl(
      "ring-dup.jsonl",
      [line(msgEntry("r", "s", 1)), line(msgEntry("s", "r", 2)), line(msgEntry("r", "s", 3))].join(""),
    );
    expect(await reader.read(self, "a", q())).toEqual({ ok: false, reason: "leaf_missing" });
    expect(await reader.read(dup, "r", q())).toEqual({ ok: false, reason: "leaf_missing" });
    reader.dispose();
  });

  it("snapshot: an append during a scan is invisible to that read; the next read rescans", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ stats, scanChunkBytes: 4096 });
    // filler-only file (~10MB ⇒ ~2500 chunks: the scan stays in flight well past the append below)
    const filler = Array.from({ length: 2500 }, (_, i) => fillerLine(`f${i}`, 4000)).join("");
    const file = writeJsonl("snap.jsonl", filler);
    const sizeAtStat = statSync(file).size;

    const p = reader.read(file, "x1", q());
    await waitFor(() => stats.chunks >= 5); // scan in flight, positioned at the stat'd EOF
    // Append the chain WHILE the scan runs: the new bytes sit beyond the stat'd offset.
    appendFileSync(file, chainRaw("x", 2).map(line).join(""));
    const chunksAtAppend = stats.chunks;

    const r1 = await p;
    expect(r1).toEqual({ ok: false, reason: "leaf_missing" }); // x1 was invisible to this read
    expect(stats.chunks).toBeGreaterThan(chunksAtAppend); // the scan really continued after the append
    expect(stats.bytes).toBeLessThanOrEqual(sizeAtStat); // never read past the stat'd EOF

    // The append bumped size/mtime ⇒ a new cache key ⇒ a fresh scan that sees the chain.
    const r2 = await reader.read(file, "x1", q());
    expect(ids(okEntries(r2))).toEqual(["x0", "x1"]);
    reader.dispose();
  });
});

// ---------------------------------------------------------------------------
// P1–P5: performance / concurrency contracts (plan §10)
// ---------------------------------------------------------------------------

describe("run-file-reader P scenarios", () => {
  it("P1: a tail snapshot scans only a small fraction of the file, with a time bound", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ stats, scanChunkBytes: 4096 });
    const filler = Array.from({ length: 400 }, (_, i) => fillerLine(`f${i}`, 400)).join("");
    const raws = chainRaw("e", 250);
    const file = writeJsonl("big.jsonl", filler + raws.map(line).join(""));
    const size = statSync(file).size;

    const t0 = Date.now();
    const r = await reader.read(file, "e249", q({ limit: 200 }));
    const elapsed = Date.now() - t0;

    const entries = okEntries(r);
    expect(entries).toHaveLength(200);
    expect(entries[0]!.id).toBe("e50");
    expect(entries[199]!.id).toBe("e249");
    if (r.ok) expect(r.hasMore).toBe(true); // 50 older entries remain unscanned
    expect(stats.bytes).toBeLessThan(size * 0.3); // tail-only scan, not the whole file
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.yields).toBe(stats.chunks); // one event-loop yield per chunk
    expect(elapsed).toBeLessThan(2000); // loose anti-regression bound
    reader.dispose();
  });

  it("P2: two concurrent reads of the same key share a single scan round", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ stats, scanChunkBytes: 512 });
    const raws = chainRaw("s", 10);
    const fillerTail = Array.from({ length: 200 }, (_, i) => fillerLine(`z${i}`, 100)).join("");
    const file = writeJsonl("shared.jsonl", raws.map(line).join("") + fillerTail);

    const [r1, r2] = await Promise.all([reader.read(file, "s9", q()), reader.read(file, "s9", q())]);
    const expected = walkExpected(raws, "s9");
    expect(okEntries(r1)).toEqual(expected);
    expect(okEntries(r2)).toEqual(expected);
    expect(stats.rounds).toBe(1); // single-flight: the joiner never started its own round
    reader.dispose();
  });

  it("P3: a third scan queues behind the global gate (max 2); queue deadline expiry ⇒ busy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let t = 100_000;
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ now: () => t, stats, scanChunkBytes: 512 });

    const fillerTail = Array.from({ length: 2000 }, (_, i) => fillerLine(`p${i}`, 200)).join("");
    const mk = (prefix: string): { file: string; raws: Raw[] } => {
      const raws = chainRaw(prefix, 3); // chain at the head: the scan churns the whole filler tail
      return { file: writeJsonl(`gate-${prefix}.jsonl`, raws.map(line).join("") + fillerTail), raws };
    };
    const f1 = mk("a");
    const f2 = mk("b");
    const f3 = mk("c");

    const p1 = reader.read(f1.file, "a2", q({ deadlineAt: t + 600_000 }));
    const p2 = reader.read(f2.file, "b2", q({ deadlineAt: t + 600_000 }));
    await waitFor(() => stats.active === 2); // both gate slots held

    const p3 = reader.read(f3.file, "c2", q({ deadlineAt: t + 1_000 }));
    await waitFor(() => stats.gateWaits === 1); // the third scan is queued
    expect(stats.maxConcurrent).toBe(2);

    t += 2_000; // let the queued waiter's deadline lapse while the gate stays full
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p3).toEqual({ ok: false, reason: "busy" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(okEntries(r1)).toEqual(walkExpected(f1.raws, "a2"));
    expect(okEntries(r2)).toEqual(walkExpected(f2.raws, "b2"));
    expect(stats.rounds).toBe(2); // the queued caller never acquired the gate
    expect(stats.maxConcurrent).toBe(2);
    reader.dispose();
  });

  it("P4: 17 distinct cursors evict the LRU oldest; an evicted cursor rescans correctly", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ stats });
    const raws = chainRaw("x", 3);
    const files = Array.from({ length: 17 }, (_, i) => writeJsonl(`lru-${i}.jsonl`, raws.map(line).join("")));
    const expected = walkExpected(raws, "x2");

    for (const f of files) {
      expect(okEntries(await reader.read(f, "x2", q()))).toEqual(expected);
    }
    expect(stats.rounds).toBe(17); // one round per fresh cursor

    // files[0]'s cursor was evicted (LRU 16): reading it again rescans, result still correct
    expect(okEntries(await reader.read(files[0]!, "x2", q()))).toEqual(expected);
    expect(stats.rounds).toBe(18);

    // files[16] is still cached: a cache hit needs no new round
    expect(okEntries(await reader.read(files[16]!, "x2", q()))).toEqual(expected);
    expect(stats.rounds).toBe(18);
    reader.dispose();
  });

  it("P5: a before page resumes the cursor — scanned bytes accumulate instead of restarting", async () => {
    const stats = createRunFileReaderStats();
    const reader = createRunFileReader({ stats, scanChunkBytes: 2048 });
    const filler = Array.from({ length: 300 }, (_, i) => fillerLine(`h${i}`, 300)).join("");
    const raws = chainRaw("e", 120);
    const file = writeJsonl("resume.jsonl", filler + raws.map(line).join(""));
    const size = statSync(file).size;

    const p1 = await reader.read(file, "e119", q({ limit: 50 }));
    expect(ids(okEntries(p1))).toEqual(raws.slice(70).map((r) => r["id"] as string));
    if (p1.ok) expect(p1.hasMore).toBe(true);
    const bytesAfterPage1 = stats.bytes;
    expect(bytesAfterPage1).toBeLessThan(size * 0.2);

    const p2 = await reader.read(file, "e119", q({ limit: 50, before: "e70" }));
    expect(ids(okEntries(p2))).toEqual(raws.slice(20, 70).map((r) => r["id"] as string));
    if (p2.ok) expect(p2.hasMore).toBe(true);

    expect(stats.bytes).toBeGreaterThan(bytesAfterPage1); // cumulative, never reset
    const incremental = stats.bytes - bytesAfterPage1;
    expect(incremental).toBeLessThan(size * 0.2); // resumed mid-file, not rescanned from EOF
    expect(stats.rounds).toBe(2); // one round per page, same cursor
    reader.dispose();
  });
});
