// Ported from the standalone session-nav extension (subagent-sessions.ts) —
// behavior preserved verbatim. Strict-mode adaptations: optional mark fields
// are declared `?: string | undefined` (exactOptionalPropertyTypes — the diag
// payload may carry explicit undefined) and the scan-pool index read
// `sessionFiles[cursor++]` is undefined-checked (noUncheckedIndexedAccess).
//
// 主会话 / subagent 会话区分。
//
// pi-subagent 的 run 记录写在**主会话**文件里（`subagent:run` custom 条目，
// `diag.sessionFile` 指向子会话文件，`diag.agentType`/`diag.label` 是派单时的
// agent 类型和任务描述）。子会话文件本身没有任何标记，所以只能反向扫描主会话
// 建立「子会话路径 → 标记」映射，再在 resume 列表里标注。
//
// 标注策略：有 label 时标题直接换成 `[sub:agentType] label`（派单描述比截断的
// subagent prompt 精炼得多）；没有 label 时给原标题加 `[sub]` 前缀。
//
// 性能：全量扫描近 1GB 的 session 目录太贵，扫描结果按「文件 mtime+size」缓存到
// <agent>/cache/session-nav/subagent-marks.json，只有变化过的文件会重扫。

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export interface SubagentMark {
  agentType?: string | undefined;
  label?: string | undefined;
}

interface FileScanEntry {
  mtimeMs: number;
  size: number;
  marks: Array<{ sessionFile: string; agentType?: string | undefined; label?: string | undefined }>;
}

interface MarksCacheFile {
  version: 1;
  files: Record<string, FileScanEntry>;
}

const SCAN_CONCURRENCY = 16;

function cachePathFor(sessionDir: string): string {
  // sessionDir = <agent>/sessions/--cwd-- → 缓存放 <agent>/cache/session-nav/
  return join(dirname(dirname(sessionDir)), "cache", "session-nav", "subagent-marks.json");
}

async function loadCache(cacheFile: string): Promise<MarksCacheFile> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8"));
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    /* 缓存缺失/损坏就全量重扫 */
  }
  return { version: 1, files: {} };
}

async function saveCache(cacheFile: string, cache: MarksCacheFile): Promise<void> {
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(cache), "utf8");
  } catch {
    /* 缓存写失败不影响功能，下次多扫一点而已 */
  }
}

/** 扫描单个会话文件，提取其中的 subagent:run 标记。 */
async function scanFileMarks(filePath: string): Promise<FileScanEntry["marks"]> {
  const marks: FileScanEntry["marks"] = [];
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // 先字符串粗筛，只对命中行 JSON.parse，避免整文件解析开销
      if (!line.includes('"subagent:run"')) continue;
      let entry: {
        type?: string;
        customType?: string;
        data?: { diag?: { sessionFile?: string; agentType?: string; label?: string } };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== "subagent:run") continue;
      const diag = entry.data?.diag;
      if (!diag?.sessionFile) continue;
      marks.push({ sessionFile: diag.sessionFile, agentType: diag.agentType, label: diag.label });
    }
  } catch {
    /* 单个文件读失败不影响整体标注 */
  } finally {
    rl.close();
  }
  return marks;
}

/**
 * 扫描给定会话文件，返回 子会话路径(resolve 后) → 标记。
 * 按 mtime+size 命中缓存，只有新增/变化的主会话文件才真正读盘。
 */
export async function collectSubagentMarks(
  sessionFiles: string[],
  sessionDir: string,
): Promise<Map<string, SubagentMark>> {
  const cacheFile = cachePathFor(sessionDir);
  const cache = await loadCache(cacheFile);
  let cacheDirty = false;

  // 简单并发池：读盘 + 逐行扫描是 IO/CPU 混合，16 路足够
  let cursor = 0;
  const results: Array<{ file: string; entry: FileScanEntry }> = [];
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, sessionFiles.length) }, async () => {
      while (cursor < sessionFiles.length) {
        const file = sessionFiles[cursor++];
        if (file === undefined) break;
        let info;
        try {
          info = await stat(file);
        } catch {
          continue;
        }
        const key = resolve(file);
        const cached = cache.files[key];
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
          results.push({ file: key, entry: cached });
          continue;
        }
        const entry: FileScanEntry = {
          mtimeMs: info.mtimeMs,
          size: info.size,
          marks: await scanFileMarks(file),
        };
        cache.files[key] = entry;
        cacheDirty = true;
        results.push({ file: key, entry });
      }
    }),
  );

  if (cacheDirty) await saveCache(cacheFile, cache);

  const marks = new Map<string, SubagentMark>();
  for (const { entry } of results) {
    for (const mark of entry.marks) {
      const key = resolve(mark.sessionFile);
      // 同一会话可能有多个 generation 的 run 条目，保留第一个带信息的即可
      if (!marks.has(key)) marks.set(key, { agentType: mark.agentType, label: mark.label });
    }
  }
  return marks;
}

/** 列出目录下全部 session 文件（给 --all 路径用）。 */
export async function listSessionFiles(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => resolve(sessionDir, name));
  } catch {
    return [];
  }
}

/** 给 subagent 会话打标记：有 label 直接换标题，否则加 [sub] 前缀。 */
export function markSubagentSessions(sessions: SessionInfo[], marks: Map<string, SubagentMark>): SessionInfo[] {
  if (marks.size === 0) return sessions;
  return sessions.map((session) => {
    const mark = marks.get(resolve(session.path));
    if (!mark || session.name) return session;
    const tag = mark.agentType ? `[sub:${mark.agentType}]` : "[sub]";
    const firstMessage = mark.label ? `${tag} ${mark.label}` : `${tag} ${session.firstMessage}`;
    return { ...session, firstMessage };
  });
}
