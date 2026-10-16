// web-resume plan §4 P1 (loader end-to-end, real pi SessionManager.list): partial-progress rows
// of the recent loader carry REAL paths after mapping and never include a sub row; renamed
// children are hidden (D1: identity filtering); the AbortSignal cleans the symlink temp dir;
// the time window and pi's header-cwd filter still hold.

import { readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { listRecentSessions } from "../../src/session-nav/recent-sessions.js";
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

async function writeSession(name: string, lines: string[], cwd = layout.root): Promise<string> {
  const path = join(layout.sessionDir, name);
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}

async function tempSessionDirs(): Promise<Set<string>> {
  const names = await readdir(tmpdir());
  return new Set(names.filter((n) => n.startsWith("pi-recent-sessions-")));
}

describe("listRecentSessions — §2.3 pipeline", () => {
  test("sub sessions never reach progress or the final list; partial rows carry real paths", async () => {
    const mainA = await writeSession("main-a.jsonl", [headerLine("ma", layout.root), userLine("任务 A")]);
    const mainB = await writeSession("main-b.jsonl", [headerLine("mb", layout.root), userLine("任务 B")]);
    const childMarked = await writeSession("child-marked.jsonl", [
      headerLine("cm", layout.root),
      childMarkerLine(),
      userLine("子任务"),
    ]);
    const childLegacy = await writeSession("child-legacy.jsonl", [headerLine("cl", layout.root), userLine("老子会话")]); // pre-v0.4.0
    await writeSession("parent.jsonl", [headerLine("p1", layout.root), runMarkLine(childLegacy)]);

    const progressSnapshots: Array<{ loaded: number; total: number; rows: readonly SessionInfo[] }> = [];
    const sessions = await listRecentSessions(layout.root, layout.sessionDir, 48, (loaded, total, rows) => {
      progressSnapshots.push({ loaded, total, rows: rows ?? [] });
    });

    // Final list: the mains AND the parent (a parent is a normal main session) — neither
    // child — D1 彻底隐藏 (drop, not retitle).
    expect(new Set(sessions.map((s) => s.path))).toEqual(
      new Set([mainA, mainB, join(layout.sessionDir, "parent.jsonl")]),
    );
    expect(sessions.find((s) => s.path === childMarked)).toBeUndefined();

    // Every partial row carries a REAL path (temp-dir mapping happened first, r1 #5).
    for (const snap of progressSnapshots) {
      for (const row of snap.rows) {
        expect(row.path.startsWith(layout.sessionDir + "/") || row.path.startsWith(layout.sessionDir)).toBe(true);
        expect(row.path).not.toContain("pi-recent-sessions-");
      }
      expect(rowPathOf(snap.rows, childMarked)).toBeUndefined();
      expect(rowPathOf(snap.rows, childLegacy)).toBeUndefined();
    }
  });

  test("a renamed child (session_info.name) is still hidden — filtering is by identity", async () => {
    const child = await writeSession("child-renamed.jsonl", [
      headerLine("cr", layout.root),
      childMarkerLine(),
      nameLine("用户给子会话改的名"),
      userLine("子任务"),
    ]);
    await writeSession("main.jsonl", [headerLine("m1", layout.root), userLine("主任务")]);
    const sessions = await listRecentSessions(layout.root, layout.sessionDir, 48);
    expect(sessions.map((s) => s.path)).toEqual([join(layout.sessionDir, "main.jsonl")]);
    expect(sessions.find((s) => s.path === child)).toBeUndefined();
  });

  test("files outside the time window and foreign-cwd headers are excluded", async () => {
    const recent = await writeSession("recent.jsonl", [headerLine("r1", layout.root), userLine("新的")]);
    const old = await writeSession("old.jsonl", [headerLine("o1", layout.root), userLine("旧的")]);
    const t = new Date(Date.now() - 96 * 3600 * 1000);
    await utimes(old, t, t);
    const foreign = await writeSession("foreign.jsonl", [headerLine("f1", "/somewhere/else"), userLine("别处")]);

    const sessions = await listRecentSessions(layout.root, layout.sessionDir, 48);
    expect(sessions.map((s) => s.path)).toEqual([recent]);
    expect(sessions.find((s) => s.path === foreign)).toBeUndefined();
  });

  test("skill-envelope titles stay cleaned on surviving rows", async () => {
    await writeSession("skill.jsonl", [
      headerLine("sk", layout.root),
      userLine(`<skill name="dev-flow">${"SKILL 正文".repeat(50)}</skill>修复构建`),
    ]);
    const sessions = await listRecentSessions(layout.root, layout.sessionDir, 48);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.firstMessage).toBe("[dev-flow] 修复构建");
  });

  test("an empty window reports zero progress and no sessions", async () => {
    const sessions = await listRecentSessions(layout.root, layout.sessionDir, 48, (loaded, total) => {
      expect([loaded, total]).toEqual([0, 0]);
    });
    expect(sessions).toEqual([]);
  });

  test("aborting mid-list rejects and leaves no temp dir behind", { timeout: 15_000 }, async () => {
    await writeSession("main-a.jsonl", [headerLine("ma", layout.root), userLine("任务 A")]);
    await writeSession("main-b.jsonl", [headerLine("mb", layout.root), userLine("任务 B")]);
    const before = await tempSessionDirs();

    const controller = new AbortController();
    let firstProgress = true;
    await expect(
      listRecentSessions(
        layout.root,
        layout.sessionDir,
        48,
        () => {
          if (firstProgress) {
            firstProgress = false;
            controller.abort(); // deterministic mid-flight abort inside pi's load loop
          }
        },
        controller.signal,
      ),
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 50)); // let the finally settle
    const after = await tempSessionDirs();
    const leaked = [...after].filter((d) => !before.has(d));
    expect(leaked).toEqual([]);
  });
});

function rowPathOf(rows: readonly SessionInfo[], path: string): SessionInfo | undefined {
  return rows.find((r) => r.path === path);
}
