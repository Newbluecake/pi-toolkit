// web-resume plan §4 P1: `collectSubagentSessions` — the §2.3 step-② sub set over candidate
// files (provenance index + per-candidate `subagent:child` head read, ≤16 concurrency), and
// `listSessionFiles`. The old collectSubagentMarks/markSubagentSessions (v1 cache + `[sub:*]`
// retitle) are gone per D1 — those suites were replaced by provenance.test.ts.

import { utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  collectSubagentSessions,
  HEAD_SCAN_CONCURRENCY,
  listSessionFiles,
} from "../../src/session-nav/subagent-sessions.js";
import {
  childMarkerLine,
  dropLayout,
  headerLine,
  makeLayout,
  nameLine,
  runMarkLine,
  userLine,
  type Layout,
} from "./helpers.js";

let layout: Layout;
beforeEach(async () => {
  layout = await makeLayout();
});
afterEach(async () => {
  await dropLayout(layout);
});

async function writeSession(name: string, lines: string[]): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const path = join(layout.sessionDir, name);
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}

describe("collectSubagentSessions", () => {
  test("self-marker (line 2) classifies a child with no parent mark at all", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1"), childMarkerLine(), userLine("任务")]);
    const main = await writeSession("main.jsonl", [headerLine("m1"), userLine("hi")]);
    const { sub } = await collectSubagentSessions([child, main], layout.sessionDir, {
      budget: { ms: 0, bytes: 0 }, // index cannot help — only the head read may classify
    });
    expect(sub.has(resolve(child))).toBe(true);
    expect(sub.has(resolve(main))).toBe(false);
  });

  test("provenance hit classifies a marker-less child (and skips its head read)", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1")]); // pre-v0.4.0 shape
    await writeSession("parent.jsonl", [headerLine("p1"), runMarkLine(child)]);
    // First call builds the index; second proves the classification is index-sourced.
    await collectSubagentSessions([join(layout.sessionDir, "parent.jsonl")], layout.sessionDir);
    const { sub } = await collectSubagentSessions([child], layout.sessionDir, {
      budget: { ms: 0, bytes: 0 },
    });
    expect(sub.has(resolve(child))).toBe(true);
  });

  test("a renamed (session_info.name) child is still filtered — identity, not title", async () => {
    const child = await writeSession("child.jsonl", [headerLine("c1"), childMarkerLine(), nameLine("用户改名")]);
    const { sub } = await collectSubagentSessions([child], layout.sessionDir, {
      budget: { ms: 0, bytes: 0 },
    });
    expect(sub.has(resolve(child))).toBe(true);
  });

  test("unparseable/missing candidates are skipped without throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    const garbage = join(layout.sessionDir, "garbage.jsonl");
    await writeFile(garbage, "not json at all\n", "utf8");
    const main = await writeSession("main.jsonl", [headerLine("m1")]);
    const { sub } = await collectSubagentSessions(
      [garbage, main, join(layout.sessionDir, "gone.jsonl")],
      layout.sessionDir,
      { budget: { ms: 2_000, bytes: 1024 * 1024 } },
    );
    expect(sub.size).toBe(0);
  });

  test("an aborted signal returns promptly with a partial answer", async () => {
    const controller = new AbortController();
    controller.abort();
    const child = await writeSession("child.jsonl", [headerLine("c1"), childMarkerLine()]);
    const { sub } = await collectSubagentSessions([child], layout.sessionDir, { signal: controller.signal });
    expect(sub.size).toBe(0); // head reads never ran; no throw
  });

  test("HEAD_SCAN_CONCURRENCY is 16 (§2.3)", () => {
    expect(HEAD_SCAN_CONCURRENCY).toBe(16);
  });

  test("candidate order does not matter for the resulting set", async () => {
    const a = await writeSession("a.jsonl", [headerLine("a"), childMarkerLine()]);
    const b = await writeSession("b.jsonl", [headerLine("b"), childMarkerLine()]);
    const forward = await collectSubagentSessions([a, b], layout.sessionDir, { budget: { ms: 0, bytes: 0 } });
    const backward = await collectSubagentSessions([b, a], layout.sessionDir, { budget: { ms: 0, bytes: 0 } });
    expect([...forward.sub].sort()).toEqual([...backward.sub].sort());
  });
});

describe("listSessionFiles", () => {
  test("lists .jsonl files resolved; ignores other names and a missing dir", async () => {
    await writeSession("one.jsonl", [headerLine("1")]);
    await writeSession("two.jsonl", [headerLine("2")]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(layout.sessionDir, "note.txt"), "x", "utf8");
    const files = await listSessionFiles(layout.sessionDir);
    expect(files.sort()).toEqual([
      resolve(join(layout.sessionDir, "one.jsonl")),
      resolve(join(layout.sessionDir, "two.jsonl")),
    ]);
    expect(await listSessionFiles(join(layout.root, "missing"))).toEqual([]);
  });

  test("old files are still candidates for the --all loader (no window filter here)", async () => {
    const path = await writeSession("ancient.jsonl", [headerLine("a")]);
    const t = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    await utimes(path, t, t);
    expect(await listSessionFiles(layout.sessionDir)).toEqual([resolve(path)]);
  });
});
