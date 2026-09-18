// Ported behavior tests for src/session-nav/subagent-sessions.ts — fakes are
// inline (no cross-package helpers). markSubagentSessions is pure;
// collectSubagentMarks runs against a temp dir with fake session jsonl files
// and exercises the on-disk mtime+size cache.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  collectSubagentMarks,
  listSessionFiles,
  markSubagentSessions,
  type SubagentMark,
} from "../../src/session-nav/subagent-sessions.js";

function fakeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    path: "/tmp/session-nav-fake.jsonl",
    id: "fake",
    cwd: "/tmp",
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "原标题",
    allMessagesText: "原标题",
    ...overrides,
  };
}

describe("markSubagentSessions", () => {
  test("replaces the title with `[sub:type] label` when the run has a label", () => {
    const session = fakeSession({ path: "/tmp/child.jsonl", firstMessage: "截断的 subagent prompt…" });
    const marks = new Map<string, SubagentMark>([
      [resolve("/tmp/child.jsonl"), { agentType: "verifier", label: "派单描述" }],
    ]);
    const [marked] = markSubagentSessions([session], marks);
    expect(marked?.firstMessage).toBe("[sub:verifier] 派单描述");
  });

  test("prefixes the original title when the run has no label", () => {
    const session = fakeSession({ path: "/tmp/child.jsonl", firstMessage: "原标题" });
    const withType = markSubagentSessions(
      [session],
      new Map([[resolve("/tmp/child.jsonl"), { agentType: "verifier" }]]),
    );
    expect(withType[0]?.firstMessage).toBe("[sub:verifier] 原标题");
    const withoutType = markSubagentSessions([session], new Map([[resolve("/tmp/child.jsonl"), {}]]));
    expect(withoutType[0]?.firstMessage).toBe("[sub] 原标题");
  });

  test("renamed sessions (name set) are left untouched", () => {
    const session = fakeSession({
      path: "/tmp/child.jsonl",
      name: "用户改的名",
      firstMessage: "原标题",
    });
    const marks = new Map<string, SubagentMark>([
      [resolve("/tmp/child.jsonl"), { agentType: "verifier", label: "派单描述" }],
    ]);
    const [marked] = markSubagentSessions([session], marks);
    expect(marked).toBe(session);
  });

  test("returns the input array unchanged when there are no marks", () => {
    const sessions = [fakeSession({})];
    expect(markSubagentSessions(sessions, new Map())).toBe(sessions);
  });
});

describe("collectSubagentMarks", () => {
  let root: string;
  let agentDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    // 布局对齐真实结构：<agent>/sessions/--cwd--/*.jsonl，
    // 缓存落 <agent>/cache/session-nav/subagent-marks.json
    root = await mkdtemp(join(tmpdir(), "session-nav-test-"));
    agentDir = join(root, "agent");
    sessionDir = join(agentDir, "sessions", "--cwd--");
    await mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runEntry(diag: Record<string, unknown>): string {
    return JSON.stringify({ type: "custom", customType: "subagent:run", data: { diag } });
  }

  test("extracts marks, tolerates dirty lines, and writes the cache file", async () => {
    const childPath = join(sessionDir, "child.jsonl");
    await writeFile(childPath, "", "utf8");
    const mainPath = join(sessionDir, "main.jsonl");
    await writeFile(
      mainPath,
      [
        '{"type":"session"}',
        // 脏行：粗筛命中但 JSON 不合法，必须被容忍
        '{"customType":"subagent:run", broken json',
        // 错误 type：粗筛命中但被类型检查丢弃
        JSON.stringify({ type: "message", customType: "subagent:run", data: { diag: { sessionFile: "/nope" } } }),
        runEntry({ sessionFile: childPath, agentType: "verifier", label: "派单描述" }),
      ].join("\n") + "\n",
      "utf8",
    );
    // 无 subagent:run 条目的普通会话
    await writeFile(join(sessionDir, "plain.jsonl"), '{"type":"session"}\n', "utf8");

    const files = await listSessionFiles(sessionDir);
    expect(files.sort()).toEqual([childPath, mainPath, join(sessionDir, "plain.jsonl")].map((p) => resolve(p)).sort());

    const marks = await collectSubagentMarks(files, sessionDir);
    expect(marks.get(resolve(childPath))).toEqual({ agentType: "verifier", label: "派单描述" });
    expect(marks.size).toBe(1);

    // 缓存文件按约定路径生成
    const cacheFile = join(agentDir, "cache", "session-nav", "subagent-marks.json");
    const cache = JSON.parse(await readFile(cacheFile, "utf8")) as {
      version: number;
      files: Record<string, { marks: unknown[] }>;
    };
    expect(cache.version).toBe(1);
    expect(Object.keys(cache.files)).toContain(resolve(mainPath));

    // 第二次调用命中缓存，结果一致
    const cached = await collectSubagentMarks(files, sessionDir);
    expect(cached.get(resolve(childPath))).toEqual({ agentType: "verifier", label: "派单描述" });
    expect(cached.size).toBe(1);
  });

  test("returns an empty map when no file contains subagent:run entries", async () => {
    const mainPath = join(sessionDir, "main.jsonl");
    await writeFile(mainPath, '{"type":"session"}\n{"type":"message"}\n', "utf8");
    const marks = await collectSubagentMarks([mainPath], sessionDir);
    expect(marks.size).toBe(0);
  });
});
