// web-resume plan §4 P1: the dir-wide provenance index — cold cache + old parent, budget
// exhaustion/convergence, warm-cache lower bound without reads, v1 cache ignored, prune/restart
// semantics, 8 MiB round-robin chunks (a 200 MiB parent never starves the others), the 20 000
// file cap with self-marked children still hidden, mark/entry/cache byte caps.

import {
  appendFile,
  mkdir,
  open as openAsync,
  readFile,
  rename,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  advanceProvenance,
  DEFAULT_PROVENANCE_BUDGET,
  provenanceCachePath,
  provenanceStatus,
  PROVENANCE_CACHE_MAX_BYTES,
  PROVENANCE_MARKS_PER_ENTRY_MAX,
} from "../../src/session-nav/provenance.js";
import { collectSubagentSessions } from "../../src/session-nav/subagent-sessions.js";
import { childMarkerLine, dropLayout, headerLine, makeLayout, runMarkLine, type Layout } from "./helpers.js";

let layout: Layout;
beforeEach(async () => {
  layout = await makeLayout();
});
afterEach(async () => {
  await dropLayout(layout);
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function setOld(path: string, daysAgo: number): Promise<void> {
  const t = new Date(Date.now() - daysAgo * DAY_MS);
  await utimes(path, t, t);
}

async function writeSession(name: string, lines: string[]): Promise<string> {
  const path = join(layout.sessionDir, name);
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}

describe("advanceProvenance — cold cache and the 48h blind-spot fix", () => {
  test("old parent outside 48h + recent child without self-marker ⇒ hidden after backfill", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]); // no self-marker (pre-v0.4.0)
    const parent = await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);
    await setOld(parent, 10); // way outside the recent lane

    const index = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(index.has(child)).toBe(true);
    expect(index.complete).toBe(true);
    expect(provenanceStatus(index)).toBe("complete");

    const filter = await collectSubagentSessions([child], layout.sessionDir, {
      budget: { ms: 0, bytes: 0 }, // no scan budget: the classification must come from the index
    });
    expect(filter.sub.has(resolve(child))).toBe(true);
  });

  test("cache file is 0600 and per-dir under provenance-v2/", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);
    await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    const cacheFile = provenanceCachePath(layout.sessionDir);
    expect(cacheFile).toContain(join("cache", "session-nav", "provenance-v2"));
    const hash = createHash("sha256").update(resolve(layout.sessionDir)).digest("hex").slice(0, 16);
    expect(cacheFile.endsWith(`${hash}.json`)).toBe(true);
    const st = await stat(cacheFile);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("advanceProvenance — budget exhaustion and convergence", () => {
  test("byte-budget exhaustion ⇒ complete:false, then converges over calls", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    // The mark sits ~90 KiB into the parent (outside lane ① — mtime is old).
    const lines = [headerLine("p1")];
    while (lines.join("\n").length < 90 * 1024)
      lines.push(JSON.stringify({ type: "custom", customType: "t:f", data: "f".repeat(500) }));
    lines.push(runMarkLine(child));
    const parent = await writeSession("parent.jsonl", lines);
    await setOld(parent, 5);

    const first = await advanceProvenance(layout.sessionDir, { ms: 10_000, bytes: 4096 });
    expect(first.complete).toBe(false);
    expect(first.has(child)).toBe(false);

    let current = first;
    for (let i = 0; i < 100 && !(current.complete && current.has(child)); i++) {
      current = await advanceProvenance(layout.sessionDir, { ms: 10_000, bytes: 4096 });
    }
    expect(current.complete).toBe(true);
    expect(current.has(child)).toBe(true);
  });

  test("time-budget expiry leaves a valid partial index", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);
    // ms: 0 — the deadline is already up, so nothing may be scanned this call.
    const index = await advanceProvenance(layout.sessionDir, { ms: 0, bytes: 64 * 1024 * 1024 });
    expect(index.complete).toBe(false);
    expect(index.has(child)).toBe(false);
  });
});

describe("advanceProvenance — cache v2 behaviour", () => {
  test("warm cache serves marks with zero read budget (lower bound without re-stat)", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);
    await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);

    const warm = await advanceProvenance(layout.sessionDir, { ms: 0, bytes: 0 });
    expect(warm.has(child)).toBe(true);
    expect(warm.complete).toBe(true); // entry identity + scannedTo === size, no reads needed
  });

  test("the v1 subagent-marks.json cache is simply ignored", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    const v1 = join(layout.agentDir, "cache", "session-nav", "subagent-marks.json");
    await mkdir(join(layout.agentDir, "cache", "session-nav"), { recursive: true });
    await writeFile(
      v1,
      JSON.stringify({
        version: 1,
        files: {
          [resolve(join(layout.sessionDir, "parent.jsonl"))]: {
            mtimeMs: Date.now(),
            size: 10,
            marks: [{ sessionFile: child, agentType: "verifier", label: "v1 标记" }],
          },
        },
      }),
      "utf8",
    );
    await writeSession("parent.jsonl", [headerLine("p1")]); // deliberately mark-free
    const index = await advanceProvenance(layout.sessionDir, { ms: 0, bytes: 0 }); // no scan
    expect(index.has(child)).toBe(false); // v1 content never consulted
  });

  test("resume from scannedTo after an append keeps old marks and finds new ones", async () => {
    const child1 = await writeSession("child1.jsonl", [headerLine("c1")]);
    const child2 = await writeSession("child2.jsonl", [headerLine("c2")]);
    const parent = await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child1)]);
    const first = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(first.has(child1)).toBe(true);
    expect(first.has(child2)).toBe(false);

    await appendFile(parent, runMarkLine(child2) + "\n", "utf8");
    const second = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(second.has(child1)).toBe(true); // old marks retained
    expect(second.has(child2)).toBe(true); // new bytes scanned from scannedTo
    expect(second.complete).toBe(true);
  });

  test("identity change (new inode) restarts at 0 and drops the old marks", async () => {
    const childOld = await writeSession("child-old.jsonl", [headerLine("co")]);
    const childNew = await writeSession("child-new.jsonl", [headerLine("cn")]);
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(childOld)]);
    const before = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(before.has(childOld)).toBe(true);

    // Replace the parent via a new inode (write elsewhere + rename).
    const tmp = join(layout.sessionDir, "parent.tmp");
    await writeFile(tmp, [headerLine("p1"), runMarkLine(childNew)].join("\n") + "\n", "utf8");
    await rename(tmp, join(layout.sessionDir, "parent.jsonl"));

    const after = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(after.has(childOld)).toBe(false); // dropped with the replaced entry
    expect(after.has(childNew)).toBe(true);
    expect(after.complete).toBe(true);
  });

  test("a shrunken file (same inode) restarts at 0 and drops its marks", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    const filler = JSON.stringify({ type: "custom", customType: "t:f", data: "f".repeat(500) });
    const parent = await writeSession("parent.jsonl", [headerLine("p1"), filler, runMarkLine(child)]);
    await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect((await advanceProvenance(layout.sessionDir, { ms: 0, bytes: 0 })).has(child)).toBe(true);

    // Truncate to a LINE boundary (header + filler, both \n-terminated) — same inode, smaller
    // than scannedTo, and still completable (ends with \n).
    const kept = `${headerLine("p1")}\n${filler}\n`;
    await truncate(parent, Buffer.byteLength(kept, "utf8"));
    const after = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(after.has(child)).toBe(false);
    expect(after.complete).toBe(true);
  });

  test("an oversized cache file (>16 MiB) is treated as absent and rebuilt", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);
    await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect((await advanceProvenance(layout.sessionDir, { ms: 0, bytes: 0 })).has(child)).toBe(true);

    const cacheFile = provenanceCachePath(layout.sessionDir);
    await writeFile(cacheFile, "x".repeat(PROVENANCE_CACHE_MAX_BYTES + 1024), "utf8");
    const degraded = await advanceProvenance(layout.sessionDir, { ms: 0, bytes: 0 }); // no scan budget
    expect(degraded.has(child)).toBe(false); // oversized cache ⇒ absent

    const rebuilt = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(rebuilt.has(child)).toBe(true);
    expect((await stat(cacheFile)).size).toBeLessThanOrEqual(PROVENANCE_CACHE_MAX_BYTES);
  });

  test("write-time eviction: a cache pushed over 16 MiB evicts oldest-mtime entries", async () => {
    const cap = PROVENANCE_CACHE_MAX_BYTES;
    const cacheFile = provenanceCachePath(layout.sessionDir);
    await mkdir(join(layout.agentDir, "cache", "session-nav", "provenance-v2"), { recursive: true });

    // Hand-build a cache of fake old entries measured EXACTLY (ASCII ⇒ length === bytes),
    // landing just under the read cap so the post-scan write must overshoot and evict.
    const files: Record<string, unknown> = {};
    let total = `{"version":2,"cursor":"","files":{}}`.length;
    let seq = 0;
    const addEntry = (marksCount: number): void => {
      const marks = Array.from(
        { length: marksCount },
        (_, i) => `/elsewhere/${seq}/child-${i}-${"p".repeat(300 - 30)}.jsonl`,
      );
      const entry = { dev: seq, ino: seq, size: 1024, mtimeMs: 1_000 + seq, scannedTo: 1024, marks };
      const key = `/fake/old-${seq}.jsonl`;
      const inc = JSON.stringify(key).length + 1 + JSON.stringify(entry).length + 1;
      total += inc;
      files[key] = entry;
      seq += 1;
    };
    while (total + 600_000 < cap - 4_000) addEntry(1_700); // ~515 KiB entries
    while (total + 4_000 < cap - 1_000) addEntry(10); // ~3.2 KiB entries
    // Fine-tune with 1-mark entries, measuring each increment BEFORE committing so the final
    // size lands in (cap-8-incMax, cap-8] — just under the read cap, past it after the scan.
    for (;;) {
      const marks = [`/elsewhere/${seq}/child-0-${"p".repeat(300 - 30)}.jsonl`];
      const entry = { dev: seq, ino: seq, size: 1024, mtimeMs: 1_000 + seq, scannedTo: 1024, marks };
      const key = `/fake/old-${seq}.jsonl`;
      const inc = JSON.stringify(key).length + 1 + JSON.stringify(entry).length + 1;
      if (total + inc > cap - 8) break;
      total += inc;
      files[key] = entry;
      seq += 1;
    }
    await writeFile(cacheFile, JSON.stringify({ version: 2, cursor: "", files }), "utf8");
    const builtSize = (await stat(cacheFile)).size;
    expect(builtSize).toBeLessThanOrEqual(cap);
    expect(builtSize).toBeGreaterThan(cap - 600);

    // One real pending parent (newest mtime) whose scan dirties the cache past the cap.
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);

    const after = await advanceProvenance(layout.sessionDir, { ms: 60_000, bytes: 64 * 1024 * 1024 });
    expect(after.has(child)).toBe(true); // the fresh scan survived
    expect(provenanceStatus(after)).toBe("capacity"); // eviction reported as capacity
    const saved = await readFile(cacheFile, "utf8");
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(cap);
    const parsed = JSON.parse(saved) as { files: Record<string, unknown> };
    expect(parsed.files["/fake/old-0.jsonl"]).toBeUndefined(); // oldest evicted first
    expect(parsed.files[resolve(join(layout.sessionDir, "parent.jsonl"))]).toBeDefined();
  });
});

describe("advanceProvenance — backfill fairness", () => {
  test(
    "a single 200 MiB parent never starves other files (round-robin, 8 MiB chunks)",
    { timeout: 240_000 },
    async () => {
      const smallChild1 = await writeSession("small-child1.jsonl", [headerLine("sc1")]);
      const smallChild2 = await writeSession("small-child2.jsonl", [headerLine("sc2")]);
      const bigChild = await writeSession("big-child.jsonl", [headerLine("bc")]);

      await writeSession("small-recent.jsonl", [headerLine("s1"), runMarkLine(smallChild1)]);
      await writeSession("small-old.jsonl", [headerLine("s2"), runMarkLine(smallChild2)]);
      await setOld(join(layout.sessionDir, "small-old.jsonl"), 9);

      // The 200 MiB parent carries its mark at the very END (only reachable after ~26 chunks).
      const bigPath = join(layout.sessionDir, "big-old.jsonl");
      const handle = await openAsync(bigPath, "w");
      try {
        await handle.writeFile(`${headerLine("b1")}\n`, "utf8");
        const filler = Buffer.from(
          JSON.stringify({ type: "custom", customType: "t:filler", data: "f".repeat(1024 * 1024 - 64) }) + "\n",
          "utf8",
        );
        for (let i = 0; i < 203; i++) await handle.writeFile(filler);
        await handle.writeFile(`${runMarkLine(bigChild)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      await setOld(bigPath, 30);
      expect((await stat(bigPath)).size).toBeGreaterThan(200 * 1024 * 1024);

      const first = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
      // Small files (both lanes) completed on call 1 — no starvation.
      expect(first.has(smallChild1)).toBe(true);
      expect(first.has(smallChild2)).toBe(true);
      expect(first.complete).toBe(false);
      expect(first.has(bigChild)).toBe(false);

      let current = first;
      let calls = 1;
      while (!(current.complete && current.has(bigChild))) {
        current = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
        calls += 1;
        expect(calls).toBeLessThanOrEqual(30); // ⌈~203 MiB / 8 MiB per call⌉ + margin
      }
      expect(current.has(bigChild)).toBe(true);
      expect(current.complete).toBe(true);
    },
  );
});

describe("advanceProvenance — capacity limits", () => {
  test(
    "20 001 files ⇒ capacity:files; self-marked children still hidden by the loader filter",
    { timeout: 240_000 },
    async () => {
      // 19 998 recent fillers + recent parent + recent child = 20 000 tracked; two much older
      // files (an old parent and an old self-marked child) fall off the cap deterministically.
      const batch: Promise<void>[] = [];
      for (let i = 0; i < 19_998; i++) {
        batch.push(writeFile(join(layout.sessionDir, `f-${i.toString().padStart(5, "0")}.jsonl`), "", "utf8"));
        if (batch.length >= 512) {
          await Promise.all(batch);
          batch.length = 0;
        }
      }
      await Promise.all(batch);
      const child = await writeSession("child.jsonl", [headerLine("c1")]);
      await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);

      const oldChild = await writeSession("old-child.jsonl", [headerLine("oc")]); // pre-v0.4.0, untracked
      const oldParent = await writeSession("old-parent.jsonl", [headerLine("op"), runMarkLine(oldChild)]);
      const oldSelfMarked = await writeSession("old-self.jsonl", [headerLine("os"), childMarkerLine()]);
      await setOld(oldParent, 40);
      await setOld(oldChild, 40);
      await setOld(oldSelfMarked, 41);

      const index = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
      expect(provenanceStatus(index)).toBe("capacity");
      expect((index as { capacity?: unknown }).capacity).toBe("files");
      expect(index.complete).toBe(false);
      expect(index.has(oldChild)).toBe(false); // its only parent is untracked
      expect(index.has(child)).toBe(true); // the tracked recent parent still marks it

      // The §2.1 guarantee: a self-marked child is hidden regardless of the index.
      const filter = await collectSubagentSessions(
        [oldSelfMarked, join(layout.sessionDir, "f-00000.jsonl")],
        layout.sessionDir,
        { budget: { ms: 30_000, bytes: 1024 * 1024 } },
      );
      expect(filter.sub.has(resolve(oldSelfMarked))).toBe(true);
      expect(filter.sub.has(resolve(join(layout.sessionDir, "f-00000.jsonl")))).toBe(false);
    },
  );

  test(">2048 marks in one parent ⇒ entry over, capacity:marks, first 2048 kept", async () => {
    const lines = [headerLine("p1")];
    for (let i = 0; i < PROVENANCE_MARKS_PER_ENTRY_MAX + 5; i++) {
      lines.push(runMarkLine(join(layout.sessionDir, `child-${i}.jsonl`)));
    }
    await writeSession("parent.jsonl", lines);
    const index = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(provenanceStatus(index)).toBe("capacity");
    expect((index as { capacity?: unknown }).capacity).toBe("marks");
    expect(index.has(join(layout.sessionDir, "child-0.jsonl"))).toBe(true);
    expect(index.has(join(layout.sessionDir, `child-${PROVENANCE_MARKS_PER_ENTRY_MAX - 1}.jsonl`))).toBe(true);
    expect(index.has(join(layout.sessionDir, `child-${PROVENANCE_MARKS_PER_ENTRY_MAX + 4}.jsonl`))).toBe(false);
  });

  test("entry byte cap (512 KiB serialized) ⇒ over before the mark count cap", async () => {
    const outsideDir = join(layout.root, "elsewhere");
    const lines = [headerLine("p1")];
    for (let i = 0; i < 1200; i++) {
      lines.push(runMarkLine(join(outsideDir, `child-${i}-${"z".repeat(420)}.jsonl`)));
    }
    await writeSession("parent.jsonl", lines);
    const index = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(provenanceStatus(index)).toBe("capacity");
    expect((index as { capacity?: unknown }).capacity).toBe("marks");
    expect(index.has(join(outsideDir, `child-0-${"z".repeat(420)}.jsonl`))).toBe(true);
    expect(index.has(join(outsideDir, `child-1199-${"z".repeat(420)}.jsonl`))).toBe(false);
  });
});

describe("advanceProvenance — degradation", () => {
  test("a missing session dir yields an empty non-throwing index", async () => {
    const index = await advanceProvenance(join(layout.root, "no-such-dir"), DEFAULT_PROVENANCE_BUDGET);
    expect(index.has(join(layout.root, "no-such-dir", "x.jsonl"))).toBe(false);
    expect(index.complete).toBe(false);
  });

  test("an aborted signal stops the pass and never writes the cache", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]);
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);
    const controller = new AbortController();
    controller.abort();
    const index = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET, controller.signal);
    expect(index.has(child)).toBe(false);
    // Not even the entry skeleton may land while aborted (§2.4 fence discipline).
    const cacheFile = provenanceCachePath(layout.sessionDir);
    await expect(stat(cacheFile)).rejects.toThrow();
  });

  test("empty dir (no jsonl) is trivially complete", async () => {
    const index = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(index.complete).toBe(true);
    expect(provenanceStatus(index)).toBe("complete");
  });

  test("marks pointing outside the dir are stored as full paths and resolved", async () => {
    const outside = join(layout.root, "outside", "child.jsonl");
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(outside)]);
    const index = await advanceProvenance(layout.sessionDir, DEFAULT_PROVENANCE_BUDGET);
    expect(index.has(outside)).toBe(true);
  });
});
